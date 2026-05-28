// Test BullMQ integration with proper job completion checking
import { Queue } from 'bullmq';
import IORedis from 'ioredis';

const connection = new IORedis({
  host: 'localhost',
  port: 6379,
  maxRetriesPerRequest: null,
});

const queue = new Queue('static-crawl', { connection });

async function testJobCompletion() {
  console.log('🧪 Testing BullMQ Job Completion\n');

  // Add a test job
  const job = await queue.add('crawl-batch', {
    urls: ['https://example.com', 'https://httpbin.org/html'],
    options: {
      maxDepth: 1,
      followLinks: false,
    },
    batchId: 'test-batch-' + Date.now(),
  });

  console.log(`✅ Job added: ${job.id}`);
  console.log(`   Data:`, JSON.stringify(job.data, null, 2));

  console.log('\n⏳ Waiting for worker to process (15 seconds)...\n');
  await new Promise((resolve) => setTimeout(resolve, 15000));

  // Check job status
  const updatedJob = await queue.getJob(job.id);
  if (!updatedJob) {
    console.log('❌ Job not found');
    await cleanup();
    return;
  }

  const state = await updatedJob.getState();
  console.log(`📊 Job Status:`);
  console.log(`   ID: ${updatedJob.id}`);
  console.log(`   State: ${state}`);
  console.log(`   Progress: ${updatedJob.progress}`);

  if (state === 'completed') {
    console.log(`\n✅ Job completed successfully!`);
    console.log(`\n📦 Return Value:`);
    console.log(JSON.stringify(updatedJob.returnvalue, null, 2));

    // Check if results are properly structured
    const result = updatedJob.returnvalue;
    if (result && result.results) {
      console.log(`\n📈 Statistics:`);
      console.log(`   Total URLs: ${result.totalUrls}`);
      console.log(`   Successful: ${result.successful}`);
      console.log(`   Failed: ${result.failed}`);
      console.log(`   Duration: ${result.duration}ms`);
      console.log(`   Results count: ${result.results.length}`);
    }
  } else if (state === 'failed') {
    console.log(`\n❌ Job failed!`);
    console.log(`   Reason: ${updatedJob.failedReason}`);
  } else if (state === 'active') {
    console.log(`\n⚠️  Job still active (worker may still be processing)`);
  } else {
    console.log(`\n⚠️  Job in unexpected state: ${state}`);
  }

  // Check queue stats
  console.log(`\n📊 Queue Statistics:`);
  const counts = await queue.getJobCounts();
  console.log(`   Waiting: ${counts.waiting || 0}`);
  console.log(`   Active: ${counts.active || 0}`);
  console.log(`   Completed: ${counts.completed || 0}`);
  console.log(`   Failed: ${counts.failed || 0}`);

  await cleanup();
}

async function cleanup() {
  await queue.close();
  await connection.quit();
  console.log('\n✅ Test complete\n');
}

testJobCompletion().catch((err) => {
  console.error('❌ Test error:', err);
  process.exit(1);
});
