# Orchestrate — a ledger skill for Claude Code

A [Claude Code](https://claude.com/claude-code) skill for running multi-batch code
changes off a **file-based ledger** that lives in the repo, survives crashes, and can be
driven by any future session from the ledger and the skill directory it pins.

The problem it solves: a change too big for one session. Context runs out, the session
dies, a new one picks up with no memory of what was done, and status notes in chat lie
about what actually shipped. Orchestrate writes the plan, the scope fence, and the
progress table into committed files, then treats **git as the source of truth** whenever
those files and reality disagree.

## How it works

Every change gets one directory, committed to the repo:

```
.agents/changes/<PREFIX>-YYYYMMDD-<slug>/
├── 00-request.md        the user's verbatim ask + decisions (incl. accepted backlog fold-ins) + item→batch map
├── 00-READBEFORE.md     the contract: repo facts — skill pin, boot, roles/gates/tiers, git model, validation, smoke — run by the pinned protocol.md
├── 01-plan.md           locked scope: batch table (weight, wave, fence), wave map + checkpoints, pre-flight verdict, per-batch specs
├── 02-batches-NN-*.md   one per batch: fence, applicable guardrails, spec, checklist, acceptance, tagged smoke steps
├── PROGRESS.md          one-line State, status + checkpoint tables, verdicts, coverage audit, one-line session log
├── LOG.md               append-only narrative (reviewer arcs, root causes, learnings) — read on demand, never at boot
├── evidence/CN/         what the QA runner already verified before each checkpoint
└── smoke-CN.html        the checkpoint smoke page as handed over
```

The work then runs in **waves**: file-disjoint batches implemented concurrently, one
implementer per batch, each on its own branch in an isolated git worktree, stacking
serially onto an **integration branch**. The gates, in the order a batch meets them:

1. **A locked plan, pre-flighted.** Scope is agreed up front and written down. Every
   request item maps to exactly one batch, or to an exclusion you signed off on. Each
   drafted batch first gets its own read-only census agent, given the batch's fence,
   whose report opens with where the draft is wrong or incomplete, then names the tests
   that read every file the batch changes, the tests each fix it proposes would break,
   and what the backlog and old ledgers already record about them; each opening item is
   logged as carried or rejected once any line the conductor wrote from it in other
   words, and any fix the conductor chose for a problem the report only flagged, have
   gone back to the same agent to be checked. Before
   you see the plan, an independent read-only sub-agent checks it: items covered both
   ways, same-wave fences really disjoint, fences *complete* (a grep census of every
   symbol a batch touches, tests and docs included), no contradictions, criteria that a
   diff, a test or a smoke step can settle. The plan also locks the **wave map** and the
   checkpoint placement; your approval is the standing authorization for the concurrency.
   Cheap backlog items whose files already sit inside a fence can be folded in at the
   same approval, under strict eligibility, and are removed from the backlog when they
   ship.
2. **A file fence, checked mechanically.** Each batch declares the only files it may
   touch. Before any reviewer is spent, `git diff --name-status` against the integration
   branch must stay inside the fence (both ends of a rename, clean worktree). An
   implementer that needs another file reports `NEEDS_FENCE` and the fence grows only if
   the wave stays disjoint — recorded, never improvised.
3. **An independent reviewer, plus optional gate agents.** One fresh read-only sub-agent
   per batch maps *every* diff hunk back to a batch item; an unmapped hunk is scope creep
   and rejects the round. P0/P1 findings block; small in-fence asks (test strength,
   prose, comments) ride under `SHIP` and close as a polish pass that costs no round. For
   `fix` batches a mechanical check first proves the new test fails on the un-fixed code.
   A repo can name gate agents (a test hunter asking "what mutation keeps this test
   green?") that run beside the reviewer. Two blocking rounds max, then the batch is
   blocked and you choose: fix again, ship with the residual on record, or drop.
4. **Validation on the tip.** Each reviewed batch merges after a merge-tree dry run, and
   the suite runs again on the integration branch — sibling interactions show up here,
   not at your smoke test. Every repair is itself a reviewed mini-batch; nothing lands on
   the integration branch unreviewed.
5. **Your smoke test — at checkpoints, not per batch.** Checkpoints sit after waves
   carrying hands-on risk (visible UI, auth flows, migrations), plus one mandatory final
   one. Steps an agent can perform in this repo's environment are run first by a QA
   sub-agent and shown as pre-verified with their evidence; your hands are spent on the
   steps only you can do. The run stops with one combined script — an interactive
   **smoke page** with a step-0 "prove you're on the right build" gate, per-step Pass /
   Fail / Blocked / Works-but verdicts, and a copy-results button whose paste is your
   verdict — and waits for that verdict, recorded verbatim.
6. **Convergence before close.** After the final checkpoint passes, and when the ledger's
   contract has it switched on, a read-only sub-agent classifies every plan item against
   the actual code (implemented / partial /
   contradicts / unrequested) before the change is declared complete, and new bug classes
   are distilled into one-line guardrails that point at the test enforcing them.

If a session crashes mid-wave, the next one reconciles the ledger against git — branch
exists? commits past the wave base? merged but not yet validated? close-out half
finished? — and resumes from the real state rather than the claimed one.

### Design notes

- **Ledgers are closed systems.** Every repo-specific fact (validation commands, version
  files, merge policy, smoke procedure, gate agents, runners, tiers) is baked into the
  ledger at scaffold time. A ledger references ONLY its pinned skill directory, by
  absolute path and hash; its procedure is that directory's `references/protocol.md`,
  frozen by the hash, and every step a tool performs also has its manual procedure there,
  so a session drives it from the ledger plus its pinned directory. A changed skill stops
  the ledger at its next boot and asks, and never silently changes how it runs.
- **Statuses are claims; git is truth.** The wave-open PROGRESS commit on the
  integration branch — not any status flip — is the crash marker recovery keys on. The
  orchestrator never switches your checkout: it reads branches with `git show` and
  writes through an integration worktree of its own.
- **Your time is the scarce resource.** Waves are engineered as wide as the fences
  allow, agents pre-verify what they can, and manual smoke tests happen only at planned
  checkpoints.
- **User gates are front-loaded.** Design and UX approvals get resolved at planning time,
  while you're present, instead of stalling an autonomous run halfway through.
- **Measured, not assumed.** Every batch row ends with a metrics token (rounds, asks,
  fence bounces, gate findings, red tips) so the cost of each gate is visible from the
  ledger alone. A repo's first ledger runs the cheap gates by default and offers the
  heavier ones (gate agents, agent pre-smoke, convergence) to be switched on once the
  numbers justify them.
- **Conservative by default.** No pushing, no `--no-verify`, no force-push, no history
  rewriting, never a commit on the default branch, and nothing merges toward the default
  branch — unless you say so, in words that get recorded in the ledger.
- **Rollout boundary.** A ledger's own contract outranks the skill through its repo
  facts. It references ONLY its pinned skill directory, by absolute path and hash; its
  procedure is that directory's `references/protocol.md`, frozen by the hash, and every
  step a tool performs also has its manual procedure there, so a session drives it from
  the ledger plus its pinned directory and a new skill version never rewrites a ledger
  already scaffolded: a changed skill stops the ledger at its next boot and asks, and
  never silently changes how it runs. Your recorded words then pick one of two ways on:
  upgrade — the pin rewritten to the new version, the ledger continuing under its
  `protocol.md` — or restore — the pinned directory rebuilt byte-for-byte from the
  contract's `**Skill source**` line and the pin re-checked. A new version reaches a repo
  through the next `/orchestrate new`, or through such an upgrade.

## Install

Clone the repo and point your Claude Code skills folder at it, so the checked-out repo
IS the deployed skill and there is nothing to keep in sync. If `~/.claude/skills/orchestrate`
already exists from a copy install, move it out of `skills/` first (keep it as a
rollback) — a link created inside it would nest a second `SKILL.md` and register a
duplicate skill:

macOS / Linux:

```bash
git clone https://github.com/hopefullyanonymous/wave-orchestrator.git && ln -s "$PWD/wave-orchestrator/orchestrate" ~/.claude/skills/orchestrate
```

Windows (PowerShell):

```powershell
git clone https://github.com/hopefullyanonymous/wave-orchestrator.git; New-Item -ItemType Junction -Path "$HOME\.claude\skills\orchestrate" -Target "$PWD\wave-orchestrator\orchestrate"
```

### Installing the skill does not install the agents

The link above puts `orchestrate/` in your skills folder, and a skill directory cannot
carry agent definitions — Claude Code reads those only from `~/.claude/agents/` (every
project) or `<project>/.claude/agents/` (one project). So the five tool-restricted
definitions this repo ships in `.claude/agents/` — `implementer`, `reviewer`,
`test-hunter`, `qa-runner`, `census` — do **not** arrive with the skill install. Copy them
yourself, or every spawn silently inherits the full tool catalog they exist to trim.

macOS / Linux:

```bash
mkdir -p ~/.claude/agents && cp wave-orchestrator/.claude/agents/*.md ~/.claude/agents/
```

Windows (PowerShell):

```powershell
New-Item -ItemType Directory -Force -Path "$HOME\.claude\agents" | Out-Null; Copy-Item "wave-orchestrator\.claude\agents\*.md" -Destination "$HOME\.claude\agents"
```

For one project only, copy them into that project's `.claude/agents/` instead. Either
way, restart Claude Code — definitions are read at startup. The skill still works
without them, but nothing falls back on its own: a spawn naming one of these
types fails outright (`Agent type 'implementer' not found`), so the orchestrator
substitutes the general-purpose agent itself on every spawn and the read-only
rules stay prose-enforced — see `orchestrate/references/protocol.md`
§Degraded environments. And with them, the guarantee is stronger but not
absolute — Write and Bash can still write, so "read-only" stays partly conventional;
withholding Edit closes the easy path, not every path. Copy them again whenever you update
the skill: the definitions change with it, and an older `reviewer` or `test-hunter` lacks
the `Write` tool its rendered prompt needs for the findings file.

Whatever branch the clone has checked out is what runs — stay on `main`. If you prefer
a plain copy, `cp -r wave-orchestrator/orchestrate ~/.claude/skills/` works, and
`diff -r ~/.claude/skills/orchestrate wave-orchestrator/orchestrate` tells you when it
has drifted. For one project only, use `<project>/.claude/skills/` instead. Restart
Claude Code and it will pick the skill up. Update an installed copy (a `git pull` in the
clone counts) only between ledgers: a ledger's contract pins the skill's hash, and an
updated copy stops that ledger's next session and asks.

## Usage

| Command | What it does |
|---|---|
| `/orchestrate new <description>` | Offer a fresh conversation first when this one already holds much earlier work; then interview, plan the batches, run a census of each batch, sweep the backlog, pre-flight the plan, scaffold the ledger, stop for your approval |
| `/orchestrate continue [<id>]` | Run to the next checkpoint: validate the tip, open the wave, implement its batches concurrently, gate + integrate each as it lands, repeat — then pre-verify what an agent can and stop with one combined smoke page. Naming a ledger's `<id>` picks that ledger when more than one is active |
| `/orchestrate status` | Read-only: reconcile every row against git (including ledgers that live only on a branch) and report what's actually true |
| `/orchestrate close` | Record your checkpoint verdict; on the final pass run convergence, distill, and finish the change |

You can also just talk to it — "where are we on the batch work", "batch 3 is broken, the
sidebar doesn't open", "continue" — and it routes to the right mode.

## Mods

`orchestrate-mod/` is an optional Claude Code mod beside the skill: a `/ledger` pane, a band line
above the prompt, and a per-request cost log of every session it loads in, one JSONL file per
session (a long session continues in `<session>.1.jsonl`, `<session>.2.jsonl`, …) under
`~/.claude/orchestrate-costs/`. No orchestrate step depends on it: step 8 of the skill's session
algorithm calls the mod's `schedule_clear` at every point where it may pause for context when a
session has it, and keeps its 10-minute timer for a context at or past the ledger's clear threshold
when the mod is absent or declines (§Clear and continue).

### Install

From the root of your clone, copy the plugin to `~/.claude/orchestrate-mod/`.

macOS / Linux:

```bash
git archive HEAD orchestrate-mod | tar -x -C ~/.claude
```

Windows (PowerShell), through a file rather than a byte pipe, which Windows PowerShell 5.1 and
pwsh before 7.4 corrupt:

```powershell
git archive -o $HOME/.claude/orchestrate-mod.tar HEAD orchestrate-mod
tar -x -f $HOME/.claude/orchestrate-mod.tar -C $HOME/.claude
Remove-Item $HOME/.claude/orchestrate-mod.tar
```

Then add two keys to the `env` object of `~/.claude/settings.json`, beside the keys already
there — never replace the object:

```json
{ "env": { "CLAUDE_CODE_PLUGIN_DIRS": "<home>/.claude/orchestrate-mod", "CLAUDE_CODE_ENABLE_FUNCTION_HOOKS": "1" } }
```

While hooks modules are in early access, Claude Code loads the mod's hooks only with
`CLAUDE_CODE_ENABLE_FUNCTION_HOOKS` set. The `CLAUDE_CODE_PLUGIN_DIRS` value is an absolute path:
write your home directory in place of `<home>` — on Windows with forward slashes
(`C:/Users/<you>`): JSON reads a backslash as an escape. Several plugin directories are joined
with `:` (`;` on Windows). A session reads the setting when it starts, so
only sessions started afterwards load the mod. Re-run the copy command after a `git pull` to update
the copy. To undo, take the mod's entry out of `CLAUDE_CODE_PLUGIN_DIRS` (remove the key if it was
the only entry), remove `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS` when no other mod still needs it, and
delete `~/.claude/orchestrate-mod/`. The setting names the
installed copy, never the clone: loading a mod writes generated files into the directory it loads
from.

### Use

- `/ledger` opens the pane: the active ledger's batches, the running agents, the conductor's
  context and the dollars spent. Where nothing draws a pane (a `claude -p` run, or an app that
  places no panes) it prints the same lines as text.
- The band line above the prompt condenses the pane to one line while the session's repository
  has exactly one active ledger.
- Each cost record is one JSON line, its keys in this order:
  `v`, `ts`, `session`, `agent`, `parent`, `type`, `ledger`, `batch`, `role`, `model`, `in`, `out`, `cr`, `cw`.
- `cost-report.mjs` totals the records by ledger, batch and role, by model and by session; an
  unpriced model's dollars are shown as unknown (`+?`), never as $0. The records cover the main loop
  and sub-agents only: the agent-progress summaries Claude Code requests for each running sub-agent
  (terminal sessions run them, desktop sessions do not) and auto mode's classifier calls are outside
  them. `--cost-state` adds a line per session comparing its records since the session last started
  with the `cost-state` total Claude Code last wrote in its transcript under `~/.claude/projects`,
  which counts the summaries but not the classifier calls:

```bash
node orchestrate-mod/tools/cost-report.mjs [--dir <dir>] [--ledger <id>] [--session <id>] [--format text|json] [--cost-state [--projects <dir>]]
```

### Clear and continue

The mod registers the tool `schedule_clear`, which the model calls by its full name
`mcp__orchestrate-mod__schedule_clear`. At every point that step 8 of the pinned `references/protocol.md`
§Session algorithm names, whatever the context, the conductor commits a PROGRESS session-log row
naming the LOG heading of the work since the row before, then calls the tool in place of its
10-minute timer. Where a wave closes on a checkpoint, it calls before the checkpoint's close-out, so
a clear leaves the whole close-out to the fresh conversation.

- The mod answers `not needed` when the conductor's context is under the ledger's clear threshold,
  the contract's `**Clear threshold**` line (300K for a contract without one), and the conductor
  carries on with no line and no timer.
- The mod declines when the band line does not show that ledger (the session is untagged, or tagged
  with another), the ledger's clear threshold line cannot be read, the ledger's pinned protocol does
  not name the tool, the integration tip has moved, the ledger's directory holds uncommitted files,
  an agent is in flight, or a clear is already scheduled, naming each agent that stops it.
  When it names an agent as waiting (it returned while a command of its own still runs) whose report
  is in, and the ledger needs nothing from that command, the conductor stops that agent by its agent
  id with TaskStop (the command's id would wake the agent for one more turn), then calls the tool
  once more. After a decline that stands, or with no mod, the conductor reads its own context size
  and runs its timer only at or past the ledger's clear threshold, or when the size or the threshold
  cannot be read.
- Otherwise the conductor posts the line the mod answers with and ends its turn. A two-minute
  countdown then runs in the band line: `clearing in M:SS · type anything to keep this conversation`.
  Any message keeps the conversation; a local command such as `/ledger` starts no turn, so it does
  not. A turn that is interrupted, or ends in a refusal or an error, drops the clear as well.
- At zero the mod runs `/clear`, then `/orchestrate continue <id> after-clear`. The earlier
  conversation vanishes from view and the fresh one boots from the ledger; its first answer names
  the LOG heading that the ledger's newest PROGRESS session-log row names, the run's record of the
  work before the clear.
- Background work still running when the turn ends, or a scheduled task (a cron), skips the clear,
  since its notice would wake the fresh conversation; so does an app that cannot report whether
  either is present, and an
  agent found running at zero. A skipped clear continues the run in this conversation with
  `/orchestrate continue <id> in-place <reason>`, which carries on without booting again while the
  integration tip is the one the conductor passed; should the app refuse that command, or the one
  that follows a clear, the band line names a command for you to type.
- `/ledger` lists each clear, with its time and the context it cleared, and a run total across the
  conversations the clears link.
- To turn the clear off, remove the mod as Install above describes; the 10-minute timer is the
  skill's own and needs no mod.

## Requirements

- Claude Code, in a **git repository** (the protocol is git-native and won't scaffold
  without one).
- The test suite needs the Claude Code CLI on PATH (`claude`, or `claude.exe` on Windows) for
  `claude plugin validate` and `claude plugin test`; no sign-in is needed.
- Sub-agents are used for census agents, implementers, reviewers, gate agents and the QA runner, but
  aren't required — without them the orchestrator implements a wave's batches one at a
  time in the main checkout and still runs the review as a separate adversarial pass per
  batch. Checkpoint placement is unchanged.
- Generated ledgers use runtime-neutral smoke delivery: reuse the committed
  HTML through available preview/file/publishing tools, or deliver the full script as
  plain text. Cloud verdict storage is optional. Claude artifact publishing instructions
  stay in the skill reference; another agent runtime can follow the ledger's contract
  and its pinned `references/protocol.md` without Claude APIs. Local HTML or plain text works without publishing a hosted page.

## What's in here

```
orchestrate/
├── SKILL.md                        entry point: mode dispatch, discovery, invariants
├── references/
│   ├── backlog.md                  the backlog and rulings entry forms, the bar for registering, packs, expiry and reconsideration
│   ├── protocol.md                 canonical spec, severity/round accounting, legacy interop, degraded environments
│   ├── execution-models.md         the waved stack: wave map, checkpoints, integration
│   ├── scaffolding.md              detection heuristics, interview, census, backlog sweep, pre-flight, placeholder registry
│   ├── subagent-prompts.md         implementer / reviewer / test hunter / QA runner / artifact proofer / census / pre-flight / convergence / fix-up skeletons
│   ├── smoke-page.md               the checkpoint hand-over format: assembly, pre-verified steps, publishing, verdict triage
│   ├── smoke-page-template.html    the smoke page itself, with slots for the run-specific content
│   ├── ruling-page.md              the change-complete ruling step's hand-over: sidecar, outcomes, paste check, delivery
│   └── ruling-page-template.html   the ruling page itself, with slots for the title and the sidecar's rows
├── templates/                      the six ledger files, with placeholders
└── tools/
    ├── git-evidence.mjs            read-only discovery, provenance and shipment facts
    ├── check-fence.mjs             read-only mechanical gate before independent review
    ├── smoke-inputs.mjs            input declarations, retained history and raw-file checks
    ├── validate.mjs                runs a ledger's validation spec in the foreground: one result line, the real exit code, a full log
    ├── ledger-parse.mjs            the one parser for plan, PROGRESS and batch tables and the contract's skill pin
    ├── check-ledger.mjs            one-line ledger checks: parse, skill (the pin hash), selfcheck, plan, cites and census
    ├── prompt.mjs                  renders one per-batch sub-agent prompt from the ledger and a facts file, ending in the nonce its report echoes; with --report it checks a report file and prints one line
    ├── mutate.mjs                  proves chosen mutations on a disposable clone: control first, then KILLED or SURVIVED each, restored byte for byte
    ├── run-at-ref.mjs              runs a validation spec on a disposable clone of any ref: one AT line, validate.mjs's exit code
    ├── prose-only-diff.mjs         classifies a polish diff: PROSE-ONLY when only JavaScript comments changed, else CODE or UNKNOWN, one line
    ├── scaffold.mjs                fills the templates from an answers file and writes the ledger only once a staged copy passes parse, selfcheck and plan
    ├── detect.mjs                  prints candidate interview answers read from the repository, as lines or JSON, and the latest prior contract
    ├── env-facts.mjs               prints the environment facts a contract records, one per line, flagging a tmpfs temp or repository filesystem
    ├── reconcile.mjs               read-only: discovery as one line per ledger; rows matches PROGRESS rows to their §Recovery row and Verdict
    ├── failing-on-base.mjs         runs protocol step 6b in a disposable clone: PROVEN, ALL-PASS (P0) or INCONCLUSIVE, one line
    ├── backlog.mjs                 reads a backlog or rulings file in its form: packs, expired, rulings and check, or UNKNOWN for a file not in the form
    ├── build-smoke-page.mjs        validates inputs and fills the checkpoint sidecar/template
    └── build-ruling-page.mjs       builds the ruling page from its sidecar, prints the LOG ruling list, checks the user's paste
```

The Markdown ledger and its pinned skill directory remain the workflow authority.
Read-only Git helpers collect evidence, and the smoke builder checks actual delivered
input bytes before writing the page. Existing ledgers keep their frozen rules;
unsupported helper shapes use the manual read-only fallback in the pinned
`references/protocol.md`. A mechanical PASS never replaces review.

```
orchestrate-mod/                    the optional mod (§Mods), beside the skill and not part of it
├── .claude-plugin/plugin.json      the plugin manifest
├── tsconfig.json                   extends the types Claude Code generates where it loads the plugin
├── hooks/
│   ├── hooks.json                  names register.js as the hooks module
│   ├── register.js                 the hooks module: every $ call, the /ledger command, the pane, the band line, the cost log, the clear
│   ├── clear.js                    pure: the tool's names, the countdown, the commands, the decision on a call, the turn's end, the run
│   ├── cost.js                     pure: attribution, the record format, the session's ledger tag, the totals
│   ├── prices.js                   pure: USD per million tokens by exact model id; an unpriced model is never $0
│   └── view.js                     pure: the pane's lines, the band line and the text fallback
├── tools/
│   ├── cost-report.mjs             totals the cost log by ledger, batch and role, by model and by session
│   └── ledger-view.mjs             one JSON view of the repository's active ledgers, which the pane reads
└── tests/
    ├── clear.test.tsx              kit test of the clear and continue, run by claude plugin test
    ├── cost.test.tsx               kit test of the cost log, run by claude plugin test
    └── pane.test.tsx               kit test of the pane, the band line and the text fallback
docs/                               longer reference notes and the findings of past experiments
```

Run all repository suites from the root with this PowerShell validation recipe:

```powershell
$testFiles = @(Get-ChildItem -LiteralPath tests -Filter *.test.cjs -File -Recurse | Sort-Object FullName | ForEach-Object FullName)
if ($testFiles.Count -eq 0) { throw 'No Node test suites discovered' }
node --test --test-reporter=spec @testFiles
if ($LASTEXITCODE -ne 0) { throw 'Node test suite failed' }
git diff --check
if ($LASTEXITCODE -ne 0) { throw 'Git diff check failed' }
```

Portable convenience: `node --test` from the repository root (bare, no directory
argument). Node's default discovery is separate from the explicit recursive FullName
ordering, empty-suite guard and failure propagation above; keep the full recipe for
ledger validation. Protocol tests execute both forms against a nested failing then
passing disposable sentinel and check the primary recipe's empty-discovery failure.
The plugins' kit tests are `*.test.tsx`, which bare `node --test` skips; both forms run them through
`tests/mod-plugins.test.cjs`, which runs `claude plugin test` on each plugin directory.
The smoke-page tests run the template's JavaScript with a minimal DOM and artifact-store
adapter, including checkpoint re-issues and verdict provenance. The Git-contract tests
require Git on PATH and create disposable local repos and bare remotes with isolated
configuration; no network service is needed, and temporary repos are removed afterward.
They exercise the actual read-only evidence and fence CLIs for discovery, shipment
and ledger history. Keep their command recipes aligned with the
documented rules when editing either; prose changes do not automatically change the tests.
The builder tests fill the shipped template from a sidecar and check the result against
the slot table: every slot filled, the same bytes each run, and rejection of invalid
inputs. Reissue tests cover stable step identities, appending new steps, revision
increases, and refusing a stale baseline without overwriting the issued page.

The conductor prepares and delivers actual reproducible smoke inputs, including the
Excel example in `tests/fixtures/smoke-inputs/`. Generate with literal `python
tests/fixtures/smoke-inputs/generate-orders.py <new-output.xlsx>` and independently
validate with `python tests/fixtures/smoke-inputs/validate-orders.py <workbook.xlsx>
<requirements.json>` (Python with openpyxl required). The expected total is 23.50 and
count is 4. Requirements cover sheets, types, formulas and cached results; hashes do
not replace that semantic validation. Detect the interpreter in the current environment.

Each file-dependent step links exact immutable inputs, validation evidence and
working-copy/reset instructions. The [input sidecar schema](orchestrate/references/smoke-page.md#input-registry-and-immutable-issue-files)
uses stable IDs with per-step references. Reissues preserve old issue files/history,
verify raw bytes (including LF/CRLF), and bump EVERY affected step's revision so old
passes become historical. Imported builders require an explicit inputRoot when files
are declared. Missing private data, credentials or external access is a named
prerequisite; no manual construction or false pre-verification replaces a deliverable.

## License

[MIT](LICENSE) — use it for anything, commercial or not. Attribution is the only
condition, and it's a copy-paste line.
