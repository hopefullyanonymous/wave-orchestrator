#!/usr/bin/env node
// Runs a validate.mjs spec on a disposable checkout of any committed ref, so an agent that may
// not touch a worktree can see a suite at another commit: ONE line, `AT <short sha> <validate.mjs
// line>`, and validate.mjs's own exit code. The checkout is mutate.mjs's, removed afterwards.
import fs from 'node:fs';
import { parseFlags, isMain } from './git-evidence.mjs';
import { oneLine } from './check-ledger.mjs';
import { Unknown, CleanupFailed, withDisposableCheckout, openLog, runLogged, readJson, checkedSpec, topLevel, inside, timeoutOf, scrubLocalGitEnv } from './mutate.mjs';

const CODES = { PASS: 0, FAIL: 1, UNKNOWN: 2 };

// Inputs are already checked (the CLI does it); `remove` is the checkout's remover, a test seam.
export async function runAtRef({ repo, ref, validate, setup = null, logPath, timeoutMs, tmpRoot, remove }) {
  let log;
  try { log = openLog(logPath); } catch (e) { return { code: 2, line: `UNKNOWN ${e.message}` }; }
  try {
    return await withDisposableCheckout(repo, ref, async ({ dir, short, scratch, env }) => {
      const run = (label, spec) => runLogged(spec, { cwd: dir, log, label, scratch, timeoutMs, env });
      if (setup) {
        const done = await run('setup', setup);
        if (done.status !== 'PASS') return { code: 2, line: `AT ${short} UNKNOWN setup ${done.line}` };
      }
      const result = await run('validate', validate);
      return { code: CODES[result.status], line: `AT ${short} ${result.line}` };
    }, { tmpRoot, log, remove });
  } catch (e) {
    if (e instanceof CleanupFailed) return { code: 2, line: `${e.value.line} — UNKNOWN ${e.message}` };
    if (!(e instanceof Unknown)) throw e;
    return { code: 2, line: `UNKNOWN ${e.message}` };
  } finally { log.close(); }
}

const HELP = `run-at-ref.mjs --repo <repo> --ref <ref> --validate <spec.json> --log <file> [--setup <spec.json>] [--timeout <seconds>]
Runs a validate.mjs spec (see its --help) from the root of a disposable checkout of <ref>: a shared clone
under the temp directory, removed afterwards; the repository itself is never written. --setup runs first.
Prints ONE line, AT <short sha> <validate.mjs line>, and exits with validate.mjs's code: 0 PASS, 1 FAIL,
2 UNKNOWN. A setup that does not pass is AT <short sha> UNKNOWN setup <validate.mjs line>; anything that
stops the checkout is UNKNOWN <reason>. --log is written fresh by each invocation, both runs appending to it,
and must lie outside the repository. --timeout (whole seconds) applies per step. Git's repository variables
(git rev-parse --local-env-vars) are dropped from the environment first.`;

export async function runAtRefCli(args) {
  if (args.length === 1 && args[0] === '--help') return { code: 0, line: HELP };
  let flags;
  try { flags = parseFlags(args, ['repo', 'ref', 'validate', 'log', 'setup', 'timeout'], ['repo', 'ref', 'validate', 'log']); }
  catch { return { code: 2, line: 'UNKNOWN usage: unknown, missing or duplicate flag; use --help' }; }
  try {
    scrubLocalGitEnv();
    const timeoutMs = timeoutOf(flags.timeout);
    const validate = await checkedSpec(readJson(flags.validate, '--validate'), '--validate');
    const setup = flags.setup === undefined ? null : await checkedSpec(readJson(flags.setup, '--setup'), '--setup');
    const top = topLevel(flags.repo);
    if (inside(top, flags.log)) throw new Unknown(`usage: --log must lie outside the repository ${top}`);
    return await runAtRef({ repo: top, ref: flags.ref, validate, setup, logPath: flags.log, timeoutMs });
  } catch (e) { return { code: 2, line: `UNKNOWN ${e instanceof Unknown ? e.message : `internal error: ${e.message}`}` }; }
}

if (isMain(import.meta.url)) {
  // Exit 1 reads as "the suite failed", so a crash never ends with it: UNKNOWN, exit 2.
  process.on('uncaughtException', e => { fs.writeSync(1, oneLine(`UNKNOWN internal error: ${e?.message ?? e}`) + '\n'); process.exit(2); });
  const output = await runAtRefCli(process.argv.slice(2));
  process.stdout.write((output.line === HELP ? HELP : oneLine(output.line)) + '\n');
  process.exitCode = output.code;
}
