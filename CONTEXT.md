# CONTEXT.md

Glossary only. No implementation.

## OpenBot
Self-hosted Grok Bot. Named Bots on one Computer. MIT. Repo `toolboxmd/openbot`.

## Computer
One Linux desktop per instance (Docker Screen). Shared files and browser cookie jar. Not a security boundary per Bot. Harness CLI logins live on the host OS, not inside Screen.

## Bot
A named teammate with a profile (name, title, description, Eyes, Harness) and its own Screen. Persistent. N tasks, N Bots can be active at once. Messaging does not start XFCE.

## Screen
Private XFCE desktop for one Bot. Other Bots cannot see its windows. Watch via KasmVNC. Takeover for 2FA. Starts when the user opens Computer for that Bot (cold start). Several Screens may be Up at once.

## Active Bot
A Bot whose Screen is currently running. RAM and CPU count per Screen that is Up, not per sidebar row. Do not serialize to one Active Bot.

## Sleep
Automatic RAM trick for an idle Screen: `docker stop`, volumes kept. Does not kill that Bot's Harness (ACP) child, so chat stays instant. Default: 20 minutes unused Computer (`OPENBOT_SCREEN_IDLE_MS`). No user-facing Wake. Opening Computer starts that Screen again.

## Harness
The coding agent CLI already on the host OS (Codex, Claude Code, Grok Build, or Kimi Code) over ACP. The picker shows what is on PATH. The process runs beside Screen, not inside XFCE. The user does not watch its terminal. Files are a host folder also mounted on Screen. Vendor login is that host CLI home. Takeover is for site 2FA.

## PinchTab
Headed Chrome driver on the Screen's DISPLAY. Default browser hands. Not Playwright.

## Takeover
User drives the Screen for password, 2FA, captcha, or payment. Never paste secrets in chat. Not used for Harness CLI login.

## Eyes
Code-drawn robot face (color + shape). States: idle, thinking, working, needs-you, asleep, waking. Sleep means the Screen is down (optional dim), not a locked chat. Sidebar click still opens chat.

## Tunnel
User-provided Cloudflare tunnel so the PWA is reachable from a phone.

## Password
Single shared secret that locks the PWA. Cookie after first entry.

## Arena
Parked. Public Twitch-plays demo. Not v1.
