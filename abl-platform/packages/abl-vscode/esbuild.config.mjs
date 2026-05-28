import * as esbuild from 'esbuild';

const isWatch = process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions} */
const shared = {
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  sourcemap: true,
  minify: false,
};

// Extension client
const extensionBuild = esbuild.build({
  ...shared,
  entryPoints: ['./src/extension.ts'],
  outfile: './dist/extension.js',
  external: ['vscode'],
});

// LSP server (bundled from abl-lsp-server)
const serverBuild = esbuild.build({
  ...shared,
  entryPoints: ['../abl-lsp-server/src/server.ts'],
  outfile: './dist/server.js',
});

if (isWatch) {
  const extCtx = await esbuild.context({
    ...shared,
    entryPoints: ['./src/extension.ts'],
    outfile: './dist/extension.js',
    external: ['vscode'],
  });
  const srvCtx = await esbuild.context({
    ...shared,
    entryPoints: ['../abl-lsp-server/src/server.ts'],
    outfile: './dist/server.js',
  });
  await Promise.all([extCtx.watch(), srvCtx.watch()]);
  console.log('Watching for changes...');
} else {
  await Promise.all([extensionBuild, serverBuild]);
  console.log('Build complete.');
}
