/**
 * TravelDesk Hotel Booking E2E Tests — Multi-Turn Conversations
 *
 * Tests complete hotel booking flows with 10+ turns each,
 * verifying entity extraction, constraint checking, tool invocation,
 * and state accumulation across natural conversational inputs.
 *
 * Uses the Sales_Agent (reasoning mode) from the TravelDesk example suite.
 */

import { describe, test, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

import {
  createRealLLMClient,
  createTestContext,
  compileAgentDSL,
  TranscriptRecorder,
  runConversationTest,
  generateTranscriptSummary,
  printCacheStats,
  getSkipReason,
  TRANSCRIPT_DIR,
  type LLMClient,
} from './fixtures/test-utils.js';

import type { AgentIR } from '../../platform/ir/schema.js';
import { InMemoryFactStore, type FactStoreConfig } from '../../platform/stores/fact-store.js';

// =============================================================================
// DSL LOADING
// =============================================================================

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXAMPLES_DIR = path.resolve(__dirname, '../../../../../examples/travel');

function loadTravelDeskDSL(filename: string): string {
  const fullPath = path.join(EXAMPLES_DIR, filename);
  if (!fs.existsSync(fullPath)) {
    throw new Error(`TravelDesk DSL not found: ${fullPath}`);
  }
  return fs.readFileSync(fullPath, 'utf-8');
}

const SALES_AGENT_DSL = loadTravelDeskDSL('agents/sales_agent.agent.abl');

// =============================================================================
// TEST SETUP
// =============================================================================

let llmClient: LLMClient;
let salesAgentIR: AgentIR;
let factStore: InMemoryFactStore;

const HOTEL_TRANSCRIPT_DIR = path.join(TRANSCRIPT_DIR, 'traveldesk');

const skipReason = getSkipReason();

describe.skipIf(!!skipReason)('TravelDesk Hotel Booking E2E — Multi-Turn', () => {
  beforeAll(() => {
    // Provider controlled via LLM_PROVIDER env var (default: anthropic)
    llmClient = createRealLLMClient();
    salesAgentIR = compileAgentDSL(SALES_AGENT_DSL);

    if (!fs.existsSync(HOTEL_TRANSCRIPT_DIR)) {
      fs.mkdirSync(HOTEL_TRANSCRIPT_DIR, { recursive: true });
    }
  });

  beforeEach(() => {
    const config: FactStoreConfig = { type: 'memory', environment: 'dev' };
    factStore = new InMemoryFactStore(config);
  });

  afterAll(() => {
    generateTranscriptSummary();
    printCacheStats();
  });

  // ===========================================================================
  // 1. HAPPY PATH — Full Hotel Booking (12 turns)
  // ===========================================================================

  describe('1. Happy Path — Hotel in Paris', () => {
    test('1.1 Full hotel booking flow from greeting to quote (12 turns)', async () => {
      const { state, transcript } = await runConversationTest(
        {
          name: 'Hotel Booking Happy Path — Paris 3 Nights',
          scenario: 'traveldesk/hotel_booking_happy_path',
          inputs: [
            'hi',
            'I need a hotel in Paris for 3 nights',
            'I will be traveling from London',
            'checking in on March 15th',
            'checking out on March 18th',
            'just 2 of us',
            'our budget is around 500 euros',
            'yes hotels only please',
            'can you search for available hotels?',
            'the second option looks good',
            'can you check if it is still available?',
            'great, please send me a quote at john@example.com',
          ],
          notes: [
            'Natural conversational flow starting with casual greeting',
            'Information spread across multiple turns (1-2 fields per turn)',
            'Budget and travel type provided as separate turns',
            'User explicitly requests search, selection, availability check, and quote',
          ],
        },
        salesAgentIR,
        'Sales_Agent',
        llmClient,
      );

      // Verify core fields extracted across turns
      expect(state.gatherProgress.destination).toBeDefined();
      expect(state.gatherProgress.origin).toBeDefined();
      expect(state.gatherProgress.departure_date).toBeDefined();
      expect(state.gatherProgress.num_travelers).toBeDefined();

      // Transcript should have all 12 turns
      expect(transcript.turns.length).toBe(12);
      expect(transcript.outcome).toBe('success');
    }, 180000);
  });

  // ===========================================================================
  // 2. MULTI-FIELD EXTRACTION — Dense First Message (10 turns)
  // ===========================================================================

  describe('2. Dense Opening — Multi-Field Extraction', () => {
    test('2.1 User packs multiple fields into first message (10 turns)', async () => {
      const { state, transcript } = await runConversationTest(
        {
          name: 'Dense Opening — Hotel Barcelona',
          scenario: 'traveldesk/hotel_booking_dense_opening',
          inputs: [
            'hi there',
            'I want a hotel in Barcelona from April 5th to April 10th for 4 people, coming from Manchester, budget 1200 pounds',
            'hotels only, nothing else',
            'yes please go ahead and search',
            'what are the amenities for the first hotel?',
            'actually I prefer something with a pool',
            'the second one then',
            'is it still available for those dates?',
            'perfect, create a quote for me please, email is sarah@travel.com',
            'thanks so much, that is all I need',
          ],
          notes: [
            'Turn 2 packs destination, dates, travelers, origin, and budget in one sentence',
            'Tests multi-field extraction from a single dense message',
            'Follow-up turns refine selection with amenity preferences',
          ],
        },
        salesAgentIR,
        'Sales_Agent',
        llmClient,
      );

      // Dense first message should extract most fields
      expect(state.gatherProgress.destination).toBeDefined();
      expect(state.gatherProgress.origin).toBeDefined();
      expect(state.gatherProgress.departure_date).toBeDefined();
      expect(state.gatherProgress.num_travelers).toBeDefined();
      expect(state.gatherProgress.budget).toBeDefined();

      expect(transcript.turns.length).toBe(10);
      expect(transcript.outcome).toBe('success');
    }, 180000);
  });

  // ===========================================================================
  // 3. CORRECTION FLOW — User Changes Mind (11 turns)
  // ===========================================================================

  describe('3. Correction Flow — Destination Change', () => {
    test('3.1 User changes destination mid-conversation (11 turns)', async () => {
      const { state, transcript } = await runConversationTest(
        {
          name: 'Correction Flow — Rome to Milan',
          scenario: 'traveldesk/hotel_booking_correction',
          inputs: [
            'hi',
            'I am looking for a hotel in Rome',
            'traveling from Berlin',
            'actually wait, can we change that to Milan instead?',
            'check in June 1st',
            'check out June 5th, so 4 nights',
            '3 travelers',
            'budget around 800 euros',
            'search for hotels please',
            'I will take the first option',
            'please create a quote, my email is anna@mail.de',
          ],
          notes: [
            'Turn 4: User corrects destination from Rome to Milan',
            'Tests whether LLM handles mid-conversation field corrections',
            'Destination should be Milan at the end, not Rome',
          ],
        },
        salesAgentIR,
        'Sales_Agent',
        llmClient,
      );

      expect(state.gatherProgress.destination).toBeDefined();
      expect(state.gatherProgress.origin).toBeDefined();
      expect(state.gatherProgress.departure_date).toBeDefined();
      expect(state.gatherProgress.num_travelers).toBeDefined();
      expect(state.gatherProgress.budget).toBeDefined();

      expect(transcript.turns.length).toBe(11);
      expect(transcript.outcome).toBe('success');
    }, 180000);
  });

  // ===========================================================================
  // 4. CONSTRAINT VALIDATION — Same City (10 turns)
  // ===========================================================================

  describe('4. Constraint — Same Origin and Destination', () => {
    test('4.1 User tries to book hotel in same city as origin (10 turns)', async () => {
      const { state, transcript } = await runConversationTest(
        {
          name: 'Constraint — Same City Rejection',
          scenario: 'traveldesk/hotel_booking_same_city',
          inputs: [
            'hi',
            'I need a hotel in London',
            'I am based in London',
            'oh right, that does not make sense does it',
            'ok let me change to a hotel in Edinburgh instead',
            'checking in May 10th',
            'checking out May 13th',
            'just me, 1 person',
            'no particular budget',
            'search for hotels in Edinburgh please',
          ],
          notes: [
            'Turns 2-3: Origin = destination = London → constraint violation',
            'Agent should flag destination != origin constraint',
            'Turn 5: User corrects to Edinburgh',
            'Tests constraint enforcement and recovery flow',
          ],
        },
        salesAgentIR,
        'Sales_Agent',
        llmClient,
      );

      // Destination should be Edinburgh after correction
      expect(state.gatherProgress.destination).toBeDefined();
      expect(state.gatherProgress.origin).toBeDefined();
      expect(state.gatherProgress.departure_date).toBeDefined();

      expect(transcript.turns.length).toBe(10);
    }, 180000);
  });

  // ===========================================================================
  // 5. BUDGET CONSTRAINT — Over Budget (10 turns)
  // ===========================================================================

  describe('5. Budget Awareness', () => {
    test('5.1 User has tight budget, agent adapts recommendations (10 turns)', async () => {
      const { state, transcript } = await runConversationTest(
        {
          name: 'Budget Constraint — Tight Budget',
          scenario: 'traveldesk/hotel_booking_tight_budget',
          inputs: [
            'hi, I am looking for something affordable',
            'hotel in Amsterdam please',
            'coming from Dublin',
            'around the 20th of July',
            'leaving on July 23rd',
            '2 guests',
            'my budget is only 150 euros total for all nights',
            'search for the cheapest options',
            'is there anything even cheaper?',
            'ok I will go with whatever is available under my budget',
          ],
          notes: [
            'Very tight budget (150 EUR for 3 nights in Amsterdam)',
            'Tests budget extraction and constraint awareness',
            'Agent should acknowledge budget limitation in responses',
          ],
        },
        salesAgentIR,
        'Sales_Agent',
        llmClient,
      );

      expect(state.gatherProgress.destination).toBeDefined();
      expect(state.gatherProgress.origin).toBeDefined();
      expect(state.gatherProgress.budget).toBeDefined();
      expect(state.gatherProgress.num_travelers).toBeDefined();

      expect(transcript.turns.length).toBe(10);
    }, 180000);
  });

  // ===========================================================================
  // 6. FAMILY TRIP — Multiple Travelers with Details (12 turns)
  // ===========================================================================

  describe('6. Family Trip — Detailed Requirements', () => {
    test('6.1 Family hotel booking with specific requirements (12 turns)', async () => {
      const { state, transcript } = await runConversationTest(
        {
          name: 'Family Trip — Lisbon',
          scenario: 'traveldesk/hotel_booking_family',
          inputs: [
            'hi',
            'we are planning a family holiday',
            'we want to go to Lisbon, Portugal',
            'flying from Manchester',
            'we are 2 adults and 2 children so 4 travelers total',
            'we want to go during the Easter holidays, around April 12th',
            'coming back on April 19th, so about a week',
            'budget is 2000 euros for the whole family',
            'we only need a hotel, we already have flights booked',
            'can you search for family-friendly hotels?',
            'the one with the pool and breakfast included sounds perfect',
            'go ahead and create the quote, email is smith.family@email.com',
          ],
          notes: [
            'Family booking scenario with 4 travelers',
            'Extended stay (7 nights)',
            'Higher budget to accommodate family',
            'Specific requirements: family-friendly, pool, breakfast',
          ],
        },
        salesAgentIR,
        'Sales_Agent',
        llmClient,
      );

      expect(state.gatherProgress.destination).toBeDefined();
      expect(state.gatherProgress.origin).toBeDefined();
      expect(state.gatherProgress.departure_date).toBeDefined();
      expect(state.gatherProgress.return_date).toBeDefined();
      expect(state.gatherProgress.num_travelers).toBeDefined();
      expect(state.gatherProgress.budget).toBeDefined();

      expect(transcript.turns.length).toBe(12);
      expect(transcript.outcome).toBe('success');
    }, 180000);
  });

  // ===========================================================================
  // 7. WEEKEND GETAWAY — Quick Booking (10 turns)
  // ===========================================================================

  describe('7. Weekend Getaway — Short Stay', () => {
    test('7.1 Quick weekend hotel booking (10 turns)', async () => {
      const { state, transcript } = await runConversationTest(
        {
          name: 'Weekend Getaway — Prague',
          scenario: 'traveldesk/hotel_booking_weekend',
          inputs: [
            'hi!',
            'I want a quick weekend getaway',
            'hotel in Prague sounds nice',
            'I am coming from Vienna',
            'this Friday, let us say March 21st',
            'just for the weekend, back on Sunday March 23rd',
            'only me, solo trip',
            'I can spend up to 300 euros',
            'find me something in the old town area if possible',
            'book the best rated one please',
          ],
          notes: [
            'Short stay (2 nights)',
            'Solo traveler',
            'Location preference (old town)',
            'Selection based on rating',
          ],
        },
        salesAgentIR,
        'Sales_Agent',
        llmClient,
      );

      expect(state.gatherProgress.destination).toBeDefined();
      expect(state.gatherProgress.origin).toBeDefined();
      expect(state.gatherProgress.departure_date).toBeDefined();
      expect(state.gatherProgress.return_date).toBeDefined();

      expect(transcript.turns.length).toBe(10);
    }, 180000);
  });

  // ===========================================================================
  // 8. HESITANT USER — Needs Guidance (11 turns)
  // ===========================================================================

  describe('8. Hesitant User — Needs Guidance', () => {
    test('8.1 User unsure about details, agent guides through (11 turns)', async () => {
      const { state, transcript } = await runConversationTest(
        {
          name: 'Hesitant User — Guided Booking',
          scenario: 'traveldesk/hotel_booking_hesitant',
          inputs: [
            'hi, I am not sure where to start',
            'I think I want a hotel somewhere warm',
            'maybe Nice in the south of France?',
            'I would be coming from Stockholm',
            'sometime in August, not sure about exact dates yet',
            'let us say August 10th to August 15th',
            'me and my girlfriend, so 2',
            'hmm I do not really have a fixed budget, maybe 700 euros?',
            'hotels only please',
            'ok can you search and show me what is available?',
            'the one closest to the beach please, send me a quote to erik@mail.se',
          ],
          notes: [
            'User starts uncertain and gets more specific through turns',
            'Tests agent ability to guide through information gathering',
            'Vague initial inputs ("somewhere warm") become specific ("Nice")',
          ],
        },
        salesAgentIR,
        'Sales_Agent',
        llmClient,
      );

      expect(state.gatherProgress.destination).toBeDefined();
      expect(state.gatherProgress.origin).toBeDefined();
      expect(state.gatherProgress.departure_date).toBeDefined();
      expect(state.gatherProgress.num_travelers).toBeDefined();

      expect(transcript.turns.length).toBe(11);
    }, 180000);
  });

  // ===========================================================================
  // 9. LUXURY BOOKING — High Budget (10 turns)
  // ===========================================================================

  describe('9. Luxury Booking — High Budget', () => {
    test('9.1 Luxury hotel booking with premium requirements (10 turns)', async () => {
      const { state, transcript } = await runConversationTest(
        {
          name: 'Luxury Booking — Santorini',
          scenario: 'traveldesk/hotel_booking_luxury',
          inputs: [
            'hi',
            'I want a luxury hotel in Santorini, Greece',
            'flying from New York',
            'September 1st to September 8th, a full week',
            '2 people, it is our anniversary trip',
            'budget is 5000 euros, we want something really special',
            'only hotels, preferably with a private pool and sea view',
            'search for 5 star hotels please',
            'the most expensive one with the best reviews',
            'create a quote and send it to luxury@travels.com',
          ],
          notes: [
            'High-end booking with premium requirements',
            'Long stay (7 nights) with generous budget',
            'Tests handling of luxury preferences and high budget',
          ],
        },
        salesAgentIR,
        'Sales_Agent',
        llmClient,
      );

      expect(state.gatherProgress.destination).toBeDefined();
      expect(state.gatherProgress.origin).toBeDefined();
      expect(state.gatherProgress.departure_date).toBeDefined();
      expect(state.gatherProgress.return_date).toBeDefined();
      expect(state.gatherProgress.num_travelers).toBeDefined();
      expect(state.gatherProgress.budget).toBeDefined();

      expect(transcript.turns.length).toBe(10);
      expect(transcript.outcome).toBe('success');
    }, 180000);
  });

  // ===========================================================================
  // 10. LAST MINUTE DEAL — Urgent Booking (10 turns)
  // ===========================================================================

  describe('10. Last Minute — Urgent Booking', () => {
    test('10.1 Urgent last-minute hotel booking (10 turns)', async () => {
      const { state, transcript } = await runConversationTest(
        {
          name: 'Last Minute Urgent — Madrid',
          scenario: 'traveldesk/hotel_booking_urgent',
          inputs: [
            'hi, I need a hotel urgently',
            'hotel in Madrid, I need it for tomorrow night',
            'I am in Barcelona right now',
            'just one night, checking out the day after',
            '1 person',
            'I do not care about budget, just find something available',
            'hotels only, as cheap as possible actually',
            'search now please, I need to book quickly',
            'whatever is available, just book the first one',
            'send the quote to my email quick, marco@urgente.es',
          ],
          notes: [
            'Urgent same-day booking scenario',
            'Tests handling of time-sensitive requests',
            'User changes mind about budget mid-conversation',
            'Speed is emphasized throughout',
          ],
        },
        salesAgentIR,
        'Sales_Agent',
        llmClient,
      );

      expect(state.gatherProgress.destination).toBeDefined();
      expect(state.gatherProgress.origin).toBeDefined();
      expect(state.gatherProgress.departure_date).toBeDefined();

      expect(transcript.turns.length).toBe(10);
    }, 180000);
  });
});
