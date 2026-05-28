/**
 * Custom-HTTP Provider × Kind E2E Tests
 *
 * Tests the custom-http provider across all 5 guardrail kinds:
 *   input, output, tool_input, tool_output, handoff
 *
 * Each kind is tested through the full pipeline with:
 *   - Violation detection (score above threshold)
 *   - Pass detection (score below threshold)
 *   - SSRF protection verification
 *   - Correct context variables for each kind
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GuardrailPipelineImpl } from '../../platform/guardrails/pipeline';
import { GuardrailProviderRegistry } from '../../platform/guardrails/provider-registry';
import { CustomHTTPProvider } from '../../platform/guardrails/providers/custom-http';
import type { Guardrail } from '../../platform/ir/schema';

// ─── Mock Fetch ─────────────────────────────────────────────────────────────

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

/** Create a mock Response with streaming body reader. */
function mockResponse(opts: {
  ok?: boolean;
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}) {
  const bodyText = opts.body !== undefined ? JSON.stringify(opts.body) : '';
  const encoded = new TextEncoder().encode(bodyText);
  return {
    ok: opts.ok ?? true,
    status: opts.status ?? 200,
    headers: new Headers(opts.headers ?? {}),
    body: {
      getReader() {
        let done = false;
        return {
          read: async (): Promise<{ done: boolean; value?: Uint8Array }> => {
            if (done) return { done: true };
            done = true;
            return { done: false, value: encoded };
          },
          cancel: async () => {},
        };
      },
    },
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeCustomHttpGuardrail(
  kind: Guardrail['kind'],
  overrides: Partial<Guardrail> = {},
): Guardrail {
  return {
    name: `custom-http-${kind}-guard`,
    description: `Custom HTTP guardrail for ${kind}`,
    kind,
    priority: 1,
    tier: 'model',
    provider: 'custom-safety',
    category: 'safety',
    threshold: 0.5,
    action: { type: 'block', message: `Blocked by custom-http ${kind} guard` },
    ...overrides,
  };
}

function createPipelineWithCustomHttp(
  providerConfig?: Partial<ConstructorParameters<typeof CustomHTTPProvider>[0]>,
): { pipeline: GuardrailPipelineImpl; provider: CustomHTTPProvider } {
  const provider = new CustomHTTPProvider({
    name: 'custom-safety',
    url: 'https://safety-api.example.com/evaluate',
    method: 'POST',
    headers: { 'X-API-Key': 'test-key' },
    bodyTemplate: '{"text": "{{content}}", "check": "{{category}}"}',
    scorePath: 'result.score',
    labelPath: 'result.label',
    explanationPath: 'result.explanation',
    costPerEvalUsd: 0.005,
    ...providerConfig,
  });

  const registry = new GuardrailProviderRegistry();
  registry.register(provider);
  const pipeline = new GuardrailPipelineImpl(registry);

  return { pipeline, provider };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('Custom-HTTP Provider × Kind E2E', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  // ─── Input Kind ─────────────────────────────────────────────────────────

  describe('kind: input', () => {
    it('should block user input when custom-http returns high score', async () => {
      mockFetch.mockResolvedValueOnce(
        mockResponse({
          body: { result: { score: 0.9, label: 'toxicity', explanation: 'Toxic user input' } },
        }),
      );

      const { pipeline } = createPipelineWithCustomHttp();
      const guardrail = makeCustomHttpGuardrail('input');

      const result = await pipeline.execute([guardrail], 'offensive user message', 'input', {});

      expect(result.passed).toBe(false);
      expect(result.violations).toHaveLength(1);
      expect(result.violations[0].name).toBe('custom-http-input-guard');
      expect(result.violations[0].tier).toBe('model');
      expect(result.violations[0].provider).toBe('custom-safety');
      expect(result.violations[0].score).toBe(0.9);
      expect(result.violations[0].action).toBe('block');
    });

    it('should pass user input when custom-http returns low score', async () => {
      mockFetch.mockResolvedValueOnce(
        mockResponse({
          body: { result: { score: 0.1, label: 'safe', explanation: 'Clean input' } },
        }),
      );

      const { pipeline } = createPipelineWithCustomHttp();
      const guardrail = makeCustomHttpGuardrail('input');

      const result = await pipeline.execute([guardrail], 'Hello, how are you?', 'input', {});

      expect(result.passed).toBe(true);
      expect(result.violations).toHaveLength(0);
    });

    it('should send correct content to custom-http endpoint for input kind', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({ body: { result: { score: 0.1 } } }));

      const { pipeline } = createPipelineWithCustomHttp();
      const guardrail = makeCustomHttpGuardrail('input');

      await pipeline.execute([guardrail], 'test input content', 'input', {});

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const requestBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(requestBody.text).toBe('test input content');
      expect(requestBody.check).toBe('safety');
    });
  });

  // ─── Output Kind ────────────────────────────────────────────────────────

  describe('kind: output', () => {
    it('should block agent output when custom-http returns high score', async () => {
      mockFetch.mockResolvedValueOnce(
        mockResponse({
          body: { result: { score: 0.85, label: 'harmful', explanation: 'Harmful response' } },
        }),
      );

      const { pipeline } = createPipelineWithCustomHttp();
      const guardrail = makeCustomHttpGuardrail('output');

      const result = await pipeline.execute([guardrail], 'dangerous agent output', 'output', {});

      expect(result.passed).toBe(false);
      expect(result.violations).toHaveLength(1);
      expect(result.violations[0].name).toBe('custom-http-output-guard');
      expect(result.violations[0].label).toBe('harmful');
    });

    it('should pass safe agent output', async () => {
      mockFetch.mockResolvedValueOnce(
        mockResponse({
          body: { result: { score: 0.05, label: 'safe' } },
        }),
      );

      const { pipeline } = createPipelineWithCustomHttp();
      const guardrail = makeCustomHttpGuardrail('output');

      const result = await pipeline.execute([guardrail], 'Here is your summary...', 'output', {});

      expect(result.passed).toBe(true);
      expect(result.violations).toHaveLength(0);
    });

    it('should support warn action on output', async () => {
      mockFetch.mockResolvedValueOnce(
        mockResponse({
          body: { result: { score: 0.7, label: 'borderline' } },
        }),
      );

      const { pipeline } = createPipelineWithCustomHttp();
      const guardrail = makeCustomHttpGuardrail('output', {
        action: { type: 'warn', message: 'Output quality warning' },
      });

      const result = await pipeline.execute([guardrail], 'questionable output', 'output', {});

      expect(result.passed).toBe(true);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0].action).toBe('warn');
    });
  });

  // ─── Tool Input Kind ──────────────────────────────────────────────────

  describe('kind: tool_input', () => {
    it('should block tool input when custom-http flags it', async () => {
      mockFetch.mockResolvedValueOnce(
        mockResponse({
          body: {
            result: { score: 0.95, label: 'injection', explanation: 'SQL injection attempt' },
          },
        }),
      );

      const { pipeline } = createPipelineWithCustomHttp();
      const guardrail = makeCustomHttpGuardrail('tool_input');

      const result = await pipeline.execute(
        [guardrail],
        'SELECT * FROM users; DROP TABLE users;--',
        'tool_input',
        { toolName: 'database_query', toolParameters: { query: 'SELECT * FROM users' } },
      );

      expect(result.passed).toBe(false);
      expect(result.violations).toHaveLength(1);
      expect(result.violations[0].name).toBe('custom-http-tool_input-guard');
      expect(result.violations[0].explanation).toBe('SQL injection attempt');
    });

    it('should pass clean tool input', async () => {
      mockFetch.mockResolvedValueOnce(
        mockResponse({
          body: { result: { score: 0.0, label: 'safe' } },
        }),
      );

      const { pipeline } = createPipelineWithCustomHttp();
      const guardrail = makeCustomHttpGuardrail('tool_input');

      const result = await pipeline.execute(
        [guardrail],
        '{"query": "weather in NYC"}',
        'tool_input',
        { toolName: 'weather_api' },
      );

      expect(result.passed).toBe(true);
    });
  });

  // ─── Tool Output Kind ─────────────────────────────────────────────────

  describe('kind: tool_output', () => {
    it('should block tool output when custom-http flags it', async () => {
      mockFetch.mockResolvedValueOnce(
        mockResponse({
          body: { result: { score: 0.88, label: 'pii_leak', explanation: 'Tool returned PII' } },
        }),
      );

      const { pipeline } = createPipelineWithCustomHttp();
      const guardrail = makeCustomHttpGuardrail('tool_output');

      const result = await pipeline.execute(
        [guardrail],
        'User SSN: 123-45-6789, DOB: 01/01/1990',
        'tool_output',
        { toolName: 'user_lookup', toolResult: { ssn: '123-45-6789' }, toolSuccess: true },
      );

      expect(result.passed).toBe(false);
      expect(result.violations).toHaveLength(1);
      expect(result.violations[0].label).toBe('pii_leak');
    });

    it('should pass clean tool output', async () => {
      mockFetch.mockResolvedValueOnce(
        mockResponse({
          body: { result: { score: 0.02 } },
        }),
      );

      const { pipeline } = createPipelineWithCustomHttp();
      const guardrail = makeCustomHttpGuardrail('tool_output');

      const result = await pipeline.execute(
        [guardrail],
        '{"temperature": 72, "conditions": "sunny"}',
        'tool_output',
        { toolName: 'weather_api', toolResult: { temp: 72 }, toolSuccess: true },
      );

      expect(result.passed).toBe(true);
    });

    it('should support redact action on tool_output', async () => {
      mockFetch.mockResolvedValueOnce(
        mockResponse({
          body: { result: { score: 0.7, label: 'pii' } },
        }),
      );

      const { pipeline } = createPipelineWithCustomHttp();
      const guardrail = makeCustomHttpGuardrail('tool_output', {
        action: { type: 'redact', redactMode: 'pii' },
      });

      const result = await pipeline.execute(
        [guardrail],
        'Contact: john@example.com, phone: 555-123-4567',
        'tool_output',
        { toolName: 'contact_lookup', toolSuccess: true },
      );

      // Redact is non-terminal, pipeline still passes
      expect(result.violations).toHaveLength(1);
      expect(result.violations[0].action).toBe('redact');
    });
  });

  // ─── Handoff Kind ─────────────────────────────────────────────────────

  describe('kind: handoff', () => {
    it('should block handoff when custom-http flags it', async () => {
      mockFetch.mockResolvedValueOnce(
        mockResponse({
          body: {
            result: {
              score: 0.92,
              label: 'unsafe_transfer',
              explanation: 'Unsafe handoff payload',
            },
          },
        }),
      );

      const { pipeline } = createPipelineWithCustomHttp();
      const guardrail = makeCustomHttpGuardrail('handoff');

      const result = await pipeline.execute(
        [guardrail],
        'Transferring sensitive customer data to unverified agent',
        'handoff',
        {
          sourceAgent: 'support-agent',
          targetAgent: 'external-agent',
          handoffReason: 'escalation',
        },
      );

      expect(result.passed).toBe(false);
      expect(result.violations).toHaveLength(1);
      expect(result.violations[0].name).toBe('custom-http-handoff-guard');
    });

    it('should pass safe handoff', async () => {
      mockFetch.mockResolvedValueOnce(
        mockResponse({
          body: { result: { score: 0.1 } },
        }),
      );

      const { pipeline } = createPipelineWithCustomHttp();
      const guardrail = makeCustomHttpGuardrail('handoff');

      const result = await pipeline.execute(
        [guardrail],
        'Transferring to billing specialist for invoice query',
        'handoff',
        {
          sourceAgent: 'triage-agent',
          targetAgent: 'billing-agent',
          handoffReason: 'specialization',
        },
      );

      expect(result.passed).toBe(true);
    });

    it('should support escalate action on handoff', async () => {
      mockFetch.mockResolvedValueOnce(
        mockResponse({
          body: { result: { score: 0.8, label: 'sensitive' } },
        }),
      );

      const { pipeline } = createPipelineWithCustomHttp();
      const guardrail = makeCustomHttpGuardrail('handoff', {
        action: { type: 'escalate', message: 'Handoff requires human review' },
      });

      const result = await pipeline.execute(
        [guardrail],
        'Transferring medical records',
        'handoff',
        { sourceAgent: 'intake', targetAgent: 'medical', handoffReason: 'medical-query' },
      );

      expect(result.passed).toBe(false);
      expect(result.violations).toHaveLength(1);
      expect(result.violations[0].action).toBe('escalate');
    });
  });

  // ─── SSRF Protection ──────────────────────────────────────────────────

  describe('SSRF protection across kinds', () => {
    const SSRF_URLS = [
      { url: 'http://evil@169.254.169.254/api', label: 'userinfo bypass' },
      { url: 'http://evil@10.0.0.1/api', label: 'userinfo + private IP' },
    ];

    const KINDS: Guardrail['kind'][] = ['input', 'output', 'tool_input', 'tool_output', 'handoff'];

    for (const { url, label } of SSRF_URLS) {
      for (const kind of KINDS) {
        it(`should block SSRF (${label}) for kind: ${kind}`, async () => {
          const { pipeline } = createPipelineWithCustomHttp({ url });
          const guardrail = makeCustomHttpGuardrail(kind);

          const result = await pipeline.execute([guardrail], 'test content', kind, {});

          // SSRF-blocked provider fails open (no network call, score 0 → pass)
          expect(result.passed).toBe(true);
          expect(mockFetch).not.toHaveBeenCalled();
        });
      }
    }
  });

  // ─── Kind Filtering ───────────────────────────────────────────────────

  describe('kind filtering', () => {
    it('should only evaluate guardrails matching the requested kind', async () => {
      mockFetch.mockResolvedValueOnce(
        mockResponse({ body: { result: { score: 0.9, label: 'toxic' } } }),
      );

      const { pipeline } = createPipelineWithCustomHttp();
      const inputGuard = makeCustomHttpGuardrail('input', { name: 'input-guard' });
      const outputGuard = makeCustomHttpGuardrail('output', { name: 'output-guard' });

      const result = await pipeline.execute([inputGuard, outputGuard], 'test content', 'input', {});

      // Only input-guard should fire, output-guard should be filtered out
      // One fetch call for input-guard only
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(result.violations).toHaveLength(1);
      expect(result.violations[0].name).toBe('input-guard');
    });
  });

  // ─── Error Handling (fail-open) ───────────────────────────────────────

  describe('error handling (fail-open)', () => {
    it('should fail-open when custom-http endpoint returns 500', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({ ok: false, status: 500 }));

      const { pipeline } = createPipelineWithCustomHttp();
      const guardrail = makeCustomHttpGuardrail('input');

      const result = await pipeline.execute([guardrail], 'test content', 'input', {});

      // Provider returns score 0 on error → pass
      expect(result.passed).toBe(true);
    });

    it('should fail-open when custom-http endpoint is unreachable', async () => {
      mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));

      const { pipeline } = createPipelineWithCustomHttp();
      const guardrail = makeCustomHttpGuardrail('input');

      const result = await pipeline.execute([guardrail], 'test content', 'input', {});

      expect(result.passed).toBe(true);
    });
  });

  // ─── Severity Actions ─────────────────────────────────────────────────

  describe('severity-specific actions', () => {
    it('should use severity-specific action when score maps to matching severity', async () => {
      // Score 0.8 → severity 'high' via scoreToSeverity
      mockFetch.mockResolvedValueOnce(
        mockResponse({
          body: { result: { score: 0.8, label: 'violence' } },
        }),
      );

      const { pipeline } = createPipelineWithCustomHttp();
      const guardrail = makeCustomHttpGuardrail('input', {
        action: { type: 'warn', message: 'Default warning' },
        severityActions: {
          high: { type: 'block', message: 'Blocked: high severity' },
          critical: { type: 'escalate', message: 'Escalated: critical' },
        },
      });

      const result = await pipeline.execute([guardrail], 'violent content', 'input', {});

      expect(result.passed).toBe(false);
      expect(result.violations).toHaveLength(1);
      expect(result.violations[0].action).toBe('block');
      expect(result.violations[0].message).toBe('Blocked: high severity');
    });
  });

  // ─── Metrics ──────────────────────────────────────────────────────────

  describe('metrics tracking', () => {
    it('should track cost from custom-http provider', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({ body: { result: { score: 0.3 } } }));

      const { pipeline } = createPipelineWithCustomHttp({ costPerEvalUsd: 0.005 });
      const guardrail = makeCustomHttpGuardrail('input');

      const result = await pipeline.execute([guardrail], 'test', 'input', {});

      expect(result.metrics.costUsd).toBeCloseTo(0.005, 5);
      expect(result.metrics.totalChecks).toBe(1);
    });
  });
});
