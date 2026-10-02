---
name: orchestrate
description: Ledger-based orchestration for multi-batch code changes. Scaffolds and drives file-based ledgers in .agents/changes/ — locked plan with a wave map (file-disjoint batches run concurrently, one git branch per batch, worktree implementers), a mechanical fence check plus an independent hunk-to-finding reviewer gate per batch, validation on the integration tip after every merge, user smoke tests only at planned checkpoints (after hands-on-risk waves plus one final — never per batch by default), and crash-safe PROGRESS reconciliation where git is truth. Use when the user asks to plan or orchestrate a multi-item or multi-batch change as a ledger; says "continue", "resume the batch work", asks for ledger status, or gives a smoke-test verdict in a repo that has a .agents/changes/ directory; or asks to set a repo up for ledger-driven orchestration. Modes: new <description> | continue | status | close.
argument-hint: new <description> | continue | status | close
---

# Ledger orchestration

Multi-batch changes run from a **ledger**: a committed directory
`.agents/changes/<PREFIX>-YYYYMMDD-<slug>/` holding the user's verbatim request, a
locked plan with a wave map and smoke checkpoints, one file per batch, a binding
contract (`00-READBEFORE.md`), a live `PROGRESS.md` where statuses are claims and
**git is truth**, and an append-only `LOG.md` for narrative. Ledgers are CLOSED SYSTEMS:
every repo fact is baked in at scaffold time, a ledger references ONLY its pinned skill
directory, by absolute path and hash, its procedure is that directory's
`references/protocol.md`, frozen by the hash, and every step a tool performs also has its
manual procedure there, so any session drives one from the ledger plus its pinned
directory. A changed skill stops the ledger at its next boot and asks, and never silently
changes how it runs. Full spec:
[references/protocol.md](references/protocol.md).

**Arguments**: `$ARGUMENTS`

## Mode dispatch

First word of the arguments:

- `new <description>` → scaffold a ledger
- `continue` → run the session algorithm on the active ledger
- `status` → read-only reconcile + report
- `close` → process smoke verdicts / finish the change
- empty or anything else → run Discovery, then route by message shape: a smoke verdict
  ("passed", "X is broken") → `close`; "what's left / where are we" → `status`;
  "continue / resume / next batch" → `continue`; a new multi-item request → confirm the
  scope, then `new`. Ambiguous → ask.

## Discovery (every mode starts here)

Use `node "<skill-dir>/tools/git-evidence.mjs" discovery --repo <repo>` — `<skill-dir>` is
the directory holding this `SKILL.md`, the base directory the skill loader reports — for the
repeatable read-only inventory and provenance probes; helper recipes and manual
fallback are in protocol.md. Its summary comes first:
`node "<skill-dir>/tools/reconcile.mjs" discovery --repo <repo>` prints one line per ledger
id, `<id> State=<value> at <locations> → <mode>`, the mode that State routes to (`continue`,
`close`, `status` or `none`). The git-evidence JSON is read when a line says `AMBIGUOUS`,
`INCOMPLETE` or `UNKNOWN`, or when a rule below needs provenance.
Inspect completeness/diagnostics; unknown never means
absent. The rules below still decide ownership, targets and ledger state. Existing
ledgers keep their frozen contract and gates even when this skill changes — a pinned
ledger's gates are its pinned directory's, and a changed directory stops it at boot.

1. Find ledgers in the WORKING TREE: glob `**/PROGRESS.md` rooted at
   `<repo>/.agents/changes/` — dot-dirs often escape repo-root globs, so root the search
   INSIDE the directory; if that still returns nothing, list the directory directly. A
   repo may park closed ledgers in a sibling archive dir (e.g. `.agents/archive/`) OUTSIDE
   this root — that is the point of it; never widen the glob to sweep them back in. An
   empty ledger directory is ignored.
2. Find ledgers that exist only on BRANCHES — scaffold commits live on the integration
   branch, never on the default branch, so a checkout on `main` may show none of the
   active work. Enumerate ALL local and remote-tracking branches with
   `git for-each-ref --format='%(refname) %(symref)' refs/heads/ refs/remotes/`.
   Skip ONLY symbolic refs (a nonempty `symref`, e.g. `refs/remotes/origin/HEAD`). For
   EVERY remaining ref, run `git ls-tree -r --name-only <ref> -- .agents/changes/` and find
   its `PROGRESS.md` files. Branch names never gate this probe: conventional
   `chore/<slug>-ledger`, shallow `foo-ledger`, and custom names are all candidates,
   even when another branch has already yielded a ledger. Skip ids under
   `.agents/archive/`. Use full refs for Git reads to avoid local/remote name collisions.
   There is no default-branch or ancestry pre-filter: even a merged ref can carry an
   unfinished ledger. Group copies of the same ledger id across the checkout and refs;
   list their branch locations together, not as separate active changes. Read only
   each candidate's contract fields needed for ownership and merge targets (legacy
   equivalents per protocol.md).
   Read branch files with `git show <ref>:./<path>` (keep the `./`; run from the repo
   root). Compare LEDGER versions, not whole branch tips: obtain the last ledger-changing
   commit with `git log -1 --format=%H <ref> -- .agents/changes/<id>/`. Its ledger-subtree
   tree id must equal the candidate ref's tree id at that path (use `git rev-parse
   <ref>:./.agents/changes/<id>` for each). That commit being an ancestor of the
   owning integration tip or resolved shipment target proves the committed copy is
   older there; unrelated later branch commits do not invalidate that proof. Unknown
   provenance, newer/conflicting ledger commits, or uncommitted ledger edits in an
   associated worktree remain visible, never silently superseded.
   Resolve ownership first: use the declared integration branch's current contract.
   A recorded target correction there supersedes proven older ledger copies; their
   old target values do not create a new ambiguity. Unresolved ownership or target
   conflicts, divergent local/remote integration refs, or conflicting working-tree
   ledger edits are AMBIGUOUS.
   Resolve the owning contract's shipment target per §Recovery (its pinned
   `references/protocol.md`'s, or a legacy contract's own), then inspect only
   this candidate's id there: an explicit COMPLETE marker in `.agents/changes/<id>/`
   or its presence in `.agents/archive/<id>/` supersedes proven older ledger copies.
   If the integration branch was deleted, use the candidate's recorded target for
   this check; a missing owner alone cannot resurrect a proven completed/archive copy.
   Ancestry alone never establishes COMPLETE or archived. Missing target evidence
   leaves the candidate visible; it cannot justify dropping it or inferring shipment.
   Reconcile active work only under its owning contract.
   Report branch-only ledgers with their classified state and "on <branch>; checkout
   is on <current>".
   Never switch the main checkout and never copy ledger files into another branch's tree.
3. Classify by GREP, never by reading the file. First the preamble's `**State**:` line
   (`ACTIVE | AT-CHECKPOINT C<n> | USER-BLOCKED | COMPLETE`); ledgers without one (older
   scaffolds) are classified from their BATCHES-TABLE rows plus the Session log — never
   from the Legend line or log prose (both quote every emoji). A closed ledger's log
   runs to tens of thousands of characters; read the BODY of at most the ONE ledger you
   are about to act on.
   - **COMPLETE**: State says so, or the Session log (or verdict log) carries an explicit
     change-COMPLETE marker — even if advisory `👤` rows remain (surface those as
     reminders).
   - **ACTIVE**: State ACTIVE / AT-CHECKPOINT, or any batch row ⬜ 🔄 🟢 🧪 ❌ ⛔ with no
     COMPLETE marker.
   - **USER-BLOCKED**: only `👤` rows remain open — report what the user must do;
     there is nothing for the orchestrator.
   - **AMBIGUOUS** → ask.
4. COMPLETE ledgers are NEVER resumed. If the user says "continue" and nothing is
   active: reconcile, report completion, point at the backlog. Do not fabricate a batch.
5. Multiple ACTIVE ledgers → list them one line each; the user picks.
6. Legacy ledgers (older file names / status vocabularies / per-batch smoke gates / no
   State line) are driven under their OWN contract — see protocol.md §Legacy ledger
   recognition. Never rewrite one, never add the new gates to one.

## Invariants (binding in every mode)

- Statuses are claims; **git is truth** — reconcile before believing any PROGRESS row.
  The orchestrator never switches the main checkout: it reads with `git show` and writes
  through an integration worktree under the session scratchpad.
- One branch per batch, cut from the integration branch when its wave opens. Never
  commit to the default branch, never push. The orchestrator merges REVIEWED batches
  into the integration branch; anything merges toward the default branch only per the
  ledger's merge policy or the user's explicit words in THIS session.
- Only batches the plan marked mutually file-disjoint and dependency-free share a
  wave; the user's plan approval is the standing authorization for that concurrency.
  Deviating from the locked wave map needs the user's explicit words, recorded
  verbatim in PROGRESS (sole standing exception: a recorded `NEEDS_FENCE` deferral
  moving the final checkpoint). A mid-wave fence extension is allowed only when it keeps the
  wave disjoint (protocol §Fence changes) and is recorded in PROGRESS.
- The wave-open PROGRESS commit on the integration branch (member rows → 🔄, wave base
  SHA logged, State line) is the crash marker reconciliation keys on.
- Every `continue` begins with validation on the integration tip; a red tip is repaired
  before any wave opens (unless a capped tip repair is awaiting the user's verdict — then
  ask, never re-spawn).
- Smoke gates are planned CHECKPOINTS — after waves carrying hands-on risk, plus one
  mandatory final — never per batch by default. A reached checkpoint belongs to the
  USER: never flip ✅ without their verdict; never open the next wave past an
  unanswered 🧪. Agent-runnable steps are pre-verified by a QA runner before the
  hand-over; `❌` is written only when the USER fails a reached checkpoint.
- Implementer sub-agents never touch version files, the changelog, PROGRESS or LOG, and
  never spawn gate agents. Sub-agent reports are structured and capped; the orchestrator
  acts on nothing without the status line and evidence block.
- Every batch passes, in order: a MECHANICAL fence check (paths, both rename endpoints,
  clean worktree — fence bounces are not review rounds), the failing-on-base check for
  `fix` batches, then ONE fresh independent read-only reviewer (plus any gate agents the
  contract names, in parallel) that maps every diff hunk to a batch item; unmapped hunks
  are scope creep and reject the round. P0/P1 block; ASKs close as a polish pass. Two
  `FIX FIRST` rounds max, then ⛔ (defective, or green with a residual) and the STOP
  offers the user: fix again / ship with the residual / drop.
- Integration is per batch: merge-tree dry run → merge → validation on the integration
  tip → 🟢. Every repair is a reviewed mini-batch on its own branch — never a direct
  commit on the integration branch.
- Default session cadence: run autonomously to the next checkpoint — waves in
  sequence, no stopping between batches — halting early only at ⛔ or an unplanned
  user gate, or pausing at a safe point for context (protocol.md §Session
  algorithm step 8).
- The orchestrator never polls: it never calls `ReadNotifications` to wait for a sub-agent
  and never sleeps; when the only remaining work waits on sub-agents it ends the turn, and
  the task notification resumes it.
- No `--no-verify`, no force-push, no history rewriting.
- The ledger's own contract outranks this skill's reference docs — a pinned contract
  through its repo facts, its pinned `references/protocol.md` governing wherever it is
  silent (protocol.md's precedence rule).

## Evidence and smoke-input responsibilities

After the implementer report, use the read-only `check-fence.mjs` mechanical gate
before fresh semantic review whenever the ledger's procedure names it — a pinned
ledger's always does (commands,
authority grammar and manual fallback in protocol.md). PASS does not grant scope or
approve a merge; UNKNOWN never passes. Capture both refs/SHAs and both diagnostic
arrays. Continue to map every hunk independently under the same cap and verdict rules.

At planning and checkpoint close-out, the conductor inventories, generates,
independently validates and delivers actual reproducible inputs per smoke step.
Supply workbooks with specified sheets/types/formulas/edge cases, exact file links,
expected results and working-copy/reset instructions; preserve immutable versioned
inputs/evidence. Name specific private-data/credential/access prerequisites instead
of fake files or pre-verification. No manual construction unless that is the test.
Compare resolved input identities on reissue and bump EVERY affected step revision;
use the input registry and raw-file/history checks in references/smoke-page.md.
Ordinary synthetic preparation adds no user gate.

## Mode: new

Read [references/scaffolding.md](references/scaffolding.md) and the files in
[templates/](templates/), then: preconditions (git repo; tree state) → detect repo
facts (validation commands and their quiet form, versioning, gate agents, runners,
backlog id scheme; `node "<skill-dir>/tools/detect.mjs" --repo <repo>` and
`node "<skill-dir>/tools/env-facts.mjs" --repo <repo>` print the candidates) → interview (back-to-back AskUserQuestion calls, as many as
the gaps need) → plan the batches (explore, at medium thoroughness by default and "very thorough" only when the interview needs an inventory and the prompt names what it is for; batch
table with weights and file fences; item→batch coverage) → structure for throughput per
[references/execution-models.md](references/execution-models.md): reshape fences for
disjointness, build the wave map (widest safe waves), classify each batch hands-on vs
machine-verifiable and each smoke step `Runner: agent | human`, place the smoke
checkpoints (fewest possible — hands-on waves + one final) → backlog sweep (propose
eligible fold-ins per scaffolding.md; the user picks at plan approval) → plan checks on
a draft (`node "<skill-dir>/tools/scaffold.mjs" --answers <draft answers> --repo <scratch worktree>`
writes the draft ledger into a scratch worktree of the base, and `check-ledger.mjs` runs
`plan`, `cites` and `census` on it, per scaffolding.md; the draft and its worktree are
removed after the last pre-flight round, so Discovery never meets a second copy of the
ledger) → independent
plan PRE-FLIGHT (a fresh read-only sub-agent given those three lines; blocking findings fixed before the user
sees the plan) → front-load user gates (design/UX approvals resolved at planning time
via mockups, or scheduled as wave 1 — never mid-run) → user approves plan + wave map +
checkpoints + weights + fold-ins in one pass → fill the templates into
`.agents/changes/<CHANGE_ID>/` with `node "<skill-dir>/tools/scaffold.mjs" --answers <file> --repo <root>`
(incl. `LOG.md`; the fill bakes the `**Skill**` pin line and
writes `validate.json`, plus `setup.json` when there is a setup step) → self-check
(grep the new directory
for `{{` and `<!--`, and its `*.md` for `<title>` — zero hits outside fenced and inline
code spans. A hit inside a code span is not an unfilled slot, since a ledger documenting
templating work quotes those tokens legitimately; `**State**: ACTIVE` present;
the pre-flight verdict line present in the plan;
every `#` cell of the plan's and PROGRESS's batch tables reads `Bnn`; `check-ledger.mjs`
prints `PARSE OK` for the directory and `SKILL MATCH` for its contract, per
scaffolding.md; `node "<skill-dir>/tools/check-ledger.mjs" selfcheck --dir <ledger-dir>`
runs all of these at once) → scaffold commit on
`chore/<slug>-ledger` (which becomes the integration branch) → STOP and report.

## Mode: continue

1. Discovery → exactly one ACTIVE ledger (else ask).
2. Read the ledger's OWN contract (`00-READBEFORE.md`; legacy names per protocol.md;
   contract absent → protocol.md fills the gaps, ask before acting on ambiguity).
3. Boot (a pinned contract verifies its skill pin first) + reconcile (for a pinned contract
   `node "<skill-dir>/tools/reconcile.mjs" rows --repo <repo> --ledger <id> --integration <full-ref>`,
   `<skill-dir>` being its pinned directory, if the tool is there) + resume-time
   validation per the contract's boot sequence — a pinned contract takes up its pinned
   skill directory's `references/protocol.md`, the procedure its repo facts plug into,
   only on `SKILL MATCH` — then run the pinned protocol.md's (or a
   legacy contract's own) §Session
   algorithm: repairs (❌ / red tip) first as mini-batches → unanswered 🧪 checkpoint →
   open the next wave (cut branches + worktrees, spawn ALL of the wave's implementers
   concurrently) → per batch as each lands: fence check → failing-on-base → reviewer +
   gate agents → polish / fix rounds → integrate (dry run, merge, tip validation) →
   next wave, repeating until a checkpoint → per-checkpoint close-out (tip validation,
   QA-runner pre-smoke with evidence, page) → STOP, delivering the checkpoint's combined
   smoke script as an interactive smoke page per
   [references/smoke-page.md](references/smoke-page.md) using available HTML delivery
   tools, or the full plain-text script when no usable HTML delivery is available.
   Render the per-batch prompts with `node "<skill-dir>/tools/prompt.mjs"`; the skeletons
   live in [references/subagent-prompts.md](references/subagent-prompts.md).

## Mode: status

Strictly read-only (no edits, no branch changes, no checkout switch): discovery →
reconcile every row that is not ✅/👤/⛔ (dropped) against git per the §Recovery table (the pinned protocol.md's, or a legacy contract's own) → print a
claim-vs-git-vs-verdict table, the checkpoint(s) awaiting the user, branch-only ledgers,
and the recommended next action. For a pinned contract that table is the output of
`node "<skill-dir>/tools/reconcile.mjs" rows --repo <repo> --ledger <id> --integration <full-ref>`,
`<skill-dir>` being its pinned directory: one `<Bnn> <status> row <k>: <Verdict>` line per
row, beside the Status and Verdict cells of PROGRESS's checkpoint table; a row it prints as
`UNKNOWN`, or every row when that directory has no such tool, is reconciled from the
§Recovery table by hand.
Drift corrections happen in `continue`, not here.

## Mode: close

1. Record the user's verdict VERBATIM in the PROGRESS smoke-verdict log. A checkpoint
   pass flips every batch it covers 🧪→✅. A fail: triage the symptoms to the
   offending batch(es) → ❌ and write `fix-up pending: fix/<batch>-c<n>-followup[-<k>]` to
   each indicted row's Notes, suffixing when the name exists (the fix-up mini-batch then
   runs via `continue`; a row whose earlier fix-up is still unmerged gets no second line —
   the new report rides that fix-up as additional failure notes); batches the
   user explicitly passed flip ✅; the rest stay 🧪 for the re-run. Smoke-page verdicts
   beyond pass/fail ([references/smoke-page.md](references/smoke-page.md)):
   **works-but** → named backlog entry, never a failure; **blocked** → correct the
   step and re-issue the page, or reclassify as a fail if the app lacks the behavior.
2. Merge / push / release ONLY on the user's explicit authorization — their exact words
   are the record (a verdict message may carry the authorization; quote it). Verdicts on
   a ⛔ batch or a capped repair (fix again / ship with the residual / drop) are recorded
   the same way, verbatim, in the verdict log (Checkpoint column = `B<NN>`), and consumed
   by `continue`.
3. Final checkpoint ✅ → change-complete close-out per protocol.md with the contract's facts: convergence pass
   (when the contract turns it on, a fresh read-only sub-agent classifies every item
   against the tip; otherwise the audit comes from PROGRESS + git and says so), final coverage
   audit (zero unaccounted items; fold-ins removed from the backlog), distillation (new
   bug classes → one-line guardrails with pointers; propose retirements past the size
   threshold, never delete unasked; harvest LOG.md learnings), optional release command,
   session-log row marked COMPLETE + `**State**: COMPLETE`, propose deleting merged
   branches and archiving the ledger.

## Refusals

- Not a git repo → do not scaffold; offer `git init` and wait for consent.
- Asked to resume a COMPLETE ledger → reconcile, report completion, point at the
  backlog.
- Contract absent and the legacy shape ambiguous → ask; never guess a protocol.
- Asked to skip the fence check, the reviewer gate or a reached checkpoint → only with
  the user's explicit waiver, recorded verbatim in PROGRESS.

## Skill files

- [references/protocol.md](references/protocol.md) — canonical spec, severity and round
  accounting, legacy interop, degraded environments
- [references/execution-models.md](references/execution-models.md) — the waved stack:
  building the wave map, placing checkpoints, integration mechanics
- [references/scaffolding.md](references/scaffolding.md) — detection heuristics,
  interview, backlog sweep, pre-flight, placeholder registry, self-check
- [references/subagent-prompts.md](references/subagent-prompts.md) — implementer /
  reviewer / test hunter / QA runner / pre-flight / convergence / fix-up skeletons
- [references/smoke-page.md](references/smoke-page.md) — the checkpoint hand-over
  format: filling and publishing
  [references/smoke-page-template.html](references/smoke-page-template.html),
  pre-verified steps, verdict intake and triage
- [templates/](templates/) — `00-request.md`, `00-READBEFORE.md`, `01-plan.md`,
  `02-batch.md` (one per batch), `PROGRESS.md`, `LOG.md`
