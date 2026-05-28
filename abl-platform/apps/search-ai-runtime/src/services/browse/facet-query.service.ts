/**
 * Facet Query Service
 *
 * Reads entity_instances from ClickHouse to power Browse SDK faceted
 * navigation. All queries use FINAL (ReplacingMergeTree) and are scoped
 * to tenant_id + index_id. Fail-open: ClickHouse errors return empty
 * results, never throw.
 */

import { createLogger } from '@abl/compiler/platform';
import { getClickHouseClient } from '@agent-platform/database/clickhouse';
import type { ClickHouseClient } from '@clickhouse/client';

import { DOC_ID_THRESHOLD } from './types.js';
import type { FacetCountResult, FacetDocumentsResult, FacetResult, FacetValue } from './types.js';

const log = createLogger('facet-query-service');

const TABLE = 'abl_platform.entity_instances';

/** Row shape returned by getFacetValues query */
interface FacetValueRow {
  attribute_type: string;
  product_type: string;
  data_type: string;
  value: string;
  count: string; // ClickHouse returns numbers as strings in JSONEachRow
}

/** Row shape returned by getDocumentsByFacet query */
interface DocumentIdRow {
  document_id: string;
}

/** Row shape returned by count query */
interface CountRow {
  total: string;
}

/** Row shape returned by getFacetCountsForDocuments query */
interface FacetCountRow {
  attribute_type: string;
  product_type: string;
  count: string;
}

/** Row shape returned by getDocumentCountsByProduct query */
interface ProductDocCountRow {
  product_type: string;
  doc_count: string;
}

export class FacetQueryService {
  private client: ClickHouseClient | null = null;

  constructor() {
    try {
      if (process.env.CLICKHOUSE_URL || process.env.CLICKHOUSE_HOST) {
        this.client = getClickHouseClient();
      }
    } catch (error) {
      log.warn('ClickHouse client unavailable — facet queries will return empty results', {
        error: error instanceof Error ? error.message : String(error),
      });
      this.client = null;
    }
  }

  /**
   * Get distinct values for an attribute within a product scope.
   * Returns grouped values with counts, ordered by count descending.
   */
  async getFacetValues(
    tenantId: string,
    indexId: string,
    attributeType: string,
    productType?: string,
    limit = 50,
    offset = 0,
  ): Promise<FacetResult> {
    const empty: FacetResult = {
      attributeType,
      productType: productType ?? '',
      dataType: '',
      values: [],
      total: 0,
    };

    if (!this.client) return empty;

    try {
      const productClause = productType ? 'AND product_type = {productType:String}' : '';

      const query = `
        SELECT attribute_type, product_type, data_type,
               raw_value AS value, count() AS count
        FROM ${TABLE} FINAL
        WHERE tenant_id = {tenantId:String}
          AND index_id = {indexId:String}
          AND attribute_type = {attributeType:String}
          ${productClause}
        GROUP BY attribute_type, product_type, data_type, raw_value
        ORDER BY count DESC
        LIMIT {limit:UInt32} OFFSET {offset:UInt32}
      `;

      const queryParams: Record<string, string | number> = {
        tenantId,
        indexId,
        attributeType,
        limit,
        offset,
      };
      if (productType) {
        queryParams.productType = productType;
      }

      const result = await this.client.query({
        query,
        query_params: queryParams,
        format: 'JSONEachRow',
      });

      const rows = await result.json<FacetValueRow>();

      if (rows.length === 0) return empty;

      const values: FacetValue[] = rows.map((r) => ({
        value: r.value,
        count: Number(r.count),
      }));

      // Run a count query for accurate total (needed for pagination)
      const countQuery = `
        SELECT count(DISTINCT raw_value) AS total
        FROM ${TABLE} FINAL
        WHERE tenant_id = {tenantId:String}
          AND index_id = {indexId:String}
          AND attribute_type = {attributeType:String}
          ${productClause}
      `;
      // Build count params without limit/offset (count query doesn't use them)
      const countParams: Record<string, string | number> = {
        tenantId,
        indexId,
        attributeType,
      };
      if (productType) {
        countParams.productType = productType;
      }
      const countResult = await this.client.query({
        query: countQuery,
        query_params: countParams,
        format: 'JSONEachRow',
      });
      const countRows = await countResult.json<{ total: string }>();
      const total = countRows.length > 0 ? Number(countRows[0].total) : values.length;

      return {
        attributeType: rows[0].attribute_type,
        productType: rows[0].product_type,
        dataType: rows[0].data_type,
        values,
        total,
      };
    } catch (error) {
      log.error('getFacetValues failed', {
        tenantId,
        indexId,
        attributeType,
        error: error instanceof Error ? error.message : String(error),
      });
      return empty;
    }
  }

  /**
   * Get document IDs matching a specific facet value.
   * Returns distinct document IDs and a total count.
   */
  async getDocumentsByFacet(
    tenantId: string,
    indexId: string,
    attributeType: string,
    value: string,
    productType?: string,
    limit = 100,
  ): Promise<FacetDocumentsResult> {
    const empty: FacetDocumentsResult = { documentIds: [], total: 0, truncated: false };

    if (!this.client) return empty;

    try {
      const productClause = productType ? 'AND product_type = {productType:String}' : '';

      const queryParams: Record<string, string | number> = {
        tenantId,
        indexId,
        attributeType,
        value,
        limit,
      };
      if (productType) {
        queryParams.productType = productType;
      }

      // Get distinct document IDs
      const docQuery = `
        SELECT DISTINCT document_id
        FROM ${TABLE} FINAL
        WHERE tenant_id = {tenantId:String}
          AND index_id = {indexId:String}
          AND attribute_type = {attributeType:String}
          AND raw_value = {value:String}
          ${productClause}
        LIMIT {limit:UInt32}
      `;

      // Get total unique count
      const countQuery = `
        SELECT uniqExact(document_id) AS total
        FROM ${TABLE} FINAL
        WHERE tenant_id = {tenantId:String}
          AND index_id = {indexId:String}
          AND attribute_type = {attributeType:String}
          AND raw_value = {value:String}
          ${productClause}
      `;

      const [docResult, countResult] = await Promise.all([
        this.client.query({
          query: docQuery,
          query_params: queryParams,
          format: 'JSONEachRow',
        }),
        this.client.query({
          query: countQuery,
          query_params: queryParams,
          format: 'JSONEachRow',
        }),
      ]);

      const docRows = await docResult.json<DocumentIdRow>();
      const countRows = await countResult.json<CountRow>();

      const total = countRows.length > 0 ? Number(countRows[0].total) : 0;
      const documentIds = docRows.map((r) => r.document_id);

      return {
        documentIds,
        total,
        truncated: total > DOC_ID_THRESHOLD,
      };
    } catch (error) {
      log.error('getDocumentsByFacet failed', {
        tenantId,
        indexId,
        attributeType,
        value,
        error: error instanceof Error ? error.message : String(error),
      });
      return empty;
    }
  }

  /**
   * Get facet count distribution for a set of document IDs (post-search).
   * Used to show facet counts scoped to search results.
   */
  async getFacetCountsForDocuments(
    tenantId: string,
    indexId: string,
    documentIds: string[],
    productType?: string,
  ): Promise<FacetCountResult[]> {
    if (!this.client) return [];
    if (documentIds.length === 0) return [];

    try {
      const productClause = productType ? 'AND product_type = {productType:String}' : '';

      const query = `
        SELECT attribute_type, product_type, count() AS count
        FROM ${TABLE} FINAL
        WHERE tenant_id = {tenantId:String}
          AND index_id = {indexId:String}
          AND document_id IN ({documentIds:Array(String)})
          ${productClause}
        GROUP BY attribute_type, product_type
        ORDER BY count DESC
      `;

      const queryParams: Record<string, string | number | string[]> = {
        tenantId,
        indexId,
        documentIds,
      };
      if (productType) {
        queryParams.productType = productType;
      }

      const result = await this.client.query({
        query,
        query_params: queryParams,
        format: 'JSONEachRow',
      });

      const rows = await result.json<FacetCountRow>();

      return rows.map((r) => ({
        attributeType: r.attribute_type,
        productType: r.product_type,
        count: Number(r.count),
      }));
    } catch (error) {
      log.error('getFacetCountsForDocuments failed', {
        tenantId,
        indexId,
        documentIdCount: documentIds.length,
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  /**
   * Get unique document counts grouped by product_type.
   * Used by the Browse SDK sidebar to show per-product document totals.
   */
  async getDocumentCountsByProduct(
    tenantId: string,
    indexId: string,
  ): Promise<Record<string, number>> {
    if (!this.client) return {};

    try {
      const query = `
        SELECT product_type, uniqExact(document_id) AS doc_count
        FROM ${TABLE} FINAL
        WHERE tenant_id = {tenantId:String}
          AND index_id = {indexId:String}
        GROUP BY product_type
      `;

      const result = await this.client.query({
        query,
        query_params: { tenantId, indexId },
        format: 'JSONEachRow',
      });

      const rows = await result.json<ProductDocCountRow>();

      const counts: Record<string, number> = {};
      for (const row of rows) {
        counts[row.product_type] = Number(row.doc_count);
      }
      return counts;
    } catch (error) {
      log.error('getDocumentCountsByProduct failed', {
        tenantId,
        indexId,
        error: error instanceof Error ? error.message : String(error),
      });
      return {};
    }
  }
}
