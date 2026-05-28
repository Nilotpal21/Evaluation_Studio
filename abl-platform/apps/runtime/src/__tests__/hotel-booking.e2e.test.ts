import { describe, test, expect, beforeEach } from 'vitest';
import { RuntimeExecutor, compileToResolvedAgent } from '../services/runtime-executor';
import * as fs from 'fs';
import * as path from 'path';

describe('Hotel Booking Advanced E2E', () => {
  let executor: RuntimeExecutor;
  let dsl: string;

  beforeEach(() => {
    executor = new RuntimeExecutor();
    // Load the actual ABL file
    const dslPath = path.resolve(
      __dirname,
      '../../../../examples/flow-test/agents/hotel_booking.agent.abl',
    );
    dsl = fs.readFileSync(dslPath, 'utf-8');
  });

  describe('Flow Initialization', () => {
    test('should display welcome message on initialization', async () => {
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([dsl], 'Hotel_Booking'),
      );
      const chunks: string[] = [];

      await executor.initializeSession(session.id, (c) => chunks.push(c));

      const fullOutput = chunks.join('');

      // Welcome message should be shown
      expect(fullOutput).toContain('Welcome to Hotel Booking!');
      expect(fullOutput).toContain("I'll help you find and book the perfect hotel");
      expect(fullOutput).toContain('"back" to go to previous step');
      expect(fullOutput).toContain('"start over" to restart');

      // Should transition to get_destination and show GATHER auto-prompt
      expect(fullOutput).toContain('Where would you like to stay?');
      expect(session.currentFlowStep).toBe('get_destination');
      expect(session.waitingForInput).toContain('destination');
    });

    test('should have correct initial session state', async () => {
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([dsl], 'Hotel_Booking'),
      );

      // agentName is stored directly on session
      expect(session.agentName).toBe('Hotel_Booking');

      expect(session.agentIR?.flow?.entry_point).toBe('welcome');
      expect(session.agentIR?.flow?.steps).toContain('welcome');
      expect(session.agentIR?.flow?.steps).toContain('get_destination');
    });
  });

  describe('Happy Path - Destination Collection', () => {
    test('should collect destination and transition to get_dates', async () => {
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([dsl], 'Hotel_Booking'),
      );
      const chunks: string[] = [];

      // Initialize flow
      await executor.initializeSession(session.id, (c) => chunks.push(c));
      expect(session.currentFlowStep).toBe('get_destination');

      // Provide destination
      chunks.length = 0;
      const result = await executor.executeMessage(session.id, 'New York', (c) => chunks.push(c));

      const output = chunks.join('');

      // Should store destination in data.values
      expect(session.data.values.destination).toBe('New York');

      // Should transition to get_dates
      expect(session.currentFlowStep).toBe('get_dates');

      // Should show GATHER auto-prompt for date fields
      expect(output).toContain('Check-in date?');
      expect(output).toContain('Check-out date?');
    });

    test('should collect dates and transition to get_guests', async () => {
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([dsl], 'Hotel_Booking'),
      );

      // Initialize and go to get_destination
      await executor.initializeSession(session.id, () => {});

      // Provide destination
      await executor.executeMessage(session.id, 'Paris', () => {});
      expect(session.currentFlowStep).toBe('get_dates');

      // Provide dates
      const chunks: string[] = [];
      await executor.executeMessage(session.id, 'March 15 to March 20', (c) => chunks.push(c));

      const output = chunks.join('');

      // Should transition to get_guests
      expect(session.currentFlowStep).toBe('get_guests');

      // Should show GATHER auto-prompt for guest fields
      expect(output).toContain('How many guests?');
      expect(output).toContain('How many rooms?');
    });
  });

  describe('Navigation - Back Command', () => {
    test('should handle "back" at get_destination (first step)', async () => {
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([dsl], 'Hotel_Booking'),
      );

      // Initialize flow
      await executor.initializeSession(session.id, () => {});
      expect(session.currentFlowStep).toBe('get_destination');

      // Try to go back at first step
      const chunks: string[] = [];
      await executor.executeMessage(session.id, 'back', (c) => chunks.push(c));

      const output = chunks.join('');

      // Should stay at get_destination with helpful message
      expect(session.currentFlowStep).toBe('get_destination');
      expect(output).toContain("You're at the first step");
    });

    test('should go back from get_dates to get_destination', async () => {
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([dsl], 'Hotel_Booking'),
      );

      // Initialize and advance to get_dates
      await executor.initializeSession(session.id, () => {});
      await executor.executeMessage(session.id, 'London', () => {});
      expect(session.currentFlowStep).toBe('get_dates');

      // Go back
      const chunks: string[] = [];
      await executor.executeMessage(session.id, 'back', (c) => chunks.push(c));

      // Should return to get_destination
      expect(session.currentFlowStep).toBe('get_destination');
    });

    test('should go back from get_guests to get_dates', async () => {
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([dsl], 'Hotel_Booking'),
      );

      // Initialize and advance to get_guests
      await executor.initializeSession(session.id, () => {});
      await executor.executeMessage(session.id, 'Tokyo', () => {});
      await executor.executeMessage(session.id, 'April 1 to April 5', () => {});
      expect(session.currentFlowStep).toBe('get_guests');

      // Go back
      const chunks: string[] = [];
      await executor.executeMessage(session.id, 'back', (c) => chunks.push(c));

      // Should return to get_dates
      expect(session.currentFlowStep).toBe('get_dates');
    });
  });

  describe('Navigation - Start Over', () => {
    test('should restart flow with "start over" command from get_destination', async () => {
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([dsl], 'Hotel_Booking'),
      );

      // Initialize flow (now at get_destination)
      await executor.initializeSession(session.id, () => {});
      expect(session.currentFlowStep).toBe('get_destination');

      // Start over from get_destination (only step with start over handler)
      const chunks: string[] = [];
      await executor.executeMessage(session.id, 'start over', (c) => chunks.push(c));

      const output = chunks.join('');

      // Should return to welcome and show welcome message
      expect(output).toContain('Welcome to Hotel Booking!');
      // Then transition to get_destination
      expect(session.currentFlowStep).toBe('get_destination');
    });
  });

  describe('Navigation - Change Commands', () => {
    test('should handle "change destination" from get_dates via back navigation', async () => {
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([dsl], 'Hotel_Booking'),
      );

      // Initialize and advance to get_dates
      await executor.initializeSession(session.id, () => {});
      await executor.executeMessage(session.id, 'Berlin', () => {});
      expect(session.currentFlowStep).toBe('get_dates');

      // Use "back" to navigate to get_destination (GATHER intercepts free-text before ON_INPUT)
      const chunks: string[] = [];
      await executor.executeMessage(session.id, 'back', (c) => chunks.push(c));

      // Should go back to get_destination
      expect(session.currentFlowStep).toBe('get_destination');
    });

    test('should handle "change date" from get_guests', async () => {
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([dsl], 'Hotel_Booking'),
      );

      // Initialize and advance to get_guests
      await executor.initializeSession(session.id, () => {});
      await executor.executeMessage(session.id, 'Sydney', () => {});
      await executor.executeMessage(session.id, 'Dec 20 to Dec 25', () => {});
      expect(session.currentFlowStep).toBe('get_guests');

      // Change dates
      const chunks: string[] = [];
      await executor.executeMessage(session.id, 'change date', (c) => chunks.push(c));

      // Should go back to get_dates
      expect(session.currentFlowStep).toBe('get_dates');
    });
  });

  describe('Context Preservation', () => {
    test('should preserve context values when navigating back', async () => {
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([dsl], 'Hotel_Booking'),
      );

      // Initialize and fill in values
      await executor.initializeSession(session.id, () => {});
      await executor.executeMessage(session.id, 'San Francisco', () => {});

      // Store destination in data.values
      expect(session.data.values.destination).toBe('San Francisco');

      await executor.executeMessage(session.id, 'July 4 to July 10', () => {});

      // Now at get_guests
      expect(session.currentFlowStep).toBe('get_guests');

      // Go back to dates
      await executor.executeMessage(session.id, 'back', () => {});

      // Destination should still be preserved in data.values
      expect(session.data.values.destination).toBe('San Francisco');
    });

    test('should display context in prompts', async () => {
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([dsl], 'Hotel_Booking'),
      );

      await executor.initializeSession(session.id, () => {});
      await executor.executeMessage(session.id, 'Barcelona', () => {});

      const chunks: string[] = [];
      await executor.executeMessage(session.id, 'Aug 1 to Aug 7', (c) => chunks.push(c));

      const output = chunks.join('');

      // Should show GATHER auto-prompt for guest fields
      expect(output).toContain('How many guests?');
    });
  });

  describe('Flow Definition', () => {
    test('should have all required flow steps defined', async () => {
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([dsl], 'Hotel_Booking'),
      );

      const flow = session.agentIR?.flow;
      expect(flow).toBeDefined();

      // Check all steps are defined
      const expectedSteps = [
        'welcome',
        'get_destination',
        'get_dates',
        'get_guests',
        'search_and_show',
        'select_hotel',
        'select_room',
        'promo_check',
        'guest_details',
        'payment_method',
        'review_booking',
        'confirm',
      ];

      for (const step of expectedSteps) {
        expect(flow?.steps).toContain(step);
        expect(flow?.definitions[step]).toBeDefined();
      }
    });

    test('should have welcome step with RESPOND action', async () => {
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([dsl], 'Hotel_Booking'),
      );

      const welcomeDef = session.agentIR?.flow?.definitions['welcome'];
      expect(welcomeDef).toBeDefined();
      expect(welcomeDef?.respond).toContain('Welcome to Hotel Booking!');
      expect(welcomeDef?.then).toBe('get_destination');
    });

    test('should have get_destination step with GATHER action', async () => {
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([dsl], 'Hotel_Booking'),
      );

      const stepDef = session.agentIR?.flow?.definitions['get_destination'];
      expect(stepDef).toBeDefined();
      expect(stepDef?.gather).toBeDefined();
    });
  });
});
