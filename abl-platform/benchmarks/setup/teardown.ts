/**
 * Benchmark Environment Teardown
 *
 * Cleans up all fixtures created by bootstrap.
 */
import http from 'k6/http';
import { config, studioApiPath, apiPath } from '../lib/config.ts';
import { getAuthToken, makeAuthHeaders } from '../lib/auth.ts';
import { assertStatus } from './helpers.ts';

export const options = {
  vus: 1,
  iterations: 1,
};

export default function (): void {
  console.log('=== Benchmark Teardown Starting ===');

  const studioUrl = config.studioUrl;
  const searchAiUrl = config.searchAiUrl;

  // Get auth token using shared auth module
  const accessToken = getAuthToken();
  const headers = makeAuthHeaders(accessToken);

  // Delete search indexes (cascades to documents, chunks, vectors)
  console.log('[teardown] Cleaning up knowledge bases...');
  const kbRes = http.get(`${searchAiUrl}${apiPath('/knowledge-bases')}`, { headers });
  if (kbRes.status === 200) {
    const body = kbRes.json() as {
      knowledgeBases: Array<{ _id: string; name: string }>;
    };
    for (const kb of body.knowledgeBases || []) {
      if (kb.name.includes('benchmark')) {
        const delRes = http.del(`${searchAiUrl}${apiPath(`/knowledge-bases/${kb._id}`)}`, null, {
          headers,
        });
        console.log(`  Deleted KB ${kb._id}: ${delRes.status}`);
      }
    }
  }

  // Delete benchmark project
  console.log('[teardown] Cleaning up project...');
  const projRes = http.get(`${studioUrl}${studioApiPath('/projects')}`, { headers });
  if (projRes.status === 200) {
    const body = projRes.json() as {
      success: boolean;
      projects: Array<{ id: string; name: string }>;
    };
    for (const proj of body.projects || []) {
      if (proj.name === 'benchmark-project') {
        const delRes = http.del(`${studioUrl}${studioApiPath(`/projects/${proj.id}`)}`, null, {
          headers,
        });
        console.log(`  Deleted project ${proj.id}: ${delRes.status}`);
      }
    }
  }

  console.log('=== Benchmark Teardown Complete ===');
}
