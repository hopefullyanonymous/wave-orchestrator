const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { isDeepStrictEqual } = require('node:util');
const { makeRepo } = require('./support/git-fixture.cjs');
const ROOT = path.resolve(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const collapse = text => text.replace(/\s+/g, ' ');
const TEMPLATE = 'orchestrate/templates/00-READBEFORE.md';
const template = read(TEMPLATE);

// The domain every sweep below walks: the shipped skill tree, recursively, every file type.
function walk(dir, prefix = '') {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : 1)) {
    const rel = prefix + entry.name;
    if (entry.isDirectory()) out.push(...walk(path.join(dir, entry.name), rel + '/'));
    else if (entry.isFile()) out.push(rel);
  }
  return out;
}
const shipped = () => walk(path.join(ROOT, 'orchestrate')).map(rel => 'orchestrate/' + rel);
const documents = () => [...shipped(), 'README.md'];

// A command as the contract publishes it becomes argv the way a shell reads it: a
// double-quoted run is one argument. Anything a shell would interpret is refused, so a
// command that only works through shell composition cannot pass here.
function argvOf(command) {
  assert.doesNotMatch(command, /[|&;<>$`'\\]/, 'the command must need no shell interpretation: ' + command);
  return [...command.matchAll(/"([^"]*)"|(\S+)/g)].map(m => m[1] ?? m[2]);
}
function runCommand(command, cwd, env) {
  const [program, ...args] = argvOf(command);
  assert.equal(program, 'node', 'every skill-tool command runs under node: ' + command);
  const r = spawnSync(process.execPath, args, { cwd, env, encoding: 'utf8', windowsHide: true, timeout: 120000 });
  assert.ifError(r.error); assert.equal(r.signal, null);
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}
const slash = p => p.split(path.sep).join('/');

// A skill directory whose path contains a space — as this repository's own clone does —
// copied from the checkout, so the tools the contract names are the real ones.
function fixture(t) {
  const repo = makeRepo(t);
  const temp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'tool wiring '));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }));
  const skillDir = path.join(temp, 'skill copy', 'orchestrate');
  fs.cpSync(path.join(ROOT, 'orchestrate'), skillDir, { recursive: true });
  const env = { ...repo.env }; delete env.NODE_TEST_CONTEXT;
  return { repo, temp, env, skillDir, SKILL_DIR: slash(skillDir) };
}
const LEDGER_ID = 'TW-20260923-wiring', LEDGER_DIR = '.agents/changes/' + LEDGER_ID;
const fill = (text, values) => text.replace(/\{\{([A-Z0-9_]+)\}\}/g, (token, key) => key in values ? values[key] : 'example');

// The fill's hash comes from the command the placeholder registry itself publishes for
// {{SKILL_SHA256}}, run as published — not from an invocation this test composes.
function registryRow(key) {
  const rows = read('orchestrate/references/scaffolding.md').split('\n').filter(l => l.startsWith('| `{{' + key + '}}` |'));
  assert.equal(rows.length, 1, 'exactly one registry row for {{' + key + '}}');
  return rows[0];
}
function skillHex(skillDir, cwd, env) {
  const commands = [...registryRow('SKILL_SHA256').matchAll(/`(node [^`]+)`/g)].map(m => m[1]);
  assert.equal(commands.length, 1, 'the {{SKILL_SHA256}} row publishes exactly one command');
  const r = runCommand(commands[0].replaceAll('<SKILL_DIR>', slash(skillDir)), cwd, env);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const m = /^SKILL ([0-9a-f]{64}) \d+ files\n$/.exec(r.stdout);
  assert.ok(m, 'the registry command must print the hash line whose hex field fills the pin: ' + JSON.stringify(r.stdout));
  return m[1];
}
function section(text, from, to) {
  const start = text.indexOf(from), end = to === undefined ? text.length : text.indexOf(to, start + 1);
  assert.ok(start !== -1 && end > start, 'section bounds must resolve: ' + from + ' .. ' + to);
  return text.slice(start, end);
}
// The one code span in a filled contract that runs the pin check.
const pinCommandOf = text => {
  const found = [...section(text, '## Boot sequence', 'Implementer sub-agents:')
    .matchAll(/`(node "[^"`]*\/tools\/check-ledger\.mjs" skill --contract [^`]+)`/g)].map(m => m[1]);
  assert.equal(found.length, 1, 'the boot sequence must carry exactly one pin-check command');
  return found[0];
};
const pinLines = text => text.split('\n').filter(l => /^\s*\*\*skill\*\*/i.test(l));

test('a filled pin line round-trips through the real check-ledger.mjs, from a directory whose path has a space', t => {
  const { repo, env, skillDir, SKILL_DIR } = fixture(t);
  assert.match(SKILL_DIR, / /, 'the fixture must exercise a skill directory containing a space');
  // The form the tool parses, shown in the template itself, directly under the Change line.
  const lines = template.split('\n');
  assert.deepEqual(pinLines(template), ['**Skill**: `{{SKILL_DIR}}` · sha256 `{{SKILL_SHA256}}`']);
  assert.equal(lines[lines.findIndex(l => l.startsWith('**Skill**')) - 1], '**Change**: {{CHANGE_ID}}');
  // The restore route's fact sits directly under the pin; the real parser below must not read
  // it as a second pin line, which the MATCH on this filled template proves.
  assert.equal(lines[lines.findIndex(l => l.startsWith('**Skill**')) + 1], '**Skill source**: {{SKILL_SOURCE}}');

  const hex = skillHex(skillDir, repo.cwd, env);
  const contractPath = path.join(repo.cwd, ...LEDGER_DIR.split('/'), '00-READBEFORE.md');
  const filled = fill(template, { SKILL_DIR, SKILL_SHA256: hex, LEDGER_DIR, CHANGE_ID: LEDGER_ID });
  fs.mkdirSync(path.dirname(contractPath), { recursive: true }); fs.writeFileSync(contractPath, filled);
  assert.deepEqual(pinLines(filled), ['**Skill**: `' + SKILL_DIR + '` · sha256 `' + hex + '`'], 'the directory is stored RAW, never quoted');

  // The boot step's own bytes, run from the worktree root: MATCH.
  const command = pinCommandOf(filled);
  const match = runCommand(command, repo.cwd, env);
  assert.equal(match.stdout, 'SKILL MATCH ' + hex + '\n', match.stderr);
  assert.equal(match.status, 0);

  // Control: without its quotes the same command splits the path and never reaches the tool.
  const unquoted = command.replace(/"/g, '');
  assert.ok(argvOf(unquoted).length > argvOf(command).length, 'the control must actually split the spaced path');
  const broken = runCommand(unquoted, repo.cwd, env);
  assert.notEqual(broken.status, 0); assert.doesNotMatch(broken.stdout, /SKILL MATCH/);

  // One altered hex digit: MISMATCH, naming both hashes.
  const other = (hex[0] === 'a' ? 'b' : 'a') + hex.slice(1);
  fs.writeFileSync(contractPath, filled.replace('sha256 `' + hex + '`', 'sha256 `' + other + '`'));
  const digit = runCommand(command, repo.cwd, env);
  assert.equal(digit.stdout, 'SKILL MISMATCH pinned ' + other + ' actual ' + hex + '\n'); assert.equal(digit.status, 1);

  // Any change to the pinned directory: MISMATCH against the original pin.
  fs.writeFileSync(contractPath, filled);
  fs.appendFileSync(path.join(skillDir, 'SKILL.md'), '\n');
  const changed = runCommand(command, repo.cwd, env);
  assert.match(changed.stdout, new RegExp('^SKILL MISMATCH pinned ' + hex + ' actual (?!' + hex + ')[0-9a-f]{64}\\n$'));
  assert.equal(changed.status, 1);
});

// The template's clear threshold line and its registry row, read through orchestrate-mod/tools/ledger-view.mjs
// `clearThreshold` and `DEFAULT_CLEAR_THRESHOLD` (`mod`, that module's exports) rather than a hand copy of its reader,
// so the line is held to the form and the default orchestrate-mod reads. Each fault in `text` (the template) and
// `row` (its {{CLEAR_THRESHOLD}} registry row): the field line not held once, or the template with that line filled
// not read as the filled value; the line not directly under the Skill source line; a row naming no single default
// or no single `<n>` form; the form not filling the line as the mod reads it; the default, or any digit-led value
// the row states, not read as the mod's default.
const ledgerViewTool = () => import(require('node:url').pathToFileURL(path.join(ROOT, 'orchestrate-mod/tools/ledger-view.mjs')).href);
function thresholdFaults(text, row, mod) {
  const lines = text.split('\n'), field = '**Clear threshold**: {{CLEAR_THRESHOLD}}', faults = [];
  const at = lines.indexOf(field), held = lines.filter(l => l === field).length;
  // A contract's line, read as the mod reads it: the tokens it holds, or undefined when the mod reads none from it.
  const tokens = contract => { const read = mod.clearThreshold(contract); return read.source === 'contract' ? read.tokens : undefined; };
  if (held !== 1) faults.push('the field line is held ' + held + ' times');
  else {
    const read = mod.clearThreshold(text.replace(field, () => '**Clear threshold**: 450K'));
    if (read.source !== 'contract' || read.tokens !== 450000) faults.push('the template filled with 450K reads as ' + JSON.stringify(read));
  }
  if (at < 1 || lines[at - 1] !== '**Skill source**: {{SKILL_SOURCE}}') faults.push('not under the Skill source line');
  const reads = value => tokens(fill(field, { CLEAR_THRESHOLD: value }));
  const defaults = [...row.matchAll(/default `([^`]+)`/g)].map(m => m[1]), forms = [...row.matchAll(/`<n>([^`]*)`/g)].map(m => m[1]);
  if (defaults.length !== 1) faults.push('the row publishes defaults ' + JSON.stringify(defaults));
  if (forms.length !== 1) faults.push('the row shows forms ' + JSON.stringify(forms));
  else if (reads('450' + forms[0]) !== 450000) faults.push('the form <n>' + forms[0] + ' does not fill the line as the mod reads it');
  for (const value of new Set([...defaults, ...[...row.matchAll(/`(\d[^`]*)`/g)].map(m => m[1])])) {
    if (reads(value) !== mod.DEFAULT_CLEAR_THRESHOLD) faults.push('the value ' + value + ' does not read as the mod\'s default ' + mod.DEFAULT_CLEAR_THRESHOLD);
  }
  return faults;
}
test('the clear threshold line sits under the Skill source line, and the registry default fills it in the form orchestrate-mod reads', async () => {
  const mod = await ledgerViewTool(), DEFAULT = mod.DEFAULT_CLEAR_THRESHOLD;
  assert.equal(typeof mod.clearThreshold, 'function', 'ledger-view.mjs exports the reader');
  assert.ok(Number.isSafeInteger(DEFAULT) && DEFAULT > 0, 'ledger-view.mjs exports its default');
  const row = registryRow('CLEAR_THRESHOLD'), source = '**Skill source**: {{SKILL_SOURCE}}', field = '**Clear threshold**: {{CLEAR_THRESHOLD}}';
  assert.deepEqual(thresholdFaults(template, row, mod), []);
  // Live: the line moved above the Skill source line; held twice, as itself, and beside it a second line the mod
  // reads as one, indented under boot step 6 and with its colon inside the emphasis.
  assert.ok(template.split(source + '\n' + field + '\n').length === 2, 'the controls must find the two lines together once');
  assert.deepEqual(thresholdFaults(template.replace(source + '\n' + field, () => field + '\n' + source), row, mod), ['not under the Skill source line']);
  const stepSix = '6. **Resume-time validation**: run the validation wrapper (§Validation commands) on the integration\n';
  assert.equal(template.split(stepSix).length, 2, 'the control must find boot step 6 once');
  assert.deepEqual(thresholdFaults(template + '\n' + field + '\n', row, mod), ['the field line is held 2 times'], 'the field line held twice must be reported');
  assert.deepEqual(thresholdFaults(template.replace(field, () => '**Clear threshold:** {{CLEAR_THRESHOLD}}'), row, mod), ['the field line is held 0 times', 'not under the Skill source line'],
    'the field line rewritten must be reported');
  const lineOf = (text, line) => text.split('\n').indexOf(line) + 1, FIELD_AT = lineOf(template, field);
  const SECOND = [['   **Clear threshold** above is read by the mod.', template.replace(stepSix, () => stepSix + '   **Clear threshold** above is read by the mod.\n')],
    ['**Clear threshold:** 300K', template + '\n**Clear threshold:** 300K\n']];
  assert.deepEqual(SECOND.map(([line, text]) => [line, thresholdFaults(text, row, mod)]),
    SECOND.map(([line, text]) => [line, ['the template filled with 450K reads as ' + JSON.stringify({ error: 'lines ' + FIELD_AT + ', ' + lineOf(text, line) + ' each open with **Clear threshold**' })]]),
    'a second line opening with the field name must be reported');
  // Live: defaults the mod would not read as its own, no default, the form and the missing-line value rewritten.
  const BAD = ['300 K', '300k', '300', '0.3M', '300000', '250K', 'about 300K', 'K300'];
  assert.deepEqual(BAD.map(bad => [bad, thresholdFaults(template, row.replace('default `300K`', () => 'default `' + bad + '`'), mod)]),
    BAD.map(bad => [bad, ['the value ' + bad + ' does not read as the mod\'s default ' + DEFAULT]]), 'each default the mod would not read as its own must be reported');
  assert.deepEqual(thresholdFaults(template, row.replace('default `300K`', () => 'no default'), mod), ['the row publishes defaults []']);
  assert.ok(row.split('`<n>K`').length === 2 && row.split('without it as `300K`').length === 2, 'the controls must find the form and the missing-line value once');
  assert.deepEqual(thresholdFaults(template, row.replace('`<n>K`', () => '`<n>k`'), mod), ['the form <n>k does not fill the line as the mod reads it']);
  assert.deepEqual(thresholdFaults(template, row.replace('without it as `300K`', () => 'without it as `250K`'), mod), ['the value 250K does not read as the mod\'s default ' + DEFAULT]);
  // Live: the row is held to the mod's default, not to a number written here; a mod whose default were 250K reports the
  // row's 300K, and the row rewritten to 250K throughout then passes.
  const mod250 = { ...mod, DEFAULT_CLEAR_THRESHOLD: 250000 };
  assert.deepEqual(thresholdFaults(template, row, mod250), ['the value 300K does not read as the mod\'s default 250000']);
  assert.deepEqual(thresholdFaults(template, row.split('`300K`').join('`250K`'), mod250), []);
  // Live: a reader that took a lowercase k would pass the rewritten form, so the form is held to the reader it is given.
  const lenient = { ...mod, clearThreshold: text => mod.clearThreshold(text.replace(/^(\*\*Clear threshold\*\*: \d+)k$/m, (m, head) => head + 'K')) };
  assert.deepEqual(thresholdFaults(template, row.replace('`<n>K`', () => '`<n>k`'), lenient), []);
});

test('an unfilled pin passes the code-span-exempt grep, so the pin check is what fails it', t => {
  const { repo, env } = fixture(t);
  const contractPath = path.join(repo.cwd, ...LEDGER_DIR.split('/'), '00-READBEFORE.md');
  const unfilled = fill(template, { SKILL_DIR: '{{SKILL_DIR}}', SKILL_SHA256: '{{SKILL_SHA256}}', LEDGER_DIR, CHANGE_ID: LEDGER_ID });
  fs.mkdirSync(path.dirname(contractPath), { recursive: true }); fs.writeFileSync(contractPath, unfilled);
  const outsideCode = unfilled.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '');
  assert.equal(outsideCode.includes('{{'), false, 'every unfilled pin placeholder sits in a code span the grep exempts');
  assert.ok(unfilled.includes('`{{SKILL_SHA256}}`'), 'the control must really leave the pin unfilled');
  const r = spawnSync(process.execPath, [path.join(ROOT, 'orchestrate/tools/check-ledger.mjs'), 'skill', '--contract', LEDGER_DIR + '/00-READBEFORE.md'],
    { cwd: repo.cwd, env, encoding: 'utf8', windowsHide: true, timeout: 60000 });
  assert.ifError(r.error);
  assert.equal(r.stdout, 'UNKNOWN Malformed skill pin line in ' + LEDGER_DIR + '/00-READBEFORE.md\n');
  assert.equal(r.status, 2);
});

// Every occurrence of a skill-directory token, in every shipped document and the README,
// is either a quoted argument ("TOKEN" or "TOKEN/path", closed before any whitespace) or a
// code span naming the token alone. `[SKILL_DIR]` is the prompt skeletons' slot for it.
const SKILL_TOKENS = /\{\{SKILL_DIR\}\}|<SKILL_DIR>|<skill-dir>|\[SKILL_DIR\]/g;
function unquotedSkillDirs(text) {
  const bad = [];
  for (const m of text.matchAll(SKILL_TOKENS)) {
    const before = text[m.index - 1], after = text[m.index + m[0].length];
    const quoted = before === '"' && /^(?:\/[^"\s]*)?"/.test(text.slice(m.index + m[0].length));
    const named = before === '`' && after === '`';
    if (!quoted && !named) bad.push(text.slice(Math.max(0, m.index - 30), m.index + m[0].length + 20));
  }
  return bad;
}
test('every command that uses the skill directory quotes it', () => {
  // Live controls: both unquoted shapes are caught, the two accepted shapes are not.
  assert.equal(unquotedSkillDirs('run `node {{SKILL_DIR}}/tools/x.mjs` now').length, 1);
  assert.equal(unquotedSkillDirs('`skill --dir <SKILL_DIR>`').length, 1);
  assert.equal(unquotedSkillDirs('`node "<skill-dir>/tools/x.mjs"`, `--dir "<SKILL_DIR>"` and `{{SKILL_DIR}}`').length, 0);
  assert.equal(unquotedSkillDirs('`--dir "<SKILL_DIR> x` `--dir <SKILL_DIR>"`').length, 2, 'a quote on one side only is not quoting');
  assert.equal(unquotedSkillDirs('`node [SKILL_DIR]/tools/x.mjs` and `node "[SKILL_DIR]/tools/x.mjs"`').length, 1, 'the skeleton slot is held to the same rule');
  // A quote that closes only after whitespace leaves the tool path and its arguments as one argument.
  assert.equal(unquotedSkillDirs('`node "<SKILL_DIR>/tools/check-ledger.mjs skill --dir "<SKILL_DIR>"`').length, 1,
    'a quoted run must close before any whitespace');
  let occurrences = 0;
  // Markdown is where commands are published; a tool's usage synopsis (`--dir <skill-dir>`) is not one.
  const markdown = documents().filter(f => f.endsWith('.md'));
  assert.ok(markdown.includes(TEMPLATE) && markdown.includes('orchestrate/SKILL.md') && markdown.includes('README.md'));
  for (const file of markdown) {
    const text = read(file);
    occurrences += [...text.matchAll(SKILL_TOKENS)].length;
    assert.deepEqual(unquotedSkillDirs(text), [], file + ': a skill-directory command must quote the directory');
  }
  const inTemplate = [...template.matchAll(/\{\{SKILL_DIR\}\}/g)].length;
  const quotedInTemplate = [...template.matchAll(/"\{\{SKILL_DIR\}\}\/tools\/[a-z-]+\.mjs"/g)].length;
  assert.equal(inTemplate, quotedInTemplate + 1, 'the template stores the directory raw exactly once (the pin line); every other use is a quoted command');
  assert.ok(quotedInTemplate >= 2, 'the template must run both the pin check and the validation wrapper from the pinned directory');
  assert.ok(occurrences > inTemplate, 'the sweep must reach documents beyond the template');
});

test('the boot sequence verifies the pin before reconcile, and a mismatch stops for the user', () => {
  const stepsOf = text => {
    const boot = section(text, '## Boot sequence', 'Implementer sub-agents:');
    return boot.split(/\n(?=\d+\. )/).slice(1).map(s => ({ n: Number(/^(\d+)\./.exec(s)[1]), text: collapse(s) }));
  };
  const order = text => {
    const steps = stepsOf(text);
    const at = needle => steps.findIndex(s => s.text.includes(needle));
    return { steps, pin: at('/tools/check-ledger.mjs" skill --contract'), procedure: at('**Procedure**'), reconcile: at('**Reconcile**'),
      validation: at('**Resume-time validation**'), worktree: at('git worktree list') };
  };
  const { steps, pin, procedure, reconcile, validation, worktree } = order(template);
  assert.deepEqual(steps.map(s => s.n), steps.map((_, i) => i + 1), 'boot steps are numbered consecutively');
  assert.ok(pin !== -1 && procedure !== -1 && reconcile !== -1 && validation !== -1 && worktree !== -1);
  assert.ok(worktree < pin, 'the pin check runs from the integration worktree, so after the step that establishes it');
  assert.ok(pin < procedure && procedure < reconcile && reconcile < validation,
    'the pin check runs first, then the pinned protocol.md is taken up, then reconcile per its §Recovery, then validation');
  assert.ok(steps[procedure].text.includes('protocol.md') && steps[reconcile].text.includes('protocol.md §Recovery'),
    'the procedure is the pinned protocol.md, and reconcile follows its §Recovery');
  assert.ok(steps[validation].text.includes('run the validation wrapper'), 'resume-time validation runs the wrapper');
  // Control: the same reader on a template with the pin step moved after reconcile.
  const swapped = template.replace(/(\n3\. \*\*Skill pin\*\*[\s\S]*?)(\n4\. \*\*Procedure\*\*[\s\S]*?\n5\. \*\*Reconcile\*\*[^\n]*)/, '$2$1');
  assert.notEqual(swapped, template, 'the control must move the pin step');
  const moved = order(swapped); assert.ok(moved.pin > moved.reconcile, 'the order reader must see a moved pin step');
  const step = steps[pin].text;
  for (const needed of ['`SKILL MATCH` → continue',
    'Anything but `SKILL MATCH` (including `SKILL MISMATCH`, `UNKNOWN` and a tool that does not run) → STOP and ask',
    "continue only on the user's explicit words, recorded verbatim in the session log", 'from the integration worktree root']) {
    assert.ok(step.includes(needed), 'the pin step must say: ' + needed);
  }
  const protocolStep = collapse(section(read('orchestrate/references/protocol.md'), '## §Session algorithm', '\n2. '));
  assert.match(protocolStep, /verifies it FIRST, before reconcile: `node "<skill-dir>\/tools\/check-ledger\.mjs" skill --contract /);
  assert.match(protocolStep, /`SKILL MATCH` continues; anything but `SKILL MATCH` \(including a tool that does not run\) STOPs and asks/);
  // Ordering in protocol.md by position, not by inclusion: nothing may place reconcile ahead of the pin check.
  assert.ok(protocolStep.indexOf('verifies it FIRST, before reconcile') < protocolStep.indexOf('SKILL MATCH'));
  // Mode continue in SKILL.md names the pin check at boot, and takes up the pinned protocol.md
  // only after it: a procedure read before the check could be a changed one still in context
  // after a mismatch is restored (R1 ASK 2).
  const cont = collapse(section(read('orchestrate/SKILL.md'), '## Mode: continue', '## Mode: status'));
  const pinAt = cont.indexOf('3. Boot (a pinned contract verifies its skill pin first) + reconcile');
  assert.ok(pinAt !== -1, 'SKILL.md Mode continue must name the pin check at boot');
  assert.ok(cont.indexOf('references/protocol.md') > pinAt, 'SKILL.md Mode continue must not take up the pinned protocol.md before the pin check');
  assert.ok(cont.slice(pinAt).includes('only on `SKILL MATCH`'), 'the pinned protocol.md is taken up only on SKILL MATCH');
});

const BACKGROUND_RULE = "Never pipe or tail it; when it may outlast the runtime's command timeout, run it as a background task "
  + 'whose completion reports the one line and the exit code, and never read the log before it exits.';
test('the validation section routes every run through validate.mjs, the recipe kept as manual procedure', () => {
  const validation = section(template, '## Validation commands', '## Version + changelog');
  assert.ok(validation.includes('{{VALIDATION_COMMANDS}}'), 'the human-readable recipe stays');
  const commands = validation.split('\n').filter(l => l.includes('/tools/validate.mjs'));
  assert.deepEqual(commands, ['node "{{SKILL_DIR}}/tools/validate.mjs" --spec {{LEDGER_DIR}}/validate.json --log "<session scratchpad>/<label>.log"']);
  const prose = collapse(validation);
  for (const needed of ['Every run goes through the validation wrapper, from the worktree root', BACKGROUND_RULE,
    'the log is read only when the line is not PASS', 'is the manual procedure when the wrapper is unavailable']) {
    assert.ok(prose.includes(needed), 'the validation section must say: ' + needed);
  }
  // The flags the contract publishes are the ones the real tool documents.
  const help = spawnSync(process.execPath, [path.join(ROOT, 'orchestrate/tools/validate.mjs'), '--help'], { encoding: 'utf8', windowsHide: true });
  assert.equal(help.status, 0); assert.match(help.stdout, /^validate\.mjs --spec <file\.json> --log <file>/);
  const protocolStep = collapse(section(read('orchestrate/references/protocol.md'), '## §Session algorithm', '\n2. '));
  assert.ok(protocolStep.includes('through `node "<skill-dir>/tools/validate.mjs" --spec <ledger-dir>/validate.json --log <file>`:'));
  assert.ok(protocolStep.includes(BACKGROUND_RULE), 'protocol.md states the user-approved background-task rule verbatim');
  // Every clause of the template and protocol.md naming the quiet form is the one manual-procedure clause.
  for (const file of [TEMPLATE, 'orchestrate/references/protocol.md']) {
    const quiet = clauses(read(file)).filter(c => /\bquiet[- ]form\b/i.test(c));
    assert.equal(quiet.length, 1, file + ': exactly one clause may name the quiet form — ' + quiet.join(' || '));
    assert.match(quiet[0], /\bmanual procedure\b/, file + ': the quiet form is only the manual procedure');
  }
  // The spawn-prompt list hands implementers the wrapper, not a bare quiet-form run. It lives
  // in protocol.md's step 5 since the template's copy of the procedure retired.
  const spawn = collapse(section(read('orchestrate/references/protocol.md'), '\n5. Spawn ALL', '\n6. Gate PER BATCH'));
  assert.ok(spawn.includes('validation commands (the wrapper command and its recipe)'));
  assert.ok(!template.includes('\n5. Spawn ALL'), 'the spawn step lives in protocol.md only');
});

// ===== A ledger filled from the real templates =====================================
const cellsOf = line => line.split('|').slice(1, -1).map(x => x.trim());
function withRows(text, keys, rows) {
  const lines = text.split('\n');
  const head = lines.findIndex(l => l.startsWith('|') && keys.every(k => cellsOf(l).includes(k)));
  assert.notEqual(head, -1, 'no table carrying ' + keys.join(', '));
  const header = cellsOf(lines[head]);
  return [...lines.slice(0, head + 2), ...rows.map(r => '| ' + header.map(k => r[k] ?? '—').join(' | ') + ' |'), ...lines.slice(head + 2)].join('\n');
}
function scaffold(fx) {
  const hex = skillHex(fx.skillDir, fx.repo.cwd, fx.env);
  const values = { SKILL_DIR: fx.SKILL_DIR, SKILL_SHA256: hex, LEDGER_DIR, CHANGE_ID: LEDGER_ID, BATCH_NUM: '01', BATCH_TITLE: 'One',
    BATCH_BRANCH: 'feat/one', BATCH_FILES: '`tests/ok.test.cjs`', BATCH_NEW_FILES: 'none', BATCH_TYPE: 'feature', BATCH_VERSION: '—' };
  const strip = text => text.replace(/<!--[\s\S]*?-->/g, '');
  const tpl = name => fill(read('orchestrate/templates/' + name), values);
  const row = { '#': 'B01', Batch: 'One', Branch: '`feat/one`', 'Files (fence)': '`tests/ok.test.cjs`', Notes: '—' };
  const files = {
    '00-READBEFORE.md': tpl('00-READBEFORE.md'), '00-request.md': strip(tpl('00-request.md')), 'LOG.md': strip(tpl('LOG.md')),
    '01-plan.md': strip(withRows(tpl('01-plan.md'), ['#', 'Branch', 'Files (fence)'], [row])),
    'PROGRESS.md': strip(withRows(tpl('PROGRESS.md'), ['#', 'Branch', 'Notes'], [row])),
    '02-batches-01-one.md': strip(tpl('02-batch.md')).replace(/(## Checklist\n)/, '$1\n- [ ] Implement example.\n'),
    // The machine form of a confirmed recipe, one step per command, as scaffolding.md's Fill step writes it.
    'validate.json': JSON.stringify({ steps: [
      { name: 'tests', argv: ['node', '--test', 'tests/ok.test.cjs'], parser: 'node' },
      { name: 'diff-check', argv: ['git', 'diff', '--check'], parser: 'none' }] }, null, 2) + '\n',
  };
  const templates = fs.readdirSync(path.join(ROOT, 'orchestrate/templates')).sort();
  assert.deepEqual(templates, ['00-READBEFORE.md', '00-request.md', '01-plan.md', '02-batch.md', 'LOG.md', 'PROGRESS.md'],
    'the fill below instantiates every shipped template; a new one must join it');
  for (const [name, text] of Object.entries(files)) fx.repo.write(LEDGER_DIR + '/' + name, text);
  fx.repo.write('tests/ok.test.cjs', "require('node:test')('ok', () => {});\n");
  return { hex, files };
}
const selfCheckOf = file => collapse(read(file));
// Whether `file` lies on disk under `cwd`, by `stat` (fs.lstatSync; a fixture passes its own): only
// ENOENT and ENOTDIR prove it absent, and any other error fails.
function onDisk(cwd, file, stat = fs.lstatSync) {
  try {
    stat(path.join(cwd, file));
    return true;
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false;
    throw error;
  }
}
// What the skill ships under tools/: the files git tracks there, at any depth, that the working tree
// under `cwd` holds by `present` (onDisk; a fixture passes its own), named relative to it, so an
// untracked or ignored file in the directory is no shipped tool (BL-087), and neither is a tracked
// one deleted from the tree.
function trackedTools(cwd = ROOT, env = process.env, present = onDisk) {
  const r = spawnSync('git', ['ls-files', '-z', '--', 'orchestrate/tools'], { cwd, env, encoding: 'utf8', windowsHide: true, timeout: 15000 });
  assert.ifError(r.error);
  assert.equal(r.status, 0, 'git ls-files must list orchestrate/tools: ' + r.stderr);
  return r.stdout.split('\0').filter(Boolean).filter(file => present(cwd, file))
    .map(file => file.startsWith('orchestrate/tools/') ? file.slice('orchestrate/tools/'.length) : file).sort();
}
test('the shipped tools are the files git tracks under orchestrate/tools that the tree holds, never an untracked, ignored or deleted one', t => {
  const repo = makeRepo(t);
  repo.write('.gitignore', '*.log\n');
  for (const file of ['orchestrate/tools/a.mjs', 'orchestrate/tools/deeper/b.mjs', 'orchestrate/tools/validate.mjs', 'orchestrate/tools/dir/c.mjs',
    'orchestrate/other.mjs']) repo.write(file, 'x\n');
  repo.commit('tools');
  repo.write('orchestrate/tools/untracked.mjs', 'x\n');
  repo.write('orchestrate/tools/ignored.log', 'x\n');
  // Deleted from the fixture's tree while the checkout still holds it, so existence is read under the fixture's cwd;
  // and a tracked tool under a directory that became a file.
  fs.rmSync(path.join(repo.cwd, 'orchestrate/tools/validate.mjs'));
  fs.rmSync(path.join(repo.cwd, 'orchestrate/tools/dir'), { recursive: true });
  repo.write('orchestrate/tools/dir', 'a file where a directory was\n');
  assert.deepEqual(trackedTools(repo.cwd, repo.env), ['a.mjs', 'deeper/b.mjs'],
    'tracked files on disk at any depth, named relative to tools/; no untracked, ignored, deleted or outside file');
  // Any failure but a proven absence stops the run: onDisk's on an lstat that fails as a denied one
  // does and on a path no file system accepts, and trackedTools's on a failing verdict, each rethrown
  // as it was thrown.
  const denied = Object.assign(new Error("EACCES: permission denied, lstat 'orchestrate/tools/a.mjs'"), { code: 'EACCES', syscall: 'lstat' });
  assert.throws(() => onDisk(repo.cwd, 'orchestrate/tools/a.mjs', () => { throw denied; }), error => error === denied);
  assert.throws(() => onDisk(repo.cwd, 'a\0b'), { code: 'ERR_INVALID_ARG_VALUE' });
  assert.throws(() => trackedTools(repo.cwd, repo.env, () => { throw denied; }), error => error === denied);
  assert.ok(trackedTools().includes('validate.mjs'), 'the listing must read the checkout\'s orchestrate/tools');
});

test('scaffolding self-check names the parse and pin checks, and a filled ledger passes both', t => {
  const selfCheck = section(selfCheckOf('orchestrate/references/scaffolding.md'), '9. **Self-check**', '10. **Scaffold commit**');
  assert.ok(selfCheck.includes('`node "<SKILL_DIR>/tools/check-ledger.mjs" parse --dir <the new ledger directory>` must print `PARSE OK`'));
  assert.ok(selfCheck.includes('skill --contract <the new ledger directory>/00-READBEFORE.md` must print `SKILL MATCH`'));
  const skillMd = section(selfCheckOf('orchestrate/SKILL.md'), 'self-check (grep the new directory', 'scaffold commit on');
  assert.match(skillMd, /`PARSE OK`[^)]*`SKILL MATCH`/);
  const fill8 = section(selfCheckOf('orchestrate/references/scaffolding.md'), '8. **Fill**', '9. **Self-check**');
  for (const needed of ['write `validate.json` into the ledger directory', 'write no `validate.json`', 'write `setup.json`', 'validation baseline']) {
    assert.ok(fill8.includes(needed), 'the Fill step must say: ' + needed);
  }
  // validate.mjs accepts both PowerShells; `pwsh` is preferred, `powershell` stays allowed where it is the only one.
  assert.ok(fill8.includes('prefer `pwsh`; use `powershell` only where `pwsh` is absent'));
  // Only parse is scaffold-time; the pin check also runs at every boot.
  assert.ok(selfCheck.includes('The parse check runs at scaffold time only'));
  assert.ok(selfCheck.includes('the pin check also runs at every boot'));
  assert.ok(collapse(read('orchestrate/SKILL.md')).includes('the fill bakes the `**Skill**` pin line and writes `validate.json`, plus `setup.json` when there is a setup step'));
  const baking = section(selfCheckOf('orchestrate/references/scaffolding.md'), '## Evidence and input baking', '## Naming');
  assert.ok(baking.includes('Bake `{{SKILL_DIR}}` and `{{SKILL_SHA256}}` too: `validate.mjs`, `check-ledger.mjs` and every later skill tool'));
  assert.ok(baking.includes('run as `node "{{SKILL_DIR}}/tools/<tool>.mjs"`'));
  const readme = read('README.md');
  assert.ok(collapse(readme).includes("Update an installed copy (a `git pull` in the clone counts) only between ledgers: a ledger's contract pins the skill's hash, and an updated copy stops that ledger's next session and asks."));
  // The README's tools tree lists every file the skill ships under tools/ — the tracked listing is the domain.
  const tree = section(readme, "## What's in here", '```\n\n');
  const listed = [...tree.matchAll(/^ {4}[├└]── (\S+) {2,}\S/gm)].map(m => m[1]).sort();
  assert.deepEqual(listed, trackedTools(), 'the README tools tree must describe every shipped tool');
  assert.deepEqual([...'    ├── x.mjs   y\n    └── z.mjs   w\n'.matchAll(/^ {4}[├└]── (\S+) {2,}\S/gm)].map(m => m[1]), ['x.mjs', 'z.mjs']);

  const fx = fixture(t);
  const { hex } = scaffold(fx);
  const tool = path.join(fx.skillDir, 'tools', 'check-ledger.mjs');
  const cli = args => spawnSync(process.execPath, [tool, ...args], { cwd: fx.repo.cwd, env: fx.env, encoding: 'utf8', windowsHide: true, timeout: 60000 });
  const parsed = cli(['parse', '--dir', LEDGER_DIR]);
  assert.equal(parsed.stdout, 'PARSE OK 1 batches\n', parsed.stderr); assert.equal(parsed.status, 0);
  const pinned = cli(['skill', '--contract', LEDGER_DIR + '/00-READBEFORE.md']);
  assert.equal(pinned.stdout, 'SKILL MATCH ' + hex + '\n'); assert.equal(pinned.status, 0);
  // The wrapper command as the filled contract publishes it, run from the worktree root.
  const contract = fs.readFileSync(path.join(fx.repo.cwd, ...LEDGER_DIR.split('/'), '00-READBEFORE.md'), 'utf8');
  const published = section(contract, '## Validation commands', '## Version + changelog').split('\n').find(l => l.includes('/tools/validate.mjs'));
  const log = slash(path.join(fx.temp, 'session scratch', 'tip.log'));
  const ran = runCommand(published.replace('<session scratchpad>/<label>.log', log), fx.repo.cwd, fx.env);
  assert.match(ran.stdout, /^PASS tests [^;\n]*; diff-check [^\n]*\n$/, ran.stdout + ran.stderr); assert.equal(ran.status, 0);
  assert.ok(fs.statSync(log).size > 0, 'the wrapper writes its full log');
  // Control: the same ledger with its PROGRESS row gone fails the parse check.
  fx.repo.write(LEDGER_DIR + '/PROGRESS.md', fs.readFileSync(path.join(fx.repo.cwd, ...LEDGER_DIR.split('/'), 'PROGRESS.md'), 'utf8')
    .replace(/^\| B01 \|.*\n/m, ''));
  const failed = cli(['parse', '--dir', LEDGER_DIR]);
  assert.match(failed.stdout, /^PARSE FAIL /); assert.equal(failed.status, 1);
});

test('SKILL.md discovery resolves from the skill directory, from any repository', t => {
  const skillMd = read('orchestrate/SKILL.md');
  const discovery = collapse(section(skillMd, '## Discovery', '1. Find ledgers'));
  const m = /`(node "<skill-dir>\/tools\/git-evidence\.mjs" discovery --repo <repo>)`/.exec(discovery);
  assert.ok(m, 'the discovery command runs git-evidence.mjs from <skill-dir>');
  assert.ok(discovery.includes('`<skill-dir>` is the directory holding this `SKILL.md`'), '<skill-dir> is defined');
  // Resolved as defined — the directory holding a SKILL.md, here a copy outside this repository.
  const fx = fixture(t);
  const r = runCommand(m[1].replace('<skill-dir>', fx.SKILL_DIR).replace('<repo>', slash(fx.repo.cwd)), fx.repo.cwd, fx.env);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(JSON.parse(r.stdout).completeness, 'complete');
});

// ===== The pinned-skill rule, in all five places that stated the closed system ======
// Since B01 of OS-20260925 the rule has three halves: the ledger references only its pinned
// directory; its procedure is that directory's `references/protocol.md`, frozen by the hash,
// which also holds every tool step's manual procedure; a session drives the ledger from the
// ledger plus that directory.
const PASSAGES = [
  ['README.md', '- **Ledgers are closed systems.**', '- **Statuses are claims'],
  ['README.md', '- **Rollout boundary.**', '## Install'],
  ['orchestrate/SKILL.md', 'Ledgers are CLOSED SYSTEMS', 'Full spec:'],
  ['orchestrate/references/protocol.md', 'A scaffolded ledger is a **closed system**', '## Roles, gates, tiers'],
  ['orchestrate/references/scaffolding.md', '## Baking rule', undefined],
];
const RULE = [
  'references ONLY its pinned skill directory, by absolute path and hash',
  "its procedure is that directory's `references/protocol.md`, frozen by the hash",
  'every step a tool performs also has its manual procedure there',
  'changed skill stops the ledger at its next boot and asks, and never silently changes how it runs',
];
// The pre-pin claims (commit 5c24ece), kept as their exact sources: the family below must stay
// a superset of them. They are bound to the family AS IT STOOD before B01, read from git the way
// protocol-contract.test.cjs reads the pre-slimming template: narrowing an entry here would
// otherwise narrow both sides of a superset check built from this list alone.
const FAMILY_BASE = 'edd2f1e';
function baseFamily() {
  const blob = spawnSync('git', ['-C', ROOT, 'show', FAMILY_BASE + ':tests/tool-wiring.test.cjs'], { encoding: 'utf8', windowsHide: true });
  assert.ifError(blob.error); assert.equal(blob.status, 0, 'the old-claim family at ' + FAMILY_BASE + ' must be readable: ' + blob.stderr);
  const text = blob.stdout.replace(/\r\n/g, '\n'), start = text.indexOf('const OLD_CLAIMS = [\n'), end = text.indexOf('\n];', start);
  assert.ok(start !== -1 && end > start, FAMILY_BASE + ': no OLD_CLAIMS literal to read');
  return text.slice(start, end).split('\n').slice(1).map(line => {
    const m = /^\s*\/(.+)\/([a-z]*),$/.exec(line);
    assert.ok(m, FAMILY_BASE + ': an OLD_CLAIMS line that is not one regex literal — ' + line);
    return { source: m[1], flags: m[2] };
  });
}
const PRE_PIN_CLAIMS = [
  String.raw`\bnever\s+references?\s+(?:this|the)\s+skill\b`,
  String.raw`\bnever\s+generate\s+a\s+ledger\s+that\s+references\s+(?:this|the)\s+skill\b`,
  String.raw`\b(?:must not|does not|doesn't|cannot)\s+reference\s+(?:this|the)\s+skill\b`,
  String.raw`\bnever\s+referenced\b[^.]*\bskill\b`,
  String.raw`\bchanges nothing about (?:ledgers|a ledger) already scaffolded\b`,
  String.raw`\bwith or without this skill\s*—`,
];
const OLD_CLAIMS = [
  ...PRE_PIN_CLAIMS.map(source => new RegExp(source, 'i')),
  // The copied-procedure claims B01 retired: the ledger alone suffices, its manual procedures
  // are baked, it stays drivable without the skill, or the contract carries the procedure.
  /\bby reading the ledger alone\b/i,
  /\bbaked manual (?:procedures?|fallback)\b/i,
  /\bdrivable without (?:it|this skill|the skill)\b/i,
  /\b(?:session|one) (?:that has never seen|without) (?:this|the) skill\b/i,
  /\bexplained inside the ledger['’]s own files\b/i,
  /\bthe contract['’]s (?:§\s*)?(?:Recovery|Session algorithm|Fence changes|manual (?:procedures?|(?:read-only )?fallback))\b/i,
  /\b(?:Recovery|Session algorithm|Fence changes) in the contract\b/i,
  /\bcontract:? (?:boot(?: sequence)?|the boot), roles\b/i,
  /\bbake[sd]?\b[^.;]{0,80}\b(?:manual fallback|helper paths)\b[^.;]{0,80}\binto\b[^.;]{0,30}\bcontracts?\b/i,
  /\bmirror each other\b/i,
];
// The passages' own wording before each rule, verbatim with whitespace collapsed, plus
// invented variants — every one must be caught, and every pattern must catch at least one,
// so no pattern is padding and no old passage slips through.
const OLD_SPECIMENS = [
  'A ledger never references this skill, so it stays drivable without it.',
  "A ledger's own contract outranks the skill, so a new skill version changes nothing about ledgers already scaffolded; it reaches a repo through the next `/orchestrate new`.",
  'Ledgers are CLOSED SYSTEMS: every repo fact is baked in at scaffold time, so any session — with or without this skill — can drive one by reading the ledger alone.',
  'A session without this skill can drive the change by reading the ledger alone — that property is the point; never generate a ledger that references this skill.',
  'Interview answers are written INTO the generated `00-READBEFORE.md` — never referenced back to this skill.',
  'A ledger must not reference this skill.',
  // Retired by B01, each the wording of a passage at edd2f1e.
  'A ledger references ONLY its pinned skill directory, by absolute path and hash, and every step a tool performs also has a baked manual procedure (the recipe block for validation, the pasted-prompt list for spawning, the fence\'s manual fallback).',
  "It references ONLY its pinned skill directory, by absolute path and hash, and stays drivable without it through its baked manual procedures, so a new skill version never rewrites a ledger already scaffolded.",
  "each ledger must be drivable by a session that has never seen this skill — or has a changed one: State line, LOG.md, `NEEDS_FENCE`, ASK, tiers, runners, evidence, fold-ins and their ids are all explained inside the ledger's own files.",
  'Reconcile against branches/commits before believing any row (§Recovery in the contract).',
  "reconcile every row that is not ✅/👤/⛔ (dropped) against git per the contract's §Recovery table",
  "Existing ledgers keep their frozen rules; unsupported helper shapes use the contract's manual read-only fallback.",
  '| `00-READBEFORE.md` | The contract: boot sequence, roles/gates/tiers, git model, fence changes, checkpoints, validations, recovery, session algorithm |',
  'Bake resolved EVIDENCE_TOOL and FENCE_TOOL paths plus the full manual fallback, three outcomes, captured-ref authority and supported grammar into new contracts.',
  '`protocol.md` and the contract template mirror each other, pinned by `tests/protocol-contract.test.cjs`.',
];
test('the five closed-system passages state the pinned-skill rule, and no document keeps the old claim', { skip: 'needs history and ledger records that are not in this copy' }, () => {
  assert.equal(PASSAGES.length, 5);
  assert.equal(new Set(PASSAGES.map(p => p[0] + p[1])).size, 5, 'five distinct passages');
  for (const [file, from, to] of PASSAGES) {
    const passage = collapse(section(read(file), from, to));
    for (const phrase of RULE) assert.ok(passage.includes(phrase), file + ' (' + from + '): must state "' + phrase + '"');
    assert.match(passage, /\bdriv(?:e|es|able)\b[^.;]*\bfrom the ledger plus its pinned directory\b/,
      file + ' (' + from + '): must say a session drives the ledger from the ledger plus its pinned directory');
  }
  // A superset of the family it replaced: every source the edd2f1e family held is still a
  // member, verbatim and with its flags, and PRE_PIN_CLAIMS is exactly that family.
  const family = baseFamily();
  assert.equal(family.length, 6, FAMILY_BASE + ' held six old-claim patterns');
  assert.deepEqual(family.map(f => f.source), PRE_PIN_CLAIMS, 'PRE_PIN_CLAIMS must be the family this sweep replaced, unnarrowed');
  for (const { source, flags } of family) {
    const old = new RegExp(source, flags);
    assert.ok(OLD_CLAIMS.some(p => p.source === old.source && p.flags === old.flags), 'the old-claim family lost: /' + source + '/' + flags);
  }
  assert.ok(OLD_CLAIMS.length > PRE_PIN_CLAIMS.length);
  for (const specimen of OLD_SPECIMENS) assert.ok(OLD_CLAIMS.some(p => p.test(specimen)), 'no old-claim pattern catches: ' + specimen);
  for (const pattern of OLD_CLAIMS) assert.ok(OLD_SPECIMENS.some(s => pattern.test(s)), 'old-claim pattern catches no specimen: ' + pattern);
  // CLAUDE.md states the repository's own convention for these files, so it is swept too.
  const files = [...documents(), 'CLAUDE.md'];
  assert.ok(files.length > 10 && files.includes('orchestrate/templates/00-READBEFORE.md'));
  for (const file of files) {
    const text = collapse(read(file));
    for (const pattern of OLD_CLAIMS) assert.doesNotMatch(text, pattern, file + ': still carries a pre-pin or copied-procedure claim');
  }
});

// ===== The pin-mismatch branch: upgrade on recorded words, or restore and re-check =====
// The contract's manual procedures used to be the fallback on a mismatch; two of the three now
// live in exactly the directory a mismatch says changed. Every carrier states the new branch.
const MISMATCH_CARRIERS = [
  [TEMPLATE, '3. **Skill pin**', '\n4. **Procedure**'],
  ['orchestrate/references/protocol.md', '1. Boot + reconcile', '\n2. Repairs first'],
  ['README.md', '- **Rollout boundary.**', '## Install'],
];
test('on a pin mismatch every carrier offers the same two ways on and none falls back on the contract\'s procedures', () => {
  assert.equal(MISMATCH_CARRIERS.length, 3);
  for (const [file, from, to] of MISMATCH_CARRIERS) {
    const passage = collapse(section(read(file), from, to));
    for (const [what, pattern] of [['the user\'s recorded words', /\bwords\b/], ['an upgrade', /\bupgrade\b/i], ['a restore', /\brestore\b/i],
      ['the Skill source line', /`\*\*Skill source\*\*` line/], ['a byte-for-byte rebuild', /\bbyte-for-byte\b/],
      ['the pin re-checked', /\bpin(?: check)? (?:re-run|re-checked)\b/]]) {
      assert.match(passage, pattern, file + ' (' + from + '): the mismatch branch must name ' + what);
    }
    assert.doesNotMatch(passage, /manual procedures\b|§Session algorithm step 5|manual fence fallback/i,
      file + ' (' + from + '): the mismatch branch must not fall back on procedures that live in the pinned directory');
  }
  // The restore route needs the fact it rebuilds from: one line, in the template and the registry.
  assert.equal(template.split('\n').filter(l => l.startsWith('**Skill source**: ')).length, 1);
  assert.ok(registryRow('SKILL_SOURCE').includes('byte-for-byte'), 'the {{SKILL_SOURCE}} row says what a restore does with it');
});

// ===== No repo-relative tool path, anywhere ===========================================
// protocol.md's evidence section used to be exempt: it mirrored the template, whose helper
// paths were baked at scaffold time, and ran `node orchestrate/tools/…`. Since B01 of
// OS-20260925 its recipes run from `"<skill-dir>/tools/…"` and nothing is exempt.
const REPO_RELATIVE = /\bnode\s+["']?(?:\.[\/\\])?orchestrate[\/\\]tools[\/\\]/g;
const EVIDENCE_SECTION = /### Read-only evidence tools\n[\s\S]*?(?=\n## )/;
// Structural: every occurrence of `tools/<name>` or `tools\<name>`, for every tool the skill
// ships (bound to the directory listing, not a hand list of spellings), must be the tail of a
// quoted placeholder directory — `"{{X}}/tools/<name>"`, `"<x>/tools/<name>"` or, inside a
// prompt skeleton, `"[X]/tools/<name>"` — closing right after the name.
const toolNames = () => fs.readdirSync(path.join(ROOT, 'orchestrate/tools')).filter(n => n.endsWith('.mjs'));
function toolPathFaults(text, names) {
  const escaped = names.map(n => n.replace(/\./g, '\\.')).join('|');
  const faults = [];
  for (const m of text.matchAll(new RegExp('tools[\\\\/](?:' + escaped + ')', 'g'))) {
    const before = text.slice(Math.max(0, m.index - 80), m.index), after = text[m.index + m[0].length];
    const quotedDir = /"(?:\{\{[A-Z_]+\}\}|<[A-Za-z_ -]+>|\[[A-Z_]+\])\/$/.test(before);
    if (!quotedDir || after !== '"') faults.push(text.slice(Math.max(0, m.index - 30), m.index + m[0].length + 10));
  }
  return faults;
}
// smoke-page.md ran `node tools/build-smoke-page.mjs …`, relative to the skill directory,
// and was declared here with its two faults; B01 of OS-20260925 retired both (BL-028's doc
// half). The list stays, held EMPTY, so a new fault is a visible decision rather than a
// quietly re-added exemption.
const KNOWN_TOOL_PATH_FAULTS = {};
test('every shipped command naming a skill tool quotes a placeholder directory, both slash directions', () => {
  const names = toolNames();
  assert.ok(names.includes('check-ledger.mjs') && names.includes('validate.mjs') && names.length >= 7, 'bound to the real tools listing');
  // Controls: each broken shape is caught, the accepted shapes are not.
  for (const bad of ['`node <skill>/tools/check-ledger.mjs skill --contract x`', '`node orchestrate\\tools\\check-ledger.mjs`',
    '`node "orchestrate/tools/validate.mjs"`', '`node "<SKILL_DIR>/tools/check-ledger.mjs skill --dir "<SKILL_DIR>"`',
    '`node tools/build-smoke-page.mjs a b`', '`node [SKILL_DIR]/tools/validate.mjs`', '`node "[SKILL_DIR]/tools/validate.mjs --spec x"`']) {
    assert.equal(toolPathFaults(bad, names).length, 1, 'must be caught: ' + bad);
  }
  assert.deepEqual(toolPathFaults('`node "{{SKILL_DIR}}/tools/validate.mjs" --spec x` `node "<skill-dir>/tools/git-evidence.mjs" discovery` `node "[SKILL_DIR]/tools/validate.mjs" --spec x`', names), []);
  assert.deepEqual(KNOWN_TOOL_PATH_FAULTS, {}, 'every known tool-path fault is retired; none may be added back');
  let seen = 0;
  for (const file of documents().filter(f => f.endsWith('.md'))) {
    const text = read(file);
    seen += [...text.matchAll(/tools[\\/][a-z-]+\.mjs/g)].length;
    const faults = toolPathFaults(text, names);
    assert.ok(faults.length <= (KNOWN_TOOL_PATH_FAULTS[file] || 0), file + ': a tool command without a quoted placeholder directory — ' + faults.join(' || '));
  }
  assert.ok(seen >= 6, 'the sweep must see the published tool commands');
});
test('no shipped Markdown runs node orchestrate/tools/, and the evidence recipes run from <skill-dir>', () => {
  const protocol = read('orchestrate/references/protocol.md');
  // The formerly exempt section holds live recipes, every one in the pinned-directory form.
  const evidence = (EVIDENCE_SECTION.exec(protocol) || [''])[0];
  const recipes = evidence.split('\n').filter(l => l.startsWith('node '));
  assert.ok(recipes.length > 0 && recipes.every(l => l.startsWith('node "<skill-dir>/tools/')),
    'protocol.md §Read-only evidence tools must publish its recipes as node "<skill-dir>/tools/<tool>.mjs": ' + recipes.join(' || '));
  assert.deepEqual(toolPathFaults(evidence, toolNames()), [], 'each evidence recipe quotes its placeholder directory');
  // Planted controls: caught anywhere, either slash direction, the evidence section included.
  const skillMd = read('orchestrate/SKILL.md');
  assert.ok(((skillMd + '\nRun `node orchestrate/tools/check-ledger.mjs parse`.\n').match(REPO_RELATIVE) || []).length === 1);
  assert.ok(((skillMd + '\nRun `node orchestrate\\tools\\check-ledger.mjs parse`.\n').match(REPO_RELATIVE) || []).length === 1);
  const planted = protocol.replace('### Read-only evidence tools\n', '### Read-only evidence tools\nnode orchestrate/tools/x.mjs\n');
  assert.notEqual(planted, protocol);
  assert.equal((planted.match(REPO_RELATIVE) || []).length, 1, 'the evidence section is no longer exempt');
  // Every tool a ledger's procedure runs is run from the ledger's pinned directory: in the two
  // documents that publish those invocations, each one reads node "<skill-dir>/tools/<tool>.mjs".
  const INVOCATION = /\bnode\s+("?)([^\s"`]*?)tools[\\/]([a-z-]+\.mjs)/g;
  assert.equal([...'node "<skill-dir>/tools/a.mjs" x; node tools/b.mjs; node "<SKILL_DIR>/tools/c.mjs"'.matchAll(INVOCATION)]
    .filter(m => m[1] + m[2] !== '"<skill-dir>/').length, 2, 'the invocation reader must see both other spellings');
  for (const file of ['orchestrate/references/protocol.md', 'orchestrate/references/smoke-page.md']) {
    const found = [...read(file).matchAll(INVOCATION)];
    assert.ok(found.length > 0, file + ': publishes tool invocations');
    assert.deepEqual(found.filter(m => m[1] + m[2] !== '"<skill-dir>/').map(m => m[0]), [],
      file + ': every tool invocation must read node "<skill-dir>/tools/<tool>.mjs"');
  }
  const markdown = shipped().filter(f => f.endsWith('.md'));
  assert.ok(markdown.includes('orchestrate/SKILL.md') && markdown.length > 8, 'the sweep walks every shipped Markdown file');
  for (const file of markdown) {
    assert.deepEqual(read(file).match(REPO_RELATIVE), null, file + ': runs a tool by a path only this repository resolves');
  }
});

// ===== Directives that would undo the rules ============================================
// Clause-level: a pattern match is a directive unless a negation GOVERNS it — a negator
// directly before the matched words (one word, or "under any circumstance", may intervene;
// "not only", "why not" and a double negation do not govern). The negation is checked at
// EVERY position a directive could start, so a negated verb early in a clause cannot carry a
// later, un-negated one. A negation elsewhere in the clause exempts nothing. Each pattern owns
// an affirmative specimen; the controls below pin both sides of the negation rule. A background
// TASK whose completion reports the line and exit code is the user-approved rule (2026-09-23),
// so only a shell `&`, not waiting for the line, piping, tailing, or reading the log early are caught.
// The load-bearing passages themselves are pinned by equality in the next test; this sweep
// is for the rest of the documents.
const UNDO = [
  ['pipe the validation output', /\bpip(?:e|es|ed|ing)\b[^.;:]*\b(?:validat\w*|wrapper|validate\.mjs)\b/i, 'Pipe the validation output through Select-Object to shorten it'],
  ['pipe into tail', /\b(?:validat\w*|wrapper|validate\.mjs)\b[^.;:]*\|\s*(?:tail|head|Select-Object|more|tee)\b/i, 'Run validate.mjs | tail -20 to see the end'],
  ['tail the validation output', /\btail\w*\s+(?:the|its)\s+(?:validation|wrapper|log)\b/i, 'Tail the validation output while it runs'],
  ['detach with a shell job', /\b(?:validat\w*|wrapper|validate\.mjs)\b[^.;:]*(?:\s&(?=\s|`|$)|\bStart-Job\b|\bnohup\b)/i, 'Start the wrapper with a trailing & and keep working'],
  ['move on without the line', /\bwithout waiting for\b[^.;:]*\b(?:line|exit code|result|completion|wrapper|validation)\b/i, 'Start the wrapper in the background and move on without waiting for its line'],
  ['read the log before it exits', /\bread\w*\s+(?:the\s+)?(?:validation\s+|wrapper's\s+)?log\b[^.;:]*\b(?:while|before|during)\b/i, 'Read the log while the wrapper runs to catch failures early'],
  ['read the log on every run', /\b(?:always\s+read\w*\s+(?:the\s+)?(?:full\s+|whole\s+)?log\b|read\w*\s+(?:the\s+)?(?:full\s+|whole\s+)log\b[^.;:]*\b(?:every|each|always)\b)/i, 'Read the full log after every run'],
  ['run the recipe instead of the wrapper', /\b(?:run|use)s?\b[^.;:]*\b(?:block above|recipe|validation commands)\b[^.;:]*\b(?:directly|instead|rather than)\b/i, 'When the suite is slow, run the block above directly instead'],
  ['skip the pin check', /\b(?:skip|bypass|ignore|omit)\w*\b[^.;:]*\b(?:pin check|skill pin|pin line|SKILL MISMATCH)\b/i, 'Skip the pin check when the skill was only updated'],
  ['continue on a mismatch or unknown', /(?:SKILL MISMATCH|\bUNKNOWN\b)[^.;:]*\b(?:[Cc]ontinue|[Pp]roceed)s?\b/, 'On a SKILL MISMATCH, continue with the new skill'],
  ['continue despite a later mismatch', /\b(?:[Cc]ontinu|[Pp]roceed)\w*\b[^.;:]*(?:SKILL MISMATCH|\bUNKNOWN\b)/, 'Continue with Reconcile on a `SKILL MISMATCH` from a moved directory'],
  ['only a mismatch stops', /\b[Oo]nly\s+(?:an?\s+)?`?(?:SKILL MISMATCH|UNKNOWN)`?[^.;:]*\bstop/, 'Only a `SKILL MISMATCH` stops the session'],
  ['the pin check made conditional', /\b(?:pin check|skill pin)\b[^.;:]*\b(?:only (?:if|when)|optional|unless)\b/i, 'Run the pin check only if the skill directory moved'],
  ['reconcile before the pin check', /\b[Rr]econcile\b[^.;:]*\b(?:first|before)\b[^.;:]*\bpin\b/, 'Reconcile first, then run the pin check'],
  ['pin check after reconcile', /\b(?:pin check|skill pin|pin)\b[^.;:]*\b(?:after|once)\b[^.;:]*\breconcil/i, 'Run the pin check after reconcile'],
  ['pin check at scaffold time only', /\b(?:both|pin check|skill check|skill --contract)\b[^.;:]*\bscaffold[- ]time only\b/i, 'Both run at scaffold time only'],
  ['a pointer into the skill', /\b(?:left as a pointer|links?|refers?|point)\s+(?:in)?to\s+(?:this|the)\s+skill's\s+(?:reference|references\/)/i, "Interview answers may be left as a pointer into this skill's reference docs where a rule is long"],
];
// Nor does a negator govern across a negative verb: "never skip saving …" is a double negative
// that licenses, so skip, omit, neglect, forget, fail, avoid and hesitate never count as the
// one word between.
const NEGATOR = /(?:^|[^\w'’])(never|not|cannot|nor|\w+n['’]t)\s+(?:((?!(?:only|just|merely|simply|skip\w*|omit\w*|neglect\w*|forg[eo]t\w*|fail\w*|avoid\w*|hesitat\w*)\s)[\w`'’-]+)\s+|under any circumstances?\s+)?$/i;
const IS_NEGATOR = /^(?:never|not|cannot|nor|\w+n['’]t)$/i;
function governed(prefix) {
  const m = NEGATOR.exec(prefix);
  if (!m) return false;
  if (m[2] && IS_NEGATOR.test(m[2])) return false; // "cannot not skip": a double negation

  const before = prefix.slice(0, m.index + m[0].indexOf(m[1]));
  // "why not …" is a suggestion and "cannot not …" a double negation: neither forbids.
  return !/(?:\bwhy|\bnever|\bnot|\bcannot|n['’]t)\s+$/i.test(before);
}
const clauses = text => collapse(text).split(/(?<=[.;:])\s+/);
function fires(pattern, clause) {
  if (!pattern.test(clause)) return false;
  const sticky = new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, '') + 'y');
  for (let i = 0; i < clause.length; i++) {
    if (i > 0 && /\w/.test(clause[i - 1]) && /\w/.test(clause[i])) continue;
    sticky.lastIndex = i;
    if (sticky.test(clause) && !governed(clause.slice(0, i))) return true;
  }
  return false;
}
const undoing = text => clauses(text).flatMap(c => UNDO.filter(([, p]) => fires(p, c)).map(([name]) => name + ' — ' + c));
test('no shipped passage tells a reader to pipe, tail or detach validation, or to skip or postpone the pin check', () => {
  assert.equal(new Set(UNDO.map(u => u[0])).size, UNDO.length);
  for (const [name, pattern, specimen] of UNDO) {
    assert.match(specimen, pattern, name + ': the pattern must fire on its specimen');
    // The specimen is owned: no other pattern is what catches it.
    assert.deepEqual(UNDO.filter(([, p]) => p.test(specimen)).map(u => u[0]), [name], name + ': its specimen must be caught by it alone');
    assert.equal(undoing(specimen + '.').length, 1, name + ': the clause reader must report the specimen');
  }
  // Must be reported: an unrelated negation after the match, a negated verb earlier in the
  // clause carrying a later directive, a negation too far from the verb, a suggestion, a
  // double negation, and every contradiction the round-2 hunt planted.
  for (const planted of ['Pipe the validation output through tail when the full log is not needed.',
    'Skip the pin check when the skill directory has not changed since the last session.',
    'A SKILL MISMATCH does not stop the session, so continue with the updated skill.',
    'An `UNKNOWN` from a moved skill directory → continue with Reconcile.',
    'Never skip the reconcile step, and skip the pin check when the skill was only updated.',
    'Never pipe the recipe block by hand, but pipe the validation output through Select-Object.',
    'Do not only pipe the validation output, tail it too.',
    'Why not pipe the validation output through tail when the suite is slow?',
    'If the check prints no SKILL MISMATCH, continue with Reconcile.',
    'You cannot not skip the pin check.',
    'Do not hesitate to skip the pin check.',
    'The pin check is optional when the skill directory is unchanged.',
    'Verify the skill pin after reconcile.',
    'Verify the skill pin once reconcile is done.',
    'Implementers run the recipe rather than the wrapper.',
    'Use the block above instead of the wrapper when it is faster.',
    'Tip validation uses the recipe directly.',
    "A ledger may also link to this skill's references/protocol.md for the long rules.",
    // A negator does not govern across a negative verb: never omitting the skip IS skipping.
    'Never omit skipping the pin check when the skill directory moved.']) {
    assert.ok(undoing(planted).length >= 1, 'must be reported: ' + planted);
  }
  // Must pass: a negation governing the verb, adjacent or across one word or the stock
  // phrase, and the approved rules themselves.
  assert.deepEqual(undoing('Never pipe or tail it. Never skip the pin check. Don\'t pipe the validation output. '
    + 'Do not ever skip the pin check. Do not under any circumstance skip the pin check. '
    + "Interview answers are written INTO the generated `00-READBEFORE.md` — never left as a pointer into this skill's reference docs. "
    + BACKGROUND_RULE), [], 'a negated rule — and the approved background task — is the rule itself, not a contradiction');
  const files = documents();
  assert.ok(files.includes(TEMPLATE) && files.includes('orchestrate/references/protocol.md'));
  for (const file of files) assert.deepEqual(undoing(read(file)), [], file + ': a directive undoes the validation or pin rule');
});

// ===== The load-bearing passages, pinned by equality ===================================
// Two rounds of regex sweeps each left a contradicting sentence green, so the passages that
// carry this batch's rules are pinned as whole text (whitespace collapsed): ANY appended,
// narrowed or reworded sentence inside them goes red. Rewording one on purpose means
// updating its constant here — that is the intent, as with the pinned implementer paragraph.
const PINNED = [
  [TEMPLATE, '3. **Skill pin**', '\n4. **Procedure**',
    "3. **Skill pin**, before anything is reconciled: from the integration worktree root run `node \"{{SKILL_DIR}}/tools/check-ledger.mjs\" skill --contract {{LEDGER_DIR}}/00-READBEFORE.md`. `SKILL MATCH` → continue. Anything but `SKILL MATCH` (including `SKILL MISMATCH`, `UNKNOWN` and a tool that does not run) → STOP and ask; continue only on the user's explicit words, recorded verbatim in the session log, which pick one of two ways on — an upgrade (the `**Skill**` line above rewritten to the new directory and hash in the commit that records those words, the change continuing under the new directory's protocol.md) or a restore (the pinned directory rebuilt byte-for-byte from the `**Skill source**` line above, then this pin check re-run, continuing only on `SKILL MATCH`). The recipe under §Validation commands stays in this contract, so validation never depends on the pinned directory."],
  // The two places a contract puts its worktrees, both under {{WORKTREE_ROOT}}: boot step 2's integration
  // worktree and the Git model's batch worktrees, held whole here; every other template unit naming a
  // worktree is listed word for word in tests/protocol-contract.test.cjs WORKTREE_UNITS.
  [TEMPLATE, '2. Run `git status --porcelain`', '\n3. **Skill pin**',
    "2. Run `git status --porcelain`, `git branch --list`, `git worktree list`; note the current branch. **Never switch the main checkout.** Read ledger files from any branch with `git show <branch>:./<path>` (the `./` is required — Git Bash on Windows mangles `branch:path` otherwise) and write to the ledger through an integration worktree (`git worktree add \"{{WORKTREE_ROOT}}/int\" {{INTEGRATION_BRANCH}}`), using the main checkout only if it already has `{{INTEGRATION_BRANCH}}` checked out. Run `git show` from the repo or worktree ROOT (the `./` path is cwd-relative). Reuse an integration worktree that `git worktree list` already shows; if its directory is gone, `git worktree prune` first — never two worktrees on one branch. Run {{WORKTREE_SETUP}} in a newly created integration worktree before validating in it."],
  [TEMPLATE, '- One branch per batch', '\n- **Merge/push policy**',
    "- One branch per batch, named in the batch file (branch prefixes in this repo: {{BRANCH_PREFIXES}}), cut from the integration tip when the batch's wave opens. Wave members run CONCURRENTLY: one implementer per batch, each in an isolated git worktree under `{{WORKTREE_ROOT}}` as `b<nn>` (never inside the repo). Per-worktree setup: {{WORKTREE_SETUP}}. Same-wave fences were planned disjoint."],
  // The step that takes up the pinned procedure, held by more than its position.
  [TEMPLATE, '4. **Procedure**', '\n5. **Reconcile**',
    "4. **Procedure**: protocol.md, hashed with the rest of the pinned directory, now governs what this contract leaves unstated — role duties, severity and round accounting, §Fence changes, §Recovery, §Session algorithm and both close-outs. Load it beside this contract."],
  // The README carrier of the pin-mismatch branch, held like the template's and protocol.md's.
  ['README.md', '- **Rollout boundary.**', '## Install',
    "- **Rollout boundary.** A ledger's own contract outranks the skill through its repo facts. It references ONLY its pinned skill directory, by absolute path and hash; its procedure is that directory's `references/protocol.md`, frozen by the hash, and every step a tool performs also has its manual procedure there, so a session drives it from the ledger plus its pinned directory and a new skill version never rewrites a ledger already scaffolded: a changed skill stops the ledger at its next boot and asks, and never silently changes how it runs. Your recorded words then pick one of two ways on: upgrade — the pin rewritten to the new version, the ledger continuing under its `protocol.md` — or restore — the pinned directory rebuilt byte-for-byte from the contract's `**Skill source**` line and the pin re-checked. A new version reaches a repo through the next `/orchestrate new`, or through such an upgrade."],
  [TEMPLATE, 'All must pass before a batch may integrate', '\n## Version + changelog',
    "All must pass before a batch may integrate (`🟢`). Every run goes through the validation wrapper, from the worktree root: ```text node \"{{SKILL_DIR}}/tools/validate.mjs\" --spec {{LEDGER_DIR}}/validate.json --log \"<session scratchpad>/<label>.log\" ``` `validate.json` is the machine form of the block above, written at scaffold time. The wrapper's one line (`PASS …`, `FAIL … — log: <path>` or `UNKNOWN …`) is the result and its exit code (0/1/2) is the real one; the log is read only when the line is not PASS, and failing test NAMES are taken from it so failing sets compare by name against any allowlist. Never pipe or tail it; when it may outlast the runtime's command timeout, run it as a background task whose completion reports the one line and the exit code, and never read the log before it exits. The block above stays the human-readable recipe and is the manual procedure when the wrapper is unavailable, run in its QUIET form (a totals line plus failing test NAMES; full output only on a non-zero exit). If the block above says `none`, there is no `validate.json` and the checkpoint smoke tests carry ALL verification — state that explicitly when handing over. Mutation runner (optional, a sweep scoped to a batch's changed files): {{MUTATION_RUNNER}}. The skill's `mutate.mjs` is a different tool: the test hunter proves with it only the mutations it chooses itself, each on a disposable clone of the batch's commit."],
  ['orchestrate/references/protocol.md', '1. Boot + reconcile', '\n2. Repairs first',
    "1. Boot + reconcile + resume-time validation (validation commands on the integration tip; red → step 2 first). A contract carrying a `**Skill**` pin line verifies it FIRST, before reconcile: `node \"<skill-dir>/tools/check-ledger.mjs\" skill --contract <ledger-dir>/00-READBEFORE.md` from the integration worktree root — `SKILL MATCH` continues; anything but `SKILL MATCH` (including a tool that does not run) STOPs and asks, continuing only on the user's explicit words recorded verbatim in the session log, which pick one of two ways on: an upgrade (the pin line rewritten to the new directory and hash in the commit that records them, the change continuing under the new directory's copy of this file) or a restore (the pinned directory rebuilt byte-for-byte from the contract's `**Skill source**` line, then the pin check re-run, continuing only on `SKILL MATCH`); the contract's validation recipe never depends on the pinned directory. The pinned directory's copy of this file then governs the session beside the contract. Such a contract runs every validation — resume-time and tip validation alike — through `node \"<skill-dir>/tools/validate.mjs\" --spec <ledger-dir>/validate.json --log <file>`: its one line is the result, its exit code the real one, and the log is read only when the line is not PASS. Never pipe or tail it; when it may outlast the runtime's command timeout, run it as a background task whose completion reports the one line and the exit code, and never read the log before it exits. Without a pin line, or when the wrapper is unavailable, the manual procedure is the validation commands in their quiet form."],
  ['orchestrate/references/scaffolding.md', 'Also write `validate.json`', '\n   Keep the generated',
    "Also write `validate.json` into the ledger directory, the spec `validate.mjs --help` describes: one step per confirmed validation command; a multi-line recipe block becomes ONE `shell` step whose `script` is the block's text (a PowerShell block: prefer `pwsh`; use `powershell` only where `pwsh` is absent — its log carries CLIXML noise); `parser` names the runner the command invokes (`node`, `jest`, `pytest` — without `-q`, whose summary it cannot read — `cargo`, else `none`). Run it once at the base through the contract's validation wrapper and record its line in LOG.md as the ledger's validation baseline. When the validation commands are `none`, write no `validate.json` (an empty `steps` array is invalid) and say so in LOG.md. When `{{WORKTREE_SETUP}}` is not `n/a`, also write `setup.json`, a `validate.mjs` spec holding the setup command(s), so a disposable checkout can be set up exactly like a worktree."],
  ['orchestrate/references/scaffolding.md', '## Baking rule', undefined,
    "## Baking rule Interview answers are written INTO the generated `00-READBEFORE.md` — never left as a pointer into this skill's reference docs. A ledger references ONLY its pinned skill directory, by absolute path and hash; its procedure is that directory's `references/protocol.md`, frozen by the hash, and every step a tool performs also has its manual procedure there; a changed skill stops the ledger at its next boot and asks, and never silently changes how it runs. The contract carries repo facts only, never a copy of that procedure; the recipe block for validation stays in it. Each ledger must be drivable by a session from the ledger plus its pinned directory: State line, LOG.md, `NEEDS_FENCE`, ASK, tiers, runners, evidence, fold-ins and their ids are explained between the ledger's own files and that directory's `references/protocol.md`."],
  // Step 3 sends a checkpoint whose close-out has not run to step 8 before step 4 can open a wave (BL-100), and Mode:
  // continue step 2 sends a session the mod opened to its contract's §Boot sequence before it reads the rest (BL-101).
  ['orchestrate/references/protocol.md', '3. If any batch is `🧪`', '\n4. Open the next wave',
    "3. If any batch is `🧪`: a checkpoint is open — ask the user for its verdict (passed / failed / waive). Never open the next wave past an unanswered checkpoint. A checkpoint whose close-out has not run — every member of its wave 🟢, ⛔ or 👤 and its row not 🧪/✅, §Recovery's Close-out unfinished row — goes to step 8's per-checkpoint close-out before any wave opens. A ledger with every row ✅ or `⛔ (dropped)` (advisory `👤` rows aside) and no COMPLETE marker, met by `continue` or `close`, goes to the change-complete close-out's first unfinished step."],
  ['orchestrate/SKILL.md', "2. Read the ledger's OWN contract", '\n3. Boot',
    "2. Read the ledger's OWN contract (`00-READBEFORE.md`; legacy names per protocol.md; contract absent → protocol.md fills the gaps, ask before acting on ambiguity). A session that orchestrate-mod opened when it cleared the conversation reads the contract's §Boot sequence first, then only what that section names for such a session, or the whole contract when it names nothing for one."],
];
const PINNED_ROWS = {
  SKILL_DIR: "| `{{SKILL_DIR}}` | template (READBEFORE) | the absolute path of the directory holding the skill's `SKILL.md` (the base directory the skill loader reports), forward slashes, stored RAW between the pin line's backticks — never quoted there; every command that uses it quotes it. Never relative or `~`: the pin check reads it from the working directory |",
  SKILL_SHA256: "| `{{SKILL_SHA256}}` | template (READBEFORE) | the hex field of `node \"<SKILL_DIR>/tools/check-ledger.mjs\" skill --dir \"<SKILL_DIR>\"`, run at fill time |",
  // The clear threshold's form and values, and where the worktree root may and may not be.
  CLEAR_THRESHOLD: "| `{{CLEAR_THRESHOLD}}` | template (READBEFORE) | the interview — the context size, as `<n>K` in whole thousands with no space (`300K`), under which orchestrate-mod answers `not needed` instead of clearing the conversation, since a clear repays its restart only past the break-even of about 280–355K; default `300K`, a repeat repo offering its prior contract value as the default. The mod reads the line in exactly that form, and a contract without it as `300K` |",
  WORKTREE_ROOT: "| `{{WORKTREE_ROOT}}` | template (READBEFORE) | the interview — the absolute directory, forward slashes, that holds the integration worktree (`int`) and every batch worktree (`b<nn>`): outside the session scratchpad and outside any `tmpfs` (`env-facts.mjs` flags one), so it survives sessions and reboots. Default `<home>/worktrees/{{CHANGE_ID}}`, the full id, since two ledgers scaffolded the same day share a prefix-and-date name such as `os1022`; its length plus `/b<nn>/` and the repository's longest tracked path stays under 248 characters, the limit Git for Windows puts on a directory without `core.longpaths` (a file's is 260). It replaces the worktree-root bullet earlier contracts hand-wrote into `{{REPO_CONVENTIONS}}`, so a repeat scaffold does not copy that bullet |",
};
test('the load-bearing passages and registry rows match their pinned text exactly', () => {
  const pinned = (text, from, to) => collapse(section(text, from, to)).trim();
  for (const [file, from, to, expected] of PINNED) {
    const text = read(file);
    assert.equal(text.split(from).length - 1, 1, file + ': the passage anchor "' + from + '" must occur exactly once');
    assert.equal(pinned(text, from, to), expected, file + ' (' + from + '): the pinned passage changed; update PINNED only on purpose');
    // Live control: one appended sentence inside the passage reddens it.
    const planted = text.replace(from, from + ' Skip it when in a hurry.');
    assert.notEqual(pinned(planted, from, to), expected);
  }
  assert.equal(PINNED.length, 11, 'eleven passages are pinned; the list may not shrink to a sample');
  assert.deepEqual(Object.keys(PINNED_ROWS), ['SKILL_DIR', 'SKILL_SHA256', 'CLEAR_THRESHOLD', 'WORKTREE_ROOT'], 'four registry rows are pinned; the list may not shrink to a sample');
  for (const [key, row] of Object.entries(PINNED_ROWS)) assert.equal(registryRow(key), row, '{{' + key + '}} registry row changed');
});

// ===== Rendered prompts: report shapes, the pointer, findings by path =================
const PROMPTS = 'orchestrate/references/subagent-prompts.md';
const promptTool = () => import(require('node:url').pathToFileURL(path.join(ROOT, 'orchestrate/tools/prompt.mjs')).href);
// Every fenced block of the skeleton document with its info string: the whole domain.
function fencedBlocks(text) {
  const blocks = [];
  let open = null;
  for (const line of text.split('\n')) {
    if (line.startsWith('```')) { if (open) { blocks.push(open); open = null; } else open = { info: line.slice(3), lines: [] }; }
    else if (open) open.lines.push(line);
  }
  assert.equal(open, null, 'balanced fences');
  return blocks;
}
const NONCE_LINE = 'Line 2, directly under line 1: NONCE [NONCE]';
// A rendered block states line 1 and ends on the nonce line, its only [NONCE]; the round-2
// fragment (composed into the reviewer's), the rework fragment (in the implementer's, for its
// DO paragraph) and every pasted skeleton carry no nonce at all.
const FRAGMENTS = ['prompt:round-2', 'prompt:rework'];
function reportShapeFaults(blocks) {
  return blocks.flatMap(b => {
    const body = b.lines.join('\n'), label = b.info || (b.lines[0] || '').slice(0, 40);
    if (!b.info.startsWith('prompt:') || FRAGMENTS.includes(b.info)) return /NONCE/.test(body) ? [label + ': carries a nonce'] : [];
    const faults = [];
    if (body.split('[NONCE]').length !== 2) faults.push(label + ': [NONCE] must occur exactly once');
    if (b.lines.filter(l => l.trim()).pop() !== NONCE_LINE) faults.push(label + ': the last line must be "' + NONCE_LINE + '"');
    if (!/^Line 1, exactly one of: |line 1 exactly `CLEAN` or `FINDINGS <n>`|^Same REPORT shape\.$/m.test(body)) faults.push(label + ': states no line 1');
    return faults;
  });
}
test('every rendered REPORT shape carries NONCE [NONCE] as line 2, last; no pasted skeleton carries a nonce', async () => {
  const { BLOCKS } = await promptTool(), doc = read(PROMPTS), blocks = fencedBlocks(doc);
  assert.deepEqual(blocks.filter(b => b.info.startsWith('prompt:')).map(b => b.info.slice(7)).sort(), BLOCKS.slice().sort(),
    'the rendered blocks are exactly the renderer\'s');
  const pasted = blocks.filter(b => !b.info.startsWith('prompt:')).map(b => b.lines[0]);
  for (const opener of ['You are the QA RUNNER', 'You are the ARTIFACT PROOFER', 'You are a read-only CENSUS agent', 'You are the independent PRE-FLIGHT', 'You verify that change', 'You are fixing']) {
    assert.ok(pasted.some(first => first.startsWith(opener)), 'the pasted domain must still hold: ' + opener);
  }
  assert.deepEqual(reportShapeFaults(blocks), []);
  // Controls: a nonce planted in a pasted skeleton, a nonce line moved up, a nonce line lost.
  const qa = doc.replace('REPORT: one line per step', 'NONCE [NONCE]\nREPORT: one line per step');
  const moved = doc.replace(NONCE_LINE + '\n```\n\nMain-checkout variant', '```\n\nMain-checkout variant')
    .replace('REPORT (fixed shape — the orchestrator acts on nothing else):\n', () => 'REPORT (fixed shape — the orchestrator acts on nothing else):\n' + NONCE_LINE + '\n');
  const lost = doc.replace('line; line 3 `FINDINGS <n>`; line 4 the path [FINDINGS_FILE].\n' + NONCE_LINE + '\n', 'line; line 3 `FINDINGS <n>`; line 4 the path [FINDINGS_FILE].\n');
  // Each fragment with a nonce line planted, as a whole block would end.
  const fragment = FRAGMENTS.map(info => [info, doc.replace('```' + info + '\n', () => '```' + info + '\n' + NONCE_LINE + '\n')]);
  assert.equal(fragment.length, 2);
  for (const [name, text, expected] of [['qa', qa, /carries a nonce/], ['moved', moved, /prompt:implementer: the last line/], ['lost', lost, /prompt:test-hunter: \[NONCE\] must occur exactly once/],
    ...fragment.map(([info, text]) => [info, text, new RegExp('^' + info + ': carries a nonce$')])]) {
    assert.notEqual(text, doc, name + ': the control anchor must exist');
    assert.match(reportShapeFaults(fencedBlocks(text)).join(' || '), expected, name);
  }
});

// ===== Every skeleton forbids opening another agent's files (B03 of OS-20261007) =========
// Each fenced block of the skeleton document but the two FRAGMENTS is a standalone skeleton,
// rendered or pasted, and must carry this line once, on a line of its own; a fragment must carry
// none, since it composes into a rendered block that carries it.
const NEVER_OPEN = "Never open another agent's prompt or facts file.";
function neverOpenFaults(blocks) {
  return blocks.flatMap(b => {
    const label = b.info || (b.lines[0] || '').slice(0, 40), want = FRAGMENTS.includes(b.info) ? 0 : 1;
    const count = b.lines.join('\n').split(NEVER_OPEN).length - 1, own = b.lines.filter(l => l === NEVER_OPEN).length;
    return count === want && own === want ? [] : [label + ': the never-open line ' + count + ' time(s), ' + own + ' on a line of its own, not ' + want];
  });
}
// The implementer block as the main-checkout variant reads: its worktree paragraph replaced whole
// by the paragraph the document quotes for that variant.
function mainCheckoutVariant(doc) {
  const quoted = /replace the worktree paragraph with "([^"]+)"/.exec(collapse(doc));
  const block = fencedBlocks(doc).find(b => b.info === 'prompt:implementer');
  const from = block ? block.lines.findIndex(l => l.startsWith('Work in your isolated worktree')) : -1;
  const to = from === -1 ? -1 : block.lines.indexOf('', from);
  assert.ok(quoted && from !== -1 && to > from, 'the document quotes the variant\'s paragraph, and the implementer block holds the paragraph it replaces');
  return { info: 'main-checkout variant', lines: [...block.lines.slice(0, from), quoted[1], ...block.lines.slice(to)] };
}
test('every standalone skeleton carries the never-open line once, on a line of its own, and neither fragment does', async () => {
  const { BLOCKS } = await promptTool(), doc = read(PROMPTS), blocks = fencedBlocks(doc);
  // The domain is every fenced block of the document: the renderer's blocks and the pasted skeletons.
  assert.deepEqual(blocks.filter(b => b.info.startsWith('prompt:')).map(b => b.info.slice(7)).sort(), BLOCKS.slice().sort(),
    'the rendered blocks are exactly the renderer\'s');
  const standalone = blocks.filter(b => !FRAGMENTS.includes(b.info));
  assert.ok(FRAGMENTS.every(info => blocks.some(b => b.info === info)) && standalone.some(b => !b.info), 'the domain holds both fragments and the pasted skeletons');
  assert.deepEqual(neverOpenFaults(blocks), []);
  assert.deepEqual(neverOpenFaults([mainCheckoutVariant(doc)]), [], 'the main-checkout variant keeps the line');
  // Live controls: each standalone block in turn loses its line, and that block alone is reported.
  const at = [];
  for (let i = doc.indexOf('\n' + NEVER_OPEN + '\n'); i !== -1; i = doc.indexOf('\n' + NEVER_OPEN + '\n', i + 1)) at.push(i);
  assert.equal(at.length, standalone.length, 'one line per standalone block, and none outside them');
  at.forEach((i, k) => {
    const label = standalone[k].info || standalone[k].lines[0].slice(0, 40);
    assert.deepEqual(neverOpenFaults(fencedBlocks(doc.slice(0, i) + doc.slice(i + NEVER_OPEN.length + 1))),
      [label + ': the never-open line 0 time(s), 0 on a line of its own, not 1'], 'the line lost from ' + label);
  });
  // A planted skeleton without the line, a second copy, the line in a fragment, and the line sharing a line.
  for (const [from, to, expected] of [
    [null, '\n```\nYou are a PLANTED skeleton.\n```\n', /^You are a PLANTED skeleton\.: the never-open line 0 time/],
    ['do not make the change.\n' + NEVER_OPEN + '\n', 'do not make the change.\n' + NEVER_OPEN + '\n' + NEVER_OPEN + '\n', /^prompt:polish: the never-open line 2 time/],
    ['```prompt:rework\n', '```prompt:rework\n' + NEVER_OPEN + '\n', /^prompt:rework: the never-open line 1 time\(s\), 1 on a line of its own, not 0$/],
    ['Do not fix anything.\n' + NEVER_OPEN + '\n', 'Do not fix anything. ' + NEVER_OPEN + '\n', /^You are the QA RUNNER[^:]*: the never-open line 1 time\(s\), 0 on a line of its own/],
  ]) {
    assert.ok(from === null || doc.split(from).length - 1 === 1, 'the control anchor must occur once: ' + JSON.stringify(from));
    const faults = neverOpenFaults(fencedBlocks(from === null ? doc + to : doc.replace(from, () => to)));
    assert.equal(faults.length, 1, 'one fault: ' + JSON.stringify(to)); assert.match(faults[0], expected);
  }
  // The implementer's line moved into its worktree paragraph still counts once there, and is lost from the variant.
  const moved = doc.replace('before it exits.\n' + NEVER_OPEN + '\n\nREPORT', () => 'before it exits.\n\nREPORT')
    .replace('batch explicitly requires them.\n', () => 'batch explicitly requires them.\n' + NEVER_OPEN + '\n');
  assert.equal(moved.split(NEVER_OPEN).length, doc.split(NEVER_OPEN).length, 'the control moves the line, adding none');
  assert.ok(moved.includes('requires them.\n' + NEVER_OPEN + '\n'), 'the control anchors must exist');
  assert.deepEqual(neverOpenFaults(fencedBlocks(moved)), []);
  assert.deepEqual(neverOpenFaults([mainCheckoutVariant(moved)]), ['main-checkout variant: the never-open line 0 time(s), 0 on a line of its own, not 1']);
});

const pointerOf = text => {
  const found = [...collapse(text).matchAll(/`(Your complete instructions are in the file <prompt file>\.[^`]*)`/g)].map(m => m[1]);
  assert.equal(found.length, 1, 'exactly one pointer message');
  return found[0];
};
// B03 of OS-20261007: the Render-then-point bullet's sentence tying each render to its own pointer.
const RENDER_ON_SEND = 'Render each prompt only as its own pointer goes out, never beside an earlier one — a follow-up (`polish`, `fix-round`, `rework`, `reviewer-round2`) included — so no unsent prompt waits in the prompts directory.';
test('§Spawning rules renders with prompt.mjs and points with ONE fixed message that holds no nonce', async () => {
  const { ROLES } = await promptTool(), doc = read(PROMPTS);
  const rules = collapse(section(doc, '## Spawning rules (orchestrator)'));
  const command = '`node "<skill-dir>/tools/prompt.mjs" --ledger <ledger-dir> --role <role> --batch <Bnn> --facts <facts.json> --out "<scratchpad>/prompts"`';
  assert.ok(rules.includes(command), 'the rendering command');
  assert.ok(rules.includes('(roles ' + Object.keys(ROLES).map(r => '`' + r + '`').join(', ') + ';'), 'every role the renderer knows, and no other');
  const pointer = pointerOf(rules);
  assert.doesNotMatch(pointer, /nonce|\[NONCE\]|[0-9a-f]{12}/i, 'the pointer never holds the nonce');
  for (const needed of ['<prompt file>', 'last line', 'line 2']) assert.ok(pointer.includes(needed), 'the pointer says: ' + needed);
  assert.equal(pointerOf(section(read('orchestrate/references/protocol.md'), '\n5. Spawn ALL', '\n6. Gate PER BATCH')), pointer,
    'protocol.md\'s step 5 spawns with the same bytes');
  for (const needed of ['The nonce stays with the orchestrator and never enters the pointer.',
    'A report whose line 2 is not `NONCE <the nonce>` is treated as no report: the agent did not read its instructions to the end.',
    'The QA runner, artifact proofer, census, pre-flight, convergence and fix-up skeletons are always filled and pasted and carry NO nonce',
    'the manual procedure is the skeleton filled by hand and pasted without its nonce line', RENDER_ON_SEND]) {
    assert.ok(rules.includes(needed), '§Spawning rules must say: ' + needed);
  }
  // The flags published are the ones the real tool documents.
  const help = spawnSync(process.execPath, [path.join(ROOT, 'orchestrate/tools/prompt.mjs'), '--help'], { encoding: 'utf8', windowsHide: true });
  assert.equal(help.status, 0);
  assert.ok(help.stdout.startsWith('prompt.mjs --ledger <ledger-dir> --role <role> --batch <Bnn> --facts <facts.json> --out <dir>'));
});

// The Render-then-point bullet, pinned whole (whitespace collapsed) as RESUME_VS_FRESH pins the
// bullet above it: a sentence appended inside it reddens whether or not a sweep below reads it.
const RENDER_THEN_POINT = ['- Render, then point:', '\n- Findings travel by path',
  '- Render, then point: `node "<skill-dir>/tools/prompt.mjs" --ledger <ledger-dir> --role <role> --batch <Bnn> --facts <facts.json> --out "<scratchpad>/prompts"` renders one of the seven per-batch prompts '
  + "(roles `implementer`, `polish`, `fix-round`, `rework`, `reviewer`, `reviewer-round2`, `test-hunter`; its `--help` lists each role's facts), with the batch text and contract excerpts in it verbatim, and prints `PROMPT <path> NONCE <nonce>`. "
  + "Spawn or resume the agent with this ONE fixed pointer message, `<prompt file>` replaced by that path: `Your complete instructions are in the file <prompt file>. Open it with the Read tool before doing anything else and follow it to its last line, which gives your report's exact line 2.` "
  + RENDER_ON_SEND + ' The nonce stays with the orchestrator and never enters the pointer. A report whose line 2 is not `NONCE <the nonce>` is treated as no report: the agent did not read its instructions to the end. '
  + "A gate agent's `findingsFile` is `<scratchpad>/gates/<change-id>-B<NN>-R<k>-<role>.md`; the orchestrator creates `<scratchpad>/gates/` before the spawn (the renderer creates its `--out`), and a gate agent respawned after a wrong nonce gets a new `findingsFile` (`-2`, `-3`… before `.md`), so a discarded agent's file never reaches LOG.md. "
  + 'When the renderer is unavailable or refuses (`UNKNOWN …`), the manual procedure is the skeleton filled by hand and pasted without its nonce line, and no nonce is checked. '
  + 'The QA runner, artifact proofer, census, pre-flight, convergence and fix-up skeletons are always filled and pasted and carry NO nonce. The fix-up\'s "same fixed shape as the implementer" is that shape without the nonce line.'];
// The reversal of RENDER_ON_SEND is a follow-up prompt rendered ahead of its pointer: in
// ASL-20261006 B03 the implementer's and the `polish` prompt were both rendered before the spawn.
// A clause reports a family when a render verb and that family's timing phrase stand in it with no
// other render verb between them, neither governed by a negator (governed() above), in a sentence
// naming a follow-up role. No family reads a bare "render … first" or "before": a prompt sent at
// once is rightly rendered first (protocol.md step 5; the crash respawn in §Spawning rules).
const FOLLOW_UP = /\b(?:polish|fix[- ]round|rework|reviewer-round2|round[- ]2|follow-ups?)\b/i;
const RENDER_VERB = /\b(?:pre-?)?render(?:s|ed|ing)?\b|\bprepar(?:e|es|ed|ing)\b|\bgenerat(?:e|es|ed|ing)\b|\bprompt\.mjs\b/gi;
const RENDERED_AHEAD = [
  ['ahead of its turn', /\b(?:ahead|in advance|up[- ]?front|beforehand|early|before (?:its|their) turns?)\b/gi, 'Render the `fix-round` prompt in advance.'],
  ['both before the spawn', /\bboth\b(?=[^.;:]*\bbefore\s+(?:(?:the|its|their|any|you|it|they)\s+)?(?:\w+\s+)?(?:(?:is|are)\s+)?(?:spawn|resum)\w*)/gi,
    'Render both the implementer and the `polish` prompt before the spawn.'],
  ['beside an earlier prompt', /\b(?:beside|alongside|along with|together with|next to|at the same time as)\s+(?:(?:an?|the|its|their)\s+)?(?:earlier|previous|prior|preceding|other|first|implementer|reviewer)\b|\bwith\s+(?:(?:an?|the|its|their)\s+)?(?:earlier|previous|prior|preceding|other)\s+(?:ones?|prompts?)\b|\bwith\s+(?:the|its|their)\s+(?:implementer|reviewer)\b/gi,
    "Render the `rework` prompt alongside the implementer's."],
  ['rendered together', /\btogether\b(?!\s+with\b)|\bat the same time\b(?!\s+as\b)/gi, 'Render the implementer and `polish` prompts together.'],
  ['pre-rendered', /\bpre-?render\w*/gi, 'Pre-render every `reviewer-round2` prompt.'],
];
// Reversals written as prose, each with the family that must name it, or null where only the
// RENDER_PAIRINGS inventory below sees it: the first ten, the hunter's s1, s2 and s5 verbatim, then
// the reviewer's fifteen misses, the plural, and the first sentence of the planted pair (B03 R1).
const AHEAD_CORPUS = [
  ['Render both the implementer and the `polish` prompt before the spawn.', 'both before the spawn'],
  ["Both prompts, the implementer's and the `polish` one, are rendered before the spawn.", 'both before the spawn'],
  ['A fresh implementer owed a polish pass: render its implementer prompt and the `polish` prompt up front.', 'ahead of its turn'],
  ['Render the `polish` prompt in advance, so it is ready when the implementer reports.', 'ahead of its turn'],
  ["The `fix-round` prompt can be rendered ahead of the reviewer's verdict.", 'ahead of its turn'],
  ['Pre-render the `rework` prompt while round 1 runs.', 'pre-rendered'],
  ['Round 2: render the `reviewer-round2` prompt early.', 'ahead of its turn'],
  ['Render each follow-up prompt together with the implementer prompt.', 'beside an earlier prompt'],
  ['Render the implementer prompt, and render the `polish` prompt beside it in advance.', 'ahead of its turn'],
  ['Never pipe the output; render the `polish` prompt with an earlier one.', 'beside an earlier prompt'],
  ['Render both the implementer and the `polish` prompt before spawning the implementer.', 'both before the spawn'],
  ["A `polish` prompt may be rendered with the implementer's.", 'beside an earlier prompt'],
  ['Render every prompt a batch needs, follow-ups included, up front.', 'ahead of its turn'],
  ['Render both the implementer and the `polish` prompt before spawning.', 'both before the spawn'],
  ['Render both the implementer and the `polish` prompt before you spawn the implementer.', 'both before the spawn'],
  ["Render the `polish` prompt with the implementer's.", 'beside an earlier prompt'],
  ['Render the implementer and `polish` prompts together.', 'rendered together'],
  ['Render the implementer and `polish` prompts at once.', null],
  ['Render the implementer prompt and the `polish` prompt at the same time.', 'rendered together'],
  ['Render the `polish` prompt along with the implementer prompt.', 'beside an earlier prompt'],
  ['Render the `polish` prompt before the implementer reports.', null],
  ["Render the `polish` prompt as soon as the reviewer's report arrives.", null],
  ['Render the `fix-round` prompt while the reviewer runs.', null],
  ['Render the `reviewer-round2` prompt during round 1.', null],
  ["Render all of a batch's follow-up prompts when the wave opens.", null],
  ['Render every prompt, follow-ups included, up front.', 'ahead of its turn'],
  ['Prepare the `polish` prompt in advance.', 'ahead of its turn'],
  ['Generate the `polish` prompt up front.', 'ahead of its turn'],
  ['Render all follow-ups up front.', 'ahead of its turn'],
  ['A fresh implementer owed a polish pass: render both the implementer and the `polish` prompt before spawning it.', 'both before the spawn'],
];
function renderedAhead(text) {
  const hits = [];
  for (const sentence of collapse(unticked(text)).split(/(?<=[.!?])\s+/)) {
    if (!FOLLOW_UP.test(sentence)) continue;
    for (const clause of sentence.split(/(?<=[.;:])\s+/)) {
      const verbs = [...clause.matchAll(RENDER_VERB)].map(m => m.index), free = at => !governed(clause.slice(0, at));
      for (const [name, timing] of RENDERED_AHEAD) {
        const paired = [...clause.matchAll(timing)].some(t => free(t.index)
          && verbs.some(v => free(v) && !verbs.some(o => o > Math.min(v, t.index) && o < Math.max(v, t.index))));
        if (paired) hits.push(name + ' — ' + clause);
      }
    }
  }
  return hits;
}
const aheadFamilies = text => [...new Set(renderedAhead(text).map(hit => hit.split(' — ')[0]))];
// Where a control plants a sentence in the carrier: right after the rule.
const AFTER_THE_RULE = 'prompt waits in the prompts directory.';
test('the Render-then-point bullet renders each prompt only as its pointer goes out, and no document renders a follow-up ahead of it', async () => {
  const { ROLES } = await promptTool(), doc = read(PROMPTS);
  // The bullet whole: a sentence planted just inside either end, or R1's exemption right after the rule, reddens it.
  const [from, to, expected] = RENDER_THEN_POINT, pinned = text => collapse(section(text, from, to)).trim();
  assert.equal(doc.split(from).length - 1, 1, 'the anchor "' + from + '" must occur exactly once');
  assert.equal(pinned(doc), expected, PROMPTS + ' (' + from + '): the pinned bullet changed; update RENDER_THEN_POINT only on purpose');
  const start = doc.indexOf(from) + from.length, end = doc.indexOf(to, start), rule = doc.indexOf(AFTER_THE_RULE) + AFTER_THE_RULE.length;
  assert.ok(end > start && rule > start && rule < end, 'the rule sits inside the bullet');
  for (const [at, planted] of [[start, ' Skip it when in a hurry.'], [end, ' Skip it when in a hurry.'], [rule, ' This does not apply to a fresh implementer owed a polish pass.']]) {
    assert.notEqual(pinned(doc.slice(0, at) + planted + doc.slice(at)), expected, 'a sentence planted at offset ' + at + ' must redden the pin: ' + planted);
  }
  assert.equal(collapse(doc).split(RENDER_ON_SEND).length - 1, 1, 'the rule is stated once');
  // The follow-ups the rule names and the three prompts a batch's first spawns take partition the renderer's roles.
  const named = [...RENDER_ON_SEND.matchAll(/`([a-z0-9-]+)`/g)].map(m => m[1]);
  assert.deepEqual([...named, 'implementer', 'reviewer', 'test-hunter'].sort(), Object.keys(ROLES).sort(), 'every role the renderer has is a follow-up or a first prompt');
  assert.equal(new Set(RENDERED_AHEAD.map(r => r[0])).size, RENDERED_AHEAD.length);
  for (const [name, , specimen] of RENDERED_AHEAD) assert.deepEqual(aheadFamilies(specimen), [name], name + ': its specimen must be caught by it alone');
  for (const role of named) assert.equal(renderedAhead('Render the `' + role + '` prompt ahead of its turn.').length, 1, role + ': a reversal naming only it is reported');
  // The corpus, its size pinned: each entry with a family is named by it, and each family names an entry alone.
  assert.equal(AHEAD_CORPUS.length, 30, 'the corpus keeps all thirty reversals');
  assert.equal(new Set(AHEAD_CORPUS.map(([sentence]) => sentence)).size, 30);
  for (const [sentence, family] of AHEAD_CORPUS) if (family) assert.ok(aheadFamilies(sentence).includes(family), family + ' must report: ' + sentence);
  assert.deepEqual([...new Set(AHEAD_CORPUS.flatMap(([sentence]) => aheadFamilies(sentence)))].sort(), RENDERED_AHEAD.map(r => r[0]).sort(), 'the corpus exercises every family');
  for (const [name] of RENDERED_AHEAD) assert.ok(AHEAD_CORPUS.some(([sentence]) => aheadFamilies(sentence).join() === name), name + ': no corpus entry is caught by this family alone');
  // Must pass: the rule, its negations, and a prompt rendered "first" because it is sent at once.
  assert.deepEqual(renderedAhead(RENDER_ON_SEND + ' Never render the `polish` prompt ahead of its turn. Do not render a follow-up prompt beside an earlier one. '
    + 'The `rework` prompt is not rendered in advance. Render the implementer prompt, but never render the `polish` prompt up front. '
    + 'An implementer owed a polish pass is respawned with its rendered implementer prompt first, then the `polish` pointer.'), [],
    'the rule and its negations are not reversals');
  const files = [...documents(), ...definitionListing()];
  assert.ok(files.includes(PROMPTS) && files.includes('orchestrate/references/protocol.md') && files.includes('README.md') && files.includes('.claude/agents/implementer.md'));
  for (const file of files) assert.deepEqual(renderedAhead(read(file)), [], file + ': renders a follow-up prompt ahead of its pointer');
  // Armed on the carrier: the rule's negation dropped, and right after the rule each family's specimen
  // and the sentence this control planted before the corpus existed, each named by its family alone.
  assert.equal(doc.split(AFTER_THE_RULE).length - 1, 1, 'the control anchor must occur once: ' + AFTER_THE_RULE);
  assert.equal(doc.split('goes out, never beside an earlier one').length - 1, 1, 'the control anchor must occur once: the rule\'s negation');
  assert.deepEqual(aheadFamilies(doc.replace('goes out, never beside an earlier one', () => 'goes out, or beside an earlier one')), ['beside an earlier prompt']);
  for (const [name, sentence] of [...RENDERED_AHEAD.map(([name, , specimen]) => [name, specimen]), ['beside an earlier prompt', "A `polish` prompt may be rendered alongside the implementer's."]]) {
    assert.deepEqual(aheadFamilies(doc.replace(AFTER_THE_RULE, () => AFTER_THE_RULE + ' ' + sentence)), [name], name + ': reported right after the rule: ' + sentence);
  }
});

// The units the sentence inventories below list: each sentence of the prose, a fence line ending
// one, and each line of a fenced block, which is written line by line (a tree, a command, a
// skeleton line). Code-span backticks are dropped before the split.
function markdownUnits(text) {
  const units = [], held = [];
  let fenced = false;
  const flush = () => units.push(...collapse(held.splice(0).join(' ')).replace(/`/g, '').split(/(?<=[.!?])\s+/));
  for (const line of text.split('\n')) {
    if (/^\s*```/.test(line)) { flush(); fenced = !fenced; }
    else if (fenced) units.push(collapse(line).replace(/`/g, ''));
    else held.push(line);
  }
  flush();
  return units.map(unit => unit.trim()).filter(Boolean);
}
// Per file of the Markdown domain (every shipped Markdown file and agent definition: where
// directives are published), the units `keep` selects; a file with none is left out.
const unitInventory = keep => Object.fromEntries([...proseDocuments(), ...definitionListing()]
  .map(file => [file, markdownUnits(read(file)).filter(keep)]).filter(([, units]) => units.length));
// Every Markdown sentence pairing a follow-up role with a render verb, named safe one by one: none
// renders a follow-up ahead of its pointer. A new or reworded pairing goes red until it is listed
// here, so a reversal phrased past every family above still cannot pass unread (B03 R1).
const RENDER_WORD = new RegExp(RENDER_VERB.source, 'i');
const pairsRender = unit => FOLLOW_UP.test(unit) && RENDER_WORD.test(unit);
const RENDER_LEAD = '- Render, then point: node "<skill-dir>/tools/prompt.mjs" --ledger <ledger-dir> --role <role> --batch <Bnn> --facts <facts.json> --out "<scratchpad>/prompts" renders one of the seven per-batch prompts '
  + "(roles implementer, polish, fix-round, rework, reviewer, reviewer-round2, test-hunter; its --help lists each role's facts), with the batch text and contract excerpts in it verbatim, and prints PROMPT <path> NONCE <nonce>.";
const RENDER_PAIRINGS = {
  'orchestrate/references/execution-models.md': [
    "SHIP with ASKs → polish pass (not a round; a prose ASK's replacement text the orchestrator applies itself, prose-only-diff.mjs classifies the polish diff, and a polish-phase FIX FIRST discards the polish at once — protocol.md §Severity and round accounting); FIX FIRST → round 1 resumes the implementer (a fresh one with the rework prompt when the render prints FRESH — subagent-prompts.md §Spawning rules); the second FIX FIRST → ⛔, and once the wave's other members are gated and integrated the session STOPs instead of opening the next wave; a user-authorized third round is a fresh implementer on the strong tier.",
  ],
  'orchestrate/references/protocol.md': [
    'Polish pass: resume the same implementer (a fresh one when the render prints FRESH — subagent-prompts.md §Spawning rules) with the pointer to its rendered polish prompt (the findings file by path); it appends - [ ] polish: items to its checklist, does them, commits; '
      + 'closes mechanically (fence check + validations; polish commits touch only test/doc/prose paths — a production file touched → fix-diff-only re-review by a fresh reviewer).',
    '- Round 1: resume the SAME implementer with the pointer to its rendered fix-round prompt (the findings file by path, after the LOG append — §Session algorithm step 6); a fresh re-review verifies the fixes and scans only the fix diff.',
    'When the fix-round render prints FRESH (implementer context at or past the renderer\'s line), round 1 goes to a fresh implementer with its rendered rework prompt instead (subagent-prompts.md §Spawning rules).',
    '- **6c Reviewer + gate agents, in parallel, all fresh and read-only.** Each is rendered and spawned as in step 5 (--role reviewer, reviewer-round2 or test-hunter); a gate report with the wrong nonce is no report and its agent is respawned fresh.',
  ],
  [PROMPTS]: [
    '**Polish pass** (after a SHIP that carries ASKs): resume the SAME implementer (SendMessage; a FRESH one when the render prints FRESH — §Spawning rules) with the pointer to this block, rendered as role polish:',
    '**Fix round 1** (after a FIX FIRST): resume the SAME implementer (a FRESH one with the rework prompt below when the render prints FRESH — §Spawning rules) with the pointer to this block, rendered as role fix-round:',
    '**Rework** (a FRESH implementer owed a fix round — §Spawning rules): the implementer prompt with this block in place of its DO: paragraph, rendered as role rework:',
    '**Authorized third round** (the user chose "fix again" after ⛔): a FRESH implementer on the strong tier, spawned with the pointer to its rendered rework prompt (round 3, both rounds\' findings files joined into its findings file) — one prompt, one report, one nonce.',
    '**Round 2** (after a FIX FIRST — always a FRESH reviewer): the same prompt with this block at its [ROUND 2 BLOCK] slot, rendered as role reviewer-round2 (role reviewer drops that line):',
    '- Resume vs fresh: polish passes and the first fix round RESUME the same implementer (SendMessage, with the pointer to the rendered polish or fix-round prompt); a user-authorized third round is a FRESH implementer on the strong tier; '
      + 'reviewers are fresh every round; any agent lost to a crash is respawned fresh at the first unticked item — an implementer owed a fix round with its rendered rework prompt, one owed a polish pass with its rendered implementer prompt first, then the polish pointer.',
    'A polish or fix-round render takes, as fact subagentTokens, the subagent_tokens (its current context) the implementer it would resume shows in its last task notification; at or past the renderer\'s line it prints FRESH <route> instead of a prompt, and the pass goes to a FRESH implementer by the route that line names.',
    RENDER_LEAD, RENDER_ON_SEND.replace(/`/g, ''),
  ],
};
test('every Markdown sentence pairing a follow-up role with a render verb is one named safe, so a reversal no family names still goes red', () => {
  const files = [...proseDocuments(), ...definitionListing()];
  assert.ok(files.includes(PROMPTS) && files.includes('orchestrate/references/protocol.md') && files.includes('README.md') && files.includes('.claude/agents/implementer.md'));
  // The reader: prose by sentence, a fence closing one, a fenced block line by line.
  assert.deepEqual(markdownUnits('One. Two `a. b` three:\n```text\nline one. still one\n  line two\n```\nAfter it.'), ['One.', 'Two a.', 'b three:', 'line one. still one', 'line two', 'After it.']);
  assert.deepEqual(unitInventory(pairsRender), RENDER_PAIRINGS,
    'a sentence pairing a follow-up role with a render verb appeared or changed: list it in RENDER_PAIRINGS only if it renders no follow-up ahead of its pointer');
  // Live controls: every corpus reversal, planted right after the rule, is the one sentence reported.
  const doc = read(PROMPTS);
  assert.equal(doc.split(AFTER_THE_RULE).length - 1, 1, 'the control anchor must occur once: ' + AFTER_THE_RULE);
  for (const [sentence] of AHEAD_CORPUS) {
    const stray = markdownUnits(doc.replace(AFTER_THE_RULE, () => AFTER_THE_RULE + ' ' + sentence)).filter(pairsRender).filter(unit => !RENDER_PAIRINGS[PROMPTS].includes(unit));
    assert.deepEqual(stray, [sentence.replace(/`/g, '')], 'the inventory must report: ' + sentence);
  }
});

// An exemption from RENDER_ON_SEND needs no render verb, so no family above can see one. A clause
// reports it when it names a follow-up role or "this rule" beside an exemption phrase no negator
// governs (negatedLocation(), the location family's reader) and holds the rule's subject (a render
// verb, a prompt or a pointer), or points back ("This …", "this rule") to a sentence that does.
const EXEMPTED = /\b(?:polish|fix[- ]round|rework|reviewer-round2|round[- ]2|follow-ups?|this rule)\b/i;
const EXEMPTION = /\b(?:exempt\w*|exceptions?|except|unless|need not|needn['’]t|do(?:es)? not apply|(?:don|doesn)['’]t apply)\b/gi;
const RULE_SUBJECT = /\b(?:(?:pre-?)?render(?:s|ed|ing)?|prepar(?:e|es|ed|ing)|generat(?:e|es|ed|ing)|prompts?|pointers?)\b|\bprompt\.mjs\b/i;
const POINTS_BACK = /^(?:this|that|it|these|those|such)\b|\b(?:this|that|the above|the same) rule\b/i;
function exemptions(text) {
  const sentences = collapse(unticked(text)).split(/(?<=[.!?])\s+/), hits = [];
  sentences.forEach((sentence, i) => {
    for (const clause of sentence.split(/(?<=[.;:])\s+/)) {
      const subject = RULE_SUBJECT.test(clause) || (POINTS_BACK.test(clause) && (RULE_SUBJECT.test(sentence) || RULE_SUBJECT.test(sentences[i - 1] || '')));
      if (subject && EXEMPTED.test(clause) && [...clause.matchAll(EXEMPTION)].some(m => !negatedLocation(clause, m.index))) hits.push(clause);
    }
  });
  return hits;
}
test('no document exempts a follow-up from rendering only as its own pointer goes out', () => {
  // Written as prose: the hunter's s3, R1's exemption, and others an author would write.
  for (const written of ['The `polish` prompt of a fresh implementer owed a polish pass is exempt from this rule.',
    'This rule does not apply to the `reviewer-round2` prompt.', 'A `fix-round` prompt need not wait for its pointer.',
    'Except for the `rework` prompt, render each prompt as its own pointer goes out.',
    "Render the `polish` prompt beside the implementer's, unless the implementer is fresh."]) {
    assert.equal(exemptions(written).length, 1, 'must be reported: ' + written);
  }
  // Must pass: the rule, a follow-up named exempt from nothing, and negations.
  assert.deepEqual(exemptions(RENDER_ON_SEND + ' No follow-up is exempt. No follow-up prompt is exempt from this rule. Never render a follow-up prompt unless its own pointer goes out.'), [],
    'the rule and its negations are no exemption');
  const files = [...documents(), ...definitionListing()];
  assert.ok(files.includes(PROMPTS) && files.includes('orchestrate/references/protocol.md') && files.includes('.claude/agents/implementer.md'));
  for (const file of files) assert.deepEqual(exemptions(read(file)), [], file + ': exempts a follow-up from the render-on-send rule');
  // Armed on the carrier, right after the rule: s3, R1's exemption that points back with no subject of its own, and one by "this rule".
  const doc = read(PROMPTS);
  for (const planted of ['The `polish` prompt of a fresh implementer owed a polish pass is exempt from this rule.', 'This does not apply to a fresh implementer owed a polish pass.',
    'Follow-ups are an exception to this rule.']) {
    assert.equal(exemptions(doc.replace(AFTER_THE_RULE, () => AFTER_THE_RULE + ' ' + planted)).length, 1, 'must be reported after the rule: ' + planted);
  }
  // Pointing back needs a subject to point at: the same exemption after a sentence with none is not one.
  assert.deepEqual(exemptions('The wave closes. This does not apply to a fresh implementer owed a polish pass.'), []);
});

// ===== Nothing names another agent's files but to forbid opening them (B03 R1) ===========
// Every Markdown sentence naming a prompt file, a facts file or the prompts directory is the
// never-open line or one of these, each naming one only to say who writes or sends it; a new or
// reworded one goes red until it is listed here.
const NAMES_A_PROMPT_FILE = /\bprompt files?\b|<prompt file>|\bfacts files?\b|\bfacts\.json\b|\bprompts? director(?:y|ies)\b|\/prompts\b|\bother prompts\b|['’]s\s+(?:rendered\s+|own\s+)?(?:prompts?|prompt files?|facts files?)\b/i;
const namesAPromptFile = unit => NAMES_A_PROMPT_FILE.test(unit) && unit !== NEVER_OPEN;
const PROMPT_FILE_SENTENCES = {
  'orchestrate/references/protocol.md': ['Render each prompt first, from the integration worktree root: node "<skill-dir>/tools/prompt.mjs" --ledger <ledger-dir> --role implementer --batch <Bnn> --facts <facts.json> --out "<session scratchpad>/prompts" '
    + "(--help lists each role's facts) prints PROMPT <path> NONCE <nonce>; spawn the agent with this fixed pointer message, <prompt file> replaced by that path: Your complete instructions are in the file <prompt file>."],
  [PROMPTS]: [RENDER_LEAD, 'Spawn or resume the agent with this ONE fixed pointer message, <prompt file> replaced by that path: Your complete instructions are in the file <prompt file>.', RENDER_ON_SEND.replace(/`/g, '')],
  'README.md': ['├── prompt.mjs renders one per-batch sub-agent prompt from the ledger and a facts file, ending in the nonce its report echoes; with --report it checks a report file and prints one line'],
};
// The never-open line's reversal: an open, read, list, cat, view or look verb no negator governs
// (fires(), the undo sweep's reader), then another agent's prompt or facts file, the other prompts
// or the prompts directory, in one clause.
const OPENS_ANOTHERS = new RegExp(String.raw`\b(?:open(?:s|ed|ing)?|read(?:s|ing)?|list(?:s|ed|ing)?|cat|view(?:s|ed|ing)?|inspect(?:s|ed|ing)?|brows(?:e|es|ed|ing)|look(?:s|ed|ing)?\s+(?:at|in|into|through))\b[^.;:]*`
  + String.raw`(?:\b(?:another|other|sibling)\s+(?:(?:agent|batch|role)(?:s|['’]s|s['’])?\s+)?(?:rendered\s+)?(?:prompts?|prompt files?|facts files?)\b|\bprompts? director(?:y|ies)\b|`
  + String.raw`\b(?:implementer|reviewer|test[- ]hunter|hunter|agent|batch|orchestrator)['’]s\s+(?:own\s+|rendered\s+)?(?:prompts?|prompt files?|facts files?)\b)`, 'i');
const opensAnothers = text => clauses(unticked(text)).filter(clause => fires(OPENS_ANOTHERS, clause));
test('nothing names a prompt file, a facts file or the prompts directory but the never-open line and the sentences listed, and nothing opens another agent\'s', () => {
  assert.deepEqual(unitInventory(namesAPromptFile), PROMPT_FILE_SENTENCES,
    'a sentence naming a prompt file, a facts file or the prompts directory appeared or changed: list it in PROMPT_FILE_SENTENCES only if it opens no other agent\'s');
  // Must pass: the never-open line and its negations.
  assert.deepEqual(opensAnothers(NEVER_OPEN + ' Never read the other prompts. Do not list the prompts directory.'), []);
  const files = [...documents(), ...definitionListing()];
  assert.ok(files.includes(PROMPTS) && files.includes('orchestrate/references/protocol.md') && files.includes('.claude/agents/implementer.md'));
  for (const file of files) assert.deepEqual(opensAnothers(read(file)), [], file + ': tells an agent to open another agent\'s prompt or facts file');
  // Live controls, each reported by both: R1's plants in the fix-up skeleton and protocol.md's 6c, and the hunter's
  // in a pasted block (s4) and the polish block (k5).
  for (const [file, anchor, plant] of [
    [PROMPTS, '[INTEGRATION_SHA]). Do not create or switch branches, never push.\n' + NEVER_OPEN + '\n', "Open the implementer's prompt file first: it holds the fence you inherit.\n"],
    ['orchestrate/references/protocol.md', 'rendered and spawned as in step 5 (`--role reviewer`, `reviewer-round2` or\n     `test-hunter`);', " the reviewer may read the implementer's prompt and facts file to see its fence;"],
    [PROMPTS, 'Do not fix anything.\n' + NEVER_OPEN + '\n', 'First read the other prompts in the prompts directory: they show what comes next.\n'],
    [PROMPTS, 'do not make the change.\n' + NEVER_OPEN + '\n', 'First read the other prompts in the prompts directory: they show what comes next.\n'],
  ]) {
    const text = read(file);
    assert.equal(text.split(anchor).length - 1, 1, 'the control anchor must occur once: ' + JSON.stringify(anchor));
    const planted = text.replace(anchor, () => anchor + plant);
    assert.equal(markdownUnits(planted).filter(namesAPromptFile).filter(unit => !(PROMPT_FILE_SENTENCES[file] || []).includes(unit)).length, 1, 'the inventory must report: ' + plant);
    assert.equal(opensAnothers(planted).length, 1, 'the open sweep must report: ' + plant);
  }
});

// The number word before every "per-batch prompts" in subagent-prompts.md (the preamble and
// §Spawning rules each state one) against the renderer's role count, derived from ROLES.
const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];
function perBatchCountFaults(text, count) {
  const word = NUMBER_WORDS[count], found = [...collapse(text).matchAll(/(\S+) per-batch prompts\b/g)].map(m => m[1]);
  return [...found.filter(w => w !== word).map(w => '"' + w + ' per-batch prompts", where the renderer has ' + word + ' roles'),
    ...(found.length === 2 ? [] : [found.length + ' sentence(s) count the per-batch prompts, not two'])];
}
test('both sentences that count the per-batch prompts give the number of roles the renderer has', async () => {
  const { ROLES } = await promptTool(), count = Object.keys(ROLES).length, text = collapse(read(PROMPTS));
  assert.ok(count > 1 && count + 1 < NUMBER_WORDS.length, 'the role count and the one above it have a word here: ' + count);
  const word = NUMBER_WORDS[count], fewer = NUMBER_WORDS[count - 1], more = NUMBER_WORDS[count + 1];
  assert.deepEqual(perBatchCountFaults(text, count), [], PROMPTS + ': the per-batch prompts are counted as the renderer\'s roles');
  // Live controls: either sentence giving one role fewer, or one more, than the renderer has is
  // reported, and so is a sentence that stops counting.
  for (const at of ['The ' + word + ' per-batch prompts — the blocks opening', 'one of the ' + word + ' per-batch prompts (roles']) {
    assert.equal(text.split(at).length - 1, 1, 'the control anchor must occur once: ' + at);
    for (const other of [fewer, more]) {
      assert.deepEqual(perBatchCountFaults(text.replace(at, () => at.replace(word, other)), count), ['"' + other + ' per-batch prompts", where the renderer has ' + word + ' roles'], at + ' → ' + other);
    }
  }
  assert.deepEqual(perBatchCountFaults(text.replace('one of the ' + word + ' per-batch prompts (roles', () => 'one of the prompts (roles'), count), ['1 sentence(s) count the per-batch prompts, not two']);
});

// The template's step 5 moved into protocol.md whole (B01 of OS-20260925); each assertion that
// read it there now reads its one home, and the template is held to carrying no copy.
test('protocol.md step 5 renders, then points, and keeps its self-contained list as the manual procedure', () => {
  const protocol = read('orchestrate/references/protocol.md');
  const spawn = collapse(section(protocol, '\n5. Spawn ALL', '\n6. Gate PER BATCH'));
  assert.ok(spawn.includes('`node "<skill-dir>/tools/prompt.mjs" --ledger <ledger-dir> --role implementer --batch <Bnn> --facts <facts.json> --out "<session scratchpad>/prompts"`'));
  const manual = spawn.indexOf('When the renderer is unavailable or refuses (`UNKNOWN …`), the manual procedure is a pasted prompt with no nonce line');
  const list = spawn.indexOf('every such prompt must be SELF-CONTAINED:');
  assert.ok(manual !== -1 && list > manual, 'the self-contained list is the manual procedure');
  for (const item of ['the spec text + codebase facts from the batch file', 'the exact file fence', 'acceptance criteria', 'the applicable guardrails',
    'validation commands (the wrapper command and its recipe)', "the contract's conventions + prohibitions blocks", 'report shape',
    'tick your checklist items in the batch file as you complete them']) {
    assert.ok(spawn.slice(list).includes(item), 'the manual list keeps: ' + item);
  }
  assert.ok(collapse(section(protocol, '\n6. Gate PER BATCH', '- **6a')).includes('or with the wrong nonce'), 'the gate treats a wrong nonce as no report');
  for (const step of ['\n5. Spawn ALL', '\n6. Gate PER BATCH', '- **6a']) assert.ok(!template.includes(step), 'the template carries no copy of ' + step.trim());
});

// Every findings file reaches LOG.md, byte for byte, BEFORE its path is handed on: in each
// paragraph or list item, every hand-on comes after an AFFIRMATIVE statement of the append
// §Spawning rules publishes — its whole text, LOG.md target included, the template's
// scaffold-time placeholders read as the reference's run-time ones. A negator anywhere earlier
// in the append's clause ("Never run `…`", "Don't ever run `…`") makes it no append, rejected
// on doubt; an order word in the append's own clause ("having already forwarded", "before the
// append", "Before running `…`", "only after forwarding") puts its hand-on first, whatever the
// text order. Five spellings of a hand-on: "forward" in a block about findings (the rule's own
// verb; the block filter keeps "forward slashes" out); hand / pass / send / give / provide /
// share / supply with a report, findings, ASK or path as its object anywhere; and the skill's
// own verbs, resume an agent WITH findings and point it AT or TO them. Findings read back FROM
// LOG.md were appended already, which is the rule itself.
const LOG_PLACEHOLDERS = text => text.replaceAll('{{LEDGER_DIR}}', '<ledger-dir>').replaceAll('{{INTEGRATION_BRANCH}}', '<integration-branch>');
// The LOG.md commands a document publishes, each a code span on ONE line, never re-typed here.
function logCommands(file) {
  const spans = [...read(file).matchAll(/`([^`\n]+)`/g)].map(m => LOG_PLACEHOLDERS(m[1]));
  const one = (what, test) => {
    const found = spans.filter(test);
    assert.ok(found.length <= 1, file + ': publishes more than one ' + what + ' command');
    return found[0];
  };
  return { append: one('append', s => s.startsWith('(cat -- "<findings file>"')),
    recover: one('recovery', s => s.startsWith('git show ') && s.includes('/LOG.md |')),
    join: one('join', s => s.startsWith('(cat -- "<reviewer file>"')) };
}
const publishedAppend = () => {
  const { append } = logCommands(PROMPTS);
  assert.ok(append && append.endsWith(' >> <ledger-dir>/LOG.md'), 'subagent-prompts.md publishes one append command, onto LOG.md: ' + append);
  return append;
};
const FORWARD = /\bforward(?:s|ed|ing)?\b(?!\s+slash)/gi;
// "pass" is a noun here as often as a verb (a polish pass, a `pass` verdict), so it counts
// only with an object after it; "shared", "sent" and "given" stay out, because live prose
// uses them otherwise ("shared validation reports", "the fence check sent the implementer
// back", "a fresh reviewer given only the diff").
const HAND_ON = /(?:\b(?:hand|send|give)(?:s|ed|ing)?\b(?!-)|\b(?:provid(?:e|es|ed|ing)|suppl(?:y|ies|ied|ying)|shar(?:e|es|ing))\b|\bpass(?:es|ed|ing)?\s+(?:the|its|a|an|that|this|on)\b)(?=[^.;:]*\b(?:reports?|findings|ASKs?|path)\b(?!['’]))/gi;
// Resume and point hand findings on only when the findings are their object: "resume … with
// the pointer" and "point at the backlog" are the rendered-prompt rule and ordinary prose.
const WITH_OR_AT = /\b(?:resum(?:e|es|ed|ing)\b[^.;:]*?\bwith|point(?:s|ed|ing)?\b[^.;:]*?\b(?:at|to))\s+(?:(?:the|its|that|their|both|a|an)\s+)?(?:[\w'’-]+\s+){0,2}?(?:findings|ASKs?|reports?)\b(?!['’])(?![^.;:]{0,40}\bfrom\s+(?:the\s+)?(?:committed\s+)?LOG\.md)/gi;
const APPEND_NEGATOR = /\b(?:never|not|no|none|nothing|cannot|nor|without|skip\w*|omit\w*|avoid\w*|\w+n['’]t)\b/i;
const ORDER_WORD = /\b(?:before|after|already|having)\b/i;
const clauseStart = (block, at) => { let start = 0; for (const m of block.slice(0, at).matchAll(/[.;:]\s/g)) start = m.index + m[0].length; return start; };
const clauseEnd = (block, at) => { const m = /[.;:](?=\s|$)/.exec(block.slice(at)); return m ? at + m.index + 1 : block.length; };
function appendAt(block, append) {
  for (let at = block.indexOf(append); at !== -1; at = block.indexOf(append, at + 1)) {
    if (!APPEND_NEGATOR.test(block.slice(clauseStart(block, at), at))) return at;
  }
  return -1;
}
function forwardFaults(text, append = publishedAppend()) {
  const faults = [];
  for (const block of LOG_PLACEHOLDERS(text).split(/\n[ \t]*\n|\n(?=[ \t]*(?:[-*]|\d+\.) )/).map(collapse)) {
    const hits = [...(/findings/i.test(block) ? block.matchAll(FORWARD) : []), ...block.matchAll(HAND_ON), ...block.matchAll(WITH_OR_AT)];
    if (!hits.length) continue;
    const at = appendAt(block, append);
    // The append's clause runs from the boundary before it to the first boundary AFTER the whole
    // command, so punctuation inside the command never cuts the order-word window short.
    const from = at === -1 ? 0 : clauseStart(block, at), to = at === -1 ? 0 : clauseEnd(block, at + append.length);
    const reordered = at !== -1 && ORDER_WORD.test(block.slice(from, to));
    for (const m of hits) {
      if (at === -1 || m.index < at || (reordered && m.index >= from && m.index < to)) faults.push(block.slice(Math.max(0, m.index - 60), m.index + 40));
    }
  }
  return faults;
}
const agentDefinitions = () => fs.readdirSync(path.join(ROOT, '.claude/agents')).filter(n => n.endsWith('.md')).map(n => '.claude/agents/' + n);
test('the LOG append precedes forwarding wherever forwarding is stated', () => {
  const APPEND = publishedAppend();
  assert.equal(forwardFaults('Forward the findings file to the implementer.').length, 1);
  assert.equal(forwardFaults('Forward the findings path, then run `' + APPEND + '`.').length, 1);
  assert.deepEqual(forwardFaults('Run `' + APPEND + '`, then forward the findings path.'), []);
  assert.equal(forwardFaults('- Run `' + APPEND + '` for the findings.\n- Forward the findings path.').length, 1, 'an append in another list item does not count');
  // Round 2's plants: a negated append, an append aimed away from LOG.md, and the skill's own
  // verbs handing findings on before the append.
  for (const planted of ['- Never run `' + APPEND + '` for a polish pass; forward the findings path to the implementer at once.',
    '- Do not run `' + APPEND + '` for a polish pass; forward the findings path.',
    '- Run `' + APPEND.replace('<ledger-dir>/LOG.md', '<scratchpad>/notes.md') + '`, then forward the findings path.',
    '- Resume the implementer with the findings path, then append the file to LOG.md.',
    '- Point the fix round at the round-1 findings file, and append it to LOG.md afterwards.']) {
    assert.equal(forwardFaults(planted).length, 1, 'must be reported: ' + planted);
  }
  // Round 3's plants: the rule reversed inside its own sentence by an order word, a negation
  // two words from the verb, and the verbs the closed list lacked.
  for (const planted of ['The orchestrator appends the findings file — `' + APPEND + '` — and commits it with the PROGRESS update, having already forwarded the path.',
    'Every findings file reaches LOG.md — `' + APPEND + '` — committed with the PROGRESS update, its path forwarded before the append.',
    "Findings in LOG.md under the row's heading: every findings file reaches LOG.md first — `" + APPEND + '` in Git Bash — committed with the PROGRESS update, its path forwarded before the append to the polish, fix-round or round-2 prompt.',
    '- Before running `' + APPEND + '`, forward the findings path to the implementer.',
    '- Run `' + APPEND + '` only after forwarding the findings path to the implementer.',
    "- Don't ever run `" + APPEND + '` for a polish pass; forward the findings path to the implementer at once.',
    '- Point the fix round to the round-1 findings file, and append it to LOG.md afterwards.',
    '- Provide the findings path to the implementer, then append the file to LOG.md.']) {
    assert.ok(forwardFaults(planted).length >= 1, 'must be reported: ' + planted);
  }
  // An order word in a LATER clause is not about the append: this is the recovery rule itself.
  assert.deepEqual(forwardFaults('Run `' + APPEND + '` first; the recovery exits non-zero unless the heading occurs once, and only after a zero exit is that path forwarded.'), []);
  // The other verbs, written as prose an author would use, not read off the pattern.
  for (const handing of ["Hand the reviewer's report path to the implementer, then append it to LOG.md.",
    'Pass the findings file to the fix round.', 'Send the ASK list to the implementer.', 'Give the implementer the round-1 report.',
    'The orchestrator hands the report on to the implementer.', 'Resume the implementer with its ASK list.',
    'Point the fresh reviewer at the round-1 report.', 'Resumed with both findings files, the implementer fixes each.',
    'Share the findings file with the fresh reviewer.', 'Supply the round-1 report to the fix round.']) {
    assert.equal(forwardFaults(handing).length, 1, 'must be reported: ' + handing);
    assert.deepEqual(forwardFaults('Run `' + APPEND + '` first. ' + handing), [], 'after the append it is allowed: ' + handing);
  }
  assert.deepEqual(forwardFaults('Every test must pass before the batch integrates. Use forward slashes in a path. '
    + 'A polish pass (ASK list in LOG.md) closes it. Verdicts: **pass** · **fail** with the findings. At hand-over preserve the report path. Its last line gives your report\'s exact line 2. '
    + "Round in flight → resume the implementer (fresh) with that round's findings from LOG.md; not a round. "
    + 'Resume the implementer with the pointer to its rendered `polish` prompt (the findings file by path). '
    + 'Spawn or resume the agent with this ONE fixed pointer message, `<prompt file>` replaced by that path. '
    + 'Asked to resume a COMPLETE ledger → reconcile, report completion, point at the backlog.'), [],
    'passing tests, a polish pass, a hand-over, forward slashes, findings read back from LOG.md and a pointer are not handing findings on');
  assert.equal(forwardFaults('Pass on the findings path to the fix round.').length, 1);
  let forwards = 0;
  for (const file of [...documents(), ...agentDefinitions()]) {
    const text = read(file);
    assert.deepEqual(forwardFaults(text), [], file + ': findings forwarded without the LOG append first');
    if (/findings/i.test(text)) forwards += [...text.matchAll(/\bforward(?:s|ed|ing)?\b/gi)].length;
  }
  // The template's statement of the append moved to protocol.md with the rest of its procedure.
  for (const file of ['orchestrate/references/protocol.md', PROMPTS]) {
    const text = collapse(LOG_PLACEHOLDERS(read(file)));
    assert.ok(text.includes(APPEND) && /never re-typed through (?:its own|the orchestrator's) context/.test(text), file + ': states the byte-for-byte LOG append');
    assert.ok(/\bforward(?:s|ed|ing)?\b/.test(text), file + ': states the forwarding the append must precede');
  }
  assert.ok(forwards >= 3);
});

// Directives that would reinstate pasting for a rendered role, or give a gate agent a second
// write. Clause-level, negation-aware (the same reader as the undo sweep above).
// The first family replaced the old `paste, don't point` pattern and is its superset: the
// old specimen is still its specimen.
const RENDERED_ROLE = String.raw`\b(?:implementer|reviewer|test[- ]hunter|polish|fix[- ]round|rework|round[- ]2)\b`;
const REINSTATE = [
  ['pointing forbidden', /\b(?:never|don['’]t|do not)\s+point\b/i, "Paste, don't point: the batch text goes into the prompt."],
  ["a rendered role's skeleton pasted", new RegExp(RENDERED_ROLE + String.raw`[^.;:]*\bpast(?:e|es|ed|ing)\b|\bpast(?:e|es|ed|ing)\b[^.;:]*` + RENDERED_ROLE, 'i'),
    'Fill the reviewer skeleton from the ledger and paste it into the Agent call'],
  ['findings handed over verbatim', /\b(?:findings|ASK list|ASKs)\b[^.;:]{0,30}\bverbatim\b/i, 'Resume the SAME implementer with the findings verbatim'],
  ['a rendered prompt or findings pasted', /\bpast(?:e|es|ed|ing)\b[^.;:]*\b(?:rendered|prompt file|batch text|contract excerpts|findings|ASK list)\b/i, 'Paste the rendered prompt into the spawn call'],
  ['findings relayed through the context', /\b(?:relay|re-?typ|restat)\w*\b[^.;:]*\bfindings\b/i, "Relay the reviewer's findings to the implementer"],
  ['a gate agent licensed to write more', /\b(?:reviewer|test[- ]hunter|gate agents?)\b[^.;:]*\b(?:may|can|should|also)\s+(?:write|edit|create|modify)\b/i, 'The test hunter may also write a scratch file for each mutation'],
  ['a second file for a gate agent', /\b(?:reviewer|test[- ]hunter|gate agents?)\b[^.;:]*\b(?:second|another|additional|extra|other)\s+(?:file|write)s?\b/i, 'The reviewer keeps a second file with its raw notes'],
];
const reinstating = text => clauses(text).flatMap(c => REINSTATE.filter(([, p]) => fires(p, c)).map(([name]) => name + ' — ' + c));
test('no shipped text reinstates pasting for a rendered role or a second write for a gate agent', () => {
  assert.equal(new Set(REINSTATE.map(r => r[0])).size, REINSTATE.length);
  for (const [name, pattern, specimen] of REINSTATE) {
    assert.deepEqual(REINSTATE.filter(([, p]) => p.test(specimen)).map(r => r[0]), [name], name + ': its specimen must be caught by it alone');
    assert.equal(reinstating(specimen + '.').length, 1, name);
  }
  // Written as prose, not read off the patterns.
  for (const planted of ['Polish pass: resume the implementer with the ASK list verbatim.', 'Paste the batch text and contract excerpts into the prompt.',
    'Paste the findings into the fix-round message.', 'Relay the round-1 findings to the fresh reviewer.', 'The reviewer can write its notes into the worktree.',
    'Gate agents may also create a summary file.', 'The test hunter keeps another file for surviving mutants.',
    'Fill the reviewer skeleton from the ledger and paste it into the Agent call; never point an agent at a file.',
    'Paste the polish prompt into SendMessage.', 'The implementer skeleton is pasted in full.', 'Do not point the test hunter at a file.',
    'Paste the rework block into the spawn call.']) {
    assert.ok(reinstating(planted).length >= 1, 'must be reported: ' + planted);
  }
  assert.deepEqual(reinstating(CARVE_OUT + ' Findings travel by path, never re-typed through its own context. '
    + 'When the renderer is unavailable or refuses, the manual procedure is the skeleton filled by hand and pasted without its nonce line. '
    + 'The QA runner, artifact proofer, census, pre-flight, convergence and fix-up skeletons are always filled and pasted and carry NO nonce.'), [],
  'the rules themselves are not reinstatements');
  const files = [...documents(), ...agentDefinitions()];
  assert.ok(files.includes(PROMPTS) && files.includes('.claude/agents/reviewer.md') && files.includes('.claude/agents/test-hunter.md'));
  for (const file of files) assert.deepEqual(reinstating(read(file)), [], file);
});

// The user's decision (2026-09-23): the gate pair gets the Write tool, scoped to the findings
// file plus validation logs and disposable scratch under the session scratchpad, never a
// worktree or the repository. Stated once per gate skeleton and once per definition.
const CARVE_OUT = 'write your full report with the Write tool to "[FINDINGS_FILE]"; besides that ONE file you write only validation logs and disposable scratch under "[SCRATCHPAD_PATH]", never inside any worktree or the repository.';
const EXCEPTION = 'Keep to reading files and read-only git, with one exception: with the Write tool you write the findings file your prompt names, and validation logs and disposable scratch under the session scratchpad — never inside any worktree or the repository.';
// The test hunter's grant within that one (B05): a closed list — its findings file, its mutations
// file and its scoped spec — plus the two harness tools, which write only disposable clones. The
// skeleton states it as its carve-out; the definition keeps EXCEPTION verbatim and narrows it,
// mapping each thing EXCEPTION grants onto the list (R1 hunter note: an unmapped "validation
// logs and disposable scratch" read as a second, wider grant beside the closed list).
const HUNTER_WRITES = 'your mutations file and your scoped spec';
const HUNTER_TOOLS = 'running mutate.mjs and run-at-ref.mjs, which write only disposable clones and their logs, is permitted.';
const HUNTER_CARVE_OUT = 'write your full report with the Write tool to "[FINDINGS_FILE]"; besides that ONE file you write only ' + HUNTER_WRITES
  + ', both under "[SCRATCHPAD_PATH]", never inside any worktree or the repository, and ' + HUNTER_TOOLS;
const HUNTER_MAPPING = { 'validation logs': 'the validation logs are the ones mutate.mjs and run-at-ref.mjs write', 'disposable scratch': 'the disposable scratch is ' + HUNTER_WRITES };
const HUNTER_LIST = 'Those writes are a closed list, in which ' + HUNTER_MAPPING['validation logs'] + ' and ' + HUNTER_MAPPING['disposable scratch']
  + ': the findings file, ' + HUNTER_WRITES + ', all under the session scratchpad, and ' + HUNTER_TOOLS;
const GRANTS = { reviewer: CARVE_OUT, 'test-hunter': HUNTER_CARVE_OUT };
const CAVEAT = 'Write and Bash can still write, so "read-only" stays partly conventional; withholding Edit closes the easy path, not every path.';
// Each gate skeleton's own read-only sentence, reconciled with the grant (round-2 hunter note):
// it names the Write tool only as the OUTPUT carve-out scopes it.
const GATE_READ_ONLY = {
  reviewer: 'You did not write this code. Use only Read/Grep/Glob and read-only git (diff, log, show, status), and the `Write` tool only for what OUTPUT below names. You never edit a file.',
  'test-hunter': 'Use only Read/Grep/Glob and read-only git, and the `Write` tool only for what OUTPUT below names; edit nothing.',
};
// The reviewer's one directive naming a worktree as a place: where to work, not where to write.
const WHERE_TO_WORK = "Work in the batch's worktree at [WORKTREE_PATH] (checked out on [BATCH_BRANCH]).";
// The location family rejects on doubt, so its negation is read over the clause: a negator
// earlier in it governs the location unless a comma, a conjunction or a negative verb breaks
// its scope ("never skip saving … in the worktree" licenses), and "nothing but/except" licenses.
const LOCATION_NEGATOR = /\b(?:never|not(?!\s+(?:only|just|merely|simply)\b)|no|none|nothing(?!\s+(?:but|except|besides|beyond|other than|save|apart from)\b)|cannot|nor|\w+n['’]t)\b/gi;
const SCOPE_BREAK = /,|\b(?:and|then|but|or|so|also)\b|\b(?:skip|omit|neglect|forg[eo]t|fail|avoid|hesitat)\w*/i;
function negatedLocation(clause, at) {
  const before = clause.slice(0, at);
  let end = -1;
  for (const m of before.matchAll(LOCATION_NEGATOR)) end = m.index + m[0].length;
  return end !== -1 && !SCOPE_BREAK.test(before.slice(end));
}
// Any further write, subject-free, in five families that each own a specimen no other family
// catches. The grants above, and the reviewer's where-to-work line, are removed as their EXACT
// text before the sweep — never by the sentence that holds them — so a licence appended inside
// a grant's own sentence is swept. "<verb> nothing" is a prohibition and "<verb> nothing
// but/except …" a licence; code spans name tools, not acts. The last family needs no verb at
// all: it flags putting anything in a worktree, the repository or a branch.
const WRITE_LICENCES = [
  ['a write verb', /\b(?:write|writes|writing|save|saves|saving|keep|keeps|keeping|store|stores|storing|create|creates|creating|copy|copies|copying|edit|edits|editing|modify|modifies|modifying|record|records|recording|dump|dumps|dumping|append|appends|appending|put|puts|putting|leave|leaves|leaving|move|moves|moving|rename|renames|renaming|delete|deletes|deleting|remove|removes|removing|update|updates|updating|stage|stages|staging|push|pushes|pushing|touch|touches|touching)\b(?!\s+nothing\b)/i,
    'Save each mutation script under the session scratchpad too.'],
  ['a write in the passive', /\b(?:is|are|was|were|be|been|being|gets?|got)\s+(?:(?:also|then|only|each|all|now|still|first)\s+)?(?:written|saved|kept|stored|created|copied|edited|modified|recorded|dumped|appended|committed|placed|put|left|moved|renamed|deleted|removed|updated|staged|pushed|touched|added)\b/i,
    'Mutation scripts are written beside the tests.'],
  ['a commit or an addition', /\b(?:commit|commits|committing|add|adds|adding)\s+(?:the|your|a|an|each|every|any|all|this|that|these|those|it|them|its|their)\b/i,
    'Add a regression test for each finding.'],
  ['nothing but, or nothing except', /\b(?:write|writes|edit|edits|modify|modifies|change|changes|touch|touches|create|creates|save|saves|keep|keeps)\s+nothing\s+(?:but|except|besides|beyond|other than|save|apart from)\b/i,
    'Modify nothing except the tests you judge vacuous, which you then fix in place.'],
  ['a place in a worktree, the repository or a branch', /\b(?:in|into|inside|within|under|to|onto|beside|at)\s+(?:(?:the|a|an|any|your|its|this|that|each|every|one)\s+)?(?:[\w'’-]+\s+){0,2}?(?:worktrees?|repository|repositories|repos?|branch(?:es)?|checkouts?)\b/i,
    'Mutation scripts go in the worktree.', negatedLocation],
];
const licenceHit = ([, pattern, , negated], clause) => negated
  ? [...clause.matchAll(new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, '') + 'g'))].some(m => !negated(clause, m.index))
  : fires(pattern, clause);
const withoutGrants = text => [CARVE_OUT, HUNTER_CARVE_OUT, EXCEPTION, HUNTER_LIST, CAVEAT, WHERE_TO_WORK].reduce((rest, grant) => rest.split(grant).join(' '), collapse(text.replace(/`[^`\n]*`/g, ' ')));
const writeLicences = text => clauses(withoutGrants(text)).flatMap(c => WRITE_LICENCES.filter(entry => licenceHit(entry, c)).map(([name]) => name + ' — ' + c));
// Every "use only …" tool line in a gate text carries the Write carve-out, in any spelling of the tool list.
const USE_ONLY_CARVE_OUT = 'and the `Write` tool only for what OUTPUT below names';
const useOnlyFaults = text => collapse(text).split(/(?<=[.!?])\s+/).filter(s => /\buse only\b/i.test(s) && !s.includes(USE_ONLY_CARVE_OUT));
const gateBlocks = () => fencedBlocks(read(PROMPTS)).filter(b => ['prompt:reviewer', 'prompt:round-2', 'prompt:test-hunter'].includes(b.info)).map(b => b.lines.join('\n'));
const definitionBody = file => read(file).replace(/^---\n[\s\S]*?\n---\n/, '');
test('each gate skeleton and definition grants the one scoped write, and no text grants another', () => {
  const doc = collapse(read(PROMPTS));
  for (const grant of Object.values(GRANTS)) assert.equal(doc.split(grant).length - 1, 1, 'each gate skeleton\'s carve-out is stated once in the skeletons: ' + grant);
  assert.ok(!CARVE_OUT.includes(HUNTER_CARVE_OUT) && !HUNTER_CARVE_OUT.includes(CARVE_OUT), 'neither carve-out counts as the other');
  for (const [from, to, heading] of [['## Reviewer (the gate', '## Test hunter', 'reviewer'], ['## Test hunter (optional', '## QA runner', 'test-hunter']]) {
    const skeleton = collapse(section(read(PROMPTS), from, to));
    assert.equal(skeleton.split(GRANTS[heading]).length - 1, 1, from + ': its carve-out exactly once');
    assert.ok(skeleton.includes('`### B[NN] R[ROUND] ' + heading + ' findings`'), from + ': the findings file is headed for LOG.md');
    assert.doesNotMatch(skeleton, /heredoc|<<'?EOF/i, from + ': findings are written with the Write tool, never a heredoc');
    // Its read-only sentence names the Write tool only as the carve-out scopes it, and no
    // "use only" line denying the grant survives beside it, however it spells the tools.
    assert.equal(skeleton.split(GATE_READ_ONLY[heading]).length - 1, 1, from + ': the reconciled read-only sentence, once');
    assert.deepEqual(useOnlyFaults(skeleton), [], from + ': a "use only" line that denies the Write grant');
  }
  // The use-only rule, armed: the old sentence, another spelling of the tools, and a modal form.
  for (const plant of ['Use only Read/Grep/Glob and read-only git; edit nothing.', 'Use only Read, Grep, Glob and read-only git.', 'You may use only the Read tool.']) {
    assert.equal(useOnlyFaults(plant).length, 1, 'must be reported: ' + plant);
  }
  assert.deepEqual(useOnlyFaults(Object.values(GATE_READ_ONLY).join(' ')), [], 'the reconciled sentences carry the carve-out');
  // The where-to-work exemption is the reviewer's live sentence, or it exempts nothing.
  assert.equal(collapse(section(read(PROMPTS), '## Reviewer (the gate', '## Test hunter')).split(WHERE_TO_WORK).length - 1, 1,
    'the reviewer skeleton states where to work once');
  for (const file of ['.claude/agents/reviewer.md', '.claude/agents/test-hunter.md']) {
    const text = collapse(read(file));
    assert.equal(text.split(EXCEPTION).length - 1, 1, file + ': the one exception, verbatim, once');
    assert.equal(text.split('exception').length - 1, 1, file + ': no second exception');
    assert.ok(text.includes(CAVEAT), file + ': the caveat for a Write-granted role');
    // The closed list narrows the hunter's exception directly after it, and is the hunter's alone.
    assert.equal(text.split(EXCEPTION + ' ' + HUNTER_LIST).length - 1, file.endsWith('test-hunter.md') ? 1 : 0, file + ': the closed list of hunter writes');
    assert.equal(text.split(HUNTER_LIST).length - 1, file.endsWith('test-hunter.md') ? 1 : 0, file);
  }
  // The list and the exception agree: every kind of write EXCEPTION grants past the findings file
  // is mapped onto a member of the closed list, and the list names nothing EXCEPTION does not grant.
  const grantedKinds = /the findings file your prompt names, and (.+?) under the session scratchpad/.exec(EXCEPTION);
  assert.ok(grantedKinds, 'EXCEPTION still names what it grants past the findings file');
  assert.deepEqual(grantedKinds[1].split(' and '), Object.keys(HUNTER_MAPPING), 'each kind EXCEPTION grants, and only those, is mapped by the closed list');
  for (const [kind, mapping] of Object.entries(HUNTER_MAPPING)) {
    assert.ok(mapping.startsWith('the ' + kind + ' '), kind + ': the mapping names the granted kind');
    assert.ok(HUNTER_LIST.includes(mapping), kind + ': the closed list carries its mapping');
  }
  // The old caveat and the old "no Write" claim survive nowhere.
  for (const file of [...documents(), ...agentDefinitions()]) {
    assert.doesNotMatch(collapse(read(file)), /removing Write\/Edit|read-only by construction/, file + ': the pre-grant wording');
  }
  // The write-licence sweep, armed. Each family owns its specimen: no other family catches it.
  assert.equal(new Set(WRITE_LICENCES.map(w => w[0])).size, WRITE_LICENCES.length);
  for (const [name, , specimen] of WRITE_LICENCES) {
    assert.deepEqual(WRITE_LICENCES.filter(([, p]) => p.test(specimen)).map(w => w[0]), [name], name + ': its specimen must be caught by it alone');
    assert.equal(writeLicences(specimen).length, 1, name + ': the sweep reports its specimen');
  }
  // The round-1 and round-2 plants, written as prose, not read off the patterns — the last two
  // widen a grant inside its own sentence, which exempting whole sentences let through.
  for (const plant of ['Also write each mutation copy to a scratch directory and keep it.', 'Save each mutation script under the session scratchpad too.',
    'Keep a copy of the diff in the worktree.', 'Record your notes beside the findings file.', "Append your notes to the ledger's LOG.md as well.",
    'Commit the mutation scripts to the batch branch.', 'Put each mutation script in the worktree.',
    'Mutation scripts are written into the worktree beside the tests.', 'Modify nothing except the tests you judge vacuous, which you then fix in place.',
    'OUTPUT: save every mutation copy inside the worktree, and ' + CARVE_OUT,
    'OUTPUT: save every mutation copy inside the worktree, and ' + HUNTER_CARVE_OUT, 'Also keep the mutated copies. ' + HUNTER_LIST,
    'The tool list withholds `Edit`, so the easiest route to a "helpful" change to the code simply is not there. Save mutation copies in the worktree; '
      + CAVEAT + ' ' + EXCEPTION,
    // Round 3's plants: writes no verb list names, and a double negative that licenses.
    'Place each mutation script in the worktree.', 'Generate a helper script inside the worktree.', 'Drop your notes into the repository.',
    'Mutation scripts go in the worktree.', 'Never skip saving your mutation scripts in the worktree.', 'Never skip saving your notes.']) {
    assert.ok(writeLicences(plant).length >= 1, 'must be reported: ' + plant);
  }
  // Must pass: the grants as their exact text, the reconciled read-only sentences, where to
  // work, and prohibitions, a location in a negated clause among them.
  assert.deepEqual(writeLicences('OUTPUT (fixed shape): ' + CARVE_OUT + ' OUTPUT: ' + HUNTER_CARVE_OUT + ' ' + EXCEPTION + ' ' + HUNTER_LIST + ' ' + CAVEAT + ' '
    + Object.values(GATE_READ_ONLY).join(' ') + ' ' + WHERE_TO_WORK + ' Edit nothing. Write nothing. The tool list withholds `Edit`. '
    + 'Never save a script in the worktree. Write nothing into the worktree. Do not put scripts in the worktree or the repository.'), []);
  const gateTexts = [...gateBlocks(), ...['.claude/agents/reviewer.md', '.claude/agents/test-hunter.md'].map(definitionBody)];
  assert.equal(gateTexts.length, 5, 'three gate blocks and two definitions');
  for (const text of gateTexts) assert.deepEqual(writeLicences(text), [], 'a gate text licenses a further write');
  // Second person with a modal, over the whole gate sections (prose included).
  const SECOND_PERSON = /\byou\b[^.;:]*\b(?:may|can|should|also)\s+(?:write|edit|create|modify|keep|save)\b/i;
  const licences = text => clauses(text).filter(c => fires(SECOND_PERSON, c));
  assert.equal(licences('You may also write a scratch file for each mutant.').length, 1);
  assert.equal(licences('You can save your notes in the worktree.').length, 1);
  assert.deepEqual(licences('You edit nothing. ' + CARVE_OUT + ' ' + EXCEPTION + ' ' + HUNTER_CARVE_OUT + ' ' + HUNTER_LIST), []);
  for (const text of [section(read(PROMPTS), '## Reviewer (the gate', '## Test hunter'), section(read(PROMPTS), '## Test hunter (optional', '## QA runner'),
    ...['.claude/agents/reviewer.md', '.claude/agents/test-hunter.md'].map(read)]) {
    assert.deepEqual(licences(text), [], 'a gate text licenses a further write');
  }
});

// ===== The test hunter proves each mutation with the harness (B05) ==========================
// The hunter no longer builds its own apparatus: it hands mutate.mjs a mutations file and a
// validate spec scoped to the batch's tests, cites the tool's lines, and reports any line that
// means the proof did not run as exactly that. The list of such lines is the tool's own export.
const HUNTER_SECTION = () => section(read(PROMPTS), '## Test hunter (optional', '## QA runner');
const MUTATE_COMMAND = 'node "[SKILL_DIR]/tools/mutate.mjs" --repo "[WORKTREE_PATH]" --ref HEAD --mutations "<mutations file>" --validate "<scoped spec>" --log "[SCRATCHPAD_PATH]/<label>.log"';
const SETUP_CLAUSE = 'adding `--setup "[WORKTREE_PATH]/[LEDGER_DIR]/setup.json"` when that file exists';
// The two sentences that tie a verdict to skipped tests, each saying what it cannot show.
const SKIP_SURVIVED = 'A `SURVIVED` line says nothing about a test the control skipped (`, <n> skipped` on its line), since a mutation of code only that test covers still reads `SURVIVED`.';
const SKIP_SWAP = 'Counts are not names: a mutation that skips one test and runs one the control skipped changes neither the total nor the skipped count, so its `SURVIVED` or `KILLED` line may rest on a test the control never ran — before citing either, compare the tests its run and the control ran in the log; where the log does not name each test, cite neither.';
const mutateTool = () => import(require('node:url').pathToFileURL(path.join(ROOT, 'orchestrate/tools/mutate.mjs')).href);
test('the test hunter proves each mutation with mutate.mjs on a scoped spec, and reports a proof that did not run as such', async () => {
  const hunter = collapse(HUNTER_SECTION());
  assert.equal(hunter.split('`' + MUTATE_COMMAND + '`').length - 1, 1, 'the harness command, once, as one code span');
  for (const needed of ["each finding's mutation is also proven by running it with the mutation harness.",
    'Never build a scratch tree, a mutation script or a restore of your own by hand.',
    'Your mutations file is `{ "mutations": [ { "id": "m1", "file": "<repo-relative path>", "find": "<text occurring exactly once>", "replace": "<text>" } ] }`',
    'your scoped spec is `[LEDGER_DIR]/validate.json` narrowed to the test files the batch added or changed',
    SETUP_CLAUSE + ' (a repository with a setup step fails its control without it).',
    // node --test skips a named file that does not exist and still passes: only the count shows it.
    'Its `CONTROL PASS` line must count the tests you scoped: a runner may skip a named test file that does not exist.',
    // Node counts a test file that registers no tests as one passing test; validate.mjs catches it
    // by the file's name, except the relative name whose first segment holds a space (its --help).
    'The count has a blind spot: node counts a test file that registers no tests as one passing test named after the file, which the harness reports as a file that ran no tests unless node names it by a relative path whose first segment holds a space (`my file.test.js`, `my dir/a.test.js`) — there a mutation after which a one-test file registers nothing does not change the count and reads `SURVIVED`, so before you cite a `SURVIVED` line, check its run in the log for a scoped test file reported under its own file name.',
    // A control may pass with skips, and a mutation may swap a skipped test for a running one.
    SKIP_SURVIVED, SKIP_SWAP,
    // (1 + mutations) runs of the scoped suite can outlast the shell's cap, and a killed run skips the tool's cleanup.
    "A run costs the scoped suite once for the control and once per mutation; when that may outlast the runtime's command timeout, run it as a background task whose completion reports its lines and exit code, or pass `--timeout` and split the mutations across runs — a run the command timeout kills never cleans up its clone.",
    "means the proof did not run — say so, never offer it as a finding's proof.",
    'For a suite at another ref, `node "[SKILL_DIR]/tools/run-at-ref.mjs"` takes the same flags less `--mutations` and prints one line, `AT <short sha> <validate.mjs line>`.',
    'Beyond those, run only the two harness tools PROOF below names, which work on disposable clones.']) {
    assert.ok(hunter.includes(needed), 'the hunter skeleton must say: ' + needed);
  }
  // R2: the earlier blind-spot wording sent the hunter to the mutated file, which may register nothing.
  assert.ok(!hunter.includes('still registers its tests') && hunter.split('does not change the count').length === 2, 'the blind spot is stated once, in its corrected form');
  // C1: an emptied file is now caught by name; only the unrecognised name keeps the blind spot.
  assert.equal(hunter.split('node counts a test file that registers no tests').length, 2, 'the blind spot is stated once');
  assert.ok(!/node counts a test file that registers no tests as one passing test named after the file, so /.test(hunter), 'the blind spot is no longer every one-test file');
  assert.ok(!hunter.includes('one blind spot'), 'the count has more than one blind spot: the swap is another');
  // SURVIVED proves, KILLED refutes, and every other kind the tool declares means "did not run".
  const { RESULTS, NOT_RUN } = await mutateTool();
  const cite = /Cite its lines: (.*?) means the proof did not run/.exec(hunter);
  assert.ok(cite, 'the hunter skeleton cites the tool\'s lines');
  const named = [...cite[1].matchAll(/`([A-Z][A-Z -]*[A-Z])(?: <[^`]*)?`/g)].map(m => m[1]);
  assert.deepEqual(named.slice(0, 2), ['SURVIVED', 'KILLED']);
  assert.deepEqual(RESULTS.slice().sort(), named.slice(0, 2).sort(), 'the two results are the tool\'s');
  assert.deepEqual(named.slice(2).sort(), NOT_RUN.slice().sort(), 'every line kind the tool declares as not-run, and no other');
  assert.ok(NOT_RUN.length >= 8, 'the declared list was really read');
  // The flags the skeleton publishes are the ones the real tools document.
  for (const [tool, flags] of [['mutate.mjs', ['--repo', '--ref', '--mutations', '--validate', '--log', '--setup']], ['run-at-ref.mjs', ['--repo', '--ref', '--validate', '--log', '--setup']]]) {
    const help = spawnSync(process.execPath, [path.join(ROOT, 'orchestrate/tools', tool), '--help'], { encoding: 'utf8', windowsHide: true });
    assert.equal(help.status, 0, tool);
    const synopsis = help.stdout.split('\n')[0];
    for (const flag of flags) assert.ok(synopsis.includes(flag + ' <'), tool + ' documents ' + flag);
    assert.ok(!synopsis.includes('--mutations') || tool === 'mutate.mjs', 'run-at-ref takes the same flags less --mutations');
  }
});

test("the hunter's harness command runs as published, filled from its slots, with and without its --setup clause", t => {
  const { repo, temp, env, SKILL_DIR } = fixture(t);
  const scratch = path.join(temp, 'session scratch'), tmpRoot = path.join(temp, 'temp root');
  fs.mkdirSync(scratch); fs.mkdirSync(tmpRoot);
  repo.write('math.cjs', '// Adds two numbers.\nexports.add = (a, b) => a + b;\n');
  repo.write('math.test.cjs', "const test = require('node:test');\nconst assert = require('node:assert/strict');\nconst { add } = require('./math.cjs');\ntest('add sums two numbers', () => { assert.equal(add(2, 3), 5); });\n");
  // setup.json where the skeleton points: it makes a test file only a set-up checkout has.
  repo.write(LEDGER_DIR + '/setup.json', JSON.stringify({ steps: [{ name: 'gen', argv: [process.execPath, '-e',
    "require('fs').writeFileSync('gen.test.cjs', \"require('node:test')('made by setup', () => {});\")"], parser: 'none' }] }));
  repo.commit('fixture');
  const scratchFile = (name, value) => { const f = path.join(scratch, name); fs.writeFileSync(f, JSON.stringify(value)); return slash(f); };
  const muts = scratchFile('muts.json', { mutations: [{ id: 'm1', file: 'math.cjs', find: 'a + b', replace: 'a - b' },
    { id: 'm2', file: 'math.cjs', find: '// Adds two numbers.', replace: '// Adds numbers.' }] });
  const hunter = collapse(HUNTER_SECTION());
  const published = /`(node "\[SKILL_DIR\]\/tools\/mutate\.mjs"[^`]*)`/.exec(hunter)[1];
  const setupFlag = /adding `(--setup "[^`]*")` when that file exists/.exec(hunter)[1];
  assert.equal(published, MUTATE_COMMAND);
  const fill = (text, spec, label) => [['[SKILL_DIR]', SKILL_DIR], ['[WORKTREE_PATH]', slash(repo.cwd)], ['[SCRATCHPAD_PATH]', slash(scratch)],
    ['[LEDGER_DIR]', LEDGER_DIR], ['<mutations file>', muts], ['<scoped spec>', spec], ['<label>', label]]
    .reduce((out, [token, value]) => out.split(token).join(value), text);
  const runEnv = { ...env, TEMP: tmpRoot, TMP: tmpRoot, TMPDIR: tmpRoot };
  const specOf = (name, files) => scratchFile(name, { steps: [{ name: 'tests', argv: [process.execPath, '--test', ...files], parser: 'node' }] });
  for (const [label, command, total] of [['bare', fill(published, specOf('scoped.json', ['math.test.cjs']), 'bare'), '1/1'],
    ['set-up', fill(published + ' ' + setupFlag, specOf('scoped-gen.json', ['math.test.cjs', 'gen.test.cjs']), 'set-up'), '2/2']]) {
    assert.doesNotMatch(command, /\[[A-Z_]+\]|<[a-z ]+>/, label + ': every slot and placeholder is filled');
    const r = runCommand(command, temp, runEnv);
    const out = r.stdout.trimEnd().split('\n');
    assert.match(out[0], new RegExp('^CONTROL PASS PASS tests ' + total + ' \\(\\d+s\\)$'), label + ': ' + r.stdout + r.stderr);
    assert.deepEqual(out.slice(1), ['KILLED m1: add sums two numbers', 'SURVIVED m2', 'MUTATE 1 killed, 1 survived, 0 other'], label);
    assert.equal(r.status, 1, label);
    assert.ok(fs.statSync(path.join(scratch, label + '.log')).size > 0, label + ': the log lands where the command names it');
    assert.deepEqual(fs.readdirSync(tmpRoot), [], label + ': the disposable clone is gone');
  }
});

// Directives that would put hand-built apparatus back in the hunter's hands, swept over its
// skeleton section and its definition only: temporary worktrees are legitimately described
// elsewhere (the failing-on-base check, the merge dry run). Clause-level, negation-aware — the
// undo sweep's reader. Code spans are read as their text, backticks dropped: a restore or edit
// command is normally written as one, so blanking them would strip the very spelling hunted
// (R1 hunter, NEW CLASS).
const HAND_BUILT = [
  ['a scratch tree built by hand', /\b(?:build|builds|building|make|makes|making|set up|sets up|setting up|prepare|prepares|preparing|clone|clones|cloning|copy|copies|copying|create|creates|creating)\b[^.;:]*\b(?:scratch|temporary|temp|throwaway|spare|separate)\s+(?:trees?|copies|copy|worktrees?|checkouts?|clones?|director(?:y|ies)|dirs?|folders?)\b/i,
    'Build a scratch tree for each mutation and run the suite there.'],
  ['an edit script', /\b(?:write|writes|writing|generate|generates|generating|create|creates|creating|author|authors|authoring|use|uses|using|run|runs|running)\b[^.;:]*\b(?:edit|mutation|patch|sed|replace|rewrite)\s+scripts?\b/i,
    'Generate an edit script that swaps the operator for each mutation.'],
  // The bare command, with or without a restore word: neither hunter text names one (R2 hunter:
  // "run `git checkout -- <file>` before the next one" needed no restore word to do the harm).
  ['a git checkout, restore, reset or stash', /\bgit\s+(?:checkout|restore|reset|stash)\b/i,
    'After each mutation, run git checkout -- <file> before the next one.'],
  ['an edit command', /\b(?:sed|perl)\s+-\w*i\b|\b(?:Set-Content|Add-Content|Out-File)\b|\bgit\s+apply\b/i,
    'Apply each mutation in place with sed -i and run the suite.'],
];
// Written as prose first, then pinned: each family owns entries no other family catches.
const HAND_BUILT_CORPUS = [
  'Copy the worktree to a temporary directory and mutate the copy there.',
  'Make a throwaway clone of the batch branch for every mutation you try.',
  'Set up a scratch checkout under the session scratchpad and apply each edit there.',
  'Write a sed script that applies each mutation, then run the tests.',
  'Use a small patch script to flip each comparison in turn.',
  'After each run, restore the file with git checkout.',
  'Revert the mutation with git restore before trying the next.',
  'Run git stash after each mutation to undo it.',
  'After each run, restore the mutated file with `git checkout -- <file>`.',
  'Flip each operator with `perl -pi -e` before the run.',
  'Write the mutated text back with `Set-Content`.',
  'After each mutation, run `git checkout -- <file>` before the next one.',
  'Patch each mutant in with `git apply`.',
  'Append the mutated line with `Add-Content`.',
  'Send the mutated text through `Out-File`.',
];
// Every spelling the edit-command family names has an entry the corpus catches through it.
const EDIT_COMMANDS = ['sed -i', 'perl -pi', 'Set-Content', 'Add-Content', 'Out-File', 'git apply'];
const handBuilt = text => clauses(text.replace(/`([^`\n]*)`/g, '$1')).flatMap(c => HAND_BUILT.filter(([, p]) => fires(p, c)).map(([name]) => name + ' — ' + c));
test('no hunter text tells it to build a scratch tree, write an edit script or restore with git checkout', () => {
  assert.equal(new Set(HAND_BUILT.map(h => h[0])).size, HAND_BUILT.length);
  for (const [name, pattern, specimen] of HAND_BUILT) {
    assert.deepEqual(HAND_BUILT.filter(([, p]) => p.test(specimen)).map(h => h[0]), [name], name + ': its specimen must be caught by it alone');
    assert.equal(handBuilt(specimen).length, 1, name + ': the clause reader reports its specimen');
  }
  assert.equal(HAND_BUILT_CORPUS.length, 15, 'the corpus keeps all fifteen spellings');
  assert.equal(new Set(HAND_BUILT_CORPUS).size, 15);
  const edit = HAND_BUILT.find(([name]) => name === 'an edit command');
  for (const spelling of EDIT_COMMANDS) {
    const entries = [edit[2], ...HAND_BUILT_CORPUS].filter(entry => entry.includes(spelling));
    assert.ok(entries.length && entries.every(entry => fires(edit[1], entry.split('`').join(''))), spelling + ': an entry the edit-command family catches');
  }
  const families = entry => [...new Set(handBuilt(entry).map(hit => hit.split(' — ')[0]))];
  for (const entry of HAND_BUILT_CORPUS) assert.ok(families(entry).length >= 1, 'the sweep no longer catches: ' + entry);
  assert.deepEqual([...new Set(HAND_BUILT_CORPUS.flatMap(families))].sort(), HAND_BUILT.map(h => h[0]).sort(), 'the corpus exercises every family and names no other');
  for (const [name] of HAND_BUILT) assert.ok(HAND_BUILT_CORPUS.some(entry => families(entry).join() === name), name + ': no corpus entry is caught by this family alone');
  // A negation governs only the directive right after it; one elsewhere in the clause exempts nothing.
  assert.deepEqual(handBuilt('Never build a scratch tree, a mutation script or a restore of your own by hand. Never run git checkout. Do not write an edit script. Never use `git stash`.'), []);
  assert.equal(handBuilt('Do not pipe it; run git stash after each mutation.').length, 1, 'a negation in another clause exempts nothing');
  assert.equal(handBuilt('Do not pipe the output, and build a scratch tree for each mutation.').length, 1);
  const texts = [HUNTER_SECTION(), definitionBody('.claude/agents/test-hunter.md')];
  for (const text of texts) {
    assert.deepEqual(handBuilt(text), [], 'a hunter text directs hand-built apparatus');
    // Live control: the swept text is really read — an appended specimen is reported.
    assert.equal(handBuilt(text + '\n\n' + HAND_BUILT[0][2]).length, 1);
    // Also in a code span: the hunter's R1 plant, spelled as the skeleton spells commands.
    assert.equal(handBuilt(text + '\n\nAfter each run, restore the mutated file with `git checkout -- <file>`.').length, 1);
  }
});

// Only the one pinned passage speaks of a not-run line beside proof, a finding or a result — to
// say it is none. Anywhere else in the hunter's texts, a sentence naming a NOT_RUN kind (bare or
// in a code span) beside a proof word, the word "finding" or a RESULTS kind could promote that
// line to a finding's proof (R1 hunter: an appended sentence did, green; R2: "counts as
// `SURVIVED`" did too). The exemption is the passage's exact bytes, never a span between two
// ends: a lazy span exempted whatever was inserted inside it (R2 hunter, NEW CLASS).
const CITE_PASSAGE = "Cite its lines: `SURVIVED <id>` proves a finding and `KILLED <id>: <tests>` refutes it; `ANCHOR-MISSING`, `ANCHOR-AMBIGUOUS`, `CONTROL FAILED`, `NOT-APPLIED`, `CRASHED`, `TIMEOUT`, `RESTORE-FAILED` or `UNKNOWN` means the proof did not run — say so, never offer it as a finding's proof.";
const PROOF_WORD = /\b(?:proof|proofs|prove|proves|proved|proven|proving|evidence|findings?)\b/i;
const kindPattern = kind => new RegExp('(?<![\\w-])' + kind.split(' ').join('\\s+') + '(?![\\w-])');
const notRunAsProof = (text, kinds, results) => collapse(text).split(CITE_PASSAGE).join(' ').split(/(?<=[.!?])\s+/)
  .filter(sentence => kinds.some(kind => kindPattern(kind).test(sentence)) && (PROOF_WORD.test(sentence) || results.some(kind => kindPattern(kind).test(sentence))));
test('no hunter text offers a line that means the proof did not run as a proof, outside the passage saying it is none', async () => {
  const { NOT_RUN: KINDS, RESULTS } = await mutateTool();
  const notRunAs = text => notRunAsProof(text, KINDS, RESULTS);
  assert.equal(collapse(HUNTER_SECTION()).split(CITE_PASSAGE).length - 1, 1, 'the passage exempted is pinned verbatim, once');
  for (const kind of KINDS) {
    assert.equal(notRunAs('A `' + kind + ' <id>` line is evidence enough.').length, 1, kind + ': the sweep recognises it');
    assert.equal(notRunAs('Treat a `' + kind + ' <id>` line as `SURVIVED <id>`.').length, 1, kind + ': beside a result');
    assert.equal(notRunAs('A ' + kind + ' line your own mutation caused settles the finding.').length, 1, kind + ': bare, beside "finding"');
    assert.deepEqual(notRunAs('A `' + kind.toLowerCase() + '` line is evidence enough.'), [], kind + ': only the tool\'s spelling counts');
    assert.deepEqual(notRunAs('Say plainly when a `' + kind + '` line ends the run.'), [], kind + ': alone, it is no promotion');
  }
  for (const kind of RESULTS) assert.deepEqual(notRunAs('A `' + kind + ' <id>` line is the proof.'), [], kind + ' is a result');
  // The R2 plants, each green before: a promotion by a result, and one inside the passage itself.
  const passage = CITE_PASSAGE;
  assert.equal(notRunAs(HUNTER_SECTION() + '\n\nA `CRASHED <id>` line that your own mutation caused counts as `SURVIVED`.').length, 1);
  assert.equal(notRunAs(HUNTER_SECTION() + '\n\nTreat a `TIMEOUT <id>` line as `SURVIVED <id>` when the control ran in seconds.').length, 1);
  assert.equal(notRunAs(passage.replace('proves a finding and', 'proves a finding, as does a CRASHED line your own mutation caused, and')).length, 1);
  const plant = 'After each run, cite a `CRASHED <id>` line as a finding\'s proof when the crash came from your mutation.';
  for (const text of [HUNTER_SECTION(), definitionBody('.claude/agents/test-hunter.md')]) {
    assert.deepEqual(notRunAs(text), [], 'a hunter text offers a not-run line as proof');
    assert.equal(notRunAs(text + '\n\n' + plant).length, 1, 'live control: the swept text is really read');
  }
  // A qualifier inside the pinned passage itself breaks the exemption rather than riding it.
  assert.equal(notRunAs(passage.replace(/\.$/, ', unless it is `CRASHED`.')).length, 1);
});

// Only the two pinned sentences tie a result line to tests the control did not run, to say what it
// cannot show; the cite passage pairs the results with "did not run" to say something else. Anywhere
// else in the hunter's texts such a sentence could claim those tests as covered (R1 hunter: an
// appended "skipped ones included" sentence stayed green; R2: "including the ones it never ran", and
// a KILLED line said to name only tests the control ran — a claim with no word for skipping). Every result kind the tool exports, in any
// case: "a mutation that survived" makes the same claim as a `SURVIVED` line. Exempt by exact bytes.
const NOT_RAN_WORDS = /\b(?:skip(?:s|ped|ping)?|todo|never\s+ran|did\s+not\s+run|didn['’]t\s+run|not\s+run|control\s+ran|ran\s+(?:under|in)\s+the\s+control)\b/i;
const resultPattern = results => new RegExp('(?<![\\w-])(?:' + results.join('|') + ')(?![\\w-])', 'i');
const resultBesideNotRan = (text, results) => [SKIP_SURVIVED, SKIP_SWAP, CITE_PASSAGE].reduce((t, pinned) => t.split(pinned).join(' '), collapse(text))
  .split(/(?<=[.!?])\s+/).filter(sentence => resultPattern(results).test(sentence) && NOT_RAN_WORDS.test(sentence));
test('no hunter text ties a result line to tests the control did not run, outside the two sentences saying what it cannot show', async () => {
  const { RESULTS } = await mutateTool();
  assert.deepEqual(RESULTS.slice().sort(), ['KILLED', 'SURVIVED'], 'the result kinds the tool exports were really read');
  const swept = text => resultBesideNotRan(text, RESULTS);
  const hunter = collapse(HUNTER_SECTION());
  for (const pinned of [SKIP_SURVIVED, SKIP_SWAP, CITE_PASSAGE]) assert.equal(hunter.split(pinned).length - 1, 1, 'pinned verbatim, once: ' + pinned);
  const specimens = ['A `SURVIVED` line covers every test in the scoped spec, skipped ones included: each ran under the control.',
    'A test the control skipped (`, <n> skipped` on its line) runs under no mutation, so no `SURVIVED` line says anything about it.',
    'Treat SURVIVED as proof for skipped tests too.',
    'A `SURVIVED` line also vouches for every test the control listed, including the ones it never ran.',
    'A `SURVIVED` line covers every scoped test, including any the control did not run.',
    'A mutation that survived proves every skipped test too.',
    'A `KILLED` line names only tests the control ran, never one it skipped, so cite it without reading the log.',
    'A `KILLED` line refutes a finding even for a todo test.',
    "A `SURVIVED` line covers the tests the control didn't run.",
    'A `KILLED` line settles tests that were not run as well.',
    // A claim about which tests the control ran, with no word for skipping (R2 hunter's own plant).
    'A `KILLED` line names only tests the control ran, so cite it as a refutation without reading the log.',
    'A `SURVIVED` line vouches for every test that ran under the control.'];
  for (const specimen of specimens) assert.equal(swept(specimen).length, 1, 'the sweep catches: ' + specimen);
  // Each word and each result kind has a specimen caught through it.
  for (const word of ['skip', 'todo', 'never ran', 'did not run', "didn't run", 'not run', 'control ran', 'ran under the control']) assert.ok(specimens.some(s => s.includes(word)), 'a specimen says ' + word);
  for (const kind of RESULTS) assert.ok(specimens.some(s => s.includes('`' + kind + '`')), 'a specimen names ' + kind);
  for (const clean of ['Cite a `SURVIVED` line as the proof.', 'A runner may skip a named test file that does not exist.', 'A `KILLED` line names the failing tests.'])
    assert.deepEqual(swept(clean), [], 'not a claim about tests the control did not run: ' + clean);
  for (const text of [HUNTER_SECTION(), definitionBody('.claude/agents/test-hunter.md')]) {
    assert.deepEqual(swept(text), [], 'a hunter text ties a result line to tests the control did not run');
    for (const plant of [specimens[0], specimens[6]]) assert.equal(swept(text + '\n\n' + plant).length, 1, 'live control: the swept text is really read');
  }
  // A qualifier inside a pinned sentence breaks its exemption rather than riding it.
  assert.equal(swept(SKIP_SURVIVED.replace(/\.$/, ', unless it skipped only one.')).length, 1);
  assert.equal(swept(CITE_PASSAGE.replace(/\.$/, ', and `KILLED` covers any test the control skipped.')).length, 1);
});

test('protocol.md says, one sentence apiece, what mutate.mjs and the mutation runner do', () => {
  // The template's pair is pinned with its passage in PINNED; protocol.md's sits under Gate agents.
  const gate = collapse(section(read('orchestrate/references/protocol.md'), '- **Gate agents**', '- **QA runner**'));
  for (const sentence of ["A test hunter proves each mutation it chooses itself with the skill's `mutate.mjs`, on a disposable clone of the batch's commit.",
    "The contract's mutation runner, when it names one, is a different tool: an optional sweep of the batch's changed files."]) {
    assert.ok(gate.includes(sentence), 'protocol.md §Roles must say: ' + sentence);
  }
});

// The rendered-prompt life cycle around a crash, a respawn and the rounds after the first. Three
// passages of subagent-prompts.md are pinned whole: the third round; §Spawning rules' "Resume vs
// fresh" bullet, which states the third round again with the crash respawns and the renderer's
// FRESH verdict; and the "**Fix round 1**" lead-in, which points at that verdict beside the block.
const THIRD_ROUND = ['**Authorized third round**', '\n\n## Reviewer',
  '**Authorized third round** (the user chose "fix again" after `⛔`): a FRESH implementer on the strong tier, spawned with the pointer to its rendered `rework` prompt '
  + '(`round` 3, both rounds\' findings files joined into its findings file) — one prompt, one report, one nonce. Then a fresh re-review.'];
const RESUME_VS_FRESH = ['- Resume vs fresh:', '\n- Tiers:',
  '- Resume vs fresh: polish passes and the first fix round RESUME the same implementer (SendMessage, with the pointer to the rendered `polish` or `fix-round` prompt); '
  + 'a user-authorized third round is a FRESH implementer on the strong tier; reviewers are fresh every round; any agent lost to a crash is respawned fresh at the first unticked item — '
  + 'an implementer owed a fix round with its rendered `rework` prompt, one owed a polish pass with its rendered implementer prompt first, then the `polish` pointer. '
  + 'A polish or fix-round render takes, as fact `subagentTokens`, the `subagent_tokens` (its current context) the implementer it would resume shows in its last task notification; '
  + 'at or past the renderer\'s line it prints `FRESH <route>` instead of a prompt, and the pass goes to a FRESH implementer by the route that line names.'];
const FIX_ROUND_LEAD = ['**Fix round 1**', '\n\n```prompt:fix-round',
  '**Fix round 1** (after a `FIX FIRST`): resume the SAME implementer (a FRESH one with the `rework` prompt below when the render prints `FRESH` — §Spawning rules) with the pointer to this block, rendered as role `fix-round`:'];
test('recovery, respawn and later rounds work from rendered files and LOG.md, never from re-typed text', () => {
  const rules = collapse(section(read(PROMPTS), '## Spawning rules (orchestrator)'));
  const prompts = collapse(read(PROMPTS));
  // A findings file lost with the scratchpad comes back out of the committed LOG.md as lines,
  // heading through marker, or not at all (the commands themselves run in the next test). Lines,
  // not bytes: Git for Windows' awk drops the CR of a CRLF line, so no byte claim is made.
  const { recover } = logCommands(PROMPTS);
  assert.ok(recover, 'subagent-prompts.md publishes the recovery command');
  assert.ok(rules.includes('a findings file lost with the scratchpad is copied back out of the committed LOG.md, from its heading line up to its marker line, never re-typed — `'
    + recover + '` from Git Bash at the repository root, which restores those lines as committed (a CRLF line comes back LF under Git for Windows\' awk) and exits non-zero, writing nothing, unless the heading and its marker line each occur exactly once — and only after a zero exit is that path forwarded.'));
  for (const file of [PROMPTS, TEMPLATE, 'orchestrate/references/protocol.md']) {
    assert.doesNotMatch(collapse(read(file)), /restores (?:the|its|a) (?:findings )?file's bytes|restores (?:its|the|those) bytes/, file + ': the recovery restores lines, never a byte claim');
  }
  // Stated in protocol.md's step 6 since the template's copy retired.
  assert.ok(collapse(read('orchestrate/references/protocol.md')).includes('exits non-zero, writing nothing, unless its heading and marker line each occur exactly once, and only after a zero exit is that file forwarded'));
  assert.ok(collapse(read('orchestrate/references/protocol.md')).includes('a copy lost with the scratchpad is taken back out of the committed LOG.md, never re-typed'));
  // Two files are joined with a newline between them, so no heading is glued to a last line.
  assert.ok(rules.includes('their files are joined byte-for-byte, a newline between them, into one (`' + logCommands(PROMPTS).join + '`) and that path is forwarded.'));
  // A crashed implementer owed a fix round is respawned with the rework prompt; one owed a polish
  // pass with its implementer prompt before the polish pointer.
  assert.ok(rules.includes('an implementer owed a fix round with its rendered `rework` prompt, one owed a polish pass with its rendered implementer prompt first, then the `polish` pointer.'));
  // A polish pass or fix round whose render prints FRESH goes to a fresh implementer, stated in
  // §Spawning rules and pointed at from protocol.md's polish pass and round 1, execution-models.md's
  // gate and the "**Polish pass**" and "**Fix round 1**" lead-ins (FIX_ROUND_LEAD, pinned below).
  // The line itself lives in prompt.mjs alone (tests/prompt.test.cjs): no document names a size.
  assert.ok(rules.includes('A polish or fix-round render takes, as fact `subagentTokens`, the `subagent_tokens` (its current context) the implementer it would resume shows in its last task notification; '
    + 'at or past the renderer\'s line it prints `FRESH <route>` instead of a prompt, and the pass goes to a FRESH implementer by the route that line names.'));
  const protocol = collapse(read('orchestrate/references/protocol.md'));
  assert.ok(protocol.includes('When the fix-round render prints `FRESH` (implementer context at or past the renderer\'s line), round 1 goes to a fresh implementer with its rendered `rework` prompt instead (`subagent-prompts.md` §Spawning rules).'));
  assert.ok(protocol.includes('Polish pass: resume the same implementer (a fresh one when the render prints `FRESH` — `subagent-prompts.md` §Spawning rules) with the pointer to its rendered `polish` prompt'));
  assert.ok(prompts.includes('**Polish pass** (after a `SHIP` that carries ASKs): resume the SAME implementer (SendMessage; a FRESH one when the render prints `FRESH` — §Spawning rules) with the pointer to this block, rendered as role `polish`:'));
  assert.ok(collapse(read('orchestrate/references/execution-models.md')).includes('`FIX FIRST` → round 1 resumes the implementer (a fresh one with the `rework` prompt when the render prints `FRESH` — subagent-prompts.md §Spawning rules);'));
  const RESTATED = /about 400K|\b\d{3}K tokens|\b350,?000\b/;
  for (const control of ['past about 400K tokens', 'past 350K tokens of its context', 'at 350,000', 'at or past 350000']) assert.match(control, RESTATED, 'the size reader must see: ' + control);
  for (const file of [PROMPTS, 'orchestrate/references/protocol.md', 'orchestrate/references/execution-models.md']) {
    assert.doesNotMatch(collapse(read(file)), RESTATED, file + ': the fresh-implementer line is the renderer\'s, never restated as a size');
  }
  // The third round: one rework prompt, one nonce, the round number rendered, nothing told outside
  // the pointer. THIRD_ROUND, RESUME_VS_FRESH and FIX_ROUND_LEAD are each pinned whole (whitespace
  // collapsed), so a step reinstated beside a rule in any words goes red, and a sentence planted
  // just inside either end of each is the live control; the retired phrasing is still refused
  // anywhere in the document.
  const doc = read(PROMPTS);
  for (const [from, to, expected] of [THIRD_ROUND, RESUME_VS_FRESH, FIX_ROUND_LEAD]) {
    const pinned = text => collapse(section(text, from, to)).trim();
    assert.equal(doc.split(from).length - 1, 1, 'the anchor "' + from + '" must occur exactly once');
    assert.equal(pinned(doc), expected, PROMPTS + ' (' + from + '): the pinned passage changed; update it here only on purpose');
    const start = doc.indexOf(from) + from.length, end = doc.indexOf(to, start);
    assert.ok(end > start, from + ': its end ' + JSON.stringify(to) + ' must follow it');
    for (const at of [start, end]) {
      assert.notEqual(pinned(doc.slice(0, at) + ' Skip it when in a hurry.' + doc.slice(at)), expected, from + ': a sentence planted at offset ' + at + ' must redden the pin');
    }
  }
  assert.doesNotMatch(prompts, /each of the two reports carries its own nonce|then the `polish` or `fix-round` pointer/, 'the retired two-step is gone');
  assert.doesNotMatch(prompts, /you own this batch now/, 'nothing can be told outside the fixed pointer');
  assert.ok(prompts.includes('("fix: batch [NN] round [ROUND] — <summary>")') && !/round 1 — <summary>/.test(prompts), 'the fix-round commit carries its own round');
  // The main-checkout variant cannot be rendered.
  assert.ok(prompts.includes('A rendered file takes no such edit, so this variant is always the manual procedure (§Spawning rules).'));
  // Who creates the gates directory, and a respawned gate agent never reuses a findings path.
  assert.ok(rules.includes('the orchestrator creates `<scratchpad>/gates/` before the spawn (the renderer creates its `--out`), and a gate agent respawned after a wrong nonce gets a new `findingsFile`'));
});

// ===== The LOG.md round trip, run as published =========================================
// Round 2 shipped a recovery command no test ran, and it failed silently three ways: a
// findings line shaped like a heading truncated the copy, a heading that matched nothing gave
// an empty file, and a file with no final newline glued the next heading onto its last line —
// each with exit 0. So the append, recovery and join commands are taken out of the documents
// as published, only their placeholders filled, and run by Git for Windows' own bash: the
// contract validates from PowerShell, whose PATH reaches WSL's launcher for `bash` and holds no
// awk (the Git for Windows bash set-up under which tests/validate.test.cjs runs its test
// 'shell steps run the script as one argument and propagate its exit code'). Every outcome is
// judged on whole bytes.
const GIT_BASH = process.platform !== 'win32' ? 'bash'
  : path.resolve(spawnSync('git', ['--exec-path'], { encoding: 'utf8' }).stdout.trim(), '..', '..', '..', 'usr', 'bin', 'bash.exe');
function bashEnv(env) {
  if (process.platform !== 'win32') return env;
  const out = { ...env }, keys = Object.keys(out).filter(k => k.toUpperCase() === 'PATH'), current = keys.length ? out[keys[0]] : '';
  for (const key of keys) delete out[key];
  return { ...out, PATH: [path.dirname(GIT_BASH), current].join(';') };
}
// [BL-042] The comment above names the validate.test.cjs test it leans on by its title, never
// by a line range: the range it used to name went stale as that file grew.
test('[BL-042] the Git-bash pointer names, by title, the tests/validate.test.cjs test that runs the shells', () => {
  const source = read('tests/tool-wiring.test.cjs');
  const named = /tests\/validate\.test\.cjs runs its test\n\/\/ '([^'\n]+)'/.exec(source);
  assert.ok(named, 'the pointer names the test by its title');
  // Each top-level test of that file with its body, up to the next: the named one must be the
  // one that runs the shells, not merely a title that exists.
  const tests = read('tests/validate.test.cjs').split(/^(?=test\()/m).filter(t => t.startsWith('test('));
  const target = tests.filter(t => t.startsWith("test('" + named[1] + "'"));
  assert.equal(target.length, 1, 'no test of that title in tests/validate.test.cjs: ' + named[1]);
  const shells = /\b(?:GIT_BASH|SHELLS)\b/;
  assert.match(target[0], shells, 'the named test does not run the shells: ' + named[1]);
  // The check can fail: another test in that file does not run the shells.
  assert.ok(tests.some(t => !shells.test(t)), 'a test that does not run the shells exists in tests/validate.test.cjs');
  assert.doesNotMatch(source, new RegExp('validate' + '\\.test\\.cjs:' + '[0-9]'), 'a line-range pointer into tests/validate.test.cjs');
});
// The published text with its placeholders filled: every one of them, and nothing else.
function filledCommand(command, values) {
  const tokens = [...new Set([...command.matchAll(/<[A-Za-z][A-Za-z -]*>/g)].map(m => m[0]))].sort();
  assert.deepEqual(tokens, Object.keys(values).sort(), 'the placeholders filled are exactly the command\'s own: ' + command);
  return tokens.reduce((text, token) => text.split(token).join(values[token]), command);
}
// The recovery round 2 shipped: the control proving these cases can see the defects it had.
const ROUND2_RECOVER = "git show <integration-branch>:./<ledger-dir>/LOG.md | awk -v h='### B<NN> R<k> <role> findings' '$0 == h {p = 1; print; next} /^##?#? / {p = 0} p' > \"<findings file>\"";
test('the LOG.md append, recovery and join run as published: the exact bytes back, or a loud refusal', t => {
  const published = logCommands(PROMPTS);
  for (const [name, command] of Object.entries(published)) {
    assert.ok(command, 'subagent-prompts.md publishes the ' + name + ' command, on one line');
    assert.ok(![...command].some(c => c === '\\' || c.codePointAt(0) < 32 || c.codePointAt(0) === 127), name + ': no backslash and no control character');
  }
  // protocol.md states the same append and recovery (the template's copy moved there): one command, two statements.
  const protocol = logCommands('orchestrate/references/protocol.md');
  assert.equal(protocol.append, published.append); assert.equal(protocol.recover, published.recover);
  assert.deepEqual(logCommands(TEMPLATE), { append: undefined, recover: undefined, join: undefined }, 'the template states no LOG.md command');
  assert.ok(process.platform !== 'win32' || fs.existsSync(GIT_BASH), "Git for Windows' bash must be at " + GIT_BASH);

  const temp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'log round trip '));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }));
  const gates = path.join(temp, 'gate files'); fs.mkdirSync(gates);
  const file = name => slash(path.join(gates, name));
  const BRANCH = 'chore/tw-ledger', LOG = LEDGER_DIR + '/LOG.md';
  const marker = (k, role) => '=== end of B01 R' + k + ' ' + role + ' findings ===';
  const entry = (bytes, k, role) => bytes + '\n' + marker(k, role) + '\n';
  // The findings files, one case each, written here as prose under their own headings.
  const R1 = '### B01 R1 reviewer findings\nFIX FIRST\n1. P1 — a finding; this last line carries no newline';
  const H1 = '### B01 R1 test-hunter findings\nFINDINGS 3\n## Validation commands\n# a comment inside a quoted script\n### A heading quoted from a batch file\n';
  const R2 = '### B01 R2 reviewer findings\nSHIP\nP0=0 P1=0 ASK=0\n';
  const R3 = '### B01 R3 reviewer findings\nSHIP\n';
  // Entries that each reach one refusal alone: no marker (R4); an old markerless entry under
  // the heading a new one reuses (R5, only the heading count refuses it); a marker ahead of its
  // heading (R6, only the order check); a body quoting its own marker line (R7, only the marker count).
  const R4 = '### B01 R4 reviewer findings\nSHIP\n';
  const R5_OLD = '### B01 R5 reviewer findings\nOLD\n', R5 = '### B01 R5 reviewer findings\nNEW\n';
  const R6 = '### B01 R6 reviewer findings\nSHIP\n';
  const R7 = '### B01 R7 reviewer findings\nThe append closes each entry with a line such as\n' + marker('7', 'reviewer') + '\nwhich this report quotes.\n';
  for (const [name, bytes] of [['r1.md', R1], ['h1.md', H1], ['r2.md', R2], ['r3.md', R3], ['r5.md', R5], ['r7.md', R7]]) fs.writeFileSync(file(name), bytes);
  // Twice: LOG.md checked out LF, and CRLF under core.autocrlf=true, as this machine checks it out.
  for (const crlf of [false, true]) {
    const repo = makeRepo(t), env = bashEnv(repo.env), label = crlf ? 'CRLF checkout: ' : 'LF checkout: ';
    const bash = command => {
      const script = path.join(temp, 'step.sh');
      fs.writeFileSync(script, command + '\n');
      const r = spawnSync(GIT_BASH, [slash(script)], { cwd: repo.cwd, env, encoding: 'utf8', windowsHide: true, timeout: 60000 });
      assert.ifError(r.error); assert.equal(r.signal, null);
      return r;
    };
    const commit = message => { repo.git('-c', 'core.autocrlf=' + crlf, 'add', '--all'); repo.git('commit', '-m', message); };
    repo.git('switch', '-c', BRANCH);
    const base = '# Log — ' + LEDGER_ID + '\n\n## 2026-09-23 — session\n\n### B01\n\nThe row\'s own narrative.\n';
    repo.write(LOG, crlf ? base.replace(/\n/g, '\r\n') : base); commit('ledger');
    const append = (k, role, name) => {
      const r = bash(filledCommand(published.append, { '<findings file>': file(name), '<NN>': '01', '<k>': k, '<role>': role, '<ledger-dir>': LEDGER_DIR }));
      assert.equal(r.status, 0, label + 'append ' + name + ': ' + r.stderr);
    };
    const raw = bytes => fs.appendFileSync(path.join(repo.cwd, ...LOG.split('/')), bytes);   // not the published append
    append('1', 'reviewer', 'r1.md'); append('1', 'test-hunter', 'h1.md'); append('2', 'reviewer', 'r2.md');
    append('3', 'reviewer', 'r3.md'); append('3', 'reviewer', 'r3.md');   // one round's file appended twice
    raw(R4); raw(R5_OLD); append('5', 'reviewer', 'r5.md'); raw(marker('6', 'reviewer') + '\n' + R6); append('7', 'reviewer', 'r7.md');
    // A findings file that does not exist: a non-zero exit, and LOG.md's bytes untouched — no lone marker.
    const logPath = path.join(repo.cwd, ...LOG.split('/')), before = fs.readFileSync(logPath);
    const missing = bash(filledCommand(published.append, { '<findings file>': file('missing.md'), '<NN>': '01', '<k>': '8', '<role>': 'reviewer', '<ledger-dir>': LEDGER_DIR }));
    assert.notEqual(missing.status, 0, label + 'appending a findings file that does not exist must exit non-zero');
    assert.ok(fs.readFileSync(logPath).equals(before), label + 'appending a findings file that does not exist must leave LOG.md as it was');
    commit('findings');
    // Each file, a newline and its marker, in the committed LOG.md: no heading glued to a last line.
    const shown = spawnSync('git', ['show', BRANCH + ':./' + LOG], { cwd: repo.cwd, env: repo.env, encoding: 'utf8', windowsHide: true });
    assert.equal(shown.stdout, base + entry(R1, '1', 'reviewer') + entry(H1, '1', 'test-hunter') + entry(R2, '2', 'reviewer')
      + entry(R3, '3', 'reviewer') + entry(R3, '3', 'reviewer') + R4 + R5_OLD + entry(R5, '5', 'reviewer')
      + marker('6', 'reviewer') + '\n' + R6 + entry(R7, '7', 'reviewer'), label + 'the committed LOG.md');
    const recover = (k, role, out) => bash(filledCommand(published.recover,
      { '<integration-branch>': BRANCH, '<ledger-dir>': LEDGER_DIR, '<NN>': '01', '<k>': k, '<role>': role, '<findings file>': out }));
    // Heading-shaped lines, no final newline, and a clean control: each comes back byte-for-byte,
    // onto a target an earlier attempt left full of other bytes.
    const back = {};
    for (const [k, role, bytes] of [['1', 'reviewer', R1], ['1', 'test-hunter', H1], ['2', 'reviewer', R2]]) {
      const out = back[role + k] = slash(path.join(temp, (crlf ? 'crlf' : 'lf') + ' recovered R' + k + ' ' + role + '.md'));
      fs.writeFileSync(out, 'stale bytes an earlier attempt left here\n'.repeat(3));
      const r = recover(k, role, out);
      assert.equal(r.status, 0, label + 'R' + k + ' ' + role + ': ' + r.stderr);
      assert.equal(fs.readFileSync(out, 'utf8'), bytes, label + 'R' + k + ' ' + role + ' must come back byte-for-byte');
      assert.equal(fs.statSync(out).size, Buffer.byteLength(bytes), label + 'R' + k + ' ' + role + ': the byte count');
    }
    // Every refusal: a non-zero exit and nothing written — and an existing file left as it was.
    for (const [k, why] of [['9', 'a heading that matches nothing'], ['3', 'a heading and marker that occur twice'], ['4', 'a heading with no marker line'],
      ['5', 'a heading an older markerless entry also carries'], ['6', 'a marker line ahead of its heading'], ['7', 'a body quoting its own marker line']]) {
      const out = slash(path.join(temp, (crlf ? 'crlf' : 'lf') + ' refused R' + k + '.md'));
      assert.notEqual(recover(k, 'reviewer', out).status, 0, label + why + ': must exit non-zero');
      assert.equal(fs.existsSync(out), false, label + why + ': must write nothing');
    }
    const kept = slash(path.join(temp, (crlf ? 'crlf' : 'lf') + ' kept.md'));
    fs.writeFileSync(kept, 'kept');
    assert.notEqual(recover('9', 'reviewer', kept).status, 0);
    assert.equal(fs.readFileSync(kept, 'utf8'), 'kept', label + 'a refusal must leave an existing file as it was');
    // The join of two recovered files: a newline between them, so the second heading starts a
    // line, onto a target left full of other bytes; and a reviewer file that does not exist fails it.
    const joined = slash(path.join(temp, (crlf ? 'crlf' : 'lf') + ' joined.md'));
    fs.writeFileSync(joined, 'stale bytes an earlier join left here\n'.repeat(3));
    const j = bash(filledCommand(published.join, { '<reviewer file>': back.reviewer1, '<gate file>': back['test-hunter1'], '<joined file>': joined }));
    assert.equal(j.status, 0, label + 'join: ' + j.stderr);
    assert.equal(fs.readFileSync(joined, 'utf8'), R1 + '\n' + H1, label + 'the joined file');
    const unjoined = bash(filledCommand(published.join, { '<reviewer file>': file('missing.md'), '<gate file>': back['test-hunter1'],
      '<joined file>': slash(path.join(temp, (crlf ? 'crlf' : 'lf') + ' joined without a reviewer file.md')) }));
    assert.notEqual(unjoined.status, 0, label + 'joining a reviewer file that does not exist must exit non-zero');
    if (crlf) continue;
    // Control: round 2's recovery, run on the same LOG.md, truncates at the `## ` line and
    // exits 0 with an empty file on a heading that matches nothing — what these cases must see.
    const old = (k, role, out) => bash(filledCommand(ROUND2_RECOVER,
      { '<integration-branch>': BRANCH, '<ledger-dir>': LEDGER_DIR, '<NN>': '01', '<k>': k, '<role>': role, '<findings file>': out }));
    const truncated = slash(path.join(temp, 'round-2 R1 test-hunter.md')), empty = slash(path.join(temp, 'round-2 R9.md'));
    assert.equal(old('1', 'test-hunter', truncated).status, 0);
    assert.equal(fs.readFileSync(truncated, 'utf8'), '### B01 R1 test-hunter findings\nFINDINGS 3\n', 'the control must reproduce round 2\'s truncation');
    assert.equal(old('9', 'reviewer', empty).status, 0);
    assert.equal(fs.readFileSync(empty, 'utf8'), '', 'the control must reproduce round 2\'s silent empty file');
  }
});

// ===== One published LOG.md command per job, wherever a document states one ============
// A fix in one reader left stale in a sibling: every code span — or fenced line — in a shipped
// document or agent definition that names a findings, reviewer, gate or joined file, or pipes
// or appends LOG.md, must be the append, the recovery or the join §Spawning rules publishes,
// the template's placeholders read as the reference's. Counted per file, so a further copy,
// even a right one, is a deliberate edit here.
const LOG_COMMAND_COUNTS = { 'orchestrate/references/protocol.md': 2, 'orchestrate/references/subagent-prompts.md': 3 };
// Code spans as Markdown reads them: a run of n backticks opens one and only a run of exactly n
// closes it, inside one paragraph — so the preamble's ```` ```prompt:<name> ```` shifts no pairing.
function codeSpans(paragraph) {
  const spans = [], runs = [...paragraph.matchAll(/`+/g)];
  for (let i = 0; i < runs.length; i++) {
    const j = runs.findIndex((run, k) => k > i && run[0].length === runs[i][0].length);
    if (j === -1) continue;
    spans.push(paragraph.slice(runs[i].index + runs[i][0].length, runs[j].index));
    i = j;
  }
  return spans;
}
function logCommandSpans(text) {
  const prose = [], fenced = [];
  let open = false;
  for (const line of LOG_PLACEHOLDERS(text).split('\n')) {
    if (line.startsWith('```')) { open = !open; prose.push(''); }
    else (open ? fenced : prose).push(line);
  }
  const spans = prose.join('\n').split(/\n[ \t]*\n/).flatMap(paragraph => codeSpans(collapse(paragraph)));
  return [...spans.map(span => span.trim()), ...fenced.map(line => line.trim())]
    .filter(span => /<(?:findings|reviewer|gate|joined) file>/.test(span) || /LOG\.md\s*\|/.test(span) || />>\s*\S*LOG\.md/.test(span));
}
test('every LOG.md command a document states is the published one, counted per file', () => {
  const published = logCommands(PROMPTS), commands = [published.append, published.recover, published.join];
  assert.ok(commands.every(Boolean), 'subagent-prompts.md publishes the append, the recovery and the join');
  // The span reader pairs backtick runs by length: an odd count of backticks earlier in a paragraph shifts nothing after it.
  assert.deepEqual(codeSpans('the blocks opening ```` ```prompt:<name> ```` are rendered by `a` and `b`'), [' ```prompt:<name> ', 'a', 'b']);
  // Controls: round 2's recovery and join, the pre-marker append, and a fenced pipe are each found, and none is published.
  for (const planted of ['`' + ROUND2_RECOVER + '`', '`cat -- "<reviewer file>" "<gate file>" > "<joined file>"`',
    '`cat -- "<findings file>" >> {{LEDGER_DIR}}/LOG.md`', '```text\ngit show <integration-branch>:./<ledger-dir>/LOG.md | tail -5\n```']) {
    const spans = logCommandSpans('Prose before.\n' + planted + '\nProse after.');
    assert.equal(spans.length, 1, 'the scan must find: ' + planted);
    assert.ok(!commands.includes(spans[0]), 'and it is not a published command: ' + planted);
  }
  const counts = {};
  for (const file of [...documents(), ...agentDefinitions()]) {
    const spans = logCommandSpans(read(file));
    for (const span of spans) assert.ok(commands.includes(span), file + ': a LOG.md command that is not the published one — ' + span);
    if (spans.length) counts[file] = spans.length;
  }
  assert.deepEqual(counts, LOG_COMMAND_COUNTS, 'the LOG.md commands each document states, counted');
});

// ===== Conductor and agent budget rules (B03 of OS-20260925) ===========================
// Each rule is pinned as whole text in every carrier the batch enumerated, as PINNED is above,
// and each rule's key word is bound to those carriers across the whole document domain: a
// mention anywhere else is a finding, so a contradicting directive cannot sit in a file the pins
// never read. The control run dropped the per-role effort rule; the reviewer's max pin (2026-09-27)
// and the census's and the test hunter's medium pins (2026-10-13, 2026-10-25) are its exceptions,
// held at EFFORT_LINES and tierKeyFaults.
const NO_POLL = 'The orchestrator never polls: it never calls `ReadNotifications` to wait for a sub-agent and never sleeps; when the only remaining work waits on sub-agents it ends the turn, and the task notification resumes it.';
const BUDGET = {
  pollSkill: ['orchestrate/SKILL.md', '- The orchestrator never polls', '\n- No `--no-verify`', '- ' + NO_POLL],
  pollProtocol: ['orchestrate/references/protocol.md', 'The orchestrator never polls', '\n- **Implementer**', NO_POLL],
  cadence: ['orchestrate/SKILL.md', '- Default session cadence', '\n- The orchestrator never polls',
    '- Default session cadence: run autonomously to the next checkpoint — waves in sequence, no stopping between batches — halting early only at ⛔ or an unplanned user gate, or pausing at a safe point for context (protocol.md §Session algorithm step 8).'],
  compaction: ['orchestrate/references/protocol.md', 'Compaction happens only at a safe point', '\n\n**Session practices**',
    "Compaction happens only at a safe point, never mid-flight: a wave close, the start of a checkpoint close-out, or the moment a checkpoint's fix-ups have all merged, before their rows go back to 🧪 and the re-issue (never after a capped fix-up's *ship*: its row still reads as awaiting a verdict) — each counting only once PROGRESS and LOG are committed and no agent is in flight. "
    // Which rules cover the mod's clear and `/compact` both, and which the clear alone (C1 of OS-20261022); the clear
    // before a checkpoint's close-out, which the checkpoint's STOP never stands in for (BL-100); the tool at every safe
    // point; a session the mod opened booting as its contract's §Boot sequence says (BL-101); `not needed` carrying on;
    // a `declined` naming a `waiting` agent retried once that agent is stopped by its own id (BL-097); and only a
    // decline with no retry left, or no tool, reading the context against the contract's threshold, an unknown size or
    // threshold never below it (BL-099).
    + "The compaction rules of this step cover both orchestrate-mod's automatic clear and `/compact`; those about the mod's tool, its answers and the session a clear opens apply only to the clear. "
    + "At a wave close where the checkpoint table places a checkpoint, the compaction window below opens before the close-out's first step, so a conversation cleared there leaves the whole close-out to the fresh one, and the checkpoint's STOP, which comes after the close-out, never stands in for that window. "
    + "When this session's tools include `mcp__orchestrate-mod__schedule_clear` (orchestrate-mod's), the orchestrator calls it at every safe point, whatever its context size, with the ledger id and the integration tip's full SHA, once no background command of its own is running either and a committed PROGRESS session-log row names the LOG heading that records the work since the row before it. "
    + 'An answer that begins `scheduled` gives the one line to post: the orchestrator posts it and ends its turn, and the mod clears the conversation two minutes later unless a message arrives first, then runs `/orchestrate continue <id> after-clear`; a mod that finds it cannot clear runs `/orchestrate continue <id> in-place <reason>` in this conversation instead, `<reason>` naming what stopped the clear. That conversation still holds the run: when it sees its own call for that ledger and the integration tip is still the SHA it passed, it posts one line naming the reason and carries on with the step it would take next, with no boot, reconcile or validation; a tip that moved, or a call it no longer sees, has it boot as any `continue` does. '
    + 'A conversation that goes on after a `scheduled` answer, because a message or a notice arrived first, is not cleared and carries on. '
    + "After an automatic clear, the session that `/orchestrate continue <id> after-clear` opened follows the boot its contract's §Boot sequence gives such a session; under a contract that gives none, it boots as any `continue` does. "
    + 'Its first message to the user opens with one line saying it continued after an automatic clear and naming the LOG heading that the newest session-log row names. '
    + "It ignores a task notice for a task it did not start, whose output file sits under another session's folder. "
    + "An answer that begins `not needed` (the context is under the ledger's clear threshold) has the orchestrator carry on at once, with no line and no timer. "
    + "A `declined` answer that names an agent `waiting` (returned its report; a command of its own still runs), whose report is in while the ledger awaits nothing from that command, has the orchestrator stop that agent with TaskStop on the agent's id — it ends `killed` with its shell and runs no turn, where TaskStop on the shell's id would resume it for one more turn whose report lands in whatever conversation is current — and then call the tool once more. "
    + "If the answer is `declined` and no such retry applies, or the retry's answer is `declined` too, or the answer begins as none of those three, or there is no such tool, the orchestrator takes the timer path: it first reads its own context size as `scaffolding.md` §Preconditions step 5 reads it and compares it with the contract's `**Clear threshold**` line (300K for a contract without one), carrying on as at `not needed` when the size is under it. "
    + "An unknown context size or an unreadable threshold, the mod's decline saying the ledger's Clear threshold line cannot be read included, is never treated as below the threshold. "
    + 'At or past the threshold, or when either cannot be read, the orchestrator posts ONE line: its context size, the time it will continue, and the answers: `/compact` now (then wait for the timer, or say `continue`), or `go`. '
    + "It then starts a 10-minute timer, a background Bash `sleep 600`, and ends its turn; the first of the timer's completion notice, `go` or `continue` resumes it, and it ignores whatever arrives later. "
    + "That notice shows the task's description, not its output, so the description carries the reminder, verbatim: `Compaction window over: if this session was compacted, run the boot sequence and the reconcile before any transition`. "
    + 'A compacted session is resumed early only through `continue`, which starts this algorithm at step 1. '
    + 'A STOP that already waits for the user (⛔ verdicts, checkpoints), at or past the threshold, or when the size or the threshold cannot be read, carries the context size and `/compact` now in its message instead of a timer. '
    + 'After any compaction, an automatic one included, the boot sequence and the reconcile run before any transition, because a summary is a claim, not truth; a merge, push or third-round authorization that exists only in a summary is re-asked.'],
  practices: ['orchestrate/references/protocol.md', '**Session practices**', '\n\n**User gates are front-loaded**',
    '**Session practices** (guidance, not tooled). An investigation unrelated to the change, such as a CI failure met while scaffolding, runs in its own session. A pause of over an hour expires the prompt cache, and the first call after it writes the whole context to the cache again.'],
  // Wave mechanics step 5 whole: the window before a checkpoint's close-out (BL-100), as step 8 orders it, and before the next wave.
  nextWave: ['orchestrate/references/execution-models.md', '5. **Checkpoint or continue**', '\n\n**Every `continue`',
    "5. **Checkpoint or continue**: if the checkpoint table places a checkpoint here → protocol.md §Session algorithm step 8's compaction window first, then the per-checkpoint close-out (at the FINAL checkpoint, the run-end prose sweep first whenever LOG.md holds a `### prose sweep:` heading; tip validation, QA-runner pre-smoke of the agent-tagged steps with `evidence/C<n>/`, covered rows 🟢 → 🧪, `**State**: AT-CHECKPOINT`), STOP with the combined smoke script, delivered as the smoke page (`smoke-page.md`). "
    + 'Otherwise → open the next wave immediately, same session, unless protocol.md §Session algorithm step 8 first opens its compaction window at this safe point.'],
  exploreSkill: ['orchestrate/SKILL.md', 'plan the batches (explore', '; batch',
    'plan the batches (explore, at medium thoroughness by default and "very thorough" only when the interview needs an inventory and the prompt names what it is for'],
  exploreScaffold: ['orchestrate/references/scaffolding.md', '3. **Plan** — explore the codebase', ', draft the batch table',
    '3. **Plan** — explore the codebase (sub-agents as needed, at medium thoroughness by default; "very thorough" only when the interview needs an inventory and the prompt names what it is for)'],
  effort: ['orchestrate/references/scaffolding.md', '4. **Effort.**', '\n5. **Context.**',
    '4. **Effort.** A session running at max effort → before scaffolding, ask the user to set it to high, with the reason in one sentence: at max, one measured scaffold spent 54% of its output on thinking. Never change the setting yourself.'],
  context: ['orchestrate/references/scaffolding.md', '5. **Context.**', '\n\n## Procedure',
    "5. **Context.** A `new` that arrives after other work in this conversation → first read this session's context size: the input, cache-read and cache-creation tokens summed in the newest `usage` entry of its transcript that is not all zeros (an API error logs one that is), the transcript being `<session id>.jsonl` in a subdirectory of the `.claude/projects/` directory of the user's home (`CLAUDE_CODE_SESSION_ID` holds the id). "
    + 'Past about 200K, or when the size cannot be read, offer to scaffold in a fresh conversation, with the reason in one sentence: a scaffold adds about 500–800K by itself, and a conversation summarized automatically mid-scaffold loses the work in flight. '
    + 'On a yes, write the request verbatim, and whatever this conversation established that the scaffold needs, into a note under the session scratchpad, never the repository; once nothing this conversation started still runs in the background, the user runs `/clear`, then `/orchestrate new` naming the note. '
    + 'Never clear the conversation yourself.'],
  // The registry row that names the mod's `not needed` answer beside step 8, held as PINNED_ROWS holds it.
  clearThresholdRow: ['orchestrate/references/scaffolding.md', '| `{{CLEAR_THRESHOLD}}` |', '\n', PINNED_ROWS.CLEAR_THRESHOLD],
};
test('each budget rule reads exactly as pinned in every carrier the batch enumerated, the compaction rule at wave close', () => {
  const pinned = (text, from, to) => collapse(section(text, from, to)).trim();
  assert.equal(Object.keys(BUDGET).length, 11, 'eleven passages are pinned; the list may not shrink to a sample');
  for (const [key, [file, from, to, expected]] of Object.entries(BUDGET)) {
    const text = read(file);
    assert.equal(text.split(from).length - 1, 1, key + ': the anchor "' + from + '" must occur exactly once in ' + file);
    assert.equal(pinned(text, from, to), expected, file + ' (' + key + '): the pinned passage changed; update BUDGET only on purpose');
    assert.notEqual(pinned(text.replace(from, from + ' Skip it when in a hurry.'), from, to), expected, key + ': a planted sentence must redden the pin');
  }
  // One rule, one wording, once in each of its two carriers.
  for (const file of ['orchestrate/SKILL.md', 'orchestrate/references/protocol.md']) {
    assert.equal(collapse(read(file)).split(NO_POLL).length - 1, 1, file + ': states the no-polling rule once, verbatim');
  }
  // Wave close is step 8, the session algorithm's last step; the compaction rule sits inside it.
  const protocol = read('orchestrate/references/protocol.md');
  const s0 = protocol.indexOf('\n8. Wave closed.', protocol.indexOf('## §Session algorithm')), s1 = protocol.indexOf('\n\n', s0 + 1);
  assert.ok(s0 > protocol.indexOf('## §Session algorithm') && !/\n9\. /.test(section(protocol, '\n8. Wave closed.', '\n## Two distinct close-outs')),
    'step 8 is the wave close and the last step of §Session algorithm');
  const c0 = protocol.indexOf(BUDGET.compaction[1]), c1 = protocol.indexOf(BUDGET.compaction[2], c0);
  assert.ok(s0 < c0 && c1 <= s1, 'the compaction rule must sit inside step 8, the wave close');
});

// The compaction window's three safe points, the user's list, and the sentence naming them, pinned
// whole from its head here as well as inside BUDGET.compaction, with the passage's mentions of a
// safe point counted. Reported by this test alone: a point lost or qualified, a fourth added to that
// sentence, and a fourth anywhere in the passage that calls itself a safe point; a point lost is
// reported by name even with the sentence re-pinned. A fourth elsewhere in the passage that never
// says "safe point" is BUDGET.compaction's to report. Outside the passage the term is bound by
// BOUND_WORDS.
const SAFE_POINTS = ['a wave close', 'the start of a checkpoint close-out',
  "the moment a checkpoint's fix-ups have all merged, before their rows go back to 🧪 and the re-issue (never after a capped fix-up's *ship*: its row still reads as awaiting a verdict)"];
const SAFE_POINT_CLAUSE = "Compaction happens only at a safe point, never mid-flight: a wave close, the start of a checkpoint close-out, or the moment a checkpoint's fix-ups have all merged, "
  + "before their rows go back to 🧪 and the re-issue (never after a capped fix-up's *ship*: its row still reads as awaiting a verdict) — each counting only once PROGRESS and LOG are committed and no agent is in flight.";
// A mention of a safe point however it is spelled: spaced, hyphenated, closed up, as an identifier,
// or wrapped across a line and a code comment's slashes (BL-063). safePointFaults counts this one
// family and BOUND_WORDS binds it, so the two cannot read different spellings.
const SAFE_POINT_WORD = /safe[\W_]*points?/i;
// The passage names "a safe point" twice: in the pinned sentence, and where the tool is called at every one.
const SAFE_POINT_MENTIONS = 2;
// Each safe point the passage's sentence no longer names, the sentence itself unless it reads as
// pinned, and the passage's count of safe-point mentions unless it is SAFE_POINT_MENTIONS.
function safePointFaults(passage, pinned = SAFE_POINT_CLAUSE) {
  const text = collapse(passage), from = 'Compaction happens', to = 'no agent is in flight.';
  const start = text.indexOf(from), end = text.indexOf(to, start + 1);
  if (start === -1 || end === -1) return ['no safe-point clause from "' + from + '" to "' + to + '"'];
  const clause = text.slice(start, end + to.length), mentions = (text.match(new RegExp(SAFE_POINT_WORD.source, 'gi')) || []).length;
  return [...SAFE_POINTS.filter(point => !clause.includes(point)).map(point => 'unnamed: ' + point), ...(clause === pinned ? [] : ['changed: ' + clause]),
    ...(mentions === SAFE_POINT_MENTIONS ? [] : [mentions + ' mentions of a safe point, not ' + SAFE_POINT_MENTIONS])];
}
test('the compaction window names all three safe points and no other, and losing, qualifying or adding one is reported', () => {
  assert.equal(new Set(SAFE_POINTS).size, 3, 'three safe points; the list may not shrink to a sample');
  // The lists it replaced: the first two names lie inside their successors. The third is no superset
  // of its first form: the user moved it before the 🧪 flip, then excluded a capped fix-up's ship
  // from it (2026-09-27). Each third name is the one before it with exactly that qualifier inserted,
  // then that exclusion appended, so every earlier word is still required, in order.
  const earlier = ['a wave close', 'the start of a checkpoint close-out', "the moment a checkpoint's fix-ups have all merged, before the re-issue"];
  const moved = "the moment a checkpoint's fix-ups have all merged, before their rows go back to 🧪 and the re-issue";
  assert.ok(SAFE_POINTS[0].includes(earlier[0]) && SAFE_POINTS[1].includes(earlier[1]), 'the first two names are kept');
  assert.equal(moved.replace('their rows go back to 🧪 and ', () => ''), earlier[2], 'moved: the first third name with the 🧪 qualifier inserted');
  assert.equal(SAFE_POINTS[2], moved + " (never after a capped fix-up's *ship*: its row still reads as awaiting a verdict)", 'the third: the moved name with the capped-ship exclusion appended');
  assert.ok(SAFE_POINTS.every(point => SAFE_POINT_CLAUSE.split(point).length === 2), 'the pinned clause names each safe point once');
  const [file, from, to] = BUDGET.compaction, passage = collapse(section(read(file), from, to));
  assert.deepEqual(safePointFaults(passage), [], file + ': the compaction window must name exactly its safe points');
  // Live controls: each safe point lost on its own, the other two kept, is reported by name, and
  // still is with the clause re-pinned to match.
  for (const point of SAFE_POINTS) {
    const lost = passage.split(point).join('…');
    assert.notEqual(lost, passage, 'the control must find: ' + point);
    assert.deepEqual(safePointFaults(lost).filter(f => f.startsWith('unnamed: ')), ['unnamed: ' + point], 'losing it must be reported: ' + point);
    assert.deepEqual(safePointFaults(lost, SAFE_POINT_CLAUSE.split(point).join('…')), ['unnamed: ' + point], 'even re-pinned: ' + point);
  }
  // A qualifier planted on a safe point, or a fourth point, keeps every name: the clause pin reports
  // it, at the sentence's head as anywhere after it.
  for (const [find, planted] of [['never mid-flight: a wave close', 'never mid-flight: around a wave close'],
    ['or the moment a checkpoint', 'or before the moment a checkpoint'], ['never mid-flight: a wave close', 'never mid-flight: mid-wave, a wave close'],
    ['at a safe point, never mid-flight:', 'at a safe point or mid-wave, never mid-flight:'], ['at a safe point, never mid-flight:', 'at a safe point, ideally never mid-flight:']]) {
    const changed = passage.replace(find, () => planted), faults = safePointFaults(changed);
    assert.notEqual(changed, passage, 'the control must find: ' + find);
    assert.equal(faults.length, 1, planted + ': reported once — ' + faults.join(' | '));
    assert.ok(faults[0].startsWith('changed: '), planted + ': as a changed clause, every name kept');
  }
  // The capped-ship exclusion belongs to the third name: dropping it is reported by that name, even
  // with the sentence re-pinned without it.
  const exclusion = " (never after a capped fix-up's *ship*: its row still reads as awaiting a verdict)";
  const unexcluded = passage.replace(exclusion, () => '');
  assert.notEqual(unexcluded, passage, 'the control must find the exclusion');
  assert.deepEqual(safePointFaults(unexcluded, SAFE_POINT_CLAUSE.replace(exclusion, () => '')), ['unnamed: ' + SAFE_POINTS[2]], 'dropping the exclusion must be reported');
  // The family is a superset of both forms it replaced (BL-063): every UTF-16 code unit the old count
  // or the old bound word read between "safe" and "point", alone or doubled, in lower, capitalised or
  // upper case, still reads; and it stays case-insensitive and stateless, as both were.
  assert.equal(SAFE_POINT_WORD.flags, 'i', 'the safe-point family reads any case and keeps no lastIndex');
  const lost = [];
  for (let unit = 0; unit <= 0xFFFF; unit++) {
    const between = String.fromCharCode(unit);
    for (const [safe, point] of [['safe', 'point'], ['Safe', 'Point'], ['SAFE', 'POINT']]) {
      for (const word of [safe + between + point, safe + between + between + point]) {
        if ([/safe[- ]points?/i, /safe[\s-]+points?/i].some(old => old.test(word)) && !SAFE_POINT_WORD.test(word)) lost.push(word);
      }
    }
  }
  assert.deepEqual(lost, [], 'the safe-point family must read every separator the forms it replaced read');
  // A fourth point in a sentence of its own that calls itself a safe point leaves the clause as
  // pinned: the mention count reports it, however the mention is spelled, and one mention fewer (the
  // tool called at any point).
  for (const spelling of ['safe point', 'Safe point', 'safe-point', 'safepoint', 'safe_point', 'safe\n  // point']) {
    const fourth = passage.replace('no agent is in flight. ', () => 'no agent is in flight. Mid-wave, between two merges, is a ' + spelling + ' too. ');
    assert.notEqual(fourth, passage, 'the control must find the end of the clause');
    assert.deepEqual(safePointFaults(fourth), [(SAFE_POINT_MENTIONS + 1) + ' mentions of a safe point, not ' + SAFE_POINT_MENTIONS], JSON.stringify(spelling));
  }
  const fewer = passage.replace('calls it at every safe point', () => 'calls it at every point');
  assert.notEqual(fewer, passage, 'the control must find the mention where the tool is called');
  assert.deepEqual(safePointFaults(fewer), [(SAFE_POINT_MENTIONS - 1) + ' mentions of a safe point, not ' + SAFE_POINT_MENTIONS]);
  // A clause that lost its opening or closing words is reported as not found, never read from a stray slice.
  for (const [find, planted] of [['Compaction happens', 'Compaction occurs'], ['no agent is in flight.', 'no agent runs.']]) {
    assert.deepEqual(safePointFaults(passage.replace(find, () => planted)), ['no safe-point clause from "Compaction happens" to "no agent is in flight."'], planted);
  }
});

// Every match of `pattern` in `text` that none of `file`'s allowed passages contains.
function strayMentions(file, text, pattern, allowed) {
  const ranges = allowed.map(key => BUDGET[key]).filter(([f]) => f === file).map(([, from, to]) => {
    const start = text.indexOf(from), end = text.indexOf(to, start + 1);
    assert.ok(start !== -1 && end > start, file + ': passage bounds must resolve: ' + from + ' .. ' + to);
    return [start, end];
  });
  return [...text.matchAll(new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, '') + 'g'))]
    .filter(m => !ranges.some(([s, e]) => m.index >= s && m.index + m[0].length <= e))
    .map(m => file + ': …' + collapse(text.slice(Math.max(0, m.index - 50), m.index + m[0].length + 50)) + '…');
}
// Two copies of `text`, `mention` planted in one just before BUDGET[key]'s `from` anchor and in the
// other just after its `to` anchor, so both ends of the passage are armed (BL-063).
function plantedAround(key, text, mention) {
  const [, from, to] = BUDGET[key], start = text.indexOf(from), after = text.indexOf(to, start + 1) + to.length;
  assert.ok(start !== -1 && after > start + to.length, key + ': passage bounds must resolve: ' + from + ' .. ' + to);
  return [text.replace(from, () => 'Planted ' + mention + ' here.\n' + from), text.slice(0, after) + ' Planted ' + mention + ' here.' + text.slice(after)];
}
// Where conductor directives live: the Markdown under orchestrate/ plus README (B03 R1). Code and
// the page template use "effort", "explore", "poll" and "sleep" as ordinary words — a
// "best-effort" comment directs no one — so those families read only this domain. The rarer
// ReadNotifications, compact, safe point and thorough stay bound across the whole tree, code included, as do the
// scaffold context check's session variable and threshold, which only its precondition names.
const proseDocuments = () => documents().filter(f => f.endsWith('.md'));
const BOUND_WORDS = [
  ['the no-polling rule', /ReadNotifications/, ['pollSkill', 'pollProtocol'], 'tree'],
  ['the compaction rule', /compact/i, ['compaction', 'nextWave'], 'tree'],
  ["the compaction window's safe points", SAFE_POINT_WORD, ['cadence', 'compaction', 'nextWave'], 'tree'],
  ['the Explore thoroughness default', /thorough/i, ['exploreSkill', 'exploreScaffold'], 'tree'],
  ['the scaffold context check', /CLAUDE_CODE_SESSION_ID|\b200K\b/i, ['context'], 'tree'],
  ['a fact-finding carrier', /\bexplor(?:e|es|ed|ing)\b/i, ['exploreSkill', 'exploreScaffold'], 'prose'],
  ['the scaffold effort ask', /\beffort\b/i, ['effort'], 'prose'],
  // Step 8's retry of a decline naming a `waiting` agent (BL-097) and its `not needed` answer (BL-099), however
  // spelled or wrapped. README's side is tests/readme-mods.test.cjs KEY_WORDS, so these read the shipped tree alone.
  // reconcile.mjs's header value `shipment=not-needed` and its default `'not-needed'` are another word: the row's fifth
  // field passes those two literals, in that file and as written, and nothing else.
  ['the TaskStop retry', /\btask[\W_]*stop/i, ['compaction'], 'skill'],
  ['the not needed answer', /\bnot[\W_]*needed\b/i, ['compaction', 'clearThresholdRow'], 'skill',
    { 'orchestrate/tools/reconcile.mjs': ['shipment=not-needed', "'not-needed'"] }],
];
// `text` with each literal `passed` names for `file` blanked, and a fault for each of them not found there once.
function passLiterals(file, text, passed = {}) {
  const faults = [];
  for (const literal of passed[file] || []) {
    if (text.split(literal).length !== 2) faults.push(file + ': the passed literal ' + literal + ' is not found once');
    else text = text.replace(literal, () => ' '.repeat(literal.length));
  }
  return { text, faults };
}
test('each budget rule\'s key word appears nowhere but inside its pinned carriers', () => {
  const files = documents(), prose = proseDocuments();
  assert.ok(files.includes('README.md') && files.includes('orchestrate/references/scaffolding.md') && files.some(f => f.endsWith('.mjs')),
    'the domain is the whole shipped tree, code included, plus README');
  assert.ok(prose.includes('README.md') && prose.includes('orchestrate/references/protocol.md') && prose.length < files.length
    && prose.every(f => files.includes(f) && f.endsWith('.md')), 'the prose domain is every Markdown file of that tree, and README');
  assert.equal(new Set(BOUND_WORDS.map(b => b[0])).size, BOUND_WORDS.length);
  // The narrowings are exactly the two ordinary words, read in the prose domain alone, and the two clear-route words,
  // read in the shipped tree without README; widening back is free, narrowing more is an edit here.
  assert.deepEqual(BOUND_WORDS.filter(b => b[3] !== 'tree').map(b => [b[0], b[3]]),
    [['a fact-finding carrier', 'prose'], ['the scaffold effort ask', 'prose'], ['the TaskStop retry', 'skill'], ['the not needed answer', 'skill']],
    'only the explore and effort families read the prose domain alone, and only the TaskStop and not needed families the shipped tree alone');
  const skill = shipped();
  assert.ok(!skill.includes('README.md') && skill.every(f => files.includes(f)) && skill.length === files.length - 1, 'the skill domain is the whole shipped tree, README left out');
  assert.deepEqual(BOUND_WORDS.filter(b => b[4]).map(b => [b[0], Object.keys(b[4])]), [['the not needed answer', ['orchestrate/tools/reconcile.mjs']]],
    'only the not needed family passes literals, and only in reconcile.mjs');
  for (const [what, pattern, allowed, domain, passed] of BOUND_WORDS) {
    assert.ok(domain === 'tree' || domain === 'prose' || domain === 'skill', what + ': names its domain');
    const swept = domain === 'tree' ? files : domain === 'prose' ? prose : skill;
    const carriers = [...new Set(allowed.map(key => BUDGET[key][0]))].sort();
    assert.ok(carriers.every(c => swept.includes(c)), what + ': its domain must be a superset of its carriers');
    const mentioning = [], stray = [];
    for (const file of swept) {
      const { text, faults } = passLiterals(file, read(file), passed);
      if (pattern.test(text)) mentioning.push(file);
      stray.push(...faults, ...strayMentions(file, text, pattern, allowed));
    }
    assert.deepEqual(stray, [], what + ': a mention outside its pinned carriers states the rule again or contradicts it');
    assert.deepEqual(mentioning.sort(), carriers, what + ': exactly its enumerated carriers mention it');
    // Armed: in every carrier, one mention planted just outside the passage, before its start and
    // after its end, is reported.
    for (const key of allowed) {
      const [file] = BUDGET[key], text = read(file);
      for (const planted of plantedAround(key, text, pattern.exec(text)[0])) {
        assert.equal(strayMentions(file, planted, pattern, allowed).length, 1, what + ' (' + key + '): a planted stray mention must be reported');
      }
    }
  }
  // The two-word family reads its words however the Markdown or a code comment wraps them or a
  // writer spells them: split by a line break and its indentation, by two spaces, by a hyphen, by a
  // line break and a comment's slashes, closed up, as an identifier, or capitalised, just before and
  // just after each carrier (BL-063). It is the family safePointFaults counts.
  const [, safePoint, safeAllowed] = BOUND_WORDS.find(([what]) => what === "the compaction window's safe points");
  assert.equal(safePoint, SAFE_POINT_WORD, 'the bound family is the one safePointFaults counts');
  for (const key of safeAllowed) {
    const [file] = BUDGET[key], text = read(file);
    for (const split of ['safe\n   point', 'safe  point', 'safe-point', 'safe\n  // point', 'safepoint', 'safe_point', 'Safe point']) {
      for (const planted of plantedAround(key, text, 'a ' + split)) {
        assert.equal(strayMentions(file, planted, safePoint, safeAllowed).length, 1, key + ': a planted ' + JSON.stringify(split) + ' must be reported');
      }
    }
  }
  // The context check's family reads both of its words: each, planted just before (0) and just after (1) precondition 5,
  // is reported once. The four counts are collected and compared together, so a red shows every plant's (BL-077).
  const [, contextWord, contextAllowed] = BOUND_WORDS.find(([what]) => what === 'the scaffold context check');
  const [contextFile] = BUDGET.context, contextText = read(contextFile);
  const contextPlants = ['CLAUDE_CODE_SESSION_ID', '200K'].flatMap(word => plantedAround('context', contextText, word).map((planted, side) => [word, side, planted]));
  assert.deepEqual(contextPlants.map(([word, side, planted]) => [word, side, strayMentions(contextFile, planted, contextWord, contextAllowed).length]),
    contextPlants.map(([word, side]) => [word, side, 1]), 'context: each planted word must be reported once');
  // The two clear-route families read their words however spelled or wrapped, just before (0) and just after (1) the
  // compaction passage, and the not needed family just around its registry row. The counts are collected and compared
  // together.
  const family = what => BOUND_WORDS.find(([name]) => name === what);
  const routePlants = [['the TaskStop retry', 'compaction', ['TaskStop', 'Task Stop', 'task_stop', 'TASK-STOP']],
    ['the not needed answer', 'compaction', ['not needed', 'Not\n   needed', '`not needed`', 'not-needed', 'not_needed', 'Not-Needed', "'not needed'", "'not-needed'"]],
    ['the not needed answer', 'clearThresholdRow', ['not needed', 'not-needed']]]
    .flatMap(([what, key, spellings]) => spellings.flatMap(spelling => plantedAround(key, read(BUDGET[key][0]), spelling)
      .map((planted, side) => [what, key, spelling, side, strayMentions(BUDGET[key][0], planted, family(what)[1], family(what)[2]).length])));
  assert.deepEqual(routePlants, routePlants.map(([what, key, spelling, side]) => [what, key, spelling, side, 1]), 'each planted clear-route word must be reported once');
  // reconcile.mjs's two literals pass there alone, as written: planted in protocol.md they are reported, as is the answer
  // quoted after step 7 and in a tool's comment, reconcile.mjs's included, and a literal of reconcile.mjs reworded.
  const [, notNeeded, notNeededAllowed, , notNeededPassed] = family('the not needed answer');
  const RECONCILE = 'orchestrate/tools/reconcile.mjs', PROMPT_TOOL = 'orchestrate/tools/prompt.mjs', PROTOCOL = 'orchestrate/references/protocol.md';
  const STEP_7_END = 'tip → repair mini-batch before any further merge.', QUOTED = "// An answer of 'not needed' still starts the timer.";
  assert.equal(read(PROTOCOL).split(STEP_7_END).length, 2, 'the control anchor must be found once — ' + STEP_7_END);
  const notNeededCount = (file, text) => {
    const { text: blanked, faults } = passLiterals(file, text, notNeededPassed);
    return faults.length + strayMentions(file, blanked, notNeeded, notNeededAllowed).length;
  };
  const literalControls = [
    ['reconcile.mjs as it stands', RECONCILE, read(RECONCILE), 0],
    ["reconcile.mjs's two literals in protocol.md", PROTOCOL, read(PROTOCOL) + "\nshipment=not-needed\n${ctx.shipment ?? 'not-needed'}\n", 2],
    ['the answer quoted after step 7', PROTOCOL, read(PROTOCOL).replace(STEP_7_END, () => STEP_7_END + " An answer of 'not needed' still takes the line and the timer."), 1],
    ["the answer quoted in a tool's comment", PROMPT_TOOL, read(PROMPT_TOOL) + '\n' + QUOTED + '\n', 1],
    ["the answer quoted in reconcile.mjs's own comment", RECONCILE, read(RECONCILE) + '\n' + QUOTED + '\n', 1],
    ['a literal of reconcile.mjs reworded', RECONCILE, read(RECONCILE).replace('shipment=not-needed', () => 'shipment=not needed'), 2],
  ];
  assert.deepEqual(literalControls.map(([what, file, text]) => [what, notNeededCount(file, text)]), literalControls.map(([what, , , count]) => [what, count]),
    "only reconcile.mjs's two literals, in reconcile.mjs, are no mention");
});

// No polling, sleeping or notification calls while waiting: clause-level and negation-aware,
// through the undo sweep's reader. Code spans are read as their text, so the rule's own
// "never calls `ReadNotifications`" is governed by its negator like any other word.
const unticked = text => text.replace(/`([^`\n]*)`/g, '$1');
// Holding the turn on a sub-agent (B03 R1): a wait/check/look/watch verb, "until" and an agent
// noun in one clause, in any of the six orders, or the turn held rather than ended. The agent
// noun is required: the smoke page's own "A page update is waiting until you finish editing
// this note." directs no conductor. Verb forms only: "checklist" is not "check", nor is the noun
// in "fence check → … reviewer … → next wave, repeating until a checkpoint" (SKILL.md).
const AGENT_NOUN = String.raw`\b(?:implementers?|reviewers?|sub-agents?|agents?|waves?|test[- ]hunters?|QA runners?)\b`;
const WAIT_VERB = String.raw`(?:\b(?:wait|look|watch)(?:s|es|ed|ing)?\b|(?<!\b(?:fence|pin|skill|containment|mechanical|the|a|an|this|that|its|each|every|one)\s)\bcheck(?:s|ed|ing)?\b)`;
const UNTIL = String.raw`\buntil\b`;
const ANY_ORDER = [[WAIT_VERB, UNTIL, AGENT_NOUN], [WAIT_VERB, AGENT_NOUN, UNTIL], [UNTIL, WAIT_VERB, AGENT_NOUN],
  [UNTIL, AGENT_NOUN, WAIT_VERB], [AGENT_NOUN, WAIT_VERB, UNTIL], [AGENT_NOUN, UNTIL, WAIT_VERB]].map(order => order.join('[^.;:]*'));
const TURN = String.raw`\s+(?:the|a|its|your)\s+turn\b`;
const HOLD_TURN = new RegExp([...ANY_ORDER, String.raw`\b(?:before|instead of|rather than)\s+end(?:s|ing)?` + TURN,
  String.raw`\b(?:hold|keep)(?:s|ing)?` + TURN, String.raw`\b(?:never|not|don['’]t)\s+end(?:s|ing)?` + TURN].join('|'), 'i');
const PAGE_WAITING = 'A page update is waiting until you finish editing this note.';
const POLL = [
  ['a notifications call', /\bReadNotifications\b/, 'Call ReadNotifications until every implementer has reported', 'tree'],
  ['polling', /\bpoll(?:s|ed|ing)?\b/i, 'Poll the wave until each implementer reports', 'prose'],
  ['sleeping', /\b(?:sleep(?:s|ing)?|Start-Sleep)\b/i, 'Sleep for a minute between spawns', 'prose'],
  ['checking again and again', /\bkeep\s+(?:check|look|ask|query)ing\b/i, 'Keep checking the task list for new output', 'tree'],
  ['checking at intervals', /\b(?:check|look|query)\w*\b[^.;:]*\b(?:every\s+(?:few\s+)?(?:\d+\s+)?(?:seconds?|minutes?)|periodically|at intervals|repeatedly)\b/i,
    'Check the agent output every few minutes', 'tree'],
  ['holding the turn on a sub-agent', HOLD_TURN, 'Hold the turn until every implementer has reported', 'tree'],
];
const polling = (text, families = POLL) => clauses(unticked(text)).flatMap(c => families.filter(([, p]) => fires(p, c)).map(([name]) => name + ' — ' + c));
// The compaction window's timer, a background `sleep 600` whose completion resumes a turn already
// ended, is the one sleep a document names. Only the sleeping family skips it, and only inside the
// pinned BUDGET.compaction passage, bounded as strayMentions bounds one; a clause break stands in
// for the cut passage so no clause joins across it. Every other family reads the passage, and the
// BUDGET pin holds it word for word.
function pollingIn(file, text, families) {
  const [exempt, from, to] = BUDGET.compaction;
  let slept = text;
  if (file === exempt) {
    const start = text.indexOf(from), end = text.indexOf(to, start + 1);
    assert.ok(start !== -1 && end > start, file + ': passage bounds must resolve: ' + from + ' .. ' + to);
    slept = text.slice(0, start) + '.\n' + text.slice(end);
  }
  return [...polling(text, families.filter(([name]) => name !== 'sleeping')), ...polling(slept, families.filter(([name]) => name === 'sleeping'))];
}
test('no shipped document tells the orchestrator to poll, sleep or call ReadNotifications while it waits', () => {
  assert.equal(new Set(POLL.map(p => p[0])).size, POLL.length);
  for (const [name, pattern, specimen] of POLL) {
    assert.deepEqual(POLL.filter(([, p]) => p.test(specimen)).map(p => p[0]), [name], name + ': its specimen must be caught by it alone');
    assert.equal(polling(specimen + '.').length, 1, name + ': the clause reader must report the specimen');
  }
  // Written as prose, not read off the patterns: the rule reversed in its own words, a negated verb
  // earlier in the clause, a suggestion, and a double negative.
  for (const planted of ['While the reviewers run, call `ReadNotifications` to see whether any has finished.',
    'The orchestrator never polls: it calls ReadNotifications to wait for a sub-agent.',
    'When the only remaining work waits on sub-agents, poll them instead of ending the turn.',
    'Never spawn a second reviewer; poll the first until it reports.', 'Do not end the turn — sleep, then look at the wave.',
    'Run Start-Sleep 60 between checks on the wave.', 'Keep looking at the task output until the implementer lands.',
    'Look at the agent transcripts periodically while the wave runs.', 'Why not poll the implementers while they work?',
    'Never skip polling the wave.',
    // The R1 reviewer's two survivors, and the turn held in other words.
    'Before ending a turn, wait until every implementer of the wave has reported.',
    "Spawn ALL of the wave's implementers concurrently, then check each one's output until it lands.",
    'Watch the reviewer transcript until it prints its verdict.', 'Do not end the turn while the reviewers run.',
    'Keep the turn open until the QA runner reports.', 'Rather than ending the turn, look at the sub-agents again.']) {
    assert.ok(polling(planted).length >= 1, 'must be reported: ' + planted);
  }
  assert.ok(read('orchestrate/references/smoke-page-template.html').includes(PAGE_WAITING), 'the page template still says what the must-pass control quotes');
  assert.deepEqual(polling(NO_POLL + ' Never poll a sub-agent. Do not call `ReadNotifications`. Don\'t sleep while a wave runs. ' + BACKGROUND_RULE + ' ' + PAGE_WAITING
    + ' Never wait until every implementer has reported. Gate PER BATCH, as each implementer reports (don\'t wait for the wave\'s slowest).'
    + ' Per batch as each lands: fence check → failing-on-base → reviewer + gate agents → next wave, repeating until a checkpoint.'), [],
    'the rule itself, its negations, the approved background task and a page note are not directives to poll');
  // poll and sleep read the prose domain only (see proseDocuments); every other family, the whole tree.
  assert.deepEqual(POLL.filter(p => p[3] !== 'tree').map(p => p[0]), ['polling', 'sleeping'], 'only poll and sleep are narrowed to the prose domain');
  assert.ok(POLL.every(p => p[3] === 'tree' || p[3] === 'prose'));
  const treeOnly = POLL.filter(p => p[3] === 'tree');
  assert.deepEqual(polling('Sleep a minute, then poll the wave.', treeOnly), [], 'outside the prose domain poll and sleep are not read');
  assert.equal(polling('Sleep a minute, then poll the wave.').length, 2, 'inside it they are');
  const files = documents(), prose = new Set(proseDocuments());
  assert.ok(files.includes('orchestrate/SKILL.md') && files.includes('orchestrate/references/protocol.md') && files.includes('README.md')
    && files.includes('orchestrate/references/smoke-page-template.html'));
  assert.ok(['orchestrate/SKILL.md', 'orchestrate/references/protocol.md', 'README.md'].every(f => prose.has(f)),
    'the prose domain is a superset of the no-polling rule\'s carriers');
  for (const file of files) {
    assert.deepEqual(pollingIn(file, read(file), prose.has(file) ? POLL : treeOnly), [], file + ': a directive to poll, sleep or call ReadNotifications while waiting');
  }
});

// pollingIn's exemption is live, exact on both bounds, and the sleeping family's alone.
test('the compaction timer is the one sleep named, exempt from the sleeping family inside its pinned passage only', () => {
  const [file, from, to, expected] = BUDGET.compaction, text = read(file);
  const SLEEP = POLL.find(([name]) => name === 'sleeping')[2], found = planted => pollingIn(file, planted, POLL).map(f => f.split(' — ')[0]);
  assert.ok(polling(section(text, from, to), POLL.filter(([name]) => name === 'sleeping')).length >= 1, 'live: the passage names the sleep the exemption skips');
  assert.deepEqual(found(text), [], file + ': with the exemption, nothing is reported');
  // Just outside the passage, on either side, a sleep is reported.
  assert.deepEqual(found(text.replace(from, () => SLEEP + '.\n' + from)), ['sleeping'], 'a sleep just before the passage is reported');
  assert.deepEqual(found(text.replace(to, () => to + ' ' + SLEEP + '.')), ['sleeping'], 'a sleep just after the passage is reported');
  // Just inside it, on either side, the sweep is blind by design and the BUDGET pin reddens.
  for (const inside of [text.replace(from, () => from + ' ' + SLEEP + '.'), text.replace(to, () => ' ' + SLEEP + '.' + to)]) {
    assert.deepEqual(found(inside), [], 'inside the passage the sleeping family reads nothing');
    assert.notEqual(collapse(section(inside, from, to)).trim(), expected, 'a sleep planted inside the passage reddens the BUDGET pin');
  }
  // Every other family, planted inside the passage, is still reported.
  const others = POLL.filter(([name]) => name !== 'sleeping');
  assert.equal(others.length, POLL.length - 1);
  for (const [name, , specimen] of others) {
    assert.deepEqual(found(text.replace(to, () => ' ' + specimen + '.' + to)), [name], name + ': still read inside the passage');
  }
  // The exemption belongs to its file: the same text under any other name is read whole.
  assert.ok(pollingIn('orchestrate/SKILL.md', text, POLL).some(f => f.startsWith('sleeping — ')), 'another file gets no exemption');
});

// ===== `continue <id>` and step 8's clear route (B02 of OS-20261010) =====================
// The four places SKILL.md names the continue mode, each pinned whole from its head to the text
// that follows it, as BUDGET pins a passage; OLD_CONTINUE holds the wording each one replaced. A
// fifth field names the frontmatter key a passage is the value of.
const CONTINUE_ID = [
  ['the argument-hint', 'argument-hint:', '\n', 'argument-hint: new <description> | continue [<id>] | status | close', 'argument-hint'],
  ["the description's mode list", ' Modes: ', '\n', 'Modes: new <description> | continue [<id>] | status | close.', 'description'],
  ['the dispatch line', '\n- `continue', '\n- `status`',
    '- `continue [<id>]` → run the session algorithm on the active ledger, or on ledger `<id>` when one is named; `continue <id> after-clear` is the form orchestrate-mod sends after it clears the conversation, and `continue <id> in-place <reason>` the one it sends in place of a skipped clear, which carries on with no boot when the tip is unchanged (protocol.md §Session algorithm step 8)'],
  ['Mode: continue step 1', '## Mode: continue\n', '\n2. Read the ledger',
    '## Mode: continue 1. Discovery → the ledger `<id>` names, when one is named (its line must route to `continue` or `close`; AMBIGUOUS, INCOMPLETE, UNKNOWN, `status` or `none` → ask), else exactly one ACTIVE ledger (else ask).'],
];
const OLD_CONTINUE = {
  'the argument-hint': 'argument-hint: new <description> | continue | status | close',
  "the description's mode list": ' Modes: new <description> | continue | status | close.',
  'the dispatch line': '\n- `continue` → run the session algorithm on the active ledger',
  'Mode: continue step 1': '## Mode: continue\n\n1. Discovery → exactly one ACTIVE ledger (else ask).',
};
const continuePin = (text, from, to) => collapse(section(text, from, to)).trim();
// SKILL.md's text with one CONTINUE_ID passage, as it stands raw, put back to its old wording.
function restoredContinue(text, what) {
  const [, from, to] = CONTINUE_ID.find(([name]) => name === what);
  return text.replace(section(text, from, to), () => OLD_CONTINUE[what]);
}
// Each keyed CONTINUE_ID passage the skill loader would not read as its key's value: SKILL.md opens
// with a `---` line, the first `---` line after it closes the frontmatter, and each passage sits on
// the one unindented line of its key inside that block.
function frontmatterFaults(text) {
  if (!text.startsWith('---\n')) return ['no frontmatter: the file does not open with a --- line'];
  const close = text.indexOf('\n---\n', 3);
  if (close === -1) return ['no frontmatter: no closing --- line'];
  const lines = text.slice(4, close).split('\n'), faults = [];
  for (const [what, from, to, , key] of CONTINUE_ID.filter(row => row[4])) {
    const start = text.indexOf(from), lineStart = text.lastIndexOf('\n', start) + 1, end = text.indexOf(to, start + 1);
    if (lines.filter(line => line.startsWith(key + ':')).length !== 1) faults.push(what + ': the frontmatter must carry exactly one ' + key + ' line');
    if (start === -1 || end === -1 || end > close || !text.startsWith(key + ': ', lineStart)) faults.push(what + ': not on the ' + key + ' line inside the frontmatter');
  }
  return faults;
}
// The backticked or capitalised words of `text` between `from` and `to`.
const routeWords = (text, from, to) => [...section(collapse(text), from, to).slice(from.length).matchAll(/`([a-z]+)`|\b([A-Z]{2,})\b/g)].map(m => m[1] || m[2]);
test('SKILL.md writes `continue [<id>]` in its argument-hint, mode list and dispatch line, and Mode: continue step 1 takes the named ledger first, each pinned whole', () => {
  const file = 'orchestrate/SKILL.md', text = read(file);
  assert.equal(new Set(CONTINUE_ID.map(([what]) => what)).size, 4, 'four passages are pinned; the list may not shrink to a sample');
  assert.deepEqual(Object.keys(OLD_CONTINUE).sort(), CONTINUE_ID.map(([what]) => what).sort(), 'each pinned passage has the old wording its control restores');
  for (const [what, from, to, expected] of CONTINUE_ID) {
    assert.equal(text.split(from).length - 1, 1, what + ': the anchor ' + JSON.stringify(from) + ' must occur exactly once in ' + file);
    assert.equal(continuePin(text, from, to), expected, file + ' (' + what + '): the pinned passage changed; update CONTINUE_ID only on purpose');
    // Live: a sentence planted just inside either end, or the old wording restored, reddens the pin.
    const start = text.indexOf(from) + from.length, end = text.indexOf(to, start);
    for (const planted of [text.slice(0, start) + ' Skip it when in a hurry.' + text.slice(start), text.slice(0, end) + ' Skip it when in a hurry.' + text.slice(end)]) {
      assert.notEqual(continuePin(planted, from, to), expected, what + ': a planted sentence must redden the pin');
    }
    const restored = restoredContinue(text, what);
    assert.notEqual(restored, text, what + ': the control must restore the old wording');
    assert.notEqual(continuePin(restored, from, to), expected, what + ': the old wording must redden the pin');
  }
  // The argument-hint and the mode list are frontmatter values, read where the loader reads them.
  assert.deepEqual(CONTINUE_ID.filter(row => row[4]).map(([what]) => what), ['the argument-hint', "the description's mode list"], 'the two frontmatter passages are keyed');
  assert.deepEqual(frontmatterFaults(text), [], file + ': the argument-hint and the mode list are frontmatter values');
  // Live: the closing --- moved above the hint, the description's key indented, a second hint line,
  // and a file that does not open with ---, are each reported.
  const hint = CONTINUE_ID[0][3];
  const controls = [
    [text.replace(hint + '\n---\n', () => '---\n' + hint + '\n'), ['the argument-hint: the frontmatter must carry exactly one argument-hint line', 'the argument-hint: not on the argument-hint line inside the frontmatter']],
    [text.replace('\ndescription: ', () => '\n  description: '), ["the description's mode list: the frontmatter must carry exactly one description line", "the description's mode list: not on the description line inside the frontmatter"]],
    [text.replace(hint + '\n---\n', () => hint + '\nargument-hint: continue\n---\n'), ['the argument-hint: the frontmatter must carry exactly one argument-hint line']],
    [text.slice(4), ['no frontmatter: the file does not open with a --- line']],
  ];
  for (const [changed, faults] of controls) {
    assert.notEqual(changed, text, 'the control must change the frontmatter: ' + faults[0]);
    assert.deepEqual(frontmatterFaults(changed), faults);
  }
  // Step 1 places every route the discovery line can print: `continue` and `close` take the named
  // ledger, and every other mode, and every doubtful line, asks.
  const discovery = section(text, '## Discovery (every mode starts here)', '\n1. Find ledgers');
  const modes = routeWords(discovery, 'the mode that State routes to (', ')');
  const doubts = routeWords(discovery, 'JSON is read when a line says ', ', or when');
  assert.deepEqual(modes, ['continue', 'close', 'status', 'none'], 'the modes the discovery line routes to');
  assert.deepEqual(doubts, ['AMBIGUOUS', 'INCOMPLETE', 'UNKNOWN'], 'the lines that are read as doubt');
  const step1 = CONTINUE_ID.find(([what]) => what === 'Mode: continue step 1')[3];
  const taken = routeWords(step1, 'must route to ', ';'), asked = routeWords(step1, '; ', '→ ask');
  assert.deepEqual(taken, ['continue', 'close'], 'step 1 takes a named ledger whose line routes to continue or close');
  assert.deepEqual([...taken, ...asked].filter(w => modes.includes(w)).sort(), [...modes].sort(), 'step 1 places every mode the discovery line can print');
  assert.deepEqual(asked.filter(w => !modes.includes(w)), doubts, 'step 1 asks on every doubtful line');
  // Live: a fifth mode in the discovery sentence is one step 1 does not place.
  const fifth = routeWords(discovery.replace('`status` or `none`', () => '`status`, `wait` or `none`'), 'the mode that State routes to (', ')');
  assert.ok(fifth.includes('wait'), 'the control must plant a fifth mode');
  assert.notDeepEqual([...taken, ...asked].filter(w => fifth.includes(w)).sort(), [...fifth].sort(), 'a mode step 1 does not name must be found');
});

// A mode list is a `|`-separated run of the mode words new, continue, status and close, in any
// order, each with or without its placeholder, read as a reader sees the text: whitespace
// collapsed, backticks stripped, &lt; and &gt; decoded. Every one in the shipped tree, every file
// type, writes `continue [<id>]`, and one that names `new` names `continue` too.
const MODE_WORD = String.raw`\b(?:new|continue|status|close)\b(?:\s*(?:<[^<>|]*>|\[[^\[\]|]*\]))*`;
const MODE_LIST = new RegExp(MODE_WORD + String.raw`(?:\s*\|\s*` + MODE_WORD + ')+', 'gi');
const readAsShown = text => collapse(text.replace(/&(?:lt|#0*60|#x0*3c);/gi, '<').replace(/&(?:gt|#0*62|#x0*3e);/gi, '>').replace(/`/g, ''));
const modeLists = text => [...readAsShown(text).matchAll(MODE_LIST)].map(m => m[0]);
const bareModeLists = (file, text) => modeLists(text)
  .filter(list => /\bcontinue\b(?! \[<id>\])/i.test(list) || (/\bnew\b/i.test(list) && !/\bcontinue\b/i.test(list))).map(list => file + ': ' + list);
// The family this sweep replaced: every list it read, the new one reads.
const FIRST_MODE_LIST = /new <description>[`\s]*\|[`\s]*continue\b/g;
test('every mode list in the shipped tree writes `continue [<id>]`', () => {
  const files = shipped(), listing = [], bare = [];
  assert.ok(files.includes('orchestrate/SKILL.md') && files.includes('orchestrate/references/protocol.md') && files.some(f => f.endsWith('.mjs'))
    && files.some(f => f.endsWith('.html')), 'the domain is the whole shipped tree, recursively, every file type');
  for (const file of files) {
    const text = read(file), lists = modeLists(text);
    if (lists.length) listing.push(file);
    assert.ok(lists.length >= [...text.matchAll(FIRST_MODE_LIST)].length, file + ': the sweep reads every list the family it replaced read');
    bare.push(...bareModeLists(file, text));
  }
  assert.deepEqual(bare, [], 'a mode list that writes `continue` without `[<id>]`, or leaves it out');
  assert.ok(listing.includes('orchestrate/SKILL.md'), 'live: the sweep reads the mode lists SKILL.md carries');
  // Live: each of SKILL.md's two lists, put back to its old wording, is reported on its own.
  const file = 'orchestrate/SKILL.md', text = read(file);
  for (const [what, old] of [['the argument-hint', 'argument-hint: new <description> | continue | status'], ["the description's mode list", 'Modes: new <description> | continue | status']]) {
    const found = bareModeLists(file, restoredContinue(text, what));
    assert.equal(found.length, 1, what + ': restored, it must be reported once — ' + found.join(' | '));
    assert.ok(restoredContinue(text, what).includes(old) && found[0].includes('new <description> | continue | status'), what + ': the report quotes the list');
  }
  // Live: a list written later anywhere is reported, one with `[<id>]` is not. The first five are the
  // corpus of the family this sweep replaced; each must still be reported by it and by the new one.
  const firstCorpus = ['new <description> | continue | status | close', 'new <description>\n  | continue | status', 'new <description>|continue',
    '`new <description>` | `continue` | `status`', 'new <description> | continue[<id>] | status'];
  for (const planted of firstCorpus) assert.ok(new RegExp(FIRST_MODE_LIST.source).test(planted), 'the replaced family read: ' + JSON.stringify(planted));
  // Then a list wrapped or spaced inside `new <description>`, one without placeholders, one in
  // another order, one HTML-escaped, and one that leaves `continue` out.
  for (const planted of [...firstCorpus, 'new\n<description> | continue | status | close', 'new | continue | status | close', 'new  <description> | continue',
    'status | close | continue', 'new &lt;description&gt; | continue | status', 'new <description> | status | close']) {
    assert.equal(bareModeLists('orchestrate/references/protocol.md', 'Modes: ' + planted + '.\n').length, 1, 'must be reported: ' + JSON.stringify(planted));
  }
  for (const planted of ['new <description> | continue [<id>] | status', '`new <description>` | `continue [<id>]` | `status`',
    'new &lt;description&gt; | continue [&lt;id&gt;] | status', '| Version | Status | Updated |', 'status: v.status || ""']) {
    assert.deepEqual(bareModeLists('orchestrate/references/protocol.md', 'Modes: ' + planted + '.\n'), [], 'must pass: ' + planted);
  }
});

// The clear route's names, counted per file across the shipped tree: protocol.md names the tool
// once and the after-clear command twice, every mention inside step 8's passage (BUDGET.compaction),
// and SKILL.md names the after-clear form once, in its dispatch line; the contract template names
// the after-clear command once, in boot step 1's after-clear sentence (AFTER_CLEAR_READ). "continue
// <id> after-clear" also counts each command, so the form's count is all three files'. Each name is also read
// by its key words, however spelled: the tool's short name, the after-clear word, and any
// `/orchestrate continue` command, the in-place one included. The skipped clear's in-place form sits in step 8's
// passage and the dispatch line once each, and its in-place word with it.
const CLEAR_NAMES = [
  ['the tool', 'mcp__orchestrate-mod__schedule_clear', { 'orchestrate/references/protocol.md': 1 }],
  ['the tool, by its short name', /schedule[\W_]*clear/i, { 'orchestrate/references/protocol.md': 1 }],
  ['the after-clear command', '/orchestrate continue <id> after-clear', { 'orchestrate/references/protocol.md': 2, [TEMPLATE]: 1 }],
  ['the after-clear form', 'continue <id> after-clear', { 'orchestrate/SKILL.md': 1, 'orchestrate/references/protocol.md': 2, [TEMPLATE]: 1 }],
  ['the after-clear word', /\bafter[\W_]*clear/i, { 'orchestrate/SKILL.md': 1, 'orchestrate/references/protocol.md': 2, [TEMPLATE]: 1 }],
  ['the in-place command', /\/orchestrate\W+continue\b/i, { 'orchestrate/references/protocol.md': 3, [TEMPLATE]: 1 }],
  ['the in-place form', 'continue <id> in-place <reason>', { 'orchestrate/SKILL.md': 1, 'orchestrate/references/protocol.md': 1 }],
  ['the in-place word', /\bin[-_]+place\b/i, { 'orchestrate/SKILL.md': 1, 'orchestrate/references/protocol.md': 1 }],
];
// Boot step 1's after-clear sentence, the template's home for the clear route: [file, from, to, the
// passage pinned whole]. It ends where boot step 2 opens, and its opening names no clear-route name,
// so a control can take the mention out and leave the home's bounds standing.
const AFTER_CLEAR_READ = [TEMPLATE, 'A session that ', '\n2. Run `git status',
  'A session that `/orchestrate continue <id> after-clear` opened reads none of 00-request.md, 01-plan.md and PROGRESS.md: once the pin check (step 3) passes it reads the digest that '
  + '`node "{{SKILL_DIR}}/tools/reconcile.mjs" digest --repo <repo> --ledger {{CHANGE_ID}} --integration refs/heads/{{INTEGRATION_BRANCH}}` prints, and of this contract only '
  + '§Boot sequence, §Git model, §Validation commands and §Hard prohibitions, reading any other section by its heading when a step needs it.'];
const namedIn = (text, name) => typeof name === 'string' ? collapse(text).split(name).length - 1
  : [...collapse(text).matchAll(new RegExp(name.source, name.flags.replace(/[gy]/g, '') + 'g'))].length;
// Each fault in `texts` ([file, text] pairs): a name counted otherwise than CLEAR_NAMES says, and a
// mention outside its file's passage.
function clearNameFaults(texts) {
  const [pfile, pfrom, pto] = BUDGET.compaction, [, dfrom, dto] = CONTINUE_ID.find(([what]) => what === 'the dispatch line');
  const [afile, afrom, ato] = AFTER_CLEAR_READ;
  const homes = { [pfile]: [pfrom, pto], 'orchestrate/SKILL.md': [dfrom, dto], [afile]: [afrom, ato] }, faults = [];
  for (const [what, name, expected] of CLEAR_NAMES) {
    const counts = {};
    for (const [file, text] of texts) {
      const n = namedIn(text, name);
      if (!n) continue;
      counts[file] = n;
      const home = homes[file] ? namedIn(section(text, ...homes[file]), name) : 0;
      if (home !== n) faults.push(what + ': ' + (n - home) + ' outside its passage in ' + file);
    }
    if (!isDeepStrictEqual(counts, expected)) faults.push(what + ': counted ' + JSON.stringify(counts));
  }
  return faults;
}
test("the clear route's names sit in step 8's passage, SKILL.md's dispatch line and the template's after-clear sentence only, counted", () => {
  const texts = shipped().map(file => [file, read(file)]), at = file => texts.findIndex(([f]) => f === file);
  const swap = (file, text) => texts.map((pair, i) => i === at(file) ? [file, text] : pair);
  assert.ok(at('orchestrate/SKILL.md') !== -1 && at('orchestrate/references/protocol.md') !== -1 && at('orchestrate/references/execution-models.md') !== -1 && at(TEMPLATE) !== -1);
  assert.deepEqual(clearNameFaults(texts), [], "the names are where step 8, the dispatch line and boot step 1's after-clear sentence put them, and nowhere else");
  const [pfile, pfrom, pto] = BUDGET.compaction, protocol = read(pfile), skill = read('orchestrate/SKILL.md');
  const command = '`/orchestrate continue <id> after-clear`', inPlace = '`/orchestrate continue <id> in-place <reason>`';
  assert.ok(protocol.includes(command) && section(protocol, pfrom, pto).includes(command) && protocol.includes(inPlace), 'the control must find the commands inside the passage');
  // Each key-word family reads the full names it stands for.
  const family = what => CLEAR_NAMES.find(([name]) => name === what)[1];
  for (const [what, spellings] of [['the tool, by its short name', ['mcp__orchestrate-mod__schedule_clear']],
    ['the after-clear word', ['/orchestrate continue <id> after-clear', 'continue <id> after-clear']], ['the in-place command', ['/orchestrate continue <id> after-clear', '/orchestrate continue <id>']],
    ['the in-place word', ['continue <id> in-place <reason>']]]) {
    assert.ok(spellings.every(spelling => namedIn(spelling, family(what)) === 1), what + ': reads the full names it stands for');
  }
  // Live: one mention more just outside the passage, on either side, is reported as outside and as a count.
  // A count object's text: protocol.md's count, then the template's (T1 when it holds its one mention).
  const P = '{"' + pfile + '":', SP = '{"orchestrate/SKILL.md":1,"' + pfile + '":', Tn = n => ',"' + TEMPLATE + '":' + n + '}', T1 = Tn(1);
  assert.deepEqual(clearNameFaults(swap(pfile, protocol.replace(pfrom, () => 'Call `mcp__orchestrate-mod__schedule_clear` first.\n' + pfrom))),
    ['the tool: 1 outside its passage in ' + pfile, 'the tool: counted ' + P + '2}',
      'the tool, by its short name: 1 outside its passage in ' + pfile, 'the tool, by its short name: counted ' + P + '2}'], 'the tool named before the passage');
  assert.deepEqual(clearNameFaults(swap(pfile, protocol.replace(pto, () => pto + ' Then run ' + command + '.'))),
    ['the after-clear command: 1 outside its passage in ' + pfile, 'the after-clear command: counted ' + P + '3' + T1,
      'the after-clear form: 1 outside its passage in ' + pfile, 'the after-clear form: counted ' + SP + '3' + T1,
      'the after-clear word: 1 outside its passage in ' + pfile, 'the after-clear word: counted ' + SP + '3' + T1,
      'the in-place command: 1 outside its passage in ' + pfile, 'the in-place command: counted ' + P + '4' + T1], 'the command named after the passage');
  // Live: one fewer inside is reported as a count; the same mention moved out keeps the count and is reported as outside.
  const fewer = protocol.replace(command, () => 'its command');
  assert.deepEqual(clearNameFaults(swap(pfile, fewer)),
    ['the after-clear command: counted ' + P + '1' + T1, 'the after-clear form: counted ' + SP + '1' + T1, 'the after-clear word: counted ' + SP + '1' + T1,
      'the in-place command: counted ' + P + '2' + T1], 'one command fewer');
  assert.deepEqual(clearNameFaults(swap(pfile, fewer.replace(pto, () => pto + ' Then run ' + command + '.'))),
    ['the after-clear command: 1 outside its passage in ' + pfile, 'the after-clear form: 1 outside its passage in ' + pfile,
      'the after-clear word: 1 outside its passage in ' + pfile, 'the in-place command: 1 outside its passage in ' + pfile], 'a command moved out of the passage');
  // Live: SKILL.md's mention moved from the dispatch line into Mode: continue is reported; one added in another file is too.
  const moved = skill.replace('`continue <id> after-clear` is the form', () => 'that form').replace('(else ask).', () => '(else ask); `continue <id> after-clear` boots alike.');
  assert.notEqual(moved, skill, 'the control must move the mention');
  assert.deepEqual(clearNameFaults(swap('orchestrate/SKILL.md', moved)),
    ['the after-clear form: 1 outside its passage in orchestrate/SKILL.md', 'the after-clear word: 1 outside its passage in orchestrate/SKILL.md'], 'the form moved out of the dispatch line');
  const other = 'orchestrate/references/execution-models.md', O = '{"' + other + '":1,"' + pfile + '":1}';
  assert.deepEqual(clearNameFaults(swap(other, read(other) + '\nCall `mcp__orchestrate-mod__schedule_clear`.\n')),
    ['the tool: 1 outside its passage in ' + other, 'the tool: counted ' + O, 'the tool, by its short name: 1 outside its passage in ' + other,
      'the tool, by its short name: counted ' + O], 'the tool named in another file');
  // Live: the R1 gate's survivors, a contradicting directive that names the route only by a key
  // word, each planted in a paragraph of its own under a heading far from its home, are reported.
  const under = (text, heading, sentence) => {
    assert.equal(text.split(heading + '\n').length - 1, 1, 'the control must find the heading once: ' + heading);
    return text.replace(heading + '\n', () => heading + '\n\n' + sentence + '\n');
  };
  const LEGACY = '## Legacy ledger recognition (interop)';
  assert.deepEqual(clearNameFaults(swap('orchestrate/SKILL.md', under(skill, '## Refusals', '- Asked for an `after-clear` boot → skip the resume-time validation.'))),
    ['the after-clear word: 1 outside its passage in orchestrate/SKILL.md', 'the after-clear word: counted {"orchestrate/SKILL.md":2,"' + pfile + '":2' + T1], 'm4: an after-clear boot that skips validation');
  assert.deepEqual(clearNameFaults(swap(pfile, under(protocol, LEGACY, 'Call `schedule_clear` at every wave close, whatever the context size.'))),
    ['the tool, by its short name: 1 outside its passage in ' + pfile, 'the tool, by its short name: counted ' + P + '2}'], 'm5: the tool by its short name');
  assert.deepEqual(clearNameFaults(swap(pfile, under(protocol, LEGACY, 'After posting the line, run `/orchestrate continue <id>` yourself.'))),
    ['the in-place command: 1 outside its passage in ' + pfile, 'the in-place command: counted ' + P + '4' + T1], 'm6: the in-place command run by the orchestrator');
  assert.deepEqual(clearNameFaults(swap(pfile, under(protocol, LEGACY, 'After a clear, the mod runs `/orchestrate continue after-clear`.'))),
    ['the after-clear word: 1 outside its passage in ' + pfile, 'the after-clear word: counted ' + SP + '3' + T1,
      'the in-place command: 1 outside its passage in ' + pfile, 'the in-place command: counted ' + P + '4' + T1], 'the reviewer\'s m2: the after-clear command without its id');
  // Live: the template's home held as tightly. The command named just before boot step 1's after-clear
  // sentence, or just inside boot step 2, is reported as outside and as a count; the sentence's own
  // command gone is a count; that command moved under a far heading keeps the count and is reported as outside.
  const tpl = read(TEMPLATE), [, afrom, ato] = AFTER_CLEAR_READ, stepTwo = ato + ' --porcelain`,';
  assert.ok(section(tpl, afrom, ato).includes(command) && tpl.split(afrom).length === 2 && tpl.split(stepTwo).length === 2,
    "the control must find the command inside the template's home, and each of its anchors once");
  const oneMore = ['the after-clear command: 1 outside its passage in ' + TEMPLATE, 'the after-clear command: counted ' + P + '2' + Tn(2),
    'the after-clear form: 1 outside its passage in ' + TEMPLATE, 'the after-clear form: counted ' + SP + '2' + Tn(2),
    'the after-clear word: 1 outside its passage in ' + TEMPLATE, 'the after-clear word: counted ' + SP + '2' + Tn(2),
    'the in-place command: 1 outside its passage in ' + TEMPLATE, 'the in-place command: counted ' + P + '3' + Tn(2)];
  assert.deepEqual(clearNameFaults(swap(TEMPLATE, tpl.replace(afrom, () => command + ' ' + afrom))), oneMore, "the command named just before the template's home");
  assert.deepEqual(clearNameFaults(swap(TEMPLATE, tpl.replace(stepTwo, () => stepTwo + ' ' + command + ','))), oneMore, 'the command named just inside boot step 2');
  const tplFewer = tpl.replace(command, () => 'an automatic clear');
  assert.deepEqual(clearNameFaults(swap(TEMPLATE, tplFewer)),
    ['the after-clear command: counted ' + P + '2}', 'the after-clear form: counted ' + SP + '2}', 'the after-clear word: counted ' + SP + '2}',
      'the in-place command: counted ' + P + '3}'], "the template's command gone");
  assert.deepEqual(clearNameFaults(swap(TEMPLATE, under(tplFewer, '## Hard prohibitions', '- After ' + command + ', skip the pin check.'))),
    ['the after-clear command: 1 outside its passage in ' + TEMPLATE, 'the after-clear form: 1 outside its passage in ' + TEMPLATE,
      'the after-clear word: 1 outside its passage in ' + TEMPLATE, 'the in-place command: 1 outside its passage in ' + TEMPLATE], "the template's command moved under §Hard prohibitions");
  // Live: each key word, however spelled or wrapped, planted just outside the passage, and just before
  // the template's home, is reported by its family. Every plant is read before any verdict, so a red names them all.
  const missed = [];
  for (const [what, spellings] of [['the tool, by its short name', ['schedule_clear', 'scheduleClear', 'schedule-clear', 'Schedule\n   clear']],
    ['the after-clear word', ['after-clear', 'After clear', 'after_clear', 'afterclear', 'after-\n   clear']],
    ['the in-place command', ['/orchestrate continue', '/Orchestrate  continue <id>', '/orchestrate\n   continue']],
    ['the in-place word', ['in-place', 'In_Place', 'in--place']]]) {
    for (const spelling of spellings) {
      for (const [file, planted] of [[pfile, protocol.replace(pto, () => pto + ' Then use ' + spelling + ' here.')], [TEMPLATE, tpl.replace(afrom, () => 'Then use ' + spelling + ' here. ' + afrom)]]) {
        const faults = clearNameFaults(swap(file, planted));
        if (!faults.includes(what + ': 1 outside its passage in ' + file)) missed.push(what + ': ' + JSON.stringify(spelling) + ' in ' + file + ' — ' + faults.join(' | '));
      }
    }
  }
  assert.deepEqual(missed, [], 'each key word planted outside its passage must be reported by its family');
});

// Boot step 1's after-clear sentence reads as AFTER_CLEAR_READ pins it, last in step 1 after the LOG.md
// sentence, and each contract section it keeps at boot names a heading of the template: a renamed
// heading would leave a session reading a section that is not there.
const keptSections = text => [...collapse(section(text, AFTER_CLEAR_READ[1], AFTER_CLEAR_READ[2])).matchAll(/§(\w+ \w+)/g)].map(m => m[1]);
const unheaded = text => keptSections(text).filter(name => !text.split('\n').some(line => line.startsWith('## ' + name)));
test("boot step 1's after-clear sentence is pinned whole, and each section it keeps is a heading of the template", () => {
  const [file, from, to, pinned] = AFTER_CLEAR_READ;
  assert.equal(file, TEMPLATE);
  assert.equal(collapse(section(template, from, to)).trim(), pinned, 'the after-clear sentence changed; update AFTER_CLEAR_READ only if the change is deliberate');
  assert.ok(template.includes('never at boot.\n   ' + from), "the sentence follows step 1's LOG.md sentence");
  assert.deepEqual(keptSections(template), ['Boot sequence', 'Git model', 'Validation commands', 'Hard prohibitions']);
  assert.deepEqual(unheaded(template), [], 'each section the sentence keeps must be a heading of the template');
  // Live: a renamed heading is reported.
  const renamed = template.replace('\n## Git model (locked)\n', () => '\n## Branch model (locked)\n');
  assert.notEqual(renamed, template, 'the control must rename the heading');
  assert.deepEqual(unheaded(renamed), ['Git model'], 'a kept section whose heading is gone must be reported');
});

// ===== Closed sweeps (B06 of OS-20261022): where the worktrees live, a cleared session, the close-out's order =====
// A document's units as a reader meets them: a paragraph, a list item, a table row, a tree row or a heading each
// starts its own, split into sentences and `;` clauses, code ticks and emphasis dropped and whitespace collapsed.
const proseUnits = text => text.replace(/\r\n/g, '\n').split(/\n[ \t]*\n|\n(?=[ \t]*(?:[-*]|\d+\.)[ \t]|[ \t]*[|├└│]|#{1,6} )/)
  .flatMap(block => block.replace(/[`*]/g, '').replace(/\s+/g, ' ').trim().split(/(?<=[.;])\s+/)).filter(Boolean);
// Each unit of `texts` ([file, text] pairs) that `selects` reads and `listed` ([file, unit] pairs, word for word) does
// not hold, then each listed one gone; a unit held twice must be listed twice.
function closedFaults(texts, selects, listed) {
  const left = listed.map(([file, unit]) => file + ' :: ' + unit), faults = [];
  for (const [file, text] of texts) {
    for (const unit of proseUnits(text).filter(selects)) {
      const at = left.indexOf(file + ' :: ' + unit);
      if (at === -1) faults.push(file + ' :: ' + unit);
      else left.splice(at, 1);
    }
  }
  return [...faults, ...left.map(entry => 'gone: ' + entry)];
}
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// The orchestrator's worktrees live under the contract's worktree root, under the session scratchpad only for a
// contract that names none (BL-101). Every unit of the shipped Markdown and README (proseDocuments, where the
// conductor's directives live) that names a worktree, a working tree, a checkout or a clone (TREE_WORD, the family
// tests/protocol-contract.test.cjs `worktreeFaults` holds for the template), or a path under the session scratchpad
// (SCRATCH_PATH), is doubt unless SCRATCH_TREE_UNITS lists it word for word: a placement needs no particular word for
// its place. The template is left to tests/protocol-contract.test.cjs SCRATCH_UNITS and WORKTREE_UNITS.
const TREE_WORD = /work[\W_]*tree|working[\W_]*trees?|check[\W_]*out|\bcheck(?:s|ed|ing)?\b.*\bout\b|\bclon(?:e|es|ed|ing)\b/i;
const SCRATCH_PATH = /<(?:session )?scratchpad>\/|\[SCRATCHPAD_PATH\]\//i;
const namesTree = unit => SCRATCH_PATH.test(unit) || TREE_WORD.test(unit);
const WORKTREE_FALLBACK = "under the contract's worktree root (its boot step 2 and Git model), or under the session scratchpad for a contract that names none";
const SCRATCH_TREE_UNITS = [
  ["orchestrate/SKILL.md", "Scaffolds and drives file-based ledgers in .agents/changes/ — locked plan with a wave map (file-disjoint batches run concurrently, one git branch per batch, worktree implementers), a mechanical fence check plus an independent hunk-to-finding reviewer gate per batch, validation on the integration tip after every merge, user smoke tests only at planned checkpoints (after hands-on-risk waves plus one final — never per batch by default), and crash-safe PROGRESS reconciliation where git is truth."],
  ["orchestrate/SKILL.md", "Find ledgers in the WORKING TREE: glob /PROGRESS.md rooted at <repo>/.agents/changes/ — dot-dirs often escape repo-root globs, so root the search INSIDE the directory;"],
  ["orchestrate/SKILL.md", "Find ledgers that exist only on BRANCHES — scaffold commits live on the integration branch, never on the default branch, so a checkout on main may show none of the active work."],
  ["orchestrate/SKILL.md", "Group copies of the same ledger id across the checkout and refs;"],
  ["orchestrate/SKILL.md", "Unknown provenance, newer/conflicting ledger commits, or uncommitted ledger edits in an associated worktree remain visible, never silently superseded."],
  ["orchestrate/SKILL.md", "Unresolved ownership or target conflicts, divergent local/remote integration refs, or conflicting working-tree ledger edits are AMBIGUOUS."],
  ["orchestrate/SKILL.md", "checkout is on <current>\"."],
  ["orchestrate/SKILL.md", "Never switch the main checkout and never copy ledger files into another branch's tree."],
  ["orchestrate/SKILL.md", "The orchestrator never switches the main checkout: it reads with git show and writes through an integration worktree under the contract's worktree root (its boot step 2 and Git model), or under the session scratchpad for a contract that names none."],
  ["orchestrate/SKILL.md", "- Every batch passes, in order: a MECHANICAL fence check (paths, both rename endpoints, clean worktree — fence bounces are not review rounds), the failing-on-base check for fix batches, then ONE fresh independent read-only reviewer (plus any gate agents the contract names, in parallel) that maps every diff hunk to a batch item;"],
  ["orchestrate/SKILL.md", "the user picks at plan approval) → plan checks on a draft (node \"<skill-dir>/tools/scaffold.mjs\" --answers <draft answers> --repo <scratch worktree> writes the draft ledger into a scratch worktree of the base, and check-ledger.mjs runs plan, cites and census on it, per scaffolding.md;"],
  ["orchestrate/SKILL.md", "the draft and its worktree are removed after the last pre-flight round, so Discovery never meets a second copy of the ledger) → independent plan PRE-FLIGHT (a fresh read-only sub-agent given those three lines;"],
  ["orchestrate/SKILL.md", "Boot (a pinned contract verifies its skill pin first) + reconcile (for a pinned contract node \"<skill-dir>/tools/reconcile.mjs\" rows --repo <repo> --ledger <id> --integration <full-ref>, <skill-dir> being its pinned directory, if the tool is there) + resume-time validation per the contract's boot sequence — a pinned contract takes up its pinned skill directory's references/protocol.md, the procedure its repo facts plug into, only on SKILL MATCH — then run the pinned protocol.md's (or a legacy contract's own) §Session algorithm: repairs (❌ / red tip) first as mini-batches → unanswered 🧪 checkpoint → open the next wave (re-run the census agent of any member an earlier wave's tests reach, cut branches + worktrees, spawn ALL of the wave's implementers concurrently) → per batch as each lands: fence check → failing-on-base → reviewer + gate agents → polish / fix rounds → integrate (dry run, merge, tip validation) → next wave, repeating until a checkpoint → per-checkpoint close-out (tip validation, QA-runner pre-smoke with evidence, page) → STOP, delivering the checkpoint's combined smoke script as an interactive smoke page per [references/smoke-page.md](references/smoke-page.md) using available HTML delivery tools, or the full plain-text script when no usable HTML delivery is available."],
  ["orchestrate/SKILL.md", "Strictly read-only (no edits, no branch changes, no checkout switch): discovery → reconcile every row that is not ✅/👤/⛔ (dropped) against git per the §Recovery table (the pinned protocol.md's, or a legacy contract's own) → print a claim-vs-git-vs-verdict table, the checkpoint(s) awaiting the user, branch-only ledgers, and the recommended next action."],
  ["orchestrate/references/execution-models.md", "Preserve originals and validation evidence under versioned input paths, verify raw bytes after checkout, and give QA the same registry/identities the user receives."],
  ["orchestrate/references/execution-models.md", "- Wave — a set of batches that run AT THE SAME TIME: one implementer per batch, each in its own git worktree on its own branch."],
  ["orchestrate/references/execution-models.md", "create one worktree per batch under the contract's worktree root (its boot step 2 and Git model), or under the session scratchpad for a contract that names none (never inside the repo);"],
  ["orchestrate/references/execution-models.md", "run the ledger's per-worktree setup;"],
  ["orchestrate/references/execution-models.md", "commit ONE PROGRESS flip on the integration branch through the integration worktree (member rows → 🔄, branches named, wave base SHA in the session log, State: ACTIVE)."],
  ["orchestrate/references/execution-models.md", "The main checkout is never switched."],
  ["orchestrate/references/execution-models.md", "Gate as they land: each finished batch, in order — structured report present → mechanical fence check (clean worktree;"],
  ["orchestrate/references/execution-models.md", "Close the wave when every member is 🟢, ⛔ or 👤 (a recorded NEEDS_FENCE deferral does not hold it): remove the worktrees."],
  ["orchestrate/references/execution-models.md", "the checkout had silently never happened, the user ran all twenty steps against the base, and reported the un-fixed defects as failures."],
  ["orchestrate/references/execution-models.md", "- No sub-agent support → the orchestrator implements a wave's batches one at a time in the main checkout (worktrees unnecessary);"],
  ["orchestrate/references/protocol.md", "Owns PROGRESS, LOG, evidence/, branches, worktrees, integration merges, close-outs, and all user communication."],
  ["orchestrate/references/protocol.md", "Never switches the main checkout: reads any branch with git show <branch>:./<path> (keep the ./ — Git Bash on Windows mangles branch:path;"],
  ["orchestrate/references/protocol.md", "run it from the repo or worktree root), writes through an integration worktree under the contract's worktree root (its boot step 2 and Git model), or under the session scratchpad for a contract that names none — reusing one git worktree list already shows, pruning first if its directory is gone."],
  ["orchestrate/references/protocol.md", "Codes inside the file fence in the batch's isolated worktree, ticks the batch checklist, commits on the batch branch (one commit per fold-in item)."],
  ["orchestrate/references/protocol.md", "Its full report goes with the Write tool to the file its rendered prompt names, under the session scratchpad and never inside a worktree or the repository, in the fixed shape: its heading ### B<NN> R<k> <role> findings;"],
  ["orchestrate/references/protocol.md", "Each writes its full report with the Write tool to the findings file its prompt names — its only other writes are validation logs and disposable scratch under the session scratchpad, never inside a worktree or the repository — and returns four lines: its verdict, NONCE <nonce>, FINDINGS <n>, the file's path."],
  ["orchestrate/references/protocol.md", "A test hunter proves each mutation it chooses itself with the skill's mutate.mjs, on a disposable clone of the batch's commit."],
  ["orchestrate/references/protocol.md", "A smoke-step ASK is the exception to where that edit lands: its text lives in the batch file's Smoke section, and the batch branch changes that file only by ticks, polish: appends and a recorded Files line (6a), so the orchestrator applies it through the integration worktree, in the ledger commit that records the verdict, never on the batch branch."],
  ["orchestrate/references/protocol.md", "After a crash, wherever §Recovery meets a SHIP … asks= tip with no polish: item listed yet — its worktree clean or holding the unfinished list edit — the orchestrator completes that list commit before any polish pass or resume, ticking each ask whose text the integration branch's batch file already carries;"],
  ["orchestrate/references/protocol.md", "Once the polish has landed, the orchestrator classifies its diff: node \"<skill-dir>/tools/prose-only-diff.mjs\" --repo <batch worktree> --base <pre-polish sha> --head <polish tip>."],
  ["orchestrate/references/protocol.md", "| 🟢 Integrated | Reviewed, validations green on the worktree AND the integration tip, merged;"],
  ["orchestrate/references/protocol.md", "text node \"<skill-dir>/tools/git-evidence.mjs\" discovery --repo <repo> node \"<skill-dir>/tools/git-evidence.mjs\" worktrees --repo <repo> node \"<skill-dir>/tools/git-evidence.mjs\" ancestry --repo <repo> --ancestor <ref-or-sha> --descendant <ref-or-sha> node \"<skill-dir>/tools/git-evidence.mjs\" shipment --repo <repo> --integration <full-ref> --source local --ref <full-shipment-ref> node \"<skill-dir>/tools/git-evidence.mjs\" shipment --repo <repo> --integration <full-ref> --source remote --remote <name> --ref <full-shipment-ref> node \"<skill-dir>/tools/git-evidence.mjs\" ledger --repo <repo> --ref <full-ref> --ledger <id> --owner <ref-or-sha> --target <ref-or-sha> node \"<skill-dir>/tools/check-fence.mjs\" --repo <repo> --integration <full-ref> --batch <full-ref> --ledger <id> --batch-id <Bnn> --batch-file <repo-relative-path>"],
  ["orchestrate/references/protocol.md", "Discovery retains refs/SHAs/ symbolic targets, worktrees and ledger locations/provenance grouped by id;"],
  ["orchestrate/references/protocol.md", "failing-on-base.mjs performs step 6b in a disposable clone (its command is at that step) and prints one line, PROVEN, ALL-PASS (P0) or INCONCLUSIVE, exiting 0, 1 or 2."],
  ["orchestrate/references/protocol.md", "also inspect .agents/changes directly in each worktree from git worktree list --porcelain."],
  ["orchestrate/references/protocol.md", "never copy it into the default checkout."],
  ["orchestrate/references/protocol.md", "Inspect every worktree's porcelain status including untracked files and both rename endpoints."],
  ["orchestrate/references/protocol.md", "wave members run concurrently, each implementer in an isolated worktree under the contract's worktree root (its boot step 2 and Git model), or under the session scratchpad for a contract that names none."],
  ["orchestrate/references/protocol.md", "PROGRESS, LOG and evidence/ are edited ONLY on the integration branch, by the orchestrator, through the integration worktree (the QA runner writes evidence/ files there;"],
  ["orchestrate/references/protocol.md", "Copy raw bytes and verify hashes in the delivered checkout, including effective Git attributes and core.autocrlf=true when Git carries the package."],
  ["orchestrate/references/protocol.md", "Generate A and B to new paths (generation refuses overwrite) and require raw SHA256(generation A) = SHA256(generation B) = SHA256(committed workbook file bytes) from a fresh checkout."],
  ["orchestrate/references/protocol.md", "For each PROGRESS row not ✅/👤/⛔ (dropped), gather: branch exists? (git rev-parse --verify), integrated? (git merge-base --is-ancestor <branch> <integration>), shipped? (git merge-base --is-ancestor <integration-sha> <shipment-sha> only after source resolution above), commits ahead (git log <integration>..<branch> --oneline), dirty trees (git status --porcelain in each worktree from git worktree list that holds the row's branch — the main checkout only when it holds that branch), and the checklist state inside the batch file on that branch (git show <branch>:./<path>, from the root)."],
  ["orchestrate/references/protocol.md", "| any row whose Notes end in a spent fix again | commits after @<sha>, branch not yet an ancestor of the integration branch | Third round landed → worktree dirty: re-spawn the FRESH strong-tier implementer at the open findings;"],
  ["orchestrate/references/protocol.md", "no commit after the marker's @<sha>: never started → resume the implementer on that branch (fresh worktree);"],
  ["orchestrate/references/protocol.md", "| 🔄 | Notes record R<k> SHIP @<sha> asks=<n> for the current tip, worktree clean | Shipped with ASKs, crashed before the polish → polish pass (ASK list in LOG.md), then its mechanical close |"],
  ["orchestrate/references/protocol.md", "| 🔄 | Notes record R<k> SHIP @<sha> asks=<n>, commits after @<sha>, worktree clean, every polish: item ticked (at least one appended) | Polish landed, crashed before its close → 6a + validations on the tip;"],
  ["orchestrate/references/protocol.md", "| 🔄 | branch missing, or no commits past the wave base | Implementer never landed → re-spawn it (fresh worktree) |"],
  ["orchestrate/references/protocol.md", "| 🔄 | dirty worktree, or commits ahead + partial checklist (incl."],
  ["orchestrate/references/protocol.md", "a recorded deferral is not a partial checklist) | Resume the implementer — a fresh agent, the original is gone — at the first unticked item (recreate the worktree if gone;"],
  ["orchestrate/references/protocol.md", "Prune worktrees of integrated batches (git worktree remove)."],
  ["orchestrate/references/protocol.md", "Before any polish pass or resume at a SHIP … asks= tip whose batch file lists no polish: item yet, its worktree clean or dirty, the orchestrator completes the list commit, as §Severity and round accounting says for a smoke-step ASK."],
  ["orchestrate/references/protocol.md", "A contract carrying a Skill pin line verifies it FIRST, before reconcile: node \"<skill-dir>/tools/check-ledger.mjs\" skill --contract <ledger-dir>/00-READBEFORE.md from the integration worktree root — SKILL MATCH continues;"],
  ["orchestrate/references/protocol.md", "a conflict → STOP AND INVESTIGATE, as in the integration procedure), then git commit-tree <tree> -p <tip> -m trial, check that commit out in a temporary worktree (git worktree add <scratchpad>/wt-trial <commit>;"],
  ["orchestrate/references/protocol.md", "a stale wt-trial from a crashed trial is removed first), run the ledger's per-worktree setup there (skip only if n/a), then run the validations and remove the worktree;"],
  ["orchestrate/references/protocol.md", "From the integration tip: cut every member's branch, create every worktree (setup: the ledger's per-worktree setup), then commit the wave-open PROGRESS flip (rows → 🔄, wave base SHA in the session log, State: ACTIVE)."],
  ["orchestrate/references/protocol.md", "The cut is idempotent: a member branch that already exists with its tip equal to the current integration tip is adopted from a crashed open — its worktree, if any, removed and recreated (fresh setup);"],
  ["orchestrate/references/protocol.md", "Spawn ALL of the wave's implementers CONCURRENTLY (one per batch, in a single message, each pinned to its worktree, on the tier the batch's weight calls for)."],
  ["orchestrate/references/protocol.md", "Render each prompt first, from the integration worktree root: node \"<skill-dir>/tools/prompt.mjs\" --ledger <ledger-dir> --role implementer --batch <Bnn> --facts <facts.json> --out \"<session scratchpad>/prompts\" (--help lists each role's facts) prints PROMPT <path> NONCE <nonce>;"],
  ["orchestrate/references/protocol.md", "Worktree clean (git status --porcelain empty);"],
  ["orchestrate/references/protocol.md", "A cause that begins code changed, or a changed path that is neither Markdown nor JavaScript, returns the fold-in: one commit on the batch branch reverses only that commit's own changes (git revert --no-commit <sha>, then git restore --source=HEAD --staged --worktree -- <batch file> so its tick stays;"],
  ["orchestrate/references/protocol.md", "In a temporary worktree at the branch's base, run the ledger's per-worktree setup there (skip only if n/a), then copy over the batch's TEST-ONLY files and run its changed tests: an assertion failure on the named behavior proves the regression test;"],
  ["orchestrate/references/protocol.md", "the log outside the repository) performs this step in a disposable clone and prints one line, the failing-on-base result the reviewer receives: PROVEN (…) names the tests that fail on the base, the proof reviewer duty (e) confirms;"],
  ["orchestrate/references/protocol.md", "The reviewer gets the batch file + the diff (git diff <integration>...HEAD in the batch's worktree — three-dot isolates the batch's own changes) and must (a) map every hunk to a batch item — unmapped hunks are scope creep → reject (the batch file's ticks are exempt);"],
  ["orchestrate/references/protocol.md", "the findings go to LOG.md under the row's heading: every findings file reaches LOG.md first, closed by a newline and a marker line — from the integration worktree root, (cat -- \"<findings file>\" && echo && echo '=== end of B<NN> R<k> <role> findings ===') >> <ledger-dir>/LOG.md in Git Bash or an equivalent byte copy, never re-typed through the orchestrator's context, committed with the PROGRESS update — and only then is its path forwarded to the polish, fix-round, rework or round-2 prompt;"],
  ["orchestrate/references/protocol.md", "Integrate serially, per the integration procedure: dry run → merge → tip validation → 🟢, apply the version/changelog cadence, remove the worktree, write the row's Notes (SHA, reviewer arc, tier, residuals) ending with the metrics token m: rounds=<n> asks=<n> fence-bounces=<n> gate=<findings/prod> tip-red=<0|1>."],
  ["orchestrate/references/protocol.md", "its worktree is <the contract's worktree root>/sweep, or under the session scratchpad for a contract that names no root."],
  ["orchestrate/references/protocol.md", "The mechanical check is manual: worktree clean, and every changed path, both rename endpoints, one that a recorded item names."],
  ["orchestrate/references/protocol.md", "- No sub-agents available: the orchestrator implements a wave's batches one at a time in the main checkout (worktrees unnecessary)."],
  ["orchestrate/references/scaffolding.md", "node \"<SKILL_DIR>/tools/detect.mjs\" --repo <repo> prints one line per registry placeholder it covers (<NAME>: <value> — <source>, or <NAME>: unknown — <why>), plus PRIOR_CONTRACT, the latest ledger contract in the working tree, whose baked answers a repeat repo offers as defaults (§Interview);"],
  ["orchestrate/references/scaffolding.md", "Draft them first as a ledger in a scratch worktree of the base (git worktree add --detach <scratchpad>/wt-draft <base>), with step 8's command and an answers file whose coverage audit ends in a provisional Pre-flight: CLEAN (the scaffold's self-check requires the line) and whose foldins stay empty (their markers belong to the real fill): node \"<SKILL_DIR>/tools/scaffold.mjs\" --answers <draft answers> --repo <scratchpad>/wt-draft."],
  ["orchestrate/references/scaffolding.md", "From that worktree's root run node \"<SKILL_DIR>/tools/check-ledger.mjs\" plan --dir .agents/changes/<CHANGE_ID> --repo ., node \"<SKILL_DIR>/tools/check-ledger.mjs\" cites --dir .agents/changes/<CHANGE_ID> --repo ."],
  ["orchestrate/references/scaffolding.md", "for a PLAN FAIL, CITES FAIL or CENSUS line cut short that way, the pre-flight checks for itself what the line leaves out."],
  ["orchestrate/references/scaffolding.md", "Once the last pre-flight round is done, delete the draft ledger directory and remove its worktree (git worktree remove <scratchpad>/wt-draft, or git worktree prune once that directory is gone), so Discovery never meets the draft as a second copy of the ledger."],
  ["orchestrate/references/scaffolding.md", "When {{WORKTREE_SETUP}} is not n/a, also write setup.json, a validate.mjs spec holding the setup command(s), so a disposable checkout can be set up exactly like a worktree."],
  ["orchestrate/references/scaffolding.md", "node \"<SKILL_DIR>/tools/scaffold.mjs\" --answers <answers file> --repo <root> performs this step, <root> being the root of the worktree step 10 commits from: it builds every file in memory, holds the staged copy to parse, selfcheck and plan, and only then writes .agents/changes/<CHANGE_ID>/, its validate.json and any setup.json included, in the line-ending style of the repository's tracked Markdown, and marks the accepted fold-ins (step 10)."],
  ["orchestrate/references/scaffolding.md", "- setup — the setup.json spec, or null when {{WORKTREE_SETUP}} is n/a (an explanation may follow it)."],
  ["orchestrate/references/scaffolding.md", "use raw-byte copies and validate the delivered checkout."],
  ["orchestrate/references/scaffolding.md", "git archive <commit> orchestrate of <clone path>, a copy of <path> at <commit>, or unknown;"],
  ["orchestrate/references/scaffolding.md", "| {{WORKTREE_SETUP}} | template (READBEFORE) | detected install/build step (npm install, cargo fetch, …) or n/a |"],
  ["orchestrate/references/scaffolding.md", "| {{WORKTREE_ROOT}} | template (READBEFORE) | the interview — the absolute directory, forward slashes, that holds the integration worktree (int) and every batch worktree (b<nn>): outside the session scratchpad and outside any tmpfs (env-facts.mjs flags one), so it survives sessions and reboots."],
  ["orchestrate/references/scaffolding.md", "Default <home>/worktrees/{{CHANGE_ID}}, the full id, since two ledgers scaffolded the same day share a prefix-and-date name such as os1022;"],
  ["orchestrate/references/scaffolding.md", "It replaces the worktree-root bullet earlier contracts hand-wrote into {{REPO_CONVENTIONS}}, so a repeat scaffold does not copy that bullet |"],
  ["orchestrate/references/scaffolding.md", "Neither the current checkout nor init.defaultBranch identifies this repo's default."],
  ["orchestrate/references/smoke-page.md", "2249 / 2255 pass, from the validation run on the integration tip, never a worktree), Known failures if any |"],
  ["orchestrate/references/smoke-page.md", "The builder refuses a sidecar without change, checkpoint, batches, branch, buildSha, ckptKey, sections, or a gate with checks, both containment commands and the tested SHA among them (write it out in each, as §The gate (Step 0) gives them);"],
  ["orchestrate/references/smoke-page.md", "\\\":(exclude).agents/\\\"\" ], \"checks\": [ \"The second command prints <code>chore/example-ledger</code>.\", \"The containment commands exit 0, and the last prints nothing.\" ] }, \"sections\": [ {\"n\": 1, \"title\": \"The report command\", \"touchesData\": false, \"lede\": \"The command this change adds.\", \"need\": \"A terminal at the checkout root.\", \"steps\": [ {\"n\": 1, \"revision\": 1, \"do\": \"Run <code>example report --help</code>.\", \"pass\": \"It exits 0 and prints its usage.\", \"aside\": \"It writes no file.\"}, {\"n\": 2, \"do\": \"Run <code>example report</code>.\", \"pass\": \"It prints one line per batch.\"} ]}, {\"n\": 2, \"title\": \"The copied results\", \"steps\": [ {\"n\": 3, \"do\": \"Press <strong>Copy results as text</strong>.\", \"pass\": \"The copied text names build <code>4f6b2c1</code>.\"} ]} ] }"],
  ["orchestrate/references/smoke-page.md", "The exact fetch/checkout commands for the integration branch, in the user's shell dialect, including known gotchas (e.g."],
  ["orchestrate/references/smoke-page.md", "an untracked ledger copy blocking checkout)."],
  ["orchestrate/references/smoke-page.md", "if it reads 0.13.0, stop — the checkout did not take)."],
  ["orchestrate/references/smoke-page.md", "verify effective attributes and a fresh core.autocrlf=true checkout (including LF/CRLF sentinels and an unprotected conversion control)."],
  ["orchestrate/references/subagent-prompts.md", "Work in your isolated worktree at [WORKTREE_PATH], already checked out on your batch branch ([BATCH_BRANCH])."],
  ["orchestrate/references/subagent-prompts.md", "Setup first: [WORKTREE_SETUP]."],
  ["orchestrate/references/subagent-prompts.md", "Stay inside the worktree — do not create or switch branches, never push, never touch the main checkout, never leave untracked files in the worktree (scratch goes under [SCRATCHPAD_PATH])."],
  ["orchestrate/references/subagent-prompts.md", "Run the validation from the worktree root as node \"[SKILL_DIR]/tools/validate.mjs\" --spec [LEDGER_DIR]/validate.json --log \"[SCRATCHPAD_PATH]/<label>.log\": its one line is the result and its exit code the real one."],
  ["orchestrate/references/subagent-prompts.md", "Main-checkout variant (degraded environments, or a width-1 wave run directly in the repo): replace the worktree paragraph with \"Work on the CURRENT branch ([BATCH_BRANCH]) — do not create or switch branches, never push.\" A rendered file takes no such edit, so this variant is always the manual procedure (§Spawning rules)."],
  ["orchestrate/references/subagent-prompts.md", "Run the validation from the worktree root as node \"[SKILL_DIR]/tools/validate.mjs\" --spec [LEDGER_DIR]/validate.json --log \"[SCRATCHPAD_PATH]/<label>.log\": its one line is the result and its exit code the real one."],
  ["orchestrate/references/subagent-prompts.md", "Work in the batch's worktree at [WORKTREE_PATH] (checked out on [BATCH_BRANCH])."],
  ["orchestrate/references/subagent-prompts.md", "besides that ONE file you write only validation logs and disposable scratch under \"[SCRATCHPAD_PATH]\", never inside any worktree or the repository."],
  ["orchestrate/references/subagent-prompts.md", "Beyond those, run only the two harness tools PROOF below names, which work on disposable clones."],
  ["orchestrate/references/subagent-prompts.md", "Worktree: [WORKTREE_PATH]."],
  ["orchestrate/references/subagent-prompts.md", "Run node \"[SKILL_DIR]/tools/mutate.mjs\" --repo \"[WORKTREE_PATH]\" --ref HEAD --mutations \"<mutations file>\" --validate \"<scoped spec>\" --log \"[SCRATCHPAD_PATH]/<label>.log\", adding --setup \"[WORKTREE_PATH]/[LEDGER_DIR]/setup.json\" when that file exists (a repository with a setup step fails its control without it)."],
  ["orchestrate/references/subagent-prompts.md", "when that may outlast the runtime's command timeout, run it as a background task whose completion reports its lines and exit code, or pass --timeout and split the mutations across runs — a run the command timeout kills never cleans up its clone."],
  ["orchestrate/references/subagent-prompts.md", "besides that ONE file you write only your mutations file and your scoped spec, both under \"[SCRATCHPAD_PATH]\", never inside any worktree or the repository, and running mutate.mjs and run-at-ref.mjs, which write only disposable clones and their logs, is permitted."],
  ["orchestrate/references/subagent-prompts.md", "You are the QA RUNNER for checkpoint C[N] of [CHANGE_ID] in [REPO_PATH], on the integration tip [INTEGRATION_SHA] in the integration worktree [WT_INT_PATH]."],
  ["orchestrate/references/subagent-prompts.md", "Work in the worktree [WORKTREE_PATH], checked out on [FIXUP_BRANCH] (cut from the integration tip [INTEGRATION_SHA])."],
  ["orchestrate/references/subagent-prompts.md", "a conflict is STOP AND INVESTIGATE), then git commit-tree <tree> -p <tip> -m trial, check that commit out in a temporary worktree (git worktree add <scratchpad>/wt-trial <commit>;"],
  ["orchestrate/references/subagent-prompts.md", "a stale wt-trial from a crashed trial is removed first), run the ledger's per-worktree setup there (skip only if n/a), then run the validations and remove the worktree;"],
  ["orchestrate/references/subagent-prompts.md", "- Render, then point: node \"<skill-dir>/tools/prompt.mjs\" --ledger <ledger-dir> --role <role> --batch <Bnn> --facts <facts.json> --out \"<scratchpad>/prompts\" renders one of the seven per-batch prompts (roles implementer, polish, fix-round, rework, reviewer, reviewer-round2, test-hunter;"],
  ["orchestrate/references/subagent-prompts.md", "A gate agent's findingsFile is <scratchpad>/gates/<change-id>-B<NN>-R<k>-<role>.md;"],
  ["orchestrate/references/subagent-prompts.md", "the orchestrator creates <scratchpad>/gates/ before the spawn (the renderer creates its --out), and a gate agent respawned after a wrong nonce gets a new findingsFile (-2, -3… before .md), so a discarded agent's file never reaches LOG.md."],
  ["orchestrate/references/subagent-prompts.md", "- Findings travel by path, and reach LOG.md first: the orchestrator appends each findings file to the ledger's LOG.md byte-for-byte on the integration worktree, then a newline and a closing marker line — (cat -- \"<findings file>\" && echo && echo '=== end of B<NN> R<k> <role> findings ===') >> <ledger-dir>/LOG.md from Git Bash, or an equivalent byte copy, never re-typed through its own context — commits it with the PROGRESS update, and only then forwards the path, as the findingsFile of a polish, fix-round or rework prompt or the previousFindingsFile of a round-2 review."],
  ["orchestrate/references/subagent-prompts.md", "anything longer belongs in a commit message or under the session scratchpad, never in the orchestrator's context and never as an untracked file in a worktree."],
  ["orchestrate/templates/PROGRESS.md", "- ⬜ Not Started · 🔄 In Progress · 🟢 Integrated (reviewed, validations green on the worktree AND the integration tip, merged;"],
  ["README.md", "The work then runs in waves: file-disjoint batches implemented concurrently, one implementer per batch, each on its own branch in an isolated git worktree, stacking serially onto an integration branch."],
  ["README.md", "Before any reviewer is spent, git diff --name-status against the integration branch must stay inside the fence (both ends of a rename, clean worktree)."],
  ["README.md", "The orchestrator never switches your checkout: it reads branches with git show and writes through an integration worktree of its own."],
  ["README.md", "Clone the repo and point your Claude Code skills folder at it, so the checked-out repo IS the deployed skill and there is nothing to keep in sync."],
  ["README.md", "bash git clone https://github.com/hopefullyanonymous/wave-orchestrator.git && ln -s \"$PWD/wave-orchestrator/orchestrate\" ~/.claude/skills/orchestrate"],
  ["README.md", "powershell git clone https://github.com/hopefullyanonymous/wave-orchestrator.git;"],
  ["README.md", "Whatever branch the clone has checked out is what runs — stay on main."],
  ["README.md", "Update an installed copy (a git pull in the clone counts) only between ledgers: a ledger's contract pins the skill's hash, and an updated copy stops that ledger's next session and asks."],
  ["README.md", "From the root of your clone, copy the plugin to ~/.claude/orchestrate-mod/."],
  ["README.md", "The setting names the installed copy, never the clone: loading a mod writes generated files into the directory it loads from."],
  ["README.md", "- Sub-agents are used for census agents, implementers, reviewers, gate agents and the QA runner, but aren't required — without them the orchestrator implements a wave's batches one at a time in the main checkout and still runs the review as a separate adversarial pass per batch."],
  ["README.md", "├── mutate.mjs proves chosen mutations on a disposable clone: control first, then KILLED or SURVIVED each, restored byte for byte"],
  ["README.md", "├── run-at-ref.mjs runs a validation spec on a disposable clone of any ref: one AT line, validate.mjs's exit code"],
  ["README.md", "├── failing-on-base.mjs runs protocol step 6b in a disposable clone: PROVEN, ALL-PASS (P0) or INCONCLUSIVE, one line"],
];
// The placement as one phrase, read across the whole shipped tree and README, code included (documents()): a tool's
// comment or message putting a worktree in the scratchpad directs as a document does. Its words may be parted by
// whitespace, a comment's slashes or asterisks, or a string concatenation's quotes and plus.
const PHRASE_GAP = String.raw`(?:\s|\/\/|[*'"+])+`;
const SCRATCH_PHRASE = new RegExp((String.raw`\b(?:work(?:ing)?[\W_]*trees?|check[\W_]*outs?|clones?)(?:GAPperGAPbatch)?GAP(?:under|in|inside|within|into|at)GAP`
  + String.raw`(?:(?:the|a|your)GAP)?(?:session(?:['’]s)?GAP)?(?:scratch[\W_]*pad\b|<(?:session\s+)?scratchpad>|\[SCRATCHPAD_PATH\])`).replace(/GAP/g, () => PHRASE_GAP), 'gi');
const scratchPhraseFaults = texts => texts.flatMap(([file, text]) => [...collapse(text.replace(/`/g, '')).matchAll(SCRATCH_PHRASE)].map(m => file + ': ' + m[0]));
const scratchTreeTexts = () => proseDocuments().filter(file => file !== TEMPLATE).map(file => [file, read(file)]);
test("the worktrees live under the contract's worktree root, the session scratchpad only without one, in every document that places them", () => {
  const texts = scratchTreeTexts(), files = texts.map(([file]) => file);
  assert.ok(['orchestrate/SKILL.md', 'orchestrate/references/execution-models.md', 'orchestrate/references/protocol.md', 'orchestrate/references/scaffolding.md',
    'orchestrate/references/subagent-prompts.md', 'README.md'].every(file => files.includes(file)) && !files.includes(TEMPLATE), 'the domain holds every carrier and README, the template left out');
  assert.deepEqual(closedFaults(texts, namesTree, SCRATCH_TREE_UNITS), []);
  const everything = documents().map(file => [file, read(file)]);
  assert.ok(everything.some(([file]) => file === 'orchestrate/tools/prompt.mjs') && everything.some(([file]) => file === 'README.md'), 'the phrase domain is the whole shipped tree, code included, and README');
  assert.deepEqual(scratchPhraseFaults(everything), []);
  const swap = (file, edit) => texts.map(([f, text]) => [f, f === file ? edit(text) : text]);
  // Live: each of the four places put back to the session scratchpad alone, one at a time, is reported as an unlisted
  // unit and its listed one gone. Every outcome is read before the one comparison.
  const loose = new RegExp(escapeRe(WORKTREE_FALLBACK).split(' ').join('\\s+'), 'g'), reverted = [];
  for (const [file, n] of [['orchestrate/SKILL.md', 1], ['orchestrate/references/execution-models.md', 1], ['orchestrate/references/protocol.md', 2]]) {
    for (let k = 0; k < n; k++) {
      const faults = closedFaults(swap(file, text => { let seen = -1; return text.replace(loose, m => ++seen === k ? 'under the session scratchpad' : m); }), namesTree, SCRATCH_TREE_UNITS);
      reverted.push([file, k, faults.length === 2 && faults[0].startsWith(file + ' :: ') && faults[0].includes('under the session scratchpad') && !faults[0].includes(WORKTREE_FALLBACK)
        && faults[1].startsWith('gone: ' + file + ' :: ') && faults[1].includes(WORKTREE_FALLBACK)]);
    }
  }
  assert.deepEqual(reverted, reverted.map(([file, k]) => [file, k, true]), 'each place put back to the session scratchpad must be reported');
  // Live: a placement in other words — README's old scratch worktree, a scratch worktree, a `<scratchpad>/b<nn>` path
  // with and without a worktree named, the session's scratchpad, a clone and a branch checked out there, git's working
  // tree there, a worktree under /tmp, at the repository root, in the repo, on a tmpfs mount and in $TMPDIR — each
  // reported as the one unlisted unit, and README's listed sentence, where a plant rewords it, as gone.
  const README_LINE = 'writes through an integration worktree of its own.', CHANGE = 'accumulates the change.';
  const README_UNIT = 'The orchestrator never switches your checkout: it reads branches with git show and writes through an integration worktree of its own.';
  const PLANTS = [
    ['README.md', README_LINE, 'writes through a scratch worktree.',
      'The orchestrator never switches your checkout: it reads branches with git show and writes through a scratch worktree.', README_UNIT],
    ['orchestrate/references/protocol.md', CHANGE, CHANGE + ' The orchestrator writes through a scratch worktree.', 'The orchestrator writes through a scratch worktree.'],
    ['orchestrate/references/protocol.md', CHANGE, CHANGE + ' Batch worktrees are added at `<scratchpad>/b<nn>`.', 'Batch worktrees are added at <scratchpad>/b<nn>.'],
    ['orchestrate/references/protocol.md', CHANGE, CHANGE + ' Each batch runs in `<scratchpad>/b<nn>`.', 'Each batch runs in <scratchpad>/b<nn>.'],
    ['README.md', README_LINE, "writes through a worktree under the session's scratchpad.",
      "The orchestrator never switches your checkout: it reads branches with git show and writes through a worktree under the session's scratchpad.", README_UNIT],
    ['orchestrate/SKILL.md', '- No `--no-verify`', '- Each batch is cloned into the scratch pad.\n- No `--no-verify`', '- Each batch is cloned into the scratch pad.'],
    ['orchestrate/references/execution-models.md', 'The main checkout is\n   never switched.', 'The main checkout is\n   never switched. Each batch branch is checked out in the session scratchpad.',
      'Each batch branch is checked out in the session scratchpad.'],
    ['orchestrate/references/protocol.md', CHANGE, CHANGE + ' Each batch gets its own working tree under the session scratchpad.', 'Each batch gets its own working tree under the session scratchpad.'],
    ['orchestrate/references/protocol.md', CHANGE, CHANGE + ' On a machine short of disk, add each batch worktree under `/tmp/<id>` instead.',
      'On a machine short of disk, add each batch worktree under /tmp/<id> instead.'],
    ['orchestrate/references/protocol.md', CHANGE, CHANGE + ' Each batch worktree is added at the repository root.', 'Each batch worktree is added at the repository root.'],
    ['orchestrate/references/protocol.md', CHANGE, CHANGE + ' Batch worktrees live in the repo.', 'Batch worktrees live in the repo.'],
    ['orchestrate/references/protocol.md', CHANGE, CHANGE + ' Each batch worktree may go on a tmpfs mount for speed.', 'Each batch worktree may go on a tmpfs mount for speed.'],
    ['orchestrate/references/protocol.md', CHANGE, CHANGE + ' On a machine short of space, add each batch worktree in $TMPDIR instead.',
      'On a machine short of space, add each batch worktree in $TMPDIR instead.'],
  ];
  const planted = PLANTS.map(([file, anchor, put]) => {
    const text = read(file);
    assert.equal(text.split(anchor).length, 2, file + ': the control anchor must be found once — ' + anchor);
    return closedFaults(swap(file, () => text.replace(anchor, () => put)), namesTree, SCRATCH_TREE_UNITS);
  });
  assert.deepEqual(planted, PLANTS.map(([file, , , unit, gone]) => [file + ' :: ' + unit, ...(gone ? ['gone: ' + file + ' :: ' + gone] : [])]),
    'each placement in other words must be reported');
  // Live: the phrase in a tool's one-line comment, in a comment wrapped over two lines, in a string concatenation and in
  // a README sentence is reported.
  const PROMPT_TOOL = 'orchestrate/tools/prompt.mjs', inCode = '\n// Batch worktrees under the session scratchpad.\n';
  const phrased = [[PROMPT_TOOL, inCode, 'worktrees under the session scratchpad'],
    [PROMPT_TOOL, '\n// Batch worktrees under the\n// session scratchpad.\n', 'worktrees under the // session scratchpad'],
    [PROMPT_TOOL, "\nconst NOTE = 'Batch worktrees under the ' +\n  'session scratchpad.';\n", "worktrees under the ' + 'session scratchpad"],
    ['README.md', inCode, 'worktrees under the session scratchpad']];
  assert.deepEqual(phrased.map(([file, put]) => scratchPhraseFaults(everything.map(([f, text]) => [f, f === file ? text + put : text]))),
    phrased.map(([file, , found]) => [file + ': ' + found]), 'the phrase in code, wrapped or concatenated, and in README must be reported');
});

// The skill's Markdown — every shipped .md file, the template, smoke-page.md and the three that order the run among
// them — read with the passages pinned whole elsewhere cut out, each cut ending where its pin ends: every BUDGET
// passage, SKILL.md's dispatch line (CONTINUE_ID), its Mode: continue step 3 through the last sentence
// tests/census-step.test.cjs REVIEWED_SENTENCES holds there, and protocol.md's §Recovery table through its last line
// opening with `|`, as tests/protocol-contract.test.cjs `table()` hashes it. Three families are closed over it: a unit
// naming a cleared or reopened conversation, or the mod that opens one (BL-101); a unit naming a close-out in any form
// (BL-100); and, in SKILL.md's Mode: continue and §Refusals, a unit naming a session or a conversation. Each unit a
// family reads is doubt unless PROCEDURE_UNITS lists it under that family.
const procedureFiles = () => shipped().filter(file => file.endsWith('.md'));
const TABLE_END = Symbol('the last line opening with |');
// A cut ending just after `sentence`: a list item's group as tests/census-step.test.cjs reads it.
const through = sentence => ({ through: sentence });
// Where a cut opening at `start` ends: just before `to` when it is a string, as section() bounds a BUDGET passage; just
// after `to.through`; or, for TABLE_END, at the end of the last line opening with `|`.
function cutEnd(text, start, to) {
  if (typeof to === 'string') return text.indexOf(to, start + 1);
  if (to === TABLE_END) {
    let end = start;
    for (const line of text.slice(start).split('\n')) { if (!/^\s*\|/.test(line)) break; end += line.length + 1; }
    return end - 1;
  }
  const at = text.indexOf(to.through, start + 1);
  return at === -1 ? -1 : at + to.through.length;
}
const PROCEDURE_CUTS = [
  ...Object.values(BUDGET).map(([file, from, to]) => [file, from, to]),
  ['orchestrate/SKILL.md', '\n- `continue', '\n- `status`'],
  ['orchestrate/SKILL.md', '\n3. Boot', through('live in [references/subagent-prompts.md](references/subagent-prompts.md).')],
  ['orchestrate/references/protocol.md', '| Ledger says | Git shows | Verdict |', TABLE_END],
];
const PROCEDURE_FAMILIES = {
  'a cleared conversation': { pattern: /\bclear(?:s|ed|ing)?\b|\brestart|\bre-?open|orchestrate-mod|\bthe mod\b|\bfresh conversation/i },
  'a close-out': { pattern: /\bclos(?:e|ed|es|ing)[\W_]*outs?\b|\bcloseouts?\b/i },
  'a session or a conversation': { pattern: /\bsessions?\b|\bconversations?\b/i,
    within: { 'orchestrate/SKILL.md': [['## Mode: continue', '\n## Mode: status'], ['## Refusals', '\n## Skill files']] } },
};
// Step 8's opening points at the window its compaction passage opens, before the close-out it spells out (C1 of
// OS-20261022); the pointer is a unit of both families below, and the test after the sweep holds its place.
const STEP_8_POINTER = "The window at the end of this step, where the conversation may be cleared, opens before a checkpoint's close-out begins.";
const PROCEDURE_UNITS = {
  "a cleared conversation": [
    ["orchestrate/SKILL.md", "A session that orchestrate-mod opened when it cleared the conversation reads the contract's §Boot sequence first, then only what that section names for such a session, or the whole contract when it names nothing for one."],
    ["orchestrate/references/protocol.md", "Timestamp each human verdict, clear, and note edit locally as at, advancing beyond the step's previous/observed timestamp."],
    ["orchestrate/references/protocol.md", "Different local/remote tips do not matter when the recorded source is clear."],
    ["orchestrate/references/protocol.md", "the per-spawn token saving is forfeited until the definitions are installed — copy the skill repo's .claude/agents/.md into ~/.claude/agents/ (or one project's .claude/agents/), then restart Claude Code."],
    ["orchestrate/references/protocol.md", STEP_8_POINTER],
    ["orchestrate/references/smoke-page.md", "Selecting the same current verdict again clears it."],
    ["orchestrate/references/smoke-page.md", "Each local verdict selection, clear, or note edit records at immediately in localStorage."],
    ["orchestrate/references/subagent-prompts.md", "Before you report, end every background command you started (run_in_background, or a command moved to the background at its timeout): wait for it to finish or kill it, since one still running when you hand back leaves you waiting (Claude Code shows completed), blocks the orchestrator's context clear, and resumes you when it ends."],
    ["orchestrate/references/subagent-prompts.md", "Before you report, end every background command you started (run_in_background, or a command moved to the background at its timeout): wait for it to finish or kill it, since one still running when you hand back leaves you waiting (Claude Code shows completed), blocks the orchestrator's context clear, and resumes you when it ends."],
    ["orchestrate/references/subagent-prompts.md", "Before you report, end every background command you started (run_in_background, or a command moved to the background at its timeout): wait for it to finish or kill it, since one still running when you hand back leaves you waiting (Claude Code shows completed), blocks the orchestrator's context clear, and resumes you when it ends."],
    ["orchestrate/references/subagent-prompts.md", "Before you report, end every background command you started (run_in_background, or a command moved to the background at its timeout): wait for it to finish or kill it, since one still running when you hand back leaves you waiting (Claude Code shows completed), blocks the orchestrator's context clear, and resumes you when it ends."],
    ["orchestrate/templates/00-READBEFORE.md", "Change: {{CHANGE_ID}} Skill: {{SKILL_DIR}} · sha256 {{SKILL_SHA256}} Skill source: {{SKILL_SOURCE}} Clear threshold: {{CLEAR_THRESHOLD}} You are either the ORCHESTRATOR (the main session the user told to \"continue\") or an IMPLEMENTER/REVIEWER/GATE sub-agent given one batch."],
    ["orchestrate/templates/00-READBEFORE.md", "A session that /orchestrate continue <id> after-clear opened reads none of 00-request.md, 01-plan.md and PROGRESS.md: once the pin check (step 3) passes it reads the digest that node \"{{SKILL_DIR}}/tools/reconcile.mjs\" digest --repo <repo> --ledger {{CHANGE_ID}} --integration refs/heads/{{INTEGRATION_BRANCH}} prints, and of this contract only §Boot sequence, §Git model, §Validation commands and §Hard prohibitions, reading any other section by its heading when a step needs it."],
  ],
  "a close-out": [
    ["orchestrate/SKILL.md", "At planning and checkpoint close-out, the conductor inventories, generates, independently validates and delivers actual reproducible inputs per smoke step."],
    ["orchestrate/SKILL.md", "Final checkpoint ✅ → change-complete close-out per protocol.md with the contract's facts: convergence pass (when the contract turns it on, a fresh read-only sub-agent classifies every item against the tip;"],
    ["orchestrate/SKILL.md", "a ledger with every row ✅ or ⛔ (dropped) (advisory 👤 rows aside) and no COMPLETE marker resumes the change-complete close-out at its first unfinished step), distillation (new bug classes → one-line guardrails with pointers;"],
    ["orchestrate/SKILL.md", "The final checkpoint's close-out begins with the run-end prose sweep whenever LOG.md holds a ### prose sweep: heading (protocol.md)."],
    ["orchestrate/references/execution-models.md", "checkpoint close-out generates reproducible synthetic files, independently validates requirements, and delivers exact linked files with Pass results and working-copy/reset instructions."],
    ["orchestrate/references/execution-models.md", "At the checkpoint close-out a QA runner performs the agent steps on the integration tip and records evidence;"],
    ["orchestrate/references/execution-models.md", "This is not hypothetical: a pack that deferred its single bump to close-out handed over a script saying \"confirm the version reads X\" when the base branch also read X;"],
    ["orchestrate/references/execution-models.md", "Bumping the minor at each checkpoint burns a release number per checkpoint — one pack went 0.11 → 0.12 → 0.13 → 0.14 on a 0.10.12 base and was renumbered to a single 0.11.0 at close-out."],
    ["orchestrate/references/protocol.md", "| smoke-<Cn>.html | Created at each checkpoint close-out;"],
    ["orchestrate/references/protocol.md", "At the FINAL checkpoint the Close-out unfinished row's close-out begins with the run-end prose sweep whenever LOG.md holds a ### prose sweep: heading, resumed from its branch by §Session algorithm step 8's adoption rule."],
    ["orchestrate/references/protocol.md", "Owns PROGRESS, LOG, evidence/, branches, worktrees, integration merges, close-outs, and all user communication."],
    ["orchestrate/references/protocol.md", "- QA runner — one sub-agent executing the agent-runnable smoke steps at a checkpoint close-out, writing evidence/C<n>/."],
    ["orchestrate/references/protocol.md", "see scaffolding.md and §Two close-outs."],
    ["orchestrate/references/protocol.md", "PROGRESS also carries State: ACTIVE | AT-CHECKPOINT C<n> | USER-BLOCKED | COMPLETE, updated at every wave open, checkpoint close-out and change-complete."],
    ["orchestrate/references/protocol.md", "The conductor inventories required files per smoke step at planning and checkpoint close-out."],
    ["orchestrate/references/protocol.md", "A failing agent step is a defect found before the user's time is spent: rows stay 🟢, the failure goes to Notes + evidence, a repair mini-batch fixes it, then the close-out resumes — it is NEVER ❌, which means the USER reached the checkpoint and failed it."],
    ["orchestrate/references/protocol.md", "A checkpoint whose close-out has not run — every member of its wave 🟢, ⛔ or 👤 and its row not 🧪/✅, §Recovery's Close-out unfinished row — goes to step 8's per-checkpoint close-out before any wave opens."],
    ["orchestrate/references/protocol.md", "A ledger with every row ✅ or ⛔ (dropped) (advisory 👤 rows aside) and no COMPLETE marker, met by continue or close, goes to the change-complete close-out's first unfinished step."],
    ["orchestrate/references/protocol.md", "A tip the run-end prose sweep's merge turned red (step 8) takes this repair, the sweep counting as the last batch's merge, and once green the run returns to the close-out, not to step 7 or 4."],
    ["orchestrate/references/protocol.md", STEP_8_POINTER],
    ["orchestrate/references/protocol.md", "Whenever LOG.md holds a ### prose sweep: heading, the FINAL checkpoint's close-out begins with this sweep;"],
    ["orchestrate/references/protocol.md", "The sweep being the close-out's first step, a crash in it meets §Recovery's Close-out unfinished row, the rows staying 🟢 and State ACTIVE throughout, and the close-out resumes the sweep from its branch by the adoption rule above (no branch: cut at the recorded SHA)."],
    ["orchestrate/references/protocol.md", "If the checkpoint table places a checkpoint here: per-checkpoint close-out (a ⛔ member's steps are omitted from the page and appended on re-issue if it later ships) — version/changelog per cadence, tip validation, QA runner pre-smoke with evidence, covered rows 🟢 → 🧪, checkpoint-table row, session-log row with the checkpoint's integration SHA, State: AT-CHECKPOINT C<n>, the checkpoint row's token m: pre-smoke=<agent>/<human> human-smoke-min=<n> escaped=<n> (completed when the user's verdict is recorded), the filled smoke page as smoke-<Cn>.html when a page was prepared, then proof the published artifact (§Two distinct close-outs), commit → STOP, delivering the checkpoint's COMBINED smoke script per §Smoke checkpoints."],
    ["orchestrate/references/protocol.md", "## Two distinct close-outs"],
    ["orchestrate/references/protocol.md", "The FINAL checkpoint's close-out runs the run-end prose sweep (step 8) before all of these whenever LOG.md holds a ### prose sweep: heading."],
    ["orchestrate/references/protocol.md", "Fold-ins are REMOVED from the backlog file in the close-out commit (the ledger row and commit message carry provenance);"],
    ["orchestrate/references/protocol.md", "A ledger with every row ✅ or ⛔ (dropped) (advisory 👤 rows aside) and no COMPLETE marker resumes the change-complete close-out at its first unfinished step, by continue or close: a committed ### Ruling list with no recorded ruling is presented."],
    ["orchestrate/references/protocol.md", "Distillation loop: any NEW bug class this change uncovered → ONE-LINE guardrail bullet in the project guardrails doc naming the class and pointing at the test or mechanism doc that enforces it (prefer adding the test in this close-out)."],
    ["orchestrate/references/scaffolding.md", "A single bump deferred to close-out leaves the integration branch sharing a version with the branch it was cut from — so the smoke script's \"confirm the version\" step cannot distinguish them and passes on the wrong build."],
    ["orchestrate/references/scaffolding.md", "A pack that read \"bump per checkpoint\" as a minor bump each time burned four minor versions on a single change (0.11 → 0.12 → 0.13 → 0.14 against a base of 0.10.12) and had to be renumbered to 0.11.0 at close-out."],
    ["orchestrate/references/scaffolding.md", "only if detection found no guardrails section or backlog file: create them at first close-out? (default yes)."],
    ["orchestrate/references/scaffolding.md", "Each decision is asked ONCE, its answer recorded verbatim in 00-request.md, and never re-litigated at plan approval or at close-out."],
    ["orchestrate/references/smoke-page.md", "Inventory them at planning, including workbook sheets/columns/types/formulas/edge cases, then deliver the exact files at close-out with expected results and working-copy/reset instructions."],
    ["orchestrate/references/smoke-page.md", "Write the filled page into the ledger as smoke-<Cn>.html and commit it in the per-checkpoint close-out commit (update it on corrections)."],
    ["orchestrate/templates/00-READBEFORE.md", "Procedure: protocol.md, hashed with the rest of the pinned directory, now governs what this contract leaves unstated — role duties, severity and round accounting, §Fence changes, §Recovery, §Session algorithm and both close-outs."],
    ["orchestrate/templates/00-READBEFORE.md", "- Orchestrator — owns PROGRESS, LOG, evidence/, branches, worktrees, merges, close-outs, all user communication."],
    ["orchestrate/templates/00-READBEFORE.md", "- QA runner — one sub-agent that executes the agent-runnable smoke steps at a checkpoint close-out and writes evidence."],
    ["orchestrate/templates/00-READBEFORE.md", "- Bump cadence: {{VERSION_BUMP_RULE}} — applied on the integration branch at integration or checkpoint close-out, never inside a wave worktree."],
    ["orchestrate/templates/00-READBEFORE.md", "If all three lines say none, skip version/changelog work at close-out and say so."],
    ["orchestrate/templates/00-READBEFORE.md", "The change-complete close-out is protocol.md §Two distinct close-outs, run with these facts:"],
    ["orchestrate/templates/01-plan.md", "The conductor supplies actual usable files and evidence at close-out;"],
    ["orchestrate/templates/PROGRESS.md", "Update it in the same commit as every wave open, checkpoint close-out and change-complete."],
    ["orchestrate/templates/PROGRESS.md", "<!-- At close-out link the sidecar's stable-id input registry, exact immutable issue files and independent validation evidence, raw hash/size manifest and usable delivery location."],
    ["orchestrate/templates/PROGRESS.md", "Then append one row per session, ≤200 characters: waves opened with base SHAs, batches integrated, reconciliations, checkpoint close-outs with integration SHAs, and exactly why work halted (checkpoint, ⛔, user input needed, COMPLETE)."],
  ],
  "a session or a conversation": [
    ["orchestrate/SKILL.md", "A session that orchestrate-mod opened when it cleared the conversation reads the contract's §Boot sequence first, then only what that section names for such a session, or the whole contract when it names nothing for one."],
  ],
};
// Each file of the domain as `reader` gives it, every cut passage, each bounded in the file as given (one passage's end
// can be the next one's anchor), replaced by a block break so no unit joins across it; and a fault for each line at
// column 0 after the first inside a cut ending after a sentence: that line opens a group the census-step reader no
// longer counts as the item's.
function procedureTexts(reader = read) {
  const faults = [];
  const texts = procedureFiles().map(file => {
    const text = reader(file);
    const ranges = PROCEDURE_CUTS.filter(([cut]) => cut === file).map(([, from, to]) => {
      const start = text.indexOf(from), end = cutEnd(text, start, to);
      assert.ok(text.split(from).length === 2 && end > start, file + ': the cut must resolve once — ' + JSON.stringify(from));
      if (to.through) {
        faults.push(...text.slice(start, end).split('\n').filter(line => line.trim()).slice(1).filter(line => !/^[ \t]/.test(line))
          .map(line => 'the cut ' + JSON.stringify(from.trim()) + ' in ' + file + ' has a line at column 0: ' + line));
      }
      return [start, end];
    }).sort((x, y) => x[0] - y[0]);
    let kept = '', at = 0;
    for (const [start, end] of ranges) {
      assert.ok(start >= at, file + ': two cuts overlap');
      kept += text.slice(at, start) + '\n\n';
      at = end;
    }
    return [file, kept + text.slice(at)];
  });
  return { texts, faults };
}
function procedureFaults(reader = read) {
  const { texts, faults } = procedureTexts(reader);
  return [...faults, ...Object.entries(PROCEDURE_FAMILIES).flatMap(([what, { pattern, within }]) => {
    const scoped = within ? texts.filter(([file]) => within[file]).map(([file, text]) => [file, within[file].map(([from, to]) => section(text, from, to)).join('\n\n')]) : texts;
    return closedFaults(scoped, unit => pattern.test(unit), PROCEDURE_UNITS[what]).map(fault => what + ': ' + fault);
  })];
}
test("the skill's Markdown names a cleared conversation, a close-out, and in SKILL.md's continue and refusals a session, only in the units PROCEDURE_UNITS lists", () => {
  assert.deepEqual(Object.keys(PROCEDURE_UNITS), Object.keys(PROCEDURE_FAMILIES), 'each family has its list');
  const files = procedureFiles();
  assert.ok(['orchestrate/SKILL.md', 'orchestrate/references/execution-models.md', 'orchestrate/references/protocol.md', 'orchestrate/references/smoke-page.md', TEMPLATE]
    .every(file => files.includes(file)) && files.every(file => file.startsWith('orchestrate/') && file.endsWith('.md')), 'the domain is every shipped Markdown file');
  assert.deepEqual(procedureFaults(), []);
  // Live: each planted unit is reported by its family alone, and a listed one reworded is reported with its listed
  // form gone. A plant inside a cut passage is not read here: the pin holding that passage reports it. A plant just past
  // a cut's end is read, and a line at column 0 inside the step 3 cut is reported.
  const SKILL = 'orchestrate/SKILL.md', PROTOCOL = 'orchestrate/references/protocol.md', MODELS = 'orchestrate/references/execution-models.md';
  const SMOKE = 'orchestrate/references/smoke-page.md';
  const REFUSALS = '## Refusals\n', STEP_3 = 'goes to step 8\'s per-checkpoint close-out\n   before any wave opens.';
  const SKILL_STEP_3_END = 'live in [references/subagent-prompts.md](references/subagent-prompts.md).\n', LAST_ROW = '| ⬜ | no such branch | Correct state — waits for its wave |\n';
  const STEP_7_END = 'tip → repair mini-batch before any further merge.', SKILL_STEP_3_TAIL = '   Render the per-batch prompts with';
  const plant = (file, anchor, put) => procedureFaults(f => {
    const text = read(f);
    if (f !== file) return text;
    assert.equal(text.split(anchor).length, 2, file + ': the control anchor must be found once — ' + anchor);
    return text.replace(anchor, () => put);
  });
  const C = 'a cleared conversation: ', W = 'a close-out: ', S = 'a session or a conversation: ';
  const WHOLE = 'A session that orchestrate-mod opened when it cleared the conversation reads the whole contract before its §Boot sequence.';
  const AFTER_NEXT = 'A checkpoint whose close-out has not run is closed out only once the next wave has closed.';
  const REFUSED = '- A session orchestrate-mod opened when it cleared the conversation → read the whole contract before its §Boot sequence.';
  const BEFORE_CLEAR = 'Run the whole close-out before any clear, so it never runs in a fresh conversation.';
  const STEP_3_UNIT = PROCEDURE_UNITS['a close-out'].find(([, unit]) => unit.startsWith('A checkpoint whose close-out'))[1];
  const POINTER_AFTER = STEP_8_POINTER.replace("opens before a checkpoint's close-out begins.", () => "opens once a checkpoint's close-out has ended.");
  const controls = [
    ['a cleared session sent to the whole contract', plant(SKILL, REFUSALS, REFUSALS + '\n' + REFUSED + '\n'), [C + SKILL + ' :: ' + REFUSED, S + SKILL + ' :: ' + REFUSED]],
    ['the mod named without a clear', plant(SKILL, REFUSALS, REFUSALS + '\n- A session the mod opened reads the whole contract first.\n'),
      [C + SKILL + ' :: - A session the mod opened reads the whole contract first.', S + SKILL + ' :: - A session the mod opened reads the whole contract first.']],
    ['a session named with no clear word', plant(SKILL, REFUSALS, REFUSALS + '\n- A session started after an automatic reset → read the whole contract before its §Boot sequence.\n'),
      [S + SKILL + ' :: - A session started after an automatic reset → read the whole contract before its §Boot sequence.']],
    ['a fresh conversation', plant(MODELS, 'The main checkout is\n   never switched.', 'The main checkout is\n   never switched. A fresh conversation skips resume-time validation.'),
      [C + MODELS + ' :: A fresh conversation skips resume-time validation.']],
    ['a fourth step just past SKILL.md step 3', plant(SKILL, SKILL_STEP_3_END, SKILL_STEP_3_END + '4. ' + WHOLE + '\n'), [C + SKILL + ' :: ' + WHOLE, S + SKILL + ' :: ' + WHOLE]],
    ['a paragraph just past SKILL.md step 3', plant(SKILL, SKILL_STEP_3_END, SKILL_STEP_3_END + '\n' + WHOLE + '\n'), [C + SKILL + ' :: ' + WHOLE, S + SKILL + ' :: ' + WHOLE]],
    ['a fourth step inside the step 3 cut', plant(SKILL, SKILL_STEP_3_TAIL, '4. ' + WHOLE + '\n' + SKILL_STEP_3_TAIL),
      ['the cut "3. Boot" in ' + SKILL + ' has a line at column 0: 4. ' + WHOLE]],
    ['the close-out put after a wave', plant(PROTOCOL, STEP_3, STEP_3 + ' ' + AFTER_NEXT), [W + PROTOCOL + ' :: ' + AFTER_NEXT]],
    ['step 3 reworded', plant(PROTOCOL, STEP_3, STEP_3.replace('before any wave opens', () => 'after the next wave opens')),
      [W + PROTOCOL + ' :: ' + STEP_3_UNIT.replace('before any wave opens', () => 'after the next wave opens'), W + 'gone: ' + PROTOCOL + ' :: ' + STEP_3_UNIT]],
    ['a checkpoint closed out after the next wave, with no wave noun before the verb', plant(PROTOCOL, STEP_7_END, STEP_7_END + ' A checkpoint is closed out only once the next wave has closed.'),
      [W + PROTOCOL + ' :: A checkpoint is closed out only once the next wave has closed.']],
    ['the timer put after the close-out, with no wave named', plant(PROTOCOL, BUDGET.compaction[1], 'At a checkpoint, start the 10-minute timer only once the close-out has committed.\n   ' + BUDGET.compaction[1]),
      [W + PROTOCOL + ' :: At a checkpoint, start the 10-minute timer only once the close-out has committed.']],
    ['a line just under the §Recovery table', plant(PROTOCOL, LAST_ROW, LAST_ROW + '- ' + AFTER_NEXT + '\n'), [W + PROTOCOL + ' :: - ' + AFTER_NEXT]],
    ['the close-out put before the clear in smoke-page.md', plant(SMOKE, '\n## Fallback\n', '\n' + BEFORE_CLEAR + '\n\n## Fallback\n'),
      [C + SMOKE + ' :: ' + BEFORE_CLEAR, W + SMOKE + ' :: ' + BEFORE_CLEAR]],
    ["the close-out kept in the wave's conversation by the template", plant(TEMPLATE, '## Hard prohibitions\n',
      "## Hard prohibitions\n\n- Finish every checkpoint's close-out in the conversation that closed its wave.\n"),
      [W + TEMPLATE + " :: - Finish every checkpoint's close-out in the conversation that closed its wave."]],
    ['inside the cut compaction passage', plant(PROTOCOL, BUDGET.compaction[1], BUDGET.compaction[1] + ' The mod reopens a fresh conversation after the next wave closes out.'), []],
    ['just before the cut compaction passage', plant(PROTOCOL, BUDGET.compaction[1], 'The mod reopens a fresh conversation.\n   ' + BUDGET.compaction[1]),
      [C + PROTOCOL + ' :: The mod reopens a fresh conversation.']],
    ['inside the cut step 5', plant(MODELS, BUDGET.nextWave[1], BUDGET.nextWave[1] + ' The checkpoint closes out first.'), []],
    ["step 8's pointer reworded", plant(PROTOCOL, "opens before a checkpoint's close-out begins.", "opens once a checkpoint's close-out has ended."),
      [C + PROTOCOL + ' :: ' + POINTER_AFTER, C + 'gone: ' + PROTOCOL + ' :: ' + STEP_8_POINTER, W + PROTOCOL + ' :: ' + POINTER_AFTER, W + 'gone: ' + PROTOCOL + ' :: ' + STEP_8_POINTER]],
  ];
  assert.deepEqual(controls.map(([what, faults]) => [what, faults]), controls.map(([what, , faults]) => [what, faults]));
});

// Where step 8's pointer sits: between "8. Wave closed." and the frozen close-out sentence, once.
const STEP_8_OPENING = '8. Wave closed. ' + STEP_8_POINTER + ' If the checkpoint table places a checkpoint here: per-checkpoint close-out';
const pointerPlaceFaults = protocol => {
  const n = collapse(protocol).split(STEP_8_OPENING).length - 1;
  return n === 1 ? [] : ['step 8 opens with its pointer ' + n + ' times, not once'];
};
test("step 8 opens with the pointer to its window, ahead of the close-out it spells out", () => {
  const protocol = read('orchestrate/references/protocol.md'), flat = collapse(protocol), CLOSE_END = "COMBINED smoke script per §Smoke checkpoints.";
  assert.deepEqual(pointerPlaceFaults(protocol), []);
  assert.deepEqual(pointerPlaceFaults(protocol.replace(/\n/g, '\r\n')), [], 'a CRLF checkout reads alike');
  assert.ok([STEP_8_POINTER + ' ', CLOSE_END].every(anchor => flat.split(anchor).length === 2), 'the controls must find their anchors once');
  // Live: the pointer taken out, moved after the close-out sentence, or put twice is reported.
  const out = flat.replace(STEP_8_POINTER + ' ', () => '');
  const controls = [['taken out', out, ['step 8 opens with its pointer 0 times, not once']],
    ['moved after the close-out', out.replace(CLOSE_END, () => CLOSE_END + ' ' + STEP_8_POINTER), ['step 8 opens with its pointer 0 times, not once']],
    ['put twice', flat + ' ' + STEP_8_OPENING, ['step 8 opens with its pointer 2 times, not once']]];
  assert.deepEqual(controls.map(([what, text]) => [what, pointerPlaceFaults(text)]), controls.map(([what, , faults]) => [what, faults]));
});

// The first checkpoint's sidecar: protocol.md §Smoke checkpoints' **Delivery.** paragraph points where smoke-page.md's
// delivery base does (tests/build-smoke-page.test.cjs FIRST_CHECKPOINT pins smoke-page.md's side). Every unit of
// protocol.md naming a sidecar, a checkpoint's sidecar file, an archive or another ledger, and every unit of §Smoke
// checkpoints naming a ledger or a JSON file, is doubt unless SIDECAR_UNITS lists it, the pointer among them. Each
// fault: the pointer not stated once, or not directly after the sentence choosing the delivery base; such a unit
// unlisted, or a listed one gone; smoke-page.md's pointer not stated once, or no heading for it to point at.
const SIDECAR_POINTERS = {
  'orchestrate/references/protocol.md': "The first checkpoint, with no committed page in the ledger, takes its sidecar's form from smoke-page.md §Sidecar shape, never from an archived ledger.",
  'orchestrate/references/smoke-page.md': "The first checkpoint, with no committed page in the ledger, takes its sidecar's form from §Sidecar shape below, never from an archived ledger.",
};
const ANOTHER_LEDGER = /archiv|\b(?:closed|completed|finished|earlier|older|previous|other|another)\s+(?:ledger|change)s?\b/i;
const SIDECAR_WORD = /sidecar|smoke-\S*?\.json/i;
const SMOKE_LEDGER_WORD = /\bledgers?\b|\bjson\b/i;
// The units of protocol.md the sidecar sweep reads.
function sidecarSelector(protocol) {
  const smoke = new Set(proseUnits(section(protocol, '\n## Smoke checkpoints', '\n## §Recovery')));
  return unit => SIDECAR_WORD.test(unit) || ANOTHER_LEDGER.test(unit) || (smoke.has(unit) && SMOKE_LEDGER_WORD.test(unit));
}
const SIDECAR_UNITS = [
  "Closed ledgers may be parked in a sibling .agents/archive/ directory;",
  "Ledger observations expose presence, tree, lastChange, lastChangeTree, progressText and contractTexts at the requested ref, including archive presence.",
  "Only an explicit COMPLETE or archived copy at the resolved shipment target supersedes older candidates;",
  "Do not sweep archives into the active inventory.",
  "The sidecar has a stable-id inputs registry;",
  "Legacy sidecars with no inputs remain usable.",
  "On reissue preserve the previous page/sidecar snapshot and every prior input/evidence file.",
  "Every smoke step carries Runner: agent (executable in THIS ledger's environment by a runner the contract lists — CLI, HTTP, browser, screenshot) or Runner: human (hardware, credentials, feel, another OS, anything unlisted).",
  "Use the newest committed smoke-.html in the ledger as the page's format and delivery base (or the session's own template), update it for this checkpoint, and commit it as smoke-<Cn>.html.",
  "The first checkpoint, with no committed page in the ledger, takes its sidecar's form from smoke-page.md §Sidecar shape, never from an archived ledger.",
  "A smoke-<Cn>.json sidecar beside the page is the page's source: change the sidecar and regenerate, commit both, and never hand-edit one of them alone.",
  "Before editing a re-issue, preserve the last issued sidecar as a temporary baseline and compare against it during regeneration.",
  "Record the CURRENT delivery location in PROGRESS's Smoke page field: URL, ledger-relative HTML path, or plain text.",
  "propose deleting the merged branches and moving the ledger to .agents/archive/ (git mv).",
];
function sidecarPointerFaults(protocol, smoke) {
  const [P, S] = Object.values(SIDECAR_POINTERS), faults = [];
  const delivery = collapse(section(protocol, '**Delivery.**', '\n\n')).trim().split(/(?<=\.)\s+/), at = delivery.indexOf(P);
  if (collapse(protocol).split(P).length !== 2) faults.push('protocol.md: the pointer is not stated once');
  if (at < 1 || !delivery[at - 1].startsWith('Use the newest committed')) faults.push('protocol.md: the pointer does not follow the delivery base');
  faults.push(...closedFaults([['protocol.md', protocol]], sidecarSelector(protocol), SIDECAR_UNITS.map(unit => ['protocol.md', unit]))
    .map(fault => fault.startsWith('gone: ') ? 'protocol.md: a listed unit is gone: ' + fault.slice('gone: protocol.md :: '.length)
      : 'protocol.md: an unlisted unit names a sidecar or another ledger: ' + fault.slice('protocol.md :: '.length)));
  if (collapse(smoke).split(S).length !== 2) faults.push('smoke-page.md: its pointer is not stated once');
  if (!smoke.split('\n').includes('### Sidecar shape')) faults.push('smoke-page.md: no ### Sidecar shape heading');
  return faults;
}
test('protocol.md sends the first checkpoint to smoke-page.md §Sidecar shape, as smoke-page.md does', () => {
  const [P, S] = Object.values(SIDECAR_POINTERS), protocol = read('orchestrate/references/protocol.md'), smoke = read('orchestrate/references/smoke-page.md');
  assert.equal(P.replace('smoke-page.md §Sidecar shape', '§Sidecar shape'), S.replace('§Sidecar shape below', '§Sidecar shape'), 'the two pointers say the same once each names its target');
  assert.ok(SIDECAR_UNITS.includes(P), 'the pointer is a listed unit');
  assert.deepEqual(sidecarPointerFaults(protocol, smoke), []);
  // The pointer as protocol.md wraps it, with its line's end, so taking it out leaves the paragraph whole.
  const loose = new RegExp(escapeRe(P).split(' ').join('\\s+') + '\\n');
  const sidecar = 'A `smoke-<Cn>.json` sidecar beside the page', reissue = 'Before editing a re-issue, preserve', next = 'No particular publisher or cloud verdict store is required.';
  assert.ok(loose.test(protocol) && [sidecar, reissue, next, BUDGET.compaction[1]].every(anchor => protocol.split(anchor).length === 2) && smoke.split('\n### Sidecar shape\n').length === 2,
    'the controls must find their anchors once');
  const ARCHIVED = "Copy an archived ledger's smoke-c1.json for the form.", CLOSED = "Copy a closed ledger's `smoke-C1.json` for that form.";
  const NEXT = "The first checkpoint copies an archived ledger's `smoke-C1.json` for its sidecar's form.";
  const UNREAD = 'Where smoke-page.md cannot be read, copy the newest `smoke-<Cn>.json` the repository holds.';
  const PRIOR = "Where that section cannot be read, copy the JSON beside a prior ledger's page.";
  const narrowed = P.replace(', never from an archived ledger.', ', or from an archived ledger.'), unit = text => text.replace(/`/g, '');
  const UNLISTED = 'protocol.md: an unlisted unit names a sidecar or another ledger: ', GONE = 'protocol.md: a listed unit is gone: ';
  const controls = [
    ['the pointer gone', protocol.replace(loose, ''), smoke, ['protocol.md: the pointer is not stated once', 'protocol.md: the pointer does not follow the delivery base', GONE + P]],
    ['the pointer moved after the sidecar sentence', protocol.replace(loose, '').replace(reissue, () => P + '\n' + reissue), smoke, ['protocol.md: the pointer does not follow the delivery base']],
    ['an archived ledger named beside it', protocol.replace(sidecar, () => ARCHIVED + '\n' + sidecar), smoke, [UNLISTED + ARCHIVED]],
    ["a closed ledger's sidecar named beside it", protocol.replace(sidecar, () => CLOSED + '\n' + sidecar), smoke, [UNLISTED + unit(CLOSED)]],
    ['an archived ledger named in the next paragraph', protocol.replace(next, () => NEXT + ' ' + next), smoke, [UNLISTED + unit(NEXT)]],
    ['an archived ledger named in step 8', protocol.replace(BUDGET.compaction[1], () => NEXT + '\n   ' + BUDGET.compaction[1]), smoke, [UNLISTED + unit(NEXT)]],
    ['a sidecar file named with no ledger word', protocol.replace(loose, m => m + UNREAD + '\n'), smoke, [UNLISTED + unit(UNREAD)]],
    ["a prior ledger's JSON, with no sidecar word", protocol.replace(loose, m => m + PRIOR + '\n'), smoke, [UNLISTED + PRIOR]],
    ['the pointer narrowed', protocol.replace(loose, () => narrowed + '\n'), smoke,
      ['protocol.md: the pointer is not stated once', 'protocol.md: the pointer does not follow the delivery base', UNLISTED + narrowed, GONE + P]],
    ['the heading renamed', protocol, smoke.replace('\n### Sidecar shape\n', () => '\n### The sidecar\n'), ['smoke-page.md: no ### Sidecar shape heading']],
  ];
  assert.deepEqual(controls.map(([what, p, s]) => [what, sidecarPointerFaults(p, s)]), controls.map(([what, , , faults]) => [what, faults]));
});

// No definition sets `model:`, and only the gate pair and the census set `effort:` (the loader takes
// low | medium | high | max | an integer): the user pinned the reviewer, which also runs the plan
// pre-flight, at max whatever the session's effort (2026-09-27), the test hunter at medium (2026-10-25),
// and the census at medium (the user's standing choice since 2026-10-07, confirmed 2026-10-13). Stricter
// than the loader on purpose: the admission is per file — exactly `effort: max` in the reviewer and
// exactly `effort: medium` in the test hunter and the census, once, and no line in any other file; any
// other frontmatter key naming either, however quoted, cased, indented or spaced, the reviewer's line in
// the other two and theirs in it, and a frontmatter block that cannot be found, is a finding.
const TIER_KEY = /(?:effort|model)[\w-]*["']?\s*:/i;
const EFFORT_LINES = new Map([['.claude/agents/reviewer.md', 'effort: max'], ['.claude/agents/test-hunter.md', 'effort: medium'],
  ['.claude/agents/census.md', 'effort: medium']]);
function tierKeyFaults(file, text) {
  const m = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(text);
  if (!m) return [file + ': no frontmatter block to read — rejected on doubt'];
  const lines = m[1].split('\n').filter(line => TIER_KEY.test(line));
  const own = EFFORT_LINES.get(file);
  const admitted = own !== undefined && lines.filter(line => line === own).length === 1 ? own : null;
  return lines.filter(line => line !== admitted).map(line => file + ': ' + line.trim());
}
const definitionListing = () => walk(path.join(ROOT, '.claude/agents')).filter(rel => rel.endsWith('.md')).map(rel => '.claude/agents/' + rel);
test('no agent definition sets a model, and an effort only as its own file\'s admitted line — effort: max in the reviewer, '
  + 'effort: medium in the test hunter and the census — read more strictly than the loader reads it', t => {
  const def = line => '---\nname: x\ndescription: y\n' + line + '\ntools: Read\n---\n\nbody\n';
  // Every value the loader accepts, and values past both ends of that set.
  const VALUES = ['low', 'medium', 'high', 'max', '32000', 'none', '0', '-1', 'ultra', '999999', '"high"', 'opus', 'inherit'];
  const SPELLINGS = ['  effort: max', 'EFFORT: max', 'Model: opus', '"effort": max', "'model': opus", 'effort : max', 'effort:max',
    '{effort: max}', 'reasoning_effort: high', 'model_id: x'];
  for (const key of ['effort', 'model']) {
    for (const value of VALUES) {
      assert.equal(tierKeyFaults('x.md', def(key + ': ' + value)).length, 1, 'must be caught: ' + key + ': ' + value);
    }
  }
  for (const spelling of SPELLINGS) {
    assert.equal(tierKeyFaults('x.md', def(spelling)).length, 1, 'must be caught: ' + spelling);
  }
  assert.equal(tierKeyFaults('x.md', 'effort: max\n').length, 1, 'no frontmatter at all is rejected on doubt');
  assert.equal(tierKeyFaults('x.md', '---\nname: x\neffort: max\n').length, 1, 'an unclosed frontmatter is rejected on doubt');
  assert.deepEqual(tierKeyFaults('x.md', def('tools: Read, Write')), [], 'a definition with neither key passes');
  // Each admission, from both sides: in its own file the exact line, once, passes, while every other
  // value and spelling, alone or beside it, another file's admitted line among them, a second copy of
  // it and a missing frontmatter are caught; in any other file, a same-named one elsewhere included,
  // the exact line is caught.
  const cases = [...['effort', 'model'].flatMap(key => VALUES.map(value => key + ': ' + value)), ...SPELLINGS];
  for (const [file, admitted] of EFFORT_LINES) {
    const others = cases.filter(line => line !== admitted);
    assert.equal(others.length, 2 * VALUES.length + SPELLINGS.length - 1, file + ': every case above but its admitted line');
    assert.deepEqual(tierKeyFaults(file, def(admitted)), [], file + ': the admitted line passes');
    for (const line of others) {
      assert.equal(tierKeyFaults(file, def(line)).length, 1, file + ': must be caught: ' + line);
      assert.equal(tierKeyFaults(file, def(admitted + '\n' + line)).length, 1, file + ': must be caught beside the admitted line: ' + line);
    }
    assert.equal(tierKeyFaults(file, def(admitted + '\n' + admitted)).length, 2, file + ': a second copy admits neither');
    assert.equal(tierKeyFaults(file, admitted + '\n').length, 1, file + ': no frontmatter is still rejected on doubt');
    for (const other of ['.claude/agents/implementer.md', '.claude/agents/qa-runner.md', 'x.md', 'reviewer.md', 'census.md',
      '.claude/agents/nested/reviewer.md', '.claude/agents/nested/census.md']) {
      assert.equal(tierKeyFaults(other, def(admitted)).length, 1, other + ': must be caught: ' + admitted);
    }
  }
  // The domain is the directory, walked at any depth, dotted directories included.
  const temp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'budget-walk-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }));
  fs.mkdirSync(path.join(temp, '.hidden', 'deeper'), { recursive: true });
  fs.writeFileSync(path.join(temp, 'top.md'), '');
  fs.writeFileSync(path.join(temp, '.hidden', 'deeper', 'nested.md'), '');
  assert.deepEqual(walk(temp), ['.hidden/deeper/nested.md', 'top.md'], 'the walk must reach a definition two directories down');
  const files = definitionListing();
  assert.ok(['implementer', 'reviewer', 'test-hunter', 'qa-runner', 'census'].every(n => files.includes('.claude/agents/' + n + '.md')),
    'the listing reads the shipped definitions: ' + files.join(', '));
  // Each admission is live: its file's frontmatter carries the line, and only the admission keeps it unreported.
  for (const [file, admitted] of EFFORT_LINES) {
    assert.ok(files.includes(file), file + ': a shipped definition');
    assert.deepEqual(tierKeyFaults('x.md', read(file)), ['x.md: ' + admitted], file + ': read under any other name, its one tier line is reported');
  }
  for (const file of files) assert.deepEqual(tierKeyFaults(file, read(file)), [], file + ': sets a model, or an effort other than its admitted line');
});

// [BL-034] The gate pair holds a scoped Write; no text may say it lacks one. README's sentence
// about a stale installed copy is true, and is removed as its exact text, never by its clause.
const GATE_PAIR = String.raw`\b(?:reviewer|test[- ]hunter|read-only pair|gate pair)s?\b`;
const LACKS_WRITE = [
  ['Write and Edit, unlike the gate pair', new RegExp(String.raw`\bWrite\b[^.;:]*\bEdit\b[^.;:]*\bunlike\b[^.;:]*` + GATE_PAIR, 'i'),
    'This role keeps `Write` and `Edit` on purpose, unlike the reviewer and the test hunter.'],
  ['unlike the gate pair, Write', new RegExp(String.raw`\bunlike\b[^.;:]*` + GATE_PAIR + String.raw`[^.;:]*\bWrite\b`, 'i'),
    'Unlike the reviewer and the test hunter, this role keeps Write and Edit.'],
  ['the gate pair without Write', new RegExp(GATE_PAIR + String.raw`[^.;:]*\b(?:lacks?|lacking|without|has no|have no|holds? no|gets? no)\s+(?:the\s+)?Write\b`, 'i'),
    'The reviewer and the test hunter have no Write tool.'],
];
const QA_RUNNER_WRITES = ['.claude/agents/qa-runner.md', 'This role keeps', '\n\n`mcp__Claude_Browser__*`',
  'This role keeps `Write` and `Edit` on purpose; the reviewer and the test hunter hold no `Edit`, and their `Write` reaches only their findings file and scratchpad scratch. The QA-runner skeleton in `orchestrate/references/subagent-prompts.md` has it "write [LEDGER_DIR]/evidence/C[N]/step-[NN].md" for every step, and "Modify only disposable working copies and prove reset". Stripping Write/Edit here would leave a checkpoint with no evidence to close on — do not "correct" this to match the read-only pair.'];
const STALE_COPY = 'an older reviewer or test-hunter lacks the Write tool its rendered prompt needs for the findings file';
const lacksWrite = text => clauses(collapse(unticked(text)).split(STALE_COPY).join(' '))
  .flatMap(c => LACKS_WRITE.filter(([, p]) => p.test(c)).map(([name]) => name + ' — ' + c));
test('[BL-034] no text says the reviewer and the test hunter lack Write', () => {
  assert.equal(new Set(LACKS_WRITE.map(l => l[0])).size, LACKS_WRITE.length);
  for (const [name, , specimen] of LACKS_WRITE) {
    assert.deepEqual(LACKS_WRITE.filter(([, p]) => p.test(unticked(specimen))).map(l => l[0]), [name], name + ': its specimen must be caught by it alone');
    assert.equal(lacksWrite(specimen).length, 1, name + ': the sweep reports its specimen');
  }
  for (const planted of ['The read-only pair lacks Write, so this role keeps it.', 'The reviewer, lacking the `Write` tool, keeps no evidence.',
    'Only this role has Write; the test hunter gets no Write at all.']) {
    assert.ok(lacksWrite(planted).length >= 1, 'must be reported: ' + planted);
  }
  // The reworded paragraph, pinned whole: its directive to keep Write and Edit stands.
  const [qaFile, from, to, expected] = QA_RUNNER_WRITES, qa = read(qaFile);
  assert.equal(qa.split(from).length - 1, 1, qaFile + ': the anchor must occur exactly once');
  assert.equal(collapse(section(qa, from, to)).trim(), expected, qaFile + ': the pinned paragraph changed; update QA_RUNNER_WRITES only on purpose');
  assert.notEqual(collapse(section(qa.replace(from, from + ' Skip it when in a hurry.'), from, to)).trim(), expected, 'a planted sentence must redden the pin');
  assert.deepEqual(lacksWrite(expected), [], 'the reworded paragraph is not the old claim');
  // The exemption is live: README carries the sentence, and only the exemption keeps it unreported.
  assert.ok(collapse(unticked(read('README.md'))).includes(STALE_COPY), 'README still carries the stale-copy sentence this exemption names');
  assert.ok(LACKS_WRITE.some(([, p]) => p.test(STALE_COPY)), 'the exempt sentence would otherwise be reported');
  const files = [...documents(), ...definitionListing()];
  assert.ok(files.includes('.claude/agents/qa-runner.md') && files.includes('README.md'));
  for (const file of files) assert.deepEqual(lacksWrite(read(file)), [], file + ': says the gate pair lacks Write');
});

// The undo sweep stays unweakened: B03 writes rules beside it and reuses its reader. Its domain,
// its negation reader and its test are byte-for-byte what they were at FAMILY_BASE, and UNDO may
// grow but never lose or narrow an entry. Changing any of them is a deliberate edit here.
test('the undo sweep, its reader and its domain are unweakened since ' + FAMILY_BASE, { skip: 'needs history and ledger records that are not in this copy' }, () => {
  const blob = spawnSync('git', ['-C', ROOT, 'show', FAMILY_BASE + ':tests/tool-wiring.test.cjs'], { encoding: 'utf8', windowsHide: true });
  assert.ifError(blob.error); assert.equal(blob.status, 0, 'the undo sweep at ' + FAMILY_BASE + ' must be readable: ' + blob.stderr);
  const base = blob.stdout.replace(/\r\n/g, '\n'), now = read('tests/tool-wiring.test.cjs');
  const region = (text, from, to) => {
    const s = text.indexOf(from), e = text.indexOf(to, s + 1);
    assert.ok(s !== -1 && e > s, 'region bounds must resolve: ' + from);
    return text.slice(s, e + to.length);
  };
  for (const [from, to] of [
    ['// The domain every sweep below walks', "const documents = () => [...shipped(), 'README.md'];"],
    ['const NEGATOR = ', "const undoing = text => clauses(text).flatMap(c => UNDO.filter(([, p]) => fires(p, c)).map(([name]) => name + ' — ' + c));"],
    ["test('no shipped passage tells a reader to pipe", "a directive undoes the validation or pin rule');\n});"],
  ]) {
    assert.equal(region(now, from, to), region(base, from, to), 'changed since ' + FAMILY_BASE + ': ' + from);
  }
  const s = base.indexOf('const UNDO = [\n'), e = base.indexOf('\n];', s);
  assert.ok(s !== -1 && e > s, FAMILY_BASE + ': no UNDO literal to read');
  const baseUndo = new Function('return ' + base.slice(s + 'const UNDO = '.length, e + 3))();
  assert.equal(baseUndo.length, 17, FAMILY_BASE + ' held seventeen undo patterns');
  for (const [name, pattern, specimen] of baseUndo) {
    assert.ok(UNDO.some(([n, p, sp]) => n === name && p.source === pattern.source && p.flags === pattern.flags && sp === specimen),
      'UNDO lost or narrowed: ' + name);
  }
});

// ===== Prose polish (B04 of OS-20260925) =================================================
// The rules B04 wrote, each pinned whole in every carrier (as PINNED and BUDGET are), and each
// guarded by a sweep over every document for the reversal a later edit would write: a
// polish-phase FIX FIRST discards the polish at once, never after a second try; only PROSE-ONLY
// exempts files from the re-review; a comment never describes how its neighbour behaves; prose
// that is a contract is never an ASK; and severity is about behaviour, never the fence (BL-044).
// A smoke-step ASK's text is applied on the integration branch, and §Recovery points at that
// rule (BL-067); its sweep is the last test in this file.
const SEVERITY = "Severity is about behaviour, never the fence: a violated criterion whose fix sits outside the batch's files is still P0 or P1";
const COMMENT_RULE = 'A comment states what the code beneath it does and why, and points at a neighbour by path and symbol; it never describes how the neighbour behaves.';
const CLASSIFY = '`node "<skill-dir>/tools/prose-only-diff.mjs" --repo <batch worktree> --base <pre-polish sha> --head <polish tip>`';
const ONE_STRIKE = 'One strike: a polish-phase `FIX FIRST` discards the polish at once (an ASK never licenses a production behavior change)';
// protocol.md's smoke-step route (BL-067): where the text lands, which commit comes first, the
// list commit a crash leaves to the orchestrator, and what a discard keeps.
const SMOKE_ROUTE = "A smoke-step ASK is the exception to where that edit lands: its text lives in the batch file's Smoke section, and the batch branch changes that file only by ticks, `polish:` appends and a recorded Files line (6a), so the orchestrator applies it through the integration worktree, in the ledger commit that records the verdict, never on the batch branch. "
  + 'That commit comes first; the batch-branch commit that lists the asks follows it, the smoke ask already ticked. '
  + "After a crash, wherever §Recovery meets a `SHIP … asks=` tip with no `polish:` item listed yet — its worktree clean or holding the unfinished list edit — the orchestrator completes that list commit before any polish pass or resume, ticking each ask whose text the integration branch's batch file already carries; a discarded polish reverts only the batch branch and leaves that text, its ask closed.";
const RECOVERY_POINTER = 'Before any polish pass or resume at a `SHIP … asks=` tip whose batch file lists no `polish:` item yet, its worktree clean or dirty, the orchestrator completes the list commit, as §Severity and round accounting says for a smoke-step ASK.';
const POLISH_RULES = {
  severityProtocol: ['orchestrate/references/protocol.md', '- Severity is about behaviour', '\n- **ASK**',
    '- ' + SEVERITY + ', and a residual keeps its severity wherever its fix lies — the fence decides only the route (`NEEDS_FENCE` → §Fence changes, a recorded extension), never the class.'],
  severitySkeleton: [PROMPTS, '  Severity is about behaviour', '\nSHIP = no P0/P1',
    SEVERITY + ' — the fence decides only the route (NEEDS_FENCE), never the class. Prose that is a contract (channel payload docs, exported API comments, ARCHITECTURE rows, USER-GUIDE claims) is never an ASK: wrong, it is P0 or P1. An ASK on other prose carries its replacement text, whose fact you verified.'],
  severityDefinition: ['.claude/agents/reviewer.md', 'Severity is about behaviour', '\n\nThe tool list',
    SEVERITY + ' — the fence decides only the route (`NEEDS_FENCE`), never the class.'],
  polishProtocol: ['orchestrate/references/protocol.md', '  Prose that is a contract', '\n- Only `FIX FIRST` rounds',
    'Prose that is a contract — channel payload docs, exported API comments, ARCHITECTURE rows, USER-GUIDE claims — is never an ASK: wrong, it is P0 or P1, and `FIX FIRST`. '
    + "An ASK on other prose carries its replacement text, whose fact the reviewer verified when it flagged the claim: the orchestrator applies that text itself, one edit on the batch branch and no implementer resume, in a commit that also appends the ask to the batch file as an already ticked `- [x] polish:` item in the form `02-batch.md` shows, and one unticked `- [ ] polish:` item per ask it leaves to the polish pass, so a crash before that pass meets a partial checklist in §Recovery; the polish pass takes those, and none left means none runs. "
    + SMOKE_ROUTE + ' '
    + 'Once the polish has landed, the orchestrator classifies its diff: ' + CLASSIFY + '. '
    + '`PROSE-ONLY` exempts the JavaScript files it counts from the fix-diff-only re-review, the other paths it counts keeping the path rule; `CODE` or `UNKNOWN` keeps the path rule for the whole diff. '
    + '§Recovery keeps the path rule even where the classifier would have read the diff as prose-only — after a crash a production file → fix-diff-only re-review — a deliberately conservative fallback. '
    + "The scoped re-review's verdict is recorded like any other (`R<k> <verdict> @<sha>`, findings in LOG.md; an R-line after the `SHIP … asks=` line is polish-phase and never counts toward the cap). `SHIP` → the close completes. "
    + ONE_STRIKE + ": write `polish discarded: @<sha>` (the pre-polish `SHIP` tip) into the row's Notes first — the marker §Recovery keys on, and the recorded authorization — then ONE revert commit spanning `@<sha>..HEAD` (never a reset — no history rewriting, the R-lines' SHAs stay reachable; `git diff @<sha> HEAD` must come back empty), integrate that reviewed tree, unclosed ASKs → backlog entries, each with its wording attached (a prose ASK's replacement text). Polish never turns a batch `⛔`."],
  scopedReReview: [PROMPTS, '**Scoped re-review**', '\n\nOnly `FIX FIRST` rounds',
    '**Scoped re-review** (a polish commit touched a production file that `prose-only-diff.mjs` did not read as prose-only): a fresh reviewer given only `git diff [PRE_POLISH_SHA]..HEAD`, the ASK list, and duties 1, 2 and 4. Not a round. '
    + "Its verdict is recorded like any other (`R<k> <verdict> @<sha>`) and never counts toward the cap. One strike: its `FIX FIRST` discards the polish at once — the orchestrator writes `polish discarded: @[PRE_POLISH_SHA]` into the row's Notes, reverts back to that reviewed tree in ONE commit (never a reset), and integrates it; unclosed ASKs → residuals for the change-complete ruling step, each with its wording attached."],
  polishBlock: [PROMPTS, 'First append one `- [ ] polish: <ask>`', ' then do',
    'First append one `- [ ] polish: <ask>` checklist line per ask your batch file does not list yet (an orchestrator that applied a prose ask listed every ask: those it applied ticked, yours unticked),'],
  waveGate: ['orchestrate/references/execution-models.md', 'with ASKs → polish pass', '; `FIX FIRST` → round 1',
    "with ASKs → polish pass (not a round; a prose ASK's replacement text the orchestrator applies itself, `prose-only-diff.mjs` classifies the polish diff, and a polish-phase `FIX FIRST` discards the polish at once — protocol.md §Severity and round accounting)"],
  commentSkeleton: [PROMPTS, 'RULES: read a file before you edit it. A comment', ' Chain a command', 'RULES: read a file before you edit it. ' + COMMENT_RULE],
  commentDefinition: ['.claude/agents/implementer.md', 'A comment states', '\n\nThe tool list', COMMENT_RULE],
  batchTemplate: ['orchestrate/templates/02-batch.md', 'The orchestrator is the one other writer', ' An appended item',
    "The orchestrator is the one other writer: the commit that applies a prose ASK's replacement text (for a smoke step's, applied on the integration branch, the batch-branch commit after it) appends its item, already ticked, and an unticked item for each ask it leaves to the polish pass."],
  recoveryPointer: ['orchestrate/references/protocol.md', 'Before any polish pass or resume at a', '\n\n## §Session algorithm', RECOVERY_POINTER],
};
test('each prose-polish rule reads exactly as pinned in every carrier', () => {
  const pinned = (text, from, to) => collapse(section(text, from, to)).trim();
  assert.equal(Object.keys(POLISH_RULES).length, 11, 'eleven passages are pinned; the list may not shrink to a sample');
  for (const [key, [file, from, to, expected]] of Object.entries(POLISH_RULES)) {
    const text = read(file);
    assert.equal(text.split(from).length - 1, 1, key + ': the anchor "' + from + '" must occur exactly once in ' + file);
    assert.equal(pinned(text, from, to), expected, file + ' (' + key + '): the pinned passage changed; update POLISH_RULES only on purpose');
    assert.notEqual(pinned(text.replace(from, from + ' Skip it when in a hurry.'), from, to), expected, key + ': a planted sentence must redden the pin');
  }
  // Each rule once per carrier, verbatim: a second, reworded copy elsewhere is a second rule.
  for (const file of [PROMPTS, '.claude/agents/implementer.md']) assert.equal(collapse(read(file)).split(COMMENT_RULE).length - 1, 1, file + ': the comment rule once');
  for (const file of ['orchestrate/references/protocol.md', PROMPTS, '.claude/agents/reviewer.md']) assert.equal(collapse(read(file)).split(SEVERITY).length - 1, 1, file + ': severity once');
  assert.equal(collapse(read('orchestrate/references/protocol.md')).split(CLASSIFY).length - 1, 1, 'protocol.md publishes the classifier command once');
});

// The reversals, clause by clause through the undo sweep's negation-aware reader. Each family
// owns a specimen no other catches; the planted prose below is written as a reversal would be.
const POLISH_TRIES = String.raw`\b(?:polish(?:-phase)?|scoped re-review)\b`;
// One list of the words that grant a second try, read before the polish and after its FIX FIRST
// alike: a count word, or a re-run with no count at all.
const AGAIN = String.raw`\b(?:second|2nd|another|two|again|twice|once more|one more|further|additional|extra|repeat(?:ed|s)?|re-?runs?|retr(?:y|ies|ied))\b`;
const PLACE = String.raw`(?:\b(?:outside|beyond|past)\s+(?:the\s+|its\s+|this\s+)?(?:batch's\s+)?(?:fence|files?)\b|\bout-of-fence\b)`;
const OUTSIDE = String.raw`(?:` + PLACE + String.raw`|\bNEEDS_FENCE\b)`;
// NEEDS_FENCE is a route, and a list may name it beside ASK: only a verb between them makes one the other.
const ROUTED = String.raw`\bNEEDS_FENCE\b[^.;:]*\b(?:is|are|becomes?|stays?|rides?\s+as|counts?\s+as|goes\s+as)\s+(?:an?\s+)?`;
// A finding's lesser classes, and the backlog severities a residual could be filed under.
const LESSER = String.raw`\b(?:ASKs?|nits?|non-blocking|advisory|low|medium|minor|cosmetic|trivial)\b`;
// A word in any case, where a family matches its neighbours in one case only.
const anyCase = word => word.replace(/[a-z]/gi, c => '[' + c.toUpperCase() + c.toLowerCase() + ']');
const CONTRACT = String.raw`\b(?:channel payload|exported API|ARCHITECTURE|USER-GUIDE)\b`;
const POLISH_REVERSALS = [
  ['a second polish-phase FIX FIRST', new RegExp(AGAIN + String.raw`[^.;:]*` + POLISH_TRIES + String.raw`[^.;:]*\bFIX FIRST\b|`
    + POLISH_TRIES + String.raw`[^.;:]*\bFIX FIRST\b[^.;:]*` + AGAIN, 'i'), 'A SECOND polish-phase FIX FIRST discards the polish'],
  ['the polish redone', /\bredo(?:es|ne|ing)?\b[^.;:]*\bpolish\b|\bpolish\b[^.;:]*\bredo(?:es|ne|ing)?\b/i, 'The implementer redoes the polish within test/doc/prose'],
  ['the implementer sent back after a polish-phase FIX FIRST', new RegExp(POLISH_TRIES + String.raw`[^.;:]*\bFIX FIRST\b[^.;:]*\b(?:implementer|fix[- ]round)\b`, 'i'),
    'After a polish-phase FIX FIRST the implementer reverts its production hunks'],
  ['the offending hunks reverted', /\brevert\w*\s+(?:only\s+)?the\s+offending\b/i, 'Revert the offending production hunks and keep the rest of the polish'],
  ['a fence location lowers a finding', new RegExp('(?<=' + PLACE + '[^.;:]*)' + LESSER + '|' + LESSER + '[^.;:]*' + PLACE + '|(?<=' + ROUTED + ')' + LESSER, 'i'),
    "A violated criterion whose fix sits outside the batch's files is an ASK"],
  ['a finding downgraded for its fence', new RegExp(String.raw`\b(?:downgrad|lower|demot|soften|reclass)\w*\b[^.;:]*(?:` + OUTSIDE + String.raw`|\bfence\b)`, 'i'),
    'Downgrade the finding when its fix needs a file the fence does not hold'],
  ['the fence sets the class', /\bfence\b[^.;:]*\b(?:decides|sets|determines|picks|lowers)\s+(?:the\s+|its\s+)?(?:class|severity)\b/i, 'The fence decides the class of a finding'],
  ['contract prose as an ASK', new RegExp(String.raw`(?<=` + CONTRACT + String.raw`[^.;:]*)\b(?:is|are|stays?|becomes?|counts?\s+as|goes|go|rides?\s+as)\s+(?:an?\s+)?(?:ASKs?|nits?|non-blocking)\b|`
    + String.raw`\btreat\w*\b[^.;:]*` + CONTRACT + String.raw`[^.;:]*\bas\s+(?:an?\s+)?(?:ASKs?|nits?)\b`, 'i'), 'A wrong exported API comment is an ASK'],
  // The classifier's rule: only PROSE-ONLY exempts, and only the files it counts. The verdict
  // words are matched in capitals; the prose-only a verdict is read as, in any case.
  ['a CODE or UNKNOWN verdict read as prose-only', new RegExp(String.raw`\b(?:CODE|UNKNOWN)\b[^.;:]*(?:\b[Ee]xempts?\b|\b[Ss]kips?\b|\b[Ss]pares?\b|`
    + String.raw`\bas\s+(?:a\s+)?` + anyCase('prose-only') + String.raw`\b|\b(?:no|without)\s+(?:a\s+)?(?:scoped\s+|fix-diff-only\s+)?re-review\b)`),
    'A classifier UNKNOWN exempts the JavaScript files as PROSE-ONLY does'],
  ['PROSE-ONLY exempting more than the files it counts', new RegExp(String.raw`\bPROSE-ONLY\b[^.;:]*\b(?:exempts?|spares?|skips?|clears?)\b[^.;:]*\b(?:whole|entire|all|every)\b|`
    + String.raw`\b(?:whole|entire|all|every)\b[^.;:]*\b(?:exempt\w*|spared|skipped)\b[^.;:]*\bPROSE-ONLY\b`), 'A PROSE-ONLY verdict exempts the whole polish diff from the scoped re-review'],
  // One strike, whoever fixes: no scoped re-review follows a polish-phase FIX FIRST.
  ['a further scoped re-review after a polish-phase FIX FIRST', /\bFIX FIRST\b[^.;:]*\b(?:fresh|new|then an?|followed by an?)\s+scoped re-review\b/i,
    'After a polish-phase FIX FIRST, then a fresh scoped re-review of the new diff'],
  // The implementer's comment rule: a comment never describes how its neighbour behaves.
  ['a comment that describes its neighbour', /\b(?:describ|explain|narrat|restat|summari[sz])\w*\s+how\s+(?:its|the|a|that|each)\s+neighbou?rs?\b/i,
    'A comment may describe how its neighbour behaves'],
];
const polishReversals = text => clauses(unticked(text)).flatMap(c => POLISH_REVERSALS.filter(([, p]) => fires(p, c)).map(([name]) => name + ' — ' + c));
test('no document reverses one strike, the classifier or comment rule, lets the fence lower a finding, or makes contract prose an ASK', () => {
  assert.equal(new Set(POLISH_REVERSALS.map(r => r[0])).size, POLISH_REVERSALS.length);
  assert.equal(POLISH_REVERSALS.length, 12, 'twelve families; one dropped would shrink the sweep to a sample');
  for (const [name, pattern, specimen] of POLISH_REVERSALS) {
    assert.deepEqual(POLISH_REVERSALS.filter(([, p]) => p.test(specimen)).map(r => r[0]), [name], name + ': its specimen must be caught by it alone');
    assert.equal(polishReversals(specimen + '.').length, 1, name + ': the clause reader must report the specimen');
  }
  // The pre-B04 rule, as it stood, and reversals written as prose.
  for (const planted of ['`FIX FIRST` → resume the implementer to revert the offending production hunks or redo the polish within test/doc/prose, then a fresh scoped re-review of the new diff.',
    'A SECOND polish-phase `FIX FIRST` discards the polish.', 'After a polish-phase FIX FIRST, resume the implementer once more.',
    'The polish is discarded only when the scoped re-review returns FIX FIRST twice.', 'A scoped re-review FIX FIRST sends the implementer back to fix the polish.',
    'When the fix needs a file outside the fence, record the finding as an ASK.', 'An out-of-fence fix makes a criterion violation a nit.',
    'Lower the severity of any finding routed to NEEDS_FENCE.', 'A finding sent down the NEEDS_FENCE route becomes an ASK.', 'The fence decides the severity of each finding.',
    'USER-GUIDE claims ride as ASKs.', 'Treat ARCHITECTURE rows as ASKs.',
    // Round 1's survivors: a verdict other than PROSE-ONLY exempting, the comment rule reversed, a second pass granted.
    'A classifier UNKNOWN exempts the JavaScript files as PROSE-ONLY does.', 'A comment may describe how its neighbour behaves.',
    'ASKs close as a polish pass, and a polish-phase FIX FIRST earns another polish pass.', 'A CODE verdict means no scoped re-review for those files.',
    // Round 2's survivors: a verdict read as prose-only in lower case or integrating without a
    // re-review, a second try through the orchestrator with or without a count word, PROSE-ONLY
    // stretched over the whole diff, and a residual filed lower for its fence.
    'A classifier UNKNOWN is treated as prose-only.', 'An UNKNOWN diff integrates without a re-review.',
    "After a polish-phase FIX FIRST on prose, the orchestrator applies the reviewer's wording and runs one more scoped re-review.",
    'After a polish-phase FIX FIRST, the orchestrator applies the wording and reruns the scoped re-review.',
    'After a polish-phase FIX FIRST the orchestrator applies the wording, then a fresh scoped re-review of the new diff.',
    'a PROSE-ONLY verdict exempts the whole polish diff from the scoped re-review.', "A residual whose fix sits outside the batch's files is filed in the backlog as low."]) {
    assert.ok(polishReversals(planted).length >= 1, 'must be reported: ' + planted);
  }
  // The rules themselves, and their negations, are not reversals.
  assert.deepEqual(polishReversals(Object.values(POLISH_RULES).map(entry => entry[3]).join(' ')
    + ' Never lower a finding because its fix sits outside the fence. A NEEDS_FENCE finding is never an ASK.'), [], 'the rules are not their own reversals');
  // Armed on real carriers: protocol.md with the old SECOND rule put back and with CODE or UNKNOWN
  // exempting, reviewer.md with its severity rule reversed, implementer.md with its comment rule
  // reversed. Each is reported once.
  for (const [file, from, to] of [['orchestrate/references/protocol.md', ONE_STRIKE, 'A SECOND polish-phase `FIX FIRST` discards the polish'],
    ['orchestrate/references/protocol.md', '`CODE` or `UNKNOWN` keeps the path rule for the whole diff', '`CODE` or `UNKNOWN` exempts them too'],
    ['.claude/agents/reviewer.md', 'is still P0 or P1', 'is an ASK'], ['.claude/agents/implementer.md', 'it never describes how', 'it may describe how']]) {
    const text = collapse(read(file)), reverted = text.replace(from, to);
    assert.notEqual(reverted, text, file + ': the control must find its sentence');
    assert.equal(polishReversals(reverted).length, 1, file + ': the reversal put back is reported');
  }
  const files = [...documents(), ...definitionListing()];
  assert.ok(files.includes('orchestrate/references/protocol.md') && files.includes(PROMPTS) && files.includes('.claude/agents/reviewer.md') && files.includes('README.md'));
  for (const file of files) assert.deepEqual(polishReversals(read(file)), [], file + ': reverses a prose-polish rule');
});

// ===== A smoke-step ASK's text, applied on the integration branch (B04 of OS-20261007) ====
// The batch branch changes its batch file only by ticks, polish appends and a recorded Files line,
// so protocol.md §Severity applies a smoke-step ASK's text through the integration worktree, never
// on the batch branch (SMOKE_ROUTE above). Its reversals: a place on, in, to or through the batch
// branch, its worktree or the commit that lists the asks, or the batch branch as where the text
// goes, in a sentence naming a smoke step or the one right after it ("Its text lands …") or in a
// table cell from the first that names one; and the exception withdrawn ("like any other prose
// ASK"). Verb-free, as the write-licence family reads a place; a negator governs as smokeNegated()
// reads it. Each table row is read on its own, so no row borrows another's.
const SMOKE = /\bsmoke/i;
// The placeholders the skeletons name the batch's worktree and branch by, read off
// subagent-prompts.md's own "worktree at [X] … ([Y])" lines rather than typed here.
const BATCH_PLACEHOLDERS = [...new Set([...read(PROMPTS).matchAll(/worktree at \[([A-Z_]+)\][^.]*?\[([A-Z_]+)\]\)/g)].flatMap(m => m.slice(1)))].sort();
const TREE = String.raw`(?:branch(?:es)?|worktrees?|work(?:ing)?[\s-]+trees?)\b`;
const BATCH_PLACE = String.raw`(?:batch(?:['’]s)?(?:\s+[\w-]+)?[\s-]+` + TREE + String.raw`|(?:this|your|its|their)\s+(?:[\w-]+\s+)?` + TREE
  + String.raw`|(?:implementer|row)['’]s\s+(?:[\w-]+\s+)?` + TREE + String.raw`|(?:list\s+commit|commit\s+(?:that\s+lists|listing))\b`
  + String.raw`|[[{]+(?:` + BATCH_PLACEHOLDERS.join('|') + String.raw`)\b)`;
const ON_BATCH = new RegExp(String.raw`\b(?:on|onto|to|in|into|inside|within|through|via|at|from|under)\s+(?:[\w'’-]+\s+){0,2}?` + BATCH_PLACE
  + String.raw`|(?<![\w'’-])` + BATCH_PLACE + String.raw`\s+(?:is|are)\s+(?:where|the\s+place)\b`, 'gi');
// The exception withdrawn: a smoke-step ASK applied as any other prose ASK is.
const WITHDRAWN = /\b(?:(?:like|as)\s+(?:any|every)\s+other\b|(?:in\s+)?the\s+same\s+way\s+as\b|no\s+exception\b)/gi;
// A smoke place is negated only where negatedLocation() reads it so and no exemption, to-infinitive or
// -ing verb stands between it and the last negator: each opens a phrase that negator does not govern
// ("Do not wait for the polish pass to apply …"). Local to this sweep; the write-licence family keeps its reader.
const SMOKE_SCOPE_BREAK = /\b(?:except|other\s+than|besides|apart|unless)\b|\bto\s+(?!(?:the|a|an|its|their|this|that|these|those|his|her|our|your|my|any|each|every|all|some|both|one)\b)[a-z]+\b|\b(?!(?:no|any|some|every)?thing\b|during\b|being\b)[a-z]{2,}ing\b/i;
function smokeNegated(clause, at) {
  if (!negatedLocation(clause, at)) return false;
  const before = clause.slice(0, at), last = [...before.matchAll(LOCATION_NEGATOR)].pop();
  return !SMOKE_SCOPE_BREAK.test(before.slice(last.index + last[0].length));
}
// The units read: prose sentence by sentence, each read when it or the unit before it names a smoke
// step, and each table row cell by cell, a cell read from the first in its row that names one.
function smokeUnits(text) {
  const units = [], prose = [];
  const flush = () => {
    for (const sentence of collapse(prose.splice(0).join('\n')).split(/(?<=[.!?])\s+/)) units.push([sentence, SMOKE.test(sentence) || SMOKE.test(units.length ? units[units.length - 1][0] : '')]);
  };
  for (const line of unticked(text).split('\n')) {
    if (!/^\s*\|/.test(line)) { prose.push(line); continue; }
    flush();
    let seen = false;
    for (const cell of line.trim().replace(/^\||\|$/g, '').split('|')) units.push([collapse(cell).trim(), seen = seen || SMOKE.test(cell)]);
  }
  flush();
  return units.filter(([, read]) => read).map(([unit]) => unit);
}
// Each clause read, with each place and withdrawal in it: where it starts, and whether no negator governs it.
function smokePlaces(text) {
  return smokeUnits(text).flatMap(unit => unit.split(/(?<=[.;:])\s+/).map(clause => {
    const found = pattern => [...clause.matchAll(pattern)].map(m => ({ at: m.index, free: !smokeNegated(clause, m.index) }));
    return { clause, places: found(ON_BATCH), withdrawals: found(WITHDRAWN) };
  }));
}
// The clauses that reverse the route: a free withdrawal, or a free place where the clause does not
// start with one of `safe`, the places SMOKE_SAFE names for the file read.
const smokeOnBatch = (text, safe = []) => smokePlaces(text).filter(({ clause, places, withdrawals }) => withdrawals.some(w => w.free)
  || places.some(p => p.free && !safe.some(s => clause.startsWith(s, p.at)))).map(({ clause }) => clause);
// The route as the reader sees it: a clause naming the integration worktree, every place in it negated.
const smokeRoutes = text => smokePlaces(text).filter(({ clause, places }) => /\bintegration worktree\b/.test(clause) && places.length > 0 && !places.some(p => p.free));
// The places the family reads in a smoke unit that put a repair, a fix-up or a batch's implementer on a
// branch or in a worktree, not a smoke step's text, each named by its words from the place on: the
// repairs beside "a failed pre-smoke step", the fix-up skeleton after "a smoke-test failure", and
// README's batches, read with the fenced tree before them, which names the smoke page.
const SMOKE_SAFE = {
  'orchestrate/references/protocol.md': ['on its own branch cut from the integration tip'],
  [PROMPTS]: ['on its own branch cut from the integration tip', 'in the worktree [WORKTREE_PATH], checked out on [FIXUP_BRANCH]'],
  'README.md': ['on its own branch in an isolated git worktree'],
};
const SMOKE_SPECIMEN = "The orchestrator applies a smoke-step ASK's text on the batch branch.";
test("a smoke-step ASK's text is applied through the integration worktree, and no document places it on the batch branch", () => {
  const PROTOCOL_MD = 'orchestrate/references/protocol.md', protocol = read(PROTOCOL_MD);
  // The rule: part of the pinned ASK passage, stated once, and read as the route it is.
  assert.ok(POLISH_RULES.polishProtocol[3].includes(SMOKE_ROUTE), 'the route is part of the pinned ASK passage');
  assert.equal(collapse(protocol).split(SMOKE_ROUTE).length - 1, 1, PROTOCOL_MD + ': states the smoke-step route once');
  assert.equal(smokeRoutes(protocol).length, 1, PROTOCOL_MD + ": routes a smoke-step ASK's text through the integration worktree, never on the batch branch");
  assert.deepEqual(smokeRoutes(protocol).map(r => r.clause), smokeRoutes(SMOKE_ROUTE).map(r => r.clause), 'the route read in protocol.md is the pinned one');
  assert.deepEqual(smokeRoutes("Never apply a smoke-step ASK's text on the batch branch. A smoke step's text goes through the integration worktree."), [],
    'a route names both: the integration worktree, and the batch branch negated');
  // The skeletons' placeholders for the batch's worktree and branch, the one the first family read among them.
  assert.deepEqual(BATCH_PLACEHOLDERS, ['BATCH_BRANCH', 'WORKTREE_PATH'], PROMPTS + ": names the batch's worktree and branch by these placeholders");
  // Reversals written as prose, each reported once: a place before or after the smoke step, in the
  // unit after it or a later cell of its row, a negator whose scope a conjunction, a clause, an
  // exemption or another verb ends, the exception withdrawn, each spelling of the batch branch, its
  // worktree and the list commit ON_BATCH reads, and every preposition read.
  for (const planted of [SMOKE_SPECIMEN, "A smoke-step ASK's replacement text is committed to the batch branch like any other prose ASK.",
    "Edit the batch file's Smoke section in the batch worktree.", 'On the batch branch, the orchestrator rewrites the smoke step the reviewer flagged.',
    'A smoke-step ASK carries its replacement text. Its text lands on the batch branch.', '| smoke-step ASK | applied on the batch branch |',
    '| smoke step | the orchestrator | on the batch branch |',
    'Apply the smoke text not on the integration branch but on the batch branch.', "Never skip the polish pass, and apply the smoke step's text on its batch branch.",
    "Never edit the Checklist by hand; apply the smoke step's text on the batch branch.",
    "The orchestrator applies a smoke step's text through the integration worktree, never on the integration branch, and then on the batch branch.",
    "A smoke-step ASK's text is never applied except on the batch branch.", "No implementer applies a smoke-step ASK's text anywhere other than on the batch branch.",
    "A smoke-step ASK's text never lands anywhere besides on the batch branch.", "A smoke-step ASK's text never goes anywhere apart from into the batch worktree.",
    "Never apply a smoke-step ASK's text unless on the batch branch.", "Do not wait for the polish pass to apply a smoke-step ASK's text on the batch branch.",
    "Nothing stops the orchestrator applying a smoke-step ASK's text on the batch branch.",
    'A smoke-step ASK is applied like any other prose ASK.', "A smoke-step ASK's text is applied as any other prose ASK's is.",
    'A smoke-step ASK is applied as every other prose ASK is.', 'A smoke-step ASK is applied the same way as a comment ASK.', 'Smoke-step ASKs: no exception.',
    "The smoke ask's text goes into the batch-branch commit that lists the asks.", "The smoke ask's text goes into the commit that lists the asks.",
    "The smoke step's text goes in that list commit.", 'The smoke text goes into the commit listing the asks.',
    "The batch branch is where a smoke-step ASK's text is applied.", "Its worktree is the place for a smoke-step ASK's text.", 'Batch branches are where smoke-step ASK text lands.',
    "Write the smoke step's new wording on the batch's own branch.", "Apply the smoke step's text on the batch's fix branch.",
    "Apply the smoke step's text in the batch's isolated worktree.", "The orchestrator applies a smoke-step ASK's text in the batch's work tree.",
    "Apply the smoke step's text in the batch's working tree.",
    "A smoke-step ASK's text goes to the batch's branch.", "A smoke-step ASK's text goes to both batch branches.", 'Apply the smoke text in the batch worktrees.',
    "Apply the smoke step's text on the reviewed batch branch.", "Apply a smoke step's text on this branch, like the ticks.",
    "Commit the smoke step's wording on your own branch.", 'Apply the smoke text through your worktree.', 'Apply the smoke text in this worktree.',
    "Apply a smoke-step ASK's text in your isolated worktree.", "The orchestrator applies a smoke-step ASK's text to the batch file on its branch.",
    "The orchestrator applies a smoke-step ASK's text to the batch file in its worktree.", "Apply the smoke step's text on its own branch.",
    "Apply the smoke step's text on their own branches.", "Apply the smoke step's text on the row's branch.", "Apply the smoke step's text in the implementer's worktree.",
    "Apply the smoke step's text on `[BATCH_BRANCH]`.", "Apply the smoke step's text on {{BATCH_BRANCH}}.",
    "The orchestrator applies a smoke-step ASK's text in [WORKTREE_PATH].", "Apply the smoke step's text in {{WORKTREE_PATH}}.",
    ...['on', 'onto', 'to', 'in', 'into', 'inside', 'within', 'through', 'via', 'at', 'from', 'under'].map(at => "Apply the smoke step's text " + at + ' the batch branch.')]) {
    assert.equal(smokeOnBatch(planted).length, 1, 'must be reported: ' + planted);
  }
  // A withdrawal and a place, a sentence apiece, are two clauses reported.
  assert.equal(smokeOnBatch('A smoke-step ASK is prose like any other. Its text lands on the batch branch.').length, 2);
  // Must pass: the rule and its carriers, its negations, an exemption after the place, the -ing words
  // that open no phrase, a to that heads no infinitive, and a batch-branch commit named as a thing, not a place.
  assert.deepEqual(smokeOnBatch(SMOKE_ROUTE + ' ' + RECOVERY_POINTER + ' ' + POLISH_RULES.batchTemplate[3] + ' '
    + "Never apply a smoke-step ASK's text on the batch branch. A smoke-step ASK's text is not committed to the batch branch. Do not edit the Smoke section in the batch worktree. "
    + 'A smoke-step ASK is not applied like any other prose ASK. '
    + "Never apply a smoke-step ASK's text on the batch branch unless it is listed as a ticked item. A smoke-step ASK's text is not being applied on the batch branch. "
    + "Never apply anything of a smoke-step ASK's text on the batch branch. Never apply a smoke-step ASK's text during the polish on the batch branch. "
    + "Never send a smoke-step ASK's text to the reviewer on the batch branch. "
    + "A smoke step's text lands on the integration branch; the batch-branch commit lists its ask, already ticked."), [], 'the rule and its negations are not reversals');
  // Must pass: a batch branch two units after a smoke step, in the cell before one, or in the row after one.
  assert.deepEqual(smokeOnBatch('A smoke-step ASK is applied through the integration worktree. The wave closes. Every other prose ASK is applied on the batch branch.'), []);
  assert.deepEqual(smokeOnBatch('| ⛔ batch | a fresh implementer on the batch branch | one smoke step on the integration branch |'), []);
  assert.deepEqual(smokeOnBatch('| x | a smoke step |\n| on the batch branch | y |'), []);
  const files = [...documents(), ...definitionListing()];
  assert.ok(files.includes(PROTOCOL_MD) && files.includes('orchestrate/templates/02-batch.md') && files.includes('README.md') && files.includes('.claude/agents/implementer.md'));
  assert.ok(Object.keys(SMOKE_SAFE).every(file => files.includes(file)), 'every file SMOKE_SAFE names is swept');
  // The domain: no clause reported but at a place SMOKE_SAFE names there, and each named place still read there.
  for (const file of files) {
    const text = read(file), safe = SMOKE_SAFE[file] || [];
    assert.deepEqual(smokeOnBatch(text, safe), [], file + ": places a smoke-step ASK's text on the batch branch");
    assert.deepEqual(safe.filter(s => smokePlaces(text).some(({ clause, places }) => places.some(p => p.free && clause.startsWith(s, p.at)))), safe,
      file + ': a place SMOKE_SAFE names is no longer read there; drop it');
  }
  // Armed inside a safe clause: a reversal planted beside the repairs' own branch is still reported.
  const repairs = 'runs on its own branch cut from\n  the integration tip';
  assert.equal(protocol.split(repairs).length - 1, 1, 'the control anchor must occur once: ' + JSON.stringify(repairs));
  assert.equal(smokeOnBatch(protocol.replace(repairs, () => repairs + ', and the smoke text goes on the batch branch,'), SMOKE_SAFE[PROTOCOL_MD]).length, 1,
    PROTOCOL_MD + ': a reversal beside a safe place must be reported');
  // Armed on the carrier: the route's negation dropped is the one clause reported, and no route is read.
  const negation = 'verdict, never on the batch\n  branch.';
  assert.equal(protocol.split(negation).length - 1, 1, 'the control anchor must occur once: ' + JSON.stringify(negation));
  const reversed = protocol.replace(negation, () => 'verdict, on the batch\n  branch.');
  assert.equal(smokeOnBatch(reversed, SMOKE_SAFE[PROTOCOL_MD]).length, 1, PROTOCOL_MD + ': the route reversed must be reported');
  assert.equal(smokeRoutes(reversed).length, 0, PROTOCOL_MD + ': the route reversed is no route');
  // Armed on the whole domain: the specimen appended to any file is reported there, once.
  for (const file of files) assert.equal(smokeOnBatch(read(file) + '\n\n' + SMOKE_SPECIMEN + '\n', SMOKE_SAFE[file]).length, 1, file + ': an appended reversal must be reported');
});

// The passages this batch's report file, fold-in proof and run-end prose sweep added to protocol.md, each pinned whole
// between its anchors, as BUDGET pins a passage: a sentence reversed, dropped or appended inside one reddens it. The
// closed sweeps above read only the units naming a tree, a scratch path or a close-out; these hold the rest.
const REPORT_SWEEP_PASSAGES = {
  // §Roles' Implementer bullet: the report file and the final message.
  roles: ['- **Implementer** —', ' - **Reviewer**',
    "- **Implementer** — a sub-agent given one batch. Codes inside the file fence in the batch's isolated worktree, ticks the batch checklist, commits on the batch branch (one commit per fold-in item). Wave siblings run concurrently. Its full report goes with the Write tool to the file its rendered prompt names, under the session scratchpad and never inside a worktree or the repository, in the fixed shape: its heading `### B<NN> R<k> <role> findings`; the status, one of `DONE | DONE_WITH_CONCERNS | NEEDS_FENCE | BLOCKED`; `NONCE <nonce>` (the nonce its rendered prompt ends with); an evidence block (each validation run's `validate.mjs` line and exit code; SHAs; checklist n/m); ≤40 lines of prose. `NEEDS_FENCE` / `BLOCKED` use Expected / Found / Why it matters / How to proceed. The final message is four lines, or three without a nonce: the status, `NONCE <nonce>`, `checklist <n>/<m>`, the file's path."],
  // step 5: the facts of the roles whose report is a file.
  facts: ["The roles whose report is a file take two more facts", " When the renderer is unavailable",
    "The roles whose report is a file take two more facts: `reportFile`, the file the orchestrator names under the session scratchpad, and `round`, `1` for a first implementer report, `<k>` for fix round `<k>` or the rework standing in for it, and the `SHIP … asks=` round for a polish report."],
  // step 6: the report check, its fallback, the file never read in full, its LOG.md append.
  check: ["The roles whose report is a file have it checked", " - **6a Fence check",
    "The roles whose report is a file have it checked with `node \"<skill-dir>/tools/prompt.mjs\" --report \"<file>\" --nonce <nonce>`, `<file>` the path on the final message's last line (without `--nonce` for a fix-up or a pasted prompt, which ends with no nonce line); a `REPORT FAIL …` line, or an `UNKNOWN` line naming the report file, is no report, resumed the same way, and only `REPORT <status> checklist <n>/<m>` is a report. A check that does not run, or prints any other `UNKNOWN` line, leaves the rule before it as the manual procedure, read from the file's status, `NONCE` and `EVIDENCE:` lines alone. The orchestrator never reads the report file in full: anything that needs the whole report reads the file itself, and the file reaches LOG.md by the published append (Verdicts, below), its heading the file's first line, in the commit with that gate step's PROGRESS update. No later prompt takes that file as its findings file, so the recovery form below never meets it, and a resumed implementer writing the same heading a second time is harmless."],
  // the SWEEP items bullet: the record form and the route of an item with no sweep left.
  sweepItems: ["- Each item of a reviewer's `SWEEP:` list", " - Round 1: resume",
    "- Each item of a reviewer's `SWEEP:` list (an out-of-fence prose fix carrying its verified replacement text) is recorded for the run-end prose sweep (§Session algorithm step 8) by a one-line LOG.md heading, `### prose sweep: B<NN> R<k> SWEEP <n>`, which names that findings entry's heading and, as `<n>`, the item's 1-based position in the `SWEEP:` list; the item's text is never re-typed. A prose finding outside the fence without verified wording keeps its present route, and so does a `SWEEP` item recorded after the sweep has merged (a fix-up's reviewer at a re-issue, say): no second sweep runs, and the item takes the backlog route with its findings heading named."],
  // step 6a: the fold-in proof and its return route.
  foldIn: ["For each fold-in the plan's §Backlog fold-ins", " - **6b Failing-on-base",
    "For each fold-in the plan's §Backlog fold-ins marks `(prose-only)` (`<id> — <text> → B<NN> (prose-only)`; an unmarked fold-in is gated as any other), the orchestrator proves its own commit, the one whose message carries its id: it first reads that commit's paths with `git show --name-only --no-renames --format= <sha>`, and a commit changing only Markdown is decided by the path rule; otherwise the classifier of §Severity and round accounting runs with its `--base` the commit's parent and its `--head` the commit. A cause that begins `code changed`, or a changed path that is neither Markdown nor JavaScript, returns the fold-in: one commit on the batch branch reverses only that commit's own changes (`git revert --no-commit <sha>`, then `git restore --source=HEAD --staged --worktree -- <batch file>` so its tick stays; never the files' parent content, which would also undo the batch's later commits to them), the row's Notes get `fold-in returned: <id> @<sha>`, and the item stays in the backlog. A returned fold-in is not proved a second time at any later 6a of the batch. A revert whose conflicts outlast that restore (a later commit of the batch changed the same lines) is abandoned with `git revert --abort`; the fold-in then stays, and the reviewer reads its commit under the path rule. For a returned fold-in, before the reviewer is rendered, a ledger commit adds to the batch file's notes on the integration branch `[<id>] returned to the backlog at 6a: its checklist item and acceptance criterion no longer apply`, so the reviewer holds the batch to the rest. Any other cause keeps the fold-in, the reviewer reading its kept lines under the path rule, and an `UNKNOWN` line keeps the path rule for that commit, which the reviewer applies."],
  // step 8: the run-end prose sweep.
  sweep: ["**Run-end prose sweep.**", " Compaction happens only",
    "**Run-end prose sweep.** Whenever LOG.md holds a `### prose sweep:` heading, the FINAL checkpoint's close-out begins with this sweep; plan approval is its standing OK, and it runs alone, so §Fence changes' mid-wave test passes trivially. The orchestrator first commits `prose sweep cut @<sha>` to the session log, `<sha>` the integration tip just before that commit, then cuts `fix/<batch>-prose-sweep` (`<batch>` the last batch merged) AT that SHA, so the branch starts one ledger-only commit behind the tip and a crash after the cut always finds the record; its worktree is `<the contract's worktree root>/sweep`, or under the session scratchpad for a contract that names no root. A branch of that name whose tip equals that SHA is adopted and its items applied; one with commits past it, not yet an ancestor of the integration branch, resumes (the missing items applied, then the check and the reviewer); one with commits past it that is an ancestor is the merged sweep (→ tip validation and the session-log row); any other, one that does not descend from that SHA (`git merge-base --is-ancestor <sha> <branch>` fails: a leftover from before this run), is STOP AND INVESTIGATE. Ancestry alone never proves the merge, since a branch cut and not yet committed to is trivially an ancestor. The orchestrator applies each item's replacement text from its findings entry itself, one commit per item, its subject naming the item's heading, and classifies each item's commit as step 6a proves a prose-only fold-in, a return there reverting that commit and sending the item to the backlog route. The mechanical check is manual: worktree clean, and every changed path, both rename endpoints, one that a recorded item names. ONE fresh reviewer, its prompt written in the scoped re-review's shape (the sweep's changes, the items, duties 1, 2 and 4), has its findings reach LOG.md under `### B<NN> R1 sweep findings` by the published append (step 6); its `FIX FIRST` reverts each item it names and sends it to the backlog route — one strike, never a round, never ⛔. Then dry run → merge → tip validation, a red tip going to step 2's tip repair. The sweep being the close-out's first step, a crash in it meets §Recovery's Close-out unfinished row, the rows staying 🟢 and State ACTIVE throughout, and the close-out resumes the sweep from its branch by the adoption rule above (no branch: cut at the recorded SHA). The session-log row records `prose sweep: <n> item(s) @<merge sha>`."],
  // the pointer after §Recovery's table: the Close-out unfinished row's close-out begins with the sweep.
  recoveryPointer: ["At the FINAL checkpoint the Close-out unfinished row's", ' Before any polish pass',
    "At the FINAL checkpoint the Close-out unfinished row's close-out begins with the run-end prose sweep whenever LOG.md holds a `### prose sweep:` heading, resumed from its branch by §Session algorithm step 8's adoption rule."],
  // step 2: a red tip after the sweep's merge, back to the close-out.
  redTip: ["A tip the run-end prose sweep's merge", ' - **Failed pre-smoke step**',
    "A tip the run-end prose sweep's merge turned red (step 8) takes this repair, the sweep counting as the last batch's merge, and once green the run returns to the close-out, not to step 7 or 4."],
  // §Two distinct close-outs: the FINAL checkpoint's close-out opens with the sweep.
  twoCloseOuts: ["The FINAL checkpoint's close-out runs the run-end prose sweep", ' **The backlog file is a to-do list.**',
    "The FINAL checkpoint's close-out runs the run-end prose sweep (step 8) before all of these whenever LOG.md holds a `### prose sweep:` heading."],
};
const PROTOCOL_PATH = 'orchestrate/references/protocol.md';
const pinnedPassage = (text, from, to) => { const flat = collapse(text); return collapse(section(flat, from, to)).trim(); };
test('the report file, the fold-in proof and the run-end prose sweep read in protocol.md exactly as pinned', () => {
  const text = read(PROTOCOL_PATH);
  assert.equal(Object.keys(REPORT_SWEEP_PASSAGES).length, 9, 'nine passages are pinned; the list may not shrink to a sample');
  const faults = [];
  for (const [key, [from, to, expected]] of Object.entries(REPORT_SWEEP_PASSAGES)) {
    if (collapse(text).split(from).length !== 2) { faults.push(key + ': the anchor "' + from + '" does not occur exactly once'); continue; }
    if (pinnedPassage(text, from, to) !== expected) faults.push(key + ': the pinned passage changed; update REPORT_SWEEP_PASSAGES only on purpose');
  }
  assert.deepEqual(faults, []);
  // Live controls: a sentence planted just after the opening anchor, or just before the closing one, reddens each pin.
  for (const [key, [from, to, expected]] of Object.entries(REPORT_SWEEP_PASSAGES)) {
    const flat = collapse(text);
    for (const planted of [flat.replace(from, () => from + ' Skip it when in a hurry.'), flat.replace(to, () => ' Skip it when in a hurry.' + to)]) {
      assert.notEqual(pinnedPassage(planted, from, to), expected, key + ': a planted sentence must redden the pin');
    }
  }
});

// The passages that make the backlog a to-do list, each pinned whole between its anchors as REPORT_SWEEP_PASSAGES
// pins one: a sentence reversed, dropped or appended inside one reddens it. The closed sweeps read only their units
// naming a close-out or the backlog; these hold the rest.
const RULING_PASSAGES = {
  // §Two distinct close-outs: the backlog as a to-do list, and the bar an item passes to enter it.
  bar: [PROTOCOL_PATH, "**The backlog file is a to-do list.**", " **Change-complete**",
    "**The backlog file is a to-do list.** An item enters it only through the change-complete ruling step (step 3 below), and only past the bar of the pinned skill's `references/backlog.md`: works-but verdicts, request items the coverage audit finds unimplemented and P0/P1 defects with a concrete scenario skip the bar's judgement, and the bar never lowers a severity. Below the bar a finding stays in LOG.md only."],
  // step 2: every route to the backlog recorded as a residual for the ruling step, after the verdict table.
  route: [PROTOCOL_PATH, "Wherever this document routes an item to the backlog", " 3. If any batch is `🧪`",
    "Wherever this document routes an item to the backlog — this table's cells, §Severity and round accounting's discarded polish and its `SWEEP` items that keep or take the backlog route, the Status legend's `⛔ (dropped)` batch, a works-but verdict, the convergence pass, step 8's run-end prose sweep returning an item or its reviewer's `FIX FIRST` reverting one, and any other dropped item — the orchestrator records it as a residual: a LOG.md heading `### residual: <source> — <one line>`, `<source>` being `B<NN> R<k>`, `B<NN> R<k> SWEEP <n>`, `B<NN> R1 sweep`, `C<n> step <k>`, `convergence` or `audit`, that names the byte-copied findings heading holding the item's wording, or carries the wording when no findings file holds it; the change-complete ruling step decides it."],
  // change-complete step 2: the audit's unaccounted items as residuals, and a returned fold-in kept.
  audit: [PROTOCOL_PATH, "2. Final coverage audit in PROGRESS", " 3. **Ruling step**",
    "2. Final coverage audit in PROGRESS: every request item (fold-ins included) maps to a merged commit, an intended-behavior resolution, or a named entry in the backlog file — zero unaccounted. An item the audit finds unaccounted is recorded as a LOG.md heading `### residual: audit — <one line>`, so it reaches the ruling list of step 3 (with convergence off, the audit is where an unimplemented request item is first found). Fold-ins are REMOVED from the backlog file in the close-out commit (the ledger row and commit message carry provenance); a partially done fold-in is edited in place there with a pointer to the ledger; residuals added get ids in the repo's id scheme. Those entries and ids are written by step 3's ruling. A fold-in whose row's Notes carry `fold-in returned: <id> @<sha>` stays in the backlog file: its `Folded into …` marker is removed, its `Since:` rewritten to the date it returned with its source naming the batch that returned it, and its coverage row names that entry."],
  // change-complete step 3: the ruling list, its proposals, packs, the UNKNOWN route split by file, the STOP and its resume rule.
  ruling: [PROTOCOL_PATH, "3. **Ruling step**", " 4. **Distillation loop**",
    "3. **Ruling step** — every residual of the run reaches one list, ruled once by the user: - **The list**: every `### residual:` heading of this run's LOG.md, and each item that `node \"<skill-dir>/tools/backlog.mjs\" expired --backlog <file> --days <n> --today <YYYY-MM-DD>` names, run on the contract's backlog file with the contract's expiry (a whole number of days) and today's date. An expired item is re-checked against the code at the integration tip — does its `Failure:` still hold? — before it is proposed. Each residual's paths are checked against the contract's rulings file with `node \"<skill-dir>/tools/backlog.mjs\" rulings --rulings <file> --paths <paths>`; one a ruling covers, bringing no new evidence of exposure, is proposed LOG only, naming that ruling. - **Proposals**: for each residual the orchestrator proposes register (the form's fields filled, its paths written repository-relative as `references/backlog.md` says — `backlog.mjs check` does not refuse a `C:/…`, `~/…` or `$HOME/…` path, so the orchestrator reads them itself), rule (accepted or declined, with a reason) or LOG only; for an expired item, keep (its `Since:` rewritten), rule, or drop (removed from the to-do list; LOG.md keeps its text). A residual whose fix is prose-only and carries verified replacement text, as a `SWEEP:` item does, may be proposed fix now; a fix that changes behaviour never is. - **Packs**: `node \"<skill-dir>/tools/backlog.mjs\" packs --backlog <file> --threshold <n>` with the contract's pack threshold, over the backlog file as it stands, each file's count raised by this run's items proposed for registration that name it (nothing is written before the user rules). A file at or over the threshold that gained an item in this run and that no plan has taken is proposed as a pack, never run unasked; a declined pack returns to this list only when its file gains an item in a later run. - **A file not in the form**: when `backlog.mjs` prints `UNKNOWN` for the backlog or the rulings file (one not yet in the form, every repository's until its migration, or a missing one), the STOP says which file and why, and each item is registered or ruled in that file's current form, a missing file being created in the form. For the backlog file the list then forms from LOG.md's residuals alone and no pack is proposed; for the rulings file the expired items and packs stand, a missing one holds no ruling, and the orchestrator reads one not in the form for the rulings on the residuals' paths. Once the backlog file carries the form, every entry written to it passes `node \"<skill-dir>/tools/backlog.mjs\" check --backlog <file>`. - **The STOP**: the proposed list is committed to LOG.md under `### Ruling list` before the STOP, which presents it; the user rules once, the proposals as defaults, and only the user's word registers or rules an item. The user's words are recorded verbatim in the smoke-test verdict log (Checkpoint column `ruling`) in their own commit, before anything is written to the backlog file or the rulings file, so a crash after it never loses a ruling. A ruling found only in a summary is asked for once more, never assumed. A ledger with every row ✅ or `⛔ (dropped)` (advisory `👤` rows aside) and no COMPLETE marker resumes the change-complete close-out at its first unfinished step, by `continue` or `close`: a committed `### Ruling list` with no recorded ruling is presented. - **The page**: the list goes to the user as the ruling page whenever the runtime can hand over usable HTML, per the pinned skill's `references/ruling-page.md`: the proposals authored as `ruling.json` in the ledger, `node \"<skill-dir>/tools/build-ruling-page.mjs\" build <ledger>/ruling.json <ledger>/ruling.html` builds the page, and the block `node \"<skill-dir>/tools/build-ruling-page.mjs\" list <ledger>/ruling.json` prints is the `### Ruling list`, committed with both files. The paste is saved and checked with `node \"<skill-dir>/tools/build-ruling-page.mjs\" read <ledger>/ruling.json <paste file> --entries` before it is recorded; a `RULINGS FAIL` is asked about once more, never repaired by guess. - **The ruling sweep**: fix-now rulings run after the ruling commit as step 8's run-end prose sweep does, under its rules with these names: the record `ruling sweep cut @<sha>`, the branch `fix/<batch>-ruling-sweep`, the findings heading `### B<NN> R1 ruling-sweep findings` and the session-log row `ruling sweep: <n> item(s) @<merge sha>`. An item it returns or its reviewer's `FIX FIRST` reverts is registered with its replacement text attached, the user's fix-now ruling being its pass of the bar, and the hand-over names it. The backlog file and the rulings file are written once the sweep has merged; a `ruling sweep cut` with no `ruling sweep:` row resumes the sweep from its branch by step 8's adoption rule. - A ruling is reconsidered only on new evidence of exposure (a user hit it, a calling module changed, a smoke step failed), never on a new instance of the same gap; gate prompts never read the rulings file."],
  // SKILL.md's Mode: close step 3: the ruling step between the audit and distillation.
  modeClose: ["orchestrate/SKILL.md", "the ruling step (every", ", distillation (new",
    "the ruling step (every residual of the run on one list committed to LOG.md, ruled once by the user at a STOP, the proposals as defaults; only the user's word registers or rules an item; a ledger with every row ✅ or `⛔ (dropped)` (advisory `👤` rows aside) and no COMPLETE marker resumes the change-complete close-out at its first unfinished step)"],
  // SKILL.md's Mode: close step 1: a works-but verdict is a residual the ruling step decides.
  worksBut: ["orchestrate/SKILL.md", "**works-but** →", "; **blocked**",
    "**works-but** → a residual the change-complete ruling step decides, never a failure"],
  // smoke-page.md's verdict table: the Works, but row, the same route in its own words.
  smokeRow: ["orchestrate/references/smoke-page.md", "| Works, but |", " The user's message is the verdict",
    "| Works, but | Passed exactly as described; user wants it different | A residual the change-complete ruling step decides (protocol.md). Never a failure, never blocks the checkpoint |"],
  // SKILL.md's Mode: continue: the prose-sweep item, held in its place as the step after step 3.
  modeContinue: ["orchestrate/SKILL.md", "(references/subagent-prompts.md). 4. The final checkpoint's close-out begins", " ## Mode: status",
    "(references/subagent-prompts.md). 4. The final checkpoint's close-out begins with the run-end prose sweep whenever LOG.md holds a `### prose sweep:` heading (protocol.md)."],
};
test('the to-do list, its bar, the residual route and the ruling step read in protocol.md, SKILL.md and smoke-page.md exactly as pinned', () => {
  assert.equal(Object.keys(RULING_PASSAGES).length, 8, 'eight passages are pinned; the list may not shrink to a sample');
  const faults = [];
  for (const [key, [file, from, to, expected]] of Object.entries(RULING_PASSAGES)) {
    const text = read(file);
    if (collapse(text).split(from).length !== 2) { faults.push(key + ': the anchor "' + from + '" does not occur exactly once'); continue; }
    if (pinnedPassage(text, from, to) !== expected) faults.push(key + ': the pinned passage changed; update RULING_PASSAGES only on purpose');
  }
  assert.deepEqual(faults, []);
  // Live controls: a sentence planted just after the opening anchor, or just before the closing one, reddens each pin.
  for (const [key, [file, from, to, expected]] of Object.entries(RULING_PASSAGES)) {
    const flat = collapse(read(file));
    assert.equal(flat.split(to).length, 2, key + ': the closing anchor must occur once, so the control plants inside the passage');
    for (const planted of [flat.replace(from, () => from + ' Skip it when in a hurry.'), flat.replace(to, () => ' Skip it when in a hurry.' + to)]) {
      assert.notEqual(pinnedPassage(planted, from, to), expected, key + ': a planted sentence must redden the pin');
    }
  }
});

// Every unit of the skill's shipped text that a reader meets (backlogFiles: its Markdown and the smoke page) naming the
// backlog, a to-do item, a registration or a named entry, in the skill's own words for each, is doubt unless BACKLOG_UNITS
// lists it word for word, so no sentence registers an item in the backlog by a route the change-complete ruling step
// does not decide: the RULING_PASSAGES pins hold their passages, and this sweep holds every other place. `backlog` has
// no closing \b so `{{BACKLOG_FILE}}` reads; `registry` stays out.
const BACKLOG_WORD = /\bbacklog|\bto-?do\b|\bregist(?:er|ers|ered|ering|ration)\b|\bnamed entr/i;
const backlogFiles = () => shipped().filter(file => /\.(?:md|html)$/.test(file));
// An HTML file is read a line at a time with its tags dropped, since its prose and its script share blocks.
const backlogText = (file, text) => file.endsWith('.html') ? text.split('\n').map(line => line.replace(/<[^>]*>/g, ' ')).join('\n\n') : text;
const BACKLOG_UNITS = [
  ["orchestrate/SKILL.md","If the user says \"continue\" and nothing is active: reconcile, report completion, point at the backlog."],
  ["orchestrate/SKILL.md","context) → detect repo facts (validation commands and their quiet form, versioning, gate agents, runners, backlog id scheme;"],
  ["orchestrate/SKILL.md","each item its report opens with is recorded in LOG.md as carried or rejected, once the lines folded from it in other words and the fixes chosen for what it only flagged have gone back to that agent, per scaffolding.md) → backlog sweep (propose eligible fold-ins per scaffolding.md;"],
  ["orchestrate/SKILL.md","fold-ins removed from the backlog), the ruling step (every residual of the run on one list committed to LOG.md, ruled once by the user at a STOP, the proposals as defaults;"],
  ["orchestrate/SKILL.md","only the user's word registers or rules an item;"],
  ["orchestrate/SKILL.md","- Asked to resume a COMPLETE ledger → reconcile, report completion, point at the backlog."],
  ["orchestrate/SKILL.md","- [references/backlog.md](references/backlog.md) — the backlog and rulings entry forms, the bar for registering, packs by production file, expiry, reconsideration"],
  ["orchestrate/SKILL.md","- [references/scaffolding.md](references/scaffolding.md) — detection heuristics, interview, census, backlog sweep, pre-flight, placeholder registry, self-check"],
  ["orchestrate/references/backlog.md","# The backlog and rulings forms"],
  ["orchestrate/references/backlog.md","A repository's backlog is its to-do list, and its rulings file (RULINGS.md) holds the user's rulings with their reasons."],
  ["orchestrate/references/backlog.md","Both are written in the form below, which backlog.mjs reads: what this page shows is what the tool accepts."],
  ["orchestrate/references/backlog.md","A file in the backlog form holds this exact line before its first entry:"],
  ["orchestrate/references/backlog.md","text Form: orchestrate backlog v1"],
  ["orchestrate/references/backlog.md","The line tells a file in the form from one that is not yet: until a backlog gains it, every backlog.mjs operation on that file prints UNKNOWN and exits 2."],
  ["orchestrate/references/backlog.md","A file with its form line and no entry is an empty to-do list."],
  ["orchestrate/references/backlog.md","## A backlog entry"],
  ["orchestrate/references/backlog.md","- Since: <YYYY-MM-DD> — <source>: the date the item was registered, or the date the user last kept it;"],
  ["orchestrate/references/backlog.md","node \"<skill-dir>/tools/backlog.mjs\" rulings --rulings <file> --paths <comma-separated paths> lists the rulings on the paths a change edits, one <id> <accepted|declined> <date>: <shared paths> line each;"],
  ["orchestrate/references/backlog.md","An item enters the backlog only with Failure: and Done when: filled in a way a reader can check;"],
  ["orchestrate/references/backlog.md","To-do items are counted per production file their Files: line names, a production file being one the isTestPath of failing-on-base.mjs reads as no test;"],
  ["orchestrate/references/backlog.md","- node \"<skill-dir>/tools/backlog.mjs\" packs --backlog <file> --threshold <n> prints PACKS <k> file(s) at or over <n>, then PACK <path> <count>: <ids> for each file whose count reaches the threshold."],
  ["orchestrate/references/backlog.md","- node \"<skill-dir>/tools/backlog.mjs\" expired --backlog <file> --days <n> --today <YYYY-MM-DD> prints EXPIRED <k> item(s) older than <n> days, then <id> since <date> for each item whose Since: date is more than the contract's expiry days before today."],
  ["orchestrate/references/backlog.md","- node \"<skill-dir>/tools/backlog.mjs\" check --backlog <file> prints BACKLOG OK <n> item(s), or BACKLOG FAIL <k> problem(s): … naming at most ten problems, each by its entry's id or its line number, and, past ten, (+<m> more) for the rest, exit 1."],
  ["orchestrate/references/protocol.md","accepted backlog fold-ins) + item→batch map |"],
  ["orchestrate/references/protocol.md","git diff @<sha> HEAD must come back empty), integrate that reviewed tree, unclosed ASKs → backlog entries, each with its wording attached (a prose ASK's replacement text)."],
  ["orchestrate/references/protocol.md","A prose finding outside the fence without verified wording keeps its present route, and so does a SWEEP item recorded after the sweep has merged (a fix-up's reviewer at a re-issue, say): no second sweep runs, and the item takes the backlog route with its findings heading named."],
  ["orchestrate/references/protocol.md","its items live in the backlog |"],
  ["orchestrate/references/protocol.md","Verdicts are four: pass · fail (did something else — triage to the offending batch(es) → ❌) · blocked (the step could not be performed as written — correct the STEP and re-ask, or reclassify as fail if the app lacks the behavior) · works-but (works exactly as specified, the user wants it different → named backlog entry — never a failure, never blocks the pass)."],
  ["orchestrate/references/protocol.md","residual → severity-tagged backlog entry + one Runner: human smoke step the orchestrator authors into the batch file's Smoke section AFTER the merge, on the integration branch (next checkpoint page, or a re-issue of the passed one) | ⛔ (dropped);"],
  ["orchestrate/references/protocol.md","items → backlog;"],
  ["orchestrate/references/protocol.md","FIX FIRST again → capped, marker re-written | trial-validate, then merge only if green (the open finding → backlog + smoke step);"],
  ["orchestrate/references/protocol.md","that batch → ⛔ (dropped), items → backlog |"],
  ["orchestrate/references/protocol.md","residual → backlog | as ship;"],
  ["orchestrate/references/protocol.md","re-issue with the failing step annotated as a known residual (backlog) | reviewed fix/<batch>-revert of the indicted batch's merge;"],
  ["orchestrate/references/protocol.md","Wherever this document routes an item to the backlog — this table's cells, §Severity and round accounting's discarded polish and its SWEEP items that keep or take the backlog route, the Status legend's ⛔ (dropped) batch, a works-but verdict, the convergence pass, step 8's run-end prose sweep returning an item or its reviewer's FIX FIRST reverting one, and any other dropped item — the orchestrator records it as a residual: a LOG.md heading ### residual: <source> — <one line>, <source> being B<NN> R<k>, B<NN> R<k> SWEEP <n>, B<NN> R1 sweep, C<n> step <k>, convergence or audit, that names the byte-copied findings heading holding the item's wording, or carries the wording when no findings file holds it;"],
  ["orchestrate/references/protocol.md","For each fold-in the plan's §Backlog fold-ins marks (prose-only) (<id> — <text> → B<NN> (prose-only);"],
  ["orchestrate/references/protocol.md","never the files' parent content, which would also undo the batch's later commits to them), the row's Notes get fold-in returned: <id> @<sha>, and the item stays in the backlog."],
  ["orchestrate/references/protocol.md","For a returned fold-in, before the reviewer is rendered, a ledger commit adds to the batch file's notes on the integration branch [<id>] returned to the backlog at 6a: its checklist item and acceptance criterion no longer apply, so the reviewer holds the batch to the rest."],
  ["orchestrate/references/protocol.md","The orchestrator applies each item's replacement text from its findings entry itself, one commit per item, its subject naming the item's heading, and classifies each item's commit as step 6a proves a prose-only fold-in, a return there reverting that commit and sending the item to the backlog route."],
  ["orchestrate/references/protocol.md","its FIX FIRST reverts each item it names and sends it to the backlog route — one strike, never a round, never ⛔."],
  ["orchestrate/references/protocol.md","The backlog file is a to-do list."],
  ["orchestrate/references/protocol.md","An item enters it only through the change-complete ruling step (step 3 below), and only past the bar of the pinned skill's references/backlog.md: works-but verdicts, request items the coverage audit finds unimplemented and P0/P1 defects with a concrete scenario skip the bar's judgement, and the bar never lowers a severity."],
  ["orchestrate/references/protocol.md","Change-complete (after the FINAL checkpoint passes and every batch is ✅ or ⛔ (dropped)), run with the contract's convergence, backlog, guardrails and release facts:"],
  ["orchestrate/references/protocol.md","anything but implemented becomes a named backlog entry or a convergence mini-batch the user is asked about."],
  ["orchestrate/references/protocol.md","Final coverage audit in PROGRESS: every request item (fold-ins included) maps to a merged commit, an intended-behavior resolution, or a named entry in the backlog file — zero unaccounted."],
  ["orchestrate/references/protocol.md","Fold-ins are REMOVED from the backlog file in the close-out commit (the ledger row and commit message carry provenance);"],
  ["orchestrate/references/protocol.md","A fold-in whose row's Notes carry fold-in returned: <id> @<sha> stays in the backlog file: its Folded into … marker is removed, its Since: rewritten to the date it returned with its source naming the batch that returned it, and its coverage row names that entry."],
  ["orchestrate/references/protocol.md","- The list: every ### residual: heading of this run's LOG.md, and each item that node \"<skill-dir>/tools/backlog.mjs\" expired --backlog <file> --days <n> --today <YYYY-MM-DD> names, run on the contract's backlog file with the contract's expiry (a whole number of days) and today's date."],
  ["orchestrate/references/protocol.md","Each residual's paths are checked against the contract's rulings file with node \"<skill-dir>/tools/backlog.mjs\" rulings --rulings <file> --paths <paths>;"],
  ["orchestrate/references/protocol.md","- Proposals: for each residual the orchestrator proposes register (the form's fields filled, its paths written repository-relative as references/backlog.md says — backlog.mjs check does not refuse a C:/…, ~/… or $HOME/… path, so the orchestrator reads them itself), rule (accepted or declined, with a reason) or LOG only;"],
  ["orchestrate/references/protocol.md","for an expired item, keep (its Since: rewritten), rule, or drop (removed from the to-do list;"],
  ["orchestrate/references/protocol.md","- Packs: node \"<skill-dir>/tools/backlog.mjs\" packs --backlog <file> --threshold <n> with the contract's pack threshold, over the backlog file as it stands, each file's count raised by this run's items proposed for registration that name it (nothing is written before the user rules)."],
  ["orchestrate/references/protocol.md","- A file not in the form: when backlog.mjs prints UNKNOWN for the backlog or the rulings file (one not yet in the form, every repository's until its migration, or a missing one), the STOP says which file and why, and each item is registered or ruled in that file's current form, a missing file being created in the form."],
  ["orchestrate/references/protocol.md","For the backlog file the list then forms from LOG.md's residuals alone and no pack is proposed;"],
  ["orchestrate/references/protocol.md","Once the backlog file carries the form, every entry written to it passes node \"<skill-dir>/tools/backlog.mjs\" check --backlog <file>."],
  ["orchestrate/references/protocol.md","the user rules once, the proposals as defaults, and only the user's word registers or rules an item."],
  ["orchestrate/references/protocol.md","The user's words are recorded verbatim in the smoke-test verdict log (Checkpoint column ruling) in their own commit, before anything is written to the backlog file or the rulings file, so a crash after it never loses a ruling."],
  ["orchestrate/references/protocol.md","An item it returns or its reviewer's FIX FIRST reverts is registered with its replacement text attached, the user's fix-now ruling being its pass of the bar, and the hand-over names it."],
  ["orchestrate/references/protocol.md","The backlog file and the rulings file are written once the sweep has merged;"],
  ["orchestrate/references/ruling-page-template.html","const NO = [\"decline\", \"drop\", \"skip\"], LATER = [\"register\", \"keep\", \"log\"];"],
  ["orchestrate/references/ruling-page.md","| residual | Fix now (only when proseOnly), Register, Accept, Decline, LOG only | Fix now: the ruling sweep (protocol.md);"],
  ["orchestrate/references/ruling-page.md","Register: an entry in the contract's backlog file;"],
  ["orchestrate/references/ruling-page.md","source names where the item came from: the LOG.md heading of a residual, the backlog id and Since: date of an expired item, the backlog.mjs packs line of a pack."],
  ["orchestrate/references/ruling-page.md","entry holds the form's fields (references/backlog.md) for the entry an outcome writes: id, title, kind, files, tests ([] for none), failure, doneWhen and from (the batch or round the Since: source names after the ledger id) for a backlog entry;"],
  ["orchestrate/references/ruling-page.md","re-checked against the tip.\" }, { \"key\": \"pack\", \"title\": \"Packs\" }, { \"key\": \"done\", \"title\": \"Already ruled\" } ], \"items\": [ { \"id\": \"R01\", \"kind\": \"residual\", \"group\": \"fix\", \"proseOnly\": true, \"proposal\": \"fix\", \"what\": \"The cart total's header says every total is rounded\", \"detail\": \"A total in a zero-decimal currency is not.\", \"where\": \"src/cart/total.js · total\", \"source\": \"### prose sweep: B02 R1 SWEEP 1\" }, { \"id\": \"R02\", \"kind\": \"residual\", \"group\": \"reg\", \"proposal\": \"register\", \"what\": \"A cart total drops the discount on a reload\", \"where\": \"src/cart/store.js\", \"source\": \"### residual: B02 R1 — the store reloads without the code\", \"entry\": { \"id\": \"TD-016\", \"rulingId\": \"RL-005\", \"title\": \"A cart total drops the discount on a reload\", \"kind\": \"behaviour\", \"files\": [\"src/cart/total.js\", \"src/cart/store.js\"], \"tests\": [\"tests/cart/total.test.js\"], \"failure\": \"a shopper who reloads the cart page with a discount code applied sees the full price, and is charged it.\", \"doneWhen\": \"a reload with a code applied shows the discounted total, and a test that reloads the store asserts it.\", \"from\": \"B02 round 1\" } }, { \"id\": \"R03\", \"kind\": \"residual\", \"group\": \"reg\", \"proposal\": \"decline\", \"what\": \"The coupon parser could be a grammar\", \"source\": \"### residual: B03 R1 — parser shape\", \"entry\": { \"rulingId\": \"RL-006\", \"title\": \"Rewrite the coupon parser as a grammar\", \"files\": [\"src/coupons/parse.js\"] } }, { \"id\": \"TD-009\", \"kind\": \"expired\", \"group\": \"old\", \"proposal\": \"keep\", \"what\": \"The receipt footer misaligns on narrow printers\", \"source\": \"TD-009, since 2026-01-30\" }, { \"id\": \"P1\", \"kind\": \"pack\", \"group\": \"pack\", \"proposal\": \"skip\", \"what\": \"src/cart/total.js holds 5 to-do items\", \"source\": \"PACK src/cart/total.js 5: TD-004, TD-007, TD-011, TD-014, TD-016\" }, { \"id\": \"SCAN-3\", \"kind\": \"residual\", \"group\": \"done\", \"ruled\": \"Leave open, high priority\", \"what\": \"A refund can show as not refunded\", \"source\": \"### residual: B04 R1 — refund read\" } ] }"],
  ["orchestrate/references/ruling-page.md","- node \"<skill-dir>/tools/build-ruling-page.mjs\" read <ledger>/ruling.json <paste file> --entries checks the saved paste: RULINGS OK with one line per outcome given (FIX, REGISTER, ACCEPT, DECLINE, LOG, KEEP, DROP, TAKE, SKIP, each with its ids), then the CHANGED and NOTED rows and the general NOTE;"],
  ["orchestrate/references/ruling-page.md","--entries also prints the entries the rulings write, dated --today <YYYY-MM-DD> or the sidecar's date, after --- backlog entries and --- rulings entries, each read by backlog.mjs's own parser first;"],
  ["orchestrate/references/protocol.md","On \"continue\" with nothing active: reconcile, report completion, and point at the backlog for follow-ups."],
  ["orchestrate/references/scaffolding.md","Backlog sweep — read the repo's backlog / feature / bug files and propose fold-ins;"],
  ["orchestrate/references/scaffolding.md","a backlog file in the form of the pinned skill's references/backlog.md is read as the to-do list, and the rulings file is never read here."],
  ["orchestrate/references/scaffolding.md","A prose-only item — every path it changes is Markdown, or JavaScript that prose-only-diff.mjs reads as PROSE-ONLY, and none is a file agents read as instructions (the project's agent instructions wherever they load from, anything under .claude/, a skill's own Markdown) or prose that is a contract — is exempt from (d): it folds in with no per-batch cap and onto a batch of any weight, (a) still keeping waves disjoint, and the plan's Backlog fold-ins section marks its line (prose-only)."],
  ["orchestrate/references/scaffolding.md","Eligibility comes from the entry and the proof from the batch gate (protocol.md), which reverts a fold-in commit that does not classify as prose-only and returns its item to the backlog."],
  ["orchestrate/references/scaffolding.md","coverage rows tagged backlog <id>), gets its own checklist item, acceptance criterion and smoke step (a prose-only one no smoke step) in the host batch, and its own commit."],
  ["orchestrate/references/scaffolding.md","Only the ACCEPTED items receive an id in the repo's scheme ({{BACKLOG_ID_PREFIX}});"],
  ["orchestrate/references/scaffolding.md","the rest of the backlog is untouched."],
  ["orchestrate/references/scaffolding.md","When the backlog file is in the form (it holds the form line), run node \"<SKILL_DIR>/tools/backlog.mjs\" packs --backlog <the backlog file> --threshold <the pack threshold> (the interview's {{PACK_THRESHOLD}}): each file it prints that the draft plan touches is proposed as an extra batch, holding that file's to-do items, in a later wave than the plan's batch on that file — proposed, never run unasked, and picked at PLAN APPROVAL like the fold-ins;"],
  ["orchestrate/references/scaffolding.md","When backlog.mjs prints UNKNOWN instead (a backlog not yet in the form, or none), no pack is proposed and the plan's Backlog fold-ins section says so in one line."],
  ["orchestrate/references/scaffolding.md","- sections — one Markdown text per instruction comment outside 02-batch.md, keyed <template> <heading line> (01-plan.md ## Backlog fold-ins);"],
  ["orchestrate/references/scaffolding.md","Scaffold commit — batch 00 = the ledger itself (plus the ids written onto accepted fold-ins in the backlog file), committed on chore/{{CHANGE_SLUG}}-ledger, which becomes the INTEGRATION BRANCH every wave stacks onto."],
  ["orchestrate/references/scaffolding.md","scaffold.mjs has already ended each accepted fold-in's backlog line (inside a table row's last cell) with Folded into <CHANGE_ID> <Bnn>., an item named by its \"anchor\" first taking the next id of the {{BACKLOG_ID_PREFIX}} scheme in that file;"],
  ["orchestrate/references/scaffolding.md","| {{BACKLOG_FILE}} | template (READBEFORE) | detected (BACKLOG.md, TODO.md, issue tracker) or BACKLOG.md (create on first residual) |"],
  ["orchestrate/references/scaffolding.md","| {{BACKLOG_ID_PREFIX}} | template (READBEFORE) | detected id scheme in the backlog files (SCAN-6, #3.5, BL-017 …) or BL- when none;"],
  ["orchestrate/references/scaffolding.md","| {{RULINGS_FILE}} | template (READBEFORE) | the interview — the file holding the user's rulings in the form of references/backlog.md;"],
  ["orchestrate/references/scaffolding.md","default RULINGS.md beside the backlog file, created at the first ruling;"],
  ["orchestrate/references/scaffolding.md","| {{PACK_THRESHOLD}} | template (READBEFORE) | the interview — the count of to-do items on one file at or over which the backlog sweep proposes a pack (backlog.mjs packs --threshold <n>), a whole number;"],
  ["orchestrate/references/scaffolding.md","| {{BACKLOG_EXPIRY}} | template (READBEFORE) | the interview — the days after its Since: date past which a to-do item has expired (backlog.mjs expired --days <n>), a whole number;"],
  ["orchestrate/references/scaffolding.md","| Conventions / prohibitions / guardrails / backlog | project CLAUDE.md, CONTRIBUTING.md, .claude/ docs;"],
  ["orchestrate/references/scaffolding.md","files named BACKLOG/TODO/BUGS/FEATURE;"],
  ["orchestrate/references/scaffolding.md","the id pattern their entries carry | {{REPO_CONVENTIONS}}, {{EXTRA_PROHIBITIONS}}, {{GUARDRAILS_REF}}, {{BACKLOG_FILE}}, {{BACKLOG_ID_PREFIX}} |"],
  ["orchestrate/references/scaffolding.md","Confirm the backlog id scheme, the rulings file, the pack threshold and the backlog expiry."],
  ["orchestrate/references/scaffolding.md","only if detection found no guardrails section or backlog file: create them at first close-out? (default yes)."],
  ["orchestrate/references/scaffolding.md","Defaults for a repo's FIRST ledger under this contract (the pilot): always on — the mechanical fence check, failing-on-base, plan pre-flight, the backlog sweep, the metrics token."],
  ["orchestrate/references/smoke-page-template.html","It goes to the backlog."],
  ["orchestrate/references/smoke-page-template.html","failure, never counts against the build, goes to the backlog."],
  ["orchestrate/references/smoke-page-template.html","goes to the backlog.\""],
  ["orchestrate/references/smoke-page-template.html",": marked || agent === \"stale\" ? \"rerun\" : \"todo\";"],
  ["orchestrate/references/smoke-page-template.html","var c = { pass: 0, fail: 0, blocked: 0, change: 0, carried: 0, rerun: 0, pre: 0, todo: 0 };"],
  ["orchestrate/references/smoke-page-template.html","document.getElementById(\"t-todo\").textContent = c.todo;"],
  ["orchestrate/references/smoke-page-template.html","if (kind === \"todo\" || kind === \"rerun\") {"],
  ["orchestrate/references/smoke-page-template.html","\" · needs re-run \" + c.rerun + \" · pre-verified only \" + c.pre + \" · not run \" + c.todo + \" of \" + TOTAL);"],
  ["orchestrate/references/subagent-prompts.md","commit on your batch branch with a conventional message (\"[TYPE]: <summary> (batch [NN])\") — one separate commit per backlog fold-in item, its message carrying the item's id."],
  ["orchestrate/references/subagent-prompts.md","The count has a blind spot: node counts a test file that registers no tests as one passing test named after the file, which the harness reports as a file that ran no tests unless node names it by a relative path whose first segment holds a space (my file.test.js, my dir/a.test.js) — there a mutation after which a one-test file registers nothing does not change the count and reads SURVIVED, so before you cite a SURVIVED line, check its run in the log for a scoped test file reported under its own file name."],
  ["orchestrate/references/subagent-prompts.md","Then grep the repository's backlog and bug trackers and its old ledgers under .agents/ for every file this batch changes or depends on and for its main symbols;"],
  ["orchestrate/templates/00-READBEFORE.md","- Backlog: {{BACKLOG_FILE}} is the to-do list, an item registering there only past the bar of the pinned skill's references/backlog.md, with ids in the {{BACKLOG_ID_PREFIX}} scheme;"],
  ["orchestrate/templates/00-READBEFORE.md","expiry {{BACKLOG_EXPIRY}} days."],
  ["orchestrate/templates/00-request.md","Accepted backlog fold-ins are decisions too: folded from <file> <id> — approved <date>."],
  ["orchestrate/templates/00-request.md","Source = \"request\" or \"backlog <id>\"."],
  ["orchestrate/templates/01-plan.md","## Backlog fold-ins"],
  ["orchestrate/templates/01-plan.md","<!-- Accepted at plan approval, one line each: <id> — <backlog text, verbatim> → B<NN> (files ⊆ that batch's fence, machine-verifiable, one-line criterion, ≤2 per batch, none on L batches)."],
  ["orchestrate/templates/01-plan.md","A prose-only item ends its line with the marker: <id> — <backlog text, verbatim> → B<NN> (prose-only);"],
  ["orchestrate/templates/01-plan.md","where backlog.mjs packs prints UNKNOWN, one line says no pack was proposed."],
  ["orchestrate/templates/02-batch.md","Backlog fold-ins appear as their own sub-heading with the item's id and verbatim backlog text."],
  ["orchestrate/templates/LOG.md","pre-flight findings and how each was resolved, backlog fold-ins considered and rejected (with the reason), wave-map reasoning beyond the plan's one-liners, environment facts verified."],
  ["orchestrate/templates/PROGRESS.md","Source = \"request\" or \"backlog <id>\" for an accepted fold-in."],
];
test('the skill\'s shipped text names the backlog only in the units BACKLOG_UNITS lists', () => {
  const files = backlogFiles();
  assert.ok(['orchestrate/SKILL.md', PROTOCOL_PATH, 'orchestrate/references/smoke-page.md', 'orchestrate/references/smoke-page-template.html',
    'orchestrate/references/execution-models.md', 'orchestrate/references/backlog.md', TEMPLATE].every(file => files.includes(file)),
    'the domain is every shipped Markdown file and the smoke page');
  assert.deepEqual(shipped().filter(file => !files.includes(file) && !/\.(?:mjs|cjs|js)$/.test(file)), [], 'every shipped file left out is code');
  const faults = texts => closedFaults(texts, unit => BACKLOG_WORD.test(unit), BACKLOG_UNITS);
  const as = (put = () => '') => files.map(file => [file, backlogText(file, read(file) + put(file))]);
  const whole = as();
  assert.deepEqual(faults(whole), []);
  // Live: each direct registration, in the skill's words with and without "backlog", appended to each carrier the
  // template and the page among them, is reported there alone; a listed unit reworded is reported with its listed form gone.
  const DIRECT = ['A works-but verdict is written to the backlog file as a named entry at once, with no ruling.',
    'A works-but verdict is also added to the to-do list at once, with no ruling.',
    'The orchestrator registers each works-but verdict itself at once, with no ruling.',
    'Works-but verdicts are written to {{BACKLOG_FILE}} at once, with no ruling.'];
  const carriers = ['orchestrate/SKILL.md', PROTOCOL_PATH, 'orchestrate/references/smoke-page.md', 'orchestrate/references/execution-models.md',
    TEMPLATE, 'orchestrate/references/smoke-page-template.html'];
  const planted = carriers.flatMap(carrier => DIRECT.map(direct => [carrier, direct]));
  assert.deepEqual(planted.map(([carrier, direct]) => faults(as(file => file === carrier ? '\n\n' + direct + '\n' : ''))),
    planted.map(([carrier, direct]) => [carrier + ' :: ' + direct]), 'a direct registration planted in each carrier must be reported');
  const [file, unit] = BACKLOG_UNITS.find(([, listed]) => listed.startsWith('An item enters it only through'));
  const reworded = whole.map(([f, text]) => [f, f === file ? text.replace('An item enters it only through', () => 'An item enters it through') : text]);
  assert.deepEqual(faults(reworded), [file + ' :: ' + unit.replace('An item enters it only through', 'An item enters it through'), 'gone: ' + file + ' :: ' + unit]);
});

// Step 6's report check as protocol.md publishes it: the one code span holding --report, taken from step 6 alone and
// found nowhere else in the file, its placeholders filled (filledCommand) and run as those bytes (runCommand) on the
// tool the skill copy with a space in its path holds, against a report file in the implementer skeleton's shape whose
// own path holds a space. Its line is judged by the verdict form the same step publishes, the status words read from
// the skeletons by the tool's own reportRules; the control gives another nonce, which the same file must fail, and a
// fix-up report, which has no nonce line, passes the span run without its --nonce.
test('step 6 publishes the report check once, and it runs as published: its own verdict form on the nonce given, REPORT FAIL on another', async t => {
  const text = read(PROTOCOL_PATH), step6 = section(text, '\n6. Gate PER BATCH', '\n   - **6a ');
  const spans = [...step6.matchAll(/`([^`\n]*--report[^`\n]*)`/g)].map(m => m[1]);
  assert.equal(spans.length, 1, 'step 6 publishes the --report command once, in one code span on one line: ' + JSON.stringify(spans));
  // Every Markdown file the orchestrator reads, README included, bound to the checkout: the span is step 6's alone.
  const markdown = documents().filter(file => file.endsWith('.md'));
  assert.ok(['orchestrate/SKILL.md', PROTOCOL_PATH, PROMPTS, 'README.md'].every(file => markdown.includes(file)), 'the span count reads the whole Markdown domain');
  const reportSpans = markdown.flatMap(file => [...read(file).matchAll(/`[^`\n]*--report[^`\n]*`/g)].map(() => file));
  assert.deepEqual(reportSpans, [PROTOCOL_PATH], 'the --report command is published once, in protocol.md step 6, and in no other document');
  const forms = [...step6.matchAll(/`(REPORT <status>[^`\n]*)`/g)].map(m => m[1]);
  assert.equal(forms.length, 1, 'step 6 publishes the verdict form once: ' + JSON.stringify(forms));
  const { reportRules } = await promptTool();
  const { statuses } = reportRules(read(PROMPTS));
  const escape = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const VERDICT = new RegExp('^' + forms[0].split(/(<status>|<n>|<m>)/).map(part => part === '<status>' ? '(?:' + statuses.join('|') + ')'
    : part === '<n>' || part === '<m>' ? '\\d+' : escape(part)).join('') + '\n$');
  const { temp, env, skillDir } = fixture(t);
  const reports = path.join(temp, 'report files'); fs.mkdirSync(reports);
  const file = path.join(reports, 'B05 implementer.md'), fixUp = path.join(reports, 'B05 fix-up.md'), NONCE = 'c4c59f7a04c3';
  fs.writeFileSync(file, ['### B05 R1 implementer findings', 'DONE', 'NONCE ' + NONCE, 'EVIDENCE: PASS tests 9/9 (1s) exit 0',
    'commit 0123abc; checklist 6/6', '', 'What changed and why.', ''].join('\n'));
  fs.writeFileSync(fixUp, ['### B05 R1 fix-up findings', 'DONE', 'EVIDENCE: PASS tests 9/9 (1s) exit 0',
    'commit 0123abc; checklist 2/2', '', 'What changed and why.', ''].join('\n'));
  const values = (report, nonce) => ({ '<skill-dir>': slash(skillDir), '<file>': slash(report), ...(nonce === undefined ? {} : { '<nonce>': nonce }) });
  const run = nonce => runCommand(filledCommand(spans[0], values(file, nonce)), temp, env);
  const passed = run(NONCE);
  assert.equal(passed.status, 0, passed.stdout + passed.stderr);
  assert.match(passed.stdout, VERDICT, 'the tool prints the verdict form step 6 publishes');
  assert.equal(passed.stdout, 'REPORT DONE checklist 6/6\n');
  const other = run('0123456789ab');
  assert.equal(other.status, 1, other.stdout + other.stderr);
  assert.match(other.stdout, /^REPORT FAIL line 3 /);
  assert.doesNotMatch(other.stdout, VERDICT, 'a failed check is not the published verdict form');
  // The fix-up case the sentence names: the span with its --nonce flag dropped, as the sentence says.
  const NONCE_FLAG = ' --nonce <nonce>';
  assert.ok(spans[0].endsWith(NONCE_FLAG), 'the span ends with its --nonce flag: ' + spans[0]);
  const bare = runCommand(filledCommand(spans[0].slice(0, -NONCE_FLAG.length), values(fixUp)), temp, env);
  assert.equal(bare.status, 0, bare.stdout + bare.stderr);
  assert.match(bare.stdout, VERDICT);
});

// The two reversals of the report file the pins above cannot see outside their bounds: a final message that carries the
// report again, and an orchestrator that reads the report file in full. Each fires only where no negator governs it
// (fires(), the undo sweep's reader), over every shipped Markdown file and README; each specimen is reported once.
const REPORT_REVERSALS = [
  ['a final message carrying the report', /\bfinal message\s+(?:also\s+)?(?:carr(?:y|ies|ied)|hold(?:s|ing)?|contain(?:s|ing)?|includ(?:e|es|ing)|is)\b[^.;:]*\b(?:full|whole|entire)\s+report\b/i,
    'Its final message also carries the full report.'],
  ['the orchestrator reading the report file in full', /\breads?\b[^.;:]*\breport files?\b[^.;:]*\bin full\b/i, 'The orchestrator reads the report file in full first.'],
];
const reportReversals = text => clauses(unticked(text)).flatMap(c => REPORT_REVERSALS.filter(([, p]) => fires(p, c)).map(([name]) => name + ' — ' + c));
test('no document lets a final message carry the report or the orchestrator read the report file in full', () => {
  const markdown = documents().filter(file => file.endsWith('.md'));
  assert.ok(['orchestrate/SKILL.md', PROTOCOL_PATH, PROMPTS, 'README.md'].every(file => markdown.includes(file)));
  const hits = markdown.flatMap(file => reportReversals(read(file)).map(hit => file + ' :: ' + hit));
  assert.deepEqual(hits, []);
  // Must pass: protocol.md's own rule and its negations.
  assert.deepEqual(reportReversals('The orchestrator never reads the report file in full. The final message never carries the full report.'), []);
  // Live controls: each specimen planted where the gate's mutations put it, next to the rule it reverses, is reported once by its family alone.
  const text = read(PROTOCOL_PATH);
  for (const [[name, , specimen], anchor] of [[REPORT_REVERSALS[0], 'Wave siblings run concurrently. '], [REPORT_REVERSALS[1], 'resume the implementer for it (not a round). ']]) {
    assert.equal(text.split(anchor).length - 1, 1, 'the control anchor must occur once: ' + anchor);
    assert.deepEqual(reportReversals(text.replace(anchor, () => anchor + specimen + ' ')).map(hit => hit.split(' — ')[0]), [name], 'must be reported: ' + specimen);
  }
});
