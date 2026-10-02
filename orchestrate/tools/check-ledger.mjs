#!/usr/bin/env node
// Working-tree ledger parse check and skill-directory pin. Every ledger shape is read through
// ledger-parse.mjs, the parser the fence tool uses; this tool may be stricter, never looser.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { decode, git, parseFlags, validFullRef, validId, validPath, isMain } from './git-evidence.mjs';
import { linesOf, exactPaths, table, oneRow, branchCell, extensions, skillPin, gitModel } from './ledger-parse.mjs';

const PLAN = '01-plan.md', PROGRESS = 'PROGRESS.md', CONTRACT = '00-READBEFORE.md';
const PLAN_KEYS = ['#', 'Branch', 'Files (fence)'], PROGRESS_KEYS = ['#', 'Branch', 'Notes'];
const BATCH_FILE = /^02-batches-.*\.md$/;
const MAX_PROBLEMS = 10;
// Operating-system litter the repository's .gitignore already names: never part of the pin.
const LITTER = ['.ds_store', 'thumbs.db', 'desktop.ini'];
const HELP = 'check-ledger.mjs parse --dir <ledger-dir> | skill [--dir <skill-dir>] [--contract <00-READBEFORE.md>] (at least one of the two; a relative pinned directory resolves from the working directory) | selfcheck --dir <ledger-dir> (the scaffold self-check: no slot outside code, State ACTIVE, the pre-flight line, parse, the skill pin) | plan --dir <ledger-dir> --repo <root> (parse, waves, same-wave fence disjointness, dependencies, fence paths existing or marked new) | cites --dir <ledger-dir> --repo <root> (each pinned citation of the plan and batch files, a `path:line` or `path:line-line` span then one space and a `symbol` span, holds under the root; other path:line spans are listed as unpinned) | census --dir <ledger-dir> --repo <root> [--batch <Bnn>] (tracked files outside every fence and outside .agents/ that name a fenced path by path, import specifier or basename). Exit 0 PARSE OK, SKILL <hash>, SKILL MATCH, SELFCHECK OK, PLAN OK, CITES OK or CENSUS; 1 PARSE FAIL, SKILL MISMATCH, SELFCHECK FAIL, PLAN FAIL or CITES FAIL; 2 UNKNOWN. Always one line.';

class Unknown extends Error {}

// Ledger files are read without following links: the fence accepts only ordinary committed
// files, so a link, however readable, is never a ledger file here either.
function readText(file, ordinary = false) {
  let stat, bytes;
  try { stat = (ordinary ? fs.lstatSync : fs.statSync)(file); } catch { throw new Unknown(`cannot read ${file}`); }
  if (stat.isSymbolicLink()) throw new Unknown(`a link, not an ordinary file: ${file}`);
  if (!stat.isFile()) throw new Unknown(ordinary ? `not an ordinary file: ${file}` : `cannot read ${file}`);
  try { bytes = fs.readFileSync(file); } catch { throw new Unknown(`cannot read ${file}`); }
  try { return decode(bytes); } catch { throw new Unknown(`not UTF-8: ${file}`); }
}

// A table the fence could not read fails whole; each id is then held to oneRow's rules alone,
// so a duplicate or malformed id is blamed on its own row. Any such row fails the fence for
// every batch, which is exactly when this reports it.
function rowsOf(text, file, keys, add) {
  let rows;
  try { rows = table(text, keys); } catch (e) { add(file, 1, `batch table (${keys.join(', ')}): ${e.message}`); return null; }
  if (!rows.length) { add(file, 1, `batch table (${keys.join(', ')}) has no rows`); return null; }
  for (const row of rows) {
    try { oneRow(rows.filter(r => r['#'] === row['#']), row['#']); } catch (e) { add(file, row.line, `${row['#']}: ${e.message}`); row.invalid = true; }
  }
  return rows;
}

function linesStarting(lines, prefix) {
  return lines.flatMap((l, i) => l.startsWith(prefix) ? [i + 1] : []);
}

// The strictness bar is the fence tool's own linkage and structure checks on a batch file.
function checkBatch(name, text, id, branch, fence, add) {
  const lines = linesOf(text);
  if (!new RegExp(`^# ${id} (?:—|-) `).test(text)) add(name, 1, `title must open "# ${id} — "`);
  const branchAt = linesStarting(lines, '**Branch**: ');
  if (branchAt.length !== 1) add(name, branchAt[1] ?? 1, `${branchAt.length} lines start "**Branch**: ", expected exactly one`);
  else if (branch !== null && lines[branchAt[0] - 1] !== `**Branch**: \`${branch}\``) add(name, branchAt[0], `Branch line must read exactly **Branch**: \`${branch}\``);
  const filesAt = linesStarting(lines, '**Files**: ');
  if (filesAt.length !== 1) add(name, filesAt[1] ?? 1, `${filesAt.length} lines start "**Files**: ", expected exactly one`);
  else if (fence !== null) {
    try {
      if (JSON.stringify(exactPaths(lines[filesAt[0] - 1].slice(11))) !== JSON.stringify(fence)) add(name, filesAt[0], 'Files line differs from the plan fence');
    } catch (e) { add(name, filesAt[0], `Files line: ${e.message}`); }
  }
  const checklist = lines.flatMap((l, i) => l === '## Checklist' ? [i] : []);
  if (checklist.length !== 1 || !lines.some((l, i) => i > checklist[0] && /^## /.test(l))) {
    add(name, checklist.length ? checklist[checklist.length > 1 ? 1 : 0] + 1 : 1, 'needs exactly one "## Checklist" line followed by another "## " heading');
  }
}

// The contract's integration branch and default branch name, or null after the problem that
// stands for them: a ledger always carries its contract, so a missing one fails closed.
function reservedBranches(contract, reason, add) {
  if (contract === null) { add(CONTRACT, 1, reason ?? 'no contract; the integration branch is read from it'); return null; }
  const at = linesOf(contract).findIndex(l => /^## Git model\b/.test(l)) + 1 || 1;
  let model, integration, main = null;
  try { model = gitModel(contract); } catch (e) { add(CONTRACT, at, `Git model: ${e.message}`); return null; }
  try { integration = model.integration; } catch (e) { add(CONTRACT, at, `Git model integration branch: ${e.message}`); return null; }
  if (integration === null) { add(CONTRACT, at, 'Git model: no "Integration branch: `<name>`" label'); return null; }
  // A value still holding a template slot names no branch: an unfilled contract fails closed.
  if (integration.includes('{{')) { add(CONTRACT, at, `Git model integration branch: ${integration} is an unfilled slot`); return null; }
  try { main = model.main; } catch (e) { add(CONTRACT, at, `Git model default branch: ${e.message}`); }
  if (main !== null && main.includes('{{')) { add(CONTRACT, at, `Git model default branch: ${main} is an unfilled slot`); main = null; }
  // The default branch is recorded as a full local ref; a batch Branch cell holds a bare name.
  return { integration, main: main === null ? null : main.replace(/^refs\/heads\//, '') };
}

// Pure core: the plan and PROGRESS texts, a Map of batch file name to text, the ledger id (the
// directory name the fence finds it under, `.agents/changes/<ledger>`) and the contract text, or
// null, which names the two branches no batch may take.
export function checkLedger(plan, progress, batches, ledger, contract = null) {
  const { problems, planned } = inspect(plan, progress, batches, ledger, contract ?? null, null);
  return { status: problems.length ? 'FAIL' : 'OK', batches: planned.size, problems };
}

function inspect(plan, progress, batches, ledger, contract, reason) {
  const problems = [], add = (file, line, message) => problems.push({ file, line, message, rule: 'parse' });
  // The fence refuses to run at all for a ledger id or a batch-file path it cannot accept.
  if (!validId(ledger)) add(PLAN, 1, `ledger directory ${ledger} is not a valid ledger id`);
  const reserved = reservedBranches(contract, reason, add);
  const refuseReserved = (file, line, id, branch) => {
    if (reserved && branch === reserved.integration) add(file, line, `${id} Branch: ${branch} is the integration branch`);
    else if (reserved && branch === reserved.main) add(file, line, `${id} Branch: ${branch} is the default branch`);
  };
  const planRows = rowsOf(plan, PLAN, PLAN_KEYS, add);
  const progressRows = rowsOf(progress, PROGRESS, PROGRESS_KEYS, add);
  // Rows already blamed for their id are counted as present but checked no further.
  const planned = new Map(), planIds = new Set((planRows ?? []).map(r => r['#']));
  for (const row of planRows ?? []) {
    if (row.invalid) continue;
    let fence = null, branch = null;
    try { fence = exactPaths(row['Files (fence)']); } catch (e) { add(PLAN, row.line, `${row['#']} Files (fence): ${e.message}`); }
    try { branch = branchCell(row.Branch); } catch (e) { add(PLAN, row.line, `${row['#']} Branch: ${e.message}`); }
    // The fence can gate only a branch whose full ref it accepts.
    if (branch !== null && !validFullRef(`refs/heads/${branch}`)) add(PLAN, row.line, `${row['#']} Branch: ${branch} is not a valid branch name`);
    if (branch !== null) refuseReserved(PLAN, row.line, row['#'], branch);
    planned.set(row['#'], { row, fence, branch });
  }
  // Each batch's own file, where exactly one exists: an extension may not name it.
  const names = [...batches.keys()];
  for (const [id, entry] of planned) {
    entry.own = names.filter(n => n.startsWith(`02-batches-${id.slice(1)}-`));
    entry.ownPath = entry.own.length === 1 ? `.agents/changes/${ledger}/${entry.own[0]}` : null;
  }
  if (progressRows && planRows) {
    const seen = new Set();
    for (const row of progressRows) {
      const id = row['#'], entry = planned.get(id);
      seen.add(id);
      if (!planIds.has(id)) { add(PROGRESS, row.line, `${id}: no plan row`); continue; }
      if (row.invalid || !entry) continue;
      try {
        const branch = branchCell(row.Branch);
        if (entry.branch !== null && branch !== entry.branch) add(PROGRESS, row.line, `${id}: Branch ${branch} differs from the plan's ${entry.branch}`);
        refuseReserved(PROGRESS, row.line, id, branch);
      } catch (e) { add(PROGRESS, row.line, `${id} Branch: ${e.message}`); }
      try {
        const extra = extensions(progress, row, id);
        if (entry.fence && extra.some(p => entry.fence.includes(p))) add(PROGRESS, row.line, `${id} Notes: extension repeats a fence path`);
        if (extra.some(p => p === entry.ownPath)) add(PROGRESS, row.line, `${id} Notes: extension names the batch's own file`);
      } catch (e) { add(PROGRESS, row.line, `${id} Notes: ${e.message}`); }
    }
    for (const [id, entry] of planned) if (!seen.has(id)) add(PLAN, entry.row.line, `${id}: no PROGRESS row`);
  }
  if (planRows) {
    for (const [id, entry] of planned) {
      const { own } = entry;
      if (own.length !== 1) { add(PLAN, entry.row.line, `${id}: ${own.length} batch files 02-batches-${id.slice(1)}-*.md, expected exactly one`); continue; }
      if (!validPath(entry.ownPath)) add(own[0], 1, `batch file path ${entry.ownPath} is not a valid repository path`);
      checkBatch(own[0], batches.get(own[0]), id, entry.branch, entry.fence, add);
    }
    for (const name of names) {
      const m = /^02-batches-(\d+)-/.exec(name);
      if (!m || !planIds.has('B' + m[1])) add(name, 1, 'no plan row claims this batch file');
    }
  }
  return { problems, planned, progressRows };
}

// Every ledger file parse reads, each an ordinary file; an unreadable contract is carried as its
// reason, which parse reports as a problem rather than an UNKNOWN.
function readLedger(dir) {
  let names;
  try { if (!fs.statSync(dir).isDirectory()) throw new Error(); names = fs.readdirSync(dir); } catch { throw new Unknown(`cannot read ledger directory ${dir}`); }
  const plan = readText(path.join(dir, PLAN), true), progress = readText(path.join(dir, PROGRESS), true);
  const batches = new Map(names.filter(n => BATCH_FILE.test(n)).sort().map(n => [n, readText(path.join(dir, n), true)]));
  const file = path.join(dir, CONTRACT);
  let contract = null, reason = null;
  try { contract = readText(file, true); } catch (e) { if (!(e instanceof Unknown)) throw e; reason = e.message.split(file).join(CONTRACT); }
  return { plan, progress, batches, contract, reason, ledger: path.basename(path.resolve(dir)) };
}
const inspectLedger = read => inspect(read.plan, read.progress, read.batches, read.ledger, read.contract, read.reason);

export function parseLedger(dir) {
  const { problems, planned } = inspectLedger(readLedger(dir));
  return { status: problems.length ? 'FAIL' : 'OK', batches: planned.size, problems };
}

function lf(bytes) {
  const out = Buffer.allocUnsafe(bytes.length);
  let n = 0;
  for (let i = 0; i < bytes.length; i++) if (!(bytes[i] === 13 && bytes[i + 1] === 10)) out[n++] = bytes[i];
  return out.subarray(0, n);
}

// SHA-256 over every regular file, sorted by '/'-separated relative path in code-unit order:
// per file the path, a NUL, the bytes with each CRLF pair made LF, and a NUL.
export function skillHash(dir) {
  const files = [];
  const walk = (abs, rel, ancestors) => {
    let real, names;
    try { real = fs.realpathSync(abs); names = fs.readdirSync(abs); } catch { throw new Unknown(`cannot read skill directory ${rel || dir}`); }
    if (ancestors.includes(real)) throw new Unknown(`directory cycle at ${rel}`);
    for (const name of names) {
      const full = path.join(abs, name), relPath = rel ? `${rel}/${name}` : name;
      let stat;
      try { stat = fs.statSync(full); } catch { throw new Unknown(`cannot stat ${relPath}`); }
      if (stat.isDirectory()) walk(full, relPath, [...ancestors, real]);
      else if (!stat.isFile()) throw new Unknown(`not a regular file or directory: ${relPath}`);
      else if (!LITTER.includes(name.toLowerCase())) files.push({ rel: relPath, full });
    }
  };
  let stat;
  try { stat = fs.statSync(dir); } catch { throw new Unknown(`cannot read skill directory ${dir}`); }
  if (!stat.isDirectory()) throw new Unknown(`not a directory: ${dir}`);
  walk(path.resolve(dir), '', []);
  if (!files.length) throw new Unknown(`no files in skill directory ${dir}`);
  files.sort((a, b) => a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0);
  const hash = createHash('sha256'), nul = Buffer.from([0]);
  for (const file of files) {
    let bytes;
    try { bytes = fs.readFileSync(file.full); } catch { throw new Unknown(`cannot read ${file.rel}`); }
    hash.update(Buffer.from(file.rel, 'utf8')); hash.update(nul); hash.update(lf(bytes)); hash.update(nul);
  }
  return { hex: hash.digest('hex'), files: files.length };
}

function skill({ dir, contract }) {
  let pin = null;
  if (contract !== undefined) {
    const text = readText(contract);
    try { pin = skillPin(text); } catch (e) { throw new Unknown(`${e.message} in ${contract}`); }
  }
  const { hex, files } = skillHash(dir ?? pin.dir);
  if (!pin) return { code: 0, line: `SKILL ${hex} ${files} files` };
  return hex === pin.hex ? { code: 0, line: `SKILL MATCH ${hex}` } : { code: 1, line: `SKILL MISMATCH pinned ${pin.hex} actual ${hex}` };
}

// The stable rule id of every selfcheck and plan problem, in the order they are reported. The
// selfcheck ids name the rules of step 9 in orchestrate/references/scaffolding.md; `parse` holds
// every batch-table row to a Bnn id.
export const RULES = {
  selfcheck: ['slot', 'state', 'preflight', 'parse', 'skill'],
  plan: ['parse', 'wave', 'disjoint', 'depends', 'cycle', 'new-files', 'fence-path'],
};
// A token that marks an unfilled template, outside code: `<title>` counts in Markdown only.
const SLOT_TOKENS = [['{{', 'an unfilled {{ slot', false], ['<!--', 'an unremoved <!-- comment', false], ['<title>', 'an unfilled <title> slot', true]];
const PREFLIGHT = /^Pre-flight: (?:CLEAN|\d+ blocking fixed, \d+ advisory \(see LOG\.md\))$/;

// Each inline code span of a line as [start, end): a backtick run closed by a run of the same
// length on the same line. An unclosed run is literal text.
function spansOf(line) {
  const runAt = i => { let n = 0; while (line[i + n] === '`') n++; return n; };
  const spans = [];
  let i = 0;
  while (i < line.length) {
    if (line[i] !== '`') { i++; continue; }
    const n = runAt(i);
    let j = i + n, close = -1;
    while (j < line.length && close === -1) {
      if (line[j] !== '`') { j++; continue; }
      const m = runAt(j);
      if (m === n) close = j; else j += m;
    }
    if (close === -1) { i += n; continue; }
    spans.push({ start: i, end: close + n, text: line.slice(i + n, close) });
    i = close + n;
  }
  return spans;
}
// A line with each inline code span blanked.
function withoutSpans(line) {
  let out = '', at = 0;
  for (const { start, end } of spansOf(line)) { out += line.slice(at, start) + ' '.repeat(end - start); at = end; }
  return out + line.slice(at);
}
// The lines of a text with each fenced code block (three or more backticks or tildes, closed by a
// run of the same character at least as long) blanked. A fence that never closes is kept: doubt
// reads as prose.
function outsideFences(text) {
  const lines = linesOf(text), out = lines.slice();
  for (let i = 0; i < lines.length; i++) {
    const open = /^ {0,3}(`{3,}|~{3,})/.exec(lines[i]);
    if (!open || (open[1][0] === '`' && lines[i].slice(open[0].length).includes('`'))) continue;
    const closer = new RegExp(`^ {0,3}${open[1][0]}{${open[1].length},}[ \\t]*$`);
    const close = lines.findIndex((l, j) => j > i && closer.test(l));
    if (close === -1) continue;
    for (let j = i; j <= close; j++) out[j] = '';
    i = close;
  }
  return out;
}
// The lines a reader sees as prose: fenced blocks, then code spans, blanked.
const proseLines = text => outsideFences(text).map(withoutSpans);
// Every file under the ledger directory, '/'-separated and sorted, at any depth.
function ledgerFiles(dir, rel = '') {
  let names;
  try { names = fs.readdirSync(rel ? path.join(dir, ...rel.split('/')) : dir).sort(); } catch { throw new Unknown(`cannot read ledger directory ${dir}`); }
  return names.flatMap(name => {
    const relPath = rel ? `${rel}/${name}` : name;
    let stat;
    try { stat = fs.lstatSync(path.join(dir, ...relPath.split('/'))); } catch { throw new Unknown(`cannot stat ${relPath}`); }
    return stat.isDirectory() ? ledgerFiles(dir, relPath) : [relPath];
  });
}
// The line numbers of the lines opening with a label.
const labelled = (text, prefix) => linesStarting(linesOf(text), prefix);

// Scaffolding step 9 over a ledger directory. Throws Unknown when a file cannot be read or the
// pinned skill directory cannot be hashed.
export function selfcheck(dir) {
  const read = readLedger(dir), problems = [];
  const add = (file, line, message, rule) => problems.push({ file, line, message, rule });
  for (const rel of ledgerFiles(dir)) {
    proseLines(readText(path.join(dir, ...rel.split('/')), true)).forEach((line, i) => {
      for (const [token, what, markdownOnly] of SLOT_TOKENS) if ((!markdownOnly || rel.endsWith('.md')) && line.includes(token)) add(rel, i + 1, what, 'slot');
    });
  }
  const exactLine = (file, text, prefix, ok, want, rule) => {
    const at = labelled(text, prefix);
    if (at.length !== 1) add(file, at[1] ?? 1, `${at.length} lines start "${prefix}", expected exactly one`, rule);
    else if (!ok(linesOf(text)[at[0] - 1])) add(file, at[0], `must read exactly ${want}`, rule);
  };
  exactLine(PROGRESS, read.progress, '**State**:', l => l === '**State**: ACTIVE', '**State**: ACTIVE', 'state');
  exactLine(PLAN, read.plan, 'Pre-flight:', l => PREFLIGHT.test(l), '"Pre-flight: CLEAN" or "Pre-flight: N blocking fixed, M advisory (see LOG.md)"', 'preflight');
  const parsed = inspectLedger(read);
  problems.push(...parsed.problems);
  if (read.contract !== null) {
    const at = linesOf(read.contract).findIndex(l => /^\s*\*\*skill\*\*/i.test(l)) + 1 || 1;
    let pin = null;
    try { pin = skillPin(read.contract); } catch (e) { add(CONTRACT, at, `skill pin: ${e.message}`, 'skill'); }
    if (pin) {
      const { hex } = skillHash(pin.dir);
      if (hex !== pin.hex) add(CONTRACT, at, `skill pin: pinned ${pin.hex} actual ${hex}`, 'skill');
    }
  }
  return { status: problems.length ? 'FAIL' : 'OK', batches: parsed.planned.size, problems };
}

// A repository path's kind under the root, without following a final link.
function pathKind(repo, rel) {
  try { return fs.lstatSync(path.join(repo, ...rel.split('/'))).isDirectory() ? 'directory' : 'file'; }
  catch (e) { if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return 'none'; throw new Unknown(`cannot stat ${rel} under ${repo}`); }
}
// The one dependency cycle through each set of batches, each reported once from its lowest id.
function cycles(deps) {
  const found = new Map(), state = new Map();
  const visit = (id, trail) => {
    state.set(id, 'open');
    for (const dep of deps.get(id) ?? []) {
      if (state.get(dep) === 'open') {
        const loop = trail.slice(trail.indexOf(dep));
        const lowest = loop.indexOf([...loop].sort()[0]), key = [...loop.slice(lowest), ...loop.slice(0, lowest)];
        found.set(key.join(), key);
      } else if (!state.has(dep)) visit(dep, [...trail, dep]);
    }
    state.set(id, 'done');
  };
  for (const id of deps.keys()) if (!state.has(id)) visit(id, [id]);
  return [...found.values()];
}

// The plan's wave, dependency and fence rules over a ledger directory, fence paths resolved under
// the repository root. Throws Unknown when a file or the root cannot be read.
export function planCheck(dir, repo) {
  const read = readLedger(dir);
  let root = null;
  try { root = fs.statSync(repo); } catch { root = null; }
  if (!root || !root.isDirectory()) throw new Unknown(`cannot read repository ${repo}`);
  const { problems, planned, progressRows } = inspectLedger(read);
  const add = (file, line, message, rule) => problems.push({ file, line, message, rule });
  const wave = new Map(), deps = new Map(), marks = new Map(), fileOf = new Map();
  // Waves: a positive integer in the plan, the same in PROGRESS and in the batch file.
  for (const [id, entry] of planned) {
    const cell = entry.row.Wave;
    if (cell === undefined || !/^[1-9]\d*$/.test(cell)) { add(PLAN, entry.row.line, `${id} Wave: expected a positive integer, found "${cell ?? ''}"`, 'wave'); continue; }
    wave.set(id, Number(cell));
    const prow = (progressRows ?? []).find(r => r['#'] === id && !r.invalid);
    if (prow && prow.Wave !== cell) add(PROGRESS, prow.line, `${id} Wave: ${prow.Wave ?? '(no Wave column)'} differs from the plan's ${cell}`, 'wave');
    if (entry.own.length !== 1) continue;
    const name = entry.own[0], text = read.batches.get(name), at = labelled(text, '**Wave**: ');
    if (at.length !== 1) { add(name, at[1] ?? 1, `${at.length} lines start "**Wave**: ", expected exactly one`, 'wave'); continue; }
    const value = /^\*\*Wave\*\*: (.*?)(?: · .*)?$/.exec(linesOf(text)[at[0] - 1])[1].trim();
    if (value !== cell) add(name, at[0], `Wave ${value} differs from the plan's ${cell}`, 'wave');
  }
  // Disjointness: within one wave, no path is in two plan fences.
  const ids = [...planned.keys()];
  for (let a = 0; a < ids.length; a++) for (let b = a + 1; b < ids.length; b++) {
    const [x, y] = [planned.get(ids[a]), planned.get(ids[b])];
    if (!wave.has(ids[a]) || wave.get(ids[a]) !== wave.get(ids[b]) || !x.fence || !y.fence) continue;
    const shared = x.fence.filter(p => y.fence.includes(p));
    if (shared.length) add(PLAN, y.row.line, `${ids[a]} and ${ids[b]} are both in wave ${wave.get(ids[a])} and both fence ${shared.map(p => `\`${p}\``).join(', ')}`, 'disjoint');
  }
  // Dependencies: every Bnn token of the one Depends line, or the whole value `none`.
  for (const [id, entry] of planned) {
    if (entry.own.length !== 1) continue;
    const name = entry.own[0], text = read.batches.get(name), at = labelled(text, '**Depends on**: ');
    fileOf.set(id, name);
    if (at.length !== 1) { add(name, at[1] ?? 1, `${at.length} lines start "**Depends on**: ", expected exactly one`, 'depends'); continue; }
    const value = linesOf(text)[at[0] - 1].slice('**Depends on**: '.length).trim();
    const tokens = [...new Set([...value.matchAll(/\bB\d{2,}\b/g)].map(m => m[0]))];
    if (!tokens.length && value !== 'none') { add(name, at[0], 'Depends on: expected batch ids (Bnn) or exactly "none"', 'depends'); continue; }
    deps.set(id, []);
    for (const dep of tokens) {
      if (dep === id) add(name, at[0], `Depends on: ${id} depends on itself`, 'depends');
      else if (!planned.has(dep)) add(name, at[0], `Depends on: ${dep} is not a planned batch`, 'depends');
      else {
        deps.get(id).push(dep);
        if (wave.has(id) && wave.has(dep) && wave.get(dep) >= wave.get(id)) add(name, at[0], `Depends on: ${dep} is in wave ${wave.get(dep)}, not a wave before ${id}'s ${wave.get(id)}`, 'depends');
      }
    }
  }
  for (const loop of cycles(deps)) add(fileOf.get(loop[0]), labelled(read.batches.get(fileOf.get(loop[0])), '**Depends on**: ')[0], `dependency cycle ${[...loop, loop[0]].join(' -> ')}`, 'cycle');
  // New files: an optional single line of exact paths, or `none`; each in the batch's own fence
  // and absent from the repository.
  for (const [id, entry] of planned) {
    if (entry.own.length !== 1) continue;
    const name = entry.own[0], text = read.batches.get(name), at = labelled(text, '**New files**: ');
    if (!at.length) continue;
    if (at.length !== 1) { add(name, at[1], `${at.length} lines start "**New files**: ", expected at most one`, 'new-files'); continue; }
    const value = linesOf(text)[at[0] - 1].slice('**New files**: '.length);
    if (value.trim() === 'none') continue;
    let paths;
    try { paths = exactPaths(value); } catch (e) { add(name, at[0], `New files: ${e.message}`, 'new-files'); continue; }
    for (const p of paths) {
      if (!entry.fence || !entry.fence.includes(p)) add(name, at[0], `New files: ${p} is not in the batch's fence`, 'new-files');
      if (pathKind(repo, p) !== 'none') add(name, at[0], `New files: ${p} already exists`, 'new-files');
      marks.set(p, [...(marks.get(p) ?? []), id]);
    }
  }
  // Fence paths: each an existing file, or marked new by exactly one batch that every other batch
  // fencing it follows in a later wave.
  for (const [p, by] of marks) if (by.length > 1) add(PLAN, planned.get(by[1]).row.line, `${p} is marked new by ${by.join(' and ')}, expected at most one batch`, 'fence-path');
  for (const [id, entry] of planned) {
    for (const p of entry.fence ?? []) {
      const kind = pathKind(repo, p), by = marks.get(p) ?? [];
      if (kind === 'directory') add(PLAN, entry.row.line, `${id} Files (fence): ${p} is a directory, never a fence path`, 'fence-path');
      else if (!by.length && kind === 'none') add(PLAN, entry.row.line, `${id} Files (fence): ${p} does not exist and no batch marks it new`, 'fence-path');
      else if (by.length === 1 && by[0] !== id && !(wave.has(id) && wave.has(by[0]) && wave.get(id) > wave.get(by[0]))) {
        add(PLAN, entry.row.line, `${id} Files (fence): ${p} is marked new by ${by[0]}, so ${id} must sit in a later wave`, 'fence-path');
      }
    }
  }
  return { status: problems.length ? 'FAIL' : 'OK', batches: planned.size, waves: new Set(wave.values()).size, problems };
}

// A span shaped `path:line` or `path:line-line`, the path everything before the last colon. Only
// a valid repository path can be pinned; a drive or backslash path is listed as unpinned.
const CITED = /^([^\s`]+):(\d+)(?:-(\d+))?$/;
// A span's text as CommonMark reads it: one space stripped from each side when both carry one.
const spanText = t => /^ .*\S.* $/.test(t) ? t.slice(1, -1) : t;
const repoFile = (repo, rel) => path.join(repo, ...rel.split('/'));
function repoRoot(repo) {
  let root = null;
  try { root = fs.statSync(repo); } catch { root = null; }
  if (!root || !root.isDirectory()) throw new Unknown(`cannot read repository ${repo}`);
}
// The planning documents of a ledger: the plan and every batch file directly in the directory.
function planningDocs(dir) {
  let names;
  try { if (!fs.statSync(dir).isDirectory()) throw new Error(); names = fs.readdirSync(dir); } catch { throw new Unknown(`cannot read ledger directory ${dir}`); }
  return [PLAN, ...names.filter(n => BATCH_FILE.test(n)).sort()].map(name => [name, readText(path.join(dir, name), true)]);
}

// Every pinned citation of a ledger's planning documents (a `path:line` span, one space, then a
// symbol span), each checked against the files under the repository root; every other span shaped
// `path:line` is listed as unpinned. Fenced code blocks are skipped. Throws Unknown when a ledger
// document or the root cannot be read.
export function cites(dir, repo) {
  const docs = planningDocs(dir);
  repoRoot(repo);
  const problems = [], unpinned = [], texts = new Map();
  let pinned = 0;
  const lookup = rel => {
    if (!texts.has(rel)) {
      let lines = null;
      try { if (fs.lstatSync(repoFile(repo, rel)).isFile()) lines = linesOf(decode(fs.readFileSync(repoFile(repo, rel)))); } catch { lines = null; }
      if (lines && lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
      texts.set(rel, lines);
    }
    return texts.get(rel);
  };
  for (const [name, text] of docs) {
    outsideFences(text).forEach((line, i) => {
      const spans = spansOf(line);
      for (let k = 0; k < spans.length; k++) {
        const span = spans[k], m = CITED.exec(spanText(span.text)), next = spans[k + 1];
        if (!m) continue;
        const shown = line.slice(span.start, span.end);
        if (!validPath(m[1]) || !next || next.start !== span.end + 1 || line[span.end] !== ' ') { unpinned.push({ file: name, line: i + 1, span: shown }); continue; }
        k++; pinned++;
        const symbol = spanText(next.text), citation = `${shown} ${line.slice(next.start, next.end)}`;
        const fail = reason => problems.push({ file: name, line: i + 1, message: `${citation} ${reason}` });
        const from = Number(m[2]), to = m[3] === undefined ? from : Number(m[3]), lines = lookup(m[1]);
        if (lines === null) fail('names no file under the repository');
        else if (from < 1 || to < from) fail('is not a line range');
        else if (to > lines.length) fail(`is past the end of the file (${lines.length} lines)`);
        else if (!lines.slice(from - 1, to).join('\n').includes(symbol)) fail('does not hold the symbol');
      }
    });
  }
  return { status: problems.length ? 'FAIL' : 'OK', pinned, unpinned, problems };
}

// Reference kinds, strongest first.
export const KINDS = ['path', 'import', 'basename'];
// A quoted relative specifier, and the files Node would try for it.
const SPECIFIER = /(['"`])(\.\.?\/[^'"`\s]*)\1/g;
const RESOLVED = ['', '.js', '.mjs', '.cjs', '.json', '/index.js', '/index.mjs', '/index.cjs'];
// Whether a name occurs in a text as a whole name: no name character before it (a slash before it
// only when `slashed`) and none after it, a full stop ending a sentence aside.
function occurs(text, name, slashed) {
  const before = slashed ? /[\w.\-/]/ : /[\w.\-]/;
  for (let at = text.indexOf(name); at !== -1; at = text.indexOf(name, at + 1)) {
    const end = at + name.length, prev = text[at - 1] ?? '', next = text[end] ?? '';
    if (before.test(prev) || /[\w\-/]/.test(next) || (next === '.' && /\w/.test(text[end + 1] ?? ''))) continue;
    return true;
  }
  return false;
}
// The strongest kind by which one file's text references a fenced path, or null.
function referenceKind(file, text, fenced) {
  if (occurs(text, fenced, true)) return 'path';
  for (const m of text.matchAll(SPECIFIER)) {
    const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), m[2]));
    if (RESOLVED.some(ext => target + ext === fenced)) return 'import';
  }
  return occurs(text, path.posix.basename(fenced), false) ? 'basename' : null;
}

// Every tracked file of the repository, outside every fence of the ledger's plan and outside
// `.agents/`, that references a fenced path of every batch (or of one): by repository-relative
// path, by a relative specifier resolving to it from the file's directory, or by basename. Sorted
// strongest kind first. Throws Unknown when the plan, its fences or the repository cannot be read.
export function census(dir, repo, batch) {
  const plan = readText(path.join(dir, PLAN), true);
  repoRoot(repo);
  let rows;
  try { rows = table(plan, PLAN_KEYS); } catch (e) { throw new Unknown(`${PLAN} batch table: ${e.message}`); }
  const fences = rows.map(row => {
    try { return { id: row['#'], paths: exactPaths(row['Files (fence)']) }; } catch (e) { throw new Unknown(`${PLAN} ${row['#']} Files (fence): ${e.message}`); }
  });
  if (batch !== undefined && !fences.some(f => f.id === batch)) throw new Unknown(`${batch} is not a planned batch`);
  const prefix = git(repo, ['rev-parse', '--show-prefix']), listing = git(repo, ['ls-files', '-z']);
  if (!prefix.ok || !listing.ok) throw new Unknown(`cannot list the tracked files of ${repo}`);
  if (prefix.text.trim() !== '') throw new Unknown(`not the root of its repository: ${repo}`);
  const fenced = new Set(fences.flatMap(f => f.paths));
  const files = [...new Set(listing.text.split('\0').filter(Boolean))].filter(f => !fenced.has(f) && !f.startsWith('.agents/')).sort();
  const texts = files.flatMap(file => {
    try { return fs.lstatSync(repoFile(repo, file)).isFile() ? [[file, fs.readFileSync(repoFile(repo, file)).toString('utf8')]] : []; } catch { return []; }
  });
  const references = [];
  for (const { id, paths } of fences) {
    if (batch !== undefined && id !== batch) continue;
    for (const p of paths) for (const [file, text] of texts) {
      const kind = referenceKind(file, text, p);
      if (kind) references.push({ batch: id, path: p, file, kind });
    }
  }
  references.sort((a, b) => KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind));
  return { references, files: files.length };
}

function verdictLine(word, result, ok) {
  if (result.status === 'OK') return { code: 0, line: `${word} OK ${ok}` };
  const shown = result.problems.slice(0, MAX_PROBLEMS).map(p => `${p.file}:${p.line} ${p.message}`);
  const more = result.problems.length - shown.length;
  return { code: 1, line: `${word} FAIL ${result.problems.length} problem(s): ${shown.join('; ')}${more ? ` (+${more} more)` : ''}` };
}
// The list after a count: at most MAX_PROBLEMS entries, then the number left out.
const listed = entries => entries.slice(0, MAX_PROBLEMS).join('; ') + (entries.length > MAX_PROBLEMS ? ` (+${entries.length - MAX_PROBLEMS} more)` : '');
function citesLine(r) {
  if (r.status === 'FAIL') return verdictLine('CITES', r, '');
  const list = r.unpinned.length ? ': ' + listed(r.unpinned.map(u => `${u.file}:${u.line} ${u.span}`)) : '';
  return { code: 0, line: `CITES OK ${r.pinned} pinned, ${r.unpinned.length} unpinned${list}` };
}
function censusLine(r) {
  if (!r.references.length) return { code: 0, line: 'CENSUS 0 references outside every fence' };
  return { code: 0, line: `CENSUS ${r.references.length} reference(s) outside every fence: ${listed(r.references.map(x => `${x.batch} ${x.path} ← ${x.file} (${x.kind})`))}` };
}
const OPERATIONS = { parse: [['dir'], ['dir']], skill: [['dir', 'contract'], []], selfcheck: [['dir'], ['dir']], plan: [['dir', 'repo'], ['dir', 'repo']],
  cites: [['dir', 'repo'], ['dir', 'repo']], census: [['dir', 'repo', 'batch'], ['dir', 'repo']] };
function runOperation(operation, options) {
  if (operation === 'skill') return skill(options);
  if (operation === 'parse') { const r = parseLedger(options.dir); return verdictLine('PARSE', r, `${r.batches} batches`); }
  if (operation === 'selfcheck') { const r = selfcheck(options.dir); return verdictLine('SELFCHECK', r, `${r.batches} batches`); }
  if (operation === 'cites') return citesLine(cites(options.dir, options.repo));
  if (operation === 'census') return censusLine(census(options.dir, options.repo, options.batch));
  const r = planCheck(options.dir, options.repo);
  return verdictLine('PLAN', r, `${r.batches} batches in ${r.waves} waves`);
}

export function ledgerCli(args) {
  if (args.length === 1 && args[0] === '--help') return { code: 0, line: HELP };
  const [operation, ...rest] = args;
  let options;
  try {
    if (!Object.hasOwn(OPERATIONS, operation ?? '')) throw new Error();
    options = parseFlags(rest, ...OPERATIONS[operation]);
    if (operation === 'skill' && options.dir === undefined && options.contract === undefined) throw new Error();
  } catch { return { code: 2, line: 'UNKNOWN usage: unknown operation, or an unknown, missing or duplicate flag; use --help' }; }
  try { return runOperation(operation, options); }
  catch (e) { return { code: 2, line: e instanceof Unknown ? `UNKNOWN ${e.message}` : `UNKNOWN internal error: ${e.message}` }; }
}

// One line whatever a path or message holds: C0, DEL, C1 and the line and paragraph
// separators become '?'. Tested by code point, so no escape in this source can be decoded.
const hidden = n => n < 32 || (n >= 127 && n <= 159) || n === 0x2028 || n === 0x2029;
export const oneLine = text => [...text].map(c => hidden(c.codePointAt(0)) ? '?' : c).join('');

if (isMain(import.meta.url)) {
  const output = ledgerCli(process.argv.slice(2)); process.stdout.write(oneLine(output.line) + '\n'); process.exitCode = output.code;
}
