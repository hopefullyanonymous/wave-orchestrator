'use strict';
// Every tool CLI runs the same through a linked path as through its real one. Node resolves the entry
// script's import.meta.url through links but leaves process.argv[1] as typed, so an entry check that
// compared the two unresolved skipped the CLI body and exited 0 with no output through any linked
// directory or file — the README's own install — and a gate that reads exit 0 as PASS cleared work it
// never examined (BL-028). The domain is the tools directory as checked out, never a hand list: a new
// tool is covered here with no edit.
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');

// The checkout's real path: a control run through a linked component would share the defect it controls.
const SKILL = path.join(fs.realpathSync(path.resolve(__dirname, '..')), 'orchestrate');
const TOOLS = path.join(SKILL, 'tools');
const NODE = process.execPath;
// Every script the directory holds, whatever runs it.
const SCRIPTS = fs.readdirSync(TOOLS).filter(name => /\.(?:mjs|cjs|js)$/.test(name)).sort();
const SOURCES = new Map(SCRIPTS.map(name => [name, fs.readFileSync(path.join(TOOLS, name), 'utf8')]));
// A top-level `if` whose condition reads import.meta.url: an entry check, whatever it compares. Read
// with LF breaks, so a CRLF checkout finds the same ones.
const GUARD = /^if \(.*\bimport\.meta\.url\b.*\) \{$/gm;
const guardsIn = text => text.replace(/\r\n/g, '\n').match(GUARD) || [];
const guards = name => guardsIn(SOURCES.get(name));
const GUARDED = SCRIPTS.filter(name => guards(name).length > 0);
// What only a CLI touches: a library that reads or writes any of it is a CLI with no entry check.
const CLI_STATE = /\bprocess\.(?:argv|exit|exitCode|stdout|stderr)\b/;
// A refused entry: one line on stderr, naming the tool.
const REFUSAL = /^[A-Za-z0-9._-]+\.mjs: not run: /;
// Child output is compared raw, and matched only once stripped: a colour terminal paints it.
const plain = text => text.replace(/\u001b\[[0-?]*[ -\/]*[@-~]/g, '');
const ENV = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== 'NODE_TEST_CONTEXT'));

function tempDir(t) {
  const temp = fs.realpathSync(os.tmpdir()), dir = fs.mkdtempSync(path.join(temp, 'cli-entry-'));
  t.after(() => { assert.equal(path.dirname(dir), temp); fs.rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }); });
  return dir;
}
function run(args, cwd) {
  const r = spawnSync(NODE, args, { cwd, env: ENV, encoding: 'utf8', windowsHide: true, timeout: 60000 });
  assert.ifError(r.error); assert.equal(r.signal, null);
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}
// A file link where the platform grants one. Windows without Developer Mode refuses it with EPERM,
// and with nothing else: there the directory junction carries the platform.
function fileLink(target, link) {
  try { fs.symlinkSync(target, link, 'file'); return true; }
  catch (e) {
    assert.equal(process.platform, 'win32', 'a file link failed off Windows: ' + e.code);
    assert.equal(e.code, 'EPERM', 'the one refusal accepted for a file link is EPERM');
    return false;
  }
}

test('the domain is every script in the tools directory: each is a guarded CLI or a library that touches no CLI state', () => {
  assert.ok(SCRIPTS.length > GUARDED.length, 'the libraries are in the listing too: ' + SCRIPTS.join(', '));
  assert.ok(GUARDED.length >= 8, 'guarded CLIs found: ' + GUARDED.join(', '));
  for (const name of GUARDED) assert.equal(guards(name).length, 1, name + ': one entry check');
  for (const name of SCRIPTS.filter(n => !GUARDED.includes(n))) assert.doesNotMatch(SOURCES.get(name), CLI_STATE, name + ' has no entry check but touches CLI state');
  // Live control of the partition: a CLI body with no entry check is caught.
  assert.match('process.exitCode = output.code;', CLI_STATE);
  assert.equal(guardsIn('if (isMain(import.meta.url)) {\n').length, 1);
  // The same verdict whatever line breaks the checkout gave the sources.
  for (const name of SCRIPTS) assert.deepEqual(guardsIn(SOURCES.get(name).replace(/\r?\n/g, '\r\n')), guards(name), name + ' read as CRLF');
});

const ran = new Set();
for (const name of GUARDED) {
  test(`${name} prints the same, with the same exit code, through a linked directory and a linked file as through its real path`, t => {
    const tmp = tempDir(t), real = path.join(TOOLS, name);
    const control = run([real, '--help'], tmp);
    // The live control: the CLI body ran, and did not refuse.
    assert.ok(control.stdout.length + control.stderr.length > 0, name + ': the real path prints nothing');
    assert.doesNotMatch(plain(control.stderr), REFUSAL, name + ': the real path is refused');
    // The installed skill is a link to the clone's orchestrate directory; 'junction' makes one on Windows too.
    const skill = path.join(tmp, 'linked skill');
    fs.symlinkSync(SKILL, skill, 'junction');
    assert.ok(fs.lstatSync(skill).isSymbolicLink(), 'the directory link exists');
    assert.deepEqual(run([path.join(skill, 'tools', name), '--help'], tmp), control, name + ' through a linked directory');
    // Where node keeps the linked path as the entry's URL, the check resolves that side too.
    assert.deepEqual(run(['--preserve-symlinks-main', path.join(skill, 'tools', name), '--help'], tmp), control, name + ' through a linked directory, its link preserved');
    const file = path.join(tmp, 'linked file', name);
    fs.mkdirSync(path.dirname(file));
    if (fileLink(real, file)) {
      assert.ok(fs.lstatSync(file).isSymbolicLink(), 'the file link exists');
      assert.deepEqual(run([file, '--help'], tmp), control, name + ' through a linked file');
    }
    ran.add(name);
  });

  test(`${name} imported by another script under its own file name refuses in one line with exit 2; under any other entry it is a silent library`, t => {
    const tmp = tempDir(t), url = pathToFileURL(path.join(TOOLS, name)).href;
    const own = path.join(tmp, 'own', name), other = path.join(tmp, 'other', 'wrapper-' + name);
    for (const file of [own, other]) { fs.mkdirSync(path.dirname(file)); fs.writeFileSync(file, `import ${JSON.stringify(url)};\n`); }
    const refused = run([own, '--help'], tmp);
    assert.equal(refused.stdout, '', name + ': nothing ran');
    assert.equal(refused.status, 2, name + ': ' + refused.stderr);
    const lines = plain(refused.stderr).split('\n');
    assert.deepEqual(lines.slice(1), [''], name + ': one line: ' + refused.stderr);
    assert.match(lines[0], REFUSAL);
    // It names the entry and the module (compared case-folded: a Windows drive letter may differ in case).
    const said = lines[0].toLowerCase();
    assert.ok(lines[0].startsWith(name + ': not run: ') && said.includes(own.toLowerCase()) && said.includes(path.join(TOOLS, name).toLowerCase()), lines[0]);
    // The other side of the boundary: another file name, an entry that names no file (node -e with
    // an argument), or no entry at all (node -e alone) is an import, which runs and prints nothing.
    assert.deepEqual(run([other, '--help'], tmp), { status: 0, stdout: '', stderr: '' }, name + ' imported under another name');
    assert.deepEqual(run(['--input-type=module', '-e', `import ${JSON.stringify(url)};`, 'no-such-entry.mjs'], tmp), { status: 0, stdout: '', stderr: '' }, name + ' imported under an entry no file backs');
    assert.deepEqual(run(['--input-type=module', '-e', `import ${JSON.stringify(url)};`], tmp), { status: 0, stdout: '', stderr: '' }, name + ' imported with no entry');
    // The refusal stays one line whatever the entry's path holds. A newline is legal in a POSIX
    // file name; Windows refuses one, which is asserted there rather than skipped.
    const broken = path.join(tmp, 'line\nbreak');
    let made = true;
    try { fs.mkdirSync(broken); } catch (e) { assert.equal(process.platform, 'win32', 'a directory named with a newline failed off Windows: ' + e.code); made = false; }
    if (made) {
      fs.writeFileSync(path.join(broken, name), `import ${JSON.stringify(url)};\n`);
      const odd = run([path.join(broken, name), '--help'], tmp), oddLines = plain(odd.stderr).split('\n');
      assert.deepEqual([odd.status, odd.stdout, oddLines.slice(1)], [2, '', ['']], name + ': one line from a path holding a newline: ' + JSON.stringify(odd.stderr));
      assert.ok(oddLines[0].startsWith(name + ': not run: ') && oddLines[0].includes('line?break'), oddLines[0]);
    }
  });
}

test('every guarded CLI in the listing ran through both links', () => {
  assert.deepEqual([...ran].sort(), GUARDED);
});
