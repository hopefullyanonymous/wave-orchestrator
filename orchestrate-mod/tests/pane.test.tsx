// The /ledger pane, the band line and the text fallback through the Claude CLI's test kit (`claude plugin test
// orchestrate-mod`): the hooks of orchestrate-mod/hooks/register.js over stubs for every `$` call they make, each
// drawing mounted on the terminal and on the desktop. Named *.test.tsx: the kit runs it and Node's bare
// `node --test` passes it over.
import { describe, expect, mock, test } from 'claude-code/testing'

const MIN = 60000
const T0 = 1791460800000 // 2026-10-08T12:00:00.000Z
const HOME = '/home/u'
const ROOT = '/repo'
const SKILL = HOME + '/.claude/skills/orchestrate'
const DIR = HOME + '/.claude/orchestrate-costs'
const ID = 'OS-20261008-ledger-mod'
const SHA = '9f3c2e1' + '0'.repeat(33)
const SURFACES = ['terminal', 'desktop']
const PANE = { title: 'Ledger', isFocused: true, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} }
const BAND = { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 100, scroll: { offset: 0, bodyRows: 10 }, view: {} }
const PROMPT = '/home/u/scratch/prompts/' + ID + '-B03-implementer-0123456789ab.md'
const POINTER = 'Your complete instructions are in the file ' + PROMPT
  + ". Open it with the Read tool before doing anything else and follow it to its last line, which gives your report's exact line 2."
// The main loop's request prices at $2.40 and the implementer's at $0.294 (orchestrate-mod/hooks/prices.js,
// claude-opus-5-5): the session totals $2.69, against a /cost of $2.75.
const MAIN_USAGE = { input_tokens: 100000, output_tokens: 50000, cache_read_input_tokens: 1000000, cache_creation_input_tokens: 100000, model: 'claude-opus-5-5' }
const AGENT_USAGE = { input_tokens: 1000, output_tokens: 10000, cache_read_input_tokens: 200000, cache_creation_input_tokens: 10000, model: 'claude-opus-5-5' }
const USAGE = { startedAt: T0, context: { tokens: 412345, window: 1000000, percent: 41 }, rateLimits: [], cost: { usd: 2.75 } }
const WARNING = 'AMBIGUOUS (State differs: ACTIVE at chore/x, AT-CHECKPOINT C1 at feat/y)'

const sp = n => ' '.repeat(n)
// The engine resolves every `fs` path natively, so on Windows `/home/u/x` arrives as `C:\home\u\x`: respelled into
// the posix form the stubs compare against.
const posix = p => (/^[A-Za-z]:[\\/]/.test(p) ? p.slice(2).replace(/\\/g, '/') : p)
// The directory the kit loads the plugin from, the parent of this file's tests/, respelled as the stubs compare.
const PLUGIN = posix(decodeURIComponent(new URL('..', import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1')).replace(/\/$/, '')
// The data's time as the pane prints it, in the zone the hooks run in.
const asOf = ms => 'as of ' + new Date(ms - new Date(ms).getTimezoneOffset() * MIN).toISOString().slice(11, 19)
const total = (usd, unpriced = 0) => ({ requests: 1, in: 1, out: 1, cr: 1, cw: 1, usd, unpriced })
const discoveryLine = id => id + ' State=ACTIVE at chore/ledger-mod-ledger, /work/a b/.agents/changes/' + id + '/PROGRESS.md → continue'

function ledgerOf(overrides = {}) {
  return {
    id: ID, state: 'ACTIVE', integration: { branch: 'chore/ledger-mod-ledger', sha: SHA }, skillDir: '/s', waves: 2, currentWave: 2, nextCheckpoint: 'C1',
    rows: [
      { id: 'B01', title: 'cost log', branch: 'feat/mod-cost-log', wave: 1, weight: 'M', status: '✅', round: 'R1 SHIP', roundError: null, git: null },
      { id: 'B02', title: 'compaction', branch: 'feat/b', wave: 1, weight: 'S', status: '🟢', round: 'R1 SHIP', roundError: null, git: { row: '7', verdict: 'merged at fb69885' } },
      { id: 'B03', title: 'pane', branch: 'feat/c', wave: 2, weight: 'M', status: '🔄', round: 'R2 SHIP', roundError: null, git: { unknown: 'branch feat/c: not found' } },
    ],
    checkpoints: [{ id: 'C1', afterWave: '2', status: '⬜' }], error: null, warning: null, ...overrides,
  }
}
const viewOf = (ledgers, incomplete = false) => ({ exitCode: 0, stdout: JSON.stringify({ v: 1, repo: ROOT, incomplete, ledgers }) + '\n' })
const reportOf = (ledgerTotal, byBatch) => ({ exitCode: 0, stdout: JSON.stringify({ v: 1, dir: DIR, files: 1, records: 3, total: ledgerTotal,
  byLedger: { [ID]: { total: ledgerTotal, byBatch: Object.fromEntries(Object.entries(byBatch).map(([batch, t]) => [batch, { total: t, byRole: {} }])) } },
  byModel: {}, bySession: {} }) + '\n' })
const REPORT = reportOf(total(24.33), { B01: total(11.84), B03: total(9.47) })

// The rows of `ledgerOf()` priced by REPORT, as the pane draws them 100 cells wide: a settled row with no git
// column, then a row and its verdict, then a row whose git reading is unknown and its reason.
const ROWS = [
  'B01 ✅ W1 M  cost log' + sp(4) + 'R1 SHIP' + sp(16) + '$11.84',
  'B02 🟢 W1 S  compaction  R1 SHIP  git: row 7' + sp(5) + '$0.00',
  'dim:     merged at fb69885',
  'B03 🔄 W2 M  pane' + sp(8) + 'R2 SHIP  git: unknown' + sp(3) + '$9.47',
  'dim:     branch feat/c: not found',
]
const HEADER = ID + ' · ACTIVE · W2 of 2 · next C1'
const INTEGRATION = 'chore/ledger-mod-ledger @9f3c2e1'
const AGENTS = ['running  implementer  B03  12m  211K ctx  $0.29', sp(9) + 'Explore      ?     ?m     ? ctx      ?']
const CONDUCTOR = 'conductor  412K of 1M (41%) · safe point at 300K'
const COSTS = 'ledger $24.33 · session $2.69 · /cost $2.75 (-2.0%)'
const INCOMPLETE = 'discovery incomplete — some ledgers may be missing'

// Every `$` call the hooks make answered from memory: discovery tags `w.tag` (none when null), or prints
// `o.discovery`; the two tools answer `w.view` and `w.report` at their exact paths, a ledger view waiting on `w.gate`
// when one is set; `w.runs` holds every command line run, respelled, and `w.tools` each tool's argv and init. A call
// named in `w.deny` is refused.
function world(on, o = {}) {
  const deny = new Set(o.deny ?? [])
  const w = {
    clock: mock.clock(on, { now: T0 }),
    deny, gate: null, statuses: [], tools: [], bandDraws: 0,
    tag: 'tag' in o ? o.tag : ID,
    view: o.view ?? viewOf([ledgerOf()]),
    report: o.report ?? REPORT,
    agents: [{ id: 'agent-2', description: 'look around', type: 'Explore', status: 'running' }, { id: 'agent-1', description: 'implement B03', type: 'general-purpose', status: 'running' },
      { id: 'agent-0', description: 'done', type: 'Plan', status: 'completed' }],
    usage: o.usage ?? USAGE,
    surfaces: o.surfaces ?? ['terminal'],
    open: o.open ?? { value: { isPlaced: true } },
    runs: [], opens: [], closes: [], registered: [], toolsRegistered: [],
  }
  mock.env(on, { HOME })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.id', () => (deny.has('session.id') ? { deny: 'no session id here' } : { value: 's-1' }))
  on('session.root', () => (deny.has('session.root') ? { deny: 'no root here' } : { value: ROOT }))
  // `o.skill: false` installs no orchestrate skill anywhere.
  on('fs.exists', ($, e) => ({ value: o.skill !== false && posix(e.path) === SKILL }))
  on('fs.write', () => ({ value: undefined }))
  on('process.run', async ($, e) => {
    const argv = e.argv.map(posix), file = argv[1] ?? ''
    w.runs.push(argv)
    const answer = r => (r === 'deny' ? { deny: 'node cannot start' } : { value: { exitCode: r.exitCode, stdout: r.stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (file === SKILL + '/tools/reconcile.mjs') return answer(o.discovery ?? { exitCode: 0, stdout: w.tag === null ? 'NO LEDGERS\n' : discoveryLine(w.tag) + '\n' })
    const init = { ...e.init, ...(e.init && e.init.cwd ? { cwd: posix(e.init.cwd) } : {}) }
    if (file === PLUGIN + '/tools/ledger-view.mjs') {
      w.tools.push({ argv, init })
      if (w.gate) await w.gate
      return answer(w.view)
    }
    if (file === PLUGIN + '/tools/cost-report.mjs') {
      w.tools.push({ argv, init })
      return answer(w.report)
    }
    return { deny: 'no such tool here: ' + argv.join(' ') }
  })
  on('agent.list', () => (deny.has('agent.list') ? { deny: 'no list now' } : { value: w.agents }))
  on('session.usage', () => (deny.has('session.usage') ? { deny: 'no usage here' } : { value: w.usage }))
  on('session.surfaces', () => ({ value: w.surfaces }))
  on('command.register', ($, e) => { w.registered.push(e); return deny.has('command.register') ? { deny: 'no commands here' } : { value: { command: e.name } } })
  // The tool schedule_clear registers at session.start too (orchestrate-mod/hooks/register.js `register`), recorded apart.
  on('tool.register', ($, e) => { w.toolsRegistered.push(e.name); return { value: { tool: 'mcp__orchestrate-mod__' + e.name } } })
  on('ui.open', ($, e) => { w.opens.push(e); return w.open })
  on('ui.close', ($, e) => { w.closes.push(e.id); return { value: undefined } })
  on('ui.status', ($, e) => { w.statuses.push(e.text); return { value: undefined } })
  on('agent.spawn', () => ({ model: 'claude-opus-5-5', agentId: 'agent-1' }))
  on('turn.step', async function* ($, e) {
    return { turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [], stopReason: 'end_turn', usage: e.agentId ? (o.agentUsage ?? AGENT_USAGE) : (o.mainUsage ?? MAIN_USAGE) }
  })
  // What other hooks draw in the band and in another pane.
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => { w.bandDraws += 1; const { Text } = $.ui.resolve(e); return h(Text, {}, 'drawn beneath') })
  on('ui.render', { component: 'Pane' }, ($, e) => { const { Text } = $.ui.resolve(e); return h(Text, {}, 'another pane') })
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
// The implementer of B03 makes one request and the main loop one, at T0; twelve minutes pass.
async function busy($, w) {
  await start($, w)
  await $.agent.spawn({ tool_use_id: 'toolu_1', prompt: POINTER, description: 'implement B03', subagentType: 'general-purpose',
    provider: { plugin: 'engine', tier: 'core' }, parentModel: 'claude-opus-5-5', background: true, fork: false })
  await drain($.turn.step({ turnId: 'turn-1', index: 0, model: 'claude-opus-5-5', messageCount: 3, agentId: 'agent-1' }))
  await drain($.turn.step({ turnId: 'turn-2', index: 0, model: 'claude-opus-5-5', messageCount: 3 }))
  await w.clock.advance(12 * MIN)
}
const ledger = async $ => $.command.run({ command: 'ledger', args: '' })
const toolRuns = (w, tool) => w.runs.filter(argv => argv[1].endsWith('/tools/' + tool)).length
// Every Text of a drawing in order, a dim one led by `dim: `.
const texts = async ui => (await ui.findAll({ type: 'Text' })).map(t => (t.props.dimColor === true ? 'dim: ' : '') + t.text)
const mountPane = ($, surface) => $.ui.mount({ plugin: 'orchestrate-mod', surface, component: 'Pane', props: PANE, requestId: 'ledger' })
const mountBand = ($, surface, props = BAND) => $.ui.mount({ plugin: 'orchestrate-mod', surface, component: 'AbovePrompt', props })
// The pane's Texts from the integration line on: what a test changes in the rows, agents, conductor and costs.
const body = lines => lines.slice(lines.indexOf(INTEGRATION) + 1)

describe('the pane', () => {
  test('draws the approved layout on the terminal and the desktop: header, rows with their git lines, agents, conductor, costs', async ($, on) => {
    const w = world(on)
    await busy($, w)
    expect(await ledger($)).toEqual({})
    expect(w.opens).toEqual([{ id: 'ledger', title: 'Ledger', focus: true, closeOnEscape: true }])
    for (const surface of SURFACES) {
      const ui = await mountPane($, surface)
      expect(await texts(ui)).toEqual([HEADER, asOf(T0 + 12 * MIN), INTEGRATION, ' ', ...ROWS, ' ', ...AGENTS, CONDUCTOR, COSTS])
      expect((await ui.findAll({ type: 'Button' })).map(b => [b.key, b.props.label, b.props.hotkey, b.props.plain])).toEqual([['refresh', 'refresh', 'r', true], ['close', 'close', 'x', true]])
      expect((await ui.findAll({ type: 'Text' })).every(t => t.props.wrap === 'truncate-end')).toBe(true)
      expect((await ui.find({ type: 'Box' }))?.props.flexDirection).toBe('column')
      await ui.unmount()
    }
  })

  test('registers /ledger at session.start, to run at once mid-turn', async ($, on) => {
    const w = world(on)
    await start($, w)
    expect(w.registered).toEqual([{ name: 'ledger', description: 'Show the ledger pane: batches, agents, context and costs', immediate: true }])
  })

  test('the tools run from the plugin\'s own tools/, in the session root, 30 s each: the view with the user\'s skill, the costs for the ledger shown', async ($, on) => {
    const w = world(on)
    await start($, w)
    await ledger($)
    expect(w.tools).toEqual([
      { argv: ['node', PLUGIN + '/tools/ledger-view.mjs', '--repo', ROOT, '--skill-dir', SKILL], init: { cwd: ROOT, timeoutMs: 30000 } },
      { argv: ['node', PLUGIN + '/tools/cost-report.mjs', '--ledger', ID, '--format', 'json'], init: { cwd: ROOT, timeoutMs: 30000 } },
    ])
    expect(w.runs.filter(argv => !argv[1].endsWith('/reconcile.mjs'))).toEqual(w.tools.map(t => t.argv))
  })

  test('a refused /ledger registration leaves session.start whole and says so on the status line', async ($, on) => {
    const w = world(on, { deny: ['command.register'] })
    expect(await $.session.start({ cwd: ROOT, surface: null, isInteractive: true })).toEqual({ cwd: ROOT })
    expect(w.registered).toHaveLength(1)
    expect(w.statuses).toHaveLength(1)
    expect(w.statuses[0]).toStartWith('orchestrate-mod: /ledger not registered — ')
    expect(w.statuses[0]).toContain('no commands here')
  })

  test('the pane draws the data\'s own time, not the time it is drawn', async ($, on) => {
    const w = world(on, { tag: null })
    await busy($, w)
    expect(await ledger($)).toEqual({})
    await w.clock.advance(10000)
    const ui = await mountPane($, 'terminal')
    expect((await texts(ui))[1]).toBe(asOf(T0 + 12 * MIN))
    await ui.unmount()
  })

  test('the title gives way first, so a row keeps its git column and dollars; every line is cut to the body\'s width', async ($, on) => {
    const w = world(on)
    await busy($, w)
    const narrow = ($, surface, bodyColumns) => $.ui.mount({ plugin: 'orchestrate-mod', surface, component: 'Pane', props: { ...PANE, bodyColumns }, requestId: 'ledger' })
    for (const surface of SURFACES) {
      let ui = await narrow($, surface, 52)
      expect((await texts(ui)).filter(line => /^B0\d /.test(line))).toEqual([
        'B01 ✅ W1 M  cost log  R1 SHIP' + sp(16) + '$11.84', 'B02 🟢 W1 S  compact…  R1 SHIP  git: row 7' + sp(5) + '$0.00',
        'B03 🔄 W2 M  pane' + sp(6) + 'R2 SHIP  git: unknown' + sp(3) + '$9.47'])
      await ui.unmount()
      // 30 cells, each emoji two of them.
      ui = await narrow($, surface, 30)
      expect(await texts(ui)).toEqual([ID + ' · ACTI…', asOf(T0 + 12 * MIN), 'chore/ledger-mod-ledger @9f3c…', ' ',
        'B01 ✅ W1 M  cost log  R1 SHI…', 'B02 🟢 W1 S  compact…  R1 SHI…', 'dim:     merged at fb69885', 'B03 🔄 W2 M  pane      R2 SHI…',
        'dim:     branch feat/c: not found', ' ', 'running  implementer  B03  12…', sp(9) + 'Explore      ?     ?…', 'conductor  412K of 1M (41%) ·…',
        'ledger $24.33 · session $2.69…'])
      await ui.unmount()
    }
  })

  test('r reads the data again and the pane shows it; x closes the pane', async ($, on) => {
    const w = world(on)
    await busy($, w)
    for (const surface of SURFACES) {
      const ui = await mountPane($, surface)
      const [views, reports] = [toolRuns(w, 'ledger-view.mjs'), toolRuns(w, 'cost-report.mjs')]
      w.view = viewOf([ledgerOf({ state: 'AT-CHECKPOINT C1' })])
      await ui.press({ key: 'refresh' })
      expect([toolRuns(w, 'ledger-view.mjs'), toolRuns(w, 'cost-report.mjs')]).toEqual([views + 1, reports + 1])
      expect((await texts(ui))[0]).toBe(ID + ' · AT-CHECKPOINT C1 · W2 of 2 · next C1')
      w.view = viewOf([ledgerOf()])
      await ui.press({ key: 'close' })
      expect(w.closes.at(-1)).toBe('ledger')
      await ui.unmount()
    }
  })

  test('/ledger redraws an open pane with the data it read', async ($, on) => {
    const w = world(on, { tag: null })
    await start($, w)
    const ui = await mountPane($, 'terminal')
    expect((await texts(ui))[0]).toBe(HEADER)
    w.view = viewOf([ledgerOf({ state: 'AT-CHECKPOINT C1' })])
    expect(await ledger($)).toEqual({})
    expect((await texts(ui))[0]).toBe(ID + ' · AT-CHECKPOINT C1 · W2 of 2 · next C1')
    await ui.unmount()
  })

  test('another pane\'s drawing passes through untouched', async ($, on) => {
    const w = world(on)
    await start($, w)
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ plugin: 'orchestrate-mod', surface, component: 'Pane', props: PANE, requestId: 'notes' })
      expect(await texts(ui)).toEqual(['another pane'])
      await ui.unmount()
    }
  })
})

describe('unknown is never zero', () => {
  // A refusal from the engine, read through /ledger's text: each figure it would have given renders ? or a stated
  // reason, never 0.
  const textOf = async $ => (await ledger($)).text.split('\n')
  for (const [call, tail] of [
    ['agent.list', [' ', 'running  agents unknown — the agent list cannot be read', CONDUCTOR, COSTS]],
    ['session.id', [...AGENTS, CONDUCTOR, 'ledger $24.33 · session ? · /cost $2.75 (?)']],
    ['session.usage', [...AGENTS, 'conductor context unknown · safe point at 300K', 'ledger $24.33 · session $2.69 · /cost ? (?)']],
  ]) {
    test('a refused ' + call + ' renders as unknown', async ($, on) => {
      const w = world(on, { surfaces: [] })
      await busy($, w)
      w.deny.add(call)
      const lines = await textOf($)
      expect(lines.slice(0, 2)).toEqual([HEADER, asOf(T0 + 12 * MIN)])
      expect(lines.slice(-tail.length).map(line => (line === '' ? ' ' : line))).toEqual(tail)
    })
  }

  // Refuses the clock from the end of `busy` on, so the cost log's records are still made: a plugin beside the one
  // under test, since the mock clock holds the test's own clock.now hook.
  const STOPPED = { name: 'stopped-clock', register(on) {
    on('clock.now', async ($, e, next) => {
      const now = await next(e)
      return now.value >= 1791460800000 + 12 * 60000 ? { deny: 'no clock here' } : now
    })
  } }
  test('a refused clock.now: the data\'s time and a known agent\'s minutes are ?', { plugins: [STOPPED] }, async ($, on) => {
    const w = world(on, { surfaces: [] })
    await busy($, w)
    const lines = await textOf($)
    expect(lines.slice(0, 2)).toEqual([HEADER, 'as of ?'])
    expect(lines.slice(-4)).toEqual(['running  implementer  B03  ?m  211K ctx  $0.29', sp(9) + 'Explore      ?    ?m     ? ctx      ?', CONDUCTOR, COSTS])
  })

  test('no orchestrate skill installed: the view is unavailable and says why, the ledger figure ?', async ($, on) => {
    const w = world(on, { skill: false, surfaces: [] })
    await busy($, w)
    const lines = await textOf($)
    expect(lines[0]).toBe('ledger view unavailable — no orchestrate skill in <home>/.claude/skills or the project')
    expect(lines.at(-1)).toBe('ledger ? · session $2.69 · /cost $2.75 (-2.0%)')
    expect(w.tools).toEqual([])
  })

  test('a refused session.root: the view is unavailable and says why', async ($, on) => {
    const w = world(on, { surfaces: [] })
    await busy($, w)
    w.deny.add('session.root')
    const lines = await textOf($)
    expect(lines[0]).toStartWith('ledger view unavailable — ')
    expect(lines[0]).toContain('no root here')
  })

  test('an agent whose requests include an unpriced model: its total reads +?', async ($, on) => {
    const w = world(on, { surfaces: [], agentUsage: { ...AGENT_USAGE, model: 'claude-unpriced-9' } })
    await busy($, w)
    const lines = await textOf($)
    expect(lines.slice(-4)).toEqual(['running  implementer  B03  12m  211K ctx  $0.00+?', sp(9) + 'Explore      ?     ?m     ? ctx        ?',
      CONDUCTOR, 'ledger $24.33 · session $2.40+? · /cost $2.75 (?)'])
  })

  test('a failed view with no ledger tagged: the ledger figure is ?, never left out', async ($, on) => {
    const w = world(on, { tag: null, surfaces: [], view: { exitCode: 2, stdout: 'UNKNOWN discovery did not complete: exit 1\n' } })
    await busy($, w)
    const lines = await textOf($)
    expect(lines[0]).toBe('ledger view unavailable — discovery did not complete: exit 1')
    expect(lines.at(-1)).toBe('ledger ? · session $2.69 · /cost $2.75 (-2.0%)')
    expect(toolRuns(w, 'cost-report.mjs')).toBe(0)
  })

  test('no cost records: every ledger figure is $0.00', async ($, on) => {
    const w = world(on, { report: { exitCode: 0, stdout: 'NO RECORDS ' + DIR + '\n' } })
    await busy($, w)
    for (const surface of SURFACES) {
      const ui = await mountPane($, surface)
      const lines = body(await texts(ui))
      expect(lines.filter(line => /^B0\d /.test(line)).map(line => line.slice(-6))).toEqual([' $0.00', ' $0.00', ' $0.00'])
      expect(lines.at(-1)).toBe('ledger $0.00 · session $2.69 · /cost $2.75 (-2.0%)')
      await ui.unmount()
    }
  })

  for (const [label, report] of [['exits 2', { exitCode: 2, stdout: 'UNKNOWN ' + DIR + '/s-1.jsonl:3: not JSON\n' }],
    ['prints no JSON', { exitCode: 0, stdout: 'COSTS 3 records\n' }], ['cannot start', 'deny']]) {
    test('a cost report that ' + label + ' makes every ledger figure ?', async ($, on) => {
      const w = world(on, { report })
      await busy($, w)
      for (const surface of SURFACES) {
        const ui = await mountPane($, surface)
        const lines = body(await texts(ui))
        expect(lines.filter(line => /^B0\d /.test(line)).map(line => line.slice(-2))).toEqual([' ?', ' ?', ' ?'])
        expect(lines.at(-1)).toBe('ledger ? · session $2.69 · /cost $2.75 (-2.0%)')
        await ui.unmount()
      }
    })
  }

  test('an unpriced model: the totals that leave it out read +?, and the /cost delta ?', async ($, on) => {
    const w = world(on, { report: reportOf(total(24.33, 2), { B01: total(11.84), B03: total(9.47, 2) }), mainUsage: { ...MAIN_USAGE, model: 'claude-unpriced-9' } })
    await busy($, w)
    for (const surface of SURFACES) {
      const ui = await mountPane($, surface)
      const lines = body(await texts(ui))
      expect(lines.filter(line => /^B0\d /.test(line)).map(line => line.slice(line.lastIndexOf(' ') + 1))).toEqual(['$11.84', '$0.00', '$9.47+?'])
      expect(lines.at(-1)).toBe('ledger $24.33+? · session $0.29+? · /cost $2.75 (?)')
      await ui.unmount()
    }
  })

  test('no context reading yet (a fresh session, a compaction): conductor context unknown', async ($, on) => {
    const w = world(on, { usage: { startedAt: T0, context: { window: 1000000 }, rateLimits: [] } })
    await busy($, w)
    for (const surface of SURFACES) {
      const ui = await mountPane($, surface)
      expect((await texts(ui)).slice(-2)).toEqual(['conductor context unknown · safe point at 300K', 'ledger $24.33 · session $2.69 · /cost ? (?)'])
      await ui.unmount()
    }
  })

  for (const [label, view, why] of [['UNKNOWN', { exitCode: 2, stdout: 'UNKNOWN discovery did not complete: exit 1\n' }, 'discovery did not complete: exit 1'],
    ['exits 1', { exitCode: 1, stdout: '' }, 'exit 1'], ['cannot start', 'deny', 'orchestrate-mod: $.process.run: node cannot start'],
    ['prints another JSON', { exitCode: 0, stdout: '{"v":2}\n' }, 'its output is not a view: {"v":2}']]) {
    test('a ledger view that ' + label + ' says why in place of the rows, and still draws the agents, conductor and costs', async ($, on) => {
      const w = world(on, { view })
      await busy($, w)
      for (const surface of SURFACES) {
        const ui = await mountPane($, surface)
        expect(await texts(ui)).toEqual(['ledger view unavailable — ' + why, asOf(T0 + 12 * MIN), ' ', ...AGENTS, CONDUCTOR, COSTS])
        await ui.unmount()
      }
    })
  }

  test('a ledger entry with an error shows it in place of its rows', async ($, on) => {
    const error = 'UNKNOWN contract /repo/.agents/changes/' + ID + '/00-READBEFORE.md: ENOENT'
    const w = world(on, { view: viewOf([ledgerOf({ state: null, integration: null, waves: null, currentWave: null, nextCheckpoint: null, rows: [], error })]) })
    await busy($, w)
    for (const surface of SURFACES) {
      const ui = await mountPane($, surface)
      expect((await texts(ui)).slice(0, 6)).toEqual([ID + ' · ? · W? of ? · next ?', asOf(T0 + 12 * MIN), 'integration ?', ' ', error, ' '])
      await ui.unmount()
    }
  })
})

describe('discovery', () => {
  test('incomplete: the pane says some ledgers may be missing', async ($, on) => {
    const w = world(on, { view: viewOf([ledgerOf()], true) })
    await busy($, w)
    for (const surface of SURFACES) {
      const ui = await mountPane($, surface)
      expect((await texts(ui)).slice(0, 4)).toEqual([HEADER, asOf(T0 + 12 * MIN), INCOMPLETE, INTEGRATION])
      await ui.unmount()
    }
  })

  test('a ledger carrying a warning shows its rows and one dim discovery line under the integration line', async ($, on) => {
    const w = world(on, { view: viewOf([ledgerOf({ warning: WARNING })]) })
    await busy($, w)
    for (const surface of SURFACES) {
      const ui = await mountPane($, surface)
      expect(await texts(ui)).toEqual([HEADER, asOf(T0 + 12 * MIN), INTEGRATION, 'dim: discovery: ' + WARNING, ' ', ...ROWS, ' ', ...AGENTS, CONDUCTOR, COSTS])
      await ui.unmount()
    }
  })

  test('several ledgers: the tagged one is shown, with how many more there are', async ($, on) => {
    const other = ledgerOf({ id: 'OS-20261001-other', state: 'COMPLETE' })
    const w = world(on, { view: viewOf([other, ledgerOf()]) })
    await busy($, w)
    for (const surface of SURFACES) {
      const ui = await mountPane($, surface)
      expect((await texts(ui)).slice(0, 4)).toEqual([HEADER, asOf(T0 + 12 * MIN), 'and 1 more ledger', INTEGRATION])
      await ui.unmount()
    }
  })

  test('no ledger: the pane says so and still draws the conductor and the costs', async ($, on) => {
    const w = world(on, { tag: null, view: viewOf([]) })
    await busy($, w)
    for (const surface of SURFACES) {
      const ui = await mountPane($, surface)
      expect(await texts(ui)).toEqual(['no active ledger in ' + ROOT, asOf(T0 + 12 * MIN), ' ', ...AGENTS, CONDUCTOR, 'session $2.69 · /cost $2.75 (-2.0%)'])
      await ui.unmount()
    }
    expect(toolRuns(w, 'cost-report.mjs')).toBe(0)
  })
})

describe('/ledger as text', () => {
  const TEXT = [HEADER, asOf(T0 + 12 * MIN), INTEGRATION, '', ...ROWS.map(line => line.replace(/^dim: /, '')), '', ...AGENTS, CONDUCTOR, COSTS].join('\n')

  test('where nothing draws (a plain -p run) it answers the pane\'s lines as text and opens no pane', async ($, on) => {
    const w = world(on, { surfaces: [] })
    await busy($, w)
    expect(await ledger($)).toEqual({ text: TEXT })
    expect(w.opens).toEqual([])
  })

  test('untagged, the costs are asked for the ledger shown', async ($, on) => {
    const w = world(on, { tag: null, surfaces: [] })
    await busy($, w)
    expect(await ledger($)).toEqual({ text: TEXT })
    expect(w.tools.map(t => t.argv.slice(2))).toEqual([['--repo', ROOT, '--skill-dir', SKILL], ['--ledger', ID, '--format', 'json']])
  })

  test('tagged, but the view shows another ledger: the costs are asked for the one shown', async ($, on) => {
    const w = world(on, { surfaces: [], view: viewOf([ledgerOf({ id: 'OS-20261001-other' })]) })
    await start($, w)
    expect((await ledger($)).text.split('\n')[0]).toBe('OS-20261001-other · ACTIVE · W2 of 2 · next C1')
    expect(w.tools.map(t => t.argv.slice(2))).toEqual([['--repo', ROOT, '--skill-dir', SKILL], ['--ledger', 'OS-20261001-other', '--format', 'json']])
  })

  for (const [label, open] of [['opened but not placed', { value: { isPlaced: false, reason: 'the attached surfaces place no panes' } }], ['refused', { deny: 'not now' }]]) {
    test('a pane ' + label + ' answers the text', async ($, on) => {
      const w = world(on, { surfaces: ['desktop'], open })
      await busy($, w)
      expect(await ledger($)).toEqual({ text: TEXT })
      expect(w.opens).toHaveLength(1)
    })
  }
})

describe('the band', () => {
  test('while a ledger is tagged: what is drawn beneath, then the line', async ($, on) => {
    const w = world(on)
    await busy($, w)
    for (const surface of SURFACES) {
      const ui = await mountBand($, surface)
      expect(await texts(ui)).toEqual(['drawn beneath', 'OS-…-ledger-mod · W2 · B03 R2 implementer · ctx 412K/1M · $24.33 · /ledger'])
      expect((await ui.find({ type: 'Text', text: /\/ledger$/ }))?.props.wrap).toBe('truncate-end')
      expect((await ui.find({ type: 'Box' }))?.props.flexDirection).toBe('column')
      await ui.unmount()
    }
  })

  test('a segment whose data is unknown is left out', async ($, on) => {
    const w = world(on, { view: { exitCode: 2, stdout: 'UNKNOWN discovery did not complete: exit 1\n' }, report: 'deny', usage: { startedAt: T0, context: { window: 1000000 }, rateLimits: [] } })
    await busy($, w)
    for (const surface of SURFACES) {
      const ui = await mountBand($, surface)
      expect(await texts(ui)).toEqual(['drawn beneath', 'OS-…-ledger-mod · B03 implementer · /ledger'])
      await ui.unmount()
    }
  })

  // At a checkpoint discovery by a skill older than BL-054's fix prints the ledger AMBIGUOUS because its copies'
  // States differ, and still tags it.
  const differs = reason => ({ exitCode: 2, stdout: ID + ' at chore/ledger-mod-ledger, feat/mod-cost-log → AMBIGUOUS (' + reason + ')\n' })
  test('at a checkpoint, a State differs line tags the ledger and the band draws', async ($, on) => {
    const w = world(on, { discovery: differs('State differs: chore/ledger-mod-ledger=AT-CHECKPOINT C1, feat/mod-cost-log=ACTIVE'),
      view: viewOf([ledgerOf({ state: 'AT-CHECKPOINT C1', warning: 'AMBIGUOUS (State differs: chore/ledger-mod-ledger=AT-CHECKPOINT C1, feat/mod-cost-log=ACTIVE)' })]) })
    await busy($, w)
    for (const surface of SURFACES) {
      const ui = await mountBand($, surface)
      expect(await texts(ui)).toEqual(['drawn beneath', 'OS-…-ledger-mod · W2 · B03 R2 implementer · ctx 412K/1M · $24.33 · /ledger'])
      await ui.unmount()
    }
  })

  test('a tag that goes away while the band reads draws nothing of its own', async ($, on) => {
    const w = world(on, { tag: null, surfaces: [] })
    await start($, w)
    await ledger($)
    w.tag = ID
    await start($, w)
    let release
    w.gate = new Promise(resolve => { release = resolve })
    const mounting = mountBand($, 'terminal')
    await w.clock.settle()
    expect(toolRuns(w, 'ledger-view.mjs')).toBe(2)
    w.tag = null
    await start($, w)
    release()
    const band = await mounting
    expect(await texts(band)).toEqual(['drawn beneath'])
    await band.unmount()
  })

  test('a tag that goes away during the read that follows a joined one draws nothing of its own', async ($, on) => {
    const w = world(on, { tag: null })
    await start($, w)
    let release
    w.gate = new Promise(resolve => { release = resolve })
    const paneMounting = mountPane($, 'terminal')
    await w.clock.settle()
    w.tag = ID
    await start($, w)
    const bandMounting = mountBand($, 'terminal')
    await w.clock.settle()
    release()
    let releaseAgain
    w.gate = new Promise(resolve => { releaseAgain = resolve })
    w.tag = null
    await start($, w)
    releaseAgain()
    const band = await bandMounting, pane = await paneMounting
    expect(await texts(band)).toEqual(['drawn beneath'])
    await band.unmount()
    await pane.unmount()
  })

  test('idle ticks, untagged with the pane closed, raise no band render', async ($, on) => {
    const w = world(on, { tag: null })
    await start($, w)
    const ui = await mountBand($, 'terminal')
    const draws = w.bandDraws
    expect(draws).toBeGreaterThan(0)
    await w.clock.advance(5 * 30000)
    expect(w.bandDraws).toBe(draws)
    expect(toolRuns(w, 'ledger-view.mjs')).toBe(0)
    await ui.unmount()
  })

  test('a band drawn under a tag that is gone is taken down at the next tick', async ($, on) => {
    const w = world(on)
    await busy($, w)
    const drawn = []
    for (const surface of SURFACES) drawn.push(await mountBand($, surface))
    for (const ui of drawn) expect(await texts(ui)).toEqual(['drawn beneath', 'OS-…-ledger-mod · W2 · B03 R2 implementer · ctx 412K/1M · $24.33 · /ledger'])
    // Discovery finds no ledger at the next five-minute read; the tick after it redraws.
    w.tag = null
    await w.clock.advance(330000)
    for (const ui of drawn) {
      expect(await texts(ui)).toEqual(['drawn beneath'])
      await ui.unmount()
    }
  })

  test('data read under no tag is read again once a ledger is tagged', async ($, on) => {
    const w = world(on, { tag: null, surfaces: [] })
    await start($, w)
    await ledger($)
    w.tag = ID
    await start($, w)
    for (const surface of SURFACES) {
      const ui = await mountBand($, surface)
      expect(await texts(ui)).toEqual(['drawn beneath', 'OS-…-ledger-mod · W2 · ctx 412K/1M · $24.33 · /ledger'])
      await ui.unmount()
    }
    expect(toolRuns(w, 'ledger-view.mjs')).toBe(2)
  })

  // The read in flight is a pane's first draw, which asks no redraw when it lands, so only the band's own second
  // read can bring the current tag.
  test('a read joined in flight under an older tag is followed by one under the current tag', async ($, on) => {
    const w = world(on, { tag: null })
    await start($, w)
    let release
    w.gate = new Promise(resolve => { release = resolve })
    const paneMounting = mountPane($, 'terminal')
    await w.clock.settle()
    w.tag = ID
    await start($, w)
    const bandMounting = mountBand($, 'terminal')
    await w.clock.settle()
    expect(toolRuns(w, 'ledger-view.mjs')).toBe(1)
    release()
    const band = await bandMounting, pane = await paneMounting
    expect(await texts(band)).toEqual(['drawn beneath', 'OS-…-ledger-mod · W2 · ctx 412K/1M · $24.33 · /ledger'])
    expect(toolRuns(w, 'ledger-view.mjs')).toBe(2)
    expect((await texts(pane))[0]).toBe(HEADER)
    await band.unmount()
    await pane.unmount()
  })

  for (const [label, tag, hasSurvey, discovery] of [['no ledger tagged', null, false], ['a survey in the band', ID, true],
    ['another AMBIGUOUS reason', ID, false, differs('archived at local refs/heads/main; not proven older: feat/mod-cost-log=ACTIVE')]]) {
    test('with ' + label + ', only what is drawn beneath', async ($, on) => {
      const w = world(on, { tag, ...(discovery ? { discovery } : {}) })
      await busy($, w)
      for (const surface of SURFACES) {
        const ui = await mountBand($, surface, { ...BAND, hasSurvey })
        expect(await texts(ui)).toEqual(['drawn beneath'])
        await ui.unmount()
      }
    })
  }
})

describe('the 30-second refresh', () => {
  test('does nothing while the pane is closed and no ledger is tagged; reads while the pane is open, and stops when it closes', async ($, on) => {
    const w = world(on, { tag: null })
    await start($, w)
    await w.clock.advance(5 * 30000)
    expect(toolRuns(w, 'ledger-view.mjs')).toBe(0)
    await ledger($)
    expect(toolRuns(w, 'ledger-view.mjs')).toBe(1)
    await w.clock.advance(2 * 30000)
    expect(toolRuns(w, 'ledger-view.mjs')).toBe(3)
    const ui = await mountPane($, 'terminal')
    await ui.press({ key: 'close' })
    expect(w.closes).toEqual(['ledger'])
    await ui.unmount()
    await w.clock.advance(5 * 30000)
    expect(toolRuns(w, 'ledger-view.mjs')).toBe(3)
  })

  // A close the pane did not make itself (the person's Escape, another plugin's) reaches the ui.close hook.
  const CLOSER = { name: 'closer', register(on) {
    on('command.run', { command: 'close-ledger' }, async $ => { await $.ui.close({ id: 'ledger' }); return { text: 'closed' } })
    on('command.run', { command: 'close-notes' }, async $ => { await $.ui.close({ id: 'notes' }); return { text: 'closed notes' } })
  } }
  test('another pane\'s close leaves the ledger pane\'s share running', { plugins: [CLOSER] }, async ($, on) => {
    const w = world(on, { tag: null })
    await start($, w)
    await ledger($)
    expect(await $.command.run({ command: 'close-notes', args: '' })).toEqual({ text: 'closed notes' })
    expect(w.closes).toEqual(['notes'])
    await w.clock.advance(30000)
    expect(toolRuns(w, 'ledger-view.mjs')).toBe(2)
  })
  test('a close made elsewhere stops the pane\'s share too, and is passed on', { plugins: [CLOSER] }, async ($, on) => {
    const w = world(on, { tag: null })
    await start($, w)
    await ledger($)
    await w.clock.advance(30000)
    expect(toolRuns(w, 'ledger-view.mjs')).toBe(2)
    expect(await $.command.run({ command: 'close-ledger', args: '' })).toEqual({ text: 'closed' })
    expect(w.closes).toEqual(['ledger'])
    await w.clock.advance(3 * 30000)
    expect(toolRuns(w, 'ledger-view.mjs')).toBe(2)
  })

  test('a pane opened but not placed adds no refresh', async ($, on) => {
    const w = world(on, { tag: null, open: { value: { isPlaced: false, reason: 'the attached surfaces place no panes' } } })
    await start($, w)
    expect((await ledger($)).text.split('\n')[0]).toBe(HEADER)
    expect(toolRuns(w, 'ledger-view.mjs')).toBe(1)
    await w.clock.advance(2 * 30000)
    expect(toolRuns(w, 'ledger-view.mjs')).toBe(1)
  })

  test('a second session.start replaces the 30-second timer instead of adding one', async ($, on) => {
    const w = world(on)
    await start($, w)
    await w.clock.advance(10000)
    await start($, w)
    await w.clock.advance(29999)
    expect(toolRuns(w, 'ledger-view.mjs')).toBe(0)
    await w.clock.advance(1)
    expect(toolRuns(w, 'ledger-view.mjs')).toBe(1)
  })

  test('an open pane draws each tick\'s new data', async ($, on) => {
    const w = world(on, { tag: null })
    await start($, w)
    const ui = await mountPane($, 'terminal')
    expect((await texts(ui))[0]).toBe(HEADER)
    w.view = viewOf([ledgerOf({ state: 'AT-CHECKPOINT C1' })])
    await w.clock.advance(30000)
    expect((await texts(ui))[0]).toBe(ID + ' · AT-CHECKPOINT C1 · W2 of 2 · next C1')
    await ui.unmount()
  })

  test('reads asked for while one is in flight share it: one run', async ($, on) => {
    const w = world(on, { tag: null, surfaces: [] })
    await start($, w)
    let release
    w.gate = new Promise(resolve => { release = resolve })
    const first = ledger($), second = ledger($)
    await w.clock.settle()
    expect(toolRuns(w, 'ledger-view.mjs')).toBe(1)
    release()
    const [a, b] = await Promise.all([first, second])
    expect(a.text.split('\n')[0]).toBe(HEADER)
    expect(b).toEqual(a)
    expect(toolRuns(w, 'ledger-view.mjs')).toBe(1)
  })

  test('reads every 30 seconds while a ledger is tagged, the pane closed', async ($, on) => {
    const w = world(on)
    await start($, w)
    await w.clock.advance(29999)
    expect(toolRuns(w, 'ledger-view.mjs')).toBe(0)
    await w.clock.advance(1)
    expect(toolRuns(w, 'ledger-view.mjs')).toBe(1)
    await w.clock.advance(60000)
    expect(toolRuns(w, 'ledger-view.mjs')).toBe(3)
  })
})
