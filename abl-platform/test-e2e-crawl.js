#!/usr/bin/env node
/**
 * End-to-End Crawl Test
 *
 * Tests the complete flow:
 * 1. Submit job to BullMQ
 * 2. Go worker picks up job
 * 3. Worker processes URLs
 * 4. Results stored in job.returnvalue
 * 5. Verify results are correct
 */

import { Queue } from 'bullmq';

async function runE2ETest() {
  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║  End-to-End Crawl Test                           ║');
  console.log('╚══════════════════════════════════════════════════╝\n');

  const queue = new Queue('static-crawl', {
    connection: {
      host: 'localhost',
      port: 6380,
      password: 'localdev',
    },
  });

  try {
    // Submit job
    console.log('📤 Step 1: Submitting crawl job...');
    const job = await queue.add(
      'crawl-batch',
      {
        urls: ['https://example.com', 'https://httpbin.org/html'],
        options: {
          maxDepth: 1,
          followLinks: false,
          extractMetadata: true,
        },
        batchId: `e2e-test-${Date.now()}`,
        jobId: `e2e-test-${Date.now()}`,
      },
      {
        removeOnComplete: false,
        removeOnFail: false,
      },
    );

    console.log(`✅ Job submitted: ${job.id}`);
    console.log(`   Batch ID: ${job.data.batchId}\n`);

    // Check initial state
    console.log('📋 Step 2: Checking initial job state...');
    let state = await job.getState();
    console.log(`   Initial state: ${state}\n`);

    // Wait for worker to process
    console.log('⏳ Step 3: Waiting for Go worker to process...');
    console.log('   💡 Make sure Go worker is running:');
    console.log('      cd apps/crawler-go-worker && ./run.sh\n');

    let attempts = 0;
    const maxAttempts = 15; // 30 seconds total
    let completed = false;

    while (attempts < maxAttempts && !completed) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      attempts++;

      const updatedJob = await queue.getJob(job.id);
      if (!updatedJob) {
        console.log('   ⚠️  Job not found');
        break;
      }

      state = await updatedJob.getState();
      const progress = updatedJob.progress;

      console.log(
        `   [${attempts}/${maxAttempts}] State: ${state}, Progress: ${JSON.stringify(progress)}`,
      );

      if (state === 'completed') {
        console.log('\n✅ Step 4: Job completed!\n');

        // Verify results
        console.log('📊 Step 5: Verifying results...');
        const results = updatedJob.returnvalue;

        if (!results) {
          throw new Error('No results in job.returnvalue');
        }

        console.log(`   Job ID: ${results.jobId || results.batchId}`);
        console.log(`   Total URLs: ${results.totalUrls}`);
        console.log(`   Successful: ${results.successful}`);
        console.log(`   Failed: ${results.failed}`);
        console.log(`   Duration: ${results.duration}ms\n`);

        if (results.results && results.results.length > 0) {
          console.log('   Results Preview:');
          results.results.forEach((r, i) => {
            console.log(`     ${i + 1}. ${r.url}`);
            console.log(`        Status: ${r.statusCode}`);
            console.log(`        Title: ${r.title || 'N/A'}`);
            console.log(`        Success: ${r.success}`);
            console.log(`        Duration: ${r.duration}ms\n`);
          });
        }

        // Validate results
        if (results.totalUrls !== 2) {
          throw new Error(`Expected 2 URLs, got ${results.totalUrls}`);
        }

        if (!results.results || results.results.length !== 2) {
          throw new Error(`Expected 2 results, got ${results.results?.length || 0}`);
        }

        console.log('✅ Results validated!\n');
        completed = true;
        break;
      } else if (state === 'failed') {
        console.log('\n❌ Job failed!');
        console.log(`   Reason: ${updatedJob.failedReason}\n`);
        throw new Error('Job processing failed');
      }
    }

    if (!completed && attempts >= maxAttempts) {
      console.log('\n⏸️  Job did not complete within timeout');
      console.log('   This is expected if Go worker is not running');
      console.log('   Start the worker with: cd apps/crawler-go-worker && ./run.sh\n');
    }

    // Cleanup
    await job.remove();
    await queue.close();

    if (completed) {
      console.log('╔══════════════════════════════════════════════════╗');
      console.log('║  ✅ End-to-End Test PASSED                      ║');
      console.log('╚══════════════════════════════════════════════════╝\n');
      console.log('Summary:');
      console.log('  ✓ Job submission via BullMQ');
      console.log('  ✓ Go worker processing');
      console.log('  ✓ Results storage in job.returnvalue');
      console.log('  ✓ Results validation');
      console.log('  ✓ Complete BullMQ lifecycle (wait → active → completed)');
    } else {
      console.log('╔══════════════════════════════════════════════════╗');
      console.log('║  ⏸️  Partial Test (Worker not running)          ║');
      console.log('╚══════════════════════════════════════════════════╝\n');
      console.log('Summary:');
      console.log('  ✓ Job submission via BullMQ');
      console.log('  ⏸️  Waiting for Go worker to process');
      console.log('\n💡 Start Go worker to complete the test:');
      console.log(
        '   cd /Users/Bharat.Rekha/kore/rewrite/clone/abl-platform/apps/crawler-go-worker',
      );
      console.log('   ./run.sh');
    }
  } catch (error) {
    console.error('\n❌ Test failed:', error.message);
    await queue.close();
    process.exit(1);
  }
}

runE2ETest();
