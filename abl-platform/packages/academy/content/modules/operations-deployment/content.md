# Operations & Deployment

> **Estimated time**: 16 minutes | **Prerequisites**: Platform Configuration

## Learning Objectives

After completing this module, you will be able to:

- Compare platform plan tiers and identify when to upgrade for connectors and analytics
- Configure token budgets, sliding windows, and alerts to control costs proactively
- Understand SLA commitments across plan tiers
- Describe how a single agent serves multiple channels through channel adapters
- Identify channel-specific capabilities such as Teams Adaptive Cards for B2B scenarios

## Plan Tiers and Upgrade Decisions

The Agent Platform offers three plan tiers that unlock progressively more capabilities. Understanding the differences helps you make informed upgrade decisions aligned with your business needs.

| Capability         | Starter | Professional | Enterprise |
| ------------------ | ------- | ------------ | ---------- |
| Team members       | Up to 5 | Up to 25     | Unlimited  |
| Projects           | Up to 3 | Up to 20     | Unlimited  |
| Monthly sessions   | 1,000   | 50,000       | Custom     |
| Monthly tokens     | 1M      | 50M          | Custom     |
| Connectors         | --      | Yes          | Yes        |
| Advanced analytics | --      | Yes          | Yes        |
| Guardrails         | --      | Yes          | Yes        |
| SSO                | --      | --           | Yes        |
| KMS (BYOK)         | --      | --           | Yes        |
| SLA                | --      | 99.9%        | **99.95%** |

> **Key Concept**: Upgrading to the **Professional plan** unlocks **connectors** (integrations with external services like Salesforce, HubSpot, Slack, and custom APIs) and **advanced analytics** (agent performance dashboards, session explorer, trace viewer, and custom dimensions). If your agents need to call external APIs or you require visibility into agent performance beyond basic session counts, the Professional plan is the minimum tier needed.

### When to Upgrade: Decision Framework

| Business Need                                           | Required Plan | Why                                       |
| ------------------------------------------------------- | ------------- | ----------------------------------------- |
| Connect agents to your CRM or ticketing system          | Professional  | Connectors are Professional+ only         |
| View detailed performance dashboards and session traces | Professional  | Advanced analytics are Professional+ only |
| Apply guardrails for content safety and PII protection  | Professional  | Guardrails are Professional+ only         |
| Enforce SSO through your corporate identity provider    | Enterprise    | SAML/OIDC SSO is Enterprise only          |
| Bring your own encryption keys (BYOK)                   | Enterprise    | KMS is Enterprise only                    |
| Require a 99.95% uptime SLA                             | Enterprise    | Standard Professional SLA is 99.9%        |

## Cost Controls: Budgets, Windows, and Alerts

Running AI agents in production requires disciplined cost management. The platform provides multiple layers of protection against unexpected spending.

### Token Budget Hierarchy

| Budget Level           | Scope     | Purpose                              |
| ---------------------- | --------- | ------------------------------------ |
| Monthly token budget   | Workspace | Cap total spending per billing cycle |
| **Daily token budget** | Workspace | Prevent single-day runaway costs     |
| Per-project budget     | Project   | Allocate spend across teams          |
| Per-user budget        | User      | Control individual usage             |

> **Key Concept**: **Daily token budgets combined with sliding window alerts** provide the most effective cost protection. Set the daily budget to a fraction of your monthly allocation (for example, if your monthly budget is 50M tokens, set the daily limit to 2M). Then configure **sliding window alerts** at thresholds like 50%, 80%, and 95% of the daily budget. This gives your operations team progressively urgent notifications as spending approaches the limit, with time to investigate before the budget is exhausted.

### Alert Configuration

The platform supports three types of cost-related alerts:

| Alert Type          | What It Monitors                                    | Recommended Threshold   |
| ------------------- | --------------------------------------------------- | ----------------------- |
| **Usage threshold** | Percentage of monthly token budget consumed         | Notify at 80%           |
| **Credit low**      | Remaining credit balance (for credit-based billing) | Notify at 20% remaining |
| **Health degraded** | LLM provider connection performance                 | Immediate notification  |

Configure alerts at **Settings > Account > Billing > Alerts**. Each alert can notify via email or webhook, enabling integration with your existing incident management tools.

### Cost Optimization Strategies

1. **Tier-based routing** -- Route simple tasks (classification, validation) to Fast-tier models at 10x lower cost than Powerful-tier
2. **Conversation sliding windows** -- For long-running sessions, limit the history sent to the LLM to reduce input token costs
3. **Monthly agent review** -- Identify agents with unexpectedly high per-session token counts and optimize their configurations
4. **Archive inactive projects** -- Deployed agents in dormant projects may still consume resources from scheduled tasks or webhook-triggered sessions

## Enterprise SLA: What 99.95% Means

> **Key Concept**: The **Enterprise plan guarantees a 99.95% SLA**, which translates to a maximum of approximately 22 minutes of downtime per month or 4.4 hours per year. The Professional plan offers 99.9% (approximately 44 minutes per month). For business-critical deployments where agent downtime directly impacts revenue or customer satisfaction, the Enterprise SLA provides the contractual assurance your stakeholders require.

| Plan           | SLA        | Max Monthly Downtime | Max Annual Downtime |
| -------------- | ---------- | -------------------- | ------------------- |
| Starter        | None       | Not guaranteed       | Not guaranteed      |
| Professional   | 99.9%      | ~44 minutes          | ~8.8 hours          |
| **Enterprise** | **99.95%** | **~22 minutes**      | **~4.4 hours**      |

Enterprise plans also include dedicated support, custom capacity limits, and configurable data retention periods -- critical for organizations operating in regulated industries.

## Channels: One Agent, Multiple Platforms

The Agent Platform uses a **channel adapter architecture** that separates agent logic from delivery platforms. This means you build your agent once and deploy it across web, messaging, voice, and email channels without modification.

> **Key Concept**: A **single agent serves multiple channel adapters** simultaneously. The same customer support agent can handle conversations via your website chat widget, Slack workspace, WhatsApp Business account, Microsoft Teams, and phone calls -- all at the same time, all using the same agent definition. Channel adapters handle the protocol-specific details (message format, authentication, media handling) while your agent focuses on the business logic.

### Supported Channels at a Glance

| Channel                    | Key Capability                                           | Typical Use Case                     |
| -------------------------- | -------------------------------------------------------- | ------------------------------------ |
| **Web SDK**                | Embeddable chat widget with voice support                | Website and web application support  |
| **Slack**                  | Threaded replies, slash commands, interactive components | Internal team assistants             |
| **WhatsApp Business**      | Interactive lists, buttons, media support                | Customer-facing messaging            |
| **Microsoft Teams**        | Adaptive Cards for rich, interactive content             | B2B collaboration and enterprise use |
| **Voice (Jambonz/Twilio)** | Speech-to-text, text-to-speech, SSML                     | Phone-based customer support         |
| **Telegram**               | Inline keyboards, media messages                         | Community and customer engagement    |
| **Email (SMTP)**           | Inbound/outbound email handling                          | Support ticket automation            |

### Channel-Specific Content: Rich Responses

The platform supports channel-optimized content delivery. When an agent sends a response, the runtime selects the format that matches the connected channel. If a channel-specific format is not available, it falls back to the plain text response.

| Format               | Channel             | Business Value                                                  |
| -------------------- | ------------------- | --------------------------------------------------------------- |
| Markdown tables      | Web SDK             | Clean data presentation                                         |
| **Adaptive Cards**   | **Microsoft Teams** | Rich interactive cards for approvals, summaries, and data entry |
| Slack Block Kit      | Slack               | Formatted messages with sections, buttons, and menus            |
| Interactive messages | WhatsApp            | Buttons and lists for guided conversations                      |
| Carousels            | Web, WhatsApp       | Scrollable product or option cards                              |
| SSML                 | Voice               | Precise speech control (pace, emphasis, pronunciation)          |

> **Key Concept**: **Teams Adaptive Cards** are particularly valuable for **B2B scenarios**. They let your agents send structured, interactive content -- booking confirmations with fact sets, approval workflows with action buttons, status dashboards with formatted data -- directly within the Teams interface. This makes your agent a natural part of your enterprise collaboration workflow, delivering rich experiences where your team already works.

### How Channel Routing Works

Each channel connection is bound to a specific environment (development, staging, or production) and can be configured to **auto-follow** deployments. When you create a new deployment for an environment, auto-follow channels automatically point to the new version. This means:

1. Deploy a new agent version to the `production` environment
2. All production channels (web widget, Slack, WhatsApp) automatically start using the new version
3. Existing sessions on the previous version continue to completion (graceful draining)

### Channel-Specific Limits

Different platforms impose their own constraints:

| Channel         | Message Size      | Media Size                   | Notes                           |
| --------------- | ----------------- | ---------------------------- | ------------------------------- |
| Slack           | 40,000 characters | 1 GB                         | Platform rate tier 3            |
| Microsoft Teams | 28 KB             | 10 MB                        | 2 messages/sec per conversation |
| WhatsApp        | 4,096 characters  | 16 MB (media), 100 MB (docs) | Per Meta policies               |
| Web SDK         | No platform limit | 25 MB (uploads)              | Workspace rate limit applies    |

## Key Takeaways

- The Professional plan upgrade unlocks connectors, advanced analytics, and guardrails -- essential for production deployments that integrate with external systems
- Daily token budgets combined with sliding window alerts provide the most effective cost protection, preventing runaway spending before it impacts your monthly allocation
- The Enterprise plan's 99.95% SLA guarantees a maximum of approximately 22 minutes of monthly downtime for business-critical deployments
- A single agent definition serves multiple channels simultaneously through channel adapters, with no per-channel agent modifications required
- Teams Adaptive Cards enable rich, interactive experiences for B2B collaboration, making agents a natural part of enterprise workflows

## What's Next

Continue to **Quality Assurance** to learn how to test your agents systematically, evaluate response quality with LLM judges, and configure guardrails for production safety.
