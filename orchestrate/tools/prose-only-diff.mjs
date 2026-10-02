#!/usr/bin/env node
// Classifies a polish diff between two commits in ONE line: PROSE-ONLY when every changed
// JavaScript file differs only in its prose comments, CODE <path> or UNKNOWN <reason> otherwise.
// It reads git objects and writes nothing. A path that is not JavaScript is counted and left to
// the path rule; it never makes the verdict PROSE-ONLY on its own.
import fs from 'node:fs';
import { git, capture, parseFlags, isMain } from './git-evidence.mjs';
import { oneLine } from './check-ledger.mjs';

const JAVASCRIPT = /\.(?:js|cjs|mjs)$/;
const REGULAR = /^100(?:644|755)$/;
// The BOM is kept as text, so adding or dropping one is a change like any other.
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

// A comment that steers a tool is code: rewording it changes what the tool does. No list names
// every tool, so a comment is prose only when `proseShaped` below accepts its text and none of
// four families keeps it; every other comment is doubt, kept as code. The four families keep a
// comment whatever its shape, each catching comments the other three miss: a tool named anywhere
// in the comment, a comment shaped like a directive whatever tool it names, a marker opening it
// (`//#`, `//@`, `/*!`, `///`, `/* global`, `/* exported`), and a JSDoc tag.
export const DIRECTIVES = [
  ['eslint', /(?<![\w-])eslint/i],
  ['istanbul', /(?<![\w-])istanbul(?![\w-])/i],
  ['c8', /(?<![\w-])c8(?![\w-])/i],
  ['@ts-', /@ts-/i],
  ['prettier', /(?<![\w-])prettier/i],
  ['v8', /(?<![\w-])v8(?![\w-])/i],
  ['jshint', /(?<![\w-])jshint/i],
  ['jslint', /(?<![\w-])jslint/i],
  ['biome', /(?<![\w-])biome/i],
  ['deno-lint', /(?<![\w-])deno-lint/i],
  ['oxlint', /(?<![\w-])oxlint/i],
  ['webpack', /(?<![\w-])webpack/i],
  ['turbopack', /(?<![\w-])turbopack/i],
  ['node:coverage', /(?<![\w-])node:coverage(?![\w-])/i],
  ['tslint', /(?<![\w-])tslint/i],
  ['$Flow', /\$Flow[A-Z]\w*/],
  ['LCOV_EXCL', /(?<![\w-])LCOV_EXCL_/],
  ['deepcode', /(?<![\w-])deepcode(?![\w-])/i],
  ['skipcq', /(?<![\w-])skipcq(?![\w-])/i],
  ['Stryker', /(?<![\w-])stryker(?![\w-])/i],
  ['nosemgrep', /(?<![\w-])nosemgrep(?![\w-])/i],
  ['lgtm', /(?<![\w-])lgtm(?![\w-])/i],
  ['codeql', /(?<![\w-])codeql(?![\w-])/i],
  ['cspell', /(?<![\w-])(?:cspell|spell-?checker)\s?:/i],
  ['noinspection', /(?<![\w-])noinspection(?![\w-])/i],
  ['keep-sorted', /(?<![\w-])keep-sorted(?![\w-])/i],
  ['clang-format', /(?<![\w-])clang-format(?![\w-])/i],
  ['spotless', /(?<![\w-])spotless:/i],
  // ESLint's no-fallthrough reads this comment as the intent to fall through.
  ['falls through', /(?<![\w-])falls?\s?through(?![\w-])/i],
];
// A directive's shape, whatever tool it names: the verbs and scopes directives are built from,
// exported so the corpus pins them, and four forms — a tool joined to a verb, with a scope joined
// after it or not (`cspell:disable`, `stylelint-disable-next-line`, `jscpd:ignore-end`); a tool, a
// verb and a scope set apart (`istanbul ignore next`, `Stryker disable all`); a rule id in brackets
// after a word (`lgtm[js/xss]`, `$FlowFixMe[incompatible-call]`); and a shouted NO-marker
// (`NOSONAR`, `NOLINT`, `NOQA`, `NOCOMMIT`), whose second letter may not begin an English word
// (NOT, NOTE, NOW, NONE, NORMAL are left to `proseShaped`, which reads a lone `// NOTE` or a
// leading `NOTE:` as doubt).
export const VERBS = ['disable', 'enable', 'ignore', 'restore', 'suppress', 'expect-error', 'nocheck', 'allow', 'allowlist', 'skip'];
export const SCOPES = ['next-line', 'next', 'line', 'file', 'all', 'start', 'stop', 'end', 'if', 'else'];
const oneOf = words => '(?:' + words.join('|') + ')';
export const SHAPES = [
  ['tool:verb', new RegExp('[A-Za-z][\\w@./]*[:-]\\s?' + oneOf(VERBS) + '(?:[:-]' + oneOf(SCOPES) + ')?(?!\\w)', 'i')],
  ['tool verb scope', new RegExp('[A-Za-z][\\w:.-]*\\s+' + oneOf(VERBS) + '\\s+' + oneOf(SCOPES) + '(?![\\w-])', 'i')],
  ['word[rule-id]', /(?<![\w$-])[A-Za-z$]\w*\s?\[[A-Za-z][\w-]*[/.:_-][\w/.:_-]*\]/],
  ['NO-marker', /(?<![\w-])NO[CFLQS][A-Z]+(?![\w-])/],
];
const MARKER = /^\/[/*]\s*(?:[/!#@]|globals?(?![\w-])|exported(?![\w-]))/;
const TAG = /(?<![\w@.-])@[A-Za-z_$]/;
export function keptBy(comment) {
  return [DIRECTIVES.some(([, pattern]) => pattern.test(comment)) && 'directive', SHAPES.some(([, pattern]) => pattern.test(comment)) && 'shape',
    MARKER.test(comment) && 'marker', TAG.test(comment) && 'tag'].filter(Boolean);
}
// Whether a comment's text is shaped like a sentence, the one form directives are not written in
// (BL-046). Its words are its text less `//`, or less `/*`, `*/` and the `*`s that open a block's
// lines. Prose-shaped: no word at all (an empty `//` names nothing), or all of — two words or
// more (`// ggignore`, `// $ExpectError`); a first word that is plain: letters and digits with an
// inner `.` or `'`, wrapped whole in quotes, backticks or brackets or not, then at most one of
// `. , ; ! ?` (`// eslint-disable-line`, `// NOTE: …`, `// coverity[overrun]`, `//go:build` are
// not); no colon in the second word (`// sourcery skip: …`); no `:` or `=` joining two word
// characters anywhere (`disable=SC2034`; a URL's `://` joins none); and no word opening with `@`
// or `$` and a letter or `_` (`$FlowFixMe`; `@<sha>` and `team@example.com` stay prose). A later
// word may carry a hyphen, an underscore or brackets (`the read-only view`, `reads items[0]`).
// The residual: a directive written only in plain words that no family names (`// nosec B101`,
// `// pragma once`) is prose-shaped, and no rule short of a vocabulary tells it from a sentence.
const PLAIN_WORD = "[\\p{L}\\p{M}\\p{N}]+(?:['.][\\p{L}\\p{M}\\p{N}]+)*";
const PLAIN = new RegExp('^(?:' + ['', '"', "'", '`'].map(q => q + PLAIN_WORD + q).join('|') + '|\\(' + PLAIN_WORD + '\\)|\\[' + PLAIN_WORD + '\\])[.,;!?]?$', 'u');
const JOINED = /[\p{L}\p{M}\p{N}_][:=][\p{L}\p{M}\p{N}_]/u;
const SIGIL = /^[@$][\p{L}_]/u;
export function proseShaped(comment) {
  const text = comment.startsWith('//') ? comment.slice(2)
    : comment.slice(2, -2).replace(new RegExp('(^|' + TERMINATOR.source + ')(?:' + SPACE.source + ')*\\*+', 'gu'), (match, lead) => lead + ' ');
  const words = text.split(/\s+/u).filter(Boolean);
  if (!words.length) return true;
  return words.length >= 2 && PLAIN.test(words[0]) && !words[1].includes(':') && !JOINED.test(text) && !words.some(word => SIGIL.test(word));
}

const TERMINATOR = /[\n\r\u2028\u2029]/;
const SPACE = /[\t\v\f \u00a0\ufeff\p{Zs}]/u;
const isTerminator = c => c !== undefined && TERMINATOR.test(c);
const wordChar = c => c !== undefined && !TERMINATOR.test(c) && !SPACE.test(c) && (/[\w$\\]/.test(c) || c > '\u007f');
// Every reserved word and contextual keyword of the language, placed by what a `/` (or a `<`)
// right after it means. `start`: an expression starts, so a regular expression opens (after
// `break`, `continue` and `debugger` the statement has ended, so one on the next line does too).
// `end`: an operand ended, so it divides — a value, or a name the grammar never reserves where a
// `/` can follow. `doubt`: either may — a keyword or a name by mode or position, or a word no
// valid program puts before a `/`. A word on no list is a name and divides.
export const KEYWORDS = {
  start: new Set(['break', 'case', 'continue', 'debugger', 'default', 'delete', 'do', 'else', 'extends', 'in', 'instanceof', 'new', 'return', 'throw', 'typeof', 'void']),
  end: new Set(['as', 'async', 'false', 'from', 'get', 'meta', 'null', 'set', 'target', 'this', 'true']),
  doubt: new Set(['await', 'catch', 'class', 'const', 'enum', 'export', 'finally', 'for', 'function', 'if', 'implements', 'import', 'interface', 'let', 'of',
    'package', 'private', 'protected', 'public', 'static', 'super', 'switch', 'try', 'var', 'while', 'with', 'yield']),
};
// After `if (…)`, `while (…)`, `for (…)` and `with (…)` a statement starts; after any other `)` an operand ended.
export const CONTROL = new Set(['if', 'while', 'for', 'with']);
// true: an expression starts here; false: an operator does; 'doubt': either may.
function expressionStarts(prev) {
  if (!prev) return true;
  if (prev.type === 'value') return false;
  if (prev.type === 'word') return prev.property ? false : prev.label || KEYWORDS.doubt.has(prev.text) ? 'doubt' : KEYWORDS.start.has(prev.text);
  if (prev.text === ')') return prev.control;
  if (prev.text === ']' || prev.text === '.') return false;
  if (prev.text === '++' || prev.text === '--') return prev.postfix === 'doubt' ? 'doubt' : !prev.postfix;
  return prev.text === '}' ? 'doubt' : true;
}
function stringEnd(source, at) {
  for (let j = at + 1; j < source.length; j++) {
    const c = source[j];
    if (c === source[at]) return j + 1;
    if (c === '\n' || c === '\r') return -1;
    if (c === '\\') j += source.startsWith('\r\n', j + 1) ? 2 : 1;
  }
  return -1;
}
// Where the body closes under one reading of a `[` inside a class: a literal (no `v` flag) or a
// nested class (`v`); -1 where no `/` closes it on its line.
function regexBody(source, at, nesting) {
  let depth = 0;
  for (let j = at + 1; j < source.length; j++) {
    const c = source[j];
    if (isTerminator(c)) return -1;
    if (c === '\\') { j++; if (j >= source.length || isTerminator(source[j])) return -1; }
    else if (c === '[') depth = nesting ? depth + 1 : 1;
    else if (c === ']') depth = nesting ? Math.max(depth - 1, 0) : 0;
    else if (c === '/' && !depth) return j + 1;
  }
  return -1;
}
// The flags that say which reading holds come after the end, so the end is certain only where
// both readings agree: -2 where they differ, -1 where the literal reading finds none.
function regexEnd(source, at) {
  const close = regexBody(source, at, false);
  if (close === -1) return -1;
  if (close !== regexBody(source, at, true)) return -2;
  let end = close;
  while (wordChar(source[end])) end++;
  return end;
}

// The comments of a JavaScript source, found by a tokenizer that tracks strings, template
// literals (with `${}` nesting), regular expressions and both comment forms. Anything it cannot
// delimit with certainty is a failure, never a guess: { ok: false, reason }.
export function scan(source) {
  const comments = [], braces = [], parens = [], n = source.length;
  let i = 0, prev = null, template = false, lineHasCode = false;
  const endOfLine = from => { let j = from; while (j < n && !isTerminator(source[j])) j++; return j; };
  const token = (type, text, extra = {}) => { prev = { type, text, ...extra }; lineHasCode = true; };
  const fail = reason => ({ ok: false, reason });
  if (source.startsWith('#!')) { i = endOfLine(0); lineHasCode = true; }
  while (i < n) {
    const c = source[i], next = source[i + 1];
    if (template) {
      lineHasCode = true;
      if (c === '\\') i += 2;
      else if (c === '`') { template = false; token('value', c); i++; }
      else if (c === '$' && next === '{') { braces.push('${'); template = false; token('punct', '${'); i += 2; }
      else i++;
    } else if (isTerminator(c)) { lineHasCode = false; i++; }
    else if (SPACE.test(c)) i++;
    else if (c === '/' && next === '/') { const end = endOfLine(i); comments.push({ start: i, end }); i = end; }
    else if (c === '/' && next === '*') {
      const close = source.indexOf('*/', i + 2);
      if (close === -1) return fail('an unterminated block comment');
      comments.push({ start: i, end: close + 2 });
      if (TERMINATOR.test(source.slice(i, close))) lineHasCode = false;
      i = close + 2;
    } else if (c === '\'' || c === '"') {
      const end = stringEnd(source, i);
      if (end === -1) return fail('an unterminated string');
      token('value', c); i = end;
    } else if (c === '`') { template = true; lineHasCode = true; i++; }
    else if (c === '/') {
      let starts = expressionStarts(prev);
      // A regular expression closes on its own line: with no later `/` there, it cannot be one.
      if (starts === 'doubt' && !source.slice(i + 1, endOfLine(i)).includes('/')) starts = false;
      if (starts === 'doubt') return fail('a / that may open a regular expression or divide');
      if (starts) {
        const end = regexEnd(source, i);
        if (end === -1) return fail('an unterminated regular expression');
        if (end === -2) return fail('a [ inside a regular expression class (a nested class under the v flag?)');
        token('value', c); i = end;
      } else { token('punct', c); i++; }
    } else if (c === '<' && source.startsWith('<!--', i)) return fail('an HTML-like comment <!--');
    else if (c === '<' && expressionStarts(prev) !== false) return fail('a < where an expression may start (JSX?)');
    else if (c === '<') { const op = /^<<?=?/.exec(source.slice(i, i + 3))[0]; token('punct', op); i += op.length; }
    else if (c === '-' && source.startsWith('-->', i) && !lineHasCode) return fail('an HTML-like comment -->');
    else if (c === '{') { braces.push(c); token('punct', c); i++; }
    else if (c === '}') {
      const open = braces.pop();
      if (open === undefined) return fail('an unmatched }');
      if (open === '${') { template = true; lineHasCode = true; } else token('punct', c);
      i++;
    } else if (c === '(') {
      parens.push(prev?.type === 'word' && !prev.property && (CONTROL.has(prev.text) || (prev.text === 'await' && prev.after === 'for')));
      token('punct', c); i++;
    } else if (c === ')') {
      if (!parens.length) return fail('an unmatched )');
      token('punct', c, { control: parens.pop() }); i++;
    } else if (wordChar(c)) {
      let end = i + 1;
      while (end < n && wordChar(source[end])) end++;
      // A name after `.`, `?.` or `#` (a private name) is never a keyword, however it is spelled;
      // a name on the same line as the `break` or `continue` just before it is that statement's
      // label (across a line break the statement has ended, and it starts the next).
      const property = prev?.text === '.' || prev?.text === '?.' || prev?.text === '#';
      const label = lineHasCode && prev?.type === 'word' && !prev.property && (prev.text === 'break' || prev.text === 'continue');
      token('word', source.slice(i, end), { property, label, after: prev?.text }); i = end;
    } else if ((c === '+' || c === '-') && next === c) {
      // Postfix when an operand ends the same line just before it; otherwise it prefixes what
      // follows. After a keyword-or-name either may hold, so a `/` after it is in doubt.
      const operand = !prev ? false : prev.type === 'value' || prev.text === ']' || (prev.text === ')' && !prev.control) ? true
        : prev.type !== 'word' ? false : prev.property ? true : KEYWORDS.start.has(prev.text) ? false : KEYWORDS.doubt.has(prev.text) ? 'doubt' : true;
      token('punct', c + c, { postfix: lineHasCode ? operand : false }); i += 2;
    }
    else if (c === '?' && next === '.' && !/[0-9]/.test(source[i + 2] ?? '')) { token('punct', '?.'); i += 2; }
    else if (source.startsWith('...', i)) { token('punct', '...'); i += 3; }
    else { token('punct', c); i++; }
  }
  if (template) return fail('an unterminated template literal');
  if (braces.length || parens.length) return fail('an unclosed (, { or ${');
  return { ok: true, comments };
}

// The source less its prose comments, compared byte for byte. A line that held only prose
// comments goes (or stays as an empty line where `lines` keeps the line structure a kept
// comment counts on); spaces and tabs before a comment that ends its line go with it; a block
// comment inside a line becomes one space, and one that spans lines leaves its line break.
export function remainder(source, comments, lines) {
  const removed = comments.filter(c => !c.kept);
  let out = '', k = 0;
  for (let start = 0; ;) {
    let end = start;
    while (end < source.length && !isTerminator(source[end])) end++;
    const eol = source.startsWith('\r\n', end) ? '\r\n' : source.slice(end, end + 1);
    let text = '', touched = false, lastCut = start;
    while (k < removed.length && removed[k].end <= start) k++;
    // An empty line inside a removed comment is the comment's, though the loop below never sees it.
    if (start === end && removed[k] && removed[k].start < start) touched = true;
    for (let j = start; j < end;) {
      while (k < removed.length && removed[k].end <= j) k++;
      const c = removed[k];
      if (c && c.start <= j) {
        if (c.start >= start && c.end <= end && source[c.start + 1] === '*') text += ' ';
        touched = true; j = Math.min(c.end, end); lastCut = j;
      } else {
        const stop = c ? Math.min(c.start, end) : end;
        text += source.slice(j, stop); j = stop;
      }
    }
    if (touched && /^[ \t]*$/.test(source.slice(lastCut, end))) text = text.replace(/[ \t]+$/, '');
    if (!touched || text !== '') out += text + eol;
    else if (lines) out += eol;
    if (!eol) return out;
    start = end + eol.length;
  }
}

// One file's two sides: PROSE-ONLY when their remainders are identical, CODE when not, UNKNOWN
// when either side cannot be read with certainty.
export function compareSources(before, after) {
  const sides = [['base', before], ['head', after]].map(([side, source]) => {
    if (source.includes('\0')) return { side, reason: 'a NUL byte (binary)' };
    const scanned = scan(source);
    if (!scanned.ok) return { side, reason: scanned.reason };
    return { side, source, comments: scanned.comments.map(c => { const text = source.slice(c.start, c.end); return { ...c, kept: keptBy(text).length > 0 || !proseShaped(text) }; }) };
  });
  const failed = sides.find(s => s.reason);
  if (failed) return { verdict: 'UNKNOWN', reason: `${failed.reason} (${failed.side})` };
  // A kept comment may count lines (`next-line`, `ignore next 3`) or annotate the line after it,
  // so either side carrying one keeps every line where it stands.
  const lines = sides.some(s => s.comments.some(c => c.kept));
  const [a, b] = sides.map(s => remainder(s.source, s.comments, lines));
  return { verdict: a === b ? 'PROSE-ONLY' : 'CODE' };
}

export function rawChanges(text) {
  if (text === '') return [];
  const fields = text.split('\0');
  if (fields.pop() !== '' || fields.length % 2) throw new Error('odd field count');
  const changes = [];
  for (let f = 0; f < fields.length; f += 2) {
    const m = /^:([0-7]{6}) ([0-7]{6}) ([0-9a-f]{40}|[0-9a-f]{64}) ([0-9a-f]{40}|[0-9a-f]{64}) ([ADMT])$/.exec(fields[f]);
    if (!m || !fields[f + 1]) throw new Error('unreadable record');
    changes.push({ from: m[1], to: m[2], before: m[3], after: m[4], status: m[5], path: fields[f + 1] });
  }
  return changes.sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));
}
function blobText(repo, sha, options) {
  const r = git(repo, ['cat-file', 'blob', sha], options);
  if (!r.ok) return { reason: r.diagnostic.code === 'invalid-encoding' ? 'text that is not UTF-8' : 'a blob git could not read' };
  return { text: utf8.decode(r.bytes) };
}

const unknown = reason => ({ code: 2, line: `UNKNOWN ${reason}` });
export function proseOnlyDiff({ repo, base, head, ...options }) {
  const diagnostics = [], from = capture(repo, base, diagnostics, options), to = capture(repo, head, diagnostics, options);
  if (!from || !to) return unknown(`cannot resolve ${from ? '--head' : '--base'} to a commit in ${repo}`);
  const diff = git(repo, ['diff', '--raw', '-z', '--no-abbrev', '--no-renames', '--no-relative', '--no-ext-diff', '--no-textconv', '--no-color', from, to, '--'], options);
  if (!diff.ok) return unknown('git diff did not run');
  return classifyRaw(repo, diff.text, options);
}
// The verdict for one `git diff --raw -z` output; blobs are read from `repo`.
export function classifyRaw(repo, raw, options = {}) {
  let changes;
  try { changes = rawChanges(raw); } catch { return unknown('git diff output this tool cannot read'); }
  const code = [], doubts = [];
  let prose = 0, other = 0;
  for (const change of changes) {
    if (!JAVASCRIPT.test(change.path)) other++;
    // Never prose: a mode that changes (added from 000000, deleted to 000000, turned into a link
    // or re-moded), or a path that is not a regular file on either side.
    else if (change.from !== change.to || !REGULAR.test(change.from)) code.push(change.path);
    else {
      const [a, b] = [change.before, change.after].map(sha => blobText(repo, sha, options));
      const result = a.reason || b.reason ? { verdict: 'UNKNOWN', reason: `${a.reason || b.reason} (${a.reason ? 'base' : 'head'})` } : compareSources(a.text, b.text);
      if (result.verdict === 'UNKNOWN') doubts.push(`${change.path}: ${result.reason}`);
      else if (result.verdict === 'CODE') code.push(change.path);
      else prose++;
    }
  }
  const others = other ? `; ${other} other path(s) left to the path rule` : '';
  if (doubts.length) return unknown(doubts[0]);
  if (code.length) return { code: 1, line: `CODE ${code[0]}` };
  if (!prose) return unknown(`no JavaScript file changed${others}`);
  return { code: 0, line: `PROSE-ONLY ${prose} file(s)${others}` };
}

const HELP = `prose-only-diff.mjs --repo <repo> --base <ref> --head <ref>
Classifies the committed diff from <base> to <head>. Each changed JavaScript file (.js, .cjs, .mjs) is
compared with its prose comments stripped from both sides; every other path is counted and left to the
path rule. Prints ONE line: PROSE-ONLY <n> file(s), with "; <m> other path(s) left to the path rule" when
there are any, exits 0 when every JavaScript remainder is byte-identical; CODE <path>, the first
JavaScript file whose remainder differs, exits 1; UNKNOWN <reason> exits 2. UNKNOWN outranks CODE, and
CODE outranks PROSE-ONLY. Fails closed: a comment is prose only when it is shaped like a sentence (two words
or more, a plain first word, no colon in the second, no word:word or word=word join, no @name or $name) and
names or is shaped like no tool directive (eslint, istanbul, c8, @ts-, prettier, node:coverage and others)
and carries no JSDoc tag; every other comment is code, so an unlisted tool's directive is too, though one
written in plain words alone (nosec B101) reads as prose. An added, deleted or re-moded file is code too; a
string, template literal or regular expression it cannot delimit with certainty, JSX, a binary, and a
diff with no JavaScript file are UNKNOWN. Read-only: it reads git objects and writes nothing.`;

export function proseOnlyDiffCli(args) {
  if (args.length === 1 && args[0] === '--help') return { code: 0, line: HELP };
  let flags;
  try { flags = parseFlags(args, ['repo', 'base', 'head'], ['repo', 'base', 'head']); }
  catch { return { code: 2, line: 'UNKNOWN usage: unknown, missing or duplicate flag; use --help' }; }
  return proseOnlyDiff(flags);
}

if (isMain(import.meta.url)) {
  // Exit 1 reads as CODE, so a crash never ends with it: UNKNOWN, exit 2.
  process.on('uncaughtException', e => { fs.writeSync(1, oneLine(`UNKNOWN internal error: ${e?.message ?? e}`) + '\n'); process.exit(2); });
  const output = proseOnlyDiffCli(process.argv.slice(2));
  process.stdout.write((output.line === HELP ? HELP : oneLine(output.line)) + '\n');
  process.exitCode = output.code;
}
