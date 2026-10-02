'use strict';
// orchestrate/tools/detect.mjs and orchestrate/tools/env-facts.mjs, driven in-process: detect on
// fixture repositories, env-facts on injected probes, so no verdict depends on this machine. Each
// CLI runs as published only a few times. Every detect key has a fixture that finds it and one where
// it is unknown or its stated default, and every way an input can fail to read has one that fails
// it: a real fixture where every platform builds one, else an injected git probe or filesystem read.
// The keys are bound to the registry in orchestrate/references/scaffolding.md as checked out.
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { makeRepo } = require('./support/git-fixture.cjs');

const ROOT = path.resolve(__dirname, '..');
const TOOLS = path.join(ROOT, 'orchestrate', 'tools');
const detectApi = import('../orchestrate/tools/detect.mjs');
const envApi = import('../orchestrate/tools/env-facts.mjs');
const gitApi = import('../orchestrate/tools/git-evidence.mjs');
const char = String.fromCharCode;

function fixture(t, files = {}) {
  const repo = makeRepo(t);
  repo.git('config', 'maintenance.auto', 'false');
  repo.git('config', 'gc.auto', '0');
  for (const [file, text] of Object.entries(files)) repo.write(file, text);
  if (Object.keys(files).length) repo.commit('fixture');
  return repo;
}
async function keysOf(repo, options = {}) {
  const { detect } = await detectApi, result = detect({ repo: repo.cwd, env: repo.env, ...options });
  assert.ok(result.root, 'the fixture is a git work tree');
  return result.keys;
}
const has = (keys, name, value, source) => assert.deepEqual(keys[name], { value, source }, name);
const lacks = (keys, name, why) => { assert.deepEqual(Object.keys(keys[name]), ['why'], name + ' has no value'); assert.match(keys[name].why, why, name); };
// The keys with no value, in KEYS order: an input that cannot be read reaches exactly the keys that read it.
const unknownKeys = keys => Object.keys(keys).filter(k => keys[k].why !== undefined);
function run(args, cwd, env) {
  const r = spawnSync(process.execPath, args, { cwd, env, encoding: 'utf8', shell: false, windowsHide: true, timeout: 60000 });
  assert.ifError(r.error); assert.equal(r.signal, null);
  return r;
}
// The top level as git names it, which detect joins every path to: on Windows it can spell the
// fixture's directory differently (a short 8.3 name, a drive letter's case) than repo.cwd does.
const topOf = repo => path.resolve(repo.git('rev-parse', '--show-toplevel'));
// detect's filesystem reads: the real ones, except at the named repository paths ('' is the root),
// where lstat, read or list answers as given. 'EACCES' throws as an unreadable path throws; a
// function returns what it makes of the path and the real read.
function reads(repo, answers) {
  const top = topOf(repo), rel = p => path.relative(top, p).split(path.sep).join('/');
  const real = { lstat: p => fs.lstatSync(p), read: p => fs.readFileSync(p), list: p => fs.readdirSync(p, { withFileTypes: true }) };
  return Object.fromEntries(Object.entries(real).map(([op, read]) => [op, p => {
    const table = answers[op] || {}, key = rel(p);
    if (!Object.hasOwn(table, key)) return read(p);
    if (table[key] === 'EACCES') throw Object.assign(new Error(`EACCES: permission denied, ${op} '${p}'`), { code: 'EACCES' });
    return table[key](p, read);
  }]));
}
// An lstat or directory-entry answer for a link: every platform reports one, not every one makes one.
const LINK = { isFile: () => false, isDirectory: () => false, isSymbolicLink: () => true };
// The same for a regular file, and an lstat answer for a path the listing names but the volume no longer holds.
const FILE = { isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false };
const GONE = () => { throw Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' }); };
// detect's filesystem reads as a case-folding volume (NTFS, APFS) answers them: a path whose last name
// its directory holds only in another case opens that entry, and a listing spells each name as it is
// on disk. On such a volume the real reads answer the same.
function folding() {
  const onDisk = p => {
    try { fs.lstatSync(p); return p; } catch (e) { if (e.code !== 'ENOENT') throw e; }
    const want = path.basename(p).toLowerCase(), hit = fs.readdirSync(path.dirname(p)).find(n => n.toLowerCase() === want);
    return hit === undefined ? p : path.join(path.dirname(p), hit);
  };
  return { lstat: p => fs.lstatSync(onDisk(p)), read: p => fs.readFileSync(onDisk(p)), list: p => fs.readdirSync(p, { withFileTypes: true }) };
}
// The real git probe, except for the commands `fails` picks, which answer as a failed probe does.
async function gitFailing(fails, answer = { ok: false, exit: 128, text: null }) {
  const { git } = await gitApi;
  return (cwd, args, options) => fails(args) ? answer : git(cwd, args, options);
}
const contract = branch => `# Contract\n\n## Git model\n\n- Default branch (protected local ref): \`refs/heads/main\`. Integration branch: \`${branch}\` — merges land here.\n`;
const LATEST = 'latest by the date in its id, of .agents/changes/ and .agents/archive/';

test('every key detect.mjs prints is a registry placeholder, PRIOR_CONTRACT excepted, and the spec\'s keys are all there', async () => {
  const text = fs.readFileSync(path.join(ROOT, 'orchestrate/references/scaffolding.md'), 'utf8').replace(/\r\n/g, '\n');
  const start = text.indexOf('\n## Placeholder registry'), end = text.indexOf('\n## ', start + 1);
  assert.ok(start >= 0 && end > start, 'the registry section exists');
  const registry = new Set([...text.slice(start, end).matchAll(/^\| `\{\{([A-Z0-9_]+)\}\}` \|/gm)].map(m => m[1]));
  // Live control of the reader: the registry's own first rows and a name it does not hold.
  assert.ok(registry.size > 30 && registry.has('CHANGE_ID') && registry.has('CONVERGENCE') && !registry.has('PRIOR_CONTRACT'), [...registry].join(' '));
  const { KEYS } = await detectApi;
  assert.deepEqual(KEYS.filter(k => !registry.has(k)), ['PRIOR_CONTRACT']);
  const spec = ['VALIDATION_COMMANDS', 'MUTATION_RUNNER', 'VERSION_FILES', 'CHANGELOG_RULE', 'MAIN_BRANCH', 'SHIPMENT_SOURCE', 'SHIPMENT_REF',
    'BRANCH_PREFIXES', 'GATE_AGENTS', 'BACKLOG_FILE', 'BACKLOG_ID_PREFIX', 'GUARDRAILS_REF', 'RELEASE_COMMAND', 'WORKTREE_SETUP', 'PRIOR_CONTRACT'];
  assert.deepEqual(KEYS.slice().sort(), spec.slice().sort());
});

test('an empty repository: each key is unknown or its stated default; lines print every key once, json only those with a value', async t => {
  const { detect, renderLines, renderJson, KEYS } = await detectApi, repo = fixture(t);
  const result = detect({ repo: repo.cwd, env: repo.env }), keys = result.keys;
  assert.deepEqual(Object.keys(keys), KEYS, 'the result holds the domain, in order');
  lacks(keys, 'VALIDATION_COMMANDS', /^no package\.json check script/);
  has(keys, 'MUTATION_RUNNER', 'none', 'default: no Stryker, mutmut, cargo-mutants or PIT configuration');
  has(keys, 'VERSION_FILES', 'none', 'default: no version field in package.json, manifest.json, Cargo.toml, pyproject.toml or VERSION');
  has(keys, 'CHANGELOG_RULE', 'none', 'default: no CHANGELOG.md');
  has(keys, 'MAIN_BRANCH', 'refs/heads/main', 'no remote; refs/heads/main exists locally');
  has(keys, 'SHIPMENT_SOURCE', 'local', 'no remote; refs/heads/main exists locally');
  has(keys, 'SHIPMENT_REF', 'refs/heads/main', 'no remote; refs/heads/main exists locally');
  has(keys, 'BRANCH_PREFIXES', 'fix/ feat/ chore/', 'default: no branch prefix used twice under refs/heads/ or refs/remotes/');
  has(keys, 'GATE_AGENTS', 'reviewer only', 'default: no .md file under .claude/agents/');
  has(keys, 'BACKLOG_FILE', '`BACKLOG.md` (create on first residual)', 'default: no root BACKLOG*, TODO*, BUGS* or FEATURE* file');
  has(keys, 'BACKLOG_ID_PREFIX', 'BL-', 'default: no backlog file');
  has(keys, 'GUARDRAILS_REF', 'the project guardrails doc (none yet — create a CLAUDE.md guardrails section at first distill)', 'default: no CLAUDE.md heading names guardrails');
  has(keys, 'RELEASE_COMMAND', 'none', 'default: no build, release or package script or target');
  has(keys, 'WORKTREE_SETUP', 'n/a', 'default: none of package-lock.json, npm-shrinkwrap.json, pnpm-lock.yaml, yarn.lock, Cargo.lock, uv.lock, requirements.txt, go.sum');
  lacks(keys, 'PRIOR_CONTRACT', /^no 00-READBEFORE\.md under \.agents\/changes\/ or \.agents\/archive\/$/);
  const lines = renderLines(result).split('\n');
  assert.equal(lines.pop(), '', 'the output ends with a newline');
  assert.deepEqual(lines.map(l => l.slice(0, l.indexOf(': '))), KEYS, 'one line per key, in order');
  assert.equal(lines[0], 'VALIDATION_COMMANDS: unknown — ' + keys.VALIDATION_COMMANDS.why);
  assert.equal(lines[1], 'MUTATION_RUNNER: none — default: no Stryker, mutmut, cargo-mutants or PIT configuration');
  const json = renderJson(result), valued = KEYS.filter(k => k !== 'VALIDATION_COMMANDS' && k !== 'PRIOR_CONTRACT');
  assert.deepEqual(Object.keys(json), ['values', 'sources']);
  assert.deepEqual(Object.keys(json.values), valued); assert.deepEqual(Object.keys(json.sources), valued);
  assert.equal(json.values.BACKLOG_ID_PREFIX, 'BL-'); assert.equal(json.sources.BACKLOG_ID_PREFIX, 'default: no backlog file');
});

test('package.json scripts, version, release script and lockfile; the package manager follows the lockfiles, and two managers contradict', async t => {
  const repo = fixture(t, {
    'package.json': JSON.stringify({ name: 'app', version: '1.4.2', scripts: { start: 'node .', test: 'node --test', lint: 'eslint .', 'format:check': 'prettier --check .', typecheck: 'tsc', build: 'tsc -b' } }),
    'package-lock.json': '{}\n',
  });
  let keys = await keysOf(repo);
  has(keys, 'VALIDATION_COMMANDS', '`npm run --silent lint`, `npm run --silent format:check`, `npm run --silent typecheck`, `npm run --silent test`', 'package.json scripts');
  has(keys, 'VERSION_FILES', '`package.json` 1.4.2', 'version fields in package.json');
  has(keys, 'RELEASE_COMMAND', '`npm run build`', 'package.json scripts');
  has(keys, 'WORKTREE_SETUP', '`npm ci`', 'package-lock.json');
  // Two npm lockfiles name one manager.
  repo.write('npm-shrinkwrap.json', '{}\n');
  keys = await keysOf(repo);
  has(keys, 'RELEASE_COMMAND', '`npm run build`', 'package.json scripts');
  has(keys, 'WORKTREE_SETUP', '`npm ci`', 'package-lock.json, npm-shrinkwrap.json');
  // A second manager's lockfile contradicts them wherever a script needs the manager, and nowhere else.
  repo.write('pnpm-lock.yaml', 'lockfileVersion: 9\n');
  keys = await keysOf(repo);
  const two = /^lockfiles of more than one package manager: package-lock\.json, npm-shrinkwrap\.json, pnpm-lock\.yaml$/;
  for (const k of ['VALIDATION_COMMANDS', 'RELEASE_COMMAND', 'WORKTREE_SETUP']) lacks(keys, k, two);
  repo.write('package.json', JSON.stringify({ version: '1.4.2' }));
  keys = await keysOf(repo);
  lacks(keys, 'VALIDATION_COMMANDS', /^no package\.json check script/);
  has(keys, 'RELEASE_COMMAND', 'none', 'default: no build, release or package script or target');
  lacks(keys, 'WORKTREE_SETUP', two);
  // One manager's lockfile alone names it.
  repo.write('package.json', JSON.stringify({ scripts: { lint: 'x', build: 'y' } }));
  for (const file of ['package-lock.json', 'npm-shrinkwrap.json']) fs.rmSync(path.join(repo.cwd, file));
  keys = await keysOf(repo);
  has(keys, 'VALIDATION_COMMANDS', '`pnpm run --silent lint`', 'package.json scripts');
  has(keys, 'RELEASE_COMMAND', '`pnpm run build`', 'package.json scripts');
  has(keys, 'WORKTREE_SETUP', '`pnpm install`', 'pnpm-lock.yaml');
  fs.rmSync(path.join(repo.cwd, 'pnpm-lock.yaml')); repo.write('yarn.lock', '# yarn\n');
  keys = await keysOf(repo);
  has(keys, 'VALIDATION_COMMANDS', '`yarn run --silent lint`', 'package.json scripts');
  has(keys, 'RELEASE_COMMAND', '`yarn run build`', 'package.json scripts');
  has(keys, 'WORKTREE_SETUP', '`yarn install`', 'yarn.lock');
});

test('package.json fields npm reads as an object of strings or a string are reported in any other shape, to the keys that read them only', async t => {
  const repo = fixture(t, { 'package.json': JSON.stringify({ version: '1.0.0', scripts: ['test'] }) });
  let keys = await keysOf(repo);
  for (const k of ['VALIDATION_COMMANDS', 'RELEASE_COMMAND']) lacks(keys, k, /^package\.json scripts is not an object$/);
  has(keys, 'VERSION_FILES', '`package.json` 1.0.0', 'version fields in package.json');
  repo.write('package.json', JSON.stringify({ scripts: null }));
  lacks(await keysOf(repo), 'VALIDATION_COMMANDS', /^package\.json scripts is not an object$/);
  repo.write('package.json', JSON.stringify({ scripts: { lint: 'x', test: 1 } }));
  keys = await keysOf(repo);
  for (const k of ['VALIDATION_COMMANDS', 'RELEASE_COMMAND']) lacks(keys, k, /^package\.json scripts\.test is not a string$/);
  repo.write('package.json', JSON.stringify({ scripts: { lint: 'x', package: false } }));
  lacks(await keysOf(repo), 'RELEASE_COMMAND', /^package\.json scripts\.package is not a string$/);
  // A script no key reads may hold anything; a version that is no string is reported.
  repo.write('package.json', JSON.stringify({ version: 2, scripts: { start: 1, test: 'x' } }));
  keys = await keysOf(repo);
  has(keys, 'VALIDATION_COMMANDS', '`npm run --silent test`', 'package.json scripts');
  lacks(keys, 'VERSION_FILES', /^package\.json version is not a string$/);
  has(keys, 'RELEASE_COMMAND', 'none', 'default: no build, release or package script or target');
});

test('nothing runs: scripts and recipes that would write a canary leave it unwritten, and no file, ref or config changes', async t => {
  const CODE = "require('fs').writeFileSync('canary.txt', 'ran')", script = `node -e "${CODE}"`;
  const repo = fixture(t, {
    'package.json': JSON.stringify({ version: '1.0.0', scripts: Object.fromEntries(['preinstall', 'install', 'postinstall', 'prepare', 'lint', 'test', 'build', 'release', 'package', 'version'].map(n => [n, script])) }),
    'Makefile': `test:\n\t${script}\n`, 'justfile': `check:\n    ${script}\n`, 'package-lock.json': '{}\n',
  });
  // Live control: the command the scripts hold does write the canary when something runs it.
  const control = path.join(repo.root, 'control');
  fs.mkdirSync(control);
  run(['-e', CODE], control);
  assert.equal(fs.readFileSync(path.join(control, 'canary.txt'), 'utf8'), 'ran', 'the control wrote its canary');
  const config = () => repo.git('config', '--list', '--local'), before = { snap: repo.snapshot(), refs: repo.git('for-each-ref'), config: config() };
  const { detect, renderLines } = await detectApi, keys = await keysOf(repo);
  assert.equal(keys.VALIDATION_COMMANDS.value, '`npm run --silent lint`, `npm run --silent test`, `just check`, `make -s test`');
  const cli = run([path.join(TOOLS, 'detect.mjs'), '--repo', repo.cwd], repo.cwd, repo.env);
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(cli.stdout, renderLines(detect({ repo: repo.cwd, env: repo.env })), 'the CLI prints the core\'s lines');
  assert.equal(fs.existsSync(path.join(repo.cwd, 'canary.txt')), false, 'no script ran');
  assert.deepEqual({ snap: repo.snapshot(), refs: repo.git('for-each-ref'), config: config() }, before);
});

test('every git command detect runs is a read: no fetch, no remote change, a symbolic-ref only ever given one ref', async t => {
  const { git } = await gitApi, { detect } = await detectApi;
  const repo = fixture(t, { '.agents/changes/AB-20260101-one/00-READBEFORE.md': contract('chore/one-ledger') });
  repo.remote(); repo.git('update-ref', 'refs/remotes/origin/main', repo.base); repo.git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
  const calls = [];
  const { keys } = detect({ repo: repo.cwd, env: repo.env, git: (cwd, args, options) => { calls.push(args); return git(cwd, args, options); } });
  assert.equal(keys.MAIN_BRANCH.value, 'refs/heads/main', 'the probes answered');
  assert.deepEqual(calls, [
    ['rev-parse', '--is-inside-work-tree'], ['rev-parse', '--show-toplevel'],
    ['for-each-ref', '--format=%(refname)%00%(symref)', 'refs/heads/', 'refs/remotes/'], ['remote'],
    ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'], ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    ['symbolic-ref', '--quiet', 'HEAD'],
  ]);
});

test('Cargo.toml: validation commands, the version of [package] or [workspace.package] only, cargo-mutants and the Cargo.lock setup', async t => {
  const repo = fixture(t, {
    'Cargo.toml': '[package]\nname = "crate"\nversion = "0.3.1"  # released\n\n[dependencies.serde]\nversion = "1.0.0"\n',
    'Cargo.lock': '# lock\n', 'mutants.toml': 'timeout = 60\n',
  });
  let keys = await keysOf(repo);
  has(keys, 'VALIDATION_COMMANDS', '`cargo fmt --check`, `cargo clippy`, `cargo test -q`', 'Cargo.toml');
  has(keys, 'VERSION_FILES', '`Cargo.toml` 0.3.1', 'version fields in Cargo.toml');
  has(keys, 'MUTATION_RUNNER', '`cargo mutants --file <changed files>`', 'mutants.toml');
  has(keys, 'WORKTREE_SETUP', '`cargo fetch`', 'Cargo.lock');
  // A version outside those sections is a dependency's and an inherited one sets none; cargo-mutants named in Cargo.toml still counts.
  repo.write('Cargo.toml', '[package]\nname = "crate"\nversion.workspace = true\n\n[dependencies.serde]\nversion = "1.0.0"\n\n# dev: cargo-mutants\n');
  fs.rmSync(path.join(repo.cwd, 'mutants.toml'));
  keys = await keysOf(repo);
  has(keys, 'VERSION_FILES', 'none', 'default: no version field in package.json, manifest.json, Cargo.toml, pyproject.toml or VERSION');
  has(keys, 'MUTATION_RUNNER', '`cargo mutants --file <changed files>`', 'Cargo.toml');
  // A workspace root's version, as a TOML literal string.
  repo.write('Cargo.toml', "[workspace]\nmembers = [\"a\"]\n\n[workspace.package]\nversion = '2.1.0'\n");
  has(await keysOf(repo), 'VERSION_FILES', '`Cargo.toml` 2.1.0', 'version fields in Cargo.toml');
  // A version that is no single-line string is reported, never read as none.
  for (const value of ['3', '"""1.0.0"""', '"1.0\\u0030"']) {
    repo.write('Cargo.toml', `[package]\nversion = ${value}\n`);
    lacks(await keysOf(repo), 'VERSION_FILES', /^Cargo\.toml \[package\] version is not a string$/);
  }
  // A .cargo that is a file holds nothing: no mutants file there.
  repo.write('Cargo.toml', '[package]\nversion = "1.0.0"\n'); repo.write('.cargo', 'not a directory\n');
  has(await keysOf(repo), 'MUTATION_RUNNER', 'none', 'default: no Stryker, mutmut, cargo-mutants or PIT configuration');
});

test('pyproject.toml: ruff and pytest (never -q), the [project] or poetry version, mutmut, and uv or pip setup', async t => {
  const repo = fixture(t, {
    'pyproject.toml': '[project]\nname = "pkg"\nversion = "2.0.0"\n\n[tool.ruff]\nline-length = 100\n\n[tool.pytest.ini_options]\naddopts = "-ra"\n\n[tool.mutmut]\npaths_to_mutate = "src/"\n',
    'uv.lock': '# uv\n', 'requirements.txt': 'requests\n',
  });
  let keys = await keysOf(repo);
  has(keys, 'VALIDATION_COMMANDS', '`ruff check`, `pytest`', 'pyproject.toml');
  has(keys, 'VERSION_FILES', '`pyproject.toml` 2.0.0', 'version fields in pyproject.toml');
  has(keys, 'MUTATION_RUNNER', '`mutmut run --paths-to-mutate <changed files>`', 'pyproject.toml [tool.mutmut]');
  has(keys, 'WORKTREE_SETUP', '`uv sync`, `pip install -r requirements.txt`', 'uv.lock, requirements.txt');
  repo.write('pyproject.toml', '[tool.poetry]\nname = "pkg"\nversion = "0.9.0"\n');
  repo.write('setup.cfg', '[metadata]\nname = pkg\n\n[mutmut]\npaths_to_mutate = src/\n');
  keys = await keysOf(repo);
  lacks(keys, 'VALIDATION_COMMANDS', /pyproject\.toml naming ruff or pytest/);
  has(keys, 'VERSION_FILES', '`pyproject.toml` 0.9.0', 'version fields in pyproject.toml');
  has(keys, 'MUTATION_RUNNER', '`mutmut run --paths-to-mutate <changed files>`', 'setup.cfg [mutmut]');
  repo.write('pyproject.toml', '[project]\nversion = ["2"]\n');
  lacks(await keysOf(repo), 'VERSION_FILES', /^pyproject\.toml \[project\] version is not a string$/);
});

test('go.mod and go.sum; manifest.json and VERSION versions, and a version field that holds no single version reported', async t => {
  const repo = fixture(t, { 'go.mod': 'module example.com/m\n\ngo 1.22\n', 'go.sum': '', 'manifest.json': '{"version": "3.1.0"}', 'VERSION': '3.1.0\n' });
  const keys = await keysOf(repo);
  has(keys, 'VALIDATION_COMMANDS', '`go vet ./...`, `go test ./...`', 'go.mod');
  has(keys, 'WORKTREE_SETUP', '`go mod download`', 'go.sum');
  has(keys, 'VERSION_FILES', '`manifest.json` 3.1.0, `VERSION` 3.1.0', 'version fields in manifest.json, VERSION');
  repo.write('manifest.json', '{"version": 3}');
  lacks(await keysOf(repo), 'VERSION_FILES', /^manifest\.json version is not a string$/);
  fs.rmSync(path.join(repo.cwd, 'manifest.json'));
  for (const [text, why] of [['1.0.0\n2.0.0\n', /^VERSION holds more than one line$/], ['', /^VERSION is empty$/], [' \n\n', /^VERSION is empty$/]]) {
    repo.write('VERSION', text);
    lacks(await keysOf(repo), 'VERSION_FILES', why);
  }
  repo.write('VERSION', '  4.0.0  \n');
  has(await keysOf(repo), 'VERSION_FILES', '`VERSION` 4.0.0', 'version fields in VERSION');
});

test('justfile and Makefile targets: rules only, never an assignment or a special target', async t => {
  const repo = fixture(t, {
    'Makefile': 'CC := gcc\ncheck := yes\n.PHONY: typecheck\ntest lint:\n\techo hi\nrelease: build\n\techo\nbuild:\n\techo\n',
    'justfile': 'set shell := ["bash", "-c"]\nalias t := test\ncheck arg="x":\n    echo hi\n',
  });
  const keys = await keysOf(repo);
  has(keys, 'VALIDATION_COMMANDS', '`just check`, `make -s lint`, `make -s test`', 'justfile targets; Makefile targets');
  has(keys, 'RELEASE_COMMAND', '`make build`, `make release`', 'Makefile targets');
  // GNU make reads GNUmakefile before Makefile: the one it would read is the one reported.
  repo.write('GNUmakefile', 'package:\n\techo\n');
  has(await keysOf(repo), 'RELEASE_COMMAND', '`make package`', 'GNUmakefile targets');
});

test('justfile and Makefile are named as the root listing spells them, so a case-folding volume (NTFS, APFS) reports what a case-sensitive one does', async t => {
  const repo = fixture(t), recipe = 'check:\n    echo\nbuild:\n    echo\n', rule = 'test:\n\techo\nbuild:\n\techo\n';
  const both = ['`just check`, `make -s test`', '`just build`, `make build`'];
  // make reads the first of GNUmakefile, makefile and Makefile under its exact name, just the one justfile
  // or .justfile in any ASCII case; a folding volume opens `makefile` as the `Makefile` it holds.
  const cases = [
    [{ Makefile: rule, justfile: recipe }, both, 'justfile targets; Makefile targets'],
    [{ Justfile: recipe, makefile: rule }, both, 'Justfile targets; makefile targets'],
    [{ JUSTFILE: recipe, GNUmakefile: rule, makefile: rule }, both, 'JUSTFILE targets; GNUmakefile targets'],
    [{ '.justfile': recipe, MAKEFILE: rule }, ['`just check`', '`just build`'], '.justfile targets'],
  ];
  for (const [files, [checks, builds], source] of cases) {
    for (const [file, text] of Object.entries(files)) repo.write(file, text);
    for (const [volume, io] of [['this volume', {}], ['a case-folding volume', folding()]]) {
      const keys = await keysOf(repo, { io });
      assert.deepEqual([keys.VALIDATION_COMMANDS, keys.RELEASE_COMMAND], [{ value: checks, source }, { value: builds, source }], `${Object.keys(files).join(', ')} on ${volume}`);
    }
    for (const file of Object.keys(files)) fs.rmSync(path.join(repo.cwd, file));
  }
  // Near misses name no justfile or Makefile: a longer name, and a letter only Unicode folds to an ASCII one.
  const misses = ['justfile.bak', 'old.justfile', 'ju' + char(0x17f) + 'tfile', 'Makefile.am'];
  for (const file of misses) repo.write(file, recipe);
  let keys = await keysOf(repo);
  lacks(keys, 'VALIDATION_COMMANDS', /^no package\.json check script/);
  has(keys, 'RELEASE_COMMAND', 'none', 'default: no build, release or package script or target');
  for (const file of misses) fs.rmSync(path.join(repo.cwd, file));
  // Two entries just would read are doubt, named in one order whatever order the listing gives, and the
  // doubt is the reason given whichever of them cannot be read.
  repo.write('justfile', recipe); repo.write('.justfile', recipe);
  for (const io of [{}, reads(repo, { list: { '': (p, read) => read(p).reverse() }, read: { '.justfile': 'EACCES' } }),
    reads(repo, { read: { justfile: 'EACCES' } })]) {
    keys = await keysOf(repo, { io });
    for (const k of ['VALIDATION_COMMANDS', 'RELEASE_COMMAND']) lacks(keys, k, /^more than one justfile: \.justfile, justfile$/);
  }
  fs.rmSync(path.join(repo.cwd, 'justfile')); fs.rmSync(path.join(repo.cwd, '.justfile'));
  // A case-sensitive volume can hold makefile beside Makefile, and make reads makefile. No folding volume
  // can hold the pair, so the listing and the reads of makefile are injected.
  repo.write('Makefile', rule);
  const pair = reads(repo, { list: { '': (p, read) => [...read(p), { name: 'makefile', ...FILE }] }, lstat: { makefile: () => FILE }, read: { makefile: () => Buffer.from('lint:\n\techo\n') } });
  has(await keysOf(repo, { io: pair }), 'VALIDATION_COMMANDS', '`make -s lint`', 'makefile targets');
  // A justfile or Makefile that is a directory or a link is reported, never skipped: the listing is read
  // whatever each entry's type. The directory is built for real, the link injected (LINK).
  fs.rmSync(path.join(repo.cwd, 'Makefile')); repo.write('Makefile/keep', 'x'); repo.write('go.mod', 'module m\n');
  keys = await keysOf(repo);
  for (const k of ['VALIDATION_COMMANDS', 'RELEASE_COMMAND']) lacks(keys, k, /^Makefile is not a regular file$/);
  fs.rmSync(path.join(repo.cwd, 'Makefile'), { recursive: true });
  keys = await keysOf(repo, { io: reads(repo, { list: { '': (p, read) => [...read(p), { name: 'justfile', ...LINK }] }, lstat: { justfile: () => LINK } }) });
  for (const k of ['VALIDATION_COMMANDS', 'RELEASE_COMMAND']) lacks(keys, k, /^justfile is not a regular file$/);
});

test('a README section naming a validation recipe with a code block is a source; the phrase alone is not', async t => {
  const repo = fixture(t, { 'README.md': '# Proj\n\n## Contributing\n\nRun the validation recipe below.\n\n## Testing\n\nThe validation recipe:\n\n```sh\nmake all\n```\n\n## License\n\nMIT\n' });
  let keys = await keysOf(repo);
  has(keys, 'VALIDATION_COMMANDS', 'the recipe in `README.md` §Testing', 'README.md §Testing');
  repo.write('go.mod', 'module m\n');
  keys = await keysOf(repo);
  has(keys, 'VALIDATION_COMMANDS', '`go vet ./...`, `go test ./...`', 'go.mod; README.md §Testing');
  fs.rmSync(path.join(repo.cwd, 'go.mod'));
  repo.write('README.md', '# Proj\n\n## Testing\n\nThe validation commands are in CI.\n\n## Build\n\n```sh\nmake\n```\n');
  lacks(await keysOf(repo), 'VALIDATION_COMMANDS', /README validation recipe$/);
});

test('mutation runners: a Stryker config and a PIT plugin in Maven or Gradle; a directory named like a config is none', async t => {
  const repo = fixture(t, { 'stryker.conf.json': '{}', 'pom.xml': '<project><artifactId>pitest-maven</artifactId></project>\n' });
  let keys = await keysOf(repo);
  has(keys, 'MUTATION_RUNNER', '`npx stryker run --mutate <changed files>`, `mvn org.pitest:pitest-maven:mutationCoverage -DtargetClasses=<changed classes>`', 'stryker.conf.json; pom.xml (PIT plugin)');
  fs.rmSync(path.join(repo.cwd, 'stryker.conf.json')); fs.rmSync(path.join(repo.cwd, 'pom.xml'));
  repo.write('build.gradle.kts', 'plugins { id("info.solidsoft.pitest") }\n');
  keys = await keysOf(repo);
  has(keys, 'MUTATION_RUNNER', '`gradle pitest`', 'build.gradle.kts (PIT plugin)');
  repo.write('build.gradle.kts', 'plugins { java }\n'); repo.write('stryker.conf.d/base.json', '{}');
  has(await keysOf(repo), 'MUTATION_RUNNER', 'none', 'default: no Stryker, mutmut, cargo-mutants or PIT configuration');
});

test('CHANGELOG ordering from the first and last version headings, compared as numbers, fenced headings skipped', async t => {
  const { changelogOrder } = await detectApi;
  assert.deepEqual(changelogOrder('# Changelog\n\n## [Unreleased]\n\n## [1.10.0] - 2026-02-01\n\n## [1.9.0] - 2026-01-01\n'),
    { value: '`CHANGELOG.md`, newest first: prepend at the top, headings like `## [1.10.0] - 2026-02-01`', source: 'CHANGELOG.md headings: first 1.10.0, last 1.9.0' });
  assert.deepEqual(changelogOrder('# Changelog\n\n```md\n## 9.0.0\n```\n\n## v0.9.0\n\n## v0.10.0\n'),
    { value: '`CHANGELOG.md`, oldest first: append at the bottom, headings like `## v0.9.0`', source: 'CHANGELOG.md headings: first 0.9.0, last 0.10.0' });
  // A backtick run inside a tilde fence closes nothing.
  assert.deepEqual(changelogOrder('# Changelog\n\n~~~\n```\n## 9.0.0\n```\n~~~\n\n## 1.0.0\n\n## 2.0.0\n'),
    { value: '`CHANGELOG.md`, oldest first: append at the bottom, headings like `## 1.0.0`', source: 'CHANGELOG.md headings: first 1.0.0, last 2.0.0' });
  assert.deepEqual(changelogOrder('# Changelog\n\n## 1.0.0\n'), { why: 'CHANGELOG.md holds fewer than two version headings' });
  assert.deepEqual(changelogOrder('## 1.0\n\n## 1.0.0\n'), { why: "CHANGELOG.md's first and last version headings both read 1.0" });
  const repo = fixture(t, { 'CHANGELOG.md': '# Changelog\r\n\r\n## 2.0.0\r\n\r\n## 1.0.0\r\n' });
  has(await keysOf(repo), 'CHANGELOG_RULE', '`CHANGELOG.md`, newest first: prepend at the top, headings like `## 2.0.0`', 'CHANGELOG.md headings: first 2.0.0, last 1.0.0');
  repo.write('CHANGELOG.md', '# Changelog\n\n## 1.0.0\n');
  lacks(await keysOf(repo), 'CHANGELOG_RULE', /^CHANGELOG\.md holds fewer than two version headings$/);
});

test('default branch and shipment: a live origin/HEAD, a stale one, one outside origin, one with no origin remote, and local main or master', async t => {
  const repo = fixture(t);
  repo.git('branch', 'master');
  let keys = await keysOf(repo);
  for (const k of ['MAIN_BRANCH', 'SHIPMENT_SOURCE', 'SHIPMENT_REF']) lacks(keys, k, /^no remote, and both refs\/heads\/main and refs\/heads\/master exist$/);
  repo.git('branch', '-D', 'master'); repo.git('branch', '-m', 'main', 'trunk');
  lacks(await keysOf(repo), 'MAIN_BRANCH', /^no remote, and neither/);
  repo.git('branch', '-m', 'trunk', 'master');
  has(await keysOf(repo), 'MAIN_BRANCH', 'refs/heads/master', 'no remote; refs/heads/master exists locally');
  // A hint left behind with no origin remote names no shipment source.
  repo.git('update-ref', 'refs/remotes/origin/master', repo.base); repo.git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/master');
  keys = await keysOf(repo);
  for (const k of ['MAIN_BRANCH', 'SHIPMENT_SOURCE', 'SHIPMENT_REF']) lacks(keys, k, /^refs\/remotes\/origin\/HEAD is set, but origin is not a remote$/);
  repo.git('symbolic-ref', '--delete', 'refs/remotes/origin/HEAD'); repo.git('update-ref', '-d', 'refs/remotes/origin/master');
  repo.remote();
  repo.git('update-ref', 'refs/remotes/origin/main', repo.base);
  lacks(await keysOf(repo), 'SHIPMENT_REF', /^remote origin but no refs\/remotes\/origin\/HEAD$/);
  repo.git('update-ref', '--no-deref', 'refs/remotes/origin/HEAD', repo.base);
  lacks(await keysOf(repo), 'MAIN_BRANCH', /^refs\/remotes\/origin\/HEAD is not a symbolic ref$/);
  repo.git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/gone');
  lacks(await keysOf(repo), 'MAIN_BRANCH', /^refs\/remotes\/origin\/HEAD names refs\/remotes\/origin\/gone, which is not an existing branch$/);
  repo.git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/heads/master');
  lacks(await keysOf(repo), 'SHIPMENT_REF', /^refs\/remotes\/origin\/HEAD names refs\/heads\/master, outside refs\/remotes\/origin\/$/);
  repo.git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
  keys = await keysOf(repo);
  const source = 'refs/remotes/origin/HEAD → refs/remotes/origin/main';
  has(keys, 'MAIN_BRANCH', 'refs/heads/main', source); has(keys, 'SHIPMENT_SOURCE', 'remote origin', source); has(keys, 'SHIPMENT_REF', 'refs/heads/main', source);
});

test('a git probe that fails makes exactly the keys that read it unknown', async t => {
  const { detect } = await detectApi;
  const repo = fixture(t, { 'go.mod': 'module m\n', '.agents/changes/AB-20260101-one/00-READBEFORE.md': contract('chore/one-ledger') });
  repo.remote(); repo.git('update-ref', 'refs/remotes/origin/main', repo.base); repo.git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
  assert.deepEqual(unknownKeys(await keysOf(repo)), [], 'the control: every key has a value');
  const shipping = ['MAIN_BRANCH', 'SHIPMENT_SOURCE', 'SHIPMENT_REF'], origin = args => args.join(' ') === 'symbolic-ref --quiet refs/remotes/origin/HEAD';
  const cases = [
    [args => args[0] === 'for-each-ref', undefined, [...shipping, 'BRANCH_PREFIXES'], /^git could not list refs or remotes$/],
    [args => args[0] === 'remote', undefined, [...shipping, 'BRANCH_PREFIXES'], /^git could not list refs or remotes$/],
    [origin, undefined, shipping, /^git could not read refs\/remotes\/origin\/HEAD$/],
    [origin, { ok: true, exit: 0, text: '\n' }, shipping, /^git could not read refs\/remotes\/origin\/HEAD$/],
    // git follows a chain of symbolic refs to its end, so a target that is itself one is refused should any git not.
    [origin, { ok: true, exit: 0, text: 'refs/remotes/origin/HEAD\n' }, shipping, /^refs\/remotes\/origin\/HEAD names refs\/remotes\/origin\/HEAD, which is not an existing branch$/],
    [args => args[0] === 'ls-files', undefined, ['VALIDATION_COMMANDS'], /^git ls-files failed$/],
    [args => args.join(' ') === 'symbolic-ref --quiet HEAD', undefined, ['PRIOR_CONTRACT'], /^git could not read HEAD$/],
  ];
  for (const [fails, answer, expected, why] of cases) {
    const keys = await keysOf(repo, { git: await gitFailing(fails, answer) });
    assert.deepEqual(unknownKeys(keys), expected, String(fails) + ' ' + JSON.stringify(answer));
    for (const k of expected) lacks(keys, k, why);
  }
  // Exit 1 is git's answer for a detached HEAD: no branch to compare, so the latest contract.
  const detached = await keysOf(repo, { git: await gitFailing(args => args.join(' ') === 'symbolic-ref --quiet HEAD', { ok: false, exit: 1, text: '' }) });
  has(detached, 'PRIOR_CONTRACT', '.agents/changes/AB-20260101-one/00-READBEFORE.md', LATEST);
  // A top level git cannot name is no work tree.
  assert.equal(detect({ repo: repo.cwd, env: repo.env, git: await gitFailing(args => args[1] === '--show-toplevel', { ok: true, exit: 0, text: '\n' }) }).root, null);
});

test('branch prefixes: used at least twice across local and remote-tracking names, each name once, most used first', async t => {
  const repo = fixture(t);
  repo.remote();
  for (const b of ['feat/a', 'feat/b', 'fix/a', 'fix/b', 'chore/x', 'solo']) repo.git('branch', b);
  for (const r of ['fix/c', 'chore/x', 'feat/a']) repo.git('update-ref', `refs/remotes/origin/${r}`, repo.base);
  has(await keysOf(repo), 'BRANCH_PREFIXES', 'fix/ feat/', 'branch names under refs/heads/ and refs/remotes/');
});

test('gate agents: name, tools and review shape from a strict frontmatter, nested definitions too; a definition the real reader would not load is unparsed', async t => {
  const def = (name, description, tools, eol = '\n') => ['---', ...(name ? [`name: ${name}`] : []), `description: ${description}`, `tools: ${tools}`, '---', 'Body.', ''].join(eol);
  const repo = fixture(t, {
    '.claude/agents/reviewer.md': def('reviewer', 'Reviews one batch diff and reports findings.', 'Read, Grep, Glob'),
    '.claude/agents/builder.md': def('builder', 'Builds the checkpoint page.', 'Read, Write'),
    '.claude/agents/crlf.md': def('crlf', 'Audits tests.', 'Read, Grep', '\r\n'),
    '.claude/agents/broken.md': '---\nname: broken\ndescription: Reviews.\ntools: Read\n',
    '.claude/agents/quoted.md': def('quoted', '"Reviews diffs."', 'Read'),
    '.claude/agents/nameless.md': def(null, 'Reviews diffs.', 'Read'),
    '.claude/agents/renamed.md': def('code-auditor', 'An auditor of diffs.', 'Read'),
    // A build that recurses loads these, two levels down included; a directory named like a definition is walked.
    '.claude/agents/team/hunter.md': def('hunter', 'Hunts vacuous tests.', 'Read, Grep'),
    '.claude/agents/team/deeper/checker.md': def('checker', 'Checks fences.', 'Read'),
    '.claude/agents/folder.md/keep': 'x', '.claude/agents/notes.txt': 'ignored',
  });
  has(await keysOf(repo), 'GATE_AGENTS',
    'broken (unparsed); builder (tools: Read, Write; not review-shaped); crlf (tools: Read, Grep; review-shaped); nameless (unparsed); quoted (unparsed); '
    + 'renamed (name: code-auditor; tools: Read; review-shaped); reviewer (tools: Read, Grep, Glob; review-shaped); '
    + 'team/deeper/checker (nested; name: checker; tools: Read; review-shaped); team/hunter (nested; name: hunter; tools: Read, Grep; review-shaped)',
    '.claude/agents/**/*.md frontmatter');
});

test('gate agents: a .claude/agents that cannot be read or listed at any depth, holds a link, or is no directory, is unknown, and every other key still prints', async t => {
  const repo = fixture(t, { '.claude/agents/reviewer.md': '---\nname: reviewer\ndescription: Reviews.\ntools: Read\n---\n', '.claude/agents/team/keep.txt': 'x' });
  has(await keysOf(repo), 'GATE_AGENTS', 'reviewer (tools: Read; review-shaped)', '.claude/agents/**/*.md frontmatter');
  const linked = name => (p, read) => [...read(p), { name, ...LINK }];
  for (const [answers, why] of [[{ list: { '.claude/agents': 'EACCES' } }, /^\.claude\/agents cannot be listed$/], [{ list: { '.claude/agents/team': 'EACCES' } }, /^\.claude\/agents\/team cannot be listed$/],
    [{ lstat: { '.claude/agents': 'EACCES' } }, /^\.claude\/agents cannot be read$/], [{ lstat: { '.claude/agents': () => LINK } }, /^\.claude\/agents is not a directory$/],
    [{ list: { '.claude/agents/team': linked('shared') } }, /^\.claude\/agents\/team\/shared is a link, not followed$/]]) {
    const keys = await keysOf(repo, { io: reads(repo, answers) });
    lacks(keys, 'GATE_AGENTS', why);
    assert.deepEqual(unknownKeys(keys), ['VALIDATION_COMMANDS', 'GATE_AGENTS', 'PRIOR_CONTRACT'], 'every other key still has its value');
  }
  // A definition that cannot be read, or is a link, is unparsed, never guessed.
  has(await keysOf(repo, { io: reads(repo, { read: { '.claude/agents/reviewer.md': 'EACCES' } }) }), 'GATE_AGENTS', 'reviewer (unparsed)', '.claude/agents/**/*.md frontmatter');
  has(await keysOf(repo, { io: reads(repo, { list: { '.claude/agents/team': linked('linked.md') }, lstat: { '.claude/agents/team/linked.md': () => LINK } }) }), 'GATE_AGENTS',
    'reviewer (tools: Read; review-shaped); team/linked (nested; unparsed)', '.claude/agents/**/*.md frontmatter');
  // Built for real: .claude/agents a file, then .claude itself a file, which holds nothing: the default.
  fs.rmSync(path.join(repo.cwd, '.claude/agents'), { recursive: true }); repo.write('.claude/agents', 'x');
  lacks(await keysOf(repo), 'GATE_AGENTS', /^\.claude\/agents is not a directory$/);
  fs.rmSync(path.join(repo.cwd, '.claude'), { recursive: true }); repo.write('.claude', 'x');
  has(await keysOf(repo), 'GATE_AGENTS', 'reviewer only', 'default: no .md file under .claude/agents/');
});

test('frontmatter accepts a name, tools and description only as plain scalars every YAML reader reads as the strings they spell', async () => {
  const { frontmatter } = await detectApi, base = ['---', 'name: r', 'description: Reviews a diff.', 'tools: Read, mcp__Claude_Browser__*', '---', ''];
  const expected = { name: 'r', tools: 'Read, mcp__Claude_Browser__*', description: 'Reviews a diff.' };
  assert.deepEqual(frontmatter(base.join('\n')), expected);
  assert.deepEqual(frontmatter(base.join('\r\n')), expected, 'the same under CRLF');
  assert.deepEqual(frontmatter(['---', '', 'name: r', 'description: Reviews a diff.  ', 'tools: Read, mcp__Claude_Browser__*', '---'].join('\n')), expected, 'a blank line and trailing spaces');
  const edit = (i, line) => base.map((l, n) => n === i ? line : l).join('\n');
  const add = line => [...base.slice(0, 4), line, ...base.slice(4)].join('\n');
  assert.deepEqual(frontmatter(add('_private: x')), expected, 'a key that is no YAML word');
  const rejected = {
    'no leading fence': base.slice(1).join('\n'), 'no closing fence': base.slice(0, 4).join('\n'),
    'a key twice': add('tools: Read'), 'no name': edit(1, 'model: x'), 'no tools': edit(3, 'model: x'), 'no description': edit(2, 'model: x'),
    'a block list': edit(3, 'tools:\n  - Read'), 'an indented line': edit(1, '  name: r'), 'a comment line': add('# a note'),
    'a tab in a value': edit(2, 'description: Reviews\ta diff.'), 'a colon and space in a value': edit(2, 'description: Reviews: a diff.'),
    'a value ending in a colon': edit(2, 'description: Reviews:'), 'a comment in a value': edit(2, 'description: Reviews #a diff'),
  };
  // A key YAML 1.1 reads as a boolean or a null collides with its other spellings.
  for (const key of ['yes', 'Null', 'n', 'ON']) rejected['a key ' + key] = add(key + ': x');
  // A value that does not open with an ASCII letter: every indicator, a number, a date, a special float, a non-ASCII letter.
  const openers = [...'-?:,[]{}#&*!|>\'"%@`~=<\\/(_0+.'].map(c => c + 'Read').concat(['~', '1', '0x1F', '+1', '.5', '.inf', '2026-01-01', char(0xdc) + 'berpr' + char(0xfc) + 'ft']);
  for (const v of openers) rejected['tools: ' + v] = edit(3, 'tools: ' + v);
  rejected['description: 2026-01-01'] = edit(2, 'description: 2026-01-01');
  // The words YAML 1.1 or 1.2 reads as a null or a boolean.
  for (const v of ['null', 'Null', 'NULL', 'true', 'True', 'TRUE', 'false', 'False', 'FALSE', 'yes', 'Yes', 'YES', 'no', 'No', 'NO', 'on', 'On', 'ON', 'off', 'Off', 'OFF', 'y', 'Y', 'n', 'N']) {
    rejected['tools: ' + v] = edit(3, 'tools: ' + v);
  }
  // A character YAML refuses or reads as a line break, inside a value: each lies just past a character accepted below.
  const refused = [...Array(32).keys()].filter(c => c !== 9).concat([0x7f, 0x80, 0x85, 0x9b, 0x9f, 0x2028, 0x2029, 0xd800, 0xdfff, 0xfeff, 0xfffe, 0xffff]);
  for (const code of refused) rejected['U+' + code.toString(16)] = edit(2, 'description: Reviews' + char(code) + 'diffs.');
  for (const [name, text] of Object.entries(rejected)) assert.equal(frontmatter(text), null, name);
  // The other side of every boundary: words that only begin like a YAML word, indicators past the first
  // character, and the printable characters beside each refused range.
  for (const v of ['nullable', 'Yesterday', 'Nope', 'Read, true', 'Yz', 'Off-by-one', 'a:b', 'a#b', 'Read [x] {y}, z', 'x - y ? z & w * v ! u | t > s % r @ q', 'It\'s "quoted" inside', 'a~b']) {
    assert.deepEqual(frontmatter(edit(3, 'tools: ' + v)), { ...expected, tools: v }, v);
  }
  for (const code of [0x20, 0x7e, 0xa0, 0xe9, 0x2014, 0x2027, 0x202a, 0xd7ff, 0xe000, 0xfefe, 0xff00, 0xfffd, 0x10000, 0x10ffff]) {
    const description = 'Reviews' + String.fromCodePoint(code) + 'diffs.';
    assert.deepEqual(frontmatter(edit(2, 'description: ' + description)), { ...expected, description }, 'U+' + code.toString(16));
  }
});

test('backlog: the root backlog files by name, any case, and the id prefix most used across them', async t => {
  const { idPrefix } = await detectApi;
  assert.deepEqual(idPrefix([{ name: 'A', text: 'SCAN-1 SCAN-2 SCAN-3 BL-1 scan-9 #3.5' }, { name: 'B', text: 'BL-2 BL-3 BL-4' }]), { prefix: 'BL-', file: 'B' });
  assert.deepEqual(idPrefix([{ name: 'A', text: 'SCAN-1 BL-1' }]), { prefix: 'BL-', file: 'A' }, 'a tie goes to the alphabetically first');
  assert.equal(idPrefix([{ name: 'A', text: 'no ids, BL- alone, bl-1' }]), null);
  const repo = fixture(t, { 'BACKLOG.md': '| SCAN-1 | SCAN-2 | SCAN-3 | BL-1 |\n', 'todo.md': 'BL-2, BL-3, BL-4\n', 'notes.md': 'ZZ-1 ZZ-2 ZZ-3 ZZ-4 ZZ-5\n' });
  let keys = await keysOf(repo);
  has(keys, 'BACKLOG_FILE', '`BACKLOG.md`', 'root file BACKLOG.md (also todo.md)');
  has(keys, 'BACKLOG_ID_PREFIX', 'BL-', 'todo.md');
  repo.write('BACKLOG.md', 'nothing yet\n'); fs.rmSync(path.join(repo.cwd, 'todo.md'));
  has(await keysOf(repo), 'BACKLOG_ID_PREFIX', 'BL-', 'default: no id in BACKLOG.md');
  repo.write('BACKLOG.md', 'SCAN-6\n');
  has(await keysOf(repo), 'BACKLOG_ID_PREFIX', 'SCAN-', 'BACKLOG.md');
  // A directory is not a backlog file, beside one or alone.
  repo.write('todo/keep', 'x'); repo.write('features/steps.feature', 'x');
  keys = await keysOf(repo);
  has(keys, 'BACKLOG_FILE', '`BACKLOG.md`', 'root file BACKLOG.md');
  has(keys, 'BACKLOG_ID_PREFIX', 'SCAN-', 'BACKLOG.md');
  fs.rmSync(path.join(repo.cwd, 'BACKLOG.md'));
  keys = await keysOf(repo);
  has(keys, 'BACKLOG_FILE', '`BACKLOG.md` (create on first residual)', 'default: no root BACKLOG*, TODO*, BUGS* or FEATURE* file');
  has(keys, 'BACKLOG_ID_PREFIX', 'BL-', 'default: no backlog file');
  // A link named like one is reported, not followed.
  keys = await keysOf(repo, { io: reads(repo, { list: { '': (p, read) => [...read(p), { name: 'todo.md', ...LINK }] } }) });
  for (const k of ['BACKLOG_FILE', 'BACKLOG_ID_PREFIX']) lacks(keys, k, /^todo\.md is not a regular file$/);
});

test('guardrails: the first CLAUDE.md heading naming guardrails outside fenced code, fences and headings read as CommonMark reads them', async t => {
  const repo = fixture(t, { 'CLAUDE.md': '# Project\n\n```md\n## Fake guardrails\n```\n\n## Conventions\n\n## Bug-Class Guardrails\n\n- one\n' });
  has(await keysOf(repo), 'GUARDRAILS_REF', '`CLAUDE.md` §Bug-Class Guardrails', 'CLAUDE.md heading');
  // A fence closes only on its own character, at least as long, with nothing after it; up to three spaces indent a heading.
  repo.write('CLAUDE.md', ['# Project', '', '~~~md', '```', '## Fake guardrails', '```', '## Still fenced guardrails', '~~~', '',
    '````', '## Longer fence guardrails', '```', '## Inside guardrails', '```` x', '## Info string guardrails', '````', '', '   ## Indented Guardrails ##', ''].join('\n'));
  has(await keysOf(repo), 'GUARDRAILS_REF', '`CLAUDE.md` §Indented Guardrails', 'CLAUDE.md heading');
  // A backtick run whose info string holds a backtick opens no fence; a closing `#` run needs a space before it.
  repo.write('CLAUDE.md', '# P\n\n``` `a` ```\n\n## Guardrails for C#\n');
  has(await keysOf(repo), 'GUARDRAILS_REF', '`CLAUDE.md` §Guardrails for C#', 'CLAUDE.md heading');
  repo.write('CLAUDE.md', '# Project\n\nGuardrails live in prose here.\n\n#Guardrails without a space\n    ## Indented four: code\n');
  has(await keysOf(repo), 'GUARDRAILS_REF', 'the project guardrails doc (none yet — create a CLAUDE.md guardrails section at first distill)', 'default: no CLAUDE.md heading names guardrails');
});

test('prior contract: the latest by the date in its id, or the latest whose integration branch is checked out; an unreadable Git model is doubt only where it could win', async t => {
  const repo = fixture(t, {
    '.agents/changes/AB-20260101-one/00-READBEFORE.md': contract('chore/one-ledger'),
    '.agents/archive/AB-20260301-two/00-READBEFORE.md': contract('chore/two-ledger'),
    '.agents/archive/AB-20250101-three/00-READBEFORE.md': contract('chore/three-ledger'),
    '.agents/changes/zz-nodate/00-READBEFORE.md': contract('chore/nodate-ledger'),
    '.agents/changes/AB-20260401-four/PROGRESS.md': '# no contract here\n',
    '.agents/changes/README.md': '# a note beside the ledgers\n',
  });
  has(await keysOf(repo), 'PRIOR_CONTRACT', '.agents/archive/AB-20260301-two/00-READBEFORE.md', LATEST);
  repo.git('checkout', '-q', '-b', 'chore/one-ledger');
  has(await keysOf(repo), 'PRIOR_CONTRACT', '.agents/changes/AB-20260101-one/00-READBEFORE.md', 'its integration branch chore/one-ledger is checked out');
  // A contract may spell its integration branch as the full ref.
  repo.write('.agents/archive/AB-20250601-full/00-READBEFORE.md', contract('refs/heads/chore/full-ledger'));
  repo.git('checkout', '-q', '-b', 'chore/full-ledger');
  has(await keysOf(repo), 'PRIOR_CONTRACT', '.agents/archive/AB-20250601-full/00-READBEFORE.md', 'its integration branch chore/full-ledger is checked out');
  repo.git('checkout', '-q', 'chore/one-ledger');
  // An older contract's Git model cannot outrank the own one; a later one's could.
  const twice = branch => contract(branch) + '\n## Git model\n\nIntegration branch: `chore/other-ledger`.\n';
  repo.write('.agents/archive/AB-20250101-three/00-READBEFORE.md', twice('chore/three-ledger'));
  has(await keysOf(repo), 'PRIOR_CONTRACT', '.agents/changes/AB-20260101-one/00-READBEFORE.md', 'its integration branch chore/one-ledger is checked out');
  repo.git('checkout', '-q', '-b', 'feat/elsewhere');
  lacks(await keysOf(repo), 'PRIOR_CONTRACT', /^\.agents\/archive\/AB-20250101-three\/00-READBEFORE\.md holds no Git model to compare with the checked-out branch feat\/elsewhere$/);
  repo.git('checkout', '-q', 'chore/one-ledger');
  repo.write('.agents/archive/AB-20250101-three/00-READBEFORE.md', contract('chore/three-ledger')); repo.write('.agents/archive/AB-20260301-two/00-READBEFORE.md', twice('chore/two-ledger'));
  lacks(await keysOf(repo), 'PRIOR_CONTRACT', /^\.agents\/archive\/AB-20260301-two\/00-READBEFORE\.md holds no Git model to compare with the checked-out branch chore\/one-ledger$/);
  // A detached HEAD has no branch to compare: the latest, whatever its Git model.
  repo.git('checkout', '-q', '--detach');
  has(await keysOf(repo), 'PRIOR_CONTRACT', '.agents/archive/AB-20260301-two/00-READBEFORE.md', LATEST);
});

test('prior contract: a ledger area, entry or contract that cannot be read makes it unknown, never an older contract', async t => {
  const live = '.agents/changes/AB-20260101-live/00-READBEFORE.md';
  const repo = fixture(t, { [live]: contract('chore/live-ledger'), '.agents/archive/AB-20250101-old/00-READBEFORE.md': contract('chore/old-ledger') });
  has(await keysOf(repo), 'PRIOR_CONTRACT', live, LATEST);
  const cases = [
    [{ list: { '.agents/changes': 'EACCES' } }, /^\.agents\/changes cannot be listed$/],
    [{ lstat: { '.agents/changes': 'EACCES' } }, /^\.agents\/changes cannot be read$/],
    [{ lstat: { '.agents/changes': () => LINK } }, /^\.agents\/changes is not a directory$/],
    [{ list: { '.agents/changes': (p, read) => [...read(p), { name: 'AB-20270101-linked', ...LINK }] } }, /^\.agents\/changes\/AB-20270101-linked is a link, not followed$/],
    [{ lstat: { [live]: 'EACCES' } }, /^\.agents\/changes\/AB-20260101-live\/00-READBEFORE\.md cannot be read$/],
    [{ read: { [live]: 'EACCES' } }, /^\.agents\/changes\/AB-20260101-live\/00-READBEFORE\.md cannot be read$/],
  ];
  for (const [answers, why] of cases) {
    const keys = await keysOf(repo, { io: reads(repo, answers) });
    lacks(keys, 'PRIOR_CONTRACT', why);
    assert.deepEqual(unknownKeys(keys), ['VALIDATION_COMMANDS', 'PRIOR_CONTRACT'], 'only the key that reads the ledgers: ' + JSON.stringify(answers));
  }
  // Built for real: a contract that is not UTF-8, a directory in its place, an area that is a file.
  fs.writeFileSync(path.join(repo.cwd, live), Buffer.from([0x23, 0x20, 0xff, 0x0a]));
  lacks(await keysOf(repo), 'PRIOR_CONTRACT', /^\.agents\/changes\/AB-20260101-live\/00-READBEFORE\.md is not UTF-8 text$/);
  fs.rmSync(path.join(repo.cwd, live)); fs.mkdirSync(path.join(repo.cwd, live));
  lacks(await keysOf(repo), 'PRIOR_CONTRACT', /^\.agents\/changes\/AB-20260101-live\/00-READBEFORE\.md is not a regular file$/);
  fs.rmSync(path.join(repo.cwd, '.agents/changes'), { recursive: true }); fs.writeFileSync(path.join(repo.cwd, '.agents/changes'), 'x');
  lacks(await keysOf(repo), 'PRIOR_CONTRACT', /^\.agents\/changes is not a directory$/);
  // With .agents itself a file there is no ledger area at all.
  fs.rmSync(path.join(repo.cwd, '.agents'), { recursive: true }); fs.writeFileSync(path.join(repo.cwd, '.agents'), 'x');
  lacks(await keysOf(repo), 'PRIOR_CONTRACT', /^no 00-READBEFORE\.md under \.agents\/changes\/ or \.agents\/archive\/$/);
});

test('monorepo shape rides on the validation source: two or more package.json files outside node_modules, or a workspaces declaration', async t => {
  const repo = fixture(t, {
    'package.json': JSON.stringify({ workspaces: ['packages/*'], scripts: { test: 'x' } }),
    'packages/a/package.json': '{}', 'packages/b/package.json': '{}', 'node_modules/dep/package.json': '{}',
  });
  const npmTest = '`npm run --silent test`', declared = 'package.json scripts; monorepo: a workspaces declaration — the package in scope is to confirm';
  has(await keysOf(repo), 'VALIDATION_COMMANDS', npmTest, 'package.json scripts; monorepo: packages packages/a, packages/b — the package in scope is to confirm');
  // Run from inside one package, detect still reads the repository from its top level.
  const { detect } = await detectApi, inner = detect({ repo: path.join(repo.cwd, 'packages', 'a'), env: repo.env });
  assert.equal(inner.root, topOf(repo));
  assert.notEqual(path.basename(inner.root), 'a', 'the top level, not the package directory');
  has(inner.keys, 'VALIDATION_COMMANDS', npmTest, 'package.json scripts; monorepo: packages packages/a, packages/b — the package in scope is to confirm');
  // A package.json the index holds but the working tree no longer does is not a package.
  fs.rmSync(path.join(repo.cwd, 'packages'), { recursive: true }); repo.write('package.json', JSON.stringify({ scripts: { test: 'x' } })); repo.write('pnpm-workspace.yaml', 'packages: []\n');
  has(await keysOf(repo), 'VALIDATION_COMMANDS', npmTest, declared);
  // A workspaces field alone, with no nested package.json and no pnpm-workspace.yaml.
  fs.rmSync(path.join(repo.cwd, 'pnpm-workspace.yaml')); repo.write('package.json', JSON.stringify({ workspaces: ['packages/*'], scripts: { test: 'x' } }));
  has(await keysOf(repo), 'VALIDATION_COMMANDS', npmTest, declared);
  repo.write('package.json', JSON.stringify({ scripts: { test: 'x' } }));
  has(await keysOf(repo), 'VALIDATION_COMMANDS', npmTest, 'package.json scripts');
  // Two package.json files are several; one nested file with no root one is a single package.
  repo.write('web/package.json', '{}');
  has(await keysOf(repo), 'VALIDATION_COMMANDS', npmTest, 'package.json scripts; monorepo: packages web — the package in scope is to confirm');
  fs.rmSync(path.join(repo.cwd, 'package.json')); repo.write('go.mod', 'module m\n');
  has(await keysOf(repo), 'VALIDATION_COMMANDS', '`go vet ./...`, `go test ./...`', 'go.mod');
});

test('an unreadable input makes the keys that read it unknown, never a guess', async t => {
  const repo = fixture(t, { 'package.json': '{ "version": "1.0.0", ', 'CHANGELOG.md/keep': 'x', 'CLAUDE.md/keep': 'x', 'go.sum': '' });
  fs.writeFileSync(path.join(repo.cwd, 'BACKLOG.md'), Buffer.from([0x42, 0x4c, 0x2d, 0x31, 0xff]));
  const keys = await keysOf(repo);
  for (const k of ['VALIDATION_COMMANDS', 'VERSION_FILES', 'RELEASE_COMMAND']) lacks(keys, k, /^package\.json is not a JSON object$/);
  lacks(keys, 'CHANGELOG_RULE', /^CHANGELOG\.md is not a regular file$/);
  lacks(keys, 'GUARDRAILS_REF', /^CLAUDE\.md is not a regular file$/);
  has(keys, 'BACKLOG_FILE', '`BACKLOG.md`', 'root file BACKLOG.md');
  lacks(keys, 'BACKLOG_ID_PREFIX', /^BACKLOG\.md is not UTF-8 text$/);
  has(keys, 'WORKTREE_SETUP', '`go mod download`', 'go.sum');
  has(keys, 'MUTATION_RUNNER', 'none', 'default: no Stryker, mutmut, cargo-mutants or PIT configuration');
  // JSON that parses to no object is no manifest either.
  for (const text of ['[]', 'null', '"text"', '3']) {
    repo.write('package.json', text);
    lacks(await keysOf(repo), 'VERSION_FILES', /^package\.json is not a JSON object$/);
  }
  // A file that cannot be read is reported as that, not as text it is not.
  lacks(await keysOf(repo, { io: reads(repo, { read: { 'BACKLOG.md': 'EACCES' } }) }), 'BACKLOG_ID_PREFIX', /^BACKLOG\.md cannot be read$/);
});

test('an unreadable path makes exactly the keys that read it unknown: lockfiles, make and just files, packages, mutants files, the root listing', async t => {
  const repo = fixture(t, {
    'package.json': JSON.stringify({ scripts: { test: 'x', build: 'y' } }), 'yarn.lock': '# yarn\n', 'justfile': 'check:\n    echo\n', 'GNUmakefile': 'all:\n\techo\n',
    'Cargo.toml': '[package]\nversion = "1.0.0"\n', '.cargo/mutants.toml': '', 'packages/a/package.json': '{}', 'go.sum': '',
  });
  const control = await keysOf(repo);
  has(control, 'VALIDATION_COMMANDS', '`yarn run --silent test`, `just check`, `cargo fmt --check`, `cargo clippy`, `cargo test -q`',
    'package.json scripts; justfile targets; Cargo.toml; monorepo: packages packages/a — the package in scope is to confirm');
  has(control, 'MUTATION_RUNNER', '`cargo mutants --file <changed files>`', '.cargo/mutants.toml');
  has(control, 'VERSION_FILES', '`Cargo.toml` 1.0.0', 'version fields in Cargo.toml');
  has(control, 'RELEASE_COMMAND', '`yarn run build`', 'package.json scripts');
  has(control, 'WORKTREE_SETUP', '`yarn install`, `go mod download`', 'yarn.lock, go.sum');
  assert.deepEqual(unknownKeys(control), ['PRIOR_CONTRACT'], 'the control: every other key has a value');
  const cases = [
    [{ lstat: { '.cargo/mutants.toml': 'EACCES' } }, ['MUTATION_RUNNER'], /^\.cargo\/mutants\.toml cannot be read$/],
    [{ lstat: { 'mutants.toml': 'EACCES' } }, ['MUTATION_RUNNER'], /^mutants\.toml cannot be read$/],
    [{ lstat: { 'yarn.lock': 'EACCES' } }, ['VALIDATION_COMMANDS', 'RELEASE_COMMAND', 'WORKTREE_SETUP'], /^yarn\.lock cannot be read$/],
    [{ lstat: { 'pnpm-lock.yaml': 'EACCES' } }, ['VALIDATION_COMMANDS', 'RELEASE_COMMAND', 'WORKTREE_SETUP'], /^pnpm-lock\.yaml cannot be read$/],
    [{ lstat: { 'go.sum': 'EACCES' } }, ['WORKTREE_SETUP'], /^go\.sum cannot be read$/],
    [{ lstat: { 'GNUmakefile': 'EACCES' } }, ['VALIDATION_COMMANDS', 'RELEASE_COMMAND'], /^GNUmakefile cannot be read$/],
    [{ lstat: { 'justfile': 'EACCES' } }, ['VALIDATION_COMMANDS', 'RELEASE_COMMAND'], /^justfile cannot be read$/],
    [{ read: { 'justfile': 'EACCES' } }, ['VALIDATION_COMMANDS', 'RELEASE_COMMAND'], /^justfile cannot be read$/],
    [{ lstat: { 'justfile': GONE } }, ['VALIDATION_COMMANDS', 'RELEASE_COMMAND'], /^justfile cannot be read$/],
    [{ lstat: { 'packages/a/package.json': 'EACCES' } }, ['VALIDATION_COMMANDS'], /^packages\/a\/package\.json cannot be read$/],
    [{ lstat: { 'pnpm-workspace.yaml': 'EACCES' } }, ['VALIDATION_COMMANDS'], /^pnpm-workspace\.yaml cannot be read$/],
    [{ read: { 'Cargo.toml': 'EACCES' } }, ['VALIDATION_COMMANDS', 'MUTATION_RUNNER', 'VERSION_FILES'], /^Cargo\.toml cannot be read$/],
    [{ lstat: { 'package.json': 'EACCES' } }, ['VALIDATION_COMMANDS', 'VERSION_FILES', 'RELEASE_COMMAND'], /^package\.json cannot be read$/],
    [{ list: { '': 'EACCES' } }, ['VALIDATION_COMMANDS', 'MUTATION_RUNNER', 'BACKLOG_FILE', 'BACKLOG_ID_PREFIX', 'RELEASE_COMMAND'], /^the repository root cannot be listed$/],
  ];
  for (const [answers, expected, why] of cases) {
    const keys = await keysOf(repo, { io: reads(repo, answers) });
    assert.deepEqual(unknownKeys(keys), [...expected, 'PRIOR_CONTRACT'], JSON.stringify(answers, (key, v) => typeof v === 'function' ? v.name : v));
    for (const k of expected) lacks(keys, k, why);
  }
  // A lockfile that cannot be read is doubt only where a script needs the package manager.
  repo.write('package.json', JSON.stringify({ scripts: { start: 'x' } }));
  const quiet = await keysOf(repo, { io: reads(repo, { lstat: { 'pnpm-lock.yaml': 'EACCES' } }) });
  assert.deepEqual(unknownKeys(quiet), ['WORKTREE_SETUP', 'PRIOR_CONTRACT']);
});

test('detect CLI: --help, json as published, and exit 2 with one UNKNOWN line on bad usage or a directory outside git', async t => {
  const { detectCli, detect, renderJson, KEYS } = await detectApi, repo = fixture(t, { 'BACKLOG.md': 'BL-1\n' });
  const help = detectCli(['--help']);
  assert.equal(help.code, 0);
  assert.ok(help.text.startsWith('detect.mjs --repo <repo> [--format <lines|json>] — '), help.text);
  for (const k of KEYS) assert.ok(help.text.includes(k), 'the help names ' + k);
  const outside = path.join(repo.root, 'plain');
  fs.mkdirSync(outside);
  for (const args of [[], ['--repo'], ['--repo', repo.cwd, '--repo', repo.cwd], ['--repo', repo.cwd, '--format', 'xml'], ['--repo', repo.cwd, '--nope', 'x'], ['--format', 'json'], ['--repo', outside], ['--repo', path.join(repo.root, 'missing')]]) {
    const r = detectCli(args, { env: repo.env });
    assert.equal(r.code, 2, JSON.stringify(args));
    assert.match(r.text, /^UNKNOWN [^\n]*\n$/, JSON.stringify(args));
  }
  assert.equal(detectCli(['--repo', outside], { env: repo.env }).text, 'UNKNOWN --repo is not a git work tree\n');
  const cli = run([path.join(TOOLS, 'detect.mjs'), '--repo', repo.cwd, '--format', 'json'], repo.cwd, repo.env);
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(cli.stdout.split('\n').length, 2, 'one line of JSON');
  const json = JSON.parse(cli.stdout);
  assert.deepEqual(json, renderJson(detect({ repo: repo.cwd, env: repo.env })));
  assert.equal(json.values.BACKLOG_ID_PREFIX, 'BL-'); assert.equal(json.sources.BACKLOG_ID_PREFIX, 'BACKLOG.md');
  assert.ok(!Object.hasOwn(json.values, 'PRIOR_CONTRACT') && !Object.hasOwn(json.values, 'VALIDATION_COMMANDS'), 'unknown keys are left out');
});

// A machine made of injected probes: `programs` maps an executable path to what `--version` prints
// there (null: it exists but fails); every other path is not an executable file.
function machine({ platform = 'linux', release = '6.8.0', env = { PATH: '/usr/bin' }, programs = {}, argsFor = {}, bash = () => 'bash',
  tmpdir = '/tmp', mounts = '/dev/sda1 / ext4 rw 0 0\n', procVersion = 'Linux version 6.8.0 (gcc)', realpaths = {} } = {}) {
  const calls = [];
  return {
    calls, platform, release, env, node: 'v22.0.0', tmpdir, bash,
    executable: file => Object.hasOwn(programs, file),
    run(file, args) {
      calls.push([file, ...args]);
      assert.ok(Array.isArray(args) && args.every(a => typeof a === 'string'), 'arguments, never a command line');
      if (argsFor[file]) assert.deepEqual(args, argsFor[file], file);
      return programs[file] === null ? { ok: false, text: '' } : { ok: true, text: programs[file] + '\n' };
    },
    readText: file => file === '/proc/self/mounts' ? mounts : file === '/proc/version' ? procVersion : assert.fail('unexpected read ' + file),
    realpath: file => Object.hasOwn(realpaths, file) ? realpaths[file] : file,
  };
}
const LINUX_PROGRAMS = {
  '/usr/bin/git': 'git version 2.40.0', '/usr/bin/bash': 'GNU bash, version 5.2.15(1)-release (x86_64-pc-linux-gnu)',
  '/usr/local/bin/python3': 'Python 3.12.1', '/usr/bin/python3': 'Python 3.11.0', '/usr/bin/python': 'Python 2.7.18', '/opt/pwsh/pwsh': 'PowerShell 7.4.2',
};

test('env-facts on Linux: every fact in order, bash and tools through PATH in order, tmpfs warned, the longest mount prefix', async () => {
  const { envFacts, FACTS } = await envApi;
  const p = machine({
    env: { PATH: 'relative/bin:/usr/local/bin:/usr/bin:/opt/pwsh' }, programs: { ...LINUX_PROGRAMS, 'relative/bin/git': 'git version 9.9.9' },
    mounts: '/dev/sda1 / ext4 rw 0 0\ntmpfs /tmp tmpfs rw 0 0\n/dev/sdb1 /home ext4 rw 0 0\ntmpfs /home/u/re tmpfs rw 0 0\n',
  });
  const lines = envFacts({ repo: '/home/u/repo', ...p });
  assert.deepEqual(lines, [
    'os: linux 6.8.0', 'node: v22.0.0', 'git: 2.40.0', 'bash: /usr/bin/bash 5.2.15(1)-release', 'pwsh: /opt/pwsh/pwsh 7.4.2',
    'python: /usr/local/bin/python3 3.12.1', 'tmpdir: /tmp tmpfs — wiped at reboot; keep worktrees elsewhere', 'repo: /home/u/repo ext4',
  ]);
  assert.deepEqual(lines.map(l => l.slice(0, l.indexOf(':'))), FACTS.filter(f => f !== 'powershell'), 'FACTS order, powershell off Windows');
  assert.deepEqual(p.calls.map(c => c[0]), ['/usr/bin/git', '/usr/bin/bash', '/opt/pwsh/pwsh', '/usr/local/bin/python3'], 'each probe runs the resolved absolute path; no python after the first that runs');
});

test('env-facts on Linux off tmpfs and under WSL: no warning, a later mount over the same point wins, octal-escaped mount points, a linked tmpdir', async () => {
  const { envFacts } = await envApi;
  const lines = envFacts({ repo: '/mnt/my disk/r', ...machine({
    programs: { ...LINUX_PROGRAMS, '/usr/bin/bash': 'GNU bash, Version 5.1.16(1)-release (x86_64-pc-linux-gnu)' },
    tmpdir: '/var/tmp-link', realpaths: { '/var/tmp-link': '/scratch/tmp' }, procVersion: 'Linux version 5.15.153.1-microsoft-standard-WSL2',
    mounts: '/dev/sda1 / ext4 rw 0 0\noverlay / overlay rw 0 0\n/dev/sdc1 /mnt/my\\040disk xfs rw 0 0\n/dev/sdd1 /scratch btrfs rw 0 0\n',
  }) });
  assert.equal(lines[0], 'os: linux 6.8.0 (WSL)');
  assert.equal(lines[3], 'bash: /usr/bin/bash 5.1.16(1)-release', 'a localized `Version` still reads');
  assert.deepEqual(lines.slice(-2), ['tmpdir: /var/tmp-link btrfs', 'repo: /mnt/my disk/r xfs']);
  const { filesystemOf } = await envApi;
  assert.equal(filesystemOf('/srv', 'overlay / overlay rw 0 0\n/dev/sda1 / ext4 rw 0 0\n'), 'ext4');
  assert.equal(filesystemOf('/tmpx', 'tmpfs /tmp tmpfs rw 0 0\n'), 'unknown', 'a name prefix is not a mount prefix');
  assert.equal(filesystemOf(null, 'tmpfs / tmpfs rw 0 0\n'), 'unknown');
});

test('env-facts on Windows: Git Bash from resolveBash, PATH case-folded and quoted, powershell, py -3 after failing Store stubs', async () => {
  const { envFacts } = await envApi, apps = 'C:\\Users\\u\\AppData\\Local\\Microsoft\\WindowsApps';
  const p = machine({
    platform: 'win32', release: '10.0.22631', tmpdir: 'C:\\Users\\u\\AppData\\Local\\Temp', bash: () => 'C:\\Git\\bin\\bash.exe',
    env: { Path: `C:\\Git\\cmd;"C:\\Program Files\\PowerShell\\7";C:\\Windows\\System32\\WindowsPowerShell\\v1.0;${apps};C:\\Windows` },
    programs: {
      'C:\\Git\\cmd\\git.exe': 'git version 2.45.1.windows.1', 'C:\\Git\\bin\\bash.exe': 'GNU bash, version 5.2.26(1)-release (x86_64-pc-msys)',
      'C:\\Program Files\\PowerShell\\7\\pwsh.exe': 'PowerShell 7.4.2', 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe': 'unused',
      [`${apps}\\python3.exe`]: null, [`${apps}\\python.exe`]: null, 'C:\\Windows\\py.exe': 'Python 3.12.3',
    },
    argsFor: { 'C:\\Windows\\py.exe': ['-3', '--version'] },
  });
  assert.deepEqual(envFacts({ repo: 'C:\\src\\repo', ...p }), [
    'os: win32 10.0.22631', 'node: v22.0.0', 'git: 2.45.1.windows.1', 'bash: C:\\Git\\bin\\bash.exe 5.2.26(1)-release',
    'pwsh: C:\\Program Files\\PowerShell\\7\\pwsh.exe 7.4.2', 'powershell: C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    'python: C:\\Windows\\py.exe -3 3.12.3', 'tmpdir: C:\\Users\\u\\AppData\\Local\\Temp unknown', 'repo: C:\\src\\repo unknown',
  ]);
  assert.ok(!p.calls.some(c => c[0].endsWith('powershell.exe')), 'powershell is located, not run');
});

test('env-facts with tools absent or failing: absent where PATH holds none, unknown where one fails or a table cannot be read', async () => {
  const { envFacts } = await envApi;
  assert.deepEqual(envFacts({ repo: '/r', ...machine({ env: { PATH: '/empty' } }) }).slice(2, 6), ['git: absent', 'bash: absent', 'pwsh: absent', 'python: absent']);
  assert.deepEqual(envFacts({ repo: 'C:\\r', ...machine({ platform: 'win32', env: { PATH: 'C:\\empty' }, bash: () => null, tmpdir: 'C:\\t' }) }).slice(2, 7),
    ['git: absent', 'bash: absent', 'pwsh: absent', 'powershell: absent', 'python: absent']);
  const failing = machine({ programs: { '/usr/bin/git': null, '/usr/bin/bash': 'GNU bash', '/usr/bin/python3': null, '/usr/bin/python': null }, mounts: null });
  assert.deepEqual(envFacts({ repo: '/r', ...failing }).filter(l => !/^(?:os|node|pwsh):/.test(l)),
    ['git: unknown', 'bash: /usr/bin/bash unknown', 'python: unknown', 'tmpdir: /tmp unknown', 'repo: /r unknown']);
  assert.deepEqual(failing.calls.map(c => c[0]).filter(f => f.includes('python')), ['/usr/bin/python3', '/usr/bin/python'], 'each python is tried when the one before fails');
  // Off Windows PATH is read by its exact name: a Path beside it is another variable.
  const exact = machine({ env: { Path: '/opt/other', PATH: '/usr/bin' }, programs: { '/opt/other/git': 'git version 9.9.9', '/usr/bin/git': 'git version 2.40.0' } });
  assert.equal(envFacts({ repo: '/r', ...exact })[2], 'git: 2.40.0');
  assert.equal(envFacts({ repo: '/r', ...machine({ env: { Path: '/usr/bin' }, programs: LINUX_PROGRAMS }) })[2], 'git: absent');
});

test('env-facts CLI: --help, exit 2 on bad usage, and one real run whose lines have the published shapes', async t => {
  const { envFactsCli, FACTS } = await envApi;
  const help = envFactsCli(['--help']);
  assert.equal(help.code, 0);
  assert.ok(help.text.startsWith('env-facts.mjs --repo <repo> — '), help.text);
  for (const f of FACTS) assert.ok(help.text.includes(f), 'the help names ' + f);
  for (const args of [[], ['--repo'], ['--repo', ROOT, '--repo', ROOT], ['--nope', 'x'], ['--repo', path.join(ROOT, 'no such dir')], ['--repo', path.join(ROOT, 'README.md')]]) {
    const r = envFactsCli(args);
    assert.equal(r.code, 2, JSON.stringify(args)); assert.match(r.text, /^UNKNOWN [^\n]*\n$/);
  }
  assert.equal(envFactsCli(['--repo', path.join(ROOT, 'README.md')]).text, 'UNKNOWN --repo is not a directory\n', 'a regular file is not a directory');
  const r = run([path.join(TOOLS, 'env-facts.mjs'), '--repo', ROOT], ROOT);
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.split('\n');
  assert.equal(lines.pop(), '');
  assert.deepEqual(lines.map(l => l.slice(0, l.indexOf(':'))), FACTS.filter(f => f !== 'powershell' || process.platform === 'win32'));
  const abs = String.raw`(?:/|[A-Za-z]:\\)`, fsType = String.raw`(?:tmpfs — wiped at reboot; keep worktrees elsewhere|(?!tmpfs)\S+)`;
  const shapes = [/^os: \S+ \S+(?: \(WSL\))?$/, new RegExp('^node: ' + process.version.replace(/\./g, '\\.') + '$'), /^git: (?:\S+|absent)$/,
    new RegExp(`^bash: (?:absent|${abs}.* \\S+)$`), new RegExp(`^pwsh: (?:absent|${abs}.* \\S+)$`),
    ...(process.platform === 'win32' ? [new RegExp(`^powershell: (?:absent|${abs}.*)$`)] : []),
    new RegExp(`^python: (?:absent|unknown|${abs}.* \\S+)$`), new RegExp(`^tmpdir: ${abs}.* ${fsType}$`), new RegExp(`^repo: .* ${fsType}$`)];
  lines.forEach((line, i) => assert.match(line, shapes[i]));
  assert.ok(lines[lines.length - 1].startsWith('repo: ' + ROOT + ' '), lines[lines.length - 1]);
});

test('every member of each closed detection list is detected, and each list holds the spec\'s names', async t => {
  const { SCRIPT_CHECKS, TARGET_CHECKS, RELEASE, LOCKS, MANAGERS, BACKLOG_NAMES, REVIEW_WORDS } = await detectApi;
  const superset = (list, spec, name) => assert.deepEqual(spec.filter(x => !list.includes(x)), [], name + ' holds every spec name');
  superset(SCRIPT_CHECKS, ['lint', 'format:check', 'typecheck', 'check', 'test'], 'SCRIPT_CHECKS');
  superset(TARGET_CHECKS, ['lint', 'typecheck', 'check', 'test'], 'TARGET_CHECKS');
  superset(RELEASE, ['build', 'release', 'package'], 'RELEASE');
  superset(LOCKS.map(l => l.join(' → ')), ['package-lock.json → npm ci', 'npm-shrinkwrap.json → npm ci', 'pnpm-lock.yaml → pnpm install', 'yarn.lock → yarn install',
    'Cargo.lock → cargo fetch', 'uv.lock → uv sync', 'requirements.txt → pip install -r requirements.txt', 'go.sum → go mod download'], 'LOCKS');
  superset(MANAGERS.map(l => l.join(' → ')), ['package-lock.json → npm', 'npm-shrinkwrap.json → npm', 'pnpm-lock.yaml → pnpm', 'yarn.lock → yarn'], 'MANAGERS');
  superset(BACKLOG_NAMES, ['BACKLOG', 'TODO', 'BUGS', 'FEATURE'], 'BACKLOG_NAMES');
  superset(REVIEW_WORDS, ['review', 'audit', 'hunt', 'check'], 'REVIEW_WORDS');
  // One repository, one member at a time: each detection is that member's alone.
  const repo = fixture(t), drop = file => fs.rmSync(path.join(repo.cwd, file), { recursive: true, force: true });
  for (const s of SCRIPT_CHECKS) {
    repo.write('package.json', JSON.stringify({ scripts: { [s]: 'x' } }));
    has(await keysOf(repo), 'VALIDATION_COMMANDS', `\`npm run --silent ${s}\``, 'package.json scripts');
  }
  for (const s of RELEASE) {
    repo.write('package.json', JSON.stringify({ scripts: { [s]: 'x' } }));
    has(await keysOf(repo), 'RELEASE_COMMAND', `\`npm run ${s}\``, 'package.json scripts');
  }
  repo.write('package.json', JSON.stringify({ scripts: { test: 'x' } }));
  for (const [file, manager] of MANAGERS) {
    repo.write(file, '');
    has(await keysOf(repo), 'VALIDATION_COMMANDS', `\`${manager} run --silent test\``, 'package.json scripts');
    drop(file);
  }
  drop('package.json');
  for (const n of TARGET_CHECKS) {
    repo.write('Makefile', `${n}:\n\techo\n`); repo.write('justfile', `${n}:\n    echo\n`);
    has(await keysOf(repo), 'VALIDATION_COMMANDS', `\`just ${n}\`, \`make -s ${n}\``, 'justfile targets; Makefile targets');
  }
  for (const n of RELEASE) {
    repo.write('Makefile', `${n}:\n\techo\n`); repo.write('justfile', `${n}:\n    echo\n`);
    has(await keysOf(repo), 'RELEASE_COMMAND', `\`just ${n}\`, \`make ${n}\``, 'justfile targets; Makefile targets');
  }
  drop('Makefile'); drop('justfile');
  for (const [file, command] of LOCKS) {
    repo.write(file, '');
    has(await keysOf(repo), 'WORKTREE_SETUP', `\`${command}\``, file);
    drop(file);
  }
  for (const name of BACKLOG_NAMES) for (const file of [name + '.md', name.toLowerCase() + 's.txt']) {
    repo.write(file, 'X-1\n');
    const keys = await keysOf(repo);
    has(keys, 'BACKLOG_FILE', `\`${file}\``, `root file ${file}`); has(keys, 'BACKLOG_ID_PREFIX', 'X-', file);
    drop(file);
  }
  for (const file of ['stryker.conf.js', 'stryker.config.json', 'stryker.config.mjs']) {
    repo.write(file, '{}');
    has(await keysOf(repo), 'MUTATION_RUNNER', '`npx stryker run --mutate <changed files>`', file);
    drop(file);
  }
  for (const file of ['.cargo/mutants.toml', 'mutants.toml']) {
    repo.write(file, '');
    has(await keysOf(repo), 'MUTATION_RUNNER', '`cargo mutants --file <changed files>`', file);
    drop(file);
  }
  for (const word of REVIEW_WORDS) for (const form of [word, word + 's', word + 'ed', word + 'ing', word + 'er', word + 'ers', word + 'or', word + 'ors']) {
    const description = form[0].toUpperCase() + form.slice(1) + ' one batch.';
    repo.write('.claude/agents/a.md', `---\nname: a\ndescription: ${description}\ntools: Read\n---\n`);
    has(await keysOf(repo), 'GATE_AGENTS', 'a (tools: Read; review-shaped)', '.claude/agents/**/*.md frontmatter');
  }
  // The other side of the boundary: a review word that follows other letters is none.
  for (const word of REVIEW_WORDS) {
    repo.write('.claude/agents/a.md', `---\nname: a\ndescription: Builds un${word}ed pages.\ntools: Read\n---\n`);
    has(await keysOf(repo), 'GATE_AGENTS', 'a (tools: Read; not review-shaped)', '.claude/agents/**/*.md frontmatter');
  }
});

test('control characters from the repository or the machine print as ?, keeping one line per key or fact', async t => {
  const ESC = char(27), CSI = char(0x9b), LS = char(0x2028), { detect, renderLines, renderJson } = await detectApi;
  const repo = fixture(t, { 'CLAUDE.md': '# P\n\n## Guardrails' + ESC + '[31m' + CSI + LS + ' here\n' });
  const result = detect({ repo: repo.cwd, env: repo.env }), lines = renderLines(result), json = renderJson(result);
  assert.equal(result.keys.GUARDRAILS_REF.value, '`CLAUDE.md` §Guardrails' + ESC + '[31m' + CSI + LS + ' here', 'the core keeps the raw heading');
  assert.ok(lines.includes('GUARDRAILS_REF: `CLAUDE.md` §Guardrails?[31m?? here — CLAUDE.md heading\n'), lines);
  assert.ok(![ESC, CSI, LS].some(c => lines.includes(c)) && lines.split('\n').length === 16, 'one line per key: ' + lines);
  assert.equal(json.values.GUARDRAILS_REF, '`CLAUDE.md` §Guardrails?[31m?? here');
  const { envFacts } = await envApi;
  assert.equal(envFacts({ repo: '/r', ...machine({ release: '6.8' + ESC + '\n' + CSI + LS, programs: LINUX_PROGRAMS }) })[0], 'os: linux 6.8????');
});

test('the real probes: resolveBash\'s answer, the machine as this process sees it, spawns under the published options, executable files only', async t => {
  const { realProbes, SPAWN_OPTIONS } = await envApi, { resolveBash } = await import('../orchestrate/tools/validate.mjs');
  const real = realProbes();
  assert.equal(real.bash(process.env), resolveBash(process.env).bash);
  assert.deepEqual({ platform: real.platform, release: real.release, env: real.env, node: real.node, tmpdir: real.tmpdir },
    { platform: process.platform, release: os.release(), env: process.env, node: process.version, tmpdir: os.tmpdir() });
  assert.deepEqual({ shell: SPAWN_OPTIONS.shell, timeout: SPAWN_OPTIONS.timeout }, { shell: false, timeout: 15000 });
  // run hands every spawn the published options as they are, and a probe ran only on a clean exit.
  const seen = [], answers = [
    [{ status: 0, signal: null, stdout: 'out', stderr: 'err' }, { ok: true, text: 'out\nerr' }],
    [{ status: 1, signal: null, stdout: 'x' }, { ok: false, text: 'x\n' }],
    [{ status: null, signal: 'SIGTERM', error: Object.assign(new Error('spawnSync x ETIMEDOUT'), { code: 'ETIMEDOUT' }), stdout: '', stderr: '' }, { ok: false, text: '\n' }],
    [{ status: 0, signal: 'SIGKILL', stdout: '', stderr: '' }, { ok: false, text: '\n' }],
    [{ status: 0, signal: null, error: Object.assign(new Error('spawnSync x ENOENT'), { code: 'ENOENT' }) }, { ok: false, text: '\n' }],
  ];
  for (const [answer, expected] of answers) {
    const probe = realProbes((file, args, options) => { seen.push({ file, args, options }); return answer; });
    assert.deepEqual(probe.run('/bin/x', ['--version']), expected, JSON.stringify(answer));
  }
  assert.equal(seen.length, answers.length);
  for (const s of seen) { assert.equal(s.options, SPAWN_OPTIONS, 'the published options, as they are'); assert.deepEqual([s.file, s.args], ['/bin/x', ['--version']]); }
  // The real spawn: shell syntax in an argument arrives as bytes, never evaluated or split.
  const arg = 'a;$X b "c" | d';
  const r = real.run(process.execPath, ['-e', 'process.stdout.write(process.argv[1])', arg]);
  assert.equal(r.ok, true); assert.ok(r.text.startsWith(arg + '\n'), JSON.stringify(r.text));
  assert.equal(real.run(process.execPath, ['-e', 'process.exit(3)']).ok, false, 'a non-zero exit is a failed probe');
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'env-facts-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const plain = path.join(dir, 'plain');
  fs.writeFileSync(plain, 'x', { mode: 0o644 }); fs.mkdirSync(path.join(dir, 'sub'));
  assert.equal(real.executable(process.execPath), true);
  assert.equal(real.executable(dir), false, 'a directory is not an executable file');
  assert.equal(real.executable(path.join(dir, 'missing')), false, 'nor is a missing one');
  // Windows has no execute bit: there a regular file is one; elsewhere a 0644 file is not.
  assert.equal(real.executable(plain), process.platform === 'win32');
  // readText and realpath read the real file system, and answer null where there is nothing to read.
  assert.equal(real.readText(plain), 'x');
  assert.equal(real.readText(path.join(dir, 'missing')), null);
  assert.equal(real.realpath(path.join(dir, 'sub', '..', 'plain')), plain);
  assert.equal(real.realpath(path.join(dir, 'missing')), null);
});
