'use strict';
// The census skeleton's five instruction lines are the user's own words (four the user gave, and a fifth
// this change added and the user approved with its plan, 2026-10-21), so the `## Census` section of
// orchestrate/references/subagent-prompts.md is pinned whole, its prompt block is held to the five lines
// verbatim, its send-back block is held to its own text, and the report line's earlier wording, which the
// fifth line replaced, is held out of every tracked file under orchestrate/ and .claude/agents/. Each rule
// has a live control, and the section's CRLF twin must read as its LF original.
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
// The five lines, whitespace-collapsed: the four as the user gave them (2026-10-07 and 2026-10-13), and,
// before the report line, the fifth this change added (2026-10-21), which the user approved with the plan.
const LINES = [
  'Open your report with a short list headed "Where the draft is wrong or incomplete": each place the planned change '
    + 'contradicts the code or misses something it must also change, one bullet each with `path:line`, or `none`.',
  "Then, for every file this batch changes, list every test that reads it (search the tests for the file's name), "
    + 'including tests that assert on something unrelated to this batch, and say whether the change could break it.',
  "Then grep the repository's backlog and bug trackers and its old ledgers under `.agents/` for every file this batch "
    + 'changes or depends on and for its main symbols; open the hits, and report any recorded finding, measurement or '
    + 'decision that bears on the planned change.',
  'Then, for every fix you propose, in that opening list or anywhere else in your report, list every test that reads '
    + 'a file the fix changes or a name it adds or changes (search the tests for both), and say what the fix would break; '
    + 'do this before you hand back.',
  'Report: one bullet per file: `path:line — what — why`. At most 80 lines. Mark as UNVERIFIED anything you did not '
    + 'read in the file it depends on or run yourself, including your own inferences and recommendations, and name the '
    + 'platform of anything you ran.',
];
// The send-back block the orchestrator resumes the census with, verbatim: its label line, the never-open
// line, and its instruction paragraph; and the lead line above it.
const SEND_BACK_LABEL = "THE LINES WRITTEN INTO B[NN]'S BATCH FILE FROM YOUR REPORT, exactly as written, each with "
  + 'the item of your report it came from: [the lines]';
const NEVER_OPEN = "Never open another agent's prompt or facts file.";
const SEND_BACK_ASK = 'For each line, list every test that reads a file it changes or a name it adds or changes (search '
  + 'the tests for both), say what it would break, and say whether it still says what your report found. Open with one '
  + 'bullet per line: `holds`, or what breaks or differs, with `path:line`. Mark as UNVERIFIED anything you did not '
  + 'read in the file it depends on or run yourself.';
const SEND_BACK_LEAD = '**Send-back** — after the orchestrator folds the report, it resumes the same agent (SendMessage) '
  + 'with this block, holding the lines `scaffolding.md` step 3 names:';
// The report line's UNVERIFIED rule before 2026-10-13, which the report line, now the fifth, widened.
const OLD = 'Mark anything you did not verify by opening the file as UNVERIFIED';
// The whole section as its batch shipped it, whitespace-collapsed: the spawn line, the bare-fenced
// prompt block, the send-back lead line and block, and the prose under them. A sentence added anywhere
// in the section, a licence to write or a line to skip among them, changes it; lineFaults() below names which of the five lines went.
const SECTION = flow([HEADING, '**Spawn with** `subagent_type: census`.', '```',
  'You are a read-only CENSUS agent for ONE planned batch, B[NN] of change [CHANGE_ID], in [REPO_PATH] at [BASE]. '
    + 'Use only Read/Grep/Glob, read-only git and read-only commands; edit nothing, and write only disposable scratch '
    + 'under your session scratchpad.',
  NEVER_OPEN,
  "THE BATCH'S PLANNED CHANGE: [the draft batch file's planned change]",
  "THE BATCH'S FENCE: [the draft batch file's Files line; where the repository keeps a map of its files' tests and "
    + "callers, each fenced file's rows from it]",
  'FACTS TO FIND: [numbered; each names the files and symbols to settle]',
  ...LINES, '```', SEND_BACK_LEAD, '```', SEND_BACK_LABEL, NEVER_OPEN, SEND_BACK_ASK, '```',
  "One census per batch, never one agent for several batches. The report comes back as the agent's final message. "
    + '`scaffolding.md` step 3 says how the orchestrator records its opening list in LOG.md; `protocol.md` §Fence '
    + "changes and §Session algorithm step 4 say when a batch's `census` agent runs again during the run. "
    + "The send-back's answer also comes back as the agent's final message; `scaffolding.md` step 3 says which lines go "
    + 'back and how the answer is recorded.'].join(' '));

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

// What the section's prompt block, its first fenced block, lacks of the five lines: each line that is
// not exactly one of the block's whitespace-collapsed paragraphs, once; and, when every line is, a block
// that does not close on the five in order.
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
const ORDER = 'the block does not close on the five lines in order';

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

// The phrases the send-back block must carry, each its own fault when its whitespace-collapsed text lacks it.
const SEND_BACK_PHRASES = ['exactly as written', 'each with the item of your report it came from',
  'list every test that reads a file it changes or a name it adds or changes', 'search the tests for both',
  'say what it would break', 'say whether it still says what your report found', 'Open with one bullet per line',
  'Mark as UNVERIFIED anything you did not read in the file it depends on or run yourself'];
const SEND_BACK = flow([SEND_BACK_LABEL, NEVER_OPEN, SEND_BACK_ASK].join(' '));
const NO_SEND_BACK = 'no send-back block after the census prompt block';
const lacks = phrase => 'the send-back block lacks: ' + phrase;
const NOT_SECOND = 'the never-open line is not the send-back block\'s second line, on a line of its own';
const REWORDED = 'the send-back block carries every phrase but does not read as SEND_BACK';
// What the section's send-back block, the one fenced block after its prompt block, lacks: none, or more
// than one, is a fault; then each missing phrase, and a never-open line that is not the block's second line;
// and, when neither, a block whose whitespace-collapsed text is not SEND_BACK.
function sendBackFaults(text) {
  const { fault, section } = censusSection(text);
  if (fault) return [fault];
  const lines = section.split('\n'), blocks = [];
  let open = -1;
  lines.forEach((line, at) => {
    if (!line.startsWith('```')) return;
    if (open === -1) open = at;
    else { blocks.push(lines.slice(open + 1, at)); open = -1; }
  });
  if (blocks.length < 2) return [NO_SEND_BACK];
  if (blocks.length > 2) return [(blocks.length - 1) + ' fenced blocks after the census prompt block, not one'];
  const body = blocks[1], actual = flow(body.join('\n'));
  const faults = SEND_BACK_PHRASES.filter(phrase => !actual.includes(phrase)).map(lacks);
  if (body[1] !== NEVER_OPEN) faults.push(NOT_SECOND);
  if (!faults.length && actual !== SEND_BACK) faults.push(REWORDED);
  return faults;
}

test('the census prompt block closes on the five lines, verbatim and in order, each a paragraph of its own', () => {
  const doc = readText(path.join(ROOT, PROMPTS));
  assert.deepEqual(lineFaults(doc), [], PROMPTS + ': the census skeleton must carry its five lines as written');
  // Live controls on the real document, each anchor found before it is used: a line lost, a sentence
  // appended inside one, a line twice, a paragraph after the last, two lines swapped, the fifth line
  // removed or moved past the report line, the heading renamed or doubled, and a fence left open.
  const planted = (from, to) => {
    assert.equal(doc.split(from).length - 1, 1, 'the control anchor must occur once: ' + from);
    return doc.replace(from, () => to);
  };
  for (const [name, text, expected] of [
    ['the test-reader line lost', planted(LINES[1] + '\n\n', ''), [missing(1, 0)]],
    ['a sentence appended to the report line', planted(LINES[4], LINES[4] + ' Skip it when in a hurry.'), [missing(4, 0)]],
    ['the backlog line twice', planted(LINES[2] + '\n', LINES[2] + '\n\n' + LINES[2] + '\n'), [missing(2, 2)]],
    ['a paragraph after the report line', planted(LINES[4] + '\n```', LINES[4] + '\n\nSkip the backlog when in a hurry.\n```'), [ORDER]],
    ['two lines swapped', planted(LINES[1] + '\n\n' + LINES[2], LINES[2] + '\n\n' + LINES[1]), [ORDER]],
    ['the fifth line removed', planted(LINES[3] + '\n\n', ''), [missing(3, 0)]],
    ['the fifth line moved after the report line', planted(LINES[3] + '\n\n' + LINES[4], LINES[4] + '\n\n' + LINES[3]), [ORDER]],
    ['the heading renamed', planted(HEADING + '\n', '## Census\n'), ['0 "' + HEADING + '" headings outside a fence, not one']],
    ['the heading doubled', doc + '\n' + HEADING + '\n', ['2 "' + HEADING + '" headings outside a fence, not one']],
    ['a fence left open', doc + '\n```\n', ['an unbalanced ``` fence']],
  ]) {
    assert.notEqual(text, doc, name + ': the control must change the document');
    assert.deepEqual(lineFaults(text), expected, name);
  }
  // The block is the section's own: five lines in a block under the NEXT heading do not count, and
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
  // Live controls, each a case the five-line rule passes: a sentence just inside either end of the
  // section, a paragraph after FACTS TO FIND that skips two of the user's lines, two licences appended
  // to the block's read-only sentence, and a paste rule appended to the prose under the block.
  const FACTS = 'FACTS TO FIND: [numbered; each names the files and symbols to settle]\n';
  const READ_ONLY_END = 'nothing, and write only disposable scratch under your session scratchpad.';
  const PER_BATCH = 'One census per batch, never one agent for several batches.';
  for (const [name, text] of [
    ['a sentence just inside the start', planted(HEADING + '\n', HEADING + '\n\nSkip the census for a small batch.\n')],
    ['a sentence just inside the end', planted('recorded.\n', 'recorded. Skip it when in a hurry.\n')],
    ['two of the user\'s lines skipped', planted(FACTS, FACTS
      + '\nWhen the batch is small, report only the opening list and leave out the test and backlog searches.\n')],
    ['the batch file corrected in place', planted(READ_ONLY_END, READ_ONLY_END + ' Where the draft is wrong, correct the batch file in place.')],
    ['an edit licence', planted(READ_ONLY_END, READ_ONLY_END + ' You may also edit any file the draft names when a fix is obvious.')],
    ['a paste without the backlog line', planted(PER_BATCH, PER_BATCH + ' For a small batch, paste the skeleton without its backlog line.')],
  ]) {
    assert.notEqual(text, doc, name + ': the control must change the document');
    assert.deepEqual(lineFaults(text), [], name + ': the five lines still pass, so only the section pin decides this case');
    const faults = sectionFaults(text);
    assert.equal(faults.length, 1, name + ': reported once — ' + faults.join(' | '));
    assert.ok(faults[0].startsWith(CHANGED), name + ': reported as a changed section — ' + faults[0]);
  }
});

test('the census send-back block reads as pinned, each phrase its own fault, the never-open line second', () => {
  const doc = readText(path.join(ROOT, PROMPTS));
  assert.deepEqual(sendBackFaults(doc), [], PROMPTS + ': the census send-back block must read as SEND_BACK');
  const planted = (from, to) => {
    assert.equal(doc.split(from).length - 1, 1, 'the control anchor must occur once: ' + from);
    return doc.replace(from, () => to);
  };
  const BLOCK = '```\n' + SEND_BACK_LABEL + '\n' + NEVER_OPEN + '\n\n' + SEND_BACK_ASK + '\n```\n\n';
  // Live controls, each decided by this rule's own fault and passed by the five-line rule: a phrase
  // dropped from the label and one from the instruction, the never-open line moved first, a sentence
  // appended to the instruction, the block removed, and a second block after it.
  for (const [name, text, expected] of [
    ['"exactly as written" dropped', planted('REPORT, exactly as written, each', 'REPORT, each'), [lacks('exactly as written')]],
    ['"say what it would break" dropped', planted('both), say what it would break, and', 'both), and'), [lacks('say what it would break')]],
    ['the never-open line moved first', planted(SEND_BACK_LABEL + '\n' + NEVER_OPEN + '\n', NEVER_OPEN + '\n' + SEND_BACK_LABEL + '\n'), [NOT_SECOND]],
    ['a sentence appended to the instruction', planted(SEND_BACK_ASK, SEND_BACK_ASK + ' Skip the tests for a one-line fix.'), [REWORDED]],
    ['the block removed', planted(BLOCK, ''), [NO_SEND_BACK]],
    ['a second block after it', planted(BLOCK, BLOCK + '```\nTHE LINES AGAIN\n```\n\n'), ['2 fenced blocks after the census prompt block, not one']],
  ]) {
    assert.notEqual(text, doc, name + ': the control must change the document');
    assert.deepEqual(lineFaults(text), [], name + ': the five lines still pass, so the five-line rule does not decide this case');
    assert.deepEqual(sendBackFaults(text), expected, name);
  }
  // The never-open line out of second place where only whitespace changes, so the section pin passes it:
  // moved below the blank line, and joined onto the label line.
  for (const [name, text] of [
    ['the never-open line below the blank line', planted(NEVER_OPEN + '\n\n' + SEND_BACK_ASK, '\n' + NEVER_OPEN + '\n' + SEND_BACK_ASK)],
    ['the never-open line joined onto the label', planted(SEND_BACK_LABEL + '\n' + NEVER_OPEN + '\n', SEND_BACK_LABEL + ' ' + NEVER_OPEN + '\n')],
  ]) {
    assert.notEqual(text, doc, name + ': the control must change the document');
    assert.deepEqual(sectionFaults(text), [], name + ': whitespace only, so the section pin does not decide this case');
    assert.deepEqual(lineFaults(text), [], name + ': the five lines still pass');
    assert.deepEqual(sendBackFaults(text), [NOT_SECOND], name);
  }
  // One control per phrase, written out apart from SEND_BACK_PHRASES so a phrase cut from that list
  // turns its control red; each phrase is cut from the block's own text, since two of them also occur
  // in the prompt block.
  const CUTS = ['exactly as written', 'each with the item of your report it came from',
    'list every test that reads a file it changes or a name it adds or changes', 'search the tests for both',
    'say what it would break', 'say whether it still says what your report found', 'Open with one bullet per line',
    'Mark as UNVERIFIED anything you did not read in the file it depends on or run yourself'];
  assert.deepEqual([...CUTS].sort(), [...SEND_BACK_PHRASES].sort(), 'every phrase of SEND_BACK_PHRASES has its own control, and no other');
  for (const phrase of CUTS) {
    assert.equal(BLOCK.split(phrase).length - 1, 1, 'the phrase must occur once in the block: ' + phrase);
    const text = planted(BLOCK, BLOCK.replace(phrase, () => ''));
    assert.deepEqual(lineFaults(text), [], phrase + ' cut: the five lines still pass');
    assert.deepEqual(sendBackFaults(text), [lacks(phrase)], phrase + ' cut');
  }
  // A section that cannot be found is the pin's fault too, never a clean verdict.
  assert.deepEqual(sendBackFaults(planted(HEADING + '\n', '## Census\n')), ['0 "' + HEADING + '" headings outside a fence, not one'],
    'the heading renamed: the send-back pin reports the section lost');
  assert.deepEqual(sendBackFaults(doc + '\n```\n'), ['an unbalanced ``` fence'], 'a fence left open: the send-back pin reports it');
});

// The senses of "census" that do not name the census agent (tests/census-wiring.test.cjs's NOT_THE_AGENT, copied).
const NOT_THE_AGENT = [/\bcheck-ledger(?:\.mjs)?["']?\s+census\b/gi, /\bcensus\s+lines?\b/gi, /\bgrep\s+census\b/gi];
// The sentences of a text (tests/census-wiring.test.cjs's sentencesOf, copied): its blocks, split at blank
// lines, list items and table rows, each whitespace-collapsed with its code ticks dropped and cut after a
// full stop, question or exclamation mark.
const BLOCKS = /\n(?:[ \t]*\n)+|\n(?=[ \t]*(?:[-*]|\d+\.)[ \t])|\n(?=[ \t]*\|)/;
const sentencesOf = text => text.split(BLOCKS).flatMap(block => flow(block.replace(/`/g, '')).split(/(?<=[.!?]) /)).filter(Boolean);
// The reviewed sentences outside §Census that name the census agent, as sentencesOf() reads them.
const OUTSIDE = ['Fence completeness census: the CENSUS line lists the tracked files outside all fences that name a fenced '
    + 'path (by path, import specifier or basename); beyond paths, grep the repo for every symbol, channel, table, key or '
    + 'literal string each batch changes, and given no CENSUS line, for every fenced path too.',
  'The QA runner, artifact proofer, census, pre-flight, convergence and fix-up skeletons are always filled and pasted and '
    + 'carry NO nonce.'];
// Every sentence of the document outside §Census, fenced blocks included, that names the census agent and is
// not on OUTSIDE; then each OUTSIDE sentence not found exactly once.
function outsideFaults(text) {
  const lines = text.split('\n'), headings = [];
  let open = false;
  lines.forEach((line, at) => {
    if (line.startsWith('```')) open = !open;
    else if (!open && line.startsWith('## ')) headings.push(at);
  });
  const own = headings.find(at => lines[at] === HEADING);
  if (open || own === undefined) return ['the census section cannot be found'];
  const end = headings.find(at => at > own) ?? lines.length;
  const rest = sentencesOf([...lines.slice(0, own), ...lines.slice(end)].join('\n'));
  const named = rest.filter(sentence => /census/i.test(NOT_THE_AGENT.reduce((left, sense) => left.replace(sense, ' '), sentence)));
  return [...named.filter(sentence => !OUTSIDE.includes(sentence)).map(sentence => 'unreviewed: ' + sentence),
    ...OUTSIDE.filter(sentence => named.filter(found => found === sentence).length !== 1).map(sentence => 'not found once: ' + sentence)];
}

test('outside §Census, every sentence of the prompts file that names the census agent is a reviewed one', () => {
  const doc = readText(path.join(ROOT, PROMPTS));
  assert.deepEqual(outsideFaults(doc), [], PROMPTS + ': a sentence outside §Census names the census agent; review it into OUTSIDE');
  const planted = (from, to) => {
    assert.equal(doc.split(from).length - 1, 1, 'the control anchor must occur once: ' + from);
    return doc.replace(from, () => to);
  };
  const RESUMED = 'A census is never resumed: its send-back block goes to a fresh `census` agent instead.';
  const UNSEARCHED = 'A census need not search the tests for the fixes it proposes; the orchestrator does that after the fold.';
  // Live controls: a reversal of the send-back at the document's end and of the fifth line before §Census,
  // each reported once; a CENSUS-line sentence, which names no agent, not reported; a reviewed sentence
  // lost; and the section lost, by its heading renamed or by a fence left open.
  for (const [name, text, expected] of [
    ['the send-back reversed at the end', doc + '\n- ' + RESUMED + '\n', ['unreviewed: - ' + RESUMED.replace(/`/g, '')]],
    ['the fifth line reversed before §Census', planted('## Implementer\n', '## Implementer\n\n' + UNSEARCHED + '\n'), ['unreviewed: ' + UNSEARCHED]],
    ['a CENSUS-line sentence', doc + '\nRead the CENSUS line first.\n', []],
    ['a reviewed sentence lost', planted('census, pre-flight, convergence', 'pre-flight, convergence'), ['not found once: ' + OUTSIDE[1]]],
    ['the section lost', planted(HEADING + '\n', '## Census\n'), ['the census section cannot be found']],
    ['a fence left open', doc + '\n```\n', ['the census section cannot be found']],
  ]) {
    assert.notEqual(text, doc, name + ': the control must change the document');
    assert.deepEqual(outsideFaults(text), expected, name);
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
  // The section as it is, with a line lost, and with its send-back block lost, so the verdicts agree on a
  // fault as well as on none; the line pin's, the section pin's and the send-back pin's alike.
  const broken = section.replace(LINES[1] + '\n\n', () => '');
  assert.notEqual(broken, section, 'the broken twin must lose the test-reader line');
  const unsent = section.replace('```\n' + SEND_BACK_LABEL + '\n' + NEVER_OPEN + '\n\n' + SEND_BACK_ASK + '\n```\n', () => '');
  assert.notEqual(unsent, section, 'the unsent twin must lose the send-back block');
  for (const [name, text, expected, pinned, sent] of [['section', section, [], [], []],
    ['broken', broken, [missing(1, 0)], ['changed'], []], ['unsent', unsent, [], ['changed'], [NO_SEND_BACK]]]) {
    const lf = twin(name + '-lf.md', text, '\n'), crlf = twin(name + '-crlf.md', text, CRLF);
    assert.ok(fs.readFileSync(crlf, 'utf8').includes(CRLF) && !fs.readFileSync(lf, 'utf8').includes(CRLF), name + ': the twins differ in their line endings');
    assert.deepEqual(lineFaults(readText(crlf)), lineFaults(readText(lf)), name + ': the CRLF twin must read as its LF original');
    assert.deepEqual(lineFaults(readText(lf)), expected, name + ': and both give the verdict the section itself gives');
    assert.deepEqual(sectionFaults(readText(crlf)), sectionFaults(readText(lf)), name + ': the section pin reads the CRLF twin as its LF original');
    assert.deepEqual(sectionFaults(readText(lf)).map(fault => fault.startsWith(CHANGED) ? 'changed' : fault), pinned,
      name + ': and the section pin gives the verdict it gives the section itself');
    assert.deepEqual(sendBackFaults(readText(crlf)), sendBackFaults(readText(lf)), name + ': the send-back pin reads the CRLF twin as its LF original');
    assert.deepEqual(sendBackFaults(readText(lf)), sent, name + ': and the send-back pin gives the verdict it gives the section itself');
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
  assert.deepEqual(oldWordingFaults(ROOT, files), [], 'the report line\'s old wording survives; the census skeleton\'s fifth line replaced it');
});

test('the old-wording sweep finds a planted copy in any form, at any depth of either tree, and reads no other tree', t => {
  const repo = makeRepo(t);
  const cut = OLD.indexOf(' by opening'), first = OLD.slice(0, cut), second = OLD.slice(cut + 1);
  const CRLF = String.fromCharCode(13, 10);
  const plants = {
    'orchestrate/SKILL.md': 'No copy here: ' + LINES[4] + '\n',
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
