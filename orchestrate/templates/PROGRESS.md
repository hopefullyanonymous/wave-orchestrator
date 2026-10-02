# Progress

**Identifier**: {{CHANGE_ID}}
**Started**: {{DATE}} · **Base**: {{BASE_SHA}} (the default-branch commit the ledger
branch was cut from — the "since" point for the first checkpoint's diff and for convergence)
**State**: ACTIVE
**Work list**: [01-plan.md](01-plan.md) (see [00-request.md](00-request.md))
**Contract**: [00-READBEFORE.md](00-READBEFORE.md) · **Narrative**: [LOG.md](LOG.md)
(read on demand by heading, never at boot)
**Smoke page**: — (current delivery: URL, ledger-relative HTML path, or `plain text`; update at each hand-over)
**Rule**: statuses here are claims; **git is truth**. Reconcile against branches/commits
before believing any row (§Recovery of the pinned skill directory's `references/protocol.md`).

<!-- **State** is exactly one of: ACTIVE | AT-CHECKPOINT C<n> | USER-BLOCKED | COMPLETE.
     Update it in the same commit as every wave open, checkpoint close-out and
     change-complete. Discovery greps this one line — keep the form exact. -->

## Execution model

**{{EXECUTION_MODEL}}** — {{EXECUTION_MODEL_RATIONALE}}

## Legend

- `⬜ Not Started` · `🔄 In Progress` · `🟢 Integrated` (reviewed, validations green on
  the worktree AND the integration tip, merged; awaiting its covering checkpoint) ·
  `🧪 At Checkpoint` (checkpoint reached, awaiting the USER's combined smoke verdict) ·
  `❌ Smoke Failed` (the USER failed a reached checkpoint — never an agent-found failure) ·
  `✅ Passed` (its checkpoint passed; merged toward the default branch per the merge
  policy — verify with git) · `⛔ Blocked` (`defective`, or `green, residual finding
  open`; awaiting the user's verdict; `⛔ (dropped)` once the user drops it) ·
  `❌ (fix-up capped)` (a checkpoint fix-up failed review twice; awaiting the verdict) ·
  `👤 User Action`

## Batches

| # | Batch | Branch | Wave | Version | Status | Updated | Notes |
|---|-------|--------|------|---------|--------|---------|-------|
<!-- one row per batch from the plan's batch table, all ⬜ at scaffold time (Version "—"
     if the repo doesn't version). Notes are DENSE but SHORT (≈300 chars of prose; keyed
     lines — `… capped:`, `… repair pending:` and `polish discarded:` markers, `verdict … spent`, `fix-up pending:`, `deferred to`,
     `R<k> <verdict> @<sha>[ asks=<n>]`, the metrics token — are exempt and never move to LOG): integration
     SHA, reviewer arc ("R1 FIX FIRST P1 → R2 SHIP"), tier used, fence extensions
     ("fence +path (item, reason, date)"), accepted residuals, then the metrics token
     `m: rounds=<FIX FIRST rounds> asks=<ASK items closed by polish> fence-bounces=<times
     the fence check sent the implementer back> gate=<gate-agent findings>/<of which
     needed a production change> tip-red=<1 if tip validation went red after this merge>`.
     Anything longer goes in LOG.md under a heading this cell names.
     Every # cell is Bnn — the same id as the plan's row and the batch file title. Copy:
| B01 | <title> | `fix/<slug>` | 1 | — | ⬜ | <date> | — |
-->

## Checkpoints

| Checkpoint | After wave | Covers | Why here | Status | Verdict |
|------------|------------|--------|----------|--------|---------|
<!-- one row per checkpoint from the plan's wave map — intermediate rows only after
     waves carrying hands-on batches, plus the mandatory final row. Status ⬜ until
     reached, 🧪 while awaiting the user, then ✅/❌ per the verdict log. The Verdict cell
     ends with the checkpoint's metrics token:
     `m: pre-smoke=<agent steps passed>/<human steps> human-smoke-min=<minutes the user
     reports> escaped=<defects the user found that no gate caught>`, completed when the
     user's verdict is recorded. -->

## Issued checkpoint inputs

<!-- At close-out link the sidecar's stable-id input registry, exact immutable issue
     files and independent validation evidence, raw hash/size manifest and usable
     delivery location. Record working-copy/reset instructions and named unavailable
     prerequisites. Reissue preserves previous page/sidecar/inputHistory and files;
     record every affected step revision. A hash alone is not semantic validation. -->

## Smoke-test verdict log

| Date | Checkpoint | Verdict | User notes |
|------|------------|---------|------------|
<!-- record the user's VERBATIM words for every checkpoint verdict — and for every
     verdict on a ⛔ batch or a capped repair (Checkpoint column = `B<NN>`) — including any
     merge/push/release authorization in the same message (that wording IS the
     authorization record) and which batch(es) a partial fail indicts. Verbatim quotes are
     exempt from every length cap. The smoke page's "Copy results as text" paste is the
     preferred form; works-but items become backlog entries, not failures. -->

## Item → batch coverage audit

| Request item | Source | Batch | Version | Status |
|--------------|--------|-------|---------|--------|
<!-- one row per user item from 00-request.md; Source = "request" or "backlog <id>" for
     an accepted fold-in. The final pass must show ZERO unaccounted items: each row ends
     as a merged commit SHA, an intended-behavior resolution, or a named backlog entry,
     and carries the convergence class (implemented / partial / contradicts — from the
     convergence pass when the contract has it on, else from PROGRESS + git). -->

## Session log

| Date | Session did | Stopped because |
|------|-------------|-----------------|
<!-- the FIRST row is the scaffold session. Then append one row per session, ≤200
     characters: waves opened with base SHAs, batches
     integrated, reconciliations, checkpoint close-outs with integration SHAs, and
     exactly why work halted (checkpoint, ⛔, user input needed, COMPLETE). Narrative
     goes in LOG.md under a heading named here. -->
