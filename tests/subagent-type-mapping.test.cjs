// Each prompt skeleton names the agent type the orchestrator must spawn it as. A name
// with no definition behind it is not a soft failure: the Agent tool answers
// `Agent type '<name>' not found` and nothing is spawned at all. So the mapping is
// asserted against the definition files that have to back it, and the documented
// fallback is asserted too — it is what a repo without those files runs on.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const ROOT = path.resolve(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const prompts = read('orchestrate/references/subagent-prompts.md');
const protocol = read('orchestrate/references/protocol.md');
// Markdown wraps prose, so "verbatim" is judged on whitespace-collapsed text.
const flow = text => text.replace(/\s+/g, ' ');
const CAVEAT = 'Write and Bash can still write, so "read-only" stays partly conventional; '
  + 'withholding Edit closes the easy path, not every path.';

// Heading → the type its spawn line must name, plus the opening of the prompt block
// that line governs, in document order. Enumerated rather than counted, so a skeleton
// added later cannot inherit the silence. The opening line is pinned because two of
// these sections hold further fenced blocks (the Implementer's polish, fix-round and rework
// prompts, the Reviewer's round-2 block): without it, deleting a skeleton's actual prompt
// body would leave a later block to satisfy every structural check here. RESUMES below
// pins those further blocks, so the whole block set is enumerated.
const SKELETONS = [
  { heading: '## Implementer', type: 'implementer',
    opens: 'You are the IMPLEMENTER for batch B[NN]' },
  { heading: '## Reviewer (the gate — read-only)', type: 'reviewer',
    opens: 'You are the INDEPENDENT REVIEWER for batch B[NN]' },
  { heading: '## Test hunter (optional gate agent — read-only)', type: 'test-hunter',
    opens: 'You hunt tests that cannot fail, for batch B[NN]' },
  { heading: '## QA runner (checkpoint pre-smoke)', type: 'qa-runner',
    opens: 'You are the QA RUNNER for checkpoint C[N]' },
  { heading: '## Artifact proofer (checkpoint post-page)', type: 'qa-runner',
    opens: 'You are the ARTIFACT PROOFER for checkpoint C[N]' },
  { heading: '## Census (scaffold time — read-only)', type: 'census', opens: 'You are a read-only CENSUS agent for ONE planned batch' },
  { heading: '## Plan pre-flight (scaffold time — read-only)', type: 'reviewer',
    opens: 'You are the independent PRE-FLIGHT reviewer of a change plan' },
  { heading: '## Convergence (change-complete — read-only)', type: 'reviewer',
    opens: 'You verify that change [CHANGE_ID]' },
  { heading: '## Fix-up implementer (repair mini-batch)', type: 'implementer',
    opens: 'You are fixing [a smoke-test failure from checkpoint [CN]' },
];
// One form, everywhere: the orchestrator reads these lines under a token budget and a
// second spelling is a line it can skim past.
const SPAWN = /^\*\*Spawn with\*\* `subagent_type: ([a-z-]+)`\.$/;
const spawnLine = type => '**Spawn with** `subagent_type: ' + type + '`.';

// One fence-aware pass. A `## ` line inside a fenced body is body text, not a heading
// — these skeletons carry ledger markdown verbatim (rendered or pasted), so an inserted
// heading is a real possibility. A "prompt block" is a fenced block addressed to the
// agent ("You …"), which is what a spawn line governs; a shell, YAML or output example
// in some future section is not one and must not be dragged into the rule.
function parse(text) {
  const lines = text.split('\n'), blocks = [];
  const fenced = new Array(lines.length).fill(false);
  let open = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('```')) {
      fenced[i] = true;
      if (open === -1) open = i;
      else { blocks.push({ open, first: lines[open + 1] || '' }); open = -1; }
    } else if (open !== -1) fenced[i] = true;
  }
  blocks.forEach(b => { b.info = lines[b.open].slice(3); });
  assert.equal(open, -1, 'unbalanced ``` fence — the parse below would be wrong');
  const pick = predicate => lines.flatMap((line, at) => !fenced[at] && predicate(line) ? [{ line, at }] : []);
  const headings = pick(l => l.startsWith('## '));
  // The half-open line range of one `##` section, by heading text.
  const bounds = heading => {
    const k = headings.findIndex(h => h.line === heading);
    assert.notEqual(k, -1, 'missing heading: ' + heading);
    return [headings[k].at, k + 1 < headings.length ? headings[k + 1].at : lines.length];
  };
  return {
    lines, fenced, headings, bounds,
    // A section's body as text, and its top-level bullets with their continuation
    // lines. Both are cut from the fence-aware line map rather than by splitting raw
    // text on `\n## ` or `\n- `, so a heading or bullet pasted into a fenced body
    // stays body — every reader of this file goes through one of these.
    section: heading => { const [s, e] = bounds(heading); return lines.slice(s + 1, e).join('\n'); },
    bullets: heading => {
      const [s, e] = bounds(heading), found = [];
      for (let i = s + 1; i < e; i++) {
        if (!fenced[i] && lines[i].startsWith('- ')) found.push([lines[i].slice(2)]);
        else if (found.length) found[found.length - 1].push(lines[i]);
      }
      return found.map(b => b.join('\n'));
    },
    spawns: pick(l => SPAWN.test(l)).map(s => ({ ...s, type: SPAWN.exec(s.line)[1] })),
    blocks,
    promptBlocks: blocks.filter(b => /^You /.test(b.first)),
  };
}
const doc = parse(prompts);
const proto = parse(protocol);

test('every skeleton names its agent type above its prompt block', () => {
  for (const { heading, type, opens } of SKELETONS) {
    const [start, end] = doc.bounds(heading);
    const block = doc.promptBlocks.find(b => b.open > start && b.open < end);
    assert.ok(block, heading + ' has no prompt block');
    assert.ok(block.first.startsWith(opens),
      heading + ' must still open its prompt with "' + opens + '" — found: ' + block.first);
    const spawn = doc.spawns.find(s => s.at > start && s.at < block.open);
    assert.ok(spawn,
      heading + ' must carry `' + spawnLine(type) + '` between its heading and its prompt block');
    assert.equal(spawn.type, type, heading + ' names the wrong agent type');
  }
});

test('no prompt block escapes the mapping', () => {
  const owner = block => {
    const heading = [...doc.headings].reverse().find(h => h.at < block.open);
    return heading ? heading.line : '(before the first heading)';
  };
  assert.deepEqual(doc.promptBlocks.map(owner), SKELETONS.map(s => s.heading),
    'a fenced block addressed to a sub-agent is a skeleton and needs a subagent_type line');
});

// The blocks a skeleton section holds after its prompt: resumed or composed, never spawned,
// so they carry no spawn line. Paired with the fence line prompt.mjs renders them by.
const RESUMES = [
  { heading: '## Implementer', opens: 'Your batch reviewed SHIP with ASKs', info: 'prompt:polish' },
  { heading: '## Implementer', opens: 'Your batch reviewed FIX FIRST', info: 'prompt:fix-round' },
  { heading: '## Implementer', opens: 'DO: your batch is already built', info: 'prompt:rework' },
  { heading: '## Reviewer (the gate — read-only)', opens: 'PREVIOUS FINDINGS:', info: 'prompt:round-2' },
];
// Which skeletons prompt.mjs renders (the rest are filled and pasted), by fence line.
const RENDERED = new Map([['## Implementer', 'prompt:implementer'], ['## Reviewer (the gate — read-only)', 'prompt:reviewer'],
  ['## Test hunter (optional gate agent — read-only)', 'prompt:test-hunter']]);

test('the whole block set: every fenced block is a mapped skeleton or a named resume block, in document order', () => {
  const owner = at => { const h = [...doc.headings].reverse().find(x => x.at < at); return h ? h.line : '(before the first heading)'; };
  const expected = [];
  for (const s of SKELETONS) {
    expected.push({ heading: s.heading, opens: s.opens, info: RENDERED.get(s.heading) || '' });
    expected.push(...RESUMES.filter(r => r.heading === s.heading));
  }
  const actual = doc.blocks.map(b => {
    const want = expected.find(e => e.heading === owner(b.open) && b.first.startsWith(e.opens));
    return want ? { heading: want.heading, opens: want.opens, info: b.info } : { heading: owner(b.open), opens: b.first, info: b.info };
  });
  assert.deepEqual(actual, expected, 'a fenced block was added, dropped, reordered or re-fenced');
  assert.equal(expected.length, SKELETONS.length + RESUMES.length);
  // The pasted skeletons carry a bare fence: rendering one would need prompt.mjs to know it.
  assert.deepEqual(doc.blocks.filter(b => b.info).length, RENDERED.size + RESUMES.length);
  // No spawn line governs a resume block: each sits after its section's spawned prompt block.
  for (const r of RESUMES) {
    const block = doc.blocks.find(b => b.first.startsWith(r.opens));
    const [start] = doc.bounds(r.heading);
    const prompt = doc.promptBlocks.find(b => b.open > start);
    assert.ok(prompt.open < block.open, r.opens + ' must follow its section\'s prompt block');
    assert.ok(!doc.spawns.some(s => s.at > prompt.open && s.at < block.open), r.opens + ' is resumed or composed, never spawned');
  }
});

test('the spawn lines are one consistent form, in the mapped order', () => {
  assert.deepEqual(doc.spawns.map(s => s.type), SKELETONS.map(s => s.type),
    'the document order of the spawn lines must be exactly the mapping');
  // Only where the orchestrator reads the instruction — between a skeleton's heading
  // and its prompt block — must there be no second spelling of it. Prose elsewhere in
  // the file may discuss the field however it likes.
  for (const { heading } of SKELETONS) {
    const [start] = doc.bounds(heading);
    const block = doc.promptBlocks.find(b => b.open > start);
    for (let i = start + 1; i < block.open; i++) {
      if (!doc.fenced[i] && doc.lines[i].includes('subagent_type:')) {
        assert.match(doc.lines[i], SPAWN, heading + ' carries a second spelling: ' + doc.lines[i]);
      }
    }
  }
});

test('every named type resolves to a shipped definition', () => {
  // The assertion this whole change exists for. Strict: a named type with no definition
  // is a spawn that errors, so this is never softened to a skip or a conditional.
  const named = new Set(doc.spawns.map(s => s.type));
  assert.deepEqual([...named].sort(), ['census', 'implementer', 'qa-runner', 'reviewer', 'test-hunter']);
  for (const type of named) {
    const file = '.claude/agents/' + type + '.md';
    assert.ok(fs.existsSync(path.join(ROOT, file)),
      'a skeleton spawns `' + type + '` but ' + file + ' does not exist — that spawn errors');
  }
});

test('§Spawning rules binds the orchestrator to the named type', () => {
  // Selected on both marks the rule carries, so that a future bullet mentioning the
  // field in passing is not mistaken for a second copy of this rule.
  const bullets = doc.bullets('## Spawning rules (orchestrator)')
    .filter(b => b.includes('subagent_type') && /wildcard/i.test(b));
  assert.equal(bullets.length, 1, '§Spawning rules needs exactly one rule about the agent type');
  const bullet = flow(bullets[0]);
  assert.match(bullet, /wildcard/i, 'the rule must forbid a wildcard-tool agent in a read-only role');
  assert.match(bullet, /read-only/, 'the rule must say which roles it protects');
  assert.ok(bullet.includes(CAVEAT), '§Spawning rules must carry the Bash caveat verbatim');
  assert.match(bullet, /Degraded environments/,
    'a reader with no definitions installed must be pointed at the fallback');
});

test('§Degraded environments documents the undefined-agent-types fallback', () => {
  const bullets = proto.bullets('## Degraded environments')
    .filter(b => b.includes('subagent_type') && b.includes('general-purpose'));
  assert.equal(bullets.length, 1, '§Degraded environments needs exactly one undefined-types bullet');
  const bullet = flow(bullets[0]);
  assert.match(bullet, /general-purpose/, 'the bullet must name the substitute');
  assert.match(bullet, /ORCHESTRATOR|orchestrator/,
    'substituting is the orchestrator\'s own job — the spawn errors, it does not fall back by itself');
  assert.match(bullet, /read-only/, 'the prose read-only rules are the only enforcement left');
  assert.match(bullet, /forfeit/i, 'the per-spawn token saving is forfeited until the install');
  // The install must be an action the reader can perform from wherever they are. A
  // filename is not one: this bullet is read by an orchestrator driving a ledger in
  // some other repo, where a bare `README.md` resolves either to a sibling of this
  // file that does not exist or to a project README that says nothing about agents.
  assert.match(bullet, /\.claude\/agents/, 'the bullet must say what to install and where');
  assert.match(bullet, /restart/i, 'and that Claude Code must be restarted before they load');
  assert.doesNotMatch(bullet, /README\.md/,
    'no bare README.md pointer, backticked or not — it dangles for every reader outside the skill repo');
});

// Without the definitions these lines are the ONLY thing holding a read-only role
// to read-only, so the capability boundary never licenses deleting them. The two gate lines
// name the Write tool the user granted (2026-09-23) only as their OUTPUT carve-out scopes it,
// so the rule and the grant a few lines below it no longer contradict each other. The map's
// keys are bound to the document: every heading that calls its skeleton read-only.
const PROSE = new Map([
  ['## Reviewer (the gate — read-only)',
    'You did not write this code. Use only Read/Grep/Glob and read-only git (diff, log, show, status), '
      + 'and the `Write` tool only for what OUTPUT below names. You never edit a file.'],
  ['## Test hunter (optional gate agent — read-only)',
    'Use only Read/Grep/Glob and read-only git, and the `Write` tool only for what OUTPUT below names; edit nothing.'],
  ['## Census (scaffold time — read-only)',
    'Use only Read/Grep/Glob, read-only git and read-only commands; edit nothing, and write only disposable scratch under your session scratchpad.'],
  ['## Plan pre-flight (scaffold time — read-only)',
    'Use only Read/Grep/Glob; edit nothing.'],
  ['## Convergence (change-complete — read-only)',
    'converged with its plan. Read-only.'],
]);
// The headings, read outside any fence, that call their skeleton read-only: the domain PROSE covers.
const readOnlyHeadings = parsed => parsed.headings.map(h => h.line).filter(line => /read-only/i.test(line));

test('the prose read-only rules survive in every read-only skeleton', () => {
  assert.deepEqual([...PROSE.keys()].sort(), readOnlyHeadings(doc).sort(),
    'every heading that calls its skeleton read-only needs its prose rule in PROSE, and PROSE names no other');
  // Live control: a read-only heading planted in the document is one PROSE does not cover.
  const planted = '## Planted (scaffold time — read-only)';
  assert.deepEqual(readOnlyHeadings(parse(prompts + '\n' + planted + '\n')).filter(h => !PROSE.has(h)), [planted],
    'the domain must be read from the document\'s headings');
  for (const [heading, rule] of PROSE) {
    assert.ok(flow(doc.section(heading)).includes(rule),
      heading + ' lost its prose read-only rule: ' + rule);
  }
});

// BL-023: `smoke-page.md` defined a pass that proofs the BUILT page and no skeleton
// invoked it, so it only ever ran when someone remembered. Wiring it in had one hard
// constraint: the QA runner is pre-page by construction ("a FAIL becomes a repair
// mini-batch before the page is issued") and the pass's own definition changes nothing
// about when the runner runs — so it had to become a SECOND skeleton rather than extra
// duties bolted onto the first. These two tests are what stops a later edit from
// collapsing them back together or flipping either one's timing.
const PRE_SMOKE = '## QA runner (checkpoint pre-smoke)';
const POST_PAGE = '## Artifact proofer (checkpoint post-page)';
// Directives that would undo the split, in whichever section they landed. Held as one
// list and armed below, so neither sweep's silence is a canary that could never sing.
const REVERSALS = [
  { name: 'the proofing pass made optional', pattern: /\b(?:optional|skippable|may be (?:skipped|omitted)|can be skipped|need not run)\b/i },
  { name: 'the pre-smoke moved after the page', pattern: /\bpre-smoke\b[^.;]*\bafter the page\b/i },
  { name: 'one pass standing in for the other', pattern: /\b(?:replaces|instead of|in place of)\b[^.;]*\b(?:pre-smoke|proofing pass|QA runner|artifact proofer)\b/i },
];
// The two sections are short and wholly about their own skeleton, so every clause in them
// is in scope. The `[\s*]+` boundary is the one protocol-contract.test.cjs uses: a
// sentence closed by markdown emphasis must still end a clause.
const reversals = text => text.split(/(?<=[.;])[\s*]+/).flatMap(clause =>
  REVERSALS.filter(({ pattern }) => pattern.test(clause)).map(({ name }) => name + ' :: ' + clause.trim()));
// The same families over the WHOLE document. Bound to clauses about the pass, because
// `optional` is a legitimate word elsewhere here — two headings carry it — and an unbound
// document sweep would cry wolf on both. This is the half that catches a sentence
// appended outside either section; neither this file's sections nor the carrier sweep in
// protocol-contract.test.cjs would see one, since subagent-prompts.md states no close-out.
const ABOUT_PASS = /proofs? the published artifact|proofing pass|artifact proofer/i;
const reversalsAboutPass = text => text.split(/(?<=[.;])[\s*]+/)
  .filter(clause => ABOUT_PASS.test(clause))
  .flatMap(clause => REVERSALS.filter(({ pattern }) => pattern.test(clause)).map(({ name }) => name + ' :: ' + clause.trim()));

test('the reversal sweep over the checkpoint skeletons is armed by an independent corpus', () => {
  // Sentences an author would actually write to undo the split, not spellings read off the
  // alternations. Its predecessor was one control per pattern, derived FROM the patterns:
  // narrowing the first family to bare `optional` lost four spellings while the family
  // size, the triggered-name set and every control stayed identical.
  const UNDOINGS = ['The artifact proofer is optional when the pre-smoke is green.',
    'The proofing pass is skippable on a re-issue.',
    'The proofing pass may be skipped when nothing changed.',
    'The proofing pass may be omitted for a text-only script.',
    'The proofing pass can be skipped once the runner passes.',
    'The proofing pass need not run when the page is unchanged.',
    'The pre-smoke now runs after the page is built.',
    'The pre-smoke happens after the page exists.',
    'The artifact proofer replaces the QA runner.',
    'Spawn the artifact proofer instead of the pre-smoke.',
    'The artifact proofer runs in place of the QA runner.'];
  assert.equal(UNDOINGS.length, 11, 'the undoing corpus must keep all eleven spellings');
  assert.equal(new Set(UNDOINGS).size, 11, 'the corpus must not repeat a spelling to pad its size');
  const names = text => [...new Set(reversals(text).map(hit => hit.split(' :: ')[0]))].sort();
  for (const undoing of UNDOINGS) {
    assert.ok(reversals(undoing).length > 0, 'the sweep no longer catches: "' + undoing + '"');
  }
  // Subject is the DOMAIN: the corpus exercises every family and may name none the list
  // has lost, so neither can move without the other.
  assert.deepEqual([...new Set(UNDOINGS.flatMap(names))].sort(), REVERSALS.map(entry => entry.name).slice().sort(),
    'every reversal family must be exercised by the corpus, and the corpus may name none it has dropped');
  // …and set equality alone protects only n-1 of n, because deleting a family removes its
  // name from BOTH sides at once. Each family must own an entry NO other family flags.
  for (const { name } of REVERSALS) {
    assert.ok(UNDOINGS.some(undoing => { const hit = names(undoing); return hit.length === 1 && hit[0] === name; }),
      name + ': no corpus entry is caught by this family ALONE, so deleting it balances the set equality above');
  }
  // The document sweep's clause filter armed separately: it must let a real undoing
  // through, and must not select the headings that make an unbound sweep cry wolf.
  assert.deepEqual(reversalsAboutPass('The artifact proofer is optional when the pre-smoke is green.')
    .map(hit => hit.split(' :: ')[0]), ['the proofing pass made optional'],
  'the document sweep filters out the very sentence it exists to catch');
  assert.deepEqual(reversalsAboutPass('## Test hunter (optional gate agent — read-only)'), [],
    'the document sweep flags a heading that merely contains the word, and a sweep that cries wolf gets deleted');
});

test('no sentence anywhere in the document undoes the post-page pass', () => {
  assert.deepEqual(reversalsAboutPass(flow(prompts)), [],
    'a clause about the proofing pass, outside either skeleton, undoes it');
});

test('the pre-smoke skeleton keeps its pre-page timing and takes on no post-page duty', () => {
  const section = flow(doc.section(PRE_SMOKE)), postPage = flow(doc.section(POST_PAGE));
  assert.ok(section.includes('A FAIL becomes a repair mini-batch before the page is issued'),
    PRE_SMOKE + ' must still place its repair loop BEFORE the page is issued');
  // Appending the post-page duty HERE is the edit the timing constraint forbids: the
  // runner proves the steps, the proofer proves the bytes the reader receives, and one
  // block doing both contradicts both smoke-page.md and the line pinned above.
  for (const duty of [/published artifact/i, /textContent/, /after the page is (?:built|generated)/i]) {
    // Armed against the section that MUST carry the duty before it is denied of the one
    // that must not. A typo — `/publshed artifact/i` — leaves a `doesNotMatch` silent
    // forever, and a silent one is indistinguishable from a clean document.
    assert.match(postPage, duty,
      'this post-page duty pattern matches nothing even in "' + POST_PAGE + '", so denying it below proves nothing: ' + duty);
    assert.doesNotMatch(section, duty,
      PRE_SMOKE + ' has acquired a post-page duty — that belongs in "' + POST_PAGE + '"');
  }
  assert.deepEqual(reversals(section), [], PRE_SMOKE + ' carries a directive that undoes the split');
});

test('the post-page skeleton actually invokes the proofing pass', () => {
  const section = flow(doc.section(POST_PAGE));
  // Instructs the pass rather than mentioning it: the page as the source of the bytes,
  // and the bytes run as they are.
  for (const clause of ['proof the published artifact',
    "read every `<pre><code>` block's `textContent`", 'run exactly those bytes',
    'after the page is built and before the STOP']) {
    assert.ok(section.includes(clause), POST_PAGE + ' must instruct the pass, not merely name it: ' + clause);
  }
  // Both halves say it re-times nothing, so deleting either the prompt's sentence or the
  // prose one leaves the other to redden.
  assert.ok(section.includes("nothing about the pre-smoke's timing changes"),
    POST_PAGE + "'s prompt must tell the agent it re-times nothing");
  assert.ok(section.includes('leaves the pre-smoke above exactly where it is'),
    POST_PAGE + "'s prose must say the same to the orchestrator reading it");
  assert.deepEqual(reversals(section), [], POST_PAGE + ' carries a directive that undoes the pass it invokes');
});
