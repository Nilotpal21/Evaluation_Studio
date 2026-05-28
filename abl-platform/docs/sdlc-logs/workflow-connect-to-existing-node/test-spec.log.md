# Test Spec Oracle Log — Connect to Existing Node (Add Step)

**Phase**: TEST-SPEC
**Slug**: workflow-connect-to-existing-node
**Oracle Run**: 2026-05-19

---

## Question Classifications

| ID  | Question                         | Classification        | Decision Summary                                                                                                                                          |
| --- | -------------------------------- | --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1  | Highest-risk FR                  | ANSWERED              | FR-4 (eligibility filter) — picker/`onConnect` predicate parity is the primary defect vector                                                              |
| A2  | Known production tickets         | INFERRED              | None — feature is PLANNED, no related tickets, no Known Engine Gaps for convergence                                                                       |
| A3  | Current coverage baseline        | ANSWERED              | `canvas-fanout.test.tsx` covers `onConnect` (UT-1 thru UT-7). No tests for `HandlePlusMenu` (E2E only) or `getEligibleConnectTargets` (doesn't exist yet) |
| A4  | External deps to mock            | ANSWERED              | None — pure client-side, no HTTP / LLM / DB                                                                                                               |
| A5  | Restate required for E2E         | DECIDED (D-1)         | Restate NOT required for core E2E; engine fan-in already covered by `system-parallel-graph.test.ts`                                                       |
| B1  | Critical user journeys           | DECIDED (D-2)         | 5 E2E journeys: diamond, mid-flow fan-in, empty-state, search, eligibility. Keyboard at component level only.                                             |
| B2  | Execute workflow in diamond E2E? | DECIDED (D-3)         | No — save + reload + graph-shape only. Execution duplicates engine E2E and adds Restate dep.                                                              |
| B3  | Auth/permission combinations     | ANSWERED              | N/A — operates within authenticated canvas session; no new permission surface                                                                             |
| B4  | Cross-feature interactions       | ANSWERED              | MergerNodeConfig auto-engage + serialization round-trip + predicate parity (filter ↔ onConnect)                                                           |
| B5  | Data seeding pattern             | ANSWERED              | Zustand store via `page.evaluate` per `agents.md` Writing Rule #2; `addNodeViaHandleMenu` only for the picker interaction itself                          |
| C1  | Integration test shape           | DECIDED (D-4)         | RTL + real Zustand store, matching `canvas-fanout.test.tsx` pattern                                                                                       |
| C2  | Webhook/event flows              | ANSWERED              | None — purely client-side                                                                                                                                 |
| C3  | Tenant/project isolation         | ANSWERED              | N/A — no new server-side surface                                                                                                                          |
| C4  | Race conditions                  | DECIDED (D-5/D-6/D-7) | (a) multi-user delete race + (b) fan-out cap on open → defer to LLD per feature spec §7. (c) rapid-type search filter → include as component test.        |
| C5  | Error / failure paths            | DECIDED (D-8)         | Parity test (`getEligibleConnectTargets` ↔ `onConnect`) is the primary error-path coverage. "Filter, don't fail" architecture.                            |

## Escalations

None. Zero AMBIGUOUS items.

## Decisions Carried Forward

D-1 through D-8 will be reflected in the test spec.
