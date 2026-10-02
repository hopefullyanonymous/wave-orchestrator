'use strict';
// prose-only-diff.mjs lets a polish diff that only rewords comments skip the scoped re-review, so
// a false PROSE-ONLY waves code through unreviewed. The corpus is written as prose first: each
// rejection rule is a pair of edits, the case it must catch and a twin that differs from it only
// in lacking that rule's trigger and must read PROSE-ONLY. The twin is the proof that this rule,
// and no other, is what the case turns on. Every pair runs through the CLI exactly as protocol.md
// publishes it, on real commits, and through the pure core with LF and CRLF line ends alike.
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');
const { makeRepo } = require('./support/git-fixture.cjs');
const ROOT = path.resolve(__dirname, '..');
const TOOL = path.join(ROOT, 'orchestrate', 'tools', 'prose-only-diff.mjs');
const api = import(pathToFileURL(TOOL).href);
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const NUL = String.fromCharCode(0);
// Built, never typed: a raw line separator or no-break space in this file is refused by the
// invisible-character sweep, and an escape can be decoded into one on the way in.
const LS = String.fromCharCode(0x2028), NBSP = String.fromCharCode(0xa0);

// ---- The corpus, rule by rule: [rule, verdict, [before, after], twin [before, after]] ----------
// Where a case holds a `//` that a broken rule would misread as a comment, the misread comment is
// shaped like a sentence, so the misread reads PROSE-ONLY and the case goes red (BL-046).
const RULES = [
  ['a // inside a string is string text', 'CODE',
    ["export const BANNER = '// generated file, do not edit';\n", "export const BANNER = '// generated file, do not change';\n"],
    ["export const BANNER = ''; // generated file, do not edit\n", "export const BANNER = ''; // generated file, do not change\n"]],
  ['a /* inside a template literal is template text', 'CODE',
    ['export const banner = `/* build ${version} */`;\n', 'export const banner = `/* release ${version} */`;\n'],
    ['export const banner = `${version}`; /* build tag */\n', 'export const banner = `${version}`; /* release tag */\n']],
  ['a // inside a regular expression is pattern text', 'CODE',
    ['export const isUrl = s => /^https?:\\/\\//i.test (s) && s.length > 8;\n', 'export const isUrl = s => /^https?:\\/\\//i.test (s) && s.length > 9;\n'],
    ['export const isUrl = s => /^https?:\\/\\//i.test (s); // longer than 8\n', 'export const isUrl = s => /^https?:\\/\\//i.test (s); // longer than 9\n']],
  ['a regular expression after a control statement opens there', 'CODE',
    ['if (ready) /[// note a]/.test(input);\n', 'if (ready) /[// note b]/.test(input);\n'],
    ['if (ready) /[/]/.test(input); // note a\n', 'if (ready) /[/]/.test(input); // note b\n']],
  ['a regular expression after for await ( opens there', 'CODE',
    ['for await (const line of lines) /[// note a]/.test(line);\n', 'for await (const line of lines) /[// note b]/.test(line);\n'],
    ['for await (const line of lines) /[/]/.test(line); // note a\n', 'for await (const line of lines) /[/]/.test(line); // note b\n']],
  ['a comment naming a tool directive is code', 'CODE',
    ['// eslint-disable-next-line no-console -- the CLI prints its result\nconsole.log(result);\n',
      '// eslint-disable-next-line no-console -- the CLI prints the result\nconsole.log(result);\n'],
    ['// the CLI prints its result\nconsole.log(result);\n', '// the CLI prints the result\nconsole.log(result);\n']],
  ['a comment carrying a JSDoc tag is code', 'CODE',
    ['/**\n * Adds two numbers.\n * @param {number} a the first addend\n */\nexport function add(a, b) { return a + b; }\n',
      '/**\n * Adds two numbers.\n * @param {number} a the left addend\n */\nexport function add(a, b) { return a + b; }\n'],
    ['/**\n * Adds two numbers.\n * a is the first addend\n */\nexport function add(a, b) { return a + b; }\n',
      '/**\n * Adds two numbers.\n * a is the left addend\n */\nexport function add(a, b) { return a + b; }\n']],
  ['a comment opening with a marker is code', 'CODE',
    ['export default run;\n//# sourceMappingURL=run.js.map\n', 'export default run;\n//# sourceMappingURL=run.mjs.map\n'],
    ['export default run;\n// map at run.js.map\n', 'export default run;\n// map at run.mjs.map\n']],
  ['a prose line added under a line-counting directive moves what it covers', 'CODE',
    ['// eslint-disable-next-line no-eval\neval(code);\n', "// eslint-disable-next-line no-eval\n// Runs the user's snippet.\neval(code);\n"],
    ['eval(code);\n', "// Runs the user's snippet.\neval(code);\n"]],
  ['a prose line added under a JSDoc-tagged comment moves what it annotates', 'CODE',
    ['/** @returns {number} */\nconst f = () => 1;\n', '/** @returns {number} */\n// One, always.\nconst f = () => 1;\n'],
    ['/** Returns one. */\nconst f = () => 1;\n', '/** Returns one. */\n// One, always.\nconst f = () => 1;\n']],
  ['whitespace in code is code', 'CODE',
    ['export const limit = 10;\n', 'export const limit =  10;\n'],
    ['export const limit = 10; // at most ten\n', 'export const limit = 10; // at most  ten\n']],
  ['one character of code is code', 'CODE',
    ['export const add = (a, b) => a + b;\n', 'export const add = (a, b) => a - b;\n'],
    ['// a + b\nexport const add = (a, b) => a + b;\n', '// a - b\nexport const add = (a, b) => a + b;\n']],
  ['a block comment holding a line break is a line break', 'CODE',
    ['export function f(x) {\n  return /* the\n  value */ x;\n}\n', 'export function f(x) {\n  return /* the value */ x;\n}\n'],
    ['export function f(x) {\n  return /* the value */ x;\n}\n', 'export function f(x) {\n  return /* its value */ x;\n}\n']],
  ['a / after a prefix ++ opens a regular expression', 'CODE',
    ['x = ++/[// note a]/.lastIndex;\n', 'x = ++/[// note b]/.lastIndex;\n'],
    ['x = count++ /[// note a]/.lastIndex;\n', 'x = count++ /[// note b]/.lastIndex;\n']],
  ['a line break before ++ makes it a prefix', 'CODE',
    ['x = count\n++/[// note a]/.lastIndex;\n', 'x = count\n++/[// note b]/.lastIndex;\n'],
    ['x = count ++/[// note a]/.lastIndex;\n', 'x = count ++/[// note b]/.lastIndex;\n']],
  ['a block comment between two words keeps them apart', 'CODE',
    ['const t = typeof/* the name */value;\n', 'const t = typeofvalue;\n'],
    ['const t = typeof/* the name */value;\n', 'const t = typeof/* its name */value;\n']],
  ['a word after # is a private name, never a keyword', 'CODE',
    ["half() { return this.#default / pick('/') + pick('//x'); }\n", "half() { return this.#default / pick('/') + pick('//y'); }\n"],
    ["half() { return this.#default / pick('/') + pick(''); } // note x\n", "half() { return this.#default / pick('/') + pick(''); } // note y\n"]],
  ['a keyword after a spread opens an expression', 'CODE',
    ['x = [...typeof /[// note a]/].length;\n', 'x = [...typeof /[// note a]/].length + 1;\n'],
    ['x = [...typeof /[/]/].length; // note a\n', 'x = [...typeof /[/]/].length; // note b\n']],
  ['an escaped backtick stays inside its template literal', 'CODE',
    ['const t = `it\\`s // note one`;\n', 'const t = `it\\`s // note two`;\n'],
    ['const t = `its`; // note one\n', 'const t = `its`; // note two\n']],
  ['an escaped quote stays inside its string', 'CODE',
    ["const s = 'it\\'s // note one';\n", "const s = 'it\\'s // note two';\n"],
    ["const s = 'it\\'s // no comment'; // note a\n", "const s = 'it\\'s // no comment'; // note b\n"]],
  ['a ++ after an operand keyword is a prefix', 'CODE',
    ['x = typeof ++/[// note a]/.lastIndex;\n', 'x = typeof ++/[// note b]/.lastIndex;\n'],
    ['x = typeOf ++/[// note a]/.lastIndex;\n', 'x = typeOf ++/[// note b]/.lastIndex;\n']],
  ["a ++ after a control statement's ) is a prefix", 'CODE',
    ['if (ok) ++/[// note a]/.lastIndex;\n', 'if (ok) ++/[// note b]/.lastIndex;\n'],
    ['f(ok) ++/[// note a]/.lastIndex;\n', 'f(ok) ++/[// note b]/.lastIndex;\n']],
  ['a / after a prefix -- opens a regular expression', 'CODE',
    ['x = --/[// note a]/.lastIndex;\n', 'x = --/[// note b]/.lastIndex;\n'],
    ['x = count--/[// note a]/.lastIndex;\n', 'x = count--/[// note b]/.lastIndex;\n']],
  ['a / first in a file opens a regular expression', 'CODE',
    ['/[// note a]/.test(s);\n', '/[// note b]/.test(s);\n'],
    ['s /[// note a]/.test(s);\n', 's /[// note b]/.test(s);\n']],
  ['a hashbang is code', 'CODE',
    ['#!/usr/bin/env node\nrun();\n', '#!/usr/bin/env -S node\nrun();\n'],
    ['// runs usr/bin/env node\nrun();\n', '// runs usr/bin/env -S node\nrun();\n']],
  ['a / after } with a second / on its line is in doubt', 'UNKNOWN',
    ['if (ready) { start(); }\n/[/]/.test(input); // note a\n', 'if (ready) { start(); }\n/[/]/.test(input); // note b\n'],
    ['if (ready) { start(); }\n;/[/]/.test(input); // note a\n', 'if (ready) { start(); }\n;/[/]/.test(input); // note b\n']],
  ['a / after a word that may be a keyword is in doubt', 'UNKNOWN',
    ['for (const part of /[/]/.exec(path)) use(part); // note a\n', 'for (const part of /[/]/.exec(path)) use(part); // note b\n'],
    ['for (const part of (/[/]/.exec(path))) use(part); // note a\n', 'for (const part of (/[/]/.exec(path))) use(part); // note b\n']],
  ['a < where an expression starts is JSX', 'UNKNOWN',
    ['const view = <b>https://example.com</b>;\n// note a\n', 'const view = <b>https://example.com</b>;\n// note b\n'],
    ['const view = a <b;\n// note a\n', 'const view = a <b;\n// note b\n']],
  ['a < after } is in doubt', 'UNKNOWN',
    ['if (a) {}\n<b>a // note com</b>;\n', 'if (a) {}\n<b>a // note org</b>;\n'],
    ['if (a) {}\nx <b>a // note com</b>;\n', 'if (a) {}\nx <b>a // note org</b>;\n']],
  ['a < after a keyword-or-name is in doubt', 'UNKNOWN',
    ['for (const x of xs) yield <li>// the {x.a}</li>;\n', 'for (const x of xs) yield <li>// the {x.b}</li>;\n'],
    ['for (const x of xs) yield x <li>// the {x.a}</li>;\n', 'for (const x of xs) yield x <li>// the {x.b}</li>;\n']],
  ['<!-- opens an HTML-like comment', 'UNKNOWN',
    ['x = y <!--z;\n// note a\n', 'x = y <!--z;\n// note b\n'],
    ['x = y < !--z;\n// note a\n', 'x = y < !--z;\n// note b\n']],
  ['--> at a line start closes an HTML-like comment', 'UNKNOWN',
    ['x = 1;\n  --> a note\n// note a\n', 'x = 1;\n  --> a note\n// note b\n'],
    ['x = 1;\n  y-->0;\n// note a\n', 'x = 1;\n  y-->0;\n// note b\n']],
  ['--> after a block comment that broke the line is at a line start', 'UNKNOWN',
    ['x = 1; /* a\n b */ --> note\n// note a\n', 'x = 1; /* a\n b */ --> note\n// note b\n'],
    ['x = 1; /* a b */ --> note\n// note a\n', 'x = 1; /* a b */ --> note\n// note b\n']],
  ['a NUL byte is a binary', 'UNKNOWN',
    ['export const a = 1; // a' + NUL + '\n', 'export const a = 1; // b' + NUL + '\n'],
    ['export const a = 1; // note a\n', 'export const a = 1; // note b\n']],
  ['a template literal left open is a parse that cannot finish', 'UNKNOWN',
    ['export const t = `open ${x}; // note a\n', 'export const t = `open ${x}; // note b\n'],
    ['export const t = `open ${x}`; // note a\n', 'export const t = `open ${x}`; // note b\n']],
  // Written without semicolons: the statement ends at the line break, so the next line's `/`
  // opens a regular expression, never divides.
  ['a regular expression on the line after break opens there', 'CODE',
    ['for (const s of xs) {\n  if (s.done) break\n  /^https?:\\/\\//i.test (s.url) && out.push(s)\n}\n', 'for (const s of xs) {\n  if (s.done) break\n  /^https?:\\/\\//i.test (s.url) && out.unshift(s)\n}\n'],
    ['x = breaks\n/[// note a]/.test(s);\n', 'x = breaks\n/[// note b]/.test(s);\n']],
  ['a regular expression on the line after continue opens there', 'CODE',
    ['for (const s of xs) {\n  if (!s) continue\n  /^https?:\\/\\//i.test (s) && out.push(s)\n}\n', 'for (const s of xs) {\n  if (!s) continue\n  /^https?:\\/\\//i.test (s)\n}\n'],
    ['x = continued\n/[// note a]/.test(s);\n', 'x = continued\n/[// note b]/.test(s);\n']],
  ['a regular expression on the line after debugger opens there', 'CODE',
    ['debugger\n/[// note a]/.test(s);\n', 'debugger\n/[// note b]/.test(s);\n'],
    ['debug()\n/[// note a]/.test(s);\n', 'debug()\n/[// note b]/.test(s);\n']],
  ['a comment shaped like a tool directive is code, whatever tool it names', 'CODE',
    ['// Stryker disable next-line all\nreturn a + b;\n', '// Stryker disable all\nreturn a + b;\n'],
    ['// Tests ignore next-gen flags.\nreturn a + b;\n', '// Tests ignore all-caps flags.\nreturn a + b;\n']],
  ['a comment carrying a rule id in brackets is code', 'CODE',
    ['// lgtm[js/xss]\nreturn html;\n', '// lgtm[js/sql-injection]\nreturn html;\n'],
    ['// the items[0] is the head\nreturn html;\n', '// the items[1] is the next\nreturn html;\n']],
  ['a comment shouting a NO-marker is code', 'CODE',
    ['// NOLINT\nreturn html;\n', '// NOLINT(readability)\nreturn html;\n'],
    ['// NOTE this\nreturn html;\n', '// NOTE this order\nreturn html;\n']],
  // BL-046: no family names coverity's event syntax; the comment's shape alone keeps it.
  ['a comment not shaped like a sentence is code, whatever tool it names', 'CODE',
    ['return html; // coverity[overrun]\n', 'return html; // coverity[overrun_local]\n'],
    ['return html; // coverity reads the overrun\n', 'return html; // coverity reads the local overrun\n']],
  ['a blank line inside a template literal is template text', 'CODE',
    ['const HELP = `usage\n\nflags`;\n', 'const HELP = `usage\nflags`;\n'],
    ['/* usage\n\nflags */\nconst HELP = 1;\n', '/* usage\nflags */\nconst HELP = 1;\n']],
  ['trailing whitespace after code that follows an inline block comment is code', 'CODE',
    ['f(/* a note */ 1);  \n', 'f(/* a note */ 1); \n'],
    ['f(1); /* a note */  \n', 'f(1); /* a note */ \n']],
  ['a line separator ends a line comment', 'CODE',
    ['// note' + LS + 'process.exit(1);\n', '// note' + LS + 'process.exit(0);\n'],
    ['// note process.exit(1);\n', '// note process.exit(0);\n']],
  ['a non-ASCII space keeps two words apart', 'CODE',
    ['x = typeof' + NBSP + '/[// note a]/.test(s);\n', 'x = typeof' + NBSP + '/[// note b]/.test(s);\n'],
    ['x = typeof_/[// note a]/.test(s);\n', 'x = typeof_/[// note b]/.test(s);\n']],
  ["a regular expression after a control statement's ) opens there whatever the ( held", 'CODE',
    ['if (f(x)) /[// note a]/.test(s);\n', 'if (f(x)) /[// note b]/.test(s);\n'],
    ['g(f(x)) /[// note a]/.test(s);\n', 'g(f(x)) /[// note b]/.test(s);\n']],
  ['a / after the label of a break or continue is in doubt', 'UNKNOWN',
    ['if (!s) continue outer\n/[/]/.test(s); // note a\n', 'if (!s) continue outer\n/[/]/.test(s); // note b\n'],
    ['if (!s) continue\nouter\n/[/]/.test(s); // note a\n', 'if (!s) continue\nouter\n/[/]/.test(s); // note b\n']],
  ['a ++ after a word that may be a keyword is in doubt', 'UNKNOWN',
    ['x = yield ++/[/]/.lastIndex; // note a\n', 'x = yield ++/[/]/.lastIndex; // note b\n'],
    ['x = yielded ++/[/]/.lastIndex; // note a\n', 'x = yielded ++/[/]/.lastIndex; // note b\n']],
  // Under the v flag a `[` inside a class opens a nested one, and the flag comes after the end.
  ['a [ inside a regular expression class may nest', 'UNKNOWN',
    ['x = /[[a]/b//c]/v.test(s);\n', 'x = /[[a]/b//d]/v.test(s);\n'],
    ['x = /[[a]--[b]]/v.test(s); // note c\n', 'x = /[[a]--[b]]/v.test(s); // note d\n']],
];
// Pinned by hand, so a rule dropped from the corpus goes red here rather than shrinking every loop.
const RULE_COUNTS = { CODE: 37, UNKNOWN: 13 };
// Edits a polish makes, and code the reader must not mistake for doubt: each must read PROSE-ONLY.
const PROSE = [
  ['a line comment reworded', '// Adds two numbers.\nexport const add = (a, b) => a + b;\n', '// Adds two numbers together.\nexport const add = (a, b) => a + b;\n'],
  ['a block comment rewrapped onto more lines', '/* Adds two numbers. */\nexport const add = (a, b) => a + b;\n',
    '/*\n * Adds two numbers,\n * the left one first.\n */\nexport const add = (a, b) => a + b;\n'],
  ['a comment line dropped', '// Adds both.\n// Two numbers.\nexport const add = (a, b) => a + b;\n', '// Adds two numbers.\nexport const add = (a, b) => a + b;\n'],
  ['a trailing comment added to a code line', 'export const limit = 10;\n', 'export const limit = 10; // at most ten\n'],
  ['an inline block comment reworded', 'retry(/* retry times */ 3);\n', 'retry(/* retry attempts */ 3);\n'],
  ['a comment inside a template substitution', 'const t = `a ${ `b ${c /* an x */}` } d`;\n', 'const t = `a ${ `b ${c /* the x */}` } d`;\n'],
  ['a / after a postfix ++ divides', 'count++ / 2; // note a\n', 'count++ / 2; // note b\n'],
  ['a keyword after a dot is a property name', 'export const half = options.return / 2; // note a\n', 'export const half = options.return / 2; // note b\n'],
  ['a / after } with no second / on its line divides', 'x = {} / 2;\n// note a\n', 'x = {} / 2;\n// note b\n'],
  ['a regular expression holding a slash, quotes and a backtick in a class', 'const q = /[/\'"`]/; // note a\n', 'const q = /[/\'"`]/; // note b\n'],
  ['a / after ] divides', 'const half = sizes[0] / 2; // note a\n', 'const half = sizes[0] / 2; // note b\n'],
  ['a / after a number ending in a dot divides', 'const r = 1. / 3; // note a\n', 'const r = 1. / 3; // note b\n'],
  ['a / after a string divides', "const n = '10' / 2; // note a\n", "const n = '10' / 2; // note b\n"],
  ['a hashbang holding a quote', "#!/usr/bin/env -S node --title=it's\n// note a\nrun();\n", "#!/usr/bin/env -S node --title=it's\n// note b\nrun();\n"],
  ['a line continuation inside a string', "const s = 'one \\\ntwo'; // note a\n", "const s = 'one \\\ntwo'; // note b\n"],
  ['a shift is not JSX', 'const v = (a << 2) | (b <= c); // note a\n', 'const v = (a << 2) | (b <= c); // note b\n'],
  ['a comment beside a hashbang', '#!/usr/bin/env node\n// note a\nrun();\n', '#!/usr/bin/env node\n// note b\nrun();\n'],
  ['JSDoc-tagged comments untouched, prose beside them reworded', '/** @returns {number} */\n// note a\nconst f = () => 1;\n', '/** @returns {number} */\n// note b\nconst f = () => 1;\n'],
];
// BL-046: edits that read PROSE-ONLY before a comment had to be shaped like a sentence, each an old
// twin or prose pin above in its old form. Their comments are not prose-shaped, so each now reads
// CODE; they moved here rather than being deleted, and their prose-shaped rewrites stand above.
const FLIPPED = [
  ['a one-word comment reworded (the old one-token twins)', 'export const a = 1; // a\n', 'export const a = 1; // b\n'],
  ['a comment opening with a URL', "export const HOME = ''; // https://example.com/docs\n", "export const HOME = ''; // https://example.com/help\n"],
  ['a comment opening with a word and a colon', 'export default run;\n// map: run.js.map\n', 'export default run;\n// map: run.mjs.map\n'],
  ['a comment opening with an index', '// items[0] is the head\nreturn html;\n', '// items[1] is the next\nreturn html;\n'],
  ['a bare NOTE given a colon', '// NOTE\nreturn html;\n', '// NOTE: keep\nreturn html;\n'],
  ['a comment opening with a path', '// usr/bin/env node\nrun();\n', '// usr/bin/env -S node\nrun();\n'],
  ['a comment after a divide, opening with a bracket', 'x = count++ /[//]a/.lastIndex;\n', 'x = count++ /[//]b/.lastIndex;\n'],
  ['a comment after a < that compares, opening with a letter joined to markup', 'x = as <b>//x</b>;\n', 'x = as <b>//y</b>;\n'],
  ['a one-word inline block comment reworded', 'retry(/* times */ 3);\n', 'retry(/* attempts */ 3);\n'],
  ['a one-word comment line dropped', '// Adds.\n// Two numbers.\nexport const add = (a, b) => a + b;\n', '// Adds two numbers.\nexport const add = (a, b) => a + b;\n'],
  ['trailing whitespace after a one-word block comment', 'f(1); /* a */  \n', 'f(1); /* a */ \n'],
  ['a comment opening with a bracketed index edited (the old CLI near-miss)', '// values[key] are cached.\nreturn html;\n', '// values[key] are stale.\nreturn html;\n'],
];
// Every line end the reader knows: LF, CRLF, and the Unicode line separator.
const crlf = text => text.replace(/\n/g, '\r\n');
const ls = text => text.replace(/\n/g, LS);
const LINE_ENDS = [text => text, crlf, ls];

test('the corpus is the one written above: its size and its rules, pinned', () => {
  const names = RULES.map(r => r[0]);
  assert.equal(new Set(names).size, RULES.length, 'every rule once');
  assert.equal(RULES.length, RULE_COUNTS.CODE + RULE_COUNTS.UNKNOWN);
  for (const [verdict, count] of Object.entries(RULE_COUNTS)) assert.equal(RULES.filter(r => r[1] === verdict).length, count, verdict + ' rules');
  assert.equal(PROSE.length, 18, 'the prose-only corpus');
  assert.equal(FLIPPED.length, 12, 'the old prose pins moved to the code side');
  // A twin that equals its case would prove nothing: each pair differs, and so does each twin.
  for (const [rule, , [a, b], [c, d]] of RULES) assert.ok(a !== b && c !== d && (a !== c || b !== d), rule);
});

test('every rule catches its case, and its twin, lacking only the trigger, reads PROSE-ONLY, under every line end', async () => {
  const { compareSources } = await api;
  assert.equal(LINE_ENDS.length, 3);
  for (const [rule, verdict, [before, after], [twinBefore, twinAfter]] of RULES) {
    for (const eol of LINE_ENDS) {
      assert.equal(compareSources(eol(before), eol(after)).verdict, verdict, rule);
      assert.equal(compareSources(eol(twinBefore), eol(twinAfter)).verdict, 'PROSE-ONLY', rule + ' (twin)');
    }
  }
  for (const [name, before, after] of PROSE) {
    for (const eol of LINE_ENDS) assert.deepEqual(compareSources(eol(before), eol(after)), { verdict: 'PROSE-ONLY' }, name);
  }
  for (const [name, before, after] of FLIPPED) {
    for (const eol of LINE_ENDS) assert.deepEqual(compareSources(eol(before), eol(after)), { verdict: 'CODE' }, name);
  }
});

// Every way the reader refuses, read from the tool's own source, so a new refusal needs a fixture.
// A string or a regular expression that closes on a later line is refused at its line break:
// one that never closes would be refused at the end of the file whatever the line break did.
const REFUSALS = [
  ['an unterminated block comment', 'x = 1; /* open\n', 'x = 1; /* shut */\n'],
  ['an unterminated string', "const s = 'open;\nshut';\n", "const s = 'open shut';\n"],
  ['a / that may open a regular expression or divide', 'if (a) { b(); }\n/[/]/.test(c);\n', 'if (a) { b(); }\n;/[/]/.test(c);\n'],
  ['an unterminated regular expression', 'const r = /open\nshut/;\n', 'const r = /open shut/;\n'],
  ['a [ inside a regular expression class (a nested class under the v flag?)', 'const r = /[[a]/]/v;\n', 'const r = /[[a]]/v;\n'],
  ['an HTML-like comment <!--', 'x <!-- y\n', 'x < !-- y\n'],
  ['a < where an expression may start (JSX?)', 'return <div/>;\n', 'return a <div;\n'],
  ['an HTML-like comment -->', '--> y\n', 'x --> y\n'],
  ['an unmatched }', 'f(); }\n', 'f(); {}\n'],
  ['an unmatched )', 'f());\n', 'f(());\n'],
  ['an unterminated template literal', 'const t = `open;\n', 'const t = `shut`;\n'],
  ['an unclosed (, { or ${', 'f({ a: 1 );\n', 'f({ a: 1 });\n'],
];
test('each refusal of the reader has a fixture, and a twin one edit away that it reads', async () => {
  const { scan } = await api;
  const declared = [...fs.readFileSync(TOOL, 'utf8').matchAll(/\bfail\('([^']+)'\)/g)].map(m => m[1]).sort();
  assert.ok(declared.length >= 12, 'the refusals were really read: ' + declared.join(' | '));
  assert.deepEqual(REFUSALS.map(r => r[0]).sort(), declared, 'every refusal the tool declares has a fixture here, and no other');
  for (const [reason, refused, read] of REFUSALS) {
    assert.deepEqual(scan(refused), { ok: false, reason }, reason);
    assert.equal(scan(read).ok, true, reason + ' (twin)');
  }
});

// Every reserved word and contextual keyword, written here from the ECMAScript specification (the
// ReservedWord production, the words reserved only in strict mode, and the contextual keywords of
// the Identifier Names section), never read off the tool. Each is placed once by what a `/` right
// after it means — a regular expression opens (start), it divides (end), or either may (doubt: a
// keyword or a name by mode or position, or a word no valid program puts before a `/`) — and the
// tool's sets must partition the list exactly, so a word the tool leaves unplaced, or places twice,
// goes red. `/[// note a]/` is a pattern only where an expression starts: after a name it divides, and
// `//]a/` is a comment.
const SPEC = {
  reserved: ['await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do', 'else', 'enum', 'export', 'extends', 'false',
    'finally', 'for', 'function', 'if', 'import', 'in', 'instanceof', 'new', 'null', 'return', 'super', 'switch', 'this', 'throw', 'true', 'try', 'typeof', 'var',
    'void', 'while', 'with', 'yield'],
  strictMode: ['implements', 'interface', 'let', 'package', 'private', 'protected', 'public', 'static'],
  contextual: ['as', 'async', 'from', 'get', 'meta', 'of', 'set', 'target'],
};
const PLACED = {
  start: ['break', 'case', 'continue', 'debugger', 'default', 'delete', 'do', 'else', 'extends', 'in', 'instanceof', 'new', 'return', 'throw', 'typeof', 'void'],
  end: ['as', 'async', 'false', 'from', 'get', 'meta', 'null', 'set', 'target', 'this', 'true'],
  doubt: ['await', 'catch', 'class', 'const', 'enum', 'export', 'finally', 'for', 'function', 'if', 'implements', 'import', 'interface', 'let', 'of', 'package',
    'private', 'protected', 'public', 'static', 'super', 'switch', 'try', 'var', 'while', 'with', 'yield'],
  control: ['for', 'if', 'while', 'with'],
};
test('every reserved word and contextual keyword is placed once: after it a / opens a regular expression, divides, or is in doubt', async () => {
  const { compareSources, KEYWORDS, CONTROL } = await api;
  const words = [...SPEC.reserved, ...SPEC.strictMode, ...SPEC.contextual];
  assert.deepEqual([SPEC.reserved.length, SPEC.strictMode.length, SPEC.contextual.length, new Set(words).size], [38, 8, 8, 54], 'the specification list, pinned by size');
  assert.deepEqual([[...KEYWORDS.start].sort(), [...KEYWORDS.end].sort(), [...KEYWORDS.doubt].sort(), [...CONTROL].sort()], [PLACED.start, PLACED.end, PLACED.doubt, PLACED.control]);
  assert.deepEqual([PLACED.start.length, PLACED.end.length, PLACED.doubt.length], [16, 11, 27], 'the placements written here, pinned by size');
  const placed = [...PLACED.start, ...PLACED.end, ...PLACED.doubt];
  assert.equal(new Set(placed).size, placed.length, 'no word placed twice');
  assert.deepEqual(placed.sort(), words.sort(), 'the three sets partition the specification list exactly');
  assert.ok(PLACED.control.every(w => PLACED.doubt.includes(w)), 'a control keyword decides at its ), never right after itself');
  const pair = lead => [lead + ' /[// note a]/.test(s);\n', lead + ' /[// note b]/.test(s);\n'];
  for (const word of PLACED.start) assert.equal(compareSources(...pair('x = ' + word)).verdict, 'CODE', word);
  for (const word of PLACED.doubt) assert.equal(compareSources(...pair('x = ' + word)).verdict, 'UNKNOWN', word);
  for (const word of PLACED.end) assert.equal(compareSources(...pair('x = ' + word)).verdict, 'PROSE-ONLY', word);
  for (const word of PLACED.control) assert.equal(compareSources(...pair(word + ' (ok)')).verdict, 'CODE', word);
  // A `<` right after: an operator after an end word (its `//` a comment), possible JSX after any other.
  const jsx = lead => [lead + ' <b>// note x</b>;\n', lead + ' <b>// note y</b>;\n'];
  for (const word of PLACED.end) assert.equal(compareSources(...jsx('x = ' + word)).verdict, 'PROSE-ONLY', word + ' <');
  for (const word of [...PLACED.start, ...PLACED.doubt]) assert.equal(compareSources(...jsx('x = ' + word)).verdict, 'UNKNOWN', word + ' <');
  // The other side of each boundary: a plain name, a property named like a keyword, a call's `)`.
  for (const lead of ['x = value', 'x = options.return', 'x = run(ok)', 'x = run(ok)?.typeof', 'x = this.#return', 'x = this?.#in']) {
    assert.equal(compareSources(...pair(lead)).verdict, 'PROSE-ONLY', lead);
  }
});

// ---- The comment families -------------------------------------------------------------------
// Comments as they are written in real code, not read off the patterns: each directive the tool
// lists owns one no other directive catches, each shape owns one no other shape catches, each
// family owns one the other three miss, and prose that only looks like a directive or a tag is
// left prose — a near-miss on the far side of each boundary.
const DIRECTIVE_COMMENTS = [
  '// eslint-disable-next-line no-console -- the CLI prints its result', '/* eslint quotes: ["error", "double"] */', '/* eslint-env node */',
  '/* istanbul ignore next: a platform guard */', '/* istanbul ignore if */', '/* istanbul ignore else */', '/* istanbul ignore file */',
  '/* c8 ignore next 3 */', '/* c8 ignore start */', '/* c8 ignore stop */', '// @ts-expect-error: the legacy caller passes a string', '// @ts-nocheck',
  '// prettier-ignore', '/* v8 ignore next */', '/* jshint esversion: 11 */', '/*jslint node:true, es6 */',
  '// biome-ignore lint/suspicious/noExplicitAny: legacy data', '// deno-lint-ignore no-explicit-any', '// deno-lint-ignore-file', '// oxlint-disable-next-line no-unused-vars',
  '/* webpackChunkName: "editor" */', '/* turbopackIgnore: true */', '/* node:coverage ignore next */', '/* node:coverage disable */',
  '// tslint:disable-next-line:no-any', '// $FlowFixMe[incompatible-call] legacy props', '// LCOV_EXCL_LINE', '// deepcode ignore HardcodedSecret: a test fixture', '// skipcq: JS-0002', '// skipcq',
  '// Stryker disable next-line all', '// Stryker disable all', '// Stryker restore all', '// Stryker restore EqualityOperator',
  '// nosemgrep: javascript.lang.security.audit.path-traversal', '// nosemgrep', '// lgtm[js/xss]', '// lgtm', '// codeql[js/unused-local-variable]',
  '// cSpell:words xyzzy plugh', '// spell-checker: disable', '// noinspection JSUnusedGlobalSymbols', '// keep-sorted start', '// clang-format off', '// spotless:off',
  '// falls through to the default branch', '// fallthrough',
];
// Kept by their shape alone: the tool each names is on no list.
const SHAPE_COMMENTS = ['/* stylelint-disable-next-line selector-max-id */', '/* stylelint-enable */', '// jscs:disable requireCamelCaseOrUpperCaseIdentifiers',
  '// sort-imports-ignore', '// deepscan-disable-line', '// svelte-ignore a11y-missing-attribute', '/* vite-ignore */', '// cppcheck-suppress unusedFunction',
  '/* jscpd:ignore-start */', '/* jscpd:ignore-end */', '/* bun:coverage ignore next */', '/* bun:coverage ignore start */', '/* bun:coverage ignore stop */',
  '// NOSONAR: the pattern is vetted', '// NOLINT(readability-identifier-naming)', '// NOQA', '// NOCOMMIT',
  '// gitleaks:allow', '// pragma: allowlist secret', '// checkov:skip=CKV_AWS_18: the audit bucket keeps these logs', '// coverity[tainted_data]'];
const MARKER_COMMENTS = ['//# sourceMappingURL=run.js.map', '/*! Licensed MIT; see LICENSE */', '/// <reference types="node" />', '/* global fetch, Response */',
  '/* exported main */', '/* globals describe, it */', '//@ sourceURL=eval-1.js'];
const TAG_COMMENTS = ['/** @returns {number} the sum */', '/** Parses a flag list; see {@link parseFlags}. */', '/**\n * Old entry point.\n * @deprecated since 2.0\n */'];
// Kept by several families at once, each pinned to exactly the families that keep it.
const SHARED_COMMENTS = [
  ['// @ts-expect-error: the legacy caller passes a string', ['directive', 'shape', 'marker', 'tag']],
  ['// @ts-nocheck', ['directive', 'shape', 'marker', 'tag']],
  ["// @glint-expect-error: the component's args are loose", ['shape', 'marker', 'tag']],
  ['// @vite-ignore', ['shape', 'marker', 'tag']],
  ['// Stryker disable next-line all', ['directive', 'shape']],
  ['/* istanbul ignore else */', ['directive', 'shape']],
  ['// lgtm[js/xss]', ['directive', 'shape']],
  ['// $FlowFixMe[incompatible-call] legacy props', ['directive', 'shape']],
];
const PROSE_COMMENTS = ['// Adds two numbers.', '// Mail the maintainers at team@example.com.', '// polish discarded: @<sha> marks the reviewed tree.',
  '/* Falls back to the default when unset. */', '/** Adds two numbers. */', '// the abc8 codec', '// the v8-compat shim', '// istanbul-lib-coverage reads this',
  '// A path like a/b/c.', '// a c80 checksum', '// Blank lines are ignored.', '// A self-disabled switch.', '// Callers ignore next-gen flags.',
  '// Tests ignore all-caps names.', '// Tests suppress nothing here.', '// keep sorted by name', '// no inspection needed here', '// semgrep rules live in .semgrep/',
  '// the cspell dictionary is cspell.json', '// codeql-cli output goes to out/', '// spotless output', '// clang formats this file',
  '// items[0] is the head.', '// values[key] are cached.', '// NOTE: keep this order.', '// NOT thread-safe.', '// NONE of the flags apply.', '// NORMAL exit.',
  '// allow one retry', '// skip the cache'];
// BL-046: the prose comments above the four families leave alone that are not prose-shaped, each
// kept as code now by its shape alone: a colon on its second word, a first word that is joined,
// bracketed or followed by a colon.
const UNSHAPED_PROSE = ['// polish discarded: @<sha> marks the reviewed tree.', '// istanbul-lib-coverage reads this', '// codeql-cli output goes to out/',
  '// items[0] is the head.', '// values[key] are cached.', '// NOTE: keep this order.'];
// Held out from every family: comments written as directives of tools no list or shape names. Each
// is kept by the prose-shape rule alone. If a family edit comes to name one, swap it for one no
// family names, so the control below still exercises the rule by itself.
const HELD_OUT = ['// ggignore', '// sourcery skip: no-loop-in-tests', '// coverity[overrun]', '// TODO: remove this', '//go:build linux', '// $ExpectError',
  '// lint:off', '// checker=off', '// cov[skip]', '// fmt:off', '// size-limit ok', '// eol=lf', '// flake8: noqa', '// mypy:strict',
  // A letter no family's `@` reads, so the prose-shape rule's `@` alone keeps it.
  '// see @' + String.fromCharCode(0xfc) + 'ber below', '// see $_internal below'];
// Prose on the near side of each prose-shape condition: the hyphen, underscore and bracket later
// in a sentence, an email, a bare `@`, a URL past the second word, a leading `e.g.` or backticked
// name, the near-misses of the verbs, and a comment holding no word at all.
const SHAPED = ['// the read-only view is cached', '// reads items[0] first', '// sets max_len on start', '// Mail team@example.com for access.',
  '// the polish at @<sha> was discarded', '// docs live at https://example.com/docs', '// e.g. the first flag wins', '// `table` holds the rows',
  "// 'quoted' first words pass", "// it's cached here", '// (optional) second pass', '// [draft] notes follow', '// costs $5 more', '// set eol = lf here', '// one rule, keep it',
  '// allow one retry', '// skip the cache', '/**\n * Adds two numbers,\n * the left one first.\n */', '/*** Adds two numbers. ***/', '//'];
// The declared residual (BL-046): a directive written only in plain words that no family names is
// prose-shaped, so it still reads PROSE-ONLY. Closing the gap moves a member to HELD_OUT.
const KNOWN_GAP = ['// nosec B101', '// pragma once', '// sourcery skip', '// ggignore this line'];
// The shapes' verbs and scopes, written here from the directives above, never read off the tool.
const SHAPE_GRAMMAR = {
  verbs: ['disable', 'enable', 'ignore', 'restore', 'suppress', 'expect-error', 'nocheck', 'allow', 'allowlist', 'skip'],
  scopes: ['next-line', 'next', 'line', 'file', 'all', 'start', 'stop', 'end', 'if', 'else'],
};
const POOL = () => [...DIRECTIVE_COMMENTS, ...SHAPE_COMMENTS, ...MARKER_COMMENTS, ...TAG_COMMENTS, ...SHARED_COMMENTS.map(s => s[0])];
test('each directive, and each comment family, owns a real comment; prose that only looks like one is prose', async () => {
  const { DIRECTIVES, SHAPES, keptBy } = await api;
  assert.deepEqual([DIRECTIVES.length, SHAPES.length], [29, 4], 'the directive and shape lists are pinned by size');
  assert.deepEqual([DIRECTIVE_COMMENTS.length, SHAPE_COMMENTS.length, MARKER_COMMENTS.length, TAG_COMMENTS.length, SHARED_COMMENTS.length, PROSE_COMMENTS.length],
    [47, 21, 7, 3, 8, 30]);
  // The five the feature names are in the list, by name.
  for (const named of ['eslint', 'istanbul', 'c8', '@ts-', 'prettier']) assert.ok(DIRECTIVES.some(([name]) => name === named), named);
  for (const [name] of DIRECTIVES) {
    const owned = DIRECTIVE_COMMENTS.filter(c => DIRECTIVES.filter(([, p]) => p.test(c)).map(([n]) => n).join() === name);
    assert.ok(owned.length >= 1, name + ' owns no comment of the corpus');
  }
  for (const comment of DIRECTIVE_COMMENTS) assert.ok(keptBy(comment).includes('directive'), comment);
  // Each shape owns a pool comment no other shape catches (a name may catch it too).
  for (const [name] of SHAPES) {
    const owned = POOL().filter(c => SHAPES.filter(([, p]) => p.test(c)).map(([n]) => n).join() === name);
    assert.ok(owned.length >= 1, name + ' owns no comment of the corpus');
  }
  // Family by family: a comment that family alone keeps.
  const alone = (list, family) => list.filter(c => keptBy(c).join() === family);
  assert.ok(alone(DIRECTIVE_COMMENTS, 'directive').length >= 1 && alone(SHAPE_COMMENTS, 'shape').length === SHAPE_COMMENTS.length
    && alone(MARKER_COMMENTS, 'marker').length === MARKER_COMMENTS.length && alone(TAG_COMMENTS, 'tag').length === TAG_COMMENTS.length, 'each family owns its comments');
  for (const [comment, families] of SHARED_COMMENTS) assert.deepEqual(keptBy(comment), families, comment);
  for (const comment of PROSE_COMMENTS) assert.deepEqual(keptBy(comment), [], comment);
});

// BL-046: the prose-shape rule, pinned from both sides. The code side is comments no family keeps,
// so the rule alone is what keeps them; the prose side is sentences each condition must let pass.
test('a comment no family keeps is code unless it is shaped like a sentence; each condition is pinned on both sides', async () => {
  const { compareSources, keptBy, proseShaped } = await api;
  assert.deepEqual([UNSHAPED_PROSE.length, HELD_OUT.length, SHAPED.length, KNOWN_GAP.length], [6, 16, 20, 4]);
  assert.ok(UNSHAPED_PROSE.every(c => PROSE_COMMENTS.includes(c)), 'the unshaped prose pins are old prose pins, moved');
  for (const comment of PROSE_COMMENTS) assert.equal(proseShaped(comment), !UNSHAPED_PROSE.includes(comment), comment);
  // No family keeps any comment here, so each verdict turns on the prose-shape rule alone.
  for (const comment of [...HELD_OUT, ...UNSHAPED_PROSE, ...SHAPED, ...KNOWN_GAP]) {
    const code = HELD_OUT.includes(comment) || UNSHAPED_PROSE.includes(comment);
    assert.deepEqual(keptBy(comment), [], 'no family keeps ' + comment);
    assert.equal(proseShaped(comment), !code, comment);
    // A comment appended to a code line, and one reworded in place: code for the held-out, prose for the rest.
    for (const eol of LINE_ENDS) {
      assert.equal(compareSources(eol('run();\n'), eol('run(); ' + comment + '\n')).verdict, code ? 'CODE' : 'PROSE-ONLY', comment + ' appended');
      assert.equal(compareSources(eol(comment + '\nrun();\n'), eol('run();\n')).verdict, code ? 'CODE' : 'PROSE-ONLY', comment + ' removed');
    }
  }
  // Either side's doubt keeps it: a directive reworded into prose, and prose reworded into one.
  assert.equal(compareSources('// ggignore\nrun();\n', '// ggignore now\nrun();\n').verdict, 'CODE');
  assert.equal(compareSources('// ggignore now\nrun();\n', '// ggignore\nrun();\n').verdict, 'CODE');
  assert.equal(compareSources('// ggignore now\nrun();\n', '// ggignore later\nrun();\n').verdict, 'PROSE-ONLY', 'the control');
  // Each condition's tight pair, code first: one word or two; a first word joined or plain; a
  // colon on the second word or on the third; a join or its spaced twin; a sigil and a letter or a digit.
  for (const [code, prose] of [['// ggignore', '// ggignore now'], ['// size-limit ok', '// the size-limit ok'], ['// e.g.. the', '// e.g. the'],
    ['// "word again', '// "word" again'], ['// sourcery skip: x', '// sourcery skips x: y'], ['// set eol=lf', '// set eol= lf'],
    ['// a url is http://host:80', '// a url is http://host'], ['// see $ExpectError', '// see $5'], ['// see $_x', '// see $5'], ['/* ggignore */', '/* ggignore now */'],
    ['/**\n * ggignore\n */', '/**\n * ggignore now\n */']]) {
    assert.deepEqual([keptBy(code), keptBy(prose)], [[], []], code);
    assert.deepEqual([proseShaped(code), proseShaped(prose)], [false, true], code + ' / ' + prose);
  }
});

// The alternatives of a pattern's `(?:a|b|c)` groups, read off its own source.
const alternatives = pattern => [...pattern.source.matchAll(/\(\?:([^()]*)\)/g)].flatMap(m => m[1].split('|'));
test('each verb and scope a shape accepts is the one written here, read off the shape itself, and ends a match on a real comment', async () => {
  const { SHAPES, VERBS, SCOPES } = await api;
  assert.deepEqual([VERBS, SCOPES], [SHAPE_GRAMMAR.verbs, SHAPE_GRAMMAR.scopes]);
  assert.deepEqual([SHAPE_GRAMMAR.verbs.length, SHAPE_GRAMMAR.scopes.length], [10, 10], 'the lists written here, pinned by size');
  const [[, joined], [, spaced], [, bracketed], [, shouted]] = SHAPES;
  // Both list-built shapes carry every verb and scope as an alternative of their own source, and nothing else.
  const expected = [...SHAPE_GRAMMAR.verbs, ...SHAPE_GRAMMAR.scopes].sort();
  for (const pattern of [joined, spaced]) assert.deepEqual(alternatives(pattern).sort(), expected, pattern.source);
  // What each shape matched, on every pool comment it matches, parsed back into its verb and scope.
  const tail = new RegExp('[:-]\\s?(' + VERBS.join('|') + ')(?:[:-](' + SCOPES.join('|') + '))?$', 'i');
  const apart = new RegExp('\\s(' + VERBS.join('|') + ')\\s+(' + SCOPES.join('|') + ')$', 'i');
  const witnesses = POOL().flatMap(c => [[joined, tail], [spaced, apart]].map(([pattern, parse]) => {
    const m = pattern.exec(c);
    return m && parse.exec(m[0]);
  }).filter(Boolean).map(m => ({ verb: m[1].toLowerCase(), scope: m[2]?.toLowerCase() })));
  assert.ok(witnesses.length >= 20, 'the shapes really match the pool');
  for (const word of alternatives(joined)) {
    const witness = SHAPE_GRAMMAR.verbs.includes(word) ? witnesses.some(w => w.verb === word) : witnesses.some(w => w.scope === word);
    assert.ok(witness, 'no real comment matches a shape through ' + word);
  }
  // The other side: a word past the lists is not a verb or scope, an index is not a rule id, a
  // shouted English word is not a marker.
  assert.equal(joined.test('// cspell:words xyzzy'), false);
  assert.equal(spaced.test('// Stryker disable EqualityOperator'), false);
  assert.equal(bracketed.test('// items[0] is the head.'), false);
  assert.equal(shouted.test('// NOTE: keep this order.'), false);
});

// ---- The CLI as protocol.md publishes it, on real commits ------------------------------------
function publishedCommand() {
  const spans = [...read('orchestrate/references/protocol.md').matchAll(/`(node "<skill-dir>\/tools\/prose-only-diff\.mjs"[^`]*)`/g)].map(m => m[1]);
  assert.equal(spans.length, 1, 'protocol.md publishes the classifier command once');
  return spans[0];
}
function cli(repo, base, head) {
  const values = { '<skill-dir>': path.join(ROOT, 'orchestrate').split(path.sep).join('/'), '<batch worktree>': repo.cwd, '<pre-polish sha>': base, '<polish tip>': head };
  const command = Object.entries(values).reduce((text, [token, value]) => text.split(token).join(value), publishedCommand());
  assert.doesNotMatch(command, /<[a-z -]+>/, 'every placeholder is filled: ' + command);
  const argv = [...command.matchAll(/"([^"]*)"|(\S+)/g)].map(m => m[1] ?? m[2]);
  assert.equal(argv[0], 'node');
  const env = { ...repo.env }; delete env.NODE_TEST_CONTEXT;
  const r = spawnSync(process.execPath, argv.slice(1), { cwd: repo.cwd, env, encoding: 'utf8', windowsHide: true, timeout: 60000 });
  assert.ifError(r.error); assert.equal(r.signal, null);
  assert.equal(r.stderr, '', 'nothing on stderr');
  const lines = r.stdout.split('\n');
  assert.deepEqual(lines.slice(1), [''], 'ONE line: ' + JSON.stringify(r.stdout));
  return { status: r.status, line: lines[0] };
}
const EXIT = { 'PROSE-ONLY': 0, CODE: 1, UNKNOWN: 2 };

test('every corpus pair reads the same through the published CLI on commits, each pair its own diff', t => {
  const repo = makeRepo(t);
  // One file per pair, all at "before" in one commit; then each pair's "after" in a commit of its
  // own, so the diff between two neighbouring commits is that pair and nothing else.
  const pairs = [...RULES.flatMap(([rule, verdict, edit, twin], i) => [[rule, verdict, edit, `r${i}-case.mjs`], [rule + ' (twin)', 'PROSE-ONLY', twin, `r${i}-twin.mjs`]]),
    ...PROSE.map(([name, before, after], i) => [name, 'PROSE-ONLY', [before, after], `p${i}.mjs`]),
    ...FLIPPED.map(([name, before, after], i) => [name, 'CODE', [before, after], `f${i}.mjs`])];
  for (const [, , [before], file] of pairs) repo.write(file, before);
  let previous = repo.commit('before');
  for (const [name, verdict, [, after], file] of pairs) {
    repo.write(file, after);
    const next = repo.commit(name);
    const r = cli(repo, previous, next);
    const expected = verdict === 'PROSE-ONLY' ? 'PROSE-ONLY 1 file(s)' : verdict === 'CODE' ? 'CODE ' + file : 'UNKNOWN ' + file + ': ';
    assert.ok(verdict === 'UNKNOWN' ? r.line.startsWith(expected) : r.line === expected, name + ': ' + r.line);
    assert.equal(r.status, EXIT[verdict], name);
    previous = next;
  }
});

test('the CLI is read-only: nothing in the repository changes across runs', t => {
  const repo = makeRepo(t);
  repo.write('a.mjs', '// note a\nexport const a = 1;\n'); const c0 = repo.commit('c0');
  repo.write('a.mjs', '// note b\nexport const a = 1;\n'); const c1 = repo.commit('c1');
  const before = repo.snapshot();
  assert.deepEqual(cli(repo, c0, c1), { status: 0, line: 'PROSE-ONLY 1 file(s)' });
  assert.deepEqual(cli(repo, c1, c0), { status: 0, line: 'PROSE-ONLY 1 file(s)' });
  assert.deepEqual(repo.snapshot(), before);
});

// The smoke the checkpoint runs, as I-01 builds it: c0, a comment-only change of both forms, then
// a one-character code change in the same file. The second step is the live control.
test('a comment-only commit of both forms reads PROSE-ONLY and a one-character code change after it reads CODE', t => {
  const repo = makeRepo(t);
  repo.write('lib/sum.mjs', '// Adds two numbers.\n/* The left one first. */\nexport const sum = (a, b) => a + b;\n'); const c0 = repo.commit('c0');
  repo.write('lib/sum.mjs', '// Adds two numbers together.\n/*\n * The left one\n * first.\n */\nexport const sum = (a, b) => a + b;\n'); const c1 = repo.commit('c1');
  repo.write('lib/sum.mjs', '// Adds two numbers together.\n/*\n * The left one\n * first.\n */\nexport const sum = (a, b) => a - b;\n'); const c2 = repo.commit('c2');
  assert.deepEqual(cli(repo, c0, c1), { status: 0, line: 'PROSE-ONLY 1 file(s)' });
  assert.deepEqual(cli(repo, c1, c2), { status: 1, line: 'CODE lib/sum.mjs' });
  assert.deepEqual(cli(repo, c0, c2), { status: 1, line: 'CODE lib/sum.mjs' });
});

// BL-046, its first scenario as C1's I-04 builds it: a directive appended to a code line, or its
// rule id edited, reads CODE through the published CLI on real commits; the same edit made in
// prose on the far side of each boundary reads PROSE-ONLY.
test('an allow, allowlist, skip, skipcq or underscored rule-id directive appended or edited reads CODE through the published CLI; its prose near-miss reads PROSE-ONLY', t => {
  const repo = makeRepo(t);
  const LF = String.fromCharCode(10), text = (...lines) => lines.map(line => line + LF).join('');
  const header = '// The name of the header the client sends its token in.', code = "export const TOKEN_HEADER = 'x-client-token';";
  for (const [name, before, after, verdict] of [
    ['gitleaks:allow appended (I-04)', text(header, code), text(header, code + ' // gitleaks:allow'), 'CODE'],
    ['pragma: allowlist secret appended', text(header, code), text(header, code + ' // pragma: allowlist secret'), 'CODE'],
    ['checkov:skip appended', text(header, code), text(header, code + ' // checkov:skip=CKV_AWS_18: the audit bucket keeps these logs'), 'CODE'],
    ['a skipcq rule id edited', text(header, code + ' // skipcq: JS-0002'), text(header, code + ' // skipcq: JS-0003'), 'CODE'],
    ['a bare skipcq appended', text(header, code), text(header, code + ' // skipcq'), 'CODE'],
    ['a coverity event edited', text('// coverity[tainted_data]', code), text('// coverity[tainted_data_return]', code), 'CODE'],
    ['allow in prose appended', text(header, code), text(header, code + ' // allow one retry'), 'PROSE-ONLY'],
    ['skip in prose appended', text(header, code), text(header, code + ' // skip the cache'), 'PROSE-ONLY'],
    // BL-046: an index opening the comment makes it doubt, so the old near-miss reads CODE; the
    // same index later in the sentence stays prose.
    ['a bracketed index opening a comment edited', text('// values[key] are cached.', code), text('// values[key] are stale.', code), 'CODE'],
    ['a bracketed index in prose edited', text('// the values[key] are cached.', code), text('// the values[key] are stale.', code), 'PROSE-ONLY'],
  ]) {
    repo.write('lib/token.mjs', before); const c0 = repo.commit(name + ': before');
    repo.write('lib/token.mjs', after); const c1 = repo.commit(name + ': after');
    assert.deepEqual(cli(repo, c0, c1), verdict === 'CODE' ? { status: 1, line: 'CODE lib/token.mjs' } : { status: 0, line: 'PROSE-ONLY 1 file(s)' }, name);
  }
});

// BL-046, the three comments its entry names, as C1's I-04 builds them: each appended to a code
// line reads CODE in-process and through the published CLI on real commits, though no family keeps
// it; the same line given a prose comment instead reads PROSE-ONLY.
for (const comment of ['// ggignore', '// sourcery skip: no-loop-in-tests', '// coverity[overrun]']) {
  test(`BL-046: ${comment} appended to a code line reads CODE in-process and through the published CLI`, async t => {
    const { compareSources, keptBy } = await api;
    const LF = String.fromCharCode(10), text = (...lines) => lines.map(line => line + LF).join('');
    const header = '// The name of the header the client sends its token in.', code = "export const TOKEN_HEADER = 'x-client-token';";
    assert.deepEqual(keptBy(comment), [], 'no family keeps it: the prose-shape rule alone must');
    const before = text(header, code);
    assert.equal(compareSources(before, text(header, code + ' ' + comment)).verdict, 'CODE');
    const repo = makeRepo(t);
    repo.write('lib/token.mjs', before); const c0 = repo.commit('base');
    repo.write('lib/token.mjs', text(header, code + ' ' + comment)); const c1 = repo.commit('directive');
    assert.deepEqual(cli(repo, c0, c1), { status: 1, line: 'CODE lib/token.mjs' });
    // The control: the same line given a prose comment.
    repo.write('lib/token.mjs', before); const c2 = repo.commit('base again');
    repo.write('lib/token.mjs', text(header, code + ' // the header name is fixed')); const c3 = repo.commit('plain');
    assert.deepEqual(cli(repo, c2, c3), { status: 0, line: 'PROSE-ONLY 1 file(s)' });
  });
}

// The round-2 reviewer's scenario: semicolon-less code where a regular expression opens the line
// after break, continue, a label or debugger. Each code edit reads CODE or UNKNOWN through the
// published CLI, never PROSE-ONLY; the controls are the same file with a `;` and a comment edit.
test('a regular expression on the line after break, continue, a label or debugger never reads PROSE-ONLY through the published CLI', t => {
  const repo = makeRepo(t);
  const links = end => 'export function links(lines) {\n  const out = []\n  for (const line of lines) {\n    if (!line) ' + end + '\n    /^https?:\\/\\//i.test (line) && out.push(line)\n  }\n  return out\n}\n';
  const edits = [['out.push', 'out.unshift'], [' && out.push(line)', '']];
  let previous = null;
  const step = (name, text) => { repo.write('lib/links.mjs', text); const from = previous; previous = repo.commit(name); return from && cli(repo, from, previous); };
  for (const [end, expected] of [['continue', 'CODE lib/links.mjs'], ['break', 'CODE lib/links.mjs'], ['debugger', 'CODE lib/links.mjs'],
    ['continue outer', 'UNKNOWN lib/links.mjs: a / that may open a regular expression or divide (base)']]) {
    for (const [find, replace] of edits) {
      step(end + ' base', links(end));
      const r = step(end + ' ' + find, links(end).replace(find, replace));
      assert.deepEqual(r, { status: expected.startsWith('CODE') ? 1 : 2, line: expected }, end + ': ' + find);
    }
  }
  step('control base', links('continue;'));
  assert.deepEqual(step('control code', links('continue;').replace('out.push', 'out.unshift')), { status: 1, line: 'CODE lib/links.mjs' });
  assert.deepEqual(step('control comment', links('continue;') + '// note a\n'), { status: 1, line: 'CODE lib/links.mjs' }, 'a comment line added to the tail is a code change too');
  step('control prose base', links('continue') + '// note a\n');
  assert.deepEqual(step('control prose', links('continue') + '// note b\n'), { status: 0, line: 'PROSE-ONLY 1 file(s)' });
});

// Git-level rules: what the diff is, rather than what a file says.
test('an added, deleted, renamed, re-moded, linked or submodule JavaScript path, or a BOM added, is CODE; its twin reads PROSE-ONLY', t => {
  const repo = makeRepo(t);
  const body = '// note a\nexport const a = 1;\n', edited = '// note b\nexport const a = 1;\n';
  repo.write('keep.mjs', body); repo.write('gone.cjs', body); repo.write('old.js', body); repo.write('mode.mjs', body); repo.write('link.mjs', body);
  const blob = repo.git('hash-object', '-w', 'keep.mjs');
  // Index-only entries (a submodule, then a link) have no file in the checkout, so every commit
  // below stages exactly its own paths: `git add --all` would stage their removal.
  repo.git('add', '--all');
  repo.git('update-index', '--add', '--cacheinfo', '160000,' + repo.base + ',sub.mjs');
  repo.git('commit', '-m', 'c0');
  const c0 = repo.git('rev-parse', 'HEAD');
  const step = (name, change, expected) => {
    const from = repo.git('rev-parse', 'HEAD'); change();
    repo.git('commit', '--allow-empty', '-m', name);
    assert.deepEqual(cli(repo, from, repo.git('rev-parse', 'HEAD')), expected, name);
  };
  step('twin: an edit in place', () => { repo.write('keep.mjs', edited); repo.git('add', 'keep.mjs'); }, { status: 0, line: 'PROSE-ONLY 1 file(s)' });
  step('added', () => { repo.write('new.mjs', body); repo.git('add', 'new.mjs'); }, { status: 1, line: 'CODE new.mjs' });
  step('deleted', () => { repo.git('rm', '--quiet', 'gone.cjs'); }, { status: 1, line: 'CODE gone.cjs' });
  step('renamed', () => { repo.git('mv', 'old.js', 'renamed.js'); }, { status: 1, line: 'CODE old.js' });
  step('made executable, its text reworded too', () => { repo.write('mode.mjs', edited); repo.git('add', 'mode.mjs'); repo.git('update-index', '--chmod=+x', 'mode.mjs'); },
    { status: 1, line: 'CODE mode.mjs' });
  step('a byte-order mark added', () => { repo.write('keep.mjs', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(edited)])); repo.git('add', 'keep.mjs'); },
    { status: 1, line: 'CODE keep.mjs' });
  step('turned into a link', () => { repo.git('update-index', '--cacheinfo', '120000,' + blob + ',link.mjs'); }, { status: 1, line: 'CODE link.mjs' });
  step('a submodule moved', () => { repo.git('update-index', '--cacheinfo', '160000,' + c0 + ',sub.mjs'); }, { status: 1, line: 'CODE sub.mjs' });
});

test('precedence: UNKNOWN over CODE over PROSE-ONLY, the first CODE in path order, other paths counted', t => {
  const repo = makeRepo(t);
  const files = { 'a.mjs': '// note a\nx = 1;\n', 'b.mjs': 'x = 1;\n', 'c.mjs': 'x = 1;\n', 'd.mjs': 'x = `open ${y}`;\n', 'README.md': 'one\n', 'z.py': 'x = 1\n' };
  for (const [file, text] of Object.entries(files)) repo.write(file, text);
  const c0 = repo.commit('c0');
  const at = changes => { for (const [file, text] of Object.entries(changes)) repo.write(file, text); return repo.commit(Object.keys(changes).join(' ')); };
  const prose = at({ 'a.mjs': '// note b\nx = 1;\n', 'README.md': 'two\n', 'z.py': 'x = 2\n' });
  assert.deepEqual(cli(repo, c0, prose), { status: 0, line: 'PROSE-ONLY 1 file(s); 2 other path(s) left to the path rule' });
  const code = at({ 'c.mjs': 'x = 2;\n', 'b.mjs': 'x = 2;\n', 'a.mjs': '// note c\nx = 1;\n' });
  assert.deepEqual(cli(repo, prose, code), { status: 1, line: 'CODE b.mjs' });
  const doubt = at({ 'd.mjs': 'x = `open ${y};\n', 'b.mjs': 'x = 3;\n' });
  const r = cli(repo, code, doubt);
  assert.equal(r.status, 2);
  assert.equal(r.line, 'UNKNOWN d.mjs: an unterminated template literal (head)');
  const fixed = at({ 'd.mjs': 'x = `shut ${y}`;\n' });
  assert.deepEqual(cli(repo, doubt, fixed), { status: 2, line: 'UNKNOWN d.mjs: an unterminated template literal (base)' });
  // No JavaScript file: other paths alone never make PROSE-ONLY. An empty diff is no evidence either.
  const docs = at({ 'README.md': 'three\n' });
  assert.deepEqual(cli(repo, fixed, docs), { status: 2, line: 'UNKNOWN no JavaScript file changed; 1 other path(s) left to the path rule' });
  assert.deepEqual(cli(repo, docs, docs), { status: 2, line: 'UNKNOWN no JavaScript file changed' });
});

test('text git cannot hand over as UTF-8, a blob git cannot read, and a ref or a diff git refuses are UNKNOWN', async t => {
  const { proseOnlyDiff } = await api;
  const repo = makeRepo(t);
  repo.write('latin.mjs', Buffer.from([...Buffer.from('// caf'), 0xe9, ...Buffer.from('\nx = 1;\n')])); repo.write('lost.mjs', '// note a\nx = 1;\n');
  const c0 = repo.commit('c0');
  repo.write('latin.mjs', Buffer.from([...Buffer.from('// caf'), 0xe8, ...Buffer.from('\nx = 1;\n')]));
  const c1 = repo.commit('c1');
  assert.deepEqual(cli(repo, c0, c1), { status: 2, line: 'UNKNOWN latin.mjs: text that is not UTF-8 (base)' });
  repo.write('lost.mjs', '// note b\nx = 1;\n');
  const c2 = repo.commit('c2');
  // The blob's loose object removed: the commits and trees still read, the blob does not.
  const oid = repo.git('rev-parse', c2 + ':lost.mjs');
  fs.rmSync(path.join(repo.cwd, '.git', 'objects', oid.slice(0, 2), oid.slice(2)));
  assert.deepEqual(cli(repo, c1, c2), { status: 2, line: 'UNKNOWN lost.mjs: a blob git could not read (head)' });
  assert.deepEqual(cli(repo, 'refs/heads/no-such-branch', c2), { status: 2, line: 'UNKNOWN cannot resolve --base to a commit in ' + repo.cwd });
  assert.deepEqual(cli(repo, c0, 'refs/heads/no-such-branch'), { status: 2, line: 'UNKNOWN cannot resolve --head to a commit in ' + repo.cwd });
  // A setting only the diff reads, injected the way git's own config variables inject it.
  const env = { ...repo.env, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'diff.renameLimit', GIT_CONFIG_VALUE_0: 'many' };
  assert.deepEqual(proseOnlyDiff({ repo: repo.cwd, base: c0, head: c1, env }), { code: 2, line: 'UNKNOWN git diff did not run' });
  assert.deepEqual(proseOnlyDiff({ repo: repo.cwd, base: c0, head: c1, env: repo.env }), { code: 2, line: 'UNKNOWN latin.mjs: text that is not UTF-8 (base)' }, 'the control: without the setting the diff runs');
});

test('the raw diff reader refuses every record it cannot read, and the verdict reads a refusal as UNKNOWN', async () => {
  const { rawChanges, classifyRaw } = await api;
  const sha = 'a'.repeat(40), other = 'b'.repeat(40), record = status => ':100644 100644 ' + sha + ' ' + other + ' ' + status;
  assert.deepEqual(rawChanges(''), []);
  assert.deepEqual(rawChanges([record('M'), 'b.mjs', record('A'), 'a.mjs', ''].join(NUL)).map(c => [c.path, c.status]), [['a.mjs', 'A'], ['b.mjs', 'M']]);
  for (const [label, text] of [['a status git never prints here', [record('R100'), 'a.mjs', ''].join(NUL)], ['an unmerged status', [record('U'), 'a.mjs', ''].join(NUL)],
    ['a record with no path', [record('M'), '', ''].join(NUL)], ['an odd field count', [record('M'), ''].join(NUL)],
    ['a short object name', [':100644 100644 abc def M', 'a.mjs', ''].join(NUL)], ['no final NUL', [record('M'), 'a.mjs'].join(NUL)]]) {
    assert.throws(() => rawChanges(text), label);
    assert.deepEqual(classifyRaw(ROOT, text), { code: 2, line: 'UNKNOWN git diff output this tool cannot read' }, label);
  }
  // The control: a record it reads reaches the verdict (a path that is not JavaScript needs no blob).
  assert.deepEqual(classifyRaw(ROOT, [record('M'), 'README.md', ''].join(NUL)), { code: 2, line: 'UNKNOWN no JavaScript file changed; 1 other path(s) left to the path rule' });
});

// A path holding a line break. Git for Windows refuses one at the index (`update-index --cacheinfo`
// prints "Invalid path" and exits 128) and git elsewhere takes one. The classifier reads commits, so
// the fixture builds its commit from tree objects, which never pass the index; Git for Windows is
// expected to take the name in a tree too (its mktree refuses only a `/`), pending a Windows run.
// Off Windows the fixture's PATH starts with a git that answers an update-index whose arguments
// hold a control character with that refusal, and hands every other command to the git found after
// it. It reads arguments only, so once c1 exists the test also asserts on the domain: no name in the
// index or under the work tree holds a code point below U+0020. A fixture that stages the name from
// an argument, from stdin or through the work tree goes red off Windows too.
const BROKEN = 'line' + String.fromCharCode(10) + 'break.mjs', TAB = String.fromCharCode(9);
const indexRefusingGit = real => `#!/bin/sh
# An update-index whose arguments hold a control character gets Git for Windows' --cacheinfo
# refusal; every other command goes to the real git.
sub= skip=
for arg do
  if [ -n "$sub" ]; then
    case $arg in *[[:cntrl:]]*) echo "error: Invalid path '$arg'" >&2; exit 128 ;; esac
  elif [ -n "$skip" ]; then skip=
  else
    case $arg in -c|-C|--git-dir|--work-tree|--namespace|--config-env) skip=1 ;; -*) ;; update-index) sub=$arg ;; *) break ;; esac
  fi
done
exec '${real}' "$@"
`;
// Every name holding a code point below U+0020, compared by code point, in git's index (read raw:
// the fixture's git() trims its output) or anywhere under the work tree.
function controlNames(repo) {
  const held = name => [...name].some(c => c.codePointAt(0) < 0x20);
  const index = spawnSync('git', ['ls-files', '-z'], { cwd: repo.cwd, env: repo.env, encoding: 'utf8', windowsHide: true, timeout: 15000 });
  assert.ifError(index.error); assert.equal(index.status, 0, index.stderr);
  const walk = (dir, prefix) => fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => !prefix && entry.name === '.git' ? []
    : [prefix + entry.name, ...(entry.isDirectory() ? walk(path.join(dir, entry.name), prefix + entry.name + '/') : [])]);
  return [...index.stdout.split(NUL).filter(held).map(name => 'index: ' + name), ...walk(repo.cwd, '').sort().filter(held).map(name => 'work tree: ' + name)];
}
function refuseAtTheIndexAsGitForWindows(repo) {
  if (process.platform === 'win32') return;
  const key = Object.keys(repo.env).find(name => name.toUpperCase() === 'PATH');
  const runnable = file => { try { fs.accessSync(file, fs.constants.X_OK); return fs.statSync(file).isFile(); } catch { return false; } };
  const real = repo.env[key].split(path.delimiter).filter(dir => path.isAbsolute(dir)).map(dir => path.join(dir, 'git')).find(runnable);
  assert.ok(real && !real.includes("'"), 'a git on PATH the script can name: ' + real);
  const bin = path.join(repo.root, 'windows-git');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'git'), indexRefusingGit(real), { mode: 0o755 });
  repo.env[key] = bin + path.delimiter + repo.env[key];
}

test('one line whatever a path holds, usage refused, --help documents the flags the published command uses', t => {
  const repo = makeRepo(t);
  refuseAtTheIndexAsGitForWindows(repo);
  repo.write('a.mjs', 'x = 1;\n'); const c0 = repo.commit('c0');
  const blob = repo.git('hash-object', '-w', 'a.mjs');
  // The live control: the index refuses the path, and takes the same entry under a name holding
  // U+0020, which stays in the index for the domain assertion below.
  const refused = repo.probe('update-index', '--add', '--cacheinfo', '100644,' + blob + ',' + BROKEN);
  assert.equal(refused.status, 128, 'the index refuses a path holding a line break: ' + refused.stderr);
  assert.match(refused.stderr, /Invalid path '/);
  assert.equal(repo.probe('update-index', '--add', '--cacheinfo', '100644,' + blob + ',plain name.mjs').status, 0, 'the index takes a name holding a space');
  // So c1 is c0's tree entries and the new one, made a tree by mktree and a commit by commit-tree.
  const tree = spawnSync('git', ['mktree', '-z'], { cwd: repo.cwd, env: repo.env, input: repo.git('ls-tree', '-z', c0) + '100644 blob ' + blob + TAB + BROKEN + NUL,
    encoding: 'utf8', windowsHide: true, timeout: 15000 });
  assert.ifError(tree.error); assert.equal(tree.status, 0, tree.stderr);
  const c1 = repo.git('commit-tree', tree.stdout.trim(), '-p', c0, '-m', 'c1');
  assert.deepEqual(controlNames(repo), [], 'the name never reached the index or the work tree');
  assert.deepEqual(cli(repo, c0, c1), { status: 1, line: 'CODE line?break.mjs' });
  const run = args => spawnSync(process.execPath, [TOOL, ...args], { cwd: repo.cwd, env: repo.env, encoding: 'utf8', windowsHide: true, timeout: 60000 });
  for (const args of [[], ['--repo', repo.cwd], ['--repo', repo.cwd, '--base', c0, '--head', c1, '--extra', 'x'], ['--repo', repo.cwd, '--base', c0, '--base', c1]]) {
    const r = run(args);
    assert.deepEqual([r.status, r.stdout], [2, 'UNKNOWN usage: unknown, missing or duplicate flag; use --help\n'], args.join(' '));
  }
  const help = run(['--help']);
  assert.equal(help.status, 0);
  const synopsis = help.stdout.split('\n')[0];
  const flags = [...publishedCommand().matchAll(/(--[a-z]+) </g)].map(m => m[1]);
  assert.deepEqual(flags, ['--repo', '--base', '--head']);
  for (const flag of flags) assert.ok(synopsis.includes(flag + ' <'), '--help documents ' + flag);
  // The domain assertion's live control: names staged from stdin, which the git above never sees,
  // and written to the work tree — the fixture's own, one holding only U+001F (in a directory, so
  // the walk recurses) and one opening with a tab (which the fixture's git() would trim). Off
  // Windows each is reported from both; Windows refuses them all, so none is held.
  const names = [TAB + 'lead.mjs', 'lib/unit' + String.fromCharCode(0x1f) + 'separator.mjs', BROKEN];
  const staged = spawnSync('git', ['update-index', '-z', '--index-info'], { cwd: repo.cwd, env: repo.env, input: names.map(name => '100644 blob ' + blob + TAB + name + NUL).join(''),
    encoding: 'utf8', windowsHide: true, timeout: 15000 });
  assert.ifError(staged.error);
  for (const name of names) {
    try { repo.write(name, 'x = 1;\n'); }
    catch (e) { assert.equal(process.platform, 'win32', 'a file named with a control character failed off Windows: ' + e.code); }
  }
  const held = process.platform === 'win32' ? [] : [...names.map(name => 'index: ' + name), ...names.map(name => 'work tree: ' + name)];
  assert.deepEqual(controlNames(repo), held, staged.stderr);
});
