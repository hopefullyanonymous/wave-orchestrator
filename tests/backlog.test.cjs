'use strict';
// backlog.mjs reads the form references/backlog.md shows. The examples are taken out of that page
// as published, so the page and the parser cannot drift; every rule has a case it alone decides,
// and every sweep collects its faults before asserting once.
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');

const ROOT = path.resolve(__dirname, '..');
const TOOL = path.join(ROOT, 'orchestrate', 'tools', 'backlog.mjs');
const DOC = 'orchestrate/references/backlog.md';
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const load = () => import(pathToFileURL(TOOL).href);
const loadIsTestPath = async () => (await import(pathToFileURL(path.join(ROOT, 'orchestrate', 'tools', 'failing-on-base.mjs')).href)).isTestPath;
const USAGE = 'UNKNOWN usage: unknown, missing or duplicate flag; use --help';

function tmp(t) {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'backlog-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }));
  return dir;
}
const writer = dir => (name, text) => { const file = path.join(dir, name); fs.writeFileSync(file, text); return file; };

// The page's fenced blocks under one heading, as published.
function blocksUnder(heading, lang) {
  const text = read(DOC), start = text.indexOf('\n' + heading + '\n');
  assert.ok(start >= 0, DOC + ' must hold the heading ' + heading);
  const end = text.indexOf('\n## ', start + 1), section = text.slice(start, end === -1 ? undefined : end);
  return [...section.matchAll(new RegExp('```' + lang + '\\n([\\s\\S]*?)```', 'g'))].map(m => m[1]);
}
const FORM_LINE = () => { const b = blocksUnder('## The form line', 'text'); assert.equal(b.length, 1); return b[0].trim(); };
const ENTRY_EXAMPLE = () => { const b = blocksUnder('## A backlog entry', 'markdown'); assert.equal(b.length, 1); return b[0]; };
const RULING_EXAMPLE = () => { const b = blocksUnder('## A ruling', 'markdown'); assert.equal(b.length, 1); return b[0]; };
const RULINGS_FORM = 'Form: orchestrate rulings v1';

const entry = (id, kind, files, since, { folded = '', tests = 'none' } = {}) => [`### ${id} — Item ${id}${folded}`, `Kind: ${kind}`,
  `Files: ${files.map(f => '`' + f + '`').join(', ')}`, `Tests: ${tests}`, `Failure: a user sees item ${id} fail.`,
  `Done when: a test of item ${id} passes.`, `Since: ${since} — XY-20260101-sample B01`, ''].join('\n');
const backlog = (...entries) => 'Form: orchestrate backlog v1\n\n' + entries.join('\n');

test('the published form line, entry and ruling examples read as the tool reads them', async t => {
  const { backlogCli, BACKLOG_FORM, RULINGS_FORM: ruled, KINDS } = await load();
  const w = writer(tmp(t));
  assert.equal(FORM_LINE(), BACKLOG_FORM);
  assert.equal(ruled, RULINGS_FORM);
  assert.ok(read(DOC).includes('`' + RULINGS_FORM + '`'), 'the page shows the rulings form line');
  // Every Kind bullet on the page, so a second one naming other kinds is caught.
  const kindLines = read(DOC).split('\n').filter(l => l.startsWith('- `Kind:`'));
  assert.deepEqual(kindLines.map(l => [...l.matchAll(/`([a-z]+)`/g)].map(m => m[1])), [KINDS], 'one Kind bullet names the six kinds, in order');
  // The id sentence's backticked separators are exactly the ASCII punctuation an id `TD<c>1` reads with.
  const idSentence = read(DOC).replace(/\s+/g, ' ').match(/The id is `#` and digits, or a letter, letters and digits, one (.*?), then digits\./);
  assert.ok(idSentence, 'the page states the id form');
  const separators = [...idSentence[1].matchAll(/`([^`]+)`/g)].map(m => m[1]);
  const punctuation = Array.from({ length: 128 }, (_, c) => String.fromCharCode(c)).filter(c => /[!-\/:-@\[-`{-~]/.test(c));
  const reads = punctuation.filter(c => backlogCli(['check', '--backlog', w('id.md', backlog(entry('TD' + c + '1', 'docs', ['a.md'], '2026-01-01')))]).code === 0);
  assert.deepEqual(reads, separators.slice().sort(), 'the separators the tool reads are the ones the page names');
  assert.ok(separators.length >= 3, 'live control: the sentence names its separators');
  // The bullets name the fields in the order the published example writes them.
  const section = read(DOC).slice(read(DOC).indexOf('\n## A backlog entry\n'), read(DOC).indexOf('```markdown'));
  const bullets = [...section.matchAll(/^- `([A-Za-z ]+):/gm)].map(m => m[1]);
  const example = ENTRY_EXAMPLE().split('\n### ')[0].split('\n').slice(1).filter(Boolean).map(l => l.slice(0, l.indexOf(':')));
  assert.deepEqual(bullets, example);
  assert.equal(bullets.length, 6);
  const file = w('b.md', '# Backlog\n\n' + BACKLOG_FORM + '\n\n' + ENTRY_EXAMPLE());
  assert.deepEqual(backlogCli(['check', '--backlog', file]), { code: 0, lines: ['BACKLOG OK 2 item(s)'] });
  // The second example is folded and coverage-only: it counts toward no pack and never expires.
  assert.match(ENTRY_EXAMPLE(), /\n### \S+ — .* Folded into \S+ B\d+\.\n/);
  assert.deepEqual(backlogCli(['packs', '--backlog', file, '--threshold', '1']).lines.slice(0, 1), ['PACKS 2 file(s) at or over 1']);
  assert.deepEqual(backlogCli(['expired', '--backlog', file, '--days', '0', '--today', '2099-01-01']).lines.length, 2);
  const rulings = w('r.md', RULINGS_FORM + '\n\n' + RULING_EXAMPLE());
  const files = [...RULING_EXAMPLE().matchAll(/^Files: `([^`]+)`/gm)].map(m => m[1]);
  assert.equal(files.length, 2);
  const listed = backlogCli(['rulings', '--rulings', rulings, '--paths', files.join(',')]);
  assert.deepEqual([listed.code, listed.lines[0], listed.lines.length], [0, 'RULINGS 2 ruling(s) on those paths', 3]);
  assert.match(listed.lines[1], /^\S+ accepted \d{4}-\d{2}-\d{2}: /);
  assert.match(listed.lines[2], /^\S+ declined \d{4}-\d{2}-\d{2}: /);
  // Live control: the published example with its form line taken away is unknown.
  assert.equal(backlogCli(['check', '--backlog', w('n.md', ENTRY_EXAMPLE())]).code, 2);
});

test('the page cites no backlog id of this repository and no machine-local path', () => {
  const text = read(DOC);
  // Any slash that opens an absolute path (not after a word, `.`, `-`, `>` as in `<skill-dir>/`, `~`, `/` or `:` as in a URL),
  // beside the named roots, a drive, a home tilde and a home variable.
  const PATTERNS = [/\bBL-\d+/, /(?<![\w.-])\/(?:home|Users|tmp|mnt|var|opt|root|private)\//, /(?<![\w.>~/:-])\/[\w.-]+\//,
    /(?<![\w])[A-Za-z]:[\\/]/, /(?<![\w])~\//, /\$\{?HOME\b|%[A-Za-z]+%/];
  const faultsIn = page => PATTERNS.filter(re => re.test(page)).map(String);
  assert.deepEqual(faultsIn(text), []);
  // Live controls, each caught: quoted, git's drive form, a home tilde, the named and the unnamed roots, Git Bash's drive, a home variable.
  const SAMPLES = ['see BL-064', 'run "/home/someone/shop/RULINGS.md"', 'C:/shop/RULINGS.md', '~/.local/share/x', 'C:' + '\\' + 'x', 'in (/tmp/x)', '`/var/x`',
    '`/Volumes/dev/shop/RULINGS.md`', '/srv/shop/RULINGS.md', '$HOME/.local/share/x', '/c/Users/x', '/snap/bin/x', '%USERPROFILE%' + '\\' + 'x'];
  assert.deepEqual(SAMPLES.filter(s => faultsIn(s).length === 0), []);
  // Controls on the clean side: a repository-relative path, the skill-dir form and a URL.
  assert.deepEqual(['`src/cart/total.js`', '`<skill-dir>/tools/backlog.mjs`', 'https://example.com/a/b'].filter(s => faultsIn(s).length), []);
  // No backtick token or link target on the page, its `#…` or `:<line>` tail cut and read from the page's directory or
  // the root, is a file this repository tracks outside the shipped skill. `RULINGS.md` is the form's own file name, which
  // this repository may come to track at its root.
  const r = spawnSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8', windowsHide: true, timeout: 15000 });
  assert.ifError(r.error);
  assert.equal(r.status, 0, r.stderr);
  const tracked = new Set(r.stdout.split('\0').filter(f => f && !f.startsWith('orchestrate/')));
  assert.ok(tracked.has('README.md') && tracked.has('tests/backlog.test.cjs'), 'the tracked set is the checkout\'s');
  const local = page => [...page.matchAll(/`([^`\n]+)`|\]\(([^)\s]+)\)/g)].map(m => (m[1] ?? m[2]).replace(/#.*$|:\d.*$/, ''))
    .flatMap(s => [path.posix.normalize(path.posix.join(path.posix.dirname(DOC), s)), path.posix.normalize(s)])
    .filter(s => tracked.has(s) && s !== 'RULINGS.md');
  assert.deepEqual(local(text), []);
  assert.deepEqual(['\nSee `README.md`.\n', '\nSee `tests/backlog.test.cjs:12`.\n', '\nSee [the receipts](../../docs/guardrail-receipts.md#top).\n', '\nSee `RULINGS.md`.\n']
    .map(s => local(text + s)), [['README.md'], ['tests/backlog.test.cjs'], ['docs/guardrail-receipts.md'], []], 'live controls: a repository-only path is reported, the form\'s own file name is not');
});

test('check fails each single defect of the published example, each decided by that defect alone', async t => {
  const { backlogCli } = await load();
  const w = writer(tmp(t)), good = 'Form: orchestrate backlog v1\n\n' + ENTRY_EXAMPLE();
  const lines = good.split('\n'), at = prefix => { const i = lines.findIndex(l => l.startsWith(prefix)); assert.ok(i > 0, prefix); return i; };
  const edit = (i, line) => lines.map((l, n) => n === i ? line : l).filter(l => l !== null).join('\n');
  const head = at('### '), kind = at('Kind:'), files = at('Files:'), since = at('Since:'), second = lines.findIndex((l, n) => n > kind && l.startsWith('### '));
  const swapped = lines.slice(); [swapped[kind], swapped[files]] = [swapped[files], swapped[kind]];
  const CASES = [
    ['a missing field', edit(at('Failure:'), null), /: no Failure: line$/],
    ['an empty field', edit(at('Done when:'), 'Done when:'), /: Done when: empty/],
    ['a field out of order', swapped.join('\n'), /: Kind: out of order/],
    ['a repeated field', edit(kind, lines[kind] + '\n' + lines[kind]), /: Kind: repeated$/],
    ['a Kind outside the six', edit(kind, 'Kind: bug'), /: Kind: bug is none of /],
    ['a malformed date', edit(since, 'Since: 2026-02-30 — somewhere'), /: Since: is not /],
    ['a date with no source', edit(since, 'Since: 2026-02-03'), /: Since: is not /],
    ['a duplicate id', edit(second, lines[second].replace(/^### \S+/, lines[head].match(/^### \S+/)[0])), /: the id is used 2 times$/],
    ['a heading with no em dash', edit(head, lines[head].replace(' — ', ' - ')), /^line \d+: the heading is not /],
    ['a malformed id', edit(head, lines[head].replace(/^### \S+/, '### TD14')), /: the id TD14 is not /],
    ['a line that is no field', edit(files, lines[files] + '\nSee the cart notes.'), /: line \d+ is no field line$/],
    ['a path that is not repository-relative', edit(files, 'Files: `/src/cart/total.js`'), /: Files: is not /],
    ['a path with a backslash', edit(files, 'Files: `src\\cart\\total.js`'), /: Files: is not /],
    ['a path with a .. part', edit(files, 'Files: `src/../total.js`'), /: Files: is not /],
    ['a path with a ./ part', edit(files, 'Files: `./src/cart/total.js`'), /: Files: is not /],
    ['a path with a space round it', edit(files, 'Files: ` src/cart/total.js`'), /: Files: is not /],
    ['a malformed fold-in marker', edit(head, lines[head] + ' Folded into XY-1 B01'), /: the title is empty or holds a malformed fold-in marker$/],
    ['a field with no space after its colon', edit(kind, 'Kind:behaviour'), /: Kind: empty or not followed by one space$/],
    ['a Tests: line that is neither none nor paths', edit(at('Tests:'), 'Tests: the cart suite'), /: Tests: is neither /],
    ['a line before the first entry', good.replace('\n\n###', '\n\nSome notes.\n###'), /^line \d+: not an entry heading/],
    // Each field emptied alone is one problem, its reader never reached.
    ...['Kind', 'Files', 'Tests', 'Failure', 'Since'].map(f => ['an empty ' + f + ':', edit(at(f + ':'), f + ':'), new RegExp(': ' + f + ': empty or not followed by one space$')]),
    ['paths with no space after a comma', edit(files, 'Files: `src/cart/total.js`,`src/cart/store.js`'), /: Files: is not /],
    ['a path and words', edit(files, 'Files: `src/cart/total.js` and the store'), /: Files: is not /],
    ['an id opening with a digit', edit(head, lines[head].replace(/^### \S+/, '### 1TD-3')), /: the id 1TD-3 is not /],
    ['an id ending in a letter', edit(head, lines[head].replace(/^### \S+/, '### TD-3a')), /: the id TD-3a is not /],
    ['a fold-in marker followed by text', edit(head, lines[head] + ' Folded into XY-1 B01. (resumed)'), /: the title is empty or holds a malformed fold-in marker$/],
    ['a title that is only the marker', edit(head, lines[head].replace(/ — .*$/, ' —  Folded into XY-1 B01.')), /: the title is empty or holds a malformed fold-in marker$/],
  ];
  const faults = [];
  for (const [name, text, expected] of CASES) {
    const out = backlogCli(['check', '--backlog', w('case.md', text)]);
    const m = /^BACKLOG FAIL (\d+) problem\(s\): (.*)$/.exec(out.lines[0] ?? '');
    if (out.code !== 1 || !m || m[1] !== '1' || !expected.test(m[2])) faults.push(name + ' → ' + out.code + ' ' + out.lines.join(' / '));
    // Outside check, the same entry leaves every count unknown.
    const packed = backlogCli(['packs', '--backlog', w('case.md', text), '--threshold', '1']);
    if (packed.code !== 2 || !/^UNKNOWN --backlog holds 1 problem\(s\)/.test(packed.lines[0])) faults.push(name + ' (packs) → ' + packed.lines.join(' / '));
  }
  assert.deepEqual(faults, []);
  // Live control: the unedited example passes, so each FAIL above is its edit's.
  assert.deepEqual(backlogCli(['check', '--backlog', w('good.md', good)]), { code: 0, lines: ['BACKLOG OK 2 item(s)'] });
  assert.deepEqual(backlogCli(['check', '--backlog', w('crlf.md', good.replace(/\n/g, '\r\n'))]), { code: 0, lines: ['BACKLOG OK 2 item(s)'] }, 'a CRLF file reads the same');
  assert.deepEqual(backlogCli(['check', '--backlog', w('bom.md', String.fromCharCode(0xfeff) + good)]), { code: 0, lines: ['BACKLOG OK 2 item(s)'] }, 'a BOM before the form line');
  assert.deepEqual(backlogCli(['check', '--backlog', w('ws.md', good.replace('\n\n### ', '\n   \t\n### '))]), { code: 0, lines: ['BACKLOG OK 2 item(s)'] }, 'a whitespace-only line is blank');
  // Several defects at once, each counted: two fields out of order, and a duplicate whose copy is broken.
  const reordered = [lines.slice(0, head + 1), lines[at('Tests:')], lines[kind], lines[files], lines.filter((l, n) => n > files && n <= since && n !== at('Tests:'))].flat().join('\n');
  const twice = good + '\n' + lines.slice(head, since + 1).join('\n').replace(lines[kind], 'Kind: bug') + '\n';
  const several = [[reordered, 2, /Kind: out of order.*Files: out of order/], [twice, 2, /Kind: bug is none of .*the id is used 2 times$/]];
  assert.deepEqual(several.map(([text]) => backlogCli(['check', '--backlog', w('s.md', text)])).map(o => [o.code, Number(/FAIL (\d+)/.exec(o.lines[0])?.[1])]),
    several.map(([, n]) => [1, n]));
  assert.deepEqual(several.map(([text, , re]) => re.test(backlogCli(['check', '--backlog', w('s.md', text)]).lines[0])), [true, true]);
  // At most ten problems are named, then the rest are counted.
  const eleven = backlog(...Array.from({ length: 11 }, (_, i) => entry('K-' + i, 'bug', ['src/a.js'], '2026-01-01')));
  const shown = backlogCli(['check', '--backlog', w('k.md', eleven)]).lines[0];
  assert.deepEqual([shown.startsWith('BACKLOG FAIL 11 problem(s): K-0: '), shown.split('; ').length, shown.endsWith(' (+1 more)'), shown.includes('K-10')], [true, 10, true, false]);
  const ten = backlogCli(['check', '--backlog', w('k.md', backlog(...Array.from({ length: 10 }, (_, i) => entry('K-' + i, 'bug', ['src/a.js'], '2026-01-01'))))]).lines[0];
  assert.deepEqual([ten.split('; ').length, ten.includes('more)')], [10, false], 'ten are named whole');
  // Every id scheme scaffold.mjs mints reads.
  assert.deepEqual(backlogCli(['check', '--backlog', w('ids.md', backlog(entry('#12', 'docs', ['a.md'], '2026-01-01'), entry('TD_3', 'docs', ['a.md'], '2026-01-01'),
    entry('TD.4', 'docs', ['a.md'], '2026-01-01')))]), { code: 0, lines: ['BACKLOG OK 3 item(s)'] });
  // Each line is one line, whatever a value holds: a C1 control character, which no line break of the parser splits at.
  const sep = String.fromCharCode(0x85);
  const odd = backlogCli(['check', '--backlog', w('sep.md', backlog(entry('A-1', 'bug' + sep + 'x', ['src/a.js'], '2026-01-01')))]);
  assert.deepEqual([odd.code, odd.lines.length, odd.lines[0].includes(sep), odd.lines[0].includes('bug?x')], [1, 1, false, true]);
});

test('packs counts per production file, per test file only for test-only items, never decision or folded items', async t => {
  const { backlogCli } = await load(), isTestPath = await loadIsTestPath();
  const w = writer(tmp(t));
  // The partition is isTestPath's: these paths sit on the side the counts below expect.
  assert.deepEqual(['src/a.js', 'tests/a.test.js', 'tests/b.test.js', 'spec/c.js', 'Tests/x.js'].map(isTestPath), [false, true, true, true, false]);
  const items = [
    entry('A-1', 'behaviour', ['src/a.js', 'tests/a.test.js'], '2026-01-01'),
    entry('A-2', 'hygiene', ['src/a.js'], '2026-01-01'),
    entry('A-3', 'decision', ['src/a.js'], '2026-01-01'),
    entry('A-4', 'coverage', ['tests/b.test.js', 'spec/c.js'], '2026-01-01'),
    entry('A-5', 'tooling', ['src/a.js'], '2026-01-01', { folded: ' Folded into XY-20260101-sample B02.' }),
    entry('A-6', 'docs', ['Tests/x.js', 'tests/b.test.js'], '2026-01-01'),
  ];
  const run = (text, n) => backlogCli(['packs', '--backlog', w('p.md', text), '--threshold', String(n)]);
  const ALL = ['PACK src/a.js 2: A-1, A-2', 'PACK Tests/x.js 1: A-6', 'PACK spec/c.js 1: A-4', 'PACK tests/b.test.js 1: A-4'];
  const cases = [
    [1, { code: 0, lines: ['PACKS 4 file(s) at or over 1', ...ALL] }],
    // src/a.js holds 2: listed at 2, and not at 3, one above its count.
    [2, { code: 0, lines: ['PACKS 1 file(s) at or over 2', ALL[0]] }],
    [3, { code: 0, lines: ['PACKS 0 file(s) at or over 3'] }],
  ];
  assert.deepEqual(cases.map(([n]) => run(backlog(...items), n)), cases.map(([, out]) => out));
  // Live controls, each decided by one rule: the decision item made behaviour, and the folded item's
  // marker taken off, each raise src/a.js to 3.
  const undecided = items.map(e => e.replace('Kind: decision', 'Kind: behaviour'));
  const unfolded = items.map(e => e.replace(' Folded into XY-20260101-sample B02.', ''));
  assert.deepEqual([run(backlog(...undecided), 3).lines, run(backlog(...unfolded), 3).lines],
    [['PACKS 1 file(s) at or over 3', 'PACK src/a.js 3: A-1, A-2, A-3'], ['PACKS 1 file(s) at or over 3', 'PACK src/a.js 3: A-1, A-2, A-5']]);
  // An item naming a production file is never counted on its test files: A-1's tests/a.test.js has no pack at 1.
  assert.ok(!run(backlog(...items), 1).lines.some(l => l.includes('tests/a.test.js')));
  assert.deepEqual(run(backlog(entry('A-1', 'behaviour', ['src/a.js', 'src/a.js'], '2026-01-01')), 1).lines, ['PACKS 1 file(s) at or over 1', 'PACK src/a.js 1: A-1'],
    'a file named twice by one item counts once');
  // Live control of the test-only rule: A-1 with only its test file counts on it.
  assert.ok(run(backlog(entry('A-1', 'behaviour', ['tests/a.test.js'], '2026-01-01')), 1).lines.includes('PACK tests/a.test.js 1: A-1'));
});

test('expired lists an item one day past the expiry, not one on it or before it, and never a folded item', async t => {
  const { backlogCli } = await load();
  const w = writer(tmp(t));
  const items = [
    entry('E-1', 'behaviour', ['src/a.js'], '2026-10-31'),
    entry('E-2', 'behaviour', ['src/a.js'], '2026-11-01'),
    entry('E-3', 'behaviour', ['src/a.js'], '2026-11-02'),
    entry('E-4', 'decision', ['src/a.js'], '2025-02-28'),
    entry('E-5', 'hygiene', ['src/a.js'], '2020-01-01', { folded: ' Folded into XY-20260101-sample B03.' }),
  ];
  const run = (days, today) => backlogCli(['expired', '--backlog', w('e.md', backlog(...items)), '--days', String(days), '--today', today]);
  assert.deepEqual([run(30, '2026-12-01'), run(31, '2026-12-01'), run(29, '2026-12-01')], [
    { code: 0, lines: ['EXPIRED 2 item(s) older than 30 days', 'E-1 since 2026-10-31', 'E-4 since 2025-02-28'] },
    { code: 0, lines: ['EXPIRED 1 item(s) older than 31 days', 'E-4 since 2025-02-28'] },
    { code: 0, lines: ['EXPIRED 3 item(s) older than 29 days', 'E-1 since 2026-10-31', 'E-2 since 2026-11-01', 'E-4 since 2025-02-28'] },
  ]);
  // Calendar days across a year: 2025-02-28 to 2026-02-28 is 365 days, one below, at and one above.
  assert.deepEqual([run(364, '2026-02-28').lines.length, run(365, '2026-02-28').lines.length], [2, 1]);
  // Live control: the folded item's marker taken off, it is listed.
  const unfolded = backlog(...items.map(e => e.replace(' Folded into XY-20260101-sample B03.', '')));
  assert.ok(backlogCli(['expired', '--backlog', w('u.md', unfolded), '--days', '30', '--today', '2026-12-01']).lines.includes('E-5 since 2020-01-01'));
});

test('rulings lists only the rulings sharing a path, with the shared paths', async t => {
  const { backlogCli } = await load();
  const w = writer(tmp(t));
  const file = w('r.md', [RULINGS_FORM, '', '### RL-1 — One', 'Ruling: accepted — 2026-04-01', 'Reason: "fine"', 'Files: `src/a.js`, `src/b.js`', '',
    '### RL-2 — Two', 'Ruling: declined — 2026-04-02', 'Reason: "no"', 'Files: `src/c.js`', ''].join('\n'));
  const run = paths => backlogCli(['rulings', '--rulings', file, '--paths', paths]);
  assert.deepEqual([run('src/b.js,src/z.js'), run('src/c.js'), run('src/a'), run('src/a.js,src/b.js,src/c.js')], [
    { code: 0, lines: ['RULINGS 1 ruling(s) on those paths', 'RL-1 accepted 2026-04-01: src/b.js'] },
    { code: 0, lines: ['RULINGS 1 ruling(s) on those paths', 'RL-2 declined 2026-04-02: src/c.js'] },
    { code: 0, lines: ['RULINGS 0 ruling(s) on those paths'] },
    { code: 0, lines: ['RULINGS 2 ruling(s) on those paths', 'RL-1 accepted 2026-04-01: src/a.js, src/b.js', 'RL-2 declined 2026-04-02: src/c.js'] },
  ]);
  // A ruling it cannot read leaves the answer unknown; a backlog given as a rulings file is not in the form.
  const broken = w('rb.md', fs.readFileSync(file, 'utf8').replace('Ruling: declined — 2026-04-02', 'Ruling: maybe — 2026-04-02'));
  assert.match(backlogCli(['rulings', '--rulings', broken, '--paths', 'src/a.js']).lines[0], /^UNKNOWN --rulings holds 1 problem\(s\).*RL-2: Ruling: is not /);
  const badDate = w('rd.md', fs.readFileSync(file, 'utf8').replace('Ruling: accepted — 2026-04-01', 'Ruling: accepted — 2026-02-30'));
  assert.match(backlogCli(['rulings', '--rulings', badDate, '--paths', 'src/a.js']).lines[0], /^UNKNOWN --rulings holds 1 problem\(s\).*RL-1: Ruling: is not /);
  const trailing = w('rt.md', fs.readFileSync(file, 'utf8').replace('Ruling: accepted — 2026-04-01', 'Ruling: accepted — 2026-04-01 (renewed)'));
  assert.match(backlogCli(['rulings', '--rulings', trailing, '--paths', 'src/a.js']).lines[0], /^UNKNOWN --rulings holds 1 problem\(s\).*RL-1: Ruling: is not /);
  assert.deepEqual(run('src/a.js, src/c.js').lines, ['RULINGS 2 ruling(s) on those paths', 'RL-1 accepted 2026-04-01: src/a.js', 'RL-2 declined 2026-04-02: src/c.js'], 'a space after a comma is no part of a path');
  assert.match(backlogCli(['rulings', '--rulings', w('bk.md', backlog(entry('A-1', 'behaviour', ['src/a.js'], '2026-01-01'))), '--paths', 'src/a.js']).lines[0],
    /^UNKNOWN --rulings has no line "Form: orchestrate rulings v1"/);
});

test('a table backlog, a file without the form line and an unreadable file are UNKNOWN in every operation; the form line alone is zero items', async t => {
  const { backlogCli } = await load();
  const dir = tmp(t), w = writer(dir);
  const SOURCES = {
    'a table backlog': w('table.md', '# Backlog\n\n| ID | Item | Files |\n|---|---|---|\n| BL-001 | A thing | `src/a.js` |\n'),
    'entries without the form line': w('noform.md', entry('A-1', 'behaviour', ['src/a.js'], '2026-01-01')),
    'the form line after an entry': w('late.md', entry('A-1', 'behaviour', ['src/a.js'], '2026-01-01') + '\nForm: orchestrate backlog v1\n'),
    'the form line twice': w('twice.md', backlog() + 'Form: orchestrate backlog v1\n'),
    'a missing file': path.join(dir, 'absent.md'),
    'a directory': dir,
    'a line holding more than the form line': w('draft.md', 'Form: orchestrate backlog v1 (draft)\nForm: orchestrate rulings v1 (draft)\n\n' + entry('A-1', 'behaviour', ['src/a.js'], '2026-01-01')),
  };
  const ops = file => ({
    check: ['check', '--backlog', file], packs: ['packs', '--backlog', file, '--threshold', '1'],
    expired: ['expired', '--backlog', file, '--days', '30', '--today', '2026-12-01'], rulings: ['rulings', '--rulings', file, '--paths', 'src/a.js'],
  });
  const faults = [];
  for (const [what, file] of Object.entries(SOURCES)) {
    for (const [op, args] of Object.entries(ops(file))) {
      const out = backlogCli(args), flag = op === 'rulings' ? '--rulings' : '--backlog';
      if (out.code !== 2 || out.lines.length !== 1 || !out.lines[0].startsWith('UNKNOWN ' + flag + ' ') || /usage/.test(out.lines[0])) faults.push(what + ' ' + op + ' → ' + out.code + ' ' + out.lines.join(' / '));
    }
  }
  assert.deepEqual(faults, []);
  assert.deepEqual([backlogCli(ops(dir).check), backlogCli(ops(dir).rulings)].map(o => o.lines), [['UNKNOWN --backlog is not a file'], ['UNKNOWN --rulings is not a file']]);
  // A file that stats as a file and then fails to read names its flag: node:fs readFileSync, the object backlog.mjs
  // imports, throws EACCES for that one path, which reads the same on every platform.
  const locked = w('locked.md', backlog()), realRead = fs.readFileSync;
  fs.readFileSync = (p, ...rest) => { if (p === locked) throw Object.assign(new Error('permission denied'), { code: 'EACCES' }); return realRead(p, ...rest); };
  let deniedOut;
  try { deniedOut = Object.entries(ops(locked)).map(([op, args]) => [op, backlogCli(args)]); } finally { fs.readFileSync = realRead; }
  assert.deepEqual(deniedOut, Object.keys(ops(locked)).map(op => [op, { code: 2, lines: [`UNKNOWN ${op === 'rulings' ? '--rulings' : '--backlog'} cannot be read: EACCES`] }]));
  // Live control: unstubbed, the same file reads (the rulings run is unknown for its backlog form line, not for the read).
  assert.deepEqual(backlogCli(ops(locked).check), { code: 0, lines: ['BACKLOG OK 0 item(s)'] });
  // The form line with no entry is an empty to-do list, never unknown.
  const empty = w('empty.md', '# Backlog\n\nForm: orchestrate backlog v1\n'), emptyRulings = w('er.md', RULINGS_FORM + '\n\n');
  assert.deepEqual(Object.values({ ...ops(empty), rulings: ['rulings', '--rulings', emptyRulings, '--paths', 'src/a.js'] }).map(backlogCli), [
    { code: 0, lines: ['BACKLOG OK 0 item(s)'] }, { code: 0, lines: ['PACKS 0 file(s) at or over 1'] },
    { code: 0, lines: ['EXPIRED 0 item(s) older than 30 days'] }, { code: 0, lines: ['RULINGS 0 ruling(s) on those paths'] }]);
});

test('a usage error says usage; a bad flag value names the flag and does not', async t => {
  const { backlogCli } = await load();
  const file = writer(tmp(t))('b.md', backlog(entry('A-1', 'behaviour', ['src/a.js'], '2026-01-01')));
  const USAGES = [[], ['packs'], ['bogus', '--backlog', file], ['packs', '--backlog', file], ['packs', '--backlog', file, '--threshold', '1', '--bogus', 'x'],
    ['check', '--backlog', file, '--backlog', file], ['check', '--backlog'], ['check', '--repo', file], ['--help', 'x']];
  const VALUES = [
    [['packs', '--backlog', file, '--threshold', '2.5'], 'UNKNOWN --threshold is not a whole number'],
    [['packs', '--backlog', file, '--threshold', '-1'], 'UNKNOWN --threshold is not a whole number'],
    [['expired', '--backlog', file, '--days', 'ten', '--today', '2026-12-01'], 'UNKNOWN --days is not a whole number'],
    [['expired', '--backlog', file, '--days', '30', '--today', '2026-13-01'], 'UNKNOWN --today is not a YYYY-MM-DD calendar date'],
    [['expired', '--backlog', file, '--days', '30', '--today', '2026-2-01'], 'UNKNOWN --today is not a YYYY-MM-DD calendar date'],
    [['rulings', '--rulings', file, '--paths', 'src/a.js,../b.js'], 'UNKNOWN --paths is not a comma-separated list of repository-relative paths'],
  ];
  const faults = [...USAGES.map(args => [args, backlogCli(args)]).filter(([, out]) => out.code !== 2 || out.lines.join() !== USAGE).map(([a, o]) => a.join(' ') + ' → ' + o.lines),
    ...VALUES.map(([args, line]) => [args, line, backlogCli(args)]).filter(([, line, out]) => out.code !== 2 || out.lines.join() !== line).map(([a, , o]) => a.join(' ') + ' → ' + o.lines)];
  assert.deepEqual(faults, []);
  // Live control: the same commands with good values run.
  assert.deepEqual(backlogCli(['packs', '--backlog', file, '--threshold', '1']).code, 0);
  assert.deepEqual(backlogCli(['expired', '--backlog', file, '--days', '30', '--today', '2026-02-28']).code, 0);
});

test('--help names every operation with its flags in full, and the published commands are accepted by the parser', async t => {
  const { backlogCli } = await load();
  const help = backlogCli(['--help']);
  assert.equal(help.code, 0);
  const segments = help.lines[0].split(' | ');
  const FLAGS = { packs: ['--backlog', '--threshold'], expired: ['--backlog', '--days', '--today'], rulings: ['--rulings', '--paths'], check: ['--backlog'] };
  const documented = Object.fromEntries(Object.keys(FLAGS).map(op => [op, segments.filter(s => s.startsWith('backlog.mjs ' + op + ' ') || s.startsWith(op + ' '))
    .map(s => s.match(/--[a-z][a-z-]*/g))]));
  assert.deepEqual(documented, Object.fromEntries(Object.entries(FLAGS).map(([op, f]) => [op, [f]])));
  assert.doesNotMatch(help.lines.join('\n'), /…|\.\.\./, 'no flag is elided');
  assert.match(help.lines.join('\n'), /Tests\/ case-sensitively, so a file under Tests\/ counts as production unless another of its directories or its own name marks it a test\./);
  // What that sentence says follows, read off isTestPath: production, a test by a directory, a test by its name.
  const isTestPath = await loadIsTestPath();
  assert.deepEqual(['Tests/x.js', 'Tests/spec/x.js', 'Tests/x.test.js'].map(isTestPath), [false, true, true]);
  // Each command the page publishes, its placeholders filled, gets past the flag parser.
  const w = writer(tmp(t)), file = w('b.md', backlog()), rulingsFile = w('r.md', RULINGS_FORM + '\n');
  const commands = [...read(DOC).replace(/\s+/g, ' ').matchAll(/`node "<skill-dir>\/tools\/backlog\.mjs" ([^`]+)`/g)].map(m => m[1].match(/(?:[^\s<]|<[^>]*>)+/g));
  assert.deepEqual(commands.map(c => c[0]).sort(), ['check', 'expired', 'packs', 'rulings']);
  const FILL = { '<file>': file, '<n>': '5', '<YYYY-MM-DD>': '2026-12-01', '<comma-separated paths>': 'src/a.js' };
  const refused = commands.map(c => c.map(a => a === '<file>' && c[0] === 'rulings' ? rulingsFile : FILL[a] ?? a)).map(args => [args, backlogCli(args)]).filter(([, out]) => out.code === 2);
  assert.deepEqual(refused.map(([a, o]) => a.join(' ') + ' → ' + o.lines), []);
});

test('each output line the page publishes matches a line the tool prints', async t => {
  const { backlogCli } = await load();
  const w = writer(tmp(t));
  const items = backlog(entry('A-1', 'behaviour', ['src/a.js'], '2026-01-01'), entry('A-2', 'hygiene', ['src/a.js'], '2026-01-01'));
  const file = w('b.md', items), rulings = w('r.md', RULINGS_FORM + '\n\n### RL-1 — One\nRuling: declined — 2026-04-01\nReason: "no"\nFiles: `src/a.js`\n');
  const eleven = w('k.md', backlog(...Array.from({ length: 11 }, (_, i) => entry('K-' + i, 'bug', ['src/a.js'], '2026-01-01'))));
  const printed = [['packs', '--backlog', file, '--threshold', '1'], ['expired', '--backlog', file, '--days', '1', '--today', '2026-12-01'],
    ['rulings', '--rulings', rulings, '--paths', 'src/a.js'], ['check', '--backlog', file],
    ['check', '--backlog', w('f.md', backlog(entry('A-1', 'bug', ['src/a.js'], '2026-01-01')))], ['check', '--backlog', eleven],
    ['check', '--backlog', w('n.md', 'x\n')]].flatMap(a => backlogCli(a).lines);
  const OUTPUT = /^(?:PACKS? |EXPIRED |RULINGS |BACKLOG |UNKNOWN |<id> |\(\+)/;
  const spans = [...read(DOC).replace(/```[\s\S]*?```/g, '').replace(/\s+/g, ' ').matchAll(/`([^`]+)`/g)].map(m => m[1]).filter(s => OUTPUT.test(s));
  // Each placeholder by its name: a count is digits, a date a date, one id or path a token holding no space, colon,
  // comma or semicolon, a list those tokens joined by ", ", a reason the rest of the line. A name not listed is a fault.
  const TOKEN = '[^\\s:,;]+', LIST = TOKEN + '(?:, ' + TOKEN + ')*';
  const SLOTS = { '<k>': '\\d+', '<n>': '\\d+', '<m>': '\\d+', '<count>': '\\d+', '<date>': '\\d{4}-\\d{2}-\\d{2}', '<id>': TOKEN, '<path>': TOKEN,
    '<ids>': LIST, '<shared paths>': LIST, '<reason>': '.+', '<accepted|declined>': '(?:accepted|declined)' };
  const esc = p => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const named = new Set();
  // A span opening with `(+` is the tail of a line, so it is matched at the line's end only.
  const matcher = span => new RegExp((span.startsWith('(+') ? '' : '^') + span.split(/(<[^>]+>|…)/).map(p => p === '…' ? '.+'
    : !p.startsWith('<') ? esc(p) : Object.hasOwn(SLOTS, p) ? SLOTS[p] : (named.add(p), '(?!)')).join('') + '$');
  const unmatched = page => page.filter(s => !printed.some(l => matcher(s).test(l)));
  assert.ok(spans.length >= 9, 'the page publishes the output lines: ' + spans.join(' | '));
  assert.deepEqual([unmatched(spans), [...named]], [[], []]);
  // Live controls, each reported: a literal reworded, two slots swapped, a colon dropped, a space lost, a refusal and a tail renamed.
  const MUTANTS = ['PACKS <k> file(s) over <n>', 'PACK <count> <path>: <ids>', '<id> <accepted|declined> <date> <shared paths>',
    'EXPIRED <k> item(s) older than <n>days', 'ERROR <reason>', '(and <m> more)', '(+<m> more) at most'];
  assert.deepEqual(unmatched(MUTANTS), MUTANTS);
  assert.deepEqual([unmatched(['PACK <path> <tally>: <ids>']), [...named]], [['PACK <path> <tally>: <ids>'], ['<tally>']], 'an unlisted placeholder is a fault');
});

test('run as a command, it prints its lines and exits with its code', t => {
  const w = writer(tmp(t));
  const run = args => { const r = spawnSync(process.execPath, [TOOL, ...args], { encoding: 'utf8', windowsHide: true, timeout: 60000 }); assert.ifError(r.error); return [r.status, r.stdout, r.stderr]; };
  const good = w('g.md', backlog(entry('A-1', 'behaviour', ['src/a.js'], '2026-01-01')));
  const bad = w('f.md', backlog(entry('A-1', 'bug', ['src/a.js'], '2026-01-01')));
  assert.deepEqual([run(['check', '--backlog', good]), run(['check', '--backlog', bad]), run(['packs', '--backlog', w('n.md', 'x\n'), '--threshold', '1'])], [
    [0, 'BACKLOG OK 1 item(s)\n', ''],
    [1, 'BACKLOG FAIL 1 problem(s): A-1: Kind: bug is none of behaviour, hygiene, coverage, decision, docs, tooling\n', ''],
    [2, 'UNKNOWN --backlog has no line "Form: orchestrate backlog v1" before its first entry\n', ''],
  ]);
  const esc = String.fromCharCode(27);
  assert.deepEqual(run(['check', '--backlog', w('e.md', backlog(entry('A-1', 'bug' + esc + '[31m', ['src/a.js'], '2026-01-01')))]).slice(0, 2),
    [1, 'BACKLOG FAIL 1 problem(s): A-1: Kind: bug?[31m is none of behaviour, hygiene, coverage, decision, docs, tooling\n']);
});

// The planted throw waits until the tool has registered its handler, so it tests the handler.
test('an uncaught error is UNKNOWN internal error with exit 2, never exit 1', () => {
  const plant = 'let n = 0; const go = () => { if (process.listenerCount("uncaughtException") > 0 || ++n > 300) throw new Error("planted crash"); setTimeout(go, 10); }; setTimeout(go, 10);';
  const url = 'data:text/javascript,' + encodeURIComponent(plant);
  const spawn = args => spawnSync(process.execPath, ['--import', url, ...args], { encoding: 'utf8', windowsHide: true, timeout: 60000 });
  // Control: the same plant in a process with no handler crashes with exit 1.
  const bare = spawn(['-e', '']);
  assert.deepEqual([bare.status, /planted crash/.test(bare.stderr)], [1, true]);
  const r = spawn([TOOL, '--help']);
  assert.deepEqual([r.status, r.stdout.trimEnd().split('\n').pop()], [2, 'UNKNOWN internal error: planted crash']);
});

// A throw inside an operation that is none of the tool's own refusals: node:fs statSync, the object backlog.mjs
// imports, returns a stat whose isFile throws, for one path.
test('an error inside an operation is UNKNOWN internal error with exit 2, never exit 1', async t => {
  const { backlogCli } = await load();
  const file = writer(tmp(t))('b.md', backlog()), realStat = fs.statSync;
  fs.statSync = (p, ...rest) => p === file ? { isFile() { throw new Error('planted'); } } : realStat(p, ...rest);
  let out;
  try { out = [['check', '--backlog', file], ['packs', '--backlog', file, '--threshold', '1']].map(backlogCli); } finally { fs.statSync = realStat; }
  assert.deepEqual(out, [{ code: 2, lines: ['UNKNOWN internal error: planted'] }, { code: 2, lines: ['UNKNOWN internal error: planted'] }]);
  // Live control: unstubbed, the same file reads.
  assert.deepEqual(backlogCli(['check', '--backlog', file]), { code: 0, lines: ['BACKLOG OK 0 item(s)'] });
});
