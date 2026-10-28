# Execution model — the waved stack

One model, structured at scaffold time and recorded as facts in the ledger's READBEFORE
(git model section) and PROGRESS preamble, run by its pinned `references/protocol.md`: batches are grouped into **waves** that run
concurrently, waves stack serially onto an **integration branch**, and the user
smoke-tests only at planned **checkpoints**. Strict one-at-a-time sequencing is just
the degenerate case (every wave width 1) — it is not a separate model.

## Evidence and required inputs

Discovery and shipment probes use the read-only git-evidence helper under the owning
contract. After each implementer report, the mechanical fence gate captures
refs/SHAs before fresh independent semantic review; check-fence PASS is mechanical
only, VIOLATION/UNKNOWN never authorize extensions or merges. Unsupported authority
uses protocol.md's manual fallback. Existing ledgers retain their frozen gate rules — a
pinned ledger those of its pinned directory's protocol.md.

Planning inventories inputs per step; checkpoint close-out generates reproducible
synthetic files, independently validates requirements, and delivers exact linked
files with Pass results and working-copy/reset instructions. Preserve originals and
validation evidence under versioned input paths, verify raw bytes after checkout, and
give QA the same registry/identities the user receives. Private-data, credential and
external-access prerequisites must be named specifically, never called pre-verified.
Input changes on reissue require new file paths and EVERY affected step's revision;
unaffected verdicts remain applicable. Relative-file hosting failures need usable
attachments/local links and a mapping. Ordinary synthetic preparation adds no gate.

## The three structures

- **Wave** — a set of batches that run AT THE SAME TIME: one implementer per batch,
  each in its own git worktree on its own branch. Two batches may share a wave only
  if ALL hold:
  1. Neither depends on the other, directly or transitively.
  2. Their file fences are disjoint. Version files, the changelog, and the ledger
     don't count against this — those are orchestrator-only, touched at integration,
     never by implementers.
  3. Neither carries an unresolved user gate (design approvals are settled at
     planning time or scheduled as wave 1).
- **Integration branch** — the scaffold branch `chore/<slug>-ledger` by default.
  Reviewed batch branches merge into it serially; it is the only branch that ever
  merges toward the default branch. Fence disjointness (plus PROGRESS living only on
  the integration branch and each batch ticking only its own batch file) makes these
  merges conflict-free by construction — a conflict is stop-and-investigate (a fence
  violation, an unrecorded fence extension, or a ledger file edited on both sides), never
  hand-resolved silently.
- **Checkpoint** — a planned STOP where the USER smoke-tests everything integrated
  since the last checkpoint, in one combined session. Between checkpoints the run is
  autonomous: implement → review → integrate → next wave, no user interaction.

## Building the wave map (planning time)

The planner doesn't just discover concurrency — it ENGINEERS it:

1. Draft the batches, then actively reshape fences for disjointness: pull a shared
   file into its own small "seam" batch that runs in an early wave; merge two batches
   that would fight over the same files; split a wide batch whose halves are
   independent.
2. Assign waves greedily: wave 1 = every batch with no dependencies, mutually
   disjoint; wave N = every remaining batch whose dependencies all land by wave N-1,
   mutually disjoint with its wave peers. A batch that fits several waves goes in the
   earliest.
3. Aim for the widest safe waves, not the largest batch count — 5 batches as "3
   concurrent, then 2 concurrent" beats 5 back-to-back whenever the fences allow it.
4. Record the map in the plan (Wave column + wave map section) with one line per wave
   on WHY its members are safe together. The user's plan approval IS the standing
   authorization to run each wave concurrently — no further waiver is needed mid-run.

## Placing checkpoints (planning time)

Manual smoke tests are scarce by design: the user tests at checkpoints, never per
batch or per wave by default.

- Classify every batch **hands-on** or **machine-verifiable**. Hands-on ("scary")
  means validations + code review genuinely cannot establish it works: visible UI/UX
  behavior, auth/payment/external-service flows, data migrations, destructive or
  hard-to-reverse operations, cross-cutting refactors of live paths — or anything the
  user should see working before more code stacks on top of it.
- Place ONE checkpoint after each wave that contains a hands-on batch.
- Always end with a final checkpoint covering every batch not covered earlier. If the
  only hands-on work sits in the last wave — or there is none — the final checkpoint
  is the ONLY one.
- The user confirms placement at plan approval and may add or remove checkpoints;
  record their choice. Never insert an unplanned mid-run smoke gate on your own; if a
  wave surfaces something genuinely unforeseeable, propose one at the next STOP and
  record the user's words in PROGRESS.
- Tag every smoke step `Runner: agent` (performable in THIS repo's environment by a
  runner the contract lists — CLI, HTTP, browser, screenshot) or `Runner: human`
  (hardware, credentials, feel, another OS, live data — and anything "touches your
  data" unless a disposable environment exists). Tag on what an agent on this machine
  can do, never on what the test fixtures can do: fixtures are isolated from the real
  machine by design and a subagent is not, so "no test could prove it" is never a
  reason to hand a step to the user. A step is human ONLY when it needs something an
  agent on this machine cannot do: a device, a GUI, held credentials, a judgement
  about whether something looks right, or something the environment contract forbids
  an agent here to do. That last kind is why the grounds listed above — another OS,
  live data, anything "touches your data" without a disposable environment — stay
  human; the enumeration narrows nothing. At the checkpoint
  close-out a QA runner performs the agent steps on the integration tip and records
  evidence; the user's hands are spent only on the human steps. A checkpoint asks the
  user for a VERDICT, not for labour. A repo whose contract
  forbids running the app has no agent steps — say so rather than pretend.

## Wave mechanics (run time)

1. **Open the wave**: from the integration tip — after any `census` agent re-run that
   `protocol.md` §Session algorithm step 4 calls for —, cut every member batch's branch;
   create one worktree per batch under the contract's worktree root (its boot step 2 and
   Git model), or under the session scratchpad for a contract that names none (never
   inside the repo); run the ledger's per-worktree setup; commit ONE PROGRESS flip on the
   integration branch through the integration worktree (member rows → 🔄, branches
   named, wave base SHA in the session log, `**State**: ACTIVE`). Spawn all
   implementers in a single message so they run concurrently. The main checkout is
   never switched.
2. **Gate as they land**: each finished batch, in order — structured report present →
   mechanical fence check (clean worktree; `git diff --name-status -M` three-dot against
   the integration branch; every path in plan fence ∪ recorded extensions ∪ own batch
   file) → failing-on-base for `fix` batches → ONE fresh read-only reviewer plus the
   contract's gate agents in parallel; don't wait for the wave's slowest batch. `SHIP`
   with ASKs → polish pass (not a round; a prose ASK's replacement text the orchestrator
   applies itself, `prose-only-diff.mjs` classifies the polish diff, and a polish-phase
   `FIX FIRST` discards the polish at once — protocol.md §Severity and round
   accounting); `FIX FIRST` → round 1 resumes the implementer (a fresh one with the `rework`
   prompt when the render prints `FRESH` — subagent-prompts.md §Spawning rules);
   the second `FIX FIRST` → ⛔, and once the wave's other members are gated and
   integrated the session STOPs instead of opening the next wave; a user-authorized
   third round is a fresh implementer on the strong tier.
3. **Integrate serially**: per batch, `git merge-tree --write-tree` dry run (a conflict is
   stop-and-investigate: fence violation, unrecorded extension, or a ledger file edited
   on both sides — never hand-resolved silently) → merge → validation commands on the
   integration tip → `🟢`. A red tip stops further merges until a repair mini-batch
   lands. Version/changelog work happens here or at the checkpoint per the ledger's
   cadence — implementers never touch either.
4. **Close the wave** when every member is 🟢, ⛔ or 👤 (a recorded NEEDS_FENCE deferral
   does not hold it): remove the worktrees. A ⛔ batch
   is left out of integration, its dependents stay ⬜-blocked, and it is surfaced at
   the next STOP with three verdicts (fix again / ship with the residual / drop).
5. **Checkpoint or continue**: if the checkpoint table places a checkpoint here →
   protocol.md §Session algorithm step 8's compaction window first, then the
   per-checkpoint close-out (at the FINAL checkpoint, the run-end prose sweep first
   whenever LOG.md holds a `### prose sweep:` heading; tip validation, QA-runner pre-smoke of the agent-tagged
   steps with `evidence/C<n>/`, covered rows 🟢 → 🧪, `**State**: AT-CHECKPOINT`), STOP
   with the combined smoke script, delivered as the smoke page (`smoke-page.md`).
   Otherwise → open the next wave immediately, same session, unless protocol.md
   §Session algorithm step 8 first opens its compaction window at this safe point.

**Every `continue` starts with resume-time validation** on the integration tip (quiet
form); a red tip is repaired before any wave opens, whatever PROGRESS claims — unless a
capped tip repair is awaiting the user's verdict, in which case the session asks.

**Before handing over ANY checkpoint script, make the build identifiable.** Bump the
version on the integration branch so it differs from the base branch's, and open the
script with (a) the terminal command that prints the current branch, (b) an executable
**containment check**, (c) the version
she should see, and (d) a **canary** — one cheap step whose result is OPPOSITE on the
base build, run FIRST, with "if it behaves the old way, stop and say so". On the smoke page this
is Step 0 — the gate, a non-verdict section rendered before every verdict step.
A script whose every step passes on the base build cannot detect that it ran against
the base build. This is not hypothetical: a pack that deferred its single bump to
close-out handed over a script saying "confirm the version reads X" when the base
branch also read X; the checkout had silently never happened, the user ran all twenty
steps against the base, and reported the un-fixed defects as failures. Note which
batch appeared to "pass" — the one whose steps deliberately exercise behaviour the fix
must NOT disturb. Those steps pass on old code by design, so they are the ones most
likely to disguise a wrong-tree run.

**The containment check is a command, not an eyeball.** Committing the checkpoint page
moves `HEAD` past the build the page describes, so a gate that asks the tester to
compare `git rev-parse HEAD` against the recorded build SHA can never agree, and every
run so far waived the difference by hand. The gate RUNS the comparison instead, naming
the tested SHA literally:

```text
git merge-base --is-ancestor <buildSha> HEAD
git diff --name-only <buildSha>..HEAD -- . ":(exclude).agents/"
```

The first must exit 0 — the tested build is in her history. The second must print
NOTHING — the pathspec excludes the ledger directory, so empty output IS the verdict
and she never reads a list to reach one. Anything it prints is a real code change made
after the build she is testing. Both are plain commands with no backslashes, so no
transport between sidecar and clipboard can mangle them; keep them that way rather than
adding a shell filter. The pathspec is DOUBLE-quoted on purpose — verified as published
in PowerShell, `cmd.exe` and Git Bash; single quotes reach git unstripped under
`cmd.exe` and the command dies with `Invalid path`. `build-smoke-page.mjs` refuses a
sidecar whose `gate.commands` omits either command or the SHA the sidecar itself records.

**Bump the PATCH component for checkpoint markers; save the MINOR for the release.**
The marker's only job is to differ from the base branch, so it costs a patch
(0.10.13, .14, .15). Bumping the minor at each checkpoint burns a release number per
checkpoint — one pack went 0.11 → 0.12 → 0.13 → 0.14 on a 0.10.12 base and was
renumbered to a single 0.11.0 at close-out. The changelog is written against the
release number, not the markers.

## Degenerate cases

- Every fence overlaps → every wave has width 1 → the run is sequential, still with
  minimal checkpoints. Nothing else changes.
- The repo versions per batch → bumps happen serially at each integration merge, so
  they never collide even inside a wave.
- No sub-agent support → the orchestrator implements a wave's batches one at a time
  in the main checkout (worktrees unnecessary); the wave map still decides what may
  proceed without a checkpoint in between.

## Changing the map mid-change

Allowed with the user's explicit sign-off: record the change + rationale in the
PROGRESS preamble and a Session log row. Sole standing exception: a recorded
`NEEDS_FENCE` deferral with no later wave moves the final checkpoint after the
continuation (protocol §Fence changes). Typical causes: a ⛔ batch forces
re-planning its dependents; a checkpoint failure reveals a batch was scarier than
classified (add a checkpoint after its fix-up).

**Fence extensions** are the one mid-wave change the orchestrator may make alone, because
they keep the invariant plan approval rested on: a `NEEDS_FENCE` path is granted only if
it is absent from every same-wave sibling's fence (including siblings already integrated
this wave) and from every extension already recorded; it is recorded in PROGRESS on the
integration branch, and the implementer updates its own Files line on its branch. A path
a sibling owns waits for the next wave; two batches needing the same region is a plan
error that goes to the user at the STOP.

## Legacy models

Ledgers scaffolded before the waved stack may name **strict sequential**, **linear
stack**, or **stacked waves** as their execution model, and typically smoke-gate
every batch. Drive them under their OWN contract — never rewrite one onto this model
without the user asking.
