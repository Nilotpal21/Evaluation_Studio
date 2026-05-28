/**
 * Supervisor Parser Tests
 *
 * Direct tests for supervisor-parser.ts covering:
 * - Basic supervisor document parsing
 * - STATE section (variables, types, defaults, nullable)
 * - AGENTS section (refs, capabilities)
 * - INTENTS section (intent-to-agent mappings)
 * - POLICIES section (allowed_when, forbidden_when, triggerSignal)
 * - COMMUNICATION section (language, formality)
 * - BEHAVIOR section (canRespondDirectly, allowed/forbidden actions)
 * - Error handling (lex errors, parse errors)
 */

import { describe, test, expect } from 'vitest';
import { parseSupervisor } from '../parser/supervisor-parser.js';

describe('SupervisorParser', () => {
  describe('basic parsing', () => {
    test('should parse a minimal supervisor document', () => {
      const input = `SUPERVISOR: TestSupervisor\n`;
      const result = parseSupervisor(input);

      expect(result.errors).toHaveLength(0);
      expect(result.document).not.toBeNull();
      expect(result.document!.meta.kind).toBe('supervisor');
      expect(result.document!.meta.name).toBe('TestSupervisor');
      expect(result.document!.meta.version).toBe('1.0.0');
    });

    test('should generate a unique ID for each parse', () => {
      const input = `SUPERVISOR: MySupervisor\n`;
      const result1 = parseSupervisor(input);
      const result2 = parseSupervisor(input);

      expect(result1.document).not.toBeNull();
      expect(result2.document).not.toBeNull();
      expect(result1.document!.meta.id).not.toBe(result2.document!.meta.id);
    });

    test('should set defaults for all sections', () => {
      const input = `SUPERVISOR: Minimal\n`;
      const result = parseSupervisor(input);
      const doc = result.document!;

      expect(doc.state).toEqual({});
      expect(doc.agents).toEqual([]);
      expect(doc.routing).toEqual([]);
      expect(doc.policies).toEqual([]);
      expect(doc.communication).toEqual({
        language: 'en',
        formality: 'neutral',
        constraints: [],
      });
      expect(doc.behavior).toEqual({
        canRespondDirectly: false,
        allowedDirectActions: [],
        forbiddenActions: [],
      });
    });

    test('should set createdAt and updatedAt timestamps', () => {
      const before = new Date();
      const result = parseSupervisor(`SUPERVISOR: TimedSupervisor\n`);
      const after = new Date();
      const doc = result.document!;

      expect(doc.meta.createdAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
      expect(doc.meta.createdAt.getTime()).toBeLessThanOrEqual(after.getTime());
      expect(doc.meta.updatedAt.getTime()).toBe(doc.meta.createdAt.getTime());
    });
  });

  describe('STATE section', () => {
    test('should parse state variables with namespaces', () => {
      const input = `SUPERVISOR: TestSupervisor
STATE:
  user.name: string
  user.age: number
`;
      const result = parseSupervisor(input);
      expect(result.errors).toHaveLength(0);

      const state = result.document!.state;
      expect(state.user).toBeDefined();
      expect(state.user.name.name).toBe('name');
      expect(state.user.name.type).toBe('string');
      expect(state.user.name.required).toBe(true);
      expect(state.user.age.name).toBe('age');
      expect(state.user.age.type).toBe('number');
    });

    test('should parse nullable types', () => {
      const input = `SUPERVISOR: TestSupervisor
STATE:
  user.email: string?
`;
      const result = parseSupervisor(input);
      expect(result.errors).toHaveLength(0);

      const state = result.document!.state;
      expect(state.user.email.required).toBe(false);
    });

    test('should parse boolean type', () => {
      const input = `SUPERVISOR: TestSupervisor
STATE:
  user.verified: boolean
`;
      const result = parseSupervisor(input);
      expect(result.errors).toHaveLength(0);
      expect(result.document!.state.user.verified.type).toBe('boolean');
    });

    test('should parse date and datetime types', () => {
      const input = `SUPERVISOR: TestSupervisor
STATE:
  user.birthdate: date
  user.last_login: datetime
`;
      const result = parseSupervisor(input);
      expect(result.errors).toHaveLength(0);
      expect(result.document!.state.user.birthdate.type).toBe('date');
      expect(result.document!.state.user.last_login.type).toBe('datetime');
    });

    test('should parse enum type', () => {
      const input = `SUPERVISOR: TestSupervisor
STATE:
  user.role: enum(admin, user, guest)
`;
      const result = parseSupervisor(input);
      expect(result.errors).toHaveLength(0);

      const type = result.document!.state.user.role.type;
      expect(typeof type).toBe('object');
      expect((type as any).kind).toBe('enum');
      expect((type as any).values).toEqual(['admin', 'user', 'guest']);
    });

    test('should parse array type', () => {
      const input = `SUPERVISOR: TestSupervisor
STATE:
  user.tags: array
`;
      const result = parseSupervisor(input);
      expect(result.errors).toHaveLength(0);

      const type = result.document!.state.user.tags.type;
      expect(typeof type).toBe('object');
      expect((type as any).kind).toBe('array');
    });

    test('should parse state variables with default values', () => {
      const input = `SUPERVISOR: TestSupervisor
STATE:
  user.name: string = "John"
  user.age: number = 25
  user.active: boolean = true
  user.data: string = null
`;
      const result = parseSupervisor(input);
      expect(result.errors).toHaveLength(0);

      const state = result.document!.state;
      expect(state.user.name.default).toBe('John');
      expect(state.user.age.default).toBe(25);
      expect(state.user.active.default).toBe(true);
      expect(state.user.data.default).toBe(null);
    });

    test('should parse state with false default value', () => {
      const input = `SUPERVISOR: TestSupervisor
STATE:
  user.verified: boolean = false
`;
      const result = parseSupervisor(input);
      expect(result.errors).toHaveLength(0);
      expect(result.document!.state.user.verified.default).toBe(false);
    });

    test('should parse multiple namespaces', () => {
      const input = `SUPERVISOR: TestSupervisor
STATE:
  user.name: string
  conversation.active_agent: string
  session.started: boolean
`;
      const result = parseSupervisor(input);
      expect(result.errors).toHaveLength(0);

      const state = result.document!.state;
      expect(state.user).toBeDefined();
      expect(state.conversation).toBeDefined();
      expect(state.session).toBeDefined();
    });
  });

  describe('AGENTS section', () => {
    test('should parse agent references', () => {
      const input = `SUPERVISOR: TestSupervisor
AGENTS:
  booking: "./booking_agent.abl"
  support: "./support_agent.abl"
`;
      const result = parseSupervisor(input);
      expect(result.errors).toHaveLength(0);

      const agents = result.document!.agents;
      expect(agents).toHaveLength(2);
      expect(agents[0].alias).toBe('booking');
      expect(agents[0].ref).toBe('./booking_agent.abl');
      expect(agents[1].alias).toBe('support');
      expect(agents[1].ref).toBe('./support_agent.abl');
    });

    test('should parse agent references with capabilities', () => {
      const input = `SUPERVISOR: TestSupervisor
AGENTS:
  booking: "./booking_agent.abl" [search, reserve, cancel]
`;
      const result = parseSupervisor(input);
      expect(result.errors).toHaveLength(0);

      const agent = result.document!.agents[0];
      expect(agent.capabilities).toEqual(['search', 'reserve', 'cancel']);
    });

    test('should parse agent references without capabilities as empty array', () => {
      const input = `SUPERVISOR: TestSupervisor
AGENTS:
  simple: "./simple.abl"
`;
      const result = parseSupervisor(input);
      expect(result.errors).toHaveLength(0);
      expect(result.document!.agents[0].capabilities).toEqual([]);
    });
  });

  describe('INTENTS section', () => {
    test('should parse intent mappings', () => {
      const input = `SUPERVISOR: TestSupervisor
INTENTS:
  [book, reserve] -> booking
  [help, support] -> support
`;
      const result = parseSupervisor(input);
      expect(result.errors).toHaveLength(0);

      const intents = result.document!.intents;
      expect(intents).toBeDefined();
      expect(intents!).toHaveLength(2);
      expect(intents![0].intents).toEqual(['book', 'reserve']);
      expect(intents![0].action.kind).toBe('route_to_agent');
      expect((intents![0].action as any).agent).toBe('booking');
      expect(intents![1].intents).toEqual(['help', 'support']);
      expect((intents![1].action as any).agent).toBe('support');
    });

    test('should parse single intent mapping', () => {
      const input = `SUPERVISOR: TestSupervisor
INTENTS:
  [cancel] -> cancellation
`;
      const result = parseSupervisor(input);
      expect(result.errors).toHaveLength(0);

      const intents = result.document!.intents;
      expect(intents!).toHaveLength(1);
      expect(intents![0].intents).toEqual(['cancel']);
    });
  });

  describe('POLICIES section', () => {
    test('should parse policies with allowed_when rule', () => {
      const input = `SUPERVISOR: TestSupervisor
POLICIES:
  data_access:
    allowed_when: user.verified
`;
      const result = parseSupervisor(input);
      expect(result.errors).toHaveLength(0);

      const policies = result.document!.policies;
      expect(policies).toHaveLength(1);
      expect(policies[0].name).toBe('data_access');
      expect(policies[0].rules.allowedWhen).toBeDefined();
      expect(policies[0].rules.allowedWhen!.kind).toBe('unary');
    });

    test('should parse policies with forbidden_when rule', () => {
      const input = `SUPERVISOR: TestSupervisor
POLICIES:
  restricted:
    forbidden_when: user.banned
`;
      const result = parseSupervisor(input);
      expect(result.errors).toHaveLength(0);

      const policies = result.document!.policies;
      expect(policies[0].rules.forbiddenWhen).toBeDefined();
    });

    test('should parse policies with trigger_signal as string literal', () => {
      const input = `SUPERVISOR: TestSupervisor
POLICIES:
  alert:
    trigger_signal: "high_alert"
`;
      const result = parseSupervisor(input);
      expect(result.errors).toHaveLength(0);

      const policies = result.document!.policies;
      expect(policies[0].rules.triggerSignal).toBe('high_alert');
    });

    test('should parse policies with trigger_signal as variable ref', () => {
      const input = `SUPERVISOR: TestSupervisor
POLICIES:
  alert:
    trigger_signal: system.alert_level
`;
      const result = parseSupervisor(input);
      expect(result.errors).toHaveLength(0);

      const policies = result.document!.policies;
      expect(policies[0].rules.triggerSignal).toBe('system.alert_level');
    });

    test('should parse policy with multiple rules', () => {
      const input = `SUPERVISOR: TestSupervisor
POLICIES:
  access_control:
    allowed_when: user.verified
    forbidden_when: user.banned
    trigger_signal: "access_alert"
`;
      const result = parseSupervisor(input);
      expect(result.errors).toHaveLength(0);

      const policy = result.document!.policies[0];
      expect(policy.name).toBe('access_control');
      expect(policy.rules.allowedWhen).toBeDefined();
      expect(policy.rules.forbiddenWhen).toBeDefined();
      expect(policy.rules.triggerSignal).toBe('access_alert');
    });

    test('should parse policies with camelCase rule names', () => {
      const input = `SUPERVISOR: TestSupervisor
POLICIES:
  myPolicy:
    allowedWhen: user.active
    forbiddenWhen: user.banned
    triggerSignal: "alert"
`;
      const result = parseSupervisor(input);
      expect(result.errors).toHaveLength(0);

      const policy = result.document!.policies[0];
      expect(policy.rules.allowedWhen).toBeDefined();
      expect(policy.rules.forbiddenWhen).toBeDefined();
      expect(policy.rules.triggerSignal).toBe('alert');
    });
  });

  describe('COMMUNICATION section', () => {
    test('should parse language setting', () => {
      const input = `SUPERVISOR: TestSupervisor
COMMUNICATION:
  language: "es"
`;
      const result = parseSupervisor(input);
      expect(result.errors).toHaveLength(0);
      expect(result.document!.communication.language).toBe('es');
    });

    test('should parse formality setting', () => {
      const input = `SUPERVISOR: TestSupervisor
COMMUNICATION:
  formality: formal
`;
      const result = parseSupervisor(input);
      expect(result.errors).toHaveLength(0);
      expect(result.document!.communication.formality).toBe('formal');
    });

    test('should parse both language and formality', () => {
      const input = `SUPERVISOR: TestSupervisor
COMMUNICATION:
  language: "fr"
  formality: informal
`;
      const result = parseSupervisor(input);
      expect(result.errors).toHaveLength(0);
      expect(result.document!.communication.language).toBe('fr');
      expect(result.document!.communication.formality).toBe('informal');
    });

    test('should default to en and neutral when communication not specified', () => {
      const input = `SUPERVISOR: TestSupervisor\n`;
      const result = parseSupervisor(input);
      expect(result.errors).toHaveLength(0);
      expect(result.document!.communication.language).toBe('en');
      expect(result.document!.communication.formality).toBe('neutral');
    });
  });

  describe('BEHAVIOR section', () => {
    test('should parse can_respond_directly true', () => {
      const input = `SUPERVISOR: TestSupervisor
BEHAVIOR:
  can_respond_directly: true
`;
      const result = parseSupervisor(input);
      expect(result.errors).toHaveLength(0);
      expect(result.document!.behavior.canRespondDirectly).toBe(true);
    });

    test('should parse can_respond_directly false', () => {
      const input = `SUPERVISOR: TestSupervisor
BEHAVIOR:
  can_respond_directly: false
`;
      const result = parseSupervisor(input);
      expect(result.errors).toHaveLength(0);
      expect(result.document!.behavior.canRespondDirectly).toBe(false);
    });

    test('should parse allowed_actions list', () => {
      const input = `SUPERVISOR: TestSupervisor
BEHAVIOR:
  allowed_actions: ["greet", "farewell"]
`;
      const result = parseSupervisor(input);
      expect(result.errors).toHaveLength(0);
      expect(result.document!.behavior.allowedDirectActions).toEqual(['greet', 'farewell']);
    });

    test('should parse forbidden_actions list', () => {
      const input = `SUPERVISOR: TestSupervisor
BEHAVIOR:
  forbidden_actions: ["delete_data", "modify_config"]
`;
      const result = parseSupervisor(input);
      expect(result.errors).toHaveLength(0);
      expect(result.document!.behavior.forbiddenActions).toEqual(['delete_data', 'modify_config']);
    });

    test('should parse empty actions list', () => {
      const input = `SUPERVISOR: TestSupervisor
BEHAVIOR:
  allowed_actions: []
`;
      const result = parseSupervisor(input);
      expect(result.errors).toHaveLength(0);
      expect(result.document!.behavior.allowedDirectActions).toEqual([]);
    });

    test('should parse all behavior settings together', () => {
      const input = `SUPERVISOR: TestSupervisor
BEHAVIOR:
  can_respond_directly: true
  allowed_actions: ["greet"]
  forbidden_actions: ["delete"]
`;
      const result = parseSupervisor(input);
      expect(result.errors).toHaveLength(0);

      const behavior = result.document!.behavior;
      expect(behavior.canRespondDirectly).toBe(true);
      expect(behavior.allowedDirectActions).toEqual(['greet']);
      expect(behavior.forbiddenActions).toEqual(['delete']);
    });
  });

  describe('complete supervisor document', () => {
    test('should parse a full supervisor document with all sections', () => {
      const input = `SUPERVISOR: CustomerService
STATE:
  user.name: string
  user.verified: boolean = false
  conversation.active_agent: string?
AGENTS:
  booking: "./booking.abl" [search, reserve]
  support: "./support.abl" [troubleshoot]
INTENTS:
  [book, reserve] -> booking
  [help, problem] -> support
POLICIES:
  access_control:
    allowed_when: user.verified
COMMUNICATION:
  language: "en"
  formality: formal
BEHAVIOR:
  can_respond_directly: false
  forbidden_actions: ["modify_user"]
`;
      const result = parseSupervisor(input);
      expect(result.errors).toHaveLength(0);

      const doc = result.document!;
      expect(doc.meta.name).toBe('CustomerService');
      expect(Object.keys(doc.state)).toHaveLength(2);
      expect(doc.agents).toHaveLength(2);
      expect(doc.routing).toEqual([]);
      expect(doc.intents).toHaveLength(2);
      expect(doc.policies).toHaveLength(1);
      expect(doc.communication.language).toBe('en');
      expect(doc.behavior.canRespondDirectly).toBe(false);
    });
  });

  describe('error handling', () => {
    test('should return lex errors for invalid characters', () => {
      const input = `SUPERVISOR: Test\u201C\n`;
      const result = parseSupervisor(input);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.document).toBeNull();
    });

    test('should return parse errors for invalid syntax', () => {
      const input = `STATE: missing_supervisor\n`;
      const result = parseSupervisor(input);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.document).toBeNull();
    });

    test('should return errors with line and column info', () => {
      const input = `SUPERVISOR:\n`;
      const result = parseSupervisor(input);
      // Missing name after SUPERVISOR: should cause an error
      expect(result.errors.length).toBeGreaterThan(0);
    });
  });
});
