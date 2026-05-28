# SDLC Log: Alerts HLD

**Feature:** alerts
**Phase:** HLD (High-Level Design)
**Date:** 2026-03-22
**Author:** SDLC Pipeline

## Summary

Generated HLD addressing all 12 architectural concerns for the Alerts feature. Identified CRITICAL SQL injection, mass-assignment vulnerability, and distributed scheduler issues.

## 12 Architectural Concerns Addressed

| #   | Concern                 | Status   | Key Finding                                                |
| --- | ----------------------- | -------- | ---------------------------------------------------------- |
| 1   | Overview / Architecture | COMPLETE | Three-layer architecture: Runtime, EventStore, Pipeline    |
| 2   | Tenant Isolation        | COMPLETE | Query-level isolation verified; PUT mass-assignment gap    |
| 3   | Authentication & Auth   | COMPLETE | Full middleware chain documented; permission model mapped  |
| 4   | Stateless/Distributed   | COMPLETE | Scheduler is NOT stateless; needs Redis for production     |
| 5   | Traceability            | PARTIAL  | Event emission exists but no TraceEvent from routes        |
| 6   | Compliance              | PARTIAL  | No TTL, no cascade delete, webhook secrets in plaintext    |
| 7   | Performance             | COMPLETE | N+1 ClickHouse query risk identified; mitigation proposed  |
| 8   | Security                | CRITICAL | SQL injection + mass-assignment vulnerabilities documented |
| 9   | Error Handling          | COMPLETE | Standard pattern followed; error codes documented          |
| 10  | Data Model              | COMPLETE | Dual type system gap identified; consolidation recommended |
| 11  | Alternatives            | COMPLETE | Three design decisions analyzed with tradeoff tables       |
| 12  | Cross-Cutting           | COMPLETE | i18n, rate limiting, logging, configuration mapped         |

## Critical Issues Found

1. **SQL Injection (CRITICAL):** `rule.metric` and `rule.sourceTable` interpolated into ClickHouse SQL without parameterization or validation
2. **Mass Assignment (HIGH):** PUT `/:alertId` passes `req.body` directly to `$set` without field filtering
3. **Distributed Scheduler (HIGH):** Scheduler uses in-memory state; duplicate evaluations in multi-pod deployment
4. **Dual Type System (MEDIUM):** EventStore and Pipeline-engine use different interfaces for the same concepts
5. **No Cascade Delete (MEDIUM):** Tenant deletion doesn't cascade to alert rules/configs

## Decision Log

| ID  | Classification | Decision                                                |
| --- | -------------- | ------------------------------------------------------- |
| D-1 | DECIDED        | SQL injection fix is P0 -- allowlist + regex validation |
| D-2 | DECIDED        | Mass assignment fix via field allowlist on PUT          |
| D-3 | DECIDED        | Consolidate to eventstore engine + Redis stores         |
| D-4 | INFERRED       | Alert history should use ClickHouse                     |
| D-5 | DECIDED        | Polling is appropriate for current scale                |
