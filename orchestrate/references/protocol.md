# The ledger protocol — canonical reference

This is the skill's single copy of the orchestration procedure. **Precedence rule: a
ledger's own contract file outranks this document — a pinned contract (one carrying a
`**Skill**` line) through its repo facts, and this document's procedure governs wherever
that contract is silent.** A pinned ledger runs under its pinned skill directory's copy of
this file, frozen by the hash. Use this file also to drive a legacy ledger that predates
the skill or lacks a contract file (§Legacy ledger recognition); a legacy contract that
carries its own procedure is driven as written.

## What a ledger is

One directory per change: `.agents/changes/<ID>/`, where `<ID> = <PREFIX>-YYYYMMDD-<slug>`
(e.g. `IST-20260713-ux-fix-pack`). The directory is committed to the repo on purpose — it
is the audit trail of an AI-assisted change. Standard files for new ledgers, including
checkpoint artifacts created later rather than at scaffold time:

| File | Purpose |
|---|---|
| `00-request.md` | The user's verbatim ask + clarifying decisions (incl. accepted backlog fold-ins) + item→batch map |
| `00-READBEFORE.md` | The contract — the change's repo facts: skill pin, boot sequence, roles/gates/tiers, git model facts, validations, version rule, conventions, prohibitions, smoke facts; its procedure is the pinned skill directory's copy of this file |
| `01-plan.md` | Locked scope: batch table (weight, wave, fence, smoke, version), wave map + checkpoints, pre-flight verdict, per-batch specs, coverage audit |
| `02-batches-NN-<slug>.md` | One per batch: wave, weight, fence, applicable guardrails, verbatim spec, checklist, acceptance criteria, tagged smoke steps |
| `PROGRESS.md` | The live ledger: `**State**` line, status + checkpoint tables, verdict log, coverage audit, one-line session log |
| `LOG.md` | Append-only narrative (reviewer arcs, root causes, reconciliations, in-run learnings), anchored per session/batch; read on demand, never at boot |
| `evidence/C<n>/` | Created during checkpoint QA, starting at the first checkpoint; QA-runner evidence per pre-verified smoke step (command, exit, output tail / screenshot path, integration SHA, environment) |
| `smoke-<Cn>.html` | Created at each checkpoint close-out; the combined checkpoint script as handed over — committed source of the smoke page |

A scaffolded ledger is a **closed system**: every repo-specific fact (validation
commands, version files, merge policy, wave map, checkpoint placement, smoke procedure,
gate agents, runners, tiers) is baked into its READBEFORE and plan at scaffold time. A
ledger references ONLY its pinned skill directory, by absolute path and hash; its
procedure is that directory's `references/protocol.md`, frozen by the hash, and every
step a tool performs also has its manual procedure there (the pasted-prompt list for
spawning, the fence's manual fallback; the validation recipe stays in the contract), so a
session drives the change from the ledger plus its pinned directory; that property is the
point. A changed skill stops the ledger at its next boot and asks, and never silently
changes how it runs. Closed
ledgers may be parked in a sibling `.agents/archive/` directory; discovery never globs it.

## Roles, gates, tiers

- **Orchestrator** — the main session. Owns PROGRESS, LOG, `evidence/`, branches,
  worktrees, integration merges, close-outs, and all user communication. The ONLY role
  that edits version files, the changelog, PROGRESS or LOG. Never switches the main
  checkout: reads any branch with `git show <branch>:./<path>` (keep the `./` — Git Bash
  on Windows mangles `branch:path`; run it from the repo or worktree root), writes through
  an integration worktree under the contract's worktree root (its boot step 2 and Git
  model), or under the session scratchpad for a contract that names none — reusing one
  `git worktree list` already shows, pruning first if its directory is gone.
  The orchestrator never polls: it never calls `ReadNotifications` to wait for a sub-agent
  and never sleeps; when the only remaining work waits on sub-agents it ends the turn, and
  the task notification resumes it.
- **Implementer** — a sub-agent given one batch. Codes inside the file fence in the
  batch's isolated worktree, ticks the batch checklist, commits on the batch branch (one
  commit per fold-in item). Wave siblings run concurrently. Its full report goes with the
  Write tool to the file its rendered prompt names, under the session scratchpad and never
  inside a worktree or the repository, in the fixed shape: its heading
  `### B<NN> R<k> <role> findings`; the status, one of
  `DONE | DONE_WITH_CONCERNS | NEEDS_FENCE | BLOCKED`; `NONCE <nonce>` (the nonce its
  rendered prompt ends with); an evidence block (each validation run's `validate.mjs` line
  and exit code; SHAs; checklist n/m); ≤40 lines of prose. `NEEDS_FENCE` / `BLOCKED` use Expected / Found / Why
  it matters / How to proceed. The final message is four lines, or three without a nonce:
  the status, `NONCE <nonce>`, `checklist <n>/<m>`, the file's path.
- **Reviewer** — ONE fresh read-only sub-agent per batch per round, never the
  implementer, never reused. Maps every hunk to a batch item (unmapped = scope creep =
  reject; the batch file's ticks are exempt), verifies acceptance criteria, runs
  validations, checks guardrails, confirms failing-on-base cells and doc sweeps. Line-1
  verdict: `SHIP` (no P0/P1; may carry ASKs) / `FIX FIRST` (P0 or P1 with a concrete
  failure scenario) / `NEEDS A CLOSER LOOK` (names what would confirm it); line 2
  `NONCE <nonce>`. The full report goes to the ONE findings file its prompt names, first
  line its LOG heading (`### B<NN> R<k> reviewer findings`); the final message is four
  lines: verdict, nonce, `P0=<n> P1=<n> ASK=<n>`, the file's path.
- **Gate agents** — optional read-only agents the contract names (e.g. a test hunter
  asking "what production mutation keeps this test green?"), run by the ORCHESTRATOR in
  parallel with the reviewer over the batch's new/changed tests. Each writes its full
  report with the Write tool to the findings file its prompt names — its only other
  writes are validation logs and disposable scratch under the session scratchpad, never
  inside a worktree or the repository — and returns four lines: its verdict, `NONCE <nonce>`, `FINDINGS <n>`, the file's path. Implementers never
  spawn them. A gate finding needing a production change is a P1; test-only → ASK.
  A test hunter proves each mutation it chooses itself with the skill's `mutate.mjs`, on a
  disposable clone of the batch's commit. The contract's mutation runner, when it names
  one, is a different tool: an optional sweep of the batch's changed files.
- **QA runner** — one sub-agent executing the agent-runnable smoke steps at a checkpoint
  close-out, writing `evidence/C<n>/`.
- **Plan pre-flight** (scaffold time) and **convergence** (change-complete) — one fresh
  read-only sub-agent each; see `scaffolding.md` and §Two close-outs.
- **Census** (scaffold time, and again on the triggers in §Fence changes and §Session algorithm
  step 4) — one read-only `census` agent per batch, never one for several batches; see
  `scaffolding.md` step 3 and `subagent-prompts.md` §Census.
- **Tiers** — the contract words them model-agnostically: the reviewer never runs on a
  less capable model than the implementer; L-weight reviews and the fresh implementer of
  an authorized third round use the most capable model the session can spawn (the
  "strong tier"); tiers unavailable →
  default, gate shape unchanged. Reconcile, status and discovery stay in-session over raw
  git output — never delegated to a cheaper model.

Neither sub-agent role has the planning session's context — every prompt is built from
the ledger files and complete in itself. Every report entering the orchestrator's
context is capped (~40 lines + findings); the fence check and tip validation return one
line each on success.

**Metrics** (the pilot's measurement, readable from the ledger alone). Batch row Notes
end with `m: rounds=<FIX FIRST rounds> asks=<ASK items closed by a polish pass>
fence-bounces=<times the fence check sent the implementer back> gate=<gate-agent
findings>/<of which needed a production change> tip-red=<1 if tip validation went red
after this merge>`; each checkpoint row's Verdict cell ends with `m: pre-smoke=<agent
steps passed>/<human steps> human-smoke-min=<minutes the user reports> escaped=<defects
the user found that no gate caught>`, completed when the user's final verdict on that
checkpoint is recorded (`escaped` counts every fail across re-runs).

## Severity and round accounting

- **P0** — wrong behavior / violated criterion or guardrail, concrete scenario. Blocking.
- **P1** — should fix, concrete scenario, needs a production change. Blocking.
- Severity is about behaviour, never the fence: a violated criterion whose fix sits
  outside the batch's files is still P0 or P1, and a residual keeps its severity wherever
  its fix lies — the fence decides only the route (`NEEDS_FENCE` → §Fence changes, a
  recorded extension), never the class.
- **ASK** — in-fence, about the batch's OWN artifacts (its new tests' strength, smoke-step
  prose, comments, a doc sweep it owns), no production behavior change. Rides under
  `SHIP` as a list. Polish pass: resume the same implementer (a fresh one when the render
  prints `FRESH` — `subagent-prompts.md` §Spawning rules) with the pointer to its
  rendered `polish` prompt (the findings file by path); it appends `- [ ] polish:`
  items to its checklist, does them, commits; closes mechanically (fence check +
  validations; polish commits touch only test/doc/prose paths — a production file touched
  → fix-diff-only re-review by a fresh reviewer). Never a round.
  Prose that is a contract — channel payload docs, exported API comments, ARCHITECTURE
  rows, USER-GUIDE claims — is never an ASK: wrong, it is P0 or P1, and `FIX FIRST`.
  An ASK on other prose carries its replacement text, whose fact the reviewer verified
  when it flagged the claim: the orchestrator applies that text itself, one edit on the
  batch branch and no implementer resume, in a commit that also appends the ask to the
  batch file as an already ticked `- [x] polish:` item in the form `02-batch.md` shows,
  and one unticked `- [ ] polish:` item per ask it leaves to the polish pass, so a crash
  before that pass meets a partial checklist in §Recovery; the polish pass takes those,
  and none left means none runs.
  A smoke-step ASK is the exception to where that edit lands: its text lives in the batch
  file's Smoke section, and the batch branch changes that file only by ticks, `polish:`
  appends and a recorded Files line (6a), so the orchestrator applies it through the
  integration worktree, in the ledger commit that records the verdict, never on the batch
  branch. That commit comes first; the batch-branch commit that lists the asks follows it,
  the smoke ask already ticked. After a crash, wherever §Recovery meets a `SHIP … asks=`
  tip with no `polish:` item listed yet — its worktree clean or holding the unfinished
  list edit — the orchestrator completes that list commit before any polish pass or
  resume, ticking each ask whose text the integration branch's batch file already
  carries; a discarded polish reverts only the batch branch and leaves that text, its ask
  closed.
  Once the polish has landed, the orchestrator classifies its diff:
  `node "<skill-dir>/tools/prose-only-diff.mjs" --repo <batch worktree> --base <pre-polish sha> --head <polish tip>`.
  `PROSE-ONLY` exempts the JavaScript files it counts from the fix-diff-only re-review,
  the other paths it counts keeping the path rule; `CODE` or `UNKNOWN` keeps the path
  rule for the whole diff. §Recovery keeps the path rule even where the classifier would
  have read the diff as prose-only — after a crash a production file → fix-diff-only
  re-review — a deliberately conservative fallback.
  The scoped re-review's verdict is recorded like any other (`R<k> <verdict> @<sha>`,
  findings in LOG.md; an R-line after the `SHIP … asks=` line is polish-phase and never
  counts toward the cap). `SHIP` → the close completes. One strike: a polish-phase
  `FIX FIRST` discards the polish at once (an ASK never licenses a production behavior
  change): write `polish discarded: @<sha>` (the pre-polish `SHIP` tip) into the row's
  Notes first — the marker §Recovery keys on, and the recorded authorization — then ONE
  revert commit spanning `@<sha>..HEAD` (never a reset — no history rewriting, the
  R-lines' SHAs stay reachable; `git diff @<sha> HEAD` must come back empty), integrate
  that reviewed tree, unclosed ASKs → backlog entries, each with its wording attached (a
  prose ASK's replacement text). Polish never turns a batch `⛔`.
- Only `FIX FIRST` rounds count toward the cap of two. Fence bounces, evidence resubmits,
  polish passes, scoped re-reviews and `NEEDS A CLOSER LOOK` checks never do — nor does a
  `FIX FIRST` a scoped re-review returns: its bound is the polish-discard rule above, not
  the cap.
- Each item of a reviewer's `SWEEP:` list (an out-of-fence prose fix carrying its verified
  replacement text) is recorded for the run-end prose sweep (§Session algorithm step 8) by a
  one-line LOG.md heading, `### prose sweep: B<NN> R<k> SWEEP <n>`, which names that
  findings entry's heading and, as `<n>`, the item's 1-based position in the `SWEEP:` list;
  the item's text is never re-typed. A prose finding outside the fence without verified
  wording keeps its present route, and so does a `SWEEP` item recorded after the sweep has
  merged (a fix-up's reviewer at a re-issue, say): no second sweep runs, and the item takes
  the backlog route with its findings heading named.
- Round 1: resume the SAME implementer with the pointer to its rendered fix-round prompt
  (the findings file by path, after the LOG append — §Session algorithm step 6); a fresh re-review
  verifies the fixes and scans only the fix diff. Reviewers are fresh every round. An
  agent gone after a crash → fresh, at the first unticked item. When the fix-round render
  prints `FRESH` (implementer context at or past the renderer's line), round 1 goes to a
  fresh implementer with its rendered `rework` prompt instead (`subagent-prompts.md`
  §Spawning rules).
- The SECOND `FIX FIRST`: `⛔ defective` (finding open, not green) or `⛔ green, residual
  finding open (<severity>)`. Both stay out of integration; once the wave's other members
  are gated and integrated the session stops instead of opening the next wave, quotes the
  open finding WITH its failure scenario, and names three verdicts for the
  user: fix again / ship with the residual / drop (a green suite alone is weak grounds
  for shipping) — meanings, recording and consumption per step 2's table.

## Status legend

| Status | Meaning |
|---|---|
| ⬜ Not Started | No commits on its branch |
| 🔄 In Progress | Wave opened (branch cut, row flipped), implementation ongoing |
| 🟢 Integrated | Reviewed, validations green on the worktree AND the integration tip, merged; awaiting its covering checkpoint |
| 🧪 At Checkpoint | A planned checkpoint is reached — awaiting the USER's combined smoke verdict |
| ❌ Smoke Failed | The USER reported a checkpoint failure triaged to this batch — the fix-up mini-batch is the next session's FIRST job. Never written for an agent-found failure |
| ✅ Passed | Its checkpoint passed; merged toward the default branch per the merge policy (verify with git, not the table) |
| ⛔ Blocked | Reviewer rejected twice (`defective`, or `green, residual finding open`), or an external blocker — left out of integration; needs the user's verdict. `⛔ (dropped)` = the user dropped it; its items live in the backlog |
| ❌ (fix-up capped) | A checkpoint fix-up failed review twice — left unmerged; needs the user's verdict |
| 👤 User Action | Waiting on something only the user can do (credentials, hardware, approvals) |

PROGRESS also carries `**State**: ACTIVE | AT-CHECKPOINT C<n> | USER-BLOCKED | COMPLETE`,
updated at every wave open, checkpoint close-out and change-complete. Statuses are
claims; **git is truth**. Reconcile before believing any row.

### Read-only evidence tools

The ledger's captured contract is authority. Changed skill files or templates do not
rewrite existing ledgers or silently add new gates. Tools collect facts; the conductor
still resolves ownership/target ambiguity and makes every Recovery decision.

Run these Node commands with explicit arguments from the repository root. `<skill-dir>`
is the contract's pinned skill directory (its `**Skill**` line; without one, the directory
holding this skill's `SKILL.md`); if unavailable or unsupported,
use the self-contained manual fallback below. Neither helper writes evidence files;
the conductor may capture stdout with the command, exit and captured SHAs.

```text
node "<skill-dir>/tools/git-evidence.mjs" discovery --repo <repo>
node "<skill-dir>/tools/git-evidence.mjs" worktrees --repo <repo>
node "<skill-dir>/tools/git-evidence.mjs" ancestry --repo <repo> --ancestor <ref-or-sha> --descendant <ref-or-sha>
node "<skill-dir>/tools/git-evidence.mjs" shipment --repo <repo> --integration <full-ref> --source local --ref <full-shipment-ref>
node "<skill-dir>/tools/git-evidence.mjs" shipment --repo <repo> --integration <full-ref> --source remote --remote <name> --ref <full-shipment-ref>
node "<skill-dir>/tools/git-evidence.mjs" ledger --repo <repo> --ref <full-ref> --ledger <id> --owner <ref-or-sha> --target <ref-or-sha>
node "<skill-dir>/tools/check-fence.mjs" --repo <repo> --integration <full-ref> --batch <full-ref> --ledger <id> --batch-id <Bnn> --batch-file <repo-relative-path>
```

Evidence stdout is one JSON object: operation, repo, completeness
(complete/partial/unknown), evidence and diagnostics. Discovery retains refs/SHAs/
symbolic targets, worktrees and ledger locations/provenance grouped by id; it never
classifies those ledgers. Ledger observations expose presence, tree, lastChange,
lastChangeTree, progressText and contractTexts at the requested ref, including archive
presence. Unavailable values are null, never absent facts. Ancestry/shipment return
captured SHAs and result contained/not-contained/unknown. Exit 0 means complete facts
(including not-contained); exit 2 means partial/unknown or invalid invocation. Read
the JSON tri-state, never infer ancestry from helper exit 0 alone. Remote shipment
queries the named remote now, without fetching; a cached remote ref is insufficient.

After the implementer report, before failing-on-base and fresh independent review,
run the mechanical fence command. It captures integrationSha, batchSha and mergeBase;
authority is the committed integration plan plus recorded authorized extensions,
never the candidate's Files line alone. PASS (exit 0) is only mechanical clearance;
VIOLATION (1) returns violations; UNKNOWN (2) returns unknowns and takes precedence
when both arrays contain diagnostics. Retain both arrays. Neither grants an extension,
changes ledger state, replaces semantic hunk mapping, or approves a merge.

Supported fence grammar: full local refs for integration and batch; a single id under
.agents/changes; unambiguous Markdown tables with #, Branch, Files (fence) in 01-plan
and #, Branch, Notes in PROGRESS; Bnn ids; exact comma-separated backtick paths (no
globs). Baseline batch Branch and Files lines must exactly match the plan; Files is
"**Files**: " followed by those paths. A unique "## Checklist" ends at the next
level-two heading. Only [ ] to [x] ticks, appended "- [ ] polish: ..." items (or
their completed ticks), and precisely authorized Files additions are permitted.
Extensions use "fence +path (Bnn, item, reason, YYYY-MM-DD)" in Notes and exactly
one matching Session log record (the row-bound short form omits Bnn); no commas in
item/reason. Unknown or legacy shapes use the manual gate, never rewritten authority.
All tools reject unknown, duplicate or missing flags; --help documents usage.

Two more helpers print lines instead of JSON, and neither writes the repository. Discovery's
summary, `node "<skill-dir>/tools/reconcile.mjs" discovery --repo <repo>`, prints one line per
ledger id (`<id> State=<value> at <locations> → <mode>`), and `reconcile.mjs rows` matches each
PROGRESS row §Recovery reconciles to its table row and Verdict (its command is there); both exit 0
when every line is known and 2 on any `UNKNOWN`, `AMBIGUOUS` or `INCOMPLETE` line.
`failing-on-base.mjs` performs step 6b in a disposable clone (its command is at that step)
and prints one line, `PROVEN`, `ALL-PASS (P0)` or `INCONCLUSIVE`, exiting 0, 1 or 2. Where
either does not run, the §Recovery table and step 6b's text are the manual procedure.

**Manual read-only fallback.** Capture refs with git rev-parse --verify ref^{commit}
before comparing; failed probes mean unknown. Enumerate ALL local/remote-tracking
branches with git for-each-ref --format='%(refname) %(symref)' refs/heads/ refs/remotes/.
Retain symbolic refs as hints but do not probe their trees. For every other full ref,
git ls-tree -r --name-only ref -- .agents/changes/ finds active ledger PROGRESS files;
also inspect .agents/changes directly in each worktree from git worktree list --porcelain.
Group the same id across locations, never pre-filter by branch name or ancestry.
Read only candidate ownership/target fields before selecting a ledger; read blobs with
git show ref:./path from the repo root. Compare ledger-subtree tree IDs and the last
ledger-changing commit (git log -1 --format=%H ref -- ledger-path), not whole tips.
Proven older copies can be superseded by the owning contract; unknown provenance,
dirty copies, divergent owners and conflicting targets remain visible/ambiguous.
Only an explicit COMPLETE or archived copy at the resolved shipment target supersedes
older candidates; ancestry alone never proves completion. Do not sweep archives into
the active inventory. Follow the frozen discovery/Recovery classification rules.

Classify from the PROGRESS preamble's State line; without it use batch-table rows and
explicit Session/verdict-log completion, never the Legend or quoted log prose.
COMPLETE is explicit and never resumed; ACTIVE/AT-CHECKPOINT or open non-human rows
remain active without a COMPLETE marker; only human-action rows open means USER-BLOCKED.
Ambiguity asks the user. Multiple active ledgers require a choice. Inspect the full
body of only the selected ledger; never copy it into the default checkout.

For ancestry use git merge-base --is-ancestor with captured SHAs: exit 0 contained,
1 not-contained, any other exit unknown. Shipment source resolution is in Recovery.
Inspect every worktree's porcelain status including untracked files and both rename
endpoints. Before status, run git check-attr filter on the paths status inspects:
a path resolving to a set filter, or a submodule, makes safe cleanliness unknown;
unspecified, unset and mere configuration do not. Never execute such filter drivers to
obtain a clean result. For the manual fence, use git diff --name-status -z -M
integration-sha...batch-sha, inspect both rename endpoints against the committed plan
union recorded extensions union own batch file; inspect that file's blob diff for
only the permitted ticks/polish/authorized Files edits. Cleanliness and parse failures
remain unknown until resolved. Report violations and unknowns separately and retain
the same fresh semantic reviewer gate. No helper or fallback changes round caps.


## Git model (generic defaults)

- An **integration branch** (default: the scaffold branch `chore/<slug>-ledger`)
  accumulates the change. One branch per batch, cut from the integration tip when the
  batch's wave opens; wave members run concurrently, each implementer in an isolated
  worktree under the contract's worktree root (its boot step 2 and Git model), or under
  the session scratchpad for a contract that names none.
- **Integration procedure, per batch**: `git merge-tree --write-tree <integration>
  <batch>` as a dry run — a conflict is STOP AND INVESTIGATE (fence violation, unrecorded
  fence extension, or a ledger file edited on both sides; git reports the conflict, not
  the cause), never hand-resolved silently → merge → run the validation commands on the
  integration tip → green: flip `🟢`; red: the tip stays non-green, no further merges,
  repair via a mini-batch (below).
- **Repairs are mini-batches.** Every repair — a red tip after a merge, a failed
  pre-smoke step, a user-reported checkpoint failure — runs on its own branch cut from
  the integration tip — `fix/<batch>-c<n>-followup` (checkpoint failure),
  `fix/<batch>-tip` (red tip), `fix/<batch>-presmoke-<step>`, `fix/<batch>-revert`
  (user-ordered revert of a merge) — through the fence check, a fresh reviewer, the dry run,
  the merge and tip validation like any batch. A repair is a `fix` batch for step 6b: it
  must carry a test that fails on the pre-repair tip (a revert is exempt — its proof is a
  green tip after the merge and a reviewer confirming the diff is the exact inverse). Never a direct commit on
  the integration branch.
- Never commit to the default branch; never push. Default policy: the USER
  smoke-tests at checkpoints and merges the default branch up to the checkpoint's
  integration commit. A scaffold-time interview may set a different policy (PR flow,
  orchestrator ff-merge on a recorded verdict, squash); the ledger's contract states
  whichever governs.
- New contracts confirm the protected default as a full local ref, plus a shipment
  source (`local` or `remote <name>`) and the full `refs/heads/<name>` on that source.
  The shipment branch must be that default on the chosen source, not an arbitrary
  feature branch. A local merge may count without a remote or push; an upstream
  merge requires current remote evidence (§Recovery). These facts do not grant
  merge/push permission and are never silently re-detected during a drive.
- Wave open = ONE PROGRESS commit on the integration branch (member rows → `🔄`,
  branches named, wave base SHA in the session log, `**State**` line updated) — the crash
  marker §Recovery keys on. PROGRESS, LOG and `evidence/` are edited ONLY on the
  integration branch, by the orchestrator, through the integration worktree (the QA runner
  writes `evidence/` files there; the orchestrator commits them); implementers
  touch only their own batch file, on their own branch, and only its checklist ticks,
  appended `- [ ] polish:` lines, and its Files line under a recorded fence extension.
- The wave map and checkpoint placement in `01-plan.md` are LOCKED: plan
  approval authorized the concurrency; deviations need the user's explicit words,
  recorded verbatim in PROGRESS (sole standing exception: a recorded `NEEDS_FENCE`
  deferral moving the final checkpoint — §Fence changes). A wave opens only when every earlier wave's members are
  `🟢`/`✅`, `⛔ (dropped)` or `👤` (dependents of those held `⬜`), the tip is green, and no
  reached checkpoint is unanswered; a `⛔` still awaiting a verdict stops the session
  before this point.
- Never `--no-verify`, never force-push, never rewrite history.

### §Fence changes (mid-wave)

An implementer that needs a path outside its fence does NOT touch it: it finishes every
item it can, commits, and reports `NEEDS_FENCE: <paths> — <item> — <why>`. The
orchestrator's test is mechanical: the path must be absent from the fence of EVERY
same-wave sibling regardless of status (a sibling already `🟢` is the dangerous case — the
extension would edit from the wave-base version and no reviewer sees the interaction)
and from every extension recorded this wave; ledger, version and changelog files never
qualify. Pass → record "fence +<path> (B<NN>, <item>, <reason>, <date>)" in the row's
Notes and the session log on the integration branch, then resume the implementer, whose
only batch-file edit is the Files line on its own branch. Fail → the batch's other items
are gated and integrated now; the deferred item is recorded in the row's Notes and the
session log as `deferred to W<n+1>: <item> (<path>)` and runs as a continuation of the
same batch in the next wave (branch `<batch-branch>-w<n+1>` cut from the tip, fence
extended then); a recorded deferral does not hold the wave open. At that wave's open the
row flips back to `🔄` with its Branch cell pointing at `<batch-branch>-w<n+1>`; the
checkpoint after wave n covers the batch's other items and the deferred item's smoke
steps ride the next checkpoint; with no later wave, the continuation is a final wave on
its own and the final checkpoint moves to after it — record the move in the
checkpoint-table row (After wave) and the session log (the recorded deferral is the
authorization to deviate from the map); wave n then closes without a checkpoint; the row
returns to `🟢` when the continuation integrates. If two batches need
the same region, the question goes in the STOP hand-off. The fence check's allowed set is the plan's fence ∪ recorded
extensions ∪ the batch's own file — never the implementer's Files line alone.

A recorded extension, or a change to a batch's plan the user authorizes (recorded verbatim in
PROGRESS, as the locked-map rule requires), that adds a file, a hook or a behaviour runs the batch's
`census` agent again before its implementer resumes or starts. Every correction it carries is committed
to the batch file's notes on the integration branch — for a running implementer before its resume,
which also carries it — and each opening item is recorded in LOG.md as carried or rejected; a
correction that needs a path outside the fence passes this section's test first, and one that adds a
checklist item or an acceptance criterion needs the user's words, recorded verbatim in PROGRESS.
Before a correction is committed, the lines it writes in words other than the report's, and a fix
chosen for a problem the report only flagged, go back to the same `census` agent by
`scaffolding.md` step 3's send-back, and the prompt of the re-run keeps that step's rule on what it
may leave out.

### Complete checkpoint inputs

The conductor inventories required files per smoke step at planning and checkpoint
close-out. Specify workbook sheets, columns, types, formulas, cached results and edge
cases; generate reproducible synthetic inputs, then independently validate against
those requirements. A digest proves byte identity, never workbook semantics. Preserve
commands, exits, observed results and environment with the issued artifacts. Identify
the exact private-data, credential or external-access prerequisite when generation
is impossible; an unavailable dependency is never pre-verified. Ordinary synthetic
preparation needs no new approval gate. Never ask the tester to construct files unless
construction itself is the behavior being tested.

Deliver the actual usable files beside the page, named/linked in each relevant step
with its expected Pass result. Provide exact read-only or working-copy and reset
instructions; modify disposable copies, never issued originals. Preserve files and
validation evidence in versioned evidence/Cn/inputs/issue-NNN/ directories. Copy raw
bytes and verify hashes in the delivered checkout, including effective Git attributes
and core.autocrlf=true when Git carries the package. Keep validation reports whose
hashes are declared under the same byte-preserving input paths. A hosted page whose
renderer cannot serve relative files needs separate usable attachments/local links
and an explicit mapping; an inaccessible URL is not a delivered download.

The sidecar has a stable-id inputs registry; each step references its exact IDs.
Each input records path, raw SHA-256, byte size, requirements, independent validation
evidence (path/hash/size, command, exit 0, result, environment), mode, use and reset.
Safe paths are relative to the HTML's artifact directory; reject absolute/traversal
paths, symlinks, missing files, directories or mismatched bytes. The builder validates
real disk bytes before writing HTML; imported calls with inputs need explicit
inputRoot. Legacy sidecars with no inputs remain usable. In a tool-less runtime,
perform these declaration, raw-file and history checks manually before hand-over.

On reissue preserve the previous page/sidecar snapshot and every prior input/evidence
file. Use a new issue path for changed bytes; inputHistory retains path/hash/size of
old artifacts no longer referenced. An issued path cannot change identity, and missing
prior artifacts are an error. Compare resolved input metadata, not just stable IDs:
changed bytes, path, requirements or use/reset/validation instructions require revision
increases for EVERY referencing existing step, including same-build corrections.
Unrelated revisions/verdicts/notes remain intact; old affected passes and pre evidence
are historical, shown as NOT RE-RUN until fresh applicable verification. The plain-text
script/results name the same files, requirements and use/reset instructions.

Record interpreter/dependency discovery as this ledger's environment fact; reusable
templates never hardcode a machine installation path. For this skill's concrete Excel
example, use literal python with openpyxl, confirm sys.executable/version, and run:

```text
python tests/fixtures/smoke-inputs/generate-orders.py <new-output.xlsx>
python tests/fixtures/smoke-inputs/validate-orders.py <workbook.xlsx> <requirements.json>
```

The fixed example is tests/fixtures/smoke-inputs/orders.xlsx with
orders.requirements.json, generate-orders.py and validate-orders.py beside it. Generate
A and B to new paths (generation refuses overwrite) and require raw
SHA256(generation A) = SHA256(generation B) = SHA256(committed workbook file bytes)
from a fresh checkout. Independently check sheets/types/formulas/caches and reject a
deliberately corrupt copy. Orders F2 is 22.50; Summary B2/B3 are 23.50/4. In a working
copy, Orders C2 from 2 to 3 recalculates F2 to 33.75 and Summary B2 to 34.75; reset by
recopying the immutable original. An actual Excel/compatible app is a human prerequisite
unless a real spreadsheet runner is available. Hash checks alone never establish this.


## Smoke checkpoints

The user smoke-tests at planned CHECKPOINTS, never per batch by default: one after
each wave carrying a hands-on batch (visible UI/UX, auth/payment/external-service
flows, migrations, destructive or hard-to-reverse operations — anything validations +
review cannot prove), plus one mandatory final checkpoint covering everything since
the last. If no hands-on work sits outside the final wave, the final checkpoint is the
ONLY one. Between checkpoints the run is autonomous. At a checkpoint the orchestrator
assembles ONE combined script — every covered batch's smoke steps, data-touching sections
first, then the rest of the hands-on work, steps numbered continuously. A reached
checkpoint is never skipped and never resolved without the user's verdict.

**Runners.** Every smoke step carries `Runner: agent` (executable in THIS ledger's
environment by a runner the contract lists — CLI, HTTP, browser, screenshot) or
`Runner: human` (hardware, credentials, feel, another OS, anything unlisted). Steps
flagged "Touches your data" are human unless the contract names a disposable fixture
environment. A step is human ONLY when it needs something an agent on this machine
cannot do: a device, a GUI, held credentials, a judgement about whether something
looks right, or something the environment contract forbids an agent here to do — the
data and another-OS grounds above are that last kind, not exceptions to this rule. A
fixture's isolation is not such a thing, and a checkpoint asks the user
for a verdict, not for labour. Before the page is issued, the QA runner executes every
agent step on the integration tip and writes `evidence/C<n>/step-NN.md` (command, exit
code, output tail or screenshot path, the integration SHA and the environment). The page
renders those steps as **pre-verified** with their evidence, collapsed but re-runnable;
human steps are unchanged; a step the runner could not perform is issued as a human step
with the reason. A failing agent step is a defect found before the user's time is spent:
rows stay `🟢`, the failure goes to Notes + evidence, a repair mini-batch fixes it, then
the close-out resumes — it is NEVER `❌`, which means the USER reached the checkpoint and
failed it. A pre-verified label is invalidated for any step whose covered files a later
repair touched; the QA runner re-runs it before the page is re-issued.

**Delivery.** The batch files' smoke steps are canonical. Use the newest committed
`smoke-*.html` in the ledger as the page's format and delivery base (or the session's
own template), update it for this checkpoint, and commit it as `smoke-<Cn>.html`.
The first checkpoint, with no committed page in the ledger, takes its sidecar's form from
smoke-page.md §Sidecar shape, never from an archived ledger.
A `smoke-<Cn>.json` sidecar beside the page is the page's source: change the sidecar
and regenerate, commit both, and never hand-edit one of them alone.
Before editing a re-issue, preserve the last issued sidecar as a temporary baseline
and compare against it during regeneration. Keep existing step numbers and order;
append new steps after them with numbers above the previous maximum. Never decrease
revisions; changes to instructions or shared section context require increases for
the affected steps.
Deliver it through the driving runtime's available HTML preview, file hand-over, or publishing
tools; reuse the existing hosted URL when the runtime can update it. Record the CURRENT
delivery location in PROGRESS's `Smoke page` field: URL, ledger-relative HTML path, or
`plain text`. When switching delivery, retain the previous hosted URL in LOG for future
reuse; never present an outdated hosted page as the current run. Include the step-0
build-identity gate essentials in text with every page hand-over.

No particular publisher or cloud verdict store is required. Without a usable HTML
delivery route or page/template, print the FULL combined script: gate first, then each
step's Do / Pass in section order, with pre-verification and carried-over results
identified. Keep a prepared page's committed audit copy even when delivering text.
Browser-local saving works without cloud synchronization where browser storage is
available. Keep storage isolated by change and checkpoint; switching runtimes, hosts,
or browsers does not transfer saved marks automatically. Use the recorded user verdicts
and the new hand-over's results; missing stored marks are not passes. Runtime-specific
publishing instructions live in the skill's `smoke-page.md`, not the generated contract.

**Verdicts are four**: **pass** · **fail** (did something else — triage to the
offending batch(es) → ❌) · **blocked** (the step could not be performed as written —
correct the STEP and re-ask, or reclassify as fail if the app lacks the behavior) ·
**works-but** (works exactly as specified, the user wants it different → named
backlog entry — never a failure, never blocks the pass). The user's message
carries the verdict — the page's "Copy results as text" paste is the preferred form,
recorded verbatim. On re-issues never renumber existing steps (verdicts key on step
numbers); annotate corrected steps instead.

**Verdict intake.** A checkpoint PASS flips every covered row `🧪`→`✅`. A FAIL indicts
batch(es) → `❌`, and the intake writes `fix-up pending: fix/<batch>-c<n>-followup[-<k>]`
into each indicted row's Notes (suffix `-2`, `-3`… when the name already exists) — the
branch step 2 and §Recovery act on; never a second line while the row's earlier fix-up
is unmerged — a further report rides that fix-up as additional failure notes (rows the
user explicitly passed → `✅`, the rest stay `🧪` for the re-run). *Waive* is the user's
recorded decision to treat the checkpoint as passed without running it. Every verdict is
quoted verbatim in the verdict log.

On page re-issues, set `BUILD_SHA` to the tested integration SHA (before the page commit).
Each step's `revision` starts at 1; increment it only when the step's instructions,
criterion or covered behavior changes, and retain it on subsequent re-issues. Save
`buildSha` and `stepRevision` with human verdicts. Preserve earlier verdicts and notes:
unchanged steps are labeled carried-over, affected steps require re-running or current
agent pre-verification. Copy results with that distinction and the current build SHA;
an old verdict on an affected step is not a fresh pass or failure. Selecting a verdict
again after a re-run records the new build/revision; editing its note does not. In plain
text, likewise identify carried-over results and affected steps still awaiting a verdict.

Agent evidence carries `pre: {sha, stepRevision, env, evidence}`: record the revision
actually tested and retain it with the original SHA until a new successful run. A
revision mismatch or missing evidence metadata requires re-verification, even on the
same build. Matching revisions from an earlier build remain applicable and are labeled
carried-over. Validate `BUILD_SHA` as a full hexadecimal Git object ID (40 or 64
characters) before loading saved verdicts or enabling input/copy; an invalid identity
must visibly stop the page without touching saved records.

Timestamp each human verdict, clear, and note edit locally as `at`, advancing beyond
the step's previous/observed timestamp. If a page store is available, persist that same
timestamp to it.
Only a strictly newer snapshot may replace an existing record; preserve verdict,
note, build identity, and revision together. Defer newer remote records while a note
is being edited and reconcile on blur. An unchanged snapshot must not rewrite local
storage; older/equal or untimed snapshots must not erase a newer local result.

## §Recovery — the reconcile table

Resolve shipment before inferring a silent merge. Use the ledger's recorded default
and shipment target, never the current branch, `init.defaultBranch`, or a guessed
`main`/`master`. Preserve an older contract's unambiguous recorded local-target
semantics; missing new field names alone do not require migration. With no contract,
use explicit target/merge semantics from the plan or PROGRESS; if absent or ambiguous,
ask and record the answer before inferring shipment. Missing, contradictory or renamed
targets require a recorded correction, never silent substitution or contract rewriting.
The integration branch must be distinct from the default and shipment branches.

Resolve the integration branch's full local ref to `<integration-sha>`. Resolve
`<shipment-sha>` from the recorded source:

- `local`: `git rev-parse --verify <shipment-ref>^{commit}`. This needs no remote;
  an unpushed local merge counts under this policy.
- `remote <name>`: read `git ls-remote --exit-code <name> <shipment-ref>` now and
  take the SHA of the exact matching ref. Verify that object exists locally as a
  commit before testing ancestry. A cached `refs/remotes/...` value alone does not
  establish current upstream state. A failed query, missing ref or missing object
  leaves shipment unknown; do not fetch or update remote metadata automatically.

Use these captured SHAs for the shipment test; exit 0 means contained, 1 means not
contained, any other error means unknown. Different local/remote tips do not matter
when the recorded source is clear. Unknown shipment never flips rows or authorizes
cleanup. Target ambiguity blocks actions depending on that target; independent
read-only discovery/status may continue. Record the source, ref and SHAs with an
inferred shipment. Existing merge/push permissions still apply.

For each PROGRESS row not `✅`/`👤`/`⛔ (dropped)`, gather: branch exists? (`git rev-parse --verify`),
integrated? (`git merge-base --is-ancestor <branch> <integration>`), shipped?
(`git merge-base --is-ancestor <integration-sha> <shipment-sha>` only after source
resolution above), commits ahead
(`git log <integration>..<branch> --oneline`), dirty trees (`git status --porcelain`
in each worktree from `git worktree list` that holds the row's branch — the main
checkout only when it holds that branch), and the checklist
state inside the batch file on that branch (`git show <branch>:./<path>`, from the root).
Rows are matched top to bottom; the first match wins.
`node "<skill-dir>/tools/reconcile.mjs" rows --repo <repo> --ledger <id> --integration <full-ref>`
gathers these facts and prints, per row, the table row it matches and that row's Verdict
(`<Bnn> <status> row <k>: <Verdict>`); the conductor still decides and acts, and a row it
prints as `UNKNOWN` is reconciled by hand from this table.

| Ledger says | Git shows | Verdict |
|---|---|---|
| any row whose Notes end in a spent *fix again* (`third round on <branch> @<sha>`) | no commit after `@<sha>`, branch not yet an ancestor of the integration branch | Crashed before the third round landed → re-spawn the FRESH strong-tier implementer per step 2's table |
| any row whose Notes end in a spent *fix again* | commits after `@<sha>`, branch not yet an ancestor of the integration branch | Third round landed → worktree dirty: re-spawn the FRESH strong-tier implementer at the open findings; clean: fence check, then the fresh re-review with both rounds' findings |
| any row whose Notes carry a `… capped:` marker not followed by a later `verdict … spent` (a marker re-written after a spent line counts as awaiting) | any | Awaiting the user's verdict on that repair (fix again / ship with the residual / drop; ship / drop only after a spent *fix again*) — do not re-gate, do not re-spawn; a recorded verdict is consumed by step 2 |
| any row whose Notes carry a `… repair pending:` marker (`tip repair pending:` / `pre-smoke repair pending:`) with no later spent *ship* / *drop* verdict (those retire it unmerged) | any | In-flight repair — branch missing: spawn it on the named branch; no commit after the marker's `@<sha>`: never started → resume the implementer on that branch (fresh worktree); commits after `@<sha>` but not integrated: resume / gate it per the 🔄 rows on that branch (never a same-named new one); integrated: tip validation (a pre-smoke repair also re-runs its step), remove the marker, then continue per step 2 (tip: back to step 7 or 4; pre-smoke: resume the close-out) |
| 🔄, Notes carry `polish discarded: @<sha>` | branch not an ancestor of the integration branch | Discard in flight → branch tree differs from `@<sha>`: finish the revert (ONE commit spanning `@<sha>..HEAD`; never a reset); tree identical (`git diff @<sha> <tip>` empty): integrate now (dry run → merge → tip validation); the marker stays as the record |
| 🔄 | Notes record `R<k> SHIP @<sha>` (no `asks=` on that line) for the current tip | Reviewed, crashed before the merge → integrate now, no re-review |
| 🔄 | Notes record `R<k> SHIP @<sha> asks=<n>` for the current tip, worktree clean | Shipped with ASKs, crashed before the polish → polish pass (ASK list in LOG.md), then its mechanical close |
| 🔄 | Notes record `R<k> SHIP @<sha> asks=<n>`, commits after `@<sha>`, worktree clean, every `polish:` item ticked (at least one appended) | Polish landed, crashed before its close → 6a + validations on the tip; `git diff --name-only <sha>..HEAD` touches only test/doc/prose paths → integrate; a production file → fix-diff-only re-review by a fresh reviewer |
| 🔄 | Notes end in `R<k> FIX FIRST @<sha>` for the current tip | Round in flight, fix not landed → resume the implementer (fresh) with that round's findings from LOG.md; not a round |
| 🔄 | branch missing, or no commits past the wave base | Implementer never landed → re-spawn it (fresh worktree) |
| 🔄 | dirty worktree, or commits ahead + partial checklist (incl. unticked `polish:` items; a recorded deferral is not a partial checklist) | Resume the implementer — a fresh agent, the original is gone — at the first unticked item (recreate the worktree if gone; a `SHIP … asks=` line with no `polish:` items yet → the ASK list in LOG.md) |
| 🔄 | commits ahead, checklist fully ticked | validations green → crashed before the gate → fence check, then the reviewer gate now (latest `R<k>` line is `FIX FIRST @<sha>` → the round-<k+1> re-review, recorded `R<k+1>`: verifies that round's findings from LOG.md, scans `git diff <sha>..HEAD`); red → resume the implementer (fresh) with the failing output, not a round |
| 🔄 | branch already an ancestor of the integration branch | Crashed between merge and flip → tip validation, then 🟢 (red → repair mini-batch) |
| 🟢 (every member of a checkpoint-carrying wave is 🟢, ⛔ or 👤 — verdict or not) | checkpoint row not 🧪/✅ | Close-out unfinished → integrate any 🟢 member whose branch is not yet an ancestor of the integration branch (dry run → merge → tip validation), then finish the close-out (tip validation → pre-smoke → page → 🧪); never open the next wave |
| 🟢 | branch NOT an ancestor of the integration branch | Crashed between review and merge → integrate now (dry run → merge → tip validation) |
| 🟢 | branch ancestor of the integration branch | Correct state — waits for its covering checkpoint |
| 🧪 | shipment check confirms integration tip contained in the recorded shipment target | User merged silently → flip the checkpoint's covered rows ✅, propose branch deletes |
| 🧪 | shipment unknown or target ambiguous | Do not infer a pass or propose cleanup; resolve the target/evidence or ask the user for the checkpoint verdict |
| 🧪 | shipment check confirms integration tip not contained | Correct state → ask the user for the checkpoint verdict |
| ❌ (not fix-up capped) | no branch named by the latest `fix-up pending:` Notes line | Fix-up never started → spawn it on that branch |
| ❌ (not fix-up capped) | that branch ahead, not integrated | Resume / gate it per the 🔄 rows (a `SHIP` there continues step 2's fix-up flow: → 🧪 → re-issue, never 🟢) |
| ❌ (not fix-up capped) | that branch integrated, tip green | Covered rows → 🧪, re-issue the page with affected steps annotated |
| ❌ (not fix-up capped) | that branch integrated, tip red | Repair mini-batch on the tip first |
| ⛔ (either kind) or `❌ (fix-up capped)` | any | Awaiting the user's verdict (fix again / ship with the residual / drop; ship / drop only after a spent *fix again*) — do not re-gate, do not re-spawn; dependents stay ⬜; a recorded verdict is consumed by step 2 |
| ⬜ | a branch with the batch's planned name already exists | Wave-open crashed before its flip (or a name collision) → nothing to reconcile now; step 4's idempotent cut adopts or stops when this wave opens |
| ⬜ | no such branch | Correct state — waits for its wave |

Prune worktrees of integrated batches (`git worktree remove`). Log every
reconciliation: one line in the PROGRESS Session log, detail in LOG.md.

At the FINAL checkpoint the Close-out unfinished row's close-out begins with the run-end
prose sweep whenever LOG.md holds a `### prose sweep:` heading, resumed from its branch by
§Session algorithm step 8's adoption rule.

Before any polish pass or resume at a `SHIP … asks=` tip whose batch file lists no
`polish:` item yet, its worktree clean or dirty, the orchestrator completes the list
commit, as §Severity and round accounting says for a smoke-step ASK.

## §Session algorithm ("continue")

1. Boot + reconcile + resume-time validation (validation commands on the
   integration tip; red → step 2 first). A contract carrying a `**Skill**` pin line
   verifies it FIRST, before reconcile: `node "<skill-dir>/tools/check-ledger.mjs" skill
   --contract <ledger-dir>/00-READBEFORE.md` from the integration worktree root —
   `SKILL MATCH` continues; anything but `SKILL MATCH` (including a tool that does not run)
   STOPs and asks, continuing only
   on the user's explicit words recorded verbatim in the session log, which pick one of two
   ways on: an upgrade (the pin line rewritten to the new directory and hash in the commit
   that records them, the change continuing under the new directory's copy of this file)
   or a restore (the pinned directory rebuilt byte-for-byte from the contract's
   `**Skill source**` line, then the pin check re-run, continuing only on `SKILL MATCH`);
   the contract's validation recipe never depends on the pinned directory. The pinned
   directory's copy of this file then governs the session beside the contract. Such a
   contract runs every validation — resume-time and tip validation alike — through
   `node "<skill-dir>/tools/validate.mjs" --spec <ledger-dir>/validate.json --log <file>`:
   its one line is the result, its exit code the real one, and the log is read only when
   the line is not PASS. Never pipe or tail it; when it may outlast the runtime's command
   timeout, run it as a background task whose completion reports the one line and the exit
   code, and never read the log before it exits. Without a pin line, or when the wrapper is
   unavailable, the manual procedure is the validation commands in their quiet form.
2. Repairs first, as mini-batches (Git model).
   - **Checkpoint failure** (`❌`): spawn ONE fix-up implementer on the branch the
     verdict intake recorded in Notes as `fix-up pending: fix/<batch>-c<n>-followup[-<k>]`
     (suffix `-2`, `-3`… when the name already exists — a second ❌ on the same batch and
     checkpoint is a NEW fix-up, and a fail on a step annotated as a known residual
     re-indicts), cut from the integration tip, with the user's failure notes VERBATIM +
     the indicted batch file(s) + the diff since the last passed checkpoint (the Base SHA
     before the first); fence check → fresh reviewer (spec = the
     failure report + the batch's acceptance criteria) → dry run → merge → tip validation
     → rows back to 🧪 → STOP, re-issuing the checkpoint's script per §Smoke checkpoints
     (republish with the affected steps annotated — earlier verdicts survive; or reprint
     the text; bump the PATCH marker before re-issuing so step 0 can tell the repaired
     build from the one just tested). Failing review twice → `❌ (fix-up capped)`, left
     unmerged (the status stays through a third round; the round's `SHIP` flips the row
     to `❌` in the commit recording it, and the fix-up proceeds from its dry run).
   - **Red tip with no checkpoint reached** (resume-time validation, or after a merge):
     the same mini-batch on `fix/<batch>-tip` (`<batch>` = the last batch merged before
     the red) with the failing output as the spec; once green, return to step 7 or step 4
     — no 🧪, no STOP. Failing review twice → rows keep their status, the tip stays red
     (no further merges). A tip the run-end prose sweep's merge turned red (step 8) takes
     this repair, the sweep counting as the last batch's merge, and once green the run
     returns to the close-out, not to step 7 or 4.
   - **Failed pre-smoke step** (step 8): `fix/<batch>-presmoke-<step>`; failing review
     twice → the step is issued as a HUMAN step carrying the failure note.
   - **Pending markers**: spawning a `-tip`/`-presmoke` repair writes `tip repair
     pending: <branch> @<sha>` / `pre-smoke repair pending: step NN, <branch> @<sha>`
     (`@<sha>` = the tip the branch was cut from) into the affected batch's Notes in the
     same commit (the phrases §Recovery keys on, like `fix-up pending:`); the marker is
     removed in the commit that records the repair's merge, and a consumed *ship* /
     *drop* verdict retires it unmerged (the spent line supersedes it).
   - **Capping** never writes `❌` for a `-tip`/`-presmoke` repair. Every capped repair
     writes `tip repair capped: <branch>` / `pre-smoke repair capped: step NN, <branch>` /
     `fix-up capped: <branch>` into the affected batch's Notes (the phrases §Recovery keys
     on) + LOG, and the session STOPs naming three verdicts. Verdicts are recorded
     verbatim in the verdict log (Checkpoint column `B<NN>`) and consumed EXACTLY ONCE:
     the consuming session appends `verdict <date> <fix again|ship|drop> spent → <what it
     did>` to the subject row's Notes (a spent *fix again* names the round's branch and
     tip: `third round on <branch> @<sha>`), and whenever a repair returns to the capped
     state it re-writes its `… capped:` marker after that line. After a spent *fix
     again*, the re-ask offers only ship / drop — no fourth round. Every `⛔ (dropped)`,
     by any route, raises the ⬜-dependents question at the next STOP. "Merge only if the
     tip then validates green" means a TRIAL first: the dry run (`git merge-tree
     --write-tree <tip> <branch>`; a conflict → STOP AND INVESTIGATE, as in the
     integration procedure), then `git commit-tree <tree> -p <tip> -m trial`, check that
     commit out in a temporary worktree (`git worktree add <scratchpad>/wt-trial
     <commit>`; a stale `wt-trial` from a crashed trial is removed first), run the
     ledger's per-worktree setup there (skip only if `n/a`), then run the validations
     and remove the worktree; green → merge for real; red → no merge. A setup failure
     blocks the trial and the merge as an environment problem, not a red validation
     result; resolve setup and retry the trial before deciding whether to merge.

   | Subject | fix again | ship with the residual | drop |
   |---|---|---|---|
   | ⛔ batch | authorized third round: a FRESH implementer on the strong tier, on the batch branch (row → 🔄), both rounds' findings + the current diff, then a fresh re-review; `FIX FIRST` again → ⛔ (kind per step 6; the recorded `R<k> FIX FIRST` line now ends the Notes) | only for `⛔ green, residual finding open` (a `⛔ defective` is fixed again or dropped): integrate per the integration procedure; residual → severity-tagged backlog entry + one `Runner: human` smoke step the orchestrator authors into the batch file's Smoke section AFTER the merge, on the integration branch (next checkpoint page, or a re-issue of the passed one) | `⛔ (dropped)`; items → backlog; its ⬜ dependents re-planned or dropped on the user's words, asked at the same STOP |
   | capped `-tip` repair | third round on the repair's own branch; `FIX FIRST` again → capped, marker re-written | trial-validate, then merge only if green (the open finding → backlog + smoke step); trial red → no merge, stays capped, marker re-written, ask again | reviewed revert mini-batch `fix/<batch>-revert` of the offending merge; that batch → `⛔ (dropped)`, items → backlog |
   | capped `-presmoke` repair | as above | the human step stands; residual → backlog | as ship; the repair branch is deleted (the recorded drop is the authorization) |
   | `❌ (fix-up capped)` | third round on the fix-up's own branch; `SHIP` → row ❌ and the fix-up proceeds (dry run → merge → tip validation → 🧪 → re-issue); `FIX FIRST` again → capped, marker re-written | trial-validate, then merge only if green; indicted rows → 🧪; re-issue with the failing step annotated as a known residual (backlog) | reviewed `fix/<batch>-revert` of the indicted batch's merge; that batch → `⛔ (dropped)`; the rest → 🧪 for the re-issue |

   Wherever this document routes an item to the backlog — this table's cells, §Severity and
   round accounting's discarded polish and its `SWEEP` items that keep or take the backlog
   route, the Status legend's `⛔ (dropped)` batch, a works-but verdict, the convergence
   pass, step 8's run-end prose sweep returning an item or its reviewer's `FIX FIRST`
   reverting one, and any other dropped item — the orchestrator records it as a residual: a
   LOG.md heading `### residual: <source> — <one line>`, `<source>` being `B<NN> R<k>`,
   `B<NN> R<k> SWEEP <n>`, `B<NN> R1 sweep`, `C<n> step <k>`, `convergence` or `audit`, that
   names the byte-copied findings heading holding the item's wording, or carries the wording
   when no findings file holds it; the change-complete ruling step decides it.
3. If any batch is `🧪`: a checkpoint is open — ask the user for its verdict (passed /
   failed / waive). Never open the next wave past an unanswered checkpoint. A checkpoint
   whose close-out has not run — every member of its wave 🟢, ⛔ or 👤 and its row not
   🧪/✅, §Recovery's Close-out unfinished row — goes to step 8's per-checkpoint close-out
   before any wave opens. A ledger with every row ✅ or `⛔ (dropped)` (advisory `👤` rows
   aside) and no COMPLETE marker, met by `continue` or `close`, goes to the change-complete
   close-out's first unfinished step.
4. Open the next wave: the earliest wave that still has `⬜` batches (or a recorded
   deferral) whose deps are all `🟢`/`✅`. From the second wave on, before the cut, run the
   `census` agent again for each member whose fence path a test added or changed by an
   earlier wave names — the path itself, its basename or a directory holding it — taking the
   tests among the files
   `git diff --name-only --no-renames --diff-filter=AM <W1's base, from the session log>..<the integration tip>`
   lists (a listing that fails counts as a match), and commit the corrections it carries into
   the member's batch file on the integration branch, each opening item recorded in LOG.md
   as carried or rejected, so every member branch starts from them. A correction that needs a
   path outside the member's fence is first recorded as an extension under §Fence changes'
   test, and one that adds a checklist item or an acceptance criterion needs the user's
   words, recorded verbatim in PROGRESS. The lines the census's corrections write in other words,
   and any fix chosen for what it only flagged, go back to the same agent before they are
   committed, as §Fence changes says. Once a member branch of this wave exists at the
   integration tip — an open that crashed after its cut began — no census runs again at
   this open, so the cut below adopts the branches cut from the corrected tip.
   From the integration tip: cut every member's branch, create every
   worktree (setup: the ledger's per-worktree setup), then commit the wave-open PROGRESS flip
   (rows → 🔄, wave base SHA in the session log, `**State**: ACTIVE`).
   The cut is idempotent: a member branch that already exists with its tip equal to the
   current integration tip is adopted from a crashed open — its worktree, if any, removed
   and recreated (fresh setup); a member branch in any other state → STOP AND INVESTIGATE
   (name collision, or a stale base from an earlier crashed open — re-cut only on the
   user's word; never delete unasked).
5. Spawn ALL of the wave's implementers CONCURRENTLY (one per batch, in a single
   message, each pinned to its worktree, on the tier the batch's weight calls for).
   Render each prompt first, from the integration worktree root:
   `node "<skill-dir>/tools/prompt.mjs" --ledger <ledger-dir> --role implementer --batch <Bnn> --facts <facts.json> --out "<session scratchpad>/prompts"`
   (`--help` lists each role's facts) prints `PROMPT <path> NONCE <nonce>`; spawn the
   agent with this fixed pointer message, `<prompt file>` replaced by that path:
   `Your complete instructions are in the file <prompt file>. Open it with the Read tool before doing anything else and follow it to its last line, which gives your report's exact line 2.`
   Keep the nonce for the gate (step 6); it never enters the pointer. The roles whose report
   is a file take two more facts: `reportFile`, the file the orchestrator names under the
   session scratchpad, and `round`, `1` for a first implementer report, `<k>` for fix round
   `<k>` or the rework standing in for it, and the `SHIP … asks=` round for a polish report.
   When the renderer
   is unavailable or refuses (`UNKNOWN …`), the manual procedure is a pasted prompt with
   no nonce line, and every such prompt must be SELF-CONTAINED: the spec text + codebase
   facts from the batch file, the exact file fence, acceptance criteria, the applicable guardrails, the
   validation commands (the wrapper command and its recipe), the contract's conventions +
   prohibitions blocks, the
   report shape, and "tick your checklist items in the batch file as you complete them;
   run `git diff --name-status -M` against the integration branch before committing and
   revert anything outside your fence; commit on your batch branch (one commit per
   fold-in item)".
6. Gate PER BATCH, as each implementer reports (don't wait for the wave's slowest). A
   report without the status line + evidence block, or with the wrong nonce (line 2 not
   `NONCE <the nonce the renderer printed>`: the agent did not read its prompt to the end),
   is no report → resume the implementer for it (not a round). The roles whose report is a
   file have it checked with `node "<skill-dir>/tools/prompt.mjs" --report "<file>" --nonce <nonce>`,
   `<file>` the path on the final message's last line (without `--nonce` for a fix-up or a
   pasted prompt, which ends with no nonce line); a `REPORT FAIL …` line, or an `UNKNOWN` line
   naming the report file, is no report, resumed the same way, and only
   `REPORT <status> checklist <n>/<m>` is a report. A check that does not run, or prints any
   other `UNKNOWN` line, leaves the rule before it as the manual procedure, read from the
   file's status, `NONCE` and `EVIDENCE:` lines alone. The orchestrator never reads the
   report file in full: anything that needs the whole report reads the file itself, and the file reaches
   LOG.md by the published append (Verdicts, below), its heading the file's first line, in the
   commit with that gate step's PROGRESS update. No later prompt takes that file as its
   findings file, so the recovery form below never meets it, and a resumed implementer
   writing the same heading a second time is harmless.
   - **6a Fence check (mechanical, orchestrator).** Run the read-only helper above
     or its manual fallback. Worktree clean (`git status
     --porcelain` empty); `git diff --name-status -M <integration>...HEAD`; every
     path (both endpoints of a rename) in the plan's fence ∪ recorded extensions ∪ the
     batch's own file — and within the batch file only ticks, `polish:` appends and a
     recorded Files change. Anything else → no reviewer; `NEEDS_FENCE` → §Fence changes,
     otherwise resume the implementer to revert. Not a round.
     For each fold-in the plan's §Backlog fold-ins marks `(prose-only)`
     (`<id> — <text> → B<NN> (prose-only)`; an unmarked fold-in is gated as any other), the
     orchestrator proves its own commit, the one whose message carries its id: it first reads
     that commit's paths with `git show --name-only --no-renames --format= <sha>`, and a commit
     changing only Markdown is decided by the path rule; otherwise the classifier of §Severity and
     round accounting runs with its `--base` the commit's parent and its `--head` the commit.
     A cause that begins `code changed`, or a changed path that is neither Markdown nor
     JavaScript, returns the fold-in: one commit on the batch branch reverses only that
     commit's own changes (`git revert --no-commit <sha>`, then
     `git restore --source=HEAD --staged --worktree -- <batch file>` so its tick stays; never
     the files' parent content, which would also undo the batch's later commits to them), the
     row's Notes get `fold-in returned: <id> @<sha>`, and the item stays in the backlog.
     A returned fold-in is not proved a second time at any later 6a of the batch. A
     revert whose conflicts outlast that restore (a later commit of the batch changed the same
     lines) is abandoned with `git revert --abort`; the fold-in then stays, and the reviewer
     reads its commit under the path rule. For a returned fold-in, before the reviewer is
     rendered, a ledger commit adds to the batch file's notes on the integration branch
     `[<id>] returned to the backlog at 6a: its checklist item and acceptance criterion no longer apply`,
     so the reviewer holds the batch to the rest. Any other cause keeps the fold-in, the reviewer reading its kept lines under
     the path rule, and an `UNKNOWN` line keeps the path rule for that commit, which the
     reviewer applies.
   - **6b Failing-on-base (mechanical, `fix` batches and repairs).** In a temporary
     worktree at the branch's base, run the ledger's per-worktree setup there (skip only if `n/a`),
     then copy over the batch's TEST-ONLY files and run its changed tests: an
     assertion failure on the named behavior proves the regression test; every test
     PASSING on the base is a P0 (the fix is unproven); a setup failure or a run that
     cannot execute is inconclusive → reviewer duty (e).
     `node "<skill-dir>/tools/failing-on-base.mjs" --repo <repo> --base <integration-ref> --batch <batch-ref> --validate <ledger-dir>/validate.json --log <file>`
     (adding `--setup <ledger-dir>/setup.json` where the ledger has one; the log outside the
     repository) performs this step in a disposable clone and prints one line, the
     failing-on-base result the reviewer receives: `PROVEN (…)` names the tests that fail on
     the base, the proof reviewer duty (e) confirms; `ALL-PASS (P0)` is the P0 above;
     `INCONCLUSIVE (…)` gives its reason and goes to reviewer duty (e). Any other line, or a
     tool that does not run, leaves the text above as the manual procedure.
   - **6c Reviewer + gate agents, in parallel, all fresh and read-only.** Each is
     rendered and spawned as in step 5 (`--role reviewer`, `reviewer-round2` or
     `test-hunter`); a gate report with the wrong nonce is no report and its agent is
     respawned fresh. The reviewer gets the batch file + the diff (`git diff <integration>...HEAD` in the batch's
     worktree — three-dot isolates the batch's own changes) and must (a) map every hunk
     to a batch item — unmapped hunks are scope creep → reject (the batch file's ticks are
     exempt); (b) check each acceptance criterion against the diff; (c) run the
     validation commands; (d) check the diff against the project guardrails doc and the batch
     file's applicable guardrails; (e) confirm the failing-on-base result from 6b — an
     INCONCLUSIVE run means the reviewer establishes from the test text which changed
     cell fails on the un-fixed code, or says none does — and, when no gate agent runs,
     name the mutation each new or re-pointed test would survive; (f) confirm every doc/comment sweep the batch file names
     happened in the same commit. Gate agents run over the batch's new/changed tests
     (skipped when none changed); a gate finding that needs a production change is a P1,
     a test-only finding is an ASK. S-weight batches: one combined reviewer+gate pass.
   - **Verdicts** (each recorded in the row's Notes as `R<k> <verdict> @<sha>`, `asks=<n>`
     appended when a `SHIP` carries ASKs; the findings go to LOG.md under the row's
     heading: every findings file reaches LOG.md first, closed by a newline and a marker
     line — from the integration worktree root,
     `(cat -- "<findings file>" && echo && echo '=== end of B<NN> R<k> <role> findings ===') >> <ledger-dir>/LOG.md`
     in Git Bash or an equivalent
     byte copy, never re-typed through the orchestrator's context, committed with the
     PROGRESS update — and only then is its path forwarded to the polish, fix-round, rework or
     round-2 prompt; a copy lost with the scratchpad
     is taken back out of the committed LOG.md, never re-typed — from the repository root
     in Git Bash,
     `git show <integration-branch>:./<ledger-dir>/LOG.md | F="<findings file>" awk -v h='### B<NN> R<k> <role> findings' -v m='=== end of B<NN> R<k> <role> findings ===' '$0 == h {n++; p = 1} $0 == m {e++; d += p; p = 0; next} p {o = o s $0; s = ORS} END {if (n != 1 || e != 1 || d != 1) exit 1; printf "%s", o > ENVIRON["F"]}'`
     exits non-zero, writing nothing, unless its heading and marker line each occur
     exactly once, and only after a zero exit is that file forwarded). Verdict handling —
     the polish pass, fix rounds and the cap — is §Severity and round accounting's, with
     the prompts of `subagent-prompts.md` §Spawning rules. `NEEDS A CLOSER LOOK` → run the confirming check the
     reviewer named (or have the implementer add the probe) → `FIX FIRST` or `SHIP`; not a
     round. After the second
     `FIX FIRST` → ⛔ (defective / green-residual), left out of integration, dependents
     blocked, STOP with the three verdicts.
7. Integrate serially, per the integration procedure: dry run → merge → tip validation →
   `🟢`, apply the version/changelog cadence, remove the worktree, write the row's Notes
   (SHA, reviewer arc, tier, residuals) ending with the metrics token
   `m: rounds=<n> asks=<n> fence-bounces=<n> gate=<findings/prod> tip-red=<0|1>`. A red
   tip → repair mini-batch before any further merge.
8. Wave closed. The window at the end of this step, where the conversation may be cleared,
   opens before a checkpoint's close-out begins.
   If the checkpoint table places a checkpoint here: per-checkpoint close-out (a ⛔
   member's steps are omitted from the page and appended on re-issue if it later ships) —
   version/changelog per cadence, tip validation, QA runner pre-smoke with evidence,
   covered rows `🟢` → `🧪`, checkpoint-table row, session-log row with the checkpoint's
   integration SHA, `**State**: AT-CHECKPOINT C<n>`, the checkpoint row's token
   `m: pre-smoke=<agent>/<human> human-smoke-min=<n> escaped=<n>` (completed when the
   user's verdict is recorded), the filled smoke page as `smoke-<Cn>.html` when a page
   was prepared, then **proof the published artifact** (§Two distinct close-outs), commit
   → STOP, delivering the checkpoint's COMBINED smoke script per §Smoke checkpoints. Otherwise: go to step 4 and open the next wave in this SAME
   session. Default cadence: run until the next checkpoint — stop early only at `⛔` or
   an unplanned user gate.
   **Run-end prose sweep.** Whenever LOG.md holds a `### prose sweep:` heading, the FINAL
   checkpoint's close-out begins with this sweep; plan approval is its standing OK, and it
   runs alone, so §Fence changes' mid-wave test passes trivially. The orchestrator first
   commits `prose sweep cut @<sha>` to the session log, `<sha>` the integration tip just
   before that commit, then cuts `fix/<batch>-prose-sweep` (`<batch>` the last batch merged)
   AT that SHA, so the branch starts one ledger-only commit behind the tip and a crash after
   the cut always finds the record; its worktree is `<the contract's worktree root>/sweep`,
   or under the session scratchpad for a contract that names no root. A branch of that name
   whose tip equals that SHA is adopted and its items applied; one with commits past it, not
   yet an ancestor of the integration branch, resumes (the missing items applied, then the
   check and the reviewer); one with commits past it that is an ancestor is the merged sweep
   (→ tip validation and the session-log row); any other, one that does not descend from that
   SHA (`git merge-base --is-ancestor <sha> <branch>` fails: a leftover from before this run),
   is STOP AND INVESTIGATE. Ancestry alone never proves the merge, since a branch cut and not
   yet committed to is trivially an ancestor. The orchestrator applies each item's
   replacement text from its findings entry itself, one commit per item, its subject naming
   the item's heading, and classifies each item's commit as step 6a proves a prose-only
   fold-in, a return there reverting that commit and sending the item to the backlog route.
   The mechanical check is manual: worktree clean, and every changed path, both rename
   endpoints, one that a recorded item names. ONE fresh reviewer, its prompt written in the
   scoped re-review's shape (the sweep's changes, the items, duties 1, 2 and 4), has its
   findings reach LOG.md under `### B<NN> R1 sweep findings` by the published append (step
   6); its `FIX FIRST` reverts each item it names and sends it to the backlog route — one
   strike, never a round, never ⛔. Then dry run → merge → tip validation, a red tip going to
   step 2's tip repair. The sweep being the close-out's first step, a crash in it meets
   §Recovery's Close-out unfinished row, the rows staying 🟢 and State ACTIVE throughout, and
   the close-out resumes the sweep from its branch by the adoption rule above (no branch:
   cut at the recorded SHA). The session-log row records
   `prose sweep: <n> item(s) @<merge sha>`.
   Compaction happens only at a safe point, never mid-flight: a wave close, the start of a
   checkpoint close-out, or the moment a checkpoint's fix-ups have all merged, before their
   rows go back to 🧪 and the re-issue (never after a capped fix-up's *ship*: its row still
   reads as awaiting a verdict) — each counting only once PROGRESS and LOG are
   committed and no agent is in
   flight. The compaction rules of this step cover both orchestrate-mod's automatic clear
   and `/compact`; those about the mod's tool, its answers and the session a clear opens
   apply only to the clear.
   At a wave close where the checkpoint table places a checkpoint, the compaction
   window below opens before the close-out's first step, so a conversation cleared there
   leaves the whole close-out to the fresh one, and the checkpoint's STOP, which comes
   after the close-out, never stands in for that window.
   When this session's tools include `mcp__orchestrate-mod__schedule_clear`
   (orchestrate-mod's), the orchestrator calls it at every safe point, whatever its context
   size, with the ledger id and the integration tip's full SHA, once no background
   command of its own is running either and a committed PROGRESS session-log row names the
   LOG heading that records the work since the row before it. An answer that begins
   `scheduled` gives the one line to post: the orchestrator posts it and ends its turn, and
   the mod clears the conversation two minutes later unless a message arrives first, then
   runs `/orchestrate continue <id> after-clear`; a mod that finds it cannot clear runs
   `/orchestrate continue <id> in-place <reason>` in this conversation instead, `<reason>`
   naming what stopped the clear. That conversation still holds the run: when it sees its own
   call for that ledger and the integration tip is still the SHA it passed, it posts one line
   naming the reason and carries on with the step it would take next, with no boot,
   reconcile or validation; a tip that moved, or a call it no longer sees, has it boot as
   any `continue` does. A conversation that goes on
   after a `scheduled` answer, because a message or a notice arrived first, is not cleared
   and carries on. After an automatic clear, the session that
   `/orchestrate continue <id> after-clear` opened follows the boot its contract's
   §Boot sequence gives such a session; under a contract that gives none, it boots as any
   `continue` does. Its first message to the user opens with one line
   saying it continued after an automatic clear and naming the LOG heading that the newest
   session-log row names. It ignores a task notice for a task it did not start, whose
   output file sits under another session's folder. An answer that begins `not needed`
   (the context is under the ledger's clear threshold) has the orchestrator carry on at
   once, with no line and no timer. A `declined` answer that names an agent `waiting`
   (returned its report; a command of its own still runs), whose report is in while the ledger
   awaits nothing from that command, has the orchestrator stop that agent with TaskStop on
   the agent's id — it ends `killed` with its shell and runs no turn, where TaskStop on the
   shell's id would resume it for one more turn whose report lands in whatever conversation
   is current — and then call the tool once more. If the answer is `declined` and no such
   retry applies, or the retry's answer is `declined` too, or the answer begins as none of
   those three, or there is no such tool, the orchestrator takes the timer path: it first
   reads its own context size as `scaffolding.md`
   §Preconditions step 5 reads it and compares it with the contract's
   `**Clear threshold**` line (300K for a contract without one), carrying on as at
   `not needed` when the size is under it. An unknown context size or an unreadable
   threshold, the mod's decline saying the ledger's Clear threshold line cannot be read
   included, is never treated as below the threshold.
   At or past the threshold, or when either cannot be read, the orchestrator posts ONE
   line: its context size, the time it will continue, and the answers: `/compact` now (then
   wait for the timer, or say `continue`), or `go`. It then starts a 10-minute timer, a
   background Bash `sleep 600`, and ends its turn; the first of the timer's completion
   notice, `go` or `continue` resumes it, and it ignores whatever arrives later. That
   notice shows the task's description, not its output, so the description carries the
   reminder, verbatim:
   `Compaction window over: if this session was compacted, run the boot sequence and the reconcile before any transition`.
   A compacted session is resumed early only through `continue`, which starts this
   algorithm at step 1. A STOP that already waits for the user (⛔ verdicts, checkpoints),
   at or past the threshold, or when the size or the threshold cannot be read, carries the context size and `/compact` now in its message
   instead of a timer. After any compaction, an automatic one included, the boot
   sequence and the reconcile run before any transition, because a summary is a claim, not
   truth; a merge, push or third-round authorization that exists only in a summary is
   re-asked.

**Session practices** (guidance, not tooled). An investigation unrelated to the change, such
as a CI failure met while scaffolding, runs in its own session. A pause of over an hour
expires the prompt cache, and the first call after it writes the whole context to the cache
again.

**User gates are front-loaded**: design/UX approvals the plan can foresee are resolved
at planning time (mockup shown, pick recorded, approved design baked into the batch
file) or scheduled as wave 1 — never mid-sequence where they stall the autonomous run.
**Unplanned user gate**: if a batch surfaces a design/UX decision the plan didn't
settle, do not guess and do not stall silently — implement what is decidable, record
the EXACT question in the row's Notes (status `👤` if the batch cannot close without
it), and put the question in the STOP hand-off so the next session starts with the
answer.

## Two distinct close-outs

**Per-checkpoint** (step 8): version bump + changelog per the cadence for everything
integrated since the last checkpoint, tip validation, QA-runner pre-smoke with
evidence (a failing agent step → repair mini-batch first), covered rows `🟢` → `🧪`,
checkpoint-table row, session-log row recording the checkpoint's integration SHA,
`State: AT-CHECKPOINT C<n>`, the checkpoint row's token `m: pre-smoke=<agent>/<human>
human-smoke-min=<n> escaped=<n>` (completed when the user's verdict is recorded), the
filled smoke page committed as `smoke-<Cn>.html` when a page was prepared, then
**proof the published artifact** per `smoke-page.md` — after the page is built and
before the STOP, every embedded command run out of the built page's own bytes; a command
re-authored on its way into the page is unverified, and the pre-smoke that ran before the
page existed does not cover it; the pre-smoke's timing is unchanged —
commit on the integration branch, STOP with the combined smoke script (smoke page link
+ gate essentials in text, or the full plain-text script; pre-verified steps marked,
with the evidence SHA). The FINAL checkpoint's close-out runs the run-end prose sweep
(step 8) before all of these whenever LOG.md holds a `### prose sweep:` heading.

**The backlog file is a to-do list.** An item enters it only through the change-complete
ruling step (step 3 below), and only past the bar of the pinned skill's
`references/backlog.md`: works-but verdicts, request items the coverage audit finds
unimplemented and P0/P1 defects with a concrete scenario skip the bar's judgement, and the
bar never lowers a severity. Below the bar a finding stays in LOG.md only.

**Change-complete** (after the FINAL checkpoint passes and every batch is ✅ or
`⛔ (dropped)`), run with the contract's convergence, backlog, guardrails and release facts:
1. **Convergence pass** — on or off per the contract. When on: one read-only sub-agent
   reads the integration tip against every plan item (acceptance criteria + the full diff
   from the ledger's **Base** SHA in the PROGRESS preamble, ledger dir excluded) and
   classifies each `implemented / partial / contradicts / unrequested`; anything but
   `implemented` becomes a named backlog entry or a convergence mini-batch the user is
   asked about. When off: the coverage audit is built from PROGRESS rows + git, and the
   hand-over says so. Never close on PROGRESS claims alone.
2. Final coverage audit in PROGRESS: every request item (fold-ins included) maps to a
   merged commit, an intended-behavior resolution, or a named entry in the backlog file —
   zero unaccounted. An item the audit finds unaccounted is recorded as a LOG.md
   heading `### residual: audit — <one line>`, so it reaches the ruling list of step 3 (with
   convergence off, the audit is where an unimplemented request item is first found).
   Fold-ins are REMOVED from the backlog file in the close-out commit
   (the ledger row and commit message carry provenance); a partially done fold-in is
   edited in place there with a pointer to the ledger; residuals added get ids in the
   repo's id scheme. Those entries and ids are written by step 3's ruling. A fold-in whose
   row's Notes carry `fold-in returned: <id> @<sha>` stays in the backlog file: its
   `Folded into …` marker is removed, its `Since:` rewritten to the date it returned with
   its source naming the batch that returned it, and its coverage row names that entry.
3. **Ruling step** — every residual of the run reaches one list, ruled once by the user:
   - **The list**: every `### residual:` heading of this run's LOG.md, and each item that
     `node "<skill-dir>/tools/backlog.mjs" expired --backlog <file> --days <n> --today <YYYY-MM-DD>`
     names, run on the contract's backlog file with the contract's expiry (a whole number
     of days) and today's date. An expired item is re-checked against the code at the
     integration tip — does its `Failure:` still hold? — before it is proposed. Each
     residual's paths are checked against the contract's rulings file with
     `node "<skill-dir>/tools/backlog.mjs" rulings --rulings <file> --paths <paths>`; one a
     ruling covers, bringing no new evidence of exposure, is proposed LOG only, naming
     that ruling.
   - **Proposals**: for each residual the orchestrator proposes register (the form's
     fields filled, its paths written repository-relative as `references/backlog.md`
     says — `backlog.mjs check` does not refuse a `C:/…`, `~/…` or `$HOME/…` path, so the
     orchestrator reads them itself), rule (accepted or declined, with a reason) or LOG
     only; for an expired item, keep (its `Since:` rewritten), rule, or drop (removed
     from the to-do list; LOG.md keeps its text). A residual whose fix is prose-only and
     carries verified replacement text, as a `SWEEP:` item does, may be proposed fix now;
     a fix that changes behaviour never is.
   - **Packs**: `node "<skill-dir>/tools/backlog.mjs" packs --backlog <file> --threshold <n>`
     with the contract's pack threshold, over the backlog file as it stands, each file's
     count raised by this run's items proposed for registration that name it (nothing is
     written before the user rules). A file at or over the threshold that gained an item
     in this run and that no plan has taken is proposed as a pack, never run unasked; a
     declined pack returns to this list only when its file gains an item in a later run.
   - **A file not in the form**: when `backlog.mjs` prints `UNKNOWN` for the backlog or
     the rulings file (one not yet in the form, every repository's until its migration,
     or a missing one), the STOP says which file and why, and each item is registered or
     ruled in that file's current form, a missing file being created in the form. For the
     backlog file the list then forms from LOG.md's residuals alone and no pack is
     proposed; for the rulings file the expired items and packs stand, a missing one holds
     no ruling, and the orchestrator reads one not in the form for the rulings on the
     residuals' paths. Once the backlog file carries the form, every entry written to it
     passes `node "<skill-dir>/tools/backlog.mjs" check --backlog <file>`.
   - **The STOP**: the proposed list is committed to LOG.md under `### Ruling list`
     before the STOP, which presents it; the user rules once, the proposals as defaults,
     and only the user's word registers or rules an item. The user's words are recorded
     verbatim in the smoke-test verdict log (Checkpoint column `ruling`) in their own
     commit, before anything is written to the backlog file or the rulings file, so a
     crash after it never loses a ruling. A ruling found only in a
     summary is asked for once more, never assumed. A ledger with every row ✅ or
     `⛔ (dropped)` (advisory `👤` rows aside) and no COMPLETE marker resumes the
     change-complete close-out at its first unfinished step, by `continue` or `close`: a
     committed `### Ruling list` with no recorded ruling is presented.
   - **The page**: the list goes to the user as the ruling page whenever the runtime can
     hand over usable HTML, per the pinned skill's `references/ruling-page.md`: the
     proposals authored as `ruling.json` in the ledger,
     `node "<skill-dir>/tools/build-ruling-page.mjs" build <ledger>/ruling.json <ledger>/ruling.html`
     builds the page, and the block `node "<skill-dir>/tools/build-ruling-page.mjs" list <ledger>/ruling.json`
     prints is the `### Ruling list`, committed with both files. The paste is saved and
     checked with `node "<skill-dir>/tools/build-ruling-page.mjs" read <ledger>/ruling.json <paste file> --entries`
     before it is recorded; a `RULINGS FAIL` is asked about once more, never repaired by
     guess.
   - **The ruling sweep**: fix-now rulings run after the ruling commit as step 8's run-end
     prose sweep does, under its rules with these names: the record
     `ruling sweep cut @<sha>`, the branch `fix/<batch>-ruling-sweep`, the findings
     heading `### B<NN> R1 ruling-sweep findings` and the
     session-log row `ruling sweep: <n> item(s) @<merge sha>`. An item it returns or its
     reviewer's `FIX FIRST` reverts is registered with its replacement text attached, the
     user's fix-now ruling being its pass of the bar, and the hand-over names it. The
     backlog file and the rulings file are written once the sweep has merged; a
     `ruling sweep cut` with no `ruling sweep:` row resumes the sweep from its branch by
     step 8's adoption rule.
   - A ruling is reconsidered only on new evidence of exposure (a user hit it, a calling
     module changed, a smoke step failed), never on a new instance of the same gap; gate
     prompts never read the rulings file.
4. **Distillation loop**: any NEW bug class this change uncovered → ONE-LINE guardrail
   bullet in the project guardrails doc naming the class and pointing at the test or
   mechanism doc that enforces it (prefer adding the test in this close-out). Repo-wide
   rules stay in the always-loaded section; area-specific ones go to the area's doc and
   are pulled into batch files per fence. If the always-loaded section exceeds ~8 KB /
   ~120 lines, PROPOSE retirements (to a test, a linked doc, or a merge of bullets) for
   the user to accept — never delete on your own. Harvest in-run learnings from LOG.md.
   Durable lessons belong in repo files every future session loads — not in any one
   session's memory.
5. Release step (only on explicit user authorization): the contract's release command.
6. Mark the change COMPLETE in the Session log and `**State**: COMPLETE`; propose deleting
   the merged branches and moving the ledger to `.agents/archive/` (`git mv`).

**A COMPLETE ledger is never resumed.** On "continue" with nothing active: reconcile,
report completion, and point at the backlog for follow-ups. Do not fabricate a batch.

Classify a ledger from its `**State**` line when present; otherwise from its
BATCHES-TABLE rows plus the Session log — never from the Legend line or log prose (both
quote every emoji). An explicit change-COMPLETE marker outranks leftover advisory rows:
a lingering `👤` item (e.g. "rotate the deploy credential") makes the ledger a reminder
to surface, not a change to resume.

## Legacy ledger recognition (interop)

Ledgers created before this skill (or before the waved stack) vary in shape.
Recognition rules:

| Variant | How to recognize | How to drive |
|---|---|---|
| Full contract (before the 2026-09-25 contract slimming) | Its contract carries its own `§Recovery` and `§Session algorithm`, with or without a `**Skill**` pin line | Drive as written under its own contract; a pin line, when present, is still checked first at boot |
| Pre-2026-09-17 waved scaffold | Has checkpoints and 🟢 but no `**State**` line, no LOG.md, no runner tags, "two rounds then ⛔" without ASK | Drive as written under its own contract; classify by rows; do not add the new gates |
| Contract under another name | `02-batches-00-READBEFORE.md` or `03-tasks-00-READBEFORE.md` | Same contract — follow it as-is |
| Contract absent | Only `01-plan.md` + `PROGRESS.md` (± request file) | Protocol lives in the plan's orchestration section + the PROGRESS preamble; the running skill's copy of this file fills gaps; ASK before acting on anything ambiguous |
| Per-batch smoke scaffolds | Contract has no checkpoints or 🟢 status; every batch ends 🧪; model named strict sequential / linear stack / stacked waves | Earlier skill versions: drive as written — smoke and merge each batch under its own algorithm |
| Task model (oldest) | `03-tasks-NN-*` files; statuses `✅ Completed` / `🔴 Incomplete` | Map ✅→✅ and 🔴→ask (❌ or ⛔?); tasks may share a single feature branch — check git |
| Spec/plan split | `01-specification.md` + `02-plan.md` | Specification = locked scope; plan = batch table |

Never rewrite a legacy ledger into the new format — drive it under its own conventions.

## Degraded environments

- **No sub-agents available**: the orchestrator implements a wave's batches one at a
  time in the main checkout (worktrees unnecessary). The reviewer gate still runs per
  batch — a separate adversarial pass over each finished diff, with the same
  hunk-mapping duty, before integration. Checkpoint placement is unchanged.
  The census is the orchestrator's own pass, one batch at a time, in the same report shape.
  The census's send-back is then the orchestrator's own check, in the send-back block's shape, of
  the lines it folded in other words and the fixes it chose.
- **No agent definitions installed** (the skeletons' `subagent_type:` lines name types
  this environment does not define): the spawn ERRORS — `Agent type '<name>' not found` —
  it does not degrade on its own, so the ORCHESTRATOR substitutes the general-purpose
  agent itself on every spawn. The skeleton's prose read-only rules are then the only
  enforcement and bind strictly; the per-spawn token saving is forfeited until the
  definitions are installed — copy the skill repo's `.claude/agents/*.md` into
  `~/.claude/agents/` (or one project's `.claude/agents/`), then restart Claude Code.
- **No gate agents named**: the reviewer alone carries duties (a)–(f).
- **No runners** (or the environment forbids running the app): every smoke step is
  human; no pre-smoke, no `evidence/`; the hand-over says so.
- **No validation commands**: legal (contract says `none`); the checkpoint smoke tests
  carry all verification and every hand-over message must say so.
- **No publishing tools**: deliver the committed smoke HTML through the runtime's
  usable preview/file hand-over. Without usable HTML delivery or a page/template,
  print the full checkpoint script — gate first, then each step's Do/Pass in the same
  section order, pre-verified steps marked in text. The batch files' smoke steps stay
  canonical; lack of a publisher or cloud verdict store never blocks the checkpoint.
