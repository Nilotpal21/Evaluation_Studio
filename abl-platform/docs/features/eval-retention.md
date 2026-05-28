# Feature: Eval Retention

**Doc Type**: SUB-FEATURE
**Parent Feature**: [Agent Testing & Evals](../specs/agent-testing-evals.hld.md)
**Status**: ALPHA
**Feature Area(s)**: `evals`, `compliance`, `settings`
**Package(s)**: `packages/database`, `packages/pipeline-engine`, `apps/studio`
**Owner(s)**: `Platform team`
**Testing Guide**: N/A
**Last Updated**: 2026-05-11

---

## 1. Introduction / Overview

### Problem Statement

Eval transcripts and scores were retained with platform-wide ClickHouse TTLs: 730 days for eval
data and 365 days for production score rows. That kept the ClickHouse lifecycle simple, but it did
not let a customer shorten retention for tenant-specific compliance requirements. It also left a
split-brain outcome when ClickHouse expired drill-down rows while MongoDB `EvalRun` metadata
remained active.

### Goal Statement

Eval Retention gives each tenant an explicit retention contract for eval conversations, eval
scores, production scores, synthetic eval runs, Mongo cleanup behavior, and optional prompt PII
scrubbing. Defaults preserve the historical lifecycle unless the tenant owner changes settings.

### Summary

Tenant settings now include `settings.evalRetention`. Studio exposes the effective contract in
Settings > Data Retention and the API exposes it at `GET /api/tenant/retention`. ClickHouse rows
carry a resolved `ttl_override_days` value at write time, and a Restate-backed nightly sweep keeps
MongoDB `EvalRun` documents symmetric with ClickHouse expiration by archiving or deleting expired
runs.

---

## 2. Scope

### Goals

- Let tenant owners read and update eval retention TTLs with validation.
- Preserve existing defaults: 730 days for eval conversations and eval scores, 365 days for
  production scores, 30 days for synthetic eval runs.
- Apply tenant overrides to ClickHouse rows without relying on dynamic Mongo reads inside
  ClickHouse TTL expressions.
- Archive expired MongoDB eval runs unless the tenant opts into hard deletion.
- Keep eval definitions (`EvalSet`, `EvalPersona`, `EvalScenario`, `EvalEvaluator`) intact because
  they are configuration, not transcripts.
- Optionally scrub PII from persona `systemPrompt` and scenario `initialMessage` before storage.

### Non-Goals

- Backfilling historical ClickHouse rows with tenant-specific TTLs beyond the migration defaults.
- Deleting eval configuration definitions during retention cleanup.
- Replacing the v0 regex eval-definition scrubber with the full runtime PII detector.
- Guaranteeing aggregate materialized views disappear at exactly the same instant as source rows.

---

## 3. Customer-Facing Contract

| Data Class                         | Default | Override Field                        | Retained Form                            |
| ---------------------------------- | ------- | ------------------------------------- | ---------------------------------------- |
| Eval conversation transcripts      | 730 d   | `evalConversationsTtlDays`            | ClickHouse row until TTL expires         |
| Eval score rows                    | 730 d   | `evalScoresTtlDays`                   | ClickHouse row until TTL expires         |
| Production score rows              | 365 d   | `productionScoresTtlDays`             | ClickHouse row until TTL expires         |
| Synthetic eval conversation/scores | 30 d    | `syntheticTtlDays`                    | ClickHouse row until shorter TTL expires |
| Eval run summary                   | 730 d   | `hardDeleteExpiredRuns=false` default | Mongo summary after archive              |
| Eval run document                  | 730 d   | `hardDeleteExpiredRuns=true`          | Deleted by nightly retention cleanup     |
| Persona/scenario prompt text       | N/A     | `scrubPiiOnStore`                     | Verbatim by default, masked when enabled |

Tenant TTL overrides must be between 7 and 730 days. `syntheticTtlDays` must be strictly shorter
than normal eval conversation and score retention so prospect/demo synthetic traffic does not outlive
production eval traffic.

---

## 4. Behavior

### ClickHouse Retention

Eval ClickHouse tables include `ttl_override_days UInt16` and use a column-driven MergeTree TTL:
`toDateTime(created_at) + toIntervalDay(ttl_override_days) DELETE`. The pipeline engine resolves the
tenant retention contract before writing rows. Synthetic runs are tagged with `known_source =
'synthetic'` and receive the synthetic TTL.

### MongoDB Retention

The nightly workflow-engine sweep scans active tenants and finds completed, failed, or cancelled
`EvalRun` documents older than the effective conversation TTL. By default it marks them
`archived: true`, sets `archivedAt`, sets `archivedReason: 'retention_expired'`, strips
detail-requiring fields, and preserves summaries such as counts, score, and cost.

When `hardDeleteExpiredRuns` is true, the sweep deletes expired `EvalRun` documents instead of
archiving them. Eval definitions remain untouched in both modes.

### API and UI

`GET /api/tenant/retention` returns both defaults and the effective tenant contract. `PATCH
/api/tenant/retention` updates tenant overrides for workspace users with settings permission.
Archived eval run drill-down endpoints return a structured 410-style response so clients can
distinguish expired runs from never-existing runs.

Studio shows the same effective TTLs in the Data Retention settings page, including whether each
value is the platform default or a tenant override.

### PII Scrubbing

When `scrubPiiOnStore` is enabled, persona system prompts and scenario initial messages are masked
before storage. The current scrubber is a v0 placeholder that masks common email, US SSN, credit
card, and phone patterns. A follow-up should extract the richer runtime PII detector into a
dependency-safe shared package.

---

## 5. Compatibility Notes

The synthetic retention path composes with ABLP-947. Until `Session.source.knownSource` is fully
merged, callers can pass the eval run source explicitly and the system normalizes unknown values to
`eval`.
