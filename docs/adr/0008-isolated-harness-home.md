# ADR 0008: Isolated Harness Home and per-Bot cwd

## Status
Accepted

## Context
ADR 0005 put the Harness on the host OS and reused `~/.codex` (and friends) for login. That also loads the user's global AGENTS.md, hooks, plugins, and MCP, so a Bot is not an OpenBot Bot. Spawn-time swapping of one shared `config.toml` was a bandage: Codex, Grok, and Kimi all want that filename with different schemas.

ADR 0007 made Workspace the single ACP cwd for every Bot. Then a This-Bot AGENTS.md cannot be a real project file. Vendors walk cwd to the git root. They do not care where the CLI binary lives.

## Decision
Isolated is the Computer default, override per Bot. Talk sets `CODEX_HOME` / `CLAUDE_CONFIG_DIR` / `GROK_HOME` / `KIMI_CODE_HOME` to Harness Home on the Computer. Host mode unsets those and uses the user's real vendor home.

Harness Home is one vendor dir plus Computer `shared/`. Skills, plugins, hook scripts, and `OPENBOT.md` live in `shared/` and symlink into each Isolated home. `config.toml` / Claude `settings.json` stay native files in the vendor dir. Auth is a host-login symlink or API key so the user is not asked twice. Do not symlink sessions or logs.

`OPENBOT.md` is the locked product file (Isolated user-level instructions). All Bots is `Workspace/AGENTS.md`. This Bot is `Workspace/bots/<id>/AGENTS.md`. Session cwd is that Bot directory. `CLAUDE.md` is a symlink to the same file at that layer. Grok Isolated home gets `AGENTS.md` only, not both names.

The Workspace jail is the shared drop plus every Bot directory. Every Bot may read and write that tree. Paths on the host PC outside Workspace need a Host grant.

This supersedes ADR 0007's "there is no per-Bot cwd" and ADR 0005's implication that the only vendor home is `~/.codex`.

## Consequences
A Bot in Isolated does not inherit the user's global Codex/Claude/Grok/Kimi config. A Bot in Host does. Both still see Workspace AGENTS.md because cwd is under Workspace. Ada's rules and Ben's rules can differ. Empty Workspace still loads `OPENBOT.md` when Isolated.
