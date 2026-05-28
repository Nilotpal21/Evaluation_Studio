# Runtime Test Lanes

Runtime tests are split by contract so the default lane stays deterministic and
environment-sensitive coverage is explicit.

## Lane Inventory

| Lane                     | Command                                                                                                        | Contract                                                                                                                                                              |
| ------------------------ | -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Deterministic regression | `pnpm --filter @agent-platform/runtime test` or `pnpm --filter @agent-platform/runtime test:deterministic`     | Core runtime/unit-style lanes plus `project-io`; no vendor calls and no intentionally live LLM smoke.                                                                 |
| Integration              | `pnpm --filter @agent-platform/runtime test:integration`                                                       | MongoMemoryServer/Redis-capable service tests, real middleware, no external vendors.                                                                                  |
| E2E                      | `pnpm --filter @agent-platform/runtime test:e2e`                                                               | Runtime HTTP/WebSocket behavior through public surfaces, with vendor dependencies replaced by local fixtures or injected doubles.                                     |
| Full regression          | `pnpm --filter @agent-platform/runtime test:regression`                                                        | Deterministic, integration, E2E, isolated, and connector lanes; intended for merge/nightly gates rather than default local smoke.                                     |
| Live vendor smoke        | `pnpm --filter @agent-platform/runtime test:live:llm` or `pnpm --filter @agent-platform/runtime test:live:all` | Explicit opt-in coverage for OpenAI/Anthropic/Gemini/Kore.ai credentials. Requires live environment variables and validates credentials before TravelDesk smoke runs. |

## Preflight And Failure Output

`apps/runtime/scripts/run-test-lanes.mjs` prints one compact preflight line before
running a profile:

- Mongo and Redis TCP reachability when configured.
- Live LLM enablement and whether any supported vendor key is present.
- External network posture from environment flags.
- Selected phases, lane counts, and per-phase concurrency.

When a lane fails, the runner mirrors normal test output and also prints a
failure classifier: credential failure, DB pool timeout, Redis unavailable, port
bind failure, timeout, assertion failure, or unknown.

## Resource Controls

DB-heavy runtime lanes are serialized at the shard layer. Shared MongoMemoryServer
helpers use per-worker database names (`abl_platform_test_*`) and scope index
warming by database so tests do not converge on the shared `abl_platform`
namespace. Set `TEST_MONGODB_DATABASE` only when a test intentionally needs a
stable database name.

## Warning Policy

Expected warnings should be tied to the scenario that creates them with local
assertions or comments. Live-provider credential errors belong only in live
lanes; deterministic and integration lanes should use provider doubles, local
fixtures, or explicit Redis/Mongo fallback assertions.
