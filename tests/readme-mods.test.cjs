'use strict';
// README.md's clear and continue (§Mods), bound to the files that define it. The tool's name, the arguments the mod
// runs after its clear and in place of a skipped one, and the countdown are read from
// orchestrate-mod/hooks/clear.js's exports and held equal to what README.md, orchestrate-mod/hooks/register.js,
// orchestrate/references/protocol.md and orchestrate/SKILL.md name; README's passages of this change are pinned
// whole, and the clear's key words held inside them. Each check answers a list of faults, so every live
// control below feeds it one planted mismatch and reads the faults it reports.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');

const ROOT = path.resolve(__dirname, '..');
const lf = text => text.replace(/\r\n/g, '\n');
const read = file => lf(fs.readFileSync(path.join(ROOT, file), 'utf8'));
const collapse = text => text.replace(/\s+/g, ' ');
const clear = import(pathToFileURL(path.join(ROOT, 'orchestrate-mod/hooks/clear.js')).href);
const README = 'README.md', PROTOCOL = 'orchestrate/references/protocol.md', SKILL = 'orchestrate/SKILL.md';
const REGISTER = 'orchestrate-mod/hooks/register.js', MOD = 'orchestrate-mod';
const DOCS = [README, PROTOCOL, SKILL];
const checkout = () => new Map([...DOCS, REGISTER].map(file => [file, read(file)]));
const pluginName = () => JSON.parse(read(MOD + '/.claude-plugin/plugin.json')).name;
// `texts` with one file's text edited; the edit must change it, so a control whose anchor moved fails loudly.
function edited(texts, file, edit) {
  const before = texts.get(file), after = edit(before);
  assert.notEqual(after, before, file + ': the control must change the text');
  return new Map([...texts, [file, after]]);
}
// An edit replacing `find`, which must occur exactly once.
const swap = (find, put) => text => {
  assert.equal(text.split(find).length - 1, 1, 'the control anchor must be found once — ' + find);
  return text.replace(find, () => put);
};
// Every text spelled with CRLF, as a Git for Windows checkout may hand it over.
const crlf = texts => new Map([...texts].map(([file, text]) => [file, text.replace(/\n/g, '\r\n')]));
// Each control `[what, ...inputs, faults]` with the faults `check(...inputs)` reports, beside the ones it must, compared
// once, so a red shows every control's outcome.
const settle = (controls, check) => assert.deepEqual(controls.map(([what, ...rest]) => [what, check(...rest.slice(0, -1))]),
  controls.map(([what, ...rest]) => [what, rest[rest.length - 1]]));
const spansOf = text => [...lf(text).matchAll(/`([^`\n]+)`/g)].map(m => m[1]);
// The part of `text` from `from` up to `to`; both bounds must resolve.
function between(text, [from, to]) {
  const start = text.indexOf(from), end = start === -1 ? -1 : text.indexOf(to, start + from.length);
  assert.ok(start !== -1 && end !== -1, 'passage bounds must resolve: ' + from + ' .. ' + to);
  return text.slice(start, end);
}
// protocol.md's step 8, and README's two passages of the clear: §Mods' opening and §Clear and continue.
const STEP_8 = ['\n8. Wave closed.', '\n**Session practices**'];
const README_OPENING = ['\n## Mods\n', '\n### Install'], README_CLEAR = ['### Clear and continue', '\n\n## Requirements'];

// ===== register.js, read as code =======================================================
// Its code with the comments taken out, so a comment may name anything.
const code = source => lf(source).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
// The value register.js passes as `expr`: a name it imports from ./clear.js, resolved through the exports `c`;
// any other expression is no value of clear.js's.
function valueOf(source, c, expr) {
  const m = /\bimport\s*\{([^}]*)\}\s*from\s*['"]\.\/clear\.js['"]/.exec(source);
  const imports = new Map((m ? m[1].split(',') : []).map(s => s.trim()).filter(Boolean).map(s => {
    const [name, local = name] = s.split(/\s+as\s+/);
    return [local, name];
  }));
  return imports.has(expr) ? c[imports.get(expr)] : undefined;
}

// ===== The tool's name =================================================================
const FULL_NAME = /\bmcp__[\w-]+?__\w+/g;
const SHORT_NAME = /schedule[\W_]*clear/gi;
// Each place the tool's name is not clear.js's: TOOL_FULL_NAME off the plugin's own name, register.js registering
// or filtering on another, and a full or short name README, protocol.md or SKILL.md spells otherwise; README and
// protocol.md must name it in full.
function toolFaults(texts, c, plugin) {
  const faults = [];
  if (c.TOOL_FULL_NAME !== `mcp__${plugin}__${c.TOOL_NAME}`) faults.push(`clear.js: TOOL_FULL_NAME is not mcp__${plugin}__${c.TOOL_NAME}`);
  const source = code(texts.get(REGISTER));
  const registered = [...source.matchAll(/\$\.tool\.register\(\{\s*name:\s*([^,}]+?)\s*[,}]/g)].map(m => m[1]);
  if (registered.length === 0) faults.push('register.js: registers no tool');
  for (const expr of registered) if (valueOf(source, c, expr) !== c.TOOL_NAME) faults.push('register.js: registers ' + expr);
  const filters = [...source.matchAll(/\{\s*tool:\s*(['"`])([^'"`]*)\1\s*\}/g)].map(m => m[2]);
  if (filters.length === 0) faults.push('register.js: filters on no tool');
  for (const name of filters) if (name !== c.TOOL_FULL_NAME) faults.push('register.js: filters on ' + name);
  for (const file of DOCS) {
    const text = collapse(lf(texts.get(file))), full = [...text.matchAll(FULL_NAME)].map(m => m[0]);
    for (const name of full) if (name !== c.TOOL_FULL_NAME) faults.push(file + ': names ' + name);
    for (const m of text.matchAll(SHORT_NAME)) if (m[0] !== c.TOOL_NAME) faults.push(file + ': names ' + m[0]);
    if (file !== SKILL && !full.includes(c.TOOL_FULL_NAME)) faults.push(file + ': does not name ' + c.TOOL_FULL_NAME);
  }
  return faults;
}
test('the tool README names is the one clear.js exports, register.js registers and filters on, and protocol.md names', async () => {
  const c = await clear, plugin = pluginName(), texts = checkout();
  assert.deepEqual(toolFaults(texts, c, plugin), []);
  assert.deepEqual(toolFaults(crlf(texts), c, plugin), [], 'a CRLF checkout reads alike');
  const P = PROTOCOL + ': ', R = 'README.md: ', FULL = c.TOOL_FULL_NAME;
  const controls = [
    ['README, the full name', edited(texts, README, swap('`' + FULL + '`', '`mcp__orchestrate_mod__schedule_clear`')), c,
      [R + 'names mcp__orchestrate_mod__schedule_clear', R + 'does not name ' + FULL]],
    ['README, the short name', edited(texts, README, swap("calls the mod's `schedule_clear`", "calls the mod's `schedule-clear`")), c, [R + 'names schedule-clear']],
    ['protocol.md', edited(texts, PROTOCOL, swap('include `' + FULL + '`', 'include `mcp__orchestrate-mod__clear`')), c,
      [P + 'names mcp__orchestrate-mod__clear', P + 'does not name ' + FULL]],
    ['SKILL.md', edited(texts, SKILL, text => text + '\nCall `mcp__orchestrate-mod__scheduleclear` first.\n'), c,
      [SKILL + ': names mcp__orchestrate-mod__scheduleclear', SKILL + ': names scheduleclear']],
    ["clear.js's short name", texts, { ...c, TOOL_NAME: 'clear_schedule' },
      ['clear.js: TOOL_FULL_NAME is not mcp__' + plugin + '__clear_schedule', R + 'names schedule_clear', R + 'names schedule_clear', R + 'names schedule_clear',
        P + 'names schedule_clear']],
    ["clear.js's full name", texts, { ...c, TOOL_FULL_NAME: 'mcp__orchestrate-mod__clear' },
      ['clear.js: TOOL_FULL_NAME is not ' + FULL, 'register.js: filters on ' + FULL, 'register.js: filters on ' + FULL,
        R + 'names ' + FULL, R + 'does not name mcp__orchestrate-mod__clear', P + 'names ' + FULL, P + 'does not name mcp__orchestrate-mod__clear']],
    ["register.js's filter", edited(texts, REGISTER, swap("on('tool.call', { tool: '" + FULL + "' }", "on('tool.call', { tool: 'mcp__orchestrate-mod__scheduleClear' }")), c,
      ['register.js: filters on mcp__orchestrate-mod__scheduleClear']],
    ["register.js's name, another export", edited(texts, REGISTER, swap('name: TOOL_NAME,', 'name: TOOL_FULL_NAME,')), c, ['register.js: registers TOOL_FULL_NAME']],
    ["register.js's name, a literal", edited(texts, REGISTER, swap('name: TOOL_NAME,', "name: 'schedule_clear',")), c, ["register.js: registers 'schedule_clear'"]],
    ["register.js's registration, gone", edited(texts, REGISTER, swap('$.tool.register({ name: TOOL_NAME', '$.tool.add({ name: TOOL_NAME')), c, ['register.js: registers no tool']],
    ["register.js's filters, no literal", edited(texts, REGISTER, text => text.split("{ tool: '" + FULL + "' }").join('{ tool: TOOL_FULL_NAME }')), c, ['register.js: filters on no tool']],
  ];
  settle(controls, (changed, exports) => toolFaults(changed, exports, plugin));
  // A comment of register.js may name another tool.
  assert.deepEqual(toolFaults(edited(texts, REGISTER, text => text + "\n// { tool: 'mcp__x__y' }\n"), c, plugin), []);
});

// ===== The arguments after the clear, and in place of a skipped one ====================
const AFTER_CLEAR = /after[\W_]*clear/gi;
// Each place the mod's `/orchestrate` arguments are not clear.js's. After its clear, `afterClearArgs`: in README,
// protocol.md and SKILL.md, a code span naming the after-clear word that is not that form, alone or behind
// `/orchestrate `, a mention of the word outside such a span, and a document naming no form. In place of a skipped
// clear, `continueArgs`: in README §Clear and continue and protocol.md's step 8, any other `/orchestrate ` code span
// and a passage not naming it. In register.js, each `/orchestrate` run after the `/clear` inside the function running
// it takes afterClearArgs, every other one continueArgs, and each kind is run.
function argsFaults(texts, c) {
  const faults = [], form = c.afterClearArgs('<id>'), word = new RegExp(AFTER_CLEAR.source, 'i');
  for (const file of DOCS) {
    const text = lf(texts.get(file)), spans = spansOf(text).filter(span => word.test(span));
    for (const span of spans) if (span.replace(/^\/orchestrate /, '') !== form) faults.push(file + ': names `' + span + '`');
    if (spans.length === 0) faults.push(file + ': names no after-clear form');
    const outside = [...text.matchAll(AFTER_CLEAR)].length - spans.reduce((n, span) => n + [...span.matchAll(AFTER_CLEAR)].length, 0);
    if (outside !== 0) faults.push(file + ': ' + outside + ' after-clear mention(s) outside its code spans');
  }
  const inPlace = '/orchestrate ' + c.continueArgs('<id>');
  for (const [where, text] of [[README + ' §Clear and continue', between(lf(texts.get(README)), README_CLEAR)], [PROTOCOL + ' step 8', between(lf(texts.get(PROTOCOL)), STEP_8)]]) {
    const commands = spansOf(text).filter(span => span.startsWith('/orchestrate ') && !word.test(span));
    for (const span of commands) if (span !== inPlace) faults.push(where + ': names `' + span + '`');
    if (!commands.includes(inPlace)) faults.push(where + ': does not name `' + inPlace + '`');
  }
  const source = code(texts.get(REGISTER)), at = source.search(/\$\.command\.run\(\{\s*command:\s*'clear'/);
  if (at === -1) return [...faults, 'register.js: runs no /clear'];
  const end = source.indexOf('\n}', at), afterClear = m => m.index > at && m.index < end;
  const runs = [...source.matchAll(/command:\s*'orchestrate',\s*args:\s*([^\n]*?)\s*\}\s*\)/g)];
  for (const [what, builder, kind] of [['after /clear', c.afterClearArgs, afterClear], ['in place', c.continueArgs, m => !afterClear(m)]]) {
    const exprs = runs.filter(kind).map(m => m[1]);
    if (exprs.length === 0) faults.push('register.js: runs no /orchestrate ' + what);
    for (const expr of exprs) {
      const called = /^(\w+)\(/.exec(expr);
      if (called === null || valueOf(source, c, called[1]) !== builder) faults.push('register.js: runs /orchestrate ' + expr + ' ' + what);
    }
  }
  return faults;
}
test('the arguments the mod runs after its clear, and in place of a skipped one, are the forms protocol.md, SKILL.md and README name', async () => {
  const c = await clear, texts = checkout();
  assert.deepEqual(argsFaults(texts, c), []);
  assert.deepEqual(argsFaults(crlf(texts), c), [], 'a CRLF checkout reads alike');
  const command = '`/orchestrate continue <id> after-clear`';
  const controls = [
    ['README', edited(texts, README, swap(command, '`/orchestrate continue after-clear <id>`')), c, ['README.md: names `/orchestrate continue after-clear <id>`']],
    ['README, unticked', edited(texts, README, text => text + '\nThe mod runs continue <id> after-clear.\n'), c, ['README.md: 1 after-clear mention(s) outside its code spans']],
    ['protocol.md', edited(texts, PROTOCOL, swap('runs ' + command + ';', 'runs `/orchestrate continue <id> --after-clear`;')), c,
      [PROTOCOL + ': names `/orchestrate continue <id> --after-clear`']],
    ['SKILL.md', edited(texts, SKILL, swap('`continue <id> after-clear` is the form', '`continue after-clear` is the form')), c, [SKILL + ': names `continue after-clear`']],
    ['SKILL.md, no form', edited(texts, SKILL, swap('`continue <id> after-clear` is the form', 'a form')), c, [SKILL + ': names no after-clear form']],
    ["clear.js's builder", texts, { ...c, afterClearArgs: id => `continue ${id} --after-clear` },
      ['README.md: names ' + command, PROTOCOL + ': names ' + command, PROTOCOL + ': names ' + command, SKILL + ': names `continue <id> after-clear`']],
    ["register.js's builder", edited(texts, REGISTER, swap('args: afterClearArgs(c.ledger) }', 'args: continueArgs(c.ledger) }')), c,
      ['register.js: runs /orchestrate continueArgs(c.ledger) after /clear']],
    ["register.js's literal", edited(texts, REGISTER, swap('args: afterClearArgs(c.ledger) }', 'args: `continue ${c.ledger} after-clear` }')), c,
      ['register.js: runs /orchestrate `continue ${c.ledger} after-clear` after /clear']],
    ["register.js's run, gone", edited(texts, REGISTER, swap("{ command: 'orchestrate', args: afterClearArgs(c.ledger) }", "{ command: 'help', args: '' }")), c,
      ['register.js: runs no /orchestrate after /clear']],
    ["register.js's /clear, gone", edited(texts, REGISTER, swap("command: 'clear'", "command: 'reset'")), c, ['register.js: runs no /clear']],
    ['README, the in-place command', edited(texts, README, swap('`/orchestrate continue <id>`;', '`/orchestrate continue`;')), c,
      ['README.md §Clear and continue: names `/orchestrate continue`', 'README.md §Clear and continue: does not name `/orchestrate continue <id>`']],
    ['protocol.md, the in-place command', edited(texts, PROTOCOL, swap('`/orchestrate continue <id>` in this conversation', '`/orchestrate continue <id> here` in this conversation')), c,
      [PROTOCOL + ' step 8: names `/orchestrate continue <id> here`', PROTOCOL + ' step 8: does not name `/orchestrate continue <id>`']],
    ["clear.js's in-place builder", texts, { ...c, continueArgs: id => `resume ${id}` },
      ['README.md §Clear and continue: names `/orchestrate continue <id>`', 'README.md §Clear and continue: does not name `/orchestrate resume <id>`',
        PROTOCOL + ' step 8: names `/orchestrate continue <id>`', PROTOCOL + ' step 8: does not name `/orchestrate resume <id>`']],
    ["register.js's in-place builder", edited(texts, REGISTER, swap('args: continueArgs(id) }', 'args: afterClearArgs(id) }')), c,
      ['register.js: runs /orchestrate afterClearArgs(id) in place']],
    ["register.js's in-place run, gone", edited(texts, REGISTER, swap("{ command: 'orchestrate', args: continueArgs(id) }", "{ command: 'help', args: '' }")), c,
      ['register.js: runs no /orchestrate in place']],
  ];
  settle(controls, argsFaults);
});

// ===== The countdown ===================================================================
const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];
const UNIT_MS = { second: 1000, minute: 60000, hour: 3600000 };
const DURATION = new RegExp(String.raw`\b(\d+|${NUMBER_WORDS.join('|')})[\s-]+(second|minute|hour)s?\b([\s-]+timer\b)?`, 'gi');
// Every duration `text` states: its phrase, its milliseconds, and whether it is a timer's.
const durations = text => [...collapse(text).matchAll(DURATION)].map(([phrase, n, unit, timer]) => ({
  phrase, timer: timer !== undefined, ms: (/^\d+$/.test(n) ? Number(n) : NUMBER_WORDS.indexOf(n.toLowerCase())) * UNIT_MS[unit.toLowerCase()],
}));
// Each place the countdown is not clear.js's COUNTDOWN_MS: in protocol.md's step 8 and in README's two passages of
// the clear (§Mods' opening and §Clear and continue), every duration but a timer's is the countdown, and each states
// both; the timers both state are one; and the band text those passages quote is clear.js's `countdownText` with
// its minutes and seconds written M:SS. README's other sections may state durations of their own.
function countdownFaults(texts, c) {
  const whole = lf(texts.get(README)), readme = between(whole, README_OPENING) + '\n\n' + between(whole, README_CLEAR);
  const faults = [], timers = new Set();
  for (const [where, text] of [[PROTOCOL + ' step 8', between(lf(texts.get(PROTOCOL)), STEP_8)], [README, readme]]) {
    const found = durations(text);
    for (const d of found) if (!d.timer && d.ms !== c.COUNTDOWN_MS) faults.push(where + ': ' + d.phrase + ' is not ' + c.COUNTDOWN_MS + ' ms');
    if (!found.some(d => !d.timer)) faults.push(where + ': states no countdown');
    if (!found.some(d => d.timer)) faults.push(where + ': states no timer');
    for (const d of found) if (d.timer) timers.add(d.ms);
  }
  if (timers.size > 1) faults.push('step 8 and README state timers of ' + [...timers].join(' and ') + ' ms');
  const band = c.countdownText(c.COUNTDOWN_MS).replace(/^clearing in \d+:\d\d/, 'clearing in M:SS');
  const quoted = spansOf(readme).filter(span => span.startsWith('clearing in '));
  if (quoted.length === 0) faults.push('README.md: quotes no band text');
  for (const span of quoted) if (span !== band) faults.push('README.md: quotes `' + span + '`, not `' + band + '`');
  return faults;
}
test("README's two minutes, protocol.md's and the countdown clear.js exports agree, and README quotes its band text", async () => {
  const c = await clear, texts = checkout(), S8 = PROTOCOL + ' step 8: ', MS = ' is not ' + c.COUNTDOWN_MS + ' ms';
  assert.deepEqual(countdownFaults(texts, c), []);
  assert.deepEqual(countdownFaults(crlf(texts), c), [], 'a CRLF checkout reads alike');
  const band = c.countdownText(c.COUNTDOWN_MS).replace(/^clearing in \d+:\d\d/, 'clearing in M:SS');
  const controls = [
    ['README', edited(texts, README, swap('A two-minute', 'A three-minute')), c, ['README.md: three-minute' + MS]],
    ['README, no countdown', edited(texts, README, swap('A two-minute', 'A')), c, ['README.md: states no countdown']],
    ['protocol.md', edited(texts, PROTOCOL, swap('two minutes later', 'five minutes later')), c, [S8 + 'five minutes' + MS]],
    ["clear.js's countdown", texts, { ...c, COUNTDOWN_MS: 180000 }, [S8 + 'two minutes is not 180000 ms', 'README.md: two-minute is not 180000 ms']],
    ["README's timer", edited(texts, README, swap('keeps its 10-minute timer', 'keeps its 15-minute timer')), c, ['step 8 and README state timers of 600000 and 900000 ms']],
    ["README's band text", edited(texts, README, swap('`clearing in M:SS', '`clearing in 2:00')), c,
      ['README.md: quotes `' + band.replace('M:SS', '2:00') + '`, not `' + band + '`']],
    ["clear.js's band text", texts, { ...c, countdownText: ms => 'clears in ' + ms / 1000 + ' s' }, ['README.md: quotes `' + band + '`, not `clears in 120 s`']],
    // Must pass: the same two minutes, in other words.
    ['README, in seconds', edited(texts, README, swap('A two-minute', 'A 120-second')), c, []],
    ['protocol.md, in digits', edited(texts, PROTOCOL, swap('two minutes later', '2 minutes later')), c, []],
    // Must pass: a duration of README's own in §Use, just before §Clear and continue, and in §Requirements, just after it.
    ['README, a duration in §Use', edited(texts, README, swap('context and the dollars spent.', 'context and the dollars spent, read again every 30 seconds while it is open.')), c, []],
    ['README, a duration in §Requirements', edited(texts, README, swap('without one).', 'without one). The suite takes about 30 seconds.')), c, []],
    ['README, no timer', edited(texts, README, text => text.split('10-minute timer').join('timer')), c, ['README.md: states no timer']],
    ['README, the band text unquoted', edited(texts, README, swap('`' + band + '`', band)), c, ['README.md: quotes no band text']],
  ];
  settle(controls, countdownFaults);
});

// ===== README's passages ===============================================================
// [what, from, to, the passage from `from` up to `to`, its whitespace collapsed].
const PINS = [
  ['the continue row', '| `/orchestrate continue [<id>]` |', '\n',
    "| `/orchestrate continue [<id>]` | Run to the next checkpoint: validate the tip, open the wave, implement its batches concurrently, gate + integrate each as it lands, repeat — then pre-verify what an agent can and stop with one combined smoke page. Naming a ledger's `<id>` picks that ledger when more than one is active |"],
  ["§Mods' opening", '`orchestrate-mod/` is an optional Claude Code mod', '\n\n### Install',
    "`orchestrate-mod/` is an optional Claude Code mod beside the skill: a `/ledger` pane, a band line above the prompt, and a per-request cost log of every session it loads in, one JSONL file per session (a long session continues in `<session>.1.jsonl`, `<session>.2.jsonl`, …) under `~/.claude/orchestrate-costs/`."
    + " No orchestrate step depends on it: step 8 of the skill's session algorithm calls the mod's `schedule_clear` when a session has it, and keeps its 10-minute timer otherwise (§Clear and continue)."],
  ['§Clear and continue', ...README_CLEAR,
    "### Clear and continue The mod registers the tool `schedule_clear`, which the model calls by its full name `mcp__orchestrate-mod__schedule_clear`."
    + " At the points that step 8 of the pinned `references/protocol.md` §Session algorithm names, the conductor commits a PROGRESS session-log row naming the LOG heading of the work since the row before, then calls the tool in place of its 10-minute timer."
    + " - The mod declines when the band line does not show that ledger (the session is untagged, or tagged with another), the ledger's pinned protocol does not name the tool, the integration tip has moved, the ledger's directory holds uncommitted files, an agent is in flight, or a clear is already scheduled. The conductor then runs its timer as before."
    + " - Otherwise the conductor posts the line the mod answers with and ends its turn. A two-minute countdown then runs in the band line: `clearing in M:SS · type anything to keep this conversation`."
    + " Any message keeps the conversation; a local command such as `/ledger` starts no turn, so it does not. A turn that is interrupted, or ends in a refusal or an error, drops the clear as well."
    + " - At zero the mod runs `/clear`, then `/orchestrate continue <id> after-clear`. The earlier conversation vanishes from view and the fresh one boots from the ledger; its first answer names the LOG heading that the ledger's newest PROGRESS session-log row names, the run's record of the work before the clear."
    + " - Background work still running when the turn ends, or a scheduled task (a cron), skips the clear, since its notice would wake the fresh conversation; so does an app that reports neither, and an agent found running at zero."
    + " A skipped clear continues the run in this conversation with `/orchestrate continue <id>`; should the app refuse that command, or the one that follows a clear, the band line names it for you to type."
    + " - `/ledger` lists each clear, with its time and the context it cleared, and a run total across the conversations the clears link."
    + " - To turn the clear off, remove the mod as Install above describes; the 10-minute timer is the skill's own and needs no mod."],
];
// The tree rows this change wrote or extended, each a whole line.
const TREE_ROWS = [
  '│   ├── register.js                 the hooks module: every $ call, the /ledger command, the pane, the band line, the cost log, the clear',
  "│   ├── clear.js                    pure: the tool's names, the countdown, the commands, the decision on a call, the turn's end, the run",
  '    ├── clear.test.tsx              kit test of the clear and continue, run by claude plugin test',
];
const rowName = row => /[├└]── (\S+)/.exec(row)[1];
// [start, end) of each pinned passage and row `text` holds once.
function homes(text) {
  const found = [];
  for (const [what, from, to] of PINS) {
    const start = text.indexOf(from), end = start === -1 ? -1 : text.indexOf(to, start + from.length);
    if (end !== -1 && text.indexOf(from, start + 1) === -1) found.push([what, start, end]);
  }
  for (const row of TREE_ROWS) {
    const start = text.indexOf('\n' + row + '\n');
    if (start !== -1 && text.indexOf('\n' + row + '\n', start + 1) === -1) found.push(['tree row ' + rowName(row), start + 1, start + 1 + row.length]);
  }
  return found;
}
function pinFaults(readme) {
  const text = lf(readme), at = new Map(homes(text).map(([what, start, end]) => [what, text.slice(start, end)]));
  return [...PINS.flatMap(([what, , , expected]) => !at.has(what) ? [what + ': not found once'] : collapse(at.get(what)) !== expected ? [what + ': changed'] : []),
    ...TREE_ROWS.flatMap(row => at.has('tree row ' + rowName(row)) ? [] : ['tree row ' + rowName(row) + ': not found once'])];
}
// The clear's key words, however spelled or wrapped, sit in README only inside the pinned passages and rows, so no
// sentence elsewhere restates or reverses them.
const KEY_WORDS = [['the tool', SHORT_NAME], ['the after-clear word', AFTER_CLEAR], ['the countdown', /count[\W_]*down/gi], ['the clear command', /(?<![\w/.-])\/clear\b/gi]];
function strayFaults(readme) {
  const text = lf(readme), inside = homes(text);
  return KEY_WORDS.flatMap(([what, pattern]) => [...text.matchAll(pattern)]
    .filter(m => !inside.some(([, start, end]) => m.index >= start && m.index + m[0].length <= end))
    .map(m => what + ': ' + collapse(text.slice(Math.max(0, m.index - 30), m.index + m[0].length + 30)).trim()));
}
test("README's passages of the clear and continue are pinned whole, and its key words appear nowhere else", () => {
  const readme = read(README);
  assert.deepEqual(pinFaults(readme), []);
  assert.deepEqual(strayFaults(readme), []);
  assert.deepEqual([pinFaults(readme.replace(/\n/g, '\r\n')), strayFaults(readme.replace(/\n/g, '\r\n'))], [[], []], 'a CRLF checkout reads alike');
  // Live: a sentence planted just inside either end of each passage, and each row edited, reddens its pin.
  const inside = PINS.flatMap(([what, from, to]) => {
    const start = readme.indexOf(from) + from.length, end = readme.indexOf(to, start);
    return [[what + ', at its start', readme.slice(0, start) + ' Skip it.' + readme.slice(start), [what + ': changed']],
      [what + ', at its end', readme.slice(0, end) + ' Skip it.' + readme.slice(end), [what + ': changed']]];
  });
  const gone = [['§Clear and continue, its heading renamed', swap('### Clear and continue', '### Clear, then continue')(readme), ['§Clear and continue: not found once']]];
  settle([...inside, ...gone, ...TREE_ROWS.map(row => [rowName(row), swap(row, row + ' too')(readme), ['tree row ' + rowName(row) + ': not found once']])], pinFaults);
  // Live: each key word, however spelled or wrapped, planted outside the passages is reported; inside one it is not.
  const outside = text => swap('## Usage\n', '## Usage\n\n' + text + '\n')(readme);
  const planted = [['the tool', ['schedule_clear', 'scheduleClear', 'Schedule\n  clear']], ['the after-clear word', ['after-clear', 'after_clear', 'After\nclear']],
    ['the countdown', ['countdown', 'count-down', 'Count down']], ['the clear command', ['/clear', '`/clear`']]]
    .flatMap(([what, spellings]) => spellings.map(spelling => [JSON.stringify(spelling), outside('Then use ' + spelling + ' here.'), [what]]));
  settle(planted, text => strayFaults(text).map(f => f.split(':')[0]));
  assert.deepEqual(strayFaults(swap('for you to type.', 'for you to type; the countdown is `/clear`\'s.')(readme)), [], 'inside a passage a key word is at home');
});
