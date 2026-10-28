// prompt.mjs renders the seven per-batch prompts from a ledger built here from the REAL
// templates. Each render is compared WHOLE against an oracle written here — the live
// skeleton block, composed and filled from a table of expected values keyed by every slot
// the renderer knows — so a slot bound to the wrong value, a role bound to the wrong block
// or a second substitution pass all go red. Also pinned: the nonce only on the file's last
// line and nowhere a reader could see it without opening the file, and nothing written on
// any refusal.
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');
const { isDeepStrictEqual } = require('node:util');
const ROOT = path.resolve(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const TOOL = path.join(ROOT, 'orchestrate/tools/prompt.mjs');
const SKELETONS = 'orchestrate/references/subagent-prompts.md';
const collapse = text => text.replace(/\s+/g, ' ');
const api = () => import(pathToFileURL(TOOL).href);
const run = (args, cwd = ROOT) => {
  const r = spawnSync(process.execPath, [TOOL, ...args], { cwd, encoding: 'utf8', windowsHide: true, timeout: 60000 });
  assert.ifError(r.error); assert.equal(r.stderr, '');
  return r;
};

// The two stated defaults, written here rather than read from the renderer.
const GUARDRAILS_DEFAULT = 'none recorded; apply general correctness scrutiny to async/lifecycle/state boundaries';
const DUTY_DEFAULT = 'Also, for every new or re-pointed test, name the production mutation that would still pass it.';
// Every role's facts as --help must list them (as sets: --help prints them in slot order).
const ROLE_FACTS = {
  implementer: ['guardrails', 'repoPath', 'reportFile', 'round', 'scratchpadPath', 'worktreePath'],
  polish: ['findingsFile', 'reportFile', 'round', 'subagentTokens'],
  'fix-round': ['findingsFile', 'reportFile', 'round', 'scratchpadPath', 'subagentTokens'],
  rework: ['findingsFile', 'guardrails', 'repoPath', 'reportFile', 'round', 'scratchpadPath', 'worktreePath'],
  reviewer: ['failingOnBase', 'findingsFile', 'gateAgentsRun', 'guardrails', 'repoPath', 'round', 'scratchpadPath', 'worktreePath'],
  'reviewer-round2': ['failingOnBase', 'findingsFile', 'gateAgentsRun', 'guardrails', 'previousFindingsFile', 'repoPath', 'round', 'round1Sha', 'scratchpadPath', 'worktreePath'],
  'test-hunter': ['findingsFile', 'repoPath', 'round', 'scratchpadPath', 'testingGuidePath', 'worktreePath'],
};
const ROLES = Object.keys(ROLE_FACTS);
// Role → the block it renders, written here, independent of the renderer's own table.
const ROLE_BLOCK = { implementer: 'implementer', polish: 'polish', 'fix-round': 'fix-round', rework: 'implementer', reviewer: 'reviewer', 'reviewer-round2': 'reviewer', 'test-hunter': 'test-hunter' };

// Every slot token the renderer knows plus the replacement patterns String.replace would
// honour ($&, $`, $', $$, $1): text any ledger or guardrails file may legitimately quote.
let QUOTING;
test.before(async () => {
  const { SLOTS } = await api();
  QUOTING = Object.keys(SLOTS).join(' ') + " $& $` $' $$ $1";
});

// ===== A ledger filled from the real templates ========================================
const CHANGE_ID = 'PT-20260923-render', LEDGER_DIR = '.agents/changes/' + CHANGE_ID;
const BATCH_GUARDRAILS = 'a guard that samples its domain · quoting `[NN]`';
const values = () => ({
  CHANGE_ID, LEDGER_DIR, SKILL_DIR: 'C:/skill copy/orchestrate', SKILL_SHA256: 'ab'.repeat(32),
  INTEGRATION_BRANCH: 'chore/pt-ledger', WORKTREE_SETUP: 'npm ci --no-audit', MAIN_BRANCH: 'main',
  REPO_CONVENTIONS: '- **Conventions marker.** Keep additions surgical.\n- Quoting: ' + QUOTING,
  EXTRA_PROHIBITIONS: 'Prohibition marker: never touch `vendor/`. ' + QUOTING,
  // A `#` comment inside the fenced recipe looks like a heading to a parser that is not fence-aware.
  VALIDATION_COMMANDS: '```powershell\n# a comment line, not a heading\n# ' + QUOTING + '\nnode --test\n```',
  BATCH_NUM: '01', BATCH_TITLE: 'Render me', BATCH_TYPE: 'feature', BATCH_VERSION: '—', BATCH_BRANCH: 'feat/render-me',
  BATCH_FILES: '`src/a.js`, `tests/a.test.cjs`', BATCH_NEW_FILES: '`tests/a.test.cjs`', BATCH_GUARDRAILS,
});
const fillWith = (text, v) => text.replace(/\{\{([A-Z0-9_]+)\}\}/g, (token, key) => key in v ? v[key] : 'example-' + key.toLowerCase());
const strip = text => text.replace(/<!--[\s\S]*?-->/g, '');
// The conventional-commit type each batch type renders, written here: of the registry's
// `fix`, `feature` and `chore`, only `feature` changes.
const COMMIT_TYPE = { fix: 'fix', feature: 'feat', chore: 'chore' };
// `## Next section` is followed straight away by a HIGHER-level heading, where it must stop.
const guardrailsMd = () => ['# Project', '', '## Bug-class guardrails', '', 'Guardrail marker one.', '', '### A subsection', '',
  'Subsection marker: ' + QUOTING, '', '```bash', '## not a heading inside a fence', '```', '', '## Next section', '', 'Next marker.', '',
  '# Appendix', '', 'Outside marker.', '', '## After the appendix', '', 'After marker.', ''].join('\n');
const guardrailsBody = md => md.slice(md.indexOf('Guardrail marker one.'), md.indexOf('\n\n## Next section'));

function batchFile(v, eol) {
  const quoting = 'This batch quotes, literally: ' + QUOTING;
  const text = fillWith(read('orchestrate/templates/02-batch.md'), v)
    .replace(/(## Implementation notes\n)\n<!--[\s\S]*?-->/, (all, heading) => heading + '\n' + quoting)
    .replace(/(## Checklist\n)/, '$1\n- [ ] Implement it.\n');
  assert.ok(text.includes(quoting), 'the fixture batch file must carry the quoting line');
  return text.replace(/\n/g, eol);
}
function withRow(text, type) {
  const lines = text.split('\n'), head = lines.findIndex(l => l.startsWith('| # | Batch |'));
  assert.notEqual(head, -1);
  const row = '| B01 | Render me | ' + type + ' | M | `feat/render-me` | 1 | `src/a.js`, `tests/a.test.cjs` | C1 | — |';
  return [...lines.slice(0, head + 2), row, ...lines.slice(head + 2)].join('\n');
}
// A contract section as the template lays it out: its heading's body up to the next heading.
function contractBody(contract, heading) {
  const start = contract.indexOf(heading + '\n'); assert.notEqual(start, -1, heading);
  const lines = contract.slice(start + heading.length + 1).split('\n');
  let fenced = false, end = lines.length;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('```')) fenced = !fenced;
    else if (!fenced && /^#{1,6} /.test(lines[i])) { end = i; break; }
  }
  return lines.slice(0, end).join('\n').trim();
}
function fixture(t, { eol = '\n', crlf = false, type = 'feature' } = {}) {
  assert.ok(QUOTING, 'the quoting text is built from the renderer\'s registry before any fixture');
  const v = { ...values(), BATCH_TYPE: type };
  // A CRLF checkout, as this machine's: every file the renderer takes a section from is CRLF.
  const EOL = text => crlf ? text.replace(/\n/g, '\r\n') : text;
  const temp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'prompt render '));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }));
  const ledger = path.join(temp, 'repo', ...LEDGER_DIR.split('/')), worktree = path.join(temp, 'worktree');
  fs.mkdirSync(ledger, { recursive: true }); fs.mkdirSync(worktree);
  const templates = fs.readdirSync(path.join(ROOT, 'orchestrate/templates')).sort();
  assert.deepEqual(templates, ['00-READBEFORE.md', '00-request.md', '01-plan.md', '02-batch.md', 'LOG.md', 'PROGRESS.md'],
    'every shipped template is instantiated below; a new one must join it');
  const tpl = name => fillWith(read('orchestrate/templates/' + name), v);
  const batch = batchFile(v, crlf ? '\r\n' : eol), contract = tpl('00-READBEFORE.md');
  const files = { '00-READBEFORE.md': contract, '00-request.md': strip(tpl('00-request.md')), '01-plan.md': withRow(strip(tpl('01-plan.md')), type),
    'PROGRESS.md': strip(tpl('PROGRESS.md')), 'LOG.md': strip(tpl('LOG.md')) };
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(ledger, name), EOL(text));
  fs.writeFileSync(path.join(ledger, '02-batches-01-render-me.md'), batch);
  const md = guardrailsMd();
  fs.writeFileSync(path.join(worktree, 'CLAUDE.md'), EOL(md));
  const slash = p => p.split(path.sep).join('/');
  const facts = {
    repoPath: 'C:/repo path', worktreePath: slash(worktree), scratchpadPath: slash(path.join(temp, 'scratch')),
    findingsFile: slash(path.join(temp, 'scratch', 'gates', 'f.md')), previousFindingsFile: slash(path.join(temp, 'scratch', 'gates', 'p.md')),
    reportFile: slash(path.join(temp, 'scratch', 'reports', 'r.md')),
    round1Sha: 'abc1234', round: 2, failingOnBase: 'n/a (feature batch)', gateAgentsRun: false, testingGuidePath: 'none',
    guardrails: { file: 'CLAUDE.md', heading: '## Bug-class guardrails' },
    // The resumed implementer's context one token under the fresh-implementer line, so every
    // polish and fix-round render below is the tight case of resuming.
    subagentTokens: 349999,
  };
  // The value every slot must render to, keyed by every slot the renderer knows.
  const conventions = contractBody(contract, '## Repo conventions (binding)');
  assert.equal(conventions, v.REPO_CONVENTIONS, 'the conventions body is exactly the filled block');
  const expected = {
    '[NN]': '01', '[CHANGE_ID]': CHANGE_ID, '[LEDGER_DIR]': LEDGER_DIR, '[SKILL_DIR]': v.SKILL_DIR,
    '[INTEGRATION_BRANCH]': v.INTEGRATION_BRANCH, '[WORKTREE_SETUP]': v.WORKTREE_SETUP, '[BATCH_BRANCH]': v.BATCH_BRANCH,
    '[FENCE FILES]': v.BATCH_FILES, '[BATCH FILENAME]': '02-batches-01-render-me.md', '[TYPE]': COMMIT_TYPE[type],
    '[FULL TEXT OF THE BATCH FILE]': batch, '[APPLICABLE GUARDRAILS FROM THE BATCH FILE]': BATCH_GUARDRAILS,
    // Sections come through as their bytes were read: CRLF inside when the checkout is CRLF.
    '[REPO CONVENTIONS BLOCK FROM THE READBEFORE]': EOL(conventions),
    '[HARD PROHIBITIONS BLOCK FROM THE READBEFORE]': EOL(contractBody(contract, '## Hard prohibitions')),
    '[VALIDATION COMMANDS]': EOL(contractBody(contract, '## Validation commands')),
    '[REPO_PATH]': facts.repoPath, '[WORKTREE_PATH]': facts.worktreePath, '[SCRATCHPAD_PATH]': facts.scratchpadPath,
    '[FINDINGS_FILE]': facts.findingsFile, '[PREVIOUS_FINDINGS_FILE]': facts.previousFindingsFile, '[REPORT_FILE]': facts.reportFile, '[ROUND1_SHA]': facts.round1Sha,
    '[ROUND]': '2', '[FAILING_ON_BASE_RESULT]': facts.failingOnBase, '[TESTING_GUIDE_PATH]': facts.testingGuidePath,
    '[NO GATE AGENT DUTY]': DUTY_DEFAULT, '[GUARDRAILS SECTION TEXT]': EOL(guardrailsBody(md)), '[ROUND 2 BLOCK]': '',
  };
  return { temp, ledger, worktree, out: path.join(temp, 'scratch', 'prompts'), facts, batch, contract, expected };
}
function writeFacts(fx, role, facts) {
  const file = path.join(fx.temp, role + '-facts.json');
  fs.writeFileSync(file, JSON.stringify(facts));
  return file;
}
const listing = dir => fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [];
const pick = (facts, keys) => Object.fromEntries(keys.map(k => [k, facts[k]]));
const PROMPT_LINE = /^PROMPT (\S(?:.*\S)?) NONCE ([0-9a-f]{12})\n$/;
const render = (fx, role, facts, extra = []) =>
  run(['--ledger', fx.ledger, '--role', role, '--batch', 'B01', '--facts', writeFacts(fx, role, facts), '--out', fx.out, ...extra]);

// ===== The oracle ======================================================================
function blocksByName(text) {
  const map = new Map();
  let open = null;
  for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
    if (line.startsWith('```')) {
      if (open) { if (open.name) map.set(open.name, open.lines.join('\n')); open = null; }
      else open = { name: (/^```prompt:(.+)$/.exec(line) || [])[1], lines: [] };
    } else if (open) open.lines.push(line);
  }
  return map;
}
function expectedRender(skeletons, role, table) {
  const blocks = blocksByName(skeletons);
  let text = blocks.get(ROLE_BLOCK[role]);
  assert.ok(text !== undefined, 'the live skeletons hold a block for ' + role);
  if (role === 'reviewer-round2') text = text.split('[ROUND 2 BLOCK]').join(blocks.get('round-2'));
  // Rework: the implementer block with the rework block in place of the lines from its DO line
  // up to, not including, its RULES line.
  if (role === 'rework') {
    const lines = text.split('\n'), from = lines.findIndex(l => l.startsWith('DO:')), to = lines.findIndex(l => l.startsWith('RULES:'));
    assert.ok(from !== -1 && to > from && blocks.has('rework'), 'the live implementer block has a DO paragraph, and a rework block exists');
    text = [...lines.slice(0, from), blocks.get('rework'), ...lines.slice(to)].join('\n');
  }
  const value = slot => { assert.ok(Object.hasOwn(table, slot), 'the oracle has no value for ' + slot); return table[slot]; };
  const kept = text.split('\n').filter(line => { const m = /^\s*(\[[A-Z][A-Z0-9_ -]*\])\s*$/.exec(line); return !(m && value(m[1]) === ''); });
  return kept.join('\n').replace(/\[[A-Z][A-Z0-9_ -]*\]/g, slot => value(slot)) + '\n';
}
// The fixed pointer message, as §Spawning rules publishes it.
function pointer() {
  const found = [...collapse(read(SKELETONS)).matchAll(/`(Your complete instructions are in the file <prompt file>\.[^`]*)`/g)].map(m => m[1]);
  assert.equal(found.length, 1, 'subagent-prompts.md publishes exactly one pointer message');
  return found[0];
}
// One render, checked whole against the oracle, plus everything about the nonce and the file.
function renderedMatches(fx, role, facts, table) {
  const r = render(fx, role, facts);
  assert.equal(r.status, 0, role + ': ' + r.stdout);
  const m = PROMPT_LINE.exec(r.stdout);
  assert.ok(m, role + ': one PROMPT line — ' + JSON.stringify(r.stdout));
  const [, file, nonce] = m;
  const id = new RegExp('^' + CHANGE_ID + '-B01-' + role + '-([0-9a-f]{12})\\.md$').exec(path.basename(file));
  assert.ok(id, role + ': file name ' + path.basename(file));
  assert.notEqual(id[1], nonce, 'the file id is independent of the nonce');
  assert.ok(!file.includes(nonce) && !pointer().includes(nonce), role + ': the nonce is in neither the path nor the pointer');
  assert.equal(path.dirname(path.resolve(file)), path.resolve(fx.out));
  const bytes = fs.readFileSync(file), text = bytes.toString('utf8');
  assert.ok(Buffer.from(text, 'utf8').equals(bytes), role + ': UTF-8 bytes');
  assert.equal(text, expectedRender(read(SKELETONS), role, { ...table, '[NONCE]': nonce }), role + ': the render differs from the oracle');
  assert.equal(text.split(nonce).length - 1, 1, role + ': the nonce occurs exactly once');
  const lines = text.split('\n').filter(l => l.trim());
  assert.equal(lines[lines.length - 1], 'Line 2, directly under line 1: NONCE ' + nonce, role + ': the nonce closes the file');
  return { file, nonce, text };
}

test('--help lists every role with exactly its facts', () => {
  const r = run(['--help']);
  assert.equal(r.status, 0);
  const listed = Object.fromEntries([...r.stdout.matchAll(/^ {2}([a-z0-9-]+): ([A-Za-z0-9, ]+)$/gm)].map(m => [m[1], m[2].split(', ')]));
  assert.deepEqual(Object.keys(listed), ROLES);
  for (const role of ROLES) assert.deepEqual(listed[role].slice().sort(), ROLE_FACTS[role], role);
});

test('every role renders exactly the oracle: each slot its own value, each role its own block, ledger text byte-for-byte', async t => {
  const fx = fixture(t), { SLOTS, BLOCKS, ROLES: roles } = await api();
  // The oracle's table covers the renderer's registry exactly: every slot has a pinned value.
  assert.deepEqual(Object.keys(fx.expected).concat('[NONCE]').sort(), Object.keys(SLOTS).sort());
  assert.equal(Object.keys(SLOTS).length, 29, 'the registry size is pinned; a new slot needs an oracle value');
  // Each role is bound to its own block, and the blocks are exactly those the roles use.
  assert.deepEqual(Object.fromEntries(Object.entries(roles).map(([role, spec]) => [role, spec.block])), ROLE_BLOCK);
  assert.deepEqual([...new Set(Object.values(roles).flatMap(s => [s.block, s.compose, s.replaceDo].filter(Boolean)))].sort(), BLOCKS.slice().sort());
  // Distinct values, so a slot bound to another slot's value cannot render the same text.
  const scalar = Object.entries(fx.expected).filter(([, value]) => value !== '');
  assert.equal(new Set(scalar.map(([, value]) => value)).size, scalar.length, 'every expected value is distinct');
  const seen = new Set();
  for (const role of ROLES) {
    const { nonce, text } = renderedMatches(fx, role, pick(fx.facts, ROLE_FACTS[role]), fx.expected);
    seen.add(nonce);
    if (ROLE_BLOCK[role] === 'implementer' || ROLE_BLOCK[role] === 'reviewer') {
      // The registry-wide quoting text reaches the file through every inserted section, unchanged.
      assert.ok(text.split(QUOTING).length - 1 >= 3, role + ': the quoting text passes through each inserted section');
    }
  }
  assert.equal(seen.size, ROLES.length, 'every render drew its own nonce');
  assert.equal(listing(fx.out).length, ROLES.length);
});

// The contract template slimmed to repo facts (B01 of OS-20260925) must still feed the
// unmodified renderer every line it parses, and the ledger built from it must still parse.
test('the slimmed contract, every placeholder filled, renders every role and its fixture ledger parses', t => {
  const fx = fixture(t);
  const keys = [...new Set([...read('orchestrate/templates/00-READBEFORE.md').matchAll(/\{\{([A-Z0-9_]+)\}\}/g)].map(m => m[1]))];
  assert.ok(keys.length > 20 && keys.includes('SKILL_SOURCE') && keys.includes('WORKTREE_SETUP'), 'the whole placeholder set: ' + keys.join(' '));
  assert.doesNotMatch(fx.contract, /\{\{|\}\}/, 'every placeholder of the template is given a value');
  for (const role of ROLES) {
    const { text } = renderedMatches(fx, role, pick(fx.facts, ROLE_FACTS[role]), fx.expected);
    if (role === 'implementer') {
      // The Git model facts reach the prompt: the integration branch and the per-worktree setup.
      assert.ok(text.includes(fx.expected['[INTEGRATION_BRANCH]']) && text.includes(fx.expected['[WORKTREE_SETUP]']));
    }
  }
  // The fixture ledger, completed with the PROGRESS row the scaffolder writes, passes the real parse.
  const progress = path.join(fx.ledger, 'PROGRESS.md');
  const lines = fs.readFileSync(progress, 'utf8').split('\n');
  const head = lines.findIndex(l => l.startsWith('| # | Batch | Branch |'));
  assert.notEqual(head, -1, 'the PROGRESS batch table');
  lines.splice(head + 2, 0, '| B01 | Render me | `feat/render-me` | 1 | — | ⬜ | 2026-09-26 | — |');
  fs.writeFileSync(progress, lines.join('\n'));
  const parse = spawnSync(process.execPath, [path.join(ROOT, 'orchestrate/tools/check-ledger.mjs'), 'parse', '--dir', fx.ledger],
    { encoding: 'utf8', windowsHide: true, timeout: 60000 });
  assert.ifError(parse.error);
  assert.equal(parse.stdout, 'PARSE OK 1 batches\n', parse.stderr); assert.equal(parse.status, 0);
  // Control: the one Git model line the renderer takes the integration branch from, reworded,
  // and the render refuses — so the renders above rested on the slimmed contract's own lines.
  const contractPath = path.join(fx.ledger, '00-READBEFORE.md'), filled = fs.readFileSync(contractPath, 'utf8');
  const reworded = filled.replace('Integration branch: `' + fx.expected['[INTEGRATION_BRANCH]'] + '`', 'Integration: `' + fx.expected['[INTEGRATION_BRANCH]'] + '`');
  assert.notEqual(reworded, filled, 'the control must reword the Git model line');
  fs.writeFileSync(contractPath, reworded);
  const refused = render(fx, 'implementer', pick(fx.facts, ROLE_FACTS.implementer));
  assert.equal(refused.stdout, 'UNKNOWN the Git model integration branch: expected exactly one, found 0\n'); assert.equal(refused.status, 2);
  // Only the label the renderer reads can refuse it: a repeated Shipment ref label renders the
  // oracle, a repeated Integration branch label is refused with the count, as before gitModel.
  const shipment = filled.replace('Shipment ref: `', 'Shipment ref: `twice`. Shipment ref: `');
  assert.notEqual(shipment, filled, 'the control must repeat the Shipment ref label');
  fs.writeFileSync(contractPath, shipment);
  renderedMatches(fx, 'implementer', pick(fx.facts, ROLE_FACTS.implementer), fx.expected);
  for (const n of [2, 3]) {
    const repeated = filled.replace('Integration branch: `', 'Integration branch: `again`. '.repeat(n - 1) + 'Integration branch: `');
    assert.equal(repeated.split('Integration branch: `').length - 1, filled.split('Integration branch: `').length - 1 + n - 1, 'the control must repeat the label');
    fs.writeFileSync(contractPath, repeated);
    const refusedRepeated = render(fx, 'implementer', pick(fx.facts, ROLE_FACTS.implementer));
    assert.equal(refusedRepeated.stdout, 'UNKNOWN the Git model integration branch: expected exactly one, found ' + n + '\n'); assert.equal(refusedRepeated.status, 2);
  }
});

test('the batch type becomes a conventional-commit type: feature renders feat, fix and chore pass through', async t => {
  const { COMMIT_TYPES } = await api();
  assert.deepEqual(COMMIT_TYPES, { feature: 'feat' });
  // The domain is the placeholder registry's list of batch types, read from the checkout.
  const rows = read('orchestrate/references/scaffolding.md').split('\n').filter(l => l.startsWith('| `{{BATCH_TYPE}}` |'));
  assert.equal(rows.length, 1, 'one {{BATCH_TYPE}} registry row');
  const types = [...rows[0].split('|')[3].matchAll(/`([a-z]+)`/g)].map(m => m[1]);
  assert.deepEqual(types.slice().sort(), Object.keys(COMMIT_TYPE).sort(), 'every registry batch type has its commit type pinned here');
  for (const type of types) {
    const fx = fixture(t, { type });
    const { text } = renderedMatches(fx, 'implementer', pick(fx.facts, ROLE_FACTS.implementer), fx.expected);
    assert.ok(text.includes('("' + COMMIT_TYPE[type] + ': <summary> (batch 01)")'), type + ' must render ' + COMMIT_TYPE[type]);
  }
});

test('a CRLF ledger and a CRLF guardrails file render the oracle, each section as its bytes were read', t => {
  const fx = fixture(t, { crlf: true });
  assert.ok(fs.readFileSync(path.join(fx.ledger, '00-READBEFORE.md'), 'utf8').includes('\r\n## Repo conventions (binding)\r\n'), 'the contract is CRLF');
  assert.ok(fs.readFileSync(path.join(fx.worktree, 'CLAUDE.md'), 'utf8').includes('\r\n## Bug-class guardrails\r\n'), 'the guardrails file is CRLF');
  for (const slot of ['[REPO CONVENTIONS BLOCK FROM THE READBEFORE]', '[HARD PROHIBITIONS BLOCK FROM THE READBEFORE]', '[VALIDATION COMMANDS]',
    '[GUARDRAILS SECTION TEXT]', '[FULL TEXT OF THE BATCH FILE]']) {
    assert.ok(fx.expected[slot].includes('\r\n'), slot + ' spans lines, so the CRLF checkout reaches it');
  }
  for (const role of ['implementer', 'reviewer']) renderedMatches(fx, role, pick(fx.facts, ROLE_FACTS[role]), fx.expected);
});

test('a guardrails section stops at the next heading of the same or a HIGHER level', t => {
  const fx = fixture(t);
  // `## Next section` runs straight into `# Appendix`; a stop only at the same level would run on to `## After the appendix`.
  renderedMatches(fx, 'reviewer', { ...pick(fx.facts, ROLE_FACTS.reviewer), guardrails: { file: 'CLAUDE.md', heading: '## Next section' } },
    { ...fx.expected, '[GUARDRAILS SECTION TEXT]': 'Next marker.' });
});

test('ledger text in a CRLF batch file comes through byte-for-byte and is not refused', t => {
  const fx = fixture(t, { eol: '\r\n' });
  assert.ok(fx.batch.includes('\r\n') && fx.batch.includes(QUOTING));
  const { text } = renderedMatches(fx, 'implementer', pick(fx.facts, ROLE_FACTS.implementer), fx.expected);
  assert.ok(text.includes(fx.batch));
});

test('round 1 renders, and the guardrails "none" and gateAgentsRun true defaults render as stated', async t => {
  const fx = fixture(t);
  renderedMatches(fx, 'reviewer', { ...pick(fx.facts, ROLE_FACTS.reviewer), round: 1 }, { ...fx.expected, '[ROUND]': '1' });
  const fix = renderedMatches(fx, 'fix-round', { ...pick(fx.facts, ROLE_FACTS['fix-round']), round: 1 }, { ...fx.expected, '[ROUND]': '1' });
  assert.ok(fix.text.includes('("fix: batch 01 round 1 — <summary>")'));
  const none = renderedMatches(fx, 'reviewer', { ...pick(fx.facts, ROLE_FACTS.reviewer), guardrails: 'none', gateAgentsRun: true },
    { ...fx.expected, '[GUARDRAILS SECTION TEXT]': GUARDRAILS_DEFAULT, '[NO GATE AGENT DUTY]': '' });
  assert.match(none.text, /or say that none does\.\n6\. /, 'the duty line is dropped, not left blank');
  // The defaults the test states are the renderer's and the skeleton prose's.
  const { DEFAULTS } = await api(), prose = collapse(read(SKELETONS));
  assert.deepEqual(DEFAULTS, { guardrails: GUARDRAILS_DEFAULT, noGateAgentDuty: DUTY_DEFAULT });
  for (const value of Object.values(DEFAULTS)) assert.ok(prose.includes(value), 'subagent-prompts.md must state the default: ' + value);
  const missing = render(fx, 'reviewer', { ...pick(fx.facts, ROLE_FACTS.reviewer), guardrails: { file: 'CLAUDE.md', heading: '## No such heading' } });
  assert.equal(missing.stdout, 'UNKNOWN CLAUDE.md: no heading line "## No such heading"\n'); assert.equal(missing.status, 2);
});

test('a missing fact is UNKNOWN UNFILLED with nothing written, for every fact of every role', async t => {
  const fx = fixture(t), { promptCli, SLOTS } = await api();
  // The published form of the checkpoint's step 10, run as a command.
  const { worktreePath, ...rest } = pick(fx.facts, ROLE_FACTS.implementer);
  assert.ok(worktreePath);
  const r = render(fx, 'implementer', rest);
  assert.equal(r.stdout, 'UNKNOWN UNFILLED [WORKTREE_PATH]\n'); assert.equal(r.status, 2);
  let cases = 0;
  for (const role of ROLES) for (const key of ROLE_FACTS[role]) {
    const facts = pick(fx.facts, ROLE_FACTS[role]); delete facts[key];
    const out = promptCli(['--ledger', fx.ledger, '--role', role, '--batch', 'B01', '--facts', writeFacts(fx, role, facts), '--out', fx.out]);
    // The one fact no slot carries is named by its key.
    if (key === 'subagentTokens') { assert.deepEqual(out, { code: 2, line: 'UNKNOWN UNFILLED subagentTokens' }, role + ' without ' + key); cases++; continue; }
    const m = /^UNKNOWN UNFILLED (\[[A-Z][A-Z0-9_ -]*\])$/.exec(out.line);
    assert.ok(m, role + ' without ' + key + ': ' + out.line); assert.equal(out.code, 2);
    const entry = SLOTS[m[1]];
    assert.ok(entry.fact === key || (entry.also || []).includes(key), role + ' without ' + key + ' names ' + m[1] + ', a slot of another fact');
    cases++;
  }
  assert.equal(cases, Object.values(ROLE_FACTS).reduce((n, keys) => n + keys.length, 0));
  assert.deepEqual(listing(fx.out), [], 'nothing written');
});

const GUARDRAILS_SHAPE = 'fact guardrails: expected "none" or { "file": "<worktree-relative path>", "heading": "<exact heading line>" }';
test('unknown, foreign and ill-typed facts, and bad invocations, are UNKNOWN with nothing written — one case per check', t => {
  const fx = fixture(t), base = pick(fx.facts, ROLE_FACTS['reviewer-round2']);
  const impl = pick(fx.facts, ROLE_FACTS.implementer);
  const cases = [
    ['implementer', { ...impl, bogus: 'x' }, 'fact bogus is not one role implementer uses (see --help)'],
    ['implementer', { ...impl, round1Sha: 'abc1234' }, 'fact round1Sha is not one role implementer uses (see --help)'],
    ['reviewer-round2', { ...base, gateAgentsRun: 'no' }, 'fact gateAgentsRun: expected true or false'],
    ['reviewer-round2', { ...base, round: 0 }, 'fact round: expected a positive integer'],
    ['reviewer-round2', { ...base, round: '1' }, 'fact round: expected a positive integer'],
    ['reviewer-round2', { ...base, round1Sha: 'XYZ1234' }, 'fact round1Sha: expected a lowercase hex commit id'],
    ['reviewer-round2', { ...base, findingsFile: '   ' }, 'fact findingsFile: expected a non-empty one-line string'],
    ['reviewer-round2', { ...base, findingsFile: 'two\nlines' }, 'fact findingsFile: expected a non-empty one-line string'],
    ['reviewer-round2', { ...base, guardrails: { file: '../CLAUDE.md', heading: '## Bug-class guardrails' } }, GUARDRAILS_SHAPE],
    ['reviewer-round2', { ...base, guardrails: { file: 'CLAUDE.md', heading: '## Bug-class guardrails', extra: 1 } }, GUARDRAILS_SHAPE],
    ['reviewer-round2', { ...base, guardrails: { file: 'CLAUDE.md', heading: 'Bug-class guardrails' } }, GUARDRAILS_SHAPE],
    ['reviewer-round2', [], 'facts must be one JSON object'],
  ];
  for (const [role, facts, expected] of cases) {
    const r = render(fx, role, facts);
    assert.equal(r.stdout, 'UNKNOWN ' + expected + '\n', JSON.stringify(facts)); assert.equal(r.status, 2);
  }
  const factsFile = writeFacts(fx, 'implementer', impl);
  for (const [args, expected] of [
    [['--ledger', fx.ledger, '--role', 'closer', '--batch', 'B01', '--facts', factsFile, '--out', fx.out], /^UNKNOWN unknown role closer/],
    [['--ledger', fx.ledger, '--role', 'implementer', '--batch', 'B02', '--facts', factsFile, '--out', fx.out], /^UNKNOWN 0 batch files 02-batches-02-\*\.md/],
    [['--ledger', fx.ledger, '--role', 'implementer', '--batch', 'B01', '--facts', factsFile], /^UNKNOWN usage/],
    [['--ledger', fx.ledger, '--role', 'implementer', '--batch', 'B01', '--facts', factsFile, '--out', fx.out, '--nonce', 'x'], /^UNKNOWN usage/],
  ]) {
    const r = run(args);
    assert.match(r.stdout, expected); assert.equal(r.status, 2);
    assert.equal(r.stdout.split('\n').length, 2, 'one line');
  }
  assert.deepEqual(listing(fx.out), []);
});

test('every string fact, every hidden-character class and both commit-id bounds are checked', async t => {
  const fx = fixture(t), { promptCli } = await api();
  const cli = (role, facts) => promptCli(['--ledger', fx.ledger, '--role', role, '--batch', 'B01', '--facts', writeFacts(fx, role, facts), '--out', fx.out]);
  // The string facts are every fact but the five typed ones, derived from the pinned role table.
  const TYPED = ['gateAgentsRun', 'guardrails', 'round', 'round1Sha', 'subagentTokens'];
  const strings = [...new Set(Object.values(ROLE_FACTS).flat())].filter(key => !TYPED.includes(key)).sort();
  assert.deepEqual(strings, ['failingOnBase', 'findingsFile', 'previousFindingsFile', 'repoPath', 'reportFile', 'scratchpadPath', 'testingGuidePath', 'worktreePath']);
  const roleOf = key => ROLES.find(role => ROLE_FACTS[role].includes(key));
  const ONE_LINE = key => ({ code: 2, line: 'UNKNOWN fact ' + key + ': expected a non-empty one-line string' });
  for (const key of strings) {
    for (const value of ['', '   ', 'two' + String.fromCharCode(10) + 'lines', 42, null, ['x'], { x: 1 }]) {
      const role = roleOf(key);
      assert.deepEqual(cli(role, { ...pick(fx.facts, ROLE_FACTS[role]), [key]: value }), ONE_LINE(key), role + ': ' + key + ' = ' + JSON.stringify(value));
    }
  }
  // One character from each hidden class — C0 at both ends and a tab, DEL, C1 at both ends, both
  // separators — is refused; the code point just outside each range is not (U+00A0, the no-break
  // space, is the C1 range's upper neighbour: outside the renderer's hidden classes).
  const named = code => 'gates/a' + String.fromCharCode(code) + 'b.md';
  for (const code of [0x00, 0x09, 0x1f, 0x7f, 0x85, 0x9f, 0x2028, 0x2029]) {
    assert.deepEqual(cli('polish', { ...pick(fx.facts, ROLE_FACTS.polish), findingsFile: named(code) }), ONE_LINE('findingsFile'), 'U+' + code.toString(16) + ' is hidden');
  }
  const heading = cli('reviewer', { ...pick(fx.facts, ROLE_FACTS.reviewer), guardrails: { file: 'CLAUDE.md', heading: '## Bug-class' + String.fromCharCode(0x2028) + 'guardrails' } });
  assert.deepEqual(heading, { code: 2, line: 'UNKNOWN ' + GUARDRAILS_SHAPE }, 'a hidden character in the guardrails heading');
  assert.deepEqual(listing(fx.out), [], 'no refusal wrote a file');
  for (const code of [0x20, 0x7e, 0xa0, 0x2027]) {
    const out = cli('polish', { ...pick(fx.facts, ROLE_FACTS.polish), findingsFile: named(code) });
    assert.equal(out.code, 0, 'U+' + code.toString(16) + ' lies outside the hidden classes and is accepted: ' + out.line);
  }
  // round1Sha: seven to sixty-four lowercase hex digits, each bound pinned from both sides.
  for (const [sha, ok] of [['abc123', false], ['abc1234', true], ['a'.repeat(64), true], ['a'.repeat(65), false]]) {
    const out = cli('reviewer-round2', { ...pick(fx.facts, ROLE_FACTS['reviewer-round2']), round1Sha: sha });
    if (ok) assert.equal(out.code, 0, sha.length + ' hex digits are a commit id: ' + out.line);
    else assert.deepEqual(out, { code: 2, line: 'UNKNOWN fact round1Sha: expected a lowercase hex commit id' }, sha.length + ' hex digits are not');
  }
  assert.equal(listing(fx.out).length, 6, 'the six accepted renders, and nothing else, wrote a file');
});

test('two renders draw two nonces and two files', t => {
  const fx = fixture(t), facts = pick(fx.facts, ROLE_FACTS.polish);
  const a = PROMPT_LINE.exec(render(fx, 'polish', facts).stdout), b = PROMPT_LINE.exec(render(fx, 'polish', facts).stdout);
  assert.ok(a && b);
  assert.notEqual(a[2], b[2]); assert.notEqual(a[1], b[1]);
  assert.equal(listing(fx.out).length, 2);
});

// ===== The fresh-implementer line ======================================================
// A role that resumes an implementer takes that implementer's context, the `subagent_tokens` of
// its last task notification, as fact subagentTokens. The line is 350000 tokens, written here, not
// read from the renderer: below it the role renders; at it and past it the renderer writes nothing,
// exits 1 and prints one FRESH line naming the route §Spawning rules gives that role's crash respawn.
const FRESH_LINE = 350000;
const FRESH_ROUTE = {
  polish: 'spawn a fresh implementer with its rendered implementer prompt first, then the polish pointer',
  'fix-round': 'spawn a fresh implementer with its rendered rework prompt',
};
const freshLine = (role, tokens) => 'FRESH subagentTokens ' + tokens + ' is at or past 350000: ' + FRESH_ROUTE[role] + '\n';
test('polish and fix-round render below 350000 tokens, and at it or past it write nothing and print one FRESH line naming the fresh route', async t => {
  const fx = fixture(t), { FRESH_AT, TOKENS_FACT, ROLES: roles } = await api();
  assert.deepEqual([FRESH_AT, TOKENS_FACT], [FRESH_LINE, 'subagentTokens']);
  // The resuming roles are exactly those taking the fact, in the renderer's table and in --help's.
  assert.deepEqual(Object.keys(roles).filter(role => roles[role].fresh), Object.keys(FRESH_ROUTE));
  assert.deepEqual(ROLES.filter(role => ROLE_FACTS[role].includes('subagentTokens')), Object.keys(FRESH_ROUTE));
  // Each route is the crash respawn §Spawning rules states for an implementer owed that pass.
  const rules = collapse(read(SKELETONS)).replace(/`/g, '');
  for (const [role, owed] of [['fix-round', 'an implementer owed a fix round '], ['polish', 'one owed a polish pass ']]) {
    assert.ok(rules.includes(owed + FRESH_ROUTE[role].replace('spawn a fresh implementer ', '')), role + ': the route is the crash respawn\'s');
  }
  const got = {}, want = {};
  for (const role of Object.keys(FRESH_ROUTE)) {
    const facts = tokens => ({ ...pick(fx.facts, ROLE_FACTS[role]), subagentTokens: tokens });
    // Below the line: a small context and the last token under it render the oracle.
    for (const tokens of [1, FRESH_LINE - 1]) renderedMatches(fx, role, facts(tokens), fx.expected);
    const before = listing(fx.out);
    // The line itself (inclusive), one past it, B08's 404,572 and B06's 813K: FRESH, exit 1.
    for (const tokens of [FRESH_LINE, FRESH_LINE + 1, 404572, 813000]) {
      const r = render(fx, role, facts(tokens));
      got[role + ' ' + tokens] = { status: r.status, stdout: r.stdout };
      want[role + ' ' + tokens] = { status: 1, stdout: freshLine(role, tokens) };
    }
    assert.deepEqual(listing(fx.out), before, role + ': no FRESH line wrote a file');
  }
  assert.deepEqual(got, want);
});

test('subagentTokens: missing is UNKNOWN UNFILLED, no positive integer is UNKNOWN, and no other role takes it — nothing written', t => {
  const fx = fixture(t), got = [], want = [];
  for (const role of Object.keys(FRESH_ROUTE)) {
    const { subagentTokens, ...rest } = pick(fx.facts, ROLE_FACTS[role]);
    assert.equal(subagentTokens, FRESH_LINE - 1);
    got.push([role, 'missing', render(fx, role, rest).stdout]); want.push([role, 'missing', 'UNKNOWN UNFILLED subagentTokens\n']);
    // A value that is no positive integer is refused, never read as zero or as past the line.
    for (const value of [0, -1, -404572, 0.5, 349999.5, 404572.5, '404572', '349999', null, true, [404572], { tokens: 404572 }]) {
      const r = render(fx, role, { ...rest, subagentTokens: value });
      got.push([role, value, r.stdout, r.status]); want.push([role, value, 'UNKNOWN fact subagentTokens: expected a positive integer\n', 2]);
    }
  }
  // Every other role refuses the fact, so a fresh implementer's prompt is never given one.
  for (const role of ROLES.filter(role => !Object.hasOwn(FRESH_ROUTE, role))) {
    got.push([role, 'foreign', render(fx, role, { ...pick(fx.facts, ROLE_FACTS[role]), subagentTokens: 404572 }).stdout]);
    want.push([role, 'foreign', 'UNKNOWN fact subagentTokens is not one role ' + role + ' uses (see --help)\n']);
  }
  assert.deepEqual(got, want);
  assert.deepEqual(listing(fx.out), [], 'no refusal wrote a file');
});

test('--help states the FRESH line, its exit code and the subagentTokens fact, and each exit code is the one the tool returns', t => {
  const fx = fixture(t), help = run(['--help']).stdout.split('\n');
  const at = help.indexOf('Renders one per-batch prompt to <out>/<CHANGE_ID>-B<NN>-<role>-<id>.md and prints ONE line:');
  assert.deepEqual(help.slice(at + 1, at + 4), [
    '  PROMPT <path> NONCE <nonce>  |  FRESH <route>  |  UNKNOWN <reason> (UNKNOWN UNFILLED <slot> when a slot has no value,',
    '  UNKNOWN UNFILLED subagentTokens without that fact; on FRESH and UNKNOWN nothing is written)',
    'Exit 0 PROMPT; 1 FRESH; 2 UNKNOWN. The nonce is only in the file, on its last line. --skeletons defaults to']);
  const facts = help.indexOf('round, subagentTokens: positive integers; round1Sha: a hex commit id; every other fact: a one-line string.');
  assert.notEqual(facts, -1, 'the typed facts line');
  assert.deepEqual(help.slice(facts + 1, facts + 3), [
    "subagentTokens is the resumed implementer's subagent_tokens in its last task notification; at or past 350000",
    "the line is FRESH <route>, naming the fresh implementer that takes the role's work instead."]);
  const stated = Object.fromEntries([...help[at + 3].matchAll(/(\d) (PROMPT|FRESH|UNKNOWN)\b/g)].map(m => [m[2], Number(m[1])]));
  const role = 'fix-round', facts1 = pick(fx.facts, ROLE_FACTS[role]);
  const observed = { PROMPT: render(fx, role, facts1).status, FRESH: render(fx, role, { ...facts1, subagentTokens: FRESH_LINE }).status,
    UNKNOWN: render(fx, role, { ...facts1, subagentTokens: 0 }).status };
  assert.deepEqual(stated, observed, 'the exit codes --help states are the ones the tool returns');
  assert.deepEqual(observed, { PROMPT: 0, FRESH: 1, UNKNOWN: 2 });
});

// ===== Registry ↔ prose, both directions ================================================
// Computed from the live skeletons with a parse of this test's own, looser than the
// renderer's: any `[` + capital up to the next `]`, across lines, so an irregular slot is
// seen too.
function liveSlots(text) {
  const blocks = [], lines = text.replace(/\r\n/g, '\n').split('\n');
  let open = null;
  for (const line of lines) {
    if (line.startsWith('```')) { if (open) { blocks.push(open); open = null; } else open = { info: line.slice(3), body: [] }; }
    else if (open) open.body.push(line);
  }
  assert.equal(open, null, 'balanced fences');
  const scoped = blocks.filter(b => b.info.startsWith('prompt:'));
  return { names: scoped.map(b => b.info.slice(7)), slots: [...new Set(scoped.flatMap(b => [...b.body.join('\n').matchAll(/\[[A-Z][^\[\]]*\]/g)].map(m => m[0])))].sort() };
}
const drift = (live, registry) => ({ unknown: live.filter(s => !registry.includes(s)), unused: registry.filter(s => !live.includes(s)) });

test('the renderer knows exactly the slots of the live in-scope skeletons, in both directions', async () => {
  const { SLOTS, BLOCKS } = await api(), registry = Object.keys(SLOTS).sort(), skeletons = read(SKELETONS);
  const live = liveSlots(skeletons);
  assert.deepEqual(live.names.slice().sort(), BLOCKS.slice().sort(), 'the in-scope blocks are the renderer\'s blocks');
  assert.ok(live.slots.length >= 20, 'the live slot set was actually read');
  assert.deepEqual(drift(live.slots, registry), { unknown: [], unused: [] });
  // Controls: a slot planted in a block, and a registry slot removed from every block, each show as drift.
  const planted = skeletons.replace('You are the IMPLEMENTER for batch B[NN]', 'You are the IMPLEMENTER [PLANTED SLOT] for batch B[NN]');
  assert.notEqual(planted, skeletons, 'the planted-slot anchor must exist');
  assert.deepEqual(drift(liveSlots(planted).slots, registry), { unknown: ['[PLANTED SLOT]'], unused: [] });
  const removed = skeletons.split('[ROUND1_SHA]').join('abc1234');
  assert.notEqual(removed, skeletons, 'the removal anchor must exist');
  assert.deepEqual(drift(liveSlots(removed).slots, registry), { unknown: [], unused: ['[ROUND1_SHA]'] });
});

// Every refusal the renderer makes about the skeleton itself, planted in a copy: each must
// name its reason exactly and write nothing, and the unaltered copy must render.
test('every skeleton refusal is reached by a planted copy, with its own message and nothing written', t => {
  const fx = fixture(t), skeletons = read(SKELETONS);
  const withSkeletons = (text, role, facts = pick(fx.facts, ROLE_FACTS[role])) => {
    const file = path.join(fx.temp, 'skeletons.md'); fs.writeFileSync(file, text);
    return render(fx, role, facts, ['--skeletons', file]);
  };
  const plant = (from, to) => { const text = skeletons.split(from).join(to); assert.notEqual(text, skeletons, 'anchor must exist: ' + from); return text; };
  const NONCE_LINE = 'Line 2, directly under line 1: NONCE [NONCE]';
  const cases = [
    ['implementer', plant('You are the IMPLEMENTER for batch B[NN]', 'You are the IMPLEMENTER [PLANTED SLOT] for batch B[NN]'), 'UNFILLED [PLANTED SLOT]'],
    ['implementer', plant('- Project guardrails: [GUARDRAILS SECTION TEXT]', '- Project guardrails: [GUARDRAILS SECTION TEXT or "none"]'),
      'irregular slot in the implementer skeleton: [GUARDRAILS SECTION TEXT or "none"]'],
    // The ONE nonce line moved above the report, not a second one added: only the last-line rule refuses it.
    ['implementer', plant('line 4 the path [REPORT_FILE].\n' + NONCE_LINE + '\n```\n\nMain-checkout', 'line 4 the path [REPORT_FILE].\n```\n\nMain-checkout')
      .replace('REPORT (fixed shape — the orchestrator acts on nothing else):\n', () => 'REPORT (fixed shape — the orchestrator acts on nothing else):\n' + NONCE_LINE + '\n'),
    'the implementer skeleton must carry [NONCE] once, on its last line'],
    ['polish', skeletons + '\n```prompt:polish\nA second polish block.\n```\n', 'skeleton block polish occurs twice'],
    ['polish', skeletons + '\n```prompt:stray\nnever closed\n', 'unbalanced code fence in the skeletons'],
    ['polish', plant('```prompt:polish\n', '```prompt:polished\n'), 'no ```prompt:polish block in the skeletons'],
    ['reviewer-round2', plant('```prompt:round-2\n', '```prompt:round-3\n'), 'no ```prompt:round-2 block in the skeletons'],
    ['reviewer-round2', plant('same commit.\n[ROUND 2 BLOCK]\n', 'same commit.\n'), '[ROUND 2 BLOCK] must occur once in the reviewer block'],
  ];
  for (const [role, text, reason] of cases) {
    const r = withSkeletons(text, role);
    assert.equal(r.stdout, 'UNKNOWN ' + reason + '\n', reason); assert.equal(r.status, 2);
  }
  assert.deepEqual(listing(fx.out), [], 'no refusal wrote a file');
  // A skeleton whose guardrails slot has no [WORKTREE_PATH] beside it still takes, and
  // still needs, the worktree the guardrails file is read from.
  const noWorktreeSlot = plant('Work in your isolated worktree at [WORKTREE_PATH], already', 'Work in your isolated worktree, already');
  const { worktreePath, ...withoutWorktree } = pick(fx.facts, ROLE_FACTS.implementer);
  assert.ok(worktreePath);
  const missing = withSkeletons(noWorktreeSlot, 'implementer', withoutWorktree);
  assert.equal(missing.stdout, 'UNKNOWN UNFILLED [GUARDRAILS SECTION TEXT]\n'); assert.equal(missing.status, 2);
  assert.equal(withSkeletons(noWorktreeSlot, 'implementer').status, 0, 'the worktree fact is accepted for the guardrails read');
  assert.equal(withSkeletons(skeletons, 'implementer').status, 0, 'the unaltered copy renders, so the refusals above are the plants');
  assert.equal(listing(fx.out).length, 2);
});

// ===== Role rework: the implementer prompt with the rework block for its DO paragraph ===
// Checked against the implementer's own render, not only the oracle: the lines before the DO
// line and from the RULES line on (REPORT and the one nonce line included) are the
// implementer's; only the DO paragraph differs. expectedRender reads the live block, so the
// block's wording is held by REWORK_BLOCK, pinned whole with whitespace collapsed, like BUDGET and
// PINNED in tests/tool-wiring.test.cjs.
const REWORK_BLOCK = 'DO: your batch is already built on your batch branch; do not redo it. The findings file [FINDINGS_FILE] lists what to fix: read it first, then what it cites and what its fixes need. '
  + 'Fix each finding, tick nothing new, run the validation commands; before committing run `git diff --name-status -M [INTEGRATION_BRANCH]...HEAD` plus `git status --porcelain` and revert anything outside your fence; '
  + 'commit on your batch branch ("fix: batch [NN] round [ROUND] — <summary>").';
test('rework renders the implementer prompt with the rework block for its DO paragraph, findings file and round filled', t => {
  const fx = fixture(t), rework = blocksByName(read(SKELETONS)).get('rework');
  assert.ok(rework && !rework.includes('[NONCE]') && rework.includes('[FINDINGS_FILE]') && rework.includes('[ROUND]'), 'the rework block fills the findings file and round, and carries no nonce');
  const pinned = text => collapse(blocksByName(text).get('rework') || '').trim();
  assert.equal(pinned(read(SKELETONS)), REWORK_BLOCK, SKELETONS + ': the rework block changed; update REWORK_BLOCK only on purpose');
  // Live controls: one sentence planted inside the block, just after its opening fence or just before its closing one, reddens the pin.
  for (const [at, planted] of [['```prompt:rework\n', '```prompt:rework\nSkip it when in a hurry.\n'], ['— <summary>").\n```\n\n**Authorized third round**', '— <summary>"). Skip it when in a hurry.\n```\n\n**Authorized third round**']]) {
    const text = read(SKELETONS);
    assert.equal(text.split(at).length - 1, 1, 'the control anchor must occur once: ' + at);
    assert.notEqual(pinned(text.replace(at, () => planted)), REWORK_BLOCK, 'a planted sentence must redden the pin: ' + planted);
  }
  const own = renderedMatches(fx, 'rework', pick(fx.facts, ROLE_FACTS.rework), fx.expected);
  const impl = renderedMatches(fx, 'implementer', pick(fx.facts, ROLE_FACTS.implementer), fx.expected);
  // Head, DO paragraph, tail: cut at the last DO line and the last RULES line, both after the batch text.
  const cut = ({ text, nonce }) => {
    const d = text.lastIndexOf('\nDO: '), r = text.lastIndexOf('\nRULES: ');
    assert.ok(d !== -1 && r > d, 'a DO line before a RULES line');
    return [text.slice(0, d), text.slice(d, r), text.slice(r).split(nonce).join('<nonce>')];
  };
  const [head, body, tail] = cut(own), [implHead, implBody, implTail] = cut(impl);
  assert.equal(head, implHead, 'everything before the DO paragraph is the implementer\'s');
  assert.equal(tail, implTail, 'RULES, REPORT and the nonce line are the implementer\'s');
  assert.notEqual(body, implBody, 'the DO paragraph is replaced');
  assert.ok(!own.text.includes('DO: implement each checklist item'), 'the implementer\'s DO paragraph is gone');
  assert.ok(body.startsWith('\nDO: your batch is already built on your batch branch; do not redo it.'), 'the rework block stands in its place');
  assert.ok(body.includes(fx.facts.findingsFile + ' lists what to fix') && body.includes('("fix: batch 01 round 2 — <summary>")'), 'the findings file and the round are filled');
  assert.ok(body.includes('`git diff --name-status -M ' + fx.expected['[INTEGRATION_BRANCH]'] + '...HEAD` plus `git status --porcelain`'), 'the pre-commit fence check is kept');
});

test('rework refuses, writing nothing, unless the implementer block holds one DO line before one RULES line, each anchor on its own', t => {
  const fx = fixture(t), skeletons = read(SKELETONS);
  const withSkeletons = (text, role) => {
    const file = path.join(fx.temp, 'skeletons.md'); fs.writeFileSync(file, text);
    return render(fx, role, pick(fx.facts, ROLE_FACTS[role]), ['--skeletons', file]);
  };
  const plant = (text, from, to) => { assert.equal(text.split(from).length - 1, 1, 'the anchor must occur once: ' + from); return text.replace(from, () => to); };
  const DO = 'DO: implement each checklist item;', RULES = 'RULES: read a file before you edit it. A comment';
  const REPORT = 'REPORT (fixed shape — the orchestrator acts on nothing else):', noDo = plant(skeletons, DO, 'Do: implement each checklist item;');
  const cases = [
    [noDo, '"DO:" must open exactly one line of the implementer block, found 0'],
    [plant(skeletons, "its message carrying the item's id.\nRULES:", "its message carrying the item's id.\nDO: a second DO line.\nRULES:"),
      '"DO:" must open exactly one line of the implementer block, found 2'],
    [plant(skeletons, RULES, 'Rules: read a file before you edit it. A comment'), '"RULES:" must open exactly one line of the implementer block, found 0'],
    [plant(skeletons, REPORT, 'RULES: a second RULES line.\n' + REPORT), '"RULES:" must open exactly one line of the implementer block, found 2'],
    [plant(noDo, REPORT, 'DO: a DO line after RULES.\n' + REPORT), 'the implementer block\'s "DO:" line must come before its "RULES:" line'],
    [plant(skeletons, '```prompt:rework\n', '```prompt:reworked\n'), 'no ```prompt:rework block in the skeletons'],
  ];
  for (const [text, reason] of cases) {
    const r = withSkeletons(text, 'rework');
    assert.equal(r.stdout, 'UNKNOWN ' + reason + '\n', reason); assert.equal(r.status, 2);
  }
  assert.deepEqual(listing(fx.out), [], 'no refusal wrote a file');
  // The anchors bind role rework alone: the implementer renders from each anchor plant, and rework from the unaltered copy.
  for (const [text, reason] of cases.slice(0, 5)) assert.equal(withSkeletons(text, 'implementer').status, 0, 'the implementer reads no anchor: ' + reason);
  assert.equal(withSkeletons(skeletons, 'rework').status, 0, 'the unaltered copy renders rework, so the refusals above are the plants');
  // An anchor is a line that OPENS with DO: or RULES:, so either word later in a line is no second anchor.
  const midLine = plant(skeletons, 'NEVER spawn a gate or reviewer agent yourself.', 'NEVER spawn a gate or reviewer agent yourself (see DO: and RULES: below).');
  assert.equal(withSkeletons(midLine, 'rework').status, 0, 'DO: and RULES: inside a line are not anchors');
  assert.equal(listing(fx.out).length, 7);
});

// ===== Every render the renderer made before rework, unchanged =========================
// "Before" is the renderer and its skeletons as committed at PROMPT_BASE, the commit this
// change was cut from, read out of git blob by blob into a scratch directory (as FAMILY_BASE
// in tests/tool-wiring.test.cjs reads its base) — never a snapshot the current code wrote.
const PROMPT_BASE = 'd1f80ee';
function materializeBase(t) {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'prompt base '));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }));
  const git = (...args) => {
    const r = spawnSync('git', ['-C', ROOT, ...args], { windowsHide: true, maxBuffer: 1 << 26 });
    assert.ifError(r.error); assert.equal(r.status, 0, PROMPT_BASE + ': git ' + args.join(' ') + ' — ' + r.stderr);
    return r.stdout;
  };
  const files = git('ls-tree', '-r', '-z', '--name-only', PROMPT_BASE, '--', 'orchestrate/tools', SKELETONS).toString('utf8').split('\0').filter(Boolean);
  assert.ok(files.includes('orchestrate/tools/prompt.mjs') && files.includes(SKELETONS), PROMPT_BASE + ' must hold the renderer and its skeletons');
  for (const file of files) {
    const target = path.join(dir, ...file.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, git('cat-file', 'blob', PROMPT_BASE + ':' + file));
  }
  return dir;
}
// The one line B03 of OS-20261007 added to every skeleton, so to every render: how often a render
// holds it, anywhere and as a line of its own, and the render with that one line taken out, and
// every line that is BACKGROUND, the implementer-side line counted on its own in the test below.
const NEVER_OPEN = "Never open another agent's prompt or facts file.";
const BACKGROUND = 'Before you report, end every background command you started (`run_in_background`, or a command moved to the background at its timeout): '
  + 'wait for it to finish or kill it, since one still running when you hand back leaves you `waiting` (Claude Code shows `completed`), '
  + "blocks the orchestrator's context clear, and resumes you when it ends.";
function neverOpen(text) {
  const lines = text.split('\n'), at = lines.flatMap((line, i) => line === NEVER_OPEN ? [i] : []);
  return { count: text.split(NEVER_OPEN).length - 1, own: at.length,
    rest: at.length === 1 ? lines.filter((line, i) => i !== at[0] && line !== BACKGROUND).join('\n') : null };
}
// A role rendered in-process by the renderer module given, from the fixture's ledger, facts and
// guardrails file, with one fixed nonce, so two renderers' outputs compare byte for byte.
function rendererFor(fx) {
  const file = name => fs.readFileSync(path.join(fx.ledger, name), 'utf8');
  const texts = { contract: file('00-READBEFORE.md'), plan: file('01-plan.md'), batchName: '02-batches-01-render-me.md', batchText: file('02-batches-01-render-me.md'), batch: 'B01' };
  const nonce = '0123456789ab', readGuardrails = name => fs.readFileSync(path.join(fx.worktree, name), 'utf8');
  // Each renderer takes the facts its own skeletons ask for, so a skeleton without a slot is not handed that slot's fact.
  return (mod, text, role) => mod.render({ skeletons: text, ledger: mod.ledgerValues(texts), role,
    facts: pick(fx.facts, mod.roleFacts(mod.promptBlocks(text), role)), nonce, readGuardrails });
}
// B01 of OS-20261024 changed the skeletons on purpose: the implementer, polish and fix-round blocks
// name their report file and its heading, and the reviewer block its optional SWEEP list. Each
// entry is [the text now, the text at PROMPT_BASE]; undone in the current skeletons, every base
// role renders as it did at the base, so these edits, and only they, are exempt. They pin the new
// text whole: an edit to it moves this list on purpose.
const REPORT_FILE_EDITS = [
  ['REPORT (fixed shape — the orchestrator acts on nothing else):\n'
    + 'Write your full report with the Write tool to "[REPORT_FILE]". Its first line is exactly\n'
    + '`### B[NN] R[ROUND] implementer findings`; then line 1 below; then the same `NONCE` line as\n'
    + 'line 2 of your final message (when this prompt does not end with that line, neither the\n'
    + 'file nor your final message has one, and your final message is three lines); then the\n'
    + 'EVIDENCE block below, one line per validation run (its `validate.mjs` line, then\n'
    + '`exit <code>`), ended by a blank line.\n',
  'REPORT (fixed shape — the orchestrator acts on nothing else):\n'],
  ['the commit SHA(s); `checklist <n>/<m>` (<n> items ticked of <m>).\n', 'the commit SHA(s); checklist ticked n/m.\n'],
  ['  (NEEDS_FENCE names the path(s), the checklist item, and why the fence must grow.)\n'
    + 'FINAL MESSAGE (four lines, nothing else): line 1 the status line; line 3\n'
    + '`checklist <n>/<m>`; line 4 the path [REPORT_FILE].\n',
  '  (NEEDS_FENCE names the path(s), the checklist item, and why the fence must grow.)\n'],
  ['Same REPORT shape.\nIts file this time is "[REPORT_FILE]", its first line exactly `### B[NN] R[ROUND] polish findings`.\n', 'Same REPORT shape.\n'],
  ['Same REPORT shape.\nIts file this time is "[REPORT_FILE]", its first line exactly `### B[NN] R[ROUND] fix-round findings`.\n', 'Same REPORT shape.\n'],
  ['of maybes.\n'
    + "SWEEP: an optional list after the findings, one entry per prose-only fix outside the\n"
    + "batch's own work: `file:line`, the current text and the replacement text, whose fact you\n"
    + "verified; it is no finding class, line 3's counts never include it, and it never blocks.\n"
    + 'A fix is prose-only when every path it changes is Markdown, or JavaScript that\n'
    + '`prose-only-diff.mjs` reads as `PROSE-ONLY`. Prose that is a contract and files agents read\n'
    + "as instructions (`CLAUDE.md`, `.claude/**`, a skill's own Markdown) are never listed there;\n"
    + 'the classes above still apply to them.\n',
  'of maybes.\n'],
];
const undoEdits = (text, edits) => edits.reduce((t, [now, then]) => {
  assert.equal(t.split(now).length - 1, 1, 'an exempt edit must occur exactly once: ' + JSON.stringify(now.slice(0, 80)));
  return t.replace(now, () => then);
}, text);
test('the implementer, and every role the renderer had at ' + PROMPT_BASE + ', renders byte-identically to that renderer and its skeletons, the never-open and background-command lines aside', { skip: 'needs history and ledger records that are not in this copy' }, async t => {
  const fx = fixture(t), base = materializeBase(t), skeletons = read(SKELETONS), undone = undoEdits(skeletons, REPORT_FILE_EDITS);
  const now = await api(), then = await import(pathToFileURL(path.join(base, 'orchestrate', 'tools', 'prompt.mjs')).href);
  const baseSkeletons = fs.readFileSync(path.join(base, ...SKELETONS.split('/')), 'utf8');
  // The base is the pre-change pair, and every role it rendered still renders.
  assert.ok(!Object.hasOwn(then.ROLES, 'rework') && !baseSkeletons.includes('```prompt:rework'), PROMPT_BASE + ' predates role rework');
  const roles = Object.keys(then.ROLES);
  assert.ok(roles.includes('implementer') && roles.every(role => Object.hasOwn(now.ROLES, role)), 'the base roles, the implementer among them, all still exist');
  // The same ledger, facts and nonce for both.
  const renderWith = rendererFor(fx);
  // Every role the renderer has now, rework among them, holds the never-open line once, on a line
  // of its own; each base role, that line and any background-command line taken out and the exempt
  // edits undone, renders as it did at the base.
  assert.ok(Object.hasOwn(now.ROLES, 'rework'), 'the role the base lacked is among those checked');
  for (const role of Object.keys(now.ROLES)) {
    const { count, own } = neverOpen(renderWith(now, skeletons, role));
    assert.deepEqual({ count, own }, { count: 1, own: 1 }, role + ': the never-open line, once, on a line of its own');
    if (roles.includes(role)) assert.equal(neverOpen(renderWith(now, undone, role)).rest, renderWith(then, baseSkeletons, role), role + ': the render changed since ' + PROMPT_BASE + ' beyond the never-open line and the exempt edits');
  }
  // The exemption is needed by every base role it names, and by no other: without it those renders differ from the base.
  const differs = roles.filter(role => neverOpen(renderWith(now, skeletons, role)).rest !== renderWith(then, baseSkeletons, role));
  assert.deepEqual(differs, ['implementer', 'polish', 'fix-round', 'reviewer', 'reviewer-round2'], 'the base roles the exempt edits reach');
  // Live control: one word of the implementer's DO paragraph changed is a different render.
  const changed = undone.replace('DO: implement each checklist item;', () => 'DO: implement every checklist item;');
  assert.notEqual(changed, undone, 'the control anchor must exist');
  const changedRender = neverOpen(renderWith(now, changed, 'implementer'));
  assert.equal(changedRender.own, 1, 'the control keeps the never-open line, so only the DO word differs');
  assert.notEqual(changedRender.rest, renderWith(then, baseSkeletons, 'implementer'), 'a changed DO paragraph must show');
  // Live controls, each count moved: the implementer block without its line, rendered as rework;
  // the polish block with a second copy; the reviewer block's line joined to the line above it.
  for (const [role, from, to, want] of [
    ['rework', 'before it exits.\n' + NEVER_OPEN + '\n\nREPORT', 'before it exits.\n\nREPORT', { count: 0, own: 0 }],
    ['polish', 'do not make the change.\n' + NEVER_OPEN + '\n', 'do not make the change.\n' + NEVER_OPEN + '\n' + NEVER_OPEN + '\n', { count: 2, own: 2 }],
    ['reviewer', '(checked out on [BATCH_BRANCH]).\n' + NEVER_OPEN + '\n', '(checked out on [BATCH_BRANCH]). ' + NEVER_OPEN + '\n', { count: 1, own: 0 }],
  ]) {
    assert.equal(skeletons.split(from).length - 1, 1, 'the control anchor must occur once: ' + JSON.stringify(from));
    const { count, own } = neverOpen(renderWith(now, skeletons.replace(from, () => to), role));
    assert.deepEqual({ count, own }, want, role + ': the planted skeleton must change the count');
  }
});

// ===== The background-command line: implementer-side prompts only =====================
// B05 of OS-20261022 put BACKGROUND in the implementer, polish and fix-round blocks and in the
// fix-up skeleton. Counted in every role's render, in the fix-up block and in the whole file: one
// copy in each of the four homes and four in the file leave no other skeleton, nor prose, a copy.
// Each role's count, written here and checked against the renderer's roles; rework's copy is the
// implementer block's (expectedRender above).
const BACKGROUND_ROLES = { implementer: 1, polish: 1, 'fix-round': 1, rework: 1, reviewer: 0, 'reviewer-round2': 0, 'test-hunter': 0 };
const occurrences = text => ({ count: text.split(BACKGROUND).length - 1, own: text.split('\n').filter(line => line === BACKGROUND).length });
// The fix-up skeleton is pasted by hand, not rendered, so it is no `prompt:` block: it is found
// here as the bare fenced block whose first line opens "You are fixing". Null on unbalanced fences.
function fixupBodies(text) {
  const blocks = [];
  let open = null;
  for (const line of text.split('\n')) {
    if (line.startsWith('```')) { if (open) { blocks.push(open); open = null; } else open = { bare: line === '```', lines: [] }; }
    else if (open) open.lines.push(line);
  }
  return open ? null : blocks.filter(b => b.bare && (b.lines[0] || '').startsWith('You are fixing ')).map(b => b.lines.join('\n'));
}
// The fix-up block, its BACKGROUND line set aside, is pinned whole against the block as the ledger
// base FIXUP_BASE committed it, read out of git as materializeBase reads PROMPT_BASE: no role renders
// the fix-up block, so no render comparison reaches a sentence added to it. An edit to the block moves
// FIXUP_BASE on purpose, or is applied to the base block as FIXUP_EDITS below.
const FIXUP_BASE = '81f7c00';
// B01 of OS-20261024: the fix-up report names its file, heading and three-line final message.
// [the text at FIXUP_BASE, the text now], applied to the base block, which then must be the live one.
const FIXUP_EDITS = [["what the user's checkpoint re-run should now check).",
  "what the user's checkpoint re-run should now check).\n"
  + 'Write it with the Write tool to "[REPORT_FILE]", and give neither it nor your final message\n'
  + 'the nonce line. Its first line is exactly `### B[NN] R[ROUND] fix-up findings`; its second\n'
  + 'exactly one of: DONE | DONE_WITH_CONCERNS | NEEDS_FENCE | BLOCKED; its third `EVIDENCE:`,\n'
  + 'then one line per validation run (its `validate.mjs` line, then `exit <code>`), the commit\n'
  + 'SHA(s) and `checklist <n>/<m>`, ended by a blank line; then the ≤40 lines. For NEEDS_FENCE\n'
  + 'or BLOCKED add exactly:\n'
  + '  Expected: … / Found: … / Why it matters: … / How to proceed: …\n'
  + 'FINAL MESSAGE (three lines, nothing else): the status line; `checklist <n>/<m>`; the path\n'
  + '[REPORT_FILE].']];
const withoutBackground = body => body.split('\n').filter(line => line !== BACKGROUND).join('\n');
function fixupAtBase() {
  const r = spawnSync('git', ['-C', ROOT, 'cat-file', 'blob', FIXUP_BASE + ':' + SKELETONS], { encoding: 'utf8', windowsHide: true, maxBuffer: 1 << 26 });
  assert.ifError(r.error); assert.equal(r.status, 0, FIXUP_BASE + ': git cat-file blob — ' + r.stderr);
  const bodies = fixupBodies(r.stdout.replace(/\r\n/g, '\n'));
  assert.ok(bodies && bodies.length === 1 && !bodies[0].includes(BACKGROUND), FIXUP_BASE + ' holds one fix-up block, without the background-command line');
  return FIXUP_EDITS.reduce((body, [then, now]) => {
    assert.equal(body.split(then).length - 1, 1, FIXUP_BASE + ': an edited passage must occur once in the base block: ' + then);
    return body.replace(then, () => now);
  }, bodies[0]);
}
function backgroundCounts(renderWith, skeletons, baseBlock) {
  const bodies = fixupBodies(skeletons);
  return {
    renders: Object.fromEntries(Object.keys(BACKGROUND_ROLES).map(role => [role, occurrences(renderWith(skeletons, role))])),
    fixup: bodies === null ? 'unbalanced fences' : bodies.length === 1 ? occurrences(bodies[0]) : bodies.length + ' bare blocks open "You are fixing"',
    fixupBlock: bodies && bodies.length === 1 && withoutBackground(bodies[0]) === baseBlock ? 'as at ' + FIXUP_BASE : 'changed',
    file: occurrences(skeletons),
  };
}
test('the background-command line: once, on a line of its own, in every implementer-side render and the fix-up block, and in no other render or skeleton; the fix-up block otherwise as at ' + FIXUP_BASE, { skip: 'needs history and ledger records that are not in this copy' }, async t => {
  const fx = fixture(t), skeletons = read(SKELETONS), now = await api(), render = rendererFor(fx), baseBlock = fixupAtBase();
  assert.deepEqual(Object.keys(BACKGROUND_ROLES).sort(), Object.keys(now.ROLES).sort(), 'every role the renderer has is counted, and only those');
  const counts = text => backgroundCounts((s, role) => render(now, s, role), text, baseBlock);
  const once = { count: 1, own: 1 }, none = { count: 0, own: 0 }, n = k => ({ count: k, own: k });
  const want = (renders, rest) => ({ renders: { ...Object.fromEntries(Object.entries(BACKGROUND_ROLES).map(([role, k]) => [role, n(k)])), ...renders },
    fixup: once, fixupBlock: 'as at ' + FIXUP_BASE, file: n(4), ...rest });
  assert.deepEqual(counts(skeletons), want());
  // Live controls, collected and asserted once: the line taken out of each home in turn, planted in
  // the reviewer block and in the QA runner skeleton, the fix-up copy joined to the line above it, and
  // a contradicting sentence added to the fix-up block beside its copy. Each states the whole result it
  // must produce.
  const controls = [
    ['implementer removed', '(<n> items ticked of <m>).\n' + BACKGROUND + '\n', '(<n> items ticked of <m>).\n', want({ implementer: none, rework: none }, { file: n(3) })],
    ['polish removed', 'do not make the change.\n' + NEVER_OPEN + '\n' + BACKGROUND + '\n', 'do not make the change.\n' + NEVER_OPEN + '\n', want({ polish: none }, { file: n(3) })],
    ['fix-round removed', 'before it exits.\n' + NEVER_OPEN + '\n' + BACKGROUND + '\n', 'before it exits.\n' + NEVER_OPEN + '\n', want({ 'fix-round': none }, { file: n(3) })],
    ['fix-up removed', 'repair — [symptom]".\n' + BACKGROUND + '\n', 'repair — [symptom]".\n', want({}, { fixup: none, file: n(3) })],
    ['planted in the reviewer', '(checked out on [BATCH_BRANCH]).\n' + NEVER_OPEN + '\n', '(checked out on [BATCH_BRANCH]).\n' + NEVER_OPEN + '\n' + BACKGROUND + '\n',
      want({ reviewer: once, 'reviewer-round2': once }, { file: n(5) })],
    ['planted in the QA runner', 'THE RELEVANT HARD PROHIBITIONS FROM THE READBEFORE].\n', 'THE RELEVANT HARD PROHIBITIONS FROM THE READBEFORE].\n' + BACKGROUND + '\n', want({}, { file: n(5) })],
    ['fix-up joined to the line above', 'repair — [symptom]".\n' + BACKGROUND + '\n', 'repair — [symptom]". ' + BACKGROUND + '\n',
      want({}, { fixup: { count: 1, own: 0 }, fixupBlock: 'changed', file: { count: 4, own: 3 } })],
    ['a sentence added to the fix-up block', 'repair — [symptom]".\n' + BACKGROUND + '\n',
      'repair — [symptom]".\n' + BACKGROUND + '\nIf a background command is still running, report anyway and leave it running.\n', want({}, { fixupBlock: 'changed' })],
  ];
  const missed = [];
  for (const [name, from, to, expected] of controls) {
    if (skeletons.split(from).length !== 2) { missed.push({ control: name, counts: 'the anchor must occur once' }); continue; }
    const got = counts(skeletons.replace(from, () => to));
    if (!isDeepStrictEqual(got, expected)) missed.push({ control: name, counts: got });
  }
  assert.deepEqual(missed, [], 'every control must move the counts exactly as it states');
});

// ===== The report file: named by the implementer-side prompts, checked by --report ========
// B01 of OS-20261024: the implementer, polish, fix-round and rework prompts name a report file and
// its heading; `prompt.mjs --report <file> --nonce <nonce>` checks that file and prints one line.
// The heading role each role's prompt names, written here.
const REPORT_HEADING = { implementer: 'implementer', polish: 'polish', 'fix-round': 'fix-round', rework: 'implementer' };
test('every implementer-side render names its report file and its heading, and no gate render does', async t => {
  const fx = fixture(t), { ROLES: roles } = await api();
  assert.deepEqual(Object.keys(roles).filter(role => ROLE_FACTS[role].includes('reportFile')), Object.keys(REPORT_HEADING), 'the roles taking reportFile');
  const seen = {};
  for (const role of ROLES) {
    const { text } = renderedMatches(fx, role, pick(fx.facts, ROLE_FACTS[role]), fx.expected);
    const headings = [...text.matchAll(/`### B01 R2 ([a-z0-9-]+) findings`/g)].map(m => m[1]);
    seen[role] = { file: text.includes('"' + fx.facts.reportFile + '"'), headings };
  }
  assert.deepEqual(seen, Object.fromEntries(ROLES.map(role => [role, Object.hasOwn(REPORT_HEADING, role)
    ? { file: true, headings: [REPORT_HEADING[role]] } : { file: false, headings: [{ reviewer: 'reviewer', 'reviewer-round2': 'reviewer', 'test-hunter': 'test-hunter' }[role]] }])));
});

const REPORT_NONCE = '0123456789ab', PROSE = 'PROSE-MARKER what changed and why, checklist 9/9 in passing.';
const EVIDENCE = ['EVIDENCE:', 'PASS tests 905/907, 2 skipped (42s) exit 0', 'commit abc1234', 'checklist 3/4'];
const MISMATCH = 'Expected: a / Found: b / Why it matters: c / How to proceed: d';
function reportText({ heading = '### B01 R1 implementer findings', status = 'DONE', nonce = 'NONCE ' + REPORT_NONCE, evidence = EVIDENCE, prose = [PROSE] } = {}) {
  return [heading, status, ...(nonce === null ? [] : [nonce]), ...evidence, '', ...prose].join('\n') + '\n';
}
const FAIL = rule => ({ code: 1, line: 'REPORT FAIL ' + rule });
const OK = (status, count = '3/4') => ({ code: 0, line: 'REPORT ' + status + ' checklist ' + count });
test('--report: every rule has a passing case and a failing case decided by that rule alone, and no line prints the report', async () => {
  const { checkReport, reportRules } = await api(), skeletons = read(SKELETONS);
  // The domain comes from the skeletons: every heading role a report-file block names, and the implementer's status line.
  assert.deepEqual(reportRules(skeletons), { roles: ['implementer', 'polish', 'fix-round', 'fix-up'], statuses: ['DONE', 'DONE_WITH_CONCERNS', 'NEEDS_FENCE', 'BLOCKED'],
    mismatch: ['NEEDS_FENCE', 'BLOCKED'], labels: ['Expected:', 'Found:', 'Why it matters:', 'How to proceed:'] });
  const check = (text, nonce = REPORT_NONCE) => checkReport({ skeletons, text, nonce });
  const without = (lines, drop) => lines.filter(l => l !== drop);
  const HEADING = 'line 1 is not `### B<NN> R<k> <role> findings`, <role> one of implementer, polish, fix-round, fix-up';
  const EV = 'the EVIDENCE block holds no `validate.mjs` line (PASS, FAIL or UNKNOWN) with `exit <code>`';
  const SPACED = reportText().replace('\nchecklist 3/4\n\n', () => '\nchecklist 3/4\n  \n');
  assert.ok(SPACED.includes('\nchecklist 3/4\n  \nPROSE-MARKER'), 'the whitespace-only control line is planted');
  const cases = [
    ['well formed', reportText(), REPORT_NONCE, OK('DONE')],
    ['CRLF', reportText().replace(/\n/g, '\r\n'), REPORT_NONCE, OK('DONE')],
    ...['polish', 'fix-round', 'fix-up'].map(role => ['heading ' + role, reportText({ heading: '### B12 R3 ' + role + ' findings' }), REPORT_NONCE, OK('DONE')]),
    ['heading of a gate role', reportText({ heading: '### B01 R1 reviewer findings' }), REPORT_NONCE, FAIL(HEADING)],
    ['heading with a one-digit batch', reportText({ heading: '### B1 R1 implementer findings' }), REPORT_NONCE, FAIL(HEADING)],
    ['heading of round 0', reportText({ heading: '### B01 R0 implementer findings' }), REPORT_NONCE, FAIL(HEADING)],
    // The heading is the whole line, as the LOG.md recovery's exact match needs it: nothing before it, nothing after it.
    ['heading with a trailing space', reportText({ heading: '### B01 R1 implementer findings ' }), REPORT_NONCE, FAIL(HEADING)],
    ['heading with a trailing word', reportText({ heading: '### B01 R1 implementer findings (resumed)' }), REPORT_NONCE, FAIL(HEADING)],
    ['heading with a leading space', reportText({ heading: ' ### B01 R1 implementer findings' }), REPORT_NONCE, FAIL(HEADING)],
    // Batch and round numbers of more than two and one digits, as the renderer's own B<NN> takes them.
    ['heading with a three-digit batch', reportText({ heading: '### B100 R1 implementer findings' }), REPORT_NONCE, OK('DONE')],
    ['heading with a two-digit round', reportText({ heading: '### B01 R10 implementer findings' }), REPORT_NONCE, OK('DONE')],
    ['DONE_WITH_CONCERNS', reportText({ status: 'DONE_WITH_CONCERNS' }), REPORT_NONCE, OK('DONE_WITH_CONCERNS')],
    ['unknown status', reportText({ status: 'FINISHED' }), REPORT_NONCE, FAIL('line 2 is not one of DONE | DONE_WITH_CONCERNS | NEEDS_FENCE | BLOCKED')],
    ['status with a trailing word', reportText({ status: 'DONE early' }), REPORT_NONCE, FAIL('line 2 is not one of DONE | DONE_WITH_CONCERNS | NEEDS_FENCE | BLOCKED')],
    ['no NONCE line', reportText({ nonce: null }), REPORT_NONCE, FAIL('line 3 is not `NONCE <nonce>` for the nonce given')],
    ['the wrong nonce', reportText({ nonce: 'NONCE ba9876543210' }), REPORT_NONCE, FAIL('line 3 is not `NONCE <nonce>` for the nonce given')],
    // The right nonce inside other text is not the line: line 3 is exactly `NONCE <nonce>`.
    ['the skeleton nonce line copied whole', reportText({ nonce: 'Line 2, directly under line 1: NONCE ' + REPORT_NONCE }), REPORT_NONCE, FAIL('line 3 is not `NONCE <nonce>` for the nonce given')],
    ['the nonce line with a trailing word', reportText({ nonce: 'NONCE ' + REPORT_NONCE + ' extra' }), REPORT_NONCE, FAIL('line 3 is not `NONCE <nonce>` for the nonce given')],
    // The nonce line's place is line 3: the live nonce further down does not rescue a stale one there.
    ['a stale nonce on line 3, the live one below', reportText({ nonce: 'NONCE ba9876543210', prose: [PROSE, 'NONCE ' + REPORT_NONCE] }), REPORT_NONCE,
      FAIL('line 3 is not `NONCE <nonce>` for the nonce given')],
    ['fix-up without a nonce', reportText({ heading: '### B01 R1 fix-up findings', nonce: null }), null, OK('DONE')],
    ['a NONCE line, no --nonce', reportText(), null, FAIL('line 3 is a NONCE line, and no --nonce was given')],
    ['no EVIDENCE line', reportText({ evidence: EVIDENCE.slice(1) }), REPORT_NONCE, FAIL('line 4 does not open `EVIDENCE:`')],
    ['no EVIDENCE line, no nonce', reportText({ heading: '### B01 R1 fix-up findings', nonce: null, evidence: EVIDENCE.slice(1) }), null, FAIL('line 3 does not open `EVIDENCE:`')],
    ['an EVIDENCE opener in bold', reportText({ evidence: ['**EVIDENCE:**', ...EVIDENCE.slice(1)] }), REPORT_NONCE, FAIL('line 4 does not open `EVIDENCE:`')],
    ['a report ending at its NONCE line', ['### B01 R1 implementer findings', 'DONE', 'NONCE ' + REPORT_NONCE].join('\n'), REPORT_NONCE, FAIL('line 4 does not open `EVIDENCE:`')],
    ['the validate line on the EVIDENCE line', reportText({ evidence: ['EVIDENCE: ' + EVIDENCE[1], ...EVIDENCE.slice(2)] }), REPORT_NONCE, OK('DONE')],
    // Each accepted form of a validate.mjs line is the block's ONLY such line, so no other form rescues it.
    ...[['a FAIL line', 'FAIL tests 2 of 9 failed: a — log: x exit 1'], ['an UNKNOWN line', 'UNKNOWN cannot read spec s.json (ENOENT) exit 2'],
      ['a line in backticks', '`PASS tests 3/3 (1s)` exit 0'], ['an exit code', 'PASS tests 3/3 (1s) exit code 0'],
      ['a dash item', '- PASS tests 3/3 (1s) exit 0'], ['a star item', '* PASS tests 3/3 (1s) exit 0']]
      .map(([name, line]) => [name, reportText({ evidence: EVIDENCE.map(l => l === EVIDENCE[1] ? line : l) }), REPORT_NONCE, OK('DONE')]),
    ['no validate line', reportText({ evidence: without(EVIDENCE, EVIDENCE[1]) }), REPORT_NONCE, FAIL(EV)],
    ['a validate line without its exit code', reportText({ evidence: EVIDENCE.map(l => l === EVIDENCE[1] ? 'PASS tests 905/907, 2 skipped (42s)' : l) }), REPORT_NONCE, FAIL(EV)],
    // A line that holds an exit code is a validate.mjs line only when PASS, FAIL or UNKNOWN opens it.
    ['an exit code with no result word', reportText({ evidence: EVIDENCE.map(l => l === EVIDENCE[1] ? 'node --test tests exit 0' : l) }), REPORT_NONCE, FAIL(EV)],
    ['a result word not opening the line', reportText({ evidence: EVIDENCE.map(l => l === EVIDENCE[1] ? 'run 1: PASS tests 3/3 (1s) exit 0' : l) }), REPORT_NONCE, FAIL(EV)],
    ['the validate line past the blank line', reportText({ evidence: without(EVIDENCE, EVIDENCE[1]), prose: [EVIDENCE[1], PROSE] }), REPORT_NONCE, FAIL(EV)],
    ['no checklist', reportText({ evidence: without(EVIDENCE, 'checklist 3/4') }), REPORT_NONCE, FAIL('the EVIDENCE block holds 0 `checklist <n>/<m>` counts, not one')],
    ['two checklists', reportText({ evidence: [...EVIDENCE, 'checklist 4/4'] }), REPORT_NONCE, FAIL('the EVIDENCE block holds 2 `checklist <n>/<m>` counts, not one')],
    // A whitespace-only line ends the block too, so the prose's own `checklist 9/9` stays out of it.
    ['a whitespace-only line ending the block', SPACED, REPORT_NONCE, OK('DONE')],
    ['the checklist past the blank line', reportText({ evidence: without(EVIDENCE, 'checklist 3/4'), prose: ['checklist 3/4', PROSE] }), REPORT_NONCE,
      FAIL('the EVIDENCE block holds 0 `checklist <n>/<m>` counts, not one')],
    ...['NEEDS_FENCE', 'BLOCKED'].flatMap(status => [
      [status + ', one line', reportText({ status, prose: [PROSE, MISMATCH] }), REPORT_NONCE, OK(status)],
      [status + ', four lines', reportText({ status, prose: [PROSE, ...MISMATCH.split(' / ').map(l => '  ' + l)] }), REPORT_NONCE, OK(status)],
      ...['Expected:', 'Found:', 'Why it matters:', 'How to proceed:'].map(label => [status + ' without ' + label,
        reportText({ status, prose: [PROSE, MISMATCH.split(' / ').filter(p => !p.startsWith(label)).join(' / ')] }), REPORT_NONCE, FAIL(status + ' without its `' + label + '` line')]),
      // A label inside a sentence is no mismatch line: it counts only opening a line or after " / ".
      [status + ' naming Expected: mid-sentence', reportText({ status, prose: [PROSE + ' The Expected: line follows.', MISMATCH.split(' / ').slice(1).join(' / ')] }), REPORT_NONCE,
        FAIL(status + ' without its `Expected:` line')],
    ]),
    // Mismatch labels count only after the EVIDENCE block.
    ['NEEDS_FENCE with its labels inside the EVIDENCE block', reportText({ status: 'NEEDS_FENCE', evidence: [...EVIDENCE, MISMATCH] }), REPORT_NONCE,
      FAIL('NEEDS_FENCE without its `Expected:` line')],
    ['DONE needs no mismatch lines', reportText({ status: 'DONE' }), REPORT_NONCE, OK('DONE')],
  ];
  const wrong = [];
  for (const [name, text, nonce, expected] of cases) {
    const got = check(text, nonce);
    if (!isDeepStrictEqual(got, expected)) wrong.push({ name, got });
    if (got.line.includes('PROSE-MARKER') || got.line.includes('\n')) wrong.push({ name, prints: got.line });
  }
  assert.deepEqual(wrong, [], 'every case reads as it states');
});

test('--report reads its rules from the skeletons it is given, and refuses skeletons that state none', async () => {
  const { checkReport } = await api(), skeletons = read(SKELETONS);
  const plant = (from, to) => { assert.equal(skeletons.split(from).length - 1, 1, 'the anchor must occur once: ' + from); return skeletons.replace(from, () => to); };
  const check = (text, planted) => { try { return checkReport({ skeletons: planted, text, nonce: REPORT_NONCE }); } catch (e) { return { unknown: e.message }; } };
  const STATUS = 'Line 1, exactly one of: DONE | DONE_WITH_CONCERNS | NEEDS_FENCE | BLOCKED\nEVIDENCE:';
  const FIXUP = 'Its first line is exactly `### B[NN] R[ROUND] fix-up findings`';
  const MISMATCH_AT = '(notes only). For NEEDS_FENCE or BLOCKED use exactly:';
  const LABELS = '  Expected: … / Found: … / Why it matters: … / How to proceed: …\n  (NEEDS_FENCE names';
  const NO_SHAPE = { unknown: 'the skeletons state no report file shape (heading roles, status words, mismatch lines)' };
  const bare = status => reportText({ status });
  const labelled = (status, labels) => reportText({ status, prose: [PROSE, labels.map(l => l + ' x').join(' / ')] });
  const OLD_LABELS = ['Expected:', 'Found:', 'Why it matters:', 'How to proceed:'], NEW_LABELS = ['Expected:', 'Found:', 'Why it matters:', 'Next step:'];
  const toDwc = plant('or BLOCKED use exactly:', 'or DONE_WITH_CONCERNS use exactly:'), nextStep = plant(LABELS, LABELS.replace('How to proceed:', 'Next step:'));
  const got = {
    // Each value read from the skeleton, CHANGED there, changes the verdict.
    plantedStatus: check(reportText({ status: 'PARTIAL' }), plant(STATUS, STATUS.replace('BLOCKED', 'BLOCKED | PARTIAL'))),
    lostStatus: check(reportText({ status: 'DONE_WITH_CONCERNS' }), plant(STATUS, STATUS.replace(' | DONE_WITH_CONCERNS', ''))),
    lostFixup: check(reportText({ heading: '### B01 R1 fix-up findings' }), plant(FIXUP, 'Its first line is exactly the heading')),
    mismatchNowDwc: check(bare('DONE_WITH_CONCERNS'), toDwc),
    mismatchNoLongerBlocked: check(bare('BLOCKED'), toDwc),
    labelNowNextStep: check(labelled('NEEDS_FENCE', OLD_LABELS), nextStep),
    labelNextStepHeld: check(labelled('NEEDS_FENCE', NEW_LABELS), nextStep),
    // Each refusal, met by a skeleton only it refuses.
    mismatchNotAStatus: check(reportText(), plant(STATUS, STATUS.replace(' | BLOCKED', ''))),
    noStatusLine: check(reportText(), plant(STATUS, STATUS.replace('Line 1, exactly one of: ', 'Line 1, one of: '))),
    // The planted line comes first and is well formed, so only the one-line rule refuses it.
    secondStatusLine: check(reportText(), plant(STATUS, 'Line 1, exactly one of: DONE | DONE_WITH_CONCERNS | NEEDS_FENCE | BLOCKED | PARTIAL\n' + STATUS)),
    statusWordShape: check(reportText(), plant(STATUS, STATUS.replace('DONE_WITH_CONCERNS', 'Done_with_concerns'))),
    noMismatchLine: check(reportText(), plant(MISMATCH_AT, '(notes only). For a mismatch use exactly:')),
    secondMismatchLine: check(reportText(), plant(MISMATCH_AT, MISMATCH_AT + '\n  Expected: … / Found: … / Why it matters: … / How to proceed: …\nFor NEEDS_FENCE or BLOCKED use exactly:')),
    labelWithoutColon: check(reportText(), plant(LABELS, LABELS.replace('Expected:', 'Expected'))),
    threeLabels: check(reportText(), plant(LABELS, LABELS.replace(' / How to proceed: …', ''))),
    fiveLabels: check(reportText(), plant(LABELS, LABELS.replace(' / How to proceed: …', ' / How to proceed: … / Next step: …'))),
    noImplementerBlock: check(reportText(), plant('```prompt:implementer\n', '```prompt:implementers\n')),
    noReportFile: check(reportText(), skeletons.split('[REPORT_FILE]').join('the report file')),
  };
  assert.deepEqual(got, {
    plantedStatus: OK('PARTIAL'), lostStatus: FAIL('line 2 is not one of DONE | NEEDS_FENCE | BLOCKED'),
    lostFixup: FAIL('line 1 is not `### B<NN> R<k> <role> findings`, <role> one of implementer, polish, fix-round'),
    mismatchNowDwc: FAIL('DONE_WITH_CONCERNS without its `Expected:` line'), mismatchNoLongerBlocked: OK('BLOCKED'),
    labelNowNextStep: FAIL('NEEDS_FENCE without its `Next step:` line'), labelNextStepHeld: OK('NEEDS_FENCE'),
    mismatchNotAStatus: NO_SHAPE, noStatusLine: NO_SHAPE, secondStatusLine: NO_SHAPE, statusWordShape: NO_SHAPE,
    noMismatchLine: NO_SHAPE, secondMismatchLine: NO_SHAPE, labelWithoutColon: NO_SHAPE, threeLabels: NO_SHAPE, fiveLabels: NO_SHAPE,
    noImplementerBlock: { unknown: 'no ```prompt:implementer block in the skeletons' }, noReportFile: NO_SHAPE,
  });
});

// The fix-up skeleton is pasted, so its agent never sees the implementer block: the block itself
// spells out every line --report checks, in the words reportRules reads from the implementer block.
test('the fix-up block states the report file --report checks, and a report built from its own words passes', async () => {
  const { checkReport, reportRules } = await api(), skeletons = read(SKELETONS), rules = reportRules(skeletons);
  const bodies = fixupBodies(skeletons);
  assert.ok(bodies && bodies.length === 1, 'one fix-up block');
  const body = bodies[0], flat = collapse(body);
  const heading = /Its first line is exactly `(### B\[NN\] R\[ROUND\] fix-up findings)`;/.exec(flat);
  const statuses = /its second exactly one of: ([A-Z_ |]+); its third `(EVIDENCE:)`,/.exec(flat);
  const labels = body.split('\n').filter(l => l.startsWith('  Expected: '));
  assert.ok(heading && statuses && labels.length === 1, 'the block states its heading, its status words, its EVIDENCE opener and its mismatch line');
  assert.deepEqual(statuses[1].split(' | '), rules.statuses, 'the fix-up block\'s status words are those --report reads');
  assert.ok(flat.includes('(its `validate.mjs` line, then `exit <code>`), the commit SHA(s) and `checklist <n>/<m>`, ended by a blank line'), 'the evidence lines and their end');
  assert.doesNotMatch(body, /NONCE/, 'the pasted block spells no nonce');
  const filled = heading[1].replace('[NN]', '03').replace('[ROUND]', '1');
  const write = (status, prose) => [filled, status, statuses[2], 'PASS tests 3/3 (1s) exit 0', 'commit abc1234', 'checklist 2/2', '', ...prose].join('\n') + '\n';
  const got = rules.statuses.map(status => [status, checkReport({ skeletons, text: write(status, rules.mismatch.includes(status) ? [labels[0].trim()] : ['root cause']), nonce: null })]);
  assert.deepEqual(got, rules.statuses.map(status => [status, OK(status, '2/2')]));
});

test('--report run as --help prints it: a rendered implementer prompt\'s report passes, a changed nonce fails, a bad invocation is UNKNOWN', async t => {
  const fx = fixture(t), help = run(['--help']).stdout.split('\n');
  assert.equal(help[0].startsWith('prompt.mjs --ledger '), true, 'the render synopsis stays the first line');
  const usage = help.filter(l => l.startsWith('prompt.mjs --report '));
  assert.deepEqual(usage, ['prompt.mjs --report <file> --nonce <nonce>'], '--help prints the check form once');
  // The check form's lines, whole: the roles named are those taking a report file, and each exit code is the one observed below.
  const checkHelp = help.slice(help.indexOf(usage[0]));
  assert.deepEqual(checkHelp, [usage[0],
    'Checks the report file written under role ' + Object.keys(REPORT_HEADING).join(', ') + ' (a fix-up report has no nonce line: drop --nonce for it)',
    "and prints ONE line, never the report's prose: REPORT <status> checklist <n>/<m> (exit 0) | REPORT FAIL <the first rule broken>",
    '(exit 1) | UNKNOWN <reason> (exit 2). --report comes first.', ''], 'the check form\'s --help lines');
  const legend = collapse(checkHelp.join(' '));
  const exitOf = what => Number((new RegExp(what + ' [^|]*\\(exit (\\d)\\)').exec(legend) || [])[1]);
  // A real render: the prompt names the file and heading the report must carry, and the nonce the CLI printed.
  const facts = { ...pick(fx.facts, ROLE_FACTS.implementer), round: 1 };
  const { text, nonce } = renderedMatches(fx, 'implementer', facts, { ...fx.expected, '[ROUND]': '1' });
  const heading = /^`(### B01 R1 implementer findings)`;/m.exec(text);
  assert.ok(heading && text.includes('to "' + fx.facts.reportFile + '"'), 'the prompt names the heading and the report file');
  fs.mkdirSync(path.dirname(fx.facts.reportFile), { recursive: true });
  const published = (file, n) => usage[0].split(' ').slice(1).map(w => w === '<file>' ? file : w === '<nonce>' ? n : w);
  const write = body => { fs.writeFileSync(fx.facts.reportFile, body); return fx.facts.reportFile; };
  const outcome = args => { const r = run(args); return { status: r.status, stdout: r.stdout }; };
  const got = {
    good: outcome(published(write(reportText({ heading: heading[1], nonce: 'NONCE ' + nonce })), nonce)),
    changedNonce: outcome(published(write(reportText({ heading: heading[1], nonce: 'NONCE ' + nonce.replace(/^./, c => c === '0' ? '1' : '0') })), nonce)),
    fixup: outcome(published(write(reportText({ heading: '### B01 R1 fix-up findings', nonce: null })), nonce).slice(0, 2)),
    missing: outcome(published(path.join(fx.temp, 'no such report.md'), nonce)),
    directory: outcome(published(fx.temp, nonce)),
    notUtf8: outcome(published(write(Buffer.from([0x23, 0xff, 0x0a])), nonce)),
    noValue: outcome(['--report']),
    unknownFlag: outcome(['--report', fx.facts.reportFile, '--bogus', 'x']),
    twice: outcome(['--report', fx.facts.reportFile, '--nonce', nonce, '--nonce', nonce]),
    nonceFirst: outcome(['--nonce', nonce, '--report', fx.facts.reportFile]),
  };
  const usageLine = 'UNKNOWN usage: --report <file> [--nonce <nonce>]; use --help\n';
  assert.deepEqual([got.good.status, got.changedNonce.status, got.missing.status], [exitOf('REPORT <status>'), exitOf('REPORT FAIL'), exitOf('UNKNOWN')],
    'the exit codes --help states are the ones the tool returns');
  assert.deepEqual(got, {
    good: { status: 0, stdout: 'REPORT DONE checklist 3/4\n' },
    changedNonce: { status: 1, stdout: 'REPORT FAIL line 3 is not `NONCE <nonce>` for the nonce given\n' },
    fixup: { status: 0, stdout: 'REPORT DONE checklist 3/4\n' },
    missing: { status: 2, stdout: 'UNKNOWN cannot read report file ' + path.join(fx.temp, 'no such report.md') + '\n' },
    directory: { status: 2, stdout: 'UNKNOWN cannot read report file ' + fx.temp + '\n' },
    notUtf8: { status: 2, stdout: 'UNKNOWN not UTF-8: report file ' + fx.facts.reportFile + '\n' },
    noValue: { status: 2, stdout: usageLine }, unknownFlag: { status: 2, stdout: usageLine }, twice: { status: 2, stdout: usageLine },
    nonceFirst: { status: 2, stdout: 'UNKNOWN usage: an unknown, missing or duplicate flag; use --help\n' },
  });
});
