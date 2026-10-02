// The one ledger parser: every ledger writer and checker reads tables, fences, extension
// records and the skill pin through these functions, never through a private copy.
import { validPath } from './git-evidence.mjs';

export const linesOf = text => text.split(/\r?\n/);
export function exactPaths(text) {
  const paths = [];
  let remaining = text.trim();
  while (remaining) {
    const m = /^`([^`]+)`(?:\s*,\s*|$)/.exec(remaining);
    if (!m || !validPath(m[1]) || paths.includes(m[1])) throw new Error('Expected unique exact repository-relative backtick paths (globs unsupported)');
    paths.push(m[1]); remaining = remaining.slice(m[0].length);
  }
  if (!paths.length) throw new Error('Empty file fence');
  return paths;
}
export function table(text, required) {
  const lines = linesOf(text), matches = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith('|')) continue;
    const header = lines[i].split('|').slice(1, -1).map(x => x.trim());
    if (!required.every(key => header.includes(key))) continue;
    if (new Set(header).size !== header.length || !/^\|[\s:|-]+\|$/.test(lines[++i] || '')) throw new Error('Malformed table header');
    const rows = [];
    while (++i < lines.length && lines[i].startsWith('|')) {
      const cells = lines[i].split('|').slice(1, -1).map(x => x.trim());
      if (cells.length !== header.length) throw new Error('Malformed table row');
      rows.push({ ...Object.fromEntries(header.map((key, n) => [key, cells[n]])), line: i + 1 });
    }
    matches.push(rows);
  }
  if (matches.length !== 1) throw new Error('Missing or ambiguous authority table');
  return matches[0];
}
export function oneRow(rows, id) {
  const ids = rows.map(r => r['#']);
  if (new Set(ids).size !== ids.length || ids.some(x => !/^B\d{2,}$/.test(x))) throw new Error('Duplicate or malformed batch IDs');
  const matches = rows.filter(r => r['#'] === id);
  if (matches.length !== 1) throw new Error('Missing or duplicate requested batch');
  return matches[0];
}
export function branchCell(text) {
  const match = /^(?:`([^`]+)`|([^`]+))$/.exec(text);
  if (!match) throw new Error('Malformed branch cell');
  return match[1] || match[2];
}
export function records(text, rowId) {
  const results = [], re = /(?<!\S)fence \+(`[^`]+`|[^\r\n()]+?) \(([^()\r\n]+)\)/g;
  for (const m of text.matchAll(re)) {
    const file = m[1].startsWith('`') ? m[1].slice(1, -1) : m[1];
    const parts = m[2].split(',').map(x => x.trim());
    let id = rowId;
    if (parts.length === 4) id = parts.shift();
    if (parts.length !== 3 || !parts.every(Boolean) || !/^\d{4}-\d{2}-\d{2}$/.test(parts[2]) || !/^B\d{2,}$/.test(id || '') || !validPath(file)) throw new Error('Malformed fence extension');
    results.push({ path: file, id, item: parts[0], reason: parts[1], date: parts[2], spelling: m[0] });
  }
  if ((text.match(/fence\s*\+/g) || []).length !== results.length) throw new Error('Unsupported fence extension grammar');
  return results;
}
export function extensions(progress, row, id) {
  const authorized = records(row.Notes, id);
  if (authorized.some(r => r.id !== id) || new Set(authorized.map(r => r.path)).size !== authorized.length) throw new Error('Mismatched or ambiguous extension in Notes');
  const sections = [...progress.matchAll(/^## Session log\s*\r?$/gm)];
  if (!authorized.length) return [];
  if (sections.length !== 1) throw new Error('Extension needs an unambiguous session log');
  const tail = progress.slice(sections[0].index + sections[0][0].length).split(/^## /m)[0];
  // Short records are bound by their identical text to one Notes row, never by a substring.
  const logs = records(tail, id);
  const allRows = table(progress, ['#', 'Branch', 'Notes']);
  for (const r of authorized) {
    const matching = logs.filter(l => l.id === r.id && l.path === r.path && l.item === r.item && l.reason === r.reason && l.date === r.date);
    if (matching.length !== 1) throw new Error('Extension needs exactly one matching session-log authorization');
    const notesOwners = allRows.filter(candidate => records(candidate.Notes, candidate['#']).some(n => n.path === r.path && n.item === r.item && n.reason === r.reason && n.date === r.date));
    if (notesOwners.length !== 1) throw new Error('Extension cannot be bound to one batch row');
  }
  return authorized.map(r => r.path);
}
// The contract's skill pin: exactly one line in exactly this form, after CRLF becomes LF.
// Any line opening with the label in another case or indent counts, so a near-miss is a
// duplicate or a malformed line rather than a line silently skipped.
const PIN = /^\*\*Skill\*\*: `(?<dir>[^`]+)` · sha256 `(?<hex>[0-9a-f]{64})`$/;
export function skillPin(contractText) {
  const candidates = linesOf(contractText).filter(l => /^\s*\*\*skill\*\*/i.test(l));
  if (!candidates.length) throw new Error('Missing skill pin line');
  if (candidates.length !== 1) throw new Error('Duplicated skill pin line');
  const m = PIN.exec(candidates[0]);
  if (!m) throw new Error('Malformed skill pin line');
  return { dir: m.groups.dir, hex: m.groups.hex };
}
// The contract's Git model: the one `## Git model` heading line (counted inside code fences too,
// and refused there), its body up to the next heading outside a code fence, the whitespace
// collapsed. Each label's backtick value is returned raw (null when the label is absent) and
// never validated: each caller checks only the fields it reads, so a label given twice throws
// only when its own field is read, carrying the number of times as `count`. Read by orchestrate/tools/prompt.mjs `ledgerValues` and
// orchestrate/tools/check-ledger.mjs `checkLedger`.
const GIT_LABELS = {
  main: /Default branch \(protected local ref\): `([^`]+)`/g, integration: /Integration branch: `([^`]+)`/g,
  shipmentSource: /Shipment source: `([^`]+)`/g, shipmentRef: /Shipment ref: `([^`]+)`/g,
};
export function gitModel(contractText) {
  const lines = contractText.replace(/\r\n/g, '\n').split('\n'), headings = lines.filter(l => /^## Git model\b/.test(l));
  if (headings.length !== 1) throw new Error('Missing or duplicated Git model heading');
  let fenced = false, start = -1, end = lines.length;
  for (let i = 0; i < lines.length && end === lines.length; i++) {
    if (/^ {0,3}(?:```|~~~)/.test(lines[i])) { fenced = !fenced; continue; }
    if (fenced) continue;
    if (lines[i] === headings[0]) start = i;
    else if (start !== -1 && /^#{1,6}[ \t]/.test(lines[i])) end = i;
  }
  if (start === -1) throw new Error('Missing or duplicated Git model heading');
  const body = lines.slice(start + 1, end).join('\n').replace(/\s+/g, ' ');
  const field = key => {
    const found = [...body.matchAll(GIT_LABELS[key])];
    if (found.length > 1) throw Object.assign(new Error('Repeated Git model label'), { count: found.length });
    return found.length ? found[0][1] : null;
  };
  return {
    get main() { return field('main'); }, get integration() { return field('integration'); },
    get shipmentSource() { return field('shipmentSource'); }, get shipmentRef() { return field('shipmentRef'); },
  };
}
