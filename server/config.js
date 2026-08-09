// Configuration, from the environment. Nothing is read from a file the browser can reach and
// nothing has an AWS credential in it - the role arrives through the instance profile.
//
// Every value that cannot be guessed is required, and the process refuses to start without it.
// A dashboard that starts against the wrong bucket does not fail: it shows an empty list, which
// reads exactly like "nothing is wrong".

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REQUIRED = ['OPT_MARKER_BUCKET', 'OPT_STATE_BUCKET', 'OPT_DASHBOARD_API_KEY'];

/** Which commit is running, for the issued_by field on every approval marker.
 *
 * install.sh writes this to a file beside the code; the deploy workflow passes the commit to it.
 * Nothing puts it in the environment - the environment file is written by hand on the host and a
 * deploy must not rewrite it - so reading only OPT_RELEASE meant every approval marker recorded
 * "unknown" and could not be traced to a build. That was the one thing issued_by was for.
 *
 * Resolved from the module's own location rather than the working directory, so it does not depend
 * on where the process was started from.
 */
function release() {
  const fromEnv = (process.env.OPT_RELEASE ?? '').trim();
  if (fromEnv) return fromEnv;
  try {
    const value = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'RELEASE'),
                               'utf-8').trim();
    if (value) return value;
  } catch {
    // Not installed - running from a checkout. 'unknown' is then accurate.
  }
  return 'unknown';
}

export class ConfigError extends Error {}

function required(name) {
  const value = (process.env[name] ?? '').trim();
  if (!value) throw new ConfigError(`${name} is not set`);
  return value;
}

function integer(name, fallback) {
  const raw = (process.env[name] ?? '').trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new ConfigError(`${name} must be a whole number, got ${raw}`);
  return n;
}

export function load() {
  const missing = REQUIRED.filter((name) => !(process.env[name] ?? '').trim());
  if (missing.length) {
    throw new ConfigError(
      `missing configuration: ${missing.join(', ')}. See deploy/dashboard.env.example.`,
    );
  }

  // A second key, for one route, and deliberately not the same one.
  //
  // OPT_DASHBOARD_API_KEY approves plans. Handing it to the listener so it could announce its
  // dispatches would give a machine that consumes a queue the ability to approve IAM changes -
  // the exact separation this system is built around. So the listener gets a key that opens
  // POST /api/notifications and nothing else, and a leak of it buys noise in a panel.
  //
  // Optional. Unset means the ingest route is off and answers 503, rather than open.
  const ingestKey = (process.env.OPT_DASHBOARD_INGEST_KEY ?? '').trim();
  if (ingestKey && ingestKey.length < 32) {
    throw new ConfigError('OPT_DASHBOARD_INGEST_KEY must be at least 32 characters');
  }

  const apiKey = required('OPT_DASHBOARD_API_KEY');
  if (ingestKey && ingestKey === apiKey) {
    // Not a strength check. Equal keys collapse the two scopes into one, which is the thing the
    // second key exists to prevent, and it would do so silently.
    throw new ConfigError(
      'OPT_DASHBOARD_INGEST_KEY must differ from OPT_DASHBOARD_API_KEY - the ingest key is for a '
      + 'machine that may only announce, and the API key can approve plans',
    );
  }
  if (apiKey.length < 32) {
    // Not a strength meter. It is the one credential standing in front of the only principal in
    // this system that may write an approval, so a value short enough to have been typed by hand
    // is refused rather than warned about.
    throw new ConfigError('OPT_DASHBOARD_API_KEY must be at least 32 characters');
  }

  return {
    region: (process.env.AWS_REGION ?? 'us-east-1').trim(),

    markerBucket: required('OPT_MARKER_BUCKET'),
    stateBucket: required('OPT_STATE_BUCKET'),

    // Prefixes are named for the container that consumes the marker, and the instance role is
    // scoped to them. Changing one here without changing opt-stack-dashboard-host.yaml produces
    // AccessDenied on write and a silently empty list on read.
    inspectorPrefix: 'inspector/',
    applierPrefix: 'applier/',
    // Written by the inspector before it writes request.json, deleted by the impact querier. While
    // it exists the assessment for that inspection has not finished - which is what lets the page
    // say "assessment in progress" rather than showing nothing and looking like there is nothing.
    impactPrefix: 'impact/',

    // The state bucket has no plan prefix any more. Everything terraform produces for one governed
    // resource lives under <account id>/<resource>/, and the plan artifacts are the plan/ subfolder
    // of that - see event_pipeline generator/twin.py. There is therefore no single prefix to list,
    // which is why the instance role's s3:ListBucket on this bucket carries no s3:prefix condition.
    planSuffix: 'plan/',

    // Loopback by default. This server speaks plain HTTP and holds no certificate, so binding it
    // to a routable address would put the API key on the wire in clear. Put nginx or a load
    // balancer in front and terminate TLS there, or reach it over an SSH tunnel. Setting this to
    // 0.0.0.0 is one line and it is a decision, not a default.
    bindAddress: (process.env.OPT_BIND_ADDRESS ?? '127.0.0.1').trim(),
    port: integer('OPT_PORT', 8080),

    apiKey,
    ingestKey,

    // Marker bodies kept in memory so the sweep does not fetch them again. Filled by the
    // listener's announcements and by the approval markers this process writes itself, which
    // between them is every marker in a healthy system - so a sweep makes no GetObject at all.
    // A miss costs one call and gives the same answer, which is what keeps the announcement path
    // from being load-bearing. Bodies reach ten kilobytes, so the count is the memory bound.
    markerBodyCache: integer('OPT_MARKER_BODY_CACHE', 200),

    // An announcement carries a marker body. The listener leaves the body out above its own
    // limit rather than sending something this would refuse, so this only has to be the larger
    // of the two.
    maxAnnouncementBytes: integer('OPT_MAX_ANNOUNCEMENT_BYTES', 128 * 1024),

    // How many announcements the panel keeps. They are announcements and not a log: the durable
    // record of what ran is the marker, the plan prefix and CloudWatch.
    notificationLimit: integer('OPT_NOTIFICATION_LIMIT', 200),

    // A notification asks for a sweep, because learning that work started is most of its value.
    // Not on every one: a burst of dispatches would otherwise be a burst of full bucket listings.
    notificationSweepSeconds: integer('OPT_NOTIFICATION_SWEEP_SECONDS', 10),

    // Assessments pushed by the impact querier. Fewer entries than marker bodies because an
    // assessment carries resource ARNs rather than event names - a wide grant on a busy account is
    // far larger than any marker. A miss costs one GetObject and gives the same answer.
    impactCache: integer('OPT_IMPACT_CACHE', 50),

    // An assessment is the largest thing anything posts here. The querier drops the assessment from
    // its push above its own limit and sends the summary alone, so this only has to be the larger of
    // the two - and it is the reason the impact route has its own body cap rather than sharing the
    // 16 kilobyte one every other POST uses.
    maxImpactBytes: integer('OPT_MAX_IMPACT_BYTES', 512 * 1024),

    // Where the built single page application lives. Served from this process rather than from a
    // separate web server so there is one origin, and therefore no reason to relax CORS.
    staticDir: (process.env.OPT_STATIC_DIR ?? 'dist').trim(),

    // A marker exists for as long as its task runs, so a young one is work in progress rather
    // than a failure. An inspection that downloads a provider and runs terraform plan takes
    // minutes; below this age a marker is reported as running and not as a failure.
    markerGraceSeconds: integer('OPT_MARKER_GRACE_SECONDS', 900),

    // The sweep is what makes the notification path optional. It runs once at startup and then
    // on this interval, so a lost notification costs at most one interval and an instance
    // replacement costs nothing.
    sweepIntervalSeconds: integer('OPT_SWEEP_INTERVAL_SECONDS', 86400),

    // Reading every marker body on every sweep is a GetObject per object. Bounded so that a
    // bucket that has accumulated failures does not turn one sweep into thousands of calls.
    maxBodiesPerSweep: integer('OPT_MAX_BODIES_PER_SWEEP', 200),

    release: release(),
  };
}
