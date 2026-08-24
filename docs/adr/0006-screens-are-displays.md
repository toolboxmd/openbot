# ADR 0006: Screens are displays on one Computer

## Status
Accepted

## Context
ADR 0001 locked one Computer, N Screens, shared disk. The first implementation ran a full XFCE+Kasm container per Bot (hundreds of MB idle). Grok Bot is one persistent computer per account with a screen per Bot. Screens are work surfaces, not a security boundary. Chat is always-on and must not boot XFCE. The Computer pane shows one Screen at a time. Zooming that preview is how the user drives the desktop. A Takeover button is the wrong affordance.

## Decision
One Computer (one Screen image / one machine). N Bots get N screens: extra displays on that Computer, not extra Debian containers.

The Computer preview is watch-only. Zooming or opening it is already write. No Takeover button. While zoomed, that Bot's desktop control pauses so two pointers do not fight. Closing zoom returns to watch-only and the Bot continues if it was working.

Chat does not start a display. A display stays up while that Bot is using the desktop, or while the user is zoomed on it. Idle displays may sleep; the Computer stays. Switching chats shows that Bot's screen (live if up, last frame if not).

2FA, captcha, and payment happen on the zoomed Screen. Never paste secrets in chat. ADR 0005 still holds: the ACP child is a host OS process.

## Consequences
Per-Bot `docker run` of the Screen image is not the architecture. Shared cookies and files are automatic. RAM for a sleeping Bot is not a second Linux. Tickets that shipped one container per Bot (#13 Sleep, #14 Takeover button) are a stepping stone; the button and per-Bot containers go. Sleep of a display does not kill Talk.
