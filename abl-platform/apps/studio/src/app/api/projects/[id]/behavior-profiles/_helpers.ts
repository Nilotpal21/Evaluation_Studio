import type { BehaviorProfileAST } from '@abl/core';
import { parseBehaviorProfile } from '@abl/core/parser';
import {
  behaviorProfileNameToConfigKey,
  extractDependencies,
  extractBehaviorProfileNameFromDsl,
  spliceSections,
  validateBehaviorProfileSemantics,
  type SectionEdit,
} from '@agent-platform/project-io';
import { serializeConversationBehaviorBlock, serializeProfileToABL } from '@/lib/abl-serializers';
import type { ConversationBehaviorData } from '@/store/agent-detail-store';

export interface BehaviorProfileDocShape {
  key: string;
  value: string;
  updatedAt?: Date | string;
}

export interface AgentDslShape {
  name: string;
  dslContent: string;
}

export interface ParsedBehaviorProfileShape {
  name: string;
  priority: number;
  whenExpression: string;
  conversationBehavior?: ConversationBehaviorData;
  overrideCategories: string[];
  parseErrors: string[];
  semanticErrors: string[];
}

export function parseStoredBehaviorProfile(
  dslContent: string,
  fallbackName?: string,
): ParsedBehaviorProfileShape {
  const errors: Array<{ line: number; column: number; message: string }> = [];
  const ast = parseBehaviorProfile(dslContent.split(/\r?\n/), 0, errors);
  const name = extractBehaviorProfileNameFromDsl(dslContent) ?? fallbackName ?? 'unknown_profile';
  const parseErrors = errors.map((error) => `line ${error.line + 1}: ${error.message}`);
  const semanticValidation =
    parseErrors.length === 0
      ? validateBehaviorProfileSemantics(dslContent)
      : { compilationErrors: [] };

  return {
    name,
    priority: ast.priority,
    whenExpression: ast.when,
    conversationBehavior: ast.conversation as ConversationBehaviorData | undefined,
    overrideCategories: summarizeOverrideCategories(ast),
    parseErrors,
    semanticErrors: semanticValidation.compilationErrors,
  };
}

export function buildProfileUsageMap(agentDocs: AgentDslShape[]): Map<string, string[]> {
  const usage = new Map<string, Set<string>>();

  for (const agent of agentDocs) {
    const deps = extractDependencies(agent.dslContent);
    for (const dep of deps) {
      if (dep.type !== 'profile_use') {
        continue;
      }

      const profileName = dep.targetAgent;
      const users = usage.get(profileName) ?? new Set<string>();
      users.add(agent.name);
      usage.set(profileName, users);
    }
  }

  return new Map(
    [...usage.entries()].map(([profileName, users]) => [profileName, [...users].sort()]),
  );
}

export function buildStructuredBehaviorProfileDsl(input: {
  name: string;
  priority: number;
  whenExpression: string;
  conversationBehavior?: ConversationBehaviorData;
  baseDslContent?: string;
}): string {
  const baseDsl =
    input.baseDslContent && input.baseDslContent.trim().length > 0
      ? input.baseDslContent
      : serializeProfileToABL({
          name: input.name,
          priority: input.priority,
          when: input.whenExpression,
          conversationBehavior: input.conversationBehavior,
        });

  const edits: SectionEdit[] = [
    { section: 'PRIORITY', content: `PRIORITY: ${input.priority}` },
    { section: 'WHEN', content: `WHEN: ${input.whenExpression}` },
    {
      section: 'CONVERSATION',
      content: input.conversationBehavior
        ? serializeConversationBehaviorBlock(input.conversationBehavior)
        : null,
    },
  ];

  const spliced = spliceSections(baseDsl, edits);
  const withHeader = replaceBehaviorProfileHeader(spliced, input.name);

  return withHeader.endsWith('\n') ? withHeader : `${withHeader}\n`;
}

export function buildBehaviorProfileConfigKey(name: string): string {
  return behaviorProfileNameToConfigKey(name);
}

function replaceBehaviorProfileHeader(content: string, name: string): string {
  if (content.trim().length === 0) {
    return serializeProfileToABL({ name, priority: 10, when: 'true' });
  }

  if (/^\s*BEHAVIOR_PROFILE:\s*\S+/m.test(content)) {
    return content.replace(/^\s*BEHAVIOR_PROFILE:\s*\S+/m, `BEHAVIOR_PROFILE: ${name}`);
  }

  return `BEHAVIOR_PROFILE: ${name}\n\n${content.trimStart()}`;
}

function summarizeOverrideCategories(ast: BehaviorProfileAST): string[] {
  const categories: string[] = [];

  if (ast.instructions) {
    categories.push('instructions');
  }
  if (ast.constraints && ast.constraints.length > 0) {
    categories.push('constraints');
  }
  if (ast.response) {
    categories.push('response_rules');
  }
  if (ast.voice) {
    categories.push('voice');
  }
  if (
    ast.tools &&
    ((ast.tools.hide && ast.tools.hide.length > 0) || (ast.tools.add && ast.tools.add.length > 0))
  ) {
    categories.push('tools');
  }
  if (ast.gather) {
    categories.push('gather');
  }
  if (ast.flow) {
    categories.push('flow');
  }
  if (ast.conversation) {
    categories.push('conversation');
  }

  return categories;
}
