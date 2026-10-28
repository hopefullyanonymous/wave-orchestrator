'use strict';
// build-ruling-page.mjs builds the ruling page from its sidecar, prints the LOG.md ruling list and
// checks the user's paste. The sidecar is the example references/ruling-page.md publishes, and every
// paste read here is the one the built page's own script writes, run in a small DOM, so the page,
// the tool and the document cannot drift apart. Every rule has a case it alone decides, each beside
// a control that passes, and every sweep collects its faults before asserting once.
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');

const ROOT = path.resolve(__dirname, '..');
const SKILL_DIR = path.join(ROOT, 'orchestrate');
const TOOL = path.join(SKILL_DIR, 'tools', 'build-ruling-page.mjs');
const DOC = 'orchestrate/references/ruling-page.md', PROTOCOL = 'orchestrate/references/protocol.md';
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const load = () => import(pathToFileURL(TOOL).href);
const template = () => read('orchestrate/references/ruling-page-template.html');
const clone = v => JSON.parse(JSON.stringify(v));

function tmp(t) {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'ruling-page-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }));
  return dir;
}
function run(args, cwd) {
  const r = spawnSync(process.execPath, [TOOL, ...args], { cwd, encoding: 'utf8', windowsHide: true, timeout: 60000 });
  assert.ifError(r.error);
  return { status: r.status, stdout: r.stdout.replace(/\r\n/g, '\n'), stderr: r.stderr };
}
// The one JSON block of §Sidecar shape, as published.
function example() {
  const text = read(DOC), start = text.indexOf('\n## Sidecar shape\n'), end = text.indexOf('\n## ', start + 1);
  assert.ok(start >= 0, DOC + ' must hold §Sidecar shape');
  const blocks = [...text.slice(start, end).matchAll(/```json\n([\s\S]*?)```/g)];
  assert.equal(blocks.length, 1, '§Sidecar shape holds one json block');
  return JSON.parse(blocks[0][1]);
}

// ===== A DOM just large enough for the page's script =============================================
class Node {
  constructor(tag) { Object.assign(this, { tagName: tag, children: [], parent: null, attrs: {}, listeners: {}, className: '', hidden: false, value: '', checked: false, id: '' }); this._text = ''; }
  get textContent() { return this._text + this.children.map(c => c.textContent ?? c.text).join(''); }
  set textContent(v) { this._text = v; this.children = []; }
  get classList() { return { toggle: () => {} }; }
  append(...kids) { for (const k of kids) { k.parent = this; this.children.push(k); } }
  setAttribute(k, v) { this.attrs[k] = v; }
  addEventListener(type, f) { (this.listeners[type] ||= []).push(f); }
  fire(type) { for (const f of this.listeners[type] || []) f(); }
  remove() { const p = this.parent; if (p) p.children = p.children.filter(c => c !== this); }
  focus() {} select() {}
  *walk() { yield this; for (const c of this.children) if (c instanceof Node) yield* c.walk(); }
  querySelector(sel) { for (const n of this.walk()) if (n !== this && n.className.split(' ').includes(sel.slice(1))) return n; return null; }
}
// The built page's script run against that DOM; `storage` stands in for localStorage, or throws.
function pageOf(html, storage = new Map()) {
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  assert.equal(scripts.length, 1, 'the page carries one script');
  const fixed = {};
  for (const id of ['eyebrow', 'headline', 'strip', 'groups', 'note', 'copy', 'status', 'copybox']) fixed[id] = Object.assign(new Node('div'), { id });
  const root = new Node('body');
  root.append(...Object.values(fixed));
  const document = {
    createElement: tag => new Node(tag), createTextNode: text => ({ text }),
    getElementById: id => { for (const n of root.walk()) if (n.id === id) return n; return null; }
  };
  const localStorage = storage === 'throws'
    ? { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } }
    : { getItem: k => storage.has(k) ? storage.get(k) : null, setItem: (k, v) => storage.set(k, String(v)) };
  const ctx = vm.createContext({ document, localStorage, navigator: {} });
  vm.runInContext(scripts[0][1], ctx);
  const nodes = () => [...root.walk()];
  return {
    ctx, root,
    radios: id => nodes().filter(n => n.tagName === 'input' && n.name === 'r-' + id).map(n => n.value),
    pick(id, value) {
      const n = nodes().find(x => x.tagName === 'input' && x.name === 'r-' + id && x.value === value);
      assert.ok(n, `the page offers ${id} the choice ${value}`);
      n.checked = true; n.fire('change');
    },
    note(id, text) { const n = document.getElementById('note-' + id); n.value = text; n.fire('input'); },
    general(text) { fixed.note.value = text; },
    paste: () => ctx.text()
  };
}

test('the example sidecar of ruling-page.md builds the same bytes every time, every slot filled, its key in the page', async () => {
  const { buildRulingPage, pageKeyOf } = await load();
  const data = example(), html = buildRulingPage(data, template());
  assert.equal(buildRulingPage(clone(data), template()), html);
  assert.doesNotMatch(html, /\{\{[A-Z_]+\}\}/);
  assert.match(html, /<title>Example change Rulings<\/title>/);
  assert.ok(html.includes('"pageKey":"' + pageKeyOf(data) + '"'));
  // Key order is not content; a value is.
  const reordered = Object.fromEntries(Object.entries(data).reverse());
  assert.equal(pageKeyOf(reordered), pageKeyOf(data));
  const edited = clone(data); edited.items[0].what += '.';
  assert.notEqual(pageKeyOf(edited), pageKeyOf(data));
  // The template's self-check refuses a stray brace pair, beside the real template that passes.
  assert.throws(() => buildRulingPage(data, template() + '{{ x }}'), /self-check failed/);
  assert.throws(() => buildRulingPage(data, template().replace('{{PAGE_TITLE}}', '{{PAGE_NAME}}')), /cannot fill: \{\{PAGE_NAME\}\}/);
});

test('the page offers each row exactly the choices read accepts, and Fix now only on a prose-only residual', async () => {
  const { buildRulingPage, choicesOf } = await load();
  const data = example(), page = pageOf(buildRulingPage(data, template()));
  const faults = [];
  for (const it of data.items) {
    const want = it.ruled === undefined ? choicesOf(it) : [];
    if (JSON.stringify(page.radios(it.id)) !== JSON.stringify(want)) faults.push(`${it.id}: ${page.radios(it.id)} != ${want}`);
  }
  assert.deepEqual(faults, []);
  assert.deepEqual(page.radios('R01'), ['fix', 'register', 'accept', 'decline', 'log']);
  assert.deepEqual(page.radios('R02'), ['register', 'accept', 'decline', 'log']);
  assert.deepEqual(page.radios('TD-009'), ['keep', 'drop', 'accept', 'decline']);
  assert.deepEqual(page.radios('P1'), ['take', 'skip']);
  assert.deepEqual(page.radios('SCAN-3'), []);
});

test("the page's own copy text reads back through read: every pick, note and the general note as given", async t => {
  const { buildRulingPage, readLines, pageKeyOf } = await load();
  const data = example(), page = pageOf(buildRulingPage(data, template()));
  const untouched = page.paste();
  assert.equal(untouched.split('\n')[1], 'All 5 on proposal.');
  assert.deepEqual(readLines(data, untouched).lines, [`RULINGS OK 5 item(s), page ${pageKeyOf(data)}, 0 changed from proposal`,
    'FIX R01', 'REGISTER R02', 'DECLINE R03', 'KEEP TD-009', 'SKIP P1']);
  page.pick('R02', 'accept'); page.pick('TD-009', 'drop');
  page.note('R02', '  we live with it\nfor now '); page.note('R03', 'nobody asked');
  page.general('thanks\nall');
  const paste = page.paste();
  assert.deepEqual(readLines(data, paste).lines, [`RULINGS OK 5 item(s), page ${pageKeyOf(data)}, 2 changed from proposal`,
    'FIX R01', 'ACCEPT R02', 'DECLINE R03', 'DROP TD-009', 'SKIP P1', 'CHANGED R02 TD-009', 'NOTED R02 R03', 'NOTE thanks all']);
  // The same text through CRLF, as a Windows clipboard or checkout hands it over.
  assert.deepEqual(readLines(data, paste.replace(/\n/g, '\r\n')).lines, readLines(data, paste).lines);
  // The picks and notes survive a reload of the same page, and a page whose storage throws still works.
  const storage = new Map(), first = pageOf(buildRulingPage(data, template()), storage);
  first.pick('P1', 'take'); first.note('P1', 'next phase');
  assert.match(pageOf(buildRulingPage(data, template()), storage).paste(), /\nP1: Take as a pack — note: next phase$/m);
  assert.match(pageOf(buildRulingPage(data, template()), 'throws').paste(), /\nP1: Skip$/m);
  // A stored pick the row does not offer is never shown as a ruling: the row reads its proposal.
  const forged = new Map([[`${data.storageKey}:${pageKeyOf(data)}:picks`, JSON.stringify({ R02: 'fix', P1: 'take' })]]);
  assert.match(pageOf(buildRulingPage(data, template()), forged).paste(), /\nR02: Register\n[\s\S]*\nP1: Take as a pack$/m);
  // An edited sidecar is another page: its saved picks do not carry over.
  const edited = clone(data); edited.items[4].what += '.';
  assert.match(pageOf(buildRulingPage(edited, template()), storage).paste(), /\nP1: Skip$/m);
  t.diagnostic(paste);
});

test("a row's text cannot end the page's script, and reaches the paste as written", async () => {
  const { buildRulingPage, readLines } = await load();
  const data = example();
  data.items[1].what = 'A </script><b>tag</b> & "quote"';
  data.pageTitle = '<Cart> & co';
  const html = buildRulingPage(data, template());
  assert.equal(html.split('</script>').length, template().split('</script>').length);
  assert.match(html, /<title>&lt;Cart&gt; &amp; co<\/title>/);
  const page = pageOf(html);
  page.pick('R02', 'log');
  const paste = page.paste();
  assert.ok(paste.includes('R02 LOG only (proposed Register) — A </script><b>tag</b> & "quote"'));
  assert.equal(readLines(data, paste).code, 0);
});

test('the sidecar is refused for each rule broken, and the example beside them passes', async () => {
  const { validate } = await load();
  assert.doesNotThrow(() => validate(example()));
  const cases = [
    [d => { d.items[1].proposal = 'fix'; }, /fix is offered only on a proseOnly residual/],
    [d => { d.items[0].proseOnly = false; }, /item R01: proposal must be one of register/],
    [d => { d.items[3].proseOnly = true; }, /proseOnly is a boolean, on a residual only/],
    [d => { delete d.items[1].entry.failure; }, /item R02: a register proposal needs entry failure/],
    [d => { delete d.items[2].entry.rulingId; }, /item R03: a decline proposal needs entry rulingId/],
    [d => { d.items[2].entry.files = []; }, /entry.files must name at least one path/],
    [d => { d.items[1].entry.kind = 'bug'; }, /entry.kind must be one of/],
    [d => { d.extra = 1; }, /the sidecar has unknown key\(s\): extra/],
    [d => { d.items[0].note = 'x'; }, /items\[0\] has unknown key\(s\): note/],
    [d => { d.items[1].entry.since = 'x'; }, /entry has unknown key\(s\): since/],
    [d => { d.items[1].id = 'R01'; }, /item R01 is listed twice/],
    [d => { d.items[1].id = '-R2'; }, /items\[1\].id must be/],
    [d => { d.items[0].group = 'nope'; }, /group nope is not in groups/],
    [d => { d.groups[1].key = 'fix'; }, /group fix is defined twice/],
    [d => { d.items[5].proposal = 'log'; }, /an already ruled row takes no proposal/],
    [d => { d.items = [d.items[5]]; }, /at least one row to rule/],
    [d => { d.date = '2026-02-30'; }, /date must be a YYYY-MM-DD calendar date/],
    [d => { d.storageKey = 'a key'; }, /storageKey must be/],
    [d => { d.items[0].what = 'two\nlines'; }, /what must be one line/],
    [d => { delete d.items[0].source; }, /source must be a non-empty string/],
    [d => { d.items[4].proposal = 'keep'; }, /item P1: proposal must be one of take, skip/],
    [d => { d.items[3].kind = 'bug'; }, /kind must be one of residual, expired, pack/],
  ];
  const faults = [];
  for (const [edit, want] of cases) {
    const d = example(); edit(d);
    try { validate(d); faults.push(`${want}: accepted`); } catch (e) { if (!want.test(e.message)) faults.push(`${want}: ${e.message}`); }
  }
  assert.deepEqual(faults, []);
});

test('read refuses a paste from another page, a row missing, twice, unknown or already ruled, and an outcome the row does not offer', async () => {
  const { buildRulingPage, readPaste } = await load();
  const data = example(), good = pageOf(buildRulingPage(data, template())).paste();
  assert.equal(readPaste(data, good).problems, undefined);
  const edited = clone(data); edited.items[0].what += '.';
  const other = pageOf(buildRulingPage(edited, template())).paste();
  const cases = [
    [other, /the paste comes from page [0-9a-f]{12}; this sidecar builds page/],
    ['Thanks!\n' + good, /does not open with the page's header line/],
    [good.replace('\nP1: Skip', ''), /^P1 has no outcome in the full list$/],
    [good.replace('P1: Skip', 'P1: Skip\nP1: Take as a pack'), /^P1 is ruled twice$/],
    [good.replace('P1: Skip', 'P1: Skip\nR99: Skip'), /^R99 is no row of this page$/],
    [good.replace('P1: Skip', 'P1: Skip\nSCAN-3: Register'), /^SCAN-3 was already ruled/],
    [good.replace('R02: Register', 'R02: Fix now'), /^R02: Fix now is not a choice for this row$/],
    [good.replace('R02: Register', 'R02: Registered'), /^R02: "Registered" names no outcome$/],
    [good.replace('R02: Register', 'R02 Register'), /is not <id>: <outcome>/],
    [good.replace('Full list:', 'All of them:'), /holds "Full list:" 0 times/],
    [good.replace('All 5 on proposal.', '4 on proposal, 1 changed:\nR02 Accept (proposed Register) — x'), /^R02: the changed line says Accept, the full list Register$/],
  ];
  const faults = [];
  for (const [paste, want] of cases) {
    const r = readPaste(data, paste);
    if (!r.problems) faults.push(`${want}: accepted`);
    else if (!r.problems.some(p => want.test(p))) faults.push(`${want}: ${r.problems.join(' | ')}`);
  }
  assert.deepEqual(faults, []);
});

test('read --entries prints entries the real backlog.mjs reads, and names each the sidecar cannot fill', async t => {
  const { buildRulingPage, readLines } = await load();
  const data = example(), page = pageOf(buildRulingPage(data, template()));
  page.note('R03', 'the parser works and nobody asked for it');
  const out = readLines(data, page.paste(), { entries: true, today: '2026-03-21' });
  assert.equal(out.code, 0, out.lines.join('\n'));
  assert.equal(out.lines.find(l => l.startsWith('ENTRIES')), 'ENTRIES OK 1 backlog, 1 rulings');
  const at = name => out.lines.indexOf(name);
  const backlog = out.lines.slice(at('--- backlog entries') + 1, at('--- rulings entries'));
  const rulings = out.lines.slice(at('--- rulings entries') + 1);
  assert.equal(backlog[0], '### TD-016 — A cart total drops the discount on a reload');
  assert.ok(backlog.includes('Since: 2026-03-21 — XY-20260301-cart B02 round 1'));
  assert.ok(rulings.includes('Ruling: declined — 2026-03-21'));
  assert.ok(rulings.includes('Reason: "the parser works and nobody asked for it"'));
  // The real consumer: backlog.mjs over files holding its form line and the printed entries.
  const dir = tmp(t), backlogMjs = path.join(SKILL_DIR, 'tools', 'backlog.mjs');
  fs.writeFileSync(path.join(dir, 'BACKLOG.md'), ['Form: orchestrate backlog v1', '', ...backlog].join('\n'));
  fs.writeFileSync(path.join(dir, 'RULINGS.md'), ['Form: orchestrate rulings v1', '', ...rulings].join('\n'));
  const node = args => spawnSync(process.execPath, [backlogMjs, ...args], { cwd: dir, encoding: 'utf8', windowsHide: true });
  assert.equal(node(['check', '--backlog', 'BACKLOG.md']).stdout.trim(), 'BACKLOG OK 1 item(s)');
  assert.equal(node(['rulings', '--rulings', 'RULINGS.md', '--paths', 'src/coupons/parse.js']).stdout.trim(),
    'RULINGS 1 ruling(s) on those paths\nRL-006 declined 2026-03-21: src/coupons/parse.js');
  // A row ruled to an outcome its entry cannot fill, and a path only the form's own reader refuses.
  const regR03 = pageOf(buildRulingPage(data, template())); regR03.pick('R03', 'register');
  const missing = readLines(data, regR03.paste(), { entries: true });
  assert.equal(missing.code, 1);
  assert.match(missing.lines.at(-1), /^ENTRIES FAIL 1 problem\(s\): R03: Register needs entry id, kind, tests, failure, doneWhen, from in the sidecar$/);
  const absolute = clone(data); absolute.items[1].entry.files = ['/src/cart/total.js'];
  const bad = readLines(absolute, pageOf(buildRulingPage(absolute, template())).paste(), { entries: true });
  assert.equal(bad.code, 1);
  assert.match(bad.lines.at(-1), /^ENTRIES FAIL 1 problem\(s\): backlog entry TD-016: Files: is not/);
  // A decline with no note says so in its reason, and an accept is written accepted.
  const plain = pageOf(buildRulingPage(data, template())); plain.pick('R02', 'accept');
  const lines = readLines(data, plain.paste(), { entries: true }).lines;
  assert.ok(lines.includes('Reason: "Decline" on the ruling page, no note given'));
  assert.ok(lines.includes('Ruling: accepted — 2026-03-20'));
  assert.ok(!lines.includes('--- backlog entries'));
});

test('list prints the Ruling list block: one line per row, its proposal and its source', async () => {
  const { rulingList, pageKeyOf } = await load();
  const data = example(), lines = rulingList(data, 'ruling.json');
  assert.deepEqual(lines.slice(0, 3), ['### Ruling list', '', `Sidecar \`ruling.json\`, page ${pageKeyOf(data)}: 5 item(s) to rule, 1 already ruled.`]);
  const rows = lines.slice(4);
  assert.equal(rows.length, data.items.length);
  assert.equal(rows[0], "- R01 (residual, proposed Fix now): The cart total's header says every total is rounded — from ### prose sweep: B02 R1 SWEEP 1");
  assert.equal(rows[5], '- SCAN-3 (residual, already ruled: Leave open, high priority): A refund can show as not refunded — from ### residual: B04 R1 — refund read');
  // No row line opens a heading of its own, so LOG.md's heading readers never meet one.
  assert.ok(rows.every(r => r.startsWith('- ')));
});

test('the CLI: help, invalid invocations exit 2, a refusal or a FAIL exits 1', t => {
  const dir = tmp(t);
  fs.writeFileSync(path.join(dir, 'ruling.json'), JSON.stringify(example(), null, 2));
  const help = run(['--help'], dir);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /^usage: build-ruling-page\.mjs build .* \| list .* \| read /);
  const faults = [];
  for (const args of [[], ['nope', 'ruling.json'], ['list'], ['list', 'ruling.json', 'x'], ['build', 'ruling.json'],
    ['build', 'ruling.json', 'out.html', '--entries'], ['list', 'ruling.json', '--template', 'x'], ['read', 'ruling.json', 'p.txt', '--today', '2026-13-01'],
    ['list', 'ruling.json', '--bogus'], ['list', 'ruling.json', '--help']]) {
    const r = run(args, dir);
    if (r.status !== 2) faults.push(args.join(' ') + ' → ' + r.status);
  }
  assert.deepEqual(faults, []);
  assert.equal(run(['list', 'ruling.json'], dir).status, 0);
  const over = run(['build', 'ruling.json', 'ruling.json'], dir);
  assert.equal(over.status, 1);
  assert.match(over.stderr, /output must not overwrite an input/);
  fs.writeFileSync(path.join(dir, 'p.txt'), 'hello\n');
  const fail = run(['read', 'ruling.json', 'p.txt'], dir);
  assert.equal(fail.status, 1);
  assert.match(fail.stdout, /^RULINGS FAIL 1 problem\(s\)/);
  fs.writeFileSync(path.join(dir, 'broken.json'), '{');
  assert.equal(run(['list', 'broken.json'], dir).status, 1);
});

test('every build-ruling-page.mjs command protocol.md and ruling-page.md publish runs as published, in order', t => {
  const dir = tmp(t), ledger = path.join(dir, 'ledger');
  fs.mkdirSync(ledger);
  fs.writeFileSync(path.join(ledger, 'ruling.json'), JSON.stringify(example(), null, 2));
  const COMMAND = /`node "<skill-dir>\/tools\/build-ruling-page\.mjs" ([^`]+)`/g;
  const faults = [];
  for (const doc of [PROTOCOL, DOC]) {
    const commands = [...read(doc).replace(/\s+/g, ' ').matchAll(COMMAND)].map(m => m[1]);
    const ops = commands.map(c => c.split(' ')[0]);
    if (JSON.stringify(ops) !== JSON.stringify(['build', 'list', 'read'])) faults.push(`${doc}: publishes ${ops.join(', ')}`);
    for (const c of commands) {
      if (c.includes('<paste file>')) {
        const html = fs.readFileSync(path.join(ledger, 'ruling.html'), 'utf8');
        fs.writeFileSync(path.join(dir, 'paste.txt'), pageOf(html).paste());
      }
      const args = c.replace(/<ledger>/g, 'ledger').replace('<paste file>', 'paste.txt').split(' ');
      const r = run(args, dir);
      if (r.status !== 0) faults.push(`${doc}: ${c} → ${r.status} ${r.stdout}${r.stderr}`);
    }
  }
  assert.deepEqual(faults, []);
});
