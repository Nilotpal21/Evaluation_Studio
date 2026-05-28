/**
 * Arch AI Spec Document Model
 *
 * Stores the living specification document extracted from an Arch session.
 * One document per session; optionally linked to a project after acceptance.
 *
 * Indexes:
 *   - Unique { tenantId, sessionId } — idempotent creation
 *   - Partial unique { tenantId, projectId } — idempotent linking (non-null only)
 *   - Non-unique { tenantId, userId } — list view
 */

import mongoose, { Schema, model } from 'mongoose';
import { uuidv7 } from '../mongo/base-document.js';
import { tenantIsolationPlugin } from '../mongo/plugins/tenant-isolation.plugin.js';

// ─── Sub-interfaces ──────────────────────────────────────────────────────

export interface IComplianceItem {
  standard: string;
  severity: string;
  detail: string;
}

export interface IPersona {
  name: string;
  description: string;
  context: string;
}

export interface ISLA {
  metric: string;
  target: string;
  unit: string;
}

export interface ISpecAgent {
  name: string;
  role: string;
  executionMode: string;
  model: string;
  description: string;
  compileStatus: string;
}

export interface ISpecEdge {
  from: string;
  to: string;
  type: string;
  condition: string;
}

export interface ISpecTool {
  name: string;
  agent: string;
  type: string;
  description: string;
}

export interface IGuardrail {
  rule: string;
  agent: string;
  severity: string;
  onFail: string;
}

export interface ISpecDecision {
  date: string;
  what: string;
  why: string;
  phase: string;
}

// ─── Nested object interfaces ────────────────────────────────────────────

export interface ISpecBusiness {
  projectName: string;
  objective: string | null;
  channels: string[];
  language: string;
  compliance: IComplianceItem[];
  constraints: string[];
  personas: IPersona[];
  slas: ISLA[];
  edgeCases: string[];
  notes: unknown[];
}

export interface ISpecArchitecture {
  pattern: string | null;
  entryPoint: string | null;
  agentCount: number;
  agents: ISpecAgent[];
  edges: ISpecEdge[];
  rationale: string | null;
}

export interface ISpecImplementation {
  tools: ISpecTool[];
  guardrails: IGuardrail[];
  buildStatus: string | null;
}

// ─── Document Interface ──────────────────────────────────────────────────

export interface IArchSpecDocument {
  _id: string;
  tenantId: string;
  userId: string;
  sessionId: string;
  projectId: string | null;
  version: number;
  business: ISpecBusiness;
  architecture: ISpecArchitecture;
  implementation: ISpecImplementation;
  decisions: ISpecDecision[];
  createdAt: Date;
  updatedAt: Date;
}

// ─── Sub-schemas ─────────────────────────────────────────────────────────

const ComplianceItemSchema = new Schema<IComplianceItem>(
  {
    standard: { type: String, required: true },
    severity: { type: String, required: true },
    detail: { type: String, required: true },
  },
  { _id: false },
);

const PersonaSchema = new Schema<IPersona>(
  {
    name: { type: String, required: true },
    description: { type: String, required: true },
    context: { type: String, required: true },
  },
  { _id: false },
);

const SLASchema = new Schema<ISLA>(
  {
    metric: { type: String, required: true },
    target: { type: String, required: true },
    unit: { type: String, required: true },
  },
  { _id: false },
);

const SpecAgentSchema = new Schema<ISpecAgent>(
  {
    name: { type: String, required: true },
    role: { type: String, required: true },
    executionMode: { type: String, required: true },
    model: { type: String, required: true },
    description: { type: String, required: true },
    compileStatus: { type: String, required: true },
  },
  { _id: false },
);

const SpecEdgeSchema = new Schema<ISpecEdge>(
  {
    from: { type: String, required: true },
    to: { type: String, required: true },
    type: { type: String, required: true },
    condition: { type: String, required: true },
  },
  { _id: false },
);

const SpecToolSchema = new Schema<ISpecTool>(
  {
    name: { type: String, required: true },
    agent: { type: String, required: true },
    type: { type: String, required: true },
    description: { type: String, required: true },
  },
  { _id: false },
);

const GuardrailSchema = new Schema<IGuardrail>(
  {
    rule: { type: String, required: true },
    agent: { type: String, required: true },
    severity: { type: String, required: true },
    onFail: { type: String, required: true },
  },
  { _id: false },
);

const SpecDecisionSchema = new Schema<ISpecDecision>(
  {
    date: { type: String, required: true },
    what: { type: String, required: true },
    why: { type: String, required: true },
    phase: { type: String, required: true },
  },
  { _id: false },
);

// ─── Nested object sub-schemas ───────────────────────────────────────────

const SpecBusinessSchema = new Schema<ISpecBusiness>(
  {
    projectName: { type: String, required: true },
    objective: { type: String, default: null },
    channels: { type: [String], default: [] },
    language: { type: String, required: true },
    compliance: { type: [ComplianceItemSchema], default: [] },
    constraints: { type: [String], default: [] },
    personas: { type: [PersonaSchema], default: [] },
    slas: { type: [SLASchema], default: [] },
    edgeCases: { type: [String], default: [] },
    notes: { type: [Schema.Types.Mixed], default: [] },
  },
  { _id: false },
);

const SpecArchitectureSchema = new Schema<ISpecArchitecture>(
  {
    pattern: { type: String, default: null },
    entryPoint: { type: String, default: null },
    agentCount: { type: Number, required: true, default: 0 },
    agents: { type: [SpecAgentSchema], default: [] },
    edges: { type: [SpecEdgeSchema], default: [] },
    rationale: { type: String, default: null },
  },
  { _id: false },
);

const SpecImplementationSchema = new Schema<ISpecImplementation>(
  {
    tools: { type: [SpecToolSchema], default: [] },
    guardrails: { type: [GuardrailSchema], default: [] },
    buildStatus: { type: String, default: null },
  },
  { _id: false },
);

// ─── Main Schema ─────────────────────────────────────────────────────────

const ArchSpecDocumentSchema = new Schema<IArchSpecDocument>(
  {
    _id: { type: String, default: uuidv7 },
    tenantId: { type: String, required: true },
    userId: { type: String, required: true },
    sessionId: { type: String, required: true },
    projectId: { type: String, default: null },
    version: { type: Number, required: true, default: 1 },
    business: { type: SpecBusinessSchema, required: true },
    architecture: { type: SpecArchitectureSchema, required: true },
    implementation: { type: SpecImplementationSchema, required: true },
    decisions: { type: [SpecDecisionSchema], default: [] },
  },
  { timestamps: true, collection: 'arch_spec_documents' },
);

// ─── Plugins ─────────────────────────────────────────────────────────────

ArchSpecDocumentSchema.plugin(tenantIsolationPlugin);

// ─── Indexes ─────────────────────────────────────────────────────────────

// Unique per session — idempotent creation (one spec doc per session)
ArchSpecDocumentSchema.index({ tenantId: 1, sessionId: 1 }, { unique: true });

// Unique per project when linked (partial — only when projectId is a string)
ArchSpecDocumentSchema.index(
  { tenantId: 1, projectId: 1 },
  {
    unique: true,
    partialFilterExpression: { projectId: { $type: 'string' } },
  },
);

// List view — retrieve all spec docs for a user within a tenant
ArchSpecDocumentSchema.index({ tenantId: 1, userId: 1 });

// ─── Model ───────────────────────────────────────────────────────────────

export const ArchSpecDocument =
  (mongoose.models.ArchSpecDocument as mongoose.Model<IArchSpecDocument>) ||
  model<IArchSpecDocument>('ArchSpecDocument', ArchSpecDocumentSchema);
