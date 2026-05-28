import http from 'k6/http';
import { config } from '../lib/config.ts';
import { assertStatus } from './helpers.ts';

export interface IndexVerificationResult {
  opensearchOk: boolean;
  qdrantOk: boolean;
}

export function verifyIndexes(accessToken: string, indexId: string): IndexVerificationResult {
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${accessToken}`,
    Origin: config.studioUrl,
    'X-Tenant-Id': config.tenantId,
  };

  // Verify OpenSearch index exists
  let opensearchOk = false;
  const osUrl = config.opensearchUrl;
  const osRes = http.get(`${osUrl}/_cat/indices?format=json`, {
    headers: { 'Content-Type': 'application/json' },
  });

  if (osRes.status === 200) {
    const indices = osRes.json() as Array<{ index: string }>;
    opensearchOk = indices.some((idx) => idx.index.includes(indexId));
    if (opensearchOk) {
      console.log(`[bootstrap-indexes] OpenSearch index found for ${indexId}`);
    } else {
      console.warn(
        `[bootstrap-indexes] OpenSearch index NOT found for ${indexId}. ` +
          `Available: ${indices.map((i) => i.index).join(', ')}`,
      );
    }
  } else {
    console.warn(`[bootstrap-indexes] Could not query OpenSearch: ${osRes.status}`);
  }

  // Verify Qdrant collection exists
  let qdrantOk = false;
  const qdrantUrl = config.qdrantUrl;
  const qdrantRes = http.get(`${qdrantUrl}/collections`, {
    headers: { 'Content-Type': 'application/json' },
  });

  if (qdrantRes.status === 200) {
    const body = qdrantRes.json() as {
      result: { collections: Array<{ name: string }> };
    };
    const collections = body.result?.collections || [];
    qdrantOk = collections.some((c) => c.name.includes(indexId));
    if (qdrantOk) {
      console.log(`[bootstrap-indexes] Qdrant collection found for ${indexId}`);
    } else {
      console.warn(
        `[bootstrap-indexes] Qdrant collection NOT found for ${indexId}. ` +
          `Available: ${collections.map((c) => c.name).join(', ')}`,
      );
    }
  } else {
    console.warn(`[bootstrap-indexes] Could not query Qdrant: ${qdrantRes.status}`);
  }

  return { opensearchOk, qdrantOk };
}
