import type { BlueprintV2Output } from './v2-schema.js';
import { inferFallbackToolSignature } from '../planning/tool-signature-inference.js';

interface FixtureAgent {
  name: string;
  role: string;
  goal: string;
  description: string;
  tools?: string[];
  gathers?: string[];
}

interface FixtureInput {
  id: string;
  projectName: string;
  summary: string;
  channels: string[];
  languages?: string[];
  compliance?: string[];
  agents: FixtureAgent[];
  tools?: Array<{ name: string; type?: 'http' | 'mcp'; description: string; id?: string }>;
}

function fieldName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/^[0-9]/, 'field_$&');
}

function makeBlueprint(input: FixtureInput): BlueprintV2Output {
  const [entry, ...rest] = input.agents;
  if (!entry) {
    throw new Error(`Fixture "${input.id}" must define at least one agent`);
  }

  const topologyAgents = input.agents.map((agent, index) => ({
    name: agent.name,
    role: agent.role,
    executionMode:
      index === 0 && input.agents.length > 1 ? ('hybrid' as const) : ('reasoning' as const),
    description: agent.description,
  }));

  const edges = rest.map((agent) => ({
    from: entry.name,
    to: agent.name,
    type: 'transfer' as const,
    condition: `intent.category == "${fieldName(agent.role)}"`,
    expectReturn: true,
    experienceMode: 'shared_voice_handoff' as const,
  }));

  const perAgent: BlueprintV2Output['perAgent'] = {};
  for (const agent of input.agents) {
    const isEntry = agent.name === entry.name;
    const gatherFields = agent.gathers ?? ['request_summary'];
    const completionField = fieldName(gatherFields[0] ?? 'request_summary');
    const handoffs = isEntry
      ? rest.map((target) => ({
          to: target.name,
          when: `intent.category == "${fieldName(target.role)}"`,
          context: {
            pass: ['user_intent', 'conversation_topic'],
            summary: `Route ${target.role} work to ${target.name}.`,
          },
          return: true,
        }))
      : [];

    perAgent[agent.name] = {
      role: agent.role,
      goal: agent.goal,
      executionMode: isEntry ? 'hybrid' : 'reasoning',
      persona: {
        summary: `You are ${agent.name}, responsible for ${agent.role}. Be concise, careful, and explicit about next steps.`,
        tone: ['professional', 'clear'],
        rationale: `Dedicated ${agent.role} behavior keeps the system easier to test and route.`,
        limitations: [
          'Do not invent unavailable records or claim external actions succeeded without tool evidence.',
        ],
      },
      tools: (agent.tools ?? []).map((toolName) => ({
        ref: toolName,
        purpose: `Use ${toolName} for ${agent.role} workflows.`,
        signature: inferFallbackToolSignature(toolName),
        description: `${toolName} project tool`,
      })),
      gather: {
        fields: gatherFields.map((name) => ({
          name: fieldName(name),
          prompt: `Collect ${name.replace(/_/g, ' ')}.`,
          type: 'string',
          required: true,
          source: 'user',
        })),
      },
      memory: {
        session: ['conversation_topic', 'user_intent'],
        persistent: [],
      },
      constraints: [
        {
          label: 'truthfulness',
          kind: 'require',
          condition: 'tool_result.claimed == false IMPLIES tool_result IS SET',
          onFail: 'I need to verify that before confirming it.',
        },
      ],
      guardrails: [
        {
          name: 'safe_response',
          kind: 'output',
          llmCheck: 'Does the response contain unsafe or unsupported claims?',
          threshold: 0.8,
          action: 'warn',
        },
      ],
      complete: {
        conditions: [
          {
            when: `${completionField} != null`,
            respond: 'I have the details needed to continue.',
          },
        ],
      },
      handoffs,
    };
  }

  return {
    version: '2.0',
    metadata: {
      schemaVersion: '2.0',
      projectName: input.projectName,
      generatedAt: '2026-05-12T00:00:00.000Z',
      authoringMode: 'manual',
    },
    specification: {
      summary: input.summary,
      users: ['customer', 'operator'],
      channels: input.channels,
      languages: input.languages ?? ['English'],
      successCriteria: [
        'Routes to the right specialist',
        'Captures required fields',
        'Produces auditable completion',
      ],
      assumptions: ['External systems are represented by Project Tools.'],
    },
    topology: {
      pattern: input.agents.length > 2 ? 'hub_spoke' : 'triage',
      agents: topologyAgents,
      edges,
      entryPoint: entry.name,
    },
    perAgent,
    governance: {
      compliance: input.compliance ?? [],
      guardrails: [],
      policies: [],
    },
    integrations: {
      tools: (input.tools ?? []).map((tool) => ({
        id: tool.id,
        name: tool.name,
        type: tool.type ?? 'http',
        description: tool.description,
        bootstrapDescriptor:
          (tool.type ?? 'http') === 'http'
            ? { type: 'http', method: 'POST', url: `{{env.API_BASE_URL}}/${tool.name}` }
            : undefined,
      })),
      apiSpecs: [],
    },
    buildOrder: input.agents.map((agent) => agent.name),
  };
}

export const BLUEPRINT_BATTLE_TEST_FIXTURES: BlueprintV2Output[] = [
  makeBlueprint({
    id: 'claims',
    projectName: 'ClaimFlow Battle',
    summary:
      'Insurance claims intake with fraud scoring, evidence upload, adjuster routing, and payout updates.',
    channels: ['Web Chat', 'Voice', 'Email'],
    compliance: ['PII', 'SOC2'],
    tools: [
      { name: 'lookup_policy', description: 'Look up policy coverage' },
      { name: 'fraud_score', description: 'Score claim fraud risk' },
      { name: 'assign_adjuster', description: 'Assign an adjuster' },
    ],
    agents: [
      {
        name: 'ClaimRouter',
        role: 'claim triage',
        goal: 'Classify claim requests and route to the right claim specialist.',
        description: 'Entry router for claim conversations.',
        gathers: ['claim_type', 'policy_number'],
      },
      {
        name: 'ClaimIntake',
        role: 'claim intake',
        goal: 'Collect incident details and evidence for a new insurance claim.',
        description: 'Collects structured claim details.',
        tools: ['lookup_policy'],
        gathers: ['incident_date', 'loss_description', 'policy_number'],
      },
      {
        name: 'FraudReview',
        role: 'fraud review',
        goal: 'Evaluate claim fraud risk and route suspicious claims for review.',
        description: 'Runs fraud scoring and explains review outcomes.',
        tools: ['fraud_score', 'assign_adjuster'],
      },
    ],
  }),
  makeBlueprint({
    id: 'telco',
    projectName: 'CarrierCare Battle',
    summary:
      'Voice-first telco billing dispute assistant with authentication, credit rules, and supervisor callbacks.',
    channels: ['Voice'],
    languages: ['English', 'Spanish'],
    compliance: ['PCI', 'PII'],
    tools: [
      { name: 'authenticate_caller', description: 'Verify caller identity' },
      { name: 'get_billing_history', description: 'Fetch recent billing cycles' },
      { name: 'apply_credit', description: 'Apply approved credit' },
    ],
    agents: [
      {
        name: 'BillingRouter',
        role: 'billing triage',
        goal: 'Authenticate callers and route billing disputes.',
        description: 'Voice entry agent for billing disputes.',
        tools: ['authenticate_caller'],
        gathers: ['last4_ssn', 'zip_code'],
      },
      {
        name: 'DisputeResolver',
        role: 'dispute resolution',
        goal: 'Resolve billing disputes using policy-backed credit rules.',
        description: 'Handles dispute classification and credit policy.',
        tools: ['get_billing_history', 'apply_credit'],
        gathers: ['dispute_type', 'billing_cycle'],
      },
    ],
  }),
  makeBlueprint({
    id: 'medical',
    projectName: 'CareTriage Battle',
    summary:
      'Multimodal urgent-care triage with symptom intake, photo hints, appointment booking, and nurse handoff.',
    channels: ['Web Chat', 'Voice'],
    languages: ['English', 'Spanish', 'Mandarin Chinese'],
    compliance: ['HIPAA'],
    tools: [
      { name: 'classify_urgency', description: 'Classify triage urgency' },
      { name: 'book_appointment', description: 'Book urgent care appointment' },
      {
        name: 'connect_nurse_line',
        type: 'mcp',
        id: 'existing-nurse-line-tool',
        description: 'Connect to nurse line',
      },
    ],
    agents: [
      {
        name: 'TriageRouter',
        role: 'symptom triage',
        goal: 'Collect symptoms and route to safe triage paths without diagnosing.',
        description: 'Entry triage agent.',
        tools: ['classify_urgency'],
        gathers: ['symptoms', 'severity', 'duration'],
      },
      {
        name: 'AppointmentCoordinator',
        role: 'appointment booking',
        goal: 'Book appointments when triage indicates care is appropriate.',
        description: 'Books and confirms appointments.',
        tools: ['book_appointment'],
        gathers: ['preferred_time', 'clinic_location'],
      },
      {
        name: 'NurseEscalation',
        role: 'nurse escalation',
        goal: 'Escalate ambiguous or urgent cases to nurse support.',
        description: 'Routes urgent clinical uncertainty.',
        tools: ['connect_nurse_line'],
      },
    ],
  }),
  makeBlueprint({
    id: 'saas',
    projectName: 'TenantLaunch Battle',
    summary:
      'B2B SaaS onboarding for tenant profile, SSO, integrations, teammate invites, and kickoff scheduling.',
    channels: ['Web Chat'],
    compliance: ['SOC2'],
    tools: [
      { name: 'create_tenant', description: 'Create tenant workspace' },
      { name: 'configure_sso', description: 'Configure SSO provider' },
      { name: 'schedule_kickoff', description: 'Schedule customer-success kickoff' },
    ],
    agents: [
      {
        name: 'OnboardingRouter',
        role: 'tenant onboarding triage',
        goal: 'Guide a new tenant through setup and route specialized tasks.',
        description: 'Entry agent for onboarding.',
        gathers: ['company_name', 'tenant_size'],
      },
      {
        name: 'SSOSetupAgent',
        role: 'SSO setup',
        goal: 'Help configure SSO and explain identity-provider steps.',
        description: 'SSO setup specialist.',
        tools: ['configure_sso'],
        gathers: ['identity_provider'],
      },
      {
        name: 'KickoffScheduler',
        role: 'kickoff scheduling',
        goal: 'Schedule customer-success kickoff after setup milestones.',
        description: 'Schedules kickoff meetings.',
        tools: ['create_tenant', 'schedule_kickoff'],
      },
    ],
  }),
  makeBlueprint({
    id: 'travel',
    projectName: 'JourneyBuilder Battle',
    summary:
      'Full itinerary travel assistant across flights, hotels, car rental, activities, and confirmation.',
    channels: ['Web Chat', 'Email'],
    languages: ['English', 'Spanish', 'French'],
    tools: [
      { name: 'search_flights', description: 'Search flights' },
      { name: 'search_hotels', description: 'Search hotels' },
      { name: 'book_itinerary', description: 'Book selected itinerary' },
    ],
    agents: [
      {
        name: 'TravelRouter',
        role: 'travel triage',
        goal: 'Understand itinerary needs and route booking tasks.',
        description: 'Entry travel agent.',
        gathers: ['destination', 'travel_dates'],
      },
      {
        name: 'FlightHotelAgent',
        role: 'flight and hotel search',
        goal: 'Find travel options that match dates, budget, and policy.',
        description: 'Searches travel inventory.',
        tools: ['search_flights', 'search_hotels'],
      },
      {
        name: 'BookingAgent',
        role: 'itinerary booking',
        goal: 'Finalize selected itinerary and send confirmation.',
        description: 'Books itinerary selections.',
        tools: ['book_itinerary'],
      },
    ],
  }),
  makeBlueprint({
    id: 'financial',
    projectName: 'AdvisorCompliant Battle',
    summary:
      'Compliance-grade financial education assistant with KYC, AML screening, suitability, and audit logging.',
    channels: ['Web Chat'],
    compliance: ['KYC', 'AML', 'FINRA'],
    tools: [
      { name: 'verify_identity', description: 'Verify customer identity' },
      { name: 'aml_screen', description: 'Run sanctions screening' },
      { name: 'write_audit_log', description: 'Write immutable audit log' },
    ],
    agents: [
      {
        name: 'ComplianceRouter',
        role: 'compliance triage',
        goal: 'Keep financial conversations inside compliant education boundaries.',
        description: 'Entry compliance agent.',
        tools: ['write_audit_log'],
        gathers: ['intent', 'jurisdiction'],
      },
      {
        name: 'KycAgent',
        role: 'KYC and AML',
        goal: 'Collect KYC details and run AML checks.',
        description: 'Identity verification specialist.',
        tools: ['verify_identity', 'aml_screen'],
        gathers: ['legal_name', 'address', 'last4_ssn'],
      },
    ],
  }),
  makeBlueprint({
    id: 'legal',
    projectName: 'ClauseGuard Battle',
    summary:
      'Contract review pipeline for clause extraction, risk scoring, redlines, playbook comparison, and counsel escalation.',
    channels: ['Web Chat'],
    compliance: ['Legal review audit'],
    tools: [
      { name: 'parse_contract', description: 'Parse uploaded contracts' },
      { name: 'score_clause_risk', description: 'Score clause risk' },
      { name: 'export_markup', description: 'Export marked-up document' },
    ],
    agents: [
      {
        name: 'ContractRouter',
        role: 'contract review triage',
        goal: 'Route contract review tasks through extraction, risk review, and markup.',
        description: 'Entry legal review agent.',
        gathers: ['contract_type'],
      },
      {
        name: 'ClauseExtractor',
        role: 'clause extraction',
        goal: 'Extract and classify key contract clauses.',
        description: 'Clause extraction specialist.',
        tools: ['parse_contract'],
      },
      {
        name: 'RiskRedlineAgent',
        role: 'risk scoring and redlines',
        goal: 'Score risky clauses and prepare redline suggestions.',
        description: 'Risk and redline specialist.',
        tools: ['score_clause_risk', 'export_markup'],
      },
    ],
  }),
  makeBlueprint({
    id: 'edtech',
    projectName: 'TutorAdapt Battle',
    summary:
      'Adaptive K-12 math tutoring with consent gate, diagnostic test, lesson planning, hints, and mastery tracking.',
    channels: ['Web Chat'],
    languages: ['English', 'Spanish'],
    compliance: ['COPPA', 'FERPA'],
    tools: [
      { name: 'run_diagnostic', description: 'Run diagnostic quiz' },
      { name: 'update_mastery', description: 'Update mastery model' },
      { name: 'send_parent_digest', description: 'Send parent digest' },
    ],
    agents: [
      {
        name: 'TutorRouter',
        role: 'tutoring triage',
        goal: 'Guide students through safe adaptive tutoring.',
        description: 'Entry tutoring agent.',
        gathers: ['grade_level', 'topic'],
      },
      {
        name: 'DiagnosticAgent',
        role: 'diagnostic testing',
        goal: 'Run diagnostics and identify learning gaps.',
        description: 'Diagnostic specialist.',
        tools: ['run_diagnostic'],
      },
      {
        name: 'LessonAgent',
        role: 'adaptive lesson delivery',
        goal: 'Deliver problems, hints, and mastery updates.',
        description: 'Lesson specialist.',
        tools: ['update_mastery', 'send_parent_digest'],
      },
    ],
  }),
  makeBlueprint({
    id: 'field_service',
    projectName: 'DispatchOps Battle',
    summary:
      'Field-service dispatch for issue classification, technician matching, parts check, booking, and ETA SMS.',
    channels: ['Web Chat', 'SMS'],
    tools: [
      { name: 'find_technician', description: 'Find matching technician' },
      { name: 'check_parts', description: 'Check parts inventory' },
      { name: 'send_eta_sms', description: 'Send ETA SMS' },
    ],
    agents: [
      {
        name: 'DispatchRouter',
        role: 'dispatch triage',
        goal: 'Classify service issues and route dispatch tasks.',
        description: 'Entry dispatch agent.',
        gathers: ['issue_type', 'service_address'],
      },
      {
        name: 'TechnicianMatcher',
        role: 'technician matching',
        goal: 'Match technician skills, radius, availability, and parts.',
        description: 'Matches technicians to jobs.',
        tools: ['find_technician', 'check_parts'],
      },
      {
        name: 'EtaCoordinator',
        role: 'ETA communication',
        goal: 'Confirm booking windows and send ETA updates.',
        description: 'Handles ETA communication.',
        tools: ['send_eta_sms'],
      },
    ],
  }),
  makeBlueprint({
    id: 'mortgage',
    projectName: 'MortgageFlow Battle',
    summary:
      'Mortgage origination assistant for prequalification, document collection, underwriting, and closing updates.',
    channels: ['Web Chat', 'Email'],
    compliance: ['PII', 'GLBA'],
    tools: [
      { name: 'prequalify_borrower', description: 'Prequalify borrower' },
      { name: 'request_documents', description: 'Request mortgage documents' },
      { name: 'check_underwriting_status', description: 'Check underwriting status' },
    ],
    agents: [
      {
        name: 'MortgageRouter',
        role: 'mortgage triage',
        goal: 'Route borrower requests across prequalification, documents, and underwriting.',
        description: 'Entry mortgage agent.',
        gathers: ['loan_purpose', 'property_state'],
      },
      {
        name: 'PrequalificationAgent',
        role: 'borrower prequalification',
        goal: 'Collect borrower basics and run prequalification.',
        description: 'Prequalification specialist.',
        tools: ['prequalify_borrower'],
        gathers: ['income_range', 'credit_band'],
      },
      {
        name: 'DocumentAgent',
        role: 'document collection',
        goal: 'Request missing documents and track underwriting status.',
        description: 'Document collection specialist.',
        tools: ['request_documents', 'check_underwriting_status'],
      },
    ],
  }),
];
