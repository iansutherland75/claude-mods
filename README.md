# claude-mods

Ian's Claude Code mods. The repo is a plugin marketplace called `ian-mods`, and each mod lives in its own folder under `mods/`.

| Mod | What it does |
| --- | --- |
| `prompt-upgrade` | `/better <prompt>` asks up to three quick questions, rewrites the prompt and shows the original and the rewrite side by side. Nothing runs until you press Run. `/better on` sends what you type to it first. |
| `work-report` | `/report` opens a pane with the tasks Claude finished for you and an estimate of the hours saved and what that time is worth, for today, the last 7 days, the last 30 days and the year. `/report settings` shows and changes the minutes per task and the hourly rate. Counts are kept per machine. |

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
