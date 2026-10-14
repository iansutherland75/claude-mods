# claude-mods

Ian's Claude Code mods, kept as a plugin marketplace (`ian-mods`) in his personal GitHub (iansutherland75/claude-mods, public since 2026-10-14). The clone is at `~/claude-mods` on both machines (Gonzo and Kermit), and each mod is installed from it at user scope, so it loads in every local session.

## Rules

- One folder per mod under `mods/`. List every mod in `.claude-plugin/marketplace.json` with `"source": "./mods/<name>"`.
- The plugin-authoring skill writes a new mod into a per-session folder under `~/.claude/dev-mods/`. Once it is finished, move it here, add it to the marketplace, validate and test it, commit, push, and give Ian the install line for each machine.
- Validate and test with Claude Code 2.1.295 or newer. The Homebrew `claude` on Gonzo was 2.1.260 on 2026-10-14 and wrongly refuses valid hooks (`ui.close`, `$` passed to `update`).
- Never write files inside a mod's folder at run time. Mods keep data in `$.store`.
- Commit as `5667167+iansutherland75@users.noreply.github.com` (set in this clone's git config), never the Gmail: the repo is public. The history was rewritten on 2026-10-14 to remove the Gmail.
- Git workflow as in the dev root: pull before working, push before stopping, prompt Ian for both.
