import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';

const mockMutate = vi.fn();
const mockSwrReturn = {
  data: undefined as unknown,
  error: undefined as unknown,
  isLoading: false,
  mutate: mockMutate,
};

vi.mock('swr', () => ({
  default: vi.fn(() => mockSwrReturn),
}));

import { useAvailableConnectors } from '../useAvailableConnectors';

describe('useAvailableConnectors', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(mockSwrReturn, {
      data: undefined,
      error: undefined,
      isLoading: false,
      mutate: mockMutate,
    });
  });

  it('hides utility connectors from connection surfaces while keeping auth-aware entries', () => {
    mockSwrReturn.data = {
      success: true,
      data: [
        {
          name: 'http',
          displayName: 'HTTP',
          availableAuthTypes: ['api_key'],
        },
        {
          name: 'postgres',
          displayName: 'Postgres',
          availableAuthTypes: ['basic'],
        },
        {
          name: 'shopify',
          displayName: 'Shopify',
          availableAuthTypes: ['oauth2', 'oauth2_client_credentials', 'api_key'],
        },
      ],
    };

    const { result } = renderHook(() => useAvailableConnectors('proj-1'));

    expect(result.current.connectors.map((connector) => connector.name)).toEqual(['shopify']);
  });
});
