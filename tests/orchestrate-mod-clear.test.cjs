'use strict';
// orchestrate-mod/hooks/clear.js in-process: the names, countdown and argument builders the hooks module binds, the
// SHA check, the porcelain parser, the shown fields, the decision on a schedule_clear call (reasons a–i, in order,
// and the clear threshold), the scheduled and not-needed lines, the turn's-end verdict, the countdown text, the
// notices, the run's links and its total.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');

const ROOT = path.resolve(__dirname, '..');
const clear = import(pathToFileURL(path.join(ROOT, 'orchestrate-mod/hooks/clear.js')).href);
const readText = file => fs.readFileSync(path.join(ROOT, file), 'utf8').replace(/\r\n/g, '\n');

const ID = 'OS-20261010-clear-continue';
const BRANCH = 'chore/clear-continue-ledger';
const SHA = '0123456789abcdef'.repeat(2) + '01234567';
const TOOL = 'mcp__orchestrate-mod__schedule_clear';
const run = (stdout, over = {}) => ({ exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false, ...over });
const porcelain = (eol, at = p => p) => ['worktree ' + at('/work/repo'), 'HEAD ' + 'f'.repeat(40), 'branch refs/heads/main', '',
  'worktree ' + at('/work/int'), 'HEAD ' + SHA, 'branch refs/heads/' + BRANCH, '', 'worktree ' + at('/work/bare'), 'bare', '',
  'worktree ' + at('/work/old'), 'HEAD ' + SHA, 'detached', 'prunable gitdir file points to non-existent location', ''].join(eol);
// Every fact of a call that schedules: each reason's case below changes one of them.
const ledgerOf = (over = {}) => ({ id: ID, integration: { branch: BRANCH, sha: SHA }, skillDir: '/s', clearThreshold: { tokens: 300000, source: 'contract' }, rows: [], error: null, ...over });
// The read of a passing call with the ledger's entry changed by `over`.
const readWith = over => ({ ...passing().read, view: { incomplete: false, ledger: ledgerOf(over), more: 0 } });
// The context is over the threshold, so every reason after the threshold step is still reached.
const passing = (over = {}) => ({
  agentId: undefined, ledger: ID, ledgerValid: true, sha: SHA, busy: false,
  read: { tag: ID, view: { incomplete: false, ledger: ledgerOf(), more: 0 }, root: '/work/repo' }, context: 412345,
  protocol: { text: 'call `' + TOOL + '` here' }, worktrees: run(porcelain('\n')), status: run(''),
  agents: [{ id: 'a', status: 'completed' }], ...over,
});

// ===== The names ========================================================================

test('the tool: its short and full names, the description and schema verbatim; the full name is the plugin\'s', async () => {
  const c = await clear;
  const plugin = JSON.parse(readText('orchestrate-mod/.claude-plugin/plugin.json')).name;
  assert.equal(c.TOOL_NAME, 'schedule_clear');
  assert.equal(c.TOOL_FULL_NAME, TOOL);
  assert.equal(c.TOOL_FULL_NAME, `mcp__${plugin}__${c.TOOL_NAME}`);
  assert.equal(c.TOOL_DESCRIPTION, 'orchestrate-mod: schedules an automatic clear of this conversation followed by /orchestrate continue <ledger> after-clear.'
    + " Call it only where your ledger's pinned protocol.md (§Session algorithm step 8) names this tool, with the ledger id and the"
    + " integration branch's full tip SHA. The answer begins `scheduled` (post the line it gives, then end your turn), `not needed`"
    + " (carry on: no clear and no timer) or `declined` (take the timer path, after any retry your ledger's step 8 names).");
  assert.deepEqual(c.TOOL_INPUT_SCHEMA, { type: 'object', properties: { ledger: { type: 'string' }, sha: { type: 'string' } }, required: ['ledger', 'sha'] });
});

test('the countdown is two minutes and the Stop wait five seconds; the argument builders', async () => {
  const c = await clear;
  assert.equal(c.COUNTDOWN_MS, 120000);
  assert.equal(c.STOP_WAIT_MS, 5000);
  assert.equal(c.NO_STOP, 'no Stop within 5 s, so background work is unknown');
  assert.equal(c.afterClearArgs(ID), 'continue ' + ID + ' after-clear');
  assert.equal(c.inPlaceArgs(ID, 'background work is running: b1 (shell, sleep 120)'), 'continue ' + ID + ' in-place background work is running: b1 (shell, sleep 120)');
  assert.equal(c.continueArgs(ID), 'continue ' + ID);
});

// The hooks module spells event filters as literals (the loader's static analysis), so its two filters are held equal
// to TOOL_FULL_NAME here. Every other use is bound at its call site: every `$.clock.after` waits STOP_WAIT_MS, 0 or
// COUNTDOWN_MS, every `/orchestrate` it runs takes its arguments from inPlaceArgs or afterClearArgs, and no literal
// or number in its code spells the tool, an argument or the countdown. Its comments may name them: the code is read
// with its comments taken out.
const toolFilters = source => [...source.matchAll(/\{ tool: '([^']*)' \}/g)].map(m => m[1]);
const code = source => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
function unbound(source) {
  const text = code(source), problems = [];
  const waits = [...text.matchAll(/\$\.clock\.after\(([^,]*),/g)].map(m => m[1]);
  if (waits.join(' | ') !== 'STOP_WAIT_MS | 0 | COUNTDOWN_MS') problems.push('waits: ' + waits.join(' | '));
  const runs = [...text.matchAll(/command: 'orchestrate', args: (\w+)\(|command: 'orchestrate'/g)].map(m => m[1] ?? 'unbound');
  if (runs.join(' | ') !== 'inPlaceArgs | afterClearArgs') problems.push('orchestrate: ' + runs.join(' | '));
  const bare = text.replace(/\{ tool: '[^']*' \}/g, '{ tool }');
  for (const m of bare.matchAll(/[`'"](?:continue |[^`'"\n]*?(?:schedule_clear|after-clear))/g)) problems.push('literal: ' + m[0]);
  for (const m of bare.matchAll(/\b120_?000\b/g)) problems.push('number: ' + m[0]);
  return problems;
}
test('register.js filters on the full name twice, and binds each wait and /orchestrate argument to clear.js at its call site', async () => {
  const c = await clear;
  const source = readText('orchestrate-mod/hooks/register.js');
  assert.deepEqual(toolFilters(source), [c.TOOL_FULL_NAME, c.TOOL_FULL_NAME]);
  assert.match(source, /on\('tool\.describe', \{ tool: '[^']*' \}/);
  assert.match(source, /on\('tool\.call', \{ tool: '[^']*' \}/);
  assert.match(source, /\$\.tool\.register\(\{ name: TOOL_NAME, description: TOOL_DESCRIPTION, inputSchema: TOOL_INPUT_SCHEMA \}\)/);
  assert.deepEqual(unbound(source), []);
  // Live controls: each call site rewritten in its own spelling, and each name planted in code, is reported.
  const rewritten = ([from, to]) => {
    assert.equal(source.split(from).length - 1, 1, 'the control anchor must be found once — ' + from);
    return unbound(source.replace(from, () => to));
  };
  const outcomes = [
    ...[['$.clock.after(COUNTDOWN_MS,', '$.clock.after(2 * 60 * 1000,'], ['$.clock.after(STOP_WAIT_MS,', '$.clock.after(5000,'],
      ['args: inPlaceArgs(id, reason) }', 'args: `continue ${id} in-place ${reason}` }'], ['args: inPlaceArgs(id, reason) }', "args: 'continue ' + id }"],
      ['args: inPlaceArgs(id, reason) }', 'args: continueArgs(id) }'],
      ['args: afterClearArgs(c.ledger) }', 'args: "continue " + c.ledger + " after" + "-clear" }']].map(rewritten),
    ...['const x = "after-clear";', "const y = 'mcp__orchestrate-mod__schedule_clear';", 'const n = 120000;', 'const m = 120_000;'].map(line => unbound(source + '\n' + line + '\n')),
  ];
  assert.deepEqual(outcomes, [['waits: STOP_WAIT_MS | 0 | 2 * 60 * 1000'], ['waits: 5000 | 0 | COUNTDOWN_MS'],
    ['orchestrate: unbound | afterClearArgs', 'literal: `continue '], ['orchestrate: unbound | afterClearArgs', "literal: 'continue "],
    ['orchestrate: continueArgs | afterClearArgs'],
    ['orchestrate: inPlaceArgs | unbound', 'literal: "continue '], ['literal: "after-clear'], ["literal: 'mcp__orchestrate-mod__schedule_clear"],
    ['number: 120000'], ['number: 120_000']]);
  // A comment may name them.
  assert.deepEqual(['after-clear', 'schedule_clear', "'continue ", '120000'].map(word => unbound(source + '\n// ' + word + '\n/* ' + word + ' */\n')), [[], [], [], []]);
});

const IMPORTS = /^\s*import\b|\bimport\s*\(|\brequire\s*\(|^\s*export\s*(?:\*|\{[^}]*\})\s*(?:as\s+\w+\s*)?from\b/m;
test('clear.js imports nothing, and re-exports nothing from another module', () => {
  const source = readText('orchestrate-mod/hooks/clear.js');
  assert.equal(IMPORTS.test(source), false);
  const lines = ["import { validId } from './cost.js';", "const m = await import('./cost.js');", "const fs = require('fs');",
    "export { validId } from './cost.js';", "export * from './cost.js';", "export * as cost from './cost.js';"];
  assert.deepEqual(lines.filter(line => !IMPORTS.test(source + '\n' + line + '\n')), [], 'the controls: each line is caught');
});

// ===== The SHA and the worktree =========================================================

test('validSha: 40 or 64 lowercase hex, and no length or character either side', async () => {
  const { validSha } = await clear;
  const verdicts = [['a', 39], ['a', 40], ['a', 41], ['b', 63], ['b', 64], ['b', 65], ['0', 40], ['f', 64]].map(([ch, n]) => validSha(ch.repeat(n)));
  assert.deepEqual(verdicts, [false, true, false, false, true, false, true, true]);
  const bad = ['A'.repeat(40), 'g'.repeat(40), 'a'.repeat(39) + ' ', ' ' + 'a'.repeat(40), 'a'.repeat(40) + '\n', SHA.slice(0, 7), '', undefined, null, 40, ['a'.repeat(40)]];
  assert.deepEqual(bad.map(validSha), bad.map(() => false));
});

test('worktreeHolding: the path holding the branch, LF or CRLF, as git spells it on either platform', async () => {
  const { worktreeHolding } = await clear;
  const results = [
    worktreeHolding(porcelain('\n'), BRANCH),
    worktreeHolding(porcelain('\r\n'), BRANCH),
    worktreeHolding(porcelain('\r\n', p => 'C:' + p), BRANCH),
    worktreeHolding(porcelain('\n', p => 'C:' + p.replace(/\//g, '\\')), BRANCH),
    worktreeHolding(porcelain('\n', p => p.replace('/work', '/home/Jo Ann/work')), BRANCH),
    worktreeHolding(porcelain('\n'), 'main'),
  ];
  assert.deepEqual(results, [{ path: '/work/int' }, { path: '/work/int' }, { path: 'C:/work/int' }, { path: 'C:\\work\\int' }, { path: '/home/Jo Ann/work/int' }, { path: '/work/repo' }]);
});

test('worktreeHolding: none holds it, a branch that only starts with its name, two holders, a record without its worktree line', async () => {
  const { worktreeHolding } = await clear;
  assert.deepEqual(worktreeHolding(porcelain('\n'), 'feat/x'), { none: true });
  assert.deepEqual(worktreeHolding(porcelain('\n'), 'chore/clear'), { none: true });
  assert.deepEqual(worktreeHolding(porcelain('\n').replace('refs/heads/' + BRANCH, 'refs/heads/' + BRANCH + '-old'), BRANCH), { none: true });
  assert.deepEqual(worktreeHolding('', BRANCH), { none: true });
  assert.deepEqual(worktreeHolding(porcelain('\n') + 'worktree /work/again\nHEAD ' + SHA + '\nbranch refs/heads/' + BRANCH + '\n', BRANCH), { error: '2 worktrees hold ' + BRANCH });
  assert.deepEqual(worktreeHolding('HEAD ' + SHA + '\nbranch refs/heads/' + BRANCH + '\n', BRANCH), { error: 'a record opens with HEAD ' + SHA });
  assert.deepEqual(worktreeHolding(porcelain('\n') + '\nbranch refs/heads/' + BRANCH + '\n', BRANCH), { error: 'a record opens with branch refs/heads/' + BRANCH });
});

// ===== Agents and the turn's end ========================================================

test('shown: each control character and line break a space, at most 80 characters and then …, ? for no string', async () => {
  const { shown, SHOWN_MAX } = await clear;
  assert.equal(SHOWN_MAX, 80);
  const codes = [0, 9, 10, 11, 12, 13, 27, 31, 127, 128, 0x85, 159, 0x2028, 0x2029];
  assert.deepEqual(codes.map(code => shown('a' + String.fromCharCode(code) + 'b')), codes.map(() => 'a b'));
  // The controls: a space, a no-break space and the last character below DEL are kept.
  assert.deepEqual([32, 160, 126].map(code => shown('a' + String.fromCharCode(code) + 'b')), [32, 160, 126].map(code => 'a' + String.fromCharCode(code) + 'b'));
  assert.equal(shown('a' + String.fromCharCode(13, 10) + 'b'), 'a  b', 'each one a space, not each run');
  const x = n => 'x'.repeat(n);
  assert.deepEqual([0, 79, 80, 81, 200].map(n => shown(x(n))), ['', x(79), x(80), x(80) + '…', x(80) + '…']);
  assert.equal(shown(x(79) + '🟢🟢'), x(79) + '🟢…', 'cut by character, never inside one');
  assert.deepEqual([undefined, null, 5, {}, ['x']].map(shown), ['?', '?', '?', '?', '?']);
});

test('agentsReason: in flight unless completed, failed or killed, each named; an answer that is no list cannot be read', async () => {
  const { agentsReason, SETTLED } = await clear;
  assert.deepEqual(SETTLED, ['completed', 'failed', 'killed']);
  const lists = [[], SETTLED.map(status => ({ id: status, status })), [{ status: 'running' }], [{ status: 'pending' }], [{ status: 'suspended' }],
    [{ status: 'completed' }, { status: 'Completed' }], [{}], [null], ['completed'], undefined, { error: 'no list now' }, null];
  const flight = status => 'an agent is in flight: ? (?, "?", ' + status + ')';
  assert.deepEqual(lists.map(agentsReason), [null, null, flight('running'), flight('pending'), flight('suspended'), flight('Completed'),
    flight('?'), flight('?'), flight('?'), 'the agent list cannot be read', 'the agent list cannot be read', 'the agent list cannot be read']);
});

test('agentsReason: a waiting agent reads returned its report with a command still running; every unsettled agent is named, none settled, one as an agent and several as agents', async () => {
  const { agentsReason, WAITING } = await clear;
  assert.equal(WAITING, 'waiting: returned its report; a command of its own still runs');
  // The entry `$.agent.list()` gives on 2.1.307 for a sub-agent that handed back with a background command of its own running.
  const waiting = { id: 'a0adf6f1a25021318', description: 'probe leaker C', type: 'general-purpose', status: 'waiting' };
  assert.equal(agentsReason([waiting]), 'an agent is in flight: a0adf6f1a25021318 (general-purpose, "probe leaker C", waiting: returned its report; a command of its own still runs)');
  const running = { id: 'a-2', description: 'implement B03', type: 'Explore', status: 'running' }, done = { id: 'a-1', description: 'done', type: 'Plan', status: 'completed' };
  assert.equal(agentsReason([waiting, done, running]), 'agents are in flight: a0adf6f1a25021318 (general-purpose, "probe leaker C", ' + WAITING
    + '); a-2 (Explore, "implement B03", running)');
  // Several is any count past one, not two alone: three in flight read as agents too.
  assert.equal(agentsReason([waiting, done, running, { ...running, id: 'a-5', description: 'implement B04' }]), 'agents are in flight: a0adf6f1a25021318 (general-purpose, "probe leaker C", '
    + WAITING + '); a-2 (Explore, "implement B03", running); a-5 (Explore, "implement B04", running)');
  // The count is of the agents in flight, not of the list: one unsettled beside a settled one is still one agent.
  assert.equal(agentsReason([done, running]), 'an agent is in flight: a-2 (Explore, "implement B03", running)');
  // A description cannot fake a line, nor run past 80 characters.
  const forged = 'first' + String.fromCharCode(10) + 'declined: forged', long = 'd'.repeat(81);
  assert.equal(agentsReason([{ ...running, id: 'a-3', description: forged }, { ...running, id: 'a-4', description: long }]),
    'agents are in flight: a-3 (Explore, "first declined: forged", running); a-4 (Explore, "' + 'd'.repeat(80) + '…", running)');
  // Every shown field, not the description alone: the id, the type and the status each on one line, the type cut at 80.
  const LF = String.fromCharCode(10), CR = String.fromCharCode(13);
  assert.equal(agentsReason([{ id: 'a' + LF + 'b', type: 'T' + CR + LF + 'x'.repeat(90), description: 'd', status: 'run' + LF + 'ning' }]),
    'an agent is in flight: a b (T  ' + 'x'.repeat(77) + '…, "d", run ning)');
});

test('stopReason: both lists empty is null; each task named by its command, else its description, each cron by its schedule; either absent or no list is unknown', async () => {
  const { stopReason } = await clear;
  // The two task entries a 2.1.307 Stop gives: a shell with its command, a sub-agent with none.
  const task = { id: 'bmr94wa0m', type: 'shell', status: 'running', description: 'probe leak sleep C', command: 'sleep 1800' };
  const agent = { id: 'a70c0ff43ab64663d', type: 'subagent', status: 'running', description: 'probe leaker E', agent_type: 'general-purpose' };
  const cron = { id: 'c1', schedule: '* * * * *', recurring: true, prompt: 'x' };
  const running = 'background work is running: bmr94wa0m (shell, sleep 1800)', waking = 'a scheduled task would wake this conversation: c1 (* * * * *)';
  const events = [{ background_tasks: [], session_crons: [] }, { background_tasks: [task], session_crons: [] }, { background_tasks: [], session_crons: [cron] },
    { background_tasks: [task], session_crons: [cron] }, { background_tasks: [task] }, { session_crons: [cron] }, { session_crons: [] }, { background_tasks: [] }, {},
    { background_tasks: null, session_crons: [] }, { background_tasks: [], session_crons: {} }, { background_tasks: 'none', session_crons: [] }];
  assert.deepEqual(events.map(stopReason), [null, running, waking, running, running, waking, 'background work is unknown', 'background work is unknown', 'background work is unknown',
    'background work is unknown', 'background work is unknown', 'background work is unknown']);
  assert.equal(stopReason({ background_tasks: [task, agent, null], session_crons: [] }),
    'background work is running: bmr94wa0m (shell, sleep 1800); a70c0ff43ab64663d (subagent, probe leaker E); ? (?, ?)');
  assert.equal(stopReason({ background_tasks: [], session_crons: [cron, { id: 'c2', schedule: '0 9 * * 1', recurring: false, prompt: 'y' }, 'c3'] }),
    'a scheduled task would wake this conversation: c1 (* * * * *); c2 (0 9 * * 1); ? (?)');
  // A command, a description and a schedule cannot fake a line, nor run past 80 characters.
  const forged = 'tail -f log' + String.fromCharCode(13, 10) + 'clear', long = 'c'.repeat(81);
  assert.deepEqual([stopReason({ background_tasks: [{ ...task, command: forged }, { ...agent, description: long }], session_crons: [] }),
    stopReason({ background_tasks: [], session_crons: [{ ...cron, schedule: long }] })],
  ['background work is running: bmr94wa0m (shell, tail -f log  clear); a70c0ff43ab64663d (subagent, ' + 'c'.repeat(80) + '…)',
    'a scheduled task would wake this conversation: c1 (' + 'c'.repeat(80) + '…)']);
  // Every shown field, not those alone: a task's id and type, a cron's id, each on one line, the type cut at 80.
  const LF = String.fromCharCode(10), CR = String.fromCharCode(13);
  assert.deepEqual([stopReason({ background_tasks: [{ ...task, id: 'b' + LF + '1', type: 'sh' + CR + 'ell' + 'y'.repeat(90) }], session_crons: [] }),
    stopReason({ background_tasks: [], session_crons: [{ ...cron, id: 'c' + LF + '1' }] })],
  ['background work is running: b 1 (sh ell' + 'y'.repeat(74) + '…, sleep 1800)', 'a scheduled task would wake this conversation: c 1 (* * * * *)']);
});

// ===== The decision =====================================================================

test('decide: every fact passing schedules; each gathered in order, the status only where a worktree holds the branch', async () => {
  const { decide } = await clear;
  assert.deepEqual(decide(passing()), { scheduled: true });
  const full = passing(), steps = [];
  for (const facts = { agentId: undefined, ledger: ID, ledgerValid: true, sha: SHA, busy: false }; ;) {
    const verdict = decide(facts);
    steps.push(verdict);
    if (verdict.need === undefined) break;
    facts[verdict.need] = full[verdict.need];
  }
  assert.deepEqual(steps, [{ need: 'read' }, { need: 'context' }, { need: 'protocol' }, { need: 'worktrees' }, { need: 'status', cwd: '/work/int' }, { need: 'agents' }, { scheduled: true }]);
  const none = { ...passing({ worktrees: run(porcelain('\n').replace('refs/heads/' + BRANCH, 'refs/heads/other')) }), status: undefined };
  assert.deepEqual(decide(none), { scheduled: true });
  assert.deepEqual(decide({ ...none, agents: undefined }), { need: 'agents' });
});

// Each reason's own cases: one fact of a passing call changed, and the reason that alone declines it.
const REASONS = [
  ['a', { agentId: 'agent-1' }, 'only the main conversation can schedule a clear'],
  ['a', { agentId: '' }, 'only the main conversation can schedule a clear'],
  ['b', { ledgerValid: false }, 'ledger is not a ledger id'],
  ['b', { ledgerValid: undefined }, 'ledger is not a ledger id'],
  ['b', { sha: SHA.toUpperCase() }, 'sha is not a full commit SHA (40 or 64 lowercase hex characters)'],
  ['c', { busy: true }, 'a clear is already scheduled'],
  ['d', { read: { ...passing().read, tag: null } }, "this session's ledger tag is none, not " + ID],
  ['d', { read: { ...passing().read, tag: 'OS-20261001-other' } }, "this session's ledger tag is OS-20261001-other, not " + ID],
  ['d', { read: { ...passing().read, view: { error: 'exit 1' } } }, 'the ledger view cannot be read: exit 1'],
  ['d', { read: { ...passing().read, view: { incomplete: false, ledger: null, more: 0 } } }, 'the ledger view lists no ' + ID],
  ['d', { read: { ...passing().read, view: { incomplete: false, ledger: ledgerOf({ id: 'OS-20261001-other' }), more: 0 } } }, 'the ledger view lists no ' + ID],
  ['d', { read: { ...passing().read, view: { incomplete: false, ledger: ledgerOf({ error: 'UNKNOWN x' }), more: 0 } } }, 'the ledger view of ' + ID + ' carries an error: UNKNOWN x'],
  ['e', { read: { ...passing().read, view: { incomplete: false, ledger: ledgerOf({ integration: { branch: BRANCH, sha: 'e'.repeat(40) } }), more: 0 } } },
    'the integration tip is ' + 'e'.repeat(40) + ', not ' + SHA],
  ['e', { read: { ...passing().read, view: { incomplete: false, ledger: ledgerOf({ integration: null }), more: 0 } } }, 'the integration tip is ?, not ' + SHA],
  ['e', { read: { ...passing().read, view: { incomplete: false, ledger: ledgerOf({ integration: { branch: BRANCH, sha: null } }), more: 0 } } }, 'the integration tip is ?, not ' + SHA],
  ['f', { read: readWith({ clearThreshold: { error: 'line 5 is not **Clear threshold**: <n>K' } }) }, "the ledger's Clear threshold line cannot be read: line 5 is not **Clear threshold**: <n>K"],
  ['f', { read: readWith({ clearThreshold: null }) }, "the ledger's Clear threshold line cannot be read: the ledger view carries none"],
  ['f', { read: readWith({ clearThreshold: undefined }) }, "the ledger's Clear threshold line cannot be read: the ledger view carries none"],
  // Each a form no field but one breaks: tokens no integer, no whole thousand, below zero; a source of neither kind.
  ...[{ tokens: '300000', source: 'contract' }, { tokens: 300500, source: 'contract' }, { tokens: -1000, source: 'contract' }, { tokens: 300000, source: 'ledger' }]
    .map(clearThreshold => ['f', { read: readWith({ clearThreshold }) }, "the ledger's Clear threshold line cannot be read: the ledger view carries it in no form this mod reads"]),
  ['g', { protocol: { error: 'ENOENT' } }, 'the pinned protocol.md cannot be read: ENOENT'],
  ['g', { protocol: { text: 'call mcp__orchestrate-mod__schedule-clear here' } }, 'the pinned protocol.md does not name ' + TOOL],
  // The tight cases: the short name alone, and another plugin's tool of that name.
  ['g', { protocol: { text: 'call schedule_clear here' } }, 'the pinned protocol.md does not name ' + TOOL],
  ['g', { protocol: { text: 'call mcp__other-mod__schedule_clear here' } }, 'the pinned protocol.md does not name ' + TOOL],
  ['h', { worktrees: { error: 'git cannot start' } }, 'git worktree list failed: git cannot start'],
  ['h', { worktrees: run(porcelain('\n'), { isStdoutTruncated: true }) }, 'git worktree list was cut short'],
  ['h', { worktrees: run('', { exitCode: 128 }) }, 'git worktree list exited 128'],
  ['h', { worktrees: run('HEAD x\n') }, 'git worktree list cannot be read: a record opens with HEAD x'],
  ['h', { status: { error: 'git cannot start' } }, 'git status failed: git cannot start'],
  ['h', { status: run('', { isStdoutTruncated: true }) }, 'git status was cut short'],
  ['h', { status: run('', { exitCode: 1 }) }, 'git status exited 1'],
  ['h', { status: run('?? .agents/changes/' + ID + '/x.md\n') }, 'uncommitted files in .agents/changes/' + ID + '/ of /work/int'],
  ['h', { status: run(' M .agents/changes/' + ID + '/PROGRESS.md\n') }, 'uncommitted files in .agents/changes/' + ID + '/ of /work/int'],
  ['i', { agents: [{ id: 'a', type: 'Explore', description: 'look', status: 'running' }] }, 'an agent is in flight: a (Explore, "look", running)'],
  ['i', { agents: { error: 'no list now' } }, 'the agent list cannot be read'],
];
test('decide: each reason declines a call that only it stops, and every reason a–i has its cases', async () => {
  const { decide } = await clear;
  const got = REASONS.map(([, change]) => decide(passing(change)));
  assert.deepEqual(got, REASONS.map(([, , reason]) => ({ declined: reason })));
  assert.deepEqual([...new Set(REASONS.map(([letter]) => letter))], ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i']);
  // Each reason after the threshold step declines with the context unknown too: an unknown size is never small.
  const later = REASONS.filter(([letter]) => 'ghi'.includes(letter));
  for (const context of [null, { error: 'no usage here' }]) {
    assert.deepEqual(later.map(([, change]) => decide(passing({ ...change, context }))), later.map(([, , reason]) => ({ declined: reason })), JSON.stringify(context));
  }
});

test('decide: with every reason applying, the first decides; each fixed in turn hands the call to the next, in order a–i, the threshold among them', async () => {
  const { decide } = await clear;
  const moved = { incomplete: false, ledger: ledgerOf({ integration: { branch: BRANCH, sha: 'e'.repeat(40) }, clearThreshold: { error: 'line 5 is not **Clear threshold**: <n>K' } }), more: 0 };
  const worst = passing({ agentId: 'agent-1', ledgerValid: false, sha: 'x', busy: true, read: { ...passing().read, tag: null, view: moved }, context: 299999,
    protocol: { error: 'ENOENT' }, status: run('?? x\n'), agents: [{ status: 'running' }] });
  const fixes = [f => ({ ...f, agentId: undefined }), f => ({ ...f, ledgerValid: true }), f => ({ ...f, sha: SHA }), f => ({ ...f, busy: false }),
    f => ({ ...f, read: { ...f.read, tag: ID } }), f => ({ ...f, read: { ...f.read, view: { ...moved, ledger: { ...moved.ledger, integration: { branch: BRANCH, sha: SHA } } } } }),
    f => ({ ...f, read: passing().read }), f => ({ ...f, context: 300000 }), f => ({ ...f, protocol: passing().protocol }),
    f => ({ ...f, status: run('') }), f => ({ ...f, agents: passing().agents })];
  const sequence = [];
  let facts = worst;
  for (const fix of fixes) {
    sequence.push(decide(facts));
    facts = fix(facts);
  }
  sequence.push(decide(facts));
  const declines = reasons => reasons.map(declined => ({ declined }));
  assert.deepEqual(sequence, [...declines(['only the main conversation can schedule a clear', 'ledger is not a ledger id', 'sha is not a full commit SHA (40 or 64 lowercase hex characters)',
    'a clear is already scheduled', "this session's ledger tag is none, not " + ID, 'the integration tip is ' + 'e'.repeat(40) + ', not ' + SHA,
    "the ledger's Clear threshold line cannot be read: line 5 is not **Clear threshold**: <n>K"]),
  { notNeeded: { tokens: 299999, threshold: 300000, source: 'contract' } },
  ...declines(['the pinned protocol.md cannot be read: ENOENT', 'uncommitted files in .agents/changes/' + ID + '/ of /work/int', 'an agent is in flight: ? (?, "?", running)']),
  { scheduled: true }]);
});

test('decide: a context known and under the threshold is not needed; at it, over it or unknown, the checks after it run', async () => {
  const { decide } = await clear;
  const at = (context, clearThreshold = { tokens: 300000, source: 'contract' }) => decide(passing({ context, read: readWith({ clearThreshold }) }));
  const under = (tokens, threshold = 300000, source = 'contract') => ({ notNeeded: { tokens, threshold, source } });
  assert.deepEqual([0, 299999, 300000, 300001].map(c => at(c)), [under(0), under(299999), { scheduled: true }, { scheduled: true }]);
  // Unknown is never under it: no reading, a refused one, and anything that is no count, each held to a size that would be under it.
  assert.deepEqual([null, { error: 'no usage here' }, NaN, -1, -Infinity, '1000'].map(c => at(c)), Array(6).fill({ scheduled: true }));
  assert.deepEqual(at(212000, { tokens: 300000, source: 'default' }), under(212000, 300000, 'default'));
  assert.deepEqual([249999, 250000].map(c => at(c, { tokens: 250000, source: 'contract' })), [under(249999, 250000), { scheduled: true }]);
  // A 0K threshold, which ledger-view.mjs reads, is a threshold: no context is under it, so every call goes on to schedule.
  assert.deepEqual([0, 1].map(c => at(c, { tokens: 0, source: 'contract' })), [{ scheduled: true }, { scheduled: true }]);
  // Not needed is decided before the protocol, git and the agents are read; at the threshold or unknown, they are read next.
  const early = { agentId: undefined, ledger: ID, ledgerValid: true, sha: SHA, busy: false, read: passing().read };
  assert.deepEqual([undefined, 299999, 300000, null, { error: 'no usage here' }].map(context => decide({ ...early, context })),
    [{ need: 'context' }, under(299999), { need: 'protocol' }, { need: 'protocol' }, { need: 'protocol' }]);
  // A threshold that cannot be read declines before the context is asked for, whatever the context would be.
  const unread = { ...early, read: readWith({ clearThreshold: { error: '2 lines' } }) };
  assert.deepEqual([undefined, null, { error: 'no usage here' }, 299999, 300000].map(context => decide({ ...unread, context })),
    Array(5).fill({ declined: "the ledger's Clear threshold line cannot be read: 2 lines" }));
});

// ===== The line, the countdown and the notices ==========================================

test('scheduledLine: the context in thousands rounded on both sides of a half, ?K when there is no reading', async () => {
  const { scheduledLine, COUNTDOWN_MS } = await clear;
  assert.equal(scheduledLine(412345, ID), 'Context 412K: clearing this conversation in about two minutes and continuing ' + ID
    + ' in a fresh one; any message before then keeps this conversation.');
  assert.equal(COUNTDOWN_MS, 2 * 60000, 'the line says two minutes');
  const context = tokens => /^Context (\S+):/.exec(scheduledLine(tokens, ID))[1];
  assert.deepEqual([0, 499, 500, 1499, 1500, 388000].map(context), ['0K', '0K', '1K', '1K', '2K', '388K']);
  assert.deepEqual([null, undefined, NaN, Infinity, -1, '412345'].map(context), ['?K', '?K', '?K', '?K', '?K', '?K']);
});

test('notNeededLine: the context floored to thousands, under the ledger\'s threshold or the default one', async () => {
  const { notNeededLine } = await clear;
  assert.equal(notNeededLine({ tokens: 299999, threshold: 300000, source: 'contract' }), "context 299K is under the ledger's 300K clear threshold");
  assert.equal(notNeededLine({ tokens: 212000, threshold: 300000, source: 'default' }), 'context 212K is under the default 300K clear threshold');
  assert.equal(notNeededLine({ tokens: 1, threshold: 250000, source: 'contract' }), "context 0K is under the ledger's 250K clear threshold");
  const context = tokens => /^context (\S+) /.exec(notNeededLine({ tokens, threshold: 300000, source: 'contract' }))[1];
  assert.deepEqual([0, 999, 1000, 1499, 1500, 1999, 212345].map(context), ['0K', '0K', '1K', '1K', '1K', '1K', '212K']);
});

test('countdownText: the seconds left rounded up, as M:SS, at each boundary', async () => {
  const { countdownText } = await clear;
  const left = ms => /^clearing in (\d+:\d\d) · type anything to keep this conversation$/.exec(countdownText(ms))[1];
  assert.deepEqual([120000, 119001, 119000, 60001, 60000, 59999, 10000, 9999, 1000, 999, 1, 0, -1000].map(left),
    ['2:00', '2:00', '1:59', '1:01', '1:00', '1:00', '0:10', '0:10', '0:01', '0:01', '0:01', '0:00', '0:00']);
});

test('the notices: a skip continuing here, a skip whose continue was refused, a clear whose continue was refused', async () => {
  const { skipNotice, afterClearNotice } = await clear;
  assert.equal(skipNotice('background work is running', ID, true), 'clear skipped: background work is running — continuing here');
  assert.equal(skipNotice('background work is running', ID, false), 'clear skipped: background work is running — type /orchestrate continue ' + ID);
  assert.equal(afterClearNotice(ID), 'cleared — type /orchestrate continue ' + ID + ' after-clear');
});

// ===== The run ==========================================================================

test('linkClear: a clear from the run\'s last conversation for its ledger joins it; any other begins a run', async () => {
  const { linkClear } = await clear;
  const c = (before, after, ledger = ID) => ({ ledger, before, after, at: 1, tzOffset: 0, tokens: 2 });
  const first = linkClear(null, c('s-1', 's-2'));
  assert.deepEqual(first, { ledger: ID, ids: ['s-1', 's-2'], clears: [{ at: 1, tzOffset: 0, tokens: 2 }] });
  const second = linkClear(first, c('s-2', 's-3'));
  assert.deepEqual([second.ids, second.clears.length], [['s-1', 's-2', 's-3'], 2]);
  assert.deepEqual(first.ids, ['s-1', 's-2'], 'the run it joined is left as it was');
  const fresh = [linkClear(second, c('s-9', 's-10')), linkClear(second, c('s-3', 's-4', 'OS-20261001-other')), linkClear(linkClear(null, c('s-1', null)), c(null, 's-5'))];
  assert.deepEqual(fresh.map(r => [r.ledger, r.ids, r.clears.length]), [[ID, ['s-9', 's-10'], 1], ['OS-20261001-other', ['s-3', 's-4'], 1], [ID, [null, 's-5'], 1]]);
  // An earlier conversation of the run, resumed and cleared, is not where the run ended: it begins a run too.
  assert.deepEqual([linkClear(second, c('s-1', 's-9')), linkClear(second, c('s-2', 's-9'))], [
    { ledger: ID, ids: ['s-1', 's-9'], clears: [{ at: 1, tzOffset: 0, tokens: 2 }] }, { ledger: ID, ids: ['s-2', 's-9'], clears: [{ at: 1, tzOffset: 0, tokens: 2 }] }]);
});

test('runTotal: the conversations\' totals summed; one with none adds $0.00, an id unknown counts unpriced', async () => {
  const { runTotal } = await clear;
  const sessions = new Map([['s-1', { usd: 2.4, unpriced: 0 }], ['s-2', { usd: 1.25, unpriced: 2 }], ['s-x', { usd: 99, unpriced: 0 }]]);
  assert.deepEqual(runTotal(['s-1', 's-2'], sessions), { usd: 3.65, unpriced: 2, conversations: 2 });
  assert.deepEqual(runTotal(['s-1', 's-3'], sessions), { usd: 2.4, unpriced: 0, conversations: 2 });
  assert.deepEqual(runTotal([null, 's-1', null], sessions), { usd: 2.4, unpriced: 2, conversations: 3 });
});
