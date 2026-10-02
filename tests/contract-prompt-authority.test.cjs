const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const ROOT = path.resolve(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const TEMPLATE = 'orchestrate/templates/00-READBEFORE.md';
// The literal the old boot paragraph used to send implementers into the ~20k-token
// contract. Its absence from the template and its survival in the archived ledger are
// the two halves of this suite.
const OLD_BOOT_INSTRUCTION = 'read this file + your';
// The distinctive phrase of the replacement paragraph. It tells a contract filled from
// the new template apart from one filled from the old.
const NEW_BOOT_MARKER = 'your spawn prompt is authoritative';
const template = read(TEMPLATE);
// Anchor every claim to the implementer paragraph itself — it sits between the
// orchestrator's boot sequence and the roles section — so a coincidental match
// elsewhere in the contract cannot satisfy these assertions. Whitespace is
// flattened because the paragraph is hard-wrapped.
const paragraphStart = template.indexOf('Implementer sub-agents:');
const paragraphEnd = template.indexOf('## Roles, gates, tiers');
assert.ok(paragraphStart >= 0, TEMPLATE + ' must keep an "Implementer sub-agents:" paragraph');
assert.ok(paragraphEnd > paragraphStart, TEMPLATE + ' must keep that paragraph above "## Roles, gates, tiers"');
const implementerParagraph = template.slice(paragraphStart, paragraphEnd).replace(/\s+/g, ' ').trim();
// This prose IS the production artifact, so it is pinned verbatim rather than sampled.
// Positive substring matches cannot catch an ADDITION: one appended sentence — "Even so,
// skim this contract end to end before you start." — satisfies every assertion below
// while destroying the ~20k-per-implementer saving this change exists to deliver. The
// repo already pins load-bearing procedure text for exactly this reason
// (tests/protocol-contract.test.cjs sha256-pins protocol.md's decision tables). Rewording the
// paragraph on purpose means updating this constant; that is the intent, not brittleness.
const EXPECTED_PARAGRAPH = [
  'Implementer sub-agents: **your spawn prompt is authoritative.** It is self-contained —',
  "it carries your batch's full text plus every contract excerpt that binds you (file fence,",
  'conventions, guardrails, prohibitions, validation commands), so do NOT read this contract',
  'at boot. Consult it only if the prompt is incomplete, contradicts itself, or is missing a',
  'fact the work needs, and then read only the section you need. Work ONLY in the worktree',
  'your prompt names. Your batch file carries the full spec text and codebase facts — it is',
  'authoritative for scope. Do NOT re-derive scope from the original request or any external',
  'document.',
].join(' ');
// Filled ledger contracts live under whichever root the ledger currently occupies;
// archival moves one from changes/ to archive/. Discover them instead of naming a path —
// the hardcoded path in tests/protocol-contract.test.cjs:122 went stale that way and its
// assertions have been silently dead since the OS-20260918 ledger was archived.
const LEDGER_ROOTS = ['.agents/archive', '.agents/changes'];
// Ledgers scaffolded BEFORE this change filled their contract from the old template and
// must keep that wording: a filled contract records the protocol its change actually ran
// under, and a template edit reaches new ledgers only. Ledgers scaffolded afterwards will
// legitimately carry the new wording, so they are checked for consistency, not for a
// specific paragraph.
const PRE_CHANGE_LEDGERS = ['OS-20260918-readonly-evidence-smoke-inputs', 'OS-20260919-agent-tool-restrictions'];

function ledgerContracts() {
  const found = new Map();
  for (const root of LEDGER_ROOTS) {
    const dir = path.join(ROOT, root);
    if (!fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const file = path.join(dir, entry.name, '00-READBEFORE.md');
      if (!fs.existsSync(file)) continue;
      found.set(entry.name, { rel: root + '/' + entry.name + '/00-READBEFORE.md', text: fs.readFileSync(file, 'utf8') });
    }
  }
  return found;
}

test('the contract no longer sends implementers to read the contract at boot', () => {
  assert.ok(!template.includes(OLD_BOOT_INSTRUCTION),
    TEMPLATE + ' must not tell implementers to "' + OLD_BOOT_INSTRUCTION + '" — their prompt carries every excerpt that binds them');
});

test('the implementer paragraph makes the spawn prompt authoritative and the contract on-demand', () => {
  assert.match(implementerParagraph, /your spawn prompt is authoritative/,
    'the paragraph must name the spawn prompt as authoritative');
  assert.match(implementerParagraph, /self-contained/,
    'the paragraph must say the prompt is self-contained');
  assert.match(implementerParagraph, /do NOT read this contract at boot/,
    'the paragraph must rule the contract out as a boot-time read');
  assert.match(implementerParagraph, /Consult it only if the prompt is/,
    'the paragraph must make consulting the contract conditional on the prompt falling short');
  for (const shortfall of [/incomplete/, /contradicts itself/, /missing a fact the work needs/]) {
    assert.match(implementerParagraph, shortfall,
      'the paragraph must name each condition that justifies consulting the contract');
  }
  assert.match(implementerParagraph, /read only the section you need/,
    'consulting the contract must mean a targeted read, not an end-to-end one');
});

test('the constraints the old boot paragraph carried survive the rewrite', () => {
  assert.match(implementerParagraph, /[Ww]ork ONLY in the worktree your prompt names/,
    'the worktree restriction must survive');
  assert.match(implementerParagraph, /batch file carries the full spec text and codebase facts/,
    'the batch file must still be named as the carrier of spec text and codebase facts');
  assert.match(implementerParagraph, /authoritative for scope/,
    'the batch file must still be authoritative for scope');
  assert.match(implementerParagraph, /Do NOT re-derive scope from the original request or any external document/,
    'the ban on re-deriving scope from the request or an external document must survive');
});

test('the implementer paragraph is pinned verbatim, so additions are production changes', () => {
  assert.equal(implementerParagraph, EXPECTED_PARAGRAPH,
    'the implementer paragraph changed; update EXPECTED_PARAGRAPH only if the change is deliberate');
});

test('no other passage sends a sub-agent through the contract in full', () => {
  // The pin above guards the paragraph. It cannot see a directive added ELSEWHERE in the
  // file — "Sub-agents: read this whole file first." two lines from the top would
  // reinstate the boot read while every other assertion here still passed.
  const rest = template.slice(0, paragraphStart) + template.slice(paragraphEnd);
  for (const directive of [
    /\bread\s+(?:this|the)\s+(?:whole\s+|entire\s+|full\s+|complete\s+)?(?:file|contract)\b/i,
    /\b(?:skim|study|review|consume|digest)\s+(?:this|the)\s+(?:whole\s+|entire\s+|full\s+)?(?:file|contract)\b/i,
    /\bread\b[^.\n]{0,40}\b(?:in full|end[- ]to[- ]end|cover to cover|from top to bottom)\b/i,
  ]) {
    assert.doesNotMatch(rest, directive,
      TEMPLATE + ' must not reinstate a boot-time full read outside the implementer paragraph');
  }
});

test('filled ledger contracts are never rewritten by a template edit', () => {
  const contracts = ledgerContracts();
  for (const id of PRE_CHANGE_LEDGERS) {
    // Ledgers are branch-local; an ordinary clone need not carry one, so only assert on
    // what is actually on disk.
    if (!contracts.has(id)) continue;
    const { rel, text } = contracts.get(id);
    assert.ok(text.includes(OLD_BOOT_INSTRUCTION),
      rel + ' predates this change and must keep its original boot wording');
  }
  for (const { rel, text } of contracts.values()) {
    // Exactly one wording, never both (a half-applied sweep) and never neither (a gutted
    // paragraph) — the check that still holds for ledgers scaffolded after this change.
    assert.ok(text.includes(OLD_BOOT_INSTRUCTION) !== text.includes(NEW_BOOT_MARKER),
      rel + ' must carry exactly one boot wording — a mix means a template edit bled into a filled contract');
  }
});
