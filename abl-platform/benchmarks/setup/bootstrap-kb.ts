import http from 'k6/http';
import { check, sleep } from 'k6';
import { config, apiPath } from '../lib/config.ts';
import { assertStatus, httpWithRetry, pollUntil } from './helpers.ts';

const SAMPLE_DOCS = [
  {
    filename: 'sample-small.md',
    content: __ENV.DOC_SMALL || 'Sample small document for benchmark testing.',
  },
  {
    filename: 'sample-medium.md',
    content: __ENV.DOC_MEDIUM || 'Sample medium document for benchmark testing.',
  },
  {
    filename: 'sample-large.md',
    content: __ENV.DOC_LARGE || 'Sample large document for benchmark testing.',
  },
];

const KB_NAME = 'benchmark-kb';
const KB_DESCRIPTION = 'Knowledge base for benchmark load testing';

export interface KBSetupResult {
  kbId: string;
  indexId: string;
  sourceId: string;
  documentCount: number;
}

export function bootstrapKB(
  accessToken: string,
  projectId: string,
  overrideSearchAiUrl?: string,
): KBSetupResult {
  const searchAiUrl = overrideSearchAiUrl || config.searchAiUrl;
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${accessToken}`,
    Origin: config.studioUrl,
    'X-Tenant-Id': config.tenantId,
  };

  // Step 1: Check if KB already exists
  const listRes = http.get(`${searchAiUrl}${apiPath('/knowledge-bases')}?projectId=${projectId}`, {
    headers,
  });
  assertStatus(listRes, [200], 'list-kbs');

  const listBody = listRes.json() as {
    knowledgeBases: Array<{
      _id: string;
      name: string;
      searchIndexId: string;
      status: string;
    }>;
  };
  const existing = listBody.knowledgeBases?.find((kb) => kb.name === KB_NAME);

  let kbId: string;
  let indexId: string;
  let sourceId = 'default';

  if (existing) {
    console.log(`[bootstrap-kb] Reusing existing KB: ${existing._id}`);
    kbId = existing._id;
    indexId = existing.searchIndexId;

    // Check if documents already exist
    const docsRes = http.get(`${searchAiUrl}${apiPath(`/indexes/${indexId}/documents`)}`, {
      headers,
    });
    if (docsRes.status === 200) {
      const docsBody = docsRes.json() as { documents?: Array<unknown>; total?: number };
      const docCount = docsBody.documents?.length || docsBody.total || 0;
      if (docCount > 0) {
        console.log(`[bootstrap-kb] KB already has ${docCount} documents, skipping upload`);
        return { kbId, indexId, sourceId, documentCount: docCount };
      }
      console.log(`[bootstrap-kb] KB exists but has 0 documents, uploading...`);
    } else {
      console.warn(
        `[bootstrap-kb] Could not check documents (${docsRes.status}), attempting upload`,
      );
    }
  } else {
    // Create knowledge base (auto-creates SearchIndex + pipeline)
    const createRes = httpWithRetry(
      'POST',
      `${searchAiUrl}${apiPath('/knowledge-bases')}`,
      JSON.stringify({
        projectId,
        name: KB_NAME,
        description: KB_DESCRIPTION,
      }),
      headers,
      { label: 'create-kb' },
    );

    const createOk = check(createRes, {
      'create KB returns 201': (r) => r.status === 201,
    });

    if (!createOk) {
      throw new Error(`Create KB failed: ${createRes.status} ${createRes.body}`);
    }

    const createBody = createRes.json() as {
      knowledgeBase: { _id: string; searchIndexId: string };
    };
    kbId = createBody.knowledgeBase._id;
    indexId = createBody.knowledgeBase.searchIndexId;
    console.log(`[bootstrap-kb] Created KB: ${kbId}, Index: ${indexId}`);

    sleep(5);
  }

  // Create a source for document uploads (or find existing)
  const sourceRes = httpWithRetry(
    'POST',
    `${searchAiUrl}${apiPath(`/indexes/${indexId}/sources`)}`,
    JSON.stringify({
      name: 'benchmark-upload',
      sourceType: 'manual',
    }),
    headers,
    { label: 'create-source' },
  );

  if (sourceRes.status === 201 || sourceRes.status === 200) {
    const sourceBody = sourceRes.json() as {
      source?: { _id: string };
      _id?: string;
    };
    sourceId = sourceBody.source?._id || sourceBody._id || sourceId;
    console.log(`[bootstrap-kb] Using source: ${sourceId}`);
  } else {
    console.warn(`[bootstrap-kb] Source creation returned ${sourceRes.status}, trying 'default'`);
  }

  // Step 4: Upload sample documents
  let uploadedCount = 0;

  for (const doc of SAMPLE_DOCS) {
    const uploadHeaders = {
      Authorization: `Bearer ${accessToken}`,
      Origin: config.studioUrl,
      'X-Tenant-Id': config.tenantId,
    };

    const formData = {
      file: http.file(doc.content, doc.filename, 'text/markdown'),
    };

    const uploadRes = http.post(
      `${searchAiUrl}${apiPath(`/indexes/${indexId}/sources/${sourceId}/documents`)}`,
      formData,
      { headers: uploadHeaders, timeout: '60s' },
    );

    if (uploadRes.status === 201 || uploadRes.status === 200) {
      uploadedCount++;
      console.log(`[bootstrap-kb] Uploaded: ${doc.filename}`);
    } else {
      console.warn(
        `[bootstrap-kb] Upload failed for ${doc.filename}: ${uploadRes.status} ${uploadRes.body}`,
      );
    }
  }

  console.log(`[bootstrap-kb] Uploaded ${uploadedCount}/${SAMPLE_DOCS.length} documents`);

  if (uploadedCount === 0) {
    throw new Error('No documents uploaded successfully');
  }

  // Step 5: Trigger ingestion job
  const jobRes = httpWithRetry(
    'POST',
    `${searchAiUrl}${apiPath('/jobs')}`,
    JSON.stringify({ indexId }),
    headers,
    { label: 'create-job' },
  );

  if (jobRes.status === 201 || jobRes.status === 200) {
    const jobBody = jobRes.json() as { job: { id: string } };
    const jobId = jobBody.job.id;
    console.log(`[bootstrap-kb] Ingestion job created: ${jobId}`);

    // Step 6: Poll for ingestion completion (10s interval, 10min timeout)
    const result = pollUntil(
      `${searchAiUrl}${apiPath(`/jobs/${jobId}`)}`,
      headers,
      (body) => {
        const job = (body as any).job;
        const status = job?.status;
        return status === 'completed' || status === 'failed';
      },
      { intervalSec: 10, timeoutSec: 600, label: 'ingestion-poll' },
    );

    if (result) {
      const job = (result as any).job;
      if (job.status === 'failed') {
        console.error(`[bootstrap-kb] Ingestion failed: ${job.error}`);
      } else {
        console.log(
          `[bootstrap-kb] Ingestion completed: ${job.documentsProcessed}/${job.documentsTotal} docs`,
        );
      }
    }
  } else {
    console.warn(`[bootstrap-kb] Could not create ingestion job: ${jobRes.status}`);
  }

  return { kbId, indexId, sourceId, documentCount: uploadedCount };
}
