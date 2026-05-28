# SDLC Log: Tool Invocations - Feature Spec (Phase 1)

**Date**: 2026-03-22
**Phase**: Feature Spec
**Skill**: `/feature-spec`

## Clarifying Questions & Decisions

| #   | Question                                            | Classification | Answer / Rationale                                                                                                                                               |
| --- | --------------------------------------------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | What tool types are supported?                      | ANSWERED       | HTTP, MCP, Sandbox, SearchAI, Connector, Workflow, Async Webhook. Lambda declared but not implemented. Source: `packages/compiler/src/platform/ir/schema.ts:632` |
| 2   | How are tools compiled and dispatched?              | ANSWERED       | Tools compiled into agent IR via `loadProjectToolsAsIR()`, dispatched by `ToolBindingExecutor` based on `tool_type`. Source: tool-binding-executor.ts            |
| 3   | What security controls exist?                       | ANSWERED       | SSRF protection (shared-kernel), AES-256-GCM secrets, sandbox isolation, confirmation gates, OAuth HTTPS enforcement. Source: multiple executor files            |
| 4   | What resilience controls exist?                     | ANSWERED       | Circuit breakers (3-failure, 30s reset), rate limiters (Redis sliding window), configurable timeouts (default 30s), MCP retry (1 retry, exponential backoff)     |
| 5   | What is the middleware architecture?                | ANSWERED       | Onion-model composable middleware chain in `tool-middleware.ts`. Auth-profile middleware mutates HTTP bindings before dispatch. Source: llm-wiring.ts            |
| 6   | What auth integration exists?                       | ANSWERED       | Auth profiles inject per-request credentials, OAuth 2.0 code flow, client credentials, JIT auth, preflight consent. Source: auth-profile-tool-middleware.ts      |
| 7   | What is the test coverage baseline?                 | ANSWERED       | 66+ test files, 1,000+ test cases, 19-scenario API E2E suite. Source: docs/testing/tool-invocations.md                                                           |
| 8   | What are the primary gaps?                          | ANSWERED       | Lambda/async-webhook partial, isolation E2E missing, external-backend CI coverage absent. Source: existing feature spec GAP-001 through GAP-006                  |
| 9   | Should lambda executor be HIGH priority?            | DECIDED        | Low priority -- declared in schema but no production demand yet. Kept as open question.                                                                          |
| 10  | Should token-based MCP cap replace character-based? | DECIDED        | Logged as open question -- character-based is simpler but less aligned with LLM token budgets.                                                                   |

## Files Created / Modified

| File                                                  | Action    | Notes                               |
| ----------------------------------------------------- | --------- | ----------------------------------- |
| `docs/features/tool-invocations.md`                   | Rewritten | Full 18-section spec, code-grounded |
| `docs/sdlc-logs/tool-invocations/feature-spec.log.md` | Created   | This file                           |

## Review Summary

### Round 1 - Completeness & Quality

- All 18 TEMPLATE.md sections addressed
- 8 user stories (exceeds minimum 3)
- 12 functional requirements (exceeds minimum 4)
- Integration matrix references 8 related features
- Non-functional concerns address tenant, project, and user isolation
- Delivery plan has parent tasks with numbered subtasks
- 5 open questions
- All claims grounded in code evidence (file paths verified)

### Round 2 - Cross-Phase Consistency

- FR numbering consistent (FR-1 through FR-12), referenced in test matrix
- Scope boundaries match non-goals
- User stories align with functional requirements
- Implementation files verified against codebase paths
- No contradictions with existing test spec

## Key Learnings

- The tool invocation system spans 10+ packages with the compiler package owning the executor framework and the runtime package owning session-level wiring
- Auth profile injection is a middleware concern, not an executor concern -- this is an important architectural boundary
- Namespace-scoped executors are created lazily per-tool only when `variable_namespace_ids` are present
- The proxy resolver uses an async-ready pattern (`setProxyReadyPromise`) to avoid blocking session startup
