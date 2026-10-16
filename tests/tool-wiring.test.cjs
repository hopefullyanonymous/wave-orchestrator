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
];
const PINNED_ROWS = {
  SKILL_DIR: "| `{{SKILL_DIR}}` | template (READBEFORE) | the absolute path of the directory holding the skill's `SKILL.md` (the base directory the skill loader reports), forward slashes, stored RAW between the pin line's backticks — never quoted there; every command that uses it quotes it. Never relative or `~`: the pin check reads it from the working directory |",
  SKILL_SHA256: "| `{{SKILL_SHA256}}` | template (READBEFORE) | the hex field of `node \"<SKILL_DIR>/tools/check-ledger.mjs\" skill --dir \"<SKILL_DIR>\"`, run at fill time |",
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
  assert.equal(PINNED.length, 7, 'seven passages are pinned; the list may not shrink to a sample');
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
    .replace('REPORT (fixed shape — the orchestrator acts on nothing else):\nLine 1', 'REPORT (fixed shape — the orchestrator acts on nothing else):\n' + NONCE_LINE + '\nLine 1');
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
  'orchestrate/references/protocol.md': [
    'Polish pass: resume the same implementer with the pointer to its rendered polish prompt (the findings file by path); it appends - [ ] polish: items to its checklist, does them, commits; '
      + 'closes mechanically (fence check + validations; polish commits touch only test/doc/prose paths — a production file touched → fix-diff-only re-review by a fresh reviewer).',
    '- Round 1: resume the SAME implementer with the pointer to its rendered fix-round prompt (the findings file by path, after the LOG append — §Session algorithm step 6); a fresh re-review verifies the fixes and scans only the fix diff.',
    'Past about 400K tokens of implementer context, round 1 goes to a fresh implementer with its rendered rework prompt instead (subagent-prompts.md §Spawning rules).',
    '- **6c Reviewer + gate agents, in parallel, all fresh and read-only.** Each is rendered and spawned as in step 5 (--role reviewer, reviewer-round2 or test-hunter); a gate report with the wrong nonce is no report and its agent is respawned fresh.',
  ],
  [PROMPTS]: [
    '**Polish pass** (after a SHIP that carries ASKs): resume the SAME implementer (SendMessage) with the pointer to this block, rendered as role polish:',
    '**Fix round 1** (after a FIX FIRST): resume the SAME implementer (past about 400K tokens of its context, a FRESH one with the rework prompt below — §Spawning rules) with the pointer to this block, rendered as role fix-round:',
    '**Rework** (a FRESH implementer owed a fix round — §Spawning rules): the implementer prompt with this block in place of its DO: paragraph, rendered as role rework:',
    '**Authorized third round** (the user chose "fix again" after ⛔): a FRESH implementer on the strong tier, spawned with the pointer to its rendered rework prompt (round 3, both rounds\' findings files joined into its findings file) — one prompt, one report, one nonce.',
    '**Round 2** (after a FIX FIRST — always a FRESH reviewer): the same prompt with this block at its [ROUND 2 BLOCK] slot, rendered as role reviewer-round2 (role reviewer drops that line):',
    '- Resume vs fresh: polish passes and the first fix round RESUME the same implementer (SendMessage, with the pointer to the rendered polish or fix-round prompt); a user-authorized third round is a FRESH implementer on the strong tier; '
      + 'reviewers are fresh every round; any agent lost to a crash is respawned fresh at the first unticked item — an implementer owed a fix round with its rendered rework prompt, one owed a polish pass with its rendered implementer prompt first, then the polish pointer.',
    'A fix round goes instead to a FRESH implementer with the rendered rework prompt when the implementer it would resume shows subagent_tokens (its current context) past about 400K in its last task notification.',
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
  'README.md': ['├── prompt.mjs renders one per-batch sub-agent prompt from the ledger and a facts file, ending in the nonce its report echoes'],
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
// fresh" bullet, which states the third round again with the crash respawns and the 400K
// exception; and the "**Fix round 1**" lead-in, which states that exception beside the block.
const THIRD_ROUND = ['**Authorized third round**', '\n\n## Reviewer',
  '**Authorized third round** (the user chose "fix again" after `⛔`): a FRESH implementer on the strong tier, spawned with the pointer to its rendered `rework` prompt '
  + '(`round` 3, both rounds\' findings files joined into its findings file) — one prompt, one report, one nonce. Then a fresh re-review.'];
const RESUME_VS_FRESH = ['- Resume vs fresh:', '\n- Tiers:',
  '- Resume vs fresh: polish passes and the first fix round RESUME the same implementer (SendMessage, with the pointer to the rendered `polish` or `fix-round` prompt); '
  + 'a user-authorized third round is a FRESH implementer on the strong tier; reviewers are fresh every round; any agent lost to a crash is respawned fresh at the first unticked item — '
  + 'an implementer owed a fix round with its rendered `rework` prompt, one owed a polish pass with its rendered implementer prompt first, then the `polish` pointer. '
  + 'A fix round goes instead to a FRESH implementer with the rendered `rework` prompt when the implementer it would resume shows `subagent_tokens` (its current context) past about 400K in its last task notification.'];
const FIX_ROUND_LEAD = ['**Fix round 1**', '\n\n```prompt:fix-round',
  '**Fix round 1** (after a `FIX FIRST`): resume the SAME implementer (past about 400K tokens of its context, a FRESH one with the `rework` prompt below — §Spawning rules) with the pointer to this block, rendered as role `fix-round`:'];
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
  // A fix round past about 400K of implementer context goes to a fresh implementer, stated in
  // §Spawning rules and pointed at from protocol.md's round 1, execution-models.md's gate and the
  // "**Fix round 1**" lead-in (FIX_ROUND_LEAD, pinned below).
  assert.ok(rules.includes('A fix round goes instead to a FRESH implementer with the rendered `rework` prompt when the implementer it would resume shows `subagent_tokens` (its current context) past about 400K in its last task notification.'));
  assert.ok(collapse(read('orchestrate/references/protocol.md')).includes('Past about 400K tokens of implementer context, round 1 goes to a fresh implementer with its rendered `rework` prompt instead (`subagent-prompts.md` §Spawning rules).'));
  assert.ok(collapse(read('orchestrate/references/execution-models.md')).includes('`FIX FIRST` → round 1 resumes the implementer (past about 400K tokens of its context, a fresh one with the `rework` prompt — subagent-prompts.md §Spawning rules);'));
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
// never read. The control run dropped the per-role effort rule; the gate pair's max pin
// (2026-09-27) and the census's medium pin (2026-10-13) are its two exceptions, held at
// EFFORT_LINES and tierKeyFaults.
const NO_POLL = 'The orchestrator never polls: it never calls `ReadNotifications` to wait for a sub-agent and never sleeps; when the only remaining work waits on sub-agents it ends the turn, and the task notification resumes it.';
const BUDGET = {
  pollSkill: ['orchestrate/SKILL.md', '- The orchestrator never polls', '\n- No `--no-verify`', '- ' + NO_POLL],
  pollProtocol: ['orchestrate/references/protocol.md', 'The orchestrator never polls', '\n- **Implementer**', NO_POLL],
  cadence: ['orchestrate/SKILL.md', '- Default session cadence', '\n- The orchestrator never polls',
    '- Default session cadence: run autonomously to the next checkpoint — waves in sequence, no stopping between batches — halting early only at ⛔ or an unplanned user gate, or pausing at a safe point for context (protocol.md §Session algorithm step 8).'],
  compaction: ['orchestrate/references/protocol.md', 'Compaction happens only at a safe point', '\n\n**Session practices**',
    "Compaction happens only at a safe point, never mid-flight: a wave close, the start of a checkpoint close-out, or the moment a checkpoint's fix-ups have all merged, before their rows go back to 🧪 and the re-issue (never after a capped fix-up's *ship*: its row still reads as awaiting a verdict) — each counting only once PROGRESS and LOG are committed and no agent is in flight. "
    + 'At a safe point with context past about 300K tokens, the orchestrator posts ONE line: its context size, the time it will continue, and the answers: `/compact` now (then wait for the timer, or say `continue`), or `go`. '
    + "It then starts a 10-minute timer, a background Bash `sleep 600`, and ends its turn; the first of the timer's completion notice, `go` or `continue` resumes it, and it ignores whatever arrives later. "
    + "That notice shows the task's description, not its output, so the description carries the reminder, verbatim: `Compaction window over: if this session was compacted, run the boot sequence and the reconcile before any transition`. "
    + "When this session's tools include `mcp__orchestrate-mod__schedule_clear` (orchestrate-mod's), the orchestrator calls it at that point in place of that line and the timer, with the ledger id and the integration tip's full SHA, once no background command of its own is running either and a committed PROGRESS session-log row names the LOG heading that records the work since the row before it. "
    + 'An answer that begins `scheduled` gives the one line to post: the orchestrator posts it and ends its turn, and the mod clears the conversation two minutes later unless a message arrives first, then runs `/orchestrate continue <id> after-clear`; a mod that finds it cannot clear runs `/orchestrate continue <id>` in this conversation instead. '
    + 'Any other answer, or no such tool, takes the line and the timer above. '
    + 'A conversation that goes on after a `scheduled` answer, because a message or a notice arrived first, is not cleared and carries on. '
    + "One that `/orchestrate continue <id> after-clear` opened boots as any `continue` does; its first message to the user opens with one line saying it continued after an automatic clear and naming the LOG heading that the newest session-log row names, and it ignores a task notice for a task it did not start, whose output file sits under another session's folder. "
    + 'A compacted session is resumed early only through `continue`, which starts this algorithm at step 1. '
    + 'A STOP that already waits for the user (⛔ verdicts, checkpoints), past about 300K, carries the context size and `/compact` now in its message instead of a timer. '
    + 'After any compaction, an automatic one included, the boot sequence and the reconcile run before any transition, because a summary is a claim, not truth; a merge, push or third-round authorization that exists only in a summary is re-asked.'],
  practices: ['orchestrate/references/protocol.md', '**Session practices**', '\n\n**User gates are front-loaded**',
    '**Session practices** (guidance, not tooled). An investigation unrelated to the change, such as a CI failure met while scaffolding, runs in its own session. A pause of over an hour expires the prompt cache, and the first call after it writes the whole context to the cache again.'],
  nextWave: ['orchestrate/references/execution-models.md', 'Otherwise → open the next wave immediately', '\n\n**Every `continue`',
    'Otherwise → open the next wave immediately, same session, unless protocol.md §Session algorithm step 8 first opens its compaction window at this safe point.'],
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
};
test('each budget rule reads exactly as pinned in every carrier the batch enumerated, the compaction rule at wave close', () => {
  const pinned = (text, from, to) => collapse(section(text, from, to)).trim();
  assert.equal(Object.keys(BUDGET).length, 10, 'ten passages are pinned; the list may not shrink to a sample');
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
// The passage names "a safe point" twice: in the pinned sentence, and where the window opens.
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
  // window opening at any point).
  for (const spelling of ['safe point', 'Safe point', 'safe-point', 'safepoint', 'safe_point', 'safe\n  // point']) {
    const fourth = passage.replace('no agent is in flight. ', () => 'no agent is in flight. Mid-wave, between two merges, is a ' + spelling + ' too. ');
    assert.notEqual(fourth, passage, 'the control must find the end of the clause');
    assert.deepEqual(safePointFaults(fourth), [(SAFE_POINT_MENTIONS + 1) + ' mentions of a safe point, not ' + SAFE_POINT_MENTIONS], JSON.stringify(spelling));
  }
  const fewer = passage.replace('At a safe point with context', () => 'At any point with context');
  assert.notEqual(fewer, passage, 'the control must find the mention where the window opens');
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
];
test('each budget rule\'s key word appears nowhere but inside its pinned carriers', () => {
  const files = documents(), prose = proseDocuments();
  assert.ok(files.includes('README.md') && files.includes('orchestrate/references/scaffolding.md') && files.some(f => f.endsWith('.mjs')),
    'the domain is the whole shipped tree, code included, plus README');
  assert.ok(prose.includes('README.md') && prose.includes('orchestrate/references/protocol.md') && prose.length < files.length
    && prose.every(f => files.includes(f) && f.endsWith('.md')), 'the prose domain is every Markdown file of that tree, and README');
  assert.equal(new Set(BOUND_WORDS.map(b => b[0])).size, BOUND_WORDS.length);
  // The narrowing is exactly the two ordinary words; widening back is free, narrowing more is an edit here.
  assert.deepEqual(BOUND_WORDS.filter(b => b[3] !== 'tree').map(b => b[0]), ['a fact-finding carrier', 'the scaffold effort ask'],
    'only the explore and effort families read the prose domain alone');
  for (const [what, pattern, allowed, domain] of BOUND_WORDS) {
    assert.ok(domain === 'tree' || domain === 'prose', what + ': names its domain');
    const swept = domain === 'tree' ? files : prose;
    const carriers = [...new Set(allowed.map(key => BUDGET[key][0]))].sort();
    assert.ok(carriers.every(c => swept.includes(c)), what + ': its domain must be a superset of its carriers');
    const mentioning = [], stray = [];
    for (const file of swept) {
      const text = read(file);
      if (pattern.test(text)) mentioning.push(file);
      stray.push(...strayMentions(file, text, pattern, allowed));
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
    '- `continue [<id>]` → run the session algorithm on the active ledger, or on ledger `<id>` when one is named; `continue <id> after-clear` is the form orchestrate-mod sends after it clears the conversation (protocol.md §Session algorithm step 8)'],
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
// and SKILL.md names the after-clear form once, in its dispatch line. "continue <id> after-clear"
// also counts the protocol.md command, so the form's count is both files'. Each name is also read
// by its key words, however spelled: the tool's short name, the after-clear word, and any
// `/orchestrate continue` command, the in-place one included.
const CLEAR_NAMES = [
  ['the tool', 'mcp__orchestrate-mod__schedule_clear', { 'orchestrate/references/protocol.md': 1 }],
  ['the tool, by its short name', /schedule[\W_]*clear/i, { 'orchestrate/references/protocol.md': 1 }],
  ['the after-clear command', '/orchestrate continue <id> after-clear', { 'orchestrate/references/protocol.md': 2 }],
  ['the after-clear form', 'continue <id> after-clear', { 'orchestrate/SKILL.md': 1, 'orchestrate/references/protocol.md': 2 }],
  ['the after-clear word', /\bafter[\W_]*clear/i, { 'orchestrate/SKILL.md': 1, 'orchestrate/references/protocol.md': 2 }],
  ['the in-place command', /\/orchestrate\W+continue\b/i, { 'orchestrate/references/protocol.md': 3 }],
];
const namedIn = (text, name) => typeof name === 'string' ? collapse(text).split(name).length - 1
  : [...collapse(text).matchAll(new RegExp(name.source, name.flags.replace(/[gy]/g, '') + 'g'))].length;
// Each fault in `texts` ([file, text] pairs): a name counted otherwise than CLEAR_NAMES says, and a
// mention outside its file's passage.
function clearNameFaults(texts) {
  const [pfile, pfrom, pto] = BUDGET.compaction, [, dfrom, dto] = CONTINUE_ID.find(([what]) => what === 'the dispatch line');
  const homes = { [pfile]: [pfrom, pto], 'orchestrate/SKILL.md': [dfrom, dto] }, faults = [];
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
test("the clear route's names sit in step 8's passage and SKILL.md's dispatch line only, counted", () => {
  const texts = shipped().map(file => [file, read(file)]), at = file => texts.findIndex(([f]) => f === file);
  const swap = (file, text) => texts.map((pair, i) => i === at(file) ? [file, text] : pair);
  assert.ok(at('orchestrate/SKILL.md') !== -1 && at('orchestrate/references/protocol.md') !== -1 && at('orchestrate/references/execution-models.md') !== -1);
  assert.deepEqual(clearNameFaults(texts), [], 'the names are where step 8 and the dispatch line put them, and nowhere else');
  const [pfile, pfrom, pto] = BUDGET.compaction, protocol = read(pfile), skill = read('orchestrate/SKILL.md');
  const command = '`/orchestrate continue <id> after-clear`', inPlace = '`/orchestrate continue <id>`';
  assert.ok(protocol.includes(command) && section(protocol, pfrom, pto).includes(command) && protocol.includes(inPlace), 'the control must find the commands inside the passage');
  // Each key-word family reads the full names it stands for.
  const family = what => CLEAR_NAMES.find(([name]) => name === what)[1];
  for (const [what, spellings] of [['the tool, by its short name', ['mcp__orchestrate-mod__schedule_clear']],
    ['the after-clear word', ['/orchestrate continue <id> after-clear', 'continue <id> after-clear']], ['the in-place command', ['/orchestrate continue <id> after-clear', '/orchestrate continue <id>']]]) {
    assert.ok(spellings.every(spelling => namedIn(spelling, family(what)) === 1), what + ': reads the full names it stands for');
  }
  // Live: one mention more just outside the passage, on either side, is reported as outside and as a count.
  const P = '{"' + pfile + '":', SP = '{"orchestrate/SKILL.md":1,"' + pfile + '":';
  assert.deepEqual(clearNameFaults(swap(pfile, protocol.replace(pfrom, () => 'Call `mcp__orchestrate-mod__schedule_clear` first.\n' + pfrom))),
    ['the tool: 1 outside its passage in ' + pfile, 'the tool: counted ' + P + '2}',
      'the tool, by its short name: 1 outside its passage in ' + pfile, 'the tool, by its short name: counted ' + P + '2}'], 'the tool named before the passage');
  assert.deepEqual(clearNameFaults(swap(pfile, protocol.replace(pto, () => pto + ' Then run ' + command + '.'))),
    ['the after-clear command: 1 outside its passage in ' + pfile, 'the after-clear command: counted ' + P + '3}',
      'the after-clear form: 1 outside its passage in ' + pfile, 'the after-clear form: counted ' + SP + '3}',
      'the after-clear word: 1 outside its passage in ' + pfile, 'the after-clear word: counted ' + SP + '3}',
      'the in-place command: 1 outside its passage in ' + pfile, 'the in-place command: counted ' + P + '4}'], 'the command named after the passage');
  // Live: one fewer inside is reported as a count; the same mention moved out keeps the count and is reported as outside.
  const fewer = protocol.replace(command, () => 'its command');
  assert.deepEqual(clearNameFaults(swap(pfile, fewer)),
    ['the after-clear command: counted ' + P + '1}', 'the after-clear form: counted ' + SP + '1}', 'the after-clear word: counted ' + SP + '1}',
      'the in-place command: counted ' + P + '2}'], 'one command fewer');
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
    ['the after-clear word: 1 outside its passage in orchestrate/SKILL.md', 'the after-clear word: counted {"orchestrate/SKILL.md":2,"' + pfile + '":2}'], 'm4: an after-clear boot that skips validation');
  assert.deepEqual(clearNameFaults(swap(pfile, under(protocol, LEGACY, 'Call `schedule_clear` at every wave close, whatever the context size.'))),
    ['the tool, by its short name: 1 outside its passage in ' + pfile, 'the tool, by its short name: counted ' + P + '2}'], 'm5: the tool by its short name');
  assert.deepEqual(clearNameFaults(swap(pfile, under(protocol, LEGACY, 'After posting the line, run `/orchestrate continue <id>` yourself.'))),
    ['the in-place command: 1 outside its passage in ' + pfile, 'the in-place command: counted ' + P + '4}'], 'm6: the in-place command run by the orchestrator');
  assert.deepEqual(clearNameFaults(swap(pfile, under(protocol, LEGACY, 'After a clear, the mod runs `/orchestrate continue after-clear`.'))),
    ['the after-clear word: 1 outside its passage in ' + pfile, 'the after-clear word: counted ' + SP + '3}',
      'the in-place command: 1 outside its passage in ' + pfile, 'the in-place command: counted ' + P + '4}'], 'the reviewer\'s m2: the after-clear command without its id');
  // Live: each key word, however spelled or wrapped, planted just outside the passage, is reported by its family.
  for (const [what, spellings] of [['the tool, by its short name', ['schedule_clear', 'scheduleClear', 'schedule-clear', 'Schedule\n   clear']],
    ['the after-clear word', ['after-clear', 'After clear', 'after_clear', 'afterclear', 'after-\n   clear']],
    ['the in-place command', ['/orchestrate continue', '/Orchestrate  continue <id>', '/orchestrate\n   continue']]]) {
    for (const spelling of spellings) {
      const faults = clearNameFaults(swap(pfile, protocol.replace(pto, () => pto + ' Then use ' + spelling + ' here.')));
      assert.ok(faults.includes(what + ': 1 outside its passage in ' + pfile), what + ': a planted ' + JSON.stringify(spelling) + ' must be reported — ' + faults.join(' | '));
    }
  }
});

// No definition sets `model:`, and only the gate pair and the census set `effort:` (the loader takes
// low | medium | high | max | an integer): the user pinned the reviewer, which also runs the plan
// pre-flight, and the test hunter at max whatever the session's effort (2026-09-27), and the census at
// medium (the user's standing choice since 2026-10-07, confirmed 2026-10-13). Stricter than the loader
// on purpose: the admission is per file — exactly `effort: max` in each gate file and exactly
// `effort: medium` in the census, once, and no line in any other file; any other frontmatter key
// naming either, however quoted, cased, indented or spaced, one file's admitted line in another, and
// a frontmatter block that cannot be found, is a finding.
const TIER_KEY = /(?:effort|model)[\w-]*["']?\s*:/i;
const EFFORT_LINES = new Map([['.claude/agents/reviewer.md', 'effort: max'], ['.claude/agents/test-hunter.md', 'effort: max'],
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
test('no agent definition sets a model, and an effort only as its own file\'s admitted line — effort: max in the gate pair, '
  + 'effort: medium in the census — read more strictly than the loader reads it', t => {
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
    + "Its verdict is recorded like any other (`R<k> <verdict> @<sha>`) and never counts toward the cap. One strike: its `FIX FIRST` discards the polish at once — the orchestrator writes `polish discarded: @[PRE_POLISH_SHA]` into the row's Notes, reverts back to that reviewed tree in ONE commit (never a reset), and integrates it; unclosed ASKs → backlog, each with its wording attached."],
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
