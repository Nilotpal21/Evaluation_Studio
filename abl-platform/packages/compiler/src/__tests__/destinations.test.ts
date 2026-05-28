/**
 * Destinations Parser & Compiler Tests (Phase 3A — ST-3.2)
 *
 * Verifies the DESTINATIONS: DSL section is parsed into DestinationAST
 * and compiled into DestinationIR with URL validation and SSRF protection.
 */

import { describe, test, expect } from 'vitest';
import { parseAgentBasedABL } from '@abl/core';
import { compileABLtoIR } from '../platform/ir/compiler.js';

// =============================================================================
// Parser Tests
// =============================================================================

describe('DESTINATIONS parser', () => {
  test('3-U8: parses DESTINATIONS block into AST with destinations array', () => {
    const dsl = `AGENT: Test

GOAL: "Test agent with destinations"
DESTINATIONS:
  doc_processor:
    url: "https://api.docprocessor.com/ingest"
    method: POST
    auth: bearer_token
    headers:
      X-Custom: "value"
  archive:
    url: "https://s3.archive.example.com/upload"
    method: PUT
`;
    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);
    expect(result.document).not.toBeNull();
    expect(result.document!.destinations).toBeDefined();
    expect(result.document!.destinations).toHaveLength(2);

    const docProcessor = result.document!.destinations![0];
    expect(docProcessor.name).toBe('doc_processor');
    expect(docProcessor.url).toBe('https://api.docprocessor.com/ingest');
    expect(docProcessor.method).toBe('POST');
    expect(docProcessor.auth).toBe('bearer_token');
    expect(docProcessor.headers).toEqual({ 'X-Custom': 'value' });

    const archive = result.document!.destinations![1];
    expect(archive.name).toBe('archive');
    expect(archive.url).toBe('https://s3.archive.example.com/upload');
    expect(archive.method).toBe('PUT');
  });

  test('3-U10: missing url in destination produces parser error', () => {
    const dsl = `AGENT: Test

GOAL: "Test agent"
DESTINATIONS:
  broken:
    method: POST
`;
    const result = parseAgentBasedABL(dsl);
    // Should produce an error about missing url
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors.some((e) => e.message.toLowerCase().includes('url'))).toBe(true);
  });
});

// =============================================================================
// Compiler Tests
// =============================================================================

describe('DESTINATIONS compiler', () => {
  test('3-U9: compiles destinations to IR with validated URLs', () => {
    const dsl = `AGENT: TestDest

GOAL: "Test agent with destinations"
DESTINATIONS:
  api_target:
    url: "https://api.example.com/ingest"
    method: POST
    auth: bearer_token
    headers:
      Authorization: "Bearer {{secrets.API_KEY}}"
`;
    const parseResult = parseAgentBasedABL(dsl);
    expect(parseResult.errors).toHaveLength(0);

    const compiled = compileABLtoIR([parseResult.document!]);
    expect(compiled.compilation_errors ?? []).toHaveLength(0);

    const agent = compiled.agents['TestDest'];
    expect(agent).toBeDefined();
    expect(agent.destinations).toBeDefined();
    expect(agent.destinations).toHaveLength(1);

    const dest = agent.destinations![0];
    expect(dest.name).toBe('api_target');
    expect(dest.url).toBe('https://api.example.com/ingest');
    expect(dest.method).toBe('POST');
    expect(dest.auth).toBe('bearer_token');
  });

  test('3-U11: SSRF URL (169.254.x / private IPs) rejected by compiler', () => {
    const ssrfUrls = [
      'http://169.254.169.254/latest/meta-data/', // AWS metadata
      'http://10.0.0.1/internal',
      'http://172.16.0.1/admin',
      'http://192.168.1.1/config',
      'http://127.0.0.1/localhost',
      'http://localhost/admin',
    ];

    for (const url of ssrfUrls) {
      const dsl = `AGENT: SSRFTest

GOAL: "Test agent"
DESTINATIONS:
  target:
    url: "${url}"
    method: POST
`;
      const parseResult = parseAgentBasedABL(dsl);
      if (parseResult.errors.length > 0) {
        // Parser caught it — that's fine
        expect(
          parseResult.errors.some(
            (e) =>
              e.message.toLowerCase().includes('ssrf') ||
              e.message.toLowerCase().includes('private') ||
              e.message.toLowerCase().includes('internal') ||
              e.message.toLowerCase().includes('not allowed'),
          ),
        ).toBe(true);
        continue;
      }

      // Parser passed — compiler should catch it
      const compiled = compileABLtoIR([parseResult.document!]);
      expect(compiled.compilation_errors.length).toBeGreaterThan(0);
      expect(
        compiled.compilation_errors.some(
          (e) =>
            e.message.toLowerCase().includes('ssrf') ||
            e.message.toLowerCase().includes('private') ||
            e.message.toLowerCase().includes('internal') ||
            e.message.toLowerCase().includes('not allowed'),
        ),
      ).toBe(true);
    }
  });
});
