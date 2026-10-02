'use strict';
// The skill names every tool this change added by the command that runs it, at the step that uses
// it, and says what each tool prints in the tool's own terms. Each binding reads both sides from the
// checkout — the shipped documents, and the tool's --help, flag parser, exports or a run of it — so a
// drift on either side goes red, and each carries a live control showing that it can. The new
// passages are pinned whole, as tests/tool-wiring.test.cjs `PINNED` pins its own, and a clause sweep
// over the shipped Markdown, README and the agent definitions reports a directive that reverses them.
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');
const { makeRepo } = require('./support/git-fixture.cjs');

const ROOT = path.resolve(__dirname, '..');
const SKILL_DIR = path.join(ROOT, 'orchestrate');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const collapse = text => text.replace(/\s+/g, ' ');
const load = name => import(pathToFileURL(path.join(SKILL_DIR, 'tools', name)).href);
const SKILL = 'orchestrate/SKILL.md', PROTOCOL = 'orchestrate/references/protocol.md';
const SCAFFOLDING = 'orchestrate/references/scaffolding.md', PROMPTS = 'orchestrate/references/subagent-prompts.md';
const PLAN_TEMPLATE = 'orchestrate/templates/01-plan.md', BATCH_TEMPLATE = 'orchestrate/templates/02-batch.md';

// The text from an anchor occurring exactly once up to the first `to` after it, whitespace collapsed.
function between(text, from, to, label) {
  assert.equal(text.split(from).length - 1, 1, label + ': the anchor "' + from + '" must occur exactly once');
  const start = text.indexOf(from), end = text.indexOf(to, start + from.length);
  assert.ok(end > start, label + ': "' + to + '" must follow "' + from + '"');
  return collapse(text.slice(start, end)).trim();
}
function tmp(t) {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'tool-docs-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }));
  return dir;
}
function writeTree(dir, files) {
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
  return dir;
}
// A tool's --help, run as the documents publish it once `<skill-dir>` is this checkout's orchestrate/.
const helps = new Map();
function helpOf(tool) {
  if (!helps.has(tool)) {
    const r = spawnSync(process.execPath, [path.join(SKILL_DIR, 'tools', tool), '--help'], { encoding: 'utf8', windowsHide: true, timeout: 60000 });
    assert.ifError(r.error);
    assert.equal(r.status, 0, tool + ' --help must exit 0: ' + r.stdout + r.stderr);
    helps.set(tool, r.stdout);
  }
  return helps.get(tool);
}

// ===== Every new tool, by a command that runs, at the step that uses it ==========================
// The tools this change added, and the operations it added to check-ledger.mjs beside parse and skill.
const NEW_TOOLS = ['detect.mjs', 'env-facts.mjs', 'failing-on-base.mjs', 'reconcile.mjs', 'scaffold.mjs'];
const NEW_OPERATIONS = { 'check-ledger.mjs': ['selfcheck', 'plan', 'cites', 'census'] };
// A published skill-tool command: one code span running `node "<skill-dir>/tools/<name>.mjs" …`, or
// `<SKILL_DIR>` as scaffolding.md spells the directory.
const COMMAND = /`node "(?:<skill-dir>|<SKILL_DIR>)\/tools\/([a-z-]+\.mjs)"((?: [^`]+)?)`/g;
// Arguments as a shell would split them once each `<placeholder>` is filled: a placeholder holding a
// space (`<draft answers>`) stays inside its argument.
const argsOf = text => text.match(/(?:[^\s<]|<[^>]*>)+/g) || [];
const commandsIn = text => [...collapse(text).matchAll(COMMAND)].map(m => ({ tool: m[1], args: argsOf(m[2]), span: m[0] }));
const isNew = c => NEW_TOOLS.includes(c.tool) || (NEW_OPERATIONS[c.tool] || []).includes(c.args[0]);
// Where each tool is used, so where its command is published: [the use, file, from, to, tool, operation].
const PLACEMENTS = [
  ['the discovery summary', SKILL, '## Discovery (every mode starts here)', '\n1. Find ledgers', 'reconcile.mjs', 'discovery'],
  ['the boot reconcile', SKILL, '3. Boot (a pinned contract verifies its skill pin first)', '\n## Mode: status', 'reconcile.mjs', 'rows'],
  ['status mode', SKILL, '## Mode: status', '\n## Mode: close', 'reconcile.mjs', 'rows'],
  ['the §Recovery reconcile', PROTOCOL, 'Rows are matched top to bottom; the first match wins.', '\n| Ledger says |', 'reconcile.mjs', 'rows'],
  ['step 6b', PROTOCOL, '- **6b Failing-on-base', '\n   - **6c Reviewer', 'failing-on-base.mjs', null],
  ['detection', SCAFFOLDING, '1. **Detect**', '\n2. **Interview**', 'detect.mjs', null],
  ['the environment facts', SCAFFOLDING, '1. **Detect**', '\n2. **Interview**', 'env-facts.mjs', null],
  ['the pre-flight draft', SCAFFOLDING, '5. **Pre-flight**', '\n6. **Front-load', 'scaffold.mjs', null],
  ['the pre-flight plan check', SCAFFOLDING, '5. **Pre-flight**', '\n6. **Front-load', 'check-ledger.mjs', 'plan'],
  ['the pre-flight citation check', SCAFFOLDING, '5. **Pre-flight**', '\n6. **Front-load', 'check-ledger.mjs', 'cites'],
  ['the pre-flight census', SCAFFOLDING, '5. **Pre-flight**', '\n6. **Front-load', 'check-ledger.mjs', 'census'],
  ['the fill', SCAFFOLDING, '8. **Fill**', '\n9. **Self-check**', 'scaffold.mjs', null],
  ['the self-check', SCAFFOLDING, '9. **Self-check**', '\n10. **Scaffold commit**', 'check-ledger.mjs', 'selfcheck'],
];
const placed = (text, tool, op) => commandsIn(text).some(c => c.tool === tool && (op === null || c.args[0] === op));
// What --help documents for one invocation: the synopsis naming the operation when the tool has several
// (`<tool> <op> …`, or `<op> …` after a `|`), else its first line; its flags, and those not bracketed as optional.
function synopsisOf(help, tool, op) {
  const segments = help.split('\n').flatMap(line => line.split(' | ')).map(s => s.trim());
  const found = op === null ? [segments[0]] : segments.filter(s => s.startsWith(tool + ' ' + op + ' ') || s.startsWith(op + ' '));
  if (found.length !== 1) return null;
  const flags = text => [...new Set(text.match(/--[a-z][a-z-]*/g) || [])];
  return { documented: flags(found[0]), required: flags(found[0].replace(/\[[^\]]*\]/g, '')) };
}
// A tool takes an operation first when the first line of its --help names one after the tool.
const takesOperation = (help, tool) => !help.split('\n')[0].startsWith(tool + ' --');
// Why a published command would not run as its tool documents it: an operation --help does not name, a
// flag it does not document, or a flag it requires that the command leaves out.
function commandFaults(command, help) {
  const op = takesOperation(help, command.tool) ? command.args[0] : null;
  const synopsis = synopsisOf(help, command.tool, op);
  if (!synopsis) return [command.span + ': --help documents no operation ' + op];
  const used = command.args.filter(a => a.startsWith('--'));
  return [...used.filter(f => !synopsis.documented.includes(f)).map(f => command.span + ': --help documents no ' + f),
    ...synopsis.required.filter(f => !used.includes(f)).map(f => command.span + ': leaves out the required ' + f)];
}
const referenceDocs = () => [SKILL, ...fs.readdirSync(path.join(SKILL_DIR, 'references')).filter(n => n.endsWith('.md')).sort().map(n => 'orchestrate/references/' + n)];

test('every new tool is published by a command that runs, at each step that uses it', () => {
  for (const tool of NEW_TOOLS) assert.ok(fs.existsSync(path.join(SKILL_DIR, 'tools', tool)), 'a new tool the checkout ships: ' + tool);
  for (const [what, file, from, to, tool, op] of PLACEMENTS) {
    const text = between(read(file), from, to, file);
    assert.ok(placed(text, tool, op), file + ' (' + what + '): must publish `node "<skill-dir>/tools/' + tool + '"' + (op ? ' ' + op : '') + ' …`');
    // Live control: the same passage with that tool's commands taken out is reported.
    assert.ok(!placed(text.split('/tools/' + tool + '"').join('/tools/elsewhere.mjs"'), tool, op), what + ': the control must lose the command');
  }
  // The domain is every command the skill's own documents publish for a new tool or operation.
  const published = referenceDocs().flatMap(file => commandsIn(read(file)).map(c => ({ ...c, file }))).filter(isNew);
  for (const tool of NEW_TOOLS) assert.ok(published.some(c => c.tool === tool), 'published somewhere: ' + tool);
  for (const [tool, ops] of Object.entries(NEW_OPERATIONS)) for (const op of ops) assert.ok(published.some(c => c.tool === tool && c.args[0] === op), 'published: ' + tool + ' ' + op);
  for (const command of published) assert.deepEqual(commandFaults(command, helpOf(command.tool)), [], command.file);
  // Live controls: a flag --help does not document, a required flag left out, an operation it lacks.
  const rows = published.find(c => c.tool === 'reconcile.mjs' && c.args[0] === 'rows');
  const fob = published.find(c => c.tool === 'failing-on-base.mjs');
  assert.match(commandFaults({ ...rows, args: [...rows.args, '--bogus', 'x'] }, helpOf('reconcile.mjs')).join(), /documents no --bogus/);
  assert.match(commandFaults({ ...fob, args: fob.args.filter((a, i, all) => a !== '--log' && all[i - 1] !== '--log') }, helpOf('failing-on-base.mjs')).join(), /leaves out the required --log/);
  assert.match(commandFaults({ ...rows, args: ['summary', ...rows.args.slice(1)] }, helpOf('reconcile.mjs')).join(), /documents no operation summary/);
});

// Each tool's CLI entry as its module exports it, and the first line of what it returns.
const CLI = {
  'check-ledger.mjs': ['ledgerCli', r => r.line], 'reconcile.mjs': ['reconcileCli', r => r.lines[0]],
  'detect.mjs': ['detectCli', r => r.text.split('\n')[0]], 'env-facts.mjs': ['envFactsCli', r => r.text.split('\n')[0]],
  'scaffold.mjs': ['scaffoldCli', r => r.line], 'failing-on-base.mjs': ['failingOnBaseCli', r => r.line],
};
// Placeholder values of the shape each flag takes — ids and refs that parse, directories that hold
// nothing, paths that name nothing — so that only a tool's own flag parser can refuse a command.
const SHAPED = { '<id>': 'TD-20990101-sample', '<CHANGE_ID>': 'TD-20990101-sample', '<full-ref>': 'refs/heads/chore/sample-ledger',
  '<integration-ref>': 'refs/heads/chore/sample-ledger', '<batch-ref>': 'refs/heads/feat/one' };
const EMPTY_DIRS = ['<repo>', '<root>', '<scratch worktree>'];
const filledArgs = (args, dir) => args.map(a => a.replace(/<[^>]*>/g, p => SHAPED[p]
  ?? (EMPTY_DIRS.includes(p) ? dir : path.join(dir, 'absent-' + p.slice(1, -1).replace(/\W+/g, '-')))));
// env-facts.mjs `realProbes` stood in for, so the parse is all that runs for real.
const NO_PROBES = { platform: 'linux', release: '0', env: { PATH: '' }, node: 'v0', tmpdir: os.tmpdir(), run: () => ({ ok: false, text: '' }),
  executable: () => false, readText: () => null, realpath: () => null, bash: () => null };
async function parsedLine(command, dir) {
  const [name, first] = CLI[command.tool], entry = (await load(command.tool))[name];
  return first(await entry(filledArgs(command.args, dir), ...(command.tool === 'env-facts.mjs' ? [NO_PROBES] : [])));
}
// Why a published command's line is a refusal: it says usage, or it is the very line its tool gives
// for the same command with `--bogus x` appended — the tool's own refusal, compared whole, since a
// refusal need not say usage.
async function parserFaults(command, dir) {
  const line = await parsedLine(command, dir), refusal = await parsedLine({ ...command, args: [...command.args, '--bogus', 'x'] }, dir);
  assert.match(refusal, /^UNKNOWN /, command.span + ': --bogus x must be refused for the comparison to mean anything');
  return [...(/^UNKNOWN usage/.test(line) ? ['a usage refusal: ' + line] : []), ...(line === refusal ? ['its tool\'s own refusal: ' + line] : [])];
}
test('each published command is accepted by its own tool\'s flag parser', async t => {
  const dir = tmp(t);
  const published = referenceDocs().flatMap(file => commandsIn(read(file)).map(c => ({ ...c, file }))).filter(isNew);
  assert.ok(published.length >= 12 && Object.keys(CLI).every(tool => published.some(c => c.tool === tool)), 'every new tool has a published command to feed its parser');
  for (const command of published) {
    const line = await parsedLine(command, dir);
    assert.ok(typeof line === 'string' && line.length > 0, command.span + ': the entry answered');
    assert.doesNotMatch(line, /^UNKNOWN usage/, command.file + ': ' + command.span + ' → ' + line);
    assert.deepEqual(await parserFaults(command, dir), [], command.file + ': ' + command.span);
  }
  // Live control: the rows command with a flag its parser does not take is refused as usage.
  const rows = published.find(c => c.tool === 'reconcile.mjs' && c.args[0] === 'rows');
  assert.match(await parsedLine({ ...rows, args: rows.args.map(a => a === '--integration' ? '--tip' : a) }, dir), /^UNKNOWN usage/);
  // Live controls, one per tool: `--repo` renamed in its first published command that takes it is
  // reported as that tool's own refusal.
  for (const tool of Object.keys(CLI)) {
    const command = published.find(c => c.tool === tool && c.args.includes('--repo'));
    assert.ok(command, tool + ': a published command with --repo');
    const faults = await parserFaults({ ...command, args: command.args.map(a => a === '--repo' ? '--root' : a) }, dir);
    assert.ok(faults.some(f => f.startsWith('its tool\'s own refusal: ')), tool + ': --repo renamed must be reported: ' + faults.join('; '));
  }
});

test('SKILL.md Mode new names the tools at their steps, in the order the chain runs them', () => {
  const chain = between(read(SKILL), '## Mode: new', '\n## Mode: continue', SKILL);
  const ORDER = ['detect repo facts', '"<skill-dir>/tools/detect.mjs" --repo', '"<skill-dir>/tools/env-facts.mjs" --repo', '→ interview (',
    '→ plan checks on a draft', '"<skill-dir>/tools/scaffold.mjs" --answers <draft answers>', '→ independent plan PRE-FLIGHT',
    '→ fill the templates', '"<skill-dir>/tools/scaffold.mjs" --answers <file>', '→ self-check (', '"<skill-dir>/tools/check-ledger.mjs" selfcheck',
    '→ scaffold commit on'];
  const faults = text => ORDER.flatMap((step, i) => {
    const at = text.split(step).length - 1 === 1 ? text.indexOf(step) : -1;
    return at === -1 ? [step + ': not exactly once'] : i && at < text.indexOf(ORDER[i - 1]) ? [step + ': before ' + ORDER[i - 1]] : [];
  });
  assert.deepEqual(faults(chain), []);
  // Live control: the self-check command moved ahead of the fill is reported.
  const moved = chain.replace(' → fill the templates', ' → `node "<skill-dir>/tools/check-ledger.mjs" selfcheck` → fill the templates')
    .replace('; `node "<skill-dir>/tools/check-ledger.mjs" selfcheck --dir <ledger-dir>` runs all of these at once', '');
  assert.notEqual(moved, chain);
  assert.ok(faults(moved).length > 0, 'the order reader must see a moved step');
});

// ===== scaffolding.md step 8 documents the answers file scaffold.mjs enforces ====================
// The placeholders of one template outside its instruction comments, read here with no code shared
// with the tool.
const placeholdersOf = file => [...new Set([...read(file).replace(/<!--[\s\S]*?-->/g, '').matchAll(/\{\{([A-Z0-9_]+)\}\}/g)].map(m => m[1]))];
const spansIn = text => [...text.matchAll(/`([A-Z0-9_]+)`/g)].map(m => m[1]);
// Every way step 8's text and the enforced domain disagree: the keys its bullets give, in order; the
// computed values; and the naming-only values that no template carries.
function answersDrift(fillText, domain) {
  const problems = [], at = fillText.indexOf('schema version 1');
  if (at === -1) return ['step 8 names no schema version 1 answers file'];
  const bullets = [...fillText.slice(at).matchAll(/^ {3}- `([a-z]+)` — ((?:.|\n {5})*)/gm)].map(m => ({ key: m[1], text: collapse(m[2]) }));
  const keys = bullets.map(b => b.key);
  if (JSON.stringify(keys) !== JSON.stringify(domain.keys)) problems.push('keys ' + keys.join(', ') + '; scaffold.mjs takes ' + domain.keys.join(', '));
  const bullet = key => (bullets.find(b => b.key === key) || { text: '' }).text;
  const computed = /; ((?:`[A-Z0-9_]+`(?:, | and )?)+) are computed/.exec(bullet('values'));
  if (!computed || JSON.stringify(spansIn(computed[1])) !== JSON.stringify(domain.values.computed)) problems.push('computed values differ from ' + domain.values.computed.join(', '));
  const templates = fs.readdirSync(path.join(SKILL_DIR, 'templates')).map(n => 'orchestrate/templates/' + n);
  const inTemplates = new Set(templates.filter(f => f !== BATCH_TEMPLATE).flatMap(placeholdersOf)), inBatch = new Set(placeholdersOf(BATCH_TEMPLATE));
  for (const [key, required, carried] of [['values', domain.values.required, inTemplates], ['batches', domain.batches.values, inBatch]]) {
    const named = /plus the naming-only ((?:`[A-Z0-9_]+`(?:, | and )?)+)/.exec(bullet(key));
    const naming = required.filter(k => !carried.has(k));
    if (!named || JSON.stringify(spansIn(named[1]).sort()) !== JSON.stringify(naming.sort())) problems.push(key + ': the naming-only values are ' + naming.join(', '));
  }
  return problems;
}
test('scaffolding.md step 8 documents exactly the answers-file keys scaffold.mjs enforces', async () => {
  const { answersDomain } = await load('scaffold.mjs');
  const domain = answersDomain();
  assert.ok(domain.keys.includes('values') && domain.keys.includes('foldins') && domain.values.computed.length > 0, 'the domain was really read');
  const text = read(SCAFFOLDING), fill = text.slice(text.indexOf('8. **Fill**'), text.indexOf('9. **Self-check**'));
  assert.ok(fill.includes('`node "<SKILL_DIR>/tools/scaffold.mjs" --answers'), 'step 8 runs scaffold.mjs');
  assert.deepEqual(answersDrift(fill, domain), []);
  // Live controls, one per side: a key dropped from the prose, a key added to the code, a computed
  // value renamed, and a template placeholder that turns a naming-only value into a template one.
  const noFoldins = fill.replace(/^ {3}- `foldins` — [^\n]*\n(?: {5}[^\n]*\n)*/m, '');
  assert.notEqual(noFoldins, fill);
  assert.match(answersDrift(noFoldins, domain).join(), /^keys values, sections, batches, validate, setup;/);
  assert.match(answersDrift(fill, { ...domain, keys: [...domain.keys, 'extra'] }).join(), /takes values, sections, batches, validate, setup, foldins, extra/);
  assert.match(answersDrift(fill, { ...domain, values: { ...domain.values, computed: ['CHANGE_ID', 'LEDGER_DIR', 'SKILL_DIR'] } }).join(), /computed values differ/);
  assert.match(answersDrift(fill, { ...domain, batches: { ...domain.batches, values: [...domain.batches.values, 'BATCH_EXTRA'] } }).join(), /batches: the naming-only values are .*BATCH_EXTRA/);
});

// ===== scaffolding.md step 9 and check-ledger.mjs selfcheck, one rule each ======================
// Where step 9 states each selfcheck rule, by the rule id the tool gives its problems.
const RULE_TEXT = {
  slot: ['grep the new ledger directory for `{{` and `<!--`, and its `*.md` for `<title>`', '**zero hits** outside fenced and inline code spans'],
  state: ['`**State**: ACTIVE` present in PROGRESS'],
  preflight: ['the pre-flight verdict line present in the plan'],
  parse: ['every `#` cell of the batch tables in BOTH the plan and PROGRESS reads `Bnn`', 'must print `PARSE OK`'],
  skill: ['must print `SKILL MATCH`'],
};
function selfcheckDrift(step, rules) {
  const listed = /`node "<SKILL_DIR>\/tools\/check-ledger\.mjs" selfcheck [^`]*` runs every rule of this step in one pass — its rules (.*?) — /.exec(step);
  if (!listed) return ['step 9 publishes no selfcheck rule list'];
  const named = [...listed[1].matchAll(/`([a-z]+)`/g)].map(m => m[1]), problems = [];
  if (JSON.stringify(named) !== JSON.stringify(rules)) problems.push('step 9 names ' + named.join(', ') + '; selfcheck has ' + rules.join(', '));
  for (const rule of rules) if (!RULE_TEXT[rule]) problems.push(rule + ': no rule of step 9 states it');
  for (const [rule, phrases] of Object.entries(RULE_TEXT)) {
    if (!rules.includes(rule)) problems.push(rule + ': step 9 states it, selfcheck has no such rule');
    for (const phrase of phrases) if (!step.includes(phrase)) problems.push(rule + ': step 9 no longer states "' + phrase + '"');
  }
  return problems;
}
test('step 9 lists each selfcheck rule once, by the id check-ledger.mjs gives it, and states each', async () => {
  const { RULES } = await load('check-ledger.mjs');
  assert.ok(RULES.selfcheck.length >= 5 && RULES.selfcheck.includes('slot'), 'the rule ids were really read');
  const step = between(read(SCAFFOLDING), '9. **Self-check**', '\n10. **Scaffold commit**', SCAFFOLDING);
  assert.deepEqual(selfcheckDrift(step, RULES.selfcheck), []);
  // Live controls, one per side: an id dropped from the prose, a rule added to the code, a rule's
  // statement gone from the step.
  assert.match(selfcheckDrift(step.replace('`state`, ', ''), RULES.selfcheck).join(), /step 9 names slot, preflight/);
  assert.match(selfcheckDrift(step, [...RULES.selfcheck, 'extra']).join(), /extra: no rule of step 9 states it/);
  assert.match(selfcheckDrift(step, RULES.selfcheck.filter(r => r !== 'skill')).join(), /skill: step 9 states it, selfcheck has no such rule/);
  assert.match(selfcheckDrift(step.replace('the pre-flight verdict line present in the plan', 'the plan'), RULES.selfcheck).join(), /preflight: step 9 no longer states/);
});

// ===== protocol.md step 6b and the words failing-on-base.mjs prints ============================
// The result words one step-6b text names: each code span opening with a capitalised word.
const resultWords = text => [...text.matchAll(/`([A-Z][A-Z-]*[A-Z])(?: [^`]*)?`/g)].map(m => m[1]);
test('step 6b names exactly the three result words failing-on-base.mjs prints, and §Recovery names rows', async () => {
  const { verdict } = await load('failing-on-base.mjs');
  // The verdict core on one run of each kind: a named failure, every test passing, a crash.
  const step = { name: 'tests', loadFailures: [], emptyFiles: [], names: [] };
  const runs = [{ status: 'FAIL', steps: [{ ...step, result: 'FAIL', passed: 1, failed: 1, names: ['a test'] }] },
    { status: 'PASS', steps: [{ ...step, result: 'PASS', passed: 2, failed: 0 }] }, { status: 'FAIL', steps: [{ ...step, result: 'CRASHED' }] }];
  const printed = runs.map(r => verdict(r));
  assert.deepEqual(printed.map(p => p.code), [0, 1, 2]);
  const words = printed.map(p => p.line.split(' ')[0]);
  // --help lists every line the tool prints beside its exit code; UNKNOWN is its refusal, never a result.
  const listed = [...helpOf('failing-on-base.mjs').matchAll(/^ {2}(\d) ([A-Z][A-Z-]*[A-Z])/gm)].map(m => m[2]).filter(w => w !== 'UNKNOWN');
  assert.deepEqual(listed.slice().sort(), words.slice().sort(), 'the verdict core and --help name the same results');
  const sentence = between(read(PROTOCOL), '`node "<skill-dir>/tools/failing-on-base.mjs"', '\n   - **6c Reviewer', PROTOCOL);
  assert.ok(between(read(PROTOCOL), '- **6b Failing-on-base', '\n   - **6c Reviewer', PROTOCOL).endsWith(sentence), 'the sentence closes step 6b');
  assert.deepEqual(resultWords(sentence).sort(), words.slice().sort());
  // Live controls: a fourth word named, and one of the three left out.
  assert.notDeepEqual(resultWords(sentence.replace('`ALL-PASS (P0)`', '`ALL-PASS (P0)` or `UNKNOWN <reason>`')).sort(), words.slice().sort());
  assert.notDeepEqual(resultWords(sentence.replace('`INCONCLUSIVE (…)`', 'an inconclusive line')).sort(), words.slice().sort());
  // §Recovery: the sentence right after the first-match rule names the rows operation, ahead of the table.
  const recovery = between(read(PROTOCOL), 'Rows are matched top to bottom; the first match wins.', '\n| Ledger says |', PROTOCOL);
  assert.ok(recovery.startsWith('Rows are matched top to bottom; the first match wins. `node "<skill-dir>/tools/reconcile.mjs" rows --repo '), recovery);
  assert.ok(synopsisOf(helpOf('reconcile.mjs'), 'reconcile.mjs', 'rows'), 'reconcile.mjs --help documents rows');
});

// ===== What reconcile.mjs prints, against the lines the documents quote ===========================
// A quoted line as a pattern: each `<placeholder>` any text, the rest literal.
const shapeOf = quoted => new RegExp('^' + quoted.split(/(<[^>]+>)/).map((part, i) => i % 2 ? '(.+?)' : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('') + '$');
// The modes SKILL.md §Discovery says a State routes to.
const modesNamed = text => {
  const m = /the mode that State routes to \(((?:`[a-z]+`(?:, | or )?)+)\)/.exec(text);
  return m ? [...m[1].matchAll(/`([a-z]+)`/g)].map(n => n[1]).sort() : [];
};
test('reconcile.mjs prints the discovery modes and the rows line SKILL.md and protocol.md quote', async t => {
  const { summarize, reconcileRows, loadTable } = await load('reconcile.mjs');
  // Discovery: one ledger per State a preamble can hold, and one with none.
  const STATES = ['ACTIVE', 'AT-CHECKPOINT C1', 'USER-BLOCKED', 'COMPLETE', null];
  const ledgers = STATES.map((state, i) => ({ id: 'TD-2099010' + (i + 1) + '-x',
    locations: [{ kind: 'worktree', path: 'wt' + i + '/PROGRESS.md', progressText: '# Progress\n\n' + (state === null ? '' : '**State**: ' + state + '\n') }] }));
  const found = summarize({ completeness: 'complete', diagnostics: [], evidence: { ledgers } });
  assert.equal(found.code, 0, found.lines.join('\n'));
  const discovery = shapeOf('<id> State=<value> at <locations> → <mode>');
  const modes = found.lines.map(line => { const m = discovery.exec(line); assert.ok(m, 'the quoted shape: ' + line); return m[4]; });
  const skill = between(read(SKILL), 'Its summary comes first:', '\nInspect completeness', SKILL);
  assert.deepEqual([...new Set(modes)].sort(), modesNamed(skill), 'SKILL.md names each mode reconcile.mjs routes a State to, and no other');
  assert.notDeepEqual([...new Set(modes)].sort(), modesNamed(skill.replace('`continue`', '`resume`')), 'live control: a mode renamed in the prose is reported');
  // Rows: one ⬜ batch whose branch does not exist, on a ledger committed to its integration branch.
  const repo = makeRepo(t);
  repo.git('config', 'maintenance.auto', 'false'); repo.git('config', 'gc.auto', '0');
  repo.git('checkout', '-q', '-b', 'int');
  repo.write('.agents/changes/TD-1/00-READBEFORE.md', '# Contract\n\n## Git model\n\n- Default branch (protected local ref): `refs/heads/main`. Integration branch: `int`.\n- Shipment source: `local`. Shipment ref: `refs/heads/main`.\n');
  repo.write('.agents/changes/TD-1/PROGRESS.md', '# Progress\n\n**State**: ACTIVE\n\n## Batches\n\n| # | Batch | Branch | Wave | Version | Status | Updated | Notes |\n|---|---|---|---|---|---|---|---|\n'
    + '| B01 | work | `feat/b01` | 1 | — | ⬜ | 2099-01-01 | — |\n\n## Checkpoints\n\n| Checkpoint | After wave | Covers | Why here | Status | Verdict |\n|---|---|---|---|---|---|\n| C1 | 1 | B01 | final | ⬜ | — |\n');
  repo.commit('ledger');
  const protocolText = read(PROTOCOL);
  const printed = reconcileRows({ repo: repo.cwd, ledger: 'TD-1', integration: 'refs/heads/int', protocolText, env: repo.env });
  assert.equal(printed.code, 0, printed.lines.join('\n'));
  const row = shapeOf('<Bnn> <status> row <k>: <Verdict>').exec(printed.lines[1]);
  assert.ok(row, 'the quoted shape: ' + printed.lines[1]);
  assert.deepEqual(row.slice(1, 3), ['B01', '⬜']);
  assert.equal(row[4], loadTable(protocolText)[Number(row[3]) - 1], 'the Verdict is its table row\'s own');
  assert.ok(!shapeOf('<Bnn> <status> → row <k>: <Verdict>').test(printed.lines[1]), 'live control: another shape does not fit the printed line');
});

// ===== The ten entries a check line shows =========================================================
const NUMBERS = { five: 5, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, fifteen: 15, twenty: 20 };
const cutsNamed = text => [...text.matchAll(/lists at most (\w+) entries, then `\(\+<k> more\)`/g)].map(m => NUMBERS[m[1]] ?? m[1]);
test('the check lines are cut short where the pre-flight prose says, and the prose says what then remains to check', async t => {
  const { ledgerCli } = await load('check-ledger.mjs');
  // Twelve stale citations and twelve unpinned spans: a FAIL line's problems and an OK line's list.
  const lines = Array.from({ length: 12 }, (_, i) => '- `README.md:1` `no symbol ' + (i + 1) + ' here`');
  const spans = Array.from({ length: 12 }, (_, i) => '- `README.md:' + (i + 1) + '` alone');
  const run = text => ledgerCli(['cites', '--dir', writeTree(fs.mkdtempSync(path.join(tmp(t), 'ledger-')), { '01-plan.md': '# Plan\n\n' + text + '\n' }), '--repo', ROOT]);
  const failed = run(lines.join('\n')), listed = run(spans.join('\n'));
  const cut = /^(?:CITES FAIL 12 problem\(s\)|CITES OK 0 pinned, 12 unpinned): (.+) \(\+(\d+) more\)$/;
  const shown = [failed, listed].map(r => { const m = cut.exec(r.line); assert.ok(m, r.line); assert.equal(m[1].split('; ').length + Number(m[2]), 12, r.line); return m[1].split('; ').length; });
  assert.equal(shown[0], shown[1], 'a problem list and an entry list are cut at the same count');
  const step5 = between(read(SCAFFOLDING), '5. **Pre-flight**', '\n6. **Front-load', SCAFFOLDING);
  const skeleton = between(read(PROMPTS), 'THE ORCHESTRATOR\'S CHECK LINES', '\n\nCHECK, in order', PROMPTS);
  for (const text of [step5, skeleton]) assert.deepEqual(cutsNamed(text), [shown[0]], 'the prose names the cut the tool makes');
  // Both name the lines a cut leaves short of their check, and say the pre-flight does the rest itself.
  for (const text of [step5, skeleton]) assert.match(text, /`PLAN FAIL`, `CITES FAIL` or `CENSUS` line/);
  assert.match(skeleton, /settles only what it lists, so do the rest of its check as if no line were given/);
  assert.match(step5, /the pre-flight checks for itself what the line leaves out/);
  // Live control: the prose naming another cut is reported.
  assert.notDeepEqual(cutsNamed(step5.replace('at most ten entries', 'at most twenty entries')), [shown[0]]);
});

// ===== The draft worktree, added and removed ======================================================
// Why step 5's text leaves a worktree behind: one it adds and never removes after adding it.
function worktreeFaults(step) {
  const added = [...step.matchAll(/`git worktree add (?:--detach )?(\S+)/g)].map(m => m[1]);
  if (!added.length) return ['step 5 adds no worktree'];
  return added.filter(p => step.indexOf('`git worktree remove ' + p + '`') < step.indexOf('`git worktree add')).map(p => p + ': added, never removed');
}
test('the draft worktree step 5 adds is removed once the pre-flight is done, and SKILL.md says so', () => {
  const step5 = between(read(SCAFFOLDING), '5. **Pre-flight**', '\n6. **Front-load', SCAFFOLDING);
  assert.deepEqual(worktreeFaults(step5), []);
  assert.ok(between(read(SKILL), '→ plan checks on', '→ independent', SKILL).includes('the draft and its worktree are removed after the last pre-flight round'));
  // Live control: the step without its clean-up sentence is reported.
  const kept = step5.replace(/ Once the last pre-flight round is done[^.]*\./, '');
  assert.notEqual(kept, step5);
  assert.deepEqual(worktreeFaults(kept), ['<scratchpad>/wt-draft: added, never removed']);
});

// ===== The New files line and its registry row ==================================================
test('the BATCH_NEW_FILES registry row and the batch template line exist together', () => {
  const rows = read(SCAFFOLDING).split('\n').filter(l => l.startsWith('| `{{BATCH_NEW_FILES}}` |'));
  assert.equal(rows.length, 1, 'one registry row');
  assert.match(rows[0], /^\| `\{\{BATCH_NEW_FILES\}\}` \| template \(batch file\) \| .*`none`.*`check-ledger\.mjs plan`/);
  const lines = read(BATCH_TEMPLATE).split('\n'), at = lines.indexOf('**New files**: {{BATCH_NEW_FILES}}');
  assert.ok(at > 0, BATCH_TEMPLATE + ' carries the line');
  assert.equal(lines[at - 1], '**Files**: {{BATCH_FILES}}', 'directly under the Files line');
  const carriers = fs.readdirSync(path.join(SKILL_DIR, 'templates')).filter(n => read('orchestrate/templates/' + n).includes('{{BATCH_NEW_FILES}}'));
  assert.deepEqual(carriers, ['02-batch.md'], 'the batch template alone carries it');
  assert.equal(lines.filter(l => l.includes('{{BATCH_NEW_FILES}}')).length, 1, 'once');
});

// ===== The citation form, shown by each template ================================================
test('each template shows one pinned citation in its instruction comment, and it holds under the checkout', async t => {
  const { cites } = await load('check-ledger.mjs');
  const plan = read(PLAN_TEMPLATE), batch = read(BATCH_TEMPLATE);
  const check = files => cites(writeTree(fs.mkdtempSync(path.join(tmp(t), 'ledger-')), files), ROOT);
  // Each template alone, the batch template beside an empty plan: one pinned citation, holding.
  for (const [label, files] of [[PLAN_TEMPLATE, { '01-plan.md': plan }], [BATCH_TEMPLATE, { '01-plan.md': '# Plan\n', '02-batches-01-example.md': batch }]]) {
    const r = check(files);
    assert.deepEqual({ status: r.status, pinned: r.pinned, unpinned: r.unpinned, problems: r.problems }, { status: 'OK', pinned: 1, unpinned: [], problems: [] }, label);
  }
  // In the comment under the heading it cites.
  for (const [label, text, heading] of [[PLAN_TEMPLATE, plan, '## Per-batch specifications'], [BATCH_TEMPLATE, batch, '## Implementation notes']]) {
    const own = text.slice(text.indexOf('\n' + heading + '\n'), text.indexOf('\n## ', text.indexOf('\n' + heading + '\n') + 1));
    const comment = own.slice(own.indexOf('<!--'), own.indexOf('-->'));
    const line = text.split('\n').indexOf(heading) + 1;
    assert.ok(comment.includes('`' + label + ':' + line + '` `' + heading + '`'), label + ': the comment under ' + heading + ' cites line ' + line);
  }
  // As published, both at once.
  const dir = writeTree(fs.mkdtempSync(path.join(tmp(t), 'ledger-')), { '01-plan.md': plan, '02-batches-01-example.md': batch });
  const cli = spawnSync(process.execPath, [path.join(SKILL_DIR, 'tools', 'check-ledger.mjs'), 'cites', '--dir', dir, '--repo', ROOT], { encoding: 'utf8', windowsHide: true, timeout: 60000 });
  assert.ifError(cli.error);
  assert.deepEqual({ status: cli.status, stdout: cli.stdout }, { status: 0, stdout: 'CITES OK 2 pinned, 0 unpinned\n' });
  // Live controls: the example moved off its line fails, and split from its symbol it is no citation.
  const moved = check({ '01-plan.md': '# Plan\n', '02-batches-01-example.md': batch.replace('02-batch.md:14`', '02-batch.md:15`') });
  assert.equal(moved.status, 'FAIL');
  assert.match(moved.problems.map(p => p.message).join(), /does not hold the symbol/);
  assert.equal(check({ '01-plan.md': plan.replace('01-plan.md:53` `', '01-plan.md:53`, `') }).pinned, 0);
});

// ===== README =====================================================================================
test('README describes check-ledger.mjs by every operation its --help documents', () => {
  const ops = helpOf('check-ledger.mjs').split(' | ').map(s => s.trim().replace(/^check-ledger\.mjs /, '').split(' ')[0]);
  assert.ok(ops.includes('parse') && ops.includes('census') && ops.length >= 6, 'the operations were really read: ' + ops.join(', '));
  const row = read('README.md').split('\n').filter(l => /^ {4}[├└]── check-ledger\.mjs {2,}\S/.test(l));
  assert.equal(row.length, 1, 'one tools-tree row');
  const missing = text => ops.filter(op => !new RegExp('\\b' + op + '\\b').test(text.replace(/^ {4}[├└]── check-ledger\.mjs/, '')));
  assert.deepEqual(missing(row[0]), []);
  assert.deepEqual(missing(row[0].replace(', cites', '')), ['cites'], 'live control: an operation left out is reported');
});

// ===== The new passages, pinned whole ============================================================
// Each passage this change wrote, whitespace collapsed: any appended, narrowed or reworded sentence
// inside one goes red. Rewording one on purpose means updating its text here.
const PASSAGES = [
  [SKILL, 'Its summary comes first:', '\nInspect completeness',
    'Its summary comes first: `node "<skill-dir>/tools/reconcile.mjs" discovery --repo <repo>` prints one line per ledger id, `<id> State=<value> at <locations> → <mode>`, the mode that State routes to (`continue`, `close`, `status` or `none`). The git-evidence JSON is read when a line says `AMBIGUOUS`, `INCOMPLETE` or `UNKNOWN`, or when a rule below needs provenance.'],
  [SKILL, 'backlog id scheme; `node', ') → interview',
    'backlog id scheme; `node "<skill-dir>/tools/detect.mjs" --repo <repo>` and `node "<skill-dir>/tools/env-facts.mjs" --repo <repo>` print the candidates'],
  [SKILL, '→ plan checks on', '→ independent',
    '→ plan checks on a draft (`node "<skill-dir>/tools/scaffold.mjs" --answers <draft answers> --repo <scratch worktree>` writes the draft ledger into a scratch worktree of the base, and `check-ledger.mjs` runs `plan`, `cites` and `census` on it, per scaffolding.md; the draft and its worktree are removed after the last pre-flight round, so Discovery never meets a second copy of the ledger)'],
  [SKILL, 'plan PRE-FLIGHT (a fresh read-only sub-agent', ') → front-load',
    'plan PRE-FLIGHT (a fresh read-only sub-agent given those three lines; blocking findings fixed before the user sees the plan'],
  [SKILL, '`.agents/changes/<CHANGE_ID>/` with', '\n(incl. `LOG.md`',
    '`.agents/changes/<CHANGE_ID>/` with `node "<skill-dir>/tools/scaffold.mjs" --answers <file> --repo <root>`'],
  [SKILL, '`**State**: ACTIVE` present;', '\nevery `#` cell',
    '`**State**: ACTIVE` present; the pre-flight verdict line present in the plan;'],
  [SKILL, 'scaffolding.md; `node', ') → scaffold commit on',
    'scaffolding.md; `node "<skill-dir>/tools/check-ledger.mjs" selfcheck --dir <ledger-dir>` runs all of these at once'],
  [SKILL, '+ reconcile (for a pinned contract', ') + resume-time',
    '+ reconcile (for a pinned contract `node "<skill-dir>/tools/reconcile.mjs" rows --repo <repo> --ledger <id> --integration <full-ref>`, `<skill-dir>` being its pinned directory, if the tool is there'],
  [SKILL, 'For a pinned contract that table is', '\nDrift corrections',
    'For a pinned contract that table is the output of `node "<skill-dir>/tools/reconcile.mjs" rows --repo <repo> --ledger <id> --integration <full-ref>`, `<skill-dir>` being its pinned directory: one `<Bnn> <status> row <k>: <Verdict>` line per row, beside the Status and Verdict cells of PROGRESS\'s checkpoint table; a row it prints as `UNKNOWN`, or every row when that directory has no such tool, is reconciled from the §Recovery table by hand.'],
  [PROTOCOL, 'Two more helpers print lines instead of JSON', '\n\n**Manual read-only fallback.**',
    'Two more helpers print lines instead of JSON, and neither writes the repository. Discovery\'s summary, `node "<skill-dir>/tools/reconcile.mjs" discovery --repo <repo>`, prints one line per ledger id (`<id> State=<value> at <locations> → <mode>`), and `reconcile.mjs rows` matches each PROGRESS row §Recovery reconciles to its table row and Verdict (its command is there); both exit 0 when every line is known and 2 on any `UNKNOWN`, `AMBIGUOUS` or `INCOMPLETE` line. `failing-on-base.mjs` performs step 6b in a disposable clone (its command is at that step) and prints one line, `PROVEN`, `ALL-PASS (P0)` or `INCONCLUSIVE`, exiting 0, 1 or 2. Where either does not run, the §Recovery table and step 6b\'s text are the manual procedure.'],
  [PROTOCOL, 'Rows are matched top to bottom; the first match wins.', '\n\n| Ledger says |',
    'Rows are matched top to bottom; the first match wins. `node "<skill-dir>/tools/reconcile.mjs" rows --repo <repo> --ledger <id> --integration <full-ref>` gathers these facts and prints, per row, the table row it matches and that row\'s Verdict (`<Bnn> <status> row <k>: <Verdict>`); the conductor still decides and acts, and a row it prints as `UNKNOWN` is reconciled by hand from this table.'],
  [PROTOCOL, '`node "<skill-dir>/tools/failing-on-base.mjs"', '\n   - **6c Reviewer',
    '`node "<skill-dir>/tools/failing-on-base.mjs" --repo <repo> --base <integration-ref> --batch <batch-ref> --validate <ledger-dir>/validate.json --log <file>` (adding `--setup <ledger-dir>/setup.json` where the ledger has one; the log outside the repository) performs this step in a disposable clone and prints one line, the failing-on-base result the reviewer receives: `PROVEN (…)` names the tests that fail on the base, the proof reviewer duty (e) confirms; `ALL-PASS (P0)` is the P0 above; `INCONCLUSIVE (…)` gives its reason and goes to reviewer duty (e). Any other line, or a tool that does not run, leaves the text above as the manual procedure.'],
  [SCAFFOLDING, '1. **Detect**', '\n2. **Interview**',
    '1. **Detect** repo facts (heuristics below) — read-only. `node "<SKILL_DIR>/tools/detect.mjs" --repo <repo>` prints one line per registry placeholder it covers (`<NAME>: <value> — <source>`, or `<NAME>: unknown — <why>`), plus `PRIOR_CONTRACT`, the latest ledger contract in the working tree, whose baked answers a repeat repo offers as defaults (§Interview); `--format json` prints the same values as JSON. `node "<SKILL_DIR>/tools/env-facts.mjs" --repo <repo>` prints the environment facts a contract records, one per line, a `tmpfs` temp or repository filesystem flagged as wiped at reboot. The interview confirms these candidates; without the tools, the table below is the manual procedure.'],
  [SCAFFOLDING, 'Record each codebase fact', '\n   Inventory the exact',
    'Record each codebase fact the plan and batch files rely on as a pinned citation, in the form the templates\' instruction comments show (`` `path:line` `symbol` ``), so that `check-ledger.mjs cites` checks it against the base; any other `path:line` span it lists as unpinned.'],
  [SCAFFOLDING, 'Draft them first as a ledger', '\n   It checks coverage both ways',
    'Draft them first as a ledger in a scratch worktree of the base (`git worktree add --detach <scratchpad>/wt-draft <base>`), with step 8\'s command and an answers file whose coverage audit ends in a provisional `Pre-flight: CLEAN` (the scaffold\'s self-check requires the line) and whose `foldins` stay empty (their markers belong to the real fill): `node "<SKILL_DIR>/tools/scaffold.mjs" --answers <draft answers> --repo <scratchpad>/wt-draft`. A re-draft after a fix first deletes the draft directory, which `scaffold.mjs` otherwise refuses. From that worktree\'s root run `node "<SKILL_DIR>/tools/check-ledger.mjs" plan --dir .agents/changes/<CHANGE_ID> --repo .`, `node "<SKILL_DIR>/tools/check-ledger.mjs" cites --dir .agents/changes/<CHANGE_ID> --repo .` and `node "<SKILL_DIR>/tools/check-ledger.mjs" census --dir .agents/changes/<CHANGE_ID> --repo .`, and include their three lines in the skeleton: `PLAN …` settles same-wave disjointness, dependencies and fence paths, `CITES …` names the citations that no longer hold, and `CENSUS …` the tracked files outside every fence that name a fenced path. Each line lists at most ten entries, then `(+<k> more)`; for a `PLAN FAIL`, `CITES FAIL` or `CENSUS` line cut short that way, the pre-flight checks for itself what the line leaves out. Where the tools do not run, the drafts go in as written and the skeleton\'s checks run without those lines.'],
  [SCAFFOLDING, 'Once the last pre-flight round is done', '\n6. **Front-load',
    'Once the last pre-flight round is done, delete the draft ledger directory and remove its worktree (`git worktree remove <scratchpad>/wt-draft`, or `git worktree prune` once that directory is gone), so Discovery never meets the draft as a second copy of the ledger.'],
  [SCAFFOLDING, '`node "<SKILL_DIR>/tools/scaffold.mjs" --answers <answers file>', '\n9. **Self-check**',
    '`node "<SKILL_DIR>/tools/scaffold.mjs" --answers <answers file> --repo <root>` performs this step, `<root>` being the root of the worktree step 10 commits from: it builds every file in memory, holds the staged copy to parse, selfcheck and plan, and only then writes `.agents/changes/<CHANGE_ID>/`, its `validate.json` and any `setup.json` included, in the line-ending style of the repository\'s tracked Markdown, and marks the accepted fold-ins (step 10). It never commits and prints one line: `SCAFFOLD OK <CHANGE_ID> <n> batches, <k> files`, `SCAFFOLD FAIL <n> problem(s): ...` with nothing written, or `UNKNOWN <reason>`. Its answers file, schema version 1, is one JSON object holding exactly these keys, the placeholders and headings inside them read from the templates at run time: - `values` — every placeholder outside `02-batch.md`, plus the naming-only `ID_PREFIX` and `CHANGE_SLUG`; `CHANGE_ID`, `LEDGER_DIR`, `SKILL_DIR` and `SKILL_SHA256` are computed (from `ID_PREFIX`, `DATE` and `CHANGE_SLUG`, and from the tool\'s own skill directory) and may be left out. - `sections` — one Markdown text per instruction comment outside `02-batch.md`, keyed `<template> <heading line>` (`01-plan.md ## Backlog fold-ins`); `""` removes the comment. - `batches` — one `{ "values", "sections" }` object per batch, in order: every `02-batch.md` placeholder plus the naming-only `BATCH_SLUG`, and its comments keyed by heading line. - `validate` — the `validate.json` spec above, or `null` when the validation commands are `none`. - `setup` — the `setup.json` spec, or `null` when `{{WORKTREE_SETUP}}` is `n/a` (an explanation may follow it). - `foldins` — one `{ "file", "batch" }` object per accepted fold-in, plus its existing `"id"` or, for an item without one, an `"anchor"`: the exact text of its line. Each refusal is named: a missing or unknown key at any level, a value that is not a string, a computed value supplied differently, a malformed `ID_PREFIX`, `CHANGE_SLUG`, `DATE` or `BATCH_SLUG`, a `BASE_SHA` that is no full commit SHA of the repository, a `BATCH_NUM` out of sequence, a `validate` or `setup` present where it must be `null` or missing where it must not be, a spec `validate.mjs` rejects, a fold-in it cannot mark, an existing ledger directory, and every problem of the staged ledger\'s checks. The text above stays the manual procedure.'],
  [SCAFFOLDING, '`node "<SKILL_DIR>/tools/check-ledger.mjs" selfcheck', '\n10. **Scaffold commit**',
    '`node "<SKILL_DIR>/tools/check-ledger.mjs" selfcheck --dir <the new ledger directory>` runs every rule of this step in one pass — its rules `slot` (the grep), `state`, `preflight`, `parse` (the `Bnn` cells and `PARSE OK`) and `skill` (`SKILL MATCH`) — and prints `SELFCHECK OK`, or `SELFCHECK FAIL` naming each problem by file and line; `scaffold.mjs` has already run it on its staged copy, and the rules above stay the manual procedure.'],
  [SCAFFOLDING, '`scaffold.mjs` has already ended', '\n11. **STOP**',
    '`scaffold.mjs` has already ended each accepted fold-in\'s backlog line (inside a table row\'s last cell) with `Folded into <CHANGE_ID> <Bnn>.`, an item named by its `"anchor"` first taking the next id of the `{{BACKLOG_ID_PREFIX}}` scheme in that file; a scheme the file holds no id of yet must read `#`, or a letter, letters and digits, then one `-`, `_` or `.`.'],
  [SCAFFOLDING, '| `{{BATCH_DEPS}}` |', '\n',
    '| `{{BATCH_DEPS}}` | template (batch file) | the `Bnn` ids of the batches this batch needs integrated first, comma-separated (`B01, B03`), or `none` if independent; `check-ledger.mjs plan` reads every `Bnn` on the line, each from an earlier wave |'],
  [SCAFFOLDING, '| `{{BATCH_NEW_FILES}}` |', '\n',
    '| `{{BATCH_NEW_FILES}}` | template (batch file) | the fence files this batch creates, as exact backtick paths (`src/new.ts`), or `none`; `check-ledger.mjs plan` reads it: each path in this batch\'s fence and not yet in the repository, and a later wave\'s batch may fence it unmarked |'],
  [PROMPTS, 'THE ORCHESTRATOR\'S CHECK LINES', '\n\nCHECK, in order',
    'THE ORCHESTRATOR\'S CHECK LINES (check-ledger.mjs on the draft ledger): [PLAN, CITES AND CENSUS LINES] Each of those lines lists at most ten entries, then `(+<k> more)`: a `PLAN FAIL`, `CITES FAIL` or `CENSUS` line that ends so settles only what it lists, so do the rest of its check as if no line were given.'],
  [PROMPTS, '2. Same-wave fences are disjoint', '\n4. Contradictions',
    '2. Same-wave fences are disjoint, dependencies sit in earlier waves, and every fence path exists or is marked new: the `PLAN` line settles this, so take it rather than computing the intersections — report each problem a `PLAN FAIL` line names. Given no `PLAN` line, compute the intersections literally. 3. Fence completeness census: the `CENSUS` line lists the tracked files outside all fences that name a fenced path (by path, import specifier or basename); beyond paths, grep the repo for every symbol, channel, table, key or literal string each batch changes, and given no `CENSUS` line, for every fenced path too. Every such file or hit must be in the fence, declared out of scope with a reason, or identified as another batch\'s seam (then a dependency must exist). Include tests, generated maps and docs. The `CITES` line checks every pinned citation of the plan and batch files: report each one a `CITES FAIL` line names as no longer holding. Given no `CITES` line, open each cited line yourself.'],
  [PROMPTS, 'The `[PLAN, CITES AND CENSUS LINES]` slot', '\n\n## Convergence',
    'The `[PLAN, CITES AND CENSUS LINES]` slot takes the three lines `check-ledger.mjs` printed for the draft ledger (scaffolding.md step 5). The planner fixes blocking findings before the plan goes to the user and records the verdict in the plan\'s coverage audit as the `Pre-flight:` line the plan template shows, the form `check-ledger.mjs selfcheck` reads.'],
  [BATCH_TEMPLATE, '**Files**: {{BATCH_FILES}}', '\nThe fence:', '**Files**: {{BATCH_FILES}} **New files**: {{BATCH_NEW_FILES}}'],
  [BATCH_TEMPLATE, 'Each file:line reference is a pinned citation', ' Backlog fold-ins appear',
    'Each file:line reference is a pinned citation, the form `check-ledger.mjs cites` checks: a `path:line` span, one space, then a span holding a symbol that line carries — `orchestrate/templates/02-batch.md:14` `## Implementation notes` cites the heading above.'],
  [PLAN_TEMPLATE, 'Each file:line fact is a pinned', ' The batch files quote from',
    'Each file:line fact is a pinned citation, as `orchestrate/templates/01-plan.md:53` `## Per-batch specifications` cites this heading (`check-ledger.mjs cites` checks each one).'],
];
// The README tools-tree rows of the new tools and of check-ledger.mjs, each pinned as its whole line.
const README_ROWS = [
  '    ├── check-ledger.mjs            one-line ledger checks: parse, skill (the pin hash), selfcheck, plan, cites and census',
  '    ├── scaffold.mjs                fills the templates from an answers file and writes the ledger only once a staged copy passes parse, selfcheck and plan',
  '    ├── detect.mjs                  prints candidate interview answers read from the repository, as lines or JSON, and the latest prior contract',
  '    ├── env-facts.mjs               prints the environment facts a contract records, one per line, flagging a tmpfs temp or repository filesystem',
  '    ├── reconcile.mjs               read-only: discovery as one line per ledger; rows matches PROGRESS rows to their §Recovery row and Verdict',
  '    ├── failing-on-base.mjs         runs protocol step 6b in a disposable clone: PROVEN, ALL-PASS (P0) or INCONCLUSIVE, one line',
];
test('each passage this change wrote reads exactly as pinned', () => {
  for (const [file, from, to, expected] of PASSAGES) {
    const text = read(file);
    assert.equal(between(text, from, to, file), expected, file + ' (' + from + '): the pinned passage changed; update PASSAGES only on purpose');
    // Live control: one sentence planted inside the passage reddens it.
    assert.notEqual(between(text.replace(from, from + ' Skip it when in a hurry.'), from, to, file), expected);
  }
  const readme = read('README.md').split('\n');
  for (const row of README_ROWS) assert.equal(readme.filter(l => l === row).length, 1, 'README tools tree: ' + row.trim().split(' ')[1]);
  for (const tool of [...NEW_TOOLS, 'check-ledger.mjs']) assert.ok(README_ROWS.some(r => r.startsWith('    ├── ' + tool + ' ')), 'a pinned README row for ' + tool);
});

// ===== The printed lines the new passages quote ===================================================
// Each line a new passage quotes, the tool whose --help shows it verbatim (`run` where a run of the
// tool shows it instead, in the tests below), and the documents quoting it.
const QUOTED_LINES = [
  ['<id> State=<value> at <locations> → <mode>', 'reconcile.mjs', [SKILL, PROTOCOL]],
  ['<Bnn> <status> row <k>: <Verdict>', 'reconcile.mjs', [SKILL, PROTOCOL]],
  ['<NAME>: <value> — <source>', 'detect.mjs', [SCAFFOLDING]],
  ['<NAME>: unknown — <why>', 'detect.mjs', [SCAFFOLDING]],
  ['SCAFFOLD OK <CHANGE_ID> <n> batches, <k> files', 'scaffold.mjs', [SCAFFOLDING]],
  ['SCAFFOLD FAIL <n> problem(s): ...', 'scaffold.mjs', [SCAFFOLDING]],
  ['UNKNOWN <reason>', 'scaffold.mjs', [SCAFFOLDING]],
  ['Folded into <CHANGE_ID> <Bnn>.', 'scaffold.mjs', [SCAFFOLDING]],
  ['<template> <heading line>', 'scaffold.mjs', [SCAFFOLDING]],
  ['SELFCHECK OK', 'check-ledger.mjs', [SCAFFOLDING]],
  ['SELFCHECK FAIL', 'check-ledger.mjs', [SCAFFOLDING]],
  ['(+<k> more)', 'run', [SCAFFOLDING, PROMPTS]],
];
// Why a quoted line is not bound: a document that no longer quotes it, or a --help that no longer shows it.
const quoteFaults = help => QUOTED_LINES.flatMap(([shape, tool, files]) => [
  ...files.filter(file => !collapse(read(file)).includes('`' + shape + '`')).map(file => file + ' no longer quotes ' + shape),
  ...(tool !== 'run' && !collapse(help(tool)).includes(shape) ? [tool + ' --help no longer shows ' + shape] : [])]);
// The status word each code span of a new passage opens with (`CENSUS` of `CENSUS …`), a span that is
// a template placeholder name such as `DATE` aside; and why one is not bound: no --help shows it.
const statusWords = (passages, placeholders) => [...new Set(passages.flatMap(p => [...p[3].matchAll(/`([^`]+)`/g)].map(m => m[1]))
  .filter(s => !placeholders.has(s)).map(s => /^[A-Z][A-Z-]*[A-Z]\b/.exec(s)).filter(Boolean).map(m => m[0]))];
const wordFaults = (words, help) => words.filter(w => !new RegExp('(?<![\\w-])' + w + '(?![\\w-])').test(help)).map(w => w + ': no new tool\'s --help shows it');
test('every printed line the new passages quote is shown by its tool', () => {
  // The domain: each code span of a new passage holding a placeholder and a space, commands aside.
  const spans = [...new Set(PASSAGES.flatMap(p => [...p[3].matchAll(/`([^`]+)`/g)].map(m => m[1])))]
    .filter(s => /<[^>]+>/.test(s) && s.includes(' ') && !/^(?:node|git) |^--/.test(s));
  assert.ok(spans.length >= 8, 'the quoted lines were really read: ' + spans.join(' | '));
  assert.deepEqual(spans.filter(s => !QUOTED_LINES.some(q => q[0] === s)), [], 'a quoted line that no binding below covers');
  assert.deepEqual(quoteFaults(helpOf), []);
  // Live control: reconcile.mjs --help rewording its discovery line is reported.
  const reworded = tool => tool === 'reconcile.mjs' ? helpOf(tool).replace('<id> State=<value> at <locations> → <mode>', '<id> <value> in <locations> ⇒ <mode>') : helpOf(tool);
  assert.deepEqual(quoteFaults(reworded), ['reconcile.mjs --help no longer shows <id> State=<value> at <locations> → <mode>']);
  // A second domain: each span of a new passage opening with an upper-case status word, placeholder or
  // not, bound by that word to the --help of the new tools and check-ledger.mjs.
  const placeholders = new Set(fs.readdirSync(path.join(SKILL_DIR, 'templates')).flatMap(n => placeholdersOf('orchestrate/templates/' + n)));
  const words = statusWords(PASSAGES, placeholders);
  assert.ok(['AMBIGUOUS', 'INCOMPLETE', 'CENSUS', 'PLAN', 'ALL-PASS', 'SELFCHECK'].every(w => words.includes(w)), 'the status words were really read: ' + words.join(', '));
  const helpsOf = help => [...NEW_TOOLS, ...Object.keys(NEW_OPERATIONS)].map(help).join('\n');
  assert.deepEqual(wordFaults(words, helpsOf(helpOf)), []);
  // Live controls: `CENSUS` renamed in check-ledger.mjs --help, and a passage quoting a status word no
  // tool prints, are each reported; `DATE` stays out only as a template placeholder name.
  assert.deepEqual(wordFaults(words, helpsOf(tool => tool === 'check-ledger.mjs' ? helpOf(tool).replace(/\bCENSUS\b/g, 'REFS') : helpOf(tool))), ['CENSUS: no new tool\'s --help shows it']);
  assert.deepEqual(wordFaults(statusWords([...PASSAGES, [SCAFFOLDING, '', '', 'its `REFS …` line']], placeholders), helpsOf(helpOf)), ['REFS: no new tool\'s --help shows it']);
  assert.deepEqual(wordFaults(statusWords(PASSAGES, new Set()), helpsOf(helpOf)), ['DATE: no new tool\'s --help shows it']);
});

// ===== Directives that would reverse the new passages ============================================
// Clause-level over every shipped Markdown file, README and the agent definitions README ships: a
// failing-on-base or reconcile line that proves nothing read as a proof or a pass, ALL-PASS read as
// clearing the gate, a line the conductor must reconcile by hand passed over, and reconcile.mjs acting
// for the conductor. Tool words are matched in any case. A family fires on its `before` words, then a
// verb no negator governs, then its `after` words, in that order. A negator governs a verb only right
// before it, or with `ever` or `yet` alone between ("never ever decides"): those two leave the verb
// negated, while "not always", "not merely" and "not simply" grant it at times, so any other word
// between, like a negator elsewhere in the clause, exempts nothing.
const PROOF = String.raw`^\s*(?:a\s+|the\s+)?(?:proven|proof|pass|green|clean)\b`;
// [name, before, verb, after, specimen]; a null part matches anywhere.
const TOOL_REVERSALS = [
  ['a line that proves nothing read as proof', /\b(?:inconclusive|unknown)\b/i, /\b(?:counts?|reads?|serves?)\s+as\b|\btreated\s+as\b|\bstands?\s+(?:in\s+)?for\b/i,
    new RegExp(PROOF, 'i'), 'An INCONCLUSIVE line counts as PROVEN when the batch is small'],
  ['a line that proves nothing treated as proof', null, /\b(?:treat|read|count|take)s?\b/i,
    /\b(?:inconclusive|unknown)\b[^.;:]*\bas\s+(?:a\s+)?(?:proven|proof|pass|green|clean)\b/i, 'Treat an inconclusive line as proof when the tests are new'],
  ['ALL-PASS read as clearing the gate', /\ball-pass\b/i, /\b(?:clears?|ships?|passes\s+the\s+gate)\b|\bis\s+(?:not\s+a|no)\s+P0\b|\bneeds\s+no\s+finding\b/i, null,
    'ALL-PASS clears the gate for a refactor batch'],
  ['a line to reconcile by hand passed over', /\b(?:unknown|ambiguous|incomplete)\b/i, /\b(?:is|are)\s+(?:skipped|ignored|dropped|passed\s+over|left\s+out|read\s+as\s+correct)\b/i, null,
    'A row it prints as UNKNOWN is skipped'],
  ['reconcile.mjs acting for the conductor', /\breconcile\.mjs\b/i, /\b(?:decides?|acts?\s+on|appl(?:y|ies)\s+(?:its|the)\s+verdicts?|flips?|re-spawns?)\b/i, null,
    'reconcile.mjs rows decides each row and flips its status'],
];
const GOVERNED = /(?:^|[^\w'’])(?:never|not|no|cannot|nor|\w+n['’]t)\s+(?:(?:ever|yet)\s+)?$/i;
const every = re => new RegExp(re.source, re.flags.replace(/g/g, '') + 'g');
function fires([, before, verb, after], clause) {
  const from = before ? Math.min(...[...clause.matchAll(every(before))].map(m => m.index + m[0].length)) : 0;
  if (!Number.isFinite(from)) return false;
  return [...clause.matchAll(every(verb))].some(v => v.index >= from && !GOVERNED.test(clause.slice(0, v.index))
    && (!after || after.test(clause.slice(v.index + v[0].length))));
}
const clausesOf = text => collapse(text.replace(/`([^`\n]*)`/g, '$1')).split(/(?<=[.;:])\s+/);
const reversals = text => clausesOf(text).flatMap(c => TOOL_REVERSALS.filter(family => fires(family, c)).map(([name]) => name + ' — ' + c));
const walkMarkdown = (dir, rel = '') => fs.readdirSync(path.join(dir, rel), { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : 1)
  .flatMap(e => e.isDirectory() ? walkMarkdown(dir, rel + e.name + '/') : e.name.endsWith('.md') ? [rel + e.name] : []);
test('no shipped document reads a line that proves nothing as proof, or lets reconcile.mjs act for the conductor', () => {
  assert.equal(new Set(TOOL_REVERSALS.map(r => r[0])).size, TOOL_REVERSALS.length);
  for (const family of TOOL_REVERSALS) {
    const [name, , , , specimen] = family;
    assert.deepEqual(TOOL_REVERSALS.filter(f => fires(f, specimen)).map(f => f[0]), [name], name + ': its specimen must be caught by it alone');
    assert.equal(reversals(specimen + '.').length, 1, name + ': the clause reader reports its specimen');
  }
  // Written as prose a reversal would be, not read off the patterns: lower case, and a negator that
  // governs another word than the verb, among them — a word just before the verb ("not risky clears"),
  // and each adverb that grants the verb at times ("not always count").
  for (const planted of ['A row reconcile.mjs prints as UNKNOWN is ignored until the next session.', 'Treat INCONCLUSIVE as proof when the tests are new.',
    'An `ALL-PASS (P0)` line ships when the batch only refactors.', 'Let reconcile.mjs apply its verdicts and flip the rows.',
    'An INCOMPLETE discovery line is read as correct.', 'Treat an inconclusive failing-on-base line as proof when the batch is small.',
    '`reconcile.mjs rows`, not the conductor, decides each row.', 'An unknown row is skipped until the next boot.',
    'An ALL-PASS line for a refactor that is not risky clears the gate.', 'An UNKNOWN row with no owner is skipped.',
    'An INCONCLUSIVE failing-on-base line that is not flaky counts as PROVEN.', 'An INCONCLUSIVE line does not always count as PROVEN.',
    'reconcile.mjs does not merely decide each row.', 'ALL-PASS does not simply clear the gate.']) {
    assert.ok(reversals(planted).length >= 1, 'must be reported: ' + planted);
  }
  // Must pass: the new passages' own rules, and their negations, `ever` and `yet` between among them.
  assert.deepEqual(reversals(PASSAGES.map(p => p[3]).join(' ') + ' An INCONCLUSIVE line never counts as PROVEN. ALL-PASS is not a pass. '
    + 'A row it prints as UNKNOWN is never skipped. reconcile.mjs never decides a row. Never treat an inconclusive line as proof. '
    + 'reconcile.mjs does not flip a row. reconcile.mjs never ever decides a row. An INCONCLUSIVE line does not yet count as PROVEN.'), [], 'the rules are not their own reversals');
  const definitions = walkMarkdown(path.join(ROOT, '.claude', 'agents')).map(rel => '.claude/agents/' + rel);
  const files = [...walkMarkdown(SKILL_DIR).map(rel => 'orchestrate/' + rel), 'README.md', ...definitions];
  assert.ok(files.includes(PROTOCOL) && files.includes(SCAFFOLDING) && files.includes(BATCH_TEMPLATE) && files.includes('.claude/agents/reviewer.md')
    && files.length > 10, 'the sweep walks every shipped Markdown file and the agent definitions');
  for (const file of files) assert.deepEqual(reversals(read(file)), [], file + ': a directive reverses what a tool line means');
  // Armed on real carriers: protocol.md with the §Recovery rule reversed, and the reviewer definition
  // with a reversal appended, are each reported once.
  const reversed = read(PROTOCOL).replace('is reconciled by hand from this table', 'is skipped');
  assert.notEqual(reversed, read(PROTOCOL));
  assert.equal(reversals(reversed).length, 1);
  assert.equal(reversals(read('.claude/agents/reviewer.md') + '\n\nTreat an INCONCLUSIVE failing-on-base line as proof when the batch is small.\n').length, 1);
});
