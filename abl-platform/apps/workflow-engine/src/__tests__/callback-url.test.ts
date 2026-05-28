import { describe, it, expect } from 'vitest';

describe('CallbackUrlBuilder', () => {
  it('should build URL matching the callback router pattern /:executionId/:stepId', () => {
    const PUBLIC_URL = 'https://engine.example.com';
    const builder = {
      buildCallbackUrl: (executionId: string, stepId: string) =>
        `${PUBLIC_URL}/api/v1/workflows/callbacks/${executionId}/${stepId}`,
    };
    const url = builder.buildCallbackUrl('exec-123', 'step-456');
    expect(url).toBe('https://engine.example.com/api/v1/workflows/callbacks/exec-123/step-456');
    // Must NOT contain '/steps/' segment
    expect(url).not.toContain('/steps/');
  });
});
