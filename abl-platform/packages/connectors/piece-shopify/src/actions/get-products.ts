/* eslint-disable @typescript-eslint/no-explicit-any */
import { createAction, Property } from '@activepieces/pieces-framework';
import { shopifyAuth } from '@activepieces/piece-shopify';
import { getBaseUrl } from '@activepieces/piece-shopify/src/lib/common/index';

export const getProductsAction = createAction({
  name: 'get_products',
  auth: shopifyAuth as any,
  displayName: 'Get Products',
  description:
    'Get products from your Shopify store. Use filters to narrow results and limit to control page size.',
  props: {
    limit: Property.Number({
      displayName: 'Limit',
      description: 'Maximum number of products to return (1–250). Defaults to 50.',
      required: false,
      defaultValue: 50,
    }),
    title: Property.ShortText({
      displayName: 'Title',
      description: 'Filter products whose title contains this text (case-insensitive).',
      required: false,
    }),
    vendor: Property.ShortText({
      displayName: 'Vendor',
      description: 'Filter products by vendor name (exact match).',
      required: false,
    }),
    product_type: Property.ShortText({
      displayName: 'Product Type',
      description: 'Filter products by product type (exact match).',
      required: false,
    }),
    status: Property.StaticDropdown({
      displayName: 'Status',
      description: 'Filter products by publication status.',
      required: false,
      options: {
        disabled: false,
        options: [
          { label: 'Active', value: 'active' },
          { label: 'Archived', value: 'archived' },
          { label: 'Draft', value: 'draft' },
        ],
      },
    }),
  },
  async run({ auth, propsValue }) {
    const { shopName, adminToken } = (auth as any).props as {
      shopName: string;
      adminToken: string;
    };

    const rawLimit = propsValue.limit ?? 50;
    const limit = Math.min(
      Math.max(1, typeof rawLimit === 'number' ? rawLimit : Number(rawLimit)),
      250,
    );

    const query = new URLSearchParams();
    query.set('limit', String(limit));
    if (propsValue.title && String(propsValue.title).trim())
      query.set('title', String(propsValue.title).trim());
    if (propsValue.vendor && String(propsValue.vendor).trim())
      query.set('vendor', String(propsValue.vendor).trim());
    if (propsValue.product_type && String(propsValue.product_type).trim())
      query.set('product_type', String(propsValue.product_type).trim());
    if (propsValue.status && String(propsValue.status).trim())
      query.set('status', String(propsValue.status).trim());

    const url = `${getBaseUrl(shopName)}/products.json?${query.toString()}`;

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'X-Shopify-Access-Token': adminToken,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(
        `Shopify API error ${response.status} ${response.statusText}: ${body.slice(0, 200)}`,
      );
    }

    const data = (await response.json()) as { products: unknown[] };
    return data.products ?? [];
  },
});
