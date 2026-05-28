/**
 * Hand-ported checksum validators for the recognizer-pack family.
 *
 * Source attributions (per Round 8 OSS audit):
 *   - isIbanMod97: design reference is `ibantools` (MIT,
 *     https://github.com/Simplify/ibantools) — mod-97 core only, NOT
 *     the BBAN country tables.
 *   - verhoeffCheck: public algorithm spec — Verhoeff (1969) lookup-
 *     table form; no maintained npm package exists for vendoring.
 *   - deaCheck: DEA Diversion Control documentation (weighted mod-10).
 *   - btcBase58Check: design reference is `bs58check` (MIT,
 *     bitcoinjs-lib) — base58 alphabet decode + double-SHA256 check.
 *
 * No new runtime deps (HLD §8.2). The luhnCheck export is re-exported
 * from `pii-recognizer-registry.ts` for ergonomics.
 */

export { luhnCheck } from '../pii-recognizer-registry.js';

// ---------------------------------------------------------------------------
// IBAN mod-97
// ---------------------------------------------------------------------------

export function isIbanMod97(input: string): boolean {
  const stripped = input.replace(/\s+/g, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{1,30}$/.test(stripped)) return false;
  const rearranged = stripped.slice(4) + stripped.slice(0, 4);
  let remainder = 0;
  for (const ch of rearranged) {
    const code = ch.charCodeAt(0);
    const num = code >= 65 ? code - 55 : code - 48;
    if (num < 0 || num > 35) return false;
    if (num >= 10) {
      remainder = (remainder * 100 + num) % 97;
    } else {
      remainder = (remainder * 10 + num) % 97;
    }
  }
  return remainder === 1;
}

// ---------------------------------------------------------------------------
// Verhoeff (Aadhaar)
// ---------------------------------------------------------------------------

const VERHOEFF_D: number[][] = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
  [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
  [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
  [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
  [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
  [6, 5, 9, 8, 7, 1, 0, 4, 3, 2],
  [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
  [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
  [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
];
const VERHOEFF_P: number[][] = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
  [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
  [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
  [9, 4, 5, 3, 1, 2, 6, 8, 7, 0],
  [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5],
  [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
];

export function verhoeffCheck(num: string): boolean {
  if (!/^\d+$/.test(num)) return false;
  let c = 0;
  const reversed = num.split('').reverse();
  for (let i = 0; i < reversed.length; i++) {
    c = VERHOEFF_D[c][VERHOEFF_P[i % 8][parseInt(reversed[i], 10)]];
  }
  return c === 0;
}

// ---------------------------------------------------------------------------
// DEA registration number
// Format: 2 letters + 7 digits. Checksum: last digit equals
//   ((d1 + d3 + d5) + 2*(d2 + d4 + d6)) mod 10  for the 6 leading digits.
// ---------------------------------------------------------------------------

export function deaCheck(input: string): boolean {
  const m = /^[A-Z]{2}(\d{6})(\d)$/.exec(input.toUpperCase());
  if (!m) return false;
  const d = m[1].split('').map(Number);
  const expected = (d[0] + d[2] + d[4] + 2 * (d[1] + d[3] + d[5])) % 10;
  return expected === parseInt(m[2], 10);
}

// ---------------------------------------------------------------------------
// BTC base58check
// Decode base58 alphabet, verify double-SHA256 4-byte trailing checksum.
// ---------------------------------------------------------------------------

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function base58Decode(input: string): Uint8Array | null {
  let num: bigint = 0n;
  for (const ch of input) {
    const idx = BASE58_ALPHABET.indexOf(ch);
    if (idx < 0) return null;
    num = num * 58n + BigInt(idx);
  }
  const bytes: number[] = [];
  while (num > 0n) {
    bytes.unshift(Number(num & 0xffn));
    num >>= 8n;
  }
  // Leading zero bytes for each leading '1' in input
  for (const ch of input) {
    if (ch === '1') bytes.unshift(0);
    else break;
  }
  return Uint8Array.from(bytes);
}

async function sha256(data: Uint8Array): Promise<Uint8Array> {
  // Use Node's crypto.subtle (available in Node 16+; the runtime ships on 24+).
  const digest = await globalThis.crypto.subtle.digest('SHA-256', data);
  return new Uint8Array(digest);
}

/**
 * Async because base58check requires SHA-256. Most pack recognizers use
 * sync validators — for BTC, callers should pre-validate shape via regex
 * and run base58check via this async path during full validation.
 */
export async function btcBase58CheckAsync(input: string): Promise<boolean> {
  const decoded = base58Decode(input);
  if (!decoded || decoded.length < 5) return false;
  const payload = decoded.slice(0, -4);
  const checksum = decoded.slice(-4);
  const hash1 = await sha256(payload);
  const hash2 = await sha256(hash1);
  for (let i = 0; i < 4; i++) {
    if (hash2[i] !== checksum[i]) return false;
  }
  return true;
}

/**
 * Sync alphabet-only validator (no checksum). Use as a regex validator
 * for the BTC recognizer; callers needing checksum should run
 * `btcBase58CheckAsync` separately.
 */
export function btcBase58Shape(input: string): boolean {
  if (input.length < 26 || input.length > 35) return false;
  for (const ch of input) {
    if (BASE58_ALPHABET.indexOf(ch) < 0) return false;
  }
  return true;
}
