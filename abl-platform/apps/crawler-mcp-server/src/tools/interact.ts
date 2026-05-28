import { Page } from 'playwright';
import type {
  ClickElementArgs,
  ClickResult,
  TypeTextArgs,
  TypeTextResult,
  ScrollArgs,
  ScrollResult,
  WaitForElementArgs,
  WaitForElementResult,
} from '../types/index.js';

/**
 * Click an element on the page
 */
export async function clickElement(page: Page, args: ClickElementArgs): Promise<ClickResult> {
  try {
    const element = page.locator(args.selector).first();

    await element.waitFor({ state: 'visible', timeout: args.timeout });
    await element.click({ timeout: args.timeout });

    // Wait after click if specified
    if (args.waitAfterClick > 0) {
      await page.waitForTimeout(args.waitAfterClick);
    }

    // Wait for any network activity to settle
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {
      // Ignore timeout - page might have ongoing requests
    });

    return {
      success: true,
      selector: args.selector,
      message: `Clicked element: ${args.selector}`,
    };
  } catch (error: any) {
    return {
      success: false,
      selector: args.selector,
      message: `Failed to click element: ${args.selector}`,
      error: error.message,
    };
  }
}

/**
 * Type text into an input field
 */
export async function typeText(page: Page, args: TypeTextArgs): Promise<TypeTextResult> {
  try {
    const element = page.locator(args.selector).first();

    await element.waitFor({ state: 'visible', timeout: args.timeout });

    if (args.clearFirst) {
      await element.clear();
    }

    await element.type(args.text, { timeout: args.timeout });

    if (args.pressEnter) {
      await element.press('Enter');
      await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
    }

    return {
      success: true,
      selector: args.selector,
      text: args.text,
    };
  } catch (error: any) {
    return {
      success: false,
      selector: args.selector,
      text: args.text,
      error: error.message,
    };
  }
}

/**
 * Scroll the page
 */
export async function scroll(page: Page, args: ScrollArgs): Promise<ScrollResult> {
  const scrollPosition = await page.evaluate(
    ({ direction, amount }) => {
      if (direction === 'to_bottom') {
        window.scrollTo(0, document.body.scrollHeight);
      } else if (direction === 'to_top') {
        window.scrollTo(0, 0);
      } else if (direction === 'down') {
        window.scrollBy(0, amount || 500);
      } else if (direction === 'up') {
        window.scrollBy(0, -(amount || 500));
      }

      return {
        x: window.scrollX,
        y: window.scrollY,
        maxX: document.body.scrollWidth - window.innerWidth,
        maxY: document.body.scrollHeight - window.innerHeight,
      };
    },
    { direction: args.direction, amount: args.amount },
  );

  // Wait for any lazy-loaded content
  await page.waitForTimeout(500);

  return {
    success: true,
    scrollPosition: {
      x: scrollPosition.x,
      y: scrollPosition.y,
    },
    maxScroll: {
      x: scrollPosition.maxX,
      y: scrollPosition.maxY,
    },
  };
}

/**
 * Wait for an element to appear
 */
export async function waitForElement(
  page: Page,
  args: WaitForElementArgs,
): Promise<WaitForElementResult> {
  try {
    const element = page.locator(args.selector).first();
    await element.waitFor({ state: args.state, timeout: args.timeout });

    return {
      success: true,
      selector: args.selector,
      found: true,
    };
  } catch (error: any) {
    return {
      success: false,
      selector: args.selector,
      found: false,
      error: error.message,
    };
  }
}
