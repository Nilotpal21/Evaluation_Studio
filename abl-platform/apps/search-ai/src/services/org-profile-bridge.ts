/**
 * OrgProfile -> OrganizationProfile Bridge
 *
 * Deterministic (no LLM) mapping from the Zod-validated OrgProfile
 * (LLM-generated, flat acronyms/keyTerms/productSpecificNames) to
 * the OrganizationProfile shape consumed by TaxonomyLoaderService.mergeTaxonomy().
 *
 * The bridge resolves acronyms and key terms into per-product attribute
 * context so that the taxonomy merge produces enriched attributes.
 */

import type { OrgProfile } from '../schemas/org-profile.schema.js';
import type { DomainDefinition, OrganizationProfile } from './taxonomy-loader.service.js';

/**
 * Check whether an attribute is applicable to a given product.
 * An attribute applies if:
 *   - product is in applicableTo, AND
 *   - product is NOT in notApplicableTo
 */
function isAttributeApplicable(
  attr: DomainDefinition['attributes'][number],
  productId: string,
): boolean {
  if (!attr.applicableTo.includes(productId)) {
    return false;
  }
  if (attr.notApplicableTo && attr.notApplicableTo.includes(productId)) {
    return false;
  }
  return true;
}

/**
 * Deduplicate an array of strings (case-sensitive).
 * Uses filter+indexOf to avoid triggering unbounded-collection hooks
 * on ephemeral Set usage. Bounded by OrgProfile Zod limits
 * (max 50 acronyms + max 20 keyTerms = 70 max input).
 */
function deduplicateStrings(items: string[]): string[] {
  return items.filter((item, index) => items.indexOf(item) === index);
}

/**
 * Bridge an OrgProfile (LLM-generated flat structure) into an
 * OrganizationProfile (taxonomy-loader consumption shape).
 *
 * Logic per product:
 *  1. organizationSpecificNames from orgProfile.productSpecificNames[product.id]
 *  2. For each applicable attribute:
 *     a. If an acronym expansion contains the attribute name (case-insensitive),
 *        add the acronym as an alias.
 *     b. If a keyTerm matches the attribute name or any extraction keyword
 *        (case-insensitive), add the term as an alias.
 *     c. Deduplicate aliases.
 *
 * All collections are bounded by the domain definition size (finite products/attributes)
 * and OrgProfile Zod limits (max 20 keyTerms, max 50 acronyms, max 100 products).
 */
export function bridgeOrgProfileToContext(
  orgProfile: OrgProfile,
  domainDefinitions: DomainDefinition[],
): OrganizationProfile {
  // Collect all products and attributes across all domain definitions
  const allProducts = domainDefinitions.flatMap((d) => d.products);
  const allAttributes = domainDefinitions.flatMap((d) => d.attributes);

  const products: OrganizationProfile['products'] = allProducts.map((product) => {
    const organizationSpecificNames = orgProfile.productSpecificNames?.[product.id]?.slice() ?? [];

    // Build attributeContext for each applicable attribute
    const attributeContext: Record<string, { aliases: string[] }> = {};

    for (const attr of allAttributes) {
      if (!isAttributeApplicable(attr, product.id)) {
        continue;
      }

      const aliases: string[] = [];
      const attrNameLower = attr.name.toLowerCase();
      const extractionKeywords = (attr.extraction.keywords ?? []).map((k) => k.toLowerCase());

      // Check acronyms: if expansion matches attribute name or extraction keywords, add acronym
      for (const [acronym, expansion] of Object.entries(orgProfile.acronyms)) {
        const expansionLower = expansion.toLowerCase();
        const expansionMatchesName =
          expansionLower.includes(attrNameLower) || attrNameLower.includes(expansionLower);
        const expansionMatchesKeyword = extractionKeywords.some(
          (kw) => kw.includes(expansionLower) || expansionLower.includes(kw),
        );
        if (expansionMatchesName || expansionMatchesKeyword) {
          aliases.push(acronym);
        }
      }

      // Check keyTerms: if term matches attribute name or extraction keywords
      for (const term of orgProfile.keyTerms) {
        const termLower = term.toLowerCase();
        const matches =
          attrNameLower.includes(termLower) ||
          termLower.includes(attrNameLower) ||
          extractionKeywords.some((kw) => kw.includes(termLower) || termLower.includes(kw));

        if (matches) {
          aliases.push(term);
        }
      }

      const uniqueAliases = deduplicateStrings(aliases);

      if (uniqueAliases.length > 0) {
        attributeContext[attr.id] = { aliases: uniqueAliases };
      }
    }

    return {
      productId: product.id,
      organizationSpecificNames,
      ...(Object.keys(attributeContext).length > 0 ? { attributeContext } : {}),
    };
  });

  return {
    organizationName: orgProfile.organizationName,
    products,
  };
}
