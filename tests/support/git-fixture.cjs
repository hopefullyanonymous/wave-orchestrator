const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');


const LEDGER = '.agents/changes/FIXTURE';
const ARCHIVE = '.agents/archive/FIXTURE';
const MAIN = 'refs/heads/main';
const INTEGRATION = 'refs/heads/chore/fixture-ledger';

function makeRepo(t) {
  const temp = fs.realpathSync(os.tmpdir());
  const root = fs.mkdtempSync(path.join(temp, 'orchestrate-git-'));
  t.after(() => {
    // Only remove the exact disposable directory created by this test.
    const resolved = fs.realpathSync(root);
    assert.equal(resolved, root);
    assert.equal(path.dirname(resolved), temp);
    assert.ok(path.basename(resolved).startsWith('orchestrate-git-'));
    fs.rmSync(resolved, { recursive: true, maxRetries: 10, retryDelay: 100 });
  });
  const emptyConfig = path.join(root, 'empty.gitconfig');
  const emptyHooks = path.join(root, 'empty-hooks');
  const emptyTemplate = path.join(root, 'empty-template');
  fs.writeFileSync(emptyConfig, '');
  fs.mkdirSync(emptyHooks);
  fs.mkdirSync(emptyTemplate);

  // Do not inherit repository overrides, identity, templates or injected -c
  // settings. Isolate Git's config without changing the process's HOME.
  const env = Object.fromEntries(Object.entries(process.env)
    .filter(([key]) => !/^GIT_/i.test(key)));
  Object.assign(env, {
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: emptyConfig,
    GIT_TERMINAL_PROMPT: '0',
  });
  const config = [
    '-c', 'user.name=Orchestrate Fixture', '-c', 'user.email=fixture@example.invalid',
    '-c', 'commit.gpgSign=false', '-c', 'tag.gpgSign=false',
    '-c', `core.hooksPath=${emptyHooks}`, '-c', 'core.autocrlf=false',
    '-c', 'protocol.allow=never', '-c', 'protocol.file.allow=always',
  ];

  function at(cwd) {
    // probe() permits expected Git failures, but never hides process-launch errors.
    function probe(...args) {
      const result = spawnSync('git', [...config, ...args], {
        cwd, env, encoding: 'utf8', shell: false, windowsHide: true, timeout: 15000,
      });
      if (result.error) throw result.error;
      assert.equal(result.signal, null, `git ${args.join(' ')} terminated by signal`);
      assert.notEqual(result.status, null, 'Git must return an exit code');
      return { status: result.status, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
    }
    // All fixture construction uses git(): a bad setup command fails immediately.
    function git(...args) {
      const result = probe(...args);
      assert.equal(result.status, 0,
        `Fixture command failed in ${cwd}: git ${args.join(' ')}\n${result.stderr}`);
      return result.stdout;
    }
    function write(file, content) {
      const destination = path.join(cwd, file);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, content);
    }
    function commit(message) {
      git('add', '--all');
      git('commit', '--allow-empty', '-m', message);
      return git('rev-parse', '--verify', 'HEAD^{commit}');
    }
    function snapshot() {
      const gitDir = path.resolve(cwd, git('rev-parse', '--git-dir'));
      const files = {};
      const walk = (dir, prefix = '') => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : 1)) {
          if (entry.name === '.git') continue;
          const name = prefix + entry.name, file = path.join(dir, entry.name);
          if (entry.isDirectory()) walk(file, name + '/');
          else files[name] = entry.isSymbolicLink() ? { link: fs.readlinkSync(file) } : fs.readFileSync(file).toString('base64');
        }
      };
      if (git('rev-parse', '--is-bare-repository') !== 'true') walk(cwd);
      return { refs: git('for-each-ref', '--format=%(refname) %(objectname) %(symref)'),
        head: fs.readFileSync(path.join(gitDir, 'HEAD')).toString('base64'),
        index: fs.existsSync(path.join(gitDir, 'index')) ? fs.readFileSync(path.join(gitDir, 'index')).toString('base64') : null, files };
    }
    function cli(tool, args = [], customEnv = {}) {
      const executable = path.resolve(__dirname, '../../orchestrate/tools', tool);
      const r = spawnSync(process.execPath, [executable, ...args], { cwd, env: { ...env, ...customEnv }, encoding: 'utf8', shell: false, windowsHide: true, timeout: 60000, maxBuffer: 16 * 1024 * 1024 });
      assert.ifError(r.error); assert.equal(r.signal, null);
      return { status: r.status, stdout: r.stdout, stderr: r.stderr, json: args.includes('--help') ? null : JSON.parse(r.stdout) };
    }
    return { cwd, probe, git, write, commit, env, snapshot, cli };
  }

  function init(name, bare = false) {
    const cwd = path.join(root, name);
    fs.mkdirSync(cwd);
    const repo = at(cwd);
    repo.git('init', '--initial-branch=main', `--template=${emptyTemplate}`, ...(bare ? ['--bare'] : []));
    return repo;
  }
  const repo = init('repo');
  const base = repo.commit('base');
  function remote() {
    const bare = init('origin.git', true);
    repo.git('remote', 'add', 'origin', bare.cwd);
    repo.git('push', 'origin', `${base}:${MAIN}`);
    return bare;
  }
  return { ...repo, root, base, remote, at };
}


module.exports = { makeRepo, LEDGER, ARCHIVE, MAIN, INTEGRATION };
