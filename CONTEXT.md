# CONTEXT.md

Glossary only. No implementation.

## OpenBot
Self-hosted Grok Bot. Named Bots on one Computer. MIT. Repo `toolboxmd/openbot`.

## Home
The private OpenBot state tree. It contains durable Talk state and the shared Workspace. A wipe of Home is the wipe. Bots do not receive Home itself.

## Workspace
The Computer jail inside Home. A shared drop plus every Bot directory. Every Bot may read and write the whole Workspace without a Host grant. Mounted on Screen. Distinct from Talk's private Home state.

## Channel
A persistent conversation with members. A direct Channel is you plus one Bot and is born with that Bot. Group and Bot-to-Bot are other Channel kinds. The Channel owns its Transcript. The Bot owns its Harness.

## Transcript
The human-facing messages, Cards, receipts, replies, reactions, and attachments in a Channel. Harness logs are not the Transcript.

## Session
One live Harness conversation for one Bot in one Channel. A Bot may run several Sessions at once. ACP `cwd` is that Bot's directory under Workspace.

## Computer
One Linux desktop per instance (one Docker Screen container). Shared Workspace and browser cookie jar. Not a security boundary per Bot. Harness CLI logins live on the host OS, not inside Screen. The Computer pane is always a live desktop. It is never a down / "Screen is down" gate.

## Bot
A named teammate with a profile (name, title, description, Eyes, Harness, Isolated or Host) and its own Screen (a display on the Computer). Persistent.

## Screen
Private XFCE display for one Bot, as an extra Kasm session inside the one Computer container. Other Bots cannot see its windows. Watch via KasmVNC. Zooming the Computer preview is write (2FA lives there). Not a second Debian.

## Active Bot
A Bot the user is talking to. RAM and CPU count per Computer plus per lit display, not per extra container.

## Sleep
Not a user-visible down pane. Do not docker-stop the Computer. Displays stay lit. The Computer stays up.

## Harness
The coding agent CLI already on the host OS (Codex, Claude Code, Grok Build, or Kimi Code) over ACP. The picker shows what is on PATH. The process runs beside Screen, not inside XFCE. The user does not watch its terminal. Session cwd is that Bot's directory under Workspace. Vendor login is reused from the host CLI (auth file or keychain symlink only). Config mode is Isolated or Host. Zoom (not a Takeover button) is for site 2FA. Zoom does not pause Sessions. Ask the Bot to stop if two pointers fight.

## Isolated
Config mode. Talk sets the vendor home env (`CODEX_HOME`, `CLAUDE_CONFIG_DIR`, `GROK_HOME`, `KIMI_CODE_HOME`) to Harness Home on the Computer. Unix ~ is This Bot's directory. The Bot does not load the user's global AGENTS.md, hooks, plugins, MCP, or the host `$HOME/.agents`. Auth is still the host login. Computer default. Override per Bot.

## Host
Config mode. Unset those env vars. Unix ~ is the host home. The Harness uses the user's real `~/.codex` (and friends). `OPENBOT.md` is not injected. Workspace AGENTS.md files still load because they live in cwd.

## Harness Home
On the Computer, not inside `~/.codex`. One vendor dir each (`harness/codex`, `claude`, `grok`, `kimi`) plus Computer `shared/` (skills, plugins, hook scripts). Isolated homes keep native `config.toml` / Claude `settings.json`. Shared content is a symlink into `shared/`. Do not symlink auth, sessions, or logs. Auth is a host-login symlink. Only link the vendor filename that Harness reads (Grok gets `AGENTS.md` only, not also `CLAUDE.md`).

## OPENBOT.md
Locked product file in `shared/`. Isolated user-level instructions. Users do not edit it. User-facing editors are All Bots and This Bot only.

## AGENTS.md
Two user files. All Bots: `Workspace/AGENTS.md`. This Bot: `Workspace/bots/<id>/AGENTS.md` (that Bot's cwd). `CLAUDE.md` at that layer is a symlink to the same file. Vendors walk cwd to project root, so both layers load. Isolated also loads `OPENBOT.md` from Harness Home. Launch path of the CLI does not matter; ACP Session cwd does.

## PinchTab
Headed Chrome driver on the Screen's DISPLAY. Default browser hands. Not Playwright. One bridge per Bot Screen (one Chrome). Talk injects stock `pinchtab mcp --server` and allowlists the browse loop plus screenshot. Not a custom MCP. Cookie sharing is the Computer cookie jar (copy on Screen start/stop), not `pinchtab_cookies`. Open web. IDPI wrap and scan stay on. Page text is untrusted. If PinchTab is down, fail closed: no host Chrome, no Playwright. Captcha: screenshot and clicks first; if that fails, Open computer. No auto-solver.

## IDPI
PinchTab Indirect Prompt Injection defense. wrapContent frames snapshot and get_text as untrusted page data. scanContent looks for injection patterns. Stays on when browsing the open web.

## Host grant
Permission to read or read-write paths on the host PC outside the Workspace jail. The Harness already runs on the host OS; the jail is the folder. The card offers Read, Read and write, or Deny, and asks duration (once / this Session / until revoked). Store what they pick. One grant is Computer-wide. Isolated Harness Home is inside the jail. Open computer is Screen 2FA, not this card.

## Takeover
There is no Takeover button on the Computer pane. Zooming or opening the Computer preview is already write and does not pause Sessions. In chat, a needs-you Computer card says it needs you; its action is **Open computer** (same as zoom). Not a second mode. User drives the Screen for password, 2FA, captcha, or payment. Never paste secrets in chat. Not used for Harness CLI login.

## Open computer
The primary action on a needs-you Computer card. Opens that Bot's Computer (already write). Same as clicking the preview. Captcha fallback after PinchTab screenshot and clicks fail.

## Waiting for you
Sidebar state when a Bot needs the user (orange). Pairs with an in-thread Computer card: **Action needed**, thumbnail of the blocker, **Open computer** / **I'm done** / **Skip**. I'm done = resume the Bot. Skip = stop waiting. Both stay on the card until clicked. Done and Skip remain in history (green Done / skipped), with Open computer still available.

## Working
While a Bot is writing: Eyes animate in the thread (three-dot / moving). Hover on that Eyes shows `{name} is working`. Not a chat bubble and not a strip that stays on screen. Idle: no working copy, animation gone.

## Card
A transcript item that is not a text bubble: screenshot, file chip, widget, Computer needs-you / Done, Host grant. Human-facing. Never a dump of tool JSON or ACP logs.

## Turn
One user send. The Bot may reply with several short bubbles (each ACP message / messageId is one bubble). The PWA does not split a long string. Tone is a few sentences, like a person. Markdown essays and tool transcripts are capped out of chat. Screenshots and files attach when they help, not as a default dump.

## Eyes
Code-drawn robot face (color + shape). States: idle, thinking, working, needs-you, asleep.

## Tunnel
User-provided Cloudflare tunnel so the PWA is reachable from a phone.

## Password
Single shared secret that locks the PWA. Cookie after first entry. Default `openbot`.

## Arena
Parked. Public Twitch-plays demo. Not v1.
