// Checkpoint input declarations are evidence, not workbook semantic validation.
// Keep history comparisons pure; disk checks hash the exact delivered bytes.
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
}
function text(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be nonempty text`);
}
export function inputPath(value, label = 'input path') {
  text(value, label);
  // One portable spelling, also safe as a relative browser URL after encoding.
  // Reject Windows aliases/ADS and ambiguous trailing dots or spaces on every OS.
  if (isAbsolute(value) || /[\\:<>"|?*\u0000-\u001f\u007f]/.test(value) || value.startsWith('/') ||
      value.split('/').some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part) ||
        /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
    throw new Error(`${label} must be a safe relative file path: ${JSON.stringify(value)}`);
  }
  return value;
}
function file(value, label) {
  object(value, label);
  inputPath(value.path, `${label}.path`);
  if (typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256)) {
    throw new Error(`${label}.sha256 must be a lowercase SHA-256 of raw file bytes`);
  }
  if (!Number.isSafeInteger(value.size) || value.size < 0) throw new Error(`${label}.size must be a nonnegative safe integer`);
  return { path: value.path, sha256: value.sha256, size: value.size };
}
const pathKey = value => value.toLowerCase(); // Reject collisions on Windows as well as POSIX.

export function declareInputs(data) {
  const inputs = data.inputs === undefined ? [] : data.inputs;
  const history = data.inputHistory === undefined ? [] : data.inputHistory;
  if (!Array.isArray(inputs)) throw new Error('inputs must be a stable-id registry array');
  if (!Array.isArray(history)) throw new Error('inputHistory must be an array');
  const byId = new Map(), artifacts = new Map();
  function addFile(value, label) {
    const descriptor = file(value, label), key = pathKey(descriptor.path);
    const old = artifacts.get(key);
    if (old && !isDeepStrictEqual(old, descriptor)) throw new Error(`conflicting issued input path: ${descriptor.path}`);
    artifacts.set(key, descriptor);
  }
  for (const input of inputs) {
    object(input, 'input');
    if (typeof input.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(input.id)) throw new Error('input.id must be a stable nonempty id');
    if (byId.has(input.id)) throw new Error(`duplicate input id: ${input.id}`);
    addFile(input, `input ${input.id}`);
    for (const field of ['requirements', 'use', 'reset']) text(input[field], `input ${input.id}.${field}`);
    if (!['read-only', 'working-copy'].includes(input.mode)) throw new Error(`input ${input.id}.mode must be read-only or working-copy`);
    addFile(input.validation, `input ${input.id}.validation`);
    for (const field of ['command', 'result', 'env']) text(input.validation[field], `input ${input.id}.validation.${field}`);
    if (input.validation.exitCode !== 0) throw new Error(`input ${input.id}.validation.exitCode must be 0; unvalidated inputs cannot be issued`);
    byId.set(input.id, input);
  }
  const historyPaths = new Set();
  for (const entry of history) {
    addFile(entry, 'inputHistory entry');
    const key = pathKey(entry.path);
    if (historyPaths.has(key)) throw new Error(`duplicate inputHistory path: ${entry.path}`);
    historyPaths.add(key);
  }
  const byStep = new Map();
  for (const section of data.sections || []) for (const step of section.steps || []) {
    if (Object.hasOwn(step, 'inputFiles')) throw new Error(`step ${step.n}.inputFiles is reserved for resolved input declarations`);
    const refs = step.inputs === undefined ? [] : step.inputs;
    if (!Array.isArray(refs)) throw new Error(`step ${step.n}.inputs must be an array of input ids`);
    const seen = new Set();
    byStep.set(step.n, refs.map(id => {
      if (typeof id !== 'string' || !byId.has(id)) throw new Error(`step ${step.n} has a dangling input reference: ${JSON.stringify(id)}`);
      if (seen.has(id)) throw new Error(`step ${step.n} repeats input reference: ${id}`);
      seen.add(id);
      return byId.get(id);
    }));
  }
  return { byId, byStep, artifacts };
}

// No filesystem reads here: a previous sidecar is historical metadata even if its
// snapshot lives in a temporary directory. The caller separately verifies retention.
export function compareInputHistory(current, previous) {
  for (const [key, old] of previous.artifacts) {
    const retained = current.artifacts.get(key);
    if (!retained) throw new Error(`required prior input artifact is missing from inputs/inputHistory: ${old.path}`);
    if (!isDeepStrictEqual(retained, old)) throw new Error(`issued input path is immutable: ${old.path}; use a new issue directory`);
  }
}

export function validateInputFiles(declaration, inputRoot) {
  if (!declaration.artifacts.size) return;
  if (typeof inputRoot !== 'string' || !inputRoot.trim()) throw new Error('declared inputs require an explicit inputRoot');
  const root = realpathSync(resolve(inputRoot));
  for (const artifact of declaration.artifacts.values()) {
    let target = root;
    try {
      // Reject links even when they currently resolve inside root: a delivered
      // package must contain its files, not depend on mutable external pointers.
      for (const component of artifact.path.split('/')) {
        target = resolve(target, component);
        if (lstatSync(target).isSymbolicLink()) throw new Error('symbolic links are not permitted');
      }
      const actual = realpathSync(target), rel = relative(root, actual);
      if (rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) throw new Error('file escapes inputRoot');
      if (!lstatSync(actual).isFile()) throw new Error('not a regular file');
      const bytes = readFileSync(actual);
      if (bytes.length !== artifact.size) throw new Error(`size mismatch (expected ${artifact.size}, read ${bytes.length})`);
      if (createHash('sha256').update(bytes).digest('hex') !== artifact.sha256) throw new Error('SHA-256 mismatch for raw file bytes');
    } catch (error) {
      throw new Error(`input artifact ${artifact.path}: ${error.message}`);
    }
  }
}

// The browser receives resolved descriptors, so registry edits cannot hide behind
// unchanged IDs. Preserve the no-input template shape for legacy sidecars.
export function sectionsWithInputs(data, declaration) {
  return data.sections.map(section => ({ ...section, steps: section.steps.map(step => {
    const resolved = declaration.byStep.get(step.n);
    return resolved.length ? { ...step, inputFiles: resolved } : step;
  }) }));
}
