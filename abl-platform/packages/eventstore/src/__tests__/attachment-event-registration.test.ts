import { describe, expect, it } from 'vitest';
import { eventRegistry } from '../schema/index.js';

describe('attachment event registration', () => {
  it('registers attachment lifecycle platform events', () => {
    expect(eventRegistry.has('attachment.uploaded')).toBe(true);
    expect(eventRegistry.has('attachment.processed')).toBe(true);
    expect(eventRegistry.has('attachment.preprocessed')).toBe(true);
  });

  it('registers channel response events used by channel delivery tracing', () => {
    expect(eventRegistry.has('channel.response.sent')).toBe(true);
  });
});
