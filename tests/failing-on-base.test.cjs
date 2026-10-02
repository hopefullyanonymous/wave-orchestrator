// failing-on-base.mjs against a small git repository built here: a module with a bug, a node:test
// suite that passes on it, and one branch per result and per edge of protocol step 6b, each cut
// from the same base. The logic runs in-process through the exported core; the CLI runs only a
// few times, as published. Every run is held to the same checks: the repository untouched (refs,
// HEAD, index, files, status and worktree list), nothing left under the temp root it was given.
'use strict';
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');
const { makeRepo } = require('./support/git-fixture.cjs');
const ROOT = path.resolve(__dirname, '..');
const TOOL = path.join(ROOT, 'orchestrate/tools/failing-on-base.mjs');
const api = () => import(pathToFileURL(TOOL).href);
const NODE = process.execPath;

// ===== The fixture repository =====================================================================
const lines = (...l) => l.join('\n') + '\n';
const HEAD = ["const test = require('node:test');", "const assert = require('node:assert/strict');", "const { add, half } = require('../lib/math.cjs');"];
// The base's bug: half returns its argument.
const MATH = lines('exports.add = (a, b) => a + b;', 'exports.half = x => x;');
const FIXED = lines('exports.add = (a, b) => a + b;', 'exports.half = x => x / 2;');
const ADD_TEST = lines(...HEAD, "test('add sums', () => { assert.equal(add(2, 3), 5); });");
const OLD_TEST = lines(...HEAD, "test('old add check', () => { assert.equal(add(1, 1), 2); });");
const HALF_TEST = lines(...HEAD, "test('half halves', () => { assert.equal(half(4), 2); });");
const MORE_TEST = lines(...HEAD, "test('add sums again', () => { assert.equal(add(1, 2), 3); });");
const FEATURE_TEST = lines("const test = require('node:test');", "const { feature } = require('../lib/feature.cjs');", "test('feature runs', () => { feature(); });");
// A production edit with a test inside it, and one whose calls only look like one.
const MIXED = FIXED + lines("const test = require('node:test');", "if (process.env.INLINE_TESTS) test('half inline', () => {});");
const LOOKALIKE = FIXED + lines("exports.words = s => s.split(' ').filter(w => /x/.test(w));", 'exports.quit = code => process.exit(code);');
const specOf = () => ({ steps: [{ name: 'tests', argv: [NODE, '--test'], parser: 'node' }] });

function fixture(t) {
  const repo = makeRepo(t);
  repo.git('config', 'maintenance.auto', 'false');
  repo.git('config', 'gc.auto', '0');
  const work = path.join(repo.root, 'work');
  fs.mkdirSync(work);
  const files = { 'lib/math.cjs': MATH, 'tests/add.test.cjs': ADD_TEST, 'tests/old.test.cjs': OLD_TEST, 'README.md': 'fixture\n' };
  for (const [file, text] of Object.entries(files)) repo.write(file, text);
  const base = repo.commit('base: half is broken');
  // One branch per case, each cut from the base; `remove` lists paths the branch deletes.
  const branch = (name, write, remove = [], from = base) => {
    repo.git('checkout', '--quiet', '-b', name, from);
    for (const [file, text] of Object.entries(write)) repo.write(file, text);
    if (remove.length) repo.git('rm', '--quiet', '--', ...remove.map(file => ':(literal)' + file));
    const sha = repo.commit(name);
    repo.git('checkout', '--quiet', 'main');
    return sha;
  };
  const b = {
    proven: branch('fix-proven', { 'lib/math.cjs': FIXED, 'tests/half.test.cjs': HALF_TEST }),
    allpass: branch('fix-allpass', { 'tests/more.test.cjs': MORE_TEST }),
    load: branch('fix-load', { 'lib/feature.cjs': lines('exports.feature = () => {};'), 'tests/feature.test.cjs': FEATURE_TEST }),
    empty: branch('fix-empty', { 'tests/empty.test.cjs': lines('// No test registered yet.') }),
    notest: branch('fix-notest', { 'lib/math.cjs': FIXED }),
    deleted: branch('fix-deleted', { 'lib/math.cjs': FIXED, 'tests/half.test.cjs': HALF_TEST }, ['tests/old.test.cjs']),
    mixed: branch('fix-mixed', { 'lib/math.cjs': MIXED, 'tests/half.test.cjs': HALF_TEST }),
    lookalike: branch('fix-lookalike', { 'lib/math.cjs': LOOKALIKE, 'tests/half.test.cjs': HALF_TEST }),
    mixedOnly: branch('fix-mixed-only', { 'lib/math.cjs': MIXED }),
    // An added line git cannot give as UTF-8: the file's diff is unreadable, and doubt is named for review.
    latin1: branch('fix-latin1', { 'lib/math.cjs': Buffer.concat([Buffer.from(FIXED), Buffer.from([0x2f, 0x2f, 0x20, 0xe9, 0x0a])]), 'tests/half.test.cjs': HALF_TEST }),
    // A test path that, read as a glob, also matches tests/a.test.cjs, which the batch leaves alone.
    glob: branch('fix-glob', { 'lib/math.cjs': FIXED, 'tests/half.test.cjs': HALF_TEST }, ['tests/[ab].test.cjs'],
      branch('glob-base', { 'tests/[ab].test.cjs': lines(...HEAD, "test('bracket test', () => {});"), 'tests/a.test.cjs': lines(...HEAD, "test('a test', () => {});") })),
  };
  // The integration branch moves on, then takes fix-proven in a merge commit.
  repo.write('README.md', 'fixture, moved on\n');
  const moved = repo.commit('main moves on');
  repo.git('merge', '--quiet', '--no-ff', '-m', 'merge fix-proven', 'fix-proven');
  const merge = repo.git('rev-parse', 'HEAD');
  // Two merge bases (a criss-cross), and none (an unrelated history).
  const c1 = branch('cross-1', { 'one.txt': '1\n' }), c2 = branch('cross-2', { 'two.txt': '2\n' });
  repo.git('checkout', '--quiet', 'cross-1'); repo.git('merge', '--quiet', '--no-ff', '-m', 'm1', c2);
  repo.git('checkout', '--quiet', 'cross-2'); repo.git('merge', '--quiet', '--no-ff', '-m', 'm2', c1);
  repo.git('checkout', '--quiet', '--orphan', 'lonely'); repo.git('rm', '--quiet', '-r', '--cached', '.');
  for (const file of Object.keys(files)) fs.rmSync(path.join(repo.cwd, file));
  repo.write('alone.txt', 'alone\n');
  repo.commit('lonely');
  repo.git('checkout', '--quiet', 'main');
  const env = { ...repo.env };
  delete env.NODE_TEST_CONTEXT;
  const json = (name, value) => { const file = path.join(work, name); fs.writeFileSync(file, JSON.stringify(value)); return file; };
  return { repo, work, base, b, moved, merge, env, json, short: sha => repo.git('rev-parse', '--short', sha) };
}

// ===== What every run must leave behind =============================================================
function state(repo) {
  return { snapshot: repo.snapshot(), status: repo.git('--no-optional-locks', 'status', '--porcelain', '--untracked-files=all'),
    worktrees: repo.git('worktree', 'list', '--porcelain') };
}
// prompt.mjs's own test of a string fact (`STRING_FACTS`): non-empty, one line, no C0, DEL, C1,
// U+2028 or U+2029.
const isFact = text => typeof text === 'string' && text.trim() !== '' && ![...text].some(c => { const n = c.codePointAt(0); return n < 32 || (n >= 127 && n <= 159) || n === 0x2028 || n === 0x2029; });
// In-process runs see the isolated Git configuration the CLI runs get, never this machine's.
async function isolated(fx, fn, config = fx.repo.env.GIT_CONFIG_GLOBAL) {
  const saved = Object.entries(process.env).filter(([key]) => /^GIT_/i.test(key));
  for (const [key] of saved) delete process.env[key];
  const set = { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: config };
  Object.assign(process.env, set);
  try { return await fn(); } finally {
    for (const key of Object.keys(set)) delete process.env[key];
    for (const [key, value] of saved) process.env[key] = value;
  }
}
let runs = 0;
async function core(fx, options) {
  const { failingOnBase } = await api();
  const tmp = fs.mkdtempSync(path.join(fx.repo.root, 'tmp-')), logPath = options.logPath ?? path.join(fx.work, `core-${++runs}.log`), before = state(fx.repo);
  const result = await isolated(fx, () => failingOnBase({ repo: fx.repo.cwd, validate: specOf(), logPath, tmpRoot: tmp, ...options }));
  assert.deepEqual(state(fx.repo), before, 'the repository must be untouched');
  if (!options.remove) assert.deepEqual(fs.readdirSync(tmp), [], 'no checkout survives under the temp root');
  assert.ok(isFact(result.line), 'a valid failingOnBase fact: ' + JSON.stringify(result.line));
  return { ...result, tmp, logPath, log: fs.readFileSync(logPath, 'utf8') };
}
function cli(fx, args, env = {}) {
  const tmp = fs.mkdtempSync(path.join(fx.repo.root, 'tmp-')), before = state(fx.repo);
  const r = spawnSync(NODE, [TOOL, ...args], { cwd: fx.work, env: { ...fx.env, TEMP: tmp, TMP: tmp, TMPDIR: tmp, ...env }, encoding: 'utf8', windowsHide: true, timeout: 180000 });
  assert.ifError(r.error); assert.equal(r.signal, null); assert.equal(r.stderr, '', 'nothing on stderr');
  assert.deepEqual(state(fx.repo), before, 'the repository passed as --repo must be untouched');
  assert.deepEqual(fs.readdirSync(tmp), [], 'no directory survives under the temp root');
  assert.match(r.stdout, /^[^\n]+\n$/, 'exactly one line: ' + JSON.stringify(r.stdout));
  const line = r.stdout.slice(0, -1);
  assert.ok(isFact(line), 'a valid failingOnBase fact: ' + JSON.stringify(line));
  return { code: r.status, line };
}
const args = (fx, base, batch, log, extra = []) => ['--repo', fx.repo.cwd, '--base', base, '--batch', batch, '--validate', fx.json('validate.json', specOf()), '--log', path.join(fx.work, log), ...extra];
// A setup step that records, outside the checkout, where it ran and which of `paths` exist there.
const probe = (fx, name, paths) => {
  const out = path.join(fx.work, name + '.json');
  const script = "const fs = require('fs'); fs.writeFileSync(process.argv[1], JSON.stringify({ cwd: process.cwd(), exists: JSON.parse(process.argv[2]).map(p => fs.existsSync(p)) }));";
  return { out, spec: { steps: [{ name: 'probe', argv: [NODE, '-e', script, out, JSON.stringify(paths)], parser: 'none' }] } };
};
// A validate spec running node's own test runner in the checkout, each test file in its output
// spelled tests\<file>, as the runner spells it on Windows: that platform's run, on every platform.
const windowsSpec = fx => {
  const shim = path.join(fx.work, 'windows-node.cjs');
  fs.writeFileSync(shim, lines("const { spawnSync } = require('node:child_process');", "const { sep } = require('node:path').win32;",
    "const r = spawnSync(process.execPath, ['--test', '--test-reporter=spec'], { encoding: 'utf8' });", 'if (r.error) throw r.error;',
    "const windows = text => text.split('tests/').join('tests' + sep);",
    'process.stdout.write(windows(r.stdout));', 'process.stderr.write(windows(r.stderr));', 'process.exitCode = r.status ?? 1;'));
  return { steps: [{ name: 'tests', argv: [NODE, shim], parser: 'node' }] };
};
// A log's text without colour codes, so a reporter line reads the same under FORCE_COLOR.
const uncoloured = text => text.replace(new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g'), '');

// ===== The three results, each for its stated reason =================================================
test('PROVEN: the new test fails on the base, and only the test files are taken from the batch', async t => {
  const fx = fixture(t);
  const p = probe(fx, 'proven', ['tests/half.test.cjs', 'lib/math.cjs']);
  const r = await core(fx, { base: 'main~1', batch: 'fix-proven', setup: p.spec });
  assert.deepEqual([r.code, r.line], [0, 'PROVEN (1 of 3 fail: half halves)']);
  const seen = JSON.parse(fs.readFileSync(p.out, 'utf8'));
  assert.deepEqual(seen.exists, [true, true], 'the test file was checked out before setup ran');
  assert.equal(path.basename(seen.cwd), 'c');
  assert.equal(path.dirname(path.dirname(seen.cwd)), fs.realpathSync(r.tmp), 'setup ran in the disposable checkout under the temp root');
  assert.match(r.log, new RegExp(`merge base ${fx.base}, batch ${fx.b.proven}; check out: tests/half\\.test\\.cjs; delete: -; mixed: -`));
});

test('ALL-PASS (P0): the new test passes on the base too', async t => {
  const fx = fixture(t);
  const r = await core(fx, { base: 'main', batch: 'fix-allpass' });
  assert.deepEqual([r.code, r.line], [1, 'ALL-PASS (P0)']);
});

test('INCONCLUSIVE: a new test that loads code the base lacks, a test file with no test, no test change, a failing setup', async t => {
  const fx = fixture(t);
  const load = await core(fx, { base: 'main', batch: 'fix-load' });
  assert.deepEqual([load.code, load.line], [2, 'INCONCLUSIVE (load error: tests/feature.test.cjs)']);
  const empty = await core(fx, { base: 'main', batch: 'fix-empty' });
  assert.deepEqual([empty.code, empty.line], [2, 'INCONCLUSIVE (ran no tests: tests/empty.test.cjs)']);
  const none = await core(fx, { base: 'main', batch: 'fix-notest' });
  assert.deepEqual([none.code, none.line], [2, 'INCONCLUSIVE (no test file changed)']);
  assert.ok(!none.log.includes('checkout '), 'no checkout is made when no test file changed');
  const failing = { steps: [{ name: 'setup', argv: [NODE, '-e', 'process.exit(3)'], parser: 'none' }] };
  const setup = await core(fx, { base: fx.base, batch: 'fix-proven', setup: failing });
  assert.deepEqual([setup.code, setup.line], [2, `INCONCLUSIVE (setup: FAIL setup exit 3 — log: ${setup.logPath})`]);
  assert.ok(!setup.log.includes('==> mutate: validate'), 'validate never runs after a failing setup');
  // A log path holding \ (a file name on POSIX, a directory on Windows) prints as resolved, never respelled.
  const odd = await core(fx, { base: fx.base, batch: 'fix-proven', setup: failing, logPath: path.join(fx.work, 'a\\b.log') });
  assert.deepEqual([odd.code, odd.line], [2, `INCONCLUSIVE (setup: FAIL setup exit 3 — log: ${path.resolve(odd.logPath)})`]);
  // The mixed tail rides on every INCONCLUSIVE line too.
  const onlyMixed = await core(fx, { base: 'main', batch: 'fix-mixed-only' });
  assert.deepEqual([onlyMixed.code, onlyMixed.line], [2, 'INCONCLUSIVE (no test file changed; mixed, left to review: lib/math.cjs)']);
  const mixedSetup = await core(fx, { base: 'main', batch: 'fix-mixed', setup: failing });
  assert.deepEqual([mixedSetup.code, mixedSetup.line], [2, `INCONCLUSIVE (setup: FAIL setup exit 3 — log: ${mixedSetup.logPath}; mixed, left to review: lib/math.cjs)`]);
});

test('INCONCLUSIVE names a file that failed to load or ran no tests with /, however the run spelled it', async t => {
  const fx = fixture(t), windows = windowsSpec(fx);
  const load = await core(fx, { base: 'main', batch: 'fix-load', validate: windows });
  const empty = await core(fx, { base: 'main', batch: 'fix-empty', validate: windows });
  assert.match(uncoloured(load.log), /^test at tests\\feature\.test\.cjs:\d+:\d+$/m, 'live control: the run named the file that failed to load the Windows way');
  assert.match(uncoloured(empty.log), /^✔ tests\\empty\.test\.cjs \(/m, 'live control: the run named the file with no test the Windows way');
  assert.deepEqual([load.code, load.line, empty.code, empty.line], [2, 'INCONCLUSIVE (load error: tests/feature.test.cjs)', 2, 'INCONCLUSIVE (ran no tests: tests/empty.test.cjs)']);
});

// ===== The edges =====================================================================================
test('a deleted test is absent in the checkout', async t => {
  const fx = fixture(t);
  const p = probe(fx, 'deleted', ['tests/old.test.cjs', 'tests/half.test.cjs', 'tests/add.test.cjs']);
  const r = await core(fx, { base: 'main', batch: 'fix-deleted', setup: p.spec });
  // With old.test.cjs still there the run would count three tests.
  assert.deepEqual([r.code, r.line], [0, 'PROVEN (1 of 2 fail: half halves)']);
  assert.deepEqual(JSON.parse(fs.readFileSync(p.out, 'utf8')).exists, [false, true, true]);
});

test('a production file whose added lines hold a test is named and never checked out; lookalike calls stay production', async t => {
  const fx = fixture(t);
  // Checked out, the mixed file's fix would make half halves pass: ALL-PASS, not PROVEN.
  const mixed = await core(fx, { base: 'main', batch: 'fix-mixed' });
  assert.deepEqual([mixed.code, mixed.line], [0, 'PROVEN (1 of 3 fail: half halves; mixed, left to review: lib/math.cjs)']);
  const look = await core(fx, { base: 'main', batch: 'fix-lookalike' });
  assert.deepEqual([look.code, look.line], [0, 'PROVEN (1 of 3 fail: half halves)']);
  const latin1 = await core(fx, { base: 'main', batch: 'fix-latin1' });
  assert.deepEqual([latin1.code, latin1.line], [0, 'PROVEN (1 of 3 fail: half halves; mixed, left to review: lib/math.cjs)']);
  const none = await core(fx, { base: 'main', batch: 'cross-1' });
  assert.equal(none.line, 'INCONCLUSIVE (no test file changed)');
});

test('an already-merged batch, given the pre-merge base, is still PROVEN; the merge commit itself leaves nothing to run', async t => {
  const fx = fixture(t);
  assert.equal(fx.repo.git('rev-parse', 'main^1'), fx.moved);
  const pre = await core(fx, { base: fx.moved, batch: 'fix-proven' });
  assert.deepEqual([pre.code, pre.line], [0, 'PROVEN (1 of 3 fail: half halves)']);
  const post = await core(fx, { base: fx.merge, batch: 'fix-proven' });
  assert.deepEqual([post.code, post.line], [2, 'INCONCLUSIVE (no test file changed)']);
});

test('not exactly one merge base, and a ref that names no commit, are UNKNOWN', async t => {
  const fx = fixture(t);
  const two = await core(fx, { base: 'cross-1', batch: 'cross-2' });
  assert.deepEqual([two.code, two.line], [2, 'UNKNOWN --base and --batch have 2 merge bases; exactly one is needed']);
  const zero = await core(fx, { base: 'main', batch: 'lonely' });
  assert.deepEqual([zero.code, zero.line], [2, 'UNKNOWN --base and --batch have 0 merge bases; exactly one is needed']);
  const noBase = await core(fx, { base: 'no-such', batch: 'fix-proven' });
  assert.deepEqual([noBase.code, noBase.line], [2, `UNKNOWN --base names no commit in ${fx.repo.cwd}`]);
  const noBatch = await core(fx, { base: 'main', batch: 'no-such' });
  assert.deepEqual([noBatch.code, noBatch.line], [2, `UNKNOWN --batch names no commit in ${fx.repo.cwd}`]);
});

test('a test path holding [ is one literal path: the checkout keeps the test its glob would match', async t => {
  const fx = fixture(t);
  const p = probe(fx, 'glob', ['tests/[ab].test.cjs', 'tests/a.test.cjs']);
  const r = await core(fx, { base: 'glob-base', batch: 'fix-glob', setup: p.spec });
  // Read as a glob, git rm would take tests/a.test.cjs too: three tests, not four.
  assert.deepEqual([r.code, r.line], [0, 'PROVEN (1 of 4 fail: half halves)']);
  assert.deepEqual(JSON.parse(fs.readFileSync(p.out, 'utf8')).exists, [false, true]);
});

test('a log that cannot be opened is UNKNOWN before anything runs', async t => {
  const fx = fixture(t), { failingOnBase } = await api();
  const blocker = path.join(fx.work, 'a-file');
  fs.writeFileSync(blocker, 'not a directory');
  const logPath = path.join(blocker, 'x.log'), tmp = fs.mkdtempSync(path.join(fx.repo.root, 'tmp-')), before = state(fx.repo);
  const r = await isolated(fx, () => failingOnBase({ repo: fx.repo.cwd, base: fx.base, batch: 'fix-proven', validate: specOf(), logPath, tmpRoot: tmp }));
  assert.equal(r.code, 2);
  assert.match(r.line, /^UNKNOWN cannot open log .*a-file.x\.log \((?:ENOTDIR|EEXIST)\)$/);
  assert.deepEqual(state(fx.repo), before);
  assert.deepEqual(fs.readdirSync(tmp), [], 'no checkout was made');
});

test('a checkout that cannot be removed turns the result into UNKNOWN cleanup, exit 2', async t => {
  const fx = fixture(t), { removeTree } = await import(pathToFileURL(path.join(ROOT, 'orchestrate/tools/mutate.mjs')).href);
  const busy = () => { throw Object.assign(new Error('held open'), { code: 'EBUSY' }); };
  const r = await core(fx, { base: fx.base, batch: 'fix-proven', remove: busy });
  const [left] = fs.readdirSync(r.tmp);
  assert.ok(left && left.startsWith('mut-'));
  assert.equal(r.line, `UNKNOWN cleanup: ${path.join(r.tmp, left)} could not be removed (EBUSY); the run said PROVEN (1 of 3 fail: half halves)`);
  assert.equal(r.code, 2);
  removeTree(path.join(r.tmp, left));
});

// ===== The CLI, as published ==========================================================================
test('the CLI prints one line per result with exit 0, 1 and 2', async t => {
  const fx = fixture(t);
  assert.deepEqual(cli(fx, args(fx, fx.moved, 'fix-proven', 'p.log')), { code: 0, line: 'PROVEN (1 of 3 fail: half halves)' });
  assert.deepEqual(cli(fx, args(fx, 'main', fx.b.allpass, 'a.log')), { code: 1, line: 'ALL-PASS (P0)' });
  assert.deepEqual(cli(fx, args(fx, fx.base, 'fix-notest', 'n.log')), { code: 2, line: 'INCONCLUSIVE (no test file changed)' });
  // --setup and --timeout reach the run: a setup that outlives one second stops it.
  const slow = fx.json('slow-setup.json', { steps: [{ name: 'setup', argv: [NODE, '-e', 'setTimeout(() => {}, 20000)'], parser: 'none' }] });
  const log = path.join(fx.work, 's.log');
  assert.deepEqual(cli(fx, args(fx, fx.base, 'fix-proven', 's.log', ['--setup', slow, '--timeout', '1'])), { code: 2, line: `INCONCLUSIVE (setup: FAIL setup TIMEOUT after 1s — log: ${log})` });
});

test('no hook the source repository configures runs, on the clone or on the path checkout', async t => {
  const fx = fixture(t);
  const hooks = path.join(fx.repo.root, 'user-hooks'), slash = p => p.split(path.sep).join('/');
  fs.mkdirSync(hooks);
  const marker = path.join(fx.repo.root, 'hook-ran.txt');
  for (const hook of ['post-checkout', 'reference-transaction']) fs.writeFileSync(path.join(hooks, hook), '#!/bin/sh\ncat > /dev/null\necho ' + hook + ' >> "' + slash(marker) + '"\n', { mode: 0o755 });
  const config = path.join(fx.repo.root, 'hooks.gitconfig');
  fs.writeFileSync(config, '[core]\n\thooksPath = ' + slash(hooks) + '\n');
  // Live control: under that configuration a plain path checkout of the batch's test runs post-checkout.
  const control = path.join(fx.repo.root, 'control-clone');
  const plain = (cwd, list) => { const r = spawnSync('git', list, { cwd, env: { ...fx.env, GIT_CONFIG_GLOBAL: config }, encoding: 'utf8', windowsHide: true }); assert.equal(r.status, 0, r.stderr); };
  plain(fx.repo.root, ['-c', 'core.hooksPath=' + slash(path.join(fx.repo.root, 'empty-hooks')), 'clone', '--quiet', '--shared', '--no-checkout', '--', fx.repo.cwd, control]);
  plain(control, ['-c', 'core.hooksPath=' + slash(path.join(fx.repo.root, 'empty-hooks')), 'checkout', '--quiet', '--detach', fx.base]);
  assert.equal(fs.existsSync(marker), false);
  plain(control, ['checkout', '--quiet', fx.b.proven, '--', 'tests/half.test.cjs']);
  assert.match(fs.readFileSync(marker, 'utf8'), /post-checkout/, 'the path checkout runs the configured hook where nothing stops it');
  fs.rmSync(marker);
  assert.deepEqual(cli(fx, args(fx, fx.moved, 'fix-proven', 'hooks.log'), { GIT_CONFIG_GLOBAL: config }), { code: 0, line: 'PROVEN (1 of 3 fail: half halves)' });
  assert.equal(fs.existsSync(marker), false, "no leg of the tool's checkout ran a hook");
});

test('usage: a log inside the repository, a missing flag, and --help', async t => {
  const fx = fixture(t), { failingOnBaseCli } = await api();
  const inRepo = await isolated(fx, () => failingOnBaseCli(['--repo', fx.repo.cwd, '--base', 'main', '--batch', 'fix-proven', '--validate', fx.json('v.json', specOf()), '--log', path.join(fx.repo.cwd, 'x.log')]));
  assert.deepEqual(inRepo, { code: 2, line: `UNKNOWN usage: --log must lie outside the repository ${fx.repo.cwd}` });
  assert.equal(fs.existsSync(path.join(fx.repo.cwd, 'x.log')), false);
  const missing = await failingOnBaseCli(['--repo', fx.repo.cwd, '--base', 'main']);
  assert.deepEqual(missing, { code: 2, line: 'UNKNOWN usage: unknown, missing or duplicate flag; use --help' });
  const help = await failingOnBaseCli(['--help']);
  assert.equal(help.code, 0);
  assert.ok(help.line.startsWith('failing-on-base.mjs --repo <repo> --base <ref-or-sha> --batch <ref-or-sha> --validate <validate.json> --log <path> [--setup <setup.json>] [--timeout <seconds>]\n'));
});

// ===== The pure core ==================================================================================
test('test paths: by segment or by name, both sides of each pattern', async () => {
  const { isTestPath } = await api();
  const tests = ['test/a.js', 'src/tests/a.rs', 'a/__tests__/b.tsx', 'spec/a.rb', 'x/specs/y.rb', 'tests', 'a.test.js', 'src/a.spec.ts', 'pkg/a_test.go', 'a_spec.rb', 'test_a.py', 'd/test_x.cfg', '.test.x'];
  const production = ['src/a.js', 'latest/a.js', 'testing/a.js', 'contest.js', 'a.test', 'a_test', 'mytest_a.py', 'test_a', 'attest.js', 'spec.js', 'specs.md/x', 'a.tests.js'];
  for (const p of tests) assert.equal(isTestPath(p), true, p);
  for (const p of production) assert.equal(isTestPath(p), false, p);
});

test('test markers in added lines: each marker, and the calls that only look like one', async () => {
  const { hasTestMarker, addedLines } = await api();
  const marked = ['#[test]', '#[cfg(test)]', 'def test_half():', 'func TestHalf(t *testing.T) {', "test('x', () => {})", "  it('x', f)", "describe('x', f)", '(test(1))', "x = [it('y')]"];
  const plain = ["s.split(' ')", '/x/.test(w)', 'process.exit(1)', '$test(1)', 'my_test(1)', 'obj.it(1)', 'submit(1)', 'retest(1)', 'describer(1)', 'test (1)', 'def testhalf():'];
  for (const text of marked) assert.equal(hasTestMarker(text), true, text);
  for (const text of plain) assert.equal(hasTestMarker(text), false, text);
  const diff = lines('diff --git a/x b/x', '--- a/x', '+++ b/x', '@@ -1 +1,2 @@', '-old', '+new one', '++ doubled', ' context');
  assert.deepEqual(addedLines(diff), ['new one', '+ doubled'], 'the file header is not an added line; a line starting ++ inside a hunk is');
  assert.deepEqual(addedLines(lines('Binary files a/x and b/x differ')), []);
});

const step = (over = {}) => ({ name: 'tests', result: 'PASS', passed: 2, failed: 0, skipped: 0, total: 2, names: [], loadFailures: [], emptyFiles: [], exit: 0, ...over });
test('the verdict for every step result, and the line a name cannot break', async () => {
  const { verdict } = await api();
  assert.deepEqual(verdict({ status: 'PASS', steps: [step(), step({ name: 'diff', result: 'PASS', passed: null, failed: null, total: null })] }), { code: 1, line: 'ALL-PASS (P0)' });
  assert.deepEqual(verdict({ status: 'PASS', steps: [step()] }, ['a.rs']), { code: 1, line: 'ALL-PASS (P0; mixed, left to review: a.rs)' });
  const fail = step({ result: 'FAIL', passed: 1, failed: 2, total: 3, names: ['one', 'two'] });
  assert.deepEqual(verdict({ status: 'FAIL', steps: [fail, step({ name: 'more', passed: 4, total: 4 })] }), { code: 0, line: 'PROVEN (2 of 7 fail: one, two)' });
  const names = Array.from({ length: 11 }, (_, i) => 'n' + i);
  assert.equal(verdict({ status: 'FAIL', steps: [step({ result: 'FAIL', passed: 0, failed: 11, total: 11, names })] }).line, `PROVEN (11 of 11 fail: ${names.slice(0, 10).join(', ')}, …)`);
  assert.equal(verdict({ status: 'FAIL', steps: [step({ result: 'FAIL', passed: 0, failed: 10, total: 10, names: names.slice(0, 10) })] }).line, `PROVEN (10 of 10 fail: ${names.slice(0, 10).join(', ')})`);
  for (const result of ['NO-TESTS', 'CRASHED', 'NO-SUMMARY', 'TIMEOUT']) {
    assert.deepEqual(verdict({ status: 'FAIL', steps: [fail, step({ name: 'later', result })] }), { code: 2, line: `INCONCLUSIVE (${result}: later)` }, result);
  }
  assert.deepEqual(verdict({ status: 'UNKNOWN', steps: [step({ result: 'COULD-NOT-START' })] }), { code: 2, line: 'INCONCLUSIVE (COULD-NOT-START: tests)' });
  assert.deepEqual(verdict({ status: 'FAIL', steps: [step({ result: 'FAIL', passed: 2, failed: 0, total: 2 })] }), { code: 2, line: 'INCONCLUSIVE (no failing test named: tests)' });
  assert.deepEqual(verdict({ status: 'FAIL', steps: [step({ result: 'FAIL', passed: null, failed: null, total: null, exit: 1 })] }), { code: 2, line: 'INCONCLUSIVE (no failing test named: tests)' }, 'a parser-none step that fails');
  assert.deepEqual(verdict({ status: 'FAIL', steps: [step({ result: 'FAIL', failed: 1, names: ['x'] })] }, ['m.go']).line, 'PROVEN (1 of 3 fail: x; mixed, left to review: m.go)');
  assert.deepEqual(verdict({ status: 'PASS', steps: [] }), { code: 2, line: 'INCONCLUSIVE (no step ran)' });
  assert.deepEqual(verdict({ status: 'FAIL', steps: [fail, step({ name: 'later', result: 'TIMEOUT' })] }, ['a.rs']), { code: 2, line: 'INCONCLUSIVE (TIMEOUT: later; mixed, left to review: a.rs)' });
  // Both sides of a named failure: a count with no name, and a name with no count.
  assert.deepEqual(verdict({ status: 'FAIL', steps: [step({ result: 'FAIL', passed: 1, failed: 1, total: 2, names: [] })] }), { code: 2, line: 'INCONCLUSIVE (no failing test named: tests)' });
  assert.deepEqual(verdict({ status: 'FAIL', steps: [step({ result: 'FAIL', passed: 2, failed: 0, total: 2, names: ['x'] })] }), { code: 2, line: 'INCONCLUSIVE (no failing test named: tests)' });
  // A name failing in two steps is listed once, and counted in each.
  assert.deepEqual(verdict({ status: 'FAIL', steps: [fail, step({ name: 'again', result: 'FAIL', passed: 0, failed: 1, total: 1, names: ['one'] })] }), { code: 0, line: 'PROVEN (3 of 4 fail: one, two)' });
  // Every file named, each of its separators, prints as /; a test's name prints as written.
  const loadWin = step({ result: 'FAIL', passed: 1, failed: 2, total: 3, names: ['tests\\a.test.cjs', 'tests\\sub\\b.test.cjs'], loadFailures: ['tests\\a.test.cjs', 'tests\\sub\\b.test.cjs'] });
  const emptyWin = step({ result: 'FAIL', passed: 1, failed: 1, total: 2, names: ['tests\\sub\\e.test.cjs'], loadFailures: ['tests\\sub\\e.test.cjs'], emptyFiles: ['tests\\sub\\e.test.cjs'] });
  assert.deepEqual([verdict({ status: 'FAIL', steps: [loadWin] }).line, verdict({ status: 'FAIL', steps: [emptyWin] }).line],
    ['INCONCLUSIVE (load error: tests/a.test.cjs, tests/sub/b.test.cjs)', 'INCONCLUSIVE (ran no tests: tests/sub/e.test.cjs)']);
  const empties = ['tests\\sub\\e.test.cjs', 'tests\\f.test.cjs'];
  assert.equal(verdict({ status: 'FAIL', steps: [step({ result: 'FAIL', passed: 0, failed: 2, total: 2, names: empties, loadFailures: empties, emptyFiles: empties })] }).line, 'INCONCLUSIVE (ran no tests: tests/sub/e.test.cjs, tests/f.test.cjs)');
  assert.equal(verdict({ status: 'FAIL', steps: [step({ result: 'FAIL', failed: 1, names: ['parses C:\\x'] })] }).line, 'PROVEN (1 of 3 fail: parses C:\\x)');
  // The rest of an INCONCLUSIVE line prints as written: a mixed path, and a step name on every branch that names one.
  assert.equal(verdict({ status: 'FAIL', steps: [loadWin] }, ['lib\\m.rs']).line, 'INCONCLUSIVE (load error: tests/a.test.cjs, tests/sub/b.test.cjs; mixed, left to review: lib\\m.rs)');
  assert.equal(verdict({ status: 'FAIL', steps: [step({ name: 'unit\\win', result: 'TIMEOUT' })] }, ['lib/a\\b.cjs']).line, 'INCONCLUSIVE (TIMEOUT: unit\\win; mixed, left to review: lib/a\\b.cjs)');
  assert.equal(verdict({ status: 'FAIL', steps: [step({ name: 'unit\\win', result: 'FAIL', passed: 2, failed: 0, total: 2 })] }).line, 'INCONCLUSIVE (no failing test named: unit\\win)');
  assert.equal(verdict({ status: 'UNKNOWN', steps: [step({ name: 'unit\\win', result: 'COULD-NOT-START' })] }).line, 'INCONCLUSIVE (COULD-NOT-START: unit\\win)');
  // A name holding a line break or a separator still gives one line prompt.mjs accepts.
  const broken = 'a' + String.fromCharCode(10) + 'b' + String.fromCharCode(0x2028) + 'c';
  assert.equal(isFact(broken), false, 'live control: the raw name is not a fact');
  const out = verdict({ status: 'FAIL', steps: [step({ result: 'FAIL', failed: 1, names: [broken] })] });
  assert.ok(isFact(out.line), out.line);
  assert.equal(out.line, 'PROVEN (1 of 3 fail: a?b?c)');
});
