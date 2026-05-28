import { parseAgentBasedABL, type AgentBasedDocument } from '@abl/core';
import {
  behaviorProfileConfigKeyToName,
  isBehaviorProfileConfigKey,
} from './behavior-profile-files.js';

export interface BehaviorProfileConfigSource {
  key?: unknown;
  value?: unknown;
}

export interface ParsedBehaviorProfileDocuments {
  documents: AgentBasedDocument[];
  errors: string[];
}

export function parseBehaviorProfileDocumentsFromConfigSources(
  sources: Iterable<BehaviorProfileConfigSource>,
): ParsedBehaviorProfileDocuments {
  const documents: AgentBasedDocument[] = [];
  const errors: string[] = [];

  for (const source of sources) {
    if (typeof source.key !== 'string' || !isBehaviorProfileConfigKey(source.key)) {
      continue;
    }

    const profileName = behaviorProfileConfigKeyToName(source.key) ?? source.key;
    if (typeof source.value !== 'string' || source.value.trim().length === 0) {
      errors.push(`${profileName}: behavior profile content is empty`);
      continue;
    }

    const parseResult = parseAgentBasedABL(source.value);
    if (!parseResult.document) {
      errors.push(`${profileName}: behavior profile DSL did not produce a document`);
      continue;
    }

    if (parseResult.errors.length > 0) {
      errors.push(`${profileName}: ${parseResult.errors.map((error) => error.message).join(', ')}`);
      continue;
    }

    if (parseResult.document.meta.kind !== 'behavior_profile') {
      errors.push(`${profileName}: expected BEHAVIOR_PROFILE document`);
      continue;
    }

    documents.push(parseResult.document);
  }

  return { documents, errors };
}

export function parseBehaviorProfileDocumentsFromConfigVariables(
  configVariables: Record<string, string>,
): ParsedBehaviorProfileDocuments {
  return parseBehaviorProfileDocumentsFromConfigSources(
    Object.entries(configVariables).map(([key, value]) => ({ key, value })),
  );
}
