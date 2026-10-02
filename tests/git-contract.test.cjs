const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { makeRepo, LEDGER, ARCHIVE, MAIN, INTEGRATION } = require('./support/git-fixture.cjs');
const api = import('../orchestrate/tools/git-evidence.mjs');
const options = repo => ({ repo: repo.cwd, env: repo.env });
function writeLedger(repo, { id = 'FIXTURE', defaultRef = MAIN, state = 'ACTIVE' } = {}) {
  const dir = `.agents/changes/${id}`;
  repo.write(`${dir}/PROGRESS.md`, `**Identifier**: ${id}\n**State**: ${state}\n`);
  repo.write(`${dir}/00-READBEFORE.md`, `Default branch (protected local ref): ${defaultRef}\nIntegration branch: ${INTEGRATION}\nShipment source: local\nShipment ref: ${defaultRef}\n`);
}
function complete(result) { assert.equal(result.completeness, 'complete', JSON.stringify(result.diagnostics)); return result.evidence; }
function unknown(result) { assert.notEqual(result.completeness, 'complete'); assert.equal(result.evidence.result, 'unknown'); assert.ok(result.diagnostics.length); }
function cli(repo, operation, args = []) { return repo.cli('git-evidence.mjs', [operation, '--repo', repo.cwd, ...args]); }

test('deleted origin/HEAD supplies no hint despite a checked-out feature branch', async t => {
  const repo = makeRepo(t); repo.remote();
  repo.git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
  repo.git('symbolic-ref', '--delete', 'refs/remotes/origin/HEAD'); repo.git('checkout', '-b', 'feature/current'); repo.git('config', 'init.defaultBranch', 'master');
  const e = complete((await api).discovery(options(repo)));
  assert.equal(e.refs.some(r => r.symref), false);
  assert.equal(e.refs.find(r => r.ref === MAIN).sha, repo.base);
  assert.equal(e.worktrees[0].branch, 'refs/heads/feature/current');
  assert.equal(Object.hasOwn(e, 'defaultBranch'), false);
});
test('main and master can coexist without a remote HEAD to choose between them', async t => {
  const repo = makeRepo(t); repo.git('branch', 'master');
  const e = complete((await api).discovery(options(repo)));
  assert.deepEqual(e.refs, [{ ref: MAIN, sha: repo.base, symref: null }, { ref: 'refs/heads/master', sha: repo.base, symref: null }]);
});
test('a successful origin/HEAD lookup can still name a missing target', async t => {
  const repo = makeRepo(t); repo.git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/old-main');
  const e = complete((await api).discovery(options(repo)));
  assert.deepEqual(e.refs.find(r => r.ref === 'refs/remotes/origin/HEAD'), { ref: 'refs/remotes/origin/HEAD', sha: null, symref: 'refs/remotes/origin/old-main' });
  unknown((await api).ancestry({ ...options(repo), ancestor: 'refs/remotes/origin/old-main', descendant: MAIN }));
});
test('the all-branch probe finds merged, custom, shallow and remote-only ledgers without a default hint', async t => {
  const repo = makeRepo(t); repo.git('checkout', '-b', 'custom/work'); writeLedger(repo); repo.commit('custom ledger');
  repo.git('branch', 'foo-ledger'); repo.git('checkout', 'main'); repo.git('merge', '--ff-only', 'custom/work');
  repo.git('checkout', '-b', 'temporary-remote-work', repo.base); writeLedger(repo, { id: 'REMOTE' });
  const remoteOnly = repo.commit('remote ledger'); repo.git('update-ref', 'refs/remotes/upstream/custom', remoteOnly);
  repo.git('symbolic-ref', 'refs/remotes/upstream/HEAD', 'refs/remotes/upstream/custom');
  repo.git('checkout', '-b', 'archive-only', repo.base); repo.write('.agents/archive/OLD/PROGRESS.md', '**State**: COMPLETE\n'); repo.commit('archive');
  repo.git('checkout', 'main'); repo.git('branch', '-D', 'temporary-remote-work');
  repo.write('.agents/changes/WORKING/PROGRESS.md', '**State**: ACTIVE\n'); repo.write('.agents/changes/empty/ignore', '');
  const before = repo.snapshot(); const e = complete((await api).discovery(options(repo)));
  assert.deepEqual(e.ledgers.map(l => l.id), ['FIXTURE', 'REMOTE', 'WORKING']);
  assert.deepEqual(e.ledgers[0].locations.filter(l => l.kind === 'ref').map(l => l.ref), ['refs/heads/custom/work', 'refs/heads/foo-ledger', MAIN]);
  assert.equal(e.ledgers[1].locations[0].ref, 'refs/remotes/upstream/custom');
  assert.ok(e.refs.find(r => r.ref === 'refs/remotes/upstream/HEAD').symref);
  assert.equal(e.ledgers[2].locations[0].cleanliness, 'dirty'); assert.deepEqual(repo.snapshot(), before);
});
test('ancestry distinguishes equal/contained, not-contained and unavailable objects', async t => {
  const repo = makeRepo(t), later = repo.commit('later'), { ancestry } = await api;
  for (const [a, d, result] of [[repo.base, repo.base, 'contained'], [repo.base, later, 'contained'], [later, repo.base, 'not-contained']]) {
    assert.deepEqual(complete(ancestry({ ...options(repo), ancestor: a, descendant: d })), { ancestorSha: a, descendantSha: d, result });
  }
  unknown(ancestry({ ...options(repo), ancestor: 'refs/heads/absent', descendant: repo.base }));
});
test('an unpushed merge is contained locally but not on the recorded remote', async t => {
  const repo = makeRepo(t); repo.remote(); repo.git('checkout', '-b', 'chore/fixture-ledger'); const sha = repo.commit('work'); repo.git('checkout', 'main'); repo.git('merge', '--ff-only', INTEGRATION);
  const { shipment } = await api;
  assert.equal(complete(shipment({ ...options(repo), integration: INTEGRATION, source: 'local', ref: MAIN })).result, 'contained');
  assert.deepEqual(complete(shipment({ ...options(repo), integration: INTEGRATION, source: 'remote', remote: 'origin', ref: MAIN })), { source: 'remote', remote: 'origin', ref: MAIN, integrationSha: sha, shipmentSha: repo.base, result: 'not-contained' });
});
test('a stale local default does not disprove a merge into the recorded remote', async t => {
  const repo = makeRepo(t); repo.remote(); repo.git('checkout', '-b', 'chore/fixture-ledger'); repo.commit('work'); repo.git('push', 'origin', `${INTEGRATION}:${MAIN}`);
  const { shipment } = await api;
  assert.equal(complete(shipment({ ...options(repo), integration: INTEGRATION, source: 'local', ref: MAIN })).result, 'not-contained');
  assert.equal(complete(shipment({ ...options(repo), integration: INTEGRATION, source: 'remote', remote: 'origin', ref: MAIN })).result, 'contained');
});
test('different local and remote tips can both contain integration', async t => {
  const repo = makeRepo(t); repo.remote(); repo.commit('work'); repo.git('branch', 'chore/fixture-ledger'); repo.git('push', 'origin', `${MAIN}:${MAIN}`); repo.commit('later');
  const { shipment } = await api;
  const local = complete(shipment({ ...options(repo), integration: INTEGRATION, source: 'local', ref: MAIN })), remote = complete(shipment({ ...options(repo), integration: INTEGRATION, source: 'remote', remote: 'origin', ref: MAIN }));
  assert.notEqual(local.shipmentSha, remote.shipmentSha); assert.equal(local.result, 'contained'); assert.equal(remote.result, 'contained');
});
test('a fresh remote SHA missing locally is unknown even when the tracking cache is usable', async t => {
  const repo = makeRepo(t), bare = repo.remote(); repo.git('branch', 'chore/fixture-ledger');
  const unseen = bare.git('commit-tree', bare.git('rev-parse', `${repo.base}^{tree}`), '-p', repo.base, '-m', 'upstream-only'); bare.git('update-ref', MAIN, unseen);
  const before = repo.snapshot(), remoteBefore = bare.snapshot();
  const r = (await api).shipment({ ...options(repo), integration: INTEGRATION, source: 'remote', remote: 'origin', ref: MAIN });
  unknown(r); assert.equal(r.evidence.shipmentSha, unseen); assert.equal(r.evidence.integrationSha, repo.base);
  const c = cli(repo, 'shipment', ['--integration', INTEGRATION, '--source', 'remote', '--remote', 'origin', '--ref', MAIN]);
  assert.equal(c.status, 2); unknown(c.json); assert.equal(c.json.evidence.shipmentSha, unseen);
  assert.deepEqual(repo.snapshot(), before); assert.deepEqual(bare.snapshot(), remoteBefore);
});
test('an absent remote branch and an unavailable remote do not supply shipment evidence', async t => {
  const repo = makeRepo(t); repo.remote(); repo.git('branch', 'chore/fixture-ledger');
  for (const [remote, ref] of [['origin', 'refs/heads/absent'], ['missing', MAIN]]) {
    const r = (await api).shipment({ ...options(repo), integration: INTEGRATION, source: 'remote', remote, ref }); unknown(r); assert.equal(r.evidence.shipmentSha, null);
    const c = cli(repo, 'shipment', ['--integration', INTEGRATION, '--source', 'remote', '--remote', remote, '--ref', ref]); assert.equal(c.status, 2); unknown(c.json); assert.equal(c.json.diagnostics[0].command, 'ls-remote');
  }
});
function archivedLedger(t) {
  const repo = makeRepo(t); repo.git('checkout', '-b', 'chore/fixture-ledger'); writeLedger(repo); repo.commit('active'); repo.git('checkout', 'main'); repo.git('merge', '--ff-only', INTEGRATION);
  repo.git('checkout', '-b', 'unrelated-work'); repo.write('unrelated.txt', 'Unrelated\n'); repo.commit('unrelated');
  repo.git('checkout', 'chore/fixture-ledger'); writeLedger(repo, { state: 'COMPLETE' }); fs.mkdirSync(path.join(repo.cwd, '.agents/archive'), { recursive: true }); repo.git('mv', LEDGER, ARCHIVE); repo.commit('archive');
  repo.git('checkout', 'main'); repo.git('merge', '--ff-only', INTEGRATION); repo.git('branch', '-D', 'chore/fixture-ledger'); return repo;
}
test('ledger history proves an archived copy is older despite unrelated branch commits and a deleted owner', async t => {
  const repo = archivedLedger(t), { ledger, ancestry, discovery } = await api;
  const e = complete(ledger({ ...options(repo), ref: 'refs/heads/unrelated-work', ledger: 'FIXTURE', target: MAIN }));
  assert.equal(e.active.tree, e.active.lastChangeTree); assert.equal(e.active.ancestry.target.result, 'contained');
  assert.equal(complete(ancestry({ ...options(repo), ancestor: 'refs/heads/unrelated-work', descendant: MAIN })).result, 'not-contained');
  const target = complete(ledger({ ...options(repo), ref: MAIN, ledger: 'FIXTURE' }));
  assert.equal(target.active.exists, false); assert.equal(target.archive.exists, true); assert.match(target.archive.progressText, /State\*\*: COMPLETE/);
  assert.equal(complete(discovery(options(repo))).ledgers[0].locations[0].ref, 'refs/heads/unrelated-work');
  const ownerMissing = ledger({ ...options(repo), ref: 'refs/heads/unrelated-work', ledger: 'FIXTURE', owner: INTEGRATION }); assert.notEqual(ownerMissing.completeness, 'complete'); assert.equal(ownerMissing.evidence.active.ancestry.owner.result, 'unknown');
});
test('a newer ledger commit fails the older-copy ancestry proof', async t => {
  const repo = archivedLedger(t); repo.git('checkout', 'unrelated-work'); repo.write(`${LEDGER}/PROGRESS.md`, '**State**: ACTIVE\nNew work\n'); const changed = repo.commit('new ledger');
  const e = complete((await api).ledger({ ...options(repo), ref: 'refs/heads/unrelated-work', ledger: 'FIXTURE', target: MAIN }));
  assert.equal(e.active.lastChange, changed); assert.equal(e.active.tree, e.active.lastChangeTree); assert.equal(e.active.ancestry.target.result, 'not-contained');
});
test('dirty ledger edits in another worktree remain visible despite older committed provenance', async t => {
  const repo = archivedLedger(t), dir = path.join(repo.root, 'candidate-worktree'); repo.git('worktree', 'add', dir, 'unrelated-work');
  const candidate = repo.at(dir); candidate.write(`${LEDGER}/PROGRESS.md`, '**State**: ACTIVE\nUncommitted\n');
  const before = candidate.snapshot(), e = complete((await api).discovery(options(repo)));
  assert.equal(e.worktrees.find(w => w.branch === 'refs/heads/unrelated-work').cleanliness, 'dirty');
  const locations = e.ledgers[0].locations;
  assert.match(locations.find(l => l.kind === 'worktree').progressText, /Uncommitted/);
  assert.equal(locations.find(l => l.kind === 'ref').worktrees[0].status[0].path, `${LEDGER}/PROGRESS.md`);
  assert.deepEqual(candidate.snapshot(), before);
});
test('recorded target corrections have newer provenance than retained batch contracts', async t => {
  const repo = makeRepo(t); repo.git('branch', '-m', 'main', 'master'); repo.git('checkout', '-b', 'chore/fixture-ledger'); writeLedger(repo, { defaultRef: 'refs/heads/master' }); const oldSha = repo.commit('old target');
  repo.git('branch', 'fix/batch-1'); repo.git('branch', '-m', 'master', 'main'); writeLedger(repo); repo.write(`${LEDGER}/LOG.md`, 'User approved correcting master to main.\n'); repo.commit('correction');
  const { ledger } = await api; const old = complete(ledger({ ...options(repo), ref: 'refs/heads/fix/batch-1', ledger: 'FIXTURE', owner: INTEGRATION })), owner = complete(ledger({ ...options(repo), ref: INTEGRATION, ledger: 'FIXTURE' }));
  assert.equal(old.active.lastChange, oldSha); assert.equal(old.active.ancestry.owner.result, 'contained'); assert.notEqual(old.active.tree, owner.active.tree);
  assert.match(old.active.contractTexts[0].text, /Shipment ref: refs\/heads\/master/); assert.match(owner.active.contractTexts[0].text, /Shipment ref: refs\/heads\/main/);
  repo.git('checkout', 'fix/batch-1'); writeLedger(repo, { defaultRef: 'refs/heads/release' }); repo.commit('conflict');
  const conflict = complete(ledger({ ...options(repo), ref: 'refs/heads/fix/batch-1', ledger: 'FIXTURE', owner: INTEGRATION })); assert.equal(conflict.active.ancestry.owner.result, 'not-contained'); assert.match(conflict.active.contractTexts[0].text, /refs\/heads\/release/);
});

test('every fixed evidence CLI command returns structured real evidence without writes', async t => {
  const repo = makeRepo(t), bare = repo.remote(); repo.git('branch', 'chore/fixture-ledger'); writeLedger(repo); repo.commit('ledger');
  const before = repo.snapshot(), remoteBefore = bare.snapshot();
  const cases = [
    ['discovery', [], e => { assert.ok(e.refs.length); assert.equal(e.ledgers[0].id, 'FIXTURE'); assert.ok(e.ledgers[0].locations[0].provenance.tree); }],
    ['worktrees', [], e => { assert.equal(e.worktrees[0].head.length, 40); assert.equal(e.worktrees[0].branch, MAIN); assert.equal(e.worktrees[0].cleanliness, 'clean'); }],
    ['ancestry', ['--ancestor', INTEGRATION, '--descendant', MAIN], e => { assert.equal(e.ancestorSha, repo.base); assert.equal(e.descendantSha.length, 40); assert.equal(e.result, 'contained'); }],
    ['shipment', ['--integration', INTEGRATION, '--source', 'local', '--ref', MAIN], e => { assert.equal(e.source, 'local'); assert.equal(e.remote, null); assert.equal(e.ref, MAIN); assert.equal(e.integrationSha, repo.base); assert.equal(e.shipmentSha.length, 40); assert.equal(e.result, 'contained'); }],
    ['shipment', ['--integration', INTEGRATION, '--source', 'remote', '--remote', 'origin', '--ref', MAIN], e => { assert.equal(e.source, 'remote'); assert.equal(e.remote, 'origin'); assert.equal(e.ref, MAIN); assert.equal(e.integrationSha, repo.base); assert.equal(e.shipmentSha, repo.base); assert.equal(e.result, 'contained'); }],
    ['ledger', ['--ref', MAIN, '--ledger', 'FIXTURE'], e => { assert.equal(e.id, 'FIXTURE'); assert.equal(e.ref, MAIN); assert.equal(e.activePath, LEDGER); assert.equal(e.archivePath, ARCHIVE); assert.equal(e.refSha.length, 40); assert.equal(e.active.exists, true); assert.equal(e.archive.exists, false); assert.ok(e.active.lastChange); assert.equal(e.active.lastChangeTree, e.active.tree); assert.match(e.active.progressText, /ACTIVE/); assert.ok(e.active.contractTexts[0].path); }],
  ];
  for (const [op, args, check] of cases) { const c = cli(repo, op, args); assert.equal(c.status, 0, c.stdout); assert.equal(c.stderr, ''); assert.equal(c.json.operation, op); assert.equal(c.json.repo, path.resolve(repo.cwd)); check(complete(c.json)); }
  const notContained = cli(repo, 'ancestry', ['--ancestor', MAIN, '--descendant', INTEGRATION]); assert.equal(notContained.status, 0); assert.equal(complete(notContained.json).result, 'not-contained');
  assert.deepEqual(repo.snapshot(), before); assert.deepEqual(bare.snapshot(), remoteBefore);
});
test('CLI errors, invalid encoding, unavailable Git and dirty calls preserve unknowns and bytes', async t => {
  const repo = makeRepo(t); repo.write('dirty name Ω.txt', 'bytes\r\n'); const before = repo.snapshot();
  for (const args of [[], ['bogus'], ['discovery'], ['discovery', '--repo', repo.cwd, '--repo', repo.cwd], ['worktrees', '--repo', repo.cwd, '--extra', 'x'], ['ancestry', '--repo', repo.cwd, '--ancestor', MAIN], ['shipment', '--repo', repo.cwd, '--integration', MAIN, '--source', 'remote', '--ref', MAIN]]) {
    const c = repo.cli('git-evidence.mjs', args); assert.equal(c.status, 2); assert.notEqual(c.json.completeness, 'complete'); assert.ok(c.json.diagnostics.length);
  }
  const absent = cli(repo, 'ancestry', ['--ancestor', MAIN, '--descendant', 'refs/heads/missing']); assert.equal(absent.status, 2); unknown(absent.json);
  const dirty = cli(repo, 'worktrees'); assert.equal(dirty.status, 0); assert.deepEqual(dirty.json.evidence.worktrees[0].status, [{ status: '??', path: 'dirty name Ω.txt', originalPath: null }]);
  const help = repo.cli('git-evidence.mjs', ['--help']); assert.equal(help.status, 0); assert.match(help.stdout, /shipment/);
  // --help states the rule the helper actually applies, and keeps documenting its exits.
  assert.match(help.stdout, /A path resolving to a clean\/process filter attribute, or a submodule, makes worktree cleanliness UNKNOWN; unsafe status commands are not run\./);
  assert.match(help.stdout, /Exit 0: complete facts \(including not-contained\); exit 2: partial\/unknown or invalid invocation\./);
  const noGit = repo.cli('git-evidence.mjs', ['ancestry', '--repo', repo.cwd, '--ancestor', MAIN, '--descendant', MAIN], { PATH: repo.root, Path: repo.root }); assert.equal(noGit.status, 2); unknown(noGit.json); assert.ok(noGit.json.diagnostics[0].error);
  assert.deepEqual(repo.snapshot(), before);
  repo.write(`${LEDGER}/PROGRESS.md`, Buffer.from([0xff, 0xfe])); repo.commit('invalid utf8');
  const invalid = cli(repo, 'ledger', ['--ref', MAIN, '--ledger', 'FIXTURE']); assert.equal(invalid.status, 2); assert.ok(invalid.json.diagnostics.some(d => d.code === 'invalid-encoding')); assert.equal(invalid.json.evidence.active.progressText, null);
});

test('worktree and ledger CLIs retain unavailable observations and config failures as UNKNOWN', async t => {
  const repo = makeRepo(t), dir = path.join(repo.root, 'missing-worktree'); repo.git('worktree', 'add', '-b', 'missing-worktree', dir); fs.renameSync(dir, path.join(repo.root, 'moved-worktree'));
  const result = cli(repo, 'worktrees'); assert.equal(result.status, 2); assert.equal(result.json.completeness, 'partial'); assert.equal(result.json.evidence.worktrees.find(w => w.branch === 'refs/heads/missing-worktree').cleanliness, 'unknown'); assert.ok(result.json.diagnostics.some(d => d.code === 'worktree-unavailable'));
  const missing = cli(repo, 'ledger', ['--ref', 'refs/heads/no-object', '--ledger', 'FIXTURE']); assert.equal(missing.status, 2); assert.equal(missing.json.evidence.refSha, null); assert.equal(missing.json.evidence.active.exists, null); assert.equal(missing.json.evidence.archive.exists, null);
  const configured = repo.cli('git-evidence.mjs', ['ancestry', '--repo', repo.cwd, '--ancestor', MAIN, '--descendant', MAIN], { GIT_CONFIG_COUNT: 'not-a-number' }); assert.equal(configured.status, 2); unknown(configured.json); assert.equal(configured.json.diagnostics[0].command, 'rev-parse');
});
// Git exports GIT_DIR and GIT_INDEX_FILE to every hook, so a tool run from one inherits them. The
// evidence still describes --repo: git's repository-location variables are dropped from every
// probe (config injection stays surfaced, as the GIT_CONFIG_COUNT case above pins).
test('an inherited GIT_DIR or GIT_INDEX_FILE never points the git-evidence or check-fence CLI at another repository', async t => {
  const repo = makeRepo(t), decoy = makeRepo(t), batchFile = `${LEDGER}/02-batches-01-work.md`;
  repo.write(`${LEDGER}/01-plan.md`, '# Plan\n\n| # | Batch | Branch | Files (fence) |\n|---|---|---|---|\n| B01 | Work | batch-one | `allowed.txt` |\n');
  repo.write(`${LEDGER}/PROGRESS.md`, '# Progress\n\n## Batches\n\n| # | Branch | Notes |\n|---|---|---|\n| B01 | batch-one | — |\n\n## Session log\n\n| Date | Detail |\n|---|---|\n');
  repo.write(batchFile, '# B01 — Work (feature, —)\n\n**Branch**: `batch-one`\n**Files**: `allowed.txt`\n\n## Checklist\n\n- [ ] Implement behavior.\n\n## Acceptance\n\nPreserve this text.\n');
  repo.write('allowed.txt', 'before\n'); repo.commit('authority'); repo.git('branch', 'integration');
  const wt = path.join(repo.root, 'batch worktree'); repo.git('worktree', 'add', '-b', 'batch-one', wt);
  repo.at(wt).write('allowed.txt', 'implemented\n'); repo.at(wt).commit('implement');
  // The decoy has the same branch names at other commits, and a file of its own in its index.
  decoy.write('decoy-only.txt', 'decoy\n'); decoy.commit('decoy'); decoy.git('branch', 'integration'); decoy.git('branch', 'batch-one');
  const decoyGit = path.join(decoy.cwd, '.git');
  const fence = ['--repo', repo.cwd, '--integration', 'refs/heads/integration', '--batch', 'refs/heads/batch-one', '--ledger', 'FIXTURE', '--batch-id', 'B01', '--batch-file', batchFile];
  const runs = { discovery: env => repo.cli('git-evidence.mjs', ['discovery', '--repo', repo.cwd], env), worktrees: env => repo.cli('git-evidence.mjs', ['worktrees', '--repo', repo.cwd], env), fence: env => repo.cli('check-fence.mjs', fence, env) };
  const clean = Object.fromEntries(Object.entries(runs).map(([name, run]) => [name, run({})]));
  assert.deepEqual(Object.values(clean).map(r => r.status), [0, 0, 0], JSON.stringify(clean.fence.json));
  assert.equal(clean.fence.json.status, 'PASS');
  // The decoy's path as JSON writes it (a Windows path's backslashes come out doubled): the only
  // form in which stdout can hold it.
  const needle = JSON.stringify(decoy.root).slice(1, -1);
  assert.ok(JSON.stringify({ path: path.join(decoy.root, 'x') }).includes(needle), 'live control: the needle matches the path as JSON writes it');
  const gitOut = (env, args) => { const r = spawnSync('git', args, { cwd: repo.cwd, env: { ...repo.env, ...env }, encoding: 'utf8', windowsHide: true }); return [r.status, r.stdout]; };
  for (const [label, env, probe] of [
    ['GIT_DIR', { GIT_DIR: decoyGit }, ['for-each-ref', '--format=%(refname) %(objectname)']],
    ['GIT_INDEX_FILE', { GIT_INDEX_FILE: path.join(decoyGit, 'index') }, ['status', '--porcelain', '--untracked-files=all']],
    ['both', { GIT_DIR: decoyGit, GIT_INDEX_FILE: path.join(decoyGit, 'index') }, ['for-each-ref', '--format=%(refname) %(objectname)']],
  ]) {
    // Live control: plain git in this environment reads the decoy (its index names objects this repository lacks).
    assert.equal(gitOut({}, probe)[0], 0, label);
    assert.notDeepEqual(gitOut(env, probe), gitOut({}, probe), label + ': the plant is live');
    for (const [name, run] of Object.entries(runs)) {
      const r = run(env);
      assert.deepEqual([r.status, r.json], [clean[name].status, clean[name].json], label + ': ' + name);
      assert.ok(!r.stdout.includes(needle), label + ': ' + name + ': the decoy appears nowhere');
    }
    // The exported API drops them from a caller's env the same way.
    assert.deepEqual((await api).discovery({ repo: repo.cwd, env: { ...repo.env, ...env } }), clean.discovery.json, label + ': the API');
  }
});
test("git's repository-location variables are dropped from a probe's environment whatever their case, and its config injection and everything else are kept", async () => {
  const { localGitVars, repositoryEnv } = await api;
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)));
  const listed = spawnSync('git', ['rev-parse', '--local-env-vars'], { env, encoding: 'utf8', windowsHide: true });
  assert.equal(listed.status, 0, listed.stderr);
  const names = listed.stdout.split(/\r?\n/).filter(Boolean);
  assert.deepEqual(localGitVars(), names, 'the list is the one git prints, never a copy');
  const config = names.filter(name => /^GIT_CONFIG(?:_|$)/.test(name)), location = names.filter(name => !config.includes(name));
  assert.ok(location.includes('GIT_DIR') && location.includes('GIT_INDEX_FILE') && config.includes('GIT_CONFIG_COUNT') && config.includes('GIT_CONFIG_PARAMETERS'), names.join(' '));
  const keep = { PATH: 'p', GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_GLOBAL: 'g', GIT_CONFIG_KEY_0: 'k', GIT_CONFIG_VALUE_0: 'v', GIT_CEILING_DIRECTORIES: 'c', GIT_DIRECTORY: 'not git_dir' };
  for (const name of config) { keep[name] = 'kept'; keep[name.toLowerCase()] = 'kept'; }
  const planted = { ...keep };
  for (const name of location) { planted[name] = 'x'; planted[name.toLowerCase()] = 'x'; }
  assert.deepEqual(repositoryEnv(planted), keep);
  assert.equal(planted.GIT_DIR, 'x', "the caller's object is not changed");
});
// With no trustworthy list there is nothing to drop by: every probe refuses, none runs unscrubbed.
// The fake is node under git's name (a link, or a copy where links need privileges), answering
// through a --require hook that acts only in a process started as git.
test('a git that lists no repository variable, or a name that is not one, fails every evidence probe closed', t => {
  const repo = makeRepo(t), bin = path.join(repo.root, 'fake-bin'), fake = path.join(bin, process.platform === 'win32' ? 'git.exe' : 'git');
  fs.mkdirSync(bin);
  try { fs.symlinkSync(process.execPath, fake); } catch { fs.copyFileSync(process.execPath, fake); }
  const hook = path.join(repo.root, 'fake-git.cjs');
  fs.writeFileSync(hook, "if (require('path').basename(process.argv0).replace(/[.]exe$/i, '') === 'git') { process.stdout.write(process.env.FAKE_GIT_OUT); process.exit(0); }\n");
  const pathKey = Object.keys(repo.env).find(key => key.toUpperCase() === 'PATH');
  for (const [label, out] of [['a list of nothing', ''], ['a name that is not a git variable', 'GIT_DIR\nPATH\n']]) {
    const env = { [pathKey]: bin + path.delimiter + repo.env[pathKey], NODE_OPTIONS: '--require "' + hook.split(path.sep).join('/') + '"', FAKE_GIT_OUT: out };
    // Live control: a PATH lookup finds the fake, and it answers as told.
    const probe = spawnSync('git', ['rev-parse', '--local-env-vars'], { env: { ...repo.env, ...env }, encoding: 'utf8', windowsHide: true });
    assert.deepEqual([probe.status, probe.stdout], [0, out], label + ': the fake answers ' + probe.stderr);
    const r = repo.cli('git-evidence.mjs', ['ancestry', '--repo', repo.cwd, '--ancestor', MAIN, '--descendant', MAIN], env);
    assert.equal(r.status, 2, label); unknown(r.json);
    assert.deepEqual(r.json.diagnostics.map(d => [d.code, d.command, d.error]), [['git-probe', 'rev-parse', 'local-env-vars'], ['git-probe', 'rev-parse', 'local-env-vars']], label);
  }
});
test('read-only probes do not execute configured external diff or fsmonitor shell commands', async t => {
  const repo = makeRepo(t); repo.write('tracked', 'before'); repo.commit('tracked'); repo.write('tracked', 'after');
  const marker = path.join(repo.root, 'must-not-exist');
  repo.git('config', 'core.fsmonitor', `echo forbidden > "${marker}"`); repo.git('config', 'diff.external', `echo forbidden > "${marker}"`);
  const before = repo.snapshot(); const r = (await api).worktrees(options(repo)); assert.equal(complete(r).worktrees[0].cleanliness, 'dirty'); assert.equal(fs.existsSync(marker), false); assert.deepEqual(repo.snapshot(), before);
});

test('remote branch must point to an actual local commit rather than a peelable tag', async t => {
  const repo = makeRepo(t), bare = repo.remote(); repo.git('branch', 'chore/fixture-ledger'); repo.git('tag', '-a', 'object-tag', repo.base, '-m', 'annotated'); repo.git('push', 'origin', 'refs/tags/object-tag');
  const tag = repo.git('rev-parse', 'refs/tags/object-tag'); bare.write('refs/heads/main', tag + '\n');
  const before = [repo.snapshot(), bare.snapshot()]; const c = cli(repo, 'shipment', ['--integration', INTEGRATION, '--source', 'remote', '--remote', 'origin', '--ref', MAIN]);
  assert.equal(c.status, 2); unknown(c.json); assert.equal(c.json.evidence.shipmentSha, tag); assert.ok(c.json.diagnostics.some(d => d.code === 'remote-object-type')); assert.deepEqual([repo.snapshot(), bare.snapshot()], before);
});

test('configured clean and process filters never execute through API or actual CLI status probes', async t => {
  const { worktrees, discovery } = await api;
  for (const kind of ['clean', 'process']) await t.test(kind, t => {
    const repo = makeRepo(t), marker = path.join(repo.cwd, 'filter-must-not-run'), script = path.join(repo.root, `filter-${kind}.cjs`);
    fs.writeFileSync(script, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed'); ${kind === 'clean' ? 'process.stdin.pipe(process.stdout);' : 'process.exit(1);'}`);
    repo.write('.gitattributes', 'filtered.txt filter=marker\n'); repo.write('filtered.txt', 'before\n'); repo.commit('filter fixture');
    repo.git('config', `filter.marker.${kind}`, `node "${script.replaceAll('\\', '/')}"`);
    repo.write('filtered.txt', 'after!\n'); fs.utimesSync(path.join(repo.cwd, 'filtered.txt'), new Date(0), new Date(0));
    const before = repo.snapshot();
    for (const operation of ['worktrees', 'discovery']) {
      const result = ({ worktrees, discovery })[operation](options(repo));
      assert.equal(result.completeness, 'partial'); assert.equal(result.evidence.worktrees[0].cleanliness, 'unknown'); assert.ok(result.diagnostics.some(d => d.code === 'unsafe-filter'));
      const command = cli(repo, operation); assert.equal(command.status, 2); assert.equal(command.json.evidence.worktrees[0].cleanliness, 'unknown'); assert.ok(command.json.diagnostics.some(d => d.code === 'unsafe-filter'));
      assert.equal(fs.existsSync(marker), false, `${operation} must not start ${kind} command`); assert.deepEqual(repo.snapshot(), before);
    }
    // GIT_CONFIG can redirect only `git config`; it must not conceal the real
    // repository's configured filter from the status prerequisite check.
    const conceal = { ...repo.env, GIT_CONFIG: path.join(repo.root, 'empty.gitconfig') };
    const hidden = worktrees({ repo: repo.cwd, env: conceal }); assert.ok(hidden.diagnostics.some(d => d.code === 'unsafe-filter'));
    const hiddenCli = repo.cli('git-evidence.mjs', ['worktrees', '--repo', repo.cwd], { GIT_CONFIG: conceal.GIT_CONFIG }); assert.equal(hiddenCli.status, 2); assert.ok(hiddenCli.json.diagnostics.some(d => d.code === 'unsafe-filter'));
    assert.equal(fs.existsSync(marker), false); assert.deepEqual(repo.snapshot(), before);
  });
});
test('a configured driver no inspected path resolves to leaves cleanliness observable', async t => {
  // Git for Windows writes filter.lfs.* into the system gitconfig on every stock install.
  // A configured driver converts nothing until an attribute selects it, so mere
  // configuration must not cost the mechanical gate its answer.
  const { worktrees, discovery } = await api;
  const repo = makeRepo(t), marker = path.join(repo.cwd, 'filter-must-not-run'), script = path.join(repo.root, 'unresolved-filter.cjs');
  fs.writeFileSync(script, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed'); process.stdin.pipe(process.stdout);`);
  for (const kind of ['clean', 'process']) repo.git('config', `filter.marker.${kind}`, `node "${script.replaceAll('\\', '/')}"`);
  // A repository with no path at all is safe, not unknown.
  assert.equal(complete(worktrees(options(repo))).worktrees[0].cleanliness, 'clean');
  // `-filter` resolves to `unset` and every other inspected path to `unspecified`: neither
  // selects the configured driver. The attribute on the ignored path does select it, but
  // status never inspects that path's content, so nothing can convert it.
  repo.write('.gitattributes', 'pinned.txt -filter\nignored.txt filter=marker\n'); repo.write('.gitignore', 'ignored.txt\n');
  repo.write('pinned.txt', 'pinned\n'); repo.write('plain.txt', 'plain\n'); repo.commit('unresolved driver fixture');
  repo.write('ignored.txt', 'ignored\n');
  const before = repo.snapshot();
  for (const operation of ['worktrees', 'discovery']) {
    const actual = ({ worktrees, discovery })[operation](options(repo)), command = cli(repo, operation);
    assert.equal(command.status, 0, command.stdout);
    for (const result of [actual, command.json]) {
      assert.equal(result.completeness, 'complete', JSON.stringify(result.diagnostics));
      assert.equal(result.evidence.worktrees[0].cleanliness, 'clean');
      assert.equal(result.diagnostics.some(d => d.code === 'unsafe-filter'), false, JSON.stringify(result.diagnostics));
    }
    assert.equal(fs.existsSync(marker), false, `${operation} must not start a filter command`); assert.deepEqual(repo.snapshot(), before);
  }
  // Real dirt is reported as dirt, and still without executing anything.
  repo.write('plain.txt', 'changed\n'); fs.utimesSync(path.join(repo.cwd, 'plain.txt'), new Date(0), new Date(0));
  const dirty = complete(worktrees(options(repo))), dirtyCli = cli(repo, 'worktrees'); assert.equal(dirtyCli.status, 0, dirtyCli.stdout);
  for (const e of [dirty, dirtyCli.json.evidence]) {
    assert.equal(e.worktrees[0].cleanliness, 'dirty');
    assert.deepEqual(e.worktrees[0].status, [{ status: ' M', path: 'plain.txt', originalPath: null }]);
  }
  assert.equal(fs.existsSync(marker), false, 'a dirty inspected path must not start a filter command');
  // Live-canary control, last because it is destructive. Every absence assertion above is
  // vacuous unless this fixture CAN execute the driver: attach the attribute to the
  // tracked, stat-dirty path and let Git itself run status once. The marker must appear.
  repo.git('config', '--unset', 'filter.marker.process'); // the stub cannot speak the long-running protocol
  repo.write('.gitattributes', 'pinned.txt -filter\nignored.txt filter=marker\nplain.txt filter=marker\n');
  // Equal byte length on purpose: status short-circuits on a size change and never
  // converts, so only a same-size edit makes the driver reachable at all.
  repo.write('plain.txt', 'plaiN\n'); fs.utimesSync(path.join(repo.cwd, 'plain.txt'), new Date(0), new Date(0));
  repo.git('status', '--porcelain=v1', '--untracked-files=all');
  assert.equal(fs.existsSync(marker), true, 'the fixture must be able to execute the driver, or absence proves nothing');
});
test('a driver reached only through $GIT_DIR/info/attributes is still refused', async t => {
  // The fast path may skip the attribute enumeration when nothing is configured; it must
  // never turn a resolving path safe, whichever attributes file names the driver. This
  // one is untracked and uncommitted: no .gitattributes blob mentions the driver.
  const repo = makeRepo(t), marker = path.join(repo.cwd, 'info-filter-must-not-run'), script = path.join(repo.root, 'info-filter.cjs');
  fs.writeFileSync(script, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed'); process.stdin.pipe(process.stdout);`);
  repo.write('filtered.txt', 'before\n'); repo.commit('info attributes fixture');
  repo.write('.git/info/attributes', 'filtered.txt filter=marker\n'); repo.git('config', 'filter.marker.clean', `node "${script.replaceAll('\\', '/')}"`);
  repo.write('filtered.txt', 'after!\n'); fs.utimesSync(path.join(repo.cwd, 'filtered.txt'), new Date(0), new Date(0));
  const before = repo.snapshot(), result = (await api).worktrees(options(repo)), command = cli(repo, 'worktrees');
  assert.equal(command.status, 2);
  for (const r of [result, command.json]) {
    assert.equal(r.completeness, 'partial'); assert.equal(r.evidence.worktrees[0].cleanliness, 'unknown');
    assert.ok(r.diagnostics.some(d => d.code === 'unsafe-filter'), JSON.stringify(r.diagnostics));
  }
  assert.equal(fs.existsSync(marker), false); assert.deepEqual(repo.snapshot(), before);
});
// Each case is the ONLY path in its repository carrying an attribute, so each one alone
// holds the enumeration and classification rule it names.
const QUOTED = `sub dir/réd 'q'.bin`;
for (const [name, attributes, file, tracked, live] of [
  // -z round trip: without it `ls-files` applies core.quotePath to this path and the
  // NUL-separated triples become `path: filter: value` text that no tab split survives.
  ['a space and non-ASCII path', '*.bin filter=marker\n', QUOTED, true, true],
  // A valueless `filter` attribute resolves to bare `set`. Today's Git selects no driver
  // for it, so this is a deliberate margin no other test would hold.
  ['a bare set attribute', 'bare.txt filter\n', 'bare.txt', true, false],
  // Defence in depth, not a live exploit: status enumerates untracked non-ignored paths
  // under -uall, so the probe enumerates them too rather than resting on the current
  // reachability of convert_to_git, which only index entries reach.
  ['an untracked non-ignored path', '*.bin filter=marker\n', 'new.bin', false, false],
]) test(`${name} resolving to a driver refuses without executing it`, async t => {
  const repo = makeRepo(t), marker = path.join(repo.cwd, 'resolving-must-not-run'), script = path.join(repo.root, 'resolving-filter.cjs');
  fs.writeFileSync(script, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed'); process.stdin.pipe(process.stdout);`);
  repo.write('.gitattributes', attributes); repo.write('untouched.txt', 'no attribute here\n');
  if (tracked) repo.write(file, 'before\n');
  repo.commit('resolving driver fixture'); repo.git('config', 'filter.marker.clean', `node "${script.replaceAll('\\', '/')}"`);
  // Tracked cases are made stat-dirty, so status would have to convert them to answer.
  repo.write(file, 'after!\n'); if (tracked) fs.utimesSync(path.join(repo.cwd, file), new Date(0), new Date(0));
  const before = repo.snapshot(), { worktrees, discovery } = await api;
  for (const operation of ['worktrees', 'discovery']) {
    const actual = ({ worktrees, discovery })[operation](options(repo)), command = cli(repo, operation);
    assert.equal(command.status, 2);
    for (const r of [actual, command.json]) {
      assert.equal(r.completeness, 'partial'); assert.equal(r.evidence.worktrees[0].cleanliness, 'unknown');
      assert.ok(r.diagnostics.some(d => d.code === 'unsafe-filter'), JSON.stringify(r.diagnostics));
    }
    assert.equal(fs.existsSync(marker), false); assert.deepEqual(repo.snapshot(), before);
  }
  // Live-canary control: only a tracked, stat-dirty path can reach a driver through
  // status, so only there does the absence above carry weight. Say so rather than let
  // the assertion read as proof in the cases where nothing could have run.
  if (!live) return;
  repo.git('status', '--porcelain=v1', '--untracked-files=all');
  assert.equal(fs.existsSync(marker), true, 'the fixture must be able to execute the driver, or absence proves nothing');
});
// git() caps output at 16MB and times out at 15s, so a large or slow repository really can
// fail these probes. Failing closed is the whole contract. Both cases are asserted because
// a corrupt index fails every ls-files call: the fixture pins the OUTCOME, and cannot from
// outside tell the enumeration apart from the index inventory. Ordering note for a reader
// who expects invalid-index here: with a driver configured the enumeration now runs first,
// so a corrupt index surfaces as git-probe, and invalid-index is left for a readable but
// malformed inventory.
for (const configured of [true, false]) test(`a failed probe stays unknown rather than clean, driver ${configured ? 'configured' : 'absent'}`, async t => {
  const repo = makeRepo(t), marker = path.join(repo.cwd, 'broken-probe-must-not-run'), script = path.join(repo.root, `broken-probe-${configured}.cjs`);
  fs.writeFileSync(script, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed'); process.stdin.pipe(process.stdout);`);
  repo.write('.gitattributes', 'filtered.txt filter=marker\n'); repo.write('filtered.txt', 'before\n'); repo.commit('broken probe fixture');
  if (configured) repo.git('config', 'filter.marker.clean', `node "${script.replaceAll('\\', '/')}"`);
  fs.writeFileSync(path.join(repo.cwd, '.git/index'), 'this is not a Git index');
  const before = repo.snapshot(), result = (await api).worktrees(options(repo)), command = cli(repo, 'worktrees');
  assert.equal(command.status, 2);
  for (const r of [result, command.json]) {
    assert.notEqual(r.completeness, 'complete'); assert.equal(r.evidence.worktrees[0].cleanliness, 'unknown');
    assert.deepEqual(r.evidence.worktrees[0].status, []);
    assert.ok(r.diagnostics.some(d => d.code === 'git-probe' && d.command === 'ls-files' && path.resolve(d.path) === path.resolve(repo.cwd)), JSON.stringify(r.diagnostics));
    assert.equal(r.diagnostics.some(d => d.code === 'unsafe-filter'), false, JSON.stringify(r.diagnostics));
  }
  assert.equal(fs.existsSync(marker), false); assert.deepEqual(repo.snapshot(), before);
});
test('an unmerged index keeps one attribute record per enumerated entry', async t => {
  // The probe requires exactly three fields per enumerated path, so it must agree with
  // real Git about how many records come back. An unmerged path is listed once per stage
  // and check-attr answers once per line; if that ever diverged the probe would report
  // invalid-attributes and refuse a repository that is merely conflicted.
  const repo = makeRepo(t);
  repo.write('conflict.txt', 'base\n'); repo.commit('base');
  repo.git('checkout', '-b', 'side'); repo.write('conflict.txt', 'side\n'); repo.commit('side');
  repo.git('checkout', 'main'); repo.write('conflict.txt', 'main\n'); repo.commit('main');
  assert.equal(repo.probe('merge', 'side').status, 1, 'the fixture must actually conflict');
  repo.git('config', 'filter.marker.clean', 'node --version');
  assert.equal(repo.git('ls-files', '--cached', '--', 'conflict.txt').split('\n').length, 3, 'all three stages must be enumerated');
  const e = complete((await api).worktrees(options(repo)));
  assert.equal(e.worktrees[0].cleanliness, 'dirty');
  assert.ok(e.worktrees[0].status.some(s => s.status === 'UU' && s.path === 'conflict.txt'), JSON.stringify(e.worktrees[0].status));
});
test('malformed loose refs are retained as unknown while valid sibling evidence remains available', async t => {
  const repo = makeRepo(t); writeLedger(repo); repo.commit('valid sibling ledger'); repo.write('.git/refs/heads/broken', 'not-an-object\n');
  const before = repo.snapshot(), brokenBytes = fs.readFileSync(path.join(repo.cwd, '.git/refs/heads/broken'));
  const actual = (await api).discovery(options(repo)), command = cli(repo, 'discovery');
  assert.equal(command.status, 2);
  for (const result of [actual, command.json]) {
    assert.equal(result.completeness, 'partial');
    assert.deepEqual(result.evidence.refs.find(r => r.ref === 'refs/heads/broken'), { ref: 'refs/heads/broken', sha: null, symref: null });
    assert.ok(result.evidence.refs.find(r => r.ref === MAIN).sha); assert.equal(result.evidence.ledgers[0].id, 'FIXTURE');
    assert.ok(result.diagnostics.some(d => d.code === 'unobserved-loose-ref' && d.ref === 'refs/heads/broken'));
    assert.ok(result.diagnostics.some(d => d.code === 'ref-inventory-warning' && d.command === 'for-each-ref' && d.exit === 0));
  }
  assert.deepEqual(repo.snapshot(), before); assert.deepEqual(fs.readFileSync(path.join(repo.cwd, '.git/refs/heads/broken')), brokenBytes);
});
test('staged and unstaged T statuses remain complete dirty observations in API and CLI', async t => {
  const { worktrees } = await api;
  for (const kind of ['staged', 'unstaged']) await t.test(kind, t => {
    const repo = makeRepo(t); repo.write('tracked.txt', 'ordinary file\n'); repo.commit('ordinary'); repo.git('config', 'core.symlinks', 'false');
    const blob = repo.git('hash-object', '-w', '--', 'tracked.txt'); repo.git('update-index', '--cacheinfo', `120000,${blob},tracked.txt`);
    if (kind === 'unstaged') { repo.git('commit', '-m', 'symlink index'); repo.git('config', 'core.symlinks', 'true'); }
    const before = repo.snapshot(), expected = [{ status: kind === 'staged' ? 'T ' : ' T', path: 'tracked.txt', originalPath: null }];
    const r = complete(worktrees(options(repo))); assert.equal(r.worktrees[0].cleanliness, 'dirty'); assert.deepEqual(r.worktrees[0].status, expected);
    const c = cli(repo, 'worktrees'); assert.equal(c.status, 0, c.stdout); assert.equal(complete(c.json).worktrees[0].cleanliness, 'dirty'); assert.deepEqual(c.json.evidence.worktrees[0].status, expected); assert.deepEqual(repo.snapshot(), before);
  });
});
test('submodule status does not enter a nested repository with its own executable filters', async t => {
  const repo = makeRepo(t), nestedPath = path.join(repo.root, 'nested-source'); fs.mkdirSync(nestedPath); const nested = repo.at(nestedPath);
  nested.git('init', '--initial-branch=main'); nested.write('.gitattributes', 'tracked.txt filter=nested\n'); nested.write('tracked.txt', 'before\n'); nested.commit('nested');
  repo.git('submodule', 'add', nestedPath, 'nested'); repo.commit('submodule');
  const sub = repo.at(path.join(repo.cwd, 'nested')), marker = path.join(repo.cwd, 'nested-filter-must-not-run'), script = path.join(repo.root, 'nested-filter.cjs');
  fs.writeFileSync(script, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed'); process.stdin.pipe(process.stdout);`);
  sub.git('config', 'filter.nested.clean', `node "${script.replaceAll('\\', '/')}"`); sub.write('tracked.txt', 'after!\n'); fs.utimesSync(path.join(sub.cwd, 'tracked.txt'), new Date(0), new Date(0));
  const before = repo.snapshot(), subBefore = sub.snapshot();
  const r = (await api).worktrees(options(repo)), c = cli(repo, 'worktrees'); assert.equal(c.status, 2);
  for (const result of [r, c.json]) { assert.equal(result.completeness, 'partial'); assert.equal(result.evidence.worktrees[0].cleanliness, 'unknown'); assert.ok(result.diagnostics.some(d => d.code === 'submodule-status-unsupported')); }
  assert.equal(fs.existsSync(marker), false); assert.deepEqual(repo.snapshot(), before); assert.deepEqual(sub.snapshot(), subBefore);
});

test('dangling symbolic hints retain legal targets in every namespace through API and actual CLI', async t => {
  for (const target of ['refs/tags/missing', 'refs/custom/missing', 'refs/remotes/absent/main']) await t.test(target, async t => {
    const repo = makeRepo(t), ref = 'refs/remotes/origin/HEAD';
    repo.git('check-ref-format', target); repo.git('symbolic-ref', ref, target);
    const before = repo.snapshot(), refBytes = fs.readFileSync(path.join(repo.cwd, '.git', ref));
    const actual = (await api).discovery(options(repo)), command = cli(repo, 'discovery');
    assert.equal(command.status, 0, command.stdout);
    for (const result of [actual, command.json]) {
      const evidence = complete(result);
      assert.deepEqual(evidence.refs, [{ ref: MAIN, sha: repo.base, symref: null }, { ref, sha: null, symref: target }]);
      assert.deepEqual(evidence.ledgers, []); assert.deepEqual(result.diagnostics, []);
    }
    assert.deepEqual(repo.snapshot(), before); assert.deepEqual(fs.readFileSync(path.join(repo.cwd, '.git', ref)), refBytes);
  });
});
test('symbolic hints do not expand discovery into target namespaces or scan their trees', async t => {
  const repo = makeRepo(t); writeLedger(repo, { id: 'OUTSIDE' }); const outside = repo.commit('outside namespace ledger');
  repo.git('update-ref', 'refs/custom/target', outside); repo.git('reset', '--hard', repo.base);
  repo.git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/custom/target');
  const before = repo.snapshot(), actual = (await api).discovery(options(repo)), command = cli(repo, 'discovery');
  assert.equal(command.status, 0, command.stdout);
  for (const result of [actual, command.json]) {
    const evidence = complete(result);
    assert.deepEqual(evidence.refs, [{ ref: MAIN, sha: repo.base, symref: null }, { ref: 'refs/remotes/origin/HEAD', sha: outside, symref: 'refs/custom/target' }]);
    assert.deepEqual(evidence.ledgers, []);
  }
  assert.deepEqual(repo.snapshot(), before);
});
test('malformed symbolic targets remain unknown without losing valid sibling refs', async t => {
  for (const target of ['refs/tags/.hidden', 'refs/custom/name.lock', 'refs/tags/double..dot']) await t.test(target, async t => {
    const repo = makeRepo(t), ref = 'refs/remotes/origin/HEAD';
    assert.equal(repo.probe('check-ref-format', target).status, 1);
    repo.write(`.git/${ref}`, `ref: ${target}\n`);
    const before = repo.snapshot(), refBytes = fs.readFileSync(path.join(repo.cwd, '.git', ref));
    const actual = (await api).discovery(options(repo)), command = cli(repo, 'discovery');
    assert.equal(command.status, 2);
    for (const result of [actual, command.json]) {
      assert.equal(result.completeness, 'partial');
      assert.deepEqual(result.evidence.refs.find(r => r.ref === ref), { ref, sha: null, symref: null });
      assert.deepEqual(result.evidence.refs.find(r => r.ref === MAIN), { ref: MAIN, sha: repo.base, symref: null });
      assert.ok(result.diagnostics.some(d => d.code === 'git-probe' && d.command === 'symbolic-ref' && d.exit === 128), JSON.stringify(result.diagnostics));
    }
    assert.deepEqual(repo.snapshot(), before); assert.deepEqual(fs.readFileSync(path.join(repo.cwd, '.git', ref)), refBytes);
  });
});
test('global clean filters remain unknown and never execute through API or actual CLI', async t => {
  const repo = makeRepo(t), marker = path.join(repo.cwd, 'global-filter-must-not-run'), script = path.join(repo.root, 'global-filter.cjs');
  fs.writeFileSync(script, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed'); process.stdin.pipe(process.stdout);`);
  repo.write('.gitattributes', 'filtered.txt filter=global-marker\n'); repo.write('filtered.txt', 'before\n'); repo.commit('global filter fixture');
  // --global writes only this disposable fixture's GIT_CONFIG_GLOBAL file.
  repo.git('config', '--global', 'filter.global-marker.clean', `node "${script.replaceAll('\\', '/')}"`);
  assert.equal(repo.probe('config', '--local', '--get', 'filter.global-marker.clean').status, 1);
  repo.write('filtered.txt', 'after!\n'); fs.utimesSync(path.join(repo.cwd, 'filtered.txt'), new Date(0), new Date(0));
  const before = repo.snapshot(), configBefore = fs.readFileSync(repo.env.GIT_CONFIG_GLOBAL), { worktrees, discovery } = await api;
  for (const operation of ['worktrees', 'discovery']) {
    const actual = ({ worktrees, discovery })[operation](options(repo)), command = cli(repo, operation);
    assert.equal(command.status, 2);
    for (const result of [actual, command.json]) {
      assert.equal(result.completeness, 'partial'); assert.equal(result.evidence.worktrees[0].cleanliness, 'unknown');
      assert.ok(result.diagnostics.some(d => d.code === 'unsafe-filter'));
    }
    assert.equal(fs.existsSync(marker), false, `${operation} must not start the global clean command`);
    assert.deepEqual(repo.snapshot(), before); assert.deepEqual(fs.readFileSync(repo.env.GIT_CONFIG_GLOBAL), configBefore);
  }
});

// Two fail-closed guards in the filter probe are unreachable from any repository: a corrupt
// index fails every ls-files call, so the worktrees walk reports `unknown` whether or not
// the enumeration guard fires, and real check-attr emits exactly three fields per input
// path and always names the attribute it was asked for. Both are therefore driven through
// the helper's own surface below, so disarming either reddens this file rather than passing
// unnoticed while the probe starts reporting `clean` and running status.
test('the attribute report classifier refuses a miscounted, misnamed or unsafely valued record', async t => {
  const { filterReportVerdict } = await api;
  const malformed = { code: 'invalid-attributes', message: 'Malformed attribute report' };
  const unexpected = { code: 'invalid-attributes', message: 'Unexpected attribute in report' };
  const unsafe = { code: 'unsafe-filter', message: 'An inspected path resolves to a filter attribute; status was not run because it can execute commands' };
  const record = (file, attribute, value) => `${file}\0${attribute}\0${value}\0`;
  const report = (count, value = 'unspecified') => Array.from({ length: count }, (_, i) => record(`path ${i}.txt`, 'filter', value)).join('');
  // The count boundary, pinned on both sides: exactly three fields per enumerated path is
  // the only accepted shape, and one field more or one field fewer is not. Loosening the
  // guard in either direction is caught, not only strengthening it. Each case names which
  // half of the guard refuses it, because the two disjuncts are independently mutable: an
  // input a mismatched count already refuses says nothing about the terminator, so the
  // terminator half gets an input whose field count matches exactly.
  for (const count of [0, 1, 2, 3]) {
    assert.equal(filterReportVerdict(count, report(count)), null, `${count} well-formed records must be accepted`);
    assert.deepEqual(filterReportVerdict(count, report(count) + 'stray\0'), malformed, `count half: one terminated field beyond ${count} records must be refused`);
    assert.deepEqual(filterReportVerdict(count + 1, report(count)), malformed, `count half: ${count} records where ${count + 1} paths were enumerated must be refused`);
    // Terminator half alone: after the trailing field is popped the count matches exactly,
    // so only `fields.pop() !== ''` can refuse this one.
    assert.deepEqual(filterReportVerdict(count, report(count) + 'stray'), malformed, `terminator half: ${count} records plus an unterminated field must be refused`);
    if (count) assert.deepEqual(filterReportVerdict(count, report(count).slice(0, -'unspecified\0'.length)), malformed, `count half: ${count} records with a value field missing must be refused`);
  }
  // The name guard classifies every record, not only the first: the misnamed one is last,
  // and then at an odd interior index, where a loop striding past records would miss it.
  assert.deepEqual(filterReportVerdict(1, record('p.txt', 'diff', 'unspecified')), unexpected, 'a report about another attribute must be refused');
  assert.deepEqual(filterReportVerdict(3, report(2) + record('p2.txt', 'text', 'unspecified')), unexpected, 'a misnamed trailing record must be refused');
  assert.deepEqual(filterReportVerdict(5, report(3) + record('p3.txt', 'text', 'unspecified') + report(1)), unexpected, 'a misnamed interior record must be refused');
  // The safe-value whitelist, written out here rather than read back from the tool, swept
  // whole against a domain of its neighbours: exactly these two values may be accepted, so
  // admitting a third one goes red even if the pattern and the list are edited together.
  const safe = ['unspecified', 'unset'];
  assert.equal(new Set(safe).size, 2, 'the whitelist is a two-member set');
  const domain = [...safe, 'set', 'marker', 'lfs', 'crlf', '', ' ', 'Unspecified', 'UNSET', 'unspecified ', ' unset', 'unspecifie', 'unsets', 'unset,unspecified', 'true', 'false', 'unspecified\n'];
  assert.equal(new Set(domain).size, domain.length, 'the swept domain has no duplicates');
  assert.deepEqual(domain.filter(value => filterReportVerdict(1, record('p.txt', 'filter', value)) === null), safe, 'no value outside the whitelist may be accepted');
  for (const value of domain.filter(value => !safe.includes(value))) {
    assert.deepEqual(filterReportVerdict(1, record('p.txt', 'filter', value)), unsafe, `a ${JSON.stringify(value)} filter attribute must refuse`);
    assert.deepEqual(filterReportVerdict(3, report(2) + record('p2.txt', 'filter', value)), unsafe, `a trailing ${JSON.stringify(value)} filter attribute must refuse`);
    assert.deepEqual(filterReportVerdict(5, report(3) + record('p3.txt', 'filter', value) + report(1)), unsafe, `an interior ${JSON.stringify(value)} filter attribute must refuse`);
  }
});
test('the filter probe refuses an unreadable inventory and proceeds on a readable one', async t => {
  const { safeResolvedFilters, worktrees } = await api;
  // Live control, first: a readable repository with a driver configured that no path
  // resolves to. The probe says safe, status really runs, and real dirt comes back. Without
  // it, the refusal below would be an observation about a fixture that could never have
  // proceeded, and `status: []` would prove nothing at all.
  const live = makeRepo(t); live.git('config', 'filter.marker.clean', 'node --version');
  live.write('tracked.txt', 'before\n'); live.commit('live control fixture');
  live.write('tracked.txt', 'after!\n'); fs.utimesSync(path.join(live.cwd, 'tracked.txt'), new Date(0), new Date(0));
  const liveBefore = live.snapshot(), proceeds = [];
  assert.equal(safeResolvedFilters(live.cwd, proceeds, { env: live.env }), true, 'a readable inventory resolving to no driver is safe');
  assert.deepEqual(proceeds, []);
  const proceeded = complete(worktrees(options(live)));
  assert.equal(proceeded.worktrees[0].cleanliness, 'dirty');
  assert.deepEqual(proceeded.worktrees[0].status, [{ status: ' M', path: 'tracked.txt', originalPath: null }]);
  assert.deepEqual(live.snapshot(), liveBefore);
  // The guard, driven by a real unreadable inventory rather than the seam. Only the verdict
  // is mutation-sensitive in this half — a corrupt index fails the later index inventory
  // too, so the walk answers `unknown` even with this guard disarmed. The test below drives
  // the same guard through the walk, where the seam keeps the rest of the repository sound.
  const broken = makeRepo(t); broken.write('tracked.txt', 'before\n'); broken.commit('broken index fixture');
  fs.writeFileSync(path.join(broken.cwd, '.git/index'), 'this is not a Git index');
  const brokenBefore = broken.snapshot(), refusals = [];
  assert.equal(safeResolvedFilters(broken.cwd, refusals, { env: broken.env }), false, 'an unreadable inventory must refuse, never report safe');
  assert.equal(refusals.length, 1, JSON.stringify(refusals));
  assert.equal(refusals[0].code, 'git-probe'); assert.equal(refusals[0].command, 'ls-files');
  assert.equal(path.resolve(refusals[0].path), path.resolve(broken.cwd));
  const refused = worktrees(options(broken));
  assert.notEqual(refused.completeness, 'complete');
  assert.equal(refused.evidence.worktrees[0].cleanliness, 'unknown');
  assert.deepEqual(refused.evidence.worktrees[0].status, [], 'status must not have been run');
  assert.deepEqual(broken.snapshot(), brokenBefore);
});
// The third guard of the same class, in the same function: an attribute report Git could
// not return. No repository reaches it — check-attr exits 0 on a directory .gitattributes,
// on a macro cycle and on a missing or unreadable core.attributesFile alike — so it is
// driven through the probe seam, which can only force a probe to be read as failed. Both
// unreadable-probe refusals are watched through the walk itself here, where the injected
// failure is the ONLY thing wrong with the repository: a driver is configured, status would
// otherwise run, and disarming either guard is therefore visible as cleanliness.
for (const command of ['ls-files', 'check-attr']) test(`an unreadable ${command} result refuses the walk instead of running status`, async t => {
  const { safeResolvedFilters, worktrees } = await api;
  const repo = makeRepo(t); repo.git('config', 'filter.marker.clean', 'node --version');
  repo.write('tracked.txt', 'before\n'); repo.commit('degraded probe fixture');
  repo.write('tracked.txt', 'after!\n'); fs.utimesSync(path.join(repo.cwd, 'tracked.txt'), new Date(0), new Date(0));
  const before = repo.snapshot();
  // Live control, in the very same repository: with no probe degraded the prerequisite says
  // safe and status really runs, returning real dirt. So `unknown` below is caused by the
  // unread probe alone, and `status: []` is an absence that could have been a presence.
  const control = complete(worktrees(options(repo)));
  assert.equal(control.worktrees[0].cleanliness, 'dirty');
  assert.deepEqual(control.worktrees[0].status, [{ status: ' M', path: 'tracked.txt', originalPath: null }]);
  const diagnostics = [];
  assert.equal(safeResolvedFilters(repo.cwd, diagnostics, { env: repo.env, failProbe: command }), false, `an unread ${command} result must refuse, never report safe`);
  assert.deepEqual(diagnostics.map(d => [d.code, d.command, path.resolve(d.path)]), [['git-probe', command, path.resolve(repo.cwd)]]);
  const refused = worktrees({ ...options(repo), failProbe: command });
  assert.notEqual(refused.completeness, 'complete');
  assert.equal(refused.evidence.worktrees[0].cleanliness, 'unknown', `an unread ${command} result must not be reported clean or dirty`);
  assert.deepEqual(refused.evidence.worktrees[0].status, [], 'status must not have been run');
  assert.ok(refused.diagnostics.some(d => d.code === 'git-probe' && d.command === command), JSON.stringify(refused.diagnostics));
  assert.deepEqual(repo.snapshot(), before);
});
test('the probe seam can only refuse, and no published invocation reaches it', async t => {
  const { safeResolvedFilters } = await api;
  const repo = makeRepo(t); repo.git('config', 'filter.marker.clean', 'node --version');
  repo.write('.gitattributes', 'filtered.txt filter=marker\n'); repo.write('filtered.txt', 'before\n'); repo.commit('seam reach fixture');
  const before = repo.snapshot();
  // The seam is an options key, never a flag: every spelling the CLI could carry is an
  // invalid invocation, and --help names no such flag to try.
  for (const args of [['--failProbe', 'check-attr'], ['--fail-probe', 'check-attr'], ['--failProbe', 'ls-files'], ['--failprobe', 'status']]) {
    const c = repo.cli('git-evidence.mjs', ['worktrees', '--repo', repo.cwd, ...args]);
    assert.equal(c.status, 2); assert.deepEqual(c.json.diagnostics.map(d => d.code), ['usage'], JSON.stringify(c.json.diagnostics));
    assert.equal(c.json.completeness, 'unknown');
  }
  const help = repo.cli('git-evidence.mjs', ['--help']);
  assert.equal(help.status, 0); assert.doesNotMatch(help.stdout, /fail[- ]?probe/i);
  // Omitting the options argument is not the same as passing `failProbe: undefined`: the
  // seam must leave the argument optional, as every other exported helper here does. The
  // verdict stays deterministic despite the fallback to process.env, because the inspected
  // path is TRACKED and its attribute comes from a committed .gitattributes, which outranks
  // core.attributesFile and the system attributes file: no ambient Git configuration can
  // drop it from the listing or unresolve it, on any machine. The diagnostic is read as
  // well as the boolean, so an environment that broke a probe could not pass as the
  // attribute verdict this fixture exists to reach.
  const optional = [];
  assert.equal(safeResolvedFilters(repo.cwd, optional), false, 'the third argument must stay optional');
  assert.deepEqual(optional.map(d => d.code), ['unsafe-filter'], 'and the omitted argument still reaches the real attribute verdict');
  // And in the API it degrades only: swept over its whole reachable domain and beyond, no
  // value makes this resolving attribute safe. The two probes it can degrade refuse as
  // unread; every other value leaves the real, resolving verdict standing.
  const domain = [undefined, null, '', 'ls-files', 'check-attr', 'status', 'config', 'ls-tree', 'filter', 'ls-files -z', 'LS-FILES', true];
  assert.equal(domain.length, 12, 'the swept domain has twelve members');
  assert.equal(new Set(domain).size, domain.length, 'the swept domain has no duplicates');
  const codes = [];
  for (const failProbe of domain) {
    const diagnostics = [];
    assert.equal(safeResolvedFilters(repo.cwd, diagnostics, { env: repo.env, failProbe }), false, `failProbe=${JSON.stringify(failProbe)} must not make a resolving attribute safe`);
    assert.deepEqual(diagnostics.map(d => d.code), [['ls-files', 'check-attr'].includes(failProbe) ? 'git-probe' : 'unsafe-filter'], `failProbe=${JSON.stringify(failProbe)}`);
    codes.push(...diagnostics.map(d => d.code));
  }
  // The domain and the expectation are two independent lists, so deleting a member from
  // both at once would otherwise leave this green: the partition is pinned by size too.
  assert.equal(codes.length, domain.length, 'every swept value refused with exactly one diagnostic');
  assert.equal(codes.filter(code => code === 'git-probe').length, 2, 'exactly two swept values name a probe this function issues');
  assert.deepEqual(repo.snapshot(), before);
});
test('a refusing verdict reaches the caller as the diagnostic the classifier produced', async t => {
  const { safeResolvedFilters, filterReportVerdict } = await api;
  const repo = makeRepo(t);
  repo.write('.gitattributes', 'filtered.txt filter=marker\n'); repo.write('filtered.txt', 'before\n'); repo.commit('resolving fixture');
  const diagnostics = [], before = repo.snapshot();
  assert.equal(safeResolvedFilters(repo.cwd, diagnostics, { env: repo.env }), false);
  // One call site consumes the verdict, so this pins the whole refusal wire: a verdict no
  // repository can produce travels it exactly as this reachable one does, gaining the
  // inspected path and nothing else.
  assert.deepEqual(diagnostics, [{ ...filterReportVerdict(1, 'filtered.txt\0filter\0marker\0'), path: repo.cwd }]);
  assert.deepEqual(repo.snapshot(), before);
});
