const INFOBIP_PHONE_IDENTIFIER_PATTERN = /^\d{6,20}$/;

export function normalizeInfobipPhoneIdentifier(value: unknown): string | null {
  if (typeof value !== 'string') return null;

  const normalized = value.trim().replace(/^\+/, '');
  return INFOBIP_PHONE_IDENTIFIER_PATTERN.test(normalized) ? normalized : null;
}

export function validateInfobipBaseUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return 'Missing required credential: base_url';
  }

  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return 'base_url must include http:// or https://';
    }
    if (!url.hostname) {
      return 'base_url must include a host';
    }
  } catch {
    return 'base_url must be a valid URL including http:// or https://';
  }

  return null;
}

export function normalizeInfobipBaseUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const error = validateInfobipBaseUrl(value);
  if (error) return null;
  return value.trim().replace(/\/+$/, '');
}
