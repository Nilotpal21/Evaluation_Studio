# Publishing & Monitoring

> **Estimated time**: 16 minutes | **Prerequisites**: Quality Assurance

## Learning Objectives

After completing this module, you will be able to:

- Describe the deployment lifecycle and how rollback works
- Explain the staging environment validation workflow for safe production releases
- Navigate the Insights dashboard and interpret the Containment Rate metric
- Configure Git auto-deploy with branch-to-environment mapping
- Use the Insights cost breakdown to identify root causes of unexpected spending

## The Deployment Lifecycle

Publishing an agent means creating a versioned snapshot of your agent definitions and deploying it to a target environment. The platform manages deployments through a clear lifecycle that ensures safe transitions.

### Deployment Status Flow

Every deployment passes through three statuses:

| Status       | Meaning                                                        | What Happens                                       |
| ------------ | -------------------------------------------------------------- | -------------------------------------------------- |
| **Active**   | Receiving new sessions and serving traffic                     | This is your live deployment                       |
| **Draining** | No new sessions accepted; existing sessions complete naturally | Graceful wind-down after a new version is deployed |
| **Retired**  | Fully decommissioned, no traffic                               | Historical record only                             |

Only one deployment per environment can be active at a time. When you create a new deployment, the platform automatically transitions the previous active deployment to draining status.

### How Rollback Works

> **Key Concept**: **Rollback retires the current deployment and reactivates the previous one.** When a new deployment causes issues -- degraded quality, errors, or unexpected behavior -- you can roll back with a single click. The platform retires the problematic deployment (stopping new sessions), then reactivates the previous deployment (resuming it as the active version). Existing sessions on the problematic version continue to completion, while all new sessions are routed to the restored version.

The rollback process:

1. Navigate to **Deployments** in Studio
2. Find the problematic deployment
3. Click **Rollback**
4. The current deployment moves to `retired` status
5. The previous deployment moves back to `active` status
6. New sessions immediately begin using the restored version

Rollback is also available via API, enabling automated rollback in your CI/CD pipeline when monitoring detects issues.

### Version Management

Before deploying, you create versioned snapshots of each agent. Versions capture the compiled agent definition at a point in time. Key aspects:

- Versions with compilation errors are rejected at creation time
- Each deployment includes a **version manifest** mapping every agent name to a specific version
- You can use `auto` versioning to create snapshots from the current working copy during deployment

## The Staging Environment Validation Workflow

The platform supports three built-in environments per project, designed for a progressive release process:

| Environment    | Purpose                                                 | Typical Configuration                   |
| -------------- | ------------------------------------------------------- | --------------------------------------- |
| **dev**        | Active development and Studio testing                   | Sandbox API endpoints, debug logging    |
| **staging**    | Pre-production validation with production-like settings | Production-like endpoints, info logging |
| **production** | Live traffic from end users                             | Real API endpoints, warn-level logging  |

> **Key Concept**: The **staging environment validation workflow** is your safety gate before production. Deploy your agent to staging first, run your eval sets against the staging deployment, validate that channel connections work correctly, and verify performance metrics meet your thresholds. Only after staging validation passes should you promote to production. Environment variables let you use production-like API endpoints in staging while keeping test credentials separate.

### Recommended Validation Workflow

1. **Deploy to staging** -- Create a deployment with pinned agent versions in the staging environment
2. **Run evaluation sets** -- Execute your quality eval sets against the staging deployment and check for regressions against your baseline
3. **Test channels** -- Verify that channel connections (web widget, Slack, WhatsApp) route correctly to the staging deployment
4. **Check environment variables** -- Ensure all required environment variables are defined for the staging environment (missing variables generate warnings during deployment)
5. **Review performance** -- Run representative conversations and check response latency, token usage, and error rates
6. **Promote to production** -- Use the promote API or create a new production deployment with the validated versions

### Environment Variables Across Environments

Environment variables let you change agent behavior per environment without modifying agent definitions. Common patterns:

| Variable           | Development      | Staging          | Production          |
| ------------------ | ---------------- | ---------------- | ------------------- |
| `API_BASE_URL`     | Sandbox endpoint | Staging endpoint | Production endpoint |
| `LOG_LEVEL`        | debug            | info             | warn                |
| `FEATURE_NEW_FLOW` | true             | true             | false               |

Variables are resolved at session start. New sessions pick up the latest values; existing sessions retain the values from when they were created.

## Git Auto-Deploy

For teams that manage agent definitions in source control, the platform supports Git integration with automatic deployments.

### Branch-to-Environment Mapping

> **Key Concept**: **Git auto-deploy with branch-to-environment mapping** lets you connect Git branches directly to platform environments. The typical setup maps `develop` to `dev`, `staging` to `staging`, and `main` to `production`. When code is pushed to a configured branch, the platform automatically pulls the latest files, validates and compiles all agents, creates auto-versioned snapshots, and creates a new deployment in the target environment.

| Branch    | Auto-Deploys To        | Trigger                                 |
| --------- | ---------------------- | --------------------------------------- |
| `develop` | dev environment        | Push to develop                         |
| `staging` | staging environment    | Push to staging (or merge from develop) |
| `main`    | production environment | Push to main (or merge from staging)    |

This GitOps workflow means your deployment process follows the same branch and merge discipline as your other software projects. Pull requests, code reviews, and approval gates all apply naturally.

### Setting Up Auto-Deploy

1. Connect your Git repository in **Project Settings > Git Integration**
2. Authorize access (GitHub, GitLab, Bitbucket, or generic SSH/token)
3. In the Git integration settings, expand **Auto-Deploy**
4. Toggle it on
5. Configure the branch-to-environment mapping
6. Optionally enable auto-sync to keep Studio and your repository in sync

The platform supports conflict resolution strategies (manual, local wins, or remote wins) for cases where changes are made in both Studio and the repository.

## Insights Dashboard: Monitoring Performance

The Insights dashboard provides an executive-level view of your AI agent program's health, performance, and cost profile.

### KPI Metric Cards

Five headline metrics appear at the top of the dashboard:

| Metric               | What It Measures                                         | Why It Matters                                        |
| -------------------- | -------------------------------------------------------- | ----------------------------------------------------- |
| **Sessions**         | Total conversation count in the selected period          | Volume indicator -- are users engaging?               |
| **Messages**         | Total messages exchanged                                 | Engagement depth -- how much interaction per session? |
| **Tokens**           | Total LLM tokens consumed                                | Primary cost driver                                   |
| **Estimated Cost**   | Computed cost based on token usage and model pricing     | Budget tracking                                       |
| **Containment Rate** | Percentage of sessions resolved without human escalation | Agent effectiveness                                   |

Each metric card includes a trend indicator showing percentage change compared to the previous period.

### Understanding Containment Rate

> **Key Concept**: **Containment Rate** is the percentage of sessions that the agent resolved **without requiring human escalation**. It is one of the most important metrics for measuring agent effectiveness. A containment rate of 85% means that out of every 100 conversations, 85 were fully handled by the agent while 15 required transfer to a human operator. Tracking containment rate over time tells you whether your agent improvements are actually reducing the burden on your human team.

Benchmarks for containment rate vary by domain:

- **FAQ and information retrieval**: 90-95% is typical
- **Transactional workflows** (booking, order status): 75-85% is good
- **Complex problem resolution**: 50-70% may be expected initially

A drop in containment rate after a deployment is a strong signal to investigate and potentially roll back.

### Cost Breakdown for Root Cause Analysis

> **Key Concept**: The **Insights cost breakdown table** groups spending by agent, showing each agent's session count, tokens consumed, and estimated cost. When you notice unexpected spending spikes, this table is your starting point for **root cause analysis**. Sort by cost to identify which agent is driving the spend, then drill into that agent's sessions to examine token usage per conversation. Common root causes include verbose system prompts, excessive tool calls, missing conversation sliding windows, or a recent model tier change to a more expensive model.

The cost breakdown helps answer questions like:

- Which agent is responsible for the spending spike?
- Has a specific agent's per-session cost increased after a recent change?
- Are there inactive agents still consuming resources?

### Additional Insights Pages

| Page                  | Focus                                                            | Business Value                       |
| --------------------- | ---------------------------------------------------------------- | ------------------------------------ |
| **Agent Performance** | Per-agent response times, completion rates, error frequencies    | Identify agents needing optimization |
| **Quality Monitor**   | Automated quality scoring and anomaly detection                  | Track quality trends over time       |
| **Customer Insights** | Intent distribution, sentiment trends, voice-of-customer signals | Understand user behavior patterns    |
| **Voice Analytics**   | Call volume, duration, STT accuracy, latency                     | Optimize voice channel performance   |

### Working with Date Ranges

All insights pages respect the selected date range:

- **7 days** -- Operational monitoring and quick health checks
- **30 days** -- Monthly reviews and reporting (default)
- **90 days** -- Trend analysis and strategic planning

Compare 30-day periods before and after agent changes to measure the impact of your improvements.

## Key Takeaways

- Rollback retires the current deployment and reactivates the previous one -- existing sessions drain gracefully while new sessions immediately use the restored version
- The staging environment validation workflow (deploy, evaluate, test channels, promote) is your safety gate before production releases
- Containment Rate measures the percentage of sessions resolved without human escalation -- the single most important metric for agent effectiveness
- Git auto-deploy with branch-to-environment mapping brings GitOps discipline to your agent deployment process, mapping branches like `develop`, `staging`, and `main` to their respective environments
- The Insights cost breakdown table is your starting point for root cause analysis when unexpected spending spikes occur -- sort by cost to identify the responsible agent

## What's Next

Continue to **Content & Trust** to learn about rich content delivery across channels, encryption architecture, and data protection standards.
