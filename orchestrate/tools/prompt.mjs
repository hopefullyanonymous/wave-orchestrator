#!/usr/bin/env node
// Renders one per-batch sub-agent prompt into ONE file: a skeleton from subagent-prompts.md,
// every slot filled from the ledger or a facts file, ending with a fresh nonce the report must
// echo. Substitution is a single pass over the SKELETON text, so ledger text that quotes a slot
// token is inserted byte-for-byte and never scanned again. Fail closed: a skeleton slot nothing
// fills, or any doubt about a ledger shape, writes no file.
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { decode, parseFlags, validId, validPath, isMain } from './git-evidence.mjs';
import { exactPaths, table, oneRow, branchCell, skillPin, gitModel } from './ledger-parse.mjs';
import { oneLine } from './check-ledger.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// The skill copy this tool ships in: the same directory the contract's pin line hashes.
const DEFAULT_SKELETONS = path.join(HERE, '..', 'references', 'subagent-prompts.md');
// A rendered block opens with this fence line; the name after the colon is the block's.
const PROMPT_FENCE = /^```prompt:([a-z0-9-]+)$/;
// A regular slot. Any `[` followed by a capital that does not open one is an irregular slot.
const SLOT = /\[[A-Z][A-Z0-9_ -]*\]/g;
const ALONE = /^[ \t]*(\[[A-Z][A-Z0-9_ -]*\])[ \t]*$/;
const NONCE_SLOT = '[NONCE]', COMPOSE_SLOT = '[ROUND 2 BLOCK]';
// The two lines that bound a block's DO paragraph: it opens on the DO line and ends before RULES.
const DO_LINE = 'DO:', RULES_LINE = 'RULES:';

// Each role is one block; reviewer-round2 is the reviewer block with the round-2 block at its
// [ROUND 2 BLOCK] slot, which role reviewer leaves empty; rework is the implementer block with
// the rework block in place of its DO paragraph, the rest (REPORT and nonce line) kept.
export const ROLES = {
  implementer: { block: 'implementer' },
  polish: { block: 'polish' },
  'fix-round': { block: 'fix-round' },
  rework: { block: 'implementer', replaceDo: 'rework' },
  reviewer: { block: 'reviewer', compose: null },
  'reviewer-round2': { block: 'reviewer', compose: 'round-2' },
  'test-hunter': { block: 'test-hunter' },
};
export const BLOCKS = ['implementer', 'polish', 'fix-round', 'rework', 'reviewer', 'round-2', 'test-hunter'];

// The stated defaults, quoted verbatim in subagent-prompts.md beside the reviewer skeleton.
export const DEFAULTS = {
  guardrails: 'none recorded; apply general correctness scrutiny to async/lifecycle/state boundaries',
  noGateAgentDuty: 'Also, for every new or re-pointed test, name the production mutation that would still pass it.',
};

// Every slot the renderer knows: `ledger` slots come from the ledger, `fact` slots from the
// facts file (key named), and two are the renderer's own.
export const SLOTS = {
  '[NN]': { ledger: 'nn' },
  '[CHANGE_ID]': { ledger: 'changeId' },
  '[LEDGER_DIR]': { ledger: 'ledgerDir' },
  '[SKILL_DIR]': { ledger: 'skillDir' },
  '[INTEGRATION_BRANCH]': { ledger: 'integration' },
  '[WORKTREE_SETUP]': { ledger: 'setup' },
  '[BATCH_BRANCH]': { ledger: 'branch' },
  '[FENCE FILES]': { ledger: 'fence' },
  '[BATCH FILENAME]': { ledger: 'batchName' },
  '[TYPE]': { ledger: 'type' },
  '[FULL TEXT OF THE BATCH FILE]': { ledger: 'batchText' },
  '[APPLICABLE GUARDRAILS FROM THE BATCH FILE]': { ledger: 'applicable' },
  '[REPO CONVENTIONS BLOCK FROM THE READBEFORE]': { ledger: 'conventions' },
  '[HARD PROHIBITIONS BLOCK FROM THE READBEFORE]': { ledger: 'prohibitions' },
  '[VALIDATION COMMANDS]': { ledger: 'validation' },
  '[REPO_PATH]': { fact: 'repoPath' },
  '[WORKTREE_PATH]': { fact: 'worktreePath' },
  '[SCRATCHPAD_PATH]': { fact: 'scratchpadPath' },
  '[FINDINGS_FILE]': { fact: 'findingsFile' },
  '[PREVIOUS_FINDINGS_FILE]': { fact: 'previousFindingsFile' },
  '[ROUND1_SHA]': { fact: 'round1Sha' },
  '[ROUND]': { fact: 'round' },
  '[FAILING_ON_BASE_RESULT]': { fact: 'failingOnBase' },
  '[TESTING_GUIDE_PATH]': { fact: 'testingGuidePath' },
  '[NO GATE AGENT DUTY]': { fact: 'gateAgentsRun' },
  '[GUARDRAILS SECTION TEXT]': { fact: 'guardrails', also: ['worktreePath'] },
  [NONCE_SLOT]: { own: 'nonce' },
  [COMPOSE_SLOT]: { own: 'compose' },
};
const STRING_FACTS = ['repoPath', 'worktreePath', 'scratchpadPath', 'findingsFile', 'previousFindingsFile', 'failingOnBase', 'testingGuidePath'];

export class Unknown extends Error {}
// C0, DEL, C1 and the line and paragraph separators, tested by code point: no escape to decode.
const hidden = text => [...text].some(c => { const n = c.codePointAt(0); return n < 32 || (n >= 127 && n <= 159) || n === 0x2028 || n === 0x2029; });

// Every fenced block of the skeleton document, by the name its ```prompt: line gives it.
export function promptBlocks(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n'), blocks = new Map();
  let name = null, body = null;
  for (const line of lines) {
    if (body === null) {
      if (line.startsWith('```')) { name = (PROMPT_FENCE.exec(line) || [])[1] ?? null; body = []; }
    } else if (line.startsWith('```')) {
      if (name !== null) {
        if (blocks.has(name)) throw new Unknown(`skeleton block ${name} occurs twice`);
        blocks.set(name, body.join('\n'));
      }
      body = null;
    } else body.push(line);
  }
  if (body !== null) throw new Unknown('unbalanced code fence in the skeletons');
  return blocks;
}

// The skeleton a role renders, composition applied, before any slot is filled.
export function roleSkeleton(blocks, role) {
  const spec = ROLES[role];
  if (!spec) throw new Unknown(`unknown role ${role}`);
  let text = blocks.get(spec.block);
  if (text === undefined) throw new Unknown(`no \`\`\`prompt:${spec.block} block in the skeletons`);
  if (spec.compose) {
    const inserted = blocks.get(spec.compose);
    if (inserted === undefined) throw new Unknown(`no \`\`\`prompt:${spec.compose} block in the skeletons`);
    if (text.split(COMPOSE_SLOT).length !== 2) throw new Unknown(`${COMPOSE_SLOT} must occur once in the ${spec.block} block`);
    text = text.replace(COMPOSE_SLOT, () => inserted);
  }
  // The DO paragraph is replaced only when each bounding line opens exactly one line, DO first.
  if (spec.replaceDo) {
    const inserted = blocks.get(spec.replaceDo);
    if (inserted === undefined) throw new Unknown(`no \`\`\`prompt:${spec.replaceDo} block in the skeletons`);
    const lines = text.split('\n'), opening = prefix => lines.flatMap((line, i) => line.startsWith(prefix) ? [i] : []);
    const [dos, rules] = [opening(DO_LINE), opening(RULES_LINE)];
    for (const [prefix, found] of [[DO_LINE, dos], [RULES_LINE, rules]]) {
      if (found.length !== 1) throw new Unknown(`"${prefix}" must open exactly one line of the ${spec.block} block, found ${found.length}`);
    }
    if (dos[0] > rules[0]) throw new Unknown(`the ${spec.block} block's "${DO_LINE}" line must come before its "${RULES_LINE}" line`);
    text = [...lines.slice(0, dos[0]), inserted, ...lines.slice(rules[0])].join('\n');
  }
  for (const m of text.matchAll(/\[[A-Z]/g)) {
    const slot = new RegExp(SLOT.source, 'y'); slot.lastIndex = m.index;
    if (!slot.test(text)) throw new Unknown(`irregular slot in the ${role} skeleton: ${text.slice(m.index, m.index + 40).split('\n')[0]}`);
  }
  const lines = text.split('\n'), last = lines.map(l => l.trim()).filter(Boolean).pop() ?? '';
  if (text.split(NONCE_SLOT).length !== 2 || !last.includes(NONCE_SLOT)) throw new Unknown(`the ${role} skeleton must carry ${NONCE_SLOT} once, on its last line`);
  return text;
}

// The facts a role's skeleton needs, in slot order.
export function roleFacts(blocks, role) {
  const facts = [];
  for (const [slot] of roleSkeleton(blocks, role).matchAll(SLOT)) {
    const entry = SLOTS[slot];
    for (const key of entry ? [entry.fact, ...(entry.also || [])] : []) if (key && !facts.includes(key)) facts.push(key);
  }
  return facts;
}

function validateFacts(facts, allowed, role) {
  if (!facts || typeof facts !== 'object' || Array.isArray(facts)) throw new Unknown('facts must be one JSON object');
  for (const [key, value] of Object.entries(facts)) {
    if (!allowed.includes(key)) throw new Unknown(`fact ${key} is not one role ${role} uses (see --help)`);
    const bad = reason => { throw new Unknown(`fact ${key}: ${reason}`); };
    if (STRING_FACTS.includes(key)) { if (typeof value !== 'string' || !value.trim() || hidden(value)) bad('expected a non-empty one-line string'); }
    else if (key === 'round1Sha') { if (typeof value !== 'string' || !/^[0-9a-f]{7,64}$/.test(value)) bad('expected a lowercase hex commit id'); }
    else if (key === 'round') { if (!Number.isInteger(value) || value < 1) bad('expected a positive integer'); }
    else if (key === 'gateAgentsRun') { if (typeof value !== 'boolean') bad('expected true or false'); }
    else if (key === 'guardrails') {
      if (value === 'none') continue;
      const keys = value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value).sort() : [];
      if (keys.join() !== 'file,heading' || !validPath(value.file) || typeof value.heading !== 'string' || !/^#{1,6} \S/.test(value.heading) || hidden(value.heading)) {
        bad('expected "none" or { "file": "<worktree-relative path>", "heading": "<exact heading line>" }');
      }
    }
  }
}

// A heading's body: the lines after its exact heading line, up to the next heading whose level
// is at most `stopAt` (code fences are body), outer blank lines trimmed, bytes otherwise as read.
function sectionOf(text, heading, stopAt, where) {
  const lines = text.split(/(?<=\n)/), bare = l => l.replace(/\r?\n$/, '');
  let fenced = false, start = -1, end = lines.length, count = 0;
  const level = l => { const m = /^(#{1,6})[ \t]/.exec(l); return m ? m[1].length : 0; };
  for (let i = 0; i < lines.length; i++) {
    const line = bare(lines[i]);
    if (/^ {0,3}(?:```|~~~)/.test(line)) { fenced = !fenced; continue; }
    if (fenced) continue;
    if (line === heading) { count++; if (start === -1) start = i; continue; }
    if (start !== -1 && end === lines.length && level(line) && level(line) <= stopAt(level(heading))) end = i;
  }
  if (count !== 1) throw new Unknown(`${where}: ${count ? 'more than one' : 'no'} heading line "${heading}"`);
  const body = lines.slice(start + 1, end).join('').replace(/^(?:[ \t]*\r?\n)+/, '').replace(/\s+$/, '');
  if (!body) throw new Unknown(`${where}: the section under "${heading}" is empty`);
  return body;
}
// Contract sections stop at the next heading of any level; a guardrails section at the next
// heading of the same or a higher level, so its subsections come with it.
const contractSection = (text, heading) => sectionOf(text, heading, () => 6, '00-READBEFORE.md');
export const guardrailSection = (text, heading, where) => sectionOf(text, heading, own => own, where);

function oneMatch(text, pattern, what) {
  const found = [...text.matchAll(pattern)];
  if (found.length !== 1) throw new Unknown(`${what}: expected exactly one, found ${found.length}`);
  return found[0][1];
}
const collapse = text => text.replace(/\s+/g, ' ');
// A batch's type word (fix / feature / chore) becomes its conventional-commit type.
export const COMMIT_TYPES = { feature: 'feat' };

// Every ledger-derived value, read through ledger-parse.mjs and exact headings. Pure: texts in.
export function ledgerValues({ contract, plan, batchName, batchText, batch }) {
  const lf = contract.replace(/\r\n/g, '\n'), lines = lf.split('\n');
  const v = { nn: batch.slice(1), batchName, batchText };
  v.changeId = oneMatch(lf, /^\*\*Change\*\*: (.+)$/gm, 'the **Change**: line').trim();
  if (!validId(v.changeId)) throw new Unknown(`change id ${v.changeId} is not a valid ledger id`);
  const preamble = collapse(lf.slice(0, lf.search(/^## /m) === -1 ? lf.length : lf.search(/^## /m)));
  v.ledgerDir = oneMatch(preamble, /in this ledger directory \(([^()]+)\)/g, 'the ledger directory in the contract preamble');
  if (!validPath(v.ledgerDir)) throw new Unknown(`ledger directory ${v.ledgerDir} is not a repository-relative path`);
  try { v.skillDir = skillPin(contract).dir; } catch (e) { throw new Unknown(`${e.message} in 00-READBEFORE.md`); }
  const gitHeading = oneMatch(lf, /^(## Git model\b.*)$/gm, 'the ## Git model heading');
  const gitSection = collapse(contractSection(lf, gitHeading));
  // The integration branch comes from orchestrate/tools/ledger-parse.mjs `gitModel`; the heading
  // refusals above keep their own wording, and an absent or repeated label refuses here with the
  // number of times it was found.
  let found = 1;
  try { v.integration = gitModel(lf).integration; if (v.integration === null) found = 0; }
  catch (e) {
    if (e.message !== 'Repeated Git model label' || !Number.isInteger(e.count)) throw new Unknown(`00-READBEFORE.md: ${e.message}`);
    found = e.count;
  }
  if (found !== 1) throw new Unknown(`the Git model integration branch: expected exactly one, found ${found}`);
  v.setup = oneMatch(gitSection,/Per-worktree setup: (.+?)\. Same-wave fences were planned disjoint\./g, 'the Git model per-worktree setup');
  v.conventions = contractSection(contract, '## Repo conventions (binding)');
  v.prohibitions = contractSection(contract, '## Hard prohibitions');
  v.validation = contractSection(contract, '## Validation commands');
  let row;
  try {
    row = oneRow(table(plan, ['#', 'Branch', 'Files (fence)']), batch);
    v.branch = branchCell(row.Branch);
    exactPaths(row['Files (fence)']);
  } catch (e) { throw new Unknown(`01-plan.md ${batch}: ${e.message}`); }
  v.fence = row['Files (fence)'];
  const first = batchText.split(/\r?\n/, 1)[0];
  if (!new RegExp(`^# ${batch} (?:—|-) `).test(first)) throw new Unknown(`${batchName}: title must open "# ${batch} — "`);
  const type = (/\(([a-z][a-z-]*), [^()]*\)[ \t]*$/.exec(first) || [])[1];
  if (!type) throw new Unknown(`${batchName}: title must end "(<type>, <version>)"`);
  v.type = Object.hasOwn(COMMIT_TYPES, type) ? COMMIT_TYPES[type] : type;
  const applicable = batchText.split(/\r?\n/).filter(l => l.startsWith('**Applicable guardrails**: '));
  if (applicable.length !== 1 || !applicable[0].slice(27).trim()) throw new Unknown(`${batchName}: needs exactly one non-empty "**Applicable guardrails**: " line`);
  v.applicable = applicable[0].slice(27).trim();
  for (const [key, value] of Object.entries(v)) if (typeof value !== 'string' || !value) throw new Unknown(`empty ledger value ${key}`);
  return v;
}

// Pure core. `readGuardrails(file)` returns the named file's text from the worktree.
export function render({ skeletons, ledger, role, facts, nonce, readGuardrails }) {
  const blocks = promptBlocks(skeletons), skeleton = roleSkeleton(blocks, role);
  validateFacts(facts, roleFacts(blocks, role), role);
  const values = new Map();
  const resolve = slot => {
    const entry = SLOTS[slot];
    if (!entry) return undefined;
    if (entry.ledger) return ledger[entry.ledger];
    if (entry.own === 'nonce') return nonce;
    if (entry.own === 'compose') return '';
    const value = facts[entry.fact];
    if (value === undefined) return undefined;
    if (entry.fact === 'gateAgentsRun') return value ? '' : DEFAULTS.noGateAgentDuty;
    if (entry.fact === 'round') return String(value);
    if (entry.fact !== 'guardrails') return value;
    if (value === 'none') return DEFAULTS.guardrails;
    if (facts.worktreePath === undefined) return undefined;
    return guardrailSection(readGuardrails(value.file), value.heading, value.file);
  };
  for (const [slot] of skeleton.matchAll(SLOT)) {
    if (values.has(slot)) continue;
    const value = resolve(slot);
    if (value === undefined) throw new Unknown(`UNFILLED ${slot}`);
    values.set(slot, value);
  }
  // A line holding only a slot that renders empty goes with it.
  const kept = skeleton.split('\n').filter(line => { const m = ALONE.exec(line); return !(m && values.get(m[1]) === ''); });
  return kept.join('\n').replace(SLOT, slot => values.get(slot)) + '\n';
}

function readText(file, what) {
  let bytes;
  try { if (!fs.statSync(file).isFile()) throw new Error(); bytes = fs.readFileSync(file); } catch { throw new Unknown(`cannot read ${what}`); }
  try { return decode(bytes); } catch { throw new Unknown(`not UTF-8: ${what}`); }
}
const hex = () => randomBytes(6).toString('hex');
const slashes = p => p.split(path.sep).join('/');

function help(skeletonsPath) {
  const blocks = promptBlocks(readText(skeletonsPath, skeletonsPath));
  const roles = Object.keys(ROLES).map(role => `  ${role}: ${roleFacts(blocks, role).join(', ')}`);
  return ['prompt.mjs --ledger <ledger-dir> --role <role> --batch <Bnn> --facts <facts.json> --out <dir> [--skeletons <file>]',
    'Renders one per-batch prompt to <out>/<CHANGE_ID>-B<NN>-<role>-<id>.md and prints ONE line:',
    '  PROMPT <path> NONCE <nonce>  |  UNKNOWN <reason> (UNKNOWN UNFILLED <slot> when a slot has no value; nothing is written)',
    'Exit 0 PROMPT; 2 UNKNOWN. The nonce is only in the file, on its last line. --skeletons defaults to',
    'this skill\'s references/subagent-prompts.md. Facts (a JSON object holding exactly the role\'s keys):',
    ...roles,
    'guardrails: "none" or { "file": "<worktree-relative path>", "heading": "<exact heading line>" }; gateAgentsRun: true | false;',
    'round: a positive integer; round1Sha: a hex commit id; every other fact: a one-line string.'].join('\n');
}

export function promptCli(args) {
  if (args.length === 1 && args[0] === '--help') {
    try { return { code: 0, line: help(DEFAULT_SKELETONS) }; } catch (e) { return { code: 2, line: `UNKNOWN ${e.message}` }; }
  }
  let o;
  try { o = parseFlags(args, ['ledger', 'role', 'batch', 'facts', 'out', 'skeletons'], ['ledger', 'role', 'batch', 'facts', 'out']); }
  catch { return { code: 2, line: 'UNKNOWN usage: an unknown, missing or duplicate flag; use --help' }; }
  try {
    if (!Object.hasOwn(ROLES, o.role)) throw new Unknown(`unknown role ${o.role}; roles: ${Object.keys(ROLES).join(', ')}`);
    if (!/^B\d{2,}$/.test(o.batch)) throw new Unknown(`batch id ${o.batch} must read B<NN>`);
    let facts;
    try { facts = JSON.parse(readText(o.facts, o.facts)); } catch (e) { throw e instanceof Unknown ? e : new Unknown(`facts file is not JSON: ${o.facts}`); }
    let names;
    try { names = fs.readdirSync(o.ledger); } catch { throw new Unknown(`cannot read ledger directory ${o.ledger}`); }
    const own = names.filter(n => n.startsWith(`02-batches-${o.batch.slice(1)}-`) && n.endsWith('.md'));
    if (own.length !== 1) throw new Unknown(`${own.length} batch files 02-batches-${o.batch.slice(1)}-*.md, expected exactly one`);
    const ledger = ledgerValues({ contract: readText(path.join(o.ledger, '00-READBEFORE.md'), '00-READBEFORE.md'),
      plan: readText(path.join(o.ledger, '01-plan.md'), '01-plan.md'), batchName: own[0],
      batchText: readText(path.join(o.ledger, own[0]), own[0]), batch: o.batch });
    const nonce = hex();
    let id = hex();
    while (id === nonce) id = hex();
    const text = render({ skeletons: readText(o.skeletons ?? DEFAULT_SKELETONS, 'the skeletons file'), ledger, role: o.role, facts, nonce,
      readGuardrails: file => readText(path.join(facts.worktreePath, file), `guardrails file ${file}`) });
    const file = path.resolve(o.out, `${ledger.changeId}-B${ledger.nn}-${o.role}-${id}.md`);
    try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, Buffer.from(text, 'utf8'), { flag: 'wx' }); }
    catch { throw new Unknown(`cannot write ${slashes(file)}`); }
    return { code: 0, line: `PROMPT ${slashes(file)} NONCE ${nonce}` };
  } catch (e) { return { code: 2, line: e instanceof Unknown ? `UNKNOWN ${e.message}` : `UNKNOWN internal error: ${e.message}` }; }
}

if (isMain(import.meta.url)) {
  const output = promptCli(process.argv.slice(2));
  process.stdout.write((output.code === 0 && output.line.includes('\n') ? output.line : oneLine(output.line)) + '\n');
  process.exitCode = output.code;
}
