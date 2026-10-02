#!/usr/bin/env node
// One foreground validation run: every step in order, full output to a log, ONE line out.
// Fail closed: a step passes only on a found summary with zero failures, a passed test, and exit 0.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { parseFlags, isMain } from './git-evidence.mjs';

const PARSERS = ['node', 'jest', 'pytest', 'cargo', 'none'];
const SHELLS = ['pwsh', 'powershell', 'bash'];
const MAX_NAMES = 10;
// setTimeout's ceiling: a longer delay silently becomes 1 ms, which would kill every step.
const MAX_TIMEOUT_MS = 2 ** 31 - 1;
// After a step exits, output pipes still held by a stray descendant stop being read after this.
// The descendant is left running: once the step's own process is gone it cannot be found portably.
const GRACE_MS = 5000;
// CSI, OSC (BEL or ST terminated), nF (e.g. charset selection) and Fe escapes. The escape
// character is written as an escape sequence: a literal ESC byte is an invisible character.
const ANSI = /\u001b(?:\[[0-?]*[ -\/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[ -\/]+[0-~]|[@-Z\\-_])/g;
const SCRIPT_FILE = /\.(?:c|m)?[jt]sx?$/;

const normalize = text => text.replace(ANSI, '').replace(/\r\n?/g, '\n');
const uniq = list => [...new Set(list)];
const slashes = p => p.replace(/[\\/]+/g, '/');
// The name and the location may each be relative or absolute (spec: absolute name, relative location).
const isFileOf = (name, file) => { const n = slashes(name), f = slashes(file); return f === n || f.endsWith('/' + n) || n.endsWith('/' + f); };
// A name taken for a test file's path: a script extension, and no whitespace before its first
// separator (an absolute path may hold a space later; a sentence ending "src/config.js" is a test name).
const fileShaped = name => SCRIPT_FILE.test(name) && !/\s/.test(name.split(/[\\/]/, 1)[0]);
// `skipped` counts every test in the total that neither passed nor failed.
const empty = () => ({ summary: false, passed: null, failed: null, skipped: null, total: null, names: [], loadFailures: [], emptyFiles: [] });
// A result with a summary; `emptyFiles` are passing entries moved to the failures.
const found = (c, names, loadFailures, emptyFiles = []) => ({ summary: true, passed: c.passed - emptyFiles.length, failed: c.failed + emptyFiles.length,
  skipped: c.skipped, total: c.total, names: uniq([...names, ...emptyFiles]), loadFailures: uniq([...loadFailures, ...emptyFiles]), emptyFiles: uniq(emptyFiles) });
const missing = (names, loadFailures, emptyFiles = []) => ({ ...empty(), names: uniq([...names, ...emptyFiles]), loadFailures: uniq([...loadFailures, ...emptyFiles]), emptyFiles: uniq(emptyFiles) });

// node reports a test file that registered no tests (or had every test filtered out) as ONE
// PASSING test named after the file. It is found by shape, rejecting on doubt: a top-level
// passing entry with no directive, no children and not a suite, whose name is file-shaped.
function emptyFileEntries(lines) {
  const out = [], open = new Map();
  // Spec: a suite or a parent test opens with a top-level `▶ name` and closes with `✔ name (…ms)`.
  for (const line of lines) {
    const start = /^▶ (.+)$/.exec(line);
    if (start) { open.set(start[1], (open.get(start[1]) || 0) + 1); continue; }
    const end = /^([✔✖]) (.+) \(\d+(?:\.\d+)?ms\)$/.exec(line);
    if (!end) continue;
    if (open.get(end[2])) open.set(end[2], open.get(end[2]) - 1);
    else if (end[1] === '✔' && fileShaped(end[2])) out.push(end[2]);
  }
  // TAP: `ok N - name` at column 0; its children print indented before it, its type after it.
  for (let i = 0; i < lines.length; i++) {
    const m = /^ok \d+ - ((?:\\.|[^\\#])*)(#.*)?$/.exec(lines[i]);
    if (!m || m[2]) continue;
    let children = false, suite = false;
    for (let j = i - 1; j >= 0 && !/^(?:# Subtest: |(?:not )?ok \d+ )/.test(lines[j]); j--) if (/^[ \t]+(?:# Subtest: |(?:not )?ok \d+ )/.test(lines[j])) children = true;
    for (let j = i + 1; j < lines.length && /^[ \t]/.test(lines[j]); j++) if (/^[ \t]+type: 'suite'$/.test(lines[j])) suite = true;
    const name = m[1].trimEnd().replace(/\\([\\#])/g, '$1');
    if (!children && !suite && fileShaped(name)) out.push(name);
  }
  return out;
}

// node: spec reporter (`✖ name (1.2ms)`, `ℹ tests N`) or TAP (`not ok N - name`, `# tests N`).
// The summary is the reporter's contiguous block, so a test printing `tests 99` is not one.
function parseNode(text) {
  const lines = text.split('\n'), entries = [];
  const c = { found: 0, passed: 0, failed: 0, skipped: 0, total: 0 };
  for (const m of text.matchAll(/^(ℹ|#) tests (\d+)\n\1 suites \d+\n\1 pass (\d+)\n\1 fail (\d+)\n\1 cancelled (\d+)\n\1 skipped (\d+)\n\1 todo (\d+)$/gm)) {
    c.found++; c.total += +m[2]; c.passed += +m[3]; c.failed += +m[4] + +m[5]; c.skipped += +m[6] + +m[7];
  }
  // Spec: the trailing "failing tests" block lists each failure once, without the suites the
  // inline tree also marks; outside a block every inline `✖` line is taken.
  const block = [], inline = [];
  let inBlock = false, location = null;
  for (const line of lines) {
    if (line === '✖ failing tests:') { inBlock = true; location = null; continue; }
    if (inBlock && /^[ℹ✔▶﹣]/.test(line)) inBlock = false;
    const at = /^test at (.+):\d+:\d+$/.exec(line);
    if (inBlock && at) { location = at[1]; continue; }
    const m = /^[ \t]*✖ (.+) \(\d+(?:\.\d+)?ms\)$/.exec(line);
    if (!m) continue;
    if (!inBlock) inline.push({ name: m[1], location: null });
    else { block.push({ name: m[1], location }); location = null; }
  }
  entries.push(...(lines.includes('✖ failing tests:') ? block : inline));
  // TAP: skip directives, suites and parents failed only by their subtests.
  for (let i = 0; i < lines.length; i++) {
    const m = /^([ \t]*)not ok \d+ - ((?:\\.|[^\\#])*)(#.*)?$/.exec(lines[i]);
    if (!m || /^# (?:TODO|SKIP)\b/i.test(m[3] || '')) continue;
    let skip = false, tapLocation = null;
    for (let j = i + 1; j < lines.length && lines[j].startsWith(m[1] + '  '); j++) {
      if (/^\s*(?:type: 'suite'|failureType: 'subtestsFailed')$/.test(lines[j])) skip = true;
      const loc = /^\s*location: '(.*):\d+:\d+'$/.exec(lines[j]);
      if (loc) tapLocation = loc[1];
    }
    if (!skip) entries.push({ name: m[2].trimEnd().replace(/\\([\\#])/g, '$1'), location: tapLocation });
  }
  // A file that fails to load is reported as one failing test named after the file.
  const loadFailures = entries.filter(e => e.location ? isFileOf(e.name, e.location) : SCRIPT_FILE.test(e.name)).map(e => e.name);
  const names = entries.map(e => e.name), emptyFiles = emptyFileEntries(lines);
  return c.found ? found(c, names, loadFailures, emptyFiles) : missing(names, loadFailures, emptyFiles);
}

function parseJest(text) {
  const c = { found: 0, passed: 0, failed: 0, skipped: 0, total: 0 };
  for (const m of text.matchAll(/^Tests:[ \t]+(?:(.*?),[ \t]+)?(\d+) total$/gm)) {
    const tokens = (m[1] ? m[1].split(/,[ \t]+/) : []).map(t => /^(\d+) (failed|passed|skipped|todo|pending)$/.exec(t));
    if (tokens.some(t => !t)) continue;
    c.found++; c.total += +m[2];
    for (const [, n, kind] of tokens) c[kind === 'failed' || kind === 'passed' ? kind : 'skipped'] += +n;
  }
  const names = [], loadFailures = [];
  let file = null;
  for (const line of text.split('\n')) {
    const f = /^[ \t]*FAIL[ \t]+(\S+)/.exec(line);
    if (f) file = f[1];
    const m = /^[ \t]*● (.+?)[ \t]*$/.exec(line);
    if (!m) continue;
    if (m[1] !== 'Test suite failed to run') names.push(m[1]);
    else if (file) { names.push(file); loadFailures.push(file); }
  }
  // A suite that cannot run is outside jest's test counts; it is a failing entry here.
  const loads = uniq(loadFailures);
  return c.found ? found({ ...c, failed: c.failed + loads.length, total: c.total + loads.length }, names, loads) : missing(names, loads);
}

function parsePytest(text) {
  const c = { found: 0, passed: 0, failed: 0, skipped: 0, total: 0 };
  for (const m of text.matchAll(/^=+ (.+?) in \d+(?:\.\d+)?s(?: \([^)]*\))? =+$/gm)) {
    if (m[1] === 'no tests ran') { c.found++; continue; }
    const tokens = m[1].split(', ').map(t => /^(\d+) (passed|failed|errors?|skipped|deselected|xfailed|xpassed|warnings?|rerun)$/.exec(t));
    if (tokens.some(t => !t)) continue;
    c.found++;
    // deselected tests were never selected: outside the total, like cargo's filtered out.
    for (const [, n, kind] of tokens) {
      if (kind === 'passed') c.passed += +n;
      if (kind === 'failed' || kind.startsWith('error')) c.failed += +n;
      if (['skipped', 'xfailed', 'xpassed'].includes(kind)) c.skipped += +n;
      if (['passed', 'failed', 'error', 'errors', 'skipped', 'xfailed', 'xpassed'].includes(kind)) c.total += +n;
    }
  }
  const names = [], loadFailures = [];
  for (const m of text.matchAll(/^(FAILED|ERROR) ([^\s[]+(?:\[[^\]\n]*\])?)(?: - .*)?$/gm)) {
    names.push(m[2]);
    // A collection error names a file, never a `file::test` node id.
    if (m[1] === 'ERROR' && !m[2].includes('::')) loadFailures.push(m[2]);
  }
  return c.found ? found(c, names, loadFailures) : missing(names, loadFailures);
}

// cargo: one result line per test binary, summed.
function parseCargo(text) {
  const c = { found: 0, passed: 0, failed: 0, skipped: 0, total: 0 };
  for (const m of text.matchAll(/^test result: (?:ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored; \d+ measured; \d+ filtered out(?:; finished in \d+(?:\.\d+)?s)?$/gm)) {
    c.found++; c.passed += +m[1]; c.failed += +m[2]; c.skipped += +m[3]; c.total += +m[1] + +m[2] + +m[3];
  }
  const names = [...text.matchAll(/^test (.+) \.\.\. FAILED$/gm)].map(m => m[1]);
  return c.found ? found(c, names, []) : missing(names, []);
}

export function parseRunnerOutput(parser, text) {
  const parse = { node: parseNode, jest: parseJest, pytest: parsePytest, cargo: parseCargo, none: () => empty() }[parser];
  if (!PARSERS.includes(parser) || !parse) throw new Error(`Unknown parser: ${parser}`);
  return parse(normalize(String(text)));
}

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
function checkSpec(spec) {
  if (!isObject(spec) || Object.keys(spec).some(k => k !== 'steps')) return 'the spec must be an object whose only key is "steps"';
  if (!Array.isArray(spec.steps) || !spec.steps.length) return '"steps" must be a non-empty array';
  const seen = new Set();
  for (const [i, step] of spec.steps.entries()) {
    const where = `step ${i + 1}`;
    if (!isObject(step)) return `${where} must be an object`;
    const extra = Object.keys(step).find(k => !['name', 'argv', 'shell', 'script', 'parser'].includes(k));
    if (extra !== undefined) return `${where} has unknown key "${extra}"`;
    if (typeof step.name !== 'string' || !/^[A-Za-z0-9._-]+$/.test(step.name)) return `${where} needs a name of [A-Za-z0-9._-]+`;
    if (seen.has(step.name)) return `duplicate step name "${step.name}"`;
    seen.add(step.name);
    if (!PARSERS.includes(step.parser)) return `${where} needs a parser: ${PARSERS.join(', ')}`;
    const hasArgv = Object.hasOwn(step, 'argv'), hasShell = Object.hasOwn(step, 'shell') || Object.hasOwn(step, 'script');
    if (hasArgv === hasShell) return `${where} needs exactly one of "argv" or "shell" + "script"`;
    if (hasArgv && (!Array.isArray(step.argv) || step.argv.some(a => typeof a !== 'string') || !step.argv[0])) return `${where} "argv" must be a non-empty array of strings`;
    if (hasShell && !SHELLS.includes(step.shell)) return `${where} "shell" must be one of ${SHELLS.join(', ')}`;
    if (hasShell && (typeof step.script !== 'string' || !step.script)) return `${where} needs a non-empty "script"`;
  }
  return null;
}

// The script is one argument, never composed into a command string. PowerShell gets it
// encoded: Windows PowerShell 5.1 strips embedded double quotes from a -Command argument.
// -OutputFormat Text keeps pwsh's error stream readable text rather than CLIXML in the log.
function commandOf(step, bash = 'bash') {
  if (step.argv) return step.argv;
  if (step.shell === 'bash') return [bash, '-o', 'pipefail', '-c', step.script];
  return [step.shell, '-NoProfile', '-NonInteractive', '-OutputFormat', 'Text', '-EncodedCommand', Buffer.from(step.script, 'utf16le').toString('base64')];
}

// On Windows every program splits its own command line. A `bash` that is really a launcher
// (WSL's System32 or WindowsApps bash.exe) rejoins and re-evaluates it, so a quoted script
// runs ALTERED rather than failing. Each PATH candidate must echo this probe back byte for
// byte; the first that does is used, and none is a step that could not start. Elsewhere
// argv reaches bash intact by construction. Each part catches its own alteration: "b" quote
// stripping, \" a consumed backslash, $c a second evaluation, line two a cut at the newline.
export const BASH_PROBE = [String.raw`printf '%s' 'q "b" \" $c'`, String.raw`printf '%s' ' z'`].join('\n');
const BASH_PROBE_OUT = String.raw`q "b" \" $c z`;
export const bashProbeIntact = ({ status, stdout }) => status === 0 && stdout === BASH_PROBE_OUT;
const bashCache = new Map();
export function resolveBash(env) {
  if (process.platform !== 'win32') return { bash: 'bash', rejected: [] };
  const pathVar = Object.entries(env).find(([k]) => k.toUpperCase() === 'PATH')?.[1] ?? '';
  if (bashCache.has(pathVar)) return bashCache.get(pathVar);
  const rejected = [];
  let bash = null;
  for (const dir of pathVar.split(';').map(d => d.replace(/"/g, '')).filter(d => path.isAbsolute(d))) {
    for (const file of ['.com', '.exe'].map(ext => path.join(dir, 'bash' + ext))) {
      try { if (fs.lstatSync(file).isDirectory()) continue; } catch { continue; }
      const r = spawnSync(file, ['-o', 'pipefail', '-c', BASH_PROBE], { env, encoding: 'utf8', timeout: 30000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
      if (bashProbeIntact(r)) { bash = file; break; }
      rejected.push(file);
    }
    if (bash) break;
  }
  const found = { bash, rejected };
  bashCache.set(pathVar, found);
  return found;
}

function killTree(pid) {
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  else try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } }
}

// Child output goes to the log byte for byte; the tool's own lines always start a new line.
function logWriter(fd) {
  let atLineStart = true;
  const put = data => { if (data.length) { fs.writeSync(fd, data); atLineStart = data[data.length - 1] === '\n' || data[data.length - 1] === 10; } };
  return { fd, data: put, note: text => put((atLineStart ? '' : '\n') + text + '\n') };
}

function runStep(step, { cwd, env, timeoutMs, log }) {
  return new Promise(resolve => {
    let resolved = { bash: 'bash', rejected: [] };
    if (step.shell === 'bash') {
      resolved = resolveBash(env);
      for (const file of resolved.rejected) log.note(`==> step ${step.name}: ${file} does not receive a quoted script intact (a launcher such as WSL's); not used`);
      if (resolved.bash && resolved.bash !== 'bash') log.note(`==> step ${step.name}: bash is ${resolved.bash}`);
    }
    const [command, ...args] = commandOf(step, resolved.bash), pieces = [];
    const decoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') };
    let child, settled = false, timedOut = false, timer, grace;
    const finish = outcome => {
      if (settled) return;
      settled = true; clearTimeout(timer); clearTimeout(grace);
      pieces.push(decoders.stdout.end(), decoders.stderr.end());
      resolve({ ...outcome, timedOut, text: pieces.join('') });
    };
    if (!command) { finish({ error: resolved.rejected.length ? 'BASH-ARGV-ALTERED' : 'ENOENT' }); return; }
    try {
      child = spawn(command, args, { cwd, env, shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) { finish({ error: e.code || e.name }); return; }
    for (const stream of ['stdout', 'stderr']) child[stream].on('data', chunk => { log.data(chunk); pieces.push(decoders[stream].write(chunk)); });
    child.on('error', e => { if (child.pid === undefined) finish({ error: e.code || e.name }); });
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      grace = setTimeout(() => {
        log.note(`==> step ${step.name}: exited but its output pipes are still held open; stopped reading (the holder is left running)`);
        child.stdout.destroy(); child.stderr.destroy();
        finish({ exit: code ?? signal });
      }, GRACE_MS);
    });
    child.on('close', (code, signal) => finish({ exit: code ?? signal }));
    if (timeoutMs) timer = setTimeout(() => { timedOut = true; killTree(child.pid); }, timeoutMs);
  });
}

function classify(step, run, timeoutMs) {
  const parsed = step.parser === 'none' ? empty() : parseRunnerOutput(step.parser, run.text || '');
  const base = { name: step.name, passed: parsed.passed, failed: parsed.failed, skipped: parsed.skipped, total: parsed.total, names: parsed.names, loadFailures: parsed.loadFailures, emptyFiles: parsed.emptyFiles, exit: run.exit ?? null };
  const shown = parsed.names.map(n => parsed.emptyFiles.includes(n) ? `${n} (ran no tests)` : n);
  const list = shown.length > MAX_NAMES ? `${shown.slice(0, MAX_NAMES).join(', ')} (+${shown.length - MAX_NAMES} more)` : shown.join(', ');
  // Skips show only when there are any, so a run without them keeps the plain `<passed>/<total>`.
  const sk = parsed.skipped ? `, ${parsed.skipped} skipped` : '';
  const out = (result, text) => ({ step: { ...base, result }, text: `${step.name} ${text}` });
  if (run.error) return out('COULD-NOT-START', `COULD-NOT-START (${run.error})`);
  if (run.timedOut) return out('TIMEOUT', `TIMEOUT after ${timeoutMs / 1000}s`);
  if (step.parser === 'none') return run.exit === 0 ? out('PASS', 'ok') : out('FAIL', `exit ${run.exit}`);
  if (parsed.summary && parsed.failed > 0) return out('FAIL', list ? `${parsed.failed} of ${parsed.total} failed${sk}: ${list}` : `${parsed.failed} of ${parsed.total} failed${sk} (names not captured)`);
  if (parsed.summary && run.exit !== 0) return out('FAIL', `exit ${run.exit} after ${parsed.passed}/${parsed.total} passed${sk}`);
  // Nothing passed (every test skipped, or none at all, 0/0 included): nothing was proved.
  if (parsed.summary && !(parsed.passed > 0)) return out('NO-TESTS', `no test passed (${parsed.passed}/${parsed.total}${sk})`);
  if (parsed.summary) return out('PASS', `${parsed.passed}/${parsed.total}${sk}`);
  if (run.exit !== 0) return out('CRASHED', `CRASHED before summary (exit ${run.exit})`);
  return out('NO-SUMMARY', 'NO SUMMARY (exit 0)');
}

export function formatDuration(ms) {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
}
// A reporter's text never breaks the one-line contract.
const SEPARATORS = [0x2028, 0x2029].map(c => String.fromCharCode(c));
const oneLine = text => SEPARATORS.reduce((t, s) => t.split(s).join(' '), text.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' '));

// Step `result` is PASS, FAIL, NO-TESTS, CRASHED, NO-SUMMARY, TIMEOUT or COULD-NOT-START; counts
// are null without a summary. `status` is UNKNOWN when a step could not start or the input is invalid.
// Steps inherit `env` (a caller may pass a scrubbed copy; process.env itself is never changed).
export async function runSpec(spec, { cwd = process.cwd(), logPath, timeoutMs, env: inherited = process.env } = {}) {
  const unknown = reason => ({ status: 'UNKNOWN', line: oneLine(`UNKNOWN ${reason}`), steps: [] });
  const problem = checkSpec(spec);
  if (problem) return unknown(`spec: ${problem}`);
  if (typeof logPath !== 'string' || !logPath) return unknown('a log path is required');
  if (timeoutMs !== undefined && !(Number.isFinite(timeoutMs) && timeoutMs > 0 && timeoutMs <= MAX_TIMEOUT_MS)) return unknown(`the timeout must be a positive number of ms, at most ${MAX_TIMEOUT_MS}`);
  let log;
  try { fs.mkdirSync(path.dirname(path.resolve(logPath)), { recursive: true }); log = logWriter(fs.openSync(logPath, 'w')); }
  catch (e) { return unknown(`cannot open log ${logPath} (${e.code || e.name})`); }
  // A validation run is never a nested test context.
  const env = Object.fromEntries(Object.entries(inherited).filter(([k]) => k.toUpperCase() !== 'NODE_TEST_CONTEXT'));
  const started = Date.now(), steps = [], texts = [];
  try {
    for (const step of spec.steps) {
      log.note(`==> step ${step.name}: ${step.argv ? 'argv ' + JSON.stringify(step.argv) : 'shell ' + step.shell}`);
      const run = await runStep(step, { cwd, env, timeoutMs, log });
      if (run.error) log.note(`==> step ${step.name}: COULD-NOT-START (${run.error})`);
      if (run.timedOut) log.note(`==> step ${step.name}: TIMEOUT after ${timeoutMs / 1000}s; process tree killed`);
      const { step: result, text } = classify(step, run, timeoutMs);
      steps.push(result); texts.push(text);
    }
  } finally { fs.closeSync(log.fd); }
  const status = steps.some(s => s.result === 'COULD-NOT-START') ? 'UNKNOWN' : steps.every(s => s.result === 'PASS') ? 'PASS' : 'FAIL';
  const joined = texts.join('; ');
  const line = status === 'PASS' ? `PASS ${joined} (${formatDuration(Date.now() - started)})` : `${status} ${joined} — log: ${logPath}`;
  return { status, line: oneLine(line), steps };
}

const HELP = `validate.mjs --spec <file.json> --log <file> [--cwd <dir>] [--timeout <seconds>]
Runs every step in order in the foreground, writes all output to --log, prints ONE line:
  PASS <step>; <step> (<duration>)  |  FAIL <step>; <step> — log: <path>  |  UNKNOWN <reason>
Exit 0 PASS; 1 FAIL; 2 UNKNOWN (usage, spec, or a step that could not start).
--cwd defaults to the current directory; --timeout (whole seconds, at most 2147483) applies per step and kills
the step's process tree. Spec (JSON; any other key is rejected):
  { "steps": [
    { "name": "tests", "shell": "pwsh", "script": "<multi-line recipe>", "parser": "node" },
    { "name": "diff-check", "argv": ["git", "diff", "--check"], "parser": "none" } ] }
name: unique, [A-Za-z0-9._-]+. Exactly one of argv (spawned without a shell) or shell + script;
shell: pwsh | powershell | bash (bash runs with -o pipefail; on Windows the first bash on PATH
that receives a quoted script intact, so never WSL's launcher). parser: node | jest | pytest |
cargo | none. A parsed step passes only when its summary shows zero failures, at least one
passed test, and it exits 0: a run in which nothing passed (every test skipped, or no test at
all, 0/0 included) is FAIL "no test passed (<passed>/<total>, <k> skipped)". Skips show on the
line only when there are any: "tests 497/499, 2 skipped". skipped counts every test in the
total that neither passed nor failed: node skipped + todo; jest skipped + todo + pending;
pytest skipped + xfailed + xpassed; cargo ignored (pytest's deselected and cargo's filtered
out are outside the total). node reports a test file that registered no tests, or whose every
test a filter removed (--test-name-pattern, --test-skip-pattern, --test-only), as one passing
test named after the file; any top-level passing entry (no directive, no subtests, not a suite)
whose name is file-shaped (a script extension, and no whitespace before its first / or \\) is
taken for one: counted as failed, named "(ran no tests)" and listed in loadFailures. The price
is a false rejection of any real top-level test, or an empty describe under the spec reporter,
whose name is file-shaped: one named like a file path ("config.test.js") or a title whose first
word holds a slash or a backslash ("I/O errors from reader.js"); rename it. Not recognised: a file that node
names by a relative path whose first segment holds a space, whether given, globbed, ./-prefixed
or discovered ("my file.test.js", "my dir/a.test.js").
`;

export async function validateCli(args) {
  if (args.length === 1 && args[0] === '--help') return { code: 0, text: HELP };
  const unknown = reason => ({ code: 2, text: oneLine(`UNKNOWN ${reason}`) + '\n' });
  let flags;
  try { flags = parseFlags(args, ['spec', 'log', 'cwd', 'timeout'], ['spec', 'log']); }
  catch { return unknown('usage: unknown, missing or duplicate flag; use --help'); }
  if (flags.timeout !== undefined && (!/^[1-9]\d*$/.test(flags.timeout) || Number(flags.timeout) * 1000 > MAX_TIMEOUT_MS)) {
    return unknown(`usage: --timeout must be a positive whole number of seconds, at most ${Math.floor(MAX_TIMEOUT_MS / 1000)}`);
  }
  const cwd = path.resolve(flags.cwd ?? process.cwd());
  try { if (!fs.statSync(cwd).isDirectory()) throw new Error(); } catch { return unknown(`usage: --cwd is not a directory: ${flags.cwd}`); }
  let text, spec;
  try { text = fs.readFileSync(flags.spec, 'utf8'); } catch (e) { return unknown(`cannot read spec ${flags.spec} (${e.code || e.name})`); }
  try { spec = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text); } catch { return unknown(`spec: ${flags.spec} is not valid JSON`); }
  const result = await runSpec(spec, { cwd, logPath: flags.log, timeoutMs: flags.timeout === undefined ? undefined : Number(flags.timeout) * 1000 });
  return { code: { PASS: 0, FAIL: 1, UNKNOWN: 2 }[result.status], text: result.line + '\n' };
}

if (isMain(import.meta.url)) {
  const output = await validateCli(process.argv.slice(2)); process.stdout.write(output.text); process.exitCode = output.code;
}
