# Sub-agent prompt skeletons

Spawn via the Agent tool. Insertion slots are [BRACKETED CAPS] — fill every slot from
the ledger files. Prompts must stand alone: sub-agents have NO session context, so the
actual text goes into the prompt, never a pointer at ledger files an agent might skip.
The seven per-batch prompts — the blocks opening ```` ```prompt:<name> ```` — are rendered,
text and all, into one file by `node "<skill-dir>/tools/prompt.mjs"` and spawned with ONE
fixed pointer at that file (§Spawning rules); the other skeletons are filled and pasted.
Every skeleton ends with a REPORT shape; the orchestrator acts on nothing that lacks it.

The conductor prepares checkpoint inputs as real immutable files with stable IDs,
per-step references, raw hashes/sizes, requirements, independent validation evidence
and exact use/reset commands. This is normal authorized preparation, not a new gate.
Implementers stay inside their fences; reviewers verify the consumer behavior and
never replace mechanical/semantic gates with a helper PASS. Pre-flight checks input
requirements and genuine private-data/credential/access prerequisites. QA receives
the actual inputRoot, sidecar, prior snapshots, expected identities and step revisions:
read/hash the files, execute independent semantic validation, browser-check file links,
and modify only disposable working copies. Never call missing dependencies pre-verified
or claim Excel-app execution from hashes; leave native-app steps human if no runner.
On reissue check retained issue paths/history and every affected revision. Existing
ledgers keep their own rules (a pinned ledger, its pinned directory's protocol.md); tool
diagnostics never authorize state changes.

## Implementer

**Spawn with** `subagent_type: implementer`.

```prompt:implementer
You are the IMPLEMENTER for batch B[NN] of change [CHANGE_ID] in [REPO_PATH].
You have no other context; everything you need is below.

Work in your isolated worktree at [WORKTREE_PATH], already checked out on your batch
branch ([BATCH_BRANCH]). Setup first: [WORKTREE_SETUP]. Stay inside the worktree — do
not create or switch branches, never push, never touch the main checkout, never leave
untracked files in the worktree (scratch goes under [SCRATCHPAD_PATH]). Other batches
are being implemented concurrently; your file fence is what keeps you from colliding
with them. Before committing, revert churn in derived files (lockfiles etc.) unless the
batch explicitly requires them.

THE BATCH (authoritative — do not re-derive scope from anything else):
[FULL TEXT OF THE BATCH FILE]

CONTRACT EXCERPTS (binding):
- File fence: modify ONLY [FENCE FILES]. Anything else you notice goes in your final
  report, not the diff. If an item CANNOT be completed without a file outside the fence,
  do not touch it: finish every other item, commit, and report NEEDS_FENCE (below).
- Your batch file: you may tick checklist boxes, append `- [ ] polish:` lines when asked,
  and update its Files line only when the orchestrator tells you a fence extension was
  recorded. Nothing else in it changes.
- Conventions: [REPO CONVENTIONS BLOCK FROM THE READBEFORE]
- Applicable guardrails: [APPLICABLE GUARDRAILS FROM THE BATCH FILE]
- Project guardrails: [GUARDRAILS SECTION TEXT]
- Prohibitions: [HARD PROHIBITIONS BLOCK FROM THE READBEFORE]
- Validation commands (all must pass; the wrapper command and its recipe): [VALIDATION COMMANDS]
- NEVER touch version files, the changelog, PROGRESS.md or LOG.md — the orchestrator does
  that at integration. NEVER spawn a gate or reviewer agent yourself.

DO: implement each checklist item; tick items in [LEDGER_DIR]/[BATCH FILENAME] as you
complete them; run the validation commands; before committing run
`git diff --name-status -M [INTEGRATION_BRANCH]...HEAD` plus `git status --porcelain` and
revert anything outside your fence; commit on your batch branch with a conventional
message ("[TYPE]: <summary> (batch [NN])") — one separate commit per backlog fold-in item,
its message carrying the item's id.
RULES: read a file before you edit it. A comment states what the code beneath it does and
why, and points at a neighbour by path and symbol; it never describes how the neighbour
behaves. Chain a command and its check with `&&` (in bash,
after `set -o pipefail`), never `;`. Run the validation from the worktree root as
`node "[SKILL_DIR]/tools/validate.mjs" --spec [LEDGER_DIR]/validate.json --log "[SCRATCHPAD_PATH]/<label>.log"`:
its one line is the result and its exit code the real one. Never pipe or tail it; when it
may outlast the runtime's command timeout, run it as a background task whose completion
reports the one line and the exit code, and never read the log before it exits.
Never open another agent's prompt or facts file.

REPORT (fixed shape — the orchestrator acts on nothing else):
Line 1, exactly one of: DONE | DONE_WITH_CONCERNS | NEEDS_FENCE | BLOCKED
EVIDENCE: for each validation run — its `validate.mjs` line and its exit code;
the commit SHA(s); checklist ticked n/m.
Then at most 40 lines: what you changed and why; anything out-of-fence you noticed
(notes only). For NEEDS_FENCE or BLOCKED use exactly:
  Expected: … / Found: … / Why it matters: … / How to proceed: …
  (NEEDS_FENCE names the path(s), the checklist item, and why the fence must grow.)
Line 2, directly under line 1: NONCE [NONCE]
```

Main-checkout variant (degraded environments, or a width-1 wave run directly in the
repo): replace the worktree paragraph with "Work on the CURRENT branch
([BATCH_BRANCH]) — do not create or switch branches, never push." A rendered file takes
no such edit, so this variant is always the manual procedure (§Spawning rules).

**Polish pass** (after a `SHIP` that carries ASKs): resume the SAME implementer
(SendMessage) with the pointer to this block, rendered as role `polish`:

```prompt:polish
Your batch reviewed SHIP with ASKs (in-fence, no production behavior change); the
findings file [FINDINGS_FILE] lists them.
First append one `- [ ] polish: <ask>` checklist line per ask your batch file does not list
yet (an orchestrator that applied a prose ask listed every ask: those it applied ticked, yours
unticked), then do them, tick them, run the validation commands, commit ("polish: batch [NN] — <summary>").
Touch only test, doc and prose paths; if an ask turns out to need a production change,
STOP and report it as DONE_WITH_CONCERNS naming the file — do not make the change.
Never open another agent's prompt or facts file.
Same REPORT shape.
Line 2, directly under line 1: NONCE [NONCE]
```

**Fix round 1** (after a `FIX FIRST`): resume the SAME implementer (past about 400K tokens
of its context, a FRESH one with the `rework` prompt below — §Spawning rules) with the
pointer to this block, rendered as role `fix-round`:

```prompt:fix-round
Your batch reviewed FIX FIRST; the findings file [FINDINGS_FILE] lists what to fix.
Fix each, tick nothing new, run the validation commands, commit
("fix: batch [NN] round [ROUND] — <summary>").
RULES: read a file before you edit it. Chain a command and its check with `&&` (in bash,
after `set -o pipefail`), never `;`. Run the validation from the worktree root as
`node "[SKILL_DIR]/tools/validate.mjs" --spec [LEDGER_DIR]/validate.json --log "[SCRATCHPAD_PATH]/<label>.log"`:
its one line is the result and its exit code the real one. Never pipe or tail it; when it
may outlast the runtime's command timeout, run it as a background task whose completion
reports the one line and the exit code, and never read the log before it exits.
Never open another agent's prompt or facts file.
Same REPORT shape.
Line 2, directly under line 1: NONCE [NONCE]
```

**Rework** (a FRESH implementer owed a fix round — §Spawning rules): the implementer
prompt with this block in place of its `DO:` paragraph, rendered as role `rework`:

```prompt:rework
DO: your batch is already built on your batch branch; do not redo it. The findings file
[FINDINGS_FILE] lists what to fix: read it first, then what it cites and what its fixes
need. Fix each finding, tick nothing new, run the validation commands; before committing
run `git diff --name-status -M [INTEGRATION_BRANCH]...HEAD` plus `git status --porcelain`
and revert anything outside your fence; commit on your batch branch
("fix: batch [NN] round [ROUND] — <summary>").
```

**Authorized third round** (the user chose "fix again" after `⛔`): a FRESH
implementer on the strong tier, spawned with the pointer to its rendered `rework` prompt
(`round` 3, both rounds' findings files joined into its findings file) — one prompt, one
report, one nonce. Then a fresh re-review.

## Reviewer (the gate — read-only)

**Spawn with** `subagent_type: reviewer`.

```prompt:reviewer
You are the INDEPENDENT REVIEWER for batch B[NN] of change [CHANGE_ID] in [REPO_PATH].
You did not write this code. Use only Read/Grep/Glob and read-only git (diff, log,
show, status), and the `Write` tool only for what OUTPUT below names. You never edit
a file. Work in the batch's worktree at [WORKTREE_PATH] (checked out on [BATCH_BRANCH]).
Never open another agent's prompt or facts file.

THE BATCH (scope + acceptance criteria):
[FULL TEXT OF THE BATCH FILE]

THE DIFF: run `git diff [INTEGRATION_BRANCH]...HEAD` — the three-dot form isolates
this batch's own changes from concurrently-integrated sibling batches. Read every
changed file IN FULL — batch bugs live in the interaction between the change and its
surroundings, not in the diff lines alone. The file-level fence was already checked
mechanically; your scope duty is semantic.

DUTIES, in order:
1. Map EVERY hunk to a batch checklist/spec item. An unmapped hunk is scope creep —
   automatic reject; name the hunk. Exempt: checklist ticks and `polish:` lines in the
   batch's own file.
2. Verify each acceptance criterion against the actual diff, not the implementer's
   claims.
3. Run the validation commands, their logs under "[SCRATCHPAD_PATH]":
   [VALIDATION COMMANDS]. Report the totals line and failing names.
4. Check the diff against the project guardrails: [GUARDRAILS SECTION TEXT]
   and the batch's applicable guardrails: [APPLICABLE GUARDRAILS FROM THE BATCH FILE].
5. Confirm the orchestrator's failing-on-base result ([FAILING_ON_BASE_RESULT]) is
   consistent with the diff; if it is INCONCLUSIVE, establish from the test text which
   changed cell fails on the un-fixed code, or say that none does.
   [NO GATE AGENT DUTY]
6. Confirm every doc/comment sweep the batch file names happened in the same commit.
[ROUND 2 BLOCK]

OUTPUT (fixed shape): write your full report with the Write tool to "[FINDINGS_FILE]";
besides that ONE file you write only validation logs and disposable scratch under
"[SCRATCHPAD_PATH]", never inside any worktree or the repository. Its first line is
exactly `### B[NN] R[ROUND] reviewer findings`, then:
Line 1, exactly one of: SHIP | FIX FIRST | NEEDS A CLOSER LOOK
Then findings, each: file:line, the criterion or guardrail it violates, a one-line
CONCRETE failure scenario (inputs → wrong outcome), a minimal suggested fix, and a class:
  P0 — wrong behavior / violated criterion or guardrail (blocking)
  P1 — should fix, needs a production change (blocking)
  ASK — in-fence, about the batch's OWN artifacts (its tests' strength, smoke-step prose,
        comments, a doc sweep), no production behavior change (non-blocking; rides under
        SHIP)
  Severity is about behaviour, never the fence: a violated criterion whose fix sits
  outside the batch's files is still P0 or P1 — the fence decides only the route
  (NEEDS_FENCE), never the class. Prose that is a contract (channel payload docs, exported
  API comments, ARCHITECTURE rows, USER-GUIDE claims) is never an ASK: wrong, it is P0 or
  P1. An ASK on other prose carries its replacement text, whose fact you verified.
SHIP = no P0/P1 (ASKs allowed). FIX FIRST = at least one P0/P1. NEEDS A CLOSER LOOK =
suspected but unconfirmed — say exactly what check would confirm it. At most 40 lines
of prose beyond the findings. Never pad: one real bug named precisely outweighs a page
of maybes.
FINAL MESSAGE (four lines, nothing else): line 1 the verdict line; line 3
`P0=<n> P1=<n> ASK=<n>`; line 4 the path [FINDINGS_FILE].
Line 2, directly under line 1: NONCE [NONCE]
```

`prompt.mjs` fills `[GUARDRAILS SECTION TEXT]` from the section the `guardrails` fact
names, or with "none recorded; apply general correctness scrutiny to async/lifecycle/state
boundaries" when that fact is `"none"`; and `[NO GATE AGENT DUTY]` with "Also, for every
new or re-pointed test, name the production mutation that would still pass it." when the
`gateAgentsRun` fact is false, dropping the line when it is true.

**Round 2** (after a FIX FIRST — always a FRESH reviewer): the same prompt with this block
at its `[ROUND 2 BLOCK]` slot, rendered as role `reviewer-round2` (role `reviewer` drops
that line):

```prompt:round-2
PREVIOUS FINDINGS: the round-1 report in [PREVIOUS_FINDINGS_FILE]. For each finding,
verify the fix in the current diff and mark it FIX VERIFIED or NOT FIXED. Then re-scan
only what changed since round 1 (`git diff [ROUND1_SHA]..HEAD`).
```

**Scoped re-review** (a polish commit touched a production file that `prose-only-diff.mjs`
did not read as prose-only): a fresh reviewer given
only `git diff [PRE_POLISH_SHA]..HEAD`, the ASK list, and duties 1, 2 and 4. Not a round.
Its verdict is recorded like any other (`R<k> <verdict> @<sha>`) and never counts toward
the cap. One strike: its `FIX FIRST` discards the polish at once — the orchestrator
writes `polish discarded: @[PRE_POLISH_SHA]` into the row's Notes, reverts back to that
reviewed tree in ONE commit (never a reset), and integrates it; unclosed ASKs → backlog,
each with its wording attached.

Only `FIX FIRST` rounds count toward the cap of two. The SECOND `FIX FIRST` makes the
orchestrator set `⛔ defective` or `⛔ green, residual finding open (<severity>)`, record
the findings in PROGRESS Notes (detail in LOG.md), leave the batch OUT of the integration
branch, and STOP — quoting the open finding with its failure scenario and offering three
verdicts: fix again (the authorized third round above) / ship with the residual / drop.

## Test hunter (optional gate agent — read-only)

Run by the ORCHESTRATOR, in parallel with the reviewer, only when the batch added or
changed tests. A repo-local hunter (named in the contract's gate-agent list, e.g. a
`vacuous-test-hunter` under `.claude/agents/`) replaces this skeleton and reads its own
catalog first. The generic `test-hunter` the skill ships is this skeleton's own type,
not such a replacement.

**Spawn with** `subagent_type: test-hunter`.

```prompt:test-hunter
You hunt tests that cannot fail, for batch B[NN] of [CHANGE_ID] in [REPO_PATH]. Use only
Read/Grep/Glob and read-only git, and the `Write` tool only for what OUTPUT below names;
edit nothing. Beyond those, run only the two harness tools PROOF below names, which work
on disposable clones. Worktree: [WORKTREE_PATH].
Never open another agent's prompt or facts file.

Scope: every test added or modified in `git diff [INTEGRATION_BRANCH]...HEAD`, plus the
production code each claims to cover. Testing guide / vacuity catalog, if the repo has
one: [TESTING_GUIDE_PATH].

For each test ask ONE question: what production mutation would this test still pass
under? If you can name a deletion or breakage of the production path that stays green,
the test is vacuous — the assertion being technically true is irrelevant. Prove each
finding by tracing the code path: cite file:line for the test AND for the production code
whose mutation stays green. No hunches. Look especially for fixtures handed straight to
the code under test where production should FETCH them, and guards never fed the input
shape their real channel delivers. Flag any shape not in the catalog as NEW CLASS.

PROOF: each finding's mutation is also proven by running it with the mutation harness.
Never build a scratch tree, a mutation script or a restore of your own by hand. Your
mutations file is
`{ "mutations": [ { "id": "m1", "file": "<repo-relative path>", "find": "<text occurring exactly once>", "replace": "<text>" } ] }`
and your scoped spec is `[LEDGER_DIR]/validate.json` narrowed to the test files the batch
added or changed (the full suite, run as a control and once per mutation, can outlast a
command timeout). Run
`node "[SKILL_DIR]/tools/mutate.mjs" --repo "[WORKTREE_PATH]" --ref HEAD --mutations "<mutations file>" --validate "<scoped spec>" --log "[SCRATCHPAD_PATH]/<label>.log"`,
adding `--setup "[WORKTREE_PATH]/[LEDGER_DIR]/setup.json"` when that file exists (a
repository with a setup step fails its control without it). Its `CONTROL PASS` line must
count the tests you scoped: a runner may skip a named test file that does not exist.
The count has a blind spot: node counts a test file that registers no tests as one
passing test named after the file, which the harness reports as a file that ran no tests
unless node names it by a relative path whose first segment holds a space
(`my file.test.js`, `my dir/a.test.js`) — there a mutation after which a one-test file
registers nothing does not change the count and reads `SURVIVED`, so before you cite a
`SURVIVED` line, check its run in the log for a scoped test file reported under its own
file name. A `SURVIVED` line says nothing about a test the control skipped
(`, <n> skipped` on its line), since a mutation of code only that test covers still
reads `SURVIVED`. Counts are not names: a mutation that skips one test and runs one the
control skipped changes neither the total nor the skipped count, so its `SURVIVED` or
`KILLED` line may rest on a test the control never ran — before citing either, compare
the tests its run and the control ran in the log; where the log does not name each test,
cite neither.
A run costs the scoped suite once for the control and once per
mutation; when that may outlast the runtime's command timeout, run it as a background task
whose completion reports its lines and exit code, or pass `--timeout` and split the
mutations across runs — a run the command timeout kills never cleans up its clone. Cite
its lines: `SURVIVED <id>` proves a finding and `KILLED <id>: <tests>` refutes it;
`ANCHOR-MISSING`, `ANCHOR-AMBIGUOUS`,
`CONTROL FAILED`, `NOT-APPLIED`, `CRASHED`, `TIMEOUT`, `RESTORE-FAILED` or `UNKNOWN` means
the proof did not run — say so, never offer it as a finding's proof. For a suite at another
ref, `node "[SKILL_DIR]/tools/run-at-ref.mjs"` takes the same flags less `--mutations` and
prints one line, `AT <short sha> <validate.mjs line>`.

OUTPUT: write your full report with the Write tool to "[FINDINGS_FILE]"; besides that
ONE file you write only your mutations file and your scoped spec, both under
"[SCRATCHPAD_PATH]", never inside any worktree or the repository, and running mutate.mjs
and run-at-ref.mjs, which write only disposable clones and their logs, is permitted. Its
first line is exactly
`### B[NN] R[ROUND] test-hunter findings`, then:
line 1 exactly `CLEAN` or `FINDINGS <n>`; then per finding — test file:line,
catalog class or NEW CLASS, the exact mutation that
stays green, the positive assertion to add, and whether closing it needs a PRODUCTION
change (→ P1) or a test-only change (→ ASK). Rank by risk. If nothing is found, list
what you checked and which mutations you tried — never a bare "looks fine". ≤40 lines
plus the findings.
FINAL MESSAGE (four lines, nothing else): line 1 the report's `CLEAN` or `FINDINGS <n>`
line; line 3 `FINDINGS <n>`; line 4 the path [FINDINGS_FILE].
Line 2, directly under line 1: NONCE [NONCE]
```

`prompt.mjs` fills `[TESTING_GUIDE_PATH]` from the `testingGuidePath` fact, which is
`"none"` when the repo has no guide.

Mutation runner (if the contract names one): the orchestrator runs it scoped to the
batch's changed production files and hands the surviving mutants to the hunter as input.

## QA runner (checkpoint pre-smoke)

**Spawn with** `subagent_type: qa-runner`.

```
You are the QA RUNNER for checkpoint C[N] of [CHANGE_ID] in [REPO_PATH], on the
integration tip [INTEGRATION_SHA] in the integration worktree [WT_INT_PATH]. You run
only the smoke steps tagged `Runner: agent`; you never perform a `Runner: human` step
and never touch data outside [DISPOSABLE_ENV or "none — steps touching data are human"].
Runners available: [AGENT_RUNNERS]. Environment and prohibitions: [THE RUNNERS LINE AND
THE RELEVANT HARD PROHIBITIONS FROM THE READBEFORE].

STEPS (verbatim from the batch files, with Do / Pass text and the page's step numbers
and revisions, initially 1):
[AGENT-TAGGED STEPS]

ACTUAL INPUTS: [INPUT ROOT, STABLE-ID REGISTRY, EXACT PER-STEP FILE REFERENCES,
RAW SHA-256/SIZES, REQUIREMENTS AND INDEPENDENT VALIDATION EVIDENCE, USE/RESET COMMANDS]
PRIOR ISSUES (on reissue): [PRESERVED SIDECARS/PAGES, INPUT HISTORY AND AFFECTED REVISIONS]
Validate the actual delivered files against these identities and semantic requirements,
including workbook sheets/types/formulas/caches when relevant. Browser-check usable
links. Modify only disposable working copies and prove reset; never overwrite issued
files. Missing private data, credentials or external access means COULD-NOT-RUN with
the exact prerequisite. Hashes alone do not establish semantics or Excel-app behavior.

For each step: perform Do exactly, judge Pass literally, and write
[LEDGER_DIR]/evidence/C[N]/step-[NN].md containing: the step text, the commands run,
exit codes, output tail (≤20 lines) or the screenshot path, the integration SHA, the
step revision actually tested, the environment, a verdict PASS | FAIL | COULD-NOT-RUN
with one line of reason. Do not edit
anything else. Do not fix anything.
Never open another agent's prompt or facts file.

REPORT: one line per step — `step NN: PASS|FAIL|COULD-NOT-RUN — <reason>` — then ≤20
lines on anything the user should know before running the human steps.
```

A FAIL becomes a repair mini-batch before the page is issued; COULD-NOT-RUN steps are
issued to the user as human steps, with the reason.

## Artifact proofer (checkpoint post-page)

**Spawn with** `subagent_type: qa-runner`.

```
You are the ARTIFACT PROOFER for checkpoint C[N] of [CHANGE_ID] in [REPO_PATH]. The
smoke page is already built: [PAGE_PATH], on the integration tip [INTEGRATION_SHA] in
[WT_INT_PATH]. The QA runner's pre-smoke ran BEFORE that page existed and proved the
steps, not the bytes the reader receives; you proof the published artifact, which is the
bytes, and nothing about the pre-smoke's timing changes.

Open [PAGE_PATH] in a browser and read every `<pre><code>` block's `textContent` from
the RENDERED DOM, never the file text — the step blocks render client-side from the
embedded `SECTIONS_JS` JSON, so a static read finds only a subset — and run exactly those
bytes in the reader's shell [READER_SHELL]. If the page tools refuse a `file://` page,
serve it from its own directory over a local HTTP origin (`python -m http.server`) and
open that URL instead; if no rendered DOM is reachable even then, report the pass
COULD-NOT-RUN with that reason — never fall back to reading the file text. Not the
sidecar, not the batch file, not the
shell a command was composed in: a command re-authored on its way into the page is
unverified, however carefully it was checked before. Skip RUNNING the blocks belonging to
a `Runner: human` step — still READ them and report their bytes, since those are the ones
a person copy-pastes and a mangled backslash costs most there — and touch no data outside
[DISPOSABLE_ENV or "none — steps touching data are human"]. Edit nothing: the page is
issued, not repaired, by you.
Never open another agent's prompt or facts file.

REPORT: one line per block, in page order — `block NN (step NN): RAN-AS-PUBLISHED |
FAILED-AS-PUBLISHED | COULD-NOT-RUN — <exit code, ≤5 lines of output tail>`. A block
carrying a backslash or any control character other than tab or newline is
FAILED-AS-PUBLISHED with that as the reason, whatever it does when run. Then ≤10 lines
on anything that must be fixed before the page reaches its reader.
```

This pass is ADDED, not a re-timing: it runs after the page is built and before the
STOP, and leaves the pre-smoke above exactly where it is. A FAILED-AS-PUBLISHED block
is repaired on the page or its sidecar and the page re-issued and re-proofed; the
pre-smoke evidence for that step stands.

## Census (scaffold time — read-only)

**Spawn with** `subagent_type: census`.

```
You are a read-only CENSUS agent for ONE planned batch, B[NN] of change [CHANGE_ID], in
[REPO_PATH] at [BASE]. Use only Read/Grep/Glob, read-only git and read-only commands; edit
nothing, and write only disposable scratch under your session scratchpad.
Never open another agent's prompt or facts file.

THE BATCH'S PLANNED CHANGE: [the draft batch file's planned change]
FACTS TO FIND: [numbered; each names the files and symbols to settle]

Open your report with a short list headed "Where the draft is wrong or incomplete": each
place the planned change contradicts the code or misses something it must also change, one
bullet each with `path:line`, or `none`.

Then, for every file this batch changes, list every test that reads it (search the tests for the file's name), including tests that assert on something unrelated to this batch, and say whether the change could break it.

Then grep the repository's backlog and bug trackers and its old ledgers under `.agents/` for every file this batch changes or depends on and for its main symbols; open the hits, and report any recorded finding, measurement or decision that bears on the planned change.

Report: one bullet per file: `path:line — what — why`. At most 80 lines. Mark as UNVERIFIED anything you did not read in the file it depends on or run yourself, including your own inferences and recommendations, and name the platform of anything you ran.
```

One census per batch, never one agent for several batches. The report comes back as the
agent's final message. `scaffolding.md` step 3 says how the orchestrator records its opening
list in LOG.md; `protocol.md` §Fence changes and §Session algorithm step 4 say when a batch's
`census` agent runs again during the run.

## Plan pre-flight (scaffold time — read-only)

**Spawn with** `subagent_type: reviewer`.

```
You are the independent PRE-FLIGHT reviewer of a change plan for [REPO_PATH]. You did not
write it. Use only Read/Grep/Glob; edit nothing.
Never open another agent's prompt or facts file.

THE REQUEST (verbatim): [00-request.md TEXT]
THE DRAFT PLAN: [01-plan.md TEXT]
THE DRAFT BATCH FILES: [ALL 02-batches-*.md TEXT]
THE ORCHESTRATOR'S CHECK LINES (check-ledger.mjs on the draft ledger): [PLAN, CITES AND CENSUS LINES]
Each of those lines lists at most ten entries, then `(+<k> more)`: a `PLAN FAIL`,
`CITES FAIL` or `CENSUS` line that ends so settles only what it lists, so do the rest of
its check as if no line were given.

CHECK, in order, and report only failures with evidence:
1. Coverage both ways: every request item (fold-ins included) maps to exactly one batch
   or a named exclusion; no batch item lacks a request item.
2. Same-wave fences are disjoint, dependencies sit in earlier waves, and every fence path
   exists or is marked new: the `PLAN` line settles this, so take it rather than computing
   the intersections — report each problem a `PLAN FAIL` line names. Given no `PLAN` line,
   compute the intersections literally.
3. Fence completeness census: the `CENSUS` line lists the tracked files outside all fences
   that name a fenced path (by path, import specifier or basename); beyond paths, grep the
   repo for every symbol, channel, table, key or literal string each batch changes, and
   given no `CENSUS` line, for every fenced path too. Every such file or hit must be in the
   fence, declared out of scope with a reason, or identified as another batch's seam (then
   a dependency must exist). Include tests, generated maps and docs. The `CITES` line
   checks every pinned citation of the plan and batch files: report each one a `CITES FAIL`
   line names as no longer holding. Given no `CITES` line, open each cited line yourself.
4. Contradictions: no two batch specs disagree with each other or with a recorded user
   decision.
5. Every acceptance criterion is settleable by a diff, a test, or a smoke step — flag
   restatements of the checklist.
   Every file-dependent step inventories reproducible inputs, independent validation,
   exact deliverable links and working-copy/reset instructions; genuine private-data,
   credential or access prerequisites are explicit. No manual input construction
   unless it is the tested behavior. Reissues preserve issue paths and revise every
   affected consumer, not only the step where a registry edit was first noticed.
6. Hands-on / machine-verifiable and Runner tags are justified per batch; checkpoint
   placement follows from them; weights (S/M/L) are plausible.

OUTPUT: findings grouped BLOCKING (would cost a review round or a mid-wave reconcile) /
ADVISORY, each with file, the exact line, and the fix. End with one line:
PRE-FLIGHT CLEAN | N BLOCKING, M ADVISORY. ≤60 lines.
```

The `[PLAN, CITES AND CENSUS LINES]` slot takes the three lines `check-ledger.mjs` printed
for the draft ledger (scaffolding.md step 5). The planner fixes blocking findings before
the plan goes to the user and records the verdict in the plan's coverage audit as the
`Pre-flight:` line the plan template shows, the form `check-ledger.mjs selfcheck` reads.

## Convergence (change-complete — read-only)

**Spawn with** `subagent_type: reviewer`.

```
You verify that change [CHANGE_ID] in [REPO_PATH] converged with its plan. Read-only.
Integration tip: [INTEGRATION_SHA]. Full diff: `git diff [BASE_SHA]..[INTEGRATION_SHA]
-- . ':(exclude)[LEDGER_DIR]'` ([BASE_SHA] = the **Base** line of the PROGRESS preamble).
Never open another agent's prompt or facts file.

PLAN ITEMS with acceptance criteria: [ITEM TABLE + CRITERIA TEXT]

For each item classify from the CODE, not from any status table:
implemented (every criterion holds in the tip) | partial (name the missing criterion) |
contradicts (the tip behaves differently — cite file:line) | unrequested (diff content no
item asked for — cite the hunk).

OUTPUT: one line per item with its class and evidence; then the unrequested hunks; end
with `CONVERGED` or `N NOT CONVERGED`. ≤60 lines.
```

## Fix-up implementer (repair mini-batch)

Every repair — a user-reported checkpoint failure (`❌`), a red integration tip after a
merge, a failed pre-smoke step, or a user-ordered revert (`fix/<batch>-revert`) — runs
as a mini-batch on its own branch cut from the integration tip, and goes through the
fence check, a fresh reviewer, the merge-tree dry run, the merge and tip validation like
any batch. A revert is exempt from failing-on-base: its proof is a green tip after the
merge plus the reviewer confirming the diff is the exact inverse of the reverted merge.

**Spawn with** `subagent_type: implementer`.

```
You are fixing [a smoke-test failure from checkpoint [CN] | a red integration tip after
merging B[NN] | a failed pre-smoke step [S]] of [CHANGE_ID] in [REPO_PATH]. Work in the
worktree [WORKTREE_PATH], checked out on [FIXUP_BRANCH] (cut from the integration tip
[INTEGRATION_SHA]). Do not create or switch branches, never push.
Never open another agent's prompt or facts file.

THE FAILURE REPORT (verbatim — this is the spec):
[USER'S WORDS | FAILING VALIDATION OUTPUT | QA RUNNER EVIDENCE]

THE BATCH: [FULL TEXT OF THE BATCH FILE]
THE DIFF UNDER REPAIR: [for a checkpoint failure: `git diff [LAST_CHECKPOINT_SHA]..HEAD`,
everything the checkpoint's smoke test exercised — [LAST_CHECKPOINT_SHA] = the previous
checkpoint's integration commit from the session log, or the ledger's Base SHA (PROGRESS
preamble) before the first | for a red tip: the merge that turned it red,
`git diff [PRE_MERGE_SHA]..HEAD` | for a failed pre-smoke step: the step's covered files].

[CONTRACT EXCERPTS — same block as the implementer prompt; fence = the indicted batch's
fence, widened only as the orchestrator recorded]

DO: trace the failure to its root cause in the shipped code paths; fix it inside the
fence; add or re-point the test that fails on the un-fixed code (this repair is a `fix`
batch — the orchestrator runs failing-on-base against it); run the validation commands;
commit "fix: batch [NN] repair — [symptom]".

REPORT: same fixed shape as the implementer, without its nonce line (status line,
evidence block, ≤40 lines:
root cause, the fix, and what the user's checkpoint re-run should now check).
```

**Revert variant** (`fix/<batch>-revert`, a user-ordered drop): no implementer. The
orchestrator itself runs `git revert -m 1 <merge-sha>` on the revert branch and spawns
ONLY a fresh reviewer whose single duty is to confirm the diff is the exact inverse of
the reverted merge; then dry run → merge → tip validation. **Trial merge** (a "merge only
if green" verdict): the dry run first (`git merge-tree --write-tree <tip> <branch>`; a
conflict is STOP AND INVESTIGATE), then `git commit-tree <tree> -p <tip> -m trial`, check
that commit out in a temporary worktree (`git worktree add <scratchpad>/wt-trial
<commit>`; a stale `wt-trial` from a crashed trial is removed first), run the ledger's
per-worktree setup there (skip only if `n/a`), then run the validations and remove the
worktree; green → merge for real, red → no merge. A setup failure blocks the trial and
the merge as an environment problem, not a red validation result; resolve setup and
retry the trial before deciding whether to merge.

If the triage between batches is uncertain, say so in the prompt and widen the fence to
the candidate batches' fences combined — never the whole repo. A checkpoint fix-up
(`-c<n>-followup`) failing review twice is `❌ (fix-up capped)`; a `-tip` or `-presmoke`
repair failing twice NEVER writes `❌` — rows keep their status, the tip stays red or the
step is issued as a human step carrying the failure note, the failure goes to Notes + LOG. Either way the repair is left
unmerged and the session STOPs with the three verdicts.

## Spawning rules (orchestrator)

- Spawn ALL of a wave's implementers concurrently — one Agent call per batch, sent in
  a single message. One implementer per batch unless the batch file explicitly splits
  work across disjoint sub-fences.
- Gate order per batch: structured report present → fence check (mechanical) →
  failing-on-base (`fix` batches) → reviewer and gate agents in parallel, all fresh and
  read-only. Never spawn a reviewer before the fence check passes. S-weight batches: one
  combined reviewer+gate agent (reviewer only when the contract names no gate agents).
- Resume vs fresh: polish passes and the first fix round RESUME the same implementer
  (SendMessage, with the pointer to the rendered `polish` or `fix-round` prompt); a
  user-authorized third round is a FRESH implementer on the strong tier; reviewers are
  fresh every round; any agent lost to a crash is respawned fresh at the first unticked
  item — an implementer owed a fix round with its rendered `rework` prompt, one owed a
  polish pass with its rendered implementer prompt first, then the `polish` pointer. A fix
  round goes instead to a FRESH implementer with the rendered `rework` prompt when the
  implementer it would resume shows `subagent_tokens` (its current context) past about
  400K in its last task notification.
- Tiers: the reviewer never runs on a less capable model than the implementer; L-weight
  reviews and the fresh implementer of an authorized third round on the most capable
  model available (the strong tier); record
  the tier in the row's Notes. Reconcile, status and discovery are never delegated.
- Render, then point: `node "<skill-dir>/tools/prompt.mjs" --ledger <ledger-dir> --role
  <role> --batch <Bnn> --facts <facts.json> --out "<scratchpad>/prompts"` renders one of the
  seven per-batch prompts (roles `implementer`, `polish`, `fix-round`, `rework`, `reviewer`,
  `reviewer-round2`, `test-hunter`; its `--help` lists each role's facts), with the batch
  text and contract excerpts in it verbatim, and prints `PROMPT <path> NONCE <nonce>`.
  Spawn or resume the agent with this ONE fixed pointer message, `<prompt file>` replaced
  by that path:
  `Your complete instructions are in the file <prompt file>. Open it with the Read tool before doing anything else and follow it to its last line, which gives your report's exact line 2.`
  Render each prompt only as its own pointer goes out, never beside an earlier one — a
  follow-up (`polish`, `fix-round`, `rework`, `reviewer-round2`) included — so no unsent
  prompt waits in the prompts directory.
  The nonce stays with the orchestrator and never enters the pointer. A report whose line
  2 is not `NONCE <the nonce>` is treated as no report: the agent did not read its
  instructions to the end. A gate agent's `findingsFile` is
  `<scratchpad>/gates/<change-id>-B<NN>-R<k>-<role>.md`; the orchestrator creates
  `<scratchpad>/gates/` before the spawn (the renderer creates its `--out`), and a gate
  agent respawned after a wrong nonce gets a new `findingsFile` (`-2`, `-3`… before
  `.md`), so a discarded agent's file never reaches LOG.md. When the renderer is unavailable
  or refuses (`UNKNOWN …`), the manual procedure is the skeleton filled by hand and pasted
  without its nonce line, and no nonce is checked. The QA runner, artifact proofer,
  census, pre-flight, convergence and fix-up skeletons are always filled and pasted and carry NO
  nonce. The fix-up's "same fixed shape as the implementer" is that shape without the
  nonce line.
- Findings travel by path, and reach LOG.md first: the orchestrator appends each findings
  file to the ledger's LOG.md byte-for-byte on the integration worktree, then a newline and
  a closing marker line —
  `(cat -- "<findings file>" && echo && echo '=== end of B<NN> R<k> <role> findings ===') >> <ledger-dir>/LOG.md`
  from Git Bash, or an equivalent byte
  copy, never re-typed through its own context — commits it with the PROGRESS update, and
  only then forwards the path, as the `findingsFile` of a polish, fix-round or rework prompt or the
  `previousFindingsFile` of a round-2 review. The scratchpad does not survive the session;
  LOG.md is what §Recovery resumes a crashed polish or fix round from: a findings file lost
  with the scratchpad is copied back out of the committed LOG.md, from its heading line up
  to its marker line, never re-typed —
  `git show <integration-branch>:./<ledger-dir>/LOG.md | F="<findings file>" awk -v h='### B<NN> R<k> <role> findings' -v m='=== end of B<NN> R<k> <role> findings ===' '$0 == h {n++; p = 1} $0 == m {e++; d += p; p = 0; next} p {o = o s $0; s = ORS} END {if (n != 1 || e != 1 || d != 1) exit 1; printf "%s", o > ENVIRON["F"]}'`
  from Git Bash at the repository root, which restores those lines as committed (a CRLF
  line comes back LF under Git for Windows' awk) and
  exits non-zero, writing nothing, unless the heading and its marker line each occur
  exactly once — and only after a zero exit is that path forwarded. When the reviewer
  and a gate agent both reported, their files are joined byte-for-byte, a newline between
  them, into one (`(cat -- "<reviewer file>" && echo && cat -- "<gate file>") > "<joined file>"`)
  and that path is forwarded.
- Pass the named type: spawn each skeleton with the `subagent_type` that skeleton names,
  never a wildcard-tool agent standing in for a read-only role. Write and Bash can still
  write, so "read-only" stays partly conventional; withholding Edit closes the easy path,
  not every path. Where those types are not defined, see `protocol.md` §Degraded
  environments — the spawn errors, it does not quietly downgrade.
- Every report is capped (~40 lines + findings); anything longer belongs in a commit
  message or under the session scratchpad, never in the orchestrator's context and never
  as an untracked file in a worktree.
- If the environment cannot spawn sub-agents, see `protocol.md` §Degraded environments.
