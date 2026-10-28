# The ruling page — the change-complete ruling step's hand-over

The ruling step (protocol.md, change-complete step 3) puts every
residual of the run on one list the user rules once. The ruling page is that list as a page:
one row per item, its proposal preselected, a choice of outcomes and an optional note per
row, and a **Copy rulings** button whose paste is the user's ruling.
[ruling-page-template.html](ruling-page-template.html) is the page, verbatim, with two
slots; `build-ruling-page.mjs` fills them from the ledger's `ruling.json`.

**The template is the settled design — do not restyle, "improve", or re-theme it.** The
user learns one page and reads every run's list the same way. Never hand-write a ruling
page: a page built by hand carries no fingerprint, so `read` cannot tell its paste from
another page's.

## Outcomes

A row's choices follow from its `kind`; the page offers no others and `read` refuses any
other.

| Kind | Choices | Written by |
|---|---|---|
| `residual` | Fix now (only when `proseOnly`), Register, Accept, Decline, LOG only | Fix now: the ruling sweep (protocol.md); Register: an entry in the contract's backlog file; Accept and Decline: an entry in its rulings file; LOG only: nothing past LOG.md |
| `expired` | Keep, Drop, Accept, Decline | Keep: its `Since:` rewritten; Drop: removed, LOG.md keeping its text; Accept and Decline as above |
| `pack` | Take as a pack, Skip | Take: proposed to the user as a later ledger's batch, never run unasked; Skip: returns only when its file gains an item in a later run |

`proseOnly` marks an item whose fix changes only prose and carries
replacement text a reviewer already checked, as a `SWEEP:` item does: Markdown, or JavaScript whose
only change is to its comments, never a file agents read as instructions. A fix
that changes behaviour is never offered as Fix now: after the final checkpoint it would need
a smoke step of its own. A row with `ruled` (an item the user already ruled earlier in the
run) is shown and takes no outcome.

## Sidecar shape

`ruling.json` in the ledger directory, complete. The builder refuses a sidecar without
`change`, `ledger`, `date` (YYYY-MM-DD, the date its entries carry unless `read` is given
`--today`), `storageKey` (stable for the change; letters, digits, `.`, `_`, `-`), `groups`
or `items`; a group without `key` or `title`; an item without `id`, `kind`, `group`,
`what` or `source`, or without a `proposal` among its choices unless it carries `ruled`;
and any key it does not know. `source` names where the item came from: the LOG.md heading
of a residual, the backlog id and `Since:` date of an expired item, the `backlog.mjs packs`
line of a pack. Optional: `pageTitle`, `eyebrow` and `headline` (the defaults are
`<change> Rulings`, `<ledger> · change-complete ruling step` and `<change>: what the run
set aside`); a group's `blurb`; an item's `detail`, `where`, `proseOnly` and `entry`.

`entry` holds the form's fields (references/backlog.md) for the entry an outcome writes:
`id`, `title`, `kind`, `files`, `tests` (`[]` for `none`), `failure`, `doneWhen` and
`from` (the batch or round the `Since:` source names after the ledger id) for a backlog
entry; `rulingId`, `title` and `files` for a ruling. The proposal's fields are required; fill
the others for any outcome the user may pick instead, or `read --entries` names them as
missing.

```json
{
  "change": "Example change",
  "ledger": "XY-20260301-cart",
  "date": "2026-03-20",
  "storageKey": "xy-cart-rulings",
  "groups": [
    { "key": "fix", "title": "Fix now: one prose sweep before the merge", "blurb": "Comments that say something false; the corrected wording is already reviewed." },
    { "key": "reg", "title": "Real gaps", "blurb": "Each with its suggested fix." },
    { "key": "old", "title": "Expired items", "blurb": "Past the expiry; re-checked against the tip." },
    { "key": "pack", "title": "Packs" },
    { "key": "done", "title": "Already ruled" }
  ],
  "items": [
    { "id": "R01", "kind": "residual", "group": "fix", "proseOnly": true, "proposal": "fix",
      "what": "The cart total's header says every total is rounded", "detail": "A total in a zero-decimal currency is not.",
      "where": "src/cart/total.js · total", "source": "### prose sweep: B02 R1 SWEEP 1" },
    { "id": "R02", "kind": "residual", "group": "reg", "proposal": "register",
      "what": "A cart total drops the discount on a reload", "where": "src/cart/store.js",
      "source": "### residual: B02 R1 — the store reloads without the code",
      "entry": { "id": "TD-016", "rulingId": "RL-005", "title": "A cart total drops the discount on a reload", "kind": "behaviour",
        "files": ["src/cart/total.js", "src/cart/store.js"], "tests": ["tests/cart/total.test.js"],
        "failure": "a shopper who reloads the cart page with a discount code applied sees the full price, and is charged it.",
        "doneWhen": "a reload with a code applied shows the discounted total, and a test that reloads the store asserts it.",
        "from": "B02 round 1" } },
    { "id": "R03", "kind": "residual", "group": "reg", "proposal": "decline",
      "what": "The coupon parser could be a grammar", "source": "### residual: B03 R1 — parser shape",
      "entry": { "rulingId": "RL-006", "title": "Rewrite the coupon parser as a grammar", "files": ["src/coupons/parse.js"] } },
    { "id": "TD-009", "kind": "expired", "group": "old", "proposal": "keep",
      "what": "The receipt footer misaligns on narrow printers", "source": "TD-009, since 2026-01-30" },
    { "id": "P1", "kind": "pack", "group": "pack", "proposal": "skip",
      "what": "src/cart/total.js holds 5 to-do items", "source": "PACK src/cart/total.js 5: TD-004, TD-007, TD-011, TD-014, TD-016" },
    { "id": "SCAN-3", "kind": "residual", "group": "done", "ruled": "Leave open, high priority",
      "what": "A refund can show as not refunded", "source": "### residual: B04 R1 — refund read" }
  ]
}
```

## The commands

`<skill-dir>` is the contract's pinned skill directory.

- `node "<skill-dir>/tools/build-ruling-page.mjs" build <ledger>/ruling.json <ledger>/ruling.html`
  writes the page, naming its page key: the first twelve hex digits of the sidecar's
  fingerprint. JSON formatting and key order do not change it; any other edit does.
- `node "<skill-dir>/tools/build-ruling-page.mjs" list <ledger>/ruling.json` prints the
  `### Ruling list` block, one line per row with its proposal and source, which LOG.md
  commits with the sidecar and the page before the STOP.
- `node "<skill-dir>/tools/build-ruling-page.mjs" read <ledger>/ruling.json <paste file> --entries`
  checks the saved paste: `RULINGS OK` with one line per outcome given (`FIX`, `REGISTER`,
  `ACCEPT`, `DECLINE`, `LOG`, `KEEP`, `DROP`, `TAKE`, `SKIP`, each with its ids), then the
  `CHANGED` and `NOTED` rows and the general `NOTE`; or `RULINGS FAIL` naming each problem, exit 1.
  A paste from another page key (an older issue, or another change's page), a row missing,
  twice or unknown, and an outcome the row does not offer are each refused. `--entries`
  also prints the entries the rulings write, dated `--today <YYYY-MM-DD>` or the sidecar's
  `date`, after `--- backlog entries` and `--- rulings entries`, each read by `backlog.mjs`'s
  own parser first; a ruling's `Reason:` is the row's note, quoted. `ENTRIES FAIL` names each
  one the sidecar cannot fill, exit 1.

An edit to the sidecar after the page went out changes the page key, so the page is rebuilt and
republished and the user's picks start over on the proposals: the page keeps them per page key.

## Delivery

The page needs no publisher SDK and no runtime capability; it saves picks and notes in
browser-local storage under `storageKey` and the page key. With the Claude Artifact tools,
keep ONE hosted ruling page per change, separate from the smoke page: first publish with
`icon: "list"` and the title `<change> Rulings`; a later re-issue republishes to the same
URL. Record the URL in LOG.md beside the `### Ruling list`. Elsewhere, hand over the
committed HTML, or, where no HTML can be handed over, the list printed by `list` in text,
the user ruling in their own words.
