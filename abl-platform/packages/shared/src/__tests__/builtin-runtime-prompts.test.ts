import { describe, expect, it } from 'vitest';
import {
  BUILT_IN_FILLER_PROMPT_TEMPLATE,
  CLONABLE_FILLER_PROMPT_TEMPLATE,
  CLONABLE_FILLER_PROMPT_VARIABLES,
} from '../prompts/builtin-runtime.js';

describe('built-in runtime prompts', () => {
  it('exposes a prompt-library compatible filler clone template without changing runtime placeholders', () => {
    expect(BUILT_IN_FILLER_PROMPT_TEMPLATE).toContain('{userMessage}');
    expect(CLONABLE_FILLER_PROMPT_TEMPLATE).toContain('{{userMessage}}');
    expect(CLONABLE_FILLER_PROMPT_TEMPLATE).not.toMatch(/(^|[^{])\{userMessage\}(?!})/);
    expect(CLONABLE_FILLER_PROMPT_TEMPLATE).toContain('{languageHint}');
    expect(CLONABLE_FILLER_PROMPT_TEMPLATE).toContain('{presenceHint}');
    expect(CLONABLE_FILLER_PROMPT_VARIABLES).toEqual(['userMessage']);
  });
});
