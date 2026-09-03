import { build } from 'esbuild';

await build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  outfile: 'dist/index.js',
  sourcemap: true,
  external: ['pg-native'],
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url); import { fileURLToPath as __fturl } from 'node:url'; import { dirname as __dn } from 'node:path'; const __filename = __fturl(import.meta.url); const __dirname = __dn(__filename);",
  },
  logLevel: 'info',
});
