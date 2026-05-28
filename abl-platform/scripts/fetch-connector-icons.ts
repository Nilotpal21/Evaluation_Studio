/**
 * Fetch Connector Icons
 *
 * Reads connector-catalog.json and downloads any missing PNG icons from the
 * Activepieces CDN into apps/studio/public/icons/connectors/.
 *
 * The AP CDN uses the same connector names as our catalog (e.g. "google-drive"
 * → https://cdn.activepieces.com/pieces/google-drive.png), so no slug mapping
 * is needed.
 *
 * Usage:
 *   pnpm connectors:fetch-icons          — download missing icons
 *   pnpm connectors:fetch-icons --force  — re-download all icons
 *   pnpm connectors:fetch-icons --check  — exit 1 if any icons are missing
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const CATALOG_PATH = join(
  __dirname,
  '..',
  'packages',
  'connectors',
  'src',
  'generated',
  'connector-catalog.json',
);
const OUTPUT_DIR = join(__dirname, '..', 'apps', 'studio', 'public', 'icons', 'connectors');
const AP_CDN_BASE = 'https://cdn.activepieces.com/pieces';

/**
 * Connectors whose AP CDN filename differs from our catalog name.
 * Value is the exact filename stem used on the CDN (without .png).
 */
const AP_CDN_OVERRIDES: Record<string, string> = {
  'jira-cloud': 'jira',
  'microsoft-onedrive': 'oneDrive',
  servicenow: 'service-now',
  'microsoft-outlook-calendar': 'microsoft-outlook',
  'amazon-sqs': 'aws-sqs',
};

interface CatalogEntry {
  name: string;
  displayName: string;
}

async function fetchIcon(name: string): Promise<Buffer | null> {
  const cdnName = AP_CDN_OVERRIDES[name] ?? name;
  const url = `${AP_CDN_BASE}/${cdnName}.png`;
  const res = await fetch(url);
  if (!res.ok) {
    if (res.status === 404) return null;
    throw new Error(`HTTP ${res.status} fetching ${url}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

async function main(): Promise<void> {
  const isForce = process.argv.includes('--force');
  const isCheck = process.argv.includes('--check');

  const catalog: CatalogEntry[] = JSON.parse(readFileSync(CATALOG_PATH, 'utf-8'));
  mkdirSync(OUTPUT_DIR, { recursive: true });

  let added = 0;
  let skipped = 0;
  let missing = 0;
  let notFound = 0;

  for (const { name, displayName } of catalog) {
    const dest = join(OUTPUT_DIR, `${name}.png`);
    const exists = existsSync(dest);

    if (exists && !isForce) {
      skipped++;
      continue;
    }

    if (isCheck) {
      if (!exists) {
        console.error(`  MISSING  ${name}  (${displayName})`);
        missing++;
      }
      continue;
    }

    process.stdout.write(`  fetching  ${name} ...`);
    try {
      const buf = await fetchIcon(name);
      if (!buf) {
        console.log(`  NOT FOUND on AP CDN — skipped`);
        notFound++;
        continue;
      }
      writeFileSync(dest, buf);
      console.log(`  saved (${buf.length} bytes)`);
      added++;
    } catch (err) {
      console.log(`  ERROR: ${err instanceof Error ? err.message : String(err)}`);
      notFound++;
    }
  }

  if (isCheck) {
    if (missing > 0) {
      console.error(`\n${missing} icon(s) missing. Run: pnpm connectors:fetch-icons`);
      process.exit(1);
    } else {
      console.log(`All ${catalog.length} connector icons present.`);
      process.exit(0);
    }
  }

  console.log(`\nDone — added: ${added}, already existed: ${skipped}, not on CDN: ${notFound}`);
}

main().catch((err) => {
  console.error('fetch-connector-icons failed:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
