# Allmind: instructions for AI agents
The code map, working rules, build/release steps and lessons are in [CLAUDE.md](CLAUDE.md); read it first (it applies to every agent, not only Claude).

Two rules worth repeating:
- **Allmind stays standalone.** It must run without Xylem and without the AI assistant, and must not depend on beta features (details in CLAUDE.md, "Working rules").
- **Keep the vault in sync.** When Allmind changes, update the owner's Obsidian vault in the same session.

## Obsidian vault
The owner keeps project context in an Obsidian vault.
- Rules for all agents: %USERPROFILE%\Documents\Obsidian Vault\AGENTS.md
- This project's notes: %USERPROFILE%\Documents\Obsidian Vault\Projects\Allmind\Allmind Overview.md (hub: `Areas\Streaming Megaproject.md`)
- At session start, read the rules and this project's overview note. When Allmind changes, or when the owner says "wrap up", follow the vault's `AGENTS.md` ("Code changes must reach the vault" and the wrap-up steps).
- If that path doesn't exist (a cloud session without the owner's PC), clone the private repo `Hoshia05/Kidian` if you have access and follow its `AGENTS.md`; if you can't reach it, say so in your final message and give a ready-to-paste summary (version, what changed, decisions, untested items) instead of skipping it.
