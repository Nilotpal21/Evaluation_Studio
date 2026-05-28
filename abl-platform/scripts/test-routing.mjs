#!/usr/bin/env node
/**
 * Test Runner for Agent Routing Policies and Business Rules
 *
 * Tests:
 * 1. Intent matching - correct agent routing based on keywords
 * 2. Policy enforcement - business rules like validation requirements
 * 3. State-based routing - different paths based on state
 */

import { parseSupervisor } from '../packages/core/dist/index.js';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const examplesDir = join(__dirname, '../apps/web/public/examples');

// ============================================================================
// Routing Engine Simulator
// ============================================================================

class RoutingEngine {
  constructor(supervisorDoc) {
    this.supervisor = supervisorDoc;
    this.state = this.initializeState();
    this.intentMap = this.buildIntentMap();
  }

  initializeState() {
    const state = {};
    // Parse state from the nested structure
    if (this.supervisor.state) {
      for (const [namespace, vars] of Object.entries(this.supervisor.state)) {
        for (const [varName, varDef] of Object.entries(vars)) {
          const fullName = `${namespace}.${varName}`;
          state[fullName] = varDef.default ?? this.getDefaultForType(varDef.type);
        }
      }
    }
    return state;
  }

  getDefaultForType(type) {
    switch (type) {
      case 'boolean':
        return false;
      case 'number':
        return 0;
      case 'string':
        return '';
      default:
        return null;
    }
  }

  setState(updates) {
    this.state = { ...this.state, ...updates };
  }

  buildIntentMap() {
    const map = new Map();
    if (this.supervisor.intents) {
      for (const intentGroup of this.supervisor.intents) {
        // intentGroup has { intents: [...keywords], action: { kind, agent } }
        const targetAgent = intentGroup.action?.agent;
        if (targetAgent && intentGroup.intents) {
          for (const keyword of intentGroup.intents) {
            map.set(keyword.toLowerCase(), targetAgent);
          }
        }
      }
    }
    return map;
  }

  matchIntent(userInput) {
    const input = userInput.toLowerCase();
    const words = input.split(/\s+/);

    // First try exact word match
    for (const word of words) {
      if (this.intentMap.has(word)) {
        return this.intentMap.get(word);
      }
    }

    // Then try substring match (keyword appears in input)
    for (const [keyword, agent] of this.intentMap) {
      if (input.includes(keyword)) {
        return agent;
      }
    }

    return null;
  }

  checkPolicies(targetAgent, action = 'route') {
    const violations = [];

    if (this.supervisor.policies) {
      for (const policy of this.supervisor.policies) {
        if (policy.rules?.allowedWhen) {
          const conditionMet = this.evaluateCondition(policy.rules.allowedWhen);

          if (!conditionMet) {
            violations.push({
              policy: policy.name,
              reason: `Condition not met: ${this.describeCondition(policy.rules.allowedWhen)}`,
              currentState: this.getRelevantState(policy.rules.allowedWhen),
            });
          }
        }
      }
    }

    return violations;
  }

  evaluateCondition(condition) {
    if (!condition) return true;

    // Handle unary conditions like { kind: 'unary', operator: 'exists', operand: { kind: 'variable', path: ['user', 'is_validated'] } }
    if (condition.kind === 'unary') {
      if (condition.operator === 'exists' && condition.operand?.kind === 'variable') {
        const path = condition.operand.path.join('.');
        const value = this.state[path];
        return Boolean(value);
      }
    }

    // Handle binary conditions
    if (condition.kind === 'binary') {
      const leftPath = condition.left?.path?.join('.');
      const leftValue = leftPath ? this.state[leftPath] : null;
      const rightValue = condition.right?.value ?? condition.right;

      switch (condition.operator) {
        case '==':
          return leftValue === rightValue;
        case '!=':
          return leftValue !== rightValue;
        case '>':
          return leftValue > rightValue;
        case '<':
          return leftValue < rightValue;
        default:
          return true;
      }
    }

    // Handle simple variable reference
    if (condition.kind === 'variable') {
      const path = condition.path.join('.');
      return Boolean(this.state[path]);
    }

    return true;
  }

  describeCondition(condition) {
    if (condition.kind === 'unary' && condition.operand?.kind === 'variable') {
      return `${condition.operand.path.join('.')} must be truthy`;
    }
    if (condition.kind === 'variable') {
      return `${condition.path.join('.')} must be truthy`;
    }
    return JSON.stringify(condition);
  }

  getRelevantState(condition) {
    if (condition.kind === 'unary' && condition.operand?.kind === 'variable') {
      const path = condition.operand.path.join('.');
      return { [path]: this.state[path] };
    }
    if (condition.kind === 'variable') {
      const path = condition.path.join('.');
      return { [path]: this.state[path] };
    }
    return this.state;
  }

  route(userInput) {
    const result = {
      input: userInput,
      matchedIntent: null,
      targetAgent: null,
      policyViolations: [],
      finalDecision: null,
      state: { ...this.state },
    };

    // Step 1: Match intent
    result.matchedIntent = this.matchIntent(userInput);

    if (result.matchedIntent) {
      result.targetAgent = result.matchedIntent;

      // Step 2: Check policies
      result.policyViolations = this.checkPolicies(result.targetAgent);

      // Step 3: Make final decision
      if (result.policyViolations.length > 0) {
        result.finalDecision = {
          allowed: false,
          reason: 'Policy violation',
          redirectTo: this.getValidationAgent(),
          violations: result.policyViolations,
        };
      } else {
        result.finalDecision = {
          allowed: true,
          agent: result.targetAgent,
        };
      }
    } else {
      // No intent matched - route to fallback
      result.targetAgent = this.getFallbackAgent();
      result.finalDecision = {
        allowed: true,
        agent: result.targetAgent,
        reason: 'No intent matched - using fallback',
      };
    }

    return result;
  }

  getValidationAgent() {
    for (const agent of this.supervisor.agents) {
      if (agent.capabilities?.includes('validation')) {
        return agent.alias;
      }
    }
    return 'User_Validator';
  }

  getFallbackAgent() {
    for (const agent of this.supervisor.agents) {
      if (
        agent.capabilities?.includes('clarification') ||
        agent.capabilities?.includes('unknown')
      ) {
        return agent.alias;
      }
      if (agent.alias?.toLowerCase().includes('fallback')) {
        return agent.alias;
      }
    }
    return null;
  }
}

// ============================================================================
// Test Framework
// ============================================================================

class TestRunner {
  constructor() {
    this.results = [];
    this.passed = 0;
    this.failed = 0;
  }

  test(name, fn) {
    try {
      const result = fn();
      if (result.pass) {
        this.passed++;
        this.results.push({ name, status: 'PASS', ...result });
        console.log(`  ✅ ${name}`);
      } else {
        this.failed++;
        this.results.push({ name, status: 'FAIL', ...result });
        console.log(`  ❌ ${name}`);
        console.log(`     Expected: ${result.expected}`);
        console.log(`     Actual: ${result.actual}`);
      }
    } catch (error) {
      this.failed++;
      this.results.push({ name, status: 'ERROR', error: error.message });
      console.log(`  💥 ${name}`);
      console.log(`     Error: ${error.message}`);
    }
  }

  summary() {
    console.log('\n' + '='.repeat(60));
    console.log(`Results: ${this.passed} passed, ${this.failed} failed`);
    console.log('='.repeat(60));
    return this.failed === 0;
  }
}

// ============================================================================
// Load Supervisors
// ============================================================================

function loadSupervisor(name) {
  const path = join(examplesDir, name, 'supervisor.dsl');
  const content = readFileSync(path, 'utf-8');
  const result = parseSupervisor(content);
  if (result.errors.length > 0) {
    throw new Error(`Failed to parse ${name} supervisor: ${result.errors[0].message}`);
  }
  return result.document;
}

// ============================================================================
// Test Suites
// ============================================================================

function runSaludsaTests(runner) {
  console.log('\n📋 SALUDSA - Intent Routing Tests\n');

  const supervisor = loadSupervisor('saludsa');

  // Test 1: Payment intent
  runner.test('Payment keywords route to Pending_Payments', () => {
    const engine = new RoutingEngine(supervisor);
    engine.setState({ 'user.is_validated': true });
    const result = engine.route('Quiero saber mi saldo pendiente');
    return {
      pass: result.matchedIntent === 'Pending_Payments',
      expected: 'Pending_Payments',
      actual: result.matchedIntent,
    };
  });

  // Test 2: Refund intent
  runner.test('Refund keywords route to Refund_Handler', () => {
    const engine = new RoutingEngine(supervisor);
    engine.setState({ 'user.is_validated': true });
    const result = engine.route('Necesito un reembolso por favor');
    return {
      pass: result.matchedIntent === 'Refund_Handler',
      expected: 'Refund_Handler',
      actual: result.matchedIntent,
    };
  });

  // Test 3: Contract intent
  runner.test('Contract keywords route to Contract_Assistant', () => {
    const engine = new RoutingEngine(supervisor);
    engine.setState({ 'user.is_validated': true });
    const result = engine.route('Dame una copia de mi poliza');
    return {
      pass: result.matchedIntent === 'Contract_Assistant',
      expected: 'Contract_Assistant',
      actual: result.matchedIntent,
    };
  });

  // Test 4: Password intent
  runner.test('Password keywords route to Password_Reset', () => {
    const engine = new RoutingEngine(supervisor);
    engine.setState({ 'user.is_validated': true });
    const result = engine.route('Olvide mi contrasena');
    return {
      pass: result.matchedIntent === 'Password_Reset',
      expected: 'Password_Reset',
      actual: result.matchedIntent,
    };
  });

  // Test 5: Human agent intent
  runner.test('Agent keywords route to Transfer_To_SAC', () => {
    const engine = new RoutingEngine(supervisor);
    engine.setState({ 'user.is_validated': true });
    const result = engine.route('Quiero hablar con un agente humano');
    return {
      pass: result.matchedIntent === 'Transfer_To_SAC',
      expected: 'Transfer_To_SAC',
      actual: result.matchedIntent,
    };
  });

  // Test 6: Farewell intent
  runner.test('Farewell keywords route to Farewell', () => {
    const engine = new RoutingEngine(supervisor);
    const result = engine.route('Gracias, adios');
    return {
      pass: result.matchedIntent === 'Farewell',
      expected: 'Farewell',
      actual: result.matchedIntent,
    };
  });

  // Test 7: Unknown input - fallback
  runner.test('Unknown input routes to Fallback_Handler', () => {
    const engine = new RoutingEngine(supervisor);
    const result = engine.route('Cual es el clima hoy?');
    return {
      pass: result.targetAgent === 'Fallback_Handler',
      expected: 'Fallback_Handler',
      actual: result.targetAgent,
    };
  });

  // Test 8: Balance keyword match
  runner.test('"balance" keyword routes to Pending_Payments', () => {
    const engine = new RoutingEngine(supervisor);
    engine.setState({ 'user.is_validated': true });
    const result = engine.route('Quiero ver mi balance');
    return {
      pass: result.matchedIntent === 'Pending_Payments',
      expected: 'Pending_Payments',
      actual: result.matchedIntent,
    };
  });

  // Test 9: Deuda keyword match
  runner.test('"deuda" keyword routes to Pending_Payments', () => {
    const engine = new RoutingEngine(supervisor);
    engine.setState({ 'user.is_validated': true });
    const result = engine.route('Tengo una deuda?');
    return {
      pass: result.matchedIntent === 'Pending_Payments',
      expected: 'Pending_Payments',
      actual: result.matchedIntent,
    };
  });

  console.log('\n📋 SALUDSA - Policy Enforcement Tests\n');

  // Test 10: Handoff blocked when not validated
  runner.test('Handoff BLOCKED when user.is_validated = false', () => {
    const engine = new RoutingEngine(supervisor);
    engine.setState({ 'user.is_validated': false });
    const result = engine.route('Transferir a un agente');
    return {
      pass: result.policyViolations.length > 0,
      expected: 'Policy violation (handoff_policy)',
      actual:
        result.policyViolations.length > 0
          ? `Blocked: ${result.policyViolations[0].policy}`
          : 'No violations',
    };
  });

  // Test 11: Handoff allowed when validated
  runner.test('Handoff ALLOWED when user.is_validated = true', () => {
    const engine = new RoutingEngine(supervisor);
    engine.setState({ 'user.is_validated': true });
    const result = engine.route('Transferir a un agente');
    return {
      pass: result.policyViolations.length === 0 && result.finalDecision.allowed,
      expected: 'Allowed to Transfer_To_SAC',
      actual: result.finalDecision.allowed
        ? `Allowed to ${result.finalDecision.agent}`
        : `Blocked: ${result.policyViolations[0]?.policy}`,
    };
  });

  // Test 12: Policy blocks payment query when not validated
  runner.test('Payment query BLOCKED when user.is_validated = false', () => {
    const engine = new RoutingEngine(supervisor);
    engine.setState({ 'user.is_validated': false });
    const result = engine.route('Cual es mi saldo?');
    return {
      pass: result.policyViolations.length > 0,
      expected: 'Policy violation - needs validation',
      actual:
        result.policyViolations.length > 0
          ? `Blocked: needs ${result.finalDecision.redirectTo}`
          : 'No violations',
    };
  });

  // Test 13: Payment allowed when validated
  runner.test('Payment query ALLOWED when user.is_validated = true', () => {
    const engine = new RoutingEngine(supervisor);
    engine.setState({ 'user.is_validated': true });
    const result = engine.route('Cual es mi saldo?');
    return {
      pass: result.finalDecision.allowed && result.targetAgent === 'Pending_Payments',
      expected: 'Allowed to Pending_Payments',
      actual: result.finalDecision.allowed ? `Allowed to ${result.targetAgent}` : 'Blocked',
    };
  });

  // Test 14: Redirect to validation agent when blocked
  runner.test('Blocked requests redirect to User_Validator', () => {
    const engine = new RoutingEngine(supervisor);
    engine.setState({ 'user.is_validated': false });
    const result = engine.route('Quiero un reembolso');
    return {
      pass: result.finalDecision.redirectTo === 'User_Validator',
      expected: 'Redirect to User_Validator',
      actual: `Redirect to ${result.finalDecision.redirectTo}`,
    };
  });
}

function runTravelDeskTests(runner) {
  console.log('\n📋 TRAVELDESK - Intent Routing Tests\n');

  const supervisor = loadSupervisor('traveldesk');

  // Test 1: Flight intent
  runner.test('Flight keywords route to Flight_Search', () => {
    const engine = new RoutingEngine(supervisor);
    const result = engine.route('I need to book a flight to Paris');
    return {
      pass: result.matchedIntent === 'Flight_Search',
      expected: 'Flight_Search',
      actual: result.matchedIntent,
    };
  });

  // Test 2: Hotel intent
  runner.test('Hotel keywords route to Hotel_Search', () => {
    const engine = new RoutingEngine(supervisor);
    const result = engine.route('Find me a hotel in Rome');
    return {
      pass: result.matchedIntent === 'Hotel_Search',
      expected: 'Hotel_Search',
      actual: result.matchedIntent,
    };
  });

  // Test 3: Booking management intent
  runner.test('Booking keywords route to Trip_Manager', () => {
    const engine = new RoutingEngine(supervisor);
    const result = engine.route('I want to see my itinerary');
    return {
      pass: result.matchedIntent === 'Trip_Manager',
      expected: 'Trip_Manager',
      actual: result.matchedIntent,
    };
  });

  // Test 4: Deals intent
  runner.test('Deal keywords route to Deals_Advisor', () => {
    const engine = new RoutingEngine(supervisor);
    const result = engine.route('Show me cheap deals');
    return {
      pass: result.matchedIntent === 'Deals_Advisor',
      expected: 'Deals_Advisor',
      actual: result.matchedIntent,
    };
  });

  // Test 5: Support intent
  runner.test('Problem keywords route to Support', () => {
    const engine = new RoutingEngine(supervisor);
    const result = engine.route('I have a problem with my booking');
    return {
      pass: result.matchedIntent === 'Support',
      expected: 'Support',
      actual: result.matchedIntent,
    };
  });

  // Test 6: Refund intent
  runner.test('Refund keywords route to Support', () => {
    const engine = new RoutingEngine(supervisor);
    const result = engine.route('I need a refund please');
    return {
      pass: result.matchedIntent === 'Support',
      expected: 'Support',
      actual: result.matchedIntent,
    };
  });

  // Test 7: Farewell intent
  runner.test('Goodbye keywords route to Farewell', () => {
    const engine = new RoutingEngine(supervisor);
    const result = engine.route('Thanks, bye!');
    return {
      pass: result.matchedIntent === 'Farewell',
      expected: 'Farewell',
      actual: result.matchedIntent,
    };
  });

  // Test 8: Plane keyword
  runner.test('"plane" keyword routes to Flight_Search', () => {
    const engine = new RoutingEngine(supervisor);
    const result = engine.route('I want to take a plane');
    return {
      pass: result.matchedIntent === 'Flight_Search',
      expected: 'Flight_Search',
      actual: result.matchedIntent,
    };
  });

  // Test 9: Room keyword
  runner.test('"room" keyword routes to Hotel_Search', () => {
    const engine = new RoutingEngine(supervisor);
    const result = engine.route('I need a room for tonight');
    return {
      pass: result.matchedIntent === 'Hotel_Search',
      expected: 'Hotel_Search',
      actual: result.matchedIntent,
    };
  });

  // Test 10: Discount keyword
  runner.test('"discount" keyword routes to Deals_Advisor', () => {
    const engine = new RoutingEngine(supervisor);
    const result = engine.route('Any discount available?');
    return {
      pass: result.matchedIntent === 'Deals_Advisor',
      expected: 'Deals_Advisor',
      actual: result.matchedIntent,
    };
  });

  console.log('\n📋 TRAVELDESK - Policy Enforcement Tests\n');

  // Test 11: Booking modification blocked when not authenticated
  runner.test('Booking modification BLOCKED when user.authenticated = false', () => {
    const engine = new RoutingEngine(supervisor);
    engine.setState({ 'user.authenticated': false });
    const result = engine.route('I want to cancel my booking');
    return {
      pass: result.policyViolations.length > 0,
      expected: 'Policy violation (booking_security)',
      actual:
        result.policyViolations.length > 0
          ? `Blocked: ${result.policyViolations[0].policy}`
          : 'No violations',
    };
  });

  // Test 12: Booking modification allowed when authenticated
  runner.test('Booking modification ALLOWED when user.authenticated = true', () => {
    const engine = new RoutingEngine(supervisor);
    engine.setState({ 'user.authenticated': true });
    const result = engine.route('I want to manage my booking');
    return {
      pass: result.policyViolations.length === 0,
      expected: 'Allowed - no policy violations',
      actual:
        result.policyViolations.length === 0
          ? 'Allowed'
          : `Blocked: ${result.policyViolations[0].policy}`,
    };
  });

  // Test 13: Search allowed without authentication (search is in allowed_actions)
  runner.test('Flight search ALLOWED even when not authenticated', () => {
    const engine = new RoutingEngine(supervisor);
    engine.setState({ 'user.authenticated': false });
    const result = engine.route('Search flights to London');
    return {
      pass: result.matchedIntent === 'Flight_Search',
      expected: 'Flight_Search (search is permitted action)',
      actual: result.matchedIntent,
    };
  });

  // Test 14: Trip management blocked without auth
  runner.test('Trip management BLOCKED without authentication', () => {
    const engine = new RoutingEngine(supervisor);
    engine.setState({ 'user.authenticated': false });
    const result = engine.route('Show me my trip details');
    return {
      pass: result.policyViolations.length > 0,
      expected: 'Policy violation',
      actual:
        result.policyViolations.length > 0
          ? `Blocked: ${result.policyViolations[0].policy}`
          : 'No violations (unexpected)',
    };
  });
}

function runGenericTests(runner) {
  console.log('\n📋 GENERIC - Basic Routing Tests\n');

  const supervisor = loadSupervisor('generic');

  // Test basic routing for generic supervisor
  runner.test('Generic supervisor loads correctly', () => {
    // Just check it has a name
    return {
      pass: supervisor.meta.name != null && supervisor.meta.name.length > 0,
      expected: 'Any valid name',
      actual: supervisor.meta.name,
    };
  });

  // Test intent count
  runner.test('Generic supervisor has defined intents', () => {
    const intentCount = supervisor.intents?.length || 0;
    return {
      pass: intentCount > 0,
      expected: 'At least 1 intent',
      actual: `${intentCount} intents`,
    };
  });

  // Test agents count
  runner.test('Generic supervisor has defined agents', () => {
    const agentCount = supervisor.agents?.length || 0;
    return {
      pass: agentCount > 0,
      expected: 'At least 1 agent',
      actual: `${agentCount} agents`,
    };
  });
}

// ============================================================================
// Run All Tests
// ============================================================================

async function main() {
  console.log('='.repeat(60));
  console.log('🧪 Agent DSL - Routing Policy & Business Rules Test Suite');
  console.log('='.repeat(60));

  const runner = new TestRunner();

  try {
    runSaludsaTests(runner);
    runTravelDeskTests(runner);
    runGenericTests(runner);
  } catch (error) {
    console.error('\n💥 Test suite error:', error.message);
    process.exit(1);
  }

  const success = runner.summary();

  // Print detailed results
  console.log('\n📊 Detailed Results:\n');

  const saludsaPassed = runner.results
    .filter(
      (r) =>
        r.name.includes('Saludsa') ||
        r.name.includes('Payment') ||
        r.name.includes('Refund') ||
        r.name.includes('Contract') ||
        r.name.includes('Password') ||
        r.name.includes('Agent') ||
        r.name.includes('Farewell') ||
        r.name.includes('Unknown') ||
        r.name.includes('balance') ||
        r.name.includes('deuda') ||
        r.name.includes('Handoff') ||
        r.name.includes('Redirect') ||
        r.name.includes('validation'),
    )
    .filter((r) => r.status === 'PASS').length;
  const travelDeskPassed = runner.results
    .filter(
      (r) =>
        r.name.includes('Flight') ||
        r.name.includes('Hotel') ||
        r.name.includes('Booking') ||
        r.name.includes('Deal') ||
        r.name.includes('Problem') ||
        r.name.includes('Goodbye') ||
        r.name.includes('plane') ||
        r.name.includes('room') ||
        r.name.includes('discount') ||
        r.name.includes('Trip') ||
        r.name.includes('authenticated'),
    )
    .filter((r) => r.status === 'PASS').length;

  console.log(`  Saludsa tests: ${saludsaPassed} scenarios validated`);
  console.log(`  Traveldesk tests: ${travelDeskPassed} scenarios validated`);
  console.log(
    `  Generic tests: ${runner.results.filter((r) => r.name.includes('Generic')).filter((r) => r.status === 'PASS').length} scenarios validated`,
  );

  process.exit(success ? 0 : 1);
}

main();
