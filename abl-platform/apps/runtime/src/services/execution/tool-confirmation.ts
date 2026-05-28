/**
 * Tool Confirmation Immutability
 *
 * Snapshot creation, immutability validation, and expiration checking
 * for tool call confirmations. Prevents parameter tampering between
 * user confirmation and tool execution.
 */

import { createHash } from 'node:crypto';
import { createLogger, renderSensitiveValue } from '@abl/compiler/platform';
import type { ToolDefinition, GatherField } from '@abl/compiler';

const log = createLogger('tool-confirmation');
const CONFIRMATION_TTL_MS = 5 * 60 * 1000;
const EMPTY_IMMUTABLE_HASH = 'no_immutable_params';

export interface ToolConfirmationSnapshot {
  toolName: string;
  toolCallId: string;
  params: Record<string, unknown>;
  immutableParams: string[];
  snapshotHash: string;
  createdAt: number;
  expiresAt: number;
}

interface ToolCallLike {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ConfirmationConfig {
  require: 'always' | 'never' | 'when_side_effects';
  immutable_params?: string[];
  consent_required_in?: 'conversation' | 'explicit_prompt';
  consent_scope?: string[];
  consent_action?: string;
  consent_fallback?: 'explicit_prompt' | 'block';
}

interface ConversationMessageLike {
  role: string;
  content: unknown;
}

export type ConversationConsentReason =
  | 'not_configured'
  | 'detected'
  | 'missing'
  | 'scope_mismatch';

export interface ConversationConsentDecision {
  satisfied: boolean;
  reason: ConversationConsentReason;
  evidence?: {
    userText: string;
    matchedAction: string;
    scopedFields: string[];
  };
}

export function createSnapshot(
  toolCall: ToolCallLike,
  config: ConfirmationConfig,
): ToolConfirmationSnapshot {
  const immutableParams = getImmutableParams(config);
  const now = Date.now();
  return {
    toolName: toolCall.name,
    toolCallId: toolCall.id,
    params: { ...toolCall.input },
    immutableParams,
    snapshotHash: hashImmutableValues(toolCall.input, immutableParams),
    createdAt: now,
    expiresAt: now + CONFIRMATION_TTL_MS,
  };
}

export function validateImmutability(
  snapshot: ToolConfirmationSnapshot,
  currentParams: Record<string, unknown>,
): { valid: boolean; violations: string[] } {
  // Fast-path: hash comparison catches any tampering
  const currentHash = hashImmutableValues(currentParams, snapshot.immutableParams);
  if (currentHash === snapshot.snapshotHash) {
    return { valid: true, violations: [] };
  }

  // Slow path: identify specific violations for error reporting
  const violations: string[] = [];
  for (const param of snapshot.immutableParams) {
    if (!deepEqual(snapshot.params[param], currentParams[param])) {
      violations.push(param);
    }
  }

  if (violations.length > 0) {
    log.warn('Immutable parameter tampering detected', {
      toolName: snapshot.toolName,
      toolCallId: snapshot.toolCallId,
      violations,
    });
  }

  return { valid: violations.length === 0, violations };
}

export function isSnapshotExpired(snapshot: ToolConfirmationSnapshot): boolean {
  return Date.now() > snapshot.expiresAt;
}

export function formatConfirmationMessage(
  toolCall: ToolCallLike,
  config: ConfirmationConfig,
  gatherFields?: GatherField[],
): string {
  const fieldMap = new Map<string, GatherField>();
  if (gatherFields) {
    for (const f of gatherFields) {
      fieldMap.set(f.name, f);
    }
  }

  const immutableParams = getImmutableParams(config);
  const paramLines = Object.entries(toolCall.input)
    .map(([key, value]) => {
      const locked = immutableParams.includes(key) ? ' (locked)' : '';
      const field = fieldMap.get(key);
      const displayValue =
        field && field.sensitive ? renderSensitiveValue(value, field) : JSON.stringify(value);
      return `  - ${key}: ${displayValue}${locked}`;
    })
    .join('\n');
  return `Confirm execution of **${toolCall.name}**?\n\nParameters:\n${paramLines}\n\nReply "yes" to proceed or "no" to cancel.`;
}

export function shouldRequireConfirmation(toolDef: ToolDefinition): boolean {
  if (!toolDef.confirmation) return false;
  switch (toolDef.confirmation.require) {
    case 'always':
      return true;
    case 'when_side_effects':
      return toolDef.hints.side_effects === true;
    case 'never':
      return false;
    default:
      return false;
  }
}

export function evaluateConversationConsent(
  toolCall: ToolCallLike,
  config: ConfirmationConfig,
  conversationHistory: ConversationMessageLike[],
): ConversationConsentDecision {
  if (config.consent_required_in !== 'conversation') {
    return { satisfied: false, reason: 'not_configured' };
  }

  const userText = getLatestUserText(conversationHistory);
  if (!userText) {
    return { satisfied: false, reason: 'missing' };
  }

  const normalizedUserText = normalizeConsentText(userText);
  const actionTerms = getConsentActionTerms(toolCall.name, config);
  const matchedAction = actionTerms.find((term) => normalizedUserText.includes(term));
  if (!matchedAction) {
    return { satisfied: false, reason: 'missing' };
  }

  const scopedFields = getConsentScopeFields(config);
  if (hasScopeMismatch(normalizedUserText, toolCall.input, scopedFields)) {
    return { satisfied: false, reason: 'scope_mismatch' };
  }

  return {
    satisfied: true,
    reason: 'detected',
    evidence: {
      userText,
      matchedAction,
      scopedFields,
    },
  };
}

export function shouldBlockForMissingConversationConsent(
  config: ConfirmationConfig,
  decision: ConversationConsentDecision,
): boolean {
  return (
    config.consent_required_in === 'conversation' &&
    config.consent_fallback === 'block' &&
    !decision.satisfied &&
    decision.reason !== 'not_configured'
  );
}

function getImmutableParams(config: ConfirmationConfig): string[] {
  const params: string[] = [];
  for (const field of [...(config.immutable_params ?? []), ...(config.consent_scope ?? [])]) {
    if (field.length > 0 && !params.includes(field)) {
      params.push(field);
    }
  }
  return params;
}

function hashImmutableValues(params: Record<string, unknown>, immutableParams: string[]): string {
  if (immutableParams.length === 0) return EMPTY_IMMUTABLE_HASH;
  const values: Record<string, unknown> = {};
  for (const key of [...immutableParams].sort()) {
    values[key] = params[key];
  }
  return createHash('sha256').update(JSON.stringify(values)).digest('hex');
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || a === undefined || b === undefined) return false;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((item, i) => deepEqual(item, b[i]));
  }
  if (typeof a === 'object' && typeof b === 'object') {
    const aObj = a as Record<string, unknown>;
    const bObj = b as Record<string, unknown>;
    const aKeys = Object.keys(aObj).sort();
    const bKeys = Object.keys(bObj).sort();
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every((key, i) => key === bKeys[i] && deepEqual(aObj[key], bObj[key]));
  }
  return false;
}

function getLatestUserText(conversationHistory: ConversationMessageLike[]): string | undefined {
  for (let i = conversationHistory.length - 1; i >= 0; i--) {
    const message = conversationHistory[i];
    if (message.role !== 'user') {
      continue;
    }
    const text = contentToText(message.content).trim();
    if (text.length > 0) {
      return text;
    }
  }
  return undefined;
}

function contentToText(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }
  const parts: string[] = [];
  for (const block of content) {
    if (
      block &&
      typeof block === 'object' &&
      'type' in block &&
      block.type === 'text' &&
      'text' in block &&
      typeof block.text === 'string'
    ) {
      parts.push(block.text);
    }
  }
  return parts.join(' ');
}

function getConsentScopeFields(config: ConfirmationConfig): string[] {
  const scopeFields = config.consent_scope ?? config.immutable_params ?? [];
  return [...scopeFields].filter((field) => field.length > 0);
}

function getConsentActionTerms(toolName: string, config: ConfirmationConfig): string[] {
  const explicitAction = normalizeConsentText(config.consent_action ?? '');
  const terms = explicitAction ? [explicitAction] : [];
  const normalizedToolName = normalizeConsentText(toolName.replace(/_/g, ' '));

  if (normalizedToolName.includes('replacement') || normalizedToolName.includes('replace')) {
    terms.push('replacement', 'replace', 'send another', 'ship another', 'new unit', 'resend');
  }
  if (normalizedToolName.includes('refund')) {
    terms.push('refund', 'money back');
  }
  if (normalizedToolName.includes('credit')) {
    terms.push('credit', 'goodwill');
  }

  for (const token of normalizedToolName.split(' ')) {
    if (!isGenericToolActionToken(token)) {
      terms.push(token);
    }
  }

  const uniqueTerms: string[] = [];
  for (const term of terms) {
    if (term.length > 1 && !uniqueTerms.includes(term)) {
      uniqueTerms.push(term);
    }
  }
  return uniqueTerms;
}

function normalizeConsentText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/[^a-z0-9@. ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isGenericToolActionToken(token: string): boolean {
  return [
    'apply',
    'create',
    'execute',
    'issue',
    'process',
    'run',
    'send',
    'set',
    'tool',
    'update',
  ].includes(token);
}

function hasScopeMismatch(
  normalizedUserText: string,
  params: Record<string, unknown>,
  scopedFields: string[],
): boolean {
  let numericComparisonText = normalizedUserText;
  for (const field of scopedFields) {
    const currentValue = params[field];
    if (typeof currentValue !== 'string' || currentValue.trim().length === 0) {
      continue;
    }

    const normalizedCurrentValue = normalizeConsentText(currentValue);
    if (normalizedUserText.includes(normalizedCurrentValue)) {
      numericComparisonText = removeNormalizedPhrase(numericComparisonText, normalizedCurrentValue);
    }
  }

  for (const field of scopedFields) {
    const currentValue = params[field];
    if (typeof currentValue === 'string') {
      if (currentValue.trim().length === 0) {
        continue;
      }

      const normalizedCurrentValue = normalizeConsentText(currentValue);
      if (normalizedUserText.includes(normalizedCurrentValue)) {
        continue;
      }

      if (isIdentifierLikeField(field) && mentionsDifferentIdentifier(normalizedUserText)) {
        return true;
      }
      continue;
    }

    if (typeof currentValue === 'number') {
      if (numberAppearsInText(numericComparisonText, currentValue)) {
        continue;
      }

      if (mentionsDifferentNumber(numericComparisonText, currentValue)) {
        return true;
      }
      continue;
    }
  }
  return false;
}

function removeNormalizedPhrase(text: string, phrase: string): string {
  return text.replace(phrase, ' ').replace(/\s+/g, ' ').trim();
}

function numberAppearsInText(normalizedUserText: string, expected: number): boolean {
  return extractNumbers(normalizedUserText).some((value) => numbersEquivalent(value, expected));
}

function mentionsDifferentNumber(normalizedUserText: string, expected: number): boolean {
  const numbers = extractNumbers(normalizedUserText);
  return numbers.length > 0 && numbers.every((value) => !numbersEquivalent(value, expected));
}

function extractNumbers(normalizedUserText: string): number[] {
  const matches = normalizedUserText.match(/\b\d+(?:\.\d+)?\b/gu) ?? [];
  return matches.map((value) => Number(value)).filter((value) => Number.isFinite(value));
}

function numbersEquivalent(a: number, b: number): boolean {
  return Math.abs(a - b) < 0.000001;
}

function isIdentifierLikeField(field: string): boolean {
  return /(^|_)(id|order|transaction|account|case|ticket)(_|$)/u.test(field);
}

function mentionsDifferentIdentifier(normalizedUserText: string): boolean {
  return /\b[a-z]{2,}\s+\d{3,}[a-z0-9 ]*\b/u.test(normalizedUserText);
}
