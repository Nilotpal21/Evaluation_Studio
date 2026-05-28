// Test script to add a crawl job to BullMQ queue
// Usage: node test-job.js

import { Queue } from 'bullmq';
import IORedis from 'ioredis';

const connection = new IORedis({
  host: 'localhost',
  port: 6379,
  maxRetriesPerRequest: null,
});

const queue = new Queue('static-crawl', { connection });

async function addTestJob() {
  console.log('Adding test crawl job to queue...\n');

  const job = await queue.add('crawl-batch', {
    urls: ['https://example.com', 'https://example.com/about', 'https://example.com/contact'],
    options: {
      maxDepth: 2,
      followLinks: true,
      extractMetadata: true,
    },
    batchId: 'test-batch-' + Date.now(),
  });

  console.log(`✅ Job added successfully!`);
  console.log(`   Job ID: ${job.id}`);
  console.log(`   Job Name: ${job.name}`);
  console.log(`   URLs: ${job.data.urls.length}`);
  console.log(`\nWaiting for job completion...\n`);

  // Wait for job completion
  const result = await job.waitUntilFinished(queue.events, 30000);

  console.log('✅ Job completed!');
  console.log('\nResults:');
  console.log(JSON.stringify(result, null, 2));

  await queue.close();
  await connection.quit();
}

addTestJob().catch((err) => {
  console.error('❌ Error:', err.message);
  process.exit(1);
});
