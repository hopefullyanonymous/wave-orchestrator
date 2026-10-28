#!/usr/bin/env node
// The change-complete ruling step's page, from one sidecar: build fills the frozen ruling-page
// template, list prints the `### Ruling list` block LOG.md commits, and read checks the text the
// user pasted back against the sidecar the page was built from.
//
//   node build-ruling-page.mjs build <ruling.json> <ruling.html> [--template <path>]
//   node build-ruling-page.mjs list <ruling.json>
//   node build-ruling-page.mjs read <ruling.json> <paste.txt> [--entries] [--today <YYYY-MM-DD>]
//   node build-ruling-page.mjs --help
//
// The sidecar's keys, with a complete example: references/ruling-page.md §Sidecar shape.
// The same sidecar and template always produce the same bytes, and the page names the first
// twelve hex digits of the sidecar's fingerprint, so a paste from any other sidecar is refused.
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { isMain } from "./git-evidence.mjs";
import { BACKLOG_FORM, RULINGS_FORM, BACKLOG_FIELDS, RULING_FIELDS, BACKLOG_READERS, RULING_READERS, KINDS, parseForm } from "./backlog.mjs";

const DEFAULT_TEMPLATE = resolve(
  dirname(fileURLToPath(import.meta.url)), "../references/ruling-page-template.html");

// Every outcome a row can be given, in the order the page and read's lines show them.
export const LABELS = {
  fix: "Fix now", register: "Register", accept: "Accept", decline: "Decline", log: "LOG only",
  keep: "Keep", drop: "Drop", take: "Take as a pack", skip: "Skip"
};
const ITEM_KINDS = ["residual", "expired", "pack"];
// A row's choices by its kind: Fix now only on a residual whose fix is prose-only.
export function choicesOf(item) {
  if (item.kind === "residual") return [...(item.proseOnly ? ["fix"] : []), "register", "accept", "decline", "log"];
  if (item.kind === "expired") return ["keep", "drop", "accept", "decline"];
  return ["take", "skip"];
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const isDate = s => typeof s === "string" && DATE.test(s) && new Date(s + "T00:00:00Z").toISOString().slice(0, 10) === s;
const ROW_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const TOP_KEYS = ["change", "ledger", "date", "storageKey", "groups", "items", "pageTitle", "eyebrow", "headline"];
const GROUP_KEYS = ["key", "title", "blurb"];
const ITEM_KEYS = ["id", "kind", "group", "what", "source", "detail", "where", "proseOnly", "proposal", "ruled", "entry"];
const ENTRY_KEYS = ["id", "rulingId", "title", "kind", "files", "tests", "failure", "doneWhen", "from"];
// The entry fields each written outcome needs; the rest of the outcomes write no entry.
const NEEDS = {
  register: ["id", "title", "kind", "files", "tests", "failure", "doneWhen", "from"],
  accept: ["rulingId", "title", "files"],
  decline: ["rulingId", "title", "files"]
};

function text(where, value, optional = false) {
  if (value === undefined && optional) return;
  if (typeof value !== "string" || !value.trim()) throw new Error(`${where} must be a non-empty string`);
  if (/[\r\n]/.test(value)) throw new Error(`${where} must be one line`);
}
function onlyKeys(where, obj, keys) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) throw new Error(`${where} must be an object`);
  const extra = Object.keys(obj).filter(k => !keys.includes(k));
  if (extra.length) throw new Error(`${where} has unknown key(s): ${extra.join(", ")}`);
}

// The sidecar, checked whole: a refusal names the first problem, never a guess.
export function validate(data) {
  onlyKeys("the sidecar", data, TOP_KEYS);
  text("change", data.change); text("ledger", data.ledger);
  if (!isDate(data.date)) throw new Error("date must be a YYYY-MM-DD calendar date");
  if (typeof data.storageKey !== "string" || !/^[A-Za-z0-9._-]+$/.test(data.storageKey)) throw new Error("storageKey must be letters, digits, '.', '_' or '-'");
  for (const k of ["pageTitle", "eyebrow", "headline"]) text(k, data[k], true);
  if (!Array.isArray(data.groups) || !data.groups.length) throw new Error("groups must be a non-empty array");
  const groups = new Set();
  data.groups.forEach((g, i) => {
    onlyKeys(`groups[${i}]`, g, GROUP_KEYS);
    text(`groups[${i}].key`, g.key); text(`groups[${i}].title`, g.title); text(`groups[${i}].blurb`, g.blurb, true);
    if (groups.has(g.key)) throw new Error(`group ${g.key} is defined twice`);
    groups.add(g.key);
  });
  if (!Array.isArray(data.items) || !data.items.length) throw new Error("items must be a non-empty array");
  const ids = new Set();
  data.items.forEach((it, i) => {
    onlyKeys(`items[${i}]`, it, ITEM_KEYS);
    if (typeof it.id !== "string" || !ROW_ID.test(it.id)) throw new Error(`items[${i}].id must be a letter or digit, then letters, digits, '.', '_' or '-'`);
    const at = `item ${it.id}`;
    if (ids.has(it.id)) throw new Error(`${at} is listed twice`);
    ids.add(it.id);
    if (!ITEM_KINDS.includes(it.kind)) throw new Error(`${at}: kind must be one of ${ITEM_KINDS.join(", ")}`);
    if (!groups.has(it.group)) throw new Error(`${at}: group ${it.group} is not in groups`);
    text(`${at}: what`, it.what); text(`${at}: source`, it.source);
    text(`${at}: detail`, it.detail, true); text(`${at}: where`, it.where, true);
    if (it.proseOnly !== undefined && (typeof it.proseOnly !== "boolean" || it.kind !== "residual")) throw new Error(`${at}: proseOnly is a boolean, on a residual only`);
    if (it.ruled !== undefined) {
      text(`${at}: ruled`, it.ruled);
      if (it.proposal !== undefined) throw new Error(`${at}: an already ruled row takes no proposal`);
    } else if (!choicesOf(it).includes(it.proposal)) {
      throw new Error(`${at}: proposal must be one of ${choicesOf(it).join(", ")}` + (it.proposal === "fix" ? " (fix is offered only on a proseOnly residual)" : ""));
    }
    if (it.entry !== undefined) validateEntry(at, it.entry);
    const missing = missingFor(it, it.proposal);
    if (missing.length) throw new Error(`${at}: a ${it.proposal} proposal needs entry ${missing.join(", ")}`);
  });
  if (!data.items.some(it => it.ruled === undefined)) throw new Error("items must hold at least one row to rule");
  return data;
}
function validateEntry(at, e) {
  onlyKeys(`${at}: entry`, e, ENTRY_KEYS);
  for (const k of ["id", "rulingId", "title", "failure", "doneWhen", "from"]) text(`${at}: entry.${k}`, e[k], true);
  if (e.kind !== undefined && !KINDS.includes(e.kind)) throw new Error(`${at}: entry.kind must be one of ${KINDS.join(", ")}`);
  for (const k of ["files", "tests"]) {
    if (e[k] === undefined) continue;
    if (!Array.isArray(e[k]) || e[k].some(p => typeof p !== "string" || !p)) throw new Error(`${at}: entry.${k} must be an array of paths`);
  }
  if (e.files !== undefined && !e.files.length) throw new Error(`${at}: entry.files must name at least one path`);
}
const missingFor = (it, outcome) => (NEEDS[outcome] || []).filter(k => !it.entry || it.entry[k] === undefined);

function fingerprint(data) {
  // Ignore object-key order and JSON formatting, but keep array order and values.
  const canonical = JSON.stringify(data, (_, value) =>
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))
      : value);
  return createHash("sha256").update(canonical).digest("hex");
}
export const pageKeyOf = data => fingerprint(data).slice(0, 12);

const escapeHtml = s => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
// JSON inside a script element: no `<` may reach the page raw, or a `</script>` in a row's text would end it.
const scriptJson = value => JSON.stringify(value).replace(/</g, String.fromCharCode(92) + "x3c");

export function buildRulingPage(data, template) {
  const d = validate(data);
  if (template.replace(/\{\{[A-Z_]+\}\}/g, "").includes("{{")) {
    throw new Error("self-check failed: the template carries a `{{` that is not a slot");
  }
  const pageKey = pageKeyOf(d);
  const page = {
    change: d.change, pageKey, storageKey: d.storageKey, labels: LABELS,
    eyebrow: d.eyebrow ?? `${d.ledger} · change-complete ruling step`,
    headline: d.headline ?? `${d.change}: what the run set aside`,
    groups: d.groups.map(g => ({ key: g.key, title: g.title, blurb: g.blurb })),
    items: d.items.map(it => ({
      id: it.id, group: it.group, what: it.what, detail: it.detail, where: it.where, ruled: it.ruled,
      proposal: it.proposal, choices: it.ruled === undefined ? choicesOf(it) : []
    }))
  };
  const slots = { PAGE_TITLE: escapeHtml(d.pageTitle ?? `${d.change} Rulings`), DATA_JSON: scriptJson(page) };
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (_, name) => {
    if (!(name in slots)) throw new Error(`template wants a slot the sidecar cannot fill: {{${name}}}`);
    return slots[name];
  });
}

// The `### Ruling list` block LOG.md commits before the STOP: every row, its proposal and where it came from.
export function rulingList(data, sidecarName) {
  const d = validate(data);
  const open = d.items.filter(it => it.ruled === undefined);
  const lines = ["### Ruling list", "",
    `Sidecar \`${sidecarName}\`, page ${pageKeyOf(d)}: ${open.length} item(s) to rule, ${d.items.length - open.length} already ruled.`, ""];
  for (const it of d.items) {
    const state = it.ruled === undefined ? `proposed ${LABELS[it.proposal]}` : `already ruled: ${it.ruled}`;
    lines.push(`- ${it.id} (${it.kind}, ${state}): ${it.what} — from ${it.source}`);
  }
  return lines;
}

// The pasted text read against the sidecar: { problems } or { picks, notes, note, changed }.
export function readPaste(data, paste) {
  const d = validate(data);
  const key = pageKeyOf(d);
  const lines = (paste.charCodeAt(0) === 0xfeff ? paste.slice(1) : paste).split(/\r?\n/).map(l => l.trimEnd());
  const problems = [];
  const first = lines.findIndex(l => l.trim());
  const header = first === -1 ? null : /^(.+) rulings \(page ([0-9a-f]{12})\)$/.exec(lines[first].trim());
  if (!header) return { problems: ["the paste does not open with the page's header line, <change> rulings (page <key>)"] };
  if (header[2] !== key) return { problems: [`the paste comes from page ${header[2]}; this sidecar builds page ${key} (an older or another page)`] };
  const fullAt = lines.flatMap((l, i) => l.trim() === "Full list:" ? [i] : []);
  if (fullAt.length !== 1) return { problems: [`the paste holds "Full list:" ${fullAt.length} times, not once`] };
  const byId = new Map(d.items.map(it => [it.id, it]));
  const picks = new Map(), notes = new Map();
  let i = fullAt[0] + 1;
  for (; i < lines.length && lines[i].trim(); i++) {
    const line = lines[i].trim();
    const m = /^(\S+): (.+)$/.exec(line);
    if (!m) { problems.push(`"${line}" is not <id>: <outcome>`); continue; }
    const [, id, rest] = m, it = byId.get(id);
    if (!it) { problems.push(`${id} is no row of this page`); continue; }
    if (it.ruled !== undefined) { problems.push(`${id} was already ruled and takes no outcome`); continue; }
    if (picks.has(id)) { problems.push(`${id} is ruled twice`); continue; }
    const outcome = Object.keys(LABELS).find(k => rest === LABELS[k] || rest.startsWith(LABELS[k] + " — note: "));
    if (!outcome) { problems.push(`${id}: "${rest}" names no outcome`); continue; }
    if (!choicesOf(it).includes(outcome)) { problems.push(`${id}: ${LABELS[outcome]} is not a choice for this row`); continue; }
    picks.set(id, outcome);
    if (rest !== LABELS[outcome]) notes.set(id, rest.slice(LABELS[outcome].length + " — note: ".length));
  }
  for (const it of d.items) if (it.ruled === undefined && !picks.has(it.id)) problems.push(`${it.id} has no outcome in the full list`);
  // The changed lines above the full list must agree with it, so an edited paste reads as one.
  for (const line of lines.slice(first + 1, fullAt[0]).map(l => l.trim())) {
    const m = /^(\S+) (.+?) \(proposed (.+?)\) — /.exec(line);
    if (m && picks.has(m[1]) && LABELS[picks.get(m[1])] !== m[2]) problems.push(`${m[1]}: the changed line says ${m[2]}, the full list ${LABELS[picks.get(m[1])]}`);
  }
  let note = "";
  for (const line of lines.slice(i)) if (line.startsWith("Note: ")) note = line.slice(6);
  if (problems.length) return { problems };
  const changed = d.items.filter(it => picks.has(it.id) && picks.get(it.id) !== it.proposal).map(it => it.id);
  return { picks, notes, note, changed };
}

const ticks = paths => paths.map(p => "`" + p + "`").join(", ");
// The backlog and rulings entries the rulings write, as the form shows them, and the problems of
// any the sidecar holds too few fields for or that the form's own reader refuses.
export function entriesFor(data, read, today) {
  const d = validate(data);
  const backlog = [], rulings = [], problems = [];
  for (const it of d.items) {
    const outcome = read.picks.get(it.id);
    if (!NEEDS[outcome]) continue;
    const missing = missingFor(it, outcome);
    if (missing.length) { problems.push(`${it.id}: ${LABELS[outcome]} needs entry ${missing.join(", ")} in the sidecar`); continue; }
    const e = it.entry;
    if (outcome === "register") {
      backlog.push(`### ${e.id} — ${e.title}`, `Kind: ${e.kind}`, `Files: ${ticks(e.files)}`,
        `Tests: ${e.tests.length ? ticks(e.tests) : "none"}`, `Failure: ${e.failure}`, `Done when: ${e.doneWhen}`,
        `Since: ${today} — ${d.ledger} ${e.from}`, "");
    } else {
      const note = read.notes.get(it.id);
      rulings.push(`### ${e.rulingId} — ${e.title}`, `Ruling: ${outcome === "accept" ? "accepted" : "declined"} — ${today}`,
        `Reason: ${note ? JSON.stringify(note) : `"${LABELS[outcome]}" on the ruling page, no note given`}`, `Files: ${ticks(e.files)}`, "");
    }
  }
  for (const [form, fields, readers, lines, name] of [[BACKLOG_FORM, BACKLOG_FIELDS, BACKLOG_READERS, backlog, "backlog"],
    [RULINGS_FORM, RULING_FIELDS, RULING_READERS, rulings, "rulings"]]) {
    if (!lines.length) continue;
    const parsed = parseForm([form, "", ...lines].join("\n"), form, fields, readers);
    problems.push(...parsed.problems.map(p => `${name} entry ${p}`));
  }
  return { backlog, rulings, problems };
}

// The lines read prints: the verdict, one line per outcome given, the changed and noted rows, then the entries.
export function readLines(data, paste, { entries = false, today } = {}) {
  const read = readPaste(data, paste);
  if (read.problems) return { code: 1, lines: [`RULINGS FAIL ${read.problems.length} problem(s): ${read.problems.join("; ")}`] };
  const lines = [`RULINGS OK ${read.picks.size} item(s), page ${pageKeyOf(data)}, ${read.changed.length} changed from proposal`];
  for (const k of Object.keys(LABELS)) {
    const ids = [...read.picks].filter(([, v]) => v === k).map(([id]) => id);
    if (ids.length) lines.push(`${k.toUpperCase()} ${ids.join(" ")}`);
  }
  if (read.changed.length) lines.push(`CHANGED ${read.changed.join(" ")}`);
  if (read.notes.size) lines.push(`NOTED ${[...read.notes.keys()].join(" ")}`);
  if (read.note) lines.push(`NOTE ${read.note}`);
  if (!entries) return { code: 0, lines };
  const out = entriesFor(data, read, today ?? data.date);
  if (out.problems.length) return { code: 1, lines: [...lines, `ENTRIES FAIL ${out.problems.length} problem(s): ${out.problems.join("; ")}`] };
  lines.push(`ENTRIES OK ${out.backlog.filter(l => l.startsWith("### ")).length} backlog, ${out.rulings.filter(l => l.startsWith("### ")).length} rulings`);
  if (out.backlog.length) lines.push("--- backlog entries", ...out.backlog);
  if (out.rulings.length) lines.push("--- rulings entries", ...out.rulings);
  return { code: 0, lines };
}

function sameFile(left, right) {
  if (resolve(left) === resolve(right)) return true;
  if (!existsSync(left) || !existsSync(right)) return false;
  const a = statSync(left), b = statSync(right);
  return a.dev === b.dev && a.ino === b.ino;
}

const USAGE = "usage: build-ruling-page.mjs build <ruling.json> <ruling.html> [--template <path>] | list <ruling.json> | read <ruling.json> <paste.txt> [--entries] [--today <YYYY-MM-DD>]";
const HELP = [USAGE,
  "       build-ruling-page.mjs --help",
  "build: fills the ruling-page template (references/ruling-page-template.html, or --template <path>) from the sidecar.",
  "list: prints the ### Ruling list block LOG.md commits before the STOP, one line per row with its proposal and source.",
  "read: checks the pasted rulings against the sidecar: RULINGS OK <n> item(s), page <key>, <k> changed from proposal, then",
  "  one line per outcome given (FIX, REGISTER, ACCEPT, DECLINE, LOG, KEEP, DROP, TAKE, SKIP, each with its ids), CHANGED, NOTED",
  "  and NOTE; or RULINGS FAIL <k> problem(s): a paste from another page, a row missing, twice, unknown or given an outcome",
  "  it does not offer. --entries also prints the backlog and rulings entries the rulings write, in the form backlog.mjs",
  "  reads, dated --today (default the sidecar's date), or ENTRIES FAIL naming each one the sidecar cannot fill.",
  "The sidecar's keys, with a complete example: references/ruling-page.md §Sidecar shape.",
  "Exit 0: done, or this help; 1: an input refused or a FAIL, the reason printed; 2: an invalid invocation."
].join("\n");

function run(argv) {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: {
    template: { type: "string" }, entries: { type: "boolean" }, today: { type: "string" }, help: { type: "boolean" }
  } });
  if (values.help && argv.length === 1) return { code: 0, out: HELP };
  const [op, ...rest] = positionals;
  const shape = { build: 2, list: 1, read: 2 }[op];
  if (shape === undefined || rest.length !== shape || values.help
    || (values.template !== undefined && op !== "build") || ((values.entries || values.today !== undefined) && op !== "read")
    || (values.today !== undefined && !isDate(values.today))) throw new Error("invalid invocation");
  return { op, rest, values };
}

if (isMain(import.meta.url)) {
  let args;
  try { args = run(process.argv.slice(2)); } catch (e) {
    console.error(e.message);
    console.error(USAGE);
    process.exit(2);
  }
  if (args.out) { console.log(args.out); process.exit(0); }
  const { op, rest: [sidecar, second], values } = args;
  try {
    const data = JSON.parse(readFileSync(sidecar, "utf8"));
    if (op === "build") {
      const template = values.template ?? DEFAULT_TEMPLATE;
      for (const input of [sidecar, template]) if (sameFile(second, input)) throw new Error("output must not overwrite an input");
      const html = buildRulingPage(data, readFileSync(template, "utf8"));
      writeFileSync(second, html);
      console.log(`${second}: page ${pageKeyOf(data)}, ${data.items.length} row(s), every template slot filled`);
    } else if (op === "list") {
      console.log(rulingList(data, basename(sidecar)).join("\n"));
    } else {
      const out = readLines(data, readFileSync(second, "utf8"), { entries: values.entries, today: values.today });
      console.log(out.lines.join("\n"));
      process.exitCode = out.code;
    }
  } catch (e) {
    console.error(`${sidecar}: ${e.message}`);
    process.exit(1);
  }
}
