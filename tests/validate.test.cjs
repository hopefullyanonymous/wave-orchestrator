'use strict';
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const api = import('../orchestrate/tools/validate.mjs');
const TOOL = path.join(__dirname, '..', 'orchestrate', 'tools', 'validate.mjs');
// Built, never written literally: a literal ESC or BEL byte fails the invisible-character sweep.
const ESC = String.fromCharCode(27), BEL = String.fromCharCode(7), BOM = String.fromCharCode(0xfeff);
const NODE = process.execPath;
// validate.mjs's own ANSI pattern (not exported), for reading a child's raw log by text: a suite
// run from a colour terminal hands FORCE_COLOR on to the child, whose spec reporter then paints.
const ANSI = /\u001b(?:\[[0-?]*[ -\/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[ -\/]+[0-~]|[@-Z\\-_])/g;
const stripAnsi = text => text.replace(ANSI, '');
const lines = (...l) => l.join('\n');
const slashes = p => p.replace(/[\\/]+/g, '/');

function tmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'validate-'));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* a killed process may still hold a handle */ } });
  return dir;
}
function cleanEnv(extra = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.toUpperCase() === 'NODE_TEST_CONTEXT') delete env[key];
  return { ...env, ...extra };
}
// Everything that can break or hide a line: C0, DEL, C1 (NEL included) and U+2028/U+2029.
const BREAKERS = [...Array.from({ length: 0x20 }, (_, i) => i), ...Array.from({ length: 0x21 }, (_, i) => 0x7f + i), 0x2028, 0x2029]
  .map(c => String.fromCharCode(c));
const leaksBreaker = text => BREAKERS.some(b => text.includes(b));
// Every CLI call asserts the single-line contract, then hands back the FIRST line alone.
function cli(args, { env = cleanEnv(), cwd } = {}) {
  const started = Date.now();
  const r = spawnSync(NODE, [TOOL, ...args], { encoding: 'utf8', env, cwd, timeout: 120000 });
  assert.equal(r.error, undefined, 'the CLI itself must run');
  assert.ok(r.stdout.length > 1 && r.stdout.endsWith('\n') && !leaksBreaker(r.stdout.slice(0, -1)), 'stdout must be exactly one line: ' + JSON.stringify(r.stdout));
  return { code: r.status, line: r.stdout.split('\n')[0], ms: Date.now() - started };
}
function fake(dir, file, transcript, code = 0) {
  const script = path.join(dir, file);
  fs.writeFileSync(script, `process.stdout.write(${JSON.stringify(transcript)});\nprocess.exitCode = ${code};\n`);
  return [NODE, script];
}
function writeSpec(dir, steps, file = 'spec.json') {
  const f = path.join(dir, file);
  fs.writeFileSync(f, JSON.stringify({ steps }));
  return f;
}
function run(t, steps, extra = [], env = cleanEnv()) {
  const dir = tmp(t), log = path.join(dir, 'out', 'validate.log');
  const result = cli(['--spec', writeSpec(dir, steps), '--log', log, ...extra], { env });
  return { ...result, dir, logPath: log, log: fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : null };
}
const isAlive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

// ---------------------------------------------------------------------------------------
// Transcripts. Each parser has PASS and FAIL cases; the node shapes mirror what the real
// reporters print (proved separately by the live controls below).
const nodeSummary = (mark, c) => lines(`${mark} tests ${c.tests}`, `${mark} suites ${c.suites || 0}`, `${mark} pass ${c.pass}`,
  `${mark} fail ${c.fail}`, `${mark} cancelled ${c.cancelled || 0}`, `${mark} skipped ${c.skipped || 0}`, `${mark} todo ${c.todo || 0}`, `${mark} duration_ms 9.5`);
const NODE_SPEC_PASS = lines('✔ alpha works (1.2ms)', '✔ beta works (0.5ms)', nodeSummary('ℹ', { tests: 2, pass: 2, fail: 0 }));
const NODE_SPEC_FAIL = lines(
  '✔ node spec keeps passing (1.2ms)',
  '▶ node suite',
  '  ✖ node nested spec failure (0.1ms)',
  '✖ node suite (0.2ms)',
  '✖ node spec failure (0.4ms)',
  '✖ node todo failure (0.1ms) # TODO',
  nodeSummary('ℹ', { tests: 4, suites: 1, pass: 1, fail: 2, todo: 1 }),
  '',
  '✖ failing tests:',
  '',
  'test at tests/a.test.cjs:5:3',
  '✖ node nested spec failure (0.1ms)',
  '  Error: boom',
  '',
  'test at tests/a.test.cjs:9:1',
  '✖ node spec failure (0.4ms)',
  '  AssertionError: 1 == 2',
  '',
  'test at tests/a.test.cjs:12:1',
  '✖ node todo failure (0.1ms) # TODO',
  '  Error: t');
// The real spec shape for a file that fails to load: absolute name, cwd-relative location.
const NODE_SPEC_LOAD = lines(
  '✖ C:\\work\\tests\\broken.test.cjs (40.1ms)',
  '✖ parses x.test.cjs (1ms)',
  nodeSummary('ℹ', { tests: 2, pass: 0, fail: 2 }),
  '',
  '✖ failing tests:',
  '',
  'test at tests\\broken.test.cjs:1:1',
  '✖ C:\\work\\tests\\broken.test.cjs (40.1ms)',
  "  'test failed'",
  '',
  'test at tests\\x.test.cjs:3:1',
  '✖ parses x.test.cjs (1ms)',
  '  Error: nope');
// Without a trailing block every inline failure line is taken, and a file-named entry
// without a location is judged by its name alone.
const NODE_SPEC_INLINE = lines(
  '✔ fine (1ms)',
  '✖ tests/broken.test.cjs (30ms)',
  '✖ inline only failure (2ms)',
  '✖ inline only failure (2ms)',
  '  ✖ nested inline failure (1ms)',
  nodeSummary('ℹ', { tests: 4, pass: 1, fail: 3 }));
const NODE_TAP_PASS = lines('TAP version 13', '# Subtest: tap passes', 'ok 1 - tap passes', '  ---', '  duration_ms: 0.5', "  type: 'test'", '  ...',
  '1..1', nodeSummary('#', { tests: 1, pass: 1, fail: 0 }));
const NODE_TAP_FAIL = lines(
  'TAP version 13',
  '# tests 99',
  '# Subtest: tap parent',
  '    # Subtest: tap nested failure',
  '    not ok 1 - tap nested failure',
  '      ---',
  "      type: 'test'",
  "      location: '/work/tests/a.test.cjs:3:5'",
  "      failureType: 'testCodeFailure'",
  '      ...',
  '    1..1',
  'not ok 1 - tap parent',
  '  ---',
  "  type: 'test'",
  "  location: '/work/tests/a.test.cjs:2:1'",
  "  failureType: 'subtestsFailed'",
  '  ...',
  '# Subtest: tap suite',
  'not ok 2 - tap suite',
  '  ---',
  "  type: 'suite'",
  "  failureType: 'hookFailed'",
  '  ...',
  'not ok 3 - tap \\# hashed failure',
  '  ---',
  "  type: 'test'",
  "  location: '/work/tests/a.test.cjs:9:1'",
  '  ...',
  'not ok 4 - tap todo failure # TODO',
  'ok 5 - tap passes',
  'not ok 6 - tap cancelled',
  '  ---',
  "  type: 'test'",
  "  failureType: 'testTimeoutFailure'",
  '  ...',
  'not ok 7 - tap skip directive # SKIP',
  'not ok 8 - tap lowercase directive # skip',
  '1..8',
  nodeSummary('#', { tests: 8, suites: 1, pass: 1, fail: 3, cancelled: 1, skipped: 2, todo: 1 }));
const NODE_TAP_LOAD = lines(
  'TAP version 13',
  'not ok 1 - C:\\\\work\\\\tests\\\\broken.test.cjs',
  '  ---',
  "  type: 'test'",
  "  location: 'C:\\\\work\\\\tests\\\\broken.test.cjs:1:1'",
  '  ...',
  'not ok 2 - parses broken.test.cjs',
  '  ---',
  "  type: 'test'",
  "  location: 'C:\\\\work\\\\tests\\\\other.test.cjs:4:1'",
  '  ...',
  '1..2',
  nodeSummary('#', { tests: 2, pass: 0, fail: 2 }));
const JEST_PASS = lines('PASS src/sum.test.js', '  sum', '    ✓ adds (2 ms)', '', 'Test Suites: 1 passed, 1 total',
  'Tests:       2 passed, 2 total', 'Snapshots:   0 total', 'Time:        0.512 s', 'Ran all test suites.');
const JEST_FAIL = lines(
  'FAIL src/math.test.js',
  '  math',
  '    ✓ adds (1 ms)',
  '    ✕ subtracts (4 ms)',
  '',
  '  ● math › subtracts',
  '',
  '    expect(received).toBe(expected) // Object.is equality',
  '',
  'Summary of all failing tests',
  'FAIL src/math.test.js',
  '  ● math › subtracts',
  '',
  'Test Suites: 1 failed, 1 total',
  'Tests:       1 failed, 1 skipped, 1 passed, 3 total');
const JEST_LOAD = lines('FAIL src/broken.test.js', '  ● Test suite failed to run', '', '    SyntaxError: Unexpected token (3:1)', '',
  'Test Suites: 1 failed, 1 total', 'Tests:       0 total');
const PYTEST_PASS = lines(
  '============================= test session starts ==============================',
  'collected 4 items / 1 deselected / 3 selected',
  '',
  'tests/test_app.py ...                                                    [100%]',
  '',
  '=================== 3 passed, 1 deselected, 2 warnings in 0.50s ===================');
const PYTEST_FAIL = lines(
  'tests/test_app.py F.sE                                                   [100%]',
  '',
  '=================================== FAILURES ===================================',
  '___________________________ test_pytest_fails[a - b] ___________________________',
  'E   assert 1 == 2',
  '=========================== short test summary info ============================',
  'FAILED tests/test_app.py::test_pytest_fails[a - b] - assert 1 == 2',
  'ERROR tests/test_app.py::test_fixture_breaks - RuntimeError: fixture',
  '========== 1 failed, 1 passed, 1 skipped, 1 error in 0.12s (0:00:00) ==========');
const PYTEST_LOAD = lines(
  '==================================== ERRORS ====================================',
  '____________________ ERROR collecting tests/test_broken.py _____________________',
  'E   SyntaxError: invalid syntax',
  '=========================== short test summary info ============================',
  'ERROR tests/test_broken.py - SyntaxError: invalid syntax',
  '!!!!!!!!!!!!!!!!!!!! Interrupted: 1 error during collection !!!!!!!!!!!!!!!!!!!!',
  '=============================== 1 error in 0.10s ===============================');
const PYTEST_EMPTY = '============================ no tests ran in 0.01s =============================';
const CARGO_PASS = lines(
  'running 2 tests',
  'test tests::adds ... ok',
  'test tests::ignored_one ... ignored',
  '',
  'test result: ok. 1 passed; 0 failed; 1 ignored; 0 measured; 0 filtered out; finished in 0.00s',
  '',
  '   Doc-tests demo',
  '',
  'running 0 tests',
  '',
  'test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s');
const CARGO_FAIL = lines(
  'running 3 tests',
  'test tests::adds ... ok',
  'test tests::cargo_fails ... FAILED',
  'test tests::skipped ... ignored',
  '',
  'failures:',
  '',
  '---- tests::cargo_fails stdout ----',
  "thread 'tests::cargo_fails' panicked at src/lib.rs:10:9:",
  '',
  'failures:',
  '    tests::cargo_fails',
  '',
  'test result: FAILED. 1 passed; 1 failed; 1 ignored; 0 measured; 0 filtered out; finished in 0.00s',
  '',
  'running 1 test',
  'test src/lib.rs - doc (line 3) ... FAILED',
  '',
  'test result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.20s');
// Location-less entries: every script extension is a load failure, anything else is not, and
// only millisecond durations are the reporter's.
const SCRIPT_NAMES = ['a/one.test.js', 'two.test.mjs', 'three.test.cjs', 'four.test.ts', 'five.test.mts', 'six.test.cts', 'seven.test.tsx', 'eight.test.jsx'];
const NODE_SPEC_SCRIPTS = lines(...[...SCRIPT_NAMES, 'nine.test.json', 'ten.js.map'].map(n => `✖ ${n} (3ms)`), '✖ in seconds (1.5s)',
  nodeSummary('ℹ', { tests: 11, pass: 0, fail: 11 }));
const JEST_TOKENS = lines('PASS src/t.test.js', 'Tests:       1 skipped, 2 todo, 1 pending, 3 passed, 7 total');
// A plugin item can fail under a bare file name: FAILED, so a failure but never a load failure.
const PYTEST_TOKENS = lines('FAILED checks/lint.py', 'ERROR tests/test_t.py::test_a - boom',
  '== 1 failed, 2 passed, 1 xfailed, 1 xpassed, 2 errors, 1 warning, 1 rerun in 1.00s ==');
const CARGO_NO_TIME = 'test result: ok. 3 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out';
// Skipped and todo tests count in the total but neither pass nor fail (shapes as node prints them).
const NODE_SPEC_SKIPS = lines('✔ runs (0.4ms)', '﹣ skipped here (0.4ms) # Windows only', '✔ todo passing (0.1ms) # TODO', '⚠ todo failing (0.1ms) # TODO',
  nodeSummary('ℹ', { tests: 4, pass: 1, fail: 0, skipped: 1, todo: 2 }));
// A file that registers no tests is ONE passing top-level entry named after the file, relative,
// absolute or discovered. With no whitespace before its first separator, a name is file-shaped:
// absolute paths holding a space later are file-shaped. The entries follow a parent test with a
// child, the position most empty files hold in a real run.
// A space in the file's OWN name is file-shaped too, discovered or absolute.
const EMPTY_NAMES = ['empty.test.cjs', 'C:\\Users\\Jo Ann\\proj\\test\\gone.test.mjs', '/home/Jo Ann/proj/test/deep.test.cjs', 'test/sub/none.test.ts',
  'test/my data.test.cjs', 'C:\\proj\\my file.test.mjs'];
const NODE_SPEC_EMPTY = lines('▶ parent', '  ✔ child (0.1ms)', '✔ parent (0.3ms)', ...EMPTY_NAMES.map(n => `✔ ${n} (21.5ms)`), '✔ real one (0.4ms)',
  nodeSummary('ℹ', { tests: 9, pass: 9, fail: 0 }));
const tapEntry = (n, name, extra = []) => [`# Subtest: ${name}`, `ok ${n} - ${name.replace(/\\/g, '\\\\')}`, '  ---', '  duration_ms: 0.4', ...extra, "  type: 'test'", '  ...'];
const TAP_PARENT = ['# Subtest: parent', '    # Subtest: child', '    ok 1 - child', '      ---', "      type: 'test'", '      ...', '    1..1',
  'ok 1 - parent', '  ---', "  type: 'test'", '  ...'];
const NODE_TAP_EMPTY = lines('TAP version 13', ...TAP_PARENT, ...EMPTY_NAMES.flatMap((name, i) => tapEntry(i + 2, name)), ...tapEntry(8, 'real one'), '1..8',
  nodeSummary('#', { tests: 9, pass: 9, fail: 0 }));
// The other side of the signature: file-shaped names that are NOT empty files — a nested test, a
// suite or parent test (children), a directive (skip and todo), a file name without a script
// extension, sentences ending in a file name, and two real titles of the Shipping App suite whose
// last word is a path.
const REAL_TITLES = ['settings-view: the hardcoded kind names and basenames match src/shared/data-files.js',
  'no console.* diagnostic survives anywhere in src/main outside logger.js'];
const NODE_SPEC_NOT_EMPTY = lines(
  '▶ validate.mjs', '  ✔ nested.test.cjs (0.2ms)', '✔ validate.mjs (0.5ms)',
  '▶ helpers.mjs', '  ✔ inner (0.2ms)', '✔ helpers.mjs (0.4ms)',
  '﹣ skipped.test.cjs (0.1ms) # SKIP', '✔ todo.test.cjs (0.1ms) # TODO', '✔ parses config.test.js (0.3ms)', '✔ plain (0.1ms)',
  ...REAL_TITLES.map(t => `✔ ${t} (0.3ms)`), '✔ package.json (0.1ms)',
  nodeSummary('ℹ', { tests: 10, suites: 1, pass: 8, fail: 0, skipped: 1, todo: 1 }));
const NODE_TAP_NOT_EMPTY = lines('TAP version 13',
  '# Subtest: validate.mjs', '    # Subtest: nested.test.cjs', '    ok 1 - nested.test.cjs', '      ---', "      type: 'test'", '      ...', '    1..1',
  'ok 1 - validate.mjs', '  ---', "  type: 'suite'", '  ...',
  '# Subtest: helpers.mjs', '    # Subtest: inner', '    ok 1 - inner', '      ---', "      type: 'test'", '      ...', '    1..1',
  'ok 2 - helpers.mjs', '  ---', "  type: 'test'", '  ...',
  '# Subtest: skipped.test.cjs', 'ok 3 - skipped.test.cjs # SKIP', '  ---', "  type: 'test'", '  ...',
  ...tapEntry(4, 'parses config.test.js'), '# Subtest: empty-suite.mjs', 'ok 5 - empty-suite.mjs', '  ---', "  type: 'suite'", '  ...',
  ...tapEntry(6, REAL_TITLES[0]), ...tapEntry(7, REAL_TITLES[1]), ...tapEntry(8, 'package.json'),
  '# Subtest: todo.test.cjs', 'ok 9 - todo.test.cjs # TODO', '  ---', "  type: 'test'", '  ...',
  '1..9', nodeSummary('#', { tests: 9, suites: 2, pass: 7, fail: 0, skipped: 1, todo: 1 }));

const ok = (passed, total, skipped = 0) => ({ summary: true, passed, failed: 0, skipped, total, names: [], loadFailures: [], emptyFiles: [] });
const bad = (passed, failed, skipped, total, names, loadFailures = [], emptyFiles = []) => ({ summary: true, passed, failed, skipped, total, names, loadFailures, emptyFiles });
const CASES = [
  { parser: 'node', label: 'spec pass', text: NODE_SPEC_PASS, expect: ok(2, 2) },
  { parser: 'node', label: 'spec fail', text: NODE_SPEC_FAIL, expect: bad(1, 2, 1, 4, ['node nested spec failure', 'node spec failure']) },
  { parser: 'node', label: 'spec load failure', text: NODE_SPEC_LOAD, expect: bad(0, 2, 0, 2, ['C:\\work\\tests\\broken.test.cjs', 'parses x.test.cjs'], ['C:\\work\\tests\\broken.test.cjs']) },
  { parser: 'node', label: 'spec inline only', text: NODE_SPEC_INLINE, expect: bad(1, 3, 0, 4, ['tests/broken.test.cjs', 'inline only failure', 'nested inline failure'], ['tests/broken.test.cjs']) },
  { parser: 'node', label: 'tap pass', text: NODE_TAP_PASS, expect: ok(1, 1) },
  { parser: 'node', label: 'tap fail', text: NODE_TAP_FAIL, expect: bad(1, 4, 3, 8, ['tap nested failure', 'tap # hashed failure', 'tap cancelled']) },
  { parser: 'node', label: 'spec script-named entries without location', text: NODE_SPEC_SCRIPTS, expect: bad(0, 11, 0, 11, [...SCRIPT_NAMES, 'nine.test.json', 'ten.js.map'], SCRIPT_NAMES) },
  { parser: 'node', label: 'tap load failure', text: NODE_TAP_LOAD, expect: bad(0, 2, 0, 2, ['C:\\work\\tests\\broken.test.cjs', 'parses broken.test.cjs'], ['C:\\work\\tests\\broken.test.cjs']) },
  { parser: 'node', label: 'spec skipped and todo', text: NODE_SPEC_SKIPS, expect: ok(1, 4, 3) },
  { parser: 'node', label: 'spec file entries that are not empty files', text: NODE_SPEC_NOT_EMPTY, expect: ok(8, 10, 2) },
  { parser: 'node', label: 'tap file entries that are not empty files', text: NODE_TAP_NOT_EMPTY, expect: ok(7, 9, 2) },
  { parser: 'node', label: 'spec empty files', text: NODE_SPEC_EMPTY, expect: bad(3, 6, 0, 9, EMPTY_NAMES, EMPTY_NAMES, EMPTY_NAMES) },
  { parser: 'node', label: 'tap empty files', text: NODE_TAP_EMPTY, expect: bad(3, 6, 0, 9, EMPTY_NAMES, EMPTY_NAMES, EMPTY_NAMES) },
  { parser: 'jest', label: 'pass', text: JEST_PASS, expect: ok(2, 2) },
  { parser: 'jest', label: 'fail', text: JEST_FAIL, expect: bad(1, 1, 1, 3, ['math › subtracts']) },
  { parser: 'jest', label: 'suite failed to run', text: JEST_LOAD, expect: bad(0, 1, 0, 1, ['src/broken.test.js'], ['src/broken.test.js']) },
  { parser: 'jest', label: 'skipped, todo and pending tokens', text: JEST_TOKENS, expect: ok(3, 7, 4) },
  { parser: 'pytest', label: 'pass', text: PYTEST_PASS, expect: ok(3, 3) },
  { parser: 'pytest', label: 'no tests ran', text: PYTEST_EMPTY, expect: ok(0, 0) },
  { parser: 'pytest', label: 'fail', text: PYTEST_FAIL, expect: bad(1, 2, 1, 4, ['tests/test_app.py::test_pytest_fails[a - b]', 'tests/test_app.py::test_fixture_breaks']) },
  { parser: 'pytest', label: 'collection error', text: PYTEST_LOAD, expect: bad(0, 1, 0, 1, ['tests/test_broken.py'], ['tests/test_broken.py']) },
  { parser: 'pytest', label: 'every other token', text: PYTEST_TOKENS, expect: bad(2, 3, 2, 7, ['checks/lint.py', 'tests/test_t.py::test_a']) },
  { parser: 'cargo', label: 'pass', text: CARGO_PASS, expect: ok(1, 2, 1) },
  { parser: 'cargo', label: 'fail', text: CARGO_FAIL, expect: bad(1, 2, 1, 4, ['tests::cargo_fails', 'src/lib.rs - doc (line 3)']) },
  { parser: 'cargo', label: 'result line without a finish time', text: CARGO_NO_TIME, expect: ok(3, 3) },
];
// Text that resembles a summary but is not one must never count as one (fail closed).
const NOT_SUMMARIES = [
  { parser: 'node', label: 'spec summary missing its suites line', text: lines('ℹ tests 2', 'ℹ pass 2', 'ℹ fail 0', 'ℹ cancelled 0', 'ℹ skipped 0', 'ℹ todo 0') },
  { parser: 'node', label: 'a lone printed "# tests 99"', text: lines('# tests 99', 'ok 1 - x') },
  { parser: 'jest', label: 'unknown jest token', text: 'Tests:       2 exploded, 2 total' },
  { parser: 'pytest', label: 'unknown pytest token', text: '=== 1 passed, 2 bananas in 0.10s ===' },
  { parser: 'cargo', label: 'cargo line missing its counts', text: 'test result: ok. 1 passed; finished in 0.00s' },
];
const ANSI_KINDS = {
  csi: l => `${ESC}[1m${ESC}[31m${l}${ESC}[39m${ESC}[22m`,
  'osc-bel': l => `${ESC}]0;title${BEL}${l}`,
  'osc-st': l => `${ESC}]8;;https://example.test${ESC}\\${l}${ESC}]8;;${ESC}\\`,
  nf: l => `${ESC}(B${l}`,
  fe: l => `${ESC}M${l}`,
};
const paint = (text, kind) => text.split('\n').map(l => l ? ANSI_KINDS[kind](l) : l).join('\n');

test('runSpec and parseRunnerOutput are exported with the documented shapes', async t => {
  const { runSpec, parseRunnerOutput } = await api;
  assert.equal(typeof runSpec, 'function');
  assert.equal(typeof parseRunnerOutput, 'function');
  assert.deepEqual(Object.keys(parseRunnerOutput('node', '')).sort(), ['emptyFiles', 'failed', 'loadFailures', 'names', 'passed', 'skipped', 'summary', 'total']);
  assert.deepEqual(parseRunnerOutput('none', NODE_SPEC_PASS), { summary: false, passed: null, failed: null, skipped: null, total: null, names: [], loadFailures: [], emptyFiles: [] });
  assert.throws(() => parseRunnerOutput('mocha', NODE_SPEC_PASS), /Unknown parser/);
  const dir = tmp(t), logPath = path.join(dir, 'log.txt');
  const pending = runSpec({ steps: [{ name: 'one', argv: fake(dir, 'ok.js', NODE_SPEC_FAIL, 1), parser: 'node' }] }, { cwd: dir, logPath });
  assert.ok(pending instanceof Promise, 'runSpec is async');
  const result = await pending;
  assert.deepEqual(Object.keys(result).sort(), ['line', 'status', 'steps']);
  assert.deepEqual(result.steps.map(s => Object.keys(s).sort()), [['emptyFiles', 'exit', 'failed', 'loadFailures', 'name', 'names', 'passed', 'result', 'skipped', 'total']]);
  assert.deepEqual(result.steps[0], { name: 'one', result: 'FAIL', passed: 1, failed: 2, skipped: 1, total: 4, names: ['node nested spec failure', 'node spec failure'], loadFailures: [], emptyFiles: [], exit: 1 });
  assert.equal(result.status, 'FAIL');
  assert.equal(result.line, `FAIL one 2 of 4 failed, 1 skipped: node nested spec failure, node spec failure — log: ${logPath}`);
  const noLog = await runSpec({ steps: [{ name: 'one', argv: [NODE, '-e', ''], parser: 'none' }] }, { cwd: dir });
  assert.equal(noLog.status, 'UNKNOWN');
  assert.equal(noLog.line, 'UNKNOWN a log path is required');
  assert.deepEqual(noLog.steps, [], 'without a log path nothing runs');
  // Both sides of setTimeout's ceiling (2^31-1 ms): above it Node would fire after 1 ms.
  for (const timeoutMs of [0, -5, Number.NaN, '1000', 2 ** 31, Number.POSITIVE_INFINITY]) {
    const bad = await runSpec({ steps: [{ name: 'one', argv: [NODE, '-e', ''], parser: 'none' }] }, { cwd: dir, logPath, timeoutMs });
    assert.equal(bad.line, 'UNKNOWN the timeout must be a positive number of ms, at most 2147483647', String(timeoutMs));
  }
  const ceiling = await runSpec({ steps: [{ name: 'one', argv: [NODE, '-e', ''], parser: 'none' }] }, { cwd: dir, logPath, timeoutMs: 2 ** 31 - 1 });
  assert.equal(ceiling.status, 'PASS', 'the ceiling itself is accepted and does not fire early');
});

test('the one line survives every control character and line separator in anything it echoes', async t => {
  const { runSpec } = await api;
  const dir = tmp(t), log = path.join(dir, 'x.log'), blocker = path.join(dir, 'a-file');
  fs.writeFileSync(blocker, '');
  const good = { steps: [{ name: 'a', argv: [NODE, '-e', ''], parser: 'none' }] };
  assert.equal(BREAKERS.length, 67);
  for (const breaker of BREAKERS) {
    const code = breaker.charCodeAt(0).toString(16);
    // In-process, NUL included: a log path under a plain file cannot be opened and is echoed.
    const r = await runSpec(good, { cwd: dir, logPath: path.join(blocker, `a${breaker}b.log`) });
    assert.match(r.line, /^UNKNOWN cannot open log .*a b\.log/, code);
    assert.equal(leaksBreaker(r.line), false, code);
    // Through the CLI for every breaker an OS argument can carry.
    if (breaker === String.fromCharCode(0)) continue;
    const viaCli = cli(['--spec', path.join(dir, `a${breaker}b.json`), '--log', log]);
    assert.equal(viaCli.code, 2, code);
    assert.match(viaCli.line, /^UNKNOWN cannot read spec .*a b\.json/, code);
  }
});

test('the PASS/FAIL line is guarded too: failing names and the log path never break it', async t => {
  const { runSpec } = await api;
  const dir = tmp(t), logPath = path.join(dir, 'names.log');
  const tap = name => lines('TAP version 13', `not ok 1 - ${name}`, '1..1', nodeSummary('#', { tests: 1, pass: 0, fail: 1 }));
  // \n and \r end the reporter's own line before the tool sees a name, so they cannot reach it.
  const inName = BREAKERS.filter(b => b !== '\n' && b !== '\r');
  assert.equal(inName.length, 65);
  for (const breaker of inName) {
    const code = breaker.charCodeAt(0).toString(16);
    const r = await runSpec({ steps: [{ name: 'tests', argv: fake(dir, 'n.js', tap(`a${breaker}b`), 1), parser: 'node' }] }, { cwd: dir, logPath });
    assert.equal(r.steps[0].names.length, 1, code);
    assert.ok(r.steps[0].names[0].includes(breaker), code + ': the raw name must really carry the breaker');
    assert.equal(leaksBreaker(r.line), false, code);
    assert.equal(r.line, `FAIL tests 1 of 1 failed: a b — log: ${logPath}`, code);
  }
  const sep = String.fromCharCode(0x2028), oddLog = path.join(dir, `x${sep}y.log`);
  const r = await runSpec({ steps: [{ name: 'red', argv: fake(dir, 'r.js', 'x\n', 1), parser: 'none' }] }, { cwd: dir, logPath: oddLog });
  assert.ok(fs.existsSync(oddLog), 'the log must really open under the separator-bearing name');
  assert.equal(r.line, `FAIL red exit 1 — log: ${oddLog.split(sep).join(' ')}`);
});

test('a log path that cannot be opened is UNKNOWN before anything runs', t => {
  const dir = tmp(t);
  const r = cli(['--spec', writeSpec(dir, [{ name: 'a', argv: [NODE, '-e', 'require("fs").writeFileSync("ran.txt", "")'], parser: 'none' }]), '--log', dir, '--cwd', dir]);
  assert.equal(r.code, 2);
  assert.match(r.line, /^UNKNOWN cannot open log .*\(E[A-Z]+\)$/);
  assert.equal(fs.existsSync(path.join(dir, 'ran.txt')), false);
});

test('an argument the OS cannot take is COULD-NOT-START, not a crash of the tool', t => {
  const r = run(t, [{ name: 'nul', argv: [NODE, 'a' + String.fromCharCode(0) + 'b'], parser: 'none' }]);
  assert.equal(r.code, 2);
  assert.equal(r.line, `UNKNOWN nul COULD-NOT-START (ERR_INVALID_ARG_VALUE) — log: ${r.logPath}`);
});

test('the parser corpus covers exactly the parsers the tool accepts, each with a pass and a named failure', () => {
  const help = spawnSync(NODE, [TOOL, '--help'], { encoding: 'utf8' });
  const declared = /parser: ([a-z |\r\n]+?)\./.exec(help.stdout);
  assert.ok(declared, 'the --help text must declare its parsers');
  const parsers = declared[1].split('|').map(s => s.trim());
  assert.ok(parsers.includes('none') && parsers.length === 5, 'declared parsers: ' + parsers);
  assert.deepEqual([...new Set(CASES.map(c => c.parser))].sort(), parsers.filter(p => p !== 'none').sort());
  for (const parser of parsers.filter(p => p !== 'none')) {
    assert.ok(CASES.some(c => c.parser === parser && c.expect.failed === 0 && c.expect.summary), parser + ' needs a PASS case');
    assert.ok(CASES.some(c => c.parser === parser && c.expect.failed > 0 && c.expect.names.length), parser + ' needs a FAIL-with-names case');
    assert.ok(NOT_SUMMARIES.some(c => c.parser === parser), parser + ' needs a not-a-summary case');
  }
});

test('every corpus transcript parses to its expected result', async () => {
  const { parseRunnerOutput } = await api;
  for (const c of CASES) assert.deepEqual(parseRunnerOutput(c.parser, c.text), c.expect, `${c.parser} ${c.label}`);
  for (const c of NOT_SUMMARIES) assert.equal(parseRunnerOutput(c.parser, c.text).summary, false, `${c.parser} ${c.label}`);
});

test('without a summary, an empty-file entry is still reported as a load failure', async () => {
  const { parseRunnerOutput } = await api;
  // A run that died before its summary: the entries it did print still name the empty file.
  for (const text of [lines('✔ gone.test.cjs (20ms)', '✔ real one (0.4ms)'), lines('TAP version 13', ...tapEntry(1, 'gone.test.cjs'))]) {
    assert.deepEqual(parseRunnerOutput('node', text), { summary: false, passed: null, failed: null, skipped: null, total: null,
      names: ['gone.test.cjs'], loadFailures: ['gone.test.cjs'], emptyFiles: ['gone.test.cjs'] }, text);
  }
});

test('each parser owns its cases: no other parser finds a summary in them', async () => {
  const { parseRunnerOutput } = await api;
  const parsers = [...new Set(CASES.map(c => c.parser))];
  for (const c of CASES) for (const other of parsers.filter(p => p !== c.parser)) {
    const r = parseRunnerOutput(other, c.text);
    assert.equal(r.summary, false, `${other} must not read ${c.parser} ${c.label} as a summary`);
    assert.notDeepEqual(r, c.expect);
  }
});

test('multiple summaries in one output are summed and names de-duplicated', async () => {
  const { parseRunnerOutput } = await api;
  for (const parser of [...new Set(CASES.map(c => c.parser))]) {
    const pass = CASES.find(c => c.parser === parser && c.expect.failed === 0), fail = CASES.find(c => c.parser === parser && c.expect.failed > 0);
    const r = parseRunnerOutput(parser, pass.text + '\n' + fail.text + '\n' + fail.text);
    const n = key => pass.expect[key] + 2 * fail.expect[key];
    assert.deepEqual(r, { summary: true, passed: n('passed'), failed: n('failed'), skipped: n('skipped'), total: n('total'), names: fail.expect.names, loadFailures: fail.expect.loadFailures, emptyFiles: [] }, parser);
  }
});

test('CRLF and LF transcripts produce identical results', async () => {
  const { parseRunnerOutput } = await api;
  for (const c of [...CASES, ...NOT_SUMMARIES]) {
    const crlf = c.text.replace(/\n/g, '\r\n');
    assert.ok(crlf.includes('\r\n') || !c.text.includes('\n'), 'the CRLF variant must really differ');
    assert.deepEqual(parseRunnerOutput(c.parser, crlf), parseRunnerOutput(c.parser, c.text), `${c.parser} ${c.label}`);
  }
  for (const c of CASES) assert.deepEqual(parseRunnerOutput(c.parser, c.text.replace(/\n/g, '\r\n')), c.expect, `${c.parser} ${c.label}`);
  // A lone CR (old line endings, progress redraws) ends a line too.
  for (const c of CASES) assert.deepEqual(parseRunnerOutput(c.parser, c.text.replace(/\n/g, '\r')), c.expect, `CR: ${c.parser} ${c.label}`);
});

test('ANSI-coloured output parses identically to plain output, for every kind of escape', async () => {
  const { parseRunnerOutput } = await api;
  for (const kind of Object.keys(ANSI_KINDS)) for (const c of CASES) {
    const coloured = paint(c.text, kind);
    assert.ok(coloured.includes(ESC) && coloured !== c.text, 'the coloured variant must carry escapes');
    assert.deepEqual(parseRunnerOutput(c.parser, coloured), c.expect, `${kind}: ${c.parser} ${c.label}`);
  }
});

test('skipped is every counted test that neither passed nor failed, in every corpus summary', async () => {
  const { parseRunnerOutput } = await api;
  // Each parser's own not-run kinds, one transcript each: a parser that drops a kind goes red.
  const KINDS = [
    ['node', nodeSummary('ℹ', { tests: 5, pass: 1, fail: 1, skipped: 2, todo: 1 }), 3],
    ['node', nodeSummary('#', { tests: 3, pass: 1, fail: 0, skipped: 0, todo: 2 }), 2],
    ['jest', 'Tests:       2 skipped, 1 passed, 3 total', 2],
    ['jest', 'Tests:       2 todo, 1 passed, 3 total', 2],
    ['jest', 'Tests:       2 pending, 1 passed, 3 total', 2],
    ['pytest', '=== 1 passed, 2 skipped in 0.10s ===', 2],
    ['pytest', '=== 1 passed, 2 xfailed in 0.10s ===', 2],
    ['pytest', '=== 1 passed, 2 xpassed in 0.10s ===', 2],
    ['pytest', '=== 1 passed, 5 deselected in 0.10s ===', 0],
    ['cargo', 'test result: ok. 1 passed; 0 failed; 2 ignored; 0 measured; 7 filtered out; finished in 0.00s', 2],
  ];
  for (const [parser, text, skipped] of KINDS) assert.equal(parseRunnerOutput(parser, text).skipped, skipped, `${parser}: ${text}`);
  for (const c of CASES) {
    const r = parseRunnerOutput(c.parser, c.text);
    assert.equal(r.passed + r.failed + r.skipped, r.total, `${c.parser} ${c.label}: passed + failed + skipped = total`);
  }
  assert.ok(CASES.filter(c => c.expect.skipped > 0).length >= 4, 'the invariant must see summaries with skips');
});

test('CRLF through the runner end to end matches LF', async t => {
  const { runSpec } = await api;
  const dir = tmp(t), results = [];
  for (const [label, text] of [['lf', NODE_SPEC_FAIL], ['crlf', NODE_SPEC_FAIL.replace(/\n/g, '\r\n')]]) {
    const r = await runSpec({ steps: [{ name: 'tests', argv: fake(dir, label + '.js', text, 1), parser: 'node' }] }, { cwd: dir, logPath: path.join(dir, label + '.log') });
    results.push(r.steps);
  }
  assert.ok(fs.readFileSync(path.join(dir, 'crlf.log'), 'utf8').includes('\r\n'), 'the CRLF run must really emit CRLF');
  assert.deepEqual(results[0], results[1]);
});

// ---------------------------------------------------------------------------------------
// Classification rows, through the CLI.
test('row: summary, zero failures, exit 0 is PASS with the duration', t => {
  const r = run(t, [{ name: 'tests', argv: fake(tmp(t), 'r.js', NODE_SPEC_PASS), parser: 'node' }]);
  assert.equal(r.code, 0);
  assert.match(r.line, /^PASS tests 2\/2 \(\d+s\)$/);
  assert.ok(r.log.endsWith(NODE_SPEC_PASS), 'the log ends with the reporter summary');
});

test('row: a parsed failure count wins over exit 0', t => {
  for (const code of [0, 1]) {
    const r = run(t, [{ name: 'tests', argv: fake(tmp(t), 'r.js', NODE_SPEC_FAIL, code), parser: 'node' }]);
    assert.equal(r.code, 1, 'exit ' + code);
    assert.equal(r.line, `FAIL tests 2 of 4 failed, 1 skipped: node nested spec failure, node spec failure — log: ${r.logPath}`);
  }
});

test('row: summary with zero failures but a non-zero exit is a FAIL naming the exit', t => {
  const r = run(t, [{ name: 'tests', argv: fake(tmp(t), 'r.js', NODE_SPEC_PASS, 3), parser: 'node' }]);
  assert.equal(r.code, 1);
  assert.equal(r.line, `FAIL tests exit 3 after 2/2 passed — log: ${r.logPath}`);
});

test('row: no summary and a non-zero exit is CRASHED before summary', t => {
  const r = run(t, [{ name: 'tests', argv: fake(tmp(t), 'r.js', '✔ started (1ms)\n', 1), parser: 'node' }]);
  assert.equal(r.code, 1);
  assert.equal(r.line, `FAIL tests CRASHED before summary (exit 1) — log: ${r.logPath}`);
});

test('row: no summary and exit 0 is NO SUMMARY, never a pass', t => {
  for (const parser of ['node', 'jest', 'pytest', 'cargo']) {
    const r = run(t, [{ name: 'tests', argv: fake(tmp(t), 'r.js', 'all good, trust me\n', 0), parser }]);
    assert.equal(r.code, 1, parser);
    assert.equal(r.line, `FAIL tests NO SUMMARY (exit 0) — log: ${r.logPath}`);
  }
});

test('row: failures counted but no names captured still fails and says so', t => {
  const r = run(t, [{ name: 'tests', argv: fake(tmp(t), 'r.js', nodeSummary('ℹ', { tests: 2, pass: 1, fail: 1 }), 1), parser: 'node' }]);
  assert.equal(r.code, 1);
  assert.equal(r.line, `FAIL tests 1 of 2 failed (names not captured) — log: ${r.logPath}`);
  const skipped = run(t, [{ name: 'tests', argv: fake(tmp(t), 'r.js', nodeSummary('ℹ', { tests: 3, pass: 1, fail: 1, skipped: 1 }), 1), parser: 'node' }]);
  assert.equal(skipped.line, `FAIL tests 1 of 3 failed, 1 skipped (names not captured) — log: ${skipped.logPath}`);
});

// Per parser: a run in which nothing passed (all skipped, or no test at all) and its sibling in
// which some tests are skipped but one passes.
const NO_PASS = [
  ['node', nodeSummary('ℹ', { tests: 1, pass: 0, fail: 0, skipped: 1 }), 'no test passed (0/1, 1 skipped)'],
  ['node', nodeSummary('#', { tests: 2, pass: 0, fail: 0, todo: 2 }), 'no test passed (0/2, 2 skipped)'],
  ['node', nodeSummary('ℹ', { tests: 0, pass: 0, fail: 0 }), 'no test passed (0/0)'],
  ['jest', 'Tests:       2 skipped, 2 total', 'no test passed (0/2, 2 skipped)'],
  ['jest', 'Tests:       0 total', 'no test passed (0/0)'],
  ['pytest', '=== 2 skipped in 0.10s ===', 'no test passed (0/2, 2 skipped)'],
  ['pytest', '=== 1 xfailed in 0.10s ===', 'no test passed (0/1, 1 skipped)'],
  ['pytest', '=== 3 deselected in 0.10s ===', 'no test passed (0/0)'],
  ['pytest', PYTEST_EMPTY, 'no test passed (0/0)'],
  ['cargo', 'test result: ok. 0 passed; 0 failed; 2 ignored; 0 measured; 0 filtered out; finished in 0.00s', 'no test passed (0/2, 2 skipped)'],
  ['cargo', 'test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 3 filtered out; finished in 0.00s', 'no test passed (0/0)'],
];
const SOME_SKIPPED = [
  ['node', nodeSummary('ℹ', { tests: 3, pass: 1, fail: 0, skipped: 1, todo: 1 }), '1/3, 2 skipped'],
  ['node', nodeSummary('#', { tests: 2, pass: 1, fail: 0, skipped: 1 }), '1/2, 1 skipped'],
  ['jest', 'Tests:       1 skipped, 1 passed, 2 total', '1/2, 1 skipped'],
  ['pytest', '=== 1 passed, 1 skipped, 4 deselected in 0.10s ===', '1/2, 1 skipped'],
  ['cargo', 'test result: ok. 1 passed; 0 failed; 1 ignored; 0 measured; 0 filtered out; finished in 0.00s', '1/2, 1 skipped'],
];

test('row: a summary in which no test passed is never a PASS, whatever the parser (0/0 included)', async t => {
  const { runSpec } = await api;
  const dir = tmp(t), logPath = path.join(dir, 'none.log');
  assert.deepEqual([...new Set(NO_PASS.map(([p]) => p))].sort(), ['cargo', 'jest', 'node', 'pytest'], 'every parser has a no-pass case');
  for (const [i, [parser, text, said]] of NO_PASS.entries()) {
    const r = await runSpec({ steps: [{ name: 'tests', argv: fake(dir, `n${i}.js`, text + '\n'), parser }] }, { cwd: dir, logPath });
    assert.equal(r.status, 'FAIL', `${parser}: ${text}`);
    assert.equal(r.steps[0].result, 'NO-TESTS', `${parser}: ${text}`);
    assert.equal(r.line, `FAIL tests ${said} — log: ${logPath}`);
  }
  // A non-zero exit still names the exit first, now with its skips.
  const exited = await runSpec({ steps: [{ name: 'tests', argv: fake(dir, 'x.js', NO_PASS[0][1], 2), parser: 'node' }] }, { cwd: dir, logPath });
  assert.equal(exited.line, `FAIL tests exit 2 after 0/1 passed, 1 skipped — log: ${logPath}`);
  // Through the CLI: exit code 1.
  const viaCli = run(t, [{ name: 'tests', argv: fake(dir, 'c.js', NO_PASS[0][1]), parser: 'node' }]);
  assert.equal(viaCli.code, 1);
  assert.equal(viaCli.line, `FAIL tests no test passed (0/1, 1 skipped) — log: ${viaCli.logPath}`);
});

test('row: a run with skips that passes shows them; one without skips keeps the plain count', async t => {
  const { runSpec } = await api;
  const dir = tmp(t), logPath = path.join(dir, 'some.log');
  assert.deepEqual([...new Set(SOME_SKIPPED.map(([p]) => p))].sort(), ['cargo', 'jest', 'node', 'pytest']);
  for (const [i, [parser, text, said]] of SOME_SKIPPED.entries()) {
    const r = await runSpec({ steps: [{ name: 'tests', argv: fake(dir, `s${i}.js`, text + '\n'), parser }] }, { cwd: dir, logPath });
    assert.equal(r.status, 'PASS', `${parser}: ${text}`);
    assert.match(r.line, new RegExp(`^PASS tests ${said} \\(\\d+s\\)$`), `${parser}: ${r.line}`);
  }
  const plain = CASES.filter(c => c.expect.failed === 0 && c.expect.skipped === 0 && c.expect.passed > 0);
  assert.deepEqual([...new Set(plain.map(c => c.parser))].sort(), ['cargo', 'jest', 'node', 'pytest'], 'every parser has a skip-free pass');
  for (const c of plain) {
    const r = await runSpec({ steps: [{ name: 'tests', argv: fake(dir, 'plain.js', c.text + '\n'), parser: c.parser }] }, { cwd: dir, logPath });
    assert.match(r.line, new RegExp(`^PASS tests ${c.expect.passed}/${c.expect.total} \\(\\d+s\\)$`), `${c.parser} ${c.label}: ${r.line}`);
  }
  const failing = await runSpec({ steps: [{ name: 'tests', argv: fake(dir, 'f.js', JEST_FAIL, 1), parser: 'jest' }] }, { cwd: dir, logPath });
  assert.equal(failing.line, `FAIL tests 1 of 3 failed, 1 skipped: math › subtracts — log: ${logPath}`);
});

test('row: a file that ran no tests is a failure named as such, never a passing test', async t => {
  const { runSpec } = await api;
  const dir = tmp(t), logPath = path.join(dir, 'empty.log');
  for (const [label, text] of [['spec', NODE_SPEC_EMPTY], ['tap', NODE_TAP_EMPTY]]) {
    const r = await runSpec({ steps: [{ name: 'tests', argv: fake(dir, label + '.js', text + '\n'), parser: 'node' }] }, { cwd: dir, logPath });
    assert.equal(r.steps[0].result, 'FAIL', label);
    assert.equal(r.line, `FAIL tests 6 of 9 failed: ${EMPTY_NAMES.map(n => n + ' (ran no tests)').join(', ')} — log: ${logPath}`, label);
    assert.deepEqual([r.steps[0].loadFailures, r.steps[0].emptyFiles], [EMPTY_NAMES, EMPTY_NAMES], label);
  }
});

test('row: parser none is ok on exit 0 and FAIL with the exit code otherwise', t => {
  const dir = tmp(t);
  const pass = run(t, [{ name: 'check', argv: fake(dir, 'a.js', 'anything\n', 0), parser: 'none' }]);
  assert.equal(pass.code, 0);
  assert.match(pass.line, /^PASS check ok \(\d+s\)$/);
  const fail = run(t, [{ name: 'check', argv: fake(dir, 'b.js', 'ℹ tests 0\n', 4), parser: 'none' }]);
  assert.equal(fail.code, 1);
  assert.equal(fail.line, `FAIL check exit 4 — log: ${fail.logPath}`);
});

test('row: a step outliving --timeout is killed and reported, and later steps still run', t => {
  const dir = tmp(t), sleeper = path.join(dir, 'sleep.js');
  fs.writeFileSync(sleeper, 'setTimeout(() => {}, 60000);\n');
  const r = run(t, [{ name: 'slow', argv: [NODE, sleeper], parser: 'node' }, { name: 'after', argv: fake(dir, 'a.js', 'x\n'), parser: 'none' }], ['--timeout', '1']);
  assert.equal(r.code, 1);
  assert.equal(r.line, `FAIL slow TIMEOUT after 1s; after ok — log: ${r.logPath}`);
  assert.ok(r.ms < 15000, 'the run ended ' + r.ms + 'ms after start');
  assert.match(r.log, /==> step slow: TIMEOUT after 1s; process tree killed/);
});

test('row: a step finishing inside its timeout is not a TIMEOUT (the other side of the boundary)', t => {
  const r = run(t, [{ name: 'quick', argv: fake(tmp(t), 'q.js', NODE_SPEC_PASS), parser: 'node' }], ['--timeout', '30']);
  assert.equal(r.code, 0);
  assert.match(r.line, /^PASS quick 2\/2 \(\d+s\)$/);
});

test('row: a command that cannot start is UNKNOWN, outranks a FAIL, and later steps still run', t => {
  const dir = tmp(t);
  const r = run(t, [{ name: 'missing', argv: ['validate-no-such-command-4f2a'], parser: 'node' },
    { name: 'red', argv: fake(dir, 'r.js', 'x\n', 1), parser: 'none' }, { name: 'after', argv: fake(dir, 'a.js', 'x\n'), parser: 'none' }]);
  assert.equal(r.code, 2);
  assert.equal(r.line, `UNKNOWN missing COULD-NOT-START (ENOENT); red exit 1; after ok — log: ${r.logPath}`);
  // Two tool lines in a row: the second follows the first directly, with no blank line between.
  assert.ok(r.log.includes('==> step missing: argv ["validate-no-such-command-4f2a"]\n==> step missing: COULD-NOT-START (ENOENT)\n'), r.log);
});

test('names are capped at ten, then counted (both sides of the cap)', t => {
  const cargo = n => lines(...Array.from({ length: n }, (_, i) => `test t${i + 1} ... FAILED`),
    `test result: FAILED. 0 passed; ${n} failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s`);
  const names = n => Array.from({ length: n }, (_, i) => 't' + (i + 1)).join(', ');
  const ten = run(t, [{ name: 'tests', argv: fake(tmp(t), 'c.js', cargo(10), 101), parser: 'cargo' }]);
  assert.equal(ten.line, `FAIL tests 10 of 10 failed: ${names(10)} — log: ${ten.logPath}`);
  const eleven = run(t, [{ name: 'tests', argv: fake(tmp(t), 'c.js', cargo(11), 101), parser: 'cargo' }]);
  assert.equal(eleven.line, `FAIL tests 11 of 11 failed: ${names(10)} (+1 more) — log: ${eleven.logPath}`);
});

test('the log holds every step\'s full output, stdout and stderr, under a header per step', t => {
  const dir = tmp(t), log = path.join(dir, 'run.log');
  fs.writeFileSync(log, 'STALE CONTENT FROM AN EARLIER RUN\n');
  const writer = (file, marker) => { const f = path.join(dir, file); fs.writeFileSync(f, `console.log('${marker} out'); console.error('${marker} err');\n`); return [NODE, f]; };
  const steps = [{ name: 'first', argv: writer('1.js', 'FIRST-7c1'), parser: 'none' }, { name: 'second', argv: writer('2.js', 'SECOND-9d4'), parser: 'none' },
    { name: 'bare', argv: fake(dir, 'bare.js', 'BARE-END-2e8'), parser: 'none' }, { name: 'last', argv: fake(dir, 'last.js', 'LAST\n'), parser: 'none' }];
  const r = cli(['--spec', writeSpec(dir, steps), '--log', log]);
  assert.equal(r.code, 0);
  const text = fs.readFileSync(log, 'utf8');
  assert.ok(!text.includes('STALE'), 'each run writes a fresh log');
  const at = s => { const i = text.indexOf(s); assert.ok(i >= 0, 'log lacks ' + s); return i; };
  const h1 = at(`==> step first: argv ${JSON.stringify(steps[0].argv)}`), h2 = at(`==> step second: argv ${JSON.stringify(steps[1].argv)}`);
  assert.ok(h1 < at('FIRST-7c1 out') && h1 < at('FIRST-7c1 err') && at('FIRST-7c1 out') < h2 && at('FIRST-7c1 err') < h2);
  assert.ok(h2 < at('SECOND-9d4 out') && h2 < at('SECOND-9d4 err'));
  // The other side: after newline-terminated output a header gains no blank line either.
  assert.ok(!/\n\r?\n==> step/.test(text), 'no blank line before a header');
  assert.ok(text.includes(`BARE-END-2e8\n==> step last: argv`), 'a header always starts its own line');
});

test('a step reading stdin gets end-of-input at once rather than waiting', t => {
  const script = "process.stdin.on('data', () => {}); process.stdin.on('end', () => console.log('stdin closed'));";
  const r = run(t, [{ name: 'reader', argv: [NODE, '-e', script], parser: 'none' }], ['--timeout', '20']);
  assert.match(r.line, /^PASS reader ok \(\d+s\)$/);
  assert.match(r.log, /stdin closed/);
});

test('a multi-byte character split across output chunks still parses', t => {
  const dir = tmp(t), script = path.join(dir, 'split.js');
  // Each multi-byte character is written in two halves, 30ms apart, so they arrive as separate chunks.
  fs.writeFileSync(script, lines(
    `const bytes = Buffer.from(${JSON.stringify(NODE_SPEC_PASS)});`,
    'let from = 0;',
    'for (let i = 0; i < bytes.length; i++) if (bytes[i] >= 0xe0) {',
    '  require("fs").writeSync(1, bytes.subarray(from, i + 1)); from = i + 1;',
    '  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30);',
    '}',
    'require("fs").writeSync(1, bytes.subarray(from));', ''));
  const r = run(t, [{ name: 'tests', argv: [NODE, script], parser: 'node' }]);
  assert.match(r.line, /^PASS tests 2\/2 \(\d+s\)$/);
});

test('the child environment never carries NODE_TEST_CONTEXT, and otherwise is inherited', t => {
  const dir = tmp(t), probe = path.join(dir, 'env.js');
  fs.writeFileSync(probe, "console.log('ctx=' + (process.env.NODE_TEST_CONTEXT ?? 'absent') + ' probe=' + process.env.VALIDATE_PROBE);\n");
  const log = path.join(dir, 'env.log');
  const r = cli(['--spec', writeSpec(dir, [{ name: 'env', argv: [NODE, probe], parser: 'none' }]), '--log', log],
    { env: cleanEnv({ NODE_TEST_CONTEXT: 'child-v8', VALIDATE_PROBE: 'carried' }) });
  assert.equal(r.code, 0);
  assert.match(fs.readFileSync(log, 'utf8'), /ctx=absent probe=carried/);
});

// ---------------------------------------------------------------------------------------
// Shell steps and process trees.
const SHELL_ORDER = process.platform === 'win32' ? ['pwsh', 'powershell', 'bash'] : ['bash', 'pwsh', 'powershell'];
function shellWorks(shell) {
  const args = shell === 'bash' ? ['-c', 'exit 0'] : ['-NoProfile', '-NonInteractive', '-Command', 'exit 0'];
  return spawnSync(shell, args, { stdio: 'ignore', timeout: 30000, windowsHide: true }).status === 0;
}
// The test's own answer to "which bash on PATH receives a quoted script intact", found by
// running the real quoted script through every candidate rather than the tool's probe. On
// Windows a bash that merely RUNS may be WSL's launcher, which re-evaluates the script.
const QUOTED_BASH = lines("x='said \"quoted\" words'", 'echo "$x"', 'exit 7');
// A refused bash must never run the script: an unquoted marker that any launcher still runs,
// printed and written to a file in the cwd.
const MARKED_BASH = lines('echo ran-anyway; echo ran-anyway > ran-anyway.txt', QUOTED_BASH);
const bashIntact = file => {
  const r = spawnSync(file, ['-o', 'pipefail', '-c', QUOTED_BASH], { encoding: 'utf8', timeout: 30000, windowsHide: true });
  return r.status === 7 && r.stdout.replace(/\r/g, '') === 'said "quoted" words\n';
};
const PATH_KEYS = Object.keys(process.env).filter(k => k.toUpperCase() === 'PATH');
const bashOnPath = pathVar => pathVar.split(';').map(d => d.replace(/"/g, '')).filter(d => path.isAbsolute(d))
  .flatMap(d => ['bash.com', 'bash.exe'].map(f => path.join(d, f))).filter(f => { try { return !fs.lstatSync(f).isDirectory(); } catch { return false; } });
const INTACT_BASH = process.platform !== 'win32' ? (bashIntact('bash') ? 'bash' : null)
  : bashOnPath(PATH_KEYS.length ? process.env[PATH_KEYS[0]] : '').find(bashIntact) ?? null;
function withPath(pathVar) {
  const env = cleanEnv();
  for (const key of PATH_KEYS) delete env[key];
  return { ...env, PATH: pathVar };
}
// Git for Windows' own bash: intact, and reachable however PATH is set (a PowerShell PATH may
// hold only WSL's launcher). When PATH has no intact bash, bash steps run with Git's first,
// so pipefail and the exit code stay pinned under the contract's PowerShell validation too.
const GIT_BASH = process.platform !== 'win32' ? null
  : path.resolve(spawnSync('git', ['--exec-path'], { encoding: 'utf8' }).stdout.trim(), '..', '..', '..', 'usr', 'bin', 'bash.exe');
const BASH_ENV = INTACT_BASH !== null || GIT_BASH === null ? cleanEnv()
  : withPath([path.dirname(GIT_BASH), PATH_KEYS.length ? process.env[PATH_KEYS[0]] : ''].join(';'));
const SHELLS = SHELL_ORDER.filter(s => s === 'bash' ? INTACT_BASH !== null || (GIT_BASH !== null && bashIntact(GIT_BASH)) : shellWorks(s));
// A refused run: the tool's own lines only (nothing any launcher printed) and no marker file.
function assertRefused(r, logPath, cwd, label) {
  assert.equal(r.line, `UNKNOWN sh COULD-NOT-START (BASH-ARGV-ALTERED) — log: ${logPath}`, label);
  assert.equal(r.code, 2, label);
  const text = fs.readFileSync(logPath, 'utf8');
  assert.deepEqual(text.split('\n').filter(l => l && !l.startsWith('==> ')), [], label + ': only the tool\'s own lines');
  assert.equal(fs.existsSync(path.join(cwd, 'ran-anyway.txt')), false, label + ': a refused bash must never run the script');
  return text;
}

test('shell steps run the script as one argument and propagate its exit code', t => {
  assert.ok(SHELLS.length >= 1, 'at least one of pwsh, powershell, bash must run here, or this branch silently skips');
  if (process.platform === 'win32') assert.ok(SHELLS.includes('bash'), `Git for Windows' bash (${GIT_BASH}) must run here, or bash steps go unexercised`);
  if (INTACT_BASH === null && shellWorks('bash')) {
    // A bash that runs but alters a quoted script (WSL's launcher first on PATH) is refused, never run.
    const dir = tmp(t), log = path.join(dir, 'refused.log');
    const refused = cli(['--spec', writeSpec(dir, [{ name: 'sh', shell: 'bash', script: MARKED_BASH, parser: 'none' }]), '--log', log], { cwd: dir });
    assertRefused(refused, log, dir, 'the bash first on PATH');
  }
  for (const shell of SHELLS) {
    const bash = shell === 'bash', env = bash ? BASH_ENV : cleanEnv();
    const quoted = bash ? QUOTED_BASH : lines('$x = "said ""quoted"" words"', 'Write-Output $x', 'exit 7');
    const red = run(t, [{ name: 'sh', shell, script: quoted, parser: 'none' }], [], env);
    assert.equal(red.code, 1, shell);
    assert.equal(red.line, `FAIL sh exit 7 — log: ${red.logPath}`, shell);
    assert.match(red.log, /said "quoted" words/, shell + ' must receive embedded double quotes intact');
    assert.match(red.log, new RegExp(`==> step sh: shell ${shell}`));
    const green = run(t, [{ name: 'sh', shell, script: bash ? 'echo fine' : 'Write-Output fine', parser: 'none' }], [], env);
    assert.equal(green.code, 0, shell);
    assert.match(green.line, /^PASS sh ok \(\d+s\)$/);
    if (bash) {
      const piped = run(t, [{ name: 'sh', shell, script: 'false | true', parser: 'none' }], [], env);
      assert.equal(piped.line, `FAIL sh exit 1 — log: ${piped.logPath}`, 'bash runs with -o pipefail');
    } else {
      // The script travels encoded, never as command text: the process sees only base64.
      const seen = run(t, [{ name: 'sh', shell, script: 'Write-Output ([Environment]::CommandLine)', parser: 'none' }], [], env);
      assert.match(seen.log, /-NoProfile -NonInteractive -OutputFormat Text -EncodedCommand [A-Za-z0-9+/]+=*\s*$/m, shell);
      assert.doesNotMatch(seen.log, /\[Environment\]::CommandLine/, shell);
    }
  }
});

test('the bash probe catches each launcher alteration through a part of its own', async () => {
  const { BASH_PROBE, bashProbeIntact } = await api;
  const bash = GIT_BASH ?? 'bash';
  assert.ok(bashIntact(bash), `an intact bash (${bash}) must run here, or the probe is proved against nothing`);
  const through = script => spawnSync(bash, ['-o', 'pipefail', '-c', script], { encoding: 'utf8', timeout: 30000, windowsHide: true });
  const intact = through(BASH_PROBE);
  assert.equal(bashProbeIntact(intact), true, 'the unaltered probe passes: ' + JSON.stringify(intact.stdout));
  // One simulated alteration per probe part, each keyed on that part alone: a probe that loses
  // the part leaves its alteration a no-op, undetected.
  const ALTERATIONS = [
    ['plain double quotes stripped', s => s.replace(/(?<!\\)"/g, '')],
    ['a backslash before a quote consumed', s => s.replace(/\\"/g, '"')],
    ['a second evaluation expanding $ variables', s => s.replace(/\$\w+/g, '')],
    ['a cut at the first newline', s => s.split('\n')[0]],
  ];
  assert.equal(ALTERATIONS.length, 4, 'one alteration per probe part');
  for (const [what, alter] of ALTERATIONS) {
    const altered = alter(BASH_PROBE);
    assert.notEqual(altered, BASH_PROBE, what + ': the probe must hold the part this alteration touches');
    assert.equal(bashProbeIntact(through(altered)), false, what);
  }
  // A substitution that keeps the output's length: only a byte comparison rejects it.
  const swapped = through(BASH_PROBE.replace('$c', 'xy'));
  assert.ok(swapped.stdout !== intact.stdout && swapped.stdout.length === intact.stdout.length, 'an equal-length alteration: ' + JSON.stringify(swapped.stdout));
  assert.equal(bashProbeIntact(swapped), false, 'an equal-length substitution');
  // The right output with any exit but 0: a failure, another code, a probe killed by its timeout.
  for (const status of [1, 2, null]) assert.equal(bashProbeIntact({ ...intact, status }), false, 'the right output with exit status ' + status);
});

test('on Windows a bash that alters a quoted script is skipped for a later intact one, and refused when none follows', async t => {
  if (process.platform !== 'win32') { t.skip('Windows only: elsewhere argv reaches bash intact by construction'); return; }
  const { BASH_PROBE } = await api;
  const dir = tmp(t), spec = writeSpec(dir, [{ name: 'sh', shell: 'bash', script: MARKED_BASH, parser: 'none' }]);
  const place = (sub, name, source) => {
    const d = path.join(dir, sub);
    fs.mkdirSync(d);
    try { fs.linkSync(source, path.join(d, name)); } catch { fs.copyFileSync(source, path.join(d, name)); }
    return d;
  };
  const cmdExe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe');
  // Stand-ins failing the probe on different grounds, proved rather than assumed: node.exe
  // named bash.exe exits non-zero; cmd.exe named bash.exe exits 0 with the wrong output.
  const [nodeDir, cmdDir] = [place('node', 'bash.exe', NODE), place('cmd', 'bash.exe', cmdExe)];
  const [viaNode, viaCmd] = [nodeDir, cmdDir].map(d => spawnSync(path.join(d, 'bash.exe'), ['-o', 'pipefail', '-c', BASH_PROBE], { encoding: 'utf8', timeout: 30000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }));
  assert.ok(viaNode.status !== 0 && viaNode.status !== null, 'the node stand-in exits non-zero: ' + viaNode.status);
  assert.ok(viaCmd.status === 0 && viaCmd.stdout !== '' && !viaCmd.stdout.includes('q "b"'), 'the cmd stand-in exits 0 printing something else: ' + JSON.stringify(viaCmd));
  assert.ok(bashIntact(GIT_BASH), `Git for Windows ships an intact bash at ${GIT_BASH}, or the skip-to-next branch goes unexercised`);
  const gitDir = path.dirname(GIT_BASH), rejectedNote = file => `==> step sh: ${file} does not receive a quoted script intact (a launcher such as WSL's); not used`;
  // A stand-in that RUNS scripts yet fails the probe: Git's bash with BASH_ENV overriding printf.
  // It arms the "a refused bash never runs the script" marker on every Windows machine with Git.
  const bashEnvFile = path.join(dir, 'alter-printf.sh');
  fs.writeFileSync(bashEnvFile, "printf() { builtin printf '%s' altered; }\n");
  const altering = { BASH_ENV: slashes(bashEnvFile) }, envCtl = path.join(dir, 'bash-env-control');
  fs.mkdirSync(envCtl);
  const envProbe = spawnSync(GIT_BASH, ['-o', 'pipefail', '-c', BASH_PROBE], { env: cleanEnv(altering), encoding: 'utf8', timeout: 30000, windowsHide: true });
  assert.ok(envProbe.status === 0 && envProbe.stdout === 'alteredaltered', 'the BASH_ENV stand-in exits 0 with the wrong probe output: ' + JSON.stringify(envProbe.stdout));
  const envRun = spawnSync(GIT_BASH, ['-o', 'pipefail', '-c', MARKED_BASH], { env: cleanEnv(altering), cwd: envCtl, encoding: 'utf8', timeout: 30000, windowsHide: true });
  assert.ok(envRun.status === 7 && fs.existsSync(path.join(envCtl, 'ran-anyway.txt')), 'the BASH_ENV stand-in runs a script and writes the marker: ' + envRun.status);
  const alterers = [{ dir: nodeDir }, { dir: cmdDir }, { dir: gitDir, env: altering, alone: true }];
  // WSL's launcher, wherever installed, is an alterer too; where it runs scripts it is a live
  // control of the real alteration. Its absence or a missing distribution is reported, never red.
  const wsl = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'bash.exe');
  if (!fs.existsSync(wsl)) t.diagnostic(`no WSL launcher at ${wsl}: a real launcher's own alteration is not exercised end to end here`);
  else {
    if (spawnSync(wsl, ['-c', 'exit 7'], { timeout: 60000, windowsHide: true, stdio: 'ignore' }).status !== 7) {
      t.diagnostic(`${wsl} cannot run a script (no usable distribution?): kept as an alterer, its live alteration control skipped`);
    } else {
      const ctl = path.join(dir, 'wsl-control');
      fs.mkdirSync(ctl);
      const r = spawnSync(wsl, ['-o', 'pipefail', '-c', MARKED_BASH], { cwd: ctl, encoding: 'utf8', timeout: 60000, windowsHide: true });
      assert.equal(r.status, 7, `${wsl} runs a script: ${JSON.stringify(r.stdout)}`);
      assert.match(r.stdout, /ran-anyway/);
      assert.ok(fs.existsSync(path.join(ctl, 'ran-anyway.txt')), 'the marker file is how a refused bash that ran anyway shows');
      assert.doesNotMatch(r.stdout, /said "quoted" words/, 'it alters the quoted script');
    }
    alterers.push({ dir: path.dirname(wsl) });
  }
  for (const [i, { dir: alterer, env: extra = {}, alone }] of alterers.entries()) {
    const cwd = path.join(dir, `refused-${i}`), log = path.join(dir, `refused-${i}.log`);
    fs.mkdirSync(cwd);
    const text = assertRefused(cli(['--spec', spec, '--log', log], { env: { ...withPath(alterer), ...extra }, cwd }), log, cwd, alterer);
    assert.ok(text.includes(rejectedNote(path.join(alterer, 'bash.exe'))), text);
    if (alone) continue; // Git's bash altered by BASH_ENV cannot be followed by Git's bash unaltered.
    const skipCwd = path.join(dir, `skipped-${i}`), skipLog = path.join(dir, `skipped-${i}.log`);
    fs.mkdirSync(skipCwd);
    const skipped = cli(['--spec', spec, '--log', skipLog], { env: withPath([alterer, gitDir].join(';')), cwd: skipCwd });
    assert.equal(skipped.line, `FAIL sh exit 7 — log: ${skipLog}`, alterer);
    const skipText = fs.readFileSync(skipLog, 'utf8');
    assert.ok(skipText.includes(rejectedNote(path.join(alterer, 'bash.exe'))), skipText);
    assert.ok(skipText.includes(`==> step sh: bash is ${GIT_BASH}`), skipText);
    assert.match(skipText, /said "quoted" words/);
    assert.ok(fs.existsSync(path.join(skipCwd, 'ran-anyway.txt')), 'the marker is live: a bash that runs the script writes it');
  }
  // The candidate list: a relative entry and a folder named bash.exe are never candidates,
  // bash.com is tried, a quoted entry is unquoted, and the FIRST intact bash wins, so the same
  // folder spelt in upper case later is never named.
  place('rel', 'bash.exe', cmdExe);
  fs.mkdirSync(path.join(dir, 'folder', 'bash.exe'), { recursive: true });
  const com = place('com', 'bash.com', cmdExe), listLog = path.join(dir, 'listed.log');
  const listed = cli(['--spec', spec, '--log', listLog], { env: withPath(['rel', path.join(dir, 'folder'), com, `"${gitDir}"`, gitDir.toUpperCase()].join(';')), cwd: dir });
  assert.equal(listed.line, `FAIL sh exit 7 — log: ${listLog}`);
  assert.notEqual(gitDir.toUpperCase(), gitDir, 'the upper-case spelling must differ, or first-wins is unpinned');
  assert.deepEqual(fs.readFileSync(listLog, 'utf8').split('\n').filter(l => / does not receive | bash is /.test(l)),
    [rejectedNote(path.join(com, 'bash.com')), `==> step sh: bash is ${GIT_BASH}`]);
  const none = path.join(dir, 'none.log'), missing = cli(['--spec', spec, '--log', none], { env: withPath(path.join(dir, 'empty')), cwd: dir });
  assert.equal(missing.line, `UNKNOWN sh COULD-NOT-START (ENOENT) — log: ${none}`);
});

test('on Windows the bash a step uses is resolved per PATH within one process', async t => {
  if (process.platform !== 'win32') { t.skip('Windows only: elsewhere bash is not resolved by the tool'); return; }
  const { runSpec } = await api;
  const dir = tmp(t), cmdDir = path.join(dir, 'cmd');
  fs.mkdirSync(cmdDir);
  fs.copyFileSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe'), path.join(cmdDir, 'bash.exe'));
  const key = PATH_KEYS[0] ?? 'PATH', saved = process.env[key], spec = { steps: [{ name: 'sh', shell: 'bash', script: QUOTED_BASH, parser: 'none' }] }, results = [];
  try {
    for (const [i, pathVar] of [cmdDir, path.dirname(GIT_BASH), cmdDir].entries()) {
      process.env[key] = pathVar;
      results.push(await runSpec(spec, { cwd: dir, logPath: path.join(dir, `cache-${i}.log`) }));
    }
  } finally { if (saved === undefined) delete process.env[key]; else process.env[key] = saved; }
  assert.deepEqual(results.map(r => [r.steps[0].result, r.steps[0].exit]), [['COULD-NOT-START', null], ['FAIL', 7], ['COULD-NOT-START', null]]);
});

test('a shell step outliving its timeout ends with its grandchildren killed', t => {
  assert.ok(SHELLS.length >= 1);
  const shell = SHELLS[0], dir = tmp(t), pidFile = path.join(dir, 'grandchild.pid'), grand = path.join(dir, 'grand.js');
  fs.writeFileSync(grand, "require('fs').writeFileSync(process.argv[2], String(process.pid)); setTimeout(() => {}, 60000);\n");
  const call = `'${NODE}' '${grand}' '${pidFile}'`;
  const script = shell === 'bash' ? lines(call, 'echo after') : lines(`& ${call}`, 'Write-Output after');
  const r = run(t, [{ name: 'tree', shell, script, parser: 'node' }], ['--timeout', '5']);
  assert.ok(fs.existsSync(pidFile), 'the grandchild must have started, or this proves nothing');
  const pid = Number(fs.readFileSync(pidFile, 'utf8'));
  t.after(() => { if (isAlive(pid)) process.kill(pid); });
  assert.equal(r.line, `FAIL tree TIMEOUT after 5s — log: ${r.logPath}`);
  assert.ok(r.ms < 5000 + 10000, 'the run ended ' + r.ms + 'ms after start');
  const deadline = Date.now() + 5000;
  while (isAlive(pid) && Date.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
  assert.equal(isAlive(pid), false, 'the grandchild must be killed with the tree');
});

test('a step that exits while a stray descendant holds its output ends after a grace period', t => {
  const dir = tmp(t), pidFile = path.join(dir, 'orphan.pid'), script = path.join(dir, 'orphan.js');
  fs.writeFileSync(script, lines(
    "const { spawn } = require('child_process');",
    "if (process.argv[2] === 'grand') { require('fs').writeFileSync(process.argv[3], String(process.pid)); setTimeout(() => {}, 60000); }",
    "else { spawn(process.execPath, [__filename, 'grand', process.argv[2]], { stdio: 'inherit', detached: true }).unref(); console.log('parent done'); }", ''));
  // A timeout shorter than the grace period: an exited step is no longer timed.
  const r = run(t, [{ name: 'orphan', argv: [NODE, script, pidFile], parser: 'none' }], ['--timeout', '2']);
  const pid = fs.existsSync(pidFile) ? Number(fs.readFileSync(pidFile, 'utf8')) : 0;
  t.after(() => { if (pid && isAlive(pid)) process.kill(pid); });
  assert.ok(pid, 'the stray descendant must have started, or this proves nothing');
  assert.match(r.line, /^PASS orphan ok \(\d+s\)$/);
  assert.ok(r.ms < 20000, 'the run ended ' + r.ms + 'ms after start');
  // The holder is deliberately NOT killed (its parent is gone, so no tree leads to it); the
  // log says so, and t.after above cleans it up.
  assert.match(r.log, /==> step orphan: exited but its output pipes are still held open; stopped reading \(the holder is left running\)/);
});

// ---------------------------------------------------------------------------------------
// Live controls: the real node reporters, not canned text.
function liveFiles(dir) {
  const write = (file, text) => { fs.writeFileSync(path.join(dir, file), text); return path.join(dir, file); };
  return {
    mixed: write('mixed.test.cjs', "const test = require('node:test');\ntest('live control passes', () => {});\ntest('live control zebra fails 7f3a', () => { throw new Error('on purpose'); });\n"),
    green: write('green.test.cjs', "const test = require('node:test');\ntest('live green passes', () => {});\n"),
    broken: write('broken.test.cjs', "const test = require('node:test');\ntest('never loads', () => {\n"),
  };
}

test('live: the real spec and TAP reporters report the failing name and counts 1/2', async t => {
  const { runSpec } = await api;
  const dir = tmp(t), files = liveFiles(dir);
  for (const reporter of ['spec', 'tap']) {
    const logPath = path.join(dir, reporter + '.log');
    const r = await runSpec({ steps: [{ name: 'tests', argv: [NODE, '--test', '--test-reporter=' + reporter, files.mixed], parser: 'node' }] }, { cwd: dir, logPath });
    assert.equal(r.status, 'FAIL', reporter);
    assert.deepEqual(r.steps[0], { name: 'tests', result: 'FAIL', passed: 1, failed: 1, skipped: 0, total: 2, names: ['live control zebra fails 7f3a'], loadFailures: [], emptyFiles: [], exit: 1 }, reporter);
    assert.equal(r.line, `FAIL tests 1 of 2 failed: live control zebra fails 7f3a — log: ${logPath}`);
    const green = await runSpec({ steps: [{ name: 'tests', argv: [NODE, '--test', '--test-reporter=' + reporter, files.green], parser: 'node' }] }, { cwd: dir, logPath });
    assert.equal(green.status, 'PASS', reporter);
    assert.match(green.line, /^PASS tests 1\/1 \(\d+s\)$/);
  }
  const viaCli = cli(['--spec', writeSpec(dir, [{ name: 'tests', argv: [NODE, '--test', '--test-reporter=spec', files.mixed], parser: 'node' }]), '--log', path.join(dir, 'cli.log')]);
  assert.equal(viaCli.code, 1);
  assert.equal(viaCli.line, `FAIL tests 1 of 2 failed: live control zebra fails 7f3a — log: ${path.join(dir, 'cli.log')}`);
});

test('live: a test file that fails to load comes back in loadFailures, absolute or relative, both reporters', async t => {
  const { runSpec } = await api;
  const dir = tmp(t), files = liveFiles(dir);
  for (const reporter of ['spec', 'tap']) for (const style of ['absolute', 'relative']) {
    const args = style === 'absolute' ? [files.broken, files.mixed] : ['broken.test.cjs', 'mixed.test.cjs'];
    const r = await runSpec({ steps: [{ name: 'tests', argv: [NODE, '--test', '--test-reporter=' + reporter, ...args], parser: 'node' }] }, { cwd: dir, logPath: path.join(dir, `${reporter}-${style}.log`) });
    const step = r.steps[0], label = `${reporter} ${style}`;
    assert.equal(step.result, 'FAIL', label);
    assert.equal(step.loadFailures.length, 1, label + ': ' + JSON.stringify(step));
    assert.ok(slashes(step.loadFailures[0]).endsWith('broken.test.cjs'), label);
    assert.ok(step.names.includes(step.loadFailures[0]), label);
    assert.ok(step.names.includes('live control zebra fails 7f3a') && !step.loadFailures.includes('live control zebra fails 7f3a'), label);
  }
});

test('live: a suite whose only test is skipped, or that runs nothing, fails; a partly skipped one passes with its count', async t => {
  const { runSpec } = await api;
  const dir = tmp(t), write = (file, text) => fs.writeFileSync(path.join(dir, file), "const test = require('node:test');\n" + text);
  // The shape the report measured: a Windows-only test, skipped everywhere else (forced here).
  write('only-skipped.test.cjs', "test('windows only', { skip: 'Windows only' }, () => {});\n");
  write('partly.test.cjs', "test('runs', () => {});\ntest('windows only', { skip: 'Windows only' }, () => {});\ntest('later', { todo: true }, () => {});\n");
  write('plain.test.cjs', "test('runs', () => {});\n");
  const go = async (reporter, files) => (await runSpec({ steps: [{ name: 'tests', argv: [NODE, '--test', '--test-reporter=' + reporter, ...files], parser: 'node' }] },
    { cwd: dir, logPath: path.join(dir, reporter + '.log') }));
  for (const reporter of ['spec', 'tap']) {
    const skipped = await go(reporter, ['only-skipped.test.cjs']);
    assert.equal(skipped.line, `FAIL tests no test passed (0/1, 1 skipped) — log: ${path.join(dir, reporter + '.log')}`, reporter);
    assert.deepEqual([skipped.steps[0].result, skipped.steps[0].skipped], ['NO-TESTS', 1], reporter);
    // A pattern matching no file: node runs nothing, prints a 0/0 summary and exits 0.
    const nothing = await go(reporter, ['nothing-matches-*.test.cjs']);
    assert.equal(nothing.steps[0].exit, 0, reporter + ': node exits 0 on it, so only the rule refuses it');
    assert.equal(nothing.line, `FAIL tests no test passed (0/0) — log: ${path.join(dir, reporter + '.log')}`, reporter);
    const partly = await go(reporter, ['partly.test.cjs']);
    assert.match(partly.line, /^PASS tests 1\/3, 2 skipped \(\d+s\)$/, reporter);
    assert.deepEqual([partly.steps[0].passed, partly.steps[0].skipped, partly.steps[0].total], [1, 2, 3], reporter);
    const plain = await go(reporter, ['plain.test.cjs']);
    assert.match(plain.line, /^PASS tests 1\/1 \(\d+s\)$/, reporter + ': no skips, no suffix');
  }
});

test('live: a test file that registers no tests is a load failure, relative, absolute or discovered; real tests beside it still pass', async t => {
  const { runSpec } = await api;
  const dir = tmp(t), sub = path.join(dir, 'test');
  fs.mkdirSync(sub);
  const write = (file, text) => { fs.writeFileSync(path.join(sub, file), "const { test, describe } = require('node:test');\n" + text); return path.join(sub, file); };
  // R2's mutation: the same data-driven file, once with its data and once emptied. It sorts
  // after named.test.cjs, so its entry follows a suite and a parent test: the common position.
  const DATA = "for (const x of ROWS) test('row ' + x, () => {});\n";
  write('one.test.cjs', "const ROWS = ['a'];\n" + DATA);
  // File-shaped names that are NOT empty files: a suite and a parent test with children, a
  // todo, sentences ending in a file name (two real Shipping App titles), a non-script file name.
  write('named.test.cjs', lines("describe('validate.mjs', () => { test('inside', () => {}); });",
    "test('helpers.mjs', async t => { await t.test('child', () => {}); });", "test('parses config.test.js', () => {});",
    ...REAL_TITLES.map(title => `test(${JSON.stringify(title)}, () => {});`), "test('package.json', () => {});",
    "test('todo.test.cjs', { todo: true }, () => {});", ''));
  const go = async (reporter, args) => {
    const logPath = path.join(dir, reporter + '.log');
    const step = (await runSpec({ steps: [{ name: 'tests', argv: [NODE, '--test', '--test-reporter=' + reporter, ...args], parser: 'node' }] }, { cwd: dir, logPath })).steps[0];
    const raw = fs.readFileSync(logPath, 'utf8');
    return { ...step, raw: raw.split(/\r?\n/), log: stripAnsi(raw).split(/\r?\n/) };
  };
  const at = (log, re) => log.findIndex(l => re.test(l));
  // Plain AND coloured in every run, whatever terminal started the suite: FORCE_COLOR reaches the
  // child through the environment runSpec forwards (NO_COLOR and NODE_DISABLE_COLORS would only warn).
  const COLOUR_KEYS = ['FORCE_COLOR', 'NO_COLOR', 'NODE_DISABLE_COLORS'], savedColour = COLOUR_KEYS.map(k => [k, process.env[k]]);
  try { for (const [colour, reporter] of [['0', 'spec'], ['0', 'tap'], ['1', 'spec'], ['1', 'tap']]) {
    for (const k of COLOUR_KEYS) delete process.env[k];
    process.env.FORCE_COLOR = colour;
    write('zz-data.test.cjs', "const ROWS = ['b'];\n" + DATA);
    const control = await go(reporter, []);
    assert.deepEqual([control.result, control.passed, control.skipped, control.total, control.loadFailures], ['PASS', 9, 1, 10, []], `${reporter} FORCE_COLOR=${colour} control: ` + JSON.stringify(control));
    write('zz-data.test.cjs', 'const ROWS = [];\n' + DATA);
    const named = path.join(sub, 'named.test.cjs');
    for (const [style, args, name] of [['discovered', [], slashes(path.join('test', 'zz-data.test.cjs'))],
      ['relative', ['test/named.test.cjs', 'test/zz-data.test.cjs', 'test/one.test.cjs'], 'test/zz-data.test.cjs'],
      ['absolute', [named, path.join(sub, 'zz-data.test.cjs'), path.join(sub, 'one.test.cjs')], path.join(sub, 'zz-data.test.cjs')]]) {
      const step = await go(reporter, args), label = `${reporter} ${style} FORCE_COLOR=${colour}`;
      assert.equal(step.result, 'FAIL', label + ': ' + JSON.stringify(step));
      assert.equal(step.emptyFiles.length, 1, label + ': ' + JSON.stringify(step.emptyFiles));
      assert.ok(slashes(step.emptyFiles[0]).endsWith(slashes(name)), label + ': ' + step.emptyFiles[0]);
      assert.deepEqual(step.loadFailures, step.emptyFiles, label);
      assert.equal(step.failed, 1, label + ': the file counts as failed, not passed');
      assert.equal(step.passed, step.total - step.skipped - 1, label);
      // The emptied file's entry really follows the parent test's, so the scan's bound is exercised.
      const parent = at(step.log, /^(?:✔ |ok \d+ - )helpers\.mjs\b/), emptied = at(step.log, /^(?:✔ |ok \d+ - ).*zz-data\.test\.cjs\b/);
      assert.ok(parent >= 0 && emptied > parent, `${label}: the emptied file (line ${emptied}) must follow the parent test (line ${parent})`);
      // Live control: the plain run is plain, and in the coloured spec run the very lines found are painted.
      if (colour === '0') assert.ok(!step.raw.some(l => l.includes(ESC)), label + ': the plain log must hold no escape');
      else if (reporter === 'spec') assert.ok(step.raw.length === step.log.length && step.raw[parent].includes(ESC) && step.raw[emptied].includes(ESC),
        `${label}: both entries must be painted in the raw log: ${JSON.stringify([step.raw[parent], step.raw[emptied]])}`);
    }
  } } finally { for (const [k, v] of savedColour) if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  // Presence as well as value: a key unset before must be unset again, never the string 'undefined'.
  assert.deepEqual(COLOUR_KEYS.map(k => [k, k in process.env, process.env[k]]), savedColour.map(([k, v]) => [k, v !== undefined, v]), 'the colour environment is restored');
  // The documented false rejection: a real test deliberately named like a file path.
  write('zz-data.test.cjs', "test('data.test.cjs', () => {});\n");
  const falseRejection = await go('spec', ['test/zz-data.test.cjs']);
  assert.deepEqual([falseRejection.result, falseRejection.emptyFiles], ['FAIL', ['data.test.cjs']]);
  // A space in the emptied file's own name, discovered: still recognised under both reporters.
  const spaced = tmp(t);
  fs.mkdirSync(path.join(spaced, 'test'));
  fs.writeFileSync(path.join(spaced, 'test', 'one.test.cjs'), "require('node:test')('real one', () => {});\n");
  fs.writeFileSync(path.join(spaced, 'test', 'my data.test.cjs'), "const test = require('node:test');\nfor (const x of []) test(x, () => {});\n");
  for (const reporter of ['spec', 'tap']) {
    const r = await runSpec({ steps: [{ name: 'tests', argv: [NODE, '--test', '--test-reporter=' + reporter], parser: 'node' }] }, { cwd: spaced, logPath: path.join(spaced, reporter + '.log') });
    assert.deepEqual([r.steps[0].result, r.steps[0].passed, r.steps[0].failed, r.steps[0].emptyFiles.map(slashes)], ['FAIL', 1, 1, ['test/my data.test.cjs']], reporter + ': ' + r.line);
  }
});

// ---------------------------------------------------------------------------------------
// Input validation.
test('invalid specs are UNKNOWN with exit 2 and run nothing; a valid one of the same shape runs', t => {
  const good = { name: 'a', argv: [NODE, '-e', ''], parser: 'none' };
  const bad = {
    'both argv and shell': { steps: [{ ...good, shell: 'bash', script: 'exit 0' }] },
    'neither argv nor shell': { steps: [{ name: 'a', parser: 'none' }] },
    'empty steps': { steps: [] },
    'steps not an array': { steps: good },
    'spec is an array': [good],
    'spec is null': null,
    'duplicate names': { steps: [good, { ...good }] },
    'unknown step key': { steps: [{ ...good, timeout: 5 }] },
    'unknown top-level key': { steps: [good], extra: true },
    'unknown parser': { steps: [{ ...good, parser: 'mocha' }] },
    'missing parser': { steps: [{ name: 'a', argv: [NODE, '-e', ''] }] },
    'bad name': { steps: [{ ...good, name: 'has space' }] },
    'missing name': { steps: [{ argv: [NODE, '-e', ''], parser: 'none' }] },
    'shell without script': { steps: [{ name: 'a', shell: 'bash', parser: 'none' }] },
    'script without shell': { steps: [{ name: 'a', script: 'exit 0', parser: 'none' }] },
    'unknown shell': { steps: [{ name: 'a', shell: 'zsh', script: 'exit 0', parser: 'none' }] },
    'empty script': { steps: [{ name: 'a', shell: 'bash', script: '', parser: 'none' }] },
    'empty argv': { steps: [{ ...good, argv: [] }] },
    'non-string argv': { steps: [{ ...good, argv: [NODE, 5] }] },
    'empty command': { steps: [{ ...good, argv: ['', '-e', ''] }] },
  };
  for (const [label, spec] of Object.entries(bad)) {
    const dir = tmp(t), file = path.join(dir, 'spec.json'), log = path.join(dir, 'never.log');
    fs.writeFileSync(file, JSON.stringify(spec));
    const r = cli(['--spec', file, '--log', log]);
    assert.equal(r.code, 2, label);
    assert.match(r.line, /^UNKNOWN spec: /, label);
    assert.equal(fs.existsSync(log), false, label + ': nothing may run');
  }
  const dir = tmp(t), file = path.join(dir, 'spec.json');
  for (const [label, text] of [['not JSON', '{"steps": ['], ['BOM-prefixed JSON', BOM + JSON.stringify({ steps: [good] })]]) {
    fs.writeFileSync(file, text);
    const r = cli(['--spec', file, '--log', path.join(dir, 'x.log')]);
    if (label === 'not JSON') { assert.equal(r.code, 2); assert.match(r.line, /^UNKNOWN spec: .* is not valid JSON$/); }
    else { assert.equal(r.code, 0, label); assert.match(r.line, /^PASS a ok/); }
  }
  const missing = cli(['--spec', path.join(dir, 'absent.json'), '--log', path.join(dir, 'x.log')]);
  assert.equal(missing.code, 2);
  assert.match(missing.line, /^UNKNOWN cannot read spec .*\(ENOENT\)$/);
  const valid = run(t, [good, { ...good, name: 'b.c_d-1' }]);
  assert.equal(valid.code, 0, 'the same shape, valid, must run');
});

test('flags: unknown, duplicate, missing or malformed are UNKNOWN exit 2; --help exits 0', t => {
  const dir = tmp(t), spec = writeSpec(dir, [{ name: 'a', argv: [NODE, '-e', ''], parser: 'none' }]), log = path.join(dir, 'x.log');
  const cases = {
    'no flags': [],
    'unknown flag': ['--spec', spec, '--log', log, '--bogus', 'x'],
    'duplicate flag': ['--spec', spec, '--spec', spec, '--log', log],
    'missing --log': ['--spec', spec],
    'missing --spec': ['--log', log],
    'value-less flag': ['--log', log, '--spec'],
    'flag as value': ['--spec', '--log', log],
    'timeout zero': ['--spec', spec, '--log', log, '--timeout', '0'],
    'timeout negative': ['--spec', spec, '--log', log, '--timeout', '-1'],
    'timeout fractional': ['--spec', spec, '--log', log, '--timeout', '1.5'],
    'timeout text': ['--spec', spec, '--log', log, '--timeout', 'soon'],
    'timeout above the timer ceiling': ['--spec', spec, '--log', log, '--timeout', '2147484'],
    'cwd missing': ['--spec', spec, '--log', log, '--cwd', path.join(dir, 'nowhere')],
    'help plus more': ['--help', '--spec', spec],
  };
  for (const [label, args] of Object.entries(cases)) {
    const r = cli(args);
    assert.equal(r.code, 2, label);
    assert.match(r.line, /^UNKNOWN usage: /, label);
  }
  const largest = cli(['--spec', spec, '--log', log, '--timeout', '2147483']);
  assert.match(largest.line, /^PASS a ok \(\d+s\)$/, 'the largest timeout is accepted and does not fire early');
  const accepted = cli(['--spec', spec, '--log', log, '--timeout', '1', '--cwd', dir]);
  assert.equal(accepted.code, 0, 'the smallest timeout and an explicit cwd are accepted');
  const help = spawnSync(NODE, [TOOL, '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /--spec <file\.json> --log <file>/);
  assert.match(help.stdout, /"steps"/);
});

test('--help states the pass rule, the skipped display and count, and the empty-file rule with its false rejection', () => {
  const help = spawnSync(NODE, [TOOL, '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0);
  const text = help.stdout.replace(/\s+/g, ' ');
  for (const needed of [
    'A parsed step passes only when its summary shows zero failures, at least one passed test, and it exits 0',
    '0/0 included) is FAIL "no test passed (<passed>/<total>, <k> skipped)"',
    'Skips show on the line only when there are any: "tests 497/499, 2 skipped"',
    'skipped counts every test in the total that neither passed nor failed: node skipped + todo; jest skipped + todo + pending; pytest skipped + xfailed + xpassed; cargo ignored',
    'or whose every test a filter removed (--test-name-pattern, --test-skip-pattern, --test-only), as one passing test named after the file',
    'counted as failed, named "(ran no tests)" and listed in loadFailures',
    'The price is a false rejection of any real top-level test, or an empty describe under the spec reporter, whose name is file-shaped: one named like a file path ("config.test.js") or a title whose first word holds a slash or a backslash ("I/O errors from reader.js"); rename it.',
    'no whitespace before its first / or \\)',
    'Not recognised: a file that node names by a relative path whose first segment holds a space, whether given, globbed, ./-prefixed or discovered ("my file.test.js", "my dir/a.test.js").',
  ]) assert.ok(text.includes(needed), 'the --help text must say: ' + needed);
  assert.doesNotMatch(text, /passes only when its summary shows zero failures and it exits 0/, 'the old rule is gone');
  // No sentence but the two that state the rules may speak of passing alongside skips, empty runs
  // or 0/0. Sentences end at a dot before a capital or the end, never at a dot inside a file name;
  // the two rule sentences come out verbatim, so an edit inside either goes red too.
  const RULE = 'A parsed step passes only when its summary shows zero failures, at least one passed test, and it exits 0: a run in which nothing passed (every test skipped, or no test at all, 0/0 included) is FAIL "no test passed (<passed>/<total>, <k> skipped)".';
  const COUNTS = 'Skips show on the line only when there are any: "tests 497/499, 2 skipped". skipped counts every test in the total that neither passed nor failed: node skipped + todo; jest skipped + todo + pending; pytest skipped + xfailed + xpassed; cargo ignored (pytest\'s deselected and cargo\'s filtered out are outside the total). node reports a test file that registered no tests, or whose every test a filter removed (--test-name-pattern, --test-skip-pattern, --test-only), as one passing test named after the file; any top-level passing entry (no directive, no subtests, not a suite) whose name is file-shaped (a script extension, and no whitespace before its first / or \\) is taken for one: counted as failed, named "(ran no tests)" and listed in loadFailures.';
  const SUBJECT = /0\/0|\bno tests?\b|\bzero\b|\bnothing\b|\bskip(?:ped|s)?\b|\bempty\b|\bevery test\b|\ball tests?\b|\btodo\b|\bregistered no\b/i;
  const VERDICT = /\bpass(?:es|ed|ing)?\b|\bgreen\b|\bok\b|\bsucceeds?\b|\baccepted\b|\bcounts? as\b|\bnever fails?\b|\bsuccess(?:ful(?:ly)?)?\b/i;
  const speaking = t => t.split(/\.(?=\s+[A-Z]|\s*$)/).map(x => x.trim()).filter(Boolean).map(x => x + '.').filter(x => SUBJECT.test(x) && VERDICT.test(x));
  assert.deepEqual(speaking(text), [RULE, COUNTS], 'only the two rule sentences speak of passing and skips, verbatim');
  // Live control of the sweep: every contradiction the reviews found, appended, is caught.
  const SPECIMENS = ['A run with no tests at all passes.', 'An empty file such as x.test.js passes.', 'Skipped tests (e.g. todo) pass.',
    'A file that registered no tests counts as a passing test.', 'A run with zero tests succeeds.', 'A step whose every test was skipped is accepted.',
    'An empty file such as data.test.js passes.', 'A run with no tests never fails.', 'A step whose every test was skipped is a success.',
    'An empty file runs successfully.'];
  for (const specimen of SPECIMENS) assert.deepEqual(speaking(`${text} ${specimen}`), [RULE, COUNTS, specimen], specimen);
});

test('--cwd sets where steps run', t => {
  const dir = tmp(t), sub = path.join(dir, 'where-7b2');
  fs.mkdirSync(sub);
  const log = path.join(dir, 'cwd.log');
  const r = cli(['--spec', writeSpec(dir, [{ name: 'where', argv: [NODE, '-e', 'console.log("cwd=" + require("path").basename(process.cwd()))'], parser: 'none' }]), '--log', log, '--cwd', sub]);
  assert.equal(r.code, 0);
  assert.match(fs.readFileSync(log, 'utf8'), /cwd=where-7b2/);
});

test('durations read as seconds below a minute and minutes with padded seconds from one minute up', async () => {
  const { formatDuration } = await api;
  assert.equal(formatDuration(0), '0s');
  assert.equal(formatDuration(59400), '59s');
  assert.equal(formatDuration(59600), '1m00s');
  assert.equal(formatDuration(60000), '1m00s');
  assert.equal(formatDuration(125000), '2m05s');
  assert.equal(formatDuration(513000), '8m33s');
});
