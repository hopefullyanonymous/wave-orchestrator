'use strict';
// orchestrate-mod's cost log off the engine: the pure helpers of orchestrate-mod/hooks/cost.js and the price table
// of orchestrate-mod/hooks/prices.js in-process, and orchestrate-mod/tools/cost-report.mjs in-process and, a few
// times, as published. The parsers are bound to what they read: the roles and the prompt file names come from
// orchestrate/tools/prompt.mjs, the pointer from the skill's documents, the ledger-id rule from
// orchestrate/tools/git-evidence.mjs `validId`, and discovery's lines from orchestrate/tools/reconcile.mjs.
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');
const { makeRepo } = require('./support/git-fixture.cjs');

const ROOT = fs.realpathSync(path.resolve(__dirname, '..'));
const load = file => import(pathToFileURL(path.join(ROOT, file)).href);
const cost = load('orchestrate-mod/hooks/cost.js');
const prices = load('orchestrate-mod/hooks/prices.js');
const report = load('orchestrate-mod/tools/cost-report.mjs');
const prompt = load('orchestrate/tools/prompt.mjs');
const reconcile = load('orchestrate/tools/reconcile.mjs');
const evidence = load('orchestrate/tools/git-evidence.mjs');
const readDoc = file => fs.readFileSync(path.join(ROOT, file), 'utf8').replace(/\r\n/g, '\n');
const REPORT = path.join(ROOT, 'orchestrate-mod', 'tools', 'cost-report.mjs');
const plain = text => text.replace(/\u001b\[[0-?]*[ -\/]*[@-~]/g, '');
const ENV = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== 'NODE_TEST_CONTEXT'));
const POINTER = 'Your complete instructions are in the file ';
const TAIL = ". Open it with the Read tool before doing anything else and follow it to its last line, which gives your report's exact line 2.";

function tempDir(t) {
  const temp = fs.realpathSync(os.tmpdir()), dir = fs.mkdtempSync(path.join(temp, 'mod-cost-'));
  t.after(() => { assert.equal(path.dirname(dir), temp); fs.rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }); });
  return dir;
}
const near = (actual, expected, label) => assert.ok(Math.abs(actual - expected) < 1e-9, `${label}: ${actual} is not ${expected}`);

// ===== Attribution ======================================================================

test('the rendered roles are exactly prompt.mjs ROLES, each parsed from a file name, reviewer-round2 never as reviewer', async () => {
  const { ROLES } = await prompt, { RENDERED_ROLES, parsePromptFile, promptFileOf } = await cost;
  const keys = Object.keys(ROLES);
  assert.ok(keys.includes('reviewer-round2') && keys.includes('reviewer') && keys.length >= 7, 'roles read: ' + keys.join(', '));
  assert.deepEqual([...RENDERED_ROLES].sort(), [...keys].sort());
  assert.ok(RENDERED_ROLES.indexOf('reviewer-round2') < RENDERED_ROLES.indexOf('reviewer'));
  for (const role of keys) {
    const name = `OS-20261008-ledger-mod-B07-${role}-0123456789ab.md`;
    assert.deepEqual(parsePromptFile(name), { ledger: 'OS-20261008-ledger-mod', batch: 'B07', role }, name);
    assert.equal(promptFileOf(POINTER + '/home/u/scratch/prompts/' + name + TAIL), name);
  }
});

// The pointer message a skill document publishes: its one backticked sentence holding `<prompt file>`.
function publishedPointer(file) {
  const found = [...readDoc(file).replace(/\s+/g, ' ').matchAll(/`([^`]*<prompt file>[^`]*)`/g)].map(m => m[1]).filter(text => text !== '<prompt file>');
  assert.equal(found.length, 1, file + ' publishes one pointer message: ' + JSON.stringify(found));
  return found[0];
}
// A ledger filled from the skill's own templates, as orchestrate/tools/prompt.mjs reads one, holding batch B<nn>.
function templateLedger(dir, changeId, nn) {
  const values = { CHANGE_ID: changeId, LEDGER_DIR: '.agents/changes/' + changeId, SKILL_DIR: '/skill/orchestrate', SKILL_SHA256: 'ab'.repeat(32),
    INTEGRATION_BRANCH: 'chore/x-ledger', WORKTREE_SETUP: 'none', MAIN_BRANCH: 'main', BATCH_NUM: nn, BATCH_TITLE: 'Render', BATCH_TYPE: 'feature',
    BATCH_VERSION: '—', BATCH_BRANCH: 'feat/render', BATCH_FILES: '`src/a.js`', BATCH_NEW_FILES: '`src/a.js`', BATCH_GUARDRAILS: 'none' };
  const fill = name => readDoc('orchestrate/templates/' + name)
    .replace(/\{\{([A-Z0-9_]+)\}\}/g, (token, key) => (key in values ? values[key] : 'example-' + key.toLowerCase())).replace(/<!--[\s\S]*?-->/g, '');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '00-READBEFORE.md'), fill('00-READBEFORE.md'));
  const plan = fill('01-plan.md').split('\n'), head = plan.findIndex(line => line.startsWith('| # | Batch |'));
  assert.notEqual(head, -1, 'the plan template has its batch table');
  plan.splice(head + 2, 0, `| B${nn} | Render | feature | M | \`feat/render\` | 1 | \`src/a.js\` | C1 | — |`);
  fs.writeFileSync(path.join(dir, '01-plan.md'), plan.join('\n'));
  fs.writeFileSync(path.join(dir, `02-batches-${nn}-render.md`), fill('02-batch.md'));
}
// A value for each kind of fact prompt.mjs --help names; every other fact is a one-line string.
const FACT_VALUES = { guardrails: 'none', gateAgentsRun: false, round: 1, round1Sha: 'abc1234' };

test('every role prompt.mjs renders, pointed at with the message the skill publishes, is attributed to its ledger, batch and role', async t => {
  const { promptCli, ROLES } = await prompt, { parsePromptFile, promptFileOf } = await cost;
  const temp = tempDir(t), ledger = path.join(temp, 'ledger'), out = path.join(temp, 'prompts dir');
  // A change id with lower case, `_` and `.`, which the skill's ledger ids allow.
  templateLedger(ledger, 'os_2026.10-x', '07');
  const help = promptCli(['--help']);
  assert.equal(help.code, 0, help.line);
  const pointers = ['orchestrate/references/protocol.md', 'orchestrate/references/subagent-prompts.md'].map(publishedPointer);
  for (const role of Object.keys(ROLES)) {
    const keys = new RegExp('^  ' + role + ': (.+)$', 'm').exec(help.line);
    assert.ok(keys, role + ' is in prompt.mjs --help');
    const facts = path.join(temp, role + '.json');
    fs.writeFileSync(facts, JSON.stringify(Object.fromEntries(keys[1].split(', ').map(key => [key, FACT_VALUES[key] ?? 'x']))));
    const r = promptCli(['--ledger', ledger, '--role', role, '--batch', 'B07', '--facts', facts, '--out', out]);
    const rendered = /^PROMPT (.+) NONCE [0-9a-f]{12}$/.exec(r.line);
    assert.ok(r.code === 0 && rendered, role + ': ' + r.line);
    for (const pointer of pointers) {
      for (const file of [rendered[1], rendered[1].split('/').join('\\')]) {
        const message = pointer.replace('<prompt file>', () => file);
        assert.deepEqual(parsePromptFile(promptFileOf(message)), { ledger: 'os_2026.10-x', batch: 'B07', role }, role + ': ' + message);
      }
    }
  }
});

test('cost.js validId agrees with git-evidence.mjs validId on every printable ASCII character, first, inside and last, and on ..', async () => {
  const ours = (await cost).validId, theirs = (await evidence).validId;
  let accepted = 0, refused = 0;
  for (let code = 0x20; code < 0x7f; code++) {
    const c = String.fromCharCode(code);
    for (const id of [c, c + 'a', 'a' + c + 'b', 'a' + c]) {
      assert.equal(ours(id), theirs(id), JSON.stringify(id));
      if (theirs(id)) accepted++; else refused++;
    }
  }
  for (const id of ['a..b', '..', 'a.b', 'a.-_b', 'é', '', null, undefined, 7]) assert.equal(ours(id), theirs(id), String(id));
  assert.ok(accepted > 0 && refused > 0, 'both verdicts occur');
});

test('a prompt file name matches whole: change id in validId\'s set, two or more batch digits, a known role, 12 lower-case hex', async () => {
  const { parsePromptFile } = await cost;
  assert.deepEqual(parsePromptFile('os_2026.10-x-B12-polish-abcdef012345.md'), { ledger: 'os_2026.10-x', batch: 'B12', role: 'polish' });
  assert.deepEqual(parsePromptFile('X-B100-fix-round-abcdef012345.md'), { ledger: 'X', batch: 'B100', role: 'fix-round' });
  assert.deepEqual(parsePromptFile('OS-1-B02-x-B03-rework-abcdef012345.md'), { ledger: 'OS-1-B02-x', batch: 'B03', role: 'rework' },
    'a change id holding -Bnn- extends until a role and the id follow');
  for (const name of ['OS-1-B1-implementer-abcdef012345.md', 'OS-1-B01-implementer-abcdef01234.md', 'OS-1-B01-implementer-abcdef0123456.md',
    'OS-1-B01-implementer-ABCDEF012345.md', 'OS-1-B01-census-abcdef012345.md', 'OS-1-B01-implementer-abcdef012345.MD',
    'OS-1-B01-implementer-abcdef012345.md.txt', 'x.OS-1-B01-implementer-abcdef012345', '-OS-1-B01-implementer-abcdef012345.md',
    'OS..1-B01-implementer-abcdef012345.md', 'OS 1-B01-implementer-abcdef012345.md', 'B01-implementer-abcdef012345.md']) {
    assert.equal(parsePromptFile(name), null, name);
  }
  assert.equal(parsePromptFile(null), null);
});

test('the pointer names the prompt file: either separator, spaces in the path, a full stop or the end after it', async () => {
  const { promptFileOf } = await cost, name = 'OS-1-B01-implementer-abcdef012345.md';
  assert.equal(promptFileOf(POINTER + 'C:\\Users\\Jo Ann\\AppData\\Local\\Temp\\p\\' + name + TAIL), name);
  assert.equal(promptFileOf('Read this.\n' + POINTER + '/tmp/a.md.d/p/' + name), name);
  assert.equal(promptFileOf(POINTER + name + ' now'), name);
  assert.equal(promptFileOf(POINTER + '/tmp/p/' + name + 'x' + TAIL), null, 'no .md before the full stop');
  assert.equal(promptFileOf('The file /tmp/p/' + name + TAIL), null, 'a prompt without the pointer names no prompt file');
  assert.equal(promptFileOf(POINTER + '\n/tmp/p/' + name), null, 'the path is on the pointer\'s line');
  assert.equal(promptFileOf(undefined), null);
});

test('a batch is the first B and two or more digits standing as a word in a description', async () => {
  const { batchOf } = await cost;
  const cases = [['implement B01', 'B01'], ['B07: census', 'B07'], ['fix-B123 then B02', 'B123'], ['AB01 B1 B01x', null],
    ['b01', null], ['', null], [undefined, null]];
  for (const [description, batch] of cases) assert.equal(batchOf(description), batch, String(description));
});

test('attribution: a rendered spawn from its file, any other from the tag, its description and its type; a listed agent once', async () => {
  const { attributeSpawn, attributeListed, mainAttribution } = await cost;
  const name = 'OS-9-B04-test-hunter-abcdef012345.md';
  const spawn = { prompt: POINTER + '/p/' + name + TAIL, description: 'hunt B09', subagentType: 'general-purpose', parentAgentId: 'a0' };
  assert.deepEqual(attributeSpawn(spawn, 'TAG'), { type: 'general-purpose', role: 'test-hunter', ledger: 'OS-9', batch: 'B04', parent: 'a0' });
  assert.deepEqual(attributeSpawn({ ...spawn, prompt: 'census of ' + name, parentAgentId: undefined }, 'TAG'),
    { type: 'general-purpose', role: 'general-purpose', ledger: 'TAG', batch: 'B09', parent: null });
  assert.deepEqual(attributeSpawn({ prompt: 'x', description: 'x', subagentType: '' }, null), { type: 'unknown', role: null, ledger: null, batch: null, parent: null });
  assert.deepEqual(attributeListed({ id: 'a1', description: 'review B03', type: 'Explore', status: 'running', parentId: 'a0' }, 'TAG'),
    { type: 'Explore', role: 'Explore', ledger: 'TAG', batch: 'B03', parent: 'a0' });
  assert.deepEqual(attributeListed({ id: 'a1', description: 'x', type: 'Plan', status: 'done' }, null), { type: 'Plan', role: 'Plan', ledger: null, batch: null, parent: null });
  assert.deepEqual(attributeListed(undefined, 'TAG'), { type: 'unknown', role: null, ledger: 'TAG', batch: null, parent: null });
  assert.deepEqual(mainAttribution('TAG'), { type: 'main', role: 'main', ledger: 'TAG', batch: null, parent: null });
});

// ===== The session's ledger tag ==========================================================

const progress = state => `# Progress\n\n${state === null ? '' : `**State**: ${state}\n`}\n## Batches\n`;
const copy = (where, state) => ({ kind: 'worktree', path: where, progressText: progress(state) });
// Discovery's stdout as orchestrate/tools/reconcile.mjs prints it for ledgers given as `[id, [copy, …]]`.
async function discovered(ledgers, completeness = 'complete') {
  const { summarize } = await reconcile;
  const { lines } = summarize({ completeness, diagnostics: completeness === 'complete' ? [] : [{ code: 'probe' }],
    evidence: { ledgers: ledgers.map(([id, locations]) => ({ id, locations })) } });
  return lines.join('\n') + '\n';
}

test('the tag is the one ledger discovery prints in mode continue, close or status, read from reconcile.mjs\'s own lines', async () => {
  const { ledgerTag } = await cost, temp = fs.realpathSync(os.tmpdir());
  // A location holding spaces, commas and an arrow of its own: the mode is what follows the LAST arrow.
  const odd = path.join(temp, 'a → b, c', '.agents', 'changes', 'L', 'PROGRESS.md');
  for (const [state, mode] of [['ACTIVE', 'continue'], ['AT-CHECKPOINT C2', 'close'], ['USER-BLOCKED', 'status'], [null, 'status']]) {
    const out = await discovered([['os_2026.10-x', [copy(odd, state)]], ['OS-DONE', [copy(odd, 'COMPLETE')]]]);
    assert.ok(out.includes(' → ' + mode + '\n') && out.includes(' → none\n') && out.includes('a → b, c'), out);
    assert.equal(ledgerTag(out), 'os_2026.10-x', out);
    assert.equal(ledgerTag(out.replace(/\n/g, '\r\n')), 'os_2026.10-x', 'CRLF output');
  }
  assert.equal(ledgerTag('OS-OLD State=archived at local refs/heads/main → none (older copies: x=COMPLETE)\nOS-1 State=ACTIVE at x → continue\n'), 'OS-1');
});

test('any doubt leaves the session untagged: none active, two, AMBIGUOUS, UNKNOWN, INCOMPLETE, NO LEDGERS, an unknown line', async () => {
  const { ledgerTag } = await cost, temp = fs.realpathSync(os.tmpdir()), at = name => path.join(temp, name, 'PROGRESS.md');
  const active = ['OS-A', [copy(at('a'), 'ACTIVE')]];
  const control = await discovered([active]);
  assert.equal(ledgerTag(control), 'OS-A', 'the control: the active ledger alone is tagged');
  const doubts = {
    'no active ledger': await discovered([['OS-B', [copy(at('b'), 'COMPLETE')]]]),
    'two active ledgers': await discovered([active, ['OS-B', [copy(at('b'), 'AT-CHECKPOINT C1')]]]),
    'a State differs ledger beside an active one: two active lines': await discovered([active, ['OS-B', [copy(at('b'), 'ACTIVE'), copy(at('c'), 'COMPLETE')]]]),
    'an UNKNOWN state beside an active one': await discovered([active, ['OS-B', [copy(at('b'), 'DONE')]]]),
    'an INCOMPLETE run': await discovered([active], 'partial'),
    'no ledgers': await discovered([]),
    'a line in no known form': control + 'something else\n',
    'a mode in no known form': control.replace('→ continue', '→ continuing'),
    'a none mode in no known form': control + 'OS-B State=COMPLETE at x → none (earlier copies: y=ACTIVE)\n',
    'an id validId refuses': control.replace('OS-A', 'OS..A'),
    'a line with no location': 'OS-A State=ACTIVE → continue\n',
    'nothing printed': '',
  };
  assert.match(doubts['a State differs ledger beside an active one: two active lines'], / → AMBIGUOUS \(State differs: /);
  assert.match(doubts['an UNKNOWN state beside an active one'], / → UNKNOWN \(/);
  assert.match(doubts['an INCOMPLETE run'], /^INCOMPLETE /);
  assert.equal(doubts['no ledgers'], 'NO LEDGERS\n');
  for (const [why, out] of Object.entries(doubts)) assert.equal(ledgerTag(out), null, why + ':\n' + out);
  assert.equal(ledgerTag(undefined), null);
});

test('a State differs line tags its ledger, as ledger-view reads it through; beside another active line, or for any other AMBIGUOUS reason, untagged', async () => {
  const { ledgerTag } = await cost, { readDiscovery } = await load('orchestrate-mod/tools/ledger-view.mjs');
  const temp = fs.realpathSync(os.tmpdir()), at = name => path.join(temp, name, 'PROGRESS.md');
  const differs = ['OS-B', [copy(at('b'), 'ACTIVE'), copy(at('c'), 'AT-CHECKPOINT C1')]];
  const alone = await discovered([differs, ['OS-DONE', [copy(at('d'), 'COMPLETE')]]]);
  assert.match(alone, /^OS-B at .+ → AMBIGUOUS \(State differs: .+=ACTIVE, .+=AT-CHECKPOINT C1\)$/m, 'the control: reconcile prints the State differs form');
  assert.equal(ledgerTag(alone), 'OS-B', alone);
  assert.equal(ledgerTag(alone.replace(/\n/g, '\r\n')), 'OS-B', 'CRLF output');
  // orchestrate-mod/tools/ledger-view.mjs reads the same line as a ledger with a warning, never an error entry.
  const entry = readDiscovery(alone).ledgers.find(l => l.id === 'OS-B');
  assert.ok(entry && !entry.error && entry.warning.startsWith('AMBIGUOUS (State differs: '), JSON.stringify(entry));
  // Beside a second active line, of either kind and in either order, or under an INCOMPLETE run: untagged.
  const active = ['OS-A', [copy(at('a'), 'ACTIVE')]], second = ['OS-C', [copy(at('e'), 'ACTIVE'), copy(at('f'), 'COMPLETE')]];
  for (const out of [await discovered([active, differs]), await discovered([differs, active]), await discovered([differs, second]), await discovered([differs], 'partial')]) {
    assert.equal(ledgerTag(out), null, out);
  }
  // Every other AMBIGUOUS reason, and each near miss of this one, alone on its line and beside an active one: untagged.
  const where = at('b'), activeLine = 'OS-A State=ACTIVE at x → continue\n';
  assert.equal(ledgerTag(activeLine), 'OS-A', 'the control: the active line alone is tagged');
  for (const mode of ['AMBIGUOUS (archived at local refs/heads/main; not proven older: ' + where + '=ACTIVE)', 'AMBIGUOUS (integration branch chore/b-ledger is missing)',
    'AMBIGUOUS (state differs: ' + where + '=ACTIVE, int=COMPLETE)', 'AMBIGUOUS (State differs ' + where + '=ACTIVE, int=COMPLETE)',
    'AMBIGUOUS(State differs: ' + where + '=ACTIVE, int=COMPLETE)', 'AMBIGUOUS', 'UNKNOWN (State differs: ' + where + '=ACTIVE, int=COMPLETE)']) {
    const line = 'OS-B at ' + where + ' → ' + mode + '\n';
    assert.equal(ledgerTag(line), null, line);
    assert.equal(ledgerTag(activeLine + line), null, activeLine + line);
    assert.equal(ledgerTag(line.replace(' → ' + mode, ' → ' + 'AMBIGUOUS (State differs: ' + where + '=ACTIVE, int=COMPLETE)')), 'OS-B', 'the control: the same line with the reason read through');
  }
});

test('discovery run as the hooks module runs it tags the active ledger beside an archived one with an older copy', async t => {
  const { ledgerTag } = await cost;
  const repo = makeRepo(t);
  repo.git('config', 'maintenance.auto', 'false');
  repo.git('config', 'gc.auto', '0');
  repo.remote();
  const contract = '# Contract\n\n## Git model\n\n- Default branch (protected local ref): `refs/heads/main`. Integration branch: `int` — the ledger branch.\n'
    + '- Shipment source: `remote origin`. Shipment ref: `refs/heads/main` — the target.\n\n## Other\n';
  const ledger = (id, state) => {
    repo.write(`.agents/changes/${id}/PROGRESS.md`, `# Progress\n\n**State**: ${state}\n\n## Batches\n`);
    repo.write(`.agents/changes/${id}/00-READBEFORE.md`, contract);
  };
  // A ledger closed and archived on the shipment target, a leftover batch branch still holding its ACTIVE copy.
  repo.git('checkout', '-q', '-b', 'chore/old-ledger');
  ledger('OS-OLD', 'ACTIVE');
  repo.commit('old ledger');
  repo.git('branch', 'feat/old-a');
  fs.mkdirSync(path.join(repo.cwd, '.agents', 'archive'));
  repo.git('mv', '.agents/changes/OS-OLD', '.agents/archive/OS-OLD');
  repo.commit('close OS-OLD');
  repo.git('push', '-q', 'origin', 'HEAD:refs/heads/main');
  repo.git('checkout', '-q', 'main');
  repo.git('branch', '-q', '-D', 'chore/old-ledger');
  // The live ledger, checked out on its ledger branch.
  repo.git('checkout', '-q', '-b', 'chore/live-ledger');
  ledger('os_live.1', 'ACTIVE');
  repo.commit('live ledger');
  // The command orchestrate-mod/hooks/register.js `refreshTag` runs, with this checkout's skill as <skill>.
  const env = Object.fromEntries(Object.entries(repo.env).filter(([key]) => key.toUpperCase() !== 'NODE_TEST_CONTEXT'));
  const r = spawnSync(process.execPath, [path.join(ROOT, 'orchestrate', 'tools', 'reconcile.mjs'), 'discovery', '--repo', repo.cwd],
    { cwd: repo.cwd, env, encoding: 'utf8', windowsHide: true, timeout: 60000 });
  assert.ifError(r.error);
  const lines = r.stdout.split('\n').filter(line => line !== '');
  assert.ok(lines.includes('OS-OLD State=archived at remote origin refs/heads/main → none (older copies: feat/old-a=ACTIVE)'), r.stdout + r.stderr);
  assert.ok(lines.some(line => line.startsWith('os_live.1 State=ACTIVE at ') && line.endsWith(' → continue')), r.stdout);
  assert.equal(lines.length, 2, r.stdout);
  assert.equal(ledgerTag(r.stdout), 'os_live.1');
});

// ===== Records ===========================================================================

const USAGE = { model: 'claude-opus-5-5', input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 };
const AGENT = { type: 'general-purpose', role: 'implementer', ledger: 'OS-1', batch: 'B01', parent: 'a0' };

test('a record is fourteen keys in a fixed order, one line, and the writer refuses what the parser would', async () => {
  const { RECORD_KEYS, buildRecord, recordLine, mainAttribution } = await cost;
  assert.deepEqual(RECORD_KEYS, ['v', 'ts', 'session', 'agent', 'parent', 'type', 'ledger', 'batch', 'role', 'model', 'in', 'out', 'cr', 'cw']);
  const record = buildRecord({ now: 1791460800123, session: 's-1', agent: 'a1', attribution: AGENT, usage: USAGE });
  assert.equal(recordLine(record), '{"v":1,"ts":"2026-10-08T12:00:00.123Z","session":"s-1","agent":"a1","parent":"a0","type":"general-purpose",'
    + '"ledger":"OS-1","batch":"B01","role":"implementer","model":"claude-opus-5-5","in":1,"out":2,"cr":3,"cw":4}\n');
  assert.equal(recordLine(buildRecord({ now: 0, session: 's', agent: null, attribution: mainAttribution(null), usage: USAGE })),
    '{"v":1,"ts":"1970-01-01T00:00:00.000Z","session":"s","agent":null,"parent":null,"type":"main","ledger":null,"batch":null,"role":"main",'
    + '"model":"claude-opus-5-5","in":1,"out":2,"cr":3,"cw":4}\n');
  assert.throws(() => buildRecord({ now: 0, session: 's', agent: 'a1', attribution: AGENT, usage: { ...USAGE, output_tokens: 1.5 } }),
    { message: 'record not built: out is not a non-negative integer' });
  assert.throws(() => buildRecord({ now: NaN, session: 's', agent: 'a1', attribution: AGENT, usage: USAGE }), RangeError);
});

test('every record rule refuses its own case, and a valid record passes all of them', async () => {
  const { recordProblem, parseRecordLine } = await cost;
  const valid = { v: 1, ts: '2026-10-08T12:00:00.000Z', session: 's', agent: 'a1', parent: null, type: 'Explore', ledger: null, batch: null,
    role: null, model: 'm', in: 0, out: 0, cr: 0, cw: 0 };
  const main = { ...valid, agent: null, type: 'main', role: 'main', ledger: 'os_1.x' };
  assert.equal(recordProblem(valid), null);
  assert.equal(recordProblem(main), null);
  const { v, ...noV } = valid;
  const cases = [
    [[], 'not a JSON object'], [null, 'not a JSON object'], ['x', 'not a JSON object'],
    [noV, /^keys are not exactly /], [{ ...valid, extra: 1 }, /^keys are not exactly /], [{ ts: valid.ts, v: 1, ...noV }, /^keys are not exactly /],
    [{ ...valid, v: 2 }, 'v is not 1'], [{ ...valid, v: '1' }, 'v is not 1'],
    [{ ...valid, ts: '2026-10-08T12:00:00Z' }, /^ts /], [{ ...valid, ts: '2026-13-08T12:00:00.000Z' }, /^ts /], [{ ...valid, ts: '2026-02-30T12:00:00.000Z' }, /^ts /], [{ ...valid, ts: 5 }, /^ts /],
    [{ ...valid, session: '' }, /^session /], [{ ...valid, agent: '' }, /^agent /], [{ ...valid, parent: 3 }, /^parent /],
    [{ ...valid, type: null }, /^type /], [{ ...valid, ledger: 'a..b' }, /^ledger /], [{ ...valid, ledger: '' }, /^ledger /],
    [{ ...valid, batch: 'B1' }, /^batch /], [{ ...valid, batch: 'b01' }, /^batch /],
    [{ ...valid, batch: 'B01x' }, /^batch /], [{ ...valid, batch: 'xB01' }, /^batch /], [{ ...valid, role: 7 }, /^role /],
    [{ ...valid, model: '' }, /^model /], [{ ...valid, in: -1 }, /^in /], [{ ...valid, out: 1.5 }, /^out /], [{ ...valid, cr: '3' }, /^cr /],
    [{ ...valid, cw: 2 ** 53 }, /^cw /],
    [{ ...main, type: 'Explore' }, /^a main-loop record/], [{ ...main, role: 'x' }, /^a main-loop record/],
    [{ ...main, batch: 'B01' }, /^a main-loop record/], [{ ...main, parent: 'a0' }, /^a main-loop record/],
  ];
  for (const [value, reason] of cases) {
    const problem = recordProblem(value);
    if (typeof reason === 'string') assert.equal(problem, reason, JSON.stringify(value));
    else assert.match(String(problem), reason, JSON.stringify(value));
  }
  assert.deepEqual(parseRecordLine(JSON.stringify(valid)), { record: valid });
  assert.deepEqual(parseRecordLine(JSON.stringify(valid) + '\r'), { record: valid }, 'a CRLF file reads as an LF one');
  assert.deepEqual(parseRecordLine('{"v":1,'), { reason: 'not JSON' });
});

test('a part file parses line by line; the first bad line, a blank one or a cut last line is reported by number', async () => {
  const { parseRecords } = await cost;
  const line = n => JSON.stringify({ v: 1, ts: '2026-10-08T12:00:00.000Z', session: 's', agent: null, parent: null, type: 'main', ledger: null,
    batch: null, role: 'main', model: 'm', in: n, out: 0, cr: 0, cw: 0 });
  assert.deepEqual(parseRecords(''), { records: [] });
  assert.deepEqual(parseRecords(line(1) + '\n' + line(2) + '\n').records.map(r => r.in), [1, 2]);
  assert.deepEqual(parseRecords(line(1) + '\n\n' + line(2) + '\n'), { line: 2, reason: 'not JSON' });
  assert.deepEqual(parseRecords(line(1) + '\n{"v":2}\n'), { line: 2, reason: 'keys are not exactly v, ts, session, agent, parent, type, ledger, batch, role, model, in, out, cr, cw, in that order' });
  assert.deepEqual(parseRecords(line(1) + '\n' + line(2)), { line: 2, reason: 'no line break after the last record' });
  assert.deepEqual(parseRecords(line(1) + '\nx\n' + line(2)), { line: 2, reason: 'not JSON' }, 'the first problem in line order');
});

// ===== Files =============================================================================

test('part names, the cost directory and the 3 MiB fill, counted in UTF-8 bytes on both sides of the limit', async () => {
  const { partName, costDir, joinPath, fitting, utf8Length, PART_LIMIT } = await cost;
  assert.equal(PART_LIMIT, 3 * 1024 * 1024);
  assert.equal(partName('7f3c-aa_1', 0), '7f3c-aa_1.jsonl');
  assert.equal(partName('7f3c-aa_1', 2), '7f3c-aa_1.2.jsonl');
  for (const bad of ['', '../x', 'a/b', 'a\\b', 'a.1', '-a', undefined]) assert.equal(partName(bad, 0), null, String(bad));
  assert.equal(costDir('/home/u'), '/home/u/.claude/orchestrate-costs');
  assert.equal(costDir('C:\\Users\\Jo Ann\\'), 'C:\\Users\\Jo Ann/.claude/orchestrate-costs');
  assert.equal(joinPath('/', 'x'), '/x');
  const wide = 'é'.repeat(10) + '\n';
  assert.equal(utf8Length(wide), 21);
  assert.deepEqual(fitting(PART_LIMIT - 42, [wide, wide, wide], PART_LIMIT), { n: 2, bytes: 42 }, 'exactly at the limit');
  assert.deepEqual(fitting(PART_LIMIT - 41, [wide, wide], PART_LIMIT), { n: 1, bytes: 21 }, 'one byte past it');
  assert.deepEqual(fitting(PART_LIMIT - 20, [wide], PART_LIMIT), { n: 0, bytes: 0 });
  assert.deepEqual(fitting(0, ['x'.repeat(10) + '\n'], 5), { n: 1, bytes: 11 }, 'an empty part takes its first line whatever its size');
  assert.deepEqual(fitting(0, [], 5), { n: 0, bytes: 0 });
});

// ===== Pricing and totals ================================================================

test('the price table is the batch\'s, dated 2026-09-25, cache writes at 1.25x and 2x input', async () => {
  const { PRICES, PRICES_CHECKED } = await prices;
  assert.equal(PRICES_CHECKED, '2026-09-25');
  const row = (i, o, cacheRead, cacheWrite5m, cacheWrite1h) => ({ in: i, out: o, cacheRead, cacheWrite5m, cacheWrite1h });
  assert.deepEqual(PRICES, {
    'claude-opus-5-5': row(4, 20, 0.2, 5, 8), 'claude-sonnet-5-5': row(2, 10, 0.2, 2.5, 4),
    'claude-haiku-4-5': row(1, 5, 0.1, 1.25, 2), 'claude-haiku-4-5-20251001': row(1, 5, 0.1, 1.25, 2),
    'claude-fable-5-1': row(10, 50, 0.25, 12.5, 20), 'claude-fable-5': row(10, 50, 1, 12.5, 20), 'claude-opus-5': row(5, 25, 0.5, 6.25, 10),
  });
  for (const [model, p] of Object.entries(PRICES)) {
    assert.equal(p.cacheWrite5m, p.in * 1.25, model);
    assert.equal(p.cacheWrite1h, p.in * 2, model);
  }
});

test('pricing: the exact model id, the 1-hour write rate on the main loop and the 5-minute rate on a subagent, unknown never $0', async () => {
  const { priceOf } = await cost, { PRICES } = await prices;
  const r = (model, agent, tokens) => ({ model, agent, in: 0, out: 0, cr: 0, cw: 0, ...tokens });
  assert.equal(priceOf(r('claude-opus-5-5', null, { cw: 1000000 }), PRICES), 8, 'main loop: 1-hour writes');
  assert.equal(priceOf(r('claude-opus-5-5', 'a1', { cw: 1000000 }), PRICES), 5, 'subagent: 5-minute writes');
  assert.equal(priceOf(r('claude-opus-5', 'a1', { in: 1000000 }), PRICES), 5, 'claude-opus-5');
  assert.equal(priceOf(r('claude-opus-5-5', 'a1', { in: 1000000 }), PRICES), 4, 'claude-opus-5-5, of which claude-opus-5 is a prefix');
  near(priceOf(r('claude-fable-5-1', 'a1', { in: 100000, out: 10000, cr: 400000, cw: 40000 }), PRICES), 2.1, 'every rate at once');
  near(priceOf(r('claude-fable-5', null, { cr: 1000000, cw: 1000000 }), PRICES), 21, 'fable-5 reads at 1 and main writes at 20');
  for (const model of ['claude-opus', 'claude-opus-5-5-20261001', 'CLAUDE-OPUS-5-5', 'constructor', '__proto__', 'toString']) {
    assert.equal(priceOf(r(model, null, { in: 1 }), PRICES), null, model);
  }
});

test('addRecord keeps per-agent totals with the main loop under main, per-session totals and the whole, unpriced counted apart', async () => {
  const { newTotals, addRecord } = await cost, { PRICES } = await prices;
  const totals = newTotals();
  assert.equal(totals.tag, null);
  const rec = (ts, session, agent, extra) => ({ v: 1, ts, session, agent, parent: null, type: agent ? 'Explore' : 'main', ledger: null, batch: null,
    role: agent ? 'Explore' : 'main', model: 'claude-opus-5-5', in: 0, out: 0, cr: 0, cw: 0, ...extra });
  assert.equal(addRecord(totals, rec('2026-10-08T12:00:00.000Z', 's-1', null, { in: 1000000, cr: 10, cw: 1000000, ledger: 'OS-1' }), PRICES), 12.000002);
  addRecord(totals, rec('2026-10-08T12:00:05.000Z', 's-1', null, { in: 7, ledger: 'OS-2' }), PRICES);
  assert.equal(addRecord(totals, rec('2026-10-08T12:01:00.000Z', 's-2', 'a1', { model: 'claude-unknown', out: 5, batch: 'B01' }), PRICES), null);
  addRecord(totals, rec('2026-10-08T12:02:00.000Z', 's-2', 'a1', { cw: 1000000, cr: 3, in: 2 }), PRICES);
  assert.deepEqual([...totals.agents.keys()], ['main', 'a1']);
  const main = totals.agents.get('main'), a1 = totals.agents.get('a1');
  assert.deepEqual({ ...main, usd: Number(main.usd.toFixed(6)) }, { type: 'main', role: 'main', ledger: 'OS-2', batch: null, parent: null,
    firstSeen: Date.UTC(2026, 9, 8, 12), requests: 2, in: 1000007, out: 0, cr: 10, cw: 1000000, usd: 12.00003, unpriced: 0, lastPrompt: 7 });
  assert.deepEqual({ ...a1, usd: Number(a1.usd.toFixed(6)) }, { type: 'Explore', role: 'Explore', ledger: null, batch: null, parent: null,
    firstSeen: Date.UTC(2026, 9, 8, 12, 1), requests: 2, in: 2, out: 5, cr: 3, cw: 1000000, usd: 5.000009, unpriced: 1, lastPrompt: 1000005 });
  assert.deepEqual([...totals.sessions.keys()], ['s-1', 's-2']);
  assert.equal(totals.sessions.get('s-2').unpriced, 1);
  assert.equal(totals.sessions.get('s-1').requests, 2);
  assert.deepEqual({ ...totals.total, usd: Number(totals.total.usd.toFixed(6)) },
    { requests: 4, in: 1000009, out: 5, cr: 13, cw: 2000000, usd: 17.000039, unpriced: 1 });
});

// ===== cost-report.mjs ===================================================================

// The fixture: seven records over three files (one a rotated part), two ledgers and none, the main loop and
// subagents, three priced models and one unpriced. Each record's dollars, worked by hand from the batch's table:
//   r1 main L-A opus-5-5      1e6 in, 1e5 out, 2e6 cr, 5e5 cw (1h)  4 + 2 + 0.4 + 4      = 10.4
//   r2 a1 L-A B01 implementer opus-5-5 2e5, 5e4, 1e6, 1e5 (5m)      0.8 + 1 + 0.2 + 0.5   =  2.5
//   r3 a2 L-A B01 reviewer-round2 fable-5-1 1e5, 1e4, 4e5, 4e4      1 + 0.5 + 0.1 + 0.5   =  2.1
//   r4 a3 untagged Explore haiku-4-5-20251001 1e6 in, 2e5 out       1 + 1                 =  2.0
//   r5 a4 L-B B02 reviewer claude-unpriced-9, 10 of each            unpriced
//   r6 main L-B opus-5-5      5e5 in, 1e6 cw (1h)                    2 + 8                 = 10.0
//   r7 a5 L-B B02 implementer opus-5-5 1e6 cw (5m)                  5                     =  5.0
//   r8 a6 untagged, an agent the list did not name (type unknown, role null) opus-5-5 2.5e5 in = 1.0
const rec = (session, agent, type, ledger, batch, role, model, [i, o, cr, cw]) => JSON.stringify({ v: 1, ts: '2026-10-08T12:00:00.000Z',
  session, agent, parent: null, type, ledger, batch, role, model, in: i, out: o, cr, cw }) + '\n';
const FIXTURE = {
  's-one.jsonl': rec('s-one', null, 'main', 'L-A', null, 'main', 'claude-opus-5-5', [1000000, 100000, 2000000, 500000])
    + rec('s-one', 'a1', 'general-purpose', 'L-A', 'B01', 'implementer', 'claude-opus-5-5', [200000, 50000, 1000000, 100000])
    + rec('s-one', 'a2', 'general-purpose', 'L-A', 'B01', 'reviewer-round2', 'claude-fable-5-1', [100000, 10000, 400000, 40000]),
  's-one.1.jsonl': rec('s-one', 'a3', 'Explore', null, null, 'Explore', 'claude-haiku-4-5-20251001', [1000000, 200000, 0, 0])
    + rec('s-one', 'a4', 'general-purpose', 'L-B', 'B02', 'reviewer', 'claude-unpriced-9', [10, 10, 10, 10]),
  's-two.jsonl': rec('s-two', null, 'main', 'L-B', null, 'main', 'claude-opus-5-5', [500000, 0, 0, 1000000])
    + rec('s-two', 'a5', 'general-purpose', 'L-B', 'B02', 'implementer', 'claude-opus-5-5', [0, 0, 0, 1000000])
    + rec('s-two', 'a6', 'unknown', null, null, null, 'claude-opus-5-5', [250000, 0, 0, 0]),
  'notes.txt': 'not a record file\n',
};
const T = (requests, i, o, cr, cw, usd, unpriced = 0) => ({ requests, in: i, out: o, cr, cw, usd, unpriced });
const EXPECTED = {
  total: T(8, 3050010, 360010, 3400010, 2640010, 33, 1),
  byLedger: {
    '(none)': { total: T(2, 1250000, 200000, 0, 0, 3), byBatch: { '(none)': { total: T(2, 1250000, 200000, 0, 0, 3),
      byRole: { '(none)': T(1, 250000, 0, 0, 0, 1), Explore: T(1, 1000000, 200000, 0, 0, 2) } } } },
    'L-A': { total: T(3, 1300000, 160000, 3400000, 640000, 15), byBatch: {
      '(none)': { total: T(1, 1000000, 100000, 2000000, 500000, 10.4), byRole: { main: T(1, 1000000, 100000, 2000000, 500000, 10.4) } },
      B01: { total: T(2, 300000, 60000, 1400000, 140000, 4.6), byRole: {
        implementer: T(1, 200000, 50000, 1000000, 100000, 2.5), 'reviewer-round2': T(1, 100000, 10000, 400000, 40000, 2.1) } } } },
    'L-B': { total: T(3, 500010, 10, 10, 2000010, 15, 1), byBatch: {
      '(none)': { total: T(1, 500000, 0, 0, 1000000, 10), byRole: { main: T(1, 500000, 0, 0, 1000000, 10) } },
      B02: { total: T(2, 10, 10, 10, 1000010, 5, 1), byRole: { implementer: T(1, 0, 0, 0, 1000000, 5), reviewer: T(1, 10, 10, 10, 10, 0, 1) } } } },
  },
  byModel: { 'claude-fable-5-1': T(1, 100000, 10000, 400000, 40000, 2.1), 'claude-haiku-4-5-20251001': T(1, 1000000, 200000, 0, 0, 2),
    'claude-opus-5-5': T(5, 1950000, 150000, 3000000, 2600000, 28.9), 'claude-unpriced-9': T(1, 10, 10, 10, 10, 0, 1) },
  bySession: { 's-one': T(5, 2300010, 360010, 3400010, 640010, 17, 1), 's-two': T(3, 750000, 0, 0, 2000000, 16) },
};
function fixture(t, files = FIXTURE) {
  const dir = tempDir(t);
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
  return dir;
}

test('the report\'s JSON totals equal the hand-worked sums by ledger, batch, role, model and session', async t => {
  const { costReport } = await report, dir = fixture(t);
  const r = costReport(['--dir', dir, '--format', 'json'], {});
  assert.equal(r.code, 0);
  assert.equal(r.lines.length, 1);
  assert.deepEqual(JSON.parse(r.lines[0]), { v: 1, dir, files: 3, records: 8, ...EXPECTED });
  const keys = Object.keys(JSON.parse(r.lines[0]));
  assert.deepEqual(keys, ['v', 'dir', 'files', 'records', 'total', 'byLedger', 'byModel', 'bySession']);
});

test('the report filters by ledger, by untagged and by session, reading every file either way', async t => {
  const { costReport } = await report, dir = fixture(t);
  const json = (...args) => JSON.parse(costReport(['--dir', dir, '--format', 'json', ...args], {}).lines[0]);
  const a = json('--ledger', 'L-A');
  assert.deepEqual([a.files, a.records, a.total, a.byLedger], [3, 3, EXPECTED.byLedger['L-A'].total, { 'L-A': EXPECTED.byLedger['L-A'] }]);
  assert.deepEqual(json('--ledger', '(none)').byLedger, { '(none)': EXPECTED.byLedger['(none)'] });
  const two = json('--session', 's-two');
  assert.deepEqual([two.records, two.total, Object.keys(two.bySession)], [3, EXPECTED.bySession['s-two'], ['s-two']]);
  assert.deepEqual(json('--session', 's-one', '--ledger', 'L-B').total, T(1, 10, 10, 10, 10, 0, 1));
  assert.deepEqual(json('--ledger', 'L-Z').total, T(0, 0, 0, 0, 0, 0));
});

test('the report rounds every dollar total to 6 decimals: binary sums print as their decimals, and micro-dollars survive', async t => {
  const { costReport } = await report;
  // $0.1 and $0.2 at claude-opus-5-5's $4 per million input tokens: a float sum of 0.30000000000000004.
  const dir = fixture(t, { 'a.jsonl': rec('a', 'x', 'Explore', null, null, 'Explore', 'claude-opus-5-5', [25000, 0, 0, 0])
    + rec('a', 'x', 'Explore', null, null, 'Explore', 'claude-opus-5-5', [50000, 0, 0, 0]) });
  const out = JSON.parse(costReport(['--dir', dir, '--format', 'json'], {}).lines[0]);
  assert.notEqual(0.1 + 0.2, 0.3, 'the control: the float sum is not 0.3');
  const ledger = out.byLedger['(none)'], batch = ledger.byBatch['(none)'];
  assert.deepEqual([out.total.usd, out.byModel['claude-opus-5-5'].usd, out.bySession.a.usd, ledger.total.usd, batch.total.usd, batch.byRole.Explore.usd],
    [0.3, 0.3, 0.3, 0.3, 0.3, 0.3]);
  // The other side: one input and one cache-read token, $0.0000042, keep six decimals; fewer print 0.
  const small = fixture(t, { 'b.jsonl': rec('b', 'x', 'Explore', null, null, 'Explore', 'claude-opus-5-5', [1, 0, 1, 0]) });
  const tiny = JSON.parse(costReport(['--dir', small, '--format', 'json'], {}).lines[0]);
  const tl = tiny.byLedger['(none)'], tb = tl.byBatch['(none)'];
  assert.deepEqual([tiny.total.usd, tiny.byModel['claude-opus-5-5'].usd, tiny.bySession.b.usd, tl.total.usd, tb.total.usd, tb.byRole.Explore.usd],
    [0.000004, 0.000004, 0.000004, 0.000004, 0.000004, 0.000004]);
});

test('the report\'s text: the header line, then a row per ledger, batch and role, + ? marking unpriced records left out', async t => {
  const { costReport } = await report, dir = fixture(t);
  const r = costReport(['--dir', dir], {});
  assert.equal(r.code, 0);
  assert.equal(r.lines[0], 'COSTS 8 records, 3 files, $33.00 (1 unpriced)');
  const rows = r.lines.slice(2).map(line => line.split(/\s+/));
  assert.deepEqual(r.lines[1].split(/\s+/), ['ledger', 'batch', 'role', 'requests', 'in', 'out', 'cr', 'cw', 'usd']);
  assert.deepEqual(rows, [
    ['(none)', '*', '*', '2', '1250000', '200000', '0', '0', '$3.00'],
    ['(none)', '(none)', '*', '2', '1250000', '200000', '0', '0', '$3.00'],
    ['(none)', '(none)', '(none)', '1', '250000', '0', '0', '0', '$1.00'],
    ['(none)', '(none)', 'Explore', '1', '1000000', '200000', '0', '0', '$2.00'],
    ['L-A', '*', '*', '3', '1300000', '160000', '3400000', '640000', '$15.00'],
    ['L-A', '(none)', '*', '1', '1000000', '100000', '2000000', '500000', '$10.40'],
    ['L-A', '(none)', 'main', '1', '1000000', '100000', '2000000', '500000', '$10.40'],
    ['L-A', 'B01', '*', '2', '300000', '60000', '1400000', '140000', '$4.60'],
    ['L-A', 'B01', 'implementer', '1', '200000', '50000', '1000000', '100000', '$2.50'],
    ['L-A', 'B01', 'reviewer-round2', '1', '100000', '10000', '400000', '40000', '$2.10'],
    ['L-B', '*', '*', '3', '500010', '10', '10', '2000010', '$15.00+?'],
    ['L-B', '(none)', '*', '1', '500000', '0', '0', '1000000', '$10.00'],
    ['L-B', '(none)', 'main', '1', '500000', '0', '0', '1000000', '$10.00'],
    ['L-B', 'B02', '*', '2', '10', '10', '10', '1000010', '$5.00+?'],
    ['L-B', 'B02', 'implementer', '1', '0', '0', '0', '1000000', '$5.00'],
    ['L-B', 'B02', 'reviewer', '1', '10', '10', '10', '10', '$0.00+?'],
  ]);
  assert.equal(new Set(r.lines.slice(1).map(line => line.length)).size, 1, 'the table\'s columns are aligned');
});

test('the report fails closed: a malformed line, an unreadable file or directory and a bad invocation are UNKNOWN; absence is NO RECORDS', async t => {
  const { costReport } = await report, base = tempDir(t);
  const bad = fixture(t, { ...FIXTURE, 's-two.jsonl': FIXTURE['s-two.jsonl'] + '{"v":1}\n' });
  assert.deepEqual(costReport(['--dir', bad], {}), { code: 2,
    lines: [`UNKNOWN ${path.join(bad, 's-two.jsonl')}:4: keys are not exactly v, ts, session, agent, parent, type, ledger, batch, role, model, in, out, cr, cw, in that order`] });
  const cut = fixture(t, { 'a.jsonl': FIXTURE['s-two.jsonl'].slice(0, -1) });
  assert.deepEqual(costReport(['--dir', cut], {}).lines, [`UNKNOWN ${path.join(cut, 'a.jsonl')}:3: no line break after the last record`]);
  const binary = fixture(t, { 'a.jsonl': Buffer.from([0x7b, 0xff, 0x0a]) });
  assert.deepEqual(costReport(['--dir', binary], {}), { code: 2, lines: [`UNKNOWN ${path.join(binary, 'a.jsonl')}: cannot be read (not UTF-8)`] });
  const folder = fixture(t, { 'a.jsonl': FIXTURE['s-two.jsonl'] });
  fs.mkdirSync(path.join(folder, 'b.jsonl'));
  const r = costReport(['--dir', folder], {});
  assert.equal(r.code, 2);
  assert.match(r.lines[0], new RegExp('^UNKNOWN ' + path.join(folder, 'b.jsonl').replace(/[\\^$.*+?()[\]{}|]/g, '\\$&') + ': cannot be read \\(EISDIR\\)$'));
  assert.equal(r.lines.length, 1);
  const missing = path.join(base, 'none');
  assert.deepEqual(costReport(['--dir', missing], {}), { code: 0, lines: [`NO RECORDS ${missing}`] });
  const file = path.join(base, 'file');
  fs.writeFileSync(file, '');
  assert.deepEqual(costReport(['--dir', file], {}), { code: 0, lines: [`NO RECORDS ${file}`] }, 'ENOTDIR is a proven absence');
  assert.deepEqual(costReport(['--dir', path.join(file, 'x')], {}), { code: 0, lines: [`NO RECORDS ${path.join(file, 'x')}`] });
  const empty = fixture(t, {});
  assert.deepEqual(costReport(['--dir', empty], {}).lines, ['COSTS 0 records, 0 files, $0.00 (0 unpriced)', 'ledger  batch  role  requests  in  out  cr  cw  usd']);
  for (const args of [['--dir'], ['--dir', ''], ['--dir', base, '--dir', base], ['--format', 'csv', '--dir', base], ['--nope', 'x'], ['dir', base], ['--help', 'x']]) {
    const u = costReport(args, {});
    assert.equal(u.code, 2, args.join(' '));
    assert.match(u.lines[0], /^UNKNOWN usage: .+; use --help$/, args.join(' '));
  }
  assert.deepEqual(costReport([], {}), { code: 2, lines: ['UNKNOWN usage: no --dir, and neither HOME nor USERPROFILE is set; use --help'] });
  // A directory or file the platform refuses is unknown, whatever the refusal; only ENOENT and ENOTDIR are absence.
  const refusing = (code, where) => ({ readdirSync: dir => (where === 'dir' ? fail(code) : ['a.jsonl']), readFileSync: () => fail(code) });
  const fail = code => { throw Object.assign(new Error('refused'), code ? { code } : {}); };
  const at = path.resolve(base, 'x');
  assert.deepEqual(costReport(['--dir', at], {}, refusing('EACCES', 'dir')), { code: 2, lines: [`UNKNOWN ${at}: cannot be read (EACCES)`] });
  assert.deepEqual(costReport(['--dir', at], {}, refusing(undefined, 'dir')), { code: 2, lines: [`UNKNOWN ${at}: cannot be read (refused)`] });
  assert.deepEqual(costReport(['--dir', at], {}, refusing('EACCES', 'file')), { code: 2, lines: [`UNKNOWN ${path.join(at, 'a.jsonl')}: cannot be read (EACCES)`] });
  const unsorted = { readdirSync: () => ['b.jsonl', 'a.jsonl'], readFileSync: () => Buffer.from('x\n') };
  assert.deepEqual(costReport(['--dir', at], {}, unsorted).lines, [`UNKNOWN ${path.join(at, 'a.jsonl')}:1: not JSON`], 'files are read in name order');
  assert.deepEqual(costReport(['--dir', at], {}, refusing('ENOENT', 'file')), { code: 2, lines: [`UNKNOWN ${path.join(at, 'a.jsonl')}: cannot be read (ENOENT)`] },
    'a file listed then gone is not an absence of records');
  const help = costReport(['--help'], {});
  assert.equal(help.code, 0);
  assert.match(help.lines[0], /^node orchestrate-mod\/tools\/cost-report\.mjs \[--dir <dir>\]/);
});

test('the report\'s default directory is <home>/.claude/orchestrate-costs, home from HOME, else USERPROFILE', async t => {
  const { costReport } = await report, home = tempDir(t), other = tempDir(t);
  const dir = path.join(home, '.claude', 'orchestrate-costs');
  assert.deepEqual(costReport([], { HOME: home, USERPROFILE: other }).lines, [`NO RECORDS ${dir}`]);
  assert.deepEqual(costReport([], { USERPROFILE: home }).lines, [`NO RECORDS ${dir}`]);
  assert.deepEqual(costReport([], { HOME: '', USERPROFILE: home }).lines, [`NO RECORDS ${dir}`]);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 's.jsonl'), FIXTURE['s-two.jsonl']);
  assert.equal(costReport([], { HOME: home }).lines[0], 'COSTS 3 records, 1 files, $16.00 (0 unpriced)');
});

// ===== The CLI as published ==============================================================

function cli(args, cwd = ROOT, entry = REPORT) {
  const r = spawnSync(process.execPath, [entry, ...args], { cwd, env: ENV, encoding: 'utf8', windowsHide: true, timeout: 60000 });
  assert.ifError(r.error);
  assert.equal(r.signal, null);
  return { status: r.status, stdout: plain(r.stdout), stderr: plain(r.stderr) };
}

test('published: the CLI prints the JSON and text reports, and exits 2 on a malformed line', async t => {
  const dir = fixture(t);
  const json = cli(['--dir', dir, '--format', 'json']);
  assert.equal(json.status, 0, json.stderr);
  assert.deepEqual(JSON.parse(json.stdout), { v: 1, dir, files: 3, records: 8, ...EXPECTED });
  assert.ok(json.stdout.endsWith('}\n') && json.stdout.split('\n').length === 2, 'one line');
  const text = cli(['--dir', dir]);
  assert.equal(text.status, 0, text.stderr);
  assert.equal(text.stdout.split('\n')[0], 'COSTS 8 records, 3 files, $33.00 (1 unpriced)');
  const bad = fixture(t, { 'x.jsonl': 'nope\n' });
  const failed = cli(['--dir', bad]);
  assert.deepEqual([failed.status, failed.stdout], [2, `UNKNOWN ${path.join(bad, 'x.jsonl')}:1: not JSON\n`]);
});

test('published: run through a linked directory the CLI still runs, and imported it runs nothing', async t => {
  const base = tempDir(t), link = path.join(base, 'mod');
  fs.symlinkSync(path.join(ROOT, 'orchestrate-mod'), link, 'junction');
  const r = cli(['--help'], base, path.join(link, 'tools', 'cost-report.mjs'));
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^node orchestrate-mod\/tools\/cost-report\.mjs /);
  const imported = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(pathToFileURL(REPORT).href)})`],
    { cwd: base, env: ENV, encoding: 'utf8', windowsHide: true, timeout: 60000 });
  assert.deepEqual([imported.status, imported.stdout], [0, ''], imported.stderr);
});

test('published: every hidden character a record holds prints as ?: C0 but tab and LF, DEL, C1 and both Unicode separators', async t => {
  const range = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => from + i);
  const codes = [...range(0x00, 0x08), ...range(0x0b, 0x1f), ...range(0x7f, 0x9f), 0x2028, 0x2029];
  const line = JSON.stringify({ v: 1, ts: '2026-10-08T12:00:00.000Z', session: 's', agent: 'a', parent: null, type: 'x', ledger: null, batch: null,
    role: 'r' + String.fromCharCode(...codes) + 'z', model: 'm', in: 0, out: 0, cr: 0, cw: 0 }) + '\n';
  const dir = fixture(t, { 'a.jsonl': line });
  const r = spawnSync(process.execPath, [REPORT, '--dir', dir], { cwd: ROOT, env: ENV, encoding: 'utf8', windowsHide: true, timeout: 60000 });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes('r' + '?'.repeat(codes.length) + 'z'), r.stdout);
  for (const code of codes) assert.ok(!r.stdout.includes(String.fromCharCode(code)), code.toString(16));
});
