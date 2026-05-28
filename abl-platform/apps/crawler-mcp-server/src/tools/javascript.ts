import { Page } from 'playwright';
import type { ExecuteJavaScriptArgs, ExecuteJavaScriptResult } from '../types/index.js';

/**
 * Execute JavaScript in the page context
 */
export async function executeJavaScript(
  page: Page,
  args: ExecuteJavaScriptArgs,
): Promise<ExecuteJavaScriptResult> {
  try {
    const result = args.returnValue
      ? await page.evaluate(args.code)
      : await page.evaluate(args.code).then(() => undefined);

    return {
      success: true,
      result,
    };
  } catch (error: any) {
    return {
      success: false,
      error: error.message,
    };
  }
}
