# The backlog and rulings forms

A repository's backlog is its to-do list, and its rulings file (`RULINGS.md`) holds the
user's rulings with their reasons. Both are written in the form below, which
`backlog.mjs` reads: what this page shows is what the tool accepts.

## The form line

A file in the backlog form holds this exact line before its first entry:

```text
Form: orchestrate backlog v1
```

A rulings file holds `Form: orchestrate rulings v1` instead. The line tells a file in the
form from one that is not yet: until a backlog gains it, every `backlog.mjs` operation on
that file prints `UNKNOWN` and exits 2. A file with its form line and no entry is an empty
to-do list. Any line but a level-3 heading (`### `) may precede the form line, and the file
holds the form line once; after it come only entries and blank lines.

## A backlog entry

An entry is a level-3 heading `### <id> — <title>` (an em dash), then one line each, in
this order:

- `Kind:` one of `behaviour`, `hygiene`, `coverage`, `decision`, `docs` or `tooling`.
- `Files:` the files a fix would edit, as backtick repository-relative paths, comma-separated.
- `Tests:` the test files that would prove it, the same way, or `none`.
- `Failure:` who sees what, under which condition.
- `Done when:` a condition a reader can check.
- `Since: <YYYY-MM-DD> — <source>`: the date the item was registered, or the date the user
  last kept it; the source names the ledger and the batch or round it came from, or where
  else it came from.

The id is `#` and digits, or a letter, letters and digits, one `-`, `_` or `.`, then digits.
An accepted fold-in's heading ends in the marker `scaffold.mjs` appends to the one line
holding the id, ` Folded into <CHANGE_ID> <Bnn>.`, so an entry never repeats its own id
below its heading.

```markdown
### TD-014 — A cart total drops the discount on a reload
Kind: behaviour
Files: `src/cart/total.js`, `src/cart/store.js`
Tests: `tests/cart/total.test.js`
Failure: a shopper who reloads the cart page with a discount code applied sees the full price, and is charged it.
Done when: a reload with a code applied shows the discounted total, and a test that reloads the store asserts it.
Since: 2026-03-02 — XY-20260301-cart B02 round 1

### TD-015 — The coupon parser's expiry branch is untested Folded into XY-20260310-coupons B01.
Kind: coverage
Files: `tests/coupons/parse.test.js`
Tests: `tests/coupons/parse.test.js`
Failure: a mutant that accepts an expired coupon survives, so a shopper could be charged the discounted price for a coupon past its date and no test would fail.
Done when: a test applies a coupon one day past its date and asserts it is refused.
Since: 2026-03-04 — XY-20260301-cart B03 test hunter
```

A coverage entry names the behaviour a surviving mutant would let through to a user or a
calling module, as the second entry does; "some cells would survive a mutant" is not yet
an entry.

## A ruling

The rulings file holds one entry per ruling: `### <id> — <title>`, then
`Ruling: accepted — <YYYY-MM-DD>` (the gap is real and its exposure is accepted) or
`Ruling: declined — <YYYY-MM-DD>` (not taken up), `Reason:` (the user's words) and
`Files:`, in that order.

```markdown
### RL-003 — A slow cart total on carts of over 500 lines
Ruling: accepted — 2026-04-11
Reason: "no shopper has a cart that size; we accept it"
Files: `src/cart/total.js`

### RL-004 — Rewrite the coupon parser as a grammar
Ruling: declined — 2026-04-12
Reason: "the parser works and nobody asked for it"
Files: `src/coupons/parse.js`
```

A ruling is reconsidered only on new evidence of exposure (a user hit it, a calling module
changed, a smoke step failed), never on a new instance of the same gap.
`node "<skill-dir>/tools/backlog.mjs" rulings --rulings <file> --paths <comma-separated paths>`
lists the rulings on the paths a change edits, one `<id> <accepted|declined> <date>: <shared paths>`
line each; gate prompts never read the rulings file.

## The bar

An item enters the backlog only with `Failure:` and `Done when:` filled in a way a reader
can check; anything below the bar stays in the ledger's `LOG.md`. Works-but verdicts,
request items the change-complete audit finds unimplemented, and P0/P1 defects with a
concrete scenario skip the bar's judgement but still use the form. The bar never lowers a
severity. The procedure that applies it is protocol.md's.

## Packs and expiry

To-do items are counted per production file their `Files:` line names, a production file
being one the `isTestPath` of `failing-on-base.mjs` reads as no test; an item whose `Files:`
are all test paths counts once per test file it names; `decision` items never count. A
folded entry is being worked: it counts toward no pack and never expires, and `check`
still reads it.

- `node "<skill-dir>/tools/backlog.mjs" packs --backlog <file> --threshold <n>` prints
  `PACKS <k> file(s) at or over <n>`, then `PACK <path> <count>: <ids>` for each file whose
  count reaches the threshold.
- `node "<skill-dir>/tools/backlog.mjs" expired --backlog <file> --days <n> --today <YYYY-MM-DD>`
  prints `EXPIRED <k> item(s) older than <n> days`, then `<id> since <date>` for each item
  whose `Since:` date is more than the contract's expiry days before today.
- `node "<skill-dir>/tools/backlog.mjs" check --backlog <file>` prints `BACKLOG OK <n> item(s)`,
  or `BACKLOG FAIL <k> problem(s): …` naming at most ten problems, each by its entry's id
  or its line number, and, past ten, `(+<m> more)` for the rest, exit 1.

Each prints `UNKNOWN <reason>` and exits 2 for a file without its form line or one it
cannot read; outside `check`, one entry that breaks the form does the same, since no count
over the file is then known.
