// Exercise the shipped builder against the shipped template. No copy of its
// slot-rendering logic lives in this harness.
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { createHash } = require('node:crypto');

const BUILDER = path.join(__dirname, '../orchestrate/tools/build-smoke-page.mjs');
const TEMPLATE_PATH = path.join(__dirname, '../orchestrate/references/smoke-page-template.html');
const template = fs.readFileSync(TEMPLATE_PATH, 'utf8');
const SHA = 'af57139e302f85a209a9a7695f671345fc7ed6ed';

let builder;
test.before(async () => { builder = await import('file://' + BUILDER.replace(/\\/g, '/')); });

// The gate the contract now specifies: the containment proof executes, and names the
// SHA of the build this sidecar describes. A sidecar for another build needs its own.
const gateFor = sha => ({ intro: 'Prove the build first.',
  commands: ['git switch chore/smoke-hardening-ledger',
    `git merge-base --is-ancestor ${sha} HEAD`,
    `git diff --name-only ${sha}..HEAD -- . ":(exclude).agents/"`],
  checks: ['<code>git status --porcelain</code> prints nothing.',
    'The containment commands exit 0 and name nothing outside this ledger.'] });
// A build change carries its gate with it, the way a real re-issue does.
const onBuild = sha => ({ buildSha: sha, gate: gateFor(sha) });

const sidecar = (over = {}) => ({
  change: 'Smoke-page hardening', checkpoint: 1, batches: 'B01–B05',
  branch: 'chore/smoke-hardening-ledger', buildSha: SHA, ckptKey: 'orch-smoke-c1',
  version: { now: '0.14.0', was: '0.13.2' }, suite: '27 / 27 pass', knownFailures: 'none',
  gate: gateFor(SHA),
  sections: [
    { n: 1, title: 'Verdict persistence', steps: [
      { n: 1, do: 'Mark step 1 <strong>Fail</strong>.', pass: 'It turns red.', revision: 1 },
      { n: 2, do: 'Reload the page.', pass: 'It is still Fail.', revision: 2 }] },
    { n: 2, title: 'Ledger discovery', steps: [
      { n: 3, do: 'Ask for ledger status.', pass: 'It lists this ledger.', revision: 1,
        pre: { sha: 'af57139', stepRevision: '1', env: 'Git 2.52', evidence: 'evidence/C1/step-03.md' } }] }
  ],
  ...over
});

const build = over => builder.buildSmokePage(sidecar(over), template);
const fails = (over, message) => assert.throws(() => build(over), message);

test('every template slot is filled, and the builder fills no slot the template lacks', () => {
  const declared = new Set(template.match(/\{\{([A-Z_]+)\}\}/g).map(s => s.slice(2, -2)));
  const rendered = new Set(Object.keys(builder.renderSlots(sidecar())));
  assert.deepEqual([...rendered].sort(), [...declared].sort());
  // Re-aimed at the TEMPLATE, where slots live. This line used to read
  // `build().includes('{{')`, which pinned the defect: step content carrying `{{` is
  // content, not an unfilled slot. What is worth holding is that the shipped template
  // carries no `{{` the fill pattern cannot match, and that no well-formed slot
  // survives the fill.
  assert.equal(template.replace(/\{\{[A-Z_]+\}\}/g, '').includes('{{'), false,
    'the shipped template must carry no `{{` outside a well-formed slot marker');
  assert.equal(build().match(/\{\{[A-Z_]+\}\}/g), null, 'no slot may survive the fill');
  // Companion over the OUTPUT, because the two lines above are template-side only and a
  // `{{` injected into the page body — outside every slot — escaped both. Subject is the
  // non-content region: strip the values the fill supplied, and what remains is template
  // bytes, which carry no `{{` at all. That is the reach the old output-side line had,
  // without its defect: content that may legitimately carry `{{` arrives inside a value.
  const outsideSlots = Object.values(builder.renderSlots(sidecar()))
    .reduce((page, value) => value ? page.split(value).join('') : page, build());
  assert.equal(outsideSlots.includes('{{'), false,
    'the published page carries `{{` outside every filled slot value');
});

// BL-022: the residual scan ran over the FILLED page, so a Do command quoting a
// GitHub Actions expression, a Handlebars block or a Vue binding could not be published
// at all — the builder blamed an "unfilled" slot for the reader's own content.
test('step content carrying a doubled-brace expression publishes unchanged', () => {
  const EXPRESSIONS = ['${{ github.event.inputs.tag }}', '{{ site.title }}', '{{#if ok}}yes{{/if}}'];
  assert.equal(new Set(EXPRESSIONS).size, 3, 'the three published templating dialects must be distinct');
  for (const expression of EXPRESSIONS) {
    assert.doesNotMatch(expression, /\{\{[A-Z_]+\}\}/,
      expression + ': a fixture that IS a slot marker would prove nothing about content');
  }
  const steps = EXPRESSIONS.map((expression, i) => ({ n: i + 1, revision: 1,
    do: `Run <code>echo ${expression}</code>.`, pass: `It prints ${expression}.` }));
  const html = build({ sections: [{ n: 1, title: 'Templating', steps }] });
  // The domain pin for the list is the set size above; this holds each member.
  assert.deepEqual(EXPRESSIONS.filter(expression => html.split(expression).length - 1 === 2), EXPRESSIONS,
    'every expression must reach the page verbatim, in both the do and the pass text');
  // Subject observed on the BUILT page, not on the literal the steps were made from: the
  // embedded sections carry one step per expression, so a builder that dropped, merged or
  // duplicated a step while still emitting its text reddens here.
  const embedded = JSON.parse(html.match(/var SECTIONS = (\[[\s\S]*?\]);\r?\n/)[1]);
  assert.equal(embedded.reduce((n, section) => n + section.steps.length, 0), EXPRESSIONS.length,
    'the page must publish one step per expression');
});

test('a template slot name the fill cannot match aborts the build', () => {
  // Written independently of the `[A-Z_]+` pattern, and asserted below to be outside it.
  const MALFORMED = ['{{page_title}}', '{{PAGE TITLE}}', '{{PAGE-TITLE}}', '{{ PAGE_TITLE }}', '{{Page_Title}}'];
  assert.equal(new Set(MALFORMED).size, 5, 'five distinct malformed spellings, not a sample of one');
  const caught = MALFORMED.filter(slot => {
    // Armed in the production shape — unanchored, as the scan is. An anchored check
    // would pass `{{{HEADLINE}}}`, which the scan skips, and leave the deepEqual to fail
    // instead of this line.
    assert.ok(slot.replace(/\{\{[A-Z_]+\}\}/g, '').includes('{{'),
      slot + ' must leave a `{{` the fill pattern cannot match');
    try { builder.buildSmokePage(sidecar(), template + '\n' + slot); return false; }
    catch (e) { return /^self-check failed: the template carries a `\{\{` that is not a slot/.test(e.message); }
  });
  assert.deepEqual(caught, MALFORMED, 'every malformed slot name must abort the build, naming the template');
  // The other side of the boundary: the same template, plus a WELL-FORMED marker, builds.
  assert.doesNotThrow(() => builder.buildSmokePage(sidecar(), template + '\n{{HEADLINE}}'));
});

test('a template slot the sidecar cannot fill aborts the build', () => {
  assert.throws(() => builder.buildSmokePage(sidecar(), template + '\n{{NO_SUCH_SLOT}}'),
    /^Error: template wants a slot the sidecar cannot fill: \{\{NO_SUCH_SLOT\}\}$/m);
  assert.doesNotThrow(() => builder.buildSmokePage(sidecar(), template + '\n{{BUILD_SHA}}'));
});

test('the same sidecar always produces the same bytes', () => {
  assert.equal(build(), build());
  assert.notEqual(build(), build(onBuild('b'.repeat(40))));
});

for (const [label, newline] of [['LF', '\n'], ['CRLF', '\r\n']]) {
  test(`sections survive the fill verbatim and stay inside the script block (${label} template)`, () => {
    const data = sidecar({ sections: sidecar().sections.map(s => ({ ...s,
      steps: s.steps.map(step => ({ ...step, aside: 'Close the </script> tag reader trap' })) })) });
    const html = builder.buildSmokePage(data, template.replace(/\r?\n/g, newline));
    assert.equal(html.includes('</script> tag reader trap'), false, 'a prose `</script>` must not close the block');
    const match = html.match(/var SECTIONS = (\[[\s\S]*?\]);\r?\n/);
    assert.ok(match, 'the generated page must contain the complete SECTIONS assignment');
    const embedded = match[1];
    assert.deepEqual(JSON.parse(embedded.replace(/<\\\//g, '</')), data.sections);
  });
}

test('facts render in the documented order, with the old version struck through', () => {
  const html = build();
  assert.match(html, /<dt>Branch<\/dt><dd><code>chore\/smoke-hardening-ledger<\/code><\/dd>/);
  assert.match(html, /0\.14\.0 <span class="was">0\.13\.2<\/span>/);
  assert.match(html, /<dt>Tip<\/dt><dd><code>af57139<\/code><\/dd>/);
  const order = ['Branch', 'Version should read', 'Tip', 'Suite', 'Known failures']
    .map(dt => html.indexOf('<dt>' + dt + '</dt>'));
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
  assert.equal(build({ suite: undefined, knownFailures: undefined, version: undefined })
    .includes('<dt>Suite</dt>'), false);
});

test('the gate renders the documented structure', () => {
  const html = build();
  const gate = html.slice(html.indexOf('gate-eyebrow'), html.indexOf('</ol>'));
  assert.match(gate, /Step 0 — prove you are on the right build/);
  assert.match(gate, /<pre><code>git switch chore\/smoke-hardening-ledger<\/code><\/pre>/);
  assert.match(gate, /<ol class="gate-checks">/);
  // Validation proves the SIDECAR carries the containment commands. This proves they
  // REACH the page the tester actually runs: rendering only the first command leaves
  // the eyeballed gate in place while every other assertion here stays green.
  const commands = gateFor(SHA).commands;
  assert.equal(commands.length, 3, 'the fixture gate is the branch command plus both containment commands');
  for (const command of commands) {
    assert.ok(gate.includes('<pre><code>' + command + '</code></pre>'),
      'the gate must publish this command verbatim: ' + command);
  }
});

test('derived headings can be overridden without touching the template', () => {
  assert.match(build(), /C1 smoke run — Smoke-page hardening \(0\.14\.0\)/);
  assert.match(build({ copyHeader: 'C1 re-issue' }), /C1 re-issue/);
  assert.match(build({ standfirst: 'All three failures fixed.' }), /All three failures fixed\./);
  assert.match(build(), /3 steps in 2 sections/);
});

test('a sidecar that would produce a broken run sheet is refused', () => {
  fails({ buildSha: 'af57139' }, /full 40- or 64-character/);
  fails({ branch: '' }, /missing: branch/);
  fails({ sections: [] }, /no sections/);
  fails({ gate: { checks: [] } }, /gate has no checks/);
  const dup = sidecar().sections; dup[1].steps[0].n = 2;
  fails({ sections: dup }, /step number 2 is used twice/);
  const noPass = sidecar().sections; delete noPass[0].steps[0].pass;
  fails({ sections: noPass }, /needs both/);
  const noRevision = sidecar().sections; delete noRevision[1].steps[0].pre.stepRevision;
  fails({ sections: noRevision }, /evidence with no stepRevision/);
});

// The one gate whose job is "are you testing the right tree" resolved to eyeballing on
// every run this skill has produced: committing the page moves HEAD past `buildSha`, so
// a `git rev-parse HEAD` comparison can never agree and was waived by hand each time.
test('a gate that cannot prove containment mechanically is refused', () => {
  // The control the whole test rests on: the contract's own gate builds. Every case
  // below removes exactly one thing from it, so no rejection is satisfied by an input
  // that could never have been accepted.
  assert.doesNotThrow(() => build(), 'the gate execution-models.md specifies must build');
  const without = drop => ({ ...gateFor(SHA), commands: gateFor(SHA).commands.filter(c => !c.includes(drop)) });
  fails({ gate: without('merge-base') }, /no containment check: gate\.commands must run `git merge-base --is-ancestor/);
  fails({ gate: without('--name-only') }, /no containment check: gate\.commands must run `git diff --name-only/);
  fails({ gate: { ...gateFor(SHA), commands: [] } },
    /no containment check:.*merge-base --is-ancestor.*and.*diff --name-only.*and.*af57139/);
  fails({ gate: { ...gateFor(SHA), commands: undefined } }, /no containment check/);
  // The hand-written escape hatch both ledgers on this version carried: a prose check
  // asking a human to adjudicate the difference, with nothing that executes.
  fails({ gate: { checks: ['Tested source commit: <code>af57139</code>. A later commit '
    + 'containing only checkpoint artifacts is allowed.'] } }, /no containment check/);
  // EXECUTED versus EYEBALLED is the whole of BL-012, so pin the pair that separates
  // them: the very same two commands, complete and naming this build, written as prose
  // in `checks` for a human to run by hand. Accepting containment found in `checks`
  // would leave every other case here green.
  fails({ gate: { commands: [], checks: [`Run git merge-base --is-ancestor ${SHA} HEAD and then `
    + `git diff --name-only ${SHA}..HEAD -- . ":(exclude).agents/" yourself, and compare.`] } },
    /no containment check:.*merge-base --is-ancestor.*and.*diff --name-only.*and.*af57139/);
  // Near misses: each runs, and each differs from a required command by exactly the
  // flag that makes it a containment proof. `git merge-base main HEAD` plus a plain
  // `git diff` is two real commands and no proof of anything.
  const near = commands => ({ ...gateFor(SHA), commands });
  fails({ gate: near([`git merge-base ${SHA} HEAD`, `git diff --name-only ${SHA}..HEAD`]) },
    /no containment check: gate\.commands must run `git merge-base --is-ancestor/);
  fails({ gate: near([`git merge-base --is-ancestor ${SHA} HEAD`, `git diff ${SHA}..HEAD`]) },
    /no containment check: gate\.commands must run `git diff --name-only/);
  fails({ gate: near(['git merge-base main HEAD', `git diff ${SHA}..HEAD`]) },
    /no containment check:.*merge-base --is-ancestor.*and.*diff --name-only/);
  // Case matters, because git's flags are case-sensitive: `--IS-ANCESTOR` is not a flag.
  fails({ gate: near([`git merge-base --IS-ANCESTOR ${SHA} HEAD`, `git diff --name-only ${SHA}..HEAD`]) },
    /no containment check: gate\.commands must run `git merge-base --is-ancestor/);
  fails({ gate: near([`git merge-base --is-ancestor ${SHA} HEAD`, `git DIFF --NAME-ONLY ${SHA}..HEAD`]) },
    /no containment check: gate\.commands must run `git diff --name-only/);
  // Containment of SOME build is not containment of THIS one — and naming this one
  // turns the very same gate into an accepted gate.
  fails({ gate: gateFor('b'.repeat(40)) }, /no containment check:.*the tested build `af57139` itself/);
  assert.doesNotThrow(() => build(onBuild('b'.repeat(40))), 'a gate naming its own build is accepted');
  assert.doesNotThrow(() => build({ gate: gateFor(SHA.slice(0, 7)) }), 'the documented 7-hex short form counts');
  for (const commands of ['git status', 42, true, [null], [42], [['git']], [{}]]) {
    fails({ gate: { ...gateFor(SHA), commands } }, /gate\.commands must be an array of command strings/);
  }
});

// The spec, the baked contract and the enforcement have to fail TOGETHER, or the
// three-way agreement holds only until someone edits a document. Both files are in this
// batch's fence for exactly this reason. This is also the dogfood: what a future
// scaffolder copies out of the contract is what the builder is fed here.
function publishedContainmentBlock(file) {
  const text = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  const fenced = [...text.matchAll(/```text\r?\n([\s\S]*?)```/g)].map(m => m[1]);
  const blocks = fenced.filter(block => block.includes('merge-base --is-ancestor'));
  assert.equal(blocks.length, 1, file + ': exactly one fenced block must publish the containment commands');
  const lines = blocks[0].split(/\r?\n/).filter(Boolean);
  assert.equal(lines.length, 2, file + ': the published block is the two containment commands');
  return lines;
}

// smoke-page.md states the same contract a fourth time, as two inline spans rather than
// a fenced block. Drift there is loud rather than silent — an author following it writes
// a sidecar the builder rejects — but it is still a statement of the contract no test
// read, so it is read here too.
function publishedInlineCommands(file) {
  const text = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  const spans = [...text.matchAll(/`([^`\r\n]+)`/g)].map(m => m[1]).filter(span => span.startsWith('git '));
  return ['merge-base --is-ancestor', 'diff --name-only'].map(needle => {
    const hits = [...new Set(spans.filter(span => span.includes(needle)))];
    assert.equal(hits.length, 1,
      file + ': exactly one inline `git ...` span must publish ' + needle + ' — found ' + JSON.stringify(hits));
    return hits[0];
  });
}

const CONTAINMENT_SOURCES = [
  { file: 'orchestrate/references/execution-models.md', read: publishedContainmentBlock },
  { file: 'orchestrate/templates/00-READBEFORE.md', read: publishedContainmentBlock },
  { file: 'orchestrate/references/smoke-page.md', read: publishedInlineCommands }
];

test('the published containment block is the one the builder accepts', () => {
  assert.equal(CONTAINMENT_SOURCES.length, 3,
    'the spec, the baked contract and the reference prose each state this contract and must each be read');
  const published = CONTAINMENT_SOURCES.map(({ file, read }) => [file, read(file)]);
  for (const [file, lines] of published) {
    assert.deepEqual(lines, published[0][1], file + ': every statement of the contract must publish the same two commands');
  }
  for (const [file, lines] of published) {
    // Negative control first: the block AS PUBLISHED, placeholder unsubstituted, is
    // refused — so the acceptance below is about the commands, not about any string.
    fails({ gate: { ...gateFor(SHA), commands: lines } },
      /no containment check:.*the tested build `af57139` itself/);
    const filled = lines.map(line => line.replaceAll('<buildSha>', SHA));
    assert.notDeepEqual(filled, lines, file + ': the published block must carry the <buildSha> placeholder');
    assert.doesNotThrow(() => build({ gate: { ...gateFor(SHA), commands: filled } }),
      file + ': a gate authored from the published block must build');
    // And it must reach the page, not merely validate.
    const html = build({ gate: { ...gateFor(SHA), commands: filled } });
    for (const command of filled) {
      assert.ok(html.includes('<pre><code>' + command + '</code></pre>'),
        file + ': the published command must reach the rendered gate: ' + command);
    }
  }
});

// An invisible U+0000 inside a copyable command reached a published hand-over and made
// that command a SyntaxError for anyone who pasted it.
test('an invisible control character anywhere in the sidecar is refused', () => {
  // The domain smoke-page.md publishes, written out independently of the predicate in
  // build-smoke-page.mjs: Unicode Cc entire — C0, DEL and C1 — minus tab and newline.
  // Its size and its edges are asserted, so widening the list and the rule in one edit
  // still reddens. Built from code points, never written as escapes: an editor or
  // transport that decodes an escape puts the invisible byte into this file instead of
  // testing it — the accident the source sweep below exists to catch.
  const c0 = [...Array(0x20).keys()], c1 = [...Array(0x20).keys()].map(i => 0x80 + i);
  const points = [...c0, 0x7f, ...c1];
  assert.equal(points.length, 65, 'the sweep must cover C0, DEL and C1 entire, not a sample');
  assert.deepEqual([Math.min(...points), Math.max(...points)], [0x00, 0x9f]);
  const controls = points.map(i => String.fromCharCode(i));
  const allowed = new Set([String.fromCharCode(9), String.fromCharCode(10)]);
  assert.deepEqual(controls.filter(c => allowed.has(c)).map(c => c.codePointAt(0)), [9, 10]);
  // Each placement reaches a different arm of the recursion AND names its own path in
  // the diagnostic, so deleting a placement and its arm in one edit changes the size.
  const placements = [
    { where: /^sidecar\.gate\.commands\[0\] carries/,
      make: ch => ({ gate: { ...gateFor(SHA), commands: [`git switch main${ch}`, ...gateFor(SHA).commands] } }) },
    { where: /^sidecar\.sections\[0\]\.steps\[0\]\.do carries/,
      make: ch => { const sections = sidecar().sections; sections[0].steps[0].do = `Mark it${ch}Fail.`; return { sections }; } },
    { where: /^sidecar: key "stray/, make: ch => ({ [`stray${ch}key`]: 'a value' }) },
    { where: /^sidecar\.facts\[0\]\.dd carries/, make: ch => ({ facts: [{ dt: 'Note', dd: `plain${ch}text` }] }) }
  ];
  assert.equal(placements.length, 4,
    'an array element, nested step prose, an object KEY and a nested object must all be swept');
  assert.equal(new Set(placements.map(p => String(p.where))).size, 4,
    'each placement must reach a distinct recursion path');
  const reached = new Set();
  for (const ch of controls) {
    const point = ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0');
    for (const place of placements) {
      // Both directions on the same placement: tab and newline are the paired positive
      // controls, so a rule that rejected everything would redden here.
      if (allowed.has(ch)) { assert.doesNotThrow(() => build(place.make(ch)), 'U+' + point); continue; }
      let message = '';
      try { build(place.make(ch)); } catch (error) { message = error.message; }
      assert.match(message, place.where, 'U+' + point + ': the diagnostic must name the path it found it at');
      assert.ok(message.includes(`carries control character U+${point};`),
        `U+${point} must be refused and named in the message — got: ${message}`);
      reached.add(String(place.where));
    }
  }
  assert.equal(reached.size, placements.length, 'every placement must actually have produced a rejection');
  // Both edges of the forbidden range. 0x1F, 0x7F, 0x80 and 0x9F are rejected in the
  // sweep above; their neighbours just outside it must build, so a narrowing is as
  // visible as a widening. U+2028/U+2029 are separators, not Cc, and stay legal.
  const OUTSIDE_Cc = [0x20, 0x7e, 0xa0, 0xa1, 0x2028, 0x2029];
  assert.equal(OUTSIDE_Cc.length, 6, 'one neighbour beyond each Cc edge (0x20 above C0, 0x7E below '
    + 'DEL, 0xA0 above C1), plus an ordinary printable and both Unicode separators');
  // Bound to the swept domain itself, not sampled: the code point one past the top of
  // the forbidden range must be in this list. Without it, widening C1_LAST to 0xA0 —
  // which rejects a no-break space, legitimate in prose — passes in silence.
  assert.deepEqual(OUTSIDE_Cc.filter(code => code === Math.max(...points) + 1), [0xa0],
    'the neighbour one past the top of the swept domain must be an accepted control');
  for (const outside of OUTSIDE_Cc) {
    assert.doesNotThrow(() => build({ change: 'Edge ' + String.fromCharCode(outside) + ' case' }),
      'U+' + outside.toString(16).toUpperCase().padStart(4, '0') + ' is outside Cc and must still build');
  }
});

// The rule above protects sidecars. Nothing protected this repository's OWN source, and
// the accident has landed twice: once in this batch's first draft, where the rule's own
// character class was written as escapes, decoded into literal control bytes on the way
// into the file, and left the suite green at 301/301; and once earlier, where a literal
// U+2028 sat inside a fixture name for the whole life of that fixture. A human running a
// byte scan catches it for one batch. This catches it for every batch.
//
// Domain enforced, stated rather than implied: Unicode Cc entire (C0, DEL, C1) minus
// tab and LF, plus the Unicode line and paragraph separators U+2028/U+2029, which is the
// pair that actually got in. CR is spared ONLY as the first half of a CRLF pair — this
// working tree is CRLF. A LONE CR is invisible and splits a pasted command exactly as
// the NEL this rule was widened to C1 for.
const SOURCE_TAB = 9, SOURCE_LF = 10, SOURCE_CR = 13;
const forbiddenInSource = code =>
  (code < 32 && code !== SOURCE_TAB && code !== SOURCE_LF && code !== SOURCE_CR)
  || code === 127 || (code >= 128 && code <= 159) || code === 0x2028 || code === 0x2029;
// An extension DENY-list, not a content sniff: a new kind of TEXT file is swept by
// default, and a binary kind nobody listed fails loudly rather than passing silently.
// Both errors land on the safe side; neither is silent.
const NOT_TEXT = /\.(?:xlsx|xls|png|jpe?g|gif|ico|pdf|zip|gz|woff2?|ttf|eot|exe|dll)$/i;
const SWEEP_EXCLUDED = ['.git', '.agents', 'node_modules'];

// Returns what it FOUND and what it COVERED. The second half is the point: a sweep whose
// domain is a hand-written array quietly shrinks when someone edits the array.
function invisibleCharacterScan(root) {
  const found = [], covered = new Set();
  const walk = (dir, top) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : 1)) {
      if (SWEEP_EXCLUDED.includes(entry.name)) continue;
      const full = path.join(dir, entry.name), name = top ?? entry.name;
      covered.add(name);
      if (entry.isDirectory()) { walk(full, name); continue; }
      if (NOT_TEXT.test(entry.name)) continue;
      const characters = [...fs.readFileSync(full, 'utf8')];
      let line = 1;
      for (let i = 0; i < characters.length; i++) {
        const code = characters[i].codePointAt(0);
        if (code === SOURCE_LF) { line++; continue; }
        if (code === SOURCE_CR) {
          if (characters[i + 1]?.codePointAt(0) === SOURCE_LF) continue;
        } else if (!forbiddenInSource(code)) continue;
        found.push(path.relative(root, full).split(path.sep).join('/') + ':' + line
          + ': U+' + code.toString(16).toUpperCase().padStart(4, '0'));
      }
    }
  };
  walk(root, undefined);
  return { found, covered: [...covered].sort() };
}

test('no file this repository publishes carries an invisible character', t => {
  // The live control comes FIRST, so the silence over the repository means something. It
  // plants one byte from each part of the domain — a C0 NUL, a C1 NEL, a separator and a
  // LONE CR — in a SUBDIRECTORY (the walk must recurse), beside a clean file whose tabs
  // and CRLF pairs must be spared, a binary full of NULs that must be skipped, and
  // excluded directories whose planted bytes must NOT be reported.
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'invisible-source-'));
  t.after(() => fs.rmSync(scratch, { recursive: true, maxRetries: 8, retryDelay: 100 }));
  fs.mkdirSync(path.join(scratch, 'nested'));
  fs.writeFileSync(path.join(scratch, 'clean.cjs'), 'const ok = 1;\r\nconst tabbed = 2;\t// fine\r\n');
  fs.writeFileSync(path.join(scratch, 'nested', 'planted.cjs'),
    'const nul = "' + String.fromCharCode(0x00) + '";\n'
    + 'const nel = "' + String.fromCharCode(0x85) + '";\n'
    + 'const sep = "' + String.fromCharCode(0x2028) + '";\n'
    + 'const lone = "git status' + String.fromCharCode(0x0d) + ' --short";\n');
  fs.writeFileSync(path.join(scratch, 'binary.xlsx'), Buffer.from([0, 1, 2, 3]));
  for (const excluded of SWEEP_EXCLUDED) {
    fs.mkdirSync(path.join(scratch, excluded));
    fs.writeFileSync(path.join(scratch, excluded, 'record.md'), 'quoted ' + String.fromCharCode(0x00) + ' verbatim\n');
  }
  const control = invisibleCharacterScan(scratch);
  assert.deepEqual(control.found,
    ['nested/planted.cjs:1: U+0000', 'nested/planted.cjs:2: U+0085',
      'nested/planted.cjs:3: U+2028', 'nested/planted.cjs:4: U+000D'],
    'the sweep must recurse, report each planted byte with its line including a lone CR, '
    + 'spare tab and CRLF, skip binary files, and never descend into an excluded directory');
  assert.deepEqual(control.covered, ['binary.xlsx', 'clean.cjs', 'nested'],
    'coverage must be the top-level entries minus the exclusions, binaries included as visited');

  // The swept domain is the CHECKOUT, not a list in this file: every top-level entry
  // except the stated exclusions. It then grows with the repository instead of needing
  // maintenance, and narrowing it to one tree cannot pass. `.agents/` stays out on
  // purpose — those ledgers are historical records that quote published bytes verbatim.
  const ROOT = path.join(__dirname, '..');
  const expected = fs.readdirSync(ROOT).filter(name => !SWEEP_EXCLUDED.includes(name)).sort();
  assert.ok(expected.length > 2, 'the repository root must offer more than the two source trees to sweep');
  const repository = invisibleCharacterScan(ROOT);
  assert.deepEqual(repository.covered, expected,
    'the sweep must cover every top-level entry of the checkout except ' + SWEEP_EXCLUDED.join(', '));
  assert.deepEqual(repository.found, [],
    'an invisible character in a published file is an escape something decoded on the way in — '
    + 'rebuild that literal with String.fromCharCode instead of exempting the file');
});

// Two of the five documentation defects in a published page were a `Section 5` and a
// `Step 3` that no longer existed after a restructure — both mechanically detectable.
test('a Section or Step cross-reference the sidecar does not contain is refused', () => {
  const place = text => { const sections = sidecar().sections;
    sections[0].steps[0].aside = text; return { sections }; };
  // Positive controls, one per thing that must resolve: existing sections, existing
  // steps, the Step 0 gate every page has, and a lower-case phrase that is prose rather
  // than a cross-reference. The domain's size is asserted, so deleting the Step 0
  // control and the Step 0 exemption in one edit cannot stay green.
  const resolving = ['See Section 1 and Section 2.', 'Repeat Step 1, Step 2 and Step 3.',
    'Redo Step 0 first.', 'Mark step 1 and section 9 in your own notes.'];
  assert.equal(resolving.length, 4,
    'sections, steps, the Step 0 gate and the lower-case non-reference each need a control');
  for (const text of resolving) assert.doesNotThrow(() => build(place(text)), text);
  fails(place('Continue from Section 5.'), /"Section 5" refers to a section this sidecar does not contain/);
  fails(place('Repeat Step 4.'), /"Step 4" refers to a step this sidecar does not contain/);
  fails(place('See Section  6.'), /"Section 6" refers to a section/);
  fails(place('There is no Section 0.'), /"Section 0" refers to a section/);
  // Any string in the sidecar, not only step prose.
  fails({ standfirst: 'Start at Step 9.' }, /"Step 9" refers to a step/);
  fails({ gate: { ...gateFor(SHA), checks: ['Then do Section 7.'] } }, /"Section 7" refers to a section/);
  // The paired control for the rejection: the reference is accepted the moment its
  // target exists, so the refusal was about the missing target, not about the wording.
  const withFourth = place('Repeat Step 4.');
  withFourth.sections[1].steps.push({ n: 4, do: 'Perform new check 4.', pass: 'It succeeds.', revision: 1 });
  assert.doesNotThrow(() => build(withFourth));
});

// A page whose script does not parse has no verdict buttons and no copy button, so
// every fill must be checked by compiling the script the user would actually get.
const script = html => html.match(/<script>([\s\S]*?)<\/script>/)[1];
const compiles = html => new vm.Script(script(html));

test('ordinary punctuation in a plain name never breaks the generated script', () => {
  // The separator case is BUILT from its code point. Written as an escape, it was
  // decoded on the way into this file by an earlier batch's editor, and the literal
  // U+2028 then sat here, green, for the whole life of the fixture.
  const separatorName = 'Separator' + String.fromCharCode(0x2028) + 'pack';
  for (const change of ['Fix "Save as"', 'Back\\slash pack', 'Two\nlines', 'A </script> name',
    'Ampersand & <b>markup</b>', separatorName]) {
    compiles(build({ change }));
    const emitted = script(build({ change })).match(/var lines = \["([^\n]*?)", "Current build/)[1];
    assert.equal(JSON.parse('"' + emitted + '"'), `C1 smoke run — ${change} (0.14.0)`,
      'the copy header must survive escaping as the text the user pasted back');
  }
  compiles(build({ copyHeader: 'C1 "re-issue" \\ 2' }));
  assert.match(build({ change: 'A <b> name' }), /<title>A &lt;b&gt; name Smoke Run<\/title>/);
  assert.match(build({ change: 'A <b> name' }), /<h1>A &lt;b&gt; name — smoke run<\/h1>/);
  // Slots the format documents AS HTML keep their markup.
  assert.match(build({ headline: 'Ship <strong>now</strong>' }), /<h1>Ship <strong>now<\/strong><\/h1>/);
});

test('embedded data cannot introduce HTML parser tokens and round-trips unchanged', () => {
  // A regex-extracted script can compile while the browser consumes its closing
  // tag as data after `<!-- <script>`. Check the serialized data boundary too:
  // no literal '<' may enter the script from either JSON or a string slot.
  for (const text of ['<!-- <script>', '<!-- <ScRiPt >', '</script>', '</ScRiPt >',
    '<strong>Keep this markup</strong>', 'Separators\u2028and\u2029newlines\n']) {
    const data = sidecar({ change: `Handle ${text} markers` });
    data.sections[0].steps[0].aside = text;
    const slots = builder.renderSlots(data);
    assert.equal(slots.SECTIONS_JS.includes('<'), false, 'section data must not affect HTML parsing');
    assert.equal(slots.COPY_HEADER.includes('<'), false, 'the derived header must not affect HTML parsing');
    assert.deepEqual(JSON.parse(slots.SECTIONS_JS), data.sections);
    assert.equal(JSON.parse('"' + slots.COPY_HEADER + '"'),
      `C1 smoke run — ${data.change} (0.14.0)`);
    compiles(builder.buildSmokePage(data, template));

    const custom = builder.renderSlots({ ...data, copyHeader: text });
    assert.equal(custom.COPY_HEADER.includes('<'), false, 'an explicit header uses the same protection');
    assert.equal(JSON.parse('"' + custom.COPY_HEADER + '"'), text);
  }
});

test('step and section numbers must be ones the page can tell apart', () => {
  const asString = sidecar().sections; asString[1].steps[0].n = '1';
  fails({ sections: asString }, /step number "1" must be a positive integer/);
  const fraction = sidecar().sections; fraction[0].steps[0].n = 1.5;
  fails({ sections: fraction }, /step number 1.5 must be a positive integer/);
  const zero = sidecar().sections; zero[0].steps[0].n = 0;
  fails({ sections: zero }, /step number 0 must be a positive integer/);
  const absent = sidecar().sections; delete absent[0].steps[0].n;
  fails({ sections: absent }, /step number undefined must be a positive integer/);
  const dupSection = sidecar().sections; dupSection[1].n = 1;
  fails({ sections: dupSection }, /section number 1 is used twice/);
  const badRevision = sidecar().sections; badRevision[0].steps[0].revision = '2';
  fails({ sections: badRevision }, /revision "2" must be a positive integer/);
});

test('keys and provenance that the page cannot use are refused', () => {
  fails({ ckptKey: 'c1"-run' }, /ckptKey must be letters, digits/);
  fails({ ckptKey: 'c1 */ end' }, /ckptKey must be letters, digits/);
  const shortSha = sidecar().sections; shortSha[1].steps[0].pre.sha = 'af57';
  fails({ sections: shortSha }, /pre.sha must be at least 7 hex characters/);
  compiles(build({ ckptKey: 'orch-smoke.c1_2' }));
});

test('checkpoint storage keys cannot be coerced from other JSON types', () => {
  for (const ckptKey of [null, 42, true, false, [], ['c1'], {}]) {
    fails({ ckptKey }, /ckptKey must be a nonempty string/);
  }
  fails({ ckptKey: '' }, /missing: ckptKey/);
  fails({ ckptKey: ' ' }, /ckptKey/);
  for (const ckptKey of ['orch-smoke.c1_2', '42']) {
    assert.equal(builder.renderSlots(sidecar({ ckptKey })).CKPT_KEY, ckptKey);
  }
});

const reissue = (current, previous, options = {}) =>
  builder.buildSmokePage(current, template, { previous, ...options });
const newStep = n => ({ n, do: `Perform new check ${n}.`, pass: 'It succeeds.', revision: 1 });

test('reissues append after existing steps, in the final section or new sections', () => {
  const previous = sidecar();
  const original = JSON.stringify(previous);
  const current = sidecar(onBuild('b'.repeat(40)));
  current.sections[1].steps.push(newStep(4));
  current.sections.push({ n: 3, title: 'New coverage', steps: [newStep(5), newStep(6)] });
  const html = reissue(current, previous);
  assert.deepEqual(JSON.parse(builder.renderSlots(current).SECTIONS_JS), current.sections);
  assert.match(html, /6 steps in 3 sections/);
  assert.equal(html, reissue(current, previous));
  assert.deepEqual(current.sections.flatMap(s => s.steps).slice(0, 3), previous.sections.flatMap(s => s.steps));
  assert.equal(JSON.stringify(previous), original, 'validation never edits the previous sidecar');
});

test('reissues reject deletion, renumbering, reordering, and insertion before old steps', () => {
  const previous = sidecar();
  const cases = [
    d => d.sections[0].steps.pop(),
    d => { d.sections[0].steps[0].n = 8; },
    d => d.sections.reverse(),
    d => d.sections[0].steps.reverse(),
    d => d.sections[0].steps.push(newStep(4)),
    d => d.sections[1].steps.unshift(newStep(4))
  ];
  for (const edit of cases) {
    const current = sidecar(); edit(current);
    assert.throws(() => reissue(current, previous), /keep its number and position/);
  }
  // A gap in an older sidecar is not an available identity for newly added work.
  const gapped = sidecar(); gapped.sections[1].steps[0].n = 5;
  const current = structuredClone(gapped); current.sections[1].steps.push(newStep(4));
  assert.throws(() => reissue(current, gapped), /number greater than 5/);
  current.sections[1].steps.splice(1, 1, newStep(7), newStep(6));
  assert.throws(() => reissue(current, gapped), /number greater than 7/);
});

test('instruction changes require revision increases even on the same build', () => {
  for (const field of ['do', 'pass', 'aside', 'unit', 'tag']) {
    const previous = sidecar(), current = sidecar();
    current.sections[0].steps[0][field] = 'A corrected instruction';
    assert.throws(() => reissue(current, previous), /step 1:.*increment revision above 1/, field);
    current.sections[0].steps[0].revision = 2;
    assert.doesNotThrow(() => reissue(current, previous), field);
    assert.equal(current.sections[0].steps[1].revision, 2, 'unaffected revisions are preserved');
  }
  const previous = sidecar(), current = sidecar();
  current.sections[0].steps[0].revision = 2;
  assert.doesNotThrow(() => reissue(current, previous), 'behavior-only changes may bump a revision');
});

test('changing section instructions requires increasing every affected existing revision', () => {
  for (const field of ['title', 'lede', 'need', 'order', 'touchesData']) {
    const previous = sidecar(), current = sidecar();
    current.sections[0][field] = field === 'touchesData' ? true : 'A changed prerequisite';
    assert.throws(() => reissue(current, previous), /step 1:.*section context changed/, field);
    current.sections[0].steps[0].revision++;
    assert.throws(() => reissue(current, previous), /step 2:.*section context changed/, field);
    current.sections[0].steps[1].revision++;
    assert.doesNotThrow(() => reissue(current, previous), field);
  }
});

test('later reissues cannot lose previous revision increases, including by omission', () => {
  const previous = sidecar(), current = sidecar();
  current.sections[0].steps[1].revision = 1;
  assert.throws(() => reissue(current, previous), /step 2: revision cannot decrease from 2 to 1/);
  delete current.sections[0].steps[1].revision;
  assert.throws(() => reissue(current, previous), /step 2: revision cannot decrease from 2 to 1/);
  current.sections[0].steps[1].revision = 2;
  delete current.sections[0].steps[0].revision;
  assert.doesNotThrow(() => reissue(current, previous), 'omitted and explicit initial revisions are equivalent');
  const next = structuredClone(current);
  next.sections[0].steps[0].pass = 'Corrected criterion';
  assert.throws(() => reissue(next, current), /increment revision above 1/);
  next.sections[0].steps[0].revision = 2;
  assert.doesNotThrow(() => reissue(next, current));
  assert.throws(() => reissue(current, next), /revision cannot decrease/);
});

test('page facts, evidence, and JSON key order do not invalidate unchanged instructions', () => {
  const previous = sidecar();
  const current = sidecar({ ...onBuild('b'.repeat(40)), suite: '30 / 30 pass',
    standfirst: 'Reissued after a repair.', copyHeader: 'C1 reissue',
    gate: { ...gateFor('b'.repeat(40)), checks: ['Confirm the new build.'] } });
  current.sections[1].steps[0].pre = { sha: 'b'.repeat(40), stepRevision: 1,
    env: 'New test environment', evidence: 'evidence/C1/new-run.md' };
  current.sections[0].steps[0] = Object.fromEntries(Object.entries(current.sections[0].steps[0]).reverse());
  assert.doesNotThrow(() => reissue(current, previous));
  delete current.sections[1].steps[0].pre;
  assert.doesNotThrow(() => reissue(current, previous));
});

test('checkpoint identity is stable and a clean sheet requires an explicit new storage key', () => {
  const previous = sidecar();
  assert.throws(() => reissue(sidecar({ checkpoint: 2 }), previous), /different checkpoint/);
  const reset = sidecar({ ckptKey: 'orch-smoke-c1r2' });
  assert.throws(() => reissue(reset, previous), /ckptKey changed/);
  assert.doesNotThrow(() => reissue(reset, previous, { resetVerdicts: true }));
  assert.throws(() => reissue(sidecar(), previous, { resetVerdicts: true }), /requires a new ckptKey/);
  assert.throws(() => builder.buildSmokePage(reset, template, { resetVerdicts: true }), /requires a previous sidecar/);
  reset.sections[0].steps[1].revision = 1;
  assert.throws(() => reissue(reset, previous, { resetVerdicts: true }), /revision cannot decrease/);
  const invalidPrevious = sidecar(); invalidPrevious.sections[0].steps[0].n = 2;
  assert.throws(() => reissue(sidecar(), invalidPrevious), /used twice/);
});

test('the command line writes the page, or explains why it did not', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-build-'));
  const json = path.join(dir, 'smoke-c1.json'), out = path.join(dir, 'smoke-c1.html');
  fs.writeFileSync(json, JSON.stringify(sidecar()));
  const ok = spawnSync(process.execPath, [BUILDER, json, out], { encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(fs.readFileSync(out, 'utf8'), build());
  // The success line is itself a claim about what was checked. The builder no longer
  // inspects the filled page, so it may not report a tally of unfilled slots in one.
  assert.equal(ok.stdout.trim(), out + ': ' + build().length + ' bytes, every template slot filled');
  assert.doesNotMatch(ok.stdout, /unfilled/, 'the success line may not claim a check the builder does not perform');

  fs.writeFileSync(json, JSON.stringify(sidecar({ buildSha: 'nope' })));
  const bad = spawnSync(process.execPath, [BUILDER, json, out], { encoding: 'utf8' });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /full 40- or 64-character/);

  fs.writeFileSync(json, JSON.stringify(sidecar({ ckptKey: null })));
  const invalidKey = spawnSync(process.execPath, [BUILDER, json, out], { encoding: 'utf8' });
  assert.equal(invalidKey.status, 1);
  assert.match(invalidKey.stderr, /ckptKey must be a nonempty string/);
  assert.equal(fs.readFileSync(out, 'utf8'), build(), 'invalid input must preserve the prior page');

  assert.equal(spawnSync(process.execPath, [BUILDER], { encoding: 'utf8' }).status, 2);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('CLI reissues require the last issued snapshot and preserve the old page on failure', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-reissue-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const json = path.join(dir, 'smoke-c1.json'), out = path.join(dir, 'smoke-c1.html');
  const old = path.join(dir, 'last-issued.json');
  const write = (file, data) => fs.writeFileSync(file, JSON.stringify(data));
  const run = (...args) => spawnSync(process.execPath, [BUILDER, json, out, ...args], { encoding: 'utf8' });
  const previous = sidecar(); write(json, previous); write(old, previous);
  let result = run(); assert.equal(result.status, 0, result.stderr);
  const firstHTML = fs.readFileSync(out, 'utf8');
  result = run(); assert.equal(result.status, 0, 'identical builds remain idempotent');

  const current = sidecar(); current.sections[1].steps.push(newStep(4));
  write(json, current);
  const failsWithoutWriting = (args, message, expectedHTML = firstHTML) => {
    const result = run(...args);
    assert.notEqual(result.status, 0, result.stderr);
    assert.match(result.stderr, message);
    assert.equal(fs.readFileSync(out, 'utf8'), expectedHTML);
  };
  failsWithoutWriting([], /requires --previous/);
  failsWithoutWriting(['--previous', json], /separate snapshot/);
  const alias = path.join(dir, 'input-alias.json'); fs.linkSync(json, alias);
  failsWithoutWriting(['--previous', alias], /separate snapshot/);
  failsWithoutWriting(['--previous'], /argument.*missing/i);
  failsWithoutWriting(['--previuos', old], /Unknown option/);
  current.sections[0].steps[0].do = 'Corrected action'; write(json, current);
  failsWithoutWriting(['--previous', old], /increment revision/);
  current.sections[0].steps[0].revision = 2; write(json, current);
  // Formatting and object-key order do not make a correct snapshot stale.
  write(old, Object.fromEntries(Object.entries(previous).reverse()));
  result = run('--previous', old, '--template', TEMPLATE_PATH);
  assert.equal(result.status, 0, result.stderr);
  const secondHTML = fs.readFileSync(out, 'utf8');
  assert.equal(secondHTML, reissue(current, previous));
  const oldBytes = fs.readFileSync(old, 'utf8');
  assert.deepEqual(JSON.parse(oldBytes), previous, 'the baseline is read-only');

  // Using the first issue again would allow both a dropped step and a rollback.
  write(json, previous);
  failsWithoutWriting(['--previous', old], /does not match the last issued page/, secondHTML);
  write(old, current);
  failsWithoutWriting(['--previous', old], /keep its number and position/, secondHTML);
  write(json, current);
  fs.writeFileSync(out, secondHTML.replace(/\r?\n/g, '\r\n'));
  result = run(); assert.equal(result.status, 0, 'Git line-ending conversion preserves idempotence');
  fs.writeFileSync(out, secondHTML.replace(/\r?\n/g, '\r\n'));
  result = run('--previous', old); assert.equal(result.status, 0, result.stderr);

  for (const input of [json, old]) {
    const before = fs.readFileSync(input, 'utf8');
    result = spawnSync(process.execPath, [BUILDER, json, input, '--previous', old], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /output must not overwrite/);
    assert.equal(fs.readFileSync(input, 'utf8'), before);
  }
  const reset = { ...current, ckptKey: 'orch-smoke-c1r2' }; write(json, reset);
  failsWithoutWriting(['--previous', old], /ckptKey changed/, secondHTML);
  result = run('--previous', old, '--reset-verdicts');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(out, 'utf8'), reissue(reset, current, { resetVerdicts: true }));
});

test('legacy pages require a reproducible baseline before their first guarded reissue', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-legacy-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const json = path.join(dir, 'smoke-c1.json'), out = path.join(dir, 'smoke-c1.html');
  const old = path.join(dir, 'last-issued.json');
  const previous = sidecar(), current = sidecar(); current.sections[1].steps.push(newStep(4));
  const legacyHTML = build().replace(/\n<!-- smoke-sidecar-sha256:[a-f0-9]{64} -->\n$/, '');
  const run = () => spawnSync(process.execPath, [BUILDER, json, out, '--previous', old], { encoding: 'utf8' });
  fs.writeFileSync(out, legacyHTML);
  fs.writeFileSync(json, JSON.stringify(current));
  fs.writeFileSync(old, JSON.stringify({ ...previous, suite: 'Different issued content' }));
  let result = run(); assert.equal(result.status, 1);
  assert.match(result.stderr, /does not match the last issued page/);
  assert.equal(fs.readFileSync(out, 'utf8'), legacyHTML);
  fs.writeFileSync(old, JSON.stringify(previous));
  result = run(); assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(out, 'utf8'), reissue(current, previous));
});

function inputPackage(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-real-build-'));
  t.after(() => fs.rmSync(root, { recursive: true, maxRetries: 8, retryDelay: 100 }));
  const put = (name, bytes) => {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), bytes);
    return { path: name, size: Buffer.byteLength(bytes), sha256: createHash('sha256').update(bytes).digest('hex') };
  };
  const report = put('evidence/C1/inputs/validation-001/report.txt', 'Independent workbook fixture validation: passed.\n');
  const workbook = fs.readFileSync(path.join(__dirname, 'fixtures/smoke-inputs/orders.xlsx'));
  const d = sidecar();
  d.inputs = [{ id: 'orders', ...put('evidence/C1/inputs/issue-001/orders.xlsx', workbook),
    requirements: 'Three sheets; text IDs, formulas/caches; total 23.50/count 4.',
    validation: { ...report, command: 'python validate-orders.py orders.xlsx orders.requirements.json',
      exitCode: 0, result: 'All fixture requirements passed.', env: 'Independent B02 validator' },
    mode: 'working-copy', use: 'Copy orders.xlsx to a temporary working file.', reset: 'Recopy the issued original.' }];
  d.sections[0].steps[0].inputs = ['orders']; d.sections[1].steps[0].inputs = ['orders'];
  const json = path.join(root, 'smoke-c1.json'), out = path.join(root, 'smoke-c1.html');
  const write = data => fs.writeFileSync(json, JSON.stringify(data));
  const run = (...args) => spawnSync(process.execPath, [BUILDER, json, out, ...args], { encoding: 'utf8', windowsHide: true });
  return { root, put, report, workbook, d, json, out, write, run };
}

test('imported builder requires actual root/bytes and never accepts supplied digests on faith', t => {
  const f = inputPackage(t);
  assert.throws(() => builder.buildSmokePage(f.d, template), /explicit inputRoot/);
  const original = JSON.stringify(f.d);
  const built = builder.buildSmokePage(f.d, template, { inputRoot: f.root });
  assert.equal(JSON.stringify(f.d), original);
  const emitted = JSON.parse(built.match(/var SECTIONS = (\[[\s\S]*?\]);\r?\n/)[1]);
  assert.deepEqual(emitted[0].steps[0].inputFiles, f.d.inputs);
  assert.equal(emitted[0].steps[1].inputFiles, undefined);
  const bytes = Buffer.from(f.workbook); bytes[150] ^= 1;
  fs.writeFileSync(path.join(f.root, f.d.inputs[0].path), bytes);
  assert.throws(() => builder.buildSmokePage(f.d, template, { inputRoot: f.root }), /SHA-256 mismatch/);
});

test('CLI validates files beside output, preserving old HTML on file, digest, evidence and metadata failures', t => {
  const f = inputPackage(t); f.write(f.d);
  let r = f.run(); assert.equal(r.status, 0, r.stderr);
  const before = fs.readFileSync(f.out), original = path.join(f.root, f.d.inputs[0].path);
  const refuse = (message, ...args) => {
    const result = f.run(...args); assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, message); assert.deepEqual(fs.readFileSync(f.out), before);
  };
  const changed = Buffer.from(f.workbook); changed[200] ^= 1; fs.writeFileSync(original, changed);
  refuse(/SHA-256 mismatch/);
  fs.unlinkSync(original); refuse(/ENOENT/);
  fs.mkdirSync(original); refuse(/not a regular file/); fs.rmdirSync(original);
  fs.writeFileSync(original, f.workbook);
  const report = path.join(f.root, f.report.path), reportBytes = fs.readFileSync(report);
  fs.writeFileSync(report, Buffer.alloc(reportBytes.length)); refuse(/report.txt.*SHA-256 mismatch/);
  fs.writeFileSync(report, reportBytes);
  for (const mutate of [d => { d.inputs[0].use = ''; }, d => { d.sections[0].steps[0].inputs = ['missing']; },
    d => { d.inputs[0].path = '../outside.xlsx'; }]) {
    const invalid = structuredClone(f.d); mutate(invalid); f.write(invalid); refuse(/nonempty|dangling|safe relative/);
  }
  f.write(f.d); r = f.run(); assert.equal(r.status, 0, r.stderr);
  // The source JSON may be elsewhere: file URLs resolve beside the output HTML.
  const snapshot = path.join(f.root, 'snapshots', 'input.json'); fs.mkdirSync(path.dirname(snapshot));
  fs.writeFileSync(snapshot, JSON.stringify(f.d));
  r = spawnSync(process.execPath, [BUILDER, snapshot, f.out], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
});

test('CLI reissue refuses to overwrite the existing HTML declared as an issued input', t => {
  const f = inputPackage(t), previous = sidecar();
  f.write(previous);
  let result = f.run();
  assert.equal(result.status, 0, result.stderr);
  const issuedBytes = fs.readFileSync(f.out);
  const prior = path.join(f.root, 'last-issued.json');
  fs.writeFileSync(prior, JSON.stringify(previous));
  const current = structuredClone(previous);
  current.inputs = [{ ...f.d.inputs[0], id: 'prior-page', path: path.basename(f.out),
    size: issuedBytes.length, sha256: createHash('sha256').update(issuedBytes).digest('hex'),
    requirements: 'Preserve the issued prior page as an immutable input.',
    mode: 'read-only', use: 'Read the issued prior page.', reset: 'Recopy the preserved original page.' }];
  current.sections[0].steps[0].inputs = ['prior-page'];
  current.sections[0].steps[0].revision++;
  f.write(current);
  result = f.run('--previous', prior);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /output must not overwrite an issued input artifact/);
  assert.deepEqual(fs.readFileSync(f.out), issuedBytes, 'the entire issued input/output must remain byte-identical');
  assert.deepEqual(JSON.parse(fs.readFileSync(prior, 'utf8')), previous, 'the exact prior sidecar remains intact');
});

test('shared stable IDs require EVERY referencing revision for path, bytes and all semantic metadata changes', t => {
  const f = inputPackage(t);
  const edits = [
    d => { d.inputs[0].requirements += ' Check another edge case.'; },
    d => { d.inputs[0].use += ' Change C2.'; },
    d => { d.inputs[0].reset += ' Verify restored value.'; },
    d => { d.inputs[0].mode = 'read-only'; },
    d => { d.inputs[0].validation.command += ' --changed'; },
    d => { d.inputs[0].validation.result += ' New result text.'; },
    d => { d.inputs[0].validation.env += ' New environment.'; },
    d => { Object.assign(d.inputs[0], f.put('evidence/C1/inputs/issue-002/orders.xlsx', f.workbook)); },
    d => { const bytes = Buffer.from(f.workbook); bytes[200] ^= 1;
      Object.assign(d.inputs[0], f.put('evidence/C1/inputs/issue-002/orders.xlsx', bytes)); }
  ];
  for (const edit of edits) {
    const current = structuredClone(f.d); edit(current);
    current.inputHistory = [{ path: f.d.inputs[0].path, sha256: f.d.inputs[0].sha256, size: f.d.inputs[0].size }];
    const options = { previous: f.d, inputRoot: f.root };
    assert.throws(() => builder.buildSmokePage(current, template, options), /step 1:.*resolved inputs changed.*increment revision/);
    current.sections[0].steps[0].revision++;
    assert.throws(() => builder.buildSmokePage(current, template, options), /step 3:.*resolved inputs changed.*increment revision/);
    current.sections[1].steps[0].revision++;
    assert.doesNotThrow(() => builder.buildSmokePage(current, template, options));
    assert.equal(current.sections[0].steps[1].revision, f.d.sections[0].steps[1].revision);
    assert.equal(current.buildSha, f.d.buildSha, 'same-build changes must still invalidate input consumers');
  }
});

test('shared validation report identity changes invalidate all input consumers and require its historical bytes', t => {
  const f = inputPackage(t), current = structuredClone(f.d);
  current.inputs.push({ ...structuredClone(current.inputs[0]), id: 'second' });
  current.sections[1].steps[0].inputs = ['second'];
  const previous = structuredClone(current);
  const proof = f.put('evidence/C1/inputs/validation-002/report.txt', 'New independent validation.\n');
  current.inputs.forEach(input => Object.assign(input.validation, proof));
  current.inputHistory = [f.report];
  const options = { previous, inputRoot: f.root };
  assert.throws(() => builder.buildSmokePage(current, template, options), /step 1:.*increment revision/);
  current.sections[0].steps[0].revision++;
  assert.throws(() => builder.buildSmokePage(current, template, options), /step 3:.*increment revision/);
  current.sections[1].steps[0].revision++;
  assert.doesNotThrow(() => builder.buildSmokePage(current, template, options));
  fs.unlinkSync(path.join(f.root, f.report.path));
  assert.throws(() => builder.buildSmokePage(current, template, options), /validation-001.*ENOENT/);
});

test('LF/CRLF-only reissue refuses stale bytes then enforces new paths, all revisions and multi-issue history', t => {
  const f = inputPackage(t);
  Object.assign(f.d.inputs[0], f.put('evidence/C1/inputs/issue-001/raw.txt', 'one\ntwo\n'));
  f.write(f.d); let r = f.run(); assert.equal(r.status, 0, r.stderr);
  const before = fs.readFileSync(f.out), old = path.join(f.root, 'snapshots', 'previous.json');
  fs.mkdirSync(path.dirname(old)); fs.writeFileSync(old, JSON.stringify(f.d));
  const source = path.join(f.root, f.d.inputs[0].path);
  fs.writeFileSync(source, 'one\r\ntwo\r\n');
  r = f.run('--previous', old); assert.equal(r.status, 1); assert.match(r.stderr, /size mismatch/);
  assert.deepEqual(fs.readFileSync(f.out), before);
  const current = structuredClone(f.d); Object.assign(current.inputs[0], f.put(f.d.inputs[0].path, 'one\r\ntwo\r\n'));
  current.sections[0].steps[0].revision++; current.sections[1].steps[0].revision++;
  f.write(current); r = f.run('--previous', old); assert.equal(r.status, 1); assert.match(r.stderr, /immutable/);
  assert.deepEqual(fs.readFileSync(f.out), before);
  fs.writeFileSync(source, 'one\ntwo\n');
  Object.assign(current.inputs[0], f.put('evidence/C1/inputs/issue-002/raw.txt', 'one\r\ntwo\r\n'));
  f.write(current); r = f.run('--previous', old); assert.equal(r.status, 1); assert.match(r.stderr, /missing from inputs\/inputHistory/);
  current.inputHistory = [{ path: f.d.inputs[0].path, sha256: f.d.inputs[0].sha256, size: f.d.inputs[0].size }];
  current.sections[1].steps[0].revision--; f.write(current);
  r = f.run('--previous', old); assert.equal(r.status, 1); assert.match(r.stderr, /step 3:.*increment revision/);
  current.sections[1].steps[0].revision++; f.write(current);
  r = f.run('--previous', old); assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.readFileSync(source, 'utf8'), 'one\ntwo\n');
  const second = fs.readFileSync(f.out); fs.writeFileSync(old, JSON.stringify(current));
  fs.unlinkSync(source); r = f.run('--previous', old);
  assert.equal(r.status, 1); assert.match(r.stderr, /issue-001.*ENOENT/);
  assert.deepEqual(fs.readFileSync(f.out), second);
  fs.writeFileSync(source, 'one\ntwo\n');
  delete current.inputHistory; f.write(current); r = f.run('--previous', old);
  assert.equal(r.status, 1); assert.match(r.stderr, /missing.*issue-001/);
  assert.deepEqual(fs.readFileSync(f.out), second);
});

// ===== --help, and the sidecar smoke-page.md §Sidecar shape publishes ==========================
test('--help prints the usage the header comment shows, names §Sidecar shape, prints no absolute path and exits 0', () => {
  const r = spawnSync(process.execPath, [BUILDER, '--help'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, '');
  assert.match(r.stdout, /references\/smoke-page\.md §Sidecar shape/);
  const forms = r.stdout.split(/\r?\n/).map(l => /^(?:usage: | {7})(build-smoke-page\.mjs .+)$/.exec(l)?.[1]).filter(Boolean);
  const header = text => [...text.matchAll(/^\/\/ {3}node (build-smoke-page\.mjs .+)$/gm)].map(m => m[1]);
  const source = fs.readFileSync(BUILDER, 'utf8').replace(/\r\n/g, '\n'), anchor = ' [--reset-verdicts]\n//   node';
  assert.equal(forms.length, 2, 'the usage and the help form');
  assert.deepEqual(header(source), forms, 'the header comment shows the usage --help prints');
  assert.equal(source.split(anchor).length, 2, 'the control anchor occurs once');
  assert.notDeepEqual(header(source.split(anchor).join('\n//   node')), forms, 'live control: a header that drifts from --help is reported');
  // No absolute path, so the help reads alike through a linked skill directory or file.
  const absolute = text => text.split(/\s+/).map(w => w.replace(/^[("'`[]+|[)"'`.,;:\]]+$/g, '')).filter(w => path.isAbsolute(w) || /^[A-Za-z]:[\\/]/.test(w));
  assert.deepEqual(absolute(r.stdout), []);
  assert.deepEqual(absolute(r.stdout + ' (/opt/skill/references/smoke-page-template.html) C:\\skill\\x.html'),
    ['/opt/skill/references/smoke-page-template.html', 'C:\\skill\\x.html'], 'live control: a resolved path in either spelling is reported');
  // The usage refusal keeps its own exit code.
  assert.equal(spawnSync(process.execPath, [BUILDER, 'only-one.json'], { encoding: 'utf8' }).status, 2);
});

const SMOKE_DOC = path.join(__dirname, '../orchestrate/references/smoke-page.md');
// The subsection's prose and its one fenced json block, the block's bytes as the document holds them.
function sidecarSection(text) {
  const found = [...text.matchAll(/^### Sidecar shape\r?$/gm)];
  assert.equal(found.length, 1, 'smoke-page.md holds one Sidecar shape subsection');
  const rest = text.slice(found[0].index + found[0][0].length), next = rest.search(/^#{1,3} /m), body = next < 0 ? rest : rest.slice(0, next);
  const blocks = [...body.matchAll(/^```json\r?\n([\s\S]*?)^```\r?$/gm)];
  assert.equal(blocks.length, 1, 'the subsection publishes one json block');
  return { prose: body.slice(0, blocks[0].index), raw: blocks[0][1] };
}
// Every key path of a sidecar, an array's members spelled `*`.
function keyPaths(value, at) {
  if (Array.isArray(value)) return value.flatMap(item => keyPaths(item, at + '.*'));
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, item]) => { const here = at ? at + '.' + key : key; return [here, ...keyPaths(item, here)]; });
}
// A copy without one key path, each `*` its first member.
function without(data, keyPath) {
  const copy = structuredClone(data), parts = keyPath.split('.').map(p => p === '*' ? 0 : p), last = parts.pop();
  const parent = parts.reduce((node, part) => node[part], copy);
  assert.ok(Object.hasOwn(parent, last), 'the example holds ' + keyPath);
  delete parent[last];
  return copy;
}
// What the builder refuses a sidecar without, each with the refusal that names it.
const REFUSED_WITHOUT = {
  change: /^sidecar is missing: change$/, checkpoint: /^sidecar is missing: checkpoint$/, batches: /^sidecar is missing: batches$/,
  branch: /^sidecar is missing: branch$/, buildSha: /^sidecar is missing: buildSha$/, ckptKey: /^sidecar is missing: ckptKey$/,
  gate: /^sidecar is missing: gate$/, sections: /^sidecar is missing: sections$/,
  'gate.commands': /^the step-0 gate has no containment check/, 'gate.checks': /^the step-0 gate has no checks$/,
  'sections.*.n': /^section number undefined must be a positive integer$/, 'sections.*.steps': /^section 1 has no steps$/,
  'sections.*.steps.*.n': /^step number undefined must be a positive integer$/,
  'sections.*.steps.*.do': /^step 1 needs both `do` and `pass`$/, 'sections.*.steps.*.pass': /^step 1 needs both `do` and `pass`$/,
};
// What the example shows that a sidecar may leave out.
const OPTIONAL = ['version', 'version.was', 'suite', 'knownFailures', 'facts', 'pageTitle', 'eyebrow', 'headline', 'standfirst', 'copyHeader',
  'gate.intro', 'sections.*.touchesData', 'sections.*.lede', 'sections.*.need', 'sections.*.steps.*.revision', 'sections.*.steps.*.aside'];
// What the builder checks of none: a section's title, which its heading shows, and what an optional key holds.
const SHOWN = ['sections.*.title', 'version.now', 'facts.*.dt', 'facts.*.dd'];

test('smoke-page.md §Sidecar shape: the example builds, each key it names required is refused when absent and each optional one is not', () => {
  const { prose, raw } = sidecarSection(fs.readFileSync(SMOKE_DOC, 'utf8')), example = JSON.parse(raw);
  assert.doesNotThrow(() => builder.buildSmokePage(example, template), 'the documented example builds');
  // The domain is the example itself: every key it shows is classified, and every classified key is shown.
  assert.deepEqual([...new Set(keyPaths(example))].sort(), [...Object.keys(REFUSED_WITHOUT), ...OPTIONAL, ...SHOWN].sort());
  const faults = [];
  for (const [key, refusal] of Object.entries(REFUSED_WITHOUT)) {
    try { builder.buildSmokePage(without(example, key), template); faults.push(key + ': built without it'); }
    catch (e) { if (!refusal.test(e.message)) faults.push(key + ': refused for another reason — ' + e.message); }
  }
  for (const key of OPTIONAL) {
    try { builder.buildSmokePage(without(example, key), template); } catch (e) { faults.push(key + ': refused without it — ' + e.message); }
  }
  assert.deepEqual(faults, []);
  // The prose names each required key before "The rest is optional:" and each optional one after it, never both.
  const [before, after] = prose.split('The rest is optional:'), named = text => new Set([...text.matchAll(/`([A-Za-z]+)`/g)].map(m => m[1]));
  assert.ok(after !== undefined, 'the prose holds the optional list');
  const required = named(before), optional = named(after), last = key => key.split('.').pop();
  assert.deepEqual([...Object.keys(REFUSED_WITHOUT), 'sections.*.title'].map(last).filter(k => !required.has(k) || optional.has(k)), [], 'each required key is named as required');
  assert.deepEqual(OPTIONAL.map(last).filter(k => !optional.has(k) || required.has(k)), [], 'each optional key is named as optional');
});

test('smoke-page.md §Sidecar shape: the CLI builds the published bytes in either line ending, and refuses them without checkpoint', t => {
  const doc = fs.readFileSync(SMOKE_DOC, 'utf8').replace(/\r\n/g, '\n'), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidecar-shape-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const run = (name, raw) => {
    const json = path.join(dir, name + '.json'), out = path.join(dir, name + '.html');
    fs.writeFileSync(json, raw);
    const r = spawnSync(process.execPath, [BUILDER, json, out], { encoding: 'utf8' });
    return { status: r.status, stderr: r.stderr, html: r.status === 0 ? fs.readFileSync(out, 'utf8') : null };
  };
  const crlf = sidecarSection(doc.replace(/\n/g, '\r\n')).raw, lf = sidecarSection(doc).raw;
  assert.ok(crlf.includes('\r\n') && !lf.includes('\r'), 'each twin keeps its own line endings');
  const pages = [run('lf', lf), run('crlf', crlf)];
  assert.deepEqual(pages.map(p => [p.status, p.stderr]), [[0, ''], [0, '']]);
  assert.equal(pages[1].html, pages[0].html, 'both line endings build one page');
  assert.equal(pages[0].html, builder.buildSmokePage(JSON.parse(lf), template), 'the CLI builds what the module builds');
  // Live control on the published bytes: the line holding a required key taken out is refused, naming it.
  const line = '  "checkpoint": 1,\n';
  assert.equal(lf.split(line).length, 2, 'the example holds the checkpoint line once');
  const refused = run('without-checkpoint', lf.split(line).join(''));
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /sidecar is missing: checkpoint/);
});

// Each first-checkpoint pointer, word for word, and the passage holding it, pinned whole so that a sentence added beside
// the pointer is caught: the delivery-base paragraph entire, and the by-hand fallback from "Without Node" to its
// paragraph's end.
const FIRST_CHECKPOINT = [
  { name: 'delivery base', whole: true, pointer: "The first checkpoint, with no committed page in the ledger, takes its sidecar's form from §Sidecar shape below, never from an archived ledger.",
    passage: "Use the newest committed `smoke-*.html` as the delivery base, or this template when starting a page. The first checkpoint, with no committed page in the ledger,"
      + " takes its sidecar's form from §Sidecar shape below, never from an archived ledger. Fill and commit `smoke-<Cn>.html`, then use the current runtime's HTML preview,"
      + " file hand-over, or publisher. Reuse an existing hosted URL when that runtime can update it; otherwise hand over the current committed HTML or use §Fallback."
      + " Record the CURRENT URL, ledger-relative HTML path, or `plain text` in PROGRESS's `**Smoke page**:` line. If delivery moves, retain the previous hosted URL in"
      + ' LOG for future reuse. A link to an older hosted checkpoint is not a current hand-over.' },
  { name: 'by-hand fallback', whole: false, pointer: "At the first checkpoint no page is committed in the ledger yet: patch this template, taking its content's form from §Sidecar shape, never from an archived ledger.",
    passage: "Without Node, or with the sidecar lost, copy the newest committed `smoke-*.html`, patch the slots by hand, and run `grep -o '{{[A-Z_]\\{1,\\}}}'` over the"
      + " result — zero hits; the page never depends on the tool that filled it. At the first checkpoint no page is committed in the ledger yet: patch this template,"
      + " taking its content's form from §Sidecar shape, never from an archived ledger." },
];
// A pointer missing, or its passage not as pinned, and any other sentence of the document that names an archive.
function pointerFaults(text) {
  const paragraphs = text.replace(/\r\n/g, '\n').split(/\n{2,}/).map(p => p.replace(/\s+/g, ' ').trim()), faults = [];
  for (const { name, whole, pointer, passage } of FIRST_CHECKPOINT) {
    const homes = paragraphs.filter(p => p.includes(pointer));
    if (homes.length !== 1) faults.push(`${name}: ${homes.length} paragraph(s) hold the pointer`);
    else if (whole ? homes[0] !== passage : !homes[0].endsWith(' ' + passage)) faults.push(`${name}: the passage is not as pinned`);
  }
  const pointers = FIRST_CHECKPOINT.map(entry => entry.pointer);
  return [...faults, ...paragraphs.flatMap(p => p.split(/(?<=\.)\s+/)).filter(s => /archiv/i.test(s) && !pointers.includes(s)).map(s => 'another sentence names an archive: ' + s)];
}
test('smoke-page.md sends a first checkpoint to §Sidecar shape, never to an archived ledger, from the delivery base and the by-hand fallback', () => {
  const doc = fs.readFileSync(SMOKE_DOC, 'utf8').replace(/\r\n/g, '\n');
  assert.deepEqual(FIRST_CHECKPOINT.filter(entry => !entry.passage.includes(entry.pointer)).map(entry => entry.name), [], 'each passage holds its pointer');
  assert.deepEqual(pointerFaults(doc), []);
  assert.deepEqual(pointerFaults(doc.split('\n').join('\r\n')), [], 'the CRLF twin reads alike');
  // Live controls: each pointer taken out, a sentence added beside it naming no archive, and an archived ledger named in
  // another sentence are each reported.
  const faults = [], beside = ' Or copy the sidecar of the newest completed ledger for its form.';
  for (const { name, pointer } of FIRST_CHECKPOINT) {
    const at = new RegExp(pointer.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').split(' ').join('\\s+'), 'g'), hits = doc.match(at) ?? [];
    if (hits.length !== 1) { faults.push(`${name}: the pointer occurs ${hits.length} times as written`); continue; }
    if (!pointerFaults(doc.replace(at, () => '')).some(f => f.startsWith(name + ': '))) faults.push(`${name}: the pointer taken out is not reported`);
    if (!pointerFaults(doc.replace(at, m => m + beside)).some(f => f === `${name}: the passage is not as pinned`)) faults.push(`${name}: a sentence added beside the pointer is not reported`);
  }
  const planted = pointerFaults(doc + "\nCopy an archived ledger's `smoke-c1.json` for the form.\n");
  if (!planted.some(f => f.endsWith("Copy an archived ledger's `smoke-c1.json` for the form."))) faults.push('a planted archive sentence is not reported: ' + JSON.stringify(planted));
  assert.deepEqual(faults, []);
});

// ===== BL-096: the checkpoint field is the n of C<n> ============================================
// Three ledgers in a row wrote "checkpoint": "C1", and two issued pages read "Checkpoint CC1".
const CHECKPOINT_REFUSAL = /^checkpoint must be a positive integer, the n of C<n> \("checkpoint": 1 for C1\), got /;
test('[BL-096] checkpoint is a positive integer: "C1", "1" and every other form are refused naming the field, a previous sidecar included', () => {
  const faults = [];
  for (const checkpoint of ['C1', '1', 'c1', 0, -1, 1.5, true, null, [1], { n: 1 }]) {
    try { build({ checkpoint }); faults.push(JSON.stringify(checkpoint) + ': built'); }
    catch (e) { if (!CHECKPOINT_REFUSAL.test(e.message) || !e.message.endsWith('got ' + JSON.stringify(checkpoint))) faults.push(JSON.stringify(checkpoint) + ': ' + e.message); }
  }
  assert.deepEqual(faults, []);
  // The boundary's other side: 1 and 2 build, their eyebrow and copy header reading C1 and C2.
  for (const n of [1, 2]) {
    const slots = builder.renderSlots(sidecar({ checkpoint: n, eyebrow: undefined, copyHeader: undefined }));
    assert.ok(slots.EYEBROW.startsWith(`Checkpoint C${n} · `) && slots.COPY_HEADER.startsWith(`C${n} smoke run`), slots.EYEBROW + ' / ' + slots.COPY_HEADER);
  }
  // A re-issue's previous sidecar is held to the same form, so the two checkpoints compare as numbers.
  assert.throws(() => reissue(sidecar(), sidecar({ checkpoint: '1' })), e => CHECKPOINT_REFUSAL.test(e.message));
  assert.doesNotThrow(() => reissue(sidecar(), sidecar()), 'the control: a numbered previous sidecar re-issues');
});

test('[BL-096] smoke-page.md shows the field: the eyebrow row and the example carry "checkpoint": 1, and the example\'s "C1" copy is refused', t => {
  const doc = fs.readFileSync(SMOKE_DOC, 'utf8').replace(/\r\n/g, '\n');
  const rows = doc.split('\n').filter(l => l.startsWith('| `{{EYEBROW}}` |'));
  assert.equal(rows.length, 1, 'one eyebrow row in the slot table');
  assert.ok(rows[0].includes('`"checkpoint": 1` builds `Checkpoint C1`'), 'the row shows the field beside its rendering: ' + rows[0]);
  const { raw } = sidecarSection(doc), example = JSON.parse(raw);
  assert.equal(example.checkpoint, 1);
  // Rendered from the field alone: the example without its own eyebrow and copy header.
  const slots = builder.renderSlots(without(without(example, 'eyebrow'), 'copyHeader'));
  assert.equal(slots.EYEBROW, 'Checkpoint C1 · batches B01–B02');
  assert.ok(slots.COPY_HEADER.startsWith('C1 smoke run — '), slots.COPY_HEADER);
  // As the checkpoint's smoke step runs it: the published example with "C1", through the CLI.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'checkpoint-form-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const line = '  "checkpoint": 1,\n', json = path.join(dir, 'smoke-c1.json'), out = path.join(dir, 'smoke-c1.html');
  assert.equal(raw.split(line).length, 2, 'the example holds the checkpoint line once');
  const faults = [];
  for (const [form, status] of [['"C1"', 1], ['"1"', 1], ['1', 0]]) {
    fs.writeFileSync(json, raw.split(line).join(`  "checkpoint": ${form},\n`));
    fs.rmSync(out, { force: true });
    const r = spawnSync(process.execPath, [BUILDER, json, out], { encoding: 'utf8' });
    const named = status === 1 ? r.stderr.includes('checkpoint must be a positive integer, the n of C<n> ("checkpoint": 1 for C1), got ' + form) : r.stderr === '';
    if (r.status !== status || !named) faults.push(form + ': exit ' + r.status + ' ' + r.stderr);
    if (status === 0 && !fs.readFileSync(out, 'utf8').includes('Checkpoint C1 · batches B01–B02')) faults.push(form + ': the page does not read Checkpoint C1');
  }
  assert.deepEqual(faults, []);
});
