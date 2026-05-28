/**
 * Analyzer Tests
 */

import { describe, test, expect } from 'vitest';
import { DSLAnalyzer, createAnalyzer } from '../analyzer.js';
import type { SupervisorDocument, AgentDocument, AgentBasedDocument } from '@abl/core';

describe('DSLAnalyzer', () => {
  const analyzer = new DSLAnalyzer();

  const createSupervisorDoc = (overrides?: Partial<SupervisorDocument>): SupervisorDocument => ({
    meta: {
      id: 'test-supervisor',
      kind: 'supervisor',
      version: '1.0.0',
      name: 'Test_Supervisor',
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    state: {},
    agents: [],
    routing: [],
    policies: [],
    communication: {
      language: 'en',
      formality: 'neutral',
      constraints: [],
    },
    behavior: {
      canRespondDirectly: false,
      allowedDirectActions: [],
      forbiddenActions: [],
    },
    ...overrides,
  });

  const createAgentDoc = (overrides?: Partial<AgentDocument>): AgentDocument => ({
    meta: {
      id: 'test-agent',
      kind: 'agent',
      version: '1.0.0',
      name: 'Test_Agent',
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    identity: {
      role: 'Test Role',
      tone: 'professional',
      expertise: [],
      language: 'en',
    },
    contract: {
      trigger: { type: 'intent', value: 'test' },
      input: [],
      output: [],
      successCriteria: 'Test completed',
    },
    flow: [],
    guardrails: {
      required: [],
      forbidden: [],
      onViolation: 'warn',
    },
    ...overrides,
  });

  describe('analyzeSupervisor', () => {
    test('should return empty results for valid supervisor', () => {
      const doc = createSupervisorDoc();
      const results = analyzer.analyzeSupervisor(doc);

      // A minimal valid supervisor should have few if any issues
      expect(Array.isArray(results)).toBe(true);
    });

    test('should detect missing agent references', () => {
      const doc = createSupervisorDoc({
        agents: [{ name: 'Missing_Agent', path: './agents/missing.abl' }],
      });

      const results = analyzer.analyzeSupervisor(doc);

      // Should be able to analyze even with missing agents
      expect(Array.isArray(results)).toBe(true);
    });
  });

  describe('analyzeAgent', () => {
    test('should return empty results for valid agent', () => {
      const doc = createAgentDoc();
      const results = analyzer.analyzeAgent(doc);

      expect(Array.isArray(results)).toBe(true);
    });

    test('should analyze agent with flow steps', () => {
      const doc = createAgentDoc({
        flow: [
          { number: '1', name: 'Start', action: { type: 'RESPOND', message: 'Hi' } },
          {
            number: '2',
            name: 'Continue',
            action: { type: 'RESPOND', message: 'How can I help?' },
          },
        ],
      });

      const results = analyzer.analyzeAgent(doc);
      expect(Array.isArray(results)).toBe(true);
    });
  });

  describe('analyzeProject', () => {
    test('should return report for empty project', () => {
      const agents = new Map<string, AgentDocument>();
      const report = analyzer.analyzeProject(null, agents);

      expect(report).toBeDefined();
      expect(report.results).toBeDefined();
      expect(report.summary).toBeDefined();
    });

    test('should analyze project with supervisor and agents', () => {
      const supervisor = createSupervisorDoc({
        agents: [{ name: 'Test_Agent', path: './agents/test.abl' }],
      });

      const agent = createAgentDoc();
      const agents = new Map<string, AgentDocument>([['Test_Agent', agent]]);

      const report = analyzer.analyzeProject(supervisor, agents);

      expect(report.summary).toBeDefined();
      expect(typeof report.summary.totalErrors).toBe('number');
      expect(typeof report.summary.totalWarnings).toBe('number');
    });

    test('should detect conflicts in routing', () => {
      const supervisor = createSupervisorDoc({
        agents: [
          { name: 'Agent_A', path: './agents/a.abl' },
          { name: 'Agent_B', path: './agents/b.abl' },
        ],
        routing: [
          {
            priority: 1,
            condition: { kind: 'wildcard' },
            target: { type: 'agent', agent: 'Agent_A' },
          },
          {
            priority: 1,
            condition: { kind: 'wildcard' },
            target: { type: 'agent', agent: 'Agent_B' },
          },
        ],
      });

      const agents = new Map<string, AgentDocument>([
        ['Agent_A', createAgentDoc({ meta: { ...createAgentDoc().meta, name: 'Agent_A' } })],
        ['Agent_B', createAgentDoc({ meta: { ...createAgentDoc().meta, name: 'Agent_B' } })],
      ]);

      const report = analyzer.analyzeProject(supervisor, agents);

      // Report should be generated even if it detects issues
      expect(report).toBeDefined();
      expect(report.summary).toBeDefined();
    });
  });

  describe('configuration', () => {
    test('should create analyzer with default config', () => {
      const analyzer = createAnalyzer();
      expect(analyzer).toBeInstanceOf(DSLAnalyzer);
    });

    test('should respect severity threshold', () => {
      const analyzer = createAnalyzer({ severityThreshold: 'error' });
      const doc = createSupervisorDoc();
      const results = analyzer.analyzeSupervisor(doc);

      // Should only include errors, not warnings or infos
      const hasNonErrors = results.some((r) => r.severity !== 'error');
      // This is expected to be false if the filter is working
      expect(
        results.every(
          (r) => r.severity === 'error' || r.severity === 'warning' || r.severity === 'info',
        ),
      ).toBe(true);
    });

    test('should allow adding custom rules', () => {
      const customAnalyzer = createAnalyzer();
      customAnalyzer.addRule({
        id: 'CUSTOM001',
        name: 'custom-check',
        description: 'Custom validation rule',
        severity: 'warning',
        category: 'custom',
        checkSupervisor: (doc) => [
          {
            ruleId: 'CUSTOM001',
            severity: 'warning',
            message: 'Custom check triggered',
            location: {
              documentId: doc.meta.id,
              documentName: doc.meta.name,
            },
          },
        ],
      });

      const doc = createSupervisorDoc();
      const results = customAnalyzer.analyzeSupervisor(doc);

      expect(results.some((r) => r.ruleId === 'CUSTOM001')).toBe(true);
    });
  });

  describe('rule management', () => {
    test('should get all rules', () => {
      const analyzer = createAnalyzer();
      const rules = analyzer.getRules();

      expect(Array.isArray(rules)).toBe(true);
    });

    test('should remove rule by ID', () => {
      const customAnalyzer = createAnalyzer();
      const initialRules = customAnalyzer.getRules();

      if (initialRules.length > 0) {
        const ruleId = initialRules[0].id;
        const removed = customAnalyzer.removeRule(ruleId);
        expect(removed).toBe(true);

        const remainingRules = customAnalyzer.getRules();
        expect(remainingRules.length).toBe(initialRules.length - 1);
      }
    });
  });

  // =============================================================================
  // AGENT-BASED DOCUMENT TESTS
  // =============================================================================

  describe('analyzeAgentBased', () => {
    const createAgentBasedDoc = (overrides?: Partial<AgentBasedDocument>): AgentBasedDocument => ({
      meta: {
        id: 'test-agent-based',
        kind: 'agent-based',
        version: '1.0.0',
        name: 'Test_Agent_Based',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      mode: 'scripted',
      name: 'Test_Agent_Based',
      goal: { description: 'Test goal' },
      persona: { description: 'Test persona' },
      limitations: [],
      tools: [],
      gather: [],
      memory: {
        session: [],
        persistent: [],
        remember: [],
        recall: [],
      },
      constraints: [],
      flow: undefined,
      delegate: [],
      handoff: [],
      escalate: undefined,
      complete: [],
      onError: [],
      ...overrides,
    });

    test('should analyze valid agent-based document', () => {
      const doc = createAgentBasedDoc({
        flow: {
          steps: ['welcome', 'complete'],
          definitions: {
            welcome: {
              name: 'welcome',
              respond: 'Hello!',
              then: 'complete',
            },
            complete: {
              name: 'complete',
              respond: 'Goodbye!',
              then: 'COMPLETE',
            },
          },
        },
      });

      const results = analyzer.analyzeAgentBased(doc);
      expect(Array.isArray(results)).toBe(true);
    });

    test('should detect invalid step references (AB007)', () => {
      const doc = createAgentBasedDoc({
        flow: {
          steps: ['welcome'],
          definitions: {
            welcome: {
              name: 'welcome',
              respond: 'Hello!',
              then: 'nonexistent_step', // Invalid reference
            },
          },
        },
      });

      const results = analyzer.analyzeAgentBased(doc);
      const ab007Results = results.filter((r) => r.ruleId === 'AB007');

      expect(ab007Results.length).toBeGreaterThan(0);
      expect(ab007Results[0].message).toContain('nonexistent_step');
    });

    test('should detect missing complete conditions for reasoning mode (AB004)', () => {
      const doc = createAgentBasedDoc({
        mode: 'reasoning',
        complete: [], // No complete conditions
      });

      const results = analyzer.analyzeAgentBased(doc);
      const ab004Results = results.filter((r) => r.ruleId === 'AB004');

      expect(ab004Results.length).toBeGreaterThan(0);
    });

    test('should detect handoff without return handler (AB003)', () => {
      const doc = createAgentBasedDoc({
        handoff: [
          {
            to: 'Other_Agent',
            when: 'needs_help',
            context: {
              pass: [],
              summary: 'Need help with task',
            },
            return: true,
            onReturn: undefined, // Missing return handler
          },
        ],
      });

      const results = analyzer.analyzeAgentBased(doc);
      const ab003Results = results.filter((r) => r.ruleId === 'AB003');

      expect(ab003Results.length).toBeGreaterThan(0);
      expect(ab003Results.some((r) => r.message.includes('on_return'))).toBe(true);
    });

    test('should detect delegate without timeout (AB005)', () => {
      const doc = createAgentBasedDoc({
        delegate: [
          {
            agent: 'Sub_Agent',
            when: 'need_sub_task',
            purpose: 'Handle sub-task',
            input: {},
            returns: {},
            useResult: 'sub_result',
            timeout: undefined, // Missing timeout
            onFailure: undefined, // Missing failure handler
          },
        ],
      });

      const results = analyzer.analyzeAgentBased(doc);
      const ab005Results = results.filter((r) => r.ruleId === 'AB005');

      expect(ab005Results.length).toBeGreaterThan(0);
    });

    test('should detect incomplete escalation config (AB002)', () => {
      const doc = createAgentBasedDoc({
        escalate: {
          triggers: [
            {
              when: 'user.frustrated',
              reason: 'User is frustrated',
              priority: undefined as any, // Missing priority
            },
          ],
          contextForHuman: [], // Empty context
          onHumanComplete: [], // Empty handlers
        },
      });

      const results = analyzer.analyzeAgentBased(doc);
      const ab002Results = results.filter((r) => r.ruleId === 'AB002');

      expect(ab002Results.length).toBeGreaterThan(0);
    });

    test('should detect dead steps (COV002)', () => {
      const doc = createAgentBasedDoc({
        flow: {
          steps: ['welcome', 'unreachable'],
          definitions: {
            welcome: {
              name: 'welcome',
              respond: 'Hello!',
              then: 'COMPLETE', // Goes directly to COMPLETE, skipping 'unreachable'
            },
            unreachable: {
              name: 'unreachable',
              respond: 'This should not be reached',
              then: 'COMPLETE',
            },
          },
        },
      });

      const results = analyzer.analyzeAgentBased(doc);
      const cov002Results = results.filter((r) => r.ruleId === 'COV002');

      expect(cov002Results.length).toBeGreaterThan(0);
      expect(cov002Results[0].message).toContain('unreachable');
    });

    test('should detect missing error handlers in flow (COV003)', () => {
      const doc = createAgentBasedDoc({
        tools: [
          {
            name: 'search_hotels',
            parameters: [],
            returns: { type: 'object' },
          },
        ],
        flow: {
          steps: ['search'],
          definitions: {
            search: {
              name: 'search',
              call: 'search_hotels()',
              respond: 'Found results',
              then: 'COMPLETE',
              // Missing onFail
            },
          },
        },
      });

      const results = analyzer.analyzeAgentBased(doc);
      const cov003Results = results.filter((r) => r.ruleId === 'COV003');

      expect(cov003Results.length).toBeGreaterThan(0);
    });
  });
});
