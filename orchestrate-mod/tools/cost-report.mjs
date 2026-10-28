#!/usr/bin/env node
// Totals over orchestrate-mod's cost records (orchestrate-mod/hooks/register.js writes them): by ledger, batch
// and role, by model and by session, and with --cost-state each session's records against the cost-state line of
// its Claude Code transcript. Parsing and pricing are orchestrate-mod/hooks/cost.js and
// orchestrate-mod/hooks/prices.js, the hooks module's own, so the report and the log read one format.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { aggregate, parseRecords, roundedTotal } from '../hooks/cost.js';
import { PRICES, PRICES_CHECKED } from '../hooks/prices.js';

const HELP = [
  'node orchestrate-mod/tools/cost-report.mjs [--dir <dir>] [--ledger <id>] [--session <id>] [--format text|json] [--cost-state [--projects <dir>]]',
  '  Reads every *.jsonl in <dir> (default <home>/.claude/orchestrate-costs, home from HOME, else USERPROFILE),',
  '  sorted by name, and validates every line as a cost record. --ledger and --session keep the records of one',
  '  ledger (`(none)`: untagged) or session. text (the default) prints the line',
  '  `COSTS <records> records, <files> files, $<usd> (<n> unpriced), main loop and sub-agents only` and a table by',
  '  ledger, batch and role; json prints one line with the totals by ledger, batch and role, by model and by session.',
  '  A dollar figure sums the priced records; `+?` marks one that leaves unpriced records out (a model the price',
  `  table, checked ${PRICES_CHECKED}, lacks).`,
  '  The records cover the main loop and sub-agents only. Outside them: the agent-progress summaries Claude Code',
  '  requests for each running sub-agent (terminal sessions run them, desktop sessions do not), and auto mode\'s',
  '  classifier calls.',
  '  --cost-state compares each session of the kept records with the last `"type":"cost-state"` line of its',
  '  transcript, <projects>/*/<session>.jsonl (default <home>/.claude/projects): Claude Code\'s own total since the',
  '  session last started, which counts the summaries but not the classifier calls. After the table, one line per',
  '  session in id order: `COST-STATE <session> records $<x> since <startTime>, cost-state $<y>, outside the',
  '  records $<y - x> (<n>% of cost-state)`, where <x> sums every record of the session from startTime on, whatever',
  '  --ledger keeps; an unpriced record marks <x> `+?` and the outside figure and its share `-?`, and a $0.00',
  '  cost-state prints no share. A session with no transcript, or no cost-state line in it, prints',
  '  `COST-STATE <session> none`. json adds `costState`: per session',
  '  `{ records: <a total>, costState, outside, startTime: <ISO time> }`, or null for none.',
  'Exit 0: every line read and valid, or `NO RECORDS <dir>` when the directory does not exist. Exit 2: one',
  '  `UNKNOWN <path>[:<line>]: <reason>` line for a malformed record or cost-state line, a session with two',
  '  transcripts, a file or directory that cannot be read, or an invalid invocation.',
].join('\n');
const FLAGS = ['dir', 'ledger', 'session', 'format', 'projects'];
// The flags that take no value.
const SWITCHES = ['cost-state'];
const NONE = '(none)';
const decoder = new TextDecoder('utf-8', { fatal: true });
// A transcript is decoded leniently: only its cost-state lines are read, and a live one can end in a cut character.
const lenient = new TextDecoder('utf-8');
// What a transcript line carrying Claude Code's own cost total holds; only such lines are parsed.
const MARKER = '"type":"cost-state"';
// What a record's text may carry that a terminal would act on or hide: C0 but tab and LF, DEL, C1 and the two
// Unicode separators, each printed as `?`.
const HIDDEN = new RegExp('[\\x00-\\x08\\x0b-\\x1f\\x7f-\\x9f' + String.fromCharCode(0x2028, 0x2029) + ']', 'g');
// HIDDEN with tab and LF as well, for a record's text printed inside one line: replaced before the table's widths
// are taken, so the text keeps its row and its width.
const IN_LINE = new RegExp('[\\x00-\\x1f\\x7f-\\x9f' + String.fromCharCode(0x2028, 0x2029) + ']', 'g');
const inLine = text => text.replace(IN_LINE, '?');

const usage = why => ({ code: 2, lines: [`UNKNOWN usage: ${why}; use --help`] });
const sorted = map => [...map.keys()].sort();
const usd = total => '$' + total.usd.toFixed(2) + (total.unpriced > 0 ? '+?' : '');
const unreadable = (where, e) => `UNKNOWN ${where}: cannot be read (${e.code ?? e.message})`;
const absent = e => e.code === 'ENOENT' || e.code === 'ENOTDIR';

function parseArgs(args) {
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const flag = args[i], name = flag.startsWith('--') ? flag.slice(2) : null;
    if (!FLAGS.includes(name) && !SWITCHES.includes(name)) return { error: `unknown argument ${flag}` };
    if (name in options) return { error: `--${name} given twice` };
    if (SWITCHES.includes(name)) { options[name] = true; continue; }
    if (i + 1 >= args.length || args[i + 1] === '') return { error: `--${name} needs a value` };
    options[name] = args[++i];
  }
  options.format ??= 'text';
  if (!['text', 'json'].includes(options.format)) return { error: `--format is text or json, not ${options.format}` };
  if (options.projects !== undefined && !options['cost-state']) return { error: '--projects needs --cost-state' };
  return { options };
}

// The last line of a transcript's text that is Claude Code's cost-state record, as `{ value }` (null when there is
// none), or `{ line, reason }` (1-based) when a line carrying MARKER does not parse or that record is not one this
// report can read. Lines are read from the end, and only those carrying MARKER are parsed.
function lastCostState(text, session) {
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes(MARKER)) continue;
    let value;
    const at = reason => ({ line: i + 1, reason });
    try { value = JSON.parse(lines[i]); } catch { return at('a cost-state line that is not JSON'); }
    // MARKER inside a nested object of another kind of line: not the session's cost total.
    if (value?.type !== 'cost-state') continue;
    if (value.sessionId !== session) return at('the cost-state line names session ' + JSON.stringify(value.sessionId));
    const cost = value.totalCostUSD, start = value.startTime;
    if (typeof cost !== 'number' || !Number.isFinite(cost) || cost < 0) return at('totalCostUSD is not a non-negative number');
    if (!Number.isSafeInteger(start) || start < 0 || Number.isNaN(new Date(start).getTime())) return at('startTime is not a time in milliseconds');
    return { value };
  }
  return { value: null };
}

// Per session of `sessions`, in their order, its transcript's last cost-state line against every record of
// `records` for that session from that line's startTime on: a Map from session to `{ records: <a total>, costState,
// startTime: <ISO time> }`, null for a session with no transcript or no cost-state line, or `{ unknown }`, the one
// line to print. Only ENOENT or ENOTDIR on <projects> itself, and ENOTDIR on an entry of it, are absence.
function costStates(projects, sessions, records, io) {
  const wanted = new Set(sessions), files = new Map();
  let dirs = [];
  try { dirs = io.readdirSync(projects).sort(); } catch (e) { if (!absent(e)) return { unknown: unreadable(projects, e) }; }
  for (const dir of dirs) {
    const where = path.join(projects, dir);
    let names;
    try { names = io.readdirSync(where); } catch (e) { if (e.code === 'ENOTDIR') continue; return { unknown: unreadable(where, e) }; }
    for (const name of names) {
      const session = name.endsWith('.jsonl') ? name.slice(0, -'.jsonl'.length) : null;
      if (!wanted.has(session)) continue;
      const file = path.join(where, name);
      if (files.has(session)) return { unknown: `UNKNOWN ${file}: a second transcript of the session, beside ${files.get(session)}` };
      files.set(session, file);
    }
  }
  const out = new Map();
  for (const session of sessions) {
    const file = files.get(session);
    let found = { value: null };
    if (file !== undefined) {
      let text;
      try { text = lenient.decode(io.readFileSync(file)); } catch (e) { return { unknown: unreadable(file, e) }; }
      found = lastCostState(text, session);
      if (found.reason) return { unknown: `UNKNOWN ${file}:${found.line}: ${found.reason}` };
    }
    const { value } = found;
    out.set(session, value === null ? null : {
      records: aggregate(records.filter(r => r.session === session && Date.parse(r.ts) >= value.startTime), PRICES).total,
      costState: value.totalCostUSD, startTime: new Date(value.startTime).toISOString(),
    });
  }
  return { bySession: out };
}

// The plain-object JSON form: keys sorted, every `usd` rounded to 6 decimals; `costState` only under --cost-state.
function json(agg, dir, files, records, states) {
  const totals = map => Object.fromEntries(sorted(map).map(key => [key, roundedTotal(map.get(key))]));
  const byLedger = Object.fromEntries(sorted(agg.byLedger).map(ledger => {
    const l = agg.byLedger.get(ledger);
    return [ledger, { total: roundedTotal(l.total), byBatch: Object.fromEntries(sorted(l.byBatch).map(batch => {
      const b = l.byBatch.get(batch);
      return [batch, { total: roundedTotal(b.total), byRole: totals(b.byRole) }];
    })) }];
  }));
  const costState = states && Object.fromEntries([...states].map(([session, s]) => [session, s === null ? null : {
    records: roundedTotal(s.records), costState: Number(s.costState.toFixed(6)), outside: Number((s.costState - s.records.usd).toFixed(6)), startTime: s.startTime,
  }]));
  return JSON.stringify({ v: 1, dir, files, records, total: roundedTotal(agg.total), byLedger, byModel: totals(agg.byModel), bySession: totals(agg.bySession),
    ...(states ? { costState } : {}) });
}

const cents = dollars => Math.round(dollars * 100);
const inDollars = c => (c < 0 ? '-$' : '$') + (Math.abs(c) / 100).toFixed(2);
// One session's line after the table, from its `costStates` entry. Its three figures are taken in whole cents, so
// the printed outside figure is the printed cost-state less the printed records.
function costStateLine(session, s) {
  if (s === null) return `COST-STATE ${inLine(session)} none`;
  const x = cents(s.records.usd), y = cents(s.costState), open = s.records.unpriced > 0;
  const share = y > 0 ? ` (${((y - x) / y * 100).toFixed(1)}%${open ? '-?' : ''} of cost-state)` : '';
  return `COST-STATE ${inLine(session)} records ${inDollars(x)}${open ? '+?' : ''} since ${s.startTime}, cost-state ${inDollars(y)}, `
    + `outside the records ${inDollars(y - x)}${open ? '-?' : ''}${share}`;
}

// The header line, then one row per ledger, per batch in it and per role in that (`*` marks a row's total).
function text(agg, files, records) {
  const rows = [['ledger', 'batch', 'role', 'requests', 'in', 'out', 'cr', 'cw', 'usd']];
  const row = (ledger, batch, role, t) => rows.push([...[ledger, batch, role].map(inLine), ...[t.requests, t.in, t.out, t.cr, t.cw].map(String), usd(t)]);
  for (const ledger of sorted(agg.byLedger)) {
    const l = agg.byLedger.get(ledger);
    row(ledger, '*', '*', l.total);
    for (const batch of sorted(l.byBatch)) {
      const b = l.byBatch.get(batch);
      row(ledger, batch, '*', b.total);
      for (const role of sorted(b.byRole)) row(ledger, batch, role, b.byRole.get(role));
    }
  }
  const widths = rows[0].map((_, i) => Math.max(...rows.map(r => r[i].length)));
  const lines = rows.map(r => r.map((cell, i) => (i < 3 ? cell.padEnd(widths[i]) : cell.padStart(widths[i]))).join('  ').trimEnd());
  return [`COSTS ${records} records, ${files} files, $${agg.total.usd.toFixed(2)} (${agg.total.unpriced} unpriced), main loop and sub-agents only`, ...lines];
}

// The report for `args` under environment `env`, as `{ code, lines }`: the CLI prints the lines and exits
// with the code. `io` is the file system it reads (`readdirSync`, `readFileSync`).
export function costReport(args, env = process.env, io = fs) {
  if (args.length === 1 && args[0] === '--help') return { code: 0, lines: [HELP] };
  const { options, error } = parseArgs(args);
  if (error) return usage(error);
  const home = env.HOME || env.USERPROFILE;
  if (options.dir === undefined && !home) return usage('no --dir, and neither HOME nor USERPROFILE is set');
  if (options['cost-state'] && options.projects === undefined && !home) return usage('--cost-state with no --projects, and neither HOME nor USERPROFILE is set');
  const dir = path.resolve(options.dir ?? path.join(home, '.claude', 'orchestrate-costs'));
  let names;
  try { names = io.readdirSync(dir).filter(name => name.endsWith('.jsonl')).sort(); }
  catch (e) {
    if (absent(e)) return { code: 0, lines: [`NO RECORDS ${dir}`] };
    return { code: 2, lines: [unreadable(dir, e)] };
  }
  const records = [], all = [];
  for (const name of names) {
    const file = path.join(dir, name);
    let bytes, content;
    try { bytes = io.readFileSync(file); } catch (e) { return { code: 2, lines: [unreadable(file, e)] }; }
    try { content = decoder.decode(bytes); } catch { return { code: 2, lines: [`UNKNOWN ${file}: cannot be read (not UTF-8)`] }; }
    const parsed = parseRecords(content);
    if (!parsed.records) return { code: 2, lines: [`UNKNOWN ${file}:${parsed.line}: ${parsed.reason}`] };
    all.push(...parsed.records);
    records.push(...parsed.records.filter(r => (options.ledger === undefined || (r.ledger ?? NONE) === options.ledger)
      && (options.session === undefined || r.session === options.session)));
  }
  const agg = aggregate(records, PRICES);
  let states = null;
  if (options['cost-state']) {
    const projects = path.resolve(options.projects ?? path.join(home, '.claude', 'projects'));
    // Every record of a kept session counts against its cost-state, whatever --ledger keeps: the total covers them all.
    const read = costStates(projects, [...new Set(records.map(r => r.session))].sort(), all, io);
    if (read.unknown) return { code: 2, lines: [read.unknown] };
    states = read.bySession;
  }
  if (options.format === 'json') return { code: 0, lines: [json(agg, dir, names.length, records.length, states)] };
  return { code: 0, lines: [...text(agg, names.length, records.length), ...(states ? [...states].map(([session, s]) => costStateLine(session, s)) : [])] };
}

// Runs only as the entry script, both sides resolved: through a linked file or directory the CLI still runs,
// where a comparison of the unresolved paths would exit 0 with no output.
let entry = null;
try { entry = fs.realpathSync(process.argv[1]); } catch { /* no entry script (node -e): a library */ }
if (entry !== null && entry === fs.realpathSync(fileURLToPath(import.meta.url))) {
  const output = costReport(process.argv.slice(2));
  process.stdout.write(output.lines.join('\n').replace(HIDDEN, '?') + '\n');
  process.exitCode = output.code;
}
