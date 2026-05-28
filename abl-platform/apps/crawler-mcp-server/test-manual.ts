import { CrawlerMCPServer } from './dist/server.js';

console.log('Starting MCP Crawler Server test...\n');

const server = new CrawlerMCPServer();

// Start the server
await server.start();

console.log('\nServer started successfully!');
console.log('\nRegistered tools:');
console.log('  1. navigate - Navigate to URLs');
console.log('  2. get_page_content - Get HTML/text/screenshot');
console.log('  3. click_element - Click elements');
console.log('  4. type_text - Type into fields');
console.log('  5. scroll - Scroll the page');
console.log('  6. wait_for_element - Wait for elements');
console.log('  7. extract_links - Extract all links');
console.log('  8. extract_elements - Extract matching elements');
console.log('  9. take_screenshot - Take screenshots');
console.log(' 10. execute_javascript - Run JS code');
console.log(' 11. get_page_state - Get page state');

console.log('\nPress Ctrl+C to stop...');

// Keep process alive
process.stdin.resume();
