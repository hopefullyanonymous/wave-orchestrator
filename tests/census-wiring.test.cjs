'use strict';
// README.md's account of the census, bound to the files that ship it. README's list of the definitions this repo ships
// in .claude/agents/, and the count word before it, are the definitions git tracks there; step 3's census paragraph in
// orchestrate/references/scaffolding.md names the `census` type and the §Census skeleton that
// orchestrate/references/subagent-prompts.md and .claude/agents/census.md hold; no sentence of a tracked file under
// orchestrate/ or .claude/agents/ lets one census agent cover several batches; README's `/orchestrate new` row offers a
// fresh conversation, and orchestrate/SKILL.md's Mode: new names the context precondition, exactly when scaffolding.md
// holds it; and README's other census mentions are pinned whole or bound to SKILL.md's rows. Every file is read through
// `read`, which turns CRLF into LF. Each check answers a list of faults, so every live control feeds it one planted
// mismatch and reads the faults it reports.
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { makeRepo } = require('./support/git-fixture.cjs');

const ROOT = path.resolve(__dirname, '..');
const lf = text => text.replace(/\r\n/g, '\n');
// The one door every file comes through, so a CRLF checkout hands each rule the LF text it is written against.
const read = (file, root = ROOT) => lf(fs.readFileSync(path.join(root, file), 'utf8'));
const crlf = text => text.replace(/\r?\n/g, '\r\n');
const collapse = text => text.replace(/\s+/g, ' ');
const README = 'README.md', SKILL = 'orchestrate/SKILL.md', SCAFFOLDING = 'orchestrate/references/scaffolding.md';
const PROMPTS = 'orchestrate/references/subagent-prompts.md', AGENTS = '.claude/agents', DEFINITION = '.claude/agents/census.md';

// An edit replacing `find`, which must occur exactly once, so a control whose anchor moved fails loudly.
const swap = (find, put) => text => {
  assert.equal(text.split(find).length - 1, 1, 'the control anchor must be found once — ' + find);
  return text.replace(find, () => put);
};
// Each control `[what, ...inputs, faults]` with the faults `check(...inputs)` reports, beside the ones it must, compared
// once, so a red shows every control's outcome.
const settle = (controls, check) => assert.deepEqual(controls.map(([what, ...rest]) => [what, check(...rest.slice(0, -1))]),
  controls.map(([what, ...rest]) => [what, rest[rest.length - 1]]));
// A temporary root holding a CRLF copy of each of `files`, read from the checkout.
function crlfTwin(t, files) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'census-wiring-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }));
  for (const file of files) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), crlf(read(file)));
  }
  return root;
}

// ===== The tracked files ===============================================================================================
// Whether `file` lies on disk under `cwd`, by `stat` (fs.lstatSync; a fixture passes its own): only ENOENT and ENOTDIR
// prove it absent, and any other error fails.
function onDisk(cwd, file, stat = fs.lstatSync) {
  try {
    stat(path.join(cwd, file));
    return true;
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false;
    throw error;
  }
}
// The files git tracks under `paths`, at any depth, that the working tree under `cwd` holds by `present` (onDisk; a
// fixture passes its own): an untracked or ignored file is none of them, and neither is a tracked one deleted from the
// tree. A listing that fails stops the run rather than read as empty.
function tracked(paths, cwd = ROOT, env = process.env, present = onDisk) {
  const r = spawnSync('git', ['ls-files', '-z', '--', ...paths], { cwd, env, encoding: 'utf8', windowsHide: true, timeout: 15000 });
  assert.ifError(r.error);
  assert.equal(r.status, 0, 'git ls-files must list ' + paths.join(' ') + ': ' + r.stderr);
  return r.stdout.split('\0').filter(Boolean).filter(file => present(cwd, file)).sort();
}
// The definitions .claude/agents/ ships: its tracked files, named relative to it with `.md` dropped.
const definitions = (cwd = ROOT, env = process.env) => tracked([AGENTS], cwd, env).map(file => file.slice(AGENTS.length + 1).replace(/\.md$/, ''));

test('a shipped definition is a file git tracks under .claude/agents/, at any depth, that the working tree holds', t => {
  const repo = makeRepo(t);
  repo.write('.gitignore', '*.log\n');
  for (const file of ['.claude/agents/a.md', '.claude/agents/deeper/b.md', '.claude/agents/implementer.md', '.claude/agents/dir/c.md', '.claude/other.md']) {
    repo.write(file, 'x\n');
  }
  repo.commit('definitions');
  repo.write('.claude/agents/untracked.md', 'x\n');
  repo.write('.claude/agents/ignored.log', 'x\n');
  // Deleted from the fixture's tree while the checkout still holds it, so existence is read under the fixture's cwd; and
  // a tracked definition under a directory that became a file.
  fs.rmSync(path.join(repo.cwd, '.claude/agents/implementer.md'));
  fs.rmSync(path.join(repo.cwd, '.claude/agents/dir'), { recursive: true });
  repo.write('.claude/agents/dir', 'a file where a directory was\n');
  assert.deepEqual(definitions(repo.cwd, repo.env), ['a', 'deeper/b'],
    'tracked and on disk, at any depth: no untracked, ignored, deleted or outside file, and none under a directory that became a file');
  // Any failure but a proven absence stops the run: onDisk's on an lstat that fails as a denied one does and on a path no
  // file system accepts, and tracked's on a failing verdict, each rethrown as it was thrown.
  const denied = Object.assign(new Error("EACCES: permission denied, lstat '.claude/agents/a.md'"), { code: 'EACCES', syscall: 'lstat' });
  assert.throws(() => onDisk(repo.cwd, '.claude/agents/a.md', () => { throw denied; }), error => error === denied);
  assert.throws(() => onDisk(repo.cwd, 'a\0b'), { code: 'ERR_INVALID_ARG_VALUE' });
  assert.throws(() => tracked([AGENTS], repo.cwd, repo.env, () => { throw denied; }), error => error === denied);
});

// ===== (a) README's shipped-definition list and its count word =======================================================
const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];
const NUMBER = String.raw`\b(\d+|${NUMBER_WORDS.join('|')})\b`;
const countOf = word => /^\d+$/.test(word) ? Number(word) : NUMBER_WORDS.indexOf(word.toLowerCase());
// A count of definitions anywhere in README: a number, not a partitive "one of", then up to three words, then
// "definitions", inside one sentence.
const COUNTED = new RegExp(NUMBER + String.raw`(?!\s+of\b)(?:\s+\S*[^\s.!?,;:]){0,3}?\s+definitions\b`, 'gi');
// The words opening README's list of the definitions this repo ships, and the words closing it.
const LIST = ['definitions this repo ships in `.claude/agents/` —', '— do **not**'];
// README's list: the backticked names between LIST's bounds, the count words of the sentence that opens before them,
// and the span from that sentence's start to the list's end, all on README's whitespace-collapsed text; null when the
// bounds do not resolve, the opening words once.
function readmeList(readme) {
  const text = collapse(readme), start = text.indexOf(LIST[0]);
  if (start === -1 || text.indexOf(LIST[0], start + 1) !== -1) return null;
  const end = text.indexOf(LIST[1], start + LIST[0].length);
  if (end === -1) return null;
  const stop = [...text.slice(0, start).matchAll(/[.!?] /g)].pop(), opens = stop === undefined ? 0 : stop.index + 2;
  return {
    names: [...text.slice(start + LIST[0].length, end).matchAll(/`([^`]+)`/g)].map(m => m[1]),
    counts: [...text.slice(opens, start).matchAll(new RegExp(NUMBER, 'gi'))].map(m => m[1]),
    span: [opens, end + LIST[1].length],
  };
}
// Each way README's list differs from `shipped`: a name either side lacks, a name listed twice, a count word that is
// not one or does not count the names, and a count of definitions elsewhere in README that is not the shipped number.
function listFaults(readme, shipped) {
  const list = readmeList(readme);
  if (list === null) return ['README: no list from "' + LIST[0] + '" to "' + LIST[1] + '", its opening once'];
  const faults = [];
  for (const name of list.names) if (!shipped.includes(name)) faults.push('README names `' + name + '`, which ' + AGENTS + '/ does not ship');
  for (const name of shipped) if (!list.names.includes(name)) faults.push(AGENTS + '/ ships `' + name + '`, which README does not name');
  for (const name of new Set(list.names)) if (list.names.indexOf(name) !== list.names.lastIndexOf(name)) faults.push('README names `' + name + '` twice');
  if (list.counts.length !== 1) faults.push('README: ' + list.counts.length + ' count words before the list, not one');
  else if (countOf(list.counts[0]) !== list.names.length) faults.push('README: "' + list.counts[0] + '" before a list of ' + list.names.length);
  const text = collapse(readme), rest = text.slice(0, list.span[0]) + '. ' + text.slice(list.span[1]);
  for (const m of rest.matchAll(COUNTED)) if (countOf(m[1]) !== shipped.length) faults.push('README: "' + m[0] + '", where ' + AGENTS + '/ ships ' + shipped.length);
  return faults;
}

test("README's shipped definitions are the ones git tracks under .claude/agents/, counted in words, and a CRLF copy reads alike", t => {
  assert.ok(fs.statSync(path.join(ROOT, AGENTS)).isDirectory(), AGENTS + '/ must be a directory of the checkout');
  const shipped = definitions(), readme = read(README);
  assert.ok(shipped.includes('implementer'), 'the listing must read the checkout\'s ' + AGENTS + '/; found ' + (shipped.join(', ') || 'nothing'));
  assert.deepEqual(listFaults(readme, shipped), []);
  const words = text => { const list = readmeList(text); return { names: list.names, counts: list.counts }; };
  // Equivalence, which passes: a CRLF copy, read back through `read`, is its LF twin, and gives the names and the count
  // word that twin gives.
  const twin = crlfTwin(t, [README]);
  assert.ok(fs.readFileSync(path.join(twin, README), 'utf8').includes('\r\n'), 'the copy must be CRLF');
  assert.equal(read(README, twin), readme, 'the door hands a CRLF copy over as its LF twin');
  assert.deepEqual(words(read(README, twin)), words(readme));
  assert.deepEqual(listFaults(read(README, twin), shipped), []);
  // The controls' names and numbers come from the checkout, so a definition added later needs no edit here.
  const { names, counts: [word] } = readmeList(readme), n = shipped.length, last = names[names.length - 1];
  assert.ok(n + 1 < NUMBER_WORDS.length, 'the controls need a number word past the count');
  const A = AGENTS + '/', lead = 'So the ' + word, more = NUMBER_WORDS[n + 1], fewer = NUMBER_WORDS[n - 1];
  const closing = '`' + last + '` — do', stale = count => '## Usage\n\nThe ' + count + ' agent definitions install apart from the skill.\n';
  const extra = 'planted-' + last;
  assert.ok(!shipped.includes(extra), 'the planted name must be no shipped definition: ' + extra);
  const NO_LIST = 'README: no list from "' + LIST[0] + '" to "' + LIST[1] + '", its opening once';
  settle([
    ['a dropped name', swap(', ' + closing, ' — do')(readme), shipped, [A + ' ships `' + last + '`, which README does not name', 'README: "' + word + '" before a list of ' + (n - 1)]],
    ['an added name', swap(closing, '`' + last + '`, `' + extra + '` — do')(readme), shipped, ['README names `' + extra + '`, which ' + A + ' does not ship', 'README: "' + word + '" before a list of ' + (n + 1)]],
    ['a name swapped for another', swap(closing, '`renamed-' + last + '` — do')(readme), shipped,
      ['README names `renamed-' + last + '`, which ' + A + ' does not ship', A + ' ships `' + last + '`, which README does not name']],
    ['a name listed twice, recounted', swap(lead, 'So the ' + more)(swap(closing, '`' + last + '`, ' + closing)(readme)), shipped, ['README names `' + last + '` twice']],
    ['a wrong count word', swap(lead, 'So the ' + more)(readme), shipped, ['README: "' + more + '" before a list of ' + n]],
    ['the count word gone', swap(lead, 'So the')(readme), shipped, ['README: 0 count words before the list, not one']],
    ['two count words', swap(lead, lead + ' or ' + more)(readme), shipped, ['README: 2 count words before the list, not one']],
    ['a definition the directory gains', readme, [...shipped, extra].sort(), [A + ' ships `' + extra + '`, which README does not name']],
    // A stale count of definitions in another section, below the shipped number and above it.
    ['a stale count below the shipped number', swap('## Usage\n', stale(fewer))(readme), shipped, ['README: "' + fewer + ' agent definitions", where ' + A + ' ships ' + n]],
    ['a stale count above the shipped number', swap('## Usage\n', stale(more))(readme), shipped, ['README: "' + more + ' agent definitions", where ' + A + ' ships ' + n]],
    // A stale count is held to what the directory ships, not to what the list names.
    ['a stale count beside a list as short', swap('## Usage\n', stale(fewer))(swap(', ' + closing, ' — do')(readme)), shipped,
      [A + ' ships `' + last + '`, which README does not name', 'README: "' + word + '" before a list of ' + (n - 1), 'README: "' + fewer + ' agent definitions", where ' + A + ' ships ' + n]],
    ["the list's closing words reworded", swap('— do **not**', '— **do not**')(readme), shipped, [NO_LIST]],
    ["the list's opening words copied", readme + '\n' + LIST[0] + '\n', shipped, [NO_LIST]],
    // Must pass: the count in digits, and a partitive "one of" that counts nothing.
    ['the count in digits', swap(lead, 'So the ' + n)(readme), shipped, []],
    ['a partitive "one of … definitions"', swap('## Usage\n', '## Usage\n\nEdit one of the definitions only between ledgers.\n')(readme), shipped, []],
  ], listFaults);
});

// ===== (b) Step 3's census paragraph, the §Census skeleton and the definition =========================================
// scaffolding.md step 3's census paragraph, from its bold lead to the next step.
const STEP_3 = ['**Census** — once the batches are drafted', '\n\n4. **Backlog sweep**'];
const HEADING = '## Census (scaffold time — read-only)';
const SPAWN = /^\*\*Spawn with\*\* `subagent_type: ([^`]+)`\.$/;
// Each way the census paragraph fails to point at the skeleton and the definition that ship it: it names no `census`
// type or no subagent-prompts.md §Census, that file holds no §Census heading or its spawn line names another type, or
// git tracks no .claude/agents/census.md.
function wiringFaults(scaffolding, prompts, files) {
  const faults = [], start = scaffolding.indexOf(STEP_3[0]), end = start === -1 ? -1 : scaffolding.indexOf(STEP_3[1], start);
  if (end === -1 || scaffolding.indexOf(STEP_3[0], start + 1) !== -1) faults.push(SCAFFOLDING + ': step 3 holds no census paragraph, once');
  else {
    const paragraph = collapse(scaffolding.slice(start, end));
    if (!paragraph.includes('`census` agent')) faults.push(SCAFFOLDING + ': the census paragraph names no `census` agent');
    if (!paragraph.includes('`subagent-prompts.md` §Census')) faults.push(SCAFFOLDING + ': the census paragraph names no `subagent-prompts.md` §Census');
  }
  const lines = prompts.split('\n'), at = lines.indexOf(HEADING);
  if (at === -1 || lines.indexOf(HEADING, at + 1) !== -1) faults.push(PROMPTS + ': no "' + HEADING + '" heading, once');
  else {
    const next = lines.findIndex((line, i) => i > at && line.startsWith('## '));
    const types = lines.slice(at + 1, next === -1 ? lines.length : next).map(line => SPAWN.exec(line)).filter(Boolean).map(m => m[1]);
    if (types.length !== 1) faults.push(PROMPTS + ': §Census holds ' + types.length + ' spawn lines, not one');
    else if (types[0] !== 'census') faults.push(PROMPTS + ': §Census spawns `' + types[0] + '`, not `census`');
  }
  if (!files.includes(DEFINITION)) faults.push(DEFINITION + ' is not tracked');
  return faults;
}

test("step 3's census paragraph names the census type and §Census, which subagent-prompts.md and .claude/agents/census.md hold", t => {
  const scaffolding = read(SCAFFOLDING), prompts = read(PROMPTS), files = tracked([AGENTS]);
  assert.deepEqual(wiringFaults(scaffolding, prompts, files), []);
  const twin = crlfTwin(t, [SCAFFOLDING, PROMPTS]);
  assert.deepEqual(wiringFaults(read(SCAFFOLDING, twin), read(PROMPTS, twin), files), [], 'a CRLF checkout reads alike');
  settle([
    ['the skeleton heading renamed', scaffolding, swap(HEADING + '\n', '## Census (scaffold time)\n')(prompts), files, [PROMPTS + ': no "' + HEADING + '" heading, once']],
    ['the skeleton heading copied', scaffolding, prompts + '\n' + HEADING + '\n', files, [PROMPTS + ': no "' + HEADING + '" heading, once']],
    ['the spawn line naming another type', scaffolding, swap('**Spawn with** `subagent_type: census`.', '**Spawn with** `subagent_type: reviewer`.')(prompts), files,
      [PROMPTS + ': §Census spawns `reviewer`, not `census`']],
    ['the spawn line gone', scaffolding, swap('**Spawn with** `subagent_type: census`.\n', '')(prompts), files, [PROMPTS + ': §Census holds 0 spawn lines, not one']],
    ['a second spawn line', scaffolding, swap('**Spawn with** `subagent_type: census`.\n', '**Spawn with** `subagent_type: census`.\n**Spawn with** `subagent_type: census`.\n')(prompts), files,
      [PROMPTS + ': §Census holds 2 spawn lines, not one']],
    // Must pass: §Census as the file's last section, its spawn line the last line.
    ['§Census the last section', scaffolding, prompts.slice(0, prompts.indexOf(HEADING)) + HEADING + '\n\n**Spawn with** `subagent_type: census`.', files, []],
    ['the paragraph naming another type', scaffolding.split('`census` agent').join('`reviewer` agent'), prompts, files,
      [SCAFFOLDING + ': the census paragraph names no `census` agent']],
    ['the paragraph pointing at another section', swap('`subagent-prompts.md` §Census', '`subagent-prompts.md` §Plan pre-flight')(scaffolding), prompts, files,
      [SCAFFOLDING + ': the census paragraph names no `subagent-prompts.md` §Census']],
    ['the paragraph gone', swap(STEP_3[0], '**Survey** — once the batches are drafted')(scaffolding), prompts, files, [SCAFFOLDING + ': step 3 holds no census paragraph, once']],
    ["the paragraph's lead copied", scaffolding + '\n' + STEP_3[0] + '\n', prompts, files, [SCAFFOLDING + ': step 3 holds no census paragraph, once']],
    ['the definition untracked', scaffolding, prompts, files.filter(file => file !== DEFINITION), [DEFINITION + ' is not tracked']],
  ], wiringFaults);
});

// ===== (c) No sentence lets one census agent cover several batches ===================================================
// tests/census-step.test.cjs's SEVERAL, copied (a test file is no module): a quantifier phrase over batches.
const SEVERAL = /\b(?:several|multiple|many|both|all|two or more|a (?:set|group|handful) of)\s+(?:(?:of|the|its|their|drafted|planned|wave['’]s|plan['’]s)\s+){0,3}batches\b|\b(?:a|the|each|every|one)\s+(?:wave|plan)['’]s\s+batches\b|\bbatches\s+of\s+(?:a|the|each|one)\s+(?:wave|plan)\b|\bper\s+(?:wave|plan|change|ledger)\b|\b(?:the\s+)?whole\s+(?:wave|plan|change)\b/i;
const NEVER = /\bnever\b/i;
// The senses of "census" that are not the agent, a closed list: check-ledger.mjs's census operation, the CENSUS line it
// prints, and the pre-flight's grep census. Every other "census", in any case, is the agent or its step.
const NOT_THE_AGENT = [
  ['check-ledger.mjs census', /\bcheck-ledger(?:\.mjs)?["']?\s+census\b/gi],
  ['a CENSUS line', /\bcensus\s+lines?\b/gi],
  ['grep census', /\bgrep\s+census\b/gi],
];
// The sentences of a text: its blocks, split at blank lines, list items and table rows (tests/census-step.test.cjs's
// BLOCKS, copied), each whitespace-collapsed with its code ticks dropped and cut after a full stop, question or
// exclamation mark.
const BLOCKS = /\n(?:[ \t]*\n)+|\n(?=[ \t]*(?:[-*]|\d+\.)[ \t])|\n(?=[ \t]*\|)/;
const sentencesOf = text => text.split(BLOCKS).flatMap(block => collapse(block.replace(/`/g, '')).trim().split(/(?<=[.!?]) /)).filter(Boolean);
// Whether `sentence` of `file` names the census agent: every sentence of its definition does, and elsewhere a "census"
// left once `senses` are taken out.
const namesAgent = (file, sentence, senses = NOT_THE_AGENT) => file === DEFINITION || /census/i.test(senses.reduce((rest, [, sense]) => rest.replace(sense, ' '), sentence));
// Whether some quantifier phrase in `sentence` has no `never` among the six words before it, inside its own clause.
const unnevered = sentence => [...sentence.matchAll(new RegExp(SEVERAL.source, 'gi'))].some(m => {
  const clause = sentence.slice(0, m.index).split(/[,;:()—]/).pop().trim();
  return !NEVER.test(clause.split(/\s+/).slice(-6).join(' '));
});
// Every sentence of `texts` (file → text) that names the census agent beside a quantifier phrase over batches no `never`
// governs, as `file: sentence`.
const sweepFaults = (texts, senses = NOT_THE_AGENT) => [...texts].flatMap(([file, text]) => sentencesOf(text)
  .filter(sentence => namesAgent(file, sentence, senses) && unnevered(sentence)).map(sentence => file + ': ' + sentence));
// The domain: every tracked file under orchestrate/ and .claude/agents/, of any type.
const sweepDomain = () => tracked(['orchestrate', AGENTS]);
const load = (files, root = ROOT) => new Map(files.map(file => [file, read(file, root)]));
// `texts` with `sentence` appended to `file` as a paragraph of its own.
const planted = (texts, file, sentence) => new Map([...texts, [file, texts.get(file) + '\n\n' + sentence + '\n']]);
// The one sentence of `file` holding `fragment`, read as the sweep reads it.
function sentenceWith(texts, file, fragment) {
  const found = sentencesOf(texts.get(file)).filter(sentence => sentence.includes(fragment));
  assert.equal(found.length, 1, file + ': one sentence must hold ' + JSON.stringify(fragment));
  return found[0];
}

test('no sentence of a tracked file under orchestrate/ or .claude/agents/ lets one census agent cover several batches', () => {
  const files = sweepDomain();
  assert.ok([SKILL, SCAFFOLDING, PROMPTS, 'orchestrate/tools/check-ledger.mjs', DEFINITION].every(file => files.includes(file)),
    'the domain must read the skill tree, its code and the definitions; found ' + files.length + ' files');
  const texts = load(files);
  assert.deepEqual(sweepFaults(texts), []);
  assert.ok(read('tests/census-step.test.cjs').includes('\nconst SEVERAL = ' + SEVERAL + ';\n'), "SEVERAL must be tests/census-step.test.cjs's, word for word");

  // Real carriers that pass: an upper-case "ALL" beside "batches", "batches" beside "all" in the definition, "ALL" beside
  // "mini-batches" in a census sentence, and "per wave" in a sentence whose only census is the pre-flight's grep census.
  const carriers = [
    [PROMPTS, 'THE DRAFT BATCH FILES: [ALL 02-batches-*.md TEXT]', s => /\bALL\b/.test(s) && /batches/.test(s) && s.includes('[PLAN, CITES AND CENSUS LINES]')],
    [DEFINITION, 'group in batches where it makes sense', s => namesAgent(DEFINITION, s) && /\ball\b/.test(s) && /\bbatches\b/.test(s)],
    [SKILL, "spawn ALL of the wave's implementers", s => namesAgent(SKILL, s) && /\bALL\b/.test(s) && /batches\b/.test(s)],
    [SCAFFOLDING, 'grep census of every symbol', s => SEVERAL.test(s) && !namesAgent(SCAFFOLDING, s)],
  ];
  assert.deepEqual(carriers.map(([file, fragment, holds]) => [fragment, holds(sentenceWith(texts, file, fragment))]), carriers.map(([, fragment]) => [fragment, true]),
    'each real carrier holds the words that would trip a sweep reading co-occurring words');
  assert.deepEqual(carriers.flatMap(([file, fragment]) => sweepFaults(new Map([[file, sentenceWith(texts, file, fragment)]]))), []);

  // Live: each sense excluded from the agent decides its own planted sentence, and only it; scaffolding.md's grep census
  // "per wave" is the real sentence one of them decides.
  const grepCensus = sentenceWith(texts, SCAFFOLDING, 'grep census of every symbol');
  const decided = [['Run check-ledger.mjs census on all batches.', 'check-ledger.mjs census'], ['The CENSUS line lists the files of all batches.', 'a CENSUS line'],
    ['A grep census reads all batches.', 'grep census'], [grepCensus, 'grep census']];
  assert.deepEqual(decided.map(([sentence]) => sweepFaults(new Map([[SCAFFOLDING, sentence]]))), decided.map(() => []), 'with every sense excluded, none is reported');
  assert.deepEqual(NOT_THE_AGENT.map(([dropped]) => [dropped, decided.filter(([sentence]) => sweepFaults(new Map([[SCAFFOLDING, sentence]]), NOT_THE_AGENT.filter(([sense]) => sense !== dropped)).length)
    .map(([, sense]) => sense)]), NOT_THE_AGENT.map(([dropped]) => [dropped, decided.filter(([, sense]) => sense === dropped).map(([, sense]) => sense)]),
  'dropping a sense reports exactly the sentences it decides');

  const S = SCAFFOLDING + ': ';
  settle([
    ['one census agent covering all batches', planted(texts, SCAFFOLDING, 'One census agent covers all batches.'), [S + 'One census agent covers all batches.']],
    ['the upper-case CENSUS agent', planted(texts, SCAFFOLDING, 'The read-only CENSUS agent reads several batches.'), [S + 'The read-only CENSUS agent reads several batches.']],
    ['a never in the clause before', planted(texts, SCAFFOLDING, 'Never mind the plan, one census agent covers several batches.'),
      [S + 'Never mind the plan, one census agent covers several batches.']],
    ['a never seven words back', planted(texts, SCAFFOLDING, 'Never let the one census agent cover several batches.'), [S + 'Never let the one census agent cover several batches.']],
    ['a never after the phrase', planted(texts, SCAFFOLDING, 'One census agent covers several batches, never one.'), [S + 'One census agent covers several batches, never one.']],
    ['a second phrase no never governs', planted(texts, SCAFFOLDING, 'Never give one census agent several batches; one may read all batches.'),
      [S + 'Never give one census agent several batches; one may read all batches.']],
    ['code ticks around the census', planted(texts, SCAFFOLDING, 'One `census` agent covers all batches.'), [S + 'One census agent covers all batches.']],
    ['a sentence wrapped across lines', planted(texts, SCAFFOLDING, 'One census agent may cover\n   several batches.'), [S + 'One census agent may cover several batches.']],
    ["the definition's description losing its never", new Map([...texts, [DEFINITION, swap('never give one agent several batches', 'give one agent several batches')(texts.get(DEFINITION))]]),
      [DEFINITION + ': Spawn one per batch; give one agent several batches.']],
    ['a sentence of the definition naming no census', planted(texts, DEFINITION, 'Give one agent several batches.'), [DEFINITION + ': Give one agent several batches.']],
    ['a sentence of a tool', planted(texts, 'orchestrate/tools/check-ledger.mjs', '// One census agent may read several batches.'),
      ['orchestrate/tools/check-ledger.mjs: // One census agent may read several batches.']],
    // Must pass: a never six words back, the window's far edge; the definition's sentence planted where no census is named;
    // and several batches in the sentence after a census sentence, or in the list item after one that ends unpunctuated.
    ['a never six words back', planted(texts, SCAFFOLDING, 'Never let one census agent cover several batches.'), []],
    ['the same sentence outside the definition', planted(texts, SCAFFOLDING, 'Give one agent several batches.'), []],
    ['several batches in the next sentence', planted(texts, SCAFFOLDING, 'Spawn one census agent per drafted batch. A wave may hold several batches.'), []],
    ['several batches in the next list item', planted(texts, SCAFFOLDING, '- Spawn one census agent per drafted batch\n- A wave may hold several batches.'), []],
  ], sweepFaults);
  // A never parted from the phrase by any clause break, or a word that only begins with "never", governs nothing.
  const parted = [',', ';', ':', '(', ')', '—'].map(mark => 'Never' + mark + ' one census agent covers several batches.').concat('Nevertheless one census agent covers several batches.');
  assert.deepEqual(parted.filter(sentence => sweepFaults(new Map([[SCAFFOLDING, sentence]])).length !== 1), [], 'each must be reported');
  // Every form of the quantifier phrase, each in a census sentence of its own, is reported.
  const forms = ['several batches', 'multiple batches', 'many batches', 'both batches', 'all the batches', 'two or more batches', 'a set of batches', 'a group of batches',
    'a handful of batches', "the wave's batches", "the plan’s batches", 'the batches of a wave', 'one per wave', 'one per plan', 'one per change', 'one per ledger',
    'the whole wave', 'the whole plan', 'the whole change'];
  assert.deepEqual(forms.filter(form => sweepFaults(new Map([[SCAFFOLDING, 'One census agent reads ' + form + '.']])).length !== 1), [], 'every form of the phrase is read');
});

// ===== (d) README's `/orchestrate new` row and precondition 5 ========================================================
const NEW_ROW = '| `/orchestrate new <description>` |';
const PRECONDITIONS = ['\n## Preconditions\n', '\n## Procedure\n'];
const CONTEXT = '5. **Context.**';
// Whether scaffolding.md's §Preconditions holds precondition 5, or null when that section cannot be found.
function holdsContext(scaffolding) {
  const start = scaffolding.indexOf(PRECONDITIONS[0]), end = start === -1 ? -1 : scaffolding.indexOf(PRECONDITIONS[1], start);
  return end === -1 ? null : scaffolding.slice(start, end).split('\n').some(line => line.startsWith(CONTEXT));
}
// Each way README's `/orchestrate new` row and scaffolding.md's preconditions disagree: the row offers a fresh
// conversation without precondition 5 or omits it beside one, or its description states a number; that row only, since
// README's §Mods says "fresh conversation" too.
function rowFaults(readme, scaffolding) {
  const rows = readme.split('\n').filter(line => line.startsWith(NEW_ROW));
  if (rows.length !== 1) return ['README: ' + rows.length + ' `/orchestrate new` rows, not one'];
  const holds = holdsContext(scaffolding);
  if (holds === null) return [SCAFFOLDING + ': no §Preconditions before §Procedure'];
  const offers = /\bfresh conversation\b/i.test(rows[0]), faults = [];
  if (offers && !holds) faults.push("README's `new` row offers a fresh conversation, and " + SCAFFOLDING + ' holds no precondition ' + CONTEXT);
  if (holds && !offers) faults.push(SCAFFOLDING + ' holds precondition ' + CONTEXT + ", and README's `new` row offers no fresh conversation");
  for (const m of rows[0].slice(NEW_ROW.length).matchAll(/\S*\d\S*/g)) faults.push("README's `new` row states a number: " + m[0]);
  return faults;
}
// SKILL.md's Mode: new list of preconditions, from its "then: preconditions (…)".
const SKILL_PRECONDITIONS = /\bthen: preconditions \(([^)]*)\)/g;
// Each way SKILL.md's Mode: new and scaffolding.md's preconditions disagree: the list names "context" without
// precondition 5, or omits it beside one.
function skillFaults(skill, scaffolding) {
  const lists = [...collapse(skill).matchAll(SKILL_PRECONDITIONS)].map(m => m[1].split('; '));
  if (lists.length !== 1) return [SKILL + ': ' + lists.length + ' lists of preconditions in Mode: new, not one'];
  const holds = holdsContext(scaffolding);
  if (holds === null) return [SCAFFOLDING + ': no §Preconditions before §Procedure'];
  const names = lists[0].includes('context');
  if (names && !holds) return [SKILL + "'s preconditions name context, and " + SCAFFOLDING + ' holds no precondition ' + CONTEXT];
  if (holds && !names) return [SCAFFOLDING + ' holds precondition ' + CONTEXT + ', and ' + SKILL + "'s preconditions name no context"];
  return [];
}

test("README's new row offers a fresh conversation exactly when scaffolding.md holds precondition 5, and states no number", t => {
  const readme = read(README), scaffolding = read(SCAFFOLDING);
  assert.deepEqual(rowFaults(readme, scaffolding), []);
  const twin = crlfTwin(t, [README, SCAFFOLDING]);
  assert.deepEqual(rowFaults(read(README, twin), read(SCAFFOLDING, twin)), [], 'a CRLF checkout reads alike');
  const offer = 'Offer a fresh conversation first when this one already holds much earlier work; then interview', bare = 'Interview';
  const at = scaffolding.indexOf(CONTEXT), cut = scaffolding.indexOf('\n\n## Procedure', at);
  assert.ok(at !== -1 && cut > at, 'the control needs precondition 5 before §Procedure');
  const withoutContext = scaffolding.slice(0, at) + scaffolding.slice(cut + 1);
  assert.ok(readme.slice(readme.indexOf('## Mods')).includes('fresh conversation'), "README's §Mods says it too, so the controls below prove the row alone counts");
  const OFFERS = "README's `new` row offers a fresh conversation, and " + SCAFFOLDING + ' holds no precondition ' + CONTEXT;
  const OMITS = SCAFFOLDING + ' holds precondition ' + CONTEXT + ", and README's `new` row offers no fresh conversation";
  settle([
    ["the row's offer dropped", swap(offer, bare)(readme), scaffolding, [OMITS]],
    ['precondition 5 dropped', readme, withoutContext, [OFFERS]],
    ['precondition 5 moved past §Procedure', readme, withoutContext + '\n' + CONTEXT + ' Elsewhere.\n', [OFFERS]],
    ['a number in the row', swap('much earlier work', 'past about 200K of earlier work')(readme), scaffolding, ["README's `new` row states a number: 200K"]],
    ['the row copied', readme.replace(NEW_ROW, () => NEW_ROW + ' x |\n' + NEW_ROW), scaffolding, ['README: 2 `/orchestrate new` rows, not one']],
    ['the row gone', swap(NEW_ROW, '| `/orchestrate new` |')(readme), scaffolding, ['README: 0 `/orchestrate new` rows, not one']],
    ['§Preconditions renamed', readme, swap(PRECONDITIONS[0], '\n## Before you start\n')(scaffolding), [SCAFFOLDING + ': no §Preconditions before §Procedure']],
    // Must pass: both dropped, the neither half of both or neither.
    ['both dropped', swap(offer, bare)(readme), withoutContext, []],
  ], rowFaults);
});

test("SKILL.md's Mode: new names the context precondition exactly when scaffolding.md holds precondition 5", t => {
  const skill = read(SKILL), scaffolding = read(SCAFFOLDING);
  assert.deepEqual(skillFaults(skill, scaffolding), []);
  const twin = crlfTwin(t, [SKILL, SCAFFOLDING]);
  assert.deepEqual(skillFaults(read(SKILL, twin), read(SCAFFOLDING, twin)), [], 'a CRLF checkout reads alike');
  const at = scaffolding.indexOf(CONTEXT), cut = scaffolding.indexOf('\n\n## Procedure', at);
  assert.ok(at !== -1 && cut > at, 'the control needs precondition 5 before §Procedure');
  const withoutContext = scaffolding.slice(0, at) + scaffolding.slice(cut + 1), unnamed = swap('tree state; context)', 'tree state)')(skill);
  settle([
    ["SKILL.md's context dropped", unnamed, scaffolding, [SCAFFOLDING + ' holds precondition ' + CONTEXT + ', and ' + SKILL + "'s preconditions name no context"]],
    ['precondition 5 dropped', skill, withoutContext, [SKILL + "'s preconditions name context, and " + SCAFFOLDING + ' holds no precondition ' + CONTEXT]],
    ['precondition 5 moved past §Procedure', skill, withoutContext + '\n' + CONTEXT + ' Elsewhere.\n',
      [SKILL + "'s preconditions name context, and " + SCAFFOLDING + ' holds no precondition ' + CONTEXT]],
    ['the list gone', swap('then: preconditions (', 'then: checks (')(skill), scaffolding, [SKILL + ': 0 lists of preconditions in Mode: new, not one']],
    ['the list copied', skill + '\nthen: preconditions (git repo)\n', scaffolding, [SKILL + ': 2 lists of preconditions in Mode: new, not one']],
    ['§Preconditions renamed', skill, swap(PRECONDITIONS[0], '\n## Before you start\n')(scaffolding), [SCAFFOLDING + ': no §Preconditions before §Procedure']],
    // "context" is read as a whole item, never inside a longer one.
    ['a longer item holding the word', swap('tree state; context)', 'tree state; context window)')(skill), scaffolding,
      [SCAFFOLDING + ' holds precondition ' + CONTEXT + ', and ' + SKILL + "'s preconditions name no context"]],
    // Must pass: both dropped, the neither half of both or neither.
    ['both dropped', unnamed, withoutContext, []],
  ], skillFaults);
});

// ===== (e) README's other census mentions ===========================================================================
// How it works step 1, and the one sentence of it that names the census agent, pinned whole.
const STEP_1 = ['1. **A locked plan, pre-flighted.**', '\n2. **A file fence, checked mechanically.**'];
const STEP_1_CENSUS = 'Each drafted batch first gets its own read-only census agent, whose report opens with where the draft is wrong or '
  + 'incomplete, then names the tests that read every file the batch changes and what the backlog and old ledgers already record '
  + 'about them; each opening item is logged as carried or rejected.';
// README's `/orchestrate new` row, pinned whole, its whitespace collapsed.
const NEW_ROW_TEXT = '| `/orchestrate new <description>` | Offer a fresh conversation first when this one already holds much earlier work; then '
  + 'interview, plan the batches, run a census of each batch, sweep the backlog, pre-flight the plan, scaffold the ledger, stop for your approval |';
// The rows README's tree shares with SKILL.md's list of the skill's files: [the file, SKILL.md's row from its lead to the
// next row, the words SKILL.md's row adds at its end].
const REFERENCE_ROWS = [
  ['scaffolding.md', ['- [references/scaffolding.md](references/scaffolding.md) —', '\n- [references/subagent-prompts.md]'], ', self-check'],
  ['subagent-prompts.md', ['- [references/subagent-prompts.md](references/subagent-prompts.md) —', '\n- [references/smoke-page.md]'], ''],
];
const TREE_ROW = /^│ {3}[├└]── /;
// Each README mention of the census that differs from its pin or from SKILL.md: step 1's sentences naming the census
// agent, the `new` row, and each shared tree row, which must be SKILL.md's row less the words SKILL.md's adds.
function mentionFaults(readme, skill) {
  const faults = [], start = readme.indexOf(STEP_1[0]), end = start === -1 ? -1 : readme.indexOf(STEP_1[1], start);
  if (end === -1) faults.push('README: no How it works step 1 before step 2');
  else {
    const said = sentencesOf(readme.slice(start, end)).filter(sentence => namesAgent(README, sentence));
    if (said.length !== 1 || said[0] !== STEP_1_CENSUS) faults.push('README step 1 names the census agent in: ' + (said.join(' | ') || 'no sentence'));
  }
  const rows = readme.split('\n').filter(line => line.startsWith(NEW_ROW)).map(line => collapse(line).trim());
  if (rows.length !== 1 || rows[0] !== NEW_ROW_TEXT) faults.push("README's `new` row reads: " + (rows.join(' | ') || 'no row'));
  for (const [file, [from, to], adds] of REFERENCE_ROWS) {
    const tree = readme.split('\n').map(line => [line, TREE_ROW.exec(line)]).filter(([line, m]) => m !== null && line.slice(m[0].length).split(' ')[0] === file)
      .map(([line, m]) => line.slice(m[0].length + file.length).trim());
    const at = skill.indexOf(from), stop = at === -1 ? -1 : skill.indexOf(to, at);
    if (tree.length !== 1) faults.push('README: ' + tree.length + ' tree rows for ' + file + ', not one');
    else if (stop === -1) faults.push(SKILL + ': no row for ' + file);
    else if (tree[0] + adds !== collapse(skill.slice(at + from.length, stop)).trim()) {
      faults.push("README's tree row for " + file + ' is not ' + SKILL + "'s" + (adds ? ' less "' + adds + '"' : '') + ': ' + tree[0]);
    }
  }
  return faults;
}

test("README's other census mentions are pinned whole or bound to SKILL.md's rows", t => {
  const readme = read(README), skill = read(SKILL);
  assert.deepEqual(mentionFaults(readme, skill), []);
  const twin = crlfTwin(t, [README, SKILL]);
  assert.deepEqual(mentionFaults(read(README, twin), read(SKILL, twin)), [], 'a CRLF checkout reads alike');
  const STEP = 'README step 1 names the census agent in: ', ROW = "README's `new` row reads: ";
  const scaffoldingRow = 'interview, census, backlog sweep', skeletonsRow = 'artifact proofer / census / ';
  settle([
    ['the step 1 sentence naming no census', swap('read-only census agent, whose', 'read-only agent, whose')(readme), skill, [STEP + 'no sentence']],
    ['a word of the step 1 sentence altered', swap('logged as carried or rejected.', 'logged as carried.')(readme), skill, [STEP + STEP_1_CENSUS.replace(' or rejected.', '.')]],
    ['a census sentence added to step 1', swap('logged as carried or rejected.', 'logged as carried or rejected. Skip the census when in a hurry.')(readme), skill,
      [STEP + STEP_1_CENSUS + ' | Skip the census when in a hurry.']],
    ["the new row's census dropped", swap('run a census of each batch, ', '')(readme), skill, [ROW + NEW_ROW_TEXT.replace('run a census of each batch, ', '')]],
    ['a clause appended to the new row', swap('stop for your approval |', 'stop for your approval; skip the census for one batch |')(readme), skill,
      [ROW + NEW_ROW_TEXT.replace('stop for your approval |', 'stop for your approval; skip the census for one batch |')]],
    ["README's scaffolding.md row losing the census", swap(scaffoldingRow, 'interview, backlog sweep')(readme), skill,
      ["README's tree row for scaffolding.md is not " + SKILL + '\'s less ", self-check": detection heuristics, interview, backlog sweep, pre-flight, placeholder registry']],
    ["README's scaffolding.md row losing its last item", swap('backlog sweep, pre-flight, placeholder registry\n', 'backlog sweep, pre-flight\n')(readme), skill,
      ["README's tree row for scaffolding.md is not " + SKILL + '\'s less ", self-check": detection heuristics, interview, census, backlog sweep, pre-flight']],
    ["README's subagent-prompts.md row losing the census", swap(skeletonsRow, 'artifact proofer / ')(readme), skill,
      ["README's tree row for subagent-prompts.md is not " + SKILL + "'s: implementer / reviewer / test hunter / QA runner / artifact proofer / pre-flight / convergence / fix-up skeletons"]],
    ["SKILL.md's scaffolding.md row losing the census", readme, swap('interview, census, backlog sweep, pre-flight, placeholder registry, self-check', 'interview, backlog sweep, pre-flight, placeholder registry, self-check')(skill),
      ["README's tree row for scaffolding.md is not " + SKILL + '\'s less ", self-check": detection heuristics, interview, census, backlog sweep, pre-flight, placeholder registry']],
    ["README's scaffolding.md row gone", swap('│   ├── scaffolding.md ', '│   ├── scaffold.md ')(readme), skill, ['README: 0 tree rows for scaffolding.md, not one']],
    ["SKILL.md's subagent-prompts.md row gone", readme, swap('- [references/subagent-prompts.md](references/subagent-prompts.md) —', '- [references/subagent-prompts.md](references/subagent-prompts.md):')(skill),
      [SKILL + ': no row for subagent-prompts.md']],
    // Must pass: the same item added to both rows, which bind, not pin, the shared list.
    ['an item added to both scaffolding.md rows', swap(scaffoldingRow, 'interview, census, gamma, backlog sweep')(readme),
      swap('interview, census, backlog sweep, pre-flight, placeholder registry, self-check', 'interview, census, gamma, backlog sweep, pre-flight, placeholder registry, self-check')(skill), []],
  ], mentionFaults);
});

// ===== One checkout, every rule ======================================================================================
test('a CRLF checkout of every file the rules read reaches the verdicts of its LF original', t => {
  const files = sweepDomain(), all = [...new Set([README, ...files])], twin = crlfTwin(t, all);
  assert.deepEqual(all.filter(file => read(file).includes('\n') && !fs.readFileSync(path.join(twin, file), 'utf8').includes('\r\n')), [], 'every copy is CRLF');
  const verdicts = root => {
    const texts = load(files, root), readme = read(README, root);
    return [listFaults(readme, definitions()), wiringFaults(texts.get(SCAFFOLDING), texts.get(PROMPTS), tracked([AGENTS])), sweepFaults(texts),
      rowFaults(readme, texts.get(SCAFFOLDING)), skillFaults(texts.get(SKILL), texts.get(SCAFFOLDING)), mentionFaults(readme, texts.get(SKILL))];
  };
  assert.deepEqual(verdicts(twin), verdicts(ROOT));
  // Live: a sentence planted in the CRLF copy on disk, wrapped across a line, is read back as its LF original reads.
  const sentence = 'One census agent may cover\nseveral batches.';
  fs.appendFileSync(path.join(twin, SCAFFOLDING), crlf('\n' + sentence + '\n'));
  assert.deepEqual(sweepFaults(load(files, twin)), sweepFaults(planted(load(files), SCAFFOLDING, sentence)));
  assert.deepEqual(sweepFaults(load(files, twin)), [SCAFFOLDING + ': One census agent may cover several batches.']);
});
