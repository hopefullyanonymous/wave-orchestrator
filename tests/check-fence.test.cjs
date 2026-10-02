const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { makeRepo, MAIN, LEDGER } = require('./support/git-fixture.cjs');
const api = import('../orchestrate/tools/check-fence.mjs');
const INT = 'refs/heads/integration', BATCH = 'refs/heads/batch-one', BATCHFILE = `${LEDGER}/02-batches-01-work.md`;
const makeBatch = files => `# B01 — Work (feature, —)\n\n**Branch**: \`batch-one\`\n**Files**: ${files.map(p => `\`${p}\``).join(', ')}\n\n## Checklist\n\n- [ ] Implement behavior.\n- [x] Keep completed item.\n\n## Acceptance\n\nPreserve this text.\n`;
function fixture(t, paths = ['allowed.txt'], missing = []) {
  const repo = makeRepo(t), batchText = makeBatch(paths);
  const plan = `# Plan\n\n| # | Batch | Branch | Files (fence) |\n|---|---|---|---|\n| B01 | Work | batch-one | ${paths.map(p => `\`${p}\``).join(', ')} |\n`;
  const progress = `# Progress\n\n## Batches\n\n| # | Branch | Notes |\n|---|---|---|\n| B01 | batch-one | — |\n\n## Session log\n\n| Date | Detail |\n|---|---|\n`;
  repo.write(`${LEDGER}/01-plan.md`, plan); repo.write(`${LEDGER}/PROGRESS.md`, progress); repo.write(BATCHFILE, batchText);
  for (const file of paths) if (!missing.includes(file)) repo.write(file, 'Initial unique contents for ' + file + '\n');
  repo.write('outside.txt', 'Outside unique contents, keep both rename endpoints\n'); const base = repo.commit('authority'); repo.git('branch', 'integration');
  const wt = path.join(repo.root, 'batch worktree'); repo.git('worktree', 'add', '-b', 'batch-one', wt);
  const candidate = repo.at(wt), opts = { repo: repo.cwd, integration: INT, batch: BATCH, ledger: 'FIXTURE', 'batch-id': 'B01', 'batch-file': BATCHFILE, env: repo.env };
  const args = ['--repo', repo.cwd, '--integration', INT, '--batch', BATCH, '--ledger', 'FIXTURE', '--batch-id', 'B01', '--batch-file', BATCHFILE];
  function authority(planText = plan, progressText = progress) { repo.write(`${LEDGER}/01-plan.md`, planText); repo.write(`${LEDGER}/PROGRESS.md`, progressText); const sha = repo.commit('authority amendment'); repo.git('update-ref', INT, sha); }
  return { repo, candidate, base, opts, args, plan, progress, batchText, authority, cli: () => repo.cli('check-fence.mjs', args) };
}
function state(result, expected, code) {
  assert.equal(result.status, expected, JSON.stringify(result));
  if (code) assert.ok([...result.violations, ...result.unknowns].some(d => d.code === code), JSON.stringify(result));
}

test('actual fence CLI PASS is read-only and imported result agrees', async t => {
  const f = fixture(t); f.candidate.write('allowed.txt', 'implemented\n'); f.candidate.write(BATCHFILE, f.batchText.replace('- [ ]', '- [x]')); const sha = f.candidate.commit('implement');
  const before = [f.repo.snapshot(), f.candidate.snapshot()];
  const c = f.cli(); assert.equal(c.status, 0, c.stdout); state(c.json, 'PASS');
  assert.equal(c.json.integrationSha, f.base); assert.equal(c.json.batchSha, sha); assert.equal(c.json.mergeBase, f.base);
  assert.deepEqual(c.json.evidence.allowedPaths, ['allowed.txt', BATCHFILE]); assert.deepEqual(c.json.violations, []); assert.deepEqual(c.json.unknowns, []);
  assert.deepEqual((await api).checkFence(f.opts), c.json); assert.deepEqual([f.repo.snapshot(), f.candidate.snapshot()], before);
});
test('adds modifications deletions and type changes obey literal fence', async t => {
  for (const operation of ['add', 'modify', 'delete', 'type']) for (const inside of [true, false]) await t.test(`${operation} ${inside ? 'inside' : 'outside'}`, async t => {
    const f = fixture(t, ['allowed.txt', 'new.txt'], ['new.txt']), file = inside ? 'allowed.txt' : 'outside.txt';
    if (operation === 'add') f.candidate.write(inside ? 'new.txt' : 'new-outside.txt', 'new unique content');
    if (operation === 'modify') f.candidate.write(file, 'modified unique content');
    if (operation === 'delete') f.candidate.git('rm', '--', file);
    if (operation === 'type') {
      f.candidate.git('config', 'core.symlinks', 'false');
      const blob = f.candidate.git('hash-object', '-w', '--', file);
      f.candidate.git('update-index', '--cacheinfo', `120000,${blob},${file}`);
    }
    if (operation === 'type') f.candidate.git('commit', '-m', 'type'); else f.candidate.commit(operation);
    const r = (await api).checkFence(f.opts);
    state(r, inside ? 'PASS' : 'VIOLATION', inside ? undefined : 'outside-fence');
    assert.ok(r.evidence.changes.some(c => c.status === ({ add: 'A', modify: 'M', delete: 'D', type: 'T' })[operation]));
  });
});
test('both rename directions and copy sources enforce both raw endpoints', async t => {
  for (const [from, to, copy] of [['outside.txt', 'allowed.txt', false], ['allowed.txt', 'outside-new.txt', false], ['outside.txt', 'allowed.txt', true]]) await t.test(`${from} -> ${to} copy=${copy}`, async t => {
    const f = fixture(t, ['allowed.txt'], from === 'outside.txt' ? ['allowed.txt'] : []);
    if (copy) fs.copyFileSync(path.join(f.candidate.cwd, from), path.join(f.candidate.cwd, to));
    else f.candidate.git('mv', '--', from, to);
    f.candidate.commit('rename or copy'); const r = (await api).checkFence(f.opts);
    state(r, 'VIOLATION', 'outside-fence'); assert.ok(r.violations.some(d => d.path === (from === 'outside.txt' ? from : to)));
    assert.ok(r.evidence.changes.some(c => /^[RC]/.test(c.status) && c.paths.includes(from) && c.paths.includes(to)), JSON.stringify(r.evidence.changes));
  });
});
test('raw spaces Unicode and option-like filenames are never trimmed or option parsed', async t => {
  const files = [' space Ω.txt', 'name with spaces.txt', '-option.txt', "apostrophe's.txt"];
  if (process.platform !== 'win32') files.push('quote"tab\tnewline\n.txt', 'trailing .txt ');
  const allowed = files.filter(p => !/[\t\n]/.test(p)), f = fixture(t, allowed);
  for (const file of allowed) f.candidate.write(file, `changed ${file}`);
  f.candidate.commit('raw names'); const r = (await api).checkFence(f.opts); state(r, 'PASS');
  assert.deepEqual(r.evidence.changes.flatMap(c => c.paths).sort(), allowed.sort());
  // A near-match with a different leading space is outside the exact fence.
  f.candidate.write('space Ω.txt', 'different'); f.candidate.commit('near name');
  const bad = f.cli(); assert.equal(bad.status, 1); state(bad.json, 'VIOLATION', 'outside-fence'); assert.ok(bad.json.violations.some(d => d.path === 'space Ω.txt'));
  if (process.platform !== 'win32') {
    f.candidate.write('quote"tab\tnewline\n.txt', 'unusual'); f.candidate.commit('unusual');
    assert.ok((await api).checkFence(f.opts).violations.some(d => d.path === 'quote"tab\tnewline\n.txt'));
  }
});
test('candidate staged unstaged untracked rename and conflicted dirt are violations and remain untouched', async t => {
  for (const kind of ['staged', 'unstaged', 'untracked', 'rename', 'conflict']) await t.test(kind, async t => {
    const f = fixture(t);
    if (kind === 'untracked') f.candidate.write('untracked Ω.txt', 'dirty');
    else if (kind === 'rename') f.candidate.git('mv', 'allowed.txt', 'renamed Ω.txt');
    else if (kind === 'conflict') {
      f.candidate.write('allowed.txt', 'candidate change'); f.candidate.commit('candidate side');
      f.repo.write('allowed.txt', 'other change'); f.repo.commit('other side');
      assert.equal(f.candidate.probe('merge', MAIN).status, 1);
    } else { f.candidate.write('allowed.txt', 'dirty'); if (kind === 'staged') f.candidate.git('add', 'allowed.txt'); }
    const before = f.candidate.snapshot(); const r = (await api).checkFence(f.opts); state(r, 'VIOLATION', 'dirty-worktree');
    const entries = r.violations.find(d => d.code === 'dirty-worktree').entries;
    if (kind === 'rename') assert.deepEqual(entries, [{ status: 'R ', path: 'renamed Ω.txt', originalPath: 'allowed.txt' }]);
    if (kind === 'conflict') assert.ok(entries.some(e => e.status === 'UU'));
    const cli = f.cli(); assert.equal(cli.status, 1); state(cli.json, 'VIOLATION', 'dirty-worktree'); assert.deepEqual(f.candidate.snapshot(), before);
  });
});
test('other worktree dirt is evidence without a batch violation', async t => {
  const f = fixture(t); f.repo.write('other-dirt', 'untracked'); const before = f.repo.snapshot();
  const r = (await api).checkFence(f.opts); state(r, 'PASS'); assert.equal(r.evidence.worktrees.find(w => w.branch === MAIN).cleanliness, 'dirty'); assert.deepEqual(f.repo.snapshot(), before);
});
test('missing worktree and changed checkout identity are UNKNOWN, never clean', async t => {
  for (const kind of ['missing', 'identity']) await t.test(kind, async t => {
    const f = fixture(t), original = f.candidate.cwd, moved = path.join(f.repo.root, 'moved'); fs.renameSync(original, moved);
    if (kind === 'identity') fs.mkdirSync(original);
    const c = f.cli(); assert.equal(c.status, 2); state(c.json, 'UNKNOWN', 'candidate-worktree'); assert.equal(c.json.evidence.worktrees.find(w => w.branch === BATCH).cleanliness, 'unknown');
  });
});
test('captured integration plan wins over forged candidate plan and Files grants', async t => {
  const f = fixture(t); f.candidate.write(`${LEDGER}/01-plan.md`, f.plan.replace('`allowed.txt`', '`allowed.txt`, `outside.txt`'));
  f.candidate.write(BATCHFILE, f.batchText.replace('`allowed.txt`', '`allowed.txt`, `outside.txt`')); f.candidate.write('outside.txt', 'forged'); f.candidate.commit('forgery');
  const c = f.cli(); assert.equal(c.status, 1); state(c.json, 'VIOLATION', 'outside-fence'); assert.ok(c.json.violations.some(d => d.code === 'batch-files')); assert.deepEqual(c.json.evidence.allowedPaths, ['allowed.txt', BATCHFILE]);
});
test('explicit and row-bound extensions require matching committed Notes and session-log authority', async t => {
  for (const explicit of [true, false]) await t.test(explicit ? 'explicit B01' : 'row-bound', async t => {
    const f = fixture(t), entry = `fence +extra Ω.txt (${explicit ? 'B01, ' : ''}item, reason, 2026-09-18)`;
    const progress = f.progress.replace('| B01 | batch-one | — |', `| B01 | batch-one | ${entry} |`) + `| 2026-09-18 | ${entry} |\n`;
    f.authority(f.plan, progress); f.candidate.write('extra Ω.txt', 'approved extension'); f.candidate.write(BATCHFILE, f.batchText.replace('`allowed.txt`', '`allowed.txt`, `extra Ω.txt`')); f.candidate.commit('authorized');
    state((await api).checkFence(f.opts), 'PASS');
  });
});
test('mismatched ambiguous substring and forged extension records never grant authority', async t => {
  for (const kind of ['mismatch', 'duplicate-log', 'missing-log', 'substring', 'candidate-only', 'other-row', 'embedded-record']) await t.test(kind, async t => {
    const f = fixture(t), entry = 'fence +extra.txt (B01, item, reason, 2026-09-18)';
    let progress = f.progress.replace('| B01 | batch-one | — |', `| B01 | batch-one | ${kind === 'mismatch' ? entry.replace('B01,', 'B02,') : entry} |`);
    if (kind !== 'missing-log') progress += `| 2026-09-18 | ${kind === 'substring' ? entry.replace('extra.txt', 'extra.txt-other') : entry} |\n`;
    if (kind === 'duplicate-log') progress += `| 2026-09-18 | ${entry} |\n`;
    if (kind === 'embedded-record') progress = progress.replaceAll('fence +', 'unfence +');
    if (kind === 'other-row') progress = progress.replace(`| B01 | batch-one | ${entry} |`, `| B01 | batch-one | ${entry} |\n| B02 | batch-two | fence +extra.txt (item, reason, 2026-09-18) |`);
    if (kind === 'candidate-only') f.candidate.write(`${LEDGER}/PROGRESS.md`, progress); else f.authority(f.plan, progress);
    f.candidate.write('extra.txt', 'outside'); f.candidate.commit('extension attempt'); const r = (await api).checkFence(f.opts);
    state(r, kind === 'candidate-only' ? 'VIOLATION' : 'UNKNOWN', kind === 'candidate-only' ? 'outside-fence' : 'authority');
    assert.ok(r.violations.some(d => d.path === 'extra.txt'));
  });
});
test('malformed duplicate glob traversal missing and wrong-linkage authority is explicit UNKNOWN', async t => {
  const mutations = [
    p => p.replace('`allowed.txt`', 'allowed.txt'), p => p.replace('`allowed.txt`', '`*.txt`'), p => p.replace('`allowed.txt`', '`../outside.txt`'),
    p => p + '| B01 | Work | batch-one | `outside.txt` |\n', p => p.replace('| B01 |', '| B02 |'), p => p.replace('batch-one', 'other-branch'), p => p.replace('Files (fence)', 'Files'), p => p.replace('batch-one', '`batch-one'),
  ];
  for (const [index, mutate] of mutations.entries()) await t.test(`malformed ${index}`, async t => { const f = fixture(t); f.authority(mutate(f.plan)); const c = f.cli(); assert.equal(c.status, 2); state(c.json, 'UNKNOWN', 'authority'); });
  await t.test('invalid encoding', async t => { const f = fixture(t); f.authority(Buffer.from([0xff])); const c = f.cli(); assert.equal(c.status, 2); state(c.json, 'UNKNOWN', 'invalid-encoding'); });
  await t.test('wrong requested filename', async t => { const f = fixture(t); state((await api).checkFence({ ...f.opts, 'batch-file': `${LEDGER}/02-batches-02-work.md` }), 'UNKNOWN', 'batch-linkage'); });
});
test('own batch permits ticks and appended polish while retaining all original lines', async t => {
  const f = fixture(t); f.candidate.write(BATCHFILE, f.batchText.replace('- [ ] Implement', '- [x] Implement').replace('\n\n## Acceptance', '\n- [x] polish: Strengthen test.\n- [ ] polish: Follow up.\n\n## Acceptance')); f.candidate.commit('ticks polish');
  state((await api).checkFence(f.opts), 'PASS');
});
test('own batch accepts wrapped polish items and still rejects indented lines with no header', async t => {
  // Every checklist line in this repository wraps at about ninety characters, so a real
  // polish ask arrives as a header line plus indented continuation lines.
  const item = '- [x] polish: Accept the indented continuation lines that the authoring convention\n      of this repository produces, so the mechanical gate reads the wrapped form and\n      not the single-line form alone.';
  const unticked = '- [ ] polish: Wrap an unticked ask too, exercising the other header box.\n      Its continuation is indented the same way.';
  const orphan = '      An indented line with no polish header above it.';
  // Expected lines are those of the proposed file; the baseline blank sits at line 10.
  const cases = [
    // Live control: the whole wrapped block is consumed, so nothing reaches the diagnostic.
    ['wrapped ticked and unticked items', `\n${item}\n${unticked}\n\n## Acceptance`, []],
    ['continuation with no header above it', `\n${orphan}\n## Acceptance`, [10]],
    ['wrapped item then an unrelated appended line', `\n${item}\n- [x] Sneak in work.\n## Acceptance`, [13]],
    ['continuation appended ahead of the blank line', `\n${orphan}\n\n## Acceptance`, [10, 11, 12, 13, 14, 15]],
  ];
  for (const [name, replacement, lines] of cases) await t.test(name, async t => {
    const f = fixture(t); f.candidate.write(BATCHFILE, f.batchText.replace('\n\n## Acceptance', replacement)); f.candidate.commit(name);
    const r = (await api).checkFence(f.opts);
    state(r, lines.length ? 'VIOLATION' : 'PASS', lines.length ? 'batch-content' : undefined);
    assert.deepEqual(r.violations.filter(d => d.code === 'batch-content' && d.path === BATCHFILE).map(d => d.line), lines, JSON.stringify(r.violations));
  });
});
test('the polish scan is pinned to its position, a non-empty ask and the space indent', async t => {
  const ask = '- [x] polish: An ask that wraps, as every checklist line in this repository does.';
  const cases = [
    // Held from BELOW as well as from column 0: one space continues an ask, a tab does not.
    ['one-space continuation is accepted', s => s.replace('\n\n## Acceptance', `\n${ask}\n One space is enough to continue it.\n\n## Acceptance`), []],
    ['tab continuation is rejected', s => s.replace('\n\n## Acceptance', `\n${ask}\n\tA tab is not the indent this repository writes.\n\n## Acceptance`), [11, 12, 13, 14, 15, 16]],
    // Both spellings of an empty ask: no space at all, and the space with nothing after it.
    ['header with no ask text is rejected', s => s.replace('\n\n## Acceptance', '\n- [ ] polish:\n\n## Acceptance'), [10, 11, 12, 13, 14, 15]],
    ['header whose ask is empty after the space is rejected', s => s.replace('\n\n## Acceptance', '\n- [ ] polish: \n\n## Acceptance'), [10, 11, 12, 13, 14, 15]],
    // An appended checkbox is a new item, never the continuation of the ask above it.
    ['indented checkbox continuation is rejected', s => s.replace('\n\n## Acceptance', `\n${ask}\n  - [ ] Also rewrite the module into three files.\n\n## Acceptance`), [11, 12, 13, 14, 15, 16]],
    // Reaches the positional guard: consumption happens only where polish may be appended.
    ['wrapped item outside the Checklist section is rejected', s => s.replace('Preserve this text.', () => `Preserve this text.\n${ask}\n      Its continuation is indented, but this is not the checklist.`), [14, 15]],
  ];
  for (const [name, edit, lines] of cases) await t.test(name, async t => {
    const f = fixture(t), text = edit(f.batchText); assert.notEqual(text, f.batchText);
    f.candidate.write(BATCHFILE, text); f.candidate.commit(name);
    const r = (await api).checkFence(f.opts);
    state(r, lines.length ? 'VIOLATION' : 'PASS', lines.length ? 'batch-content' : undefined);
    assert.deepEqual(r.violations.filter(d => d.code === 'batch-content' && d.path === BATCHFILE).map(d => d.line), lines, JSON.stringify(r.violations));
  });
});
test('a checkbox is excluded from the polish continuation, and only a checkbox is', async () => {
  // Any indented non-blank line used to be consumed, so an appended checkbox rode in as if it
  // were wrapped prose. Every other indented form this repository writes must still continue.
  const ask = '- [x] polish: An ask that wraps, as every checklist line in this repository does.';
  const smuggled = [
    '  - [ ] Also rewrite the module into three files.', '  - [x] Also rewrite the module into three files.',
    '  * [ ] The star marker renders the same task item.', '  + [X] The plus marker, with a capital tick.',
    '  1. [ ] An ordered task item is a task item too.', '  1) [x] Ordered with a paren, already ticked.',
    // These two are the only inputs that reach the tab and the multi-digit ordinal: without
    // them `[ \t]+` narrows to `[ ]+` and `\d{1,9}` to `\d` with the suite still green.
    '  -\t[ ] A tab after the marker is the whitespace markdown allows there.',
    '  10. [ ] A two-digit ordinal, because one digit is not the whole ordered family.',
  ];
  const continuations = [
    '      of this repository produces, so the wrapped form still reads as one ask.',
    '      - a plain bullet sub-point, which is not a checkbox.',
    '      - [] an empty bracket pair, the only indented bracket form `.agents` holds.',
    '      -[x] no space after the marker, so no renderer makes this a task item.',
    '      [x] a bare bracket pair with no list marker at all.',
  ];
  // Relate both literals to the predicate being narrowed: every line in EITHER list was consumed
  // before, so each acceptance is a live control and each rejection a real change of verdict.
  for (const line of [...smuggled, ...continuations]) assert.match(line, /^ +\S/);
  assert.equal(new Set([...smuggled, ...continuations]).size, smuggled.length + continuations.length);
  // Sizes written by hand, not derived from the arrays: dropping a spelling while simplifying
  // would otherwise shrink both sides of every count above it and leave its path unguarded.
  assert.equal(smuggled.length, 8);
  assert.equal(continuations.length, 5);
  for (const [line, rejected] of [...smuggled.map(l => [l, true]), ...continuations.map(l => [l, false])]) {
    const baseline = makeBatch(['allowed.txt']), proposed = baseline.replace('\n\n## Acceptance', () => `\n${ask}\n${line}\n\n## Acceptance`);
    assert.notEqual(proposed, baseline);
    const crlf = [baseline, proposed].map(s => s.replace(/\n/g, '\r\n'));
    const found = (await api).validateBatchEdit(baseline, proposed, ['allowed.txt'], [], BATCHFILE);
    // A verdict that turned on the checkout rather than the code would differ between these.
    assert.deepEqual((await api).validateBatchEdit(crlf[0], crlf[1], ['allowed.txt'], [], BATCHFILE), found, line);
    assert.equal(found.length > 0, rejected, JSON.stringify([line, found]));
    if (rejected) assert.ok(found.every(d => d.code === 'batch-content' && d.path === BATCHFILE), JSON.stringify(found));
  }
});
test('the batch template SHOWS the wrapped polish form, unticked and ticked, in the exact bytes the validator accepts', async () => {
  // Read from the shipped template, never a copy: the forms shown to implementers and to the
  // orchestrator (whose prose-ASK commit appends its item already ticked) and the form the
  // mechanical gate accepts cannot drift apart. Either checkout style parses. Every shown item is
  // governed, not the first alone.
  const template = fs.readFileSync(path.join(__dirname, '..', 'orchestrate', 'templates', '02-batch.md'), 'utf8').replace(/\r\n?/g, '\n');
  const shown = [...template.matchAll(/^- \[([ x])\] polish: .+(?:\n +\S[^\n]*)+/gm)];
  assert.deepEqual(shown.map(m => m[1]), [' ', 'x'],
    'orchestrate/templates/02-batch.md must SHOW a wrapped unticked polish item and a wrapped ticked one, not only describe them');
  assert.equal([...template.matchAll(/^- \[[ xX]\] polish:/gm)].length, shown.length, 'every polish header the template holds is a shown wrapped item');
  const baseline = makeBatch(['allowed.txt']);
  // Each item alone, then both in order: the implementer's pass and the orchestrator's item together.
  for (const items of [...shown.map(m => [m[0]]), shown.map(m => m[0])]) {
    for (const item of items) {
      const block = item.split('\n');
      // The space indent the validator itself requires, so this parse cannot admit a form it rejects.
      assert.ok(block.length >= 2 && block.slice(1).every(l => /^ +\S/.test(l)), JSON.stringify(block));
    }
    const proposed = baseline.replace('\n\n## Acceptance', () => `\n${items.join('\n')}\n\n## Acceptance`);
    assert.notEqual(proposed, baseline);
    assert.deepEqual((await api).validateBatchEdit(baseline, proposed, ['allowed.txt'], [], BATCHFILE), [], items.join('\n'));
  }
});
test('own batch rejects every forbidden structural edit with line diagnostics', async t => {
  const edits = {
    reword: s => s.replace('Implement behavior.', 'Implement something else.'), reset: s => s.replace('- [x] Keep', '- [ ] Keep'),
    remove: s => s.replace('- [ ] Implement behavior.\n', ''), reorder: s => s.replace('- [ ] Implement behavior.\n- [x] Keep completed item.', '- [x] Keep completed item.\n- [ ] Implement behavior.'),
    ordinary: s => s.replace('\n\n## Acceptance', '\n- [x] Sneak in work.\n\n## Acceptance'), outside: s => s.replace('Preserve this text.', 'Changed acceptance.'),
    section: s => s.replace('## Acceptance', '## Modified'), title: s => s.replace('# B01', '# B99'), files: s => s.replace('`allowed.txt`', '`allowed.txt`, `outside.txt`'),
  };
  for (const [name, edit] of Object.entries(edits)) await t.test(name, async t => {
    const f = fixture(t); f.candidate.write(BATCHFILE, edit(f.batchText)); f.candidate.commit(name); const r = (await api).checkFence(f.opts);
    state(r, 'VIOLATION', name === 'files' ? 'batch-files' : 'batch-content'); assert.ok(r.violations.some(d => d.path === BATCHFILE && Number.isInteger(d.line)));
  });
});
test('batch deletion and rename cannot be treated as permitted own-file edits', async t => {
  for (const rename of [false, true]) await t.test(rename ? 'rename' : 'delete', async t => {
    const f = fixture(t); if (rename) f.candidate.git('mv', BATCHFILE, `${LEDGER}/02-batches-01-new.md`); else f.candidate.git('rm', BATCHFILE); f.candidate.commit('remove batch');
    state((await api).checkFence(f.opts), 'VIOLATION', 'batch-type');
  });
});
test('UNKNOWN takes precedence while preserving known violations; invalid CLI flags are structured', async t => {
  const f = fixture(t); f.authority(f.plan.replace('`allowed.txt`', '`*.txt`')); f.candidate.write('dirty', 'dirt'); const before = [f.repo.snapshot(), f.candidate.snapshot()];
  const c = f.cli(); assert.equal(c.status, 2); state(c.json, 'UNKNOWN', 'authority'); assert.ok(c.json.violations.some(d => d.code === 'dirty-worktree')); assert.ok(c.json.unknowns.length); assert.deepEqual([f.repo.snapshot(), f.candidate.snapshot()], before);
  for (const args of [[], [...f.args, '--unknown', 'x'], [...f.args, '--repo', f.repo.cwd], f.args.slice(0, -1)]) {
    const r = f.repo.cli('check-fence.mjs', args); assert.equal(r.status, 2); state(r.json, 'UNKNOWN', 'usage');
  }
  const help = f.repo.cli('check-fence.mjs', ['--help']); assert.equal(help.status, 0); assert.match(help.stdout, /UNKNOWN takes precedence/);
});

test('criss-cross merge bases are UNKNOWN and preserve a clean candidate snapshot', async t => {
  const f = fixture(t), tree = f.repo.git('rev-parse', `${f.base}^{tree}`);
  const a = f.repo.git('commit-tree', tree, '-p', f.base, '-m', 'left');
  const b = f.repo.git('commit-tree', tree, '-p', f.base, '-m', 'right');
  const left = f.repo.git('commit-tree', tree, '-p', a, '-p', b, '-m', 'merge left');
  const right = f.repo.git('commit-tree', tree, '-p', b, '-p', a, '-m', 'merge right');
  f.repo.git('update-ref', INT, left); f.candidate.git('reset', '--hard', right);
  const before = [f.repo.snapshot(), f.candidate.snapshot()];
  const c = f.cli(); assert.equal(c.status, 2); state(c.json, 'UNKNOWN', 'merge-base'); assert.equal(c.json.mergeBase, null); assert.deepEqual([f.repo.snapshot(), f.candidate.snapshot()], before);
});
test('own batch type replacement is rejected even with identical blob bytes', async t => {
  const f = fixture(t); f.candidate.git('config', 'core.symlinks', 'false');
  const blob = f.candidate.git('hash-object', '-w', '--', BATCHFILE); f.candidate.git('update-index', '--cacheinfo', `120000,${blob},${BATCHFILE}`); f.candidate.git('commit', '-m', 'replace own file type');
  const r = (await api).checkFence(f.opts); state(r, 'VIOLATION', 'batch-type'); assert.ok(r.evidence.changes.some(c => c.status === 'T' && c.paths[0] === BATCHFILE));
});
test('candidate with no associated worktree and missing integration objects are UNKNOWN', async t => {
  const f = fixture(t); f.candidate.git('checkout', '--detach');
  state((await api).checkFence(f.opts), 'UNKNOWN', 'candidate-worktree');
  state((await api).checkFence({ ...f.opts, integration: 'refs/heads/missing' }), 'UNKNOWN', 'git-probe');
});

test('ref and worktree races during real probes return UNKNOWN', async t => {
  const { checkFence } = await api;
  for (const kind of ['ref', 'checkout']) await t.test(kind, t => {
    const f = fixture(t), stat = fs.statSync; let fired = false;
    const newTip = f.repo.git('commit-tree', f.repo.git('rev-parse', `${f.base}^{tree}`), '-p', f.base, '-m', 'concurrent update');
    // Trigger a real external Git mutation at the filesystem observation boundary.
    // The API and CLI still use actual Git output; no evidence is fabricated.
    fs.statSync = function(file, ...args) {
      if (!fired && path.resolve(file) === path.resolve(f.candidate.cwd)) {
        fired = true;
        if (kind === 'ref') f.repo.git('update-ref', INT, newTip);
        else f.candidate.git('checkout', '--detach');
      }
      return stat.call(this, file, ...args);
    };
    let r; try { r = checkFence(f.opts); } finally { fs.statSync = stat; }
    assert.equal(fired, true); state(r, 'UNKNOWN', kind === 'ref' ? 'ref-race' : 'candidate-worktree');
  });
});
test('unsupported original Checklist shapes are UNKNOWN, not a content verdict', async t => {
  const f = fixture(t);
  // Rebuild the fixture's common authority commit with a legacy checklist heading.
  f.candidate.git('checkout', '--detach'); f.repo.write(BATCHFILE, f.batchText.replace('## Checklist', '## Tasks')); const baseline = f.repo.commit('legacy shape');
  f.repo.git('update-ref', INT, baseline); f.repo.git('update-ref', BATCH, baseline); f.candidate.git('checkout', 'batch-one');
  state((await api).checkFence(f.opts), 'UNKNOWN', 'batch-structure');
});

test('an inaccessible unrelated worktree is unknown evidence rather than a false clean gate', async t => {
  const f = fixture(t), other = path.join(f.repo.root, 'other-worktree'); f.repo.git('worktree', 'add', '-b', 'other-worktree', other); fs.renameSync(other, path.join(f.repo.root, 'moved-other'));
  const r = (await api).checkFence(f.opts); state(r, 'UNKNOWN', 'worktree-unavailable'); assert.deepEqual(r.violations, []); assert.ok(r.evidence.worktreeDiagnostics.some(d => d.code === 'worktree-unavailable'));
});
test('authority file type replacement cannot supply a valid plan from a symlink blob', async t => {
  const f = fixture(t), file = `${LEDGER}/01-plan.md`; f.repo.git('config', 'core.symlinks', 'false');
  const blob = f.repo.git('hash-object', '-w', '--', file); f.repo.git('update-index', '--cacheinfo', `120000,${blob},${file}`); f.repo.git('commit', '-m', 'authority type replacement'); f.repo.git('update-ref', INT, f.repo.git('rev-parse', 'HEAD'));
  state((await api).checkFence(f.opts), 'UNKNOWN', 'authority-file');
});

test('own batch executable-bit edits are outside permitted checklist-only changes', async t => {
  const f = fixture(t); f.candidate.git('update-index', '--chmod=+x', '--', BATCHFILE); f.candidate.git('commit', '-m', 'own batch mode');
  state((await api).checkFence(f.opts), 'VIOLATION', 'batch-type');
});

test('configured filters leave the fence UNKNOWN without executing a command or changing bytes', async t => {
  const f = fixture(t), marker = path.join(f.candidate.cwd, 'filter-must-not-run'), script = path.join(f.repo.root, 'fence-filter.cjs');
  fs.writeFileSync(script, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed'); process.stdin.pipe(process.stdout);`);
  f.repo.write('.git/info/attributes', 'allowed.txt filter=marker\n'); f.repo.git('config', 'filter.marker.clean', `node "${script.replaceAll('\\', '/')}"`);
  f.candidate.write('allowed.txt', 'changed'); fs.utimesSync(path.join(f.candidate.cwd, 'allowed.txt'), new Date(0), new Date(0));
  const before = [f.repo.snapshot(), f.candidate.snapshot()]; const r = (await api).checkFence(f.opts), c = f.cli();
  state(r, 'UNKNOWN', 'unsafe-filter'); assert.equal(c.status, 2); state(c.json, 'UNKNOWN', 'unsafe-filter'); assert.equal(fs.existsSync(marker), false); assert.deepEqual([f.repo.snapshot(), f.candidate.snapshot()], before);
});
test('a configured driver no path resolves to leaves the fence mechanically usable', async t => {
  // Both observations of the worktree inventory run the status prerequisite, so a driver
  // that a stock install configures system-wide used to cost every candidate its verdict.
  const f = fixture(t), marker = path.join(f.candidate.cwd, 'filter-must-not-run'), script = path.join(f.repo.root, 'unresolved-fence-filter.cjs');
  fs.writeFileSync(script, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed'); process.stdin.pipe(process.stdout);`);
  f.repo.git('config', 'filter.marker.clean', `node "${script.replaceAll('\\', '/')}"`);
  f.candidate.write('allowed.txt', 'implemented\n'); f.candidate.write(BATCHFILE, f.batchText.replace('- [ ]', '- [x]')); const sha = f.candidate.commit('implement');
  const before = [f.repo.snapshot(), f.candidate.snapshot()]; const r = (await api).checkFence(f.opts), c = f.cli();
  state(r, 'PASS'); assert.equal(c.status, 0, c.stdout); state(c.json, 'PASS'); assert.equal(c.json.batchSha, sha);
  assert.deepEqual(r.evidence.worktreeDiagnostics, []);
  assert.equal(fs.existsSync(marker), false); assert.deepEqual([f.repo.snapshot(), f.candidate.snapshot()], before);
  // Live-canary control, last because it is destructive. The absence above is vacuous
  // unless this fixture CAN execute the driver, and no attributes file named it until now.
  f.repo.write('.git/info/attributes', 'allowed.txt filter=marker\n');
  // Equal byte length on purpose: status short-circuits on a size change and never
  // converts, so only a same-size edit makes the driver reachable at all.
  f.candidate.write('allowed.txt', 'IMPLEMENTED\n'); fs.utimesSync(path.join(f.candidate.cwd, 'allowed.txt'), new Date(0), new Date(0));
  f.candidate.git('status', '--porcelain=v1', '--untracked-files=all');
  assert.equal(fs.existsSync(marker), true, 'the fixture must be able to execute the driver, or absence proves nothing');
});
test('staged and unstaged type dirt produce a deterministic fence VIOLATION in API and CLI', async t => {
  const { checkFence } = await api;
  for (const kind of ['staged', 'unstaged']) await t.test(kind, t => {
    const f = fixture(t); f.candidate.git('config', 'core.symlinks', 'false'); const blob = f.candidate.git('hash-object', '-w', '--', 'allowed.txt'); f.candidate.git('update-index', '--cacheinfo', `120000,${blob},allowed.txt`);
    if (kind === 'unstaged') { f.candidate.git('commit', '-m', 'symlink index'); f.candidate.git('config', 'core.symlinks', 'true'); }
    const before = [f.repo.snapshot(), f.candidate.snapshot()], r = checkFence(f.opts), c = f.cli();
    state(r, 'VIOLATION', 'dirty-worktree'); assert.equal(c.status, 1); state(c.json, 'VIOLATION', 'dirty-worktree');
    for (const result of [r, c.json]) assert.deepEqual(result.violations.find(d => d.code === 'dirty-worktree').entries, [{ status: kind === 'staged' ? 'T ' : ' T', path: 'allowed.txt', originalPath: null }]);
    assert.deepEqual([f.repo.snapshot(), f.candidate.snapshot()], before);
  });
});
test('late real working-file mutation requires the final worktree-race comparison', async t => {
  const { checkFence } = await api, f = fixture(t), originalStat = fs.statSync, before = f.candidate.snapshot(); let observations = 0;
  fs.statSync = function(file, ...args) {
    if (path.resolve(file) === path.resolve(f.candidate.cwd) && ++observations === 2) f.candidate.write('allowed.txt', 'concurrent uncommitted update');
    return originalStat.call(this, file, ...args);
  };
  let r; try { r = checkFence(f.opts); } finally { fs.statSync = originalStat; }
  assert.equal(observations, 2); state(r, 'UNKNOWN', 'worktree-race');
  assert.equal(r.evidence.worktrees.find(w => w.branch === BATCH).cleanliness, 'clean'); assert.deepEqual(r.violations, []);
  const after = f.candidate.snapshot(); assert.equal(after.head, before.head); assert.equal(after.index, before.index); assert.equal(after.refs, before.refs);
  assert.deepEqual(after.files, { ...before.files, 'allowed.txt': Buffer.from('concurrent uncommitted update').toString('base64') }); assert.match(f.candidate.git('status', '--porcelain'), /M allowed\.txt/);
});
