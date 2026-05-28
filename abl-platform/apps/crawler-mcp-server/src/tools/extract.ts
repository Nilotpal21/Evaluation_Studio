import { Page } from 'playwright';
import type {
  ExtractLinksArgs,
  ExtractLinksResult,
  ExtractElementsArgs,
  ExtractElementsResult,
  Link,
  ExtractedElement,
} from '../types/index.js';

/**
 * Extract all links from the current page
 */
export async function extractLinks(
  page: Page,
  args: ExtractLinksArgs,
): Promise<ExtractLinksResult> {
  const links = await page.$$eval(
    'a[href]',
    (anchors, options) => {
      const { filter, includeExternal, limit } = options;
      const currentOrigin = window.location.origin;

      let results = anchors.map((a) => {
        const anchor = a as HTMLAnchorElement;
        return {
          text: anchor.textContent?.trim() || null,
          href: anchor.href,
          title: anchor.title || undefined,
          target: anchor.target || undefined,
        };
      });

      // Filter external links if requested
      if (!includeExternal) {
        results = results.filter((link) => {
          try {
            const linkUrl = new URL(link.href);
            return linkUrl.origin === currentOrigin;
          } catch {
            return false;
          }
        });
      }

      // Apply text/URL filter if provided
      if (filter) {
        const filterRegex = new RegExp(filter, 'i');
        results = results.filter(
          (link) => filterRegex.test(link.href) || filterRegex.test(link.text || ''),
        );
      }

      // Apply limit
      if (limit && limit > 0) {
        results = results.slice(0, limit);
      }

      return results;
    },
    {
      filter: args.filter,
      includeExternal: args.includeExternal,
      limit: args.limit,
    },
  );

  return {
    links: links as Link[],
    count: links.length,
  };
}

/**
 * Extract elements matching a selector
 */
export async function extractElements(
  page: Page,
  args: ExtractElementsArgs,
): Promise<ExtractElementsResult> {
  const elements = await page.$$eval(
    args.selector,
    (els, options) => {
      const { attributes, limit } = options;

      let results = els.map((el) => {
        const data: any = {
          text: el.textContent?.trim() || '',
          html: el.innerHTML,
        };

        // Extract requested attributes
        if (attributes && attributes.length > 0) {
          attributes.forEach((attr) => {
            const value = el.getAttribute(attr);
            if (value !== null) {
              data[attr] = value;
            }
          });
        }

        return data;
      });

      // Apply limit
      if (limit && limit > 0) {
        results = results.slice(0, limit);
      }

      return results;
    },
    {
      attributes: args.attributes || [],
      limit: args.limit,
    },
  );

  return {
    elements: elements as ExtractedElement[],
    count: elements.length,
  };
}
