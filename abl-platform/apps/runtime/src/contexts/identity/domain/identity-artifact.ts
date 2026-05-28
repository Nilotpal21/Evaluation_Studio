/**
 * Identity Artifact Value Object
 *
 * Represents a channel-specific identity artifact (cookie, device ID, phone, etc.)
 * with its hashed value for secure storage and session resolution.
 * Raw values are hashed with SHA-256 and never persisted in plaintext.
 */

import { createHash } from 'node:crypto';
import type { ChannelArtifactType } from '@agent-platform/shared-auth';

export interface IdentityArtifact {
  readonly rawValue: string;
  readonly artifactType: ChannelArtifactType;
  readonly hashedValue: string;
}

/** Hash a raw artifact value using SHA-256. Returns a 64-char hex string. */
export function hash(rawValue: string): string {
  return createHash('sha256').update(rawValue).digest('hex');
}

/** Create an IdentityArtifact from a raw value and artifact type. */
export function create(rawValue: string, artifactType: ChannelArtifactType): IdentityArtifact {
  return {
    rawValue,
    artifactType,
    hashedValue: hash(rawValue),
  };
}
