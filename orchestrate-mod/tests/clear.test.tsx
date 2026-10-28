// The clear and continue through the Claude CLI's test kit (`claude plugin test orchestrate-mod`): the hooks of
// orchestrate-mod/hooks/register.js that serve schedule_clear, watch the turn's end, count down in the band and run
// /clear and /orchestrate continue, over stubs for every `$` call they make. Named *.test.tsx: the kit runs it and
// Node's bare `node --test` passes it over.
import { describe, expect, mock, test } from 'claude-code/testing'

const T0 = 1791460800000 // 2026-10-08T12:00:00.000Z
const MIN = 60000
const COUNTDOWN = 120000
const HOME = '/home/u'
const ROOT = '/work/repo'
const INT = '/work/int'
const SKILL = HOME + '/.claude/skills/orchestrate'
const PINNED = HOME + '/.local/share/orchestrate-x/orchestrate'
const PROTOCOL_PATH = PINNED + '/references/protocol.md'
const ID = 'OS-20261010-clear-continue'
const OTHER = 'OS-20261001-other'
const BRANCH = 'chore/clear-continue-ledger'
const SHA = '0123456789abcdef'.repeat(2) + '01234567'
const TOOL = 'mcp__orchestrate-mod__schedule_clear'
const PROTOCOL = '8. At a safe point call `mcp__orchestrate-mod__schedule_clear` with the ledger id and the tip.\n'
const DESCRIPTION = 'orchestrate-mod: schedules an automatic clear of this conversation followed by /orchestrate continue <ledger> after-clear.'
  + " Call it only where your ledger's pinned protocol.md (§Session algorithm step 8) names this tool, with the ledger id and the"
  + " integration branch's full tip SHA. The answer begins `scheduled` (post the line it gives, then end your turn), `not needed`"
  + " (carry on: no clear and no timer) or `declined` (take the timer path, after any retry your ledger's step 8 names)."
const SCHEDULED = 'scheduled: Context 412K: clearing this conversation in about two minutes and continuing ' + ID
  + ' in a fresh one; any message before then keeps this conversation.'
const USAGE = { startedAt: T0, context: { tokens: 412345, window: 1000000, percent: 41 }, rateLimits: [], cost: { usd: 2.75 } }
// A fresh conversation's reading, what the session reports once /clear has run.
const FRESH = { startedAt: T0, context: { tokens: 18000, window: 1000000, percent: 2 }, rateLimits: [], cost: { usd: 0 } }
// One main-loop request prices at $2.40 (orchestrate-mod/hooks/prices.js, claude-opus-5-5).
const MAIN_USAGE = { input_tokens: 100000, output_tokens: 50000, cache_read_input_tokens: 1000000, cache_creation_input_tokens: 100000, model: 'claude-opus-5-5' }
const SETTLED_AGENTS = ['completed', 'failed', 'killed'].map((status, n) => ({ id: 'agent-' + n, description: 'done', type: 'Plan', status }))
const EMPTY = { background_tasks: [], session_crons: [] }
const TASK = { id: 'b1', type: 'shell', status: 'running', description: 'sleep 120', command: 'sleep 120' }
// The entries 2.1.307 gives: a sub-agent that handed back with a background command of its own running, in the agent
// list, and a sub-agent's task at the Stop, with no command.
const WAITING = { id: 'a0adf6f1a25021318', description: 'probe leaker C', type: 'general-purpose', status: 'waiting' }
const AGENT_TASK = { id: 'a70c0ff43ab64663d', type: 'subagent', status: 'running', description: 'probe leaker E', agent_type: 'general-purpose' }
const CRON = { id: 'c1', schedule: '*/5 * * * *', recurring: true, prompt: 'check the build' }
const BAND = { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 200, scroll: { offset: 0, bodyRows: 10 }, view: {} }
const PANE = { title: 'Ledger', isFocused: true, bodyColumns: 200, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} }
const BAND_TAIL = 'OS-…-clear-continue · W1 · ctx 412K/1M · $0.00 · /ledger'
const counted = left => 'clearing in ' + left + ' · type anything to keep this conversation · ' + BAND_TAIL
const continueHere = reason => ['orchestrate', 'continue ' + ID + ' in-place ' + reason]
const CLEARED = [['clear', ''], ['orchestrate', 'continue ' + ID + ' after-clear']]

// The engine resolves every `fs` path natively before a stub sees it, so on Windows `/home/u/x` arrives as
// `C:\home\u\x`; `win32` hands each `fs` stub that spelling, which it respells into the posix form the expectations
// are written in. In `win32` the session root is `C:\work\repo` and git prints `C:/work/int` with CRLF, each
// respelled where a stub reads it, so both spellings reach the hooks on every platform.
const posix = p => (/^[A-Za-z]:[\\/]/.test(p) ? p.slice(2).replace(/\\/g, '/') : p)
const asWindows = p => p.replace(/^(?:[A-Za-z]:)?/, 'C:').replace(/\//g, '\\')
const SPELLINGS = ['native', 'win32']
const hhmm = ms => new Date(ms - new Date(ms).getTimezoneOffset() * MIN).toISOString().slice(11, 16)
const discoveryLine = id => id + ' State=ACTIVE at ' + BRANCH + ', /work/a b/.agents/changes/' + id + '/PROGRESS.md → continue'
const ledgerOf = (over = {}) => ({ id: ID, state: 'ACTIVE', integration: { branch: BRANCH, sha: SHA }, skillDir: PINNED, clearThreshold: { tokens: 300000, source: 'contract' }, waves: 2, currentWave: 1,
  nextCheckpoint: 'C1', rows: [], checkpoints: [], error: null, warning: null, ...over })
const viewOf = ledgers => ({ exitCode: 0, stdout: JSON.stringify({ v: 1, repo: ROOT, incomplete: false, ledgers }) + '\n' })
// `git worktree list --porcelain` as git prints it: the root on main, then `holders`, each holding the integration branch.
function porcelain(spelling, holders = [INT]) {
  const at = p => (spelling === 'win32' ? 'C:' + p : p)
  const records = [['worktree ' + at(ROOT), 'HEAD ' + 'f'.repeat(40), 'branch refs/heads/main'],
    ...holders.map(path => ['worktree ' + at(path), 'HEAD ' + SHA, 'branch refs/heads/' + BRANCH]), ['worktree ' + at('/work/old'), 'HEAD ' + SHA, 'detached']]
  return records.map(r => r.join('\n') + '\n').join('\n').replace(/\n/g, spelling === 'win32' ? '\r\n' : '\n')
}

// Every `$` call the hooks make answered from memory. Discovery tags `w.tag` (none when null); the ledger view answers
// `w.view` as it stood when the run began, waiting on `w.gate` when one is set; the pinned protocol.md reads
// `w.protocol` (refused when 'deny'); git answers `w.worktrees` and `w.status` (a run refused when 'deny') and is
// recorded in `w.git`; the agent list answers `w.agents` (refused when 'deny'), waiting on `w.agentGate` when one is
// set. The session's usage answers `w.usages` one by one, then `w.usage`. `/clear` moves the session to the next id of
// `w.next` and its reading to a fresh conversation's; every command that reaches the engine is recorded in
// `w.commands`. A call named in `w.deny` is refused (`command.run <name>` for one command).
function makeWorld(on, o = {}) {
  const spelling = o.spelling, deny = new Set(o.deny ?? [])
  const seen = p => posix(spelling === 'win32' ? asWindows(p) : p)
  const w = {
    clock: mock.clock(on, { now: T0 }),
    deny, session: 's-1', next: ['s-2', 's-3', 's-4'], tag: 'tag' in o ? o.tag : ID,
    view: o.view ?? viewOf([ledgerOf()]), protocol: o.protocol ?? PROTOCOL,
    worktrees: o.worktrees ?? { exitCode: 0, stdout: porcelain(spelling) }, status: o.status ?? { exitCode: 0, stdout: '' },
    agents: o.agents ?? SETTLED_AGENTS, usage: o.usage ?? USAGE, usages: [...(o.usages ?? [])], stopAnswer: {}, gate: null, agentGate: null,
    git: [], reads: [], commands: [], statuses: [], tools: [], registered: [], lists: 0, views: 0, bandDraws: 0,
  }
  mock.env(on, { HOME })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('session.id', () => (deny.has('session.id') ? { deny: 'no session id here' } : { value: w.session }))
  on('session.root', () => ({ value: spelling === 'win32' ? asWindows(ROOT) : ROOT }))
  on('session.usage', () => (deny.has('session.usage') ? { deny: 'no usage here' } : { value: w.usages.length ? w.usages.shift() : w.usage }))
  on('session.surfaces', () => ({ value: [] }))
  on('fs.exists', ($, e) => ({ value: seen(e.path) === SKILL }))
  on('fs.read', ($, e) => {
    const path = seen(e.path)
    w.reads.push(path)
    return path === PROTOCOL_PATH && w.protocol !== 'deny' ? { value: w.protocol } : { deny: 'cannot read ' + path }
  })
  on('fs.write', () => ({ value: undefined }))
  on('process.run', async ($, e) => {
    const argv = e.argv.map(posix), init = { ...e.init, ...(e.init && e.init.cwd ? { cwd: posix(e.init.cwd) } : {}) }
    const answer = r => (r === 'deny' ? { deny: argv[0] + ' cannot start' }
      : { value: { exitCode: r.exitCode, stdout: r.stdout, stderr: '', isStdoutTruncated: Boolean(r.truncated), isStderrTruncated: false } })
    if (argv[1] === SKILL + '/tools/reconcile.mjs') return answer({ exitCode: 0, stdout: w.tag === null ? 'NO LEDGERS\n' : discoveryLine(w.tag) + '\n' })
    if (/\/tools\/ledger-view\.mjs$/.test(argv[1])) {
      w.views += 1
      const view = w.view
      if (w.gate) await w.gate
      return answer(view)
    }
    if (/\/tools\/cost-report\.mjs$/.test(argv[1])) return answer({ exitCode: 0, stdout: 'NO RECORDS ' + HOME + '/.claude/orchestrate-costs\n' })
    w.git.push({ argv, init })
    if (argv[0] === 'git' && argv[2] === 'worktree') return answer(w.worktrees)
    if (argv[0] === 'git' && argv[2] === 'status') return answer(w.status)
    return { deny: 'no such command here: ' + argv.join(' ') }
  })
  on('agent.list', async () => {
    w.lists += 1
    if (w.agentGate) await w.agentGate
    return w.agents === 'deny' ? { deny: 'no list now' } : { value: w.agents }
  })
  on('command.register', ($, e) => { w.registered.push(e.name); return { value: { command: e.name } } })
  on('tool.register', ($, e) => { w.tools.push(e); return deny.has('tool.register') ? { deny: 'no tools here' } : { value: { tool: 'mcp__orchestrate-mod__' + e.name } } })
  on('tool.describe', ($, e) => ({ description: e.description, isDeferred: true }))
  on('command.run', ($, e) => {
    w.commands.push([e.command, e.args])
    if (deny.has('command.run ' + e.command)) throw new Error(e.command + ' cannot run now')
    if (e.command === 'clear') {
      w.session = w.next.shift()
      w.usage = FRESH
    }
    return { text: '' }
  })
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('classic.Stop', () => w.stopAnswer)
  on('turn.step', async function* ($, e) {
    return { turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [], stopReason: 'end_turn', usage: MAIN_USAGE }
  })
  on('ui.status', ($, e) => { w.statuses.push(e.text); return { value: undefined } })
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => { w.bandDraws += 1; const { Text } = $.ui.resolve(e); return h(Text, {}, 'drawn beneath') })
  return w
}

async function start($, w) {
  await $.session.start({ cwd: ROOT, surface: null, isInteractive: true })
  await w.clock.settle()
}
async function drain(stream) {
  for (;;) {
    const item = await stream.next()
    if (item.done) return item.value
  }
}
const call = ($, input = {}) => $.tool.call({ tool: TOOL, tool_use_id: 'toolu_1', ledger: ID, sha: SHA, ...input })
const stop = ($, fields = EMPTY) => $.classic.Stop({ stop_hook_active: false, ...fields })
const complete = ($, reason = 'answer', over = {}) => $.turn.complete({ reason, answer: 'posted', durationMs: 1000, isAborted: reason === 'aborted', turnId: 't-1',
  ...(reason === 'refusal' ? { refusal: { category: null, explanation: null } } : {}), ...over })
const turn = ($, turnId = 't-2', text = 'stay') => $.turn.start({ text, turnId })
const step = $ => drain($.turn.step({ turnId: 't-1', index: 0, model: 'claude-opus-5-5', messageCount: 3 }))
const mountBand = ($, props = BAND) => $.ui.mount({ plugin: 'orchestrate-mod', surface: 'terminal', component: 'AbovePrompt', props })
const mountPane = $ => $.ui.mount({ plugin: 'orchestrate-mod', surface: 'terminal', component: 'Pane', props: PANE, requestId: 'ledger' })
// Every Text of a drawing in order, but for the Texts the Buttons hold as labels: they come last, in the buttons' row.
const texts = async ui => {
  const held = (await ui.findAll({ type: 'Button' })).reduce((n, b) => n + b.children.filter(c => c?.type === 'Text').length, 0)
  const all = await ui.findAll({ type: 'Text' })
  return all.slice(0, all.length - held).map(t => t.text)
}
const paneText = async $ => (await $.command.run({ command: 'ledger', args: '' })).text.split('\n')
// The call answered `scheduled`; then, for a countdown, the turn's unblocked Stop found nothing in flight and the
// turn completed with its answer.
async function scheduled($, w) {
  await start($, w)
  expect(await call($)).toEqual({ result: SCHEDULED })
}
async function counting($, w) {
  await scheduled($, w)
  await stop($)
  await complete($)
}
// The same, the countdown begun 1 s past the 30-second refresh grid: zero falls between two refreshes, so a band
// mounted before it shows only what the clear's own redraws draw.
async function countingOffGrid($, w) {
  await scheduled($, w)
  await w.clock.advance(1000)
  await stop($)
  await complete($)
}

function suite(spelling) {
  const world = (on, o = {}) => makeWorld(on, { ...o, spelling })
  const int = (spelling === 'win32' ? 'C:' : '') + INT

  describe(spelling + ' paths, the tool', () => {
    test('session.start registers schedule_clear with its description and schema, and describe lists it in front', async ($, on) => {
      const w = world(on)
      await start($, w)
      expect(w.tools).toEqual([{ name: 'schedule_clear', description: DESCRIPTION,
        inputSchema: { type: 'object', properties: { ledger: { type: 'string' }, sha: { type: 'string' } }, required: ['ledger', 'sha'] } }])
      expect(w.registered).toEqual(['ledger'])
      const described = await $.tool.describe({ tool: TOOL, description: DESCRIPTION, isDeferred: true, provider: { plugin: 'orchestrate-mod', tier: 'user' } })
      expect(described).toEqual({ description: DESCRIPTION, isDeferred: false })
    })

    test('a refused registration shows one status line and leaves /ledger and the band as they are', async ($, on) => {
      const w = world(on, { deny: ['tool.register'] })
      expect(await $.session.start({ cwd: ROOT, surface: null, isInteractive: true })).toEqual({ cwd: ROOT })
      await w.clock.settle()
      expect(w.statuses).toEqual(['orchestrate-mod: schedule_clear not registered — orchestrate-mod: $.tool.register: no tools here'])
      expect(w.registered).toEqual(['ledger'])
      expect((await paneText($))[0]).toBe(ID + ' · ACTIVE · W1 of 2 · next C1')
      const ui = await mountBand($)
      expect(await texts(ui)).toEqual(['drawn beneath', BAND_TAIL])
      await ui.unmount()
    })

    test('scheduled: the line to post, after a fresh view, the pinned protocol.md, git in the root and the holding worktree, and the agents', async ($, on) => {
      const w = world(on)
      await start($, w)
      const [views, lists] = [w.views, w.lists]
      expect(await call($)).toEqual({ result: SCHEDULED })
      expect([w.views - views, w.lists - lists]).toEqual([1, 2])
      expect(w.reads).toEqual([PROTOCOL_PATH])
      expect(w.git).toEqual([
        { argv: ['git', '--no-optional-locks', 'worktree', 'list', '--porcelain'], init: { cwd: ROOT, timeoutMs: 30000 } },
        { argv: ['git', '--no-optional-locks', 'status', '--porcelain', '--', '.agents/changes/' + ID + '/'], init: { cwd: INT, timeoutMs: 30000 } },
      ])
      expect(w.commands).toEqual([])
    })

    test('a 64-character SHA is accepted; no context reading reads ?K', async ($, on) => {
      const sha = 'ab'.repeat(32)
      const w = world(on, { view: viewOf([ledgerOf({ integration: { branch: BRANCH, sha } })]), usage: { startedAt: T0, context: { window: 1000000 }, rateLimits: [] } })
      await start($, w)
      expect(await call($, { sha })).toEqual({ result: SCHEDULED.replace('412K', '?K') })
    })

    test('a refused usage reads ?K', async ($, on) => {
      const w = world(on, { deny: ['session.usage'] })
      await start($, w)
      expect(await call($)).toEqual({ result: SCHEDULED.replace('412K', '?K') })
    })

    test('no worktree holds the integration branch: nothing is uncommitted there, and no status runs', async ($, on) => {
      const w = world(on, { worktrees: { exitCode: 0, stdout: porcelain(spelling, []) } })
      await start($, w)
      expect(await call($)).toEqual({ result: SCHEDULED })
      expect(w.git.map(g => g.argv[2])).toEqual(['worktree'])
    })

    // The read in flight answers the tip it began under, which the call's SHA is not: only the later read schedules.
    test('a ledger view read in flight when the call comes is followed by one begun after it', async ($, on) => {
      const w = world(on, { view: viewOf([ledgerOf({ integration: { branch: BRANCH, sha: 'e'.repeat(40) } })]) })
      await start($, w)
      let release
      w.gate = new Promise(resolve => { release = resolve })
      await w.clock.advance(30000)
      expect(w.views).toBe(1)
      w.view = viewOf([ledgerOf()])
      const answering = call($)
      await w.clock.settle()
      w.gate = null
      release()
      expect(await answering).toEqual({ result: SCHEDULED })
      expect(w.views).toBe(2)
    })
  })

  describe(spelling + ' paths, the clear threshold', () => {
    const sized = tokens => ({ ...USAGE, context: { tokens, window: 1000000, percent: Math.round(tokens / 10000) } })
    test('one token under the ledger\'s threshold: not needed, nothing past the threshold read, and nothing scheduled or run', async ($, on) => {
      const w = world(on, { usage: sized(299999) })
      await start($, w)
      const lists = w.lists
      expect(await call($)).toEqual({ result: "not needed: context 299K is under the ledger's 300K clear threshold" })
      // The list the read's refresh makes, and none of the decision's own.
      expect([w.reads, w.git, w.lists - lists]).toEqual([[], [], 1])
      await stop($)
      await complete($)
      await w.clock.advance(COUNTDOWN + 10000)
      expect(w.commands).toEqual([])
      // No clear stands scheduled: a call over the threshold schedules.
      w.usage = USAGE
      expect(await call($)).toEqual({ result: SCHEDULED })
    })

    test('at the threshold it schedules, the line naming the size the threshold was held to', async ($, on) => {
      const w = world(on, { usage: sized(300000) })
      await start($, w)
      expect(await call($)).toEqual({ result: SCHEDULED.replace('412K', '300K') })
    })

    test('the default threshold of a contract with no line is named as the default', async ($, on) => {
      const w = world(on, { view: viewOf([ledgerOf({ clearThreshold: { tokens: 300000, source: 'default' } })]), usage: sized(212000) })
      await start($, w)
      expect(await call($)).toEqual({ result: 'not needed: context 212K is under the default 300K clear threshold' })
    })

    test('a ledger\'s own threshold: one under it is not needed, at it schedules', async ($, on) => {
      const w = world(on, { view: viewOf([ledgerOf({ clearThreshold: { tokens: 250000, source: 'contract' } })]), usage: sized(249999) })
      await start($, w)
      expect(await call($)).toEqual({ result: "not needed: context 249K is under the ledger's 250K clear threshold" })
      w.usage = sized(250000)
      expect(await call($)).toEqual({ result: SCHEDULED.replace('412K', '250K') })
    })

    // The session's usage answers the read's refresh under the threshold, the threshold step over it, and any later
    // read far under it: only the threshold step's own reading may decide, and the line posts that one.
    test('the scheduled line posts the size the threshold step read, not another reading', async ($, on) => {
      const w = world(on, { usages: [sized(100000), sized(350000)], usage: sized(5000) })
      await start($, w)
      expect(await call($)).toEqual({ result: SCHEDULED.replace('412K', '350K') })
    })
  })

  describe(spelling + ' paths, every reason to decline, each on its own', () => {
    const declined = reason => ({ result: 'declined: ' + reason })
    // Each case changes one fact of a world that schedules, and says how far the call read: its git runs and reads.
    const cases = [
      ['(a) a sub-agent', {}, { agentId: 'agent-1' }, 'only the main conversation can schedule a clear', [], []],
      ['(b) a ledger that is no id', {}, { ledger: '../x' }, 'ledger is not a ledger id', [], []],
      ['(b) a short SHA', {}, { sha: SHA.slice(0, 7) }, 'sha is not a full commit SHA (40 or 64 lowercase hex characters)', [], []],
      ['(d) an untagged session whose view lists the ledger', { tag: null }, {}, "this session's ledger tag is none, not " + ID, [], []],
      ['(d) a session tagged with another ledger', { tag: OTHER, view: viewOf([ledgerOf({ id: OTHER }), ledgerOf()]) }, {},
        "this session's ledger tag is " + OTHER + ', not ' + ID, [], []],
      ['(d) a view that cannot be read', { view: { exitCode: 2, stdout: 'UNKNOWN discovery did not complete: exit 1\n' } }, {},
        'the ledger view cannot be read: discovery did not complete: exit 1', [], []],
      ['(d) a view without the ledger', { view: viewOf([ledgerOf({ id: OTHER })]) }, {}, 'the ledger view lists no ' + ID, [], []],
      ['(d) the ledger\'s entry with an error', { view: viewOf([ledgerOf({ error: 'UNKNOWN rows did not complete: exit 1' })]) }, {},
        'the ledger view of ' + ID + ' carries an error: UNKNOWN rows did not complete: exit 1', [], []],
      ['(e) a tip that moved', { view: viewOf([ledgerOf({ integration: { branch: BRANCH, sha: 'e'.repeat(40) } })]) }, {},
        'the integration tip is ' + 'e'.repeat(40) + ', not ' + SHA, [], []],
      ...[{}, { deny: ['session.usage'] }].map(o => ['(f) a Clear threshold line that cannot be read' + (o.deny ? ', the context unknown' : ''),
        { ...o, view: viewOf([ledgerOf({ clearThreshold: { error: 'line 5 is not **Clear threshold**: <n>K' } })]) }, {},
        "the ledger's Clear threshold line cannot be read: line 5 is not **Clear threshold**: <n>K", [], []]),
      ['(f) a ledger entry with no clear threshold', { view: viewOf([ledgerOf({ clearThreshold: null })]) }, {},
        "the ledger's Clear threshold line cannot be read: the ledger view carries none", [], []],
      ['(g) a protocol.md that cannot be read', { protocol: 'deny' }, {},
        'the pinned protocol.md cannot be read: orchestrate-mod: $.fs.read: cannot read ' + PROTOCOL_PATH, [], [PROTOCOL_PATH]],
      ['(g) a protocol.md that does not name the tool', { protocol: '8. At a safe point start the timer.\n' }, {},
        'the pinned protocol.md does not name ' + TOOL, [], [PROTOCOL_PATH]],
      ['(h) a worktree list that cannot run', { worktrees: 'deny' }, {}, 'git worktree list failed: orchestrate-mod: $.process.run: git cannot start', ['worktree'], [PROTOCOL_PATH]],
      ['(h) a worktree list that fails', { worktrees: { exitCode: 128, stdout: '' } }, {}, 'git worktree list exited 128', ['worktree'], [PROTOCOL_PATH]],
      ['(h) a worktree list that cannot be read', { worktrees: { exitCode: 0, stdout: 'HEAD ' + SHA + '\n' } }, {},
        'git worktree list cannot be read: a record opens with HEAD ' + SHA, ['worktree'], [PROTOCOL_PATH]],
      ['(h) a status that cannot run', { status: 'deny' }, {}, 'git status failed: orchestrate-mod: $.process.run: git cannot start', ['worktree', 'status'], [PROTOCOL_PATH]],
      ['(h) a status that fails', { status: { exitCode: 128, stdout: '' } }, {}, 'git status exited 128', ['worktree', 'status'], [PROTOCOL_PATH]],
      ['(h) a status cut short', { status: { exitCode: 0, stdout: '', truncated: true } }, {}, 'git status was cut short', ['worktree', 'status'], [PROTOCOL_PATH]],
      ['(h) uncommitted ledger files', { status: { exitCode: 0, stdout: '?? .agents/changes/' + ID + '/notes.md\n' } }, {},
        'uncommitted files in .agents/changes/' + ID + '/ of ' + int, ['worktree', 'status'], [PROTOCOL_PATH]],
      ...['running', 'pending', 'suspended'].map(status => ['(i) an agent ' + status, { agents: [...SETTLED_AGENTS, { id: 'agent-9', description: 'x', type: 'Explore', status }] }, {},
        'an agent is in flight: agent-9 (Explore, "x", ' + status + ')', ['worktree', 'status'], [PROTOCOL_PATH]]),
      ['(i) an agent waiting on a command of its own', { agents: [...SETTLED_AGENTS, WAITING] }, {},
        'an agent is in flight: a0adf6f1a25021318 (general-purpose, "probe leaker C", waiting: returned its report; a command of its own still runs)', ['worktree', 'status'], [PROTOCOL_PATH]],
      ['(i) two agents in flight, both named', { agents: [WAITING, ...SETTLED_AGENTS, { id: 'agent-9', description: 'x', type: 'Explore', status: 'running' }] }, {},
        'agents are in flight: a0adf6f1a25021318 (general-purpose, "probe leaker C", waiting: returned its report; a command of its own still runs); agent-9 (Explore, "x", running)',
        ['worktree', 'status'], [PROTOCOL_PATH]],
      ['(i) an agent list that cannot be read', { agents: 'deny' }, {}, 'the agent list cannot be read', ['worktree', 'status'], [PROTOCOL_PATH]],
    ]
    for (const [label, o, input, reason, git, reads] of cases) {
      test(label + ': declined, and nothing scheduled', async ($, on) => {
        const w = world(on, o)
        await start($, w)
        expect(await call($, input)).toEqual(declined(reason))
        expect([w.git.map(g => g.argv[2]), w.reads]).toEqual([git, reads])
        await stop($)
        await complete($)
        await w.clock.advance(COUNTDOWN + 10000)
        expect(w.commands).toEqual([])
      })
    }

    test('(c) a clear already scheduled, or counting down: declined, and the first goes on', async ($, on) => {
      const w = world(on)
      await scheduled($, w)
      expect(await call($)).toEqual(declined('a clear is already scheduled'))
      await stop($)
      await complete($)
      expect(await call($)).toEqual(declined('a clear is already scheduled'))
      await w.clock.advance(COUNTDOWN)
      expect(w.commands).toEqual(CLEARED)
    })
  })

  describe(spelling + ' paths, the turn\'s end', () => {
    test('a Stop before the turn completes, both lists empty: the countdown starts at the completion', async ($, on) => {
      const w = world(on)
      await scheduled($, w)
      await stop($)
      await w.clock.advance(1000)
      await complete($)
      await w.clock.advance(COUNTDOWN - 1)
      expect(w.commands).toEqual([])
      await w.clock.advance(1)
      expect(w.commands).toEqual(CLEARED)
    })

    test('a Stop after the turn completes starts the countdown at the Stop; the 5-second wait for it runs nothing', async ($, on) => {
      const w = world(on)
      await scheduled($, w)
      await complete($)
      await w.clock.advance(4999)
      await stop($)
      await w.clock.advance(COUNTDOWN - 1)
      expect(w.commands).toEqual([])
      await w.clock.advance(1)
      expect(w.commands).toEqual(CLEARED)
    })

    // The blocked Stop lists work in flight, which would skip the clear were it read.
    test('a Stop answered with block keeps the schedule for the next Stop, which starts the countdown', async ($, on) => {
      const w = world(on)
      await scheduled($, w)
      w.stopAnswer = { block: 'keep going' }
      expect(await stop($, { background_tasks: [TASK], session_crons: [] })).toEqual({ block: 'keep going' })
      w.stopAnswer = {}
      await complete($)
      await w.clock.advance(4000)
      await stop($)
      await w.clock.advance(COUNTDOWN - 1)
      expect(w.commands).toEqual([])
      await w.clock.advance(1)
      expect(w.commands).toEqual(CLEARED)
    })

    // The stopping Stop lists nothing in flight, which would start the countdown were it read as passing.
    for (const order of ['before', 'after']) {
      test('a Stop answered with preventContinuation, ' + order + ' the turn completes, stops the session: the schedule is dropped and nothing runs', async ($, on) => {
        const w = world(on)
        await scheduled($, w)
        const answer = { preventContinuation: true, stopReason: 'budget hook: stop' }
        w.stopAnswer = answer
        if (order === 'after') await complete($)
        expect(await stop($)).toEqual(answer)
        if (order === 'before') await complete($)
        await w.clock.advance(10000)
        expect(w.commands).toEqual([])
        w.stopAnswer = {}
        expect(await call($)).toEqual({ result: SCHEDULED })
      })
    }

    const skips = [
      ['background work running', { background_tasks: [TASK], session_crons: [] }, 'background work is running: b1 (shell, sleep 120)'],
      ['a shell and a sub-agent running', { background_tasks: [TASK, AGENT_TASK], session_crons: [] },
        'background work is running: b1 (shell, sleep 120); a70c0ff43ab64663d (subagent, probe leaker E)'],
      ['a session cron', { background_tasks: [], session_crons: [CRON] }, 'a scheduled task would wake this conversation: c1 (*/5 * * * *)'],
      ['no background_tasks', { session_crons: [] }, 'background work is unknown'],
      ['no session_crons', { background_tasks: [] }, 'background work is unknown'],
      ['a background_tasks that is no list', { background_tasks: null, session_crons: [] }, 'background work is unknown'],
    ]
    for (const [label, fields, reason] of skips) {
      test('a Stop with ' + label + ' skips the clear and continues here from a timer, the band saying why', async ($, on) => {
        const w = world(on)
        await scheduled($, w)
        const ui = await mountBand($)
        await complete($)
        await stop($, fields)
        expect(w.commands).toEqual([])
        expect(await texts(ui)).toEqual(['drawn beneath', 'clear skipped: ' + reason + ' — continuing here · ' + BAND_TAIL])
        await w.clock.settle()
        expect(w.commands).toEqual([continueHere(reason)])
        await ui.unmount()
        await w.clock.advance(COUNTDOWN + 10000)
        expect(w.commands).toEqual([continueHere(reason)])
      })
    }

    test('no unblocked Stop within 5 s of the completion skips the clear and continues here', async ($, on) => {
      const w = world(on)
      await scheduled($, w)
      const ui = await mountBand($)
      w.stopAnswer = { block: 'keep going' }
      await complete($)
      await stop($)
      await w.clock.advance(4999)
      expect([w.commands, await texts(ui)]).toEqual([[], ['drawn beneath', BAND_TAIL]])
      await w.clock.advance(1)
      expect(w.commands).toEqual([continueHere('no Stop within 5 s, so background work is unknown')])
      expect(await texts(ui)).toEqual(['drawn beneath', 'clear skipped: no Stop within 5 s, so background work is unknown — continuing here · ' + BAND_TAIL])
      await ui.unmount()
      // The skip ended the schedule: the turn's later unblocked Stop starts nothing, and a new call is free to schedule.
      w.stopAnswer = {}
      await stop($)
      await w.clock.advance(COUNTDOWN + 10000)
      expect(w.commands).toEqual([continueHere('no Stop within 5 s, so background work is unknown')])
      expect(await call($)).toEqual({ result: SCHEDULED })
    })

    test('a turn that starts while the Stop is awaited drops the schedule, and nothing runs in its place', async ($, on) => {
      const w = world(on)
      await scheduled($, w)
      await complete($)
      await w.clock.advance(4999)
      await turn($)
      await w.clock.advance(COUNTDOWN + 10000)
      expect(w.commands).toEqual([])
    })

    for (const reason of ['aborted', 'refusal', 'error']) {
      test('a turn that completes ' + reason + ' drops the schedule and runs nothing', async ($, on) => {
        const w = world(on)
        await scheduled($, w)
        await stop($)
        await complete($, reason)
        await w.clock.advance(COUNTDOWN + 10000)
        expect(w.commands).toEqual([])
        expect(await call($)).toEqual({ result: SCHEDULED })
      })
    }

    test('a sub-agent\'s turn and Stop are not the main loop\'s: they neither drop, skip nor start the clear', async ($, on) => {
      const w = world(on)
      await scheduled($, w)
      await complete($, 'aborted', { agentId: 'agent-1' })
      await stop($, { background_tasks: [TASK], session_crons: [], agent_id: 'agent-1' })
      w.stopAnswer = { preventContinuation: true }
      await stop($, { ...EMPTY, agent_id: 'agent-1' })
      w.stopAnswer = {}
      await complete($, 'answer', { agentId: 'agent-1' })
      await w.clock.advance(10000)
      expect(w.commands).toEqual([])
      await complete($)
      await stop($)
      await w.clock.advance(COUNTDOWN)
      expect(w.commands).toEqual(CLEARED)
    })
  })

  describe(spelling + ' paths, the countdown', () => {
    test('the band counts down each second while, and only while, the countdown runs; a turn cancels it', async ($, on) => {
      const w = world(on)
      await scheduled($, w)
      const ui = await mountBand($)
      expect(await texts(ui)).toEqual(['drawn beneath', BAND_TAIL])
      let draws = w.bandDraws
      await w.clock.advance(2000)
      expect(w.bandDraws).toBe(draws)
      await stop($)
      await complete($)
      expect(await texts(ui)).toEqual(['drawn beneath', counted('2:00')])
      draws = w.bandDraws
      await w.clock.advance(1000)
      expect([await texts(ui), w.bandDraws]).toEqual([['drawn beneath', counted('1:59')], draws + 1])
      await w.clock.advance(20000)
      expect([await texts(ui), w.bandDraws]).toEqual([['drawn beneath', counted('1:39')], draws + 21])
      await turn($)
      expect(await texts(ui)).toEqual(['drawn beneath', BAND_TAIL])
      draws = w.bandDraws
      await w.clock.advance(5000)
      expect(w.bandDraws).toBe(draws)
      await w.clock.advance(COUNTDOWN)
      expect(w.commands).toEqual([])
      await ui.unmount()
    })

    test('a narrow band keeps the countdown first', async ($, on) => {
      const w = world(on)
      await counting($, w)
      const ui = await mountBand($, { ...BAND, bodyColumns: 30 })
      expect(await texts(ui)).toEqual(['drawn beneath', 'clearing in 2:00 · type anyth…'])
      await ui.unmount()
    })

    test('zero is at 120 000 ms, not 119 999: /clear, then /orchestrate continue <id> after-clear, in that order and from the timer', async ($, on) => {
      const w = world(on)
      await countingOffGrid($, w)
      const ui = await mountBand($)
      await w.clock.advance(COUNTDOWN - 1)
      expect([w.commands, await texts(ui)]).toEqual([[], ['drawn beneath', counted('0:01')]])
      await w.clock.advance(1)
      expect(w.commands).toEqual(CLEARED)
      expect(await texts(ui)).toEqual(['drawn beneath', BAND_TAIL])
      // No second-by-second redraw outlives the countdown.
      const draws = w.bandDraws
      await w.clock.advance(5000)
      expect(w.bandDraws).toBe(draws)
      await ui.unmount()
    })

    // Zero falls between two 30-second refreshes, so an agent list read there is zero's own.
    test('a turn that starts before zero cancels it: zero reads nothing and runs nothing in its place', async ($, on) => {
      const w = world(on)
      await scheduled($, w)
      await w.clock.advance(1000)
      await stop($)
      await complete($)
      await w.clock.advance(COUNTDOWN - 1)
      await turn($)
      const lists = w.lists
      await w.clock.advance(1)
      expect(w.lists).toBe(lists)
      await w.clock.advance(COUNTDOWN + 10000)
      expect(w.commands).toEqual([])
    })

    test('at zero a turn that opens while the agents are read again carries the conversation on: nothing clears, nothing runs', async ($, on) => {
      const w = world(on)
      await counting($, w)
      await w.clock.advance(COUNTDOWN - 1)
      let release
      w.agentGate = new Promise(resolve => { release = resolve })
      const lists = w.lists
      await w.clock.advance(1)
      expect(w.lists).toBeGreaterThan(lists)
      await turn($)
      w.agentGate = null
      release()
      await w.clock.advance(10000)
      expect(w.commands).toEqual([])
    })

    for (const [label, agents, reason] of [...['running', 'pending', 'suspended'].map(status => ['an agent ' + status,
      [...SETTLED_AGENTS, { id: 'agent-9', description: 'x', type: 'Explore', status }], 'an agent is in flight: agent-9 (Explore, "x", ' + status + ')']),
      ['an agent waiting on a command of its own', [...SETTLED_AGENTS, WAITING],
        'an agent is in flight: a0adf6f1a25021318 (general-purpose, "probe leaker C", waiting: returned its report; a command of its own still runs)'],
      ['two agents, both named', [...SETTLED_AGENTS, WAITING, { id: 'agent-9', description: 'x', type: 'Explore', status: 'running' }],
        'agents are in flight: a0adf6f1a25021318 (general-purpose, "probe leaker C", waiting: returned its report; a command of its own still runs); agent-9 (Explore, "x", running)'],
      ['three agents, each named', [...SETTLED_AGENTS, WAITING, { id: 'agent-9', description: 'x', type: 'Explore', status: 'running' }, { id: 'agent-10', description: 'y', type: 'Plan', status: 'pending' }],
        'agents are in flight: a0adf6f1a25021318 (general-purpose, "probe leaker C", waiting: returned its report; a command of its own still runs); agent-9 (Explore, "x", running); agent-10 (Plan, "y", pending)'],
      ['an agent list that cannot be read', 'deny', 'the agent list cannot be read']]) {
      test('at zero, ' + label + ': no clear, the run continues here', async ($, on) => {
        const w = world(on)
        await countingOffGrid($, w)
        // Wide enough for the longest reason whole.
        const ui = await mountBand($, { ...BAND, bodyColumns: 400 })
        w.agents = agents
        await w.clock.advance(COUNTDOWN)
        expect(w.commands).toEqual([continueHere(reason)])
        expect(await texts(ui)).toEqual(['drawn beneath', 'clear skipped: ' + reason + ' — continuing here · ' + BAND_TAIL])
        await ui.unmount()
      })
    }

    test('at zero, an agent whose description holds a line break and runs past 80 characters is named on one line, cut', async ($, on) => {
      const w = world(on)
      await countingOffGrid($, w)
      const ui = await mountBand($, { ...BAND, bodyColumns: 400 })
      w.agents = [...SETTLED_AGENTS, { id: 'agent-9', description: 'first' + String.fromCharCode(10) + 'x'.repeat(100), type: 'Explore', status: 'running' }]
      await w.clock.advance(COUNTDOWN)
      expect(w.commands).toEqual([continueHere('an agent is in flight: agent-9 (Explore, "first ' + 'x'.repeat(74) + '…", running)')])
      expect(await texts(ui)).toEqual(['drawn beneath', 'clear skipped: an agent is in flight: agent-9 (Explore, "first ' + 'x'.repeat(74) + '…", running) — continuing here · ' + BAND_TAIL])
      await ui.unmount()
    })

    test('a refused /clear continues the run here', async ($, on) => {
      const w = world(on, { deny: ['command.run clear'] })
      await countingOffGrid($, w)
      const ui = await mountBand($)
      await w.clock.advance(COUNTDOWN)
      expect(w.commands).toEqual([['clear', ''], continueHere('/clear was refused')])
      expect(await texts(ui)).toEqual(['drawn beneath', 'clear skipped: /clear was refused — continuing here · ' + BAND_TAIL])
      await ui.unmount()
    })

    test('a refused after-clear continue leaves the command to type in the band until the next turn', async ($, on) => {
      const w = world(on, { deny: ['command.run orchestrate'] })
      await countingOffGrid($, w)
      const ui = await mountBand($)
      await w.clock.advance(COUNTDOWN)
      expect(w.commands).toEqual(CLEARED)
      expect(await texts(ui)).toEqual(['drawn beneath', 'cleared — type /orchestrate continue ' + ID + ' after-clear · ' + BAND_TAIL])
      await turn($, 't-3', '/orchestrate continue ' + ID + ' after-clear')
      expect(await texts(ui)).toEqual(['drawn beneath', BAND_TAIL])
      await ui.unmount()
    })

    test('a skip notice stays through the mod\'s own continue turn, gives way to a countdown begun there, and goes at the next turn', async ($, on) => {
      const w = world(on)
      await scheduled($, w)
      const ui = await mountBand($)
      await stop($, { background_tasks: [TASK], session_crons: [] })
      await complete($)
      const notice = ['drawn beneath', 'clear skipped: background work is running: b1 (shell, sleep 120) — continuing here · ' + BAND_TAIL]
      expect(await texts(ui)).toEqual(notice)
      await w.clock.settle()
      await turn($, 't-2', '')
      // The engine draws the band again as a turn starts, and the call's fresh read draws it once more.
      await ui.redraw({ ...BAND, isWorking: true })
      expect(await texts(ui)).toEqual(notice)
      // The conductor's continue reaches a step-8 point at once: the countdown, the one warning of a clear, leads.
      expect(await call($)).toEqual({ result: SCHEDULED })
      expect(await texts(ui)).toEqual(notice)
      await stop($)
      await complete($, 'answer', { turnId: 't-2' })
      expect(await texts(ui)).toEqual(['drawn beneath', counted('2:00')])
      await turn($, 't-3', 'hello')
      expect(await texts(ui)).toEqual(['drawn beneath', BAND_TAIL])
      await ui.unmount()
    })

    test('a refused continue here names the command to type, and the notice goes at the next turn', async ($, on) => {
      const w = world(on, { deny: ['command.run orchestrate'] })
      await scheduled($, w)
      await stop($, { background_tasks: [TASK], session_crons: [] })
      await complete($)
      const ui = await mountBand($)
      await w.clock.settle()
      expect(w.commands).toEqual([continueHere('background work is running: b1 (shell, sleep 120)')])
      expect(await texts(ui)).toEqual(['drawn beneath', 'clear skipped: background work is running: b1 (shell, sleep 120) — type /orchestrate continue ' + ID + ' · ' + BAND_TAIL])
      await turn($, 't-2', '/orchestrate continue ' + ID)
      expect(await texts(ui)).toEqual(['drawn beneath', BAND_TAIL])
      await ui.unmount()
    })
  })

  describe(spelling + ' paths, the run across conversations', () => {
    test('each clear links the next conversation: the pane lists the clears and the run total over them', async ($, on) => {
      const w = world(on)
      await start($, w)
      await step($)
      let lines = await paneText($)
      expect(lines.some(line => /^(?:clears|run) /.test(line))).toBe(false)
      expect(await call($)).toEqual({ result: SCHEDULED })
      await stop($)
      await complete($)
      await w.clock.advance(COUNTDOWN)
      expect(w.session).toBe('s-2')
      lines = await paneText($)
      expect(lines.slice(-2)).toEqual(['clears ' + hhmm(T0 + COUNTDOWN) + ' at 412K', 'run $2.40 over 2 conversations'])
      // The pane draws them as the text does.
      const pane = await mountPane($)
      expect((await texts(pane)).slice(-2)).toEqual(['clears ' + hhmm(T0 + COUNTDOWN) + ' at 412K', 'run $2.40 over 2 conversations'])
      await pane.unmount()
      await step($)
      w.usage = { ...USAGE, context: { tokens: 388000, window: 1000000, percent: 39 } }
      expect(await call($)).toEqual({ result: SCHEDULED.replace('412K', '388K') })
      await stop($)
      await complete($)
      await w.clock.advance(COUNTDOWN)
      lines = await paneText($)
      expect(lines.slice(-2)).toEqual(['clears ' + hhmm(T0 + COUNTDOWN) + ' at 412K · ' + hhmm(T0 + 2 * COUNTDOWN) + ' at 388K', 'run $4.80 over 3 conversations'])
    })

    test('a clear from a conversation the run did not end in begins a run of its own', async ($, on) => {
      const w = world(on)
      await counting($, w)
      await w.clock.advance(COUNTDOWN)
      // The person's own /clear: the session moves on without the mod, and grows past the threshold.
      w.session = 's-9'
      w.usage = { ...FRESH, context: { tokens: 318000, window: 1000000, percent: 32 } }
      await step($)
      expect(await call($)).toEqual({ result: SCHEDULED.replace('412K', '318K') })
      await stop($)
      await complete($)
      await w.clock.advance(COUNTDOWN)
      expect((await paneText($)).slice(-2)).toEqual(['clears ' + hhmm(T0 + 2 * COUNTDOWN) + ' at 318K', 'run $2.40 over 2 conversations'])
    })

    // Refuses the clock from zero on: a plugin beside the one under test, since the mock clock holds the test's own
    // clock.now hook.
    const STOPPED = { name: 'stopped-clock', register(on) {
      on('clock.now', async ($, e, next) => {
        const now = await next(e)
        return now.value >= 1791460800000 + 120000 ? { deny: 'no clock here' } : now
      })
    } }
    test('a clear whose time cannot be read lists its time as ?', { plugins: [STOPPED] }, async ($, on) => {
      const w = world(on)
      await counting($, w)
      await w.clock.advance(COUNTDOWN)
      expect(w.commands).toEqual(CLEARED)
      expect((await paneText($)).slice(-2)).toEqual(['clears ? at 412K', 'run $0.00 over 2 conversations'])
    })

    test('a session id or a context that cannot be read is unknown in the pane, never zero', async ($, on) => {
      const w = world(on)
      await counting($, w)
      w.deny.add('session.id')
      w.deny.add('session.usage')
      await w.clock.advance(COUNTDOWN)
      expect(w.commands).toEqual(CLEARED)
      w.deny.clear()
      expect((await paneText($)).slice(-2)).toEqual(['clears ' + hhmm(T0 + COUNTDOWN) + ' at ?', 'run $0.00+? over 2 conversations'])
    })

    // Refuses the fresh conversation's id: a plugin beside the one under test, above the world's session.id hook.
    const NO_FRESH_ID = { name: 'no-fresh-id', register(on) {
      on('session.id', async ($, e, next) => {
        const id = await next(e)
        return id.value === 's-2' ? { deny: 'no id yet' } : id
      })
    } }
    test('a fresh conversation whose id cannot be read is unknown in the run, never the old one again', { plugins: [NO_FRESH_ID] }, async ($, on) => {
      const w = world(on)
      await start($, w)
      await step($)
      expect(await call($)).toEqual({ result: SCHEDULED })
      await stop($)
      await complete($)
      await w.clock.advance(COUNTDOWN)
      expect(w.commands).toEqual(CLEARED)
      expect((await paneText($)).slice(-2)).toEqual(['clears ' + hhmm(T0 + COUNTDOWN) + ' at 412K', 'run $2.40+? over 2 conversations'])
    })
  })
}

for (const spelling of SPELLINGS) suite(spelling)
