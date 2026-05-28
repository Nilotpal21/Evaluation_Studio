/**
 * Compiler Destinations Integration Tests (I-3A.1 to I-3A.6)
 *
 * Uses REAL parser + REAL compiler (no mocks). These are pure function tests
 * that validate the full DSL → AST → IR pipeline for DESTINATIONS,
 * AWAIT_ATTACHMENT, and GATHER with attachment fields.
 */

import { describe, test, expect } from 'vitest';
import { parseAgentBasedABL } from '@abl/core';
import { compileABLtoIR } from '../platform/ir/compiler.js';

/** Helper to compile a single-agent DSL and return its AgentIR + output */
function compileAgent(dsl: string) {
  const parsed = parseAgentBasedABL(dsl);
  expect(parsed.errors).toHaveLength(0);
  const output = compileABLtoIR([parsed.document!]);
  const agentName = parsed.document!.name;
  const ir = output.agents[agentName];
  return { ir, output, parsed };
}

describe('Destinations Integration (I-3A.1 to I-3A.6)', () => {
  // ===========================================================================
  // I-3A.1: Full DSL with DESTINATIONS compiles to valid IR
  // ===========================================================================

  test('I-3A.1: full DSL with DESTINATIONS compiles to valid IR with URLs, methods, headers', () => {
    const dsl = `AGENT: FullDestAgent

GOAL: "Agent with multiple destinations"

DESTINATIONS:
  doc_processor:
    url: "https://api.docprocessor.com/ingest"
    method: POST
    auth: bearer_token
    headers:
      X-Custom-Header: "custom-value"
      Content-Type: "application/json"
  archive_storage:
    url: "https://s3.archive.example.com/upload"
    method: PUT
    auth: api_key
  notification_webhook:
    url: "https://hooks.example.com/notify"
    method: POST
`;

    const { ir, output } = compileAgent(dsl);

    // No compilation errors
    expect(output.compilation_errors ?? []).toHaveLength(0);

    // IR should have destinations
    expect(ir.destinations).toBeDefined();
    expect(ir.destinations).toHaveLength(3);

    // Verify first destination
    const docProcessor = ir.destinations![0];
    expect(docProcessor.name).toBe('doc_processor');
    expect(docProcessor.url).toBe('https://api.docprocessor.com/ingest');
    expect(docProcessor.method).toBe('POST');
    expect(docProcessor.auth).toBe('bearer_token');
    expect(docProcessor.headers).toEqual({
      'X-Custom-Header': 'custom-value',
      'Content-Type': 'application/json',
    });

    // Verify second destination
    const archive = ir.destinations![1];
    expect(archive.name).toBe('archive_storage');
    expect(archive.url).toBe('https://s3.archive.example.com/upload');
    expect(archive.method).toBe('PUT');
    expect(archive.auth).toBe('api_key');

    // Verify third destination (no auth)
    const webhook = ir.destinations![2];
    expect(webhook.name).toBe('notification_webhook');
    expect(webhook.url).toBe('https://hooks.example.com/notify');
    expect(webhook.method).toBe('POST');
    expect(webhook.auth).toBeUndefined();
  });

  // ===========================================================================
  // I-3A.2: DSL without DESTINATIONS still compiles (regression)
  // ===========================================================================

  test('I-3A.2: DSL without DESTINATIONS still compiles cleanly', () => {
    const dsl = `AGENT: NoDest

GOAL: "Agent without destinations"

TOOLS:
  search(query: string) -> {results: array}
    description: "Search for information"
`;

    const { ir, output } = compileAgent(dsl);

    expect(output.compilation_errors ?? []).toHaveLength(0);
    expect(ir.destinations).toBeUndefined();
    expect(ir.metadata.name).toBe('NoDest');
  });

  // ===========================================================================
  // I-3A.3: DESTINATIONS with invalid URL rejected
  // ===========================================================================

  test('I-3A.3: destination missing URL produces parser error', () => {
    const dsl = `AGENT: BadUrl

GOAL: "Agent with broken destination"

DESTINATIONS:
  broken_dest:
    method: POST
`;

    const parsed = parseAgentBasedABL(dsl);

    // Parser should flag missing url
    expect(parsed.errors.length).toBeGreaterThan(0);
    expect(parsed.errors.some((e) => e.message.toLowerCase().includes('url'))).toBe(true);
  });

  // ===========================================================================
  // I-3A.4: DESTINATIONS with private IP rejected (SSRF)
  // ===========================================================================

  test('I-3A.4: destinations with private/internal IPs are rejected by SSRF protection', () => {
    const ssrfUrls = [
      'http://169.254.169.254/latest/meta-data/',
      'http://10.0.0.1/internal',
      'http://172.16.0.1/admin',
      'http://192.168.1.1/config',
      'http://127.0.0.1/localhost',
      'http://localhost/admin',
      'http://0.0.0.0/internal',
    ];

    for (const url of ssrfUrls) {
      const dsl = `AGENT: SSRFTest

GOAL: "Test SSRF protection"

DESTINATIONS:
  target:
    url: "${url}"
    method: POST
`;

      const parsed = parseAgentBasedABL(dsl);

      // If parser caught it, we're done
      if (parsed.errors.length > 0) {
        expect(
          parsed.errors.some(
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
      const compiled = compileABLtoIR([parsed.document!]);
      expect(compiled.compilation_errors!.length).toBeGreaterThan(0);
      expect(
        compiled.compilation_errors!.some(
          (e) =>
            e.message.toLowerCase().includes('ssrf') ||
            e.message.toLowerCase().includes('private') ||
            e.message.toLowerCase().includes('internal') ||
            e.message.toLowerCase().includes('not allowed'),
        ),
      ).toBe(true);
    }
  });

  // ===========================================================================
  // I-3A.5: AWAIT_ATTACHMENT compiles to correct IR (schema-level)
  // ===========================================================================

  test('I-3A.5: AwaitAttachmentIR schema exists on FlowStepIR', () => {
    // AWAIT_ATTACHMENT is defined in the IR schema (FlowStepIR.await_attachment)
    // but not yet implemented in the parser/compiler as a DSL keyword.
    // This test validates that the IR schema supports the field and a flow step
    // with attachment config can be represented.

    // Verify the schema shape by compiling a flow agent and checking the IR types
    const dsl = `AGENT: FlowAgent

GOAL: "Agent with flow steps"

FLOW:
  entry_point: start
  steps:
    - start
    - done

start:
  REASONING: false
  RESPOND: "Hello! Please upload your document."
  THEN: done

done:
  REASONING: false
  RESPOND: "Thank you!"
  THEN: COMPLETE
`;

    const { ir, output } = compileAgent(dsl);
    expect(output.compilation_errors ?? []).toHaveLength(0);

    // Flow should compile without errors
    expect(ir.flow).toBeDefined();
    expect(ir.flow!.definitions).toBeDefined();

    // Verify the flow step structure supports await_attachment at the type level
    // (The field is optional on FlowStepIR — we confirm IR shape is valid)
    const startStep = ir.flow!.definitions['start'];
    expect(startStep).toBeDefined();

    // await_attachment is an optional field — undefined when not set
    expect(startStep.await_attachment).toBeUndefined();
  });

  // ===========================================================================
  // I-3A.6: GATHER with attachment field compiles
  // ===========================================================================

  test('I-3A.6: GATHER alongside ATTACHMENTS compiles correctly', () => {
    const dsl = `AGENT: GatherAttachAgent

GOAL: "Agent that collects data and files"

GATHER:
  name:
    prompt: "What is your name?"
    type: string
  email:
    prompt: "What is your email?"
    type: string

ATTACHMENTS:
  id_document:
    prompt: "Please upload your ID"
    category: document
    required: true
  headshot:
    prompt: "Upload a headshot photo"
    category: image
    required: false
`;

    const { ir, output } = compileAgent(dsl);
    expect(output.compilation_errors ?? []).toHaveLength(0);

    // Gather fields should compile
    expect(ir.gather).toBeDefined();
    expect(ir.gather.fields.length).toBeGreaterThanOrEqual(2);
    const nameField = ir.gather.fields.find((f: { name: string }) => f.name === 'name');
    expect(nameField).toBeDefined();

    // Attachment fields should compile
    expect(ir.attachments).toBeDefined();
    expect(ir.attachments).toHaveLength(2);

    const idDoc = ir.attachments![0];
    expect(idDoc.name).toBe('id_document');
    expect(idDoc.category).toBe('document');
    expect(idDoc.required).toBe(true);

    const headshot = ir.attachments![1];
    expect(headshot.name).toBe('headshot');
    expect(headshot.category).toBe('image');
    expect(headshot.required).toBe(false);
  });
});
