/**
 * Spec Document types — Design spec: 2026-04-12-arch-spec-document-design.md
 *
 * Persistent unified document capturing business requirements + architecture
 * decisions. Lives in `arch_spec_documents` collection.
 *
 * IMPORTANT: Field names MUST match the Mongoose schema in
 * packages/database/src/models/arch-spec-document.model.ts
 */

import { z } from 'zod';
import type { ConversationNote } from '../types/specification.js';

// Re-export for convenience
export type { ConversationNote };

// ─── Sub-type schemas ───────────────────────────────────────────────────

export const ComplianceEntrySchema = z.object({
  standard: z.string().min(1),
  severity: z.enum(['must', 'should', 'nice']),
  detail: z.string().min(1),
});
export type ComplianceEntry = z.infer<typeof ComplianceEntrySchema>;

export const PersonaEntrySchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  context: z.string(),
});
export type PersonaEntry = z.infer<typeof PersonaEntrySchema>;

export const SLAEntrySchema = z.object({
  metric: z.string().min(1),
  target: z.string().min(1),
  unit: z.string().min(1),
});
export type SLAEntry = z.infer<typeof SLAEntrySchema>;

export const AgentSummarySchema = z.object({
  name: z.string().min(1),
  role: z.string(),
  executionMode: z.enum(['reasoning', 'scripted', 'hybrid']),
  model: z.string().nullable().default(null),
  description: z.string(),
  compileStatus: z
    .enum(['pending', 'generated', 'compiled', 'warning', 'error'])
    .nullable()
    .default(null),
});
export type AgentSummary = z.infer<typeof AgentSummarySchema>;

export const EdgeSummarySchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  type: z.enum(['delegate', 'escalate', 'transfer']),
  condition: z.string(),
});
export type EdgeSummary = z.infer<typeof EdgeSummarySchema>;

export const ToolSummarySchema = z.object({
  name: z.string().min(1),
  agent: z.string().min(1),
  type: z.string(),
  description: z.string(),
});
export type ToolSummary = z.infer<typeof ToolSummarySchema>;

export const GuardrailSummarySchema = z.object({
  rule: z.string().min(1),
  agent: z.string().min(1),
  severity: z.string(),
  onFail: z.string(),
});
export type GuardrailSummary = z.infer<typeof GuardrailSummarySchema>;

export const DecisionEntrySchema = z.object({
  date: z.string().min(1),
  what: z.string().min(1),
  why: z.string().min(1),
  phase: z.string().min(1),
});
export type DecisionEntry = z.infer<typeof DecisionEntrySchema>;

// ─── Section schemas ────────────────────────────────────────────────────

export const BusinessSectionSchema = z.object({
  projectName: z.string().default(''),
  objective: z.string().nullable().default(null),
  channels: z.array(z.string()).default([]),
  language: z.string().default('English'),
  compliance: z.array(ComplianceEntrySchema).default([]),
  constraints: z.array(z.string()).default([]),
  personas: z.array(PersonaEntrySchema).default([]),
  slas: z.array(SLAEntrySchema).default([]),
  edgeCases: z.array(z.string()).default([]),
  notes: z.array(z.unknown().transform((v) => v as ConversationNote)).default([]),
});
export type BusinessSection = z.infer<typeof BusinessSectionSchema>;

export const ArchitectureSectionSchema = z.object({
  pattern: z.string().nullable().default(null),
  entryPoint: z.string().nullable().default(null),
  agentCount: z.number().default(0),
  agents: z.array(AgentSummarySchema).default([]),
  edges: z.array(EdgeSummarySchema).default([]),
  rationale: z.string().nullable().default(null),
});
export type ArchitectureSection = z.infer<typeof ArchitectureSectionSchema>;

export const ImplementationSectionSchema = z.object({
  tools: z.array(ToolSummarySchema).default([]),
  guardrails: z.array(GuardrailSummarySchema).default([]),
  buildStatus: z.string().nullable().default(null),
});
export type ImplementationSection = z.infer<typeof ImplementationSectionSchema>;

// ─── Full document interface ────────────────────────────────────────────

export interface IArchSpecDocument {
  _id: string;
  tenantId: string;
  userId: string;
  sessionId: string;
  projectId: string | null;
  version: number;
  business: BusinessSection;
  architecture: ArchitectureSection;
  implementation: ImplementationSection;
  decisions: DecisionEntry[];
  createdAt: Date;
  updatedAt: Date;
}

// ─── Section status ─────────────────────────────────────────────────────

export type SectionStatus = 'empty' | 'draft' | 'complete';

export function getBusinessStatus(business: BusinessSection): SectionStatus {
  if (!business.projectName) return 'empty';
  if (!business.objective) return 'draft';
  return 'complete';
}

export function getArchitectureStatus(arch: ArchitectureSection): SectionStatus {
  if (arch.agents.length === 0) return 'empty';
  if (!arch.entryPoint) return 'draft';
  return 'complete';
}

export function getImplementationStatus(impl: ImplementationSection): SectionStatus {
  if (impl.tools.length === 0 && impl.guardrails.length === 0) return 'empty';
  if (!impl.buildStatus) return 'draft';
  return 'complete';
}
