/**
 * SDKChannel hosted exchange auth storage tests.
 *
 * Validates that:
 * - Hosted exchange auth metadata fields exist in the schema
 * - Legacy secretKey/HMAC persistence fields are gone
 * - The auth lookup index is present for secret-prefix resolution
 */

import { describe, it, expect } from 'vitest';
import { SDKChannel } from '../models/sdk-channel.model.js';

describe('SDKChannel hosted exchange auth schema', () => {
  it('schema has hosted exchange auth metadata fields', () => {
    const schema = SDKChannel.schema;
    expect(schema.path('authMode')).toBeDefined();
    expect(schema.path('serverSecretHash')).toBeDefined();
    expect(schema.path('serverSecretSalt')).toBeDefined();
    expect(schema.path('serverSecretPrefix')).toBeDefined();
    expect(schema.path('serverSecretLastRotatedAt')).toBeDefined();
  });

  it('removes legacy SDK HMAC secret persistence fields', () => {
    const schema = SDKChannel.schema;
    expect(schema.path('secretKey')).toBeUndefined();
    expect(schema.path('hmacEnforcement')).toBeUndefined();
  });

  it('indexes hosted exchange secrets by auth mode and secret prefix', () => {
    const schema = SDKChannel.schema;
    const hostedExchangeIndex = schema
      .indexes()
      .find(([fields]) => fields.authMode === 1 && fields.serverSecretPrefix === 1);

    expect(hostedExchangeIndex).toBeDefined();
  });
});
