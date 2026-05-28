import { Page } from 'playwright';
import type { GetPageContentArgs, PageContentResult } from '../types/index.js';

/**
 * Get current page content (HTML, text, screenshot)
 */
export async function getPageContent(
  page: Page,
  args: GetPageContentArgs,
): Promise<PageContentResult> {
  const result: PageContentResult = {
    url: page.url(),
    title: await page.title(),
  };

  if (args.includeHtml) {
    result.html = await page.content();
  }

  if (args.includeText) {
    result.text = await page.evaluate(() => document.body.innerText);
  }

  if (args.includeScreenshot) {
    const screenshot = await page.screenshot({
      type: 'png',
      fullPage: false,
    });
    result.screenshot = (screenshot as Buffer).toString('base64');
  }

  return result;
}
