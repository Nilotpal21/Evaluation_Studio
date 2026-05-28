/**
 * ABL Gap Detection
 *
 * Identifies limitations in ABL that affect use case requirements
 * and suggests alternative design approaches.
 */

import type { Gap, GapReport, Alternative } from './types.js';

// =============================================================================
// KNOWN ABL GAPS REGISTRY
// =============================================================================

interface KnownGap {
  id: string;
  keywords: string[]; // Keywords to detect this gap in use case text
  requirement: string;
  ablLimitation: string;
  severity: 'minor' | 'moderate' | 'significant';
  alternatives: Alternative[];
}

const KNOWN_GAPS: KnownGap[] = [
  {
    id: 'no-http-calls',
    keywords: ['api call', 'http request', 'rest api', 'fetch', 'webhook call', 'external api'],
    requirement: 'Direct HTTP/API call syntax',
    ablLimitation: 'ABL has no native HTTP call syntax - all external calls go through TOOLS',
    severity: 'minor',
    alternatives: [
      {
        approach: 'Define TOOLS that wrap your API calls',
        tradeoffs: 'Requires a tool runtime to execute the actual HTTP calls',
        dslPattern: `TOOLS:
  call_api(method: string, url: string, body: string) -> {status: number, data: object}`,
      },
    ],
  },
  {
    id: 'no-loops',
    keywords: ['loop', 'iterate', 'repeat', 'for each', 'while', 'batch process', 'pagination'],
    requirement: 'Loop/iteration constructs',
    ablLimitation: 'ABL has no native loop or iteration syntax',
    severity: 'moderate',
    alternatives: [
      {
        approach: 'Use recursive FLOW step patterns (step calls itself)',
        tradeoffs: 'Limited depth, less readable than traditional loops',
        dslPattern: `FLOW:
  process_item -> check_more

  process_item:
    CALL: process_next_item
    THEN: check_more

  check_more:
    ON_INPUT:
      - IF: has_more_items == true
        THEN: process_item
      - ELSE:
        THEN: done`,
      },
      {
        approach: 'Use reasoning mode - LLM can decide to call tools repeatedly',
        tradeoffs: 'Less deterministic, higher LLM cost',
        dslPattern: 'MODE: reasoning',
      },
    ],
  },
  {
    id: 'no-timers',
    keywords: ['timer', 'schedule', 'cron', 'delay', 'timeout trigger', 'periodic', 'scheduled'],
    requirement: 'Timer/scheduled triggers',
    ablLimitation: 'ABL has no timer or scheduling syntax - agents are reactive to user input',
    severity: 'moderate',
    alternatives: [
      {
        approach: 'Use external cron/scheduler + ON_START pattern',
        tradeoffs: 'Requires external orchestration infrastructure',
        dslPattern: `ON_START:
  call: check_scheduled_tasks
  respond: "Processing scheduled items..."`,
      },
    ],
  },
  {
    id: 'no-database',
    keywords: ['database', 'sql', 'query', 'db access', 'data store', 'crud'],
    requirement: 'Direct database query syntax',
    ablLimitation: 'ABL has no database access syntax',
    severity: 'minor',
    alternatives: [
      {
        approach: 'Define TOOLS that wrap database operations',
        tradeoffs: 'Database logic lives outside ABL in tool implementations',
        dslPattern: `TOOLS:
  query_db(table: string, filter: string) -> {rows: object[], count: number}
  insert_record(table: string, data: object) -> {id: string, success: boolean}`,
      },
    ],
  },
  {
    id: 'no-conditional-gather',
    keywords: [
      'conditional field',
      'dynamic form',
      'show if',
      'depends on',
      'conditional question',
    ],
    requirement: 'Conditional GATHER fields (show field X only if field Y = Z)',
    ablLimitation: 'ABL GATHER fields cannot have conditional visibility',
    severity: 'moderate',
    alternatives: [
      {
        approach: 'Use scripted FLOW with branching steps',
        tradeoffs: 'More verbose, requires explicit step definitions',
        dslPattern: `FLOW:
  ask_type -> check_type

  ask_type:
    GATHER: type_selection
    THEN: check_type

  check_type:
    ON_INPUT:
      - IF: type_selection == "business"
        THEN: ask_business_fields
      - ELSE:
        THEN: ask_personal_fields`,
      },
    ],
  },
  {
    id: 'no-file-upload',
    keywords: ['file upload', 'attachment', 'document upload', 'image upload', 'file handling'],
    requirement: 'File upload/attachment handling',
    ablLimitation: 'ABL has no native file handling syntax',
    severity: 'moderate',
    alternatives: [
      {
        approach: 'Define TOOLS with a file handler',
        tradeoffs: 'File handling logic is external; ABL only receives metadata',
        dslPattern: `TOOLS:
  upload_file(file_ref: string, category: string) -> {url: string, size: number, type: string}
  process_document(url: string) -> {extracted_text: string, pages: number}`,
      },
    ],
  },
  {
    id: 'no-multi-turn-tools',
    keywords: ['multi-turn tool', 'tool chain', 'sequential tool', 'tool pipeline', 'async tool'],
    requirement: 'Multi-turn tool calls (call tool, wait for async result, call again)',
    ablLimitation: 'ABL tool calls are synchronous - no built-in async/await pattern',
    severity: 'moderate',
    alternatives: [
      {
        approach: 'Use DELEGATE pattern for multi-step tool orchestration',
        tradeoffs: 'Adds complexity with sub-agent delegation',
        dslPattern: `DELEGATE:
  - AGENT: async_processor
    WHEN: needs_async_processing == true
    PURPOSE: "Handle multi-step async tool workflow"
    INPUT: {task_id: current_task}
    RETURNS: {result: object}
    USE_RESULT: "Present final result to user"`,
      },
    ],
  },
  {
    id: 'no-streaming',
    keywords: [
      'streaming',
      'real-time',
      'live update',
      'server-sent',
      'websocket',
      'push notification',
    ],
    requirement: 'Real-time streaming responses',
    ablLimitation: 'ABL has no streaming or push notification syntax',
    severity: 'minor',
    alternatives: [
      {
        approach: 'Use TOOLS with polling pattern',
        tradeoffs: 'Not truly real-time; introduces latency',
        dslPattern: `TOOLS:
  check_status(task_id: string) -> {status: string, progress: number, result?: object}`,
      },
    ],
  },
  {
    id: 'no-arithmetic',
    keywords: ['calculate', 'arithmetic', 'math', 'compute', 'formula', 'expression'],
    requirement: 'Arithmetic/computation in conditions',
    ablLimitation: 'ABL conditions support comparisons but not arithmetic expressions',
    severity: 'minor',
    alternatives: [
      {
        approach: 'Use TOOLS for calculations',
        tradeoffs: 'Simple math requires a tool call',
        dslPattern: `TOOLS:
  calculate(expression: string) -> {result: number}`,
      },
    ],
  },
  {
    id: 'limited-entity-extraction',
    keywords: [
      'entity extraction',
      'ner',
      'named entity',
      'natural language understanding',
      'nlu',
      'intent classification',
    ],
    requirement: 'Advanced entity extraction / NLU',
    ablLimitation: 'ABL relies on LLM for extraction; no dedicated NLU pipeline',
    severity: 'minor',
    alternatives: [
      {
        approach: 'Use external NLU tool integration',
        tradeoffs: 'Adds external dependency; LLM extraction may be sufficient for most cases',
        dslPattern: `TOOLS:
  extract_entities(text: string, entity_types: string) -> {entities: object[]}`,
      },
    ],
  },
  {
    id: 'no-multi-language',
    keywords: [
      'multi-language',
      'multilingual',
      'i18n',
      'localization',
      'translate',
      'language detection',
    ],
    requirement: 'Multi-language support syntax',
    ablLimitation: 'ABL has no built-in language switching or i18n system',
    severity: 'moderate',
    alternatives: [
      {
        approach: 'Use PERSONA per language + supervisor routing',
        tradeoffs: 'Requires duplicating agent definitions per language',
        dslPattern: `# Supervisor routes based on detected language
HANDOFF:
  - TO: Agent_Spanish
    WHEN: detected_language == "es"
    CONTEXT:
      pass: [user_query]
      summary: "Spanish language user"
    RETURN: false`,
      },
    ],
  },
];

// =============================================================================
// AGENT PLATFORM v12 SPECIFIC GAPS
// =============================================================================

const AGENT_PLATFORM_GAPS: KnownGap[] = [
  {
    id: 'ap-processors',
    keywords: ['processor', 'pre-processing', 'post-processing', 'javascript hook'],
    requirement: 'JavaScript processors/pre-processing hooks',
    ablLimitation: 'ABL has no JavaScript execution or pre/post-processing hook system',
    severity: 'significant',
    alternatives: [
      {
        approach: 'Wrap processor logic in TOOLS',
        tradeoffs: 'Logic must be reimplemented as tool functions',
        dslPattern: `TOOLS:
  preprocess_input(text: string) -> {processed: string, metadata: object}`,
      },
    ],
  },
  {
    id: 'ap-voice',
    keywords: ['voice', 'vad', 'real-time llm', 'speech'],
    requirement: 'Real-time voice/VAD configuration',
    ablLimitation: 'ABL has no voice or speech processing configuration',
    severity: 'moderate',
    alternatives: [
      {
        approach: 'Note as unsupported - handle voice at platform level',
        tradeoffs: 'Voice features must be handled outside ABL',
        dslPattern: '# Voice config is handled at platform deployment level, not in ABL',
      },
    ],
  },
  {
    id: 'ap-thought-streaming',
    keywords: ['thought streaming', 'thinking', 'chain of thought display'],
    requirement: 'Thought streaming to UI',
    ablLimitation: 'ABL has no thought/reasoning stream output',
    severity: 'minor',
    alternatives: [
      {
        approach: 'Platform-level feature, not needed in agent definition',
        tradeoffs: 'Streaming behavior is a runtime concern',
        dslPattern: '# Thought streaming is a platform runtime feature',
      },
    ],
  },
  {
    id: 'ap-pii-masking',
    keywords: ['pii', 'data masking', 'data privacy', 'redaction', 'anonymization'],
    requirement: 'PII masking / data privacy configuration',
    ablLimitation: 'ABL has no built-in PII detection or masking',
    severity: 'moderate',
    alternatives: [
      {
        approach: 'Use GUARDRAILS with input checks + TOOLS for redaction',
        tradeoffs: 'Less integrated than platform-native PII handling',
        dslPattern: `GUARDRAILS:
  pii_check:
    kind: input
    check: "contains_pii(user_input)"
    action: redact
    message: "PII detected and redacted"`,
      },
    ],
  },
  {
    id: 'ap-per-agent-model',
    keywords: ['per-agent model', 'model config', 'temperature', 'model selection per agent'],
    requirement: 'Per-agent LLM model configuration (model, temperature)',
    ablLimitation: 'ABL has no per-agent model configuration syntax',
    severity: 'moderate',
    alternatives: [
      {
        approach: 'Note in documentation - model config is set at deployment level',
        tradeoffs: 'All agents use the same model unless platform supports overrides',
        dslPattern: '# Model configuration is set at deployment/runtime level',
      },
    ],
  },
  {
    id: 'ap-content-variables',
    keywords: ['content variable', 'template variable', 'dynamic content', 'variable substitution'],
    requirement: 'Content variables / template system',
    ablLimitation:
      'ABL has context references ({{context.field}}) but no global content variable system',
    severity: 'minor',
    alternatives: [
      {
        approach: 'Use MEMORY persistent paths for shared variables',
        tradeoffs: 'Not the same as compile-time content variables',
        dslPattern: `MEMORY:
  persistent:
    - config.welcome_message
    - config.company_name`,
      },
    ],
  },
  {
    id: 'ap-model-retry',
    keywords: ['model retry', 'fallback model', 'retry with fallback', 'model failover'],
    requirement: 'Model retry with fallback configuration',
    ablLimitation: 'ABL ON_ERROR supports retry count but not model fallback',
    severity: 'minor',
    alternatives: [
      {
        approach: 'Use ON_ERROR with retry + escalation',
        tradeoffs: 'Cannot switch models; can only retry or escalate',
        dslPattern: `ON_ERROR:
  llm_error:
    RESPOND: "Let me try again..."
    RETRY: 2
    THEN: ESCALATE`,
      },
    ],
  },
  {
    id: 'ap-channel-branching',
    keywords: ['channel', 'whatsapp', 'web chat', 'channel-specific', 'platform-specific'],
    requirement: 'Channel-specific branching (whatsapp vs web)',
    ablLimitation: 'ABL has no channel-aware branching',
    severity: 'moderate',
    alternatives: [
      {
        approach: 'Use CONSTRAINTS or FLOW branching with channel context',
        tradeoffs: 'Channel must be provided as context; no native channel detection',
        dslPattern: `FLOW:
  check_channel:
    ON_INPUT:
      - IF: context.channel == "whatsapp"
        THEN: whatsapp_flow
      - ELSE:
        THEN: web_flow`,
      },
    ],
  },
];

// =============================================================================
// XO11 SPECIFIC GAPS
// =============================================================================

const XO11_GAPS: KnownGap[] = [
  {
    id: 'xo11-script-nodes',
    keywords: ['script node', 'custom script', 'custom logic', 'javascript node'],
    requirement: 'Script nodes with custom logic',
    ablLimitation: 'ABL has no inline scripting capability',
    severity: 'significant',
    alternatives: [
      {
        approach: 'Wrap custom logic in TOOLS',
        tradeoffs: 'Script logic must be extracted and reimplemented as tool functions',
        dslPattern: `TOOLS:
  custom_logic(input: object) -> {result: object}`,
      },
    ],
  },
  {
    id: 'xo11-channel-ux',
    keywords: ['rich card', 'quick reply', 'channel-specific ux'],
    requirement: 'Channel-specific UX (quick replies, channel-specific styling)',
    ablLimitation:
      'ABL supports ACTIONS (buttons/selects) and CAROUSEL but has no quick reply or channel-specific styling syntax',
    severity: 'minor',
    alternatives: [
      {
        approach:
          'Use ACTIONS for buttons/selects, CAROUSEL for rich cards; quick replies approximated with ACTIONS buttons',
        tradeoffs:
          'Quick replies rendered as standard buttons; channel-specific styling not available',
        dslPattern: `# Resolved: CAROUSEL and ACTIONS blocks now supported in DSL
# Use ACTIONS for interactive buttons and selects:
RESPOND: "Choose an option"
  ACTIONS:
    - BUTTON: "Option A" -> option_a
    - BUTTON: "Option B" -> option_b

# Use CAROUSEL for rich multi-card layouts:
RESPOND: "Browse products"
  CAROUSEL:
    - TITLE: "Product Name"
      SUBTITLE: "Description"
      IMAGE: "https://example.com/img.jpg"
      BUTTONS:
        - BUTTON: "Buy" -> buy_product`,
      },
    ],
  },
];

// =============================================================================
// GAP DETECTION FUNCTIONS
// =============================================================================

/**
 * Detect ABL gaps from a use case description
 */
export function detectGapsFromUseCase(useCase: string): GapReport {
  const lowerUseCase = useCase.toLowerCase();
  const gaps: Gap[] = [];

  for (const known of KNOWN_GAPS) {
    if (known.keywords.some((kw) => lowerUseCase.includes(kw))) {
      gaps.push({
        requirement: known.requirement,
        ablLimitation: known.ablLimitation,
        alternatives: known.alternatives,
        severity: known.severity,
      });
    }
  }

  return {
    gaps,
    overallCoverage:
      gaps.length === 0
        ? 100
        : Math.max(
            0,
            100 -
              gaps.reduce((sum, g) => {
                const weight =
                  g.severity === 'significant' ? 15 : g.severity === 'moderate' ? 8 : 3;
                return sum + weight;
              }, 0),
          ),
  };
}

/**
 * Detect ABL gaps from an Agent Platform v12 export
 */
export function detectAgentPlatformGaps(data: unknown): GapReport {
  const gaps: Gap[] = [];
  const json = data as Record<string, unknown>;

  // Check for processors
  const agents = (json.agents || []) as Array<{ processors?: unknown[] }>;
  const hasProcessors = agents.some((a) => a.processors && (a.processors as unknown[]).length > 0);
  if (hasProcessors) {
    const gap = AGENT_PLATFORM_GAPS.find((g) => g.id === 'ap-processors')!;
    gaps.push({
      requirement: gap.requirement,
      ablLimitation: gap.ablLimitation,
      alternatives: gap.alternatives,
      severity: gap.severity,
    });
  }

  // Check for voice config
  if (agents.some((a) => (a as Record<string, unknown>).realTimeLlmModel)) {
    const gap = AGENT_PLATFORM_GAPS.find((g) => g.id === 'ap-voice')!;
    gaps.push({
      requirement: gap.requirement,
      ablLimitation: gap.ablLimitation,
      alternatives: gap.alternatives,
      severity: gap.severity,
    });
  }

  // Check for thought streaming
  const app = json.app as Record<string, unknown> | undefined;
  const appConfig = app?.appConfigurations as Record<string, unknown> | undefined;
  if (appConfig?.thoughtStreaming) {
    const gap = AGENT_PLATFORM_GAPS.find((g) => g.id === 'ap-thought-streaming')!;
    gaps.push({
      requirement: gap.requirement,
      ablLimitation: gap.ablLimitation,
      alternatives: gap.alternatives,
      severity: gap.severity,
    });
  }

  // Check for PII configs
  if (app?.piiConfigs) {
    const gap = AGENT_PLATFORM_GAPS.find((g) => g.id === 'ap-pii-masking')!;
    gaps.push({
      requirement: gap.requirement,
      ablLimitation: gap.ablLimitation,
      alternatives: gap.alternatives,
      severity: gap.severity,
    });
  }

  // Check for per-agent model configs
  if (agents.some((a) => (a as Record<string, unknown>).aiModel)) {
    const gap = AGENT_PLATFORM_GAPS.find((g) => g.id === 'ap-per-agent-model')!;
    gaps.push({
      requirement: gap.requirement,
      ablLimitation: gap.ablLimitation,
      alternatives: gap.alternatives,
      severity: gap.severity,
    });
  }

  // Check for content variables
  if (app?.contentVariables && (app.contentVariables as unknown[]).length > 0) {
    const gap = AGENT_PLATFORM_GAPS.find((g) => g.id === 'ap-content-variables')!;
    gaps.push({
      requirement: gap.requirement,
      ablLimitation: gap.ablLimitation,
      alternatives: gap.alternatives,
      severity: gap.severity,
    });
  }

  return {
    gaps,
    overallCoverage:
      gaps.length === 0
        ? 100
        : Math.max(
            0,
            100 -
              gaps.reduce((sum, g) => {
                const weight =
                  g.severity === 'significant' ? 15 : g.severity === 'moderate' ? 8 : 3;
                return sum + weight;
              }, 0),
          ),
  };
}

/**
 * Detect ABL gaps from an XO11 export
 */
export function detectXO11Gaps(data: unknown): GapReport {
  const gaps: Gap[] = [];
  const json = data as Record<string, unknown>;

  // Check for script nodes
  if (json.scriptNodes && (json.scriptNodes as unknown[]).length > 0) {
    const gap = XO11_GAPS.find((g) => g.id === 'xo11-script-nodes')!;
    gaps.push({
      requirement: gap.requirement,
      ablLimitation: gap.ablLimitation,
      alternatives: gap.alternatives,
      severity: gap.severity,
    });
  }

  // Check for dialog flows (they may reference rich UI)
  const flows = (json.dialogFlows || json.dialogTasks || []) as Array<Record<string, unknown>>;
  const hasRichNodes = flows.some((f) => {
    const nodes = (f.nodes || []) as Array<Record<string, unknown>>;
    return nodes.some((n) => n.type === 'carousel' || n.type === 'quickReply' || n.type === 'card');
  });
  if (hasRichNodes) {
    const gap = XO11_GAPS.find((g) => g.id === 'xo11-channel-ux')!;
    gaps.push({
      requirement: gap.requirement,
      ablLimitation: gap.ablLimitation,
      alternatives: gap.alternatives,
      severity: gap.severity,
    });
  }

  return {
    gaps,
    overallCoverage:
      gaps.length === 0
        ? 100
        : Math.max(
            0,
            100 -
              gaps.reduce((sum, g) => {
                const weight =
                  g.severity === 'significant' ? 15 : g.severity === 'moderate' ? 8 : 3;
                return sum + weight;
              }, 0),
          ),
  };
}

/**
 * Merge multiple gap reports
 */
export function mergeGapReports(...reports: GapReport[]): GapReport {
  const allGaps: Gap[] = [];
  const seen = new Set<string>();

  for (const report of reports) {
    for (const gap of report.gaps) {
      const key = gap.requirement;
      if (!seen.has(key)) {
        seen.add(key);
        allGaps.push(gap);
      }
    }
  }

  return {
    gaps: allGaps,
    overallCoverage:
      allGaps.length === 0
        ? 100
        : Math.max(
            0,
            100 -
              allGaps.reduce((sum, g) => {
                const weight =
                  g.severity === 'significant' ? 15 : g.severity === 'moderate' ? 8 : 3;
                return sum + weight;
              }, 0),
          ),
  };
}
