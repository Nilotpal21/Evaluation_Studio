import { Page } from 'playwright';
import type { NavigateArgs, NavigateResult } from '../types/index.js';

/**
 * Navigate to a URL and wait for page load
 */
export async function navigate(page: Page, args: NavigateArgs): Promise<NavigateResult> {
  try {
    const response = await page.goto(args.url, {
      waitUntil: args.waitFor,
      timeout: args.timeout,
    });

    const title = await page.title();

    return {
      success: true,
      url: page.url(),
      title,
      statusCode: response?.status(),
    };
  } catch (error: any) {
    return {
      success: false,
      url: args.url,
      title: '',
      error: error.message,
    };
  }
}
