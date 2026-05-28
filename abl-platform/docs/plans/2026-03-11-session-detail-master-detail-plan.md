# Session Detail Master-Detail Redesign — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Refactor the session detail view from three-panel to two-panel master-detail, fix data quality bugs (raw IDs, empty traces, constraint spam), and reorganize information architecture.

**Architecture:** Two-panel layout (AgentExecutionTree left, tabbed detail right) with persistent MetricsBar. New `buildAgentTree()` replaces `buildConversationTree()` for agent-centric hierarchy. OverviewTab merges SessionSummaryPanel content into DebugTabs. Bug fixes in replay-trace-events and label resolution.

**Tech Stack:** React 18, TypeScript, Zustand, Next.js 15, Tailwind CSS, Lucide icons, next-intl

**Design doc:** `docs/plans/2026-03-11-session-detail-master-detail-design.md`

---

## Task 1: Create `label-utils.ts` — Raw ID guard + label resolution

**Files:**

- Create: `apps/studio/src/lib/label-utils.ts`
- Create: `apps/studio/src/__tests__/label-utils.test.ts`

**Step 1: Write the failing tests**

```typescript
// apps/studio/src/__tests__/label-utils.test.ts
import { describe, it, expect } from 'vitest';
import {
  isRawId,
  resolveAgentLabel,
  resolveLLMLabel,
  resolveToolLabel,
  resolveDecisionLabel,
  resolveHandoffLabel,
} from '../lib/label-utils';

describe('isRawId', () => {
  it('detects hex strings >= 16 chars', () => {
    expect(isRawId('f160636b4e1e3bcee2f2bfb2')).toBe(true);
  });

  it('detects traceId:spanId composites', () => {
    expect(isRawId('f160636b4e1e3bcee2f2bfb2:29e4086b8fc5dd0')).toBe(true);
  });

  it('detects UUIDs', () => {
    expect(isRawId('019c0ce7-7248-7815-8030-42c421246467')).toBe(true);
  });

  it('allows normal agent names', () => {
    expect(isRawId('TravelDesk_Supervisor')).toBe(false);
    expect(isRawId('gpt-4o')).toBe(false);
    expect(isRawId('search_flights')).toBe(false);
  });

  it('allows empty/short strings', () => {
    expect(isRawId('')).toBe(false);
    expect(isRawId('Agent')).toBe(false);
  });
});

describe('resolveAgentLabel', () => {
  it('uses agentName when present', () => {
    expect(resolveAgentLabel({ agentName: 'Travel_Agent' })).toBe('Travel_Agent');
  });

  it('extracts last segment from dotted agent path', () => {
    expect(resolveAgentLabel({ agent: 'traveldesk/TravelDesk_Supervisor' })).toBe(
      'TravelDesk_Supervisor',
    );
  });

  it('falls back to sessionAgentName', () => {
    expect(resolveAgentLabel({}, 'Booking_Agent')).toBe('Booking_Agent');
  });

  it('replaces raw IDs with fallback', () => {
    expect(resolveAgentLabel({ agentName: 'f160636b4e1e3bcee2f2bfb2:29e4086b8fc5dd0' })).toBe(
      'Agent',
    );
  });

  it('falls back to "Agent" when nothing available', () => {
    expect(resolveAgentLabel({})).toBe('Agent');
  });
});

describe('resolveLLMLabel', () => {
  it('prefixes model name', () => {
    expect(resolveLLMLabel({ model: 'gpt-4o' })).toBe('LLM → gpt-4o');
  });

  it('falls back to "LLM Call"', () => {
    expect(resolveLLMLabel({})).toBe('LLM Call');
  });
});

describe('resolveToolLabel', () => {
  it('prefixes tool name', () => {
    expect(resolveToolLabel({ toolName: 'search_flights' })).toBe('tool: search_flights');
  });

  it('tries name field', () => {
    expect(resolveToolLabel({ name: 'weather_api' })).toBe('tool: weather_api');
  });

  it('falls back to "Tool Call"', () => {
    expect(resolveToolLabel({})).toBe('Tool Call');
  });
});

describe('resolveDecisionLabel', () => {
  it('combines kind and outcome', () => {
    expect(resolveDecisionLabel({ decisionKind: 'handoff', outcome: 'Booking_Agent' })).toBe(
      'handoff: Booking_Agent',
    );
  });

  it('truncates to 80 chars', () => {
    const long = 'a'.repeat(100);
    expect(
      resolveDecisionLabel({ decisionKind: 'completion', outcome: long }).length,
    ).toBeLessThanOrEqual(80);
  });

  it('falls back to "decision"', () => {
    expect(resolveDecisionLabel({})).toBe('decision');
  });
});

describe('resolveHandoffLabel', () => {
  it('uses toAgent', () => {
    expect(resolveHandoffLabel({ toAgent: 'Booking_Agent' })).toBe('handoff → Booking_Agent');
  });

  it('falls back to agentName', () => {
    expect(resolveHandoffLabel({ agentName: 'Travel_Agent' })).toBe('handoff → Travel_Agent');
  });

  it('falls back to "Handoff"', () => {
    expect(resolveHandoffLabel({})).toBe('Handoff');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd apps/studio && pnpm vitest run src/__tests__/label-utils.test.ts`
Expected: FAIL — module not found

**Step 3: Write the implementation**

```typescript
// apps/studio/src/lib/label-utils.ts

const HEX_16_PLUS = /^[0-9a-f]{16,}$/i;
const TRACE_SPAN_COMPOSITE = /^[0-9a-f]{8,}:[0-9a-f]{4,}$/i;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-/i;

/** Returns true if the value looks like a raw trace/span ID rather than a human label. */
export function isRawId(value: string): boolean {
  if (!value || value.length < 12) return false;
  return HEX_16_PLUS.test(value) || TRACE_SPAN_COMPOSITE.test(value) || UUID_PATTERN.test(value);
}

function safeLabel(value: unknown, fallback: string): string {
  if (typeof value !== 'string' || !value.trim()) return fallback;
  return isRawId(value) ? fallback : value;
}

function lastSegment(path: string): string {
  const parts = path.split('/');
  return parts[parts.length - 1] || path;
}

export function resolveAgentLabel(
  data: Record<string, unknown>,
  sessionAgentName?: string,
): string {
  const fromName = safeLabel(data.agentName, '');
  if (fromName) return fromName;

  if (typeof data.agent === 'string' && data.agent) {
    const seg = lastSegment(data.agent);
    const safe = safeLabel(seg, '');
    if (safe) return safe;
  }

  if (sessionAgentName) {
    const safe = safeLabel(sessionAgentName, '');
    if (safe) return safe;
  }

  return 'Agent';
}

export function resolveLLMLabel(data: Record<string, unknown>): string {
  const model = typeof data.model === 'string' && data.model ? data.model : '';
  return model ? `LLM → ${model}` : 'LLM Call';
}

export function resolveToolLabel(data: Record<string, unknown>): string {
  const name =
    typeof data.toolName === 'string' && data.toolName
      ? data.toolName
      : typeof data.name === 'string' && data.name
        ? data.name
        : '';
  return name ? `tool: ${name}` : 'Tool Call';
}

export function resolveDecisionLabel(data: Record<string, unknown>): string {
  const kind = typeof data.decisionKind === 'string' ? data.decisionKind : '';
  const outcome = typeof data.outcome === 'string' ? data.outcome : '';
  if (!kind && !outcome) return 'decision';
  const full = outcome ? `${kind}: ${outcome}` : kind;
  return full.length > 80 ? full.slice(0, 77) + '…' : full;
}

export function resolveHandoffLabel(data: Record<string, unknown>): string {
  const target =
    typeof data.toAgent === 'string' && data.toAgent
      ? data.toAgent
      : typeof data.agentName === 'string' && data.agentName
        ? data.agentName
        : '';
  return target ? `handoff → ${target}` : 'Handoff';
}

export function resolveDelegateLabel(data: Record<string, unknown>): string {
  const target = typeof data.targetAgent === 'string' && data.targetAgent ? data.targetAgent : '';
  return target ? `delegate → ${target}` : 'Delegate';
}
```

**Step 4: Run test to verify it passes**

Run: `cd apps/studio && pnpm vitest run src/__tests__/label-utils.test.ts`
Expected: PASS — all tests green

**Step 5: Commit**

```bash
npx prettier --write apps/studio/src/lib/label-utils.ts apps/studio/src/__tests__/label-utils.test.ts
git add apps/studio/src/lib/label-utils.ts apps/studio/src/__tests__/label-utils.test.ts
git commit -m "[ABLP-2] feat(studio): add label-utils with raw ID guard and label resolution"
```

---

## Task 2: Create `buildAgentTree.ts` — agent-centric tree builder

**Files:**

- Create: `apps/studio/src/lib/buildAgentTree.ts`
- Create: `apps/studio/src/__tests__/buildAgentTree.test.ts`

**Context:** This replaces `buildConversationTree()` (useSessionDetail.ts:228-344) and `buildAgentSubtree()` (useSessionDetail.ts:363-624). The new algorithm groups events by agent instead of by conversation turn, collapses consecutive same-type events, and uses label-utils for all labels.

**Pre-requisite:** Before this task, add `'constraint_check'` and `'guardrail_check'` to the `TreeNodeType` union in `apps/studio/src/hooks/useSessionDetail.ts:25-45`:

```typescript
// Add after 'agent_response' (line 38):
  | 'constraint_check'
  | 'guardrail_check'
```

**Step 1: Write the failing tests**

```typescript
// apps/studio/src/__tests__/buildAgentTree.test.ts
import { describe, it, expect } from 'vitest';
import { buildAgentTree } from '../lib/buildAgentTree';
import type { TraceEvent, SessionMessage } from '../types';

function makeEvent(overrides: Partial<TraceEvent> & { type: string }): TraceEvent {
  return {
    id: `evt-${Math.random().toString(36).slice(2, 8)}`,
    sessionId: 'sess-1',
    timestamp: new Date('2026-03-11T10:00:00Z'),
    data: {},
    ...overrides,
  } as TraceEvent;
}

function makeMsg(role: 'user' | 'assistant', content: string, ts: string): SessionMessage {
  return {
    id: `msg-${Math.random().toString(36).slice(2, 8)}`,
    role,
    content,
    timestamp: new Date(ts),
    traceIds: [],
  };
}

describe('buildAgentTree', () => {
  it('creates agent nodes as top-level entries', () => {
    const events = [
      makeEvent({
        type: 'agent_enter',
        data: { agentName: 'Travel_Agent' },
        timestamp: new Date('2026-03-11T10:00:01Z'),
      }),
      makeEvent({
        type: 'llm_call',
        data: { model: 'gpt-4o', tokensIn: 100, tokensOut: 50 },
        timestamp: new Date('2026-03-11T10:00:02Z'),
      }),
      makeEvent({
        type: 'agent_exit',
        data: { agentName: 'Travel_Agent' },
        timestamp: new Date('2026-03-11T10:00:03Z'),
      }),
    ];
    const tree = buildAgentTree([], events);

    expect(tree.length).toBe(1);
    expect(tree[0].type).toBe('agent');
    expect(tree[0].label).toBe('Travel_Agent');
    expect(tree[0].children.length).toBe(1); // llm_call
    expect(tree[0].children[0].label).toBe('LLM → gpt-4o');
  });

  it('inserts user messages as separators between agents', () => {
    const messages = [makeMsg('user', 'Book a flight', '2026-03-11T10:00:00Z')];
    const events = [
      makeEvent({
        type: 'agent_enter',
        data: { agentName: 'Agent_A' },
        timestamp: new Date('2026-03-11T10:00:01Z'),
      }),
      makeEvent({
        type: 'agent_exit',
        data: { agentName: 'Agent_A' },
        timestamp: new Date('2026-03-11T10:00:02Z'),
      }),
    ];
    const tree = buildAgentTree(messages, events);

    // Should have user separator before agent
    const types = tree.map((n) => n.type);
    expect(types).toContain('user_input');
    expect(types).toContain('agent');
  });

  it('collapses consecutive constraint_check events', () => {
    const events = [
      makeEvent({
        type: 'agent_enter',
        data: { agentName: 'Agent_A' },
        timestamp: new Date('2026-03-11T10:00:01Z'),
      }),
      makeEvent({
        type: 'constraint_check',
        data: { constraint: 'c1', passed: true },
        timestamp: new Date('2026-03-11T10:00:02Z'),
      }),
      makeEvent({
        type: 'constraint_check',
        data: { constraint: 'c2', passed: true },
        timestamp: new Date('2026-03-11T10:00:03Z'),
      }),
      makeEvent({
        type: 'constraint_check',
        data: { constraint: 'c3', passed: false },
        timestamp: new Date('2026-03-11T10:00:04Z'),
      }),
      makeEvent({
        type: 'agent_exit',
        data: { agentName: 'Agent_A' },
        timestamp: new Date('2026-03-11T10:00:05Z'),
      }),
    ];
    const tree = buildAgentTree([], events);

    const agentChildren = tree[0].children;
    expect(agentChildren.length).toBe(1); // collapsed group
    expect(agentChildren[0].type).toBe('constraint_check');
    expect(agentChildren[0].label).toMatch(/constraints \(3\)/);
    expect(agentChildren[0].label).toContain('✗'); // one failed
    expect(agentChildren[0].children.length).toBe(3); // expandable
  });

  it('replaces raw IDs with fallback labels', () => {
    const events = [
      makeEvent({
        type: 'agent_enter',
        data: { agentName: 'f160636b4e1e3bcee2f2bfb2:29e4086b8fc5dd0' },
        timestamp: new Date('2026-03-11T10:00:01Z'),
      }),
      makeEvent({ type: 'agent_exit', data: {}, timestamp: new Date('2026-03-11T10:00:02Z') }),
    ];
    const tree = buildAgentTree([], events, 'Fallback_Agent');

    expect(tree[0].label).toBe('Fallback_Agent');
  });

  it('labels LLM calls with "LLM → model" not bare model name', () => {
    const events = [
      makeEvent({
        type: 'agent_enter',
        data: { agentName: 'A' },
        timestamp: new Date('2026-03-11T10:00:01Z'),
      }),
      makeEvent({
        type: 'llm_call',
        data: { model: 'gpt-4o' },
        timestamp: new Date('2026-03-11T10:00:02Z'),
      }),
      makeEvent({ type: 'agent_exit', data: {}, timestamp: new Date('2026-03-11T10:00:03Z') }),
    ];
    const tree = buildAgentTree([], events);
    expect(tree[0].children[0].label).toBe('LLM → gpt-4o');
  });

  it('handles handoff between agents', () => {
    const events = [
      makeEvent({
        type: 'agent_enter',
        data: { agentName: 'Supervisor' },
        timestamp: new Date('2026-03-11T10:00:01Z'),
      }),
      makeEvent({
        type: 'tool_call',
        data: { toolName: '__handoff__', input: { target: 'Worker' } },
        timestamp: new Date('2026-03-11T10:00:02Z'),
      }),
      makeEvent({ type: 'agent_exit', data: {}, timestamp: new Date('2026-03-11T10:00:03Z') }),
      makeEvent({
        type: 'agent_enter',
        data: { agentName: 'Worker' },
        timestamp: new Date('2026-03-11T10:00:04Z'),
      }),
      makeEvent({ type: 'agent_exit', data: {}, timestamp: new Date('2026-03-11T10:00:05Z') }),
    ];
    const tree = buildAgentTree([], events);
    expect(tree.length).toBe(2);
    expect(tree[0].label).toBe('Supervisor');
    expect(tree[1].label).toBe('Worker');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd apps/studio && pnpm vitest run src/__tests__/buildAgentTree.test.ts`
Expected: FAIL — module not found

**Step 3: Write the implementation**

```typescript
// apps/studio/src/lib/buildAgentTree.ts
import type { TreeNode, TreeNodeType } from '../hooks/useSessionDetail';
import type { TraceEvent, SessionMessage } from '../types';
import {
  resolveAgentLabel,
  resolveLLMLabel,
  resolveToolLabel,
  resolveDecisionLabel,
  resolveHandoffLabel,
  resolveDelegateLabel,
} from './label-utils';

const SYSTEM_TOOLS: Record<string, TreeNodeType> = {
  __handoff__: 'handoff',
  __delegate__: 'delegate_action',
  __complete__: 'complete',
  __escalate__: 'escalate',
};

const COLLAPSIBLE_TYPES = new Set([
  'constraint_check',
  'guardrail_check',
  'gather_extraction',
  'correction',
]);

function extractTokens(data: Record<string, unknown>) {
  const tokenUsage = data.tokenUsage as Record<string, number> | undefined;
  return {
    input: (data.tokensIn as number) || tokenUsage?.input || 0,
    output: (data.tokensOut as number) || tokenUsage?.output || 0,
  };
}

function collapseConsecutive(nodes: TreeNode[]): TreeNode[] {
  const result: TreeNode[] = [];
  let i = 0;
  while (i < nodes.length) {
    const node = nodes[i];
    if (COLLAPSIBLE_TYPES.has(node.type)) {
      const group: TreeNode[] = [node];
      while (i + 1 < nodes.length && nodes[i + 1].type === node.type) {
        i++;
        group.push(nodes[i]);
      }
      if (group.length > 1) {
        const allPassed = group.every((n) => n.data?.passed !== false && n.data?.success !== false);
        const typeName =
          node.type === 'guardrail_check'
            ? 'guardrails'
            : node.type === 'gather_extraction'
              ? 'extractions'
              : node.type === 'correction'
                ? 'corrections'
                : 'constraints';
        const totalMs = group.reduce((sum, n) => sum + (n.latencyMs || 0), 0);
        result.push({
          id: `group-${node.id}`,
          type: node.type as TreeNodeType,
          label: `${typeName} (${group.length}) ${allPassed ? '✓' : '✗'}`,
          latencyMs: totalMs,
          children: group,
          data: { collapsed: true, count: group.length, allPassed },
        });
      } else {
        result.push(node);
      }
    } else {
      result.push(node);
    }
    i++;
  }
  return result;
}

function buildAgentNodes(events: TraceEvent[], sessionAgentName?: string): TreeNode[] {
  const topLevel: TreeNode[] = [];
  const agentStack: TreeNode[] = [];

  function pushNode(node: TreeNode) {
    if (agentStack.length > 0) {
      agentStack[agentStack.length - 1].children.push(node);
    } else {
      topLevel.push(node);
    }
  }

  for (const event of events) {
    const eventData = event.data || {};
    const type = event.type;

    switch (type) {
      case 'agent_enter': {
        const node: TreeNode = {
          id: event.id,
          type: 'agent',
          label: resolveAgentLabel(eventData, sessionAgentName),
          timestamp:
            event.timestamp instanceof Date
              ? event.timestamp.toISOString()
              : String(event.timestamp),
          children: [],
          data: eventData,
        };
        pushNode(node);
        agentStack.push(node);
        break;
      }

      case 'agent_exit':
      case 'delegate_complete': {
        if (agentStack.length > 0) {
          const agent = agentStack.pop()!;
          if (event.timestamp && agent.timestamp) {
            agent.latencyMs =
              new Date(event.timestamp).getTime() - new Date(agent.timestamp).getTime();
          }
          agent.children = collapseConsecutive(agent.children);
        }
        break;
      }

      case 'delegate_start': {
        const node: TreeNode = {
          id: event.id,
          type: 'sub_agent',
          label: resolveDelegateLabel(eventData),
          timestamp:
            event.timestamp instanceof Date
              ? event.timestamp.toISOString()
              : String(event.timestamp),
          children: [],
          data: eventData,
        };
        pushNode(node);
        agentStack.push(node);
        break;
      }

      case 'llm_call': {
        const tokens = extractTokens(eventData);
        pushNode({
          id: event.id,
          type: 'llm_call',
          label: resolveLLMLabel(eventData),
          detail: typeof eventData.model === 'string' ? eventData.model : undefined,
          tokens,
          latencyMs: event.durationMs || (eventData.durationMs as number) || undefined,
          timestamp:
            event.timestamp instanceof Date
              ? event.timestamp.toISOString()
              : String(event.timestamp),
          children: [],
          data: eventData,
        });
        break;
      }

      case 'tool_call': {
        const toolName =
          typeof eventData.toolName === 'string'
            ? eventData.toolName
            : typeof eventData.name === 'string'
              ? eventData.name
              : '';
        const systemType = SYSTEM_TOOLS[toolName];
        if (systemType) {
          const input = eventData.input as Record<string, unknown> | undefined;
          const target = (input?.target as string) || '';
          if (systemType === 'handoff') {
            pushNode({
              id: event.id,
              type: 'handoff',
              label: target ? `handoff → ${target}` : 'Handoff',
              children: [],
              data: eventData,
            });
          } else if (systemType === 'delegate_action') {
            pushNode({
              id: event.id,
              type: 'delegate_action',
              label: target ? `delegate → ${target}` : 'Delegate',
              children: [],
              data: eventData,
            });
          } else {
            pushNode({
              id: event.id,
              type: systemType,
              label: systemType === 'complete' ? 'Complete' : 'Escalate',
              children: [],
              data: eventData,
            });
          }
        } else {
          pushNode({
            id: event.id,
            type: 'tool_call',
            label: resolveToolLabel(eventData),
            detail: toolName || undefined,
            latencyMs: event.durationMs || (eventData.durationMs as number) || undefined,
            children: [],
            data: eventData,
          });
        }
        break;
      }

      case 'decision': {
        pushNode({
          id: event.id,
          type: 'decision',
          label: resolveDecisionLabel(eventData),
          latencyMs: event.durationMs || (eventData.durationMs as number) || undefined,
          children: [],
          data: eventData,
        });
        break;
      }

      case 'constraint_check': {
        pushNode({
          id: event.id,
          type: 'constraint_check' as TreeNodeType,
          label: `constraint: ${eventData.constraint || 'check'}`,
          latencyMs: event.durationMs || (eventData.durationMs as number) || undefined,
          children: [],
          data: eventData,
        });
        break;
      }

      case 'flow_step_enter': {
        pushNode({
          id: event.id,
          type: 'flow_step',
          label: `step: ${eventData.stepName || 'Step'}`,
          detail: typeof eventData.stepName === 'string' ? eventData.stepName : undefined,
          children: [],
          data: eventData,
        });
        break;
      }

      case 'flow_transition': {
        const from = typeof eventData.fromStep === 'string' ? eventData.fromStep : '';
        const to = typeof eventData.toStep === 'string' ? eventData.toStep : '';
        pushNode({
          id: event.id,
          type: 'flow_transition',
          label: from && to ? `${from} → ${to}` : 'transition',
          children: [],
          data: eventData,
        });
        break;
      }

      case 'error': {
        const msg =
          typeof eventData.errorMessage === 'string'
            ? eventData.errorMessage
            : typeof eventData.message === 'string'
              ? eventData.message
              : 'Error';
        pushNode({
          id: event.id,
          type: 'escalate',
          label: `error: ${msg.slice(0, 60)}`,
          children: [],
          data: eventData,
        });
        break;
      }

      default:
        // Skip unknown event types (voice handled separately, other noise ignored)
        break;
    }
  }

  // Close any unclosed agents
  while (agentStack.length > 0) {
    const agent = agentStack.pop()!;
    agent.children = collapseConsecutive(agent.children);
  }

  return topLevel;
}

/**
 * Build an agent-centric tree from messages and trace events.
 * Agents are top-level nodes. User messages appear as separators.
 */
export function buildAgentTree(
  messages: SessionMessage[],
  traceEvents: TraceEvent[],
  sessionAgentName?: string,
): TreeNode[] {
  if (!traceEvents.length && !messages.length) return [];

  // Note: voice sessions (voice_session_start, voice_turn, etc.) are handled by
  // VoiceMetricsTab. Voice event types fall through to the `default: break` case
  // in buildAgentNodes and are intentionally skipped from the execution tree.
  // The old buildConversationTree had special voice handling (lines 237-245) to
  // skip message grouping, but buildAgentTree is already agent-centric so no
  // special voice path is needed.

  // Sort events chronologically
  const sorted = [...traceEvents].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
  );

  // Build the agent nodes from trace events
  const agentNodes = buildAgentNodes(sorted, sessionAgentName);

  // If no messages, return agent nodes directly
  if (!messages.length) return agentNodes;

  // Interleave user/assistant messages as separators
  const sortedMsgs = [...messages].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
  );

  const result: TreeNode[] = [];
  let agentIdx = 0;

  for (const msg of sortedMsgs) {
    const msgTime = new Date(msg.timestamp).getTime();

    // Add agent nodes that started before this message
    while (agentIdx < agentNodes.length) {
      const nodeTime = agentNodes[agentIdx].timestamp
        ? new Date(agentNodes[agentIdx].timestamp!).getTime()
        : 0;
      if (nodeTime < msgTime) {
        result.push(agentNodes[agentIdx]);
        agentIdx++;
      } else {
        break;
      }
    }

    // Add message separator
    if (msg.role === 'user') {
      result.push({
        id: msg.id,
        type: 'user_input',
        label: `"${msg.content.slice(0, 60)}${msg.content.length > 60 ? '…' : ''}"`,
        timestamp:
          msg.timestamp instanceof Date ? msg.timestamp.toISOString() : String(msg.timestamp),
        children: [],
      });
    } else if (msg.role === 'assistant') {
      result.push({
        id: msg.id,
        type: 'agent_response',
        label: `Agent: "${msg.content.slice(0, 60)}${msg.content.length > 60 ? '…' : ''}"`,
        timestamp:
          msg.timestamp instanceof Date ? msg.timestamp.toISOString() : String(msg.timestamp),
        children: [],
      });
    }
  }

  // Add remaining agent nodes after all messages
  while (agentIdx < agentNodes.length) {
    result.push(agentNodes[agentIdx]);
    agentIdx++;
  }

  return result;
}
```

**Step 4: Run test to verify it passes**

Run: `cd apps/studio && pnpm vitest run src/__tests__/buildAgentTree.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
npx prettier --write apps/studio/src/lib/buildAgentTree.ts apps/studio/src/__tests__/buildAgentTree.test.ts
git add apps/studio/src/lib/buildAgentTree.ts apps/studio/src/__tests__/buildAgentTree.test.ts
git commit -m "[ABLP-2] feat(studio): add buildAgentTree — agent-centric tree builder with collapsing"
```

---

## Task 3: Fix `replay-trace-events.ts` — use real spanIds

**Files:**

- Modify: `apps/studio/src/utils/replay-trace-events.ts:139-151`

**Context:** Currently line 146 builds `spanId: (eventData.spanId as string) || 'span-' + event.id` which creates synthetic spanIds. After trace consolidation Phase 2, events should have real `spanId`/`parentSpanId`. We need to prefer those.

**Step 1: Read the current code**

Read `apps/studio/src/utils/replay-trace-events.ts:135-160` to verify the exact lines.

**Step 2: Fix the spanId resolution**

In the `ExtendedTraceEvent` construction (lines 140-151), change:

```typescript
// Before:
spanId: (eventData.spanId as string) || 'span-' + event.id,
parentSpanId: eventData.parentSpanId as string | undefined,

// After — prefer event-level span fields, then data fields, then synthetic:
spanId: (event as any).spanId || (eventData.spanId as string) || 'span-' + event.id,
parentSpanId: (event as any).parentSpanId || (eventData.parentSpanId as string) || undefined,
```

**Step 3: Build to verify no type errors**

Run: `pnpm build --filter=@agent-platform/studio`
Expected: Build succeeds

**Step 4: Commit**

```bash
npx prettier --write apps/studio/src/utils/replay-trace-events.ts
git add apps/studio/src/utils/replay-trace-events.ts
git commit -m "[ABLP-2] fix(studio): prefer real spanId/parentSpanId over synthetic in replay"
```

---

## Task 4: Create `MetricsBar.tsx`

**Files:**

- Create: `apps/studio/src/components/session/MetricsBar.tsx`

**Step 1: Write the component**

```typescript
// apps/studio/src/components/session/MetricsBar.tsx
'use client';

import { DollarSign, Coins, Clock, Calendar } from 'lucide-react';

interface MetricsBarProps {
  cost: number;
  tokens: number;
  latencyMs: number;
  finishedAt?: string | Date;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const mins = Math.floor(ms / 60_000);
  const secs = Math.round((ms % 60_000) / 1000);
  return `${mins}m ${secs}s`;
}

function formatTimestamp(value: string | Date): string {
  const d = value instanceof Date ? value : new Date(value);
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function MetricsBar({ cost, tokens, latencyMs, finishedAt }: MetricsBarProps) {
  return (
    <div className="flex items-center gap-6 px-4 py-2 border-b border-border bg-background-subtle text-sm">
      <div className="flex items-center gap-1.5 text-muted">
        <DollarSign className="h-3.5 w-3.5" />
        <span className="font-medium text-foreground">${cost.toFixed(6)}</span>
      </div>
      <div className="flex items-center gap-1.5 text-muted">
        <Coins className="h-3.5 w-3.5" />
        <span className="font-medium text-foreground">{tokens.toLocaleString()}</span>
        <span>tokens</span>
      </div>
      <div className="flex items-center gap-1.5 text-muted">
        <Clock className="h-3.5 w-3.5" />
        <span className="font-medium text-foreground">{formatDuration(latencyMs)}</span>
      </div>
      {finishedAt && (
        <div className="flex items-center gap-1.5 text-muted ml-auto">
          <Calendar className="h-3.5 w-3.5" />
          <span>{formatTimestamp(finishedAt)}</span>
        </div>
      )}
    </div>
  );
}
```

**Step 2: Build to verify**

Run: `pnpm build --filter=@agent-platform/studio`
Expected: Build succeeds

**Step 3: Commit**

```bash
npx prettier --write apps/studio/src/components/session/MetricsBar.tsx
git add apps/studio/src/components/session/MetricsBar.tsx
git commit -m "[ABLP-2] feat(studio): add MetricsBar — persistent session metrics strip"
```

---

## Task 5: Create `OverviewTab.tsx` — extract from SessionSummaryPanel

**Files:**

- Create: `apps/studio/src/components/session/OverviewTab.tsx`
- Read first: `apps/studio/src/components/session/SessionSummaryPanel.tsx` (extract PreviewTab:267-369, RequestTab:373-412, ResponseTab:416-452, MetadataTab:456-553, LLMData:597-607, extractLLMData:609-643, findNodeById:645-652)

**Step 1: Read SessionSummaryPanel to get exact content**

Read lines 267-670 of SessionSummaryPanel.tsx for the tab renderers and helpers.

**Step 2: Create OverviewTab with extracted content**

The OverviewTab has two modes:

- **No selection**: Session summary (agent name, IDs, message count, models used)
- **Node selected**: Reuses PreviewTab/RequestTab/ResponseTab/MetadataTab from SessionSummaryPanel

Extract the 4 tab renderers + helpers (LLMData, extractLLMData, findNodeById) from SessionSummaryPanel into OverviewTab. Add the session summary view as the default.

**Step 3: Build to verify**

Run: `pnpm build --filter=@agent-platform/studio`
Expected: Build succeeds

**Step 4: Commit**

```bash
npx prettier --write apps/studio/src/components/session/OverviewTab.tsx
git add apps/studio/src/components/session/OverviewTab.tsx
git commit -m "[ABLP-2] feat(studio): add OverviewTab — session summary + node detail"
```

---

## Task 6: Create `AgentExecutionTree.tsx` — rewrite left panel

**Files:**

- Create: `apps/studio/src/components/session/AgentExecutionTree.tsx`
- Reference: `apps/studio/src/components/session/AgentConversationTree.tsx` (388 lines — reuse icon mapping patterns from getNodePresentation:189-387)

**Step 1: Create the new tree component**

The structure mirrors AgentConversationTree (388 lines, `getNodePresentation` at 189-387) but with:

- Updated `getNodePresentation` matching the design's icon/label table:
  | TreeNodeType | Icon (Lucide) | Right-side info |
  |---|---|---|
  | `agent` | Bot | total duration |
  | `llm_call` | Cpu | `{tokens.input+tokens.output}tk  {latencyMs}` |
  | `tool_call` | Wrench | duration |
  | `decision` | Lightbulb | duration |
  | `constraint_check` (collapsed) | Shield | total duration |
  | `guardrail_check` (collapsed) | ShieldAlert | total duration |
  | `handoff` | ArrowRight | — |
  | `sub_agent` / `delegate_action` | Users | — |
  | `flow_step` | Workflow | duration |
  | `escalate` (error) | AlertTriangle | — |
  | `user_input` | MessageSquare | — (styled as divider, not indented) |
  | `agent_response` | Bot | — (styled as divider) |

- Right-side info column: `<span className="ml-auto text-xs text-muted tabular-nums">{info}</span>`
- Collapsed group expansion: click toggles `expandedGroups` Set in local state
- User/assistant message separators styled as full-width dividers with dashed border, not indented tree nodes
- Double-click agent node scrolls to span in Traces tab:

  ```typescript
  // In AgentExecutionTree.tsx:
  const { setDebugPanelTab } = useObservatoryStore();
  const { selectSpan } = useObservatoryStore();

  const handleDoubleClick = (nodeId: string) => {
    setDebugPanelTab('traces');
    selectSpan(nodeId); // WaterfallPanel already scrolls to selectedSpanId via useEffect
  };
  // Usage: onDoubleClick={() => handleDoubleClick(node.id)}
  ```

  Note: WaterfallPanel already has scroll-to-selected behavior via `selectedSpanId` in observatory-store. No new `scrollToSpan` function needed — just set the span ID and switch tabs.

- Collapsed group expand + select behavior:

  ```typescript
  // In AgentExecutionTree.tsx:
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());

  const toggleGroup = (groupId: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });
    // Also select the group node so Overview tab shows the group summary
    setSelectedTraceNodeId(groupId);
  };

  // Rendering logic for collapsed groups:
  // If node.data?.collapsed && !expandedGroups.has(node.id):
  //   Render single collapsed row: "constraints (12) ✓" with onClick={toggleGroup}
  // If node.data?.collapsed && expandedGroups.has(node.id):
  //   Render group header row + children indented 1 level below
  ```

**Step 2: Build to verify**

Run: `pnpm build --filter=@agent-platform/studio`

**Step 3: Commit**

```bash
npx prettier --write apps/studio/src/components/session/AgentExecutionTree.tsx
git add apps/studio/src/components/session/AgentExecutionTree.tsx
git commit -m "[ABLP-2] feat(studio): add AgentExecutionTree — agent-centric left panel"
```

---

## Task 7: Modify `DebugTabs.tsx` — add Overview tab

**Files:**

- Modify: `apps/studio/src/components/observatory/DebugTabs.tsx`

**Step 1: Update DebugTab type in observatory-store.ts (line 29)**

Current type at `apps/studio/src/store/observatory-store.ts:29`:

```typescript
export type DebugTab = 'traces' | 'data' | 'conversation' | 'performance' | 'ir';
```

Change to:

```typescript
export type DebugTab = 'overview' | 'traces' | 'data' | 'conversation' | 'performance' | 'ir';
```

Also update the default tab value in the store initial state (observatory-store.ts, around line 272):

```typescript
// Before:
debugPanelTab: 'traces',
// After:
debugPanelTab: 'overview',
```

**Step 2: Add Overview tab to the tabs array in DebugTabs.tsx (line ~39)**

```typescript
// In DebugTabs.tsx, add as first tab:
{ id: 'overview', label: t('tab_overview'), icon: LayoutDashboard },
```

**Step 2: Add Overview tab content rendering**

```typescript
// Add import at top:
import { OverviewTab } from '../session/OverviewTab';

// Add to tab content section:
{debugPanelTab === 'overview' && <OverviewTab />}
```

**Step 3: Add Voice tab conditionally**

Check for voice events and add Voice tab when present (same logic as SessionSummaryPanel:63-66).

**Step 4: Build to verify**

Run: `pnpm build --filter=@agent-platform/studio`

**Step 5: Commit**

```bash
npx prettier --write apps/studio/src/components/observatory/DebugTabs.tsx apps/studio/src/store/observatory-store.ts
git add apps/studio/src/components/observatory/DebugTabs.tsx apps/studio/src/store/observatory-store.ts
git commit -m "[ABLP-2] feat(studio): add Overview + Voice tabs to DebugTabs"
```

---

## Task 8: Rewrite `SessionDetailPage.tsx` — two-panel master-detail

**Files:**

- Rewrite: `apps/studio/src/components/session/SessionDetailPage.tsx`

**Step 1: Read the current file (267 lines)**

Read to understand imports, header bar, Arch context setup, and navigation logic that must be preserved.

**Step 2: Rewrite with two-panel layout**

Key changes:

- Remove vertical resize (no top/bottom split)
- Keep horizontal resize (left/right, default 35% left / 65% right)
- Replace `AgentConversationTree` with `AgentExecutionTree`
- Replace `SessionSummaryPanel` + `DebugTabs` with `MetricsBar` + `DebugTabs`
- Wire `useSessionDetail` to use new `buildAgentTree` (modify hook in same step)
- Preserve: header bar, navigation, Arch context, loading/error states
- Set resize handle default: `const [leftWidth, setLeftWidth] = useState(35);` (percentage)

**Step 3: Modify `useSessionDetail.ts` — swap tree builder**

```typescript
// Replace import:
import { buildAgentTree } from '../lib/buildAgentTree';

// Replace useMemo (line ~200):
const tree = useMemo(
  () => (session ? buildAgentTree(session.messages, session.traceEvents, session.agentName) : []),
  [session],
);
```

**Step 4: Build to verify**

Run: `pnpm build --filter=@agent-platform/studio`

**Step 5: Manual test**

Start dev server: `cd apps/studio && WATCHPACK_POLLING=true npx next dev -p 5173`
Navigate to a session detail page. Verify:

- Two-panel layout (left tree, right tabs)
- MetricsBar shows cost/tokens/latency
- Agent names show correctly (no raw IDs)
- Constraint checks are collapsed
- Overview tab shows session summary / node detail on selection
- Traces tab shows waterfall
- Other tabs work as before

**Step 6: Commit**

```bash
npx prettier --write apps/studio/src/components/session/SessionDetailPage.tsx apps/studio/src/hooks/useSessionDetail.ts
git add apps/studio/src/components/session/SessionDetailPage.tsx apps/studio/src/hooks/useSessionDetail.ts
git commit -m "[ABLP-2] feat(studio): rewrite SessionDetailPage as two-panel master-detail"
```

---

## Task 9: Delete old components + cleanup

**Files:**

- Delete: `apps/studio/src/components/session/SessionSummaryPanel.tsx`
- Delete: `apps/studio/src/components/session/AgentConversationTree.tsx`
- Modify: `apps/studio/src/store/ui-store.ts` — remove `SessionDetailTab` type (no longer needed)

**Step 1: Search for remaining imports of deleted components**

Run: `grep -r 'SessionSummaryPanel\|AgentConversationTree' apps/studio/src/ --include='*.ts' --include='*.tsx'`

Fix any remaining references.

**Step 2: Delete the files**

```bash
rm apps/studio/src/components/session/SessionSummaryPanel.tsx
rm apps/studio/src/components/session/AgentConversationTree.tsx
```

**Step 3: Clean up ui-store.ts**

Remove `SessionDetailTab` type and `sessionDetailTab`/`setSessionDetailTab` from the store (the Overview tab manages its own sub-tab state internally).

**Step 4: Build to verify**

Run: `pnpm build --filter=@agent-platform/studio`
Expected: Clean build, no import errors

**Step 5: Run tests**

Run: `cd apps/studio && pnpm vitest run`
Expected: All tests pass (some old tests may need updating if they imported deleted components)

**Step 6: Commit**

```bash
git add -A
git commit -m "[ABLP-2] chore(studio): delete SessionSummaryPanel + AgentConversationTree, clean up ui-store"
```

---

## Task 10: Full build + manual verification

**Step 1: Full build**

```bash
pnpm build --force
```

Expected: All packages build clean

**Step 2: Run all tests**

```bash
npx turbo test:fast --concurrency=2
```

Expected: All pass (except known pre-existing failures)

**Step 3: Manual test checklist**

Start servers and test in browser:

- [ ] Session detail page loads with two-panel layout
- [ ] Left panel shows agent-centric tree (agents as top-level nodes)
- [ ] No raw IDs visible as labels
- [ ] Constraint checks collapsed into single node with count
- [ ] LLM calls show "LLM → gpt-4o" format
- [ ] User messages appear as separators
- [ ] MetricsBar shows cost, tokens, latency, timestamp
- [ ] Overview tab: session summary when nothing selected
- [ ] Overview tab: node detail when tree node clicked
- [ ] Traces tab: waterfall renders spans
- [ ] Data/Conversation/Performance/IR tabs work as before
- [ ] Voice tab appears for voice sessions
- [ ] Live debug panel (ChatWithDebugPanel) still works
- [ ] Resize handle works between left/right panels

**Step 4: Commit any fixes**

```bash
git add -A
git commit -m "[ABLP-2] fix(studio): address manual test findings"
```
