import { defineConfig } from 'vitest/config';
import { resolveVitestPathSelection } from './vitest.path-filters';

const defaultInclude = [
  // Cache-heavy voice adapter coverage that validates the TravelDesk compile path
  // but is too expensive for the merge-gate integration shards.
  'src/__tests__/channels/livekit-voice.integration.test.ts',

  // Benchmark / saturation suites. These validate throughput envelopes, not
  // merge-gate correctness, so they run in an explicit slow lane.
  'src/__tests__/stress/high-throughput-stress.test.ts',
  'src/__tests__/stress/runtime-load.test.ts',
  'src/__tests__/stress/runtime-channel-stress.test.ts',
];

const selection = resolveVitestPathSelection(defaultInclude);

export default defineConfig({
  test: {
    exclude: selection.exclude,
    include: selection.include,
    pool: 'forks',
    maxWorkers: 1,
    fileParallelism: false,
    testTimeout: 300_000,
    hookTimeout: 120_000,
  },
});
