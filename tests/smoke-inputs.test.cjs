const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const test = require('node:test');
const FIXTURES = path.join(__dirname, 'fixtures/smoke-inputs');
const rawHash = bytes => createHash('sha256').update(bytes).digest('hex');
let inputs;
test.before(async () => { inputs = await import(pathToFileURL(path.join(__dirname, '../orchestrate/tools/smoke-inputs.mjs'))); });

function makeRepo(t) {
  const temp = fs.realpathSync(os.tmpdir()), root = fs.mkdtempSync(path.join(temp, 'smoke-bytes-git-'));
  t.after(() => { assert.equal(path.dirname(fs.realpathSync(root)), temp); fs.rmSync(root, { recursive: true, maxRetries: 8, retryDelay: 100 }); });
  const cwd = path.join(root, 'repo'); fs.mkdirSync(cwd);
  const empty = path.join(root, 'empty'); fs.writeFileSync(empty, '');
  const hooks = path.join(root, 'hooks'), template = path.join(root, 'template'); fs.mkdirSync(hooks); fs.mkdirSync(template);
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key))),
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: empty, GIT_TERMINAL_PROMPT: '0' };
  const config = ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgSign=false',
    '-c', 'core.autocrlf=false', '-c', 'core.hooksPath=' + hooks];
  const git = (...args) => {
    const r = spawnSync('git', [...config, ...args], { cwd, env, encoding: 'utf8', windowsHide: true });
    assert.ifError(r.error); assert.equal(r.status, 0, r.stderr); return r.stdout.trim();
  };
  git('init', '--initial-branch=main', '--template=' + template);
  const write = (file, bytes) => { const p = path.join(cwd, file); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, bytes); };
  const commit = message => { git('add', '--all'); git('commit', '--allow-empty', '-m', message); return git('rev-parse', 'HEAD'); };
  return { root, cwd, env, git, write, commit };
}

function fixture(t) {
  const temp = fs.realpathSync(os.tmpdir()), root = fs.mkdtempSync(path.join(temp, 'smoke-inputs-'));
  t.after(() => { assert.equal(path.dirname(fs.realpathSync(root)), temp); fs.rmSync(root, { recursive: true, maxRetries: 8, retryDelay: 100 }); });
  const write = (file, bytes) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); fs.writeFileSync(path.join(root, file), bytes);
    return { path: file, size: Buffer.byteLength(bytes), sha256: rawHash(bytes) };
  };
  const workbook = fs.readFileSync(path.join(FIXTURES, 'orders.xlsx'));
  assert.equal(rawHash(workbook), 'e5544604e81a378431842516d9dad722f4ba650ce4b9efb2850920ac4199469f', 'exercise the actual independently validated B02 workbook');
  const report = write('evidence/C1/inputs/validation-001/report.txt', 'Independent validation evidence: fixture checks passed.\n');
  const input = { id: 'orders', ...write('evidence/C1/inputs/issue-001/orders.xlsx', workbook),
    requirements: 'Orders/Summary/Types, leading-zero IDs, formulas/caches, total 23.50/count 4.',
    validation: { ...report, command: 'python validate-orders.py orders.xlsx orders.requirements.json', exitCode: 0,
      result: 'All sheet/cell/type/formula/cache requirements passed.', env: 'B02 fixture semantics independently validated; this test checks delivery bytes.' },
    mode: 'working-copy', use: 'Copy original to a disposable workbook.', reset: 'Close the copy and recopy the preserved original.' };
  const data = { inputs: [input], sections: [{ n: 1, steps: [{ n: 1, inputs: ['orders'] }, { n: 2, inputs: ['orders'] }, { n: 3 }] }] };
  return { root, write, input, data, report, workbook };
}

test('real workbook declarations resolve shared stable IDs without mutating metadata', t => {
  const f = fixture(t), original = JSON.stringify(f.data), d = inputs.declareInputs(f.data);
  assert.equal(d.byStep.get(1)[0], f.input); assert.equal(d.byStep.get(2)[0], f.input);
  assert.deepEqual(d.byStep.get(3), []);
  assert.doesNotThrow(() => inputs.validateInputFiles(d, f.root));
  assert.throws(() => inputs.validateInputFiles(d), /explicit inputRoot/);
  assert.equal(JSON.stringify(f.data), original);
  assert.doesNotThrow(() => inputs.validateInputFiles(inputs.declareInputs({ sections: [] })));
});

test('incomplete or ambiguous declarations never become inputs', t => {
  const f = fixture(t);
  const bad = [
    [d => delete d.inputs[0].id, /stable nonempty id/],
    [d => d.inputs.push(structuredClone(d.inputs[0])), /duplicate input id/],
    [d => { d.inputs = {}; }, /registry array/],
    [d => { d.inputHistory = {}; }, /inputHistory must be an array/],
    [d => { d.sections[0].steps[0].inputs = ['missing']; }, /dangling/],
    [d => { d.sections[0].steps[0].inputs = ['orders', 'orders']; }, /repeats/],
    [d => { d.sections[0].steps[0].inputs = 'orders'; }, /array of input ids/],
    [d => { d.sections[0].steps[0].inputFiles = []; }, /reserved/],
    [d => { d.inputs[0].size = -1; }, /size/],
    [d => { d.inputs[0].size = '8634'; }, /size/],
    [d => { d.inputs[0].sha256 = 'a'.repeat(40); }, /SHA-256/],
    [d => { d.inputs[0].sha256 = 'A'.repeat(64); }, /SHA-256/],
    [d => { d.inputs[0].mode = 'edit-original'; }, /mode/],
    [d => { d.inputs[0].validation.exitCode = 1; }, /exitCode/],
    [d => { d.inputs[0].validation.exitCode = '0'; }, /exitCode/],
    [d => { d.inputs[0].validation = null; }, /object/]
  ];
  for (const field of ['path', 'sha256', 'size', 'requirements', 'validation', 'mode', 'use', 'reset']) {
    bad.push([d => delete d.inputs[0][field], new RegExp(field === 'validation' ? 'object' : field)]);
  }
  for (const field of ['path', 'sha256', 'size', 'command', 'result', 'env']) bad.push([d => delete d.inputs[0].validation[field], new RegExp(field)]);
  for (const [edit, message] of bad) { const d = structuredClone(f.data); edit(d); assert.throws(() => inputs.declareInputs(d), message); }
});

test('portable input paths reject absolute, traversal and Windows alias spellings', t => {
  const f = fixture(t);
  for (const name of ['/tmp/file', 'C:/file', 'C:file', '//host/share', '..', '../file', 'a/../file',
    'a/./file', 'a//file', 'a\\file', 'a\0file', 'a\nfile', 'a.', 'a ', 'NUL.txt', 'con', 'a/COM1.xlsx', 'a/',
    'a?file', 'a*file', 'a"file', 'a|file', 'a<file', 'a>file']) {
    for (const where of ['input', 'validation', 'history']) {
      const d = structuredClone(f.data);
      if (where === 'input') d.inputs[0].path = name;
      else if (where === 'validation') d.inputs[0].validation.path = name;
      else d.inputHistory = [{ ...f.report, path: name }];
      assert.throws(() => inputs.declareInputs(d), /safe relative/, `${where}: ${JSON.stringify(name)}`);
    }
  }
  const collision = structuredClone(f.data);
  collision.inputHistory = [{ ...f.report, path: f.report.path.toUpperCase() }];
  assert.throws(() => inputs.declareInputs(collision), /conflicting issued input path/);
});

test('disk checks reject missing files, directories, altered reports and stale raw hashes', t => {
  const f = fixture(t), d = inputs.declareInputs(f.data), workbook = path.join(f.root, f.input.path);
  fs.unlinkSync(workbook); assert.throws(() => inputs.validateInputFiles(d, f.root), /input artifact.*ENOENT/);
  fs.mkdirSync(workbook); assert.throws(() => inputs.validateInputFiles(d, f.root), /not a regular file/);
  fs.rmdirSync(workbook); fs.writeFileSync(workbook, f.workbook);
  const tampered = Buffer.from(f.workbook); tampered[100] ^= 1; fs.writeFileSync(workbook, tampered);
  assert.throws(() => inputs.validateInputFiles(d, f.root), /SHA-256 mismatch/);
  fs.writeFileSync(workbook, f.workbook);
  const report = path.join(f.root, f.report.path), bytes = fs.readFileSync(report);
  const altered = Buffer.from(bytes); altered[0] ^= 1; fs.writeFileSync(report, altered);
  assert.throws(() => inputs.validateInputFiles(d, f.root), /report.txt.*SHA-256 mismatch/);
  fs.unlinkSync(report); assert.throws(() => inputs.validateInputFiles(d, f.root), /report.txt.*ENOENT/);
});

test('LF, CRLF, BOM and whitespace are significant raw bytes', t => {
  const f = fixture(t);
  const source = Buffer.from('A line\nAnother é line\n');
  Object.assign(f.input, f.write('evidence/C1/inputs/issue-001/raw.txt', source));
  const d = inputs.declareInputs(f.data);
  for (const mutated of [Buffer.from(source.toString().replace(/\n/g, '\r\n')), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), source]),
    Buffer.concat([source, Buffer.from(' ')]), Buffer.from(source.toString().replace('A', 'B'))]) {
    fs.writeFileSync(path.join(f.root, f.input.path), mutated);
    assert.throws(() => inputs.validateInputFiles(d, f.root), /size mismatch|SHA-256 mismatch/);
    const wrongDigest = structuredClone(f.data); wrongDigest.inputs[0].size = mutated.length;
    assert.throws(() => inputs.validateInputFiles(inputs.declareInputs(wrongDigest), f.root), /SHA-256 mismatch/,
      'the hash itself must reject normalization even when byte size metadata was updated');
  }
  fs.writeFileSync(path.join(f.root, f.input.path), source);
  assert.doesNotThrow(() => inputs.validateInputFiles(d, f.root));
});

test('symlink or junction inputs and evidence cannot escape the delivery root', t => {
  const f = fixture(t);
  const external = fixture(t).root;
  fs.writeFileSync(path.join(external, 'data.txt'), 'outside');
  const link = path.join(f.root, 'redirect');
  fs.symlinkSync(external, link, process.platform === 'win32' ? 'junction' : 'dir');
  for (const place of ['input', 'validation', 'history']) {
    const data = structuredClone(f.data), target = { path: 'redirect/data.txt', sha256: rawHash(Buffer.from('outside')), size: 7 };
    if (place === 'input') Object.assign(data.inputs[0], target);
    else if (place === 'validation') Object.assign(data.inputs[0].validation, target);
    else data.inputHistory = [target];
    assert.throws(() => inputs.validateInputFiles(inputs.declareInputs(data), f.root), /symbolic links are not permitted/);
  }
});

test('history comparison is metadata-only but requires retention of input and shared evidence across later issues', t => {
  const f = fixture(t), old = inputs.declareInputs(f.data), next = structuredClone(f.data);
  const second = { ...f.input, id: 'orders-copy' }; next.inputs.push(second);
  next.sections[0].steps[1].inputs = ['orders-copy'];
  assert.doesNotThrow(() => inputs.compareInputHistory(inputs.declareInputs(next), old));
  const before = inputs.declareInputs(next);
  next.inputs = []; next.sections[0].steps.forEach(s => { s.inputs = []; });
  assert.throws(() => inputs.compareInputHistory(inputs.declareInputs(next), before), /missing from inputs\/inputHistory.*orders.xlsx/);
  next.inputHistory = [{ path: f.input.path, sha256: f.input.sha256, size: f.input.size }];
  assert.throws(() => inputs.compareInputHistory(inputs.declareInputs(next), before), /missing.*report.txt/);
  next.inputHistory.push(f.report);
  assert.doesNotThrow(() => inputs.compareInputHistory(inputs.declareInputs(next), before));
  // A later sidecar must carry history forward, even after no live step uses it.
  const later = structuredClone(next); later.inputHistory.pop();
  assert.throws(() => inputs.compareInputHistory(inputs.declareInputs(later), inputs.declareInputs(next)), /missing.*report.txt/);
  const changed = structuredClone(next); changed.inputHistory[0].sha256 = '0'.repeat(64);
  assert.throws(() => inputs.compareInputHistory(inputs.declareInputs(changed), before), /immutable/);
  fs.unlinkSync(path.join(f.root, f.input.path));
  assert.doesNotThrow(() => inputs.compareInputHistory(inputs.declareInputs(next), before), 'metadata comparison does not pretend old bytes are current files');
  assert.throws(() => inputs.validateInputFiles(inputs.declareInputs(next), f.root), /orders.xlsx.*ENOENT/);
});

test('actual scoped attributes preserve fixture, active and archived raw bytes in a fresh autocrlf checkout', t => {
  const repo = makeRepo(t), source = new Map();
  repo.write('.gitattributes', fs.readFileSync(path.join(__dirname, '../.gitattributes')));
  const remember = (p, bytes) => { repo.write(p, bytes); source.set(p, rawHash(bytes)); };
  for (const name of ['orders.xlsx', 'orders.requirements.json', 'generate-orders.py', 'validate-orders.py']) {
    const bytes = fs.readFileSync(path.join(FIXTURES, name));
    remember('tests/fixtures/smoke-inputs/' + name, bytes);
    for (const where of ['changes', 'archive']) remember(`.agents/${where}/BYTES/evidence/C1/inputs/issue-001/${name}`, bytes);
  }
  for (const where of ['changes', 'archive']) {
    for (const [name, bytes] of [['lf.txt', Buffer.from('one\ntwo\n')], ['crlf.txt', Buffer.from('one\r\ntwo\r\n')],
      ['nested/evidence.json', Buffer.from('{"validated":true}\n')]]) remember(`.agents/${where}/BYTES/evidence/C1/inputs/issue-001/${name}`, bytes);
  }
  repo.write('conversion-control.txt', 'one\ntwo\n');
  const commit = repo.commit('real protected package');
  const checkout = path.join(repo.root, 'checkout');
  // Fixture helpers force autocrlf=false, so the checkout commands deliberately
  // use the isolated env directly. Local true is effective before the first checkout.
  function git(args, cwd = repo.cwd) {
    const r = spawnSync('git', args, { cwd, env: repo.env, encoding: 'utf8', shell: false, windowsHide: true });
    assert.ifError(r.error); assert.equal(r.status, 0, r.stderr); return r.stdout.trim();
  }
  git(['clone', '--no-checkout', '--no-hardlinks', repo.cwd, checkout]);
  git(['config', '--local', 'core.autocrlf', 'true'], checkout);
  assert.equal(git(['config', '--get', 'core.autocrlf'], checkout), 'true');
  git(['checkout', '--detach', commit], checkout);
  for (const [file, expected] of source) {
    const actual = fs.readFileSync(path.join(checkout, file));
    assert.equal(rawHash(actual), expected, file);
    const attributes = git(['check-attr', 'text', 'eol', 'filter', 'ident', 'working-tree-encoding', '--', file], checkout);
    assert.equal(attributes.split('\n').length, 5);
    assert.ok(attributes.split('\n').every(line => line.endsWith(': unset')), attributes);
    if (file.endsWith('.xlsx')) assert.ok(git(['check-attr', 'diff', 'merge', '--', file], checkout).split('\n').every(line => line.endsWith(': unset')));
  }
  assert.equal(fs.readFileSync(path.join(checkout, 'conversion-control.txt'), 'utf8'), 'one\r\ntwo\r\n', 'unprotected control proves conversion was effective');
  assert.equal(source.size, 18);
});
