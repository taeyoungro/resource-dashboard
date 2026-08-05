// Entry point. One process: it sweeps the buckets, serves the API, and serves the built page.
//
// Logging is key=value on one line to stdout, which systemd sends to the journal, so everything
// below is visible in `journalctl -u opt-dashboard -f`.

import { createServer } from 'node:http';

import {
  authorised, authorisedToAnnounce, HttpError, INGEST_ROUTES, readBody, routes,
} from './api.js';
import { ConfigError, load } from './config.js';
import { client } from './s3.js';
import { makeMarkerBodies } from './markerBodies.js';
import { makeNotifications } from './notifications.js';
import { staticHandler } from './static.js';
import { sweep } from './sweep.js';

const log = {
  info: (...args) => console.log(stamp('INFO '), format(...args)),
  warn: (...args) => console.log(stamp('WARN '), format(...args)),
  error: (...args) => console.error(stamp('ERROR'), format(...args)),
};

function stamp(level) {
  return `${new Date().toISOString()} ${level}`;
}

function format(template, ...args) {
  if (typeof template !== 'string' || args.length === 0) return String(template);
  let i = 0;
  return template.replace(/%[sdif]/g, () => String(args[i++]));
}

function makeStore(s3, config, markerBodies) {
  let state = null;
  let inFlight = null;

  async function refresh(reason) {
    // One sweep at a time. Two overlapping sweeps would double the S3 calls to reach the same
    // answer, and the page's refresh button is one click away from making that happen.
    if (inFlight) return inFlight;
    const started = Date.now();
    inFlight = (async () => {
      try {
        state = await sweep(s3, config, { bodies: markerBodies });
        log.info(
          'sweep reason="%s" failed=%d running=%d awaiting=%d errors=%d skipped=%d '
          + 'bodies=%d held/%d fetched took=%dms',
          reason, state.counts.failed, state.counts.running, state.counts.awaiting_decision,
          state.errors.length, state.skipped_keys ?? 0,
          state.bodies?.held ?? 0, state.bodies?.fetched ?? 0, Date.now() - started,
        );
        for (const problem of state.errors) log.warn('sweep problem: %s', problem);
      } catch (err) {
        // The previous state is kept. A sweep that fails should leave the page showing the last
        // thing that was true, marked stale, rather than an empty list that reads like calm.
        log.error('sweep FAILED reason="%s" error=%s', reason, err.message);
        if (state) state.stale = true;
        throw err;
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  }

  return { get: () => state, refresh };
}

function match(routeTable, method, path) {
  for (const [spec, handler] of Object.entries(routeTable)) {
    const [routeMethod, pattern] = spec.split(' ');
    if (routeMethod !== method) continue;
    const routeParts = pattern.split('/');
    const pathParts = path.split('/');
    if (routeParts.length !== pathParts.length) continue;
    const params = {};
    let ok = true;
    for (let i = 0; i < routeParts.length; i += 1) {
      if (routeParts[i].startsWith(':')) params[routeParts[i].slice(1)] = pathParts[i];
      else if (routeParts[i] !== pathParts[i]) { ok = false; break; }
    }
    if (ok) return { handler, params };
  }
  return null;
}

function json(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf-8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

async function main() {
  let config;
  try {
    config = load();
  } catch (err) {
    if (err instanceof ConfigError) {
      log.error('configuration: %s', err.message);
      process.exit(2);
    }
    throw err;
  }

  const s3 = client(config);
  // Before the store, which reads it on every sweep.
  const markerBodies = makeMarkerBodies({ limit: config.markerBodyCache });
  const store = makeStore(s3, config, markerBodies);
  const notifications = makeNotifications({ limit: config.notificationLimit });
  const routeTable = routes({ config, s3, store, notifications, markerBodies, log });
  const serveStatic = staticHandler(config.staticDir);

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname;

    // Not defence in depth so much as removing a footgun: this page is served from one origin
    // and has no reason to be embedded anywhere or to be sniffed into another type.
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');

    if (!path.startsWith('/api/')) {
      try {
        await serveStatic(req, res, path === '/' ? '/index.html' : path);
      } catch (err) {
        log.error('static %s failed: %s', path, err.message);
        if (!res.headersSent) res.writeHead(500).end('internal error');
      }
      return;
    }

    const route = match(routeTable, req.method, path);
    if (!route) {
      json(res, 404, { error: `no route for ${req.method} ${path}` });
      return;
    }

    // Which key opens which route, decided here and only here.
    //
    // POST /api/notifications takes the ingest key and nothing else. The dashboard's own key is
    // not accepted there and the ingest key is not accepted anywhere else, so the two callers -
    // a person who may approve IAM changes, and a machine that may say a task started - stay
    // separate by construction rather than by convention.
    const spec = `${req.method} ${path}`;
    if (path !== '/api/health') {
      const ok = INGEST_ROUTES.has(spec)
        ? authorisedToAnnounce(config, req.headers['x-api-key'])
        : authorised(config, req.headers['x-api-key']);
      if (!ok) {
        log.warn('unauthorised %s %s from %s', req.method, path, req.socket.remoteAddress);
        json(res, 401, { error: 'X-API-Key missing or wrong' });
        return;
      }
    }

    try {
      // An announcement carries a marker body and is allowed to be large; a decision is a
      // name and a sentence and is not.
      const limit = INGEST_ROUTES.has(spec) ? config.maxAnnouncementBytes : undefined;
      const body = req.method === 'POST' ? await readBody(req, limit) : {};
      json(res, 200, await route.handler({ params: route.params, body }));
    } catch (err) {
      // An HttpError is a condition this code decided on - a bad request id, a plan that is not
      // there, a sweep that has not finished yet. It gets one line. A stack trace is for
      // something nobody anticipated, and printing one for an expected 503 teaches everyone to
      // scroll past stack traces.
      const expected = err instanceof HttpError;
      const status = expected ? err.status : 500;
      if (expected) log.warn('%s %s -> %d: %s', req.method, path, status, err.message);
      else log.error('%s %s failed: %s', req.method, path, err.stack ?? err.message);
      json(res, status, { error: err.message });
    }
  });

  server.listen(config.port, config.bindAddress, () => {
    log.info(
      'listening on %s:%d release=%s markers=s3://%s state=s3://%s region=%s',
      config.bindAddress, config.port, config.release,
      config.markerBucket, config.stateBucket, config.region,
    );
    if (config.bindAddress === '0.0.0.0') {
      log.warn(
        'bound to every interface and speaking plain HTTP - the API key crosses the network in '
        + 'clear unless something in front terminates TLS',
      );
    }
    // Said at startup, because the failure mode is silence. With no ingest key the listener's
    // announcements are refused and nothing anywhere says so except a 401 in its log; the page
    // still works, just a sweep interval behind.
    log.info('announcements %s (POST /api/notifications)',
             config.ingestKey ? 'enabled' : 'DISABLED - OPT_DASHBOARD_INGEST_KEY is not set');
  });

  // The sweep at startup is half of why a lost notification costs nothing: a replaced instance
  // knows the true state of both buckets before anyone looks at it.
  store.refresh('startup').catch(() => {});
  const timer = setInterval(
    () => store.refresh('interval').catch(() => {}),
    config.sweepIntervalSeconds * 1000,
  );
  timer.unref?.();

  const stop = (signal) => {
    log.info('%s received, closing', signal);
    clearInterval(timer);
    server.close(() => process.exit(0));
    // Nothing here is mid-write that matters: a decision is a single PutObject that has either
    // happened or not.
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
}

main().catch((err) => {
  log.error('unhandled: %s', err.stack ?? err.message);
  process.exit(1);
});
