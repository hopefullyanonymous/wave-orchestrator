'use strict';
// orchestrate-mod/hooks/view.js in-process: the formatters, the readers of the two tools' output, and the lines of
// the /ledger pane, the band and the text fallback. The readers are also bound to their producers, run here
// in-process: orchestrate-mod/tools/ledger-view.mjs `ledgerView` on a fixture repository and
// orchestrate-mod/tools/cost-report.mjs `costReport` on a records directory.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');
const { makeRepo } = require('./support/git-fixture.cjs');

const ROOT = path.resolve(__dirname, '..');
const SKILL = path.join(ROOT, 'orchestrate');
const load = file => import(pathToFileURL(path.join(ROOT, file)).href);
const view = load('orchestrate-mod/hooks/view.js');
const cost = load('orchestrate-mod/hooks/cost.js');
const ledgerViewTool = load('orchestrate-mod/tools/ledger-view.mjs');
const costReportTool = load('orchestrate-mod/tools/cost-report.mjs');
const PROTOCOL = fs.readFileSync(path.join(SKILL, 'references', 'protocol.md'), 'utf8').replace(/\r\n/g, '\n');
const withoutTestContext = env => Object.fromEntries(Object.entries(env).filter(([key]) => key.toUpperCase() !== 'NODE_TEST_CONTEXT'));

const T0 = 1791460800000; // 2026-10-08T12:00:00.000Z
const MIN = 60000;
const ID = 'OS-20261008-ledger-mod';
const sp = n => ' '.repeat(n);
const ok = stdout => ({ exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false });
const ledgerOf = (over = {}) => ({
  id: ID, state: 'ACTIVE', integration: { branch: 'chore/ledger-mod-ledger', sha: '9f3c2e1' + '0'.repeat(33) }, skillDir: '/s', waves: 2, currentWave: 2, nextCheckpoint: 'C1',
  rows: [
    { id: 'B01', title: 'cost log', branch: 'feat/a', wave: 1, weight: 'M', status: '✅', round: 'R1 SHIP', roundError: null, git: null },
    { id: 'B02', title: 'compaction', branch: 'feat/b', wave: 1, weight: 'S', status: '🟢', round: 'R1 SHIP', roundError: null, git: { row: '7', verdict: 'merged at fb69885' } },
    { id: 'B03', title: 'pane', branch: 'feat/c', wave: 2, weight: 'M', status: '🔄', round: 'R2 SHIP', roundError: null, git: { unknown: 'branch feat/c: not found' } },
  ],
  checkpoints: [], error: null, warning: null, ...over,
});
// Every reading known: the data object orchestrate-mod/hooks/register.js `load` builds.
const dataOf = (over = {}) => ({
  at: T0 + 12 * MIN, tzOffset: 0, root: '/repo', tag: ID, view: { incomplete: false, ledger: ledgerOf(), more: 0 },
  costs: { ledger: ID, total: { usd: 24.33, unpriced: 0 }, byBatch: { B01: { usd: 11.84, unpriced: 0 }, B03: { usd: 9.47, unpriced: 0 } } },
  agents: [{ known: true, role: 'implementer', batch: 'B03', firstSeen: T0, ctx: 211000, usd: 0.294, unpriced: 0 }, { known: false, type: 'Explore' }],
  conductor: { tokens: 412345, window: 1000000, percent: 41 }, session: { usd: 2.694, unpriced: 0 }, slashCost: 2.75, ...over,
});
const ROWS = [
  'B01 ✅ W1 M  cost log' + sp(4) + 'R1 SHIP' + sp(16) + '$11.84',
  'B02 🟢 W1 S  compaction  R1 SHIP  git: row 7' + sp(5) + '$0.00',
  { text: '    merged at fb69885', dim: true },
  'B03 🔄 W2 M  pane' + sp(8) + 'R2 SHIP  git: unknown' + sp(3) + '$9.47',
  { text: '    branch feat/c: not found', dim: true },
];
const TAIL = ['running  implementer  B03  12m  211K ctx  $0.29', sp(9) + 'Explore      ?     ?m     ? ctx      ?',
  'conductor  412K of 1M (41%) · safe point at 300K', 'ledger $24.33 · session $2.69 · /cost $2.75 (-2.0%)'];
const lined = items => items.map(item => (typeof item === 'string' ? { text: item, dim: false } : item));

// ===== Formatters ======================================================================

test('tokens round to the nearest thousand on both sides of a half, the window reads 1M only at 1,000,000', async () => {
  const { tokensK, windowText } = await view;
  assert.deepEqual([0, 499, 500, 1499, 1500, 412345, 211000].map(tokensK), ['0K', '0K', '1K', '1K', '2K', '412K', '211K']);
  assert.deepEqual([1000000, 999999, 1000001, 200000].map(windowText), ['1M', '1000K', '1000K', '200K']);
});

test('dollars to two decimals; a total leaving unpriced records out reads +?', async () => {
  const { dollars } = await view;
  assert.deepEqual([0, 2.694, 24.33].map(dollars), ['$0.00', '$2.69', '$24.33']);
  assert.equal(dollars({ usd: 9.47, unpriced: 1 }), '$9.47+?');
  assert.equal(dollars({ usd: 0, unpriced: 0 }), '$0.00');
  assert.equal(dollars({ usd: 0, unpriced: 3 }), '$0.00+?');
});

test('minutes are whole and floored: 59.999 s is 0, 60 s is 1', async () => {
  const { minutes } = await view;
  assert.deepEqual([0, 59999, 60000, 12 * MIN, 12 * MIN + 59999, -5].map(minutes), ['0', '0', '1', '12', '12', '0']);
});

test('the /cost delta is signed to one decimal, above and below, and never -0.0', async () => {
  const { delta } = await view;
  assert.equal(delta({ usd: 2.694, unpriced: 0 }, 2.75), '-2.0%');
  assert.equal(delta({ usd: 2.75, unpriced: 0 }, 2.5), '+10.0%');
  assert.equal(delta({ usd: 2.5, unpriced: 0 }, 2.5), '+0.0%');
  assert.equal(delta({ usd: 99.96, unpriced: 0 }, 100), '+0.0%');
  assert.equal(delta({ usd: 99.9, unpriced: 0 }, 100), '-0.1%');
  assert.equal(delta({ usd: 100.1, unpriced: 0 }, 100), '+0.1%');
});

test('the data\'s time in the zone it was read in', async () => {
  const { clock } = await view;
  assert.equal(clock(T0, 0), '12:00:00');
  assert.equal(clock(T0 + 12 * MIN + 5000, 0), '12:12:05');
  assert.equal(clock(T0, -120), '14:00:00');
  assert.equal(clock(T0, 330), '06:30:00');
});

test('a ledger id with its eight-digit date elided; any other id as it is', async () => {
  const { shortId } = await view;
  assert.equal(shortId(ID), 'OS-…-ledger-mod');
  assert.equal(shortId('L-20260101-a-b'), 'L-…-a-b');
  assert.equal(shortId('OS-2026100-x'), 'OS-2026100-x');
  assert.equal(shortId('OS-202610081-x'), 'OS-202610081-x');
  assert.equal(shortId('os_2026.10-x'), 'os_2026.10-x');
});

test('unknown is never zero: every formatter answers ? for a missing, non-finite, negative or mistyped value', async () => {
  const { tokensK, windowText, dollars, minutes, delta, clock } = await view;
  for (const bad of [undefined, null, NaN, Infinity, '5', {}]) {
    assert.equal(tokensK(bad), '?', String(bad));
    assert.equal(windowText(bad), '?', String(bad));
    assert.equal(dollars(bad), '?', String(bad));
    assert.equal(minutes(bad), '?', String(bad));
    assert.equal(clock(bad, 0), '?', String(bad));
    assert.equal(clock(T0, bad), '?', String(bad));
  }
  assert.equal(tokensK(-1), '?');
  for (const bad of [{ usd: NaN, unpriced: 0 }, { usd: 1 }, { usd: 1, unpriced: -1 }, { usd: 1, unpriced: 0.5 }, { usd: '1', unpriced: 0 }]) assert.equal(dollars(bad), '?', JSON.stringify(bad));
  const priced = { usd: 2.5, unpriced: 0 };
  assert.equal(delta(null, 2.5), '?');
  assert.equal(delta(priced, null), '?');
  assert.equal(delta(priced, 0), '?');
  assert.equal(delta({ usd: 2.5, unpriced: 1 }, 2.5), '?');
});

// ===== Width ===========================================================================

test('cells: an emoji status two, a combining mark none; fit cuts at the width with a closing …, at the tight case too', async () => {
  const { cells, fit } = await view;
  const acute = String.fromCharCode(0x301);
  assert.deepEqual(['🟢', '✅', '⬜', '🔄', '❌', '⛔', '👤', '🧪', 'abc', 'e' + acute, '·', '—', '…'].map(cells), [2, 2, 2, 2, 2, 2, 2, 2, 3, 1, 1, 1, 1]);
  assert.equal(fit('abcd', 4), 'abcd');
  assert.equal(fit('abcde', 4), 'abc…');
  assert.equal(fit('ab🟢cd', 5), 'ab🟢…');
  assert.equal(fit('ab🟢cd', 4), 'ab…');
  assert.equal(fit('abc', 0), '…');
  assert.equal(fit('a'.repeat(500), Infinity), 'a'.repeat(500));
  assert.equal(fit('abc', undefined), 'abc');
});

test('fit draws a run of hidden characters as one space: C0, DEL, C1 and the two Unicode separators', async () => {
  const { fit } = await view;
  for (const code of [0, 9, 10, 13, 27, 31, 127, 128, 159, 0x2028, 0x2029]) {
    assert.equal(fit('a' + String.fromCharCode(code, code) + 'b', 80), 'a b', code.toString(16));
  }
  assert.equal(fit('a' + String.fromCharCode(32, 160) + 'b', 80), 'a' + String.fromCharCode(32, 160) + 'b', 'a space and a no-break space are kept');
  assert.equal(fit('a~b', 80), 'a~b', 'the last character below DEL is kept');
});

// ===== Readers =========================================================================

test('readView: the tagged ledger, else the first, and how many more; an empty list is no ledger', async () => {
  const { readView } = await view;
  const a = ledgerOf({ id: 'L-A' }), b = ledgerOf({ id: 'L-B' });
  const line = ledgers => ok(JSON.stringify({ v: 1, repo: '/r', incomplete: false, ledgers }) + '\n');
  assert.deepEqual(readView(line([a, b]), 'L-B'), { incomplete: false, ledger: b, more: 1 });
  assert.deepEqual(readView(line([a, b]), 'L-Z'), { incomplete: false, ledger: a, more: 1 });
  assert.deepEqual(readView(line([a, b]), null), { incomplete: false, ledger: a, more: 1 });
  assert.deepEqual(readView(line([]), 'L-A'), { incomplete: false, ledger: null, more: 0 });
  assert.equal(readView(ok(JSON.stringify({ v: 1, repo: '/r', incomplete: true, ledgers: [a] })), null).incomplete, true);
});

test('readView: a view that fails is a stated reason, never an empty list', async () => {
  const { readView } = await view;
  const cases = [
    [{ ...ok('UNKNOWN discovery did not complete: exit 1\n'), exitCode: 2 }, 'discovery did not complete: exit 1'],
    [{ ...ok(''), exitCode: 1 }, 'exit 1'],
    [{ ...ok('Error: boom\n'), exitCode: 1 }, 'exit 1: Error: boom'],
    [{ ...ok('{"v":1,"repo":"/r","incomplete":false,"ledgers":[]}'), isStdoutTruncated: true }, 'its output was cut short'],
    [{ error: 'node cannot start' }, 'node cannot start'],
    [ok('not json\n'), 'its output is not a view: not json'],
    [ok(''), 'its output is not a view: no output'],
    [ok('{"v":2,"incomplete":false,"ledgers":[]}'), 'its output is not a view: {"v":2,"incomplete":false,"ledgers":[]}'],
    [ok('{"v":1,"ledgers":[]}'), 'its output is not a view: {"v":1,"ledgers":[]}'],
    [ok('{"v":1,"incomplete":false,"ledgers":[{"id":"L-A"}]}'), 'its output is not a view: {"v":1,"incomplete":false,"ledgers":[{"id":"L-A"}]}'],
    [ok('{"v":1,"incomplete":false}'), 'its output is not a view: {"v":1,"incomplete":false}'],
    [ok('{"v":1,"incomplete":false,"ledgers":[{"rows":[]}]}'), 'its output is not a view: {"v":1,"incomplete":false,"ledgers":[{"rows":[]}]}'],
  ];
  for (const [run, error] of cases) assert.deepEqual(readView(run, null), { error }, JSON.stringify(run));
});

test('readCosts: the ledger total and its batches; NO RECORDS at exit 0 alone is every figure $0.00', async () => {
  const { readCosts } = await view;
  const t = (usd, unpriced = 0) => ({ requests: 1, in: 1, out: 1, cr: 1, cw: 1, usd, unpriced });
  const report = { v: 1, dir: '/d', files: 1, records: 2, total: t(3, 1), byLedger: { [ID]: { total: t(3, 1), byBatch: { B01: { total: t(1), byRole: {} }, B02: { total: t(2, 1), byRole: {} } } } }, byModel: {}, bySession: {} };
  assert.deepEqual(readCosts(ok(JSON.stringify(report) + '\n'), ID), { ledger: ID, total: { usd: 3, unpriced: 1 }, byBatch: { B01: { usd: 1, unpriced: 0 }, B02: { usd: 2, unpriced: 1 } } });
  assert.deepEqual(readCosts(ok(JSON.stringify({ ...report, total: t(0), byLedger: {} })), ID), { ledger: ID, total: { usd: 0, unpriced: 0 }, byBatch: {} });
  assert.deepEqual(readCosts(ok('NO RECORDS /home/u/.claude/orchestrate-costs\n'), ID), { ledger: ID, total: { usd: 0, unpriced: 0 }, byBatch: {} });
  assert.deepEqual(readCosts({ ...ok('NO RECORDS /d\n'), exitCode: 2 }, ID), { ledger: ID, error: 'exit 2: NO RECORDS /d' });
});

test('readCosts: a report that fails, is cut short or is not its JSON is an error, never $0.00', async () => {
  const { readCosts } = await view;
  const t = (usd, unpriced = 0) => ({ usd, unpriced });
  const bad = line => ({ ledger: ID, error: `its output is not a report: ${line}` });
  const cases = [
    [{ ...ok('UNKNOWN /d/s.jsonl:3: not JSON\n'), exitCode: 2 }, { ledger: ID, error: 'exit 2: UNKNOWN /d/s.jsonl:3: not JSON' }],
    [{ ...ok('NO RECORDS /d\n'), isStdoutTruncated: true }, { ledger: ID, error: 'its output was cut short' }],
    [{ error: 'node cannot start' }, { ledger: ID, error: 'node cannot start' }],
    [ok('COSTS 3 records\n'), bad('COSTS 3 records')],
    [ok('{"v":1,"byLedger":{}}'), bad('{"v":1,"byLedger":{}}')],
    [ok('{"v":2,"total":{"usd":1,"unpriced":0},"byLedger":{}}'), bad('{"v":2,"total":{"usd":1,"unpriced":0},"byLedger":{}}')],
    [ok('{"v":1,"total":{"usd":1,"unpriced":0}}'), bad('{"v":1,"total":{"usd":1,"unpriced":0}}')],
    ...[{ [ID]: null }, { [ID]: { byBatch: 5 } }, { [ID]: { byBatch: { B01: null } } }].map(byLedger => {
      const line = JSON.stringify({ v: 1, total: t(1), byLedger });
      return [ok(line), bad(line)];
    }),
    [ok(JSON.stringify({ v: 1, total: t('1'), byLedger: {} })), bad(JSON.stringify({ v: 1, total: t('1'), byLedger: {} }))],
    [ok(JSON.stringify({ v: 1, total: t(1), byLedger: { [ID]: { byBatch: { B01: { total: t(null) } } } } })), bad(JSON.stringify({ v: 1, total: t(1), byLedger: { [ID]: { byBatch: { B01: { total: t(null) } } } } }))],
  ];
  for (const [run, expected] of cases) assert.deepEqual(readCosts(run, ID), expected, JSON.stringify(run));
});

test('runningAgents: running ones only, joined to the cost log\'s aggregates oldest first, the rest by type after them', async () => {
  const { runningAgents } = await view;
  const agg = new Map([['main', { role: 'main' }],
    ['a-1', { type: 'general-purpose', role: 'implementer', batch: 'B03', firstSeen: T0 + 5, lastPrompt: 211000, usd: 1.5, unpriced: 0 }],
    ['a-2', { type: 'general-purpose', role: 'test-hunter', batch: 'B03', firstSeen: T0, lastPrompt: 96000, usd: 0.5, unpriced: 1 }],
    ['a-3', { type: 'unknown', role: null, batch: null, firstSeen: T0, lastPrompt: 0, usd: 0, unpriced: 0 }]]);
  const list = [{ id: 'x-9', type: 'Explore', status: 'running' }, { id: 'a-1', type: 'general-purpose', status: 'running' },
    { id: 'a-2', type: 'general-purpose', status: 'running' }, { id: 'a-3', type: 'Plan', status: 'completed' }, { id: 'main', type: 'x', status: 'killed' }];
  assert.deepEqual(runningAgents(list, agg), [
    { known: true, role: 'test-hunter', batch: 'B03', firstSeen: T0, ctx: 96000, usd: 0.5, unpriced: 1 },
    { known: true, role: 'implementer', batch: 'B03', firstSeen: T0 + 5, ctx: 211000, usd: 1.5, unpriced: 0 },
    { known: false, type: 'Explore' },
  ]);
  assert.deepEqual(runningAgents([{ id: 'a-3', type: 'Plan', status: 'running' }], agg), [{ known: true, role: 'unknown', batch: null, firstSeen: T0, ctx: 0, usd: 0, unpriced: 0 }]);
  assert.equal(runningAgents(undefined, agg), null);
});

test('conductorOf: no tokens and no percent before the live window\'s first response; never zeroed', async () => {
  const { conductorOf } = await view;
  assert.deepEqual(conductorOf({ window: 1000000 }), { tokens: null, window: 1000000, percent: null });
  assert.deepEqual(conductorOf({ tokens: 412345, window: 1000000, percent: 41 }), { tokens: 412345, window: 1000000, percent: 41 });
  assert.deepEqual(conductorOf({ tokens: 0, window: 1000000, percent: 0 }), { tokens: 0, window: 1000000, percent: 0 });
  assert.deepEqual(conductorOf(undefined), { tokens: null, window: null, percent: null });
  assert.deepEqual(conductorOf({ tokens: -1, window: 'x', percent: NaN }), { tokens: null, window: null, percent: null });
});

test('the safe point is the 300K protocol.md names', async () => {
  const { SAFE_POINT } = await view;
  const named = [...PROTOCOL.matchAll(/past about (\d+)K\b/g)].map(m => Number(m[1]) * 1000);
  assert.ok(named.length >= 1, 'protocol.md names a safe point');
  assert.deepEqual([...new Set(named)], [SAFE_POINT]);
});

// ===== The pane, the text, the band =====================================================

test('paneLines draws the approved one-screen layout; textReport is the same lines as plain text', async () => {
  const { paneLines, textReport } = await view;
  const expected = lined([ID + ' · ACTIVE · W2 of 2 · next C1', 'as of 12:12:00', 'chore/ledger-mod-ledger @9f3c2e1', '', ...ROWS, '', ...TAIL]);
  assert.deepEqual(paneLines(dataOf(), 100), expected);
  assert.equal(textReport(dataOf()), expected.map(l => l.text).join('\n'));
});

test('a ledger carrying a warning: its rows, and one dim discovery line under the integration line, in the pane and the text', async () => {
  const { paneLines, textReport } = await view;
  const warning = 'AMBIGUOUS (State differs: ACTIVE at chore/x, AT-CHECKPOINT C1 at feat/y)';
  const data = dataOf({ view: { incomplete: false, ledger: ledgerOf({ warning }), more: 0 } });
  const expected = lined([ID + ' · ACTIVE · W2 of 2 · next C1', 'as of 12:12:00', 'chore/ledger-mod-ledger @9f3c2e1',
    { text: 'discovery: ' + warning, dim: true }, '', ...ROWS, '', ...TAIL]);
  assert.deepEqual(paneLines(data, 100), expected);
  assert.equal(textReport(data), expected.map(l => l.text).join('\n'));
  // The control: without one, no discovery line.
  assert.ok(!paneLines(dataOf(), 100).some(l => l.text.startsWith('discovery:')));
  assert.ok(!textReport(dataOf()).includes('discovery:'));
  // Cut like every line.
  assert.deepEqual(paneLines(data, 30)[3], { text: 'discovery: AMBIGUOUS (State d…', dim: true });
  // The text is never cut: a warning naming long worktree paths stays whole.
  const long = 'AMBIGUOUS (State differs: ' + '/home/u/worktrees/'.repeat(16) + 'PROGRESS.md=ACTIVE, int=AT-CHECKPOINT C1)';
  assert.ok(long.length > 300);
  assert.ok(textReport(dataOf({ view: { incomplete: false, ledger: ledgerOf({ warning: long }), more: 0 } })).split('\n').includes('discovery: ' + long));
});

test('at a narrow width every line is cut, each emoji counted two cells; the title gives way before the git column and the dollars', async () => {
  const { paneLines, cells } = await view;
  const at30 = paneLines(dataOf(), 30);
  assert.ok(at30.every(l => cells(l.text) <= 30), JSON.stringify(at30));
  assert.deepEqual(at30.map(l => l.text).slice(0, 5), [ID + ' · ACTI…', 'as of 12:12:00', 'chore/ledger-mod-ledger @9f3c…', '', 'B01 ✅ W1 M  cost log  R1 SHI…']);
  const at52 = paneLines(dataOf(), 52).map(l => l.text);
  assert.ok(at52.includes('B02 🟢 W1 S  compact…  R1 SHIP  git: row 7' + sp(5) + '$0.00'), JSON.stringify(at52));
  // At the widest row's own width the titles are whole; one cell less and the widest title gives way.
  assert.ok(paneLines(dataOf(), 54).map(l => l.text).includes('B02 🟢 W1 S  compaction  R1 SHIP  git: row 7' + sp(5) + '$0.00'));
  assert.ok(paneLines(dataOf(), 53).map(l => l.text).includes('B02 🟢 W1 S  compacti…  R1 SHIP  git: row 7' + sp(5) + '$0.00'));
});

test('a row: a settled one (git null) has no git column or line; a round that cannot be read is R?, an unknown weight ?', async () => {
  const { paneLines } = await view;
  const rows = [{ id: 'B01', title: 't', wave: 1, weight: null, status: '⛔ (dropped)', round: null, roundError: 'notes: unreadable', git: null }];
  const data = dataOf({ view: { incomplete: false, ledger: ledgerOf({ rows }), more: 0 }, costs: { ledger: ID, total: { usd: 0, unpriced: 0 }, byBatch: {} } });
  const lines = paneLines(data, 100).map(l => l.text);
  assert.deepEqual(lines.slice(4, 6), ['B01 ⛔ (dropped) W1 ?  t  R?  $0.00', '']);
});

test('the header: a ledger entry with an error shows it in place of its rows and ? for what was not read; none when no checkpoint is left', async () => {
  const { paneLines } = await view;
  const error = 'UNKNOWN contract x: ENOENT';
  const failed = dataOf({ view: { incomplete: false, ledger: ledgerOf({ state: null, integration: null, waves: null, currentWave: null, nextCheckpoint: null, rows: [], error }), more: 0 } });
  assert.deepEqual(paneLines(failed, 100).map(l => l.text).slice(0, 6), [ID + ' · ? · W? of ? · next ?', 'as of 12:12:00', 'integration ?', '', error, '']);
  const done = dataOf({ view: { incomplete: false, ledger: ledgerOf({ nextCheckpoint: null, integration: { branch: 'int', sha: null } }), more: 2 } });
  assert.deepEqual(paneLines(done, 100).map(l => l.text).slice(0, 4), [ID + ' · ACTIVE · W2 of 2 · next none', 'as of 12:12:00', 'and 2 more ledgers', 'int @?']);
  assert.equal(paneLines({ ...done, view: { ...done.view, more: 1 } }, 100)[2].text, 'and 1 more ledger');
});

test('discovery incomplete: the line shows with a ledger and with none', async () => {
  const { paneLines, INCOMPLETE } = await view;
  assert.equal(INCOMPLETE, 'discovery incomplete — some ledgers may be missing');
  const withLedger = paneLines(dataOf({ view: { incomplete: true, ledger: ledgerOf(), more: 0 } }), 100).map(l => l.text);
  assert.deepEqual(withLedger.slice(1, 4), ['as of 12:12:00', INCOMPLETE, 'chore/ledger-mod-ledger @9f3c2e1']);
  const none = paneLines(dataOf({ tag: null, costs: null, view: { incomplete: true, ledger: null, more: 0 } }), 100).map(l => l.text);
  assert.deepEqual(none, ['no active ledger in /repo', 'as of 12:12:00', INCOMPLETE, '', ...TAIL.slice(0, 3), 'session $2.69 · /cost $2.75 (-2.0%)']);
  // The control: complete discovery draws no such line.
  assert.ok(!paneLines(dataOf(), 100).some(l => l.text === INCOMPLETE));
});

test('everything unknown renders as ? or a stated reason, never as 0', async () => {
  const { paneLines, textReport } = await view;
  const data = { at: null, tzOffset: null, root: null, tag: ID, view: { error: 'node cannot start' }, costs: { ledger: ID, error: 'exit 2' }, agents: null, conductor: null, session: null, slashCost: null };
  assert.deepEqual(paneLines(data, 100).map(l => l.text), ['ledger view unavailable — node cannot start', 'as of ?', '',
    'running  agents unknown — the agent list cannot be read', 'conductor context unknown · safe point at 300K', 'ledger ? · session ? · /cost ? (?)']);
  const unknownAgent = textReport({ ...data, agents: [{ known: false, type: 'Explore' }] });
  assert.ok(unknownAgent.includes('running  Explore  ?  ?m  ? ctx  ?'), unknownAgent);
  // A known agent with no time of the data: its minutes are ?, never 0.
  const knownAgent = textReport({ ...data, agents: [dataOf().agents[0]] });
  assert.ok(knownAgent.includes('running  implementer  B03  ?m  211K ctx  $0.29'), knownAgent);
  for (const text of [textReport(data), unknownAgent, knownAgent]) assert.doesNotMatch(text, /\$0\.00|\b0K\b|\b0m\b|\(0%\)/);
  // A failed cost report: every row's figure ?, not $0.00.
  const rows = paneLines(dataOf({ costs: { ledger: ID, error: 'exit 2' } }), 100).map(l => l.text).filter(t => /^B0\d /.test(t));
  assert.deepEqual(rows.map(t => t.slice(-2)), [' ?', ' ?', ' ?']);
});

test('no running agent reads running none, a line of its own', async () => {
  const { paneLines } = await view;
  assert.deepEqual(paneLines(dataOf({ agents: [] }), 100).map(l => l.text).slice(-4), ['', 'running  none', TAIL[2], TAIL[3]]);
});

test('an agent: a total that leaves unpriced records out reads +?, a known agent with no batch -', async () => {
  const { paneLines } = await view;
  const agents = [{ ...dataOf().agents[0], unpriced: 1 }, { known: true, role: 'Explore', batch: null, firstSeen: T0, ctx: 1000, usd: 0.1, unpriced: 0 }];
  assert.deepEqual(paneLines(dataOf({ agents }), 100).map(l => l.text).slice(-4, -2),
    ['running  implementer  B03  12m  211K ctx  $0.29+?', sp(9) + 'Explore      -    12m    1K ctx    $0.10']);
});

test('a context reading with tokens and no percent reads (?), never (0%)', async () => {
  const { paneLines } = await view;
  const lines = paneLines(dataOf({ conductor: { tokens: 412345, window: 1000000, percent: null } }), 100).map(l => l.text);
  assert.equal(lines.at(-2), 'conductor  412K of 1M (?) · safe point at 300K');
});

test('bandLine: id, wave, the latest agent as <Bnn> R<k> <role>, context, dollars, /ledger; each unknown segment left out', async () => {
  const { bandLine } = await view;
  const full = 'OS-…-ledger-mod · W2 · B03 R2 implementer · ctx 412K/1M · $24.33 · /ledger';
  assert.equal(bandLine(dataOf(), 200), full);
  // The most recently started of the running agents; the unknown one is never chosen.
  const two = [{ known: true, role: 'test-hunter', batch: 'B02', firstSeen: T0 + 1, ctx: 1, usd: 0, unpriced: 0 }, ...dataOf().agents];
  assert.equal(bandLine(dataOf({ agents: two }), 200), 'OS-…-ledger-mod · W2 · B02 R1 test-hunter · ctx 412K/1M · $24.33 · /ledger');
  assert.equal(bandLine(dataOf({ agents: [{ known: true, role: 'Explore', batch: null, firstSeen: T0, ctx: 1, usd: 0, unpriced: 0 }] }), 200),
    'OS-…-ledger-mod · W2 · Explore · ctx 412K/1M · $24.33 · /ledger');
  const noRound = ledgerOf({ rows: ledgerOf().rows.map(r => ({ ...r, round: null })) });
  assert.equal(bandLine(dataOf({ view: { incomplete: false, ledger: noRound, more: 0 } }), 200), 'OS-…-ledger-mod · W2 · B03 implementer · ctx 412K/1M · $24.33 · /ledger');
  const unknown = { view: { error: 'x' }, agents: null, conductor: { tokens: null, window: 1000000, percent: null }, costs: { ledger: ID, error: 'exit 2' } };
  assert.equal(bandLine(dataOf(unknown), 200), 'OS-…-ledger-mod · /ledger');
  // The tagged ledger's own entry with an error carries no wave.
  const failed = ledgerOf({ currentWave: null, waves: null, rows: [], error: 'UNKNOWN x' });
  assert.equal(bandLine(dataOf({ view: { incomplete: false, ledger: failed, more: 0 } }), 200), 'OS-…-ledger-mod · B03 implementer · ctx 412K/1M · $24.33 · /ledger');
  assert.equal(bandLine(dataOf({ agents: [{ known: false, type: 'Explore' }] }), 200), 'OS-…-ledger-mod · W2 · ctx 412K/1M · $24.33 · /ledger');
  // The view's ledger and the costs count only when they are the tagged ledger's.
  assert.equal(bandLine(dataOf({ tag: 'OS-20261001-other' }), 200), 'OS-…-other · B03 implementer · ctx 412K/1M · /ledger');
  assert.equal(bandLine(dataOf({ costs: { ledger: ID, total: { usd: 1, unpriced: 2 }, byBatch: {} } }), 200), full.replace('$24.33', '$1.00+?'));
  assert.equal(bandLine(dataOf(), 20), 'OS-…-ledger-mod · W…');
});

// The clear's three optional fields (orchestrate-mod/hooks/clear.js, set by orchestrate-mod/hooks/register.js `drawn`).
test('the clear\'s fields absent, null or empty: the pane, the text and the band print what they print without them', async () => {
  const { paneLines, textReport, bandLine } = await view;
  const forms = [{ clearBand: undefined }, { clearBand: null }, { clears: undefined }, { clears: null }, { clears: [] }, { runTotal: undefined }, { runTotal: null }];
  const drawn = forms.map(over => [paneLines(dataOf(over), 100), textReport(dataOf(over)), bandLine(dataOf(over), 200)]);
  assert.deepEqual(drawn, forms.map(() => [paneLines(dataOf(), 100), textReport(dataOf()), bandLine(dataOf(), 200)]));
  assert.equal(bandLine(dataOf(), 200), 'OS-…-ledger-mod · W2 · B03 R2 implementer · ctx 412K/1M · $24.33 · /ledger');
  assert.equal(paneLines(dataOf(), 100).length, 4 + ROWS.length + 1 + TAIL.length);
});

test('the band leads with the countdown or the notice, which a narrow band keeps', async () => {
  const { bandLine } = await view;
  const full = 'OS-…-ledger-mod · W2 · B03 R2 implementer · ctx 412K/1M · $24.33 · /ledger';
  const countdown = 'clearing in 1:59 · type anything to keep this conversation';
  const notice = 'clear skipped: background work is running — continuing here';
  assert.equal(bandLine(dataOf({ clearBand: countdown }), 200), countdown + ' · ' + full);
  assert.equal(bandLine(dataOf({ clearBand: notice }), 200), notice + ' · ' + full);
  assert.equal(bandLine(dataOf({ clearBand: countdown, tag: 'OS-20261001-other' }), 200), countdown + ' · OS-…-other · B03 implementer · ctx 412K/1M · /ledger');
  assert.equal(bandLine(dataOf({ clearBand: countdown }), 20), 'clearing in 1:59 · …');
});

test('the pane closes with the clears, each at its local time and context, and the run\'s total over its conversations', async () => {
  const { paneLines, textReport } = await view;
  const clears = [{ at: T0 + 2 * MIN, tzOffset: 0, tokens: 412345 }, { at: T0 + 95 * MIN, tzOffset: -120, tokens: 388000 }];
  const data = dataOf({ clears, runTotal: { usd: 7.2, unpriced: 0, conversations: 3 } });
  const added = ['clears 12:02 at 412K · 15:35 at 388K', 'run $7.20 over 3 conversations'];
  assert.deepEqual(paneLines(data, 100), lined([ID + ' · ACTIVE · W2 of 2 · next C1', 'as of 12:12:00', 'chore/ledger-mod-ledger @9f3c2e1', '', ...ROWS, '', ...TAIL, ...added]));
  assert.deepEqual(textReport(data).split('\n').slice(-3), [TAIL[3], ...added]);
  // Unknown is never zero: a clear whose time or context was not read, a run with a conversation unknown; one conversation.
  const unknown = paneLines(dataOf({ clears: [{ at: null, tzOffset: null, tokens: null }], runTotal: { usd: 2.4, unpriced: 1, conversations: 1 } }), 100).map(l => l.text);
  assert.deepEqual(unknown.slice(-2), ['clears ? at ?', 'run $2.40+? over 1 conversation']);
  // The clears alone or the run alone; each cut like every line.
  assert.deepEqual(paneLines(dataOf({ clears }), 100).at(-1), { text: added[0], dim: false });
  assert.deepEqual(paneLines(dataOf({ runTotal: { usd: 7.2, unpriced: 0, conversations: 3 } }), 100).slice(-2).map(l => l.text), [TAIL[3], added[1]]);
  assert.deepEqual(paneLines(data, 20).slice(-2).map(l => l.text), ['clears 12:02 at 412…', 'run $7.20 over 3 co…']);
});

// ===== Bound to the producers ============================================================

function tempDir(t) {
  const temp = fs.realpathSync(os.tmpdir()), dir = fs.mkdtempSync(path.join(temp, 'mod-view-'));
  t.after(() => { assert.equal(path.dirname(dir), temp); fs.rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }); });
  return dir;
}

test('readCosts reads what cost-report.mjs prints: totals by batch, NO RECORDS, and a malformed file', async t => {
  const { readCosts, dollars } = await view, { costReport } = await costReportTool, { buildRecord, recordLine } = await cost;
  const dir = tempDir(t);
  const usage = { input_tokens: 1000, output_tokens: 10000, cache_read_input_tokens: 200000, cache_creation_input_tokens: 10000 };
  const record = (batch, model) => buildRecord({ now: T0, session: 's-1', agent: 'a-1', attribution: { type: 'general-purpose', role: 'implementer', ledger: ID, batch, parent: null }, usage: { ...usage, model } });
  fs.writeFileSync(path.join(dir, 's-1.jsonl'), [record('B03', 'claude-opus-5-5'), record('B03', 'claude-unpriced-9'), record('B01', 'claude-opus-5-5')].map(recordLine).join(''));
  const run = args => { const out = costReport(args, {}); return { exitCode: out.code, stdout: out.lines.join('\n') + '\n', isStdoutTruncated: false }; };
  const read = readCosts(run(['--dir', dir, '--ledger', ID, '--format', 'json']), ID);
  assert.deepEqual([dollars(read.total), dollars(read.byBatch.B03), dollars(read.byBatch.B01)], ['$0.59+?', '$0.29+?', '$0.29']);
  assert.deepEqual(readCosts(run(['--dir', path.join(dir, 'none'), '--ledger', ID, '--format', 'json']), ID), { ledger: ID, total: { usd: 0, unpriced: 0 }, byBatch: {} });
  fs.writeFileSync(path.join(dir, 's-2.jsonl'), '{"bad":1}\n');
  const failed = readCosts(run(['--dir', dir, '--ledger', ID, '--format', 'json']), ID);
  assert.match(failed.error, /^exit 2: UNKNOWN .*s-2\.jsonl:1: /);
});

test('readView reads what ledger-view.mjs prints: a fixture ledger drawn row by row with its git verdicts, and an UNKNOWN', async t => {
  const { readView, paneLines } = await view, { ledgerView } = await ledgerViewTool;
  const repo = makeRepo(t);
  repo.git('config', 'maintenance.auto', 'false');
  repo.git('config', 'gc.auto', '0');
  const table = (columns, rows) => [`| ${columns.join(' | ')} |`, `|${columns.map(() => '---').join('|')}|`, ...rows.map(r => `| ${r.join(' | ')} |`)].join('\n');
  const contract = '# Contract\n\n**Change**: fixture\n**Skill**: `' + SKILL + '` · sha256 `' + 'ab'.repeat(32) + '`\n\n## Git model\n\n'
    + '- Default branch (protected local ref): `refs/heads/main`. Integration branch: `int` — the ledger branch.\n'
    + '- Shipment source: `local`. Shipment ref: `refs/heads/main` — the target.\n\n## Other\n';
  const progress = '# Progress\n\n**State**: ACTIVE\n\n## Batches\n\n'
    + table(['#', 'Batch', 'Branch', 'Wave', 'Version', 'Status', 'Updated', 'Notes'], [['B01', 'first work', '`feat/b01`', '1', '—', '🔄', '2026-10-08', '—'], ['B02', 'second work', '`feat/b02`', '2', '—', '⬜', '2026-10-08', '—']])
    + '\n\n## Checkpoints\n\n' + table(['Checkpoint', 'After wave', 'Covers', 'Why here', 'Status', 'Verdict'], [['C1', '2', 'all', 'final', '⬜', '—']])
    + '\n\n## Session log\n\n| Date | Did | Stopped |\n|---|---|---|\n';
  const plan = '# Plan\n\n' + table(['#', 'Batch', 'Type', 'Weight', 'Branch', 'Wave'], [['B01', 'first work', 'feature', 'M', '`feat/b01`', '1'], ['B02', 'second work', 'feature', 'S', '`feat/b02`', '2']]) + '\n';
  repo.git('checkout', '-q', '-b', 'int', 'main');
  for (const [name, text] of [['00-READBEFORE.md', contract], ['PROGRESS.md', progress], ['01-plan.md', plan]]) repo.write(`.agents/changes/L-A/${name}`, text);
  repo.commit('L-A on int');
  repo.git('checkout', '-q', 'main');
  const out = await ledgerView({ repo: repo.cwd, skillDir: SKILL, env: withoutTestContext(repo.env) });
  assert.equal(out.code, 0, JSON.stringify(out));
  const read = readView({ exitCode: 0, stdout: JSON.stringify(out.view) + '\n', isStdoutTruncated: false }, 'L-A');
  assert.equal(read.ledger.id, 'L-A');
  const verdicts = read.ledger.rows.map(r => r.git);
  assert.ok(verdicts.every(g => g !== null && typeof g.row === 'string' && PROTOCOL.replace(/\s+/g, ' ').includes(g.verdict)), JSON.stringify(verdicts));
  const sha = repo.git('rev-parse', 'refs/heads/int').slice(0, 7);
  const data = { at: T0, tzOffset: 0, root: repo.cwd, tag: 'L-A', view: read, costs: { ledger: 'L-A', total: { usd: 0, unpriced: 0 }, byBatch: {} }, agents: [], conductor: null, session: null, slashCost: null };
  const lines = paneLines(data, Infinity);
  assert.deepEqual(lines.slice(0, 4).map(l => l.text), ['L-A · ACTIVE · W1 of 2 · next C1', 'as of 12:00:00', `int @${sha}`, '']);
  const git = verdicts.map(g => `git: row ${g.row}`), gitW = Math.max(...git.map(g => g.length));
  assert.deepEqual(lines.slice(4, 8), [
    { text: `B01 🔄 W1 M  first work   ${git[0].padEnd(gitW)}  $0.00`, dim: false }, { text: `    ${verdicts[0].verdict}`, dim: true },
    { text: `B02 ⬜ W2 S  second work  ${git[1].padEnd(gitW)}  $0.00`, dim: false }, { text: `    ${verdicts[1].verdict}`, dim: true },
  ]);
  const missing = await ledgerView({ repo: repo.cwd, skillDir: path.join(repo.root, 'no-such-skill'), env: withoutTestContext(repo.env) });
  const failed = readView({ exitCode: missing.code, stdout: missing.line + '\n', isStdoutTruncated: false }, 'L-A');
  assert.match(failed.error, /^skill directory .*no-such-skill: tools\/reconcile\.mjs cannot be used/);
});
