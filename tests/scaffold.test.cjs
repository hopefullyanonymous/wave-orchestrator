'use strict';
// scaffold.mjs fills the ledger templates from an answers file. The answers fixture is built from
// the domain the tool exports, which is checked here against the checkout's templates read by this
// file's own oracle, so neither the fixture nor the domain can drift from the templates. Every
// refusal is run against a fixture repository whose whole tree is compared before and after:
// nothing may be written on any refusal. The logic runs in-process; the CLI runs a few times.
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');

const ROOT = path.resolve(__dirname, '..');
const SKILL = path.join(ROOT, 'orchestrate');
const TOOL = path.join(SKILL, 'tools', 'scaffold.mjs');
const load = name => import(pathToFileURL(path.join(SKILL, 'tools', name)).href);
const api = () => load('scaffold.mjs');
const TEMPLATES = path.join(SKILL, 'templates');
const lf = text => text.split('\r\n').join('\n');
const CHANGE_ID = 'TS-20990101-sample';
const LEDGER = '.agents/changes/' + CHANGE_ID;

// ===== Fixture repositories ======================================================================
const BACKLOG = [
  '# Backlog', '',
  '| id | what |', '|---|---|',
  '| TB-007 | a table item |', '| TB-012 | another table item |', '| TB-003 | done item Folded into XX-20000101-old B01. |', '| TB-015 | tight|', '',
  '- TB-020 a listed item', '- [ ] an unnumbered item', '- another unnumbered item', '| an unnumbered row |', '- x Folded into XX-20000101-old B01.', '',
  'Note: TB-007 was split.', 'Note: XTB-099 is foreign.', '',
].join('\n');
const FILES = { 'README.md': '# Readme\n', 'src/a.txt': 'a\n', 'src/b.txt': 'b\n', 'BACKLOG.md': BACKLOG };

function tmp(t, prefix = 'scaffold-test-') {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }));
  return dir;
}
function writeFiles(dir, files) {
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(dir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, content);
  }
}
// A committed repository under an isolated git configuration, maintenance and gc off.
function fixture(t, files = FILES, { objectFormat = 'sha1' } = {}) {
  const dir = tmp(t), repo = path.join(dir, 'repo'), stage = path.join(dir, 'stage'), template = path.join(dir, 'template');
  fs.mkdirSync(repo); fs.mkdirSync(stage); fs.mkdirSync(template);
  const config = path.join(dir, 'git.config');
  fs.writeFileSync(config, '[maintenance]\n\tauto = false\n[gc]\n\tauto = 0\n[user]\n\tname = Fixture\n\temail = fixture@example.invalid\n[core]\n\tautocrlf = false\n[commit]\n\tgpgSign = false\n');
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^GIT_/i.test(k))), GIT_CONFIG_GLOBAL: config, GIT_CONFIG_NOSYSTEM: '1' };
  const git = (...args) => {
    const r = spawnSync('git', args, { cwd: repo, env, encoding: 'utf8', windowsHide: true, timeout: 60000 });
    assert.ifError(r.error); assert.equal(r.status, 0, 'git ' + args.join(' ') + ': ' + r.stderr);
    return r.stdout.trim();
  };
  git('init', '--initial-branch=main', '--object-format=' + objectFormat, '--template=' + template);
  writeFiles(repo, files);
  git('add', '--all'); git('commit', '-m', 'base');
  return { dir, repo, stage, git, base: git('rev-parse', 'HEAD') };
}
// The whole working tree, .git aside, as path → content hash.
function snapshot(repo) {
  const out = {};
  const walk = (abs, rel) => {
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      if (!rel && e.name === '.git') continue;
      const r = rel ? rel + '/' + e.name : e.name, full = path.join(abs, e.name);
      if (e.isDirectory()) { out[r + '/'] = 'dir'; walk(full, r); }
      else out[r] = createHash('sha256').update(fs.readFileSync(full)).digest('hex');
    }
  };
  walk(repo, '');
  return out;
}
const readRepo = (fx, rel) => fs.readFileSync(path.join(fx.repo, ...rel.split('/')), 'utf8');

// ===== The answers, built from the exported domain ===============================================
// The values a ledger's parse, selfcheck and plan read; every other key gets a plain value.
const SPECIAL = {
  ID_PREFIX: 'TS', CHANGE_SLUG: 'sample', DATE: '2099-01-01', MAIN_BRANCH: 'refs/heads/main',
  INTEGRATION_BRANCH: 'chore/sample-ledger', SHIPMENT_SOURCE: 'local', SHIPMENT_REF: 'refs/heads/main',
  WORKTREE_SETUP: 'n/a — nothing to install', VALIDATION_COMMANDS: '```text\nnode --test\n```', BACKLOG_ID_PREFIX: '`TB-`',
};
const BATCHES = [
  { num: '01', slug: 'one', title: 'One', branch: 'feat/one', wave: '1', deps: 'none', files: ['src/a.txt'] },
  { num: '02', slug: 'two', title: 'Two', branch: 'fix/two', wave: '2', deps: 'B01', files: ['src/b.txt'] },
];
const fence = b => b.files.map(f => '`' + f + '`').join(', ');
const planRow = b => `| B${b.num} | ${b.title} | feature | S | \`${b.branch}\` | ${b.wave} | ${fence(b)} | C1 | — |`;
const progressRow = b => `| B${b.num} | ${b.title} | \`${b.branch}\` | ${b.wave} | — | ⬜ | 2099-01-01 | — |`;
const SPECIAL_SECTIONS = {
  '01-plan.md ## Batch table': batches => batches.map(planRow).join('\n'),
  'PROGRESS.md ## Batches': batches => batches.map(progressRow).join('\n'),
  '01-plan.md ## Coverage audit (planning-time)': () => 'Every item is covered.\n\nPre-flight: CLEAN',
  'PROGRESS.md # Progress': () => '',
};
const VALIDATE = { steps: [{ name: 'tests', argv: ['node', '--test'], parser: 'node' }] };

function answersFor(domain, fx, batches = BATCHES) {
  for (const k of Object.keys(SPECIAL)) assert.ok(domain.values.required.includes(k), 'the fixture fills a key the domain requires: ' + k);
  for (const k of Object.keys(SPECIAL_SECTIONS)) assert.ok(domain.sections.includes(k), 'the fixture fills a section the domain requires: ' + k);
  const values = Object.fromEntries(domain.values.required.map(k => [k, SPECIAL[k] ?? 'value of ' + k]));
  values.BASE_SHA = fx.base;
  const sections = Object.fromEntries(domain.sections.map((k, i) => [k, SPECIAL_SECTIONS[k] ? SPECIAL_SECTIONS[k](batches) : 'Section text ' + (i + 1) + '.']));
  return {
    values, sections,
    batches: batches.map(b => {
      const special = { BATCH_NUM: b.num, BATCH_SLUG: b.slug, BATCH_TITLE: b.title, BATCH_TYPE: 'feature', BATCH_VERSION: '—', BATCH_BRANCH: b.branch,
        BATCH_WAVE: b.wave, BATCH_DEPS: b.deps, BATCH_FILES: fence(b), BATCH_NEW_FILES: 'none', BATCH_WEIGHT: 'S' };
      return {
        values: Object.fromEntries(domain.batches.values.map(k => [k, special[k] ?? 'value of ' + k])),
        sections: Object.fromEntries(domain.batches.sections.map((k, i) => [k, k === '## Checklist' ? '- [ ] Do the work.' : 'Batch section ' + (i + 1) + '.'])),
      };
    }),
    validate: VALIDATE, setup: null,
    foldins: [{ file: 'BACKLOG.md', id: 'TB-012', batch: 'B02' }],
  };
}
const clone = v => JSON.parse(JSON.stringify(v));

async function setup(t, files, options) {
  const { scaffold, answersDomain } = await api();
  const fx = fixture(t, files, options), domain = answersDomain();
  return { fx, domain, answers: answersFor(domain, fx), run: (answers, opts = {}) => scaffold(answers, { repo: fx.repo, tmpRoot: fx.stage, ...opts }) };
}
// A refusal names every expected problem and leaves the tree and the staging root as they were.
async function refuses(ctx, answers, expected, opts) {
  const before = snapshot(ctx.fx.repo);
  const r = await ctx.run(answers, opts);
  assert.equal(r.status, 'FAIL', 'must refuse: ' + expected.join(' | '));
  assert.equal(r.code, 1);
  for (const e of expected) assert.ok(r.problems.some(p => p.includes(e)), 'expected a problem naming ' + JSON.stringify(e) + ', got ' + JSON.stringify(r.problems));
  assert.deepEqual(snapshot(ctx.fx.repo), before, 'nothing written under --repo');
  assert.deepEqual(fs.readdirSync(ctx.fx.stage), [], 'the staging directory removed');
  assert.match(r.line, /^SCAFFOLD FAIL \d+ problem\(s\): /);
  return r;
}
// The fixture as committed again, so a second accepted run can write the same ledger.
function reset(ctx) {
  fs.rmSync(path.join(ctx.fx.repo, '.agents'), { recursive: true, force: true });
  ctx.fx.git('checkout', '--', '.');
}
async function accepts(ctx, answers, opts) {
  const r = await ctx.run(answers, opts);
  assert.equal(r.status, 'OK', JSON.stringify(r.problems));
  assert.deepEqual(fs.readdirSync(ctx.fx.stage), [], 'the staging directory removed');
  return r;
}

// ===== The domain ================================================================================
// The oracle: each template's placeholders outside its comments, and each comment's nearest
// preceding heading line, read here with no code shared with the tool.
function oracle() {
  const names = fs.readdirSync(TEMPLATES).sort(), out = {};
  for (const name of names) {
    const content = lf(fs.readFileSync(path.join(TEMPLATES, name), 'utf8'));
    const bare = content.replace(/<!--[\s\S]*?-->/g, '');
    const headings = [];
    let at = 0;
    for (const m of content.matchAll(/<!--/g)) {
      const before = content.slice(0, m.index).split('\n').filter(l => /^#{1,6} /.test(l));
      headings.push(before[before.length - 1]);
      at++;
    }
    out[name] = { placeholders: [...new Set([...bare.matchAll(/\{\{([A-Z0-9_]+)\}\}/g)].map(m => m[1]))], headings, comments: at };
  }
  return out;
}

test('answersDomain is the templates\' own placeholders and instruction comments, keyed by heading', async () => {
  const { answersDomain } = await api();
  const domain = answersDomain(), o = oracle(), names = Object.keys(o);
  assert.ok(names.includes('02-batch.md') && names.length >= 6, 'the templates directory as checked out: ' + names);
  const top = new Set(names.filter(n => n !== '02-batch.md').flatMap(n => o[n].placeholders));
  assert.ok(top.size > 20 && o['02-batch.md'].placeholders.length > 5, 'the oracle reads real placeholders');
  // Every placeholder outside the batch template, plus the two naming-only values, is required or computed.
  assert.deepEqual([...domain.values.required, ...domain.values.computed].sort(), [...new Set([...top, 'ID_PREFIX', 'CHANGE_SLUG', ...domain.values.computed])].sort());
  assert.deepEqual(domain.values.computed, ['CHANGE_ID', 'LEDGER_DIR', 'SKILL_DIR', 'SKILL_SHA256']);
  assert.equal(domain.values.required.filter(k => domain.values.computed.includes(k)).length, 0);
  for (const k of domain.values.computed) assert.ok(top.has(k), 'a computed value fills a template placeholder: ' + k);
  assert.deepEqual(domain.batches.values, [...o['02-batch.md'].placeholders.filter(k => !top.has(k)), 'BATCH_SLUG'].sort());
  // One section key per comment, under the heading it sits beneath.
  const sections = names.filter(n => n !== '02-batch.md').flatMap(n => o[n].headings.map(h => n + ' ' + h)).sort();
  assert.deepEqual(domain.sections, sections);
  assert.equal(domain.sections.length, names.filter(n => n !== '02-batch.md').reduce((s, n) => s + o[n].comments, 0));
  assert.deepEqual(domain.batches.sections, o['02-batch.md'].headings.slice().sort());
  assert.ok(domain.sections.includes('LOG.md ## {{DATE}} — scaffold') && domain.sections.includes('PROGRESS.md # Progress'), 'headings as written');
  assert.deepEqual(domain.keys, ['values', 'sections', 'batches', 'validate', 'setup', 'foldins']);
});

// The line endings a checkout can give the templates: LF, and CRLF (Git for Windows' default).
const EOLS = { lf: '\n', crlf: '\r\n' };
// A copy of the skill directory whose templates a test may edit. Given a key of EOLS, every template
// is first rewritten in that line ending and, after the edit, must be written in it alone: an edit
// test then runs on CRLF templates on every platform, whichever way this checkout came out.
function skillCopy(t, edit = () => {}, eol) {
  const dir = path.join(tmp(t, 'scaffold-skill-' + (eol ? eol + '-' : '')), 'orchestrate'), templates = path.join(dir, 'templates');
  fs.cpSync(SKILL, dir, { recursive: true });
  const inEol = n => lf(fs.readFileSync(path.join(templates, n), 'utf8')).split('\n').join(EOLS[eol]);
  if (eol) for (const n of fs.readdirSync(templates)) fs.writeFileSync(path.join(templates, n), inEol(n));
  edit(templates);
  if (eol) for (const n of fs.readdirSync(templates)) assert.ok(fs.readFileSync(path.join(templates, n), 'utf8') === inEol(n), n + ' is written in ' + eol + ' alone after the edit');
  return dir;
}
// One edit of a copied template, kept in the template's own line ending: the anchor and its
// replacement are written with LF and take CRLF where the file has it.
const editFile = (file, from, to) => {
  const before = fs.readFileSync(file, 'utf8'), own = text => before.includes('\r\n') ? text.split('\n').join('\r\n') : text;
  assert.equal(before.split(own(from)).length, 2, 'the edit anchor occurs exactly once in ' + file);
  fs.writeFileSync(file, before.split(own(from)).join(own(to)));
};

test('a template edit flows through: an added placeholder is required, a removed comment\'s key refused, an added one required', async t => {
  const { answersDomain } = await api();
  for (const eol of Object.keys(EOLS)) {
    const ctx = await setup(t);
    const added = skillCopy(t, dir => editFile(path.join(dir, '00-request.md'), '## User decisions\n', '## User decisions\n\nProbe: {{SCAFFOLD_PROBE}}\n'), eol);
    assert.ok(answersDomain(added).values.required.includes('SCAFFOLD_PROBE'), eol + ': the added placeholder is required');
    await refuses(ctx, ctx.answers, ['values: missing SCAFFOLD_PROBE'], { skillDir: added });
    const withProbe = clone(ctx.answers); withProbe.values.SCAFFOLD_PROBE = 'probe value';
    await accepts(ctx, withProbe, { skillDir: added });
    assert.ok(readRepo(ctx.fx, LEDGER + '/00-request.md').includes('Probe: probe value\n'), eol + ': the added placeholder is filled');

    const ctx2 = await setup(t);
    const removed = skillCopy(t, dir => {
      const file = path.join(dir, 'LOG.md'), content = fs.readFileSync(file, 'utf8');
      const at = content.indexOf('## Learnings'), start = content.indexOf('<!--', at), end = content.indexOf('-->', start) + 3;
      assert.ok(at > 0 && start > at && end > start);
      fs.writeFileSync(file, content.slice(0, start) + 'Learnings go here.' + content.slice(end));
    }, eol);
    assert.ok(!answersDomain(removed).sections.includes('LOG.md ## Learnings'), eol + ': the removed comment has no key');
    await refuses(ctx2, ctx2.answers, ['sections: unknown key "LOG.md ## Learnings"'], { skillDir: removed });

    const batchComment = skillCopy(t, dir => editFile(path.join(dir, '02-batch.md'), '## Validation\n', '## Validation\n\n<!-- probe -->\n'), eol);
    assert.ok(answersDomain(batchComment).batches.sections.includes('## Validation'), eol + ': the added comment is keyed');
    await refuses(ctx2, ctx2.answers, ['batches[0].sections: missing ## Validation', 'batches[1].sections: missing ## Validation'], { skillDir: batchComment });
  }
});

test('templates checked out CRLF give the same domain and the same ledger bytes as LF ones', async t => {
  const { answersDomain } = await api();
  const lfSkill = skillCopy(t, dir => { for (const n of fs.readdirSync(dir)) fs.writeFileSync(path.join(dir, n), lf(fs.readFileSync(path.join(dir, n), 'utf8'))); });
  const crlfSkill = skillCopy(t, dir => { for (const n of fs.readdirSync(dir)) fs.writeFileSync(path.join(dir, n), lf(fs.readFileSync(path.join(dir, n), 'utf8')).split('\n').join('\r\n')); });
  assert.ok(fs.readFileSync(path.join(crlfSkill, 'templates', '01-plan.md'), 'utf8').includes('\r\n'));
  assert.deepEqual(answersDomain(crlfSkill), answersDomain(lfSkill));
  const outputs = [];
  for (const skillDir of [lfSkill, crlfSkill]) {
    const ctx = await setup(t);
    await accepts(ctx, ctx.answers, { skillDir });
    const dir = path.join(ctx.fx.repo, ...LEDGER.split('/'));
    const slash = skillDir.split(path.sep).join('/');
    outputs.push(Object.fromEntries(fs.readdirSync(dir).sort().map(n => [n, fs.readFileSync(path.join(dir, n), 'utf8').split(slash).join('<skill>').split(ctx.fx.base).join('<base>')])));
  }
  assert.deepEqual(outputs[1], outputs[0]);
  assert.ok(!Object.values(outputs[0]).some(v => v.includes('\r')), 'an LF repository gets LF files from CRLF templates');
});

// ===== The OK path ===============================================================================
test('a complete answers file writes a ledger that passes parse, selfcheck and plan, and renders a prompt per batch', async t => {
  const { parseLedger, selfcheck, planCheck } = await load('check-ledger.mjs');
  const { promptCli } = await load('prompt.mjs');
  const ctx = await setup(t);
  // A section ending in line breaks leaves no extra blank line.
  ctx.answers.sections['01-plan.md ## Wave map & checkpoints'] = 'W1 then W2.\n\n\n';
  const r = await accepts(ctx, ctx.answers);
  const templates = fs.readdirSync(TEMPLATES).length;
  const expected = [...fs.readdirSync(TEMPLATES).filter(n => n !== '02-batch.md'), '02-batches-01-one.md', '02-batches-02-two.md', 'validate.json'].sort();
  assert.equal(r.line, `SCAFFOLD OK ${CHANGE_ID} 2 batches, ${templates - 1 + 2 + 1} files`);
  const dir = path.join(ctx.fx.repo, ...LEDGER.split('/'));
  assert.deepEqual(fs.readdirSync(dir).sort(), expected);
  assert.deepEqual(r.files.slice().sort(), expected);
  assert.equal(parseLedger(dir).status, 'OK');
  assert.deepEqual(selfcheck(dir).problems, []);
  const plan = planCheck(dir, ctx.fx.repo);
  assert.deepEqual(plan.problems, []); assert.equal(plan.waves, 2);
  assert.equal(readRepo(ctx.fx, LEDGER + '/validate.json'), JSON.stringify(VALIDATE, null, 2) + '\n');
  // The computed values, filled.
  const contract = readRepo(ctx.fx, LEDGER + '/00-READBEFORE.md');
  assert.ok(contract.includes('**Change**: ' + CHANGE_ID + '\n'));
  assert.ok(contract.includes('(' + LEDGER + ')'));
  assert.ok(contract.includes('**Skill**: `' + SKILL.split(path.sep).join('/') + '` · sha256 `'));
  // No template trace: no slot, no example row, no doubled blank line where a comment went.
  for (const n of expected) {
    const content = readRepo(ctx.fx, LEDGER + '/' + n);
    assert.doesNotMatch(content, /\{\{|<!--|-->|<title>/, n);
    assert.ok(!content.includes('\n\n\n'), n + ': a removed comment leaves no doubled blank line');
  }
  const progress = readRepo(ctx.fx, LEDGER + '/PROGRESS.md');
  assert.ok(!progress.includes('is exactly one of') && progress.includes('**State**: ACTIVE\n'), 'the "" section removes the note');
  assert.ok(readRepo(ctx.fx, LEDGER + '/02-batches-01-one.md').startsWith('# B01 — One (feature, —)\n\n**Branch**: `feat/one`\n'));
  // The fold-in marker, and only it, in the backlog.
  assert.equal(readRepo(ctx.fx, 'BACKLOG.md'), BACKLOG.replace('| TB-012 | another table item |', () => '| TB-012 | another table item Folded into ' + CHANGE_ID + ' B02. |'));
  assert.deepEqual(r.foldins, ['BACKLOG.md']);
  const status = ctx.fx.git('status', '--porcelain', '--untracked-files=all').split('\n').map(l => l.trim().split(/\s+/).pop()).sort();
  assert.deepEqual(status, ['BACKLOG.md', ...expected.map(n => LEDGER + '/' + n)].sort(), 'the ledger and the backlog, nothing else');
  // Round trip: the implementer prompt renders for every batch.
  const facts = path.join(ctx.fx.dir, 'facts.json'), out = path.join(ctx.fx.dir, 'prompts');
  fs.writeFileSync(facts, JSON.stringify({ guardrails: 'none', repoPath: ctx.fx.repo, scratchpadPath: ctx.fx.dir, worktreePath: ctx.fx.repo }));
  for (const b of BATCHES) {
    const p = promptCli(['--ledger', dir, '--role', 'implementer', '--batch', 'B' + b.num, '--facts', facts, '--out', out]);
    assert.equal(p.code, 0, p.line);
    const file = /^PROMPT (.+) NONCE [0-9a-f]+$/.exec(p.line)[1];
    const prompt = fs.readFileSync(file, 'utf8');
    assert.ok(prompt.includes(readRepo(ctx.fx, LEDGER + '/02-batches-' + b.num + '-' + b.slug + '.md').trim()), 'the prompt carries the batch file');
    assert.ok(prompt.includes(b.branch));
  }
});

test('computed values may be supplied only as computed', async t => {
  const ctx = await setup(t);
  const { skillHash } = await load('check-ledger.mjs');
  const computed = { CHANGE_ID, LEDGER_DIR: LEDGER, SKILL_DIR: SKILL.split(path.sep).join('/'), SKILL_SHA256: skillHash(SKILL).hex };
  for (const k of Object.keys(computed)) {
    const a = clone(ctx.answers); a.values[k] = computed[k] + 'x';
    await refuses(ctx, a, ['values.' + k + ': supplied']);
  }
  const all = clone(ctx.answers); Object.assign(all.values, computed);
  await accepts(ctx, all);
});

// ===== Refusals derived from the domain ==========================================================
test('every missing and every unknown key is refused by name, and nothing is written', async t => {
  const ctx = await setup(t), { domain } = ctx;
  for (const k of domain.values.required) { const a = clone(ctx.answers); delete a.values[k]; await refuses(ctx, a, ['values: missing ' + k]); }
  for (const k of domain.sections) { const a = clone(ctx.answers); delete a.sections[k]; await refuses(ctx, a, ['sections: missing ' + k]); }
  for (const k of domain.batches.values) { const a = clone(ctx.answers); delete a.batches[1].values[k]; await refuses(ctx, a, ['batches[1].values: missing ' + k]); }
  for (const k of domain.batches.sections) { const a = clone(ctx.answers); delete a.batches[0].sections[k]; await refuses(ctx, a, ['batches[0].sections: missing ' + k]); }
  for (const k of domain.keys) { const a = clone(ctx.answers); delete a[k]; await refuses(ctx, a, ['answers: missing ' + k]); }
  // A key of one scope in another is a key no template carries there; so is a typo.
  const unknown = (where, k) => `${where}: unknown key ${JSON.stringify(k)}`;
  for (const k of [...domain.batches.values, 'MERGE_POLCY']) { const a = clone(ctx.answers); a.values[k] = 'x'; await refuses(ctx, a, [unknown('values', k)]); }
  for (const k of [...domain.values.required, ...domain.values.computed]) { const a = clone(ctx.answers); a.batches[0].values[k] = 'x'; await refuses(ctx, a, [unknown('batches[0].values', k)]); }
  for (const k of [...domain.batches.sections, 'LOG.md ## Learning']) { const a = clone(ctx.answers); a.sections[k] = 'x'; await refuses(ctx, a, [unknown('sections', k)]); }
  for (const k of domain.sections.slice(0, 3)) { const a = clone(ctx.answers); a.batches[0].sections[k] = 'x'; await refuses(ctx, a, [unknown('batches[0].sections', k)]); }
  { const a = clone(ctx.answers); a.schema = 1; await refuses(ctx, a, ['answers: unknown key "schema"']); }
  { const a = clone(ctx.answers); a.values.MERGE_POLICY = 7; await refuses(ctx, a, ['values.MERGE_POLICY must be a string']); }
  await refuses(ctx, [], ['the answers must be a JSON object']);
  // Control: the unaltered answers are accepted.
  await accepts(ctx, ctx.answers);
});

test('batch numbers run 01, 02, … with no gap, duplicate or reordering; names and the base are checked', async t => {
  const ctx = await setup(t);
  for (const nums of [['01', '03'], ['01', '01'], ['02', '01'], ['1', '2'], ['00', '01']]) {
    const a = clone(ctx.answers); a.batches.forEach((b, i) => { b.values.BATCH_NUM = nums[i]; });
    await refuses(ctx, a, ['.values.BATCH_NUM']);
  }
  const cases = [
    [a => { a.values.BASE_SHA = 'f'.repeat(40); }, 'values.BASE_SHA'],
    [a => { a.values.BASE_SHA = a.values.BASE_SHA.slice(0, 12); }, 'values.BASE_SHA'],
    [a => { a.values.DATE = '2099-02-30'; }, 'values.DATE'],
    [a => { a.values.CHANGE_SLUG = 'Not Kebab'; }, 'values.CHANGE_SLUG'],
    [a => { a.values.ID_PREFIX = 'T-S'; }, 'values.ID_PREFIX'],
    [a => { a.batches[0].values.BATCH_SLUG = 'a/b'; }, 'batches[0].values.BATCH_SLUG'],
    [a => { a.batches = []; }, 'batches must be a non-empty array'],
    [a => { a.batches[0].extra = {}; }, 'batches[0] must hold exactly'],
    [a => { a.foldins = {}; }, 'foldins must be an array'],
  ];
  for (const [edit, named] of cases) { const a = clone(ctx.answers); edit(a); await refuses(ctx, a, [named]); }
  // Control: three-digit numbers in order are accepted.
  const wide = clone(ctx.answers); wide.batches.forEach((b, i) => { b.values.BATCH_NUM = '00' + (i + 1); });
  wide.sections['01-plan.md ## Batch table'] = wide.sections['01-plan.md ## Batch table'].split('| B0').join('| B00');
  wide.sections['PROGRESS.md ## Batches'] = wide.sections['PROGRESS.md ## Batches'].split('| B0').join('| B00');
  wide.batches[1].values.BATCH_DEPS = 'B001'; wide.foldins = [];
  await accepts(ctx, wide);
  assert.ok(fs.existsSync(path.join(ctx.fx.repo, ...LEDGER.split('/'), '02-batches-001-one.md')));
});

test('a SHA-256 repository: its full base SHA is accepted, an abbreviation refused', async t => {
  const ctx = await setup(t, FILES, { objectFormat: 'sha256' });
  assert.match(ctx.fx.base, /^[0-9a-f]{64}$/);
  const short = clone(ctx.answers); short.values.BASE_SHA = ctx.fx.base.slice(0, 40);
  await refuses(ctx, short, ['values.BASE_SHA']);
  await accepts(ctx, ctx.answers);
});

test('validate and setup: each present exactly when its command is, and checked by checkedSpec', async t => {
  const ctx = await setup(t);
  const cases = [
    [a => { a.validate = { steps: [] }; }, 'validate: spec: "steps" must be a non-empty array'],
    [a => { a.validate = { steps: [{ name: 'x', argv: ['node'], parser: 'mocha' }] }; }, 'validate: spec: step 1 needs a parser'],
    [a => { a.validate = null; }, 'validate is required'],
    [a => { a.values.VALIDATION_COMMANDS = 'none'; }, 'validate must be null'],
    [a => { a.setup = VALIDATE; }, 'setup must be null: the worktree setup is n/a'],
    [a => { a.values.WORKTREE_SETUP = '`npm ci`'; }, 'setup is required'],
    [a => { a.values.WORKTREE_SETUP = 'npm ci'; a.setup = { steps: [{ name: 'bad name', argv: ['npm', 'ci'], parser: 'none' }] }; }, 'setup: spec: step 1 needs a name'],
  ];
  for (const [edit, named] of cases) { const a = clone(ctx.answers); edit(a); await refuses(ctx, a, [named]); }
  const none = clone(ctx.answers); none.values.VALIDATION_COMMANDS = 'none — no test suite'; none.validate = null;
  const r = await accepts(ctx, none);
  assert.ok(!r.files.includes('validate.json') && !fs.existsSync(path.join(ctx.fx.repo, ...LEDGER.split('/'), 'validate.json')));
  // The command word is read without backticks and case.
  for (const word of ['`none`', 'None']) {
    reset(ctx);
    const v = clone(none); v.values.VALIDATION_COMMANDS = word; await accepts(ctx, v);
  }
  const ctx2 = await setup(t);
  const SETUP = { steps: [{ name: 'install', argv: ['npm', 'ci'], parser: 'none' }] };
  const withSetup = clone(ctx2.answers); withSetup.values.WORKTREE_SETUP = '`npm ci`'; withSetup.setup = SETUP;
  await accepts(ctx2, withSetup);
  assert.equal(readRepo(ctx2.fx, LEDGER + '/setup.json'), JSON.stringify(SETUP, null, 2) + '\n');
});

test('the staged ledger is held to parse, selfcheck and plan: any problem refuses the whole run', async t => {
  const ctx = await setup(t);
  const cases = [
    [a => { a.batches[0].values.BATCH_BRANCH = 'feat/other'; }, 'staged parse 02-batches-01-one.md'],
    [a => { a.sections['01-plan.md ## Batch table'] = planRow(BATCHES[0]); }, 'staged parse'],
    [a => { a.sections['01-plan.md ## Coverage audit (planning-time)'] = 'Covered.'; }, 'staged selfcheck preflight'],
    [a => { a.sections['LOG.md ## Learnings'] = '<!-- left over -->'; }, 'staged selfcheck slot LOG.md'],
    [a => { a.values.REPO_CONVENTIONS = 'see {{LEFT}}'; }, 'staged selfcheck slot 00-READBEFORE.md'],
    [a => { a.batches[0].sections['## Acceptance criteria'] = '| B01 | <title> |'; }, 'staged selfcheck slot 02-batches-01-one.md'],
    [a => { a.batches[1].values.BATCH_WAVE = '1'; }, 'staged plan wave'],
    [a => { a.batches[0].values.BATCH_DEPS = 'B02'; }, 'staged plan depends'],
    [a => { a.batches[1].values.BATCH_FILES = '`src/missing.txt`'; a.sections['01-plan.md ## Batch table'] = [planRow(BATCHES[0]), planRow({ ...BATCHES[1], files: ['src/missing.txt'] })].join('\n'); }, 'staged plan fence-path'],
    [a => { a.batches[0].values.BATCH_NEW_FILES = '`src/a.txt`'; }, 'staged plan new-files 02-batches-01-one.md'],
  ];
  for (const [edit, named] of cases) { const a = clone(ctx.answers); edit(a); await refuses(ctx, a, [named]); }
  // A parse problem that selfcheck and plan repeat is reported once.
  const branch = clone(ctx.answers); branch.batches[0].values.BATCH_BRANCH = 'feat/other';
  const once = await refuses(ctx, branch, ['staged parse']);
  assert.equal(once.problems.filter(p => p.includes('02-batches-01-one.md') && p.includes('Branch line must read exactly')).length, 1, JSON.stringify(once.problems));
  // Control: a slot token inside a code span is a quotation, not a slot.
  const quoted = clone(ctx.answers); quoted.values.REPO_CONVENTIONS = 'quote `{{LEFT}}` and `<!--` freely';
  await accepts(ctx, quoted);
  // Control: a path the batch template's New files line marks new may be fenced before it exists.
  reset(ctx);
  const marked = clone(ctx.answers);
  marked.batches[1].values.BATCH_FILES = '`src/b.txt`, `src/new.txt`'; marked.batches[1].values.BATCH_NEW_FILES = '`src/new.txt`';
  marked.sections['01-plan.md ## Batch table'] = [planRow(BATCHES[0]), planRow({ ...BATCHES[1], files: ['src/b.txt', 'src/new.txt'] })].join('\n');
  await accepts(ctx, marked);
  assert.ok(readRepo(ctx.fx, LEDGER + '/02-batches-02-two.md').includes('\n**Files**: `src/b.txt`, `src/new.txt`\n**New files**: `src/new.txt`\n'));
});

test('an existing target directory is refused, and nothing is written', async t => {
  const ctx = await setup(t);
  fs.mkdirSync(path.join(ctx.fx.repo, ...LEDGER.split('/')), { recursive: true });
  await refuses(ctx, ctx.answers, ['.agents/changes/' + CHANGE_ID + ' already exists']);
  // Found before staging: reported beside a fold-in problem, not only after the checks pass.
  const both = clone(ctx.answers); both.foldins = [{ file: 'BACKLOG.md', id: 'TB-999', batch: 'B01' }];
  await refuses(ctx, both, ['.agents/changes/' + CHANGE_ID + ' already exists', 'foldins[0]: TB-999 occurs on 0 lines']);
});

test('values and sections holding replacement patterns are written verbatim', async t => {
  const ctx = await setup(t);
  const PATTERNS = "keep $& and $` and $' and $$ and $1 and $<n> literal";
  const a = clone(ctx.answers); a.values.EXTRA_PROHIBITIONS = PATTERNS; a.sections['LOG.md ## Learnings'] = '- ' + PATTERNS;
  a.batches[0].values.BATCH_GUARDRAILS = PATTERNS;
  await accepts(ctx, a);
  assert.ok(readRepo(ctx.fx, LEDGER + '/00-READBEFORE.md').includes('- ' + PATTERNS + '\n'));
  assert.ok(readRepo(ctx.fx, LEDGER + '/LOG.md').includes('## Learnings\n\n- ' + PATTERNS + '\n'));
  assert.ok(readRepo(ctx.fx, LEDGER + '/02-batches-01-one.md').includes('**Applicable guardrails**: ' + PATTERNS + '\n'));
});

// ===== Fold-ins ==================================================================================
test('fold-in markers: inside a table row\'s last cell, at a list line\'s end, and an anchored item takes the next id', async t => {
  // An anchored item's id goes after its line's list marker, task box and indentation, or a heading's `#`s.
  const LINES = [
    ['+   a plus item', '+   TB-001 a plus item'],
    ['10. a numbered item', '10. TB-002 a numbered item'],
    ['2) a parenthesised item', '2) TB-003 a parenthesised item'],
    ['  * [X] a nested done item', '  * [X] TB-004 a nested done item'],
    ['### a heading item', '### TB-005 a heading item'],
    ['a plain line', 'TB-006 a plain line'],
  ];
  const extra = { 'docs/TODO.md': '# Todo\n\n* write docs\n', 'docs/WIDE.md': 'TB-0042 wide\n\n- [x] a wide item\n', 'docs/LINES.md': '# Lines\n\n' + LINES.map(([from]) => from).join('\n') + '\n' };
  const ctx = await setup(t, { ...FILES, ...extra });
  const a = clone(ctx.answers);
  a.foldins = [
    { file: 'BACKLOG.md', id: 'TB-012', batch: 'B02' },
    { file: 'BACKLOG.md', id: 'TB-020', batch: 'B01' },
    { file: 'BACKLOG.md', id: 'TB-015', batch: 'B01' },
    { file: 'BACKLOG.md', anchor: '- [ ] an unnumbered item', batch: 'B01' },
    { file: 'BACKLOG.md', anchor: '- another unnumbered item', batch: 'B02' },
    { file: 'docs/TODO.md', anchor: '* write docs', batch: 'B01' },
    { file: 'docs/WIDE.md', anchor: '- [x] a wide item', batch: 'B02' },
    ...LINES.map(([from]) => ({ file: 'docs/LINES.md', anchor: from, batch: 'B01' })),
  ];
  const r = await accepts(ctx, a);
  assert.deepEqual(r.foldins.slice().sort(), ['BACKLOG.md', 'docs/LINES.md', 'docs/TODO.md', 'docs/WIDE.md']);
  const m = b => ' Folded into ' + CHANGE_ID + ' ' + b + '.';
  const want = BACKLOG.split('\n').map(l => ({
    '| TB-012 | another table item |': '| TB-012 | another table item' + m('B02') + ' |',
    '- TB-020 a listed item': '- TB-020 a listed item' + m('B01'),
    '| TB-015 | tight|': '| TB-015 | tight' + m('B01') + ' |',
    '- [ ] an unnumbered item': '- [ ] TB-021 an unnumbered item' + m('B01'),
    '- another unnumbered item': '- TB-022 another unnumbered item' + m('B02'),
  })[l] ?? l).join('\n');
  assert.equal(readRepo(ctx.fx, 'BACKLOG.md'), want);
  assert.equal(readRepo(ctx.fx, 'docs/TODO.md'), '# Todo\n\n* TB-001 write docs' + m('B01') + '\n', 'three digits when the file has no id');
  assert.equal(readRepo(ctx.fx, 'docs/WIDE.md'), 'TB-0042 wide\n\n- [x] TB-0043 a wide item' + m('B02') + '\n', 'the widest existing width');
  assert.equal(readRepo(ctx.fx, 'docs/LINES.md'), '# Lines\n\n' + LINES.map(([, to]) => to + m('B01')).join('\n') + '\n');
});

test('a fold-in that cannot be marked refuses the whole run, ledger included', async t => {
  // Backlogs that are not UTF-8: a Latin-1 é (E9), and a CP1252 em dash (97) alone and behind a UTF-8 BOM.
  const ANSI = Buffer.concat([Buffer.from('- TB-001 a '), Buffer.from([0x97]), Buffer.from(' b\n')]);
  const ctx = await setup(t, {
    ...FILES, 'X.md/keep': 'a directory named like a backlog\n', 'docs/ALNUM.md': 'TB7 first\n\n- second\n', 'docs/PLAIN.md': '# Plain\n\n* write docs\n',
    'docs/SCAN.md': '- SCAN-6 first\n- second\n', 'docs/DOTTED.md': '- #3.5 first\n- #4.9 other\n- second\n',
    'docs/MARKED.md': '- XX-009 done Folded into XX-20000101-old B01. Split into XX-011.\n- next\n',
    'docs/LATIN.txt': Buffer.concat([Buffer.from('- TB-001 caf'), Buffer.from([0xe9]), Buffer.from(' one\n- other caf'), Buffer.from([0xe9]), Buffer.from('\n')]),
    'docs/ANSI.md': ANSI, 'docs/BOM-ANSI.md': Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), ANSI]),
  });
  // A link to a file outside the repository, where the platform grants one.
  const outside = path.join(ctx.fx.dir, 'OUTSIDE.md');
  fs.writeFileSync(outside, '| TB-012 | outside |\n');
  let linked = true;
  try { fs.symlinkSync(outside, path.join(ctx.fx.repo, 'OUT.md'), 'file'); } catch (e) { assert.equal(process.platform, 'win32', 'a file link failed off Windows: ' + e.code); linked = false; }
  if (linked) { const a = clone(ctx.answers); a.foldins = [{ file: 'OUT.md', id: 'TB-012', batch: 'B01' }]; await refuses(ctx, a, ['foldins[0]: OUT.md is not an ordinary file inside the repository']); fs.rmSync(path.join(ctx.fx.repo, 'OUT.md')); }
  assert.equal(fs.readFileSync(outside, 'utf8'), '| TB-012 | outside |\n');
  const cases = [
    [{ file: 'BACKLOG.md', id: 'TB-999', batch: 'B01' }, 'TB-999 occurs on 0 lines'],
    [{ file: 'BACKLOG.md', id: 'TB-007', batch: 'B01' }, 'TB-007 occurs on 2 lines'],
    [{ file: 'BACKLOG.md', id: 'TB-00', batch: 'B01' }, 'TB-00 occurs on 0 lines'],
    [{ file: 'BACKLOG.md', id: 'B-012', batch: 'B01' }, 'B-012 occurs on 0 lines'],
    [{ file: 'BACKLOG.md', id: 'TB-012 |', batch: 'B01' }, 'id "TB-012 |" must be one token'],
    [{ file: 'BACKLOG.md', anchor: '- x Folded into XX-20000101-old B01.', batch: 'B01' }, 'the anchored item in BACKLOG.md is already folded'],
    [{ file: 'BACKLOG.md', anchor: '- TB-020 a listed item', batch: 'B01' }, 'the anchored item in BACKLOG.md already has the id TB-020'],
    [{ file: 'X.md', id: 'TB-012', batch: 'B01' }, 'X.md is not an ordinary file inside the repository'],
    [{ file: 'BACKLOG.md', id: 'TB-003', batch: 'B01' }, 'TB-003 in BACKLOG.md is already folded'],
    [{ file: 'BACKLOG.md', id: 'TB-012', batch: 'B09' }, 'batch "B09" is not a planned batch'],
    [{ file: 'BACKLOG.md', anchor: '| an unnumbered row |', batch: 'B01' }, 'the anchor is a table row'],
    [{ file: 'BACKLOG.md', anchor: 'an unnumbered item', batch: 'B01' }, 'the anchor is 0 whole lines'],
    [{ file: 'BACKLOG.md', anchor: '', batch: 'B01' }, 'every field must be a non-empty string'],
    [{ file: 'MISSING.md', id: 'TB-012', batch: 'B01' }, 'no file MISSING.md'],
    [{ file: 'docs/LATIN.txt', id: 'TB-001', batch: 'B01' }, 'docs/LATIN.txt is not UTF-8'],
    [{ file: 'docs/ANSI.md', id: 'TB-001', batch: 'B01' }, 'docs/ANSI.md is not UTF-8'],
    [{ file: 'docs/BOM-ANSI.md', id: 'TB-001', batch: 'B01' }, 'docs/BOM-ANSI.md is not UTF-8'],
    [{ file: '../BACKLOG.md', id: 'TB-012', batch: 'B01' }, 'file "../BACKLOG.md" is not a repository-relative path'],
    [{ file: 'BACKLOG.md', id: 'TB-012', anchor: 'x', batch: 'B01' }, 'must hold "file", "batch" and exactly one of "id" or "anchor"'],
  ];
  for (const [f, named] of cases) { const a = clone(ctx.answers); a.foldins = [f]; await refuses(ctx, a, ['foldins[0]: ' + named]); }
  // The same id twice: the second finds the first's marker.
  const twice = clone(ctx.answers); twice.foldins = [{ file: 'BACKLOG.md', id: 'TB-012', batch: 'B01' }, { file: 'BACKLOG.md', id: 'TB-012', batch: 'B02' }];
  await refuses(ctx, twice, ['foldins[1]: TB-012 in BACKLOG.md is already folded']);
  // Only the safe shape is a prefix on the contract's word alone; any other is one only where the
  // file already holds an id in it, and a fold-in marker's change and batch (BACKLOG.md's B01) are not ids.
  for (const value of ['ids like TB-017', '`TB-NNN`', 'TB-N', '`TB1`', '`TB`', '`BL-###`', 'BL-...', '`BL-XXX-`', '`BL#`', '`##`', '`#3.5`', '`B`']) {
    const prefix = clone(ctx.answers); prefix.values.BACKLOG_ID_PREFIX = value; prefix.foldins = [{ file: 'BACKLOG.md', anchor: '- another unnumbered item', batch: 'B01' }];
    await refuses(ctx, prefix, ['foldins[0]: values.BACKLOG_ID_PREFIX ' + JSON.stringify(value) + ' is not a plain id prefix']);
  }
  // Controls, each changing only its anchored line: the safe shape on a file holding none of its
  // ids; an example id names its scheme (XTB-099 is not one of its ids), at the width the file's ids
  // set; other shapes where the file holds ids in them; the ids beside a marker count, its change id not.
  const m = b => ' Folded into ' + CHANGE_ID + ' ' + b + '.';
  const controls = [
    ['`TB-017`', 'BACKLOG.md', '- another unnumbered item', '- TB-021 another unnumbered item'],
    ['`#`', 'docs/PLAIN.md', '* write docs', '* #001 write docs'],
    ['`v2-`', 'docs/PLAIN.md', '* write docs', '* v2-001 write docs'],
    ['`TB_`', 'docs/PLAIN.md', '* write docs', '* TB_001 write docs'],
    ['TB.', 'docs/PLAIN.md', '* write docs', '* TB.001 write docs'],
    ['`X-`', 'docs/PLAIN.md', '* write docs', '* X-001 write docs'],
    ['`SCAN-`', 'docs/PLAIN.md', '* write docs', '* SCAN-001 write docs'],
    ['`SCAN-6`', 'docs/SCAN.md', '- second', '- SCAN-7 second'],
    ['`TB`', 'docs/ALNUM.md', '- second', '- TB8 second'],
    ['`#3.5`', 'docs/DOTTED.md', '- second', '- #3.6 second'],
    ['`XX-`', 'docs/MARKED.md', '- next', '- XX-012 next'],
  ];
  for (const [value, file, anchor, line] of controls) {
    const before = readRepo(ctx.fx, file), a = clone(ctx.answers);
    a.values.BACKLOG_ID_PREFIX = value; a.foldins = [{ file, anchor, batch: 'B02' }];
    await accepts(ctx, a);
    assert.equal(readRepo(ctx.fx, file), before.split('\n').map(l => l === anchor ? line + m('B02') : l).join('\n'), value);
    reset(ctx);
  }
  // Control: an id on a line that merely names another id is still exactly one line.
  const ok = clone(ctx.answers); ok.foldins = [{ file: 'BACKLOG.md', id: 'TB-020', batch: 'B01' }];
  await accepts(ctx, ok);
});

// ===== EOL =======================================================================================
const crlf = text => text.split('\n').join('\r\n');
const ledgerBytes = fx => { const dir = path.join(fx.repo, ...LEDGER.split('/')); return fs.readdirSync(dir).map(n => fs.readFileSync(path.join(dir, n), 'latin1')); };
test('the ledger takes the majority EOL of the tracked Markdown; the backlog keeps its own', async t => {
  // CRLF Markdown in the majority, the backlog LF.
  // Values and sections authored with CRLF and lone CR line breaks, as an answers file written on Windows carries them.
  // A section ending in a CRLF blank line leaves no doubled blank line where its comment was.
  const breaks = a => { a.values.EXTRA_PROHIBITIONS = 'a\r\nb c\rd'; a.sections['LOG.md ## Learnings'] = '- one\r\n- two\r- three\r\n\r\n'; return a; };
  const crlfRepo = await setup(t, { 'README.md': crlf('# Readme\n'), 'docs/one.md': crlf('# One\n'), 'docs/two.md': crlf('# Two\n'), 'src/a.txt': 'a\n', 'src/b.txt': 'b\n', 'BACKLOG.md': BACKLOG });
  await accepts(crlfRepo, breaks(crlfRepo.answers));
  for (const bytes of ledgerBytes(crlfRepo.fx)) {
    assert.ok(bytes.includes('\r\n')); assert.ok(!bytes.split('\r\n').join('').includes('\n'), 'no bare LF in a CRLF repository');
    assert.ok(!bytes.split('\r\n').join('').includes('\r'), 'no CR outside a CRLF pair');
    assert.ok(!bytes.includes('\r\n\r\n\r\n'), 'no doubled blank line');
  }
  assert.ok(readRepo(crlfRepo.fx, LEDGER + '/LOG.md').includes('## Learnings\r\n\r\n- one\r\n- two\r\n- three\r\n'));
  assert.ok(!readRepo(crlfRepo.fx, 'BACKLOG.md').includes('\r'), 'an LF backlog stays LF');
  // LF Markdown in the majority, the backlog CRLF: only the marked line changes, its CR kept.
  const lfRepo = await setup(t, { ...FILES, 'docs/one.md': '# One\n', 'BACKLOG.md': crlf(BACKLOG) });
  await accepts(lfRepo, breaks(lfRepo.answers));
  for (const bytes of ledgerBytes(lfRepo.fx)) { assert.ok(!bytes.includes('\r'), 'no CR in an LF repository'); assert.ok(!bytes.includes('\n\n\n'), 'no doubled blank line'); }
  assert.equal(readRepo(lfRepo.fx, 'BACKLOG.md'), crlf(BACKLOG).replace('| TB-012 | another table item |', () => '| TB-012 | another table item Folded into ' + CHANGE_ID + ' B02. |'));
  // Markdown committed LF and checked out CRLF (autocrlf): the working tree, not the index, decides.
  const checkout = await setup(t, { ...FILES, 'docs/one.md': '# One\n' });
  for (const f of ['README.md', 'BACKLOG.md', 'docs/one.md']) fs.rmSync(path.join(checkout.fx.repo, ...f.split('/')));
  checkout.fx.git('-c', 'core.autocrlf=true', 'checkout', '--', '.');
  const eol = checkout.fx.git('ls-files', '--eol', '--', 'README.md');
  assert.match(eol, /^i\/lf\s+w\/crlf\s/, 'the fixture is LF in the index and CRLF in the working tree: ' + eol);
  await accepts(checkout, checkout.answers);
  for (const bytes of ledgerBytes(checkout.fx)) assert.ok(bytes.includes('\r\n') && !bytes.split('\r\n').join('').includes('\n'), 'CRLF ledger files');
  // A tie is LF.
  const tie = await setup(t, { ...FILES, 'README.md': crlf('# Readme\n') });
  await accepts(tie, tie.answers);
  for (const bytes of ledgerBytes(tie.fx)) assert.ok(!bytes.includes('\r'), 'a tie is LF');
});

test('a backlog that begins with a UTF-8 BOM keeps it through every fold-in form, LF and CRLF, and only its marked lines change', async t => {
  const BOM = Buffer.from([0xef, 0xbb, 0xbf]), m = b => ' Folded into ' + CHANGE_ID + ' ' + b + '.';
  // FIRST.md's marked line is its first, right after the BOM; PLAIN.md, the same without one, gains none;
  // TWICE.md begins with two BOMs, the second of them text, and keeps both; NEAR.md begins with U+FEFC,
  // a BOM's first two bytes and a different third, and gains none.
  const FIRST = '- first item\n- TB-001 second\n', FIRST_MARKED = '- TB-002 first item' + m('B01') + '\n- TB-001 second\n';
  const TWICE = String.fromCharCode(0xfeff) + FIRST, TWICE_MARKED = String.fromCharCode(0xfeff) + '- first item\n- TB-001 second' + m('B02') + '\n';
  const NEAR = String.fromCharCode(0xfefc) + FIRST, NEAR_MARKED = String.fromCharCode(0xfefc) + '- first item\n- TB-001 second' + m('B02') + '\n';
  for (const eol of [text => text, crlf]) {
    // Every Markdown file in one EOL, so the repository is LF or CRLF, as its ledger shows.
    const ctx = await setup(t, { 'README.md': eol('# Readme\n'), 'src/a.txt': 'a\n', 'src/b.txt': 'b\n',
      'BACKLOG.md': Buffer.concat([BOM, Buffer.from(eol(BACKLOG))]), 'docs/FIRST.md': Buffer.concat([BOM, Buffer.from(eol(FIRST))]), 'docs/PLAIN.md': eol(FIRST),
      'docs/TWICE.md': Buffer.concat([BOM, Buffer.from(eol(TWICE))]), 'docs/NEAR.md': eol(NEAR) });
    const a = clone(ctx.answers);
    a.foldins = [
      { file: 'BACKLOG.md', id: 'TB-012', batch: 'B02' },
      { file: 'BACKLOG.md', id: 'TB-020', batch: 'B01' },
      { file: 'BACKLOG.md', anchor: '- another unnumbered item', batch: 'B02' },
      { file: 'docs/FIRST.md', anchor: '- first item', batch: 'B01' },
      { file: 'docs/PLAIN.md', anchor: '- first item', batch: 'B01' },
      { file: 'docs/TWICE.md', id: 'TB-001', batch: 'B02' },
      { file: 'docs/NEAR.md', id: 'TB-001', batch: 'B02' },
    ];
    await accepts(ctx, a);
    for (const bytes of ledgerBytes(ctx.fx)) assert.equal(bytes.includes('\r'), eol === crlf, 'the ledger takes the repository EOL');
    assert.deepEqual([...fs.readFileSync(path.join(ctx.fx.repo, 'docs', 'NEAR.md')).subarray(0, 3)], [0xef, 0xbb, 0xbc], 'docs/NEAR.md keeps its first bytes');
    const want = [
      ['BACKLOG.md', true, BACKLOG.split('\n').map(l => ({
        '| TB-012 | another table item |': '| TB-012 | another table item' + m('B02') + ' |',
        '- TB-020 a listed item': '- TB-020 a listed item' + m('B01'),
        '- another unnumbered item': '- TB-021 another unnumbered item' + m('B02'),
      })[l] ?? l).join('\n')],
      ['docs/FIRST.md', true, FIRST_MARKED],
      ['docs/PLAIN.md', false, FIRST_MARKED],
      ['docs/TWICE.md', true, TWICE_MARKED],
      ['docs/NEAR.md', false, NEAR_MARKED],
    ];
    for (const [file, bom, text] of want) {
      const bytes = fs.readFileSync(path.join(ctx.fx.repo, ...file.split('/')));
      assert.ok(bytes.subarray(0, 3).equals(BOM) === bom, file + (bom ? ' keeps its UTF-8 BOM' : ' gains no BOM'));
      assert.equal(bytes.subarray(bom ? 3 : 0).toString('utf8'), eol(text), file + ': only the marked lines change');
    }
  }
});

// ===== CLI =======================================================================================
const cli = args => {
  const r = spawnSync(process.execPath, [TOOL, ...args], { encoding: 'utf8', windowsHide: true, timeout: 120000 });
  assert.ifError(r.error); assert.equal(r.stderr, '');
  assert.match(r.stdout, /^[^\r\n]*\n$/, 'exactly one line: ' + JSON.stringify(r.stdout));
  return { status: r.status, line: r.stdout.slice(0, -1) };
};
test('the CLI prints one line: --help, an OK run, a refusal', async t => {
  const help = cli(['--help']);
  assert.equal(help.status, 0); assert.ok(help.line.startsWith('scaffold.mjs --answers <answers.json> --repo <worktree-root> — '));
  const ctx = await setup(t);
  const file = path.join(ctx.fx.dir, 'answers.json');
  const missing = clone(ctx.answers); delete missing.values.MERGE_POLICY;
  fs.writeFileSync(file, JSON.stringify(missing));
  const before = snapshot(ctx.fx.repo);
  assert.deepEqual(cli(['--answers', file, '--repo', ctx.fx.repo]), { status: 1, line: 'SCAFFOLD FAIL 1 problem(s): values: missing MERGE_POLICY' });
  assert.deepEqual(snapshot(ctx.fx.repo), before);
  fs.writeFileSync(file, JSON.stringify(ctx.answers));
  assert.deepEqual(cli(['--answers', file, '--repo', ctx.fx.repo]), { status: 0, line: `SCAFFOLD OK ${CHANGE_ID} 2 batches, ${fs.readdirSync(TEMPLATES).length + 2} files` });
});

test('scaffoldCli: UNKNOWN for bad flags, unreadable or non-JSON answers and a --repo that is not a work tree root; at most ten problems shown', async t => {
  const { scaffoldCli } = await api();
  const ctx = await setup(t);
  const file = path.join(ctx.fx.dir, 'answers.json'), bad = path.join(ctx.fx.dir, 'bad.json');
  fs.writeFileSync(file, JSON.stringify(ctx.answers)); fs.writeFileSync(bad, '{ not json');
  const unknown = async (args, reason) => { const r = await scaffoldCli(args); assert.equal(r.code, 2, r.line); assert.ok(r.line.startsWith('UNKNOWN ' + reason), r.line); };
  await unknown(['--answers', file], 'usage:');
  await unknown(['--answers', file, '--repo', ctx.fx.repo, '--extra', 'x'], 'usage:');
  await unknown(['--answers', bad, '--repo', ctx.fx.repo], '--answers ' + bad + ' is not valid JSON');
  await unknown(['--answers', path.join(ctx.fx.dir, 'none.json'), '--repo', ctx.fx.repo], 'cannot read --answers');
  await unknown(['--answers', file, '--repo', ctx.fx.stage], '--repo ' + ctx.fx.stage + ' is not a git work tree');
  await unknown(['--answers', file, '--repo', path.join(ctx.fx.repo, 'src')], '--repo ' + path.join(ctx.fx.repo, 'src') + ' is not the root');
  // A control character in a path reaches the line as '?', never as a second line.
  const NL = String.fromCharCode(10);
  const odd = await scaffoldCli(['--answers', file, '--repo', 'no' + NL + 'such']);
  assert.equal(odd.code, 2); assert.ok(!odd.line.includes(NL)); assert.ok(odd.line.startsWith('UNKNOWN --repo no?such is not a git work tree'), odd.line);
  const many = clone(ctx.answers); many.values = {};
  fs.writeFileSync(file, JSON.stringify(many));
  const r = await scaffoldCli(['--answers', file, '--repo', ctx.fx.repo]);
  assert.equal(r.code, 1);
  const n = ctx.domain.values.required.length;
  assert.match(r.line, new RegExp('^SCAFFOLD FAIL ' + n + ' problem\\(s\\): (?:[^;]+; ){9}[^;]+ \\(\\+' + (n - 10) + ' more\\)$'));
});

test('a template whose comments have no key is UNKNOWN, never a guessed domain', async t => {
  const { answersDomain, scaffold } = await api();
  // A tight case follows the comfortable one it sharpens, an input a looser check would accept: no row is redundant.
  const cases = [
    ['LOG.md', '## Learnings\n', '## Learnings\n\nText <!-- inline --> here.\n', 'must open a line'],
    ['LOG.md', '## Learnings\n', '## Learnings\n\n    <!-- indented -->\n', 'must open a line'],
    ['LOG.md', '## Learnings\n', '## Learnings\n\nText <!-- opened mid-line\n', 'must open a line'],
    ['LOG.md', '## Learnings\n', '## Learnings\n\nText --> here.\n', 'must open a line'],
    ['LOG.md', '## Learnings\n', '## Learnings\n\n<!-- one -->\n\n<!-- two -->\n', 'a second instruction comment under ## Learnings'],
    ['LOG.md', '## Learnings\n', '## Learnings\n\n<!-- closed --> early\n', 'must close at the end of a line'],
    ['LOG.md', '## Learnings\n', '## Learnings\n\n<!-- closed --> early -->\n', 'must close at the end of a line'],
    ['LOG.md', '## Learnings\n', '## Learnings\n\n<!-- never closed\n', 'opened inside another'],
    ['LOG.md', '## Learnings\n', '## Learnings\n\n<!-- one\nstill one <!-- two -->\n', 'opened inside another'],
    ['LOG.md', 'Later sessions append below. -->\n', 'Later sessions append below. -->\n\n<!-- unclosed\n', 'must close at the end of a line'],
    ['00-request.md', '# Request ({{DATE}}, verbatim)\n', '<!-- above -->\n# Request ({{DATE}}, verbatim)\n', 'under no heading'],
  ];
  for (const [file, from, to, reason] of cases) {
    for (const eol of Object.keys(EOLS)) {
      const dir = skillCopy(t, d => editFile(path.join(d, file), from, to), eol);
      assert.throws(() => answersDomain(dir), e => e.message.includes(reason), eol + ': ' + reason);
    }
  }
  const ctx = await setup(t);
  const empty = skillCopy(t, d => fs.rmSync(path.join(d, '02-batch.md')));
  await assert.rejects(scaffold(ctx.answers, { repo: ctx.fx.repo, skillDir: empty }), e => e.message.startsWith('no 02-batch.md in '));
});
