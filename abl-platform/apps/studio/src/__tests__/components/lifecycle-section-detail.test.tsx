/**
 * LifecycleSection Component Tests
 *
 * Tests for the lifecycle section: collapsed summary with hook count and
 * completion condition preview, expanded view with five sub-sections --
 * ON_START (respond + call), Error Handlers (type, respond, then),
 * Completion (when, respond), Memory (session vars, persistent paths,
 * remember/recall counts), and Hooks (configured hooks list). Also tests
 * empty state when nothing is configured.
 */

import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { LifecycleSection } from '../../components/agent-detail/LifecycleSection';
import type {
  LifecycleSectionData,
  ErrorHandlerData,
  CompletionConditionData,
  MemoryConfigData,
} from '../../store/agent-detail-store';

// =============================================================================
// TEST DATA
// =============================================================================

const toolCallError: ErrorHandlerData = {
  type: 'tool_call_failed',
  respond: 'Sorry, I encountered an error accessing the service.',
  then: 'retry',
};

const llmError: ErrorHandlerData = {
  type: 'llm_timeout',
  respond: 'The AI service is currently slow. Please try again.',
  then: 'escalate',
};

const goalComplete: CompletionConditionData = {
  when: 'user_goal_met === true',
  respond: 'Happy to help! Is there anything else?',
};

const maxTurnsComplete: CompletionConditionData = {
  when: 'turn_count > 20',
  respond: 'We have reached our conversation limit.',
};

const fullMemoryConfig: MemoryConfigData = {
  sessionVars: ['user_name', 'selected_plan', 'order_id'],
  persistentPaths: ['preferences.language', 'preferences.timezone'],
  rememberTriggers: 3,
  recallInstructions: 2,
};

const emptyMemoryConfig: MemoryConfigData = {
  sessionVars: [],
  persistentPaths: [],
  rememberTriggers: 0,
  recallInstructions: 0,
};

const fullLifecycle: LifecycleSectionData = {
  hasOnStart: true,
  onStartRespond: 'Welcome! How can I help you today?',
  onStartCall: 'initialize_session',
  hasHooks: true,
  hooks: ['before_agent', 'after_agent', 'before_turn', 'after_turn'],
  errorHandlers: [toolCallError, llmError],
  completionConditions: [goalComplete, maxTurnsComplete],
  memoryConfig: fullMemoryConfig,
};

const emptyLifecycle: LifecycleSectionData = {
  hasOnStart: false,
  hasHooks: false,
  hooks: [],
  errorHandlers: [],
  completionConditions: [],
  memoryConfig: emptyMemoryConfig,
};

// =============================================================================
// TESTS
// =============================================================================

describe('LifecycleSection', () => {
  it('renders collapsed with hook count and summary', () => {
    render(
      <LifecycleSection
        data={fullLifecycle}
        isExpanded={false}
        onToggle={() => {}}
        onChange={() => {}}
      />,
    );

    // Title is "Lifecycle"
    expect(screen.getByText('Lifecycle')).toBeInTheDocument();

    // Count badge shows total items (2 error handlers + 2 completions + 4 hooks + ON_START = 9)
    // Or a simpler count: let's look at what our component uses for count.
    // Summary text should mention hooks and completion
    expect(screen.getByText(/4 hooks/i)).toBeInTheDocument();
  });

  it('renders expanded with ON_START sub-section (respond + call)', () => {
    render(
      <LifecycleSection
        data={fullLifecycle}
        isExpanded={true}
        onToggle={() => {}}
        onChange={() => {}}
      />,
    );

    // ON_START sub-section header
    expect(screen.getByText('ON_START')).toBeInTheDocument();

    // Respond text (in textarea)
    expect(screen.getByDisplayValue('Welcome! How can I help you today?')).toBeInTheDocument();

    // Call action (in input)
    expect(screen.getByDisplayValue('initialize_session')).toBeInTheDocument();
  });

  it('shows error handlers with type, respond, then', () => {
    render(
      <LifecycleSection
        data={fullLifecycle}
        isExpanded={true}
        onToggle={() => {}}
        onChange={() => {}}
      />,
    );

    // Error Handlers sub-section header
    expect(screen.getByText('Error Handlers')).toBeInTheDocument();

    // Error handler types (in input elements)
    expect(screen.getByDisplayValue('tool_call_failed')).toBeInTheDocument();
    expect(screen.getByDisplayValue('llm_timeout')).toBeInTheDocument();

    // Error handler respond texts (in textarea elements)
    expect(
      screen.getByDisplayValue('Sorry, I encountered an error accessing the service.'),
    ).toBeInTheDocument();
    expect(
      screen.getByDisplayValue('The AI service is currently slow. Please try again.'),
    ).toBeInTheDocument();

    // Error handler then actions (in select elements)
    expect(screen.getByDisplayValue('retry')).toBeInTheDocument();
    expect(screen.getByDisplayValue('escalate')).toBeInTheDocument();
  });

  it('shows completion conditions with when and respond', () => {
    render(
      <LifecycleSection
        data={fullLifecycle}
        isExpanded={true}
        onToggle={() => {}}
        onChange={() => {}}
      />,
    );

    // Completion sub-section header
    expect(screen.getByText('Completion')).toBeInTheDocument();

    // Completion when expressions
    expect(screen.getByText('user_goal_met === true')).toBeInTheDocument();
    expect(screen.getByText('turn_count > 20')).toBeInTheDocument();

    // Completion respond texts
    expect(screen.getByText('Happy to help! Is there anything else?')).toBeInTheDocument();
    expect(screen.getByText('We have reached our conversation limit.')).toBeInTheDocument();
  });

  it('shows memory configuration (session vars, persistent paths)', () => {
    render(
      <LifecycleSection
        data={fullLifecycle}
        isExpanded={true}
        onToggle={() => {}}
        onChange={() => {}}
      />,
    );

    // Memory sub-section header
    expect(screen.getByText('Memory')).toBeInTheDocument();

    // Session variables
    expect(screen.getByText('user_name')).toBeInTheDocument();
    expect(screen.getByText('selected_plan')).toBeInTheDocument();
    expect(screen.getByText('order_id')).toBeInTheDocument();

    // Persistent paths
    expect(screen.getByText('preferences.language')).toBeInTheDocument();
    expect(screen.getByText('preferences.timezone')).toBeInTheDocument();

    // Remember and recall counts
    expect(screen.getByText(/3 remember/i)).toBeInTheDocument();
    expect(screen.getByText(/2 recall/i)).toBeInTheDocument();
  });

  it('shows configured hooks list', () => {
    render(
      <LifecycleSection
        data={fullLifecycle}
        isExpanded={true}
        onToggle={() => {}}
        onChange={() => {}}
      />,
    );

    // Hooks sub-section header
    expect(screen.getByText('Hooks')).toBeInTheDocument();

    // Hook names
    expect(screen.getByText('before_agent')).toBeInTheDocument();
    expect(screen.getByText('after_agent')).toBeInTheDocument();
    expect(screen.getByText('before_turn')).toBeInTheDocument();
    expect(screen.getByText('after_turn')).toBeInTheDocument();
  });

  it('renders empty state when nothing configured', () => {
    render(
      <LifecycleSection
        data={emptyLifecycle}
        isExpanded={false}
        onToggle={() => {}}
        onChange={() => {}}
      />,
    );

    // Title still shows
    expect(screen.getByText('Lifecycle')).toBeInTheDocument();

    // SectionCard handles empty state via isEmpty prop
    expect(screen.getByText(/no lifecycle hooks configured/i)).toBeInTheDocument();
  });
});
