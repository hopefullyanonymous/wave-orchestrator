const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { spawnSync, execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { makeRepo, LEDGER } = require('./support/git-fixture.cjs');
const ROOT = path.resolve(__dirname, '..');
const TOOLS = path.join(ROOT, 'orchestrate', 'tools');
const TOOL = path.join(TOOLS, 'check-ledger.mjs'), FENCE = path.join(TOOLS, 'check-fence.mjs');
const parserApi = import('../orchestrate/tools/ledger-parse.mjs');
const ledgerApi = import('../orchestrate/tools/check-ledger.mjs');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');

// Every invocation must print exactly one line, whatever the verdict.
function run(args) {
  const r = spawnSync(process.execPath, [TOOL, ...args], { cwd: ROOT, encoding: 'utf8', windowsHide: true, timeout: 60000 });
  assert.ifError(r.error); assert.equal(r.signal, null);
  assert.match(r.stdout, /^[^\r\n]*\n$/, 'exactly one line on stdout: ' + JSON.stringify(r.stdout));
  return { status: r.status, line: r.stdout.slice(0, -1) };
}
function tmp(t) {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'check-ledger-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }));
  return dir;
}
function writeTree(dir, files) {
  fs.rmSync(dir, { recursive: true, force: true });
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(dir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, content);
  }
  return dir;
}

// ===== A ledger built from the shipped templates, never hand-written ======
// The authority rows are the templates' own example rows with real values substituted, so a
// template whose rows the parser cannot read reddens here, as it does for a scaffolder.
const PLAN = '01-plan.md', PROG = 'PROGRESS.md', B1 = '02-batches-01-one.md', B2 = '02-batches-02-two.md', CONTRACT = '00-READBEFORE.md';
const BATCHES = [
  { id: 'B01', title: 'One', branch: 'feat/one', files: ['a.txt', 'b.txt'], wave: '1', deps: 'none' },
  { id: 'B02', title: 'Two', branch: 'fix/two', files: ['c.txt'], wave: '1', deps: 'none' },
];
// The contract's two reserved branches, which no fixture batch branch names. The fence below is
// invoked with this integration branch, as a real gate is invoked with the contract's.
const INTEGRATION_BRANCH = 'integration', MAIN_BRANCH = 'refs/heads/main';
const cellsOf = line => line.split('|').slice(1, -1).map(x => x.trim());
function authority(template, keys, values) {
  const lines = read(template).split('\n');
  const head = lines.findIndex(l => l.startsWith('|') && keys.every(k => cellsOf(l).includes(k)));
  assert.notEqual(head, -1, template + ': no batch table carrying ' + keys.join(', '));
  const example = lines.slice(head + 2).find(l => /^\| B\d{2,} \|.*\|$/.test(l));
  assert.ok(example, template + ': no example row to copy');
  const header = cellsOf(lines[head]), cells = cellsOf(example);
  // The template's own id is the first batch's: rename it there and this goes red.
  assert.equal(cells[header.indexOf('#')], BATCHES[0].id, template + ': the example row must pin B01');
  const rows = values.map(v => '| ' + header.map((key, i) => v[key] ?? cells[i]).join(' | ') + ' |');
  return [...lines.slice(0, head + 2), ...rows, ...lines.slice(head + 2)].join('\n');
}
function batchFile(b) {
  const values = { BATCH_NUM: b.id.slice(1), BATCH_BRANCH: b.branch, BATCH_FILES: b.files.map(f => '`' + f + '`').join(', '),
    BATCH_TITLE: b.title, BATCH_TYPE: 'feature', BATCH_VERSION: '—', BATCH_WAVE: b.wave, BATCH_DEPS: b.deps, BATCH_NEW_FILES: b.newFiles ?? 'none' };
  const text = read('orchestrate/templates/02-batch.md').replace(/\{\{([A-Z_]+)\}\}/g, (_, k) => values[k] || 'example')
    .replace(/<!-- - \[ \] one box[\s\S]*?-->/, '- [ ] Implement example.').replace(/<!--[\s\S]*?-->/g, '');
  // The New files line is the template's own, filled like every other header line: plan reads
  // the line a scaffolder writes, never one this fixture adds.
  assert.equal(text.split('\n').filter(l => l.startsWith('**New files**: ')).length, 1, 'the batch template carries one **New files** line');
  return text;
}
// The contract filled from the real template, so the Git model labels parse reads are the
// template's own; `values` overrides any placeholder.
function contractFile(values = {}) {
  const v = { MAIN_BRANCH, INTEGRATION_BRANCH, ...values };
  return read('orchestrate/templates/00-READBEFORE.md').replace(/\{\{([A-Z0-9_]+)\}\}/g, (_, k) => v[k] ?? 'example');
}
const batchName = b => '02-batches-' + b.id.slice(1) + '-' + b.title.toLowerCase() + '.md';
function baseLedger(batches = BATCHES) {
  return {
    [PLAN]: authority('orchestrate/templates/01-plan.md', ['#', 'Branch', 'Files (fence)'],
      batches.map(b => ({ '#': b.id, Batch: b.title, Branch: '`' + b.branch + '`', Wave: b.wave, 'Files (fence)': b.files.map(f => '`' + f + '`').join(', ') }))),
    [PROG]: authority('orchestrate/templates/PROGRESS.md', ['#', 'Branch', 'Notes'],
      batches.map(b => ({ '#': b.id, Batch: b.title, Branch: '`' + b.branch + '`', Wave: b.progressWave ?? b.wave, Notes: '—' }))),
    ...Object.fromEntries(batches.map(b => [batchName(b), batchFile(b)])),
    [CONTRACT]: contractFile(),
  };
}
// Every edit asserts its anchor, so a variant whose replacement silently missed cannot
// pass as a verdict about a ledger it never produced.
function swap(text, from, to) {
  const hits = typeof from === 'string' ? text.split(from).length - 1 : (text.match(new RegExp(from.source, 'gm')) || []).length;
  assert.equal(hits, 1, 'mutation anchor must occur exactly once: ' + from);
  const out = text.replace(from, to);
  assert.notEqual(out, text, 'mutation must change the text: ' + from);
  return out;
}
const edit = (files, name, from, to) => ({ ...files, [name]: swap(files[name], from, to) });
const without = (files, name) => { assert.ok(files[name]); const copy = { ...files }; delete copy[name]; return copy; };
const rename = (files, from, to) => ({ ...without(files, from), [to]: files[from] });
const appendBytes = (files, name) => ({ ...files, [name]: Buffer.concat([Buffer.from(files[name]), Buffer.from([0xff, 0xfe])]) });
const lineOf = (text, re, nth = 0) => text.split('\n').flatMap((l, i) => re.test(l) ? [i + 1] : [])[nth];
const NOTES = { B01: /^(\| B01 \| One \|.*\| )— \|$/m, B02: /^(\| B02 \| Two \|.*\| )— \|$/m };
const notes = (files, value, id = 'B01') => edit(files, PROG, NOTES[id], '$1' + value + ' |');
const EXTENSION = 'fence +x.txt (item, reason, 2026-09-23)';
const authorizeInLog = (files, record, ids = ['B01']) => edit(ids.reduce((f, id) => notes(f, record, id), files), PROG,
  /^(\| Date \| Session did \| Stopped because \|\n\|[-|]+\|)$/m, '$1\n| 2026-09-23 | ' + record + ' | — |');
const setBranch = (files, branch) => edit(edit(edit(files, PLAN, '`feat/one`', '`' + branch + '`'), PROG, '`feat/one`', '`' + branch + '`'),
  B1, '**Branch**: `feat/one`', '**Branch**: `' + branch + '`');

// Fence rejection sites as `<code>: <message>`, then ` @<document>` where one site is raised for
// more than one ledger document, and ` #<clause>` for one clause of a condition joining several.
// Written by hand here; the domain they are checked against is DERIVED from the fence's and the
// parser's source below, so the two cannot drift apart silently.
const A = m => 'authority: ' + m, BL = m => 'batch-linkage: ' + m;
const PL = m => A(m) + ' @plan', PR = m => A(m) + ' @progress', BD = m => BL(m) + ' @batch';
const IDS = 'Duplicate or malformed batch IDs', REQUESTED = 'Missing or duplicate requested batch', CELL = 'Malformed branch cell';
const HEADER = 'Malformed table header', TABLE_ROW = 'Malformed table row', AMBIGUOUS = 'Missing or ambiguous authority table';
const NAME = BL('Batch ID and ledger batch filename do not agree');
// Raised by git-evidence.mjs when a blob the fence reads is not UTF-8, keyed by the document read.
const ENC = 'invalid-encoding: Git output is not valid UTF-8';
const BRANCH = A('Plan/PROGRESS branch linkage does not agree'), REDUNDANT = A('Redundant or ambiguous extension');
const MISSING = A('Missing authoritative ledger text'), TITLE = BL('Batch title does not match ID');
const FILES_BRANCH = BL('Baseline batch Files/Branch must match authoritative plan'), STRUCTURE = 'batch-structure: Unsupported original Checklist section';
const AUTH_FILE = 'authority-file: Authority must be an ordinary committed file', BASELINE = 'batch-baseline: Baseline batch must be an ordinary file';
const USAGE = 'usage: Explicit repository, distinct full refs, ledger ID, batch ID and exact batch file are required';
const PATHS = 'Expected unique exact repository-relative backtick paths (globs unsupported)';
const row = (f, file, id = 'B01') => lineOf(f[file], new RegExp('^\\| ' + id + ' \\|'));

// Each case: the ledger edit, what `parse` must say (the problems it names by file, line and
// message, or an UNKNOWN), and the fence rejection sites the REAL fence reports when the same
// ledger is committed and B01 gated: no sites means the fence PASSes. `ledger` names the ledger
// directory and `gate` overrides what the fence is invoked with, each derived from the ledger.
const CASES = [
  { name: 'ledger from the real templates', edit: f => f, expect: () => [], sites: [] },
  { name: 'authorized fence extension', edit: f => authorizeInLog(f, EXTENSION), expect: () => [], sites: [] },
  { name: 'title with a hyphen for the dash', sites: [], edit: f => edit(f, B1, '# B01 — ', '# B01 - '), expect: () => [] },
  // Stricter than the fence, which reads only the batch it gates.
  { name: 'orphan batch file', sites: [], edit: f => ({ ...f, '02-batches-03-three.md': swap(f[B2], '# B02 — ', '# B03 — ') }),
    expect: () => [['02-batches-03-three.md', 1, /^no plan row claims this batch file$/]] },
  { name: 'two batch files for one id', sites: [], edit: f => ({ ...f, '02-batches-01-copy.md': f[B1] }),
    expect: f => [[PLAN, row(f, PLAN), /^B01: 2 batch files 02-batches-01-\*\.md, expected exactly one$/]] },
  // Ledger authority: the plan and PROGRESS tables, cells and extension records.
  { name: 'glob in the plan fence', sites: [PL(PATHS)], edit: f => edit(f, PLAN, '`a.txt`, `b.txt` |', '`*.txt` |'),
    expect: f => [[PLAN, row(f, PLAN), /^B01 Files \(fence\): Expected unique exact repository-relative backtick paths \(globs unsupported\)$/]] },
  { name: 'empty plan fence cell', sites: [PL('Empty file fence')], edit: f => edit(f, PLAN, '`a.txt`, `b.txt` |', '|'),
    expect: f => [[PLAN, row(f, PLAN), /^B01 Files \(fence\): Empty file fence$/]] },
  { name: 'malformed plan table header', sites: [PL(HEADER)], edit: f => edit(f, PLAN, '|---|-------|', '|---|--x----|'),
    expect: () => [[PLAN, 1, /^batch table \(#, Branch, Files \(fence\)\): Malformed table header$/]] },
  { name: 'malformed PROGRESS table header', sites: [PR(HEADER)], edit: f => edit(f, PROG, '|---|-------|', '|---|--x----|'),
    expect: () => [[PROG, 1, /^batch table \(#, Branch, Notes\): Malformed table header$/]] },
  { name: 'plan row missing a cell', sites: [PL(TABLE_ROW)], edit: f => edit(f, PLAN, /^(\| B02 \|.*) — \|$/m, '$1'),
    expect: () => [[PLAN, 1, /^batch table \(#, Branch, Files \(fence\)\): Malformed table row$/]] },
  { name: 'PROGRESS row missing a cell', sites: [PR(TABLE_ROW)], edit: f => edit(f, PROG, /^(\| B02 \|.*) — \|$/m, '$1'),
    expect: () => [[PROG, 1, /^batch table \(#, Branch, Notes\): Malformed table row$/]] },
  { name: 'two plan batch tables', sites: [PL(AMBIGUOUS)],
    edit: f => edit(f, PLAN, '## Wave map & checkpoints', '| # | Branch | Files (fence) |\n|---|---|---|\n| B01 | `feat/one` | `a.txt`, `b.txt` |\n\n## Wave map & checkpoints'),
    expect: () => [[PLAN, 1, /^batch table \(#, Branch, Files \(fence\)\): Missing or ambiguous authority table$/]] },
  { name: 'two PROGRESS batch tables', sites: [PR(AMBIGUOUS)],
    edit: f => edit(f, PROG, '## Checkpoints', '| # | Branch | Notes |\n|---|---|---|\n| B01 | `feat/one` | — |\n\n## Checkpoints'),
    expect: () => [[PROG, 1, /^batch table \(#, Branch, Notes\): Missing or ambiguous authority table$/]] },
  { name: 'malformed Bnn', sites: [PL(IDS)], edit: f => edit(f, PLAN, /^\| B02 \|/m, '| B2 |'),
    expect: f => [[PLAN, row(f, PLAN, 'B2'), /^B2: Duplicate or malformed batch IDs$/], [PROG, row(f, PROG, 'B02'), /^B02: no plan row$/], [B2, 1, /^no plan row claims this batch file$/]] },
  { name: 'duplicate PROGRESS row', sites: [PR(IDS)], edit: f => edit(f, PROG, /^(\| B02 \|.*)$/m, '$1\n$1'),
    expect: f => [[PROG, lineOf(f[PROG], /^\| B02 \|/), /^B02: Duplicate or malformed batch IDs$/], [PROG, lineOf(f[PROG], /^\| B02 \|/, 1), /^B02: Duplicate or malformed batch IDs$/]] },
  { name: 'plan lacks the gated id', sites: [PL(REQUESTED)], edit: f => edit(f, PLAN, /^\| B01 \| One \|/m, '| B03 | One |'),
    expect: f => [[PROG, row(f, PROG), /^B01: no plan row$/], [PLAN, row(f, PLAN, 'B03'), /^B03: no PROGRESS row$/],
      [PLAN, row(f, PLAN, 'B03'), /^B03: 0 batch files 02-batches-03-\*\.md, expected exactly one$/], [B1, 1, /^no plan row claims this batch file$/]] },
  { name: 'plan and PROGRESS ids differ', sites: [PR(REQUESTED)], edit: f => edit(f, PROG, /^\| B01 \| One \|/m, '| B03 | One |'),
    expect: f => [[PROG, row(f, PROG, 'B03'), /^B03: no plan row$/], [PLAN, row(f, PLAN), /^B01: no PROGRESS row$/]] },
  { name: 'malformed plan branch cell', sites: [PL(CELL)], edit: f => edit(f, PLAN, '`feat/one`', '`feat/one`x'),
    expect: f => [[PLAN, row(f, PLAN), /^B01 Branch: Malformed branch cell$/]] },
  { name: 'malformed PROGRESS branch cell', sites: [PR(CELL)], edit: f => edit(f, PROG, '`feat/one`', '`feat/one`x'),
    expect: f => [[PROG, row(f, PROG), /^B01 Branch: Malformed branch cell$/]] },
  { name: 'plan branch disagrees with PROGRESS and the batch file', sites: [BRANCH + ' #plan-branch'], edit: f => edit(f, PLAN, '`feat/one`', '`feat/other`'),
    expect: f => [[PROG, row(f, PROG), /^B01: Branch feat\/one differs from the plan's feat\/other$/], [B1, lineOf(f[B1], /^\*\*Branch\*\*: /), /^Branch line must read exactly \*\*Branch\*\*: `feat\/other`$/]] },
  { name: 'PROGRESS branch disagrees with the plan', sites: [BRANCH + ' #progress-branch'], edit: f => edit(f, PROG, '`feat/one`', '`feat/other`'),
    expect: f => [[PROG, row(f, PROG), /^B01: Branch feat\/other differs from the plan's feat\/one$/]] },
  { name: 'malformed fence extension', sites: [PR('Malformed fence extension')], edit: f => notes(f, 'fence +x.txt (item, reason)'),
    expect: f => [[PROG, row(f, PROG), /^B01 Notes: Malformed fence extension$/]] },
  { name: 'unsupported fence extension grammar', sites: [PR('Unsupported fence extension grammar')], edit: f => notes(f, 'fence +x.txt'),
    expect: f => [[PROG, row(f, PROG), /^B01 Notes: Unsupported fence extension grammar$/]] },
  { name: 'extension recorded for another id', sites: [PR('Mismatched or ambiguous extension in Notes')], edit: f => notes(f, 'fence +x.txt (B02, item, reason, 2026-09-23)'),
    expect: f => [[PROG, row(f, PROG), /^B01 Notes: Mismatched or ambiguous extension in Notes$/]] },
  { name: 'extension with two session logs', sites: [PR('Extension needs an unambiguous session log')],
    edit: f => edit(authorizeInLog(f, EXTENSION), PROG, '## Session log', '## Session log\n\n## Session log'),
    expect: f => [[PROG, row(f, PROG), /^B01 Notes: Extension needs an unambiguous session log$/]] },
  { name: 'extension with no session-log authorization', sites: [PR('Extension needs exactly one matching session-log authorization')], edit: f => notes(f, EXTENSION),
    expect: f => [[PROG, row(f, PROG), /^B01 Notes: Extension needs exactly one matching session-log authorization$/]] },
  { name: 'extension owned by two rows', sites: [PR('Extension cannot be bound to one batch row')], edit: f => authorizeInLog(f, EXTENSION, ['B01', 'B02']),
    expect: f => [[PROG, row(f, PROG), /^B01 Notes: Extension cannot be bound to one batch row$/], [PROG, row(f, PROG, 'B02'), /^B02 Notes: Extension cannot be bound to one batch row$/]] },
  { name: 'authorized extension repeating a fence path', sites: [REDUNDANT + ' #in-fence'], edit: f => authorizeInLog(f, EXTENSION.replace('x.txt', 'a.txt')),
    expect: f => [[PROG, row(f, PROG), /^B01 Notes: extension repeats a fence path$/]] },
  { name: 'authorized extension naming the batch file itself', sites: [REDUNDANT + ' #own-batch-file'], edit: f => authorizeInLog(f, EXTENSION.replace('x.txt', `${LEDGER}/${B1}`)),
    expect: f => [[PROG, row(f, PROG), /^B01 Notes: extension names the batch's own file$/]] },
  // Authority files the fence will not read: missing, undecodable, or a link.
  { name: 'missing plan', sites: [MISSING + ' #plan', AUTH_FILE + ' @plan'], edit: f => without(f, PLAN), unknown: /^UNKNOWN cannot read .*01-plan\.md$/ },
  { name: 'missing PROGRESS', sites: [MISSING + ' #progress', AUTH_FILE + ' @progress'], edit: f => without(f, PROG), unknown: /^UNKNOWN cannot read .*PROGRESS\.md$/ },
  { name: 'plan not UTF-8', sites: [MISSING + ' #plan', ENC + ' @plan'], edit: f => appendBytes(f, PLAN), unknown: /^UNKNOWN not UTF-8: .*01-plan\.md$/ },
  { name: 'PROGRESS not UTF-8', sites: [MISSING + ' #progress', ENC + ' @progress'], edit: f => appendBytes(f, PROG), unknown: /^UNKNOWN not UTF-8: .*PROGRESS\.md$/ },
  { name: 'batch file not UTF-8', sites: [ENC + ' @batch'], edit: f => appendBytes(f, B1), unknown: /^UNKNOWN not UTF-8: .*02-batches-01-one\.md$/ },
  { name: 'linked plan', sites: [AUTH_FILE + ' @plan'], link: PLAN, edit: f => f, unknown: /^UNKNOWN a link, not an ordinary file: .*01-plan\.md$/ },
  { name: 'linked PROGRESS', sites: [AUTH_FILE + ' @progress'], link: PROG, edit: f => f, unknown: /^UNKNOWN a link, not an ordinary file: .*PROGRESS\.md$/ },
  // What the fence is invoked with, each derived from the ledger: a ledger it refuses to gate.
  { name: 'impossible branch name', sites: [USAGE + ' #batch-ref'], gate: { batch: 'refs/heads/feat/one x' }, edit: f => setBranch(f, 'feat/one x'),
    expect: f => [[PLAN, row(f, PLAN), /^B01 Branch: feat\/one x is not a valid branch name$/]] },
  { name: 'branch name with a double dot', sites: [USAGE + ' #batch-ref'], gate: { batch: 'refs/heads/feat/one..x' }, edit: f => setBranch(f, 'feat/one..x'),
    expect: f => [[PLAN, row(f, PLAN), /^B01 Branch: feat\/one\.\.x is not a valid branch name$/]] },
  // The contract's integration branch as the batch branch: the fence is invoked with both refs equal.
  { name: 'batch branch naming the integration branch', sites: [USAGE + ' #distinct-refs'], gate: { batch: 'refs/heads/' + INTEGRATION_BRANCH },
    edit: f => setBranch(f, INTEGRATION_BRANCH),
    expect: f => [[PLAN, row(f, PLAN), /^B01 Branch: integration is the integration branch$/], [PROG, row(f, PROG), /^B01 Branch: integration is the integration branch$/]] },
  // An unfilled Git model value, which the slot scan skips inside its code span: parse refuses it.
  { name: 'unfilled integration branch in the contract', sites: [],
    edit: f => ({ ...f, [CONTRACT]: swap(f[CONTRACT], 'Integration branch: `integration`', 'Integration branch: `{{INTEGRATION_BRANCH}}`') }),
    expect: f => [[CONTRACT, lineOf(f[CONTRACT], /^## Git model\b/), /^Git model integration branch: \{\{INTEGRATION_BRANCH\}\} is an unfilled slot$/]] },
  { name: 'unfilled default branch in the contract', sites: [],
    edit: f => ({ ...f, [CONTRACT]: swap(f[CONTRACT], 'Default branch (protected local ref): `refs/heads/main`', 'Default branch (protected local ref): `{{MAIN_BRANCH}}`') }),
    expect: f => [[CONTRACT, lineOf(f[CONTRACT], /^## Git model\b/), /^Git model default branch: \{\{MAIN_BRANCH\}\} is an unfilled slot$/]] },
  { name: 'ledger id the fence refuses', sites: [USAGE + ' #ledger-id'], ledger: 'OS-20260923-café', edit: f => f,
    expect: () => [[PLAN, 1, /^ledger directory OS-20260923-café is not a valid ledger id$/]] },
  { name: 'batch id the fence refuses', sites: [USAGE + ' #batch-id'], gate: { 'batch-id': 'B1' },
    edit: f => edit(edit(f, PLAN, /^\| B01 \| One \|/m, '| B1 | One |'), PROG, /^\| B01 \| One \|/m, '| B1 | One |'),
    expect: f => [[PLAN, row(f, PLAN, 'B1'), /^B1: Duplicate or malformed batch IDs$/], [PROG, row(f, PROG, 'B1'), /^B1: Duplicate or malformed batch IDs$/], [B1, 1, /^no plan row claims this batch file$/]] },
  { name: 'batch file path the fence refuses', sites: [USAGE + ' #batch-file'], gate: { 'batch-file': `${LEDGER}/02-batches-01-one[1].md` },
    edit: f => rename(f, B1, '02-batches-01-one[1].md'),
    expect: () => [['02-batches-01-one[1].md', 1, /^batch file path \.agents\/changes\/FIXTURE\/02-batches-01-one\[1\]\.md is not a valid repository path$/]] },
  { name: 'batch file numbered unlike its id', sites: [NAME + ' #prefix'], gate: { 'batch-file': `${LEDGER}/02-batches-1-one.md` },
    edit: f => rename(f, B1, '02-batches-1-one.md'),
    expect: f => [[PLAN, row(f, PLAN), /^B01: 0 batch files 02-batches-01-\*\.md, expected exactly one$/], ['02-batches-1-one.md', 1, /^no plan row claims this batch file$/]] },
  { name: 'batch file not Markdown', sites: [NAME + ' #suffix'], gate: { 'batch-file': `${LEDGER}/02-batches-01-one.markdown` },
    edit: f => rename(f, B1, '02-batches-01-one.markdown'),
    expect: f => [[PLAN, row(f, PLAN), /^B01: 0 batch files 02-batches-01-\*\.md, expected exactly one$/]] },
  { name: 'batch file in a subdirectory', sites: [NAME + ' #subdir'], gate: { 'batch-file': `${LEDGER}/02-batches-01-x/one.md` },
    edit: f => rename(f, B1, '02-batches-01-x/one.md'),
    expect: f => [[PLAN, row(f, PLAN), /^B01: 0 batch files 02-batches-01-\*\.md, expected exactly one$/]] },
  // The batch file: its linkage to the plan, and its structure.
  { name: 'missing batch file', sites: [BASELINE], edit: f => without(f, B1),
    expect: f => [[PLAN, row(f, PLAN), /^B01: 0 batch files 02-batches-01-\*\.md, expected exactly one$/]] },
  { name: 'linked batch file', sites: [BASELINE], link: B1, edit: f => f, unknown: /^UNKNOWN a link, not an ordinary file: .*02-batches-01-one\.md$/ },
  { name: 'title names another id', sites: [TITLE], edit: f => edit(f, B1, '# B01 — ', '# B09 — '),
    expect: () => [[B1, 1, /^title must open "# B01 — "$/]] },
  { name: 'title with a colon for the dash', sites: [TITLE], edit: f => edit(f, B1, '# B01 — ', '# B01: '),
    expect: () => [[B1, 1, /^title must open "# B01 — "$/]] },
  { name: 'title with no dash', sites: [TITLE], edit: f => edit(f, B1, '# B01 — ', '# B01 '),
    expect: () => [[B1, 1, /^title must open "# B01 — "$/]] },
  { name: 'title with no space after the dash', sites: [TITLE], edit: f => edit(f, B1, '# B01 — ', '# B01 —'),
    expect: () => [[B1, 1, /^title must open "# B01 — "$/]] },
  { name: 'missing Files line', sites: [FILES_BRANCH + ' #files-count'], edit: f => edit(f, B1, /^\*\*Files\*\*: .*\n/m, ''),
    expect: () => [[B1, 1, /^0 lines start "\*\*Files\*\*: ", expected exactly one$/]] },
  { name: 'duplicate Files line', sites: [FILES_BRANCH + ' #files-count'], edit: f => edit(f, B1, /^(\*\*Files\*\*: .*)$/m, '$1\n$1'),
    expect: f => [[B1, lineOf(f[B1], /^\*\*Files\*\*: /, 1), /^2 lines start "\*\*Files\*\*: ", expected exactly one$/]] },
  { name: 'missing Branch line', sites: [FILES_BRANCH + ' #branch-count'], edit: f => edit(f, B1, /^\*\*Branch\*\*: .*\n/m, ''),
    expect: () => [[B1, 1, /^0 lines start "\*\*Branch\*\*: ", expected exactly one$/]] },
  { name: 'duplicate Branch line', sites: [FILES_BRANCH + ' #branch-count'], edit: f => edit(f, B1, /^(\*\*Branch\*\*: .*)$/m, '$1\n$1'),
    expect: f => [[B1, lineOf(f[B1], /^\*\*Branch\*\*: /, 1), /^2 lines start "\*\*Branch\*\*: ", expected exactly one$/]] },
  { name: 'text after the Branch backtick', sites: [FILES_BRANCH + ' #branch-exact'], edit: f => edit(f, B1, '**Branch**: `feat/one`', '**Branch**: `feat/one` (cut from the tip)'),
    expect: f => [[B1, lineOf(f[B1], /^\*\*Branch\*\*: /), /^Branch line must read exactly \*\*Branch\*\*: `feat\/one`$/]] },
  { name: 'stale Files line', sites: [FILES_BRANCH + ' #files-equal'], edit: f => edit(f, B1, '**Files**: `a.txt`, `b.txt`', '**Files**: `a.txt`'),
    expect: f => [[B1, lineOf(f[B1], /^\*\*Files\*\*: /), /^Files line differs from the plan fence$/]] },
  { name: 'reordered Files line', sites: [FILES_BRANCH + ' #files-equal'], edit: f => edit(f, B1, '**Files**: `a.txt`, `b.txt`', '**Files**: `b.txt`, `a.txt`'),
    expect: f => [[B1, lineOf(f[B1], /^\*\*Files\*\*: /), /^Files line differs from the plan fence$/]] },
  { name: 'glob in the Files line', sites: [BD(PATHS)], edit: f => edit(f, B1, '**Files**: `a.txt`, `b.txt`', '**Files**: `*.txt`'),
    expect: f => [[B1, lineOf(f[B1], /^\*\*Files\*\*: /), /^Files line: Expected unique exact repository-relative backtick paths \(globs unsupported\)$/]] },
  { name: 'empty Files line', sites: [BD('Empty file fence')], edit: f => edit(f, B1, '**Files**: `a.txt`, `b.txt`', '**Files**: '),
    expect: f => [[B1, lineOf(f[B1], /^\*\*Files\*\*: /), /^Files line: Empty file fence$/]] },
  { name: 'missing Checklist', sites: [STRUCTURE + ' #no-checklist'], edit: f => edit(f, B1, '## Checklist', '## Tasks'),
    expect: () => [[B1, 1, /^needs exactly one "## Checklist" line followed by another "## " heading$/]] },
  { name: 'duplicate Checklist', sites: [STRUCTURE + ' #two-checklists'], edit: f => edit(f, B1, '## Checklist', '## Checklist\n\n## Checklist'),
    expect: f => [[B1, lineOf(f[B1], /^## Checklist$/, 1), /^needs exactly one "## Checklist" line followed by another "## " heading$/]] },
  { name: 'Checklist is the last heading', sites: [STRUCTURE + ' #no-later-heading'], edit: f => edit(f, B1, /\n## Acceptance criteria[\s\S]*$/, '\n'),
    expect: f => [[B1, lineOf(f[B1], /^## Checklist$/), /^needs exactly one "## Checklist" line followed by another "## " heading$/]] },
];
// The diagnostic codes by which the fence rejects a ledger shape, and every other code it raises:
// operational evidence about refs, worktrees, the diff and the batch's edits, never its linkage.
const MEASURED = ['authority', 'batch-linkage', 'authority-file', 'batch-baseline', 'batch-structure', 'usage'];
const OPERATIONAL = ['merge-base', 'candidate-worktree', 'dirty-worktree', 'outside-fence', 'batch-type', 'batch-files', 'batch-content', 'invalid-diff', 'ref-race', 'worktree-race'];
// Codes raised in git-evidence.mjs that the harness measures by the ledger document they name.
const BY_DOC = ['authority-file', 'invalid-encoding'];
// Every value pushed onto the fence's verdict arrays is a diagnostic( with a literal code, or one
// of these, each named by its exact text: a diagnostic git-evidence.mjs or validateBatchEdit built.
const PUSHED = ['{ ...r.diagnostic, path: file }', 'bases.diagnostic', 'diff.diagnostic', '...wt.diagnostics', '...after.diagnostics',
  "...batchFindings.filter(f => f.code === 'batch-structure')", "...batchFindings.filter(f => f.code !== 'batch-structure')",
  'diagnostic(code, message, { path: batchPath, ...(line ? { line } : {}) })'];
// Each fence condition joining several clauses, pinned whole, with every clause named by its
// own text: a clause moved between conditions changes both pins.
const CLAUSES = {
  [USAGE]: { when: "!repo || !validFullRef(integration) || !validFullRef(batch) || integration === batch || !validId(id) || !/^B\\d{2,}$/.test(batchId || '') || !validPath(batchFile)",
    clauses: { repo: '!repo', 'integration-ref': '!validFullRef(integration)', 'batch-ref': '!validFullRef(batch)', 'distinct-refs': 'integration === batch',
      'ledger-id': '!validId(id)', 'batch-id': "!/^B\\d{2,}$/.test(batchId || '')", 'batch-file': '!validPath(batchFile)' } },
  [NAME]: { when: "!batchFile.startsWith(`${root}/02-batches-${number}-`) || !batchFile.endsWith('.md') || batchFile.slice(root.length + 1).includes('/')",
    clauses: { prefix: '!batchFile.startsWith(`${root}/02-batches-${number}-`)', suffix: "!batchFile.endsWith('.md')", subdir: "batchFile.slice(root.length + 1).includes('/')" } },
  [MISSING]: { when: 'plan === null || progress === null', clauses: { plan: 'plan === null', progress: 'progress === null' } },
  [BRANCH]: { when: "!batch.startsWith('refs/heads/') || branchCell(planRow.Branch) !== branch || branchCell(progressRow.Branch) !== branch",
    clauses: { 'ref-not-heads': "!batch.startsWith('refs/heads/')", 'plan-branch': 'branchCell(planRow.Branch) !== branch', 'progress-branch': 'branchCell(progressRow.Branch) !== branch' } },
  [REDUNDANT]: { when: 'extension.some(p => fence.includes(p) || p === batchFile)', clauses: { 'in-fence': 'fence.includes(p)', 'own-batch-file': 'p === batchFile' } },
  [FILES_BRANCH]: { when: "fileLines.length !== 1 || branchLines.length !== 1 || branchLines[0] !== `**Branch**: \\`${batch.slice('refs/heads/'.length)}\\`` || JSON.stringify(exactPaths(fileLines[0].slice(11))) !== JSON.stringify(fence)",
    clauses: { 'files-count': 'fileLines.length !== 1', 'branch-count': 'branchLines.length !== 1',
      'branch-exact': "branchLines[0] !== `**Branch**: \\`${batch.slice('refs/heads/'.length)}\\``", 'files-equal': 'JSON.stringify(exactPaths(fileLines[0].slice(11))) !== JSON.stringify(fence)' } },
  [STRUCTURE]: { when: "start < 0 || before.filter(l => l === '## Checklist').length !== 1 || !ends.length",
    clauses: { 'no-checklist': 'start < 0', 'two-checklists': "before.filter(l => l === '## Checklist').length !== 1", 'no-later-heading': '!ends.length' } },
};
// A site raised once per authority file by the loop on its source line.
const PER_FILE = { [AUTH_FILE]: { loop: 'for (const file of [planPath, progressPath]) if (', docs: ['plan', 'progress'] } };
// Operator inputs, never ledger shapes: the fence is always invoked with the repository, the
// contract's integration branch and `refs/heads/<plan branch>`.
const OPERATOR = [USAGE + ' #repo', USAGE + ' #integration-ref', BRANCH + ' #ref-not-heads'];
const UNREACHABLE = [...OPERATOR];
// Sites a ledger shape reaches only together: the fence has no authority text exactly when its
// blob is undecodable, since a missing one is an authority-file site as well.
const TIED = [[MISSING + ' #plan', ENC + ' @plan'], [MISSING + ' #progress', ENC + ' @progress']];
// A measured code raised outside checkFence, on the fence command line's own flags.
const EXEMPT = ['usage: Unknown, missing or duplicate flag; use --help'];
// The ledger document a parser call reads, by the names in its arguments, and the one a blob
// read names by its path argument.
const DOC = { plan: 'plan', planRow: 'plan', progress: 'progress', progressRow: 'progress', baseline: 'batch', proposed: 'batch', fileLines: 'batch', branchLines: 'batch' };
const READS = { planPath: 'plan', progressPath: 'progress', batchFile: 'batch' };
const LITERAL = /^(?:'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\]|\\.)*)`)/;
const THROW_AT = /throw new Error\((?:'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\]|\\.)*)`)\)/y;
// The source with every comment and every string, template and regular-expression literal
// blanked (newlines kept), so bracket, keyword and call scans read code only, at the same offsets.
function codeMask(src) {
  const out = src.split(''), fail = at => assert.fail('unterminated literal at ' + at);
  const blank = (a, b) => { for (let k = a; k < b; k++) if (out[k] !== '\n') out[k] = ' '; };
  // The index after the string, template or regular expression opening at i.
  function literal(i) {
    const q = src[i];
    for (let j = i + 1; j < src.length; j++) {
      if (src[j] === '\\') j++;
      else if (q !== '`' && src[j] === '\n') fail(i);
      else if (q === '/' && src[j] === '[') { while (++j < src.length && src[j] !== ']') if (src[j] === '\\') j++; }
      else if (src[j] === q) { let k = j + 1; if (q === '/') while (/[a-z]/i.test(src[k] || '')) k++; return k; }
      else if (q === '`' && src.startsWith('${', j)) j = code(j + 2, true) - 1;
    }
    fail(i);
  }
  // Scans code from i; inside a template's ${…}, returns the index after its closing brace.
  function code(i, inner) {
    let depth = 0, prev = '', word = '';
    while (i < src.length) {
      const ch = src[i];
      if (src.startsWith('//', i) || src.startsWith('/*', i)) {
        const end = src[i + 1] === '/' ? (src.indexOf('\n', i) + 1 || src.length + 1) - 1 : src.indexOf('*/', i) + 2;
        blank(i, end); i = end; continue;
      }
      const regex = ch === '/' && (prev === '' || '(,=:[!&|?{};+-*%<>~^'.includes(prev) || /^(?:return|typeof|case|void|delete|in|of|throw|else)$/.test(word));
      if (ch === "'" || ch === '"' || ch === '`' || regex) { const end = literal(i); blank(i, end); i = end; prev = 'a'; word = ''; continue; }
      if (inner && ch === '{') depth++;
      if (inner && ch === '}' && depth-- === 0) return i + 1;
      if (/[\w$]/.test(ch)) { let j = i; while (/[\w$]/.test(src[j] || '')) j++; word = src.slice(i, j); prev = 'a'; i = j; continue; }
      if (!/\s/.test(ch)) { prev = ch; word = ''; }
      i++;
    }
    return i;
  }
  code(0, false);
  return out.join('');
}
// The index of the bracket closing the one at `open`, in a masked source.
function closing(mask, open, o = '(', c = ')') {
  for (let depth = 0, j = open; j < mask.length; j++) {
    if (mask[j] === o) depth++;
    else if (mask[j] === c && --depth === 0) return j;
  }
  assert.fail('unbalanced ' + o + ' at ' + open);
}
// Every declaration at the top level of a module, by a bracket-depth scan: name, start and end,
// each ending where the next begins.
function topLevel(mask) {
  const decls = [];
  for (let depth = 0, i = 0; i < mask.length; i++) {
    const ch = mask[i];
    if ('({['.includes(ch)) depth++;
    else if (')}]'.includes(ch)) depth--;
    else if (!depth && !/[\w$]/.test(mask[i - 1] || '')) {
      const m = /^(?:export\s+)?(?:async\s+)?(?:function\b\s*\*?\s*|class\s+|(?:const|let|var)\s+)([A-Za-z_$][\w$]*)/.exec(mask.slice(i, i + 200));
      if (m) { decls.push({ name: m[1], start: i }); i += m[0].length - 1; }
    }
  }
  const byName = {};
  decls.forEach((d, n) => { assert.ok(!Object.hasOwn(byName, d.name), 'one top-level declaration of ' + d.name); byName[d.name] = { start: d.start, end: n + 1 < decls.length ? decls[n + 1].start : mask.length }; });
  return byName;
}
// The throws and calls in [a, b) of a source, with every try blanked whose catch does not rethrow:
// a throw inside one is caught where it is raised. Every throw left must raise a literal Error.
function region(src, mask, a, b, where) {
  const m = mask.slice(a, b).split('');
  for (const t of mask.slice(a, b).matchAll(/\btry\s*\{/g)) {
    if (m[t.index] === ' ') continue;
    const text = m.join(''), open = t.index + t[0].length - 1, close = closing(text, open, '{', '}');
    const c = /^\s*catch\s*(?:\([^)]*\))?\s*\{/.exec(text.slice(close + 1));
    assert.ok(c, where + ': a try without a catch');
    const cOpen = close + c[0].length, cClose = closing(text, cOpen, '{', '}');
    assert.ok(!/\bthrow\b/.test(text.slice(cOpen, cClose)), where + ': a catch that rethrows');
    for (let k = t.index; k <= cClose; k++) if (m[k] !== '\n') m[k] = ' ';
  }
  const text = m.join(''), throws = [], calls = [];
  for (const t of text.matchAll(/\bthrow\b/g)) {
    THROW_AT.lastIndex = a + t.index;
    const lit = THROW_AT.exec(src);
    assert.ok(lit, where + ': every throw raises an Error with a literal message');
    throws.push({ message: lit[1] ?? lit[2] ?? lit[3], at: a + t.index });
  }
  for (const t of text.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)\s*\(/g)) calls.push({ name: t[1], open: a + t.index + t[0].length - 1 });
  return { throws, calls };
}
// The condition guarding the raise at `at`: the `if (…)` whose closing bracket is followed only by
// an opening brace or a push before the raise; null when the raise is unconditional.
function conditionOf(mask, at) {
  for (const t of [...mask.slice(0, at).matchAll(/(?<![\w$])if\s*\(/g)].reverse()) {
    const open = t.index + t[0].length - 1, close = closing(mask, open);
    if (close < at && /^\s*\{?\s*(?:(?:unknowns|violations)\s*\.\s*push\s*\(\s*)?$/.test(mask.slice(close + 1, at))) return [open + 1, close];
  }
  return null;
}
function sitesAt(src, mask, key, at) {
  const line = src.slice(src.lastIndexOf('\n', at - 1) + 1, (src.indexOf('\n', at) + 1 || src.length + 1) - 1);
  let keys = [key];
  if (PER_FILE[key]) {
    assert.ok(line.trimStart().startsWith(PER_FILE[key].loop), key + ': raised once per authority file');
    keys = PER_FILE[key].docs.map(d => key + ' @' + d);
  }
  const span = conditionOf(mask, at), pinned = CLAUSES[key];
  const when = span && src.slice(...span), code = span && mask.slice(...span);
  if (!pinned) {
    assert.ok(!span || !code.includes('||'), key + ': a condition joining clauses needs them named: ' + when);
    return keys;
  }
  assert.ok(when === pinned.when, key + ': the pinned condition');
  let from = 0, gaps = '';
  for (const text of Object.values(pinned.clauses)) {
    const i = when.indexOf(text, from);
    assert.ok(i >= 0 && when.indexOf(text, i + 1) < 0, key + ': each clause once, in order: ' + text);
    gaps += code.slice(from, i); from = i + text.length;
  }
  assert.ok((gaps + code.slice(from)).split('||').length === Object.keys(pinned.clauses).length, key + ': every clause is named');
  return keys.flatMap(k => Object.keys(pinned.clauses).map(c => k + ' #' + c));
}
// Every site at which the fence rejects a ledger shape, derived from the source: each message
// thrown in the fence's authority and linkage try blocks, directly, through the fence's own
// functions, or by a parser they reach (keyed by the ledger document the call reads); every
// measured diagnostic the fence raises with a literal message; each blob read, which git-evidence
// reports as undecodable by its path; and each clause of a joined condition. The sources are
// parameters so a planted copy can prove the extractor sees what is planted.
function fenceRejectionSites(fence = read('orchestrate/tools/check-fence.mjs'), parser = read('orchestrate/tools/ledger-parse.mjs'), evidence = read('orchestrate/tools/git-evidence.mjs')) {
  const fmask = codeMask(fence), pmask = codeMask(parser), emask = codeMask(evidence);
  const fenceDecls = topLevel(fmask), parserDecls = topLevel(pmask);
  // Each parser's throws, following its calls into the parser's other declarations.
  const parserThrows = (name, seen = new Set()) => {
    if (seen.has(name)) return [];
    seen.add(name);
    const { throws, calls } = region(parser, pmask, parserDecls[name].start, parserDecls[name].end, name);
    return [...throws, ...calls.filter(c => Object.hasOwn(parserDecls, c.name)).flatMap(c => parserThrows(c.name, seen))];
  };
  const parsed = new Set(), own = [], raised = new Set(), sinks = [], exempt = [];
  const raise = (key, at) => { assert.ok(!raised.has(key), 'one source site raises ' + key); raised.add(key); own.push(...sitesAt(fence, fmask, key, at)); };
  const walk = (code, a, b, where, seen) => {
    const { throws, calls } = region(fence, fmask, a, b, where);
    for (const t of throws) raise(code + ': ' + t.message, t.at);
    for (const c of calls) {
      if (Object.hasOwn(parserDecls, c.name)) {
        const found = parserThrows(c.name);
        if (!found.length) continue;
        const names = [...fmask.slice(c.open + 1, closing(fmask, c.open)).matchAll(/[A-Za-z_$][\w$]*/g)].map(t => t[0]);
        const docs = [...new Set(names.filter(n => Object.hasOwn(DOC, n)).map(n => DOC[n]))];
        assert.ok(docs.length === 1, `${c.name}(${fence.slice(c.open + 1, closing(fmask, c.open))}) must read exactly one ledger document`);
        for (const t of found) parsed.add(`${code}: ${t.message} @${docs[0]}`);
      } else if (Object.hasOwn(fenceDecls, c.name) && !seen.has(c.name)) {
        seen.add(c.name);
        walk(code, fenceDecls[c.name].start, fenceDecls[c.name].end, c.name, seen);
      }
    }
  };
  for (const code of ['authority', 'batch-linkage']) {
    const sink = `catch (e) { unknowns.push(diagnostic('${code}', e.message`, end = fence.indexOf(sink);
    assert.ok(end >= 0 && fence.indexOf(sink, end + 1) < 0, 'one catch for ' + code);
    // The try block is the one whose closing brace meets the catch.
    const opens = [...fmask.slice(0, end).matchAll(/\btry\s*\{/g)].map(t => t.index + t[0].length - 1)
      .filter(open => fmask.slice(closing(fmask, open, '{', '}') + 1, end).trim() === '');
    assert.ok(opens.length === 1, 'one try block ending in the ' + code + ' catch');
    sinks.push(end + sink.indexOf('diagnostic('));
    walk(code, opens[0] + 1, closing(fmask, opens[0], '{', '}'), code + ' block', new Set());
  }
  const codes = new Set();
  let computed = 0;
  for (const m of fmask.matchAll(/(?<![\w$.])(diagnostic|add)\s*\(/g)) {
    const after = fence.slice(m.index + m[0].length), at = m.index + m[0].length + /^\s*/.exec(after)[0].length, lit = LITERAL.exec(fence.slice(at));
    if (!lit) {
      assert.ok(fence.startsWith(PUSHED[PUSHED.length - 1], m.index) && !computed++, 'a diagnostic with a computed code: ' + fence.slice(m.index, m.index + 60));
      continue;
    }
    const code = lit[1] ?? lit[2] ?? lit[3];
    codes.add(code);
    if (!MEASURED.includes(code)) continue;
    const rest = fence.slice(at + lit[0].length), sep = /^\s*,\s*/.exec(rest), msg = sep && LITERAL.exec(rest.slice(sep[0].length));
    if (!msg) {
      assert.ok(sinks.includes(m.index), code + ': a measured diagnostic with a computed message outside the two catches');
      sinks.splice(sinks.indexOf(m.index), 1); continue;
    }
    const key = code + ': ' + (msg[1] ?? msg[2] ?? msg[3]);
    if (EXEMPT.includes(key)) exempt.push(key); else raise(key, m.index);
  }
  assert.ok(sameSet([...codes], [...MEASURED, ...OPERATIONAL]), "the fence's diagnostic codes are exactly the measured and the operational ones: " + [...codes].join(', '));
  const pushed = [];
  for (const m of fmask.matchAll(/(?<![\w$.])(unknowns|violations)\s*\.\s*([A-Za-z_$][\w$]*)\s*\(/g)) {
    assert.ok(m[2] === 'push', `${m[1]}.${m[2]}(: the verdict arrays grow by push alone`);
    const open = m.index + m[0].length - 1, arg = fence.slice(open + 1, closing(fmask, open)).trim();
    if (PUSHED.includes(arg)) { pushed.push(arg); continue; }
    assert.ok(/^diagnostic\(\s*(['"`])[\w-]+\1/.test(arg), `${m[1]}.push(${arg}): a push that is neither a literal-code diagnostic nor a named exemption`);
  }
  assert.ok(pushed.length === PUSHED.length && sameSet(pushed, PUSHED), 'every push exemption names one live push: ' + pushed.join(' | '));
  // Blob reads: git-evidence's readBlob reports an undecodable blob as invalid-encoding by path.
  const encodings = [...evidence.matchAll(/diagnostic\('invalid-encoding', '([^']+)'/g)];
  const readBlob = topLevel(emask).readBlob, blobBody = readBlob && evidence.slice(readBlob.start, readBlob.end);
  assert.ok(encodings.length === 1 && ENC === 'invalid-encoding: ' + encodings[0][1] && /\bgit\(/.test(blobBody) && blobBody.includes('diagnostics.push({ ...r.diagnostic, path: file })'),
    'readBlob reports an undecodable blob as ' + ENC + ' with its path');
  const reads = new Set();
  for (const m of fmask.matchAll(/(?<![\w$.])readBlob\s*\(/g)) {
    const open = m.index + m[0].length - 1, file = fmask.slice(open + 1, closing(fmask, open)).split(',')[2].trim();
    assert.ok(Object.hasOwn(READS, file), 'readBlob reads a known ledger document: ' + file);
    reads.add(ENC + ' @' + READS[file]);
  }
  own.push(...reads);
  assert.ok(sinks.length === 0, 'each try block ends in its measured catch');
  assert.ok(sameSet(exempt, EXEMPT) && exempt.length === EXEMPT.length, 'every exemption names one live site');
  const domain = [...parsed, ...own];
  assert.ok(new Set(domain).size === domain.length, 'a parsed site is never also raised directly');
  return domain;
}
function problemsOf(line) {
  const m = /^PARSE FAIL (\d+) problem\(s\): (.*)$/.exec(line);
  assert.ok(m, 'expected a PARSE FAIL line, got: ' + line);
  const problems = m[2].split('; ').map(p => /^(\S+):(\d+) (.*)$/.exec(p));
  assert.ok(problems.every(Boolean), line);
  assert.equal(Number(m[1]), problems.length, line);
  return problems.map(p => [p[1], Number(p[2]), p[3]]);
}

const sameSet = (a, b) => JSON.stringify([...new Set(a)].sort()) === JSON.stringify([...new Set(b)].sort());
// Replaces a ledger file with a link to identical bytes: a file symlink where the platform
// allows one, else a directory junction. Either way it is not an ordinary file.
function linkInPlace(file, content, outside) {
  const target = path.join(outside, path.basename(file));
  fs.rmSync(target, { recursive: true, force: true }); fs.unlinkSync(file);
  try { fs.writeFileSync(target, content); fs.symlinkSync(target, file, 'file'); }
  catch (e) { if (e.code !== 'EPERM') throw e; fs.rmSync(target, { force: true }); fs.mkdirSync(target); fs.symlinkSync(target, file, 'junction'); }
  assert.ok(fs.lstatSync(file).isSymbolicLink(), 'the link must exist: ' + file);
  return () => { fs.unlinkSync(file); fs.writeFileSync(file, content); };
}

test('the fence rejection domain is derived from the source, and every site is owned by a case', () => {
  const domain = fenceRejectionSites();
  // Pinned by hand: a site dropped from the source AND from the cases still goes red here.
  assert.equal(domain.length, 53, JSON.stringify(domain, null, 1));
  assert.equal(new Set(domain).size, domain.length);
  for (const site of [...UNREACHABLE, ...TIED.flat()]) assert.ok(domain.includes(site), site);
  assert.deepEqual([MEASURED.length, OPERATIONAL.length, PUSHED.length, OPERATOR.length, UNREACHABLE.length], [6, 10, 8, 3, 3]);
  assert.equal(new Set([...MEASURED, ...OPERATIONAL]).size, 16);
  // The distinct-refs site, once a known gap parse could not see, is owned by a case.
  assert.ok(CASES.some(c => sameSet(c.sites, [USAGE + ' #distinct-refs'])));
  assert.equal(CASES.length, 65);
  assert.equal(new Set(CASES.map(c => c.name)).size, CASES.length);
  for (const c of CASES) {
    for (const site of c.sites) assert.ok(domain.includes(site), c.name + ': not a fence rejection site: ' + site);
    // A case the fence rejects never demands PARSE OK: that would pin the looser parse.
    assert.ok(!c.sites.length || c.unknown || c.expect(c.edit(baseLedger())).length, c.name + ': rejected by the fence, so parse must not pass it');
  }
  // Owned: some case is rejected by the fence at this site and no other (or only with the site it
  // is tied to), so the parse check standing opposite it is the only thing that can fail it.
  for (const site of domain) {
    if (UNREACHABLE.includes(site)) { assert.ok(!CASES.some(c => c.sites.includes(site)), site); continue; }
    const tie = TIED.find(t => t.includes(site)) ?? [site];
    assert.ok(CASES.some(c => sameSet(c.sites, tie) && c.sites.length === tie.length), 'no case is rejected at this site alone: ' + site);
  }
  assert.ok(CASES.some(c => !c.sites.length && c.expect(c.edit(baseLedger())).length), 'a case where parse is stricter than the fence');
});

test('the rejection-site extractor: a planted site grows the domain, an unreadable one stops it', () => {
  const fence = read('orchestrate/tools/check-fence.mjs'), parser = read('orchestrate/tools/ledger-parse.mjs');
  const base = fenceRejectionSites(fence, parser);
  const grows = [
    ['a throw before the first authority statement', swap(fence, '  try {\n    if (plan === null', "  try {\n    if (plan !== null && plan.includes('ZZZ-SENTINEL')) throw new Error('Sentinel plan rejected');\n    if (plan === null"), parser,
      ['authority: Sentinel plan rejected']],
    ['a template-literal throw in the authority block', swap(fence, "    const branch = batch.slice('refs/heads/'.length);\n",
      "    const branch = batch.slice('refs/heads/'.length);\n    if (branch === 'zzz') throw new Error(`Sentinel ${branch}`);\n"), parser, ['authority: Sentinel ${branch}']],
    ['a measured diagnostic with a literal message', swap(fence, "{ path: file }));\n", "{ path: file }));\n  unknowns.push(diagnostic('authority', 'Sentinel batch file'));\n"), parser,
      ['authority: Sentinel batch file']],
    ['a double-quoted throw in a parser the fence reaches', fence, swap(parser, 'export function table(text, required) {\n', 'export function table(text, required) {\n  if (text === \'zzz\') throw new Error("Sentinel table");\n'),
      ['authority: Sentinel table @plan', 'authority: Sentinel table @progress']],
    ['a throw in a fence function the linkage block calls', swap(fence, 'export function validateBatchEdit(baseline, proposed, originalPaths, addedPaths, batchPath) {\n',
      "export function validateBatchEdit(baseline, proposed, originalPaths, addedPaths, batchPath) {\n  if (baseline.includes('ZZZ-M1')) throw new Error('Sentinel baseline rejected');\n"), parser, ['batch-linkage: Sentinel baseline rejected']],
    ['a throw before a nested try in the linkage block', swap(fence, '      try {\n        if (!new RegExp(`^# ${batchId}',
      "      try {\n        if (baseline.includes('ZZZ-M7B')) throw new Error('Sentinel before nested try');\n        try { JSON.parse('0'); } catch { }\n        if (!new RegExp(`^# ${batchId}"), parser,
      ['batch-linkage: Sentinel before nested try']],
    ['a condition wrapped onto a second line', swap(fence, '(?:—|-) `).test(baseline)) throw', '(?:—|-) `)\n          .test(baseline)) throw'), parser, []],
    ['a throw in a parser helper above the first export', fence, swap(swap(parser, 'export const linesOf', "function guard(text) { if (text.includes('ZZZ-M4')) throw new Error('Sentinel helper'); }\nexport const linesOf"),
      '  const lines = linesOf(text), matches = [];', '  guard(text);\n  const lines = linesOf(text), matches = [];'), ['authority: Sentinel helper @plan', 'authority: Sentinel helper @progress']],
  ];
  for (const [name, f, p, added] of grows) {
    const grown = fenceRejectionSites(f, p);
    assert.deepEqual(base.filter(s => !grown.includes(s)), [], name + ': nothing lost');
    assert.deepEqual(grown.filter(s => !base.includes(s)).sort(), added.slice().sort(), name);
  }
  const firstLine = re => err => re.test(String(err.message).split('\n')[0]);
  const stops = [
    ['a throw the extractor cannot read', swap(fence, '    if (plan === null', "    if (plan === 'zzz') throw sentinel;\n    if (plan === null"), parser, /^authority block: every throw raises an Error with a literal message$/],
    ['a measured diagnostic with a computed message', swap(fence, "{ path: file }));\n", "{ path: file }));\n  unknowns.push(diagnostic('authority', String(plan)));\n"), parser,
      /^authority: a measured diagnostic with a computed message outside the two catches$/],
    ['a diagnostic code neither measured nor operational', swap(fence, 'progressPath, unknowns, options);\n',
      "progressPath, unknowns, options);\n  if (plan !== null && plan.includes('ZZZ-M8')) unknowns.push(diagnostic('ledger-shape', 'Sentinel new code', { path: planPath }));\n"), parser,
      /^the fence's diagnostic codes are exactly the measured and the operational ones: /],
    ['an object-literal push', swap(fence, 'progressPath, unknowns, options);\n', "progressPath, unknowns, options);\n  unknowns.push({ code: 'authority', message: 'Sentinel object literal', path: planPath });\n"), parser,
      /^unknowns\.push\(\{ code: 'authority', .*\): a push that is neither a literal-code diagnostic nor a named exemption$/],
    ['a verdict array grown by another method', swap(fence, 'progressPath, unknowns, options);\n', "progressPath, unknowns, options);\n  unknowns.unshift(diagnostic('authority', 'Sentinel unshift'));\n"), parser,
      /^unknowns\.unshift\(: the verdict arrays grow by push alone$/],
    ['a catch that rethrows in a fence function the linkage block calls', swap(fence, 'export function validateBatchEdit(baseline, proposed, originalPaths, addedPaths, batchPath) {\n',
      "export function validateBatchEdit(baseline, proposed, originalPaths, addedPaths, batchPath) {\n  try { JSON.parse(baseline); } catch { throw new Error('Sentinel rethrown'); }\n"), parser, /^validateBatchEdit: a catch that rethrows$/],
    ['a clause joined to a condition wrapped onto a second line', swap(fence, '(?:—|-) `).test(baseline)) throw', "(?:—|-) `)\n          .test(baseline) || baseline === 'zzz') throw"), parser,
      /^batch-linkage: Batch title does not match ID: a condition joining clauses needs them named: /],
    // The exempt clause moved into the usage guard, a ledger-shape clause left in its place.
    ['a clause moved from the branch condition into the usage guard', swap(swap(fence, 'if (!repo || ', "if (!repo || !batch.startsWith('refs/heads/') || "),
      "!batch.startsWith('refs/heads/') || branchCell(planRow.Branch)", '!planRow.Batch || branchCell(planRow.Branch)'), parser,
      /^authority: Plan\/PROGRESS branch linkage does not agree: the pinned condition$/],
    ['a clause added to the usage guard alone', swap(fence, 'if (!repo || ', "if (!repo || !batch.startsWith('refs/heads/') || "), parser, /^usage: .*: the pinned condition$/],
    ['a clause joined to a single-clause condition', swap(fence, 'if (!baselineMode) ', "if (!baselineMode || plan === 'zzz') "), parser, /^batch-baseline: .*: a condition joining clauses needs them named: /],
  ];
  for (const [name, f, p, re] of stops) assert.throws(() => fenceRejectionSites(f, p), firstLine(re), name);
});

// The real fence command line, run asynchronously so one case's fence overlaps the next case's setup.
function fenceRun(cwd, env, gate) {
  const args = ['--repo', cwd, ...['integration', 'batch', 'ledger', 'batch-id', 'batch-file'].flatMap(k => ['--' + k, gate[k]])];
  return new Promise((resolve, reject) => execFile(process.execPath, [FENCE, ...args], { cwd, env, encoding: 'utf8', windowsHide: true, timeout: 120000, maxBuffer: 16 * 1024 * 1024 },
    (error, stdout) => error && typeof error.code !== 'number' ? reject(error) : resolve({ code: error ? error.code : 0, verdict: JSON.parse(stdout) })));
}
const POOL = 4;
test('parse is never looser than the fence: each case in parse and in the real fence', { concurrency: POOL }, async t => {
  // One fixture repository per concurrent case: each commit replaces that repository's whole ledger.
  const pool = Array.from({ length: POOL }, () => {
    const repo = makeRepo(t); repo.git('checkout', '-b', 'feat/one'); repo.git('config', 'core.symlinks', 'false');
    return { repo, outside: tmp(t) };
  });
  const opts = { integration: 'refs/heads/' + INTEGRATION_BRANCH, batch: 'refs/heads/feat/one', 'batch-id': 'B01' };
  // The fence is invoked with the fixture contract's own integration branch.
  const { gitModel } = await parserApi;
  assert.equal(opts.integration, 'refs/heads/' + gitModel(baseLedger()[CONTRACT]).integration);
  const FILE_OF = { plan: PLAN, progress: PROG }, DOC_OF = { [PLAN]: 'plan', [PROG]: 'progress' };
  // The fence's own key for a site: the clause is never visible to it, the document only where
  // its diagnostic carries the authority file's path.
  const fenceKey = s => { const k = s.replace(/ #[\w-]+$/, ''); return BY_DOC.some(c => k.startsWith(c + ': ')) ? k : k.replace(/ @\w+$/, ''); };
  await Promise.all(CASES.map(c => t.test(c.name, async () => {
    const slot = pool.pop();
    assert.ok(slot, 'a free fixture repository');
    try { await fenceCase(c, slot); } finally { pool.push(slot); }
  })));
  async function fenceCase(c, { repo, outside }) {
    const files = c.edit(baseLedger()), ledger = c.ledger ?? path.posix.basename(LEDGER);
    const gate = { ...opts, ledger, 'batch-file': `.agents/changes/${ledger}/${B1}`, ...c.gate };
    // Only the base control and the cases that change the file type or the ledger's name keep the bytes.
    if (c.name !== 'ledger from the real templates' && !c.link && !c.ledger) assert.notDeepEqual(files, baseLedger());
    fs.rmSync(path.join(repo.cwd, '.agents'), { recursive: true, force: true });
    const dir = path.join(repo.cwd, '.agents', 'changes', ledger);
    writeTree(dir, files);
    // The working tree, before any commit: the scaffold-time reading.
    const restore = c.link ? linkInPlace(path.join(dir, c.link), files[c.link], outside) : null;
    const r = run(['parse', '--dir', dir]);
    if (restore) restore();
    // Each ledger document a site is keyed by is one parse names too.
    const docs = c.sites.flatMap(s => / @(\w+)(?: #|$)/.exec(s)?.slice(1) ?? []).map(d => FILE_OF[d] ?? path.posix.basename(gate['batch-file']));
    if (c.unknown) {
      assert.equal(r.status, 2, r.line); assert.match(r.line, c.unknown);
      for (const file of docs) assert.ok(r.line.includes(file), c.name + ': parse must name ' + file);
    } else {
      const expected = c.expect(files);
      if (!expected.length) assert.deepEqual(r, { status: 0, line: 'PARSE OK 2 batches' });
      else {
        assert.equal(r.status, 1, r.line);
        const found = problemsOf(r.line);
        assert.deepEqual(found.map(p => p.slice(0, 2)), expected.map(e => e.slice(0, 2)), r.line);
        found.forEach((p, i) => assert.match(p[2], expected[i][2], r.line));
        for (const file of docs) assert.ok(found.some(p => p[0] === file), c.name + ': parse must name ' + file);
      }
    }
    // Committed with the same bytes; a linked file is committed as a symlink blob.
    repo.git('rm', '-r', '-q', '--cached', '--ignore-unmatch', '--', '.agents'); repo.git('add', '--all');
    if (c.link) {
      const rel = `.agents/changes/${ledger}/${c.link}`, blob = repo.git('hash-object', '-w', '--', rel);
      repo.git('update-index', '--cacheinfo', `120000,${blob},${rel}`);
    }
    repo.git('commit', '--allow-empty', '-q', '-m', c.name);
    repo.git('update-ref', opts.integration, repo.git('rev-parse', 'HEAD'));
    const { code, verdict } = await fenceRun(repo.cwd, repo.env, gate);
    assert.equal(code, { PASS: 0, VIOLATION: 1, UNKNOWN: 2 }[verdict.status], JSON.stringify(verdict));
    const docOf = p => p === gate['batch-file'] ? 'batch' : DOC_OF[path.posix.basename(p)];
    const measured = [...verdict.unknowns, ...verdict.violations].filter(d => MEASURED.includes(d.code) || BY_DOC.includes(d.code))
      .map(d => d.code + ': ' + d.message + (BY_DOC.includes(d.code) ? ' @' + docOf(d.path) : ''));
    assert.ok(sameSet(measured, c.sites.map(fenceKey)), JSON.stringify(verdict));
    if (!c.sites.length) assert.equal(verdict.status, 'PASS', JSON.stringify(verdict));
  }
});

test('parse-only shapes, the problem cap from both sides, and unreadable input', async t => {
  const dir = path.join(tmp(t), 'ledger');
  const shapes = [
    ['empty plan table', f => edit(f, PLAN, /^\| B01 \|.*\n\| B02 \|.*\n/m, ''), [[PLAN, 1, /^batch table \(#, Branch, Files \(fence\)\) has no rows$/]]],
    ['batch file with no number', f => ({ ...f, '02-batches-x-foo.md': f[B2] }), [['02-batches-x-foo.md', 1, /^no plan row claims this batch file$/]]],
    ['duplicate id', f => edit(f, PLAN, /^\| B02 \|/m, '| B01 |'), null],
  ];
  for (const [name, change, expected] of shapes) {
    const files = change(baseLedger()); writeTree(dir, files);
    const r = run(['parse', '--dir', dir]); assert.equal(r.status, 1, name + ': ' + r.line);
    const found = problemsOf(r.line);
    // Both rows carrying the duplicate are blamed, each on its own line.
    const want = expected ?? [[PLAN, lineOf(files[PLAN], /^\| B01 \|/), /Duplicate or malformed/], [PLAN, lineOf(files[PLAN], /^\| B01 \|/, 1), /Duplicate or malformed/], [PROG, lineOf(files[PROG], /^\| B02 \|/), /^B02: no plan row$/], [B2, 1, /^no plan row claims this batch file$/]];
    assert.deepEqual(found.map(p => p.slice(0, 2)), want.map(e => e.slice(0, 2)), name + ': ' + r.line);
    found.forEach((p, i) => assert.match(p[2], want[i][2], name));
  }
  // Ten problems print whole; the eleventh becomes a count. Held from both sides.
  const orphans = n => Object.fromEntries(Array.from({ length: n }, (_, i) => ['02-batches-' + (50 + i) + '-x.md', 'orphan']));
  writeTree(dir, { ...baseLedger(), ...orphans(10) });
  const ten = run(['parse', '--dir', dir]);
  assert.equal(problemsOf(ten.line).length, 10); assert.doesNotMatch(ten.line, /more\)$/);
  writeTree(dir, { ...baseLedger(), ...orphans(11) });
  const eleven = run(['parse', '--dir', dir]);
  assert.match(eleven.line, /^PARSE FAIL 11 problem\(s\): /); assert.match(eleven.line, / \(\+1 more\)$/);
  assert.equal(eleven.line.replace(/ \(\+1 more\)$/, '').split('; ').length, 10);
  // Unreadable input is UNKNOWN, never a verdict.
  writeTree(dir, without(baseLedger(), PROG));
  const missing = run(['parse', '--dir', dir]); assert.equal(missing.status, 2); assert.match(missing.line, /^UNKNOWN cannot read .*PROGRESS\.md$/);
  writeTree(dir, { ...baseLedger(), [PROG]: Buffer.from([0xff, 0xfe, 0x41]) });
  const binary = run(['parse', '--dir', dir]); assert.equal(binary.status, 2); assert.match(binary.line, /^UNKNOWN not UTF-8: .*PROGRESS\.md$/);
  writeTree(dir, without(baseLedger(), B2)); fs.mkdirSync(path.join(dir, B2));
  const folder = run(['parse', '--dir', dir]); assert.equal(folder.status, 2); assert.match(folder.line, /^UNKNOWN not an ordinary file: .*02-batches-02-two\.md$/);
  const absent = run(['parse', '--dir', path.join(dir, 'absent')]); assert.equal(absent.status, 2); assert.match(absent.line, /^UNKNOWN cannot read ledger directory /);
});

test('parse accepts a CRLF checkout of the same ledger, exactly as the fence does', async t => {
  const dir = path.join(tmp(t), 'ledger');
  const crlf = Object.fromEntries(Object.entries(baseLedger()).map(([k, v]) => [k, v.replace(/\n/g, '\r\n')]));
  assert.ok(Object.values(crlf).every(v => v.includes('\r\n')));
  writeTree(dir, crlf);
  assert.deepEqual(run(['parse', '--dir', dir]), { status: 0, line: 'PARSE OK 2 batches' });
  writeTree(dir, edit(crlf, B1, '**Files**: `a.txt`, `b.txt`', '**Files**: `a.txt`'));
  assert.equal(run(['parse', '--dir', dir]).status, 1, 'the CRLF checkout must still be read, not waved through');
});

test('live corpus: the archived stale-template ledger fails on its tables', { skip: 'needs history and ledger records that are not in this copy' }, () => {
  // Scaffolded from a stale template: a lower-case plan header and two PROGRESS batch tables.
  const archived = path.join(ROOT, '.agents', 'archive', 'OS-20260921-backlog-closeout');
  assert.ok(fs.statSync(archived).isDirectory());
  assert.deepEqual(run(['parse', '--dir', archived]), { status: 1, line: 'PARSE FAIL 2 problem(s): '
    + '01-plan.md:1 batch table (#, Branch, Files (fence)): Missing or ambiguous authority table; '
    + 'PROGRESS.md:1 batch table (#, Branch, Notes): Missing or ambiguous authority table' });
});

// ===== BL-031: parse reads the contract's Git model =============================
const triples = result => result.problems.map(p => [p.file, p.line, p.message]);
const gitHeadingLine = text => lineOf(text, /^## Git model\b/);

test('BL-031: parse refuses a batch on the contract\'s integration or default branch, and nothing beside them', async t => {
  const { parseLedger } = await ledgerApi;
  const dir = path.join(tmp(t), 'ledger');
  const parsed = files => { writeTree(dir, files); return triples(parseLedger(dir)); };
  assert.deepEqual(parsed(baseLedger()), [], 'the control ledger parses clean');
  const both = (f, id, branch, kind) => [[PLAN, row(f, PLAN, id), `${id} Branch: ${branch} is the ${kind} branch`], [PROG, row(f, PROG, id), `${id} Branch: ${branch} is the ${kind} branch`]];
  for (const [branch, kind] of [[INTEGRATION_BRANCH, 'integration'], ['main', 'default']]) {
    const f = setBranch(baseLedger(), branch);
    assert.deepEqual(parsed(f), both(f, 'B01', branch, kind), branch);
  }
  // PROGRESS alone on the integration branch is blamed on its own row; so is a later batch.
  const progressOnly = edit(baseLedger(), PROG, '`feat/one`', '`integration`');
  assert.deepEqual(parsed(progressOnly), [[PROG, row(progressOnly, PROG), "B01: Branch integration differs from the plan's feat/one"],
    [PROG, row(progressOnly, PROG), 'B01 Branch: integration is the integration branch']]);
  const second = edit(edit(edit(baseLedger(), PLAN, '`fix/two`', '`integration`'), PROG, '`fix/two`', '`integration`'), B2, '**Branch**: `fix/two`', '**Branch**: `integration`');
  assert.deepEqual(parsed(second), both(second, 'B02', 'integration', 'integration'));
  // The other side of the boundary: names beside the reserved ones are ordinary branches.
  for (const near of ['integration2', 'integratio', 'feat/integration', 'main2', 'Main', 'heads/main', 'refs/heads/main']) {
    assert.deepEqual(parsed(setBranch(baseLedger(), near)), [], near);
  }
  // The names are the contract's: other values move the refusal with them.
  const trunk = setBranch(baseLedger(), 'trunk');
  assert.deepEqual(parsed({ ...trunk, [CONTRACT]: contractFile({ MAIN_BRANCH: 'refs/heads/trunk', INTEGRATION_BRANCH: 'chore/x-ledger' }) }), both(trunk, 'B01', 'trunk', 'default'));
  assert.deepEqual(parsed({ ...trunk, [CONTRACT]: contractFile({ MAIN_BRANCH: 'refs/heads/main', INTEGRATION_BRANCH: 'trunk' }) }), both(trunk, 'B01', 'trunk', 'integration'));
  assert.deepEqual(parsed({ ...setBranch(baseLedger(), 'integration'), [CONTRACT]: contractFile({ INTEGRATION_BRANCH: 'chore/x-ledger' }) }), []);
  assert.deepEqual(parsed({ ...setBranch(baseLedger(), 'main'), [CONTRACT]: contractFile({ MAIN_BRANCH: 'refs/heads/trunk' }) }), []);
  // A default branch recorded as a bare name is the same branch.
  const bare = setBranch(baseLedger(), 'main');
  assert.deepEqual(parsed({ ...bare, [CONTRACT]: contractFile({ MAIN_BRANCH: 'main' }) }), both(bare, 'B01', 'main', 'default'));
  // As published: the CLI names the row and the reason, exit 1.
  const published = setBranch(baseLedger(), INTEGRATION_BRANCH);
  writeTree(dir, published);
  assert.deepEqual(run(['parse', '--dir', dir]), { status: 1, line: `PARSE FAIL 2 problem(s): ${PLAN}:${row(published, PLAN)} B01 Branch: integration is the integration branch; `
    + `${PROG}:${row(published, PROG)} B01 Branch: integration is the integration branch` });
});

test('BL-031: a missing, unreadable or Git-model-less contract fails the parse on 00-READBEFORE.md', async t => {
  const { parseLedger, checkLedger } = await ledgerApi;
  const root = tmp(t), dir = path.join(root, 'ledger');
  const parsed = files => { writeTree(dir, files); return triples(parseLedger(dir)); };
  const contract = baseLedger()[CONTRACT], at = gitHeadingLine(contract);
  assert.ok(at > 1, 'the template has its Git model heading below line 1');
  const withContract = text => ({ ...baseLedger(), [CONTRACT]: text });
  const INTEGRATION = 'Integration branch: `integration`', DEFAULT = 'Default branch (protected local ref): `refs/heads/main`.';
  const shapes = [
    ['missing', without(baseLedger(), CONTRACT), [[CONTRACT, 1, 'cannot read 00-READBEFORE.md']]],
    ['not UTF-8', appendBytes(baseLedger(), CONTRACT), [[CONTRACT, 1, 'not UTF-8: 00-READBEFORE.md']]],
    ['no Git model heading', withContract(swap(contract, '## Git model (locked)', '## Git')), [[CONTRACT, 1, 'Git model: Missing or duplicated Git model heading']]],
    ['a near-miss heading', withContract(swap(contract, '## Git model (locked)', '## Git modelling')), [[CONTRACT, 1, 'Git model: Missing or duplicated Git model heading']]],
    ['two Git model headings', withContract(contract + '\n## Git model\n'), [[CONTRACT, at, 'Git model: Missing or duplicated Git model heading']]],
    ['the heading only inside a code fence', withContract(swap(contract, '## Git model (locked)\n', '```\n## Git model (locked)\n```\n')),
      [[CONTRACT, at + 1, 'Git model: Missing or duplicated Git model heading']]],
    ['no integration label', withContract(swap(contract, INTEGRATION, 'Integration: `integration`')), [[CONTRACT, at, 'Git model: no "Integration branch: `<name>`" label']]],
    ['the label only past the section', withContract(swap(contract, INTEGRATION, 'Integration: `integration`') + '\n## Later\n\n' + INTEGRATION + '\n'),
      [[CONTRACT, at, 'Git model: no "Integration branch: `<name>`" label']]],
    ['a repeated integration label', withContract(swap(contract, INTEGRATION, INTEGRATION + '. Integration branch: `other`')),
      [[CONTRACT, at, 'Git model integration branch: Repeated Git model label']]],
    // A repeated default-branch label is reported, and the integration branch is still enforced.
    ['a repeated default-branch label', { ...setBranch(baseLedger(), INTEGRATION_BRANCH), [CONTRACT]: swap(contract, DEFAULT, DEFAULT + ' ' + DEFAULT.replace('main', 'trunk')) },
      f => [[CONTRACT, at, 'Git model default branch: Repeated Git model label'], [PLAN, row(f, PLAN), 'B01 Branch: integration is the integration branch'],
        [PROG, row(f, PROG), 'B01 Branch: integration is the integration branch']]],
    // Fail closed, never alone: the rest of the ledger is still checked.
    ['missing, beside a stale Files line', edit(without(baseLedger(), CONTRACT), B1, '**Files**: `a.txt`, `b.txt`', '**Files**: `a.txt`'),
      f => [[CONTRACT, 1, 'cannot read 00-READBEFORE.md'], [B1, lineOf(f[B1], /^\*\*Files\*\*: /), 'Files line differs from the plan fence']]],
  ];
  for (const [name, files, want] of shapes) assert.deepEqual(parsed(files), typeof want === 'function' ? want(files) : want, name);
  // A link to identical bytes, and a directory, are not ordinary files.
  writeTree(dir, baseLedger());
  const restore = linkInPlace(path.join(dir, CONTRACT), contract, tmp(t));
  try { assert.deepEqual(triples(parseLedger(dir)), [[CONTRACT, 1, 'a link, not an ordinary file: 00-READBEFORE.md']]); } finally { restore(); }
  assert.deepEqual(triples(parseLedger(dir)), [], 'restored');
  writeTree(dir, without(baseLedger(), CONTRACT)); fs.mkdirSync(path.join(dir, CONTRACT));
  assert.deepEqual(triples(parseLedger(dir)), [[CONTRACT, 1, 'not an ordinary file: 00-READBEFORE.md']]);
  // The pure core: no contract text is the same refusal; the text passes.
  const f = baseLedger(), batches = new Map([[B1, f[B1]], [B2, f[B2]]]);
  const noContract = [[CONTRACT, 1, 'no contract; the integration branch is read from it']];
  assert.deepEqual(triples(checkLedger(f[PLAN], f[PROG], batches, 'FIXTURE', null)), noContract);
  assert.deepEqual(triples(checkLedger(f[PLAN], f[PROG], batches, 'FIXTURE')), noContract);
  assert.deepEqual(checkLedger(f[PLAN], f[PROG], batches, 'FIXTURE', f[CONTRACT]), { status: 'OK', batches: 2, problems: [] });
  writeTree(dir, without(baseLedger(), CONTRACT));
  assert.deepEqual(run(['parse', '--dir', dir]), { status: 1, line: 'PARSE FAIL 1 problem(s): 00-READBEFORE.md:1 cannot read 00-READBEFORE.md' });
});

test('gitModel: the four Git model values, raw; null when absent; a repeated label throws only when read', { skip: 'needs history and ledger records that are not in this copy' }, async () => {
  const { gitModel } = await parserApi;
  const fields = m => ({ main: m.main, integration: m.integration, shipmentSource: m.shipmentSource, shipmentRef: m.shipmentRef });
  const source = 'remote origin (https://example.invalid/x.git) — a merge there counts';
  const contract = contractFile({ SHIPMENT_SOURCE: source, SHIPMENT_REF: 'refs/heads/main' });
  const want = { main: MAIN_BRANCH, integration: INTEGRATION_BRANCH, shipmentSource: source, shipmentRef: 'refs/heads/main' };
  assert.deepEqual(fields(gitModel(contract)), want);
  assert.deepEqual(fields(gitModel(contract.replace(/\n/g, '\r\n'))), want, 'a CRLF contract reads the same');
  // Never validated: a contract filled with `example` everywhere reads `example` everywhere.
  assert.deepEqual(fields(gitModel(contractFile({ MAIN_BRANCH: 'example', INTEGRATION_BRANCH: 'example' }))),
    { main: 'example', integration: 'example', shipmentSource: 'example', shipmentRef: 'example' });
  // Live corpus: an archived contract, its shipment source a sentence.
  const archived = fs.readFileSync(path.join(ROOT, '.agents', 'archive', 'OS-20260921-backlog-closeout', '00-READBEFORE.md'), 'utf8');
  assert.deepEqual(fields(gitModel(archived)), { main: 'refs/heads/main', integration: 'chore/backlog-closeout-ledger',
    shipmentSource: 'remote origin (https://github.com/hopefullyanonymous/wave-orchestrator.git) — a merge on that remote counts as shipped; a local merge does not', shipmentRef: 'refs/heads/main' });
  // Labels past the section's end are not its own; a fenced heading inside it does not end it.
  const later = '## Git model (locked)\n\n- Integration branch: `i`.\n\n```\n## inside a fence\n```\nShipment ref: `r`.\n\n### Next\n\n- Default branch (protected local ref): `refs/heads/main`. Shipment source: `local`.\n';
  assert.deepEqual(fields(gitModel(later)), { main: null, integration: 'i', shipmentSource: null, shipmentRef: 'r' });
  // A label wrapped across lines is read whole; an empty backtick value is no value.
  assert.equal(gitModel('## Git model\n\nIntegration\n  branch:   `i`\n').integration, 'i');
  assert.equal(gitModel('## Git model\n\nIntegration branch: ``\n').integration, null);
  // Each label, repeated, throws when its field is read and never when another is.
  const labels = { main: 'Default branch (protected local ref): ', integration: 'Integration branch: ', shipmentSource: 'Shipment source: ', shipmentRef: 'Shipment ref: ' };
  for (const [key, label] of Object.entries(labels)) {
    const twice = gitModel('## Git model\n\n' + Object.values(labels).map(l => l + '`v`.').join(' ') + ' ' + label + '`w`.\n');
    assert.throws(() => twice[key], e => /^Repeated Git model label$/.test(e.message) && e.count === 2, key);
    const thrice = gitModel('## Git model\n\n' + label + '`a`. ' + label + '`b`. ' + label + '`c`.\n');
    assert.throws(() => thrice[key], e => /^Repeated Git model label$/.test(e.message) && e.count === 3, key + ' three times');
    for (const other of Object.keys(labels).filter(k => k !== key)) assert.equal(twice[other], 'v', key + ' repeated, ' + other + ' read');
  }
  for (const text of ['# Contract\n', '## Git model\n\n## Git model (again)\n', '```\n## Git model\n```\nIntegration branch: `i`\n', '## Git model\n```\n## Git model\n```\n',
    '### Git model\n', ' ## Git model\n', '## Git modelling\n', '## Git model'.replace('## ', '##\t')]) {
    assert.throws(() => gitModel(text), /^Error: Missing or duplicated Git model heading$/, JSON.stringify(text));
  }
});

// ===== selfcheck: scaffolding step 9 ========================================
// A ledger step 9 passes: every slot filled, every comment stripped, the pre-flight line written,
// and a contract pinning a real skill directory by its hash.
function cleanLedger(skillDir, hex) {
  const fill = text => text.replace(/\{\{([A-Z0-9_]+)\}\}/g, 'example').replace(/<!--[\s\S]*?-->/g, '');
  const f = Object.fromEntries(Object.entries(baseLedger()).map(([k, v]) => [k, fill(v)]));
  return { ...f, [PLAN]: f[PLAN] + '\nPre-flight: CLEAN\n', [CONTRACT]: contractFile({ SKILL_DIR: skillDir, SKILL_SHA256: hex }), 'LOG.md': '# Log\n', 'validate.json': '{}\n' };
}
const quads = result => result.problems.map(p => [p.file, p.line, p.message, p.rule]);

test('selfcheck: step 9 over every file, one failing ledger per rule, and quoted code never a slot', async t => {
  const { selfcheck, RULES } = await ledgerApi;
  assert.deepEqual(RULES.selfcheck, ['slot', 'state', 'preflight', 'parse', 'skill']);
  const root = tmp(t), skillDir = writeTree(path.join(root, 'skill'), SKILL), hex = specHash(SKILL), dir = path.join(root, 'ledger');
  const clean = cleanLedger(skillDir, hex);
  writeTree(dir, clean);
  assert.deepEqual(run(['selfcheck', '--dir', dir]), { status: 0, line: 'SELFCHECK OK 2 batches' });
  const seen = new Set();
  const fails = (name, files, want) => {
    writeTree(dir, files);
    const got = quads(selfcheck(dir));
    assert.deepEqual(got, typeof want === 'function' ? want(files) : want, name);
    for (const p of got) seen.add(p[3]);
  };
  const at = (text, re, nth) => lineOf(text, re, nth);
  // Slots: every file, at any depth; `<title>` in Markdown only.
  fails('a {{ slot in the log', { ...clean, 'LOG.md': '# Log\n\nA {{SLOT}} here.\n' }, [['LOG.md', 3, 'an unfilled {{ slot', 'slot']]);
  fails('a comment in a nested input', { ...clean, 'inputs/deep/I-01.txt': 'ok\n<!-- left -->\n' }, [['inputs/deep/I-01.txt', 2, 'an unremoved <!-- comment', 'slot']]);
  fails('<title> in a batch file', edit(clean, B2, '# B02 — Two', '# B02 — <title>'), [[B2, 1, 'an unfilled <title> slot', 'slot']]);
  fails('<title> outside Markdown is text; {{ is still a slot', { ...clean, 'validate.json': '{"a": "<title>",\n"b": "{{X}}"}\n' }, [['validate.json', 2, 'an unfilled {{ slot', 'slot']]);
  fails('three tokens on one line', { ...clean, 'LOG.md': '{{X}} <!-- <title>\n' },
    [['LOG.md', 1, 'an unfilled {{ slot', 'slot'], ['LOG.md', 1, 'an unremoved <!-- comment', 'slot'], ['LOG.md', 1, 'an unfilled <title> slot', 'slot']]);
  // Quoted in code, never a slot: spans of any run length, backtick and tilde fences, indented fences.
  const quoted = ['`{{X}}` and `<!--` and ``a ` <title>`` and ```{{X}}```', '```md', '{{X}} <!-- <title>', '```', '~~~~', '{{X}}', '```', '~~~~~', '   ```', '<!--', '```'];
  fails('quoted in code', { ...clean, 'LOG.md': quoted.join('\n') + '\n' }, []);
  // The same tokens outside code: after a span, an unclosed span, a span closed by a shorter run,
  // a fence closed by a shorter or a different run, and a fence never closed.
  // A backtick run with a backtick after it opens no fence, so the lines below it stay prose.
  fails('a span at the start of a line is no fence', { ...clean, 'LOG.md': ['```a``` {{X}}', '{{Y}}', '```'].join('\n') + '\n' },
    [['LOG.md', 1, 'an unfilled {{ slot', 'slot'], ['LOG.md', 2, 'an unfilled {{ slot', 'slot']]);
  fails('beside code, not in it', { ...clean, 'LOG.md': ['`{{X}}` {{Y}}', '`unclosed {{X}}', '``{{X}}`', '````', '{{X}}', '```', '~~~', '```', '<!--'].join('\n') + '\n' },
    [['LOG.md', 1, 'an unfilled {{ slot', 'slot'], ['LOG.md', 2, 'an unfilled {{ slot', 'slot'], ['LOG.md', 3, 'an unfilled {{ slot', 'slot'],
      ['LOG.md', 5, 'an unfilled {{ slot', 'slot'], ['LOG.md', 9, 'an unremoved <!-- comment', 'slot']]);
  // State: exactly one line, reading exactly ACTIVE.
  const state = at(clean[PROG], /^\*\*State\*\*:/);
  fails('State PAUSED', edit(clean, PROG, '**State**: ACTIVE', '**State**: PAUSED'), [[PROG, state, 'must read exactly **State**: ACTIVE', 'state']]);
  fails('State with a note', edit(clean, PROG, '**State**: ACTIVE', '**State**: ACTIVE (resumed)'), [[PROG, state, 'must read exactly **State**: ACTIVE', 'state']]);
  fails('no State line', edit(clean, PROG, '**State**: ACTIVE\n', ''), [[PROG, 1, '0 lines start "**State**:", expected exactly one', 'state']]);
  fails('two State lines', edit(clean, PROG, '**State**: ACTIVE', '**State**: ACTIVE\n**State**: ACTIVE'), [[PROG, state + 1, '2 lines start "**State**:", expected exactly one', 'state']]);
  // The pre-flight line, in either of the template's two forms and no other.
  const preflight = at(clean[PLAN], /^Pre-flight:/), form = 'must read exactly "Pre-flight: CLEAN" or "Pre-flight: N blocking fixed, M advisory (see LOG.md)"';
  fails('the counted form', edit(clean, PLAN, 'Pre-flight: CLEAN', 'Pre-flight: 4 blocking fixed, 13 advisory (see LOG.md)'), []);
  for (const bad of ['Pre-flight: clean', 'Pre-flight: CLEAN.', 'Pre-flight: 4 blocking fixed, 13 advisory', 'Pre-flight: N blocking fixed, M advisory (see LOG.md)', 'Pre-flight:  CLEAN']) {
    fails(bad, edit(clean, PLAN, 'Pre-flight: CLEAN', bad), [[PLAN, preflight, form, 'preflight']]);
  }
  fails('no pre-flight line', edit(clean, PLAN, '\nPre-flight: CLEAN\n', '\n'), [[PLAN, 1, '0 lines start "Pre-flight:", expected exactly one', 'preflight']]);
  fails('two pre-flight lines', edit(clean, PLAN, 'Pre-flight: CLEAN', 'Pre-flight: CLEAN\nPre-flight: CLEAN'), [[PLAN, preflight + 1, '2 lines start "Pre-flight:", expected exactly one', 'preflight']]);
  // Parse, Bnn ids and BL-031 included.
  fails('a malformed id', edit(clean, PLAN, /^\| B02 \|/m, '| B2 |'), f => [[PLAN, row(f, PLAN, 'B2'), 'B2: Duplicate or malformed batch IDs', 'parse'],
    [PROG, row(f, PROG, 'B02'), 'B02: no plan row', 'parse'], [B2, 1, 'no plan row claims this batch file', 'parse']]);
  fails('a batch on the integration branch', setBranch(clean, INTEGRATION_BRANCH), f => [[PLAN, row(f, PLAN), 'B01 Branch: integration is the integration branch', 'parse'],
    [PROG, row(f, PROG), 'B01 Branch: integration is the integration branch', 'parse']]);
  // The skill pin: a stale hash, a malformed or missing line.
  const pin = at(clean[CONTRACT], /^\*\*Skill\*\*/), zeros = '0'.repeat(64);
  fails('a stale pin', { ...clean, [CONTRACT]: swap(clean[CONTRACT], hex, zeros) }, [[CONTRACT, pin, `skill pin: pinned ${zeros} actual ${hex}`, 'skill']]);
  fails('a malformed pin', { ...clean, [CONTRACT]: swap(clean[CONTRACT], ' · sha256 ', ' . sha256 ') }, [[CONTRACT, pin, 'skill pin: Malformed skill pin line', 'skill']]);
  fails('no contract', without(clean, CONTRACT), [[CONTRACT, 1, 'cannot read 00-READBEFORE.md', 'parse']]);
  writeTree(dir, without(clean, CONTRACT));
  assert.deepEqual(run(['selfcheck', '--dir', dir]), { status: 1, line: 'SELFCHECK FAIL 1 problem(s): 00-READBEFORE.md:1 cannot read 00-READBEFORE.md' });
  fails('no pin line', { ...clean, [CONTRACT]: swap(clean[CONTRACT], /^\*\*Skill\*\*: .*\n/m, '') }, [[CONTRACT, 1, 'skill pin: Missing skill pin line', 'skill']]);
  assert.ok(sameSet([...seen], RULES.selfcheck), 'a failing ledger for every rule: ' + [...seen].join(', '));
  // Every rule at once, reported in rule order.
  const all = { ...setBranch(edit(edit(clean, PROG, '**State**: ACTIVE', '**State**: PAUSED'), PLAN, 'Pre-flight: CLEAN', 'Pre-flight: clean'), INTEGRATION_BRANCH), 'LOG.md': '{{X}}\n',
    [CONTRACT]: swap(clean[CONTRACT], hex, zeros) };
  writeTree(dir, all);
  assert.deepEqual([...new Set(quads(selfcheck(dir)).map(p => p[3]))], RULES.selfcheck);
  assert.match(run(['selfcheck', '--dir', dir]).line, /^SELFCHECK FAIL 6 problem\(s\): LOG\.md:1 an unfilled \{\{ slot; PROGRESS\.md:\d+ must read exactly /);
  // Unreadable input is UNKNOWN: a pinned directory that cannot be hashed, a linked or undecodable file.
  writeTree(dir, { ...clean, [CONTRACT]: contractFile({ SKILL_DIR: path.join(root, 'absent'), SKILL_SHA256: hex }) });
  assert.throws(() => selfcheck(dir), /^Error: cannot read skill directory /);
  assert.match(run(['selfcheck', '--dir', dir]).line, /^UNKNOWN cannot read skill directory /);
  writeTree(dir, { ...clean, 'LOG.md': Buffer.from([0x23, 0xff]) });
  assert.throws(() => selfcheck(dir), /^Error: not UTF-8: .*LOG\.md$/);
  writeTree(dir, clean);
  const restore = linkInPlace(path.join(dir, 'LOG.md'), clean['LOG.md'], tmp(t));
  try { assert.throws(() => selfcheck(dir), /^Error: a link, not an ordinary file: .*LOG\.md$/); } finally { restore(); }
  assert.equal(selfcheck(dir).status, 'OK', 'restored');
});

// ===== plan: waves, disjointness, dependencies, fence paths =================
test('plan: every check over every batch, one failing ledger per check, and each boundary from both sides', async t => {
  const { planCheck, RULES } = await ledgerApi;
  assert.deepEqual(RULES.plan, ['parse', 'wave', 'disjoint', 'depends', 'cycle', 'new-files', 'fence-path']);
  const root = tmp(t), dir = path.join(root, 'ledger');
  const repo = writeTree(path.join(root, 'repo'), { 'a.txt': 'a', 'b.txt': 'b', 'c.txt': 'c', 'd/e.txt': 'e' });
  const one = over => ({ ...BATCHES[0], ...over }), two = over => ({ ...BATCHES[1], ...over });
  const three = over => ({ id: 'B03', title: 'Three', branch: 'feat/three', files: ['d/e.txt'], wave: '1', deps: 'none', ...over });
  const B3 = batchName(three());
  const seen = new Set();
  const planned = (files, want, name) => {
    writeTree(dir, files);
    const result = planCheck(dir, repo), got = quads(result);
    assert.deepEqual(got, typeof want === 'function' ? want(files) : want, name);
    for (const p of got) seen.add(p[3]);
    return result;
  };
  const check = (name, batches, want) => planned(baseLedger(batches), want, name);
  const dependsAt = (f, name) => lineOf(f[name], /^\*\*Depends on\*\*: /), newAt = (f, name) => lineOf(f[name], /^\*\*New files\*\*: /);
  writeTree(dir, baseLedger());
  assert.deepEqual(run(['plan', '--dir', dir, '--repo', repo]), { status: 0, line: 'PLAN OK 2 batches in 1 waves' });
  assert.equal(check('three batches in two waves', [one(), two({ wave: '2', deps: 'B01' }), three({ wave: '2', deps: 'B01' })], []).waves, 2);
  // Parse runs first, and its problems are reported.
  planned(edit(baseLedger(), B1, '**Files**: `a.txt`, `b.txt`', '**Files**: `a.txt`'), f => [[B1, lineOf(f[B1], /^\*\*Files\*\*: /), 'Files line differs from the plan fence', 'parse']], 'parse');
  // Waves: a positive integer in the plan, equal in PROGRESS and the batch file.
  for (const bad of ['0', 'x', '01', '-1', '1.5']) {
    check('plan wave ' + bad, [one(), two({ wave: bad })], f => [[PLAN, row(f, PLAN, 'B02'), `B02 Wave: expected a positive integer, found "${bad}"`, 'wave']]);
  }
  check('a two-digit wave', [one(), two({ wave: '12' })], []);
  check('PROGRESS wave differs', [one(), two({ progressWave: '2' })], f => [[PROG, row(f, PROG, 'B02'), "B02 Wave: 2 differs from the plan's 1", 'wave']]);
  check('PROGRESS wave differs for the first batch', [one({ progressWave: '3' }), two()], f => [[PROG, row(f, PROG), "B01 Wave: 3 differs from the plan's 1", 'wave']]);
  planned(edit(baseLedger(), B2, '**Wave**: 1 ·', '**Wave**: 2 ·'), f => [[B2, lineOf(f[B2], /^\*\*Wave\*\*: /), "Wave 2 differs from the plan's 1", 'wave']], 'batch-file wave differs');
  planned(edit(baseLedger(), B2, /^\*\*Wave\*\*: .*\n/m, ''), [[B2, 1, '0 lines start "**Wave**: ", expected exactly one', 'wave']], 'no batch-file wave');
  // Disjointness: within a wave, every pair; across waves, allowed.
  check('overlap within a wave', [one(), two({ files: ['c.txt', 'b.txt', 'a.txt'] })], f => [[PLAN, row(f, PLAN, 'B02'), 'B01 and B02 are both in wave 1 and both fence `a.txt`, `b.txt`', 'disjoint']]);
  check('overlap between the first and third', [one(), two(), three({ files: ['a.txt'] })], f => [[PLAN, row(f, PLAN, 'B03'), 'B01 and B03 are both in wave 1 and both fence `a.txt`', 'disjoint']]);
  check('overlap across waves', [one(), two({ files: ['c.txt', 'a.txt'], wave: '2', deps: 'B01' })], []);
  // Dependencies: planned, not the batch itself, in an earlier wave; the graph acyclic.
  check('depends on a batch in the same wave', [one(), two({ deps: 'B01' })], f => [[B2, dependsAt(f, B2), "Depends on: B01 is in wave 1, not a wave before B02's 1", 'depends']]);
  check('depends on a batch in a later wave', [one({ deps: 'B02' }), two({ wave: '2' })], f => [[B1, dependsAt(f, B1), "Depends on: B02 is in wave 2, not a wave before B01's 1", 'depends']]);
  check('depends on an earlier wave, in free text', [one(), two({ wave: '2', deps: 'B01 (`🟢`) — wave ordering only' })], []);
  check('an unknown dependency', [one(), two({ deps: 'B07' })], f => [[B2, dependsAt(f, B2), 'Depends on: B07 is not a planned batch', 'depends']]);
  check('a batch depending on itself', [one(), two({ deps: 'B02' })], f => [[B2, dependsAt(f, B2), 'Depends on: B02 depends on itself', 'depends']]);
  for (const bad of ['nothing', 'none yet', 'None', 'B1']) {
    check('Depends on ' + bad, [one(), two({ deps: bad })], f => [[B2, dependsAt(f, B2), 'Depends on: expected batch ids (Bnn) or exactly "none"', 'depends']]);
  }
  planned(edit(baseLedger(), B2, /^(\*\*Depends on\*\*: .*)$/m, '$1\n$1'), f => [[B2, dependsAt(f, B2) + 1, '2 lines start "**Depends on**: ", expected exactly one', 'depends']], 'two Depends lines');
  check('a two-batch cycle', [one({ deps: 'B02' }), two({ wave: '2', deps: 'B01' })], f => [[B1, dependsAt(f, B1), "Depends on: B02 is in wave 2, not a wave before B01's 1", 'depends'],
    [B1, dependsAt(f, B1), 'dependency cycle B01 -> B02 -> B01', 'cycle']]);
  // Entered by the search at a higher id, a cycle is still reported from its lowest.
  check('a cycle entered above its lowest id', [one({ deps: 'B03' }), two({ wave: '2', deps: 'B03' }), three({ wave: '2', deps: 'B02' })], f => [
    [B1, dependsAt(f, B1), "Depends on: B03 is in wave 2, not a wave before B01's 1", 'depends'],
    [B2, dependsAt(f, B2), "Depends on: B03 is in wave 2, not a wave before B02's 2", 'depends'], [B3, dependsAt(f, B3), "Depends on: B02 is in wave 2, not a wave before B03's 2", 'depends'],
    [B2, dependsAt(f, B2), 'dependency cycle B02 -> B03 -> B02', 'cycle']]);
  check('a three-batch cycle, reported once', [one({ deps: 'B03' }), two({ deps: 'B01' }), three({ deps: 'B02' })], f => [
    [B1, dependsAt(f, B1), "Depends on: B03 is in wave 1, not a wave before B01's 1", 'depends'], [B2, dependsAt(f, B2), "Depends on: B01 is in wave 1, not a wave before B02's 1", 'depends'],
    [B3, dependsAt(f, B3), "Depends on: B02 is in wave 1, not a wave before B03's 1", 'depends'], [B1, dependsAt(f, B1), 'dependency cycle B01 -> B03 -> B02 -> B01', 'cycle']]);
  // New files: in the batch's own fence and absent; `none` or exact paths.
  check('marked new, in the fence, absent', [one({ files: ['a.txt', 'new.txt'], newFiles: '`new.txt`' }), two({ newFiles: 'none' })], []);
  check('marked new but existing', [one({ newFiles: '`a.txt`' }), two()], f => [[B1, newAt(f, B1), 'New files: a.txt already exists', 'new-files']]);
  check('marked new, a directory existing', [one({ files: ['a.txt', 'd'], newFiles: '`d`' }), two()], f => [[B1, newAt(f, B1), 'New files: d already exists', 'new-files'],
    [PLAN, row(f, PLAN), 'B01 Files (fence): d is a directory, never a fence path', 'fence-path']]);
  check('marked new outside the fence', [one(), two({ newFiles: '`z.txt`' })], f => [[B2, newAt(f, B2), "New files: z.txt is not in the batch's fence", 'new-files']]);
  check('a malformed New files line', [one(), two({ newFiles: '*.txt' })], f => [[B2, newAt(f, B2), 'New files: Expected unique exact repository-relative backtick paths (globs unsupported)', 'new-files']]);
  planned(edit(baseLedger([one(), two({ newFiles: 'none' })]), B2, /^(\*\*New files\*\*: .*)$/m, '$1\n$1'), f => [[B2, newAt(f, B2) + 1, '2 lines start "**New files**: ", expected at most one', 'new-files']], 'two New files lines');
  // The line stays optional: a batch file written before the template carried it passes.
  planned(edit(baseLedger(), B2, /^\*\*New files\*\*: .*\n/m, ''), [], 'no New files line');
  // Fence paths: existing files, or marked new by exactly one batch that every other fencer follows.
  check('a missing fence path', [one(), two({ files: ['c.txt', 'missing.txt'] })], f => [[PLAN, row(f, PLAN, 'B02'), 'B02 Files (fence): missing.txt does not exist and no batch marks it new', 'fence-path']]);
  check('a missing fence path in the first batch', [one({ files: ['gone/a.txt'] }), two()], f => [[PLAN, row(f, PLAN), 'B01 Files (fence): gone/a.txt does not exist and no batch marks it new', 'fence-path']]);
  check('a directory as a fence path', [one(), two({ files: ['c.txt', 'd'] })], f => [[PLAN, row(f, PLAN, 'B02'), 'B02 Files (fence): d is a directory, never a fence path', 'fence-path']]);
  check('marked in wave 1, fenced unmarked in wave 2', [one({ files: ['a.txt', 'new.txt'], newFiles: '`new.txt`' }), two({ files: ['c.txt', 'new.txt'], wave: '2', deps: 'B01' })], []);
  check('marked and fenced in the same wave', [one({ files: ['a.txt', 'new.txt'], newFiles: '`new.txt`' }), two({ files: ['c.txt', 'new.txt'] })], f => [
    [PLAN, row(f, PLAN, 'B02'), 'B01 and B02 are both in wave 1 and both fence `new.txt`', 'disjoint'],
    [PLAN, row(f, PLAN, 'B02'), 'B02 Files (fence): new.txt is marked new by B01, so B02 must sit in a later wave', 'fence-path']]);
  check('fenced in an earlier wave than it is marked', [one({ files: ['a.txt', 'new.txt'], newFiles: '`new.txt`', wave: '2' }), two({ files: ['c.txt', 'new.txt'] })],
    f => [[PLAN, row(f, PLAN, 'B02'), 'B02 Files (fence): new.txt is marked new by B01, so B02 must sit in a later wave', 'fence-path']]);
  check('marked new by two batches', [one({ files: ['a.txt', 'new.txt'], newFiles: '`new.txt`' }), two({ files: ['c.txt', 'new.txt'], newFiles: '`new.txt`', wave: '2', deps: 'B01' })],
    f => [[PLAN, row(f, PLAN, 'B02'), 'new.txt is marked new by B01 and B02, expected at most one batch', 'fence-path']]);
  assert.ok(sameSet([...seen], RULES.plan), 'a failing ledger for every check: ' + [...seen].join(', '));
  // As published, and unreadable input.
  writeTree(dir, baseLedger([one(), two({ files: ['c.txt', 'a.txt'] })]));
  assert.deepEqual(run(['plan', '--dir', dir, '--repo', repo]).status, 1);
  assert.match(run(['plan', '--dir', dir, '--repo', repo]).line, /^PLAN FAIL 1 problem\(s\): 01-plan\.md:\d+ B01 and B02 are both in wave 1 and both fence `a\.txt`$/);
  assert.throws(() => planCheck(dir, path.join(root, 'absent')), /^Error: cannot read repository /);
  assert.match(run(['plan', '--dir', dir, '--repo', path.join(repo, 'a.txt')]).line, /^UNKNOWN cannot read repository /);
});

// ===== One parser, as a property of the tools directory ======================
// Module-level declarations only: a column-0 function, class, or const/let/var binding.
// Indented locals (git-evidence's and check-fence's `records` arrays) are not parsers.
function moduleLevelNames(source) {
  const names = new Set();
  for (const line of source.split(/\r?\n/)) {
    const fn = /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\s*\*?|class)\s+([A-Za-z_$][\w$]*)/.exec(line);
    if (fn) { names.add(fn[1]); continue; }
    const binding = /^(?:export\s+)?(?:const|let|var)\s+(.*)$/.exec(line);
    if (binding) for (const m of binding[1].matchAll(/(?:^|[\s,{[])([A-Za-z_$][\w$]*)\s*(?==(?!=)|,|}|]|;|$)/g)) names.add(m[1]);
  }
  return names;
}
function parserDefinitions(root, names) {
  const found = [], covered = [];
  const walk = (dir, prefix) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : 1)) {
      const rel = prefix + e.name;
      if (e.isDirectory()) { walk(path.join(dir, e.name), rel + '/'); continue; }
      covered.push(rel);
      const declared = moduleLevelNames(fs.readFileSync(path.join(dir, e.name), 'utf8'));
      for (const name of names) if (declared.has(name)) found.push(rel + ': ' + name);
    }
  };
  walk(root, '');
  return { found, covered };
}

test('one parser: no tool but ledger-parse.mjs defines a ledger parser, and check-fence imports them', async t => {
  // The swept names are the module's own exports, not a list written here; the size is
  // pinned by hand so an export dropped from both sides still goes red.
  const names = Object.keys(await parserApi).sort();
  assert.deepEqual(names, ['branchCell', 'exactPaths', 'extensions', 'gitModel', 'linesOf', 'oneRow', 'records', 'skillPin', 'table']);
  assert.equal(names.length, 9);
  // Live control first: planted definitions in every declaration form, at depth two, beside
  // indented locals that must NOT be reported.
  const control = tmp(t);
  writeTree(control, {
    'rogue.mjs': 'import x from "y";\nfunction table(text, required) {\n  return [];\n}\n',
    'nested/deeper/copy.mjs': 'export const exactPaths = text => [];\nconst first = 1, records = [];\nlet skillPin;\nexport async function oneRow() {}\n',
    'nested/destructured.mjs': 'const { branchCell } = await import("./elsewhere.mjs");\nvar extensions = null\n',
    'locals.mjs': 'function outer() {\n  const records = [];\n  function table() {}\n  let linesOf = 1;\n}\nconst tableRows = 1;\nconst x = table == 1;\n',
  });
  assert.deepEqual(parserDefinitions(control, names), {
    found: ['nested/deeper/copy.mjs: exactPaths', 'nested/deeper/copy.mjs: oneRow', 'nested/deeper/copy.mjs: records', 'nested/deeper/copy.mjs: skillPin',
      'nested/destructured.mjs: branchCell', 'nested/destructured.mjs: extensions', 'rogue.mjs: table'],
    covered: ['locals.mjs', 'nested/deeper/copy.mjs', 'nested/destructured.mjs', 'rogue.mjs'],
  });
  // The real directory, from its own listing.
  const { found, covered } = parserDefinitions(TOOLS, names);
  const listing = fs.readdirSync(TOOLS, { recursive: true }).map(p => p.split(path.sep).join('/')).filter(p => fs.statSync(path.join(TOOLS, p)).isFile()).sort();
  assert.deepEqual(covered.slice().sort(), listing);
  for (const tool of ['check-fence.mjs', 'check-ledger.mjs', 'git-evidence.mjs', 'ledger-parse.mjs']) assert.ok(covered.includes(tool), tool);
  assert.deepEqual(found.filter(f => !f.startsWith('ledger-parse.mjs: ')), [], 'a private parser copy outside ledger-parse.mjs');
  // The detector reads the real module's forms: every export is found where it is defined.
  assert.deepEqual(found.filter(f => f.startsWith('ledger-parse.mjs: ')), names.map(n => 'ledger-parse.mjs: ' + n));
  // check-fence imports exactly the parsers it calls, from the one module.
  const fence = read('orchestrate/tools/check-fence.mjs');
  const imports = [...fence.matchAll(/^import \{([^}]+)\} from '\.\/ledger-parse\.mjs';$/gm)];
  assert.equal(imports.length, 1, 'check-fence.mjs must import the parsers from ./ledger-parse.mjs');
  const imported = imports[0][1].split(',').map(s => s.trim()).sort();
  const called = [...new Set([...fence.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)\(/g)].map(m => m[1]))].filter(n => names.includes(n)).sort();
  assert.deepEqual(imported, called);
  assert.ok(called.length >= 6, 'check-fence reads plan, PROGRESS and batch files through the parsers: ' + called);
});

test('check-fence --help bytes are unchanged by the move', () => {
  const r = spawnSync(process.execPath, [path.join(TOOLS, 'check-fence.mjs'), '--help'], { encoding: 'utf8', windowsHide: true });
  assert.equal(r.status, 0);
  assert.equal(createHash('sha256').update(r.stdout).digest('hex'), '0cf41ad7f57e6e591a6cdeaf8c465753b9954acbd24efcca339ed101ade5803a');
});

// ===== The skill pin ==========================================================
const NUL = Buffer.from([0]);
const bytesOf = v => Buffer.isBuffer(v) ? v : Buffer.from(v, 'utf8');
// Written from the specification, independently of the tool: sorted '/'-paths, NUL, bytes
// with CRLF pairs made LF (a latin1 round trip is byte-exact), NUL.
function specHash(files) {
  const h = createHash('sha256');
  for (const rel of Object.keys(files).sort()) {
    h.update(Buffer.from(rel, 'utf8')); h.update(NUL);
    h.update(Buffer.from(bytesOf(files[rel]).toString('latin1').split('\r\n').join('\n'), 'latin1')); h.update(NUL);
  }
  return h.digest('hex');
}
// Upper before lower case, `-` before `/`, and a non-ASCII name: a locale sort or a
// per-directory sort orders these differently from code units.
const SKILL = {
  'SKILL.md': 'top\nline\n', 'B.md': 'upper\n', 'a.md': 'lower\n', 'a-b.md': 'dash\n', 'a/b.md': 'nested\n',
  'references/runners/deep.md': 'deep\n', 'tools/bin.dat': Buffer.from([0, 13, 10, 13, 255, 10]), 'Ω.md': 'omega\n',
};

test('skill hash: the specified format, deterministic, CRLF-blind, and sensitive to content, names and membership', async t => {
  const { skillHash } = await ledgerApi;
  const root = tmp(t), dir = name => path.join(root, name);
  const base = skillHash(writeTree(dir('lf'), SKILL));
  assert.deepEqual(base, { hex: specHash(SKILL), files: 8 });
  assert.deepEqual(skillHash(dir('lf')), base, 'deterministic across runs');
  // CRLF and LF checkouts of the same content, built explicitly rather than inherited from
  // however this machine checks files out.
  const crlf = Object.fromEntries(Object.entries(SKILL).map(([k, v]) => [k, typeof v === 'string' ? v.replace(/\n/g, '\r\n') : v]));
  assert.notDeepEqual(crlf, SKILL);
  assert.deepEqual(skillHash(writeTree(dir('crlf'), crlf)), base, 'a CRLF checkout must pin the same hash');
  // The other side of the boundary: a lone CR is content, not a line ending.
  assert.notEqual(skillHash(writeTree(dir('cr'), { ...SKILL, 'a.md': 'lower\r' })).hex, base.hex);
  const changed = {
    byte: { ...SKILL, 'references/runners/deep.md': 'deeP\n' },
    name: (({ 'a.md': moved, ...rest }) => ({ ...rest, 'c.md': moved }))(SKILL),
    added: { ...SKILL, 'references/extra.md': '' },
    removed: (({ 'B.md': _, ...rest }) => rest)(SKILL),
    binary: { ...SKILL, 'tools/bin.dat': Buffer.from([0, 13, 10, 13, 254, 10]) },
  };
  for (const [kind, files] of Object.entries(changed)) {
    const h = skillHash(writeTree(dir(kind), files));
    assert.notEqual(h.hex, base.hex, kind); assert.equal(h.hex, specHash(files), kind);
  }
  // Operating-system litter never counts, in any case and at any depth; a near-name does.
  const litter = { ...SKILL, 'Thumbs.db': 'x', '.DS_Store': 'x', 'desktop.ini': 'x', 'references/runners/THUMBS.DB': 'x', 'a/Desktop.INI': 'x', 'tools/.ds_store': 'x' };
  assert.deepEqual(skillHash(writeTree(dir('litter'), litter)), base);
  for (const near of ['Thumbs.db.bak', 'xdesktop.ini', 'references/.DS_Store2']) {
    assert.notEqual(skillHash(writeTree(dir('near'), { ...SKILL, [near]: 'x' })).hex, base.hex, near);
  }
});

test('skill hash follows links, refuses cycles, dangling entries, empty and non-directories', async t => {
  const { skillHash } = await ledgerApi;
  const root = tmp(t), real = writeTree(path.join(root, 'real'), SKILL), base = skillHash(real);
  // The recommended install is a junction into a clone: it pins the clone's hash.
  const link = path.join(root, 'installed');
  fs.symlinkSync(real, link, 'junction');
  assert.deepEqual(skillHash(link), base);
  const cycle = path.join(real, 'references', 'loop');
  fs.symlinkSync(real, cycle, 'junction');
  try { assert.throws(() => skillHash(real), /^Error: directory cycle at references\/loop$/); } finally { fs.unlinkSync(cycle); }
  const gone = writeTree(path.join(root, 'gone'), { 'x.md': 'x' }), dangling = path.join(real, 'dangling');
  fs.symlinkSync(gone, dangling, 'junction'); fs.rmSync(gone, { recursive: true });
  try { assert.throws(() => skillHash(real), /cannot stat dangling/); } finally { fs.unlinkSync(dangling); }
  // Neither a file nor a directory: only POSIX can make one without privileges.
  if (process.platform !== 'win32') {
    const fifo = path.join(real, 'references', 'pipe'), made = spawnSync('mkfifo', [fifo]);
    assert.ifError(made.error); assert.equal(made.status, 0, 'mkfifo must create the fixture');
    try { assert.throws(() => skillHash(real), /^Error: not a regular file or directory: references\/pipe$/); } finally { fs.unlinkSync(fifo); }
  }
  assert.deepEqual(skillHash(real), base, 'the tree is restored after the controls');
  fs.mkdirSync(path.join(root, 'empty'));
  assert.deepEqual(run(['skill', '--dir', path.join(root, 'empty')]).line, 'UNKNOWN no files in skill directory ' + path.join(root, 'empty'));
  assert.match(run(['skill', '--dir', path.join(real, 'a.md')]).line, /^UNKNOWN not a directory: /);
  assert.match(run(['skill', '--dir', path.join(root, 'absent')]).line, /^UNKNOWN cannot read skill directory /);
});

test('skill --contract: exactly the documented line form, and nothing looser', async t => {
  const { skillPin } = await parserApi;
  const root = tmp(t), dir = writeTree(path.join(root, 'skill dir with space'), SKILL), hex = specHash(SKILL);
  const pin = (d, h) => '**Skill**: `' + d + '` · sha256 `' + h + '`';
  const contract = (name, text) => { const p = path.join(root, name); fs.writeFileSync(p, text); return p; };
  const good = contract('good.md', '# Contract\n\n' + pin(dir, hex) + '\n\nText.\n');
  assert.deepEqual(skillPin(fs.readFileSync(good, 'utf8')), { dir, hex });
  assert.deepEqual(run(['skill', '--dir', dir]), { status: 0, line: `SKILL ${hex} 8 files` });
  assert.deepEqual(run(['skill', '--contract', good]), { status: 0, line: `SKILL MATCH ${hex}` });
  assert.deepEqual(run(['skill', '--contract', contract('crlf.md', '# Contract\r\n\r\n' + pin(dir, hex) + '\r\n')]), { status: 0, line: `SKILL MATCH ${hex}` });
  const zeros = '0'.repeat(64);
  assert.deepEqual(run(['skill', '--contract', contract('stale.md', pin(dir, zeros) + '\n')]), { status: 1, line: `SKILL MISMATCH pinned ${zeros} actual ${hex}` });
  // --dir wins over the pinned directory; without it, the pinned directory is read.
  const elsewhere = contract('elsewhere.md', pin(path.join(root, 'absent'), hex) + '\n');
  assert.deepEqual(run(['skill', '--dir', dir, '--contract', elsewhere]), { status: 0, line: `SKILL MATCH ${hex}` });
  assert.match(run(['skill', '--contract', elsewhere]).line, /^UNKNOWN cannot read skill directory /);
  const refused = {
    'Missing skill pin line': ['# Contract\n', 'Skill: `' + dir + '` · sha256 `' + hex + '`\n'],
    'Duplicated skill pin line': [pin(dir, hex) + '\n' + pin(dir, hex) + '\n', pin(dir, hex) + '\n**skill**: `' + dir + '`\n'],
    'Malformed skill pin line': [
      pin(dir, hex.toUpperCase()), pin(dir, hex.slice(1)), pin(dir, hex) + ' ', pin(dir, hex) + ' (upgraded)', pin(dir, hex).replace('·', '.'),
      pin(dir, hex).replace('sha256', 'sha-256'), pin(dir, hex).replace(' · ', ' ·  '), '**Skill**: ' + dir + ' · sha256 `' + hex + '`',
      ' ' + pin(dir, hex), '**Skill**:`' + dir + '` · sha256 `' + hex + '`', pin('', hex), pin(dir, hex) + '\rtrailing',
    ],
  };
  for (const [reason, texts] of Object.entries(refused)) texts.forEach((text, i) => {
    const file = contract('refused.md', text), r = run(['skill', '--contract', file]);
    assert.equal(r.status, 2, reason + ' #' + i + ': ' + r.line);
    assert.equal(r.line, 'UNKNOWN ' + reason + ' in ' + file, reason + ' #' + i);
    assert.throws(() => skillPin(text), new RegExp('^Error: ' + reason + '$'), reason + ' #' + i);
  });
  assert.match(run(['skill', '--contract', path.join(root, 'absent.md')]).line, /^UNKNOWN cannot read /);
});

// ===== cites: pinned citations against a repository ========================
test('cites: every pinned citation checked, each failure from both sides, fenced blocks skipped, unpinned spans listed', async t => {
  const { cites, ledgerCli } = await ledgerApi;
  const root = tmp(t), dir = path.join(root, 'ledger');
  const repo = writeTree(path.join(root, 'repo'), { 'src/a.mjs': 'one\nexport function alpha() {}\nthree\nconst beta = 1;\nfive\n', 'src/crlf.txt': 'a\r\nb\r\n', 'src/d/x.txt': 'x\n' });
  const c = (p, s) => '`' + p + '` `' + s + '`';
  const planLines = [
    '# Plan',
    'Holds: ' + c('src/a.mjs:2', 'alpha') + ' and ' + c('src/a.mjs:3-4', 'beta') + ', its first line: ' + c('src/a.mjs:2-3', 'alpha') + '.',
    'The last line: ' + c('src/a.mjs:5', 'five') + ', a CRLF file: ' + c('src/crlf.txt:2', 'b') + ', a spaced span: `` src/a.mjs:1 `` `` one ``.',
    'Missing: ' + c('src/none.mjs:1', 'x') + ', a directory: ' + c('src/d:1', 'x'),
    'Past the end: ' + c('src/a.mjs:6', 'five') + ' and ' + c('src/a.mjs:4-6', 'beta') + ' and ' + c('src/crlf.txt:3', 'b'),
    'Absent: ' + c('src/a.mjs:2', 'beta') + ' and ' + c('src/a.mjs:3-4', 'alpha') + ' and ' + c('src/a.mjs:5', 'three'),
    // The symbol one line below the range, and a symbol span spaced on one side, which keeps its space.
    'Just after: ' + c('src/a.mjs:3', 'beta') + ' and ' + c('src/a.mjs:2-3', 'beta') + ' and ' + c('src/a.mjs:1', ' one'),
    'Not a range: ' + c('src/a.mjs:0', 'one') + ' and ' + c('src/a.mjs:4-3', 'beta'),
    '```md', c('src/none.mjs:1', 'fenced'), '```', '~~~', c('src/none.mjs:2', 'tilde'), '~~~',
    'Unpinned: `src/a.mjs:2` alone, `src/a.mjs:2`  `alpha` two spaces, `src/a.mjs:3`,`beta` no space, `C:/x.txt:4` `y` a drive path, `src\\a.mjs:1` `one` a backslash path.',
    'Not citations: `src/a.mjs` `alpha`, `a b:1` `x`, `src/a.mjs:x` `y`, `:1` `z`.',
  ];
  const clean = {
    [PLAN]: '# Plan\n\n' + c('src/a.mjs:2', 'alpha') + ' then `src/a.mjs:1` unpinned\n',
    '02-batches-01-one.md': '# B01 — One\n' + c('src/a.mjs:3-4', 'beta') + '\n',
    'LOG.md': c('src/none.mjs:1', 'log') + '\n', 'PROGRESS.md': c('src/none.mjs:1', 'progress') + '\n', '00-request.md': c('src/none.mjs:1', 'request') + '\n',
    'nested/02-batches-02-two.md': c('src/none.mjs:1', 'nested') + '\n',
  };
  // Only the plan and the batch files directly in the directory are read.
  writeTree(dir, clean);
  assert.deepEqual(cites(dir, repo), { status: 'OK', pinned: 2, unpinned: [{ file: PLAN, line: 3, span: '`src/a.mjs:1`' }], problems: [] });
  assert.deepEqual(run(['cites', '--dir', dir, '--repo', repo]), { status: 0, line: 'CITES OK 2 pinned, 1 unpinned: 01-plan.md:3 `src/a.mjs:1`' });
  writeTree(dir, { ...clean, [PLAN]: '# Plan\n\n' + c('src/a.mjs:2', 'alpha') + '\n' });
  assert.deepEqual(ledgerCli(['cites', '--dir', dir, '--repo', repo]), { code: 0, line: 'CITES OK 2 pinned, 0 unpinned' });
  writeTree(dir, { ...clean, [PLAN]: planLines.join('\n') + '\n' });
  const r = cites(dir, repo), cite = (p, s) => c(p, s);
  assert.equal(r.status, 'FAIL');
  assert.equal(r.pinned, 20, 'each pinned citation outside a fence, the batch file\'s included, and none inside one');
  assert.deepEqual(r.problems.map(p => [p.file, p.line, p.message]), [
    [PLAN, 4, cite('src/none.mjs:1', 'x') + ' names no file under the repository'],
    [PLAN, 4, cite('src/d:1', 'x') + ' names no file under the repository'],
    [PLAN, 5, cite('src/a.mjs:6', 'five') + ' is past the end of the file (5 lines)'],
    [PLAN, 5, cite('src/a.mjs:4-6', 'beta') + ' is past the end of the file (5 lines)'],
    [PLAN, 5, cite('src/crlf.txt:3', 'b') + ' is past the end of the file (2 lines)'],
    [PLAN, 6, cite('src/a.mjs:2', 'beta') + ' does not hold the symbol'],
    [PLAN, 6, cite('src/a.mjs:3-4', 'alpha') + ' does not hold the symbol'],
    [PLAN, 6, cite('src/a.mjs:5', 'three') + ' does not hold the symbol'],
    [PLAN, 7, cite('src/a.mjs:3', 'beta') + ' does not hold the symbol'],
    [PLAN, 7, cite('src/a.mjs:2-3', 'beta') + ' does not hold the symbol'],
    [PLAN, 7, cite('src/a.mjs:1', ' one') + ' does not hold the symbol'],
    [PLAN, 8, cite('src/a.mjs:0', 'one') + ' is not a line range'],
    [PLAN, 8, cite('src/a.mjs:4-3', 'beta') + ' is not a line range'],
  ]);
  assert.deepEqual(r.unpinned, ['`src/a.mjs:2`', '`src/a.mjs:2`', '`src/a.mjs:3`', '`C:/x.txt:4`', '`src\\a.mjs:1`'].map(span => ({ file: PLAN, line: 15, span })));
  const failed = run(['cites', '--dir', dir, '--repo', repo]);
  assert.equal(failed.status, 1);
  assert.equal(failed.line, 'CITES FAIL 13 problem(s): ' + r.problems.slice(0, 10).map(p => `${p.file}:${p.line} ${p.message}`).join('; ') + ' (+3 more)');
  // The problem cap and the unpinned cap, each from both sides.
  const many = n => ({ [PLAN]: Array.from({ length: n }, () => '`src/a.mjs:1`').join(', ') + '\n' });
  writeTree(dir, many(10));
  assert.ok(!ledgerCli(['cites', '--dir', dir, '--repo', repo]).line.includes('more'));
  writeTree(dir, many(11));
  assert.match(ledgerCli(['cites', '--dir', dir, '--repo', repo]).line, /^CITES OK 0 pinned, 11 unpinned: (?:01-plan\.md:1 `src\/a\.mjs:1`; ){9}01-plan\.md:1 `src\/a\.mjs:1` \(\+1 more\)$/);
  writeTree(dir, { [PLAN]: Array.from({ length: 11 }, () => c('src/none.mjs:1', 'x')).join(' ') + '\n' });
  assert.match(ledgerCli(['cites', '--dir', dir, '--repo', repo]).line, /^CITES FAIL 11 problem\(s\): .* \(\+1 more\)$/);
  // Unreadable input is UNKNOWN: no plan, no ledger directory, no repository, a file for one.
  writeTree(dir, { '02-batches-01-one.md': '# B01\n' });
  assert.match(run(['cites', '--dir', dir, '--repo', repo]).line, /^UNKNOWN cannot read .*01-plan\.md$/);
  assert.match(run(['cites', '--dir', path.join(root, 'absent'), '--repo', repo]).line, /^UNKNOWN cannot read ledger directory /);
  writeTree(dir, clean);
  assert.deepEqual(run(['cites', '--dir', dir, '--repo', path.join(root, 'absent')]), { status: 2, line: 'UNKNOWN cannot read repository ' + path.join(root, 'absent') });
  const notRoot = path.join(repo, 'src', 'a.mjs');
  assert.deepEqual(run(['cites', '--dir', dir, '--repo', notRoot]), { status: 2, line: 'UNKNOWN cannot read repository ' + notRoot });
});

// ===== census: references to fenced paths from outside every fence ========
test('census: path, import and basename references outside every fence and .agents/, strongest first, and --batch', async t => {
  const { census, ledgerCli, KINDS } = await ledgerApi;
  assert.deepEqual(KINDS, ['path', 'import', 'basename']);
  const repo = makeRepo(t);
  repo.git('config', 'maintenance.auto', 'false'); repo.git('config', 'gc.auto', '0');
  // B03 fences one file per specifier resolution Node tries beyond the exact path and `.mjs`.
  const PKG = ['pkg/a.js', 'pkg/b.cjs', 'pkg/c.json', 'pkg/d/index.js', 'pkg/e/index.mjs', 'pkg/f/index.cjs'];
  const ledger = baseLedger([{ ...BATCHES[0], files: ['lib/core.mjs', 'tests/core.test.cjs'] }, { ...BATCHES[1], files: ['lib/extra.mjs'] },
    { id: 'B03', title: 'Three', branch: 'feat/three', files: PKG, wave: '1', deps: 'none' }]);
  for (const [name, text] of Object.entries(ledger)) repo.write(LEDGER + '/' + name, text);
  const files = {
    'lib/core.mjs': 'export const core = 1;\n',
    // Inside a fence: never reported, for its own batch or another.
    'lib/extra.mjs': "import { core } from './core.mjs';\n",
    'tests/core.test.cjs': "require('../lib/core.mjs'); require('../lib/extra.mjs'); // lib/core.mjs\n",
    ...Object.fromEntries(PKG.map(p => [p, '{}\n'])),
    'docs/guide.md': 'See lib/core.mjs and ../lib/core.mjs.\n',
    'tests/other.test.cjs': "const c = require('../lib/core.mjs');\n",
    'tests/ext.test.cjs': "const e = import(\"../lib/extra\");\n",
    // Same-directory specifiers, with and without an extension.
    'lib/sib.mjs': "import './core.mjs';\n",
    'lib/user.mjs': "import './core';\n",
    // Every other resolution, one specifier each.
    'docs/pkg.cjs': ['a', 'b', 'c', 'd', 'e', 'f'].map(x => `require('../pkg/${x}');`).join('\n') + '\n',
    'notes.txt': 'Read core.mjs.\n',
    'tests/wrong.test.cjs': "require('./lib/core.mjs');\n",
    // A decoy first, then the real mention.
    'docs/later.md': 'xcore.mjs, then core.mjs\n',
    'docs/later-path.md': 'mylib/core.mjs then lib/core.mjs\n',
    'misc/decoy.md': 'mylib/core.mjs.bak, xcore.mjs, core.mjsx, lib/core.mjs-old, core-mjs, core.mjs/extra, lib/core.mjs/x, "./core" from the root\n',
    '.agents/other.md': 'lib/core.mjs core.mjs\n',
  };
  for (const [name, text] of Object.entries(files)) repo.write(name, text);
  repo.commit('fixture');
  repo.write('untracked.md', 'lib/core.mjs\n');
  const dir = path.join(repo.cwd, ...LEDGER.split('/'));
  const quad = r => r.references.map(x => [x.batch, x.path, x.file, x.kind]);
  const all = [
    ['B01', 'lib/core.mjs', 'docs/guide.md', 'path'],
    ['B01', 'lib/core.mjs', 'docs/later-path.md', 'path'],
    ['B01', 'lib/core.mjs', 'lib/sib.mjs', 'import'],
    ['B01', 'lib/core.mjs', 'lib/user.mjs', 'import'],
    ['B01', 'lib/core.mjs', 'tests/other.test.cjs', 'import'],
    ['B02', 'lib/extra.mjs', 'tests/ext.test.cjs', 'import'],
    ...PKG.map(p => ['B03', p, 'docs/pkg.cjs', 'import']),
    ['B01', 'lib/core.mjs', 'docs/later.md', 'basename'],
    ['B01', 'lib/core.mjs', 'notes.txt', 'basename'],
    ['B01', 'lib/core.mjs', 'tests/wrong.test.cjs', 'basename'],
  ];
  assert.deepEqual(quad(census(dir, repo.cwd)), all);
  // The subject is every tracked file outside every fence and .agents/, and nothing else.
  assert.equal(census(dir, repo.cwd).files, 11);
  assert.deepEqual(quad(census(dir, repo.cwd, 'B02')), [['B02', 'lib/extra.mjs', 'tests/ext.test.cjs', 'import']]);
  const line = ledgerCli(['census', '--dir', dir, '--repo', repo.cwd]).line;
  assert.equal(line, 'CENSUS 15 reference(s) outside every fence: ' + all.slice(0, 10).map(([b, p, f, k]) => `${b} ${p} ← ${f} (${k})`).join('; ') + ' (+5 more)');
  const cli = spawnSync(process.execPath, [TOOL, 'census', '--dir', dir, '--repo', repo.cwd, '--batch', 'B02'], { encoding: 'utf8', env: repo.env, windowsHide: true });
  assert.deepEqual([cli.status, cli.stdout], [0, 'CENSUS 1 reference(s) outside every fence: B02 lib/extra.mjs ← tests/ext.test.cjs (import)\n']);
  // A tracked file gone from the working tree is read as nothing.
  fs.rmSync(path.join(repo.cwd, 'tests', 'ext.test.cjs'));
  assert.deepEqual(ledgerCli(['census', '--dir', dir, '--repo', repo.cwd, '--batch', 'B02']), { code: 0, line: 'CENSUS 0 references outside every fence' });
  // The cap from both sides: ten references shown whole, eleven with the rest counted. A file
  // counts once git tracks it.
  for (let i = 0; i < 10; i++) repo.write(`more/m${i}.md`, 'lib/extra.mjs\n');
  assert.deepEqual(ledgerCli(['census', '--dir', dir, '--repo', repo.cwd, '--batch', 'B02']), { code: 0, line: 'CENSUS 0 references outside every fence' }, 'untracked until added');
  repo.git('add', 'more');
  assert.match(ledgerCli(['census', '--dir', dir, '--repo', repo.cwd, '--batch', 'B02']).line, /^CENSUS 10 reference\(s\) outside every fence: (?:[^;]+; ){9}[^;(]+\(path\)$/);
  repo.write('more/m10.md', 'lib/extra.mjs\n'); repo.git('add', 'more');
  assert.match(ledgerCli(['census', '--dir', dir, '--repo', repo.cwd, '--batch', 'B02']).line, /^CENSUS 11 reference\(s\) outside every fence: (?:[^;]+; ){9}[^;]+ \(\+1 more\)$/);
  // UNKNOWN: an unplanned batch, a subdirectory, a directory that is no repository, no plan.
  assert.deepEqual(ledgerCli(['census', '--dir', dir, '--repo', repo.cwd, '--batch', 'B09']), { code: 2, line: 'UNKNOWN B09 is not a planned batch' });
  assert.deepEqual(ledgerCli(['census', '--dir', dir, '--repo', path.join(repo.cwd, 'lib')]), { code: 2, line: 'UNKNOWN not the root of its repository: ' + path.join(repo.cwd, 'lib') });
  const plain = tmp(t);
  assert.deepEqual(ledgerCli(['census', '--dir', dir, '--repo', plain]), { code: 2, line: 'UNKNOWN cannot list the tracked files of ' + plain });
  assert.match(ledgerCli(['census', '--dir', plain, '--repo', repo.cwd]).line, /^UNKNOWN cannot read .*01-plan\.md$/);
  writeTree(plain, { [PLAN]: '# Plan\n' });
  assert.match(ledgerCli(['census', '--dir', plain, '--repo', repo.cwd]).line, /^UNKNOWN 01-plan\.md batch table: /);
});

test('flags, --help and one-line output in every case', async () => {
  const help = run(['--help']);
  assert.equal(help.status, 0); assert.match(help.line, /^check-ledger\.mjs parse --dir <ledger-dir> \| skill /);
  // HELP names every operation and its flags.
  for (const part of ['| selfcheck --dir <ledger-dir>', '| plan --dir <ledger-dir> --repo <root>', 'SELFCHECK OK', 'SELFCHECK FAIL', 'PLAN OK', 'PLAN FAIL',
    '| cites --dir <ledger-dir> --repo <root>', '| census --dir <ledger-dir> --repo <root> [--batch <Bnn>]', 'CITES OK', 'CITES FAIL', 'CENSUS']) assert.ok(help.line.includes(part), part);
  const invalid = [[], ['bogus'], ['parse'], ['parse', '--dir'], ['parse', '--dir', 'a', '--dir', 'b'], ['parse', '--contract', 'x'],
    ['skill'], ['skill', '--bogus', 'x'], ['skill', '--dir', '--contract'], ['--help', 'parse'], ['parse', '--help'],
    ['selfcheck'], ['selfcheck', '--dir', 'x', '--bogus', 'y'], ['selfcheck', '--repo', 'x'], ['selfcheck', '--dir', 'x', '--dir', 'y'], ['--help', 'selfcheck'],
    ['plan', '--dir', 'x'], ['plan', '--repo', '.'], ['plan', '--dir', 'x', '--repo'], ['plan', '--dir', 'x', '--repo', '.', '--contract', 'y'], ['plan', '--help'],
    ['cites', '--dir', 'x'], ['cites', '--repo', '.'], ['cites', '--dir', 'x', '--repo', '.', '--batch', 'B01'], ['cites', '--help'],
    ['census', '--dir', 'x'], ['census', '--repo', '.'], ['census', '--dir', 'x', '--repo', '.', '--batch'], ['census', '--dir', 'x', '--repo', '.', '--batch', 'B01', '--batch', 'B02'], ['--help', 'census']];
  for (const args of invalid) {
    assert.deepEqual(run(args), { status: 2, line: 'UNKNOWN usage: unknown operation, or an unknown, missing or duplicate flag; use --help' }, JSON.stringify(args));
  }
  // Whatever a path or message holds, the output stays one line: a newline and a C1 byte in
  // the argument reach the printed reason, which run() holds to one line.
  const { oneLine } = await ledgerApi, c = String.fromCharCode;
  assert.deepEqual(run(['parse', '--dir', 'absent' + c(10) + 'dir' + c(0x85)]), { status: 2, line: 'UNKNOWN cannot read ledger directory absent?dir?' });
  assert.equal(oneLine('a' + c(10) + 'b' + c(13) + 'c' + c(0) + c(0x85) + c(0x2028) + c(0x2029) + c(9) + c(0x7f) + ' ·—Ω'), 'a?b?c?????? ·—Ω');
});
