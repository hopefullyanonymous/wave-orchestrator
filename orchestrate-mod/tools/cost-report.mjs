#!/usr/bin/env node
// Totals over orchestrate-mod's cost records (orchestrate-mod/hooks/register.js writes them): by ledger, batch
// and role, by model and by session. Parsing and pricing are orchestrate-mod/hooks/cost.js and
// orchestrate-mod/hooks/prices.js, the hooks module's own, so the report and the log read one format.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { aggregate, parseRecords, roundedTotal } from '../hooks/cost.js';
import { PRICES, PRICES_CHECKED } from '../hooks/prices.js';

const HELP = [
  'node orchestrate-mod/tools/cost-report.mjs [--dir <dir>] [--ledger <id>] [--session <id>] [--format text|json]',
  '  Reads every *.jsonl in <dir> (default <home>/.claude/orchestrate-costs, home from HOME, else USERPROFILE),',
  '  sorted by name, and validates every line as a cost record. --ledger and --session keep the records of one',
  '  ledger (`(none)`: untagged) or session. text (the default) prints the line',
  '  `COSTS <records> records, <files> files, $<usd> (<n> unpriced)` and a table by ledger, batch and role; json',
  '  prints one line with the totals by ledger, batch and role, by model and by session. A dollar figure sums the',
  '  priced records; `+?` marks one that leaves unpriced records out (a model the price table, checked',
  `  ${PRICES_CHECKED}, lacks).`,
  'Exit 0: every line read and valid, or `NO RECORDS <dir>` when the directory does not exist. Exit 2: one',
  '  `UNKNOWN <path>[:<line>]: <reason>` line for a malformed line, a file or directory that cannot be read, or an',
  '  invalid invocation.',
].join('\n');
const FLAGS = ['dir', 'ledger', 'session', 'format'];
const NONE = '(none)';
const decoder = new TextDecoder('utf-8', { fatal: true });
// What a record's text may carry that a terminal would act on or hide: C0 but tab and LF, DEL, C1 and the two
// Unicode separators, each printed as `?`.
const HIDDEN = new RegExp('[\\x00-\\x08\\x0b-\\x1f\\x7f-\\x9f' + String.fromCharCode(0x2028, 0x2029) + ']', 'g');

const usage = why => ({ code: 2, lines: [`UNKNOWN usage: ${why}; use --help`] });
const sorted = map => [...map.keys()].sort();
const usd = total => '$' + total.usd.toFixed(2) + (total.unpriced > 0 ? '+?' : '');

function parseArgs(args) {
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i], name = flag.startsWith('--') ? flag.slice(2) : null;
    if (!FLAGS.includes(name)) return { error: `unknown argument ${flag}` };
    if (name in options) return { error: `--${name} given twice` };
    if (i + 1 >= args.length || args[i + 1] === '') return { error: `--${name} needs a value` };
    options[name] = args[i + 1];
  }
  options.format ??= 'text';
  if (!['text', 'json'].includes(options.format)) return { error: `--format is text or json, not ${options.format}` };
  return { options };
}

// The plain-object JSON form: keys sorted, every `usd` rounded to 6 decimals.
function json(agg, dir, files, records) {
  const totals = map => Object.fromEntries(sorted(map).map(key => [key, roundedTotal(map.get(key))]));
  const byLedger = Object.fromEntries(sorted(agg.byLedger).map(ledger => {
    const l = agg.byLedger.get(ledger);
    return [ledger, { total: roundedTotal(l.total), byBatch: Object.fromEntries(sorted(l.byBatch).map(batch => {
      const b = l.byBatch.get(batch);
      return [batch, { total: roundedTotal(b.total), byRole: totals(b.byRole) }];
    })) }];
  }));
  return JSON.stringify({ v: 1, dir, files, records, total: roundedTotal(agg.total), byLedger, byModel: totals(agg.byModel), bySession: totals(agg.bySession) });
}

// The header line, then one row per ledger, per batch in it and per role in that (`*` marks a row's total).
function text(agg, files, records) {
  const rows = [['ledger', 'batch', 'role', 'requests', 'in', 'out', 'cr', 'cw', 'usd']];
  const row = (ledger, batch, role, t) => rows.push([ledger, batch, role, ...[t.requests, t.in, t.out, t.cr, t.cw].map(String), usd(t)]);
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
  return [`COSTS ${records} records, ${files} files, $${agg.total.usd.toFixed(2)} (${agg.total.unpriced} unpriced)`, ...lines];
}

// The report for `args` under environment `env`, as `{ code, lines }`: the CLI prints the lines and exits
// with the code. `io` is the file system it reads (`readdirSync`, `readFileSync`).
export function costReport(args, env = process.env, io = fs) {
  if (args.length === 1 && args[0] === '--help') return { code: 0, lines: [HELP] };
  const { options, error } = parseArgs(args);
  if (error) return usage(error);
  const home = env.HOME || env.USERPROFILE;
  if (options.dir === undefined && !home) return usage('no --dir, and neither HOME nor USERPROFILE is set');
  const dir = path.resolve(options.dir ?? path.join(home, '.claude', 'orchestrate-costs'));
  let names;
  try { names = io.readdirSync(dir).filter(name => name.endsWith('.jsonl')).sort(); }
  catch (e) {
    if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return { code: 0, lines: [`NO RECORDS ${dir}`] };
    return { code: 2, lines: [`UNKNOWN ${dir}: cannot be read (${e.code ?? e.message})`] };
  }
  const records = [];
  for (const name of names) {
    const file = path.join(dir, name);
    let bytes, content;
    try { bytes = io.readFileSync(file); } catch (e) { return { code: 2, lines: [`UNKNOWN ${file}: cannot be read (${e.code ?? e.message})`] }; }
    try { content = decoder.decode(bytes); } catch { return { code: 2, lines: [`UNKNOWN ${file}: cannot be read (not UTF-8)`] }; }
    const parsed = parseRecords(content);
    if (!parsed.records) return { code: 2, lines: [`UNKNOWN ${file}:${parsed.line}: ${parsed.reason}`] };
    records.push(...parsed.records.filter(r => (options.ledger === undefined || (r.ledger ?? NONE) === options.ledger)
      && (options.session === undefined || r.session === options.session)));
  }
  const agg = aggregate(records, PRICES);
  return { code: 0, lines: options.format === 'json' ? [json(agg, dir, names.length, records.length)] : text(agg, names.length, records.length) };
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
