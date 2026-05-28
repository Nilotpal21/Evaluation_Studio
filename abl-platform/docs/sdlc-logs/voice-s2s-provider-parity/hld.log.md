# SDLC Log: voice-s2s-provider-parity — HLD

**Feature**: `voice-s2s-provider-parity`
**Phase**: HLD
**Date**: 2026-04-23

---

## Architectural Notes

- Added a dedicated runtime S2S adapter so provider-specific payloads, tool messages, and event translation do not live as scattered OpenAI-centric cases inside the router.
- Preserved Google and Grok specialized flows and treated the provider-aware adapter as the widening path for the other modeled S2S providers.
- Kept partial-support messaging as an explicit product contract instead of promoting all modeled providers to `full`.
