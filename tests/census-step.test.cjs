'use strict';
// The per-batch census as a scaffold step, and the triggers that run it again. scaffolding.md step 3 states the
// step; protocol.md names the census role (§Roles), runs it again before a wave's cut (§Session algorithm step 4)
// and on a recorded extension or a user-authorized plan change (§Fence changes), and makes it the orchestrator's own
// pass without sub-agents (§Degraded environments); SKILL.md, execution-models.md and templates/LOG.md name it where
// they summarise those places. Each passage is pinned whole on whitespace-collapsed text, each rule inside one is
// also checked alone, a rule about order is checked in document order, and the skill's Markdown is swept for a
// sentence that undoes a rule. The sweep is closed over what it reads: a census mention outside the pinned passages must
// be a reviewed phrase, and a sentence it reads must lie wholly inside a pinned passage or be a reviewed sentence. It
// reads every sentence of a paragraph or list item that holds a sentence about the census, the blocks indented under
// the item among them, every sentence a family of the sweep selects (each one naming a listing or a diff among them),
// and every one that names a re-run, "again" or "step 4". An undoing no pattern foresaw therefore fails when it names
// the census or one of those words, or sits in such a paragraph or item or in a pinned passage; one that names none of
// them, elsewhere, goes unread. Every rule has a live control that makes it fail, and the CRLF twin of every document
// reaches its LF original's verdict.
// orchestrate/references/subagent-prompts.md, home of the §Census skeleton the step names, is never read here.
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { isDeepStrictEqual } = require('node:util');
const { makeRepo } = require('./support/git-fixture.cjs');

const ROOT = path.resolve(__dirname, '..');
// Every document is read through lf, so a CRLF checkout reads as the LF text each rule below is written against.
const lf = text => text.replace(/\r\n/g, '\n');
const readAt = (root, file) => lf(fs.readFileSync(path.join(root, file), 'utf8'));
const read = file => readAt(ROOT, file);
// The bytes as they lie on disk: only the CRLF twin's live control reads through this.
const rawAt = (root, file) => fs.readFileSync(path.join(root, file), 'utf8');
const crlf = text => text.replace(/\r?\n/g, '\r\n');
const collapse = text => text.replace(/\s+/g, ' ').trim();

const SCAFFOLDING = 'orchestrate/references/scaffolding.md', PROTOCOL = 'orchestrate/references/protocol.md';
const MODELS = 'orchestrate/references/execution-models.md', SKILL = 'orchestrate/SKILL.md';
const LOG = 'orchestrate/templates/LOG.md', SKELETONS = 'orchestrate/references/subagent-prompts.md';
const SMOKE = 'orchestrate/references/smoke-page.md', CONTRACT = 'orchestrate/templates/00-READBEFORE.md', BATCH = 'orchestrate/templates/02-batch.md';
const PROGRESS = 'orchestrate/templates/PROGRESS.md';

// The skill tree as git tracks it, recursively; the rules read its Markdown, SKELETONS left out. A listing that fails
// stops the run rather than leaving an empty domain to sweep.
let tracked;
function trackedSkill() {
  if (!tracked) {
    const r = spawnSync('git', ['-C', ROOT, 'ls-files', '-z', '--', 'orchestrate'], { encoding: 'utf8', windowsHide: true });
    assert.ifError(r.error);
    assert.equal(r.status, 0, 'git ls-files must list the skill tree: ' + r.stderr);
    tracked = r.stdout.split('\0').filter(Boolean).sort();
    assert.ok(tracked.length > 0, 'git ls-files listed no file under orchestrate/');
  }
  return tracked;
}
const domain = () => trackedSkill().filter(file => file.endsWith('.md') && file !== SKELETONS);
const load = (root, reader = readAt) => new Map(domain().map(file => [file, reader(root, file)]));

// The raw text from `from`, which must occur exactly once, up to the first `to` after it (the end when `to` is null),
// or the reason it cannot be read.
function between(text, from, to) {
  const count = text.split(from).length - 1;
  if (count !== 1) return { fault: JSON.stringify(from) + ' occurs ' + count + ' times, not once' };
  const start = text.indexOf(from), end = to === null ? text.length : text.indexOf(to, start + from.length);
  if (end === -1) return { fault: JSON.stringify(to) + ' no longer follows ' + JSON.stringify(from) };
  return { start, raw: text.slice(start, end) };
}

// ===== The passages, pinned whole ==================================================================================
const PINS = [
  { key: 'pin:step3', rule: 'scaffolding.md step 3 states the census', file: SCAFFOLDING,
    from: '**Census** — once the batches are drafted', to: '\n\n4. **Backlog sweep**',
    text: "**Census** — once the batches are drafted, spawn one `census` agent per batch, never one agent for several batches, with the `subagent-prompts.md` §Census skeleton filled with the batch's planned change and the facts it must find. Each report opens with where the draft is wrong or incomplete; before the pre-flight, record every one of those items in LOG.md as carried (the batch-file line that now holds it) or rejected (the reason). Whenever a later planning step — a pre-flight fix, an accepted fold-in or an adjustment at approval — adds a file, a hook or a behaviour to a batch, run the batch's `census` agent again and record its items the same way before the fill." },
  { key: 'pin:roles', rule: 'protocol.md §Roles names the census role', file: PROTOCOL,
    from: '- **Census** (scaffold time', to: '\n- **Tiers**',
    text: '- **Census** (scaffold time, and again on the triggers in §Fence changes and §Session algorithm step 4) — one read-only `census` agent per batch, never one for several batches; see `scaffolding.md` step 3 and `subagent-prompts.md` §Census.' },
  { key: 'pin:step4', rule: 'protocol.md §Session algorithm step 4 runs the census again before the cut', file: PROTOCOL,
    from: 'From the second wave on, before the cut, run the', to: 'From the integration tip: cut every member',
    text: "From the second wave on, before the cut, run the `census` agent again for each member whose fence path a test added or changed by an earlier wave names — the path itself, its basename or a directory holding it — taking the tests among the files `git diff --name-only --no-renames --diff-filter=AM <W1's base, from the session log>..<the integration tip>` lists (a listing that fails counts as a match), and commit the corrections it carries into the member's batch file on the integration branch, each opening item recorded in LOG.md as carried or rejected, so every member branch starts from them. A correction that needs a path outside the member's fence is first recorded as an extension under §Fence changes' test, and one that adds a checklist item or an acceptance criterion needs the user's words, recorded verbatim in PROGRESS. Once a member branch of this wave exists at the integration tip — an open that crashed after its cut began — no census runs again at this open, so the cut below adopts the branches cut from the corrected tip." },
  { key: 'pin:fenceTest', rule: "protocol.md §Fence changes' test, which a census correction outside its fence passes, stays as it reads", file: PROTOCOL,
    from: 'An implementer that needs a path outside its fence', to: '\n\nA recorded extension, or a change to a batch',
    text: "An implementer that needs a path outside its fence does NOT touch it: it finishes every item it can, commits, and reports `NEEDS_FENCE: <paths> — <item> — <why>`. The orchestrator's test is mechanical: the path must be absent from the fence of EVERY same-wave sibling regardless of status (a sibling already `🟢` is the dangerous case — the extension would edit from the wave-base version and no reviewer sees the interaction) and from every extension recorded this wave; ledger, version and changelog files never qualify. Pass → record \"fence +<path> (B<NN>, <item>, <reason>, <date>)\" in the row's Notes and the session log on the integration branch, then resume the implementer, whose only batch-file edit is the Files line on its own branch. Fail → the batch's other items are gated and integrated now; the deferred item is recorded in the row's Notes and the session log as `deferred to W<n+1>: <item> (<path>)` and runs as a continuation of the same batch in the next wave (branch `<batch-branch>-w<n+1>` cut from the tip, fence extended then); a recorded deferral does not hold the wave open. At that wave's open the row flips back to `🔄` with its Branch cell pointing at `<batch-branch>-w<n+1>`; the checkpoint after wave n covers the batch's other items and the deferred item's smoke steps ride the next checkpoint; with no later wave, the continuation is a final wave on its own and the final checkpoint moves to after it — record the move in the checkpoint-table row (After wave) and the session log (the recorded deferral is the authorization to deviate from the map); wave n then closes without a checkpoint; the row returns to `🟢` when the continuation integrates. If two batches need the same region, the question goes in the STOP hand-off. The fence check's allowed set is the plan's fence ∪ recorded extensions ∪ the batch's own file — never the implementer's Files line alone." },
  { key: 'pin:fence', rule: 'protocol.md §Fence changes runs the census again on an extension or an authorized plan change', file: PROTOCOL,
    from: 'A recorded extension, or a change to a batch', to: '\n\n### Complete checkpoint inputs',
    text: "A recorded extension, or a change to a batch's plan the user authorizes (recorded verbatim in PROGRESS, as the locked-map rule requires), that adds a file, a hook or a behaviour runs the batch's `census` agent again before its implementer resumes or starts. Every correction it carries is committed to the batch file's notes on the integration branch — for a running implementer before its resume, which also carries it — and each opening item is recorded in LOG.md as carried or rejected; a correction that needs a path outside the fence passes this section's test first, and one that adds a checklist item or an acceptance criterion needs the user's words, recorded verbatim in PROGRESS." },
  { key: 'pin:degraded', rule: "protocol.md §Degraded environments makes the census the orchestrator's own pass", file: PROTOCOL,
    from: '- **No sub-agents available**', to: '\n- **No agent definitions installed**',
    text: "- **No sub-agents available**: the orchestrator implements a wave's batches one at a time in the main checkout (worktrees unnecessary). The reviewer gate still runs per batch — a separate adversarial pass over each finished diff, with the same hunk-mapping duty, before integration. Checkpoint placement is unchanged. The census is the orchestrator's own pass, one batch at a time, in the same report shape." },
  { key: 'pin:pipeline', rule: "SKILL.md's new-mode pipeline names the per-batch census", file: SKILL,
    from: '→ per-batch census', to: ' → backlog sweep (propose',
    text: '→ per-batch census (one `census` agent per drafted batch; each item its report opens with is recorded in LOG.md as carried or rejected, per scaffolding.md)' },
  { key: 'pin:continue', rule: "SKILL.md's continue flow runs the census again at a wave's open", file: SKILL,
    from: 'open the next wave (', to: ', cut branches + worktrees',
    text: "open the next wave (re-run the `census` agent of any member an earlier wave's tests reach" },
  { key: 'pin:scaffoldingRow', rule: "SKILL.md's skill-files row for scaffolding.md names the census", file: SKILL,
    from: '- [references/scaffolding.md](references/scaffolding.md) —', to: '\n- [references/subagent-prompts.md]',
    text: '- [references/scaffolding.md](references/scaffolding.md) — detection heuristics, interview, census, backlog sweep, pre-flight, placeholder registry, self-check' },
  { key: 'pin:skeletonsRow', rule: "SKILL.md's skill-files row for subagent-prompts.md names the artifact proofer and census skeletons", file: SKILL,
    from: '- [references/subagent-prompts.md](references/subagent-prompts.md) —', to: '\n- [references/smoke-page.md]',
    text: '- [references/subagent-prompts.md](references/subagent-prompts.md) — implementer / reviewer / test hunter / QA runner / artifact proofer / census / pre-flight / convergence / fix-up skeletons' },
  { key: 'pin:waveOpen', rule: "execution-models.md's wave open defers to step 4's census re-run", file: MODELS,
    from: '1. **Open the wave**:', to: ' cut every member batch',
    text: '1. **Open the wave**: from the integration tip — after any `census` agent re-run that `protocol.md` §Session algorithm step 4 calls for —,' },
  { key: 'pin:log', rule: "templates/LOG.md's scaffold comment names the census record", file: LOG,
    from: '<!-- What planning decided and why:', to: '-->',
    text: "<!-- What planning decided and why: each census report's opening items, carried (the batch-file line) or rejected (the reason); pre-flight findings and how each was resolved, backlog fold-ins considered and rejected (with the reason), wave-map reasoning beyond the plan's one-liners, environment facts verified. Later sessions append below." },
  // Passages that restate or perform what a census rule amends, where an edit could narrow the rule without naming the
  // census: the fence extension and the branch cut, as execution-models.md and SKILL.md restate them, and the planning
  // steps whose changes step 3's re-run follows.
  { key: 'pin:fenceExtensions', rule: "execution-models.md's fence extensions, which a census re-run follows, stay as they read", file: MODELS,
    from: '**Fence extensions** are the one mid-wave change', to: '\n\n## Legacy models',
    text: "**Fence extensions** are the one mid-wave change the orchestrator may make alone, because they keep the invariant plan approval rested on: a `NEEDS_FENCE` path is granted only if it is absent from every same-wave sibling's fence (including siblings already integrated this wave) and from every extension already recorded; it is recorded in PROGRESS on the integration branch, and the implementer updates its own Files line on its branch. A path a sibling owns waits for the next wave; two batches needing the same region is a plan error that goes to the user at the STOP." },
  { key: 'pin:branchInvariant', rule: "SKILL.md's branch invariant, whose cut step 4's corrections precede, stays as it reads", file: SKILL,
    from: '- One branch per batch, cut from the integration branch', to: '\n- Only batches the plan marked',
    text: "- One branch per batch, cut from the integration branch when its wave opens. Never commit to the default branch, never push. The orchestrator merges REVIEWED batches into the integration branch; anything merges toward the default branch only per the ledger's merge policy or the user's explicit words in THIS session." },
  { key: 'pin:waveInvariant', rule: "SKILL.md's wave invariant, whose fence extension a census re-run follows, stays as it reads", file: SKILL,
    from: '- Only batches the plan marked mutually file-disjoint', to: '\n- The wave-open PROGRESS commit',
    text: "- Only batches the plan marked mutually file-disjoint and dependency-free share a wave; the user's plan approval is the standing authorization for that concurrency. Deviating from the locked wave map needs the user's explicit words, recorded verbatim in PROGRESS (sole standing exception: a recorded `NEEDS_FENCE` deferral moving the final checkpoint). A mid-wave fence extension is allowed only when it keeps the wave disjoint (protocol §Fence changes) and is recorded in PROGRESS." },
  { key: 'pin:backlogSweep', rule: 'scaffolding.md step 4, whose accepted fold-ins re-run the census before the fill, stays as it reads', file: SCAFFOLDING,
    from: '4. **Backlog sweep**', to: '\n5. **Pre-flight**',
    text: "4. **Backlog sweep** — read the repo's backlog / feature / bug files and propose fold-ins. Eligible only if ALL hold: (a) the item's files are a SUBSET of one draft batch's fence; (b) it is machine-verifiable or covered by that batch's existing agent-runnable smoke steps — it never adds a human step and never changes the batch's hands-on class; (c) a one-line acceptance criterion, no design decision, no migration; (d) at most two per batch, none on an L-weight batch. Present the eligible list (id or a proposed id, verbatim text, host batch, why cheap) for the user to pick at PLAN APPROVAL — not a separate interview round. Items considered and rejected are noted in LOG.md. An accepted fold-in becomes a request item (00-request.md decision \"folded from <file> <id> — approved <date>\"; coverage rows tagged `backlog <id>`), gets its own checklist item, acceptance criterion and smoke step in the host batch, and its own commit. Only the ACCEPTED items receive an id in the repo's scheme (`{{BACKLOG_ID_PREFIX}}`); the rest of the backlog is untouched." },
  { key: 'pin:preflight', rule: 'scaffolding.md step 5, whose fixes re-run the census before the fill, stays as it reads', file: SCAFFOLDING,
    from: '5. **Pre-flight**', to: '\n6. **Front-load user gates**',
    text: "5. **Pre-flight** — spawn ONE fresh read-only sub-agent with the `subagent-prompts.md` pre-flight skeleton over the draft request, plan and batch files (fold-ins included). Draft them first as a ledger in a scratch worktree of the base (`git worktree add --detach <scratchpad>/wt-draft <base>`), with step 8's command and an answers file whose coverage audit ends in a provisional `Pre-flight: CLEAN` (the scaffold's self-check requires the line) and whose `foldins` stay empty (their markers belong to the real fill): `node \"<SKILL_DIR>/tools/scaffold.mjs\" --answers <draft answers> --repo <scratchpad>/wt-draft`. A re-draft after a fix first deletes the draft directory, which `scaffold.mjs` otherwise refuses. From that worktree's root run `node \"<SKILL_DIR>/tools/check-ledger.mjs\" plan --dir .agents/changes/<CHANGE_ID> --repo .`, `node \"<SKILL_DIR>/tools/check-ledger.mjs\" cites --dir .agents/changes/<CHANGE_ID> --repo .` and `node \"<SKILL_DIR>/tools/check-ledger.mjs\" census --dir .agents/changes/<CHANGE_ID> --repo .`, and include their three lines in the skeleton: `PLAN …` settles same-wave disjointness, dependencies and fence paths, `CITES …` names the citations that no longer hold, and `CENSUS …` the tracked files outside every fence that name a fenced path. Each line lists at most ten entries, then `(+<k> more)`; for a `PLAN FAIL`, `CITES FAIL` or `CENSUS` line cut short that way, the pre-flight checks for itself what the line leaves out. Where the tools do not run, the drafts go in as written and the skeleton's checks run without those lines. It checks coverage both ways, mechanical fence disjointness per wave, fence completeness (grep census of every symbol / channel / table / literal each batch touches, across tests, generated maps and docs), contradictions, criteria testability, and hands-on / runner / weight plausibility. Fix every BLOCKING finding before the plan goes to the user; record the verdict line in the plan's coverage audit and the detail in LOG.md. Once the last pre-flight round is done, delete the draft ledger directory and remove its worktree (`git worktree remove <scratchpad>/wt-draft`, or `git worktree prune` once that directory is gone), so Discovery never meets the draft as a second copy of the ledger." },
  { key: 'pin:approve', rule: 'scaffolding.md step 7, whose adjustments re-run the census before the fill, stays as it reads', file: SCAFFOLDING,
    from: '7. **Approve**', to: '\n8. **Fill**',
    text: "7. **Approve** — present the computed wave map (which batches run concurrently, and why that is safe), the checkpoint placement (after which waves, with the hands-on batches named) per `execution-models.md`, and each batch's weight; the user approves plan, wave map, weights, checkpoints and fold-ins in ONE pass, confirming or adjusting; that approval is the standing authorization for the concurrency." },
];
const pinOf = key => PINS.find(pin => pin.key === key);
function pinFaults(docs, pin) {
  const found = between(docs.get(pin.file), pin.from, pin.to);
  if (found.fault) return [found.fault];
  const text = collapse(found.raw);
  return text === pin.text ? [] : ['reads ' + JSON.stringify(text)];
}

// ===== Each rule inside a pinned passage, checked alone, so a re-pinned passage cannot lose it =================
const CLAUSES = [
  { key: 'clause:one-per-batch', rule: 'step 3: one census agent per drafted batch, never one for several', pin: 'pin:step3',
    phrase: 'once the batches are drafted, spawn one `census` agent per batch, never one agent for several batches' },
  { key: 'clause:record', rule: 'step 3: every opening item recorded before the pre-flight, carried with its batch-file line or rejected with the reason', pin: 'pin:step3',
    phrase: 'before the pre-flight, record every one of those items in LOG.md as carried (the batch-file line that now holds it) or rejected (the reason)' },
  { key: 'clause:planning-rerun', rule: 'step 3: a pre-flight fix, a fold-in or an approval adjustment that adds a file, a hook or a behaviour runs the census again before the fill', pin: 'pin:step3',
    phrase: "a pre-flight fix, an accepted fold-in or an adjustment at approval — adds a file, a hook or a behaviour to a batch, run the batch's `census` agent again and record its items the same way before the fill" },
  { key: 'clause:roles-one-per-batch', rule: '§Roles: one census agent per batch, never one for several', pin: 'pin:roles',
    phrase: 'one read-only `census` agent per batch, never one for several batches' },
  { key: 'clause:second-wave', rule: 'step 4: the census runs again from the second wave on, when an earlier wave exists', pin: 'pin:step4',
    phrase: 'From the second wave on, before the cut,' },
  { key: 'clause:crashed-open', rule: 'step 4: only a member branch at the integration tip, from an open that crashed after its cut began, stops the census running again', pin: 'pin:step4',
    phrase: 'Once a member branch of this wave exists at the integration tip — an open that crashed after its cut began — no census runs again at this open, so the cut below adopts the branches cut from the corrected tip.' },
  { key: 'clause:names', rule: 'step 4: a member is reached through its fence path, the basename or a directory holding it', pin: 'pin:step4',
    phrase: 'each member whose fence path a test added or changed by an earlier wave names — the path itself, its basename or a directory holding it' },
  { key: 'clause:listing', rule: 'step 4: the tests earlier waves added or changed come from the published AM listing', pin: 'pin:step4',
    phrase: "taking the tests among the files `git diff --name-only --no-renames --diff-filter=AM <W1's base, from the session log>..<the integration tip>` lists" },
  { key: 'clause:failed-listing', rule: 'step 4: a listing that fails counts as a match', pin: 'pin:step4',
    phrase: '(a listing that fails counts as a match)' },
  { key: 'clause:step4-branch', rule: 'step 4: the corrections are committed to the batch file on the integration branch', pin: 'pin:step4',
    phrase: "commit the corrections it carries into the member's batch file on the integration branch, each opening item recorded in LOG.md as carried or rejected, so every member branch starts from them" },
  { key: 'clause:step4-extension', rule: "step 4: a correction outside the fence is first recorded as an extension under §Fence changes' test", pin: 'pin:step4',
    phrase: "A correction that needs a path outside the member's fence is first recorded as an extension under §Fence changes' test" },
  { key: 'clause:step4-words', rule: "step 4: a correction that adds a checklist item or a criterion needs the user's words", pin: 'pin:step4',
    phrase: "one that adds a checklist item or an acceptance criterion needs the user's words, recorded verbatim in PROGRESS" },
  { key: 'clause:fence-trigger', rule: '§Fence changes: an extension or an authorized plan change that adds a file, a hook or a behaviour runs the census again', pin: 'pin:fence',
    phrase: "that adds a file, a hook or a behaviour runs the batch's `census` agent again before its implementer resumes or starts" },
  { key: 'clause:fence-branch', rule: '§Fence changes: the corrections are committed to the batch file on the integration branch', pin: 'pin:fence',
    phrase: "Every correction it carries is committed to the batch file's notes on the integration branch" },
  { key: 'clause:fence-extension', rule: "§Fence changes: a correction outside the fence passes the section's test first", pin: 'pin:fence',
    phrase: "a correction that needs a path outside the fence passes this section's test first" },
  { key: 'clause:fence-words', rule: "§Fence changes: a correction that adds a checklist item or a criterion needs the user's words", pin: 'pin:fence',
    phrase: "one that adds a checklist item or an acceptance criterion needs the user's words, recorded verbatim in PROGRESS" },
];
function clauseFaults(docs, clause) {
  const pin = pinOf(clause.pin), found = between(docs.get(pin.file), pin.from, pin.to);
  if (found.fault) return [found.fault];
  return collapse(found.raw).includes(clause.phrase) ? [] : ['no longer says ' + JSON.stringify(clause.phrase)];
}

// ===== Rules about order: each anchor once in its section, in this order ==========================================
const ORDERS = [
  { key: 'order:step3', rule: 'scaffolding.md: the census closes step 3, before the backlog sweep and the pre-flight', file: SCAFFOLDING,
    from: '\n## Procedure', to: '\n## Evidence and input baking',
    anchors: ['3. **Plan**', 'invent a pre-verified result.', '**Census** — once the batches are drafted', 'before the fill.', '4. **Backlog sweep**', '5. **Pre-flight**'] },
  { key: 'order:roles', rule: 'protocol.md §Roles: the census bullet follows the pre-flight bullet', file: PROTOCOL,
    from: '\n## Roles, gates, tiers', to: '\n## Severity and round accounting',
    anchors: ['- **Plan pre-flight** (scaffold time)', '- **Census** (scaffold time', '- **Tiers**'] },
  { key: 'order:step4', rule: 'protocol.md step 4: the census runs again before the cut, and the cut comes before the wave-open commit', file: PROTOCOL,
    from: '\n## §Session algorithm', to: '\n## Two distinct close-outs',
    anchors: ['4. Open the next wave', 'From the second wave on, before the cut, run the `census` agent again', 'no census runs again at this open',
      "cut every member's branch", 'then commit the wave-open PROGRESS flip', 'wave base SHA in the session log', '5. Spawn ALL'] },
  { key: 'order:fence', rule: 'protocol.md §Fence changes: the census trigger closes the section', file: PROTOCOL,
    from: '\n### §Fence changes (mid-wave)', to: '\n### Complete checkpoint inputs',
    anchors: ['An implementer that needs a path outside its fence', "never the implementer's Files line alone.", 'A recorded extension, or a change to a batch'] },
  { key: 'order:degraded', rule: 'protocol.md §Degraded environments: the census closes the no-sub-agents bullet', file: PROTOCOL,
    from: '\n## Degraded environments', to: null,
    anchors: ['- **No sub-agents available**', 'Checkpoint placement is unchanged.', "The census is the orchestrator's own pass", '- **No agent definitions installed**'] },
  { key: 'order:pipeline', rule: 'SKILL.md new mode: the census comes after the checkpoints, before the backlog sweep and the plan checks', file: SKILL,
    from: '\n## Mode: new', to: '\n## Mode: continue',
    anchors: ['place the smoke checkpoints', '→ per-batch census', '→ backlog sweep (propose', '→ plan checks on', 'plan PRE-FLIGHT'] },
  { key: 'order:continue', rule: 'SKILL.md continue: the census runs again before the cut', file: SKILL,
    from: '\n## Mode: continue', to: '\n## Mode: status',
    anchors: ['open the next wave (re-run the `census` agent', 'cut branches + worktrees', "spawn ALL of the wave's implementers"] },
  { key: 'order:waveOpen', rule: "execution-models.md: the wave's cut follows step 4's census re-run", file: MODELS,
    from: '\n## Wave mechanics (run time)', to: '\n## Degenerate cases',
    anchors: ['1. **Open the wave**: from the integration tip', 'after any `census` agent re-run', "cut every member batch's branch", '2. **Gate as they land**'] },
];
function orderFaults(docs, order) {
  const found = between(docs.get(order.file), order.from, order.to);
  if (found.fault) return [found.fault];
  const text = collapse(found.raw), faults = [];
  const at = order.anchors.map(anchor => {
    const count = text.split(anchor).length - 1;
    if (count !== 1) faults.push(JSON.stringify(anchor) + ' occurs ' + count + ' times in the section, not once');
    return text.indexOf(anchor);
  });
  for (let i = 1; i < at.length; i++) {
    if (at[i - 1] !== -1 && at[i] !== -1 && at[i - 1] >= at[i]) faults.push(JSON.stringify(order.anchors[i - 1]) + ' no longer comes before ' + JSON.stringify(order.anchors[i]));
  }
  return faults;
}

// ===== The census is a paragraph of step 3, not a step: the procedure keeps its numbering =========================
const STEPS = ['1. Detect', '2. Interview', '3. Plan', '4. Backlog sweep', '5. Pre-flight', '6. Front-load user gates', '7. Approve', '8. Fill',
  '9. Self-check', '10. Scaffold commit', '11. STOP'];
function stepFaults(docs) {
  const found = between(docs.get(SCAFFOLDING), '\n## Procedure', '\n## Evidence and input baking');
  if (found.fault) return [found.fault];
  const steps = [...found.raw.matchAll(/^(\d+)\. \*\*([^*]+)\*\*/gm)].map(m => m[1] + '. ' + m[2]);
  return isDeepStrictEqual(steps, STEPS) ? [] : ['the procedure reads ' + steps.join(' | ')];
}

// ===== Every pointer in the passages resolves for a reader of the installed skill ================================
// A Markdown file a passage names is a file of the skill tree, and a § pointer names a protocol.md heading — §Census
// aside: it is the §Census section of SKELETONS, which this file never reads.
function pointerFaults(docs) {
  const files = new Set(trackedSkill().map(file => file.split('/').pop()));
  const sections = [...docs.get(PROTOCOL).matchAll(/^#{2,3} §?(.+?)(?: \(.*\)| — .*)?$/gm)].map(m => m[1]);
  const faults = [];
  for (const pin of PINS) {
    const found = between(docs.get(pin.file), pin.from, pin.to);
    if (found.fault) continue;
    const text = collapse(found.raw);
    for (const m of text.matchAll(/[\w.-]+\.md\b/g)) if (!files.has(m[0])) faults.push(pin.key + ' names ' + m[0] + ', no file of the skill');
    for (const m of text.matchAll(/§/g)) {
      const after = text.slice(m.index + 1);
      if (!after.startsWith('Census') && !sections.some(name => after.startsWith(name))) faults.push(pin.key + ' points at §' + after.slice(0, 24) + '…, no protocol.md section');
    }
  }
  return faults;
}

// ===== The undoing sweep, and the closed rules over it ==============================================================
// Paragraphs, list items and table rows, each whitespace collapsed with code ticks dropped, cut into sentences at a full
// stop, question or exclamation mark followed by a space, a list item's number kept with its first sentence. Each
// sentence keeps its offset in the whole document read the same way, so it can be placed against the pinned passages,
// and its group: a list item together with the blocks after it indented further — its paragraphs, rows and sub-items —
// up to the first block that is not; any other block is a group of its own.
const BLOCKS = /\n(?:[ \t]*\n)+|\n(?=[ \t]*(?:[-*]|\d+\.)[ \t])|\n(?=[ \t]*\|)/;
const ITEM = /^[ \t]*(?:[-*]|\d+\.)[ \t]/;
const normalize = text => collapse(text.replace(/`/g, ''));
const unitCache = new Map();
function unitsOf(text) {
  if (!unitCache.has(text)) {
    const whole = normalize(text), units = [];
    let cursor = 0, item = null, depth = 0;
    text.split(BLOCKS).forEach((raw, block) => {
      const paragraph = normalize(raw);
      if (!paragraph) return;
      const indent = raw.match(/^[ \t]*/)[0].length;
      let group = block;
      if (item !== null && indent > depth) group = item;
      else if (ITEM.test(raw)) { item = block; depth = indent; }
      else item = null;
      const start = whole.indexOf(paragraph, cursor);
      assert.ok(start !== -1, 'a block must read back from its normalized document: ' + paragraph.slice(0, 60));
      cursor = start + paragraph.length;
      let at = start;
      for (const sentence of paragraph.split(/(?<=[.!?])(?<!^\d+\.) /)) {
        units.push({ sentence, at, group });
        at += sentence.length + 1;
      }
    });
    unitCache.set(text, { whole, units });
  }
  return unitCache.get(text);
}
// A sentence about the census agent, its report or its record, not about check-ledger.mjs's census operation.
const ABOUT_CENSUS = /\bcensus(?:es)?\s+(?:agents?|reports?|pass(?:es)?|steps?|items?|records?|re-?runs?|corrections?|findings|is|are|runs?|ran|covers?|reads?|may|can|must|should|needs?)\b|\b(?:the|a|an|one|each|every|its|their|this|that|any|per-batch|planning|batch['’]s|member['’]s)\s+census(?:es)?\b/i;
const aboutCensus = sentence => ABOUT_CENSUS.test(sentence);
const SEVERAL = /\b(?:several|multiple|many|both|all|two or more|a (?:set|group|handful) of)\s+(?:(?:of|the|its|their|drafted|planned|wave['’]s|plan['’]s)\s+){0,3}batches\b|\b(?:a|the|each|every|one)\s+(?:wave|plan)['’]s\s+batches\b|\bbatches\s+of\s+(?:a|the|each|one)\s+(?:wave|plan)\b|\bper\s+(?:wave|plan|change|ledger)\b|\b(?:the\s+)?whole\s+(?:wave|plan|change)\b/i;
const NEGATOR = /\b(?:never|not|no|nor|none|cannot|without)\b|\w+n['’]t\b/i;
// Whether some match of `pattern` has (`negated` true) or lacks (false) a negator among the six words before it, inside
// its own clause.
function matchesBy(sentence, pattern, negated) {
  return [...sentence.matchAll(new RegExp(pattern.source, 'gi'))].some(m => {
    const clause = sentence.slice(0, m.index).split(/[,;:()—]/).pop().trim();
    return NEGATOR.test(clause.split(/\s+/).slice(-6).join(' ')) === negated;
  });
}
const unnegated = (sentence, pattern) => matchesBy(sentence, pattern, false);
const negated = (sentence, pattern) => matchesBy(sentence, pattern, true);
const OPTIONAL = /\b(?:optional|skippable|may be (?:skipped|omitted|dropped)|can be (?:skipped|omitted|dropped)|need not|does not have to|doesn['’]t have to|if time (?:allows|permits)|at (?:the orchestrator['’]s|the conductor['’]s|your) discretion)\b/i;
const ONCE = /\b(?:only once|once only|(?:runs?|ran|spawned|done)\s+(?:just\s+|only\s+)?once|only at scaffold time|never\s+(?:re-?runs?|runs?\s+(?:it\s+)?again|again)|(?:not|isn['’]t)\s+(?:re-?run|run again)|no\s+(?:re-?runs?|second census|further census|new census))\b/i;
// The listing step 4 runs, by any of its names: the absence family reads every sentence that names one, whatever word
// it uses for the failure.
const LISTING = /\b(?:listings?|diffs?|ls-files)\b/i;
const AS_ABSENCE = /\bno\s+(?:match|earlier[- ]wave\s+tests?|tests?)\b|\b(?:counts?|reads?|is\s+(?:read|taken|treated)|treat(?:s|ed)?(?:\s+it)?)\s+as\s+(?:no|absence|absent|empty|nothing|none)\b|\bskip(?:s|ped|ping)?\s+(?:the\s+|its\s+|a\s+)?(?:re-?run|census)\b/i;
const COUNTS_AS_MATCH = /\bcounts?\s+as\s+a\s+match\b/i;
const CORRECTION = /\bcorrections?\b/i, ADDS_SCOPE = /\b(?:checklist items?|acceptance criteri(?:on|a))\b/i, USERS_WORDS = /\buser['’]s\s+(?:explicit\s+)?words\b/i;
const OUT_OF_FENCE = /\b(?:outside\s+(?:the|its|a|every|the\s+member['’]s|the\s+batch['’]s|a\s+batch['’]s)\s+fences?|out-of-fence|beyond\s+(?:the|its)\s+fence)\b/i;
const ROUTE = /§\s*Fence changes|this section['’]s test/i;
// Each family: the sentences it selects; with byGroup, also every later sentence of a group that holds a sentence about
// the census, where a pronoun carries the census, and an earlier one that points ahead with "below" or "following"; the
// ones it reports among those it reads; and undoings an author would write, each of which this family alone reports. A
// family reports a rule's keyword negated as it reports it missing.
const FAMILIES = [
  { key: 'sweep:several', rule: 'no sentence lets one census agent cover several batches', select: aboutCensus, byGroup: true,
    report: s => unnegated(s, SEVERAL),
    undoings: ['One `census` agent may cover several batches at once.', 'A single census agent can read all the batches of a wave.', 'Spawn one census agent per wave.',
      // A negator seven words back, just outside the window, and one in the clause before: neither negates the batches.
      'No rule stops one census agent covering several batches.', 'When none changed, one census agent covers several batches.',
      'One census agent reads one batch, or several batches.',
      // The census carried by a pronoun into the next sentence, the item's next paragraph (after one blank line and after
      // two) and its sub-item, and by "below" back to the sentence before.
      'Spawn the census agents once the plan is drafted. One may read several batches.',
      '- Spawn the census agents once the plan is drafted.\n\n  One may read several batches.',
      '- Spawn the census agents once the plan is drafted.\n\n\n  One may read several batches.',
      '- Spawn the census agents once the plan is drafted.\n  - One may read several batches.',
      'The agent below may read several batches. Spawn the census agents once the plan is drafted.'] },
  { key: 'sweep:optional', rule: 'no sentence makes the census or its record optional', select: aboutCensus, byGroup: true,
    report: s => OPTIONAL.test(s),
    undoings: ['The census is optional for an S-weight batch.', 'Recording the census items in LOG.md may be skipped when the draft is unchanged.',
      "Re-run the census agent at the orchestrator's discretion.", 'The following step is optional for an S-weight batch. Spawn one census agent per drafted batch.'] },
  { key: 'sweep:once', rule: 'no sentence runs the census only once', select: aboutCensus, byGroup: true,
    report: s => ONCE.test(s),
    undoings: ['The census runs only once, at scaffold time.', 'A pre-flight fix never re-runs the census agent.', 'The census agent is not re-run when a wave opens.',
      'Do not re-run the census agent when a pre-flight fix adds a hook.'] },
  { key: 'sweep:absence', rule: 'no sentence reads a failed listing as no match', select: s => LISTING.test(s),
    report: s => AS_ABSENCE.test(s) || negated(s, COUNTS_AS_MATCH),
    undoings: ['A listing that fails counts as no match.', 'If the git diff fails, there are no earlier-wave tests to read.', 'When the listing fails, skip the re-run.',
      'A listing that fails does not count as a match.',
      // One for each other name of the listing.
      'When the listings fail, they count as no match.', 'When the diffs fail, they count as no match.', 'When ls-files fails, it counts as no match.',
      // The failure in other words.
      'A diff that errors counts as no match.', 'When the git diff crashes, there are no earlier-wave tests to read.', 'A listing that aborts is read as empty.',
      'A diff that exits non-zero counts as no match.', 'An unreadable listing counts as no match.', 'A diff that cannot run is treated as nothing.',
      "A listing that can't run counts as no match."] },
  { key: 'sweep:words', rule: "no census correction adds a checklist item or a criterion without the user's words",
    select: s => (aboutCensus(s) || CORRECTION.test(s)) && ADDS_SCOPE.test(s), report: s => !unnegated(s, USERS_WORDS),
    undoings: ['A census correction may add a checklist item on its own.', 'The orchestrator adds the acceptance criteria a census report proposes.',
      "A census correction that adds a checklist item does not need the user's words."] },
  { key: 'sweep:route', rule: "no census correction leaves its fence except through §Fence changes' test",
    select: s => (aboutCensus(s) || CORRECTION.test(s)) && OUT_OF_FENCE.test(s), report: s => !unnegated(s, ROUTE),
    undoings: ['A census correction outside the fence is applied to the batch file directly.', "Commit a correction that needs a path outside the member's fence at once.",
      "A census correction outside the fence does not pass §Fence changes' test."] },
];
// Sentences that state a rule rather than undo it: no family may report one. The first holds its negator six words
// back, the window's far edge; the next puts several batches before the census sentence with no word pointing ahead;
// the rest put them just past a census group: in the paragraph before it, pointing ahead, the next item as shallow as
// it (unindented and indented), the unindented paragraph after an item, an indented paragraph past that one, and an
// indented paragraph that follows no item.
const KEEPINGS = ['Never let one census agent cover several batches.', 'One census agent reads one batch, never several batches.',
  'A listing that fails counts as a match.', "A census correction that adds a checklist item needs the user's words.",
  "A census correction outside the fence passes §Fence changes' test first.", 'Re-run the census agent when a pre-flight fix adds a hook.',
  'A wave holds several batches. Each gets its own census agent.', 'Several batches are listed below.\n\nEach gets its own census agent.',
  '- Each batch gets its own census agent.\n- A wave holds several batches.', '  - Each batch gets its own census agent.\n  - A wave holds several batches.',
  '- Each batch gets its own census agent.\n\nA wave holds several batches.',
  '- Each batch gets its own census agent.\n\nA paragraph between.\n\n  A wave holds several batches.',
  'A paragraph.\n\n  Each batch gets its own census agent.\n\n  A wave holds several batches.'];
// The groups of `units` that hold a sentence about the census, and the words by which a sentence points at a later one.
const censusGroups = units => new Set(units.filter(unit => aboutCensus(unit.sentence)).map(unit => unit.group));
const FORWARD = /\b(?:below|following)\b/i;
// The sentences a family reads, in document order.
function readBy(family, units) {
  const groups = censusGroups(units), reached = new Set();
  return units.filter(({ sentence, group }) => {
    if (aboutCensus(sentence)) reached.add(group);
    return family.select(sentence) || (family.byGroup === true && (reached.has(group) || (groups.has(group) && FORWARD.test(sentence))));
  });
}
const reported = (family, text) => readBy(family, unitsOf(text).units).filter(({ sentence }) => family.report(sentence)).map(({ sentence }) => sentence);
const familyFaults = (docs, family) => [...docs].flatMap(([file, text]) => reported(family, text).map(sentence => file + ': ' + sentence));

// The closed rules read the rest as doubt. Every census mention outside a pinned passage is one of these reviewed
// phrases: check-ledger.mjs's census operation and the pre-flight's grep census, none of which names the census agent.
// Each phrase is read as normalize reads its document and occurs there once.
const REVIEWED_MENTIONS = [
  { file: SCAFFOLDING, phrase: 'node "<SKILL_DIR>/tools/check-ledger.mjs" census --dir .agents/changes/<CHANGE_ID> --repo .' },
  { file: SCAFFOLDING, phrase: 'and CENSUS … the tracked files outside every fence that name a fenced path' },
  { file: SCAFFOLDING, phrase: 'for a PLAN FAIL, CITES FAIL or CENSUS line cut short that way' },
  { file: SCAFFOLDING, phrase: 'fence completeness (grep census of every symbol / channel / table / literal each batch touches' },
  { file: SKILL, phrase: 'check-ledger.mjs runs plan, cites and census on it' },
];
// Every sentence the closed rule reads outside a pinned passage is one of these, each read as unitsOf reads it, and none
// undoes a census rule. First the census groups' own: step 3's planning before its census paragraph, step 4's opening
// sentence and its cut, the new-mode pipeline and the continue flow around their census steps, the wave open with its
// spawn, and the end of the LOG comment; the pipeline's list of preconditions is left open.
const REVIEWED_SENTENCES = [
  { file: SCAFFOLDING, sentence: "3. **Plan** — explore the codebase (sub-agents as needed, at medium thoroughness by default; \"very thorough\" only when the interview needs an inventory and the prompt names what it is for), draft the batch table with file fences and a weight per batch (S / M / L), and map every request item to a batch." },
  { file: SCAFFOLDING, sentence: "Then structure for throughput per execution-models.md: reshape fences for disjointness (seam batches, splits, merges), build the wave map (widest safe waves — \"3 concurrent, then 2\" beats 5 back-to-back), classify every batch hands-on vs machine-verifiable, tag every smoke step Runner: agent | human against the detected runner set and the environment's prohibitions (\"touches data\" is human unless a disposable environment exists), and place the smoke checkpoints (one after each hands-on wave + the mandatory final one — never per batch)." },
  { file: SCAFFOLDING, sentence: "A step is human ONLY when it needs something an agent on this machine cannot do: a device, a GUI, held credentials, a judgement about whether something looks right, or something the environment contract forbids an agent here to do — the prohibitions just named are that last kind, not exceptions to this rule." },
  { file: SCAFFOLDING, sentence: "Pick the applicable guardrails per batch (the subset of the project's guardrail bullets its fence can violate)." },
  { file: SCAFFOLDING, sentence: "Record each codebase fact the plan and batch files rely on as a pinned citation, in the form the templates' instruction comments show ( path:line symbol ), so that check-ledger.mjs cites checks it against the base; any other path:line span it lists as unpinned." },
  { file: SCAFFOLDING, sentence: "Inventory the exact required inputs for each step while planning: workbook sheets/columns/types/formulas/edge cases, independent validation, reproducible synthetic generation, immutable issue paths and working-copy/reset directions." },
  { file: SCAFFOLDING, sentence: "Name actual private-data/credential/access prerequisites; do not defer ordinary input construction to the tester or invent a pre-verified result." },
  { file: PROTOCOL, sentence: "4. Open the next wave: the earliest wave that still has ⬜ batches (or a recorded deferral) whose deps are all 🟢/✅." },
  { file: PROTOCOL, sentence: "From the integration tip: cut every member's branch, create every worktree (setup: the ledger's per-worktree setup), then commit the wave-open PROGRESS flip (rows → 🔄, wave base SHA in the session log, **State**: ACTIVE)." },
  { file: PROTOCOL, sentence: "The cut is idempotent: a member branch that already exists with its tip equal to the current integration tip is adopted from a crashed open — its worktree, if any, removed and recreated (fresh setup); a member branch in any other state → STOP AND INVESTIGATE (name collision, or a stale base from an earlier crashed open — re-cut only on the user's word; never delete unasked)." },
  { file: SKILL, sentence: "Read [references/scaffolding.md](references/scaffolding.md) and the files in [templates/](templates/), then: preconditions (git repo; tree state) → detect repo facts (validation commands and their quiet form, versioning, gate agents, runners, backlog id scheme; node \"<skill-dir>/tools/detect.mjs\" --repo <repo> and node \"<skill-dir>/tools/env-facts.mjs\" --repo <repo> print the candidates) → interview (back-to-back AskUserQuestion calls, as many as the gaps need) → plan the batches (explore, at medium thoroughness by default and \"very thorough\" only when the interview needs an inventory and the prompt names what it is for; batch table with weights and file fences; item→batch coverage) → structure for throughput per [references/execution-models.md](references/execution-models.md): reshape fences for disjointness, build the wave map (widest safe waves), classify each batch hands-on vs machine-verifiable and each smoke step Runner: agent | human, place the smoke checkpoints (fewest possible — hands-on waves + one final) → per-batch census (one census agent per drafted batch; each item its report opens with is recorded in LOG.md as carried or rejected, per scaffolding.md) → backlog sweep (propose eligible fold-ins per scaffolding.md; the user picks at plan approval) → plan checks on a draft (node \"<skill-dir>/tools/scaffold.mjs\" --answers <draft answers> --repo <scratch worktree> writes the draft ledger into a scratch worktree of the base, and check-ledger.mjs runs plan, cites and census on it, per scaffolding.md; the draft and its worktree are removed after the last pre-flight round, so Discovery never meets a second copy of the ledger) → independent plan PRE-FLIGHT (a fresh read-only sub-agent given those three lines; blocking findings fixed before the user sees the plan) → front-load user gates (design/UX approvals resolved at planning time via mockups, or scheduled as wave 1 — never mid-run) → user approves plan + wave map + checkpoints + weights + fold-ins in one pass → fill the templates into .agents/changes/<CHANGE_ID>/ with node \"<skill-dir>/tools/scaffold.mjs\" --answers <file> --repo <root> (incl.", open: 'preconditions (git repo; tree state' },
  { file: SKILL, sentence: "LOG.md; the fill bakes the **Skill** pin line and writes validate.json, plus setup.json when there is a setup step) → self-check (grep the new directory for {{ and <!--, and its *.md for <title> — zero hits outside fenced and inline code spans." },
  { file: SKILL, sentence: "A hit inside a code span is not an unfilled slot, since a ledger documenting templating work quotes those tokens legitimately; **State**: ACTIVE present; the pre-flight verdict line present in the plan; every # cell of the plan's and PROGRESS's batch tables reads Bnn; check-ledger.mjs prints PARSE OK for the directory and SKILL MATCH for its contract, per scaffolding.md; node \"<skill-dir>/tools/check-ledger.mjs\" selfcheck --dir <ledger-dir> runs all of these at once) → scaffold commit on chore/<slug>-ledger (which becomes the integration branch) → STOP and report." },
  { file: SKILL, sentence: "3. Boot (a pinned contract verifies its skill pin first) + reconcile (for a pinned contract node \"<skill-dir>/tools/reconcile.mjs\" rows --repo <repo> --ledger <id> --integration <full-ref>, <skill-dir> being its pinned directory, if the tool is there) + resume-time validation per the contract's boot sequence — a pinned contract takes up its pinned skill directory's references/protocol.md, the procedure its repo facts plug into, only on SKILL MATCH — then run the pinned protocol.md's (or a legacy contract's own) §Session algorithm: repairs (❌ / red tip) first as mini-batches → unanswered 🧪 checkpoint → open the next wave (re-run the census agent of any member an earlier wave's tests reach, cut branches + worktrees, spawn ALL of the wave's implementers concurrently) → per batch as each lands: fence check → failing-on-base → reviewer + gate agents → polish / fix rounds → integrate (dry run, merge, tip validation) → next wave, repeating until a checkpoint → per-checkpoint close-out (tip validation, QA-runner pre-smoke with evidence, page) → STOP, delivering the checkpoint's combined smoke script as an interactive smoke page per [references/smoke-page.md](references/smoke-page.md) using available HTML delivery tools, or the full plain-text script when no usable HTML delivery is available." },
  { file: SKILL, sentence: "Render the per-batch prompts with node \"<skill-dir>/tools/prompt.mjs\"; the skeletons live in [references/subagent-prompts.md](references/subagent-prompts.md)." },
  { file: MODELS, sentence: "1. **Open the wave**: from the integration tip — after any census agent re-run that protocol.md §Session algorithm step 4 calls for —, cut every member batch's branch; create one worktree per batch under the session scratchpad (never inside the repo); run the ledger's per-worktree setup; commit ONE PROGRESS flip on the integration branch through the integration worktree (member rows → 🔄, branches named, wave base SHA in the session log, **State**: ACTIVE)." },
  { file: MODELS, sentence: "Spawn all implementers in a single message so they run concurrently." },
  { file: MODELS, sentence: "The main checkout is never switched." },
  { file: LOG, sentence: "-->" },
  // A re-run, "again" or step 4 without the census: smoke steps re-run and verdicts selected again, the fix again
  // verdict, the metrics, the skill-pin check, the validation the orchestrator re-runs, the prompt cache, the interview's
  // step 7, and step 4 as the step a red tip and step 7 return to and the cut a leftover branch meets.
  { file: SCAFFOLDING, sentence: "confirmations + gaps only is what bounds the count now that the number of calls does not: never ask what detection already answered — present it for confirmation, or not at all — and never ask what procedure step 7 will ask again (plan, wave map, weights, checkpoints, fold-ins)." },
  { file: PROTOCOL, sentence: "Batch row Notes end with m: rounds=<FIX FIRST rounds> asks=<ASK items closed by a polish pass> fence-bounces=<times the fence check sent the implementer back> gate=<gate-agent findings>/<of which needed a production change> tip-red=<1 if tip validation went red after this merge>; each checkpoint row's Verdict cell ends with m: pre-smoke=<agent steps passed>/<human steps> human-smoke-min=<minutes the user reports> escaped=<defects the user found that no gate caught>, completed when the user's final verdict on that checkpoint is recorded (escaped counts every fail across re-runs)." },
  { file: PROTOCOL, sentence: "Both stay out of integration; once the wave's other members are gated and integrated the session stops instead of opening the next wave, quotes the open finding WITH its failure scenario, and names three verdicts for the user: fix again / ship with the residual / drop (a green suite alone is weak grounds for shipping) — meanings, recording and consumption per step 2's table." },
  { file: PROTOCOL, sentence: "Unrelated revisions/verdicts/notes remain intact; old affected passes and pre evidence are historical, shown as NOT RE-RUN until fresh applicable verification." },
  { file: PROTOCOL, sentence: "A pre-verified label is invalidated for any step whose covered files a later repair touched; the QA runner re-runs it before the page is re-issued." },
  { file: PROTOCOL, sentence: "A FAIL indicts batch(es) → ❌, and the intake writes fix-up pending: fix/<batch>-c<n>-followup[-<k>] into each indicted row's Notes (suffix -2, -3… when the name already exists) — the branch step 2 and §Recovery act on; never a second line while the row's earlier fix-up is unmerged — a further report rides that fix-up as additional failure notes (rows the user explicitly passed → ✅, the rest stay 🧪 for the re-run)." },
  { file: PROTOCOL, sentence: "Preserve earlier verdicts and notes: unchanged steps are labeled carried-over, affected steps require re-running or current agent pre-verification." },
  { file: PROTOCOL, sentence: "Selecting a verdict again after a re-run records the new build/revision; editing its note does not." },
  { file: PROTOCOL, sentence: "| any row whose Notes end in a spent *fix again* (third round on <branch> @<sha>) | no commit after @<sha>, branch not yet an ancestor of the integration branch | Crashed before the third round landed → re-spawn the FRESH strong-tier implementer per step 2's table |" },
  { file: PROTOCOL, sentence: "| any row whose Notes end in a spent *fix again* | commits after @<sha>, branch not yet an ancestor of the integration branch | Third round landed → worktree dirty: re-spawn the FRESH strong-tier implementer at the open findings; clean: fence check, then the fresh re-review with both rounds' findings |" },
  { file: PROTOCOL, sentence: "| any row whose Notes carry a … capped: marker not followed by a later verdict … spent (a marker re-written after a spent line counts as awaiting) | any | Awaiting the user's verdict on that repair (fix again / ship with the residual / drop; ship / drop only after a spent *fix again*) — do not re-gate, do not re-spawn; a recorded verdict is consumed by step 2 |" },
  { file: PROTOCOL, sentence: "| any row whose Notes carry a … repair pending: marker (tip repair pending: / pre-smoke repair pending:) with no later spent *ship* / *drop* verdict (those retire it unmerged) | any | In-flight repair — branch missing: spawn it on the named branch; no commit after the marker's @<sha>: never started → resume the implementer on that branch (fresh worktree); commits after @<sha> but not integrated: resume / gate it per the 🔄 rows on that branch (never a same-named new one); integrated: tip validation (a pre-smoke repair also re-runs its step), remove the marker, then continue per step 2 (tip: back to step 7 or 4; pre-smoke: resume the close-out) |" },
  { file: PROTOCOL, sentence: "| ⛔ (either kind) or ❌ (fix-up capped) | any | Awaiting the user's verdict (fix again / ship with the residual / drop; ship / drop only after a spent *fix again*) — do not re-gate, do not re-spawn; dependents stay ⬜; a recorded verdict is consumed by step 2 |" },
  { file: PROTOCOL, sentence: "| ⬜ | a branch with the batch's planned name already exists | Wave-open crashed before its flip (or a name collision) → nothing to reconcile now; step 4's idempotent cut adopts or stops when this wave opens |" },
  { file: PROTOCOL, sentence: "A contract carrying a **Skill** pin line verifies it FIRST, before reconcile: node \"<skill-dir>/tools/check-ledger.mjs\" skill --contract <ledger-dir>/00-READBEFORE.md from the integration worktree root — SKILL MATCH continues; anything but SKILL MATCH (including a tool that does not run) STOPs and asks, continuing only on the user's explicit words recorded verbatim in the session log, which pick one of two ways on: an upgrade (the pin line rewritten to the new directory and hash in the commit that records them, the change continuing under the new directory's copy of this file) or a restore (the pinned directory rebuilt byte-for-byte from the contract's **Skill source** line, then the pin check re-run, continuing only on SKILL MATCH); the contract's validation recipe never depends on the pinned directory." },
  { file: PROTOCOL, sentence: "- **Red tip with no checkpoint reached** (resume-time validation, or after a merge): the same mini-batch on fix/<batch>-tip (<batch> = the last batch merged before the red) with the failing output as the spec; once green, return to step 7 or step 4 — no 🧪, no STOP." },
  { file: PROTOCOL, sentence: "Verdicts are recorded verbatim in the verdict log (Checkpoint column B<NN>) and consumed EXACTLY ONCE: the consuming session appends verdict <date> <fix again|ship|drop> spent → <what it did> to the subject row's Notes (a spent *fix again* names the round's branch and tip: third round on <branch> @<sha>), and whenever a repair returns to the capped state it re-writes its … capped: marker after that line." },
  { file: PROTOCOL, sentence: "After a spent *fix again*, the re-ask offers only ship / drop — no fourth round." },
  { file: PROTOCOL, sentence: "| Subject | fix again | ship with the residual | drop |" },
  { file: PROTOCOL, sentence: "| capped -tip repair | third round on the repair's own branch; FIX FIRST again → capped, marker re-written | trial-validate, then merge only if green (the open finding → backlog + smoke step); trial red → no merge, stays capped, marker re-written, ask again | reviewed revert mini-batch fix/<batch>-revert of the offending merge; that batch → ⛔ (dropped), items → backlog |" },
  { file: PROTOCOL, sentence: "| ❌ (fix-up capped) | third round on the fix-up's own branch; SHIP → row ❌ and the fix-up proceeds (dry run → merge → tip validation → 🧪 → re-issue); FIX FIRST again → capped, marker re-written | trial-validate, then merge only if green; indicted rows → 🧪; re-issue with the failing step annotated as a known residual (backlog) | reviewed fix/<batch>-revert of the indicted batch's merge; that batch → ⛔ (dropped); the rest → 🧪 for the re-issue |" },
  { file: PROTOCOL, sentence: "Otherwise: go to step 4 and open the next wave in this SAME session." },
  { file: PROTOCOL, sentence: "A pause of over an hour expires the prompt cache, and the first call after it writes the whole context to the cache again." },
  { file: SKILL, sentence: "Two FIX FIRST rounds max, then ⛔ (defective, or green with a residual) and the STOP offers the user: fix again / ship with the residual / drop." },
  { file: SKILL, sentence: "A fail: triage the symptoms to the offending batch(es) → ❌ and write fix-up pending: fix/<batch>-c<n>-followup[-<k>] to each indicted row's Notes, suffixing when the name exists (the fix-up mini-batch then runs via continue; a row whose earlier fix-up is still unmerged gets no second line — the new report rides that fix-up as additional failure notes); batches the user explicitly passed flip ✅; the rest stay 🧪 for the re-run." },
  { file: SKILL, sentence: "Verdicts on a ⛔ batch or a capped repair (fix again / ship with the residual / drop) are recorded the same way, verbatim, in the verdict log (Checkpoint column = B<NN>), and consumed by continue." },
  { file: MODELS, sentence: "A ⛔ batch is left out of integration, its dependents stay ⬜-blocked, and it is surfaced at the next STOP with three verdicts (fix again / ship with the residual / drop)." },
  { file: SMOKE, sentence: "- **Republish, same session**: call Artifact again with the same file path — omit favicon and capabilities (both carry forward)." },
  { file: SMOKE, sentence: "The builder neither infers code coverage nor claims an agent reran a step." },
  { file: SMOKE, sentence: "The page then labels old affected passes NOT RE-RUN; merely editing a note cannot refresh them." },
  { file: SMOKE, sentence: "A missing/mismatched revision or incomplete metadata is historical only: the step requires a re-run and is not counted done unless an applicable human verdict exists." },
  { file: SMOKE, sentence: "pre is dropped from any step whose covered files a later repair touched, and the runner re-runs it before the page is re-issued." },
  { file: SMOKE, sentence: "The STOP message carries: the current page link/path (or full plain-text script), the gate essentials **in text** (branch command, both containment commands with the SHA written out, expected version, canary — so a page that fails to load can't cause a wrong-build run), the step/section counts split into human steps and pre-verified steps (with the evidence SHA), and \"run it from the page; paste the copied results (or just tell me) when done — pre-verified steps are yours to skip or re-run.\"" },
  { file: SMOKE, sentence: "| Blocked | Step could not be performed as written | Usually a defect in the STEP: correct it, republish, ask for that step again." },
  { file: SMOKE, sentence: "Copied results name the current build and distinguish current-build verdicts, carried-over verdicts for unchanged steps, and NOT RE-RUN for affected steps." },
  { file: SMOKE, sentence: "- After a fix-up implementer lands (❌ → 🧪), republish with the affected steps' asides noting the fix, update BUILD_SHA, increment only affected steps' revision, and tell the user which step numbers to re-run." },
  { file: SMOKE, sentence: "- Selecting a carried-over verdict again records a re-run on this build and revision (one click, including selecting Pass again)." },
  { file: SMOKE, sentence: "Selecting the same current verdict again clears it." },
  { file: SMOKE, sentence: "Editing a note alone never counts as re-running the step." },
  { file: SMOKE, sentence: "- A genuinely clean sheet (user asks to re-run everything fresh): suffix the key (c1r2) so old verdicts stop loading, and pass --reset-verdicts along with --previous." },
  { file: CONTRACT, sentence: "Anything but SKILL MATCH (including SKILL MISMATCH, UNKNOWN and a tool that does not run) → STOP and ask; continue only on the user's explicit words, recorded verbatim in the session log, which pick one of two ways on — an upgrade (the **Skill** line above rewritten to the new directory and hash in the commit that records those words, the change continuing under the new directory's protocol.md) or a restore (the pinned directory rebuilt byte-for-byte from the **Skill source** line above, then this pin check re-run, continuing only on SKILL MATCH)." },
  { file: CONTRACT, sentence: "Every checkpoint row's Verdict cell ends with m: pre-smoke=<agent steps passed>/<human steps> human-smoke-min=<minutes the user reports> escaped=<defects the user found that no gate caught>, completed when the user's final verdict on that checkpoint is recorded (escaped counts every fail across re-runs)." },
  { file: BATCH, sentence: "The orchestrator re-runs them on the integration tip after the merge." },
  // A listing or a diff that is not step 4's: the diffs the gates, the fix and polish rounds, a fix-up and the
  // convergence read, the smoke page's containment check, and the templates' mentions of the diff.
  { file: PROTOCOL, sentence: "Polish pass: resume the same implementer with the pointer to its rendered polish prompt (the findings file by path); it appends - [ ] polish: items to its checklist, does them, commits; closes mechanically (fence check + validations; polish commits touch only test/doc/prose paths — a production file touched → fix-diff-only re-review by a fresh reviewer)." },
  { file: PROTOCOL, sentence: "Once the polish has landed, the orchestrator classifies its diff: node \"<skill-dir>/tools/prose-only-diff.mjs\" --repo <batch worktree> --base <pre-polish sha> --head <polish tip>." },
  { file: PROTOCOL, sentence: "PROSE-ONLY exempts the JavaScript files it counts from the fix-diff-only re-review, the other paths it counts keeping the path rule; CODE or UNKNOWN keeps the path rule for the whole diff." },
  { file: PROTOCOL, sentence: "§Recovery keeps the path rule even where the classifier would have read the diff as prose-only — after a crash a production file → fix-diff-only re-review — a deliberately conservative fallback." },
  { file: PROTOCOL, sentence: "One strike: a polish-phase FIX FIRST discards the polish at once (an ASK never licenses a production behavior change): write polish discarded: @<sha> (the pre-polish SHIP tip) into the row's Notes first — the marker §Recovery keys on, and the recorded authorization — then ONE revert commit spanning @<sha>..HEAD (never a reset — no history rewriting, the R-lines' SHAs stay reachable; git diff @<sha> HEAD must come back empty), integrate that reviewed tree, unclosed ASKs → backlog entries, each with its wording attached (a prose ASK's replacement text)." },
  { file: PROTOCOL, sentence: "- Round 1: resume the SAME implementer with the pointer to its rendered fix-round prompt (the findings file by path, after the LOG append — §Session algorithm step 6); a fresh re-review verifies the fixes and scans only the fix diff." },
  { file: PROTOCOL, sentence: "For the manual fence, use git diff --name-status -z -M integration-sha...batch-sha, inspect both rename endpoints against the committed plan union recorded extensions union own batch file; inspect that file's blob diff for only the permitted ticks/polish/authorized Files edits." },
  { file: PROTOCOL, sentence: "A repair is a fix batch for step 6b: it must carry a test that fails on the pre-repair tip (a revert is exempt — its proof is a green tip after the merge and a reviewer confirming the diff is the exact inverse)." },
  { file: PROTOCOL, sentence: "| 🔄, Notes carry polish discarded: @<sha> | branch not an ancestor of the integration branch | Discard in flight → branch tree differs from @<sha>: finish the revert (ONE commit spanning @<sha>..HEAD; never a reset); tree identical (git diff @<sha> <tip> empty): integrate now (dry run → merge → tip validation); the marker stays as the record |" },
  { file: PROTOCOL, sentence: "| 🔄 | Notes record R<k> SHIP @<sha> asks=<n>, commits after @<sha>, worktree clean, every polish: item ticked (at least one appended) | Polish landed, crashed before its close → 6a + validations on the tip; git diff --name-only <sha>..HEAD touches only test/doc/prose paths → integrate; a production file → fix-diff-only re-review by a fresh reviewer |" },
  { file: PROTOCOL, sentence: "| 🔄 | commits ahead, checklist fully ticked | validations green → crashed before the gate → fence check, then the reviewer gate now (latest R<k> line is FIX FIRST @<sha> → the round-<k+1> re-review, recorded R<k+1>: verifies that round's findings from LOG.md, scans git diff <sha>..HEAD); red → resume the implementer (fresh) with the failing output, not a round |" },
  { file: PROTOCOL, sentence: "- **Checkpoint failure** (❌): spawn ONE fix-up implementer on the branch the verdict intake recorded in Notes as fix-up pending: fix/<batch>-c<n>-followup[-<k>] (suffix -2, -3… when the name already exists — a second ❌ on the same batch and checkpoint is a NEW fix-up, and a fail on a step annotated as a known residual re-indicts), cut from the integration tip, with the user's failure notes VERBATIM + the indicted batch file(s) + the diff since the last passed checkpoint (the Base SHA before the first); fence check → fresh reviewer (spec = the failure report + the batch's acceptance criteria) → dry run → merge → tip validation → rows back to 🧪 → STOP, re-issuing the checkpoint's script per §Smoke checkpoints (republish with the affected steps annotated — earlier verdicts survive; or reprint the text; bump the PATCH marker before re-issuing so step 0 can tell the repaired build from the one just tested)." },
  { file: PROTOCOL, sentence: "| ⛔ batch | authorized third round: a FRESH implementer on the strong tier, on the batch branch (row → 🔄), both rounds' findings + the current diff, then a fresh re-review; FIX FIRST again → ⛔ (kind per step 6; the recorded R<k> FIX FIRST line now ends the Notes) | only for ⛔ green, residual finding open (a ⛔ defective is fixed again or dropped): integrate per the integration procedure; residual → severity-tagged backlog entry + one Runner: human smoke step the orchestrator authors into the batch file's Smoke section AFTER the merge, on the integration branch (next checkpoint page, or a re-issue of the passed one) | ⛔ (dropped); items → backlog; its ⬜ dependents re-planned or dropped on the user's words, asked at the same STOP |" },
  { file: PROTOCOL, sentence: "When the renderer is unavailable or refuses (UNKNOWN …), the manual procedure is a pasted prompt with no nonce line, and every such prompt must be SELF-CONTAINED: the spec text + codebase facts from the batch file, the exact file fence, acceptance criteria, the applicable guardrails, the validation commands (the wrapper command and its recipe), the contract's conventions + prohibitions blocks, the report shape, and \"tick your checklist items in the batch file as you complete them; run git diff --name-status -M against the integration branch before committing and revert anything outside your fence; commit on your batch branch (one commit per fold-in item)\"." },
  { file: PROTOCOL, sentence: "Worktree clean (git status --porcelain empty); git diff --name-status -M <integration>...HEAD; every path (both endpoints of a rename) in the plan's fence ∪ recorded extensions ∪ the batch's own file — and within the batch file only ticks, polish: appends and a recorded Files change." },
  { file: PROTOCOL, sentence: "The reviewer gets the batch file + the diff (git diff <integration>...HEAD in the batch's worktree — three-dot isolates the batch's own changes) and must (a) map every hunk to a batch item — unmapped hunks are scope creep → reject (the batch file's ticks are exempt); (b) check each acceptance criterion against the diff; (c) run the validation commands; (d) check the diff against the project guardrails doc and the batch file's applicable guardrails; (e) confirm the failing-on-base result from 6b — an INCONCLUSIVE run means the reviewer establishes from the test text which changed cell fails on the un-fixed code, or says none does — and, when no gate agent runs, name the mutation each new or re-pointed test would survive; (f) confirm every doc/comment sweep the batch file names happened in the same commit." },
  { file: PROTOCOL, sentence: "When on: one read-only sub-agent reads the integration tip against every plan item (acceptance criteria + the full diff from the ledger's **Base** SHA in the PROGRESS preamble, ledger dir excluded) and classifies each implemented / partial / contradicts / unrequested; anything but implemented becomes a named backlog entry or a convergence mini-batch the user is asked about." },
  { file: SKILL, sentence: "- Every batch passes, in order: a MECHANICAL fence check (paths, both rename endpoints, clean worktree — fence bounces are not review rounds), the failing-on-base check for fix batches, then ONE fresh independent read-only reviewer (plus any gate agents the contract names, in parallel) that maps every diff hunk to a batch item; unmapped hunks are scope creep and reject the round." },
  { file: MODELS, sentence: "2. **Gate as they land**: each finished batch, in order — structured report present → mechanical fence check (clean worktree; git diff --name-status -M three-dot against the integration branch; every path in plan fence ∪ recorded extensions ∪ own batch file) → failing-on-base for fix batches → ONE fresh read-only reviewer plus the contract's gate agents in parallel; don't wait for the wave's slowest batch." },
  { file: MODELS, sentence: "SHIP with ASKs → polish pass (not a round; a prose ASK's replacement text the orchestrator applies itself, prose-only-diff.mjs classifies the polish diff, and a polish-phase FIX FIRST discards the polish at once — protocol.md §Severity and round accounting); FIX FIRST → round 1 resumes the implementer (past about 400K tokens of its context, a fresh one with the rework prompt — subagent-prompts.md §Spawning rules); the second FIX FIRST → ⛔, and once the wave's other members are gated and integrated the session STOPs instead of opening the next wave; a user-authorized third round is a fresh implementer on the strong tier." },
  { file: MODELS, sentence: "text git merge-base --is-ancestor <buildSha> HEAD git diff --name-only <buildSha>..HEAD -- ." },
  { file: SMOKE, sentence: "4. **The containment check**, in gate.commands where it EXECUTES — never a check asking the user to compare two SHAs by eye, because committing this page moves HEAD past the build it describes and the two can never agree: git merge-base --is-ancestor <buildSha> HEAD (must exit 0) and git diff --name-only <buildSha>..HEAD -- ." },
  { file: CONTRACT, sentence: "1. Read [00-request.md](00-request.md) (the user's verbatim ask + decisions), [01-plan.md](01-plan.md) (locked scope, batch table, wave map + checkpoints), and [PROGRESS.md](PROGRESS.md), plus the project's always-loaded docs — especially {{GUARDRAILS_REF}}; every batch diff is checked against it." },
  { file: CONTRACT, sentence: "Anything else you notice goes in a PROGRESS Notes entry (orchestrator) or your final report (sub-agent) — never in the diff." },
  { file: CONTRACT, sentence: "text git merge-base --is-ancestor <buildSha> HEAD git diff --name-only <buildSha>..HEAD -- ." },
  { file: BATCH, sentence: "<!-- Verifiable statements the reviewer checks against the actual diff — behaviors and invariants, not restatements of the checklist." },
  { file: PROGRESS, sentence: "**Identifier**: {{CHANGE_ID}} **Started**: {{DATE}} · **Base**: {{BASE_SHA}} (the default-branch commit the ledger branch was cut from — the \"since\" point for the first checkpoint's diff and for convergence) **State**: ACTIVE **Work list**: [01-plan.md](01-plan.md) (see [00-request.md](00-request.md)) **Contract**: [00-READBEFORE.md](00-READBEFORE.md) · **Narrative**: [LOG.md](LOG.md) (read on demand by heading, never at boot) **Smoke page**: — (current delivery: URL, ledger-relative HTML path, or plain text; update at each hand-over) **Rule**: statuses here are claims; **git is truth**." },
];
// The ranges, in normalize(text), of the pinned passages of `file` whose anchors still hold.
function pinnedRanges(docs, file) {
  const text = docs.get(file), whole = normalize(text), ranges = [];
  for (const pin of PINS.filter(p => p.file === file)) {
    const found = between(text, pin.from, pin.to);
    if (found.fault) continue;
    const passage = normalize(found.raw), at = whole.indexOf(passage);
    assert.ok(at !== -1, pin.key + ': a passage must read back from its normalized document');
    ranges.push([at, at + passage.length]);
  }
  return ranges;
}
const CENSUS_WORD = /\bcensus(?:es)?\b/gi;
function mentionFaults(docs) {
  const faults = REVIEWED_MENTIONS.filter(entry => !docs.has(entry.file)).map(entry => entry.file + ' holds a reviewed phrase but is no document of the domain');
  for (const [file, text] of docs) {
    const whole = normalize(text), ranges = pinnedRanges(docs, file);
    for (const { phrase } of REVIEWED_MENTIONS.filter(entry => entry.file === file)) {
      const count = whole.split(phrase).length - 1;
      if (count !== 1) { faults.push(file + ': the reviewed phrase ' + JSON.stringify(phrase) + ' occurs ' + count + ' times, not once'); continue; }
      const at = whole.indexOf(phrase);
      ranges.push([at, at + phrase.length]);
    }
    for (const m of whole.matchAll(CENSUS_WORD)) {
      if (!ranges.some(([start, end]) => m.index >= start && m.index + m[0].length <= end)) faults.push(file + ': …' + whole.slice(Math.max(0, m.index - 60), m.index + m[0].length + 60) + '…');
    }
  }
  return faults;
}
// Words that point at the census's re-run without naming the census.
const RERUN = /\bre-?r[au]n(?:s|ning)?\b/i, AGAIN = /\bagain\b/i, STEP_4 = /\bstep 4\b/i;
const pointsAtRerun = s => RERUN.test(s) || AGAIN.test(s) || STEP_4.test(s);
// The sentences the closed rule reads: every one of a census group, every one a family selects, and every one that
// points at the re-run.
function closedRead(units) {
  const groups = censusGroups(units);
  return units.filter(({ sentence, group }) => groups.has(group) || pointsAtRerun(sentence) || FAMILIES.some(family => family.select(sentence)));
}
// A reviewed sentence matches as written; one that names `open` also matches with more one-word items closing the list
// `open` ends, so that list can grow a word without a fresh review while no clause can join it.
function matches(entry, sentence) {
  if (entry.open === undefined) return sentence === entry.sentence;
  const at = entry.sentence.indexOf(entry.open) + entry.open.length, head = entry.sentence.slice(0, at), tail = entry.sentence.slice(at);
  return sentence.startsWith(head) && sentence.endsWith(tail) && /^(?:; [a-z]+)*$/.test(sentence.slice(head.length, sentence.length - tail.length));
}
function sentenceFaults(docs) {
  const faults = REVIEWED_SENTENCES.filter(entry => !docs.has(entry.file) || !unitsOf(docs.get(entry.file)).units.some(unit => matches(entry, unit.sentence)))
    .map(entry => entry.file + ': the reviewed sentence is gone — ' + entry.sentence.slice(0, 80) + '…');
  for (const [file, text] of docs) {
    const ranges = pinnedRanges(docs, file), reviewed = REVIEWED_SENTENCES.filter(entry => entry.file === file);
    for (const unit of closedRead(unitsOf(text).units)) {
      if (ranges.some(([start, end]) => start <= unit.at && unit.at + unit.sentence.length <= end)) continue;
      if (!reviewed.some(entry => matches(entry, unit.sentence))) faults.push(file + ': ' + unit.sentence);
    }
  }
  return faults;
}

// ===== The verdict =================================================================================================
const RULES = [
  ...PINS.map(pin => ({ key: pin.key, rule: pin.rule, check: docs => pinFaults(docs, pin) })),
  ...CLAUSES.map(clause => ({ key: clause.key, rule: clause.rule, check: docs => clauseFaults(docs, clause) })),
  ...ORDERS.map(order => ({ key: order.key, rule: order.rule, check: docs => orderFaults(docs, order) })),
  { key: 'steps', rule: 'scaffolding.md keeps its procedure steps and their numbers', check: stepFaults },
  { key: 'pointers', rule: 'the passages point only at skill files and protocol.md sections', check: pointerFaults },
  ...FAMILIES.map(family => ({ key: family.key, rule: family.rule, check: docs => familyFaults(docs, family) })),
  { key: 'closed:mentions', rule: 'every census mention lies in a pinned passage or a reviewed phrase', check: mentionFaults },
  { key: 'closed:sentences', rule: 'every sentence the sweep reads lies wholly inside a pinned passage or is a reviewed sentence', check: sentenceFaults },
];
const faultsOf = docs => RULES.flatMap(r => r.check(docs).map(fault => ({ key: r.key, text: r.key + ' (' + r.rule + '): ' + fault })));
const verdict = docs => faultsOf(docs).map(fault => fault.text);

// ===== Live controls ===============================================================================================
// Each mutation throws when its anchor is gone, so a control never runs on an unchanged document.
function plantAfter(text, anchor, addition) {
  assert.equal(text.split(anchor).length - 1, 1, 'the control needs ' + JSON.stringify(anchor) + ' once');
  const at = text.indexOf(anchor) + anchor.length;
  return text.slice(0, at) + addition + text.slice(at);
}
function swap(text, find, replacement) {
  assert.equal(text.split(find).length - 1, 1, 'the control needs ' + JSON.stringify(find) + ' once');
  return text.replace(find, () => replacement);
}
// `text` with the span from `start` through the first `end` after it moved to just before `before`.
function relocate(text, start, end, before) {
  const from = text.indexOf(start), endAt = from === -1 ? -1 : text.indexOf(end, from);
  assert.ok(from !== -1 && endAt !== -1, 'the control needs ' + JSON.stringify(start) + ' … ' + JSON.stringify(end));
  const piece = text.slice(from, endAt + end.length), rest = text.slice(0, from) + text.slice(endAt + end.length);
  assert.equal(rest.split(before).length - 1, 1, 'the control needs ' + JSON.stringify(before) + ' once');
  const at = rest.indexOf(before);
  return rest.slice(0, at) + piece + rest.slice(at);
}
// `text` with `phrase`, matched across any whitespace, removed from inside the passage of `pin`.
function dropWithin(text, pin, phrase) {
  const found = between(text, pin.from, pin.to);
  assert.ok(!found.fault, found.fault);
  const words = phrase.trim().split(/\s+/).map(word => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const m = new RegExp(words.join('\\s+')).exec(found.raw);
  assert.ok(m, 'the control needs ' + JSON.stringify(phrase) + ' inside ' + pin.key);
  const at = found.start + m.index;
  return text.slice(0, at) + text.slice(at + m[0].length);
}
const WORDS_CLAUSE = ", and one that adds a checklist item or an acceptance criterion needs the user's words, recorded verbatim in PROGRESS";
// The controls this change's plan named, by label.
const NAMED = ['a planted sentence saying one census agent covers several batches', "step 4's sentence moved after the cut",
  'the failed-listing clause dropped', "the user's-words clause dropped from step 4", "the user's-words clause dropped from §Fence changes"];
// `host` is a document of the domain that no pin reads, where a planted undoing can only be the sweep's to report.
function controls(host) {
  return [
    { label: NAMED[0], file: SCAFFOLDING, rules: ['pin:step3', 'sweep:several'],
      mutate: text => plantAfter(text, 'before the fill.', ' One `census` agent may cover several batches at once.') },
    { label: NAMED[1], file: PROTOCOL, rules: ['order:step4', 'pin:step4'],
      mutate: text => relocate(text, 'From the second wave on, before the cut, run the', 'the corrected tip.\n   ', 'The cut is idempotent') },
    { label: NAMED[2], file: PROTOCOL, rules: ['clause:failed-listing', 'pin:step4'],
      mutate: text => dropWithin(text, pinOf('pin:step4'), ' (a listing that fails counts as a match)') },
    { label: NAMED[3], file: PROTOCOL, rules: ['clause:step4-words', 'pin:step4'], mutate: text => dropWithin(text, pinOf('pin:step4'), WORDS_CLAUSE) },
    { label: NAMED[4], file: PROTOCOL, rules: ['clause:fence-words', 'pin:fence'], mutate: text => dropWithin(text, pinOf('pin:fence'), WORDS_CLAUSE) },
    // The condition that keeps a colliding or stale member branch from stopping the census, dropped.
    { label: "step 4's crashed-open exception without its integration-tip condition", file: PROTOCOL, rules: ['clause:crashed-open', 'pin:step4'],
      mutate: text => dropWithin(text, pinOf('pin:step4'), ' at the integration tip') },
    // A sentence planted inside each pinned passage.
    ...PINS.map(pin => ({ label: 'a sentence planted in ' + pin.key, file: pin.file, rules: [pin.key],
      mutate: text => plantAfter(text, pin.from, ' Skip it when in a hurry.') })),
    // Each clause dropped from its passage.
    ...CLAUSES.map(clause => ({ label: 'dropped: ' + clause.key, file: pinOf(clause.pin).file, rules: [clause.key],
      mutate: text => dropWithin(text, pinOf(clause.pin), clause.phrase) })),
    // Each order rule's moving part moved past its neighbour.
    { label: 'the census paragraph moved into step 4', file: SCAFFOLDING, rules: ['order:step3'],
      mutate: text => relocate(text, '   **Census** — once the batches are drafted', 'before the fill.\n', '5. **Pre-flight**') },
    { label: 'the census bullet moved above the pre-flight bullet', file: PROTOCOL, rules: ['order:roles'],
      mutate: text => relocate(text, '- **Census** (scaffold time', '§Census.\n', '- **Plan pre-flight** (scaffold time)') },
    { label: 'the census trigger moved to the head of §Fence changes', file: PROTOCOL, rules: ['order:fence'],
      mutate: text => relocate(text, 'A recorded extension, or a change to a batch', 'recorded verbatim in PROGRESS.\n\n', 'An implementer that needs a path outside its fence') },
    { label: 'the census sentence moved into the next degraded bullet', file: PROTOCOL, rules: ['order:degraded'],
      mutate: text => relocate(text, "  The census is the orchestrator's own pass", 'same report shape.\n', '- **No gate agents named**') },
    { label: 'the pipeline census moved after the plan checks', file: SKILL, rules: ['order:pipeline'],
      mutate: text => relocate(text, '→ per-batch census', 'per scaffolding.md) ', '→ independent') },
    { label: 'the continue re-run moved after the cut', file: SKILL, rules: ['order:continue'],
      mutate: text => relocate(text, 're-run the `census` agent of any member', 'reach, ', "spawn ALL of the wave's implementers") },
    { label: "the wave-open clause moved after the cut", file: MODELS, rules: ['order:waveOpen'],
      mutate: text => relocate(text, ' — after any `census` agent re-run', 'calls for —,', ' create one worktree') },
    { label: 'the census paragraph made a numbered step', file: SCAFFOLDING, rules: ['steps'],
      mutate: text => swap(text, '   **Census** — once the batches are drafted', '4. **Census** — once the batches are drafted') },
    // One bad pointer each, and the fault must name it, so neither half of pointerFaults stands in for the other.
    { label: 'a passage pointing at a repository file', file: SCAFFOLDING, rules: ['pointers'], expect: 'BACKLOG.md',
      mutate: text => plantAfter(text, pinOf('pin:step3').from, ' See `BACKLOG.md`.') },
    { label: 'a passage pointing at a section protocol.md lacks', file: SCAFFOLDING, rules: ['pointers'], expect: '§Nowhere',
      mutate: text => plantAfter(text, pinOf('pin:step3').from, ' See §Nowhere.') },
    // A second copy of an anchor, and a section heading gone: the pins and orders read neither as a passage.
    { label: 'a second census paragraph opening in step 5', file: SCAFFOLDING, rules: ['pin:step3', 'order:step3'],
      mutate: text => plantAfter(text, '5. **Pre-flight**', ' **Census** — once the batches are drafted, one agent reads them all.') },
    { label: "scaffolding.md's procedure loses its closing heading", file: SCAFFOLDING, rules: ['steps', 'order:step3'],
      mutate: text => swap(text, '\n## Evidence and input baking', '\n## Evidence and inputs') },
    // Each family's first undoing planted where no pin reads.
    ...FAMILIES.map(family => ({ label: 'planted in ' + host + ': ' + family.undoings[0], file: host, rules: [family.key],
      mutate: text => text + '\n' + family.undoings[0] + '\n' })),
    // Undoings appended to a pinned document past its passages: the closed rules report each, and a family the one it names.
    ...[['Skip the census for an S-weight batch.', 'closed:mentions'], ['No census is needed for a batch whose fence holds one file.', 'closed:mentions'],
      ['One census agent reads every batch of the wave.', 'closed:mentions'],
      ["At a wave's open, re-run the census agent only for members a newly added test names.", 'closed:mentions'],
      ['When the listing fails, there is nothing to re-run.', 'closed:sentences'],
      ["Skip step 4's re-run for an S-weight member.", 'closed:sentences'], ['When the listing errors, there is nothing to re-run.', 'closed:sentences'],
      // One undoing for each word that makes the closed rule read a sentence outside a census group, and no other: the
      // re-run's words, and a listing or a diff, failing in any words or named in the plural.
      ['Skip that re-run for an S-weight member.', 'closed:sentences'], ['Never run that agent again for an S-weight member.', 'closed:sentences'],
      ['Skip the check of step 4 for an S-weight member.', 'closed:sentences'], ['Read the listing only for L-weight members.', 'closed:sentences'],
      ['If the git diff errors, no member is reached.', 'closed:sentences'], ['If the git diff times out, no member is reached.', 'closed:sentences'],
      ['When the listings fail, they count as no match.', ['closed:sentences', 'sweep:absence']]]
      .map(([sentence, rule]) => ({ label: 'appended to ' + MODELS + ': ' + sentence, file: MODELS, rules: [].concat(rule), mutate: text => text + '\n' + sentence + '\n' })),
    // Undoings planted where no pin reads: a negated rule, a narrowed one, a reworded one and a pronoun.
    ...[["A census correction that adds a checklist item does not need the user's words.", ['closed:mentions', 'sweep:words']],
      ["A census correction outside the fence does not pass §Fence changes' test.", ['closed:mentions', 'sweep:route']],
      ['A listing that fails does not count as a match.', ['closed:sentences', 'sweep:absence']],
      ['Do not run the census agent again when a pre-flight fix adds a hook.', ['closed:mentions']],
      ['The census is not required for an S-weight batch.', ['closed:mentions']],
      ['A single census agent can read every batch of a wave.', ['closed:mentions']],
      ['Only an L-weight member runs the census again.', ['closed:mentions']],
      ['Spawn the census agents once the plan is drafted. One may read several batches.', ['closed:mentions', 'sweep:several']],
      ['A recorded extension resumes the implementer at once, with no re-run first.', ['closed:sentences']],
      // Read only because a family selects it.
      ['A correction may add a checklist item on its own.', ['closed:sentences', 'sweep:words']]]
      .map(([sentence, rules]) => ({ label: 'planted in ' + host + ': ' + sentence, file: host, rules, mutate: text => text + '\n' + sentence + '\n' })),
    // The same extension planted inside §Fence changes' test, which its pin holds.
    { label: "a recorded extension resuming at once, planted in §Fence changes' test", file: PROTOCOL, rules: ['pin:fenceTest'],
      mutate: text => plantAfter(text, 'only batch-file edit is the Files line on its own branch.', ' A recorded extension resumes the implementer at once, with no re-run first.') },
    // A census rule narrowed without naming the census, where a restatement or a planning step its re-run follows says it.
    ...[[MODELS, 'the implementer updates its own Files line on its branch.',
      'the implementer updates its own Files line on its branch. A recorded extension resumes the implementer at once.', 'pin:fenceExtensions'],
    [SKILL, '(protocol §Fence changes) and is recorded in PROGRESS.', '(protocol §Fence changes) and is recorded in PROGRESS; the implementer then resumes at once.', 'pin:waveInvariant'],
    [SKILL, 'cut from the integration branch when its wave opens.', 'cut from the integration branch when its wave opens, from its batch file as the plan approved it.', 'pin:branchInvariant'],
    [SCAFFOLDING, 'audit and the detail in LOG.md.', 'audit and the detail in LOG.md. A fix that adds a file to a batch goes straight into the fill.', 'pin:preflight'],
    [SCAFFOLDING, 'and its own commit.', 'and its own commit; nothing else runs ahead of the fill.', 'pin:backlogSweep'],
    [SCAFFOLDING, 'that approval is the standing authorization for the concurrency.',
      'that approval is the standing authorization for the concurrency. An adjustment made here goes straight into the fill.', 'pin:approve']]
      .map(([file, find, replacement, rule]) => ({ label: 'in ' + file + ': ' + replacement, file, rules: [rule], mutate: text => swap(text, find, replacement) })),
    // A pronoun sentence after the census in step 4's paragraph, which no family's pattern reports.
    { label: "a pronoun sentence after step 4's cut", file: PROTOCOL, rules: ['closed:sentences'],
      mutate: text => plantAfter(text, "user's word; never delete unasked).", ' It may read every batch of the wave at once.') },
    // The rest of a census group: a paragraph and a sub-item continuing step 4's item, sentences before step 4's and step
    // 3's census passages, and one of them naming no word any rule keys on.
    { label: "a pronoun paragraph continuing step 4's item", file: PROTOCOL, rules: ['closed:sentences'],
      mutate: text => plantAfter(text, "user's word; never delete unasked).", '\n\n   It may read every batch of the wave at once.') },
    { label: "a pronoun sub-item under step 4's item", file: PROTOCOL, rules: ['closed:sentences'],
      mutate: text => plantAfter(text, "user's word; never delete unasked).", '\n   - It may read every batch of the wave at once.') },
    ...[' An S-weight member is left out of what follows.', ' The re-run below is unnecessary for a one-member wave.', ' The re-run below binds only L-weight members.']
      .map(sentence => ({ label: "planted before step 4's census:" + sentence, file: PROTOCOL, rules: ['closed:sentences'],
        mutate: text => plantAfter(text, 'whose deps are all `🟢`/`✅`.', sentence) })),
    ...[' The paragraph below is optional for an S-weight batch.', ' The agent below is optional for an S-weight batch.']
      .map(sentence => ({ label: "planted before step 3's census:" + sentence, file: SCAFFOLDING, rules: ['closed:sentences', 'sweep:optional'],
        mutate: text => plantAfter(text, 'invent a pre-verified result.', sentence) })),
    // An undoing in the unpinned part of a sentence a pinned passage covers only in part, which the pin does not vouch for.
    ...[[MODELS, "cut every member batch's branch;", "cut every member batch's branch; skip that re-run when the wave holds one member;"],
      [MODELS, "calls for —, cut every member batch's branch;", "calls for —, cut every member batch's branch (an S-weight member skips that re-run);"],
      [SKILL, 'cut branches + worktrees', 'cut branches + worktrees (skipping that re-run for a one-member wave)'],
      [SKILL, 'reach, cut branches + worktrees, spawn ALL', 'reach, cut branches + worktrees (an S-weight member skips that re-run), spawn ALL'],
      [SKILL, 'the user picks at plan approval)', 'the user picks at plan approval) → (the step two arrows back is skipped for a one-batch plan)'],
      [SKILL, 'hands-on waves + one final)', 'hands-on waves + one final) → (the next step is skipped for a one-batch plan)'],
      // The open list closed on a clause, and a word swapped for one as long before it and after it.
      [SKILL, 'preconditions (git repo; tree state', 'preconditions (git repo; tree state; the step after the checkpoints is skipped'],
      [SKILL, 'then: preconditions', 'skip: preconditions'], [SKILL, 'the user picks at plan approval)', 'the user skips at plan approval)']]
      .map(([file, find, replacement]) => ({ label: 'in ' + file + ': ' + replacement, file, rules: ['closed:sentences'], expect: normalize(replacement),
        mutate: text => swap(text, find, replacement) })),
    // A census mention inside a sentence that overlaps a pinned passage, but outside the passage itself.
    { label: 'a census mention past the pipeline\'s pinned step, in the same sentence', file: SKILL, rules: ['closed:mentions'],
      mutate: text => plantAfter(text, '→ backlog sweep (propose', ' one census agent for every batch and') },
    // The reviewed lists are exact: a phrase copied, a phrase reworded and a sentence reworded each fail.
    { label: 'a reviewed phrase copied a second time', file: SKILL, rules: ['closed:mentions'], expect: 'occurs 2 times',
      mutate: text => text + '\nThe plan checks: check-ledger.mjs runs plan, cites and census on it.\n' },
    { label: 'a reviewed phrase reworded', file: SCAFFOLDING, rules: ['closed:mentions'], expect: 'occurs 0 times',
      mutate: text => swap(text, 'grep census of every symbol', 'grep census of each symbol') },
    { label: 'a reviewed sentence reworded', file: PROTOCOL, rules: ['closed:sentences'], expect: 'the reviewed sentence is gone',
      mutate: text => swap(text, 'A repair is a `fix` batch for step 6b:', 'A repair is a `fix` batch for step 6b, too:') },
  ];
}
// A copy of `docs` under a temporary root, every document converted to CRLF.
function twinOf(t, docs) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'census-step-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }));
  for (const [file, text] of docs) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), crlf(text));
  }
  return root;
}
const hostOf = docs => [...docs.keys()].find(file => !PINS.some(pin => pin.file === file));
// What one control proves on `docs`: each rule it names fails, on a fault holding its `expect` text when it names one,
// and the CRLF twin of its mutated document, read back from `twin`, reaches the same verdict. Returns the problems
// found and the rules made to fail.
function evaluate(control, docs, twin) {
  const before = docs.get(control.file), problems = [], failed = [];
  let after;
  try { after = control.mutate(before); } catch (error) { return { problems: [control.label + ': ' + error.message], failed }; }
  if (after === before) return { problems: [control.label + ': the mutation changed nothing'], failed };
  const mutated = new Map(docs).set(control.file, after), faults = faultsOf(mutated);
  for (const key of control.rules) {
    if (faults.some(fault => fault.key === key && (control.expect === undefined || fault.text.includes(control.expect)))) failed.push(key);
    else problems.push(control.label + ': ' + key + ' stays green' + (control.expect === undefined ? '' : ' on ' + JSON.stringify(control.expect)));
  }
  fs.writeFileSync(path.join(twin, control.file), crlf(after));
  const twinVerdict = verdict(load(twin));
  fs.writeFileSync(path.join(twin, control.file), crlf(before));
  if (!isDeepStrictEqual(twinVerdict, verdict(mutated))) problems.push(control.label + ': its CRLF twin reaches another verdict');
  return { problems, failed };
}

// ===== Tests =======================================================================================================
test('the rules read the Markdown git tracks under orchestrate/, recursively, and never the prompt skeletons', () => {
  const files = domain();
  assert.ok(trackedSkill().includes(SKELETONS), 'the skeletons file is tracked, so leaving it out leaves out a real file');
  assert.ok(!files.includes(SKELETONS), 'the domain must leave out ' + SKELETONS);
  const missing = [SCAFFOLDING, PROTOCOL, MODELS, SKILL, LOG].filter(file => !files.includes(file));
  assert.deepEqual(missing, [], 'every document a rule pins is in the domain');
  assert.ok(hostOf(load(ROOT)), 'the domain holds a document no pin reads, so the sweep reaches past the pinned ones');
  assert.equal(new Set(RULES.map(r => r.key)).size, RULES.length, 'every rule has its own key');
});

test('every rule holds on the checkout', () => {
  assert.deepEqual(verdict(load(ROOT)), []);
});

// Edits the reviewed sentences leave open: each keeps every rule green, on its CRLF twin as well.
const ALLOWED = [{ label: "the new-mode pipeline's preconditions naming one word more", file: SKILL,
  mutate: text => swap(text, 'preconditions (git repo; tree state', 'preconditions (git repo; tree state; context') }];
test('an edit the reviewed sentences leave open keeps every rule green, on its CRLF twin as well', t => {
  const docs = load(ROOT), twin = twinOf(t, docs);
  const problems = ALLOWED.flatMap(({ label, file, mutate }) => {
    const after = mutate(docs.get(file));
    fs.writeFileSync(path.join(twin, file), crlf(after));
    const found = [...verdict(new Map(docs).set(file, after)), ...verdict(load(twin)).map(fault => 'its CRLF twin: ' + fault)];
    fs.writeFileSync(path.join(twin, file), crlf(docs.get(file)));
    return found.map(fault => label + ': ' + fault);
  });
  assert.deepEqual(problems, []);
});

test('each family of the undoing sweep reports what an author would write, alone, and none reports a rule as written', () => {
  const problems = [];
  for (const family of FAMILIES) {
    for (const undoing of family.undoings) {
      const by = FAMILIES.filter(f => reported(f, undoing).length).map(f => f.key);
      if (!isDeepStrictEqual(by, [family.key])) problems.push(family.key + ' must alone report ' + JSON.stringify(undoing) + ', reported by: ' + by.join(', '));
    }
  }
  for (const keeping of KEEPINGS) {
    const by = FAMILIES.filter(f => reported(f, keeping).length).map(f => f.key);
    if (by.length) problems.push(JSON.stringify(keeping) + ' states a rule, reported by: ' + by.join(', '));
  }
  // The rules as the documents state them: each family reads at least one sentence of the domain and reports none.
  const docs = load(ROOT);
  for (const family of FAMILIES) {
    if (![...docs.values()].some(text => unitsOf(text).units.some(unit => family.select(unit.sentence)))) problems.push(family.key + ' reads no sentence of the domain');
  }
  assert.deepEqual(problems, []);
});

test("every rule has a live control that makes it fail, the controls the plan named among them, each failing alike on its CRLF twin", t => {
  const docs = load(ROOT), twin = twinOf(t, docs), host = hostOf(docs), list = controls(host);
  assert.deepEqual(NAMED.filter(label => !list.some(control => control.label === label)), [], 'the named controls are all here');
  const problems = [], failed = new Set(), failedInHost = new Set();
  for (const control of list) {
    const result = evaluate(control, docs, twin);
    problems.push(...result.problems);
    for (const key of result.failed) {
      failed.add(key);
      if (control.file === host) failedInHost.add(key);
    }
  }
  assert.deepEqual(problems, []);
  assert.deepEqual(RULES.map(r => r.key).filter(key => !failed.has(key)), [], 'every rule is made to fail by a control');
  assert.deepEqual(FAMILIES.map(f => f.key).filter(key => !failedInHost.has(key)), [], 'every family reports an undoing planted where no pin reads');
});

// The harness above, held to its own word: a control that changes nothing, loses its anchor, leaves its rule green,
// fails its rule on a fault other than the one it expects, or meets a twin reading otherwise is reported.
test('the control harness reports every way a control can fail to prove its rule', t => {
  const docs = load(ROOT), twin = twinOf(t, docs);
  const plant = text => plantAfter(text, pinOf('pin:step3').from, ' See `BACKLOG.md`.');
  const own = { label: 'own fault', file: SCAFFOLDING, rules: ['pointers'], expect: 'BACKLOG.md', mutate: plant };
  assert.deepEqual(evaluate(own, docs, twin), { problems: [], failed: ['pointers'] }, 'the plant proves its own rule on its own fault');
  // A twin that reads otherwise: another document of it carries an undoing the LF documents lack.
  const stale = twinOf(t, new Map(docs).set(MODELS, docs.get(MODELS) + '\nSkip the census for an S-weight batch.\n'));
  const cases = [
    [{ label: 'unchanged', file: SCAFFOLDING, rules: ['pointers'], mutate: text => text }, twin, 'the mutation changed nothing'],
    [{ label: 'anchor gone', file: SCAFFOLDING, rules: ['pointers'], mutate: text => plantAfter(text, 'no such anchor here', '.') }, twin, 'the control needs'],
    [{ label: 'rule green', file: SCAFFOLDING, rules: ['steps'], mutate: plant }, twin, 'steps stays green'],
    [{ ...own, label: 'other fault', expect: '§Nowhere' }, twin, 'pointers stays green on "§Nowhere"'],
    [own, stale, 'its CRLF twin reaches another verdict'],
  ];
  assert.deepEqual(cases.filter(([control, root, problem]) => !evaluate(control, docs, root).problems.some(p => p.includes(problem))).map(([control]) => control.label), []);
});

test("a CRLF twin of every document reaches its LF original's verdict through the same reader", t => {
  const docs = load(ROOT), twin = twinOf(t, docs);
  assert.deepEqual(verdict(load(twin)), verdict(docs));
  // Live control: every twin holds CRLF, and read without lf the twins reach another verdict.
  assert.deepEqual([...docs.keys()].filter(file => !rawAt(twin, file).includes('\r\n')), [], 'every twin is CRLF');
  assert.notDeepEqual(verdict(load(twin, rawAt)), verdict(docs), 'read raw, the twins must read differently, or they prove nothing about lf');
});

// ===== Step 4's listing, run as protocol.md publishes it ==========================================================
// Step 4's one `git` code span, whitespace collapsed as a reader receives it.
function publishedListing(text) {
  const step = between(text, '\n4. Open the next wave', '\n5. Spawn ALL');
  assert.ok(!step.fault, step.fault);
  const spans = [...step.raw.matchAll(/`([^`]+)`/g)].map(m => collapse(m[1])).filter(span => /^git\s/.test(span));
  assert.equal(spans.length, 1, 'step 4 publishes one git command, found: ' + JSON.stringify(spans));
  return spans[0];
}
// The listing's argv once its two placeholders hold W1's base and the integration tip; it needs no shell.
function argvOf(command, base, tip) {
  const holes = command.match(/<[^<>]*>/g) || [];
  assert.equal(holes.length, 2, 'the listing holds two placeholders: ' + command);
  assert.match(holes[0], /W1's base/);
  assert.match(holes[0], /session log/);
  assert.match(holes[1], /integration tip/);
  const filled = command.replace(holes[0], () => base).replace(holes[1], () => tip);
  assert.doesNotMatch(filled, /[|&;<>$`'"\\]/, 'the filled listing needs no shell: ' + filled);
  return filled.split(' ');
}

test("step 4's listing, run as protocol.md publishes it, lists a test added, one edited and one renamed and edited", t => {
  const command = publishedListing(read(PROTOCOL));
  const repo = makeRepo(t);
  const cases = n => Array.from({ length: n }, (_, i) => "test('case " + i + "', () => {});\n").join('');
  repo.write('tests/edited.test.cjs', cases(4));
  repo.write('tests/renamed.test.cjs', cases(24));
  repo.write('tests/untouched.test.cjs', "test('untouched', () => {});\n");
  repo.write('docs/notes.md', '# Notes\n');
  const w1Base = repo.commit('W1 base');
  repo.write('tests/added.test.cjs', "const assert = require('node:assert');\nassert.ok(true);\n");
  repo.write('tests/edited.test.cjs', cases(4) + "test('edited', () => {});\n");
  fs.rmSync(path.join(repo.cwd, 'tests/renamed.test.cjs'));
  repo.write('tests/moved.test.cjs', cases(24).replace("'case 0'", () => "'case zero'"));
  const tip = repo.commit('an earlier wave');
  const listed = published => {
    const [program, ...args] = argvOf(published, w1Base, tip);
    assert.equal(program, 'git');
    const r = repo.probe(...args);
    assert.equal(r.status, 0, 'the listing must run: ' + r.stderr);
    return r.stdout.split('\n').filter(Boolean).sort();
  };
  assert.deepEqual(listed(command), ['tests/added.test.cjs', 'tests/edited.test.cjs', 'tests/moved.test.cjs']);
  // Live control: without --no-renames git reports the renamed test as a rename, which --diff-filter=AM drops.
  const renaming = command.replace(' --no-renames', () => '');
  assert.notEqual(renaming, command, 'the published listing carries --no-renames');
  assert.deepEqual(listed(renaming), ['tests/added.test.cjs', 'tests/edited.test.cjs'], 'without --no-renames the renamed test goes missing');
});
