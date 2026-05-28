# SDLC Log: Voice Pipeline STT Provider Parity — HLD

**Feature**: `voice-pipeline-stt-provider-parity`
**Phase**: HLD
**Date**: 2026-04-23

## Recommendation

- Shared registry expansion in `packages/config`
- Studio-only provider-card field metadata for admin forms
- Dedicated runtime speech-credential mapper before Jambonz provisioning

## Key Risk

- Provider-specific secret/config drift across CRUD, provisioning, and public read paths; mitigated with central sensitive-key metadata and targeted mapper tests.
