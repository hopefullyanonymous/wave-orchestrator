# B{{BATCH_NUM}} — {{BATCH_TITLE}} ({{BATCH_TYPE}}, {{BATCH_VERSION}})

**Branch**: `{{BATCH_BRANCH}}`
Cut from the integration tip when the wave opens.
**Wave**: {{BATCH_WAVE}} · **Weight**: {{BATCH_WEIGHT}}
**Depends on**: {{BATCH_DEPS}}
**Smoke gate**: {{BATCH_SMOKE_GATE}}
**Files**: {{BATCH_FILES}}
**New files**: {{BATCH_NEW_FILES}}
The fence: modify NOTHING else; need more? report `NEEDS_FENCE`.
**Applicable guardrails**: {{BATCH_GUARDRAILS}}
**Spec**: [01-plan.md](01-plan.md) §B{{BATCH_NUM}} · **Gate**: fence check → {{BATCH_GATE}}

## Implementation notes

<!-- The VERBATIM spec/finding/feature text plus every codebase fact gathered at planning
     time: file:line references, existing helpers to reuse, decisions the user already
     made, known traps. Each file:line reference is a pinned citation, the form
     `check-ledger.mjs cites` checks: a `path:line` span, one space, then a span holding a
     symbol that line carries — `orchestrate/templates/02-batch.md:14` `## Implementation notes`
     cites the heading above. Backlog fold-ins appear as their own sub-heading with the item's
     id and verbatim backlog text. This section is AUTHORITATIVE — implementers work from
     it alone and must not re-derive scope from the original request or external docs. -->

## Checklist

<!-- - [ ] one box per concrete deliverable, in implementation order; fold-in items are
     marked `[<id>]` and get their own commit. Implementers tick these as they complete
     them (the reconcile table reads them) and append `- [ ] polish: <ask>` lines only
     when the orchestrator sends a polish pass. Nothing else in this file is theirs to
     edit. The orchestrator is the one other writer: the commit that applies a prose
     ASK's replacement text appends its item, already ticked, and an unticked item for
     each ask it leaves to the polish pass. An appended item may wrap; its header
     starts at column 0 and every
     continuation line is indented under it — an indented checkbox is a new item,
     not a continuation, and the fence rejects it — exactly as shown:
- [ ] polish: Pin the boundary from both directions, so a later loosening of the
      grammar goes red instead of passing.
- [x] polish: The comment above parseFlags says what it returns and names
      check-fence.mjs as its caller, never how that caller behaves.
-->

## Acceptance criteria

<!-- Verifiable statements the reviewer checks against the actual diff — behaviors and
     invariants, not restatements of the checklist. For a `fix` batch, name the test that
     must FAIL on the un-fixed code (the failing-on-base check runs it). -->

## Validation

Run the validation commands in [00-READBEFORE.md](00-READBEFORE.md) — all green before
the batch may integrate (🟢). The orchestrator re-runs them on the integration tip after
the merge.

## Smoke (checkpoint)

<!-- Steps the USER or the QA RUNNER performs, written against the smoke procedure in
     00-READBEFORE.md. NOT run after this batch alone: they aggregate into the
     covering checkpoint's combined smoke page (data-touching sections first), so
     author each step in the page's field vocabulary:
     - Do: one action, imperative, naming the exact UI ("Press Edit… on a supplier").
     - Pass: the acceptance criterion — what the user sees when it works, kept apart
       from Do.
     - Runner: `agent` (executable in THIS repo's environment by a runner the contract
       lists — say which) or `human` (hardware, credentials, feel, another OS, live
       data). A step is human ONLY when it needs something an agent on this machine
       cannot do: a device, a GUI, held credentials, a judgement about whether
       something looks right, or something the environment contract forbids an agent
       here to do — the live-data and another-OS grounds above are that last kind, not
       exceptions to this rule. A checkpoint asks the user for a verdict, not for
       labour. Agent steps are pre-verified before the hand-over.
     - Inputs: stable IDs and exact issued file links, requirements, independently
       validated expected results, read-only or working-copy/reset commands. Conductor
       generates and delivers the files; no manual construction unless being tested.
       Preserve prior input/evidence paths and bump EVERY affected revision on reissue.
       Name specific private-data/credential/access prerequisites; missing means not
       pre-verified. QA must receive and validate the same actual files as the tester.
     - Aside (optional): warning or context ("Enter cancels here — click the button").
     - Counting (optional): when Pass checks a number, define ONE unit in the user's
       words ("One unit = one purchase order").
     - Tag (optional): short hazard label ("Scanner safety").
     Once per batch, if applicable: "You need" (test data / hardware / accounts),
     "Order matters" (cross-step constraints), "Touches your data" (flag — these
     sections run FIRST in the combined script and are human unless the contract names
     a disposable environment). -->
