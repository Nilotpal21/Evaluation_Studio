# Reusable Module E2E Audit Iteration 4: Snapshot Binary Normalization

Status: Implemented
Date: 2026-05-02
Jira: ABLP-51

## Audit Finding

`DeploymentModuleSnapshot.compressedPayload` is stored as binary data in MongoDB. Unit tests use `Buffer`, but real `.lean()` reads can return a Mongo/BSON Binary-like object with `buffer`, `byteOffset`, and `byteLength`. The runtime resolver currently passes `compressedPayload` directly into `zlib.gunzipSync`, so a valid DB snapshot can be treated as corrupt before DSL/runtime execution ever sees the mounted agents or tools.

## Target Design

All deployment module snapshot consumers should normalize binary payloads before decompression. The resolver should accept `Buffer`, `Uint8Array`, and Binary-like payloads, then fail closed only when normalization or decompression genuinely fails.

## Implementation Slices

- [x] Red test: resolver successfully merges a module snapshot whose compressed payload is Binary-like, not a Buffer.
- [x] Green implementation: normalize `compressedPayload` before `gunzipSync`.
- [x] Verification: run focused module preview/deployment resolver tests.

## Future-Ready Contract

- DB binary representation is isolated to one normalization helper.
- Runtime snapshot loading remains fail-closed for corrupt payloads but tolerant of valid Mongo serialization forms.
- This keeps Studio publish → DB snapshot → resolver → runtime execution portable across local tests, Mongo memory, and production Mongo drivers.
