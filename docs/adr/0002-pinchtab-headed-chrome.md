# ADR 0002: PinchTab drives headed Chrome

## Status
Accepted

## Context
Headless Chrome and Playwright fail DataDome / similar bot walls. januszbot completed a real checkout with headed PinchTab.

## Decision
PinchTab is the default browser driver. Headed Chrome on the Screen's DISPLAY, dedicated profile, not the host daily profile. Playwright MCP is fallback only, never both on the same Chrome.

## Consequences
The user watches the full XFCE desktop, not a Chrome-only screencast. PinchTab must not be left in its default headless bridge mode.
