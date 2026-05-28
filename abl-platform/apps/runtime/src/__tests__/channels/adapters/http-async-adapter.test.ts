import { describe, it, expect } from 'vitest';
import { HttpAsyncAdapter } from '../../../channels/adapters/http-async-adapter.js';
import type { RichContentIR } from '@abl/compiler';

describe('HttpAsyncAdapter.transformOutput', () => {
  const adapter = new HttpAsyncAdapter();

  it('passes rich content through in channel output for webhook consumers', () => {
    const richContent: RichContentIR = {
      markdown: '# Confirmation',
      table: '{"columns":["id"],"rows":[["A-1"]]}',
    };

    const result = adapter.transformOutput('Done', undefined, richContent);

    expect(result).toEqual({
      kind: 'structured_payload',
      text: 'Done',
      richContent,
    });
  });
});
