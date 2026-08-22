# ADR 0004: Vite PWA, not React Native

## Status
Accepted

## Context
The product is chat plus a live Linux desktop. The desktop is already a web view. The author is new to apps. App Store is later.

## Decision
React + Vite + Tailwind v4 + shadcn, served by the daemon, installed as a PWA. Chat and Eyes are custom. No CopilotKit, no assistant-ui, no Rork. Native wrap (Expo/Capacitor) after the PWA looks right.

## Consequences
One codebase for laptop and phone. Store listing is a later shell, not a rewrite.
