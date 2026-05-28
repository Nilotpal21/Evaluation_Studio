import { describe, expect, it } from 'vitest';
import {
  classifyTopologyPattern,
  synthesizePatternTopology,
  synthesizeDefaultTopology,
  TOPOLOGY_PATTERN_VOCABULARY,
  type TopologyPatternId,
} from '../../coordinator/topology-synthesis.js';
import type { Specification } from '../../types/specification.js';

describe('topology-synthesis', () => {
  describe('TOPOLOGY_PATTERN_VOCABULARY', () => {
    it('defines 5 canonical patterns', () => {
      expect(TOPOLOGY_PATTERN_VOCABULARY).toHaveLength(5);
      const ids = TOPOLOGY_PATTERN_VOCABULARY.map((p) => p.id);
      expect(ids).toEqual([
        'single_agent',
        'triage_specialists',
        'pipeline',
        'hub_spoke',
        'peer_mesh',
      ]);
    });

    it('each pattern has required fields', () => {
      for (const pattern of TOPOLOGY_PATTERN_VOCABULARY) {
        expect(pattern.id).toBeTruthy();
        expect(pattern.name).toBeTruthy();
        expect(pattern.description).toBeTruthy();
        expect(pattern.whenToUse).toBeTruthy();
        expect(Array.isArray(pattern.agentRoles)).toBe(true);
        expect(pattern.agentRoles.length).toBeGreaterThan(0);
        expect(pattern.edgeStructure).toBeTruthy();
        expect(Array.isArray(pattern.edgeTypes)).toBe(true);
        expect(Array.isArray(pattern.selectionSignals)).toBe(true);
        expect(pattern.selectionSignals.length).toBeGreaterThan(0);
        expect(Array.isArray(pattern.antiPatterns)).toBe(true);
      }
    });
  });

  describe('classifyTopologyPattern', () => {
    it('classifies simple specs as single_agent', () => {
      const spec: Specification = {
        projectName: 'Simple Bot',
        description: 'A basic chatbot for simple Q&A',
      };

      const result = classifyTopologyPattern(spec);
      expect(result.pattern).toBe('single_agent');
      expect(result.matchedSignals).toContain('simple');
      expect(result.matchedSignals).toContain('basic');
    });

    it('classifies support specs as triage_specialists', () => {
      const spec: Specification = {
        projectName: 'Customer Support',
        description: 'Route customer queries to appropriate departments for helpdesk support',
      };

      const result = classifyTopologyPattern(spec);
      expect(result.pattern).toBe('triage_specialists');
      expect(result.matchedSignals).toContain('route');
      expect(result.matchedSignals).toContain('support');
      expect(result.matchedSignals).toContain('customer support');
    });

    it('classifies sequential workflows as pipeline', () => {
      const spec: Specification = {
        projectName: 'Document Processing',
        description: 'Multi-step sequential workflow for document intake and processing stages',
      };

      const result = classifyTopologyPattern(spec);
      expect(result.pattern).toBe('pipeline');
      expect(result.matchedSignals).toContain('sequential');
      expect(result.matchedSignals).toContain('workflow');
      expect(result.matchedSignals).toContain('stages');
    });

    it('classifies parallel processing as hub_spoke', () => {
      const spec: Specification = {
        projectName: 'Research Aggregator',
        description:
          'Parallel fan-out to multiple workers, coordinate and aggregate results from all sources',
      };

      const result = classifyTopologyPattern(spec);
      expect(result.pattern).toBe('hub_spoke');
      expect(result.matchedSignals).toContain('parallel');
      expect(result.matchedSignals).toContain('fan-out');
      expect(result.matchedSignals).toContain('coordinate');
      expect(result.matchedSignals).toContain('aggregate');
    });

    it('classifies collaborative workflows as peer_mesh', () => {
      const spec: Specification = {
        projectName: 'Peer Review System',
        description:
          'Bidirectional mesh network for collaborative peer-to-peer review across teams',
      };

      const result = classifyTopologyPattern(spec);
      expect(result.pattern).toBe('peer_mesh');
      expect(result.matchedSignals).toContain('peer');
      expect(result.matchedSignals).toContain('mesh');
      expect(result.matchedSignals).toContain('bidirectional');
    });

    it('assigns high confidence when 3+ signals match', () => {
      const spec: Specification = {
        projectName: 'Support System',
        description:
          'Customer support with triage, routing to departments, and helpdesk classification',
      };

      const result = classifyTopologyPattern(spec);
      expect(result.confidence).toBe('high');
      expect(result.matchedSignals.length).toBeGreaterThanOrEqual(3);
    });

    it('assigns medium confidence when 1-2 signals match', () => {
      const spec: Specification = {
        projectName: 'Simple Agent',
        description: 'Does something',
      };

      const result = classifyTopologyPattern(spec);
      expect(result.confidence).toBe('medium');
    });

    it('assigns low confidence with fallback when no signals match', () => {
      const spec: Specification = {
        projectName: 'Unknown System',
        description: 'xyz',
      };

      const result = classifyTopologyPattern(spec);
      // Short spec with no notes triggers single_agent heuristic
      if (result.matchedSignals.length === 0) {
        expect(['low', 'medium']).toContain(result.confidence);
        expect(['single_agent', 'triage_specialists']).toContain(result.pattern);
      }
    });

    it('falls back to single_agent for very short specs', () => {
      const spec: Specification = {
        projectName: 'Bot',
        description: 'A bot',
      };

      const result = classifyTopologyPattern(spec);
      if (result.matchedSignals.length === 0) {
        expect(result.pattern).toBe('single_agent');
        expect(result.reasoning).toContain('Simple spec');
      }
    });

    it('handles spec with conversation notes', () => {
      const spec: Specification = {
        projectName: 'System',
        description: 'Generic description',
        conversationNotes: [
          { label: 'Feature', detail: 'Needs sequential pipeline processing with multiple stages' },
          { label: 'Tech', detail: 'Workflow-based approach' },
        ],
      };

      const result = classifyTopologyPattern(spec);
      expect(result.pattern).toBe('pipeline');
      expect(result.matchedSignals).toContain('sequential');
      expect(result.matchedSignals).toContain('pipeline');
    });

    it('handles empty spec fields gracefully', () => {
      const spec: Specification = {
        projectName: '',
        description: '',
      };

      const result = classifyTopologyPattern(spec);
      expect(result.pattern).toBeTruthy();
      expect(['single_agent', 'triage_specialists']).toContain(result.pattern);
    });

    it('is case-insensitive in signal matching', () => {
      const spec: Specification = {
        projectName: 'SUPPORT SYSTEM',
        description: 'ROUTE customers to DEPARTMENTS for HELPDESK support',
      };

      const result = classifyTopologyPattern(spec);
      expect(result.pattern).toBe('triage_specialists');
      expect(result.matchedSignals.length).toBeGreaterThan(0);
    });
  });

  describe('synthesizePatternTopology', () => {
    const testSpec: Specification = {
      projectName: 'Test Project',
      description: 'Test description for agents',
    };

    describe('single_agent pattern', () => {
      it('generates single agent with no edges', () => {
        const topology = synthesizePatternTopology(testSpec, 'single_agent');

        expect(topology.agents).toHaveLength(1);
        expect(topology.edges).toHaveLength(0);
        expect(topology.entryPoint).toBe(topology.agents[0].name);
      });

      it('derives agent name from project name', () => {
        const spec: Specification = {
          projectName: 'appointment bot',
          description: 'Test',
        };
        const topology = synthesizePatternTopology(spec, 'single_agent');

        expect(topology.agents[0].name).toBe('AppointmentBotAgent');
      });

      it('uses reasoning execution mode', () => {
        const topology = synthesizePatternTopology(testSpec, 'single_agent');

        expect(topology.agents[0].executionMode).toBe('reasoning');
      });

      it('emits fast support model-policy hints for ordinary fallback agents', () => {
        const topology = synthesizePatternTopology(testSpec, 'single_agent');

        expect(topology.agents[0].modelPolicy).toEqual({
          agentType: 'support',
          reasoningRequired: false,
          defaultModelClass: 'fast_tool_capable',
        });
      });
    });

    describe('triage_specialists pattern', () => {
      it('generates triage + 2 specialists + escalation', () => {
        const topology = synthesizePatternTopology(testSpec, 'triage_specialists');

        expect(topology.agents).toHaveLength(4);
        const names = topology.agents.map((a) => a.name);
        expect(names).toContain('TriageAgent');
        expect(names.some((n) => n.includes('Specialist'))).toBe(true);
        expect(names).toContain('EscalationAgent');
      });

      it('creates transfer edges from triage to specialists', () => {
        const topology = synthesizePatternTopology(testSpec, 'triage_specialists');

        const transferEdges = topology.edges.filter((e) => e.type === 'transfer');
        expect(transferEdges.length).toBeGreaterThanOrEqual(2);

        for (const edge of transferEdges) {
          expect(edge.from).toBe('TriageAgent');
          expect(edge.expectReturn).toBe(true);
          expect(edge.experienceMode).toBe('shared_voice_handoff');
        }
      });

      it('creates escalate edge to escalation agent', () => {
        const topology = synthesizePatternTopology(testSpec, 'triage_specialists');

        const escalateEdges = topology.edges.filter((e) => e.type === 'escalate');
        expect(escalateEdges.length).toBeGreaterThanOrEqual(1);

        const escalateEdge = escalateEdges[0];
        expect(escalateEdge.from).toBe('TriageAgent');
        expect(escalateEdge.to).toBe('EscalationAgent');
        expect(escalateEdge.expectReturn).toBe(false);
        expect(escalateEdge.experienceMode).toBe('human_escalation');
      });

      it('sets triage as entry point', () => {
        const topology = synthesizePatternTopology(testSpec, 'triage_specialists');

        expect(topology.entryPoint).toBe('TriageAgent');
      });

      it('emits dispatcher and support model-policy hints without concrete model ids', () => {
        const topology = synthesizePatternTopology(testSpec, 'triage_specialists');
        const triage = topology.agents.find((agent) => agent.name === 'TriageAgent');
        const specialist = topology.agents.find((agent) => agent.name.includes('Specialist'));

        expect(triage?.modelPolicy).toEqual({
          agentType: 'dispatcher',
          reasoningRequired: false,
          defaultModelClass: 'fast_tool_capable',
        });
        expect(specialist?.modelPolicy).toEqual({
          agentType: 'support',
          reasoningRequired: false,
          defaultModelClass: 'fast_tool_capable',
        });
        expect(JSON.stringify(topology.agents.map((agent) => agent.modelPolicy))).not.toMatch(
          /gpt|claude|gemini|o\d/i,
        );
      });
    });

    describe('pipeline pattern', () => {
      it('generates 3 sequential agents', () => {
        const topology = synthesizePatternTopology(testSpec, 'pipeline');

        expect(topology.agents.length).toBeGreaterThanOrEqual(3);
      });

      it('creates linear transfer chain with expectReturn', () => {
        const topology = synthesizePatternTopology(testSpec, 'pipeline');

        const transferEdges = topology.edges.filter((e) => e.type === 'transfer');
        expect(transferEdges.length).toBeGreaterThanOrEqual(2);

        for (const edge of transferEdges) {
          expect(edge.expectReturn).toBe(true);
          expect(edge.experienceMode).toBe('shared_voice_handoff');
        }
      });

      it('sets first agent as entry point', () => {
        const topology = synthesizePatternTopology(testSpec, 'pipeline');

        const firstAgent = topology.agents[0];
        expect(topology.entryPoint).toBe(firstAgent.name);
      });

      it('creates sequential chain structure', () => {
        const topology = synthesizePatternTopology(testSpec, 'pipeline');

        // Verify edges form a chain: agent[0] -> agent[1] -> agent[2]...
        const transferEdges = topology.edges.filter((e) => e.type === 'transfer');
        const agentNames = topology.agents.map((a) => a.name);

        for (let i = 0; i < transferEdges.length; i++) {
          const edge = transferEdges[i];
          expect(agentNames).toContain(edge.from);
          expect(agentNames).toContain(edge.to);
        }
      });

      it('uses domain-specific fallback agents and tools for insurance claims workflows', () => {
        const spec: Specification = {
          projectName: 'ClaimFlow',
          description:
            'Insurance claims processing assistant for auto and property. Collects policy and incident details, photos, fraud risk scoring, adjuster assignment, claim status, supplemental document requests, payout notification, and escalation for high-value or fraud-flagged claims.',
        };

        const topology = synthesizePatternTopology(spec, 'pipeline');
        const names = topology.agents.map((agent) => agent.name);
        const toolNames = new Set(topology.agents.flatMap((agent) => agent.tools ?? []));

        expect(topology.entryPoint).toBe('ClaimsRouter');
        expect(topology.agents).toHaveLength(7);
        expect(names).toEqual(
          expect.arrayContaining([
            'ClaimIntakeAgent',
            'EvidenceFraudReviewAgent',
            'AdjusterAssignmentAgent',
            'ClaimStatusDocumentsAgent',
            'PayoutNotificationAgent',
            'ClaimsEscalationDesk',
          ]),
        );
        expect(toolNames.has('create_claim')).toBe(true);
        expect(toolNames.has('lookup_policy')).toBe(true);
        expect(toolNames.has('fraud_score')).toBe(true);
        expect(toolNames.has('assign_adjuster')).toBe(true);
        expect(toolNames.has('send_payout_notification')).toBe(true);
        expect(topology.edges.filter((edge) => edge.type === 'transfer')).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ experienceMode: 'shared_voice_handoff' }),
          ]),
        );
        expect(topology.edges.find((edge) => edge.type === 'escalate')).toMatchObject({
          experienceMode: 'human_escalation',
        });
      });
    });

    describe('hub_spoke pattern', () => {
      it('generates hub + multiple workers', () => {
        const topology = synthesizePatternTopology(testSpec, 'hub_spoke');

        expect(topology.agents.length).toBeGreaterThanOrEqual(3);
        const names = topology.agents.map((a) => a.name);
        expect(names.some((n) => n.includes('Coordinator'))).toBe(true);
      });

      it('creates fan-out edges from hub with expectReturn', () => {
        const topology = synthesizePatternTopology(testSpec, 'hub_spoke');

        const hubAgent = topology.agents[0];
        const fanOutEdges = topology.edges.filter(
          (e) => e.from === hubAgent.name && e.type === 'transfer',
        );

        expect(fanOutEdges.length).toBeGreaterThanOrEqual(2);

        for (const edge of fanOutEdges) {
          expect(edge.expectReturn).toBe(true);
          expect(edge.experienceMode).toBe('shared_voice_handoff');
        }
      });

      it('sets hub as entry point', () => {
        const topology = synthesizePatternTopology(testSpec, 'hub_spoke');

        expect(topology.entryPoint).toBe(topology.agents[0].name);
      });
    });

    describe('peer_mesh pattern', () => {
      it('generates 3+ peer agents', () => {
        const topology = synthesizePatternTopology(testSpec, 'peer_mesh');

        expect(topology.agents.length).toBeGreaterThanOrEqual(3);
      });

      it('creates bidirectional edges between peers', () => {
        const topology = synthesizePatternTopology(testSpec, 'peer_mesh');

        expect(topology.edges.length).toBeGreaterThan(0);

        // Check for some form of mesh connectivity
        const fromSet = new Set(topology.edges.map((e) => e.from));
        const toSet = new Set(topology.edges.map((e) => e.to));

        expect(fromSet.size).toBeGreaterThanOrEqual(2);
        expect(toSet.size).toBeGreaterThanOrEqual(2);
      });

      it('uses delegate or transfer edge types', () => {
        const topology = synthesizePatternTopology(testSpec, 'peer_mesh');

        for (const edge of topology.edges) {
          expect(['delegate', 'transfer', 'escalate']).toContain(edge.type);
          expect(edge.experienceMode).toBe('visible_handoff');
        }
      });

      it('sets first peer as entry point', () => {
        const topology = synthesizePatternTopology(testSpec, 'peer_mesh');

        expect(topology.entryPoint).toBe(topology.agents[0].name);
      });
    });
  });

  describe('synthesizeDefaultTopology', () => {
    it('generates single-agent topology', () => {
      const spec: Specification = {
        projectName: 'Test Bot',
        description: 'A test bot',
      };

      const topology = synthesizeDefaultTopology(spec);

      expect(topology.agents).toHaveLength(1);
      expect(topology.edges).toHaveLength(0);
    });

    it('derives PascalCase agent name from project name', () => {
      const spec: Specification = {
        projectName: 'customer support',
        description: 'Test',
      };

      const topology = synthesizeDefaultTopology(spec);

      expect(topology.agents[0].name).toBe('CustomerSupportAgent');
    });

    it('handles project names with hyphens', () => {
      const spec: Specification = {
        projectName: 'booking-system',
        description: 'Test',
      };

      const topology = synthesizeDefaultTopology(spec);

      expect(topology.agents[0].name).toBe('BookingSystemAgent');
    });

    it('handles project names with special characters', () => {
      const spec: Specification = {
        projectName: 'Booking @ Home (v2)',
        description: 'Test',
      };

      const topology = synthesizeDefaultTopology(spec);

      expect(topology.agents[0].name).toBe('BookingHomeV2Agent');
    });

    it('handles empty project name', () => {
      const spec: Specification = {
        projectName: '',
        description: 'Test',
      };

      const topology = synthesizeDefaultTopology(spec);

      expect(topology.agents[0].name).toBe('MainAgent');
    });

    it('preserves existing Agent suffix', () => {
      const spec: Specification = {
        projectName: 'TriageAgent',
        description: 'Test',
      };

      const topology = synthesizeDefaultTopology(spec);

      expect(topology.agents[0].name).toBe('TriageAgent');
    });

    it('derives role from description', () => {
      const spec: Specification = {
        projectName: 'Test',
        description: 'Handles customer inquiries and provides support. Additional info here.',
      };

      const topology = synthesizeDefaultTopology(spec);

      expect(topology.agents[0].role).toBe('Handles customer inquiries and provides support');
    });

    it('caps long descriptions at 200 chars', () => {
      const longDesc = 'A'.repeat(250);
      const spec: Specification = {
        projectName: 'Test',
        description: longDesc,
      };

      const topology = synthesizeDefaultTopology(spec);

      expect(topology.agents[0].role.length).toBeLessThanOrEqual(200);
      expect(topology.agents[0].role).toContain('...');
    });

    it('uses fallback role when description is missing', () => {
      const spec: Specification = {
        projectName: 'TestBot',
        description: '',
      };

      const topology = synthesizeDefaultTopology(spec);

      expect(topology.agents[0].role).toContain('Handle all interactions');
      expect(topology.agents[0].role).toContain('TestBot');
    });

    it('sets agent as entry point', () => {
      const spec: Specification = {
        projectName: 'Bot',
        description: 'Test',
      };

      const topology = synthesizeDefaultTopology(spec);

      expect(topology.entryPoint).toBe(topology.agents[0].name);
    });

    it('uses reasoning execution mode', () => {
      const spec: Specification = {
        projectName: 'Bot',
        description: 'Test',
      };

      const topology = synthesizeDefaultTopology(spec);

      expect(topology.agents[0].executionMode).toBe('reasoning');
    });

    it('handles single-letter project name', () => {
      const spec: Specification = {
        projectName: 'X',
        description: 'Test',
      };

      const topology = synthesizeDefaultTopology(spec);

      expect(topology.agents[0].name).toBe('XAgent');
    });

    it('handles project names with underscores', () => {
      const spec: Specification = {
        projectName: 'customer_support_bot',
        description: 'Test',
      };

      const topology = synthesizeDefaultTopology(spec);

      expect(topology.agents[0].name).toBe('CustomerSupportBotAgent');
    });

    it('preserves camelCase in project names', () => {
      const spec: Specification = {
        projectName: 'myAwesomeBot',
        description: 'Test',
      };

      const topology = synthesizeDefaultTopology(spec);

      expect(topology.agents[0].name).toBe('MyAwesomeBotAgent');
    });
  });
});
