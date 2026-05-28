# SDLC Log: Alerts Test Spec

**Feature:** alerts
**Phase:** Test Spec
**Date:** 2026-03-22
**Author:** SDLC Pipeline

## Summary

Generated test spec with 7 E2E scenarios and 6 integration scenarios covering the full alerts feature. All scenarios follow the E2E testing standards: no mocking of codebase components, real servers, HTTP API interaction only.

## Key Gaps Identified

1. **CRITICAL: SQL injection test** -- No tests exist for the ClickHouse SQL injection vulnerability in metric/sourceTable interpolation
2. **CRITICAL: No E2E tests** -- Zero end-to-end tests exercising the alert routes through HTTP API with real middleware
3. **CRITICAL: No tenant isolation E2E** -- Cross-tenant access not tested at the route level
4. **HIGH: No integration tests** -- No tests with real MongoDB verifying schema constraints and isolation
5. **HIGH: No HMAC verification test** -- Webhook signing never verified with independent computation

## Existing Test Analysis

| Test File                  | Tests | Quality Assessment                                          |
| -------------------------- | ----- | ----------------------------------------------------------- |
| alerting-threshold.test.ts | 22    | GOOD: Pure function tests, comprehensive operator coverage  |
| alerting-scheduler.test.ts | ~25   | GOOD: Covers core scheduler logic, but uses memory stores   |
| alert-evaluator.test.ts    | 7     | FAIR: Mocks DB + ClickHouse, misses real integration points |
| alert-config-ssrf.test.ts  | 3     | FAIR: Mocks all dependencies, only tests delivery service   |

## E2E Scenarios (7)

1. Alert Rule CRUD Lifecycle
2. Tenant Isolation for Alert Rules
3. Alert Config CRUD with SSRF Protection
4. Alert Rule Validation
5. Test-Fire Endpoint (SQL Injection Prevention)
6. Alert History Endpoint
7. Permission Enforcement

## Integration Scenarios (6)

1. Alert Evaluator Service with Real MongoDB
2. Alert Delivery Service with Real MongoDB
3. AlertScheduler with ClickHouse Metrics
4. Alert Rule Mongoose Model Validation
5. Alert Config Route with Real Auth Middleware
6. Webhook Delivery with HMAC Verification

## Decision Log

| ID  | Classification | Decision                                            |
| --- | -------------- | --------------------------------------------------- |
| D-1 | DECIDED        | E2E tests must use real Express server, no mocks    |
| D-2 | DECIDED        | SQL injection test is P0 and blocks BETA promotion  |
| D-3 | INFERRED       | Integration tests use MongoMemoryServer for MongoDB |
| D-4 | INFERRED       | ClickHouse integration can use mock wire protocol   |
