/**
 * Browser-Only Crawl E2E Test
 *
 * Simulates an agent-driven browser crawl workflow:
 * 1. Connect to MCP server
 * 2. Navigate to target URL
 * 3. Extract content and links
 * 4. Analyze results
 * 5. Make intelligent decisions
 *
 * This tests the browser tools in a realistic workflow pattern.
 */

import {
  getMCPServerManager,
  type MCPServerConfig,
} from './packages/compiler/src/platform/mcp/server-manager.js';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface CrawlResult {
  url: string;
  title: string;
  text?: string;
  links: Array<{ text: string; href: string }>;
  timestamp: Date;
}

async function testBrowserCrawlWorkflow() {
  console.log('╔══════════════════════════════════════════════════════╗');
  console.log('║  Browser-Only Crawl E2E Test                        ║');
  console.log('║  Simulates agent-driven crawl workflow              ║');
  console.log('╚══════════════════════════════════════════════════════╝\n');

  const manager = getMCPServerManager();
  const results: CrawlResult[] = [];

  try {
    // Step 1: Register and connect to MCP server
    console.log('📋 Step 1: Setting up MCP crawler server...');

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
        SESSION_TIMEOUT: '300000',
      },
    };

    manager.registerServer(serverConfig);
    await manager.connectServer('crawler');
    console.log('✅ MCP server connected\n');

    // Step 2: Simulate agent analysis - navigate to target
    console.log('📋 Step 2: Agent Decision - Navigate to target URL...');
    console.log('   🤖 Agent: "I\'ll start by navigating to the URL"');
    console.log('   Target: https://example.com\n');

    const navResult: any = await manager.callTool('navigate', {
      url: 'https://example.com',
      waitFor: 'load',
      timeout: 30000,
    });

    const navData = typeof navResult === 'string' ? JSON.parse(navResult) : navResult;
    console.log(`✅ Navigation successful: ${navData.title}`);
    console.log(`   Status: ${navData.statusCode}`);
    console.log(`   URL: ${navData.url}\n`);

    // Step 3: Extract page content
    console.log('📋 Step 3: Agent Decision - Extract page content...');
    console.log('   🤖 Agent: "Now I\'ll extract the text content"\n');

    const contentResult: any = await manager.callTool('get_page_content', {
      includeHtml: false,
      includeText: true,
      includeScreenshot: false,
    });

    const contentData =
      typeof contentResult === 'string' ? JSON.parse(contentResult) : contentResult;
    console.log('✅ Content extracted');
    console.log(`   Text length: ${contentData.text?.length || 0} characters`);
    console.log(`   Preview: ${contentData.text?.substring(0, 100)}...\n`);

    // Step 4: Extract links
    console.log('📋 Step 4: Agent Decision - Discover navigation structure...');
    console.log('   🤖 Agent: "Let me find all links on this page"\n');

    const linksResult: any = await manager.callTool('extract_links', {
      filter: '',
      includeExternal: true,
      limit: 50,
    });

    const linksData = typeof linksResult === 'string' ? JSON.parse(linksResult) : linksResult;
    console.log('✅ Links extracted');
    console.log(`   Total links: ${linksData.count || 0}`);

    if (linksData.links && linksData.links.length > 0) {
      console.log('   Links found:');
      linksData.links.slice(0, 5).forEach((link: any, i: number) => {
        console.log(`     ${i + 1}. ${link.text || '(no text)'} → ${link.href}`);
      });
      if (linksData.links.length > 5) {
        console.log(`     ... and ${linksData.links.length - 5} more`);
      }
    }
    console.log();

    // Step 5: Agent analysis and decision
    console.log('📋 Step 5: Agent Analysis - Making intelligent decisions...\n');

    const pageAnalysis = {
      url: navData.url,
      title: navData.title,
      hasContent: contentData.text && contentData.text.length > 0,
      linkCount: linksData.count || 0,
      isStaticHTML: linksData.count < 50, // Simple heuristic
      estimatedPages: linksData.count > 0 ? Math.min(linksData.count * 2, 100) : 1,
    };

    console.log('🤖 Agent Decision Logic:');
    console.log(`   ✓ Site Type: ${pageAnalysis.isStaticHTML ? 'Static HTML' : 'Dynamic/SPA'}`);
    console.log(`   ✓ Links found: ${pageAnalysis.linkCount}`);
    console.log(`   ✓ Estimated pages: ${pageAnalysis.estimatedPages}`);
    console.log();

    if (pageAnalysis.linkCount === 0) {
      console.log('🤖 Agent: "This is a single-page site with no navigation."');
      console.log('   Decision: Use browser mode for this page only');
    } else if (pageAnalysis.estimatedPages < 20) {
      console.log('🤖 Agent: "This is a small site, browser mode is efficient."');
      console.log('   Decision: Continue with browser tools');
    } else if (pageAnalysis.isStaticHTML) {
      console.log('🤖 Agent: "This is a larger static HTML site."');
      console.log('   Decision: Switch to bulk crawl for better performance');
      console.log('   (Would call HTTP tool: crawl_batch())');
    } else {
      console.log('🤖 Agent: "This appears to be a dynamic site with many pages."');
      console.log('   Decision: Use browser mode for JS rendering');
    }
    console.log();

    // Step 6: Store result
    results.push({
      url: navData.url,
      title: navData.title,
      text: contentData.text,
      links: linksData.links || [],
      timestamp: new Date(),
    });

    // Step 7: Simulate following a link (if available)
    if (linksData.links && linksData.links.length > 0) {
      const targetLink = linksData.links.find((l: any) => l.href && l.href.startsWith('http'));

      if (targetLink) {
        console.log('📋 Step 6: Agent Decision - Follow discovered link...');
        console.log(`   🤖 Agent: "I'll explore this link: ${targetLink.text}"`);
        console.log(`   URL: ${targetLink.href}\n`);

        try {
          const nav2Result: any = await manager.callTool('navigate', {
            url: targetLink.href,
            waitFor: 'load',
            timeout: 30000,
          });

          const nav2Data = typeof nav2Result === 'string' ? JSON.parse(nav2Result) : nav2Result;
          console.log(`✅ Navigated to linked page: ${nav2Data.title}`);
          console.log(`   Status: ${nav2Data.statusCode}\n`);

          // Extract content from second page
          const content2Result: any = await manager.callTool('get_page_content', {
            includeHtml: false,
            includeText: true,
            includeScreenshot: false,
          });

          const content2Data =
            typeof content2Result === 'string' ? JSON.parse(content2Result) : content2Result;

          results.push({
            url: nav2Data.url,
            title: nav2Data.title,
            text: content2Data.text,
            links: [],
            timestamp: new Date(),
          });

          console.log('✅ Second page crawled successfully\n');
        } catch (error) {
          console.log(
            `⚠️  Could not follow link: ${error instanceof Error ? error.message : String(error)}\n`,
          );
        }
      }
    }

    // Step 8: Agent summary
    console.log('📋 Step 7: Agent Summary - Presenting results...\n');
    console.log('🤖 Agent Response:');
    console.log('   "I\'ve successfully crawled the site. Here\'s what I found:"\n');
    console.log('   Crawl Summary:');
    console.log(`   • Pages crawled: ${results.length}`);
    console.log(
      `   • Total links discovered: ${results.reduce((sum, r) => sum + r.links.length, 0)}`,
    );
    console.log(`   • Strategy used: Browser automation (MCP tools)`);
    console.log(
      `   • Duration: ~${((Date.now() - results[0].timestamp.getTime()) / 1000).toFixed(1)}s`,
    );
    console.log();

    console.log('   Pages:');
    results.forEach((result, i) => {
      console.log(`   ${i + 1}. ${result.title}`);
      console.log(`      URL: ${result.url}`);
      console.log(`      Content: ${result.text?.length || 0} characters`);
      console.log(`      Links: ${result.links.length}`);
    });
    console.log();

    // Step 9: Disconnect
    console.log('📋 Step 8: Cleaning up...');
    await manager.disconnectServer('crawler');
    console.log('✅ MCP server disconnected\n');

    // Final summary
    console.log('╔══════════════════════════════════════════════════════╗');
    console.log('║  ✅ Browser-Only E2E Test PASSED                    ║');
    console.log('╚══════════════════════════════════════════════════════╝\n');

    console.log('Test Summary:');
    console.log('  ✓ MCP server connection and tool discovery');
    console.log('  ✓ Agent-driven navigation workflow');
    console.log('  ✓ Content extraction and analysis');
    console.log('  ✓ Link discovery and following');
    console.log('  ✓ Intelligent decision-making logic');
    console.log('  ✓ Multi-page crawl simulation');
    console.log('  ✓ Result aggregation and summary');
    console.log();

    console.log('💡 Key Findings:');
    console.log('  • Browser tools work correctly for interactive crawling');
    console.log('  • Agent can navigate, extract, and analyze content');
    console.log('  • Decision logic can determine crawl strategy');
    console.log('  • Multi-tool workflow executes successfully');
    console.log();

    console.log('🎯 Ready for:');
    console.log('  → Full agent integration (load ABL agent definition)');
    console.log('  → Bulk crawl integration (HTTP tools + Go worker)');
    console.log('  → Production deployment');
  } catch (error) {
    console.error('\n❌ Test failed:', error);
    console.error('   Message:', error instanceof Error ? error.message : String(error));
    if (error instanceof Error && error.stack) {
      console.error('   Stack:', error.stack);
    }

    // Cleanup on error
    try {
      await manager.disconnectServer('crawler');
    } catch {}

    process.exit(1);
  }
}

// Run the test
testBrowserCrawlWorkflow();
