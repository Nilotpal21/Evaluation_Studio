#!/usr/bin/env node
/**
 * Test script for /api/crawl endpoints
 *
 * Tests:
 * 1. POST /api/crawl/batch - Submit crawl job
 * 2. GET /api/crawl/status - Check job status
 *
 * Prerequisites:
 * - search-ai server running
 * - Redis running
 * - Go crawler worker running (optional, for full E2E test)
 */

const API_BASE = process.env.SEARCH_AI_URL || 'http://localhost:3113';

async function submitCrawlJob(urls, options = {}) {
  console.log('\n📤 Submitting crawl job...');
  console.log(`   URLs: ${urls.length}`);
  console.log(`   Options:`, options);

  const response = await fetch(`${API_BASE}/api/crawl/batch`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ urls, options }),
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(`Failed to submit job: ${JSON.stringify(error)}`);
  }

  const result = await response.json();
  console.log('✅ Job submitted successfully');
  console.log(`   Job ID: ${result.jobId}`);
  console.log(`   Batch ID: ${result.batchId}`);
  console.log(`   Status: ${result.status}`);

  return result;
}

async function checkJobStatus(jobId) {
  console.log(`\n🔍 Checking job status: ${jobId}`);

  const response = await fetch(`${API_BASE}/api/crawl/status?jobId=${jobId}`);

  if (!response.ok) {
    const error = await response.json();
    throw new Error(`Failed to get status: ${JSON.stringify(error)}`);
  }

  const result = await response.json();
  console.log(`   State: ${result.state}`);
  console.log(`   Progress: ${JSON.stringify(result.progress)}`);

  if (result.state === 'completed' && result.returnvalue) {
    console.log('\n✅ Job completed!');
    console.log(`   Results:`, JSON.stringify(result.returnvalue, null, 2));
  } else if (result.state === 'failed' && result.failedReason) {
    console.log('\n❌ Job failed!');
    console.log(`   Error:`, result.failedReason);
  }

  return result;
}

async function waitForCompletion(jobId, maxWaitSeconds = 30) {
  console.log(`\n⏳ Waiting for job completion (max ${maxWaitSeconds}s)...`);

  const startTime = Date.now();
  let lastState = '';

  while (Date.now() - startTime < maxWaitSeconds * 1000) {
    const status = await checkJobStatus(jobId);

    if (status.state !== lastState) {
      console.log(`   State changed: ${lastState} → ${status.state}`);
      lastState = status.state;
    }

    if (status.state === 'completed' || status.state === 'failed') {
      return status;
    }

    // Wait 2 seconds before next poll
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }

  console.log('\n⚠️  Job did not complete within timeout');
  return await checkJobStatus(jobId);
}

async function main() {
  console.log('╔════════════════════════════════════════╗');
  console.log('║  Test: /api/crawl Endpoints            ║');
  console.log('╚════════════════════════════════════════╝');

  try {
    // Test 1: Submit a crawl job
    const job = await submitCrawlJob(['https://example.com', 'https://httpbin.org/html'], {
      maxDepth: 1,
      followLinks: false,
      extractMetadata: true,
    });

    // Test 2: Check status immediately
    await checkJobStatus(job.jobId);

    // Test 3: Wait for completion (if Go worker is running)
    console.log('\n💡 Tip: Start Go crawler worker to see job completion');
    console.log('   cd apps/crawler-go-worker && ./run.sh');

    const waitForWorker = process.env.WAIT_FOR_WORKER === 'true';
    if (waitForWorker) {
      await waitForCompletion(job.jobId, 30);
    } else {
      console.log('\n⏭️  Skipping completion wait (set WAIT_FOR_WORKER=true to enable)');
    }

    console.log('\n✅ All tests passed!');
  } catch (error) {
    console.error('\n❌ Test failed:', error.message);
    process.exit(1);
  }
}

main();
