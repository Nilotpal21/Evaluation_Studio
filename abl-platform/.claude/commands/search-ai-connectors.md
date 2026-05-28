Help with SearchAI connector development using the `search-ai-connectors` skill.

This covers: researching external systems, building new connectors, migrating connectors from other repos, debugging sync/delta/permission issues, and reviewing connector code.

Reference docs:

- `docs/searchai/design/SHAREPOINT-CONNECTOR-COMPLETE-REFERENCE.md` — Narrative walkthrough (11 scenes)
- `docs/searchai/design/SHAREPOINT-CONNECTOR-DIAGRAMS.md` — Class & sequence diagrams (17 diagrams)
- `apps/search-ai/docs/connectors/search-ai-connectors-framework.md` — IConnector interface spec

Use this for:

- Researching a new external system before building a connector (auth, objects, metadata, permissions, rate limits, filters)
- Scaffolding a new connector from scratch (package setup, class stubs, registration)
- Migrating an existing connector from another repo into the platform
- Debugging connector failures (stuck sync, stale delta tokens, permission mismatches, token refresh)
- Reviewing connector code against architecture patterns and anti-patterns

$ARGUMENTS
