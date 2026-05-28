# Modules, Models & Scaling

> **Estimated time**: 40 minutes | **Prerequisites**: Familiarity with ABL agent definitions, basic understanding of versioning concepts

## Learning Objectives

After completing this module, you will be able to:

- Explain how reusable modules work and how the double-underscore alias naming convention prevents conflicts
- Describe the 5-level model resolution cascade and explain why agents reference tiers, not specific models
- Understand module dependency limits and constraints (max 5 dependencies per consumer)
- Calculate the total conversations and evaluations in a Cartesian product eval set
- Explain the 3-layer archive check that prevents premature release deletion

## Reusable Modules: Share Agent Logic Across Projects

In enterprise environments, teams often need the same capabilities across multiple projects -- identity verification, payment processing, FAQ handling. Without a sharing mechanism, you copy ABL definitions between projects, and those copies inevitably diverge. Modules solve this by letting you publish tested, versioned snapshots of agent logic that consumers pin to specific releases.

### The Module Lifecycle

1. **Create** -- Enable module mode on any existing project
2. **Build** -- Author agents and tools as usual
3. **Publish** -- Create an immutable, versioned release
4. **Promote** -- Move releases through `dev` -> `staging` -> `production` environments
5. **Import** -- Consumer projects browse the catalog and import modules with an alias
6. **Deploy** -- Consumer deployments freeze exact module versions into deployment snapshots

### Publishing a Release

When you publish a module release, the system runs a multi-step build pipeline:

1. Validates at least one agent exists and an entry agent is set
2. Compiles each agent's ABL to intermediate representation (IR)
3. Strips project-specific identifiers
4. Runs publish safety validation (rejects inline secrets, flags non-portable bindings)
5. Extracts the module contract (what it provides, what it requires)
6. Computes a deterministic SHA-256 source hash

```abl
AGENT billing_lookup
  DESCRIPTION: "Looks up billing information for a customer account"
  MODEL: default
  TOOLS:
    - get_account_balance
    - get_payment_history
  INSTRUCTIONS: |
    You help customers check their account balance and review payment history.
    Always verify the customer's identity before providing billing details.
    Use {{config.CURRENCY_FORMAT}} for all monetary values.
```

Notice the use of `{{config.CURRENCY_FORMAT}}` -- module authors use config templating so consumer projects can provide their own values without changing module source.

### The Double-Underscore Alias Convention

When you import a module, you assign it an **alias**. All agent and tool names are automatically prefixed with `alias__` (alias + double underscore). This prevents naming conflicts between modules and your project's own agents.

| Module Symbol         | Alias     | Mounted Name in Consumer       |
| --------------------- | --------- | ------------------------------ |
| `billing_lookup`      | `billing` | `billing__billing_lookup`      |
| `get_account_balance` | `billing` | `billing__get_account_balance` |
| `get_payment_history` | `billing` | `billing__get_payment_history` |

> **Key Concept**: The double-underscore (`__`) separator is reserved. Module aliases cannot contain double underscores, ensuring the platform can always distinguish the alias prefix from the original name. When you reference imported agents in routing rules or handoffs, you use the mounted name: `billing__billing_lookup`.

The rewrite is deep and comprehensive -- it updates all references across agent metadata, tool names in flow steps, handoff targets, delegate targets, routing rules, error handler targets, behavior profile tool lists, and static graph nodes.

### Alias Rules

| Rule                                                  | Example       |
| ----------------------------------------------------- | ------------- |
| Lowercase, starts with a letter                       | `billing`     |
| 2-25 characters                                       | `hr_tools`    |
| Letters, digits, single underscores                   | `payments_v2` |
| No double underscores (`__`)                          | --            |
| No reserved prefixes: `system_`, `internal_`, `test_` | --            |

### Import Limits and Constraints

- **Maximum 5 module dependencies** per consumer project
- Alias must be unique within a project (409 if duplicate)
- Self-import is blocked (a project cannot import itself)
- No transitive dependencies (a module cannot import another module)
- Config overrides cannot set secret keys
- Maximum 250 mounted symbols (agents + tools combined) per deployment

> **Key Concept**: The 5-dependency limit is a deliberate constraint. It encourages focused, domain-specific modules ("one domain, one module") rather than sprawling utility packages. If you need more than 5 modules, reconsider your module boundaries -- some modules may be candidates for consolidation.

## The 5-Level Model Resolution Cascade

Agent Platform is provider-neutral. Agents reference **model tiers** (Fast, Balanced, Powerful, Voice), not specific models. When the Runtime executes an agent, it resolves the actual model through a 5-level priority cascade, stopping at the first match:

| Priority | Source              | Description                                                   |
| -------- | ------------------- | ------------------------------------------------------------- |
| **0**    | Deployment override | Model pinned to a specific deployment (e.g., an A/B test)     |
| **1**    | Agent DSL           | Model or `operation_models` declared in the `.agent.abl` file |
| **2**    | Agent DB config     | Per-agent model override in the agent settings UI             |
| **3**    | Project DB config   | Project-level `ModelConfig` with tier-to-model mapping        |
| **4**    | Tenant model        | Workspace-level default model for the resolved tier           |

### Why This Matters

This cascade lets you make sweeping changes efficiently:

- **Change the workspace default** (level 4) and every agent that does not have a more specific override picks up the new model immediately.
- **Override at the project level** (level 3) for a project that needs a different model for cost or performance reasons.
- **Pin a specific agent** (level 2) when one agent has unique requirements.
- **Declare in ABL** (level 1) when the model choice is integral to the agent's design.
- **Pin a deployment** (level 0) for A/B testing or gradual rollout.

```abl
AGENT CustomerSupport
  DESCRIPTION "Handles customer inquiries"
  MODEL "anthropic/claude-sonnet-4"
  FALLBACK_MODELS ["openai/gpt-4o", "google/gemini-2.5-flash"]
```

If the agent declares a `MODEL` (level 1), it overrides the project and tenant defaults. But a deployment override (level 0) still takes precedence.

> **Key Concept**: If no model is resolved at any level, the request fails with a clear error. The platform never falls back to a hardcoded default. This fail-fast behavior prevents silent degradation -- you always know exactly which model is serving your agent.

### Model Tiers

| Tier         | Intended Use                             | Typical Models                                  |
| ------------ | ---------------------------------------- | ----------------------------------------------- |
| **Fast**     | Classification, routing, quick responses | Claude 3.5 Haiku, GPT-4o mini, Gemini 2.0 Flash |
| **Balanced** | General-purpose tasks                    | Claude 4 Sonnet, GPT-4o, Gemini 2.5 Flash       |
| **Powerful** | Complex reasoning, analysis              | Claude 4 Opus, o3, Gemini 2.5 Pro               |
| **Voice**    | Real-time voice interaction              | GPT-4o Realtime, Gemini Live 2.5 Flash          |

### Fallback Chains

Configure fallback models for provider resilience:

- Fallback models are tried in order when the primary fails (timeout, rate limit, provider error)
- Each fallback uses its own credentials (you can fall back from Anthropic to OpenAI)
- Fallback is transparent to the agent -- it receives a response regardless of which model served it
- Analytics track which model ultimately served each request

## Evaluation Math: The Cartesian Product

The evaluation system runs the Cartesian product of personas, scenarios, and variants. Understanding this math helps you plan eval costs and duration.

### The Formula

```
Total conversations = Personas x Scenarios x Variants
Total evaluations   = Total conversations x Evaluators
```

### Worked Example

An eval set with:

- 3 personas (Impatient Traveler, Confused Beginner, Technical Expert)
- 4 scenarios (booking, cancellation, rebooking, complaint)
- 2 evaluators (Quality Judge, Safety Judge)
- 2 variants (for statistical confidence)

```
Total conversations = 3 x 4 x 2 = 24
Total evaluations   = 24 x 2     = 48
```

Each conversation is an independent multi-turn session where a persona LLM plays the user role according to the scenario definition. Each evaluator scores each conversation independently.

> **Key Concept**: The Cartesian product grows multiplicatively. Adding one more persona to the example above adds 8 conversations and 16 evaluations. Adding one more scenario adds 6 conversations and 12 evaluations. Plan your eval sets carefully -- start small during development (1 variant, 2-3 personas) and expand for release validation.

### Cost Optimization Tips

- Use **1 variant** during active development, increase to **3+** for release candidates
- Use **smaller persona models** (Fast tier) to reduce the simulated user cost
- Use **scenario tags** to create focused eval sets (smoke-test vs. full regression)
- Set **daily token budgets** to prevent a runaway eval from consuming a month's quota

## Release Archive: The 3-Layer Protection

Module authors can archive old releases to hide them from the catalog. But archiving is not deletion -- the platform protects releases that are still in use through a **3-layer check**.

### The 3 Layers

A release archive is blocked if the release is referenced by any of these:

| Layer                        | Check                                                                      | What It Protects                                                        |
| ---------------------------- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| **1. Environment pointers**  | A `dev`, `staging`, or `production` pointer currently targets this release | Prevents archiving the release that an environment track is pointing to |
| **2. Deployment snapshots**  | An active deployment has this release frozen in its snapshot               | Prevents breaking running production deployments                        |
| **3. Consumer dependencies** | A consumer project's dependency resolves to this release                   | Prevents breaking consumer projects that pin to this version            |

> **Key Concept**: This is not a time-based retention system. There is no "archive after 90 days" policy. A release remains protected as long as any of the 3 layers still references it. Once all references are removed or updated -- promote a different release, redeploy consumers, update dependencies -- the archive succeeds. This ensures you never accidentally break a running system.

### The Archive Workflow

```
1. Check reverse dependencies:  GET /module/consumers
2. Notify consumers to upgrade to the new release
3. Consumers update their dependencies
4. Promote a different release to any environment pointers
5. Consumer projects redeploy (creating new snapshots)
6. All 3 layers clear -> archive succeeds
```

Archived releases remain internally resolvable (existing deployments keep working) but stop appearing in the catalog for new imports.

## Deployment with Frozen Module Snapshots

When you deploy a consumer project with module dependencies, the system creates a **frozen deployment module snapshot**. This snapshot captures the exact state of every imported module at deploy time.

### What Happens at Deploy Time

1. **Dependency resolution** -- Each module dependency's selector is resolved to a concrete release ID
2. **Auth profile preflight** -- All required auth profiles from module contracts are validated
3. **IR rewriting** -- Module IR is deep-cloned and all names are rewritten with alias prefixes
4. **Snapshot compression** -- Rewritten IR is gzip-compressed and stored
5. **Hash computation** -- Deterministic SHA-256 ensures reproducibility

After deployment, editing agents in the source module project has **zero effect** on existing consumer deployments. Changes only take effect when the consumer imports a new release and redeploys.

## Context Window Management and Cost Control

Large conversations accumulate tokens. The Runtime automatically manages context windows to stay within model limits and control costs:

- **Tool result compression** -- Large tool results are compressed before being added to conversation
- **Prior turn truncation** -- Tool results from previous turns are replaced with short placeholders
- **Conversation compaction** -- When history grows beyond a threshold, older messages are summarized

### Conversation Sliding Windows

For long-running agents, **sliding windows** limit the conversation history sent to the LLM:

- Only the last N turns are included in the context
- Older turns are summarized or dropped
- This directly reduces input token costs
- Particularly important for agents with many tool calls (each tool result adds tokens)

> **Key Concept**: Conversation sliding windows are one of the most effective cost optimization tools. A support agent that handles 50-turn conversations can reduce input token costs by 60-80% with an appropriate window size, while preserving the context needed for quality responses.

## Key Takeaways

- Module imports use the `alias__name` double-underscore convention to prevent naming conflicts across up to 5 module dependencies per consumer
- The 5-level model resolution cascade (deployment -> DSL -> agent config -> project config -> tenant) ensures flexible, provider-neutral model management
- Eval sets run the Cartesian product: 3 personas x 4 scenarios x 2 variants = 24 conversations, each scored by every evaluator
- Release archives are protected by a 3-layer check (environment pointers, deployment snapshots, consumer dependencies) -- not by time-based retention
- Conversation sliding windows are a key cost optimization for long-running agents

## What's Next

Explore the [Patterns & Deployment](../patterns-deployment/content.md) module for orchestration patterns and enterprise deployment, or the [Testing & Evaluation](../testing-evaluation/content.md) module for a deeper dive into the eval framework.
