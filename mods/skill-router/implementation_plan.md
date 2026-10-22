# skill-router 0.2: conductor, agent routing, Fable review

Drafted 2026-10-21. Approved and built 2026-10-21. How it ended up: `system_architecture.md`.

Changes from this plan during the build:

- The rules are not added on `resume` or `fork`. Those carry the transcript, and adding them again doubled the rules (seen in a live test).
- Log writes take turns through one queue, because parallel agent spawns would overwrite each other's lines.
- An agent's line is written at spawn and gets its tokens when the agent's turn ends.

## What Ian asked for

Every Claude Code session works as a conductor. It splits a goal into tasks and hands the right ones to subagents. Jev picks the model each subagent runs on. When a turn produced real work, a Fable agent reviews it before the turn ends.

Ian's decisions (2026-10-21):

- Fable reviews only turns that changed files or produced a deliverable. Questions and lookups skip it.
- Enforcement is hard: a Stop hook keeps the turn open until the review has run.
- The conductor picks the agent's role. Jev picks its size, never above the session model.

## What the checks found

All three pieces have a hook in this build's mod engine (types from 2.1.304; the `claude` on PATH is 2.1.302, see Risks).

| Need | Hook | What it gives us |
|---|---|---|
| Pick a subagent's model | `agent.spawn` | Fires before the subagent's model is resolved. Carries `prompt`, `description`, `subagentType`, `parentModel` and the call's own `model`. A hook sets `model` to choose. Ignored for forks, which always inherit. |
| Block the turn until review | `classic.Stop` | Fires whether or not a settings hook exists. Returning `{ block: reason }` re-prompts the model with the reason. `e.stop_hook_active` says the model is already continuing because of a Stop hook, so we never loop. `e.background_tasks` lists work still running. |
| Add the conductor rules | `classic.SessionStart` | Returns `additionalContext`. Fires on startup, resume and after compaction, so the rules survive a compact. Main session only. |
| Know a turn did real work | `tool.call` | Sees Edit, Write, NotebookEdit and Artifact calls in the main loop and in subagents (`agentId`). |
| A Fable reviewer | plugin `agents/*.md` | A plugin folder's agent files register as `skill-router:<name>`. The Agent tool's model aliases include `fable`, so `model: fable` is valid. The `agent.spawn` hook also forces Fable for this one agent as a backstop. |

`prompt.compose` was the other option for the rules. Its input has no `agentId`, so the rules could leak into subagent prompts and make subagents spawn their own agents. `classic.SessionStart` avoids that.

`turn.step` sees subagent steps too, but it fires on every request inside the subagent and has no task text. `agent.spawn` fires once per subagent with the brief in hand, which is what Jev needs.

## Design

### 1. Conductor rules (`hooks/conductor.ts`, added at session start)

About 300 tokens, given to the main session at startup and again after each compaction. The draft:

> You are the conductor for this session. Split the goal into tasks and decide where each runs.
>
> Hand a task to a subagent when one of these is true:
> - Two or more pieces of work can run at the same time and do not depend on each other. Launch them in one message.
> - A search covers many files or repos and only the conclusion matters. Use Explore.
> - The task needs a design before code. Use Plan.
> - A draft in Ian's voice is finished. Use voice-check.
>
> Do the work yourself when it is a question, a lookup, an edit to one or two files, or anything a few tool calls settle. A subagent rebuilds its context from scratch, so small jobs cost more and run slower when handed off.
>
> Never let two agents edit the same files. Brief each agent with the goal, the files, what done looks like and the shape of the answer you want back.
>
> Do not set `model` on Agent calls. skill-router picks the size.
>
> When a turn changes files or produces a deliverable, run `skill-router:final-review` before you finish. Brief it with Ian's request and what changed. Fix what it marks FIX, or tell Ian why you did not. If the deliverable came from a Bash command, run the review anyway: the Stop hook cannot see Bash writes.

The final text gets an em dash and AI-tell check before it ships.

### 2. Agent routing (`agent.spawn`)

For each spawn, in order:

1. **Skip**, logged as `kept`: forks (the model is ignored), workflow agents (their prompt is a placeholder), `claude-code-guide` and `statusline-setup` (built-ins with their own model choice).
2. **Pin**: `skill-router:final-review` always runs on Fable.
3. **Explicit model**: if the conductor set `model` anyway, keep it but clamp it to the session tier (down only). Logged as `explicit`.
4. **Jev**: ask the Decisions API (the same `~typesafe/jev-latest` call skill-router makes now) with the agent type, its short description and the first 1,500 characters of its brief. The options are the tiers at or below the session's. If the picked option's probability is 0.5 or higher, set `model` to that tier. Below 0.5, or if Jev fails, the agent inherits the session model.

Criteria Jev reads for agents:

- **haiku**: searching and reading files, lookups, listing, formatting, filing. No edits that need judgment.
- **sonnet**: code or doc edits in a few files with a clear brief; moderate judgment.
- **opus**: design across many files, hard judgment calls, debugging with no clear cause, or copy in Ian's voice that will be published.

**Fable sessions.** For agent routing, Fable ranks above Opus, so under a Fable session Jev picks from Haiku, Sonnet and Opus. Skill routing on a Fable session stays as it is now (never routed). That is a separate change if Ian wants it.

**Cold cache.** A subagent starts with an empty context whatever its model, so this routing doesn't pay the cold-cache cost the skill switches show.

### 3. Fable final review

**The agent** (`agents/final-review.md`): `model: fable`, tools Read, Grep, Glob, Bash. It is told to use Bash only to read (`git diff`, `git status`, a test or build command the project already defines) and never to write, commit or push. It returns:

- `PASS` or `FIX` on the first line.
- Up to 10 findings, most severe first, each with `file:line`, what is wrong and what would fix it.
- Whether the work did what Ian asked, in one sentence.
- For writing in Ian's voice: whether voice-check ran. It does not redo voice-check's scan.

**The gate** (module state, reset on each new prompt from Ian):

- `touched`: an Edit, Write or NotebookEdit call succeeded, or an Artifact publish succeeded, in the main loop or any subagent, since the prompt.
- `reviewed`: a `skill-router:final-review` agent was spawned after the last `touched`.

On `classic.Stop`:

| Condition | Result |
|---|---|
| Review switched off (`/skill-router review off`) | Let it stop |
| `stop_hook_active` is true | Let it stop, log `review skipped` if still unreviewed. This caps the forced review at one per prompt, so a FIX followed by more edits does not trigger a second Fable run. |
| `background_tasks` is not empty | Let it stop. The session is waiting on work, not finished. |
| `touched` and not `reviewed` | `{ block: "Run skill-router:final-review on this turn's work before you finish. Brief it with Ian's request and the files that changed." }` |
| Otherwise | Let it stop |

**Known gap.** Files written by Bash (`sed -i`, a heredoc, a build script) don't set `touched`. A Bash command can't be reliably told apart as a read or a write. The conductor rules cover it by telling the session to run the review anyway.

### 4. Log and command

- `LogEntry` gains `kind: 'skill' | 'agent' | 'review'` and `agentType`. Old entries without `kind` read as `skill`.
- A review entry records the verdict (`PASS` or `FIX`, read from the answer's first line), its time and its tokens from `turn.complete` (`agentId` matches the review's spawn).
- `/skill-router log` shows all three kinds. The summary splits them and adds the total review tokens, so Ian can see what Fable costs after a week.
- New words: `/skill-router review on|off` and `/skill-router agents on|off`. The existing `on|off` keeps covering skill routing.

## Files

The mod stays named skill-router, so both machines keep the install they have. A rename means reinstalling on Kermit and Gonzo for no gain.

- `[MODIFY] hooks/logic.ts`: agent tiers and criteria, `agentJevRequest`, `decideAgent`, the agent skip and pin lists, Fable's rank for agents, `stopDecision` (the table above as a pure function), `LogEntry.kind`, `logLine`, `summary`.
- `[MODIFY] hooks/register.ts`: hooks for `agent.spawn`, `tool.call` (tracking only, always `next`), `classic.Stop`, `classic.SessionStart`, the `turn.complete` review entry, the reset in `prompt.submit`, the new command words.
- `[NEW] hooks/conductor.ts`: the rules text.
- `[NEW] agents/final-review.md`: the reviewer.
- `[MODIFY] tests/skill-router.test.ts`: `decideAgent` (skip, pin, explicit clamp, Jev above and below 0.5, Fable session), `stopDecision` (every row of the table), old log entries without `kind`.
- `[MODIFY] .claude-plugin/plugin.json`: version 0.2.0 and a new description.
- `[MODIFY] system_architecture.md`, `../../README.md`, `../../.claude-plugin/marketplace.json`: the new pieces and commands.

## Verify before calling it done

1. `claude plugin validate`, `tsc -p` and `claude plugin test` on the mod, all clean.
2. Headless `claude -p --plugin-dir` on a Sonnet session, as with 0.1:
   - A prompt that needs a wide search: an Explore agent spawns and the log shows a Jev pick with `kind: agent`.
   - A prompt that edits a scratch file in the scratchpad: Stop blocks once, `final-review` runs on Fable, and the log shows `kind: review` with a verdict.
   - A question-only prompt: no block, no review.
   - A second stop after a FIX: no second review (`stop_hook_active`).
3. In the desktop app: the rules show up at session start and are still there after `/compact`.
4. Check the hooks exist on 2.1.302, the `claude` on PATH that the headless tests use. If `agent.spawn` is missing there, update the CLI first.

## Risks and costs

- **Fable cost.** One Fable run per working prompt. Its size depends on the diff. The log measures it. After a week, decide whether small diffs (one file, under ~20 lines) should skip review.
- **Jev latency.** About 400 ms per subagent spawn, about $0.00002 each. Parallel spawns ask Jev in parallel.
- **Over-delegation.** The rules can only persuade. If sessions start handing off small jobs, tighten the thresholds in `conductor.ts`. The log shows how many agents each prompt spawned.
- **Clash with antigravity.** Antigravity's Mode C (plan, halt, execute) still applies. The conductor decides who does each step, not whether to plan.
- **Version skew.** The types are from 2.1.304 and the CLI on PATH is 2.1.302. Verify step 4 covers it.

## After the build

- Push claude-mods. On Kermit: `claude plugin update skill-router@ian-mods`.
- Gonzo: `git pull` in `~/claude-mods`, install the plugin, and add the OpenRouter key to its Keychain. Gonzo doesn't have 0.1 yet.
- Add a dated entry to ClaudeCowork `memory.md` and update the skill-router line in the dev root `CLAUDE.md` project list if Ian wants it there.
