#!/usr/bin/env node
// Prints candidate interview answers read from the repository. Read-only: it runs no repository
// script, fetches nothing and writes nothing; the conductor confirms every candidate. Each key is a
// placeholder of orchestrate/references/scaffolding.md §Placeholder registry, except PRIOR_CONTRACT.
// An input it cannot read, or inputs that contradict each other, make the key that reads them
// unknown, never a guess.
import fs from 'node:fs';
import path from 'node:path';
import { git, parseFlags, isMain } from './git-evidence.mjs';
import { gitModel } from './ledger-parse.mjs';

export const KEYS = ['VALIDATION_COMMANDS', 'MUTATION_RUNNER', 'VERSION_FILES', 'CHANGELOG_RULE', 'MAIN_BRANCH', 'SHIPMENT_SOURCE', 'SHIPMENT_REF',
  'BRANCH_PREFIXES', 'GATE_AGENTS', 'BACKLOG_FILE', 'BACKLOG_ID_PREFIX', 'GUARDRAILS_REF', 'RELEASE_COMMAND', 'WORKTREE_SETUP', 'PRIOR_CONTRACT'];

const HELP = [
  'detect.mjs --repo <repo> [--format <lines|json>] — prints candidate interview answers read from the repository. Exit 0, or 2 on invalid usage.',
  'Read-only: it runs no repository script, fetches nothing and writes nothing. Every value is a candidate the conductor confirms.',
  'lines (the default): one line per key, `<NAME>: <value> — <source>`, or `<NAME>: unknown — <why>` when an input is missing, contradictory or unreadable.',
  'json: one object {"values": {...}, "sources": {...}} holding only the keys that have a value, ready for the values of an answers file.',
  'Keys: ' + KEYS.join(', ') + '. Each names a placeholder of references/scaffolding.md, except PRIOR_CONTRACT: the latest ledger contract in the working tree.',
  'origin/HEAD is read as a hint and used only when its target exists. Exit 2 with one UNKNOWN line on a bad flag or a --repo that is not a git work tree.',
].join('\n');

const decoder = new TextDecoder('utf-8', { fatal: true });
// C0 and C1 controls, DEL and the Unicode line and paragraph separators print as `?`: each key stays
// one line and carries nothing a terminal acts on.
const clean = text => String(text).replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/g, '?');
const tick = text => '`' + text + '`';
const found = (value, source) => ({ value, source });
const unknown = why => ({ why });

// Every filesystem read detect makes, each on an absolute path: an entry's lstat, a file's bytes and a
// directory's entries as fs.Dirent. A test replaces a member to fail one path as an unreadable one fails.
const FILES = { lstat: file => fs.lstatSync(file), read: file => fs.readFileSync(file), list: dir => fs.readdirSync(dir, { withFileTypes: true }) };

// The entry at one repository path: `absent` when nothing is there, `bad` when the lstat fails any
// other way, else its stat. A link is an entry of its own, never followed.
function entryAt(c, rel) {
  try { return { stat: c.io.lstat(path.join(c.root, rel)) }; }
  catch (e) { return e?.code === 'ENOENT' || e?.code === 'ENOTDIR' ? { absent: true } : { bad: `${rel} cannot be read` }; }
}
// One repository file: its text with LF breaks, `absent`, or `bad` naming why it cannot be read. A
// link or a directory where a file is expected is reported, not followed.
function readFile(c, rel) {
  const entry = entryAt(c, rel);
  if (!entry.stat) return entry;
  if (!entry.stat.isFile()) return { bad: `${rel} is not a regular file` };
  let bytes;
  try { bytes = c.io.read(path.join(c.root, rel)); } catch { return { bad: `${rel} cannot be read` }; }
  try { return { text: decoder.decode(bytes).replace(/\r\n/g, '\n') }; } catch { return { bad: `${rel} is not UTF-8 text` }; }
}
function readJson(c, rel) {
  const r = readFile(c, rel);
  if (r.text === undefined) return r;
  try { const json = JSON.parse(r.text); if (!json || typeof json !== 'object' || Array.isArray(json)) throw new Error(); return { json }; }
  catch { return { bad: `${rel} is not a JSON object` }; }
}

// Markdown ATX headings outside fenced code, in order, each with its line index. A fence closes only
// on a bare run of its own character at least as long as the run that opened it.
function headings(text) {
  const out = [];
  let fence = null;
  text.split('\n').forEach((line, at) => {
    const run = /^ {0,3}(`{3,}|~{3,})(.*)$/s.exec(line);
    if (fence) { if (run && run[1][0] === fence[0] && run[1].length >= fence.length && !run[2].trim()) fence = null; return; }
    if (run && !(run[1][0] === '`' && run[2].includes('`'))) { fence = run[1]; return; }
    const m = /^ {0,3}#{1,6}[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/s.exec(line);
    if (m && m[1]) out.push({ line, at, title: m[1] });
  });
  return out;
}
// The `version` the first of the named TOML sections sets: { value } for a basic or literal string,
// { bad } for any other value, null when none sets one. A dotted `version.workspace` key sets no
// version of its own.
function tomlVersion(text, sections, file) {
  let current = null;
  for (const line of text.split('\n')) {
    const h = /^\s*\[\[?([^\]]+)\]\]?\s*(?:#.*)?$/.exec(line);
    if (h) { current = h[1].trim(); continue; }
    const m = sections.includes(current) && /^\s*version\s*=\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    const s = /^(?:"([^"\\]*)"|'([^']*)')\s*(?:#.*)?$/.exec(m[1]);
    return s ? { value: s[1] ?? s[2] } : { bad: `${file} [${current}] version is not a string` };
  }
  return null;
}
// Recipe names of a justfile or Makefile: a rule line at column 0, never an assignment or a
// special target such as `.PHONY`.
const TARGET_LINE = { just: /^@?([A-Za-z0-9_-]+)(?:[ \t][^:\n]*)?:(?!=)/, make: /^([A-Za-z0-9_.-]+(?:[ \t]+[A-Za-z0-9_.-]+)*)[ \t]*:(?![:=])/ };
function targetsIn(text, kind) {
  const out = new Set();
  for (const line of text.split('\n')) {
    const m = TARGET_LINE[kind].exec(line);
    if (m) for (const name of m[1].split(/[ \t]+/)) if (!name.startsWith('.')) out.add(name);
  }
  return out;
}

// Compares two dotted versions numerically: negative, zero or positive.
function compareVersions(a, b) {
  const x = a.split('.').map(Number), y = b.split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0);
  return 0;
}
// The ordering CHANGELOG.md's first and last version headings imply.
export function changelogOrder(text) {
  const versioned = headings(text).map(h => ({ ...h, version: /\bv?(\d+\.\d+(?:\.\d+)?)\b/.exec(h.title)?.[1] })).filter(h => h.version);
  if (versioned.length < 2) return unknown('CHANGELOG.md holds fewer than two version headings');
  const first = versioned[0], last = versioned[versioned.length - 1], order = compareVersions(first.version, last.version);
  if (order === 0) return unknown(`CHANGELOG.md's first and last version headings both read ${first.version}`);
  const rule = order > 0 ? 'newest first: prepend at the top' : 'oldest first: append at the bottom';
  return found(`${tick('CHANGELOG.md')}, ${rule}, headings like ${tick(first.line)}`, `CHANGELOG.md headings: first ${first.version}, last ${last.version}`);
}

// An agent definition's `name:`, `tools:` and `description:`, or null. Only a frontmatter every YAML
// reader reads the same way is accepted: a leading `---` block of single-line `key: value` entries, no
// key twice, each key and value a plain scalar provably read as the string it spells. Such a scalar
// opens with an ASCII letter, holds printable characters only, never `: `, a final `:` or ` #`, and is
// none of the words YAML 1.1 or 1.2 reads as a null or a boolean. Anything else is doubt: null.
const YAML_WORDS = /^(?:null|Null|NULL|true|True|TRUE|false|False|FALSE|yes|Yes|YES|no|No|NO|on|On|ON|off|Off|OFF|y|Y|n|N)$/;
const PLAIN = /^[A-Za-z][\x20-\x7e\u00a0-\u2027\u202a-\ud7ff\ue000-\ufefe\uff00-\ufffd\u{10000}-\u{10ffff}]*$/u;
export function frontmatter(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n'), end = lines.indexOf('---', 1);
  if (lines[0] !== '---' || end < 0) return null;
  const fields = {};
  for (const line of lines.slice(1, end)) {
    if (line === '') continue;
    const m = /^([A-Za-z_][A-Za-z0-9_-]*): +(\S.*)$/s.exec(line);
    if (!m || Object.hasOwn(fields, m[1]) || YAML_WORDS.test(m[1])) return null;
    const value = m[2].replace(/ +$/, '');
    if (!PLAIN.test(value) || YAML_WORDS.test(value) || /: |:$| #/.test(value)) return null;
    fields[m[1]] = value;
  }
  return fields.name && fields.tools && fields.description ? { name: fields.name, tools: fields.tools, description: fields.description } : null;
}
export const REVIEW_WORDS = ['review', 'audit', 'hunt', 'check'];
const REVIEW_SHAPED = new RegExp(`\\b(?:${REVIEW_WORDS.join('|')})(?:s|ed|ing|ers?|ors?)?\\b`, 'i');

// The most frequent id prefix (capitals and a hyphen before digits) across the backlog files, and the
// file holding most of its uses.
export function idPrefix(files) {
  const totals = new Map(), per = [];
  for (const { name, text } of files) {
    const counts = new Map();
    for (const m of text.matchAll(/\b([A-Z]+-)\d+/g)) counts.set(m[1], (counts.get(m[1]) || 0) + 1);
    for (const [prefix, n] of counts) totals.set(prefix, (totals.get(prefix) || 0) + n);
    per.push({ name, counts });
  }
  const ranked = [...totals].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  if (!ranked.length) return null;
  const prefix = ranked[0][0], home = per.reduce((best, f) => (f.counts.get(prefix) || 0) > (best.counts.get(prefix) || 0) ? f : best);
  return { prefix, file: home.name };
}

export const SCRIPT_CHECKS = ['lint', 'format:check', 'typecheck', 'check', 'test'];
export const TARGET_CHECKS = ['lint', 'format-check', 'fmt-check', 'typecheck', 'check', 'test'];
export const RELEASE = ['build', 'release', 'package'];
// The names GNU make reads a Makefile under, in its order.
const MAKEFILES = ['GNUmakefile', 'makefile', 'Makefile'];
export const LOCKS = [['package-lock.json', 'npm ci'], ['npm-shrinkwrap.json', 'npm ci'], ['pnpm-lock.yaml', 'pnpm install'], ['yarn.lock', 'yarn install'],
  ['Cargo.lock', 'cargo fetch'], ['uv.lock', 'uv sync'], ['requirements.txt', 'pip install -r requirements.txt'], ['go.sum', 'go mod download']];
// The package manager a package.json script runs under, named by the lockfile it keeps.
export const MANAGERS = [['package-lock.json', 'npm'], ['npm-shrinkwrap.json', 'npm'], ['pnpm-lock.yaml', 'pnpm'], ['yarn.lock', 'yarn']];

// The manifests several keys read, each read once. `bad` maps an input to why it cannot be read;
// each key consults only the inputs it reads (badOf).
function manifests(c) {
  const bad = {}, take = (label, r) => { if (r.bad) bad[label] = r.bad; return r; };
  const pkg = take('package.json', readJson(c, 'package.json')), json = pkg.json ?? {};
  // npm reads `scripts` as an object of strings and `version` as a string; any other shape is reported.
  let scripts = {};
  if (json.scripts !== undefined) {
    if (json.scripts && typeof json.scripts === 'object' && !Array.isArray(json.scripts)) scripts = json.scripts;
    else bad.scripts = 'package.json scripts is not an object';
  }
  const odd = [...SCRIPT_CHECKS, ...RELEASE].find(s => Object.hasOwn(scripts, s) && typeof scripts[s] !== 'string');
  if (odd) bad.scripts = `package.json scripts.${odd} is not a string`;
  if (json.version !== undefined && typeof json.version !== 'string') bad.version = 'package.json version is not a string';
  // Lockfiles of two package managers contradict each other; with none, npm runs the scripts.
  const locks = MANAGERS.map(([file, manager]) => ({ file, manager, entry: entryAt(c, file) })), held = locks.filter(l => l.entry.stat);
  const managers = [...new Set(held.map(l => l.manager))], unreadable = locks.find(l => l.entry.bad);
  const pm = unreadable ? { bad: unreadable.entry.bad } : managers.length > 1 ? { bad: `lockfiles of more than one package manager: ${held.map(l => l.file).join(', ')}` } : { name: managers[0] ?? 'npm' };
  // The justfile and Makefile each tool would read, named as the root listing spells them, so a
  // case-folding volume (NTFS, APFS) reports what a case-sensitive one does. just reads the one entry
  // named justfile or .justfile in any ASCII case (without `u`, an `i` flag folds no other letter onto
  // an ASCII one) and refuses two; make, the first of MAKEFILES the listing holds under exactly that name.
  const targets = {};
  let atRoot = [];
  try { atRoot = c.io.list(c.root).map(e => e.name); } catch { bad.targets = 'the repository root cannot be listed'; }
  const justfiles = atRoot.filter(n => /^\.?justfile$/i.test(n)).sort();
  if (justfiles.length > 1) bad.targets = `more than one justfile: ${justfiles.join(', ')}`;
  for (const [kind, name] of [['just', justfiles.length === 1 && justfiles[0]], ['make', MAKEFILES.find(n => atRoot.includes(n))]]) {
    if (!name) continue;
    const r = readFile(c, name);
    if (r.text === undefined) bad.targets = r.bad ?? `${name} cannot be read`; else targets[kind] = { name, set: targetsIn(r.text, kind) };
  }
  const text = rel => take(rel, readFile(c, rel)).text ?? null;
  const m = { bad, pkg, scripts, pm, targets, cargo: text('Cargo.toml'), pyproject: text('pyproject.toml'), goMod: text('go.mod'), readme: text('README.md'), monorepo: null };
  // Two or more package.json files outside node_modules, or a workspaces declaration, is a monorepo.
  // The index and the untracked files are listed; only those the working tree still holds count.
  const listed = c.git(['ls-files', '-z', '--cached', '--others', '--exclude-standard']);
  if (!listed.ok) bad['ls-files'] = 'git ls-files failed';
  const packages = [];
  for (const file of listed.ok ? listed.text.split('\0') : []) {
    if (!/(?:^|\/)package\.json$/.test(file) || file.split('/').includes('node_modules')) continue;
    const entry = entryAt(c, file);
    if (entry.bad) { bad.packages = entry.bad; break; }
    if (entry.stat) packages.push(path.posix.dirname(file));
  }
  const workspace = entryAt(c, 'pnpm-workspace.yaml');
  if (workspace.bad && !bad.packages) bad.packages = workspace.bad;
  const nested = packages.filter(d => d !== '.').sort();
  if (packages.length >= 2 || json.workspaces !== undefined || workspace.stat) m.monorepo = 'monorepo: ' + (nested.length ? 'packages ' + nested.join(', ') : 'a workspaces declaration') + ' — the package in scope is to confirm';
  return m;
}
// Why the named inputs cannot be read, each reason once: one file can be read as several inputs.
const badOf = (m, labels) => [...new Set(labels.map(l => m.bad[l]).filter(Boolean))];

function validationCommands(m) {
  const bad = badOf(m, ['package.json', 'scripts', 'targets', 'Cargo.toml', 'pyproject.toml', 'go.mod', 'README.md', 'ls-files', 'packages']);
  if (bad.length) return unknown(bad.join('; '));
  const commands = [], sources = [];
  const scripts = SCRIPT_CHECKS.filter(s => Object.hasOwn(m.scripts, s));
  if (scripts.length) {
    if (m.pm.bad) return unknown(m.pm.bad);
    commands.push(...scripts.map(s => `${m.pm.name} run --silent ${s}`)); sources.push('package.json scripts');
  }
  for (const [kind, t] of Object.entries(m.targets)) {
    const hits = TARGET_CHECKS.filter(n => t.set.has(n));
    if (hits.length) { commands.push(...hits.map(n => kind === 'make' ? `make -s ${n}` : `just ${n}`)); sources.push(`${t.name} targets`); }
  }
  if (m.cargo !== null) { commands.push('cargo fmt --check', 'cargo clippy', 'cargo test -q'); sources.push('Cargo.toml'); }
  if (m.pyproject !== null) {
    const py = [/\bruff\b/.test(m.pyproject) && 'ruff check', /\bpytest\b/.test(m.pyproject) && 'pytest'].filter(Boolean);
    if (py.length) { commands.push(...py); sources.push('pyproject.toml'); }
  }
  if (m.goMod !== null) { commands.push('go vet ./...', 'go test ./...'); sources.push('go.mod'); }
  // A README section that names a validation recipe and holds a code block is a source of its own.
  let recipe = null;
  if (m.readme !== null) {
    const lines = m.readme.split('\n'), marks = headings(m.readme);
    for (let i = 0; i < marks.length && recipe === null; i++) {
      const body = lines.slice(marks[i].at + 1, i + 1 < marks.length ? marks[i + 1].at : lines.length).join('\n');
      if (/\bvalidation (?:recipe|commands?)\b/i.test(body) && /^ {0,3}(?:```|~~~)/m.test(body)) recipe = marks[i].title;
    }
  }
  if (recipe !== null) sources.push(`README.md §${recipe}`);
  if (m.monorepo) sources.push(m.monorepo);
  if (commands.length) return found(commands.map(tick).join(', '), sources.join('; '));
  if (recipe !== null) return found(`the recipe in ${tick('README.md')} §${recipe}`, sources.join('; '));
  return unknown('no package.json check script, justfile or Makefile check target, Cargo.toml, pyproject.toml naming ruff or pytest, go.mod, or README validation recipe' + (m.monorepo ? '; ' + m.monorepo : ''));
}

function mutationRunner(c, m) {
  const reads = Object.fromEntries(['setup.cfg', 'pom.xml', 'build.gradle', 'build.gradle.kts'].map(f => [f, readFile(c, f)]));
  const mutants = ['.cargo/mutants.toml', 'mutants.toml'].map(file => ({ file, entry: entryAt(c, file) }));
  const bad = [...badOf(m, ['pyproject.toml', 'Cargo.toml']), ...Object.values(reads).map(r => r.bad), ...mutants.map(x => x.entry.bad)].filter(Boolean);
  if (bad.length) return unknown(bad.join('; '));
  let listing;
  try { listing = c.io.list(c.root).filter(e => !e.isDirectory()).map(e => e.name).sort(); } catch { return unknown('the repository root cannot be listed'); }
  const hits = [], sources = [], hit = (command, source) => { hits.push(command); sources.push(source); };
  const stryker = listing.find(n => /^stryker\.conf(?:ig)?\./.test(n));
  if (stryker) hit('npx stryker run --mutate <changed files>', stryker);
  if (m.pyproject !== null && /^\[tool\.mutmut\]/m.test(m.pyproject)) hit('mutmut run --paths-to-mutate <changed files>', 'pyproject.toml [tool.mutmut]');
  else if (/^\[mutmut\]/m.test(reads['setup.cfg'].text ?? '')) hit('mutmut run --paths-to-mutate <changed files>', 'setup.cfg [mutmut]');
  const held = mutants.find(x => x.entry.stat)?.file;
  if (held || /cargo-mutants/.test(m.cargo ?? '')) hit('cargo mutants --file <changed files>', held || 'Cargo.toml');
  if (/pitest/.test(reads['pom.xml'].text ?? '')) hit('mvn org.pitest:pitest-maven:mutationCoverage -DtargetClasses=<changed classes>', 'pom.xml (PIT plugin)');
  const gradle = ['build.gradle', 'build.gradle.kts'].find(f => /pitest/.test(reads[f].text ?? ''));
  if (gradle) hit('gradle pitest', `${gradle} (PIT plugin)`);
  return hits.length ? found(hits.map(tick).join(', '), sources.join('; ')) : found('none', 'default: no Stryker, mutmut, cargo-mutants or PIT configuration');
}

function versionFiles(c, m) {
  const manifest = readJson(c, 'manifest.json'), version = readFile(c, 'VERSION'), line = version.text?.trim();
  const cargo = m.cargo === null ? null : tomlVersion(m.cargo, ['package', 'workspace.package'], 'Cargo.toml');
  const py = m.pyproject === null ? null : tomlVersion(m.pyproject, ['project', 'tool.poetry'], 'pyproject.toml');
  const bad = [...badOf(m, ['package.json', 'version', 'Cargo.toml', 'pyproject.toml']), manifest.bad, version.bad, cargo?.bad, py?.bad,
    manifest.json?.version !== undefined && typeof manifest.json.version !== 'string' && 'manifest.json version is not a string',
    line === '' && 'VERSION is empty', line?.includes('\n') && 'VERSION holds more than one line'].filter(Boolean);
  if (bad.length) return unknown(bad.join('; '));
  const hits = [];
  if (typeof m.pkg.json?.version === 'string') hits.push(['package.json', m.pkg.json.version]);
  if (typeof manifest.json?.version === 'string') hits.push(['manifest.json', manifest.json.version]);
  if (cargo) hits.push(['Cargo.toml', cargo.value]);
  if (py) hits.push(['pyproject.toml', py.value]);
  if (line) hits.push(['VERSION', line]);
  return hits.length ? found(hits.map(([file, v]) => `${tick(file)} ${v}`).join(', '), 'version fields in ' + hits.map(([file]) => file).join(', '))
    : found('none', 'default: no version field in package.json, manifest.json, Cargo.toml, pyproject.toml or VERSION');
}

function changelogRule(c) {
  const r = readFile(c, 'CHANGELOG.md');
  if (r.absent) return found('none', 'default: no CHANGELOG.md');
  return r.bad ? unknown(r.bad) : changelogOrder(r.text);
}

// Default branch and shipment target. origin/HEAD (hint: its `git symbolic-ref` target, null when it
// is no symbolic ref, false when git could not say) is a cached hint: used only when the ref it names
// exists and origin is a remote; with any remote and no usable hint, or no remote and both or neither
// of main and master locally, the three keys are unknown.
function shipment(refs, remotes, hint) {
  const all = why => ({ MAIN_BRANCH: unknown(why), SHIPMENT_SOURCE: unknown(why), SHIPMENT_REF: unknown(why) });
  if (!refs || !remotes) return all('git could not list refs or remotes');
  if (hint === false) return all('git could not read refs/remotes/origin/HEAD');
  if (hint === null && refs.some(r => r.ref === 'refs/remotes/origin/HEAD')) return all('refs/remotes/origin/HEAD is not a symbolic ref');
  if (hint !== null) {
    const prefix = 'refs/remotes/origin/';
    if (!hint.startsWith(prefix)) return all(`refs/remotes/origin/HEAD names ${hint}, outside ${prefix}`);
    if (!refs.some(r => r.ref === hint && !r.symref)) return all(`refs/remotes/origin/HEAD names ${hint}, which is not an existing branch`);
    if (!remotes.includes('origin')) return all('refs/remotes/origin/HEAD is set, but origin is not a remote');
    const name = hint.slice(prefix.length), source = `refs/remotes/origin/HEAD → ${hint}`;
    return { MAIN_BRANCH: found(`refs/heads/${name}`, source), SHIPMENT_SOURCE: found('remote origin', source), SHIPMENT_REF: found(`refs/heads/${name}`, source) };
  }
  if (remotes.length) return all(`remote ${remotes.join(', ')} but no refs/remotes/origin/HEAD`);
  const local = ['main', 'master'].filter(n => refs.some(r => r.ref === `refs/heads/${n}` && !r.symref));
  if (local.length !== 1) return all(local.length ? 'no remote, and both refs/heads/main and refs/heads/master exist' : 'no remote, and neither refs/heads/main nor refs/heads/master exists');
  const source = `no remote; refs/heads/${local[0]} exists locally`;
  return { MAIN_BRANCH: found(`refs/heads/${local[0]}`, source), SHIPMENT_SOURCE: found('local', source), SHIPMENT_REF: found(`refs/heads/${local[0]}`, source) };
}

// Branch names under refs/heads/ and refs/remotes/<remote>/, each counted once however many places hold it.
function branchPrefixes(refs, remotes) {
  if (!refs || !remotes) return unknown('git could not list refs or remotes');
  const names = new Set(), byLength = [...remotes].sort((a, b) => b.length - a.length);
  for (const { ref, symref } of refs) {
    if (symref) continue;
    if (ref.startsWith('refs/heads/')) names.add(ref.slice(11));
    else { const remote = byLength.find(r => ref.startsWith(`refs/remotes/${r}/`)); if (remote) names.add(ref.slice(`refs/remotes/${remote}/`.length)); }
  }
  const counts = new Map();
  for (const name of names) if (name.includes('/')) { const p = name.slice(0, name.indexOf('/') + 1); counts.set(p, (counts.get(p) || 0) + 1); }
  const kept = [...counts].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  return kept.length ? found(kept.map(([p]) => p).join(' '), 'branch names under refs/heads/ and refs/remotes/')
    : found('fix/ feat/ chore/', 'default: no branch prefix used twice under refs/heads/ or refs/remotes/');
}

// Each .md definition under .claude/agents with its tools and whether its description is
// review-shaped. A nested one is walked to and marked, since a build that recurses loads it; a link
// below the directory that is no definition is doubt. A definition whose name differs from its path
// shows the name the agent is spawned by.
function gateAgents(c) {
  const top = '.claude/agents', entry = entryAt(c, top), none = found('reviewer only', 'default: no .md file under .claude/agents/');
  if (entry.absent) return none;
  if (entry.bad) return unknown(entry.bad);
  if (!entry.stat.isDirectory()) return unknown(`${top} is not a directory`);
  const files = [];
  const walk = dir => {
    let entries;
    try { entries = c.io.list(path.join(c.root, dir)); } catch { return `${dir} cannot be listed`; }
    for (const e of entries) {
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) { const why = walk(rel); if (why) return why; }
      else if (e.name.endsWith('.md')) files.push(rel);
      else if (e.isSymbolicLink()) return `${rel} is a link, not followed`;
    }
    return null;
  };
  const why = walk(top);
  if (why) return unknown(why);
  if (!files.length) return none;
  const items = files.sort().map(rel => {
    const r = readFile(c, rel), f = r.text === undefined ? null : frontmatter(r.text), id = rel.slice(top.length + 1, -3), nested = id.includes('/') ? 'nested; ' : '';
    if (!f) return `${id} (${nested}unparsed)`;
    return `${id} (${nested}${f.name === id ? '' : `name: ${f.name}; `}tools: ${f.tools}; ${REVIEW_SHAPED.test(f.description) ? 'review-shaped' : 'not review-shaped'})`;
  });
  return found(items.join('; '), `${top}/**/*.md frontmatter`);
}

export const BACKLOG_NAMES = ['BACKLOG', 'TODO', 'BUGS', 'FEATURE'];
function backlog(c) {
  const both = why => ({ BACKLOG_FILE: unknown(why), BACKLOG_ID_PREFIX: unknown(why) });
  let entries;
  try { entries = c.io.list(c.root); } catch { return both('the repository root cannot be listed'); }
  const group = n => BACKLOG_NAMES.findIndex(p => n.toUpperCase().startsWith(p));
  // A directory of such a name (a BDD `features/`) is no backlog; a link or any other entry that is
  // not a regular file is reported, not followed.
  const named = entries.filter(e => group(e.name) >= 0 && !e.isDirectory()), odd = named.find(e => !e.isFile());
  if (odd) return both(`${odd.name} is not a regular file`);
  const files = named.map(e => e.name).sort((a, b) => group(a) - group(b) || (a < b ? -1 : 1));
  if (!files.length) return { BACKLOG_FILE: found(tick('BACKLOG.md') + ' (create on first residual)', 'default: no root BACKLOG*, TODO*, BUGS* or FEATURE* file'), BACKLOG_ID_PREFIX: found('BL-', 'default: no backlog file') };
  const others = files.length > 1 ? ` (also ${files.slice(1).join(', ')})` : '';
  const texts = files.map(name => ({ name, ...readFile(c, name) })), bad = texts.filter(t => t.text === undefined);
  const file = found(tick(files[0]), `root file ${files[0]}${others}`);
  if (bad.length) return { BACKLOG_FILE: file, BACKLOG_ID_PREFIX: unknown(bad.map(t => t.bad).join('; ')) };
  const id = idPrefix(texts);
  return { BACKLOG_FILE: file, BACKLOG_ID_PREFIX: id ? found(id.prefix, id.file) : found('BL-', `default: no id in ${files.join(', ')}`) };
}

function guardrailsRef(c) {
  const r = readFile(c, 'CLAUDE.md');
  if (r.bad) return unknown(r.bad);
  const heading = r.text === undefined ? null : headings(r.text).find(h => /guardrail/i.test(h.title));
  return heading ? found(`${tick('CLAUDE.md')} §${heading.title}`, 'CLAUDE.md heading')
    : found('the project guardrails doc (none yet — create a CLAUDE.md guardrails section at first distill)', 'default: no CLAUDE.md heading names guardrails');
}

function releaseCommand(m) {
  const bad = badOf(m, ['package.json', 'scripts', 'targets']);
  if (bad.length) return unknown(bad.join('; '));
  const scripts = RELEASE.filter(s => Object.hasOwn(m.scripts, s)), hits = [], sources = [];
  if (scripts.length) {
    if (m.pm.bad) return unknown(m.pm.bad);
    hits.push(...scripts.map(s => `${m.pm.name} run ${s}`)); sources.push('package.json scripts');
  }
  for (const [kind, t] of Object.entries(m.targets)) {
    const names = RELEASE.filter(n => t.set.has(n));
    if (names.length) { hits.push(...names.map(n => `${kind} ${n}`)); sources.push(`${t.name} targets`); }
  }
  return hits.length ? found(hits.map(tick).join(', '), sources.join('; ')) : found('none', 'default: no build, release or package script or target');
}

// The setup the lockfiles name; lockfiles of two package managers contradict each other here too.
function worktreeSetup(c, m) {
  const locks = LOCKS.map(([file, command]) => ({ file, command, entry: entryAt(c, file) }));
  const bad = [...new Set([...locks.map(l => l.entry.bad), m.pm.bad].filter(Boolean))];
  if (bad.length) return unknown(bad.join('; '));
  const hits = locks.filter(l => l.entry.stat), commands = [...new Set(hits.map(l => l.command))];
  return commands.length ? found(commands.map(tick).join(', '), hits.map(l => l.file).join(', ')) : found('n/a', 'default: none of ' + LOCKS.map(([file]) => file).join(', '));
}

// The latest ledger contract in the working tree, ordered by the date in its id and then the id; the
// latest contract whose integration branch is checked out is this worktree's own and wins. A ledger
// area or contract that cannot be read, or a Git model that cannot be compared with the checked-out
// branch before an own contract is found, could hide the answer: the key is then unknown.
function priorContract(c) {
  const candidates = [];
  for (const area of ['.agents/changes', '.agents/archive']) {
    const entry = entryAt(c, area);
    if (entry.absent) continue;
    if (entry.bad) return unknown(entry.bad);
    if (!entry.stat.isDirectory()) return unknown(`${area} is not a directory`);
    let dirs;
    try { dirs = c.io.list(path.join(c.root, area)); } catch { return unknown(`${area} cannot be listed`); }
    for (const d of dirs) {
      if (d.isSymbolicLink()) return unknown(`${area}/${d.name} is a link, not followed`);
      if (!d.isDirectory()) continue;
      const rel = `${area}/${d.name}/00-READBEFORE.md`, r = readFile(c, rel);
      if (r.bad) return unknown(r.bad);
      if (r.text !== undefined) candidates.push({ id: d.name, rel, text: r.text, date: /(?:^|-)(\d{8})(?:-|$)/.exec(d.name)?.[1] ?? '' });
    }
  }
  if (!candidates.length) return unknown('no 00-READBEFORE.md under .agents/changes/ or .agents/archive/');
  candidates.sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  // `git symbolic-ref --quiet HEAD` exits 1 on a detached HEAD, which has no branch to compare.
  const head = c.git(['symbolic-ref', '--quiet', 'HEAD']);
  if (!head.ok && head.exit !== 1) return unknown('git could not read HEAD');
  const branch = head.ok ? head.text.trim().replace(/^refs\/heads\//, '') : null;
  if (branch) {
    for (const cand of [...candidates].reverse()) {
      let integration;
      try { integration = gitModel(cand.text).integration; } catch { return unknown(`${cand.rel} holds no Git model to compare with the checked-out branch ${branch}`); }
      if (integration?.replace(/^refs\/heads\//, '') === branch) return found(cand.rel, `its integration branch ${branch} is checked out`);
    }
  }
  return found(candidates[candidates.length - 1].rel, 'latest by the date in its id, of .agents/changes/ and .agents/archive/');
}

// The detection core: { root, keys } with one entry per KEYS name, each { value, source } or { why };
// { root: null } when repo is not a git work tree. env reaches every git probe. A test replaces the
// probe itself (git, called as orchestrate/tools/git-evidence.mjs `git` is) or a member of io (FILES).
export function detect({ repo, env, git: probe = git, io = {} }) {
  const run = args => probe(repo, args, { env });
  const inside = run(['rev-parse', '--is-inside-work-tree']), top = inside.ok && inside.text.trim() === 'true' ? run(['rev-parse', '--show-toplevel']) : null;
  if (!top?.ok || !top.text.trim()) return { root: null, keys: {} };
  const root = path.resolve(top.text.trim()), c = { root, io: { ...FILES, ...io }, git: args => probe(root, args, { env }) };
  const listed = c.git(['for-each-ref', '--format=%(refname)%00%(symref)', 'refs/heads/', 'refs/remotes/']), remoteList = c.git(['remote']);
  const refs = listed.ok ? listed.text.split('\n').filter(Boolean).map(l => { const [ref, symref] = l.split('\0'); return { ref, symref: symref || '' }; }) : null;
  const remotes = remoteList.ok ? remoteList.text.split('\n').filter(Boolean) : null;
  // `git symbolic-ref --quiet` exits 1 when the ref is missing or no symbolic ref; any other failure is git's.
  const symbolic = c.git(['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']);
  const hint = symbolic.ok && symbolic.text.trim() ? symbolic.text.trim() : !symbolic.ok && symbolic.exit === 1 ? null : false;
  const m = manifests(c);
  const keys = {
    VALIDATION_COMMANDS: validationCommands(m), MUTATION_RUNNER: mutationRunner(c, m), VERSION_FILES: versionFiles(c, m), CHANGELOG_RULE: changelogRule(c),
    ...shipment(refs, remotes, hint), BRANCH_PREFIXES: branchPrefixes(refs, remotes), GATE_AGENTS: gateAgents(c), ...backlog(c),
    GUARDRAILS_REF: guardrailsRef(c), RELEASE_COMMAND: releaseCommand(m), WORKTREE_SETUP: worktreeSetup(c, m), PRIOR_CONTRACT: priorContract(c),
  };
  return { root, keys: Object.fromEntries(KEYS.map(k => [k, keys[k]])) };
}

export function renderLines({ keys }) {
  return KEYS.map(k => clean(keys[k].why === undefined ? `${k}: ${keys[k].value} — ${keys[k].source}` : `${k}: unknown — ${keys[k].why}`)).join('\n') + '\n';
}
export function renderJson({ keys }) {
  const has = KEYS.filter(k => keys[k].why === undefined);
  return { values: Object.fromEntries(has.map(k => [k, clean(keys[k].value)])), sources: Object.fromEntries(has.map(k => [k, clean(keys[k].source)])) };
}

export function detectCli(args, options = {}) {
  if (args.length === 1 && args[0] === '--help') return { code: 0, text: HELP + '\n' };
  let flags;
  try { flags = parseFlags(args, ['repo', 'format'], ['repo']); if (flags.format !== undefined && !['lines', 'json'].includes(flags.format)) throw new Error(); }
  catch { return { code: 2, text: 'UNKNOWN unknown, missing or duplicate flag, or a --format other than lines or json; use --help\n' }; }
  const result = detect({ repo: flags.repo, ...options });
  if (!result.root) return { code: 2, text: 'UNKNOWN --repo is not a git work tree\n' };
  return { code: 0, text: flags.format === 'json' ? JSON.stringify(renderJson(result)) + '\n' : renderLines(result) };
}

if (isMain(import.meta.url)) {
  const output = detectCli(process.argv.slice(2)); process.stdout.write(output.text); process.exitCode = output.code;
}
