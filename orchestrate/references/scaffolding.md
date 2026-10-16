# Scaffolding a new ledger (`new` mode)

## Preconditions

1. **Git repo required.** Not a repo → STOP and offer `git init` (+ an initial commit)
   with the user's consent. Crash markers, the reconcile table, and "git is truth" are
   git-native; the protocol cannot run without it.
2. Resolve and confirm the default branch in interview #4 before creating anything;
   a dirty tree on that branch → warn and let the user decide.
3. An ACTIVE ledger already in `.agents/changes/` or on any branch (Discovery in
   SKILL.md) → ask whether to finish it first. Two concurrent ledgers are allowed only as
   the user's explicit choice.
4. **Effort.** A session running at max effort → before scaffolding, ask the user to set it
   to high, with the reason in one sentence: at max, one measured scaffold spent 54% of its
   output on thinking. Never change the setting yourself.
5. **Context.** A `new` that arrives after other work in this conversation → first read this
   session's context size: the input, cache-read and cache-creation tokens summed in the newest `usage`
   entry of its transcript that is not all zeros (an API error logs one that is), the transcript being
   `<session id>.jsonl` in a subdirectory of the `.claude/projects/` directory of the user's home
   (`CLAUDE_CODE_SESSION_ID` holds the id). Past about 200K, or when the size cannot be read, offer to
   scaffold in a fresh conversation, with the reason in one sentence: a scaffold adds about 500–800K by
   itself, and a conversation summarized automatically mid-scaffold loses the work in flight. On a yes,
   write the request verbatim, and whatever this conversation established that the scaffold needs, into
   a note under the session scratchpad, never the repository; once nothing this conversation started
   still runs in the background, the user runs `/clear`, then `/orchestrate new` naming the note. Never
   clear the conversation yourself.

## Procedure

1. **Detect** repo facts (heuristics below) — read-only.
   `node "<SKILL_DIR>/tools/detect.mjs" --repo <repo>` prints one line per registry placeholder
   it covers (`<NAME>: <value> — <source>`, or `<NAME>: unknown — <why>`), plus
   `PRIOR_CONTRACT`, the latest ledger contract in the working tree, whose baked answers a
   repeat repo offers as defaults (§Interview); `--format json` prints the same values as
   JSON. `node "<SKILL_DIR>/tools/env-facts.mjs" --repo <repo>` prints the environment facts
   a contract records, one per line, a `tmpfs` temp or repository filesystem flagged as
   wiped at reboot. The interview confirms these candidates; without the tools, the table
   below is the manual procedure.
2. **Interview** — back-to-back AskUserQuestion calls, as many as the open gaps need,
   covering only the gaps and the confirmations listed below.
3. **Plan** — explore the codebase (sub-agents as needed, at medium thoroughness by default; "very thorough" only when the interview needs an inventory and the prompt names what it is for), draft the batch table with
   file fences and a weight per batch (S / M / L), and map every request item to a
   batch. Then structure for throughput per `execution-models.md`: reshape fences for
   disjointness (seam batches, splits, merges), build the wave map (widest safe waves —
   "3 concurrent, then 2" beats 5 back-to-back), classify every batch hands-on vs
   machine-verifiable, tag every smoke step `Runner: agent | human` against the
   detected runner set and the environment's prohibitions ("touches data" is human
   unless a disposable environment exists), and place the smoke
   checkpoints (one after each hands-on wave + the mandatory final one — never per
   batch). A step is human ONLY when it needs something an agent on this machine
   cannot do: a device, a GUI, held credentials, a judgement about whether something
   looks right, or something the environment contract forbids an agent here to do —
   the prohibitions just named are that last kind, not exceptions to this rule.
   Pick the applicable guardrails per batch (the subset of the project's guardrail
   bullets its fence can violate).
   Record each codebase fact the plan and batch files rely on as a pinned citation, in the
   form the templates' instruction comments show (`` `path:line` `symbol` ``), so that
   `check-ledger.mjs cites` checks it against the base; any other `path:line` span it lists
   as unpinned.
   Inventory the exact required inputs for each step while planning: workbook
   sheets/columns/types/formulas/edge cases, independent validation, reproducible
   synthetic generation, immutable issue paths and working-copy/reset directions.
   Name actual private-data/credential/access prerequisites; do not defer ordinary
   input construction to the tester or invent a pre-verified result.
   **Census** — once the batches are drafted, spawn one `census` agent per batch, never one agent
   for several batches, with the `subagent-prompts.md` §Census skeleton filled with the batch's
   planned change and the facts it must find. Each report opens with where the draft is wrong or
   incomplete; before the pre-flight, record every one of those items in LOG.md as carried (the
   batch-file line that now holds it) or rejected (the reason). Whenever a later planning step — a
   pre-flight fix, an accepted fold-in or an adjustment at approval — adds a file, a hook or a
   behaviour to a batch, run the batch's `census` agent again and record its items the same way
   before the fill.

4. **Backlog sweep** — read the repo's backlog / feature / bug files and propose
   fold-ins. Eligible only if ALL hold: (a) the item's files are a SUBSET of one draft
   batch's fence; (b) it is machine-verifiable or covered by that batch's existing
   agent-runnable smoke steps — it never adds a human step and never changes the batch's
   hands-on class; (c) a one-line acceptance criterion, no design decision, no
   migration; (d) at most two per batch, none on an L-weight batch. Present the eligible
   list (id or a proposed id, verbatim text, host batch, why cheap) for the user to pick
   at PLAN APPROVAL — not a separate interview round. Items considered and rejected are
   noted in LOG.md. An accepted fold-in becomes a request item (00-request.md decision
   "folded from <file> <id> — approved <date>"; coverage rows tagged `backlog <id>`),
   gets its own checklist item, acceptance criterion and smoke step in the host batch,
   and its own commit. Only the ACCEPTED items receive an id in the repo's scheme
   (`{{BACKLOG_ID_PREFIX}}`); the rest of the backlog is untouched.
5. **Pre-flight** — spawn ONE fresh read-only sub-agent with the `subagent-prompts.md`
   pre-flight skeleton over the draft request, plan and batch files (fold-ins included).
   Draft them first as a ledger in a scratch worktree of the base (`git worktree add
   --detach <scratchpad>/wt-draft <base>`), with step 8's command and an answers file whose
   coverage audit ends in a provisional `Pre-flight: CLEAN` (the scaffold's self-check
   requires the line) and whose `foldins` stay empty (their markers belong to the real
   fill): `node "<SKILL_DIR>/tools/scaffold.mjs" --answers <draft answers> --repo <scratchpad>/wt-draft`.
   A re-draft after a fix first deletes the draft directory, which `scaffold.mjs` otherwise
   refuses. From that worktree's root run
   `node "<SKILL_DIR>/tools/check-ledger.mjs" plan --dir .agents/changes/<CHANGE_ID> --repo .`,
   `node "<SKILL_DIR>/tools/check-ledger.mjs" cites --dir .agents/changes/<CHANGE_ID> --repo .`
   and `node "<SKILL_DIR>/tools/check-ledger.mjs" census --dir .agents/changes/<CHANGE_ID> --repo .`,
   and include their three lines in the skeleton: `PLAN …` settles same-wave disjointness,
   dependencies and fence paths, `CITES …` names the citations that no longer hold, and
   `CENSUS …` the tracked files outside every fence that name a fenced path. Each line lists
   at most ten entries, then `(+<k> more)`; for a `PLAN FAIL`, `CITES FAIL` or `CENSUS` line
   cut short that way, the pre-flight checks for itself what the line leaves out. Where the
   tools do not run, the drafts go in as written and the skeleton's checks run without
   those lines.
   It checks coverage both ways, mechanical fence disjointness per wave, fence
   completeness (grep census of every symbol / channel / table / literal each batch
   touches, across tests, generated maps and docs), contradictions, criteria
   testability, and hands-on / runner / weight plausibility. Fix every BLOCKING finding
   before the plan goes to the user; record the verdict line in the plan's coverage
   audit and the detail in LOG.md.
   Once the last pre-flight round is done, delete the draft ledger directory and remove its
   worktree (`git worktree remove <scratchpad>/wt-draft`, or `git worktree prune` once that
   directory is gone), so Discovery never meets the draft as a second copy of the ledger.
6. **Front-load user gates** — a batch that depends on a user design choice (UX
   layout, mockup, visual/copy pick — anything the user must SEE before code is
   written) must never sit mid-sequence where it stalls the autonomous run:
   - Default: resolve it NOW, at planning time — produce the mockup/options (HTML
     mockup, sketch, annotated screenshot, or option list), get the user's pick in
     the same interactive session, and bake the APPROVED design into the batch file.
     The user is present during planning; mid-run they may not be.
   - If a design genuinely cannot be mocked until earlier code exists, schedule that
     batch as EARLY as its dependencies allow (wave 1 where possible) and mark the
     gate in the plan's batch table (`👤 design approval`) so the user approves the
     stall's position along with the plan. A gated batch never shares a wave with
     work that would run past its unanswered question.
   - Never bury a known user gate in the middle of an otherwise-autonomous sequence.
7. **Approve** — present the computed wave map (which batches run concurrently, and
   why that is safe), the checkpoint placement (after which waves, with the hands-on
   batches named) per `execution-models.md`, and each batch's weight; the user approves
   plan, wave map, weights, checkpoints and fold-ins in ONE pass, confirming or
   adjusting; that approval is the standing authorization for the concurrency.
8. **Fill** — instantiate every file in `templates/` into
   `.agents/changes/{{CHANGE_ID}}/` (`LOG.md` included), renaming `02-batch.md` to one
   `02-batches-{{BATCH_NUM}}-{{BATCH_SLUG}}.md` per batch. Replace every `{{...}}`
   placeholder with its value and every `<!-- ... -->` instruction comment with real
   content. `evidence/` is created at the first checkpoint, not now.
   Also write `validate.json` into the ledger directory, the spec `validate.mjs --help`
   describes: one step per confirmed validation command; a multi-line recipe block becomes
   ONE `shell` step whose `script` is the block's text (a PowerShell block: prefer `pwsh`;
   use `powershell` only where `pwsh` is absent — its log carries CLIXML noise); `parser` names the
   runner the command invokes (`node`, `jest`, `pytest` — without `-q`, whose summary it
   cannot read — `cargo`, else `none`). Run it once at the base through the contract's
   validation wrapper and record its line in LOG.md as the ledger's validation baseline.
   When the validation commands are `none`, write no `validate.json` (an empty `steps`
   array is invalid) and say so in LOG.md. When `{{WORKTREE_SETUP}}` is not `n/a`, also
   write `setup.json`, a `validate.mjs` spec holding the setup command(s), so a disposable
   checkout can be set up exactly like a worktree.
   Keep the generated contract's smoke facts runtime-neutral: its delivery procedure is
   the pinned `references/protocol.md`'s (the committed smoke HTML and capability-based
   HTML/text hand-over); publisher API mechanics stay in the skill.
   `node "<SKILL_DIR>/tools/scaffold.mjs" --answers <answers file> --repo <root>` performs this
   step, `<root>` being the root of the worktree step 10 commits from: it builds every file in
   memory, holds the staged copy to parse, selfcheck and plan, and only then writes
   `.agents/changes/<CHANGE_ID>/`, its `validate.json` and any `setup.json` included, in the
   line-ending style of the repository's tracked Markdown, and marks the accepted fold-ins
   (step 10). It never commits and prints one line: `SCAFFOLD OK <CHANGE_ID> <n> batches, <k> files`,
   `SCAFFOLD FAIL <n> problem(s): ...` with nothing written, or `UNKNOWN <reason>`. Its answers
   file, schema version 1, is one JSON object holding exactly these keys, the placeholders
   and headings inside them read from the templates at run time:
   - `values` — every placeholder outside `02-batch.md`, plus the naming-only `ID_PREFIX` and
     `CHANGE_SLUG`; `CHANGE_ID`, `LEDGER_DIR`, `SKILL_DIR` and `SKILL_SHA256` are computed
     (from `ID_PREFIX`, `DATE` and `CHANGE_SLUG`, and from the tool's own skill directory)
     and may be left out.
   - `sections` — one Markdown text per instruction comment outside `02-batch.md`, keyed
     `<template> <heading line>` (`01-plan.md ## Backlog fold-ins`); `""` removes the comment.
   - `batches` — one `{ "values", "sections" }` object per batch, in order: every
     `02-batch.md` placeholder plus the naming-only `BATCH_SLUG`, and its comments keyed by
     heading line.
   - `validate` — the `validate.json` spec above, or `null` when the validation commands are
     `none`.
   - `setup` — the `setup.json` spec, or `null` when `{{WORKTREE_SETUP}}` is `n/a` (an
     explanation may follow it).
   - `foldins` — one `{ "file", "batch" }` object per accepted fold-in, plus its existing
     `"id"` or, for an item without one, an `"anchor"`: the exact text of its line.
   Each refusal is named: a missing or unknown key at any level, a value that is not a
   string, a computed value supplied differently, a malformed `ID_PREFIX`, `CHANGE_SLUG`,
   `DATE` or `BATCH_SLUG`, a `BASE_SHA` that is no full commit SHA of the repository, a
   `BATCH_NUM` out of sequence, a `validate` or `setup` present where it must be `null` or
   missing where it must not be, a spec `validate.mjs` rejects, a fold-in it cannot mark, an
   existing ledger directory, and every problem of the staged ledger's checks. The text
   above stays the manual procedure.
9. **Self-check** — grep the new ledger directory for `{{` and `<!--`, and its `*.md`
   for `<title>` (a deleted marker can leave an example row behind): **zero hits**
   outside fenced and inline code spans. A hit inside a code span is not an unfilled
   slot — a ledger that documents templating work quotes those tokens legitimately.
   `**State**: ACTIVE` present in PROGRESS; the pre-flight verdict line present in the
   plan; every `#` cell of the batch tables in BOTH the plan and PROGRESS reads `Bnn`.
   Any hit outside a code span is an unfilled slot; fix before committing. Discount
   the ones inside a span in the commit message rather than editing them away.
   Then `node "<SKILL_DIR>/tools/check-ledger.mjs" parse --dir <the new ledger directory>`
   must print `PARSE OK`, and `node "<SKILL_DIR>/tools/check-ledger.mjs" skill --contract
   <the new ledger directory>/00-READBEFORE.md` must print `SKILL MATCH`: the pin line's
   placeholders sit in code spans, which the grep exempts, so an unfilled pin fails only
   here. The parse check runs at scaffold time only — a recorded fence extension later
   makes a Files line differ from the plan, which `parse` reports; the pin check also runs
   at every boot.
   `node "<SKILL_DIR>/tools/check-ledger.mjs" selfcheck --dir <the new ledger directory>`
   runs every rule of this step in one pass — its rules `slot` (the grep), `state`,
   `preflight`, `parse` (the `Bnn` cells and `PARSE OK`) and `skill` (`SKILL MATCH`) — and
   prints `SELFCHECK OK`, or `SELFCHECK FAIL` naming each problem by file and line;
   `scaffold.mjs` has already run it on its staged copy, and the rules above stay the manual
   procedure.
10. **Scaffold commit** — batch 00 = the ledger itself (plus the ids written onto
    accepted fold-ins in the backlog file), committed on `chore/{{CHANGE_SLUG}}-ledger`,
    which becomes the INTEGRATION BRANCH every wave stacks onto. Never on the default
    branch. `scaffold.mjs` has already ended each accepted fold-in's backlog line (inside
    a table row's last cell) with `Folded into <CHANGE_ID> <Bnn>.`, an item named by its
    `"anchor"` first taking the next id of the `{{BACKLOG_ID_PREFIX}}` scheme in that file;
    a scheme the file holds no id of yet must read `#`, or a letter, letters and digits,
    then one `-`, `_` or `.`.
11. **STOP** — report the ledger path and batch table. Start wave 1 only if the user
    says so.

## Evidence and input baking

Capture read-only discovery/shipment evidence with the protocol's helper recipes;
the conductor still resolves owner/target ambiguity. New contracts carry no helper
paths, manual fallback, outcomes or fence grammar of their own: those live in the pinned
directory's `references/protocol.md`, whose recipes run the helpers from that directory.
Never silently adopt changed gates for an
existing ledger. Use exact Branch and Files lines in batch files and exact backtick
paths in plan tables; unsupported shapes use manual checks, not inferred authority.
Bake `{{SKILL_DIR}}` and `{{SKILL_SHA256}}` too: `validate.mjs`, `check-ledger.mjs` and
every later skill tool a contract names run as `node "{{SKILL_DIR}}/tools/<tool>.mjs"`,
located by the pin rather than by a resolved path. Bake `{{SKILL_SOURCE}}` beside them:
how that directory was produced, so a pin mismatch can be restored byte-for-byte.

At hand-over preserve generated files and independent validation reports under
evidence/Cn/inputs/issue-NNN; use raw-byte copies and validate the delivered checkout.
Record interpreter discovery in the generated ledger, never a machine-local Python
path in reusable templates. Stable input IDs, step references and retained inputHistory
belong in the sidecar; every affected revision increases on identity/instruction change.
Hosted delivery without relative-file access requires usable attachments/local links.
See smoke-page.md for the complete schema and commands.

## Naming

- `{{CHANGE_ID}}` = `{{ID_PREFIX}}-<YYYYMMDD>-{{CHANGE_SLUG}}` (e.g.
  `IST-20260713-ux-fix-pack`).
- Batch files: `02-batches-{{BATCH_NUM}}-{{BATCH_SLUG}}.md`, `{{BATCH_NUM}}` two digits
  starting at `01` (`00` is reserved for ledger scaffolding).
- Repair branches: `fix/<batch-slug>-c<n>-followup` (checkpoint failure),
  `fix/<batch-slug>-tip` (red integration tip), `fix/<batch-slug>-presmoke-<step>`,
  `fix/<batch-slug>-revert` (user-ordered revert of a merge); NEEDS_FENCE continuations:
  `<batch-branch>-w<n+1>`.
- Ledger root is always repo-root `.agents/changes/` — it is the discovery anchor every
  mode globs for. Closed ledgers may move to the sibling `.agents/archive/`. Override
  only on explicit user request.

## Placeholder registry (single source of truth)

Every `{{...}}` in `templates/` must appear here, and every row marked *template* must
appear in the templates — check both directions when editing either.

| Placeholder | Where | Filled from |
|---|---|---|
| `{{CHANGE_ID}}` | template (READBEFORE, PROGRESS, plan, LOG) | computed: prefix + date + slug |
| `{{CHANGE_SLUG}}` | naming only | short kebab-case name for the change |
| `{{ID_PREFIX}}` | naming only | interview #6 (default: repo-name initials) |
| `{{DATE}}` | template (PROGRESS, request, LOG) | today, YYYY-MM-DD |
| `{{BASE_SHA}}` | template (PROGRESS) | `git rev-parse HEAD` on the branch the ledger branch is cut from, taken at fill time BEFORE the scaffold commit (the scaffold commit cannot contain its own SHA) |
| `{{LEDGER_DIR}}` | template (READBEFORE) | `.agents/changes/{{CHANGE_ID}}` |
| `{{MAIN_BRANCH}}` | template (READBEFORE) | interview #4 — confirmed default branch as a full local ref (`refs/heads/main`); detection supplies a candidate only |
| `{{SHIPMENT_SOURCE}}` | template (READBEFORE) | interview #4 — `local` or `remote <remote-name>`; whether a local merge or a merge on that remote counts as shipped |
| `{{SHIPMENT_REF}}` | template (READBEFORE) | interview #4 — full `refs/heads/<name>` on the confirmed shipment source; never a remote-tracking cache ref |
| `{{INTEGRATION_BRANCH}}` | template (READBEFORE) | `chore/{{CHANGE_SLUG}}-ledger` unless the user overrides |
| `{{BRANCH_PREFIXES}}` | template (READBEFORE) | detected from `git branch -a` history; default `fix/ feat/ chore/` |
| `{{MERGE_POLICY}}` | template (READBEFORE) | interview #4 (incl. whether batch commits survive — squash collapses per-fold-in reverts; say so) |
| `{{EXECUTION_MODEL}}` | template (READBEFORE, PROGRESS) | procedure step 7 — the approved wave map summary (waves + members + checkpoint positions, e.g. "Waved stack — W1: B01+B02+B03; W2: B04+B05. Checkpoints: C1 after W1 (B02 hands-on), C2 final") |
| `{{EXECUTION_MODEL_RATIONALE}}` | template (READBEFORE, PROGRESS) | written at scaffold time: WHY these waves are safe together and why the checkpoints sit where they do, in 2–4 sentences |
| `{{VALIDATION_COMMANDS}}` | template (READBEFORE) | interview #1 — fenced block, one command + comment per line, each in its QUIET form (totals line + failing test names; a repo-local quiet reporter if one exists), or literal `none` |
| `{{MUTATION_RUNNER}}` | template (READBEFORE) | detected (Stryker / mutmut / cargo-mutants / PIT config) and confirmed in interview #1, with the command scoped to changed files; else `none` |
| `{{VERSION_FILES}}` | template (READBEFORE) | interview #2 — or `none` |
| `{{VERSION_BUMP_RULE}}` | template (READBEFORE) | interview #2 — cadence + per-batch vs per-change + which component moves, or `none` |
| `{{CHANGELOG_RULE}}` | template (READBEFORE) | interview #2 — path, ordering (append bottom vs prepend), heading format, voice, or `none` |
| `{{SMOKE_PROCEDURE}}` | template (READBEFORE) | interview #3 — always asked |
| `{{AGENT_RUNNERS}}` | template (READBEFORE) | interview #3 — which runners an agent may use in THIS environment (`none` / CLI / HTTP / browser / screenshot), the disposable data environment if any, and the prohibitions that apply (e.g. "never launch the headed app") |
| `{{SKILL_DIR}}` | template (READBEFORE) | the absolute path of the directory holding the skill's `SKILL.md` (the base directory the skill loader reports), forward slashes, stored RAW between the pin line's backticks — never quoted there; every command that uses it quotes it. Never relative or `~`: the pin check reads it from the working directory |
| `{{SKILL_SHA256}}` | template (READBEFORE) | the hex field of `node "<SKILL_DIR>/tools/check-ledger.mjs" skill --dir "<SKILL_DIR>"`, run at fill time |
| `{{SKILL_SOURCE}}` | template (READBEFORE) | filled at fill time next to `{{SKILL_SHA256}}`: how the pinned directory was produced — e.g. ``git archive <commit> orchestrate`` of `<clone path>`, a copy of `<path>` at `<commit>`, or `unknown`; a restore after a pin mismatch rebuilds the directory byte-for-byte from it |
| `{{WORKTREE_SETUP}}` | template (READBEFORE) | detected install/build step (`npm install`, `cargo fetch`, …) or `n/a` |
| `{{REPO_CONVENTIONS}}` | template (READBEFORE) | distilled from the project CLAUDE.md/docs — the BINDING subset, ≤25 lines, plus a pointer to the source doc; never a wholesale copy |
| `{{EXTRA_PROHIBITIONS}}` | template (READBEFORE) | interview #7 / CLAUDE.md — repo-specific never-touch items; `(none beyond the above)` if empty |
| `{{GUARDRAILS_REF}}` | template (READBEFORE) | detected guardrails section (e.g. `` `CLAUDE.md` §Bug-Class Guardrails ``) or `the project guardrails doc (none yet — create a CLAUDE.md guardrails section at first distill)` |
| `{{GATE_AGENTS}}` | template (READBEFORE) | interview #7 — the read-only gate agents this ledger runs beside the reviewer (repo-local `.claude/agents/*.md` such as a test hunter, or the skill's generic test-hunter skeleton), with the testing guide / catalog each must read first; `reviewer only` when none |
| `{{ROLE_TIERS}}` | template (READBEFORE) | interview #7 — model-agnostic wording per role, e.g. "implementers and gate agents: default; reviewer: at least the implementer's tier, most capable available for L batches and the fresh implementer of an authorized third round" |
| `{{BACKLOG_FILE}}` | template (READBEFORE) | detected (`BACKLOG.md`, `TODO.md`, issue tracker) or `` `BACKLOG.md` (create on first residual) `` |
| `{{BACKLOG_ID_PREFIX}}` | template (READBEFORE) | detected id scheme in the backlog files (`SCAN-6`, `#3.5`, `BL-017` …) or `BL-` when none; only accepted fold-ins and new residual entries receive ids |
| `{{RELEASE_COMMAND}}` | template (READBEFORE) | detected build/release script or `none` |
| `{{BATCH_NUM}}` | template (batch file) | per batch, two digits |
| `{{BATCH_SLUG}}` | naming only | per batch, kebab-case |
| `{{BATCH_TITLE}}` | template (batch file) | per batch |
| `{{BATCH_TYPE}}` | template (batch file) | `fix` / `feature` / `chore` |
| `{{BATCH_WEIGHT}}` | template (batch file) | `S` (a handful of files, no new behavior surface) / `M` / `L` (cross-cutting or hands-on) — checked by pre-flight |
| `{{BATCH_VERSION}}` | template (batch file) | per the bump rule; `—` if the repo doesn't version |
| `{{BATCH_BRANCH}}` | template (batch file) | `<prefix>/<batch-slug>` |
| `{{BATCH_DEPS}}` | template (batch file) | the `Bnn` ids of the batches this batch needs integrated first, comma-separated (`B01, B03`), or `none` if independent; `check-ledger.mjs plan` reads every `Bnn` on the line, each from an earlier wave |
| `{{BATCH_WAVE}}` | template (batch file) | wave number from the plan's wave map |
| `{{BATCH_SMOKE_GATE}}` | template (batch file) | `hands-on — checkpoint C<n> follows wave <w>` or `machine-verifiable — covered by the final checkpoint (C<n>)` |
| `{{BATCH_FILES}}` | template (batch file) | the file fence from the plan's batch table |
| `{{BATCH_NEW_FILES}}` | template (batch file) | the fence files this batch creates, as exact backtick paths (`src/new.ts`), or `none`; `check-ledger.mjs plan` reads it: each path in this batch's fence and not yet in the repository, and a later wave's batch may fence it unmarked |
| `{{BATCH_GUARDRAILS}}` | template (batch file) | the applicable subset of the project's guardrail bullets for this fence (one line each), or `none apply` |
| `{{BATCH_GATE}}` | template (batch file) | the gate shape for this weight: `failing-on-base + reviewer + <gate agents>` (fix, M/L), `reviewer + <gate agents>` (M/L), `failing-on-base + one combined reviewer+gate pass` (fix, S), `one combined reviewer+gate pass` (S) — "reviewer only" wherever the contract names no gate agents |
| `{{CONVERGENCE}}` | template (READBEFORE) | interview #7 — `on` (a read-only convergence sub-agent runs at change-complete) or `off — the coverage audit is built from PROGRESS rows + git`; default off for a repo's first ledger |

## Detection heuristics (run before asking anything)

| Topic | Look at | Derive |
|---|---|---|
| Validation commands | `package.json` scripts (`lint`, `format:check`, `typecheck`, `check`, `test`, coverage); `justfile` / `Makefile` targets; `Cargo.toml` → `cargo fmt --check` + `clippy` + `test`; `pyproject.toml` → `ruff` / `pytest`; `go.mod` → `go vet` + `go test ./...` | candidate command list to confirm |
| Quiet form | a repo-local reporter (`scripts/*reporter*`, `--test-reporter`), runner flags (`pytest -q`, `jest --silent`, `cargo test -q`, `go test` without `-v`), whether failing test NAMES appear in the summary | the quiet form of each command in `{{VALIDATION_COMMANDS}}` |
| Mutation runner | `stryker.conf.*`, `[tool.mutmut]`, `cargo-mutants`, PIT plugin | `{{MUTATION_RUNNER}}` (scoped-to-changed-files command) or `none` |
| Version + changelog | version fields in `package.json` / `manifest.json` / `Cargo.toml` / `pyproject.toml` / `VERSION`; if `CHANGELOG.md` exists, read the FIRST and LAST headings to infer oldest-first (append bottom) vs newest-first (prepend top) | candidate `{{VERSION_FILES}}` / `{{CHANGELOG_RULE}}` |
| Default branch + shipment target | `git symbolic-ref --quiet refs/remotes/origin/HEAD` (or the relevant remote's HEAD), repo merge-policy docs, `git for-each-ref --format='%(refname) %(symref)' refs/heads/ refs/remotes/` | candidates only; confirm `{{MAIN_BRANCH}}`, `{{SHIPMENT_SOURCE}}`, `{{SHIPMENT_REF}}` in interview #4 |
| Branch prefixes | `git branch -a` naming history | `{{BRANCH_PREFIXES}}` |
| Conventions / prohibitions / guardrails / backlog | project `CLAUDE.md`, `CONTRIBUTING.md`, `.claude/` docs; files named `BACKLOG*`/`TODO*`/`BUGS*`/`FEATURE*`; the id pattern their entries carry | `{{REPO_CONVENTIONS}}`, `{{EXTRA_PROHIBITIONS}}`, `{{GUARDRAILS_REF}}`, `{{BACKLOG_FILE}}`, `{{BACKLOG_ID_PREFIX}}` |
| Gate agents + testing guide | `.claude/agents/*.md` whose `tools:` are read-only (Read/Grep/Glob) and whose description is review-shaped; `TESTING-GUIDE*`, `docs/testing*` | candidates for `{{GATE_AGENTS}}` and the catalog each reads first |
| Runners + environment | OS and shell; whether the app can run headless here; CLI entrypoints; HTTP endpoints; browser tooling available to the session; CLAUDE.md prohibitions on launching the app or touching data; a fixture/disposable environment | `{{AGENT_RUNNERS}}` and the batch files' `Runner:` tags |
| Release step | `build`/`release`/`package` scripts | `{{RELEASE_COMMAND}}` |
| Monorepo | multiple `package.json` / workspace config | ask which package is in scope; constrain fences to it and filter validation commands (`pnpm --filter <pkg> …`) |

`origin/HEAD` is a cached hint, not authority; validate its target exists and present
the candidate for confirmation. Neither the current checkout nor `init.defaultBranch`
identifies this repo's default. Missing/stale hints, both `main` and `master`, other
remotes or a local-only repo → ask in #4, never guess. `git remote set-head origin -a`
is an optional repair hint for a missing/stale remote HEAD, not part of read-only
detection. Do not run it or fetch automatically.

## Interview (back-to-back AskUserQuestion calls — confirmations + gaps only)

1. **Validation commands** — present the detected list in its quiet form to
   confirm/edit; nothing detected → ask, offering "none (the checkpoint smoke tests carry
   all verification)". Confirm the mutation runner if one was detected (default: named
   but only run when a batch's gate calls for it).
2. **Version + changelog** — bump per batch, per change, or never? Which files move in
   lockstep? Changelog convention (confirm the inferred ordering).
   **Default to bumping at least once per CHECKPOINT, and say why when you ask.** A
   single bump deferred to close-out leaves the integration branch sharing a version
   with the branch it was cut from — so the smoke script's "confirm the version" step
   cannot distinguish them and passes on the wrong build. That shipped: a user ran an
   entire 20-step script against the base branch, reported the un-fixed defects as
   failures, and caught it only by asking whether the changes were really in the
   build. If the user still prefers one bump, say plainly that the checkpoint scripts
   will then need a behavioural canary instead, and make sure they get one. A
   changelog entry per checkpoint is NOT implied — one entry per change is usually
   still right; it is the VERSION that must move.
   **Ask WHICH COMPONENT moves, and default to PATCH for the checkpoint markers and
   ONE MINOR for the release.** A checkpoint bump exists only to differ from the
   branch it was cut from, so it is a marker, not a release. A pack that read
   "bump per checkpoint" as a minor bump each time burned four minor versions on a
   single change (0.11 → 0.12 → 0.13 → 0.14 against a base of 0.10.12) and had to
   be renumbered to 0.11.0 at close-out. Patch markers (0.10.13, .14, .15) leave the
   release number free and still satisfy step 0.
3. **Smoke procedure + runners** — ALWAYS asked, free text: "How do you verify a change
   by hand in this project?" (checkpoint smoke scripts are written against the answer,
   including any gotchas like "reload the extension, then refresh the page"). Then:
   which of the detected runners may an agent use here (none / CLI / HTTP / browser /
   screenshot), is there a disposable data environment, and what must an agent never
   do (launch the headed app, touch live data)? The answers decide the tags, not a
   blanket fallback. A step is human ONLY when it needs something an agent on this
   machine cannot do: a device, a GUI, held credentials, a judgement about whether
   something looks right, or something the environment contract forbids an agent here
   to do — the answers to this question are that last kind, not exceptions to it.
4. **Default branch + merge policy** — confirm the actual default branch as a full
   local ref (`{{MAIN_BRANCH}}`, protected even if no local copy currently exists).
   Confirm whether shipment means a merge into that LOCAL branch or into its branch
   on a named REMOTE; record `{{SHIPMENT_SOURCE}}` and the full `{{SHIPMENT_REF}}` on
   that source. Confirm that it is the declared default on that source, not another
   feature branch. Verify the chosen source/ref exists and resolves to a commit; the
   integration branch must be distinct from the default and shipment branches.
   A remote-tracking ref is only a cache; for remote shipment, record the actual
   remote name and its `refs/heads/<name>`, not `refs/remotes/...`. Local-only repos
   need no remote or push. Default: work stacks on the integration branch; the USER
   smoke-tests at checkpoints and merges; the orchestrator never pushes. Confirm or
   adjust (PR flow, orchestrator ff-merge on recorded verdict, squash — note that squash
   collapses per-fold-in commits, so surgical reverts stop being available).
6. **ID prefix** — default: initials of the repo directory name
   (`inventory-sync-tool` → `IST`); confirm. Confirm the backlog id scheme.
7. **Gates, tiers, distillation targets, prohibitions** — offer the detected gate agents,
   the convergence toggle, and the tier wording; only if detection found no guardrails section or backlog file:
   create them at first close-out? (default yes). Any never-touch files beyond the
   standard prohibitions?

**Defaults for a repo's FIRST ledger under this contract** (the pilot): always on —
the mechanical fence check, failing-on-base, plan pre-flight, the backlog sweep, the
metrics token. Offered but default OFF — gate agents beside the reviewer, agent
pre-smoke (runners `none`), the convergence pass. Say so in the interview: "on for the
next ledger once this one's metrics token has shown review time, false stops and human
smoke minutes." The contract records which gates this ledger runs, so a driving session
never guesses.

Back-to-back AskUserQuestion calls are the DEFAULT. Ask one question per decision that
can independently change the plan; four questions per call is the tool's schema cap on
`questions`, not a budget; issue as many calls as the open gaps need. Two decisions
never share one question.

Never join two independent axes in one option LABEL — a `+` or an `and` in a label is
the smell. "Full recipe + agent-run smoke" reads as one choice and is two: the user who
wants the full recipe with human-run smoke has nothing to click, so the answer comes
back as free text or as the wrong pick. One axis per question, one axis per label.

`confirmations + gaps only` is what bounds the count now that the number of calls does
not: never ask what detection already answered — present it for confirmation, or not at
all — and never ask what procedure step 7 will ask again (plan, wave map, weights,
checkpoints, fold-ins).

A REPEAT repo needs almost no interview: Discovery (SKILL.md) already finds prior
ledgers. Read the most recent one's `00-READBEFORE.md` and offer its baked answers as
the defaults for everything it settles; a second ledger in the same repository needs one
call, or none.

Cap REPEATS, not questions. Each decision is asked ONCE, its answer recorded verbatim in
`00-request.md`, and never re-litigated at plan approval or at close-out. Asking more is
cheap; asking twice is what produces "Use these conventions." and a system built on a
guess.

Fold-in picks are NOT interview questions — they ride plan approval (procedure step 7).

## Baking rule

Interview answers are written INTO the generated `00-READBEFORE.md` — never left as a
pointer into this skill's reference docs. A ledger references ONLY its pinned skill
directory, by absolute path and hash; its procedure is that directory's
`references/protocol.md`, frozen by the hash, and every step a tool performs also has its
manual procedure there; a changed skill stops the ledger at its next boot and asks,
and never silently changes how it runs. The contract carries repo facts only, never a
copy of that procedure; the recipe block for validation stays in it. Each ledger must
be drivable by a session from the ledger plus its pinned directory: State line, LOG.md,
`NEEDS_FENCE`, ASK, tiers, runners, evidence, fold-ins and their ids are explained
between the ledger's own files and that directory's `references/protocol.md`.
