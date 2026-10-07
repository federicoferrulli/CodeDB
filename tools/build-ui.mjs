// Il bundle statico serve browser, Electron e Android; Arc non è contattato a runtime.
import { build, context } from 'esbuild';
const options = {
  entryPoints: ['ui/main.tsx'], outdir: 'public/arc', entryNames: 'ui',
  bundle: true, minify: true, format: 'esm', target: ['chrome120', 'firefox120', 'safari17'],
  jsx: 'automatic', legalComments: 'linked', logLevel: 'info',
};
if (process.argv.includes('--watch')) {
  const ctx = await context(options);
  await ctx.watch();
} else await build(options);
