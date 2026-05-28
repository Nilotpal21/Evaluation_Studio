# HELIX Journal — ABLP-267: Deployment — deleted API key still visible in UI after revocation. When a user deletes (revokes) an API key from the Deployment section, the key still appears in the list. The delete operation succeeds (key is soft-revoked with isActive: false), but the UI continues to show it because neither the backend query nor the frontend filters out inactive keys. Two issues: (1) Backend GET /api/sdk/keys returns all keys including revoked ones without filtering by isActive:true. (2) Frontend DeployPanel sets all returned keys into state without filtering by isActive. Fix: filter inactive keys in backend query AND/OR frontend display.

Session: `014fa0a8`
Started: 2026-04-14T10:35:59.277Z
Pipeline: Bug Fix
Pipeline Version: `Bug Fix@07f1e008c27d`

---

▸ **2026-04-14T10:36:53.549Z** [pipeline] Starting pipeline: Bug Fix
▸ **2026-04-14T10:36:53.607Z** [Reproduce] Entering stage: Read the bug report, trace the code path, write a failing test
**2026-04-14T10:43:12.356Z** [Reproduce] Verified reproduction test artifact: apps/studio/src/**tests**/components/deploy-panel-public-key-guidance.test.tsx
✓ **2026-04-14T10:43:12.537Z** [Reproduce] Completed with 1 findings after 1 iterations
▸ **2026-04-14T10:43:12.574Z** [Root Cause Analysis] Entering stage: Trace from symptom to root cause, identify all affected paths
✓ **2026-04-14T10:50:08.602Z** [Root Cause Analysis] Completed with 0 findings after 1 iterations
▸ **2026-04-14T10:50:08.675Z** [Fix Approach Approval] Entering stage: Review root cause and proposed fix approach. Approve to proceed.
▸ **2026-04-14T10:53:34.842Z** [pipeline] Starting pipeline: Bug Fix
▸ **2026-04-14T10:53:34.881Z** [Fix Approach Approval] Entering stage: Review root cause and proposed fix approach. Approve to proceed.
▸ **2026-04-14T11:03:31.851Z** [pipeline] Starting pipeline: Bug Fix
▸ **2026-04-14T11:03:31.891Z** [Implement Fix] Entering stage: Apply the minimal, correct fix. Codex implements, Claude reviews.
✓ **2026-04-14T11:18:06.539Z** [Implement Fix] Completed with 0 findings after 1 iterations
▸ **2026-04-14T11:18:06.607Z** [Regression Test] Entering stage: Ensure the bug has a permanent regression test that would catch recurrence
❌ **2026-04-14T11:18:15.107Z** [Regression Test] Model error: Exit code 1:
