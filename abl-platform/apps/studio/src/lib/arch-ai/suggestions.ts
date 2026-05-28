/**
 * Server-side contextual suggestion generator.
 * Maps the last tool used to relevant follow-up actions.
 */

interface ArchSuggestion {
  id: string;
  label: string;
  description: string;
  category:
    | 'error-handling'
    | 'escalation'
    | 'testing'
    | 'optimization'
    | 'feature'
    | 'security'
    | 'modify'
    | 'health'
    | 'topology'
    | 'trace';
  prompt: string;
  icon: string;
}

interface SuggestionContext {
  agentCount: number;
  hasWarnings: boolean;
}

const TOOL_SUGGESTIONS: Record<string, ArchSuggestion[]> = {
  read_topology: [
    {
      id: 'topo-health',
      label: 'Run health check',
      description: 'Check all agents for configuration issues',
      category: 'health',
      prompt: 'Run a health check on all agents',
      icon: 'Activity',
    },
    {
      id: 'topo-modify',
      label: 'Modify an agent',
      description: 'Propose changes to an agent definition',
      category: 'modify',
      prompt: 'I want to modify an agent',
      icon: 'Pencil',
    },
  ],
  health_check: [
    {
      id: 'health-fix',
      label: 'Fix issues',
      description: 'Address the health check warnings',
      category: 'error-handling',
      prompt: 'Help me fix the health check warnings',
      icon: 'Wrench',
    },
    {
      id: 'health-topo',
      label: 'View topology',
      description: 'See the agent connection graph',
      category: 'topology',
      prompt: 'Show me the project topology',
      icon: 'Network',
    },
    {
      id: 'health-tools',
      label: 'Review tools',
      description: 'Check unresolved or unused tool bindings',
      category: 'feature',
      prompt: 'Diagnose project tool readiness and suggest any tool creation or linking work',
      icon: 'Plug',
    },
  ],
  propose_modification: [
    {
      id: 'mod-test',
      label: 'Test changes',
      description: 'Run a test scenario against the modified agent',
      category: 'testing',
      prompt: 'Run a test against the modified agent',
      icon: 'FlaskConical',
    },
    {
      id: 'mod-health',
      label: 'Recheck health',
      description: "Verify the modification didn't break anything",
      category: 'health',
      prompt: 'Run a health check to verify the changes',
      icon: 'Activity',
    },
  ],
  apply_modification: [
    {
      id: 'apply-health',
      label: 'Verify health',
      description: 'Run a health check after applying changes',
      category: 'health',
      prompt: 'Run a health check to verify everything is healthy',
      icon: 'Activity',
    },
    {
      id: 'apply-topo',
      label: 'View topology',
      description: 'See the updated topology',
      category: 'topology',
      prompt: 'Show me the updated topology',
      icon: 'Network',
    },
  ],
  read_agent: [
    {
      id: 'read-modify',
      label: 'Modify this agent',
      description: 'Propose changes to this agent',
      category: 'modify',
      prompt: 'I want to modify this agent',
      icon: 'Pencil',
    },
    {
      id: 'read-test',
      label: 'Test this agent',
      description: 'Run a test scenario',
      category: 'testing',
      prompt: 'Run a test against this agent',
      icon: 'FlaskConical',
    },
    {
      id: 'read-tools',
      label: 'Check tools',
      description: 'Review declared tools and runtime bindings',
      category: 'feature',
      prompt:
        'Review this agent tool readiness and suggest tool creation only if runtime evidence shows a missing ProjectTool',
      icon: 'Plug',
    },
  ],
  tools_ops: [
    {
      id: 'tool-test',
      label: 'Test tool',
      description: 'Run a sample input against the tool',
      category: 'testing',
      prompt: 'Test this tool with representative input',
      icon: 'FlaskConical',
    },
    {
      id: 'tool-link',
      label: 'Link to agent',
      description: 'Add the tool signature to an agent safely',
      category: 'modify',
      prompt:
        'Link this tool to the right agent using agentToolBlock, then verify project tool diagnostics',
      icon: 'Pencil',
    },
    {
      id: 'tool-auth',
      label: 'Set up auth',
      description: 'Create or select auth before testing this tool',
      category: 'feature',
      prompt:
        'Set up the auth chain for this tool: inspect existing auth profiles, collect secrets securely if needed, then update and test the ProjectTool',
      icon: 'KeyRound',
    },
  ],
  auth_ops: [
    {
      id: 'auth-continue-tool',
      label: 'Continue tool setup',
      description: 'Use this auth profile in a ProjectTool',
      category: 'feature',
      prompt:
        'Continue the tool setup using this auth profile, then test the tool and link the agent signature only after runtime readiness is verified',
      icon: 'Plug',
    },
  ],
  compile_abl: [
    {
      id: 'compile-fix',
      label: 'Fix errors',
      description: 'Address compilation errors',
      category: 'error-handling',
      prompt: 'Help me fix the compilation errors',
      icon: 'Wrench',
    },
    {
      id: 'compile-health',
      label: 'Run health check',
      description: 'Check overall project health',
      category: 'health',
      prompt: 'Run a health check on the project',
      icon: 'Activity',
    },
  ],
};

const DEFAULT_SUGGESTIONS: ArchSuggestion[] = [
  {
    id: 'default-topo',
    label: 'View topology',
    description: 'See the agent connection graph',
    category: 'topology',
    prompt: 'Show me the project topology',
    icon: 'Network',
  },
  {
    id: 'default-health',
    label: 'Run health check',
    description: 'Check all agents for issues',
    category: 'health',
    prompt: 'Run a health check on all agents',
    icon: 'Activity',
  },
  {
    id: 'default-modify',
    label: 'Modify an agent',
    description: 'Propose changes to an agent',
    category: 'modify',
    prompt: 'I want to modify an agent',
    icon: 'Pencil',
  },
];

export function generateSuggestions(
  lastToolName: string | null,
  _lastToolResult: unknown,
  _context: SuggestionContext,
): ArchSuggestion[] {
  if (lastToolName && TOOL_SUGGESTIONS[lastToolName]) {
    return TOOL_SUGGESTIONS[lastToolName];
  }
  return DEFAULT_SUGGESTIONS;
}
