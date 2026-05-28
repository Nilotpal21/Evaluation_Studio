/**
 * MCP Server Mode
 *
 * Provides Model Context Protocol server for Claude Code integration.
 * Enables debug tools to be used via Claude Code with full agent context.
 *
 * Tools are categorized as:
 * - LOCAL: Architect, import, validate, docs — no auth required
 * - REMOTE: Sessions, projects, traces — require platform auth
 */

import { createInterface } from 'readline';
import { readFileSync } from 'fs';
import { getApiUrl } from '../lib/config.js';
import { getToken, isAuthenticated } from '../lib/credentials.js';
import { DSL_DOCS, DOC_TOPICS, searchDocumentation } from './docs/index.js';
import { analyzeUseCase } from './architect/analyze.js';
import { generateABL, generateSingleAgentABL } from './architect/generate.js';
import { scaffoldProject, scaffoldDocs } from './architect/scaffold.js';
import { analyzeImport } from './import/analyzer.js';
import { convertImport } from './import/koreai-converter.js';
import { validateABLContent, validateABLFiles } from './validate/index.js';
import type { AnalyzeInput, ArchitectureSpec, AgentSpec } from './architect/types.js';
import type { ImportAnalysis } from './import/types.js';
import { modelTools, handleModelTool } from '../commands/models.js';
import { authoringTools, handleAuthoringTool, LOCAL_AUTHORING_TOOLS } from './authoring/index.js';
import { testingTools, handleTestingTool } from './testing/index.js';
import { analysisTools, handleAnalysisTool } from './analysis/index.js';

// =============================================================================
// TYPES
// =============================================================================

interface MCPRequest {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
}

interface MCPResponse {
  jsonrpc: '2.0';
  id: number | string;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

interface Tool {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

interface Resource {
  uri: string;
  name: string;
  description: string;
  mimeType: string;
}

// =============================================================================
// TOOL CATEGORIZATION
// =============================================================================

/** Local tools that don't require platform authentication */
const LOCAL_TOOLS = new Set([
  'kore_get_docs',
  'kore_search_docs',
  'kore_architect_analyze',
  'kore_architect_generate',
  'kore_architect_generate_agent',
  'kore_architect_generate_docs',
  'kore_import_analyze',
  'kore_import_convert',
  'kore_architect_validate',
  'kore_validate_agent',
  'kore_explain_dsl',
  'kore_suggest_improvements',
  'kore_test_agent',
]);

// =============================================================================
// TOOLS
// =============================================================================

const tools: Tool[] = [
  // =========================================================================
  // REMOTE TOOLS (require platform auth)
  // =========================================================================

  // Project Management
  {
    name: 'kore_list_projects',
    description:
      'List all projects in the Kore Platform. Returns project names, IDs, and agent/session counts.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'kore_get_sessions',
    description: 'List sessions for a project. Sessions represent active agent conversations.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: {
          type: 'string',
          description: 'Project ID',
        },
      },
      required: ['projectId'],
    },
  },

  // Session Debugging
  {
    name: 'kore_get_traces',
    description: `Get execution traces for a session. Traces record every action the agent takes including:
- flow_step_enter/exit: Movement through scripted flow
- llm_call: Language model invocations
- tool_call: External function calls
- dsl_collect/dsl_prompt/dsl_respond/dsl_set/dsl_on_input/dsl_call: ABL construct execution
- constraint_check: Validation results
- completion_check: COMPLETE condition evaluation (fields: condition, result, source, currentStep, nextStep)
- engine_decision: Auto-advance and skip decisions (fields: decision, reason, fromStep, toStep, chainDepth)
- handoff_condition_check: Handoff routing evaluation
- thread_return: Thread return to parent agent
- constraint_violation/warning/digression/sub_intent/correction/data_stored: Runtime events
- user_message: Incoming user messages
- error: Errors that occurred

Use completion_check events with source field to understand WHERE completion fired (loop_back_pre_advance, terminal_step, explicit_complete_step, post_turn_eval).`,
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: {
          type: 'string',
          description: 'Session ID',
        },
        projectId: {
          type: 'string',
          description: 'Project ID',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of traces to return (default: all)',
        },
        types: {
          type: 'string',
          description:
            'Comma-separated list of trace types to filter (e.g., "flow_step_enter,tool_call,error")',
        },
      },
      required: ['sessionId', 'projectId'],
    },
  },
  {
    name: 'kore_get_session_state',
    description: `Get current state for a session including:
- context: Values collected and stored during conversation
- conversationPhase: Current phase (start, gathering, processing, etc.)
- gatherProgress: Which fields have been collected
- flowState: Current step in scripted flow
- errorState: Any active errors

Use this to understand the agent's current situation.`,
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: {
          type: 'string',
          description: 'Session ID',
        },
        projectId: {
          type: 'string',
          description: 'Project ID',
        },
      },
      required: ['sessionId', 'projectId'],
    },
  },

  // Agent Specification
  {
    name: 'kore_get_agent_spec',
    description: `Get the full agent DSL specification for a session. Returns:
- Agent type (scripted, reasoning, supervisor)
- Full DSL source code
- Compiled IR (intermediate representation)
- Tool and field counts

Use this to understand HOW the agent is supposed to behave, then compare with traces to understand WHY issues occur.`,
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: {
          type: 'string',
          description: 'Session ID',
        },
        projectId: {
          type: 'string',
          description: 'Project ID',
        },
      },
      required: ['sessionId', 'projectId'],
    },
  },

  // Trace Analysis
  {
    name: 'kore_analyze_session',
    description: `Get automated analysis and diagnostics for a session. Returns:
- Summary statistics (event counts, duration, LLM calls)
- Current state (step, collected fields, missing fields)
- Detected issues (loops, errors, constraint violations, premature completion)
- Flow path analysis: expected vs visited vs skipped steps
- Premature completion detection: identifies when COMPLETE fires before all steps execute
- Suggestions for fixing problems

Use this as a starting point for debugging - it identifies common issues including premature completion automatically.`,
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: {
          type: 'string',
          description: 'Session ID',
        },
        projectId: {
          type: 'string',
          description: 'Project ID',
        },
      },
      required: ['sessionId', 'projectId'],
    },
  },

  // Documentation
  {
    name: 'kore_get_docs',
    description: `Get Agent ABL documentation for a specific topic. Available topics:
- overview: High-level ABL concepts and agent types
- scripted: Scripted agent syntax (flow, collect, transitions)
- reasoning: Reasoning agent syntax (tools, constraints, goals)
- supervisor: Supervisor agent syntax (delegation, routing)
- trace-events: Reference for all trace event types
- debugging: Step-by-step debugging guide
- context: How context works in agents
- architect: Architect and import tools reference

Use this to understand ABL syntax when analyzing agent specs or designing architectures.`,
    inputSchema: {
      type: 'object',
      properties: {
        topic: {
          type: 'string',
          description: `Documentation topic: ${DOC_TOPICS.join(', ')}`,
          enum: DOC_TOPICS,
        },
      },
      required: ['topic'],
    },
  },
  {
    name: 'kore_search_docs',
    description:
      'Search all Agent ABL documentation for a term. Returns matching excerpts with topic names.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search term to find in documentation',
        },
      },
      required: ['query'],
    },
  },

  // Combined Debug View
  {
    name: 'kore_debug_session',
    description: `Get comprehensive debug information for a session in one call. Returns:
- Agent specification (type, DSL, tools)
- Current state (step, context, collected fields)
- Recent traces (last 50 events)
- Automated analysis (issues, suggestions)

This is the recommended starting point for debugging - it gives you everything you need in one request.`,
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: {
          type: 'string',
          description: 'Session ID',
        },
        projectId: {
          type: 'string',
          description: 'Project ID',
        },
      },
      required: ['sessionId', 'projectId'],
    },
  },

  // Model Management
  ...modelTools,

  // Authoring Tools
  ...authoringTools,

  // Testing Tools
  ...testingTools,

  // Analysis Tools
  ...analysisTools,

  // =========================================================================
  // LOCAL TOOLS (no auth required)
  // =========================================================================

  // Architect Tools
  {
    name: 'kore_architect_analyze',
    description: `Analyze a use case description and optional existing API specs to design an ABL agent architecture.
Returns an architecture specification with:
- Recommended topology (single-agent, supervisor, or adaptive-network)
- Agent definitions with tools, gather fields, constraints
- Tool mappings from existing APIs
- ABL gap report with alternatives

Requires ANTHROPIC_API_KEY environment variable for Claude API calls.`,
    inputSchema: {
      type: 'object',
      properties: {
        useCase: {
          type: 'string',
          description: 'Natural language description of what the system should do',
        },
        existingApis: {
          type: 'array',
          description:
            'Optional list of existing backend APIs: [{name, baseUrl?, endpoints: [{method, path, description, params?, returns?}]}]',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              baseUrl: { type: 'string' },
              endpoints: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    method: { type: 'string' },
                    path: { type: 'string' },
                    description: { type: 'string' },
                    params: { type: 'object' },
                    returns: { type: 'string' },
                  },
                },
              },
            },
          },
        },
        constraints: {
          type: 'string',
          description:
            'Optional design constraints (e.g., "must use scripted mode", "max 3 agents")',
        },
      },
      required: ['useCase'],
    },
  },
  {
    name: 'kore_architect_generate',
    description: `Generate a complete ABL project from an architecture specification.
Creates project directory with:
- ABL agent files (.agent.abl)
- README.md
- docs/ directory (architecture, best-practices, limitations, deployment)

Takes the spec object returned by kore_architect_analyze.`,
    inputSchema: {
      type: 'object',
      properties: {
        spec: {
          type: 'object',
          description: 'Architecture specification from kore_architect_analyze',
        },
        outputDir: {
          type: 'string',
          description: 'Directory to create the project in (project will be a subdirectory)',
        },
      },
      required: ['spec', 'outputDir'],
    },
  },
  {
    name: 'kore_architect_generate_agent',
    description: `Generate a single .agent.abl file from an agent specification.
Use this for iterating on individual agents after the initial architecture is designed.
Returns the ABL text content.`,
    inputSchema: {
      type: 'object',
      properties: {
        agent: {
          type: 'object',
          description: 'Agent specification with name, mode, goal, persona, tools, gather, etc.',
        },
      },
      required: ['agent'],
    },
  },
  {
    name: 'kore_architect_generate_docs',
    description: `Generate only documentation files for an architecture spec (no ABL files).
Creates: README.md, docs/architecture.md, docs/best-practices.md, docs/limitations.md, docs/deployment.md`,
    inputSchema: {
      type: 'object',
      properties: {
        spec: {
          type: 'object',
          description: 'Architecture specification from kore_architect_analyze',
        },
        outputDir: {
          type: 'string',
          description: 'Directory to create docs in',
        },
      },
      required: ['spec', 'outputDir'],
    },
  },

  // Import Tools
  {
    name: 'kore_import_analyze',
    description: `Analyze a Kore.ai export JSON to produce a conversion plan.
Auto-detects format:
- Agent Platform v12: Multi-agent system with supervisor, agents, MCPServer tools
- XO11: Dialog flows with agent nodes, entity nodes, webhooks

Returns: format detection, entity mappings, ABL gap report, suggested topology.`,
    inputSchema: {
      type: 'object',
      properties: {
        sourceJson: {
          type: 'object',
          description: 'The full JSON export from Kore.ai Agent Platform v12 or XO11',
        },
      },
      required: ['sourceJson'],
    },
  },
  {
    name: 'kore_import_convert',
    description: `Convert an analyzed Kore.ai import to a complete ABL project.
Creates project directory with ABL files and documentation.
Requires the analysis from kore_import_analyze and the original JSON.`,
    inputSchema: {
      type: 'object',
      properties: {
        analysis: {
          type: 'object',
          description: 'Import analysis from kore_import_analyze',
        },
        sourceJson: {
          type: 'object',
          description: 'Original JSON export',
        },
        outputDir: {
          type: 'string',
          description: 'Directory to create the project in',
        },
      },
      required: ['analysis', 'sourceJson', 'outputDir'],
    },
  },

  // Validation Tool
  {
    name: 'kore_architect_validate',
    description: `Validate .agent.abl files for syntax errors.
Accepts either a file path (single file) or directory path (all .agent.abl files).
Returns validation results with errors and warnings.`,
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Path to a .agent.abl file or directory containing .agent.abl files',
        },
      },
      required: ['path'],
    },
  },
];

// =============================================================================
// RESOURCES
// =============================================================================

const resources: Resource[] = [
  {
    uri: 'kore://docs/overview',
    name: 'Agent DSL Overview',
    description: 'High-level documentation for Agent DSL',
    mimeType: 'text/markdown',
  },
  {
    uri: 'kore://docs/debugging',
    name: 'Debugging Guide',
    description: 'Step-by-step guide for debugging agents',
    mimeType: 'text/markdown',
  },
];

// =============================================================================
// TOOL HANDLERS
// =============================================================================

async function handleToolCall(name: string, args: Record<string, unknown>): Promise<unknown> {
  // Check if this is a remote tool that needs auth
  if (!LOCAL_TOOLS.has(name)) {
    const token = getToken();
    if (!token) {
      throw new Error('Not authenticated. Run: kore-platform-cli login');
    }
    return handleRemoteToolCall(name, args);
  }

  // Handle local tools (no auth required)
  return handleLocalToolCall(name, args);
}

// =============================================================================
// REMOTE TOOL HANDLERS
// =============================================================================

async function handleRemoteToolCall(name: string, args: Record<string, unknown>): Promise<unknown> {
  const token = getToken()!;
  const apiUrl = getApiUrl();
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  };

  switch (name) {
    // Project Management
    case 'kore_list_projects': {
      const response = await fetch(`${apiUrl}/api/projects`, { headers });
      if (!response.ok) throw new Error('Failed to list projects');
      return response.json();
    }

    case 'kore_get_sessions': {
      const { projectId } = args as { projectId: string };
      const response = await fetch(
        `${apiUrl}/api/projects/${encodeURIComponent(projectId)}/sessions`,
        { headers },
      );
      if (!response.ok) throw new Error('Failed to get sessions');
      return response.json();
    }

    // Session Debugging
    case 'kore_get_traces': {
      const { sessionId, projectId, limit, types } = args as {
        sessionId: string;
        projectId: string;
        limit?: number;
        types?: string;
      };
      const url = new URL(
        `${apiUrl}/api/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}/traces`,
      );
      if (limit) url.searchParams.set('limit', String(limit));
      if (types) url.searchParams.set('types', types);
      const response = await fetch(url.toString(), { headers });
      if (!response.ok) throw new Error('Failed to get traces');
      return response.json();
    }

    case 'kore_get_session_state': {
      const { sessionId, projectId } = args as { sessionId: string; projectId: string };
      const response = await fetch(
        `${apiUrl}/api/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}`,
        {
          headers,
        },
      );
      if (!response.ok) throw new Error('Failed to get session state');
      const data = (await response.json()) as { session?: { state?: unknown } };
      return { state: data.session?.state };
    }

    // Agent Specification
    case 'kore_get_agent_spec': {
      const { sessionId, projectId } = args as { sessionId: string; projectId: string };
      const response = await fetch(
        `${apiUrl}/api/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}/agent-spec`,
        { headers },
      );
      if (!response.ok) throw new Error('Failed to get agent spec');
      return response.json();
    }

    // Trace Analysis
    case 'kore_analyze_session': {
      const { sessionId, projectId } = args as { sessionId: string; projectId: string };
      const response = await fetch(
        `${apiUrl}/api/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}/analysis`,
        { headers },
      );
      if (!response.ok) throw new Error('Failed to analyze session');
      return response.json();
    }

    // Combined Debug View
    case 'kore_debug_session': {
      const { sessionId, projectId } = args as { sessionId: string; projectId: string };

      // Fetch all data in parallel
      const encodedProjectId = encodeURIComponent(projectId);
      const encodedSessionId = encodeURIComponent(sessionId);
      const [sessionRes, specRes, analysisRes, tracesRes] = await Promise.all([
        fetch(`${apiUrl}/api/projects/${encodedProjectId}/sessions/${encodedSessionId}`, {
          headers,
        }),
        fetch(
          `${apiUrl}/api/projects/${encodedProjectId}/sessions/${encodedSessionId}/agent-spec`,
          { headers },
        ),
        fetch(`${apiUrl}/api/projects/${encodedProjectId}/sessions/${encodedSessionId}/analysis`, {
          headers,
        }),
        fetch(
          `${apiUrl}/api/projects/${encodedProjectId}/sessions/${encodedSessionId}/traces?limit=50`,
          {
            headers,
          },
        ),
      ]);

      if (!sessionRes.ok) throw new Error('Failed to get session');

      const session = (await sessionRes.json()) as { session?: Record<string, unknown> };
      const spec = specRes.ok ? ((await specRes.json()) as { agent?: unknown }) : null;
      const analysisData = analysisRes.ok
        ? ((await analysisRes.json()) as { analysis?: unknown })
        : null;
      const tracesData = tracesRes.ok ? ((await tracesRes.json()) as { traces?: unknown[] }) : null;

      const analysisResult = analysisData?.analysis as { flowPath?: unknown } | null;

      return {
        session: {
          id: sessionId,
          agent: session.session?.agent,
          state: session.session?.state,
          messageCount: (session.session?.messages as unknown[])?.length || 0,
        },
        agentSpec: spec?.agent || null,
        analysis: analysisResult || null,
        flowPath: analysisResult?.flowPath || null,
        recentTraces: tracesData?.traces || [],
        documentation: {
          relevantTopics: [
            'debugging',
            session.session?.agent && (session.session.agent as { flow?: unknown }).flow
              ? 'scripted'
              : 'reasoning',
            'trace-events',
          ],
          hint: 'Use kore_get_docs to get detailed documentation for these topics.',
        },
      };
    }

    // Model Management
    case 'kore_list_models':
    case 'kore_add_model':
    case 'kore_test_model':
    case 'kore_set_default_model': {
      return handleModelTool(name, args, apiUrl, headers);
    }

    // Authoring Tools (remote)
    case 'kore_create_agent':
    case 'kore_list_agents':
    case 'kore_get_agent_dsl':
    case 'kore_update_agent_dsl':
    case 'kore_add_tool':
    case 'kore_add_flow_step':
    case 'kore_add_constraint':
    case 'kore_add_handoff':
    case 'kore_compile_agent': {
      return handleAuthoringTool(name, args, apiUrl, headers);
    }

    // Testing Tools
    case 'kore_test_conversation':
    case 'kore_test_scenario':
    case 'kore_get_test_results': {
      return handleTestingTool(name, args, apiUrl, headers);
    }

    default:
      throw new Error(`Unknown remote tool: ${name}`);
  }
}

// =============================================================================
// LOCAL TOOL HANDLERS
// =============================================================================

async function handleLocalToolCall(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    // Documentation (local)
    case 'kore_get_docs': {
      const { topic } = args as { topic: string };
      const content = DSL_DOCS[topic];
      if (!content) {
        throw new Error(`Unknown topic: ${topic}. Available: ${DOC_TOPICS.join(', ')}`);
      }
      return { topic, content };
    }

    case 'kore_search_docs': {
      const { query } = args as { query: string };
      const results = searchDocumentation(query);
      return { query, results };
    }

    // Architect: Analyze
    case 'kore_architect_analyze': {
      const input: AnalyzeInput = {
        useCase: args.useCase as string,
        existingApis: args.existingApis as AnalyzeInput['existingApis'],
        constraints: args.constraints as string | undefined,
      };
      const spec = await analyzeUseCase(input);
      return spec;
    }

    // Architect: Generate project
    case 'kore_architect_generate': {
      const spec = args.spec as ArchitectureSpec;
      const outputDir = args.outputDir as string;
      const result = scaffoldProject(spec, outputDir);
      return result;
    }

    // Architect: Generate single agent
    case 'kore_architect_generate_agent': {
      const agent = args.agent as AgentSpec;
      const ablContent = generateSingleAgentABL(agent);
      return { content: ablContent };
    }

    // Architect: Generate docs only
    case 'kore_architect_generate_docs': {
      const spec = args.spec as ArchitectureSpec;
      const outputDir = args.outputDir as string;
      const result = scaffoldDocs(spec, outputDir);
      return result;
    }

    // Import: Analyze
    case 'kore_import_analyze': {
      const sourceJson = args.sourceJson as unknown;
      const analysis = analyzeImport(sourceJson);
      return analysis;
    }

    // Import: Convert
    case 'kore_import_convert': {
      const analysis = args.analysis as ImportAnalysis;
      const sourceJson = args.sourceJson as unknown;
      const outputDir = args.outputDir as string;
      const result = await convertImport(analysis, sourceJson, outputDir);
      return result;
    }

    // Analysis Tools
    case 'kore_explain_dsl':
    case 'kore_suggest_improvements':
    case 'kore_test_agent': {
      return handleAnalysisTool(name, args);
    }

    // Validate (authoring)
    case 'kore_validate_agent': {
      return handleAuthoringTool(name, args, '', {});
    }

    // Validate
    case 'kore_architect_validate': {
      const path = args.path as string;

      // Check if it's a file or directory
      try {
        const { statSync } = await import('fs');
        const stat = statSync(path);

        if (stat.isFile()) {
          const content = readFileSync(path, 'utf-8');
          const result = validateABLContent(content, path);
          return {
            valid: result.errors.length === 0,
            fileCount: 1,
            errors: result.errors,
            warnings: result.warnings,
          };
        } else if (stat.isDirectory()) {
          return validateABLFiles(path);
        } else {
          throw new Error(`Path is neither a file nor directory: ${path}`);
        }
      } catch (err) {
        if (
          err instanceof Error &&
          'code' in err &&
          (err as NodeJS.ErrnoException).code === 'ENOENT'
        ) {
          throw new Error(`Path not found: ${path}`);
        }
        throw err;
      }
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// =============================================================================
// RESOURCE HANDLERS
// =============================================================================

function handleResourceRead(uri: string): { content: string; mimeType: string } | null {
  if (uri.startsWith('kore://docs/')) {
    const topic = uri.replace('kore://docs/', '');
    const content = DSL_DOCS[topic];
    if (content) {
      return { content, mimeType: 'text/markdown' };
    }
  }
  return null;
}

// =============================================================================
// MCP PROTOCOL HANDLERS
// =============================================================================

async function handleRequest(request: MCPRequest): Promise<MCPResponse> {
  const { id, method, params } = request;

  try {
    switch (method) {
      case 'initialize':
        return {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: '2024-11-05',
            capabilities: {
              tools: {},
              resources: { subscribe: false },
            },
            serverInfo: {
              name: 'kore-platform',
              version: '0.3.0',
            },
          },
        };

      case 'initialized':
        return {
          jsonrpc: '2.0',
          id,
          result: {},
        };

      case 'tools/list':
        return {
          jsonrpc: '2.0',
          id,
          result: { tools },
        };

      case 'tools/call': {
        const { name, arguments: args } = params as {
          name: string;
          arguments: Record<string, unknown>;
        };

        const result = await handleToolCall(name, args || {});

        return {
          jsonrpc: '2.0',
          id,
          result: {
            content: [
              {
                type: 'text',
                text: JSON.stringify(result, null, 2),
              },
            ],
          },
        };
      }

      case 'resources/list':
        return {
          jsonrpc: '2.0',
          id,
          result: { resources },
        };

      case 'resources/read': {
        const { uri } = params as { uri: string };
        const resource = handleResourceRead(uri);

        if (!resource) {
          return {
            jsonrpc: '2.0',
            id,
            error: {
              code: -32002,
              message: `Resource not found: ${uri}`,
            },
          };
        }

        return {
          jsonrpc: '2.0',
          id,
          result: {
            contents: [
              {
                uri,
                mimeType: resource.mimeType,
                text: resource.content,
              },
            ],
          },
        };
      }

      default:
        return {
          jsonrpc: '2.0',
          id,
          error: {
            code: -32601,
            message: `Method not found: ${method}`,
          },
        };
    }
  } catch (error) {
    return {
      jsonrpc: '2.0',
      id,
      error: {
        code: -32000,
        message: error instanceof Error ? error.message : 'Internal error',
      },
    };
  }
}

// =============================================================================
// SERVER
// =============================================================================

export async function startMCPServer(): Promise<void> {
  // Start server unconditionally — local tools work without auth.
  // Remote tools will check auth when called.

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false,
  });

  let buffer = '';

  rl.on('line', async (line) => {
    buffer += line;

    try {
      const request = JSON.parse(buffer) as MCPRequest;
      buffer = '';

      const response = await handleRequest(request);
      console.log(JSON.stringify(response));
    } catch {
      // Incomplete JSON, continue buffering
    }
  });

  rl.on('close', () => {
    process.exit(0);
  });
}
