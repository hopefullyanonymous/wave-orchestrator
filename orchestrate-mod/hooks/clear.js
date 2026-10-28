// Pure helpers of the clear and continue: they take data and never `$`, and import nothing, so the hooks module
// (orchestrate-mod/hooks/register.js) and node:test share them. The tool's names, description and schema, the
// countdown and the two argument builders here are the single source register.js uses.

// ===== The tool and the commands =========================================================

// The tool the conductor calls at its step-8 points (orchestrate/references/protocol.md §Session algorithm), and the
// name the model calls it by: `mcp__<plugin>__<name>`, the plugin orchestrate-mod/.claude-plugin/plugin.json names.
export const TOOL_NAME = 'schedule_clear';
export const TOOL_FULL_NAME = 'mcp__orchestrate-mod__schedule_clear';
export const TOOL_DESCRIPTION = 'orchestrate-mod: schedules an automatic clear of this conversation followed by /orchestrate'
  + ' continue <ledger> after-clear. Call it only where your ledger\'s pinned protocol.md (§Session algorithm step 8)'
  + ' names this tool, with the ledger id and the integration branch\'s full tip SHA. The answer begins `scheduled`'
  + ' (post the line it gives, then end your turn), `not needed` (carry on: no clear and no timer) or `declined` (take'
  + ' the timer path, after any retry your ledger\'s step 8 names).';
export const TOOL_INPUT_SCHEMA = { type: 'object', properties: { ledger: { type: 'string' }, sha: { type: 'string' } }, required: ['ledger', 'sha'] };
// From the end of the conductor's turn to the clear: two minutes, any message before then keeping the conversation.
export const COUNTDOWN_MS = 120000;
// How long after the turn completes its unblocked Stop may still arrive before background work counts as unknown.
export const STOP_WAIT_MS = 5000;
// The `/orchestrate` arguments the fresh conversation runs, the ones a skipped clear runs in place with its reason,
// and the ones the band offers to type when that command was refused.
export const afterClearArgs = id => `continue ${id} after-clear`;
export const inPlaceArgs = (id, reason) => `continue ${id} in-place ${reason}`;
export const continueArgs = id => `continue ${id}`;

// ===== Deciding a call ===================================================================

// A full commit id: 40 lowercase hex characters (SHA-1) or 64 (SHA-256).
export const validSha = sha => typeof sha === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(sha);

// A git run's stdout, `$.process.run`'s answer or `{ error }` when the run was refused, or why it cannot be read.
function gitText(run, what) {
  if (typeof run.error === 'string') return { error: `${what} failed: ${run.error}` };
  if (run.isStdoutTruncated) return { error: `${what} was cut short` };
  if (run.exitCode !== 0) return { error: `${what} exited ${run.exitCode}` };
  return { text: String(run.stdout) };
}

// The worktree holding `refs/heads/<branch>` in `git worktree list --porcelain`'s output, LF or CRLF, its path as
// git prints it (`C:/…` on Windows): `{ path }`, `{ none: true }` when no worktree holds it, or `{ error }` when a
// record does not open with its `worktree` line or two worktrees hold the branch.
export function worktreeHolding(stdout, branch) {
  const held = [];
  let path = null;
  for (const line of stdout.split(/\r?\n/)) {
    if (line === '') path = null;
    else if (line.startsWith('worktree ')) path = line.slice('worktree '.length);
    else if (path === null) return { error: `a record opens with ${line}` };
    else if (line === `branch refs/heads/${branch}`) held.push(path);
  }
  if (held.length > 1) return { error: `${held.length} worktrees hold ${branch}` };
  return held.length === 1 ? { path: held[0] } : { none: true };
}

// What a shown engine field may not carry: C0, DEL, C1 and the two Unicode separators, each drawn as a space.
const UNSHOWN = new RegExp('[\\x00-\\x1f\\x7f-\\x9f' + String.fromCharCode(0x2028, 0x2029) + ']', 'g');
export const SHOWN_MAX = 80;
// An agent's, a task's or a cron's field as a reason shows it: on one line and at most SHOWN_MAX characters, a longer
// one cut there with a closing `…`, so a model-written description cannot fake a line; `?` when it is no string.
export function shown(value) {
  if (typeof value !== 'string') return '?';
  const chars = [...value.replace(UNSHOWN, ' ')];
  return chars.length > SHOWN_MAX ? chars.slice(0, SHOWN_MAX).join('') + '…' : chars.join('');
}

// The statuses after which an agent no longer runs; every other one, `pending` and any the engine adds, is in flight.
export const SETTLED = ['completed', 'failed', 'killed'];
// How a `waiting` status reads: the sub-agent returned its report while a background command of its own still runs.
export const WAITING = 'waiting: returned its report; a command of its own still runs';
const agentEntry = a => {
  const o = a !== null && typeof a === 'object' ? a : {};
  return `${shown(o.id)} (${shown(o.type)}, "${shown(o.description)}", ${o.status === 'waiting' ? WAITING : shown(o.status)})`;
};
// Why `$.agent.list()`'s answer stops a clear: the agents in flight, each named under `an agent is in flight` for
// one and `agents are in flight` for several, or an answer that is no list (a rejected call is `{ error }`); null
// when every agent has settled.
export function agentsReason(list) {
  if (!Array.isArray(list)) return 'the agent list cannot be read';
  const busy = list.filter(a => !(a !== null && typeof a === 'object' && SETTLED.includes(a.status)));
  if (busy.length === 0) return null;
  return `${busy.length === 1 ? 'an agent is' : 'agents are'} in flight: ${busy.map(agentEntry).join('; ')}`;
}

// The ledger's clear threshold from its view entry's `clearThreshold` (orchestrate-mod/tools/ledger-view.mjs
// `clearThreshold`): `{ tokens, source }`, or `{ error }` when the entry carries none, an error, or no form read here.
function thresholdOf(t) {
  if (t === null || typeof t !== 'object') return { error: 'the ledger view carries none' };
  if (typeof t.error === 'string') return { error: t.error };
  const valid = Number.isSafeInteger(t.tokens) && t.tokens >= 0 && t.tokens % 1000 === 0 && ['contract', 'default'].includes(t.source);
  return valid ? { tokens: t.tokens, source: t.source } : { error: 'the ledger view carries it in no form this mod reads' };
}

// The verdict on a `schedule_clear` call over the facts gathered so far, by the first reason that applies, in this
// order: (a) a sub-agent called it; (b) the ledger is no ledger id, or the SHA no full one; (c) a clear is already
// scheduled or counting down; (d) the session is not tagged with the ledger, or the view holds no entry for it, or
// one with an error; (e) its integration tip is not the SHA; (f) its clear threshold cannot be read; (g) its pinned
// protocol.md cannot be read or does not name the tool; (h) a git run fails, or the worktree holding the
// integration branch has uncommitted files in the ledger's directory; (i) an agent is in flight or the agent list
// cannot be read. Answers `{ declined: reason }`, `{ need: name }` when the next reason reads a fact not gathered
// yet (`{ need: 'status', cwd }` names the worktree to run in), `{ notNeeded: { tokens, threshold, source } }`
// when the context is known and under the threshold, else `{ scheduled: true }`; a context unknown is never under
// it. The facts:
//   agentId, ledger, sha: the call's own; ledgerValid: orchestrate-mod/hooks/cost.js `validId`'s answer;
//   busy: a clear is scheduled or counting down; read: { tag, view, root }, the session's tag and register.js
//   `load`'s view and root; context: the conductor's context in tokens, null or { error } when unknown;
//   protocol: { text } or { error }; worktrees, status: a git run, `$.process.run`'s answer or { error }; agents:
//   `$.agent.list()`'s answer or { error }.
export function decide(f) {
  const no = declined => ({ declined });
  if (f.agentId !== undefined) return no('only the main conversation can schedule a clear');
  if (f.ledgerValid !== true) return no('ledger is not a ledger id');
  if (!validSha(f.sha)) return no('sha is not a full commit SHA (40 or 64 lowercase hex characters)');
  if (f.busy) return no('a clear is already scheduled');
  if (f.read === undefined) return { need: 'read' };
  const id = f.ledger, view = f.read.view;
  if (f.read.tag !== id) return no(`this session's ledger tag is ${f.read.tag ?? 'none'}, not ${id}`);
  if (typeof view.error === 'string') return no(`the ledger view cannot be read: ${view.error}`);
  if (!view.ledger || view.ledger.id !== id) return no(`the ledger view lists no ${id}`);
  if (typeof view.ledger.error === 'string') return no(`the ledger view of ${id} carries an error: ${view.ledger.error}`);
  const integration = view.ledger.integration;
  if (!integration || integration.sha !== f.sha) return no(`the integration tip is ${integration?.sha ?? '?'}, not ${f.sha}`);
  const threshold = thresholdOf(view.ledger.clearThreshold);
  if (threshold.error !== undefined) return no(`the ledger's Clear threshold line cannot be read: ${threshold.error}`);
  if (f.context === undefined) return { need: 'context' };
  const size = f.context;
  if (typeof size === 'number' && size >= 0 && size < threshold.tokens) {
    return { notNeeded: { tokens: size, threshold: threshold.tokens, source: threshold.source } };
  }
  if (f.protocol === undefined) return { need: 'protocol' };
  if (typeof f.protocol.text !== 'string') return no(`the pinned protocol.md cannot be read: ${f.protocol.error}`);
  if (!f.protocol.text.includes(TOOL_FULL_NAME)) return no(`the pinned protocol.md does not name ${TOOL_FULL_NAME}`);
  if (f.worktrees === undefined) return { need: 'worktrees' };
  const listed = gitText(f.worktrees, 'git worktree list');
  if (listed.error) return no(listed.error);
  const holder = worktreeHolding(listed.text, integration.branch);
  if (holder.error) return no(`git worktree list cannot be read: ${holder.error}`);
  // No worktree holding the branch has nothing uncommitted on it.
  if (holder.path !== undefined) {
    if (f.status === undefined) return { need: 'status', cwd: holder.path };
    const status = gitText(f.status, 'git status');
    if (status.error) return no(status.error);
    if (status.text !== '') return no(`uncommitted files in .agents/changes/${id}/ of ${holder.path}`);
  }
  if (f.agents === undefined) return { need: 'agents' };
  const agents = agentsReason(f.agents);
  return agents === null ? { scheduled: true } : no(agents);
}

// The line the conductor posts once the clear is scheduled, its context in thousands of tokens (`?K` unknown).
export function scheduledLine(tokens, id) {
  const context = Number.isFinite(tokens) && tokens >= 0 ? `${Math.round(tokens / 1000)}K` : '?K';
  return `Context ${context}: clearing this conversation in about two minutes and continuing ${id} in a fresh one; any message before then keeps this conversation.`;
}
// What follows `not needed: ` for `decide`'s `notNeeded`: the context floored to thousands, so 299,999 reads 299K.
export function notNeededLine({ tokens, threshold, source }) {
  const whose = source === 'default' ? 'the default' : "the ledger's";
  return `context ${Math.floor(tokens / 1000)}K is under ${whose} ${threshold / 1000}K clear threshold`;
}

// ===== The turn's end, the countdown and the run =========================================

// A task by its command, else (a sub-agent's entry has none) its description; a cron by its schedule.
const taskEntry = t => {
  const o = t !== null && typeof t === 'object' ? t : {};
  return `${shown(o.id)} (${shown(o.type)}, ${shown(typeof o.command === 'string' ? o.command : o.description)})`;
};
const cronEntry = c => {
  const o = c !== null && typeof c === 'object' ? c : {};
  return `${shown(o.id)} (${shown(o.schedule)})`;
};
// Why a main-loop Stop's in-flight fields stop a clear: work running, each task named, a cron that would wake the
// fresh conversation, each cron named, or either field absent or no array (unknown); null when both are arrays
// with no entry.
export function stopReason(e) {
  const tasks = e.background_tasks, crons = e.session_crons;
  if (Array.isArray(tasks) && tasks.length > 0) return `background work is running: ${tasks.map(taskEntry).join('; ')}`;
  if (Array.isArray(crons) && crons.length > 0) return `a scheduled task would wake this conversation: ${crons.map(cronEntry).join('; ')}`;
  if (!Array.isArray(tasks) || !Array.isArray(crons)) return 'background work is unknown';
  return null;
}
// Why the clear is skipped when no unblocked Stop came within STOP_WAIT_MS of the turn's completion.
export const NO_STOP = `no Stop within ${STOP_WAIT_MS / 1000} s, so background work is unknown`;

// The band's countdown segment, the seconds left rounded up as M:SS.
export function countdownText(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `clearing in ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')} · type anything to keep this conversation`;
}
// The band's notice of a skipped clear: continuing here by the mod's own command, or, when that command was
// refused, the command for the person to type.
export const skipNotice = (reason, id, continuing) => `clear skipped: ${reason} — ${continuing ? 'continuing here' : `type /orchestrate ${continueArgs(id)}`}`;
// The band's notice when the clear ran and the fresh conversation's command was refused.
export const afterClearNotice = id => `cleared — type /orchestrate ${afterClearArgs(id)}`;

// The run after one more clear: `run` (null before the first) is `{ ledger, ids, clears }`, its conversation ids
// oldest first and each clear's `{ at, tzOffset, tokens }`. The clear joins the run when it began from the run's
// last conversation for the same ledger; any other clear, or one whose first id could not be read (null), begins
// a run of its own.
export function linkClear(run, { ledger, before, after, at, tzOffset, tokens }) {
  const joins = run !== null && run.ledger === ledger && before !== null && run.ids[run.ids.length - 1] === before;
  const base = joins ? run : { ledger, ids: [before], clears: [] };
  return { ledger, ids: [...base.ids, after], clears: [...base.clears, { at, tzOffset, tokens }] };
}

// The run's dollars over its conversations from `sessions`, the in-process totals by session id
// (orchestrate-mod/hooks/cost.js `newTotals`): a conversation with no total recorded no request and adds $0.00, an
// id that could not be read (null) counts as one unpriced record.
export function runTotal(ids, sessions) {
  let usd = 0, unpriced = 0;
  for (const id of ids) {
    const own = id === null ? { usd: 0, unpriced: 1 } : sessions.get(id) ?? { usd: 0, unpriced: 0 };
    usd += own.usd;
    unpriced += own.unpriced;
  }
  return { usd, unpriced, conversations: ids.length };
}
