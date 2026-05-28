/**
 * Import Types
 *
 * Type definitions for Kore.ai Agent Platform (v12) and XO11 import converters.
 */

import type { ArchitectureSpec, GapReport } from '../architect/types.js';

// =============================================================================
// FORMAT DETECTION
// =============================================================================

export type ImportFormat = 'agent-platform' | 'xo11' | 'unknown';

// =============================================================================
// AGENT PLATFORM v12 TYPES
// =============================================================================

export interface AgentPlatformToolProperty {
  name?: string;
  property?: string; // Some exports use "property" instead of "name"
  type: string;
  description?: string;
  required?: boolean;
}

export interface AgentPlatformTool {
  name: string;
  description?: string;
  properties?: AgentPlatformToolProperty[];
}

export interface AgentPlatformMCPServer {
  name: string;
  tools: AgentPlatformTool[];
}

export interface AgentPlatformInstruction {
  text: string;
  type?: string;
}

export interface AgentPlatformPrompt {
  custom?: string;
  instructions?: AgentPlatformInstruction[];
}

export interface AgentPlatformProcessor {
  name?: string;
  type?: string;
  script?: string;
}

export interface AgentPlatformAgentToolRef {
  name: string;
  type?: string; // e.g. "MCP"
}

export interface AgentPlatformAgent {
  name: string;
  subType?: string;
  prompt?: AgentPlatformPrompt;
  tools?: Array<string | AgentPlatformAgentToolRef>; // Tool names or refs
  aiModel?: Record<string, unknown>;
  processors?: AgentPlatformProcessor[];
  description?: string;
}

export interface AgentPlatformMemoryStore {
  name?: string;
  memoryStoreName?: string; // Some exports use this field
  technicalMemoryKey?: string; // Technical key for the store
  type?: string;
  memSchema?: Record<string, unknown>;
}

export interface AgentPlatformAppVariable {
  key: string;
  value: string;
  scope?: string;
}

export interface AgentPlatformContentVariable {
  key: string;
  value: string;
}

export interface AgentPlatformOrchestration {
  custom?: string;
  instructions?: AgentPlatformInstruction[];
}

export interface AgentPlatformApp {
  name?: string;
  description?: string;
  orchestrationPrompt?: AgentPlatformOrchestration;
  memoryStores?: AgentPlatformMemoryStore[];
  appVariables?: AgentPlatformAppVariable[];
  contentVariables?: AgentPlatformContentVariable[];
  appConfigurations?: Record<string, unknown>;
  piiConfigs?: Record<string, unknown>;
}

export interface AgentPlatformExport {
  app: AgentPlatformApp;
  MCPServers: AgentPlatformMCPServer[];
  agents: AgentPlatformAgent[];
}

// =============================================================================
// XO11 TYPES
// =============================================================================

export interface XO11EntityNode {
  name: string;
  type?: string;
  prompt?: string;
  required?: boolean;
  patterns?: string[];
}

export interface XO11MessageNode {
  name: string;
  message?: string;
  channel?: string;
}

export interface XO11WebhookNode {
  name: string;
  url?: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  responseMapping?: Record<string, string>;
}

export interface XO11ScriptNode {
  name: string;
  script: string;
  language?: string;
}

export interface XO11Transition {
  from: string;
  to: string;
  condition?: string;
}

export interface XO11DialogFlow {
  name: string;
  intent?: string;
  nodes: Array<XO11EntityNode | XO11MessageNode | XO11WebhookNode | XO11ScriptNode>;
  transitions: XO11Transition[];
}

export interface XO11Export {
  dialogFlows?: XO11DialogFlow[];
  dialogTasks?: XO11DialogFlow[];
  entityNodes?: XO11EntityNode[];
  messageNodes?: XO11MessageNode[];
  webhookNodes?: XO11WebhookNode[];
  scriptNodes?: XO11ScriptNode[];
  subIntents?: string[];
}

// =============================================================================
// IMPORT ANALYSIS RESULT
// =============================================================================

export interface EntityMapping {
  source: string; // Original entity name/path
  sourceType: string; // Original type (e.g., "agent", "tool", "dialog_flow")
  target: string; // ABL entity name
  targetType: string; // ABL type (e.g., "AGENT", "TOOL", "FLOW_STEP")
  notes?: string; // Mapping notes
}

export interface ImportAnalysis {
  format: ImportFormat;
  summary: {
    agentCount: number;
    toolCount: number;
    flowCount?: number;
    supervisorDetected: boolean;
    description: string;
  };
  mappings: EntityMapping[];
  gapReport: GapReport;
  suggestedTopology: 'single-agent' | 'supervisor' | 'adaptive-network';
  rawEntities: {
    agents: string[];
    tools: string[];
    flows?: string[];
    intents?: string[];
  };
}

// =============================================================================
// IMPORT CONVERT INPUT
// =============================================================================

export interface ImportConvertInput {
  analysis: ImportAnalysis;
  sourceJson: unknown;
  outputDir: string;
}

// =============================================================================
// IMPORT CONVERT RESULT
// =============================================================================

export interface ImportConvertResult {
  projectDir: string;
  filesCreated: string[];
  summary: string;
  gapReport: GapReport;
}
