/**
 * Attachment Parser & Compiler Tests
 *
 * Verifies the ATTACHMENTS: section is parsed into AttachmentFieldAST
 * and compiled into AttachmentFieldIR with correct defaults and mappings.
 */

import { describe, test, expect } from 'vitest';
import { parseAgentBasedABL } from '@abl/core';
import { compileABLtoIR } from '../platform/ir/compiler.js';
import type { AttachmentFieldIR } from '../platform/ir/schema.js';

// =============================================================================
// Parser Tests
// =============================================================================

describe('ATTACHMENTS parser', () => {
  test('parses a single attachment field with all properties', () => {
    const dsl = `AGENT: Test

GOAL: "Test agent"
ATTACHMENTS:
  photo:
    prompt: "Upload a photo"
    category: image
    required: true
    max_size_mb: 5
    allowed_types: [image/jpeg, image/png]
    ocr_enabled: true
`;
    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);
    expect(result.document).not.toBeNull();
    expect(result.document!.attachments).toBeDefined();
    expect(result.document!.attachments).toHaveLength(1);

    const field = result.document!.attachments![0];
    expect(field.name).toBe('photo');
    expect(field.prompt).toBe('Upload a photo');
    expect(field.category).toBe('image');
    expect(field.required).toBe(true);
    expect(field.maxFileSizeMb).toBe(5);
    expect(field.allowedMimeTypes).toEqual(['image/jpeg', 'image/png']);
    expect(field.ocrEnabled).toBe(true);
  });

  test('parses multiple attachment fields', () => {
    const dsl = `AGENT: Test

GOAL: "Test agent"
ATTACHMENTS:
  resume:
    prompt: "Upload your resume"
    category: document
    required: true
  headshot:
    prompt: "Upload a headshot"
    category: image
    required: false
`;
    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);
    expect(result.document!.attachments).toHaveLength(2);

    expect(result.document!.attachments![0].name).toBe('resume');
    expect(result.document!.attachments![0].category).toBe('document');
    expect(result.document!.attachments![0].required).toBe(true);

    expect(result.document!.attachments![1].name).toBe('headshot');
    expect(result.document!.attachments![1].category).toBe('image');
    expect(result.document!.attachments![1].required).toBe(false);
  });

  test('parses audio attachment with transcription', () => {
    const dsl = `AGENT: Test

GOAL: "Test agent"
ATTACHMENTS:
  recording:
    prompt: "Upload voice recording"
    category: audio
    transcription_enabled: true
    max_file_size_mb: 50
`;
    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);

    const field = result.document!.attachments![0];
    expect(field.name).toBe('recording');
    expect(field.category).toBe('audio');
    expect(field.transcriptionEnabled).toBe(true);
    expect(field.maxFileSizeMb).toBe(50);
  });

  test('parses video attachment with keyframe extraction', () => {
    const dsl = `AGENT: Test

GOAL: "Test agent"
ATTACHMENTS:
  clip:
    prompt: "Upload a video clip"
    category: video
    key_frame_extraction: true
    transcription: true
`;
    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);

    const field = result.document!.attachments![0];
    expect(field.name).toBe('clip');
    expect(field.category).toBe('video');
    expect(field.keyFrameExtraction).toBe(true);
    expect(field.transcriptionEnabled).toBe(true);
  });

  test('defaults to required: true when not specified', () => {
    const dsl = `AGENT: Test

GOAL: "Test agent"
ATTACHMENTS:
  doc:
    prompt: "Upload document"
    category: document
`;
    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);

    const field = result.document!.attachments![0];
    expect(field.required).toBe(true);
  });

  test('ATTACHMENTS section works alongside GATHER', () => {
    const dsl = `AGENT: Test

GOAL: "Test agent"
GATHER:
  name:
    prompt: "What is your name?"
    type: string
ATTACHMENTS:
  id_doc:
    prompt: "Upload your ID"
    category: document
`;
    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);
    expect(result.document!.gather).toHaveLength(1);
    expect(result.document!.gather[0].name).toBe('name');
    expect(result.document!.attachments).toHaveLength(1);
    expect(result.document!.attachments![0].name).toBe('id_doc');
  });

  test('agent without ATTACHMENTS section has no attachments field', () => {
    const dsl = `AGENT: Test

GOAL: "Test agent"
`;
    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);
    expect(result.document!.attachments).toBeUndefined();
  });
});

// =============================================================================
// Compiler Tests (DSL → IR)
// =============================================================================

/** Helper to compile a single-agent DSL and return its AgentIR */
function compileAgent(dsl: string): {
  ir: import('../platform/ir/schema.js').AgentIR;
  output: import('../platform/ir/schema.js').CompilationOutput;
} {
  const parsed = parseAgentBasedABL(dsl);
  expect(parsed.errors).toHaveLength(0);
  const output = compileABLtoIR([parsed.document!]);
  const agentName = parsed.document!.name;
  const ir = output.agents[agentName];
  expect(ir).toBeDefined();
  return { ir, output };
}

describe('compileAttachments', () => {
  test('compiles attachment field to IR with defaults', () => {
    const { ir } = compileAgent(`AGENT: Test

GOAL: "Test agent"
ATTACHMENTS:
  photo:
    prompt: "Upload a photo"
    category: image
`);
    expect(ir.attachments).toBeDefined();
    expect(ir.attachments).toHaveLength(1);

    const field = ir.attachments![0];
    expect(field.name).toBe('photo');
    expect(field.prompt).toBe('Upload a photo');
    expect(field.category).toBe('image');
    expect(field.required).toBe(true);
    // Default MIME types for image
    expect(field.allowed_mime_types).toEqual([
      'image/jpeg',
      'image/png',
      'image/gif',
      'image/webp',
    ]);
    // Default max file size for image (10 MB)
    expect(field.max_file_size_bytes).toBe(10 * 1024 * 1024);
    expect(field.processing).toEqual({});
  });

  test('compiles custom MIME types and file size', () => {
    const { ir } = compileAgent(`AGENT: Test

GOAL: "Test agent"
ATTACHMENTS:
  doc:
    prompt: "Upload PDF"
    category: document
    allowed_types: [application/pdf]
    max_size_mb: 15
`);
    const field = ir.attachments![0];
    expect(field.allowed_mime_types).toEqual(['application/pdf']);
    expect(field.max_file_size_bytes).toBe(15 * 1024 * 1024);
  });

  test('compiles processing options to IR', () => {
    const { ir } = compileAgent(`AGENT: Test

GOAL: "Test agent"
ATTACHMENTS:
  receipt:
    prompt: "Upload receipt"
    category: image
    ocr_enabled: true
`);
    const field = ir.attachments![0];
    expect(field.processing.ocr_enabled).toBe(true);
  });

  test('compiles audio with transcription to IR', () => {
    const { ir } = compileAgent(`AGENT: Test

GOAL: "Test agent"
ATTACHMENTS:
  voice_memo:
    prompt: "Upload voice memo"
    category: audio
    transcription_enabled: true
`);
    const field = ir.attachments![0];
    expect(field.category).toBe('audio');
    expect(field.processing.transcription_enabled).toBe(true);
    // Default MIME types for audio
    expect(field.allowed_mime_types).toEqual([
      'audio/mpeg',
      'audio/wav',
      'audio/ogg',
      'audio/webm',
    ]);
    // Default max file size for audio (50 MB)
    expect(field.max_file_size_bytes).toBe(50 * 1024 * 1024);
  });

  test('compiles video with keyframe extraction to IR', () => {
    const { ir } = compileAgent(`AGENT: Test

GOAL: "Test agent"
ATTACHMENTS:
  clip:
    prompt: "Upload video"
    category: video
    key_frame_extraction: true
    transcription_enabled: true
`);
    const field = ir.attachments![0];
    expect(field.category).toBe('video');
    expect(field.processing.key_frame_extraction).toBe(true);
    expect(field.processing.transcription_enabled).toBe(true);
    // Default max file size for video (100 MB)
    expect(field.max_file_size_bytes).toBe(100 * 1024 * 1024);
  });

  test('agent without ATTACHMENTS compiles to undefined', () => {
    const { ir } = compileAgent(`AGENT: Test

GOAL: "Test agent"
`);
    expect(ir.attachments).toBeUndefined();
  });

  test('compiles multiple attachment fields', () => {
    const { ir } = compileAgent(`AGENT: Test

GOAL: "Test agent"
ATTACHMENTS:
  resume:
    prompt: "Upload resume"
    category: document
    required: true
  photo:
    prompt: "Upload photo"
    category: image
    required: false
`);
    expect(ir.attachments).toHaveLength(2);
    expect(ir.attachments![0].name).toBe('resume');
    expect(ir.attachments![0].required).toBe(true);
    expect(ir.attachments![1].name).toBe('photo');
    expect(ir.attachments![1].required).toBe(false);
  });
});
