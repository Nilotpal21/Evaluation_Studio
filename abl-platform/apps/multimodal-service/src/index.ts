/**
 * Multimodal Service Entry Point
 */

// Load environment variables from .env file
import 'dotenv/config';

import { createLogger } from '@abl/compiler/platform';
import { loadConfig } from './config.js';

const log = createLogger('multimodal-service');

async function main(): Promise<void> {
  try {
    await loadConfig({
      vaultType: 'env',
      throwOnError: true,
      logSummary: true,
    });

    const { startServer } = await import('./server.js');
    await startServer();
  } catch (error) {
    log.error('Failed to start multimodal-service', {
      error: error instanceof Error ? error.message : String(error),
    });
    process.exit(1);
  }
}

main();
