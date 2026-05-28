const SHOPIFY_GRAPHQL_API_VERSION = '2024-10';

// Shopify store names are lowercase alphanumeric with hyphens (no dots, slashes, or other chars)
const SHOP_NAME_RE = /^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/;

export async function sendShopifyGraphQLRequest(
  shopName: string,
  adminToken: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<unknown> {
  if (!SHOP_NAME_RE.test(shopName)) {
    throw new Error(
      `Invalid Shopify shop name "${shopName}". Expected a subdomain like "my-store" (alphanumeric + hyphens only).`,
    );
  }
  if (!adminToken || adminToken.length < 10) {
    throw new Error('Invalid Shopify admin token — token appears to be empty or too short.');
  }
  const url = `https://${shopName}.myshopify.com/admin/api/${SHOPIFY_GRAPHQL_API_VERSION}/graphql.json`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': adminToken,
    },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(
      `Shopify GraphQL error ${response.status} ${response.statusText}: ${body.slice(0, 200)}`,
    );
  }

  const result = (await response.json()) as {
    data?: unknown;
    errors?: Array<{ message: string }>;
    extensions?: unknown;
  };

  if (result.errors && result.errors.length > 0) {
    const messages = result.errors.map((e) => e.message).join('; ');
    throw new Error(`Shopify GraphQL: ${messages}`);
  }

  return result;
}
