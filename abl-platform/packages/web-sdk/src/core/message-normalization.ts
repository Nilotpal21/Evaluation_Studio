import type {
  ActionElement,
  ActionSet,
  MessageContentEnvelope,
  RichContent,
  VoiceConfig,
} from './types.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringifyActionValue(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === 'string') {
    return value;
  }
  return JSON.stringify(value);
}

function isActionElementType(value: unknown): value is ActionElement['type'] {
  return value === 'button' || value === 'select' || value === 'input';
}

function isActionInputType(value: unknown): value is NonNullable<ActionElement['input_type']> {
  return (
    value === 'text' ||
    value === 'number' ||
    value === 'date' ||
    value === 'time' ||
    value === 'email'
  );
}

function normalizeActionOption(
  value: unknown,
): NonNullable<ActionElement['options']>[number] | null {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.label !== 'string') {
    return null;
  }

  return {
    id: value.id,
    label: value.label,
    ...(typeof value.description === 'string' ? { description: value.description } : {}),
  };
}

function normalizeLegacyActionElement(value: unknown): ActionElement | null {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.label !== 'string') {
    return null;
  }

  const canonicalActionType = isActionElementType(value.type) ? value.type : null;
  const actionType: ActionElement['type'] = canonicalActionType ?? 'button';
  const options = Array.isArray(value.options)
    ? value.options
        .map((option) => normalizeActionOption(option))
        .filter(
          (option): option is NonNullable<ActionElement['options']>[number] => option !== null,
        )
    : undefined;
  const actionValue = stringifyActionValue(
    value.payload ?? value.value ?? value.url ?? (canonicalActionType ? undefined : value.id),
  );

  return {
    id: value.id,
    type: actionType,
    label: value.label,
    ...(actionValue !== undefined ? { value: actionValue } : {}),
    ...(typeof value.description === 'string' ? { description: value.description } : {}),
    ...(options && options.length > 0 ? { options } : {}),
    ...(isActionInputType(value.input_type) ? { input_type: value.input_type } : {}),
    ...(typeof value.placeholder === 'string' ? { placeholder: value.placeholder } : {}),
    ...(typeof value.required === 'boolean' ? { required: value.required } : {}),
  };
}

export function normalizeActionSet(value: unknown): ActionSet | undefined {
  if (!isRecord(value) && !Array.isArray(value)) {
    return undefined;
  }

  if (Array.isArray(value)) {
    const elements = value
      .map((entry) => normalizeLegacyActionElement(entry))
      .filter((entry): entry is ActionElement => entry !== null);
    return elements.length > 0 ? { elements } : undefined;
  }

  if (Array.isArray(value.elements)) {
    const elements = value.elements
      .map((entry) => normalizeLegacyActionElement(entry))
      .filter((entry): entry is ActionElement => entry !== null);
    return elements.length > 0
      ? {
          elements,
          ...(typeof value.submit_label === 'string' ? { submit_label: value.submit_label } : {}),
          ...(typeof value.submit_id === 'string' ? { submit_id: value.submit_id } : {}),
          ...(typeof value.renderId === 'string' ? { renderId: value.renderId } : {}),
        }
      : undefined;
  }

  return undefined;
}

export function normalizeVoiceConfig(value: unknown): VoiceConfig | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const plainText =
    typeof value.plain_text === 'string'
      ? value.plain_text
      : typeof value.plainText === 'string'
        ? value.plainText
        : undefined;

  return {
    ...value,
    ...(plainText ? { plain_text: plainText, plainText } : {}),
  } as VoiceConfig;
}

function normalizeCardRichContent(value: Record<string, unknown>): RichContent | undefined {
  const title = typeof value.title === 'string' ? value.title : undefined;
  const body = typeof value.body === 'string' ? value.body : undefined;
  const fields = Array.isArray(value.fields)
    ? value.fields
        .filter((field): field is Record<string, unknown> => isRecord(field))
        .map((field) => {
          const label = typeof field.label === 'string' ? field.label : 'Field';
          const fieldValue =
            typeof field.value === 'string' || typeof field.value === 'number'
              ? String(field.value)
              : '';
          return `- **${label}:** ${fieldValue}`;
        })
    : [];
  const markdown = [title ? `### ${title}` : undefined, body, ...fields]
    .filter((line): line is string => typeof line === 'string' && line.trim().length > 0)
    .join('\n\n');

  return markdown.trim().length > 0 ? ({ ...value, markdown } as RichContent) : undefined;
}

function normalizeQuickRepliesRichContent(value: Record<string, unknown>): RichContent | undefined {
  const replies = Array.isArray(value.replies)
    ? value.replies
        .map((reply, index) => {
          if (typeof reply === 'string') {
            return { id: reply.toLowerCase().replace(/[^a-z0-9_-]/g, '_'), label: reply };
          }
          if (isRecord(reply) && typeof reply.label === 'string') {
            return {
              id: typeof reply.id === 'string' ? reply.id : `reply-${index}`,
              label: reply.label,
            };
          }
          return null;
        })
        .filter((reply): reply is { id: string; label: string } => reply !== null)
    : [];

  return replies.length > 0 ? ({ ...value, quick_replies: replies } as RichContent) : undefined;
}

export function normalizeRichContent(value: unknown): RichContent | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  if (typeof value.markdown === 'string') {
    return value as RichContent;
  }
  if (value.type === 'card') {
    return normalizeCardRichContent(value);
  }
  if (value.type === 'quick_replies') {
    return normalizeQuickRepliesRichContent(value);
  }
  return value as RichContent;
}

export function normalizeContentEnvelope(value: unknown): MessageContentEnvelope | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const richContent = normalizeRichContent(value.richContent);
  const actions = normalizeActionSet(value.actions);
  const voiceConfig = normalizeVoiceConfig(value.voiceConfig);

  return {
    ...value,
    ...(typeof value.text === 'string' ? { text: value.text } : {}),
    ...(Array.isArray(value.rawContent) ? { rawContent: value.rawContent } : {}),
    ...(richContent ? { richContent } : {}),
    ...(actions ? { actions } : {}),
    ...(voiceConfig ? { voiceConfig } : {}),
    ...(isRecord(value.localization) ? { localization: value.localization } : {}),
    ...(isRecord(value.metadata) ? { metadata: value.metadata } : {}),
  } as MessageContentEnvelope;
}
