function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeQuestion(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function hasExistingProjectName(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

export function isProjectNameWidgetPayload(payload: unknown): payload is Record<string, unknown> {
  if (!isRecord(payload)) {
    return false;
  }

  const widgetType = payload.widgetType;
  if (widgetType !== 'SingleSelect' && widgetType !== 'TextInput') {
    return false;
  }

  const question = normalizeQuestion(payload.question);
  if (!question) {
    return false;
  }

  return (
    /\bproject\s+name\b/.test(question) ||
    /\bwhat\s+should\s+(we|i)\s+(call|name)\s+(this|the|your)\s+project\b/.test(question) ||
    /\b(call|name)\s+(this|the|your)\s+project\b/.test(question)
  );
}

export function normalizeProjectNameWidgetAnswer(answer: unknown): string | null {
  if (typeof answer !== 'string') {
    return null;
  }

  const normalized = answer.replace(/^custom:\s*/i, '').trim();
  if (normalized.length < 2 || normalized.length > 100) {
    return null;
  }

  return normalized;
}

export function getProjectNameFromWidgetAnswer(params: {
  payload: unknown;
  answer: unknown;
  currentProjectName?: unknown;
}): string | null {
  if (hasExistingProjectName(params.currentProjectName)) {
    return null;
  }

  if (!isProjectNameWidgetPayload(params.payload)) {
    return null;
  }

  return normalizeProjectNameWidgetAnswer(params.answer);
}
