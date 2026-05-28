/**
 * DiscoveredUrl — Canonical discovered URL type shared between backend and frontend.
 *
 * Maps from backend types (DepthProbeLink, DiscoveredLink) to a unified
 * frontend-consumable format for the DiscoveryTree and DiscoveryConsole.
 */

/** Confidence tier for discovered URLs */
export type UrlConfidence = 'verified' | 'projected' | 'inferred';

/** Page role classification */
export type PageRole = 'hub' | 'leaf' | 'mixed';

/** Canonical discovered URL — shared backend/frontend */
export interface DiscoveredUrl {
  /** Full URL */
  href: string;
  /** Link text or page title */
  text: string;
  /** How this URL was discovered */
  confidence: UrlConfidence;
  /** Depth level in site hierarchy */
  depth: number;
  /** Category/group this URL belongs to */
  group?: string;
  /** Role of the page that contained this URL */
  sourceRole?: PageRole;
  /** Breadcrumb chain from the source page */
  breadcrumbChain?: Array<{ text: string; href: string }>;
  /** Page title of the source page */
  pageTitle?: string;
}

/**
 * Map a DepthProbeLink to a DiscoveredUrl.
 *
 * DepthProbeLink shape (from crawler-mcp-server/explore/depth-prober.ts):
 *   { href, text, confidence, depth, group?, sourceRole? }
 */
export function fromDepthProbeLink(
  link: {
    href: string;
    text: string;
    confidence: UrlConfidence;
    depth: number;
    group?: string;
    sourceRole?: string;
  },
  breadcrumbs?: Array<{ text: string; href: string }>,
): DiscoveredUrl {
  return {
    href: link.href,
    text: link.text,
    confidence: link.confidence,
    depth: link.depth,
    group: link.group,
    sourceRole: link.sourceRole as PageRole | undefined,
    breadcrumbChain: breadcrumbs,
  };
}

/**
 * Map a DiscoveredLink to a DiscoveredUrl.
 *
 * DiscoveredLink shape (from crawler-mcp-server/explore/navigation-explorer.ts):
 *   { href, text, context?, region? }
 */
export function fromDiscoveredLink(link: { href: string; text: string }, depth = 0): DiscoveredUrl {
  return {
    href: link.href,
    text: link.text,
    confidence: 'verified',
    depth,
  };
}
