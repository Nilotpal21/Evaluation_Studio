# SDLC Log: Voice Provider Registry — HLD

**Feature**: `voice-provider-registry`
**Phase**: HLD
**Date**: 2026-04-22

## Recommendation

- Shared core provider metadata in `packages/config`
- Studio-only presentation wrapper for JSX, icons, and S2S components

## Key Risk

- Refactor drift while moving multiple consumers at once; mitigate with focused tests in each package.
