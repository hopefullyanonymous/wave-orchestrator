// Pure helpers of the /ledger pane, the band line and the text fallback: they take data and never `$`, and
// import nothing, so the hooks module (orchestrate-mod/hooks/register.js) and node:test share them. The pane, the
// band and the text read one `data` object, built once per refresh by register.js `load`:
//   { at, tzOffset, root, tag, view, costs, agents, conductor, session, slashCost }
// `view` is `readView`'s answer, `costs` `readCosts`'s (null when there is no ledger to ask about), `agents`
// `runningAgents`'s, `conductor` `conductorOf`'s, `session` the session's own `{ usd, unpriced }` total and
// `slashCost` the `/cost` dollars; `at`, `agents`, `conductor`, `session` and `slashCost` are null where the
// reading is unknown, and unknown renders as `?` or a stated reason, never as 0. Three optional fields carry the
// clear (orchestrate-mod/hooks/clear.js), each absent until there is one, so absent they change no line:
// `clearBand`, the band's countdown or notice; `clears`, each clear's `{ at, tzOffset, tokens }`; and `runTotal`,
// the run's `{ usd, unpriced, conversations }` over the conversations its clears link.

// The conductor's safe point in tokens: orchestrate/references/protocol.md, `about 300K`.
export const SAFE_POINT = 300000;
export const INCOMPLETE = 'discovery incomplete — some ledgers may be missing';

// What a line may not carry to a surface or a terminal: C0, DEL, C1 and the two Unicode separators, each run
// drawn as one space.
const HIDDEN = new RegExp('[\\x00-\\x1f\\x7f-\\x9f' + String.fromCharCode(0x2028, 0x2029) + ']+', 'g');
// Code points a terminal draws two cells wide: the East Asian wide ranges and the emoji drawn as emoji by default.
const WIDE = [
  [0x1100, 0x115f], [0x231a, 0x231b], [0x2329, 0x232a], [0x23e9, 0x23ec], [0x23f0, 0x23f0], [0x23f3, 0x23f3],
  [0x25fd, 0x25fe], [0x2614, 0x2615], [0x2648, 0x2653], [0x267f, 0x267f], [0x2693, 0x2693], [0x26a1, 0x26a1],
  [0x26aa, 0x26ab], [0x26bd, 0x26be], [0x26c4, 0x26c5], [0x26ce, 0x26ce], [0x26d4, 0x26d4], [0x26ea, 0x26ea],
  [0x26f2, 0x26f3], [0x26f5, 0x26f5], [0x26fa, 0x26fa], [0x26fd, 0x26fd], [0x2705, 0x2705], [0x270a, 0x270b],
  [0x2728, 0x2728], [0x274c, 0x274c], [0x274e, 0x274e], [0x2753, 0x2755], [0x2757, 0x2757], [0x2795, 0x2797],
  [0x27b0, 0x27b0], [0x27bf, 0x27bf], [0x2b1b, 0x2b1c], [0x2b50, 0x2b50], [0x2b55, 0x2b55], [0x2e80, 0x303e],
  [0x3041, 0x33ff], [0x3400, 0x4dbf], [0x4e00, 0x9fff], [0xa000, 0xa4cf], [0xac00, 0xd7a3], [0xf900, 0xfaff],
  [0xfe30, 0xfe4f], [0xff00, 0xff60], [0xffe0, 0xffe6], [0x1f004, 0x1f004], [0x1f0cf, 0x1f0cf], [0x1f18e, 0x1f18e],
  [0x1f191, 0x1f19a], [0x1f200, 0x1f251], [0x1f300, 0x1f64f], [0x1f680, 0x1f6ff], [0x1f7e0, 0x1f7eb],
  [0x1f900, 0x1f9ff], [0x1fa70, 0x1faff], [0x20000, 0x3fffd],
];
// Code points drawn in no cell of their own: combining marks, zero-width characters and variation selectors.
const ZERO = [[0x0300, 0x036f], [0x200b, 0x200f], [0x20d0, 0x20ff], [0xfe00, 0xfe0f], [0x1f3fb, 0x1f3ff], [0xe0000, 0xe007f]];
const within = (ranges, n) => ranges.some(([lo, hi]) => n >= lo && n <= hi);
const cellOf = n => (within(ZERO, n) ? 0 : within(WIDE, n) ? 2 : 1);

const isNumber = value => typeof value === 'number' && Number.isFinite(value);
const isCount = value => isNumber(value) && value >= 0;
const isTotal = t => t !== null && typeof t === 'object' && isNumber(t.usd) && Number.isSafeInteger(t.unpriced) && t.unpriced >= 0;
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// ===== Formatters ======================================================================

// The cells a terminal draws `text` in.
export function cells(text) {
  let n = 0;
  for (const ch of String(text)) n += cellOf(ch.codePointAt(0));
  return n;
}

// `text` on one line, its hidden characters as spaces, cut to `width` cells with a closing `…` when wider; a
// width that is not a finite number cuts nothing.
export function fit(text, width) {
  const clean = String(text).replace(HIDDEN, ' ');
  if (!isNumber(width)) return clean;
  const room = Math.max(1, Math.floor(width));
  if (cells(clean) <= room) return clean;
  let out = '', used = 0;
  for (const ch of clean) {
    const c = cellOf(ch.codePointAt(0));
    if (used + c > room - 1) break;
    out += ch;
    used += c;
  }
  return out + '…';
}

const padEnd = (text, width) => text + ' '.repeat(Math.max(0, width - cells(text)));
const padStart = (text, width) => ' '.repeat(Math.max(0, width - cells(text))) + text;

// Tokens as `<n>K`, rounded to the nearest thousand; `?` when unknown.
export const tokensK = n => (isCount(n) ? `${Math.round(n / 1000)}K` : '?');
// A context window: `1M` for 1,000,000, else as tokens.
export const windowText = n => (n === 1000000 ? '1M' : tokensK(n));
// Whole minutes in `ms`; `?` when unknown.
export const minutes = ms => (isNumber(ms) ? String(Math.max(0, Math.floor(ms / 60000))) : '?');
// Dollars to two decimals from a number or a `{ usd, unpriced }` total; a total leaving unpriced records out
// reads `$<usd>+?`; `?` when unknown.
export function dollars(value) {
  if (isNumber(value)) return `$${value.toFixed(2)}`;
  if (isTotal(value)) return `$${value.usd.toFixed(2)}${value.unpriced > 0 ? '+?' : ''}`;
  return '?';
}
// The session total against `/cost`, `(session − /cost) / /cost`, as a signed percentage to one decimal; `?`
// when either is unknown, the session total leaves unpriced records out, or `/cost` is 0.
export function delta(session, slashCost) {
  if (!isTotal(session) || session.unpriced > 0 || !isNumber(slashCost) || slashCost === 0) return '?';
  const ratio = (session.usd - slashCost) / slashCost, size = (Math.abs(ratio) * 100).toFixed(1);
  return `${ratio < 0 && size !== '0.0' ? '-' : '+'}${size}%`;
}
// `HH:MM:SS` of `ms` at `tzOffset` (minutes, as Date's getTimezoneOffset counts them); `?` when unknown.
export function clock(ms, tzOffset) {
  if (!isNumber(ms) || !isNumber(tzOffset)) return '?';
  const d = new Date(ms - tzOffset * 60000);
  return [d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()].map(n => String(n).padStart(2, '0')).join(':');
}
// A ledger id with its date elided, `<PREFIX>-…-<slug>`; an id without one as it is.
export function shortId(id) {
  const match = /^([^-]+)-\d{8}-(.+)$/.exec(String(id));
  return match ? `${match[1]}-…-${match[2]}` : String(id);
}

// ===== Reading the tools' output =========================================================

const firstLine = text => (typeof text === 'string' ? text.split(/\r?\n/).find(line => line !== '') ?? '' : '');
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

// The view to draw from one run of orchestrate-mod/tools/ledger-view.mjs: `{ error }`, the reason it is
// unavailable, or `{ incomplete, ledger, more }`, the ledger named `tag` (else the first; null with none) and how
// many others there are. `run` is `$.process.run`'s answer, or `{ error }` when the run was refused.
export function readView(run, tag) {
  if (typeof run.error === 'string') return { error: run.error };
  if (run.isStdoutTruncated) return { error: 'its output was cut short' };
  const line = firstLine(run.stdout);
  if (line.startsWith('UNKNOWN ')) return { error: line.slice('UNKNOWN '.length) };
  if (run.exitCode !== 0) return { error: `exit ${run.exitCode}${line ? `: ${line}` : ''}` };
  let view = null;
  try { view = JSON.parse(line); } catch { /* reported below */ }
  const ledgers = isObject(view) && view.v === 1 && typeof view.incomplete === 'boolean' && Array.isArray(view.ledgers) ? view.ledgers : null;
  if (ledgers === null || !ledgers.every(l => isObject(l) && typeof l.id === 'string' && Array.isArray(l.rows))) {
    return { error: `its output is not a view: ${line || 'no output'}` };
  }
  const ledger = ledgers.find(l => l.id === tag) ?? ledgers[0] ?? null;
  return { incomplete: view.incomplete, ledger, more: ledger === null ? 0 : ledgers.length - 1 };
}

// The dollars of ledger `id` from one run of orchestrate-mod/tools/cost-report.mjs `--ledger <id> --format json`:
// `{ ledger, total, byBatch }`, each a `{ usd, unpriced }` total, or `{ ledger, error }`. `NO RECORDS <dir>` is
// a proven absence: every figure $0.00.
export function readCosts(run, id) {
  if (typeof run.error === 'string') return { ledger: id, error: run.error };
  if (run.isStdoutTruncated) return { ledger: id, error: 'its output was cut short' };
  const line = firstLine(run.stdout);
  if (run.exitCode === 0 && line.startsWith('NO RECORDS ')) return { ledger: id, total: { usd: 0, unpriced: 0 }, byBatch: {} };
  if (run.exitCode !== 0) return { ledger: id, error: `exit ${run.exitCode}${line ? `: ${line}` : ''}` };
  let report = null;
  try { report = JSON.parse(line); } catch { /* reported below */ }
  const bad = { ledger: id, error: `its output is not a report: ${line || 'no output'}` };
  if (!isObject(report) || report.v !== 1 || !isTotal(report.total) || !isObject(report.byLedger)) return bad;
  const own = Object.hasOwn(report.byLedger, id) ? report.byLedger[id] : { byBatch: {} };
  if (!isObject(own) || !isObject(own.byBatch)) return bad;
  const byBatch = {};
  for (const [batch, entry] of Object.entries(own.byBatch)) {
    if (!isObject(entry) || !isTotal(entry.total)) return bad;
    byBatch[batch] = { usd: entry.total.usd, unpriced: entry.total.unpriced };
  }
  return { ledger: id, total: { usd: report.total.usd, unpriced: report.total.unpriced }, byBatch };
}

// The running agents of `$.agent.list()`'s answer, joined to `agents`, the cost log's aggregates by agent id
// (orchestrate-mod/hooks/cost.js `newTotals`): copies, oldest first, then the ones the aggregates do not hold,
// which carry only their type.
export function runningAgents(list, agents) {
  if (!Array.isArray(list)) return null;
  const known = [], unknown = [];
  for (const info of list) {
    if (!isObject(info) || info.status !== 'running') continue;
    const a = typeof info.id === 'string' ? agents.get(info.id) : undefined;
    if (!a) { unknown.push({ known: false, type: typeof info.type === 'string' ? info.type : '?' }); continue; }
    known.push({ known: true, role: a.role ?? a.type ?? info.type, batch: a.batch, firstSeen: a.firstSeen, ctx: a.lastPrompt, usd: a.usd, unpriced: a.unpriced });
  }
  known.sort((a, b) => a.firstSeen - b.firstSeen);
  return [...known, ...unknown];
}

// The conductor's context from `$.session.usage()`'s `context`: each figure null when the reading has none.
export function conductorOf(context) {
  const c = isObject(context) ? context : {};
  return { tokens: isCount(c.tokens) ? c.tokens : null, window: isCount(c.window) ? c.window : null, percent: isNumber(c.percent) ? c.percent : null };
}

// ===== The pane, the band and the text ====================================================

function headerLine(ledger) {
  const failed = typeof ledger.error === 'string';
  const wave = `W${isCount(ledger.currentWave) ? ledger.currentWave : '?'} of ${isCount(ledger.waves) ? ledger.waves : '?'}`;
  const next = failed ? '?' : ledger.nextCheckpoint ?? 'none';
  return `${ledger.id} · ${ledger.state ?? '?'} · ${wave} · next ${next}`;
}

function integrationLine(integration) {
  if (!isObject(integration) || typeof integration.branch !== 'string') return 'integration ?';
  return `${integration.branch} @${typeof integration.sha === 'string' ? integration.sha.slice(0, 7) : '?'}`;
}

// One line per row, its git verdict's text on a dim line under it; the title takes the room the other columns
// leave in `width` (at least 8 cells), so the git column and the dollars stay in view.
function rowLines(rows, costs, width) {
  const cols = rows.map(row => {
    const git = isObject(row.git) ? row.git : null;
    const round = typeof row.roundError === 'string' ? 'R?' : typeof row.round === 'string' ? row.round : '';
    const usd = costs === null || typeof costs.error === 'string' ? '?' : dollars(Object.hasOwn(costs.byBatch, row.id) ? costs.byBatch[row.id] : { usd: 0, unpriced: 0 });
    return {
      head: [String(row.id), String(row.status), `W${isCount(row.wave) ? row.wave : '?'}`, typeof row.weight === 'string' ? row.weight : '?'],
      title: String(row.title), round,
      git: git === null ? '' : typeof git.row === 'string' ? `git: row ${git.row}` : 'git: unknown',
      under: git === null ? null : typeof git.row === 'string' ? String(git.verdict) : String(git.unknown),
      usd,
    };
  });
  const most = pick => Math.max(0, ...cols.map(c => cells(pick(c))));
  const heads = [0, 1, 2, 3].map(i => most(c => c.head[i]));
  const roundW = most(c => c.round), gitW = most(c => c.git), usdW = most(c => c.usd);
  const tail = [roundW, gitW, usdW].filter(w => w > 0).reduce((sum, w) => sum + w + 2, 0);
  const lead = heads.reduce((sum, w) => sum + w + 1, 0) + 1;
  const titleW = Math.min(most(c => c.title), Math.max(8, isNumber(width) ? Math.floor(width) - lead - tail : Infinity));
  const out = [];
  for (const c of cols) {
    const parts = [c.head.map((h, i) => padEnd(h, heads[i])).join(' '), padEnd(fit(c.title, titleW), titleW)];
    if (roundW) parts.push(padEnd(c.round, roundW));
    if (gitW) parts.push(padEnd(c.git, gitW));
    parts.push(padStart(c.usd, usdW));
    out.push({ text: fit(parts.join('  ').trimEnd(), width), dim: false });
    if (c.under !== null) out.push({ text: fit(`    ${c.under}`, width), dim: true });
  }
  return out;
}

function agentLines(agents, at) {
  if (agents === null) return ['running  agents unknown — the agent list cannot be read'];
  if (agents.length === 0) return ['running  none'];
  const cols = agents.map(a => (a.known
    ? [String(a.role), a.batch ?? '-', `${isNumber(at) ? minutes(at - a.firstSeen) : '?'}m`, `${tokensK(a.ctx)} ctx`, dollars({ usd: a.usd, unpriced: a.unpriced })]
    : [a.type, '?', '?m', '? ctx', '?']));
  const widths = [0, 1, 2, 3, 4].map(i => Math.max(...cols.map(c => cells(c[i]))));
  return cols.map((c, n) => `${n === 0 ? 'running' : '       '}  ${c.map((cell, i) => (i < 2 ? padEnd(cell, widths[i]) : padStart(cell, widths[i]))).join('  ')}`.trimEnd());
}

function conductorLine(conductor) {
  const safe = `safe point at ${tokensK(SAFE_POINT)}`;
  if (conductor === null || !isCount(conductor.tokens)) return `conductor context unknown · ${safe}`;
  const percent = isNumber(conductor.percent) ? `${conductor.percent}%` : '?';
  return `conductor  ${tokensK(conductor.tokens)} of ${windowText(conductor.window)} (${percent}) · ${safe}`;
}

function costLine(data) {
  const parts = [];
  if (data.costs !== null) parts.push(`ledger ${typeof data.costs.error === 'string' ? '?' : dollars(data.costs.total)}`);
  parts.push(`session ${dollars(data.session)}`, `/cost ${dollars(data.slashCost)} (${delta(data.session, data.slashCost)})`);
  return parts.join(' · ');
}

// The pane's lines, each `{ text, dim }` and at most `width` cells: the ledger's header, the time of the data,
// its integration line and rows (or why there are none), then the running agents, the conductor and the costs, and
// once a clear ran, the clears and the run's total.
export function paneLines(data, width) {
  const out = [];
  const line = (text, dim = false) => out.push({ text: fit(text, width), dim });
  const view = data.view, asOf = `as of ${clock(data.at, data.tzOffset)}`;
  if (typeof view.error === 'string') {
    line(`ledger view unavailable — ${view.error}`);
    line(asOf);
  } else if (view.ledger === null) {
    line(`no active ledger in ${data.root ?? '?'}`);
    line(asOf);
    if (view.incomplete) line(INCOMPLETE);
  } else {
    const ledger = view.ledger;
    line(headerLine(ledger));
    line(asOf);
    if (view.more > 0) line(`and ${plural(view.more, 'more ledger')}`);
    if (view.incomplete) line(INCOMPLETE);
    line(integrationLine(ledger.integration));
    if (typeof ledger.warning === 'string') line(`discovery: ${ledger.warning}`, true);
    line('');
    if (typeof ledger.error === 'string') line(ledger.error);
    else out.push(...rowLines(ledger.rows, data.costs, width));
  }
  line('');
  for (const text of agentLines(data.agents, data.at)) line(text);
  line(conductorLine(data.conductor));
  line(costLine(data));
  if (Array.isArray(data.clears) && data.clears.length > 0) {
    line(`clears ${data.clears.map(c => `${clock(c.at, c.tzOffset).slice(0, 5)} at ${tokensK(c.tokens)}`).join(' · ')}`);
  }
  if (isObject(data.runTotal)) line(`run ${dollars(data.runTotal)} over ${plural(data.runTotal.conversations, 'conversation')}`);
  return out;
}

// The pane's lines as plain text, uncut.
export const textReport = data => paneLines(data, Infinity).map(l => l.text).join('\n');

// The band's one line, at most `width` cells: the tagged ledger's short id, its current wave, the most recently
// started running agent as `<Bnn> R<k> <role>`, the conductor's context, the ledger's dollars and `/ledger`,
// joined by ` · `; a segment whose data is unknown is left out. The clear's countdown or notice leads, so a narrow
// band keeps it.
export function bandLine(data, width) {
  const parts = [...(typeof data.clearBand === 'string' ? [data.clearBand] : []), shortId(data.tag)];
  const view = data.view, ledger = view && isObject(view.ledger) && view.ledger.id === data.tag ? view.ledger : null;
  if (ledger !== null && isCount(ledger.currentWave)) parts.push(`W${ledger.currentWave}`);
  const known = Array.isArray(data.agents) ? data.agents.filter(a => a.known && isNumber(a.firstSeen)) : [];
  const agent = known.length ? known.reduce((a, b) => (b.firstSeen >= a.firstSeen ? b : a)) : null;
  if (agent !== null) {
    const row = ledger !== null && agent.batch ? ledger.rows.find(r => r.id === agent.batch) : undefined;
    const round = row && typeof row.round === 'string' ? row.round.split(' ')[0] : null;
    parts.push([agent.batch, round, agent.role].filter(Boolean).join(' '));
  }
  const c = data.conductor;
  if (c !== null && isCount(c.tokens) && isCount(c.window)) parts.push(`ctx ${tokensK(c.tokens)}/${windowText(c.window)}`);
  if (data.costs !== null && data.costs.ledger === data.tag && isTotal(data.costs.total)) parts.push(dollars(data.costs.total));
  parts.push('/ledger');
  return fit(parts.join(' · '), width);
}
