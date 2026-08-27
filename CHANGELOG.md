# Changelog

## [0.9.6] - 2026-08-28

### Changed

- Protect PinchTab credentials and serialize cookie synchronization

## [0.9.5] - 2026-08-28

### Changed

- Harden Harness Home bootstrap rollback and config preservation for #98

## [0.9.4] - 2026-08-27

### Changed

- Preserve bounded PinchTab lifecycle with isolated live supervision resources

## [0.9.3] - 2026-08-27

### Changed

- Harden PinchTab and Screen lifecycle bounds for issue #94

## [0.9.2] - 2026-08-27

### Changed

- Supervise one durable PinchTab bridge process group per Screen display with bounded health and browser-bootstrap readiness.
- Fail the PinchTab MCP transport closed on malformed, ambiguous, stalled, backpressured, or disconnected JSON-RPC streams.

## [0.9.1] - 2026-08-27

### Changed

- Supervise PinchTab bridge readiness, lifecycle, MCP ordering, and bounded failures

## [0.9.0] - 2026-08-27

### Added

- Add focused deterministic and explicit live test lanes
