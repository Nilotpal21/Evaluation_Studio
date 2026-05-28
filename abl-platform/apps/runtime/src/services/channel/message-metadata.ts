import type { MessageMetadata } from '@abl/compiler/platform/core/types.js';

import type { ResponseMessageMetadata } from './response-provenance.js';

export type AssistantMessageMetadata = ResponseMessageMetadata | Partial<MessageMetadata>;

export function withAgentNameMetadata(
  metadata: undefined,
  agentName: string | undefined,
): Partial<MessageMetadata> | undefined;
export function withAgentNameMetadata<T extends object>(
  metadata: T,
  agentName: string | undefined,
): T;
export function withAgentNameMetadata<T extends object>(
  metadata: T | undefined,
  agentName: string | undefined,
): T | Partial<MessageMetadata> | undefined;
export function withAgentNameMetadata<T extends object>(
  metadata: T | undefined,
  agentName: string | undefined,
): T | Partial<MessageMetadata> | undefined {
  if (!agentName) return metadata;

  return {
    ...(metadata ?? {}),
    agentName,
  } as T | Partial<MessageMetadata>;
}
