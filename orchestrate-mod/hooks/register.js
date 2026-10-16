// The orchestrate-mod hooks module: every `$` call of the plugin lives here; the logic it applies is the pure
// helpers of orchestrate-mod/hooks/cost.js and orchestrate-mod/hooks/view.js.
//
// The cost log: one record per model request that returned usage (`turn.step`), for the main loop and every
// subagent, attributed from the agent's `agent.spawn` and the session's ledger tag, kept in memory and
// rewritten to `<home>/.claude/orchestrate-costs/<session>.jsonl` (then `.1.jsonl`, …) every 10 s and at
// `session.end`, since `$.fs.write` replaces a whole file. Recording never changes or fails a request.
//
// The /ledger pane, the band line above the prompt and the text fallback: one `data` object, read by `load` on
// /ledger, on the pane's refresh button and every 30 s while the pane is open or a ledger is tagged, and drawn by
// the pure helpers of orchestrate-mod/hooks/view.js.
//
// The clear and continue: the tool `schedule_clear` the conductor calls at its step-8 points; after the turn that
// called it ends with no work in flight, a two-minute countdown in the band that any turn cancels, then `/clear`
// and `/orchestrate continue <id> after-clear` from a timer. A clear skipped for anything but a turn that started, one
// interrupted, refused or failed, or a Stop that stops the session continues the run in place. The decisions are the
// pure helpers of orchestrate-mod/hooks/clear.js.
import {
  addRecord, attributeListed, attributeSpawn, buildRecord, costDir, fitting, joinPath, ledgerTag,
  mainAttribution, newTotals, partName, recordLine, utf8Length, validId,
} from './cost.js';
import {
  COUNTDOWN_MS, NO_STOP, STOP_WAIT_MS, TOOL_DESCRIPTION, TOOL_INPUT_SCHEMA, TOOL_NAME, afterClearArgs, afterClearNotice,
  agentsReason, continueArgs, countdownText, decide, linkClear, runTotal, scheduledLine, skipNotice, stopReason,
} from './clear.js';
import { PRICES } from './prices.js';
import { bandLine, conductorOf, paneLines, readCosts, readView, runningAgents, textReport } from './view.js';

// The running aggregates (orchestrate-mod/hooks/cost.js `newTotals`), with the session's ledger tag as `tag`.
const costs = newTotals();
// Attribution by agent id, from `agent.spawn` or, for an agent whose spawn this instance never saw, once from
// `$.agent.list()`.
const attributed = new Map();
// Per session id: whether its last part on disk was looked for, the part being written, its text on disk (null
// until read), its bytes, the record lines not yet written, whether writing stopped, and the chain that runs its
// flushes one at a time.
const files = new Map();
const timers = [];
let home = null, logDir = null, errorShown = false;

const FLUSH_MS = 10000, TAG_MS = 300000, DISCOVERY_TIMEOUT_MS = 30000;

// The pane's state: the last data read (null before the first), the read in flight (null when none), whether the
// pane is open, the 30-second timer, and the ledger tag its last tick saw.
let data = null, loading = null, paneOpen = false, ledgerTimer = null, tickTag = null;
const PANE = 'ledger', REFRESH_MS = 30000, TOOL_TIMEOUT_MS = 30000;
const message = error => String(error && error.message ? error.message : error);

// The clear (orchestrate-mod/hooks/clear.js). `schedule`: from a `scheduled` answer until its turn has ended, its
// ledger and SHA, whether the turn completed with `answer`, what its unblocked Stop found (`{ reason }`, null
// before one) and the timer awaiting that Stop. `countdown`: its ledger, the ms left and its two timers. `notice`:
// the band's notice of a skipped clear or a refused command; `ownTurn`: the next turn is the mod's own continue,
// which keeps it. `run`: the conversations the mod's clears linked (clear.js `linkClear`), null before the first.
let schedule = null, countdown = null, notice = null, ownTurn = false, run = null;
const GIT_TIMEOUT_MS = 30000;

export function register(on) {
  on('session.start', async ($, e, next) => {
    try { await start($); } catch (error) { showError($, error); }
    try { await startLedger($); } catch (error) { status($, `orchestrate-mod: /ledger not registered — ${message(error)}`); }
    try {
      await $.tool.register({ name: TOOL_NAME, description: TOOL_DESCRIPTION, inputSchema: TOOL_INPUT_SCHEMA });
    } catch (error) { status($, `orchestrate-mod: ${TOOL_NAME} not registered — ${message(error)}`); }
    return next(e);
  });
  on('agent.spawn', async ($, e, next) => {
    const result = await next(e);
    // A spawn answered without an agent id started no agent: nothing to attribute.
    try {
      if (result && result.agentId) attributed.set(result.agentId, attributeSpawn(e, costs.tag));
    } catch (error) { showError($, error); }
    return result;
  });
  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e);
    try { await recordStep($, e, result); } catch (error) { showError($, error); }
    return result;
  });
  // Flushes the ENDING session by its id: after a /clear the process goes on under a new one.
  on('session.end', async ($, e, next) => {
    try {
      if (files.has(e.sessionId)) await queueFlush($, e.sessionId);
    } catch (error) { showError($, error); }
    return next(e);
  });
  // /ledger: fresh data, then the pane; the same lines as text where nothing draws (a plain -p run) or the pane is
  // not placed. A placed pane answers `{}`, so the transcript gains nothing.
  on('command.run', { command: 'ledger' }, async ($, e) => {
    await refresh($, true);
    let surfaces = [];
    try { surfaces = await $.session.surfaces(); } catch { surfaces = []; }
    if (surfaces.length > 0 && await openPane($)) return {};
    return { text: textReport(drawn(data)) };
  });
  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId !== PANE) return next(e);
    paneOpen = true;
    if (data === null) await refresh($, false);
    const { Box, Text, Button } = $.ui.resolve(e);
    const lines = paneLines(drawn(data), e.props.bodyColumns).map(line => h(Text, line.dim ? { wrap: 'truncate-end', dimColor: true } : { wrap: 'truncate-end' }, line.text === '' ? ' ' : line.text));
    return h(Box, { flexDirection: 'column' }, ...lines, h(Box, { flexDirection: 'row', gap: 3 },
      h(Button, { key: 'refresh', label: 'refresh', hotkey: 'r', plain: true, onPress: () => refreshPressed($) }),
      h(Button, { key: 'close', label: 'close', hotkey: 'x', plain: true, onPress: () => closePane($) })));
  });
  // The band keeps what the hooks beneath draw there and adds the line under it, while the session's ledger tag
  // names a ledger and no survey holds the band. It draws only data read under that tag: a read joined in flight
  // under an older tag is followed by one more, and a tag that moved again meanwhile draws nothing of its own.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (costs.tag === null || e.props.hasSurvey) return next(e);
    if (data === null || data.tag !== costs.tag) await refresh($, false);
    if (data.tag !== costs.tag) await refresh($, false);
    if (costs.tag === null || data.tag !== costs.tag) return next(e);
    const { Box, Text } = $.ui.resolve(e);
    const beneath = await next(e);
    return h(Box, { flexDirection: 'column' }, ...(beneath ? [beneath] : []), h(Text, { wrap: 'truncate-end' }, bandLine(drawn(data), e.props.bodyColumns)));
  });
  // schedule_clear is listed in front, not behind ToolSearch, so the conductor calls it with no search.
  on('tool.describe', { tool: 'mcp__orchestrate-mod__schedule_clear' }, async ($, e, next) => ({ ...(await next(e)), isDeferred: false }));
  on('tool.call', { tool: 'mcp__orchestrate-mod__schedule_clear' }, async ($, e) => scheduleClear($, e));
  // Any turn that starts carries the conversation on: a schedule or a countdown is dropped and nothing runs in its
  // place. The notice stays through the mod's own continue and goes at the next turn.
  on('turn.start', async ($, e, next) => {
    let changed = dropClear();
    if (ownTurn) ownTurn = false;
    else if (notice !== null) {
      notice = null;
      changed = true;
    }
    if (changed) await redraw($);
    return next(e);
  });
  // A main-loop turn that answered waits on its Stop too (STOP_WAIT_MS at most); one interrupted, refused or failed
  // leaves the person at the keyboard, so the schedule is dropped and nothing runs.
  on('turn.complete', { reason: 'answer' }, async ($, e, next) => {
    const result = await next(e);
    if (e.agentId === undefined && schedule !== null) turnAnswered($);
    return result;
  });
  on('turn.complete', { reason: ['aborted', 'refusal', 'error'] }, async ($, e, next) => {
    const result = await next(e);
    if (e.agentId === undefined) dropClear();
    return result;
  });
  // A main-loop Stop answered with `preventContinuation` stops the session: as after an interrupted turn, the schedule
  // is dropped and nothing runs. One answered with `block` keeps the model going: the schedule waits for the next Stop.
  on('classic.Stop', async ($, e, next) => {
    const result = await next(e);
    if (e.agent_id !== undefined) return result;
    if (result?.preventContinuation !== undefined) dropClear();
    else if (schedule !== null && result?.block === undefined) {
      schedule.stop = { reason: stopReason(e) };
      if (schedule.complete) turnOver($);
    }
    return result;
  });
  // Observes only: answering a close would keep the pane open.
  on('ui.close', async ($, e, next) => {
    if (e.id === PANE) paneOpen = false;
    return next(e);
  });
}

// Starts the 30-second refresh, replacing an earlier session's, and registers /ledger.
async function startLedger($) {
  if (ledgerTimer !== null) ledgerTimer.cancel();
  ledgerTimer = $.clock.every(REFRESH_MS, () => { tick($); });
  await $.command.register({ name: 'ledger', description: 'Show the ledger pane: batches, agents, context and costs', immediate: true });
}

// A tick refreshes only while the pane is open or a ledger is tagged; a tag that changed since the last tick asks
// for a redraw either way, so a band drawn under a tag that is gone is taken down.
function tick($) {
  const changed = costs.tag !== tickTag;
  tickTag = costs.tag;
  if (paneOpen || costs.tag !== null) refresh($, true).catch(() => { /* the next tick reads again */ });
  else if (changed) redraw($);
}

async function redraw($) {
  try { await $.ui.invalidate('ui.render'); } catch { /* the next draw shows the data */ }
}

// Reads the data once for every caller that asks while a read is in flight, then asks the pane and the band to
// draw again unless a render hook is the caller.
async function refresh($, ask) {
  if (loading === null) loading = load($).then(fresh => { data = fresh; }).finally(() => { loading = null; });
  await loading;
  if (ask) await redraw($);
}

async function refreshPressed($) {
  try { await refresh($, true); } catch { /* the pane keeps its data and its time */ }
}

// The pane's own close stops the pane's share of the timer here: this plugin's `ui.close` hook observes the
// other closes (the person's Escape or close mark, another plugin's).
async function closePane($) {
  try {
    await $.ui.close({ id: PANE });
    paneOpen = false;
  } catch { /* a refused close leaves the pane open */ }
}

// Opens the pane; true when it is placed. A pane opened but not placed, or a refused open, is not shown.
async function openPane($) {
  let opened;
  try { opened = await $.ui.open({ id: PANE, title: 'Ledger', focus: true, closeOnEscape: true }); } catch { return false; }
  if (!opened || opened.isPlaced !== true) return false;
  paneOpen = true;
  return true;
}

// One reading of everything the pane, the band and the text draw (orchestrate-mod/hooks/view.js); every part that
// cannot be read is recorded as unknown, so a read never rejects.
async function load($) {
  let at = null;
  try { at = await $.clock.now(); } catch { at = null; }
  const out = { at, tzOffset: at === null ? null : new Date(at).getTimezoneOffset(), root: null, tag: costs.tag, view: null, costs: null, agents: null, conductor: null, session: null, slashCost: null };
  try {
    out.root = await $.session.root();
    const skill = await skillDir($, out.root);
    out.view = skill === null ? { error: 'no orchestrate skill in <home>/.claude/skills or the project' }
      : readView(await runTool($, out.root, 'ledger-view.mjs', ['--repo', out.root, '--skill-dir', skill]), out.tag);
  } catch (error) { out.view = { error: message(error) }; }
  const id = out.view.ledger ? out.view.ledger.id : out.tag;
  if (id) out.costs = readCosts(await runTool($, out.root, 'cost-report.mjs', ['--ledger', id, '--format', 'json']), id);
  else if (typeof out.view.error === 'string') out.costs = { ledger: null, error: 'no ledger to total' };
  try { out.agents = runningAgents(await $.agent.list(), costs.agents); } catch { out.agents = null; }
  try {
    const usage = await $.session.usage();
    out.conductor = conductorOf(usage.context);
    out.slashCost = usage.cost && typeof usage.cost.usd === 'number' && Number.isFinite(usage.cost.usd) ? usage.cost.usd : null;
  } catch { out.conductor = null; }
  try {
    const own = costs.sessions.get(await $.session.id());
    out.session = own ? { usd: own.usd, unpriced: own.unpriced } : { usd: 0, unpriced: 0 };
  } catch { out.session = null; }
  return out;
}

// One run of a tool of this plugin from the session's root: its answer, or `{ error }` when it was refused.
async function runTool($, root, file, args) {
  try {
    return await $.process.run(['node', joinPath($.plugin.root, 'tools', file), ...args], root === null ? { timeoutMs: TOOL_TIMEOUT_MS } : { cwd: root, timeoutMs: TOOL_TIMEOUT_MS });
  } catch (error) { return { error: message(error) }; }
}

// ===== The clear ========================================================================

// The data drawn: `data` with the clear's band segment while a countdown runs or a notice stands, and, once a clear
// ran, the run's clears and its total (orchestrate-mod/hooks/view.js); with neither, `data` itself.
function drawn(data) {
  const band = countdown !== null ? countdownText(countdown.left) : notice;
  if (band === null && run === null) return data;
  return { ...data, ...(band === null ? {} : { clearBand: band }), ...(run === null ? {} : { clears: run.clears, runTotal: runTotal(run.ids, costs.sessions) }) };
}

// Answers a schedule_clear call: `declined: <reason>` for the first reason orchestrate-mod/hooks/clear.js `decide`
// finds, each fact gathered only once the reasons before it pass; else the schedule, and `scheduled: <line>`.
async function scheduleClear($, e) {
  const facts = { agentId: e.agentId, ledger: e.ledger, ledgerValid: validId(e.ledger), sha: e.sha, busy: schedule !== null || countdown !== null };
  let verdict = decide(facts);
  while (verdict.need !== undefined) {
    facts[verdict.need] = await gather($, verdict, facts);
    verdict = decide(facts);
  }
  if (verdict.declined !== undefined) return { result: `declined: ${verdict.declined}` };
  let tokens = null;
  try { tokens = conductorOf((await $.session.usage()).context).tokens; } catch { tokens = null; }
  schedule = { ledger: e.ledger, sha: e.sha, complete: false, stop: null, wait: null };
  return { result: `scheduled: ${scheduledLine(tokens, e.ledger)}` };
}

// One fact `decide` asked for; a read, a run or a list that fails is the fact's `{ error }`, never its absence.
async function gather($, need, facts) {
  if (need.need === 'read') {
    // A read in flight may have begun before the conductor's last commit: the facts come from one begun after it.
    if (loading !== null) await loading;
    await refresh($, true);
    return { tag: costs.tag, view: data.view, root: data.root };
  }
  try {
    if (need.need === 'protocol') return { text: await $.fs.read(joinPath(facts.read.view.ledger.skillDir, 'references', 'protocol.md')) };
    if (need.need === 'worktrees') {
      return await $.process.run(['git', '--no-optional-locks', 'worktree', 'list', '--porcelain'], { cwd: facts.read.root, timeoutMs: GIT_TIMEOUT_MS });
    }
    if (need.need === 'status') {
      return await $.process.run(['git', '--no-optional-locks', 'status', '--porcelain', '--', `.agents/changes/${facts.ledger}/`],
        { cwd: need.cwd, timeoutMs: GIT_TIMEOUT_MS });
    }
    return await $.agent.list();
  } catch (error) { return { error: message(error) }; }
}

// Drops a schedule and a countdown with their timers; true when there was either.
function dropClear() {
  const had = schedule !== null || countdown !== null;
  if (schedule !== null && schedule.wait !== null) schedule.wait.cancel();
  if (countdown !== null) {
    countdown.ticker.cancel();
    countdown.timer.cancel();
  }
  schedule = null;
  countdown = null;
  return had;
}

// The main loop's turn answered with a schedule pending: its unblocked Stop ends the turn, or STOP_WAIT_MS passes.
function turnAnswered($) {
  schedule.complete = true;
  if (schedule.stop !== null) turnOver($);
  else {
    const s = schedule;
    s.wait = $.clock.after(STOP_WAIT_MS, () => { stopMissed($, s); });
  }
}

// No unblocked Stop came within STOP_WAIT_MS of the completion: work in flight is unknown, so the clear is skipped.
function stopMissed($, s) {
  schedule = null;
  skip($, s.ledger, NO_STOP);
}

// Both ends of the turn are in: a Stop that found nothing in flight starts the countdown, any other skips the clear.
function turnOver($) {
  const s = schedule;
  schedule = null;
  if (s.wait !== null) s.wait.cancel();
  if (s.stop.reason === null) startCountdown($, s.ledger);
  else skip($, s.ledger, s.stop.reason);
}

// Skips the clear and continues the run here: the notice, kept through that continue's turn, then
// `/orchestrate continue <id>` from a timer, since a hook the turn waits on cannot run a command.
function skip($, id, reason) {
  notice = skipNotice(reason, id, true);
  ownTurn = true;
  redraw($);
  $.clock.after(0, () => { continueHere($, id, reason); });
}

async function continueHere($, id, reason) {
  try { await $.command.run({ command: 'orchestrate', args: continueArgs(id) }); } catch {
    notice = skipNotice(reason, id, false);
    ownTurn = false;
    await redraw($);
  }
}

// The countdown: the band redrawn each second while it runs, and zero at COUNTDOWN_MS.
function startCountdown($, id) {
  const c = { ledger: id, left: COUNTDOWN_MS, ticker: null, timer: null };
  countdown = c;
  c.ticker = $.clock.every(1000, () => {
    c.left = Math.max(0, c.left - 1000);
    redraw($);
  });
  c.timer = $.clock.after(COUNTDOWN_MS, () => { fireClear($, c); });
  redraw($);
}

// Zero, from the countdown's timer: the agent list read again, then `/clear` and the fresh conversation's
// `/orchestrate continue <id> after-clear`. Every turn that starts drops the countdown (the `turn.start` hook), so
// one still current after the reads means no main-loop turn opened since the scheduled one ended; a turn that
// opened meanwhile carries the conversation on, and nothing runs.
async function fireClear($, c) {
  c.ticker.cancel();
  let agents, tokens = null, before = null, at = null;
  try { agents = await $.agent.list(); } catch (error) { agents = { error: message(error) }; }
  try { tokens = conductorOf((await $.session.usage()).context).tokens; } catch { tokens = null; }
  try { before = await $.session.id(); } catch { before = null; }
  try { at = await $.clock.now(); } catch { at = null; }
  if (countdown !== c) return;
  countdown = null;
  const busy = agentsReason(agents);
  if (busy !== null) {
    skip($, c.ledger, busy);
    return;
  }
  try { await $.command.run({ command: 'clear', args: '' }); } catch {
    skip($, c.ledger, '/clear was refused');
    return;
  }
  let after = null;
  try { after = await $.session.id(); } catch { after = null; }
  run = linkClear(run, { ledger: c.ledger, before, after, at, tzOffset: at === null ? null : new Date(at).getTimezoneOffset(), tokens });
  try { await $.command.run({ command: 'orchestrate', args: afterClearArgs(c.ledger) }); } catch { notice = afterClearNotice(c.ledger); }
  await redraw($);
}

// Resolves the home directory, starts the flush and tag timers, and starts the first discovery without
// waiting for it: discovery may take seconds and the session does not wait on the cost log.
async function start($) {
  for (const timer of timers.splice(0)) timer.cancel();
  home = (await $.env.get('HOME')) || (await $.env.get('USERPROFILE')) || null;
  logDir = home === null ? null : costDir(home);
  if (home === null) status($, 'orchestrate-mod: no home directory — cost log not written');
  timers.push($.clock.every(FLUSH_MS, () => { flushAll($); }));
  timers.push($.clock.every(TAG_MS, () => { refreshTag($); }));
  refreshTag($);
}

// Sets the session's ledger tag from `reconcile.mjs discovery` run by the installed skill: the user's
// (`<home>/.claude/skills/orchestrate`), else the project's when only that exists. Any failure leaves it null.
async function refreshTag($) {
  let tag = null;
  try {
    const root = await $.session.root();
    const skill = await skillDir($, root);
    if (skill !== null) {
      const run = await $.process.run(['node', joinPath(skill, 'tools', 'reconcile.mjs'), 'discovery', '--repo', root],
        { cwd: root, timeoutMs: DISCOVERY_TIMEOUT_MS });
      if (!run.isStdoutTruncated) tag = ledgerTag(run.stdout);
    }
  } catch { tag = null; }
  costs.tag = tag;
}

async function skillDir($, root) {
  if (home !== null) {
    const own = joinPath(home, '.claude', 'skills', 'orchestrate');
    if (await $.fs.exists(own)) return own;
  }
  const project = joinPath(root, '.claude', 'skills', 'orchestrate');
  return (await $.fs.exists(project)) ? project : null;
}

// One record for a step whose response carried usage; none for `usage: null`.
async function recordStep($, e, result) {
  const usage = result ? result.usage : null;
  if (!usage) return;
  const session = await $.session.id();
  const now = await $.clock.now();
  const agent = e.agentId ?? null;
  const attribution = agent === null ? mainAttribution(costs.tag) : await attributionOf($, agent);
  const record = buildRecord({ now, session, agent, attribution, usage });
  addRecord(costs, record, PRICES);
  fileOf(session).pending.push(recordLine(record));
}

// A list that cannot be read leaves the agent unknown for this record and is asked again at the next one.
async function attributionOf($, agentId) {
  if (attributed.has(agentId)) return attributed.get(agentId);
  let agents;
  try { agents = await $.agent.list(); } catch { return attributeListed(undefined, costs.tag); }
  const found = attributeListed(agents.find(agent => agent.id === agentId), costs.tag);
  attributed.set(agentId, found);
  return found;
}

function fileOf(session) {
  if (!files.has(session)) files.set(session, { found: false, part: 0, text: null, bytes: 0, pending: [], stopped: false, chain: Promise.resolve() });
  return files.get(session);
}

function flushAll($) {
  for (const [session, file] of files) if (file.pending.length) queueFlush($, session);
}

function queueFlush($, session) {
  const file = fileOf(session);
  file.chain = file.chain.then(() => flush($, session)).catch(error => showError($, error));
  return file.chain;
}

// Writes a session's pending lines after what its current part holds. The first flush of a session in this
// instance starts at its last part on disk, and a part never written by this instance is read first, so a reload
// appends instead of overwriting; a part that exists and cannot be read stops writing for that session. A write
// that fails keeps its lines pending for the next flush.
async function flush($, session) {
  const file = fileOf(session);
  if (logDir === null || file.stopped || !file.pending.length) return;
  if (partName(session, 0) === null) {
    file.stopped = true;
    throw new Error(`session id ${session} names no cost file`);
  }
  if (!file.found) {
    while (await $.fs.exists(joinPath(logDir, partName(session, file.part + 1)))) file.part += 1;
    file.found = true;
  }
  while (file.pending.length) {
    const path = joinPath(logDir, partName(session, file.part));
    if (file.text === null) {
      let text = '';
      if (await $.fs.exists(path)) {
        try { text = await $.fs.read(path); } catch { text = null; }
        if (typeof text !== 'string') {
          file.stopped = true;
          status($, `orchestrate-mod: cost log for ${session} unreadable — not written`);
          return;
        }
        if (text !== '' && !text.endsWith('\n')) text += '\n';
      }
      file.text = text;
      file.bytes = utf8Length(text);
    }
    const { n, bytes } = fitting(file.bytes, file.pending);
    if (n === 0) {
      file.part += 1;
      file.text = null;
      continue;
    }
    const text = file.text + file.pending.slice(0, n).join('');
    await $.fs.write(path, text);
    file.text = text;
    file.bytes += bytes;
    file.pending.splice(0, n);
  }
}

// The first error of this instance, as the status line; later ones would only replace it.
function showError($, error) {
  if (errorShown) return;
  errorShown = true;
  status($, `orchestrate-mod: cost log error — ${String(error && error.message ? error.message : error)}`);
}

// The plugin's one status line, on one line; a status that cannot be shown never fails the hook that set it.
function status($, text) {
  try { $.ui.status(text.replace(/[\x00-\x1f\x7f]+/g, ' ')); } catch { /* the line is a courtesy, never a failure */ }
}
