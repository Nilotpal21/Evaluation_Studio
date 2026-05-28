// Test BullMQ failure handling
import { Queue } from 'bullmq';
import IORedis from 'ioredis';

const connection = new IORedis({
  host: 'localhost',
  port: 6379,
  maxRetriesPerRequest: null,
});

const queue = new Queue('static-crawl', { connection });

async function testFailureHandling() {
  console.log('🧪 Testing BullMQ Failure Handling\n');

  // Add a job with invalid URLs (will cause failures)
  const job = await queue.add('crawl-batch', {
    urls: [
      'https://invalid-domain-that-does-not-exist-12345.com',
      'https://example.com', // This one should work
    ],
    options: {
      maxDepth: 1,
    },
    batchId: 'test-failure-' + Date.now(),
  });

  console.log(`✅ Job added: ${job.id}`);
  console.log('\n⏳ Waiting for processing (10 seconds)...\n');
  await new Promise((resolve) => setTimeout(resolve, 10000));

  // Check job status
  const updatedJob = await queue.getJob(job.id);
  const state = await updatedJob.getState();

  console.log(`📊 Job Status: ${state}`);

  if (state === 'completed') {
    console.log(`\n✅ Job completed (partial success expected)`);
    const result = updatedJob.returnvalue;
    console.log(`\n📈 Results:`);
    console.log(`   Total URLs: ${result.totalUrls}`);
    console.log(`   Successful: ${result.successful}`);
    console.log(`   Failed: ${result.failed}`);

    // Show individual results
    result.results.forEach((r, i) => {
      console.log(`\n   URL ${i + 1}: ${r.url}`);
      console.log(`      Status: ${r.success ? '✅ Success' : '❌ Failed'}`);
      if (!r.success) {
        console.log(`      Error: ${r.error}`);
      }
    });
  }

  // Check queue stats
  console.log(`\n📊 Queue Statistics:`);
  const counts = await queue.getJobCounts();
  console.log(`   Waiting: ${counts.waiting || 0}`);
  console.log(`   Active: ${counts.active || 0}`);
  console.log(`   Completed: ${counts.completed || 0}`);
  console.log(`   Failed: ${counts.failed || 0}`);

  await queue.close();
  await connection.quit();
  console.log('\n✅ Test complete\n');
}

testFailureHandling().catch(console.error);
