// Pure helpers of the cost log: they take data and never `$`, and import nothing, so the hooks module
// (orchestrate-mod/hooks/register.js), the report (orchestrate-mod/tools/cost-report.mjs) and node:test
// share one implementation of attribution, record format, pricing and aggregation.

// ===== Attribution =====================================================================

// The role keys of orchestrate/tools/prompt.mjs `ROLES`, reviewer-round2 ahead of reviewer; restated because this
// module imports nothing, and held equal by tests/orchestrate-mod-cost.test.cjs.
export const RENDERED_ROLES = ['implementer', 'polish', 'fix-round', 'rework', 'reviewer-round2', 'reviewer', 'test-hunter'];
// The fixed pointer message the orchestrator spawns a rendered role with
// (orchestrate/references/protocol.md, `Your complete instructions are in the file`).
export const POINTER = 'Your complete instructions are in the file ';
// A rendered prompt's file name (orchestrate/tools/prompt.mjs `ledger.changeId`), matched whole: change id, batch,
// role and a 12-hex id, the change id in the character set of orchestrate/tools/git-evidence.mjs `validId`.
const PROMPT_FILE = new RegExp('^([A-Za-z0-9][A-Za-z0-9_.-]*?)-B(\\d{2,})-(' + RENDERED_ROLES.join('|') + ')-([0-9a-f]{12})\\.md$');
const ID = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
// The ledger-id check of orchestrate/tools/git-evidence.mjs `validId`, restated because this module imports nothing.
export const validId = id => typeof id === 'string' && ID.test(id) && !id.includes('..');
const text = value => typeof value === 'string' && value.length > 0;

// The basename of the `.md` file the pointer names, or null when the prompt carries no pointer. The path
// may hold spaces (a Windows profile directory) and either separator; it ends at `.md` before the
// sentence's full stop, a space or the end.
export function promptFileOf(prompt) {
  if (typeof prompt !== 'string') return null;
  const at = prompt.indexOf(POINTER);
  if (at < 0) return null;
  const match = /^([^\r\n]+?\.md)(?=\.?(?:\s|$))/.exec(prompt.slice(at + POINTER.length));
  if (!match) return null;
  const file = match[1];
  return file.slice(Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\')) + 1);
}

// `{ ledger, batch, role }` from a rendered prompt's file name matched whole, or null.
export function parsePromptFile(name) {
  const match = typeof name === 'string' ? PROMPT_FILE.exec(name) : null;
  if (!match || !validId(match[1])) return null;
  return { ledger: match[1], batch: 'B' + match[2], role: match[3] };
}

// The first batch id (`B` and two or more digits, a whole word) in a task description, or null.
export function batchOf(description) {
  const match = typeof description === 'string' ? /\bB\d{2,}\b/.exec(description) : null;
  return match ? match[0] : null;
}

// What a main-loop record carries beside its usage.
export const mainAttribution = tag => ({ type: 'main', role: 'main', ledger: tag, batch: null, parent: null });

// A subagent's attribution from its `agent.spawn` input: ledger, batch and role from the rendered prompt the
// pointer names; any other agent gets the session's ledger tag, the description's batch and its type as role.
export function attributeSpawn(e, tag) {
  const known = text(e.subagentType), type = known ? e.subagentType : 'unknown';
  const parent = text(e.parentAgentId) ? e.parentAgentId : null;
  const rendered = parsePromptFile(promptFileOf(e.prompt));
  if (rendered) return { type, role: rendered.role, ledger: rendered.ledger, batch: rendered.batch, parent };
  return { type, role: known ? type : null, ledger: tag, batch: batchOf(e.description), parent };
}

// A subagent's attribution from its `$.agent.list()` entry, for an agent whose spawn this module never saw;
// `info` undefined (the list does not name it) is an unknown agent.
export function attributeListed(info, tag) {
  if (!info || !text(info.type)) return { type: 'unknown', role: null, ledger: tag, batch: null, parent: null };
  const parent = text(info.parentId) ? info.parentId : null;
  return { type: info.type, role: info.type, ledger: tag, batch: batchOf(info.description), parent };
}

// ===== The session's ledger tag ========================================================

const ACTIVE = ['continue', 'close', 'status'];
// The one AMBIGUOUS reason read as active: the ledger's copies hold different States (every checkpoint when the
// installed skill predates BL-054's fix).
// Its sibling reader of the same line is orchestrate-mod/tools/ledger-view.mjs `readDiscovery`.
const DIFFERS = 'AMBIGUOUS (State differs: ';
// Returns the id of the one line of `reconcile.mjs discovery`'s output (orchestrate/tools/reconcile.mjs
// `summarize`) whose mode is continue, close or status, or starts with DIFFERS, read whatever the exit code. A
// line's mode is the text after its LAST ` → `, since its locations are paths that may hold one. An INCOMPLETE
// line, NO LEDGERS or any other line not shaped `<id> State=… at … → <mode>` or `<id> at … → <mode>`, any other
// AMBIGUOUS mode or an UNKNOWN one, an id `validId` refuses, no active line or several return null: untagged.
export function ledgerTag(stdout) {
  if (typeof stdout !== 'string') return null;
  const found = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (line === '') continue;
    if (!/^\S+ (?:State=.* )?at .* → /.test(line)) return null;
    const id = line.slice(0, line.indexOf(' ')), mode = line.slice(line.lastIndexOf(' → ') + 3);
    if (!validId(id)) return null;
    if (ACTIVE.includes(mode) || mode.startsWith(DIFFERS)) found.push(id);
    else if (mode !== 'none' && !mode.startsWith('none (older copies: ')) return null;
  }
  return found.length === 1 ? found[0] : null;
}

// ===== Records =========================================================================

// The fourteen keys of a record line, in the order every line carries them.
export const RECORD_KEYS = ['v', 'ts', 'session', 'agent', 'parent', 'type', 'ledger', 'batch', 'role', 'model', 'in', 'out', 'cr', 'cw'];
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const count = value => Number.isSafeInteger(value) && value >= 0;
const textOrNull = value => value === null || text(value);

// Why a parsed value is not a record, or null when it is one.
export function recordProblem(r) {
  if (r === null || typeof r !== 'object' || Array.isArray(r)) return 'not a JSON object';
  const keys = Object.keys(r);
  if (keys.length !== RECORD_KEYS.length || keys.some((key, i) => key !== RECORD_KEYS[i])) {
    return 'keys are not exactly ' + RECORD_KEYS.join(', ') + ', in that order';
  }
  if (r.v !== 1) return 'v is not 1';
  // The format alone admits a 30 February: the time must also read back as itself.
  if (typeof r.ts !== 'string' || !ISO.test(r.ts) || Number.isNaN(Date.parse(r.ts)) || new Date(Date.parse(r.ts)).toISOString() !== r.ts) {
    return 'ts is not an ISO-8601 UTC time in milliseconds';
  }
  if (!text(r.session)) return 'session is not a non-empty string';
  if (!textOrNull(r.agent)) return 'agent is neither null nor a non-empty string';
  if (!textOrNull(r.parent)) return 'parent is neither null nor a non-empty string';
  if (!text(r.type)) return 'type is not a non-empty string';
  if (r.ledger !== null && !validId(r.ledger)) return 'ledger is neither null nor a ledger id';
  if (r.batch !== null && !(typeof r.batch === 'string' && /^B\d{2,}$/.test(r.batch))) {
    return 'batch is neither null nor B and two or more digits';
  }
  if (!textOrNull(r.role)) return 'role is neither null nor a non-empty string';
  if (!text(r.model)) return 'model is not a non-empty string';
  for (const key of ['in', 'out', 'cr', 'cw']) if (!count(r[key])) return key + ' is not a non-negative integer';
  if (r.agent === null && (r.type !== 'main' || r.role !== 'main' || r.batch !== null || r.parent !== null)) {
    return 'a main-loop record (agent null) carries type main, role main, batch null and parent null';
  }
  return null;
}

// One request's record, keys in RECORD_KEYS order; throws rather than build a record the parser would refuse.
export function buildRecord({ now, session, agent, attribution, usage }) {
  const record = {
    v: 1, ts: new Date(now).toISOString(), session, agent, parent: attribution.parent, type: attribution.type,
    ledger: attribution.ledger, batch: attribution.batch, role: attribution.role, model: usage.model,
    in: usage.input_tokens, out: usage.output_tokens, cr: usage.cache_read_input_tokens, cw: usage.cache_creation_input_tokens,
  };
  const problem = recordProblem(record);
  if (problem) throw new Error('record not built: ' + problem);
  return record;
}

export const recordLine = record => JSON.stringify(record) + '\n';

// `{ record }` for a valid record line, else `{ reason }`.
export function parseRecordLine(line) {
  let value;
  try { value = JSON.parse(line); } catch { return { reason: 'not JSON' }; }
  const problem = recordProblem(value);
  return problem ? { reason: problem } : { record: value };
}

// Every record of a part file's text, or the first line that is not one (`{ line, reason }`, 1-based). Each
// record ends with a line break, so text whose last line has none was cut short.
export function parseRecords(text) {
  const lines = text.split('\n'), tail = lines.pop(), records = [];
  for (let i = 0; i < lines.length; i++) {
    const parsed = parseRecordLine(lines[i]);
    if (!parsed.record) return { line: i + 1, reason: parsed.reason };
    records.push(parsed.record);
  }
  if (tail !== '') return { line: lines.length + 1, reason: 'no line break after the last record' };
  return { records };
}

// ===== Files ===========================================================================

// A part holds at most this many bytes of UTF-8, below the 4 MiB one `$.fs.write` takes.
export const PART_LIMIT = 3 * 1024 * 1024;
const SESSION_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
export const utf8Length = value => new TextEncoder().encode(value).length;
// Joins with `/`, which every platform's file API accepts, after the base's own trailing separators.
export const joinPath = (base, ...parts) => [base.replace(/[\\/]+$/, ''), ...parts].join('/');
export const costDir = home => joinPath(home, '.claude', 'orchestrate-costs');
// Part `n` of a session's file: `<session>.jsonl`, then `<session>.<n>.jsonl`. A session id that is not a plain
// name (one that could leave the directory or read as another session's part) names no file: null.
export function partName(session, n) {
  if (typeof session !== 'string' || !SESSION_NAME.test(session)) return null;
  return n === 0 ? session + '.jsonl' : session + '.' + n + '.jsonl';
}
// How many of `lines`, in order, a part holding `used` bytes takes without passing `limit`, and their bytes. An
// empty part takes its first line whatever its size, so a write always makes progress.
export function fitting(used, lines, limit = PART_LIMIT) {
  let n = 0, bytes = 0;
  for (const line of lines) {
    const size = utf8Length(line);
    if (used + bytes + size > limit && used + bytes > 0) break;
    n++;
    bytes += size;
  }
  return { n, bytes };
}

// ===== Pricing and totals ==============================================================

// A record's cost in USD from `prices` (orchestrate-mod/hooks/prices.js `PRICES`), looked up by the EXACT model
// id; null for a model the table lacks, which a total counts as unpriced and never as $0. A response's usage
// carries no 5-minute/1-hour split of its cache writes, so the write rate is an assumption: Claude Code's
// defaults, the 1-hour rate for the main loop (agent null) and the 5-minute rate for a subagent, unless
// `subagentPromptCacheTtl` or an agent's `experimental.cacheTtl` says otherwise. Comparing these totals with
// Claude Code's `/cost` measures it.
export function priceOf(record, prices) {
  if (!Object.hasOwn(prices, record.model)) return null;
  const p = prices[record.model], write = record.agent === null ? p.cacheWrite1h : p.cacheWrite5m;
  return (record.in * p.in + record.out * p.out + record.cr * p.cacheRead + record.cw * write) / 1e6;
}

// A total: `usd` sums its PRICED records and `unpriced` counts the rest, so a total with unpriced > 0 is
// incomplete, never complete.
export const emptyTotal = () => ({ requests: 0, in: 0, out: 0, cr: 0, cw: 0, usd: 0, unpriced: 0 });
export function addTo(total, record, usd) {
  total.requests += 1;
  total.in += record.in;
  total.out += record.out;
  total.cr += record.cr;
  total.cw += record.cw;
  if (usd === null) total.unpriced += 1;
  else total.usd += usd;
  return total;
}
export const roundedTotal = total => ({ ...total, usd: Number(total.usd.toFixed(6)) });

// The running aggregates of a module instance: `agents` by agent id, the main loop under `main`, each with its
// attribution, when it was first seen (ms), its totals and `lastPrompt` (its last request's in + cr + cw, the
// context it sent); `sessions` by session id; `total`; and `tag`, the session's ledger tag.
export const newTotals = () => ({ agents: new Map(), sessions: new Map(), total: emptyTotal(), tag: null });
// Adds one record to the aggregates; returns its price (null when unpriced).
export function addRecord(totals, record, prices) {
  const usd = priceOf(record, prices), key = record.agent ?? 'main';
  let agent = totals.agents.get(key);
  if (!agent) {
    agent = { type: null, role: null, ledger: null, batch: null, parent: null, firstSeen: Date.parse(record.ts), ...emptyTotal(), lastPrompt: 0 };
    totals.agents.set(key, agent);
  }
  // The latest record's attribution stands: the main loop's ledger tag follows each discovery refresh.
  Object.assign(agent, { type: record.type, role: record.role, ledger: record.ledger, batch: record.batch, parent: record.parent });
  addTo(agent, record, usd);
  agent.lastPrompt = record.in + record.cr + record.cw;
  if (!totals.sessions.has(record.session)) totals.sessions.set(record.session, emptyTotal());
  addTo(totals.sessions.get(record.session), record, usd);
  addTo(totals.total, record, usd);
  return usd;
}

const NONE = '(none)';
const entry = (map, key, make) => { if (!map.has(key)) map.set(key, make()); return map.get(key); };
// The report's totals over `records`: overall, by ledger then batch then role (`(none)` for null), by model and
// by session.
export function aggregate(records, prices) {
  const out = { total: emptyTotal(), byLedger: new Map(), byModel: new Map(), bySession: new Map() };
  for (const record of records) {
    const usd = priceOf(record, prices);
    addTo(out.total, record, usd);
    const ledger = entry(out.byLedger, record.ledger ?? NONE, () => ({ total: emptyTotal(), byBatch: new Map() }));
    addTo(ledger.total, record, usd);
    const batch = entry(ledger.byBatch, record.batch ?? NONE, () => ({ total: emptyTotal(), byRole: new Map() }));
    addTo(batch.total, record, usd);
    addTo(entry(batch.byRole, record.role ?? NONE, emptyTotal), record, usd);
    addTo(entry(out.byModel, record.model, emptyTotal), record, usd);
    addTo(entry(out.bySession, record.session, emptyTotal), record, usd);
  }
  return out;
}
