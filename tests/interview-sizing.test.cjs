const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const SCAFFOLDING = 'orchestrate/references/scaffolding.md';
const SKILL = 'orchestrate/SKILL.md';
const TEMPLATE_CONTRACT = 'orchestrate/templates/00-READBEFORE.md';
// The surviving interview topics, written out here and nowhere derived: an edit that
// changes both the documents and this list still has to get past the size assertions
// below, which are properties of THIS list, not of what the sweep happened to find.
const TOPICS = [1, 2, 3, 4, 6, 7];
// Collapsed whitespace, so a wrapped reintroduction is caught as surely as a one-line
// one. Every scan in this file runs on collapsed text; ~90-column wrapping is this
// repository's own convention, so the wrapped form is the likely one.
const collapse = text => text.replace(/\s+/g, ' ');
// Placeholder NAMES are identifiers, not directives: `{{MERGE_POLICY}}` is a slot in
// the generated contract, not an instruction to merge anything. They are neutralised
// before the contradiction sweep so the sweep can key on ordinary English stems.
const sweepText = text => collapse(text.replace(/\{\{[A-Z_]+\}\}/g, ' {{PLACEHOLDER}} '));
const section = (text, heading) => {
  const start = text.indexOf(heading);
  assert.notEqual(start, -1, 'section heading not found: ' + heading);
  const next = text.indexOf('\n## ', start + heading.length);
  return text.slice(start, next === -1 ? text.length : next);
};

// Files the skill SHIPS, and files the repository carries. The sizing rule is set by
// all of `orchestrate/**` — a revived single-round directive in protocol.md or in the
// generated contract template governs behaviour exactly as one in scaffolding.md does —
// so the contradiction sweeps run over the whole skill, not over the two edited files.
// `.agents/` is excluded everywhere on purpose: those ledgers are historical records
// that quote the removed text verbatim and are never rewritten.
const BINARY = /\.(?:xlsx|xls|png|jpe?g|gif|ico|pdf|zip|gz|woff2?|ttf|eot|exe|dll)$/i;
function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : 1)) {
    if (entry.name === '.git' || entry.name === '.agents' || entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (!BINARY.test(entry.name)) out.push(path.relative(ROOT, full).split(path.sep).join('/'));
  }
  return out;
}
const skillFiles = () => walk(path.join(ROOT, 'orchestrate'));

test('the merge arithmetic and the single-round promise are gone from the whole skill', () => {
  // A1 + A8, negative. These are the exact strings the batch deleted; re-introducing
  // any of them anywhere in the skill turns this red, wrapped or not.
  const removed = [
    'merged down to its 4-question cap',
    '{1+3, 2+6, 4+7, 5}',
    '4-question',
    'fit in one AskUserQuestion call',
    'ONE consolidated interview round',
    'ONE consolidated AskUserQuestion round',
  ];
  const files = skillFiles();
  assert.ok(files.includes(SCAFFOLDING) && files.includes(SKILL) && files.includes(TEMPLATE_CONTRACT),
    'the skill sweep must reach the edited documents and the generated contract template');
  for (const file of files) {
    const text = collapse(read(file));
    for (const literal of removed) {
      assert.ok(!text.includes(literal), file + ': must not contain "' + literal + '"');
    }
  }
});

// Each banned pattern is paired with a specimen it MUST match. The specimens are the
// sentences this batch removed, or the directive that would undo a rule it added, so a
// pattern that has gone blind reports itself before it reports "nothing found". Plain
// English counts: a rule keyed on "merge" is no guard at all against "consolidate",
// "combine", "collapse" — or against re-imposing the arithmetic with no verb at all,
// as a numeric budget.
const CONTRADICTIONS = [
  // A1 — one round, one call, or a question budget by any other name.
  ['a single interview round', /\b(?:one|a single)\s+(?:consolidated\s+)?(?:AskUserQuestion\s+)?(?:interview\s+)?round\b/i,
    'Interview — ONE consolidated AskUserQuestion round covering only the gaps'],
  ['topics squeezed into one call', /\bfits?\b[^.]{0,60}\b(?:one|a single)\b[^.]{0,20}\bcalls?\b/i,
    'Batch it: topics 1-7 fit in one AskUserQuestion call only merged down to its cap'],
  ['topics merged, consolidated, combined or collapsed',
    /\b(?:merg|consolidat|combin|collaps)\w*\b[^.]{0,60}\b(?:topics?|questions?|interview)\b/i,
    'Consolidate all seven topics into a single AskUserQuestion call'],
  // Object first. `interview` is deliberately NOT an object here: this repository's
  // documents legitimately put "interview #4" a few words from a git "merge".
  ['topics merged, consolidated, combined or collapsed (reversed)',
    /\b(?:topics?|questions?)\b[^.]{0,60}\b(?:merg|consolidat|combin|collaps)\w*/i,
    'the topics are consolidated into one AskUserQuestion call'],
  ['a second call treated as a defect', /\b(?:second|extra|additional|further)\s+calls?\b[^.]{0,60}\b(?:failure|failing|avoided?|discouraged|last resort)\b/i,
    'issuing a second call is a failure of preparation'],
  ['a question budget, stated as a limit', /\b(?:at most|no more than|never exceed|never ask more than|a maximum of|cap(?:ped)? at|limit(?:ed)? to|budget of)\s+\S+\s+questions?\b/i,
    'Never exceed four questions in total across the whole interview'],
  ['a question budget, stated as a total', /\b\S+\s+questions?\s+(?:in total|in all|overall|across the (?:whole|entire))\b/i,
    'Never exceed four questions in total across the whole interview'],
  // A3 — nothing detection settled, and nothing step 7 will ask, may be asked here.
  // `(?:(?!\bnever\b)[^.])` is a tempered gap: this document states its prohibitions as
  // "never ask what detection already answered", and a sweep that fires on the
  // prohibition itself would have to be deleted rather than fixed.
  ['re-asking what step 7 asks',
    /\b(?:wave map|checkpoint placement|batch weights?)\b(?:(?!\bnever\b)[^.]){0,80}\bask\w*\b(?:(?!\bnever\b)[^.]){0,60}\binterview\b/i,
    'When the wave map is unclear, ask about it in the interview as well'],
  ['re-asking what detection answered',
    /\bdetect\w*\b(?:(?!\bnever\b)[^.]){0,80}\bask\b(?:(?!\bnever\b)[^.]){0,80}\b(?:again|anyway|regardless|in the interview)\b/i,
    'Where detection is uncertain, ask the question again in the interview rather than presenting it'],
  // A4 — a repeat repo reads the previous contract instead of re-interviewing.
  ['prior ledgers ignored', /\b(?:ignor|disregard|skip)\w*\b[^.]{0,40}\b(?:prior|previous|earlier|existing)\s+ledgers?\b/i,
    'Ignore prior ledgers; always run the full interview from scratch'],
  ['the interview re-run from scratch', /\binterview\b[^.]{0,40}\bfrom scratch\b/i,
    'Ignore prior ledgers; always run the full interview from scratch'],
  // A5 — the cap is on repeats: no decision is reopened at approval or at close-out.
  ['a decision reopened at approval or close-out', /\b(?:re-?ask|re-?confirm|reconfirm|revisit|re-?open)\w*\b[^.]{0,80}\b(?:approv|close-?out)/i,
    'Revisit every interview answer at close-out'],
  ['approval or close-out that reopens a decision', /\b(?:approv\w*|close-?out)\b[^.]{0,80}\b(?:re-?ask|re-?confirm|reconfirm|revisit|re-?open)\w*/i,
    'at plan approval, re-ask anything the user may have changed their mind about'],
  ['a decision asked a second time', /\bask\w*\b[^.]{0,60}\b(?:a second time|twice|again)\b[^.]{0,60}\b(?:approv|close-?out)/i,
    'Ask each interview decision a second time when the plan is approved'],
];

test('every contradiction pattern can still fire on the directive it was written to catch', () => {
  // The live control, kept as its own test so a blind pattern is named on its own line
  // rather than hidden behind the first sweep failure.
  for (const [name, pattern, specimen] of CONTRADICTIONS) {
    assert.match(specimen, pattern, 'the sweep for "' + name + '" must fire on its own specimen');
  }
  assert.equal(new Set(CONTRADICTIONS.map(c => c[0])).size, CONTRADICTIONS.length, 'sweep names are unique');
});

test('no surviving directive anywhere in the skill contradicts the sizing rule', () => {
  // A1-A5, negative. This is the entire defence against a later appended sentence, so
  // it runs over every file the skill ships, collapsed.
  const files = skillFiles();
  assert.ok(files.length > 10, 'the sweep must walk the skill tree, not a single file');
  for (const file of files) {
    const text = sweepText(read(file));
    for (const [name, pattern] of CONTRADICTIONS) {
      assert.doesNotMatch(text, pattern, file + ': surviving directive — ' + name);
    }
  }
});

test('back-to-back calls are the default and four is the schema cap, not a budget', () => {
  // A1, positive, at all three entry points a reader can stop at.
  const text = collapse(read(SCAFFOLDING));
  assert.match(text, /Back-to-back AskUserQuestion calls are the DEFAULT/);
  assert.match(text, /one question per decision that can independently change the plan/);
  assert.match(text, /four questions per call is the tool's schema cap on `questions`, not a budget/);
  assert.match(text, /issue as many calls as the open gaps need/);
  assert.match(text, /2\. \*\*Interview\*\* — back-to-back AskUserQuestion calls, as many as the open gaps need/);
  assert.ok(read(SCAFFOLDING).includes('## Interview (back-to-back AskUserQuestion calls — confirmations + gaps only)'),
    SCAFFOLDING + ': the Interview heading must name back-to-back calls and keep "confirmations + gaps only"');
  // A8, positive: deleting SKILL.md's clause outright must not be silent — the
  // scaffolding pipeline would then name no interview step at all.
  assert.match(collapse(read(SKILL)),
    /→ interview \(back-to-back AskUserQuestion calls, as many as the gaps need\) → plan the batches/);
});

// An option label is short and carries no sentence punctuation; a quoted sentence of
// prose is neither. Collapsing first is what makes a label wrapped across two source
// lines — the likely form at this repository's ~90 columns — visible to the scan.
const compoundLabels = sectionText => [...collapse(sectionText).matchAll(/"[^"]{1,120}"/g)]
  .map(m => m[0])
  .filter(label => / \+ | and /.test(label))
  .filter(label => label.length <= 60 && !/[.,;?]/.test(label));

test('the compound-label scan catches both banned forms, wrapped or inline', () => {
  // Live control for A2: the scan is run against the two mutations it exists to catch,
  // one of them wrapped over a line break, plus a prose quotation it must ignore.
  const specimen = [
    'Options are "Stop at integration +',
    'test-hunter" and "Full recipe and agent-run smoke", while the prose quotation',
    '"on for the next ledger once this one\'s metrics token has shown review time, false',
    'stops and human smoke minutes." is not a label at all.',
  ].join('\n');
  assert.deepEqual(compoundLabels(specimen),
    ['"Stop at integration + test-hunter"', '"Full recipe and agent-run smoke"']);
});

test('compound option labels are banned and the ban is illustrated, not described', () => {
  // A2. The example is the rule: a machine-read convention shown, not summarised.
  const text = collapse(read(SCAFFOLDING));
  assert.match(text, /Never join two independent axes in one option LABEL/);
  assert.match(text, /a `\+` or an `and` in a label is the smell/);
  assert.match(text, /One axis per question, one axis per label/);
  // Scoped to the section that describes the questions: the only label joining two axes
  // there is the banned specimen itself. Zero matches is a failure too — the rule has to
  // be SHOWN, and on the base there were none at all.
  assert.deepEqual(compoundLabels(section(read(SCAFFOLDING), '## Interview (')),
    ['"Full recipe + agent-run smoke"']);
});

test('"confirmations + gaps only" is load-bearing: detection and step 7 are off limits', () => {
  // A3. This is what bounds the question count once the arithmetic is gone.
  const text = collapse(read(SCAFFOLDING));
  assert.match(text, /`confirmations \+ gaps only` is what bounds the count/);
  assert.match(text, /never ask what detection already answered/);
  assert.match(text, /never ask what procedure step 7 will ask again \(plan, wave map, weights, checkpoints, fold-ins\)/);
  // The detection table it defers to must still exist, or the rule is vacuous.
  assert.ok(read(SCAFFOLDING).includes('## Detection heuristics (run before asking anything)'),
    SCAFFOLDING + ': the detection heuristics section the rule defers to must exist');
});

test('a repeat repo collapses the round from the previous ledger contract', () => {
  // A4.
  const text = collapse(read(SCAFFOLDING));
  assert.match(text, /A REPEAT repo needs almost no interview/);
  assert.match(text, /`00-READBEFORE\.md`[^.]{0,120}baked answers[^.]{0,80}defaults/);
  assert.match(text, /a second ledger in the same repository needs one call, or none/);
  // Two anchors the instruction depends on, either of which a later batch could move:
  // the Discovery section that finds the prior ledger, and the template that gives the
  // file its name. Without them the sentence is true when written and false later.
  assert.ok(read(SKILL).includes('## Discovery (every mode starts here)'),
    SKILL + ': §Discovery — the prior-ledger detection this rule relies on — must exist');
  assert.ok(fs.existsSync(path.join(ROOT, TEMPLATE_CONTRACT)),
    TEMPLATE_CONTRACT + ': the interview defaults are read from this file in the previous ledger, so it must still be its name');
});

test('the cap is on REPEATS, not on questions', () => {
  // A5, the counterweight to A1.
  const text = collapse(read(SCAFFOLDING));
  assert.match(text, /Cap REPEATS, not questions/);
  assert.match(text, /Each decision is asked ONCE, its answer recorded verbatim in `00-request\.md`/);
  assert.match(text, /never re-litigated at plan approval or at close-out/);
});

test('interview topic 5 has moved into procedure step 7, with no pointer left behind', () => {
  // A6. Numbers are load-bearing: the list runs 1,2,3,4,6,7 with 5 simply absent.
  const scaffolding = read(SCAFFOLDING);
  const interview = section(scaffolding, '## Interview (');
  const listEnd = interview.indexOf("**Defaults for a repo's FIRST ledger");
  assert.notEqual(listEnd, -1, SCAFFOLDING + ': the topic list must end at the FIRST-ledger defaults paragraph');
  const topicList = interview.slice(0, listEnd);
  const numbers = [...topicList.matchAll(/^(\d+)\. \*\*/gm)].map(m => Number(m[1]));
  assert.deepEqual(numbers, TOPICS);
  // Properties of the expected list itself, not of `numbers`: an edit that moves the
  // documents and this file together still has to survive them.
  assert.equal(TOPICS.length, 6, 'six interview topics survive the move');
  assert.ok(!TOPICS.includes(5), 'topic 5 is not an interview topic any more');
  // No pointer row survives in the list either: the moved subject is named nowhere in it.
  assert.doesNotMatch(topicList, /wave map/i, SCAFFOLDING + ': no interview topic may mention the wave map');
  assert.doesNotMatch(topicList, /checkpoint placement/i, SCAFFOLDING + ': no interview topic may mention checkpoint placement');

  const procedure = section(scaffolding, '## Procedure');
  const stepSeven = procedure.indexOf('7. **Approve**');
  const stepEight = procedure.indexOf('8. **Fill**');
  assert.notEqual(stepSeven, -1, SCAFFOLDING + ': procedure step 7 must be the Approve step');
  assert.notEqual(stepEight, -1, SCAFFOLDING + ': procedure step 8 must be the Fill step');
  assert.ok(stepSeven < stepEight, SCAFFOLDING + ': step 7 must precede step 8');
  const approveText = collapse(procedure.slice(stepSeven, stepEight));
  for (const subject of ['plan', 'wave map', 'weights', 'checkpoints', 'fold-ins']) {
    assert.ok(approveText.includes(subject), SCAFFOLDING + ': step 7 must name ' + subject + ' — reads: ' + approveText);
  }
  assert.match(approveText, /each batch's weight/, SCAFFOLDING + ': step 7 presents each batch’s weight');
  // Step 7 is moved into, never duplicated.
  assert.equal((procedure.match(/^7\. \*\*/gm) || []).length, 1, SCAFFOLDING + ': exactly one procedure step 7');
  assert.equal((scaffolding.match(/\*\*Approve\*\*/g) || []).length, 1, SCAFFOLDING + ': exactly one Approve step');
  // SKILL.md summarises the same approval and must name weights too.
  assert.match(collapse(read(SKILL)), /user approves plan \+ wave map \+ checkpoints \+ weights \+ fold-ins in one pass/);
});

// Which registry row cites which interview topic, pinned row by row. The set of topics
// alone cannot see a single row losing its citation while a sibling row still cites the
// same number, and the registry is the reason the numbering had to be preserved at all.
const REGISTRY_CITATIONS = {
  ID_PREFIX: [6], MAIN_BRANCH: [4], SHIPMENT_SOURCE: [4], SHIPMENT_REF: [4], MERGE_POLICY: [4],
  VALIDATION_COMMANDS: [1], MUTATION_RUNNER: [1], VERSION_FILES: [2], VERSION_BUMP_RULE: [2],
  CHANGELOG_RULE: [2], SMOKE_PROCEDURE: [3], AGENT_RUNNERS: [3], EXTRA_PROHIBITIONS: [7],
  GATE_AGENTS: [7], ROLE_TIERS: [7], CONVERGENCE: [7],
};

test('the EXECUTION_MODEL registry row is repointed in its third column only', () => {
  // A7. The row's shape is what protocol-contract.test.cjs reads; only the source moves.
  const row = read(SCAFFOLDING).split('\n').find(l => l.startsWith('| `{{EXECUTION_MODEL}}`'));
  assert.ok(row, SCAFFOLDING + ': the {{EXECUTION_MODEL}} registry row must exist');
  assert.match(row, /^\| `\{\{[A-Z_]+\}\}` \| template/, 'the row must still parse as a template registry row');
  const cells = row.split('|');
  assert.equal(cells[2].trim(), 'template (READBEFORE, PROGRESS)', 'the second column is unchanged');
  assert.match(cells[3], /procedure step 7/, 'the third column must cite procedure step 7');
  assert.doesNotMatch(cells[3], /interview\s*#/i, 'the third column must no longer cite an interview topic');
});

test('every other registry row still cites the interview topic it always cited', () => {
  // A7, the siblings. Dropping a citation is invisible to a set comparison.
  const rows = read(SCAFFOLDING).split('\n').filter(l => /^\| `\{\{[A-Z_]+\}\}`/.test(l));
  assert.ok(rows.length > 20, SCAFFOLDING + ': the placeholder registry must still be a table of rows');
  const found = {};
  for (const row of rows) {
    const cited = [...row.matchAll(/interview\s*#(\d+)/gi)].map(m => Number(m[1]));
    if (cited.length) found[row.match(/\{\{([A-Z_]+)\}\}/)[1]] = cited;
  }
  assert.deepEqual(found, REGISTRY_CITATIONS);
  assert.equal(Object.keys(REGISTRY_CITATIONS).length, 16, 'sixteen registry rows cite an interview topic');
});

test('every surviving interview-topic citation resolves to a topic that still exists', () => {
  // A7, repository-wide and extension-blind: a citation in the shipped HTML template or
  // in a script dangles exactly as one in Markdown does.
  const files = walk(ROOT);
  assert.ok(files.includes(SCAFFOLDING) && files.includes(SKILL), 'the sweep must reach the edited documents');
  assert.ok(files.includes('orchestrate/references/smoke-page-template.html'),
    'the sweep must reach the shipped HTML template, not only Markdown');
  assert.ok(files.includes('orchestrate/tools/check-fence.mjs'), 'the sweep must reach the shipped tools');
  assert.ok(files.length > 10, 'the sweep must walk the repository, not a single directory');
  const cited = [];
  for (const file of files) {
    for (const match of read(file).matchAll(/interview\s*#(\d+)/gi)) cited.push({ file, topic: Number(match[1]) });
  }
  const topics = [...new Set(cited.map(c => c.topic))].sort((a, b) => a - b);
  assert.deepEqual(topics, TOPICS);
  const dangling = cited.filter(c => !TOPICS.includes(c.topic));
  assert.deepEqual(dangling, []);
  // Every surviving topic is cited in the document that defines it — the check the set
  // comparison above cannot make, since it is built from the citations themselves.
  for (const topic of TOPICS) {
    assert.ok(cited.some(c => c.file === SCAFFOLDING && c.topic === topic),
      SCAFFOLDING + ': interview topic ' + topic + ' must still be cited by the placeholder registry or the preconditions');
  }
});
