import { Page } from 'playwright';
import type { TakeScreenshotArgs, ScreenshotResult } from '../types/index.js';

/**
 * Take a screenshot of the page or a specific element
 */
export async function takeScreenshot(
  page: Page,
  args: TakeScreenshotArgs,
): Promise<ScreenshotResult> {
  let screenshot: string;

  if (args.selector) {
    // Screenshot specific element
    const element = page.locator(args.selector).first();
    const buffer = await element.screenshot({
      type: 'png',
    });
    screenshot = (buffer as Buffer).toString('base64');
  } else {
    // Screenshot full page or viewport
    const buffer = await page.screenshot({
      type: 'png',
      fullPage: args.fullPage,
    });
    screenshot = (buffer as Buffer).toString('base64');
  }

  // Get dimensions
  const viewport = page.viewportSize();

  return {
    screenshot,
    format: 'png',
    width: viewport?.width,
    height: viewport?.height,
  };
}
