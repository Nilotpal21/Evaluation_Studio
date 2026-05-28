import type { SessionTreeEvent } from '@/lib/arch-inspector-reader';
import type { TreeNode, SessionTree } from './types';

export function buildSessionTree(events: SessionTreeEvent[]): SessionTree {
  const phases: TreeNode[] = [];
  const legacyEvents: SessionTreeEvent[] = [];

  const turnNodes = new Map<string, TreeNode>();
  const llmNodes = new Map<string, TreeNode>();

  for (const event of events) {
    if (event.nestingDepth === 255 || !event.spanKind) {
      legacyEvents.push(event);
      continue;
    }

    const node: TreeNode = { event, children: [], expanded: false };

    switch (event.spanKind) {
      case 'phase':
        phases.push(node);
        break;
      case 'turn': {
        turnNodes.set(event.turnId || event.eventId, node);
        const parentPhase = findParentPhase(phases, event);
        if (parentPhase) {
          parentPhase.children.push(node);
        } else {
          phases.push(node);
        }
        break;
      }
      case 'llm_call': {
        llmNodes.set(event.eventId, node);
        const parentTurn = event.turnId ? turnNodes.get(event.turnId) : null;
        if (parentTurn) {
          parentTurn.children.push(node);
        } else {
          const lastPhase = phases[phases.length - 1];
          if (lastPhase) {
            lastPhase.children.push(node);
          } else {
            phases.push(node);
          }
        }
        break;
      }
      case 'tool_call': {
        const parentLlm = event.parentEventId ? llmNodes.get(event.parentEventId) : null;
        if (parentLlm) {
          parentLlm.children.push(node);
        } else {
          const parentTurn = event.turnId ? turnNodes.get(event.turnId) : null;
          if (parentTurn) {
            parentTurn.children.push(node);
          } else {
            const lastPhase = phases[phases.length - 1];
            if (lastPhase) {
              lastPhase.children.push(node);
            } else {
              phases.push(node);
            }
          }
        }
        break;
      }
      default: {
        legacyEvents.push(event);
        break;
      }
    }
  }

  return { phases, legacyEvents };
}

function findParentPhase(phases: TreeNode[], event: SessionTreeEvent): TreeNode | null {
  for (let i = phases.length - 1; i >= 0; i--) {
    const phase = phases[i];
    if (phase.event.spanKind === 'phase' && phase.event.phaseLabel === event.phaseLabel) {
      return phase;
    }
  }
  return phases[phases.length - 1] ?? null;
}
