import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { isYamlFormat, parseAgentBasedABL, parseYamlABL } from '@abl/core';
import { describe, expect, test } from 'vitest';

import { HANDOFF_ON_RETURN_ACTION_VALUES } from '../../platform/contracts/contract-source-data.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../../../');

interface LongFormSurface {
  path: string;
  mustContain?: string[];
  mustNotContain?: string[];
  mustNotMatch?: RegExp[];
  validateCodeBlocks?: boolean;
}

const LONG_FORM_SURFACES: LongFormSurface[] = [
  {
    path: 'packages/arch-ai/src/knowledge/cards/generated/handoff-delegate.ts',
    mustContain: ['RETURN_HANDLERS', 'memory_grants', 'history: auto'],
    mustNotContain: ['ON_RETURN_MAP', 'grant_memory', 'last_N', 'last_<n>'],
  },
  {
    path: 'packages/arch-ai/src/knowledge/cards/generated/cross-agent-contracts.ts',
    mustContain: ['RETURN_HANDLERS', 'memory_grants'],
    mustNotContain: ['ON_RETURN_MAP', 'grant_memory'],
  },
  {
    path: 'packages/arch-ai/src/knowledge/cards/generated/memory-full.ts',
    mustContain: ['execution_tree', 'session:start'],
    mustNotContain: ['session_start', 'grant_memory'],
  },
  {
    path: 'packages/academy/content/modules/multi-agent-fundamentals/content.md',
    mustContain: ['memory_grants', 'history', 'mode: last_n'],
    mustNotContain: ['grant_memory', 'last_N', 'last_<n>'],
  },
  {
    path: 'packages/academy/content/modules/multi-agent-reference/content.md',
    mustContain: ['RETURN_HANDLERS', 'memory_grants', 'auto', 'mode: last_n'],
    mustNotContain: ['The four strategies', 'grant_memory', 'ON_RETURN_MAP', 'last_N', 'last_<n>'],
    mustNotMatch: [/^\s*MAP:\s*$/m, /history:\s*last_[0-9]+/],
    validateCodeBlocks: true,
  },
  {
    path: 'packages/academy/content/modules/multi-agent-reference/quiz.json',
    mustContain: ['auto', 'summary_only', 'full', 'mode: last_n', 'count: 10'],
    mustNotContain: ['The four strategies', 'last_N', 'last_n: 10', 'last_<n>', 'last_10'],
  },
  {
    path: 'packages/academy/content/modules/patterns-deployment/content.md',
    mustContain: ['ESCALATE:', 'RETURN_HANDLERS'],
    mustNotContain: ['Human_Agent', 'ON_RETURN_MAP'],
    validateCodeBlocks: true,
  },
  {
    path: 'packages/academy/content/modules/orchestration-patterns/content.md',
    mustContain: ['RETURN_HANDLERS'],
    mustNotContain: ['grant_memory', 'ON_RETURN_MAP'],
    validateCodeBlocks: true,
  },
  {
    path: 'apps/studio/public/agent-anatomy/coordination.html',
    mustContain: ['RETURN_HANDLERS', 'history: auto', 'mode: last_n'],
    mustNotContain: ['ON_RETURN_MAP', 'history: summary_only', 'last_N', 'last_<n>', 'last_5'],
    validateCodeBlocks: true,
  },
  {
    path: 'apps/studio/public/agent-anatomy/index.html',
    mustContain: ['history: auto', 'billing_follow_up'],
    mustNotContain: ['history: summary_only'],
  },
  {
    path: 'apps/studio/public/agent-anatomy/workflows.html',
    mustContain: ['history: auto'],
    mustNotContain: ['history: summary_only'],
  },
  {
    path: 'apps/studio/public/agent-anatomy/monaco-editor-wireframe.html',
    mustContain: ['auto ▾', 'history: auto'],
    mustNotContain: ['summary_only ▾', 'history: summary_only'],
  },
];

function readRepoFile(relativePath: string): string {
  return readFileSync(path.join(REPO_ROOT, relativePath), 'utf8');
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&nbsp;/g, ' ')
    .replace(/&mdash;/g, '-')
    .replace(/&ndash;/g, '-')
    .replace(/&rsaquo;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function stripHtmlTags(value: string): string {
  return decodeHtmlEntities(value.replace(/<[^>]+>/g, ''));
}

function toAssertionText(relativePath: string, content: string): string {
  if (relativePath.endsWith('.html')) {
    return stripHtmlTags(content);
  }
  return content;
}

function extractFencedCodeBlocks(content: string): string[] {
  const blocks: string[] = [];
  const fencePattern = /```(?:[a-zA-Z0-9_-]+)?\n([\s\S]*?)```/g;
  for (const match of content.matchAll(fencePattern)) {
    blocks.push(match[1]);
  }
  return blocks;
}

function extractHtmlPreBlocks(content: string): string[] {
  const blocks: string[] = [];
  const prePattern = /<pre[^>]*>([\s\S]*?)<\/pre>/g;
  for (const match of content.matchAll(prePattern)) {
    blocks.push(stripHtmlTags(match[1]));
  }
  return blocks;
}

function getCodeBlocks(relativePath: string, content: string): string[] {
  if (relativePath.endsWith('.html')) {
    return extractHtmlPreBlocks(content);
  }
  return extractFencedCodeBlocks(content);
}

function dedent(value: string): string {
  const lines = value.replace(/\r/g, '').split('\n');
  while (lines.length > 0 && lines[0]?.trim() === '') {
    lines.shift();
  }
  while (lines.length > 0 && lines[lines.length - 1]?.trim() === '') {
    lines.pop();
  }
  const nonEmpty = lines.filter((line) => line.trim() !== '');
  if (nonEmpty.length === 0) {
    return '';
  }
  const indent = Math.min(
    ...nonEmpty.map((line) => {
      const match = line.match(/^\s*/);
      return match ? match[0].length : 0;
    }),
  );
  return lines
    .map((line) => line.slice(Math.min(indent, line.length)))
    .join('\n')
    .trim();
}

function looksLikeAblSnippet(snippet: string): boolean {
  return (
    /(?:^|\n)(?:AGENT|SUPERVISOR|HANDOFF|DELEGATE|ESCALATE|MEMORY|RETURN_HANDLERS|HOOKS|ON_START|CONSTRAINTS|FLOW):/m.test(
      snippet,
    ) ||
    /(?:^|\n)(?:agent|supervisor|handoff|delegate|escalate|memory|return_handlers|hooks|on_start|constraints|flow):/m.test(
      snippet,
    )
  );
}

function prepareSnippetForParsing(snippet: string): string | null {
  const normalized = dedent(snippet);
  if (!normalized || !looksLikeAblSnippet(normalized)) {
    return null;
  }

  if (
    /^(AGENT:|SUPERVISOR:|agent:|supervisor:)/m.test(normalized) ||
    /(?:^|\n)(AGENT:|SUPERVISOR:|agent:|supervisor:)/m.test(normalized)
  ) {
    return normalized;
  }

  if (isYamlFormat(normalized)) {
    return `agent: ContractSurfaceExample\ngoal: "Validate long-form example"\n\n${normalized}`;
  }

  return `AGENT: ContractSurfaceExample\nGOAL: "Validate long-form example"\n\n${normalized}`;
}

function splitLegacyDocuments(snippet: string): string[] {
  if (isYamlFormat(snippet)) {
    return [snippet];
  }
  return snippet
    .split(/(?=^(?:AGENT|SUPERVISOR):\s)/m)
    .map((part) => part.trim())
    .filter(Boolean);
}

function ensureGoalForValidation(snippet: string): string {
  if (isYamlFormat(snippet)) {
    if (/^goal:/m.test(snippet)) {
      return snippet;
    }
    return snippet.replace(
      /^(agent|supervisor):\s.*$/m,
      (match) => `${match}\ngoal: "Validate long-form example"`,
    );
  }

  if (/^GOAL:/m.test(snippet)) {
    return snippet;
  }

  return snippet.replace(
    /^(AGENT|SUPERVISOR):\s.*$/m,
    (match) => `${match}\nGOAL: "Validate long-form example"`,
  );
}

function collectOnReturnReferences(
  snippet: string,
): Array<{ kind: 'action' | 'handler'; value: string }> {
  const references: Array<{ kind: 'action' | 'handler'; value: string }> = [];
  const lines = snippet.replace(/\r/g, '').split('\n');

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line) {
      continue;
    }

    const inlineMatch = line.match(/^\s*ON_RETURN:\s*(?:"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*))\s*$/);
    if (inlineMatch) {
      references.push({ kind: 'handler', value: inlineMatch[1] ?? inlineMatch[2]! });
      continue;
    }

    const blockMatch = line.match(/^(\s*)ON_RETURN:\s*$/);
    if (!blockMatch) {
      continue;
    }

    const baseIndent = blockMatch[1]?.length ?? 0;
    for (let childIndex = index + 1; childIndex < lines.length; childIndex += 1) {
      const childLine = lines[childIndex];
      if (!childLine || childLine.trim() === '') {
        continue;
      }

      const childIndent = childLine.match(/^\s*/)?.[0].length ?? 0;
      if (childIndent <= baseIndent) {
        break;
      }

      const handlerMatch = childLine.match(
        /^\s*handler:\s*(?:"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*))\s*$/,
      );
      if (handlerMatch) {
        references.push({ kind: 'handler', value: handlerMatch[1] ?? handlerMatch[2]! });
      }

      const actionMatch = childLine.match(
        /^\s*action:\s*(?:"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*))\s*$/,
      );
      if (actionMatch) {
        references.push({ kind: 'action', value: actionMatch[1] ?? actionMatch[2]! });
      }
    }
  }

  return references;
}

function assertOnReturnHandlersResolve(relativePath: string, snippet: string) {
  const allowedActions = new Set(HANDOFF_ON_RETURN_ACTION_VALUES);
  const handlersBlock = snippet;

  for (const reference of collectOnReturnReferences(snippet)) {
    const value = reference.value;
    if (reference.kind === 'action') {
      expect(
        allowedActions.has(value as (typeof HANDOFF_ON_RETURN_ACTION_VALUES)[number]),
        `${relativePath} uses unsupported ON_RETURN action "${value}".`,
      ).toBe(true);
      continue;
    }

    if (allowedActions.has(value as (typeof HANDOFF_ON_RETURN_ACTION_VALUES)[number])) {
      continue;
    }

    expect(
      /\s/.test(value),
      `${relativePath} uses free-form ON_RETURN text "${value}". Prefer named handlers or built-in actions.`,
    ).toBe(false);

    const handlerPattern = new RegExp(`RETURN_HANDLERS:[\\s\\S]*?\\n\\s{2,}${value}:`);
    expect(
      handlerPattern.test(handlersBlock),
      `${relativePath} references ON_RETURN handler "${value}" without defining it in RETURN_HANDLERS.`,
    ).toBe(true);
  }
}

function assertParseableExamples(relativePath: string, content: string) {
  for (const block of getCodeBlocks(relativePath, content)) {
    const prepared = prepareSnippetForParsing(block);
    if (!prepared) {
      continue;
    }

    assertOnReturnHandlersResolve(relativePath, prepared);

    for (const docSource of splitLegacyDocuments(prepared)) {
      const validationSource = ensureGoalForValidation(docSource);

      if (isYamlFormat(validationSource)) {
        const parsed = parseYamlABL(validationSource);
        expect(
          parsed.errors,
          `${relativePath} has an invalid YAML ABL snippet:\n${docSource}`,
        ).toHaveLength(0);
      } else {
        const parsed = parseAgentBasedABL(validationSource);
        expect(
          parsed.errors,
          `${relativePath} has an invalid ABL snippet:\n${docSource}`,
        ).toHaveLength(0);
      }
    }
  }
}

describe('Phase 8 long-form contract governance', () => {
  test('curated long-form surfaces stay aligned with the canonical ABL contract', () => {
    for (const surface of LONG_FORM_SURFACES) {
      const content = readRepoFile(surface.path);
      const text = toAssertionText(surface.path, content);

      for (const required of surface.mustContain ?? []) {
        expect(text, `${surface.path} is missing required contract term "${required}"`).toContain(
          required,
        );
      }

      for (const forbidden of surface.mustNotContain ?? []) {
        expect(
          text,
          `${surface.path} still contains stale contract term "${forbidden}"`,
        ).not.toContain(forbidden);
      }

      for (const forbiddenPattern of surface.mustNotMatch ?? []) {
        expect(
          text,
          `${surface.path} still matches stale contract pattern ${forbiddenPattern}`,
        ).not.toMatch(forbiddenPattern);
      }

      if (surface.validateCodeBlocks) {
        assertParseableExamples(surface.path, content);
      }
    }
  });
});
