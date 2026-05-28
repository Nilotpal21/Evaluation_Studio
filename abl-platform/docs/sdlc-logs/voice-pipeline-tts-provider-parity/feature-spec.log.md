# SDLC Log: voice-pipeline-tts-provider-parity — Feature Spec

**Feature**: `voice-pipeline-tts-provider-parity`
**Phase**: FEATURE-SPEC
**Date**: 2026-04-23

---

## Summary

- Captured the runtime-managed pipeline TTS provider set implemented in the shared registry, Studio admin cards, and runtime speech provisioning path.
- Recorded the intentional exclusions and capability boundaries: `azure` stays outside runtime/admin parity and preview remains limited to `elevenlabs` and `custom:orpheus`.
- Linked the implementation to the combined voice-provider branch validation results and documented the remaining workspace-level verification blockers honestly.
