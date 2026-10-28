# Features: replace mechanical orchestration work with commands

Merged from three audits dated 2026-09-22 (automation, determinism and token-sink; the
source files have since been removed), plus the transcript analyses and cross-reviews done
after them. Claims those reviews showed to be wrong are removed or corrected; the
last section lists them. Pinned to commit `fceab31`, dated 2026-09-22.

## Baseline

These are the three most recent runs, measured from their session transcripts (the
orchestrator and every sub-agent).

| Run | Ledger | Batches |
|---|---|---|
| R1 | `OS-20260919-backlog-sweep` | 3 + C1 |
| R2 | `OS-20260920-interview-sizing-backlog` | 7 + C1 |
| R3 | `OS-20260921-backlog-closeout` | 4 + 1 repair + C1 |

- **Input side:** 538M tokens (522M cache reads, 16M cache writes).
  - The orchestrator used 55%. Its context grew to 480–740K tokens per run.
- **Output:** 4.34M tokens.
  - Orchestrator: 1.07M, of which about 577K was reasoning.
  - Sub-agents: 3.27M.
- **Reasoning stays in context.** The orchestrator's reasoning, prompts and LOG text stay in its context. Every later call re-reads them.
- **Tool errors:** 158 of 3,994 tool calls were flagged as errors.
  - 47 of the 68 sub-agents hit at least one.
  - About 59 more failures were hidden behind a zero exit code.

## Summary

The token figures are savings across the three runs combined, estimated per feature on its own. The first figure is input-side tokens, the second is output tokens. Parentheses give the cautious–generous range.

| # | Feature | Size | Tokens saved: central | (range) | Also buys |
|---|---|---|---|---|---|
| 1 | Ledger transition commands | L | 43M / 130K | (27–54M / 87–154K) | Prevents PROGRESS and commit corruption |
| 2 | Fence gate enforcement + scaffold parse check | S | 15M / 97K | (10–19M / 63–118K) | Closes a gate that was skipped |
| 3 | Rendered prompts + file relay | M | 49M / 237K | (29–56M / 142–256K) | Removes "forgot a block" errors |
| 4 | Reconcile + discovery summary | M | 26M / 6K | (18–28M / 4–7K) | Crash-safe resume |
| 5 | Validation wrapper | S | 20M / 119K | (13–24M / 80–135K) | Stops hidden test failures; saves wall-clock time |
| 6 | Mutation and probe harness | M | 54M / 709K | (34–67M / 463–861K) | Prevents harness false greens |
| 7 | Failing-on-base runner | M | 11M / 55K | (7–14M / 37–66K) | Grows with suite size; a hand run once faked a pass |
| 8 | Production/test path partition + polish classifier, prose polish | M | in shared row below; prose polish about 2M sub-agent / 15–20M input per five-batch pack | | Prevents a silently skipped re-review; ends agent rounds spent on comment wording |
| 9 | Scaffold, `check-ledger`, repo-fact detection | L | 48M / 95K | (32–57M / 65–111K) | Catches stale-copy defects and citation drift |
| 10 | Checkpoint tools | L | 34M / 179K | (22–43M / 123–208K) | Checked counts; published bytes proven |
| 11 | Close-out commands, with push separate | M | 23M / 51K | (15–29M / 33–63K) | Keeps push behind your explicit word |
| 12 | Sub-agent error digest + prompt rules | S | not measured | | Makes sub-agent errors visible |
| 13 | Small tools, including `next` | S–M | not measured | | |
| 14 | Contract slimming, no protocol pinning | S | ≈0 at run; about 8K output per scaffold | | One copy of the procedure; the mirror test and SHA pins retire |
| 15 | Conductor and agent budget rules | S | per scaffold: 7M / 0 from polling, plus up to a third to a half of sub-agent tokens after a control run | | Cheaper research agents, with citations verified before use |
| 16 | Tool-call batching line in the agent definitions | S | about 19% of each gate sub-agent's $ on the census; the implementer carries no line (it cost more in replays) | | Recall unchanged at max; the strict wording and CLAUDE.md placement both lost |
| 17 | Unlimited prose-only fold-ins, plus a run-end prose sweep (**high priority**) | S–M | not measured | | Docs and comment findings fixed where they are found, not registered |
| 18 | The backlog as a to-do list: a bar for registering, a rulings file, packs by production file (**high priority**) | M | not measured | | The backlog grows only by the user's ruling; settled items stop coming back |
| — | Shared: fewer re-verification calls (1, 7, 8) | | 8M / 12K | (5–10M / 7–16K) | |
| | **All together, overlap removed** | | **285M of 538M (53%) / 1.69M of 4.34M (39%)** | **(194–330M / 1.10–1.99M)** | |

Sizes are calibrated on the existing tools, which run 125–383 lines each, with 1.5–2.5× that in tests. S is under 150 new tool lines, M is 150–350, L is over 350.

## Build rules

These apply to every feature.

1. **The command's output is the answer.** No evidence dumps; full evidence goes behind a flag.
2. **Decision commands are read-only and fail closed.** Only explicit transition commands write. UNKNOWN or AMBIGUOUS always goes to you.
3. **One parser.** Every ledger writer and checker uses `check-fence.mjs`'s table and Files-line parsers. A writer refuses any row that parser cannot read.
4. **Pin tools by hash in the contract, never by copying them into each ledger.** On a hash mismatch: stop and ask, then either record an explicit upgrade or use the manual procedure. Tool copies inside a target repo get swept up by that repo's linters, test runners and bundlers.
5. **Push is a separate explicit command.** It runs only on your words, and refuses unless the commit being pushed is the one that was validated.
6. **Working-tree writes go only to scratch copies.**
   - Restore from saved bytes, never with `git checkout`.
   - Abort when an anchor matches anything other than exactly once.
   - Run an unmutated control first.
7. **No shell composition.**
   - Tools run under Node with explicit arguments.
   - Messages and content come from files.
   - The file's EOL style is preserved.
8. **Mind the doc mirror.**
   - Anything added to §Read-only evidence tools must be byte-identical in `references/protocol.md` and `templates/00-READBEFORE.md`, where two decision tables are SHA-256 pinned.
   - Only the gate-adjacent tools (reconcile, failing-on-base) belong there.
9. **The prose stays the spec.** Tests pin code-to-prose equivalence.

## Phase 1 — orchestrator core

### 1. Ledger transition commands — `ledger.mjs`

**Replaces:** hand edits of PROGRESS and LOG, plus the git steps of opening a wave and integrating a batch.

**Build:**
- **Cell editors:**
  - `set-status`, `note`, `session-log`, `set-state`.
  - `record-round <Bnn> "<verdict> @<sha> [asks=n]"` computes `R<k>`, the round cap and the resulting status, including the polish-phase rules.
  - `metrics <Bnn>` derives the metrics token from the recorded R-lines and fence runs; it is never typed by hand.
  - Each editor rewrites exactly one cell and keeps the file's EOL style.
- **`open-wave <n>`:**
  - Cuts branches idempotently.
  - Chooses the worktree root once, from the deepest tracked path measured against the 260-character Windows limit.
  - Runs setup, flips the PROGRESS rows, and commits.
- **`integrate <Bnn>`:**
  - Refuses to merge without a recorded `SHIP` verdict for the batch's exact commit; a later polish diff is classified per #8.
  - Reruns the fence tool and refuses anything but PASS or a recorded waiver (see #2).
  - Runs a merge-tree dry run, then `merge --no-ff`, then tip validation through #5.
  - Marks the row 🟢, writes the SHA and metrics into Notes, removes the worktree, and commits.
  - On a conflict it stops and prints the git output.
- **`checkpoint <Cn>`** and **`commit`**, which reads its message from a file.
- **LOG discipline:**
  - Factual lines (verdicts, SHAs, counts) are generated from recorded events.
  - Narrative is capped per entry.

**Evidence:**
- 94 hand bookkeeping calls (about 37M context, about 117K output tokens).
- Ledger 20 had 25 commits touching only PROGRESS or LOG: 10 touched PROGRESS, 15 were LOG-only.
- LOG.md reached 36 / 94 / 14 KB in the three ledgers.
- In R1, PROGRESS.md was wiped to 0 bytes.
- In R3, bash backtick substitution mangled a close-out commit, and CRLF was fixed by hand before 5 or more commits.
- A B01 row was left 🔄 after its merge (`19/LOG.md:398-401`), and `tbd` metrics remain in a ledger marked COMPLETE.
- The worktree path-length failure was rediscovered in four ledgers.
- 13 cleanup commands printed 92 `Permission denied` lines on `.git/worktrees` admin directories, none of them flagged as errors.

**Size:** L. About 400 tool lines plus 800 test lines, 2 batches, and contract prose updates in both mirrors.

**Saves:** 43M / 130K (27–54M / 87–154K).

### 2. Fence gate enforcement and scaffold parse check

**Replaces:** running the mechanical fence check by convention. In R3 it was never run: zero invocations across four batches and the repair.

**Build:**
- `integrate` reruns the fence tool just before merging. A stored PASS could go stale: the result also depends on the integration tip's plan and PROGRESS (`check-fence.mjs:87-95`). Only a waiver is stored: your words, bound to the batch commit and the paths it excuses.
- Implementers commit, then run the fence tool, instead of hand `name-status` and status checks. It reads only committed changes and flags anything left uncommitted (`check-fence.mjs:85,100`). It checks no EOL style, so those checks stay.
- The scaffold runs the fence tool's parsers over the freshly written ledger.

**Evidence:**
- The tool already returns UNKNOWN on a missing `**Files**: ` line (`check-fence.mjs:116-122`). R3's stale Files lines would have been caught at the first batch if the check had run.
- R1's fallbacks (5 UNKNOWN, 3 VIOLATION, 2 PASS out of 10 runs) came from two general defects that are now fixed:
  - the tool treated the system-wide git-lfs filter as unsafe;
  - it rejected wrapped `polish:` lines.

**Size:** S. About 70 tool lines plus 150 test lines, 1 batch.

**Saves:** 15M / 97K (10–19M / 63–118K), from implementers' hand checks, somewhat less now that EOL checks stay. Its main value is correctness.

### 3. Rendered prompts and file-based relay — `prompt.mjs`

**Replaces:** the orchestrator re-typing the eight skeletons, batch files and contract excerpts into every spawn call, then relaying findings verbatim.

**Build:**
- `prompt <role> --batch <Bnn> [--round k --findings <file>]` fills every slot from the ledger and writes the prompt to `<scratchpad>/prompts/`.
- The spawn prompt becomes about five lines: read this file, then echo its nonce on report line 2.
- Gate agents write their full findings to `<scratchpad>/gates/` and return only the verdict line and counts. The orchestrator forwards the file path, not the text.

**Evidence:**
- 68 spawns carried 572K characters of prompts, about 240K output tokens including reasoning. This is the orchestrator's largest single output category.
- Implementer prompts averaged 11K characters, and 16K in R2.
- 27 findings relays cost about 83K output tokens.
- A tool that merely prints the prompt for the orchestrator to paste leaves most of this cost in place.

**Size:** M. About 200 tool lines plus 300 test lines, and skeleton edits that are pinned by three test files. 1–2 batches.

**Saves:** 49M / 237K (29–56M / 142–256K).

### 4. Reconcile and discovery summary — `reconcile.mjs`

**Replaces:** re-deriving the 26-row §Recovery table by hand at every boot, and reading ledgers to classify them.

**Build:**
- `reconcile` prints claim versus git versus verdict for each row, with the matched Recovery rule and its action. AMBIGUOUS rows go to you.
- `status` mode becomes that command's output.
- `git-evidence.mjs discovery` defaults to one line per ledger (id, State, locations, suggested mode), with the full JSON behind `--evidence`.

**Evidence:**
- R2 read about 94K characters before its first command.
- Discovery now prints about 1 KB on this repo and on shipping-app (re-measured 2026-09-26; the earlier ~360 KB came from branches since deleted), so the summary half saves little and most of #4's value is `reconcile`'s crash-safe resume. It was never executed in the three runs; the orchestrators did discovery by hand instead.

**Size:** M. About 300 tool lines plus 600 test lines, 2 batches. This one is gate-adjacent, so it enters the doc mirror.

**Saves:** 26M / 6K (18–28M / 4–7K). The rest of its value is crash-safe resume, which is why it ships before #1's `integrate`: it is read-only, and it recovers a transition interrupted mid-way.

### 5. Validation wrapper — `validate`

**Replaces:** the retyped validation recipe, output trimmed with `tail`, and background runs polled with sleep.

**Build:**
- Generated at scaffold time from the interview's validation commands.
- Runs in the foreground and writes the full log to a file.
- Prints exactly one line: `PASS 306/306 (4m38s)` or `FAIL 2/306: <names> — log: <path>`.
- Returns the real exit code.
- Captures failing test names from the output stream, and prints `CRASHED before summary` when the summary never arrives.
- Uses name-extraction patterns for Node, Jest, pytest and Cargo; for anything else it reports the exit code and log path.

**Evidence:**
- There were 368 test runs.
- 162 outputs showing failing tests came back with exit 0 because of pipes.
- In R1, a failed merge was hidden behind a chained green validation.
- A full run of the 306-test suite takes about 4.6 minutes.
- 9 errors came from blocked sleeps or from Monitor being unavailable to sub-agents.

**Size:** S. About 150 tool lines plus 250 test lines, 1 batch.

**Saves:** 20M / 119K (13–24M / 80–135K). It ranks low on tokens but is kept for correctness and wall-clock time.

## Phase 2 — gate agents

### 6. Mutation and probe harness — `mutate.mjs`, `run-at-ref.mjs`

**Replaces:** every gate agent building its own scratch trees, inline edit scripts, anchor retries and restores.

**Build:**
- `mutate --ref <sha> --spec muts.json --run "<cmd>"` follows build rule 6. It reports killed or survived per mutation, with the failing test names.
- `run-at-ref <ref> -- <cmd>` gives read-only reviewers a disposable checkout.
- The agents still choose the mutations.

**Evidence:**
- About 950 sub-agent calls (≈74M context) were harness work: 62% of test-hunter context and 36% of reviewer context.
- This produced three recorded false or measured-nothing results: an absent anchor reported "67 pass / 0 fail", `git checkout` ate an edit, and Bash collapsed `\\b` into a clean result.
- Most projects have no mutation runner, and hunter mutations are targeted, one per finding, rather than a sweep.
- Part of this volume came from testing this repo's own docs, so the saving will be smaller elsewhere.

**Size:** M. About 240 tool lines plus 400 test lines, 1–2 batches. This is the first tool that writes a working tree, and it only writes scratch copies.

**Saves:** 54M / 709K (34–67M / 463–861K). It is the largest output saver.

### 7. Failing-on-base runner — `failing-on-base.mjs`

**Replaces:** hand-running protocol step 6b, which is already fully specified.

**Build:**
- Prints `PROVEN (k of n fail: <names>)`, `ALL-PASS (P0)` or `INCONCLUSIVE (<setup or load error>)`.
- Overlays the test files with `git checkout <branch> -- <path>`, never with a shell pipeline.
- Files that mix test and production code are named and left to the reviewer.

**Evidence:**
- R2's orchestrator spent 18 calls on it: staging tests, reverting a hunk by line range, removing worktrees.
- A `Set-Content -NoNewline` pipeline collapsed a test file into a fabricated pass (`20/LOG.md:199-204`).
- Its cost grows with install time and suite size, so it counts far more on a large repo than it did here.

**Size:** M. About 150 tool lines plus 250 test lines, 1 batch. Gate-adjacent, so it enters the doc mirror.

**Saves:** 11M / 55K (7–14M / 37–66K) here.

### 8. Production/test path partition and polish classifier

**Replaces:** the orchestrator deciding by eye whether a polish diff touched production code.

**Build:**
- New placeholders and an interview question declare which paths are production and which are test, doc or prose.
- `record-round` and `integrate` classify the polish diff: test/doc only integrates; any production path triggers the scoped re-review.
- **Prose polish** (added 2026-09-23). The path rule alone still sends every comment fix to a scoped re-review, because comments live in production files. Four additions:
  - `prose-only-diff.mjs`: strips comments from both sides of each changed production file and compares the remainder. Identical everywhere → prose-only, no scoped re-review. Fails closed: any doubt inside a string, regex or template literal, and any comment carrying a tool directive (`eslint`, `istanbul`, `c8`, `@ts-`, `prettier`) or a JSDoc tag, counts as code. JavaScript first; other languages keep the path rule.
  - A prose ASK carries the replacement text. The reviewer verified the fact when it flagged the claim; the orchestrator applies the wording with one edit. No implementer resume.
  - One strike: a polish-phase `FIX FIRST` discards the polish at once; the ASK goes to the backlog with the wording attached. The reviewed `SHIP` tree integrates either way.
  - Implementer rule: a comment states what the code beneath it does and why, and points at a neighbour by path and symbol; it never describes how the neighbour behaves.
  - `FIX FIRST` stays for prose that is a contract: channel payload docs, exported API comments, ARCHITECTURE rows, USER-GUIDE claims.

**Evidence:**
- At least seven hand classifications (`20/LOG.md:426-429`, `:720-723`, `:762`, `:1205`; `20/PROGRESS.md:49`; `21/PROGRESS.md:49`).
- No such partition exists in the placeholder registry, so on a mixed tree the scoped re-review can be silently skipped.
- `SA-20260922-high-priority-pack` (shipping-app): all five batches took `SHIP` at review round 1, then five polish-phase `FIX FIRST` verdicts followed, four on comments describing neighbouring code and one on retracted claims left in test text. B05 ran polish → review → fix → review → fix → review for one comment; B01 did the same and discarded the result. About ten agent runs plus the orchestrator calls around them, roughly one batch's cost.

**Size:** M. About 50 tool lines plus 100 test lines for the partition, plus about 120 tool lines and 200 test lines for the stripper and three skeleton/protocol edits. The registry is pinned by tests in both directions; the discard rule sits beside the SHA-pinned decision tables, so that edit re-pins deliberately. 2 batches.

**Saves:** part of the shared re-verification row, plus about 2M sub-agent and 15–20M input-side tokens per five-batch pack with prose findings (not measured in the three-run baseline). Its main value is correctness.

## Phase 3 — per-ledger and per-checkpoint work

### 9. Scaffold, `check-ledger` and repo-fact detection

**Replaces:** template filling, self-checks, plan arithmetic and environment facts, all done by hand. The three runs used three different improvised fill methods.

**Build:**
- **`scaffold --answers answers.json`:**
  - The model writes the plan prose, batch specs and facts into the answers file.
  - The tool fills all 46 placeholders and writes the ledger in the repo's EOL style.
  - It refuses a missing value or an unfilled slot, then runs the parse check from #2.
- **`check-ledger`** subcommands:
  - `selfcheck`: the §Mode new rules.
  - `plan`: same-wave fence disjointness as a set intersection, dependencies acyclic and in wave order, every fence path exists or is marked new, batch ids agree across plan, PROGRESS and batch files.
  - `cites`: every citation in the template's pinned form (a `path:line` followed by the symbol in backticks) still contains that symbol. Citations in other forms are listed for the planning review.
  - `census`: tests and docs outside every fence that reference a fenced path by repo-relative path, import specifier or basename. Most repos' tests import by relative path or module name.
- **`detect.mjs`** emits candidate answers for the interview: validation scripts and their quiet flags, version files, changelog ordering, default branch and shipment ref, branch prefixes, agent definitions, backlog id scheme, monorepo shape.
- **`env-facts.mjs`** prints the environment facts the contract records.
- **`scaffold` also writes the `Folded:` markers** for accepted fold-ins into the backlog file (about six hand calls in the 09-23 scaffold: three reads, four edits). #11's `fold` only handles close-out.

**Evidence:**
- R1 wrote an 11K-character one-off generator.
- R2 wrote about 49K characters of generators and regenerated four times to clear failures.
- R3 hand-patched a stale copied contract; its stale `**Files**` header came from an outdated installed copy of the skill.
- The self-check was rewritten in every run.
- The planning review was asked to compute fence intersections by hand.
- Citation drift appeared in every planning review (`19/LOG.md:143-146`, `:155-164`; `21/LOG.md:156-159`), and one drifted citation was steering a design decision.
- Three BLOCKING planning-review findings were census misses (`21/LOG.md:148-151`; `20/LOG.md:25-27`, `:38-40`, `:46-51`; `19/LOG.md:147-153`).

**Size:** L. About 650 tool lines plus 1,100 test lines, 3 batches.

**Saves:** 48M / 95K (32–57M / 65–111K). It is paid once per ledger, and repo-fact detection matters most on a new project.

### 10. Checkpoint tools — `assemble-sidecar.mjs`, `run-smoke.mjs`, `proof-page.mjs`

**Replaces:** hand-authored smoke sidecars, a QA runner inventing a command for every CLI step, and improvised page proofing.

**Build:**
- **`assemble-sidecar <Cn>`:**
  - Builds sections from the covered batches' Smoke sections, numbers steps continuously, and puts data-touching sections first.
  - Fills gate commands with the tested SHA, the page facts, and `pre` blocks from the evidence files.
  - On reissue it computes revision bumps against `--previous`.
- **`cmd` and `expect` fields** for agent steps: exit code, empty stdout, a regex, or a count.
  - `run-smoke <Cn>` runs those steps and writes the `step-NN.md` evidence files.
  - The QA runner model is spawned only for steps without `cmd`.
  - This also settles the blocked `summary.md` write.
  - Counts live in `expect`, where they are checked, instead of in prose, where they go stale.
- **`proof-page`:**
  - Renders the page with the DOM harness moved from `tests/` into `tools/`, and extracts every code block.
  - Rejects backslashes and control bytes, runs each block in the named shell, and prints one line per block.

**Evidence:**
- R1 first delivered a `.md` script, then hand-wrote a 13K-character sidecar and reissued it three more times; the rebuilt page had dangling `Section`/`Step` references.
- R2's 311-line sidecar came from a 16K-character one-off generator.
- R2's C1 had 18 agent steps, all CLI commands (18 evidence files, about 69 KB), and the counts in the step prose went stale.
- The R3 QA runner spent about 15 calls on page proofing.
- A static read of the page finds 3 code blocks, while the rendered page has 6.
- One published command contained a NUL byte.

**Size:** L. About 470 tool lines plus 800 test lines, a change to the smoke-step template, 2–3 batches.

**Saves:** 34M / 179K (22–43M / 123–208K).

### 11. Close-out commands

**Replaces:** hand coverage audits, backlog edits, merge-and-push sequences, branch and worktree cleanup, and archiving.

**Build:**
- `audit` checks the coverage table mechanically: no empty cells, every SHA exists and is an ancestor of the tip, every backlog id exists. It is read-only (rule 2).
- `fold` reruns `audit` and, on a pass, removes the fold-in ids from the backlog.
- `ship` does the local merge and validation, and writes the shipment record.
- `push` is separate, per build rule 5, and confirms with `ls-remote`.
- `cleanup` lists the ledger's merged branches and worktrees and removes them; it is a dry run by default.
- `archive` does the `git mv`.

**Evidence:**
- Close-out and cleanup took 126 calls (about 44M context).
- R2 wrote a 10.5K-character one-off script just to edit BACKLOG.md.
- Three coverage audits were re-verified by hand.

**Size:** M. About 300 tool lines plus 500 test lines, 2 batches.

**Saves:** 23M / 51K (15–29M / 33–63K).

## Phase 4 — optional

### 12. Sub-agent error digest and prompt rules

**Build:**
- A script counts each sub-agent's flagged and hidden errors by class, from its transcript, and attaches the digest to the gate record.
  - It depends on Claude Code's transcript format.
- Three prompt rules:
  - read before edit;
  - chain with `&&` and `set -o pipefail`, never `;` between a command and its check;
  - run validation in the foreground.

**Evidence:**
- Completion notices carry status, report and usage, but no error count.
- Reports mentioned tool errors only when an error broke the agent's own evidence (2 cases).
- The largest error classes were Edit before Read (40) and broken improvised scripts (44).

**Size:** S. About 120 tool lines plus 150 test lines, and prompt prose. 1 batch.

**Saves:** not measured. It buys visibility, and fewer retries indirectly.

### 13. Small tools

- **Invisible-byte scan.** Exposes the suite's control-character sweep as a tool. It was rewritten ad hoc three times (`20/LOG.md:821-825`, `:1257-1261`).
- **Stale-install check.** Compares the installed skill against the hash pinned in the contract. The stale copy was diffed by reasoning in two ledgers (`21/LOG.md:200-205`).
- **Run-cost report.** Promotes the transcript scripts behind these estimates into a tool, so you can compare runs before and after. It counts the activity each feature targets (bookkeeping calls, prompt characters, harness calls), because runs of different work do not compare on totals. It depends on the transcript format.
- **`next`.** Picks the single next action from `reconcile`'s output and the session algorithm. Build it last, if at all; `reconcile` already prints each row's action.

**Size:** S–M. About 500 tool lines plus 600 test lines in total, 2 batches.

## Phase 5 — added 2026-09-23 from the operator-ux scaffold and run

Measured on `SA-20260923-operator-ux-pack` (shipping-app): the scaffold session (200 conductor calls, 67.7M cache-read, 7 sub-agents at 1.51M tokens) and the run session through B04 round 1 (111 calls, 26.7M cache-read, 26 sub-agent runs at 6.0M tokens), against the three pre-rewrite scaffolds on the same repo (54–59 calls, 4.5–10.8M cache-read).

### 14. Contract slimming, no protocol pinning

**Replaces:** the template's copied procedure sections — session algorithm, recovery table, boot sequence, most of the git model and the close-out, about 33K of the 59K-character template — and the test that keeps them byte-identical with `references/protocol.md`.

**Build:**
- The template keeps the repo facts: validation commands, version rule, environment, conventions, prohibitions, roles and named gate agents, smoke facts. One line replaces the procedure: the skill's `protocol.md` governs.
- The conductor reads `protocol.md` at boot beside the contract. No protocol pinning: a ledger runs under the installed skill, and the conductor stops and asks when the ledger and the skill disagree.
- `tests/protocol-contract.test.cjs` loses its mirror and SHA-pin assertions; the recovery and capped-verdict tables live once, in `protocol.md`. `CLAUDE.md`'s mirror convention is rewritten to match.
- #13's stale-install check compares the installed copy against the skill repository, not against a hash in the contract.
- After #1 and #4 ship, the procedure prose in `protocol.md` shrinks to what `ledger.mjs` and `reconcile.mjs` cannot decide.

**Evidence:**
- `templates/00-READBEFORE.md` grew from 12,275 to 59,064 bytes between 09-12 and 09-21. 224 of its 615 substantive lines (21K characters) are verbatim from `protocol.md`; about 33K are orchestrator-only procedure. A filled contract is about 69K (the high-priority pack's is 68,999 bytes).
- Eight 09-17 "review fixes" commits each edited both copies, +284 / −180 lines in the template alone.
- The conductor reads only the contract at boot (`SKILL.md` step 2). The 09-23 run read it in two chunks, 76K characters, and touched `protocol.md` twice for greps of 0.2K and 1.4K. The 09-15 run read its 26K contract once and `protocol.md` never.
- Sub-agents never read it: prompts paste the conventions and prohibitions blocks, about 7K, and neither repo's agent definitions mention the contract.
- No run was found that continued under an older contract after the skill changed; the pinning benefit has not been exercised.

**Size:** S. Template and `protocol.md` edits, test deletions, a `CLAUDE.md` paragraph. 1 batch.

**Saves:** about 8K output tokens per scaffold (33K fewer characters to write) and nothing at run, since `protocol.md` plus a 20K contract reads the same as a 69K contract. Its value is one copy to maintain.

### 15. Conductor and agent budget rules

**Replaces:** conductor polling, and research and gate agents run at the conductor's effort and model by default.

**Build:**
- **No polling.** The conductor never calls `ReadNotifications`. If the only remaining work waits on a sub-agent, it ends the turn; the task notification resumes it.
- **Effort and model per role**, set in the agent definitions and the `Agent` call: read-only fact finding (Explore, fence-checker) at medium on the conductor's model or at high on a cheaper model, never low; the pre-flight at high, not max; reviewer and test hunter at the implementer's tier as the contract already says. Lower effort trades diligence, not knowledge: the failure mode is a citation not re-opened or an inventory stopped early, and max does not prevent that either (the operator-ux drafts carried a wrong picker description and a "31 boxes" count that was about 43, both gathered at max). Three conditions make the trade safe: enumeration runs as scripts (#9 `census`), every reported fact is a `path:line` plus symbol that `cites` verifies before the plan uses it, and the pre-flight stays at high as the independent check. Adopt only after a control on the next scaffold: the same research question to both settings, findings compared. One wrong fact that reaches a batch costs a fix round, about 500K sub-agent tokens, which is the size of the saving. **Not adopted:** that control, run at the `OS-20260925` scaffold (its LOG, §Control run (#15)), found max ahead of medium on material facts, so the clause was dropped; since `14fc878` (2026-09-28) the reviewer pins `effort: max` in its definition, and the test hunter pinned it until 2026-10-25, when it moved to `effort: medium`.
- **Explore thoroughness** defaults to medium. "Very thorough" only when the interview needs an inventory, and the prompt names what the inventory is for.
- **Scaffold at high effort.** The 09-23 scaffold ran 160 of its 200 calls at max, with thinking 54% of all output; the interview reached the user in five minutes at high.
- **Compaction at boundaries, never mid-flight.** At wave close, after the PROGRESS and LOG commit with no agent in flight, a conductor past about 300K context compacts or ends the session; the next boot reconciles from git. After any compaction the boot sequence and the reconcile run before any transition, because a summary is a claim, not truth. A merge, push or third-round authorization that exists only in a summary is re-asked. Auto-compaction stays as the safety valve it is: the 09-15 six-item run compacted once, at 963K down to 61K, after it had already paid about 150M cache reads at an average 500K context; the 9.4K summary kept the user's verbatim words and the conductor's first seven calls re-read git and the ledger, which is the behaviour the rule makes mandatory. **Superseded 2026-09-28 (`14fc878`):** `protocol.md` §Session algorithm step 8 now opens a compaction window at three safe points, where a conductor past about 300K posts one line and starts a 10-minute background timer; the first of the timer and the user's answer resumes it, and the reboot duty above is unchanged.
- Practices, recorded here rather than tooled: unrelated investigations (the 09-23 CI failure, 40 calls and 8.9M cache-read inside the scaffold) go in their own session; a pause over an hour expires the prompt cache, and the first call after the 74-minute pause re-wrote 352K tokens of cache.

**Evidence:**
- 24 `ReadNotifications` calls in the 09-23 scaffold, every one "No queued notifications", 7.3M cache-read tokens. Zero in the three pre-rewrite scaffolds and zero in the run session.
- Sub-agents in the 09-23 scaffold: fence-checker 155 tool uses, 13 minutes, 314K tokens; pre-flight 178 tool uses, 22 minutes, 379K; the second Explore trio 10–13 minutes each. The pre-flight's 14 findings were 10 behaviour judgements and 4 grep results.
- The 09-12 scaffold's five agents used 606K tokens for a comparable scope; the 09-23 scaffold's seven used 1.51M.
- The run conductor at high effort made 6 hand edits and polled nothing; the scaffold conductor at max made 138 edits and polled 24 times.

**Size:** S. Prompt and definition text plus tests that pin the rule sentences. 1 batch.

**Saves:** per scaffold, about 24 calls and 7M cache-read tokens from polling, and up to a third to a half of sub-agent tokens from effort and thoroughness once the control confirms the error rate holds (for effort it did not; see above); wall clock on the pre-flight wait. Not measured on the run phase.

## Phase 6 — added 2026-09-26 from the census effort controls

Measured on the plan-shaping census (`~/effort-control/`): one read-only Opus 5.5 max agent per run, same prompt at edd2f1e, scored against a 52-finding key. Three runs per arm, four for plain max.

### 16. Tool-call batching line in the agent definitions

**Replaces:** sub-agents issuing one tool call per turn. Every turn re-sends the whole context, so turns, not tool calls, drive cost. Plain max averaged 1.09–1.15 calls per turn.

**Build:**
- One line in the body of reviewer, test-hunter and qa-runner, and nowhere else (the implementer was dropped; see Evidence): "Preplan your tool calls, and group in batches where it makes sense, wait for them to all return before reading any."
- Not in the global CLAUDE.md, and not the strict form ("Every assistant turn re-sends the whole conversation … the number of turns, not the number of tool calls"). Both were measured and lost; see Evidence.
- Lands after #15, which is in flight and edits the same four files. Mind the 4 KiB definition cap in `agent-definitions.test.cjs`.

**Evidence:**

| arm | calls/turn | $/run mean (range) | recall /52 mean (range) |
|---|---|---|---|
| plain max | 1.09–1.15 | 7.43 (6.03–8.20) | 44.4 (43.5–45) |
| **line in definition body** | 1.36–1.73 | **5.58 (5.41–5.90)** | **44.2 (43.5–45)** |
| line in global CLAUDE.md | 1.24–1.43 | 6.62 (5.97–7.60) | 43.3 (42–45) |
| strict rule, global CLAUDE.md | 1.10–2.00 (bimodal: one run ignored it) | 5.05 (3.41–7.37) | 43.0 (41–44) |
| strict rule, definition body | 2.47–4.80 | 4.65 (3.20–5.93) | 42.5 (39.5–45.5) |

- The strict rule batches reliably from the definition body, but recall spreads and drops. Its worst run, 39.5, is xhigh-level recall. One blocking finding (B13) was caught in 0 of 6 strict runs, against 9 of 10 other max runs. The three runs with 69% or more multi-call turns scored 39.5–42.5; the three at 40% or less scored 44–45.5.
- Bigger turns also think longer. Sub-agents write only the 5-minute cache, and its TTL runs from a request's send. A turn that thinks for more than 5 minutes makes the next call rewrite the whole context, about $2 at 450K. Across all 23 census runs, all 3 requests sent more than 5 minutes after the previous one missed the cache, and no other request missed. Two of those three were strict-definition runs.
- Measured on a read-only task only. That transfers most directly to reviewer and test-hunter. It is untested on implementer and qa-runner, whose edit, run and read loops are more sequential; "where it makes sense" should keep it harmless there. Measure on the first run after it lands.
- Implementer, 2026-09-26: replays of one ledger batch cost ~$6.82 with the line and ~$6.45 with it plus a reworded read-before-edit rule, against ~$6.00 without, with 8 and 2 edits refused against 1 (single runs). Grouped edits on files only seen through `sed` fail together, so the line was removed from `implementer.md` and the test pins its absence.

**Size:** S. Three definition lines, plus a test that pins the sentence in each and its absence from the implementer. 1 batch, or ride along with the next batch that edits `.claude/agents/`.

**Saves:** about a fifth (19%) of each research or gate sub-agent's cost on the census, with recall unchanged; the table's $ omit most sub-agent output tokens, which is why it reads as a quarter. Not yet measured on a ledger run.

## Phase 7 — added 2026-10-23 from the docs-only backlog audit

Measured on the two product backlogs as last committed (shipping-app `BACKLOG.md` at `3d0ffbc8`, amazon-sheets-logger `Backlog.md` at `0edd69e`), each item classified from its entry's text, not re-checked against the code.

### 17. Unlimited prose-only fold-ins

**Priority:** high (the user, 2026-10-23).

**Replaces:** two limits that send docs and comment fixes to the backlog instead of fixing them. At scaffold, a fold-in counts against the cap of two per batch and is barred from L-weight batches, whatever it touches. During a run, a prose finding outside the batch's fence or own work cannot be an ASK, so it is registered, even when the reviewer has already written and verified its wording.

**Build:**
- **Prose-only, defined mechanically.** A fix is prose-only when every path it changes is Markdown, or JavaScript that `prose-only-diff.mjs` reads as `PROSE-ONLY`. Comments in other languages (CSS, HTML) keep the path rule and do not qualify. Two kinds of prose keep the ordinary rules: files agents read as instructions (`CLAUDE.md`, `.claude/**`, a skill's own Markdown), because they steer agents, and prose that is a contract (USER-GUIDE claims, ARCHITECTURE rows, exported API comments, channel payload docs), which also keeps its P0/P1 rule.
- **At scaffold:** a prose-only backlog item folds in with no per-batch cap and onto a batch of any weight. The fence-subset rule stays, so waves stay disjoint. It adds no file, hook or behaviour, so it needs no census re-run. It keeps its own checklist item and commit, needs no smoke step of its own, and the user still picks it at plan approval. Eligibility comes from the entry; the proof comes after: a fold-in commit that does not classify as prose-only is reverted and the item returns to the backlog.
- **Run-end prose sweep.** Plan approval also gives a standing OK for it. A prose-only finding that carries verified replacement text but sits outside the batch's fence or own work is recorded for the sweep, not the backlog. After the last wave and before the final checkpoint, one mini-batch on its own branch applies them, the conductor applying each text itself as it does for a prose ASK; then the `PROSE-ONLY` check, one reviewer, the merge and tip validation. It runs alone, so the mid-wave fence test passes trivially. A finding without verified wording still goes to the backlog.
- **The classifier's limit, which this feature must route around.** `prose-only-diff.mjs` fails closed: a comment that fails `proseShaped` is kept as code, so any edit to it reads `CODE`. That covers a `file:289` cite or any `word:word` or `word=word` join, a first word that is a path or carries a hyphen or an unclosed bracket, and a label opening such as `Family gate:`. In a file holding one such comment, this repository's BL-068 also makes every edited comment block keep its line count. For a polish that costs one scoped re-review; here it would disqualify a real prose fix. So the tool names a `CODE` verdict's cause (BL-068's minimum), and an item whose only cause is a kept comment stays in, its kept lines read by the batch's reviewer under the path rule; a changed code token still sends it back to the backlog. This repository's BL-046, the opposite gap, matters more once the classifier decides eligibility.

**Evidence:**
- 34 of 303 shipping-app items (11.2%) and 12 of 109 open Sheets-logger items (11.0%) are docs- or comment-only: 43 (14.2%) and 13 (11.9%) counting wording-only fixes in test names, assertion messages and log lines, and the Sheets logger's mostly-docs BL-161.
- The shipping app's backlog held 171 items after its 2026-09-17 audit and 303 on 2026-10-23.
- Most came from ledger runs that saw them outside the batch's fence or own work. In `SA-20261020-po-panel-pack`, B02's C1 fix-up R4 reviewer wrote and verified new wording for `scripts/renderer-inbound.test.js`'s NOT-COVERED trailer, outside that fix-up's fence, and B08 registered it. In `ASL-20261020-six-high-items`, B07 fixed one README "new tab" line and left the rest as outside its items (Sheets-logger BL-134). Four of the Sheets logger's 12 came from outside any ledger: old trackers, a verification pass, research.
- The 2026-10-23 non-ledger sweep of those 12 (amazon-sheets-logger branch `claude/prose-backlog-sweep-0d6738`, tip `9be4ca6`) fixed 8, the whole branch `PROSE-ONLY` and its suite green. The classifier's limit left Sheets-logger BL-079 and BL-115 partly done and BL-100 skipped: its stale line opens `(Hibbett`, which `proseShaped` keeps as code.
- A dedicated ledger for them pays for a whole scaffold first: $44 (`OS-20260927`) and $119 (`SA-20260926`) on the two scaffolds measured whole.

**Size:** S–M. `scaffolding.md` step 4's fold-in rule, which `tests/census-step.test.cjs` quotes, so the edit re-pins it on purpose; a `protocol.md` paragraph for the sweep beside §Fence changes (check whether §Recovery needs a row for its branch, since those tables are SHA-pinned); a cause on `prose-only-diff.mjs`'s `CODE` line, with a test per cause; and the standing OK in the plan template's `## Backlog fold-ins` section. No tool enforces the cap today. 1–2 batches.

**Saves:** not measured. The backlog's docs and comment share stops growing, and stale comments stop misdirecting the agents that read them.

## Phase 8 — added 2026-10-24 from the findings-document review

Measured on the two product backlogs at their `main` tips (shipping-app `BACKLOG.md` at `fea9a502`, and at `d2613288` before that evening's prose sweep; amazon-sheets-logger `Backlog.md` at `a2fc1ea`) and on every archived ledger in the three repositories, each item read from its entry's text and its `Kind:` and `Files:` lines, not re-checked against the code.

### 18. The backlog as a to-do list

**Priority:** high (the user, 2026-10-24).

**Replaces:** a backlog that is both a record of what was noticed and a list of what is owed, with no bar between the two. Every route into it registers whatever reaches it: the unclosed ASKs of a discarded polish (`protocol.md` §Severity and round accounting), a capped pre-smoke repair's residual (§Session algorithm step 2), the residual a `⛔` batch ships with, and every finding a reviewer or test hunter raises outside its batch's fence. Shipping-app's registers batch takes them as a catch-all ("The residuals the waves route here", `SA-20261015-multi-user-phase-c` B15), and its scaffold greps them by path and folds some kinds in unasked, so each entry acts as a promise.

**Build:**
- **A bar for registering** (the user, 2026-10-24: "a high bar for registering, and anything below it stays in the ledger's LOG only"). An entry states `Failure:` (who sees what, under which condition) and `Done when:` (a checkable condition), beside the `Files:`, `Tests:` and `Kind:` lines of shipping-app's grep contract, in a form the backlog template shows. A coverage entry names the behaviour a surviving mutant would let through to a user or a calling module; "Some Server-page cells would survive a mutant" does not pass until it does. Below the bar, a finding stays in LOG.md, which already holds every findings file verbatim.
- **What skips the bar:** works-but verdicts (the user's own ask), request items the close-out audit finds unimplemented, and P0/P1 defects with a concrete scenario. The bar is for everything else, and it never lowers a severity.
- **One close-out ruling step.** Every residual of the run reaches one list. The conductor proposes a disposition for each: register (with the fields filled), rule (accepted or declined, with a reason), or LOG only. The user rules once on the list, the proposals as defaults. Only the user's word registers or rules an item.
- **A rulings file, and no record of known edges** (the user, 2026-10-24: "a file of accepted and declined items, and no general known-edges file"). It holds the user's rulings with their reasons, in the same `Files:` form. A ruling reopens only on new evidence of exposure (a user hit it, a calling module changed, a smoke step failed), never on a new instance of the same gap, as the Sheets logger's Re-judge marks work now. The close-out checks new residuals against it by path; gate prompts never read it, so the gates stay independent.
- **Packs by production file** (the user, 2026-10-24: a threshold of 5, "just when it gets proposed"). To-do items are counted per production file they would edit (#8's partition), and items naming only tests per suite. A file at or over the contract's threshold is proposed, never run unasked: at scaffold, when the plan touches it, as an extra batch in a later wave than the plan's batch on that file; at close-out, when it gained an item in this run and no plan has taken it. The threshold is a contract repo fact, 5 to start, set again after the migration.
- **Expiry.** An item with no fold-in or ruling for 30 days is re-checked against the code and returns to the next close-out's ruling list: keep, rule or archive. It is how a lone item in a quiet file comes back.
- **Migration, once per repository.** Items that pass gain the two fields. Items below the bar move to a dated archive file, as the 2026-09-17 audit did with shipping-app's `.agents/archive/backlog-fixed-2026-09-17.md`. Open decisions (shipping-app's `decision` items, the Sheets logger's Re-judge entries) go to one ruling session with the user. Existing rulings move to the rulings file: the Sheets logger's ACCEPTED entries and its Design notes, and this repository's Accepted rows and "Noted, no action" section. Shipping-app's FEATURE-IDEAS.md keeps its declined ideas, which are about proposals, not issues.
- **Prerequisite: this repository's BL-064.** The implementer reports its prose only as its final message (`protocol.md` §Roles), and `DONE_WITH_CONCERNS` appears nowhere else, so a concern below the bar would reach no LOG.md. Reporting to a file that is appended to LOG.md, as reviewers do, closes that.

**Evidence:**
- Shipping-app's backlog held 171 items after its 2026-09-17 audit and 308 at `d2613288`. From 2026-10-03 to there every kind grew (235 → 308): behaviour +32/−5, hygiene +31/−13, coverage +28/−10, decision +8/−3, docs +7/−5, tooling +6/−3. The evening's non-ledger prose sweep then closed 37, 36 of them hygiene or docs.
- Inflow is registration, not polish: recent shipping-app ledgers left 7–31 still-open residuals each and folded 1–7 (`SA-20261015`: 31 and 7). Of 81 archived ledgers across the three repositories, 4 discarded a polish (this repository 1; shipping-app 3, all in `SA-20260922`; the Sheets logger none).
- Age at `fea9a502`: 127 of 274 items (46%) come from ledgers over 30 days old, 70 (26%) from over 60; decisions are the oldest, 23 of 37 past 30 days. The 2026-09-17 audit found 88 of 293 items already fixed, dead or duplicated.
- The same tests collect asks: 23 files carry coverage items from two or more ledgers, and five suites (renderer-inbound, ipc-data, ipc-cross-group, renderer-settings, scan) carry them from four.
- Area by folder is too coarse (`scripts/` 80–92 items, `src/main` 74, `renderer/ui` 44), and items linked by a shared file chain into one cluster of 73. By production file, 16 files hold 5 or more of the 237 non-decision items and 3 hold 10 or more (`scan.js` 21, `box-accordion.js` 19, `settings-view.js` 14), mostly behaviour; 89 name only tests or `scripts/` tooling; 64 of the 92 files named hold fewer than 3.
- The Sheets logger already rules: 13 ACCEPTED entries carry the user's decision (BL-086: "not to be fixed or re-reviewed unless something new comes to light"), and Re-judge marks the ones later evidence bears on. None of its 163 entries names its files in a field.
- A fix pack pays for a scaffold first ($44 on `OS-20260927`, $119 on `SA-20260926`); a batch averages about $44 (`OS-20260927`) to $74 (`SA-20261013`); a census re-run cost $0.61–4.04 in the 2026-10-20 census audit, the nearest yardstick for an expiry re-check.

**Size:** M. The close-out ruling step and the narrowed routes in `protocol.md` (§Severity and round accounting's discard line, step 2's capped pre-smoke row; check whether §Recovery needs a row for the ruling commit, since those tables are SHA-pinned); the pack proposal in `scaffolding.md` step 4, which `tests/census-step.test.cjs` quotes; the entry form and the rulings file in the templates, with the threshold in the contract; and a counting tool (files at the threshold, expired items) over the entry form, reusing #8's partition. 2–3 batches here, plus one migration per product repository, outside the skill.

**Saves:** not measured. The backlog grows only by the user's ruling; scaffold greps meet only owed work; settled items stop coming back.

## Build cost and payback

The core, features 1–11, is about 3,000 tool lines and 5,300 test lines, or 17–20 batches. The existing tools total 1,107 lines.

Using these runs' average per-batch cost (about 38M input-side and 310K output tokens per batch), that is roughly 0.65–0.8B input-side and 5–6M output tokens to build. At the central savings rate of about 95M input-side and 560K output per run, it pays back after roughly 7–11 runs of this size. It pays back sooner if phase 1 ships first, since later batches then run on the cheaper tooling. This is rough: it assumes tool-building batches cost what these runs' batches did.

The sizes are least certain in two places. #1 fits ten subcommands, including `open-wave` and `integrate`, into about 400 lines, while the read-only fence check, reusing the same git helpers, is 217. #9's `detect.mjs` must recognise conventions that differ by ecosystem, with no natural limit. Worktree removal and `cleanup` also need retries for Windows file locks (the 92 `Permission denied` lines in #1's evidence). Concurrent writes are not a cost: PROGRESS and LOG have one writer.

## Keep as agent work

- Planning (batching, specs, acceptance criteria, weights), the interview, and implementing.
- Semantic review: mapping hunks to checklist items, and judging acceptance criteria.
- Judging whether a cited line supports the claim made about it.
- Adjudicating when the reviewer and test-hunter disagree.
- Choosing mutations and probes ("what mutation stays green?").
- Fence VIOLATION overrides, each with your recorded reason.
- Triaging your failure reports to batches. Checkpoint verdicts stay yours.
- Distilling guardrails.
- Smoke steps that need a GUI or a look-and-see judgement.
- Choosing census symbols beyond path references.
- Writing the replacement wording for a false comment (the reviewer, who verified the fact).

## Method and caveats

**How the savings were estimated.** Every API call in the three runs was replayed. For each activity category:
- A share of the calls was removed, and the visible output, reasoning and tool results of the remaining calls were shrunk.
- Anything removed also leaves every later call's context.
- The shares are judgement calls, scaled 0.6× for the cautious figure and 1.3× for the generous one.

**What the numbers do and don't include.**
- Per-feature figures are standalone, so they sum to more than the combined total.
- Fence-retry savings are excluded, because the defects behind them are already fixed.
- Input-side tokens are mostly cache reads, which cost far less per token than output.

**Differences on other projects.** These are measurements on this repo.
- Feature 6's saving shrinks, because part of that volume came from testing this repo's own docs.
- Features 5 and 7 grow in value with suite size and setup cost.
- The orchestrator-side features (1, 3, 4, 9, 10, 11) carry over largely unchanged.

## Corrections applied in this merge

| Source | Claim | Correction |
|---|---|---|
| determinism audit | 1.5M output tokens, 71% from the orchestrator | 4.34M; the orchestrator produced 25% |
| determinism audit | Almost none of the overhead is repo-specific | True of orchestrator overhead; part of the sub-agent mutation volume is repo-specific |
| determinism audit | `ship` includes push | Push is a separate command (rule 5) |
| determinism audit | Copy tools into each ledger | Pin by hash (rule 4) |
| determinism audit | Build `next` early | Optional, last (#13) |
| determinism audit | Polish classifier uses contract path patterns | No such patterns exist; added the partition (#8) |
| automation audit | Fence fallback hardening as the fix | Fallbacks came from fixed defects; the gap is enforcement (#2) |
| automation audit | Mutation harness ranked mid | Largest output saver (#6) |
| automation audit | `git-evidence diff` subcommand | Dropped; the useful forms are #8 and hunk numbering |
| automation audit | Half the volume does not travel | True only of LOG narrative |
| token-sink audit | Validation output consumed raw; largest repeated cost | Agents trimmed output; kept for correctness and time (#5) |
| token-sink audit | Prompt tool prints for the orchestrator to paste | A file plus a pointer (#3) |
| token-sink audit | Count lint | Dropped; `expect` fields fix the cause (#10) |
| token-sink audit | 7 skeletons; 32/57/23 ledger commits; 56 bookkeeping commits | 8 skeletons; 36/58/24 commits; the 56 include scaffold, archive, CLAUDE.md and BACKLOG commits |
| token-sink audit | Ranking by tokens saved | Replaced with measured estimates |
| cross-review | 27 bookkeeping commits, each editing a table the fence tool parses | 25; 10 touch PROGRESS, 15 are LOG-only |
| cross-review | Discovery appears in two transcripts | Appears only as quoted text; never executed |
| cross-review | Return UNKNOWN on an unparseable Files line | Already done (`check-fence.mjs:116-122`) |
| cross-review | Validation output is a large sink | It is not |
| my review of token-sink | Largest Notes cell about 750 characters | 1,063 / 1,155 / 810; "a kilobyte" holds for two of three ledgers |
| draft | `audit` also removes fold-in ids | A checker that writes breaks rule 2; removal is the `fold` transition (#11) |
| draft | Implementers run the fence tool before committing | It reads only committed changes and flags a dirty worktree; they commit first (#2) |
| draft | The fence tool replaces hand EOL checks | It checks no EOL; those stay (#2) |
| draft | `integrate` trusts a recorded fence PASS | The result also depends on the integration tip; `integrate` reruns the check and requires `SHIP` (#1, #2) |
| draft | `cites` checks the symbol the text claims | Only a symbol the citation names, in a pinned form (#9) |
| draft | Census matches fenced paths | Also import specifiers and basenames (#9) |
| Astra review | `proof-page` should accept backslashes | No: shipped policy (BL-017, `smoke-page.md:161`) |
| Astra review | Sizes omit concurrent updates and recovery | PROGRESS and LOG have one writer; recovery is §Recovery, via #4. The real sizing risks are under Build cost |
| Astra review | Build full reconcile late | It ships before `integrate` (#4) |
