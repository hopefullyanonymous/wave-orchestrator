#!/usr/bin/env node
// Reads a backlog or a rulings file in the form references/backlog.md shows and prints a few lines:
// the production files whose to-do items reach a threshold (packs), the items past their expiry
// (expired), the rulings on a set of paths (rulings), and the entries that break the form (check).
// It writes nothing. A file without its form line and a file it cannot read are UNKNOWN, exit 2,
// never a count of zero; so, outside check, is an entry it cannot read.
import fs from 'node:fs';
import { parseFlags, isMain } from './git-evidence.mjs';
import { oneLine } from './check-ledger.mjs';
import { isTestPath } from './failing-on-base.mjs';

const MAX_SHOWN = 10;
export const BACKLOG_FORM = 'Form: orchestrate backlog v1';
export const RULINGS_FORM = 'Form: orchestrate rulings v1';
export const KINDS = ['behaviour', 'hygiene', 'coverage', 'decision', 'docs', 'tooling'];
export const BACKLOG_FIELDS = ['Kind', 'Files', 'Tests', 'Failure', 'Done when', 'Since'];
export const RULING_FIELDS = ['Ruling', 'Reason', 'Files'];
const USAGE = 'UNKNOWN usage: unknown, missing or duplicate flag; use --help';

const HELP = `backlog.mjs packs --backlog <file> --threshold <n> | expired --backlog <file> --days <n> --today <YYYY-MM-DD> | rulings --rulings <file> --paths <comma-separated paths> | check --backlog <file>
Reads a backlog file holding the line "${BACKLOG_FORM}", or a rulings file holding "${RULINGS_FORM}", before its first entry, in the form references/backlog.md shows. It writes nothing.
packs: the line PACKS <k> file(s) at or over <n>, then PACK <path> <count>: <ids> per file, by count descending then path. A to-do item counts once per production file its Files: line names; an item whose Files: are all test files counts once per test file; a decision item and a folded entry (its heading ending "Folded into <CHANGE_ID> <Bnn>.") never count. A test file is one failing-on-base.mjs isTestPath reads as a test; it matches Tests/ case-sensitively, so a file under Tests/ counts as production unless another of its directories or its own name marks it a test.
expired: the line EXPIRED <k> item(s) older than <n> days, then <id> since <date> per item in file order: an entry not folded whose Since: date is more than <n> days before --today.
rulings: the line RULINGS <k> ruling(s) on those paths, then <id> <accepted|declined> <date>: <shared paths> per ruling, in file order, a path shared when it is written the same in --paths and in the ruling's Files: line.
check: BACKLOG OK <n> item(s), or BACKLOG FAIL <k> problem(s): <id or line>: <what> per problem, joined by "; ", naming at most ten and, past ten, (+<m> more) for the rest: a missing or empty field, a field out of order or repeated, a line that is no field, a Kind: outside ${KINDS.join(', ')}, a path that is not repository-relative, a malformed date, a malformed heading or a duplicate id.
Exit 0: the lines are complete; exit 1: check found a problem; exit 2: UNKNOWN <reason>, for a file without its form line, a missing or unreadable file, any entry the other operations cannot read, a flag value that is wrong (a count that is not a whole number, a malformed date) or a usage error.`;

// ===== The form =================================================================================
// The marker scaffold.mjs `foldIns` appends to an accepted fold-in's line, here the entry's heading.
const FOLDED = / Folded into \S+ B\d+\.$/;
// An id as scaffold.mjs `foldIns` names one: `#` or a letter, letters and digits, one separator, digits.
const ID = /^(?:#\d+|[A-Za-z][A-Za-z0-9]*[-_.]\d+)$/;
const HEADING = /^### (\S+) — (.+)$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

// The day number of a YYYY-MM-DD calendar date, or null for any other text.
function dayOf(text) {
  const m = DATE.exec(text);
  if (!m) return null;
  const time = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (new Date(time).toISOString().slice(0, 10) !== text) return null;
  return time / 86400000;
}
// The paths of a `Files:` value, each in backticks and comma-separated, or null. A path is
// repository-relative with forward slashes: no leading slash, no backslash, no empty, `.` or `..` part.
function pathsOf(value) {
  if (!/^`[^`]+`(?:, `[^`]+`)*$/.test(value)) return null;
  const paths = value.slice(1, -1).split('`, `');
  return paths.every(isRelativePath) ? paths : null;
}
const isRelativePath = p => p === p.trim() && !p.includes('\\') && p.split('/').every(part => part && part !== '.' && part !== '..');

// Each backlog field's reading of its value: the value read, or a problem.
export const BACKLOG_READERS = {
  Kind: v => KINDS.includes(v) ? { value: v } : { problem: `Kind: ${v} is none of ${KINDS.join(', ')}` },
  Files: v => (p => p ? { value: p } : { problem: 'Files: is not a comma-separated list of backtick repository-relative paths' })(pathsOf(v)),
  Tests: v => v === 'none' ? { value: [] } : (p => p ? { value: p } : { problem: 'Tests: is neither none nor a comma-separated list of backtick repository-relative paths' })(pathsOf(v)),
  Failure: v => ({ value: v }),
  'Done when': v => ({ value: v }),
  Since: v => {
    const m = /^(\S+) — (\S.*)$/.exec(v);
    if (!m || dayOf(m[1]) === null) return { problem: 'Since: is not <YYYY-MM-DD> — <source> with a calendar date' };
    return { value: { date: m[1], day: dayOf(m[1]), source: m[2] } };
  },
};
export const RULING_READERS = {
  Ruling: v => {
    const m = /^(accepted|declined) — (\S+)$/.exec(v);
    if (!m || dayOf(m[2]) === null) return { problem: 'Ruling: is not accepted or declined — <YYYY-MM-DD> with a calendar date' };
    return { value: { verdict: m[1], date: m[2] } };
  },
  Reason: v => ({ value: v }),
  Files: BACKLOG_READERS.Files,
};

// One file in its form: `{ fault }` when the file as a whole cannot be read, else its entries and
// the problems of each entry it cannot read. After the form line every non-blank line is an entry
// heading or one of the current entry's field lines, each field once and in order; anything else is
// a problem, never passed over.
export function parseForm(text, form, fields, readers) {
  const lines = (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).split(/\r?\n/);
  const formAt = lines.flatMap((l, i) => l === form ? [i] : []);
  const firstHeading = lines.findIndex(l => l.startsWith('### '));
  if (formAt.length === 0 || (firstHeading !== -1 && formAt[0] > firstHeading)) return { fault: `has no line "${form}" before its first entry` };
  if (formAt.length > 1) return { fault: `holds the line "${form}" ${formAt.length} times` };
  const entries = [], problems = [], headingIds = [];
  const fieldLine = new RegExp(`^(${fields.join('|')}):(.*)$`);
  let entry = null;
  const finish = () => {
    if (!entry) return;
    for (const name of fields) if (!entry.seen.has(name)) entry.problems.push(`no ${name}: line`);
    problems.push(...entry.problems.map(p => `${entry.label}: ${p}`));
    if (!entry.problems.length) entries.push({ id: entry.id, title: entry.title, folded: entry.folded, line: entry.line, ...entry.values });
  };
  for (let i = formAt[0] + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    if (line.startsWith('### ')) {
      finish();
      const m = HEADING.exec(line);
      entry = { label: m ? m[1] : `line ${i + 1}`, line: i + 1, problems: [], seen: new Set(), last: -1, values: {} };
      if (!m) { entry.problems.push('the heading is not ### <id> — <title>'); continue; }
      const folded = FOLDED.test(m[2]), title = m[2].replace(FOLDED, '').trim();
      Object.assign(entry, { id: m[1], title, folded });
      headingIds.push(m[1]);
      if (!ID.test(m[1])) entry.problems.push(`the id ${m[1]} is not # or a letter, letters and digits, then -, _ or . and digits`);
      if (!title || title.includes('Folded into ')) entry.problems.push('the title is empty or holds a malformed fold-in marker');
      continue;
    }
    if (!entry) { problems.push(`line ${i + 1}: not an entry heading, and no entry has begun`); continue; }
    const m = fieldLine.exec(line);
    if (!m) { entry.problems.push(`line ${i + 1} is no field line`); continue; }
    const name = m[1], value = m[2].trim(), at = fields.indexOf(name);
    if (entry.seen.has(name)) { entry.problems.push(`${name}: repeated`); continue; }
    entry.seen.add(name);
    if (at < entry.last) entry.problems.push(`${name}: out of order (the order is ${fields.join(', ')})`);
    entry.last = Math.max(entry.last, at);
    if (!value || !m[2].startsWith(' ')) { entry.problems.push(`${name}: empty or not followed by one space`); continue; }
    const read = readers[name](value);
    if (read.problem) entry.problems.push(read.problem);
    else entry.values[name] = read.value;
  }
  finish();
  // Every heading's id, read or not, so a duplicate is a problem whichever copy breaks the form.
  const uses = new Map();
  for (const id of headingIds) uses.set(id, (uses.get(id) || 0) + 1);
  for (const [id, n] of uses) if (n > 1) problems.push(`${id}: the id is used ${n} times`);
  return { entries: entries.filter(e => uses.get(e.id) === 1), problems };
}

// ===== Reading the flags' files ================================================================
class Unknown extends Error {}
function readFile(flag, file) {
  let stat;
  try { stat = fs.statSync(file); } catch (e) { throw new Unknown(`${flag} cannot be read: ${e.code || e.message}`); }
  if (!stat.isFile()) throw new Unknown(`${flag} is not a file`);
  try { return fs.readFileSync(file, 'utf8'); } catch (e) { throw new Unknown(`${flag} cannot be read: ${e.code || e.message}`); }
}
const shownList = items => items.slice(0, MAX_SHOWN).join('; ') + (items.length > MAX_SHOWN ? ` (+${items.length - MAX_SHOWN} more)` : '');
// A file every entry of which reads, or Unknown naming the flag: outside check an entry it cannot
// read leaves every count unknown.
function readForm(flag, file, form, fields, readers) {
  const parsed = parseForm(readFile(flag, file), form, fields, readers);
  if (parsed.fault) throw new Unknown(`${flag} ${parsed.fault}`);
  if (parsed.problems.length) throw new Unknown(`${flag} holds ${parsed.problems.length} problem(s), so no count is known: ${shownList(parsed.problems)}`);
  return parsed.entries;
}
const readBacklog = file => readForm('--backlog', file, BACKLOG_FORM, BACKLOG_FIELDS, BACKLOG_READERS);
function wholeNumber(flag, text) {
  if (!/^(?:0|[1-9]\d{0,8})$/.test(text)) throw new Unknown(`${flag} is not a whole number`);
  return Number(text);
}

// ===== The operations ==========================================================================
// To-do items per file: once per production file their Files: name, or, when every one is a test
// file, once per test file; decision items and folded entries are never counted.
export function packs(entries, threshold) {
  const byFile = new Map();
  for (const e of entries) {
    if (e.folded || e.Kind === 'decision') continue;
    const files = [...new Set(e.Files)], production = files.filter(f => !isTestPath(f));
    for (const f of production.length ? production : files) byFile.set(f, [...(byFile.get(f) || []), e.id]);
  }
  const over = [...byFile].filter(([, ids]) => ids.length >= threshold)
    .sort(([a, x], [b, y]) => y.length - x.length || (a < b ? -1 : a > b ? 1 : 0));
  return [`PACKS ${over.length} file(s) at or over ${threshold}`, ...over.map(([f, ids]) => `PACK ${f} ${ids.length}: ${ids.join(', ')}`)];
}
export function expired(entries, days, today) {
  const old = entries.filter(e => !e.folded && today - e.Since.day > days);
  return [`EXPIRED ${old.length} item(s) older than ${days} days`, ...old.map(e => `${e.id} since ${e.Since.date}`)];
}
export function rulings(entries, paths) {
  const hits = entries.map(e => ({ e, shared: e.Files.filter(f => paths.includes(f)) })).filter(h => h.shared.length);
  return [`RULINGS ${hits.length} ruling(s) on those paths`, ...hits.map(({ e, shared }) => `${e.id} ${e.Ruling.verdict} ${e.Ruling.date}: ${shared.join(', ')}`)];
}
function check(file) {
  const parsed = parseForm(readFile('--backlog', file), BACKLOG_FORM, BACKLOG_FIELDS, BACKLOG_READERS);
  if (parsed.fault) throw new Unknown(`--backlog ${parsed.fault}`);
  if (parsed.problems.length) return { code: 1, lines: [`BACKLOG FAIL ${parsed.problems.length} problem(s): ${shownList(parsed.problems)}`] };
  return { code: 0, lines: [`BACKLOG OK ${parsed.entries.length} item(s)`] };
}

const OPERATIONS = {
  packs: [['backlog', 'threshold'], f => ({ code: 0, lines: packs(readBacklog(f.backlog), wholeNumber('--threshold', f.threshold)) })],
  expired: [['backlog', 'days', 'today'], f => {
    const days = wholeNumber('--days', f.days), today = dayOf(f.today);
    if (today === null) throw new Unknown('--today is not a YYYY-MM-DD calendar date');
    return { code: 0, lines: expired(readBacklog(f.backlog), days, today) };
  }],
  rulings: [['rulings', 'paths'], f => {
    const paths = f.paths.split(',').map(p => p.trim());
    if (!paths.every(isRelativePath)) throw new Unknown('--paths is not a comma-separated list of repository-relative paths');
    return { code: 0, lines: rulings(readForm('--rulings', f.rulings, RULINGS_FORM, RULING_FIELDS, RULING_READERS), paths) };
  }],
  check: [['backlog'], f => check(f.backlog)],
};

// The CLI as a function: its exit code and the lines it prints, each one line.
export function backlogCli(args) {
  if (args.length === 1 && args[0] === '--help') return { code: 0, lines: HELP.split('\n') };
  const op = Object.hasOwn(OPERATIONS, args[0] ?? '') ? OPERATIONS[args[0]] : null;
  let flags;
  try {
    if (!op) throw new Error('no operation');
    flags = parseFlags(args.slice(1), op[0], op[0]);
  } catch { return { code: 2, lines: [USAGE] }; }
  try { const out = op[1](flags); return { code: out.code, lines: out.lines.map(oneLine) }; }
  catch (e) {
    if (e instanceof Unknown) return { code: 2, lines: [oneLine(`UNKNOWN ${e.message}`)] };
    return { code: 2, lines: [oneLine(`UNKNOWN internal error: ${e?.message ?? e}`)] };
  }
}

if (isMain(import.meta.url)) {
  // Exit 1 reads as a check FAIL, so a crash never ends with it: UNKNOWN, exit 2.
  process.on('uncaughtException', e => { fs.writeSync(1, oneLine(`UNKNOWN internal error: ${e?.message ?? e}`) + '\n'); process.exit(2); });
  const output = backlogCli(process.argv.slice(2));
  process.stdout.write(output.lines.map(oneLine).join('\n') + '\n');
  process.exitCode = output.code;
}
