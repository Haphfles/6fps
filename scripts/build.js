import { build } from 'esbuild';
await build({
  stdin: { contents: "export { createClient } from '@supabase/supabase-js';", resolveDir: process.cwd() },
  outfile: 'public/vendor/supabase.js', bundle: true, minify: true,
  format: 'esm', platform: 'browser', target: 'es2022', legalComments: 'linked',
});
