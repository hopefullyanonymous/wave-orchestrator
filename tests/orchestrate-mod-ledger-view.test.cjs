'use strict';
// orchestrate-mod/tools/ledger-view.mjs: one JSON view of a repository's live ledgers. Its line readers and
// derived fields run in-process on written input; fixture repositories from makeRepo run the whole view
// in-process, with the checkout's own orchestrate/ as both --skill-dir and the pinned skill, so the view is
// always read with the parser and reconcile it ships beside; the CLI runs as published a few times.
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');
const { makeRepo } = require('./support/git-fixture.cjs');

const ROOT = path.resolve(__dirname, '..');
const SKILL = path.join(ROOT, 'orchestrate');
const TOOL = path.join(ROOT, 'orchestrate-mod', 'tools', 'ledger-view.mjs');
const api = import(pathToFileURL(TOOL).href);
const parser = import(pathToFileURL(path.join(SKILL, 'tools', 'ledger-parse.mjs')).href);
const reconcile = import(pathToFileURL(path.join(SKILL, 'tools', 'reconcile.mjs')).href);
const evidence = import(pathToFileURL(path.join(SKILL, 'tools', 'git-evidence.mjs')).href);
const PROTOCOL = fs.readFileSync(path.join(SKILL, 'references', 'protocol.md'), 'utf8');
const ESC = String.fromCharCode(27);
const plain = text => text.replace(new RegExp(`${ESC}\\[[0-?]*[ -/]*[@-~]`, 'g'), '');
const slash = text => text.replace(/\\/g, '/');
const withoutTestContext = env => Object.fromEntries(Object.entries(env).filter(([key]) => key.toUpperCase() !== 'NODE_TEST_CONTEXT'));
const NOTES_ERROR = 'notes: a round marker is not in its recorded form';
const BLANK = { state: null, integration: null, skillDir: null, waves: null, currentWave: null, nextCheckpoint: null, rows: [], checkpoints: [], error: null, warning: null };

// ===== Ledger text in the shapes tests/reconcile.test.cjs writes, plus the skill pin and a plan ===========
const HEX = 'ab'.repeat(32);
const contract = (integration, skill = SKILL) => `# Contract\n\n**Change**: fixture\n**Skill**: \`${skill}\` · sha256 \`${HEX}\`\n\n## Git model\n\n`
  + `- Default branch (protected local ref): \`refs/heads/main\`. Integration branch: \`${integration}\` — the ledger branch.\n`
  + '- Shipment source: `local`. Shipment ref: `refs/heads/main` — the target.\n\n## Other\n';
// A Markdown table of `columns`, each record keyed by column; `omit` drops columns, as a ledger lacking them would.
const tableOf = (columns, records, omit = []) => {
  const kept = columns.filter(c => !omit.includes(c));
  return [`| ${kept.join(' | ')} |`, `|${kept.map(() => '---').join('|')}|`, ...records.map(r => `| ${kept.map(c => r[c]).join(' | ')} |`)].join('\n');
};
const progress = (rows, checkpoints = [['C1', '1', '⬜']], state = 'ACTIVE', omit = {}) => `# Progress\n\n**State**: ${state}\n\n## Batches\n\n`
  + tableOf(['#', 'Batch', 'Branch', 'Wave', 'Version', 'Status', 'Updated', 'Notes'],
    rows.map(r => ({ '#': r.id, Batch: r.title, Branch: `\`${r.branch}\``, Wave: r.wave, Version: '—', Status: r.status, Updated: '2026-10-08', Notes: r.notes ?? '—' })), omit.batches)
  + '\n\n## Checkpoints\n\n'
  + tableOf(['Checkpoint', 'After wave', 'Covers', 'Why here', 'Status', 'Verdict'],
    checkpoints.map(([id, wave, status]) => ({ Checkpoint: id, 'After wave': wave, Covers: 'all', 'Why here': 'final', Status: status, Verdict: '—' })), omit.checkpoints)
  + '\n\n## Session log\n\n| Date | Did | Stopped |\n|---|---|---|\n';
const plan = (rows, omit = []) => `# Plan\n\n${tableOf(['#', 'Batch', 'Type', 'Weight', 'Branch', 'Wave'],
  rows.map(r => ({ '#': r.id, Batch: r.title, Type: 'feature', Weight: r.weight, Branch: `\`${r.branch}\``, Wave: r.wave })), omit)}\n`;
const ROW = (id, status, over = {}) => ({ id, title: `work ${id}`, branch: `feat/${id.toLowerCase()}`, wave: 1, weight: 'M', status, ...over });
const files = (integration, rows, { skill, checkpoints, state } = {}) => ({ '00-READBEFORE.md': contract(integration, skill), 'PROGRESS.md': progress(rows, checkpoints, state), '01-plan.md': plan(rows) });
// A row as the view prints it before reconcile's verdict is joined.
const viewRow = (r, over = {}) => ({ id: r.id, title: r.title, branch: r.branch, wave: r.wave, weight: r.weight, status: r.status, round: null, roundError: null, git: null, ...over });

function fixture(t) {
  const repo = makeRepo(t);
  repo.git('config', 'maintenance.auto', 'false'); repo.git('config', 'gc.auto', '0');
  return repo;
}
function writeLedger(at, id, texts) { for (const [name, text] of Object.entries(texts)) at.write(`.agents/changes/${id}/${name}`, text); }
// A ledger committed on a new branch cut from main, the main checkout left on main.
function onBranch(repo, branch, id, texts) {
  repo.git('checkout', '-q', '-b', branch, 'main');
  writeLedger(repo, id, texts); repo.commit(`${id} on ${branch}`);
  repo.git('checkout', '-q', 'main');
}
function tempDir(t) {
  const temp = fs.realpathSync(os.tmpdir()), dir = fs.mkdtempSync(path.join(temp, 'ledger-view-'));
  t.after(() => { assert.equal(path.dirname(dir), temp); fs.rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }); });
  return dir;
}
// A skill directory holding the given tools, each module source written as given.
function skillDir(dir, tools) {
  fs.mkdirSync(path.join(dir, 'tools'), { recursive: true });
  for (const [name, text] of Object.entries(tools)) fs.writeFileSync(path.join(dir, 'tools', name), text);
  return dir;
}
const realTool = name => JSON.stringify(pathToFileURL(path.join(SKILL, 'tools', name)).href);
// The refs and the main checkout's status: what a read-only run must leave as it found them.
const observe = repo => ({ refs: repo.git('for-each-ref'), status: repo.git('status', '--porcelain', '--untracked-files=all') });
async function view(repo, options = {}) {
  const { ledgerView } = await api, before = observe(repo);
  const out = await ledgerView({ repo: repo.cwd, skillDir: SKILL, env: withoutTestContext(repo.env), ...options });
  assert.deepEqual(observe(repo), before, 'a view changes no ref and no status');
  return out;
}
function cli(args, cwd, env) {
  const r = spawnSync(process.execPath, [TOOL, ...args], { cwd, env: withoutTestContext(env), encoding: 'utf8', shell: false, windowsHide: true, timeout: 120000 });
  assert.ifError(r.error); assert.equal(r.signal, null);
  const out = plain(r.stdout);
  return { status: r.status, out, lines: out.replace(/\n$/, '').split('\n') };
}
// protocol.md §Recovery's Verdict cells, read here by the checkout's parser.
async function verdicts() { return (await parser).table(PROTOCOL, ['Ledger says', 'Git shows', 'Verdict']).map(r => r.Verdict.replace(/\s+/g, ' ').trim()); }

// ===== Line readers and derived fields, in-process ========================================================
test('discovery lines: a routed or State-differs ledger names its contract source, every other ledger line is an error entry, none lines are skipped', async () => {
  const { readDiscovery } = await api;
  const lines = [
    'INCOMPLETE 1 diagnostic(s): worktree-unavailable',
    'L-A State=ACTIVE at int → continue',
    'L-B State=AT-CHECKPOINT C1 at int, main, /w/a/.agents/changes/L-B/PROGRESS.md → close',
    'L-C State=USER-BLOCKED at main, origin/main → status',
    'L-D State=none at other → status',
    'L-E at main, other → AMBIGUOUS (State differs: main=ACTIVE, other=COMPLETE)',
    'L-F State=ACTIVE at main → AMBIGUOUS (archived at local refs/heads/main; not proven older: main=ACTIVE)',
    'L-G State=DONE at main → UNKNOWN (State DONE is in no accepted form)',
    'L-H State=COMPLETE at main → none',
    'L-I State=archived at local refs/heads/main → none (older copies: main=COMPLETE)',
    'L-J State=ACTIVE at main → onward',
    'L-K State=ACTIVE → continue',
    'L-L state=ACTIVE at main → continue',
    'L-M State=ACTIVE at /w/a/.agents/changes/L-M/notes.md → continue',
    'a stray line',
    'L-N at main → AMBIGUOUS (archived at main; not proven committed: main)',
    'L-O at main, /w/a, b/.agents/changes/L-O/PROGRESS.md → AMBIGUOUS (State differs: main=ACTIVE, /w/a, b/.agents/changes/L-O/PROGRESS.md=COMPLETE)',
    'L-P State=ACTIVE at  → continue',
  ];
  const errorOf = i => ({ id: lines[i].split(' ')[0], error: lines[i] });
  const routed = (i, source, branches, warning = null) => ({ id: lines[i].split(' ')[0], source, branches, warning, line: lines[i] });
  assert.deepEqual(readDiscovery(lines.join('\n') + '\n'), { recognised: true, incomplete: true, ledgers: [
    routed(1, { branch: 'int' }, ['int']),
    routed(2, { file: '/w/a/.agents/changes/L-B/00-READBEFORE.md' }, ['int', 'main']),
    routed(3, { branch: 'main' }, ['main', 'origin/main']),
    routed(4, { branch: 'other' }, ['other']),
    routed(5, { branch: 'main' }, ['main', 'other'], 'AMBIGUOUS (State differs: main=ACTIVE, other=COMPLETE)'),
    ...[6, 7, 10, 11, 12, 13, 14, 15].map(errorOf),
    routed(16, { file: '/w/a, b/.agents/changes/L-O/00-READBEFORE.md' }, ['main'], 'AMBIGUOUS (State differs: main=ACTIVE, /w/a, b/.agents/changes/L-O/PROGRESS.md=COMPLETE)'),
    errorOf(17),
  ] });
  assert.deepEqual(readDiscovery('NO LEDGERS\n'), { recognised: true, incomplete: false, ledgers: [] });
  assert.deepEqual(readDiscovery('INCOMPLETE 2 diagnostic(s): a, b\nNO LEDGERS\n'), { recognised: true, incomplete: true, ledgers: [] });
  assert.equal(readDiscovery('').recognised, false, 'no output is no discovery run');
  assert.equal(readDiscovery('UNKNOWN usage: unknown operation\n').recognised, false, 'a line in no discovery form is no discovery run');
});

test('a working-tree location reads alike in every platform spelling, and an error\'s paths use forward slashes', async () => {
  const { readDiscovery, slashed } = await api;
  // One location in Node's POSIX spelling, Node's Windows spelling and git's Windows spelling, each holding ", ".
  const spellings = [
    ['/w/x, y/.agents/changes/L/PROGRESS.md', '/w/x, y/.agents/changes/L/00-READBEFORE.md'],
    ['C:\\w\\x, y\\.agents\\changes\\L\\PROGRESS.md', 'C:\\w\\x, y\\.agents\\changes\\L\\00-READBEFORE.md'],
    ['C:/w/x, y/.agents/changes/L/PROGRESS.md', 'C:/w/x, y/.agents/changes/L/00-READBEFORE.md'],
  ];
  for (const [location, contractFile] of spellings) {
    const line = `L State=ACTIVE at feat/l, ${location}, ${location.replace('x, y', 'z')} → continue`;
    assert.deepEqual(readDiscovery(line).ledgers, [{ id: 'L', source: { file: contractFile }, branches: ['feat/l'], warning: null, line }], location);
  }
  assert.equal(slashed(spellings[1][1]), spellings[2][1], 'Node\'s Windows spelling, slashed, is git\'s');
  const differs = 'L at main, C:\\w\\.agents\\changes\\L\\PROGRESS.md → AMBIGUOUS (State differs: main=ACTIVE, C:\\w\\.agents\\changes\\L\\PROGRESS.md=COMPLETE)';
  assert.deepEqual(readDiscovery(differs).ledgers, [{ id: 'L', source: { file: 'C:\\w\\.agents\\changes\\L\\00-READBEFORE.md' }, branches: ['main'],
    warning: 'AMBIGUOUS (State differs: main=ACTIVE, C:/w/.agents/changes/L/PROGRESS.md=COMPLETE)', line: differs }]);
  const archived = 'L at C:\\w\\.agents\\changes\\L\\PROGRESS.md → AMBIGUOUS (archived at local refs/heads/main; not proven older: C:\\w\\.agents\\changes\\L\\PROGRESS.md=ACTIVE)';
  assert.deepEqual(readDiscovery(archived).ledgers, [{ id: 'L', error: 'L at C:/w/.agents/changes/L/PROGRESS.md → AMBIGUOUS (archived at local refs/heads/main; not proven older: C:/w/.agents/changes/L/PROGRESS.md=ACTIVE)' }]);
  assert.deepEqual(readDiscovery('C:\\w stray').ledgers, [{ id: 'C:\\w', error: 'C:/w stray' }], 'a line with no arrow');
});

test('rows lines attach after their row\'s own label, whatever its status holds; the header must name the tip the tables were read at', async () => {
  const { attachVerdicts } = await api;
  const tip = { id: 'L', sha: 'abc1234'.padEnd(40, '0'), branch: 'int' }, HEAD = 'RECONCILE L @abc1234 shipment=not-needed';
  const statuses = ['🔄 In Progress', '✅', '❌ (fix-up capped)', '⛔ green, residual finding open', '❌', '⛔ waits on B03\'s row', '⛔ external: row 3: upstream fix',
    '⛔ UNKNOWN owner', '⛔ two  spaces\tand a tab', `⛔ held${String.fromCharCode(1)}up`, `⛔ next${String.fromCharCode(0x85)}line`];
  const rows = statuses.map((status, i) => ({ id: `B${String(i + 1).padStart(2, '0')}`, status, git: null }));
  // Each label as reconcile prints it: whitespace runs collapsed, an invisible code point (C0, and C1's
  // U+0085, which no whitespace run collapses) as `?`.
  const text = [HEAD,
    'B01 🔄 In Progress row 10: Implementer never landed',
    'B03 ❌ (fix-up capped) row 24: Ask the user: a verdict, with: colons',
    'B04 ⛔ green, residual finding open UNKNOWN dirty: a worktree status cannot be read',
    'B05 ❌ row 22 or 23: tip green → A | tip red → B',
    'B06 ⛔ waits on B03\'s row row 24: V',
    'B07 ⛔ external: row 3: upstream fix row 24: V',
    'B08 ⛔ UNKNOWN owner row 24: V',
    'B09 ⛔ two spaces and a tab UNKNOWN round: R1 SHIP row 3 is gone',
    'B10 ⛔ held?up row 12: a Verdict naming UNKNOWN facts',
    'B11 ⛔ next?line row 24: V',
    'PRUNE /tmp/wt-B01, /tmp/a row 2'].join('\n') + '\n';
  assert.deepEqual(attachVerdicts(rows, text, tip).rows.map(r => r.git), [
    { row: '10', verdict: 'Implementer never landed' }, null, { row: '24', verdict: 'Ask the user: a verdict, with: colons' },
    { unknown: 'dirty: a worktree status cannot be read' }, { row: '22 or 23', verdict: 'tip green → A | tip red → B' },
    { row: '24', verdict: 'V' }, { row: '24', verdict: 'V' }, { row: '24', verdict: 'V' },
    { unknown: 'round: R1 SHIP row 3 is gone' }, { row: '12', verdict: 'a Verdict naming UNKNOWN facts' }, { row: '24', verdict: 'V' }]);
  const unplaced = line => ({ error: `UNKNOWN rows printed a line this view cannot place: ${line}` });
  const after = (...lines) => [HEAD, ...lines].join('\n') + '\n';
  for (const line of ['B99 🔄 row 10: a row PROGRESS lacks', 'B01 🔄 In Progress waits', 'B01 🔄 In Progress row ten: V', 'B01 🔄 In Progress row 10 V',
    'B01 🔄 In Progress row 10x: V', 'B01 🔄 In Progress row x10: V', 'B01 🔄 In Progress row 22 or 23x: V',
    'B01 🔄 row 10: a label that is not the row\'s', 'B01 🔄 In Pregress row 10: a label as long as the row\'s, not its', 'B07 ⛔ external: row 3: upstream fix', HEAD])
    assert.deepEqual(attachVerdicts(rows, after(line), tip), unplaced(line), line);
  assert.deepEqual(attachVerdicts(rows, after('B01 🔄 In Progress row 10: V', 'B01 🔄 In Progress row 11: W'), tip), unplaced('B01 🔄 In Progress row 11: W'), 'a second line for one row');
  assert.deepEqual(attachVerdicts([...rows, { id: 'B01', status: '🔄 In Progress', git: null }], after('B01 🔄 In Progress row 10: V'), tip), unplaced('B01 🔄 In Progress row 10: V'), 'an id two rows share');
  // The first line: a bare UNKNOWN is the ledger's error; anything but this ledger's header at this tip is refused.
  const bare = 'UNKNOWN contract: its integration branch is other, not int';
  assert.deepEqual(attachVerdicts(rows, `${bare}\n`, tip), { error: bare });
  assert.deepEqual(attachVerdicts(rows, '', tip), { error: 'UNKNOWN rows did not complete: no output' });
  assert.deepEqual(attachVerdicts(rows, 'B01 🔄 In Progress row 10: V\n', tip), unplaced('B01 🔄 In Progress row 10: V'), 'no header');
  assert.deepEqual(attachVerdicts(rows, 'RECONCILE OTHER @abc1234 shipment=not-needed\n', tip), unplaced('RECONCILE OTHER @abc1234 shipment=not-needed'), 'another ledger\'s header');
  assert.deepEqual(attachVerdicts(rows, 'RECONCILE L @def5678 shipment=not-needed\n', tip), { error: 'UNKNOWN integration refs/heads/int moved during the read: abc1234 → def5678' });
  assert.deepEqual(attachVerdicts(rows, `${HEAD}\n`, tip).rows.map(r => r.git), rows.map(() => null), 'the control: this tip\'s header with no row line');
});

test('derived fields: waves is the highest wave, currentWave the lowest open one, nextCheckpoint the first not ✅', async () => {
  const { derive } = await api;
  const rows = (...specs) => specs.map(([wave, status]) => ({ wave, status }));
  const checkpoints = (...statuses) => statuses.map((status, i) => ({ id: `C${i + 1}`, status }));
  assert.equal(derive(rows([1, '✅'], [3, '🟢'], [2, '⬜']), []).waves, 3, 'the highest wave, not the last row\'s');
  assert.deepEqual(derive([], []), { waves: null, currentWave: null, nextCheckpoint: null });
  assert.equal(derive(rows([3, '⬜'], [1, '🔄'], [2, '❌']), []).currentWave, 1, 'the lowest open wave, not the first listed');
  for (const status of ['⬜', '🔄', '🔄 In Progress', '❌', '❌ (fix-up capped)', '⛔', '⛔ defective'])
    assert.equal(derive(rows([1, '✅'], [2, status], [3, '🟢']), []).currentWave, 2, `${status} holds its wave open`);
  for (const status of ['✅', '🟢', '🧪', '👤', '⛔ (dropped)'])
    assert.equal(derive(rows([1, '✅'], [2, status], [3, '🟢']), []).currentWave, 3, `${status} holds no wave open: the highest wave`);
  assert.equal(derive([], checkpoints('✅', '🧪', '⬜')).nextCheckpoint, 'C2');
  assert.equal(derive([], checkpoints('⬜', '✅')).nextCheckpoint, 'C1');
  assert.equal(derive([], checkpoints('✅', '✅')).nextCheckpoint, null);
  assert.equal(derive([], checkpoints('✅ Passed', '⬜')).nextCheckpoint, 'C2', 'the legend\'s spelled-out ✅ is passed too');
});

test('tables: rows, weights, rounds and State come through the pinned parser and reconcile; a read that throws is the ledger\'s error', async () => {
  const { readTables, loadTools } = await api;
  const pinned = await loadTools(SKILL, { 'ledger-parse.mjs': ['table', 'branchCell'], 'reconcile.mjs': ['stateOf', 'readNotes'] });
  const rows = [ROW('B01', '🔄', { notes: 'R1 FIX FIRST @1234abc R2 SHIP @5678def asks=1' }), ROW('B02', '⬜', { wave: 2, weight: 'L', notes: 'R1 SHIP asks=x' }), ROW('B03', '⬜', { wave: 2 })];
  const text = progress(rows, [['C1', '2', '⬜']], 'AT-CHECKPOINT C1'), planText = plan(rows.slice(0, 2));
  assert.deepEqual(readTables(text, planText, pinned, 'DIR'), {
    state: 'AT-CHECKPOINT C1',
    rows: [viewRow(rows[0], { round: 'R2 SHIP' }), viewRow(rows[1], { roundError: NOTES_ERROR }), viewRow(rows[2], { weight: null })],
    checkpoints: [{ id: 'C1', afterWave: '2', status: '⬜' }],
  });
  assert.deepEqual(readTables(text.replace('| B03 | work B03 |', '| B03 | work B03 | extra |'), planText, pinned, 'DIR'), { error: 'UNKNOWN pinned skill DIR: Malformed table row' });
  assert.deepEqual(readTables(text, '# Plan\n', pinned, 'DIR'), { error: 'UNKNOWN pinned skill DIR: Missing or ambiguous authority table' });
  assert.deepEqual(readTables(text.replace('`feat/b03`', '`feat/b03` x'), planText, pinned, 'DIR'), { error: 'UNKNOWN pinned skill DIR: Malformed branch cell' });
  for (const wave of ['W1', '1a'])
    assert.deepEqual(readTables(progress([ROW('B01', '🔄', { wave })]), planText, pinned, 'DIR'), { error: `UNKNOWN PROGRESS: B01's Wave cell ${wave} is not a wave number` }, wave);
  assert.deepEqual(readTables(text, plan([rows[0], rows[0]]), pinned, 'DIR'), { error: 'UNKNOWN plan: B01 has 2 rows in its batch table' });
  // Every column the batch's notes name for each table, written out here: a table lacking any one is no table.
  const missing = { error: 'UNKNOWN pinned skill DIR: Missing or ambiguous authority table' }, state = 'AT-CHECKPOINT C1', cps = [['C1', '2', '⬜']];
  for (const column of ['#', 'Batch', 'Branch', 'Wave', 'Status', 'Notes'])
    assert.deepEqual(readTables(progress(rows, cps, state, { batches: [column] }), planText, pinned, 'DIR'), missing, `the batch table without ${column}`);
  for (const column of ['Checkpoint', 'After wave', 'Status'])
    assert.deepEqual(readTables(progress(rows, cps, state, { checkpoints: [column] }), planText, pinned, 'DIR'), missing, `the checkpoint table without ${column}`);
  for (const column of ['#', 'Weight'])
    assert.deepEqual(readTables(text, plan(rows.slice(0, 2), [column]), pinned, 'DIR'), missing, `the plan without ${column}`);
  assert.deepEqual(readTables(progress(rows, cps, state, { batches: ['Version', 'Updated'], checkpoints: ['Covers', 'Why here', 'Verdict'] }),
    plan(rows.slice(0, 2), ['Batch', 'Type', 'Branch', 'Wave']), pinned, 'DIR'), readTables(text, planText, pinned, 'DIR'), 'the control: the columns no read needs can go');
});

// ===== Fixture repositories ==============================================================================
test('one ACTIVE ledger only on its integration branch: rows, weights, verdicts, derived fields and the tip, in-process and as published', async t => {
  const repo = fixture(t);
  repo.git('checkout', '-q', '-b', 'fix/B03-c1-followup');
  repo.write('fix.txt', 'the fix-up\n'); repo.commit('fix-up');
  repo.git('checkout', '-q', '-b', 'int', 'main');
  const rows = [
    ROW('B01', '🔄 In Progress', { weight: 'L' }),
    ROW('B02', '✅', { notes: 'R1 FIX FIRST @1234abc R2 SHIP @5678def' }),
    ROW('B03', '❌', { wave: 2, weight: 'S', notes: 'fix-up pending: fix/B03-c1-followup' }),
    ROW('B04', '⬜', { wave: 2, notes: 'R1 SHIP asks=x' }),
    // A free-text blocker holding both tokens a `rows` line is split at.
    ROW('B05', '⛔ UNKNOWN owner, see row 3: vendor', { wave: 2, weight: 'S' }),
  ];
  writeLedger(repo, 'L-ONE', files('int', rows, { checkpoints: [['C1', '1', '✅'], ['C2', '2', '⬜']] }));
  repo.commit('ledger');
  repo.git('merge', '-q', '--no-ff', '-m', 'merge the fix-up', 'fix/B03-c1-followup');
  repo.git('checkout', '-q', 'main');
  assert.ok(!fs.existsSync(path.join(repo.cwd, '.agents')), 'the control: the ledger lives only on its integration branch');
  const v = await verdicts(), sha = repo.git('rev-parse', 'refs/heads/int');
  const expected = { v: 1, repo: slash(repo.cwd), incomplete: false, ledgers: [{
    id: 'L-ONE', state: 'ACTIVE', integration: { branch: 'int', sha }, skillDir: slash(SKILL), waves: 2, currentWave: 1, nextCheckpoint: 'C2',
    rows: [
      viewRow(rows[0], { git: { row: '10', verdict: v[9] } }),
      viewRow(rows[1], { round: 'R2 SHIP' }),
      viewRow(rows[2], { git: { row: '22 or 23', verdict: `tip green → ${v[21]} | tip red → ${v[22]}` } }),
      viewRow(rows[3], { roundError: NOTES_ERROR, git: { unknown: NOTES_ERROR } }),
      viewRow(rows[4], { git: { row: '24', verdict: v[23] } }),
    ],
    checkpoints: [{ id: 'C1', afterWave: '1', status: '✅' }, { id: 'C2', afterWave: '2', status: '⬜' }],
    error: null, warning: null,
  }] };
  assert.deepEqual(await view(repo), { code: 0, view: expected });
  // As published, once: exactly one line, the same view with its keys in the published order.
  const r = cli(['--repo', repo.cwd, '--skill-dir', SKILL], repo.cwd, repo.env);
  assert.equal(r.status, 0); assert.equal(r.lines.length, 1, r.out); assert.ok(r.out.endsWith('\n'));
  assert.equal(r.lines[0], JSON.stringify(expected));
});

test('no ledger: an empty list, exit 0, also from a relative --repo or --skill-dir', async t => {
  const repo = fixture(t), empty = { code: 0, view: { v: 1, repo: slash(repo.cwd), incomplete: false, ledgers: [] } };
  assert.deepEqual(await view(repo), empty);
  // Each relative path is taken from the working directory, as the smoke step's `--repo .` is: one call runs
  // beside the repository, one beside the skill, so each path is relative on every platform and drive.
  const { ledgerView } = await api, env = withoutTestContext(repo.env), home = process.cwd();
  for (const [cwd, repoArg, skillArg] of [[repo.root, path.basename(repo.cwd), SKILL], [path.dirname(SKILL), repo.cwd, path.basename(SKILL)]]) {
    assert.ok(!path.isAbsolute(repoArg) || !path.isAbsolute(skillArg), 'the control: one of the two paths is relative');
    process.chdir(cwd);
    try { assert.deepEqual(await ledgerView({ repo: repoArg, skillDir: skillArg, env }), empty, `${repoArg} ${skillArg}`); } finally { process.chdir(home); }
  }
});

test('two active ledgers; the working-tree contract is read before a branch copy, and refs/heads/ is stripped from its integration branch', async t => {
  const repo = fixture(t), missing = path.join(repo.root, 'no-such-skill');
  const a = [ROW('B01', '🔄')], b = [ROW('B01', '⬜', { weight: 'S' })];
  onBranch(repo, 'int', 'L-A', files('int', a));
  // L-B's committed contract pins a skill directory that does not exist; its working-tree contract pins the checkout's.
  writeLedger(repo, 'L-B', files('int2', b, { skill: missing })); repo.commit('L-B');
  repo.git('branch', 'int2');
  repo.write('.agents/changes/L-B/00-READBEFORE.md', contract('refs/heads/int2'));
  assert.match(repo.git('show', 'int2:.agents/changes/L-B/00-READBEFORE.md'), /no-such-skill/, 'the control: the branch copy pins a missing directory');
  const v = await verdicts(), entry = (id, branch, row) => ({ id, state: 'ACTIVE', integration: { branch, sha: repo.git('rev-parse', `refs/heads/${branch}`) }, skillDir: slash(SKILL),
    waves: 1, currentWave: 1, nextCheckpoint: 'C1', checkpoints: [{ id: 'C1', afterWave: '1', status: '⬜' }], error: null, warning: null, rows: [row] });
  // Through the spawn seam: every child the view runs is recorded with the options it ran under, once with a
  // timeout given and once with none, as the CLI calls it (the batch's "a 30 s timeout each").
  const env = withoutTestContext(repo.env);
  for (const [given, timeout] of [[{ timeout: 29000 }, 29000], [{}, 30000]]) {
    const calls = [], spawn = (command, args, options) => { calls.push({ command, args, options }); return spawnSync(command, args, options); };
    assert.deepEqual(await view(repo, { env, spawn, ...given }), { code: 0, view: { v: 1, repo: slash(repo.cwd), incomplete: false, ledgers: [
      entry('L-A', 'int', viewRow(a[0], { git: { row: '10', verdict: v[9] } })),
      entry('L-B', 'int2', viewRow(b[0], { git: { row: '26', verdict: v[25] } })),
    ] } });
    // Discovery, every git read and both `rows` runs: each under the view's env and timeout, no shell, hidden.
    assert.deepEqual([...new Set(calls.map(c => c.command === 'git' ? 'git' : c.args[1]))].sort(), ['discovery', 'git', 'rows'], 'the control: all three child kinds ran');
    for (const { command, args, options } of calls) {
      assert.deepEqual({ env: options.env === env, timeout: options.timeout, shell: options.shell, windowsHide: options.windowsHide, cwd: options.cwd },
        { env: true, timeout, shell: false, windowsHide: true, cwd: repo.cwd }, `${command} ${args.join(' ')}`);
    }
  }
});

test('discovery: a State-differs ledger is read with its warning, an UNKNOWN line is an error entry, a COMPLETE ledger is skipped, partial evidence sets incomplete', async t => {
  const repo = fixture(t), { summarize } = await reconcile, { discovery } = await evidence, rows = [ROW('B01', '⬜')];
  writeLedger(repo, 'L-AMB', files('main', rows));
  for (const [id, state] of [['L-BAD', 'DONE'], ['L-DONE', 'COMPLETE']]) writeLedger(repo, id, { 'PROGRESS.md': progress(rows, undefined, state) });
  repo.commit('ledgers');
  repo.git('checkout', '-q', '-b', 'other');
  writeLedger(repo, 'L-AMB', { 'PROGRESS.md': progress(rows, undefined, 'COMPLETE') }); repo.commit('complete elsewhere');
  repo.git('checkout', '-q', 'main');
  // The lines discovery prints, read here through the checkout's reconcile: L-AMB's AMBIGUOUS text is its
  // warning, L-BAD's line its error, both verbatim.
  const printed = () => summarize(discovery({ repo: repo.cwd, env: repo.env }), { env: repo.env }).lines;
  const v = await verdicts(), sha = repo.git('rev-parse', 'refs/heads/main');
  const expected = (lines, incomplete) => {
    const line = id => lines.find(l => l.startsWith(`${id} `));
    assert.match(line('L-AMB'), /^L-AMB at .* → AMBIGUOUS \(State differs: /, 'the control: L-AMB is AMBIGUOUS');
    assert.match(line('L-BAD'), / → UNKNOWN \(State DONE is in no accepted form\)$/, 'the control: L-BAD is UNKNOWN');
    assert.match(line('L-DONE'), / → none$/, 'the control: L-DONE routes to none');
    const warning = slash(line('L-AMB').slice(line('L-AMB').lastIndexOf(' → ') + 3));
    return { code: 0, view: { v: 1, repo: slash(repo.cwd), incomplete, ledgers: [
      { id: 'L-AMB', state: 'ACTIVE', integration: { branch: 'main', sha }, skillDir: slash(SKILL), waves: 1, currentWave: 1, nextCheckpoint: 'C1',
        rows: [viewRow(rows[0], { git: { row: '26', verdict: v[25] } })], checkpoints: [{ id: 'C1', afterWave: '1', status: '⬜' }], error: null, warning },
      { id: 'L-BAD', ...BLANK, error: slash(line('L-BAD')) },
    ] } };
  };
  assert.deepEqual(await view(repo), expected(printed(), false));
  // Partial evidence: a worktree whose directory is gone. INCOMPLETE is printed first, the ledger lines still follow.
  const gone = path.join(repo.root, 'gone');
  repo.git('worktree', 'add', '-q', '-b', 'gone', gone, 'main');
  fs.rmSync(gone, { recursive: true, force: true });
  const lines = printed();
  assert.match(lines[0], /^INCOMPLETE 1 diagnostic\(s\): /, 'the control: discovery opens with INCOMPLETE');
  assert.deepEqual(await view(repo), expected(lines, true));
});

test('a ledger whose contract, tip, pinned skill, tables or rows cannot be read is an entry with its error, never absent', async t => {
  const repo = fixture(t), missing = path.join(repo.root, 'no-such-skill');
  const rows = [ROW('B01', '🔄')], ok = integration => files(integration, rows);
  // A pinned skill whose parser lacks the table exports; pinned skills whose reconcile is the checkout's as a
  // library and, run as a command, runs `entryCode` instead of `rows`.
  const exportless = skillDir(path.join(repo.root, 'exportless'), { 'ledger-parse.mjs': `export { skillPin, gitModel } from ${realTool('ledger-parse.mjs')};\n`, 'reconcile.mjs': `export * from ${realTool('reconcile.mjs')};\n` });
  const rowsStandIn = (name, entryCode) => skillDir(path.join(repo.root, name), { 'ledger-parse.mjs': `export * from ${realTool('ledger-parse.mjs')};\n`, 'reconcile.mjs': [
    'import fs from \'node:fs\';', 'import { fileURLToPath } from \'node:url\';',
    'const entry = Boolean(process.argv[1]) && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));',
    `const real = entry ? null : await import(${realTool('reconcile.mjs')});`,
    'export const stateOf = text => real.stateOf(text);', 'export const readNotes = text => real.readNotes(text);',
    `if (entry) { ${entryCode} }`, ''].join('\n') });
  // `failing` prints a line it would print anyway, so only its exit code fails the run.
  const failing = rowsStandIn('failing', 'process.stdout.write(\'RECONCILE L-STUB @0000000 shipment=not-needed\\n\'); process.exitCode = 1;');
  const mute = rowsStandIn('mute', 'process.exitCode = 0;');
  const garbled = rowsStandIn('garbled', 'process.stdout.write(Buffer.from([0xff, 0xfe, 0x0a]));');
  // `rows` whose header names a tip other than the one the tables were read at: the branch moved between the two.
  const moved = rowsStandIn('moved', 'process.stdout.write(\'RECONCILE L-MOVED @0000000 shipment=not-needed\\n\');');
  // A pinned reconcile with its State reader and no Notes reader.
  const noteless = skillDir(path.join(repo.root, 'noteless'), { 'ledger-parse.mjs': `export * from ${realTool('ledger-parse.mjs')};\n`, 'reconcile.mjs': `export { stateOf } from ${realTool('reconcile.mjs')};\n` });
  // A pin in Windows spelling: on every platform the directory it resolves to holds a backslash.
  const winPin = 'C:\\no-such\\orchestrate', winDir = path.resolve(repo.cwd, winPin);
  assert.ok(winDir.includes('\\'), 'the control: the pinned directory is spelled with backslashes');
  onBranch(repo, 'nob', 'L-NOB', { 'PROGRESS.md': progress(rows) });
  onBranch(repo, 'nogm', 'L-NOGM', { ...ok('nogm'), '00-READBEFORE.md': `# Contract\n\n**Skill**: \`${SKILL}\` · sha256 \`${HEX}\`\n` });
  onBranch(repo, 'nopin', 'L-NOPIN', { ...ok('nopin'), '00-READBEFORE.md': contract('nopin').replace(/^\*\*Skill\*\*.*\n/m, '') });
  onBranch(repo, 'nolabel', 'L-NOLABEL', { ...ok('nolabel'), '00-READBEFORE.md': contract('nolabel').replace('Integration branch: `nolabel` — the ledger branch.', '') });
  onBranch(repo, 'twice', 'L-TWICE', { ...ok('twice'), '00-READBEFORE.md': contract('twice').replace('- Shipment source', '- Integration branch: `twice`.\n- Shipment source') });
  onBranch(repo, 'noint', 'L-NOINT', ok('missing-int'));
  onBranch(repo, 'pin', 'L-PIN', files('pin', rows, { skill: missing }));
  onBranch(repo, 'exp', 'L-EXP', files('exp', rows, { skill: exportless }));
  onBranch(repo, 'noplan', 'L-NOPLAN', { '00-READBEFORE.md': contract('noplan'), 'PROGRESS.md': progress(rows) });
  onBranch(repo, 'parse', 'L-PARSE', { ...ok('parse'), 'PROGRESS.md': progress(rows).replace('| B01 | work B01 |', '| B01 | work B01 | extra |') });
  // L-MIS's first branch names mis-b its integration branch; mis-b's own contract names another, so `rows` refuses it.
  onBranch(repo, 'mis-a', 'L-MIS', ok('mis-b'));
  onBranch(repo, 'mis-b', 'L-MIS', ok('other'));
  // The State is read at the integration tip: these two are routed to status and close, not continue.
  onBranch(repo, 'stub', 'L-STUB', files('stub', rows, { skill: failing, state: 'USER-BLOCKED' }));
  onBranch(repo, 'mute', 'L-MUTE', files('mute', rows, { skill: mute, state: 'AT-CHECKPOINT C1' }));
  onBranch(repo, 'bytes', 'L-BYTES', files('bytes', rows, { skill: garbled }));
  onBranch(repo, 'win', 'L-WIN', files('win', rows, { skill: winPin }));
  onBranch(repo, 'moved', 'L-MOVED', files('moved', rows, { skill: moved }));
  onBranch(repo, 'noteless', 'L-NONOTES', files('noteless', rows, { skill: noteless }));
  writeLedger(repo, 'L-NOC', { 'PROGRESS.md': progress(rows) });
  const out = await view(repo), tip = branch => ({ branch, sha: repo.git('rev-parse', `refs/heads/${branch}`) });
  assert.equal(out.code, 0);
  const byId = Object.fromEntries(out.view.ledgers.map(l => [l.id, l]));
  assert.deepEqual(Object.keys(byId), ['L-BYTES', 'L-EXP', 'L-MIS', 'L-MOVED', 'L-MUTE', 'L-NOB', 'L-NOC', 'L-NOGM', 'L-NOINT', 'L-NOLABEL', 'L-NONOTES', 'L-NOPIN', 'L-NOPLAN',
    'L-PARSE', 'L-PIN', 'L-STUB', 'L-TWICE', 'L-WIN']);
  // Each entry: its error, and every other field as far as the view read before it failed.
  const check = (id, fields, error) => {
    const entry = byId[id];
    if (typeof error === 'string') assert.equal(entry.error, error, id); else assert.ok(error(entry.error), `${id}: ${entry.error}`);
    assert.deepEqual({ ...entry, error: null }, { id, ...BLANK, ...fields }, id);
  };
  const shown = (branch, id) => `${branch}:./.agents/changes/${id}/00-READBEFORE.md`;
  check('L-NOC', {}, `UNKNOWN contract ${slash(path.join(repo.cwd, '.agents', 'changes', 'L-NOC', '00-READBEFORE.md'))}: ENOENT`);
  check('L-NOB', {}, e => /^UNKNOWN contract nob:\.\/\.agents\/changes\/L-NOB\/00-READBEFORE\.md: git show did not read it \(exit \d+\)$/.test(e));
  check('L-NOGM', {}, `UNKNOWN contract ${shown('nogm', 'L-NOGM')}: Missing or duplicated Git model heading`);
  check('L-NOPIN', {}, `UNKNOWN contract ${shown('nopin', 'L-NOPIN')}: Missing skill pin line`);
  check('L-NOLABEL', {}, `UNKNOWN contract ${shown('nolabel', 'L-NOLABEL')}: no Integration branch recorded`);
  check('L-TWICE', {}, `UNKNOWN contract ${shown('twice', 'L-TWICE')}: Repeated Git model label`);
  check('L-NOINT', { integration: { branch: 'missing-int', sha: null }, skillDir: slash(SKILL) },
    e => /^UNKNOWN integration refs\/heads\/missing-int: git rev-parse did not resolve it \(exit \d+\)$/.test(e));
  check('L-PIN', { integration: tip('pin'), skillDir: slash(missing) }, e => e.startsWith(`UNKNOWN pinned skill ${slash(missing)}: `) && /Cannot find module/.test(e));
  check('L-EXP', { integration: tip('exp'), skillDir: slash(exportless) }, `UNKNOWN pinned skill ${slash(exportless)}: tools/ledger-parse.mjs exports no table, branchCell`);
  check('L-NOPLAN', { integration: tip('noplan'), skillDir: slash(SKILL) },
    e => /^UNKNOWN ledger: \.agents\/changes\/L-NOPLAN\/01-plan\.md cannot be read at refs\/heads\/noplan \(exit \d+\)$/.test(e));
  check('L-PARSE', { integration: tip('parse'), skillDir: slash(SKILL) }, `UNKNOWN pinned skill ${slash(SKILL)}: Malformed table row`);
  check('L-MIS', { state: 'ACTIVE', integration: tip('mis-b'), skillDir: slash(SKILL) }, 'UNKNOWN contract: its integration branch is other, not mis-b');
  check('L-STUB', { state: 'USER-BLOCKED', integration: tip('stub'), skillDir: slash(failing) }, 'UNKNOWN rows did not complete: exit 1');
  check('L-MUTE', { state: 'AT-CHECKPOINT C1', integration: tip('mute'), skillDir: slash(mute) }, 'UNKNOWN rows did not complete: no output');
  check('L-BYTES', { state: 'ACTIVE', integration: tip('bytes'), skillDir: slash(garbled) }, 'UNKNOWN rows did not complete: output is not UTF-8');
  check('L-WIN', { integration: tip('win'), skillDir: slash(winDir) }, e => e.startsWith(`UNKNOWN pinned skill ${slash(winDir)}: `) && !e.includes('\\'));
  check('L-MOVED', { state: 'ACTIVE', integration: tip('moved'), skillDir: slash(moved) }, `UNKNOWN integration refs/heads/moved moved during the read: ${tip('moved').sha.slice(0, 7)} → 0000000`);
  check('L-NONOTES', { integration: tip('noteless'), skillDir: slash(noteless) }, `UNKNOWN pinned skill ${slash(noteless)}: tools/reconcile.mjs exports no readNotes`);
});

test('each read uses its own copy of the skill: tables through the pin\'s parser, State and Notes through the pin\'s reconcile, contracts through --skill-dir\'s parser', async t => {
  const repo = fixture(t), rows = [ROW('B01', '🔄')];
  // Skill copies outside this checkout, each re-exporting the checkout's tools with one function marked so its
  // use shows in the view. Run as a command, each copy's reconcile.mjs runs the checkout's with the same
  // arguments, so its discovery and `rows` print what the real tool prints.
  const copy = (name, parseCode, reconcileCode = 'export const stateOf = text => real.stateOf(text);\nexport const readNotes = text => real.readNotes(text);') => skillDir(path.join(repo.root, name), {
    'ledger-parse.mjs': `export * from ${realTool('ledger-parse.mjs')};\n${parseCode}\n`,
    'reconcile.mjs': [
      'import fs from \'node:fs\';', 'import { spawnSync } from \'node:child_process\';', 'import { fileURLToPath } from \'node:url\';',
      'const entry = Boolean(process.argv[1]) && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));',
      `const real = entry ? null : await import(${realTool('reconcile.mjs')});`, reconcileCode,
      `if (entry) process.exitCode = spawnSync(process.execPath, [${JSON.stringify(path.join(SKILL, 'tools', 'reconcile.mjs'))}, ...process.argv.slice(2)], { stdio: 'inherit' }).status ?? 1;`,
      ''].join('\n'),
  });
  const pinTables = copy('pin-tables', 'export function table() { throw new Error(\'pinned table\'); }');
  const pinReconcile = copy('pin-reconcile', '', 'export const stateOf = () => \'PINNED\';\nexport const readNotes = text => ({ ...real.readNotes(text), latestRound: { k: 9, verdict: \'PINNED\' } });');
  const skillCopy = copy('skill-dir-copy', 'export function skillPin() { throw new Error(\'skill-dir parser\'); }');
  onBranch(repo, 'pr', 'L-PR', files('pr', rows, { skill: pinReconcile }));
  onBranch(repo, 'pt', 'L-PT', files('pt', rows, { skill: pinTables }));
  const v = await verdicts(), tip = branch => ({ branch, sha: repo.git('rev-parse', `refs/heads/${branch}`) });
  // L-PR's verdict comes from its copy's `rows`, run through to the real tool: the live control for every copy.
  assert.deepEqual(await view(repo), { code: 0, view: { v: 1, repo: slash(repo.cwd), incomplete: false, ledgers: [
    { id: 'L-PR', state: 'PINNED', integration: tip('pr'), skillDir: slash(pinReconcile), waves: 1, currentWave: 1, nextCheckpoint: 'C1',
      rows: [viewRow(rows[0], { round: 'R9 PINNED', git: { row: '10', verdict: v[9] } })], checkpoints: [{ id: 'C1', afterWave: '1', status: '⬜' }], error: null, warning: null },
    { id: 'L-PT', ...BLANK, integration: tip('pt'), skillDir: slash(pinTables), error: `UNKNOWN pinned skill ${slash(pinTables)}: pinned table` },
  ] } });
  // The same repository with the copy whose skillPin is marked as --skill-dir: its discovery lists both ledgers,
  // and each contract is read through its parser.
  assert.deepEqual((await view(repo, { skillDir: skillCopy })).view.ledgers.map(l => [l.id, l.error]), [
    ['L-PR', 'UNKNOWN contract pr:./.agents/changes/L-PR/00-READBEFORE.md: skill-dir parser'],
    ['L-PT', 'UNKNOWN contract pt:./.agents/changes/L-PT/00-READBEFORE.md: skill-dir parser'],
  ]);
});

test('Amendment 1: a checkpoint flip whose other copy is proven older settles at its integration tip with no warning; an AMBIGUOUS ledger\'s integration branch must hold a copy', async t => {
  const repo = fixture(t), { summarize } = await reconcile, { discovery } = await evidence;
  // L-CP opens ACTIVE on `int`; B01's branch is cut from it, worked and merged; the close-out commit on `int`
  // writes AT-CHECKPOINT C1 while B01's branch keeps the ACTIVE copy it was cut with, proven older than `int`.
  const rows = [ROW('B01', '🔄'), ROW('B02', '⬜', { wave: 2, weight: 'S' })], closed = [ROW('B01', '🟢'), rows[1]];
  onBranch(repo, 'int', 'L-CP', files('int', rows));
  repo.git('checkout', '-q', '-b', 'feat/b01', 'int');
  repo.write('b01.txt', 'B01\n'); repo.commit('B01 work');
  repo.git('checkout', '-q', 'int');
  repo.git('merge', '-q', '--no-ff', '-m', 'merge B01', 'feat/b01');
  writeLedger(repo, 'L-CP', { 'PROGRESS.md': progress(closed, [['C1', '1', '⬜']], 'AT-CHECKPOINT C1') }); repo.commit('C1 close-out');
  repo.git('checkout', '-q', 'main');
  // L-ORI's integration branch survives only as origin/int-ori, a remote-tracking copy, never a local branch.
  repo.remote();
  onBranch(repo, 'int-ori', 'L-ORI', files('int-ori', rows));
  repo.git('push', '-q', 'origin', 'int-ori');
  repo.git('checkout', '-q', '-b', 'side', 'int-ori');
  writeLedger(repo, 'L-ORI', { 'PROGRESS.md': progress(rows, undefined, 'USER-BLOCKED') }); repo.commit('blocked on side');
  repo.git('checkout', '-q', 'main');
  repo.git('branch', '-q', '-D', 'int-ori');
  const lines = summarize(discovery({ repo: repo.cwd, env: repo.env }), { env: repo.env }).lines, line = id => lines.find(l => l.startsWith(`${id} `));
  assert.equal(line('L-CP'), 'L-CP State=AT-CHECKPOINT C1 at feat/b01, int → close', 'the control: the checkpoint flip settles on int');
  assert.equal(line('L-ORI'), 'L-ORI at side, origin/int-ori → AMBIGUOUS (State differs: side=USER-BLOCKED, origin/int-ori=ACTIVE)', 'the control: int-ori is listed only as origin/int-ori');
  const v = await verdicts(), warning = id => line(id).slice(line(id).lastIndexOf(' → ') + 3);
  assert.deepEqual(await view(repo), { code: 0, view: { v: 1, repo: slash(repo.cwd), incomplete: false, ledgers: [
    { id: 'L-CP', state: 'AT-CHECKPOINT C1', integration: { branch: 'int', sha: repo.git('rev-parse', 'refs/heads/int') }, skillDir: slash(SKILL), waves: 2, currentWave: 2, nextCheckpoint: 'C1',
      rows: [viewRow(closed[0], { git: { row: '14', verdict: v[13] } }), viewRow(closed[1], { git: { row: '26', verdict: v[25] } })],
      checkpoints: [{ id: 'C1', afterWave: '1', status: '⬜' }], error: null, warning: null },
    { id: 'L-ORI', ...BLANK, integration: { branch: 'int-ori', sha: null }, skillDir: slash(SKILL),
      error: `UNKNOWN integration branch int-ori holds no copy of L-ORI: ${line('L-ORI')}`, warning: warning('L-ORI') },
  ] } });
});

test('a view that cannot start is UNKNOWN, exit 2: no tools, a parser without its exports, a discovery run that never completes', async t => {
  const { ledgerView } = await api, dir = tempDir(t);
  const start = (skill, extra = {}) => ledgerView({ repo: dir, skillDir: skill, env: withoutTestContext(process.env), ...extra });
  const unknown = reason => ({ code: 2, line: slash(`UNKNOWN ${reason}`) });
  const empty = path.join(dir, 'empty');
  fs.mkdirSync(empty);
  assert.deepEqual(await start(empty), unknown(`skill directory ${empty}: tools/reconcile.mjs cannot be used (ENOENT)`));
  const half = skillDir(path.join(dir, 'half'), { 'reconcile.mjs': '' });
  assert.deepEqual(await start(half), unknown(`skill directory ${half}: tools/ledger-parse.mjs cannot be used (ENOENT)`));
  const folder = skillDir(path.join(dir, 'folder'), { 'ledger-parse.mjs': '' });
  fs.mkdirSync(path.join(folder, 'tools', 'reconcile.mjs'));
  assert.deepEqual(await start(folder), unknown(`skill directory ${folder}: tools/reconcile.mjs cannot be used (not a file)`));
  const bare = skillDir(path.join(dir, 'bare'), { 'reconcile.mjs': '', 'ledger-parse.mjs': 'export {};\n' });
  assert.deepEqual(await start(bare), unknown(`skill directory ${bare}: tools/ledger-parse.mjs exports no gitModel, skillPin`));
  // A discovery stand-in whose behaviour LEDGER_VIEW_STUB picks.
  const stub = skillDir(path.join(dir, 'stub'), { 'ledger-parse.mjs': `export * from ${realTool('ledger-parse.mjs')};\n`, 'reconcile.mjs': [
    'const mode = process.env.LEDGER_VIEW_STUB;',
    'if (mode === \'hang\') setInterval(() => {}, 1000);',
    'else if (mode === \'crash\') { process.stdout.write(\'NO LEDGERS\\n\'); process.exitCode = 1; }',
    'else if (mode === \'usage\') { process.stdout.write(\'UNKNOWN usage: unknown operation\\n\'); process.exitCode = 2; }',
    'else if (mode === \'colour\') process.stdout.write(String.fromCharCode(27) + \'[32mNO LEDGERS\' + String.fromCharCode(27) + \'[0m\\n\');',
    'else if (mode === \'bytes\') process.stdout.write(Buffer.from([0xff, 0x0a]));',
    'else if (mode === \'kill\') process.kill(process.pid, \'SIGKILL\');',
    // NO LEDGERS inside an OSC 8 hyperlink: its opener ends in BEL, its closer in ESC backslash.
    'else if (mode === \'osc\') { const e = String.fromCharCode(27), b = String.fromCharCode(7); process.stdout.write(e + \']8;;https://example.invalid\' + b + \'NO LEDGERS\' + e + \']8;;\' + e + String.fromCharCode(92) + \'\\n\'); }',
    'else if (mode === \'cr\') process.stdout.write(\'X\' + String.fromCharCode(13) + \'Y\\n\');',
    // NO LEDGERS after the nF escape `tput sgr0` ends with (ESC ( B), and after the Fe escape ESC D.
    'else if (mode === \'nf\') process.stdout.write(String.fromCharCode(27) + \'(BNO LEDGERS\\n\');',
    'else if (mode === \'fe\') process.stdout.write(String.fromCharCode(27) + \'DNO LEDGERS\\n\');',
    'else if (mode === \'silent\') process.exitCode = 0;',
    'else process.stdout.write(\'NO LEDGERS\\n\');', ''].join('\n') });
  const as = (mode, extra) => start(stub, { env: { ...withoutTestContext(process.env), LEDGER_VIEW_STUB: mode }, ...extra });
  assert.deepEqual(await as('none'), { code: 0, view: { v: 1, repo: slash(dir), incomplete: false, ledgers: [] } }, 'the control: the stand-in can complete');
  assert.deepEqual(await as('colour'), { code: 0, view: { v: 1, repo: slash(dir), incomplete: false, ledgers: [] } }, 'a painted line is read once its colour is stripped');
  assert.deepEqual(await as('osc'), { code: 0, view: { v: 1, repo: slash(dir), incomplete: false, ledgers: [] } }, 'a hyperlinked line is read once its escapes are stripped');
  for (const mode of ['nf', 'fe']) assert.deepEqual(await as(mode), { code: 0, view: { v: 1, repo: slash(dir), incomplete: false, ledgers: [] } }, `a line after an ${mode} escape`);
  // A repository path spelled with a backslash is printed with forward slashes on every platform.
  const odd = path.join(dir, 'a\\b');
  fs.mkdirSync(odd, { recursive: true });
  assert.ok(path.resolve(odd).includes('\\'), 'the control: a path spelled with a backslash');
  assert.deepEqual(await as('none', { repo: odd }), { code: 0, view: { v: 1, repo: slash(path.resolve(odd)), incomplete: false, ledgers: [] } });
  assert.deepEqual(await as('hang', { timeout: 500 }), unknown('discovery did not complete: ETIMEDOUT'));
  assert.deepEqual(await as('crash'), unknown('discovery did not complete: exit 1'), 'a recognisable line from a run that failed');
  assert.deepEqual(await as('bytes'), unknown('discovery did not complete: output is not UTF-8'));
  const killed = await as('kill');
  assert.equal(killed.code, 2); assert.match(killed.line, /^UNKNOWN discovery did not complete: (?:signal SIGKILL|exit \d+)$/);
  assert.deepEqual(await as('usage'), unknown('discovery printed no line in a form it prints: UNKNOWN usage: unknown operation'));
  assert.deepEqual(await as('silent'), unknown('discovery printed no line in a form it prints: no output'));
  assert.deepEqual(await as('cr'), unknown('discovery printed no line in a form it prints: X Y'), 'an UNKNOWN line stays one line');
  // As published, once: one line, exit 2.
  const r = cli(['--repo', dir, '--skill-dir', empty], dir, process.env);
  assert.deepEqual({ status: r.status, out: r.out }, { status: 2, out: `${slash(`UNKNOWN skill directory ${empty}: tools/reconcile.mjs cannot be used (ENOENT)`)}\n` });
});

test('--help prints the usage; an invalid invocation is UNKNOWN usage, exit 2', async () => {
  const { ledgerViewCli } = await api;
  const help = cli(['--help'], ROOT, process.env);
  assert.equal(help.status, 0); assert.equal(help.lines[0], 'ledger-view.mjs --repo <dir> --skill-dir <dir>');
  const usage = { code: 2, lines: ['UNKNOWN usage: --repo <dir> and --skill-dir <dir>, each given once, are required; use --help'] };
  for (const args of [[], ['status'], ['--repo'], ['--repo', '.'], ['--skill-dir', 'x'], ['--repo', '--skill-dir'], ['--repo', '', '--skill-dir', 'x'],
    ['--repo', '.', '--repo', '.', '--skill-dir', 'x'], ['--repo', '.', '--skill-dir', 'x', '--extra', 'y'], ['--help', 'x']])
    assert.deepEqual(await ledgerViewCli(args), usage, JSON.stringify(args));
});

test('the CLI runs through a linked directory as it does in place', t => {
  // The plugin directory linked elsewhere, as an install links it; 'junction' makes the link on Windows too.
  const dir = tempDir(t), link = path.join(dir, 'linked-mod'), entry = path.join(link, 'tools', 'ledger-view.mjs');
  fs.symlinkSync(path.join(ROOT, 'orchestrate-mod'), link, 'junction');
  assert.notEqual(fs.realpathSync(entry), entry, 'the control: the entry path runs through a link');
  const r = spawnSync(process.execPath, [entry, '--help'], { cwd: dir, env: withoutTestContext(process.env), encoding: 'utf8', shell: false, windowsHide: true, timeout: 120000 });
  assert.ifError(r.error);
  assert.deepEqual({ status: r.status, first: plain(r.stdout).split('\n')[0] }, { status: 0, first: 'ledger-view.mjs --repo <dir> --skill-dir <dir>' });
});
