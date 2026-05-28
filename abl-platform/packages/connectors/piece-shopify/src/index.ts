/* eslint-disable @typescript-eslint/no-explicit-any */
import { createPiece } from '@activepieces/pieces-framework';
import { shopify as apShopify, shopifyAuth } from '@activepieces/piece-shopify';
import { getProductDataGraphqlAction } from './actions/get-product-data-graphql';
import { getProductsAction } from './actions/get-products';

// All AP shopify actions except get_products — replaced by our enhanced REST version.
const apActions = Object.values(apShopify.actions()).filter(
  (a) => a.name !== 'get_products',
) as never[];

export const shopify = createPiece({
  displayName: 'Shopify',
  logoUrl: 'https://cdn.activepieces.com/pieces/shopify.png',
  authors: [],
  description: 'Ecommerce platform for online stores',
  // Cross-package type variance between two pieces-framework instances — cast to bypass.
  auth: shopifyAuth as any,
  actions: [...apActions, getProductsAction, getProductDataGraphqlAction],
  triggers: Object.values(apShopify.triggers()) as never[],
});

export default shopify;
