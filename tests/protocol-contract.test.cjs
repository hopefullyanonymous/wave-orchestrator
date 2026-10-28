const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const ROOT = path.resolve(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const protocol = read('orchestrate/references/protocol.md');
const contract = read('orchestrate/templates/00-READBEFORE.md');
// Consumer tests use isolated disposable repositories and actual CLI invocations;
// they do not import the upstream evidence or fence implementation.
function makeRepo(t) {
  const temp = fs.realpathSync(os.tmpdir()), root = fs.mkdtempSync(path.join(temp, 'protocol-docs-git-'));
  t.after(() => { assert.equal(path.dirname(fs.realpathSync(root)), temp); fs.rmSync(root, { recursive: true, maxRetries: 8, retryDelay: 100 }); });
  const empty = path.join(root, 'empty'); fs.writeFileSync(empty, '');
  const hooks = path.join(root, 'hooks'), template = path.join(root, 'template'); fs.mkdirSync(hooks); fs.mkdirSync(template);
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key))),
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: empty, GIT_TERMINAL_PROMPT: '0' };
  const config = ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgSign=false',
    '-c', 'core.autocrlf=false', '-c', 'core.hooksPath=' + hooks, '-c', 'protocol.allow=never', '-c', 'protocol.file.allow=always'];
  function at(cwd) {
    const git = (...args) => {
      const r = spawnSync('git', [...config, ...args], { cwd, env, encoding: 'utf8', windowsHide: true, timeout: 15000 });
      assert.ifError(r.error); assert.equal(r.status, 0, r.stderr); return r.stdout.trim();
    };
    const write = (file, bytes) => { const p = path.join(cwd, file); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, bytes); };
    const commit = message => { git('add', '--all'); git('commit', '--allow-empty', '-m', message); return git('rev-parse', 'HEAD'); };
    function snapshot() {
      const files = {};
      const walk = dir => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name === '.git') continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p); else files[path.relative(cwd, p)] = fs.readFileSync(p).toString('base64');
      } };
      walk(cwd);
      const gitDir = path.resolve(cwd, git('rev-parse', '--git-dir'));
      return { files, refs: git('for-each-ref', '--format=%(refname) %(objectname) %(symref)'),
        head: fs.readFileSync(path.join(gitDir, 'HEAD')).toString('base64'),
        index: fs.readFileSync(path.join(gitDir, 'index')).toString('base64') };
    }
    return { cwd, git, write, commit, snapshot };
  }
  const cwd = path.join(root, 'repo'); fs.mkdirSync(cwd);
  const repo = at(cwd); repo.git('init', '--initial-branch=main', '--template=' + template);
  const base = repo.commit('base');
  const remote = () => {
    const location = path.join(root, 'origin.git'); fs.mkdirSync(location);
    const bare = at(location); bare.git('init', '--bare', '--initial-branch=main', '--template=' + template);
    repo.git('remote', 'add', 'origin', location); repo.git('push', 'origin', base + ':refs/heads/main'); return bare;
  };
  return { ...repo, root, env, base, at, remote };
}
const normalize = text => text.replace(/`/g, '').replace(/\{\{INTEGRATION_BRANCH\}\}/g, 'the integration branch')
  .replace(/\{\{BACKLOG_FILE\}\}/g, 'backlog').replace(/\s+/g, ' ').trim();
function table(text, start) {
  const i = text.indexOf(start); assert.notEqual(i, -1);
  const rows = [];
  for (const line of text.slice(i).split('\n')) { if (!/^\s*\|/.test(line)) break; rows.push(line); }
  return rows.join('\n');
}

// The contract template used to mirror these tables and the shipment passage, and a test
// held the two copies equal. The copy is retired (B01 of OS-20260925): the procedure lives
// once, in protocol.md, and each former mirror assertion is replaced by one on that home.
const SHIPMENT_PASSAGE = "Resolve the integration branch's full local ref to `<integration-sha>`. Resolve `<shipment-sha>` from the recorded source: "
  + '- `local`: `git rev-parse --verify <shipment-ref>^{commit}`. This needs no remote; an unpushed local merge counts under this policy. '
  + '- `remote <name>`: read `git ls-remote --exit-code <name> <shipment-ref>` now and take the SHA of the exact matching ref. Verify that object '
  + 'exists locally as a commit before testing ancestry. A cached `refs/remotes/...` value alone does not establish current upstream state. '
  + 'A failed query, missing ref or missing object leaves shipment unknown; do not fetch or update remote metadata automatically. '
  + 'Use these captured SHAs for the shipment test; exit 0 means contained, 1 means not contained, any other error means unknown. Different '
  + 'local/remote tips do not matter when the recorded source is clear. Unknown shipment never flips rows or authorizes cleanup. Target '
  + 'ambiguity blocks actions depending on that target; independent read-only discovery/status may continue. Record the source, ref and SHAs '
  + 'with an inferred shipment. Existing merge/push permissions still apply.';
test('Recovery and capped-verdict tables live once, in protocol.md, under their approved pins', () => {
  // These are the approved starting decision tables, not regenerated expectations. The
  // placeholder substitutions in `normalize` are no-ops on protocol.md, kept so the hashed
  // input is exactly what it has always been.
  const expected = {
    '| Ledger says | Git shows | Verdict |': 'c3f5e598e853e6f3d3f0f5a7b98c10dd82e7d8e63b9ec47914c64c828323b4b1',
    '| Subject | fix again | ship with the residual | drop |': '326ff764e5a7821d148ab18e38b9aed33a4c0fd36baebe5463da02c83adb7346'
  };
  for (const [heading, hash] of Object.entries(expected)) assert.equal(createHash('sha256').update(normalize(table(protocol, heading))).digest('hex'), hash);
  // One copy: protocol.md states each table once, and the template carries none of either.
  for (const heading of Object.keys(expected)) {
    assert.equal(protocol.split(heading).length - 1, 1, 'protocol.md must carry exactly one copy of ' + heading);
    assert.ok(!contract.includes(heading), 'the contract template must carry no copy of ' + heading + ' — protocol.md is its only home');
  }
  // The shipment passage the template mirrored, pinned in its one home: its wording IS the
  // captured-source semantics, so any edit to it is deliberate and visible here.
  const shipment = text => text.slice(text.indexOf("Resolve the integration branch's full local ref"), text.indexOf('For each PROGRESS row'))
    .replace(/\s+/g, ' ').trim();
  assert.equal(shipment(protocol), SHIPMENT_PASSAGE, 'protocol.md: the captured-source shipment semantics changed');
  assert.ok(!contract.includes("Resolve the integration branch's full local ref"), 'the contract template must not copy the shipment passage back');
});

// ===== B01: the template's copy of the procedure retired, nothing lost =============
// The domain is the template AS IT STOOD before the slimming — a permanent historical blob,
// read like BATCH_BASE below — never a hand-written list of what moved. Every sentence, list
// item, table row and fenced line of it must still be carried: by the slimmed template, by
// protocol.md verbatim (the template's placeholders read as protocol.md's generic spellings),
// or — where protocol.md already stated the same rule in its own words — by the protocol.md
// passage REWORDED names. RETIRED holds the statements superseded — two by the move itself, two
// by B04's one-strike polish rule — each with the successor that must exist. Content, not absence: a sentence dropped from both
// files is reported by name, and so is a map entry that no longer maps anything.
// FOR A LATER BATCH EDITING protocol.md: this freezes the wording of every moved sentence.
// Inserting a sentence beside one needs nothing here. Rewording one reddens this test until
// its new wording is named in REWORDED — so a batch that must reword a moved sentence needs
// this file in its fence; one that cannot have it inserts instead.
const SLIM_BASE = 'edd2f1e';
const GENERIC = {
  INTEGRATION_BRANCH: ['the integration branch', '<integration>', '<integration-branch>'],
  BACKLOG_FILE: ['the backlog file', 'backlog'],
  LEDGER_DIR: ['<ledger-dir>'], SKILL_DIR: ['<skill-dir>'],
  WORKTREE_SETUP: ["the ledger's per-worktree setup"],
  GUARDRAILS_REF: ['the project guardrails doc'],
  SHIPMENT_REF: ['<shipment-ref>'],
  EVIDENCE_TOOL: ['"<skill-dir>/tools/git-evidence.mjs"'], FENCE_TOOL: ['"<skill-dir>/tools/check-fence.mjs"'],
};
// Links read as their text, emphasis and code ticks dropped, "protocol.md §X" read as "§X":
// a kept sentence whose pointer now names protocol.md is the same sentence.
const flat = text => text.replace(/\[([^\]\n]+)\]\([^)\s]+\)/g, '$1').replace(/[`*]/g, '').replace(/protocol\.md §/g, '§')
  .replace(/\s+/g, ' ').trim();
const unitOf = text => flat(text).replace(/^(?:- |\d+\. )/, '').replace(/[.;:,]$/, '').trim();
// Sentences split at `.`/`;` outside code spans; a list item, a bold field line, a table
// row and a fenced line each start their own unit; headings are structure, not content.
function contractUnits(text) {
  const out = [];
  let fenced = false, paragraph = [];
  const flush = () => {
    if (!paragraph.length) return;
    let current = '';
    for (const token of paragraph.join('\n').split(/(`[^`\n]*`)/)) {
      if (token.startsWith('`')) { current += token; continue; }
      const parts = token.split(/(?<=[.;])\s+/);
      current += parts.shift();
      for (const part of parts) { out.push(current); current = part; }
    }
    out.push(current);
    paragraph = [];
  };
  for (const line of text.split('\n')) {
    if (line.startsWith('```')) { flush(); fenced = !fenced; continue; }
    if (fenced || /^\s*\|/.test(line)) { flush(); out.push(line); continue; }
    if (/^#{1,6} /.test(line) || !line.trim()) { flush(); continue; }
    if (/^\s*(?:[-*]|\d+\.) /.test(line) || line.startsWith('**')) flush();
    paragraph.push(line);
  }
  flush();
  return out.map(unitOf).filter(Boolean);
}
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const genericPattern = unit => new RegExp(unit.split(/(\{\{[A-Z0-9_]+\}\})/).map(part => {
  const m = /^\{\{([A-Z0-9_]+)\}\}$/.exec(part);
  return !m ? escapeRe(part) : GENERIC[m[1]] ? '(?:' + GENERIC[m[1]].map(escapeRe).join('|') + ')' : '(?!)';
}).join(''));
// [the lost unit's opening, where its content now lives, the excerpt(s) that carry it].
const REWORDED = [
  ['Everything needed to drive this change lives in this ledger directory', 'template',
    ['Everything needed to drive this change lives in this ledger directory ({{LEDGER_DIR}}) and that pinned directory — assume no other context survives between sessions']],
  ['Reconcile (§Recovery below)', 'template', ['Reconcile (§Recovery) before believing any PROGRESS row']],
  // The integration and batch worktrees moved from the session scratchpad to {{WORKTREE_ROOT}} (B03 of
  // OS-20261022), so each sentence that placed them is carried in its new words.
  ['Never switch the main checkout. Read ledger files', 'template',
    ['Never switch the main checkout. Read ledger files from any branch with git show <branch>:./<path> (the ./ is required — Git Bash on Windows mangles branch:path otherwise) and write to the ledger through an integration worktree (git worktree add "{{WORKTREE_ROOT}}/int" {{INTEGRATION_BRANCH}}), using the main checkout only if it already has {{INTEGRATION_BRANCH}} checked out']],
  ['Wave members run CONCURRENTLY', 'template',
    ['Wave members run CONCURRENTLY: one implementer per batch, each in an isolated git worktree under {{WORKTREE_ROOT}} as b<nn> (never inside the repo)']],
  ['Verdict on line 1: SHIP (no P0/P1', 'protocol', ['Line-1 verdict: SHIP (no P0/P1; may carry ASKs)']],
  ['may carry ASKs) · FIX FIRST', 'protocol',
    ['FIX FIRST (P0 or P1 with a concrete failure scenario) / NEEDS A CLOSER LOOK (names what would confirm it); line 2 NONCE <nonce>']],
  ['Finding classes: P0', 'protocol', ['P0 — wrong behavior / violated criterion or guardrail, concrete scenario. Blocking']],
  ['P1 — should fix', 'protocol', ['P1 — should fix, concrete scenario, needs a production change. Blocking']],
  ['ASK — in-fence', 'protocol',
    ["ASK — in-fence, about the batch's OWN artifacts (its new tests' strength, smoke-step prose, comments, a doc sweep it owns), no production behavior change. Rides under SHIP as a list"]],
  ['closes as a polish pass)', 'protocol', ['Rides under SHIP as a list. Polish pass:']],
  ['Intermediate checkpoints exist only', 'protocol', ['one after each wave carrying a hands-on batch']],
  ['the final checkpoint is mandatory', 'protocol', ['plus one mandatory final checkpoint covering everything since the last']],
  ['Use the newest committed smoke-.html in this ledger', 'protocol',
    ["Use the newest committed smoke-.html in the ledger as the page's format and delivery base (or the session's own template), update it for this checkpoint, and commit it as smoke-<Cn>.html"]],
  ['Include the gate essentials in text', 'protocol', ['Include the step-0 build-identity gate essentials in text with every page hand-over']],
  ['If a page was prepared', 'protocol', ["Keep a prepared page's committed audit copy even when delivering text"]],
  ['Use the locked default and shipment fields above', 'protocol',
    ["Use the ledger's recorded default and shipment target, never the current branch, init.defaultBranch, or a guessed main/master"]],
  ['Missing, contradictory or renamed targets are AMBIGUOUS', 'protocol',
    ['Missing, contradictory or renamed targets require a recorded correction, never silent substitution or contract rewriting']],
  ['git rev-parse --verify <branch> # exists?', 'protocol', ['branch exists? (git rev-parse --verify)']],
  ['git merge-base --is-ancestor <branch> {{INTEGRATION_BRANCH}}', 'protocol', ['integrated? (git merge-base --is-ancestor <branch> <integration>)']],
  ['git merge-base --is-ancestor <integration-sha> <shipment-sha>', 'protocol',
    ['shipped? (git merge-base --is-ancestor <integration-sha> <shipment-sha> only after source resolution above)']],
  ['git log {{INTEGRATION_BRANCH}}..<branch> --oneline', 'protocol', ['commits ahead (git log <integration>..<branch> --oneline)']],
  ['git worktree list && git status --porcelain', 'protocol',
    ["dirty trees (git status --porcelain in each worktree from git worktree list that holds the row's branch — the main checkout only when it holds that branch)"]],
  ['git show <branch>:./{{LEDGER_DIR}}/02-batches-NN-<slug>.md', 'protocol',
    ['the checklist state inside the batch file on that branch (git show <branch>:./<path>, from the root)']],
  ['Log every reconciliation in the PROGRESS Session log (one line)', 'protocol',
    ['Log every reconciliation: one line in the PROGRESS Session log, detail in LOG.md']],
  ['Boot + reconcile + resume-time validation (above)', 'protocol',
    ['Boot + reconcile + resume-time validation (validation commands on the integration tip; red → step 2 first)']],
  // The next two carry their WHOLE unit, head included: the trial merge and the nonce-free
  // pasted prompt exist only in these sentences, and a tail-only excerpt left both unguarded.
  ['a conflict → STOP AND INVESTIGATE, as in the integration procedure), then git commit-tree', 'protocol',
    ["a conflict → STOP AND INVESTIGATE, as in the integration procedure), then git commit-tree <tree> -p <tip> -m trial, check that commit out in a temporary worktree (git worktree add <scratchpad>/wt-trial <commit>; a stale wt-trial from a crashed trial is removed first), run the ledger's per-worktree setup there (skip only if n/a)"]],
  ['When the renderer is unavailable or refuses (UNKNOWN …)', 'protocol',
    ['When the renderer is unavailable or refuses (UNKNOWN …), the manual procedure is a pasted prompt with no nonce line, and every such prompt must be SELF-CONTAINED: the spec text + codebase facts from the batch file, the exact file fence, acceptance criteria, the applicable guardrails, the validation commands (the wrapper command and its recipe), the contract\'s conventions + prohibitions blocks, the report shape, and "tick your checklist items in the batch file as you complete them']],
  ['SHIP with ASKs → polish pass', 'protocol',
    ['Polish pass: resume the same implementer (a fresh one when the render prints FRESH — subagent-prompts.md §Spawning rules) with the pointer to its rendered polish prompt (the findings file by path)']],
  ['it appends - [ ] polish: <ask> items', 'protocol', ['it appends - [ ] polish: items to its checklist, does them, commits']],
  ['closes mechanically (6a + validations', 'protocol', ['closes mechanically (fence check + validations']],
  ['polish commits touch only test/doc/prose paths — a production file touched → a fix-diff-only', 'protocol',
    ['polish commits touch only test/doc/prose paths — a production file touched → fix-diff-only re-review by a fresh reviewer)']],
  ['an R-line after the SHIP … asks= line is polish-phase and never counts toward the cap — nor', 'protocol',
    ['an R-line after the SHIP … asks= line is polish-phase and never counts toward the cap). SHIP → the close completes',
      'nor does a FIX FIRST a scoped re-review returns: its bound is the polish-discard rule above, not the cap']],
  ['it is the recorded authorization), then ONE revert commit', 'protocol',
    ['then ONE revert commit spanning @<sha>..HEAD (never a reset — no history rewriting']],
  ['polish never turns a batch ⛔', 'protocol', ['Polish never turns a batch ⛔']],
  ['FIX FIRST → resume the SAME implementer', 'protocol',
    ['resume the SAME implementer with the pointer to its rendered fix-round prompt (the findings file by path, after the LOG append — §Session algorithm step 6); a fresh re-review verifies the fixes and scans only the fix diff']],
  ['the SECOND FIX FIRST sets ⛔ defective', 'protocol',
    ['The SECOND FIX FIRST: ⛔ defective (finding open, not green) or ⛔ green, residual finding open (<severity>)',
      "Both stay out of integration; once the wave's other members are gated and integrated the session stops instead of opening the next wave, quotes the open finding WITH its failure scenario, and names three verdicts for the user: fix again / ship with the residual / drop"]],
  // The old step 8 told the proofer to read each block's text out of the page file; the
  // rendered-DOM rule lives in smoke-page.md, which the carrying passage points at.
  ['If the checkpoint table places a checkpoint here: per-checkpoint close-out', 'protocol',
    ["If the checkpoint table places a checkpoint here: per-checkpoint close-out (a ⛔ member's steps are omitted from the page and appended on re-issue if it later ships)",
      'then proof the published artifact (§Two distinct close-outs)',
      "proof the published artifact per smoke-page.md — after the page is built and before the STOP, every embedded command run out of the built page's own bytes"]],
  ['a command re-authored on its way into the page is unverified', 'protocol',
    ['a command re-authored on its way into the page is unverified, and the pre-smoke that ran before the page existed does not cover it',
      "commit → STOP, delivering the checkpoint's COMBINED smoke script per §Smoke checkpoints"]],
  ['Known design gates belong at the FRONT of the plan', 'protocol',
    ['User gates are front-loaded: design/UX approvals the plan can foresee are resolved at planning time']],
  ['a partially done fold-in is edited in place there with a pointer to this ledger', 'protocol',
    ['a partially done fold-in is edited in place there with a pointer to the ledger']],
  ['Distill: any NEW bug class', 'protocol',
    ['any NEW bug class this change uncovered → ONE-LINE guardrail bullet in the project guardrails doc naming the class and pointing at the test or mechanism doc that enforces it (prefer adding the test in this close-out)']],
  ['propose deleting the merged branches and moving this ledger', 'protocol',
    ['propose deleting the merged branches and moving the ledger to .agents/archive/ (git mv)']],
  // The implementer's report moved to a file and its final message to four lines (B04 of OS-20261024): the
  // bullet's shape sentence and its evidence block's SHAs are carried by the shape protocol.md §Roles, gates, tiers
  // states, and its checklist count and cap by the template's four-line final message and its full-report sentence.
  ['Reports in the fixed shape: first line', 'protocol',
    ["in the fixed shape: its heading ### B<NN> R<k> <role> findings; the status, one of DONE | DONE_WITH_CONCERNS | NEEDS_FENCE | BLOCKED; NONCE <nonce> (the nonce its rendered prompt ends with); an evidence block (each validation run's validate.mjs line and exit code; SHAs; checklist n/m); ≤40 lines of prose"]],
  ['commit SHAs', 'protocol', ["an evidence block (each validation run's validate.mjs line and exit code; SHAs; checklist n/m)"]],
  ['checklist n/m), then ≤40 lines of prose', 'template',
    ["the final message is four lines: the status (DONE | DONE_WITH_CONCERNS | NEEDS_FENCE | BLOCKED), NONCE <nonce> (the nonce its rendered prompt ends with), checklist <n>/<m>, the file's path",
      'Its full report goes to the file its rendered prompt names, in the fixed shape of protocol.md §Roles, gates, tiers, ≤40 lines of prose']],
  // The backlog became the to-do list (B04 of OS-20261024): an item registers only past the bar, each with its id.
  ['residuals added get ids in the', 'template',
    ["{{BACKLOG_FILE}} is the to-do list, an item registering there only past the bar of the pinned skill's references/backlog.md, with ids in the {{BACKLOG_ID_PREFIX}} scheme"]],
];
// [the superseded unit's opening, why, where its successor lives, the successor].
const RETIRED = [
  ["continue only on the user's explicit words, recorded verbatim in the session log — an upgrade",
    'the mismatch branch is upgrade or restore now; the manual procedures it fell back on live in the pinned directory',
    'template', ['a restore (the pinned directory rebuilt byte-for-byte from the Skill source line above, then this pin check re-run, continuing only on SKILL MATCH)']],
  ['At scaffold time bake the resolved helper paths into this contract',
    'the helpers run from the pinned directory, never from a baked path',
    'protocol', ['<skill-dir> is the contract\'s pinned skill directory', 'node "<skill-dir>/tools/git-evidence.mjs" discovery --repo <repo>']],
  // One strike (B04 of OS-20260925): a polish-phase FIX FIRST no longer resumes the implementer
  // for a second scoped re-review; the first one discards the polish.
  ['its FIX FIRST → resume the implementer to revert',
    'one strike: a polish-phase FIX FIRST discards the polish instead of sending the implementer back',
    'protocol', ['One strike: a polish-phase FIX FIRST discards the polish at once (an ASK never licenses a production behavior change)']],
  ['a SECOND polish-phase FIX FIRST discards the polish — write',
    'one strike: the first polish-phase FIX FIRST discards, not the second',
    'protocol', ["write polish discarded: @<sha> (the pre-polish SHIP tip) into the row's Notes first — the marker §Recovery keys on, and the recorded authorization"]],
];
function lostUnits(base, carriers) {
  const T = flat(carriers.template), P = flat(carriers.protocol);
  return contractUnits(base).filter(unit => !T.includes(unit) && !genericPattern(unit).test(P));
}
test('every sentence the slimmed template dropped is carried by protocol.md', { skip: 'needs history and ledger records that are not in this copy' }, () => {
  const blob = spawnSync('git', ['-C', ROOT, 'show', SLIM_BASE + ':orchestrate/templates/00-READBEFORE.md'], { encoding: 'utf8', windowsHide: true });
  assert.ifError(blob.error); assert.equal(blob.status, 0, 'the pre-slimming template at ' + SLIM_BASE + ' must be readable: ' + blob.stderr);
  const base = blob.stdout.replace(/\r\n/g, '\n');
  // The sections note 3 moved: in the base, gone from the template, present in protocol.md.
  const MOVED = ['### Read-only evidence tools', '### §Fence changes', '### Complete checkpoint inputs', '## §Recovery', '## §Session algorithm',
    '**Manual read-only fallback.**', '**Verdict intake.**', '**Delivery.**', '**Verdicts are four**'];
  for (const marker of MOVED) {
    assert.ok(base.includes(marker), SLIM_BASE + ' must be the template that still carried ' + marker);
    assert.ok(!contract.includes(marker), 'the slimmed template must no longer carry ' + marker);
    assert.ok(protocol.includes(marker), 'protocol.md must be the home of ' + marker);
  }
  assert.ok(base.includes('## Change-complete close-out') && !contract.includes('## Change-complete close-out'),
    'the change-complete close-out procedure must leave the template');
  assert.ok(contract.length * 2 <= base.length, 'the template must shrink by at least half: ' + contract.length + ' of ' + base.length);
  const units = contractUnits(base);
  assert.ok(new Set(units).size > 300, 'the base template must yield its whole sentence domain, got ' + units.length);
  const lost = lostUnits(base, { template: contract, protocol });
  const claims = unit => [...REWORDED, ...RETIRED].filter(entry => unit.startsWith(entry[0]));
  const unmapped = lost.filter(unit => claims(unit).length !== 1);
  assert.deepEqual(unmapped, [], 'sentences the template lost that protocol.md does not carry — carry each in protocol.md, '
    + 'or name its rewording in REWORDED (inserting beside a moved sentence needs no entry): ' + unmapped.join(' || '));
  // No entry maps nothing, and none maps a sentence that is carried verbatim anyway.
  for (const [prefix] of [...REWORDED, ...RETIRED]) {
    assert.equal(lost.filter(unit => unit.startsWith(prefix)).length, 1, 'a map entry must claim exactly one lost sentence: ' + prefix);
  }
  const P = flat(protocol), T = flat(contract);
  for (const [prefix, where, excerpts] of REWORDED) {
    for (const excerpt of excerpts) {
      assert.ok((where === 'protocol' ? P : T).includes(flat(excerpt)), prefix + ': its carrier is gone from ' + where + ' — "' + excerpt + '"');
    }
  }
  for (const [prefix, why, where, successors] of RETIRED) {
    for (const successor of successors) {
      assert.ok((where === 'protocol' ? P : T).includes(flat(successor)), prefix + ' (' + why + '): its successor is gone from ' + where + ' — "' + successor + '"');
    }
  }
  // Live controls, through the same classifier: a sentence no document carries is reported,
  // and so is a moved sentence protocol.md has lost one word of.
  const planted = 'Every planted rule here is carried by no document at all.';
  assert.deepEqual(lostUnits(base + '\n\n' + planted + '\n', { template: contract, protocol }).filter(u => !lost.includes(u)),
    [unitOf(planted)], 'a planted sentence must be reported as lost');
  const moved = 'A pre-verified label is invalidated for any step whose covered files a later repair touched';
  assert.ok(P.includes(moved), 'the control sentence must be one protocol.md carries');
  const damaged = protocol.replace(/whose\s+covered files a later\s+repair touched/, 'whose covered files a later change touched');
  assert.notEqual(damaged, protocol, 'the control must damage protocol.md');
  assert.ok(lostUnits(base, { template: contract, protocol: damaged }).some(u => u.startsWith(moved)),
    'a moved sentence protocol.md no longer carries word for word must be reported');
});

test('template placeholders and registry match in both directions', () => {
  const files = fs.readdirSync(path.join(ROOT, 'orchestrate/templates')).filter(p => p.endsWith('.md'));
  const used = new Set(files.flatMap(p => [...read('orchestrate/templates/' + p).matchAll(/\{\{([A-Z_]+)\}\}/g)].map(m => m[1])));
  const rows = read('orchestrate/references/scaffolding.md').split('\n').filter(l => /^\| `\{\{[A-Z_]+\}\}` \| template/.test(l));
  const listed = rows.map(l => l.match(/\{\{([A-Z_]+)\}\}/)[1]);
  assert.equal(new Set(listed).size, listed.length);
  assert.deepEqual([...used].sort(), listed.sort());
  // The helper-path placeholders retired with the template's copy of the helper section: the
  // recipes run from the pinned directory. Swept bare as well as braced, over the whole skill.
  for (const retired of ['EVIDENCE_TOOL', 'FENCE_TOOL']) assert.ok(!listed.includes(retired), retired + ' still has a registry row');
  const swept = shippedSkillFiles();
  assert.ok(swept.includes('orchestrate/references/scaffolding.md') && swept.includes('orchestrate/templates/00-READBEFORE.md'));
  for (const file of swept) assert.doesNotMatch(read(file), /EVIDENCE_TOOL|FENCE_TOOL/, file + ': names a retired helper-path placeholder');
});

// The template's heading lines outside fences, as flat reads them, for the closed sweeps below: a heading
// here can carry a directive, as "(locked)" and "(binding)" do.
function headingsOf(text) {
  let fenced = false;
  const out = [];
  for (const line of text.split('\n')) {
    if (line.startsWith('```')) fenced = !fenced;
    else if (!fenced && /^#{1,6} /.test(line)) out.push(flat(line));
  }
  return out;
}
// Each fault in `text`: a unit (as contractUnits reads it) or a heading (as headingsOf reads it) that
// `pattern` selects and `listed` does not hold word for word, and a listed one gone. One added or reworded
// is doubt until it is read and listed; text `pattern` does not select is not read.
function closedUnitFaults(text, pattern, listed) {
  const held = [...contractUnits(text), ...headingsOf(text)].filter(unit => pattern.test(unit));
  return [...held.filter(unit => !listed.includes(unit)), ...listed.filter(unit => !held.includes(unit)).map(unit => 'gone: ' + unit)];
}
// The template's units naming a scratch area. The integration and batch worktrees live under
// {{WORKTREE_ROOT}} (B03 of OS-20261022); a gate agent's writes, the validation log and an implementer's
// scratch stay under the session scratchpad.
const SCRATCH_UNITS = [
  "Each writes its full report with the Write tool to the findings file its prompt names — its only other writes are validation logs and disposable scratch under the session scratchpad, never inside a worktree or the repository — and returns four lines: its verdict, NONCE <nonce>, FINDINGS <n>, the file's path",
  'node "{{SKILL_DIR}}/tools/validate.mjs" --spec {{LEDGER_DIR}}/validate.json --log "<session scratchpad>/<label>.log"',
  'never leave untracked files in the worktree (reconcile reads that as dirt — scratch goes under the session scratchpad)',
];
const scratchFaults = text => closedUnitFaults(text, /scratch/i, SCRATCH_UNITS);
test('the template names a scratch area only in the units SCRATCH_UNITS lists', () => {
  assert.deepEqual(scratchFaults(contract), []);
  // Live: a worktree sent back to the scratchpad from the Git model and from boot step 2, a listed unit
  // reworded, the area spelled apart, and an implementer sent there from a heading; each read before the one verdict.
  const plant = (anchor, replacement) => {
    assert.equal(contract.split(anchor).length - 1, 1, 'the control anchor must be found once: ' + anchor);
    return scratchFaults(contract.replace(anchor, () => replacement));
  };
  const GIT_MODEL = 'Wave members run CONCURRENTLY: one implementer per batch, each in an isolated git worktree under {{WORKTREE_ROOT}} as b<nn> (never inside the repo)';
  const STEP_TWO_TAIL = 'only if it already has `{{INTEGRATION_BRANCH}}` checked out.';
  assert.deepEqual([
    plant('(never inside the repo). Per-worktree setup:', '(never inside the repo), or under the session scratchpad. Per-worktree setup:'),
    plant(STEP_TWO_TAIL, STEP_TWO_TAIL + ' Where `{{WORKTREE_ROOT}}` is not writable, add the integration worktree under the session scratchpad instead.'),
    plant('scratch goes under the session scratchpad).', 'scratch and every worktree go under the session scratchpad).'),
    plant('Same-wave fences were planned disjoint.', 'Same-wave fences were planned disjoint. A wave too wide for the root keeps its worktrees in a scratch pad.'),
    plant('## Roles, gates, tiers\n', '## Roles, gates, tiers (each implementer works under the session scratchpad)\n'),
  ], [
    [GIT_MODEL + ', or under the session scratchpad'],
    ['Where {{WORKTREE_ROOT}} is not writable, add the integration worktree under the session scratchpad instead'],
    ['never leave untracked files in the worktree (reconcile reads that as dirt — scratch and every worktree go under the session scratchpad)', 'gone: ' + SCRATCH_UNITS[2]],
    ['A wave too wide for the root keeps its worktrees in a scratch pad'],
    ['## Roles, gates, tiers (each implementer works under the session scratchpad)'],
  ], 'each unit naming a scratch area outside SCRATCH_UNITS, and each listed unit gone, must be reported');
});

// The template's units and headings naming a worktree by any of the template's words for one — a worktree
// or work tree, git's working tree, a checkout or a branch checked out, a clone. Boot step 2 and the Git model place the
// integration and batch worktrees under {{WORKTREE_ROOT}} (both pinned whole in tests/tool-wiring.test.cjs
// PINNED); every other one is read and listed here, so a sentence that uses one of those words and places
// one elsewhere — under /tmp, the system temp directory or inside the repository — is reported. A
// sentence using none of them is not read.
const WORKTREE_UNITS = [
  'Run git status --porcelain, git branch --list, git worktree list',
  'Never switch the main checkout. Read ledger files from any branch with git show <branch>:./<path> (the ./ is required — Git Bash on Windows mangles branch:path otherwise) and write to the ledger through an integration worktree (git worktree add "{{WORKTREE_ROOT}}/int" {{INTEGRATION_BRANCH}}), using the main checkout only if it already has {{INTEGRATION_BRANCH}} checked out',
  'Run git show from the repo or worktree ROOT (the ./ path is cwd-relative)',
  'Reuse an integration worktree that git worktree list already shows',
  'if its directory is gone, git worktree prune first — never two worktrees on one branch',
  'Run {{WORKTREE_SETUP}} in a newly created integration worktree before validating in it',
  'Skill pin, before anything is reconciled: from the integration worktree root run node "{{SKILL_DIR}}/tools/check-ledger.mjs" skill --contract {{LEDGER_DIR}}/00-READBEFORE.md',
  'Work ONLY in the worktree your prompt names',
  'Orchestrator — owns PROGRESS, LOG, evidence/, branches, worktrees, merges, close-outs, all user communication',
  'Implementer — one per batch, in its own worktree on its own branch',
  SCRATCH_UNITS[0],
  'Wave members run CONCURRENTLY: one implementer per batch, each in an isolated git worktree under {{WORKTREE_ROOT}} as b<nn> (never inside the repo)',
  'Per-worktree setup: {{WORKTREE_SETUP}}',
  'do not re-detect these facts from the current checkout',
  'Every run goes through the validation wrapper, from the worktree root',
  "The skill's mutate.mjs is a different tool: the test hunter proves with it only the mutations it chooses itself, each on a disposable clone of the batch's commit",
  'Bump cadence: {{VERSION_BUMP_RULE}} — applied on the integration branch at integration or checkpoint close-out, never inside a wave worktree',
  SCRATCH_UNITS[2],
];
const worktreeFaults = text => closedUnitFaults(text, /work[\W_]*tree|working[\W_]*trees?|check[\W_]*out|\bcheck(?:s|ed|ing)?\b.*\bout\b|\bclon(?:e|es|ed|ing)\b/i, WORKTREE_UNITS);
// One planted text per control, its anchor found once in the template.
const plantIn = (faults, anchor, replacement) => {
  assert.equal(contract.split(anchor).length - 1, 1, 'the control anchor must be found once: ' + anchor);
  return faults(contract.replace(anchor, () => replacement));
};
test('the template names a worktree only in the units WORKTREE_UNITS lists', () => {
  assert.deepEqual(worktreeFaults(contract), []);
  // Live: a worktree placed under /tmp beside the merge policy, under the system temp directory from the
  // implementer's line, inside the repository from §Hard prohibitions and under /tmp from the bump cadence;
  // work trees spelled apart; a listed unit reworded; a batch checkout, a branch checked out and a clone
  // under /tmp, each named by that word alone; worktrees sent to /tmp from a heading, and from a fenced
  // line that only looks like one (read once, as a fenced line). Each is read before the one verdict.
  const MERGE = '- **Merge/push policy**: {{MERGE_POLICY}}\n', IMPLEMENTER = 'in its own worktree on its own branch.';
  const NO_VERIFY = '- No `--no-verify`, no force-push, no history rewriting.\n', BUMP = 'never inside a wave worktree.\n';
  const CONVENTIONS = '## Repo conventions (binding)\n';
  assert.deepEqual([
    plantIn(worktreeFaults, MERGE, MERGE + '- On a machine short of disk, add each batch worktree under `/tmp/{{CHANGE_ID}}` as `b<nn>` instead.\n'),
    plantIn(worktreeFaults, IMPLEMENTER, IMPLEMENTER + ' That worktree is added under the system temp directory.'),
    plantIn(worktreeFaults, NO_VERIFY, NO_VERIFY + '- Keep every worktree inside the repository, under `.worktrees/`, so `git worktree list` shows it beside the checkout.\n'),
    plantIn(worktreeFaults, BUMP, 'never inside a wave worktree. Bump through an integration worktree added under `/tmp/int`.\n'),
    plantIn(worktreeFaults, 'Same-wave fences were planned disjoint.', 'Same-wave fences were planned disjoint. A wave too wide for the root keeps its work trees under /tmp.'),
    plantIn(worktreeFaults, 'Work ONLY in the worktree\nyour prompt names.', 'Work ONLY in the worktree\nyour prompt names, or any directory under /tmp.'),
    plantIn(worktreeFaults, MERGE, MERGE + '- On a machine short of disk, add each batch checkout under `/tmp/{{CHANGE_ID}}` as `b<nn>` instead.\n'),
    plantIn(worktreeFaults, MERGE, MERGE + '- When disk is short, the orchestrator checks each batch branch out under `/tmp/{{CHANGE_ID}}`.\n'),
    plantIn(worktreeFaults, MERGE, MERGE + '- When disk is short, each batch is cloned into `/tmp/{{CHANGE_ID}}`.\n'),
    plantIn(worktreeFaults, CONVENTIONS, '## Repo conventions (binding; worktrees go under /tmp)\n'),
    plantIn(worktreeFaults, '```text\ngit merge-base', '```text\n# each worktree goes under /tmp\ngit merge-base'),
    plantIn(worktreeFaults, 'Same-wave fences were planned disjoint.', 'Same-wave fences were planned disjoint. Each batch gets its own working tree under /tmp.'),
  ], [
    ['On a machine short of disk, add each batch worktree under /tmp/{{CHANGE_ID}} as b<nn> instead'],
    ['That worktree is added under the system temp directory'],
    ['Keep every worktree inside the repository, under .worktrees/, so git worktree list shows it beside the checkout'],
    ['Bump through an integration worktree added under /tmp/int'],
    ['A wave too wide for the root keeps its work trees under /tmp'],
    ['Work ONLY in the worktree your prompt names, or any directory under /tmp', 'gone: Work ONLY in the worktree your prompt names'],
    ['On a machine short of disk, add each batch checkout under /tmp/{{CHANGE_ID}} as b<nn> instead'],
    ['When disk is short, the orchestrator checks each batch branch out under /tmp/{{CHANGE_ID}}'],
    ['When disk is short, each batch is cloned into /tmp/{{CHANGE_ID}}'],
    ['## Repo conventions (binding; worktrees go under /tmp)'],
    ['# each worktree goes under /tmp'],
    ['Each batch gets its own working tree under /tmp'],
  ], 'each unit or heading naming a worktree outside WORKTREE_UNITS, and each listed unit gone, must be reported');
});

// The template's units and headings naming a clear, a restart or a reopen, the mod that opens such a session or a
// fresh conversation (tests/tool-wiring.test.cjs PROCEDURE_FAMILIES' family for the procedure): the threshold line
// orchestrate-mod reads and boot step 1's after-clear sentence (tests/tool-wiring.test.cjs thresholdFaults
// and AFTER_CLEAR_READ). Every other one is read and listed here, so a sentence that uses one of those
// words and sends such a session back to the files the after-clear read skips is reported; a sentence
// naming one of those files is read by LEDGER_READ_UNITS below, and one naming neither is not read.
const CLEAR_UNITS = [
  'Clear threshold: {{CLEAR_THRESHOLD}}',
  'A session that /orchestrate continue <id> after-clear opened reads none of 00-request.md, 01-plan.md and PROGRESS.md: once the pin check (step 3) passes it reads the digest that node "{{SKILL_DIR}}/tools/reconcile.mjs" digest --repo <repo> --ledger {{CHANGE_ID}} --integration refs/heads/{{INTEGRATION_BRANCH}} prints, and of this contract only §Boot sequence, §Git model, §Validation commands and §Hard prohibitions, reading any other section by its heading when a step needs it',
];
const clearFaults = text => closedUnitFaults(text, /clear|restart|re-?open|orchestrate-mod|\bthe mod\b|\bfresh conversation/i, CLEAR_UNITS);
test('the template names a clear only in the units CLEAR_UNITS lists', () => {
  assert.deepEqual(clearFaults(contract), []);
  // Live: a cleared session sent to the plan from boot step 5; the after-clear sentence reworded to read
  // the files it skips; a restarted and a reopened session, each named by that word alone, sent to the
  // plan from boot step 6; a cleared session let off validation from a heading; a session the mod or orchestrate-mod
  // opened, and a fresh conversation, each named with no clear word, sent to the whole contract from §Hard prohibitions.
  // Each is read before the one verdict.
  const RECONCILE = '5. **Reconcile** (protocol.md §Recovery) before believing any PROGRESS row.\n';
  const GREEN = 'Green → follow protocol.md §Session algorithm.', BOOT = '## Boot sequence (orchestrator, every session)\n';
  const PROHIBITIONS = '## Hard prohibitions\n';
  assert.deepEqual([
    plantIn(clearFaults, RECONCILE, RECONCILE.trimEnd() + ' When orchestrate-mod has cleared the conversation, read 00-request.md, 01-plan.md and PROGRESS.md first, as every session does.\n'),
    plantIn(clearFaults, 'opened reads none of', 'opened reads all of'),
    plantIn(clearFaults, GREEN, GREEN + ' A session the mod restarted reads 01-plan.md before reconciling.'),
    plantIn(clearFaults, GREEN, GREEN + ' A session the mod reopened reads 01-plan.md before reconciling.'),
    plantIn(clearFaults, BOOT, '## Boot sequence (orchestrator, every session; a cleared one skips step 6)\n'),
    plantIn(clearFaults, PROHIBITIONS, PROHIBITIONS + '\n- A session the mod opened reads the whole contract before its §Boot sequence.\n'),
    plantIn(clearFaults, PROHIBITIONS, PROHIBITIONS + '\n- A session orchestrate-mod opened reads the whole contract first.\n'),
    plantIn(clearFaults, PROHIBITIONS, PROHIBITIONS + '\n- A fresh conversation reads the whole contract first.\n'),
  ], [
    ['When orchestrate-mod has cleared the conversation, read 00-request.md, 01-plan.md and PROGRESS.md first, as every session does'],
    [CLEAR_UNITS[1].replace('reads none of', () => 'reads all of'), 'gone: ' + CLEAR_UNITS[1]],
    ['A session the mod restarted reads 01-plan.md before reconciling'],
    ['A session the mod reopened reads 01-plan.md before reconciling'],
    ['## Boot sequence (orchestrator, every session; a cleared one skips step 6)'],
    ['A session the mod opened reads the whole contract before its §Boot sequence'],
    ['A session orchestrate-mod opened reads the whole contract first'],
    ['A fresh conversation reads the whole contract first'],
  ], 'each unit or heading naming a clear outside CLEAR_UNITS, and each listed unit gone, must be reported');
});

// The template's units and headings naming a file the after-clear read skips — 00-request.md, 01-plan.md
// or PROGRESS.md, numbered or not: boot step 1's read list and its after-clear sentence. Every other one is
// read and listed here, so a sentence that sends a session back to one of those files is reported whatever
// it calls the session; a sentence naming none of the three files is not read.
const LEDGER_READ_UNITS = [
  "Read 00-request.md (the user's verbatim ask + decisions), 01-plan.md (locked scope, batch table, wave map + checkpoints), and PROGRESS.md, plus the project's always-loaded docs — especially {{GUARDRAILS_REF}}",
  CLEAR_UNITS[1],
];
const ledgerReadFaults = text => closedUnitFaults(text, /\b(?:0[01]-)?(?:request|plan)\.md\b|\bPROGRESS\.md\b/i, LEDGER_READ_UNITS);
test('the template names the files the after-clear read skips only in the units LEDGER_READ_UNITS lists', () => {
  assert.deepEqual(ledgerReadFaults(contract), []);
  // Live: a session orchestrate-mod opened sent to all three files, and a cleared one sent there from boot
  // step 5; each file named alone, the plan unnumbered; a listed unit reworded. Each is read before the one verdict.
  const GREEN = 'Green → follow protocol.md §Session algorithm.', RECONCILE = '5. **Reconcile** (protocol.md §Recovery) before believing any PROGRESS row.\n';
  assert.deepEqual([
    plantIn(ledgerReadFaults, GREEN, GREEN + ' A session orchestrate-mod opened reads 00-request.md, 01-plan.md and PROGRESS.md first, as every session does.'),
    plantIn(ledgerReadFaults, RECONCILE, RECONCILE.trimEnd() + ' When orchestrate-mod has cleared the conversation, read 00-request.md, 01-plan.md and PROGRESS.md first, as every session does.\n'),
    plantIn(ledgerReadFaults, GREEN, GREEN + ' A session the mod opened reads 00-request.md first.'),
    plantIn(ledgerReadFaults, GREEN, GREEN + ' A session the mod opened reads plan.md first.'),
    plantIn(ledgerReadFaults, GREEN, GREEN + ' A session the mod opened reads PROGRESS.md first.'),
    plantIn(ledgerReadFaults, '(the user\'s verbatim ask + decisions)', '(the user\'s verbatim ask)'),
  ], [
    ['A session orchestrate-mod opened reads 00-request.md, 01-plan.md and PROGRESS.md first, as every session does'],
    ['When orchestrate-mod has cleared the conversation, read 00-request.md, 01-plan.md and PROGRESS.md first, as every session does'],
    ['A session the mod opened reads 00-request.md first'],
    ['A session the mod opened reads plan.md first'],
    ['A session the mod opened reads PROGRESS.md first'],
    [LEDGER_READ_UNITS[0].replace(' + decisions', () => ''), 'gone: ' + LEDGER_READ_UNITS[0]],
  ], 'each unit or heading naming a skipped file outside LEDGER_READ_UNITS, and each listed unit gone, must be reported');
});

// The manual fallback lives once, in protocol.md (the template's copy retired with B01), so
// the rule is pinned there and the template is held to carrying no second copy. Pin the
// command inside the rule itself, so naming it elsewhere in the document cannot satisfy this.
// Pin the whole clause, like the decision tables and the self-check clause below: matching
// only /git check-attr filter/ is equally satisfied by "never run git check-attr filter",
// the exact opposite of what the probe does. The imperative IS this sentence's content, so
// freezing its wording is deliberate; the pin stops at the clause, leaving the rest free.
test('the manual read-only fallback names git check-attr filter in the resolved-filter rule', () => {
  const rule = 'Before status, run git check-attr filter on the paths status inspects:';
  assert.ok(!contract.includes('**Manual read-only fallback.**') && !contract.includes('git check-attr'),
    'orchestrate/templates/00-READBEFORE.md: the manual fallback lives in protocol.md only');
  for (const [label, text] of [['orchestrate/references/protocol.md', protocol]]) {
    const from = text.indexOf('**Manual read-only fallback.**'), to = text.indexOf('## Git model');
    assert.ok(from !== -1 && to > from, label + ': the manual read-only fallback must precede the Git model heading');
    const fallback = text.slice(from, to);
    const start = fallback.indexOf('Before status,'), end = fallback.indexOf('makes safe cleanliness unknown');
    assert.ok(start !== -1 && end > start, label + ': the manual fallback must still carry the resolved-filter rule');
    assert.ok(fallback.slice(start, end).replace(/\s+/g, ' ').startsWith(rule),
      label + ': the resolved-filter step must read exactly "' + rule + '" (whitespace collapsed)');
    // A contradiction beside the pinned clause defeats it. Scope is this subsection, not
    // the document; the clause bound is load-bearing (`do not probe their trees` above
    // matches an unnarrowed `.*`). Polarity-blind: reinforcements ("Never skip git
    // check-attr filter") redden too — word one with no negation verb in its clause.
    // Uncaught by design: negation after the command, a probe synonym, an unlisted verb.
    assert.doesNotMatch(fallback.replace(/\s+/g, ' '), /(?:never|not|avoid|skip)\b[^.;:]*\bgit check-attr\b/i,
      label + ': nothing in the manual fallback may tell a human NOT to run git check-attr');
  }
});

test('protocol.md carries helper grammar, outcomes, fallback and full input responsibility; the contract none of it', () => {
  // The two sections the template mirrored now live once, in protocol.md, ahead of the
  // headings that bounded them; each required term is asserted INSIDE its own section.
  const section = (text, from, to) => { const i = text.indexOf(from), j = text.indexOf(to, i);
    assert.ok(i !== -1 && j > i, 'protocol.md: ' + from + ' must precede ' + to); return text.slice(i, j); };
  const helper = section(protocol, '### Read-only evidence tools', '## Git model');
  const inputs = section(protocol, '### Complete checkpoint inputs', '## Smoke checkpoints');
  for (const heading of ['### Read-only evidence tools', '### Complete checkpoint inputs']) {
    assert.ok(!contract.includes(heading), 'the contract template must carry no copy of ' + heading);
  }
  for (const needed of ['complete/partial/unknown', 'contained/not-contained/unknown', 'VIOLATION (1)', 'UNKNOWN (2)',
    'both arrays', 'committed integration plan', 'never the candidate', 'exact comma-separated backtick paths',
    'Manual read-only fallback', 'ALL local/remote-tracking', 'git show ref:./path', 'only the selected ledger']) {
    assert.ok(helper.includes(needed), 'protocol.md §Read-only evidence tools must carry: ' + needed);
  }
  // The one term of the old list that belonged to neither section (the shipment passage says it).
  assert.ok(protocol.includes('does not'), 'protocol.md must carry: does not');
  for (const needed of ['immutable', 'inputHistory', 'EVERY', 'inputRoot', 'raw SHA-256', 'working-copy', 'reset',
    'private-data', 'credential', 'external-access', 'independently validate', 'never workbook semantics']) {
    assert.ok(inputs.includes(needed), 'protocol.md §Complete checkpoint inputs must carry: ' + needed);
  }
  for (const file of ['orchestrate/SKILL.md', 'orchestrate/references/scaffolding.md', 'orchestrate/references/execution-models.md',
    'orchestrate/references/subagent-prompts.md', 'orchestrate/references/smoke-page.md']) {
    const text = read(file);
    for (const required of [/inputs/i, /reset/i, /independen/i, /revisio/i, /(?:private.data|credential)/i]) assert.match(text, required, file);
  }
  for (const file of ['orchestrate/templates/01-plan.md', 'orchestrate/templates/02-batch.md', 'orchestrate/templates/PROGRESS.md']) {
    const text = read(file); assert.match(text, /input/i); assert.match(text, /reset/); assert.match(text, /revis/i);
  }
  assert.match(read('orchestrate/references/subagent-prompts.md'), /ACTUAL INPUTS: \[INPUT ROOT, STABLE-ID REGISTRY/);
  assert.match(read('orchestrate/SKILL.md'), /Existing\nledgers keep their frozen contract/);
  const gate = section(protocol, '## §Session algorithm', '## Two distinct close-outs');
  assert.ok(gate.indexOf('**6a Fence check') !== -1 && gate.indexOf('**6a Fence check') < gate.indexOf('**6b Failing-on-base'));
  assert.ok(gate.indexOf('**6b Failing-on-base') < gate.indexOf('**6c Reviewer'));
  assert.match(gate.slice(gate.indexOf('**6a Fence check'), gate.indexOf('**6b Failing-on-base')), /read-only helper.*\n\s+or its manual fallback/);
  assert.ok(!contract.includes('**6a Fence check'), 'the gate steps live in protocol.md only');
});

test('reusable artifacts contain no local Python installation default, while frozen ledger retains its environment fact', { skip: 'needs history and ledger records that are not in this copy' }, () => {
  const paths = ['orchestrate/SKILL.md', ...fs.readdirSync(path.join(ROOT, 'orchestrate/templates')).map(p => 'orchestrate/templates/' + p),
    ...fs.readdirSync(path.join(ROOT, 'orchestrate/references')).filter(p => p.endsWith('.md')).map(p => 'orchestrate/references/' + p),
    'orchestrate/tools/build-smoke-page.mjs', 'orchestrate/tools/smoke-inputs.mjs'];
  for (const file of paths) assert.doesNotMatch(read(file), /[A-Z]:[\\/](?:Users|Program Files)[\\/].*Python|Python310/i, file);
  const candidates = ['.agents/archive/OS-20260918-readonly-evidence-smoke-inputs/00-READBEFORE.md',
    '.agents/changes/OS-20260918-readonly-evidence-smoke-inputs/00-READBEFORE.md'];
  // The approved ledger is branch-local and moves on archival; ordinary clones need
  // not contain it. When present, reusable edits must never rewrite its local fact —
  // and one location must exist HERE, so the next move breaks this guard loudly
  // instead of silently disarming it.
  const frozen = candidates.filter(p => fs.existsSync(path.join(ROOT, p)));
  assert.ok(frozen.length, 'frozen ledger contract must be readable at one of: ' + candidates.join(', '));
  // Counts, not mere presence: the interpreter path occurs three times and the
  // Excel-validation sentence once, so deleting any of them turns this red. A presence
  // check survives losing two of the three and calls the environment fact "retained".
  for (const file of frozen) {
    const text = read(file);
    assert.equal((text.match(/Python310[\\/]python\.exe/g) || []).length, 3, file + ': three literal interpreter paths');
    assert.equal((text.match(/Every generation and independent Excel-validation command in this run uses literal/g) || []).length,
      1, file + ': one Excel-validation sentence');
  }
});

test('the scaffold self-check names the Bnn id rule for both authority tables', () => {
  // scaffolding.md step 9 and the SKILL.md one-liner summarising it are the only place
  // a scaffolder is TOLD the rules the fence enforces. The id rule is pinned as the
  // exact approved sentence, like the decision tables above: mere co-occurrence of
  // "plan", "PROGRESS" and `Bnn` cannot tell "in BOTH ... and" from "in EITHER ... OR",
  // nor a requirement from its negation, and only those words state the rule the fence
  // enforces. Rewording it is then a deliberate, visible test edit. Filenames are
  // normalised away first, so writing "PROGRESS.md" is prose, not a failure.
  const selfCheckText = file => read(file).replace(/\s+/g, ' ').replace(/\.md\b/g, '');
  const idClause = {
    'orchestrate/references/scaffolding.md': 'every `#` cell of the batch tables in BOTH the plan and PROGRESS reads `Bnn`',
    'orchestrate/SKILL.md': "every `#` cell of the plan's and PROGRESS's batch tables reads `Bnn`"
  };
  // The residual grep is bound to its own verdict: naming `<title>` somewhere else in
  // the paragraph is not the same as grepping for it and requiring zero hits. `[^.;]*`
  // keeps the match inside one clause — the hole a bare `[^;]*` left open.
  const residualGrep = /grep the new[^.;]*`<title>`[^.;]*zero hits/i;
  for (const [file, clause] of Object.entries(idClause)) {
    const text = selfCheckText(file);
    assert.ok(text.includes(clause), file + ': the self-check must read exactly "' + clause + '" (whitespace collapsed, .md stripped)');
    assert.match(text, residualGrep, file + ': the self-check must grep for `<title>` and require zero hits — the token a deleted comment marker leaves behind');
  }
  // Rule and template cannot drift apart: the example rows must carry the very token
  // step 9 greps for, or the partial-deletion door reopens without a single test moving.
  for (const template of ['orchestrate/templates/01-plan.md', 'orchestrate/templates/PROGRESS.md']) {
    const row = read(template).split('\n').find(l => /^\| B\d{2,} \|/.test(l));
    assert.ok(row, template + ': no `| Bnn | ... |` example row to check');
    assert.ok(row.includes('<title>'), template + ': the example row must carry `<title>`, the token step 9 greps for — row reads ' + row);
  }
});

// The commit these templates pinned no example row at — a permanent historical blob,
// reachable in any full clone, used below as the red half of the proof.
const BATCH_BASE = 'fad7a64';
// A scaffolder's job, mechanised: lift the pinned example row out of the template's
// batch-table instruction comment and substitute real values. No authority row is
// hand-authored here, so a template that pins no Bnn row cannot quietly ship a ledger
// the real fence refuses to read.
function renderAuthorityTable(template, required, values, text = read(template)) {
  const lines = text.split('\n'), cellsOf = line => line.split('|').slice(1, -1).map(x => x.trim());
  const head = lines.findIndex(l => l.startsWith('|') && required.every(key => cellsOf(l).includes(key)));
  assert.notEqual(head, -1, template + ': no batch table carrying ' + required.join(', '));
  const open = lines.findIndex((l, i) => i > head && l.includes('<!--'));
  assert.notEqual(open, -1, template + ': the batch table carries no instruction comment');
  const close = open + lines.slice(open).findIndex(l => l.includes('-->'));
  // A live example row OUTSIDE the comment carries no {{ and no <!--, so the scaffold
  // self-check passes it and it reaches a filled ledger beside the real B01 — the
  // duplicate id that makes the fence throw for every batch of the change.
  assert.deepEqual(lines.filter((l, i) => (i < open || i > close) && /^\| B\d{2,} \|/.test(l)), [],
    template + ': a `| Bnn | ... |` row outside the instruction comment would survive scaffolding and collide with the real B01');
  const example = lines.slice(open, close + 1).find(l => /^\| B\d{2,} \|.*\|$/.test(l));
  assert.ok(example, template + ': the batch-table instruction comment pins no `| Bnn | ... |` example row for a scaffolder to copy');
  const header = cellsOf(lines[head]), cells = cellsOf(example);
  assert.equal(cells.length, header.length, template + ': the Bnn example row needs one cell per header column');
  // Callers never supply the # cell, so the id the fence reads is the template's own.
  // Without this, swapping the # and Batch columns leaves the suite green while the
  // template instructs every scaffolder to put the id in the wrong place.
  assert.match(cells[header.indexOf('#')], /^B\d{2,}$/, template + ": the example row's Bnn must sit in the # column");
  return [lines[head], lines[head + 1], '| ' + header.map((key, i) => values[key] ?? cells[i]).join(' | ') + ' |', ''].join('\n');
}

test('published helper recipes execute actual CLIs and generated batch grammar passes the real fence', { skip: 'needs history and ledger records that are not in this copy' }, t => {
  const repo = makeRepo(t), ledger = '.agents/changes/DOCS', integration = 'refs/heads/codex/docs-ledger';
  const batch = 'refs/heads/codex/docs-b01', batchFile = ledger + '/02-batches-01-example.md';
  repo.git('checkout', '-b', 'codex/docs-ledger');
  const values = { BATCH_NUM: '01', BATCH_BRANCH: 'codex/docs-b01', BATCH_FILES: '`payload.txt`', BATCH_NEW_FILES: 'none', BATCH_TITLE: 'Example',
    BATCH_TYPE: 'feature', BATCH_VERSION: '—' };
  const rendered = read('orchestrate/templates/02-batch.md').replace(/\{\{([A-Z_]+)\}\}/g, (_, k) => values[k] || 'example')
    .replace(/<!-- - \[ \] one box[\s\S]*?-->/, '- [ ] Implement example.')
    .replace(/<!--[\s\S]*?-->/g, '');
  repo.write(batchFile, rendered);
  const planKeys = ['#', 'Branch', 'Files (fence)'], progressKeys = ['#', 'Branch', 'Notes'];
  // No '#' value: B01 below is the fence's --batch-id, and it must be the id the
  // templates themselves pin. Change either template's example id and this goes red.
  repo.write(ledger + '/01-plan.md', renderAuthorityTable('orchestrate/templates/01-plan.md', planKeys,
    { Branch: '`codex/docs-b01`', 'Files (fence)': '`payload.txt`' }));
  repo.write(ledger + '/PROGRESS.md', '**State**: ACTIVE\n' + renderAuthorityTable('orchestrate/templates/PROGRESS.md',
    progressKeys, { Branch: '`codex/docs-b01`', Notes: '—' }));
  // The other direction, driven by a shipped artifact rather than text this test
  // mutilated itself: at this batch's base these templates pinned no example row, and
  // the helper must still say so in those exact words. That silence is what degraded
  // OS-20260919's fence check to the manual fallback for every one of its batches.
  for (const [template, keys] of [['orchestrate/templates/01-plan.md', planKeys], ['orchestrate/templates/PROGRESS.md', progressKeys]]) {
    const blob = spawnSync('git', ['-C', ROOT, 'show', BATCH_BASE + ':' + template], { encoding: 'utf8', windowsHide: true });
    assert.ifError(blob.error); assert.equal(blob.status, 0, template + ' at ' + BATCH_BASE + ' must be readable: ' + blob.stderr);
    assert.throws(() => renderAuthorityTable(template, keys, {}, blob.stdout.replace(/\r\n/g, '\n')),
      e => e.message === template + ': the batch-table instruction comment pins no `| Bnn | ... |` example row for a scaffolder to copy',
      template + ' at ' + BATCH_BASE + ' must fail on the missing example row, not on some other diagnostic');
  }
  repo.write(ledger + '/00-READBEFORE.md', contract.replace(/\{\{([A-Z_]+)\}\}/g, (_, key) => ({
    INTEGRATION_BRANCH: 'codex/docs-ledger' }[key] || 'example')));
  const source = repo.commit('rendered scaffold');
  const remote = repo.remote(); repo.git('push', 'origin', source + ':refs/heads/main');
  const wt = path.join(repo.root, 'batch'); repo.git('worktree', 'add', '-b', 'codex/docs-b01', wt, source);
  const candidate = repo.at(wt); candidate.write('payload.txt', 'Implemented\n');
  candidate.write(batchFile, rendered.replace('- [ ] Implement example.', '- [x] Implement example.'));
  const tip = candidate.commit('implementation');
  const before = repo.snapshot(), candidateBefore = candidate.snapshot();
  // The recipes as published: `node "<skill-dir>/tools/<tool>.mjs" …`, `<skill-dir>` being the
  // contract's pinned skill directory, which for this checkout is its own `orchestrate/`.
  const recipes = protocol.split('\n').filter(l => l.startsWith('node "<skill-dir>/tools/'));
  assert.equal(recipes.length, 7);
  assert.ok(!/^node\s+["']?orchestrate[\\/]tools[\\/]/m.test(protocol), 'no recipe may name the clone-relative tools path');
  for (const line of recipes) {
    const argv = [...line.matchAll(/"([^"]*)"|(\S+)/g)].map(m => m[1] ?? m[2]);
    assert.equal(argv[0], 'node'); assert.match(argv[1], /^<skill-dir>\/tools\/[a-z-]+\.mjs$/, line);
    const tokens = argv, script = path.join(ROOT, 'orchestrate', argv[1].slice('<skill-dir>/'.length));
    const args = tokens.slice(2).map((value, i, list) => {
      if (!value.startsWith('<')) return value;
      const flag = list[i - 1];
      return { '--repo': repo.cwd, '--integration': integration, '--batch': batch, '--ledger': 'DOCS', '--batch-id': 'B01',
        '--batch-file': batchFile, '--remote': 'origin', '--ancestor': repo.base, '--descendant': source,
        '--owner': integration, '--target': source, '--ref': line.includes(' shipment ') ? 'refs/heads/main' : integration }[flag];
    });
    assert.ok(args.every(Boolean), line);
    const r = spawnSync(process.execPath, [script, ...args], { cwd: repo.cwd, env: repo.env, encoding: 'utf8', windowsHide: true });
    assert.ifError(r.error); assert.equal(r.status, 0, line + '\n' + r.stdout + r.stderr);
    const result = JSON.parse(r.stdout);
    if (line.includes('check-fence')) {
      assert.equal(result.status, 'PASS'); assert.equal(result.integrationSha, source); assert.equal(result.batchSha, tip);
    } else {
      assert.equal(result.completeness, 'complete');
      if (line.includes(' ancestry ')) assert.equal(result.evidence.result, 'contained');
      if (line.includes(' shipment ')) assert.equal(result.evidence.result, line.includes('--source local') ? 'not-contained' : 'contained');
      if (line.includes(' discovery ')) assert.ok(result.evidence.ledgers.some(l => l.id === 'DOCS'));
      if (line.includes(' ledger ')) assert.equal(result.evidence.active.exists, true);
    }
  }
  assert.deepEqual(repo.snapshot(), before); assert.deepEqual(candidate.snapshot(), candidateBefore);
  assert.ok(remote.cwd);
});

test('actual README recursive command and portable form discover nested failure then success; empty primary discovery fails', t => {
  const repo = makeRepo(t), readme = read('README.md');
  const runnerEnv = { ...repo.env }; delete runnerEnv.NODE_TEST_CONTEXT;
  const command = readme.match(/```powershell\n(\$testFiles = [\s\S]*?)\n```/)[1];
  assert.match(command, /Get-ChildItem -LiteralPath tests -Filter \*\.test\.cjs -File -Recurse \| Sort-Object FullName \| ForEach-Object FullName/);
  assert.match(command, /node --test --test-reporter=spec @testFiles/);
  assert.match(readme, /Portable convenience: `node --test`/); assert.doesNotMatch(readme, /`node --test tests(?:`| )/);
  const runner = path.join(repo.root, 'published-runner.ps1'); fs.writeFileSync(runner, command + '\n');
  let powershell;
  for (const shell of ['pwsh', 'powershell']) {
    const r = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()'], { encoding: 'utf8' });
    if (!r.error && r.status === 0) { powershell = shell; break; }
  }
  if (!powershell) { t.skip('PowerShell prerequisite unavailable; execute published recipe on a PowerShell runner before hand-over.'); return; }
  const top = 'tests/a-control.test.cjs', nested = 'tests/unit/discovery-sentinel.test.cjs', last = 'tests/z-control.test.cjs';
  const control = name => `require('node:test')('${name}', () => require('node:assert/strict').equal(1, 1));\n`;
  repo.write(top, control('top-level discovery control')); repo.write(last, control('last discovery control'));
  const sentinel = pass => `require('node:test')('UNIQUE nested discovery sentinel', () => require('node:assert/strict').equal(${pass ? '1' : '0'}, 1));\n`;
  repo.write(nested, sentinel(false));
  const run = () => spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-File', runner], { cwd: repo.cwd, env: runnerEnv, encoding: 'utf8', windowsHide: true });
  const portable = () => spawnSync(process.execPath, ['--test'], { cwd: repo.cwd, env: runnerEnv, encoding: 'utf8', windowsHide: true });
  for (const result of [run(), portable()]) {
    assert.ifError(result.error); assert.notEqual(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout + result.stderr, /UNIQUE nested discovery sentinel/);
    assert.match(result.stdout, /fail 1/);
  }
  const failed = run(); assert.match(failed.stderr, /Node test suite failed/);
  repo.write(nested, sentinel(true));
  for (const result of [run(), portable()]) { assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /pass 3/); }
  const diffControl = 'tracked-diff-control.txt';
  repo.write(diffControl, 'clean tracked line\n');
  repo.commit('passing suites and clean tracked diff control');
  repo.write(diffControl, 'tracked trailing whitespace  \n');
  const badDiff = run();
  assert.ifError(badDiff.error);
  assert.match(badDiff.stdout, /pass 3/, 'Node tests must pass before the independent Git diff failure');
  assert.notEqual(badDiff.status, 0, badDiff.stdout + badDiff.stderr);
  assert.match(badDiff.stdout + badDiff.stderr, /trailing whitespace/);
  assert.match(badDiff.stderr, /Git diff check failed/);
  repo.write(diffControl, 'clean tracked line\n');
  const cleanDiff = run();
  assert.equal(cleanDiff.status, 0, cleanDiff.stdout + cleanDiff.stderr);
  assert.match(cleanDiff.stdout, /pass 3/, 'restoring the tracked file must restore successful published validation');
  const enumeration = command.split('\n')[0] + '\n$testFiles | ConvertTo-Json -Compress';
  const result = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', enumeration], { cwd: repo.cwd, env: repo.env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), [top, nested, last].map(p => path.join(repo.cwd, p)));
  for (const name of [top, nested, last]) fs.unlinkSync(path.join(repo.cwd, name));
  const empty = run(); assert.notEqual(empty.status, 0); assert.match(empty.stderr, /No Node test suites discovered/);
});

// ===== BL-010 and BL-016 sweeps ============================================
// Both sweeps below take their domain from the checkout rather than a hand-written
// list, and walk it RECURSIVELY with no file-type filter: a carrier of either rule
// could land in `references/runners/rules.md`, in `smoke-page-template.html` (which
// already carries runner prose) or in a tool. `orchestrate/` happens to be flat and
// mostly Markdown today, so "it recurses" and "it reads every type" would be vacuous
// claims about this checkout; the fixture test below reaches the recursive branch at
// depth three and pins the non-Markdown members that exist here.
function walkFiles(dir, prefix = '') {
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const rel = prefix ? prefix + '/' + entry.name : entry.name;
    if (entry.isDirectory()) found.push(...walkFiles(path.join(dir, entry.name), rel));
    else if (entry.isFile()) found.push(rel);
  }
  return found;
}
const shippedSkillFiles = () => walkFiles(path.join(ROOT, 'orchestrate')).map(rel => 'orchestrate/' + rel);
const collapsed = file => read(file).replace(/\s+/g, ' ');
// The files git tracks under orchestrate/, at any depth: what the skill ships, so an untracked or ignored file there is
// none of it. A listing that fails stops the run rather than read as empty.
function trackedSkillFiles(cwd = ROOT, env = process.env) {
  const r = spawnSync('git', ['ls-files', '-z', '--', 'orchestrate'], { cwd, env, encoding: 'utf8', windowsHide: true, timeout: 15000 });
  assert.ifError(r.error);
  assert.equal(r.status, 0, 'git ls-files must list orchestrate/: ' + r.stderr);
  return r.stdout.split('\0').filter(Boolean).sort();
}
// Each way a pinned list of the skill's non-Markdown files parts from the checkout: a tracked non-Markdown file it does
// not name, a name that is no tracked non-Markdown file, and a name the sweeps' walk does not reach.
function nonMarkdownFaults(listed, tracked, walked) {
  const shipped = tracked.filter(file => !file.endsWith('.md'));
  return [...shipped.filter(file => !listed.includes(file)).map(file => file + ': tracked, not listed'),
    ...listed.filter(file => !shipped.includes(file)).map(file => file + ': listed, no tracked non-Markdown file'),
    ...listed.filter(file => !walked.includes(file)).map(file => file + ': listed, the walk misses it')];
}

test('the shipped-skill domain both rule sweeps use recurses and filters no file type', t => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'skill-domain-walk-'));
  t.after(() => fs.rmSync(root, { recursive: true, maxRetries: 8, retryDelay: 100 }));
  fs.mkdirSync(path.join(root, 'references', 'runners'), { recursive: true });
  fs.mkdirSync(path.join(root, 'empty-dir'));
  fs.writeFileSync(path.join(root, 'SKILL.md'), 'top\n');
  fs.writeFileSync(path.join(root, 'references', 'smoke-page-template.html'), 'html\n');
  fs.writeFileSync(path.join(root, 'references', 'runners', 'rules.md'), 'nested\n');
  // Depth three, a non-Markdown file and a directory holding no files: the branch that
  // a flat all-Markdown checkout never exercises, so a future non-recursive rewrite of
  // walkFiles fails here instead of silently shrinking both sweeps' domains.
  assert.deepEqual(walkFiles(root),
    ['SKILL.md', 'references/runners/rules.md', 'references/smoke-page-template.html']);
  const shipped = shippedSkillFiles();
  assert.deepEqual(shipped.slice().sort(), shipped, 'the shipped listing must come out sorted');
  assert.equal(new Set(shipped).size, shipped.length, 'the shipped listing must not repeat a path');
  // Signature 1: three SAMPLED members left the domain itself unpinned — a new tool could
  // join the skill and never be swept, and dropping a member here and from `orchestrate/`
  // together stayed green. The list is compared against the non-Markdown files git tracks
  // under `orchestrate/`, each of which the walk must reach, and its own size is pinned so
  // the both-at-once edit reddens too.
  const NON_MARKDOWN = ['orchestrate/references/ruling-page-template.html', 'orchestrate/references/smoke-page-template.html',
    'orchestrate/tools/backlog.mjs', 'orchestrate/tools/build-ruling-page.mjs', 'orchestrate/tools/build-smoke-page.mjs', 'orchestrate/tools/check-fence.mjs',
    'orchestrate/tools/check-ledger.mjs', 'orchestrate/tools/detect.mjs', 'orchestrate/tools/env-facts.mjs',
    'orchestrate/tools/failing-on-base.mjs', 'orchestrate/tools/git-evidence.mjs',
    'orchestrate/tools/ledger-parse.mjs', 'orchestrate/tools/mutate.mjs', 'orchestrate/tools/prompt.mjs',
    'orchestrate/tools/prose-only-diff.mjs', 'orchestrate/tools/reconcile.mjs', 'orchestrate/tools/run-at-ref.mjs',
    'orchestrate/tools/scaffold.mjs', 'orchestrate/tools/smoke-inputs.mjs',
    'orchestrate/tools/validate.mjs'];
  assert.equal(NON_MARKDOWN.length, 20, 'the pinned non-Markdown domain must not shrink to a sample');
  assert.deepEqual(nonMarkdownFaults(NON_MARKDOWN, trackedSkillFiles(), shipped), [],
    'the sweeps must reach every non-Markdown shipped file, not only *.md; add a new tool to this list deliberately');
  // Live, on a fixture: an untracked and an ignored file under its orchestrate/ ship nothing, while a tracked file the
  // list does not name, a Markdown name and a listed file gone from the tree are each reported.
  const repo = makeRepo(t);
  repo.write('.gitignore', '*.log\n');
  repo.write('orchestrate/SKILL.md', 'top\n');
  repo.write('orchestrate/tools/deeper/x.mjs', 'x\n');
  repo.commit('skill');
  repo.write('orchestrate/tools/untracked.mjs', 'x\n');
  repo.write('orchestrate/tools/scratch.log', 'x\n');
  const fixture = listed => nonMarkdownFaults(listed, trackedSkillFiles(repo.cwd, repo.env),
    walkFiles(path.join(repo.cwd, 'orchestrate')).map(rel => 'orchestrate/' + rel));
  assert.deepEqual(fixture(['orchestrate/tools/deeper/x.mjs']), [], 'an untracked or ignored file under orchestrate/ is no shipped file');
  assert.deepEqual(fixture(['orchestrate/tools/deeper/x.mjs', 'orchestrate/SKILL.md']), ['orchestrate/SKILL.md: listed, no tracked non-Markdown file']);
  repo.write('orchestrate/tools/y.mjs', 'y\n');
  repo.git('add', '--', 'orchestrate/tools/y.mjs');
  repo.git('commit', '-m', 'a new tool');
  fs.rmSync(path.join(repo.cwd, 'orchestrate/tools/deeper/x.mjs'));
  assert.deepEqual(fixture(['orchestrate/tools/deeper/x.mjs']),
    ['orchestrate/tools/y.mjs: tracked, not listed', 'orchestrate/tools/deeper/x.mjs: listed, the walk misses it']);
  // Shape, never a pinned total: the skill grows. Only that it is bigger than either
  // rule's carrier set, so neither sweep can be satisfied by its own subjects alone.
  assert.ok(shipped.length > 10, 'shipped skill listing collapsed to ' + shipped.length + ' files');
});

// BL-010: the scaffold self-check greps a brand-new ledger for `{{`, `<!--` and
// `<title>` and called every hit an unfilled slot. A ledger that DOCUMENTS templating
// work quotes those tokens legitimately — this repository produced eleven such hits in
// one scaffold commit, every one inside a code span — so the absolute was false and the
// scaffolder was told to edit correct prose away. What is pinned here is the PREDICATE
// ("a hit inside a code span is not an unfilled slot"), not the noun phrase "fenced and
// inline code spans", which the exemption and its exact inverse both contain.
test('the scaffold self-check exempts code spans from the placeholder grep', () => {
  const selfCheckText = file => collapsed(file).replace(/\.md\b/g, '');
  const selfCheckFiles = shippedSkillFiles().filter(file => selfCheckText(file).includes('grep the new'));
  // Derived, not asserted against itself: a third document acquiring the self-check
  // reddens here rather than escaping the paragraph checks below.
  assert.deepEqual(selfCheckFiles, ['orchestrate/SKILL.md', 'orchestrate/references/scaffolding.md']);
  assert.equal(selfCheckFiles.length, 2, 'exactly two shipped documents state the scaffold self-check');
  const bounds = {
    'orchestrate/references/scaffolding.md': ['9. **Self-check**', '10. **Scaffold commit**'],
    'orchestrate/SKILL.md': ['self-check (grep the new directory', 'scaffold commit on']
  };
  assert.deepEqual(Object.keys(bounds).sort(), selfCheckFiles.slice().sort());
  // Signature 1 again: dropping `<!--` from this array AND from SKILL.md's grep clause
  // together was GREEN — every assertion took a member as its subject and none took the
  // domain. Size, distinctness and a real-marker check were still not a domain subject:
  // the loop below asserts each PINNED token is present and never that the clause names
  // no OTHER token, so dropping a member here and from both size pins stayed green. The
  // domain is now DERIVED from the clause — every backticked span it contains, in order,
  // compared against the pinned list plus the `*` file glob the clause also names.
  const PLACEHOLDER_TOKENS = ['`{{`', '`<!--`', '`<title>`'];
  const FILE_GLOB = '`*`';
  const CLAUSE_SPANS = ['`{{`', '`<!--`', FILE_GLOB, '`<title>`'];
  assert.equal(PLACEHOLDER_TOKENS.length, 3, 'the scaffold self-check greps three placeholder tokens');
  assert.equal(new Set(PLACEHOLDER_TOKENS).size, 3, 'the three placeholder tokens must be distinct');
  assert.deepEqual(CLAUSE_SPANS.filter(span => span !== FILE_GLOB), PLACEHOLDER_TOKENS,
    'the spans expected in the clause and the pinned token list must not drift apart');
  const shippedForTokens = shippedSkillFiles();
  for (const token of PLACEHOLDER_TOKENS) {
    assert.ok(shippedForTokens.some(f => read(f).includes(token.replace(/`/g, ''))),
      token + ': not a marker the shipped skill itself writes, so the grep list has been padded');
  }
  for (const file of selfCheckFiles) {
    const text = selfCheckText(file);
    const from = text.indexOf(bounds[file][0]), to = text.indexOf(bounds[file][1]);
    assert.ok(from !== -1 && to > from, file + ': the self-check paragraph bounds no longer resolve');
    const paragraph = text.slice(from, to);
    // The three tokens and their verdict, in that order, with nothing between them that
    // could drop one. `residualGrep` above admits a comma, so "ignoring `<title>`
    // entirely, and require zero hits" satisfied it while the `<title>` grep was gone.
    const grepAt = paragraph.indexOf('grep the new'), verdictAt = paragraph.indexOf('zero hits');
    assert.ok(grepAt !== -1 && verdictAt > grepAt, file + ': the self-check must grep, then reach a zero-hit verdict');
    const grepClause = paragraph.slice(grepAt, verdictAt);
    for (const token of PLACEHOLDER_TOKENS) {
      assert.ok(grepClause.includes(token),
        file + ': the grep must still name ' + token + ' before its zero-hit verdict — clause reads "' + grepClause + '"');
    }
    // Subject is the DOMAIN, taken from the document: a fourth token, a substituted one,
    // or a token dropped from the pinned list and both size pins together all redden here.
    assert.deepEqual([...grepClause.matchAll(/`[^`]+`/g)].map(span => span[0]), CLAUSE_SPANS,
      file + ': the grep clause must name exactly the pinned tokens and the file glob, in order'
        + ' — clause reads "' + grepClause + '"');
    assert.doesNotMatch(grepClause,
      /\b(?:ignor\w*|skip\w*|exclud\w*|omit\w*|except|without|drop\w*|disregard\w*|no longer|never|not)\b/i,
      file + ': no exclusion verb may stand between the grep and its zero-hit verdict — clause reads "' + grepClause + '"');
    assert.match(paragraph, /zero hits(?:\*\*)?\s*outside fenced and inline code spans/i,
      file + ': the zero-hit verdict must be qualified to hits OUTSIDE fenced and inline code spans');
    assert.doesNotMatch(paragraph, /\binside and outside\b/i,
      file + ': re-including code spans in the verdict is the exact inverse of the exemption');
    // Polarity by counting, not by phrasing: exactly one clause may rule on a hit INSIDE
    // a span, and it must say NOT a slot. Appending "A hit inside a code span is still an
    // unfilled slot." makes this two; inverting the clause makes it zero.
    const insideRulings = paragraph.split(/(?<=[.;])\s+/)
      .filter(clause => /\binside\b[^.;]*code spans?/i.test(clause) && /unfilled slot/i.test(clause));
    assert.equal(insideRulings.length, 1,
      file + ': exactly one clause may rule on a hit inside a code span, found ' + insideRulings.length
        + ' — ' + (insideRulings.join(' || ') || '(none)'));
    assert.match(insideRulings[0], /\bis not an unfilled slot\b/i,
      file + ': the ruling on a hit inside a code span must be that it is NOT an unfilled slot');
  }
});

// BL-016 named two files. SIX occurrences across FIVE documents carry the rule, and two
// of the five — the ledger contract template and the batch template — are what a DRIVING
// session and a PLANNER read, so a rule landing only in the reference docs never reaches
// a ledger at all. `scaffolding.md` states it twice (the planning step and the
// environment interview, the very place `Default when unsure: every step human` lived),
// and an `includes` check is satisfied by either copy, so the domain is a file->count map
// and the assertions are on counts.
test('every document carrying the Runner: default states the same rule, and no default-human spelling survives', () => {
  const RULE = 'A step is human ONLY when it needs something an agent on this machine cannot do: '
    + 'a device, a GUI, held credentials, a judgement about whether something looks right, '
    + 'or something the environment contract forbids an agent here to do';
  // The trailing clause is load-bearing, not padding: the four named grounds are
  // illustrative, and a conductor reading a CLOSED enumeration as controlling would tag a
  // "touches your data" or another-OS step `agent` and hand it to the QA runner against
  // live data. BL-016's list was an example; implementing it as a closed set narrowed a
  // safety rule that the human list one clause away already stated.
  assert.match(RULE, /, or something the environment contract forbids an agent here to do$/,
    'the enumeration must stay open-ended, or it narrows the grounds the human list already names');
  const RUNNER_RULE_COUNTS = {
    'orchestrate/references/execution-models.md': 1,
    'orchestrate/references/protocol.md': 1,
    'orchestrate/references/scaffolding.md': 2,
    'orchestrate/templates/00-READBEFORE.md': 1,
    'orchestrate/templates/02-batch.md': 1
  };
  const carriers = Object.keys(RUNNER_RULE_COUNTS);
  assert.equal(carriers.length, 5, 'BL-016 understated its file set by three: five documents carry the rule');
  assert.equal(Object.values(RUNNER_RULE_COUNTS).reduce((sum, n) => sum + n, 0), 6,
    'five documents, six occurrences — scaffolding.md states the rule in both the planning step and the interview');
  const occurrences = file => collapsed(file).split(RULE).length - 1;
  const shipped = shippedSkillFiles();
  assert.ok(shipped.length > carriers.length, 'the swept listing must be wider than the carrier set');
  for (const file of carriers) {
    assert.ok(shipped.includes(file), file + ': carrier is not in the shipped listing this test sweeps');
    assert.equal(occurrences(file), RUNNER_RULE_COUNTS[file],
      file + ': must state the runner rule verbatim exactly ' + RUNNER_RULE_COUNTS[file]
        + ' time(s) — "' + RULE + '" (whitespace collapsed)');
  }
  // Subject is the DOMAIN: losing one of scaffolding.md's two copies, or a sixth document
  // acquiring the rule, both redden without any member assertion changing.
  const found = Object.fromEntries(shipped.map(file => [file, occurrences(file)]).filter(([, n]) => n > 0));
  assert.equal(Object.keys(found).length, carriers.length,
    'exactly five shipped files may state the runner rule, found: ' + Object.keys(found).join(', '));
  assert.deepEqual(found, RUNNER_RULE_COUNTS);

  // The ONLY-clause is safe only because a sentence beside it says the grounds it does
  // NOT name — another OS, live data, anything "touches your data" — are the
  // contract-forbids kind rather than exceptions to it. The pinned RULE above stops at
  // "…forbids an agent here to do", so that safety half was held by nothing: deleting
  // the back-reference from every carrier, deleting protocol.md's "Steps flagged
  // \"Touches your data\" are human unless…", and deleting 02-batch.md's "live data"
  // were each GREEN. Both halves are now pinned per file, and the back-references in
  // DOCUMENT ORDER, so scaffolding.md cannot lose either of its two.
  const BACK_REFERENCE = {
    'orchestrate/references/execution-models.md': ['That last kind is why the grounds listed above'],
    'orchestrate/references/protocol.md': ['the data and another-OS grounds above are that last kind, not exceptions to this rule.'],
    'orchestrate/references/scaffolding.md': ['the prohibitions just named are that last kind, not exceptions to this rule.',
      'the answers to this question are that last kind, not exceptions to it.'],
    'orchestrate/templates/00-READBEFORE.md': ['the data and another-OS grounds above are that last kind, not exceptions to this rule.'],
    'orchestrate/templates/02-batch.md': ['the live-data and another-OS grounds above are that last kind, not exceptions to this rule.']
  };
  const GROUNDS = {
    'orchestrate/references/execution-models.md': ['another OS, live data', 'unless a disposable environment exists',
      'live data, anything "touches your data" without a disposable environment'],
    'orchestrate/references/protocol.md': ['Steps flagged "Touches your data" are human unless the contract names a disposable fixture environment.'],
    'orchestrate/references/scaffolding.md': ['"touches data" is human unless a disposable environment exists',
      'what must an agent never do (launch the headed app, touch live data)'],
    'orchestrate/templates/00-READBEFORE.md': ['A step flagged "Touches your data" is human unless the runner line names a disposable fixture environment.'],
    'orchestrate/templates/02-batch.md': ['hardware, credentials, feel, another OS, live data',
      'are human unless the contract names a disposable environment']
  };
  assert.deepEqual(Object.keys(BACK_REFERENCE).sort(), carriers.slice().sort());
  assert.deepEqual(Object.keys(GROUNDS).sort(), carriers.slice().sort());
  assert.equal(Object.values(BACK_REFERENCE).reduce((sum, list) => sum + list.length, 0), 6,
    'one pinned back-reference per occurrence of the rule, not per file');
  assert.equal(Object.values(GROUNDS).reduce((sum, list) => sum + list.length, 0), 9,
    'nine pinned grounds across the five carriers: dropping one here and from its document must redden');
  for (const file of carriers) {
    const text = collapsed(file), tails = text.split(RULE).slice(1);
    assert.equal(BACK_REFERENCE[file].length, RUNNER_RULE_COUNTS[file],
      file + ': every occurrence of the rule needs its own pinned back-reference');
    tails.forEach((tail, i) => assert.ok(tail.slice(0, 240).includes(BACK_REFERENCE[file][i]),
      file + ': occurrence ' + (i + 1) + ' of the rule must be followed by the clause re-admitting the grounds it does'
        + ' not name — "' + BACK_REFERENCE[file][i] + '"; the text after it reads "' + tail.slice(0, 240) + '"'));
    for (const ground of GROUNDS[file]) {
      assert.ok(text.includes(ground),
        file + ': the safety ground its back-reference points at is gone — "' + ground + '"');
    }
  }

  // --- the default-human sweep -------------------------------------------------
  // READ THIS BEFORE TRUSTING ITS SILENCE. This is a REGRESSION GUARD, not a detector.
  // It catches the spellings this repository has actually written plus the paraphrases
  // three reviews produced; English has more. A fourth review got sixteen further
  // paraphrases past it, and only some of those are caught now: "If in doubt, the tester
  // runs it" and "When unsure, a person must run the step" are, while "Default:
  // operator", "Any step you cannot place goes by hand", "Steps that are not automatable
  // are the user's" and "When in doubt, you run it yourself" are NOT — the vocabulary
  // they reach for is not carried here, and widening the target to "you" would fire on
  // half the skill. A positive sweep over prose has a floor; this one sits above that
  // floor, not at it. Clauses split on `.` and `;` only, so the colon form ("Default:
  // human.") stays intact. When this is green the documents are free of THESE spellings,
  // and nothing stronger may be read into it. The REGRESSION corpus below, not this
  // pattern list, is the authority on which spellings those are: it is asserted to
  // exercise EVERY pattern and each pattern to own an entry no other pattern catches, so
  // a rewrite that drops or weakens one reddens there rather than only on the control
  // that left with it. The 10->14 rewrite silently lost the `assume` spelling round 1
  // held, while every visible signal — more patterns, more controls, a size pin — said
  // the guard had grown. READ THE REINFORCEMENT FILTER'S OWN NOTE TOO: it names the
  // reversals it still excuses, which are a second and separate reason this sweep's
  // silence means less than it looks like.
  const TARGET = '(?:human|the user|a person|the tester|by hand)';
  // Every entry carries at least one NEGATION-BEARING control ("…, not agent"). Under the
  // clause-wide pre-filter this sweep used to run, all sixteen of those were skipped
  // unexamined: that is the filter being exercised rather than assumed.
  const DEFAULT_HUMAN = [
    // The em-dash and en-dash alternatives are branches no control reached before.
    { name: 'bare default to human', controls: ['Default human.', 'Default is human.', 'Default: human.',
      'Default — human.', 'default to human', 'Default human, not agent.'],
      pattern: new RegExp('\\bdefault(?:s|ed|ing)?\\b\\s*(?:[:\\u2014\\u2013-]\\s*|\\b(?:is|to|be)\\b\\s*)?human\\b', 'i') },
    { name: 'bare default to a person', controls: ['Default: the user.', 'defaults to the user',
      'Default – a person.', 'Default: the tester, not the agent.'],
      pattern: new RegExp('\\bdefault(?:s|ed|ing)?\\b\\s*(?:[:\\u2014\\u2013-]|\\b(?:is|to|be)\\b)\\s*' + TARGET + '\\b', 'i') },
    { name: 'default when unsure', controls: ['Default when unsure: every step human.', 'Default if in doubt',
      'Default when unsure: human, not agent.'],
      pattern: /\bdefault\b[^.;]*\b(?:when|if)\b[^.;]*\b(?:unsure|in doubt|uncertain|unclear|not certain)\b/i },
    { name: 'uncertainty sends it to a person', controls: ['Steps whose runner is unclear go to the user.',
      'When you cannot be certain an agent can do it, mark the step human.', 'If in doubt, the step is human.',
      // One control per alternative the widened target added, or they go untested.
      'If in doubt, the tester runs it.', 'When unsure, a person must run the step.',
      'When unsure, the step is done by hand.',
      // The two negation-carrying alternatives of this pattern were branches no input
      // could reach while any `not` in the clause exempted it.
      'We are not certain an agent can do it, so the step is human.',
      'If you do not know the runner, the step is human.', 'When unsure the step is human, not agent.'],
      pattern: new RegExp('\\b(?:unsure|uncertain|in doubt|cannot be certain|not certain|unclear|ambiguous|do not know)\\b[^.;]*\\b' + TARGET + '\\b', 'i') },
    { name: 'start from a person and downgrade', controls: ['Start from human and downgrade to agent once a runner is confirmed.',
      'Begin with the user and promote to agent later.', 'Start from human, not agent.'],
      pattern: new RegExp('\\b(?:start|starts|starting|begin|begins|beginning)\\b[^.;]*\\b(?:from|with|as|at)\\b[^.;]*\\b' + TARGET + '\\b', 'i') },
    { name: 'by default, either order', controls: ['Steps are human by default.', 'By default the user runs them.',
      'Steps are human by default, not agent.'],
      pattern: new RegExp('\\bby default\\b[^.;]*\\b' + TARGET + '\\b|\\b' + TARGET + '\\b[^.;]*\\bby default\\b', 'i') },
    { name: 'every or all steps', controls: ['every step human', 'all steps go to the user',
      // Round 2 stopped crying wolf and stopped catching modals with it.
      'Every step must be human.', 'All steps should go to the user.', 'Each step is always human.',
      'Every step is human, not agent.'],
      // The gap here is a whitelist of connectors, not `[^.;]*`: an open gap also matched
      // "what every step in that section asks the user to test" in build-smoke-page.mjs,
      // and a sweep that cries wolf gets deleted by the next author. The modal verbs were
      // added without reopening it — that false positive is a control below.
      pattern: new RegExp('\\b(?:every|all|each)\\s+steps?\\b(?:\\s+(?:is|are|be|to|go|goes|stay|stays|remain|remains|become|becomes|marked|tagged|assigned|as|a|an|the|must|should|shall|will|always|therefore|then|only))*\\s+' + TARGET + '\\b', 'i') },
    { name: 'err, prefer or lean toward', controls: ['err on the side of human', 'prefer the user here', 'lean toward human',
      'Err toward human, not agent.'],
      pattern: new RegExp('\\b(?:err|prefer|prefers|favour|favours|favor|favors|lean|leans|leaning|bias|biased)\\b[^.;]*\\b' + TARGET + '\\b', 'i') },
    { name: 'fall back to a person', controls: ['fall back to human', 'the fallback is the user',
      'Fall back to human, not agent.'],
      pattern: new RegExp('\\bfalls?[\\s-]*back\\b[^.;]*\\b' + TARGET + '\\b|\\bfallback\\b[^.;]*\\b' + TARGET + '\\b', 'i') },
    { name: 'no test, therefore a person', controls: ['no test can prove it, so the step is human',
      'no fixture covers it, therefore the user runs it', 'no test can prove it, so the step is human, not agent'],
      pattern: new RegExp('\\bno (?:test|fixture)\\b[^.;]*\\b(?:so|therefore|hence|thus|which means)\\b[^.;]*\\b' + TARGET + '\\b', 'i') },
    { name: 'safer or more conservative', controls: ['it is safer to make the step human', 'the conservative choice is the user',
      'it is safer to make the step human, not agent'],
      pattern: new RegExp('\\b(?:safer|safest|conservative|conservatively|cautious|prudent)\\b[^.;]*\\b' + TARGET + '\\b', 'i') },
    { name: 'human unless proven agent', controls: ['human unless proven agent-runnable', 'the user unless confirmed agent-runnable',
      'human unless proven agent-runnable, not the other way round'],
      pattern: /\bunless\b[^.;]*\b(?:proven|demonstrated|confirmed|verified|established)\b[^.;]*\bagent\b/i },
    // The gap is three words, not `[^.;]*`: an open gap matched build-smoke-page.mjs's
    // "the page hands // the dangling reference to the tester", which hands a REFERENCE
    // to a person, not a step. That line is a false-positive control below.
    { name: 'hand the work to the user', controls: ['hand the step to the user when unsure', 'defer it to the user',
      'hand the step to the user, not the agent'],
      pattern: new RegExp('\\b(?:hand|hands|handing|give|gives|assign|assigns|push|pushes|defer|defers)\\b(?:\\s+\\S+){0,3}\\s+to ' + TARGET + '\\b', 'i') },
    { name: 'the user does the running', controls: ['the user executes the steps', 'the user performs every smoke step',
      'the user executes the steps, not the agent'],
      pattern: new RegExp('\\b' + TARGET + '\\b[^.;]*\\b(?:executes|performs|runs|carries out)\\b[^.;]*\\bsteps?\\b', 'i') },
    // The pattern the 10->14 rewrite dropped. Round 1 held `/assume[sd]?\s+human/i`;
    // "Assume human until a runner is named." and "Unplaced steps are assumed human."
    // both swept clean through the fourteen that replaced it.
    { name: 'assume a person', controls: ['Assume human until a runner is named.', 'Steps are assumed the user.',
      'Unplaced steps are assumed human.', 'Assume human, not agent.'],
      pattern: new RegExp('\\bassum\\w*\\b[^.;]*\\b' + TARGET + '\\b', 'i') },
    // "Mark unplaced steps human." is a natural way to write the reversal and nothing
    // caught it. The broad form of this pattern (`[^.;]*` between verb and target) fires
    // on EIGHT places in this checkout, including execution-models.md's own "Tag every
    // smoke step `Runner: agent`…" and subagent-prompts.md's correct "leave native-app
    // steps human if no runner"; requiring a determiner and `steps?` directly after the
    // verb keeps all eight clean. Both are false-positive controls below.
    { name: 'mark the steps a person', controls: ['Mark unplaced steps human.', 'Mark the step human.',
      'Treat every step as human.', 'Leave the remaining steps human.', 'Mark the step human, not agent.'],
      pattern: new RegExp('\\b(?:mark|marks|leave|leaves|tag|tags|treat|treats)\\s+(?:the|every|each|all|any)?\\s*'
        + '(?:unplaced|remaining|unassigned|untagged|other)?\\s*steps?\\b\\s*(?:as\\s+)?' + TARGET + '\\b', 'i') }
  ];
  // The pre-filter used to skip any clause containing `not`/`never`/`nothing` — 570 of
  // this checkout's 3,887 clauses, 14.7%, in front of every pattern — so "Default when
  // unsure: every step human, not agent." passed, and `not certain` / `do not know`
  // inside the patterns above were branches no input could reach. It now applies to the
  // MATCH rather than the clause: a negation counts as reinforcement only inside the
  // matched phrase or within six words before it. (The reviewer's literal form, a
  // negation adjacent to the TARGET, reddens on execution-models.md's "…is never a
  // reason to hand a step to the user", where the negation is adjacent to the verb and
  // not to the target; REINFORCEMENTS below pins that clause and two more.) `not` is not
  // a negation when it is the patterns' own vocabulary — "not certain", "do not know" —
  // or those alternatives go dead again. The look-back stops at the nearest `,` `:` or
  // dash, because a negation in the PRECEDING phrase does not reinforce this one: that
  // alone recovers "When the runner is not obvious, default human.", "Never guess the
  // runner, default human.", "This is not optional: default human.", "Rather than guess,
  // default human." and "Nothing else applies, so default human.", every one of which
  // this sweep excused a round ago.
  // WHAT IT STILL EXCUSES, so its silence is not over-read: a reversal whose negation
  // sits in the SAME phrase within six words of the match — "The runner is not known and
  // so the default is human." passes — and, structurally, `exec` returns only the FIRST
  // match of a pattern in a clause, so an exempted first match hides a later
  // contradiction by the same pattern in that clause. No clause in this checkout does
  // that today. Narrowing the window to two words was measured and REJECTED: it unexempts
  // execution-models.md's own "…is never a reason to hand a step to the user" (the
  // negation is five words off) and reddens the file sweep on correct prose.
  const NEGATION = /\b(?:never|nor|neither|nothing|no longer|rather than|instead of)\b|\bnot\b(?!\s+(?:certain|know)\b)/i;
  const PHRASE = /[,:—–]/;
  const reinforcement = (clause, match) => {
    if (NEGATION.test(match[0])) return true;
    const phrases = clause.slice(0, match.index).split(PHRASE);
    return NEGATION.test(phrases[phrases.length - 1].trim().split(/\s+/).slice(-6).join(' '));
  };
  const flagClauses = text => text.split(/(?<=[.;])\s+/).flatMap(clause =>
    DEFAULT_HUMAN.filter(({ pattern }) => {
      const match = pattern.exec(clause);
      return match !== null && !reinforcement(clause, match);
    }).map(({ name }) => name + ' :: ' + clause.trim()));
  // Signature 1, twice over, is what a `.some()` control invites: one armed pattern makes
  // the whole family look alive, and nine dead ones sweep clean over anything. Every
  // pattern is armed through the SAME code path the sweep runs, and both array sizes are
  // pinned so a silently dropped member is caught. The control total counts DISTINCT
  // strings: replacing one pattern's four controls with four copies of a fifth satisfied
  // a plain sum of lengths and silently retired the colon and em-dash forms.
  assert.equal(DEFAULT_HUMAN.length, 16, 'the default-human family must keep all sixteen patterns');
  assert.equal(new Set(DEFAULT_HUMAN.map(entry => entry.name)).size, 16, 'pattern names must be distinct');
  const CONTROLS = DEFAULT_HUMAN.flatMap(entry => entry.controls);
  assert.equal(new Set(CONTROLS).size, CONTROLS.length, 'no control string may be repeated to pad the total');
  assert.equal(new Set(CONTROLS).size, 65, 'the control corpus must keep all sixty-five distinct strings');
  for (const { name, pattern, controls } of DEFAULT_HUMAN) {
    assert.ok(controls.length >= 3, name + ': every pattern needs at least three control strings');
    assert.ok(controls.some(control => /\b(?:not|never)\b/i.test(control)),
      name + ': needs a negation-bearing control, or the reinforcement filter in front of it is untested');
    for (const control of controls) {
      assert.match(control, pattern, name + ': its own control no longer matches it — "' + control + '"');
      assert.ok(flagClauses(control).some(hit => hit.startsWith(name + ' :: ')),
        name + ': the sweep as actually run does not flag its own control — "' + control + '"');
    }
  }
  // The false positives each narrowing was bought with. A sweep that cries wolf gets
  // deleted by the next author, so these are pinned as strings rather than left to the
  // file sweep, which would go quiet if the prose were reworded: the connector whitelist
  // (round 2), the three-word gap on `hand` and the determiner on `mark|tag|treat`.
  const NEVER_FLAGGED = ['what every step in that section asks the user to test',
    'the page hands // the dangling reference to the tester as an instruction.',
    'Tag every smoke step `Runner: agent` or `Runner: human`.',
    'leave native-app steps human if no runner.'];
  assert.equal(NEVER_FLAGGED.length, 4, 'every narrowing keeps the false positive that bought it');
  for (const clean of NEVER_FLAGGED) {
    assert.deepEqual(flagClauses(clean), [],
      'a narrowing has been reopened: this is correct prose, not a runner default — "' + clean + '"');
  }
  // A live control for the filter itself: each of these MATCHES a pattern and must be
  // silenced by the reinforcement rule, so "nothing was flagged" means the filter ran
  // rather than that nothing could reach it.
  const REINFORCEMENTS = ['Never hand a step to the user.',
    'so "no test could prove it" is never a reason to hand a step to the user.',
    'the user tests at checkpoints, never per batch or per wave by default.'];
  assert.equal(REINFORCEMENTS.length, 3, 'all three reinforcement controls must stay');
  // "this checkout's own prose" was a comment, held by nothing, and would have gone
  // quietly false on any rewording. The first string is invented; these two are not.
  for (const real of REINFORCEMENTS.slice(1)) {
    assert.ok(collapsed('orchestrate/references/execution-models.md').includes(real),
      'this reinforcement is no longer execution-models.md\'s own prose — "' + real + '"');
  }
  // The other side of the same filter, and what holds the phrase bound in place: each of
  // these is a GENUINE reversal carrying a negation in the phrase BEFORE the match, and
  // every one was excused while the look-back ran past the comma. Unbind it and they go
  // silent again — which makes the bound a tested property rather than a comment.
  const RECOVERED = ['When the runner is not obvious, default human.',
    'Never guess the runner, default human.',
    'This is not optional: default human.',
    'Rather than guess, default human.',
    'Nothing else applies, so default human.'];
  assert.equal(RECOVERED.length, 5, 'all five recovered reversals must stay');
  assert.equal(new Set(RECOVERED).size, 5, 'the recovered reversals must be distinct');
  for (const recovered of RECOVERED) {
    assert.ok(/\b(?:not|never|nothing|rather than)\b/i.test(recovered),
      'a recovered reversal carrying no negation tests nothing — "' + recovered + '"');
    assert.ok(flagClauses(recovered).length > 0,
      'the reinforcement filter is excusing a genuine reversal again — "' + recovered + '"');
  }
  for (const reinforced of REINFORCEMENTS) {
    assert.ok(DEFAULT_HUMAN.some(({ pattern }) => pattern.test(reinforced)),
      'no pattern matches this reinforcement at all, so exempting it proves nothing — "' + reinforced + '"');
    assert.deepEqual(flagClauses(reinforced), [],
      'a reinforcement of the rule must not be flagged as a contradiction — "' + reinforced + '"');
  }
  // THE COVERAGE AUTHORITY. Spellings this repository really wrote, the paraphrases the
  // reviews inserted into protocol.md's runner paragraph while an earlier version of this
  // sweep stayed green, and one entry per pattern. It is written INDEPENDENTLY of the
  // pattern list and its size is pinned, so a rewrite cannot shrink coverage while
  // growing every visible signal: drop a pattern and its corpus entries go unflagged;
  // weaken one and the entry it used to catch goes unflagged; delete an entry and the
  // size pin reddens. The 10->14 rewrite, which lost the `assume` family, would have
  // failed here instead of passing with more patterns than before.
  const REGRESSION = ['environment. Default human. At close-out',
    'fixture environment. Default is human. Before',
    'prohibitions (default human; "touches data" is human',
    'touch live data)? Default when unsure: every step human.',
    'Default: human.',
    'Default: the tester.',
    // `default when unsure` owned no EXCLUSIVE entry: its one entry was also caught by
    // two other patterns, so deleting that pattern, its entry and its pins balanced the
    // set-equality below and went green while "Default if in doubt." went silent.
    'Default if in doubt.',
    'Steps whose runner is unclear go to the user.',
    'When you cannot be certain an agent can do it, mark the step human.',
    'If in doubt, the tester runs it.',
    'When unsure, a person must run the step.',
    'Start from human and downgrade to agent once a runner is confirmed.',
    'Steps are human by default.',
    'Every step must be human.',
    'All steps should go to the user.',
    'Each step is always human.',
    'Err on the side of human.',
    'Fall back to human.',
    'No test can prove it, so the step is human.',
    'It is safer to make the step human.',
    'A step stays human unless proven agent-runnable.',
    'Hand the step to the user.',
    'The user executes the steps at the checkpoint.',
    'Assume human until a runner is named.',
    'Unplaced steps are assumed human.',
    'Mark unplaced steps human.'];
  assert.equal(REGRESSION.length, 26, 'the regression corpus must keep all twenty-six spellings');
  assert.equal(new Set(REGRESSION).size, 26, 'the regression corpus must not repeat a spelling to pad its size');
  for (const regression of REGRESSION) {
    assert.ok(flagClauses(regression).length > 0, 'the sweep no longer catches: "' + regression + '"');
  }
  // Subject is the DOMAIN: the corpus must exercise every pattern and name no pattern the
  // family has lost, so neither list can move without the other.
  assert.deepEqual([...new Set(REGRESSION.flatMap(regression =>
    flagClauses(regression).map(hit => hit.split(' :: ')[0])))].sort(),
  DEFAULT_HUMAN.map(entry => entry.name).slice().sort(),
  'every pattern must be exercised by the regression corpus, and the corpus may name no pattern the family has dropped');
  // …and set equality alone protected only fifteen of sixteen, because deleting a pattern
  // removes its name from BOTH sides at once and only bites when an entry goes unflagged.
  // EXCLUSIVITY is the property that makes the authority whole: every pattern must own a
  // corpus entry that NO other pattern flags, so deleting the pattern, its entry and its
  // pins together always leaves some other entry uncaught.
  for (const { name } of DEFAULT_HUMAN) {
    const exclusive = REGRESSION.filter(regression => {
      const hits = flagClauses(regression).map(hit => hit.split(' :: ')[0]);
      return hits.length === 1 && hits[0] === name;
    });
    assert.ok(exclusive.length > 0,
      name + ': no regression entry is caught by this pattern ALONE, so deleting it balances the set'
        + ' equality above and its real coverage goes silent — add a spelling only it catches');
  }
  for (const file of shipped) {
    const flagged = flagClauses(collapsed(file));
    assert.equal(flagged.length, 0, file + ': a blanket human default contradicts the runner rule — ' + flagged.join(' || '));
  }
  // The rest of BL-016: why the old default was wrong, and what a checkpoint costs.
  const models = collapsed('orchestrate/references/execution-models.md');
  assert.match(models, /fixtures are isolated from the real machine by design and a subagent is not/i,
    'execution-models.md must say why "no test can verify this" is not "no agent can verify this"');
  assert.match(models, /checkpoint asks the user for a VERDICT, not for labour/,
    'execution-models.md must say a checkpoint asks for a verdict, not for labour');
});

// ===== BL-023: the post-render proofing pass, wired ==========================
// `smoke-page.md` DEFINED a pass that proofs the built page — every embedded command run
// out of the page's own bytes, after the page exists and before the STOP — and nothing
// outside that file invoked it, so no checkpoint ever ran it except by hand. The property
// pinned below is deliberately not "these documents mention it": it is that EVERY shipped
// document stating the checkpoint close-out sequence also names the pass, swept out of the
// checkout rather than compared against a hand-written file list.
//
// The reason that distinction is load-bearing, recorded here as the known gap it is. The
// close-out sequence is stated FIVE times, not three, and two of those five were fenced
// away from the batch that wired the other three: `execution-models.md` step 5 of its wave
// loop ("STOP with the combined smoke script, delivered as the smoke page") and `SKILL.md`
// mode `continue` step 3, which wraps the same phrase across a line break and so does not
// show up in a naive grep for it at all. Both still hand over without naming the pass. A
// deepEqual over the wired files would have frozen those two omissions into the suite and
// made wiring them later look like a regression. KNOWN_UNWIRED therefore says a carrier MAY
// lack the pass, never that it must: the day either file names it, this test stays green
// with nothing here to edit, and the day a further document states the close-out without
// naming the pass, it reddens.
test('every document stating the checkpoint close-out also invokes the post-render proofing pass', () => {
  // Built fresh per use: a /g/ regex carries `lastIndex` between calls, and one shared
  // object silently skips every other match.
  const CLOSE_OUT = () => /combined smoke script/gi;   // the phrase every close-out ends on
  // The pass's own imperative in `smoke-page.md`, which is what a reader greps for and
  // what the wired documents repeat. If the defining document ever renames the pass, every
  // pointer written into the other carriers dangles — and this is what says so.
  const NAMES_PASS = () => /proofs? the published artifact/gi;
  // The definition is not an invocation. `smoke-page.md` DEFINES the pass 9.5 KB away from
  // its own mention of the close-out, so the region rule below cannot apply to it; it is
  // held to carrying the definition instead, and to being the only file that does.
  const DEFINES_PASS = /an ADDED pass, after the page is built/;
  const KNOWN_UNWIRED = ['orchestrate/SKILL.md', 'orchestrate/references/execution-models.md'];
  const shipped = shippedSkillFiles();
  const carriers = shipped.filter(file => CLOSE_OUT().test(collapsed(file)));
  // Written independently of the pattern, so that weakening the marker and dropping a
  // member in one edit still reddens. Membership, not set equality: a SIXTH carrier is
  // allowed and simply has to satisfy the property below.
  // Four since B01 of OS-20260925: the contract template's copy of the close-out moved to
  // protocol.md, which is wired below, and the template now states none (asserted next).
  const STATED_IN = ['orchestrate/SKILL.md', 'orchestrate/references/execution-models.md',
    'orchestrate/references/protocol.md', 'orchestrate/references/smoke-page.md'];
  assert.equal(STATED_IN.length, 4,
    'four shipped documents state the close-out sequence; this list may not shrink to a sample');
  assert.ok(!carriers.includes('orchestrate/templates/00-READBEFORE.md'),
    'the contract template states the close-out again: it is protocol.md\'s, and a copy here must be wired or removed');
  assert.equal(new Set(STATED_IN).size, STATED_IN.length, 'no document may be listed twice to pad that size');
  for (const file of STATED_IN) {
    assert.ok(carriers.includes(file),
      file + ': no longer matches the close-out marker this sweep selects on, so the sweep has stopped seeing it');
  }
  assert.ok(carriers.length < shipped.length,
    'the close-out marker now selects every shipped file, so selecting on it proves nothing');
  // Bounded on the direction that WEAKENS the guard only. Pinning equality made the
  // cleanup edit — wiring SKILL.md and retiring its exemption — fail with a message
  // describing the opposite edit.
  assert.ok(KNOWN_UNWIRED.length <= 2,
    'a THIRD carrier has been excused from the property; retiring an exemption is free, adding one is a decision');
  assert.equal(new Set(KNOWN_UNWIRED).size, KNOWN_UNWIRED.length,
    'a repeated exemption inflates the bound above while excusing nothing new');
  const definers = shipped.filter(file => DEFINES_PASS.test(collapsed(file)));
  assert.deepEqual(definers, ['orchestrate/references/smoke-page.md'],
    'the pass must be DEFINED in exactly one shipped file — a second copy of the definition is a fork, not an invocation');
  const wired = carriers.filter(file => !KNOWN_UNWIRED.includes(file) && !definers.includes(file));
  // Not entailed by anything above, and the hole that dropping the three arithmetic
  // assertions here would otherwise leave: an exemption SWAPPED rather than added keeps
  // the bound at two and every count intact while halving what the property covers. These
  // were wired deliberately and may never be excused. (The dropped assertions —
  // `carriers.length >= STATED_IN.length`, `wired.length === carriers.length -
  // KNOWN_UNWIRED.length` and `wired.length >= 3` — were each entailed by the membership
  // loop above, so none could ever be the first to go red.)
  const MUST_STAY_WIRED = ['orchestrate/references/protocol.md'];
  for (const file of MUST_STAY_WIRED) {
    assert.ok(wired.includes(file),
      file + ': this batch wired it, and it has been excused or reclassified rather than fixed');
  }

  // The INVOCATION must sit at the close-out, not anywhere in a 57 KB file. Matching the
  // whole document let an ancestry mention two paragraphs from the top — "BL-017 once
  // added a pass that proofs the published artifact" — satisfy a test whose own message
  // says the close-out invokes it, which is precisely the invocation/ancestry confusion
  // this batch exists to fix. 500 characters of collapsed text is roughly six wrapped
  // lines either side: the two wired invocations sit 246 and 385 characters from their
  // marker, and no window up to 800 produces a false positive in any carrier, so the bound
  // is neither accidental nor tight.
  const WINDOW = 500;
  const windows = (text, pattern) => [...text.matchAll(pattern)]
    .map(m => text.slice(Math.max(0, m.index - WINDOW), m.index + WINDOW));
  // Armed in both directions on synthetic text, through the same helper the files go
  // through, so neither verdict below is a shape that could only ever come out one way.
  const ANCESTRY_ONLY = 'Historical note: BL-017 once added a pass that proofs the published artifact. '
    + 'filler. '.repeat(250) + 'commit on the integration branch, STOP with the combined smoke script.';
  assert.ok(!windows(ANCESTRY_ONLY, CLOSE_OUT()).some(region => NAMES_PASS().test(region)),
    'a mention far from the close-out still satisfies the property, so the window bounds nothing');
  const WIRED_SHAPE = 'then proof the published artifact per smoke-page.md, '
    + 'commit on the integration branch, STOP with the combined smoke script.';
  assert.ok(windows(WIRED_SHAPE, CLOSE_OUT()).some(region => NAMES_PASS().test(region)),
    'the property rejects a close-out that DOES invoke the pass beside it');
  for (const file of wired) {
    assert.ok(windows(collapsed(file), CLOSE_OUT()).some(region => NAMES_PASS().test(region)),
      file + ': states the checkpoint close-out but invokes the post-render proofing pass nowhere near it — a rule'
        + ' nothing invokes never fires; name the pass AT the close-out, or record the file in KNOWN_UNWIRED');
  }

  // --- directives that undo the pass ------------------------------------------
  // Positive matches on prose are defeated by an APPENDED sentence. Selecting only clauses
  // that RE-NAME the pass swept up the undoing an author is least likely to write: "This
  // step is optional when the pre-smoke passed", appended to the close-out, named nothing
  // and sailed through. Two scopes now.
  //   region — undoes an obligation whatever its subject, so it is run over every window
  //            around a close-out statement or a naming of the pass, in EVERY carrier
  //            including the exempt ones and the definer.
  //   clause — needs the pass as its subject. The definer's own correct prose contrasts
  //            the two timings ("the QA runner's pre-verification happens before the page
  //            exists"), and a region sweep for the re-timing pattern flags that, so it is
  //            bound to a clause that is about the pass.
  const ABOUT = /proofs? the published artifact|proofing pass|artifact proofer|re-proofed/i;
  const CONTRADICTIONS = [
    { name: 'optional or skippable', scope: 'region',
      pattern: /\b(?:optional|skippable|may be (?:skipped|omitted)|can be skipped|if time (?:allows|permits))\b/i },
    { name: 'left to discretion', scope: 'region',
      pattern: /\b(?:need not|does not have to|at (?:the orchestrator['’]s|your) discretion|when you have time)\b/i },
    { name: 'folded back into the pre-smoke', scope: 'region',
      pattern: /\b(?:replaces|instead of|in place of)\b[^.;]*\b(?:pre-smoke|QA runner|proofing pass|artifact proofer)\b/i },
    { name: 'moved before the page exists', scope: 'clause',
      pattern: /\bbefore the page (?:is built|exists|is generated)\b/i },
  ];
  // The clause boundary swallows the markdown emphasis that closes a sentence. Splitting
  // on `(?<=[.;])\s+` alone left `smoke-page.md`'s definition — which ends `…after the
  // page is built.**` — glued to the NEXT sentence, and the re-timing pattern flagged the
  // pass for correct prose about the runner. A sweep that cries wolf gets deleted by the
  // next author, so the narrowing and the false positive it was bought with are pinned.
  const clauses = text => text.split(/(?<=[.;])[\s*]+/).filter(clause => ABOUT.test(clause));
  const undoings = text => [...new Set([
    ...[...windows(text, CLOSE_OUT()), ...windows(text, NAMES_PASS())].flatMap(region =>
      CONTRADICTIONS.filter(e => e.scope === 'region' && e.pattern.test(region))
        .map(e => e.name + ' :: ' + region.match(e.pattern)[0])),
    ...clauses(text).flatMap(clause =>
      CONTRADICTIONS.filter(e => e.pattern.test(clause)).map(e => e.name + ' :: ' + clause.trim())),
  ])];
  const names = text => [...new Set(undoings(text).map(hit => hit.split(' :: ')[0]))].sort();
  // THE COVERAGE AUTHORITY. Sentences an author would actually append to undo this rule,
  // written as prose rather than read off the alternations, with its size pinned. Its
  // predecessor was three controls derived one-per-pattern from the patterns themselves:
  // narrowing `optional|skippable|may be skipped|may be omitted|can be skipped` to bare
  // `optional` dropped four spellings while the family size, the triggered-name set and
  // every control stayed identical.
  const UNDOINGS = ['The proofing pass is optional.',
    'The proofing pass is skippable once the runner is green.',
    'The proofing pass may be skipped when the pre-smoke passed.',
    'The proofing pass may be omitted on a re-issue.',
    'The proofing pass can be skipped when nothing changed.',
    'Run the proofing pass if time allows.',
    'Run the proofing pass if time permits.',
    'The proofing pass need not run on a re-issue.',
    'The proofing pass does not have to run when the page is unchanged.',
    "Run the proofing pass at the orchestrator's discretion.",
    'Run the proofing pass when you have time.',
    'The proofing pass replaces the QA runner.',
    'Proof the published artifact instead of the pre-smoke.',
    'The proofing pass runs in place of the QA runner.',
    'Proof the published artifact before the page is built.',
    'The proofing pass runs before the page exists.',
    'Proof the published artifact before the page is generated.'];
  assert.equal(UNDOINGS.length, 17, 'the undoing corpus must keep all seventeen spellings');
  assert.equal(new Set(UNDOINGS).size, 17, 'the corpus must not repeat a spelling to pad its size');
  for (const undoing of UNDOINGS) {
    assert.ok(undoings(undoing).length > 0, 'the sweep no longer catches: "' + undoing + '"');
  }
  // Subject is the DOMAIN: the corpus must exercise every family and may name none the
  // list has lost, so neither can move without the other.
  assert.deepEqual([...new Set(UNDOINGS.flatMap(names))].sort(),
    CONTRADICTIONS.map(entry => entry.name).slice().sort(),
    'every contradiction family must be exercised by the corpus, and the corpus may name none it has dropped');
  // …and set equality alone protects only n-1 of n, because deleting a family removes its
  // name from BOTH sides at once. EXCLUSIVITY is what makes the corpus an authority: each
  // family must own an entry NO other family flags.
  for (const { name } of CONTRADICTIONS) {
    assert.ok(UNDOINGS.some(undoing => { const hit = names(undoing); return hit.length === 1 && hit[0] === name; }),
      name + ': no corpus entry is caught by this family ALONE, so deleting it balances the set equality above');
  }
  // The REGION path armed independently of the clause path: this text names nothing ABOUT
  // would select, so only the window around the close-out can flag it.
  const REGION_ONLY = 'commit on the integration branch, STOP with the combined smoke script.'
    + ' This step is optional when the pre-smoke passed.';
  assert.deepEqual(clauses(REGION_ONLY), [],
    'the clause path must not be what catches this, or the region path is never tested');
  assert.deepEqual(names(REGION_ONLY), ['optional or skippable'],
    'an undoing appended to the close-out that never names the pass must still be caught');
  const EMPHASIS_BOUNDARY = '**Proof the published artifact — an ADDED pass, after the page is built.**'
    + " The QA runner's pre-verification happens before the page exists and proves the steps, not the bytes"
    + ' the reader receives;';
  assert.equal(EMPHASIS_BOUNDARY.split(/(?<=[.;])[\s*]+/).length, 2,
    'a sentence boundary closed by markdown emphasis must produce TWO raw clauses; under a plain \\s+ split it'
      + ' produces one, and the next sentence is swept as though it were about the pass');
  assert.deepEqual(undoings(EMPHASIS_BOUNDARY), [],
    'the narrowing has been reopened: this is correct prose about the PRE-smoke, not a re-timing of the pass');
  assert.ok(collapsed('orchestrate/references/smoke-page.md').includes(EMPHASIS_BOUNDARY),
    'this false positive is no longer smoke-page.md\'s own prose — re-derive it before trusting the narrowing');
  for (const file of [...wired, ...definers]) {
    assert.ok(clauses(collapsed(file)).length > 0,
      file + ': the clause path selected nothing here, so its half of the silence is about nothing');
  }
  for (const file of carriers) {
    assert.deepEqual(undoings(collapsed(file)), [],
      file + ': a directive at the close-out, beside the pass, or in a clause about it undoes the pass');
  }
});

// ===== C1 follow-up: the proofing pass must read the RENDERED DOM =============
// C1's QA runner ran the proofing pass for real and found the gap: the step blocks it
// proofs render CLIENT-SIDE from the embedded SECTIONS_JS JSON, so a static read of the
// file text — a grep, or a plain Read — sees only the gate's blocks and reports a false
// clean over the rest. The domain here is swept from the checkout, not hand-listed: every
// shipped file that carries the OPERATIONAL instruction to read a block's `textContent`
// (as opposed to protocol.md/00-READBEFORE.md, which only point at smoke-page.md), so a
// third document that later grows this instruction is covered without editing this test.
test('every document instructing a block read from the artifact also requires the rendered DOM', () => {
  const TEXTCONTENT_MARKER = "block's `textContent`";
  const shipped = shippedSkillFiles();
  const operational = shipped.filter(file => collapsed(file).includes(TEXTCONTENT_MARKER));
  // Written independently of the marker: losing a true carrier and dropping it from this
  // list together still reddens, because MUST_INCLUDE membership is checked separately.
  const MUST_INCLUDE = ['orchestrate/references/smoke-page.md', 'orchestrate/references/subagent-prompts.md'];
  assert.ok(operational.length >= MUST_INCLUDE.length,
    'the operational-instruction sweep must find at least the two known carriers, found: ' + operational.join(', '));
  for (const file of MUST_INCLUDE) {
    assert.ok(operational.includes(file),
      file + ': no longer carries the operational block-read instruction this sweep selects on');
  }

  const DOM_MARKER = /RENDERED DOM/;
  const REASON = 'the step blocks render client-side from the embedded `SECTIONS_JS` JSON, so a static read';
  const PROHIBITION = 'never the file text';
  const WINDOW = 400;
  // Every occurrence, not the first: a second block-read instruction grown later (a
  // re-issue proofer, a second skeleton) must carry the same requirement too, or a guard
  // that only samples `indexOf`'s first hit applauds its own defect. The subject asserted
  // per file is the whole occurrence set, not one sample of it.
  function occurrencesOf(text) {
    const at = [];
    let i = -1;
    while ((i = text.indexOf(TEXTCONTENT_MARKER, i + 1)) !== -1) at.push(i);
    return at;
  }
  function checkFile(text, label) {
    const at = occurrencesOf(text);
    assert.ok(at.length > 0, label + ': marker vanished between the sweep and the check');
    at.forEach((index, n) => {
      const region = text.slice(Math.max(0, index - WINDOW), index + WINDOW);
      assert.match(region, DOM_MARKER,
        label + ': occurrence ' + (n + 1) + ' of ' + at.length + ' block-read instructions must require the RENDERED DOM nearby');
      assert.ok(region.includes(REASON),
        label + ': occurrence ' + (n + 1) + ' of ' + at.length + ' must carry the reason clause nearby — "' + REASON + '"');
      assert.ok(region.includes(PROHIBITION),
        label + ': occurrence ' + (n + 1) + ' of ' + at.length + ' must carry the prohibition nearby — "' + PROHIBITION + '"');
    });
    return at.length;
  }
  for (const file of operational) checkFile(collapsed(file), file);

  // Armed: a SECOND block-read instruction, appended far enough away that its own window
  // carries none of the first one's text, must still fail this property on its own even
  // though the first occurrence is correct — the exact shape the gate demonstrated by
  // appending an ungoverned second section to subagent-prompts.md. `FIRST_OK` alone must
  // still pass, so the control isn't failing for some unrelated reason.
  const FIRST_OK = "Open the page in a browser and read every block's `textContent` from the "
    + 'RENDERED DOM, never the file text — ' + REASON + ' finds only a subset.';
  const FILLER = ' filler '.repeat(150);
  const SECOND_BAD = "Open the page file and read every block's `textContent` with a grep, then run those bytes.";
  assert.throws(() => checkFile(FIRST_OK + FILLER + SECOND_BAD, 'two-occurrence control'),
    /occurrence 2 of 2/, 'a second, unguarded block-read instruction must fail the sweep even though the first one is correct');
  assert.doesNotThrow(() => checkFile(FIRST_OK, 'single-occurrence control'),
    'the single correct occurrence must still pass on its own');

  // --- the static-read/file-text/grep downgrade, licensed by if/when/unless/or --------
  // Demonstrated: rewriting the prohibition itself ("never the file text") is caught by
  // PROHIBITION above, but a downgrade can also be ADDED beside it without touching that
  // clause at all — "…RENDERED DOM, or the file text when no browser is at hand" — which
  // restores the false-clean route in full. Scanning is CLAUSE-scoped: this document's own
  // correct prose reads "a static read or grep of the file finds only the gate's blocks"
  // in the very same sentence as the requirement, so a bare "or…grep" alternation would
  // flag the fix's own prose. BEFORE only admits "file text" as the licensed target (never
  // "or grep", which the correct prose contains verbatim); AFTER admits all three nouns
  // but only when if/when/unless follows within a few words, which none of this document's
  // own prose does today — both measured empirically against the real files, not assumed.
  const LICENSE_BEFORE = /\b(?:or|if|when|unless)\b(?:\s+\S+){0,2}\s+(?:the\s+)?file text\b/i;
  const LICENSE_AFTER = /\b(?:file text|grep|static read)\b(?:\s+\S+){0,4}\s+\b(?:if|when|unless)\b/i;
  const DOWNGRADE_ABOUT = /\bfile text\b|\bgrep\b|\bstatic read\b/i;
  const splitClauses = text => text.split(/(?<=[.;])[\s*]+/).filter(clause => DOWNGRADE_ABOUT.test(clause));
  const isDowngrade = clause => LICENSE_BEFORE.test(clause) || LICENSE_AFTER.test(clause);

  // THE COVERAGE AUTHORITY: prose an author would actually append to license the
  // downgrade, written independently of the patterns above.
  const DOWNGRADE_CORPUS = ['Read the RENDERED DOM, or the file text when no browser is at hand.',
    'Grep the file text if no browser is available.',
    'The file text is an acceptable substitute unless a browser can render the page.',
    'Grep the file text when no browser is at hand instead.',
    'Fall back to the file text if the RENDERED DOM cannot be reached.',
    'A static read is acceptable when the rendered DOM cannot be produced.'];
  for (const undoing of DOWNGRADE_CORPUS) {
    assert.ok(isDowngrade(undoing), 'the sweep no longer catches: "' + undoing + '"');
  }
  // Exclusivity: this family is genuinely new territory, not a restatement of one of the
  // four proofing-pass contradiction families defined above this test — none of their
  // trigger vocabulary appears anywhere in this corpus.
  const OTHER_FAMILIES = [/\b(?:optional|skippable|may be (?:skipped|omitted)|can be skipped|if time (?:allows|permits))\b/i,
    /\b(?:need not|does not have to|at (?:the orchestrator['’]s|your) discretion|when you have time)\b/i,
    /\b(?:replaces|instead of|in place of)\b[^.;]*\b(?:pre-smoke|QA runner|proofing pass|artifact proofer)\b/i,
    /\bbefore the page (?:is built|exists|is generated)\b/i];
  for (const undoing of DOWNGRADE_CORPUS) {
    for (const other of OTHER_FAMILIES) {
      assert.doesNotMatch(undoing, other,
        'this corpus entry must not already belong to an existing family, or the new family adds nothing: "' + undoing + '"');
    }
  }
  // Negative control: the correct prose this repair itself wrote — including the sentence
  // that discusses "a static read or grep" as the PROBLEM, not a licensed alternative —
  // must not trip the sweep, or it cries wolf on the very fix it exists to protect.
  const CORRECT_PROSE_CONTROL = 'the step blocks render client-side from the embedded `SECTIONS_JS` JSON, '
    + "so a static read or grep of the file finds only the gate's blocks.";
  assert.ok(splitClauses(CORRECT_PROSE_CONTROL).length > 0,
    'the negative control must reach the clause filter, or its silence proves nothing');
  assert.ok(!isDowngrade(CORRECT_PROSE_CONTROL),
    'the sweep flags this repository\'s own correct prose ("a static read or grep…") as a downgrade');

  for (const file of operational) {
    const flagged = splitClauses(collapsed(file)).filter(isDowngrade);
    assert.deepEqual(flagged, [],
      file + ': a clause elsewhere in the document licenses the file text, grep or a static read as a substitute for the rendered DOM');
  }
});

// ===== BL-065: a row's dirt is read only in the trees holding its branch ==========
// reconcile.mjs read the main checkout's dirt for every row, as protocol.md's gather list said ("in
// the main checkout AND each worktree"), so one untracked file of the user's there read every 🔄 row
// as dirty. Fail-closed over every shipped file of any type, a unit at a time: a unit that names the
// main checkout, or ties dirt to every row or every worktree, is doubt unless DIRT_UNITS lists it word
// for word, and DIRT_UNITS lists exactly the units the checkout holds, so a new or edited one is read
// before it is listed. A unit is a sentence or `;` clause of a paragraph once code ticks, emphasis,
// line-leading `//` and the seams of a wrapped string are gone: a quote, a comma and a line break, then
// a quote; or a quote, a `+` before or after any line break, then a quote.
// The words the sweep selects on; a planted claim below goes unseen without each one.
const DIRT_WORDS = {
  main: ['main', 'primary'], tree: ['checkout', 'worktree', 'working[\\s-]+tree'],
  dirt: ['dirt\\w*', 'untracked', 'uncommitted', 'clean\\w*', 'git\\s+status', 'porcelain'], every: ['every', 'each', 'all'],
};
// Three selectors: a unit naming the main checkout, whatever it says of it; dirt beside every row; and
// dirt beside every worktree, the main checkout among them in `git worktree list`.
function dirtSelectors(words = DIRT_WORDS) {
  const any = list => '(?:' + list.join('|') + ')', dirt = new RegExp(`\\b${any(words.dirt)}\\b`, 'i');
  const main = new RegExp(`\\b${any(words.main)}[\\s-]+${any(words.tree)}\\b`, 'i');
  const every = noun => new RegExp(`\\b${any(words.every)}\\s+(?:\\S+\\s+){0,2}?${noun}s?\\b`, 'i');
  const rows = every('row'), trees = every(any(words.tree));
  return { mainCheckout: unit => main.test(unit), everyRow: unit => rows.test(unit) && dirt.test(unit), everyTree: unit => trees.test(unit) && dirt.test(unit) };
}
const DIRT_SELECT = dirtSelectors();
const tiesDirt = (unit, selectors = DIRT_SELECT) => Object.values(selectors).some(select => select(unit));
const dirtUnits = text => text.replace(/\r\n/g, '\n').replace(/^[ \t]*\/\//gm, '').replace(/['"],[ \t]*\n[ \t]*['"]/g, ' ').replace(/['"]\s*\+\s*['"]/g, '')
  .split(/\n\n/).flatMap(paragraph => paragraph.replace(/[`*]/g, '').replace(/\s+/g, ' ').split(/(?<=[.;])\s+/));
// [file, a unit there word for word]: each says whose dirt a row reads as the rule now has it, names the
// main checkout for another reason, or reads every worktree for another fact.
const DIRT_UNITS = [
  ['orchestrate/SKILL.md', "Never switch the main checkout and never copy ledger files into another branch's tree."],
  ['orchestrate/SKILL.md', "The orchestrator never switches the main checkout: it reads with git show and writes through an integration worktree under the contract's worktree root (its boot step 2 and Git model), or under the session scratchpad for a contract that names none."],
  ['orchestrate/references/execution-models.md', 'The main checkout is never switched.'],
  ['orchestrate/references/execution-models.md', "- No sub-agent support → the orchestrator implements a wave's batches one at a time in the main checkout (worktrees unnecessary);"],
  ['orchestrate/references/protocol.md', 'Never switches the main checkout: reads any branch with git show <branch>:./<path> (keep the ./ — Git Bash on Windows mangles branch:path;'],
  ['orchestrate/references/protocol.md', 'also inspect .agents/changes directly in each worktree from git worktree list --porcelain.'],
  ['orchestrate/references/protocol.md', "Inspect every worktree's porcelain status including untracked files and both rename endpoints."],
  ['orchestrate/references/protocol.md', "For each PROGRESS row not ✅/👤/⛔ (dropped), gather: branch exists? (git rev-parse --verify), integrated? (git merge-base --is-ancestor <branch> <integration>), shipped? (git merge-base --is-ancestor <integration-sha> <shipment-sha> only after source resolution above), commits ahead (git log <integration>..<branch> --oneline), dirty trees (git status --porcelain in each worktree from git worktree list that holds the row's branch — the main checkout only when it holds that branch), and the checklist state inside the batch file on that branch (git show <branch>:./<path>, from the root)."],
  ['orchestrate/references/protocol.md', "- No sub-agents available: the orchestrator implements a wave's batches one at a time in the main checkout (worktrees unnecessary)."],
  ['orchestrate/references/subagent-prompts.md', 'Stay inside the worktree — do not create or switch branches, never push, never touch the main checkout, never leave untracked files in the worktree (scratch goes under [SCRATCHPAD_PATH]).'],
  ['orchestrate/references/subagent-prompts.md', 'Main-checkout variant (degraded environments, or a width-1 wave run directly in the repo): replace the worktree paragraph with "Work on the CURRENT branch ([BATCH_BRANCH]) — do not create or switch branches, never push." A rendered file takes no such edit, so this variant is always the manual procedure (§Spawning rules).'],
  ['orchestrate/templates/00-READBEFORE.md', 'Never switch the main checkout.'],
  ['orchestrate/templates/00-READBEFORE.md', 'Read ledger files from any branch with git show <branch>:./<path> (the ./ is required — Git Bash on Windows mangles branch:path otherwise) and write to the ledger through an integration worktree (git worktree add "{{WORKTREE_ROOT}}/int" {{INTEGRATION_BRANCH}}), using the main checkout only if it already has {{INTEGRATION_BRANCH}} checked out.'],
  ['orchestrate/tools/reconcile.mjs', "The row's dirt is read only in the trees holding its branch, the main checkout among them only while it holds that branch: dirt on any other branch is none of this row's work."],
  ['orchestrate/tools/reconcile.mjs', 'The main checkout: the worktree holding the common .git directory, never a worktree to prune.'],
  ['README.md', "- Sub-agents are used for census agents, implementers, reviewers, gate agents and the QA runner, but aren't required — without them the orchestrator implements a wave's batches one at a time in the main checkout and still runs the review as a separate adversarial pass per batch."],
];
const dirtClaims = (file, text) => dirtUnits(text).filter(unit => tiesDirt(unit) && !DIRT_UNITS.some(([owner, listed]) => owner === file && listed === unit));
test('no shipped file says the main checkout\'s dirt counts for every row', () => {
  const agents = fs.readdirSync(path.join(ROOT, '.claude/agents')).map(name => '.claude/agents/' + name);
  const files = [...shippedSkillFiles(), 'README.md', ...agents];
  assert.ok(agents.length > 0 && [...shippedSkillFiles(), 'README.md', ...agents].every(file => files.includes(file)), 'the sweep reads every shipped file, README and the agent definitions');
  // The checkout's units, set-equal to DIRT_UNITS: one added or edited is doubt until it is read and listed,
  // and a listed one that is gone is stale.
  const held = files.flatMap(file => dirtUnits(read(file)).filter(unit => tiesDirt(unit)).map(unit => file + ' :: ' + unit));
  assert.deepEqual(held.sort(), DIRT_UNITS.map(([file, unit]) => file + ' :: ' + unit).sort(),
    'the units naming the main checkout, or tying dirt to every row or every worktree, must be exactly DIRT_UNITS: read a new one, then list it word for word');
  const sweep = readFile => files.flatMap(file => dirtClaims(file, readFile(file)).map(claim => file + ' :: ' + claim));
  // Armed on the whole domain at once: the claim appended to every file is reported once per file, whatever its type.
  assert.deepEqual(sweep(file => read(file) + '\n\nThe main checkout\'s dirt counts for every row.\n').map(hit => hit.split(' :: ')[0]), files,
    'a claim appended to any swept file must be reported, once');
  // Live controls, planted in real carriers and read the same way; a control's text anchor is found once.
  const plant = (file, anchor, replacement, eol = text => text) => {
    const text = read(file), planted = text.replace(anchor, () => replacement);
    if (typeof anchor === 'string') assert.equal(text.split(anchor).length - 1, 1, file + ': the control anchor must be found once — ' + anchor);
    assert.notEqual(planted, text, file + ': the control found no anchor');
    return dirtClaims(file, eol(planted));
  };
  const PROTOCOL_MD = 'orchestrate/references/protocol.md', RECONCILE_MJS = 'orchestrate/tools/reconcile.mjs';
  // The change reverted: protocol.md's old gather list, then reconcile.mjs's old comment.
  const reverted = plant(PROTOCOL_MD, /in each worktree from `git worktree list` that holds the row's branch — the main\ncheckout only when it holds that branch\)/,
    'in the main checkout AND each worktree from `git worktree list`)');
  assert.ok(reverted.length === 1 && reverted[0].includes('dirty trees (git status --porcelain in the main checkout AND each worktree from git worktree list)'),
    'protocol.md\'s old gather list must be reported: ' + reverted.join(' || '));
  assert.deepEqual(plant(RECONCILE_MJS, '// The main checkout: the worktree holding the common .git directory, never a worktree to prune.',
    '// The main checkout: the worktree holding the common .git directory; its dirt counts for every row.'),
    ['The main checkout: the worktree holding the common .git directory;', 'its dirt counts for every row.'], 'reconcile.mjs\'s old comment must be reported');
  // A listed unit edited anywhere is listed no more: here a clause that leans on the gather list's own "dirty trees".
  assert.equal(plant(PROTOCOL_MD, '--oneline`), dirty trees (`git status --porcelain`', '--oneline`), the main checkout\'s for every row and the other dirty trees (`git status --porcelain`').length, 1,
    'a clause borrowing a listed unit\'s dirt must be reported');
  // The rule restated in a sentence of its own, with a dirt word the list lacks, and with none.
  for (const claim of ["The main checkout's local changes count for every row.", 'The main checkout counts for every row too.']) {
    assert.deepEqual(plant(PROTOCOL_MD, 'from the root).\nRows are matched top to bottom', 'from the root). ' + claim + '\nRows are matched top to bottom'), [claim], 'protocol.md must report: ' + claim);
  }
  // A unit is listed for its own file: the template's sentence copied into README is doubt there.
  assert.deepEqual(plant('README.md', /\n*$/, '\n\nNever switch the main checkout.\n'), ['Never switch the main checkout.'], 'a listed unit copied into another file must be reported');
  // Wrapped across two comment lines, and across two --help strings at each seam the reader joins (a comma,
  // and a `+` after or before the line break; either quote on either side), in LF and CRLF checkouts alike.
  // Only the joined name ties these to the rule, so only a joined seam reports them.
  const HELP_END = "'  AMBIGUOUS or INCOMPLETE line, or an invalid invocation.',", CUT = 'AMBIGUOUS or INCOMPLETE line, or an invalid invocation. The main';
  const WRAPS = [[/\n*$/, '\n// The main\n// checkout counts for every row too.\n'],
    [HELP_END, `'  ${CUT}',\n  "checkout counts for every row too.",`], [HELP_END, `"  ${CUT}",\n  'checkout counts for every row too.',`],
    [HELP_END, `"  ${CUT} " +\n    "checkout counts for every row too.",`],
    ["otherwise the header reads shipment=not-needed.',", "otherwise the header reads shipment=not-needed. The main '\n    + 'checkout counts for every row too.',"]];
  for (const [checkout, eol] of [['LF', text => text], ['CRLF', text => text.replace(/\n/g, '\r\n')]]) {
    for (const [anchor, wrapped] of WRAPS) assert.equal(plant(RECONCILE_MJS, anchor, wrapped, eol).length, 1, checkout + ': must be reported — ' + wrapped);
  }
  // Written as an author would put the old rule back, not read off the patterns. Each selector owns a claim the
  // others miss and each word one that goes unseen without it, so none can be dropped while the corpus still
  // reads as reported; its size is pinned, so a word cannot leave together with its claim.
  const CLAIMS = ["The main checkout's dirt counts for every row.", 'One untracked file in the main checkout reads every 🔄 row as dirty.',
    'Read git status --porcelain in the main checkout AND each worktree.', 'Its dirt counts for every row.', 'The main checkout counts for every row too.',
    "The main checkout's local changes count for every row.", 'Uncommitted changes in the primary worktree count too.', "Read the main working tree's status too.",
    'Read the main-checkout status too.', 'Untracked files count for every row.', 'Uncommitted changes count against all rows.', 'Every row needs a clean tree.',
    'Each row runs git status.', 'All rows read the porcelain listing.', 'Each PROGRESS row reads as dirty.',
    'Dirty trees: git status --porcelain in each worktree from git worktree list.', 'All checkouts are read for dirt.', 'Each working tree is read with git status.'];
  assert.equal(CLAIMS.length, 18, 'the corpus keeps all eighteen claims');
  assert.equal(new Set(CLAIMS).size, CLAIMS.length, 'no claim repeats to pad the corpus');
  for (const claim of CLAIMS) {
    assert.equal(plant('README.md', /\n*$/, '\n\n' + claim + '\n').length, 1, 'README.md must report: ' + claim);
    assert.equal(plant(RECONCILE_MJS, /\n*$/, '\n// ' + claim + '\n').length, 1, 'reconcile.mjs must report: ' + claim);
  }
  for (const name of Object.keys(DIRT_SELECT)) {
    assert.ok(CLAIMS.some(claim => Object.keys(DIRT_SELECT).filter(key => DIRT_SELECT[key](claim)).join() === name), name + ': no claim is caught by it alone');
  }
  for (const [part, words] of Object.entries(DIRT_WORDS)) {
    for (const word of words) {
      const without = dirtSelectors({ ...DIRT_WORDS, [part]: words.filter(other => other !== word) });
      assert.ok(CLAIMS.some(claim => !tiesDirt(claim, without)), part + ' ' + word + ': no claim needs it, so dropping it goes unseen');
    }
  }
});
