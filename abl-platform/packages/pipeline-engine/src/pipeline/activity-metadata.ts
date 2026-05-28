/**
 * Static metadata registry for pipeline activity types.
 *
 * Each activity type describes:
 * - What it does (description)
 * - What config it requires (configSchema)
 * - What it outputs (outputSchema)
 * - Default timeout and retry behavior
 */

export interface ActivityTypeMetadata {
  name: string;
  description: string;
  configSchema: {
    required: string[];
    properties: Record<
      string,
      {
        type: string;
        description: string;
        label?: string;
        placeholder?: string;
        multiline?: boolean;
        group?: string;
        default?: unknown;
        values?: string[];
        validation?: Record<string, unknown>;
      }
    >;
  };
  outputSchema: {
    properties: Record<string, { type: string; description: string }>;
  };
  defaultTimeout: number;
  defaultRetries: number;
}

/**
 * Registry of all available activity types.
 * Keys match the `type` field in PipelineStep definitions.
 */
export const ACTIVITY_TYPES: Record<string, ActivityTypeMetadata> = {
  'evaluate-metrics': {
    name: 'Evaluate Metrics',
    description: 'Threshold-based metric evaluation against step outputs and pipeline input',
    configSchema: {
      required: ['metrics'],
      properties: {
        metrics: {
          type: 'array',
          description:
            'Metric rules: string names (legacy) or { name, field, operator, threshold, weight? }',
        },
      },
    },
    outputSchema: {
      properties: {
        scores: { type: 'object', description: 'Metric name → { value, passed, score } mapping' },
        overallScore: { type: 'number', description: 'Weighted average score (0.0 to 1.0)' },
      },
    },
    defaultTimeout: 120_000,
    defaultRetries: 2,
  },

  'evaluate-policy': {
    name: 'Evaluate Policy',
    description: 'Rule-based policy evaluation with violation tracking and severity levels',
    configSchema: {
      required: ['policyId'],
      properties: {
        policyId: { type: 'string', description: 'Policy identifier (label)' },
        rules: {
          type: 'array',
          description: 'Policy rules: { name, condition, operator, expected, severity? }',
        },
      },
    },
    outputSchema: {
      properties: {
        status: { type: 'string', description: 'PASS | WARN | FAIL' },
        policyId: { type: 'string', description: 'Policy identifier' },
        summary: { type: 'object', description: '{ passed, failed, warnings, total }' },
        violations: { type: 'array', description: 'Rule violations with details' },
      },
    },
    defaultTimeout: 60_000,
    defaultRetries: 1,
  },

  'store-results': {
    name: 'Store Results',
    description: 'Write step outputs to a storage destination',
    configSchema: {
      required: ['destination'],
      properties: {
        destination: { type: 'string', description: 'Target: clickhouse | mongodb | callback' },
        storageStrategy: {
          type: 'string',
          description:
            'New split persistence mode: score_and_document | score_only | document_only',
        },
        scorePath: {
          type: 'string',
          description:
            'Expression path for the single numeric analytics score written to ClickHouse',
        },
        scoreName: {
          type: 'string',
          description: 'Display/query name for the ClickHouse analytics score',
        },
        documentPath: {
          type: 'string',
          description: 'Expression path for the full document payload written to MongoDB',
        },
        table: {
          type: 'string',
          description:
            'Optional ClickHouse table or MongoDB collection. ClickHouse defaults to abl_platform.custom_pipeline_results and MongoDB defaults to custom_pipeline_results when omitted',
        },
        collection: { type: 'string', description: 'MongoDB collection name (alias for table)' },
        document: { type: 'object', description: 'Document template with expression field values' },
        callbackUrl: {
          type: 'string',
          description: 'HTTP callback URL (for callback destination)',
        },
        source: {
          type: 'string',
          description: 'Source label for ClickHouse writes: batch or realtime',
        },
        sourceStep: {
          type: 'string',
          description: 'Step ID to read data from for ClickHouse writes',
        },
      },
    },
    outputSchema: {
      properties: {
        recordsWritten: { type: 'number', description: 'Number of records stored' },
        destination: { type: 'string', description: 'Where results were written' },
      },
    },
    defaultTimeout: 30_000,
    defaultRetries: 3,
  },

  'inspect-output': {
    name: 'Inspect Output',
    description: 'Expose a previous node output for quick preview and debugging',
    configSchema: {
      required: ['sourceStep'],
      properties: {
        sourceStep: {
          type: 'string',
          description: 'Named node reference to inspect, for example read_messages',
        },
        fieldPath: {
          type: 'string',
          description: 'Optional output field path to inspect. Leave empty to show the full output',
        },
      },
    },
    outputSchema: {
      properties: {
        sourceStep: { type: 'string', description: 'The inspected node reference' },
        fieldPath: { type: 'string', description: 'Optional inspected field path' },
        output: { type: 'object', description: 'The inspected output value' },
      },
    },
    defaultTimeout: 10_000,
    defaultRetries: 0,
  },

  'send-notification': {
    name: 'Send Notification',
    description: 'Send a notification via Slack, email, webhook, or WebSocket',
    configSchema: {
      required: ['channel'],
      properties: {
        channel: {
          type: 'string',
          description: 'Notification channel: slack | email | webhook | websocket',
        },
        webhookUrl: { type: 'string', description: 'Webhook/Slack incoming webhook URL' },
        url: { type: 'string', description: 'Alternative to webhookUrl' },
        method: { type: 'string', description: 'HTTP method (default: POST)' },
        headers: { type: 'object', description: 'Additional HTTP headers' },
        body: { type: 'object', description: 'Body template with expression values' },
        to: { type: 'array', description: 'Email recipients (for email channel)' },
        template: {
          type: 'string',
          description: 'Message template with {{variable}} placeholders',
        },
      },
    },
    outputSchema: {
      properties: {
        sent: { type: 'boolean', description: 'Whether notification was sent successfully' },
        channel: { type: 'string', description: 'Channel used for notification' },
      },
    },
    defaultTimeout: 15_000,
    defaultRetries: 2,
  },

  transform: {
    name: 'Transform Data',
    description: 'Reshape and combine data from previous steps using expression-based mapping',
    configSchema: {
      required: ['mapping'],
      properties: {
        mapping: {
          type: 'object',
          description:
            'Output field → expression mapping (e.g., { "score": "steps.eval.output.scores.toxicity" })',
        },
      },
    },
    outputSchema: {
      properties: {
        // Dynamic — depends on the mapping config
      },
    },
    defaultTimeout: 10_000,
    defaultRetries: 0,
  },

  'run-legacy-workflow': {
    name: 'Run Legacy Workflow',
    description: 'Bridge: execute an existing Temporal system workflow and return its result',
    configSchema: {
      required: ['workflow'],
      properties: {
        workflow: {
          type: 'string',
          description: 'Temporal workflow name (e.g., evaluateSessionMetrics)',
        },
        taskQueue: {
          type: 'string',
          description: 'Temporal task queue (uses workflow default if omitted)',
        },
      },
    },
    outputSchema: {
      properties: {
        data: { type: 'object', description: 'Result from the Temporal workflow execution' },
      },
    },
    defaultTimeout: 300_000,
    defaultRetries: 1,
  },

  'store-insight': {
    name: 'Store Insight',
    description: 'Write InsightResult from a compute handler to ClickHouse insight_results table',
    configSchema: {
      required: [],
      properties: {
        sourceStep: {
          type: 'string',
          description: 'Step ID to read InsightResult from (auto-detected if omitted)',
        },
        retentionDays: {
          type: 'number',
          description: 'TTL in days for the stored rows (default: 90)',
        },
      },
    },
    outputSchema: {
      properties: {
        recordsWritten: { type: 'number', description: 'Number of rows written to ClickHouse' },
        insightType: { type: 'string', description: 'Handler type that produced the result' },
        granularity: { type: 'string', description: 'Granularity level of the stored result' },
      },
    },
    defaultTimeout: 30_000,
    defaultRetries: 3,
  },

  'compute-toxicity': {
    name: 'Compute Toxicity',
    description:
      'Score message toxicity for a session using keyword/pattern detection (zero AI cost)',
    configSchema: {
      required: [],
      properties: {
        params: {
          type: 'object',
          description:
            '{ threshold?: number (default 0.7), includeAgent?: boolean (default false) }',
        },
      },
    },
    outputSchema: {
      properties: {
        insightType: { type: 'string', description: 'Always "toxicity"' },
        granularity: { type: 'string', description: 'Always "session"' },
        score: { type: 'number', description: 'Session-level safety score (1.0 - avgToxicity)' },
        status: { type: 'string', description: 'pass | warn | fail' },
        dimensions: {
          type: 'object',
          description: '{ avgToxicity, maxToxicity, messageCount, threshold }',
        },
        records: { type: 'array', description: 'Per-message toxicity scores' },
      },
    },
    defaultTimeout: 60_000,
    defaultRetries: 2,
  },

  'compute-tool-effectiveness': {
    name: 'Compute Tool Effectiveness',
    description: 'Analyze tool call accuracy, retry rate, and efficiency from ClickHouse traces',
    configSchema: {
      required: [],
      properties: {
        params: {
          type: 'object',
          description:
            '{ tools?: string[] (filter to specific tools), minCalls?: number (default 1) }',
        },
      },
    },
    outputSchema: {
      properties: {
        insightType: { type: 'string', description: 'Always "tool-effectiveness"' },
        granularity: { type: 'string', description: 'Always "session"' },
        score: { type: 'number', description: 'Overall effectiveness score (0.0–1.0)' },
        status: { type: 'string', description: 'pass | warn | fail' },
        dimensions: {
          type: 'object',
          description: '{ selectionAccuracy, retryRate, avgDurationMs, totalToolCalls, toolCount }',
        },
        records: { type: 'array', description: 'Per-tool effectiveness breakdown' },
      },
    },
    defaultTimeout: 120_000,
    defaultRetries: 2,
  },

  'llm-evaluate': {
    name: 'LLM Evaluate',
    description: 'LLM-powered evaluation with structured output, tagging, and auto-storage',
    configSchema: {
      required: ['tag', 'systemPrompt', 'userPrompt'],
      properties: {
        tag: {
          type: 'string',
          label: 'Tag',
          placeholder: 'e.g., extraction_quality',
          description:
            'Evaluation identifier (e.g. "extraction_quality"). Results are stored and queryable by this tag.',
        },
        systemPrompt: {
          type: 'string',
          label: 'System Prompt',
          placeholder: 'You are an expert evaluator...',
          multiline: true,
          description: 'System instructions defining the evaluation task',
        },
        userPrompt: {
          type: 'string',
          label: 'User Prompt',
          placeholder:
            'Analyze this conversation:\n\n{{steps.read-conversation.output.transcript}}',
          multiline: true,
          description:
            'User prompt — supports {{context.conversation}} and {{steps.stepId.output.field}} template variables',
        },
        outputSchema: {
          type: 'object',
          label: 'Output Schema',
          group: 'schema',
          description:
            'Optional JSON schema defining expected LLM output structure. Injected into system prompt to guide the LLM.',
        },
        strict: {
          type: 'boolean',
          label: 'Strict Schema Validation',
          group: 'schema',
          description:
            'When enabled, retries LLM call with validation errors if output does not match schema (max 2 retries). Requires Output Schema.',
        },
        scoreField: {
          type: 'string',
          label: 'Score Field',
          placeholder: 'score',
          description: 'Output field to use as the numeric score (default: "score")',
        },
        model: {
          type: 'string',
          label: 'Model',
          group: 'advanced',
          description: 'LLM model override (default: project default)',
        },
        temperature: {
          type: 'number',
          label: 'Temperature',
          default: 0,
          group: 'advanced',
          description: 'LLM temperature (default: 0)',
        },
        maxTokens: {
          type: 'number',
          label: 'Max Tokens',
          default: 1024,
          group: 'advanced',
          description: 'Max output tokens (default: 1024)',
        },
      },
    },
    outputSchema: {
      properties: {
        tag: { type: 'string', description: 'The evaluation tag' },
        score: {
          type: 'number',
          description: 'Extracted numeric score, null if not found',
        },
        output: {
          type: 'object',
          description: 'Full parsed JSON output from LLM',
        },
        raw: { type: 'string', description: 'Raw text response' },
        inputTokens: { type: 'number', description: 'Input token count' },
        outputTokens: { type: 'number', description: 'Output token count' },
        model: { type: 'string', description: 'Model used' },
      },
    },
    defaultTimeout: 60_000,
    defaultRetries: 2,
  },

  // Note: 'call-llm' is NOT registered here — it only exists as a
  // backward-compat alias in SERVICE_HANDLERS (activity-router.service.ts)
  // so existing pipeline definitions still execute. It should NOT appear
  // as a selectable node type in the UI.

  'read-conversation': {
    name: 'Read Conversation',
    description: 'Read and decrypt a conversation transcript from ClickHouse messages + traces',
    configSchema: {
      required: [],
      properties: {
        enrichWithTraces: {
          type: 'boolean',
          description: 'Include tool calls and escalation data (default: true)',
        },
        roles: {
          type: 'array',
          description: 'Filter by message roles (default: all)',
        },
      },
    },
    outputSchema: {
      properties: {
        transcript: { type: 'string', description: 'Formatted conversation transcript' },
        messages: {
          type: 'array',
          description: 'Array of decrypted messages with metadata',
        },
        toolCalls: {
          type: 'array',
          description: 'Tool call details (if enrichWithTraces)',
        },
        escalations: {
          type: 'array',
          description: 'Escalation events (if enrichWithTraces)',
        },
        metadata: {
          type: 'object',
          description: '{ agentName, channel, messageCount, durationMs }',
        },
      },
    },
    defaultTimeout: 30_000,
    defaultRetries: 2,
  },

  'read-message-window': {
    name: 'Read Message Window',
    description: 'Fetches triggering message and recent context window for real-time processing',
    configSchema: {
      required: [],
      properties: {
        windowSize: {
          type: 'number',
          description: 'Number of prior messages to fetch for context (default: 5)',
        },
        includeToolCalls: {
          type: 'boolean',
          description: 'Enrich with recent tool call traces (default: false)',
        },
      },
    },
    outputSchema: {
      properties: {
        triggeringMessage: {
          type: 'object',
          description: 'The message that triggered the pipeline',
        },
        windowMessages: { type: 'array', description: 'Prior context messages' },
        metadata: { type: 'object', description: 'Session and window metadata' },
      },
    },
    defaultTimeout: 15_000,
    defaultRetries: 1,
  },

  'compute-quality': {
    name: 'Compute Quality',
    description: 'LLM-as-judge quality evaluation with configurable rubric dimensions',
    configSchema: {
      required: [],
      properties: {
        dimensions: {
          type: 'array',
          description: 'Evaluation dimensions with name, description, scale, weight',
        },
        domainContext: {
          type: 'string',
          description: 'Business context to improve judge accuracy',
        },
        flagThreshold: {
          type: 'number',
          description: 'Overall score below this triggers a flag (default: 2.5)',
        },
      },
    },
    outputSchema: {
      properties: {
        overallScore: { type: 'number', description: 'Weighted overall quality score' },
        dimensions: { type: 'object', description: 'Per-dimension scores' },
        flagged: { type: 'boolean', description: 'Whether the conversation was flagged' },
        flagReasons: { type: 'array', description: 'Reasons for flagging' },
        confidence: { type: 'number', description: 'Judge confidence (0.0-1.0)' },
        inputTokens: { type: 'number', description: 'Input token count' },
        outputTokens: { type: 'number', description: 'Output token count' },
      },
    },
    defaultTimeout: 120_000,
    defaultRetries: 2,
  },

  'compute-intent': {
    name: 'Compute Intent',
    description: 'LLM-based intent classification with optional customer taxonomy support',
    configSchema: {
      required: [],
      properties: {
        taxonomy: {
          type: 'array',
          description: 'Customer-defined intent categories with names, descriptions, and examples',
        },
        confidenceThreshold: {
          type: 'number',
          description: 'Min confidence to accept classification (default: 0.6)',
        },
        inputMessageStrategy: {
          type: 'string',
          description:
            "'first_user' | 'first_n_user' | 'all_user' | 'full_transcript' (default: 'first_n_user')",
        },
        inputMessageCount: {
          type: 'number',
          description: 'Number of user messages for first_n_user strategy (default: 3)',
        },
      },
    },
    outputSchema: {
      properties: {
        intent: { type: 'string', description: 'Primary classified intent label' },
        intentDisplay: { type: 'string', description: 'Human-readable intent name' },
        confidence: { type: 'number', description: 'Classification confidence (0.0-1.0)' },
        secondaryIntents: { type: 'array', description: 'Additional detected intents' },
        isAutoDiscovered: { type: 'boolean', description: 'True if intent was not in taxonomy' },
        inputTokens: { type: 'number', description: 'Input token count' },
        outputTokens: { type: 'number', description: 'Output token count' },
      },
    },
    defaultTimeout: 60_000,
    defaultRetries: 2,
  },

  'evaluate-resolution': {
    name: 'Evaluate Resolution',
    description:
      'Evaluates whether the primary intent was resolved by session end. Reads compute-intent output (with classificationRow) + full conversation transcript, makes one LLM call, and writes a unified row to intent_classifications carrying both classification and resolution data.',
    configSchema: {
      required: [],
      properties: {
        model: {
          type: 'string',
          description: 'Optional model override for resolution evaluation',
        },
      },
    },
    outputSchema: {
      properties: {
        intent: { type: 'string', description: 'Primary intent that was evaluated' },
        resolutionStatus: {
          type: 'string',
          description: '"resolved" | "partial" | "unresolved" or empty if evaluation failed',
        },
        resolutionConfidence: {
          type: 'number',
          description: 'Confidence in the resolution status (0.0-1.0)',
        },
        resolutionReason: { type: 'string', description: 'Short LLM-generated reason' },
        inputTokens: { type: 'number', description: 'Resolution LLM input tokens' },
        outputTokens: { type: 'number', description: 'Resolution LLM output tokens' },
      },
    },
    defaultTimeout: 60_000,
    defaultRetries: 2,
  },

  'compute-sentiment': {
    name: 'Compute Sentiment',
    description: 'LLM-based per-message sentiment scoring with conversation trajectory analysis',
    configSchema: {
      required: [],
      properties: {},
    },
    outputSchema: {
      properties: {
        conversationSentiment: {
          type: 'object',
          description: 'Conversation-level sentiment record',
        },
        messageSentiments: {
          type: 'array',
          description: 'Per-message sentiment records',
        },
        inputTokens: { type: 'number', description: 'Input token count' },
        outputTokens: { type: 'number', description: 'Output token count' },
      },
    },
    defaultTimeout: 120_000,
    defaultRetries: 2,
  },

  'conversation-analyzer': {
    name: 'Conversation Analyzer',
    description:
      'Config-driven LLM evaluation service supporting hallucination, knowledge gap, guardrail, and context preservation profiles',
    configSchema: {
      required: ['evaluationType'],
      properties: {
        evaluationType: {
          type: 'string',
          description:
            'Evaluation profile: hallucination, knowledge_gap, guardrail, context_preservation',
        },
        sourceStep: {
          type: 'string',
          description: 'Step to read conversation from (default: read-conversation)',
        },
        flagThreshold: {
          type: 'number',
          description: 'Score threshold for flagging (profile-specific default)',
        },
        systemPromptOverride: {
          type: 'string',
          description: 'Override the default system prompt for this evaluation',
        },
      },
    },
    outputSchema: {
      properties: {
        overall_score: { type: 'number', description: 'Normalized evaluation score (0-1)' },
        flagged: { type: 'boolean', description: 'Whether this evaluation was flagged' },
        evaluation_type: { type: 'string', description: 'Which profile was used' },
        inputTokens: { type: 'number', description: 'Input token count' },
        outputTokens: { type: 'number', description: 'Output token count' },
      },
    },
    defaultTimeout: 120_000,
    defaultRetries: 2,
  },

  'compute-statistical': {
    name: 'Compute Statistical',
    description:
      'Shared statistical analysis engine supporting friction detection, anomaly detection, and drift detection profiles',
    configSchema: {
      required: ['analysisType'],
      properties: {
        analysisType: {
          type: 'string',
          description: 'Analysis profile: friction_detection, anomaly_detection, drift_detection',
        },
        sourceStep: {
          type: 'string',
          description: 'Step to read conversation from (default: read-conversation)',
        },
        metricTable: {
          type: 'string',
          description: 'ClickHouse table for metric data (anomaly/drift profiles)',
        },
        metricColumn: {
          type: 'string',
          description: 'Column name for metric values (anomaly/drift profiles)',
        },
        dateColumn: {
          type: 'string',
          description: 'Date column name (default: day)',
        },
      },
    },
    outputSchema: {
      properties: {
        friction_score: { type: 'number', description: 'Composite friction score (0-1)' },
        anomaly_flag: { type: 'boolean', description: 'Whether anomaly was detected' },
        drift_score: { type: 'number', description: 'Magnitude of drift (0-1)' },
        severity: { type: 'string', description: 'Severity level (low/medium/high/critical)' },
      },
    },
    defaultTimeout: 120_000,
    defaultRetries: 2,
  },

  'compute-predictive-features': {
    name: 'Compute Predictive Features',
    description: 'Aggregates per-customer signals and computes weighted churn risk scores',
    configSchema: {
      required: [],
      properties: {
        lookbackDays: {
          type: 'number',
          description: 'Number of days to look back for feature aggregation (default: 30)',
        },
      },
    },
    outputSchema: {
      properties: {
        customersAnalyzed: { type: 'number', description: 'Number of customers analyzed' },
        highRisk: { type: 'number', description: 'Count of high-risk customers' },
        mediumRisk: { type: 'number', description: 'Count of medium-risk customers' },
        lowRisk: { type: 'number', description: 'Count of low-risk customers' },
      },
    },
    defaultTimeout: 120_000,
    defaultRetries: 1,
  },

  'compute-mentions': {
    name: 'Compute Mentions',
    description:
      'LLM-based extraction of competitor mentions, feature requests, bug reports, and channel-switch indicators',
    configSchema: {
      required: [],
      properties: {
        sourceStep: {
          type: 'string',
          description: 'Step to read conversation from (default: read-conversation)',
        },
      },
    },
    outputSchema: {
      properties: {
        mentions: { type: 'array', description: 'Array of extracted mentions' },
        mentionCount: { type: 'number', description: 'Total number of mentions found' },
        byType: { type: 'object', description: 'Mention counts by type' },
      },
    },
    defaultTimeout: 60_000,
    defaultRetries: 2,
  },

  'compute-goal-completion': {
    name: 'Goal Completion',
    description: 'Evaluate whether the agent achieved the customer goal',
    configSchema: {
      properties: {
        systemPrompt: { type: 'string', description: 'Custom system prompt for evaluation' },
        criteria: { type: 'array', description: 'List of criteria to evaluate' },
        model: { type: 'string', description: 'LLM model override' },
      },
      required: [],
    },
    outputSchema: {
      properties: {
        overallScore: { type: 'number', description: 'Overall goal completion score (0-1)' },
        goalDetected: { type: 'string', description: 'Detected customer goal' },
        goalAchieved: { type: 'boolean', description: 'Whether goal was achieved' },
        summary: { type: 'string', description: 'Summary of evaluation' },
      },
    },
    defaultTimeout: 30_000,
    defaultRetries: 1,
  },

  'http-request': {
    name: 'HTTP Request',
    description:
      'Make an HTTP request to an external endpoint with template substitution in URL, headers, and body',
    configSchema: {
      required: ['url'],
      properties: {
        url: {
          type: 'string',
          description: 'Request URL (supports {{variable}} templates)',
        },
        method: {
          type: 'string',
          description: 'HTTP method: GET, POST, PUT, PATCH, DELETE (default: GET)',
        },
        headers: {
          type: 'object',
          description: 'Request headers (supports {{variable}} templates)',
        },
        body: {
          type: 'string',
          description: 'Request body — string or object (supports {{variable}} templates)',
        },
        timeoutMs: {
          type: 'number',
          description: 'Request timeout in milliseconds (default: 30000)',
        },
      },
    },
    outputSchema: {
      properties: {
        statusCode: { type: 'number', description: 'HTTP response status code' },
        body: { type: 'object', description: 'Parsed JSON body or raw text' },
        headers: { type: 'object', description: 'Response headers' },
      },
    },
    defaultTimeout: 30_000,
    defaultRetries: 2,
  },

  // ── Eval Pipeline Activities ──────────────────────────────────────

  'simulate-persona': {
    name: 'Simulate Persona',
    description:
      'Generate next persona message given conversation context and persona configuration',
    configSchema: {
      required: ['persona', 'scenario'],
      properties: {
        persona: { type: 'object', description: 'PersonaConfig with style, traits, goals' },
        scenario: { type: 'object', description: 'ScenarioConfig with entry agent and milestones' },
        conversation: { type: 'array', description: 'Current conversation history' },
        personaModel: { type: 'string', description: 'LLM model for persona simulation' },
        temperature: { type: 'number', description: 'LLM temperature (default: 0.7)' },
        maxTokens: { type: 'number', description: 'Max output tokens (default: 512)' },
      },
    },
    outputSchema: {
      properties: {
        message: { type: 'string', description: 'Generated persona message or __END__' },
        isEnd: { type: 'boolean', description: 'Whether persona signaled conversation end' },
        inputTokens: { type: 'number', description: 'Input token count' },
        outputTokens: { type: 'number', description: 'Output token count' },
      },
    },
    defaultTimeout: 60_000,
    defaultRetries: 2,
  },

  'execute-agent-turn': {
    name: 'Execute Agent Turn',
    description:
      'Send a message to the agent-under-test via Runtime HTTP API and collect response + traces',
    configSchema: {
      required: ['message'],
      properties: {
        message: { type: 'string', description: 'User message to send' },
        sessionId: { type: 'string', description: 'Runtime session ID (null for first turn)' },
        entryAgent: { type: 'string', description: 'Agent name for first turn' },
        runtimeUrl: { type: 'string', description: 'Runtime API base URL' },
      },
    },
    outputSchema: {
      properties: {
        sessionId: { type: 'string', description: 'Runtime session ID for subsequent turns' },
        response: { type: 'string', description: 'Agent response text' },
        traceEvents: { type: 'array', description: 'Collected trace events' },
        toolCalls: { type: 'array', description: 'Tool call trace events' },
        sessionEnded: { type: 'boolean', description: 'Whether session naturally ended' },
      },
    },
    defaultTimeout: 60_000,
    defaultRetries: 1,
  },

  'run-eval-conversation': {
    name: 'Run Eval Conversation',
    description: 'Orchestrate a full multi-turn persona↔agent conversation with milestone tracking',
    configSchema: {
      required: ['persona', 'scenario', 'runId'],
      properties: {
        persona: { type: 'object', description: 'PersonaConfig' },
        scenario: { type: 'object', description: 'ScenarioConfig' },
        variantIndex: { type: 'number', description: 'Variant number within the cell' },
        runId: { type: 'string', description: 'EvalRun ID' },
        personaModel: { type: 'string', description: 'LLM model for persona simulation' },
        personaTemperature: { type: 'number', description: 'Persona LLM temperature' },
        personaMaxTokens: { type: 'number', description: 'Persona max output tokens' },
        runtimeUrl: { type: 'string', description: 'Runtime API base URL' },
      },
    },
    outputSchema: {
      properties: {
        conversation: { type: 'array', description: 'Full conversation turns' },
        traceEvents: { type: 'array', description: 'All trace events from agent execution' },
        milestonesHit: { type: 'array', description: 'Expected milestones that were achieved' },
        actualAgentPath: { type: 'array', description: 'Agent handoff sequence' },
        turnCount: { type: 'number', description: 'Number of conversation turns' },
        toolCallCount: { type: 'number', description: 'Total tool calls' },
        durationMs: { type: 'number', description: 'Conversation duration in milliseconds' },
      },
    },
    defaultTimeout: 600_000,
    defaultRetries: 1,
  },

  'judge-conversation': {
    name: 'Judge Conversation',
    description:
      'Score a conversation using LLM judge (with R1 bias mitigation), code scorer, trajectory scorer, or human review',
    configSchema: {
      required: ['conversation', 'evaluator'],
      properties: {
        conversation: { type: 'array', description: 'Conversation turns to evaluate' },
        traceEvents: { type: 'array', description: 'Trace events for trajectory scoring' },
        evaluator: {
          type: 'object',
          description: 'EvaluatorConfig with type, rubric, bias settings',
        },
        persona: { type: 'object', description: 'PersonaConfig' },
        scenario: { type: 'object', description: 'ScenarioConfig' },
        variantIndex: { type: 'number', description: 'Variant index' },
        runId: { type: 'string', description: 'EvalRun ID' },
      },
    },
    outputSchema: {
      properties: {
        score: { type: 'number', description: 'Evaluation score' },
        passed: { type: 'boolean', description: 'Whether the score meets passing threshold' },
        reasoning: { type: 'string', description: 'Judge reasoning' },
        evidence: { type: 'string', description: 'Supporting evidence' },
        confidence: { type: 'number', description: 'Judge confidence (0.0-1.0)' },
        needsHumanReview: { type: 'boolean', description: 'Whether human review is needed' },
      },
    },
    defaultTimeout: 120_000,
    defaultRetries: 2,
  },

  'aggregate-eval-run': {
    name: 'Aggregate Eval Run',
    description:
      'Compute run-level aggregates (mean, stdDev, 95% CI, Pass@k) and detect regressions against baseline',
    configSchema: {
      required: ['runId'],
      properties: {
        runId: { type: 'string', description: 'EvalRun ID' },
        evalSetId: { type: 'string', description: 'EvalSet ID' },
        baselineRunId: { type: 'string', description: 'Baseline run ID for regression detection' },
        regressionThreshold: {
          type: 'number',
          description: 'Max acceptable score drop (default: 0.5)',
        },
        variants: { type: 'number', description: 'Number of variants per cell (for Pass@k)' },
      },
    },
    outputSchema: {
      properties: {
        summary: { type: 'object', description: 'RunSummary with statistics' },
        regressionDetected: { type: 'boolean', description: 'Whether regression was found' },
        regressionDetails: { type: 'array', description: 'Per-cell regression details' },
      },
    },
    defaultTimeout: 60_000,
    defaultRetries: 1,
  },

  // ── Extended Node Types ────────────────────────────────────────────

  'sub-pipeline': {
    name: 'Sub-Pipeline',
    description: 'Execute another pipeline definition as a nested node with depth limiting',
    configSchema: {
      required: ['pipelineId'],
      properties: {
        pipelineId: {
          type: 'string',
          description: 'ID of the pipeline definition to execute as a sub-pipeline',
        },
        inputMapping: {
          type: 'object',
          description:
            'Map parent pipeline fields to sub-pipeline input fields (e.g., { "sessionId": "input.sessionId" })',
        },
      },
    },
    outputSchema: {
      properties: {
        result: { type: 'object', description: 'Output from the sub-pipeline execution' },
        pipelineId: { type: 'string', description: 'ID of the executed sub-pipeline' },
        status: {
          type: 'string',
          description: 'Sub-pipeline run status (completed | failed)',
        },
      },
    },
    defaultTimeout: 300_000,
    defaultRetries: 1,
  },

  'db-query': {
    name: 'Database Query',
    description:
      'Execute a query against ClickHouse (SQL) or MongoDB (JSON filter) with tenant/project isolation',
    configSchema: {
      required: ['database', 'query'],
      properties: {
        database: {
          type: 'string',
          description: "Database engine: 'clickhouse' or 'mongodb'",
        },
        query: {
          type: 'string',
          description:
            'SQL SELECT query (ClickHouse) or JSON filter object (MongoDB). Supports {{variable}} templates.',
        },
        collection: {
          type: 'string',
          description: "MongoDB collection name (required when database='mongodb')",
        },
        limit: {
          type: 'number',
          description: 'Maximum rows/documents to return (default: 1000)',
        },
      },
    },
    outputSchema: {
      properties: {
        rows: { type: 'array', description: 'Query result rows/documents' },
        rowCount: { type: 'number', description: 'Number of rows returned' },
        database: { type: 'string', description: 'Database engine used' },
      },
    },
    defaultTimeout: 30_000,
    defaultRetries: 1,
  },

  filter: {
    name: 'Filter',
    description: 'Filter an array from previous node outputs using a comparison expression',
    configSchema: {
      required: ['source', 'expression'],
      properties: {
        source: {
          type: 'string',
          description: "Dot-path to the source array (e.g., 'nodeOutputs.step1.data.items')",
        },
        expression: {
          type: 'string',
          description:
            'Filter expression per item (e.g., "item.score > 0.5", "item.status == \'active\'")',
        },
      },
    },
    outputSchema: {
      properties: {
        items: { type: 'array', description: 'Filtered items' },
        count: { type: 'number', description: 'Number of items after filtering' },
        originalCount: { type: 'number', description: 'Original array size before filtering' },
      },
    },
    defaultTimeout: 10_000,
    defaultRetries: 0,
  },

  aggregate: {
    name: 'Aggregate',
    description:
      'Aggregate values from previous node outputs using operations: count, sum, avg, min, max, collect',
    configSchema: {
      required: ['source', 'operations'],
      properties: {
        source: {
          type: 'string',
          description: "Dot-path to the source array (e.g., 'nodeOutputs.step1.data.items')",
        },
        operations: {
          type: 'array',
          description:
            'Aggregation operations: [{ field: string, op: count|sum|avg|min|max|collect, as: string }]',
        },
      },
    },
    outputSchema: {
      properties: {
        sourceCount: { type: 'number', description: 'Number of items in the source array' },
      },
    },
    defaultTimeout: 10_000,
    defaultRetries: 0,
  },

  'send-email': {
    name: 'Send Email',
    description:
      'Send an email via the platform email integration. Supports {{variable}} template substitution.',
    configSchema: {
      required: ['to', 'subject', 'body'],
      properties: {
        to: {
          type: 'string',
          description: 'Recipient email address (supports {{variable}} templates)',
        },
        subject: {
          type: 'string',
          description: 'Email subject line (supports {{variable}} templates)',
        },
        body: {
          type: 'string',
          description: 'Email body (supports {{variable}} templates)',
        },
        cc: {
          type: 'string',
          description: 'CC recipients (supports {{variable}} templates)',
        },
      },
    },
    outputSchema: {
      properties: {
        to: { type: 'string', description: 'Recipient email address' },
        subject: { type: 'string', description: 'Email subject' },
        sent: { type: 'boolean', description: 'Whether email was sent successfully' },
      },
    },
    defaultTimeout: 15_000,
    defaultRetries: 2,
  },

  'send-slack': {
    name: 'Send Slack Message',
    description:
      'Send a Slack message via webhook URL or tenant Slack integration. Supports {{variable}} template substitution.',
    configSchema: {
      required: ['channel', 'message'],
      properties: {
        channel: {
          type: 'string',
          description: 'Slack channel name (supports {{variable}} templates)',
        },
        message: {
          type: 'string',
          description: 'Message text (supports {{variable}} templates)',
        },
        webhookUrl: {
          type: 'string',
          description: 'Slack incoming webhook URL. If omitted, uses tenant Slack integration.',
        },
      },
    },
    outputSchema: {
      properties: {
        channel: { type: 'string', description: 'Slack channel used' },
        sent: { type: 'boolean', description: 'Whether message was sent' },
        via: { type: 'string', description: "'webhook' or 'integration'" },
      },
    },
    defaultTimeout: 15_000,
    defaultRetries: 2,
  },

  'publish-kafka': {
    name: 'Publish to Kafka',
    description: 'Publish an event to a Kafka topic. Requires Kafka producer infrastructure.',
    configSchema: {
      required: ['topic', 'payload'],
      properties: {
        topic: {
          type: 'string',
          description: 'Kafka topic name',
        },
        key: {
          type: 'string',
          description: 'Message key (supports {{variable}} templates)',
        },
        payload: {
          type: 'object',
          description: 'Message payload (JSON object)',
        },
      },
    },
    outputSchema: {
      properties: {
        topic: { type: 'string', description: 'Kafka topic published to' },
        key: { type: 'string', description: 'Message key used' },
        published: { type: 'boolean', description: 'Whether message was published' },
      },
    },
    defaultTimeout: 15_000,
    defaultRetries: 3,
  },

  // ── Control-Flow Types ─────────────────────────────────────────────
  // These are handled inline by ActivityRouter before SERVICE_HANDLERS dispatch.
  // They do NOT have entries in SERVICE_HANDLERS — the router handles them directly.

  'node-group': {
    name: 'Node Group',
    description:
      'Control-flow type: handled inline by ActivityRouter, not dispatched via SERVICE_HANDLERS. Fans out child nodes in parallel and collects their results.',
    configSchema: {
      required: [],
      properties: {
        children: {
          type: 'array',
          description:
            'Array of child node definitions ({ id, type, config }) to execute in parallel',
        },
      },
    },
    outputSchema: {
      properties: {
        children: {
          type: 'object',
          description: 'Map of child ID → StepOutput',
        },
      },
    },
    defaultTimeout: 300_000,
    defaultRetries: 0,
  },

  'wait-for-event': {
    name: 'Wait for Event',
    description:
      'Control-flow type: handled inline by ActivityRouter, not dispatched via SERVICE_HANDLERS. Suspends execution until an external signal resolves the awakeable.',
    configSchema: {
      required: ['eventName'],
      properties: {
        eventName: {
          type: 'string',
          description: 'Name of the external event to wait for',
        },
      },
    },
    outputSchema: {
      properties: {
        eventName: { type: 'string', description: 'Event name that was resolved' },
        awakeableId: { type: 'string', description: 'Restate awakeable ID' },
      },
    },
    defaultTimeout: 600_000,
    defaultRetries: 0,
  },

  delay: {
    name: 'Delay',
    description:
      'Control-flow type: handled inline by ActivityRouter, not dispatched via SERVICE_HANDLERS. Pauses execution for a specified duration using Restate durable sleep.',
    configSchema: {
      required: ['durationMs'],
      properties: {
        durationMs: {
          type: 'number',
          description: 'Duration to sleep in milliseconds',
        },
      },
    },
    outputSchema: {
      properties: {
        delayed: { type: 'number', description: 'Duration that was delayed (ms)' },
      },
    },
    defaultTimeout: 600_000,
    defaultRetries: 0,
  },
};

/**
 * List all available activity types with their metadata.
 */
export function listActivityTypes(): ActivityTypeMetadata[] {
  return Object.values(ACTIVITY_TYPES);
}

/**
 * Get metadata for a specific activity type.
 * Returns undefined if the type is not registered.
 */
export function getActivityMetadata(type: string): ActivityTypeMetadata | undefined {
  return ACTIVITY_TYPES[type];
}
