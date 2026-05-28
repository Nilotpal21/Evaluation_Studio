Review the following Search-AI design document, RFC, or code changes using the `search-ai-architect` skill.

Detect affected domains from the input (ingestion, query pipeline, database, vector store, knowledge graph, connector, security, performance) and apply the relevant checklists.

Always check security (tenant isolation) and performance as cross-cutting concerns.

If reviewing a design document: cross-reference against the existing codebase to identify conflicts, missing abstractions, and implementation feasibility.

If reviewing code: check against anti-patterns in the `search-ai-development` skill and patterns in `docs/searchai/DATABASE-SCHEMA.md`.

Output a structured review with severity ratings (CRITICAL, HIGH, MEDIUM, LOW, INFO) and a clear Approve/Block recommendation.

Review: $ARGUMENTS
