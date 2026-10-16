// The cost log through the Claude CLI's test kit (`claude plugin test orchestrate-mod`): the hooks of
// orchestrate-mod/hooks/register.js over stubs for every `$` call they make. Named *.test.tsx: the kit runs it
// and Node's bare `node --test` passes it over.
import { describe, expect, mock, test } from 'claude-code/testing'

const T0 = 1791460800000 // 2026-10-08T12:00:00.000Z
const HOME = '/home/u'
const ROOT = '/repo'
const DIR = HOME + '/.claude/orchestrate-costs'
const SKILL = HOME + '/.claude/skills/orchestrate'
const PROMPT = '/home/u/scratch/prompts/OS-20261008-ledger-mod-B01-implementer-ca0dbd21d4ac.md'
const POINTER = 'Your complete instructions are in the file ' + PROMPT
  + ". Open it with the Read tool before doing anything else and follow it to its last line, which gives your report's exact line 2."
const USAGE = { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 30, cache_creation_input_tokens: 40, model: 'claude-opus-5-5' }
const KEYS = ['v', 'ts', 'session', 'agent', 'parent', 'type', 'ledger', 'batch', 'role', 'model', 'in', 'out', 'cr', 'cw']
// The main-loop record of one default step, as a session's file holds it.
const mainLine = (session, ts = '12:00:00') => '{"v":1,"ts":"2026-10-08T' + ts + '.000Z","session":"' + session + '","agent":null,"parent":null,'
  + '"type":"main","ledger":"OS-20990101-session","batch":null,"role":"main","model":"claude-opus-5-5","in":10,"out":20,"cr":30,"cw":40}\n'
const bytesOf = text => new TextEncoder().encode(text).length
const discoveryLine = (id, mode) => id + ' State=ACTIVE at chore/x-ledger, /work/a b/.agents/changes/' + id + '/PROGRESS.md → ' + mode

// The engine resolves every `fs` path natively before a stub sees it, so on Windows `/home/u/x` arrives as
// `C:\home\u\x`. Each stub respells that one form, a path led by a drive letter, into the posix form the
// expectations are written in, and keeps every other path as received: on a posix host a `\` stays part of a
// file name. `win32` first hands the stub the Windows spelling, so the respelling runs on every platform.
const posix = p => (/^[A-Za-z]:[\\/]/.test(p) ? p.slice(2).replace(/\\/g, '/') : p)
const asWindows = p => p.replace(/^(?:[A-Za-z]:)?/, 'C:').replace(/\//g, '\\')
const SPELLINGS = ['native', 'win32']

// Every `$` call the hooks make answered from memory: the clock, the environment, the session, the file
// system (`disk`, path to text; `dirs`, paths that exist as directories; a write waits on `w.gate` when one is
// set), the discovery run, the agent list, the status line, and the bottoms of the four hooked events, each
// recording in `w.bottoms` the event it was handed.
function makeWorld(on, options = {}) {
  const seen = p => posix(options.spelling === 'win32' ? asWindows(p) : p)
  const w = {
    clock: mock.clock(on, { now: T0 }),
    session: 's-1',
    disk: new Map(Object.entries(options.disk ?? {})),
    dirs: new Set(options.dirs ?? [SKILL]),
    writes: [], runs: [], toolRuns: [], toolsRegistered: [], statuses: [], lists: 0, probes: [], reads: [], bottoms: [], inflight: 0, mostInflight: 0, gate: null,
    discovery: options.discovery ?? { exitCode: 0, stdout: discoveryLine('OS-20990101-session', 'continue') + '\n' },
    agents: options.agents ?? [],
    usage: 'usage' in options ? options.usage : USAGE,
  }
  if (options.env === 'deny') on('env.get', () => ({ deny: 'no environment here' }))
  else mock.env(on, options.env ?? { HOME })
  on('session.start', ($, e) => { w.bottoms.push(['session.start', e]); return { cwd: e.cwd } })
  on('session.end', ($, e) => { w.bottoms.push(['session.end', e]); return { sessionId: e.sessionId } })
  on('session.id', () => (options.denySessionId ? { deny: 'no session id here' } : { value: w.session }))
  on('session.root', () => ({ value: ROOT }))
  on('fs.exists', ($, e) => {
    const path = seen(e.path)
    w.probes.push(path)
    return { value: w.disk.has(path) || w.dirs.has(path) }
  })
  on('fs.read', ($, e) => {
    const path = seen(e.path)
    w.reads.push(path)
    return w.disk.has(path) && !options.denyRead ? { value: w.disk.get(path) } : { deny: 'cannot read ' + path }
  })
  on('fs.write', async ($, e) => {
    if (w.denyWrite) return { deny: 'disk full' }
    w.inflight += 1
    w.mostInflight = Math.max(w.mostInflight, w.inflight)
    if (w.gate) await w.gate
    w.inflight -= 1
    const path = seen(e.path)
    w.writes.push({ path, text: e.text })
    w.disk.set(path, e.text)
    return { value: undefined }
  })
  // The command line is no `fs` path; it is respelled only where a platform may have resolved it. The /ledger
  // refresh's two tools (orchestrate-mod/hooks/register.js `load`) are answered apart, in `w.toolRuns`, so `w.runs`
  // holds the discovery runs alone: no ledger, no cost records.
  on('process.run', ($, e) => {
    const tool = /\/tools\/(ledger-view|cost-report)\.mjs$/.exec(posix(e.argv[1] ?? ''))
    if (tool) {
      w.toolRuns.push(tool[1])
      const stdout = tool[1] === 'ledger-view' ? '{"v":1,"repo":"' + ROOT + '","incomplete":false,"ledgers":[]}\n' : 'NO RECORDS ' + DIR + '\n'
      return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    w.runs.push({ argv: e.argv.map(posix), init: { ...e.init, ...(e.init && e.init.cwd ? { cwd: posix(e.init.cwd) } : {}) } })
    if (w.discovery === 'deny') return { deny: 'node cannot start' }
    return { value: { exitCode: w.discovery.exitCode, stdout: w.discovery.stdout, stderr: '', isStdoutTruncated: Boolean(w.discovery.truncated), isStderrTruncated: false } }
  })
  on('agent.list', () => { w.lists += 1; return w.agents === 'deny' ? { deny: 'no list now' } : { value: w.agents } })
  // What /ledger registers and reads beside the cost log (orchestrate-mod/hooks/register.js `startLedger`, `load`).
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  // The tool schedule_clear registers at session.start (orchestrate-mod/hooks/register.js `register`), recorded apart.
  on('tool.register', ($, e) => { w.toolsRegistered.push(e.name); return { value: { tool: 'mcp__orchestrate-mod__' + e.name } } })
  on('session.usage', () => ({ value: { startedAt: T0, context: { window: 1000000 }, rateLimits: [] } }))
  on('ui.status', ($, e) => {
    w.statuses.push(e.text)
    if (options.statusThrows) throw new Error('no status line here')
    return { value: undefined }
  })
  on('agent.spawn', ($, e) => { w.bottoms.push(['agent.spawn', e]); return options.spawnResult ?? { model: 'claude-opus-5-5', agentId: 'agent-1' } })
  on('turn.step', async function* ($, e) {
    w.bottoms.push(['turn.step', e])
    return { turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [], stopReason: 'end_turn', usage: w.usage }
  })
  return w
}

async function start($, w) {
  await $.session.start({ cwd: ROOT, surface: null, isInteractive: false })
  await w.clock.settle()
}
function spawn($, prompt, extra = {}) {
  return $.agent.spawn({
    tool_use_id: 'toolu_1', prompt, description: 'implement B01', subagentType: 'general-purpose',
    provider: { plugin: 'engine', tier: 'core' }, parentModel: 'claude-opus-5-5', background: false, fork: false, ...extra,
  })
}
// Drains a model request's stream and returns its result.
async function drain(stream) {
  for (;;) {
    const item = await stream.next()
    if (item.done) return item.value
  }
}
const step = ($, agentId) => drain($.turn.step({ turnId: 'turn-1', index: 0, model: 'claude-opus-5-5', messageCount: 3, ...(agentId ? { agentId } : {}) }))
const linesOf = text => text.split('\n').filter(line => line !== '').map(line => JSON.parse(line))

// Every test runs once with the paths as this platform's engine hands them and once in Windows' spelling.
function suite(spelling) {
  const world = (on, options = {}) => makeWorld(on, { ...options, spelling })

  describe(spelling + ' paths, attribution', () => {
    test('a rendered role spawned with the pointer is recorded under the ledger, batch and role its prompt file names', async ($, on) => {
      const w = world(on)
      await start($, w)
      expect(await spawn($, POINTER)).toEqual({ model: 'claude-opus-5-5', agentId: 'agent-1' })
      await step($, 'agent-1')
      await w.clock.advance(9999)
      expect(w.writes).toHaveLength(0)
      await w.clock.advance(1)
      expect(w.writes.map(write => write.path)).toEqual([DIR + '/s-1.jsonl'])
      expect(w.writes[0].text).toBe('{"v":1,"ts":"2026-10-08T12:00:00.000Z","session":"s-1","agent":"agent-1","parent":null,'
        + '"type":"general-purpose","ledger":"OS-20261008-ledger-mod","batch":"B01","role":"implementer",'
        + '"model":"claude-opus-5-5","in":10,"out":20,"cr":30,"cw":40}\n')
      expect(Object.keys(linesOf(w.writes[0].text)[0])).toEqual(KEYS)
    })

    test('reviewer-round2 is never read as reviewer, and a lower-case, dotted change id is attributed like any other', async ($, on) => {
      const w = world(on)
      await start($, w)
      await spawn($, POINTER.replace(PROMPT, () => 'C:\\Users\\Jo Ann\\prompts\\os_2026.10-x-B12-reviewer-round2-0123456789ab.md'), { parentAgentId: 'agent-0' })
      await step($, 'agent-1')
      await w.clock.advance(10000)
      expect(linesOf(w.writes[0].text)[0]).toMatchObject({ agent: 'agent-1', parent: 'agent-0', ledger: 'os_2026.10-x', batch: 'B12', role: 'reviewer-round2' })
    })

    test('an agent spawned without a rendered prompt carries the session tag, its description\'s batch and its type as role', async ($, on) => {
      const w = world(on)
      await start($, w)
      await spawn($, 'Census the fence of OS-20261008-ledger-mod-B01-implementer-ca0dbd21d4ac.md', { subagentType: 'Explore', description: 'census for B03' })
      await step($, 'agent-1')
      await w.clock.advance(10000)
      expect(linesOf(w.writes[0].text)[0]).toMatchObject({ type: 'Explore', role: 'Explore', ledger: 'OS-20990101-session', batch: 'B03', parent: null })
    })

    test('a spawn answered without an agent id records nothing and passes its answer on unchanged', async ($, on) => {
      const w = world(on, { spawnResult: { deny: 'not now' } })
      await start($, w)
      expect(await spawn($, POINTER)).toEqual({ deny: 'not now' })
      await w.clock.advance(10000)
      expect(w.writes).toHaveLength(0)
    })

    test('an agent whose spawn this instance never saw is attributed once from the agent list', async ($, on) => {
      const w = world(on, { agents: [{ id: 'agent-9', description: 'review B07', type: 'Explore', status: 'running', parentId: 'agent-1' }] })
      await start($, w)
      await step($, 'agent-9')
      await step($, 'agent-9')
      await step($, 'agent-8')
      await step($, 'agent-8')
      await w.clock.advance(10000)
      const records = linesOf(w.writes[0].text)
      expect(records).toHaveLength(4)
      expect(records[3]).toEqual(records[2])
      expect(records[0]).toMatchObject({ agent: 'agent-9', type: 'Explore', role: 'Explore', batch: 'B07', parent: 'agent-1', ledger: 'OS-20990101-session' })
      expect(records[1]).toMatchObject({ agent: 'agent-9', type: 'Explore', role: 'Explore' })
      expect(records[2]).toMatchObject({ agent: 'agent-8', type: 'unknown', role: null, batch: null, parent: null })
      expect(w.lists).toBe(2)
    })

    test('an agent list that cannot be read leaves the agent unknown for that request and is asked again at the next', async ($, on) => {
      const w = world(on, { agents: 'deny' })
      await start($, w)
      await step($, 'agent-9')
      w.agents = [{ id: 'agent-9', description: 'B05', type: 'Plan', status: 'running' }]
      await step($, 'agent-9')
      await w.clock.advance(10000)
      expect(linesOf(w.writes[0].text).map(record => [record.type, record.role, record.batch])).toEqual([['unknown', null, null], ['Plan', 'Plan', 'B05']])
      expect(w.lists).toBe(2)
    })
  })

  describe(spelling + ' paths, the session tag', () => {
    test('a main-loop record carries agent null, type main, role main and the tag discovery prints, read when it exits 2', async ($, on) => {
      const w = world(on, { discovery: { exitCode: 2, stdout: discoveryLine('OS-20990101-a', 'continue') + '\nOS-20990101-b State=COMPLETE at main → none\n' } })
      await start($, w)
      await step($)
      await w.clock.advance(10000)
      expect(w.runs).toEqual([{ argv: ['node', SKILL + '/tools/reconcile.mjs', 'discovery', '--repo', ROOT], init: { cwd: ROOT, timeoutMs: 30000 } }])
      expect(linesOf(w.writes[0].text)).toEqual([{ v: 1, ts: '2026-10-08T12:00:00.000Z', session: 's-1', agent: null, parent: null, type: 'main',
        ledger: 'OS-20990101-a', batch: null, role: 'main', model: 'claude-opus-5-5', in: 10, out: 20, cr: 30, cw: 40 }])
    })

    test('a discovery run that cannot start leaves the session untagged', async ($, on) => {
      const w = world(on, { discovery: 'deny' })
      await start($, w)
      await step($)
      await w.clock.advance(10000)
      expect(w.runs).toHaveLength(1)
      expect(linesOf(w.writes[0].text)[0]).toMatchObject({ agent: null, ledger: null })
    })

    test('with no skill directory discovery never runs and the session is untagged', async ($, on) => {
      const w = world(on, { dirs: [] })
      await start($, w)
      await step($)
      await w.clock.advance(10000)
      expect(w.runs).toHaveLength(0)
      expect(linesOf(w.writes[0].text)[0]).toMatchObject({ ledger: null })
    })

    test('a second session.start in one instance replaces its timers instead of adding to them', async ($, on) => {
      const w = world(on)
      await start($, w)
      await start($, w)
      expect(w.runs).toHaveLength(2)
      await w.clock.advance(300000)
      expect(w.runs).toHaveLength(3)
    })

    test('with both installs of the skill, the user\'s runs discovery', async ($, on) => {
      const w = world(on, { dirs: [SKILL, ROOT + '/.claude/skills/orchestrate'] })
      await start($, w)
      expect(w.runs.map(run => run.argv[1])).toEqual([SKILL + '/tools/reconcile.mjs'])
    })

    test('a project install of the skill is used when only it exists', async ($, on) => {
      const w = world(on, { dirs: [ROOT + '/.claude/skills/orchestrate'] })
      await start($, w)
      expect(w.runs.map(run => run.argv[1])).toEqual([ROOT + '/.claude/skills/orchestrate/tools/reconcile.mjs'])
    })

    test('the tag is read again every five minutes; a doubtful, rejected or cut-short run untags the session', async ($, on) => {
      const w = world(on, { discovery: { exitCode: 0, stdout: 'NO LEDGERS\n' } })
      const later = discoveryLine('OS-20990101-later', 'close') + '\n'
      await start($, w)
      await step($)
      w.discovery = { exitCode: 0, stdout: later }
      await w.clock.advance(299999)
      expect(w.runs).toHaveLength(1)
      await w.clock.advance(1)
      expect(w.runs).toHaveLength(2)
      await step($)
      w.discovery = { exitCode: 2, stdout: 'INCOMPLETE 1 diagnostic(s): probe\n' + later }
      await w.clock.advance(300000)
      await step($)
      w.discovery = { exitCode: 0, stdout: later }
      await w.clock.advance(300000)
      await step($)
      w.discovery = 'deny'
      await w.clock.advance(300000)
      await step($)
      w.discovery = { exitCode: 0, stdout: later, truncated: true }
      await w.clock.advance(300000)
      await step($)
      await w.clock.advance(10000)
      expect(w.runs).toHaveLength(6)
      expect(linesOf(w.disk.get(DIR + '/s-1.jsonl')).map(record => record.ledger)).toEqual([null, 'OS-20990101-later', null, 'OS-20990101-later', null, null])
    })
  })

  describe(spelling + ' paths, recording never changes a request', () => {
    test('every hook hands the engine below the event it was given, and answers with what the engine answered', async ($, on) => {
      const w = world(on)
      expect(await $.session.start({ cwd: ROOT, surface: null, isInteractive: true })).toEqual({ cwd: ROOT })
      await w.clock.settle()
      const spawned = { tool_use_id: 'toolu_1', prompt: POINTER, description: 'implement B01', subagentType: 'general-purpose',
        provider: { plugin: 'engine', tier: 'core' }, model: 'claude-fable-5-1', parentModel: 'claude-opus-5-5', background: true, fork: false }
      expect(await $.agent.spawn(spawned)).toEqual({ model: 'claude-opus-5-5', agentId: 'agent-1' })
      const main = { turnId: 'turn-1', index: 0, model: 'claude-opus-5-5', effort: 'high', messageCount: 3 }
      const sub = { turnId: 'turn-2', index: 4, model: 'claude-fable-5-1', effort: 'max', messageCount: 9, agentId: 'agent-1' }
      await drain($.turn.step(main))
      await drain($.turn.step(sub))
      const ended = { reason: 'prompt_input_exit', sessionId: 's-1', resume: { id: 's-1' } }
      expect(await $.session.end(ended)).toEqual({ sessionId: 's-1' })
      expect(w.bottoms).toEqual([['session.start', { cwd: ROOT, surface: null, isInteractive: true }], ['agent.spawn', spawned],
        ['turn.step', main], ['turn.step', sub], ['session.end', ended]])
      expect(w.writes).toHaveLength(1)
    })

    test('a status line that cannot be shown never fails a step', async ($, on) => {
      const w = world(on, { denySessionId: true, statusThrows: true })
      await start($, w)
      expect(await step($)).toEqual({ turnId: 'turn-1', index: 0, answer: 'ok', toolUses: [], stopReason: 'end_turn', usage: USAGE })
      expect(w.statuses).toHaveLength(1)
    })

    test('an environment that cannot be read never fails session.start, and says so on the status line', async ($, on) => {
      const w = world(on, { env: 'deny' })
      expect(await $.session.start({ cwd: ROOT, surface: null, isInteractive: false })).toEqual({ cwd: ROOT })
      expect(w.bottoms.map(([name]) => name)).toEqual(['session.start'])
      expect(w.statuses).toHaveLength(1)
      expect(w.statuses[0]).toStartWith('orchestrate-mod: cost log error — ')
      expect(w.statuses[0]).toContain('no environment here')
    })

    test('a step whose usage is null writes nothing', async ($, on) => {
      const w = world(on, { usage: null })
      await start($, w)
      expect(await step($)).toEqual({ turnId: 'turn-1', index: 0, answer: 'ok', toolUses: [], stopReason: 'end_turn', usage: null })
      await w.clock.advance(10000)
      expect(w.writes).toHaveLength(0)
      expect(w.statuses).toEqual([])
    })

    test('a step whose recording throws returns its result unchanged and shows the error once', async ($, on) => {
      const w = world(on, { denySessionId: true })
      await start($, w)
      expect(await step($)).toEqual({ turnId: 'turn-1', index: 0, answer: 'ok', toolUses: [], stopReason: 'end_turn', usage: USAGE })
      await step($)
      await w.clock.advance(10000)
      expect(w.writes).toHaveLength(0)
      expect(w.statuses).toHaveLength(1)
      expect(w.statuses[0]).toStartWith('orchestrate-mod: cost log error — ')
    })

    test('a usage the record format refuses is an error, never a record', async ($, on) => {
      const w = world(on, { usage: { ...USAGE, input_tokens: -1 } })
      await start($, w)
      expect((await step($)).usage).toEqual({ ...USAGE, input_tokens: -1 })
      await w.clock.advance(10000)
      expect(w.writes).toHaveLength(0)
      expect(w.statuses).toEqual(['orchestrate-mod: cost log error — record not built: in is not a non-negative integer'])
    })

    test('a flush whose write rejects leaves the step\'s result unchanged and writes the records at the next flush', async ($, on) => {
      const w = world(on)
      w.denyWrite = true
      await start($, w)
      expect(await step($)).toEqual({ turnId: 'turn-1', index: 0, answer: 'ok', toolUses: [], stopReason: 'end_turn', usage: USAGE })
      await w.clock.advance(10000)
      expect(w.writes).toHaveLength(0)
      expect(w.statuses).toHaveLength(1)
      expect(w.statuses[0]).toStartWith('orchestrate-mod: cost log error — ')
      w.denyWrite = false
      await w.clock.advance(10000)
      expect(linesOf(w.writes[0].text)).toHaveLength(1)
    })
  })

  describe(spelling + ' paths, the files', () => {
    test('a reload continues the session\'s file instead of overwriting it', async ($, on) => {
      const earlier = '{"earlier":"record"}\n'
      const w = world(on, { disk: { [DIR + '/s-1.jsonl']: earlier } })
      await start($, w)
      await step($)
      await w.clock.advance(10000)
      expect(w.reads).toEqual([DIR + '/s-1.jsonl'])
      w.probes.length = 0
      await step($)
      await w.clock.advance(10000)
      expect([w.probes, w.reads]).toEqual([[], [DIR + '/s-1.jsonl']])
      expect(w.writes.map(write => write.path)).toEqual([DIR + '/s-1.jsonl', DIR + '/s-1.jsonl'])
      expect(w.writes[0].text).toStartWith(earlier)
      expect(w.writes[1].text).toStartWith(w.writes[0].text)
      expect(w.writes[1].text.split('\n')).toHaveLength(4)
    })

    test('a reload continues the session\'s LAST part, leaving the earlier ones as they are', async ($, on) => {
      const w = world(on, { disk: { [DIR + '/s-1.jsonl']: '{"part":0}\n', [DIR + '/s-1.1.jsonl']: '{"part":1}\n', [DIR + '/s-1.2.jsonl']: '{"part":2}\n' } })
      await start($, w)
      await step($)
      await w.clock.advance(10000)
      expect(w.writes.map(write => write.path)).toEqual([DIR + '/s-1.2.jsonl'])
      expect(w.writes[0].text).toStartWith('{"part":2}\n{"v":1,')
    })

    test('an empty part on disk takes the record as its first line, with nothing before it', async ($, on) => {
      const w = world(on, { disk: { [DIR + '/s-1.jsonl']: '' } })
      await start($, w)
      await step($)
      await w.clock.advance(10000)
      expect(w.writes).toEqual([{ path: DIR + '/s-1.jsonl', text: mainLine('s-1') }])
    })

    test('a part read without a final line break gets one before the next record, so no record is joined to it', async ($, on) => {
      const w = world(on, { disk: { [DIR + '/s-1.jsonl']: '{"cut":' } })
      await start($, w)
      await step($)
      await w.clock.advance(10000)
      const [first, second, rest] = w.writes[0].text.split('\n')
      expect([first, JSON.parse(second).ledger, rest]).toEqual(['{"cut":', 'OS-20990101-session', ''])
    })

    test('a part that cannot be read is never written', async ($, on) => {
      const w = world(on, { disk: { [DIR + '/s-1.jsonl']: '{}\n' }, denyRead: true })
      await start($, w)
      await step($)
      await w.clock.advance(10000)
      await step($)
      await w.clock.advance(10000)
      expect(w.writes).toHaveLength(0)
      expect(w.statuses).toEqual(['orchestrate-mod: cost log for s-1 unreadable — not written'])
    })

    test('a part at exactly 3 MiB takes the record; one byte more and it continues in <session>.1.jsonl', { timeoutMs: 20000 }, async ($, on) => {
      // Two sessions of one instance, each with a part already on disk: s-1's leaves exactly the record's room
      // below 3 MiB, s-3's one byte less. The parts are filled with a two-byte character, so their size in
      // UTF-8 bytes, not their length, decides.
      const line = mainLine
      const fill = size => 'x'.repeat((size - 1) % 2) + 'é'.repeat(Math.floor((size - 1) / 2)) + '\n'
      const limit = 3 * 1024 * 1024
      const w = world(on, { disk: { [DIR + '/s-1.jsonl']: fill(limit - line('s-1').length), [DIR + '/s-3.jsonl']: fill(limit - line('s-3').length + 1) } })
      expect([bytesOf(w.disk.get(DIR + '/s-1.jsonl')), w.disk.get(DIR + '/s-1.jsonl').length < limit / 2 + line('s-1').length]).toEqual([limit - line('s-1').length, true])
      await start($, w)
      await step($)
      w.session = 's-3'
      await step($)
      await w.clock.advance(10000)
      expect(w.writes.map(write => [write.path, bytesOf(write.text)])).toEqual([[DIR + '/s-1.jsonl', limit], [DIR + '/s-3.1.jsonl', line('s-3').length]])
      expect(w.writes[0].text).toEndWith(line('s-1'))
      expect(w.writes[1].text).toBe(line('s-3'))
      // The full part stays full: s-1's next record, a flush later, starts its next part.
      w.session = 's-1'
      await step($)
      await w.clock.advance(10000)
      expect(w.writes.slice(2).map(write => [write.path, write.text])).toEqual([[DIR + '/s-1.1.jsonl', line('s-1', '12:00:10')]])
    })

    test('session.end flushes the ending session by its id, and a /clear starts a new file', async ($, on) => {
      const w = world(on)
      await start($, w)
      await step($)
      w.session = 's-2'
      await step($)
      await $.session.end({ reason: 'clear', sessionId: 's-1', resume: { id: 's-1' } })
      expect(w.writes.map(write => write.path)).toEqual([DIR + '/s-1.jsonl'])
      expect(linesOf(w.writes[0].text).map(record => record.session)).toEqual(['s-1'])
      await w.clock.advance(10000)
      expect(w.writes.map(write => write.path)).toEqual([DIR + '/s-1.jsonl', DIR + '/s-2.jsonl'])
    })

    test('a session.end flush during a timer flush\'s write waits for it, so each record lands once', async ($, on) => {
      const w = world(on)
      let release
      await start($, w)
      await step($)
      w.gate = new Promise(resolve => { release = resolve })
      await w.clock.advance(10000)
      expect([w.inflight, w.writes]).toEqual([1, []])
      await step($)
      const ending = $.session.end({ reason: 'clear', sessionId: 's-1', resume: { id: 's-1' } })
      await w.clock.settle()
      expect(w.inflight).toBe(1)
      release()
      expect(await ending).toEqual({ sessionId: 's-1' })
      expect(w.mostInflight).toBe(1)
      expect(w.writes.map(write => linesOf(write.text).length)).toEqual([1, 2])
      expect(w.writes[1].text).toBe(mainLine('s-1') + mainLine('s-1', '12:00:10'))
    })

    test('a status line carries no control character: a run of them in a session id prints as one space', async ($, on) => {
      const w = world(on)
      // Every C0 control and DEL, one run.
      w.session = 'bad' + String.fromCharCode(...Array.from({ length: 32 }, (_, i) => i), 0x7f) + 'id'
      await start($, w)
      await step($)
      await w.clock.advance(10000)
      expect(w.writes).toHaveLength(0)
      expect(w.statuses).toEqual(['orchestrate-mod: cost log error — session id bad id names no cost file'])
    })

    test('a session id that is no plain file name writes nothing, outside the directory or anywhere', async ($, on) => {
      const w = world(on)
      w.session = '../escape'
      await start($, w)
      await step($)
      await w.clock.advance(20000)
      expect(w.writes).toHaveLength(0)
      expect(w.statuses).toEqual(['orchestrate-mod: cost log error — session id ../escape names no cost file'])
    })

    test('with no home directory nothing is written and the status line says so', async ($, on) => {
      const w = world(on, { env: {} })
      await start($, w)
      await step($)
      await w.clock.advance(10000)
      expect(w.writes).toHaveLength(0)
      expect(w.statuses).toEqual(['orchestrate-mod: no home directory — cost log not written'])
    })

    test('USERPROFILE stands in for an unset HOME', async ($, on) => {
      // A posix spelling: the engine resolves it natively, and the stubs respell what it hands them (`makeWorld`).
      const w = world(on, { env: { USERPROFILE: '/Users/Jo Ann/' }, dirs: [] })
      await start($, w)
      await step($)
      await w.clock.advance(10000)
      expect(w.writes.map(write => write.path)).toEqual(['/Users/Jo Ann/.claude/orchestrate-costs/s-1.jsonl'])
    })

    test('USERPROFILE stands in for a HOME set but empty', async ($, on) => {
      const w = world(on, { env: { HOME: '', USERPROFILE: '/Users/Jo Ann/' }, dirs: [] })
      await start($, w)
      await step($)
      await w.clock.advance(10000)
      expect(w.writes.map(write => write.path)).toEqual(['/Users/Jo Ann/.claude/orchestrate-costs/s-1.jsonl'])
    })
  })
}

for (const spelling of SPELLINGS) suite(spelling)
