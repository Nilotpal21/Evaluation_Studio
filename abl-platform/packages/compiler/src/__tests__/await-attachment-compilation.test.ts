/**
 * AWAIT_ATTACHMENT Parser, Compiler & Validation Tests
 *
 * Verifies the AWAIT_ATTACHMENT: flow step property is parsed into AwaitAttachmentAST,
 * compiled into AwaitAttachmentIR, and validated with correct rules.
 */

import { describe, test, expect } from 'vitest';
import { parseAgentBasedABL } from '@abl/core';
import { compileABLtoIR } from '../platform/ir/compiler.js';
import { validateFlowGraph } from '../platform/ir/validate-ir.js';
import { VALIDATION_CODES } from '../platform/ir/validation-types.js';
import type { AgentIR, FlowStep, AwaitAttachmentIR } from '../platform/ir/schema.js';

// =============================================================================
// Helper Functions
// =============================================================================

/** Compile a single-agent DSL and return its AgentIR */
function compileAgent(dsl: string): {
  ir: AgentIR;
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

/** Create a minimal AgentIR with flow for validation tests */
function makeAgent(overrides: {
  steps?: string[];
  entryPoint?: string;
  definitions?: Record<string, Partial<FlowStep>>;
}): AgentIR {
  const steps = overrides.steps ?? ['step_a', 'step_b'];
  const definitions: Record<string, FlowStep> = {};
  if (overrides.definitions) {
    for (const [name, partial] of Object.entries(overrides.definitions)) {
      definitions[name] = { name, ...partial } as FlowStep;
    }
  } else {
    definitions.step_a = { name: 'step_a', then: 'step_b' } as FlowStep;
    definitions.step_b = { name: 'step_b' } as FlowStep;
  }

  return {
    ir_version: '1.0',
    metadata: {
      name: 'test_agent',
      version: '1.0.0',
      type: 'agent',
      compiled_at: '',
      source_hash: '',
      compiler_version: '1.0.0',
    },
    execution: {
      hints: {} as any,
      timeouts: {} as any,
    },
    identity: { goal: '', persona: '', limitations: [], system_prompt: {} as any },
    tools: [],
    gather: { fields: [], strategy: 'pattern' },
    memory: { session: [], persistent: [], remember: [], recall: [] },
    constraints: { constraints: [], guardrails: [] },
    coordination: { delegates: [], handoffs: [] },
    completion: { conditions: [] },
    error_handling: { handlers: [], default_handler: {} as any },
    messages: {} as any,
    flow: {
      steps,
      entry_point: overrides.entryPoint ?? steps[0],
      definitions,
    },
  } as AgentIR;
}

// =============================================================================
// Parser Tests
// =============================================================================

describe('AWAIT_ATTACHMENT parser', () => {
  test('parses AWAIT_ATTACHMENT with all properties', () => {
    const dsl = `AGENT: TestAgent

GOAL: "Test agent"

FLOW:
  ask_upload -> process

  ask_upload:
    REASONING: false
    RESPOND: "Please upload your document."
    AWAIT_ATTACHMENT:
      name: uploaded_doc
      prompt: "Upload your ID document"
      category: document
      required: true
      timeout: 300
      on_timeout: fallback_step
    THEN: process

  process:
    REASONING: false
    RESPOND: "Processing your upload."
`;
    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);
    expect(result.document).not.toBeNull();

    const askStep = result.document!.flow!.definitions['ask_upload'];
    expect(askStep).toBeDefined();
    expect(askStep.awaitAttachment).toBeDefined();

    const aa = askStep.awaitAttachment!;
    expect(aa.name).toBe('uploaded_doc');
    expect(aa.prompt).toBe('Upload your ID document');
    expect(aa.category).toBe('document');
    expect(aa.required).toBe(true);
    expect(aa.timeout).toBe(300);
    expect(aa.onTimeout).toBe('fallback_step');
  });

  test('parses AWAIT_ATTACHMENT with minimal properties', () => {
    const dsl = `AGENT: TestAgent

GOAL: "Test agent"

FLOW:
  ask_upload -> done

  ask_upload:
    REASONING: false
    AWAIT_ATTACHMENT:
      name: photo
      prompt: "Upload a photo"
    THEN: done

  done:
    REASONING: false
    RESPOND: "Done."
`;
    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);

    const askStep = result.document!.flow!.definitions['ask_upload'];
    expect(askStep.awaitAttachment).toBeDefined();

    const aa = askStep.awaitAttachment!;
    expect(aa.name).toBe('photo');
    expect(aa.prompt).toBe('Upload a photo');
    expect(aa.category).toBeUndefined();
    expect(aa.required).toBe(true); // Default
    expect(aa.timeout).toBeUndefined();
    expect(aa.onTimeout).toBeUndefined();
  });

  test('parses AWAIT_ATTACHMENT with required: false', () => {
    const dsl = `AGENT: TestAgent

GOAL: "Test agent"

FLOW:
  ask_upload -> done

  ask_upload:
    REASONING: false
    AWAIT_ATTACHMENT:
      name: optional_file
      prompt: "Optionally upload a file"
      required: false
    THEN: done

  done:
    REASONING: false
    RESPOND: "Done."
`;
    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);

    const aa = result.document!.flow!.definitions['ask_upload'].awaitAttachment!;
    expect(aa.required).toBe(false);
  });

  test('AWAIT_ATTACHMENT keyword is not misinterpreted as step name', () => {
    const dsl = `AGENT: TestAgent

GOAL: "Test agent"

FLOW:
  upload_step -> done

  upload_step:
    REASONING: false
    AWAIT_ATTACHMENT:
      name: file
      prompt: "Upload file"
    THEN: done

  done:
    REASONING: false
    RESPOND: "Done."
`;
    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);

    // AWAIT_ATTACHMENT should NOT be in the flow step definitions as a step name
    expect(result.document!.flow!.definitions['AWAIT_ATTACHMENT']).toBeUndefined();
    // upload_step should have the awaitAttachment field
    expect(result.document!.flow!.definitions['upload_step'].awaitAttachment).toBeDefined();
  });
});

// =============================================================================
// Compiler Tests (DSL -> AST -> IR)
// =============================================================================

describe('AWAIT_ATTACHMENT compilation', () => {
  test('basic AWAIT_ATTACHMENT compiles to correct IR', () => {
    const { ir } = compileAgent(`AGENT: TestAgent

GOAL: "Test agent"

FLOW:
  ask_upload -> done

  ask_upload:
    REASONING: false
    AWAIT_ATTACHMENT:
      name: uploaded_doc
      prompt: "Upload your document"
      category: document
      required: true
      timeout: 120
      on_timeout: done
    THEN: done

  done:
    REASONING: false
    RESPOND: "Done."
`);
    expect(ir.flow).toBeDefined();
    const step = ir.flow!.definitions['ask_upload'];
    expect(step).toBeDefined();
    expect(step.await_attachment).toBeDefined();

    const aa = step.await_attachment as AwaitAttachmentIR;
    expect(aa.variable).toBe('uploaded_doc');
    expect(aa.prompt).toBe('Upload your document');
    expect(aa.category).toBe('document');
    expect(aa.required).toBe(true);
    expect(aa.timeout_seconds).toBe(120);
    expect(aa.on_timeout).toBe('done');
  });

  test('required defaults to true when not specified', () => {
    const { ir } = compileAgent(`AGENT: TestAgent

GOAL: "Test agent"

FLOW:
  ask_upload -> done

  ask_upload:
    REASONING: false
    AWAIT_ATTACHMENT:
      name: photo
      prompt: "Upload a photo"
    THEN: done

  done:
    REASONING: false
    RESPOND: "Done."
`);
    const aa = ir.flow!.definitions['ask_upload'].await_attachment!;
    expect(aa.required).toBe(true);
  });

  test('compiles with category image', () => {
    const { ir } = compileAgent(`AGENT: TestAgent

GOAL: "Test agent"

FLOW:
  ask_upload -> done

  ask_upload:
    REASONING: false
    AWAIT_ATTACHMENT:
      name: photo
      prompt: "Upload a photo"
      category: image
    THEN: done

  done:
    REASONING: false
    RESPOND: "Done."
`);
    const aa = ir.flow!.definitions['ask_upload'].await_attachment!;
    expect(aa.category).toBe('image');
  });

  test('compiles with category audio', () => {
    const { ir } = compileAgent(`AGENT: TestAgent

GOAL: "Test agent"

FLOW:
  ask_upload -> done

  ask_upload:
    REASONING: false
    AWAIT_ATTACHMENT:
      name: recording
      prompt: "Upload audio recording"
      category: audio
    THEN: done

  done:
    REASONING: false
    RESPOND: "Done."
`);
    const aa = ir.flow!.definitions['ask_upload'].await_attachment!;
    expect(aa.category).toBe('audio');
  });

  test('compiles with category video', () => {
    const { ir } = compileAgent(`AGENT: TestAgent

GOAL: "Test agent"

FLOW:
  ask_upload -> done

  ask_upload:
    REASONING: false
    AWAIT_ATTACHMENT:
      name: clip
      prompt: "Upload video clip"
      category: video
    THEN: done

  done:
    REASONING: false
    RESPOND: "Done."
`);
    const aa = ir.flow!.definitions['ask_upload'].await_attachment!;
    expect(aa.category).toBe('video');
  });

  test('step without AWAIT_ATTACHMENT compiles to undefined', () => {
    const { ir } = compileAgent(`AGENT: TestAgent

GOAL: "Test agent"

FLOW:
  greet -> done

  greet:
    REASONING: false
    RESPOND: "Hello"
    THEN: done

  done:
    REASONING: false
    RESPOND: "Done."
`);
    const step = ir.flow!.definitions['greet'];
    expect(step.await_attachment).toBeUndefined();
  });

  test('full round-trip: DSL -> AST -> IR preserves all fields', () => {
    const dsl = `AGENT: TestAgent

GOAL: "Test agent"

FLOW:
  upload_step -> timeout_step -> done

  upload_step:
    REASONING: false
    RESPOND: "Please provide your receipt."
    AWAIT_ATTACHMENT:
      name: receipt_img
      prompt: "Upload receipt image"
      category: image
      required: false
      timeout: 60
      on_timeout: timeout_step
    THEN: done

  timeout_step:
    REASONING: false
    RESPOND: "Upload timed out."
    THEN: done

  done:
    REASONING: false
    RESPOND: "Processing complete."
`;
    // Parse
    const parsed = parseAgentBasedABL(dsl);
    expect(parsed.errors).toHaveLength(0);
    const ast = parsed.document!.flow!.definitions['upload_step'].awaitAttachment!;
    expect(ast.name).toBe('receipt_img');
    expect(ast.prompt).toBe('Upload receipt image');
    expect(ast.category).toBe('image');
    expect(ast.required).toBe(false);
    expect(ast.timeout).toBe(60);
    expect(ast.onTimeout).toBe('timeout_step');

    // Compile
    const output = compileABLtoIR([parsed.document!]);
    const ir = output.agents['TestAgent'];
    const aaIR = ir.flow!.definitions['upload_step'].await_attachment!;
    expect(aaIR.variable).toBe('receipt_img');
    expect(aaIR.prompt).toBe('Upload receipt image');
    expect(aaIR.category).toBe('image');
    expect(aaIR.required).toBe(false);
    expect(aaIR.timeout_seconds).toBe(60);
    expect(aaIR.on_timeout).toBe('timeout_step');
  });
});

// =============================================================================
// IR Validation Tests
// =============================================================================

describe('AWAIT_ATTACHMENT IR validation', () => {
  test('valid await_attachment produces no diagnostics', () => {
    const agent = makeAgent({
      steps: ['upload', 'done'],
      entryPoint: 'upload',
      definitions: {
        upload: {
          then: 'done',
          await_attachment: {
            variable: 'doc_id',
            prompt: 'Upload your document',
            category: 'document',
            required: true,
            timeout_seconds: 120,
            on_timeout: 'done',
          },
        },
        done: {},
      },
    });
    const diags = validateFlowGraph(agent);
    expect(diags).toHaveLength(0);
  });

  test('invalid category produces validation error', () => {
    const agent = makeAgent({
      steps: ['upload', 'done'],
      entryPoint: 'upload',
      definitions: {
        upload: {
          then: 'done',
          await_attachment: {
            variable: 'file_id',
            prompt: 'Upload a file',
            category: 'spreadsheet' as any,
            required: true,
          },
        },
        done: {},
      },
    });
    const diags = validateFlowGraph(agent);
    const catDiag = diags.filter(
      (d) => d.code === VALIDATION_CODES.INVALID_AWAIT_ATTACHMENT && d.path?.includes('category'),
    );
    expect(catDiag.length).toBe(1);
    expect(catDiag[0].severity).toBe('error');
    expect(catDiag[0].message).toContain('spreadsheet');
  });

  test('negative timeout_seconds produces validation error', () => {
    const agent = makeAgent({
      steps: ['upload', 'done'],
      entryPoint: 'upload',
      definitions: {
        upload: {
          then: 'done',
          await_attachment: {
            variable: 'file_id',
            prompt: 'Upload a file',
            required: true,
            timeout_seconds: -10,
          },
        },
        done: {},
      },
    });
    const diags = validateFlowGraph(agent);
    const timeoutDiag = diags.filter(
      (d) =>
        d.code === VALIDATION_CODES.INVALID_AWAIT_ATTACHMENT && d.path?.includes('timeout_seconds'),
    );
    expect(timeoutDiag.length).toBe(1);
    expect(timeoutDiag[0].severity).toBe('error');
    expect(timeoutDiag[0].message).toContain('-10');
  });

  test('zero timeout_seconds produces validation error', () => {
    const agent = makeAgent({
      steps: ['upload', 'done'],
      entryPoint: 'upload',
      definitions: {
        upload: {
          then: 'done',
          await_attachment: {
            variable: 'file_id',
            prompt: 'Upload a file',
            required: true,
            timeout_seconds: 0,
          },
        },
        done: {},
      },
    });
    const diags = validateFlowGraph(agent);
    const timeoutDiag = diags.filter(
      (d) =>
        d.code === VALIDATION_CODES.INVALID_AWAIT_ATTACHMENT && d.path?.includes('timeout_seconds'),
    );
    expect(timeoutDiag.length).toBe(1);
  });

  test('on_timeout referencing nonexistent step produces DANGLING_STEP_REF', () => {
    const agent = makeAgent({
      steps: ['upload', 'done'],
      entryPoint: 'upload',
      definitions: {
        upload: {
          then: 'done',
          await_attachment: {
            variable: 'file_id',
            prompt: 'Upload a file',
            required: true,
            on_timeout: 'nonexistent_step',
          },
        },
        done: {},
      },
    });
    const diags = validateFlowGraph(agent);
    const danglingDiag = diags.filter((d) => d.code === VALIDATION_CODES.DANGLING_STEP_REF);
    expect(danglingDiag.length).toBeGreaterThanOrEqual(1);
    expect(danglingDiag[0].message).toContain('nonexistent_step');
  });

  test('on_timeout referencing valid step produces no dangling error', () => {
    const agent = makeAgent({
      steps: ['upload', 'timeout_handler', 'done'],
      entryPoint: 'upload',
      definitions: {
        upload: {
          then: 'done',
          await_attachment: {
            variable: 'file_id',
            prompt: 'Upload a file',
            required: true,
            timeout_seconds: 60,
            on_timeout: 'timeout_handler',
          },
        },
        timeout_handler: { then: 'done' },
        done: {},
      },
    });
    const diags = validateFlowGraph(agent);
    const danglingDiag = diags.filter((d) => d.code === VALIDATION_CODES.DANGLING_STEP_REF);
    expect(danglingDiag).toHaveLength(0);
  });

  test('missing prompt produces validation error', () => {
    const agent = makeAgent({
      steps: ['upload', 'done'],
      entryPoint: 'upload',
      definitions: {
        upload: {
          then: 'done',
          await_attachment: {
            variable: 'file_id',
            prompt: '',
            required: true,
          },
        },
        done: {},
      },
    });
    const diags = validateFlowGraph(agent);
    const promptDiag = diags.filter(
      (d) => d.code === VALIDATION_CODES.INVALID_AWAIT_ATTACHMENT && d.path?.includes('prompt'),
    );
    expect(promptDiag.length).toBe(1);
    expect(promptDiag[0].severity).toBe('error');
  });

  test('missing variable produces validation error', () => {
    const agent = makeAgent({
      steps: ['upload', 'done'],
      entryPoint: 'upload',
      definitions: {
        upload: {
          then: 'done',
          await_attachment: {
            variable: '',
            prompt: 'Upload a file',
            required: true,
          },
        },
        done: {},
      },
    });
    const diags = validateFlowGraph(agent);
    const varDiag = diags.filter(
      (d) => d.code === VALIDATION_CODES.INVALID_AWAIT_ATTACHMENT && d.path?.includes('variable'),
    );
    expect(varDiag.length).toBe(1);
    expect(varDiag[0].severity).toBe('error');
  });

  test('variable with spaces produces validation error', () => {
    const agent = makeAgent({
      steps: ['upload', 'done'],
      entryPoint: 'upload',
      definitions: {
        upload: {
          then: 'done',
          await_attachment: {
            variable: 'my file',
            prompt: 'Upload a file',
            required: true,
          },
        },
        done: {},
      },
    });
    const diags = validateFlowGraph(agent);
    const varDiag = diags.filter(
      (d) => d.code === VALIDATION_CODES.INVALID_AWAIT_ATTACHMENT && d.path?.includes('variable'),
    );
    expect(varDiag.length).toBe(1);
    expect(varDiag[0].message).toContain('no spaces');
  });

  test('on_timeout step is reachable in BFS traversal', () => {
    const agent = makeAgent({
      steps: ['upload', 'timeout_handler', 'done'],
      entryPoint: 'upload',
      definitions: {
        upload: {
          then: 'done',
          await_attachment: {
            variable: 'file_id',
            prompt: 'Upload a file',
            required: true,
            timeout_seconds: 60,
            on_timeout: 'timeout_handler',
          },
        },
        timeout_handler: { then: 'done' },
        done: {},
      },
    });
    const diags = validateFlowGraph(agent);
    // timeout_handler should be reachable via on_timeout — no orphan warning
    const orphanDiag = diags.filter(
      (d) => d.code === VALIDATION_CODES.ORPHANED_STEP && d.message?.includes('timeout_handler'),
    );
    expect(orphanDiag).toHaveLength(0);
  });
});
