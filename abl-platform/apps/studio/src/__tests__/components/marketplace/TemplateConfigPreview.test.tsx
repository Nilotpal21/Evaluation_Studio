/**
 * TemplateConfigPreview Component Tests
 *
 * @vitest-environment happy-dom
 */
import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TemplateConfigPreview } from '../../../components/marketplace/TemplateConfigPreview';

describe('TemplateConfigPreview', () => {
  it('renders config fields from JSON Schema-style schema', () => {
    const schema = {
      properties: {
        api_key: {
          type: 'string',
          description: 'API key for external service',
          default: 'sk-...',
        },
        max_retries: {
          type: 'number',
          description: 'Maximum retry attempts',
          default: 3,
        },
      },
    };

    render(<TemplateConfigPreview schema={schema} />);
    expect(screen.getByText('api_key')).toBeTruthy();
    expect(screen.getByText('string')).toBeTruthy();
    expect(screen.getByText('sk-...')).toBeTruthy();
    expect(screen.getByText('API key for external service')).toBeTruthy();
    expect(screen.getByText('max_retries')).toBeTruthy();
    expect(screen.getByText('number')).toBeTruthy();
    expect(screen.getByText('3')).toBeTruthy();
  });

  it('renders flat key-value config', () => {
    const schema = {
      greeting: 'Hello!',
      timeout: 30,
    };

    render(<TemplateConfigPreview schema={schema} />);
    expect(screen.getByText('greeting')).toBeTruthy();
    expect(screen.getByText('timeout')).toBeTruthy();
  });

  it('shows empty state for null schema', () => {
    render(<TemplateConfigPreview schema={null} />);
    const text = screen.getByText(/config/i);
    expect(text).toBeTruthy();
  });

  it('shows empty state for schema with no fields', () => {
    render(<TemplateConfigPreview schema={{}} />);
    const text = screen.getByText(/config/i);
    expect(text).toBeTruthy();
  });
});
