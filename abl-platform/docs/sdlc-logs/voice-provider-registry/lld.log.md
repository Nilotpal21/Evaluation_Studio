# SDLC Log: Voice Provider Registry — LLD

**Feature**: `voice-provider-registry`
**Phase**: LLD
**Date**: 2026-04-22

## Planned Execution

1. Add shared registry in `packages/config`
2. Refactor Studio to consume the registry
3. Refactor runtime route validation/helpers to consume the registry
4. Verify with targeted config, Studio, and runtime tests

## Notes

- Runtime parity for partial S2S providers is explicitly deferred to later stories.
