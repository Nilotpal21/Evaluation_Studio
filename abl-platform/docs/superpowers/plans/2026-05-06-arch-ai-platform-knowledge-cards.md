# Arch AI Platform Knowledge Cards — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add 19 new knowledge cards (12 auto-generated factual + 7 hand-written expertise) to Arch AI, with page-context routing, expertise pairing, and a 14K token budget — making Arch fully platform-aware for channels, deployments, auth, connections, KB admin, workflows, and external agents.

**Architecture:** Extend the existing `tools/abl-docs/` generation pipeline with platform card configs. Refactor `card-router.ts` to support dual-signal routing (keywords + page context) and expertise pairing. Add new card directories under `packages/arch-ai/src/knowledge/cards/`.

**Tech Stack:** TypeScript, Vitest, existing `tools/abl-docs/card-generator.ts` + `card-mapping.ts` patterns, `docs-internal/*.mdx` content source.

---

## File Structure

### New Files

- `tools/abl-docs/platform-card-mapping.ts` — Card mapping entries for 12 platform cards (same interface as existing `card-mapping.ts`)
- `packages/arch-ai/src/knowledge/cards/platform/channels-overview.ts` — Auto-generated
- `packages/arch-ai/src/knowledge/cards/platform/channels-messaging.ts` — Auto-generated
- `packages/arch-ai/src/knowledge/cards/platform/channels-voice.ts` — Auto-generated
- `packages/arch-ai/src/knowledge/cards/platform/channels-sdk.ts` — Auto-generated
- `packages/arch-ai/src/knowledge/cards/platform/deployments-lifecycle.ts` — Auto-generated
- `packages/arch-ai/src/knowledge/cards/platform/auth-profiles.ts` — Auto-generated
- `packages/arch-ai/src/knowledge/cards/platform/connections-integrations.ts` — Auto-generated
- `packages/arch-ai/src/knowledge/cards/platform/kb-administration.ts` — Auto-generated
- `packages/arch-ai/src/knowledge/cards/platform/workflows-authoring.ts` — Auto-generated
- `packages/arch-ai/src/knowledge/cards/platform/testing-evals.ts` — Auto-generated
- `packages/arch-ai/src/knowledge/cards/platform/api-management.ts` — Auto-generated
- `packages/arch-ai/src/knowledge/cards/platform/external-agents-a2a.ts` — Auto-generated
- `packages/arch-ai/src/knowledge/cards/platform/index.ts` — Barrel export
- `packages/arch-ai/src/knowledge/cards/expertise/channels-operations.ts` — Hand-written
- `packages/arch-ai/src/knowledge/cards/expertise/deployment-operations.ts` — Hand-written
- `packages/arch-ai/src/knowledge/cards/expertise/auth-operations.ts` — Hand-written
- `packages/arch-ai/src/knowledge/cards/expertise/connection-operations.ts` — Hand-written
- `packages/arch-ai/src/knowledge/cards/expertise/kb-operations.ts` — Hand-written
- `packages/arch-ai/src/knowledge/cards/expertise/external-agent-operations.ts` — Hand-written
- `packages/arch-ai/src/knowledge/cards/expertise/project-lifecycle.ts` — Hand-written
- `packages/arch-ai/src/knowledge/cards/expertise/index.ts` — Barrel export
- `packages/arch-ai/src/__tests__/platform-card-routing.test.ts` — Routing tests
- `packages/arch-ai/src/__tests__/platform-card-budget.test.ts` — Budget tests

### Modified Files

- `tools/abl-docs/card-mapping.ts` — Export existing as `ABL_CARD_MAPPINGS`, add `PLATFORM_CARD_MAPPINGS`
- `tools/abl-docs/shared.ts` — Import and generate platform cards alongside ABL cards
- `tools/abl-docs/card-generator.ts` — Increase `DEFAULT_MAX_TOKENS` to 2500 for platform cards (pass as param)
- `packages/arch-ai/src/knowledge/card-router.ts` — Add page context signal, expertise pairing, new card entries, budget increase
- `packages/arch-ai/src/knowledge/cards/_mapping.ts` — Add platform card file coverage entries
- `packages/arch-ai/src/knowledge/index.ts` — Re-export new cards

---

## Task 1: Increase Token Budget & Add PageContext to Card Router Interface

**Files:**

- Modify: `packages/arch-ai/src/knowledge/card-router.ts:58-67`
- Test: `packages/arch-ai/src/__tests__/platform-card-budget.test.ts`

- [ ] **Step 1: Write failing test for new budget**

```typescript
// packages/arch-ai/src/__tests__/platform-card-budget.test.ts
import { describe, expect, it } from 'vitest';
import { selectKnowledgeCards } from '../knowledge/card-router.js';

describe('Platform knowledge budget', () => {
  it('uses 14000 token default budget', () => {
    const result = selectKnowledgeCards('tell me about channels');
    // With 14K budget (56000 chars), should fit more than the old 6K limit
    expect(result.estimatedTokens).toBeLessThanOrEqual(14000);
  });

  it('accepts pageContext parameter', () => {
    const result = selectKnowledgeCards('what should I do?', undefined, undefined, {
      area: 'project',
      page: 'deployments',
    });
    expect(result.selectedIds).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/arch-ai && pnpm vitest run src/__tests__/platform-card-budget.test.ts`
Expected: FAIL — `selectKnowledgeCards` doesn't accept a 4th param yet

- [ ] **Step 3: Update card-router.ts — budget + interface**

In `packages/arch-ai/src/knowledge/card-router.ts`, change:

```typescript
/** Maximum tokens allocated to knowledge cards per request. */
const MAX_KNOWLEDGE_TOKENS = 14000;

interface PageContextInput {
  area?: string;
  page?: string;
  tab?: string;
  entityType?: string;
}

interface CardEntry {
  id: string;
  content: string;
  patterns: RegExp[];
  pageMatch?: {
    page?: string | string[];
    tab?: string;
    entityType?: string;
  };
  pairedExpertise?: string;
}
```

Update the `selectKnowledgeCards` signature:

```typescript
export function selectKnowledgeCards(
  userMessage?: string,
  maxTokens: number = MAX_KNOWLEDGE_TOKENS,
  forceCardIds?: string[],
  pageContext?: PageContextInput,
): CardSelection {
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/arch-ai && pnpm vitest run src/__tests__/platform-card-budget.test.ts`
Expected: PASS

- [ ] **Step 5: Run existing tests to verify no regression**

Run: `cd packages/arch-ai && pnpm vitest run src/__tests__/abl-contract-backed-knowledge.test.ts`
Expected: PASS (existing cards unchanged)

- [ ] **Step 6: Commit**

```bash
npx prettier --write packages/arch-ai/src/knowledge/card-router.ts packages/arch-ai/src/__tests__/platform-card-budget.test.ts
git add packages/arch-ai/src/knowledge/card-router.ts packages/arch-ai/src/__tests__/platform-card-budget.test.ts
git commit -m "$(cat <<'EOF'
[ABLP-162] feat(arch-ai): increase knowledge budget to 14K and add pageContext param

Card router now accepts optional pageContext for dual-signal routing.
Budget increased from 6000 to 14000 tokens to support deeper platform cards.
EOF
)"
```

---

## Task 2: Add Page-Context Matching Logic to Card Router

**Files:**

- Modify: `packages/arch-ai/src/knowledge/card-router.ts`
- Test: `packages/arch-ai/src/__tests__/platform-card-routing.test.ts`

- [ ] **Step 1: Write failing test for page-context routing**

```typescript
// packages/arch-ai/src/__tests__/platform-card-routing.test.ts
import { describe, expect, it } from 'vitest';
import { selectKnowledgeCards } from '../knowledge/card-router.js';

describe('Platform card routing — page context', () => {
  it('loads deployment card when user is on deployments page regardless of message', () => {
    const result = selectKnowledgeCards('what is this?', undefined, undefined, {
      area: 'project',
      page: 'deployments',
    });
    expect(result.selectedIds).toContain('deployments-lifecycle');
  });

  it('loads channels card when user is on deployments page', () => {
    const result = selectKnowledgeCards('how do I configure this?', undefined, undefined, {
      area: 'project',
      page: 'deployments',
    });
    expect(result.selectedIds).toContain('channels-overview');
  });

  it('loads kb-administration card when on search-ai page', () => {
    const result = selectKnowledgeCards('show me sources', undefined, undefined, {
      area: 'project',
      page: 'search-ai',
    });
    expect(result.selectedIds).toContain('kb-administration');
  });

  it('does not load page-context cards when user is on unrelated page', () => {
    const result = selectKnowledgeCards('what is this?', undefined, undefined, {
      area: 'project',
      page: 'agents',
    });
    expect(result.selectedIds).not.toContain('deployments-lifecycle');
    expect(result.selectedIds).not.toContain('channels-overview');
  });
});

describe('Platform card routing — keyword matching', () => {
  it('loads channels-messaging card on Slack keyword', () => {
    const result = selectKnowledgeCards('how do I set up Slack?');
    expect(result.selectedIds).toContain('channels-messaging');
  });

  it('loads auth-profiles card on OAuth keyword', () => {
    const result = selectKnowledgeCards('I need to configure OAuth for my tool');
    expect(result.selectedIds).toContain('auth-profiles');
  });

  it('loads deployments-lifecycle card on promote keyword', () => {
    const result = selectKnowledgeCards('how do I promote to production?');
    expect(result.selectedIds).toContain('deployments-lifecycle');
  });
});

describe('Platform card routing — expertise pairing', () => {
  it('co-loads channels-operations when channels-messaging is selected', () => {
    const result = selectKnowledgeCards('set up WhatsApp for my project');
    expect(result.selectedIds).toContain('channels-messaging');
    expect(result.selectedIds).toContain('channels-operations');
  });

  it('co-loads deployment-operations when deployments-lifecycle is selected', () => {
    const result = selectKnowledgeCards('I want to deploy to staging');
    expect(result.selectedIds).toContain('deployments-lifecycle');
    expect(result.selectedIds).toContain('deployment-operations');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/arch-ai && pnpm vitest run src/__tests__/platform-card-routing.test.ts`
Expected: FAIL — cards don't exist yet, routing logic not implemented

- [ ] **Step 3: Implement page-context matching in selectKnowledgeCards**

In the `selectKnowledgeCards` function body, add page-context matching BEFORE keyword matching:

```typescript
// Page-context matching — load cards associated with the current page
if (pageContext?.page) {
  for (const entry of CARD_REGISTRY) {
    if (!entry.pageMatch) continue;
    const pages = Array.isArray(entry.pageMatch.page)
      ? entry.pageMatch.page
      : entry.pageMatch.page
        ? [entry.pageMatch.page]
        : [];
    const pageMatches = pages.includes(pageContext.page);
    const tabMatches = !entry.pageMatch.tab || entry.pageMatch.tab === pageContext?.tab;
    if (pageMatches && tabMatches) {
      if (selectedIds.includes(entry.id)) continue;
      if (totalChars + entry.content.length > maxChars) {
        skippedIds.push(entry.id);
        continue;
      }
      parts.push(entry.content);
      selectedIds.push(entry.id);
      totalChars += entry.content.length;
    }
  }
}
```

Add expertise pairing AFTER all card selection (both page-context and keyword):

```typescript
// Expertise pairing — co-load paired expertise cards
const pairedToLoad: string[] = [];
for (const id of selectedIds) {
  const entry = CARD_REGISTRY.find((e) => e.id === id);
  if (entry?.pairedExpertise && !selectedIds.includes(entry.pairedExpertise)) {
    pairedToLoad.push(entry.pairedExpertise);
  }
}
for (const pairedId of pairedToLoad) {
  const entry = CARD_REGISTRY.find((e) => e.id === pairedId);
  if (!entry) continue;
  if (totalChars + entry.content.length > maxChars) {
    skippedIds.push(pairedId);
    continue;
  }
  parts.push(entry.content);
  selectedIds.push(pairedId);
  totalChars += entry.content.length;
}
```

- [ ] **Step 4: Add placeholder card entries to CARD_REGISTRY**

Add after the existing ABL cards section in `CARD_REGISTRY`:

```typescript
// ═══════════════════════════════════════════════════════════════
// Platform Cards (auto-generated from docs-internal)
// ═══════════════════════════════════════════════════════════════
{
  id: 'channels-overview',
  content: CHANNELS_OVERVIEW_CARD,
  patterns: [/\b(channel|channels|deploy.*agent|go\s+live)\b/i],
  pageMatch: { page: 'deployments' },
  pairedExpertise: 'channels-operations',
},
{
  id: 'channels-messaging',
  content: CHANNELS_MESSAGING_CARD,
  patterns: [/\b(slack|whatsapp|teams|telegram|messenger|line|instagram|zendesk|sms)\b/i],
  pairedExpertise: 'channels-operations',
},
{
  id: 'channels-voice',
  content: CHANNELS_VOICE_CARD,
  patterns: [/\b(voice|livekit|twilio|audiocodes|sip|vxml|s2s|realtime\s+voice|phone)\b/i],
  pairedExpertise: 'channels-operations',
},
{
  id: 'channels-sdk',
  content: CHANNELS_SDK_CARD,
  patterns: [/\b(sdk|web\s+sdk|mobile\s+sdk|embed|widget|api\s+sdk|chat\s+widget)\b/i],
  pairedExpertise: 'channels-operations',
},
{
  id: 'deployments-lifecycle',
  content: DEPLOYMENTS_LIFECYCLE_CARD,
  patterns: [/\b(deploy|promote|rollback|retire|environment|staging|production|version|go\s+live)\b/i],
  pageMatch: { page: 'deployments' },
  pairedExpertise: 'deployment-operations',
},
{
  id: 'auth-profiles',
  content: AUTH_PROFILES_CARD,
  patterns: [/\b(auth\s+profile|oauth|api[_\s]key|bearer|client[_\s]secret|client[_\s]id|azure[_\s]ad|credential|mTLS)\b/i],
  pageMatch: { page: 'settings-auth-profiles' },
  pairedExpertise: 'auth-operations',
},
{
  id: 'connections-integrations',
  content: CONNECTIONS_INTEGRATIONS_CARD,
  patterns: [/\b(connection|connector|integration|salesforce|hubspot|google\s+drive|sharepoint|jira|servicenow|dropbox)\b/i],
  pageMatch: { page: 'connections' },
  pairedExpertise: 'connection-operations',
},
{
  id: 'kb-administration',
  content: KB_ADMINISTRATION_CARD,
  patterns: [/\b(knowledge\s+base|kb|ingest|embedding|chunk|crawler|sync|source|vector|semantic\s+search)\b/i],
  pageMatch: { page: 'search-ai' },
  pairedExpertise: 'kb-operations',
},
{
  id: 'workflows-authoring',
  content: WORKFLOWS_AUTHORING_CARD,
  patterns: [/\b(workflow|node|trigger|human\s+task|approval|yaml\s+flow|workflow\s+step)\b/i],
  pageMatch: { page: 'workflows' },
},
{
  id: 'testing-evals',
  content: TESTING_EVALS_CARD,
  patterns: [/\b(eval|test\s+persona|scenario|evaluator|judge|regression|batch\s+eval|eval\s+set)\b/i],
  pageMatch: { page: ['evals', 'experiments'] },
},
{
  id: 'api-management',
  content: API_MANAGEMENT_CARD,
  patterns: [/\b(management\s+api|deployment\s+api|tool\s+secret|callback\s+api|hmac)\b/i],
},
{
  id: 'external-agents-a2a',
  content: EXTERNAL_AGENTS_A2A_CARD,
  patterns: [/\b(external\s+agent|a2a|register\s+agent|agent\s+card|remote\s+agent)\b/i],
  pageMatch: { page: 'external-agents' },
  pairedExpertise: 'external-agent-operations',
},

// ═══════════════════════════════════════════════════════════════
// Expertise Cards (hand-written operational guides)
// ═══════════════════════════════════════════════════════════════
{
  id: 'channels-operations',
  content: CHANNELS_OPERATIONS_CARD,
  patterns: [/\b(set\s+up|configure|create)\b.*\b(channel|slack|whatsapp|voice)\b/i],
},
{
  id: 'deployment-operations',
  content: DEPLOYMENT_OPERATIONS_CARD,
  patterns: [/\b(how\s+to|ready\s+to|should\s+I)\b.*\b(deploy|promote|rollback)\b/i],
},
{
  id: 'auth-operations',
  content: AUTH_OPERATIONS_CARD,
  patterns: [/\b(set\s+up|configure|create)\b.*\b(auth|oauth|credential)\b/i],
},
{
  id: 'connection-operations',
  content: CONNECTION_OPERATIONS_CARD,
  patterns: [/\b(set\s+up|configure|create|connect)\b.*\b(integration|connector|connection)\b/i],
},
{
  id: 'kb-operations',
  content: KB_OPERATIONS_CARD,
  patterns: [/\b(set\s+up|configure|add|manage)\b.*\b(knowledge|kb|source|embedding)\b/i],
},
{
  id: 'external-agent-operations',
  content: EXTERNAL_AGENT_OPERATIONS_CARD,
  patterns: [/\b(register|set\s+up|configure)\b.*\b(external|a2a|remote)\s+agent\b/i],
},
{
  id: 'project-lifecycle',
  content: PROJECT_LIFECYCLE_CARD,
  patterns: [/\b(what\s+should\s+I|next\s+step|ready\s+to\s+deploy|project\s+status|what'?s\s+missing)\b/i],
  pageMatch: { page: 'overview' },
},
```

NOTE: The card content constants (`CHANNELS_OVERVIEW_CARD`, etc.) will be created in Tasks 3-5. For now, create temporary placeholder exports so the code compiles. These will be replaced by the generation step.

- [ ] **Step 5: Create temporary placeholder card files**

Create `packages/arch-ai/src/knowledge/cards/platform/index.ts`:

```typescript
// Placeholder — will be auto-generated by `pnpm abl:docs:generate`
export const CHANNELS_OVERVIEW_CARD =
  '## Channels Overview\n\nPlaceholder — run pnpm abl:docs:generate';
export const CHANNELS_MESSAGING_CARD = '## Channels — Messaging\n\nPlaceholder';
export const CHANNELS_VOICE_CARD = '## Channels — Voice\n\nPlaceholder';
export const CHANNELS_SDK_CARD = '## Channels — SDK\n\nPlaceholder';
export const DEPLOYMENTS_LIFECYCLE_CARD = '## Deployments Lifecycle\n\nPlaceholder';
export const AUTH_PROFILES_CARD = '## Auth Profiles\n\nPlaceholder';
export const CONNECTIONS_INTEGRATIONS_CARD = '## Connections & Integrations\n\nPlaceholder';
export const KB_ADMINISTRATION_CARD = '## Knowledge Base Administration\n\nPlaceholder';
export const WORKFLOWS_AUTHORING_CARD = '## Workflows\n\nPlaceholder';
export const TESTING_EVALS_CARD = '## Testing & Evaluations\n\nPlaceholder';
export const API_MANAGEMENT_CARD = '## API Management\n\nPlaceholder';
export const EXTERNAL_AGENTS_A2A_CARD = '## External Agents & A2A\n\nPlaceholder';
```

Create `packages/arch-ai/src/knowledge/cards/expertise/index.ts`:

```typescript
// Placeholder — will be hand-written in Task 5
export const CHANNELS_OPERATIONS_CARD = '## Channels Operations\n\nPlaceholder';
export const DEPLOYMENT_OPERATIONS_CARD = '## Deployment Operations\n\nPlaceholder';
export const AUTH_OPERATIONS_CARD = '## Auth Operations\n\nPlaceholder';
export const CONNECTION_OPERATIONS_CARD = '## Connection Operations\n\nPlaceholder';
export const KB_OPERATIONS_CARD = '## KB Operations\n\nPlaceholder';
export const EXTERNAL_AGENT_OPERATIONS_CARD = '## External Agent Operations\n\nPlaceholder';
export const PROJECT_LIFECYCLE_CARD = '## Project Lifecycle\n\nPlaceholder';
```

Add imports at top of `card-router.ts`:

```typescript
import {
  CHANNELS_OVERVIEW_CARD,
  CHANNELS_MESSAGING_CARD,
  CHANNELS_VOICE_CARD,
  CHANNELS_SDK_CARD,
  DEPLOYMENTS_LIFECYCLE_CARD,
  AUTH_PROFILES_CARD,
  CONNECTIONS_INTEGRATIONS_CARD,
  KB_ADMINISTRATION_CARD,
  WORKFLOWS_AUTHORING_CARD,
  TESTING_EVALS_CARD,
  API_MANAGEMENT_CARD,
  EXTERNAL_AGENTS_A2A_CARD,
} from './cards/platform/index.js';
import {
  CHANNELS_OPERATIONS_CARD,
  DEPLOYMENT_OPERATIONS_CARD,
  AUTH_OPERATIONS_CARD,
  CONNECTION_OPERATIONS_CARD,
  KB_OPERATIONS_CARD,
  EXTERNAL_AGENT_OPERATIONS_CARD,
  PROJECT_LIFECYCLE_CARD,
} from './cards/expertise/index.js';
```

- [ ] **Step 6: Run tests**

Run: `cd packages/arch-ai && pnpm vitest run src/__tests__/platform-card-routing.test.ts`
Expected: PASS (placeholders are short so they fit budget; routing logic selects them correctly)

- [ ] **Step 7: Run full test suite to verify no regression**

Run: `cd packages/arch-ai && pnpm vitest run`
Expected: All existing tests pass

- [ ] **Step 8: Commit**

```bash
npx prettier --write packages/arch-ai/src/knowledge/card-router.ts packages/arch-ai/src/knowledge/cards/platform/index.ts packages/arch-ai/src/knowledge/cards/expertise/index.ts packages/arch-ai/src/__tests__/platform-card-routing.test.ts
git add packages/arch-ai/src/knowledge/card-router.ts packages/arch-ai/src/knowledge/cards/platform/index.ts packages/arch-ai/src/knowledge/cards/expertise/index.ts packages/arch-ai/src/__tests__/platform-card-routing.test.ts
git commit -m "$(cat <<'EOF'
[ABLP-162] feat(arch-ai): add page-context routing and expertise pairing to card router

Card router now supports dual-signal routing: keyword patterns + page context.
Expertise cards are co-loaded when their paired factual card is selected.
Platform and expertise card placeholders added (will be generated/written in next commits).
EOF
)"
```

---

## Task 3: Extend Generation Pipeline for Platform Cards

**Files:**

- Create: `tools/abl-docs/platform-card-mapping.ts`
- Modify: `tools/abl-docs/shared.ts`
- Modify: `tools/abl-docs/card-generator.ts`

- [ ] **Step 1: Create platform card mapping**

```typescript
// tools/abl-docs/platform-card-mapping.ts
import type { CardMappingEntry } from './card-mapping.js';

export const PLATFORM_CARD_MAPPINGS: CardMappingEntry[] = [
  {
    id: 'channels-overview',
    exportName: 'CHANNELS_OVERVIEW_CARD',
    title: 'Channels — Types, Categories & Capabilities',
    maxTokens: 2500,
    sources: [
      {
        file: 'guides/channels.mdx',
        sections: ['Deploy on Web', 'Set Up Slack', 'Set Up WhatsApp', 'Set Up Voice'],
      },
    ],
  },
  {
    id: 'channels-messaging',
    exportName: 'CHANNELS_MESSAGING_CARD',
    title: 'Messaging Channels — Slack, WhatsApp, Teams, Telegram',
    maxTokens: 2500,
    sources: [
      { file: 'guides/channels.mdx', sections: ['Set Up Slack', 'Set Up WhatsApp'] },
      { file: 'guides/channels.mdx', sections: ['Rich Content'] },
    ],
  },
  {
    id: 'channels-voice',
    exportName: 'CHANNELS_VOICE_CARD',
    title: 'Voice Channels — S2S, Pipeline, VXML, AudioCodes',
    maxTokens: 2500,
    sources: [{ file: 'guides/channels.mdx', sections: ['Set Up Voice'] }],
  },
  {
    id: 'channels-sdk',
    exportName: 'CHANNELS_SDK_CARD',
    title: 'SDK Channels — Web, Mobile, API',
    maxTokens: 2500,
    sources: [
      {
        file: 'api-reference/sdks.mdx',
        sections: [
          'Web SDK',
          'Installation',
          'Quick start',
          'AgentSDK',
          'ChatClient',
          'VoiceClient',
          'React hooks',
          'Styling and theming',
          'API key management',
        ],
      },
    ],
  },
  {
    id: 'deployments-lifecycle',
    exportName: 'DEPLOYMENTS_LIFECYCLE_CARD',
    title: 'Deployments — Environments, Versioning, Promotion',
    maxTokens: 2500,
    sources: [
      {
        file: 'guides/publishing-and-operations.mdx',
        sections: ['Publish an Agent', 'Set Up Environments'],
      },
      { file: 'api-reference/management-apis.mdx', sections: ['Deployments'] },
    ],
  },
  {
    id: 'auth-profiles',
    exportName: 'AUTH_PROFILES_CARD',
    title: 'Auth Profiles — Types, Credentials, OAuth Flows',
    maxTokens: 2500,
    sources: [
      {
        file: 'admin/security-and-authentication.mdx',
        sections: ['Authentication for Integrations'],
      },
      { file: 'guides/tools-and-integrations.mdx', sections: ['OAuth Configuration'] },
    ],
  },
  {
    id: 'connections-integrations',
    exportName: 'CONNECTIONS_INTEGRATIONS_CARD',
    title: 'Connections — Connector Catalog & Integration Wiring',
    maxTokens: 2500,
    sources: [
      { file: 'studio/tools-knowledge-connections.mdx', sections: ['Connections', 'Workflows'] },
    ],
  },
  {
    id: 'kb-administration',
    exportName: 'KB_ADMINISTRATION_CARD',
    title: 'Knowledge Bases — Creation, Ingestion, Connectors, Search',
    maxTokens: 2500,
    sources: [{ file: 'guides/knowledge-bases.mdx' }],
  },
  {
    id: 'workflows-authoring',
    exportName: 'WORKFLOWS_AUTHORING_CARD',
    title: 'Workflows — Nodes, Triggers, Execution, Approvals',
    maxTokens: 2500,
    sources: [
      { file: 'studio/tools-knowledge-connections.mdx', sections: ['Workflows'] },
      { file: 'studio/testing-deployment-operations.mdx', sections: ['Operations'] },
    ],
  },
  {
    id: 'testing-evals',
    exportName: 'TESTING_EVALS_CARD',
    title: 'Testing & Evaluation — Personas, Scenarios, Judges, Batches',
    maxTokens: 2500,
    sources: [{ file: 'guides/testing-and-evaluation.mdx' }],
  },
  {
    id: 'api-management',
    exportName: 'API_MANAGEMENT_CARD',
    title: 'Management APIs — Agents, Deployments, Tools, Callbacks',
    maxTokens: 2500,
    sources: [{ file: 'api-reference/management-apis.mdx' }],
  },
  {
    id: 'external-agents-a2a',
    exportName: 'EXTERNAL_AGENTS_A2A_CARD',
    title: 'External Agents & A2A — Registration, Protocol, Health',
    maxTokens: 2500,
    sources: [
      { file: 'examples/orchestration-and-integration.mdx' },
      { file: 'api-reference/channels.mdx', sections: ['A2A'] },
    ],
  },
];
```

- [ ] **Step 2: Update shared.ts to generate platform cards**

In `tools/abl-docs/shared.ts`, add after the existing L2 card generation block (~line 252):

```typescript
import { PLATFORM_CARD_MAPPINGS } from './platform-card-mapping.js';
```

And in the `getGeneratedArtifacts` function, after the existing `generateAllCards` call, add:

```typescript
// L2 platform knowledge cards (channels, deployments, auth, etc.)
const platformCards = await generateAllCards(docsContentDir, PLATFORM_CARD_MAPPINGS);
for (const card of platformCards) {
  rawArtifacts.push({
    relativePath: `packages/arch-ai/src/knowledge/cards/platform/${card.fileName}`,
    content: card.tsSource,
  });
}
```

- [ ] **Step 3: Update card-generator.ts to accept custom mappings**

Change `generateAllCards` signature to accept an optional mappings parameter:

```typescript
export async function generateAllCards(
  contentDir: string,
  mappings?: CardMappingEntry[],
): Promise<GeneratedCard[]> {
  const entries = mappings ?? CARD_MAPPINGS;
  const cards: GeneratedCard[] = [];
  for (const entry of entries) {
    cards.push(await generateCard(entry, contentDir));
  }
  return cards;
}
```

- [ ] **Step 4: Run the generator**

Run: `pnpm abl:docs:generate`
Expected: Generates 12 new files in `packages/arch-ai/src/knowledge/cards/platform/`

- [ ] **Step 5: Verify generated card sizes**

Run: `for f in packages/arch-ai/src/knowledge/cards/platform/*.ts; do echo "$(basename $f): $(wc -c < $f) chars (~$(($(wc -c < $f) / 4)) tokens)"; done`
Expected: Each file is 8000-10000 chars (~2000-2500 tokens)

- [ ] **Step 6: Update platform/index.ts to re-export generated cards**

Replace the placeholder `packages/arch-ai/src/knowledge/cards/platform/index.ts` with:

```typescript
export { CHANNELS_OVERVIEW_CARD } from './channels-overview.js';
export { CHANNELS_MESSAGING_CARD } from './channels-messaging.js';
export { CHANNELS_VOICE_CARD } from './channels-voice.js';
export { CHANNELS_SDK_CARD } from './channels-sdk.js';
export { DEPLOYMENTS_LIFECYCLE_CARD } from './deployments-lifecycle.js';
export { AUTH_PROFILES_CARD } from './auth-profiles.js';
export { CONNECTIONS_INTEGRATIONS_CARD } from './connections-integrations.js';
export { KB_ADMINISTRATION_CARD } from './kb-administration.js';
export { WORKFLOWS_AUTHORING_CARD } from './workflows-authoring.js';
export { TESTING_EVALS_CARD } from './testing-evals.js';
export { API_MANAGEMENT_CARD } from './api-management.js';
export { EXTERNAL_AGENTS_A2A_CARD } from './external-agents-a2a.js';
```

- [ ] **Step 7: Build and test**

Run: `pnpm build --filter @agent-platform/arch-ai && cd packages/arch-ai && pnpm vitest run`
Expected: Build passes, all tests pass

- [ ] **Step 8: Commit**

```bash
npx prettier --write tools/abl-docs/platform-card-mapping.ts tools/abl-docs/shared.ts tools/abl-docs/card-generator.ts packages/arch-ai/src/knowledge/cards/platform/index.ts
git add tools/abl-docs/platform-card-mapping.ts tools/abl-docs/shared.ts tools/abl-docs/card-generator.ts packages/arch-ai/src/knowledge/cards/platform/
git commit -m "$(cat <<'EOF'
[ABLP-162] feat(arch-ai): generate 12 platform knowledge cards from docs-internal

Extends the existing abl-docs generation pipeline with platform card mappings.
Covers: channels (4 cards), deployments, auth profiles, connections, KB, workflows,
testing/evals, APIs, external agents. Each card ~2500 tokens of compressed factual content.
EOF
)"
```

---

## Task 4: Update L3 Deduplication Mapping

**Files:**

- Modify: `packages/arch-ai/src/knowledge/cards/_mapping.ts`

- [ ] **Step 1: Add new coverage entries**

Append to the `CARD_FILE_COVERAGE` object in `packages/arch-ai/src/knowledge/cards/_mapping.ts`:

```typescript
// Platform cards (auto-generated)
'channels-overview': ['guides/channels.mdx'],
'channels-messaging': ['guides/channels.mdx'],
'channels-voice': ['guides/channels.mdx'],
'channels-sdk': ['api-reference/sdks.mdx'],
'deployments-lifecycle': ['guides/publishing-and-operations.mdx', 'api-reference/management-apis.mdx'],
'auth-profiles': ['admin/security-and-authentication.mdx', 'guides/tools-and-integrations.mdx'],
'connections-integrations': ['studio/tools-knowledge-connections.mdx'],
'kb-administration': ['guides/knowledge-bases.mdx'],
'workflows-authoring': ['studio/tools-knowledge-connections.mdx', 'studio/testing-deployment-operations.mdx'],
'testing-evals': ['guides/testing-and-evaluation.mdx'],
'api-management': ['api-reference/management-apis.mdx'],
'external-agents-a2a': ['examples/orchestration-and-integration.mdx', 'api-reference/channels.mdx'],
```

- [ ] **Step 2: Run tests**

Run: `cd packages/arch-ai && pnpm vitest run`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
npx prettier --write packages/arch-ai/src/knowledge/cards/_mapping.ts
git add packages/arch-ai/src/knowledge/cards/_mapping.ts
git commit -m "$(cat <<'EOF'
[ABLP-162] feat(arch-ai): add L3 deduplication for platform knowledge cards

Ensures L3 BM25 backfill skips MDX chunks already covered by loaded platform cards.
EOF
)"
```

---

## Task 5: Write 7 Expertise Cards (L2-B)

**Files:**

- Create: `packages/arch-ai/src/knowledge/cards/expertise/channels-operations.ts`
- Create: `packages/arch-ai/src/knowledge/cards/expertise/deployment-operations.ts`
- Create: `packages/arch-ai/src/knowledge/cards/expertise/auth-operations.ts`
- Create: `packages/arch-ai/src/knowledge/cards/expertise/connection-operations.ts`
- Create: `packages/arch-ai/src/knowledge/cards/expertise/kb-operations.ts`
- Create: `packages/arch-ai/src/knowledge/cards/expertise/external-agent-operations.ts`
- Create: `packages/arch-ai/src/knowledge/cards/expertise/project-lifecycle.ts`
- Modify: `packages/arch-ai/src/knowledge/cards/expertise/index.ts`

Each expertise card follows this structure:

1. Decision tree (which option for which use case)
2. Tool sequence (step-by-step tool calls)
3. Common pitfalls (provider-specific gotchas)
4. Cross-feature dependencies (what connects to what)
5. When to use search_docs (what the card doesn't cover)

- [ ] **Step 1: Write channels-operations.ts**

Write `packages/arch-ai/src/knowledge/cards/expertise/channels-operations.ts` with the full content from the design spec (Section 6, "Expertise Card Format"). Target: ~2500 tokens covering all 22 channel types' decision tree, create/test/bind tool sequences, per-provider pitfalls, and cross-feature wiring.

- [ ] **Step 2: Write deployment-operations.ts**

Write `packages/arch-ai/src/knowledge/cards/expertise/deployment-operations.ts` covering:

- Decision tree: when to promote vs stay (agents compiled? tests passing? channels bound?)
- Tool sequence: deployment_ops(create) → deployment_ops(promote) → channel_ops(bind_env)
- Pre-promotion checklist
- Rollback decision criteria (error rates, broken agents)
- Environment variable strategy (dev inherits workspace, staging pins versions)

- [ ] **Step 3: Write auth-operations.ts**

Write `packages/arch-ai/src/knowledge/cards/expertise/auth-operations.ts` covering:

- Auth type selection guide (7 types: when to use each)
- Tool sequence: auth_ops(list) → select type → collect_secret(flowId) → auth_ops(create, flowId)
- Validation: auth_ops(validate) after creation
- Consumer awareness: check what tools use a profile before deleting
- OAuth flow guidance: when to use oauth2_app vs oauth2_client_credentials

- [ ] **Step 4: Write connection-operations.ts**

Write `packages/arch-ai/src/knowledge/cards/expertise/connection-operations.ts` covering:

- Connector selection by category (CRM, storage, communication, ticketing, agent desktop)
- Tool sequence: connection_ops(catalog) → select → connection_ops(create) → connection_ops(test)
- Error recovery patterns (expired OAuth, revoked API keys)
- How connections wire into tools (tools reference connection IDs for auth)
- How connections wire into KB connectors (SharePoint/Confluence sync)

- [ ] **Step 5: Write kb-operations.ts**

Write `packages/arch-ai/src/knowledge/cards/expertise/kb-operations.ts` covering:

- Source strategy decision tree (file upload vs crawl vs enterprise connector)
- Embedding model selection (when to change default)
- Chunk size tuning guidance
- Connector health monitoring
- Search strategy recommendations by content type
- Tool sequence: kb_manage → kb_ingest → kb_search (test) → wire to agent tool

- [ ] **Step 6: Write external-agent-operations.ts**

Write `packages/arch-ai/src/knowledge/cards/expertise/external-agent-operations.ts` covering:

- A2A vs REST decision tree
- Registration tool sequence: external_agent_ops(register) → external_agent_ops(test)
- Agent card requirements (what metadata to provide)
- Health check configuration
- How external agents participate in handoff topology (ESCALATE to external)
- A2A channel binding pattern

- [ ] **Step 7: Write project-lifecycle.ts**

Write `packages/arch-ai/src/knowledge/cards/expertise/project-lifecycle.ts` covering:

- Project maturity stages: empty → building → testing → deployed → monitoring
- "What should I do next" recommendations per stage
- Common anti-patterns at each stage (deploying without tests, no error handlers, missing guardrails)
- Resource checklist (agents? tools? KB? channels? deployments?)

- [ ] **Step 8: Update expertise/index.ts**

Replace placeholder with real exports:

```typescript
export { CHANNELS_OPERATIONS_CARD } from './channels-operations.js';
export { DEPLOYMENT_OPERATIONS_CARD } from './deployment-operations.js';
export { AUTH_OPERATIONS_CARD } from './auth-operations.js';
export { CONNECTION_OPERATIONS_CARD } from './connection-operations.js';
export { KB_OPERATIONS_CARD } from './kb-operations.js';
export { EXTERNAL_AGENT_OPERATIONS_CARD } from './external-agent-operations.js';
export { PROJECT_LIFECYCLE_CARD } from './project-lifecycle.js';
```

- [ ] **Step 9: Build and run all tests**

Run: `pnpm build --filter @agent-platform/arch-ai && cd packages/arch-ai && pnpm vitest run`
Expected: All tests pass, including routing tests (now with real card content)

- [ ] **Step 10: Commit**

```bash
npx prettier --write packages/arch-ai/src/knowledge/cards/expertise/*.ts
git add packages/arch-ai/src/knowledge/cards/expertise/
git commit -m "$(cat <<'EOF'
[ABLP-162] feat(arch-ai): write 7 expertise cards for operational intelligence

Hand-written decision trees, tool sequences, pitfalls, and cross-feature guides for:
channels, deployments, auth profiles, connections, KB admin, external agents, project lifecycle.
EOF
)"
```

---

## Task 6: Wire PageContext Through Prompt Composition

**Files:**

- Modify: `packages/arch-ai/src/prompts/index.ts`

- [ ] **Step 1: Pass pageContext to selectKnowledgeCards**

In `packages/arch-ai/src/prompts/index.ts`, update the `composeInProjectPrompt` function to pass page context:

```typescript
// Before:
const knowledge = selectKnowledgeCards(userMessage);

// After:
const knowledge = selectKnowledgeCards(
  userMessage,
  undefined,
  undefined,
  pageContext
    ? {
        area: 'project',
        page: pageContext.page,
        tab: pageContext.tab,
        entityType: pageContext.entity?.type,
      }
    : undefined,
);
```

Also update `composeSystemPrompt` (ONBOARDING mode) if pageContext is available there.

- [ ] **Step 2: Build and test**

Run: `pnpm build --filter @agent-platform/arch-ai && cd packages/arch-ai && pnpm vitest run`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
npx prettier --write packages/arch-ai/src/prompts/index.ts
git add packages/arch-ai/src/prompts/index.ts
git commit -m "$(cat <<'EOF'
[ABLP-162] feat(arch-ai): wire pageContext into knowledge card selection

IN_PROJECT prompt now passes the user's current page/tab/entity to the card router,
enabling page-context-triggered card loading.
EOF
)"
```

---

## Task 7: Final Validation & Documentation

**Files:**

- Modify: `packages/arch-ai/src/knowledge/index.ts`

- [ ] **Step 1: Update knowledge barrel export**

Add re-exports for new cards in `packages/arch-ai/src/knowledge/index.ts`:

```typescript
// Platform cards
export {
  CHANNELS_OVERVIEW_CARD,
  CHANNELS_MESSAGING_CARD,
  CHANNELS_VOICE_CARD,
  CHANNELS_SDK_CARD,
  DEPLOYMENTS_LIFECYCLE_CARD,
  AUTH_PROFILES_CARD,
  CONNECTIONS_INTEGRATIONS_CARD,
  KB_ADMINISTRATION_CARD,
  WORKFLOWS_AUTHORING_CARD,
  TESTING_EVALS_CARD,
  API_MANAGEMENT_CARD,
  EXTERNAL_AGENTS_A2A_CARD,
} from './cards/platform/index.js';

export {
  CHANNELS_OPERATIONS_CARD,
  DEPLOYMENT_OPERATIONS_CARD,
  AUTH_OPERATIONS_CARD,
  CONNECTION_OPERATIONS_CARD,
  KB_OPERATIONS_CARD,
  EXTERNAL_AGENT_OPERATIONS_CARD,
  PROJECT_LIFECYCLE_CARD,
} from './cards/expertise/index.js';
```

- [ ] **Step 2: Run full build**

Run: `pnpm build --filter @agent-platform/arch-ai`
Expected: PASS with no type errors

- [ ] **Step 3: Run full test suite**

Run: `cd packages/arch-ai && pnpm vitest run`
Expected: All tests pass

- [ ] **Step 4: Verify card budget math**

Run a quick manual check: `node -e "const cards = require('./packages/arch-ai/dist/knowledge/cards/platform/index.js'); Object.entries(cards).forEach(([k,v]) => console.log(k + ': ' + Math.ceil(v.length/4) + ' tokens'))"`
Expected: Each card 2000-2500 tokens

- [ ] **Step 5: Commit**

```bash
npx prettier --write packages/arch-ai/src/knowledge/index.ts
git add packages/arch-ai/src/knowledge/index.ts
git commit -m "$(cat <<'EOF'
[ABLP-162] feat(arch-ai): export platform and expertise cards from knowledge barrel
EOF
)"
```

---

## Summary

| Task      | Scope                                                         | Commits       |
| --------- | ------------------------------------------------------------- | ------------- |
| 1         | Token budget increase + pageContext param                     | 1             |
| 2         | Page-context routing + expertise pairing logic + placeholders | 1             |
| 3         | Generation pipeline extension (12 platform cards)             | 1             |
| 4         | L3 deduplication mapping                                      | 1             |
| 5         | 7 hand-written expertise cards                                | 1             |
| 6         | Wire pageContext through prompt composition                   | 1             |
| 7         | Final validation + barrel exports                             | 1             |
| **Total** |                                                               | **7 commits** |
