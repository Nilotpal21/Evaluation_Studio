/**
 * Connector Loader
 *
 * Registers all available connectors at boot time:
 * 1. Native HTTP connector (eagerly loaded — cheap, no dependencies)
 * 2. All @activepieces/piece-* packages as lazy loaders
 *
 * Lazy loading: Activepieces connectors are registered as loaders, not loaded upfront.
 * This reduces boot-time memory from ~800MB to ~200MB and startup from ~10s to <1s.
 * First use of a connector incurs ~100-200ms load delay (acceptable for real-world flows).
 *
 * Uses createRequire() to load piece packages at runtime. This avoids both:
 * - `import(variable)` → Turbopack emits "expression is too dynamic" warnings
 * - `import('literal')` → Turbopack traces sub-dependencies (pg-format etc.) and
 *   fails on packages with Node-only resolution patterns
 *
 * createRequire() is invisible to bundlers and resolves from this package's
 * node_modules, which is where pnpm hoists the @activepieces/* dependencies.
 *
 * To add a new connector:
 * 1. `pnpm add @activepieces/piece-xyz` in packages/connectors
 * 2. Add the entry to PIECE_PACKAGES below
 */

import { createRequire } from 'module';
import type { ConnectorRegistry } from './registry.js';
import { httpConnector } from './connectors/http/index.js';
import { wrapActivepiecesPiece } from './adapters/activepieces/runtime-adapter.js';
import { applyJiraCloudAuthAdapter } from './adapters/activepieces/auth-adapters/jira-cloud.js';
import { applyServiceNowAuthAdapter } from './adapters/activepieces/auth-adapters/servicenow.js';
import { createLogger } from './logger.js';

const log = createLogger('connector-loader');

/** require() scoped to this package — resolves from packages/connectors/node_modules */
const localRequire = createRequire(import.meta.url);

/**
 * All installed Activepieces piece packages.
 * Each entry maps a short name to the full npm package specifier.
 */
const PIECE_PACKAGES: Array<[shortName: string, packageSpecifier: string]> = [
  ['airtable', '@activepieces/piece-airtable'],
  ['amazon-s3', '@activepieces/piece-amazon-s3'],
  ['amazon-ses', '@activepieces/piece-amazon-ses'],
  ['amazon-sns', '@activepieces/piece-amazon-sns'],
  ['amazon-sqs', '@activepieces/piece-amazon-sqs'],
  ['asana', '@activepieces/piece-asana'],
  ['azure-blob-storage', '@activepieces/piece-azure-blob-storage'],
  // LLD §3 Phase 3: Azure DI is gated on WORKFLOW_DOC_EXTRACTION_INTEGRATIONS_ENABLED.
  // The loader applies the gate at registration time below; entry remains here for
  // catalog completeness.
  ['azure-document-intelligence', '@abl/piece-azure-document-intelligence'],
  ['claude', '@abl/piece-claude'],
  ['clickup', '@activepieces/piece-clickup'],
  ['discord', '@activepieces/piece-discord'],
  ['github', '@activepieces/piece-github'],
  ['gmail', '@activepieces/piece-gmail'],
  ['google-calendar', '@activepieces/piece-google-calendar'],
  ['google-drive', '@abl/piece-google-drive'],
  ['google-sheets', '@activepieces/piece-google-sheets'],
  ['hubspot', '@activepieces/piece-hubspot'],
  ['jira-cloud', '@abl/piece-jira-cloud'],
  ['linear', '@activepieces/piece-linear'],
  [
    'microsoft-dynamics-365-business-central',
    '@activepieces/piece-microsoft-dynamics-365-business-central',
  ],
  ['microsoft-onedrive', '@activepieces/piece-microsoft-onedrive'],
  ['microsoft-outlook', '@activepieces/piece-microsoft-outlook'],
  ['microsoft-outlook-calendar', '@activepieces/piece-microsoft-outlook-calendar'],
  ['microsoft-power-bi', '@activepieces/piece-microsoft-power-bi'],
  ['microsoft-sharepoint', '@activepieces/piece-microsoft-sharepoint'],
  ['microsoft-teams', '@activepieces/piece-microsoft-teams'],
  ['notion', '@activepieces/piece-notion'],
  ['openai', '@abl/piece-openai'],
  ['pipedrive', '@activepieces/piece-pipedrive'],
  ['postgres', '@activepieces/piece-postgres'],
  ['salesforce', '@activepieces/piece-salesforce'],
  ['sendgrid', '@activepieces/piece-sendgrid'],
  ['servicenow', '@activepieces/piece-service-now'],
  ['shopify', '@abl/piece-shopify'],
  ['slack', '@activepieces/piece-slack'],
  ['stripe', '@activepieces/piece-stripe'],
  ['twilio', '@activepieces/piece-twilio'],
  ['zendesk', '@activepieces/piece-zendesk'],
];

/**
 * Load all available connectors into the registry.
 * Native HTTP connector is eagerly loaded. Activepieces connectors are registered
 * as lazy loaders — they load on first use, not at boot.
 *
 * This reduces startup time from ~10s to <1s and memory from ~800MB to ~200MB.
 */
export async function loadConnectors(registry: ConnectorRegistry): Promise<void> {
  // 1. Register native HTTP connector (eager — cheap, no dependencies)
  if (!registry.has('http')) {
    registry.register(httpConnector);
  }

  // 1b. Register native Docling connector (eager). Was previously gated on
  // WORKFLOW_DOC_EXTRACTION_INTEGRATIONS_ENABLED, but that gate also hid the
  // connector from the Studio process whose `runPieceAuthValidate` looks up
  // the connector to invoke its `auth.validateAuth` hook (Test Credentials).
  // The result was a silent fake-success: Test Credentials returned
  // `valid: true` because the registry didn't know about the connector,
  // even when the credentials were nonsense. Registration is cheap and has
  // no runtime side effects; the env flag now only gates runtime behavior
  // (BullMQ enqueue) at the workflow-engine call site, not the registry.
  if (!registry.has('docling')) {
    const { doclingConnector } = await import('./native/docling/index.js');
    registry.register(doclingConnector);
  }

  // 2. Register all Activepieces pieces as lazy loaders. Azure DI used to be
  // gated on the same env flag — same reason as above, removed.
  let registered = 0;

  for (const [shortName, pkgSpecifier] of PIECE_PACKAGES) {
    if (registry.has(shortName)) {
      continue; // Already registered
    }

    registry.registerLazy(shortName, async () => {
      log.debug(`Loading connector on first use: ${shortName}`);
      try {
        const mod = localRequire(pkgSpecifier);

        if (shortName === 'jira-cloud') {
          applyJiraCloudAuthAdapter(localRequire);
        }
        if (shortName === 'servicenow') {
          applyServiceNowAuthAdapter(localRequire);
        }

        const connector = wrapActivepiecesPiece(shortName, mod);

        log.debug(`Connector loaded: ${shortName}`);
        return connector;
      } catch (err) {
        log.warn(`Failed to load AP piece: ${shortName}`, {
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
    });

    registered++;
  }

  const total = registry.listConnectorNames().length;
  log.info('Connectors registered', {
    // Eager-loaded: HTTP (always) + Docling (when feature flag is on).
    eager: total - registered,
    lazy: registered, // Activepieces lazy entries
    total,
  });
}
