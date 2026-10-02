#!/usr/bin/env node
// Prints one line per ledger (`discovery`), or the protocol.md §Recovery row each PROGRESS row
// matches (`rows`). Read-only: every git probe is a query through orchestrate/tools/git-evidence.mjs.
// The table is read from this skill copy at run time and checked against the 26 rules below, so
// its Verdict words are protocol.md's and a table edit stops this tool until the rules follow it.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { git, ancestryCaptured, shipment, worktrees, readBlob, discovery, parseFlags, validId, validFullRef, isMain } from './git-evidence.mjs';
import { table, branchCell, gitModel } from './ledger-parse.mjs';
import { oneLine } from './check-ledger.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// The skill copy this tool ships in, as orchestrate/tools/prompt.mjs `DEFAULT_SKELETONS` reads its own.
const PROTOCOL = path.join(HERE, '..', 'references', 'protocol.md');
export const TABLE_DRIFT = "UNKNOWN protocol.md §Recovery table does not match reconcile's rules";

const HELP = [
  'reconcile.mjs discovery --repo <repo>',
  '  One line per ledger id: `<id> State=<value> at <locations> → <mode>`, mode continue (ACTIVE), close (AT-CHECKPOINT C<n>),',
  '  status (USER-BLOCKED, or no State line) or none (COMPLETE). Copies of one id that disagree on State print',
  "  `→ AMBIGUOUS (State differs: <location>=<value>, …)`: apply SKILL.md §Discovery's provenance rules to",
  "  git-evidence.mjs discovery --repo <repo>. An id whose .agents/archive/<id>/ a ref's commit or a checkout holds is",
  "  looked up at the shipment target its copies' contracts record, `local <ref>` or `remote <name> <ref>` (a remote is",
  "  asked now, never fetched). Archived there, with every copy's last ledger-changing commit an ancestor of the latest",
  "  commit to add that archive's PROGRESS.md there (a checkout's copy through its branch's copy at its HEAD, while no",
  '  uncommitted change touches .agents/changes/<id>/) and no .agents/changes/<id>/PROGRESS.md there, it prints',
  '  `<id> State=archived at <target> → none (older copies: <location>=<value>, …)`; not archived there, it prints as above.',
  '  A copy not proven older, a target unread, differing, unresolved or also holding the ledger, or an archive in a',
  '  checkout its HEAD commit lacks prints `<id> at <locations> → AMBIGUOUS (archived at <where>; <what>)`.',
  '  Evidence that is not complete, or an archive listing this tool cannot read, opens with an INCOMPLETE line.',
  'reconcile.mjs rows --repo <repo> --ledger <id> --integration <full-ref>',
  '  Reads .agents/changes/<id>/ at the integration tip (its contract must name that integration branch) and matches',
  '  every PROGRESS row not ✅, 👤 or ⛔ (dropped) against protocol.md §Recovery, first match winning: a RECONCILE',
  '  header, then `<Bnn> <status> row <k>: <Verdict>` with the Verdict read from protocol.md, or',
  '  `<Bnn> <status> UNKNOWN <fact>: <why>` where a fact that match needs cannot be read, then a PRUNE line naming',
  '  worktrees of integrated batches. It runs no validation: a Verdict that turns on validations prints as the table',
  '  words it. Shipment is resolved only when a 🧪 row is reconciled; otherwise the header reads shipment=not-needed.',
  "Read-only; every filesystem path prints in the platform's native spelling. Exit 0: every line known; 2: any UNKNOWN,",
  '  AMBIGUOUS or INCOMPLETE line, or an invalid invocation.',
].join('\n');

// A fact a rule needs and could not read; `fact` names it on the printed line.
class Unknown extends Error { constructor(fact, why) { super(`${fact}: ${why}`); this.fact = fact; this.why = why; } }

// ===== Statuses: the legend of orchestrate/references/protocol.md §Status legend ==========
const KINDS = { '⬜': 'notStarted', '🔄': 'progress', '🟢': 'integrated', '🧪': 'checkpoint', '❌': 'failed', '✅': 'passed', '👤': 'userAction', '⛔': 'blocked' };
const LABELS = { notStarted: 'Not Started', progress: 'In Progress', integrated: 'Integrated', checkpoint: 'At Checkpoint', failed: 'Smoke Failed', passed: 'Passed', userAction: 'User Action' };
const SKIPPED = ['passed', 'userAction', 'dropped'];
// A status cell's kind, or null for a cell in no legend form. `⛔` takes any qualifier (either kind).
export function statusKind(cell) {
  const text = cell.trim();
  if (text === '⛔ (dropped)') return 'dropped';
  if (text === '❌ (fix-up capped)') return 'fixupCapped';
  const [head, ...rest] = [...text];
  const kind = KINDS[head], tail = rest.join('');
  if (!kind) return null;
  if (kind === 'blocked') return tail === '' || /^ \S/.test(tail) ? kind : null;
  return tail === '' || tail === ' ' + LABELS[kind] ? kind : null;
}

// ===== Notes markers: the forms protocol.md tells the orchestrator to write ================
// Each marker family is counted twice, loosely and in its recorded form; any difference is a
// marker this reader cannot read, so the row's Notes are UNKNOWN rather than silently skipped.
const SHA = '`?@`?([0-9a-f]{7,64})`?(?![\\w-])';
const BRANCH = '`?([^\\s`@,;()]+)`?';
const FAMILIES = {
  round: [/\bR\d+ (?:SHIP|FIX FIRST|NEEDS A CLOSER LOOK)\b/g,
    new RegExp('\\bR(\\d+) (SHIP|FIX FIRST|NEEDS A CLOSER LOOK)(?: ' + SHA + ')?(?: asks=(\\d+)(?![\\w-]))?(?! @| `@| asks=)', 'g')],
  spent: [/\bverdict \d{4}-\d{2}-\d{2}\b/g, /\bverdict (\d{4}-\d{2}-\d{2}) (fix again|ship|drop) spent\b/g],
  third: [/\bthird round on\b/g, new RegExp('\\bthird round on ' + BRANCH + ' ' + SHA, 'g')],
  capped: [/\bcapped:/g, new RegExp('\\b(?:tip repair|pre-smoke repair|fix-up) capped: (?:step \\d+, )?' + BRANCH, 'g')],
  pending: [/\brepair pending:/g, new RegExp('\\b(tip|pre-smoke) repair pending: (?:step (\\d+), )?' + BRANCH + ' ' + SHA, 'g')],
  discarded: [/\bpolish discarded:/g, new RegExp('\\bpolish discarded: ' + SHA, 'g')],
  fixup: [/\bfix-up pending:/g, /\bfix-up pending: `?(fix\/[^\s`,;()]+-c\d+-followup(?:-\d+)?)`?(?![\w/-])/g],
  deferred: [/\bdeferred to W/g, /\bdeferred to W(\d+): (.+?) \(`?([^()`\s]+)`?\)/g],
};
// The markers a PROGRESS Notes cell carries, and the readings the table's Ledger-says cells key on.
export function readNotes(text) {
  const flat = text.replace(/\s+/g, ' '), found = {};
  for (const [family, [loose, strict]] of Object.entries(FAMILIES)) {
    found[family] = [...flat.matchAll(strict)];
    if ([...flat.matchAll(loose)].length !== found[family].length) throw new Unknown('notes', `a ${family} marker is not in its recorded form`);
  }
  for (const m of found.pending) if ((m[1] === 'tip') !== (m[2] === undefined)) throw new Unknown('notes', 'a repair pending marker names its step wrongly');
  const rounds = found.round.map(m => ({ k: Number(m[1]), verdict: m[2], sha: m[3] ?? null, asks: m[4] === undefined ? null : Number(m[4]), index: m.index }));
  const spent = found.spent.map(m => ({ date: m[1], verdict: m[2], index: m.index }));
  const at = list => list.map(m => m.index);
  // "Notes end in": the latest of the keyed markers, never the literal end of the cell.
  const events = [...rounds.map(r => ({ kind: 'round', index: r.index })), ...spent.map(s => ({ kind: 'spent', verdict: s.verdict, index: s.index })),
    ...['capped', 'pending', 'discarded', 'fixup'].flatMap(k => at(found[k]).map(index => ({ kind: k, index })))].sort((a, b) => a.index - b.index);
  const last = events[events.length - 1], lastSpent = spent.length ? spent[spent.length - 1].index : -1;
  let third = null;
  if (last?.kind === 'spent' && last.verdict === 'fix again') {
    const line = found.third.filter(m => m.index > last.index).pop();
    if (!line) throw new Unknown('notes', 'a spent fix again names no third round');
    third = { branch: line[1], sha: line[2] };
  }
  return {
    rounds, spent, third, endsInSpentFixAgain: third !== null,
    cappedAwaiting: at(found.capped).some(i => i > lastSpent),
    repairPending: at(found.pending).some(i => !spent.some(s => s.index > i && s.verdict !== 'fix again')),
    polishDiscarded: found.discarded.length ? found.discarded[found.discarded.length - 1][1] : null,
    latestRound: rounds.length ? rounds[rounds.length - 1] : null,
    fixupBranch: found.fixup.length ? found.fixup[found.fixup.length - 1][1] : null,
    deferred: found.deferred.map(m => m[2]),
  };
}

// ===== The batch file's checklist, in the grammar orchestrate/tools/check-fence.mjs `validateBatchEdit` enforces
export function readChecklist(text, deferred = []) {
  const lines = text.replace(/\r\n/g, '\n').split('\n'), start = lines.indexOf('## Checklist');
  if (start < 0 || lines.filter(l => l === '## Checklist').length !== 1) throw new Unknown('checklist', 'the batch file has no single Checklist section');
  const items = [];
  let comment = false;
  for (let i = start + 1; i < lines.length && !/^## /.test(lines[i]); i++) {
    const line = lines[i];
    if (comment || line.startsWith('<!--')) { comment = !line.includes('-->'); continue; }
    const m = /^- \[([ x])\] (\S.*)$/.exec(line);
    if (m) { items.push({ ticked: m[1] === 'x', text: m[2], polish: m[2].startsWith('polish: ') }); continue; }
    if (/^\s*[-*+]\s*\[[^\]]*\]/.test(line)) throw new Unknown('checklist', `line ${i + 1} is a checkbox in no accepted form`);
    if (/^ +\S/.test(line) && items.length) items[items.length - 1].text += ' ' + line.trim();
  }
  if (!items.length) throw new Unknown('checklist', 'the Checklist section holds no item');
  // A recorded deferral is not a partial checklist: its unticked item counts as settled.
  const open = items.filter(it => !it.ticked && !deferred.some(d => it.text.includes(d)));
  const polish = items.filter(it => it.polish);
  return { items: items.length, ticked: items.filter(it => it.ticked).length, complete: open.length === 0,
    polish: polish.length, polishTicked: polish.filter(it => it.ticked).length };
}

// ===== The 26 rules, in table order ========================================================
// Each is signed by patterns its row's "Ledger says" and "Git shows" cells must match, and holds
// the two predicates over a facts object. A predicate reads a fact through `need`, which throws
// when that fact is unknown, so a rule decides on known facts or the row is UNKNOWN.
const need = (f, key) => {
  if (Object.hasOwn(f.unknown ?? {}, key)) throw new Unknown(key, f.unknown[key]);
  if (f[key] === undefined) throw new Unknown(key, 'not gathered');
  return f[key];
};
const is = (...kinds) => f => kinds.includes(need(f, 'status'));
const notes = f => need(f, 'notes');
const any = () => true;
const round = (f, verdict, asks) => { const r = notes(f).latestRound; return r?.verdict === verdict && (asks === undefined || (r.asks !== null) === asks); };
const clean = f => need(f, 'dirty') === false;
const polishDone = f => { const c = need(f, 'checklist'); return c.polish > 0 && c.polishTicked === c.polish; };
const fixup = f => need(f, 'fixup');
const R = (says, shows, claim, gitShows, pair) => ({ says, shows, claim, git: gitShows, pair });
export const RULES = [
  R(/^any row whose Notes end in a spent \*fix again\* \(`third round on <branch> @<sha>`\)$/, /^no commit after `@<sha>`, branch not yet an ancestor of the integration branch$/,
    f => notes(f).endsInSpentFixAgain, f => need(f, 'third').after === false && need(f, 'third').integrated === false),
  R(/^any row whose Notes end in a spent \*fix again\*$/, /^commits after `@<sha>`, branch not yet an ancestor of the integration branch$/,
    f => notes(f).endsInSpentFixAgain, f => need(f, 'third').after === true && need(f, 'third').integrated === false),
  R(/^any row whose Notes carry a `… capped:` marker not followed by a later `verdict … spent` \(a marker re-written after a spent line counts as awaiting\)$/, /^any$/, f => notes(f).cappedAwaiting, any),
  R(/^any row whose Notes carry a `… repair pending:` marker \(`tip repair pending:` \/ `pre-smoke repair pending:`\) with no later spent \*ship\* \/ \*drop\* verdict \(those retire it unmerged\)$/, /^any$/,
    f => notes(f).repairPending, any),
  R(/^🔄, Notes carry `polish discarded: @<sha>`$/, /^branch not an ancestor of the integration branch$/,
    f => is('progress')(f) && notes(f).polishDiscarded !== null, f => need(f, 'integrated') === false),
  R(/^🔄$/, /^Notes record `R<k> SHIP @<sha>` \(no `asks=` on that line\) for the current tip$/,
    is('progress'), f => round(f, 'SHIP', false) && need(f, 'round').tipIs),
  R(/^🔄$/, /^Notes record `R<k> SHIP @<sha> asks=<n>` for the current tip, worktree clean$/,
    is('progress'), f => round(f, 'SHIP', true) && need(f, 'round').tipIs && clean(f)),
  R(/^🔄$/, /^Notes record `R<k> SHIP @<sha> asks=<n>`, commits after `@<sha>`, worktree clean, every `polish:` item ticked \(at least one appended\)$/,
    is('progress'), f => round(f, 'SHIP', true) && need(f, 'round').after && clean(f) && polishDone(f)),
  R(/^🔄$/, /^Notes end in `R<k> FIX FIRST @<sha>` for the current tip$/, is('progress'), f => round(f, 'FIX FIRST') && need(f, 'round').tipIs),
  R(/^🔄$/, /^branch missing, or no commits past the wave base$/, is('progress'), f => !need(f, 'branchExists') || need(f, 'onFirstParent')),
  R(/^🔄$/, /^dirty worktree, or commits ahead \+ partial checklist \(incl\. unticked `polish:` items; a recorded deferral is not a partial checklist\)$/,
    is('progress'), f => need(f, 'dirty') || (need(f, 'ahead') > 0 && !need(f, 'checklist').complete)),
  R(/^🔄$/, /^commits ahead, checklist fully ticked$/, is('progress'), f => need(f, 'ahead') > 0 && need(f, 'checklist').complete),
  R(/^🔄$/, /^branch already an ancestor of the integration branch$/, is('progress'), f => need(f, 'integrated') === true),
  R(/^🟢 \(every member of a checkpoint-carrying wave is 🟢, ⛔ or 👤 — verdict or not\)$/, /^checkpoint row not 🧪\/✅$/,
    f => is('integrated')(f) && need(f, 'wave').carrying && need(f, 'wave').settled, f => !['🧪', '✅'].includes(need(f, 'wave').checkpoint)),
  R(/^🟢$/, /^branch NOT an ancestor of the integration branch$/, is('integrated'), f => need(f, 'integrated') === false),
  R(/^🟢$/, /^branch ancestor of the integration branch$/, is('integrated'), f => need(f, 'integrated') === true),
  R(/^🧪$/, /^shipment check confirms integration tip contained in the recorded shipment target$/, is('checkpoint'), f => need(f, 'shipment') === 'contained'),
  R(/^🧪$/, /^shipment unknown or target ambiguous$/, is('checkpoint'), f => need(f, 'shipment') === 'unknown'),
  R(/^🧪$/, /^shipment check confirms integration tip not contained$/, is('checkpoint'), f => need(f, 'shipment') === 'not-contained'),
  R(/^❌ \(not fix-up capped\)$/, /^no branch named by the latest `fix-up pending:` Notes line$/, is('failed'), f => fixup(f).exists === false),
  // An existing branch that is not an ancestor of the integration tip is ahead of it.
  R(/^❌ \(not fix-up capped\)$/, /^that branch ahead, not integrated$/, is('failed'), f => fixup(f).exists && fixup(f).integrated === false),
  // Rows 22 and 23 turn on a tip validation this tool never runs: unmeasured (null), row 22 prints paired with 23.
  R(/^❌ \(not fix-up capped\)$/, /^that branch integrated, tip green$/, is('failed'), f => fixup(f).exists && fixup(f).integrated === true && need(f, 'tipGreen') !== false, 23),
  R(/^❌ \(not fix-up capped\)$/, /^that branch integrated, tip red$/, is('failed'), f => fixup(f).exists && fixup(f).integrated === true && need(f, 'tipGreen') === false),
  R(/^⛔ \(either kind\) or `❌ \(fix-up capped\)`$/, /^any$/, is('blocked', 'fixupCapped'), any),
  R(/^⬜$/, /^a branch with the batch's planned name already exists$/, is('notStarted'), f => need(f, 'branchExists') === true),
  R(/^⬜$/, /^no such branch$/, is('notStarted'), f => need(f, 'branchExists') === false),
];

const collapse = text => text.replace(/\s+/g, ' ').trim();
// The Verdict cells, in table order, once every row carries its rule's signature; throws otherwise.
export function loadTable(protocolText) {
  let rows;
  try { rows = table(protocolText, ['Ledger says', 'Git shows', 'Verdict']); } catch { throw new Unknown('table', 'unreadable'); }
  if (rows.length !== RULES.length || rows.some((row, i) => !RULES[i].says.test(collapse(row['Ledger says'])) || !RULES[i].shows.test(collapse(row['Git shows'])) || !collapse(row.Verdict)))
    throw new Unknown('table', 'drifted');
  return rows.map(row => collapse(row.Verdict));
}

// The first rule whose two predicates hold: { row } (1-based, with `pair` when a validation this
// tool does not run decides between two rows), or { fact, why } when a needed fact is unknown.
export function matchRow(facts) {
  try {
    for (let i = 0; i < RULES.length; i++) {
      const rule = RULES[i];
      if (!rule.claim(facts) || !rule.git(facts)) continue;
      return rule.pair && facts.tipGreen === null ? { row: i + 1, pair: rule.pair } : { row: i + 1 };
    }
    return { fact: 'rule', why: 'no §Recovery row matches these facts' };
  } catch (e) { if (e instanceof Unknown) return { fact: e.fact, why: e.why }; throw e; }
}

// ===== Facts from git ======================================================================
// A commit SHA, null when git reports the revision absent (exit 1, nothing printed); throws otherwise.
function resolve(repo, rev, options) {
  if (typeof rev !== 'string' || !rev || rev.startsWith('-') || /[\x00-\x20\x7f]/.test(rev)) throw new Unknown('revision', 'not a safe revision');
  const r = git(repo, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${rev}^{commit}`], options);
  if (r.ok && /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(r.text.trim())) return r.text.trim();
  if (r.exit === 1 && r.text === '') return null;
  throw new Unknown('revision', `git could not resolve ${rev}`);
}
function count(repo, range, options) {
  const r = git(repo, ['rev-list', '--count', range], options);
  if (!r.ok || !/^\d+\s*$/.test(r.text)) throw new Unknown('commits', `git could not count ${range}`);
  return Number(r.text.trim());
}
function contains(repo, ancestor, descendant, options) {
  const result = ancestryCaptured(repo, ancestor, descendant, [], options);
  if (result === 'unknown') throw new Unknown('ancestry', 'git could not test ancestry');
  return result === 'contained';
}
// A marker's `@<sha>` against the branch tip: is it the tip, and are there commits after it.
function againstTip(ctx, sha, tip) {
  if (tip === null) return { tipIs: false, after: false };
  const full = resolve(ctx.repo, sha, ctx.options);
  if (full === null) throw new Unknown('marker', `@${sha} is not a commit here`);
  if (!contains(ctx.repo, full, tip, ctx.options)) throw new Unknown('marker', `@${sha} is not on the branch`);
  return { tipIs: full === tip, after: count(ctx.repo, `${full}..${tip}`, ctx.options) > 0 };
}
// Is a commit on the integration branch's first-parent history? With --no-ff merges a merged
// batch's own commits never are, so a branch tip there was cut from an integration tip and never advanced.
function onHistory(ctx, sha) {
  if (!ctx.firstParent) {
    const r = git(ctx.repo, ['rev-list', '--first-parent', ctx.tip], ctx.options);
    if (!r.ok) throw new Unknown('wave base', 'git could not list the integration history');
    ctx.firstParent = new Set(r.text.split('\n').filter(Boolean));
  }
  return ctx.firstParent.has(sha);
}
// A branch named in the Notes (a third round's, a fix-up's): its tip, or null when it does not exist.
function namedBranch(ctx, fact, name) {
  if (!validFullRef(`refs/heads/${name}`)) throw new Unknown(fact, `${name} is not a branch name`);
  return resolve(ctx.repo, `refs/heads/${name}`, ctx.options);
}
const waveOf = cell => { const m = /^(?:W|Wave ?)?(\d+)$/i.exec(cell.trim()); if (!m) throw new Unknown('wave', `wave cell ${cell} is in no accepted form`); return Number(m[1]); };

function rowFacts(ctx, row, kind) {
  const f = { status: kind, unknown: {}, tipGreen: null };
  const fact = (key, fn) => { try { f[key] = fn(); } catch (e) { if (!(e instanceof Unknown)) throw e; f.unknown[key] = e.why; } };
  fact('notes', () => readNotes(row.Notes));
  let name = null, tip = null;
  fact('branchExists', () => {
    try { name = branchCell(row.Branch); } catch { throw new Unknown('branch', 'the Branch cell is in no accepted form'); }
    if (!validFullRef(`refs/heads/${name}`)) throw new Unknown('branch', `${name} is not a branch name`);
    tip = resolve(ctx.repo, `refs/heads/${name}`, ctx.options);
    return tip !== null;
  });
  const exists = !Object.hasOwn(f.unknown, 'branchExists');
  const onBranch = (key, fn) => fact(key, () => { if (!exists) throw new Unknown('branch', f.unknown.branchExists); return fn(); });
  onBranch('integrated', () => { if (tip === null) throw new Unknown('branch', 'missing'); return contains(ctx.repo, tip, ctx.tip, ctx.options); });
  onBranch('ahead', () => tip === null ? 0 : count(ctx.repo, `${ctx.tip}..${tip}`, ctx.options));
  onBranch('checklist', () => {
    if (tip === null) throw new Unknown('branch', 'missing');
    const file = ctx.batchFiles.get(row['#']);
    if (!file) throw new Unknown('checklist', 'no single batch file for this row at the integration tip');
    const text = readBlob(ctx.repo, tip, file, [], ctx.options);
    if (text === null) throw new Unknown('checklist', `${file} cannot be read at the branch tip`);
    return readChecklist(text, f.notes?.deferred ?? []);
  });
  // "No commits past the wave base": the tip lies on the integration branch's first-parent
  // history, cut from an integration tip and never advanced; a ticked item there contradicts it.
  onBranch('onFirstParent', () => {
    if (tip === null) return false;
    if (!onHistory(ctx, tip)) return false;
    if (Object.hasOwn(f.unknown, 'checklist')) throw new Unknown('wave base', f.unknown.checklist);
    if (f.checklist.ticked > 0) throw new Unknown('wave base', 'the tip lies on the integration history yet its checklist has a ticked item');
    return true;
  });
  onBranch('dirty', () => {
    if (ctx.worktreesUnknown) throw new Unknown('dirty', ctx.worktreesUnknown);
    const trees = ctx.worktrees.filter(w => !w.bare && (w.path === ctx.mainCheckout || w.branch === `refs/heads/${name}`));
    if (trees.some(w => w.cleanliness === 'unknown')) throw new Unknown('dirty', 'a worktree status cannot be read');
    return trees.some(w => w.cleanliness === 'dirty');
  });
  const latest = f.notes?.latestRound;
  onBranch('round', () => {
    if (!latest || latest.verdict === 'NEEDS A CLOSER LOOK') return { tipIs: false, after: false };
    if (latest.sha === null) throw new Unknown('round', `R${latest.k} ${latest.verdict} records no @<sha>`);
    return againstTip(ctx, latest.sha, tip);
  });
  // Rows 1-2 read the branch the third-round line names (a batch, repair or fix-up branch), never the row's own.
  fact('third', () => {
    const third = f.notes?.third;
    if (!third) return { tipIs: false, after: false, integrated: false };
    const at = namedBranch(ctx, 'third round', third.branch);
    if (at === null) throw new Unknown('third round', `${third.branch} does not exist`);
    return { ...againstTip(ctx, third.sha, at), integrated: contains(ctx.repo, at, ctx.tip, ctx.options) };
  });
  fact('wave', () => {
    const wave = waveOf(row.Wave), carrying = ctx.checkpoints.filter(c => c.wave === wave);
    if (carrying.length > 1) throw new Unknown('wave', `more than one checkpoint follows wave ${wave}`);
    if (!carrying.length) return { carrying: false, settled: false, checkpoint: null };
    const members = ctx.rows.filter(r => waveOf(r.Wave) === wave).map(r => statusKind(r.Status));
    if (members.includes(null)) throw new Unknown('wave', 'a member status is in no legend form');
    return { carrying: true, settled: members.every(k => ['integrated', 'blocked', 'dropped', 'userAction'].includes(k)), checkpoint: carrying[0].status };
  });
  fact('shipment', () => { if (ctx.shipment === null) throw new Unknown('shipment', 'not resolved'); return ctx.shipment; });
  fact('fixup', () => {
    const branch = f.notes?.fixupBranch;
    if (f.notes === undefined) throw new Unknown('notes', f.unknown.notes);
    if (!branch) throw new Unknown('fix-up pending', 'no fix-up pending: line names a branch');
    const sha = namedBranch(ctx, 'fix-up pending', branch);
    if (sha === null) return { exists: false, integrated: false };
    // A fix-up cut from the integration tip and never committed to is an ancestor too, never a merged fix.
    if (onHistory(ctx, sha)) throw new Unknown('fix-up pending', `${branch} lies on the integration history: cut, never advanced`);
    return { exists: true, integrated: contains(ctx.repo, sha, ctx.tip, ctx.options) };
  });
  // Worktrees to prune: a reviewed and merged batch's (🟢, 🧪), never an unadvanced branch's.
  const merged = ['integrated', 'checkpoint'].includes(kind) && f.integrated === true;
  return { facts: f, integratedWorktrees: merged ? ctx.worktrees.filter(w => !w.bare && w.path !== ctx.mainCheckout && w.branch === `refs/heads/${name}`).map(w => spelled(w.path)) : [] };
}

// The shipment target a contract's Git model records, its source reduced by its leading words to `local` or
// `remote <name>`; null for a source in any other form, or a label given twice. `rows` and `discovery` both read it.
function targetOf(model) {
  let raw, ref;
  try { raw = model.shipmentSource; ref = model.shipmentRef; } catch { return null; }
  const local = /^local(?:\s|$)/.test(raw ?? ''), remote = /^remote ([A-Za-z0-9][A-Za-z0-9._/-]*)(?=\s|$)/.exec(raw ?? '');
  if (!local && !remote) return null;
  return local ? { source: 'local', ref } : { source: 'remote', remote: remote[1], ref };
}
// Shipment for the contract's target; a target in no form read here leaves shipment unknown.
function shipmentOf(ctx, model) {
  const target = targetOf(model);
  return target ? shipment({ repo: ctx.repo, integration: ctx.integration, ...target, ...ctx.options }).evidence.result : 'unknown';
}
const real = p => { try { return fs.realpathSync(p); } catch { return null; } };
const shortRef = ref => ref.replace(/^refs\/heads\//, '').replace(/^refs\/remotes\//, '');
// Every filesystem path this tool prints, in one spelling: Node's native form of it (`C:\…` where
// Git for Windows lists a worktree as `C:/…`), so a PRUNE path and a discovery location read alike.
const spelled = p => path.normalize(p);
// A copy's place on a discovery line: a ref by its short name, a checkout's ledger by its path.
const placeOf = l => l.kind === 'ref' ? shortRef(l.ref) : spelled(l.path);

// `env` (optional) is the environment every git probe runs under, as orchestrate/tools/git-evidence.mjs `git` takes it.
// `listWorktrees` is a test seam for orchestrate/tools/git-evidence.mjs `worktrees`, so a test can reach the
// unlistable-worktrees refusal; the CLI never sets it, and an empty listing can only make dirt UNKNOWN.
export function reconcileRows({ repo, ledger, integration, protocolText, env, listWorktrees = worktrees }) {
  const out = lines => ({ code: lines.some(l => / UNKNOWN |^UNKNOWN /.test(l)) ? 2 : 0, lines: lines.map(oneLine) });
  let verdicts;
  try { verdicts = loadTable(protocolText); } catch (e) { if (e instanceof Unknown) return { code: 2, lines: [TABLE_DRIFT] }; throw e; }
  if (!validId(ledger) || !validFullRef(integration) || !integration.startsWith('refs/heads/')) return { code: 2, lines: ['UNKNOWN usage: a simple ledger id and a full refs/heads/ integration ref are required'] };
  const ctx = { repo, integration, firstParent: null, options: env ? { env } : {} };
  try {
    ctx.tip = resolve(repo, integration, ctx.options);
    if (ctx.tip === null) throw new Unknown('integration', `${integration} does not exist`);
    const dir = `.agents/changes/${ledger}`, read = file => {
      const text = readBlob(repo, ctx.tip, `${dir}/${file}`, [], ctx.options);
      if (text === null) throw new Unknown('ledger', `${dir}/${file} cannot be read at the integration tip`);
      return text;
    };
    const model = gitModel(read('00-READBEFORE.md'));
    let named;
    try { named = model.integration; } catch { named = null; }
    if (!named || named.replace(/^refs\/heads\//, '') !== shortRef(integration)) throw new Unknown('contract', `its integration branch is ${named ?? 'not recorded'}, not ${shortRef(integration)}`);
    const progress = read('PROGRESS.md');
    try {
      ctx.rows = table(progress, ['#', 'Branch', 'Wave', 'Status', 'Notes']);
      ctx.checkpoints = table(progress, ['Checkpoint', 'After wave', 'Status']).map(c => ({ wave: waveOf(c['After wave']), status: [...c.Status.trim()][0] ?? '' }));
    } catch (e) { throw e instanceof Unknown ? e : new Unknown('PROGRESS', e.message); }
    const listing = git(repo, ['ls-tree', '-z', '--name-only', ctx.tip, '--', `${dir}/`], ctx.options);
    if (!listing.ok) throw new Unknown('ledger', 'git could not list the ledger directory');
    ctx.batchFiles = new Map();
    const names = listing.text.split('\0').filter(Boolean).map(p => p.slice(dir.length + 1));
    for (const row of ctx.rows) {
      const digits = /^B?(\d+)$/.exec(row['#'])?.[1], files = digits ? names.filter(n => n.startsWith(`02-batches-${digits}-`) && n.endsWith('.md')) : [];
      if (files.length === 1) ctx.batchFiles.set(row['#'], `${dir}/${files[0]}`);
    }
    const trees = listWorktrees({ repo, ...ctx.options });
    ctx.worktrees = trees.evidence.worktrees;
    ctx.worktreesUnknown = ctx.worktrees.length ? null : 'git could not list the worktrees';
    const common = git(repo, ['rev-parse', '--path-format=absolute', '--git-common-dir'], ctx.options);
    const commonDir = common.ok ? common.text.trim() : null;
    // The main checkout: the worktree holding the common .git directory; its dirt counts for every row.
    const mainDir = commonDir && path.basename(commonDir) === '.git' ? real(path.dirname(commonDir)) : null;
    ctx.mainCheckout = mainDir ? ctx.worktrees.find(w => !w.bare && real(w.path) === mainDir)?.path ?? null : null;
    const reconciled = ctx.rows.map(row => ({ row, kind: statusKind(row.Status) })).filter(r => !SKIPPED.includes(r.kind));
    ctx.shipment = reconciled.some(r => r.kind === 'checkpoint') ? shipmentOf(ctx, model) : null;
    const lines = [`RECONCILE ${ledger} @${ctx.tip.slice(0, 7)} shipment=${ctx.shipment ?? 'not-needed'}`], prune = [];
    for (const { row, kind } of reconciled) {
      const label = `${row['#']} ${collapse(row.Status)}`;
      if (kind === null) { lines.push(`${label} UNKNOWN status: the Status cell is in no legend form`); continue; }
      const { facts, integratedWorktrees } = rowFacts(ctx, row, kind), match = matchRow(facts);
      prune.push(...integratedWorktrees);
      if (match.fact) lines.push(`${label} UNKNOWN ${match.fact}: ${match.why}`);
      else if (match.pair) lines.push(`${label} row ${match.row} or ${match.pair}: tip green → ${verdicts[match.row - 1]} | tip red → ${verdicts[match.pair - 1]}`);
      else lines.push(`${label} row ${match.row}: ${verdicts[match.row - 1]}`);
    }
    if (prune.length) lines.push(`PRUNE ${[...new Set(prune)].join(', ')}`);
    return out(lines);
  } catch (e) {
    if (e instanceof Unknown) return { code: 2, lines: [oneLine(`UNKNOWN ${e.fact}: ${e.why}`)] };
    return { code: 2, lines: [oneLine(`UNKNOWN ${e.message}`)] };
  }
}

// ===== discovery: one line per ledger id ==================================================
const MODES = [[/^ACTIVE$/, 'continue'], [/^AT-CHECKPOINT C\d+$/, 'close'], [/^USER-BLOCKED$/, 'status'], [/^none$/, 'status'], [/^COMPLETE$/, 'none']];
// The PROGRESS preamble's one `**State**:` value; `none` for a legacy ledger with no State line.
export function stateOf(progressText) {
  if (typeof progressText !== 'string') return 'unreadable';
  const lines = progressText.replace(/\r\n/g, '\n').split('\n'), end = lines.findIndex(l => /^## /.test(l));
  const found = lines.slice(0, end < 0 ? lines.length : end).filter(l => l.startsWith('**State**:'));
  if (found.length > 1) return 'repeated';
  // The value exactly as written after `**State**: `: stray whitespace is no accepted form.
  return found.length ? found[0].slice('**State**: '.length) : 'none';
}
// One `git cat-file --batch-check` run over `<commit>:<path>` names: each one's object type, `missing` for an absent
// path, or null for a name not given, any other answer or a failed run.
function typesAt(repo, names, options) {
  const sent = names.filter(Boolean), r = sent.length ? git(repo, ['cat-file', '--batch-check=%(objecttype)'], { ...options, input: sent.map(n => `${n}\n`).join('') }) : null;
  const lines = r?.ok ? r.text.split('\n').map(l => l.replace(/\r$/, '')) : [], answers = new Map(sent.map((n, i) => [n, lines[i]]));
  return names.map(n => { const answer = answers.get(n); return answer === `${n} missing` ? 'missing' : ['tree', 'blob', 'commit', 'tag'].includes(answer) ? answer : null; });
}
// An archive is a tree: true; a blob or an absent path holds none: false; any other answer (a gitlink) or none: null.
const archiveOf = type => type === 'tree' ? true : type === 'blob' || type === 'missing' ? false : null;
const isDirectory = p => { try { return fs.lstatSync(p).isDirectory(); } catch { return false; } };
// A copy's 00-READBEFORE.md as discovery read it, the contract file `rows` reads.
const contractOf = l => (l.kind === 'ref' ? l.provenance?.contractTexts : l.contractTexts)?.find(c => /(?:^|[\\/])00-READBEFORE\.md$/.test(c.path))?.text;
// The shipment target a copy's contract records; null for no contract, a Git model gitModel refuses, or a target in no form read here.
function targetIn(l) {
  let target = null;
  try { target = targetOf(gitModel(contractOf(l))); } catch { /* no contract text, or no one Git model heading */ }
  return target && validFullRef(target.ref) && target.ref.startsWith('refs/heads/') ? target : null;
}
const named = t => `${t.source === 'local' ? 'local' : `remote ${t.remote}`} ${t.ref}`;
// The target's commit: a local ref resolved here, or the remote's branch asked now, never fetched and never read
// from a remote-tracking ref, then found here as that commit, as orchestrate/tools/git-evidence.mjs `shipment` does.
function targetTip(repo, target, options) {
  if (target.source === 'local') {
    const sha = resolve(repo, target.ref, options);
    if (sha === null) throw new Unknown('target', `${named(target)} does not exist`);
    return sha;
  }
  const r = git(repo, ['ls-remote', '--exit-code', '--refs', '--', target.remote, target.ref], options);
  const records = r.ok ? r.text.split('\n').filter(Boolean).map(x => x.replace(/\r$/, '').split('\t')) : [];
  if (records.length !== 1 || records[0][1] !== target.ref) throw new Unknown('target', `remote ${target.remote} did not answer with ${target.ref} alone`);
  if (resolve(repo, records[0][0], options) !== records[0][0]) throw new Unknown('target', `${named(target)} is at ${records[0][0].slice(0, 7)}, not a commit here`);
  return records[0][0];
}
// Supersession by an archive. orchestrate/SKILL.md §Discovery resolves the owning contract's shipment target and
// inspects only this id there: `.agents/archive/<id>/` there supersedes proven older ledger copies, while unknown
// provenance, newer ledger commits, uncommitted ledger edits and missing target evidence leave them visible. This reads
// it strictly: every copy's own contract must name one target, and a copy is older only when its last ledger-changing
// commit is an ancestor of the commit that introduced that archive at the target, so an archive that predates a copy
// never supersedes it, however often it is touched later; a target that also holds the ledger supersedes nothing. An
// archive on another ref or in a checkout only prompts the lookup, so an id archived nowhere asks no remote; one in a
// checkout its HEAD commit lacks is an uncommitted ledger edit.
function archives(result, options) {
  const { ledgers = [], refs = [], worktrees: trees = [] } = result.evidence, facts = new Map();
  // Where an archive may sit: every ref but a symbolic one (it names another) at its commit, and every checkout
  // whose working tree holds one, at its HEAD commit.
  const asks = [...refs.filter(r => !r.symref).flatMap(r => ledgers.map(({ id }) => ({ id, where: shortRef(r.ref), sha: r.sha }))),
    ...trees.flatMap(wt => ledgers.map(({ id }) => ({ id, where: spelled(path.join(wt.path, '.agents', 'archive', id)), sha: wt.head, checkout: true })).filter(a => isDirectory(a.where)))];
  const held = typesAt(result.repo, asks.map(a => a.sha && `${a.sha}:.agents/archive/${a.id}`), options).map(archiveOf);
  const diagnostics = held.includes(null) ? [{ code: 'archive-unavailable', message: 'A ref or checkout cannot be read for .agents/archive/' }] : [];
  for (const { id, locations } of ledgers) {
    const mine = asks.map((a, i) => ({ ...a, held: held[i] })).filter(a => a.id === id && (a.held || a.checkout)), at = mine.map(a => a.where).join(', ');
    if (!mine.length) continue;
    const unsettled = why => facts.set(id, { at, why });
    const loose = mine.filter(a => a.checkout && !a.held).map(a => a.where);
    if (loose.length) { unsettled(`not proven committed: ${loose.join(', ')}`); continue; }
    const targets = locations.map(l => [l, targetIn(l)]), unread = targets.filter(([, t]) => !t).map(([l]) => placeOf(l));
    if (unread.length) { unsettled(`no shipment target read from ${unread.join(', ')}`); continue; }
    if (new Set(targets.map(([, t]) => named(t))).size > 1) { unsettled(`shipment targets differ: ${targets.map(([l, t]) => `${placeOf(l)}=${named(t)}`).join(', ')}`); continue; }
    const target = targets[0][1];
    let tip;
    try { tip = targetTip(result.repo, target, options); } catch (e) { if (!(e instanceof Unknown)) throw e; unsettled(e.why); continue; }
    const [archive, open] = typesAt(result.repo, [`${tip}:.agents/archive/${id}`, `${tip}:.agents/changes/${id}/PROGRESS.md`], options), archived = archiveOf(archive);
    if (archived === null) { unsettled(`${named(target)} cannot be read for .agents/archive/${id}/`); continue; }
    if (!archived) continue;
    // The commit that introduced the archive at the target: the latest to add its PROGRESS.md, a move counted as an add.
    // --no-follow keeps a configured log.follow from following that move back into .agents/changes/; a failed or
    // empty read leaves every copy unproven.
    const log = git(result.repo, ['log', '-1', '--no-follow', '--no-renames', '--diff-filter=A', '--format=%H', tip, '--', `.agents/archive/${id}/PROGRESS.md`], options);
    const added = log.ok ? log.text.trim() : null;
    const known = new Map(), under = `.agents/changes/${id}/`;
    const untouched = l => l.cleanliness === 'clean' || (l.cleanliness === 'dirty' && !l.status.some(s => [s.path, s.originalPath].some(p => p?.startsWith(under))));
    const proven = l => {
      if (!known.has(l)) {
        const p = l.provenance, twin = l.kind === 'worktree' && locations.find(t => t.kind === 'ref' && t.ref === l.branch && t.sha === l.head);
        known.set(l, l.kind === 'ref' ? p?.lastChangeTree === p?.tree && ancestryCaptured(result.repo, p?.lastChange, added, [], options) === 'contained' : Boolean(twin) && untouched(l) && proven(twin));
      }
      return known.get(l);
    };
    const unproven = locations.filter(l => !proven(l));
    // Every copy older, yet the target still holds a ledger under this id: an archive beside it closed nothing.
    if (!unproven.length && open !== 'missing') { facts.set(id, { at: named(target), why: `${named(target)} also holds .agents/changes/${id}/PROGRESS.md` }); continue; }
    facts.set(id, { at: named(target), unproven });
  }
  return { facts, diagnostics };
}
// One line per ledger id; `options.env` (optional) is the environment the archive probes run under.
export function summarize(result, options = {}) {
  const { facts, diagnostics: probes } = archives(result, options), diagnostics = [...result.diagnostics, ...probes], lines = [];
  let doubt = result.completeness !== 'complete' || probes.length > 0;
  if (doubt) lines.push(`INCOMPLETE ${diagnostics.length} diagnostic(s): ${[...new Set(diagnostics.map(d => d.code))].join(', ')}`);
  const ledgers = result.evidence.ledgers ?? [];
  if (!ledgers.length) lines.push('NO LEDGERS');
  for (const { id, locations } of ledgers) {
    const seen = locations.map(l => ({ where: placeOf(l), state: stateOf(l.kind === 'ref' ? l.provenance?.progressText : l.progressText) }));
    const where = [...new Set(seen.map(s => s.where))].join(', '), states = [...new Set(seen.map(s => s.state))];
    const archive = facts.get(id), listed = among => seen.filter((_, i) => among.includes(locations[i])).map(s => `${s.where}=${s.state}`).join(', ');
    const why = archive?.why ?? (archive?.unproven.length ? `not proven older: ${listed(archive.unproven)}` : null);
    if (why) { doubt = true; lines.push(`${id} at ${where} → AMBIGUOUS (archived at ${archive.at}; ${why})`); continue; }
    if (archive) { lines.push(`${id} State=archived at ${archive.at} → none (older copies: ${listed(locations)})`); continue; }
    if (states.length > 1) { doubt = true; lines.push(`${id} at ${where} → AMBIGUOUS (State differs: ${seen.map(s => `${s.where}=${s.state}`).join(', ')})`); continue; }
    const mode = MODES.find(([re]) => re.test(states[0]))?.[1];
    if (!mode) doubt = true;
    lines.push(`${id} State=${states[0]} at ${where} → ${mode ?? `UNKNOWN (State ${states[0]} is in no accepted form)`}`);
  }
  return { code: doubt ? 2 : 0, lines: lines.map(oneLine) };
}

export function reconcileCli(args, protocolFile = PROTOCOL) {
  if (args.length === 1 && args[0] === '--help') return { code: 0, lines: [HELP] };
  const [operation, ...rest] = args;
  let options;
  try {
    if (operation === 'discovery') options = parseFlags(rest, ['repo'], ['repo']);
    else if (operation === 'rows') options = parseFlags(rest, ['repo', 'ledger', 'integration'], ['repo', 'ledger', 'integration']);
    else throw new Error();
  } catch { return { code: 2, lines: ['UNKNOWN usage: unknown operation, or an unknown, missing or duplicate flag; use --help'] }; }
  if (operation === 'discovery') return summarize(discovery({ repo: options.repo }));
  let protocolText;
  try { protocolText = fs.readFileSync(protocolFile, 'utf8'); } catch { return { code: 2, lines: [TABLE_DRIFT] }; }
  return reconcileRows({ ...options, protocolText });
}

if (isMain(import.meta.url)) {
  const output = reconcileCli(process.argv.slice(2)); process.stdout.write(output.lines.join('\n') + '\n'); process.exitCode = output.code;
}
