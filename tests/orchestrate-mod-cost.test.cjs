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
const { isDeepStrictEqual } = require('node:util');
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
const FACT_VALUES = { guardrails: 'none', gateAgentsRun: false, round: 1, round1Sha: 'abc1234', subagentTokens: 1 };

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
  assert.equal(r.lines[0], 'COSTS 8 records, 3 files, $33.00 (1 unpriced), main loop and sub-agents only');
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
  assert.deepEqual(costReport(['--dir', empty], {}).lines, ['COSTS 0 records, 0 files, $0.00 (0 unpriced), main loop and sub-agents only', 'ledger  batch  role  requests  in  out  cr  cw  usd']);
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
  assert.equal(costReport([], { HOME: home }).lines[0], 'COSTS 3 records, 1 files, $16.00 (0 unpriced), main loop and sub-agents only');
});

// ===== --cost-state ======================================================================

// A subagent record of `usd` dollars at epoch ms `ms`: claude-opus-5-5 input at $4 per million tokens, or as many
// tokens of an unpriced model.
const at = (ms, session, usd, { ledger = null, model = 'claude-opus-5-5' } = {}) => JSON.stringify({ v: 1, ts: new Date(ms).toISOString(), session,
  agent: 'a1', parent: null, type: 'Explore', ledger, batch: null, role: 'Explore', model, in: Math.round(usd * 250000), out: 0, cr: 0, cw: 0 }) + '\n';
// A transcript's cost-state line as Claude Code writes it, its keys in Claude Code's order; other lines a transcript holds.
const costLine = (sessionId, totalCostUSD, startTime, extra = {}) => JSON.stringify({ type: 'cost-state', sessionId, totalCostUSD, totalAPIDuration: 1200,
  totalAPIDurationWithoutRetries: 1100, totalToolDuration: 30, totalLinesAdded: 0, totalLinesRemoved: 0, totalDuration: 5000, startTime,
  modelUsage: totalCostUSD === 0 ? {} : { 'claude-opus-5-5': { costUSD: totalCostUSD } }, ...extra }) + '\n';
const userLine = sessionId => JSON.stringify({ type: 'user', sessionId, message: { role: 'user', content: 'go "type":"cost-state" here' } }) + '\n';
// The marker as a nested object of another kind of line: no cost-state line.
const nestedLine = sessionId => JSON.stringify({ type: 'assistant', sessionId, message: { content: [{ type: 'cost-state', sessionId }] } }) + '\n';
const T1 = Date.UTC(2026, 9, 20, 12), T2 = T1 + 3600000, MIN = 60000;
const iso = ms => new Date(ms).toISOString();
const LF = String.fromCharCode(10), TAB = String.fromCharCode(9);
const ODD = 'c-' + LF + 'x' + TAB + 'y';
// Records of ten sessions, and their transcripts in two project directories, each worked by hand:
//   c-match    $4 at T1, $2 (ledger L-X) at T1+1m; cost-state $7.50 since T1         -> $6.00, outside $1.50, 20.0%
//   c-resumed  $8 at T2-1ms, $1 at T2; cost-state $1.25 since T2: only the second   -> $1.00, outside $0.25, 20.0%
//   c-zero     $1 at T1; cost-state $0 since T1, a real total, modelUsage {}         -> $1.00, outside -$1.00, no share
//   c-several  $3 at T2; cost-state lines of $1, $2 and $3.50, then the marker nested and a line cut inside a character
//              -> the last: $0.50, 14.3%
//   c-cents    $0.996 at T1; cost-state $1.004 since T1: each prints $1.00          -> outside $0.00, the printed difference
//   c-float    $0.1 and $0.2 at T1; cost-state 0.1 + 0.2: two float sums           -> json 0.3 for both, rounded to 6 decimals
//   c-open     $2 and an unpriced record at T1; cost-state $3 since T1              -> $2.00+?, outside $1.00-?, 33.3%-?
//   c-none     a transcript holding the marker only nested and in a message: none
//   c-gone     no transcript one directory deep (one sits two deep): none; ODD the same, its tab and LF printed as ?
const RECORDS = {
  'a.jsonl': at(T1, 'c-match', 4) + at(T1 + MIN, 'c-match', 2, { ledger: 'L-X' }) + at(T2 - 1, 'c-resumed', 8) + at(T2, 'c-resumed', 1) + at(T1, 'c-zero', 1),
  'b.jsonl': at(T2, 'c-several', 3) + at(T1, 'c-open', 2) + at(T1, 'c-open', 1, { model: 'claude-unpriced-9' }) + at(T1, 'c-none', 1) + at(T1, 'c-gone', 1) + at(T1, ODD, 1)
    + at(T1, 'c-cents', 0.996) + at(T1, 'c-float', 0.1) + at(T1, 'c-float', 0.2),
};
const TRANSCRIPTS = {
  '-tmp-a/c-match.jsonl': userLine('c-match') + costLine('c-match', 7.5, T1),
  '-tmp-a/c-resumed.jsonl': userLine('c-resumed') + costLine('c-resumed', 1.25, T2),
  '-tmp-a/c-none.jsonl': userLine('c-none') + nestedLine('c-none'),
  '-tmp-a/other.jsonl': costLine('other', 9, T1),
  '-tmp-a/c-cents.jsonl': costLine('c-cents', 1.004, T1),
  '-tmp-a/c-float.jsonl': costLine('c-float', 0.1 + 0.2, T1),
  '-tmp-b/c-zero.jsonl': costLine('c-zero', 0, T1),
  '-tmp-b/c-several.jsonl': costLine('c-several', 1, T2) + userLine('c-several') + costLine('c-several', 2, T2) + costLine('c-several', 3.5, T2)
    + nestedLine('c-several') + '{"type":"assistant","message":{"content":"cut',
  '-tmp-b/c-several/subagents/c-gone.jsonl': costLine('c-gone', 5, T1),
  '-tmp-b/c-open.jsonl': costLine('c-open', 3, T1),
  '-tmp-b/other.jsonl': costLine('other', 9, T1),
};
const STATE_LINES = [
  `COST-STATE c-?x?y none`,
  `COST-STATE c-cents records $1.00 since ${iso(T1)}, cost-state $1.00, outside the records $0.00 (0.0% of cost-state)`,
  `COST-STATE c-float records $0.30 since ${iso(T1)}, cost-state $0.30, outside the records $0.00 (0.0% of cost-state)`,
  `COST-STATE c-gone none`,
  `COST-STATE c-match records $6.00 since ${iso(T1)}, cost-state $7.50, outside the records $1.50 (20.0% of cost-state)`,
  `COST-STATE c-none none`,
  `COST-STATE c-open records $2.00+? since ${iso(T1)}, cost-state $3.00, outside the records $1.00-? (33.3%-? of cost-state)`,
  `COST-STATE c-resumed records $1.00 since ${iso(T2)}, cost-state $1.25, outside the records $0.25 (20.0% of cost-state)`,
  `COST-STATE c-several records $3.00 since ${iso(T2)}, cost-state $3.50, outside the records $0.50 (14.3% of cost-state)`,
  `COST-STATE c-zero records $1.00 since ${iso(T1)}, cost-state $0.00, outside the records -$1.00`,
];
const STATES = {
  [ODD]: null, 'c-gone': null, 'c-none': null,
  'c-cents': { records: T(1, 249000, 0, 0, 0, 0.996), costState: 1.004, outside: 0.008, startTime: iso(T1) },
  'c-float': { records: T(2, 75000, 0, 0, 0, 0.3), costState: 0.3, outside: 0, startTime: iso(T1) },
  'c-match': { records: T(2, 1500000, 0, 0, 0, 6), costState: 7.5, outside: 1.5, startTime: iso(T1) },
  'c-open': { records: T(2, 750000, 0, 0, 0, 2, 1), costState: 3, outside: 1, startTime: iso(T1) },
  'c-resumed': { records: T(1, 250000, 0, 0, 0, 1), costState: 1.25, outside: 0.25, startTime: iso(T2) },
  'c-several': { records: T(1, 750000, 0, 0, 0, 3), costState: 3.5, outside: 0.5, startTime: iso(T2) },
  'c-zero': { records: T(1, 250000, 0, 0, 0, 1), costState: 0, outside: -1, startTime: iso(T1) },
};
// The records directory and a projects directory holding `transcripts` and a stray file beside the project directories,
// with a <session>/subagents/ directory beside each transcript, as Claude Code keeps one; c-several's cut line ends in
// the first two of the three bytes of a euro sign, as a transcript being written can.
function projectsFixture(t, transcripts = TRANSCRIPTS) {
  const dir = fixture(t, RECORDS), projects = tempDir(t);
  fs.writeFileSync(path.join(projects, 'notes.txt'), 'not a project directory\n');
  for (const [name, text] of Object.entries(transcripts)) {
    fs.mkdirSync(path.dirname(path.join(projects, name)), { recursive: true });
    fs.writeFileSync(path.join(projects, name), text);
    const transcript = /^(-tmp-[ab])\/([^/]+)\.jsonl$/.exec(name);
    if (transcript) {
      fs.mkdirSync(path.join(projects, transcript[1], transcript[2], 'subagents'), { recursive: true });
      fs.writeFileSync(path.join(projects, transcript[1], transcript[2], 'subagents', 'agent-1.jsonl'), userLine(transcript[2]));
    }
  }
  fs.appendFileSync(path.join(projects, '-tmp-b', 'c-several.jsonl'), Buffer.from([0xe2, 0x82]));
  return { dir, projects };
}

test('--cost-state: per session in id order, the records from the last cost-state line\'s startTime on against its total, none and a real $0', async t => {
  const { costReport } = await report, { dir, projects } = projectsFixture(t);
  assert.ok(fs.readdirSync(projects, { withFileTypes: true }).some(e => e.isFile()), 'the control: a stray file sits beside the project directories');
  const r = costReport(['--cost-state', '--dir', dir, '--projects', projects], {});
  assert.equal(r.code, 0, r.lines.join('\n'));
  assert.deepEqual(r.lines.slice(-STATE_LINES.length), STATE_LINES);
  // The table is the report's own, its columns aligned without the COST-STATE lines after it.
  const table = r.lines.slice(1, -STATE_LINES.length);
  assert.deepEqual(table.map(line => line.split(/ +/)[2]), ['role', '*', '*', 'Explore', '*', '*', 'Explore']);
  assert.equal(new Set(table.map(line => line.length)).size, 1, 'the table\'s columns are aligned');
  assert.equal(r.lines[0], 'COSTS 14 records, 2 files, $25.30 (1 unpriced), main loop and sub-agents only');
  // json: the same entries, and the default key set with costState after it.
  const out = costReport(['--dir', dir, '--format', 'json', '--cost-state', '--projects', projects], {});
  const parsed = JSON.parse(out.lines[0]);
  assert.deepEqual(Object.keys(parsed), ['v', 'dir', 'files', 'records', 'total', 'byLedger', 'byModel', 'bySession', 'costState']);
  assert.deepEqual(parsed.costState, STATES);
  // --ledger keeps c-match alone, by its L-X record, and its records still count whole against its total.
  const kept = costReport(['--dir', dir, '--ledger', 'L-X', '--cost-state', '--projects', projects], {});
  assert.deepEqual(kept.lines.filter(line => line.startsWith('COST-STATE ')), STATE_LINES.filter(line => line.startsWith('COST-STATE c-match ')));
  assert.equal(kept.lines[0], 'COSTS 1 records, 2 files, $2.00 (0 unpriced), main loop and sub-agents only');
  // A session holding a tab and an LF whose transcript has a cost-state line, on a file system no platform needs to allow.
  const odd = 'c-' + TAB + 'z' + LF + 'w', records = path.resolve('records'), root = path.resolve('projects');
  const fake = { readdirSync: p => (p === records ? ['a.jsonl'] : p === root ? ['-p'] : [odd + '.jsonl']),
    readFileSync: p => Buffer.from(p === path.join(records, 'a.jsonl') ? at(T1, odd, 1) : costLine(odd, 1, T1)) };
  assert.deepEqual(costReport(['--dir', records, '--cost-state', '--projects', root], {}, fake).lines.slice(-1),
    [`COST-STATE c-?z?w records $1.00 since ${iso(T1)}, cost-state $1.00, outside the records $0.00 (0.0% of cost-state)`]);
});

test('--cost-state: a CRLF transcript reads as its LF original, and no projects directory is none for every session', async t => {
  const { costReport } = await report;
  const crlf = Object.fromEntries(Object.entries(TRANSCRIPTS).map(([name, text]) => [name, text.split('\n').join('\r\n')]));
  assert.ok(crlf['-tmp-a/c-match.jsonl'].includes('}\r\n'), 'the control: the twin is CRLF');
  const { dir, projects } = projectsFixture(t, crlf);
  assert.deepEqual(costReport(['--dir', dir, '--cost-state', '--projects', projects], {}).lines.slice(-STATE_LINES.length), STATE_LINES);
  const none = STATE_LINES.map(line => line.replace(/ records .*$/, ' none'));
  const missing = path.join(projects, 'missing'), file = path.join(projects, 'notes.txt');
  for (const absent of [missing, file]) {
    const r = costReport(['--dir', dir, '--cost-state', '--projects', absent], {});
    assert.deepEqual([r.code, r.lines.slice(-none.length)], [0, none], absent);
  }
});

test('--cost-state fails closed: a transcript or directory that cannot be read, a bad cost-state line and two transcripts are UNKNOWN', async t => {
  const { costReport } = await report, { dir, projects } = projectsFixture(t);
  const fail = code => { throw Object.assign(new Error('refused'), code ? { code } : {}); };
  // The file system with one path refused, listed or read.
  const refusing = (where, code) => ({ readdirSync: p => (p === where ? fail(code) : fs.readdirSync(p)), readFileSync: p => (p === where ? fail(code) : fs.readFileSync(p)) });
  const run = (io, extra = []) => costReport(['--dir', dir, '--cost-state', '--projects', projects, ...extra], {}, io);
  assert.equal(run(fs).code, 0, 'the control: the fixture reads');
  const match = path.join(projects, '-tmp-a', 'c-match.jsonl'), project = path.join(projects, '-tmp-b');
  const refusals = [[match, 'EACCES'], [match, 'ENOENT'], [match, undefined], [projects, 'EACCES'], [project, 'EACCES'], [project, 'ENOENT']];
  const faults = [];
  for (const [where, code] of refusals) {
    const r = run(refusing(where, code));
    const expected = { code: 2, lines: [`UNKNOWN ${where}: cannot be read (${code ?? 'refused'})`] };
    if (!isDeepStrictEqual(r, expected)) faults.push(`${where} ${code}: ${JSON.stringify(r.lines.slice(0, 1))}`);
  }
  assert.deepEqual(faults, [], 'a listed path that is gone, or refused for any reason, is not an absence');
  // The last cost-state line of c-match replaced by each bad form, read through the same file. 1e400 is the one
  // non-finite number JSON reads, written raw.
  const overflow = costLine('c-match', 7.5, T1).replace('"totalCostUSD":7.5,', () => '"totalCostUSD":1e400,');
  assert.ok(overflow.includes('1e400') && JSON.parse(overflow).totalCostUSD === Infinity, 'the control: the line holds 1e400, read as Infinity');
  const bad = [
    [overflow, 'totalCostUSD is not a non-negative number'],
    ['{"type":"cost-state","sessionId":"c-match","totalCostUSD":7.', 'a cost-state line that is not JSON'],
    [costLine('c-other', 7.5, T1), 'the cost-state line names session "c-other"'],
    [costLine('c-match', 7.5, T1, { sessionId: undefined }), 'the cost-state line names session undefined'],
    ...['7.5', -0.01, null, undefined].map(v => [costLine('c-match', 0, T1, { totalCostUSD: v }), 'totalCostUSD is not a non-negative number']),
    ...[T1 + 0.5, -1, String(T1), null, undefined, 9e15].map(v => [costLine('c-match', 1, T1, { startTime: v }), 'startTime is not a time in milliseconds']),
  ];
  const lineFaults = [];
  for (const [line, reason] of bad) {
    fs.writeFileSync(match, userLine('c-match') + costLine('c-match', 7.5, T1) + line);
    const r = run(fs), expected = { code: 2, lines: [`UNKNOWN ${match}:3: ${reason}`] };
    if (!isDeepStrictEqual(r, expected)) lineFaults.push(line.trim() + ' -> ' + JSON.stringify(r.lines.slice(-1)));
  }
  assert.deepEqual(lineFaults, []);
  // The other side of startTime's lower bound: 0 is a time, from which every record of the session counts.
  fs.writeFileSync(match, costLine('c-match', 7.5, T1));
  fs.writeFileSync(path.join(projects, '-tmp-a', 'c-resumed.jsonl'), costLine('c-resumed', 9, 0));
  assert.deepEqual(run(fs).lines.filter(line => line.startsWith('COST-STATE c-resumed ')),
    ['COST-STATE c-resumed records $9.00 since 1970-01-01T00:00:00.000Z, cost-state $9.00, outside the records $0.00 (0.0% of cost-state)']);
  // The same session's transcript in a second project directory, named the same way whatever order the projects
  // directory lists in.
  fs.writeFileSync(path.join(project, 'c-match.jsonl'), costLine('c-match', 7.5, T1));
  const second = { code: 2, lines: [`UNKNOWN ${path.join(project, 'c-match.jsonl')}: a second transcript of the session, beside ${match}`] };
  assert.deepEqual(run(fs), second);
  const reversed = { readdirSync: p => (p === projects ? fs.readdirSync(p).reverse() : fs.readdirSync(p)), readFileSync: p => fs.readFileSync(p) };
  const order = reversed.readdirSync(projects);
  assert.ok(order.indexOf('-tmp-b') < order.indexOf('-tmp-a'), 'the control: the listing names -tmp-b first');
  assert.deepEqual(run(reversed), second);
});

test('--cost-state takes no value; --projects takes one and needs --cost-state; with neither --projects nor a home it is a usage error', async t => {
  const { costReport } = await report, { dir, projects } = projectsFixture(t), home = tempDir(t);
  const usage = why => ({ code: 2, lines: [`UNKNOWN usage: ${why}; use --help`] });
  const cases = [
    [['--dir', dir, '--cost-state', 'x'], usage('unknown argument x')],
    [['--dir', dir, '--cost-state', '--cost-state'], usage('--cost-state given twice')],
    [['--dir', dir, '--cost-state', '--projects'], usage('--projects needs a value')],
    [['--dir', dir, '--cost-state', '--projects', ''], usage('--projects needs a value')],
    [['--dir', dir, '--projects', projects], usage('--projects needs --cost-state')],
    [['--cost-state', '--dir', dir], usage('--cost-state with no --projects, and neither HOME nor USERPROFILE is set')],
  ];
  assert.deepEqual(cases.map(([args]) => costReport(args, {})), cases.map(([, expected]) => expected));
  // The controls: the same runs with what each lacked.
  assert.equal(costReport(['--dir', dir, '--cost-state', '--projects', projects], {}).code, 0);
  assert.equal(costReport(['--dir', dir, '--projects', projects, '--cost-state'], {}).code, 0);
  // The default <home>/.claude/projects, home from HOME, else USERPROFILE; --projects over either.
  fs.cpSync(projects, path.join(home, '.claude', 'projects'), { recursive: true });
  for (const env of [{ HOME: home }, { HOME: home, USERPROFILE: tempDir(t) }, { USERPROFILE: home }, { HOME: '', USERPROFILE: home }, { HOME: tempDir(t) }]) {
    const args = env.HOME && env.HOME !== home ? ['--dir', dir, '--cost-state', '--projects', projects] : ['--dir', dir, '--cost-state'];
    assert.deepEqual(costReport(args, env).lines.slice(-STATE_LINES.length), STATE_LINES, JSON.stringify(env));
  }
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
  assert.equal(text.stdout.split('\n')[0], 'COSTS 8 records, 3 files, $33.00 (1 unpriced), main loop and sub-agents only');
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

test('published: an LF and a tab in a record\'s role print as ? inside its one table row, the columns still aligned', async t => {
  const role = 'r' + String.fromCharCode(10) + 'z' + String.fromCharCode(9) + 'q';
  const line = JSON.stringify({ v: 1, ts: '2026-10-08T12:00:00.000Z', session: 's', agent: 'a', parent: null, type: 'x', ledger: null, batch: null,
    role, model: 'm', in: 0, out: 0, cr: 0, cw: 0 }) + '\n';
  const dir = fixture(t, { 'a.jsonl': line });
  const r = spawnSync(process.execPath, [REPORT, '--dir', dir], { cwd: ROOT, env: ENV, encoding: 'utf8', windowsHide: true, timeout: 60000 });
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.split('\n');
  assert.equal(lines.pop(), '', 'the output ends with a line break');
  // Split on spaces alone: a tab printed raw would stay inside the role's cell, an LF printed raw would start a row.
  assert.deepEqual(lines.slice(2).map(l => l.split(/ +/)), [
    ['(none)', '*', '*', '1', '0', '0', '0', '0', '$0.00+?'],
    ['(none)', '(none)', '*', '1', '0', '0', '0', '0', '$0.00+?'],
    ['(none)', '(none)', 'r?z?q', '1', '0', '0', '0', '0', '$0.00+?'],
  ], r.stdout);
  assert.equal(new Set(lines.slice(1).map(l => l.length)).size, 1, 'the table\'s columns are aligned');
});

test('published: a hidden character in a path the report prints shows as ?: the pass over the whole output stays', async t => {
  // Every code of the role sweep above but NUL, which no argument can hold: the role's are replaced in its cell, a
  // path's only by the pass over the output.
  const range = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => from + i);
  const codes = [...range(0x01, 0x08), ...range(0x0b, 0x1f), ...range(0x7f, 0x9f), 0x2028, 0x2029];
  const missing = path.join(tempDir(t), 'x' + String.fromCharCode(...codes) + 'y');
  const r = spawnSync(process.execPath, [REPORT, '--dir', missing], { cwd: ROOT, env: ENV, encoding: 'utf8', windowsHide: true, timeout: 60000 });
  // A platform that refuses the name rather than finding it absent prints UNKNOWN: the path is printed either way.
  assert.match(r.stdout, /^(?:NO RECORDS|UNKNOWN) /, r.stderr);
  assert.equal(r.status, r.stdout.startsWith('NO RECORDS ') ? 0 : 2);
  assert.ok(r.stdout.includes('x' + '?'.repeat(codes.length) + 'y'), r.stdout);
  assert.deepEqual(codes.filter(code => r.stdout.includes(String.fromCharCode(code))).map(code => code.toString(16)), []);
});

test('published: --cost-state prints its lines after the table, and its json key, from the projects directory given', async t => {
  const { dir, projects } = projectsFixture(t);
  const text = cli(['--dir', dir, '--cost-state', '--projects', projects]);
  assert.equal(text.status, 0, text.stderr);
  assert.deepEqual(text.stdout.split('\n').slice(-STATE_LINES.length - 1), [...STATE_LINES, '']);
  const json = cli(['--dir', dir, '--format', 'json', '--cost-state', '--projects', projects]);
  assert.equal(json.status, 0, json.stderr);
  assert.deepEqual(JSON.parse(json.stdout).costState, STATES);
});

// ===== README §Use =======================================================================

// README §Use's account of the report, from its bullet to the end of its usage block, whitespace collapsed: the
// usage line is HELP's synopsis. The words of its scope sit nowhere else in README, so no other sentence restates or
// reverses them.
const USE_FROM = '- `cost-report.mjs` totals the records';
const SCOPE_WORDS = [/cost-state/gi, /agent-progress/gi, /classifier/gi, /sub-agents only/gi, /(?<![\w/.~-])\/cost\b/gi];
function useFaults(readme, help) {
  const text = readme.replace(/\r\n/g, '\n'), start = text.indexOf(USE_FROM), open = text.indexOf('```bash\n', start), close = text.indexOf('\n```', open + 8);
  if (start === -1 || text.indexOf(USE_FROM, start + 1) !== -1 || open === -1 || close === -1) return ['§Use: the passage is not found once'];
  const expected = "- `cost-report.mjs` totals the records by ledger, batch and role, by model and by session; an unpriced model's dollars are shown"
    + " as unknown (`+?`), never as $0. The records cover the main loop and sub-agents only: the agent-progress summaries Claude Code requests for each"
    + " running sub-agent (terminal sessions run them, desktop sessions do not) and auto mode's classifier calls are outside them. `--cost-state` adds a"
    + " line per session comparing its records since the session last started with the `cost-state` total Claude Code last wrote in its transcript"
    + " under `~/.claude/projects`, which counts the summaries but not the classifier calls: ```bash " + help.split('\n')[0] + ' ```';
  const end = close + 4, faults = text.slice(start, end).replace(/\s+/g, ' ').trim() === expected ? [] : ['§Use: the passage changed'];
  const synopses = text.split('\n').filter(line => line.startsWith('node orchestrate-mod/tools/cost-report.mjs'));
  if (synopses.length !== 1 || synopses[0] !== help.split('\n')[0]) faults.push('the usage lines are not HELP\'s synopsis once: ' + JSON.stringify(synopses));
  for (const word of SCOPE_WORDS) {
    for (const m of text.matchAll(word)) if (m.index < start || m.index >= end) faults.push('outside §Use: ' + m[0]);
  }
  return faults;
}
// HELP's body, every line after the synopsis useFaults binds to README, whitespace collapsed and pinned whole: no
// sentence of its scope, of --cost-state or of its exit codes changes, and none joins it, unread. `checked` is
// orchestrate-mod/hooks/prices.js `PRICES_CHECKED`.
function helpFaults(help, checked) {
  const expected = 'Reads every *.jsonl in <dir> (default <home>/.claude/orchestrate-costs, home from HOME, else USERPROFILE), sorted by name, and'
    + ' validates every line as a cost record. --ledger and --session keep the records of one ledger (`(none)`: untagged) or session. text (the default)'
    + ' prints the line `COSTS <records> records, <files> files, $<usd> (<n> unpriced), main loop and sub-agents only` and a table by ledger, batch and'
    + ' role; json prints one line with the totals by ledger, batch and role, by model and by session. A dollar figure sums the priced records; `+?`'
    + ' marks one that leaves unpriced records out (a model the price table, checked ' + checked + ', lacks).'
    + ' The records cover the main loop and sub-agents only. Outside them: the agent-progress summaries Claude Code requests for each running sub-agent'
    + " (terminal sessions run them, desktop sessions do not), and auto mode's classifier calls."
    + ' --cost-state compares each session of the kept records with the last `"type":"cost-state"` line of its transcript, <projects>/*/<session>.jsonl'
    + " (default <home>/.claude/projects): Claude Code's own total since the session last started, which counts the summaries but not the classifier"
    + ' calls. After the table, one line per session in id order: `COST-STATE <session> records $<x> since <startTime>, cost-state $<y>, outside the'
    + ' records $<y - x> (<n>% of cost-state)`, where <x> sums every record of the session from startTime on, whatever --ledger keeps; an unpriced'
    + ' record marks <x> `+?` and the outside figure and its share `-?`, and a $0.00 cost-state prints no share. A session with no transcript, or no'
    + ' cost-state line in it, prints `COST-STATE <session> none`. json adds `costState`: per session `{ records: <a total>, costState, outside,'
    + ' startTime: <ISO time> }`, or null for none.'
    + ' Exit 0: every line read and valid, or `NO RECORDS <dir>` when the directory does not exist. Exit 2: one `UNKNOWN <path>[:<line>]: <reason>`'
    + ' line for a malformed record or cost-state line, a session with two transcripts, a file or directory that cannot be read, or an invalid invocation.';
  const at = help.indexOf('\n');
  return at !== -1 && help.slice(at + 1).replace(/\s+/g, ' ').trim() === expected ? [] : ['HELP: its body changed'];
}

test('README §Use states the report\'s scope and --cost-state, its usage line HELP\'s synopsis; HELP states the scope', async () => {
  const { costReport } = await report, help = costReport(['--help'], {}).lines[0], read = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  const { PRICES_CHECKED } = await prices;
  assert.deepEqual(helpFaults(help, PRICES_CHECKED), []);
  // Live: the reviewer's reversed scope, absence printed as $0, the terminal and desktop sessions swapped, the flag unnamed;
  // each edit's anchor is found once. A changed synopsis alone leaves the body as it was.
  const edits = [
    ["auto mode's\n  classifier calls.", "auto mode's\n  classifier calls. Every request of the session is in the records, so the totals equal the /cost of Claude Code."],
    ['`COST-STATE <session> none`', '`COST-STATE <session> records $0.00`'],
    ['terminal sessions run them, desktop sessions do not', 'desktop sessions run them, terminal sessions do not'],
    ['--cost-state compares', 'It compares'],
  ];
  assert.deepEqual(edits.map(([from]) => help.split(from).length - 1), edits.map(() => 1), 'each control anchor is found once');
  assert.deepEqual(edits.map(([from, to]) => helpFaults(help.replace(from, () => to), PRICES_CHECKED)), edits.map(() => ['HELP: its body changed']));
  assert.deepEqual(helpFaults('node cost-report.mjs' + help.slice(help.indexOf('\n')), PRICES_CHECKED), []);
  // Both checkout forms of README on every platform, each built from the LF text whatever the checkout wrote, so a Linux
  // run reads what a CRLF checkout reads (CLAUDE.md "A verdict that depends on the platform, the checkout or the
  // terminal"). The README as read is one of the two, and every check below runs on each as `readme`, its failures
  // collected and asserted once.
  const asLf = text => text.replace(/\r\n/g, '\n'), asCrlf = text => asLf(text).replace(/\n/g, '\r\n'), both = text => [asLf(text), asCrlf(text)];
  assert.ok(both(read).includes(read), 'the README as read is the LF form or the CRLF form');
  const checks = readme => {
    assert.deepEqual(useFaults(readme, help), []);
    const lf = asLf(readme), crlf = asCrlf(readme), formOf = text => text === lf ? 'LF' : text === crlf ? 'CRLF' : 'neither';
    assert.deepEqual([lf.includes('\r\n'), /(?<!\r)\n/.test(crlf), crlf.includes('\r\n')], [false, false, true], 'one LF form and one CRLF form');
    assert.notEqual(formOf(readme), 'neither', 'the form read is the LF form or the CRLF form');
    assert.deepEqual([readme, lf, crlf].map(form => both(form).map(formOf)), [['LF', 'CRLF'], ['LF', 'CRLF'], ['LF', 'CRLF']], 'every form converts to the same two');
    assert.deepEqual(both(readme).map(form => useFaults(form, help)), [[], []], 'a CRLF checkout reads alike');
    // Live: the old emulation, CRLF written over the CRLF form, leaves CR CR LF, and the passage is not found.
    assert.deepEqual(useFaults(crlf.replace(/\n/g, '\r\n'), help), ['§Use: the passage is not found once']);
    // Live, on both forms: a stale synopsis, a sentence planted inside the passage, and each scope word planted outside it.
    const stale = help.split('\n')[0].replace(' [--cost-state [--projects <dir>]]', '');
    assert.deepEqual(both(readme).map(form => useFaults(form, stale + help.slice(help.indexOf('\n'))).slice(0, 1)), [['§Use: the passage changed'], ['§Use: the passage changed']]);
    assert.deepEqual(both(lf.replace(help.split('\n')[0], () => stale)).map(form => /^the usage lines are not HELP's synopsis once: /m.test(useFaults(form, help).join('\n'))), [true, true]);
    assert.deepEqual(both(lf.replace('never as $0.', () => 'never as $0. The totals match /cost.')).map(form => useFaults(form, help)), [['§Use: the passage changed'], ['§Use: the passage changed']]);
    const planted = ['cost-state', 'agent-progress', 'classifier', 'sub-agents only', '/cost'].map(word => both(lf + '\nThe report reads ' + word + '.\n').map(form => useFaults(form, help)));
    const outside = [['outside §Use: cost-state'], ['outside §Use: agent-progress'], ['outside §Use: classifier'], ['outside §Use: sub-agents only'], ['outside §Use: /cost']];
    assert.deepEqual(planted, outside.map(faults => [faults, faults]));
  };
  const failures = both(read).map(readme => { try { checks(readme); return null; } catch (err) { return err.message; } });
  assert.deepEqual(failures, [null, null], 'every check passes on the LF form and the CRLF form');
});
