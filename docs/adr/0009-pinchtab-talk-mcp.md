# ADR 0009: PinchTab is Talk-injected MCP on the Screen

## Status
Accepted

## Context
ADR 0002 made PinchTab the headed Chrome driver on the Screen DISPLAY. Ada then opened Seller Central with host Mac Chrome because `pinchtab` was on the Mac PATH. Stock `pinchtab mcp` exposes 36 tools. A skill that curls the HTTP API is cheaper when idle and fatter in the browse loop. Tab locks on one Chrome would show Ada's tabs to Ben. N unrelated `pinchtab` binaries are not the vendor model. MCP cookie tools dump sessions into the model. Default `allowedDomains` is localhost, so grok.com would 403.

## Decision
One PinchTab bridge per Bot Screen (one Chrome). Talk on the host runs stock `pinchtab mcp --server` at that Screen. Chrome stays in Screen. Talk allowlists the browse loop: navigate, snapshot, get_text, click, type, fill, select, key, scroll, wait, list_tabs, back, and screenshot last. No custom MCP. No eval, cookies, scrape, pdf, capture, record, or network-route tools.

`OPENBOT.md` order: get_text, then snapshot (tree, not a picture), then screenshot if vision is needed (captcha, chart, canvas) and say that vision costs more. Captcha: screenshot and clicks first; if that fails, Open computer. No PinchTab auto-solver.

Cookie sharing is the Computer jar, copied on Screen start and stop, not MCP cookies. Live copy while both Chromes are up is later. Open web (`allowedDomains` includes `*`). IDPI wrap and scan stay on. Page text is untrusted. If PinchTab is down, fail closed: no host Chrome, no Playwright.

Host grant is a separate PWA card for paths outside the Workspace jail: Read vs Read and write, duration chosen on the card and stored. Computer-wide. Open computer stays Screen 2FA.

## Consequences
The Harness never execs `pinchtab` from PATH. N active Bots means N Chromes and N bridges, not a shared tab-lock Chrome. Schema tax is the allowlist, not 36 tools. A login on Ada's Screen reaches Ben after the next Screen start.
