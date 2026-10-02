#!/usr/bin/env node
// Fill the frozen smoke-page template from a checkpoint's data sidecar.
//
//   node build-smoke-page.mjs <smoke-Cn.json> <smoke-Cn.html> [--previous <old.json>]
//     [--template <path>] [--reset-verdicts]
//
// The template is the settled design: fill its `{{...}}` slots and append a sidecar
// fingerprint. The same sidecar and template always produce the same bytes.
// Re-issues compare against the last issued sidecar to protect the step numbers
// and revisions that give carried verdicts their meaning.
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual, parseArgs } from "node:util";
import { declareInputs, compareInputHistory, validateInputFiles, sectionsWithInputs } from "./smoke-inputs.mjs";
import { isMain } from "./git-evidence.mjs";

const DEFAULT_TEMPLATE = resolve(
  dirname(fileURLToPath(import.meta.url)), "../references/smoke-page-template.html");

export function buildSmokePage(data, template, { previous, resetVerdicts = false, inputRoot } = {}) {
  const slots = renderSlots(data);
  if (previous !== undefined) validateReissue(data, validate(previous), resetVerdicts);
  else if (resetVerdicts) throw new Error("resetting verdicts requires a previous sidecar");
  validateInputFiles(declareInputs(data), inputRoot);
  // The documented self-check, enforced rather than remembered — over the TEMPLATE,
  // the only document a slot can live in. What it catches is a name the fill pattern
  // below cannot match (lower-case, spaced, hyphenated), which would otherwise ship
  // unfilled. The filled page is NOT the subject: a step's command may legitimately
  // carry `{{` — a GitHub Actions expression, a Handlebars or Vue binding — and
  // scanning the fill refused to publish any page containing one.
  if (template.replace(/\{\{[A-Z_]+\}\}/g, "").includes("{{")) {
    throw new Error("self-check failed: the template carries a `{{` that is not a slot; "
      + "a slot name is upper-case letters and underscores, with no spaces");
  }
  const out = template.replace(/\{\{([A-Z_]+)\}\}/g, (_, name) => {
    if (!(name in slots)) throw new Error(`template wants a slot the sidecar cannot fill: {{${name}}}`);
    return slots[name];
  });
  return out + sidecarStamp(data);
}

function sidecarFingerprint(data) {
  // Ignore object-key order/JSON formatting, but retain array order and values.
  const canonical = JSON.stringify(data, (_, value) =>
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))
      : value);
  return createHash("sha256").update(canonical).digest("hex");
}

function sidecarStamp(data) { return `\n<!-- smoke-sidecar-sha256:${sidecarFingerprint(data)} -->\n`; }

export function renderSlots(data) {
  const d = validate(data);
  const steps = d.sections.reduce((n, s) => n + s.steps.length, 0);
  const cn = `C${d.checkpoint}`;

  const facts = [];
  fact(facts, "Branch", code(d.branch));
  if (d.version) {
    fact(facts, "Version should read", d.version.was
      ? `${esc(d.version.now)} <span class="was">${esc(d.version.was)}</span>`
      : esc(d.version.now));
  }
  fact(facts, "Tip", code(d.buildSha.slice(0, 7)));
  if (d.suite) fact(facts, "Suite", esc(d.suite));
  if (d.knownFailures) fact(facts, "Known failures", esc(d.knownFailures));
  for (const extra of d.facts || []) fact(facts, esc(extra.dt), extra.dd);

  // Slots land in three different languages. `headline`, `eyebrow`, `standfirst`,
  // the facts and the gate are authored AS HTML and stay raw; a plain name like the
  // change title is escaped for the context it is dropped into, because "Fix "Save as""
  // is an ordinary change name and an unescaped one lands as a SyntaxError that
  // disables every control on the page.
  return {
    PAGE_TITLE: esc(d.pageTitle || `${d.change} Smoke Run`),   // <title> — text, no markup
    EYEBROW: d.eyebrow || `Checkpoint ${cn} · batches ${esc(d.batches)}`,
    HEADLINE: d.headline || `${esc(d.change)} — smoke run`,
    // After a run the driver may replace this with a result summary; before one it
    // has to tell the user how many steps there are and how to send them back.
    STANDFIRST: d.standfirst || `${steps} steps in ${d.sections.length} sections. `
      + "When you're done — or as soon as something fails — press "
      + "<strong>Copy results as text</strong> and paste it into the chat.",
    FACTS_HTML: facts.join("\n"),
    GATE_BODY: renderGate(d.gate),
    SECTIONS_JS: embed(sectionsWithInputs(d, declareInputs(d))),
    CKPT_KEY: d.ckptKey,                                       // charset-checked in validate()
    BUILD_SHA: d.buildSha,                                     // hex-checked in validate()
    COPY_HEADER: jsString(d.copyHeader                         // a JS string literal
      || `${cn} smoke run — ${d.change}${d.version ? ` (${d.version.now})` : ""}`)
  };
}

function renderGate(gate) {
  const lines = [
    '<p class="gate-eyebrow">Before anything else</p>',
    "<h3>Step 0 — prove you are on the right build</h3>"
  ];
  if (gate.intro) lines.push(`<p>${gate.intro}</p>`);
  for (const command of gate.commands || []) lines.push(`<pre><code>${esc(command)}</code></pre>`);
  lines.push('<ol class="gate-checks">');
  for (const check of gate.checks) lines.push(`  <li>${check}</li>`);
  lines.push("</ol>");
  return lines.join("\n");
}

// HTML parses script contents before JavaScript does. Escape every '<' in data:
// closing tags can end the block early, while `<!-- <script>` can hide its end.
// JSON decoding restores the original text and authored HTML at runtime.
function scriptJson(value, space) {
  return JSON.stringify(value, null, space)
    .replace(/</g, "\\u003c")
    .replace(/[\u2028\u2029]/g, c => "\\u" + c.charCodeAt(0).toString(16));
}

function embed(sections) {
  return scriptJson(sections, 2);
}

function fact(out, dt, dd) { out.push(`<div class="fact"><dt>${dt}</dt><dd>${dd}</dd></div>`); }
function code(value) { return `<code>${esc(value)}</code>`; }
function esc(value) { return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }

// The template supplies the surrounding quotes; retain the escaped string body.
function jsString(value) {
  return scriptJson(String(value)).slice(1, -1);
}

function number(value, what) {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${what} must be a positive integer`);
}

// Committing the page necessarily moves HEAD past the build the page describes, so a
// gate that asks the tester to compare `git rev-parse HEAD` against `buildSha` by eye
// can never agree; every run so far waived the difference by hand. Require the gate to
// RUN the containment proof against the SHA this very sidecar records.
function gateContainment(gate, buildSha) {
  const commands = gate.commands === undefined ? [] : gate.commands;
  if (!Array.isArray(commands) || commands.some(command => typeof command !== "string")) {
    throw new Error("gate.commands must be an array of command strings");
  }
  const text = commands.join("\n").replace(/[ \t]+/g, " ");
  const missing = [];
  if (!text.includes("merge-base --is-ancestor")) missing.push("`git merge-base --is-ancestor <buildSha> HEAD`");
  if (!text.includes("diff --name-only")) missing.push("`git diff --name-only <buildSha>..HEAD`");
  // A containment command naming some other build proves containment of that build.
  if (!new RegExp(buildSha.slice(0, 7), "i").test(text)) missing.push(`the tested build \`${buildSha.slice(0, 7)}\` itself`);
  if (missing.length) {
    throw new Error(`the step-0 gate has no containment check: gate.commands must run ${missing.join(" and ")}`);
  }
}

// A control character is invisible in every editor and in the rendered page. A U+0000
// inside a copyable command shipped once and turned that command into a SyntaxError for
// the reader who pasted it, with nothing on the page to show why.
// The domain is Unicode Cc entire — C0, DEL and C1 — minus tab and newline, which is
// what smoke-page.md publishes. C1 is in because NEL (U+0085) is a real line
// terminator: it splits a pasted command in two while looking like nothing at all.
// Compared by code point, never by an escape in a character class: the rule must not
// itself be a line of source whose meaning depends on invisible bytes surviving an edit.
const TAB = 9, NEWLINE = 10, FIRST_PRINTABLE = 32, DELETE = 127;
const C1_FIRST = 128, C1_LAST = 159;
const isControlCharacter = code =>
  (code < FIRST_PRINTABLE && code !== TAB && code !== NEWLINE)
  || code === DELETE || (code >= C1_FIRST && code <= C1_LAST);

function rejectControlCharacters(value, where) {
  if (typeof value === "string") {
    const characters = [...value];
    const at = characters.findIndex(character => isControlCharacter(character.codePointAt(0)));
    if (at === -1) return;
    const point = characters[at].codePointAt(0).toString(16).toUpperCase().padStart(4, "0");
    throw new Error(`${where} carries control character U+${point}; only tab and newline are allowed, `
      + "because an invisible character makes a published command a SyntaxError");
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => rejectControlCharacters(item, `${where}[${i}]`));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      rejectControlCharacters(key, `${where}: key ${JSON.stringify(key)}`);
      rejectControlCharacters(item, `${where}.${key}`);
    }
  }
}

// A restructure leaves `Section 5` and `Step 3` pointing at nothing, and the page hands
// the dangling reference to the tester as an instruction. Capitalised forms are the
// cross-references; `step 1` in "Mark step 1 Fail" is the step's own prose. Step 0 is
// the gate, which every page has.
function rejectDanglingReferences(d, sections, steps) {
  const known = { Section: sections, Step: steps };
  const scan = value => {
    if (typeof value === "string") {
      for (const [, word, digits] of value.matchAll(/\b(Section|Step)\s+(\d+)\b/g)) {
        const n = Number(digits);
        if (word === "Step" && n === 0) continue;
        if (known[word].has(n)) continue;
        throw new Error(`"${word} ${digits}" refers to a ${word.toLowerCase()} this sidecar does not contain`);
      }
      return;
    }
    if (Array.isArray(value)) { value.forEach(scan); return; }
    if (value && typeof value === "object") for (const item of Object.values(value)) scan(item);
  };
  scan(d);
}

function validate(d) {
  const missing = ["change", "checkpoint", "batches", "branch", "buildSha", "ckptKey", "gate", "sections"]
    .filter(key => d[key] === undefined || d[key] === "");
  if (missing.length) throw new Error(`sidecar is missing: ${missing.join(", ")}`);
  rejectControlCharacters(d, "sidecar");
  // The page refuses to run on an unfilled or malformed identity; fail here instead,
  // where the message can name the file, rather than shipping a page that stops the user.
  if (!/^[0-9a-fA-F]{40}$|^[0-9a-fA-F]{64}$/.test(d.buildSha)) {
    throw new Error(`buildSha must be a full 40- or 64-character Git object ID, got "${d.buildSha}"`);
  }
  // CKPT_KEY lands in four JS strings AND in a block comment, where no escaping saves
  // a stray `*/`; it is a storage key, so require one that is safe everywhere.
  if (typeof d.ckptKey !== "string") {
    throw new Error("ckptKey must be a nonempty string");
  }
  if (!/^[A-Za-z0-9._-]+$/.test(d.ckptKey)) {
    throw new Error(`ckptKey must be letters, digits, dot, dash or underscore, got "${d.ckptKey}"`);
  }
  if (!Array.isArray(d.sections) || !d.sections.length) throw new Error("sidecar has no sections");
  if (!Array.isArray(d.gate.checks) || !d.gate.checks.length) throw new Error("the step-0 gate has no checks");
  gateContainment(d.gate, d.buildSha);

  const seenSections = new Set(), seenSteps = new Map();
  for (const section of d.sections) {
    // Section and step numbers become DOM ids and storage keys, where `1` and `"1"`
    // are the same thing — so they must be real integers before uniqueness means
    // anything. Two steps the page cannot tell apart share one verdict.
    number(section.n, `section number ${JSON.stringify(section.n)}`);
    if (seenSections.has(section.n)) throw new Error(`section number ${section.n} is used twice`);
    seenSections.add(section.n);
    if (!Array.isArray(section.steps) || !section.steps.length) {
      throw new Error(`section ${section.n} has no steps`);
    }
    for (const step of section.steps) {
      number(step.n, `step number ${JSON.stringify(step.n)}`);
      if (seenSteps.has(step.n)) throw new Error(`step number ${step.n} is used twice (sections ${seenSteps.get(step.n)} and ${section.n})`);
      seenSteps.set(step.n, section.n);
      if (!step.do || !step.pass) throw new Error(`step ${step.n} needs both \`do\` and \`pass\``);
      if (step.revision !== undefined) number(step.revision, `step ${step.n}: revision ${JSON.stringify(step.revision)}`);
      if (step.pre) {
        if (!step.pre.stepRevision) throw new Error(`step ${step.n} carries agent evidence with no stepRevision`);
        // The page files evidence it cannot match as unknown provenance, which reads
        // as "run it again" — better to fail here than to ship a step that lies quietly.
        if (!/^[0-9a-fA-F]{7,64}$/.test(step.pre.sha || "")) {
          throw new Error(`step ${step.n}: pre.sha must be at least 7 hex characters, got "${step.pre.sha}"`);
        }
      }
    }
  }
  rejectDanglingReferences(d, seenSections, new Set(seenSteps.keys()));
  declareInputs(d);
  return d;
}

function validateReissue(current, previous, resetVerdicts) {
  const currentInputs = declareInputs(current), previousInputs = declareInputs(previous);
  compareInputHistory(currentInputs, previousInputs);
  if (current.checkpoint !== previous.checkpoint) {
    throw new Error("previous sidecar belongs to a different checkpoint");
  }
  if (current.ckptKey !== previous.ckptKey && !resetVerdicts) {
    throw new Error("ckptKey changed; keep it stable, or use --reset-verdicts for a user-requested clean sheet");
  }
  if (resetVerdicts && current.ckptKey === previous.ckptKey) {
    throw new Error("--reset-verdicts requires a new ckptKey");
  }

  const flatten = data => data.sections.flatMap(section =>
    section.steps.map(step => ({ step, section })));
  const before = flatten(previous), after = flatten(current);
  // The old sequence is a prefix, even across section boundaries. Adding to an
  // earlier section would insert work before already-issued steps, not append it.
  for (let i = 0; i < before.length; i++) {
    if (after[i]?.step.n !== before[i].step.n) {
      throw new Error(`existing step ${before[i].step.n} must keep its number and position; new steps append after all existing steps`);
    }
  }
  let highest = Math.max(...before.map(({ step }) => step.n));
  for (const { step } of after.slice(before.length)) {
    if (step.n <= highest) {
      throw new Error(`new step ${step.n} must append with a number greater than ${highest}`);
    }
    highest = step.n;
  }

  // Ignore evidence metadata: a new agent run does not change the instructions.
  // Include section context (need/order/lede/title/etc.), since changing a shared
  // prerequisite changes what every step in that section asks the user to test.
  const instructions = ({ step, section }) => {
    const { n, revision, pre, ...content } = step;
    const { n: sectionNumber, steps, ...context } = section;
    return { content, context };
  };
  for (let i = 0; i < before.length; i++) {
    const oldRevision = before[i].step.revision ?? 1;
    const newRevision = after[i].step.revision ?? 1;
    const n = before[i].step.n;
    if (newRevision < oldRevision) {
      throw new Error(`step ${n}: revision cannot decrease from ${oldRevision} to ${newRevision}`);
    }
    if (newRevision === oldRevision && (!isDeepStrictEqual(instructions(before[i]), instructions(after[i])) ||
        !isDeepStrictEqual(previousInputs.byStep.get(n), currentInputs.byStep.get(n)))) {
      throw new Error(`step ${n}: instructions or section context changed, or resolved inputs changed; increment revision above ${oldRevision}`);
    }
  }
}

function sameFile(left, right) {
  if (resolve(left) === resolve(right)) return true;
  if (!existsSync(left) || !existsSync(right)) return false;
  const a = statSync(left), b = statSync(right);
  return a.dev === b.dev && a.ino === b.ino;
}

if (isMain(import.meta.url)) {
  let args;
  try {
    args = parseArgs({ allowPositionals: true, options: {
      template: { type: "string", default: DEFAULT_TEMPLATE },
      previous: { type: "string" },
      "reset-verdicts": { type: "boolean", default: false }
    } });
    if (args.positionals.length !== 2) throw new Error("expected a sidecar and an output path");
  } catch (e) {
    console.error(e.message);
    console.error("usage: build-smoke-page.mjs <smoke-Cn.json> <smoke-Cn.html> [--previous <old.json>] [--template <path>] [--reset-verdicts]");
    process.exit(2);
  }
  const [sidecar, out] = args.positionals;
  const { template, previous, "reset-verdicts": resetVerdicts } = args.values;
  try {
    if (previous && sameFile(sidecar, previous)) {
      throw new Error("--previous must be a separate snapshot of the last issued sidecar, not the edited input");
    }
    for (const input of [sidecar, template, previous].filter(Boolean)) {
      if (sameFile(out, input)) throw new Error("output must not overwrite an input or the previous sidecar");
    }
    const data = JSON.parse(readFileSync(sidecar, "utf8"));
    const previousData = previous ? JSON.parse(readFileSync(previous, "utf8")) : undefined;
    const templateText = readFileSync(template, "utf8");
    const inputRoot = dirname(resolve(out));
    for (const artifact of declareInputs(data).artifacts.values()) {
      if (sameFile(out, resolve(inputRoot, artifact.path))) throw new Error("output must not overwrite an issued input artifact");
    }
    const html = buildSmokePage(data, templateText, {
      previous: previousData,
      resetVerdicts, inputRoot
    });
    if (existsSync(out)) {
      const existing = readFileSync(out, "utf8");
      // Git may normalize committed HTML to CRLF on checkout. That must not
      // invalidate its fingerprint or make an identical rebuild need a baseline.
      const sameHTML = (a, b) => a.replace(/\r\n/g, "\n") === b.replace(/\r\n/g, "\n");
      if (previous) {
        const fingerprint = existing.match(/\r?\n<!-- smoke-sidecar-sha256:([a-f0-9]{64}) -->\s*$/)?.[1];
        // Legacy pages have no stamp. Accept their baseline only if it reproduces
        // the old page exactly with the supplied template, before adding a stamp.
        const matches = fingerprint ? fingerprint === sidecarFingerprint(previousData)
          : sameHTML(existing + sidecarStamp(previousData), buildSmokePage(previousData, templateText, { inputRoot }));
        if (!matches) throw new Error("--previous does not match the last issued page; use its exact sidecar snapshot (and the original template for an unstamped page)");
      } else if (!sameHTML(existing, html) && !sameHTML(existing + sidecarStamp(data), html)) {
        throw new Error("reissuing an existing page requires --previous <last-issued.json>; identical rebuilds need no snapshot");
      }
    }
    writeFileSync(out, html);
    console.log(`${out}: ${html.length} bytes, every template slot filled`);
  } catch (e) {
    console.error(`${sidecar}: ${e.message}`);
    process.exit(1);
  }
}
