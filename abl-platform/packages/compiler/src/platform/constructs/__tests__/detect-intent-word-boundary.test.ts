import { describe, it, expect } from 'vitest';
import { detectIntent, detectIntentLexically } from '../utils.js';

describe('detectIntent word-boundary matching', () => {
  const ctx = {};

  it('should match explicit KEYWORDS for a semantic intent id', () => {
    expect(
      detectIntent('I need help', [{ intent: 'help_request', keywords: ['help'] } as any], ctx),
    ).toEqual({
      intent: 'help_request',
      matched: 'help',
    });
  });

  it('should NOT match a keyword as a substring of another word', () => {
    expect(
      detectIntent(
        'I found it helpful',
        [{ intent: 'help_request', keywords: ['help'] } as any],
        ctx,
      ),
    ).toBeNull();
    expect(
      detectIntent(
        'unhelpful response',
        [{ intent: 'help_request', keywords: ['help'] } as any],
        ctx,
      ),
    ).toBeNull();
  });

  it('should match a KEYWORDS entry at the start of the message', () => {
    expect(
      detectIntent('help me please', [{ intent: 'help_request', keywords: ['help'] } as any], ctx),
    ).not.toBeNull();
  });

  it('should match a KEYWORDS entry at the end of the message', () => {
    expect(
      detectIntent('I need help', [{ intent: 'help_request', keywords: ['help'] } as any], ctx),
    ).not.toBeNull();
  });

  it('should handle KEYWORDS with regex metacharacters', () => {
    expect(
      detectIntent('I use C++ daily', [{ intent: 'cpp_help', keywords: ['C++'] } as any], ctx),
    ).not.toBeNull();
    expect(
      detectIntent('nice car', [{ intent: 'cpp_help', keywords: ['C++'] } as any], ctx),
    ).toBeNull();
  });

  it('should match multi-word KEYWORDS phrases at word boundaries', () => {
    expect(
      detectIntent(
        'cancel order please',
        [{ intent: 'cancel_request', keywords: ['cancel order'] } as any],
        ctx,
      ),
    ).not.toBeNull();
    expect(
      detectIntent(
        'I can cancel orders anytime',
        [{ intent: 'cancel_request', keywords: ['cancel order'] } as any],
        ctx,
      ),
    ).toBeNull();
  });

  it('should use declaration order as the tiebreaker within lexical matches', () => {
    expect(
      detectIntent(
        'please help',
        [
          { intent: 'help_request', keywords: ['help'] },
          { intent: 'support_request', keywords: ['help'] },
        ] as any,
        ctx,
      ),
    ).toEqual({ intent: 'help_request', matched: 'help' });
  });

  it('should not tokenize semantic INTENT values when KEYWORDS are omitted', () => {
    expect(detectIntent('please assist me', [{ intent: 'help assist' } as any], ctx)).toBeNull();
  });

  it('should keep detectIntent exact while allowing normalized lexical matching as an opt-in', () => {
    expect(
      detectIntent(
        'show me nearby branches',
        [{ intent: 'branch_locator', keywords: ['branch'] }],
        ctx,
      ),
    ).toBeNull();

    expect(
      detectIntentLexically(
        'show me nearby branches',
        [{ intent: 'branch_locator', keywords: ['branch'] }],
        ctx,
        { allowNormalized: true },
      ),
    ).toEqual({
      intent: 'branch_locator',
      matched: 'branch',
      matchType: 'normalized',
      candidateIndex: 0,
    });
  });

  it('should preserve declaration order for normalized lexical matches', () => {
    expect(
      detectIntentLexically(
        'find branches near me',
        [
          { intent: 'branch_locator', keywords: ['branch'] },
          { intent: 'branch_hours', keywords: ['branch'] },
        ],
        ctx,
        { allowNormalized: true },
      ),
    ).toEqual({
      intent: 'branch_locator',
      matched: 'branch',
      matchType: 'normalized',
      candidateIndex: 0,
    });
  });
});
