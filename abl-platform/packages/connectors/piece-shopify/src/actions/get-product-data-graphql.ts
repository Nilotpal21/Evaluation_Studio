/* eslint-disable @typescript-eslint/no-explicit-any */
import { createAction, Property } from '@activepieces/pieces-framework';
import { shopifyAuth } from '@activepieces/piece-shopify';
import { sendShopifyGraphQLRequest } from '../common';
import { parseVariableDeclarations, findUsedVariables } from '../lib/parse-graphql-variables';

const DEFAULT_PRODUCTS_QUERY = `query GetProducts($first: Int!, $cursor: String) {
  products(first: $first, after: $cursor) {
    pageInfo {
      hasNextPage
      endCursor
    }
    nodes {
      id
      title
      status
      vendor
      productType
      totalInventory
      totalVariants
      createdAt
      updatedAt
    }
  }
}`;

export const getProductDataGraphqlAction = createAction({
  name: 'custom_graphql_query',
  auth: shopifyAuth as any,
  displayName: 'Custom GraphQL Query',
  description: 'Execute a custom GraphQL query on your Shopify store.',
  props: {
    query: Property.LongText({
      displayName: 'GraphQL Query',
      description:
        'The GraphQL query to execute. Variables declared in the operation definition will appear as input fields below.',
      required: true,
      defaultValue: DEFAULT_PRODUCTS_QUERY,
    }),
    variableFields: Property.DynamicProperties({
      auth: shopifyAuth as any,
      displayName: 'Variables',
      refreshers: ['query'],
      required: false,
      props: async ({ query }: any): Promise<any> => {
        if (!query || typeof query !== 'string') return {};

        const declared = parseVariableDeclarations(query);
        const fields: Record<string, unknown> = {};

        for (const { name, type, required, isList } of declared) {
          const upperType = type.toUpperCase();
          const typeLabel = isList ? `[${type}]` : type;
          const description = `GraphQL variable $${name}: ${typeLabel}${required ? '!' : ''}`;

          if (isList) {
            // List types → JSON array editor
            fields[name] = Property.Json({ displayName: name, required, description });
          } else if (
            upperType === 'INT' ||
            upperType === 'FLOAT' ||
            upperType === 'UNSIGNEDINT64'
          ) {
            fields[name] = Property.Number({ displayName: name, required, description });
          } else if (upperType === 'BOOLEAN') {
            fields[name] = Property.Checkbox({ displayName: name, required, description });
          } else if (upperType === 'DATETIME') {
            fields[name] = Property.DateTime({ displayName: name, required, description });
          } else if (upperType === 'JSON') {
            fields[name] = Property.Json({ displayName: name, required, description });
          } else if (upperType === 'HTML') {
            // Multi-line HTML content
            fields[name] = Property.LongText({ displayName: name, required, description });
          } else {
            // String, ID, URL, Color, Decimal, FormattedString, enums, custom scalars, input objects
            fields[name] = Property.ShortText({ displayName: name, required, description });
          }
        }

        return fields;
      },
    }),
    variables: Property.Json({
      displayName: 'Extra Variables (Advanced)',
      description:
        'Additional variables merged on top of the generated fields above. Use for query variables not captured by the auto-generated fields.',
      required: false,
    }),
  },
  async run({ auth, propsValue }) {
    const { shopName, adminToken } = (auth as any).props as {
      shopName: string;
      adminToken: string;
    };

    const query = propsValue.query;

    const declared = parseVariableDeclarations(query);
    const declaredNames = declared.map((v) => v.name);

    // Validate: every $var used in the body must be declared in the operation signature
    for (const varName of findUsedVariables(query)) {
      if (!declaredNames.includes(varName)) {
        throw new Error(`Variable "$${varName}" is used but not declared in the query definition.`);
      }
    }

    // Only include declared variables — discards stale params from previous queries
    const dynamicValues = (propsValue.variableFields ?? {}) as Record<string, unknown>;
    const extraVariables =
      propsValue.variables && typeof propsValue.variables === 'object'
        ? (propsValue.variables as Record<string, unknown>)
        : {};

    const variables: Record<string, unknown> = {};
    for (const name of declaredNames) {
      if (name in dynamicValues) variables[name] = dynamicValues[name];
    }
    Object.assign(variables, extraVariables);

    // Coerce UI string values to correct JS types for GraphQL
    for (const { name, type, isList } of declared) {
      const v = variables[name];
      if (v === '' || v === undefined) {
        variables[name] = null;
        continue;
      }
      if (typeof v !== 'string' || isList) continue;
      const t = type.toUpperCase();
      if (t === 'INT' || t === 'UNSIGNEDINT64') {
        const n = parseInt(v, 10);
        if (!isNaN(n)) variables[name] = n;
      } else if (t === 'FLOAT') {
        const n = parseFloat(v);
        if (!isNaN(n)) variables[name] = n;
      } else if (t === 'BOOLEAN') {
        variables[name] = v === 'true';
      }
    }

    return sendShopifyGraphQLRequest(shopName, adminToken, query, variables);
  },
});
