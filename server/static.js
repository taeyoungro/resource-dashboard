// Serving the built page.
//
// The single page application is served from this process, so the browser talks to one origin and
// never learns that S3 exists. That is not a convenience: putting the AWS calls behind this
// server is the only reason the instance may hold a role at all. A page that called S3 directly
// would need credentials in the browser.

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';

const TYPES = new Map(Object.entries({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
}));

// Vite fingerprints everything under assets/, so those may be cached indefinitely. index.html
// must not be: it is what names the current fingerprints, and a cached one points a browser at
// files a deploy has already replaced.
const IMMUTABLE = 'public, max-age=31536000, immutable';
const NEVER = 'no-cache, no-store, must-revalidate';

export function staticHandler(root) {
  const base = resolve(root);

  return async function serve(req, res, urlPath) {
    // normalize collapses ../ before the path is joined, and the resolved result is checked
    // against the root as well - a path is only served if it is genuinely inside.
    const wanted = normalize(decodeURIComponent(urlPath)).replace(/^(\.\.[/\\])+/, '');
    let file = resolve(join(base, wanted));
    if (file !== base && !file.startsWith(base + sep)) {
      res.writeHead(403).end('forbidden');
      return;
    }

    let info = await stat(file).catch(() => null);
    if (info?.isDirectory()) {
      file = join(file, 'index.html');
      info = await stat(file).catch(() => null);
    }
    if (!info) {
      // Client-side routing: an unknown path is a route the page knows about, not a missing file.
      // Only for paths that are not obviously assets, so a mistyped script tag 404s honestly
      // instead of receiving HTML and failing later with a syntax error.
      if (extname(wanted)) {
        res.writeHead(404).end('not found');
        return;
      }
      file = join(base, 'index.html');
      info = await stat(file).catch(() => null);
      if (!info) {
        res.writeHead(404).end(
          'the page has not been built. run: npm ci && npm run build',
        );
        return;
      }
    }

    const type = TYPES.get(extname(file)) ?? 'application/octet-stream';
    const cache = file.endsWith('index.html') ? NEVER : IMMUTABLE;
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': info.size,
      'Cache-Control': cache,
    });
    createReadStream(file).pipe(res);
  };
}
