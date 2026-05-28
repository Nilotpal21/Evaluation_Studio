import { CrawlerMCPServer } from './server.js';
import { createLogger } from './logger.js';

const transport = process.env.MCP_TRANSPORT ?? 'http';
const port = parseInt(process.env.MCP_PORT ?? '3100', 10);
const log = createLogger('crawler-mcp-entrypoint');

const server = new CrawlerMCPServer();

if (transport === 'stdio') {
  server.startStdio().catch((error) => {
    log.error('Failed to start MCP server (stdio)', {
      error: error instanceof Error ? error.message : String(error),
    });
    process.exit(1);
  });
} else {
  server.startHttp(port).catch((error) => {
    log.error('Failed to start MCP server (HTTP)', {
      error: error instanceof Error ? error.message : String(error),
      port,
    });
    process.exit(1);
  });
}
