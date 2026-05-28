/**
 * Extraction audit-event integration test — Phase 4 task 4.7b / LLD §1 D-20.
 *
 * Drives `ExtractionAuditEmitter` through the canonical event shapes that
 * the workflow-handler emits at runtime (success, SSRF_BLOCKED, RATE_LIMITED,
 * QUOTA_EXCEEDED, STEP_TIMEOUT) and asserts:
 *
 *   1. The emitted envelope matches the spec keys EXACTLY (no drift).
 *   2. `sourceUrl` is reduced to host-only — query strings / paths / hashes
 *      never reach audit storage.
 *   3. Pre-call rejections record `sizeBytes === 0` and `durationMs === 0`
 *      (per D-20 — no envelope was assembled).
 *   4. Successful extractions record positive `sizeBytes` and `durationMs`.
 *
 * No platform mocks — the test injects an array-collector sink and exercises
 * the production emitter. The sink-injection seam mirrors the workflow-engine
 * boot path (the engine wires `defaultExtractionAuditSink` at startup; this
 * test wires a capture sink directly to assert the shape).
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  EXTRACTION_AUDIT_REJECTION_CODES,
  ExtractionAuditEmitter,
  toHostOnlyUrl,
  type ExtractionAuditEvent,
} from '../services/extraction-audit-events.js';

const SUCCESS_URL = 'https://files.example.com/tenant-a/docs/contract.pdf?sig=AKIA-LEAK-123';
const HOST_ONLY = 'https://files.example.com';

describe('ExtractionAuditEmitter — shape & sanitization', () => {
  let captured: ExtractionAuditEvent[];
  let emitter: ExtractionAuditEmitter;

  beforeEach(() => {
    captured = [];
    emitter = new ExtractionAuditEmitter({
      sink: (event) => captured.push(event),
    });
  });

  it('emits SUCCESS with positive sizeBytes/durationMs and host-only sourceUrl', () => {
    emitter.emit({
      actor: 'user-42',
      tenantId: 'tenant-a',
      projectId: 'project-1',
      connector: 'docling',
      action: 'extract_document',
      sourceUrl: SUCCESS_URL,
      sizeBytes: 1024 * 512, // 512 KB extracted envelope
      durationMs: 4_300,
      status: 'success',
    });

    expect(captured).toHaveLength(1);
    const event = captured[0]!;

    // Shape contract — these keys (exactly) are the audit envelope.
    expect(Object.keys(event).sort()).toEqual(
      [
        'actor',
        'tenantId',
        'projectId',
        'connector',
        'action',
        'sourceUrl',
        'sizeBytes',
        'durationMs',
        'status',
      ].sort(),
    );

    // host-only sanitization — the signed-URL query string MUST NOT leak.
    expect(event.sourceUrl).toBe(HOST_ONLY);
    expect(event.sourceUrl).not.toContain('AKIA-LEAK-123');
    expect(event.sourceUrl).not.toContain('contract.pdf');

    expect(event.status).toBe('success');
    expect(event.sizeBytes).toBeGreaterThan(0);
    expect(event.durationMs).toBeGreaterThan(0);
  });

  it.each([
    ['SSRF_BLOCKED', 'http://169.254.169.254/latest/meta-data'],
    ['RATE_LIMITED', 'https://files.example.com/large.pdf'],
    ['QUOTA_EXCEEDED', 'https://files.example.com/q4-report.pdf'],
    ['EXTRACTION_TOO_LARGE', 'https://files.example.com/giant.pdf?sig=secret'],
    ['CIRCUIT_OPEN', 'https://files.example.com/x.pdf'],
    ['FEATURE_DISABLED', 'https://files.example.com/y.pdf'],
    ['INTEGRATION_UNAVAILABLE', 'https://files.example.com/z.pdf'],
    ['UNSUPPORTED_CONTENT_TYPE', 'https://files.example.com/audio.mp3'],
    ['EXTRACTION_FAILED', 'https://files.example.com/malformed.pdf'],
  ])('pre-call rejection %s emits sizeBytes=0, durationMs=0, host-only URL', (statusCode, url) => {
    emitter.emit({
      actor: 'user-42',
      tenantId: 'tenant-a',
      projectId: 'project-1',
      connector: 'docling',
      action: 'extract_document',
      sourceUrl: url,
      sizeBytes: 0,
      durationMs: 0,
      status: statusCode,
    });

    expect(captured).toHaveLength(1);
    const event = captured[0]!;

    // Pre-call invariant: no envelope was assembled.
    expect(event.sizeBytes).toBe(0);
    expect(event.durationMs).toBe(0);

    // Status code surfaces verbatim and is in the recognized rejection set.
    expect(event.status).toBe(statusCode);
    expect(EXTRACTION_AUDIT_REJECTION_CODES.has(event.status)).toBe(true);

    // sourceUrl is reduced to host-only (no path, no query, no hash).
    expect(event.sourceUrl).not.toContain('?');
    expect(event.sourceUrl).not.toContain('#');
    // Path is stripped — only protocol + host remain. e.g. `https://files.example.com`.
    const parsed = new URL(event.sourceUrl);
    expect(parsed.pathname).toBe('/');
  });

  it('STEP_TIMEOUT (post-park failure) records durationMs > 0, sizeBytes=0', () => {
    emitter.emit({
      actor: 'system:workflow',
      tenantId: 'tenant-b',
      projectId: 'project-2',
      connector: 'docling',
      action: 'extract_document',
      sourceUrl: 'https://intranet.example.com/big.pdf',
      sizeBytes: 0,
      durationMs: 600_000,
      status: 'STEP_TIMEOUT',
    });

    const event = captured[0]!;
    expect(event.status).toBe('STEP_TIMEOUT');
    expect(event.durationMs).toBeGreaterThan(0);
    expect(event.sizeBytes).toBe(0);
    expect(event.sourceUrl).toBe('https://intranet.example.com');
  });

  it('a thrown sink does NOT propagate to the caller', () => {
    const throwingEmitter = new ExtractionAuditEmitter({
      sink: () => {
        throw new Error('sink-blew-up');
      },
    });

    // Must not throw — the workflow must continue regardless of audit-sink health.
    expect(() =>
      throwingEmitter.emit({
        actor: 'system:workflow',
        tenantId: 'tenant-c',
        projectId: 'project-3',
        connector: 'azure-document-intelligence',
        action: 'extract_document',
        sourceUrl: 'https://files.example.com/doc.pdf',
        sizeBytes: 0,
        durationMs: 0,
        status: 'CIRCUIT_OPEN',
      }),
    ).not.toThrow();
  });

  it('toHostOnlyUrl handles edge cases: empty string, malformed URL, IPv6, non-default port', () => {
    expect(toHostOnlyUrl('')).toBe('');
    expect(toHostOnlyUrl('not-a-url')).toBe('not-a-url'); // fallback — returns original
    expect(toHostOnlyUrl('https://[::1]:8443/path?key=secret')).toBe('https://[::1]:8443');
    expect(toHostOnlyUrl('https://example.com:8080/a/b?x=y#frag')).toBe('https://example.com:8080');
    // http://login:pw@host.com pattern — userinfo is part of authority; URL parse strips it
    // from the host. Verify it doesn't leak.
    expect(toHostOnlyUrl('https://user:pw@host.example.com/path')).not.toContain('user:pw');
  });
});
