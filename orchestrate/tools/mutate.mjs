#!/usr/bin/env node
// Proves mutations on a disposable checkout of a committed ref, never on the checkout it was
// asked about. Every anchor is checked before anything runs, an unmutated control must pass
// first, and each mutation is written and read back, run, classified from validate.mjs's parsed
// result, and restored from its saved bytes, verified byte for byte. Fail closed: only KILLED
// and SURVIVED are results; every other outcome is named and exits 2.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { capture, git, parseFlags, validPath, isMain, localGitVars as listedGitVars } from './git-evidence.mjs';
import { oneLine } from './check-ledger.mjs';
import { runSpec } from './validate.mjs';

export class Unknown extends Error {}
// The checkout outlived its result: the result travels with the failure.
export class CleanupFailed extends Unknown {
  constructor(message, value) { super(message); this.value = value; }
}
// Every kind of line a mutation run can end on. Only RESULTS prove anything about the tests;
// each NOT_RUN kind means the proof did not run.
export const RESULTS = ['KILLED', 'SURVIVED'];
export const NOT_RUN = ['ANCHOR-MISSING', 'ANCHOR-AMBIGUOUS', 'CONTROL FAILED', 'NOT-APPLIED', 'CRASHED', 'TIMEOUT', 'RESTORE-FAILED', 'UNKNOWN'];
const TEST_PARSERS = ['node', 'jest', 'pytest', 'cargo'];
const MAX_NAMES = 10;
const MAX_TIMEOUT_S = Math.floor((2 ** 31 - 1) / 1000);
// A checkout writes a whole tree; the evidence helpers' 15-second budget is for reads.
const GIT_TIMEOUT_MS = 10 * 60 * 1000;
const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const NO_LOG = { note() {}, append() {} };

// ===== Inputs ==================================================================================
export function timeoutOf(value) {
  if (value === undefined) return undefined;
  if (!/^[1-9]\d*$/.test(value) || Number(value) > MAX_TIMEOUT_S) throw new Unknown(`usage: --timeout must be a positive whole number of seconds, at most ${MAX_TIMEOUT_S}`);
  return Number(value) * 1000;
}
export function readJson(file, flag) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { throw new Unknown(`cannot read ${flag} ${file} (${e.code || e.name})`); }
  try { return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text); } catch { throw new Unknown(`${flag}: ${file} is not valid JSON`); }
}
// validate.mjs's own spec check, never a second parser: given no log path it checks the spec and
// then refuses to run anything, so any other answer is the spec's fault.
const NOTHING_RUN = 'UNKNOWN a log path is required';
export async function checkedSpec(spec, flag) {
  const probe = await runSpec(spec, {});
  if (probe.line !== NOTHING_RUN) throw new Unknown(`${flag}: ${probe.line.replace(/^UNKNOWN /, '')}`);
  return spec;
}
export function checkMutations(doc) {
  if (!isObject(doc) || Object.keys(doc).join() !== 'mutations') return 'the file must be an object whose only key is "mutations"';
  if (!Array.isArray(doc.mutations) || !doc.mutations.length) return '"mutations" must be a non-empty array';
  const seen = new Set();
  for (const [i, m] of doc.mutations.entries()) {
    const where = `mutation ${i + 1}`;
    if (!isObject(m) || Object.keys(m).sort().join() !== 'file,find,id,replace') return `${where} must hold exactly "id", "file", "find" and "replace"`;
    if (typeof m.id !== 'string' || !/^[A-Za-z0-9._-]+$/.test(m.id)) return `${where} needs an id of [A-Za-z0-9._-]+`;
    if (seen.has(m.id)) return `duplicate id "${m.id}"`;
    seen.add(m.id);
    if (!validPath(m.file) || m.file.split('/').some(part => part.toLowerCase() === '.git')) return `${m.id}: "file" must be a repository-relative path with forward slashes, outside .git`;
    if (typeof m.find !== 'string' || !m.find) return `${m.id}: "find" must be a non-empty string`;
    if (typeof m.replace !== 'string' || m.replace === m.find) return `${m.id}: "replace" must be a string that differs from "find"`;
  }
  return null;
}
// The work tree holding <repo>: a mutation's file is relative to its top.
export function topLevel(repo, env) {
  const r = git(repo, ['rev-parse', '--show-toplevel'], { env });
  if (!r.ok || !r.text.trim()) throw new Unknown(`usage: not inside a git work tree: ${repo}`);
  return path.resolve(r.text.trim());
}
// A log inside the repository would change the status the tool promises to leave alone.
export function inside(top, file) {
  const rel = path.relative(top, path.resolve(file));
  return !(rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel));
}

// ===== Git's environment =======================================================================
// The variables that tie git to one repository — its directory, work tree, index, objects and
// injected config — as git itself lists them (`git rev-parse --local-env-vars`), never a copy of
// that list. One inherited by the clone's checkout, or by a validate step inside the clone, acts
// on the caller's repository instead: a GIT_DIR detaches its HEAD, a GIT_INDEX_FILE stages into
// its index. The list is git-evidence.mjs's, whose probes drop its repository-location names.
export function localGitVars() {
  try { return listedGitVars(); } catch (e) { throw new Unknown(e.message); }
}
// Names compare case-folded: Windows reads its environment without regard to case.
export function withoutLocalGitEnv(env) {
  const drop = new Set(localGitVars());
  return Object.fromEntries(Object.entries(env).filter(([key]) => !drop.has(key.toUpperCase())));
}
// A CLI owns its process: it drops them from process.env before anything reads it — the ref
// lookup, the clone and every validate step.
export function scrubLocalGitEnv(env = process.env) {
  const drop = new Set(localGitVars());
  for (const key of Object.keys(env)) if (drop.has(key.toUpperCase())) delete env[key];
}

// ===== The disposable checkout =================================================================
export const removeTree = dir => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
// Clone and checkout write only inside the disposable directory; hooks point at an empty
// directory there, so no hook the user configured runs, and git's repository variables are
// dropped, so neither acts on the caller's repository. Git's stderr goes to the log only.
export function gitIn(cwd, args, env, log, what) {
  const r = spawnSync('git', args, { cwd, env: { ...env, GIT_TERMINAL_PROMPT: '0' }, shell: false, windowsHide: true, timeout: GIT_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 });
  if (!r.error && r.status === 0) return;
  const how = r.error ? r.error.code || r.error.name : `exit ${r.status ?? r.signal}`;
  log.note(`git ${what} failed (${how})`);
  if (r.stderr?.length) log.append(r.stderr);
  throw new Unknown(`checkout: git ${what} failed (${how})`);
}
// A shared clone reads the repository's objects without copying them and registers nothing in
// it: no worktree entry, no admin directory. `<ref>` is resolved in `repo` first, so HEAD of a
// batch worktree works. The clone sits in a short directory under the temp root (Windows paths
// stop at 260 characters) and is removed however `fn` ends. Git's repository variables are dropped
// here for every caller, not only for a CLI that scrubbed its process first: the ref lookup, the
// clone and `fn`'s validate steps (it is handed `env`) use a scrubbed copy; process.env is untouched.
export async function withDisposableCheckout(repo, ref, fn, { tmpRoot = os.tmpdir(), log = NO_LOG, remove = removeTree } = {}) {
  const env = withoutLocalGitEnv(process.env);
  const top = topLevel(repo, env);
  const sha = capture(top, ref, [], { env }), short = sha && git(top, ['rev-parse', '--short', sha], { env });
  if (!sha || !short.ok) throw new Unknown(`ref ${ref} names no commit in ${top}`);
  let root;
  try { root = fs.mkdtempSync(path.join(tmpRoot, 'mut-')); }
  catch (e) { throw new Unknown(`cannot create a disposable directory under ${tmpRoot} (${e.code || e.name})`); }
  let value, failure = null;
  try {
    const dir = path.join(root, 'c'), hooks = path.join(root, 'hooks');
    fs.mkdirSync(hooks);
    log.note(`checkout ${sha} into ${dir}`);
    gitIn(root, ['-c', `core.hooksPath=${hooks}`, 'clone', '--shared', '--no-checkout', '--quiet', '--', top, dir], env, log, 'clone');
    gitIn(dir, ['-c', `core.hooksPath=${hooks}`, 'checkout', '--quiet', '--detach', sha], env, log, 'checkout');
    value = await fn({ dir, sha, short: short.text.trim(), scratch: root, env });
  } catch (e) { failure = e; }
  finally {
    try { remove(root); }
    catch (e) {
      const cleanup = `cleanup: ${root} could not be removed (${e.code || e.name})`;
      failure = failure ? new Unknown(`${failure.message}; ${cleanup}`) : new CleanupFailed(cleanup, value);
    }
  }
  if (failure) throw failure;
  return value;
}

// ===== Logs and runs ===========================================================================
// The one log every run of an invocation appends to, outside the checkout, fresh per invocation.
export function openLog(file) {
  const logPath = path.resolve(file);
  let fd;
  try { fs.mkdirSync(path.dirname(logPath), { recursive: true }); fd = fs.openSync(logPath, 'w'); }
  catch (e) { throw new Unknown(`cannot open log ${logPath} (${e.code || e.name})`); }
  let atLineStart = true;
  const put = data => { if (data.length) { fs.writeSync(fd, data); atLineStart = data[data.length - 1] === '\n' || data[data.length - 1] === 10; } };
  return { path: logPath, append: put, note: text => put(`${atLineStart ? '' : '\n'}==> mutate: ${text}\n`), close: () => fs.closeSync(fd) };
}
// One validate.mjs run in the checkout. Its own log is copied into the invocation's log under a
// header and its line re-pointed there, so every `log:` path printed outlives the checkout.
export async function runLogged(spec, { cwd, log, label, scratch, timeoutMs, env }) {
  const runLog = path.join(scratch, 'run.log');
  fs.rmSync(runLog, { force: true });
  log.note(label);
  const result = await runSpec(spec, { cwd, logPath: runLog, timeoutMs, env });
  log.append(fs.readFileSync(runLog));
  return { ...result, line: result.line.split(runLog).join(log.path) };
}

// ===== Anchors and verdicts ====================================================================
// Overlapping occurrences count: an anchor that could apply in two places is ambiguous.
function occurrences(bytes, needle) {
  let n = 0;
  for (let at = bytes.indexOf(needle); at !== -1; at = bytes.indexOf(needle, at + 1)) n++;
  return n;
}
// A CRLF file (at least one CRLF, no bare LF) takes the line breaks of find and replace as CRLF,
// so the mutation keeps the file's EOL style.
function isCrlf(bytes) {
  let lf = 0, crlf = 0;
  for (let i = 0; i < bytes.length; i++) if (bytes[i] === 10) { lf++; if (i > 0 && bytes[i - 1] === 13) crlf++; }
  return crlf > 0 && crlf === lf;
}
const eolOf = (text, crlf) => Buffer.from(crlf ? text.replace(/\r?\n/g, '\r\n') : text, 'utf8');
// A mutation's anchor in the checkout: a regular file inside it, never a link out of it, in
// which `find` occurs exactly once. The mutated bytes are the saved original with that one
// occurrence replaced; every other byte is kept.
function anchor(dir, realDir, m, originals) {
  const file = path.join(dir, ...m.file.split('/'));
  let stat;
  try { stat = fs.lstatSync(file); } catch { return { fault: `ANCHOR-MISSING ${m.id}` }; }
  const rel = stat.isFile() ? path.relative(realDir, fs.realpathSync(file)) : '..';
  if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) return { fault: `ANCHOR-MISSING ${m.id} (not a regular file inside the checkout)` };
  if (!originals.has(file)) originals.set(file, fs.readFileSync(file));
  const original = originals.get(file), crlf = isCrlf(original), find = eolOf(m.find, crlf), n = occurrences(original, find);
  if (n !== 1) return { fault: n ? `ANCHOR-AMBIGUOUS ${m.id} (${n} matches)` : `ANCHOR-MISSING ${m.id}` };
  const at = original.indexOf(find);
  return { m, file, original, mutated: Buffer.concat([original.subarray(0, at), eolOf(m.replace, crlf), original.subarray(at + find.length)]) };
}
// One mutation run against the control. SURVIVED needs every parsed step to have run and passed
// what the control's did: the same passed, skipped and total counts. CRASHED means the run proved
// nothing about the tests: a test step with no parsed summary; a test file that failed to load
// (node reports one as a failing test named after the file, WITH a summary, so it would otherwise
// read as KILLED) or ran no tests (node counts one as a passing test, so the total holds); a test
// count unlike the control's; a step in which no test passed or failed; a step whose skipped count
// moved, failing tests or not (a mutation that flips a skip condition changes which tests run, not
// how many, and a test the control skipped proves nothing by failing). KILLED needs every failing step
// to count failed tests and name them, which a parser-none step never does: it counts nothing.
const tests = n => `${n} test${n === 1 ? '' : 's'}`;
function moved(s, c) {
  const more = s.skipped - c.skipped;
  if (more > 0) return `${tests(more)} skipped that ran in the control`;
  return `${tests(-more)} ran that the control skipped`;
}
export function classifyRun(control, run, parsers) {
  const steps = run.steps;
  if (steps.length !== parsers.length) return { kind: 'CRASHED', reason: 'the run did not reach its steps' };
  if (steps.some(s => s.result === 'TIMEOUT')) return { kind: 'TIMEOUT', reason: 'a step outlived --timeout' };
  for (const [i, s] of steps.entries()) {
    if (parsers[i] === 'none') continue;
    const c = control.steps[i];
    if (s.total === null) return { kind: 'CRASHED', reason: `step ${s.name} printed no parsed summary` };
    // validate.mjs lists a file that ran no tests among the load failures too: each is named as what it is.
    const loads = s.loadFailures.filter(f => !s.emptyFiles.includes(f));
    const files = [loads.length && `a test file failed to load (${loads.join(', ')})`, s.emptyFiles.length && `a test file ran no tests (${s.emptyFiles.join(', ')})`].filter(Boolean);
    if (files.length) return { kind: 'CRASHED', reason: `step ${s.name}: ${files.join('; ')}` };
    if (s.total !== c.total) return { kind: 'CRASHED', reason: `step ${s.name} ran ${s.total} tests, the control ${c.total}` };
    if (s.result === 'NO-TESTS') return { kind: 'CRASHED', reason: `step ${s.name}: no test passed (${s.passed}/${s.total}${s.skipped ? `, ${s.skipped} skipped` : ''})` };
    // Every parser's total is passed + failed + skipped (validate.mjs), the totals are equal here and
    // the control failed nothing: an equal skipped count leaves only failures to move a passed count.
    if (s.skipped !== c.skipped) return { kind: 'CRASHED', reason: `step ${s.name}: ${moved(s, c)}` };
  }
  if (run.status === 'PASS') return { kind: 'SURVIVED' };
  const failing = steps.filter(s => s.result !== 'PASS');
  if (failing.every(s => s.failed > 0 && s.names.length > 0)) return { kind: 'KILLED', names: [...new Set(failing.flatMap(s => s.names))] };
  return { kind: 'CRASHED', reason: 'a step failed without a named failing test' };
}
export function verdictLine(id, verdict, runLine) {
  if (verdict.kind === 'CRASHED') return `CRASHED ${id}: ${runLine}`;
  if (verdict.kind !== 'KILLED') return `${verdict.kind} ${id}`;
  const n = verdict.names;
  return `KILLED ${id}: ${n.length > MAX_NAMES ? `${n.slice(0, MAX_NAMES).join(', ')} (+${n.length - MAX_NAMES} more)` : n.join(', ')}`;
}

// ===== The core ================================================================================
// Inputs are already checked (the CLI does it). `writeFile` writes a mutation and its restore:
// a test seam, so a write that does not land or a restore that does not hold can be fed in.
export async function mutate({ repo, ref, mutations, validate, setup = null, logPath, timeoutMs, tmpRoot, writeFile = fs.writeFileSync, remove, emit = () => {} }) {
  const lines = [], say = text => { const line = oneLine(text); lines.push(line); emit(line); };
  let log;
  try { log = openLog(logPath); } catch (e) { say(`UNKNOWN ${e.message}`); return { code: 2, lines }; }
  const parsers = validate.steps.map(s => s.parser);
  // A write counts only when reading the file back gives exactly the bytes meant.
  const wrote = (file, bytes) => { try { writeFile(file, bytes); return fs.readFileSync(file).equals(bytes); } catch { return false; } };
  let code = 2;
  try {
    code = await withDisposableCheckout(repo, ref, async ({ dir, scratch, env }) => {
      const run = (label, spec) => runLogged(spec, { cwd: dir, log, label, scratch, timeoutMs, env });
      if (setup) {
        const done = await run('setup', setup);
        if (done.status !== 'PASS') { say(`UNKNOWN setup ${done.line}`); return 2; }
      }
      // Anchors first, all of them: one that is missing or ambiguous stops everything, unrun.
      const originals = new Map(), realDir = fs.realpathSync(dir);
      const plans = mutations.map(m => anchor(dir, realDir, m, originals));
      if (plans.some(p => p.fault)) { for (const p of plans.filter(p => p.fault)) say(p.fault); return 2; }
      // A control in which no test passed would let every mutation survive: validate.mjs fails it
      // (NO-TESTS), so it is no control.
      const control = await run('control', validate);
      if (control.status !== 'PASS') { say(`CONTROL FAILED ${control.line}`); return 2; }
      say(`CONTROL PASS ${control.line}`);
      const tally = { KILLED: 0, SURVIVED: 0, other: 0 };
      for (const { m, file, original, mutated } of plans) {
        // A replace that differs from find only in its line breaks is find's own bytes once a
        // CRLF file's breaks are applied: nothing would change, and the run would read SURVIVED.
        if (mutated.equals(original)) {
          log.note(`${m.id}: NOT-APPLIED — the mutation leaves the file's bytes unchanged; nothing was written or run`);
          say(`NOT-APPLIED ${m.id}`); tally.other++;
          continue;
        }
        let line, kind;
        if (!wrote(file, mutated)) {
          log.note(`${m.id}: NOT-APPLIED — the file did not read back as the mutated bytes`);
          line = `NOT-APPLIED ${m.id}`; kind = 'other';
        } else {
          const result = await run(`mutation ${m.id} (${m.file})`, validate), verdict = classifyRun(control, result, parsers);
          if (verdict.reason) log.note(`${m.id}: ${verdict.kind} — ${verdict.reason}`);
          line = verdictLine(m.id, verdict, result.line); kind = RESULTS.includes(verdict.kind) ? verdict.kind : 'other';
        }
        // The line is printed only once the restore holds. A checkout left mutated would taint
        // every later run, and a write that just failed cannot vouch for the run before it: stop,
        // with RESTORE-FAILED alone and no summary; the unprinted line goes to the log.
        if (!wrote(file, original)) {
          log.note(`${m.id}: RESTORE-FAILED — the file did not read back as its saved bytes; not printed: ${line}`);
          say(`RESTORE-FAILED ${m.id}`); return 2;
        }
        say(line); tally[kind]++;
      }
      say(`MUTATE ${tally.KILLED} killed, ${tally.SURVIVED} survived, ${tally.other} other`);
      return tally.other ? 2 : tally.SURVIVED ? 1 : 0;
    }, { tmpRoot, log, remove });
  } catch (e) {
    if (!(e instanceof Unknown)) throw e;
    say(`UNKNOWN ${e.message}`);
  } finally { log.close(); }
  return { code, lines };
}

const HELP = `mutate.mjs --repo <repo> --ref <ref> --mutations <muts.json> --validate <spec.json> --log <file> [--setup <spec.json>] [--timeout <seconds>]
Proves each mutation on a disposable checkout of <ref>: a shared clone under the temp directory, removed
afterwards. The repository itself is never written, and its uncommitted changes are not seen. --setup runs,
every anchor is checked, then an unmutated control, then one run per mutation, each restored from saved bytes.
Prints CONTROL PASS <validate line>, then one line per mutation:
  KILLED <id>: <failing tests> | SURVIVED <id> | CRASHED <id>: <validate line> | TIMEOUT <id> |
  NOT-APPLIED <id> | RESTORE-FAILED <id> (which stops the run: no later mutation, no summary)
then MUTATE <k> killed, <s> survived, <u> other. An abort prints only its own line(s):
  ANCHOR-MISSING <id> | ANCHOR-AMBIGUOUS <id> (<n> matches) | CONTROL FAILED <validate line> | UNKNOWN <reason>
Exit 0 every mutation killed; 1 at least one survived and nothing else went wrong; 2 anything else.
KILLED: a step failed, every failing step names its failing tests and no CRASHED cause below holds, so no counted
step's skipped count moved. SURVIVED: every counted step passed with the control's own passed, skipped and total
counts, and no CRASHED cause below holds. CRASHED: the run did not reach its steps, a test step with no parsed summary, a test file that failed to
load or ran no tests, a test count unlike the control's, a counted step in which no test passed or failed, a step whose
skipped count differs from the control's, failing tests or not (a test skipped that ran in the control, or the
reverse), or a step that failed without a named failing test; the log records which.
NOT-APPLIED: the mutated bytes did not read back, or equal the file's own (in a CRLF file, a replace that differs
from find only in its line breaks). A mutation's line is printed only once its restore holds; RESTORE-FAILED
replaces it. Git's repository variables (git rev-parse --local-env-vars) are dropped from the environment first.
Mutations (JSON; any other key is rejected):
  { "mutations": [ { "id": "m1", "file": "src/sum.js", "find": "a + b", "replace": "a - b" } ] }
id: unique, [A-Za-z0-9._-]+. file: repository-relative with forward slashes, a regular file. find: occurs
exactly once in the file; in a CRLF file the line breaks of find and replace are matched and written as CRLF.
--validate and --setup are validate.mjs specs (see its --help), run from the checkout root. --validate needs
a step whose parser counts tests (node, jest, pytest, cargo), and each such step must pass at least one test
(one in which none passed, all skipped or todo or none at all, is CONTROL FAILED) in the
control. --log is written fresh by each invocation, every run appending to it, and must lie outside the
repository. --timeout (whole seconds, at most ${MAX_TIMEOUT_S}) applies per step of every run.`;

export async function mutateCli(args, emit = () => {}) {
  if (args.length === 1 && args[0] === '--help') { emit(HELP); return { code: 0, lines: [HELP] }; }
  const refuse = reason => { const line = oneLine(`UNKNOWN ${reason}`); emit(line); return { code: 2, lines: [line] }; };
  let flags;
  try { flags = parseFlags(args, ['repo', 'ref', 'mutations', 'validate', 'log', 'setup', 'timeout'], ['repo', 'ref', 'mutations', 'validate', 'log']); }
  catch { return refuse('usage: unknown, missing or duplicate flag; use --help'); }
  try {
    scrubLocalGitEnv();
    const timeoutMs = timeoutOf(flags.timeout);
    const doc = readJson(flags.mutations, '--mutations'), problem = checkMutations(doc);
    if (problem) throw new Unknown(`--mutations: ${problem}`);
    const validate = await checkedSpec(readJson(flags.validate, '--validate'), '--validate');
    if (!validate.steps.some(s => TEST_PARSERS.includes(s.parser))) throw new Unknown('--validate: needs a step whose parser counts tests (node, jest, pytest, cargo); a parser-none step has no count to compare');
    const setup = flags.setup === undefined ? null : await checkedSpec(readJson(flags.setup, '--setup'), '--setup');
    const top = topLevel(flags.repo);
    if (inside(top, flags.log)) throw new Unknown(`usage: --log must lie outside the repository ${top}`);
    return await mutate({ repo: top, ref: flags.ref, mutations: doc.mutations, validate, setup, logPath: flags.log, timeoutMs, emit });
  } catch (e) { return refuse(e instanceof Unknown ? e.message : `internal error: ${e.message}`); }
}

if (isMain(import.meta.url)) {
  // Exit 1 reads as "a mutation survived", so a crash never ends with it: UNKNOWN, exit 2.
  process.on('uncaughtException', e => { fs.writeSync(1, oneLine(`UNKNOWN internal error: ${e?.message ?? e}`) + '\n'); process.exit(2); });
  const output = await mutateCli(process.argv.slice(2), line => process.stdout.write(line + '\n'));
  process.exitCode = output.code;
}
