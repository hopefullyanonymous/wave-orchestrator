#!/usr/bin/env node
// One JSON line describing a repository's live ledgers, for the orchestrate-mod /ledger pane. Ledgers and
// their routes come from `reconcile.mjs discovery`, each row's git verdict from `reconcile.mjs rows`; every
// table and every other contract line is read through the skill's orchestrate/tools/ledger-parse.mjs, the State
// and each Notes cell through orchestrate/tools/reconcile.mjs `stateOf` and `readNotes`. This tool joins their
// answers; the ledger text it parses of its own is the contract's `**Clear threshold**` line (`clearThreshold`), so
// a ledger pinned to a skill older than that line still reads, and the rest is the two reconcile commands' printed
// lines.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// A contract's clear threshold when it has no `**Clear threshold**` line: every ledger scaffolded before the line.
export const DEFAULT_CLEAR_THRESHOLD = 300000;

export const HELP = [
  'ledger-view.mjs --repo <dir> --skill-dir <dir>',
  '  Prints one JSON line {"v":1,"repo","incomplete","ledgers":[…]}: one entry per ledger reconcile.mjs discovery routes',
  '  to continue, close or status, or AMBIGUOUS only because its copies\' States differ ("warning" then holds that text),',
  '  read at its integration branch tip; one entry with "error" set per other AMBIGUOUS or UNKNOWN discovery line.',
  '  --repo is the repository root. --skill-dir holds tools/reconcile.mjs, which runs discovery,',
  "  and tools/ledger-parse.mjs, which reads each contract; every other read uses the skill directory that contract pins.",
  '  Each entry\'s "clearThreshold", which this tool reads from its contract\'s **Clear threshold**: <n>K line, is',
  `  {"tokens","source":"contract"}; {"tokens":${DEFAULT_CLEAR_THRESHOLD},"source":"default"} with no such line;`,
  '  {"error"} for two or a malformed one; null where the contract was not read.',
  'Exit 0: the JSON line, also with no ledger or with a ledger whose "error" is set. Exit 2: `UNKNOWN <reason>` when the',
  '  view cannot start: an invalid invocation, a skill directory without both tools, or a discovery run that does not',
  '  complete. Read-only; every path it prints uses forward slashes.',
].join('\n');

const TIMEOUT = 30000;
// The pinned skill's exports this tool calls; a pin lacking one is that ledger's error, never a partial view.
const PINNED = { 'ledger-parse.mjs': ['table', 'branchCell'], 'reconcile.mjs': ['stateOf', 'readNotes'] };
const BATCHES = ['#', 'Batch', 'Branch', 'Wave', 'Status', 'Notes'];
const CHECKPOINTS = ['Checkpoint', 'After wave', 'Status'];
const PLAN = ['#', 'Weight'];
// The statuses that hold a wave open (`⛔ (dropped)` excepted), as the derived `currentWave` reads them.
const OPEN = ['⬜', '🔄', '❌', '⛔'];
const SELECTED = ['continue', 'close', 'status'];
// A working-tree location: an absolute path in either platform's spelling. A branch name never starts with a
// slash or holds a colon or a backslash, so no branch reads as one.
const ABSOLUTE = /^(?:[A-Za-z]:[\\/]|[\\/])/;
const ESC = String.fromCharCode(27), BEL = String.fromCharCode(7);
const ANSI = new RegExp(`${ESC}(?:\\[[0-?]*[ -/]*[@-~]|\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)|[ -/]+[0-~]|[@-Z\\\\-_])`, 'g');
const decoder = new TextDecoder('utf-8', { fatal: true });

export const stripAnsi = text => text.replace(ANSI, '');
export const slashed = text => text.replace(/\\/g, '/');
const message = e => String(e && e.message !== undefined ? e.message : e).replace(/\s+/g, ' ').trim();
const linesOf = text => text.split(/\r?\n/).filter(line => line !== '');

// A child run: its UTF-8 stdout with ANSI stripped, or the reason it did not complete.
function run(command, args, { cwd, env, timeout, spawn }) {
  const r = spawn(command, args, { cwd, env, shell: false, windowsHide: true, timeout, maxBuffer: 64 * 1024 * 1024 });
  let text = null;
  try { text = stripAnsi(decoder.decode(r.stdout ?? new Uint8Array())); } catch { /* not UTF-8: no text */ }
  const why = r.error ? r.error.code || message(r.error) : r.signal ? `signal ${r.signal}` : text === null ? 'output is not UTF-8' : `exit ${r.status}`;
  return { done: !r.error && r.signal === null && text !== null, status: r.status, text, why };
}

// Imports each named tool from `<dir>/tools/` and checks it exports every function listed; throws otherwise.
export async function loadTools(dir, wanted) {
  const modules = {};
  for (const [file, names] of Object.entries(wanted)) {
    const mod = await import(pathToFileURL(path.join(dir, 'tools', file)).href);
    const missing = names.filter(name => typeof mod[name] !== 'function');
    if (missing.length) throw new Error(`tools/${file} exports no ${missing.join(', ')}`);
    modules[file] = mod;
  }
  return modules;
}

// A discovery line's locations: its branches, and where its contract is read, the 00-READBEFORE.md beside its
// first working-tree PROGRESS.md, else its first branch. A path holding ", " spans several parts, so a path
// runs from an absolute part to the next part ending in PROGRESS.md. Null for an empty part or a path that
// never ends so.
export function readLocations(locations) {
  const branches = [], paths = [];
  let open = null;
  for (const part of locations.split(', ')) {
    if (open !== null) open += `, ${part}`;
    else if (ABSOLUTE.test(part)) open = part;
    else if (part) { branches.push(part); continue; }
    else return null;
    if (/[\\/]PROGRESS\.md$/.test(open)) { paths.push(open); open = null; }
  }
  if (open !== null) return null;
  return { branches, source: paths.length ? { file: paths[0].slice(0, -'PROGRESS.md'.length) + '00-READBEFORE.md' } : { branch: branches[0] } };
}

// The lines of `reconcile.mjs discovery`: `recognised` is false when no line is in a form it prints. A ledger
// line routed to continue, close or status, or AMBIGUOUS only because its copies' States differ (the batch's
// Amendment 1), gives { id, source, branches, warning, line }, `warning` holding that AMBIGUOUS text; `→ none`
// lines are skipped; every other line (another AMBIGUOUS reason, `→ UNKNOWN (…)`, a mode or form unknown here)
// gives { id, error } so no ledger disappears.
export function readDiscovery(text) {
  const result = { recognised: false, incomplete: false, ledgers: [] };
  for (const line of linesOf(text)) {
    if (line === 'NO LEDGERS') { result.recognised = true; continue; }
    if (line.startsWith('INCOMPLETE ')) { result.recognised = result.incomplete = true; continue; }
    const id = line.split(' ')[0], cut = line.lastIndexOf(' → ');
    if (cut < 0) { result.ledgers.push({ id, error: slashed(line) }); continue; }
    result.recognised = true;
    const mode = line.slice(cut + 3);
    if (mode === 'none' || mode.startsWith('none (')) continue;
    const differs = mode.startsWith('AMBIGUOUS (State differs: ');
    const prefix = SELECTED.includes(mode) ? `${id} State=` : differs ? id : null;
    const at = prefix !== null && line.startsWith(prefix) ? line.indexOf(' at ', prefix.length) : -1;
    const where = at >= 0 && at < cut ? readLocations(line.slice(at + 4, cut)) : null;
    result.ledgers.push(where ? { id, source: where.source, branches: where.branches, warning: differs ? slashed(mode) : null, line } : { id, error: slashed(line) });
  }
  return result;
}

const THRESHOLD = /^\*\*Clear threshold\*\*: (\d+)K$/, CANDIDATE = /^\s*\*\*\s*clear[\W_]*threshold/i;
// The contract's clear threshold, LF or CRLF: `{ tokens, source: 'contract' }` from its one line in exactly the
// form THRESHOLD, `{ tokens: DEFAULT_CLEAR_THRESHOLD, source: 'default' }` with none, `{ error }` otherwise. A line
// is a candidate as by orchestrate/tools/ledger-parse.mjs `skillPin`'s rule, the label at its start in any case or
// indent, and also with any spacing or punctuation inside the bold label (`**Clear threshold:**`), so a near-miss is
// an error, never a line skipped.
export function clearThreshold(text) {
  const at = [];
  text.split(/\r?\n/).forEach((line, i) => { if (CANDIDATE.test(line)) at.push({ n: i + 1, line }); });
  if (at.length === 0) return { tokens: DEFAULT_CLEAR_THRESHOLD, source: 'default' };
  if (at.length > 1) return { error: `lines ${at.map(c => c.n).join(', ')} each open with **Clear threshold**` };
  const m = THRESHOLD.exec(at[0].line), tokens = m ? Number(m[1]) * 1000 : NaN;
  if (!Number.isSafeInteger(tokens)) return { error: `line ${at[0].n} is not **Clear threshold**: <n>K` };
  return { tokens, source: 'contract' };
}

// PROGRESS's batch and checkpoint tables and the plan's weights at the integration tip, every table, branch
// cell, State and Notes cell read by the pinned skill's own functions. { error } when a read throws.
export function readTables(progressText, planText, pinned, pinnedDir) {
  const { table, branchCell } = pinned['ledger-parse.mjs'], { stateOf, readNotes } = pinned['reconcile.mjs'];
  let state, batches, checkpoints, plan;
  try {
    state = stateOf(progressText);
    batches = table(progressText, BATCHES).map(row => ({ ...row, branch: branchCell(row.Branch) }));
    checkpoints = table(progressText, CHECKPOINTS);
    plan = table(planText, PLAN);
  } catch (e) { return { error: `UNKNOWN pinned skill ${pinnedDir}: ${message(e)}` }; }
  const rows = [];
  for (const row of batches) {
    const id = row['#'], planned = plan.filter(p => p['#'] === id);
    if (!/^\d+$/.test(row.Wave)) return { error: `UNKNOWN PROGRESS: ${id}'s Wave cell ${row.Wave} is not a wave number` };
    if (planned.length > 1) return { error: `UNKNOWN plan: ${id} has ${planned.length} rows in its batch table` };
    let round = null, roundError = null;
    try {
      const latest = readNotes(row.Notes).latestRound;
      round = latest ? `R${latest.k} ${latest.verdict}` : null;
    } catch (e) { roundError = message(e); }
    rows.push({ id, title: row.Batch, branch: row.branch, wave: Number(row.Wave), weight: planned.length ? planned[0].Weight : null, status: row.Status, round, roundError, git: null });
  }
  return { state, rows, checkpoints: checkpoints.map(c => ({ id: c.Checkpoint, afterWave: c['After wave'], status: c.Status })) };
}

// Builds the label a `rows` line opens with for a row: its id and its Status, whitespace runs collapsed, each
// invisible code point as `?`, to match orchestrate/tools/reconcile.mjs `reconcileRows` and
// orchestrate/tools/check-ledger.mjs `oneLine`. A free-text `⛔` reason may hold ` row ` or ` UNKNOWN `, so a
// line is split after this label, never at a token search.
const invisible = n => n < 32 || (n >= 127 && n <= 159) || n === 0x2028 || n === 0x2029;
const labelOf = row => [...`${row.id} ${row.status.replace(/\s+/g, ' ').trim()}`].map(c => invisible(c.codePointAt(0)) ? '?' : c).join('');

// `reconcile.mjs rows` output joined to the rows. Its first line must be a bare UNKNOWN (the ledger's error) or
// the `RECONCILE <id> @<sha>` header naming this ledger at the tip the tables were read from, so tables and
// verdicts are one commit. Each later line is the row's label then `row <k>: <Verdict>` (k may read `22 or 23`)
// or `UNKNOWN <fact>: <why>`, keyed on its first token. A row it prints no line for keeps `git: null`.
// { error } for no output, a moved tip, or a line in neither form or naming no single row.
export function attachVerdicts(rows, text, tip) {
  const [head, ...lines] = linesOf(text), git = new Map();
  const unplaced = line => ({ error: `UNKNOWN rows printed a line this view cannot place: ${line}` });
  if (head === undefined) return { error: 'UNKNOWN rows did not complete: no output' };
  if (head.startsWith('UNKNOWN ')) return { error: head };
  const header = /^RECONCILE (\S+) @([0-9a-f]{7,64}) /.exec(head);
  if (!header || header[1] !== tip.id) return unplaced(head);
  if (!tip.sha.startsWith(header[2])) return { error: `UNKNOWN integration refs/heads/${tip.branch} moved during the read: ${tip.sha.slice(0, 7)} → ${header[2]}` };
  for (const line of lines) {
    if (line.startsWith('PRUNE ')) continue;
    const id = line.split(' ')[0], matches = rows.filter(row => row.id === id);
    if (matches.length !== 1 || git.has(id)) return unplaced(line);
    const label = labelOf(matches[0]), rest = line.startsWith(label) ? line.slice(label.length) : '';
    let verdict = null;
    if (rest.startsWith(' UNKNOWN ')) verdict = { unknown: rest.slice(' UNKNOWN '.length) };
    else if (rest.startsWith(' row ')) {
      const tail = rest.slice(' row '.length), colon = tail.indexOf(': ');
      if (colon >= 0 && /^\d+(?: or \d+)?$/.test(tail.slice(0, colon))) verdict = { row: tail.slice(0, colon), verdict: tail.slice(colon + 2) };
    }
    if (!verdict) return unplaced(line);
    git.set(id, verdict);
  }
  return { rows: rows.map(row => ({ ...row, git: git.get(row.id) ?? null })) };
}

// `waves`: the highest wave; `currentWave`: the lowest wave holding a row whose status opens with ⬜, 🔄, ❌ or ⛔
// (not `⛔ (dropped)`), else the highest; `nextCheckpoint`: the first checkpoint whose status is not ✅.
export function derive(rows, checkpoints) {
  const waves = rows.length ? Math.max(...rows.map(r => r.wave)) : null;
  const open = rows.filter(r => OPEN.includes([...r.status][0]) && r.status !== '⛔ (dropped)').map(r => r.wave);
  return { waves, currentWave: open.length ? Math.min(...open) : waves, nextCheckpoint: checkpoints.find(c => [...c.status][0] !== '✅')?.id ?? null };
}

// One ledger discovery routed to a mode: contract, integration tip, tables, verdicts. Every read that fails
// returns the entry with `error` set and the fields read so far, its rows empty. `child` runs every child.
async function readLedger({ root, entry, parse, child }) {
  const view = { id: entry.id, state: null, integration: null, skillDir: null, clearThreshold: null, waves: null, currentWave: null, nextCheckpoint: null, rows: [], checkpoints: [], error: null, warning: entry.warning };
  const fail = error => ({ ...view, error: slashed(error) });
  const git = args => child('git', args);
  const dir = `.agents/changes/${entry.id}`;
  let text, where;
  if (entry.source.file) {
    where = entry.source.file;
    try { text = decoder.decode(fs.readFileSync(where)); } catch (e) { return fail(`UNKNOWN contract ${where}: ${e.code || message(e)}`); }
  } else {
    // `./` resolves the path from the repository root, where every git child runs.
    where = `${entry.source.branch}:./${dir}/00-READBEFORE.md`;
    const r = git(['show', where]);
    if (!r.done || r.status !== 0) return fail(`UNKNOWN contract ${where}: git show did not read it (${r.why})`);
    text = r.text;
  }
  // The integration field is read inside this try, so a label orchestrate/tools/ledger-parse.mjs `gitModel`
  // refuses is this ledger's error.
  let integration, pin;
  try { integration = parse.gitModel(text).integration; pin = parse.skillPin(text); } catch (e) { return fail(`UNKNOWN contract ${where}: ${message(e)}`); }
  if (!integration) return fail(`UNKNOWN contract ${where}: no Integration branch recorded`);
  const branch = integration.replace(/^refs\/heads\//, ''), pinnedDir = path.resolve(root, pin.dir);
  view.integration = { branch, sha: null };
  view.skillDir = slashed(pinnedDir);
  view.clearThreshold = clearThreshold(text);
  // A copy whose State differs is read only when its integration branch, as a local branch, holds a copy.
  if (entry.warning !== null && !entry.branches.includes(branch)) return fail(`UNKNOWN integration branch ${branch} holds no copy of ${entry.id}: ${entry.line}`);
  const tip = git(['rev-parse', '--verify', '--quiet', '--end-of-options', `refs/heads/${branch}^{commit}`]);
  if (!tip.done || tip.status !== 0) return fail(`UNKNOWN integration refs/heads/${branch}: git rev-parse did not resolve it (${tip.why})`);
  const sha = tip.text.trim();
  view.integration = { branch, sha };
  let pinned;
  try { pinned = await loadTools(pinnedDir, PINNED); } catch (e) { return fail(`UNKNOWN pinned skill ${pinnedDir}: ${message(e)}`); }
  // Both tables are read at the tip SHA, so they and `integration.sha` are one commit.
  const texts = {};
  for (const file of ['PROGRESS.md', '01-plan.md']) {
    const r = git(['show', `${sha}:./${dir}/${file}`]);
    if (!r.done || r.status !== 0) return fail(`UNKNOWN ledger: ${dir}/${file} cannot be read at refs/heads/${branch} (${r.why})`);
    texts[file] = r.text;
  }
  const tables = readTables(texts['PROGRESS.md'], texts['01-plan.md'], pinned, pinnedDir);
  if (tables.error) return fail(tables.error);
  view.state = tables.state;
  const verdicts = child(process.execPath, [path.join(pinnedDir, 'tools', 'reconcile.mjs'), 'rows', '--repo', root, '--ledger', entry.id, '--integration', `refs/heads/${branch}`]);
  if (!verdicts.done || ![0, 2].includes(verdicts.status)) return fail(`UNKNOWN rows did not complete: ${verdicts.why}`);
  const placed = attachVerdicts(tables.rows, verdicts.text, { id: entry.id, sha, branch });
  if (placed.error) return fail(placed.error);
  return { ...view, ...derive(placed.rows, tables.checkpoints), rows: placed.rows, checkpoints: tables.checkpoints };
}

// The view in-process: { code: 0, view } or { code: 2, line: 'UNKNOWN …' }. `env` is the environment of every
// git and node child; `timeout` bounds each child in milliseconds. `spawn` is a test seam for node:child_process
// `spawnSync`, so a test can read the options every child runs with; the CLI never sets it.
export async function ledgerView({ repo, skillDir, env = process.env, timeout = TIMEOUT, spawn = spawnSync }) {
  const unknown = reason => ({ code: 2, line: slashed(`UNKNOWN ${reason}`.replace(/\s+/g, ' ')) });
  const root = path.resolve(repo), skill = path.resolve(skillDir);
  for (const file of ['reconcile.mjs', 'ledger-parse.mjs']) {
    let why = null;
    try { if (!fs.statSync(path.join(skill, 'tools', file)).isFile()) why = 'not a file'; } catch (e) { why = e.code || message(e); }
    if (why) return unknown(`skill directory ${skill}: tools/${file} cannot be used (${why})`);
  }
  let parse;
  try { parse = (await loadTools(skill, { 'ledger-parse.mjs': ['gitModel', 'skillPin'] }))['ledger-parse.mjs']; } catch (e) { return unknown(`skill directory ${skill}: ${message(e)}`); }
  const child = (command, args) => run(command, args, { cwd: root, env, timeout, spawn });
  const found = child(process.execPath, [path.join(skill, 'tools', 'reconcile.mjs'), 'discovery', '--repo', root]);
  if (!found.done || ![0, 2].includes(found.status)) return unknown(`discovery did not complete: ${found.why}`);
  const discovered = readDiscovery(found.text);
  if (!discovered.recognised) return unknown(`discovery printed no line in a form it prints: ${linesOf(found.text)[0] ?? 'no output'}`);
  const ledgers = [];
  for (const entry of discovered.ledgers) {
    ledgers.push(entry.error ? { id: entry.id, state: null, integration: null, skillDir: null, clearThreshold: null, waves: null, currentWave: null, nextCheckpoint: null, rows: [], checkpoints: [], error: entry.error, warning: null }
      : await readLedger({ root, entry, parse, child }));
  }
  return { code: 0, view: { v: 1, repo: slashed(root), incomplete: discovered.incomplete, ledgers } };
}

export async function ledgerViewCli(args, options = {}) {
  if (args.length === 1 && args[0] === '--help') return { code: 0, lines: [HELP] };
  const usage = { code: 2, lines: ['UNKNOWN usage: --repo <dir> and --skill-dir <dir>, each given once, are required; use --help'] }, flags = {};
  for (let i = 0; i < args.length; i += 2) {
    const name = /^--(repo|skill-dir)$/.exec(args[i] ?? '')?.[1], value = args[i + 1];
    if (!name || Object.hasOwn(flags, name) || !value || value.startsWith('--')) return usage;
    flags[name] = value;
  }
  if (!flags.repo || !flags['skill-dir']) return usage;
  const out = await ledgerView({ repo: flags.repo, skillDir: flags['skill-dir'], ...options });
  return { code: out.code, lines: [out.code === 0 ? JSON.stringify(out.view) : out.line] };
}

// The CLI runs only as the entry script, both sides resolved through links, so an import never runs it.
const isEntry = url => { try { return Boolean(process.argv[1]) && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(url)); } catch { return false; } };
if (isEntry(import.meta.url)) {
  const out = await ledgerViewCli(process.argv.slice(2));
  process.stdout.write(out.lines.join('\n') + '\n');
  process.exitCode = out.code;
}
