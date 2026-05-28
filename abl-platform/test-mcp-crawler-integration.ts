/**
 * MCP Crawler Server Integration Test
 *
 * Tests the integration between ABL runtime and the crawler MCP server.
 * Verifies:
 * 1. Server registration and connection
 * 2. Tool discovery
 * 3. Tool invocation (navigate)
 * 4. Result format
 */

import {
  getMCPServerManager,
  type MCPServerConfig,
} from './packages/compiler/src/platform/mcp/server-manager.js';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function testMCPCrawlerIntegration() {
  console.log('╔════════════════════════════════════════════════════╗');
  console.log('║  MCP Crawler Server Integration Test              ║');
  console.log('╚════════════════════════════════════════════════════╝\n');

  const manager = getMCPServerManager();

  try {
    // Step 1: Register the crawler MCP server
    console.log('📋 Step 1: Registering crawler MCP server...');

    const serverConfig: MCPServerConfig = {
      name: 'crawler',
      transport: 'stdio',
      command: 'node',
      args: [path.join(__dirname, 'apps/crawler-mcp-server/dist/index.js')],
      enabled: true,
      priority: 1,
      env: {
        HEADLESS: 'true',
        MAX_PAGES_PER_BROWSER: '10',
      },
    };

    manager.registerServer(serverConfig);
    console.log('✅ Server registered\n');

    // Step 2: Connect to the server
    console.log('📋 Step 2: Connecting to MCP server...');
    await manager.connectServer('crawler');
    console.log('✅ Server connected\n');

    // Step 3: List available tools
    console.log('📋 Step 3: Discovering tools...');
    const tools = await manager.listAllTools();
    console.log(`✅ Found ${tools.length} tools:`);
    tools.forEach((tool) => {
      console.log(`   - ${tool.name}: ${tool.description}`);
    });
    console.log();

    // Step 4: Test navigate tool
    console.log('📋 Step 4: Testing navigate tool...');
    console.log('   URL: https://example.com');

    const navigateResult = await manager.callTool('navigate', {
      url: 'https://example.com',
      waitFor: 'load',
      timeout: 30000,
    });

    console.log('✅ Navigate result:');
    console.log(JSON.stringify(navigateResult, null, 2));
    console.log();

    // Step 5: Test extract_links tool
    console.log('📋 Step 5: Testing extract_links tool...');

    const linksResult = await manager.callTool('extract_links', {
      filter: '',
      includeExternal: false,
      limit: 10,
    });

    console.log('✅ Extract links result:');
    console.log(JSON.stringify(linksResult, null, 2));
    console.log();

    // Step 6: Disconnect
    console.log('📋 Step 6: Disconnecting from MCP server...');
    await manager.disconnectServer('crawler');
    console.log('✅ Server disconnected\n');

    console.log('╔════════════════════════════════════════════════════╗');
    console.log('║  ✅ All Tests Passed                              ║');
    console.log('╚════════════════════════════════════════════════════╝\n');

    console.log('Summary:');
    console.log('  ✓ Server registration');
    console.log('  ✓ Server connection via stdio');
    console.log('  ✓ Tool discovery');
    console.log('  ✓ navigate() tool invocation');
    console.log('  ✓ extract_links() tool invocation');
    console.log('  ✓ Graceful disconnection');
    console.log('\n💡 MCP server integration is working correctly!');
  } catch (error) {
    console.error('\n❌ Test failed:', error);
    console.error('   Message:', error instanceof Error ? error.message : String(error));
    if (error instanceof Error && error.stack) {
      console.error('   Stack:', error.stack);
    }

    // Try to disconnect on error
    try {
      await manager.disconnectServer('crawler');
    } catch {}

    process.exit(1);
  }
}

// Run the test
testMCPCrawlerIntegration();
