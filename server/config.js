// Configuration, from the environment. Nothing is read from a file the browser can reach and
// nothing has an AWS credential in it - the role arrives through the instance profile.
//
// Every value that cannot be guessed is required, and the process refuses to start without it.
// A dashboard that starts against the wrong bucket does not fail: it shows an empty list, which
// reads exactly like "nothing is wrong".

const REQUIRED = ['OPT_MARKER_BUCKET', 'OPT_STATE_BUCKET', 'OPT_DASHBOARD_API_KEY'];

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

  const apiKey = required('OPT_DASHBOARD_API_KEY');
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
    planPrefix: 'plans/',

    // Loopback by default. This server speaks plain HTTP and holds no certificate, so binding it
    // to a routable address would put the API key on the wire in clear. Put nginx or a load
    // balancer in front and terminate TLS there, or reach it over an SSH tunnel. Setting this to
    // 0.0.0.0 is one line and it is a decision, not a default.
    bindAddress: (process.env.OPT_BIND_ADDRESS ?? '127.0.0.1').trim(),
    port: integer('OPT_PORT', 8080),

    apiKey,

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

    release: (process.env.OPT_RELEASE ?? 'unknown').trim(),
  };
}
