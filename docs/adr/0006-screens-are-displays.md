# ADR 0006: Screens are displays on one Computer

## Status
Accepted (amended)

## Context
ADR 0001 locked one Computer, N Screens, shared disk. The first implementation ran a full XFCE+Kasm container per Bot (hundreds of MB idle). Grok Bot is one persistent computer per account with a screen per Bot. Screens are work surfaces, not a security boundary. Chat is always-on and must not boot XFCE. The Computer pane shows one Screen at a time. Zooming that preview is how the user drives the desktop. A Takeover button is the wrong affordance.

Idle "Screen is down" and docker-stop Sleep were shipped as a RAM trick (#13, #26, #28). That reading is rejected: the Computer pane must stay a live desktop (XFCE + Chrome on a New Tab), even when the Bot is not clicking. Stopping the Screen container to save RAM makes Chat look like a dead machine.

## Decision
One Computer (one Screen image / one Docker container / one machine). N Bots get N screens: extra displays (Kasm sessions on DISPLAY :1, :2, …) **inside that container**, not extra Debian containers. `docker compose up` / `npm start` starts that one `screen` service and keeps it up. Creating a Bot allocates a display on the existing Computer. Talk never `docker run`s `openbot-screen-${botId}`.

The Computer preview is watch-only. Zooming or opening it (the existing fullscreen Computer / >>) is already write. No Takeover button. Zoom does not pause or SIGSTOP Harness Sessions. If two pointers fight, ask the Bot to stop. Closing zoom returns the Screen to watch-only.

Chat does not start a display. Displays stay lit. The Computer stays up. Idle "Screen is down", Moon-Sun as a gate, and docker-stop Sleep of the Computer are rejected. Sleep is not a user-visible down pane.

2FA, captcha, and payment happen on the zoomed Screen. Never paste secrets in chat. ADR 0005 still holds: the ACP child is a host OS process.

Never publish or treat host 6901 as OpenBot Screen (the agent desktop often owns it). Bind another loopback port.

## Consequences
Per-Bot `docker run` of the Screen image is not the architecture. Shared cookies and files are automatic. RAM for a second Bot is a second X/Kasm session, not a second Linux. Tickets that shipped one container per Bot (#13 Sleep, #14 Takeover button) are a stepping stone; the button and per-Bot containers go. Sleep of a display does not kill Talk, and docker-stop of the Computer is not product Sleep. Zoom changes Screen write access only; Sessions keep running.
