# SDLC Log: voice-pipeline-tts-provider-parity — HLD

**Feature**: `voice-pipeline-tts-provider-parity`
**Phase**: HLD
**Date**: 2026-04-23

---

## Architectural Notes

- Reused the same layered split established by the provider-registry and STT parity stories: shared provider metadata in `packages/config`, Studio-only form metadata in the Studio wrapper, and runtime normalization in the speech mapper/Jambonz provisioning path.
- Treated preview capability as a separate shared concern so runtime/admin parity does not imply preview support.
- Preserved the current Voice Services workflow instead of widening scope into a schema-driven admin redesign.
