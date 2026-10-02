// Run the shipped template script, using a minimal DOM and artifact-store adapter.
// No copy of its verdict/classification logic lives in this harness.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const test = require('node:test');
const vm = require('node:vm');
const os = require('node:os');
const { createHash } = require('node:crypto');

const template = fs.readFileSync(path.join(__dirname, '../orchestrate/references/smoke-page-template.html'), 'utf8');
const A = 'a'.repeat(40), B = 'b'.repeat(40), C = 'c'.repeat(40);
// The step-0 gate the builder now requires: a containment proof that executes against
// the SHA its own sidecar records, not a SHA comparison left to the tester's eye.
const gateFor = sha => ({ commands: [`git merge-base --is-ancestor ${sha} HEAD`,
  `git diff --name-only ${sha}..HEAD -- . ":(exclude).agents/"`], checks: ['Verify the build.'] });
const steps = () => [
  { n: 1, do: 'Open checkout', pass: 'Checkout opens', revision: 1 },
  { n: 2, do: 'Open help', pass: 'Help opens', revision: 1 }
];

async function page({ build = A, items = steps(), storage = {}, key = 'c1', cloud = false,
  now = Date.parse('2026-09-18T12:00:00.000Z'), html: generatedHTML } = {}) {
  const elements = new Map(), writes = [], timers = new Map(), cloudRequests = [], storageWrites = [];
  let copied = '', snapshot, timerId = 0;
  class Element {
    constructor(tag = 'div') {
      this.tagName = tag; this.children = []; this.style = {}; this.attrs = {};
      this.listeners = {}; this.value = ''; this.hidden = false;
    }
    set id(value) { this._id = value; elements.set(value, this); }
    get id() { return this._id; }
    set innerHTML(value) {
      this._html = value; this.children = [];
      for (const match of value.matchAll(/<(\w+)[^>]*\bid="([^"]+)"/g)) {
        const child = new Element(match[1]); child.id = match[2]; this.appendChild(child);
      }
    }
    get innerHTML() { return this._html || ''; }
    appendChild(child) { this.children.push(child); return child; }
    removeChild(child) { this.children = this.children.filter(c => c !== child); }
    setAttribute(k, v) { this.attrs[k] = v; }
    getAttribute(k) { return this.attrs[k]; }
    addEventListener(event, fn) { this.listeners[event] = fn; }
    querySelectorAll(selector) {
      const out = [];
      const matches = node => selector.startsWith('.')
        ? (node.className || '').split(' ').includes(selector.slice(1)) : node.tagName === selector;
      const walk = node => { for (const child of node.children) { if (matches(child)) out.push(child); walk(child); } };
      walk(this); return out;
    }
    querySelector(selector) {
      const [first, ...rest] = selector.split(' ');
      const match = this.querySelectorAll(first)[0];
      return rest.length ? match?.querySelector(rest.join(' ')) || null : match || null;
    }
    scrollIntoView() { this.scrolled = true; }
    select() {}
  }
  const slots = {
    PAGE_TITLE: 'Smoke test', EYEBROW: 'C1', HEADLINE: 'Smoke run', STANDFIRST: 'Test the build',
    FACTS_HTML: '', GATE_BODY: 'Verify the build', SECTIONS_JS: JSON.stringify([{ n: 1, title: 'App', steps: items }]),
    BUILD_SHA: build, CKPT_KEY: key, COPY_HEADER: 'C1 smoke run'
  };
  const html = generatedHTML ?? template.replace(/\{\{([A-Z_]+)\}\}/g, (_, name) => {
    assert.ok(Object.hasOwn(slots, name), 'Harness must fill slot ' + name); return slots[name];
  });
  for (const match of html.split('<script>')[0].matchAll(/<(\w+)[^>]*\bid="([^"]+)"/g)) {
    const el = new Element(match[1]); el.id = match[2];
  }
  const document = {
    createElement: tag => new Element(tag), getElementById: id => elements.get(id) || null,
    activeElement: null, body: new Element('body')
  };
  const window = { localStorage: { getItem: k => storage[k] || null, setItem: (k, v) => {
    storageWrites.push(k); storage[k] = v;
  } } };
  class PageDate extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  if (cloud) window.claude = { use: name => { cloudRequests.push(name); return Promise.resolve({
    collection: () => ({ onSnapshot: callback => { snapshot = callback; } }),
    doc: id => ({ set: body => { writes.push({ id, body: JSON.parse(JSON.stringify(body)) }); return Promise.resolve(); } })
  }); } };
  vm.runInNewContext(html.match(/<script>([\s\S]*?)<\/script>/)[1], {
    window, document, Date: PageDate,
    navigator: { clipboard: { writeText: value => { copied = value; return Promise.resolve(); } } },
    setTimeout: fn => { timers.set(++timerId, fn); return timerId; }, clearTimeout: id => timers.delete(id)
  });
  await Promise.resolve();
  const el = id => elements.get(id);
  return {
    storage, writes, cloudRequests, storageWrites, el,
    setTime(value) { now = value; },
    focus(n) { document.activeElement = el('note-' + n); },
    blur(n) { document.activeElement = null; el('note-' + n).listeners.blur?.(); },
    mark(n, status) {
      const button = status ? el('step-' + n).querySelectorAll('.vbtn').find(b => b.getAttribute('data-state') === status)
        : el('step-' + n).querySelector('.vclear');
      button.listeners.click();
    },
    note(n, value) { const field = el('note-' + n); field.value = value; field.listeners.input(); },
    flushTimers() { const pending = [...timers.values()]; timers.clear(); pending.forEach(fn => fn()); },
    copy() { el('btn-copy').listeners.click?.(); return copied; },
    next() { el('btn-next').listeners.click(); },
    record(n) { return JSON.parse(storage[key + '-run'] || '{}')[n]; },
    receive(records) { snapshot({ docs: records.map(data => ({ id: String(data.n), data: () => data })) }); }
  };
}

test('sidecar-built reissues preserve old verdicts while appends start unmarked', async () => {
  const { buildSmokePage } = await import(pathToFileURL(path.join(__dirname, '../orchestrate/tools/build-smoke-page.mjs')));
  const previous = { change: 'App', checkpoint: 1, batches: 'B01', branch: 'integration',
    buildSha: A, ckptKey: 'c1', gate: gateFor(A),
    sections: [{ n: 1, title: 'App', steps: steps() }] };
  const first = await page({ html: buildSmokePage(previous, template) });
  first.mark(1, 'pass'); first.mark(2, 'pass'); first.note(1, 'Original observation');
  const records = [first.record(1), first.record(2)];
  const current = structuredClone(previous); current.buildSha = B; current.gate = gateFor(B);
  current.sections[0].steps[0].do = 'Open checkout and confirm the repaired total';
  current.sections[0].steps[0].revision = 2;
  current.sections.push({ n: 2, title: 'New coverage', steps: [
    { n: 3, do: 'Open new feature', pass: 'It opens', revision: 1 }
  ] });
  const reissue = await page({ storage: first.storage,
    html: buildSmokePage(current, template, { previous }) });
  assert.deepEqual([reissue.record(1), reissue.record(2)], records);
  assert.equal(reissue.record(3), undefined);
  assert.equal(reissue.el('t-total').textContent, 3);
  assert.equal(reissue.el('t-carried').textContent, 1);
  assert.equal(reissue.el('t-rerun').textContent, 1);
  assert.equal(reissue.el('t-todo').textContent, 1);
  assert.match(reissue.copy(), /1\. NOT RE-RUN — previous PASS/);
  assert.match(reissue.copy(), /2\. PASS \(carried over from build a+\) — unchanged step/);
  assert.match(reissue.copy(), /3\. NOT RUN/);
  reissue.mark(3, 'pass');
  assert.equal(reissue.record(3).buildSha, B);
  assert.deepEqual(reissue.record(2), records[1], 'marking appended work cannot overwrite an old verdict');
});

// BL-022: a builder that scanned its own OUTPUT for `{{` could not publish a step whose
// command quotes a GitHub Actions expression. Bytes in the file are not enough — the
// expression has to survive the JSON embed and the script parse and land on the step the
// reader reads, so it is read back off the rendered DOM.
test('a step command carrying a doubled-brace expression reaches the reader', async () => {
  const { buildSmokePage } = await import(pathToFileURL(path.join(__dirname, '../orchestrate/tools/build-smoke-page.mjs')));
  const EXPRESSION = '${{ github.event.inputs.tag }}';
  const data = { change: 'Release workflow', checkpoint: 1, batches: 'B01', branch: 'integration',
    buildSha: A, ckptKey: 'c1', gate: gateFor(A),
    sections: [{ n: 1, title: 'Workflow', steps: [
      { n: 1, revision: 1, do: `Run <code>gh workflow run release.yml -f tag=${EXPRESSION}</code>.`,
        pass: `The run summary shows <code>${EXPRESSION}</code>.`,
        pre: { sha: A.slice(0, 7), stepRevision: 1, env: `GitHub runner, tag ${EXPRESSION}`,
          evidence: 'evidence/C1/step-01.md' } }] }] };
  const rendered = await page({ html: buildSmokePage(data, template) });
  const step = rendered.el('step-1');
  assert.ok(step.querySelector('.step-do').innerHTML.includes(EXPRESSION),
    'the command paragraph must carry the expression the sidecar wrote');
  assert.ok(step.querySelector('.step-pass').innerHTML.includes(EXPRESSION),
    'so must the acceptance criterion');
  assert.ok(step.querySelector('.step-pre-note').textContent.includes(EXPRESSION),
    'and the text the page composes itself, read as textContent');
});

test('real input reissue flows through builder, displayed files and saved verdicts on the same build', async t => {
  const { buildSmokePage } = await import(pathToFileURL(path.join(__dirname, '../orchestrate/tools/build-smoke-page.mjs')));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-input-page-'));
  t.after(() => fs.rmSync(root, { recursive: true, maxRetries: 8, retryDelay: 100 }));
  function put(name, bytes) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true }); fs.writeFileSync(path.join(root, name), bytes);
    return { path: name, size: Buffer.byteLength(bytes), sha256: createHash('sha256').update(bytes).digest('hex') };
  }
  const workbook = fs.readFileSync(path.join(__dirname, 'fixtures/smoke-inputs/orders.xlsx'));
  const file = put("evidence/C1/inputs/issue-001/orders & 'é'.xlsx", workbook);
  const proof = put('evidence/C1/inputs/validation-001/report & checks.txt', 'Independent requirements passed.\n');
  const input = { id: 'orders', ...file, requirements: 'Three sheets; leading-zero IDs; total 23.50/count 4. <literal>',
    validation: { ...proof, command: 'python validate-orders.py orders.xlsx orders.requirements.json', exitCode: 0,
      result: 'All workbook requirements passed.', env: 'Python with openpyxl, independent fixture validator' },
    mode: 'working-copy', use: 'Copy original to a temporary workbook; edit C2.', reset: 'Close copy, recopy original; total returns to 23.50.' };
  const previous = { change: 'Input handoff', checkpoint: 1, batches: 'B03', branch: 'integration', buildSha: A,
    ckptKey: 'c1', gate: { ...gateFor(A), checks: ['Verify build and canary.'] }, inputs: [input],
    sections: [{ n: 1, title: 'Workbook', steps: [
      { n: 1, revision: 1, do: 'Open workbook copy.', pass: 'Three sheets.', inputs: ['orders'] },
      { n: 2, revision: 1, do: 'Check unrelated feature.', pass: 'It opens.' },
      { n: 3, revision: 1, do: 'Validate input.', pass: 'All requirements pass.', inputs: ['orders'],
        pre: { sha: A, stepRevision: 1, env: 'Python', evidence: 'evidence/C1/step-03.md' } }
    ] }] };
  const options = { inputRoot: root };
  const first = await page({ html: buildSmokePage(previous, template, options) });
  const links = first.el('step-1').querySelectorAll('a');
  assert.equal(links.length, 2);
  assert.equal(links[0].textContent, file.path);
  assert.equal(links[0].getAttribute('href'), 'evidence/C1/inputs/issue-001/orders%20%26%20%27%C3%A9%27.xlsx');
  assert.equal(links[1].getAttribute('href'), 'evidence/C1/inputs/validation-001/report%20%26%20checks.txt');
  assert.deepEqual(fs.readFileSync(path.join(root, decodeURIComponent(links[0].getAttribute('href')))), workbook);
  const shown = first.el('step-1').querySelectorAll('.step-aside').map(p => p.textContent).join('\n');
  assert.match(shown, /Requirements:.*<literal>/, 'input metadata is plain text, never authored HTML');
  assert.ok(shown.includes(input.use)); assert.ok(shown.includes(input.reset));
  for (const text of [file.path, proof.path, input.requirements, input.use, input.reset, input.validation.command]) assert.ok(first.copy().includes(text), text);
  first.mark(1, 'pass'); first.note(1, 'Workbook observation');
  first.mark(2, 'pass'); first.note(2, 'Keep unrelated note');
  const oldRecords = [first.record(1), first.record(2)];
  const current = structuredClone(previous), updated = Buffer.from(workbook); updated[200] ^= 1;
  Object.assign(current.inputs[0], put('evidence/C1/inputs/issue-002/orders.xlsx', updated));
  current.inputHistory = [file];
  assert.throws(() => buildSmokePage(current, template, { ...options, previous }), /step 1:.*increment revision/);
  current.sections[0].steps[0].revision++;
  assert.throws(() => buildSmokePage(current, template, { ...options, previous }), /step 3:.*increment revision/);
  current.sections[0].steps[2].revision++;
  const reissue = await page({ storage: first.storage, html: buildSmokePage(current, template, { ...options, previous }) });
  assert.deepEqual([reissue.record(1), reissue.record(2)], oldRecords);
  assert.equal(reissue.el('t-rerun').textContent, 2);
  assert.equal(reissue.el('t-pass').textContent, 1);
  assert.equal(reissue.el('t-pre').textContent, 0);
  assert.match(reissue.copy(), /1\. NOT RE-RUN — previous PASS/);
  assert.match(reissue.copy(), /2\. PASS — Keep unrelated note/);
  assert.match(reissue.copy(), /3\. NOT RE-RUN.*agent evidence.*stale/);
  assert.ok(reissue.copy().includes(current.inputs[0].path));
  reissue.note(1, 'Note edit only'); assert.equal(reissue.el('t-rerun').textContent, 2);
  reissue.mark(1, 'pass'); assert.equal(reissue.el('t-rerun').textContent, 1);
  assert.equal(reissue.record(1).stepRevision, '2'); assert.equal(reissue.record(1).buildSha, A);
  assert.deepEqual(reissue.record(2), oldRecords[1]);
  assert.deepEqual(fs.readFileSync(path.join(root, file.path)), workbook, 'issued original stays untouched');
});

test('current verdict survives reload with build identity; selecting it twice still clears', async () => {
  const first = await page(); first.mark(1, 'pass'); first.note(1, 'Checked');
  const reload = await page({ storage: first.storage });
  assert.deepEqual(reload.record(1), { status: 'pass', note: 'Checked', buildSha: A, stepRevision: '1',
    at: '2026-09-18T12:00:00.001Z' });
  assert.equal(reload.el('t-pass').textContent, 1);
  assert.match(reload.copy(), new RegExp('Current build: ' + A));
  assert.match(reload.copy(), /1\. PASS — Checked/);
  reload.mark(1, 'pass'); assert.equal(reload.record(1).status, '');
});

test('repair retains history, requires affected step again, and preserves unaffected pass', async () => {
  const first = await page(); first.mark(1, 'pass'); first.mark(2, 'pass'); first.note(1, 'Original observation');
  const revised = steps(); revised[0].revision = 2;
  const repair = await page({ build: B, items: revised, storage: first.storage });
  assert.equal(repair.record(1).status, 'pass');
  assert.equal(repair.el('t-pass').textContent, 0);
  assert.equal(repair.el('t-carried').textContent, 1);
  assert.equal(repair.el('t-rerun').textContent, 1);
  assert.equal(repair.el('rc-1').textContent, '1/2');
  assert.equal(repair.el('step-1').getAttribute('data-status'), '');
  assert.match(repair.el('step-1').querySelector('.step-history').textContent, /Run it again/);
  repair.next(); assert.equal(repair.el('step-1').scrolled, true);
  assert.match(repair.copy(), /1\. NOT RE-RUN — previous PASS \(carried over from build a+/);
  assert.match(repair.copy(), /2\. PASS \(carried over from build a+\) — unchanged step/);
  assert.match(repair.copy(), /Current-build verdicts: passed 0/);
  repair.mark(1, 'pass'); // One click confirms the same verdict on the repaired build.
  assert.equal(repair.record(1).status, 'pass');
  assert.equal(repair.record(1).buildSha, B);
  assert.equal(repair.record(1).stepRevision, '2');
  assert.equal(repair.record(1).note, 'Original observation');
  assert.equal(repair.el('t-rerun').textContent, 0);
  assert.equal(repair.el('t-pass').textContent, 1);
});

test('a new build does not blanket-invalidate unchanged steps or change their verdicts', async () => {
  const first = await page(); first.mark(1, 'pass'); first.mark(2, 'blocked');
  const reissue = await page({ build: B, storage: first.storage });
  assert.equal(reissue.el('t-carried').textContent, 2);
  assert.equal(reissue.el('t-rerun').textContent, 0);
  assert.equal(reissue.el('rc-1').textContent, '2/2');
  assert.match(reissue.el('rc-1').className, /has-fail/);
  assert.match(reissue.copy(), /2\. BLOCKED \(carried over/);
  reissue.next(); assert.equal(reissue.el('step-1').scrolled, undefined);
  assert.equal(reissue.el('step-2').scrolled, undefined);
});

test('later re-issues retain an outstanding re-run until that step is actually tested', async () => {
  const first = await page(); first.mark(1, 'pass');
  const revised = steps(); revised[0].revision = 2;
  await page({ build: B, items: revised, storage: first.storage });
  const later = await page({ build: C, items: revised, storage: first.storage });
  assert.equal(later.el('t-rerun').textContent, 1);
  later.mark(1, 'pass');
  const cosmetic = await page({ build: C, items: revised, storage: first.storage });
  assert.equal(cosmetic.el('t-rerun').textContent, 0);
  assert.equal(cosmetic.el('t-pass').textContent, 1);
});

test('re-selecting an unchanged carried verdict records the current build in one click', async () => {
  const first = await page(); first.mark(1, 'pass');
  const reissue = await page({ build: B, storage: first.storage });
  reissue.mark(1, 'pass');
  assert.equal(reissue.record(1).status, 'pass');
  assert.equal(reissue.record(1).buildSha, B);
  assert.equal(reissue.el('t-carried').textContent, 0);
  assert.equal(reissue.el('t-pass').textContent, 1);
  assert.equal(reissue.el('step-1').querySelector('.step-history').hidden, true);
  assert.match(reissue.copy(), /1\. PASS\n/);
});

test('a corrected instruction requires a re-run even when the application SHA is unchanged', async () => {
  const first = await page(); first.mark(1, 'pass');
  const revised = steps(); revised[0].revision = 2;
  const corrected = await page({ items: revised, storage: first.storage });
  assert.equal(corrected.el('t-rerun').textContent, 1);
  corrected.mark(1, 'pass'); assert.equal(corrected.record(1).stepRevision, '2');
  assert.equal(corrected.record(1).status, 'pass');
});

test('editing a carried-over note never promotes its verdict to the new build', async () => {
  const first = await page(); first.mark(1, 'pass');
  const reissue = await page({ build: B, storage: first.storage, cloud: true });
  reissue.note(1, 'More context'); reissue.flushTimers();
  assert.equal(reissue.record(1).buildSha, A);
  assert.equal(reissue.writes.at(-1).body.buildSha, A);
  assert.equal(reissue.writes.at(-1).body.stepRevision, '1');
  assert.match(reissue.copy(), /carried over from build a+/);
});

test('artifact database round trip retains build and step revision', async () => {
  const first = await page({ cloud: true }); first.mark(1, 'pass');
  const oldDoc = first.writes.at(-1).body;
  const revised = steps(); revised[0].revision = 2;
  const repair = await page({ build: B, items: revised, cloud: true });
  repair.receive([oldDoc]); assert.equal(repair.el('t-rerun').textContent, 1);
  repair.mark(1, 'pass');
  const newDoc = repair.writes.at(-1).body;
  assert.equal(newDoc.buildSha, B); assert.equal(newDoc.stepRevision, '2');
  const anotherDevice = await page({ build: B, items: revised, cloud: true });
  anotherDevice.receive([newDoc]);
  assert.equal(anotherDevice.el('t-pass').textContent, 1);
  assert.equal(anotherDevice.el('t-rerun').textContent, 0);
});

test('agent re-verification supersedes an old revision while a fresh human verdict still wins', async () => {
  const first = await page(); first.mark(1, 'fail');
  const revised = steps(); revised[0].revision = 2;
  revised[0].pre = { sha: B, stepRevision: 2, env: 'fixture', evidence: 'evidence/C1/step-01.md' };
  const repair = await page({ build: B, items: revised, storage: first.storage });
  assert.equal(repair.el('t-pre').textContent, 1);
  assert.equal(repair.el('t-fail').textContent, 0);
  assert.equal(repair.el('t-rerun').textContent, 0);
  assert.match(repair.copy(), /pre-verified by agent @b+; previous FAIL \(carried over/);
  repair.mark(1, 'fail'); assert.equal(repair.el('t-fail').textContent, 1);
  assert.equal(repair.el('t-pre').textContent, 0);
});

test('unknown provenance is kept as history, never guessed to be the current build', async () => {
  const storage = { 'c1-run': JSON.stringify({ 1: { status: 'pass', note: 'Earlier result' } }) };
  const current = await page({ storage });
  assert.equal(current.el('t-pass').textContent, 0);
  assert.equal(current.el('t-rerun').textContent, 1);
  assert.match(current.copy(), /NOT RE-RUN — previous PASS \(carried over from build unknown\)/);
});

test('partially missing provenance also requires re-verification', async () => {
  const current = await page({ cloud: true });
  current.receive([
    { n: 1, status: 'pass', stepRevision: '1' },
    { n: 2, status: 'pass', buildSha: A }
  ]);
  assert.equal(current.el('t-pass').textContent, 0);
  assert.equal(current.el('t-carried').textContent, 0);
  assert.equal(current.el('t-rerun').textContent, 2);
});

test('new checkpoints keep independent verdict storage', async () => {
  const first = await page(); first.mark(1, 'pass');
  const next = await page({ key: 'c2', storage: first.storage });
  assert.equal(next.el('t-todo').textContent, 2);
  assert.equal(next.el('t-carried').textContent, 0);
});

test('every template slot is documented in the smoke-page reference', () => {
  const doc = fs.readFileSync(path.join(__dirname, '../orchestrate/references/smoke-page.md'), 'utf8');
  const slots = text => [...new Set([...text.matchAll(/\{\{([A-Z_]+)\}\}/g)].map(m => m[1]))].sort();
  assert.deepEqual(slots(template), slots(doc));
});

test('stale agent evidence cannot complete a changed step, including a correction on the same build', async () => {
  for (const build of [A, B]) {
    for (const humanVerdict of [false, true]) {
      const first = await page();
      if (humanVerdict) first.mark(1, 'fail');
      const revised = steps(); revised[0].revision = 2;
      revised[0].pre = { sha: A.slice(0, 7), stepRevision: 1, env: 'fixture', evidence: 'old.md' };
      const repair = await page({ build, items: revised, storage: first.storage });
      assert.equal(repair.el('t-pre').textContent, 0);
      assert.equal(repair.el('t-rerun').textContent, 1);
      assert.equal(repair.el('rc-1').textContent, '0/2');
      assert.doesNotMatch(repair.el('step-1').className, /step-pre/);
      assert.match(repair.el('step-1').querySelector('.step-pre-note').textContent, /does not count as verification/);
      assert.doesNotMatch(repair.el('step-1').querySelector('.step-history').textContent, /since been re-verified/);
      repair.next(); assert.equal(repair.el('step-1').scrolled, true);
      assert.match(repair.copy(), /1\. NOT RE-RUN/);
      assert.doesNotMatch(repair.copy(), /pre-verified by agent @/);
      repair.mark(1, 'pass');
      assert.equal(repair.el('t-rerun').textContent, 0);
      assert.equal(repair.el('t-pass').textContent, 1);
    }
  }
});

test('current agent evidence accepts short or full SHAs with an explicit matching revision', async () => {
  for (const sha of [B.slice(0, 7), B]) {
    const items = steps(); items[0].revision = 2;
    items[0].pre = { sha, stepRevision: 2, env: 'fixture', evidence: 'fresh.md' };
    const current = await page({ build: B, items });
    assert.equal(current.el('t-pre').textContent, 1);
    assert.equal(current.el('t-rerun').textContent, 0);
    assert.match(current.el('step-1').className, /step-pre/);
    assert.match(current.copy(), /1\. pre-verified by agent @b+/);
    assert.doesNotMatch(current.copy(), /carried over; unchanged step/);
  }
});

test('unchanged agent evidence survives subsequent builds and is explicitly labeled carried over', async () => {
  const items = steps();
  items[0].pre = { sha: A.slice(0, 7), stepRevision: 1, env: 'fixture', evidence: 'original.md' };
  for (const build of [B, C]) {
    const reissue = await page({ build, items });
    assert.equal(reissue.el('t-pre').textContent, 1);
    assert.equal(reissue.el('t-rerun').textContent, 0);
    assert.equal(reissue.el('rc-1').textContent, '1/2');
    assert.match(reissue.el('step-1').querySelector('.tag-pre').textContent, /carried over/);
    assert.match(reissue.copy(), /pre-verified by agent @a+ \(carried over; unchanged step\)/);
    reissue.next(); assert.equal(reissue.el('step-1').scrolled, undefined);
    reissue.mark(1, 'fail');
    assert.equal(reissue.el('t-pre').textContent, 0);
    assert.equal(reissue.el('t-fail').textContent, 1);
  }
});

test('incomplete agent evidence is historical only, even with the current build SHA', async () => {
  const valid = { sha: A, stepRevision: 1, env: 'fixture', evidence: 'proof.md' };
  for (const patch of [{ stepRevision: undefined }, { stepRevision: 0 }, { sha: '' },
    { sha: '{{BUILD_SHA}}' }, { sha: 'xyz1234' }, { sha: 'aaa' }, { evidence: '' }, { env: '' }]) {
    const items = steps(); items[0].pre = { ...valid, ...patch };
    const current = await page({ items });
    assert.equal(current.el('t-pre').textContent, 0, JSON.stringify(patch));
    assert.equal(current.el('t-rerun').textContent, 1);
    assert.match(current.copy(), /1\. NOT RE-RUN/);
  }
});

test('invalid page build identities block verdict collection and leave saved records untouched', async () => {
  for (const build of ['{{BUILD_SHA}}', '', A.slice(0, 7), 'g'.repeat(40), 'a'.repeat(39), 'a'.repeat(41), A + ' ']) {
    const storage = { 'c1-run': JSON.stringify({ 1: { status: 'pass', buildSha: build, stepRevision: '1' } }) };
    const before = JSON.stringify(storage);
    const invalid = await page({ build, storage, cloud: true });
    assert.equal(invalid.el('run-error').hidden, false, build);
    assert.match(invalid.el('run-error-text').textContent, /corrected smoke page/);
    assert.equal(invalid.el('btn-copy').disabled, true);
    assert.equal(invalid.el('btn-next').disabled, true);
    assert.equal(invalid.el('step-1'), undefined);
    assert.equal(invalid.copy(), '');
    assert.equal(invalid.cloudRequests.length, 0);
    assert.equal(invalid.writes.length, 0);
    assert.equal(JSON.stringify(storage), before);
  }
});

test('valid full build identities work with either Git hash length and normalized casing', async () => {
  for (const build of [A.toUpperCase(), 'b'.repeat(64)]) {
    const first = await page({ build }); first.mark(1, 'pass');
    const current = await page({ build: build.toLowerCase(), storage: first.storage });
    assert.equal(current.el('t-pass').textContent, 1);
    assert.match(current.copy(), /1\. PASS\n/);
  }
});

test('records with an invalid saved build identity cannot count as carried-over passes', async () => {
  const current = await page({ cloud: true });
  current.receive([
    { n: 1, status: 'pass', buildSha: '{{BUILD_SHA}}', stepRevision: '1' },
    { n: 2, status: 'pass', buildSha: 'not-a-sha', stepRevision: '1' }
  ]);
  const reload = await page({ storage: current.storage });
  assert.equal(reload.el('t-pass').textContent, 0);
  assert.equal(reload.el('t-carried').textContent, 0);
  assert.equal(reload.el('t-rerun').textContent, 2);
});

test('a delayed pass snapshot cannot overwrite a newer local failure, including after reload', async () => {
  const first = await page({ cloud: true }); first.mark(1, 'pass');
  const stale = first.writes.at(-1).body;
  first.mark(1, 'fail'); first.note(1, 'Checkout crashes');
  const latest = first.record(1), saves = first.storageWrites.length;
  first.receive([stale]);
  assert.deepEqual(first.record(1), latest);
  assert.equal(first.storageWrites.length, saves);
  assert.match(first.copy(), /1\. FAIL — Checkout crashes/);
  const reload = await page({ cloud: true, storage: first.storage });
  reload.receive([stale]);
  assert.deepEqual(reload.record(1), latest);
  assert.equal(reload.storageWrites.length, 0);
  assert.equal(reload.el('t-fail').textContent, 1);
});

test('verdict clears remain newer than saved passes even within one millisecond', async () => {
  for (const clear of ['', 'pass']) {
    const current = await page({ cloud: true }); current.mark(1, 'pass');
    const pass = current.writes.at(-1).body;
    current.mark(1, clear);
    const cleared = current.record(1);
    assert.ok(Date.parse(cleared.at) > Date.parse(pass.at));
    assert.equal(cleared.status, '');
    current.receive([pass]);
    assert.deepEqual(current.record(1), cleared);
    assert.match(current.copy(), /1\. NOT RUN/);
  }
});

test('note edits are stamped immediately and delayed persistence sends that exact timestamp', async () => {
  const current = await page({ cloud: true }); current.mark(1, 'fail');
  const old = current.writes.at(-1).body;
  current.note(1, 'New diagnosis'); current.note(1, '');
  const clearedNote = current.record(1);
  assert.ok(Date.parse(clearedNote.at) > Date.parse(old.at));
  current.receive([old]);
  assert.equal(current.el('note-1').value, '');
  current.setTime(Date.parse('2026-09-18T13:00:00.000Z'));
  current.flushTimers();
  assert.equal(current.writes.at(-1).body.at, clearedNote.at);
  assert.equal(current.writes.at(-1).body.note, '');
});

test('equal, missing, malformed, and empty snapshots never rewrite an existing local result', async () => {
  const current = await page({ cloud: true }); current.mark(1, 'fail');
  const latest = current.record(1), saves = current.storageWrites.length;
  for (const at of [latest.at, undefined, 'bad timestamp']) {
    current.receive([{ n: 1, ...latest, status: 'pass', note: 'Old observation', at }]);
    assert.deepEqual(current.record(1), latest);
  }
  current.receive([current.writes.at(-1).body]);
  current.receive([]);
  assert.equal(current.storageWrites.length, saves);
});

test('genuinely newer remote results replace the entire record and survive an older echo', async () => {
  const current = await page({ cloud: true }); current.mark(1, 'fail');
  const old = current.writes.at(-1).body, saves = current.storageWrites.length;
  const newer = { n: 1, status: 'pass', note: 'Verified elsewhere', buildSha: B, stepRevision: '2',
    at: '2026-09-18T12:00:01.000Z' };
  current.receive([newer]);
  assert.deepEqual(current.record(1), { status: newer.status, note: newer.note, buildSha: B,
    stepRevision: '2', at: newer.at });
  assert.equal(current.el('t-rerun').textContent, 1); // The remote build identity is not rewritten.
  assert.equal(current.el('note-1').value, 'Verified elsewhere');
  assert.equal(current.storageWrites.length, saves + 1);
  current.receive([old]);
  assert.equal(current.record(1).at, newer.at);
  assert.equal(current.storageWrites.length, saves + 1);
  current.setTime(Date.parse('2026-09-17T00:00:00.000Z')); // Clock moved backwards.
  current.mark(1, 'fail');
  assert.ok(Date.parse(current.record(1).at) > Date.parse(newer.at));
});

test('a newer remote edit waits for note blur and is applied without combining two records', async () => {
  const current = await page({ cloud: true }); current.mark(1, 'fail');
  current.focus(1); current.note(1, 'Local draft');
  const draft = current.record(1), saves = current.storageWrites.length;
  const remote = { n: 1, status: 'blocked', note: 'Other device', buildSha: B, stepRevision: '2',
    at: '2026-09-18T12:00:01.000Z' };
  current.receive([remote]);
  assert.deepEqual(current.record(1), draft);
  assert.equal(current.el('note-1').value, 'Local draft');
  assert.equal(current.storageWrites.length, saves);
  current.flushTimers();
  assert.equal(current.writes.length, 1); // Do not send the superseded debounced draft.
  current.blur(1);
  assert.equal(current.record(1).status, 'blocked');
  assert.equal(current.record(1).note, 'Other device');
  assert.equal(current.record(1).buildSha, B);
  assert.equal(current.record(1).at, remote.at);
  assert.equal(current.el('note-1').value, 'Other device');
});

test('continued typing advances beyond a deferred remote update and preserves the local verdict', async () => {
  const current = await page({ cloud: true }); current.mark(1, 'fail');
  current.focus(1); current.note(1, 'Draft');
  const remote = { n: 1, status: 'pass', note: 'Other device', buildSha: B, stepRevision: '2',
    at: '2026-09-18T12:00:01.000Z' };
  current.receive([remote]);
  current.note(1, 'Draft completed after that update');
  const latest = current.record(1);
  assert.ok(Date.parse(latest.at) > Date.parse(remote.at));
  current.blur(1); current.flushTimers();
  assert.deepEqual(current.record(1), latest);
  assert.equal(current.writes.at(-1).body.status, 'fail');
  assert.equal(current.writes.at(-1).body.buildSha, A);
  assert.equal(current.writes.at(-1).body.at, latest.at);
  current.receive([remote]);
  assert.deepEqual(current.record(1), latest);
});
