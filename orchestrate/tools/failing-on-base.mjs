#!/usr/bin/env node
// Protocol step 6b as a command: a batch's changed test files, taken from its commit, run on the
// merge base it was cut from, in mutate.mjs `withDisposableCheckout`. ONE line: PROVEN (a named
// test fails there), ALL-PASS (P0) (nothing fails: the fix is unproven) or INCONCLUSIVE (the run
// proves neither); every line is a valid `failingOnBase` fact for prompt.mjs.
import fs from 'node:fs';
import { git, capture, parseFlags, isMain } from './git-evidence.mjs';
import { oneLine } from './check-ledger.mjs';
import { rawChanges } from './prose-only-diff.mjs';
import { Unknown, CleanupFailed, withDisposableCheckout, gitIn, openLog, runLogged, readJson, checkedSpec, topLevel, inside, timeoutOf, scrubLocalGitEnv } from './mutate.mjs';

const MAX_NAMES = 10;

// ===== Test, production or mixed ================================================================
// A test file by where it lives or what it is called; every other path is production.
const TEST_SEGMENTS = new Set(['test', 'tests', '__tests__', 'spec', 'specs']);
const TEST_NAME = /^(?:.*\.(?:test|spec)\..*|.*_(?:test|spec)\..*|test_.*\..*)$/;
export function isTestPath(file) {
  const segments = file.split('/');
  return segments.some(s => TEST_SEGMENTS.has(s)) || TEST_NAME.test(segments[segments.length - 1]);
}
// A test written inside a production file: a Rust test attribute, a pytest or Go test function, or
// describe / it / test called by that bare name (never `str.split(`, `exit(`, `/x/.test(`).
const TEST_MARKER = /#\[test\]|#\[cfg\(test\)\]|def test_|func Test|(?<![\w$.])(?:describe|it|test)\(/;
export const hasTestMarker = text => TEST_MARKER.test(text);
// The lines a one-file `git diff -U0` adds: every `+` line from the first hunk header on, so the
// file header never counts.
export function addedLines(diff) {
  const lines = diff.split('\n'), first = lines.findIndex(l => l.startsWith('@@'));
  return first === -1 ? [] : lines.slice(first).filter(l => l.startsWith('+')).map(l => l.slice(1));
}
const literal = file => `:(literal)${file}`;

// ===== The verdict ==============================================================================
// Each \ in a file name a validate.mjs `runSpec` result lists is written /, the spelling of the git
// paths this tool names elsewhere, so the line reads the same whichever platform ran the tests.
const slashed = file => file.replaceAll('\\', '/');
// Why a validate.mjs `runSpec` result proves nothing about the base, or null: a step that did not
// run to PASS or FAIL, a test file that failed to load or ran no tests, or a failure naming no
// failing test. The first step with a reason gives it.
function doubtOf(result) {
  for (const s of result.steps) {
    if (s.result !== 'PASS' && s.result !== 'FAIL') return `${s.result}: ${s.name}`;
    const loads = s.loadFailures.filter(f => !s.emptyFiles.includes(f));
    if (loads.length) return `load error: ${loads.map(slashed).join(', ')}`;
    if (s.emptyFiles.length) return `ran no tests: ${s.emptyFiles.map(slashed).join(', ')}`;
    if (s.result === 'FAIL' && !(s.failed > 0 && s.names.length)) return `no failing test named: ${s.name}`;
  }
  return result.steps.length ? null : 'no step ran';
}
const mixedTail = mixed => mixed.length ? `; mixed, left to review: ${mixed.join(', ')}` : '';
// The line and exit code for a finished run; `mixed` names the production files left to review.
export function verdict(result, mixed = []) {
  const tail = mixedTail(mixed);
  const doubt = result.status === 'UNKNOWN' ? `COULD-NOT-START: ${result.steps.find(s => s.result === 'COULD-NOT-START')?.name ?? 'the run'}` : doubtOf(result);
  if (doubt) return { code: 2, line: oneLine(`INCONCLUSIVE (${doubt}${tail})`) };
  if (result.status === 'PASS') return { code: 1, line: oneLine(`ALL-PASS (P0${tail})`) };
  const failing = result.steps.filter(s => s.result === 'FAIL'), names = [...new Set(failing.flatMap(s => s.names))];
  const k = failing.reduce((sum, s) => sum + s.failed, 0), n = result.steps.reduce((sum, s) => sum + (s.passed ?? 0) + (s.failed ?? 0), 0);
  const shown = names.length > MAX_NAMES ? `${names.slice(0, MAX_NAMES).join(', ')}, …` : names.join(', ');
  return { code: 0, line: oneLine(`PROVEN (${k} of ${n} fail: ${shown}${tail})`) };
}

// ===== The core =================================================================================
// A read of the source repository, never a write to it.
function read(repo, args, what) {
  const r = git(repo, args);
  if (!r.ok) throw new Unknown(`${what}: git ${args[0]} failed`);
  return r.text;
}
// The batch's changes since the merge base: test paths to check out or delete, and the
// production paths whose added lines hold a test (mixed). A diff that cannot be read is doubt,
// and doubt is named for review.
export function changesOf(repo, mergeBase, batchSha) {
  const text = read(repo, ['diff', '--raw', '-z', '--no-abbrev', '--no-renames', '--no-relative', '--no-ext-diff', '--no-textconv', '--no-color', mergeBase, batchSha, '--'], 'changes');
  let changes;
  try { changes = rawChanges(text); } catch { throw new Unknown('changes: git diff output this tool cannot read'); }
  const overlay = [], gone = [], mixed = [];
  for (const c of changes) {
    if (isTestPath(c.path)) { (c.status === 'D' ? gone : overlay).push(c.path); continue; }
    if (c.status === 'D') continue;
    const r = git(repo, ['diff', '-U0', '--no-color', '--no-ext-diff', '--no-textconv', '--no-renames', mergeBase, batchSha, '--', literal(c.path)]);
    if (!r.ok || addedLines(r.text).some(hasTestMarker)) mixed.push(c.path);
  }
  return { overlay, gone, mixed };
}

// Inputs are already checked (the CLI does it); `remove` is the checkout's remover, a test seam.
export async function failingOnBase({ repo, base, batch, validate, setup = null, logPath, timeoutMs, tmpRoot, remove }) {
  let log;
  try { log = openLog(logPath); } catch (e) { return { code: 2, line: oneLine(`UNKNOWN ${e.message}`) }; }
  try {
    const diagnostics = [], baseSha = capture(repo, base, diagnostics), batchSha = capture(repo, batch, diagnostics);
    if (!baseSha || !batchSha) throw new Unknown(`${baseSha ? '--batch' : '--base'} names no commit in ${repo}`);
    const r = git(repo, ['merge-base', '--all', baseSha, batchSha]);
    // merge-base exits 1 with no output when the histories share no commit.
    if (!r.ok && !(r.exit === 1 && r.text === '')) throw new Unknown('merge base: git merge-base failed');
    const bases = r.text.split('\n').filter(Boolean);
    if (bases.length !== 1) throw new Unknown(`--base and --batch have ${bases.length} merge bases; exactly one is needed`);
    const [mergeBase] = bases, { overlay, gone, mixed } = changesOf(repo, mergeBase, batchSha), tail = mixedTail(mixed);
    if (!overlay.length && !gone.length) return { code: 2, line: oneLine(`INCONCLUSIVE (no test file changed${tail})`) };
    log.note(`merge base ${mergeBase}, batch ${batchSha}; check out: ${overlay.join(', ') || '-'}; delete: ${gone.join(', ') || '-'}; mixed: ${mixed.join(', ') || '-'}`);
    return await withDisposableCheckout(repo, mergeBase, async ({ dir, scratch, env }) => {
      // By the SHA captured here: the clone holds the batch branch only as a remote-tracking ref.
      // Hooks point at the checkout's empty directory, since a path checkout fires post-checkout.
      const hooks = ['-c', `core.hooksPath=${scratch}/hooks`];
      if (overlay.length) gitIn(dir, [...hooks, 'checkout', '--quiet', batchSha, '--', ...overlay.map(literal)], env, log, 'checkout of the test files');
      if (gone.length) gitIn(dir, [...hooks, 'rm', '--quiet', '--', ...gone.map(literal)], env, log, 'rm of the deleted test files');
      const run = (label, spec) => runLogged(spec, { cwd: dir, log, label, scratch, timeoutMs, env });
      if (setup) {
        const done = await run('setup', setup);
        if (done.status !== 'PASS') return { code: 2, line: oneLine(`INCONCLUSIVE (setup: ${done.line}${tail})`) };
      }
      return verdict(await run('validate', validate), mixed);
    }, { tmpRoot, log, remove });
  } catch (e) {
    if (e instanceof CleanupFailed) return { code: 2, line: oneLine(`UNKNOWN ${e.message}; the run said ${e.value.line}`) };
    if (!(e instanceof Unknown)) throw e;
    return { code: 2, line: oneLine(`UNKNOWN ${e.message}`) };
  } finally { log.close(); }
}

const HELP = `failing-on-base.mjs --repo <repo> --base <ref-or-sha> --batch <ref-or-sha> --validate <validate.json> --log <path> [--setup <setup.json>] [--timeout <seconds>]
Protocol step 6b. Finds the one merge base of --base and --batch (for a batch already merged, --base is the
merge commit's first parent) and lists the batch's changes since it. In a disposable checkout of that merge
base (a shared clone under the temp directory, removed afterwards; the repository itself is never written)
every added or changed test path is checked out by git from the batch commit, hooks off, and every deleted
one removed; then --setup and --validate (validate.mjs specs, see its --help) run there. A test path has a
segment test, tests, __tests__, spec or specs, or a name like *.test.*, *.spec.*, *_test.*, *_spec.* or
test_*.*; any other path is production. A production file whose added lines hold a test (#[test],
#[cfg(test)], def test_, func Test, or a bare describe(, it( or test( call) is mixed: never checked out,
named for the reviewer. Prints ONE line and exits:
  0 PROVEN (<k> of <n> fail: <names>)  every failure is a named failing test (ten names at most, then …)
  1 ALL-PASS (P0)                      every step passes on the base: the fix is unproven
  2 INCONCLUSIVE (<reason>)            no test file changed; setup: <validate.mjs line>; load error: <files>;
                                       ran no tests: <files>; <step result>: <step>; no failing test named
  2 UNKNOWN <reason>                   usage, a ref, not exactly one merge base, git, or cleanup
Mixed files add "; mixed, left to review: <paths>" inside the parentheses. --log is written fresh by each
invocation and must lie outside the repository. --timeout (whole seconds) applies per step. Git's repository
variables (git rev-parse --local-env-vars) are dropped from the environment first.`;

export async function failingOnBaseCli(args) {
  if (args.length === 1 && args[0] === '--help') return { code: 0, line: HELP };
  let flags;
  try { flags = parseFlags(args, ['repo', 'base', 'batch', 'validate', 'log', 'setup', 'timeout'], ['repo', 'base', 'batch', 'validate', 'log']); }
  catch { return { code: 2, line: 'UNKNOWN usage: unknown, missing or duplicate flag; use --help' }; }
  try {
    scrubLocalGitEnv();
    const timeoutMs = timeoutOf(flags.timeout);
    const validate = await checkedSpec(readJson(flags.validate, '--validate'), '--validate');
    const setup = flags.setup === undefined ? null : await checkedSpec(readJson(flags.setup, '--setup'), '--setup');
    const top = topLevel(flags.repo);
    if (inside(top, flags.log)) throw new Unknown(`usage: --log must lie outside the repository ${top}`);
    return await failingOnBase({ repo: top, base: flags.base, batch: flags.batch, validate, setup, logPath: flags.log, timeoutMs });
  } catch (e) { return { code: 2, line: oneLine(`UNKNOWN ${e instanceof Unknown ? e.message : `internal error: ${e.message}`}`) }; }
}

if (isMain(import.meta.url)) {
  // Exit 1 reads as ALL-PASS, so a crash never ends with it: UNKNOWN, exit 2.
  process.on('uncaughtException', e => { fs.writeSync(1, oneLine(`UNKNOWN internal error: ${e?.message ?? e}`) + '\n'); process.exit(2); });
  const output = await failingOnBaseCli(process.argv.slice(2));
  process.stdout.write((output.line === HELP ? HELP : oneLine(output.line)) + '\n');
  process.exitCode = output.code;
}
