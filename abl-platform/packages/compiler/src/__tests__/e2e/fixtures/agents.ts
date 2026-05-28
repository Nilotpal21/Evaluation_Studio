/**
 * Shared Agent DSL Fixtures
 *
 * Loads comprehensive agent DSLs from the examples/ folder.
 * This ensures tests use the same DSLs as the actual examples,
 * avoiding duplication and keeping a single source of truth.
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXAMPLES_DIR = path.resolve(__dirname, '../../../../../../examples');

// =============================================================================
// DSL FILE LOADER
// =============================================================================

function loadDSL(relativePath: string): string {
  const fullPath = path.join(EXAMPLES_DIR, relativePath);
  if (!fs.existsSync(fullPath)) {
    throw new Error(`DSL file not found: ${fullPath}`);
  }
  return fs.readFileSync(fullPath, 'utf-8');
}

// =============================================================================
// FLOW-TEST AGENTS (from examples/flow-test/)
// =============================================================================

/**
 * Hotel Booking - Consolidated flow pattern example
 * Constructs: FLOW, TOOLS, CONSTRAINTS, DELEGATE, GATHER, ON_INPUT, CALL, RESPOND, COMPLETE
 */
export const TRAVEL_BOOKING_DSL = loadDSL('flow-test/agents/hotel_booking.agent.abl');

/**
 * Hotel Booking (alias) - Same consolidated agent used for constraint tests
 * Constructs: CONSTRAINTS, DELEGATE, GATHER, FLOW, TOOLS, COMPLETE
 */
export const ORDER_PROCESSOR_DSL = loadDSL('flow-test/agents/hotel_booking.agent.abl');

/**
 * Hotel Booking (alias) - Same consolidated agent used for basic flow tests
 * Constructs: FLOW, TOOLS, COLLECT, CALL, RESPOND, COMPLETE
 */
export const LOAN_APPLICATION_DSL = loadDSL('flow-test/agents/hotel_booking.agent.abl');

// =============================================================================
// TRAVEL AGENTS (from examples/travel/ — formerly traveldesk)
// =============================================================================

/**
 * Travel Supervisor - Multi-agent routing
 * Constructs: MEMORY, HANDOFF (6 routes), ESCALATE, ON_ERROR, COMPLETE
 */
export const TRAVELDESK_SUPERVISOR_DSL = loadDSL('travel/agents/traveldesk_supervisor.agent.abl');

/**
 * Authentication Agent - Identity verification flow
 * Constructs: GATHER, MEMORY, CONSTRAINTS, DELEGATE, HANDOFF, ESCALATE, ON_ERROR, COMPLETE
 */
export const AUTHENTICATION_DSL = loadDSL('travel/agents/authentication.agent.abl');

/**
 * Booking Manager - Booking modifications
 * Constructs: GATHER, MEMORY, CONSTRAINTS, DELEGATE, HANDOFF, ESCALATE, ON_ERROR, COMPLETE
 */
export const BOOKING_MANAGER_DSL = loadDSL('travel/agents/booking_manager.agent.abl');

// =============================================================================
// SALUDSA AGENTS (from examples/saludsa/)
// =============================================================================

/**
 * Saludsa Supervisor - Health insurance routing
 * Constructs: HANDOFF, COMPLETE
 */
export const SALUDSA_SUPERVISOR_DSL = loadDSL('saludsa/agents/supervisor.agent.abl');

/**
 * User Validator - Identity verification with GATHER
 * Constructs: GATHER, TOOLS, ESCALATE, COMPLETE
 */
export const USER_VALIDATOR_DSL = loadDSL('saludsa/agents/user_validator.agent.abl');

/**
 * Pending Payments - Payment inquiry agent
 * Constructs: GATHER, TOOLS, ESCALATE, COMPLETE
 */
export const PENDING_PAYMENTS_DSL = loadDSL('saludsa/agents/pending_payments.agent.abl');

// =============================================================================
// UNIFIED AGENTS (from examples/unified/)
// =============================================================================

/**
 * Unified Supervisor - Simple multi-agent routing
 * Constructs: GATHER, HANDOFF, COMPLETE
 */
export const UNIFIED_SUPERVISOR_DSL = loadDSL('unified/agents/supervisor.agent.abl');

/**
 * Support Agent - Customer support with ESCALATE
 * Constructs: GATHER, TOOLS, ESCALATE, COMPLETE
 */
export const SUPPORT_AGENT_DSL = loadDSL('unified/agents/support.agent.abl');

// =============================================================================
// AGENT FIXTURE METADATA
// =============================================================================

export interface AgentFixture {
  name: string;
  dsl: string;
  description: string;
  category: 'flow-test' | 'travel' | 'saludsa' | 'unified';
  constructs: string[];
  gatherFields: string[];
  tools: string[];
}

export const AGENT_FIXTURES: AgentFixture[] = [
  // Flow-Test - Consolidated Hotel Booking Example
  {
    name: 'Hotel_Booking',
    dsl: TRAVEL_BOOKING_DSL,
    description: 'Comprehensive scripted flow with navigation and conditional paths',
    category: 'flow-test',
    constructs: [
      'FLOW',
      'TOOLS',
      'CONSTRAINTS',
      'DELEGATE',
      'GATHER',
      'ON_INPUT',
      'CALL',
      'RESPOND',
      'COMPLETE',
    ],
    gatherFields: [
      'destination',
      'checkin_date',
      'checkout_date',
      'num_guests',
      'num_rooms',
      'selected_hotel',
      'room_type',
      'guest_name',
      'guest_email',
      'guest_phone',
      'payment_type',
      'confirmation',
    ],
    tools: [
      'search_hotels',
      'check_availability',
      'apply_promo_code',
      'create_booking',
      'get_weather',
    ],
  },
  {
    name: 'Hotel_Booking',
    dsl: ORDER_PROCESSOR_DSL,
    description: 'Consolidated hotel booking (constraint and delegate tests)',
    category: 'flow-test',
    constructs: ['CONSTRAINTS', 'DELEGATE', 'GATHER', 'FLOW', 'TOOLS', 'COMPLETE'],
    gatherFields: [
      'destination',
      'checkin_date',
      'checkout_date',
      'num_guests',
      'guest_name',
      'guest_email',
    ],
    tools: [
      'search_hotels',
      'check_availability',
      'apply_promo_code',
      'create_booking',
      'get_weather',
    ],
  },
  {
    name: 'Hotel_Booking',
    dsl: LOAN_APPLICATION_DSL,
    description: 'Consolidated hotel booking (basic flow tests)',
    category: 'flow-test',
    constructs: ['FLOW', 'TOOLS', 'COLLECT', 'CALL', 'RESPOND', 'COMPLETE'],
    gatherFields: [
      'destination',
      'checkin_date',
      'checkout_date',
      'num_guests',
      'guest_name',
      'guest_email',
      'guest_phone',
    ],
    tools: [
      'search_hotels',
      'check_availability',
      'apply_promo_code',
      'create_booking',
      'get_weather',
    ],
  },

  // Travel - Real-World Travel System (formerly traveldesk)
  {
    name: 'TravelDesk_Supervisor',
    dsl: TRAVELDESK_SUPERVISOR_DSL,
    description: 'Multi-agent supervisor with routing',
    category: 'travel',
    constructs: ['MEMORY', 'HANDOFF', 'ESCALATE', 'ON_ERROR', 'COMPLETE'],
    gatherFields: [],
    tools: [],
  },
  {
    name: 'Authentication',
    dsl: AUTHENTICATION_DSL,
    description: 'User authentication and verification',
    category: 'travel',
    constructs: [
      'GATHER',
      'MEMORY',
      'CONSTRAINTS',
      'DELEGATE',
      'HANDOFF',
      'ESCALATE',
      'ON_ERROR',
      'COMPLETE',
    ],
    gatherFields: ['email', 'booking_reference', 'verification_code'],
    tools: ['send_verification_code', 'verify_code', 'lookup_booking', 'lookup_customer'],
  },
  {
    name: 'Booking_Manager',
    dsl: BOOKING_MANAGER_DSL,
    description: 'Booking modifications and cancellations',
    category: 'travel',
    constructs: [
      'GATHER',
      'MEMORY',
      'CONSTRAINTS',
      'DELEGATE',
      'HANDOFF',
      'ESCALATE',
      'ON_ERROR',
      'COMPLETE',
    ],
    gatherFields: ['modification_type', 'new_dates', 'reason'],
    tools: [
      'get_booking_details',
      'check_modification_eligibility',
      'calculate_fees',
      'apply_modification',
      'process_cancellation',
    ],
  },

  // Saludsa - Health Insurance
  {
    name: 'Saludsa_Supervisor',
    dsl: SALUDSA_SUPERVISOR_DSL,
    description: 'Health insurance supervisor routing',
    category: 'saludsa',
    constructs: ['HANDOFF', 'COMPLETE'],
    gatherFields: [],
    tools: [],
  },
  {
    name: 'User_Validator',
    dsl: USER_VALIDATOR_DSL,
    description: 'User identity validation for insurance',
    category: 'saludsa',
    constructs: ['GATHER', 'TOOLS', 'ESCALATE', 'COMPLETE'],
    gatherFields: ['cedula', 'nombre_completo', 'fecha_nacimiento'],
    tools: ['validar_cedula', 'consultar_afiliacion'],
  },
  {
    name: 'Pending_Payments',
    dsl: PENDING_PAYMENTS_DSL,
    description: 'Payment inquiry and guidance',
    category: 'saludsa',
    constructs: ['GATHER', 'TOOLS', 'ESCALATE', 'COMPLETE'],
    gatherFields: ['numero_factura', 'tipo_consulta'],
    tools: ['consultar_pagos_pendientes', 'generar_enlace_pago'],
  },

  // Unified - Simple Multi-Agent
  {
    name: 'Supervisor',
    dsl: UNIFIED_SUPERVISOR_DSL,
    description: 'Simple travel booking supervisor',
    category: 'unified',
    constructs: ['GATHER', 'HANDOFF', 'COMPLETE'],
    gatherFields: ['intent', 'customer_name'],
    tools: [],
  },
  {
    name: 'Support_Agent',
    dsl: SUPPORT_AGENT_DSL,
    description: 'Customer support with escalation',
    category: 'unified',
    constructs: ['GATHER', 'TOOLS', 'ESCALATE', 'COMPLETE'],
    gatherFields: ['issue_type', 'booking_reference', 'description'],
    tools: ['create_ticket', 'lookup_booking', 'request_refund'],
  },
];

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

export function getAgentByName(name: string): AgentFixture | undefined {
  return AGENT_FIXTURES.find((f) => f.name === name);
}

export function getAgentsByCategory(category: AgentFixture['category']): AgentFixture[] {
  return AGENT_FIXTURES.filter((f) => f.category === category);
}

export function getAgentsWithConstruct(construct: string): AgentFixture[] {
  return AGENT_FIXTURES.filter((f) => f.constructs.includes(construct));
}

// Export DSLs for backward compatibility and direct imports
export {
  TRAVEL_BOOKING_DSL as TRAVEL_ASSISTANT_DSL, // Alias for backward compatibility
  ORDER_PROCESSOR_DSL as CUSTOMER_SERVICE_DSL, // Different example but comprehensive
  LOAN_APPLICATION_DSL as INSURANCE_AGENT_DSL, // Different domain but similar complexity
  UNIFIED_SUPERVISOR_DSL as MULTILINGUAL_AGENT_DSL, // For basic tests
};
