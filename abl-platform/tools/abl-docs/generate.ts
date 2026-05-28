import { writeGeneratedArtifacts } from './shared.js';

async function main(): Promise<void> {
  const writtenPaths = await writeGeneratedArtifacts();

  console.log(`Generated ${writtenPaths.length} ABL contract artifact(s):`);
  for (const writtenPath of writtenPaths) {
    console.log(`- ${writtenPath}`);
  }
}

main().catch((error: unknown) => {
  console.error(
    error instanceof Error ? error.message : 'Unknown error while generating ABL docs artifacts.',
  );
  process.exitCode = 1;
});
