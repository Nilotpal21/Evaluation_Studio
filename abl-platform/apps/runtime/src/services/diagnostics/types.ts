/**
 * Unified Diagnostic Engine Types
 *
 * Single DiagnosticReport shape consumed by CLI, MCP tools, Studio, and API.
 */

import type { CanonicalConfigurationClassification } from './configuration-taxonomy.js';

export interface DiagnosticFinding {
  analyzer: string;
  severity: 'error' | 'warning' | 'info';
  code: string;
  title: string;
  detail: string;
  suggestion: string;
  evidence: DiagnosticEvidence[];
  canonical?: CanonicalConfigurationClassification;
}

export interface DiagnosticEvidence {
  type: 'config' | 'trace_event' | 'db_record' | 'execution' | 'ir_node';
  label: string;
  data: Record<string, unknown>;
}

export interface DiagnosticReport {
  status: 'healthy' | 'degraded' | 'broken';
  target: {
    type: 'agent' | 'session' | 'execution';
    id: string;
    agentName: string;
  };
  findings: DiagnosticFinding[];
  summary: {
    errors: number;
    warnings: number;
    infos: number;
    analyzersRun: string[];
  };
  config: {
    model?: {
      chain: Array<{
        level: number;
        name: string;
        checked: boolean;
        matched: boolean;
        value?: string;
        reason: string;
      }>;
      resolved?: { modelId: string; provider: string; source: string };
    };
    credentials?: {
      provider: string;
      available: boolean;
      scope?: string;
      isActive?: boolean;
    };
    tools?: {
      total: number;
      bound: number;
      failed: string[];
    };
  };
  timestamp: string;
}

export type DiagnosticDepth = 'quick' | 'standard' | 'deep';

export interface DiagnosticContext {
  tenantId: string;
  projectId: string;
  agentName?: string;
  sessionId?: string;
  depth: DiagnosticDepth;
}

export interface Analyzer {
  name: string;
  category: 'infra' | 'execution' | 'behavioral';
  analyze(context: DiagnosticContext): Promise<DiagnosticFinding[]>;
}
