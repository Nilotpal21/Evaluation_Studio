/**
 * Multimodal Service Benchmarks
 *
 * Tests: image upload+resize, video transcode, mixed media pipeline.
 * Target: Runtime multimodal endpoints at port 3112.
 */
import http from 'k6/http';
import { check, sleep } from 'k6';
import { config, getAuthHeaders } from '../lib/config.js';
import { successRate, errorCount, queueWaitTime } from '../lib/metrics.js';
import { Trend, Counter } from 'k6/metrics';

const BASE = config.runtimeUrl;
const HEADERS = getAuthHeaders();
const PROJECT_ID = config.projectId;

const imageProcessingTime = new Trend('abl_image_processing_time_ms', true);
const videoTranscodeTime = new Trend('abl_video_transcode_time_ms', true);
const mediaUploadSize = new Counter('abl_media_upload_bytes');

/** Generate a random binary-like string of given size in bytes */
function generateFakePayload(sizeKB: number): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  const targetLength = sizeKB * 1024;
  for (let i = 0; i < targetLength; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

export const options = {
  scenarios: {
    image_upload_resize: {
      executor: 'constant-arrival-rate',
      rate: 5,
      timeUnit: '1s',
      duration: '3m',
      preAllocatedVUs: 10,
      maxVUs: 25,
      exec: 'imageUploadResize',
    },
    video_transcode: {
      executor: 'per-vu-iterations',
      vus: 2,
      iterations: 5,
      startTime: '3m',
      exec: 'videoTranscode',
    },
    mixed_media: {
      executor: 'ramping-vus',
      startVUs: 1,
      stages: [
        { duration: '1m', target: 10 },
        { duration: '2m', target: 20 },
        { duration: '1m', target: 0 },
      ],
      startTime: '6m',
      exec: 'mixedMedia',
    },
    concurrent_uploads: {
      executor: 'ramping-vus',
      startVUs: 5,
      stages: [
        { duration: '1m', target: 30 },
        { duration: '2m', target: 50 },
        { duration: '1m', target: 0 },
      ],
      startTime: '10m',
      exec: 'concurrentUploads',
    },
  },
  thresholds: {
    'http_req_duration{scenario:image_upload_resize}': ['p(95)<5000', 'p(99)<10000'],
    'http_req_duration{scenario:video_transcode}': ['p(95)<30000', 'p(99)<60000'],
    'http_req_duration{scenario:mixed_media}': ['p(95)<8000', 'p(99)<15000'],
    http_req_failed: ['rate<0.05'],
    abl_image_processing_time_ms: ['p(95)<5000'],
  },
};

/** Upload an image and request resize */
export function imageUploadResize(): void {
  const imageSizeKB = Math.floor(Math.random() * 500) + 100; // 100-600KB
  const payload = JSON.stringify({
    data: generateFakePayload(imageSizeKB),
    mimeType: 'image/png',
    operations: [{ type: 'resize', width: 800, height: 600, fit: 'contain' }],
  });

  mediaUploadSize.add(imageSizeKB * 1024);
  const start = Date.now();

  const res = http.post(`${BASE}/api/projects/${PROJECT_ID}/media/process`, payload, {
    headers: HEADERS,
    tags: { scenario: 'image_upload_resize' },
    timeout: '30s',
  });

  imageProcessingTime.add(Date.now() - start);

  const ok = check(res, {
    'image processed 200': (r) => r.status === 200,
    'has output url': (r) => {
      const body = r.json() as Record<string, unknown>;
      return typeof body.url === 'string' || typeof body.outputPath === 'string';
    },
  });

  successRate.add(ok ? 1 : 0);
  if (!ok) errorCount.add(1);
  sleep(0.2);
}

/** Submit a video for transcoding */
export function videoTranscode(): void {
  const payload = JSON.stringify({
    sourceUrl: `https://storage.example.com/bench-video-${__VU}-${__ITER}.mp4`,
    mimeType: 'video/mp4',
    operations: [
      { type: 'transcode', format: 'webm', quality: 'medium' },
      { type: 'thumbnail', timestamp: 5, width: 320, height: 240 },
    ],
  });

  const start = Date.now();
  const res = http.post(`${BASE}/api/projects/${PROJECT_ID}/media/process`, payload, {
    headers: HEADERS,
    tags: { scenario: 'video_transcode' },
    timeout: '120s',
  });

  if (res.status === 202) {
    // Async processing: poll for completion
    const body = res.json() as Record<string, string>;
    const jobId = body.jobId;
    for (let i = 0; i < 30; i++) {
      sleep(2);
      const poll = http.get(`${BASE}/api/projects/${PROJECT_ID}/media/jobs/${jobId}`, {
        headers: HEADERS,
        tags: { scenario: 'video_transcode' },
      });
      const status = (poll.json() as Record<string, string>).status;
      if (status === 'completed' || status === 'failed') {
        videoTranscodeTime.add(Date.now() - start);
        successRate.add(status === 'completed' ? 1 : 0);
        return;
      }
    }
    errorCount.add(1);
    successRate.add(0);
  } else {
    videoTranscodeTime.add(Date.now() - start);
    const ok = check(res, { 'video transcode 200': (r) => r.status === 200 });
    successRate.add(ok ? 1 : 0);
    if (!ok) errorCount.add(1);
  }

  sleep(1);
}

/** Upload mixed media (images + text) in a single request */
export function mixedMedia(): void {
  const payload = JSON.stringify({
    items: [
      { type: 'text', content: 'Benchmark mixed media test content' },
      { type: 'image', data: generateFakePayload(200), mimeType: 'image/jpeg' },
      { type: 'text', content: 'Additional context after the image' },
    ],
  });

  mediaUploadSize.add(200 * 1024);
  const start = Date.now();

  const res = http.post(`${BASE}/api/projects/${PROJECT_ID}/media/process`, payload, {
    headers: HEADERS,
    tags: { scenario: 'mixed_media' },
    timeout: '30s',
  });

  queueWaitTime.add(Date.now() - start);

  const ok = check(res, {
    'mixed media 200': (r) => r.status === 200,
  });

  successRate.add(ok ? 1 : 0);
  if (!ok) errorCount.add(1);
  sleep(0.5);
}

/** High concurrency image uploads to stress the processing queue */
export function concurrentUploads(): void {
  const payload = JSON.stringify({
    data: generateFakePayload(250),
    mimeType: 'image/png',
    operations: [{ type: 'resize', width: 400, height: 300 }],
  });

  mediaUploadSize.add(250 * 1024);

  const res = http.post(`${BASE}/api/projects/${PROJECT_ID}/media/process`, payload, {
    headers: HEADERS,
    tags: { scenario: 'concurrent_uploads' },
    timeout: '30s',
  });

  const ok = check(res, { 'concurrent upload 200': (r) => r.status === 200 });
  successRate.add(ok ? 1 : 0);
  if (!ok) errorCount.add(1);
  sleep(0.1);
}
