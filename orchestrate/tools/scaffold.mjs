#!/usr/bin/env node
// Fills the ledger templates from an answers file and writes the ledger. The answers' domain is
// read from the templates at run time, never listed here, so a template edit flows through with no
// code change. Every file is built in memory, staged in a temporary directory and held to the real
// checks (orchestrate/tools/check-ledger.mjs `parseLedger`, `selfcheck`, `planCheck`); nothing
// reaches the repository unless every check passes. Never commits.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { capture, decode, git, parseFlags, validId, validPath, isMain } from './git-evidence.mjs';
import { parseLedger, selfcheck, planCheck, skillHash } from './check-ledger.mjs';
import { checkedSpec } from './mutate.mjs';

const HELP = 'scaffold.mjs --answers <answers.json> --repo <worktree-root> — fills the ledger templates from an answers file and writes the ledger. The answers file (schema version 1) is a JSON object holding exactly: "values" (every placeholder outside 02-batch.md plus ID_PREFIX and CHANGE_SLUG; CHANGE_ID, LEDGER_DIR, SKILL_DIR and SKILL_SHA256 are computed and may be omitted), "sections" (one markdown text per instruction comment outside 02-batch.md, keyed "<template> <heading line>"; "" removes the comment), "batches" (in order, each { "values": every 02-batch.md placeholder plus BATCH_SLUG, "sections": keyed by heading line }), "validate" and "setup" (validate.mjs specs, or null when the validation commands are none or the worktree setup is n/a), "foldins" ([{ "file", "id" or "anchor", "batch" }]). The keys come from the templates beside this tool. The ledger is staged in a temporary directory and checked with parse, selfcheck and plan; only then is .agents/changes/<CHANGE_ID> written, in the line-ending style of the repository\'s tracked Markdown, and each fold-in\'s backlog line given "Folded into <CHANGE_ID> <Bnn>." (an anchored item first takes the next id of its file). Never commits. Exit 0 SCAFFOLD OK <CHANGE_ID> <n> batches, <k> files; 1 SCAFFOLD FAIL <n> problem(s): ... (nothing written); 2 UNKNOWN <reason>. Always one line.';

export class Unknown extends Error {}

const DEFAULT_SKILL = fileURLToPath(new URL('..', import.meta.url));
const BATCH_TEMPLATE = '02-batch.md';
// Naming-only values: they occur in no template, only in the ledger's and batch files' names.
const NAMING = ['ID_PREFIX', 'CHANGE_SLUG'], BATCH_NAMING = ['BATCH_SLUG'];
const COMPUTED = ['CHANGE_ID', 'LEDGER_DIR', 'SKILL_DIR', 'SKILL_SHA256'];
const TOP_KEYS = ['values', 'sections', 'batches', 'validate', 'setup', 'foldins'];
const PLACEHOLDER = /\{\{([A-Z0-9_]+)\}\}/g;
const MARKER = 'Folded into ';
const MAX_PROBLEMS = 10;
const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const lfOf = text => text.split('\r\n').join('\n').split('\r').join('\n');
const eolOf = (text, crlf) => crlf ? text.split('\n').join('\r\n') : text;
const escaped = text => text.replace(/[.*+?^${}()|[\]\\\/-]/g, c => '\\' + c);
const quoted = v => JSON.stringify(v);

// ===== The domain, read from the templates ======================================================
// One template: its LF lines, each instruction comment's line range with the heading line it sits
// under, and the placeholders outside the comments. A comment that does not open a line and close
// at the end of one, or a second comment under one heading, has no key: the template is refused.
function shape(name, text) {
  const lines = text.split('\n'), comments = [], placeholders = new Set();
  let heading = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('<!--')) {
      let end = i;
      while (end < lines.length && !lines[end].includes('-->')) end++;
      if (lines.slice(i + 1, end + 1).some(l => l.includes('<!--'))) throw new Unknown(`template ${name}:${i + 1}: an instruction comment opened inside another`);
      if (end === lines.length || lines[end].indexOf('-->') !== lines[end].length - 3) throw new Unknown(`template ${name}:${i + 1}: an instruction comment must close at the end of a line`);
      if (heading === null) throw new Unknown(`template ${name}:${i + 1}: an instruction comment under no heading`);
      if (comments.some(c => c.heading === heading)) throw new Unknown(`template ${name}:${i + 1}: a second instruction comment under ${heading}`);
      comments.push({ start: i, end, heading });
      i = end;
      continue;
    }
    if (line.includes('<!--') || line.includes('-->')) throw new Unknown(`template ${name}:${i + 1}: an instruction comment must open a line`);
    if (/^#{1,6} /.test(line)) heading = line;
    for (const m of line.matchAll(PLACEHOLDER)) placeholders.add(m[1]);
  }
  return { name, lines, comments, placeholders: [...placeholders].sort() };
}

// Every file of the skill's templates directory, read as LF whatever the checkout gave it.
function readTemplates(skillDir) {
  const dir = path.join(skillDir, 'templates');
  let names;
  try { names = fs.readdirSync(dir).sort(); } catch { throw new Unknown(`cannot read the templates directory ${dir}`); }
  if (!names.includes(BATCH_TEMPLATE)) throw new Unknown(`no ${BATCH_TEMPLATE} in ${dir}`);
  return names.map(name => {
    let text;
    try { text = decode(fs.readFileSync(path.join(dir, name))); } catch { throw new Unknown(`cannot read template ${name} as UTF-8`); }
    return shape(name, lfOf(text));
  });
}

function domainOf(templates) {
  const batch = templates.find(t => t.name === BATCH_TEMPLATE), rest = templates.filter(t => t !== batch);
  const top = new Set([...rest.flatMap(t => t.placeholders), ...NAMING]);
  const batchValues = [...batch.placeholders.filter(k => !top.has(k) && !COMPUTED.includes(k)), ...BATCH_NAMING].sort();
  return {
    batch, rest,
    domain: {
      keys: TOP_KEYS.slice(),
      values: { required: [...top].filter(k => !COMPUTED.includes(k)).sort(), computed: COMPUTED.slice() },
      sections: rest.flatMap(t => t.comments.map(c => `${t.name} ${c.heading}`)).sort(),
      batches: { values: batchValues, sections: batch.comments.map(c => c.heading).sort() },
    },
  };
}

// The keys an answers file must and may carry, read from the templates of a skill directory.
export function answersDomain(skillDir = DEFAULT_SKILL) {
  return domainOf(readTemplates(skillDir)).domain;
}

// ===== Answers validation =======================================================================
// An object of strings holding every required key, any optional one, and nothing else.
function keyed(where, given, required, optional, problems) {
  if (!isObject(given)) { problems.push(`${where} must be an object`); return; }
  for (const k of required) if (!Object.hasOwn(given, k)) problems.push(`${where}: missing ${k}`);
  for (const [k, v] of Object.entries(given)) {
    if (!required.includes(k) && !optional.includes(k)) problems.push(`${where}: unknown key ${quoted(k)}, carried by no template`);
    else if (typeof v !== 'string') problems.push(`${where}.${k} must be a string`);
  }
}
const text = (obj, k) => isObject(obj) && typeof obj[k] === 'string' ? obj[k] : null;
// The first word, backticks aside: `none` and `n/a` may be followed by an explanation.
const firstWord = v => v === null ? null : v.trim().split(/\s+/)[0].split('`').join('').toLowerCase();

function validDate(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const d = new Date(`${date}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === date;
}

// The computed values, or null after the problem that stands for them.
function computedValues(values, skillDir, problems) {
  const prefix = text(values, 'ID_PREFIX'), slug = text(values, 'CHANGE_SLUG'), date = text(values, 'DATE');
  let ok = true;
  if (prefix !== null && !/^[A-Za-z0-9]+$/.test(prefix)) { problems.push(`values.ID_PREFIX ${quoted(prefix)} must be letters and digits`); ok = false; }
  if (slug !== null && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) { problems.push(`values.CHANGE_SLUG ${quoted(slug)} must be kebab-case`); ok = false; }
  if (date !== null && !validDate(date)) { problems.push(`values.DATE ${quoted(date)} must be a YYYY-MM-DD date`); ok = false; }
  if (!ok || prefix === null || slug === null || date === null) return null;
  const changeId = `${prefix}-${date.split('-').join('')}-${slug}`;
  if (!validId(changeId)) { problems.push(`the change id ${changeId} is not a valid ledger id`); return null; }
  const dir = path.resolve(skillDir).split('\\').join('/');
  const computed = { CHANGE_ID: changeId, LEDGER_DIR: `.agents/changes/${changeId}`, SKILL_DIR: dir, SKILL_SHA256: skillHash(skillDir).hex };
  for (const k of COMPUTED) {
    if (Object.hasOwn(values, k) && values[k] !== computed[k]) problems.push(`values.${k}: supplied ${quoted(values[k])}, computed ${quoted(computed[k])}`);
  }
  return computed;
}

// A validate.mjs spec where one is wanted, checked by orchestrate/tools/mutate.mjs `checkedSpec`.
async function specFor(key, spec, wanted, why, problems) {
  if (!wanted) { if (spec !== null) problems.push(`${key} must be null: ${why}`); return null; }
  if (spec === null) { problems.push(`${key} is required: ${why}`); return null; }
  try { return await checkedSpec(spec, key); } catch (e) { problems.push(e.message); return null; }
}

// ===== Fold-in markers ==========================================================================
// A backlog file as lines, each keeping its own CR, and the UTF-8 BOM its bytes begin with, if any,
// kept apart and written back ahead of them; the rest is decoded as it stands, a second BOM
// included. An edited line is the only change.
const BOM = Buffer.from([0xef, 0xbb, 0xbf]), asText = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
function readBacklog(repo, file) {
  if (!validPath(file)) return { fault: `file ${quoted(file)} is not a repository-relative path` };
  const abs = path.join(repo, ...file.split('/'));
  let stat, real;
  try { stat = fs.lstatSync(abs); real = fs.realpathSync(abs); } catch { return { fault: `no file ${file} in the repository` }; }
  if (!stat.isFile() || path.relative(repo, real).startsWith('..')) return { fault: `${file} is not an ordinary file inside the repository` };
  let bytes, bom, content;
  try { bytes = fs.readFileSync(abs); bom = bytes.subarray(0, 3).equals(BOM) ? BOM : Buffer.alloc(0); content = asText.decode(bytes.subarray(bom.length)); } catch { return { fault: `${file} is not UTF-8` }; }
  return { file, abs, bom, lines: content.split('\n') };
}
const bodyOf = line => line.endsWith('\r') ? line.slice(0, -1) : line;
const withBody = (line, body) => line.endsWith('\r') ? body + '\r' : body;
const isRow = body => body.length > 1 && body.startsWith('|') && body.endsWith('|');
// The marker inside a table row's last cell, before its closing `|`, else at the line's end.
function marked(body, marker) {
  if (isRow(body)) {
    const inner = body.slice(0, -1), kept = inner.replace(/[ \t]+$/, '');
    return kept + marker + (inner.slice(kept.length) || ' ') + '|';
  }
  return body.replace(/[ \t]+$/, '') + marker;
}
// The id scheme's prefix from the contract's value: one token, one pair of backticks allowed, an
// example id's trailing digits dropped (`BL-017` is the scheme `BL-`).
function plainPrefix(value) {
  const v = (value ?? '').trim(), bare = v.length > 1 && v.startsWith('`') && v.endsWith('`') ? v.slice(1, -1) : v;
  return /^[A-Za-z#][A-Za-z0-9#._-]*$/.test(bare) ? bare.replace(/\d+$/, '') : null;
}
// The prefix shape taken on the contract's word alone, with no id of it in the file yet: a bare
// `#`, or a letter, letters and digits, then one separator (`BL-`, `SCAN-`, `v2_`). No pattern
// notation (`BL-NNN`, `BL-###`, `BL-...`) has it.
const SAFE_PREFIX = /^(?:#|[A-Za-z][A-Za-z0-9]*[-_.])$/;
// A line's text as its ids are read: a fold-in marker names a change and a batch, never an id.
const MARKED = new RegExp(`${escaped(MARKER)}\\S+ B\\d+\\.`, 'g');
const idText = line => bodyOf(line).replace(MARKED, () => '');
// A list item's indentation, marker and task box, or a heading's `#`s: an anchored item's id goes
// after them, so the line keeps its Markdown role.
const LEAD = /^[ \t]*(?:(?:[-+*]|\d{1,9}[.)])[ \t]+(?:\[[ xX]\][ \t]+)?|#{1,6}[ \t]+)?/;

// Every fold-in applied in memory, in order: the edited files, or problems and nothing to write.
function foldIns(repo, list, changeId, planned, prefixValue, problems) {
  const docs = new Map();
  list.forEach((f, i) => {
    const where = `foldins[${i}]`;
    if (!isObject(f)) { problems.push(`${where} must be an object`); return; }
    const keys = Object.keys(f).sort().join();
    if (keys !== 'batch,file,id' && keys !== 'anchor,batch,file') { problems.push(`${where}: must hold "file", "batch" and exactly one of "id" or "anchor"`); return; }
    if (Object.values(f).some(v => typeof v !== 'string' || !v)) { problems.push(`${where}: every field must be a non-empty string`); return; }
    if (!planned.includes(f.batch)) { problems.push(`${where}: batch ${quoted(f.batch)} is not a planned batch`); return; }
    let doc = docs.get(f.file);
    if (!doc) {
      doc = readBacklog(repo, f.file);
      if (doc.fault) { problems.push(`${where}: ${doc.fault}`); return; }
      docs.set(f.file, doc);
    }
    const marker = ` ${MARKER}${changeId} ${f.batch}.`;
    if (f.id !== undefined) {
      if (/[\s|`]/.test(f.id)) { problems.push(`${where}: id ${quoted(f.id)} must be one token`); return; }
      const token = new RegExp(`(?<![A-Za-z0-9_])${escaped(f.id)}(?![A-Za-z0-9_])`);
      const hits = doc.lines.flatMap((l, n) => token.test(bodyOf(l)) ? [n] : []);
      if (hits.length !== 1) { problems.push(`${where}: ${f.id} occurs on ${hits.length} lines of ${f.file}, expected exactly one`); return; }
      const body = bodyOf(doc.lines[hits[0]]);
      if (body.includes(MARKER)) { problems.push(`${where}: ${f.id} in ${f.file} is already folded`); return; }
      doc.lines[hits[0]] = withBody(doc.lines[hits[0]], marked(body, marker));
      doc.changed = true;
      return;
    }
    const hits = doc.lines.flatMap((l, n) => bodyOf(l) === f.anchor ? [n] : []);
    if (hits.length !== 1) { problems.push(`${where}: the anchor is ${hits.length} whole lines of ${f.file}, expected exactly one`); return; }
    const body = bodyOf(doc.lines[hits[0]]);
    if (isRow(body)) { problems.push(`${where}: the anchor is a table row of ${f.file}; fill its id column by hand and name the id`); return; }
    if (body.includes(MARKER)) { problems.push(`${where}: the anchored item in ${f.file} is already folded`); return; }
    const prefix = plainPrefix(prefixValue);
    const scheme = prefix && new RegExp(`(?<![A-Za-z0-9_])${escaped(prefix)}(\\d+)(?![A-Za-z0-9_])`, 'g');
    const numbers = prefix ? doc.lines.flatMap(l => [...idText(l).matchAll(scheme)].map(m => m[1])) : [];
    // Any other prefix (`TB`, `#3.`) is the scheme only where the file already holds an id of it.
    if (!prefix || (!SAFE_PREFIX.test(prefix) && !numbers.length)) { problems.push(`${where}: values.BACKLOG_ID_PREFIX ${quoted(prefixValue ?? '')} is not a plain id prefix, so the item cannot be given an id; give it one by hand and name the id`); return; }
    const own = [...body.matchAll(scheme)];
    if (own.length) { problems.push(`${where}: the anchored item in ${f.file} already has the id ${own[0][0]}; name the id`); return; }
    const width = numbers.length ? Math.max(...numbers.map(n => n.length)) : 3;
    const next = String(Math.max(0, ...numbers.map(Number)) + 1).padStart(width, '0');
    const lead = LEAD.exec(body)[0];
    doc.lines[hits[0]] = withBody(doc.lines[hits[0]], marked(lead + prefix + next + ' ' + body.slice(lead.length), marker));
    doc.changed = true;
  });
  return [...docs.values()].filter(d => d.changed);
}

// ===== Filling ==================================================================================
// One template filled: each placeholder by a function replacement (a string replacement would
// expand `$&` and `` $` ``), each comment by its section; "" removes it with the blank line it leaves.
// Values keep their line breaks here; the whole file is made LF once filled (`scaffold` below).
function fill(template, values, sectionOf) {
  const out = [];
  for (let i = 0; i < template.lines.length; i++) {
    const comment = template.comments.find(c => c.start === i);
    if (comment) {
      const body = lfOf(sectionOf(comment.heading)).replace(/\n+$/, '');
      const next = template.lines[comment.end + 1];
      if (body !== '') out.push(...body.split('\n'));
      else if (out.length && out[out.length - 1] === '' && (next === undefined || next === '')) out.pop();
      i = comment.end;
      continue;
    }
    out.push(template.lines[i].replace(PLACEHOLDER, (whole, name) => Object.hasOwn(values, name) ? values[name] : whole));
  }
  return out.join('\n');
}

// The repository's EOL: the majority working-tree EOL of its tracked Markdown; a tie or none is LF.
function repoCrlf(repo) {
  const r = git(repo, ['ls-files', '--eol', '-z', '--', '*.md']);
  if (!r.ok) throw new Unknown('cannot list the tracked Markdown of --repo (git ls-files --eol)');
  let crlf = 0, lf = 0;
  for (const entry of r.text.split('\0')) {
    const m = /^i\/\S*\s+w\/(\S*)\s/.exec(entry);
    if (m && m[1] === 'crlf') crlf++;
    else if (m && m[1] === 'lf') lf++;
  }
  return crlf > lf;
}

// The root of the git work tree --repo names, resolved; anything else is UNKNOWN.
function workTreeRoot(repo) {
  if (typeof repo !== 'string' || !repo) throw new Unknown('usage: --repo is required');
  let real, top;
  try { real = fs.realpathSync(repo); } catch { throw new Unknown(`--repo ${repo} is not a git work tree`); }
  const r = git(real, ['rev-parse', '--show-toplevel']);
  if (!r.ok) throw new Unknown(`--repo ${repo} is not a git work tree`);
  try { top = fs.realpathSync(r.text.replace(/\r?\n$/, '')); } catch { throw new Unknown(`--repo ${repo}: its work tree root cannot be resolved`); }
  if (top !== real) throw new Unknown(`--repo ${repo} is not the root of its git work tree`);
  return real;
}
const exists = p => { try { fs.lstatSync(p); return true; } catch { return false; } };
const removeTree = dir => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });

// The staged ledger held to every check, each problem named by its rule; the parse problems that
// selfcheck and plan repeat are reported once.
function stagedProblems(dir, repo) {
  const tag = rule => p => `staged ${rule} ${p.file}:${p.line} ${p.message}`;
  return [
    ...parseLedger(dir).problems.map(tag('parse')),
    ...selfcheck(dir).problems.filter(p => p.rule !== 'parse').map(p => tag(`selfcheck ${p.rule}`)(p)),
    ...planCheck(dir, repo).problems.filter(p => p.rule !== 'parse').map(p => tag(`plan ${p.rule}`)(p)),
  ];
}

function verdict(result) {
  if (result.status === 'OK') return { ...result, code: 0, line: `SCAFFOLD OK ${result.changeId} ${result.batches} batches, ${result.files.length} files` };
  const shown = result.problems.slice(0, MAX_PROBLEMS), more = result.problems.length - shown.length;
  return { ...result, code: 1, line: `SCAFFOLD FAIL ${result.problems.length} problem(s): ${shown.join('; ')}${more ? ` (+${more} more)` : ''}` };
}
const refused = problems => verdict({ status: 'FAIL', problems });

// Pure core: an answers object in; the ledger written under <repo>/.agents/changes/<CHANGE_ID> and
// the fold-in markers applied only when nothing is refused. Throws Unknown for an unusable --repo,
// skill directory or template.
export async function scaffold(answers, { repo, skillDir = DEFAULT_SKILL, tmpRoot = os.tmpdir() } = {}) {
  const root = workTreeRoot(repo);
  const { batch: batchTemplate, rest, domain } = domainOf(readTemplates(skillDir));
  const problems = [];
  if (!isObject(answers)) return refused(['the answers must be a JSON object']);
  for (const k of TOP_KEYS) if (!Object.hasOwn(answers, k)) problems.push(`answers: missing ${k}`);
  for (const k of Object.keys(answers)) if (!TOP_KEYS.includes(k)) problems.push(`answers: unknown key ${quoted(k)}`);
  const values = isObject(answers.values) ? answers.values : {};
  keyed('values', answers.values, domain.values.required, domain.values.computed, problems);
  keyed('sections', answers.sections, domain.sections, [], problems);
  const batches = Array.isArray(answers.batches) ? answers.batches : [];
  if (!batches.length) problems.push('batches must be a non-empty array');
  const names = [];
  batches.forEach((b, i) => {
    const where = `batches[${i}]`;
    if (!isObject(b) || Object.keys(b).sort().join() !== 'sections,values') { problems.push(`${where} must hold exactly "values" and "sections"`); return; }
    keyed(`${where}.values`, b.values, domain.batches.values, [], problems);
    keyed(`${where}.sections`, b.sections, domain.batches.sections, [], problems);
    const num = text(b.values, 'BATCH_NUM'), slug = text(b.values, 'BATCH_SLUG');
    if (num !== null && (!/^\d{2,}$/.test(num) || Number(num) !== i + 1)) problems.push(`${where}.values.BATCH_NUM ${quoted(num)}: expected batch ${i + 1} in two or more digits (no gap, duplicate or reordering)`);
    if (slug !== null && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) problems.push(`${where}.values.BATCH_SLUG ${quoted(slug)} must be kebab-case`);
    names[i] = { id: `B${num}`, file: `02-batches-${num}-${slug}.md` };
  });
  const validationWord = firstWord(text(values, 'VALIDATION_COMMANDS')), setupWord = firstWord(text(values, 'WORKTREE_SETUP'));
  const specs = {};
  if (Object.hasOwn(answers, 'validate') && validationWord !== null) {
    const none = validationWord === 'none';
    specs['validate.json'] = await specFor('validate', answers.validate, !none, none ? 'the validation commands are none' : 'the validation commands are not none', problems);
  }
  if (Object.hasOwn(answers, 'setup') && setupWord !== null) {
    const none = setupWord === 'n/a';
    specs['setup.json'] = await specFor('setup', answers.setup, !none, none ? 'the worktree setup is n/a' : 'the worktree setup is not n/a', problems);
  }
  if (Object.hasOwn(answers, 'foldins') && !Array.isArray(answers.foldins)) problems.push('foldins must be an array');
  const computed = computedValues(values, skillDir, problems);
  const base = text(values, 'BASE_SHA');
  if (base !== null && (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(base) || capture(root, base, []) !== base)) problems.push(`values.BASE_SHA ${quoted(base)} is not a full commit SHA in the repository`);
  if (problems.length || !computed) return refused(problems);

  const changeId = computed.CHANGE_ID, target = path.join(root, '.agents', 'changes', changeId);
  const edited = foldIns(root, answers.foldins, changeId, names.map(n => n.id), text(values, 'BACKLOG_ID_PREFIX'), problems);
  if (exists(target)) problems.push(`.agents/changes/${changeId} already exists`);
  if (problems.length) return refused(problems);

  // Every file in memory first: the templates, one batch file each, then the specs.
  const filled = { ...values, ...computed }, files = new Map();
  const put = (name, content) => { if (files.has(name)) throw new Unknown(`two ledger files named ${name}`); files.set(name, content); };
  for (const t of rest) put(t.name, fill(t, filled, heading => answers.sections[`${t.name} ${heading}`]));
  batches.forEach((b, i) => put(names[i].file, fill(batchTemplate, { ...filled, ...b.values }, heading => b.sections[heading])));
  for (const [name, spec] of Object.entries(specs)) if (spec !== null) put(name, JSON.stringify(spec, null, 2) + '\n');
  const crlf = repoCrlf(root), bytes = new Map([...files].map(([name, content]) => [name, Buffer.from(eolOf(lfOf(content), crlf), 'utf8')]));

  // Stage, check, then write: the checks read the staged bytes, which are the bytes written.
  const stage = fs.mkdtempSync(path.join(tmpRoot, 'scaffold-'));
  try {
    const staged = path.join(stage, changeId);
    fs.mkdirSync(staged);
    for (const [name, content] of bytes) fs.writeFileSync(path.join(staged, name), content);
    problems.push(...stagedProblems(staged, root));
  } finally { removeTree(stage); }
  if (problems.length) return refused(problems);
  if (exists(target)) return refused([`.agents/changes/${changeId} already exists`]);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.mkdirSync(target);
  try {
    for (const [name, content] of bytes) {
      fs.writeFileSync(path.join(target, name), content);
      if (!fs.readFileSync(path.join(target, name)).equals(content)) throw new Error(`${name} did not read back as written`);
    }
  } catch (e) { removeTree(target); throw new Unknown(`writing the ledger failed and it was removed: ${e.message}`); }
  for (const doc of edited) fs.writeFileSync(doc.abs, Buffer.concat([doc.bom, Buffer.from(doc.lines.join('\n'), 'utf8')]));
  return verdict({ status: 'OK', problems: [], changeId, batches: batches.length, files: [...bytes.keys()], foldins: edited.map(d => d.file) });
}

// ===== CLI ======================================================================================
function readAnswers(file) {
  let content;
  try { content = decode(fs.readFileSync(file)); } catch { throw new Unknown(`cannot read --answers ${file} as UTF-8`); }
  try { return JSON.parse(content.charCodeAt(0) === 0xfeff ? content.slice(1) : content); } catch { throw new Unknown(`--answers ${file} is not valid JSON`); }
}
// One line whatever a path or message holds: C0, DEL, C1 and the line and paragraph separators
// become '?'. Tested by code point, so no escape in this source can be decoded.
const hidden = n => n < 32 || (n >= 127 && n <= 159) || n === 0x2028 || n === 0x2029;
const oneLine = line => [...line].map(c => hidden(c.codePointAt(0)) ? '?' : c).join('');

export async function scaffoldCli(args) {
  if (args.length === 1 && args[0] === '--help') return { code: 0, line: HELP };
  let o;
  try { o = parseFlags(args, ['answers', 'repo'], ['answers', 'repo']); }
  catch { return { code: 2, line: 'UNKNOWN usage: an unknown, missing or duplicate flag; use --help' }; }
  try {
    const r = await scaffold(readAnswers(o.answers), { repo: o.repo });
    return { code: r.code, line: oneLine(r.line) };
  } catch (e) { return { code: 2, line: oneLine(`UNKNOWN ${e.message || 'internal error'}`) }; }
}

if (isMain(import.meta.url)) {
  const output = await scaffoldCli(process.argv.slice(2)); process.stdout.write(output.line + '\n'); process.exitCode = output.code;
}
