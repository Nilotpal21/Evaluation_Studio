# Platform Configuration

> **Estimated time**: 18 minutes | **Prerequisites**: Workspace & Team Management

## Learning Objectives

After completing this module, you will be able to:

- Explain the model tier strategy and how it decouples agent design from model selection
- Describe the 5-level model resolution chain and how project overrides work
- Configure fallback chains for provider resilience
- Understand identity verification tiers and tool-level gating for sensitive operations
- Apply cost management strategies using tier assignments and token budgets

## AI Model Configuration: The Tier Strategy

The Agent Platform is **provider-neutral** -- your agents can use models from Anthropic, OpenAI, Google, Azure, Amazon Bedrock, and custom endpoints. The key design principle is that agents reference **tiers**, not specific models.

### Model Tiers

| Tier         | Intended Use                                    | Typical Models                                  | Relative Cost |
| ------------ | ----------------------------------------------- | ----------------------------------------------- | ------------- |
| **Fast**     | Classification, routing, quick responses        | Claude 3.5 Haiku, GPT-4o mini, Gemini 2.0 Flash | Lowest        |
| **Balanced** | General-purpose tasks                           | Claude 4 Sonnet, GPT-4o, Gemini 2.5 Flash       | Medium        |
| **Powerful** | Complex reasoning, analysis, content generation | Claude 4 Opus, o3, Gemini 2.5 Pro               | Highest       |
| **Voice**    | Real-time voice interaction                     | GPT-4o Realtime, Gemini Live 2.5 Flash          | Varies        |

> **Key Concept**: The **Fast and Powerful tier strategy** is your primary lever for cost management. Route simple tasks (entity extraction, field validation, quick classification) to Fast-tier models, and reserve Powerful-tier models for complex reasoning and multi-source analysis. The cost difference between tiers can be **10x or more**, so thoughtful tier assignment directly impacts your monthly bill.

### Why Tiers Matter for Business

Consider a customer support agent that handles three types of tasks:

1. **Routing incoming requests** to the right department -- a Fast-tier model handles this in milliseconds at minimal cost
2. **Answering standard questions** about policies or hours -- a Balanced-tier model provides good quality at reasonable cost
3. **Analyzing complex complaints** that require synthesizing multiple sources -- a Powerful-tier model delivers the nuanced reasoning required

By assigning the right tier to each operation, you optimize both quality and cost without changing any agent definitions. When a better model becomes available, you swap it at the workspace level, and all agents automatically use the upgrade.

## The Model Resolution Chain

When the runtime executes an agent, it resolves which specific model to use through a **5-level priority cascade**. The system stops at the first match:

| Priority    | Source                    | Description                                                    |
| ----------- | ------------------------- | -------------------------------------------------------------- |
| 0 (highest) | **Deployment override**   | Model pinned to a specific deployment (useful for A/B testing) |
| 1           | **Agent definition**      | Model or operation-specific models declared in the agent file  |
| 2           | **Agent settings**        | Per-agent model override configured in the Studio UI           |
| 3           | **Project configuration** | Project-level tier-to-model mapping                            |
| 4 (lowest)  | **Workspace default**     | Workspace-level default model for the resolved tier            |

> **Key Concept**: The 5-level model resolution chain gives you flexibility at every scope. Workspace defaults cover most cases, **project overrides** let specific teams customize their model choices, and deployment overrides enable controlled experiments -- all without changing agent definitions. If no model is resolved at any level, the request fails with a clear error; the platform never silently defaults to a hard-coded model.

### Project-Level Overrides in Practice

Each project inherits workspace model defaults but can customize how tiers map to operations:

| Operation           | Default Tier | When to Override                                 |
| ------------------- | ------------ | ------------------------------------------------ |
| Extraction          | Balanced     | Override to Fast for simple form parsing         |
| Validation          | Fast         | Keep as-is for most projects                     |
| Tool selection      | Balanced     | Override to Powerful for agents with many tools  |
| Response generation | Balanced     | Override to Powerful for customer-facing agents  |
| Reasoning           | Powerful     | Keep as-is -- this is where quality matters most |
| Coordination        | Balanced     | Override to Fast for simple supervisor routing   |

## Fallback Chains: Provider Resilience

No cloud provider has 100% uptime. Fallback chains protect your agents from provider outages and rate limits.

When the primary model fails (timeout, rate limit, or provider error), the runtime automatically retries with each fallback model in order:

- Each fallback attempt uses its own credentials (you might fall back from Anthropic to OpenAI)
- The platform tracks which model actually served each request, visible in analytics
- Fallback is transparent to the agent -- it receives a response regardless of which provider served it

> **Key Concept**: **Fallback chains across providers** ensure business continuity. If your primary provider (say, Anthropic) experiences an outage, the platform automatically routes requests to your secondary provider (say, OpenAI) without any manual intervention, downtime, or changes to your agent definitions. Configure fallbacks in **Settings > AI Configuration > Models** by selecting a registered model and adding fallback models in priority order.

### Example Fallback Configuration

A financial services team might configure:

1. **Primary**: Anthropic Claude 4 Sonnet (preferred for reasoning quality)
2. **Fallback 1**: OpenAI GPT-4o (broad capabilities, different provider)
3. **Fallback 2**: Google Gemini 2.5 Flash (fast inference, third provider)

This three-provider chain makes a complete service disruption extremely unlikely.

## Identity Verification and Tool Gating

Not all agent interactions require the same level of trust. The platform provides a tiered identity model that controls what end users can do based on how well their identity has been verified.

### Identity Tiers

| Tier   | Name       | Confidence Level | How It Is Established                                              |
| ------ | ---------- | ---------------- | ------------------------------------------------------------------ |
| **T0** | Anonymous  | None             | Default for all new sessions                                       |
| **T1** | Recognized | Low              | Cookie match, caller ID, or provider assertion                     |
| **T2** | Verified   | High             | Cryptographic proof via HMAC, OTP code, OAuth, or email magic link |

> **Key Concept**: The **T2 identity tier** represents a fully **verified user** -- someone who has completed cryptographic identity proof. This is the gold standard for sensitive operations. T2 verification methods include HMAC signatures (where your backend signs the user's identity), one-time password codes, OAuth with PKCE, and email magic links. Each of these provides mathematical certainty about who the user is.

### Tool-Level Identity Gating

The real power of identity tiers is **tool-level gating**. You can require a minimum identity tier on individual tools, restricting sensitive operations to verified users while keeping general features open to everyone.

> **Key Concept**: **Tool-level `identityTierRequired` gating** lets you set a minimum identity tier on any tool in your agent. For example, a "check account balance" tool can require T2 (verified identity), while a "store locator" tool remains open to anonymous users (T0). When an anonymous user attempts to use a gated tool, the platform returns a structured error, and the agent can guide the user through a verification flow before retrying.

### Business Scenario: Banking Agent

Consider an agent for a retail bank:

| Tool                | Identity Requirement | Rationale                            |
| ------------------- | -------------------- | ------------------------------------ |
| Branch locator      | T0 (anyone)          | Public information, no risk          |
| Product information | T0 (anyone)          | Marketing content, no sensitive data |
| Account balance     | T2 (verified)        | Sensitive financial data             |
| Fund transfer       | T2 (verified)        | Financial transaction                |
| Report lost card    | T1 (recognized)      | Urgent action, moderate risk         |

This layered approach balances security with usability -- customers can get general information without friction, but sensitive operations require proper verification.

## Cost Management and Token Budgets

Every LLM call tracks token usage and estimated cost. The platform provides several controls to manage spending:

| Control                | Scope     | Purpose                                                                   |
| ---------------------- | --------- | ------------------------------------------------------------------------- |
| Monthly token budget   | Workspace | Cap total spending per billing cycle                                      |
| **Daily token budget** | Workspace | Prevent a single runaway agent from consuming a month's budget in one day |
| Per-project budget     | Project   | Allocate spend across teams                                               |
| Requests per minute    | Workspace | Rate-limit API calls                                                      |

> **Key Concept**: Set **daily token budgets** conservatively during initial rollout, even if your monthly budget is generous. A daily limit acts as a circuit breaker -- it prevents a misconfigured agent or unexpected traffic spike from burning through your entire monthly allocation before anyone notices. Combine daily budgets with **sliding window alerts** (notify at 80% of budget) for proactive cost control.

### Cost Optimization Tips

1. **Use the right tier for the job** -- Route classification and validation to Fast-tier models instead of Powerful-tier (10x cost difference)
2. **Review agent-level usage monthly** -- Identify agents with high per-session token counts and optimize their prompts
3. **Enable conversation sliding windows** -- For long-running agents, limit the conversation history sent to the LLM to reduce input token costs
4. **Archive inactive projects** -- Inactive projects with deployed agents may still consume resources from scheduled tasks

## Key Takeaways

- The Fast/Powerful tier strategy is your primary lever for cost management -- assign the right tier to each operation for optimal quality-to-cost ratio
- Fallback chains across multiple providers ensure business continuity during outages without any manual intervention
- The 5-level model resolution chain provides flexibility from workspace defaults down to individual deployments, with project overrides covering most customization needs
- T2 identity verification (cryptographic proof) enables secure tool gating for sensitive operations like financial transactions
- Tool-level `identityTierRequired` gating lets you enforce verification requirements per tool while keeping general features accessible

## What's Next

Continue to **Operations & Deployment** to learn about billing plans, quota management, deployment channels, and operational monitoring.
