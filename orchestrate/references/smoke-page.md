# The smoke page — checkpoint hand-over format

Every checkpoint STOP delivers its combined smoke script as an **interactive smoke
page** when the runtime can hand over usable HTML, or as the full plain-text script.
The page provides verdict buttons per step, notes, a progress meter, and a "Copy
results as text" button whose paste is the verdict message.
[smoke-page-template.html](smoke-page-template.html) is the page, verbatim, with
`{{...}}` slots for the run-specific content.

**The template is the settled design — do not restyle, "improve", or re-theme it.**
Format stability is the point: the user learns one sheet and reads every run the same
way. The batch files' smoke steps remain canonical, the committed HTML records the
hand-over, and the user's verdict belongs in PROGRESS. Publisher-specific commands
below stay in this skill reference, which a ledger reaches through its pinned skill
directory; never copy them into a generated ledger contract.

## Delivery across runtimes

Use the newest committed `smoke-*.html` as the delivery base, or this template when
starting a page. Fill and commit `smoke-<Cn>.html`, then use the current runtime's HTML
preview, file hand-over, or publisher. Reuse an existing hosted URL when that runtime
can update it; otherwise hand over the current committed HTML or use §Fallback.
Record the CURRENT URL, ledger-relative HTML path, or `plain text` in PROGRESS's
`**Smoke page**:` line. If delivery moves, retain the previous hosted URL in LOG for
future reuse. A link to an older hosted checkpoint is not a current hand-over.

The template runs without a publisher SDK: browser-local storage is used when
available, and the cloud store is optional. Its bundled cloud adapter uses Claude's
API; other hosts use browser-local saving unless an equivalent adapter is provided.
An HTML preview must allow its script to
run for the buttons to work; otherwise use the full plain-text script. Storage must
be isolated by change and checkpoint: on a host shared by several changes, prefix
`CKPT_KEY` with a unique change key and keep it stable on re-issues. Moving runtimes,
origins, or browsers does not migrate saved verdicts. Refer to the recorded user
verdicts in PROGRESS; never turn missing marks into passes or claim cloud saving when
only browser-local saving is available.

## Claude artifact publishing (optional adapter)

Use this section only when the session has the Claude Artifact tools and the
`artifact-capabilities` skill. Load that skill before publishing; the page uses its
`db` capability. Other runtimes use §Delivery across runtimes and need no Claude APIs.

Keep ONE hosted smoke artifact per change, created at the first checkpoint and
republished to the same URL for later checkpoints and fix-up re-issues. Each checkpoint
replaces its content and uses its own storage key; earlier checkpoints' verdicts stay
in their own database collections. Use the recorded URL (PROGRESS or LOG after a
delivery switch) to resume an existing artifact.

- **First publish**: `capabilities: {db: {}}`, `favicon: "🧪"`, title
  `<Change name> Smoke Run` (stable for the life of the artifact).
- **Republish, same session**: call Artifact again with the same file path — omit
  `favicon` and `capabilities` (both carry forward).
- **Republish, later session**: pass the recorded URL as `url`; the tool requires
  reading the live artifact first (`action: "read"`) — do that, then publish. The
  committed ledger copy (below) is your content base.
- **Optional triage detail**: `Artifact` `read_db`, `db_op: "list"`, collection
  `<ckpt_key>-steps`. Database rows are supporting data, never the user's checkpoint
  verdict by themselves.

## Filling the slots

| Slot | Content |
|---|---|
| `{{PAGE_TITLE}}` | `<Change name> Smoke Run` — never changes across checkpoints |
| `{{EYEBROW}}` | `Checkpoint C<n> · batches B<xx>–B<yy>` |
| `{{HEADLINE}}` | The change, plainly: `<what this pack does> — smoke run` |
| `{{STANDFIRST}}` | At hand-over: step and section counts, then "When you're done — or as soon as something fails — press <strong>Copy results as text</strong> and paste it into the chat." Describe saving as browser-local or cloud-backed only according to what is available. After a run: may summarize the result and any corrected steps. |
| `{{FACTS_HTML}}` | `<div class="fact"><dt>…</dt><dd>…</dd></div>` items: **Branch**, **Version should read** (`0.13.1 <span class="was">0.13.0</span>` — new value, struck-through old), **Tip** (short SHA), **Suite** (e.g. `2249 / 2255 pass`, from the validation run on the integration tip, never a worktree), **Known failures** if any |
| `{{GATE_BODY}}` | Step 0 — see below |
| `{{SECTIONS_JS}}` | The sections array — schema is documented in the template; steps the QA runner already performed carry `pre: {sha, stepRevision, env, evidence}` |
| `{{CKPT_KEY}}` | Stable storage key per change and checkpoint: `c1`, `c2`, … on a host isolated to one change, or `<unique-change-key>-c1` on a shared host; used for localStorage and the optional db collection |
| `{{BUILD_SHA}}` | Full integration SHA of the build being tested, before the smoke-page commit; update after a repair, keep it for a cosmetic republish of the same build |
| `{{COPY_HEADER}}` | `C<n> smoke run — <change name> (<version>)` |

Prose fields (`do`, `pass`, `aside`, `lede`, …) are HTML strings inside a JS array:
escape `<`/`>` in literal text as `&lt;`/`&gt;`, use `<strong>` for UI names and the
load-bearing words, `<code>` for exact strings the user must see or type, `<em>` for
error-message quotes.

**Build it from a sidecar, not by hand.** Author the run's content as `smoke-<Cn>.json`
beside the page — the fields above, plus `sections` in the template's schema — and fill
the template mechanically (`<skill-dir>` is the contract's pinned skill directory):

```sh
node "<skill-dir>/tools/build-smoke-page.mjs" <ledger>/smoke-c1.json <ledger>/smoke-c1.html
```

Commit the sidecar next to the page. Before editing a re-issue, save a temporary copy
of the **last issued** sidecar (or recover it from the commit that issued the current
page). Pass that unchanged snapshot when regenerating:

```sh
node "<skill-dir>/tools/build-smoke-page.mjs" <ledger>/smoke-c1.json <ledger>/smoke-c1.html --previous <temp>/smoke-c1.previous.json
```

The builder checks that all existing steps keep their numbers and page order, that
new steps follow them with numbers above the previous maximum, and that no revision
decreases (omitted means 1). Changed step content or shared section context, including
`title`, `lede`, `need`, `order`, and `touchesData`, requires a revision increase for
each affected existing step. Appending steps alone does not invalidate old steps.
Page facts, build SHA, and `pre` evidence metadata can change without a revision bump;
the conductor still identifies **behavior-only changes** and bumps affected revisions.
The builder neither infers code coverage nor claims an agent reran a step.

Overwriting a changed page requires `--previous`; identical rebuilds do not. Generated
pages carry a sidecar fingerprint, so an older or unrelated snapshot is rejected even
if its content checks would pass. JSON formatting and object-key order do not affect
the fingerprint; Git's LF/CRLF conversion is also tolerated. A page from an older
builder without a fingerprint must reproduce from the supplied previous sidecar and
template, apart from LF/CRLF conversion, before it can be reissued.
Use the original template for that first rebuild if necessary. Keep the existing
page at the output path until generation succeeds; if moving paths, copy it there
first so the baseline can be checked. A fresh output path has no prior page to verify.
Validation errors leave the old page intact. Use a new baseline snapshot for each
subsequent re-issue, and commit the current JSON and HTML together.

The builder also rejects known invalid inputs: a short `buildSha`, a storage key that
is not a nonempty string containing only `[A-Za-z0-9._-]`, section or step numbers
that are not positive integers or that repeat
(`1` and `"1"` are one DOM id and one verdict), agent evidence with no `stepRevision` or
with a `sha` under 7 hex characters, a `gate.commands` missing either containment
command or the SHA the sidecar records, any Unicode control character — C0, `DEL` and
C1, the last for the NEL line terminator `U+0085` — other than tab or newline
anywhere in the sidecar (the invisible `U+0000` that made a published command a
`SyntaxError`), and a capitalised `Section N` or `Step N` reference to a section or step
the sidecar does not contain (`Step 0` is the gate). Embedded JavaScript data escapes every `<`, so both
`</script>` and `<!-- <script>` remain data during HTML parsing; the original text and
markup are restored at runtime. Plain names like `Fix "Save as"` also have their quotes
escaped inside JavaScript strings. Slots the
table above documents as HTML (`headline`, `standfirst`, the facts, the gate) keep their
markup. Without Node, or with the sidecar lost, copy the newest committed
`smoke-*.html`, patch the slots by hand, and run `grep -o '{{[A-Z_]\{1,\}}}'` over the
result — zero hits; the page never
depends on the tool that filled it.

**Self-check before publishing**: the builder greps its TEMPLATE for a `{{` that is not
a well-formed slot marker — a lower-case, spaced or hyphenated name it would leave
unfilled — and refuses to write a page from that template, as it refuses a slot the
sidecar cannot fill. It does not grep the filled page: step content may carry `{{` of its
own (a GitHub Actions expression, a Handlebars or Vue binding), which is content and not
a slot. Totals
and the meter compute themselves from the sections array. `BUILD_SHA` must be a full
40- or 64-character hexadecimal Git object ID. The page rejects an invalid or unfilled
identity with a visible correction message: verdict entry and copying stay disabled,
and neither saved records nor the artifact store are accessed.

**Proof the published artifact — an ADDED pass, after the page is built.** The QA
runner's pre-verification happens before the page exists and proves the steps, not the
bytes the reader receives; this pass is additional and changes nothing about when the
runner runs. After the page is generated and before the STOP, open the filled
`smoke-<Cn>.html` **in a browser and read the RENDERED DOM, never the file text** — the
step blocks render client-side from the embedded `SECTIONS_JS` JSON, so a static read or
grep of the file finds only the gate's blocks — read each `<pre><code>` block's
`textContent`, and run exactly those bytes in the reader's shell. **A command is
verified only when it has been executed in
the form the reader receives it** — not from the sidecar, not from the batch file, not
from the shell it was composed in. A command that was re-authored on its way into the
artifact is an unverified command, however carefully it was checked before. It has
happened: a pre-verified markdown draft was re-authored into the required HTML and
issued without anyone running it in that form, and it could not run as published.
Author every embedded command with **no backslashes and no control characters**, so no
transport between sidecar, HTML and clipboard can mangle it; the builder refuses a
sidecar carrying any Unicode control character other than tab or newline. Where the output is too
long for a person to check, have the command report the answer instead of the data.

## The gate (Step 0)

`{{GATE_BODY}}` is the build-identity gate from `execution-models.md`, rendered as
`<p class="gate-eyebrow">Before anything else</p>`, an `<h3>` ("Step 0 — prove you are
on the right build"), prose + `<pre><code>` command blocks, and an
`<ol class="gate-checks">` of numbered checks. Its `<pre><code>` blocks carry the
containment commands that file specifies: they are RUN, not read, and the builder
refuses a gate that omits them. It is NOT a verdict step — it decides
whether the run means anything. It must contain, in order:

1. Any "fully quit the app first" instruction the smoke procedure implies (testing a
   still-running old instance has cost runs before).
2. The exact fetch/checkout commands for the integration branch, in the user's shell
   dialect, including known gotchas (e.g. an untracked ledger copy blocking checkout).
3. The command that prints the current branch, and what it must print.
4. **The containment check**, in `gate.commands` where it EXECUTES — never a check
   asking the user to compare two SHAs by eye, because committing this page moves
   `HEAD` past the build it describes and the two can never agree:
   `git merge-base --is-ancestor <buildSha> HEAD` (must exit 0) and
   `git diff --name-only <buildSha>..HEAD -- . ":(exclude).agents/"` (must print
   NOTHING — the pathspec excludes the ledger, so empty output is the verdict rather
   than a list to read). Write the tested SHA out in both; the builder rejects a gate
   that omits either command or that SHA.
5. The version the user should see and where (`Help → About reads 0.13.1; if it reads
   0.13.0, stop — the checkout did not take`).
6. **The canary**: one cheap check whose result is OPPOSITE on the base build, with
   "if it behaves the old way, stop and say so."

## Assembling the sections

Source of truth: the covered batches' `## Smoke (checkpoint)` sections, whose steps
are authored in the page's field vocabulary (`Do` / `Pass` / optional `Aside`,
`Counting`, `Tag`, and section-level `You need` / `Order matters` / `Touches your
data`). Assembly is mechanical:

- One section per user-facing theme — usually one per batch; merge tiny related
  batches into one section rather than shipping two-step sections.
- Initial order: data-touching sections first (migrations, anything against real data), then
  the remaining hands-on work, then everything else. Number steps continuously across
  the whole page — never per section.
- Section-level `need`/`order` callouts carry preconditions (test data, hardware,
  cross-step ordering); a step is one action with its acceptance criterion in `pass`,
  kept apart from `do`.
- Where a `pass` checks a number, the step's `unit` defines ONE unit in the user's
  words ("One unit = one purchase order"). Ambiguous counts turn verdicts into prose.
- Each step has a positive integer `revision` (initially 1; omitted means 1). Keep
  its number across re-issues. Keep its revision unless its instructions, acceptance
  criterion, section context or covered behavior changed; then increment the revision.
  Keep earlier revision increments on later re-issues, even when the step is unaffected
  this time.

## Input registry and immutable issue files

The conductor supplies actual generated, independently validated files. Inventory
them at planning, including workbook sheets/columns/types/formulas/edge cases, then
deliver the exact files at close-out with expected results and working-copy/reset
instructions. Private-data, credential and external-access dependencies are named
in `need`/`aside`, never represented by fictitious files or pre-verification. Ordinary
synthetic preparation adds no approval gate; manual construction is only a test when
construction itself is the behavior being checked.

Add this structure to the sidecar (the digest/size values below are explanatory;
fill them from the actual file Buffers, and retain a real validation report):

```json
{
  "inputs": [{
    "id": "orders",
    "path": "evidence/C1/inputs/issue-001/orders.xlsx",
    "sha256": "<64 lowercase hex characters from raw file bytes>",
    "size": 8634,
    "requirements": "Orders, Summary, Types; IDs remain text; formulas F2:F5; total 23.50 and count 4.",
    "validation": {
      "path": "evidence/C1/inputs/validation-001/independent-check.md",
      "sha256": "<raw validation-report digest>",
      "size": 123,
      "command": "python evidence/C1/inputs/issue-001/validate-orders.py evidence/C1/inputs/issue-001/orders.xlsx evidence/C1/inputs/issue-001/orders.requirements.json",
      "exitCode": 0,
      "result": "Independent sheets, cell types, formulas and cached values passed.",
      "env": "Observed Python and openpyxl versions recorded in the report"
    },
    "mode": "working-copy",
    "use": "Copy-Item -LiteralPath evidence/C1/inputs/issue-001/orders.xlsx -Destination $env:TEMP/OS-orders-working.xlsx; open that copy and change Orders C2 from 2 to 3.",
    "reset": "Close the working copy and repeat Copy-Item with -Force. Original F2/Summary B2 are 22.50/23.50; edited copy is 33.75/34.75."
  }],
  "inputHistory": [],
  "sections": [{"n": 1, "title": "Workbook", "steps": [
    {"n": 1, "revision": 1, "do": "Open the supplied workbook copy.",
     "pass": "All three sheets and leading-zero IDs are visible.", "inputs": ["orders"]}
  ]}]
}
```

The registry is an array with unique stable IDs. A step's `inputs` is an array of
those IDs, with no duplicates or dangling references. Every input needs path,
lowercase raw SHA-256, nonnegative byte size, nonempty requirements, validation
path/hash/size/command/result/env and exitCode 0, mode (`read-only` or `working-copy`),
use and reset. Even read-only files name a reset rule, such as "Keep the issued file
unchanged; recopy a disposable copy from this original." Shared validation reports
are allowed. `inputFiles` is reserved for the builder's resolved display data.

Paths are slash-separated relative file paths from the output HTML's directory.
The CLI validates **actual disk bytes**, including validation evidence and historical
files, before any output write. Imported calls must pass
`buildSmokePage(data, template, {inputRoot, previous, resetVerdicts})` with explicit
`inputRoot` whenever declarations exist. Pure declaration/history inspection lives
in `smoke-inputs.mjs`; it does not pretend a temporary previous-sidecar directory is
the original input root. Missing files, directories, absolute/traversal paths,
Windows aliases and symlinks are rejected. Hash raw Buffers: no text decoding,
line-ending normalization, trimming, BOM removal or Git object-ID substitution.
Legacy sidecars with omitted/empty registries and no references remain compatible.

On each reissue keep the unchanged previous sidecar and page snapshot. Changed bytes
require new versioned paths, such as `issue-002/orders.xlsx`. In `inputHistory`, retain
`{path, sha256, size}` for every prior input or validation file no longer present in
current declarations, and carry older history forward. The builder refuses reused
paths with different byte identities, omitted history, or missing historical files.
Reusing the same unchanged file is allowed; never overwrite/delete issued originals.

Every referencing existing step must increase its revision when resolved input
metadata changes (bytes/digest/size, path, requirements, validation, mode, use or reset),
even if its stable ID and build SHA stay unchanged. Unrelated steps keep their
revisions and marks. The page then labels old affected passes `NOT RE-RUN`; merely
editing a note cannot refresh them. New applicable human verdicts or agent evidence
are still required. Registry edits cannot bypass revision checks by keeping IDs.

The existing step layout displays encoded file/evidence links, requirements,
hash/size and use/reset text. Copied results and a full plain-text fallback name the
same files and instructions. Keep HTML and inputs usable together; browser QA checks
the links. A hosted renderer that cannot serve relative files needs separate usable
attachments/local links and an explicit mapping. Never call an inaccessible URL a
download. Native Excel opening remains human unless a real spreadsheet runner exists.

Use the fixed `tests/fixtures/smoke-inputs/orders.xlsx`, requirements, generator and
validator for a concrete example. Run literal `python` generation to new paths and
independent semantic validation; do not infer sheets/formulas/caches from a hash.
Detect and record the interpreter environment in the ledger; never hardcode a local
installation path into reusable instructions. Preserve input and evidence bytes with
the scoped `.gitattributes`; verify effective attributes and a fresh
`core.autocrlf=true` checkout (including LF/CRLF sentinels and an unprotected conversion
control). Actual Excel values and validation recipes are in protocol.md.

## Pre-verified steps

Before the page is issued, the QA runner (`subagent-prompts.md`) performs every step
tagged `Runner: agent` on the integration tip and writes `evidence/C<n>/step-NN.md`
(command, exit, output tail or screenshot path, integration SHA, step revision,
environment, verdict). Include the page's step number and revision in the runner's
input. Steps it PASSED get `pre: { sha, stepRevision, env, evidence }` in the sections
array: `sha` is the tested build's full SHA or an unambiguous prefix of at least seven
hex characters; `stepRevision` is the positive integer revision actually tested.
Keep those values with the original evidence across re-issues; never update them to
the new page's values without a new successful run.

The page accepts pre-verification only when `stepRevision` matches the step's current
revision and SHA, environment, and evidence path are populated and valid. Evidence
from another build with the same revision stays applicable and is labeled
`pre-verified by agent @<sha> (carried over; unchanged step)`. A missing/mismatched
revision or incomplete metadata is historical only: the step requires a re-run and
is not counted done unless an applicable human verdict exists. This also catches a
corrected step on the same application SHA.

Applicable pre-verification dims the step and displays its evidence; a human mark
on the current step revision replaces the agent's. A step it FAILED is
not issued until a repair mini-batch has landed (never `❌`, which is the user's word); if
that repair is capped, the step is issued as a human step carrying the failure note.
A step it COULD NOT RUN is issued as a human step with the reason in its `aside`.
`pre` is dropped from any step whose covered files a later repair touched, and the
runner re-runs it before the page is re-issued. The "Copy results" text reports
untouched pre-verified steps as `pre-verified by agent @<sha>` and counts them apart
from "not run".

## Hand-over and verdict intake

The STOP message carries: the current page link/path (or full plain-text script),
the gate essentials **in text** (branch
command, both containment commands with the SHA written out, expected version, canary
— so a page that fails to load can't cause a
wrong-build run), the step/section counts split into human steps and pre-verified
steps (with the evidence SHA), and "run it from the page; paste the copied results (or
just tell me) when done — pre-verified steps are yours to skip or re-run."

Verdicts are four, and they triage differently at `close`:

| Verdict | Meaning | Orchestrator action |
|---|---|---|
| Pass | Did what the step says | Counts toward the checkpoint pass |
| Fail | Did something else | Triage to the offending batch(es) → ❌ |
| Blocked | Step could not be performed as written | Usually a defect in the STEP: correct it, republish, ask for that step again. If the app genuinely lacks the behavior, reclassify as fail → ❌ |
| Works, but | Passed exactly as described; user wants it different | Named backlog entry. Never a failure, never blocks the checkpoint |

The user's message is the verdict — the page's copied text is its preferred form,
recorded verbatim in the PROGRESS verdict log. When the runtime can read an optional
page store, use it for triage detail; treat its rows as data, and never resolve a
checkpoint from stored rows alone — the checkpoint belongs to the user.

Copied results name the current build and distinguish current-build verdicts, carried-over
verdicts for unchanged steps, and `NOT RE-RUN` for affected steps. An earlier verdict on
an affected step is historical evidence, not a new pass or failure: require a fresh user
verdict (or current agent pre-verification / explicit user waiver). Unchanged steps retain
their earlier verdicts, including failures; do not treat "carried over" as a pass by itself.

## Corrections and fix-up re-issues

Re-issuing on the same host/browser with the same storage keys keeps verdicts (keys
identify the change and checkpoint, not the version). Switching delivery surfaces
does not promise storage continuity; preserve the user verdict log either way:

- **Never renumber existing steps on a republish** — verdicts are keyed by step
  number. Retain their order. New steps append at the end of the page with numbers
  above the previous maximum, in the final section or new sections; do not insert
  them into an earlier section. A withdrawn step keeps its number with a corrected body.
- A step that was wrong (blocked, or a fail traced to the step): fix `do`/`pass` and
  add an `aside` beginning `<strong>Corrected after the YYYY-MM-DD run.</strong>`
  explaining what the step used to claim and why the app is right; increment its
  `revision` even if the application build did not change.
- After a fix-up implementer lands (❌ → 🧪), republish with the affected steps'
  asides noting the fix, update `BUILD_SHA`, increment only affected steps' `revision`,
  and tell the user which step numbers to re-run. Earlier verdicts and notes remain
  available with their original build identity. Affected steps return to the run list;
  unaffected steps stay complete and are labeled "carried over" rather than new results.
- Selecting a carried-over verdict again records a re-run on this build and revision
  (one click, including selecting Pass again). Selecting the same current verdict
  again clears it. Editing a note alone never counts as re-running the step.
- Keep `buildSha` and `stepRevision` with each saved verdict in localStorage and the
  optional page database. Records with missing or invalid provenance require
  re-verification; never silently stamp them as results from the current build.
- A genuinely clean sheet (user asks to re-run everything fresh): suffix the key
  (`c1r2`) so old verdicts stop loading, and pass `--reset-verdicts` along with
  `--previous`. This permits only the intentional key change; step numbering and
  revision checks still apply. Otherwise keep the key stable.

## Verdict synchronization

Each local verdict selection, clear, or note edit records `at` immediately in
localStorage. This ISO timestamp advances beyond the step's previous timestamp and
any remote update observed while editing, even for edits within one millisecond or
a clock that moved backwards. Database writes send that same `at`; sending a delayed
note must not make the observation appear newer than it is.

Snapshots replace a step only when their `at` is strictly newer. Older or equal
timestamps keep the local record, and an unchanged snapshot does not rewrite
localStorage. Missing/malformed timestamps can populate an empty browser but cannot
overwrite an existing record. Treat status, note, build SHA, revision, and timestamp
as one record. While a note has focus, defer a newer remote record until blur; cancel
the superseded pending note upload, then apply whichever whole record is newer.
Further typing advances the local timestamp beyond the deferred update. Equal-time
conflicts retain the local record; timestamp ordering does not establish real-world
edit order between independently clocked devices.

## Ledger copy

Write the filled page into the ledger as `smoke-<Cn>.html` and commit it in the
per-checkpoint close-out commit (update it on corrections). It is the audit copy of
what the user actually ran, and the republish base for any later session — including
one that has not loaded this skill, which can edit it directly and republish, or fall
back to text.

## Fallback

A session without usable HTML delivery or a page/template prints the full combined script as plain text
(gate first, same section order, `Do`/`Pass` per step, pre-verified steps marked
`[pre-verified by agent @sha — evidence path]`, with carried-over results identified).
Missing publisher/storage tools never block this hand-over. The batch files' smoke
steps stay canonical; the verdict is the user's message recorded in PROGRESS.
