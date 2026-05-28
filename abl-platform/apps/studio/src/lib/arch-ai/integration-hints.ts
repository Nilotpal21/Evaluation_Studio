export interface IntegrationHint {
  toolNamePattern: RegExp;
  providerKeys: string[];
  rationale: string;
}

export const INTEGRATION_HINTS: IntegrationHint[] = [
  {
    toolNamePattern: /\b(send|post)_(?:slack_)?message\b/i,
    providerKeys: ['slack', 'discord', 'teams'],
    rationale: 'Sending messages to a chat platform.',
  },
  {
    toolNamePattern: /\blook(?:_)?up_ticket\b/i,
    providerKeys: ['zendesk', 'intercom', 'servicenow'],
    rationale: 'Looking up support tickets.',
  },
  {
    toolNamePattern: /\bcreate_lead\b|\bfind_contact\b/i,
    providerKeys: ['salesforce', 'hubspot'],
    rationale: 'CRM lead/contact operations.',
  },
  {
    toolNamePattern: /\bsend_email\b/i,
    providerKeys: ['gmail', 'sendgrid', 'outlook'],
    rationale: 'Sending email.',
  },
  {
    toolNamePattern: /\b(?:create|update)_(?:row|record)\b/i,
    providerKeys: ['airtable', 'google_sheets', 'notion'],
    rationale: 'Database/spreadsheet writes.',
  },
];

export function matchProvidersForToolName(
  name: string,
): { providerKeys: string[]; rationale: string } | null {
  for (const hint of INTEGRATION_HINTS) {
    if (hint.toolNamePattern.test(name)) {
      return { providerKeys: hint.providerKeys, rationale: hint.rationale };
    }
  }
  return null;
}
