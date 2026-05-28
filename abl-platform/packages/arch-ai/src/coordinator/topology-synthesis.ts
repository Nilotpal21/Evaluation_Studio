/**
 * Topology Synthesis — deterministic server-side fallback for BLUEPRINT.
 *
 * When the LLM fails to generate a topology (e.g. it keeps asking questions
 * in a loop), we synthesize a minimal-valid topology from the specification
 * so the user always has something concrete to react to. The user can then
 * modify/reject the topology and the architect will regenerate from there.
 *
 * Design principles:
 * - Single Agent pattern (1 agent, 0 edges) is always valid.
 * - Name derived from projectName (PascalCase + "Agent" suffix).
 * - Uses description as the agent role/description.
 * - Execution mode = 'reasoning' (safest default for unknown domain).
 * - No dependencies on LLM — pure deterministic transformation.
 *
 * Pattern vocabulary (Phase 3.3):
 * - 5 canonical topology patterns with selection criteria
 * - classifyTopologyPattern() analyzes spec text for pattern signals
 * - synthesizePatternTopology() generates a pattern-specific topology
 */

import type { Specification } from '../types/specification.js';
import type { TopologyOutput, TopologyAgent, TopologyEdge } from '../types/blueprint.js';
import { inferArchModelPolicyFromText } from '../model-policy.js';

// ─── Topology Pattern Vocabulary ────────────────────────────────────────────

/**
 * Canonical topology pattern IDs.
 * These map 1:1 to the pattern catalog in the multi-agent-architect prompt.
 */
export type TopologyPatternId =
  | 'single_agent'
  | 'triage_specialists'
  | 'pipeline'
  | 'hub_spoke'
  | 'peer_mesh';

export interface TopologyPatternDef {
  id: TopologyPatternId;
  name: string;
  description: string;
  whenToUse: string;
  /** Agent roles this pattern creates (templates — actual names derived from spec) */
  agentRoles: string[];
  /** Edge structure description */
  edgeStructure: string;
  /** ABL edge types used */
  edgeTypes: Array<'delegate' | 'escalate' | 'transfer'>;
  /** Keywords in spec that suggest this pattern */
  selectionSignals: string[];
  /** Anti-patterns — when NOT to use */
  antiPatterns: string[];
}

/**
 * The 5 canonical topology patterns.
 *
 * Each pattern defines:
 * - Structure (agent roles, edge layout)
 * - Selection criteria (domain signals from spec)
 * - ABL implications (edge types, execution modes)
 */
export const TOPOLOGY_PATTERN_VOCABULARY: TopologyPatternDef[] = [
  {
    id: 'single_agent',
    name: 'Single Agent',
    description:
      'One agent handles everything. Simplest possible topology with zero routing overhead.',
    whenToUse:
      'Simple use cases, single domain, low complexity. Q&A bots, task-completion assistants, single-purpose tools.',
    agentRoles: ['main'],
    edgeStructure: '0 edges. No routing, no handoffs.',
    edgeTypes: [],
    selectionSignals: ['simple', 'single', 'basic', 'one agent', 'standalone', 'faq', 'chatbot'],
    antiPatterns: [
      'Do not use when there are 2+ clearly distinct capability domains.',
      'Do not add a supervisor wrapper around a single agent.',
    ],
  },
  {
    id: 'triage_specialists',
    name: 'Triage -> Specialists',
    description:
      'A supervisor/triage agent classifies user intent and routes to domain-specific specialists. The most common multi-agent pattern.',
    whenToUse:
      'Multi-domain support, customer service, diverse intents. Any scenario where user requests span multiple distinct domains.',
    agentRoles: ['triage', 'specialist_a', 'specialist_b', 'escalation'],
    edgeStructure:
      'Star topology — triage at center with delegate edges to each specialist. One escalate edge to human handoff.',
    edgeTypes: ['delegate', 'escalate'],
    selectionSignals: [
      'route',
      'triage',
      'classify',
      'customer support',
      'helpdesk',
      'departments',
      'categories',
      'intent',
      'multi-domain',
      'support',
    ],
    antiPatterns: [
      'Do not use for sequential workflows — if step 2 always follows step 1, use Pipeline.',
      'Do not create specialists with overlapping responsibilities.',
    ],
  },
  {
    id: 'pipeline',
    name: 'Pipeline',
    description:
      'Sequential chain where each agent processes and passes to the next. Each stage transforms or enriches data.',
    whenToUse:
      'Data processing, content pipelines, multi-step workflows. Loan processing, document intake, multi-step approval.',
    agentRoles: ['intake', 'processor', 'reviewer', 'output'],
    edgeStructure:
      'Linear chain — each agent delegates to the next with expectReturn:true so control flows back.',
    edgeTypes: ['delegate', 'escalate'],
    selectionSignals: [
      'sequential',
      'pipeline',
      'steps',
      'process',
      'stages',
      'workflow',
      'intake',
      'approval',
      'review',
      'chain',
      'multi-step',
      'document processing',
    ],
    antiPatterns: [
      'Do not use when steps can run in parallel — use Hub-and-Spoke instead.',
      'Do not use for conversational routing — Pipeline assumes fixed sequence.',
    ],
  },
  {
    id: 'hub_spoke',
    name: 'Hub-and-Spoke',
    description:
      'Central coordinator delegates to parallel workers and aggregates results. Fan-out/fan-in pattern.',
    whenToUse:
      'Parallel processing, fan-out/fan-in, research tasks. Multi-source aggregation, complex analysis, event planning.',
    agentRoles: ['coordinator', 'worker_a', 'worker_b', 'aggregator'],
    edgeStructure:
      'Hub delegates to spokes with expectReturn:true. Coordinator aggregates results from all workers.',
    edgeTypes: ['delegate', 'escalate'],
    selectionSignals: [
      'parallel',
      'concurrent',
      'fan-out',
      'fan-in',
      'batch',
      'aggregate',
      'coordinate',
      'research',
      'multi-source',
      'gather from',
      'collect from',
    ],
    antiPatterns: [
      'Do not use for simple intent routing — if coordinator does not need results back, use Triage.',
      'Do not delegate to more than 5 workers in parallel.',
    ],
  },
  {
    id: 'peer_mesh',
    name: 'Peer Mesh',
    description:
      'Agents hand off to each other without a central coordinator. Fully decentralized, peer-to-peer routing.',
    whenToUse:
      'Collaborative workflows, peer review, escalation chains. Multi-department support where any agent can route to any other.',
    agentRoles: ['peer_a', 'peer_b', 'peer_c'],
    edgeStructure:
      'Bidirectional transfer/delegate edges between peers. Requires allowCycle on edges. Every agent has routing capability.',
    edgeTypes: ['delegate', 'transfer', 'escalate'],
    selectionSignals: [
      'peer',
      'mesh',
      'bidirectional',
      'mutual',
      'any-to-any',
      'collaborative',
      'peer review',
      'cross-team',
      'dynamic routing',
    ],
    antiPatterns: [
      'Never use mesh for fewer than 3 agents.',
      'Avoid without explicit cycle limits — unbounded loops confuse users.',
      'Do not use when a clear hierarchy exists — use Triage or Hub-and-Spoke instead.',
    ],
  },
];

/**
 * Decision tree text for pattern selection.
 * Used by the multi-agent-architect specialist prompt.
 */
export const TOPOLOGY_DECISION_TREE = `Q1: How many distinct capability domains?
  -> 1 domain -> SINGLE AGENT
  -> 2+ domains:
    Q2: Is the workflow sequential (each step feeds the next)?
      -> Yes -> PIPELINE
      -> No:
        Q3: Does a central agent need results back from sub-agents?
          -> Yes -> HUB-AND-SPOKE
          -> No:
            Q4: Can users enter from multiple points / agents are peers?
              -> Yes -> PEER MESH
              -> No -> TRIAGE -> SPECIALISTS`;

function withInferredModelPolicies(topology: TopologyOutput): TopologyOutput {
  return {
    ...topology,
    agents: topology.agents.map((agent) => {
      if (agent.modelPolicy) return agent;
      return {
        ...agent,
        modelPolicy: inferArchModelPolicyFromText({
          name: agent.name,
          role: agent.role,
          description: agent.description,
          executionMode: agent.executionMode,
          isEntryPoint: topology.entryPoint === agent.name,
          hasOutgoingEdges: topology.edges.some((edge) => edge.from === agent.name),
        }),
      };
    }),
  };
}

// ─── Pattern Selection Logic ────────────────────────────────────────────────

/**
 * Analyze a specification and classify which topology pattern best fits.
 *
 * Uses keyword matching against the spec's projectName, description,
 * and conversation notes. Returns the best-matching pattern ID with
 * a confidence score and the signals that matched.
 *
 * This is a deterministic heuristic — not LLM-driven. The multi-agent
 * architect can override this classification.
 */
export function classifyTopologyPattern(spec: Specification): {
  pattern: TopologyPatternId;
  confidence: 'high' | 'medium' | 'low';
  matchedSignals: string[];
  reasoning: string;
} {
  // Build a searchable corpus from the spec
  const corpus = buildSearchCorpus(spec);

  // Score each pattern by matching signals
  const scores: Array<{
    pattern: TopologyPatternId;
    score: number;
    matchedSignals: string[];
  }> = [];

  for (const patternDef of TOPOLOGY_PATTERN_VOCABULARY) {
    const matched: string[] = [];
    for (const signal of patternDef.selectionSignals) {
      if (corpus.includes(signal.toLowerCase())) {
        matched.push(signal);
      }
    }
    scores.push({
      pattern: patternDef.id,
      score: matched.length,
      matchedSignals: matched,
    });
  }

  // Sort by score descending
  scores.sort((a, b) => b.score - a.score);
  const best = scores[0];

  // Determine confidence
  let confidence: 'high' | 'medium' | 'low';
  if (best.score >= 3) {
    confidence = 'high';
  } else if (best.score >= 1) {
    confidence = 'medium';
  } else {
    confidence = 'low';
  }

  // If no signals matched, check for simple spec heuristics
  if (best.score === 0) {
    const agentCount = estimateAgentCount(spec);
    if (agentCount <= 1) {
      return {
        pattern: 'single_agent',
        confidence: 'medium',
        matchedSignals: [],
        reasoning: 'No strong domain signals detected. Simple spec suggests single agent.',
      };
    }
    // Default fallback
    return {
      pattern: 'triage_specialists',
      confidence: 'low',
      matchedSignals: [],
      reasoning:
        'No strong domain signals detected. Defaulting to Triage -> Specialists as safest multi-agent pattern.',
    };
  }

  const patternDef = TOPOLOGY_PATTERN_VOCABULARY.find((p) => p.id === best.pattern)!;
  return {
    pattern: best.pattern,
    confidence,
    matchedSignals: best.matchedSignals,
    reasoning: `Matched ${best.matchedSignals.length} signal(s) for ${patternDef.name}: ${best.matchedSignals.join(', ')}`,
  };
}

/**
 * Build a lowercase searchable string from all spec text fields.
 */
function buildSearchCorpus(spec: Specification): string {
  const parts: string[] = [spec.projectName?.toLowerCase() ?? ''];

  if (spec.description) {
    parts.push(spec.description.toLowerCase());
  }

  if (spec.conversationNotes) {
    for (const note of spec.conversationNotes) {
      if (note.detail) parts.push(note.detail.toLowerCase());
      if (note.label) parts.push(note.label.toLowerCase());
    }
  }

  return parts.join(' ');
}

/**
 * Estimate expected agent count from spec complexity.
 * Simple heuristic based on description length and conversation notes.
 */
function estimateAgentCount(spec: Specification): number {
  const descLen = spec.description?.length ?? 0;
  const noteCount = spec.conversationNotes?.length ?? 0;

  // Very short spec with no notes: likely single agent
  if (descLen < 100 && noteCount <= 1) return 1;
  // Medium spec: likely 2-3 agents
  if (descLen < 300 && noteCount <= 3) return 2;
  // Complex spec: likely 3+ agents
  return 3;
}

// ─── Pattern-Aware Topology Synthesis ───────────────────────────────────────

/**
 * Synthesize a topology for a specific pattern.
 *
 * Unlike synthesizeDefaultTopology (which always produces a single agent),
 * this generates a pattern-appropriate topology with multiple agents and
 * edges based on the selected pattern.
 *
 * The generated topology is still a starting point — the LLM architect
 * will refine agent names, roles, and descriptions based on the spec.
 */
export function synthesizePatternTopology(
  spec: Specification,
  patternId: TopologyPatternId,
): TopologyOutput {
  const agentName = deriveAgentName(spec.projectName);
  const baseRole = deriveAgentRole(spec);
  const corpus = buildSearchCorpus(spec);

  if (isInsuranceClaimsWorkflow(corpus)) {
    return withInferredModelPolicies(synthesizeInsuranceClaimsTopology());
  }

  let topology: TopologyOutput;
  switch (patternId) {
    case 'single_agent':
      topology = synthesizeSingleAgent(agentName, baseRole);
      break;
    case 'triage_specialists':
      topology = synthesizeTriageSpecialists(agentName, baseRole);
      break;
    case 'pipeline':
      topology = synthesizePipeline(agentName, baseRole);
      break;
    case 'hub_spoke':
      topology = synthesizeHubSpoke(agentName, baseRole);
      break;
    case 'peer_mesh':
      topology = synthesizePeerMesh(agentName, baseRole);
      break;
  }
  return withInferredModelPolicies(topology);
}

function isInsuranceClaimsWorkflow(corpus: string): boolean {
  const requiredSignals = ['claim', 'policy'];
  return (
    requiredSignals.every((signal) => corpus.includes(signal)) &&
    /\b(fraud|adjuster|payout|supplemental|incident|evidence|photo|document)\b/.test(corpus)
  );
}

function synthesizeInsuranceClaimsTopology(): TopologyOutput {
  const agents: TopologyAgent[] = [
    {
      name: 'ClaimsRouter',
      role: 'Classify claim requests and route to the right claims specialist',
      executionMode: 'hybrid',
      description:
        'Entry point for auto and property claim requests. Normalizes user intent, preserves claim context, and routes intake, evidence, status, payout, fraud, or escalation work.',
      gatherFields: ['claim_intent', 'policy_number', 'claim_number'],
      tools: ['lookup_policy', 'claim_status'],
      flowStepSeeds: ['normalize_intent', 'route_claim_request'],
      suggestedConstructs: ['GATHER', 'TOOLS', 'FLOW', 'HANDOFF'],
    },
    {
      name: 'ClaimIntakeAgent',
      role: 'Create claims from policy, incident, loss, and claimant details',
      executionMode: 'hybrid',
      description:
        'Collects policy and incident details, validates required claim fields, creates the claim record, and returns the claim reference to the router.',
      gatherFields: [
        'policy_number',
        'claimant_name',
        'incident_type',
        'incident_date',
        'incident_location',
        'loss_description',
        'estimated_loss_amount',
      ],
      tools: ['lookup_policy', 'create_claim'],
      flowStepSeeds: ['collect_claim_details', 'validate_policy', 'create_claim_record'],
      suggestedConstructs: ['GATHER', 'TOOLS', 'FLOW', 'COMPLETE'],
    },
    {
      name: 'EvidenceFraudReviewAgent',
      role: 'Collect evidence and run claim fraud risk checks',
      executionMode: 'hybrid',
      description:
        'Handles photo/document evidence, requests missing artifacts, runs fraud scoring, and returns a review recommendation for adjuster routing.',
      gatherFields: ['claim_number', 'evidence_notes', 'artifact_list', 'fraud_risk_reason'],
      tools: ['upload_evidence', 'fraud_score', 'request_documents'],
      flowStepSeeds: ['collect_evidence', 'score_fraud_risk', 'request_missing_documents'],
      suggestedConstructs: ['GATHER', 'TOOLS', 'FLOW', 'COMPLETE'],
    },
    {
      name: 'AdjusterAssignmentAgent',
      role: 'Assign the claim to an adjuster and package audit context',
      executionMode: 'hybrid',
      description:
        'Balances adjuster assignment, handles high-value or fraud-flagged routing, and prepares audit-ready context for claim operations.',
      gatherFields: ['claim_number', 'claim_type', 'estimated_loss_amount', 'fraud_score'],
      tools: ['assign_adjuster', 'claim_status'],
      flowStepSeeds: ['evaluate_assignment_rules', 'assign_adjuster', 'record_assignment'],
      suggestedConstructs: ['GATHER', 'TOOLS', 'FLOW', 'ESCALATE', 'COMPLETE'],
    },
    {
      name: 'ClaimStatusDocumentsAgent',
      role: 'Track claim status and chase supplemental documents',
      executionMode: 'hybrid',
      description:
        'Answers claim status questions, explains next milestones, and requests supplemental documentation when the claim cannot progress.',
      gatherFields: ['claim_number', 'requested_document_type', 'status_question'],
      tools: ['claim_status', 'request_documents'],
      flowStepSeeds: ['lookup_claim_status', 'identify_missing_documents', 'send_document_request'],
      suggestedConstructs: ['GATHER', 'TOOLS', 'FLOW', 'COMPLETE'],
    },
    {
      name: 'PayoutNotificationAgent',
      role: 'Notify claim payout decisions and confirm deposit method',
      executionMode: 'hybrid',
      description:
        'Confirms payout status, communicates payment timelines, captures deposit method preference, and sends payout notifications without collecting sensitive secrets.',
      gatherFields: ['claim_number', 'payout_decision', 'deposit_method_preference'],
      tools: ['claim_status', 'send_payout_notification'],
      flowStepSeeds: ['confirm_payout_status', 'confirm_deposit_method', 'send_notification'],
      suggestedConstructs: ['GATHER', 'TOOLS', 'FLOW', 'COMPLETE'],
    },
    {
      name: 'ClaimsEscalationDesk',
      role: 'Escalate high-value, fraud-flagged, or disputed claim cases to a human supervisor',
      executionMode: 'scripted',
      description:
        'Packages claim context for supervisor review when claim value exceeds policy limits, fraud is flagged, or the user requests human review.',
      gatherFields: ['claim_number', 'escalation_reason', 'preferred_contact_channel'],
      tools: ['claim_status', 'request_documents'],
      flowStepSeeds: ['collect_escalation_context', 'package_supervisor_handoff'],
      suggestedConstructs: ['GATHER', 'TOOLS', 'FLOW', 'COMPLETE'],
    },
  ];

  const edges: TopologyEdge[] = [
    {
      from: 'ClaimsRouter',
      to: 'ClaimIntakeAgent',
      type: 'transfer',
      condition: 'New claim intake, policy lookup, or incident filing is needed',
      expectReturn: true,
      experienceMode: 'shared_voice_handoff',
    },
    {
      from: 'ClaimsRouter',
      to: 'EvidenceFraudReviewAgent',
      type: 'transfer',
      condition: 'Evidence upload, supplemental documents, or fraud risk review is needed',
      expectReturn: true,
      experienceMode: 'shared_voice_handoff',
    },
    {
      from: 'ClaimsRouter',
      to: 'AdjusterAssignmentAgent',
      type: 'transfer',
      condition: 'Adjuster assignment or operations routing is needed',
      expectReturn: true,
      experienceMode: 'shared_voice_handoff',
    },
    {
      from: 'ClaimsRouter',
      to: 'ClaimStatusDocumentsAgent',
      type: 'transfer',
      condition: 'Claim status, ETA, or missing document follow-up is requested',
      expectReturn: true,
      experienceMode: 'shared_voice_handoff',
    },
    {
      from: 'ClaimsRouter',
      to: 'PayoutNotificationAgent',
      type: 'transfer',
      condition: 'Payout decision, deposit method, or payout notification is requested',
      expectReturn: true,
      experienceMode: 'shared_voice_handoff',
    },
    {
      from: 'ClaimsRouter',
      to: 'ClaimsEscalationDesk',
      type: 'escalate',
      condition:
        'Claim exceeds high-value threshold, fraud is flagged, or human review is requested',
      expectReturn: false,
      experienceMode: 'human_escalation',
    },
  ];

  return { agents, edges, entryPoint: 'ClaimsRouter' };
}

function synthesizeSingleAgent(name: string, role: string): TopologyOutput {
  return {
    agents: [
      {
        name,
        role,
        executionMode: 'reasoning',
        description: `Handles all interactions. ${role}`,
      },
    ],
    edges: [],
    entryPoint: name,
  };
}

function synthesizeTriageSpecialists(baseName: string, role: string): TopologyOutput {
  const triageName = 'TriageAgent';
  const specialistA = `${stripAgentSuffix(baseName)}SpecialistA`;
  const specialistB = `${stripAgentSuffix(baseName)}SpecialistB`;
  const escalationName = 'EscalationAgent';

  const agents: TopologyAgent[] = [
    {
      name: triageName,
      role: 'Classify user intent and route to the appropriate specialist',
      executionMode: 'reasoning',
      description: `Entry point. Classifies user intent and delegates to specialists. ${role}`,
    },
    {
      name: specialistA,
      role: `Handle domain A requests`,
      executionMode: 'reasoning',
      description: 'Specialist for domain A — replace with actual domain name.',
    },
    {
      name: specialistB,
      role: `Handle domain B requests`,
      executionMode: 'reasoning',
      description: 'Specialist for domain B — replace with actual domain name.',
    },
    {
      name: escalationName,
      role: 'Handle escalation to human agents',
      executionMode: 'reasoning',
      description: 'Routes unresolvable issues to a human operator.',
    },
  ];

  const edges: TopologyEdge[] = [
    {
      from: triageName,
      to: specialistA,
      type: 'transfer',
      condition: 'User intent matches domain A',
      expectReturn: true,
      experienceMode: 'shared_voice_handoff',
    },
    {
      from: triageName,
      to: specialistB,
      type: 'transfer',
      condition: 'User intent matches domain B',
      expectReturn: true,
      experienceMode: 'shared_voice_handoff',
    },
    {
      from: triageName,
      to: escalationName,
      type: 'escalate',
      condition: 'User requests human agent or issue is unresolvable',
      expectReturn: false,
      experienceMode: 'human_escalation',
    },
  ];

  return { agents, edges, entryPoint: triageName };
}

function synthesizePipeline(baseName: string, role: string): TopologyOutput {
  const base = stripAgentSuffix(baseName);
  const intakeName = `${base}IntakeAgent`;
  const processorName = `${base}ProcessorAgent`;
  const reviewerName = `${base}ReviewerAgent`;

  const agents: TopologyAgent[] = [
    {
      name: intakeName,
      role: `Collect and validate input data`,
      executionMode: 'hybrid',
      description: `First pipeline stage. Gathers input and validates before processing. ${role}`,
    },
    {
      name: processorName,
      role: 'Process and transform the collected data',
      executionMode: 'reasoning',
      description: 'Middle pipeline stage. Performs core processing logic.',
    },
    {
      name: reviewerName,
      role: 'Review results and produce final output',
      executionMode: 'reasoning',
      description: 'Final pipeline stage. Reviews and delivers output to the user.',
    },
  ];

  const edges: TopologyEdge[] = [
    {
      from: intakeName,
      to: processorName,
      type: 'transfer',
      condition: 'Input validation complete',
      expectReturn: true,
      experienceMode: 'shared_voice_handoff',
    },
    {
      from: processorName,
      to: reviewerName,
      type: 'transfer',
      condition: 'Processing complete',
      expectReturn: true,
      experienceMode: 'shared_voice_handoff',
    },
  ];

  return { agents, edges, entryPoint: intakeName };
}

function synthesizeHubSpoke(baseName: string, role: string): TopologyOutput {
  const coordinatorName = `${stripAgentSuffix(baseName)}CoordinatorAgent`;
  const workerA = `${stripAgentSuffix(baseName)}WorkerA`;
  const workerB = `${stripAgentSuffix(baseName)}WorkerB`;

  const agents: TopologyAgent[] = [
    {
      name: coordinatorName,
      role: `Coordinate parallel work and aggregate results`,
      executionMode: 'reasoning',
      description: `Central hub. Delegates subtasks and aggregates results. ${role}`,
    },
    {
      name: workerA,
      role: 'Handle subtask A and return results',
      executionMode: 'reasoning',
      description: 'Worker spoke A — replace with actual subtask description.',
    },
    {
      name: workerB,
      role: 'Handle subtask B and return results',
      executionMode: 'reasoning',
      description: 'Worker spoke B — replace with actual subtask description.',
    },
  ];

  const edges: TopologyEdge[] = [
    {
      from: coordinatorName,
      to: workerA,
      type: 'transfer',
      condition: 'Subtask A is needed',
      expectReturn: true,
      experienceMode: 'shared_voice_handoff',
    },
    {
      from: coordinatorName,
      to: workerB,
      type: 'transfer',
      condition: 'Subtask B is needed',
      expectReturn: true,
      experienceMode: 'shared_voice_handoff',
    },
  ];

  return { agents, edges, entryPoint: coordinatorName };
}

function synthesizePeerMesh(baseName: string, role: string): TopologyOutput {
  const base = stripAgentSuffix(baseName);
  const peerA = `${base}PeerA`;
  const peerB = `${base}PeerB`;
  const peerC = `${base}PeerC`;

  const agents: TopologyAgent[] = [
    {
      name: peerA,
      role: `Handle domain A and route to peers as needed`,
      executionMode: 'reasoning',
      description: `Peer agent A. Can hand off to B or C. ${role}`,
    },
    {
      name: peerB,
      role: 'Handle domain B and route to peers as needed',
      executionMode: 'reasoning',
      description: 'Peer agent B. Can hand off to A or C.',
    },
    {
      name: peerC,
      role: 'Handle domain C and route to peers as needed',
      executionMode: 'reasoning',
      description: 'Peer agent C. Can hand off to A or B.',
    },
  ];

  const edges: TopologyEdge[] = [
    {
      from: peerA,
      to: peerB,
      type: 'transfer',
      condition: 'Topic shifts to domain B',
      allowCycle: true,
      expectReturn: false,
      experienceMode: 'visible_handoff',
    },
    {
      from: peerA,
      to: peerC,
      type: 'transfer',
      condition: 'Topic shifts to domain C',
      allowCycle: true,
      expectReturn: false,
      experienceMode: 'visible_handoff',
    },
    {
      from: peerB,
      to: peerA,
      type: 'transfer',
      condition: 'Topic shifts to domain A',
      allowCycle: true,
      expectReturn: false,
      experienceMode: 'visible_handoff',
    },
    {
      from: peerB,
      to: peerC,
      type: 'transfer',
      condition: 'Topic shifts to domain C',
      allowCycle: true,
      expectReturn: false,
      experienceMode: 'visible_handoff',
    },
    {
      from: peerC,
      to: peerA,
      type: 'transfer',
      condition: 'Topic shifts to domain A',
      allowCycle: true,
      expectReturn: false,
      experienceMode: 'visible_handoff',
    },
    {
      from: peerC,
      to: peerB,
      type: 'transfer',
      condition: 'Topic shifts to domain B',
      allowCycle: true,
      expectReturn: false,
      experienceMode: 'visible_handoff',
    },
  ];

  return { agents, edges, entryPoint: peerA };
}

/**
 * Strip the "Agent" suffix from a name for use as a prefix.
 * "AppointmentBotAgent" -> "AppointmentBot"
 */
function stripAgentSuffix(name: string): string {
  return name.endsWith('Agent') ? name.slice(0, -5) : name;
}

/**
 * Convert a project name to a valid PascalCase agent name.
 * Examples:
 *   "appointment bot"        → "AppointmentBotAgent"
 *   "customer-support"       → "CustomerSupportAgent"
 *   "TriageAgent"            → "TriageAgent" (already valid, preserved as-is)
 *   "X"                      → "XAgent"
 *   ""                       → "MainAgent"
 *   "Booking @ Home (v2)"    → "BookingHomeV2Agent"
 */
function deriveAgentName(projectName: string): string {
  // Strip non-word characters but keep letters, digits, spaces, hyphens, underscores
  const stripped = projectName.trim().replace(/[^a-zA-Z0-9\s\-_]/g, '');
  if (!stripped) return 'MainAgent';

  // Tokenize on whitespace/hyphen/underscore boundaries
  const words = stripped.split(/[\s\-_]+/).filter(Boolean);
  if (words.length === 0) return 'MainAgent';

  // If the whole name is a single camelCase/PascalCase token that already
  // ends with "Agent", preserve it as-is — don't lowercase the middle.
  if (words.length === 1 && /Agent$/.test(words[0])) {
    return words[0];
  }

  // PascalCase-join each word. For each word: capitalize first char, keep
  // rest as-is IF it contains internal uppercase (existing camelCase), else
  // lowercase the rest.
  const pascal = words
    .map((w) => {
      const hasInternalUpper = /[A-Z]/.test(w.slice(1));
      const rest = hasInternalUpper ? w.slice(1) : w.slice(1).toLowerCase();
      return w.charAt(0).toUpperCase() + rest;
    })
    .join('');

  if (!pascal) return 'MainAgent';
  if (/Agent$/.test(pascal)) return pascal;
  return `${pascal}Agent`;
}

/**
 * Derive a concise role description from the specification.
 * Falls back to a generic role if description is missing.
 */
function deriveAgentRole(spec: Specification): string {
  const desc = spec.description?.trim();
  if (desc && desc.length > 0) {
    // Keep first sentence, cap at 200 chars for safety
    const firstSentence = desc.split(/[.!?]/)[0]?.trim() ?? desc;
    return firstSentence.length > 200 ? `${firstSentence.slice(0, 197)}...` : firstSentence;
  }
  return `Handle all interactions for ${spec.projectName || 'this project'}`;
}

/**
 * Synthesize a minimal-valid default topology from the specification.
 *
 * Returns a single-agent topology that:
 * - Passes TopologyOutputSchema validation
 * - Passes computeBuildOrder (no cycles possible with 0 edges)
 * - Gives the user a concrete starting point to iterate on
 *
 * This is the deterministic fallback path used by the Continue handler
 * when the architect LLM has failed to produce a topology.
 */
export function synthesizeDefaultTopology(spec: Specification): TopologyOutput {
  const agentName = deriveAgentName(spec.projectName);
  const role = deriveAgentRole(spec);

  return withInferredModelPolicies({
    agents: [
      {
        name: agentName,
        role,
        executionMode: 'reasoning',
        description: `Default agent synthesized from project specification. ${role}`,
      },
    ],
    edges: [],
    entryPoint: agentName,
  });
}
