# skill-router: how it is built

- **Trigger.** `skill.prompt` fires for a skill run by the Skill tool and for a typed `/skill`. It decides the model there, before the skill's body reaches the model.
- **Switch.** `turn.step` rewrites `model` on each main-loop request for the rest of the turn. Subagent steps (`agentId` set) are left alone. `prompt.submit` clears the pick, so the session model comes back on the next prompt, which matches SKILL.md `model:`.
- **Why not SKILL.md `model:`.** Most skills come from vendor installers or claude.ai sync, where local edits are lost or impossible. One pin list in `hooks/logic.ts` covers every source.
- **Jev.** This uses the Decisions API (`/api/alpha/decisions`, `~typesafe/jev-latest`) with one `choice` question, not `typesafe/jev-router`. The router runs the prompt on any vendor's model, which Claude Code can't use. Options are cut to the session tier and below (down only). The gate is the picked option's probability (≥ 0.5), not Jev's `confidence`, which reads low even on clear calls. A session model that `hooks/logic.ts` doesn't rank (fable, for now) is never routed. Pins still apply.
- **Key.** `$.env.get('OPENROUTER_API_KEY')` first, then `security find-generic-password -s OPENROUTER_API_KEY -w` through `$.process.run`. Only a found key is cached.
- **State.** The pick for the current turn is a module variable. A reload mid-turn drops it, and the turn finishes on the session model. The on/off switch and the log (the last 1,000 picks) are in `$.store` under `enabled` and `log`.
- **Known cost.** A switch starts the new model with a cold prompt cache. The log's `in` tokens include cache reads and writes, so the cost of a switch shows up there.
- **Built and live-tested 2026-10-21** on Claude Code 2.1.302 with headless `--plugin-dir` runs. A pin moved Sonnet to Haiku. On the Jev path, Jev picked Haiku for `claude-api` at p 0.99 in 398 ms, for $0.000017.
