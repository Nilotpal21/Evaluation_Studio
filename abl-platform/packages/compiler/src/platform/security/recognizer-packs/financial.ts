/**
 * `financial` recognizer pack.
 *
 * Entity types: SWIFT/BIC, BTC wallet (base58 shape; checksum via
 * btcBase58CheckAsync at higher layers).
 *
 * IBAN coverage stays in `eu` pack (HLD §3.3 component diagram).
 */

import type { EntityCatalogEntry } from './catalog.js';
import { PIIRecognizerRegistry, RegexPIIRecognizer } from '../pii-recognizer-registry.js';
import { btcBase58Shape } from './_validators.js';

export const ENTITIES: ReadonlyArray<EntityCatalogEntry> = [
  { id: 'fin_swift_bic', label: 'SWIFT/BIC Code', pack: 'financial', category: 'financial' },
  {
    id: 'fin_btc_wallet',
    label: 'Bitcoin Wallet Address',
    pack: 'financial',
    category: 'cryptocurrency',
  },
];

const PACK_CFG = { baseConfidence: 0.7, contextBoost: 0.35 };

export function register(registry: PIIRecognizerRegistry): void {
  // SWIFT/BIC: 8 or 11 chars — 4 letters + 2 letters + 2 alphanumeric + optional 3 alphanumeric
  registry.register(
    new RegexPIIRecognizer(
      'fin-swift-bic',
      ['fin_swift_bic'],
      /\b[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}(?:[A-Z0-9]{3})?\b/g,
      'fin_swift_bic',
      undefined,
      'regex',
      { ...PACK_CFG, contextWords: ['swift', 'bic', 'wire'] },
    ),
    { permanent: true },
  );

  // BTC wallet — base58check shape (length 26-35, base58 alphabet).
  // Synchronous shape check; full SHA-256 checksum via btcBase58CheckAsync.
  registry.register(
    new RegexPIIRecognizer(
      'fin-btc-wallet',
      ['fin_btc_wallet'],
      /\b[13][A-HJ-NP-Za-km-z1-9]{25,34}\b/g,
      'fin_btc_wallet',
      btcBase58Shape,
      'regex',
      { ...PACK_CFG, contextWords: ['btc', 'bitcoin', 'wallet', 'address'] },
    ),
    { permanent: true },
  );
}
