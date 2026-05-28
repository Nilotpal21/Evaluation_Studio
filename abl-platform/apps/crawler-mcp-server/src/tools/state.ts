import { Page } from 'playwright';
import type { GetPageStateArgs, PageState } from '../types/index.js';

/**
 * Get current page state (URL, title, scroll position, etc.)
 */
export async function getPageState(page: Page, args: GetPageStateArgs): Promise<PageState> {
  const [scrollInfo, viewport, cookies, localStorage] = await Promise.all([
    page.evaluate(() => ({
      x: window.scrollX,
      y: window.scrollY,
      maxY: document.body.scrollHeight - window.innerHeight,
    })),
    page.viewportSize(),
    args.includeCookies ? page.context().cookies() : Promise.resolve(undefined),
    args.includeLocalStorage
      ? page.evaluate(() => {
          const storage: Record<string, string> = {};
          for (let i = 0; i < window.localStorage.length; i++) {
            const key = window.localStorage.key(i);
            if (key) {
              storage[key] = window.localStorage.getItem(key) || '';
            }
          }
          return storage;
        })
      : Promise.resolve(undefined),
  ]);

  return {
    url: page.url(),
    title: await page.title(),
    scroll: scrollInfo,
    viewport: {
      width: viewport?.width || 0,
      height: viewport?.height || 0,
    },
    cookies,
    localStorage,
  };
}
