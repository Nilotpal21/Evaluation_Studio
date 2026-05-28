/**
 * DemoConversation Component Tests
 *
 * @vitest-environment happy-dom
 */
import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { DemoConversation } from '../../../components/marketplace/DemoConversation';

describe('DemoConversation', () => {
  it('renders alternating user/agent message bubbles', () => {
    render(
      <DemoConversation
        messages={[
          { role: 'user', content: 'Hello, I need help' },
          { role: 'agent', content: 'Sure, how can I assist you?' },
          { role: 'user', content: 'I have a billing question' },
        ]}
      />,
    );
    expect(screen.getByText('Hello, I need help')).toBeTruthy();
    expect(screen.getByText('Sure, how can I assist you?')).toBeTruthy();
    expect(screen.getByText('I have a billing question')).toBeTruthy();
  });

  it('treats assistant role as agent', () => {
    const { container } = render(
      <DemoConversation
        messages={[
          { role: 'user', content: 'User message' },
          { role: 'assistant', content: 'Assistant message' },
        ]}
      />,
    );
    // Both messages should render
    expect(screen.getByText('User message')).toBeTruthy();
    expect(screen.getByText('Assistant message')).toBeTruthy();
    // Agent messages have flex-row-reverse
    const reverseElements = container.querySelectorAll('.flex-row-reverse');
    expect(reverseElements.length).toBe(1);
  });

  it('returns null for empty messages array', () => {
    const { container } = render(<DemoConversation messages={[]} />);
    expect(container.innerHTML).toBe('');
  });
});
