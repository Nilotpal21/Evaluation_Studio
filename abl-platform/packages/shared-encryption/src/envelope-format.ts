/**
 * Detect if a value is a DEK envelope ciphertext (base64 with DEK ID header).
 *
 * Wire format: base64(dekIdLen[1] + dekId[N] + iv[12] + authTag[16] + ciphertext[...])
 */
export function isDEKEnvelopeFormat(value: string): boolean {
  if (typeof value !== 'string' || value.length < 40) {
    return false;
  }

  if (!/^[A-Za-z0-9+/]+=*$/.test(value)) {
    return false;
  }

  try {
    const buf = Buffer.from(value, 'base64');
    const dekIdLen = buf[0];

    if (dekIdLen === undefined || dekIdLen < 5 || dekIdLen > 50) {
      return false;
    }

    if (buf.length < 1 + dekIdLen + 12 + 16) {
      return false;
    }

    const firstChar = buf[1];
    if (firstChar === undefined) return false;
    if (firstChar < 0x20 || firstChar > 0x7e) {
      return false;
    }

    return true;
  } catch {
    return false;
  }
}
