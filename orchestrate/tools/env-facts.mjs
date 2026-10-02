#!/usr/bin/env node
// Prints the environment facts a contract records, one line per fact in FACTS order. Every probe
// spawns a program directly with arguments, never through a shell, under a timeout; a program no
// PATH entry holds reads `absent`, a fact no probe could read `unknown`. The bash line names what
// orchestrate/tools/validate.mjs `resolveBash` would run. Probes are injectable (envFacts).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseFlags, isMain } from './git-evidence.mjs';
import { resolveBash } from './validate.mjs';

export const FACTS = ['os', 'node', 'git', 'bash', 'pwsh', 'powershell', 'python', 'tmpdir', 'repo'];
const TMPFS = ' — wiped at reboot; keep worktrees elsewhere';

const HELP = [
  'env-facts.mjs --repo <repo> — prints the environment facts a contract records. Exit 0, or 2 on invalid usage.',
  'One line per fact, in this order: os, node, git, bash, pwsh, powershell (Windows only), python, tmpdir, repo.',
  'bash is the one validate.mjs would run, as an absolute path; python is the first of python3, python and py -3 that runs.',
  'tmpdir and repo name their filesystem (Linux: the longest mount prefix in /proc/self/mounts); tmpfs adds "' + TMPFS.slice(3) + '".',
  'A tool no PATH entry holds reads `absent`; a fact no probe could read reads `unknown`. Every probe runs a program directly, never a shell, under a timeout.',
].join('\n');

// How every real probe spawns: a program and its arguments, never a shell, under a timeout.
export const SPAWN_OPTIONS = Object.freeze({ encoding: 'utf8', shell: false, windowsHide: true, timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] });
// The machine as this process sees it. Each member is replaced by a test to stand in for another
// platform, environment, program set or mount table; spawn (node:child_process `spawnSync`'s
// signature) is replaced to see how run spawns.
export function realProbes(spawn = spawnSync) {
  return {
    platform: process.platform, release: os.release(), env: process.env, node: process.version, tmpdir: os.tmpdir(),
    run(file, args) {
      const r = spawn(file, args, SPAWN_OPTIONS);
      return { ok: !r.error && r.signal === null && r.status === 0, text: `${r.stdout ?? ''}\n${r.stderr ?? ''}` };
    },
    executable(file) {
      try { if (!fs.statSync(file).isFile()) return false; if (process.platform !== 'win32') fs.accessSync(file, fs.constants.X_OK); return true; } catch { return false; }
    },
    readText(file) { try { return fs.readFileSync(file, 'utf8'); } catch { return null; } },
    realpath(file) { try { return fs.realpathSync(file); } catch { return null; } },
    bash: env => resolveBash(env).bash,
  };
}

// The filesystem type of the longest mount point holding dir, read from the mounts text; `unknown`
// off Linux or when either the path or the table cannot be read.
export function filesystemOf(dir, mounts) {
  if (dir === null || mounts === null) return 'unknown';
  let best = null;
  for (const line of mounts.split('\n')) {
    const fields = line.split(' ');
    if (fields.length < 3) continue;
    const point = fields[1].replace(/\\([0-7]{3})/g, (_, octal) => String.fromCharCode(parseInt(octal, 8)));
    const holds = dir === point || dir.startsWith(point.endsWith('/') ? point : point + '/');
    if (holds && (!best || point.length >= best.point.length)) best = { point, type: fields[2] };
  }
  return best ? best.type : 'unknown';
}

export function envFacts({ repo, ...injected }) {
  const p = { ...realProbes(), ...injected }, win = p.platform === 'win32', paths = win ? path.win32 : path.posix;
  // Windows reads its environment case-folded; every other platform reads PATH by its exact name.
  const pathVar = (win ? Object.entries(p.env).find(([key]) => key.toUpperCase() === 'PATH')?.[1] : p.env.PATH) ?? '';
  const dirs = pathVar.split(win ? ';' : ':').map(d => win ? d.replace(/"/g, '') : d).filter(d => paths.isAbsolute(d));
  // The first executable file a PATH entry holds under the name, in PATH order.
  const which = name => {
    for (const dir of dirs) for (const ext of win ? ['.com', '.exe'] : ['']) { const file = paths.join(dir, name + ext); if (p.executable(file)) return file; }
    return null;
  };
  const versionOf = (file, args, pattern) => { const r = p.run(file, args); return (r.ok && pattern.exec(r.text)?.[1]) || 'unknown'; };
  const tool = (name, args, pattern) => { const file = which(name); return file ? `${file} ${versionOf(file, args, pattern)}` : 'absent'; };
  const fsLine = dir => { const type = p.platform === 'linux' ? filesystemOf(p.realpath(dir), p.readText('/proc/self/mounts')) : 'unknown'; return `${dir} ${type}${type === 'tmpfs' ? TMPFS : ''}`; };

  const facts = {};
  facts.os = `${p.platform} ${p.release}` + (p.platform === 'linux' && /microsoft/i.test(p.readText('/proc/version') ?? '') ? ' (WSL)' : '');
  facts.node = p.node;
  const gitFile = which('git');
  facts.git = gitFile ? versionOf(gitFile, ['--version'], /git version (\S+)/) : 'absent';
  const bash = p.bash(p.env), bashFile = !bash ? null : paths.isAbsolute(bash) ? bash : which(bash);
  facts.bash = bashFile ? `${bashFile} ${versionOf(bashFile, ['--version'], /version (\S+)/i)}` : 'absent';
  facts.pwsh = tool('pwsh', ['--version'], /PowerShell (\S+)/);
  if (win) facts.powershell = which('powershell') ?? 'absent';
  // The first of python3, python and py -3 that runs; the later ones are not spawned.
  facts.python = 'absent';
  for (const [name, extra] of [['python3', []], ['python', []], ['py', ['-3']]]) {
    const file = which(name);
    if (!file) continue;
    const version = versionOf(file, [...extra, '--version'], /Python (\S+)/);
    facts.python = version === 'unknown' ? 'unknown' : [file, ...extra, version].join(' ');
    if (version !== 'unknown') break;
  }
  facts.tmpdir = fsLine(p.tmpdir);
  facts.repo = fsLine(paths.isAbsolute(repo) ? repo : path.resolve(repo));
  // C0 and C1 controls, DEL and the Unicode line and paragraph separators print as `?`: one line per fact.
  return FACTS.filter(f => Object.hasOwn(facts, f)).map(f => `${f}: ${facts[f]}`.replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/g, '?'));
}

export function envFactsCli(args, injected = {}) {
  if (args.length === 1 && args[0] === '--help') return { code: 0, text: HELP + '\n' };
  let flags;
  try { flags = parseFlags(args, ['repo'], ['repo']); } catch { return { code: 2, text: 'UNKNOWN unknown, missing or duplicate flag; use --help\n' }; }
  let dir = false;
  try { dir = fs.statSync(flags.repo).isDirectory(); } catch { /* reported below */ }
  if (!dir) return { code: 2, text: 'UNKNOWN --repo is not a directory\n' };
  return { code: 0, text: envFacts({ repo: flags.repo, ...injected }).join('\n') + '\n' };
}

if (isMain(import.meta.url)) {
  const output = envFactsCli(process.argv.slice(2)); process.stdout.write(output.text); process.exitCode = output.code;
}
