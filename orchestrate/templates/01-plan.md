# Plan — {{CHANGE_ID}}

<!-- 2–4 sentences of context: what this change is, what prompted it, intended outcome. -->

**Orchestration**: this change runs under [00-READBEFORE.md](00-READBEFORE.md) — that
file is the contract of repo facts, run by its pinned skill directory's
`references/protocol.md`; this one only locks scope, waves, and checkpoints.

## Batch table

| # | Batch | Type | Weight | Branch | Wave | Files (fence) | Smoke | Version |
|---|-------|------|--------|--------|------|---------------|-------|---------|
<!-- one row per batch; Type = fix / feature / chore. Weight = S (a handful of files, no
     new behavior surface) / M / L (cross-cutting or hands-on) — it sets the gate shape
     and reviewer tier. Wave = the concurrent group it runs in. Fences must be DISJOINT
     within a wave — reshape batches (seam batches, splits, merges) until the safe waves
     are as wide as possible. Smoke = the covering checkpoint (e.g. "C1"), suffixed
     "(hands-on)" for batches that need the user's hands — those are the reason an
     intermediate checkpoint exists. Version "—" if the repo doesn't version.
     Every # cell is Bnn — two digits minimum; the fence check keys on it. Copy:
| B01 | <title> | fix | S | `fix/<slug>` | 1 | `path/one.ts`, `path/two.ts` | C1 | — |
-->

## Wave map & checkpoints

<!-- One line per wave: members + WHY they are safe together (disjoint fences, no
     dependency between them). One line per checkpoint: after which wave, which batches
     it covers, and why it sits there — intermediate checkpoints exist ONLY for
     hands-on risk; the final checkpoint is mandatory and covers everything since the
     last one (with no hands-on work outside the final wave, it is the ONLY one). Then
     any dependencies that force wave ordering.
     RULE: user-decision gates (UX mockup approvals, design picks) come FIRST —
     resolved at planning time where possible, else wave 1. No mid-run wave may stall
     waiting on the user for a gate the plan already knew about. -->

## Smoke-input inventory

<!-- For every file-dependent step: stable input ID, exact versioned issue path,
     required contents (workbook sheets/columns/types/formulas/edge cases), synthetic
     generation and independent validation, expected Pass result, read-only or exact
     working-copy/reset instructions. Identify specific private-data, credentials or
     external-access prerequisites. The conductor supplies actual usable files and
     evidence at close-out; no manual construction unless construction is the test.
     Preserve prior issue directories and bump every referencing revision on reissue. -->

## Backlog fold-ins

<!-- Accepted at plan approval, one line each: `<id> — <backlog text, verbatim> → B<NN>`
     (files ⊆ that batch's fence, machine-verifiable, one-line criterion, ≤2 per batch,
     none on L batches). Items considered and rejected go in LOG.md, not here. "none"
     if the sweep found nothing eligible or the user declined. -->

## Per-batch specifications

<!-- ### B01 — <title>
     One section per batch: verbatim request text for its items (fold-ins marked with
     their id), exploration findings (file:line facts, existing helpers to reuse),
     design decisions, edge cases, the applicable guardrails (the subset of the
     project's guardrail bullets this fence can violate). Each file:line fact is a pinned
     citation, as `orchestrate/templates/01-plan.md:53` `## Per-batch specifications` cites
     this heading (`check-ledger.mjs cites` checks each one). The batch files quote from
     here — write it complete enough that an implementer with zero other context can
     build from the batch file alone. -->

## Coverage audit (planning-time)

<!-- Table: every request item and accepted fold-in → its batch. Zero unassigned items
     before the scaffold commit. This table seeds PROGRESS.md's coverage audit. End with
     the pre-flight verdict line, verbatim: `Pre-flight: CLEAN` or `Pre-flight: N
     blocking fixed, M advisory (see LOG.md)`. -->
