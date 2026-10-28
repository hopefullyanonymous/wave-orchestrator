# Guardrail receipts

The incidents behind the longer rules in `CLAUDE.md` §Bug-class guardrails, and the rules retired from it.
`CLAUDE.md` keeps each rule; the stories live here so the always-loaded file (and every gate
prompt rendered from it) stays small. Nothing here is a rule of its own.

## A guard that SAMPLES the domain it claims to sweep

The most productive class this repository has: eleven sightings in one change, five in another,
including in the very assertions written to close earlier sightings. Every instance was caught by a
gate that MUTATED the fix; none by one that read it — the author is thinking about the behaviour
being pinned, not about whether the new pin can fail. A sweep grown from ten patterns to fourteen
once lost a spelling while every visible signal said it grew. *(BL-004 polish, BL-016 round 2, and
five more in `OS-20260921-backlog-closeout`)*

Greppable shapes, no understanding of the code required (moved from `CLAUDE.md` at the
`OS-20260925-slim-contract-pack` close-out):

- two literals partitioning one collection with nothing relating them — for every array
  literal used as a loop domain, assert on the DOMAIN (size, set-equality, a count over
  results), not its members;
- `new Set([...a, ...b]).size === a.length + b.length` — a uniqueness check, not a size check
  (delete a member and both sides shrink);
- `indexOf` without a loop — only the FIRST occurrence is governed;
- a fixed ±N window per occurrence — occurrences closer than N share markers, and a
  generously spaced arming control never exercises the overlap;
- a corpus whose every entry sits inside the pattern's own bound (derived from it, whatever
  the comment says) — write it as prose first, pin its size and set, and require each pattern
  to own an entry no other catches;
- an out-parameter passed inline as a fresh literal and never bound;
- a sweep built on another test's unit reader — it inherits that reader's exclusions, as a
  directive sweep did that read no heading where the template's headings carry directives
  (`OS-20261022` B03 R3);
- an exclusion deferred to another guard's pin but bounded by its own, wider anchors — the text
  between the cut's end and the pin's is read by neither (`OS-20261022` B06 R2–R3).

## A sweep blind to an edit that NARROWS a rule's scope

A closed enumeration ("human ONLY when it needs a device, a GUI, held credentials, or a look-and-see
judgement") shipped one clause from a human list naming grounds it omitted — another OS, live data —
which would have licensed tagging a live-data step `agent`. The contradiction sweep could not see
it: it keyed on the rule's own vocabulary, and this was a narrowing, not a restatement.
*(BL-016 round 1)*

## A verdict that depends on the platform or the checkout

Moved from `CLAUDE.md` at the `OS-20260927-scaffold-reconcile-tools` close-out, where three bullets
became one. CRLF/LF behaviour passed only because this machine happens to check out one way, so the
equivalence is asserted explicitly *(BL-004, polish)*. Linux git indexes a file name holding a
control character that Git for Windows refuses, so a test green on every Linux gate failed the
Windows checkpoint; the fixture is now built from tree objects (`tests/prose-only-diff.test.cjs`'s
line-break fixture; OS-20260925 C1 issue 1).

At `OS-20260927` C1 issue 1, six Windows-only failures escaped every Linux gate:
- Two came from a test helper that split CRLF-checked-out templates on LF anchors.
- Three expected `path.join`'s `C:\…` where git's porcelain prints `C:/…`.
- One expected `/` where node's reporter names a test file with the native separator.

Each repair emulates the other platform on every platform, never skipping:
- `skillCopy`'s `eol` argument in `tests/scaffold.test.cjs`;
- `respell`, a worktree's admin `gitdir` rewritten with a `/./` segment, in `tests/reconcile.test.cjs`;
- `windowsSpec`, node's real runner behind a shim that respells `tests/`, in `tests/failing-on-base.test.cjs`.

At `OS-20261022` C1 step 13 an emulation itself failed on Windows: a test built its CRLF form by
converting README as read from the checkout, so a CRLF checkout became CR CR LF. Build both forms
from one canonical text (`tests/orchestrate-mod-cost.test.cjs`'s README §Use test, `d4b7ea9`);
the siblings are BL-106.

## A test that reads a child's raw output

The Windows run of C1 step 14 (a colour terminal, Node v22) failed one test while every gate had
passed it: the test searched a child's raw log for lines beginning `✔ `, and node's runner, started
from a colour terminal, had handed `FORCE_COLOR=1` to the test files, so the child's reporter lines
arrived painted. Every agent validation run had written to a file, never a TTY. *(OS-20260923 C1
issue 2)*

## A pointer is not a specification

`BL-003` named the wrong file; `BL-002` was wider than its text. In one change two of three entries
misdescribed the repair rather than the location: one proposed a code-span exemption when the real
defect was that the scan ran over the filled OUTPUT, and one named a wiring target that is pre-page by
construction while the pass it wires is post-page — both would have shipped as written. A backlog
entry's "a device, a GUI, held credentials, or a judgement" was an example, not a specification, and
shipping it behind an ONLY narrowed a safety rule. Five figures baked into one ledger — a registry-row
count, a PyYAML claim, a gap-family size, a file set, a violation count — were each corrected by the
agent asked to act on them.

## A close whose rationale points at documentation that does not contain the fact

An entry was closed as accepted on the ground that a declared `KNOWN_GAP` documented all three
cases; it documented two, and the same diff deleted the only other live record of the third. Every
signal read like a decision; the effect was a silent deletion.

## Reading a stale copy of a document once

A ledger was scaffolded with a `**Files**` header taken from a stale installed copy of this skill,
read early and discarded later; the form was plausible, so nothing looked wrong, and it silently
killed the fence tool's Files-line branch for the whole ledger.

## The apparatus that writes or verifies the work

Six sightings in one change, five tools: `Set-Content` collapsed a test file to one line;
`git checkout` ate an uncommitted edit mid-mutation; an editor decoded `\uXXXX` into literal control
bytes that behaved identically; a heredoc collapsed `\\n`; the Bash tool collapsed `\\b` into a
backspace inside a `new RegExp`, making every pattern dead and producing a false clean result. The
first three corrupted the work, the last two the verification of it; a live control paid out twice in
a single round. A seventh sighting, on the very commit that distilled the first six: backticked
filenames inside a DOUBLE-QUOTED `node -e "…"` string were command-substituted by bash and replaced
with nothing, so a close-out record read "puts  and  inside a test's domain". In OS-20260923 the
orchestrator's own gate loop read `$?` after a `$(…)` substitution and recorded basename's exit code
for every gate command; only the canary's expected exit 1 exposed it.

A test-hunter proved a real finding with a mutation anchored on a tag the shipped template does not
contain, so it never applied and its "suite stayed green" measured nothing — and by the same token its
claim about what the old code caught was unfounded too. The conclusion survived a correctly anchored
re-run; the proof did not. Later the same session, two more mutation scripts aborted on their own
anchor guards, each of which would otherwise have been a false green. A canary once reported "no
filter command was executed" over a fixture that contained nothing that could execute one.
*(BL-003 polish)*

Writing Markdown safely (moved from `CLAUDE.md` at the `OS-20260925-slim-contract-pack` close-out):
write it through the file tools or a single-quoted script — a double-quoted shell string
command-substitutes its backticks — and sweep the result for emptied code spans (a doubled space
where a name was) rather than rereading the line.

Moved from `CLAUDE.md` at the `OS-20260927-scaffold-reconcile-tools` close-out:
- A canary without a case that makes its marker appear is self-fulfilling, and its absence elsewhere
  means nothing.
- Every mutation script says in its report when it aborted: "I mutated it and nothing reddened" is a
  claim to verify.
- Restore-by-checkout is only safe once the real edit is committed.

## An issued input derived from the tree

A pin of the skill directory's hash, issued at C1, failed at its re-issue because the fix-ups had
changed three skill files; the step that consumed it had been re-issued at its old revision without
new inputs. *(OS-20260923 C1 issue 2, step 6)*

## Severity is about behaviour, never about the fence

Two defects — `validate.mjs` counting a test file with no tests as a passing test, and `mutate.mjs`
reading SURVIVED after a control that ran no test — were found by the gates and routed to the backlog:
one downgraded to an ASK because its fix sat outside the batch's fence (a fence extension was
mechanically available), the other recorded as a display nit without checking its consequence. The
user asked whether they were P0/P1 and failed the checkpoint. *(OS-20260923 C1 issue 1)*

## Text tools that transform what they write

`String.replace`'s string form expands `` $` `` and `$&`, and it spliced BACKLOG.md *(OS-20260925
close-out LOG)*. The Write and Edit tools decode a typed `\uXXXX`, so invisible characters are built
with `String.fromCharCode` *(the invisible-character sweep)*. At the `OS-20260927` close-out, the Bash
tool did the same twice: it decoded a typed apostrophe escape inside a single-quoted `node -e` script
before bash saw it. That ended the quoted string early, and the command failed to parse, so nothing
ran. Such scripts now go to files first.

## Trimmed from `CLAUDE.md` on 2026-10-10

Eight entries were merged into their nearest class, and three bullets were retired. Each merged rule kept
its text in `CLAUDE.md`. These are the sources and pointers that were cut:
- A new rule that decides an old case first: `OS-20260927` B03 R1 F1; the B06 C1 fix-up.
- A verdict that depends on the platform or the checkout: OS-20260925 and `OS-20260927` C1 issue 1 (above).
  A test that reads a child's raw output merged into it: OS-20260923 C1 issue 2 (above).
- A fail-closed guard over an open domain: OS-20260925 B04, three rounds before BL-046.
- Failure read as absence: `OS-20260927` B05 R1–R4, B06's C1 fix-up R5.
- Provenance proven against a point that moves: `OS-20260927` B06 R1 F1, its C1 fix-up's R3 F1 and R4 N1.
- A build gate that proves commits, not the disk, merged into "Verified means verified as published":
  `OS-20261007` C1. An issued input derived from the tree merged there too (above).
- A sweep that asserts inside its loop reports one member: `OS-20261008` C1 Step 12.

Retired because the rule is stated where it is enforced:
- "No test can verify this" is not "no agent can verify this" (BL-016): `protocol.md`'s Runner rule,
  pinned by `tests/protocol-contract.test.cjs`.
- Severity is about behaviour, never about the fence (above): `protocol.md` and the reviewer definition.
- A hooks module spells every `$` call in full, and its pure helpers take data, never `$`:
  `claude plugin validate --strict`, which the suite runs on every plugin directory.
