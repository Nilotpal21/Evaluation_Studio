/**
 * ToolsSection Component Tests
 *
 * Tests for the tools section: collapsed summary with tool count/name chips,
 * expanded tool cards with parameters table, binding config, hints badges,
 * and the add tool button.
 */

import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { ToolsSection } from '../../components/agent-detail/ToolsSection';
import type { ToolSectionData } from '../../store/agent-detail-store';

// =============================================================================
// TEST DATA
// =============================================================================

const httpTool: ToolSectionData = {
  name: 'search_hotels',
  description: 'Search available hotels by location and date range',
  parameters: [
    { name: 'location', type: 'string', required: true, description: 'City or region' },
    { name: 'check_in', type: 'date', required: true },
    { name: 'check_out', type: 'date', required: true },
    { name: 'guests', type: 'number', required: false, defaultValue: 1 },
  ],
  returns: { type: 'object' },
  toolType: 'http',
  httpBinding: { endpoint: 'https://api.hotels.com/search', method: 'POST' },
  hints: { cacheable: true, latency: 'high', side_effects: false },
};

const mcpTool: ToolSectionData = {
  name: 'get_weather',
  description: 'Fetch current weather data for a location',
  parameters: [{ name: 'city', type: 'string', required: true }],
  returns: { type: 'object' },
  toolType: 'mcp',
  mcpBinding: { server: 'weather-server', tool: 'current_weather' },
  hints: { cacheable: false },
};

const sandboxTool: ToolSectionData = {
  name: 'process_payment',
  description: 'Process a payment transaction',
  parameters: [
    { name: 'amount', type: 'number', required: true },
    { name: 'currency', type: 'string', required: false, defaultValue: 'USD' },
  ],
  returns: { type: 'object' },
  toolType: 'sandbox',
  hints: { side_effects: true },
};

const mockTools: ToolSectionData[] = [httpTool, mcpTool, sandboxTool];

// =============================================================================
// TESTS
// =============================================================================

describe('ToolsSection', () => {
  it('renders collapsed with tool count and name chips', () => {
    render(
      <ToolsSection data={mockTools} isExpanded={false} onToggle={() => {}} onChange={() => {}} />,
    );

    // Title rendered via i18n key
    expect(screen.getByText('Tools')).toBeInTheDocument();

    // Count badge shows "3"
    expect(screen.getByText('3')).toBeInTheDocument();

    // Tool name chips visible when collapsed
    expect(screen.getByText('search_hotels')).toBeInTheDocument();
    expect(screen.getByText('get_weather')).toBeInTheDocument();
    expect(screen.getByText('process_payment')).toBeInTheDocument();
  });

  it('renders expanded with tool cards showing name and description', () => {
    render(
      <ToolsSection data={mockTools} isExpanded={true} onToggle={() => {}} onChange={() => {}} />,
    );

    // Tool names displayed in input elements
    expect(screen.getByDisplayValue('search_hotels')).toBeInTheDocument();
    expect(screen.getByDisplayValue('get_weather')).toBeInTheDocument();
    expect(screen.getByDisplayValue('process_payment')).toBeInTheDocument();

    // Descriptions displayed in textarea elements
    expect(
      screen.getByDisplayValue('Search available hotels by location and date range'),
    ).toBeInTheDocument();
    expect(
      screen.getByDisplayValue('Fetch current weather data for a location'),
    ).toBeInTheDocument();
    expect(screen.getByDisplayValue('Process a payment transaction')).toBeInTheDocument();
  });

  it('shows parameters as inline editable rows in tool card', () => {
    render(
      <ToolsSection data={[httpTool]} isExpanded={true} onToggle={() => {}} onChange={() => {}} />,
    );

    // Parameter names in input elements
    expect(screen.getByDisplayValue('location')).toBeInTheDocument();
    expect(screen.getByDisplayValue('check_in')).toBeInTheDocument();
    expect(screen.getByDisplayValue('check_out')).toBeInTheDocument();
    expect(screen.getByDisplayValue('guests')).toBeInTheDocument();

    // Types in select elements
    expect(screen.getByDisplayValue('string')).toBeInTheDocument();
    expect(screen.getAllByDisplayValue('date')).toHaveLength(2);
    expect(screen.getByDisplayValue('number')).toBeInTheDocument();

    // Default value in input element
    expect(screen.getByDisplayValue('1')).toBeInTheDocument();
  });

  it('shows binding badge (HTTP, MCP) on tool chips', () => {
    render(
      <ToolsSection data={mockTools} isExpanded={false} onToggle={() => {}} onChange={() => {}} />,
    );

    // Binding type badges visible on collapsed chips
    expect(screen.getByText('HTTP')).toBeInTheDocument();
    expect(screen.getByText('MCP')).toBeInTheDocument();
    expect(screen.getByText('Sandbox')).toBeInTheDocument();
  });

  it('shows [+ Add Tool] button in expanded state', () => {
    render(
      <ToolsSection data={mockTools} isExpanded={true} onToggle={() => {}} onChange={() => {}} />,
    );

    const addButton = screen.getByRole('button', { name: /add inline tool/i });
    expect(addButton).toBeInTheDocument();
  });

  it('renders empty state when no tools', () => {
    render(<ToolsSection data={[]} isExpanded={false} onToggle={() => {}} onChange={() => {}} />);

    // Title still shows
    expect(screen.getByText('Tools')).toBeInTheDocument();

    expect(screen.getByText(/No tools defined/)).toBeInTheDocument();
  });

  it('shows binding config in expanded tool cards', () => {
    render(
      <ToolsSection
        data={[httpTool, mcpTool]}
        isExpanded={true}
        onToggle={() => {}}
        onChange={() => {}}
      />,
    );

    // HTTP binding details
    expect(screen.getByText(/https:\/\/api\.hotels\.com\/search/)).toBeInTheDocument();
    expect(screen.getByText(/POST/)).toBeInTheDocument();

    // MCP binding details
    expect(screen.getByText(/weather-server/)).toBeInTheDocument();
    expect(screen.getByText(/current_weather/)).toBeInTheDocument();
  });

  it('shows tool hint badges in expanded cards', () => {
    render(
      <ToolsSection data={[httpTool]} isExpanded={true} onToggle={() => {}} onChange={() => {}} />,
    );

    // Hint badges (i18n keys)
    expect(screen.getByText('cacheable')).toBeInTheDocument();
    expect(screen.getByText('latency: high')).toBeInTheDocument();
  });

  it('shows return type in expanded tool cards', () => {
    render(
      <ToolsSection data={[httpTool]} isExpanded={true} onToggle={() => {}} onChange={() => {}} />,
    );

    expect(screen.getByDisplayValue('object')).toBeInTheDocument();
  });
});
