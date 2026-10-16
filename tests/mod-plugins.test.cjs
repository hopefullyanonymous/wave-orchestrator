'use strict';
// The Claude CLI's own checks on every plugin directory the checkout holds: `claude plugin validate --strict`, the
// loader's static analysis of a hooks module (the real consumer of its source), and `claude plugin test`, the kit
// tests under the directory. The domain is the checkout, so a plugin added anywhere is checked with no edit here;
// each check has a live control on a copy that makes it exit 1.
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { makeRepo } = require('./support/git-fixture.cjs');

const ROOT = fs.realpathSync(path.resolve(__dirname, '..'));
const MISSING = "the Claude Code CLI (claude) must be on PATH for this repository's validation";
const plain = text => text.replace(/\u001b\[[0-?]*[ -\/]*[@-~]/g, '');
const ENV = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== 'NODE_TEST_CONTEXT'));
// Hooks modules are early access: while the server has them off, or the parent sets the variable to 0, `claude plugin test`
// refuses without CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1; the override follows the spread so it wins either way.
const childEnv = parent => ({ ...parent, FORCE_COLOR: '0', NO_COLOR: '1', CLAUDE_CODE_ENABLE_FUNCTION_HOOKS: '1' });
const CHILD_ENV = childEnv(ENV);
// The four events the cost log hooks (orchestrate-mod/hooks/register.js `register`).
const COST_EVENTS = ['session.start', 'agent.spawn', 'turn.step', 'session.end'];

// The CLI as PATH resolves it, or null. Windows accepts only claude.exe, which spawns without a shell, and only
// while PATHEXT lists .exe; elsewhere an executable file named claude. `exists(file)` is the file test, so either
// platform's rule runs on any platform.
function resolveClaude({ platform, PATH = '', PATHEXT = '', exists }) {
  const windows = platform === 'win32', paths = windows ? path.win32 : path.posix;
  if (windows && !PATHEXT.split(';').some(ext => ext.toLowerCase() === '.exe')) return null;
  for (const raw of PATH.split(windows ? ';' : ':')) {
    const dir = windows ? raw.replace(/^"(.*)"$/, '$1') : raw;
    if (dir === '') continue;
    const file = paths.join(dir, windows ? 'claude.exe' : 'claude');
    if (exists(file)) return file;
  }
  return null;
}
function executable(file) {
  try {
    if (!fs.statSync(file).isFile()) return false;
    if (process.platform !== 'win32') fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch { return false; }
}
// The CLI every check runs; its absence fails the test that needs it, never skips it.
function claude(env = process.env, platform = process.platform, exists = executable) {
  const found = resolveClaude({ platform, PATH: env.PATH, PATHEXT: env.PATHEXT, exists });
  if (found === null) assert.fail(MISSING);
  return found;
}
function run(args, env = CHILD_ENV) {
  const r = spawnSync(claude(), args, { cwd: ROOT, env, encoding: 'utf8', shell: false, windowsHide: true, timeout: 60000 });
  assert.ifError(r.error);
  assert.equal(r.signal, null);
  return { status: r.status, stdout: plain(r.stdout), stderr: plain(r.stderr) };
}
// Every plugin directory of the checkout, tracked or not yet: the directory holding each `.claude-plugin/plugin.json`
// that git lists, relative to the root with `/` separators ('.' for the root itself).
function pluginDirs(cwd = ROOT, env = ENV) {
  const r = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd, env, encoding: 'utf8', windowsHide: true });
  assert.ifError(r.error);
  assert.equal(r.status, 0, r.stderr);
  const dirs = r.stdout.split('\0').filter(file => /(?:^|\/)\.claude-plugin\/plugin\.json$/.test(file))
    .map(file => path.posix.dirname(path.posix.dirname(file)));
  return [...new Set(dirs)].sort();
}
function validate(dir) {
  const r = run(['plugin', 'validate', '--strict', '--json', dir]);
  let report = null;
  try { report = JSON.parse(r.stdout); } catch { /* reported below with the output */ }
  return { ...r, report };
}
const notes = report => (report?.contents ?? []).flatMap(c => c.notes ?? []);
const hooksNote = report => notes(report).find(note => / hooks: /.test(note));
// A copy of a plugin directory with every file's line breaks respelled as `eol`: a Git for Windows checkout
// (core.autocrlf) holds the plugin with CRLF, this one may hold it with LF, and both must check alike.
const EOLS = { LF: '\n', CRLF: '\r\n' };
function tempCopy(t, dir, eol) {
  const temp = fs.realpathSync(os.tmpdir()), base = fs.mkdtempSync(path.join(temp, 'mod-plugins-'));
  t.after(() => { assert.equal(path.dirname(base), temp); fs.rmSync(base, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }); });
  const copy = path.join(base, path.basename(dir));
  fs.cpSync(path.join(ROOT, dir), copy, { recursive: true });
  const respell = at => {
    for (const entry of fs.readdirSync(at, { withFileTypes: true })) {
      const file = path.join(at, entry.name);
      if (entry.isDirectory()) respell(file);
      else fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n').replace(/\n/g, eol));
    }
  };
  respell(copy);
  return copy;
}

test('PATH resolution: claude.exe alone on Windows while PATHEXT lists .exe, an executable claude elsewhere, null when absent', () => {
  const on = files => file => files.includes(file);
  const win = { platform: 'win32', PATH: 'C:\\Windows;"C:\\Program Files\\Claude";C:\\tools', PATHEXT: '.COM;.EXE;.BAT;.CMD' };
  assert.equal(resolveClaude({ ...win, exists: on(['C:\\tools\\claude.exe', 'C:\\Program Files\\Claude\\claude.exe']) }), 'C:\\Program Files\\Claude\\claude.exe');
  assert.equal(resolveClaude({ ...win, exists: on(['C:\\Windows\\claude.cmd', 'C:\\Windows\\claude', 'C:\\tools\\claude.bat']) }), null, 'a shim needs a shell');
  assert.equal(resolveClaude({ ...win, PATHEXT: '.COM;.BAT', exists: on(['C:\\tools\\claude.exe']) }), null);
  assert.equal(resolveClaude({ ...win, PATHEXT: '.com;.exe', exists: on(['C:\\tools\\claude.exe']) }), 'C:\\tools\\claude.exe');
  const posix = { platform: 'linux', PATH: '/usr/bin::/home/u/.local/bin' };
  assert.equal(resolveClaude({ ...posix, exists: on(['/home/u/.local/bin/claude']) }), '/home/u/.local/bin/claude');
  assert.equal(resolveClaude({ ...posix, exists: on(['/usr/bin/claude.exe']) }), null);
  assert.equal(resolveClaude({ ...posix, PATH: undefined, exists: () => true }), null);
  assert.equal(resolveClaude({ platform: 'darwin', PATH: '/opt/bin', exists: on(['/opt/bin/claude']) }), '/opt/bin/claude');
});

test('the domain is every plugin.json git lists under a .claude-plugin directory, tracked or untracked, never ignored', t => {
  const repo = makeRepo(t), manifest = '{ "name": "x" }\n';
  repo.write('.gitignore', 'ignored/\n');
  for (const dir of ['tracked/deep', 'ignored']) repo.write(dir + '/.claude-plugin/plugin.json', manifest);
  repo.write('.claude-plugin/plugin.json', manifest);
  repo.write('other/.claude-plugin/plugin.json.bak', manifest);
  repo.write('other/claude-plugin/plugin.json', manifest);
  repo.commit('plugins');
  repo.write('untracked/.claude-plugin/plugin.json', manifest);
  assert.deepEqual(pluginDirs(repo.cwd, repo.env), ['.', 'tracked/deep', 'untracked']);
});

test('the checkout\'s plugin directories include orchestrate-mod, and its manifest is where the domain looks', () => {
  const dirs = pluginDirs();
  assert.ok(dirs.includes('orchestrate-mod'), 'plugin directories found: ' + dirs.join(', '));
  assert.ok(fs.statSync(path.join(ROOT, 'orchestrate-mod', '.claude-plugin', 'plugin.json')).isFile());
});

test('every plugin directory passes claude plugin validate --strict with a hooks note', () => {
  const dirs = pluginDirs();
  assert.ok(dirs.length > 0);
  for (const dir of dirs) {
    const r = validate(dir);
    assert.equal(r.status, 0, `${dir}: validate exited ${r.status}\n${r.stdout}${r.stderr}`);
    assert.equal(r.report?.success, true, `${dir}: ${r.stdout}`);
    assert.ok(hooksNote(r.report), `${dir} has no hooks note: ${JSON.stringify(notes(r.report))}`);
  }
});

test('orchestrate-mod\'s hooks note names the four events of the cost log', () => {
  const note = hooksNote(validate('orchestrate-mod').report);
  const hooked = note.slice(note.indexOf(' hooks: ') + ' hooks: '.length).split(', ').map(hook => hook.replace(/\{.*\}$/, ''));
  for (const event of COST_EVENTS) assert.ok(hooked.includes(event), `${event} is not hooked: ${note}`);
});

test('every plugin directory passes claude plugin test: at least one pass, 0 fail', () => {
  for (const dir of pluginDirs()) {
    const r = run(['plugin', 'test', dir]), out = r.stdout + r.stderr;
    assert.equal(r.status, 0, `${dir}: plugin test exited ${r.status}\n${out}`);
    const passed = /^\s*(\d+) pass$/m.exec(out);
    assert.ok(passed && Number(passed[1]) >= 1, `${dir}: no passing test reported\n${out}`);
    assert.match(out, /^\s*0 fail$/m, `${dir}: ${out}`);
  }
});

test('a parent that turns hooks modules off, in either spelling, cannot refuse the kit tests: the override wins', () => {
  const r = run(['plugin', 'test', 'orchestrate-mod'], childEnv({ ...ENV, CLAUDE_CODE_ENABLE_FUNCTION_HOOKS: '0', claude_code_enable_function_hooks: '0' }));
  const out = r.stdout + r.stderr;
  assert.equal(r.status, 0, out);
  assert.match(out, /^\s*0 fail$/m, out);
});

test('every plugin directory passes both checks alike with LF and with CRLF line breaks', t => {
  for (const dir of pluginDirs()) {
    for (const [name, eol] of Object.entries(EOLS)) {
      const copy = tempCopy(t, dir, eol), v = validate(copy), k = run(['plugin', 'test', copy]), out = k.stdout + k.stderr;
      assert.ok(fs.readFileSync(path.join(copy, '.claude-plugin', 'plugin.json'), 'utf8').includes(eol), `${dir} ${name}: the copy is respelled`);
      assert.deepEqual([v.status, v.report?.success, Boolean(hooksNote(v.report))], [0, true, true], `${dir} ${name}: ${v.stdout}${v.stderr}`);
      assert.equal(k.status, 0, `${dir} ${name}: ${out}`);
      assert.match(out, /^\s*0 fail$/m, `${dir} ${name}: ${out}`);
    }
  }
});

test('live control, LF and CRLF: a hooks module that binds a noun of $ fails validate --strict', t => {
  for (const [name, eol] of Object.entries(EOLS)) {
    const copy = tempCopy(t, 'orchestrate-mod', eol), file = path.join(copy, 'hooks', 'register.js');
    const source = fs.readFileSync(file, 'utf8'), anchor = /export function register\(on\) \{(\r?\n)/.exec(source);
    assert.ok(anchor, name + ': the control\'s anchor is missing from register.js');
    assert.equal(anchor[1], eol, name + ': the anchor carries the copy\'s line break');
    const at = anchor.index + anchor[0].length;
    const alias = "  on('turn.complete', async ($, e, next) => { const session = $.session; return next(e); });" + eol;
    fs.writeFileSync(file, source.slice(0, at) + alias + source.slice(at));
    const r = validate(copy);
    assert.equal(r.status, 1, name + ': ' + r.stdout + r.stderr);
    assert.equal(r.report?.success, false, name);
    assert.match(r.stdout, /is used as a value/, name);
  }
});

test('live control, LF and CRLF: a failing kit test fails claude plugin test', t => {
  for (const [name, eol] of Object.entries(EOLS)) {
    const copy = tempCopy(t, 'orchestrate-mod', eol);
    fs.writeFileSync(path.join(copy, 'tests', 'control.test.tsx'),
      "import { expect, test } from 'claude-code/testing'" + eol + "test('the live control fails', () => { expect(1).toBe(2) })" + eol);
    const r = run(['plugin', 'test', copy]), out = r.stdout + r.stderr;
    assert.equal(r.status, 1, name + ': ' + out);
    assert.match(out, /^\s*1 fail$/m, name);
  }
});

test('a missing CLI fails with the stated message, never a skip', () => {
  for (const platform of ['linux', 'win32']) {
    assert.throws(() => claude({ PATH: '/opt/bin;C:\\tools', PATHEXT: '.EXE' }, platform, () => false), error => error.message === MISSING, platform);
    assert.ok(claude({ PATH: '/opt/bin', PATHEXT: '.EXE' }, platform, () => true), platform + ': the control, a CLI found');
  }
  assert.ok(path.isAbsolute(claude()), 'the CLI this run uses: ' + claude());
});
