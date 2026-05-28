# SDLC Log: voice-pipeline-tts-provider-parity — LLD

**Feature**: `voice-pipeline-tts-provider-parity`
**Phase**: LLD
**Date**: 2026-04-23

---

## Implementation Notes

- Broke the work into shared-registry expansion, Studio admin/channel wiring, and runtime speech provisioning parity.
- Kept verification criteria explicit about the remaining package-wide runtime/Studio build blockers in this worktree.
- Recorded the preview-capability boundary and `azure` exclusion as explicit acceptance criteria so the docs do not overstate shipped support.
