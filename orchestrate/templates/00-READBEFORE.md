# READ BEFORE ANY BATCH — orchestration & recovery

**Change**: {{CHANGE_ID}}
**Skill**: `{{SKILL_DIR}}` · sha256 `{{SKILL_SHA256}}`
**Skill source**: {{SKILL_SOURCE}}
**You are** either the ORCHESTRATOR (the main session the user told to "continue") or an
IMPLEMENTER/REVIEWER/GATE sub-agent given one batch. Neither of you has the planning
session's context. This file is the contract: it holds this change's repo facts. Its
procedure is the pinned skill directory's `references/protocol.md` ("protocol.md" below),
frozen by the hash above: protocol.md governs wherever this contract is silent, and this
contract's facts outrank it. Everything needed to drive this change lives in this ledger
directory ({{LEDGER_DIR}}) and that pinned directory — assume no other context survives
between sessions.

## Boot sequence (orchestrator, every session)

1. Read [00-request.md](00-request.md) (the user's verbatim ask + decisions),
   [01-plan.md](01-plan.md) (locked scope, batch table, wave map + checkpoints), and
   [PROGRESS.md](PROGRESS.md), plus the project's always-loaded docs — especially
   {{GUARDRAILS_REF}}; every batch diff is checked against it. [LOG.md](LOG.md) is the
   narrative record: read it ON DEMAND by anchor (a Notes cell points at it), never at boot.
2. Run `git status --porcelain`, `git branch --list`, `git worktree list`; note the current
   branch. **Never switch the main checkout.** Read ledger files from any branch with
   `git show <branch>:./<path>` (the `./` is required — Git Bash on Windows mangles
   `branch:path` otherwise) and write to the ledger through an integration worktree
   (`git worktree add <scratchpad>/wt-int {{INTEGRATION_BRANCH}}`), using the main checkout
   only if it already has `{{INTEGRATION_BRANCH}}` checked out. Run `git show` from the
   repo or worktree ROOT (the `./` path is cwd-relative). Reuse an integration worktree
   that `git worktree list` already shows; if its directory is gone, `git worktree prune`
   first — never two worktrees on one branch. Run {{WORKTREE_SETUP}} in a newly created
   integration worktree before validating in it.
3. **Skill pin**, before anything is reconciled: from the integration worktree root run
   `node "{{SKILL_DIR}}/tools/check-ledger.mjs" skill --contract {{LEDGER_DIR}}/00-READBEFORE.md`.
   `SKILL MATCH` → continue. Anything but `SKILL MATCH` (including `SKILL MISMATCH`,
   `UNKNOWN` and a tool that does not run) → STOP and ask; continue only on the user's explicit words, recorded verbatim in the session log, which pick one of two ways on — an
   upgrade (the `**Skill**` line above rewritten to the new directory and hash in the
   commit that records those words, the change continuing under the new directory's
   protocol.md) or a restore (the pinned directory rebuilt byte-for-byte from the
   `**Skill source**` line above, then this pin check re-run, continuing only on
   `SKILL MATCH`). The recipe under §Validation commands stays in this contract, so
   validation never depends on the pinned directory.
4. **Procedure**: protocol.md, hashed with the rest of the pinned directory, now governs
   what this contract leaves unstated — role duties, severity and round accounting,
   §Fence changes, §Recovery, §Session algorithm and both close-outs. Load it beside this
   contract.
5. **Reconcile** (protocol.md §Recovery) before believing any PROGRESS row.
6. **Resume-time validation**: run the validation wrapper (§Validation commands) on the integration
   tip. Red → the first job is a repair mini-batch (protocol.md §Session algorithm step 2), whatever
   PROGRESS says — unless Notes record a capped tip repair awaiting the user's verdict,
   in which case ask, never re-spawn. Green → follow protocol.md §Session algorithm.

Implementer sub-agents: **your spawn prompt is authoritative.** It is self-contained —
it carries your batch's full text plus every contract excerpt that binds you (file fence,
conventions, guardrails, prohibitions, validation commands), so do NOT read this contract
at boot. Consult it only if the prompt is incomplete, contradicts itself, or is missing a
fact the work needs, and then read only the section you need. Work ONLY in the worktree
your prompt names. Your batch file carries the full spec text and codebase facts — it is
authoritative for scope. Do NOT re-derive scope from the original request or any external
document.

## Roles, gates, tiers

- **Orchestrator** — owns PROGRESS, LOG, `evidence/`, branches, worktrees, merges,
  close-outs, all user communication. The ONLY role that edits version files, the
  changelog, PROGRESS or LOG.
- **Implementer** — one per batch, in its own worktree on its own branch. Reports in the
  fixed shape: first line `DONE | DONE_WITH_CONCERNS | NEEDS_FENCE | BLOCKED`, second
  line `NONCE <nonce>` (the nonce its rendered prompt ends with), then an
  evidence block (each validation run's `validate.mjs` line and exit code; commit SHAs;
  checklist n/m), then ≤40 lines of prose. `NEEDS_FENCE` and `BLOCKED` use the mismatch
  form: Expected / Found / Why it matters / How to proceed.
- **Reviewer** — ONE fresh read-only sub-agent per batch per round, never the implementer,
  never reused. Its line-1 verdicts (`SHIP` · `FIX FIRST` · `NEEDS A CLOSER LOOK`), its
  `NONCE <nonce>` line 2 and the finding classes (P0 · P1 · ASK) are protocol.md's
  §Roles, gates, tiers and §Severity and round accounting. The full report goes to the ONE findings file its prompt
  names, first line its LOG heading (`### B<NN> R<k> reviewer findings`); the final
  message is four lines: verdict, nonce, `P0=<n> P1=<n> ASK=<n>`, the file's path.
  Report capped like the implementer's.
- **Gate agents** (read-only, run by the ORCHESTRATOR at the reviewer gate, in parallel
  with the reviewer): {{GATE_AGENTS}}. Each writes its full report with the Write tool to
  the findings file its prompt names — its only other writes are validation logs and
  disposable scratch under the session scratchpad, never inside a worktree or the
  repository — and returns four lines: its verdict, `NONCE <nonce>`,
  `FINDINGS <n>`, the file's path. Implementers NEVER spawn a gate agent themselves —
  a self-spawned one stalls the implementer uncommitted.
- **QA runner** — one sub-agent that executes the agent-runnable smoke steps at a
  checkpoint close-out and writes evidence. Runners available in this repo:
  {{AGENT_RUNNERS}}.
- **Tiers**: {{ROLE_TIERS}}. The reviewer never runs on a less capable model than the
  implementer; L-weight reviews and the fresh implementer of an authorized third round
  use the most capable model the session can spawn (the "strong tier"); if tiers are
  unavailable, use the default and keep the gate
  shape. Record the tier used in the row's Notes.

Every sub-agent report entering the orchestrator's context is capped (~40 lines + a
findings list); the fence check and tip validation return one line each on success.

**Metrics** (the pilot's measurement, readable from the ledger alone). Every batch row's
Notes end with `m: rounds=<FIX FIRST rounds> asks=<ASK items closed by a polish pass>
fence-bounces=<times the fence check sent the implementer back> gate=<gate-agent
findings>/<of which needed a production change> tip-red=<1 if tip validation went red
after this merge>`. Every checkpoint row's Verdict cell ends with `m: pre-smoke=<agent
steps passed>/<human steps> human-smoke-min=<minutes the user reports> escaped=<defects
the user found that no gate caught>`, completed when the user's final verdict on that
checkpoint is recorded (`escaped` counts every fail across re-runs).

## Git model (locked)

- Default branch (protected local ref): `{{MAIN_BRANCH}}`. Integration branch: `{{INTEGRATION_BRANCH}}` —
  every reviewed batch merges into it, and it is the ONLY branch that ever merges
  toward `{{MAIN_BRANCH}}`.
- Shipment source: `{{SHIPMENT_SOURCE}}`. Shipment ref: `{{SHIPMENT_REF}}` — the
  confirmed default branch on that source. `local` means a local merge counts;
  `remote <name>` means a merge on that remote counts. These are locked facts,
  distinct from permission to merge/push. Remote-tracking refs are cached evidence,
  never a substitute for the recorded source. Resolve shipment as described in
  protocol.md §Recovery; do not re-detect these facts from the current checkout.
- One branch per batch, named in the batch file (branch prefixes in this repo:
  {{BRANCH_PREFIXES}}), cut from the integration tip when the batch's wave opens.
  Wave members run CONCURRENTLY: one implementer per batch, each in an isolated git
  worktree under the session scratchpad (never inside the repo). Per-worktree setup:
  {{WORKTREE_SETUP}}. Same-wave fences were planned disjoint.
- **Merge/push policy**: {{MERGE_POLICY}}
- **Execution model: {{EXECUTION_MODEL}}** — {{EXECUTION_MODEL_RATIONALE}}

## Validation commands

{{VALIDATION_COMMANDS}}

All must pass before a batch may integrate (`🟢`). Every run goes through the validation
wrapper, from the worktree root:

```text
node "{{SKILL_DIR}}/tools/validate.mjs" --spec {{LEDGER_DIR}}/validate.json --log "<session scratchpad>/<label>.log"
```

`validate.json` is the machine form of the block above, written at scaffold time. The
wrapper's one line (`PASS …`, `FAIL … — log: <path>` or `UNKNOWN …`) is the result and its
exit code (0/1/2) is the real one; the log is read only when the line is not PASS, and
failing test NAMES are taken from it so failing sets compare by name against any
allowlist. Never pipe or tail it; when it may outlast the runtime's command timeout, run it
as a background task whose completion reports the one line and the exit code, and never
read the log before it exits. The block above stays the human-readable
recipe and is the manual procedure when the wrapper is unavailable, run in its QUIET form
(a totals line plus failing test NAMES; full output only on a non-zero exit). If the
block above says `none`, there is no `validate.json` and the checkpoint smoke tests
carry ALL verification — state that explicitly when handing
over. Mutation runner (optional, a sweep scoped to a batch's changed files): {{MUTATION_RUNNER}}.
The skill's `mutate.mjs` is a different tool: the test hunter proves with it only the
mutations it chooses itself, each on a disposable clone of the batch's commit.

## Version + changelog rule (orchestrator-only)

- Version files (bump in lockstep): {{VERSION_FILES}}
- Bump cadence: {{VERSION_BUMP_RULE}} — applied on the integration branch at
  integration or checkpoint close-out, never inside a wave worktree.
- **Whatever the cadence, the version MUST differ from the base branch's by the time
  a checkpoint script is handed over.** A version shared with the base makes the
  script's step 0 unable to tell the two apart, and a whole smoke run can execute
  against the wrong tree and report the un-fixed defects as failures. If the cadence
  above would leave them equal at a checkpoint, bump anyway and note it in PROGRESS. A
  checkpoint marker costs the PATCH component; the release takes ONE minor.
- Changelog: {{CHANGELOG_RULE}}

Implementer sub-agents NEVER touch version files, the changelog, PROGRESS or LOG. If all
three lines say `none`, skip version/changelog work at close-out and say so.

## Repo conventions (binding)

{{REPO_CONVENTIONS}}

## Hard prohibitions

- No scope creep: modify ONLY the files in your batch file's fence. Anything else you
  notice goes in a PROGRESS Notes entry (orchestrator) or your final report (sub-agent) —
  never in the diff. Need a file outside the fence? Report `NEEDS_FENCE` (protocol.md §Fence changes).
- Implementers never edit their batch file beyond checklist ticks, appended
  `- [ ] polish:` lines, and the Files line under a recorded extension; never spawn gate
  agents; never leave untracked files in the worktree (reconcile reads that as dirt —
  scratch goes under the session scratchpad).
- No `--no-verify`, no force-push, no history rewriting.
- Never commit to `{{MAIN_BRANCH}}`, never push, never merge toward `{{MAIN_BRANCH}}` —
  except as the merge/push policy above allows or the user explicitly authorizes in the
  current session. (Merging reviewed batch branches into `{{INTEGRATION_BRANCH}}` is
  the orchestrator's normal job.)
- {{EXTRA_PROHIBITIONS}}

## Smoke checkpoints

The user smoke-tests at the CHECKPOINTS in the checkpoint table (the plan's wave map,
as moved by any recorded deferral) — never per batch. How the user smoke-tests in this project:
{{SMOKE_PROCEDURE}}. A reached checkpoint is never skipped and never resolved without
the user's verdict. The script's assembly, pre-verification, delivery, re-issues and
verdict intake are protocol.md §Smoke checkpoints.

**Runners.** Every smoke step is tagged at planning time `Runner: agent` (executable in
THIS repo's environment by the runners listed under Roles) or `Runner: human` (hardware,
credentials, feel, another OS, or anything not listed). A step flagged "Touches your data"
is human unless the runner line names a disposable fixture environment. A step is human
ONLY when it needs something an agent on this machine cannot do: a device, a GUI, held
credentials, a judgement about whether something looks right, or something the environment
contract forbids an agent here to do — the data and another-OS grounds above are that last
kind, not exceptions to this rule. A fixture's isolation is not such a thing, and a
checkpoint asks the user for a verdict, not for labour.

Every script OPENS with a non-verdict gate: the command that prints the current
branch, an executable containment check, the version the user must see, and a canary
whose result is OPPOSITE on the
base build — run first, "if it behaves the old way, stop and say so".
The containment check is run, never eyeballed: committing the page moves `HEAD` past
the build the page describes, so `git rev-parse HEAD` can never equal `BUILD_SHA`.
Put these in the sidecar's `gate.commands`, with the tested SHA written out:

```text
git merge-base --is-ancestor <buildSha> HEAD
git diff --name-only <buildSha>..HEAD -- . ":(exclude).agents/"
```

The first must exit 0; the second must print NOTHING — the pathspec excludes the ledger
directory, so empty output is the verdict and no one reads a list to reach one.
`build-smoke-page.mjs` refuses a sidecar whose `gate.commands` omits either command or
the SHA the sidecar records, a sidecar carrying any Unicode control character (C0, `DEL`
or C1, the last for the NEL line terminator `U+0085`) other than tab or
newline, and a `Section N` or `Step N` reference to a section or step it does not
contain. Author embedded commands with no backslashes and no control characters.

## Change-complete facts

The change-complete close-out is protocol.md §Two distinct close-outs, run with these facts:

- **Convergence pass** — {{CONVERGENCE}}.
- Backlog: {{BACKLOG_FILE}} — works-but verdicts, residuals and dropped items become named
  entries there, and residuals added get ids in the {{BACKLOG_ID_PREFIX}} scheme.
- Guardrails: new bug classes are distilled into {{GUARDRAILS_REF}}.
- Release step (only on explicit user authorization): {{RELEASE_COMMAND}}
