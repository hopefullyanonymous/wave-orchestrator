#!/usr/bin/env node
// This mechanical gate does not replace semantic review or grant scope.
import { git, capture, readBlob, worktrees, validId, validPath, validFullRef, parseFlags, diagnostic, isMain } from './git-evidence.mjs';
import { linesOf, exactPaths, table, oneRow, branchCell, extensions } from './ledger-parse.mjs';

export function validateBatchEdit(baseline, proposed, originalPaths, addedPaths, batchPath) {
  const violations = [], add = (code, message, line) => violations.push(diagnostic(code, message, { path: batchPath, ...(line ? { line } : {}) }));
  const before = linesOf(baseline), after = linesOf(proposed);
  const start = before.findIndex(l => l === '## Checklist');
  const ends = before.map((l, i) => i > start && /^## /.test(l) ? i : -1).filter(i => i >= 0);
  if (start < 0 || before.filter(l => l === '## Checklist').length !== 1 || !ends.length) { add('batch-structure', 'Unsupported original Checklist section'); return violations; }
  const end = ends[0];
  let polishAt = end;
  while (polishAt > start + 1 && before[polishAt - 1] === '') polishAt--;
  let i = 0, j = 0;
  for (; i < before.length; i++, j++) {
    // Polish is appended after all original checklist content, before the next section.
    // An item may wrap: an indented line is consumed only once a header matched here, and
    // never when it is itself a checkbox, which would smuggle a new item in as wrapped prose.
    if (i === polishAt) for (let headed = false; /^- \[[ x]\] polish: .+$/.test(after[j] || '') || (headed && /^ +(?!(?:[-*+]|\d{1,9}[.)])[ \t]+\[[ xX]\])\S/.test(after[j] || '')); j++) headed = true;
    if (before[i] === after[j]) continue;
    if (i > start && i < end && before[i].startsWith('- [ ] ') && after[j] === before[i].replace('- [ ] ', '- [x] ')) continue;
    if (before[i].startsWith('**Files**: ')) {
      try {
        const oldPaths = exactPaths(before[i].slice(11)), newPaths = exactPaths((after[j] || '').slice(11));
        if (!(after[j] || '').startsWith('**Files**: ') || JSON.stringify(oldPaths) !== JSON.stringify(originalPaths)) throw new Error();
        const expected = new Set([...oldPaths, ...addedPaths]);
        if (newPaths.length !== expected.size || newPaths.some(p => !expected.has(p)) || oldPaths.some((p, n) => newPaths[n] !== p)) throw new Error();
        continue;
      } catch { add('batch-files', 'Files may only append precisely recorded extensions, preserving original paths and order', j + 1); continue; }
    }
    add('batch-content', 'Original batch lines, sections, order and checklist text must be preserved', j + 1);
  }
  if (j !== after.length) add('batch-content', 'Unexpected added or removed batch content', j + 1);
  return violations;
}
function parseChanges(text) {
  if (!text) return [];
  const tokens = text.split('\0'); if (tokens.pop() !== '') throw new Error();
  const changes = [];
  for (let i = 0; i < tokens.length;) {
    const status = tokens[i++];
    if (!/^(?:[AMDTCUXB]|[RC]\d{1,3})$/.test(status) || !tokens[i]) throw new Error();
    const paths = [tokens[i++]];
    if (/^[RC]/.test(status)) { if (!tokens[i]) throw new Error(); paths.push(tokens[i++]); }
    changes.push({ status, paths });
  }
  return changes;
}
function ordinaryBlob(repo, sha, file, unknowns, options) {
  const r = git(repo, ['ls-tree', '-z', sha, '--', file], options);
  if (!r.ok) { unknowns.push({ ...r.diagnostic, path: file }); return false; }
  const records = r.text.split('\0');
  const valid = records.length === 2 && records[1] === '' && new RegExp('^100(?:644|755) blob [a-f0-9]{40}(?:[a-f0-9]{24})?\\t').test(records[0]) && records[0].slice(records[0].indexOf('\t') + 1) === file;
  return valid ? records[0].slice(0, 6) : null;
}
export function checkFence({ repo, integration, batch, ledger: id, 'batch-id': batchId, 'batch-file': batchFile, ...options }) {
  const result = { status: 'UNKNOWN', integrationSha: null, batchSha: null, mergeBase: null, violations: [], unknowns: [], evidence: { changes: [], allowedPaths: [], worktrees: [], worktreeDiagnostics: [] } };
  const { violations, unknowns } = result;
  const finish = () => { result.status = unknowns.length ? 'UNKNOWN' : violations.length ? 'VIOLATION' : 'PASS'; return result; };
  if (!repo || !validFullRef(integration) || !validFullRef(batch) || integration === batch || !validId(id) || !/^B\d{2,}$/.test(batchId || '') || !validPath(batchFile)) {
    unknowns.push(diagnostic('usage', 'Explicit repository, distinct full refs, ledger ID, batch ID and exact batch file are required')); return finish();
  }
  const root = `.agents/changes/${id}`;
  const number = batchId.slice(1);
  if (!batchFile.startsWith(`${root}/02-batches-${number}-`) || !batchFile.endsWith('.md') || batchFile.slice(root.length + 1).includes('/')) {
    unknowns.push(diagnostic('batch-linkage', 'Batch ID and ledger batch filename do not agree', { path: batchFile })); return finish();
  }
  result.integrationSha = capture(repo, integration, unknowns, options); result.batchSha = capture(repo, batch, unknowns, options);
  if (!result.integrationSha || !result.batchSha) return finish();
  const bases = git(repo, ['merge-base', '--all', result.integrationSha, result.batchSha], options);
  if (!bases.ok) unknowns.push(bases.diagnostic);
  else {
    const found = bases.text.split(/\r?\n/).filter(Boolean);
    if (found.length !== 1 || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(found[0])) unknowns.push(diagnostic('merge-base', 'Exactly one merge base is required'));
    else result.mergeBase = found[0];
  }
  const wt = worktrees({ repo, ...options }); result.evidence.worktrees = wt.evidence.worktrees; result.evidence.worktreeDiagnostics = wt.diagnostics;
  const associated = wt.evidence.worktrees.filter(w => w.branch === batch);
  // Other checkout dirt is evidence, not this batch's violation. An incomplete
  // observation anywhere in the inventory remains UNKNOWN rather than a clean gate.
  unknowns.push(...wt.diagnostics);
  if (associated.length !== 1) unknowns.push(diagnostic('candidate-worktree', 'Exactly one associated candidate worktree is required'));
  else if (associated[0].head !== result.batchSha || associated[0].cleanliness === 'unknown') unknowns.push(diagnostic('candidate-worktree', 'Candidate worktree is inaccessible or its HEAD does not match the captured branch', { path: associated[0].path }));
  else if (associated[0].cleanliness === 'dirty') violations.push(diagnostic('dirty-worktree', 'Candidate has tracked, staged, untracked or conflicted changes', { path: associated[0].path, entries: associated[0].status }));
  let fence = null, extension = [], baseline = null, proposed = null;
  const planPath = `${root}/01-plan.md`, progressPath = `${root}/PROGRESS.md`;
  for (const file of [planPath, progressPath]) if (!ordinaryBlob(repo, result.integrationSha, file, unknowns, options)) unknowns.push(diagnostic('authority-file', 'Authority must be an ordinary committed file', { path: file }));
  const plan = readBlob(repo, result.integrationSha, planPath, unknowns, options), progress = readBlob(repo, result.integrationSha, progressPath, unknowns, options);
  try {
    if (plan === null || progress === null) throw new Error('Missing authoritative ledger text');
    const planRow = oneRow(table(plan, ['#', 'Branch', 'Files (fence)']), batchId), progressRow = oneRow(table(progress, ['#', 'Branch', 'Notes']), batchId);
    const branch = batch.slice('refs/heads/'.length);
    if (!batch.startsWith('refs/heads/') || branchCell(planRow.Branch) !== branch || branchCell(progressRow.Branch) !== branch) throw new Error('Plan/PROGRESS branch linkage does not agree');
    fence = exactPaths(planRow['Files (fence)']); extension = extensions(progress, progressRow, batchId);
    if (extension.some(p => fence.includes(p) || p === batchFile)) throw new Error('Redundant or ambiguous extension');
    result.evidence.allowedPaths = [...fence, ...extension, batchFile];
  } catch (e) { unknowns.push(diagnostic('authority', e.message, { path: planPath })); }
  if (result.mergeBase) {
    const diff = git(repo, ['diff', '--no-ext-diff', '--no-textconv', '--name-status', '-z', '-M', '-C', '--find-copies-harder', `${result.integrationSha}...${result.batchSha}`, '--'], options);
    if (!diff.ok) unknowns.push(diff.diagnostic);
    else try { result.evidence.changes = parseChanges(diff.text); } catch { unknowns.push(diagnostic('invalid-diff', 'Malformed committed name-status output')); }
    if (fence) for (const change of result.evidence.changes) for (const file of change.paths) if (!result.evidence.allowedPaths.includes(file)) violations.push(diagnostic('outside-fence', 'Changed path is outside captured plan fence and authorized extensions', { path: file, change: change.status }));
    const batchChange = result.evidence.changes.find(c => c.paths.includes(batchFile));
    if (batchChange && batchChange.status !== 'M') violations.push(diagnostic('batch-type', 'Own batch file cannot be added, deleted, renamed, copied or type-replaced', { path: batchFile }));
    const baselineMode = ordinaryBlob(repo, result.mergeBase, batchFile, unknowns, options);
    const proposedMode = ordinaryBlob(repo, result.batchSha, batchFile, unknowns, options);
    if (!baselineMode) unknowns.push(diagnostic('batch-baseline', 'Baseline batch must be an ordinary file', { path: batchFile }));
    else baseline = readBlob(repo, result.mergeBase, batchFile, unknowns, options);
    if (proposedMode) proposed = readBlob(repo, result.batchSha, batchFile, unknowns, options);
    else violations.push(diagnostic('batch-type', 'Candidate batch must remain an ordinary file', { path: batchFile }));
    if (baselineMode && proposedMode && baselineMode !== proposedMode) violations.push(diagnostic('batch-type', 'Own batch file mode must remain unchanged', { path: batchFile }));
    if (baseline !== null && proposed !== null && fence) {
      try {
        if (!new RegExp(`^# ${batchId} (?:—|-) `).test(baseline)) throw new Error('Batch title does not match ID');
        const fileLines = linesOf(baseline).filter(l => l.startsWith('**Files**: '));
        const branchLines = linesOf(baseline).filter(l => l.startsWith('**Branch**: '));
        if (fileLines.length !== 1 || branchLines.length !== 1 || branchLines[0] !== `**Branch**: \`${batch.slice('refs/heads/'.length)}\`` || JSON.stringify(exactPaths(fileLines[0].slice(11))) !== JSON.stringify(fence)) throw new Error('Baseline batch Files/Branch must match authoritative plan');
        const batchFindings = validateBatchEdit(baseline, proposed, fence, extension, batchFile);
        unknowns.push(...batchFindings.filter(f => f.code === 'batch-structure'));
        violations.push(...batchFindings.filter(f => f.code !== 'batch-structure'));
      } catch (e) { unknowns.push(diagnostic('batch-linkage', e.message, { path: batchFile })); }
    }
  }
  // Compare observations again after all dependent probes. A moving ref or status is
  // indeterminate, even if the earlier snapshot would have passed.
  const integrationAfter = capture(repo, integration, unknowns, options), batchAfter = capture(repo, batch, unknowns, options);
  if (integrationAfter !== result.integrationSha || batchAfter !== result.batchSha) unknowns.push(diagnostic('ref-race', 'A captured ref changed during inspection'));
  const after = worktrees({ repo, ...options }), afterCandidate = after.evidence.worktrees.filter(w => w.branch === batch);
  unknowns.push(...after.diagnostics);
  if (JSON.stringify(associated) !== JSON.stringify(afterCandidate)) unknowns.push(diagnostic('worktree-race', 'Candidate worktree identity/status changed during inspection'));
  return finish();
}
export function fenceCli(args) {
  if (args.length === 1 && args[0] === '--help') return { code: 0, text: 'check-fence.mjs --repo <repo> --integration <full-ref> --batch <full-ref> --ledger <id> --batch-id <Bnn> --batch-file <repo-relative-path>\nRead-only mechanical evidence; semantic review is still required.\nExit 0 PASS; 1 VIOLATION; 2 UNKNOWN. UNKNOWN takes precedence; both diagnostic arrays are retained. Unsupported legacy authority requires the conductor\'s frozen manual checks.\n' };
  let result;
  try { const keys = ['repo', 'integration', 'batch', 'ledger', 'batch-id', 'batch-file']; result = checkFence(parseFlags(args, keys, keys)); }
  catch { result = { status: 'UNKNOWN', integrationSha: null, batchSha: null, mergeBase: null, violations: [], unknowns: [diagnostic('usage', 'Unknown, missing or duplicate flag; use --help')], evidence: {} }; }
  return { result, code: { PASS: 0, VIOLATION: 1, UNKNOWN: 2 }[result.status] };
}
if (isMain(import.meta.url)) {
  const output = fenceCli(process.argv.slice(2)); process.stdout.write(output.text ?? JSON.stringify(output.result) + '\n'); process.exitCode = output.code;
}
