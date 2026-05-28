#!/usr/bin/env tsx
/**
 * Arch AI In-Project — 100 Use Case Test Harness
 *
 * Drives the /api/arch-ai/message SSE endpoint directly to test
 * in-project operations: read agent, read topology, health check,
 * modify agent (propose + accept), add agent, verify topology.
 *
 * Usage: npx tsx tools/arch-inproject-test.ts
 */

const STUDIO_URL = 'http://localhost:5173';
const TRANSIENT_STUDIO_RETRY_MS = 2_000;
const STUDIO_READY_TIMEOUT_MS = 30_000;

// ── Types ──────────────────────────────────────────────────────────────

interface SSEEvent {
  type: string;
  data: Record<string, unknown>;
}

interface TestCase {
  id: number;
  category: string;
  description: string;
  projectId: string;
  projectName: string;
  prompt: string;
  passCriteria: (events: SSEEvent[], text: string) => boolean;
  requiresProposalAccept?: boolean;
}

interface TestResult {
  id: number;
  category: string;
  description: string;
  projectName: string;
  status: 'PASS' | 'FAIL' | 'SKIP' | 'ERROR';
  durationMs: number;
  error?: string;
  toolsCalled?: string[];
  responseExcerpt?: string;
  textLength?: number;
  eventCount?: number;
  toolCallCount?: number;
  turnEnded?: boolean;
  eventOrderIssues?: string[];
  errorCodes?: string[];
  reviewArtifactCount?: number;
  approvalAttempted?: boolean;
  approvalStatus?: 'PASS' | 'FAIL' | 'ERROR' | 'SKIP';
  approvalError?: string;
}

const EXTERNAL_BLOCKER_CODES = new Set([
  'MODEL_BILLING',
  'MODEL_AUTH',
  'MODEL_RATE_LIMITED',
  'MODEL_PROVIDER_UNAVAILABLE',
  'MODEL_TIMEOUT',
]);

interface CliArgs {
  limit: number;
  out: string;
  acceptProposals: boolean;
  reuseSessions: boolean;
  scenarioSet: 'general' | 'tools';
}

interface EventContractCheck {
  ok: boolean;
  issues: string[];
  errorCodes: string[];
  toolCallCount: number;
  turnEnded: boolean;
  reviewArtifactCount: number;
}

// ── SSE Parser ─────────────────────────────────────────────────────────

function parseSSE(raw: string): SSEEvent[] {
  const events: SSEEvent[] = [];
  const blocks = raw.split('\n\n');
  for (const block of blocks) {
    const lines = block.trim().split('\n');
    let eventType = '';
    let dataStr = '';
    for (const line of lines) {
      if (line.startsWith('event:')) eventType = line.slice(6).trim();
      else if (line.startsWith('data:')) dataStr += line.slice(5).trim();
    }
    if (eventType && dataStr) {
      try {
        events.push({ type: eventType, data: JSON.parse(dataStr) });
      } catch {
        events.push({ type: eventType, data: { raw: dataStr } });
      }
    }
  }
  return events;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    limit: 100,
    out: 'docs/testing/arch-in-project-100-usecases.md',
    acceptProposals: true,
    reuseSessions: false,
    scenarioSet: 'general',
  };

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--limit') {
      const parsed = Number(argv[++i]);
      if (Number.isFinite(parsed) && parsed > 0) {
        args.limit = Math.floor(parsed);
      }
    } else if (arg === '--out') {
      args.out = argv[++i] ?? args.out;
    } else if (arg === '--no-accept') {
      args.acceptProposals = false;
    } else if (arg === '--reuse-sessions') {
      args.reuseSessions = true;
    } else if (arg === '--tool-scenarios') {
      args.scenarioSet = 'tools';
      args.out =
        args.out === 'docs/testing/arch-in-project-100-usecases.md'
          ? 'docs/testing/arch-in-project-tool-creation-scenarios.md'
          : args.out;
    }
  }

  return args;
}

function getErrorCode(event: SSEEvent): string | null {
  if (event.type !== 'error') {
    return null;
  }

  const direct = event.data.code;
  if (typeof direct === 'string' && direct.length > 0) {
    return direct;
  }

  const nested = event.data.error;
  if (
    typeof nested === 'object' &&
    nested !== null &&
    typeof (nested as { code?: unknown }).code === 'string'
  ) {
    return (nested as { code: string }).code;
  }

  return 'UNKNOWN_ERROR';
}

function getErrorMessage(event: SSEEvent): string {
  const direct = event.data.message;
  if (typeof direct === 'string') {
    return direct;
  }

  const nested = event.data.error;
  if (
    typeof nested === 'object' &&
    nested !== null &&
    typeof (nested as { message?: unknown }).message === 'string'
  ) {
    return (nested as { message: string }).message;
  }

  return '';
}

function getEventSeq(event: SSEEvent): number | null {
  return typeof event.data.seq === 'number' ? event.data.seq : null;
}

function getEventTurnId(event: SSEEvent): string | null {
  return typeof event.data.turnId === 'string' ? event.data.turnId : null;
}

function isReviewArtifactEvent(event: SSEEvent): boolean {
  if (event.type !== 'artifact_updated') {
    return false;
  }

  const update = event.data.update;
  if (typeof update !== 'object' || update === null) {
    return false;
  }

  const artifact = (update as { artifact?: unknown }).artifact;
  return artifact === 'plan' || artifact === 'diff';
}

function eventToolNames(events: SSEEvent[]): string[] {
  const names = new Set<string>();
  for (const event of events) {
    if (
      event.type !== 'tool_call' &&
      event.type !== 'tool_result' &&
      event.type !== 'interactive_tool'
    ) {
      continue;
    }
    const name = event.data.toolName ?? event.data.tool;
    if (typeof name === 'string' && name.length > 0) {
      names.add(name);
    }
  }
  return [...names];
}

function usedAnyTool(events: SSEEvent[], expected: string[]): boolean {
  const names = eventToolNames(events);
  return expected.some((name) => names.includes(name));
}

function hasVisibleAssistantResponse(
  events: SSEEvent[],
  text: string,
  minTextLength = 30,
): boolean {
  return (
    text.trim().length > minTextLength ||
    events.some(isReviewArtifactEvent) ||
    events.some((event) => event.type === 'interactive_tool')
  );
}

function checkEventContract(events: SSEEvent[]): EventContractCheck {
  const issues: string[] = [];
  const errorCodes = events.map(getErrorCode).filter((code): code is string => code !== null);
  const toolCalls = events.filter((event) => event.type === 'tool_call');
  const toolResults = events.filter((event) => event.type === 'tool_result');
  const turnEnded = events.some(
    (event) =>
      event.type === 'turn_ended' || event.type === 'done' || event.type === 'interactive_tool',
  );
  const reviewArtifactCount = events.filter(isReviewArtifactEvent).length;

  if (events.length === 0) {
    issues.push('no SSE events parsed');
  }

  const seqByTurn = new Map<string, number>();
  for (const event of events) {
    const turnId = getEventTurnId(event);
    const seq = getEventSeq(event);
    if (!turnId || seq === null) {
      continue;
    }
    const previous = seqByTurn.get(turnId);
    if (previous !== undefined && seq <= previous) {
      issues.push(`non-monotonic seq for ${turnId}: ${seq} after ${previous}`);
    }
    seqByTurn.set(turnId, seq);
  }

  const resultIds = new Set(
    toolResults
      .map((event) => event.data.toolCallId)
      .filter((id): id is string => typeof id === 'string'),
  );
  for (const toolCall of toolCalls) {
    const id = toolCall.data.toolCallId;
    const name = String(toolCall.data.toolName ?? '');
    if (typeof id !== 'string' || id.length === 0) {
      issues.push(`tool_call missing toolCallId for ${name || 'unknown tool'}`);
      continue;
    }
    if (
      !resultIds.has(id) &&
      name !== 'ask_user' &&
      name !== 'collect_file' &&
      name !== 'collect_secret'
    ) {
      issues.push(`tool_call ${name || id} missing matching tool_result`);
    }
  }

  if (toolCalls.length > 25) {
    issues.push(`tool call limit risk: ${toolCalls.length} tool calls`);
  }

  const blockingErrorCodes = new Set([
    'SESSION_BUSY',
    'NO_PENDING_PROPOSAL',
    'TOOL_LIMIT_EXCEEDED',
    'MODEL_TOOL_PROTOCOL_ERROR',
  ]);
  for (const code of errorCodes) {
    if (blockingErrorCodes.has(code)) {
      issues.push(`blocking error event: ${code}`);
    }
  }

  for (const event of events) {
    const message = getErrorMessage(event).toLowerCase();
    if (
      message.includes('already streaming') ||
      message.includes('no pending proposal') ||
      message.includes('tool limit') ||
      message.includes('pending')
    ) {
      issues.push(`error text: ${getErrorMessage(event).slice(0, 120)}`);
    }
  }

  return {
    ok: issues.length === 0,
    issues,
    errorCodes,
    toolCallCount: toolCalls.length,
    turnEnded,
    reviewArtifactCount,
  };
}

function hasExternalBlocker(errorCodes: string[]): boolean {
  return errorCodes.some((code) => EXTERNAL_BLOCKER_CODES.has(code));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTransientStudioTransportError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes('fetch failed') ||
    message.includes('terminated') ||
    message.includes('ECONNRESET') ||
    message.includes('UND_ERR_SOCKET')
  );
}

async function waitForStudioReady(timeoutMs = STUDIO_READY_TIMEOUT_MS): Promise<void> {
  const started = Date.now();
  let lastError = '';
  while (Date.now() - started < timeoutMs) {
    try {
      const resp = await fetch(`${STUDIO_URL}/api/auth/dev-login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'test@example.com', name: 'Test User' }),
      });
      if (resp.ok) {
        return;
      }
      lastError = `status ${resp.status}`;
    } catch (error: unknown) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await sleep(TRANSIENT_STUDIO_RETRY_MS);
  }
  throw new Error(`Studio did not become ready within ${timeoutMs}ms: ${lastError}`);
}

// ── API Helpers ─────────────────────────────────────────────────────────

async function getToken(): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    const resp = await fetch(`${STUDIO_URL}/api/auth/dev-login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'test@example.com', name: 'Test User' }),
      signal: controller.signal,
    });

    const contentType = resp.headers.get('content-type') ?? '';
    const raw = await resp.text();
    if (!resp.ok) {
      throw new Error(`Dev login failed (${resp.status}): ${raw.slice(0, 300)}`);
    }
    if (!contentType.includes('application/json')) {
      throw new Error(`Dev login returned ${contentType || 'non-json'}: ${raw.slice(0, 300)}`);
    }

    const data = JSON.parse(raw) as { accessToken?: string };
    if (!data.accessToken) {
      throw new Error(`Dev login response did not include accessToken: ${raw.slice(0, 300)}`);
    }
    return data.accessToken;
  } finally {
    clearTimeout(timeout);
  }
}

async function getProjects(
  token: string,
): Promise<Array<{ id: string; name: string; agentCount: number }>> {
  const resp = await fetch(`${STUDIO_URL}/api/projects`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = (await resp.json()) as {
    projects: Array<{ id: string; name: string; agentCount: number }>;
  };
  return (data.projects || []).filter((p) => p.agentCount > 0);
}

async function getAgents(
  token: string,
  projectId: string,
): Promise<Array<{ id: string; name: string }>> {
  const resp = await fetch(`${STUDIO_URL}/api/projects/${projectId}/agents`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = (await resp.json()) as {
    success: boolean;
    agents: Array<{ _id: string; name: string }>;
  };
  return (data.agents || []).map((a) => ({ id: a._id, name: a.name }));
}

async function createSession(token: string, projectId: string): Promise<string> {
  // Archive any existing session first
  try {
    const currentResp = await fetch(
      `${STUDIO_URL}/api/arch-ai/sessions/current?mode=IN_PROJECT&projectId=${projectId}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    const currentData = (await currentResp.json()) as {
      success: boolean;
      session?: { id: string };
    };
    if (currentData.session?.id) {
      await fetch(`${STUDIO_URL}/api/arch-ai/sessions/${currentData.session.id}/archive`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      });
    }
  } catch {
    // OK if no existing session
  }

  const resp = await fetch(`${STUDIO_URL}/api/arch-ai/sessions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectId }),
  });
  const data = (await resp.json()) as { success: boolean; sessionId: string };
  if (!data.success || !data.sessionId) {
    throw new Error(`Session creation failed: ${JSON.stringify(data)}`);
  }
  return data.sessionId;
}

async function createSessionWithRetry(token: string, projectId: string): Promise<string> {
  try {
    return await createSession(token, projectId);
  } catch (error: unknown) {
    if (!isTransientStudioTransportError(error)) {
      throw error;
    }
    await waitForStudioReady();
    return createSession(token, projectId);
  }
}

async function sendMessage(
  token: string,
  sessionId: string,
  text: string,
  timeoutMs = 120_000,
): Promise<{ events: SSEEvent[]; fullText: string; toolsCalled: string[] }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const resp = await fetch(`${STUDIO_URL}/api/arch-ai/message`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ sessionId, type: 'message', text }),
      signal: controller.signal,
    });

    if (!resp.ok) {
      const errBody = await resp.text();
      throw new Error(`Message failed (${resp.status}): ${errBody.substring(0, 200)}`);
    }

    const raw = await resp.text();
    const events = parseSSE(raw);

    let fullText = '';
    const toolsCalled: string[] = [];
    for (const e of events) {
      if (e.type === 'text_delta') fullText += String(e.data.delta ?? e.data.text ?? '');
      if (e.type === 'tool_call') toolsCalled.push(String(e.data.toolName || 'unknown'));
      if (e.type === 'interactive_tool') {
        const toolName = String(e.data.toolName || e.data.tool || '');
        if (toolName && !toolsCalled.includes(toolName)) toolsCalled.push(toolName);
      }
      if (e.type === 'tool_result') {
        const tn = String(e.data.toolName || '');
        if (tn && !toolsCalled.includes(tn)) toolsCalled.push(tn);
      }
    }

    return { events, fullText, toolsCalled };
  } finally {
    clearTimeout(timeout);
  }
}

async function sendProposalAccept(
  token: string,
  sessionId: string,
): Promise<{ events: SSEEvent[]; fullText: string }> {
  const resp = await fetch(`${STUDIO_URL}/api/arch-ai/message`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ sessionId, type: 'proposal_response', action: 'accept' }),
  });

  const raw = await resp.text();
  if (!resp.ok) {
    throw new Error(`Proposal accept failed (${resp.status}): ${raw.substring(0, 200)}`);
  }

  const events = parseSSE(raw);
  let fullText = '';
  for (const e of events) {
    if (e.type === 'text_delta') fullText += String(e.data.delta ?? e.data.text ?? '');
  }
  return { events, fullText };
}

// ── Test Case Generator ────────────────────────────────────────────────

function generateTestCases(
  projects: Array<{ id: string; name: string; agents: Array<{ name: string }> }>,
): TestCase[] {
  const cases: TestCase[] = [];
  let id = 1;

  // Spread tests across projects
  const traits = [
    'professional and concise',
    'warm and empathetic',
    'formal and corporate',
    'casual and friendly',
    'patient and educational',
  ];
  const limitations = [
    'Never share internal system details with users',
    'Do not make promises about service timelines',
    'Always redirect legal questions to the legal team',
    'Never process refunds without manager approval',
    'Do not discuss competitor products',
    'Always verify identity before sharing account details',
    'Do not provide financial advice',
    'Never disclose pricing not listed on the website',
    'Always recommend professional help for complex issues',
    'Do not store or repeat sensitive personal information',
  ];
  const goalAdditions = [
    'prioritizing customer satisfaction',
    'ensuring compliance with company policies',
    'reducing average handling time',
    'providing proactive suggestions',
    'maintaining conversation context',
    'escalating complex issues promptly',
    'collecting user feedback',
    'tracking resolution metrics',
    'supporting multiple languages',
    'handling high-volume periods',
  ];
  const constraints = [
    'Must verify user identity before accessing account data',
    'Cannot process transactions over $1000 without supervisor approval',
    'Must log all escalation decisions',
    'Cannot share internal pricing formulas',
    'Must respond within 30 seconds',
    'Cannot override system-generated recommendations',
    'Must collect satisfaction rating after resolution',
    'Cannot access data from other departments without approval',
    'Must follow the defined escalation chain',
    'Cannot make external API calls during business-critical hours',
  ];
  const newAgents = [
    { name: 'FeedbackCollector', purpose: 'collecting user satisfaction surveys and NPS scores' },
    { name: 'ComplianceMonitor', purpose: 'monitoring conversations for regulatory compliance' },
    { name: 'KnowledgeHelper', purpose: 'searching and surfacing knowledge base articles' },
    {
      name: 'EscalationHandler',
      purpose: 'managing escalations to human agents with context transfer',
    },
    { name: 'AnalyticsReporter', purpose: 'generating conversation analytics summaries' },
    { name: 'OnboardingGuide', purpose: 'guiding new users through product setup' },
    { name: 'BillingAssistant', purpose: 'handling billing inquiries and payment issues' },
    { name: 'TechDiagnostic', purpose: 'running diagnostic checks on technical issues' },
    { name: 'AppointmentScheduler', purpose: 'booking and managing appointments' },
    { name: 'ReturnProcessor', purpose: 'handling product returns and exchanges' },
  ];
  const mixedPrompts = [
    'What agents does this project have and what are their roles?',
    'Are there any issues with the current agent configuration?',
    'Suggest improvements for the supervisor agent routing logic',
    'Which agent handles the most critical user interactions?',
    'Are there any missing capabilities in the current agent setup?',
    'How could we improve error handling across all agents?',
    'What guardrails should we add to improve safety?',
    'Analyze the handoff patterns between agents',
    'Which agents could benefit from adding GATHER fields?',
    'Suggest a better conversation flow for the primary agent',
  ];

  for (let pi = 0; pi < Math.min(projects.length, 5); pi++) {
    const proj = projects[pi];
    const agents = proj.agents;
    if (agents.length === 0) continue;

    // ── Category 1: Read Agent (4 per project × 5 = 20) ──
    for (let ai = 0; ai < Math.min(agents.length, 4); ai++) {
      cases.push({
        id: id++,
        category: 'Read Agent',
        description: `Read ${agents[ai].name}`,
        projectId: proj.id,
        projectName: proj.name,
        prompt: `Read the ${agents[ai].name} agent and explain its configuration briefly`,
        passCriteria: (events, text) =>
          text.length > 50 || events.some((e) => e.type === 'tool_result'),
      });
    }

    // ── Category 2: Read Topology (1 per project × 5 = 5) ──
    cases.push({
      id: id++,
      category: 'Read Topology',
      description: `Topology of ${proj.name}`,
      projectId: proj.id,
      projectName: proj.name,
      prompt: 'Show me the agent topology with all agents and their relationships',
      passCriteria: (events, text) =>
        text.length > 50 || events.some((e) => e.type === 'tool_result'),
    });

    // ── Category 3: Health Check (1 per project × 5 = 5) ──
    cases.push({
      id: id++,
      category: 'Health Check',
      description: `Health of ${proj.name}`,
      projectId: proj.id,
      projectName: proj.name,
      prompt: 'Run a full health check on all agents in this project',
      passCriteria: (events, text) =>
        text.length > 30 || events.some((e) => e.type === 'tool_result'),
    });

    // ── Category 4: Modify PERSONA (2 per project × 5 = 10) ──
    for (let mi = 0; mi < 2; mi++) {
      const agentIdx = mi % agents.length;
      cases.push({
        id: id++,
        category: 'Modify PERSONA',
        description: `${agents[agentIdx].name} persona → ${traits[pi * 2 + mi]?.split(' ')[0] || 'new'}`,
        projectId: proj.id,
        projectName: proj.name,
        prompt: `Modify the ${agents[agentIdx].name} agent to make its persona more ${traits[(pi * 2 + mi) % traits.length]}`,
        passCriteria: (events) =>
          events.some(
            (e) => e.type === 'tool_result' || e.type === 'tool_call' || e.type === 'error',
          ),
        requiresProposalAccept: true,
      });
    }

    // ── Category 5: Modify LIMITATIONS (2 per project × 5 = 10) ──
    for (let li = 0; li < 2; li++) {
      const agentIdx = (li + 1) % agents.length;
      cases.push({
        id: id++,
        category: 'Modify LIMITATIONS',
        description: `Add limitation to ${agents[agentIdx].name}`,
        projectId: proj.id,
        projectName: proj.name,
        prompt: `Add a LIMITATIONS rule to ${agents[agentIdx].name}: "${limitations[(pi * 2 + li) % limitations.length]}"`,
        passCriteria: (events) =>
          events.some((e) => e.type === 'tool_result' || e.type === 'tool_call'),
        requiresProposalAccept: true,
      });
    }

    // ── Category 6: Modify GOAL (2 per project × 5 = 10) ──
    for (let gi = 0; gi < 2; gi++) {
      const agentIdx = gi % agents.length;
      cases.push({
        id: id++,
        category: 'Modify GOAL',
        description: `Update goal of ${agents[agentIdx].name}`,
        projectId: proj.id,
        projectName: proj.name,
        prompt: `Update the GOAL of ${agents[agentIdx].name} to also include ${goalAdditions[(pi * 2 + gi) % goalAdditions.length]}`,
        passCriteria: (events) =>
          events.some((e) => e.type === 'tool_result' || e.type === 'tool_call'),
        requiresProposalAccept: true,
      });
    }

    // ── Category 7: Add Agent (2 per project × 5 = 10) ──
    for (let ni = 0; ni < 2; ni++) {
      const newAgent = newAgents[(pi * 2 + ni) % newAgents.length];
      cases.push({
        id: id++,
        category: 'Add Agent',
        description: `Add ${newAgent.name} to ${proj.name}`,
        projectId: proj.id,
        projectName: proj.name,
        prompt: `Add a new agent called ${newAgent.name} that handles ${newAgent.purpose}. Use proper ABL syntax with AGENT: as first line, GOAL:, and PERSONA: sections.`,
        passCriteria: (events) =>
          events.some((e) => e.type === 'tool_result' || e.type === 'tool_call'),
        requiresProposalAccept: true,
      });
    }

    // ── Category 8: Modify CONSTRAINTS (2 per project × 5 = 10) ──
    for (let ci = 0; ci < 2; ci++) {
      const agentIdx = ci % agents.length;
      cases.push({
        id: id++,
        category: 'Modify CONSTRAINTS',
        description: `Add constraint to ${agents[agentIdx].name}`,
        projectId: proj.id,
        projectName: proj.name,
        prompt: `Add a CONSTRAINTS section to ${agents[agentIdx].name} with this rule: "${constraints[(pi * 2 + ci) % constraints.length]}"`,
        passCriteria: (events) =>
          events.some((e) => e.type === 'tool_result' || e.type === 'tool_call'),
        requiresProposalAccept: true,
      });
    }

    // ── Category 9: Topology Verification (2 per project × 5 = 10) ──
    for (let ti = 0; ti < 2; ti++) {
      cases.push({
        id: id++,
        category: 'Topology Verify',
        description: `Verify topology #${ti + 1} of ${proj.name}`,
        projectId: proj.id,
        projectName: proj.name,
        prompt:
          ti === 0
            ? 'Show the complete agent topology with all handoff relationships'
            : 'List all agents and their types (supervisor vs agent) and which agents handle handoffs',
        passCriteria: (events, text) =>
          text.length > 50 || events.some((e) => e.type === 'tool_result'),
      });
    }

    // ── Category 10: Mixed Operations (2 per project × 5 = 10) ──
    for (let xi = 0; xi < 2; xi++) {
      const prompt = mixedPrompts[(pi * 2 + xi) % mixedPrompts.length];
      cases.push({
        id: id++,
        category: 'Mixed',
        description: prompt.substring(0, 50),
        projectId: proj.id,
        projectName: proj.name,
        prompt,
        passCriteria: hasVisibleAssistantResponse,
      });
    }
  }

  let fillerIndex = 0;
  while (cases.length < 100 && projects.length > 0) {
    const proj = projects[fillerIndex % projects.length];
    const agent = proj.agents[fillerIndex % Math.max(proj.agents.length, 1)];
    cases.push({
      id: id++,
      category: 'Mixed',
      description: `Summarize tools and responsibilities for ${proj.name}`,
      projectId: proj.id,
      projectName: proj.name,
      prompt: agent
        ? `Read the ${agent.name} agent, then summarize its responsibilities and any tool or handoff dependencies.`
        : 'List the project agents and summarize their responsibilities.',
      passCriteria: (events, text) =>
        hasVisibleAssistantResponse(events, text) ||
        events.some((event) => event.type === 'tool_result'),
    });
    fillerIndex++;
  }

  return cases;
}

function generateToolCreationTestCases(
  projects: Array<{ id: string; name: string; agents: Array<{ name: string }> }>,
): TestCase[] {
  const cases: TestCase[] = [];
  let id = 1;
  const toolNames = [
    'warranty_lookup',
    'shipment_eta_lookup',
    'customer_status_lookup',
    'appointment_slot_lookup',
    'policy_article_search',
  ];

  for (let pi = 0; pi < Math.min(projects.length, 5); pi++) {
    const proj = projects[pi];
    const agent = proj.agents[0];
    const secondAgent = proj.agents[1] ?? agent;
    if (!agent) continue;

    const impliedTool = toolNames[pi % toolNames.length];
    cases.push({
      id: id++,
      category: 'Tool Implied By Agent',
      description: `Agent creation implies ${impliedTool}`,
      projectId: proj.id,
      projectName: proj.name,
      prompt:
        `Add a new agent called ToolAware${pi + 1}Agent that handles a workflow needing the ${impliedTool} tool. ` +
        'If the ProjectTool does not already exist, do not leave the project with an unresolved TOOLS signature. ' +
        'Use a runtime-safe staged plan or create the agent without the unresolved signature and suggest the exact tool-creation follow-up.',
      passCriteria: (events, text) =>
        hasVisibleAssistantResponse(events, text) &&
        usedAnyTool(events, [
          'platform_context',
          'tools_ops',
          'propose_plan',
          'propose_modification',
        ]),
      requiresProposalAccept: false,
    });

    cases.push({
      id: id++,
      category: 'Tool Suggested From Diagnosis',
      description: `Diagnose tools for ${proj.name}`,
      projectId: proj.id,
      projectName: proj.name,
      prompt:
        'Diagnose project tool readiness. If a tool should be created, base the recommendation only on actual runtime evidence such as T-03/T-04 diagnostics, declared TOOLS, FLOW CALL references, or platform tool context. Do not invent tool gaps.',
      passCriteria: (events, text) =>
        hasVisibleAssistantResponse(events, text) &&
        usedAnyTool(events, ['diagnose_project', 'health_check', 'platform_context', 'tools_ops']),
    });

    cases.push({
      id: id++,
      category: 'Tool Suggested From Read Agent',
      description: `Read ${agent.name} tool context`,
      projectId: proj.id,
      projectName: proj.name,
      prompt:
        `Read the ${agent.name} agent and evaluate tool readiness from its TOOLS signatures and FLOW CALL references. ` +
        'Suggest ProjectTool creation only if the read_agent runtime context or platform tool list shows a missing implementation.',
      passCriteria: (events, text) =>
        hasVisibleAssistantResponse(events, text) &&
        usedAnyTool(events, ['read_agent', 'platform_context', 'tools_ops']),
    });

    cases.push({
      id: id++,
      category: 'Direct Tool Creation Assistance',
      description: `Plan HTTP tool for ${secondAgent.name}`,
      projectId: proj.id,
      projectName: proj.name,
      prompt:
        `Help me create an HTTP ProjectTool called ${impliedTool}_direct for ${secondAgent.name}. ` +
        'It should POST to {{env.CRM_BASE_URL}}/v1/customer/status with customer_id and return status plus updated_at. ' +
        'First check existing tools and runtime requirements, avoid duplicates, and present a safe creation/linking plan with the needed test step.',
      passCriteria: (events, text) =>
        hasVisibleAssistantResponse(events, text) &&
        usedAnyTool(events, ['platform_context', 'tools_ops', 'propose_plan']),
    });

    cases.push({
      id: id++,
      category: 'Tool Auth Secret Chain',
      description: `Create auth-backed tool for ${secondAgent.name}`,
      projectId: proj.id,
      projectName: proj.name,
      prompt:
        `Create a runtime-safe CRM bearer auth chain for an HTTP ProjectTool called ${impliedTool}_secure for ${secondAgent.name}. ` +
        'First inspect existing auth profiles and tools. If no suitable bearer auth profile exists, start auth_ops create and collect the token through the secure secret flow, not chat. ' +
        'Only after auth is created or explicitly pending should the tool be created/updated, tested, and then linked to the agent signature.',
      passCriteria: (events, text) =>
        (hasVisibleAssistantResponse(events, text) ||
          events.some((event) => event.type === 'interactive_tool')) &&
        usedAnyTool(events, ['platform_context', 'auth_ops', 'collect_secret', 'integration_ops']),
    });

    cases.push({
      id: id++,
      category: 'Tool OAuth Callback Chain',
      description: `Plan OAuth callback tool for ${secondAgent.name}`,
      projectId: proj.id,
      projectName: proj.name,
      prompt:
        `Help set up an OAuth-backed ProjectTool called ${impliedTool}_oauth for ${secondAgent.name}. ` +
        'The tool calls {{env.CRM_BASE_URL}}/oauth/customer/status and needs an oauth2_app profile with callback/user-consent before runtime use. ' +
        'Inspect existing auth profiles/tools, create or propose the oauth2_app setup, mark callback/token completion as pending if it has not happened, then continue with tool creation/linking only when runtime auth is resolvable.',
      passCriteria: (events, text) =>
        hasVisibleAssistantResponse(events, text) &&
        usedAnyTool(events, ['platform_context', 'auth_ops', 'tools_ops', 'integration_ops']),
    });
  }

  return cases;
}

// ── Main Runner ────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv);
  console.log(`=== Arch AI In-Project — ${args.limit} Scenario UI Contract Test Run ===\n`);

  // 1. Auth
  console.log('[1/4] Getting auth token...');
  let token = await getToken();
  let tokenExpiry = Date.now() + 14 * 60 * 1000; // 14min
  console.log('  Token acquired.\n');

  // 2. Get projects and their agents
  console.log('[2/4] Loading projects and agents...');
  const allProjects = await getProjects(token);
  const projectsWithAgents: Array<{
    id: string;
    name: string;
    agents: Array<{ name: string }>;
  }> = [];

  for (const proj of allProjects.slice(0, 5)) {
    const agents = await getAgents(token, proj.id);
    if (agents.length > 0) {
      projectsWithAgents.push({ id: proj.id, name: proj.name, agents });
      console.log(
        `  ${proj.name}: ${agents.length} agents (${agents.map((a) => a.name).join(', ')})`,
      );
    }
  }

  if (projectsWithAgents.length === 0) {
    console.error('ERROR: No projects with agents found. Cannot run tests.');
    process.exit(1);
  }
  console.log(`  Using ${projectsWithAgents.length} projects.\n`);

  // 3. Generate test cases
  console.log('[3/4] Generating test cases...');
  const allTestCases =
    args.scenarioSet === 'tools'
      ? generateToolCreationTestCases(projectsWithAgents)
      : generateTestCases(projectsWithAgents);
  const testCases = allTestCases.slice(0, args.limit);
  console.log(
    `  Generated ${allTestCases.length} ${args.scenarioSet} test cases; running ${testCases.length}.\n`,
  );

  // 4. Run tests
  console.log('[4/4] Running tests...\n');
  const results: TestResult[] = [];
  const sessionCache = new Map<string, string>(); // projectId → sessionId
  let passed = 0;
  let failed = 0;
  let errors = 0;
  let skipped = 0;
  let currentCategory = '';

  for (const tc of testCases) {
    // Print category header
    if (tc.category !== currentCategory) {
      currentCategory = tc.category;
      console.log(`\n── ${currentCategory} ──`);
    }

    const start = Date.now();
    try {
      // Refresh token if close to expiry. Keep this inside the scenario boundary so
      // transient Studio connection resets are reported instead of aborting the run.
      if (Date.now() > tokenExpiry - 60_000) {
        token = await getToken();
        tokenExpiry = Date.now() + 14 * 60 * 1000;
      }

      // Get or create session
      let sessionId = args.reuseSessions ? sessionCache.get(tc.projectId) : undefined;
      if (!sessionId) {
        sessionId = await createSessionWithRetry(token, tc.projectId);
        if (args.reuseSessions) {
          sessionCache.set(tc.projectId, sessionId);
        }
      }

      // Send message
      const { events, fullText, toolsCalled } = await sendMessage(token, sessionId, tc.prompt);
      const eventContract = checkEventContract(events);

      let approvalAttempted = false;
      let approvalStatus: TestResult['approvalStatus'] = tc.requiresProposalAccept
        ? 'SKIP'
        : undefined;
      let approvalError: string | undefined;

      // Auto-accept proposal if needed
      if (tc.requiresProposalAccept && args.acceptProposals) {
        // Check if a proposal was generated (propose_modification was called)
        const hasProposal = events.some(
          (e) =>
            e.type === 'tool_result' &&
            typeof e.data.result === 'object' &&
            e.data.result !== null &&
            'proposal' in (e.data.result as Record<string, unknown>),
        );
        const hasReviewArtifact = eventContract.reviewArtifactCount > 0;
        if (hasProposal || hasReviewArtifact) {
          approvalAttempted = true;
          try {
            const approval = await sendProposalAccept(token, sessionId);
            const approvalContract = checkEventContract(approval.events);
            if (approvalContract.ok && approvalContract.turnEnded) {
              approvalStatus = 'PASS';
            } else {
              approvalStatus = 'FAIL';
              approvalError = [
                ...approvalContract.issues,
                approvalContract.turnEnded ? undefined : 'approval response did not end turn',
              ]
                .filter((issue): issue is string => Boolean(issue))
                .join('; ');
            }
          } catch (acceptError: unknown) {
            approvalStatus = 'ERROR';
            approvalError =
              acceptError instanceof Error ? acceptError.message : String(acceptError);
          }
        }
      }

      // Evaluate
      const passCriteriaMet = tc.passCriteria(events, fullText);
      const issues = [...eventContract.issues];
      if (!eventContract.turnEnded) {
        issues.push('assistant turn did not emit turn_ended/done');
      }
      if (approvalStatus === 'FAIL' || approvalStatus === 'ERROR') {
        issues.push(`approval ${approvalStatus.toLowerCase()}: ${approvalError || 'unknown'}`);
      }
      const pass =
        passCriteriaMet && eventContract.ok && eventContract.turnEnded && issues.length === 0;
      const externallyBlocked = hasExternalBlocker(eventContract.errorCodes);
      const duration = Date.now() - start;
      const status: TestResult['status'] = externallyBlocked ? 'SKIP' : pass ? 'PASS' : 'FAIL';

      if (status === 'PASS') passed++;
      else if (status === 'SKIP') skipped++;
      else failed++;

      results.push({
        id: tc.id,
        category: tc.category,
        description: tc.description,
        projectName: tc.projectName,
        status,
        durationMs: duration,
        toolsCalled,
        textLength: fullText.length,
        eventCount: events.length,
        toolCallCount: eventContract.toolCallCount,
        turnEnded: eventContract.turnEnded,
        eventOrderIssues: issues,
        errorCodes: eventContract.errorCodes,
        reviewArtifactCount: eventContract.reviewArtifactCount,
        responseExcerpt: fullText.trim().replace(/\s+/g, ' ').slice(0, 240),
        approvalAttempted,
        approvalStatus,
        approvalError,
        error:
          status === 'PASS'
            ? undefined
            : [
                externallyBlocked ? 'external runtime blocker' : undefined,
                passCriteriaMet ? undefined : 'pass criteria not met',
                ...issues,
                eventContract.errorCodes.length > 0
                  ? `error codes: ${eventContract.errorCodes.join(', ')}`
                  : undefined,
              ]
                .filter((issue): issue is string => Boolean(issue))
                .join('; '),
      });
      console.log(
        `  [${tc.id}] ${status} (${duration}ms) ${tc.description} [events: ${events.length}, tools: ${eventContract.toolCallCount}, approval: ${approvalStatus || '-'}]`,
      );
    } catch (err: unknown) {
      const duration = Date.now() - start;
      errors++;
      const errMsg = err instanceof Error ? err.message : String(err);

      // If session is stale, clear cache
      if (errMsg.includes('Session') || errMsg.includes('ARCHIVED') || errMsg.includes('busy')) {
        sessionCache.delete(tc.projectId);
      }

      results.push({
        id: tc.id,
        category: tc.category,
        description: tc.description,
        projectName: tc.projectName,
        status: 'ERROR',
        durationMs: duration,
        error: errMsg.substring(0, 200),
        eventOrderIssues:
          errMsg.includes('busy') || errMsg.includes('already streaming')
            ? ['request was rejected as busy/already streaming']
            : undefined,
        errorCodes: errMsg.includes('SESSION_BUSY') ? ['SESSION_BUSY'] : undefined,
      });
      console.log(
        `  [${tc.id}] ERROR (${duration}ms) ${tc.description}: ${errMsg.substring(0, 100)}`,
      );
    }
  }

  // ── Summary ──────────────────────────────────────────────────────────
  console.log('\n\n=== RESULTS ===');
  console.log(`Total: ${results.length}`);
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);
  console.log(`Skipped: ${skipped}`);
  console.log(`Errors: ${errors}`);
  const scorable = passed + failed + errors;
  console.log(
    `Pass Rate: ${scorable > 0 ? ((passed / scorable) * 100).toFixed(1) : '0.0'}% (${skipped} external blockers excluded)`,
  );

  const eventOrderFailures = results.filter((r) => (r.eventOrderIssues ?? []).length > 0).length;
  const busyErrors = results.filter(
    (r) =>
      r.error?.toLowerCase().includes('busy') ||
      r.error?.toLowerCase().includes('already streaming') ||
      r.errorCodes?.includes('SESSION_BUSY'),
  ).length;
  const pendingErrors = results.filter(
    (r) =>
      r.error?.toLowerCase().includes('pending') || r.errorCodes?.includes('NO_PENDING_PROPOSAL'),
  ).length;
  const toolLimitRisks = results.filter((r) =>
    (r.eventOrderIssues ?? []).some((issue) => issue.toLowerCase().includes('tool call limit')),
  ).length;
  const approvalFailures = results.filter(
    (r) => r.approvalStatus === 'FAIL' || r.approvalStatus === 'ERROR',
  ).length;
  console.log(`Event Contract Failures: ${eventOrderFailures}`);
  console.log(`Busy/Streaming Errors: ${busyErrors}`);
  console.log(`Pending Proposal Errors: ${pendingErrors}`);
  console.log(`Tool Call Limit Risks: ${toolLimitRisks}`);
  console.log(`Approval Failures: ${approvalFailures}`);

  // Category breakdown
  const cats = new Map<string, { pass: number; fail: number; skip: number; error: number }>();
  for (const r of results) {
    const c = cats.get(r.category) || { pass: 0, fail: 0, skip: 0, error: 0 };
    if (r.status === 'PASS') c.pass++;
    else if (r.status === 'FAIL') c.fail++;
    else if (r.status === 'SKIP') c.skip++;
    else c.error++;
    cats.set(r.category, c);
  }
  console.log('\nBy Category:');
  for (const [cat, counts] of cats) {
    const scorableCategory = counts.pass + counts.fail + counts.error;
    console.log(
      `  ${cat}: ${counts.pass}/${scorableCategory} scorable passed` +
        (counts.fail > 0 ? ` (${counts.fail} failed)` : '') +
        (counts.skip > 0 ? ` (${counts.skip} external blockers)` : '') +
        (counts.error > 0 ? ` (${counts.error} errors)` : ''),
    );
  }

  // Write results markdown
  const md = generateMarkdown(results, passed, failed, skipped, errors, projectsWithAgents, args);
  const fs = await import('fs');
  const path = await import('path');
  fs.mkdirSync(path.dirname(args.out), { recursive: true });
  fs.writeFileSync(args.out, md);
  console.log(`\nResults written to ${args.out}`);
}

function generateMarkdown(
  results: TestResult[],
  passed: number,
  failed: number,
  skipped: number,
  errored: number,
  projects: Array<{ name: string }>,
  args: CliArgs,
): string {
  const total = results.length;
  const scorable = passed + failed + errored;
  const eventContractFailures = results.filter((r) => (r.eventOrderIssues ?? []).length > 0);
  const externalBlockers = results.filter((r) => r.status === 'SKIP');
  const busyErrors = results.filter(
    (r) =>
      r.error?.toLowerCase().includes('busy') ||
      r.error?.toLowerCase().includes('already streaming') ||
      r.errorCodes?.includes('SESSION_BUSY'),
  );
  const pendingErrors = results.filter(
    (r) =>
      r.error?.toLowerCase().includes('pending') || r.errorCodes?.includes('NO_PENDING_PROPOSAL'),
  );
  const approvalFailures = results.filter(
    (r) => r.approvalStatus === 'FAIL' || r.approvalStatus === 'ERROR',
  );
  const lines: string[] = [];
  const title =
    args.scenarioSet === 'tools'
      ? 'Tool Creation Scenario UI Contract Test Results'
      : 'Scenario UI Contract Test Results';
  lines.push(`# Arch AI In-Project — ${args.limit} ${title}\n`);
  lines.push(`**Date**: ${new Date().toISOString().split('T')[0]}`);
  lines.push(`**Mode**: CLI-driven Studio SSE + proposal approval contract`);
  lines.push(`**Scenario Set**: ${args.scenarioSet}`);
  lines.push(`**Projects tested**: ${projects.map((p) => p.name).join(', ')}`);
  lines.push(
    `**Total**: ${total} | **Passed**: ${passed} | **Failed**: ${failed} | **Skipped**: ${skipped} | **Errors**: ${errored}`,
  );
  lines.push(
    `**Scorable Pass Rate**: ${scorable > 0 ? ((passed / scorable) * 100).toFixed(1) : '0.0'}%`,
  );
  lines.push(`**Raw Pass Rate**: ${((passed / total) * 100).toFixed(1)}%`);
  lines.push(`**External Runtime Blockers**: ${externalBlockers.length}\n`);
  lines.push(
    `**Contract Findings**: Event/order failures ${eventContractFailures.length} | Busy/streaming ${busyErrors.length} | Pending proposal ${pendingErrors.length} | Approval failures ${approvalFailures.length}`,
  );
  lines.push('---\n');

  // Category summary
  lines.push('## Category Summary\n');
  lines.push('| Category | Pass | Fail | Skip | Error | Scorable Rate |');
  lines.push('|----------|------|------|------|-------|---------------|');
  const cats = new Map<string, { pass: number; fail: number; skip: number; error: number }>();
  for (const r of results) {
    const c = cats.get(r.category) || { pass: 0, fail: 0, skip: 0, error: 0 };
    if (r.status === 'PASS') c.pass++;
    else if (r.status === 'FAIL') c.fail++;
    else if (r.status === 'SKIP') c.skip++;
    else c.error++;
    cats.set(r.category, c);
  }
  for (const [cat, counts] of cats) {
    const t = counts.pass + counts.fail + counts.error;
    lines.push(
      `| ${cat} | ${counts.pass} | ${counts.fail} | ${counts.skip} | ${counts.error} | ${t > 0 ? ((counts.pass / t) * 100).toFixed(0) : 'n/a'} |`,
    );
  }

  lines.push('\n---\n');
  lines.push('## UI/Backend Contract Summary\n');
  lines.push('| Check | Count |');
  lines.push('|-------|-------|');
  lines.push(
    `| Event ordering / turn completion / protocol issues | ${eventContractFailures.length} |`,
  );
  lines.push(`| Busy or already-streaming errors | ${busyErrors.length} |`);
  lines.push(`| Pending proposal errors | ${pendingErrors.length} |`);
  lines.push(`| Approval failures | ${approvalFailures.length} |`);
  lines.push(`| External runtime/provider blockers | ${externalBlockers.length} |`);
  lines.push(
    `| Tool-call limit risks | ${
      results.filter((r) =>
        (r.eventOrderIssues ?? []).some((issue) => issue.toLowerCase().includes('tool call limit')),
      ).length
    } |`,
  );

  if (externalBlockers.length > 0) {
    lines.push('\n## External Runtime Blockers\n');
    lines.push(
      'These scenarios reached the Studio/Arch event stream but could not be scored because a runtime dependency or provider rejected the turn. They are excluded from the scorable pass rate.',
    );
    for (const r of externalBlockers) {
      lines.push(
        `- **[${r.id}] ${r.category}** in ${r.projectName}: ${r.errorCodes?.join(', ') || r.error || 'external blocker'}`,
      );
    }
  }

  // Full results table
  lines.push('\n---\n');
  lines.push('## Full Results\n');
  lines.push(
    '| # | Category | Description | Project | Status | Duration | Events | Tool Calls | Tools | Turn End | Artifacts | Approval | Error |',
  );
  lines.push(
    '|---|----------|-------------|---------|--------|----------|--------|------------|-------|----------|-----------|----------|-------|',
  );
  for (const r of results) {
    const err = r.error ? r.error.substring(0, 60) : '-';
    const dur = `${(r.durationMs / 1000).toFixed(1)}s`;
    const tools = r.toolsCalled?.length ? r.toolsCalled.join(', ').substring(0, 80) : '-';
    lines.push(
      `| ${r.id} | ${r.category} | ${r.description.substring(0, 40)} | ${r.projectName.substring(0, 20)} | ${r.status} | ${dur} | ${r.eventCount ?? '-'} | ${r.toolCallCount ?? '-'} | ${tools} | ${r.turnEnded === undefined ? '-' : r.turnEnded ? 'yes' : 'no'} | ${r.reviewArtifactCount ?? '-'} | ${r.approvalStatus ?? '-'} | ${err} |`,
    );
  }

  // Failures detail
  const failures = results.filter((r) => r.status !== 'PASS');
  if (failures.length > 0) {
    lines.push('\n---\n');
    lines.push('## Failures, Skips & Errors\n');
    for (const f of failures) {
      lines.push(`- **[${f.id}] ${f.category}**: ${f.description}`);
      lines.push(`  - Project: ${f.projectName}`);
      lines.push(`  - Status: ${f.status}`);
      lines.push(`  - Error: ${f.error || 'Unknown'}`);
      if (f.toolsCalled?.length) {
        lines.push(`  - Tools called: ${f.toolsCalled.join(', ')}`);
      }
      if (f.responseExcerpt) {
        lines.push(`  - Response excerpt: ${f.responseExcerpt}`);
      }
      if ((f.eventOrderIssues ?? []).length > 0) {
        lines.push(`  - Event contract: ${f.eventOrderIssues?.join('; ')}`);
      }
      if (f.errorCodes && f.errorCodes.length > 0) {
        lines.push(`  - Error codes: ${f.errorCodes.join(', ')}`);
      }
      if (f.approvalStatus && f.approvalStatus !== 'PASS') {
        lines.push(
          `  - Approval: ${f.approvalStatus}${f.approvalError ? ` — ${f.approvalError}` : ''}`,
        );
      }
      lines.push('');
    }
  }

  return lines.join('\n');
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
