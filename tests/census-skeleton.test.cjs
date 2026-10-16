'use strict';
// The census skeleton's four instruction lines are the user's own words, so the `## Census` section of
// orchestrate/references/subagent-prompts.md is pinned whole, its prompt block is held to the four lines
// verbatim, and the report line's earlier wording, which the fourth line replaced, is held out of every
// tracked file under orchestrate/ and .claude/agents/. Each rule has a live control, and the section's
// CRLF twin must read as its LF original.
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { makeRepo } = require('./support/git-fixture.cjs');

const ROOT = path.resolve(__dirname, '..');
// The one door every file comes through, so a CRLF checkout and an LF one hand each rule the same text.
const readText = file => fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
const PROMPTS = 'orchestrate/references/subagent-prompts.md';
const HEADING = '## Census (scaffold time — read-only)';
const flow = text => text.replace(/\s+/g, ' ').trim();
// The four lines as the user gave them (2026-10-07 and 2026-10-13), whitespace-collapsed.
const LINES = [
  'Open your report with a short list headed "Where the draft is wrong or incomplete": each place the planned change '
    + 'contradicts the code or misses something it must also change, one bullet each with `path:line`, or `none`.',
  "Then, for every file this batch changes, list every test that reads it (search the tests for the file's name), "
    + 'including tests that assert on something unrelated to this batch, and say whether the change could break it.',
  "Then grep the repository's backlog and bug trackers and its old ledgers under `.agents/` for every file this batch "
    + 'changes or depends on and for its main symbols; open the hits, and report any recorded finding, measurement or '
    + 'decision that bears on the planned change.',
  'Report: one bullet per file: `path:line — what — why`. At most 80 lines. Mark as UNVERIFIED anything you did not '
    + 'read in the file it depends on or run yourself, including your own inferences and recommendations, and name the '
    + 'platform of anything you ran.',
];
// The report line's UNVERIFIED rule before 2026-10-13, which the fourth line widened.
const OLD = 'Mark anything you did not verify by opening the file as UNVERIFIED';
// The whole section as its batch shipped it, whitespace-collapsed: the spawn line, the bare-fenced
// prompt block and the prose under it. A sentence added anywhere in the section, a licence to write
// or a line to skip among them, changes it; lineFaults() below names which of the four lines went.
const SECTION = flow([HEADING, '**Spawn with** `subagent_type: census`.', '```',
  'You are a read-only CENSUS agent for ONE planned batch, B[NN] of change [CHANGE_ID], in [REPO_PATH] at [BASE]. '
    + 'Use only Read/Grep/Glob, read-only git and read-only commands; edit nothing, and write only disposable scratch '
    + 'under your session scratchpad.',
  "Never open another agent's prompt or facts file.",
  "THE BATCH'S PLANNED CHANGE: [the draft batch file's planned change]",
  'FACTS TO FIND: [numbered; each names the files and symbols to settle]',
  ...LINES, '```',
  "One census per batch, never one agent for several batches. The report comes back as the agent's final message. "
    + '`scaffolding.md` step 3 says how the orchestrator records its opening list in LOG.md; `protocol.md` §Fence '
    + "changes and §Session algorithm step 4 say when a batch's `census` agent runs again during the run."].join(' '));

// The `## Census` section, from its heading, read outside any fence and found exactly once, to the line
// before the next heading outside a fence; a fault when it cannot be found.
function censusSection(text) {
  const lines = text.split('\n'), headings = [];
  let open = false;
  lines.forEach((line, at) => {
    if (line.startsWith('```')) open = !open;
    else if (!open && line.startsWith('## ')) headings.push(at);
  });
  if (open) return { fault: 'an unbalanced ``` fence' };
  const own = headings.filter(at => lines[at] === HEADING);
  if (own.length !== 1) return { fault: own.length + ' "' + HEADING + '" headings outside a fence, not one' };
  return { section: lines.slice(own[0], headings.find(at => at > own[0]) ?? lines.length).join('\n') };
}

// What the section's prompt block, its first fenced block, lacks of the four lines: each line that is
// not exactly one of the block's whitespace-collapsed paragraphs, once; and, when every line is, a block
// that does not close on the four in the user's order.
function lineFaults(text) {
  const { fault, section } = censusSection(text);
  if (fault) return [fault];
  const lines = section.split('\n'), open = lines.findIndex(line => line.startsWith('```'));
  if (open === -1) return ['no fenced block under "' + HEADING + '"'];
  const close = lines.findIndex((line, at) => at > open && line.startsWith('```'));
  const paragraphs = lines.slice(open + 1, close).join('\n').split(/\n\s*\n/).map(flow).filter(Boolean);
  const faults = LINES.flatMap((line, k) => {
    const count = paragraphs.filter(paragraph => paragraph === line).length;
    return count === 1 ? [] : [missing(k, count)];
  });
  if (!faults.length && paragraphs.slice(-LINES.length).join('\n') !== LINES.join('\n')) faults.push(ORDER);
  return faults;
}
// The two faults lineFaults() reports once the block is found.
const missing = (k, count) => 'line ' + (k + 1) + ' is a paragraph of the block ' + count + ' time(s), not once: ' + LINES[k];
const ORDER = 'the block does not close on the four lines in the user\'s order';

// The section whitespace-collapsed, unless it reads exactly as SECTION: one fault quoting it from just
// before the first place the two differ.
const CHANGED = 'the census section is not SECTION; from just before the first difference it reads: ';
function sectionFaults(text) {
  const { fault, section } = censusSection(text);
  if (fault) return [fault];
  const actual = flow(section);
  if (actual === SECTION) return [];
  let at = 0;
  while (at < actual.length && actual[at] === SECTION[at]) at++;
  return [CHANGED + actual.slice(Math.max(0, at - 30), at + 70)];
}

test('the census prompt block closes on the four lines, verbatim and in the user\'s order, each a paragraph of its own', () => {
  const doc = readText(path.join(ROOT, PROMPTS));
  assert.deepEqual(lineFaults(doc), [], PROMPTS + ': the census skeleton must carry the user\'s four lines as written');
  // Live controls on the real document, each anchor found before it is used: a line lost, a sentence
  // appended inside one, a line twice, a paragraph after the last, two lines swapped, the heading
  // renamed or doubled, and a fence left open.
  const planted = (from, to) => {
    assert.equal(doc.split(from).length - 1, 1, 'the control anchor must occur once: ' + from);
    return doc.replace(from, () => to);
  };
  for (const [name, text, expected] of [
    ['the test-reader line lost', planted(LINES[1] + '\n\n', ''), [missing(1, 0)]],
    ['a sentence appended to the report line', planted(LINES[3], LINES[3] + ' Skip it when in a hurry.'), [missing(3, 0)]],
    ['the backlog line twice', planted(LINES[2] + '\n', LINES[2] + '\n\n' + LINES[2] + '\n'), [missing(2, 2)]],
    ['a paragraph after the report line', planted(LINES[3] + '\n```', LINES[3] + '\n\nSkip the backlog when in a hurry.\n```'), [ORDER]],
    ['two lines swapped', planted(LINES[1] + '\n\n' + LINES[2], LINES[2] + '\n\n' + LINES[1]), [ORDER]],
    ['the heading renamed', planted(HEADING + '\n', '## Census\n'), ['0 "' + HEADING + '" headings outside a fence, not one']],
    ['the heading doubled', doc + '\n' + HEADING + '\n', ['2 "' + HEADING + '" headings outside a fence, not one']],
    ['a fence left open', doc + '\n```\n', ['an unbalanced ``` fence']],
  ]) {
    assert.notEqual(text, doc, name + ': the control must change the document');
    assert.deepEqual(lineFaults(text), expected, name);
  }
  // The block is the section's own: four lines in a block under the NEXT heading do not count, and
  // the heading inside a fenced block is body text, not a second heading.
  assert.deepEqual(lineFaults(HEADING + '\n\nNo block here.\n\n## Next\n\n```\n' + LINES.join('\n\n') + '\n```\n'),
    ['no fenced block under "' + HEADING + '"'], 'a block under the next heading is not the census block');
  assert.deepEqual(lineFaults(planted('FACTS TO FIND:', HEADING + '\n\nFACTS TO FIND:')), [],
    'the heading inside the prompt block is body text, not a second heading');
});

test('the census section reads exactly as pinned, and a sentence added anywhere in it is reported', () => {
  const doc = readText(path.join(ROOT, PROMPTS));
  assert.deepEqual(sectionFaults(doc), [], PROMPTS + ': the census section changed; update SECTION only on purpose');
  const planted = (from, to) => {
    assert.equal(doc.split(from).length - 1, 1, 'the control anchor must occur once: ' + from);
    return doc.replace(from, () => to);
  };
  // Live controls, each a case the four-line rule passes: a sentence just inside either end of the
  // section, a paragraph after FACTS TO FIND that skips two of the user's lines, two licences appended
  // to the block's read-only sentence, and a paste rule appended to the prose under the block.
  const FACTS = 'FACTS TO FIND: [numbered; each names the files and symbols to settle]\n';
  const READ_ONLY_END = 'nothing, and write only disposable scratch under your session scratchpad.';
  const PER_BATCH = 'One census per batch, never one agent for several batches.';
  for (const [name, text] of [
    ['a sentence just inside the start', planted(HEADING + '\n', HEADING + '\n\nSkip the census for a small batch.\n')],
    ['a sentence just inside the end', planted('agent runs again during the run.\n', 'agent runs again during the run. Skip it when in a hurry.\n')],
    ['two of the user\'s lines skipped', planted(FACTS, FACTS
      + '\nWhen the batch is small, report only the opening list and leave out the test and backlog searches.\n')],
    ['the batch file corrected in place', planted(READ_ONLY_END, READ_ONLY_END + ' Where the draft is wrong, correct the batch file in place.')],
    ['an edit licence', planted(READ_ONLY_END, READ_ONLY_END + ' You may also edit any file the draft names when a fix is obvious.')],
    ['a paste without the backlog line', planted(PER_BATCH, PER_BATCH + ' For a small batch, paste the skeleton without its backlog line.')],
  ]) {
    assert.notEqual(text, doc, name + ': the control must change the document');
    assert.deepEqual(lineFaults(text), [], name + ': the four lines still pass, so only the section pin decides this case');
    const faults = sectionFaults(text);
    assert.equal(faults.length, 1, name + ': reported once — ' + faults.join(' | '));
    assert.ok(faults[0].startsWith(CHANGED), name + ': reported as a changed section — ' + faults[0]);
  }
});

test('a CRLF twin of the census section gives exactly the verdict its LF original gives', t => {
  const temp = fs.realpathSync(os.tmpdir()), base = fs.mkdtempSync(path.join(temp, 'census-eol-'));
  t.after(() => { assert.equal(path.dirname(fs.realpathSync(base)), temp);
    fs.rmSync(base, { recursive: true, maxRetries: 8, retryDelay: 100 }); });
  const { section } = censusSection(readText(path.join(ROOT, PROMPTS)));
  assert.ok(section && section.startsWith(HEADING + '\n'), 'the census section must be found in ' + PROMPTS);
  const CRLF = String.fromCharCode(13, 10);
  // Each twin written with its line endings spelled out, then read back through the one door.
  const twin = (name, text, eol) => {
    const file = path.join(base, name);
    fs.writeFileSync(file, text.split('\n').join(eol) + eol);
    return file;
  };
  // The section as it is, and with a line lost, so the two verdicts agree on a fault as well as on none;
  // the line pin's and the section pin's alike.
  const broken = section.replace(LINES[1] + '\n\n', () => '');
  assert.notEqual(broken, section, 'the broken twin must lose the test-reader line');
  for (const [name, text, expected, pinned] of [['section', section, [], []], ['broken', broken, [missing(1, 0)], ['changed']]]) {
    const lf = twin(name + '-lf.md', text, '\n'), crlf = twin(name + '-crlf.md', text, CRLF);
    assert.ok(fs.readFileSync(crlf, 'utf8').includes(CRLF) && !fs.readFileSync(lf, 'utf8').includes(CRLF), name + ': the twins differ in their line endings');
    assert.deepEqual(lineFaults(readText(crlf)), lineFaults(readText(lf)), name + ': the CRLF twin must read as its LF original');
    assert.deepEqual(lineFaults(readText(lf)), expected, name + ': and both give the verdict the section itself gives');
    assert.deepEqual(sectionFaults(readText(crlf)), sectionFaults(readText(lf)), name + ': the section pin reads the CRLF twin as its LF original');
    assert.deepEqual(sectionFaults(readText(lf)).map(fault => fault.startsWith(CHANGED) ? 'changed' : fault), pinned,
      name + ': and the section pin gives the verdict it gives the section itself');
    // The door is what makes them agree: read raw, the CRLF twin's heading carries a CR and is not found.
    assert.notDeepEqual(lineFaults(fs.readFileSync(crlf, 'utf8')), lineFaults(readText(lf)), name + ': the normalisation is load-bearing');
  }
});

// Case-folded letters and nothing else, so a copy is found however it is wrapped, quoted, commented,
// punctuated, capitalised or split across a string concatenation.
const letters = text => text.toLowerCase().replace(/[^a-z]+/g, '');
const TREES = ['orchestrate', '.claude/agents'];
// The files git tracks under `trees`, at any depth, relative to `cwd`.
function tracked(cwd, env, trees) {
  const r = spawnSync('git', ['ls-files', '-z', '--', ...trees], { cwd, env, encoding: 'utf8', windowsHide: true, timeout: 15000 });
  assert.ifError(r.error);
  assert.equal(r.status, 0, 'git ls-files must list ' + trees.join(', ') + ': ' + r.stderr);
  return r.stdout.split('\0').filter(Boolean).sort();
}
// Each listed file whose text carries the old wording.
const oldWordingFaults = (base, files) => files.filter(file => letters(readText(path.join(base, file))).includes(letters(OLD)));

test('no tracked file under orchestrate/ or .claude/agents/ carries the report line\'s old UNVERIFIED wording', () => {
  const files = tracked(ROOT, process.env, TREES);
  // A floor, so a listing that reads the wrong place, or nothing, is red rather than clean.
  for (const floor of ['orchestrate/SKILL.md', PROMPTS, '.claude/agents/reviewer.md']) {
    assert.ok(files.includes(floor), 'the listing must read ' + floor + '; it holds ' + files.length + ' file(s)');
  }
  assert.deepEqual(oldWordingFaults(ROOT, files), [], 'the report line\'s old wording survives; the census skeleton\'s fourth line replaced it');
});

test('the old-wording sweep finds a planted copy in any form, at any depth of either tree, and reads no other tree', t => {
  const repo = makeRepo(t);
  const cut = OLD.indexOf(' by opening'), first = OLD.slice(0, cut), second = OLD.slice(cut + 1);
  const CRLF = String.fromCharCode(13, 10);
  const plants = {
    'orchestrate/SKILL.md': 'No copy here: ' + LINES[3] + '\n',
    'orchestrate/references/exact.md': OLD + '.\n',
    'orchestrate/references/deep/.dotted/wrapped.md': first + CRLF + second + '.' + CRLF,
    'orchestrate/tools/concat.mjs': "const NOTE = '" + first + " '\n  + '" + second + "';\n",
    '.claude/agents/quoted.md': '> ' + first.toUpperCase() + '\n> ' + second + '\n',
    '.agents/notes.md': OLD + '\n',
    'tests/copy.test.cjs': '// ' + OLD + '\n',
  };
  for (const [file, text] of Object.entries(plants)) repo.write(file, text);
  repo.commit('plants');
  const files = tracked(repo.cwd, repo.env, TREES);
  assert.deepEqual(files, Object.keys(plants).filter(file => TREES.some(tree => file.startsWith(tree + '/'))).sort(),
    'the listing is every tracked file of the two trees, at any depth, dotted directories included, and nothing else');
  assert.deepEqual(oldWordingFaults(repo.cwd, files), ['.claude/agents/quoted.md', 'orchestrate/references/deep/.dotted/wrapped.md',
    'orchestrate/references/exact.md', 'orchestrate/tools/concat.mjs'], 'live control: every planted form is found, and the new wording is not the old');
});
