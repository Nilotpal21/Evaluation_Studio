import fs from 'node:fs/promises';
import path from 'node:path';

interface ImportRewrite {
  match: RegExp;
  replace: string;
}

const DEFAULT_REWRITES: ImportRewrite[] = [
  // Studio-app aliases — specific paths first before broader patterns
  { match: /(['"])@\/hooks\/useArchChat(['"])/g, replace: '$1@/lib/arch-ai/ui/hook$2' },
  { match: /(['"])@\/store\/(arch-[^'"]+)(['"])/g, replace: '$1@/lib/arch-ai/store/$2$3' },
  // @/types/arch — match exactly '@/types/arch' (no -v4 suffix already, not a subpath like @/types/arch-foo)
  { match: /(['"])@\/types\/arch(?![-\w/])(['"])/g, replace: '$1@/lib/arch-ai/types/arch$2' },
  // @/lib/arch-ai/ subpaths — must NOT match @/lib/arch-ai/ (already converted)
  { match: /(['"])@\/lib\/arch-ai\/([^'"]+)(['"])/g, replace: '$1@/lib/arch-ai/$2$3' },

  // Workspace package — exact match first, then subpath
  // Exact: '@agent-platform/arch-ai' with closing quote (not followed by /)
  {
    match: /(['"])@agent-platform\/arch-ai(?![-/])(['"])/g,
    replace: '$1@agent-platform/arch-ai$2',
  },
  // Subpath: '@agent-platform/arch-ai/' — not already '@agent-platform/arch-ai/'
  { match: /(['"])@agent-platform\/arch-ai\/(?!v4\/)/g, replace: '$1@agent-platform/arch-ai/' },

  // API fetch URLs — '/api/arch-ai/' not already '/api/arch-ai/'
  { match: /(['"])\/api\/arch-ai\/(?!v4\/)/g, replace: '$1/api/arch-ai/' },
];

export function transformImports(
  source: string,
  rewrites: ImportRewrite[] = DEFAULT_REWRITES,
): string {
  let out = source;
  for (const r of rewrites) {
    out = out.replace(r.match, r.replace);
  }
  return out;
}

export interface ModelTransformOptions {
  kind: 'model';
  modelName: string;
  collection: string;
}

export function transformFileContent(source: string, opts?: ModelTransformOptions): string {
  let out = transformImports(source);

  if (opts?.kind === 'model') {
    const { modelName, collection } = opts;
    const v4Name = `${modelName}V4`;
    const interfaceName = `I${modelName}`;
    const v4InterfaceName = `I${v4Name}`;

    // Rename interface references first so that 'IArchSession' doesn't get partially
    // clobbered when we later rename 'ArchSession' (which is a substring of 'IArchSession').
    // The negative lookahead (?!V4) prevents double-renaming on a second pass.
    out = out.replace(new RegExp(`\\b${interfaceName}\\b(?!V4)`, 'g'), v4InterfaceName);

    // Rename model-name identifier — after interface rename so the substring is safe.
    out = out.replace(new RegExp(`\\b${modelName}\\b(?!V4)`, 'g'), v4Name);

    // Add collection override as third arg to the mongoose.model call.
    // After the renames above the call looks like:
    //   mongoose.model<IArchSessionV4>('ArchSessionV4', archSessionSchema)
    // We insert the collection string before the closing ')'.
    const modelCallPattern = new RegExp(
      `(mongoose\\.model<${v4InterfaceName}>\\('${v4Name}',\\s*)([^)]+?)(\\))`,
      'g',
    );
    out = out.replace(modelCallPattern, `$1$2, '${collection}'$3`);
  }

  return out;
}

export interface CloneOptions {
  source: string;
  target: string;
  modelOpts?: ModelTransformOptions;
}

export async function cloneFile(
  opts: CloneOptions,
  repoRoot: string,
): Promise<{ source: string; target: string }> {
  const srcAbs = path.isAbsolute(opts.source) ? opts.source : path.resolve(repoRoot, opts.source);
  const tgtAbs = path.isAbsolute(opts.target) ? opts.target : path.resolve(repoRoot, opts.target);

  await fs.mkdir(path.dirname(tgtAbs), { recursive: true });
  const content = await fs.readFile(srcAbs, 'utf8');
  const transformed = transformFileContent(content, opts.modelOpts);
  await fs.writeFile(tgtAbs, transformed, 'utf8');

  return { source: srcAbs, target: tgtAbs };
}

export async function cloneDir(
  sourceDir: string,
  targetDir: string,
  repoRoot: string,
  filter: (filename: string) => boolean = (f) => f.endsWith('.ts') || f.endsWith('.tsx'),
): Promise<string[]> {
  const srcAbs = path.isAbsolute(sourceDir) ? sourceDir : path.resolve(repoRoot, sourceDir);
  const results: string[] = [];

  async function walk(current: string, relative: string) {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const nextRel = path.join(relative, entry.name);
      const nextAbs = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(nextAbs, nextRel);
      } else if (entry.isFile() && filter(entry.name)) {
        const target = path.join(targetDir, nextRel);
        await cloneFile({ source: nextAbs, target: path.resolve(repoRoot, target) }, repoRoot);
        results.push(target);
      }
    }
  }

  await walk(srcAbs, '');
  return results;
}

// CLI entry point
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  if (args.length < 2) {
    console.error(
      'Usage: pnpm tsx tools/v4-codemod.ts <source> <target> [--model-name=X --collection=Y]',
    );
    process.exit(1);
  }
  const [source, target] = args;
  // Script lives at tools/v4-codemod.ts — repo root is one level up.
  const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
  const modelName = args.find((a) => a.startsWith('--model-name='))?.split('=')[1];
  const collection = args.find((a) => a.startsWith('--collection='))?.split('=')[1];

  (async () => {
    const stat = await fs.stat(path.resolve(repoRoot, source));
    if (stat.isDirectory()) {
      const files = await cloneDir(source, target, repoRoot);
      console.log(`Cloned ${files.length} files from ${source} to ${target}`);
    } else {
      const result = await cloneFile(
        {
          source,
          target,
          modelOpts: modelName && collection ? { kind: 'model', modelName, collection } : undefined,
        },
        repoRoot,
      );
      console.log(`Cloned ${result.source} → ${result.target}`);
    }
  })().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
