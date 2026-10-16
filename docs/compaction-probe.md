# compaction-probe: can a mod drive compaction?

`compaction-probe` was a throwaway Claude Code plugin. It built nothing: it ran one experiment in
a desktop session the user was willing to lose and wrote down what Claude Code did, so that whether
to build safe-point compaction could be decided on evidence. This page records that run.

## What it answers, and why

When the probe ran, the orchestrator compacted only at a safe point, and only by hand: the
conductor estimated its context ("about 300K"), started a 10-minute timer and compacted if you
typed `/compact` in time. A mod
could do each part itself: read the exact size from `$.session.usage()`, check that no agent is
running with `$.agent.list()`, call `$.session.compact()` from a `turn.complete` hook, add the
ledger's keep-list and reboot duty to every compaction through a `session.compact` hook, and
resubmit the next prompt with `$.prompt.submit({ text, asUser: true })`. The alternative skips the
summary: at the safe point the mod runs `/clear`, then the skill's own command, both through
`$.command.run`, and the fresh conversation boots from the ledger. Nobody had tried those calls
from those hooks in the desktop app; the probe did.

| Key | Question | `yes` when |
|---|---|---|
| `q1` | Can a mod compact the main conversation from a command? | the `compact` step's `$.session.compact({ instructions })` resolves to a compaction (messages, no skip) |
| `q2` | Can a mod compact at the end of a main-loop turn, the safe-point trigger? | the call made inside the main loop's `turn.complete` compacts; `yes (deferred)` when it rejects and only the one retry, 2 seconds later from a timer, compacts |
| `q3` | Does a `session.compact` hook see who compacts, and can it add to what the summary keeps? | for a `manual` (`/compact`) and a `plugin` compaction the hook saw the trigger, added a marker line with a token minted for that compaction, and the token appears in the compacted conversation though it was not in the transcript before; the probe's own compactions never reaching its hook make the `plugin` half a `no` |
| `q4` | After a mod compaction, does `$.prompt.submit({ text, asUser: true })` start a turn? | after `q2`'s compaction a main-loop turn starts within 120 seconds and its answer contains `RESUMED` |
| `q5` | Is `$.session.usage().context.tokens` the real context size? | at every reading where it is present it is within 1% of the last main-loop request's input, cache-read and cache-write tokens; readings where it is absent are recorded, not compared |
| `q6` | Does `$.agent.list()` tell a running background agent from a finished one? | one `agents` reading shows the agent `running` and a later one shows it `completed`, `failed` or `killed`, or no longer lists it |
| `q7` | Can a mod run `/clear`, and does it see the cleared session start? | the `clear` step's `/clear` run resolves and a SessionStart with source `clear` follows it |
| `q8` | After a mod compaction, does a slash command the mod then runs start the skill? | once the `resume-skill` step's compaction has compacted, the step runs `/orchestrate status`, and the orchestrate skill starts in the next main-loop turn |
| `q9` | After a mod `/clear`, does a command the mod then runs start the skill in the fresh conversation? | once the `/clear` run resolved, the `clear` step runs `/orchestrate status`, and the orchestrate skill starts in the next main-loop turn |

Each answer is `yes`, `no — <what was observed>` or `not run`, with the raw observations beside it
(times, token counts, triggers, statuses, error messages). A `no` is a finding as much as a `yes`:
the probe records, it does not judge. A call Claude Code refuses is a `no` carrying the refusal.

The `compact` and `resume-skill` steps called from a half-second timer, because Claude Code refuses
`$.session.compact` inside a command's own hook; `clear` did the same for `/clear`.

## Findings

The run of 2026-10-09, in the Claude desktop app on Linux, Claude Code 2.1.293, printed these
nine lines, verbatim:

```text
q1: no — rejected: compaction-probe: $.session.compact: not available in a headless (-p / SDK) session yet: compaction here runs inside a turn (a /compact prompt); catch it and carry on
q2: no — in turn.complete: rejected: compaction-probe: $.session.compact: not available in a headless (-p / SDK) session yet: compaction here runs inside a turn (a /compact prompt); catch it and carry on; retry from the timer: rejected: compaction-probe: $.session.compact: not available in a headless (-p / SDK) session yet: compaction here runs inside a turn (a /compact prompt); catch it and carry on
q3: not run
q4: not run
q5: yes
q6: no — no agent was seen running (no agents listed)
q7: yes
q8: no — the compaction rejected: compaction-probe: $.session.compact: not available in a headless (-p / SDK) session yet: compaction here runs inside a turn (a /compact prompt); catch it and carry on
q9: yes
```

What they say:

- A mod cannot compact a desktop session. Every `$.session.compact` call, from the command's timer,
  inside `turn.complete` and from the retry timer, was refused as "not available in a headless
  (-p / SDK) session", so `q1`, `q2` and `q8` are `no`, and `q4`, which needs a mod compaction,
  never ran.
- A manual `/compact` does reach a mod's `session.compact` hook, and a marker line added there
  survives the summary: the findings file recorded the `manual` compaction with the probe's token
  found after it (78263 → 7918 tokens). That is the manual half of `q3`; the `plugin` half never
  ran, so the report printed `not run`.
- `$.session.usage().context.tokens` was within 1% of the last main-loop request's input,
  cache-read and cache-write tokens at every reading the probe could compare (`q5`): two, both
  exactly 76622. The reading at `start`, taken before the probe had seen a request, was not compared.
- `q6` is inconclusive: its one reading listed no agent at all, so it never saw a running one.
- A mod can run `/clear`, sees the cleared session start, and a `/orchestrate status` it runs
  afterwards starts the skill in the fresh conversation (`q7`, `q9`). Clear-and-continue, not
  compaction, is the route forward.

The probe was removed after this run. Its source stays in this repository's own history at the
merge `2e08885`, which published snapshots do not carry; in a clone that has it,
`git show 2e08885:experiments/compaction-probe/hooks/register.js` prints its hooks module.

## Remove it

If you installed the probe, delete `~/.claude/compaction-probe/` and take its directory out of
`env.CLAUDE_CODE_PLUGIN_DIRS` in `~/.claude/settings.json`, keeping any other entry (remove the key
if it was the only one). Leave `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS` set while `orchestrate-mod`
uses it. The findings stay in `~/.claude/compaction-probe-findings/`.

## Not covered

The `auto` trigger, Claude Code compacting on its own near the 1M context ceiling, was not
exercised, so BL-050's automatic case stays untested.
