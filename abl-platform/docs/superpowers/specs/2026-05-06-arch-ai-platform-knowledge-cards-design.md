# Arch AI Platform Knowledge Cards — Design Spec

> **Date:** 2026-05-06
> **Goal:** Make Arch AI fully platform-aware and intelligent across all feature areas — not just ABL authoring. Arch should understand what exists, how it works, and how to act (or inform the user) for channels, deployments, auth profiles, connections, knowledge bases, workflows, external agents, and more.
> **Approach:** Three-tier knowledge architecture with increased token budget, auto-generated factual cards, hand-written expertise cards, and on-demand docs search.

---

## 1. Problem Statement

Arch AI currently has 30 knowledge cards — all focused on ABL language constructs (gather fields, flow patterns, handoff contracts, etc.). This makes Arch an expert agent _author_ but leaves it unable to assist with:

- Channel setup (22 channel types: Slack, WhatsApp, Voice, SDK, A2A, etc.)
- Deployment lifecycle (environments, promotion, rollback)
- Auth profile management (7 auth types, OAuth flows, credential validation)
- Connections & integrations (connector catalog, external agents)
- Knowledge base administration (embedding models, crawl config, vocabulary)
- Workflows (authoring, triggers, execution monitoring)
- Testing & evaluation (personas, scenarios, evaluators, batches)

Users on these pages get generic `search_docs` BM25 results instead of expert guidance. Arch cannot make intelligent recommendations or take confident action in these domains.

## 2. Three-Tier Knowledge Architecture

### Tier Overview

| Tier     | Name                         | Source                                          | Content                                                             | Token Size                        | Loaded                                        |
| -------- | ---------------------------- | ----------------------------------------------- | ------------------------------------------------------------------- | --------------------------------- | --------------------------------------------- |
| **L0**   | Platform Limits              | Hand-written (existing)                         | Hard limits, rate limits, quotas                                    | ~1,834 tokens                     | Always                                        |
| **L2-A** | Auto-generated Factual Cards | Built from `docs-internal/*.mdx`                | What exists, parameters, constraints, API shapes, examples          | 2,000-2,500 tokens each           | Intent-matched per turn                       |
| **L2-B** | Hand-written Expertise Cards | Engineering team                                | Decision trees, tool sequences, pitfalls, cross-feature connections | 2,000-3,000 tokens each           | Paired with L2-A or page-context              |
| **L3**   | search_docs (BM25 RAG)       | Live search over 1,422 chunks from 81 MDX files | Precise details, edge cases, step-by-step procedures                | Variable (fills remaining budget) | On-demand via tool call or automatic backfill |

### How They Work Together

**Example: User asks "Set up Slack for my project"**

1. Card router matches keywords → loads `channels-messaging` (L2-A: Slack credential fields, webhook path, capabilities) + `channels-operations` (L2-B: decision tree for single vs multi-workspace, tool sequence, pitfalls)
2. Arch understands deeply → asks about OAuth vs bot token, warns about event subscriptions
3. Arch acts → `collect_secret` for bot_token and signing_secret, then `channel_ops(action: "create")`
4. User asks edge case ("how do slash commands work?") → Arch calls `search_docs("slack slash commands")` → gets precise procedure from L3

**Example: User is on Deployments page, asks "what should I do?"**

1. Page context triggers → loads `deployments-lifecycle` (L2-A: environments, promotion flow) + `deployment-operations` (L2-B: when to promote vs rollback, pre-deploy checklist)
2. Arch understands project state → checks `deployment_ops(action: "list")` to see current deployments
3. Arch recommends → "You have agents in dev but nothing in staging. Want me to create a staging deployment?"

## 3. New Card Catalog

### L2-A: Auto-Generated Factual Cards (12 cards)

| Card ID                    | Source MDX Files                                                                          | Domain          | Key Content                                                                                                                                |
| -------------------------- | ----------------------------------------------------------------------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `channels-overview`        | `guides/channels.mdx`                                                                     | All channels    | 22 channel types by category, capabilities matrix, general setup pattern                                                                   |
| `channels-messaging`       | `guides/channels.mdx` (Slack, WhatsApp, Teams, Telegram sections)                         | Messaging       | Per-provider credential fields, webhook URLs, OAuth vs token auth, rich content support                                                    |
| `channels-voice`           | `guides/channels.mdx` (Voice section)                                                     | Voice           | S2S providers (LiveKit, OpenAI, Grok, Google), pipeline (Twilio, Jambonz), VXML, AudioCodes, SIP config                                    |
| `channels-sdk`             | `api-reference/sdks.mdx`                                                                  | SDK             | Web/Mobile/API SDK setup, embed token generation, CORS, theming, React hooks                                                               |
| `deployments-lifecycle`    | `guides/publishing-and-operations.mdx`                                                    | Deployments     | Environments (dev/staging/prod), versioning, deployment creation, promotion, rollback, variable snapshots                                  |
| `auth-profiles`            | `admin/security-and-authentication.mdx` + `guides/tools-and-integrations.mdx`             | Auth            | 7 auth types (api_key, bearer, oauth2_app, oauth2_token, oauth2_client_credentials, azure_ad, none), credential schemas, validation        |
| `connections-integrations` | `studio/tools-knowledge-connections.mdx`                                                  | Connections     | Connector catalog (CRM, storage, communication, ticketing, agent desktop), creation flow, status lifecycle                                 |
| `kb-administration`        | `guides/knowledge-bases.mdx`                                                              | Knowledge Bases | KB creation, embedding models, chunking strategies, ingestion methods, connectors (Confluence, SharePoint, web crawler), search strategies |
| `workflows-authoring`      | `studio/tools-knowledge-connections.mdx` (Workflows)                                      | Workflows       | Node types, trigger config, YAML syntax, execution model, human-in-the-loop approvals                                                      |
| `testing-evals`            | `guides/testing-and-evaluation.mdx`                                                       | Evaluations     | Personas (AI-generated, adversarial), scenarios, LLM judge evaluators, eval batches, regression detection, CI integration                  |
| `api-management`           | `api-reference/management-apis.mdx`                                                       | APIs            | Agent management API, deployment API, tool secrets API, callback API with HMAC verification                                                |
| `external-agents-a2a`      | `examples/orchestration-and-integration.mdx` + `api-reference/channels.mdx` (A2A section) | External Agents | A2A protocol, agent card registration, REST agent endpoints, connection testing, health checks                                             |

### L2-B: Hand-Written Expertise Cards (7 cards)

| Card ID                     | Domain                    | Key Content                                                                                                                                                                                                          |
| --------------------------- | ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `channels-operations`       | All channel actions       | Decision tree (which channel type for which use case), tool sequence (list_types → collect_secret → create → test → bind_env), pitfalls per provider, cross-feature connections (channel → deployment → environment) |
| `deployment-operations`     | Deployment lifecycle      | When to promote vs stay in dev, pre-promotion checklist (all agents compiled? tests passing?), rollback decision criteria, environment variable strategy, channel binding patterns                                   |
| `auth-operations`           | Auth profile management   | Auth type selection guide (when to use each of the 7 types), secret collection flow (collect_secret → auth_ops), validation patterns, consumer impact check before delete, OAuth flow guidance                       |
| `connection-operations`     | Integration wiring        | Connector selection by use case, credential patterns per category, test-before-save pattern, error recovery (expired OAuth tokens), how connections wire into tools and KB connectors                                |
| `kb-operations`             | Knowledge base management | Source management strategy (when to use file upload vs crawl vs connector), embedding model selection guide, chunk size tuning, vocabulary management, search strategy recommendations by content type               |
| `external-agent-operations` | External agent registry   | Registration patterns (A2A vs REST), health check configuration, agent card discovery, connection testing workflow, how external agents participate in handoff topology                                              |
| `project-lifecycle`         | Cross-cutting guidance    | End-to-end project maturity roadmap (build agents → configure tools → test → deploy → monitor), "what should I do next" recommendations based on project state, common anti-patterns at each stage                   |

### Existing Cards (30, unchanged)

All existing ABL cards in `cards/generated/` remain unchanged. They continue to handle agent authoring, flow design, gather fields, handoff contracts, memory, constraints, guardrails, etc.

## 4. Card Router Updates

### Dual-Signal Routing

The card router gains a second input signal: **page context**. Currently it only matches user message keywords.

```typescript
interface CardRouteRule {
  id: string;
  // Existing: keyword patterns against user message
  patterns: RegExp[];
  // NEW: page context match (if user is on this page, load card regardless of message)
  pageMatch?: {
    page?: ProjectPage | ProjectPage[];
    tab?: string;
    entityType?: string;
  };
  // NEW: always co-load this expertise card when this factual card is selected
  pairedExpertise?: string;
}
```

### Routing Rules

```typescript
// Channels
{ id: 'channels-overview', patterns: [/\b(channel|channels|deploy.*agent|go\s+live)\b/i], pageMatch: { page: 'deployments' }, pairedExpertise: 'channels-operations' },
{ id: 'channels-messaging', patterns: [/\b(slack|whatsapp|teams|telegram|messenger|line|instagram|zendesk|sms)\b/i], pairedExpertise: 'channels-operations' },
{ id: 'channels-voice', patterns: [/\b(voice|livekit|twilio|audiocodes|sip|vxml|s2s|realtime\s+voice|phone)\b/i], pairedExpertise: 'channels-operations' },
{ id: 'channels-sdk', patterns: [/\b(sdk|web\s+sdk|mobile\s+sdk|embed|widget|api\s+sdk|chat\s+widget)\b/i], pairedExpertise: 'channels-operations' },

// Deployments
{ id: 'deployments-lifecycle', patterns: [/\b(deploy|promote|rollback|retire|environment|staging|production|version|go\s+live)\b/i], pageMatch: { page: 'deployments' }, pairedExpertise: 'deployment-operations' },

// Auth
{ id: 'auth-profiles', patterns: [/\b(auth\s+profile|oauth|api[_\s]key|bearer|client[_\s]secret|client[_\s]id|azure[_\s]ad|credential|mTLS)\b/i], pageMatch: { page: 'settings-auth-profiles' }, pairedExpertise: 'auth-operations' },

// Connections
{ id: 'connections-integrations', patterns: [/\b(connection|connector|integration|salesforce|hubspot|google\s+drive|sharepoint|jira|servicenow|dropbox)\b/i], pageMatch: { page: 'connections' }, pairedExpertise: 'connection-operations' },

// Knowledge Bases
{ id: 'kb-administration', patterns: [/\b(knowledge\s+base|kb|ingest|embedding|chunk|crawler|sync|source|vector|semantic\s+search)\b/i], pageMatch: { page: 'search-ai' }, pairedExpertise: 'kb-operations' },

// Workflows
{ id: 'workflows-authoring', patterns: [/\b(workflow|node|trigger|human\s+task|approval|yaml\s+flow|workflow\s+step)\b/i], pageMatch: { page: 'workflows' } },

// Testing
{ id: 'testing-evals', patterns: [/\b(eval|test\s+persona|scenario|evaluator|judge|regression|batch\s+eval|eval\s+set)\b/i], pageMatch: { page: ['evals', 'experiments'] } },

// API
{ id: 'api-management', patterns: [/\b(management\s+api|deployment\s+api|tool\s+secret|callback\s+api|hmac)\b/i] },

// External Agents
{ id: 'external-agents-a2a', patterns: [/\b(external\s+agent|a2a|register\s+agent|agent\s+card|remote\s+agent)\b/i], pageMatch: { page: 'external-agents' }, pairedExpertise: 'external-agent-operations' },

// Project Lifecycle (expertise-only, no factual pair — triggered broadly)
{ id: 'project-lifecycle', patterns: [/\b(what\s+should\s+I|next\s+step|ready\s+to\s+deploy|project\s+status|what'?s\s+missing)\b/i], pageMatch: { page: 'overview' } },
```

### Expertise Pairing Logic

When a factual card is selected, its paired expertise card is **always co-loaded** as a unit:

```typescript
const EXPERTISE_PAIRS: Record<string, string> = {
  'channels-overview': 'channels-operations',
  'channels-messaging': 'channels-operations',
  'channels-voice': 'channels-operations',
  'channels-sdk': 'channels-operations',
  'deployments-lifecycle': 'deployment-operations',
  'auth-profiles': 'auth-operations',
  'connections-integrations': 'connection-operations',
  'kb-administration': 'kb-operations',
  'external-agents-a2a': 'external-agent-operations',
};
```

### Priority Order

When multiple cards match (common when user asks about deploying a channel):

1. **Page-context matched cards** — highest priority (user is looking at the feature)
2. **Expertise cards** — operational judgment takes priority over raw facts
3. **Factual cards** — detailed knowledge
4. **Existing ABL cards** — agent authoring knowledge
5. **L3 BM25 backfill** — fills remaining budget

### L3 Deduplication

The `_mapping.ts` file is extended with the new cards' source MDX files, ensuring L3 doesn't inject chunks that are already covered by a loaded L2 card:

```typescript
// New entries in CARD_FILE_COVERAGE
'channels-overview': ['guides/channels.mdx'],
'channels-messaging': ['guides/channels.mdx'],
'channels-voice': ['guides/channels.mdx'],
'channels-sdk': ['api-reference/sdks.mdx'],
'deployments-lifecycle': ['guides/publishing-and-operations.mdx'],
'auth-profiles': ['admin/security-and-authentication.mdx'],
'connections-integrations': ['studio/tools-knowledge-connections.mdx'],
'kb-administration': ['guides/knowledge-bases.mdx'],
'testing-evals': ['guides/testing-and-evaluation.mdx'],
'api-management': ['api-reference/management-apis.mdx'],
'external-agents-a2a': ['examples/orchestration-and-integration.mdx'],
```

## 5. Token Budget & Performance

### Budget Change

| Setting                | Current | Proposed | Location                                        |
| ---------------------- | ------- | -------- | ----------------------------------------------- |
| `MAX_KNOWLEDGE_TOKENS` | 6,000   | 14,000   | `packages/arch-ai/src/knowledge/card-router.ts` |

### Typical Turn Breakdown

```
System prompt (specialist + rules)         ~3,000 tokens
L0 platform-limits (always)                ~1,834 tokens
L2 cards (2-3 cards: factual + expertise)  ~5,000-7,000 tokens
L3 BM25 backfill                           ~3,000-5,000 tokens
Page context                                 ~200 tokens
Project memory                               ~500 tokens
Conversation history (sliding window)     ~8,000-12,000 tokens
─────────────────────────────────────────────────────────────
Total input                              ~22,000-30,000 tokens
```

Against limits:

- Model context: 128K-200K → uses 15-23% ✓
- `MAX_TOKENS_PER_TURN`: 150,000 → uses ~23% (input + output) ✓
- No latency impact: card selection is <2ms, all build-time ✓

### Cache Efficiency

LLM prompt caching works with stable prefixes. System prompt + L0 + L2 cards form a ~10-12K stable prefix that gets cached across turns within the same topic. Cache hits on ~40-50% of input tokens for multi-turn conversations.

### Graceful Degradation

If budget is exceeded:

1. Drop L3 backfill (Arch can `search_docs` on demand)
2. Keep L2-B expertise cards, trim L2-A factual cards
3. Never drop L0
4. Log `skippedIds` for observability

## 6. Generation Pipeline

### File Structure

```
packages/arch-ai/src/knowledge/
├── cards/
│   ├── generated/          # Existing 30 ABL cards (unchanged)
│   ├── platform/           # NEW: 12 auto-generated platform cards
│   └── expertise/          # NEW: 7 hand-written expertise cards
├── card-router.ts          # Updated: new rules, page context, pairing
├── _mapping.ts             # Updated: new deduplication entries
├── l3-index.json           # Unchanged
├── l3-search.ts            # Unchanged
└── platform-limits.ts      # Unchanged (L0)

tools/arch-knowledge/
├── generate-platform-cards.ts    # NEW: Generator script
├── card-configs/                 # NEW: Per-card extraction configs
│   ├── channels-overview.yaml
│   ├── channels-messaging.yaml
│   ├── channels-voice.yaml
│   ├── channels-sdk.yaml
│   ├── deployments-lifecycle.yaml
│   ├── auth-profiles.yaml
│   ├── connections-integrations.yaml
│   ├── kb-administration.yaml
│   ├── workflows-authoring.yaml
│   ├── testing-evals.yaml
│   ├── api-management.yaml
│   └── external-agents-a2a.yaml
└── transform.ts                  # NEW: MDX → compressed card content
```

### Card Config Format (YAML)

```yaml
# tools/arch-knowledge/card-configs/channels-messaging.yaml
id: channels-messaging
exportName: CHANNELS_MESSAGING_CARD
maxTokens: 2500
sources:
  - file: guides/channels.mdx
    headings:
      - 'Set Up Slack'
      - 'Set Up WhatsApp'
      - 'Rich Content'
      - 'File Attachments'
    priority: high
  - file: api-reference/channels.mdx
    headings:
      - 'Channel Connections'
      - 'Webhook Events'
    priority: medium
compress:
  - remove: troubleshooting sections
  - keep: code examples, credential field lists, webhook URLs
  - format: structured markdown (tables > prose)
```

### Generation Script

```bash
# Run manually or in CI
pnpm --filter @agent-platform/arch-ai generate:platform-cards

# CI trigger: when docs-internal/content/** changes
# Output: packages/arch-ai/src/knowledge/cards/platform/*.ts
```

The generator:

1. Reads each `.yaml` config
2. Parses referenced MDX files, strips JSX components
3. Extracts specified headings
4. Compresses content to fit `maxTokens` budget (prefers tables, removes verbose prose, keeps code blocks)
5. Outputs TypeScript file with `export const CARD_NAME = \`...\`` pattern
6. Validates output fits budget, warns if truncated

### Expertise Card Format (Hand-Written)

```typescript
// packages/arch-ai/src/knowledge/cards/expertise/channels-operations.ts
export const CHANNELS_OPERATIONS_CARD = `## Channels — Operational Guide

### Decision Tree: Which Channel Type?
| User Intent | Recommended Channel | Notes |
|-------------|-------------------|-------|
| Web chat widget | sdk_web | Simplest; embed code + API key |
| Mobile app | sdk_mobile | Same SDK, different embed |
| REST API integration | sdk_api or http_async | http_async for webhook-based |
| Slack bot | slack | Needs bot_token + signing_secret |
| WhatsApp business | whatsapp | Meta Business API or Infobip |
| Voice calls | voice_pipeline (telephony) or voice_realtime (S2S) | S2S = browser/app; pipeline = phone numbers |
| Agent-to-agent | a2a | A2A protocol, needs external agent registered |

### Tool Sequence: Create Channel
1. channel_ops(action: "list_types") — show options with capabilities
2. Ask user: which type + display name
3. If credentials required → for each credential field:
   - call collect_secret(fieldName, description)
4. channel_ops(action: "create", { channelType, displayName, credentials })
5. channel_ops(action: "test") — verify connection
6. Suggest: channel_ops(action: "bind_env", { environment: "dev" })

### Common Pitfalls
- Slack: signing_secret ≠ bot_token (users confuse them constantly)
- WhatsApp: Meta webhook verification needs channel active FIRST, then configure webhook
- Voice S2S: workspace-level voice service must be configured by admin BEFORE channel creation
- SDK Web: CORS origin domains must match or widget silently fails
- A2A: external agent must be registered + test-connection passing before channel works

### Cross-Feature Dependencies
- Channel → Deployment: must bind to environment to receive traffic
- Channel credentials → internally stored as encrypted auth profile
- Voice channels → require admin Voice Services config (LiveKit/Twilio keys)
- A2A channel → requires External Agent registry entry
- SDK channels → generate embed tokens via API keys

### When to Use search_docs
- Exact webhook payload format for a specific provider
- Provider-specific rate limits or message format constraints
- Troubleshooting a specific error code
- Multi-workspace Slack app configuration details
`;
```

## 7. Integration with New Tools (Future)

This knowledge card system is designed to work with the new tools identified in the gap analysis (`docs/analysis/arch-ai-full-coverage-gap-analysis.md`). The expertise cards reference tools that may not exist yet:

| Card References                          | Tool                 | Status      |
| ---------------------------------------- | -------------------- | ----------- |
| `channel_ops(action: "create")`          | `channel_ops`        | To be built |
| `deployment_ops(action: "promote")`      | `deployment_ops`     | To be built |
| `connection_ops(action: "test")`         | `connection_ops`     | To be built |
| `external_agent_ops(action: "register")` | `external_agent_ops` | To be built |

**Rollout order:**

1. Build knowledge cards FIRST (this spec) — Arch becomes platform-aware immediately
2. Build new tools SECOND — Arch gains ability to act
3. Until tools are built, expertise cards instruct Arch to inform the user what's possible and guide them through the Studio UI manually

This means partial value is delivered at step 1: Arch can already explain features, recommend approaches, and guide users — it just can't execute yet.

## 8. Success Criteria

| Criteria                                                                    | Measurement                                                |
| --------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Arch correctly answers channel setup questions without search_docs fallback | Card router selects appropriate channel card >90% of turns |
| Arch provides tool sequences for deployment/auth/connections                | Expertise card loaded when user is on relevant page        |
| No performance regression                                                   | First-token latency unchanged (within ±100ms)              |
| Token budget stays within model limits                                      | Total input <35K tokens in worst case                      |
| Cards stay fresh with docs changes                                          | CI regeneration on docs-internal changes; staleness <24h   |
| Existing ABL authoring intelligence preserved                               | All 30 existing cards unchanged, same routing patterns     |

## 9. Implementation Phases

| Phase       | Scope            | Deliverable                                                                                                                           |
| ----------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| **Phase 1** | Infrastructure   | Generation pipeline (`tools/arch-knowledge/`), card router refactor (page context, pairing, budget increase), new directory structure |
| **Phase 2** | L2-A Cards       | Generate 12 factual cards from docs-internal, update `_mapping.ts`, validate routing                                                  |
| **Phase 3** | L2-B Cards       | Write 7 expertise cards, wire pairing logic, validate budget math                                                                     |
| **Phase 4** | Testing & Tuning | Unit tests for routing, integration tests for card selection, manual QA of Arch responses across all feature areas                    |
| **Phase 5** | CI Integration   | Auto-regenerate L2-A cards when docs-internal changes, add to build pipeline                                                          |
