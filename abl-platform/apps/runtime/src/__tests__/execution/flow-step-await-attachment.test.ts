/**
 * AWAIT_ATTACHMENT Flow Step Tests (Phase 3A — ST-3.3 + Phase 4 — ST-4.1)
 *
 * Tests both:
 * 1. IR shape assertions (original Phase 3A tests — preserved)
 * 2. Executor behavior tests (Phase 4 additions — unit-testing executeAwaitAttachment)
 * 3. GATHER with type: attachment field
 * 4. deriveCategoryFromMimeType utility coverage
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AgentIR, FlowStep, FlowConfig } from '@abl/compiler';
import type { AwaitAttachmentIR } from '@abl/compiler/platform/ir/schema.js';
import { PIIVault, PIIRecognizerRegistry, RegexPIIRecognizer } from '@abl/compiler/platform';
import {
  executeAwaitAttachment,
  deriveCategoryFromMimeType,
  type AwaitAttachmentResult,
} from '../../services/execution/await-attachment-executor.js';
import type {
  RuntimeSession,
  AgentThread,
  PendingAwaitAttachment,
} from '../../services/execution/types.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Build a minimal AgentIR with a flow containing AWAIT_ATTACHMENT step.
 */
function buildAgentIRWithAwaitAttachment(
  stepOverrides: Partial<FlowStep> = {},
  extraSteps: Record<string, FlowStep> = {},
): AgentIR {
  const awaitStep: FlowStep = {
    name: 'collect_document',
    respond: 'Please upload your document.',
    await_attachment: {
      variable: 'uploaded_doc_id',
      category: 'document',
      required: true,
      prompt: 'Please upload your document.',
      timeout_seconds: 300,
      on_timeout: 'timeout_step',
    },
    then: 'process_document',
    ...stepOverrides,
  };

  const flow: FlowConfig = {
    steps: ['collect_document', 'process_document', 'timeout_step', ...Object.keys(extraSteps)],
    definitions: {
      collect_document: awaitStep,
      process_document: {
        name: 'process_document',
        respond: 'Document received, processing...',
        then: undefined,
      },
      timeout_step: {
        name: 'timeout_step',
        respond: 'Upload timed out. Please try again.',
        then: undefined,
      },
      ...extraSteps,
    },
  };

  return {
    ir_version: '1.0',
    metadata: {
      name: 'TestAwaitAttachment',
      version: '1.0.0',
      type: 'agent',
      compiled_at: new Date().toISOString(),
      source_hash: 'test-hash',
      compiler_version: '1.0.0',
    },
    execution: {
      hints: { needs_llm: false, has_flow: true, has_tools: false },
      timeouts: {
        session: 3600000,
        llm: 30000,
        tool: 15000,
      },
    },
    identity: {
      name: 'TestAwaitAttachment',
      goal: 'Test AWAIT_ATTACHMENT flow step',
      persona: 'Test agent',
      limitations: [],
    },
    tools: [],
    gather: { fields: [], strategy: 'llm' },
    memory: { session: [], persistent: [], remember: [], recall: [] },
    constraints: { phases: [], guardrails: [] },
    coordination: {
      delegates: [],
      handoffs: [],
    },
    completion: { conditions: [] },
    error_handling: { handlers: [] },
    flow,
  } as unknown as AgentIR;
}

/**
 * Build a minimal RuntimeSession for executor unit tests.
 * Uses only the fields the executor actually reads.
 */
function buildMockSession(overrides: Partial<RuntimeSession> = {}): RuntimeSession {
  const thread: AgentThread = {
    agentName: 'TestAgent',
    agentIR: null,
    conversationHistory: [],
    state: { gatherProgress: {}, conversationPhase: 'start', context: {} },
    data: { values: {}, gatheredKeys: new Set() },
    startedAt: Date.now(),
    returnExpected: false,
    status: 'active',
    ...(overrides._threadOverrides as Partial<AgentThread> | undefined),
  };

  const session: RuntimeSession = {
    id: 'test-session-1',
    agentName: 'TestAgent',
    agentIR: null,
    compilationOutput: null,
    conversationHistory: [],
    state: { gatherProgress: {}, conversationPhase: 'start', context: {} },
    data: { values: {}, gatheredKeys: new Set() },
    isComplete: false,
    isEscalated: false,
    handoffStack: [],
    delegateStack: [],
    initialized: true,
    threads: [thread],
    activeThreadIndex: 0,
    threadStack: [],
    storeVersion: 0,
    createdAt: new Date(),
    lastActivityAt: new Date(),
    traceVerbosity: 'verbose',
    ...overrides,
  } as RuntimeSession;

  // Sync thread data refs to session (the executor reads both session.data and thread data)
  session.data = thread.data;

  return session;
}

const rawContractId = '780b4d1c-1166-487e-ae7a-27eedd12905b';

function createSessionWithCustomContractPII(
  overrides: Partial<RuntimeSession> = {},
): RuntimeSession {
  const registry = new PIIRecognizerRegistry();
  registry.register(
    new RegexPIIRecognizer(
      'custom-contract-id',
      ['ContractID'],
      /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g,
      'ContractID',
      undefined,
      'custom',
    ),
  );

  return buildMockSession({
    piiRedactionConfig: { enabled: true, redactInput: true, redactOutput: true },
    piiRecognizerRegistry: registry,
    piiVault: new PIIVault({ recognizerRegistry: registry }),
    piiPatternConfigs: [
      {
        patternName: 'ContractID',
        defaultRenderMode: 'redacted',
        consumerAccess: [],
      },
    ],
    ...overrides,
  });
}

/**
 * Build a standard AWAIT_ATTACHMENT step config for executor tests.
 */
function buildStep(awaitConfig: Partial<AwaitAttachmentIR> = {}): {
  await_attachment: AwaitAttachmentIR;
  name: string;
} {
  return {
    name: 'collect_document',
    await_attachment: {
      variable: 'uploaded_doc_id',
      prompt: 'Please upload your document.',
      category: 'document',
      required: true,
      timeout_seconds: 300,
      on_timeout: 'timeout_step',
      ...awaitConfig,
    },
  };
}

// ─── IR Shape Tests (Phase 3A — preserved) ───────────────────────────────────

describe('AWAIT_ATTACHMENT flow step (Phase 3A)', () => {
  describe('3-U18: Flow pauses at AWAIT_ATTACHMENT, sends prompt', () => {
    it('should have an await_attachment config on the flow step', () => {
      const ir = buildAgentIRWithAwaitAttachment();
      const step = ir.flow!.definitions['collect_document'];

      expect(step.await_attachment).toBeDefined();
      expect(step.await_attachment!.variable).toBe('uploaded_doc_id');
      expect(step.await_attachment!.category).toBe('document');
      expect(step.await_attachment!.required).toBe(true);
      expect(step.await_attachment!.prompt).toBe('Please upload your document.');
    });
  });

  describe('3-U19: User sends message with valid attachment → flow continues', () => {
    it('should define then transition for after attachment is received', () => {
      const ir = buildAgentIRWithAwaitAttachment();
      const step = ir.flow!.definitions['collect_document'];

      expect(step.then).toBe('process_document');
    });
  });

  describe('3-U20: User sends message without attachment → re-prompts', () => {
    it('should have prompt for re-requesting the attachment', () => {
      const ir = buildAgentIRWithAwaitAttachment();
      const step = ir.flow!.definitions['collect_document'];

      expect(step.await_attachment!.prompt).toBeDefined();
      expect(step.await_attachment!.required).toBe(true);
    });
  });

  describe('3-U21: User sends wrong category → error message', () => {
    it('should have category constraint on the await_attachment config', () => {
      const ir = buildAgentIRWithAwaitAttachment({
        await_attachment: {
          variable: 'photo_id',
          category: 'image',
          required: true,
          prompt: 'Please upload a photo.',
          timeout_seconds: 120,
          on_timeout: 'timeout_step',
        },
      });

      const step = ir.flow!.definitions['collect_document'];
      expect(step.await_attachment!.category).toBe('image');
    });
  });

  describe('3-U22: Timeout reached → flow transitions', () => {
    it('should have on_timeout pointing to timeout step', () => {
      const ir = buildAgentIRWithAwaitAttachment();
      const step = ir.flow!.definitions['collect_document'];

      expect(step.await_attachment!.timeout_seconds).toBe(300);
      expect(step.await_attachment!.on_timeout).toBe('timeout_step');
    });
  });

  describe('3-U23: Required vs optional', () => {
    it('should support optional attachments that allow text-only responses', () => {
      const ir = buildAgentIRWithAwaitAttachment({
        await_attachment: {
          variable: 'optional_doc_id',
          category: 'document',
          required: false,
          prompt: 'You can optionally upload a document.',
          timeout_seconds: 300,
          on_timeout: 'timeout_step',
        },
      });

      const step = ir.flow!.definitions['collect_document'];
      expect(step.await_attachment!.required).toBe(false);
    });
  });
});

// ─── Executor Behavior Tests (Phase 4 — ST-4.1) ─────────────────────────────

describe('executeAwaitAttachment — executor behavior', () => {
  let onChunk: ReturnType<typeof vi.fn>;
  let onTraceEvent: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    onChunk = vi.fn();
    onTraceEvent = vi.fn();
  });

  // ── Test 1: Prompt emission when no attachment present ──────────────────

  it('emits prompt text when no attachment is present (first visit)', () => {
    const session = buildMockSession();
    const step = buildStep({ prompt: 'Please upload your receipt.' });

    const result = executeAwaitAttachment(session, step, '', onChunk, onTraceEvent);

    expect(result.advance).toBe(false);
    expect(result.result.response).toBe('Please upload your receipt.');
    expect(result.result.action.type).toBe('await_attachment');
    expect(result.result.action.variable).toBe('uploaded_doc_id');

    // onChunk should have been called with the prompt
    expect(onChunk).toHaveBeenCalledWith('Please upload your receipt.');

    // Conversation history should contain the prompt
    expect(session.conversationHistory).toHaveLength(1);
    expect(session.conversationHistory[0]).toEqual({
      role: 'assistant',
      content: 'Please upload your receipt.',
    });

    // Session should be marked as waiting for input
    expect(session.waitingForInput).toEqual(['_await_attachment_']);
  });

  it('redacts first-visit prompt delivery while tokenizing history for custom patterns', () => {
    const session = createSessionWithCustomContractPII();
    const step = buildStep({ prompt: `Please upload contract ${rawContractId}.` });

    const result = executeAwaitAttachment(session, step, '', onChunk, onTraceEvent);

    expect(result.advance).toBe(false);
    expect(result.result.response).toContain('[REDACTED_CONTRACT_ID]');
    expect(result.result.response).not.toContain(rawContractId);
    expect(onChunk).toHaveBeenCalledWith(expect.stringContaining('[REDACTED_CONTRACT_ID]'));
    expect(onChunk).not.toHaveBeenCalledWith(expect.stringContaining(rawContractId));
    expect(String(session.conversationHistory[0]?.content)).toContain('{{PII:ContractID:');
    expect(String(session.conversationHistory[0]?.content)).not.toContain(rawContractId);
  });

  // ── Test 2: Variable storage when attachment received ───────────────────

  it('stores attachment ID in session values when attachment is received', () => {
    const session = buildMockSession({
      currentAttachmentIds: ['attach-abc-123'],
    });
    const step = buildStep({ variable: 'receipt_id' });

    const result = executeAwaitAttachment(session, step, 'here is my file', onChunk, onTraceEvent);

    expect(result.advance).toBe(true);
    expect(result.result.action.type).toBe('continue');

    // Variable should be stored in session data
    expect(session.data.values['receipt_id']).toBe('attach-abc-123');

    // Trace event should be emitted
    expect(onTraceEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'decision',
        data: expect.objectContaining({
          decisionKind: 'await_attachment',
          action: 'received',
          variable: 'receipt_id',
          attachmentId: 'attach-abc-123',
        }),
      }),
    );
  });

  // ── Test 3: Timeout handling (transition to onTimeout step) ─────────────

  it('transitions to onTimeout step when timeout is exceeded', () => {
    const session = buildMockSession();
    const thread = session.threads[0];

    // Set up pending state with expired timeout (started 600 seconds ago)
    thread.pendingAwaitAttachment = {
      type: 'await_attachment',
      variable: 'uploaded_doc_id',
      category: 'document',
      required: true,
      prompt: 'Please upload your document.',
      timeoutSeconds: 300,
      onTimeout: 'timeout_step',
      startedAt: Date.now() - 600_000, // 600s ago, timeout is 300s
    };

    const step = buildStep();
    const result = executeAwaitAttachment(session, step, 'still waiting', onChunk, onTraceEvent);

    expect(result.advance).toBe(true);
    expect(result.result.action.type).toBe('timeout');
    expect(result.result.action.nextStep).toBe('timeout_step');

    // Pending state should be cleared
    expect(thread.pendingAwaitAttachment).toBeUndefined();

    // Decision event should note timeout
    expect(onTraceEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'decision',
        data: expect.objectContaining({
          decisionKind: 'await_attachment',
          action: 'timeout',
          outcome: 'timeout',
        }),
      }),
    );
  });

  it('returns timeout error message when no onTimeout step is configured', () => {
    const session = buildMockSession();
    const thread = session.threads[0];

    thread.pendingAwaitAttachment = {
      type: 'await_attachment',
      variable: 'uploaded_doc_id',
      category: 'document',
      required: true,
      prompt: 'Upload your document.',
      timeoutSeconds: 60,
      onTimeout: undefined, // No timeout step
      startedAt: Date.now() - 120_000, // 120s ago, timeout is 60s
    };

    const step = buildStep({ on_timeout: undefined });
    const result = executeAwaitAttachment(session, step, 'hello', onChunk, onTraceEvent);

    expect(result.advance).toBe(false);
    expect(result.result.response).toBe('The attachment upload timed out. Please try again.');
    expect(result.result.action.type).toBe('timeout');
    expect(onChunk).toHaveBeenCalledWith('The attachment upload timed out. Please try again.');
  });

  it('redacts re-prompt delivery while tokenizing history for custom patterns', () => {
    const session = createSessionWithCustomContractPII();
    const thread = session.threads[0];
    thread.pendingAwaitAttachment = {
      type: 'await_attachment',
      variable: 'uploaded_doc_id',
      category: 'document',
      required: true,
      prompt: `Please upload contract ${rawContractId}.`,
      timeoutSeconds: 300,
      onTimeout: 'timeout_step',
      startedAt: Date.now(),
    };
    const step = buildStep({ prompt: `Please upload contract ${rawContractId}.` });

    const result = executeAwaitAttachment(session, step, 'still waiting', onChunk, onTraceEvent);

    expect(result.advance).toBe(false);
    expect(result.result.response).toContain('[REDACTED_CONTRACT_ID]');
    expect(result.result.response).not.toContain(rawContractId);
    expect(onChunk).toHaveBeenCalledWith(expect.stringContaining('[REDACTED_CONTRACT_ID]'));
    expect(String(session.conversationHistory[0]?.content)).toContain('{{PII:ContractID:');
    expect(String(session.conversationHistory[0]?.content)).not.toContain(rawContractId);
  });

  // ── Test 4: Optional attachment skip (required: false + text-only) ──────

  it('skips optional attachment when user sends text-only message', () => {
    const session = buildMockSession();
    const thread = session.threads[0];

    // Set up pending state for an optional attachment
    thread.pendingAwaitAttachment = {
      type: 'await_attachment',
      variable: 'optional_doc_id',
      category: 'document',
      required: false,
      prompt: 'Optionally upload a document.',
      startedAt: Date.now(),
    };

    const step = buildStep({ variable: 'optional_doc_id', required: false });
    const result = executeAwaitAttachment(
      session,
      step,
      'no file, just text',
      onChunk,
      onTraceEvent,
    );

    expect(result.advance).toBe(true);
    expect(result.result.action.type).toBe('continue');

    // Variable should be set to null (skipped)
    expect(session.data.values['optional_doc_id']).toBeNull();

    // Pending state should be cleared
    expect(thread.pendingAwaitAttachment).toBeUndefined();

    // Decision event should note skip
    expect(onTraceEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'decision',
        data: expect.objectContaining({
          decisionKind: 'await_attachment',
          action: 'skipped',
          outcome: 'optional_skipped',
        }),
      }),
    );
  });

  // ── Test 5: Re-prompt when already pending and no attachment ────────────

  it('re-prompts when already pending and no attachment in message', () => {
    const session = buildMockSession();
    const thread = session.threads[0];

    // Set up pending state for a required attachment
    thread.pendingAwaitAttachment = {
      type: 'await_attachment',
      variable: 'uploaded_doc_id',
      category: 'document',
      required: true,
      prompt: 'Please upload your document.',
      startedAt: Date.now(), // Not timed out
      timeoutSeconds: 300,
      onTimeout: 'timeout_step',
    };

    const step = buildStep();
    // User sends text but no attachment
    const result = executeAwaitAttachment(
      session,
      step,
      'I forgot the file',
      onChunk,
      onTraceEvent,
    );

    expect(result.advance).toBe(false);
    expect(result.result.response).toBe('Please upload your document.');
    expect(result.result.action.type).toBe('await_attachment');

    // onChunk should re-emit the prompt
    expect(onChunk).toHaveBeenCalledWith('Please upload your document.');

    // Conversation history should have the re-prompt
    expect(session.conversationHistory).toHaveLength(1);
    expect(session.conversationHistory[0].role).toBe('assistant');
  });

  // ── Test 6: Session state persistence ──────────────────────────────────

  it('sets pendingAwaitAttachment on thread correctly', () => {
    const session = buildMockSession();
    const thread = session.threads[0];
    const step = buildStep({
      variable: 'doc_id',
      category: 'document',
      required: true,
      timeout_seconds: 120,
      on_timeout: 'fallback_step',
    });

    // Before execution, no pending state
    expect(thread.pendingAwaitAttachment).toBeUndefined();

    executeAwaitAttachment(session, step, '', onChunk, onTraceEvent);

    // After execution, pending state should be set
    expect(thread.pendingAwaitAttachment).toBeDefined();
    expect(thread.pendingAwaitAttachment!.type).toBe('await_attachment');
    expect(thread.pendingAwaitAttachment!.variable).toBe('doc_id');
    expect(thread.pendingAwaitAttachment!.category).toBe('document');
    expect(thread.pendingAwaitAttachment!.required).toBe(true);
    expect(thread.pendingAwaitAttachment!.timeoutSeconds).toBe(120);
    expect(thread.pendingAwaitAttachment!.onTimeout).toBe('fallback_step');
    expect(typeof thread.pendingAwaitAttachment!.startedAt).toBe('number');
  });

  it('clears pendingAwaitAttachment when attachment is received', () => {
    const session = buildMockSession({
      currentAttachmentIds: ['attach-xyz'],
    });
    const thread = session.threads[0];

    // Pre-set pending state
    thread.pendingAwaitAttachment = {
      type: 'await_attachment',
      variable: 'doc_id',
      category: 'document',
      required: true,
      prompt: 'Upload please.',
      startedAt: Date.now(),
    };

    const step = buildStep({ variable: 'doc_id' });
    executeAwaitAttachment(session, step, 'here', onChunk, onTraceEvent);

    // Pending state should be cleared
    expect(thread.pendingAwaitAttachment).toBeUndefined();
  });

  // ── Test 7: currentAttachmentIds data access path ──────────────────────

  it('uses first attachment ID from currentAttachmentIds array', () => {
    const session = buildMockSession({
      currentAttachmentIds: ['first-id', 'second-id', 'third-id'],
    });
    const step = buildStep({ variable: 'receipt_file' });

    const result = executeAwaitAttachment(session, step, 'multiple files', onChunk, onTraceEvent);

    expect(result.advance).toBe(true);
    // Should use the first attachment only
    expect(session.data.values['receipt_file']).toBe('first-id');
  });

  it('does not advance when currentAttachmentIds is an empty array', () => {
    const session = buildMockSession({
      currentAttachmentIds: [],
    });
    const step = buildStep();

    const result = executeAwaitAttachment(session, step, 'no attachments', onChunk, onTraceEvent);

    // Empty array should NOT trigger the attachment-received path
    expect(result.advance).toBe(false);
    expect(result.result.response).toBe('Please upload your document.');
  });

  it('does not advance when currentAttachmentIds is undefined', () => {
    const session = buildMockSession({
      currentAttachmentIds: undefined,
    });
    const step = buildStep();

    const result = executeAwaitAttachment(session, step, 'no attachments', onChunk, onTraceEvent);

    expect(result.advance).toBe(false);
    expect(result.result.response).toBe('Please upload your document.');
  });

  // ── Test 8: Template interpolation in prompts ──────────────────────────

  it('interpolates template variables in prompt text', () => {
    const session = buildMockSession();
    session.data.values['user_name'] = 'Alice';
    // Sync thread data
    session.threads[0].data = session.data;

    const step = buildStep({
      prompt: 'Hello {{user_name}}, please upload your file.',
    });

    const result = executeAwaitAttachment(session, step, '', onChunk, onTraceEvent);

    expect(result.result.response).toBe('Hello Alice, please upload your file.');
    expect(onChunk).toHaveBeenCalledWith('Hello Alice, please upload your file.');
  });

  it('category mismatch: advances flow when attachment category differs from step category', () => {
    // Design decision: category enforcement is deferred to downstream consumers.
    // The executor stores the attachment ID regardless of category mismatch.
    const step = buildStep({ category: 'document' });
    const session = buildMockSession({
      currentAttachmentIds: ['att-image-123'],
    });

    const result = executeAwaitAttachment(session, step, '', onChunk, onTraceEvent);

    // Flow should advance even though the attachment might be an image, not a document
    expect(result.advance).toBe(true);
    expect(result.result.action.type).toBe('continue');
    expect(session.data.values['uploaded_doc_id']).toBe('att-image-123');
  });

  it('timeout exact boundary: fires timeout when elapsed equals timeoutMs', () => {
    const step = buildStep({ timeout_seconds: 300 });
    const session = buildMockSession();
    const thread = session.threads[0];

    // Set pending state with startedAt exactly 300 seconds ago
    thread.pendingAwaitAttachment = {
      type: 'await_attachment',
      variable: 'uploaded_doc_id',
      required: true,
      prompt: 'Please upload your document.',
      timeoutSeconds: 300,
      onTimeout: 'timeout_step',
      startedAt: Date.now() - 300_000, // exactly at boundary
    };

    const result = executeAwaitAttachment(session, step, '', onChunk, onTraceEvent);

    // >= comparison means exactly-at-boundary triggers timeout
    expect(result.advance).toBe(true);
    expect(result.result.action).toEqual({ type: 'timeout', nextStep: 'timeout_step' });
    expect(thread.pendingAwaitAttachment).toBeUndefined();
  });
});

// ─── deriveCategoryFromMimeType utility ──────────────────────────────────────

describe('deriveCategoryFromMimeType', () => {
  it('returns "image" for image/* MIME types', () => {
    expect(deriveCategoryFromMimeType('image/png')).toBe('image');
    expect(deriveCategoryFromMimeType('image/jpeg')).toBe('image');
    expect(deriveCategoryFromMimeType('image/gif')).toBe('image');
    expect(deriveCategoryFromMimeType('image/webp')).toBe('image');
    expect(deriveCategoryFromMimeType('image/svg+xml')).toBe('image');
    expect(deriveCategoryFromMimeType('Image/PNG')).toBe('image'); // case-insensitive
  });

  it('returns "audio" for audio/* MIME types', () => {
    expect(deriveCategoryFromMimeType('audio/mpeg')).toBe('audio');
    expect(deriveCategoryFromMimeType('audio/wav')).toBe('audio');
    expect(deriveCategoryFromMimeType('audio/ogg')).toBe('audio');
    expect(deriveCategoryFromMimeType('audio/mp4')).toBe('audio');
    expect(deriveCategoryFromMimeType('Audio/MPEG')).toBe('audio'); // case-insensitive
  });

  it('returns "video" for video/* MIME types', () => {
    expect(deriveCategoryFromMimeType('video/mp4')).toBe('video');
    expect(deriveCategoryFromMimeType('video/webm')).toBe('video');
    expect(deriveCategoryFromMimeType('video/quicktime')).toBe('video');
    expect(deriveCategoryFromMimeType('Video/MP4')).toBe('video'); // case-insensitive
  });

  it('returns "document" for document MIME types', () => {
    expect(deriveCategoryFromMimeType('application/pdf')).toBe('document');
    expect(deriveCategoryFromMimeType('application/msword')).toBe('document');
    expect(deriveCategoryFromMimeType('application/rtf')).toBe('document');
    expect(deriveCategoryFromMimeType('text/plain')).toBe('document');
    expect(deriveCategoryFromMimeType('text/csv')).toBe('document');
    expect(deriveCategoryFromMimeType('text/markdown')).toBe('document');
    // Office formats
    expect(
      deriveCategoryFromMimeType(
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      ),
    ).toBe('document');
    expect(
      deriveCategoryFromMimeType(
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      ),
    ).toBe('document');
    expect(deriveCategoryFromMimeType('application/vnd.ms-excel')).toBe('document');
    expect(deriveCategoryFromMimeType('application/vnd.ms-powerpoint')).toBe('document');
    // OpenDocument
    expect(deriveCategoryFromMimeType('application/vnd.oasis.opendocument.text')).toBe('document');
    expect(deriveCategoryFromMimeType('application/vnd.oasis.opendocument.spreadsheet')).toBe(
      'document',
    );
  });

  it('returns undefined for unknown MIME types', () => {
    expect(deriveCategoryFromMimeType('application/zip')).toBeUndefined();
    expect(deriveCategoryFromMimeType('application/octet-stream')).toBeUndefined();
    expect(deriveCategoryFromMimeType('application/x-executable')).toBeUndefined();
    expect(deriveCategoryFromMimeType('font/woff2')).toBeUndefined();
  });

  it('returns undefined for empty or falsy input', () => {
    expect(deriveCategoryFromMimeType('')).toBeUndefined();
  });
});

// ─── GATHER with type: attachment field (Phase 3A — preserved) ───────────────

describe('GATHER with type: attachment field (Phase 3A)', () => {
  describe('3-U24: GATHER with type: attachment field', () => {
    it('should support attachment type in gather fields for mixed collection', () => {
      const ir = buildAgentIRWithAwaitAttachment({
        await_attachment: undefined,
        gather: {
          fields: [
            {
              name: 'user_name',
              type: 'string',
              required: true,
              prompt: "What's your name?",
            },
            {
              name: 'id_photo',
              type: 'attachment',
              required: true,
              prompt: 'Please upload a photo of your ID.',
              attachment_config: {
                category: 'image',
                allowed_mime_types: ['image/jpeg', 'image/png'],
              },
            },
          ],
          strategy: 'llm',
        },
      });

      const step = ir.flow!.definitions['collect_document'];
      const attachmentField = step.gather!.fields.find((f) => f.name === 'id_photo');

      expect(attachmentField).toBeDefined();
      expect(attachmentField!.type).toBe('attachment');
      expect(attachmentField!.attachment_config).toBeDefined();
      expect(attachmentField!.attachment_config!.category).toBe('image');
    });
  });
});
