#!/usr/bin/env node
// Read-only facts, never a workflow classifier. Every dependent Git probe uses captured objects.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const decoder = new TextDecoder('utf-8', { fatal: true });
const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const contracts = ['00-READBEFORE.md', '02-batches-00-READBEFORE.md', '03-tasks-00-READBEFORE.md', '01-plan.md', '02-plan.md'];
export const diagnostic = (code, message, context = {}) => ({ code, message, ...context });
export const validId = id => typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(id) && !id.includes('..');
export const validPath = p => typeof p === 'string' && p.length > 0 && !/^[\/]|[\\\x00-\x1f\x7f:*?\[\]`|]/.test(p) && p.split('/').every(x => x && x !== '.' && x !== '..');
export const validFullRef = ref => typeof ref === 'string' && /^refs\/(?:heads|remotes)\//.test(ref) && !/[\s~^:?*\[\\\x00-\x1f]|\.\.|@\{|\/\//.test(ref) && !/[/.]$/.test(ref);
function safeRef(ref) { return typeof ref === 'string' && ref.length > 0 && !ref.startsWith('-') && !/[\x00-\x20\x7f]/.test(ref); }
export function decode(bytes) { return decoder.decode(bytes); }

// A tool runs its CLI only as the entry script. Node resolves the entry's import.meta.url through
// links but leaves process.argv[1] as typed, so both sides are resolved: through a linked directory
// or file (an installed skill) a tool runs as it does in place. Imported under another file name it
// is a library; a mismatch under its own name never exits 0 unrun, which a gate reads as PASS.
export function isMain(moduleUrl) {
  const entry = process.argv[1], self = fileURLToPath(moduleUrl);
  if (!entry) return false;
  let real = null;
  try { real = fs.realpathSync(entry); } catch { /* an argument, not a file (node -e): no entry */ }
  if (real === fs.realpathSync(self)) return true;
  if (path.basename(entry) !== path.basename(self)) return false;
  fs.writeSync(2, `${path.basename(self)}: not run: the entry script ${entry} does not resolve to this module ${self}`.replace(/[\x00-\x1f\x7f]/g, '?') + '\n');
  process.exit(2);
}

// The variables that tie git to one repository, as git itself lists them (`git rev-parse
// --local-env-vars`), never a copy of that list. Git is asked with no GIT_* variable set, so none
// of them can bend its answer. It throws when the list is empty or names a non-variable.
let localVars = null;
export function localGitVars() {
  if (localVars) return localVars;
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)));
  const r = spawnSync('git', ['rev-parse', '--local-env-vars'], { env, encoding: 'utf8', shell: false, windowsHide: true, timeout: 15000 });
  const names = !r.error && r.status === 0 ? r.stdout.split(/\r?\n/).filter(Boolean) : [];
  if (!names.length || names.some(name => !/^GIT_[A-Z0-9_]+$/.test(name))) throw new Error('git did not list the variables that tie it to a repository (git rev-parse --local-env-vars)');
  return (localVars = names);
}
// Every probe reads the repository it was given: an inherited GIT_DIR or GIT_INDEX_FILE (git
// exports them to hooks) would point it at another, so git's repository-location variables are
// dropped, names compared case-folded (Windows). Its config-injection ones (GIT_CONFIG*) stay: an
// injected setting is surfaced as a failed probe, never hidden.
export function repositoryEnv(env) {
  const drop = new Set(localGitVars().filter(name => !/^GIT_CONFIG(?:_|$)/.test(name)));
  return Object.fromEntries(Object.entries(env).filter(([key]) => !drop.has(key.toUpperCase())));
}

export function git(repo, args, options = {}) {
  let env;
  try { env = repositoryEnv(options.env ?? process.env); }
  catch { return { ok: false, exit: null, text: null, diagnostic: diagnostic('git-probe', 'Git did not list its repository variables; probe not run', { command: args[0], exit: null, error: 'local-env-vars' }) }; }
  const result = spawnSync('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', ...args], {
    cwd: repo, env: { ...env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1' },
    ...(options.input === undefined ? {} : { input: options.input }),
    shell: false, windowsHide: true, timeout: 15000, maxBuffer: 16 * 1024 * 1024,
  });
  // Git's stderr can contain a remote URL, including credentials. Do not publish it.
  const failure = diagnostic('git-probe', 'Git probe failed; stderr withheld to protect remote credentials', {
    command: args[0], exit: result.status, ...(result.error ? { error: result.error.code || 'launch-error' } : {}),
    ...(result.signal ? { signal: result.signal } : {}),
  });
  try { return { ok: !result.error && result.signal === null && result.status === 0, exit: result.status, text: decode(result.stdout || Buffer.alloc(0)), bytes: result.stdout, stderrPresent: Boolean(result.stderr?.length), diagnostic: failure }; }
  catch { return { ok: false, exit: result.status, text: null, diagnostic: diagnostic('invalid-encoding', 'Git output is not valid UTF-8', { command: args[0], exit: result.status }) }; }
}
export function capture(repo, ref, diagnostics, options = {}) {
  if (!safeRef(ref)) { diagnostics.push(diagnostic('invalid-ref', 'Expected a non-option Git revision')); return null; }
  const r = git(repo, ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`], options);
  if (!r.ok) { diagnostics.push(r.diagnostic); return null; }
  const sha = r.text.replace(/\r?\n$/, '');
  if (!SHA.test(sha)) { diagnostics.push(diagnostic('invalid-object', 'Expected one full commit object ID')); return null; }
  return sha;
}
export function ancestryCaptured(repo, ancestorSha, descendantSha, diagnostics, options = {}) {
  if (!ancestorSha || !descendantSha) return 'unknown';
  const r = git(repo, ['merge-base', '--is-ancestor', ancestorSha, descendantSha], options);
  if (r.ok) return 'contained';
  if (r.exit === 1 && r.text === '') return 'not-contained';
  diagnostics.push(r.diagnostic); return 'unknown';
}
function envelope(operation, repo, evidence, diagnostics, unavailable = false) {
  return { operation, repo: path.resolve(repo), completeness: diagnostics.length ? (unavailable ? 'unknown' : 'partial') : 'complete', evidence, diagnostics };
}
function provenanceOptions(repo, diagnostics, options) {
  const captured = { ...options };
  for (const key of ['owner', 'target']) if (options[key] !== undefined) captured[`${key}Sha`] = capture(repo, options[key], diagnostics, options);
  return captured;
}
export function ancestry({ repo, ancestor, descendant, ...options }) {
  const diagnostics = [];
  const ancestorSha = capture(repo, ancestor, diagnostics, options), descendantSha = capture(repo, descendant, diagnostics, options);
  const result = ancestryCaptured(repo, ancestorSha, descendantSha, diagnostics, options);
  return envelope('ancestry', repo, { ancestorSha, descendantSha, result }, diagnostics, result === 'unknown');
}
export function shipment({ repo, integration, source, remote, ref, ...options }) {
  const diagnostics = [];
  const e = { source, remote: remote ?? null, ref, integrationSha: null, shipmentSha: null, result: 'unknown' };
  if (!validFullRef(integration) || !validFullRef(ref) || !ref.startsWith('refs/heads/') || !['local', 'remote'].includes(source) || (source === 'remote' ? !remote || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(remote) : remote !== undefined)) {
    diagnostics.push(diagnostic('invalid-shipment', 'Explicit integration, source, full shipment branch ref and remote name (remote source only) are required'));
    return envelope('shipment', repo, e, diagnostics, true);
  }
  e.integrationSha = capture(repo, integration, diagnostics, options);
  if (source === 'local') e.shipmentSha = capture(repo, ref, diagnostics, options);
  else {
    const r = git(repo, ['ls-remote', '--exit-code', '--refs', '--', remote, ref], options);
    if (!r.ok) diagnostics.push(r.diagnostic);
    else {
      const records = r.text.split('\n').filter(Boolean).map(x => x.replace(/\r$/, '').split('\t'));
      if (records.length !== 1 || records[0].length !== 2 || records[0][1] !== ref || !SHA.test(records[0][0])) diagnostics.push(diagnostic('invalid-remote-ref', 'Expected exactly one matching remote branch'));
      else {
        e.shipmentSha = records[0][0];
        const commit = capture(repo, e.shipmentSha, diagnostics, options);
        if (commit && commit !== e.shipmentSha) diagnostics.push(diagnostic('remote-object-type', 'Remote branch object must itself be a commit, not a peeled tag'));
      }
    }
  }
  // A remote SHA remains visible even if its object is unavailable; it is never substituted by a tracking ref.
  if (!diagnostics.length) e.result = ancestryCaptured(repo, e.integrationSha, e.shipmentSha, diagnostics, options);
  return envelope('shipment', repo, e, diagnostics, e.result === 'unknown');
}

export function parseStatus(text) {
  if (!text) return [];
  const fields = text.split('\0');
  if (fields.pop() !== '') throw new Error('Missing status terminator');
  const entries = [];
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i];
    if (!/^[ MTADRCU?!]{2} /.test(field) || field.length < 4) throw new Error('Malformed status entry');
    const xy = field.slice(0, 2), destination = field.slice(3);
    const entry = { status: xy, path: destination, originalPath: null };
    if (/[RC]/.test(xy)) { if (!fields[++i]) throw new Error('Missing rename endpoint'); entry.originalPath = fields[i]; }
    entries.push(entry);
  }
  return entries;
}
// Classifying the report is pure text work, so it is separated to be driven directly by a
// unit test: real check-attr emits exactly three fields per input path and always names the
// attribute asked for, leaving the first two guards below unreachable from any repository.
// Exported for that test only; it reads a report and returns a diagnostic or null, so no
// caller gains a way to make a resolving path look safe.
export function filterReportVerdict(pathCount, text) {
  const fields = text.split('\0');
  if (fields.pop() !== '' || fields.length !== pathCount * 3) return diagnostic('invalid-attributes', 'Malformed attribute report');
  for (let i = 0; i < fields.length; i += 3) {
    if (fields[i + 1] !== 'filter') return diagnostic('invalid-attributes', 'Unexpected attribute in report');
    // `unspecified` and `unset` (a `-filter` attribute) select no driver and are safe.
    // Any other value names one, and a bare `set` could resolve to one.
    if (fields[i + 2] !== 'unspecified' && fields[i + 2] !== 'unset') return diagnostic('unsafe-filter', 'An inspected path resolves to a filter attribute; status was not run because it can execute commands');
  }
  return null;
}
// Test seam: `options.failProbe` names a Git subcommand whose result this function must read
// as failed, so a test can reach the two refusals no repository produces: a corrupt index
// fails the index inventory too, and check-attr exits 0 on every unreadable attributes
// source. It can only DEGRADE: it forces `ok` false and changes nothing else, so no value
// turns a failed probe into a successful one or a resolving attribute into a safe one, and
// its only reachable effect is a refusal. The published CLI cannot set it: parseFlags admits
// only the flags `--help` lists, and rejects any other as an invalid invocation.
function degradedProbe(repo, args, options = {}) {
  const result = git(repo, args, options);
  return options.failProbe === args[0] ? { ...result, ok: false } : result;
}
// Exported for the same reason: a unit test can watch this verdict directly, where the
// worktrees walk above it collapses every refusal into the same `unknown`. Running it
// executes ls-files and check-attr only; it never runs status and never returns true on a
// probe it could not read, so an outside caller cannot use it to bypass the refusal.
export function safeResolvedFilters(repo, diagnostics, options) {
  // Enumerate exactly what status inspects under --untracked-files=all: tracked paths plus
  // untracked non-ignored ones. Status never inspects an ignored path's content, so a
  // filter attribute there cannot make a driver run; --exclude-standard applies the very
  // exclusions status applies, so that precision is free. Listing paths and reading their
  // attributes executes no driver: check-attr resolves text files, it converts nothing.
  const listing = degradedProbe(repo, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], options);
  if (!listing.ok) { diagnostics.push({ ...listing.diagnostic, path: repo }); return false; }
  if (!listing.text) return true;
  const paths = listing.text.split('\0');
  if (paths.pop() !== '') { diagnostics.push(diagnostic('invalid-attributes', 'Malformed path inventory', { path: repo })); return false; }
  // The NUL-separated listing is fed through verbatim, so quotes, spaces and non-ASCII
  // survive; -z output is NUL-separated path/attribute/value triples, never tab-delimited.
  const attributes = degradedProbe(repo, ['check-attr', 'filter', '-z', '--stdin'], { ...options, input: listing.bytes });
  if (!attributes.ok) { diagnostics.push({ ...attributes.diagnostic, path: repo }); return false; }
  const verdict = filterReportVerdict(paths.length, attributes.text);
  if (verdict) { diagnostics.push({ ...verdict, path: repo }); return false; }
  return true;
}
function safeStatusPrerequisites(repo, diagnostics, options) {
  // Status may execute clean/process drivers even without updating the index, but only for
  // a path that actually resolves to one: configuration alone converts nothing, and Git for
  // Windows ships filter.lfs.* system-wide. So the trigger is the resolved per-path filter
  // attribute. Where one resolves, cleanliness is unavailable under this read-only
  // contract; do not run the driver, or pretend disabling its conversion would give
  // truthful status.
  // GIT_CONFIG affects `git config` only, so omit that historical override: the fast path
  // below must see the same configuration scopes status reads (including includes), or a
  // redirected file could skip the enumeration. `git check-attr` ignores GIT_CONFIG, so the
  // resolved verdict itself cannot be concealed that way.
  const env = { ...(options.env ?? process.env) };
  for (const key of Object.keys(env)) if (key.toUpperCase() === 'GIT_CONFIG') delete env[key];
  const filters = git(repo, ['config', '--includes', '--null', '--name-only', '--get-regexp', '^filter[.].*[.](clean|process)$'], { ...options, env });
  if (!filters.ok && !(filters.exit === 1 && filters.text === '')) { diagnostics.push({ ...filters.diagnostic, path: repo }); return false; }
  // A fast path in the safe direction only: with no driver configured anywhere, no
  // attribute can select an executable one. It never makes a resolved attribute safe.
  if (filters.text && !safeResolvedFilters(repo, diagnostics, options)) return false;
  // Git status normally descends into submodules, whose separate local configuration
  // could execute a driver as well. Do not recurse into uninspected repositories.
  const index = git(repo, ['ls-files', '--stage', '-z'], options);
  if (!index.ok) { diagnostics.push({ ...index.diagnostic, path: repo }); return false; }
  const entries = index.text ? index.text.split('\0') : [];
  if (entries.length && entries.pop() !== '') { diagnostics.push(diagnostic('invalid-index', 'Malformed index inventory', { path: repo })); return false; }
  for (const entry of entries) {
    if (!/^\d{6} [a-f0-9]{40}(?:[a-f0-9]{24})? [0-3]\t[\s\S]+$/.test(entry)) { diagnostics.push(diagnostic('invalid-index', 'Malformed index entry', { path: repo })); return false; }
    if (entry.startsWith('160000 ')) { diagnostics.push(diagnostic('submodule-status-unsupported', 'Submodule cleanliness cannot be inspected safely without executing nested configuration; status was not run', { path: repo })); return false; }
  }
  return true;
}
function worktreesRaw(repo, diagnostics, options) {
  const r = git(repo, ['worktree', 'list', '--porcelain', '-z'], options);
  if (!r.ok) { diagnostics.push(r.diagnostic); return []; }
  const records = r.text.split('\0\0');
  if (records.pop() !== '') { diagnostics.push(diagnostic('invalid-worktrees', 'Malformed worktree list')); return []; }
  const result = [];
  for (const record of records) {
    const fields = record.split('\0');
    const get = key => fields.filter(x => x.startsWith(key + ' ')).map(x => x.slice(key.length + 1));
    const paths = get('worktree'), heads = get('HEAD'), branches = get('branch');
    if (paths.length !== 1 || heads.length > 1 || branches.length > 1 || (heads[0] && !SHA.test(heads[0]))) { diagnostics.push(diagnostic('invalid-worktrees', 'Malformed worktree identity')); continue; }
    const wt = { path: paths[0], head: heads[0] ?? null, branch: branches[0] ?? null, cleanliness: 'unknown', status: [], bare: fields.includes('bare'), prunable: get('prunable')[0] ?? null };
    result.push(wt);
    if (wt.bare) continue;
    try {
      if (!fs.statSync(wt.path).isDirectory()) throw new Error('not directory');
      const top = git(wt.path, ['rev-parse', '--show-toplevel'], options);
      if (!top.ok || fs.realpathSync(top.text.replace(/\r?\n$/, '')) !== fs.realpathSync(wt.path)) throw new Error('identity mismatch');
      const actualHead = capture(wt.path, 'HEAD', diagnostics, options);
      const actualBranch = git(wt.path, ['symbolic-ref', '--quiet', 'HEAD'], options);
      if (!actualBranch.ok && actualBranch.exit !== 1) { diagnostics.push(actualBranch.diagnostic); continue; }
      if (actualHead !== wt.head || (actualBranch.ok ? actualBranch.text.replace(/\r?\n$/, '') : null) !== wt.branch) throw new Error('checkout identity changed');
      if (!safeStatusPrerequisites(wt.path, diagnostics, options)) continue;
      const status = git(wt.path, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=all'], options);
      if (!status.ok) { diagnostics.push({ ...status.diagnostic, path: wt.path }); continue; }
      wt.status = parseStatus(status.text); wt.cleanliness = wt.status.length ? 'dirty' : 'clean';
    } catch { diagnostics.push(diagnostic('worktree-unavailable', 'Worktree is missing, inaccessible, malformed or has changed identity', { path: wt.path })); }
  }
  return result.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}
export function worktrees({ repo, ...options }) {
  const diagnostics = [], evidence = { worktrees: worktreesRaw(repo, diagnostics, options) };
  return envelope('worktrees', repo, evidence, diagnostics, !evidence.worktrees.length);
}
function parseTree(text) {
  if (!text) return [];
  const fields = text.split('\0'); if (fields.pop() !== '') throw new Error();
  return fields.map(f => { const m = /^(\d{6}) (blob|tree|commit) ([a-f0-9]{40}|[a-f0-9]{64})\t([\s\S]+)$/.exec(f); if (!m) throw new Error(); return { mode: m[1], type: m[2], sha: m[3], path: m[4] }; });
}
export function readBlob(repo, sha, file, diagnostics, options = {}) {
  const r = git(repo, ['show', `${sha}:./${file}`], options);
  if (!r.ok) { diagnostics.push({ ...r.diagnostic, path: file }); return null; }
  return r.text;
}
function observeLedger(repo, sha, ledgerPath, diagnostics, options) {
  const e = { exists: null, tree: null, lastChange: null, lastChangeTree: null, progressText: null, contractTexts: [] };
  if (!sha) return e;
  // Query the parent tree so absence is distinguished from unreadable/missing objects.
  const r = git(repo, ['ls-tree', '-z', sha, '--', ledgerPath], options);
  if (!r.ok) { diagnostics.push(r.diagnostic); return e; }
  let entries; try { entries = parseTree(r.text); } catch { diagnostics.push(diagnostic('invalid-tree', 'Malformed ledger tree', { path: ledgerPath })); return e; }
  if (!entries.length) { e.exists = false; return e; }
  if (entries.length !== 1 || entries[0].type !== 'tree' || entries[0].path !== ledgerPath) { diagnostics.push(diagnostic('invalid-ledger-tree', 'Ledger location must be one tree', { path: ledgerPath })); return e; }
  e.exists = true; e.tree = entries[0].sha;
  const files = git(repo, ['ls-tree', '-r', '-z', sha, '--', `${ledgerPath}/`], options);
  if (!files.ok) { diagnostics.push(files.diagnostic); return e; }
  let listing; try { listing = parseTree(files.text); } catch { diagnostics.push(diagnostic('invalid-tree', 'Malformed ledger files')); return e; }
  for (const entry of listing) {
    const name = entry.path.slice(ledgerPath.length + 1);
    if (name !== 'PROGRESS.md' && !contracts.includes(name)) continue;
    if (entry.type !== 'blob' || !/^100(644|755)$/.test(entry.mode)) { diagnostics.push(diagnostic('invalid-ledger-file', 'Ledger text must be an ordinary file', { path: entry.path })); continue; }
    const text = readBlob(repo, sha, entry.path, diagnostics, options);
    if (name === 'PROGRESS.md') e.progressText = text; else e.contractTexts.push({ path: entry.path, text });
  }
  if (!listing.some(entry => entry.path === `${ledgerPath}/PROGRESS.md`)) diagnostics.push(diagnostic('missing-progress', 'Ledger subtree has no PROGRESS.md', { path: ledgerPath }));
  const log = git(repo, ['log', '-1', '--format=%H', sha, '--', `${ledgerPath}/`], options);
  if (!log.ok) diagnostics.push(log.diagnostic);
  else {
    e.lastChange = log.text.replace(/\r?\n$/, '');
    if (!SHA.test(e.lastChange)) { e.lastChange = null; diagnostics.push(diagnostic('missing-provenance', 'No ledger-changing commit', { path: ledgerPath })); }
    else {
      const tree = git(repo, ['rev-parse', '--verify', `${e.lastChange}:./${ledgerPath}`], options);
      if (!tree.ok) diagnostics.push(tree.diagnostic);
      else { e.lastChangeTree = tree.text.replace(/\r?\n$/, ''); if (e.lastChangeTree !== e.tree) diagnostics.push(diagnostic('conflicting-provenance', 'Last-change subtree differs from captured ledger subtree', { path: ledgerPath })); }
    }
  }
  e.ancestry = {};
  for (const key of ['owner', 'target']) if (Object.hasOwn(options, `${key}Sha`)) {
    const descendantSha = options[`${key}Sha`];
    e.ancestry[key] = { ancestorSha: e.lastChange, descendantSha, result: ancestryCaptured(repo, e.lastChange, descendantSha, diagnostics, options) };
  }
  return e;
}
export function ledger({ repo, ref, ledger: id, ...options }) {
  const diagnostics = [];
  options = provenanceOptions(repo, diagnostics, options);
  const refSha = validId(id) && validFullRef(ref) ? capture(repo, ref, diagnostics, options) : null;
  if (!validId(id) || !validFullRef(ref)) diagnostics.push(diagnostic('invalid-ledger', 'Expected a simple ledger ID and full branch ref'));
  const activePath = `.agents/changes/${id}`, archivePath = `.agents/archive/${id}`;
  return envelope('ledger', repo, { id, ref, refSha, activePath, archivePath,
    active: observeLedger(repo, refSha, activePath, diagnostics, options), archive: observeLedger(repo, refSha, archivePath, diagnostics, options) }, diagnostics, !refSha);
}
function refsRaw(repo, diagnostics, options) {
  const r = git(repo, ['for-each-ref', '--format=%(refname)%00%(objectname)%00%(symref)', 'refs/heads/', 'refs/remotes/'], options);
  if (!r.ok) { diagnostics.push(r.diagnostic); return []; }
  if (r.stderrPresent) diagnostics.push(diagnostic('ref-inventory-warning', 'Git reported a warning while enumerating refs; inventory may be incomplete (stderr withheld)', { command: 'for-each-ref', exit: r.exit }));
  const refs = [];
  for (const line of r.text.split('\n').filter(Boolean)) {
    const [ref, sha, symref, extra] = line.replace(/\r$/, '').split('\0');
    if (extra !== undefined || !validFullRef(ref) || !SHA.test(sha) || symref === undefined) { diagnostics.push(diagnostic('invalid-ref-output', 'Malformed ref record')); continue; }
    refs.push({ ref, sha, symref: symref || null });
  }
  // for-each-ref omits dangling symbolic refs. Inspect only the two loose ref namespaces,
  // then ask Git for their symbolic targets. No HEAD/default/ownership inference.
  const common = git(repo, ['rev-parse', '--git-common-dir'], options);
  if (!common.ok) diagnostics.push(common.diagnostic);
  else {
    const root = path.resolve(repo, common.text.replace(/\r?\n$/, ''));
    const walk = (directory, prefix) => {
      let entries; try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch (e) { if (e.code !== 'ENOENT') diagnostics.push(diagnostic('refs-unavailable', 'Cannot inspect loose symbolic refs')); return; }
      for (const entry of entries.sort((a, b) => a.name < b.name ? -1 : 1)) {
        const name = `${prefix}/${entry.name}`, file = path.join(directory, entry.name);
        if (entry.isDirectory()) walk(file, name);
        else if (entry.isFile() && !refs.some(x => x.ref === name)) {
          let text;
          try { text = decode(fs.readFileSync(file)); }
          catch { refs.push({ ref: name, sha: null, symref: null }); diagnostics.push(diagnostic('refs-unavailable', 'Cannot read loose ref as UTF-8', { ref: name })); continue; }
          if (!text.startsWith('ref: ')) {
            refs.push({ ref: name, sha: null, symref: null });
            diagnostics.push(diagnostic('unobserved-loose-ref', 'A non-symbolic loose ref was omitted by Git; it is malformed, unavailable or changed during enumeration', { ref: name }));
            continue;
          }
          const s = git(repo, ['symbolic-ref', '--quiet', name], options);
          const target = s.ok ? s.text.replace(/\r?\n$/, '') : null;
          // The observed ref belongs to our inventory, but its target may legally
          // use any refs/ namespace. Validate syntax without following its tree.
          const targetFormat = target?.startsWith('refs/') ? git(repo, ['check-ref-format', target], options) : null;
          if (!s.ok || !validFullRef(name) || !targetFormat?.ok) {
            refs.push({ ref: name, sha: null, symref: null });
            diagnostics.push(s.ok ? diagnostic('invalid-symbolic-ref', 'Malformed symbolic ref', { ref: name }) : s.diagnostic);
            if (targetFormat && !targetFormat.ok && targetFormat.exit !== 1) diagnostics.push(targetFormat.diagnostic);
          } else refs.push({ ref: name, sha: null, symref: target });
        }
      }
    };
    walk(path.join(root, 'refs/heads'), 'refs/heads'); walk(path.join(root, 'refs/remotes'), 'refs/remotes');
  }
  return refs.sort((a, b) => a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0);
}
export function discovery({ repo, ...options }) {
  const diagnostics = [];
  options = provenanceOptions(repo, diagnostics, options);
  const refs = refsRaw(repo, diagnostics, options), worktrees = worktreesRaw(repo, diagnostics, options), groups = new Map();
  const add = (id, location) => { if (!groups.has(id)) groups.set(id, { id, locations: [] }); groups.get(id).locations.push(location); };
  for (const ref of refs.filter(x => !x.symref && x.sha)) {
    const r = git(repo, ['ls-tree', '-r', '-z', ref.sha, '--', '.agents/changes/'], options);
    if (!r.ok) { diagnostics.push(r.diagnostic); continue; }
    let entries; try { entries = parseTree(r.text); } catch { diagnostics.push(diagnostic('invalid-tree', 'Malformed discovery tree')); continue; }
    for (const entry of entries) {
      const m = /^\.agents\/changes\/([^/]+)\/PROGRESS\.md$/.exec(entry.path);
      if (!m) continue;
      if (!validId(m[1])) { diagnostics.push(diagnostic('invalid-ledger', 'Unsupported ledger ID', { path: entry.path })); continue; }
      add(m[1], { kind: 'ref', ref: ref.ref, sha: ref.sha, path: entry.path, provenance: observeLedger(repo, ref.sha, `.agents/changes/${m[1]}`, diagnostics, options), worktrees: worktrees.filter(w => w.branch === ref.ref) });
    }
  }
  for (const wt of worktrees.filter(x => !x.bare)) {
    const root = path.join(wt.path, '.agents/changes');
    let dirs;
    try { if (fs.lstatSync(root).isSymbolicLink()) throw new Error(); dirs = fs.readdirSync(root, { withFileTypes: true }); }
    catch (e) { if (e.code !== 'ENOENT') diagnostics.push(diagnostic('ledger-directory-unavailable', 'Cannot inspect working-tree active ledgers', { path: root })); continue; }
    for (const dir of dirs.sort((a, b) => a.name < b.name ? -1 : 1)) {
      if (!dir.isDirectory() || !validId(dir.name)) continue;
      const file = path.join(root, dir.name, 'PROGRESS.md');
      try {
        const stat = fs.lstatSync(file); if (!stat.isFile()) throw new Error();
        const progressText = decode(fs.readFileSync(file)), contractTexts = [];
        for (const name of contracts) {
          const p = path.join(root, dir.name, name);
          try { if (!fs.lstatSync(p).isFile()) throw new Error(); contractTexts.push({ path: p, text: decode(fs.readFileSync(p)) }); } catch (e) { if (e.code !== 'ENOENT') diagnostics.push(diagnostic('contract-unavailable', 'Working contract cannot be read', { path: p })); }
        }
        add(dir.name, { kind: 'worktree', path: file, branch: wt.branch, head: wt.head, cleanliness: wt.cleanliness, status: wt.status, progressText, contractTexts });
      } catch (e) { if (e.code !== 'ENOENT') diagnostics.push(diagnostic('ledger-unavailable', 'Working ledger cannot be read', { path: file })); }
    }
  }
  return envelope('discovery', repo, { refs, worktrees, ledgers: [...groups.values()].sort((a, b) => a.id < b.id ? -1 : 1) }, diagnostics, !refs.length && !worktrees.length);
}
export function parseFlags(args, names, required) {
  const result = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    if (!key?.startsWith('--') || !names.includes(key.slice(2)) || Object.hasOwn(result, key.slice(2)) || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error('Unknown, missing or duplicate flag');
    result[key.slice(2)] = args[i + 1];
  }
  if (required.some(key => !Object.hasOwn(result, key))) throw new Error('Required flag missing');
  return result;
}
export function evidenceCli(args) {
  if (args.length === 1 && args[0] === '--help') return { code: 0, text: 'git-evidence.mjs <discovery|worktrees|ancestry|shipment|ledger> --repo <repo>\nancestry: --ancestor <ref-or-sha> --descendant <ref-or-sha>\nshipment: --integration <full-ref> --source <local|remote> [--remote <name>] --ref <full-ref>\nledger: --ref <full-ref> --ledger <id> [--owner <ref-or-sha>] [--target <ref-or-sha>]\nExit 0: complete facts (including not-contained); exit 2: partial/unknown or invalid invocation.\nA path resolving to a clean/process filter attribute, or a submodule, makes worktree cleanliness UNKNOWN; unsafe status commands are not run.\n' };
  const operation = args[0] || null;
  try {
    const defs = { discovery: [], worktrees: [], ancestry: ['ancestor', 'descendant'], shipment: ['integration', 'source', 'ref'], ledger: ['ref', 'ledger'] };
    if (!Object.hasOwn(defs, operation)) throw new Error('Unknown or missing operation');
    const required = ['repo', ...defs[operation]], extra = operation === 'shipment' ? ['remote'] : operation === 'ledger' ? ['owner', 'target'] : [];
    const options = parseFlags(args.slice(1), [...required, ...extra], required);
    const result = ({ discovery, worktrees, ancestry, shipment, ledger })[operation](options);
    return { code: result.completeness === 'complete' ? 0 : 2, result };
  } catch { return { code: 2, result: { operation, repo: null, completeness: 'unknown', evidence: {}, diagnostics: [diagnostic('usage', 'Invalid invocation; use --help for explicit command and flags')] } }; }
}
if (isMain(import.meta.url)) {
  const output = evidenceCli(process.argv.slice(2)); process.stdout.write(output.text ?? JSON.stringify(output.result) + '\n'); process.exitCode = output.code;
}
