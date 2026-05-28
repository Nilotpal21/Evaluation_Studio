import { describe, it, expect } from 'vitest';
import { matchProvidersForToolName } from '../integration-hints';

describe('matchProvidersForToolName', () => {
  it('matches send_message to chat platforms', () => {
    expect(matchProvidersForToolName('send_message')).toMatchObject({
      providerKeys: ['slack', 'discord', 'teams'],
    });
  });

  it('matches look_up_ticket to support providers', () => {
    expect(matchProvidersForToolName('look_up_ticket')).toMatchObject({
      providerKeys: ['zendesk', 'intercom', 'servicenow'],
    });
  });

  it('matches send_email to email providers', () => {
    expect(matchProvidersForToolName('send_email')).toMatchObject({
      providerKeys: ['gmail', 'sendgrid', 'outlook'],
    });
  });

  it('returns null for unmatched names', () => {
    expect(matchProvidersForToolName('completely_random_xyz')).toBeNull();
  });

  it('is case-insensitive', () => {
    expect(matchProvidersForToolName('SEND_EMAIL')).toMatchObject({
      providerKeys: ['gmail', 'sendgrid', 'outlook'],
    });
  });
});
