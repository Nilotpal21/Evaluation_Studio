import { serializeToolFormToDsl } from '@agent-platform/shared/tools';
import { describe, expect, test } from 'vitest';

import { httpConfigToToolForm, toolFormToHttpConfig } from '../form-adapters';
import type { HttpConfig } from '../shared-types';

describe('httpConfigToToolForm', () => {
  test('serializes only API key auth fields after auth type is switched back from bearer', () => {
    const toggledConfig: HttpConfig = {
      endpoint: 'https://api.example.com/weather',
      method: 'GET',
      authType: 'api_key',
      authConfig: {
        headerName: 'X-API-Key',
        apiKey: '{{secrets.WEATHER_API_KEY}}',
        token: '{{secrets.STALE_BEARER_TOKEN}}',
      },
    };

    const form = httpConfigToToolForm('weather_lookup', 'Weather lookup', toggledConfig, null);
    const dsl = serializeToolFormToDsl(form);

    expect(dsl).toContain('  auth: api_key');
    expect(dsl).toContain('  auth_config:');
    expect(dsl).toContain('    api_key: "{{secrets.WEATHER_API_KEY}}"');
    expect(dsl).toContain('    header_name: X-API-Key');
    expect(dsl).not.toContain('    token: "{{secrets.STALE_BEARER_TOKEN}}"');
  });

  test('serializes only bearer auth fields after auth type is switched from API key', () => {
    const toggledConfig: HttpConfig = {
      endpoint: 'https://api.example.com/weather',
      method: 'GET',
      authType: 'bearer',
      authConfig: {
        token: '{{secrets.WEATHER_BEARER_TOKEN}}',
        headerName: 'X-API-Key',
        apiKey: '{{secrets.STALE_API_KEY}}',
      },
    };

    const form = httpConfigToToolForm('weather_lookup', 'Weather lookup', toggledConfig, null);
    const dsl = serializeToolFormToDsl(form);

    expect(dsl).toContain('  auth: bearer');
    expect(dsl).toContain('  auth_config:');
    expect(dsl).toContain('    token: "{{secrets.WEATHER_BEARER_TOKEN}}"');
    expect(dsl).not.toContain('    api_key: "{{secrets.STALE_API_KEY}}"');
    expect(dsl).not.toContain('    header_name: X-API-Key');
  });

  test('normalizes stale auth fields when loading a form into Studio config', () => {
    const config = toolFormToHttpConfig({
      name: 'weather_lookup',
      toolType: 'http',
      description: 'Weather lookup',
      parameters: [],
      returnType: 'object',
      endpoint: 'https://api.example.com/weather',
      method: 'GET',
      auth: 'api_key',
      authConfig: {
        headerName: 'X-API-Key',
        apiKey: '{{secrets.WEATHER_API_KEY}}',
        token: '{{secrets.STALE_BEARER_TOKEN}}',
      },
    });

    expect(config.authConfig).toEqual({
      headerName: 'X-API-Key',
      apiKey: '{{secrets.WEATHER_API_KEY}}',
    });
  });
});
