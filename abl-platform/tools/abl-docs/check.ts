import { getOutdatedArtifacts } from './shared.js';

async function main(): Promise<void> {
  const outdated = await getOutdatedArtifacts();

  if (outdated.length === 0) {
    console.log('ABL docs artifacts are up to date.');
    return;
  }

  console.error('ABL docs artifacts are stale. Run `pnpm abl:docs:generate` to refresh:');
  for (const artifact of outdated) {
    console.error(`- ${artifact}`);
  }
  process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(
    error instanceof Error ? error.message : 'Unknown error while checking ABL docs artifacts.',
  );
  process.exitCode = 1;
});
