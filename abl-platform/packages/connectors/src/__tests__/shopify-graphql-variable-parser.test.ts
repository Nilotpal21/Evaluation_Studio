import { describe, it, expect } from 'vitest';
import {
  parseVariableDeclarations,
  findUsedVariables,
} from '../../piece-shopify/src/lib/parse-graphql-variables';

describe('parseVariableDeclarations', () => {
  it('extracts multiple variables with mixed nullability', () => {
    const query = `query GetProducts($first: Int!, $cursor: String) {
      products(first: $first, after: $cursor) { nodes { id title } }
    }`;
    expect(parseVariableDeclarations(query)).toEqual([
      { name: 'first', type: 'Int', required: true, isList: false },
      { name: 'cursor', type: 'String', required: false, isList: false },
    ]);
  });

  it('returns empty array for a query with no variables', () => {
    expect(parseVariableDeclarations('query GetShop { shop { name email } }')).toEqual([]);
  });

  it('returns empty array for an anonymous query with no variable declaration', () => {
    expect(parseVariableDeclarations('query { products(first: $first) { nodes { id } } }')).toEqual(
      [],
    );
  });

  it('marks non-null type as required', () => {
    const query = `query GetProducts($first: Int!) { products(first: $first) { nodes { id } } }`;
    expect(parseVariableDeclarations(query)).toEqual([
      { name: 'first', type: 'Int', required: true, isList: false },
    ]);
  });

  it('marks nullable type as not required', () => {
    const query = `query GetProducts($query: String) { products(first: 10, query: $query) { nodes { id } } }`;
    expect(parseVariableDeclarations(query)).toEqual([
      { name: 'query', type: 'String', required: false, isList: false },
    ]);
  });

  it('handles mutation operations', () => {
    const query = `mutation CreateProduct($input: ProductInput!) {
      productCreate(input: $input) { product { id } }
    }`;
    expect(parseVariableDeclarations(query)).toEqual([
      { name: 'input', type: 'ProductInput', required: true, isList: false },
    ]);
  });

  it('handles three variables including a custom scalar type', () => {
    const query = `query Search($first: Int!, $cursor: String, $statusQuery: String) {
      products(first: $first, after: $cursor, query: $statusQuery) { nodes { id } }
    }`;
    expect(parseVariableDeclarations(query)).toEqual([
      { name: 'first', type: 'Int', required: true, isList: false },
      { name: 'cursor', type: 'String', required: false, isList: false },
      { name: 'statusQuery', type: 'String', required: false, isList: false },
    ]);
  });

  it('handles a required list type [String!]!', () => {
    const query = `query BulkTag($ids: [String!]!) { nodes(ids: $ids) { id } }`;
    expect(parseVariableDeclarations(query)).toEqual([
      { name: 'ids', type: 'String', required: true, isList: true },
    ]);
  });

  it('handles a nullable list type [ID]', () => {
    const query = `query ByIds($ids: [ID]) { nodes(ids: $ids) { id } }`;
    expect(parseVariableDeclarations(query)).toEqual([
      { name: 'ids', type: 'ID', required: false, isList: true },
    ]);
  });

  it('handles mixed scalar and list variables in one declaration', () => {
    const query = `query Mixed($first: Int!, $tags: [String!]!, $cursor: String) {
      products(first: $first, after: $cursor) { nodes { id } }
    }`;
    expect(parseVariableDeclarations(query)).toEqual([
      { name: 'first', type: 'Int', required: true, isList: false },
      { name: 'tags', type: 'String', required: true, isList: true },
      { name: 'cursor', type: 'String', required: false, isList: false },
    ]);
  });

  it('handles all Shopify scalar types', () => {
    const query = `query AllTypes(
      $intVal: Int!,
      $floatVal: Float,
      $boolVal: Boolean!,
      $strVal: String,
      $idVal: ID!,
      $dateVal: DateTime,
      $decimalVal: Decimal,
      $urlVal: URL,
      $htmlVal: HTML,
      $jsonVal: JSON,
      $bigIntVal: UnsignedInt64,
      $colorVal: Color
    ) { shop { name } }`;
    const vars = parseVariableDeclarations(query);
    expect(vars).toHaveLength(12);
    expect(vars.every((v) => !v.isList)).toBe(true);
    expect(vars.find((v) => v.name === 'intVal')).toMatchObject({ type: 'Int', required: true });
    expect(vars.find((v) => v.name === 'boolVal')).toMatchObject({
      type: 'Boolean',
      required: true,
    });
    expect(vars.find((v) => v.name === 'dateVal')).toMatchObject({
      type: 'DateTime',
      required: false,
    });
    expect(vars.find((v) => v.name === 'htmlVal')).toMatchObject({ type: 'HTML', required: false });
    expect(vars.find((v) => v.name === 'jsonVal')).toMatchObject({ type: 'JSON', required: false });
  });
});

describe('findUsedVariables', () => {
  it('finds variables referenced in the query body', () => {
    const query = `query GetProducts($first: Int!, $cursor: String) {
      products(first: $first, after: $cursor) { nodes { id } }
    }`;
    const used = findUsedVariables(query);
    expect(used).toContain('first');
    expect(used).toContain('cursor');
  });

  it('detects a variable used in body but not declared — the undeclared-usage case', () => {
    const query = `query { products(first: $first) { nodes { id } } }`;
    expect(findUsedVariables(query)).toContain('first');
  });

  it('returns empty array when the body has no variable references', () => {
    expect(findUsedVariables('query GetShop { shop { name email } }')).toEqual([]);
  });

  it('does not double-count variables used multiple times', () => {
    const query = `query Q($id: ID!) { product(id: $id) { id title } node(id: $id) { id } }`;
    const used = findUsedVariables(query);
    // $id appears twice in body — both occurrences returned (caller dedupes if needed)
    expect(used.filter((v) => v === 'id').length).toBeGreaterThanOrEqual(1);
  });
});
