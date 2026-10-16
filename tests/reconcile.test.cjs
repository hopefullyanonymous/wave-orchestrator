'use strict';
// reconcile.mjs: the §Recovery table of orchestrate/references/protocol.md as a command. The matcher
// is driven in-process, one facts fixture per table row; the table binding is swept over every
// row; the Notes reader runs over every archived PROGRESS row; fixture repositories run the rest,
// through the CLI a few times, and each run is proven read-only.
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { isDeepStrictEqual } = require('node:util');
const { makeRepo } = require('./support/git-fixture.cjs');

const ROOT = path.resolve(__dirname, '..');
const TOOLS = path.join(ROOT, 'orchestrate', 'tools');
const api = import('../orchestrate/tools/reconcile.mjs');
const parser = import('../orchestrate/tools/ledger-parse.mjs');
const evidence = import('../orchestrate/tools/git-evidence.mjs');
const PROTOCOL = fs.readFileSync(path.join(ROOT, 'orchestrate', 'references', 'protocol.md'), 'utf8');
const HEADERS = ['Ledger says', 'Git shows', 'Verdict'];
const collapse = text => text.replace(/\s+/g, ' ').trim();
const ENV = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== 'NODE_TEST_CONTEXT'));

// The table's Verdict cells, read here by the shared parser, never through the tool under test.
async function verdicts(text = PROTOCOL) { return (await parser).table(text, HEADERS).map(r => collapse(r.Verdict)); }

// ===== The matcher: one facts fixture per table row ======================================
async function factsKit() {
  const { readNotes } = await api;
  const N = text => readNotes(text);
  const facts = (over = {}) => ({
    status: 'progress', unknown: {}, notes: N(''), branchExists: true, integrated: false, ahead: 1, onFirstParent: false, dirty: false,
    checklist: { items: 2, ticked: 1, complete: false, polish: 0, polishTicked: 0 }, round: { tipIs: false, after: false }, third: { tipIs: false, after: false, integrated: false },
    wave: { carrying: false, settled: false, checkpoint: null }, shipment: 'unknown', fixup: { exists: false, integrated: false }, tipGreen: null, ...over,
  });
  return { N, facts };
}
const FULL = { items: 2, ticked: 2, complete: true, polish: 0, polishTicked: 0 };

test('each of the 26 table rows is the first match on its own facts, and the domain is the whole table', async () => {
  const { matchRow, RULES } = await api, { N, facts } = await factsKit();
  const spent = N('R2 FIX FIRST @abc1234 → verdict 2026-09-01 fix again spent → third round on feat/x @abc1234');
  const cases = [
    [1, { notes: spent, third: { tipIs: true, after: false, integrated: false } }],
    [2, { notes: spent, third: { tipIs: false, after: true, integrated: false } }],
    [3, { notes: N('tip repair capped: fix/B01-tip') }],
    [4, { notes: N('tip repair pending: fix/B01-tip @abc1234') }],
    [5, { notes: N('R1 SHIP @abc1234 asks=1 → polish discarded: @abc1234') }],
    [6, { notes: N('R1 SHIP @abc1234'), round: { tipIs: true, after: false } }],
    [7, { notes: N('R1 SHIP @abc1234 asks=2'), round: { tipIs: true, after: false } }],
    [8, { notes: N('R1 SHIP @abc1234 asks=2'), round: { tipIs: false, after: true }, checklist: { items: 3, ticked: 3, complete: true, polish: 1, polishTicked: 1 } }],
    [9, { notes: N('R1 FIX FIRST @abc1234'), round: { tipIs: true, after: false } }],
    [10, { branchExists: false }],
    [11, { dirty: true }],
    [12, { checklist: FULL }],
    [13, { ahead: 0, integrated: true }],
    [14, { status: 'integrated', integrated: true, wave: { carrying: true, settled: true, checkpoint: '⬜' } }],
    [15, { status: 'integrated', integrated: false }],
    [16, { status: 'integrated', integrated: true }],
    [17, { status: 'checkpoint', shipment: 'contained' }],
    [18, { status: 'checkpoint', shipment: 'unknown' }],
    [19, { status: 'checkpoint', shipment: 'not-contained' }],
    [20, { status: 'failed', notes: N('fix-up pending: fix/B01-c1-followup'), fixup: { exists: false, integrated: false } }],
    [21, { status: 'failed', fixup: { exists: true, integrated: false } }],
    [22, { status: 'failed', fixup: { exists: true, integrated: true }, tipGreen: true }],
    [23, { status: 'failed', fixup: { exists: true, integrated: true }, tipGreen: false }],
    [24, { status: 'blocked' }],
    [25, { status: 'notStarted', branchExists: true }],
    [26, { status: 'notStarted', branchExists: false }],
  ];
  assert.equal(RULES.length, 26);
  assert.equal((await verdicts()).length, RULES.length, 'the checkout table has as many rows as the rules');
  assert.deepEqual(cases.map(c => c[0]), RULES.map((_, i) => i + 1), 'one case per rule, in table order');
  for (const [row, over] of cases) assert.deepEqual(matchRow(facts(over)), { row }, `row ${row}`);
  // The second kinds its row names: ⛔ with a qualifier, and ❌ (fix-up capped).
  assert.deepEqual(matchRow(facts({ status: 'fixupCapped' })), { row: 24 });
  // Rows 22 and 23 turn on a validation reconcile never runs: unmeasured prints them paired.
  assert.deepEqual(matchRow(facts({ status: 'failed', fixup: { exists: true, integrated: true } })), { row: 22, pair: 23 });
});

test('first match wins, and each boundary is pinned from both sides', async () => {
  const { matchRow } = await api, { N, facts } = await factsKit();
  const row = over => matchRow(facts(over));
  // A 🔄 row with a FIX FIRST marker at its tip and a dirty worktree takes the earlier rule.
  assert.deepEqual(row({ notes: N('R1 FIX FIRST @abc1234'), round: { tipIs: true, after: false }, dirty: true }), { row: 9 });
  assert.deepEqual(row({ notes: N('R1 FIX FIRST @abc1234'), round: { tipIs: false, after: true }, dirty: true }), { row: 11 });
  // An unadvanced branch in a dirty worktree is row 10 before row 11.
  assert.deepEqual(row({ onFirstParent: true, dirty: true }), { row: 10 });
  // A capped marker re-written after the spent line awaits the verdict again (row 3, not 1).
  assert.deepEqual(row({ notes: N('verdict 2026-09-01 fix again spent → third round on feat/x @abc1234 → tip repair capped: fix/B01-tip'), third: { tipIs: true, after: false, integrated: false } }), { row: 3 });
  // The spent line retires an earlier capped marker, and the row then ends in that spent fix again.
  assert.deepEqual(row({ notes: N('fix-up capped: fix/B01-c1-followup → verdict 2026-09-01 fix again spent → third round on feat/x @abc1234'), third: { tipIs: true, after: false, integrated: false } }), { row: 1 });
  // Rows 1-2 hold only while the third round's branch is not yet an ancestor of the integration branch.
  const spentLine = N('verdict 2026-09-01 fix again spent → third round on fix/B01-tip @abc1234');
  for (const after of [false, true]) {
    assert.deepEqual(row({ notes: spentLine, third: { tipIs: !after, after, integrated: false } }), { row: after ? 2 : 1 });
    assert.deepEqual(row({ notes: spentLine, third: { tipIs: !after, after, integrated: true }, ahead: 0, integrated: true }), { row: 13 }, `after=${after}`);
  }
  // A later R-line means the Notes no longer end in the spent fix again.
  assert.deepEqual(row({ notes: N('verdict 2026-09-01 fix again spent → third round on feat/x @abc1234 → R3 SHIP @abc1234'), round: { tipIs: true, after: false } }), { row: 6 });
  // A pending repair is retired by a later spent ship or drop, never by a spent fix again.
  for (const verdict of ['ship', 'drop']) assert.deepEqual(row({ notes: N(`tip repair pending: fix/B01-tip @abc1234 → verdict 2026-09-02 ${verdict} spent → done`), branchExists: false }), { row: 10 }, verdict);
  assert.deepEqual(row({ notes: N('pre-smoke repair pending: step 04, fix/B01-presmoke-04 @abc1234 → verdict 2026-09-02 fix again spent → third round on fix/B01-presmoke-04 @abc1234') , third: { tipIs: true, after: false, integrated: false } }), { row: 1 });
  assert.deepEqual(row({ notes: N('verdict 2026-09-02 ship spent → x → tip repair pending: fix/B01-tip @abc1234') }), { row: 4 });
  assert.deepEqual(row({ notes: N('tip repair pending: fix/B01-tip @abc1234 → verdict 2026-09-02 fix again spent → third round on fix/B01-tip @abc1234 → R3 SHIP @abc1234') }), { row: 4 });
  // A spent ship or drop retires an earlier capped marker too; one written after it awaits again.
  assert.deepEqual(row({ notes: N('tip repair capped: fix/B01-tip → verdict 2026-09-02 ship spent → merged'), branchExists: false }), { row: 10 });
  assert.deepEqual(row({ notes: N('verdict 2026-09-02 drop spent → x → tip repair capped: fix/B01-tip'), branchExists: false }), { row: 3 });
  // Polish discarded holds only while the branch is unmerged, and only on a 🔄 row.
  assert.deepEqual(row({ notes: N('polish discarded: @abc1234'), integrated: true, ahead: 0 }), { row: 13 });
  assert.deepEqual(row({ status: 'integrated', notes: N('polish discarded: @abc1234'), integrated: false }), { row: 15 });
  // asks= decides between rows 6 and 7; a dirty worktree drops row 7 to row 11.
  assert.deepEqual(row({ notes: N('R1 SHIP @abc1234 asks=1'), round: { tipIs: true, after: false } }), { row: 7 });
  assert.deepEqual(row({ notes: N('R1 SHIP @abc1234'), round: { tipIs: true, after: false } }), { row: 6 });
  assert.deepEqual(row({ notes: N('R1 SHIP @abc1234 asks=1'), round: { tipIs: true, after: false }, dirty: true }), { row: 11 });
  // The metrics token's asks= is no SHIP asks=.
  assert.deepEqual(row({ notes: N('R1 SHIP @abc1234. m: rounds=0 asks=3 fence-bounces=0'), round: { tipIs: true, after: false } }), { row: 6 });
  // Row 8 needs at least one polish item, every one ticked.
  const polished = (polish, polishTicked) => ({ notes: N('R1 SHIP @abc1234 asks=2'), round: { tipIs: false, after: true }, checklist: { items: 2 + polish, ticked: 2 + polishTicked, complete: polish === polishTicked, polish, polishTicked } });
  assert.deepEqual(row(polished(2, 2)), { row: 8 });
  assert.deepEqual(row(polished(2, 1)), { row: 11 });
  assert.deepEqual(row(polished(0, 0)), { row: 12 });
  // Commits ahead: one is ahead, none is not.
  assert.deepEqual(row({ checklist: FULL, ahead: 1 }), { row: 12 });
  assert.deepEqual(row({ checklist: FULL, ahead: 0, integrated: true }), { row: 13 });
  // Row 14: a carrying wave, every member settled, its checkpoint neither 🧪 nor ✅.
  const wave = w => row({ status: 'integrated', integrated: true, wave: { carrying: true, settled: true, checkpoint: '⬜', ...w } });
  assert.deepEqual(wave({}), { row: 14 });
  for (const w of [{ checkpoint: '🧪' }, { checkpoint: '✅' }, { settled: false }, { carrying: false }]) assert.deepEqual(wave(w), { row: 16 }, JSON.stringify(w));
  // A NEEDS A CLOSER LOOK line is no SHIP and no FIX FIRST.
  assert.deepEqual(row({ notes: N('R1 NEEDS A CLOSER LOOK @abc1234'), round: { tipIs: true, after: false }, checklist: FULL }), { row: 12 });
});

test('a fact the first match needs is UNKNOWN; one it does not need is never asked for', async () => {
  const { matchRow } = await api, { N, facts } = await factsKit();
  assert.deepEqual(matchRow(facts({ unknown: { dirty: 'a worktree status cannot be read' } })), { fact: 'dirty', why: 'a worktree status cannot be read' });
  assert.deepEqual(matchRow(facts({ notes: N('R1 FIX FIRST @abc1234'), round: { tipIs: true, after: false }, unknown: { dirty: 'x' } })), { row: 9 });
  // Rows 1-4 read every row's Notes, so unreadable Notes stop every status.
  for (const status of ['progress', 'integrated', 'checkpoint', 'failed', 'blocked', 'notStarted']) assert.equal(matchRow(facts({ status, unknown: { notes: 'bad' } })).fact, 'notes', status);
  assert.deepEqual(matchRow(facts({ status: 'checkpoint', unknown: { shipment: 'not resolved' } })), { fact: 'shipment', why: 'not resolved' });
  assert.equal(matchRow(facts({ status: 'failed', unknown: { fixup: 'no line' } })).fact, 'fixup');
  // A fact no rule matches is said so, never guessed.
  assert.deepEqual(matchRow(facts({ ahead: 0, integrated: false })), { fact: 'rule', why: 'no §Recovery row matches these facts' });
});

test('status cells: every legend form, and nothing beside them', async () => {
  const { statusKind } = await api;
  const kinds = { '⬜': 'notStarted', '🔄': 'progress', '🟢': 'integrated', '🧪': 'checkpoint', '❌': 'failed', '✅': 'passed', '👤': 'userAction', '⛔': 'blocked',
    '⛔ (dropped)': 'dropped', '❌ (fix-up capped)': 'fixupCapped', '⛔ defective': 'blocked', '⛔ green, residual finding open (P1)': 'blocked',
    '🟢 Integrated': 'integrated', '❌ Smoke Failed': 'failed', ' 🔄 ': 'progress', '⬜ Not Started': 'notStarted' };
  for (const [cell, kind] of Object.entries(kinds)) assert.equal(statusKind(cell), kind, cell);
  for (const cell of ['', 'x', '🟢 done', '🟢Integrated', '❌ (fix-up)', '⛔(dropped)', 'In Progress', '🔄🔄']) assert.equal(statusKind(cell), null, cell);
});

// ===== The table binding ==================================================================
function tableLines(text) {
  const lines = text.split('\n'), start = lines.findIndex(l => l.startsWith('| Ledger says | Git shows | Verdict |'));
  assert.ok(start > 0, 'the checkout protocol.md holds the Recovery table header');
  let end = start + 2; while (lines[end]?.startsWith('|')) end++;
  return { lines, first: start + 2, end };
}
function mutate(text, edit) {
  const { lines, first, end } = tableLines(text), rows = lines.slice(first, end);
  const out = [...lines.slice(0, first), ...edit(rows.slice()), ...lines.slice(end)].join('\n');
  assert.notEqual(out, text, 'the mutation changed the table');
  return out;
}
const recell = (line, index, change) => { const cells = line.split('|'); cells[index + 1] = change(cells[index + 1]); return cells.join('|'); };

test('the checkout table loads, and every swap, removal, addition and reworded cell stops it', async () => {
  const { loadTable } = await api;
  assert.deepEqual(loadTable(PROTOCOL), await verdicts(), 'the checkout table loads with its own Verdict cells');
  const { first, end } = tableLines(PROTOCOL), n = end - first;
  assert.equal(n, 26);
  const refused = (text, what) => assert.throws(() => loadTable(text), e => e.fact === 'table', what);
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) refused(mutate(PROTOCOL, rows => { [rows[i], rows[j]] = [rows[j], rows[i]]; return rows; }), `swap ${i + 1}/${j + 1}`);
  for (let i = 0; i < n; i++) {
    refused(mutate(PROTOCOL, rows => rows.filter((_, k) => k !== i)), `remove ${i + 1}`);
    refused(mutate(PROTOCOL, rows => [...rows.slice(0, i + 1), rows[i], ...rows.slice(i + 1)]), `duplicate ${i + 1}`);
    for (const cell of [0, 1]) for (const change of [c => c.replace(/\S+\s*$/, 'reworded '), c => ' Reworded' + c, c => c.replace(/ (\S+) /, ' $1 extra ')]) {
      refused(mutate(PROTOCOL, rows => { rows[i] = recell(rows[i], cell, change); return rows; }), `reword row ${i + 1} cell ${cell}`);
    }
    // The Verdict cell is read, never signed: rewording it loads, with the new words.
    const reworded = mutate(PROTOCOL, rows => { rows[i] = recell(rows[i], 2, c => ' New verdict words '); return rows; });
    assert.equal(loadTable(reworded)[i], 'New verdict words');
  }
  // An emptied Verdict cell, and a table that is no longer one table.
  refused(mutate(PROTOCOL, rows => { rows[0] = recell(rows[0], 2, () => ' '); return rows; }), 'empty verdict');
  refused(PROTOCOL.replace('| Ledger says | Git shows | Verdict |', '| Ledger says | Git shows | Outcome |'), 'renamed header');
  // The CRLF checkout of the same file loads the same table.
  assert.deepEqual(loadTable(PROTOCOL.replace(/\r?\n/g, '\r\n')), await verdicts());
});

// ===== The Notes reader and the checklist reader =========================================
test('the Notes reader reads every archived PROGRESS row and finds the named markers', { skip: 'needs history and ledger records that are not in this copy' }, async () => {
  const { readNotes } = await api, { table } = await parser;
  const archive = path.join(ROOT, '.agents', 'archive'), dirs = fs.readdirSync(archive).filter(d => fs.statSync(path.join(archive, d)).isDirectory()).sort();
  assert.ok(dirs.length >= 7, 'the archive holds the ledgers: ' + dirs.join(', '));
  const read = {};
  for (const dir of dirs) {
    const file = path.join(archive, dir, 'PROGRESS.md');
    assert.ok(fs.existsSync(file), dir + ' has a PROGRESS.md');
    // Every batch table in the file, the repair mini-batch tables included: one per section.
    const rows = fs.readFileSync(file, 'utf8').split(/^(?=## )/m).flatMap(section => { try { return table(section, ['#', 'Branch', 'Status', 'Notes']); } catch { return []; } });
    assert.ok(rows.length > 0, dir + ' has batch rows');
    for (const row of rows) read[`${dir} ${row['#']}`] = readNotes(row.Notes);
  }
  const mech = read['OS-20260923-mechanical-tools B02'];
  assert.deepEqual({ ...mech.latestRound, index: 0 }, { k: 3, verdict: 'SHIP', sha: 'be26458', asks: 6, index: 0 });
  assert.deepEqual(mech.spent.map(s => [s.date, s.verdict]), [['2026-09-23', 'fix again']]);
  assert.equal(mech.endsInSpentFixAgain, false, 'an R3 line follows the spent fix again');
  assert.deepEqual({ ...read['OS-20260923-mechanical-tools B04'].latestRound, index: 0 }, { k: 4, verdict: 'SHIP', sha: '0d6fcef', asks: null, index: 0 });
  assert.equal(read['OS-20260923-mechanical-tools B01'].fixupBranch, 'fix/B01-c1-followup-2', 'the latest fix-up pending line');
  assert.deepEqual(read['OS-20260925-slim-contract-pack B04'].spent.map(s => s.verdict), ['fix again', 'ship']);
  const sizing = read['OS-20260920-interview-sizing-backlog B07'];
  assert.equal(sizing.endsInSpentFixAgain, true);
  assert.deepEqual(sizing.third, { branch: 'fix/bl-010-016-selfcheck-runners', sha: '7f07f20' });
});

test('the Notes reader: each marker in its recorded form, and anything like one in another form is UNKNOWN', async () => {
  const { readNotes } = await api;
  const n = readNotes('R1 FIX FIRST @abc1234 → R2 SHIP @`def5678` asks=3 → polish discarded: @def5678 → deferred to W3: the thing (`a/b.md`) → fix-up pending: `fix/B02-c1-followup-2`');
  assert.deepEqual(n.rounds.map(r => [r.k, r.verdict, r.sha, r.asks]), [[1, 'FIX FIRST', 'abc1234', null], [2, 'SHIP', 'def5678', 3]]);
  assert.equal(n.polishDiscarded, 'def5678');
  assert.deepEqual(n.deferred, ['the thing']);
  assert.equal(n.fixupBranch, 'fix/B02-c1-followup-2');
  assert.equal(readNotes('R1 SHIP asks=2 (combined pass)').latestRound.sha, null);
  assert.equal(readNotes('m: rounds=1 asks=0 fence-bounces=0 gate=3/0 tip-red=0').latestRound, null);
  assert.equal(readNotes('merged 06ee54a; R2/R3 reviewer strong tier; R3 @f95413b fresh implementer').latestRound, null);
  assert.equal(readNotes('pre-smoke repair pending: step 10, fix/B03-presmoke-10 @abc1234').repairPending, true);
  const refused = [
    'R1 SHIP @xyz', 'R1 SHIP @abc12', 'R1 SHIP @abc1234x', 'R1 SHIP @abc1234 asks=', 'R1 SHIP @abc1234 asks=two',
    'tip repair pending: fix/B01-tip', 'tip repair pending: step 03, fix/B01-tip @abc1234', 'pre-smoke repair pending: fix/B01-presmoke-03 @abc1234',
    'fix-up capped:', 'widget capped: x', 'verdict 2026-09-01 retry spent', 'verdict 2026-09-01 ship', 'polish discarded: abc1234',
    'fix-up pending: feat/B01', 'fix-up pending: fix/B01-followup', 'third round on feat/x', 'deferred to W2 later',
    'verdict 2026-09-01 fix again spent → the round was cut',
  ];
  for (const text of refused) assert.throws(() => readNotes(text), e => e.fact === 'notes', text);
  // The control beside each refusal family: the same marker in its recorded form reads.
  for (const text of ['R1 SHIP @abc1234 asks=2', 'tip repair pending: fix/B01-tip @abc1234', 'fix-up capped: fix/B01-c1-followup', 'verdict 2026-09-01 ship spent → merged',
    'polish discarded: @abc1234', 'fix-up pending: fix/B01-c1-followup', 'deferred to W2: an item (x.md)', 'verdict 2026-09-01 fix again spent → third round on feat/x @abc1234']) readNotes(text);
});

test('the checklist reader: items, wrapped lines, polish items, deferrals, comments; odd checkboxes are UNKNOWN', async () => {
  const { readChecklist } = await api;
  const file = body => `# B01\n\n## Checklist\n\n${body}\n\n## Acceptance criteria\n\n- [ ] not a checklist item\n`;
  assert.deepEqual(readChecklist(file('<!-- - [ ] a template comment\n- [x] still comment -->\n- [x] one\n- [ ] two\n  wraps here\n- [x] polish: tidy\n- [ ] polish: pin it')),
    { items: 4, ticked: 2, complete: false, polish: 2, polishTicked: 1 });
  assert.equal(readChecklist(file('- [x] one\n- [x] two')).complete, true);
  assert.equal(readChecklist(file('- [x] one\n- [ ] the thing to move')).complete, false);
  assert.equal(readChecklist(file('- [x] one\n- [ ] the thing to move'), ['the thing']).complete, true, 'a recorded deferral is not a partial checklist');
  assert.equal(readChecklist(file('- [x] one\n- [ ] the thing\n  to move'), ['thing to move']).complete, true, 'a deferral matches across a wrapped line');
  assert.equal(readChecklist(file('- [x] one\n- [x] two').replace(/\n/g, '\r\n')).complete, true, 'CRLF reads the same');
  for (const odd of ['- [X] one', '  - [ ] indented', '* [ ] star', '- [] empty', '- [ ]no space']) assert.throws(() => readChecklist(file(`- [x] kept\n${odd}`)), e => e.fact === 'checklist' && /no accepted form/.test(e.why), JSON.stringify(odd));
  assert.throws(() => readChecklist(file('')), e => e.fact === 'checklist' && /no item/.test(e.why));
  assert.throws(() => readChecklist('# B01\n\n- [ ] no section\n'), e => e.fact === 'checklist');
  assert.throws(() => readChecklist(file('- [ ] one') + '\n## Checklist\n\n- [ ] two\n'), e => e.fact === 'checklist');
});

// ===== Fixture repositories ===============================================================
const LEDGER_ID = 'FIX-1', LEDGER_DIR = `.agents/changes/${LEDGER_ID}`, INTEGRATION = 'refs/heads/int';
const contractText = (source, ref = 'refs/heads/main', integration = 'int') => `# Contract\n\n## Git model\n\n- Default branch (protected local ref): \`refs/heads/main\`. Integration branch: \`${integration}\` — the ledger branch.\n- Shipment source: \`${source}\`. Shipment ref: \`${ref}\` — the target.\n\n## Other\n`;
const batchText = id => `# ${id} — work\n\n**Branch**: \`feat/${id.toLowerCase()}\`\n\n## Checklist\n\n- [ ] first item\n- [ ] second item\n  wraps under it\n\n## Acceptance criteria\n\n- done\n`;
const progressText = (rows, checkpoint = '| C1 | 2 | all | final | ⬜ | — |') => `# Progress\n\n**State**: ACTIVE\n\n## Batches\n\n| # | Batch | Branch | Wave | Version | Status | Updated | Notes |\n|---|---|---|---|---|---|---|---|\n`
  + rows.map(r => `| ${r.id} | work | \`${r.branch}\` | ${r.wave ?? 1} | — | ${r.status} | 2026-09-27 | ${r.notes ?? '—'} |`).join('\n')
  + `\n\n## Checkpoints\n\n| Checkpoint | After wave | Covers | Why here | Status | Verdict |\n|---|---|---|---|---|---|\n${checkpoint}\n\n## Session log\n\n| Date | Did | Stopped |\n|---|---|---|\n`;

function repository(t) {
  const repo = makeRepo(t);
  repo.git('config', 'maintenance.auto', 'false'); repo.git('config', 'gc.auto', '0');
  return repo;
}
// Every observable a read-only run could change: refs, worktrees, and each worktree's status.
function observe(repo) {
  const trees = repo.git('worktree', 'list', '--porcelain');
  const paths = trees.split('\n').filter(l => l.startsWith('worktree ')).map(l => l.slice(9));
  return { refs: repo.git('for-each-ref'), trees, status: paths.map(p => fs.existsSync(p) ? repo.at(p).git('status', '--porcelain', '--untracked-files=all') : null) };
}
// Git for Windows lists a worktree as `C:/…` where Node spells it `C:\…`, and an expectation built
// with path.join is Node's. So that no expectation holds only where the two agree, git lists every
// linked worktree a fixture keeps in a spelling of its own on every platform: the worktree's
// admin `gitdir` file, whose path `git worktree list` prints, gains a `/./` segment. The live
// control: git's listing names the same directory, never in the spelling the test expects.
function respell(repo, wt) {
  const link = fs.readFileSync(path.join(wt, '.git'), 'utf8'), admin = /^gitdir: (.+)$/m.exec(link);
  assert.ok(admin, 'a linked worktree names its admin directory: ' + link);
  const file = path.join(path.resolve(wt, admin[1].trim()), 'gitdir'), held = /^(.*)\/([^/]+)\/\.git$/.exec(fs.readFileSync(file, 'utf8').trim());
  assert.ok(held, 'the admin gitdir file holds the worktree path');
  fs.writeFileSync(file, `${held[1]}/./${held[2]}/.git\n`);
  const listed = repo.git('worktree', 'list', '--porcelain').split('\n').filter(l => l.startsWith('worktree ')).map(l => l.slice(9))
    .filter(p => fs.existsSync(p) && fs.realpathSync(p) === fs.realpathSync(wt));
  assert.equal(listed.length, 1, 'git lists the worktree once: ' + wt);
  assert.notEqual(listed[0], wt, 'git lists the worktree in a spelling the test does not expect');
}
function cli(repo, args, tool = path.join(TOOLS, 'reconcile.mjs')) {
  const before = observe(repo);
  const r = spawnSync(process.execPath, [tool, ...args], { cwd: repo.cwd, env: { ...ENV, ...repo.env }, encoding: 'utf8', shell: false, windowsHide: true, timeout: 60000 });
  assert.ifError(r.error); assert.equal(r.signal, null);
  assert.deepEqual(observe(repo), before, 'a CLI run changes no ref, worktree or status');
  return { status: r.status, lines: r.stdout.replace(/\n$/, '').split('\n') };
}
async function rows(repo, protocolText = PROTOCOL) {
  const { reconcileRows } = await api, before = observe(repo);
  const r = reconcileRows({ repo: repo.cwd, ledger: LEDGER_ID, integration: INTEGRATION, protocolText, env: repo.env });
  assert.deepEqual(observe(repo), before, 'an in-process run changes no ref, worktree or status');
  return r;
}

// A ledger on `int` (checked out in the main checkout) and one branch per batch in the state it names.
function ledgerFixture(t, specs, source = 'remote origin') {
  const repo = repository(t);
  repo.git('checkout', '-q', '-b', 'int');
  repo.write(`${LEDGER_DIR}/00-READBEFORE.md`, contractText(source));
  for (const s of specs.filter(s => !s.noFile)) repo.write(`${LEDGER_DIR}/02-batches-${s.id.slice(1)}-work.md`, s.onInt ?? batchText(s.id));
  repo.write(`${LEDGER_DIR}/PROGRESS.md`, progressText([]));
  const tips = { base: repo.commit('ledger') };
  for (const s of specs.filter(s => s.make)) {
    const wt = path.join(repo.root, `wt-${s.id}`);
    repo.git('worktree', 'add', '-q', '-b', s.branch, wt, 'int');
    const at = repo.at(wt);
    if (s.make !== 'cut') {
      const ticks = s.make === 'partial' ? 1 : 2;
      let text = batchText(s.id); for (let k = 0; k < ticks; k++) text = text.replace('- [ ] ', '- [x] ');
      at.write(`${LEDGER_DIR}/02-batches-${s.id.slice(1)}-work.md`, text); at.write(`work-${s.id}.txt`, s.id + '\n');
      at.commit(`work ${s.id}`);
      // A polish pass after the reviewed tip: one appended polish item, ticked.
      if (s.make === 'polish') {
        tips[`${s.id}mid`] = at.git('rev-parse', 'HEAD');
        at.write(`${LEDGER_DIR}/02-batches-${s.id.slice(1)}-work.md`, text.replace('  wraps under it\n', '  wraps under it\n- [x] polish: tidy the names\n'));
        at.commit(`polish ${s.id}`);
      }
    }
    tips[s.id] = at.git('rev-parse', 'HEAD');
    if (s.dirty) at.write('scratch.txt', 'untracked\n');
    if (!s.worktree) repo.git('worktree', 'remove', wt); else respell(repo, wt);
  }
  for (const s of specs.filter(s => s.merge)) repo.git('merge', '-q', '--no-ff', '-m', `merge ${s.id}`, s.branch);
  const write = (rowsOf = specs, checkpoint) => { repo.write(`${LEDGER_DIR}/PROGRESS.md`, progressText(rowsOf.map(s => ({ ...s, notes: typeof s.notes === 'function' ? s.notes((tips[s.id] ?? '').slice(0, 7), tips) : s.notes })), checkpoint)); return repo.commit('progress'); };
  write();
  return { repo, tips, write };
}
const SPECS = [
  { id: 'B01', status: '🔄', branch: 'feat/b01' },
  { id: 'B02', status: '🔄', branch: 'feat/b02', make: 'partial', worktree: true },
  { id: 'B03', status: '🟢', branch: 'feat/b03', make: 'full', worktree: true, merge: true },
  { id: 'B04', status: '🔄', branch: 'feat/b04', make: 'full' },
  { id: 'B05', status: '🔄', branch: 'feat/b05', make: 'full', worktree: true, dirty: true },
  { id: 'B06', status: '⬜', branch: 'feat/b06' },
  { id: 'B07', status: '⬜', branch: 'feat/b07', make: 'cut' },
  { id: 'B08', status: '🟢', branch: 'feat/b08', make: 'full', worktree: true },
  { id: 'B09', status: '🔄', branch: 'feat/b09', make: 'cut', worktree: true },
  { id: 'B10', status: '🔄', branch: 'feat/b10', make: 'full', notes: tip => `R1 FIX FIRST @${tip}` },
  { id: 'B11', status: '🔄', branch: 'feat/b11', make: 'full', notes: tip => `R2 FIX FIRST @${tip} → verdict 2026-09-01 fix again spent → third round on feat/b11 @${tip}` },
  { id: 'B12', status: '🔄', branch: 'feat/b12', make: 'full', notes: tip => `R1 SHIP @${tip} asks=1 → polish discarded: @${tip}` },
  { id: 'B13', status: '🔄', branch: 'feat/b13', make: 'full', notes: tip => `R1 SHIP @${tip}` },
  { id: 'B14', status: '✅', branch: 'feat/b14', make: 'full', merge: true, worktree: true },
  { id: 'B15', status: '❌', branch: 'feat/b15', notes: 'fix-up pending: fix/B15-c1-followup' },
  { id: 'B16', status: '🟢', branch: 'feat/b16', make: 'full', merge: true, wave: 2 },
  { id: 'B17', status: '👤', branch: 'feat/b17' },
  { id: 'B18', status: '⛔ (dropped)', branch: 'feat/b18' },
  { id: 'B19', status: '⛔ defective', branch: 'feat/b19' },
  { id: 'B20', status: '🔄', branch: 'feat/b20', make: 'partial', notes: 'deferred to W2: second item (`x.md`)' },
  { id: 'B21', status: '🔄', branch: 'feat/b21', make: 'full', notes: (tip, tips) => `R1 FIX FIRST @${tips.B04.slice(0, 7)}` },
  { id: 'B22', status: '🔄', branch: 'feat/b22', make: 'full', notes: 'R1 SHIP @0000000' },
  { id: 'B23', status: '🔄', branch: 'feat/b23', make: 'full', notes: (tip, tips) => `R1 FIX FIRST @${tips.base.slice(0, 7)}` },
  { id: 'B24', status: '🔄', branch: 'feat/b24', make: 'full', notes: 'R1 SHIP asks=1' },
  { id: 'B25', status: '🔄', branch: 'feat/b25', make: 'full', notes: tip => `R1 SHIP @${tip} asks=1` },
  { id: 'B26', status: '🔄', branch: 'feat/b26', make: 'polish', notes: (tip, tips) => `R1 SHIP @${tips.B26mid.slice(0, 7)} asks=1` },
  { id: 'B27', status: '🔄', branch: 'feat/b27', make: 'full', merge: true },
  { id: 'B28', status: '⬜', branch: 'feat/b28', notes: 'tip repair capped: fix/B28-tip' },
  { id: 'B29', status: '⬜', branch: 'feat/b29', notes: (tip, tips) => `tip repair pending: fix/B29-tip @${tips.base.slice(0, 7)}` },
];
const EXPECTED = { B01: 10, B02: 11, B03: 16, B04: 12, B05: 11, B06: 26, B07: 25, B08: 15, B09: 10, B10: 9, B11: 1, B12: 5, B13: 6, B15: 20, B16: 14, B19: 24, B20: 12, B23: 12, B25: 7, B26: 8, B27: 13, B28: 3, B29: 4 };

test('rows: a fixture ledger prints its header, the right row per batch with protocol.md\'s Verdict, and a PRUNE line', async t => {
  const { repo, tips } = ledgerFixture(t, SPECS);
  const v = await verdicts(), tip = repo.git('rev-parse', 'refs/heads/int').slice(0, 7);
  const unknown = { B21: `round: @${tips.B04.slice(0, 7)} is not on the branch`, B22: 'round: @0000000 is not a commit here', B24: 'round: R1 SHIP records no @<sha>' };
  const expected = [`RECONCILE ${LEDGER_ID} @${tip} shipment=not-needed`,
    ...SPECS.filter(s => EXPECTED[s.id] || unknown[s.id]).map(s => unknown[s.id] ? `${s.id} ${s.status} UNKNOWN ${unknown[s.id]}` : `${s.id} ${s.status} row ${EXPECTED[s.id]}: ${v[EXPECTED[s.id] - 1]}`),
    `PRUNE ${path.join(repo.root, 'wt-B03')}`];
  assert.deepEqual(await rows(repo), { code: 2, lines: expected });
  assert.ok(tips.B03 && tips.B14, 'the merged batches were built');
  // As published, once: the same lines and exit code.
  assert.deepEqual(cli(repo, ['rows', '--repo', repo.cwd, '--ledger', LEDGER_ID, '--integration', INTEGRATION]), { status: 2, lines: expected });
  // The main checkout's dirt counts only for a row whose branch it holds. On `int` it holds none:
  // the user's stray file there changes no line.
  repo.write('stray.txt', 'untracked\n');
  assert.deepEqual(await rows(repo), { code: 2, lines: expected });
  // On B04's branch, which no other worktree holds, the same file turns B04, and only B04, to row 11;
  // `rows` reads the ledger from the `int` ref, so the switch changes nothing else it reads.
  repo.git('checkout', '-q', 'feat/b04');
  const held = expected.map(l => l.startsWith('B04 ') ? `B04 🔄 row 11: ${v[10]}` : l);
  assert.deepEqual(held.filter((l, i) => l !== expected[i]), [`B04 🔄 row 11: ${v[10]}`], 'the control: B04 is a line, and not already row 11');
  assert.deepEqual(await rows(repo), { code: 2, lines: held });
  // At B04's tip but detached, the checkout holds no branch: the same file changes no line.
  repo.git('checkout', '-q', '--detach', 'feat/b04');
  assert.deepEqual(await rows(repo), { code: 2, lines: expected });
  repo.git('checkout', '-q', 'feat/b04');
  // Holding the branch is not dirt: the same checkout without the file reads B04 clean again.
  fs.rmSync(path.join(repo.cwd, 'stray.txt'));
  assert.deepEqual(await rows(repo), { code: 2, lines: expected });
  repo.git('checkout', '-q', 'int');
  // A batch worktree whose status cannot be read leaves that row UNKNOWN.
  fs.rmSync(path.join(repo.root, 'wt-B02'), { recursive: true, force: true });
  assert.equal((await rows(repo)).lines[2], 'B02 🔄 UNKNOWN dirty: a worktree status cannot be read');
});

test('rows: shipment follows the contract\'s source through shipment(), and no other run queries a remote', async t => {
  const specs = [{ id: 'B01', status: '🧪', branch: 'feat/b01', make: 'full', merge: true }, { id: 'B02', status: '🟢', branch: 'feat/b02', make: 'full', merge: true }];
  const { repo, write } = ledgerFixture(t, specs);
  const bare = repo.remote();
  // A live canary: the remote's upload-pack records every query.
  const marker = path.join(repo.root, 'queried'), script = path.join(repo.root, 'upload-pack.sh');
  fs.writeFileSync(script, `#!/bin/sh\necho queried >> "${marker.split(path.sep).join('/')}"\nexec git upload-pack "$@"\n`, { mode: 0o755 });
  repo.git('config', 'remote.origin.uploadpack', script.split(path.sep).join('/'));
  const v = await verdicts(), header = shipped => `RECONCILE ${LEDGER_ID} @${repo.git('rev-parse', 'refs/heads/int').slice(0, 7)} shipment=${shipped}`;
  const tail = row => [`B01 🧪 row ${row}: ${v[row - 1]}`, `B02 🟢 row 16: ${v[15]}`];
  assert.deepEqual(await rows(repo), { code: 0, lines: [header('not-contained'), ...tail(19)] });
  assert.ok(fs.existsSync(marker), 'the control: a 🧪 row queries the remote');
  repo.git('push', '-q', bare.cwd, 'refs/heads/int:refs/heads/main');
  assert.deepEqual(await rows(repo), { code: 0, lines: [header('contained'), ...tail(17)] });
  // A merged 🧪 batch's worktree is one to prune.
  const checkpointTree = path.join(repo.root, 'wt-checkpoint');
  repo.git('worktree', 'add', '-q', checkpointTree, 'feat/b01'); respell(repo, checkpointTree);
  assert.deepEqual((await rows(repo)).lines.slice(-1), [`PRUNE ${checkpointTree}`]);
  repo.git('worktree', 'remove', checkpointTree);
  // Local source: the local main, never the remote.
  fs.rmSync(marker);
  repo.write(`${LEDGER_DIR}/00-READBEFORE.md`, contractText('local')); repo.commit('local source');
  assert.deepEqual(await rows(repo), { code: 0, lines: [header('not-contained'), ...tail(19)] });
  repo.git('update-ref', 'refs/heads/main', 'refs/heads/int');
  assert.deepEqual(await rows(repo), { code: 0, lines: [header('contained'), ...tail(17)] });
  assert.equal(fs.existsSync(marker), false, 'a local source queries no remote');
  // A source in no known form leaves shipment unknown: row 18, never a flipped row.
  for (const source of ['remote ', 'somewhere else', 'remotes origin', 'localhost', 'remote origin:main']) {
    repo.write(`${LEDGER_DIR}/00-READBEFORE.md`, contractText(source)); repo.commit('odd source');
    assert.deepEqual(await rows(repo), { code: 0, lines: [header('unknown'), ...tail(18)] }, source);
  }
  // No 🧪 row: not-needed, and the remote is never asked.
  repo.write(`${LEDGER_DIR}/00-READBEFORE.md`, contractText('remote origin')); repo.commit('remote again');
  write([{ ...specs[0], status: '🟢' }, specs[1]], '| C1 | 2 | all | final | ⬜ | — |');
  const quiet = cli(repo, ['rows', '--repo', repo.cwd, '--ledger', LEDGER_ID, '--integration', INTEGRATION]);
  assert.deepEqual(quiet, { status: 0, lines: [header('not-needed'), `B01 🟢 row 16: ${v[15]}`, `B02 🟢 row 16: ${v[15]}`] });
  assert.equal(fs.existsSync(marker), false, 'a run with no 🧪 row queries no remote');
  // The main checkout on a merged batch branch is never a worktree to prune; a linked one is.
  repo.git('checkout', '-q', 'feat/b02');
  assert.deepEqual((await rows(repo)).lines.slice(-1), [`B02 🟢 row 16: ${v[15]}`]);
  repo.git('checkout', '-q', 'int');
  const linked = path.join(repo.root, 'wt-linked');
  repo.git('worktree', 'add', '-q', linked, 'feat/b02'); respell(repo, linked);
  assert.deepEqual((await rows(repo)).lines.slice(-1), [`PRUNE ${linked}`]);
});

test('rows: the fix-up branch, the row-10 contradiction, and a contract naming another integration branch', async t => {
  const specs = [{ id: 'B01', status: '❌', branch: 'feat/b01', notes: 'fix-up pending: fix/B01-c1-followup' },
    { id: 'B02', status: '🔄', branch: 'feat/b02', make: 'cut', onInt: batchText('B02').replace('- [ ] first', '- [x] first') },
    { id: 'B05', status: '🔄', branch: 'feat/b05', make: 'cut', noFile: true }];
  const { repo, write } = ledgerFixture(t, specs), v = await verdicts();
  const at = () => `RECONCILE ${LEDGER_ID} @${repo.git('rev-parse', 'refs/heads/int').slice(0, 7)} shipment=not-needed`;
  const contradiction = 'B02 🔄 UNKNOWN onFirstParent: the tip lies on the integration history yet its checklist has a ticked item';
  // An unadvanced tip whose checklist cannot be read is UNKNOWN on that row alone.
  const noFile = 'B05 🔄 UNKNOWN onFirstParent: no single batch file for this row at the integration tip';
  assert.deepEqual(await rows(repo), { code: 2, lines: [at(), `B01 ❌ row 20: ${v[19]}`, contradiction, noFile] });
  const wt = path.join(repo.root, 'wt-fixup');
  repo.git('worktree', 'add', '-q', '-b', 'fix/B01-c1-followup', wt, 'int'); respell(repo, wt);
  // Cut and never committed to, the fix-up is an ancestor of the tip, but no merged fix.
  assert.deepEqual((await rows(repo)).lines[1], 'B01 ❌ UNKNOWN fixup: fix/B01-c1-followup lies on the integration history: cut, never advanced');
  repo.at(wt).write('fix.txt', 'fix\n'); repo.at(wt).commit('fix');
  assert.deepEqual((await rows(repo)).lines[1], `B01 ❌ row 21: ${v[20]}`);
  repo.git('merge', '-q', '--no-ff', '-m', 'merge fix-up', 'fix/B01-c1-followup');
  assert.deepEqual((await rows(repo)).lines.slice(0, 2), [at(), `B01 ❌ row 22 or 23: tip green → ${v[21]} | tip red → ${v[22]}`]);
  // Row 14 needs every member of the checkpoint's wave settled: one 🔄 member holds it at row 16.
  const merged = [{ id: 'B03', status: '🟢', branch: 'feat/b01', wave: 2 }, { id: 'B04', status: '🔄', branch: 'fix/B01-c1-followup', wave: 2 }];
  write([...specs, ...merged], '| C1 | W2 | all | final | ⬜ | — |');
  assert.deepEqual((await rows(repo)).lines.slice(4), [`B03 🟢 UNKNOWN integrated: missing`, `B04 🔄 row 13: ${v[12]}`]);
  write([...specs, { ...merged[0], branch: 'fix/B01-c1-followup' }, merged[1]], '| C1 | W2 | all | final | ⬜ | — |');
  assert.deepEqual((await rows(repo)).lines.slice(4), [`B03 🟢 row 16: ${v[15]}`, `B04 🔄 row 13: ${v[12]}`, `PRUNE ${wt}`]);
  write([...specs, { ...merged[0], branch: 'fix/B01-c1-followup' }, { ...merged[1], status: '⛔ green, residual finding open (P1)' }], '| C1 | W2 | all | final | ⬜ | — |');
  assert.deepEqual((await rows(repo)).lines.slice(4), [`B03 🟢 row 14: ${v[13]}`, `B04 ⛔ green, residual finding open (P1) row 24: ${v[23]}`, `PRUNE ${wt}`]);
  // Every settled kind: a 👤 or ⛔ (dropped) member (both skipped rows) leaves the wave settled.
  for (const status of ['👤', '⛔ (dropped)']) {
    write([...specs, { ...merged[0], branch: 'fix/B01-c1-followup' }, { ...merged[1], status }], '| C1 | W2 | all | final | ⬜ | — |');
    assert.deepEqual((await rows(repo)).lines.slice(4), [`B03 🟢 row 14: ${v[13]}`, `PRUNE ${wt}`], status);
  }
  // The contract must name the integration branch it is read from.
  repo.write(`${LEDGER_DIR}/00-READBEFORE.md`, contractText('local').replace('`int`', '`other`')); repo.commit('other');
  assert.deepEqual(await rows(repo), { code: 2, lines: ['UNKNOWN contract: its integration branch is other, not int'] });
});

test('rows: a third round on a repair branch is read on that branch, never the row\'s own', async t => {
  const specs = [{ id: 'B01', status: '🟢', branch: 'feat/b01', make: 'full', merge: true }];
  const { repo, write } = ledgerFixture(t, specs), v = await verdicts();
  const wt = path.join(repo.root, 'wt-tip');
  repo.git('worktree', 'add', '-q', '-b', 'fix/B01-tip', wt, 'int'); respell(repo, wt);
  repo.at(wt).write('repair.txt', 'rounds 1-2\n');
  const capped = repo.at(wt).commit('repair rounds').slice(0, 7);
  const notes = branch => `tip repair capped: fix/B01-tip → verdict 2026-09-01 fix again spent → third round on ${branch} @${capped}`;
  const line = async () => (await rows(repo)).lines[1];
  write([{ ...specs[0], notes: notes('fix/B01-tip') }]);
  assert.equal(await line(), `B01 🟢 row 1: ${v[0]}`);
  repo.at(wt).write('repair.txt', 'round 3\n'); repo.at(wt).commit('third round');
  assert.equal(await line(), `B01 🟢 row 2: ${v[1]}`);
  repo.git('merge', '-q', '--no-ff', '-m', 'merge repair', 'fix/B01-tip');
  assert.equal(await line(), `B01 🟢 row 16: ${v[15]}`, 'a merged third round leaves rows 1-2');
  write([{ ...specs[0], notes: notes('fix/B01-gone') }]);
  assert.equal(await line(), 'B01 🟢 UNKNOWN third: fix/B01-gone does not exist');
});

test('rows: worktrees that cannot be listed leave dirt UNKNOWN, never clean', async t => {
  const { reconcileRows } = await api;
  const { repo } = ledgerFixture(t, [{ id: 'B01', status: '🔄', branch: 'feat/b01', make: 'full' }]);
  const run = listWorktrees => reconcileRows({ repo: repo.cwd, ledger: LEDGER_ID, integration: INTEGRATION, protocolText: PROTOCOL, env: repo.env, listWorktrees });
  const v = await verdicts();
  assert.equal(run(undefined).lines[1], `B01 🔄 row 12: ${v[11]}`, 'the control: the real listing');
  assert.deepEqual(run(() => ({ evidence: { worktrees: [] }, diagnostics: [] })).lines.slice(1), ['B01 🔄 UNKNOWN dirty: git could not list the worktrees']);
});

// A skill directory beside the checkout: its tools, and a protocol.md of the test's choosing.
function skillCopy(t, protocolText) {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'reconcile-skill-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'tools')); fs.mkdirSync(path.join(dir, 'references'));
  for (const name of fs.readdirSync(TOOLS).filter(n => n.endsWith('.mjs'))) fs.copyFileSync(path.join(TOOLS, name), path.join(dir, 'tools', name));
  fs.writeFileSync(path.join(dir, 'references', 'protocol.md'), protocolText);
  return path.join(dir, 'tools', 'reconcile.mjs');
}

test('rows through a skill copy: a drifted table refuses with one UNKNOWN line, the checkout table runs', async t => {
  const { TABLE_DRIFT } = await api;
  const { repo } = ledgerFixture(t, [{ id: 'B01', status: '⬜', branch: 'feat/b01' }]);
  const args = ['rows', '--repo', repo.cwd, '--ledger', LEDGER_ID, '--integration', INTEGRATION];
  const control = cli(repo, args, skillCopy(t, PROTOCOL));
  assert.equal(control.status, 0); assert.match(control.lines[0], /^RECONCILE FIX-1 @[0-9a-f]{7} shipment=not-needed$/);
  const drifts = {
    swapped: mutate(PROTOCOL, r => { [r[5], r[6]] = [r[6], r[5]]; return r; }),
    removed: mutate(PROTOCOL, r => r.slice(0, -1)),
    reworded: mutate(PROTOCOL, r => { r[9] = recell(r[9], 0, c => c.replace('🔄', '🔄 or 🟢')); return r; }),
  };
  for (const [name, text] of Object.entries(drifts)) assert.deepEqual(cli(repo, args, skillCopy(t, text)), { status: 2, lines: [TABLE_DRIFT] }, name);
});

// ===== discovery ==========================================================================
const discoveryLedger = state => `# Progress\n\n${state === null ? '' : `**State**: ${state}\n`}\n## Batches\n\n**State**: IGNORED below the preamble\n`;

test('discovery: one line per ledger with its mode; disagreeing copies are AMBIGUOUS; partial evidence is INCOMPLETE', async t => {
  const { summarize } = await api, { discovery } = await evidence;
  const repo = repository(t), run = () => { const before = observe(repo), r = summarize(discovery({ repo: repo.cwd, env: repo.env }), { env: repo.env }); assert.deepEqual(observe(repo), before); return r; };
  assert.deepEqual(run(), { code: 0, lines: ['NO LEDGERS'] });
  const states = { 'L-ACTIVE': 'ACTIVE', 'L-CHECK': 'AT-CHECKPOINT C2', 'L-BLOCKED': 'USER-BLOCKED', 'L-DONE': 'COMPLETE', 'L-LEGACY': null };
  for (const [id, state] of Object.entries(states)) repo.write(`.agents/changes/${id}/PROGRESS.md`, discoveryLedger(state));
  repo.commit('ledgers');
  const at = id => `main, ${path.join(repo.cwd, '.agents/changes', id, 'PROGRESS.md')}`;
  const lines = ['L-ACTIVE State=ACTIVE', 'L-BLOCKED State=USER-BLOCKED', 'L-CHECK State=AT-CHECKPOINT C2', 'L-DONE State=COMPLETE', 'L-LEGACY State=none'];
  const modes = { 'L-ACTIVE': 'continue', 'L-BLOCKED': 'status', 'L-CHECK': 'close', 'L-DONE': 'none', 'L-LEGACY': 'status' };
  const expected = lines.map(l => { const id = l.split(' ')[0]; return `${l} at ${at(id)} → ${modes[id]}`; });
  assert.deepEqual(run(), { code: 0, lines: expected });
  assert.deepEqual(cli(repo, ['discovery', '--repo', repo.cwd]), { status: 0, lines: expected }, 'as published');
  // Another branch holding the same id with another State: AMBIGUOUS, exit 2.
  repo.git('checkout', '-q', '-b', 'other');
  repo.write('.agents/changes/L-ACTIVE/PROGRESS.md', discoveryLedger('COMPLETE')); repo.commit('complete elsewhere');
  repo.git('checkout', '-q', 'main');
  const split = run();
  assert.equal(split.code, 2);
  const wt = path.join(repo.cwd, '.agents/changes/L-ACTIVE/PROGRESS.md');
  assert.equal(split.lines[0], `L-ACTIVE at main, other, ${wt} → AMBIGUOUS (State differs: main=ACTIVE, other=COMPLETE, ${wt}=ACTIVE)`);
  assert.equal(split.lines[1], `L-BLOCKED State=USER-BLOCKED at main, other, ${path.join(repo.cwd, '.agents/changes/L-BLOCKED/PROGRESS.md')} → status`);
  // Partial evidence: a worktree whose directory is gone.
  repo.git('branch', '-q', '-D', 'other');
  const gone = path.join(repo.root, 'gone');
  repo.git('worktree', 'add', '-q', '-b', 'gone', gone, 'main');
  fs.rmSync(gone, { recursive: true, force: true });
  const partial = run();
  assert.equal(partial.code, 2);
  assert.equal(partial.lines[0], 'INCOMPLETE 1 diagnostic(s): worktree-unavailable');
  assert.deepEqual(partial.lines.slice(1).map(l => l.split(' ')[0]), ['L-ACTIVE', 'L-BLOCKED', 'L-CHECK', 'L-DONE', 'L-LEGACY']);
});

test('discovery: a State line in no accepted form, a repeated one, or an unreadable file is never a mode', async () => {
  const { stateOf, summarize } = await api;
  assert.equal(stateOf('# P\n**State**: ACTIVE\r\n## Batches\n'), 'ACTIVE');
  assert.equal(stateOf('# P\n**State**: ACTIVE\n**State**: COMPLETE\n'), 'repeated');
  assert.equal(stateOf('# P\n\n## Batches\n**State**: ACTIVE\n'), 'none', 'only the preamble counts');
  assert.equal(stateOf(null), 'unreadable');
  const one = (state, text = discoveryLedger(state)) => summarize({ completeness: 'complete', diagnostics: [], evidence: { ledgers: [{ id: 'L', locations: [{ kind: 'ref', ref: 'refs/heads/x', provenance: { progressText: text } }] }] } });
  for (const state of ['ACTIVE ', ' ACTIVE', 'active', 'AT-CHECKPOINT', 'AT-CHECKPOINT C', 'AT-CHECKPOINT C1 now', 'DONE']) {
    const r = one(state);
    assert.equal(r.code, 2, JSON.stringify(state)); assert.match(r.lines[0], / → UNKNOWN \(State .* is in no accepted form\)$/);
  }
  assert.deepEqual(one('ACTIVE'), { code: 0, lines: ['L State=ACTIVE at x → continue'] });
  assert.equal(one(null, null).code, 2);
  assert.equal(one(null, '# P\n**State**: ACTIVE\n**State**: ACTIVE\n').code, 2);
});

test('discovery prints a working ledger in Node\'s native spelling, however the evidence spells it', async () => {
  const { summarize } = await api;
  const base = fs.realpathSync(os.tmpdir()), native = path.join(base, 'wt-x', '.agents', 'changes', 'L', 'PROGRESS.md');
  for (const given of [`${base}/./wt-x/.agents/changes/L/PROGRESS.md`, `${base}//wt-x/.agents/changes/L/PROGRESS.md`]) {
    const found = { completeness: 'complete', diagnostics: [], evidence: { ledgers: [{ id: 'L', locations: [{ kind: 'worktree', path: given, progressText: discoveryLedger('ACTIVE') }] }] } };
    assert.notEqual(given, native, 'the control: a spelling that is not native');
    assert.deepEqual(summarize(found), { code: 0, lines: [`L State=ACTIVE at ${native} → continue`] }, given);
  }
});

// ===== discovery of archived ledgers ======================================================
// A ledger at a State, with a contract recording `remote origin`'s refs/heads/main as its shipment target and
// `integration` (`int` unless given) as its integration branch.
const writeLedger = (at, id, state, integration) => {
  at.write(`.agents/changes/${id}/PROGRESS.md`, discoveryLedger(state)); at.write(`.agents/changes/${id}/00-READBEFORE.md`, contractText('remote origin', undefined, integration));
};
const TARGET = 'remote origin refs/heads/main';
// The laptop's shape at C1: two closed ledgers archived on main and on the ledger branch checked out
// from it, each still held in .agents/changes/ by leftover refs — a batch branch whose copy says
// ACTIVE, a ledger branch and its unpruned origin twin at AT-CHECKPOINT C1 — beside the live ledger,
// and a ledger the leftover batch branch also holds, deleted where the other was archived. Every
// contract records `remote origin` as its shipment source: a bare repository whose main holds both
// archives, as a fetch left origin/main, and whose upload-pack records every query. L-SLIM's contract names its
// surviving ledger branch as its integration branch, so once its copies differ in State, only the archive cases
// coming before the integration-branch rule keep it archived rather than settled there.
function archivedFixture(t) {
  const repo = repository(t), bare = repo.remote(), ledger = (id, state) => writeLedger(repo, id, state, id === 'L-SLIM' ? 'chore/slim-ledger' : undefined);
  const archive = id => {
    ledger(id, 'COMPLETE'); fs.mkdirSync(path.join(repo.cwd, '.agents', 'archive'), { recursive: true });
    repo.git('mv', `.agents/changes/${id}`, `.agents/archive/${id}`);
  };
  repo.git('checkout', '-q', '-b', 'chore/mech-ledger');
  ledger('L-MECH', 'ACTIVE'); ledger('L-LIVE', 'ACTIVE'); repo.write('.agents/changes/L-MECH/02-batches-01-a.md', batchText('B01')); repo.commit('mech ledger');
  repo.git('branch', 'feat/mech-a');
  archive('L-MECH'); repo.git('rm', '-r', '-q', '.agents/changes/L-LIVE'); repo.commit('close mech');
  repo.git('checkout', '-q', '-b', 'chore/slim-ledger', 'main');
  ledger('L-SLIM', 'ACTIVE'); repo.commit('slim opens');
  ledger('L-SLIM', 'AT-CHECKPOINT C1'); repo.commit('slim at its checkpoint');
  repo.git('update-ref', 'refs/remotes/origin/chore/slim-ledger', 'HEAD');
  repo.git('checkout', '-q', '-b', 'close-slim'); archive('L-SLIM'); repo.commit('close slim');
  repo.git('checkout', '-q', 'main');
  for (const branch of ['chore/mech-ledger', 'close-slim']) repo.git('merge', '-q', '--no-ff', '-m', 'merge ' + branch, branch);
  repo.git('branch', '-q', '-D', 'chore/mech-ledger', 'close-slim');
  repo.git('push', '-q', 'origin', 'main');
  repo.git('checkout', '-q', '-b', 'chore/new-ledger'); ledger('L-NEW', 'ACTIVE'); repo.commit('new ledger');
  // A clone's origin/HEAD: a symbolic ref names another ref and holds nothing of its own.
  repo.git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/heads/main');
  const marker = path.join(repo.root, 'queried'), script = path.join(repo.root, 'upload-pack.sh');
  fs.writeFileSync(script, `#!/bin/sh\necho queried >> "${marker.split(path.sep).join('/')}"\nexec git upload-pack "$@"\n`, { mode: 0o755 });
  repo.git('config', 'remote.origin.uploadpack', script.split(path.sep).join('/'));
  // The remote queries since the last call.
  const queries = () => { const n = fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8').split('\n').filter(Boolean).length : 0; fs.rmSync(marker, { force: true }); return n; };
  // Every place a discovery run sees an id's archive: the refs whose commit holds it, then the main checkout.
  const archived = id => path.join(repo.cwd, '.agents', 'archive', id), seen = id => `chore/new-ledger, main, origin/main, ${archived(id)}`;
  const lines = {
    live: 'L-LIVE State=ACTIVE at feat/mech-a → continue',
    mech: `L-MECH State=archived at ${TARGET} → none (older copies: feat/mech-a=ACTIVE)`,
    fresh: `L-NEW State=ACTIVE at chore/new-ledger, ${path.join(repo.cwd, '.agents', 'changes', 'L-NEW', 'PROGRESS.md')} → continue`,
    slim: `L-SLIM State=archived at ${TARGET} → none (older copies: chore/slim-ledger=AT-CHECKPOINT C1, origin/chore/slim-ledger=AT-CHECKPOINT C1)`,
  };
  return { repo, bare, archived, seen, queries, lines };
}
// The summary run in-process, proven read-only; `env` is the one its archive probes run under.
async function summary(repo, env = repo.env) {
  const { summarize } = await api, { discovery } = await evidence, before = observe(repo);
  const r = summarize(discovery({ repo: repo.cwd, env: repo.env }), { env });
  assert.deepEqual(observe(repo), before, 'a discovery run changes no ref, worktree or status');
  return r;
}
// A tree object from `git ls-tree` lines, for trees no checkout holds.
function mktree(repo, entries) {
  const r = spawnSync('git', ['mktree'], { cwd: repo.cwd, env: repo.env, input: entries + '\n', encoding: 'utf8', windowsHide: true, timeout: 15000 });
  assert.ifError(r.error); assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}
// A ref whose tree holds a gitlink at `.agents/archive/<id>`, built from tree objects since no
// checkout holds one: git answers for it with neither a tree nor an absence.
function gitlinkRef(repo, ref, id) {
  const tree = mktree(repo, `040000 tree ${mktree(repo, `040000 tree ${mktree(repo, `160000 commit ${repo.base}\t${id}`)}\tarchive`)}\t.agents`);
  repo.git('update-ref', ref, repo.git('commit-tree', tree, '-m', 'a gitlink where an archive would be'));
}

test('discovery: a ledger archived at its shipment target, every copy older, routes to none on the laptop\'s leftover refs; offline it is AMBIGUOUS', async t => {
  const { summarize } = await api, { discovery } = await evidence;
  const { repo, bare, archived, seen, queries, lines: { live, mech, fresh, slim } } = archivedFixture(t);
  // As published. Before the repair this printed `L-MECH … → continue` and `L-SLIM … → close`, exit 0.
  // L-LIVE and L-NEW are the controls archived nowhere: they route by their State and ask no remote.
  assert.deepEqual(cli(repo, ['discovery', '--repo', repo.cwd]), { status: 0, lines: [live, mech, fresh, slim] });
  assert.equal(queries(), 2, 'each archived id asks the remote once, and no other id asks it');
  assert.deepEqual(await summary(repo), { code: 0, lines: [live, mech, fresh, slim] });
  // A configured log.follow leaves the commit that introduced each archive as it is.
  repo.git('config', 'log.follow', 'true');
  assert.deepEqual(await summary(repo), { code: 0, lines: [live, mech, fresh, slim] }, 'log.follow');
  repo.git('config', '--unset', 'log.follow');
  // Offline the target is unresolved, and each archived id stays visible: never continue or close.
  const away = `${bare.cwd}-away`, unresolved = id => `AMBIGUOUS (archived at ${seen(id)}; remote origin did not answer with refs/heads/main alone)`;
  fs.renameSync(bare.cwd, away);
  assert.deepEqual(await summary(repo), { code: 2, lines: [live, `L-MECH at feat/mech-a → ${unresolved('L-MECH')}`, fresh, `L-SLIM at chore/slim-ledger, origin/chore/slim-ledger → ${unresolved('L-SLIM')}`] });
  fs.renameSync(away, bare.cwd);
  // Unrelated later branch commits do not invalidate that proof: a leftover branch's own code commit.
  repo.git('checkout', '-q', 'feat/mech-a'); repo.write('code.txt', 'a dropped repair\n'); repo.commit('code only'); repo.git('checkout', '-q', 'chore/new-ledger');
  assert.deepEqual(await summary(repo), { code: 0, lines: [live, mech, fresh, slim] }, 'a commit outside the ledger');
  // Superseded copies need not agree: an origin twin left one commit further back still reads as archived.
  repo.git('update-ref', 'refs/remotes/origin/chore/slim-ledger', 'chore/slim-ledger~1');
  assert.equal((await summary(repo)).lines[3], `L-SLIM State=archived at ${TARGET} → none (older copies: chore/slim-ledger=AT-CHECKPOINT C1, origin/chore/slim-ledger=ACTIVE)`);
  repo.git('update-ref', 'refs/remotes/origin/chore/slim-ledger', 'chore/slim-ledger');
  // A copy no archive proves older stays visible: a commit on the leftover branch after the archive.
  repo.git('checkout', '-q', '-b', 'feat/mech-late', 'feat/mech-a');
  repo.write('.agents/changes/L-MECH/PROGRESS.md', discoveryLedger('AT-CHECKPOINT C2')); repo.commit('mech moves on');
  repo.git('checkout', '-q', 'chore/new-ledger');
  assert.deepEqual(await summary(repo), { code: 2, lines: ['L-LIVE State=ACTIVE at feat/mech-a, feat/mech-late → continue',
    `L-MECH at feat/mech-a, feat/mech-late → AMBIGUOUS (archived at ${TARGET}; not proven older: feat/mech-late=AT-CHECKPOINT C2)`, fresh, slim] });
  repo.git('branch', '-q', '-D', 'feat/mech-late');
  // A committed copy is proven older only by its last ledger-changing commit, holding that very subtree.
  const found = discovery({ repo: repo.cwd, env: repo.env });
  const doctored = change => { const clone = structuredClone(found); change(clone.evidence.ledgers.find(l => l.id === 'L-MECH').locations[0].provenance); return summarize(clone, { env: repo.env }); };
  assert.deepEqual(doctored(() => {}), { code: 0, lines: [live, mech, fresh, slim] }, 'the control: the copy as discovery found it');
  const unproven = { code: 2, lines: [live, `L-MECH at feat/mech-a → AMBIGUOUS (archived at ${TARGET}; not proven older: feat/mech-a=ACTIVE)`, fresh, slim] };
  assert.deepEqual(doctored(p => { p.lastChange = null; }), unproven, 'no last ledger-changing commit');
  assert.deepEqual(doctored(p => { p.lastChangeTree = p.tree.replace(/^./, c => c === '0' ? '1' : '0'); }), unproven, 'a last change holding another subtree');
  // An archive listing this tool cannot read: a git that does not run leaves only the checkout's
  // archive, which no commit is then proven to hold.
  assert.deepEqual(await summary(repo, { ...repo.env, PATH: repo.root, Path: repo.root }), { code: 2, lines: ['INCOMPLETE 1 diagnostic(s): archive-unavailable', live,
    `L-MECH at feat/mech-a → AMBIGUOUS (archived at ${archived('L-MECH')}; not proven committed: ${archived('L-MECH')})`, fresh,
    `L-SLIM at chore/slim-ledger, origin/chore/slim-ledger → AMBIGUOUS (archived at ${archived('L-SLIM')}; not proven committed: ${archived('L-SLIM')})`] });
  // A gitlink where an archive would be, then a ref whose commit git does not give: each leaves the
  // listing in doubt, and every ref git does answer for still holds what it holds.
  gitlinkRef(repo, 'refs/heads/odd', 'L-NEW');
  assert.deepEqual(await summary(repo), { code: 2, lines: ['INCOMPLETE 1 diagnostic(s): archive-unavailable', live, mech, fresh, slim] }, 'a gitlink');
  repo.git('update-ref', '-d', 'refs/heads/odd');
  repo.write('.git/refs/heads/broken', 'not-an-object\n');
  assert.deepEqual(await summary(repo), { code: 2, lines: ['INCOMPLETE 3 diagnostic(s): ref-inventory-warning, unobserved-loose-ref, archive-unavailable', live, mech, fresh, slim] }, 'a broken ref');
});

test('discovery: only an archive committed at the recorded shipment target supersedes; a target not read, shared or resolved is AMBIGUOUS', async t => {
  const { summarize } = await api, { discovery } = await evidence;
  const { repo, bare, seen, queries, lines: { live, mech, fresh, slim } } = archivedFixture(t);
  const line = (r, id) => r.lines.find(l => l.startsWith(id + ' '));
  // A trial archive on a branch the target does not hold supersedes nothing: L-NEW routes by its State, as before.
  repo.git('checkout', '-q', '-b', 'experiment'); repo.git('mv', '.agents/changes/L-NEW', '.agents/archive/L-NEW'); repo.commit('trial archive');
  repo.git('checkout', '-q', 'chore/new-ledger');
  assert.deepEqual(await summary(repo), { code: 0, lines: [live, mech, fresh, slim] }, 'a trial archive');
  assert.equal(queries(), 3, 'the trial archive prompts the lookup, and the target decides');
  repo.git('branch', '-q', '-D', 'experiment');
  // An id scaffolded again after its archive: its new copies are newer than that archive, never superseded by it,
  // even once merged into the target's own history.
  const shipped = bare.git('rev-parse', 'refs/heads/main');
  repo.git('checkout', '-q', '-b', 'chore/mech-again', 'main'); writeLedger(repo, 'L-MECH', 'ACTIVE'); repo.commit('mech again');
  const again = path.join(repo.cwd, '.agents', 'changes', 'L-MECH', 'PROGRESS.md'), rescaffolded = await summary(repo);
  assert.equal(rescaffolded.code, 2);
  assert.equal(line(rescaffolded, 'L-MECH'), `L-MECH at chore/mech-again, feat/mech-a, ${again} → AMBIGUOUS (archived at ${TARGET}; not proven older: chore/mech-again=ACTIVE, ${again}=ACTIVE)`);
  const merged = repo.git('commit-tree', 'chore/mech-again^{tree}', '-p', 'main', '-p', 'chore/mech-again', '-m', 'merge mech again');
  repo.git('update-ref', 'refs/heads/main', merged); repo.git('push', '-q', bare.cwd, 'refs/heads/main:refs/heads/main');
  const newer = `L-MECH at chore/mech-again, feat/mech-a, main, ${again} → AMBIGUOUS (archived at ${TARGET}; not proven older: chore/mech-again=ACTIVE, main=ACTIVE, ${again}=ACTIVE)`;
  assert.equal(line(await summary(repo), 'L-MECH'), newer);
  // Later commits at the target introduce no archive of this id: another ledger's close-out, then a touch of this
  // archive (its PROGRESS.md reformatted, a file filed beside it). The copies stay newer than the archive.
  const ship = async message => { repo.commit(message); repo.git('push', '-q', bare.cwd, 'refs/heads/main:refs/heads/main'); return summary(repo); };
  repo.git('checkout', '-q', 'main');
  repo.write('.agents/archive/L-OTHER/PROGRESS.md', discoveryLedger('COMPLETE'));
  let later = await ship('close other');
  assert.deepEqual([later.code, line(later, 'L-MECH')], [2, newer], 'another archive');
  fs.appendFileSync(path.join(repo.cwd, '.agents', 'archive', 'L-MECH', 'PROGRESS.md'), 'reformatted\n'); repo.write('.agents/archive/L-MECH/NOTES.md', 'filed late\n');
  later = await ship('touch the archive');
  assert.deepEqual([later.code, line(later, 'L-MECH')], [2, newer], 'a touched archive');
  // The archive dropped and restored after the ledger was scaffolded again: every copy predates its return, and
  // the target still holds the ledger itself.
  repo.git('rm', '-r', '-q', '.agents/archive/L-MECH'); repo.commit('drop the archive');
  repo.git('checkout', '-q', 'HEAD~1', '--', '.agents/archive/L-MECH');
  later = await ship('restore the archive');
  const holds = `L-MECH at chore/mech-again, feat/mech-a, main, ${again} → AMBIGUOUS (archived at ${TARGET}; ${TARGET} also holds .agents/changes/L-MECH/PROGRESS.md)`;
  assert.deepEqual([later.code, line(later, 'L-MECH')], [2, holds], 'a restored archive');
  // Any other entry at that path proves no absence either: a gitlink, from tree objects on top of the restore.
  const ledgerLink = mktree(repo, `040000 tree ${mktree(repo, `160000 commit ${repo.base}\tPROGRESS.md`)}\tL-MECH`);
  const agents = mktree(repo, `040000 tree ${repo.git('rev-parse', 'main:.agents/archive')}\tarchive\n040000 tree ${ledgerLink}\tchanges`);
  repo.git('push', '-q', bare.cwd, `${repo.git('commit-tree', mktree(repo, `040000 tree ${agents}\t.agents`), '-p', 'main', '-m', 'a gitlink where the ledger was')}:refs/heads/main`);
  later = await summary(repo);
  assert.deepEqual([later.code, line(later, 'L-MECH')], [2, holds], 'a gitlink');
  repo.git('checkout', '-q', 'chore/mech-again');
  repo.git('update-ref', 'refs/heads/main', shipped); bare.git('update-ref', 'refs/heads/main', shipped);
  repo.git('checkout', '-q', 'chore/new-ledger'); repo.git('branch', '-q', '-D', 'chore/mech-again');
  // The remote answers with its branch beside another ref ending in that name, then with the other ref alone,
  // then with neither: unresolved each time.
  const unresolved = why => `L-MECH at feat/mech-a → AMBIGUOUS (archived at ${seen('L-MECH')}; ${why})`, alone = 'remote origin did not answer with refs/heads/main alone';
  bare.git('update-ref', 'refs/x/refs/heads/main', shipped);
  assert.equal(line(await summary(repo), 'L-MECH'), unresolved(alone), 'two refs');
  bare.git('update-ref', '-d', 'refs/heads/main');
  assert.equal(line(await summary(repo), 'L-MECH'), unresolved(alone), 'another ref');
  bare.git('update-ref', '-d', 'refs/x/refs/heads/main');
  assert.equal(line(await summary(repo), 'L-MECH'), unresolved(alone), 'no such branch');
  // Its branch at a commit this clone does not hold, then at one whose tree holds a gitlink where the archive would be.
  const ahead = bare.git('commit-tree', `${shipped}^{tree}`, '-p', shipped, '-m', 'pushed from elsewhere');
  bare.git('update-ref', 'refs/heads/main', ahead);
  assert.equal(line(await summary(repo), 'L-MECH'), unresolved(`${TARGET} is at ${ahead.slice(0, 7)}, not a commit here`));
  gitlinkRef(repo, 'refs/heads/odd', 'L-MECH'); repo.git('push', '-q', bare.cwd, '+refs/heads/odd:refs/heads/main'); repo.git('update-ref', '-d', 'refs/heads/odd');
  assert.equal(line(await summary(repo), 'L-MECH'), unresolved(`${TARGET} cannot be read for .agents/archive/L-MECH/`));
  bare.git('update-ref', 'refs/heads/main', shipped);
  // Each copy's own contract names its target, read as `rows` reads one: the evidence doctored, git as found.
  const found = discovery({ repo: repo.cwd, env: repo.env });
  const contracts = textOf => {
    const clone = structuredClone(found);
    clone.evidence.ledgers.find(l => l.id === 'L-SLIM').locations.forEach((l, i) => {
      const list = l.provenance.contractTexts, at = list.findIndex(c => c.path.endsWith('/00-READBEFORE.md')), text = textOf(i);
      if (text === null) list.splice(at, 1); else list[at].text = text;
    });
    return line(summarize(clone, { env: repo.env }), 'L-SLIM');
  };
  const slimAt = 'chore/slim-ledger, origin/chore/slim-ledger', slimUnresolved = why => `L-SLIM at ${slimAt} → AMBIGUOUS (archived at ${seen('L-SLIM')}; ${why})`;
  assert.equal(contracts(() => contractText('remote origin')), slim, 'the control: the contracts as found');
  // A local source is the local ref, resolved here.
  assert.equal(contracts(() => contractText('local')), slim.replace(TARGET, 'local refs/heads/main'));
  assert.equal(contracts(() => contractText('local', 'refs/heads/gone')), slimUnresolved('local refs/heads/gone does not exist'));
  assert.equal(contracts(i => contractText(i ? 'local' : 'remote origin')), slimUnresolved(`shipment targets differ: chore/slim-ledger=${TARGET}, origin/chore/slim-ledger=local refs/heads/main`));
  // A target has three parts: the source above, then the ref, then the remote.
  assert.equal(contracts(i => contractText('remote origin', i ? 'refs/heads/release' : 'refs/heads/main')), slimUnresolved(`shipment targets differ: chore/slim-ledger=${TARGET}, origin/chore/slim-ledger=remote origin refs/heads/release`));
  assert.equal(contracts(i => contractText(i ? 'remote upstream' : 'remote origin')), slimUnresolved(`shipment targets differ: chore/slim-ledger=${TARGET}, origin/chore/slim-ledger=remote upstream refs/heads/main`));
  assert.equal(contracts(i => i ? null : contractText('remote origin')), slimUnresolved('no shipment target read from origin/chore/slim-ledger'));
  const unread = { 'a source in no form': contractText('somewhere else'), 'a short ref': contractText('remote origin', 'main'), 'no Git model': contractText('remote origin').replace('## Git model', '## Model'),
    'a remote-tracking ref': contractText('local', 'refs/remotes/origin/main'),
    'a revision, not a branch': contractText('local', 'refs/heads/main~1'),
    'a source that only begins with local': contractText('localhost'), 'a remote name run into other text': contractText('remote origin:main'),
    'a label given twice': contractText('remote origin').replace('\n\n## Other', '\n- Shipment source: `local`.\n\n## Other') };
  for (const [what, text] of Object.entries(unread)) assert.equal(contracts(() => text), slimUnresolved(`no shipment target read from ${slimAt}`), what);
});

test('discovery: a remote-tracking ref holding the archive prompts the lookup, and the remote itself decides', async t => {
  const repo = repository(t), bare = repo.remote();
  // A ledger closed and merged on the remote alone: this clone fetched it into origin/main, its own main is
  // behind, and a leftover batch branch still holds the ledger.
  repo.git('checkout', '-q', '-b', 'chore/l-ledger'); writeLedger(repo, 'L', 'ACTIVE'); repo.commit('ledger');
  repo.git('branch', 'feat/l-a');
  fs.mkdirSync(path.join(repo.cwd, '.agents', 'archive')); repo.git('mv', '.agents/changes/L', '.agents/archive/L'); repo.commit('close L');
  repo.git('push', '-q', 'origin', 'HEAD:refs/heads/main');
  repo.git('checkout', '-q', 'main'); repo.git('branch', '-q', '-D', 'chore/l-ledger');
  assert.deepEqual(await summary(repo), { code: 0, lines: [`L State=archived at ${TARGET} → none (older copies: feat/l-a=ACTIVE)`] });
  // The same cached ref while the remote's main no longer holds the archive: a cached ref is never the remote.
  bare.git('update-ref', 'refs/heads/main', repo.base);
  assert.deepEqual(await summary(repo), { code: 0, lines: ['L State=ACTIVE at feat/l-a → continue'] });
});

test('discovery: a checkout\'s copy is proven through its branch\'s until an uncommitted change touches the ledger; an archive its HEAD lacks settles nothing', async t => {
  const { summarize } = await api, { discovery } = await evidence;
  const { repo, queries, lines: { fresh, slim } } = archivedFixture(t);
  // A linked worktree of the leftover batch branch, which git lists in a spelling of its own.
  const wt = path.join(repo.root, 'wt-mech'), copy = (id, at = wt) => path.join(at, '.agents', 'changes', id, 'PROGRESS.md');
  repo.git('worktree', 'add', '-q', wt, 'feat/mech-a'); respell(repo, wt);
  const live = `L-LIVE State=ACTIVE at feat/mech-a, ${copy('L-LIVE')} → continue`;
  const none = `L-MECH State=archived at ${TARGET} → none (older copies: feat/mech-a=ACTIVE, ${copy('L-MECH')}=ACTIVE)`;
  const ambiguous = (at, unproven) => `L-MECH at ${at} → AMBIGUOUS (archived at ${TARGET}; not proven older: ${unproven})`;
  assert.deepEqual(await summary(repo), { code: 0, lines: [live, none, fresh, slim] });
  // A change outside the ledger, in the checkout or in another ledger (one whose id extends this one's
  // included), leaves the checkout's copy its branch's.
  const other = path.join(wt, '.agents', 'changes', 'L-MECH-2');
  fs.writeFileSync(path.join(wt, 'scratch.txt'), 'untracked\n'); fs.appendFileSync(copy('L-LIVE'), 'an uncommitted note\n');
  fs.mkdirSync(other); fs.writeFileSync(path.join(other, 'notes.md'), 'no PROGRESS.md, so no ledger line\n');
  assert.deepEqual(await summary(repo), { code: 0, lines: [live, none, fresh, slim] }, 'dirty outside the ledger');
  fs.rmSync(path.join(wt, 'scratch.txt')); fs.rmSync(other, { recursive: true }); repo.at(wt).git('checkout', '--', '.agents/changes/L-LIVE/PROGRESS.md');
  // An uncommitted change under the ledger, an edit or a rename out of it, makes the copy the checkout's own.
  fs.writeFileSync(copy('L-MECH'), discoveryLedger('USER-BLOCKED'));
  assert.deepEqual(await summary(repo), { code: 2, lines: [live, ambiguous(`feat/mech-a, ${copy('L-MECH')}`, `${copy('L-MECH')}=USER-BLOCKED`), fresh, slim] }, 'an edit');
  repo.at(wt).git('checkout', '--', '.agents/changes/L-MECH/PROGRESS.md');
  repo.at(wt).git('mv', '.agents/changes/L-MECH/02-batches-01-a.md', 'moved.md');
  assert.deepEqual(await summary(repo), { code: 2, lines: [live, ambiguous(`feat/mech-a, ${copy('L-MECH')}`, `${copy('L-MECH')}=ACTIVE`), fresh, slim] }, 'a rename out');
  repo.at(wt).git('mv', 'moved.md', '.agents/changes/L-MECH/02-batches-01-a.md');
  // A detached checkout has no branch copy to stand for; the rename undone, the other checkout's copy is its branch's again.
  const detached = path.join(repo.root, 'wt-detached');
  repo.git('worktree', 'add', '-q', '--detach', detached, 'feat/mech-a'); respell(repo, detached);
  assert.equal((await summary(repo)).lines[1], ambiguous(`feat/mech-a, ${copy('L-MECH', detached)}, ${copy('L-MECH')}`, `${copy('L-MECH', detached)}=ACTIVE`));
  repo.git('worktree', 'remove', detached);
  // Facts no fixture reaches: a checkout whose HEAD is not its branch's tip, and one whose status was not read.
  const found = discovery({ repo: repo.cwd, env: repo.env });
  const doctored = change => { const clone = structuredClone(found); change(clone.evidence.ledgers.find(l => l.id === 'L-MECH').locations.find(l => l.kind === 'worktree')); return summarize(clone, { env: repo.env }).lines[1]; };
  assert.equal(doctored(() => {}), none, 'the control: the checkout as discovery found it');
  assert.equal(doctored(l => { l.head = repo.git('rev-parse', 'main'); }), ambiguous(`feat/mech-a, ${copy('L-MECH')}`, `${copy('L-MECH')}=ACTIVE`), 'a HEAD its branch is not at');
  assert.equal(doctored(l => { l.cleanliness = 'unknown'; l.status = []; }), ambiguous(`feat/mech-a, ${copy('L-MECH')}`, `${copy('L-MECH')}=ACTIVE`), 'a status not read');
  // A clean checkout of a branch no archive proves older is no older than that branch.
  repo.at(wt).git('checkout', '-q', '-b', 'feat/mech-late');
  fs.writeFileSync(copy('L-MECH'), discoveryLedger('AT-CHECKPOINT C2')); repo.at(wt).commit('mech moves on');
  assert.equal((await summary(repo)).lines[1], ambiguous(`feat/mech-a, feat/mech-late, ${copy('L-MECH')}`, `feat/mech-late=AT-CHECKPOINT C2, ${copy('L-MECH')}=AT-CHECKPOINT C2`));
  // A close-out that crashed between its archive move and the commit: an archive no commit holds under its
  // checkout is an uncommitted ledger edit, and the committed copy stays visible.
  const solo = path.join(repo.root, 'wt-solo'), held = path.join(solo, '.agents', 'archive', 'L-SOLO'), line = (r, id) => r.lines.find(l => l.startsWith(id + ' '));
  repo.git('worktree', 'add', '-q', '-b', 'chore/solo-ledger', solo, 'main'); respell(repo, solo);
  writeLedger(repo.at(solo), 'L-SOLO', 'AT-CHECKPOINT C1'); repo.at(solo).commit('solo at its checkpoint');
  repo.at(solo).git('mv', '.agents/changes/L-SOLO', '.agents/archive/L-SOLO');
  assert.equal(line(await summary(repo), 'L-SOLO'), `L-SOLO at chore/solo-ledger → AMBIGUOUS (archived at ${held}; not proven committed: ${held})`);
  // An archive committed on a ref that is not the target settles nothing either, and a file where an
  // archive would be holds none, on a ref or in a checkout.
  repo.git('checkout', '-q', '-b', 'side', 'main');
  repo.write('.agents/archive/L-SOLO/PROGRESS.md', discoveryLedger('COMPLETE')); repo.write('.agents/archive/L-NEW', 'a file, not an archive\n'); repo.commit('stray archives');
  repo.git('checkout', '-q', 'chore/new-ledger');
  fs.writeFileSync(path.join(solo, '.agents', 'archive', 'L-LIVE'), 'a file, not an archive\n');
  queries();
  const stray = await summary(repo);
  assert.deepEqual(stray.lines.map(l => l.split(' ')[0]), ['L-LIVE', 'L-MECH', 'L-NEW', 'L-SLIM', 'L-SOLO'], 'a file reads as no archive, never as doubt');
  assert.equal(queries(), 2, 'a file prompts no lookup: only L-MECH and L-SLIM ask the remote');
  assert.equal(line(stray, 'L-SOLO'), `L-SOLO at chore/solo-ledger → AMBIGUOUS (archived at side, ${held}; not proven committed: ${held})`);
  assert.equal(line(stray, 'L-NEW'), fresh, 'a file on a ref');
  assert.equal(line(stray, 'L-LIVE'), `L-LIVE State=ACTIVE at feat/mech-a, feat/mech-late, ${copy('L-LIVE')} → continue`, 'a file in a checkout');
});

test('discovery: an archive at the target that no commit introduced with a PROGRESS.md proves no copy older', async t => {
  const repo = repository(t); repo.remote();
  // A ledger merged into the target and deleted there, its copy left on a batch branch, then an archive holding
  // no PROGRESS.md: the target holds no commit that introduced the archive, so the copy stays visible.
  repo.git('checkout', '-q', '-b', 'chore/l-ledger'); writeLedger(repo, 'L', 'ACTIVE'); repo.commit('ledger'); repo.git('branch', 'feat/l-a');
  repo.git('checkout', '-q', 'main'); repo.git('merge', '-q', '--no-ff', '-m', 'merge L', 'chore/l-ledger'); repo.git('branch', '-q', '-D', 'chore/l-ledger');
  repo.git('rm', '-r', '-q', '.agents/changes/L'); repo.write('.agents/archive/L/NOTES.md', 'no PROGRESS.md\n'); repo.commit('an archive without PROGRESS.md');
  repo.git('push', '-q', 'origin', 'main');
  assert.deepEqual(await summary(repo), { code: 2, lines: [`L at feat/l-a → AMBIGUOUS (archived at ${TARGET}; not proven older: feat/l-a=ACTIVE)`] });
  // The control: once a commit adds the archive's PROGRESS.md, the same copy is proven older, so that add alone decides.
  repo.write('.agents/archive/L/PROGRESS.md', discoveryLedger('COMPLETE')); repo.commit('the archive gains its PROGRESS.md');
  repo.git('push', '-q', 'origin', 'main');
  assert.deepEqual(await summary(repo), { code: 0, lines: [`L State=archived at ${TARGET} → none (older copies: feat/l-a=ACTIVE)`] });
});

// ===== discovery of a live ledger's own older copies =====================================
// L opens ACTIVE on `int`, the integration branch writeLedger's contract names; feat/b01 is cut from it, ticks its
// batch file and is merged; the close-out on `int` writes AT-CHECKPOINT C1, while feat/b01 keeps the ACTIVE copy of
// its own ledger commit, an ancestor of `int`. The main checkout stays on main, which holds no ledger. The remote's
// upload-pack records every query.
function ownedFixture(t) {
  const repo = repository(t), bare = repo.remote(), batch = '.agents/changes/L/02-batches-01-a.md';
  repo.git('checkout', '-q', '-b', 'int'); writeLedger(repo, 'L', 'ACTIVE'); repo.write(batch, batchText('B01')); repo.commit('L opens');
  repo.git('checkout', '-q', '-b', 'feat/b01'); repo.write(batch, batchText('B01').replace('- [ ] ', '- [x] ')); repo.write('b01.txt', 'B01\n'); repo.commit('B01 work');
  repo.git('checkout', '-q', 'int'); repo.git('merge', '-q', '--no-ff', '-m', 'merge B01', 'feat/b01');
  writeLedger(repo, 'L', 'AT-CHECKPOINT C1'); repo.commit('C1 close-out');
  repo.git('checkout', '-q', 'main');
  const marker = path.join(repo.root, 'queried'), script = path.join(repo.root, 'upload-pack.sh');
  fs.writeFileSync(script, `#!/bin/sh\necho queried >> "${marker.split(path.sep).join('/')}"\nexec git upload-pack "$@"\n`, { mode: 0o755 });
  repo.git('config', 'remote.origin.uploadpack', script.split(path.sep).join('/'));
  const queries = () => { const n = fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8').split('\n').filter(Boolean).length : 0; fs.rmSync(marker, { force: true }); return n; };
  // A commit on `base` made by `change` on a branch deleted again, so only the returned SHA remains.
  const commitOn = (base, change) => {
    repo.git('checkout', '-q', '-b', 'scratch', base); change();
    const sha = repo.commit('scratch'); repo.git('checkout', '-q', 'main'); repo.git('branch', '-q', '-D', 'scratch');
    return sha;
  };
  return { repo, bare, queries, commitOn };
}

test('discovery: copies proven older than their integration branch settle the line on its State; a newer copy, a divergent remote integration branch, or no copy on a local one leaves it AMBIGUOUS', async t => {
  const { summarize } = await api, { discovery } = await evidence;
  const { repo, queries, commitOn } = ownedFixture(t);
  const differs = (at, states) => ({ code: 2, lines: [`L at ${at} → AMBIGUOUS (State differs: ${states})`] });
  // As published. Before the fix this printed `L at feat/b01, int → AMBIGUOUS (State differs: feat/b01=ACTIVE, int=AT-CHECKPOINT C1)`, exit 2.
  const settled = 'L State=AT-CHECKPOINT C1 at feat/b01, int → close';
  assert.deepEqual(cli(repo, ['discovery', '--repo', repo.cwd]), { status: 0, lines: [settled] }, 'as published');
  assert.deepEqual(await summary(repo), { code: 0, lines: [settled] });
  // An earlier push of `int`; then a batch branch's remote copy, a remote branch whose name ends in `int` with no `/`
  // before it, and a local branch whose name ends in `/int`, each with a commit of its own outside the ledger: every
  // one older.
  repo.git('update-ref', 'refs/remotes/origin/int', 'int~1');
  repo.git('update-ref', 'refs/remotes/origin/feat/b01', commitOn('feat/b01', () => repo.write('more.txt', 'pushed\n')));
  repo.git('update-ref', 'refs/remotes/origin/print', commitOn('feat/b01', () => repo.write('print.txt', 'a print fix\n')));
  repo.git('update-ref', 'refs/heads/fix/int', commitOn('feat/b01', () => repo.write('fix.txt', 'a fix\n')));
  const all = 'feat/b01, fix/int, int, origin/feat/b01, origin/int, origin/print';
  const states = 'feat/b01=ACTIVE, fix/int=ACTIVE, int=AT-CHECKPOINT C1, origin/feat/b01=ACTIVE, origin/int=ACTIVE, origin/print=ACTIVE';
  assert.deepEqual(await summary(repo), { code: 0, lines: [`L State=AT-CHECKPOINT C1 at ${all} → close`] }, 'older remote copies');
  // origin/int at a commit git cannot test for ancestry, the evidence doctored: unknown is no proof.
  const found = discovery({ repo: repo.cwd, env: repo.env }), clone = structuredClone(found);
  clone.evidence.ledgers[0].locations.find(l => l.ref === 'refs/remotes/origin/int').sha = 'f'.repeat(40);
  assert.deepEqual(summarize(structuredClone(found), { env: repo.env }), { code: 0, lines: [`L State=AT-CHECKPOINT C1 at ${all} → close`] }, 'the control: the copies as discovery found them');
  assert.deepEqual(summarize(clone, { env: repo.env }), differs(all, states), 'origin/int unknown');
  // A remote-tracking copy's contract naming another integration branch, the evidence doctored: no one branch is named.
  const renamed = structuredClone(found), pushed = renamed.evidence.ledgers[0].locations.find(l => l.ref === 'refs/remotes/origin/feat/b01').provenance.contractTexts.find(c => c.path.endsWith('/00-READBEFORE.md'));
  pushed.text = pushed.text.replace('Integration branch: `int`', () => 'Integration branch: `int2`');
  assert.ok(pushed.text.includes('Integration branch: `int2`'), 'the control: the copy names int2');
  assert.deepEqual(summarize(renamed, { env: repo.env }), differs(all, states), 'a remote-tracking copy naming int2');
  // origin/int, then upstream/int, with a commit of its own outside the ledger: a divergent integration ref on any
  // remote, though its ledger change is old.
  const divergent = commitOn('int~1', () => repo.write('elsewhere.txt', 'pushed from elsewhere\n'));
  repo.git('update-ref', 'refs/remotes/origin/int', divergent);
  assert.deepEqual(await summary(repo), differs(all, states), 'a divergent origin/int');
  repo.git('update-ref', 'refs/remotes/origin/int', 'int~1'); repo.git('update-ref', 'refs/remotes/upstream/int', divergent);
  assert.deepEqual(await summary(repo), differs(`${all}, upstream/int`, `${states}, upstream/int=ACTIVE`), 'a divergent upstream/int');
  for (const ref of ['refs/remotes/origin/int', 'refs/remotes/origin/feat/b01', 'refs/remotes/origin/print', 'refs/remotes/upstream/int', 'refs/heads/fix/int']) repo.git('update-ref', '-d', ref);
  // A batch branch whose own ledger commit `int` lacks is newer, whatever State it writes: another, then int's own.
  repo.git('update-ref', 'refs/heads/feat/b02', commitOn('int', () => repo.write('.agents/changes/L/PROGRESS.md', discoveryLedger('USER-BLOCKED'))));
  assert.deepEqual(await summary(repo), differs('feat/b01, feat/b02, int', 'feat/b01=ACTIVE, feat/b02=USER-BLOCKED, int=AT-CHECKPOINT C1'), 'a newer ledger commit');
  repo.git('update-ref', 'refs/heads/feat/b02', commitOn('int', () => repo.write('.agents/changes/L/02-batches-02-b.md', batchText('B02'))));
  assert.deepEqual(await summary(repo), differs('feat/b01, feat/b02, int', 'feat/b01=ACTIVE, feat/b02=AT-CHECKPOINT C1, int=AT-CHECKPOINT C1'), 'a newer ledger commit agreeing with int');
  repo.git('branch', '-q', '-D', 'feat/b02');
  // The newer ledger commit pushed, held by a remote-tracking copy alone.
  repo.git('update-ref', 'refs/remotes/origin/feat/b02', commitOn('int', () => repo.write('.agents/changes/L/PROGRESS.md', discoveryLedger('USER-BLOCKED'))));
  assert.deepEqual(await summary(repo), differs('feat/b01, int, origin/feat/b02', 'feat/b01=ACTIVE, int=AT-CHECKPOINT C1, origin/feat/b02=USER-BLOCKED'), 'a newer remote-tracking copy');
  repo.git('update-ref', '-d', 'refs/remotes/origin/feat/b02');
  // No local `int`: an earlier push stands for it alone. Then a local `int` whose tip holds no copy, the ledger deleted
  // there, every other copy older than it.
  const tip = repo.git('rev-parse', 'int');
  repo.git('update-ref', 'refs/remotes/origin/int', tip); repo.git('branch', '-q', '-D', 'int');
  assert.deepEqual(await summary(repo), differs('feat/b01, origin/int', 'feat/b01=ACTIVE, origin/int=AT-CHECKPOINT C1'), 'no local int');
  repo.git('update-ref', 'refs/heads/int', commitOn(tip, () => repo.git('rm', '-r', '-q', '.agents/changes/L')));
  assert.deepEqual(await summary(repo), differs('feat/b01, origin/int', 'feat/b01=ACTIVE, origin/int=AT-CHECKPOINT C1'), 'an int that holds no copy');
  repo.git('update-ref', 'refs/heads/int', tip);
  assert.deepEqual(await summary(repo), { code: 0, lines: [`L State=AT-CHECKPOINT C1 at feat/b01, int, origin/int → close`] }, 'int restored');
  // Every proof is local: no run asked the remote. The control: a query of it is counted.
  assert.equal(queries(), 0, 'no discovery run asks the remote');
  repo.git('ls-remote', '-q', 'origin');
  assert.equal(queries(), 1, 'the control: a query of the remote is counted');
});

test('discovery: a checkout stands for its branch\'s copy, the integration branch\'s included, until an uncommitted change touches the ledger', async t => {
  const { summarize } = await api, { discovery } = await evidence;
  const { repo } = ownedFixture(t);
  // Linked worktrees of `int` and of the batch branch, which git lists in spellings of their own.
  const onInt = path.join(repo.root, 'wt-int'), onBatch = path.join(repo.root, 'wt-b01'), copy = (at, file = 'PROGRESS.md') => path.join(at, '.agents', 'changes', 'L', file);
  repo.git('worktree', 'add', '-q', onInt, 'int'); respell(repo, onInt);
  repo.git('worktree', 'add', '-q', onBatch, 'feat/b01'); respell(repo, onBatch);
  const at = `feat/b01, int, ${copy(onBatch)}, ${copy(onInt)}`, settled = { code: 0, lines: [`L State=AT-CHECKPOINT C1 at ${at} → close`] };
  const differs = (batch, int) => ({ code: 2, lines: [`L at ${at} → AMBIGUOUS (State differs: feat/b01=ACTIVE, int=AT-CHECKPOINT C1, ${copy(onBatch)}=${batch}, ${copy(onInt)}=${int})`] });
  assert.deepEqual(await summary(repo), settled);
  // A change outside the ledger leaves each checkout's copy its branch's.
  for (const wt of [onInt, onBatch]) fs.writeFileSync(path.join(wt, 'scratch.txt'), 'untracked\n');
  assert.deepEqual(await summary(repo), settled, 'changes outside the ledger');
  // On the integration branch, an uncommitted edit that changes the State, then one that keeps it.
  fs.writeFileSync(copy(onInt), discoveryLedger('USER-BLOCKED'));
  assert.deepEqual(await summary(repo), differs('ACTIVE', 'USER-BLOCKED'), 'a State edited on int');
  fs.appendFileSync(copy(onInt, '02-batches-01-a.md'), '- [ ] polish: an uncommitted item\n'); fs.writeFileSync(copy(onInt), discoveryLedger('AT-CHECKPOINT C1'));
  assert.deepEqual(await summary(repo), differs('ACTIVE', 'AT-CHECKPOINT C1'), 'a batch file edited on int');
  repo.at(onInt).git('checkout', '--', '.agents/changes/L/');
  // On the batch branch, an uncommitted edit under the ledger.
  fs.appendFileSync(copy(onBatch, '02-batches-01-a.md'), '- [ ] polish: an uncommitted item\n');
  assert.deepEqual(await summary(repo), differs('ACTIVE', 'AT-CHECKPOINT C1'), 'a batch file edited on feat/b01');
  repo.at(onBatch).git('checkout', '--', '.agents/changes/L/');
  assert.deepEqual(await summary(repo), settled, 'the edits undone');
  // A State edit git status does not see, under assume-unchanged and under skip-worktree, on each checkout: the State
  // read there is not its branch's. The control for each: status is silent about the ledger.
  const file = '.agents/changes/L/PROGRESS.md', hidden = [];
  for (const [wt, want] of [[onInt, differs('ACTIVE', 'USER-BLOCKED')], [onBatch, differs('USER-BLOCKED', 'AT-CHECKPOINT C1')]]) {
    for (const flag of ['assume-unchanged', 'skip-worktree']) {
      const tree = repo.at(wt);
      tree.git('update-index', `--${flag}`, file); fs.writeFileSync(copy(wt), discoveryLedger('USER-BLOCKED'));
      const silent = !tree.git('status', '--porcelain', '--untracked-files=all').includes('.agents/'), got = await summary(repo);
      if (!silent || !isDeepStrictEqual(got, want)) hidden.push({ flag, wt, silent, got });
      tree.git('update-index', `--no-${flag}`, file); tree.git('checkout', '--', file);
    }
  }
  assert.deepEqual(hidden, [], 'each hidden State edit: status silent, the line AMBIGUOUS');
  assert.deepEqual(await summary(repo), settled, 'the hidden edits undone');
  // Facts no fixture reaches, the evidence doctored, git as found: a checkout whose HEAD is not its branch's tip, and one
  // read clean at another State (an edit after its status was read).
  const found = discovery({ repo: repo.cwd, env: repo.env }), stale = repo.git('rev-parse', 'int~1');
  const doctored = (branch, change) => { const clone = structuredClone(found); change(clone.evidence.ledgers[0].locations.find(l => l.kind === 'worktree' && l.branch === branch)); return summarize(clone, { env: repo.env }); };
  assert.deepEqual(summarize(structuredClone(found), { env: repo.env }), settled, 'the control: the checkouts as discovery found them');
  assert.deepEqual(found.evidence.ledgers[0].locations.filter(l => l.kind === 'worktree').map(l => l.branch), ['refs/heads/feat/b01', 'refs/heads/int'], 'the control: discovery lists both checkouts');
  const unsettled = [];
  for (const branch of ['refs/heads/feat/b01', 'refs/heads/int']) {
    const blocked = branch === 'refs/heads/int' ? differs('ACTIVE', 'USER-BLOCKED') : differs('USER-BLOCKED', 'AT-CHECKPOINT C1');
    for (const [what, change, want] of [['a HEAD its branch is not at', l => { l.head = stale; }, differs('ACTIVE', 'AT-CHECKPOINT C1')],
      ['clean at another State', l => { l.cleanliness = 'clean'; l.status = []; l.progressText = discoveryLedger('USER-BLOCKED'); }, blocked]]) {
      const got = doctored(branch, change);
      if (!isDeepStrictEqual(got, want)) unsettled.push({ what, branch, got });
    }
  }
  assert.deepEqual(unsettled, [], 'each doctored checkout leaves the line AMBIGUOUS');
  // Discovery spells a checkout's contract path natively; in either separator the contract is read: as found it
  // settles, and int's checkout contract naming `int2` leaves the line AMBIGUOUS.
  const contractFile = /(?:^|[\\/])00-READBEFORE\.md$/;
  const contracts = found.evidence.ledgers[0].locations.filter(l => l.kind === 'worktree').flatMap(l => l.contractTexts).filter(c => contractFile.test(c.path));
  assert.equal(contracts.length, 2, 'the control: each checkout copy carries its contract');
  const spelled = (sep, name) => {
    const clone = structuredClone(found);
    let renamed = 0;
    for (const l of clone.evidence.ledgers[0].locations) {
      for (const c of l.contractTexts ?? []) {
        c.path = c.path.split(/[\\/]/).join(sep);
        if (name && l.branch === 'refs/heads/int' && contractFile.test(c.path)) { c.text = c.text.replace('Integration branch: `int`', () => `Integration branch: \`${name}\``); renamed += c.text.includes(`\`${name}\``) ? 1 : 0; }
      }
    }
    assert.equal(renamed, name ? 1 : 0, 'the control: int\'s checkout contract names the branch given');
    return summarize(clone, { env: repo.env });
  };
  const misread = ['\\', '/'].flatMap(sep => [[sep, undefined, settled], [sep, 'int2', differs('ACTIVE', 'AT-CHECKPOINT C1')]])
    .filter(([sep, name, want]) => !isDeepStrictEqual(spelled(sep, name), want)).map(([sep, name]) => `${sep} ${name ?? 'int'}`);
  assert.deepEqual(misread, [], 'a checkout contract path in either separator is read');
  // A detached checkout at int's tip has no branch copy to stand for.
  const detached = path.join(repo.root, 'wt-detached');
  repo.git('worktree', 'add', '-q', '--detach', detached, 'int'); respell(repo, detached);
  const three = `feat/b01, int, ${copy(onBatch)}, ${copy(detached)}, ${copy(onInt)}`;
  assert.deepEqual(await summary(repo), { code: 2, lines: [`L at ${three} → AMBIGUOUS (State differs: feat/b01=ACTIVE, int=AT-CHECKPOINT C1, ${copy(onBatch)}=ACTIVE, ${copy(detached)}=AT-CHECKPOINT C1, ${copy(onInt)}=AT-CHECKPOINT C1)`] }, 'a detached checkout');
});

test('discovery: every copy\'s contract names one integration branch, its copy at the tip git resolves, and git answers each proof, or the line stays AMBIGUOUS', async t => {
  const { summarize } = await api, { discovery } = await evidence;
  const { repo, commitOn } = ownedFixture(t);
  const settled = { code: 0, lines: ['L State=AT-CHECKPOINT C1 at feat/b01, int → close'] };
  const differs = { code: 2, lines: ['L at feat/b01, int → AMBIGUOUS (State differs: feat/b01=ACTIVE, int=AT-CHECKPOINT C1)'] };
  // The evidence doctored copy by copy (feat/b01's first, int's second), git as found.
  const found = discovery({ repo: repo.cwd, env: repo.env });
  const doctored = change => { const clone = structuredClone(found); clone.evidence.ledgers[0].locations.forEach((l, i) => change(l, i)); return summarize(clone, { env: repo.env }); };
  assert.deepEqual(doctored(() => {}), settled, 'the control: the copies as discovery found them');
  // Each copy's contract read as `rows` reads one: `refs/heads/int` is `int`, beside it or in both copies.
  const contract = (l, text) => { const list = l.provenance.contractTexts, at = list.findIndex(c => c.path.endsWith('/00-READBEFORE.md')); if (text === null) list.splice(at, 1); else list[at].text = text; };
  const naming = name => contractText('remote origin').replace('Integration branch: `int`', () => `Integration branch: \`${name}\``);
  assert.ok(naming('x').includes('Integration branch: `x`'), 'the control: the contract names the branch it is given');
  assert.deepEqual(doctored((l, i) => contract(l, naming(i ? 'refs/heads/int' : 'int'))), settled, 'refs/heads/int beside int');
  assert.deepEqual(doctored(l => contract(l, naming('refs/heads/int'))), settled, 'refs/heads/int in both');
  const unread = { 'no contract': null, 'no Git model': contractText('remote origin').replace('## Git model', '## Model'),
    'no Integration branch label': contractText('remote origin').replace('Integration branch: `int` — the ledger branch.', ''),
    'the label given twice': contractText('remote origin').replace('\n\n## Other', '\n- Integration branch: `int`.\n\n## Other'),
    'another integration branch': naming('int2'), 'an empty branch name': naming('refs/heads/') };
  const settledInstead = [0, 1].flatMap(which => Object.entries(unread)
    .filter(([, text]) => !isDeepStrictEqual(doctored((l, i) => { if (i === which) contract(l, text); }), differs)).map(([what]) => `${what}, copy ${which}`));
  assert.deepEqual(settledInstead, [], 'each contract not naming the one integration branch, on either copy, leaves the line AMBIGUOUS');
  // The integration branch's copy must be the one at its tip; every copy, that one included, is proven by its last
  // ledger-changing commit, holding that very subtree, which git finds an ancestor of the tip.
  const older = repo.git('rev-parse', 'int~1');
  assert.deepEqual(doctored((l, i) => { if (i === 1) l.sha = older; }), differs, 'int\'s copy read at another commit');
  // The tip is read from git, never from the evidence: `int` moved on after discovery read it, then a name git is never
  // asked about (an unsafe revision), though the evidence holds a ref of that name at int's tip.
  const tip = repo.git('rev-parse', 'int');
  repo.git('update-ref', 'refs/heads/int', commitOn('int', () => repo.write('.agents/changes/L/PROGRESS.md', discoveryLedger('USER-BLOCKED'))));
  assert.deepEqual(doctored(() => {}), differs, 'int moved after discovery');
  repo.git('update-ref', 'refs/heads/int', tip);
  assert.deepEqual(doctored(() => {}), settled, 'the control: int back at the tip discovery read');
  assert.deepEqual(doctored((l, i) => { contract(l, naming('int x')); if (i === 1) l.ref = 'refs/heads/int x'; }),
    { code: 2, lines: ['L at feat/b01, int x → AMBIGUOUS (State differs: feat/b01=ACTIVE, int x=AT-CHECKPOINT C1)'] }, 'an unsafe revision');
  assert.deepEqual(doctored((l, i) => { if (i === 1) l.provenance.lastChange = null; }), differs, 'int\'s copy with no last ledger-changing commit');
  assert.deepEqual(doctored((l, i) => { if (i === 0) l.provenance.lastChange = null; }), differs, 'no last ledger-changing commit');
  assert.deepEqual(doctored((l, i) => { if (i === 0) l.provenance.lastChangeTree = l.provenance.tree.replace(/^./, c => c === '0' ? '1' : '0'); }), differs, 'a last change holding another subtree');
  assert.deepEqual(doctored((l, i) => { if (i === 0) l.provenance.lastChange = 'f'.repeat(40); }), differs, 'a last change git cannot test: ancestry unknown');
  // The settled State is read as any other: one in no accepted form is UNKNOWN, an empty one included, never State differs.
  assert.deepEqual(doctored((l, i) => { if (i === 1) l.provenance.progressText = discoveryLedger('DONE'); }), { code: 2, lines: ['L State=DONE at feat/b01, int → UNKNOWN (State DONE is in no accepted form)'] });
  assert.deepEqual(doctored((l, i) => { if (i === 1) l.provenance.progressText = discoveryLedger(''); }), { code: 2, lines: ['L State= at feat/b01, int → UNKNOWN (State  is in no accepted form)'] }, 'an empty State');
  // A git that does not run: the tip is not resolved, and the line stays AMBIGUOUS, never a throw. The archive listing
  // is in doubt too.
  assert.deepEqual(await summary(repo, { ...repo.env, PATH: repo.root, Path: repo.root }), { code: 2, lines: ['INCOMPLETE 1 diagnostic(s): archive-unavailable', ...differs.lines] }, 'git not found');
  // Copies carrying no contract, as the synthetic calls in tests/tool-docs.test.cjs give them, ask git nothing: an env
  // whose keys are read only by a git probe stays unread. The control: the same copies with their contracts ask git.
  const asks = locations => {
    let read = false;
    const env = new Proxy({ ...repo.env }, { ownKeys: target => { read = true; return Reflect.ownKeys(target); } });
    summarize({ repo: repo.cwd, completeness: 'complete', diagnostics: [], evidence: { ledgers: [{ id: 'L', locations }] } }, { env });
    return read;
  };
  const copies = found.evidence.ledgers[0].locations;
  assert.equal(asks(structuredClone(copies)), true, 'the control: copies with their contracts ask git');
  assert.equal(asks(copies.map(l => ({ ...structuredClone(l), provenance: { ...structuredClone(l.provenance), contractTexts: [] } }))), false, 'copies with no contract ask git nothing');
});

test('the CLI: --help, and every invalid invocation is one UNKNOWN line with exit 2', async t => {
  const repo = repository(t);
  const help = cli(repo, ['--help']);
  assert.equal(help.status, 0); assert.match(help.lines[0], /^reconcile\.mjs discovery --repo <repo>$/);
  assert.ok(help.lines.some(l => l.includes('runs no validation')), 'HELP says reconcile runs no validation');
  // The State-differs passage, whole: copies proven older settle on the integration branch's State, never always AMBIGUOUS.
  const flat = help.lines.join(' ').replace(/\s+/g, ' '), from = 'Copies of one id that disagree on State', to = "SKILL.md §Discovery's provenance rules to";
  const start = flat.indexOf(from), end = flat.indexOf(to, start);
  assert.ok(start >= 0 && end > start, 'the passage bounds resolve in --help');
  assert.equal(flat.slice(start, end + to.length), "Copies of one id that disagree on State settle on the State their integration branch holds when every copy's contract"
    + ' names that branch, its tip holds a copy, and every other copy is proven older than that tip as an archive proves one below (a remote-tracking'
    + ' copy of that branch with its own tip an ancestor too); otherwise, a checkout of that branch with an uncommitted ledger edit included, they print'
    + " `→ AMBIGUOUS (State differs: <location>=<value>, …)`: apply SKILL.md §Discovery's provenance rules to");
  // Once, and nowhere else: --help states the rule in that passage alone, so a contradiction planted elsewhere reddens.
  assert.deepEqual(['disagree on State', 'State differs', 'AMBIGUOUS'].map(w => flat.split(w).length - 1), [1, 1, 3], 'HELP states the State-differs rule once');
  assert.equal(flat.split(from).length, 2, 'the passage appears once');
  const rest = flat.slice(0, start) + flat.slice(end + to.length);
  assert.deepEqual([/disagree on State/, /State differs/].filter(re => re.test(rest)), [], '--help says nothing else of disagreeing States');
  const { reconcileCli } = await api;
  for (const args of [[], ['status'], ['discovery'], ['discovery', '--repo'], ['rows', '--repo', '.', '--ledger', 'X'], ['discovery', '--repo', '.', '--extra', 'x'], ['--help', 'x']]) {
    const r = reconcileCli(args);
    assert.equal(r.code, 2, JSON.stringify(args)); assert.deepEqual(r.lines, ['UNKNOWN usage: unknown operation, or an unknown, missing or duplicate flag; use --help']);
  }
  for (const [ledger, integration] of [['../x', INTEGRATION], [LEDGER_ID, 'int'], [LEDGER_ID, 'refs/remotes/origin/int']]) {
    const r = await (await api).reconcileRows({ repo: repo.cwd, ledger, integration, protocolText: PROTOCOL, env: repo.env });
    assert.equal(r.code, 2); assert.match(r.lines[0], /^UNKNOWN usage: /);
  }
  assert.deepEqual(reconcileCli(['rows', '--repo', repo.cwd, '--ledger', LEDGER_ID, '--integration', INTEGRATION], path.join(repo.root, 'no-such-protocol.md')).lines, [(await api).TABLE_DRIFT]);
});
