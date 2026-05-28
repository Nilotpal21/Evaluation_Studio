import { describe, expect, it } from 'vitest';
import { LineAdapter } from '../../../channels/adapters/line-adapter.js';

describe('LineAdapter action events', () => {
  const adapter = new LineAdapter();

  it('rejects malformed postback formData at adapter ingress', () => {
    expect(() =>
      adapter.buildNormalizedMessage({
        destination: 'line-destination',
        events: [
          {
            type: 'postback',
            timestamp: 1700000000000,
            source: { type: 'user', userId: 'line-user-1' },
            postback: {
              data: 'route_agent',
              params: { constructor: 'polluted' },
            },
          },
        ],
      }),
    ).toThrow(/Invalid formData in action_submit/);
  });
});
