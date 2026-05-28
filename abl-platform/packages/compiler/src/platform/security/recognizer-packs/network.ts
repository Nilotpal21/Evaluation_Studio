/**
 * `network` recognizer pack.
 *
 * Entity types: ipv6, mac-address, url-with-credentials.
 */

import type { EntityCatalogEntry } from './catalog.js';
import { PIIRecognizerRegistry, RegexPIIRecognizer } from '../pii-recognizer-registry.js';

export const ENTITIES: ReadonlyArray<EntityCatalogEntry> = [
  { id: 'net_ipv6', label: 'IPv6 Address', pack: 'network', category: 'network' },
  { id: 'net_mac', label: 'MAC Address', pack: 'network', category: 'network' },
  {
    id: 'net_url_with_credentials',
    label: 'URL with Embedded Credentials',
    pack: 'network',
    category: 'network',
  },
];

const PACK_CFG = { baseConfidence: 0.7, contextBoost: 0.35 };

export function register(registry: PIIRecognizerRegistry): void {
  // IPv6 — full form (8 groups of 4 hex digits) and zero-compressed forms.
  registry.register(
    new RegexPIIRecognizer(
      'net-ipv6',
      ['net_ipv6'],
      /\b(?:[0-9A-Fa-f]{1,4}:){7}[0-9A-Fa-f]{1,4}\b|::(?:[0-9A-Fa-f]{1,4}:){0,6}[0-9A-Fa-f]{1,4}|(?:[0-9A-Fa-f]{1,4}:){1,7}:/g,
      'net_ipv6',
      undefined,
      'regex',
      { ...PACK_CFG, contextWords: ['ipv6', 'address'] },
    ),
    { permanent: true },
  );

  // MAC address — 6 groups of 2 hex digits, separated by ':' or '-'
  registry.register(
    new RegexPIIRecognizer(
      'net-mac',
      ['net_mac'],
      /\b[0-9A-Fa-f]{2}(?:[:-][0-9A-Fa-f]{2}){5}\b/g,
      'net_mac',
      undefined,
      'regex',
      { ...PACK_CFG, contextWords: ['mac', 'address', 'hardware'] },
    ),
    { permanent: true },
  );

  // URL with embedded credentials — http(s)://user:pass@host
  registry.register(
    new RegexPIIRecognizer(
      'net-url-with-credentials',
      ['net_url_with_credentials'],
      /\bhttps?:\/\/[^\s/@]+:[^\s/@]+@[^\s]+/g,
      'net_url_with_credentials',
      undefined,
      'regex',
      { ...PACK_CFG, contextWords: ['url', 'credentials'] },
    ),
    { permanent: true },
  );
}
