# ADR 0011: Familiar messenger visual baseline

## Status
Accepted

## Context
OpenBot's tracer-bullet PWA proved durable Chat, replies, reactions, receipts, permissions, and Computer access, but generic primitives and feature-by-feature growth did not create a coherent product interface. The result exposed technical controls in primary chrome, treated the sidebar as a Bot list instead of a Chat inbox, and had no durable visual contract or dark theme.

The local GrokBot reference walk documents a familiar modern messenger composition: recent-activity sidebar, quiet Chat header, left and right message treatment, in-stream Cards, compact composer, progressive Computer pane, command palette, and sectioned settings. Apple Messages, Telegram, and other current chat products reinforce the same learned interaction grammar. Copying a branded application pixel for pixel would import irrelevant product decisions and proprietary identity.

## Decision
OpenBot v1 adopts GrokBot as its familiar-messenger baseline for layout grammar, density, component anatomy, and interaction patterns. OpenBot retains its own Eyes, states, Cards, terminology, assets, and domain behavior.

`DESIGN.md` is the binding reusable visual and interaction contract. Its YAML front matter owns exact tokens. `docs/design/grokbot-reference-catalog.md` owns the exhaustive observation inventory and evidence boundaries. GitHub Issues own implementation timing. Catalog presence does not make a capability part of v1.

A design may diverge from the baseline only for an OpenBot domain need, accessibility, a platform constraint, or a demonstrated usability improvement. The reason must be explicit. Private reference screenshots stay outside Git; the repository stores textual observations and may later store only sanitized crops.

OpenBot uses the existing React, Tailwind, shadcn-style, Radix, Lucide, and Framer Motion stack. Generic interaction primitives come from that stack. Product composition, Eyes, message tails, transcript Cards, and Computer presentation remain OpenBot-owned.

## Consequences
UI work must read `DESIGN.md` before changing a PWA surface and must use the reference catalog when parity with the baseline is relevant.

Dark mode, responsive phone behavior, accessibility, grouped message tails, quiet motion, and the functional-controls-only capability gate are part of visual acceptance. Plugins is the sole named v1 roadmap-placeholder exception.

Existing behavioral correctness remains authoritative. A visual restyle must not change ACP `messageId` bubble boundaries, interruption semantics, durable Transcript behavior, permissions, or Computer ownership without a separate product decision.
