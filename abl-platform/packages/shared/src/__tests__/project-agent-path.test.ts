import { describe, expect, it } from 'vitest';
import { buildProjectAgentPath } from '../project-agent-path.js';

describe('buildProjectAgentPath', () => {
  it('derives the canonical legacy locator from projectId and agent name', () => {
    expect(buildProjectAgentPath('project-1', 'Supervisor')).toBe('project-1/Supervisor');
  });

  it('trims inputs without adding tenant or domain segments', () => {
    expect(buildProjectAgentPath(' project-1 ', ' Agent_A ')).toBe('project-1/Agent_A');
  });

  it('rejects empty identity components', () => {
    expect(() => buildProjectAgentPath('', 'Agent_A')).toThrow('projectId');
    expect(() => buildProjectAgentPath('project-1', '   ')).toThrow('agentName');
  });
});
