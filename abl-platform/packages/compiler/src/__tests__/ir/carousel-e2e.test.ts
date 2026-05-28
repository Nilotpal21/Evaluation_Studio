/**
 * Carousel E2E Integration Test
 *
 * Verifies the full pipeline: DSL string -> parse -> compile -> IR output
 * for carousel, actions, and on_action constructs.
 */

import { describe, test, expect } from 'vitest';
import { parseAgentBasedABL } from '@abl/core';
import { compileABLtoIR } from '../../platform/ir/compiler.js';

function compileFromDSL(dsl: string, agentName: string) {
  const parseResult = parseAgentBasedABL(dsl);
  expect(parseResult.errors).toHaveLength(0);
  expect(parseResult.document).not.toBeNull();
  const output = compileABLtoIR([parseResult.document!]);
  const agent = output.agents[agentName];
  expect(agent).toBeDefined();
  return agent;
}

describe('Carousel e2e: DSL -> parse -> compile -> verify IR', () => {
  test('full pipeline produces correct carousel IR with actions and handlers', () => {
    const ir = compileFromDSL(
      `
AGENT: Shop_Agent
GOAL: "Help users browse products"
PERSONA: "Friendly shop assistant"

FLOW:
  browse:
    REASONING: false
    RESPOND: "Here are our products"
      CAROUSEL:
        - TITLE: "Widget Pro"
          SUBTITLE: "Our best widget - $29.99"
          IMAGE: "https://shop.example.com/widget-pro.jpg"
          BUTTONS:
            - BUTTON: "Add to Cart" -> add_widget_pro
            - BUTTON: "Learn More"
              URL: "https://shop.example.com/widget-pro"
        - TITLE: "Widget Lite"
          SUBTITLE: "Budget friendly - $9.99"
          BUTTONS:
            - BUTTON: "Add to Cart" -> add_widget_lite
    ON_ACTION:
      add_widget_pro:
        RESPOND: "Widget Pro added to cart!"
        TRANSITION: cart
      add_widget_lite:
        RESPOND: "Widget Lite added to cart!"
        TRANSITION: cart
    THEN: browse
  cart:
    REASONING: false
    RESPOND: "Your cart is ready"
`,
      'Shop_Agent',
    );

    // Verify flow steps exist
    expect(ir.flow).toBeDefined();
    expect(ir.flow!.definitions['browse']).toBeDefined();
    expect(ir.flow!.definitions['cart']).toBeDefined();

    const step = ir.flow!.definitions['browse'];

    // Verify carousel in rich_content
    expect(step.rich_content).toBeDefined();
    expect(step.rich_content!.carousel).toBeDefined();
    const cards = step.rich_content!.carousel!.cards;
    expect(cards).toHaveLength(2);

    // Card 1: Widget Pro
    expect(cards[0].title).toBe('Widget Pro');
    expect(cards[0].subtitle).toBe('Our best widget - $29.99');
    expect(cards[0].image_url).toBe('https://shop.example.com/widget-pro.jpg');
    expect(cards[0].buttons).toHaveLength(2);
    expect(cards[0].buttons![0].id).toBe('add_widget_pro');
    expect(cards[0].buttons![0].type).toBe('button');
    expect(cards[0].buttons![0].label).toBe('Add to Cart');
    expect(cards[0].buttons![1].id).toBe('learn_more');
    expect(cards[0].buttons![1].label).toBe('Learn More');
    expect(cards[0].buttons![1].value).toBe('https://shop.example.com/widget-pro');

    // Card 2: Widget Lite
    expect(cards[1].title).toBe('Widget Lite');
    expect(cards[1].subtitle).toBe('Budget friendly - $9.99');
    expect(cards[1].buttons).toHaveLength(1);
    expect(cards[1].buttons![0].id).toBe('add_widget_lite');

    // Verify on_action handlers
    expect(step.on_action).toBeDefined();
    expect(step.on_action).toHaveLength(2);
    expect(step.on_action![0].action_id).toBe('add_widget_pro');
    expect(step.on_action![0].respond).toBe('Widget Pro added to cart!');
    expect(step.on_action![0].transition).toBe('cart');
    expect(step.on_action![1].action_id).toBe('add_widget_lite');
    expect(step.on_action![1].respond).toBe('Widget Lite added to cart!');
    expect(step.on_action![1].transition).toBe('cart');

    // Verify step then
    expect(step.then).toBe('browse');
  });

  test('carousel with template variables preserves variable syntax in IR', () => {
    const ir = compileFromDSL(
      `
AGENT: Search_Agent
GOAL: "Search"
PERSONA: "Helper"

FLOW:
  results:
    REASONING: false
    RESPOND: "Results for {{query}}"
      CAROUSEL:
        - TITLE: "{{items.0.name}}"
          SUBTITLE: "{{items.0.price}}"
          IMAGE: "{{items.0.image}}"
          BUTTONS:
            - BUTTON: "Select" -> select_0
    THEN: done
  done:
    REASONING: false
    RESPOND: "Done"
`,
      'Search_Agent',
    );

    const cards = ir.flow!.definitions['results'].rich_content!.carousel!.cards;
    expect(cards[0].title).toBe('{{items.0.name}}');
    expect(cards[0].subtitle).toBe('{{items.0.price}}');
    expect(cards[0].image_url).toBe('{{items.0.image}}');
  });

  test('actions without carousel compile correctly', () => {
    const ir = compileFromDSL(
      `
AGENT: Survey_Agent
GOAL: "Survey"
PERSONA: "Surveyor"

FLOW:
  ask:
    REASONING: false
    RESPOND: "Rate your experience"
      ACTIONS:
        - BUTTON: "Great" -> rate_great
        - BUTTON: "OK" -> rate_ok
        - BUTTON: "Bad" -> rate_bad
    ON_ACTION:
      rate_great:
        RESPOND: "Thanks for the positive feedback!"
        TRANSITION: done
      rate_ok:
        RESPOND: "Thanks, we'll try to improve."
        TRANSITION: done
      rate_bad:
        RESPOND: "Sorry to hear that."
        TRANSITION: done
    THEN: ask
  done:
    REASONING: false
    RESPOND: "Survey complete"
`,
      'Survey_Agent',
    );

    const step = ir.flow!.definitions['ask'];
    expect(step.actions).toBeDefined();
    expect(step.actions!.elements).toHaveLength(3);
    expect(step.on_action).toHaveLength(3);
    expect(step.rich_content?.carousel).toBeUndefined();
  });
});
