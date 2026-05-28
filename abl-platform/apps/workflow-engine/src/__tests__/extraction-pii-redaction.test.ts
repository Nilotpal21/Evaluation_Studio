/**
 * Extraction PII redaction — Phase 4 task 4.7.
 *
 * Asserts that the engine-side scrubber wired into the workflow-handler's
 * `callbackRequest` suspension block strips PII / secrets from extraction
 * callback payloads BEFORE the data lands in `step.output`, the published
 * `step.completed` event, or the persisted execution row.
 *
 * The scrubber is the shared `scrubTraceEvent` from `@abl/compiler`. This
 * test exercises the same call shape the workflow-handler uses (see
 * `apps/workflow-engine/src/handlers/workflow-handler.ts` — the
 * `scrubTraceEvent(rawCallbackOutput)` call inside the suspension block).
 *
 * No platform-mock — only the production helper is invoked. The test
 * verifies redaction outcomes, not the helper's internals.
 */

import { describe, expect, it } from 'vitest';
import { scrubTraceEvent } from '@abl/compiler';

const EXTRACTED_MARKDOWN_WITH_PII = `# Customer Support Ticket — confidential

Reporter: jane.doe@example.com
SSN: 123-45-6789
Card on file: 4111-1111-1111-1111 (expires 12/27)
Stripe key referenced in ticket body: sk_live_51HABCDEFghijklmnopqrstuvwx
Bearer token from log dump: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9
Auth header captured: Authorization: Bearer abc123xyz
Customer phone: (415) 555-1234

## Steps
1. Customer reported login failure
2. Escalated to L2 with the artifacts above
`;

describe('extraction PII redaction (Phase 4 task 4.7)', () => {
  it('redacts API keys, SSN, credit card, bearer tokens from extracted markdown', () => {
    const callbackOutput = {
      status: 'success',
      envelope: {
        provider: 'docling',
        content: EXTRACTED_MARKDOWN_WITH_PII,
        metadata: { sourceUrl: 'https://example.com/ticket-42.pdf' },
      },
    };

    const scrubbed = scrubTraceEvent(callbackOutput);
    const flattened = JSON.stringify(scrubbed);

    // Sensitive primary indicators — must not appear verbatim.
    expect(flattened).not.toContain('sk_live_51HABCDEFghijklmnopqrstuvwx');
    expect(flattened).not.toContain('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9');
    expect(flattened).not.toContain('Bearer abc123xyz');
    expect(flattened).not.toContain('123-45-6789');
    expect(flattened).not.toContain('4111-1111-1111-1111');

    // Defensible non-secret context survives so the redacted markdown is still useful.
    expect(flattened).toContain('Customer Support Ticket');
    expect(flattened).toContain('Steps');
    expect(flattened).toContain('Escalated to L2');
  });

  it('redacts key-name-flagged fields (apiKey, password, authorization) from envelope metadata', () => {
    const callbackOutput = {
      status: 'success',
      envelope: {
        provider: 'docling',
        content: 'See attached file.',
        metadata: {
          // Synthetic envelope metadata that includes credential-named keys —
          // protects against connectors that accidentally surface upstream
          // request configuration into the envelope.
          authorization: 'Bearer sk_test_REDACT_ME',
          apiKey: 'top-secret-key-123',
          password: 'hunter2',
          sourceUrl: 'https://example.com/file.pdf',
        },
      },
    };

    const scrubbed = scrubTraceEvent(callbackOutput) as {
      envelope: { metadata: Record<string, unknown> };
    };

    expect(scrubbed.envelope.metadata.authorization).not.toBe('Bearer sk_test_REDACT_ME');
    expect(scrubbed.envelope.metadata.apiKey).not.toBe('top-secret-key-123');
    expect(scrubbed.envelope.metadata.password).not.toBe('hunter2');
    // Non-secret metadata is preserved.
    expect(scrubbed.envelope.metadata.sourceUrl).toBe('https://example.com/file.pdf');
  });

  it('redacts URL query strings (they may carry signed-URL tokens)', () => {
    // Defensible boundary: extracted markdown may include presigned URLs whose
    // query string carries short-lived auth (S3 signed URLs, Azure SAS, …).
    // The scrubber's pattern set catches `key=value` and Bearer-style prefixes;
    // assert one common form here so a regression on the pattern list is loud.
    const payload = {
      status: 'success',
      envelope: {
        content:
          'Document download: https://example.com/file?api-key=sk_live_ABCDEFGHIJKLMNOPQRSTUVWX&user=x',
      },
    };

    const scrubbed = scrubTraceEvent(payload);
    const flattened = JSON.stringify(scrubbed);

    expect(flattened).not.toContain('sk_live_ABCDEFGHIJKLMNOPQRSTUVWX');
  });

  it('is a no-op for outputs that contain no PII or secrets', () => {
    const payload = {
      status: 'success',
      envelope: {
        provider: 'docling',
        content: '# Annual Report\n\nRevenue grew 12% in Q4.\n',
        metadata: { sourceUrl: 'https://example.com/annual-report.pdf' },
      },
    };

    const scrubbed = scrubTraceEvent(payload) as typeof payload;
    expect(scrubbed.envelope.content).toBe(payload.envelope.content);
    expect(scrubbed.envelope.metadata.sourceUrl).toBe(payload.envelope.metadata.sourceUrl);
  });
});
