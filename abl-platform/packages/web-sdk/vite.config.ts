import { defineConfig } from 'vite';
import { resolve } from 'path';
import dts from 'vite-plugin-dts';

export default defineConfig({
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
  },
  plugins: [dts({ insertTypesEntry: true })],
  build: {
    lib: {
      entry: resolve(__dirname, 'src/index.ts'),
      name: 'AgentSDK',
      formats: ['es', 'umd'],
      fileName: (format) => (format === 'es' ? 'agent-sdk.esm.js' : 'agent-sdk.umd.js'),
    },
    rollupOptions: {
      // The root SDK entry powers the script-tag/web-component embed path, so
      // its browser artifacts must stay self-contained. The separate
      // `@agent-platform/web-sdk/react` entry remains peer-based and is built
      // separately by scripts/create-react-entry.mjs.
      output: { globals: { react: 'React', 'react-dom': 'ReactDOM' } },
    },
    sourcemap: true,
    minify: 'esbuild',
    emptyOutDir: false,
  },
});
