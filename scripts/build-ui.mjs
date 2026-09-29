/**
 * Builds the two browser bundles and inlines them into single HTML files:
 *   dist/app/timeline.html   the MCP App served as the ui:// resource
 *   dist/sim/*               the Alexa+ simulator (index.html + app.js + app.css)
 */
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const p = (...s) => path.join(root, ...s);

// 1. The timeline MCP App -> ONE self-contained HTML document (hosts load it into a sandboxed iframe).
const js = await build({
  entryPoints: [p('src/app/timeline/main.ts')],
  bundle: true,
  minify: true,
  format: 'iife',
  target: 'es2020',
  write: false,
  legalComments: 'none',
  logLevel: 'warning',
});
const css = readFileSync(p('src/app/timeline/style.css'), 'utf8');
const script = js.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Dinner Bell timeline</title><style>${css}</style></head>
<body><div id="app"></div><script>${script}</script></body></html>`;
mkdirSync(p('dist/app'), { recursive: true });
writeFileSync(p('dist/app/timeline.html'), html);
console.log(`built dist/app/timeline.html (${(html.length / 1024).toFixed(0)} KB)`);

// 2. The simulator SPA.
mkdirSync(p('dist/sim'), { recursive: true });
await build({
  entryPoints: [p('web/sim/app.ts')],
  bundle: true,
  minify: true,
  format: 'iife',
  target: 'es2020',
  outfile: p('dist/sim/app.js'),
  legalComments: 'none',
  logLevel: 'warning',
});
cpSync(p('web/sim/index.html'), p('dist/sim/index.html'));
cpSync(p('web/sim/app.css'), p('dist/sim/app.css'));
console.log('built dist/sim/*');

// 3. The first-party web app (the portfolio product itself).
mkdirSync(p('dist/webapp'), { recursive: true });
await build({
  entryPoints: [p('web/app/app.ts')],
  bundle: true,
  minify: true,
  format: 'iife',
  target: 'es2020',
  outfile: p('dist/webapp/app.js'),
  legalComments: 'none',
  logLevel: 'warning',
});
cpSync(p('web/app/app.css'), p('dist/webapp/app.css'));
// Stamp asset URLs with a content hash so a deploy is picked up immediately despite caching.
const stamp = (file) => createHash('sha256').update(readFileSync(p('dist/webapp', file))).digest('hex').slice(0, 10);
const indexHtml = readFileSync(p('web/app/index.html'), 'utf8')
  .replace('/app.css"', `/app.css?v=${stamp('app.css')}"`)
  .replace('/app.js"', `/app.js?v=${stamp('app.js')}"`);
writeFileSync(p('dist/webapp/index.html'), indexHtml);
console.log('built dist/webapp/*');
