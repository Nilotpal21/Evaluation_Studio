/**
 * Shared constants for the HandlePlusMenu and its "Connect to existing"
 * section. Centralised here so the two surfaces cannot drift on icon
 * mapping, the canonical type list, or category ordering — keeping the
 * Add-new and Add-existing tabs visually and structurally consistent.
 */

import {
  Square,
  GitBranch,
  Repeat,
  Clock,
  Code,
  Plug,
  Monitor,
  User,
  Bot,
  Wrench,
  ClipboardEdit,
} from 'lucide-react';
import type { NodeType, NodeCategory } from '@agent-platform/shared-kernel/types';

export const STEP_ICON_MAP: Partial<Record<NodeType, React.ComponentType<{ className?: string }>>> =
  {
    agent: Bot,
    tool: Wrench,
    function: Code,
    integration: Plug,
    browser: Monitor,
    human: User,
    data_entry: ClipboardEdit,
    condition: GitBranch,
    loop: Repeat,
    delay: Clock,
    end: Square,
  };

/** Category display order used by both the Add-new and Add-existing tabs. */
export const CATEGORY_ORDER: NodeCategory[] = [
  'flow_control',
  'action',
  'agent',
  'tool',
  'human_in_loop',
];

/** Canonical node-type order within categories. Add-new renders these
 * cards in this order; Add-existing uses the same order to sort its
 * per-type sections so users see a consistent mental layout. */
export const MENU_NODE_TYPES: NodeType[] = [
  'integration',
  'function',
  'agent',
  'tool',
  'condition',
  'loop',
  'delay',
  'human',
  'data_entry',
  'end',
];
