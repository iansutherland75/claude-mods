# claude-mods

Ian's Claude Code mods. The repo is a plugin marketplace called `ian-mods`, and each mod lives in its own folder under `mods/`.

| Mod | What it does |
| --- | --- |
| `prompt-upgrade` | `/better <prompt>` asks up to three quick questions, rewrites the prompt and shows the original and the rewrite side by side. Nothing runs until you press Run. `/better on` sends what you type to it first. |
| `work-report` | `/report` opens a pane with the tasks Claude finished for you and an estimate of the hours saved and what that time is worth, for today, the last 7 days, the last 30 days and the year. `/report settings` shows and changes the minutes per task and the hourly rate. `/report backfill` fills in past days from this machine's session history (needs Python 3: `/usr/bin/python3` on a Mac, `py` or `python` on Windows). Building software is estimated from the lines of code written (`/report settings buildrate 25`), and a By project section shows hours per repo. `/report add "QBR builder" 160 2026-05-01` adds hours for older work (`/report list`, `/report remove 1`). Counts are kept per machine. |
| `skill-router` | Runs each skill and subagent on the right size of model, and has Fable check the finished work. Simple fixed-step skills (docket, schedule, loop, keybindings-help, consolidate-memory) always run on Haiku. For the rest, Jev (TypeSafe's decision model on OpenRouter) picks Haiku, Sonnet or Opus, never above the session model, and the session model comes back on your next prompt. Every subagent gets the same treatment: the session picks the agent's role, Jev picks its size. Each session starts with conductor rules: when to hand work to subagents and when to do it inline. When a turn changed files (Edit, Write, NotebookEdit or an Artifact publish), a Stop hook keeps it going until the `final-review` agent has checked the work on Fable and answered PASS or FIX. It asks once per prompt: edits made after that review end without a second one (logged as `review skipped`). Files written by Bash don't trigger it. While subagents run, a band above the chat box shows one row per agent: a dot and chip in the model colour (Haiku green, Sonnet blue, Opus purple, Fable gold), the agent and its task, a thin progress bar, and what it is doing. The bar fills by tool calls against the usual count for that agent type and holds at 90% until the agent finishes. Finished rows clear on your next typed message, and the band goes with them. The band's `[-]` collapses it. `/skill-router pane` opens the full cards beside the chat, which also show how the model was chosen (what Jev was offered, its pick, how sure it was and how long it took). `/skill-router view band`, `view pane` or `view off` picks where agents show by themselves. Each pick and review is logged with its time, cost and tokens. `/skill-router log`, `/skill-router off`/`on` (skills), `/skill-router agents off`/`on`, `/skill-router review off`/`on`. Needs an OpenRouter key in the `OPENROUTER_API_KEY` environment variable or in the login Keychain (see below). |

## Set up a machine

The clone lives at `~/claude-mods` on every machine. Install each mod once per machine at user scope. After that it loads in every local session: the desktop app's Code tab and the terminal.

```bash
git clone https://github.com/iansutherland75/claude-mods.git ~/claude-mods
```

```bash
claude plugin marketplace add ~/claude-mods
```

```bash
claude plugin install prompt-upgrade@ian-mods --scope user
```

```bash
claude plugin install work-report@ian-mods --scope user
```

```bash
claude plugin install skill-router@ian-mods --scope user
```

skill-router reads its OpenRouter key from the login Keychain. Copy the key, then run this once per machine. It never shows the key:

```bash
security add-generic-password -U -a "$USER" -s OPENROUTER_API_KEY -w "$(pbpaste)"
```

Run these with Claude Code 2.1.295 or newer. If `claude --version` shows an older build, run `brew upgrade claude-code` first.

## Keep machines in step

The marketplace is a local folder, so sessions read each mod straight from `~/claude-mods`. Nothing needs reinstalling after a change.

1. `git pull` in `~/claude-mods`.
2. Run `/reload-plugins` in any open session. New sessions pick it up on their own.

A new mod needs one extra step on each machine: `claude plugin install <mod>@ian-mods --scope user`.

## Add a mod

1. Put it in `mods/<mod-name>/` with its `.claude-plugin/plugin.json`, `hooks/` and tests.
2. Add an entry to `.claude-plugin/marketplace.json` with `"source": "./mods/<mod-name>"`.
3. Check it: `claude plugin validate mods/<mod-name>` and `claude plugin test mods/<mod-name>`.
4. Commit, push, then install it on each machine.

## Not covered

Cloud sessions (claude.ai/code, cloud Cowork) do not see mods installed on a machine.
