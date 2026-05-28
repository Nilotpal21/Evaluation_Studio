export const PROPAGATION_CONTRACT_VERSIONS = {
  assistantContentEnvelope: 'assistant.contentEnvelope/v2',
  channelCapability: 'channel.capability/v1',
  toolCallEnvelope: 'tool.callEnvelope/v1',
  attachmentEnvelope: 'attachment.envelope/v1',
  localeAsset: 'locale.asset/v1',
  authProfileView: 'auth.profileView/v1',
  memoryContext: 'memory.context/v1',
} as const;

export type PropagationFixtureFamily =
  | 'assistant-output'
  | 'guardrail-output'
  | 'channel-capability'
  | 'tool-contract'
  | 'attachment-media'
  | 'locale-auth-memory';

export type PropagationFixtureManifestEntry = {
  family: PropagationFixtureFamily;
  ownerPackage: string;
  consumerPackages: readonly string[];
  compatibilityShapeVersions: readonly string[];
  fixtureExports: readonly string[];
};

export const PROPAGATION_FIXTURE_MANIFEST = [
  {
    family: 'assistant-output',
    ownerPackage: '@agent-platform/shared-kernel',
    consumerPackages: [
      '@agent-platform/runtime',
      '@agent-platform/studio',
      '@agent-platform/project-io',
      '@agent-platform/web-sdk',
    ],
    compatibilityShapeVersions: [PROPAGATION_CONTRACT_VERSIONS.assistantContentEnvelope],
    fixtureExports: ['ASSISTANT_OUTPUT_GOLDEN_FIXTURE'],
  },
  {
    family: 'guardrail-output',
    ownerPackage: '@agent-platform/shared-kernel',
    consumerPackages: ['@agent-platform/runtime', '@agent-platform/studio'],
    compatibilityShapeVersions: [PROPAGATION_CONTRACT_VERSIONS.assistantContentEnvelope],
    fixtureExports: ['GUARDRAIL_OUTPUT_GOLDEN_FIXTURE'],
  },
  {
    family: 'channel-capability',
    ownerPackage: '@agent-platform/shared-kernel',
    consumerPackages: [
      '@agent-platform/runtime',
      '@agent-platform/studio',
      '@agent-platform/web-sdk',
    ],
    compatibilityShapeVersions: [
      PROPAGATION_CONTRACT_VERSIONS.assistantContentEnvelope,
      PROPAGATION_CONTRACT_VERSIONS.channelCapability,
    ],
    fixtureExports: ['CHANNEL_CAPABILITY_GOLDEN_FIXTURE'],
  },
  {
    family: 'tool-contract',
    ownerPackage: '@agent-platform/shared-kernel',
    consumerPackages: [
      '@agent-platform/runtime',
      '@agent-platform/studio',
      '@agent-platform/project-io',
      '@abl/compiler',
    ],
    compatibilityShapeVersions: [PROPAGATION_CONTRACT_VERSIONS.toolCallEnvelope],
    fixtureExports: ['TOOL_CONTRACT_GOLDEN_FIXTURE'],
  },
  {
    family: 'attachment-media',
    ownerPackage: '@agent-platform/shared-kernel',
    consumerPackages: ['@agent-platform/runtime', '@agent-platform/studio'],
    compatibilityShapeVersions: [PROPAGATION_CONTRACT_VERSIONS.attachmentEnvelope],
    fixtureExports: ['ATTACHMENT_MEDIA_GOLDEN_FIXTURE'],
  },
  {
    family: 'locale-auth-memory',
    ownerPackage: '@agent-platform/shared-kernel',
    consumerPackages: [
      '@agent-platform/runtime',
      '@agent-platform/studio',
      '@agent-platform/project-io',
      '@agent-platform/web-sdk',
    ],
    compatibilityShapeVersions: [
      PROPAGATION_CONTRACT_VERSIONS.localeAsset,
      PROPAGATION_CONTRACT_VERSIONS.authProfileView,
      PROPAGATION_CONTRACT_VERSIONS.memoryContext,
    ],
    fixtureExports: ['LOCALE_AUTH_MEMORY_GOLDEN_FIXTURE'],
  },
] as const satisfies readonly PropagationFixtureManifestEntry[];

export const ASSISTANT_OUTPUT_GOLDEN_FIXTURE = {
  textPlusStructured: {
    response: 'Your claim {{session.claimId}} is ready for review.',
    richContent: {
      type: 'card',
      title: 'Claim review',
      body: 'Claim {{session.claimId}} is ready.',
      fields: [
        { label: 'Status', value: 'Ready' },
        { label: 'Owner', value: '{{contact.displayName}}' },
      ],
    },
    voiceConfig: {
      plainText: 'Your claim is ready for review.',
      ssml: '<speak>Your claim is ready for review.</speak>',
      bargeIn: true,
    },
    actions: [
      {
        id: 'open-claim',
        label: 'Open claim {{session.claimId}}',
        type: 'url',
        url: 'https://claims.example.test/{{session.claimId}}',
        payload: { claimId: '{{session.claimId}}' },
      },
      {
        id: 'request-callback',
        label: 'Request callback',
        type: 'postback',
        payload: { action: 'request_callback', contactId: '{{contact.id}}' },
      },
    ],
    localization: {
      locale: 'en-US',
      messageKey: 'claims.review.ready',
      variables: ['session.claimId', 'contact.displayName'],
    },
    completionMetadata: {
      completed: false,
      reason: 'awaiting_user_action',
    },
    retryMetadata: {
      attempt: 1,
      maxAttempts: 3,
    },
    contentEnvelope: {
      version: PROPAGATION_CONTRACT_VERSIONS.assistantContentEnvelope,
      text: 'Your claim CLM-123 is ready for review.',
      rawContent: [{ type: 'text', text: 'Your claim CLM-123 is ready for review.' }],
      richContent: {
        type: 'card',
        title: 'Claim review',
        body: 'Claim CLM-123 is ready.',
      },
      voiceConfig: {
        plainText: 'Your claim is ready for review.',
        ssml: '<speak>Your claim is ready for review.</speak>',
      },
      actions: [
        {
          id: 'open-claim',
          label: 'Open claim CLM-123',
          type: 'url',
          url: 'https://claims.example.test/CLM-123',
          payload: { claimId: 'CLM-123' },
        },
      ],
      localization: {
        locale: 'en-US',
        messageKey: 'claims.review.ready',
        variables: ['session.claimId', 'contact.displayName'],
      },
      metadata: {
        locale: 'en-US',
        source: 'golden-fixture',
      },
    },
  },
  structuredOnly: {
    response: '',
    richContent: {
      type: 'quick_replies',
      prompt: 'Choose the next step.',
      replies: ['Upload document', 'Talk to support'],
    },
    voiceConfig: {
      plainText: 'Choose the next step.',
      bargeIn: true,
    },
    actions: [
      {
        id: 'upload-document',
        label: 'Upload document',
        type: 'postback',
        payload: { action: 'upload_document' },
      },
    ],
    contentEnvelope: {
      version: PROPAGATION_CONTRACT_VERSIONS.assistantContentEnvelope,
      text: '',
      rawContent: [],
      richContent: {
        type: 'quick_replies',
        prompt: 'Choose the next step.',
      },
      voiceConfig: {
        plainText: 'Choose the next step.',
      },
      actions: [
        {
          id: 'upload-document',
          label: 'Upload document',
          type: 'postback',
          payload: { action: 'upload_document' },
        },
      ],
      metadata: {
        source: 'golden-fixture',
        structuredOnly: true,
      },
    },
  },
} as const;

export const GUARDRAIL_OUTPUT_GOLDEN_FIXTURE = {
  original: ASSISTANT_OUTPUT_GOLDEN_FIXTURE.textPlusStructured,
  blocked: {
    response: 'I cannot show that information here.',
    richContent: undefined,
    voiceConfig: {
      plainText: 'I cannot show that information here.',
    },
    actions: [],
    contentEnvelope: {
      version: PROPAGATION_CONTRACT_VERSIONS.assistantContentEnvelope,
      text: 'I cannot show that information here.',
      rawContent: [{ type: 'text', text: 'I cannot show that information here.' }],
      actions: [],
      metadata: {
        guardrailAction: 'block',
        source: 'golden-fixture',
      },
    },
  },
  reaskFallback: {
    response: 'Please rephrase without sensitive details.',
    actions: [
      {
        id: 'try-again',
        label: 'Try again',
        type: 'postback',
        payload: { action: 'retry_without_sensitive_details' },
      },
    ],
  },
} as const;

export const CHANNEL_CAPABILITY_GOLDEN_FIXTURE = {
  preserveStructured: {
    channel: 'web_chat',
    capabilityVersion: PROPAGATION_CONTRACT_VERSIONS.channelCapability,
    expectedBehavior: 'preserve',
    payload: ASSISTANT_OUTPUT_GOLDEN_FIXTURE.textPlusStructured,
  },
  nativeTransform: {
    channel: 'slack',
    capabilityVersion: PROPAGATION_CONTRACT_VERSIONS.channelCapability,
    expectedBehavior: 'native_transform',
    nativeSurface: 'blocks',
    payload: ASSISTANT_OUTPUT_GOLDEN_FIXTURE.textPlusStructured,
  },
  flatten: {
    channel: 'twilio_sms',
    capabilityVersion: PROPAGATION_CONTRACT_VERSIONS.channelCapability,
    expectedBehavior: 'flatten',
    flattenedText: 'Your claim CLM-123 is ready for review.',
  },
  rejectOrNoop: {
    channel: 'http_async',
    capabilityVersion: PROPAGATION_CONTRACT_VERSIONS.channelCapability,
    expectedBehavior: 'no_op_for_structured_payload',
  },
} as const;

export const TOOL_CONTRACT_GOLDEN_FIXTURE = {
  http: {
    toolType: 'http',
    endpoint: '{{config.CLAIMS_API_BASE_URL}}/claims/{{input.claimId}}',
    method: 'POST',
    variableNamespaceIds: ['claims-runtime'],
    runtimeNumeric: {
      timeout: '{{config.HTTP_TIMEOUT_MS}}',
      retry: '{{config.HTTP_RETRY_COUNT}}',
      retryDelay: '{{config.HTTP_RETRY_DELAY_MS}}',
      rateLimit: '{{config.HTTP_RATE_LIMIT_PER_MINUTE}}',
    },
    auth: {
      authProfileRef: 'claims-oauth',
      consent: 'required',
    },
  },
  sandbox: {
    toolType: 'sandbox',
    runtime: 'nodejs20',
    timeout: '{{config.SANDBOX_TIMEOUT_MS}}',
    memoryMb: '{{config.SANDBOX_MEMORY_MB}}',
  },
  mcp: {
    toolType: 'mcp',
    server: 'claims-mcp',
    serverTool: 'lookup_claim',
    headers: {
      'x-project-key': '{{config.PROJECT_KEY}}',
    },
  },
  workflow: {
    toolType: 'workflow',
    workflowId: 'wf-claims-review',
    workflowVersionId: 'wfv-2026-05',
    triggerId: 'manual_review',
    timeoutMs: '{{config.WORKFLOW_TIMEOUT_MS}}',
    paramMapping: {
      claimId: '{{input.claimId}}',
    },
  },
  searchAi: {
    toolType: 'search_ai',
    indexId: 'idx-claims-prod',
    tenantId: 'tenant-fixture',
    query: '{{input.query}}',
  },
} as const;

export const ATTACHMENT_MEDIA_GOLDEN_FIXTURE = {
  sessionAttachment: {
    version: PROPAGATION_CONTRACT_VERSIONS.attachmentEnvelope,
    attachmentId: 'att-session-001',
    sessionId: 'sess-fixture-001',
    projectId: 'proj-fixture',
    tenantId: 'tenant-fixture',
    mimeType: 'application/pdf',
    storageKey: 'redacted-storage-key',
    redactionState: 'protected',
  },
  channelMedia: {
    version: PROPAGATION_CONTRACT_VERSIONS.attachmentEnvelope,
    channel: 'whatsapp',
    mediaId: 'media-fixture-001',
    mimeType: 'image/png',
    traceRef: 'trace-media-001',
  },
  a2aAttachment: {
    version: PROPAGATION_CONTRACT_VERSIONS.attachmentEnvelope,
    artifactId: 'artifact-a2a-001',
    provenance: 'agent-transfer',
  },
} as const;

export const LOCALE_AUTH_MEMORY_GOLDEN_FIXTURE = {
  localeAsset: {
    version: PROPAGATION_CONTRACT_VERSIONS.localeAsset,
    locale: 'es-MX',
    namespace: 'claims',
    key: 'claims.review.ready',
    fallbackLocale: 'en-US',
    value: 'Tu reclamacion esta lista para revision.',
  },
  authProfileView: {
    version: PROPAGATION_CONTRACT_VERSIONS.authProfileView,
    profileId: 'auth-prof-claims',
    connectionId: 'conn-user-001',
    displayName: 'Claims OAuth',
    redactedSecrets: {
      clientSecret: '********',
    },
    consent: {
      mode: 'per_user',
      status: 'granted',
    },
  },
  memoryContext: {
    version: PROPAGATION_CONTRACT_VERSIONS.memoryContext,
    sessionSource: 'channel',
    contactId: 'contact-fixture',
    memoryId: 'mem-fixture-001',
    erasureState: 'active',
    contextWindowRef: 'ctx-window-fixture',
  },
} as const;

export const PROPAGATION_GOLDEN_FIXTURES = {
  assistantOutput: ASSISTANT_OUTPUT_GOLDEN_FIXTURE,
  guardrailOutput: GUARDRAIL_OUTPUT_GOLDEN_FIXTURE,
  channelCapability: CHANNEL_CAPABILITY_GOLDEN_FIXTURE,
  toolContract: TOOL_CONTRACT_GOLDEN_FIXTURE,
  attachmentMedia: ATTACHMENT_MEDIA_GOLDEN_FIXTURE,
  localeAuthMemory: LOCALE_AUTH_MEMORY_GOLDEN_FIXTURE,
} as const;
