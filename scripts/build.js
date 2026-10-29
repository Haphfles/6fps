import { build } from 'esbuild';
import { access, copyFile, mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Repository-root files are the source. public/ is generated for GitHub Pages.
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const output = join(root, 'public');
const files = ['index.html', 'app.js', 'backend.js', 'style.css', 'config.js',
  'admin.html', 'admin.js', 'admin-api.js', 'admin.css', 'video-export.js'];
// Validate the complete upload before replacing any generated output.
await Promise.all(files.map(file => access(join(root, file))));
await rm(output, { recursive: true, force: true });
await mkdir(join(output, 'vendor'), { recursive: true });
await Promise.all(files.map(file => copyFile(join(root, file), join(output, file))));
await build({
  stdin: { contents: "export { createClient } from '@supabase/supabase-js';", resolveDir: root },
  outfile: join(output, 'vendor/supabase.js'), bundle: true, minify: true,
  format: 'esm', platform: 'browser', target: 'es2022', legalComments: 'linked',
});
await build({
  stdin: { contents: "export { Output, Mp4OutputFormat, WebMOutputFormat, BufferTarget, CanvasSource, Quality, canEncodeVideo } from 'mediabunny';", resolveDir: root },
  outfile: join(output, 'vendor/mediabunny.js'), bundle: true, minify: true,
  format: 'esm', platform: 'browser', target: 'es2022', legalComments: 'linked',
});
console.log('6FPS 0.5.2: published repository-root files to public/');
