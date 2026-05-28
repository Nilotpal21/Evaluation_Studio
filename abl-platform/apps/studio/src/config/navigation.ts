/**
 * Navigation Configuration
 *
 * Single source of truth for all navigation items.
 * Used by both ProjectSidebar and UniversalSearch.
 */

import {
  Bot,
  Workflow,
  LayoutDashboard,
  Wrench,
  BookOpen,
  Library,
  Plug,
  FlaskConical,
  MessageSquare,
  Rocket,
  Inbox,
  Bell,
  TrendingUp,
  BarChart3,
  Activity,
  Eye,
  Sparkles,
  ShieldAlert,
  Landmark,
  Settings,
  Key,
  Cpu,
  Variable,
  GitBranch,
  Cog,
  LineChart,
  Phone,
  Shield,
  PhoneForwarded,
  Headphones,
  Radio,
  CreditCard,
  Package,
  Languages,
  Globe,
  Database,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { ProjectPage } from '../store/navigation-store';

export interface NavItemDef {
  id: ProjectPage;
  Icon: LucideIcon;
  key: string;
  group?: string;
}

export interface NavGroup {
  id: string;
  Icon: LucideIcon;
  key: string;
  defaultPage: ProjectPage;
  pages: ProjectPage[];
  items: NavItemDef[];
}

// =============================================================================
// BUILD SECTION - Core building blocks
// =============================================================================

export const buildNavDefs: NavItemDef[] = [
  { id: 'overview', Icon: LayoutDashboard, key: 'overview' },
  { id: 'agents', Icon: Bot, key: 'agents' },
  { id: 'workflows', Icon: Workflow, key: 'workflows' },
];

// =============================================================================
// RESOURCES SECTION - Tools, data, integrations
// =============================================================================

export const resourceNavDefs: NavItemDef[] = [
  { id: 'tools', Icon: Wrench, key: 'tools' },
  { id: 'search-ai', Icon: BookOpen, key: 'knowledge_bases' },
  { id: 'prompt-library', Icon: Library, key: 'prompt_library' },
  { id: 'connections', Icon: Plug, key: 'integrations' },
  { id: 'module-dependencies', Icon: Package, key: 'dependencies' },
];

// =============================================================================
// NAVIGATION GROUPS - Expandable sections with sub-pages
// =============================================================================

export const navGroups: NavGroup[] = [
  {
    id: 'evaluate',
    Icon: FlaskConical,
    key: 'evaluate_group',
    defaultPage: 'evals',
    pages: ['evals', 'experiments'],
    items: [
      { id: 'evals', Icon: FlaskConical, key: 'evals', group: 'evaluate' },
      // Experiments is temporarily disabled in discoverable navigation.
      // Keep the page registered for direct routes and inventory locks.
    ],
  },
  {
    id: 'operate',
    Icon: MessageSquare,
    key: 'operate_group',
    defaultPage: 'sessions',
    pages: ['sessions', 'deployments', 'inbox', 'alerts', 'transfer-sessions'],
    items: [
      { id: 'sessions', Icon: MessageSquare, key: 'sessions', group: 'operate' },
      { id: 'deployments', Icon: Rocket, key: 'deployments', group: 'operate' },
      { id: 'inbox', Icon: Inbox, key: 'inbox', group: 'operate' },
      { id: 'alerts', Icon: Bell, key: 'alerts', group: 'operate' },
      { id: 'transfer-sessions', Icon: PhoneForwarded, key: 'transfer_sessions', group: 'operate' },
    ],
  },
  {
    id: 'insights',
    Icon: TrendingUp,
    key: 'insights_group',
    defaultPage: 'dashboard',
    pages: [
      'dashboard',
      'analytics',
      'billing',
      'agent-performance',
      'quality-monitor',
      'customer-insights',
      'voice-analytics',
      'agent-transfer-insights',
    ],
    items: [
      { id: 'dashboard', Icon: TrendingUp, key: 'insights_dashboard', group: 'insights' },
      { id: 'analytics', Icon: BarChart3, key: 'analytics', group: 'insights' },
      { id: 'billing', Icon: CreditCard, key: 'billing_usage', group: 'insights' },
      { id: 'agent-performance', Icon: Activity, key: 'agent_performance', group: 'insights' },
      { id: 'quality-monitor', Icon: Eye, key: 'quality_monitor', group: 'insights' },
      { id: 'customer-insights', Icon: Sparkles, key: 'customer_insights', group: 'insights' },
      { id: 'voice-analytics', Icon: Phone, key: 'voice_analytics', group: 'insights' },
      {
        id: 'agent-transfer-insights',
        Icon: PhoneForwarded,
        key: 'agent_transfer_insights',
        group: 'insights',
      },
    ],
  },
  {
    id: 'govern',
    Icon: ShieldAlert,
    key: 'govern_group',
    defaultPage: 'guardrails-config',
    pages: ['guardrails-config', 'governance'],
    items: [
      { id: 'guardrails-config', Icon: ShieldAlert, key: 'guardrails_config', group: 'govern' },
      { id: 'governance', Icon: Landmark, key: 'governance_label', group: 'govern' },
    ],
  },
  {
    id: 'settings',
    Icon: Settings,
    key: 'settings_group',
    defaultPage: 'settings-members',
    pages: [
      'settings-members',
      'settings-api-keys',
      'settings-models',
      'settings-config-vars',
      'settings-localization',
      'settings-git',
      'settings-advanced',
      'settings-runtime-config',
      'settings-data-retention',
      'settings-trace-dimensions',
      'settings-agent-transfer',
      'settings-agent-assist',
      'settings-pii-protection',
      'settings-public-api',
      'settings-omnichannel',
      'settings-modules',
    ],
    items: [
      { id: 'settings-members', Icon: Settings, key: 'members', group: 'settings' },
      { id: 'settings-api-keys', Icon: Key, key: 'api_keys', group: 'settings' },
      { id: 'settings-models', Icon: Cpu, key: 'models', group: 'settings' },
      { id: 'settings-config-vars', Icon: Variable, key: 'config_vars', group: 'settings' },
      {
        id: 'settings-localization',
        Icon: Languages,
        key: 'localization',
        group: 'settings',
      },
      { id: 'settings-git', Icon: GitBranch, key: 'git', group: 'settings' },
      { id: 'settings-advanced', Icon: Cog, key: 'advanced', group: 'settings' },
      { id: 'settings-runtime-config', Icon: Cog, key: 'runtime_config', group: 'settings' },
      {
        id: 'settings-data-retention',
        Icon: Database,
        key: 'data_retention',
        group: 'settings',
      },
      {
        id: 'settings-trace-dimensions',
        Icon: LineChart,
        key: 'trace_dimensions',
        group: 'settings',
      },
      {
        id: 'settings-agent-transfer',
        Icon: PhoneForwarded,
        key: 'agent_transfer',
        group: 'settings',
      },
      {
        id: 'settings-agent-assist',
        Icon: Headphones,
        key: 'agent_assist',
        group: 'settings',
      },
      { id: 'settings-pii-protection', Icon: Shield, key: 'pii_protection', group: 'settings' },
      { id: 'settings-public-api', Icon: Globe, key: 'public_api', group: 'settings' },
      { id: 'settings-omnichannel', Icon: Radio, key: 'omnichannel', group: 'settings' },
      { id: 'settings-modules', Icon: Package, key: 'modules', group: 'settings' },
    ],
  },
];

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Get all flat navigation items (build + resource items + all group items)
 * Use this for universal search to get all possible pages
 */
export function getAllNavItems(): NavItemDef[] {
  const allItems: NavItemDef[] = [];

  // Add build items
  allItems.push(...buildNavDefs);

  // Add resource items
  allItems.push(...resourceNavDefs);

  // Add all items from groups
  navGroups.forEach((group) => {
    allItems.push(...group.items);
  });

  return allItems;
}
