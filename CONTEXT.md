# CONTEXT.md

Glossary only. No implementation.

## OpenBot
Self-hosted Grok Bot. Named Bots on one Computer. MIT. Repo `toolboxmd/openbot`.

## Computer
One Linux desktop per install. Shared files and browser cookie jar. Not a security boundary per Bot. N screens (displays) live on it, not N containers. Harness CLI logins live on the host OS, not inside Screen.

## Bot
A named teammate with a profile (name, title, description, Eyes, Harness) and its own Screen. Persistent. Chat does not require a running display.

## Screen
Private display for one Bot on the shared Computer. Other Bots cannot see its windows. Watch via KasmVNC. Zooming the Computer preview is write.

## Active Bot
A Bot the user can message. Chat is always-on. A display is up only while that Bot is using the desktop or the user is zoomed on it.

## Sleep
Tear down an idle display so it stops costing RAM. The Computer stays. Talk stays. A Bot still using the desktop keeps its display.

## Harness
The coding agent CLI already on the host OS (Codex, Claude Code, Grok Build, or Kimi Code) over ACP. The picker shows what is on PATH. The process runs beside Screen, not inside XFCE. The user does not watch its terminal. Files are a host folder also mounted on Screen. Vendor login is that host CLI home. Zoomed Screen is for site 2FA.

## PinchTab
Headed Chrome driver on the Screen's DISPLAY. Default browser hands. Not Playwright.

## Takeover
Zooming or opening Computer is already write. No button. That Bot's desktop control pauses until zoom closes. Never paste secrets in chat. Not used for Harness CLI login.

## Eyes
Code-drawn robot face (color + shape). States: idle, thinking, working, needs-you, asleep.

## Tunnel
User-provided Cloudflare tunnel so the PWA is reachable from a phone.

## Password
Single shared secret that locks the PWA. Cookie after first entry.

## Arena
Parked. Public Twitch-plays demo. Not v1.
