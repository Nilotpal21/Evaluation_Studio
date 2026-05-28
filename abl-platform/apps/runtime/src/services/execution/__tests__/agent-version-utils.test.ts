import { describe, it, expect } from 'vitest';
import {
  resolvePersistedAgentVersion,
  resolveRawVersionAlias,
  resolveVersionString,
} from '../agent-version-utils.js';

describe('agent-version-utils', () => {
  it('prefers exact raw-version matches', () => {
    expect(
      resolveVersionString(
        {
          rawVersions: {
            Billing_Agent: '2.4.1',
          },
          versions: {
            Billing_Agent: 24,
          },
        },
        'Billing_Agent',
      ),
    ).toBe('2.4.1');
  });

  it('matches normalized IR names against manifest rawVersions', () => {
    expect(
      resolveRawVersionAlias(
        {
          contractdataassistant: '0.1.0',
        },
        'Contract_Data_Assistant',
      ),
    ).toBe('0.1.0');
  });

  it('falls back to numeric versions when rawVersions are unavailable', () => {
    expect(
      resolveVersionString(
        {
          versions: {
            Contract_Data_Assistant: 7,
          },
        },
        'Contract_Data_Assistant',
      ),
    ).toBe('7');
  });

  it('falls back to the first available version and then 1.0', () => {
    expect(
      resolvePersistedAgentVersion(
        {
          rawVersions: {
            Other_Agent: '3.2.1',
          },
        },
        'Missing_Agent',
      ),
    ).toBe('3.2.1');
    expect(resolvePersistedAgentVersion(undefined, 'Missing_Agent')).toBe('1.0');
  });
});
