import { chromium, Browser, Page, BrowserContext } from 'playwright';
import { createLogger } from '../logger.js';
import type { BrowserSession, BrowserPoolOptions } from '../types/index.js';

const log = createLogger('crawler-mcp-browser-pool');

/**
 * Browser Pool Manager
 *
 * Manages Playwright browser instances and pages efficiently.
 * Reuses browser contexts for different sessions to minimize overhead.
 */
export class BrowserPool {
  private browser: Browser | null = null;
  private sessions: Map<string, BrowserContext> = new Map();
  private pages: Map<string, Page> = new Map();
  private options: BrowserPoolOptions;

  constructor(options?: Partial<BrowserPoolOptions>) {
    this.options = {
      maxBrowsers: 1, // Single browser, multiple contexts
      maxPagesPerBrowser: 50,
      sessionTimeout: 30 * 60 * 1000, // 30 minutes
      headless: true,
      ...options,
    };
  }

  /**
   * Initialize the browser instance
   */
  async initialize(): Promise<void> {
    if (this.browser) return;

    this.browser = await chromium.launch({
      headless: this.options.headless,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu',
      ],
    });

    log.info('Browser pool initialized');
  }

  /**
   * Get or create a page for a session
   */
  async getPage(sessionId: string): Promise<Page> {
    if (!this.browser) {
      await this.initialize();
    }

    // Return existing page if available
    const existingPage = this.pages.get(sessionId);
    if (existingPage && !existingPage.isClosed()) {
      return existingPage;
    }

    // Create new context for this session
    let context = this.sessions.get(sessionId);
    if (!context) {
      context = await this.browser!.newContext({
        viewport: { width: 1920, height: 1080 },
        userAgent:
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        javaScriptEnabled: true,
        acceptDownloads: false,
        bypassCSP: true,
      });
      this.sessions.set(sessionId, context);
    }

    // Create new page in this context
    const page = await context.newPage();
    this.pages.set(sessionId, page);

    // Set reasonable timeouts
    page.setDefaultTimeout(30000);
    page.setDefaultNavigationTimeout(30000);

    return page;
  }

  /**
   * Close a session and cleanup resources
   */
  async closeSession(sessionId: string): Promise<void> {
    const page = this.pages.get(sessionId);
    if (page && !page.isClosed()) {
      await page.close().catch((err) =>
        log.error('Error closing page during session cleanup', {
          error: err instanceof Error ? err.message : String(err),
          sessionId,
        }),
      );
    }
    this.pages.delete(sessionId);

    const context = this.sessions.get(sessionId);
    if (context) {
      await context.close().catch((err) =>
        log.error('Error closing context during session cleanup', {
          error: err instanceof Error ? err.message : String(err),
          sessionId,
        }),
      );
    }
    this.sessions.delete(sessionId);

    log.info('Browser session closed', { sessionId });
  }

  /**
   * Close all sessions and cleanup
   */
  async closeAll(): Promise<void> {
    // Close all pages
    for (const [sessionId, page] of this.pages.entries()) {
      if (!page.isClosed()) {
        await page.close().catch((err) =>
          log.error('Error closing page during global cleanup', {
            error: err instanceof Error ? err.message : String(err),
            sessionId,
          }),
        );
      }
    }
    this.pages.clear();

    // Close all contexts
    for (const [sessionId, context] of this.sessions.entries()) {
      await context.close().catch((err) =>
        log.error('Error closing context during global cleanup', {
          error: err instanceof Error ? err.message : String(err),
          sessionId,
        }),
      );
    }
    this.sessions.clear();

    // Close browser
    if (this.browser) {
      await this.browser.close().catch((err) =>
        log.error('Error closing browser during global cleanup', {
          error: err instanceof Error ? err.message : String(err),
        }),
      );
      this.browser = null;
    }

    log.info('Browser pool closed');
  }

  /**
   * Get session statistics
   */
  getStats() {
    return {
      activeSessions: this.sessions.size,
      activePages: this.pages.size,
      browserRunning: this.browser !== null,
    };
  }

  /**
   * Cleanup stale sessions (sessions not used for > sessionTimeout)
   */
  async cleanupStaleSessions(): Promise<void> {
    const now = Date.now();
    const staleSessionIds: string[] = [];

    // Find stale sessions (implement lastUsed tracking if needed)
    // For now, this is a placeholder for future enhancement

    for (const sessionId of staleSessionIds) {
      await this.closeSession(sessionId);
    }
  }
}
