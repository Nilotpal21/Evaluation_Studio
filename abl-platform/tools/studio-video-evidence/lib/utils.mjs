import fs from 'node:fs';
import path from 'node:path';

export function uniqueSuffix() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function sanitizeFileName(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function sanitizeIdentifier(value, { separator = '_', ensureLeadingLetter = true } = {}) {
  const escapedSeparator = separator.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, separator)
    .replace(new RegExp(`${escapedSeparator}+`, 'g'), separator)
    .replace(new RegExp(`^${escapedSeparator}+|${escapedSeparator}+$`, 'g'), '');

  if (!ensureLeadingLetter) {
    return normalized;
  }

  if (normalized.length === 0) {
    return 'artifact';
  }

  return /^[a-z]/.test(normalized) ? normalized : `a${separator}${normalized}`;
}

export function boolFromInput(value, defaultValue = false) {
  if (value == null) return defaultValue;
  if (typeof value === 'boolean') return value;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return defaultValue;
}

export function numberFromInput(value, defaultValue) {
  if (value == null) return defaultValue;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : defaultValue;
}

export async function delay(ms) {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

export function readEnvValue(filePath, key) {
  if (!fs.existsSync(filePath)) return '';
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    if (!line || line.trim().startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator === -1) continue;
    const lineKey = line.slice(0, separator).trim();
    if (lineKey !== key) continue;
    let value = line.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    return value;
  }
  return '';
}

export async function waitForCondition(fn, { timeoutMs, intervalMs = 250, label }) {
  const deadline = Date.now() + timeoutMs;
  let lastValue;

  while (Date.now() < deadline) {
    lastValue = await fn();
    if (lastValue) {
      return lastValue;
    }
    await delay(intervalMs);
  }

  throw new Error(label ? `${label} (last value: ${String(lastValue)})` : 'Condition timed out');
}

export function resolveOutputDir(baseDir, scenarioId) {
  return path.join(baseDir, `${sanitizeFileName(scenarioId)}-${uniqueSuffix()}`);
}
