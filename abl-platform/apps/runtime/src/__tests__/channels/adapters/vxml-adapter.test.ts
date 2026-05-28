import { describe, expect, it } from 'vitest';
import { VxmlAdapter } from '../../../channels/adapters/vxml-adapter.js';

describe('VxmlAdapter', () => {
  it('renders barge-in and pause timeout transport controls', () => {
    const adapter = new VxmlAdapter();

    const xml = adapter.buildVxmlResponse('Hello', 'https://runtime.example/hook', 'call-1', {
      bargeIn: false,
      timeout: '1s',
    });

    expect(xml).toContain('<property name="bargein" value="false"/>');
    expect(xml).toContain('<property name="timeout" value="1s"/>');
  });
});
