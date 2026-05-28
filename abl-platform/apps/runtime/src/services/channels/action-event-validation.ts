import type { ActionEvent } from './action-event.js';

const MAX_ACTION_ID_LENGTH = 256;
const MAX_ACTION_VALUE_LENGTH = 10_000;
const MAX_ACTION_RENDER_ID_LENGTH = 256;
const MAX_FORM_DATA_BYTES = 16 * 1024;
const MAX_FORM_DATA_DEPTH = 5;
const MAX_FORM_DATA_KEYS = 50;
const MAX_FORM_DATA_KEY_LENGTH = 128;
const MAX_FORM_DATA_STRING_LENGTH = 4_096;
const UNSAFE_FORM_DATA_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export interface ValidatedActionSubmitEnvelope {
  actionId: string;
  value?: string;
  formData?: Record<string, unknown>;
  renderId?: string;
}

export type ActionSubmitEnvelopeValidationResult =
  | { ok: true; value: ValidatedActionSubmitEnvelope }
  | { ok: false; message: string };

export interface ActionSubmitEnvelopeInput {
  actionId: unknown;
  value?: unknown;
  formData?: unknown;
  renderId?: unknown;
  formDataPresent?: boolean;
}

export interface ActionEventInput extends ActionSubmitEnvelopeInput {
  source?: ActionEvent['source'];
}

export type ActionEventValidationResult =
  | { ok: true; value: ActionEvent }
  | { ok: false; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

function validateFormDataValue(
  value: unknown,
  depth: number,
  keyCount: { value: number },
): string | null {
  if (depth > MAX_FORM_DATA_DEPTH) {
    return 'formData exceeds maximum depth';
  }

  if (typeof value === 'string') {
    return value.length > MAX_FORM_DATA_STRING_LENGTH
      ? 'formData contains a string value that is too large'
      : null;
  }

  if (value === null || typeof value === 'number' || typeof value === 'boolean') {
    return null;
  }

  if (Array.isArray(value)) {
    keyCount.value += value.length;
    if (keyCount.value > MAX_FORM_DATA_KEYS) {
      return 'formData contains too many fields';
    }

    for (const item of value) {
      const issue = validateFormDataValue(item, depth + 1, keyCount);
      if (issue) {
        return issue;
      }
    }

    return null;
  }

  if (!isRecord(value)) {
    return 'formData contains an unsupported value';
  }

  const keys = Object.keys(value);
  keyCount.value += keys.length;
  if (keyCount.value > MAX_FORM_DATA_KEYS) {
    return 'formData contains too many fields';
  }

  for (const key of keys) {
    if (key.length === 0 || key.length > MAX_FORM_DATA_KEY_LENGTH) {
      return 'formData contains an invalid field key';
    }

    if (UNSAFE_FORM_DATA_KEYS.has(key)) {
      return 'formData contains an unsafe field key';
    }

    const issue = validateFormDataValue(value[key], depth + 1, keyCount);
    if (issue) {
      return issue;
    }
  }

  return null;
}

export function validateActionSubmitEnvelope(
  input: ActionSubmitEnvelopeInput,
): ActionSubmitEnvelopeValidationResult {
  if (
    typeof input.actionId !== 'string' ||
    input.actionId.length === 0 ||
    input.actionId.length > MAX_ACTION_ID_LENGTH
  ) {
    return { ok: false, message: 'Invalid actionId in action_submit' };
  }

  if (
    input.value !== undefined &&
    (typeof input.value !== 'string' || input.value.length > MAX_ACTION_VALUE_LENGTH)
  ) {
    return { ok: false, message: 'Invalid value in action_submit' };
  }

  if (
    input.renderId !== undefined &&
    (typeof input.renderId !== 'string' || input.renderId.length > MAX_ACTION_RENDER_ID_LENGTH)
  ) {
    return { ok: false, message: 'Invalid renderId in action_submit' };
  }

  let formData: Record<string, unknown> | undefined;
  if (input.formDataPresent === true) {
    if (!isRecord(input.formData)) {
      return { ok: false, message: 'Invalid formData in action_submit' };
    }

    let serialized: string;
    try {
      serialized = JSON.stringify(input.formData);
    } catch {
      return { ok: false, message: 'Invalid formData in action_submit' };
    }

    if (byteLength(serialized) > MAX_FORM_DATA_BYTES) {
      return { ok: false, message: 'Invalid formData in action_submit' };
    }

    const formDataIssue = validateFormDataValue(input.formData, 0, { value: 0 });
    if (formDataIssue) {
      return { ok: false, message: `Invalid formData in action_submit: ${formDataIssue}` };
    }

    formData = input.formData;
  }

  return {
    ok: true,
    value: {
      actionId: input.actionId,
      value: typeof input.value === 'string' ? input.value : undefined,
      formData,
      renderId: typeof input.renderId === 'string' ? input.renderId : undefined,
    },
  };
}

export function normalizeActionEvent(input: ActionEventInput): ActionEventValidationResult {
  const validation = validateActionSubmitEnvelope(input);
  if (!validation.ok) {
    return validation;
  }

  return {
    ok: true,
    value: {
      type: 'action_event',
      actionId: validation.value.actionId,
      ...(validation.value.value !== undefined ? { value: validation.value.value } : {}),
      ...(validation.value.formData !== undefined ? { formData: validation.value.formData } : {}),
      ...(validation.value.renderId !== undefined ? { renderId: validation.value.renderId } : {}),
      ...(input.source !== undefined ? { source: input.source } : {}),
    },
  };
}

export function requireNormalizedActionEvent(input: ActionEventInput): ActionEvent {
  const validation = normalizeActionEvent(input);
  if (!validation.ok) {
    throw new Error(validation.message);
  }
  return validation.value;
}

export function tryParseLegacyActionFormData(
  value: string | undefined,
): Record<string, unknown> | undefined {
  if (!value || value.trim().length === 0) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    const validation = validateActionSubmitEnvelope({
      actionId: 'legacy_action_payload',
      formData: parsed,
      formDataPresent: true,
    });
    return validation.ok ? validation.value.formData : undefined;
  } catch {
    return undefined;
  }
}
