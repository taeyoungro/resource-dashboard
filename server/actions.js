// The IAM action catalogue, read from disk once and held in memory.
//
// It exists so the restriction screen can offer a list instead of asking an administrator to type an
// action name. Typing is where the quiet mistakes come from: sqs:DeleteMessages and
// sqs:ReceiveMessages do not exist, and neither looks wrong on a screen.
//
// It is an INPUT AID AND NOT A TRUST BOUNDARY, and everything about how it is loaded follows from
// that. Nothing downstream believes it: the decision route checks every chosen action against the
// actions the plan actually grants and against the protected set, and the inline writer checks them
// again against the fence the applier handed it. So
//
//   an action missing from the file    can still be typed. The screen keeps the text box for
//                                     services the file does not cover, and says which those are
//   an action wrongly in the file      is refused by the two checks above, with a sentence
//   a malformed file                   leaves the catalogue empty and the screen behaves exactly as
//                                     it did before this existed. It does not stop the server
//
// That last one is why load() reports a problem and returns an empty catalogue rather than throwing.
// An approval path that cannot run because a convenience file has a typo in it would be a worse
// system than one that asks somebody to type an action.
//
// Read once at startup rather than per request. It is a few kilobytes, it does not change while the
// process runs, and a request that reads a file is a request that can fail for a reason unrelated to
// what it was asked.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const CATALOGUE_PATH = join(HERE, 'data', 'aws-actions.json');

// Access levels as the Service Authorization Reference names them. Used to group the list on screen -
// an administrator restricting a queue is looking for Write, not for Read - and to refuse a value
// that is not one of them, since a typo here would render as an empty group.
export const ACCESS_LEVELS = [
  'List', 'Read', 'Write', 'Permissions management', 'Tagging',
];

const SERVICE = /^[a-z0-9-]{2,64}$/;
const ACTION = /^[a-z0-9-]{2,64}:[A-Za-z0-9]{1,128}$/;

/** Parse and validate one catalogue document. Throws; load() is what swallows.
 *
 * Every entry is checked because a bad one is invisible on screen: an action whose prefix does not
 * match its service would be offered under the wrong heading, and an unknown access level would land
 * in a group that renders empty.
 */
export function parse(raw) {
  const document = JSON.parse(raw);
  if (!document || typeof document !== 'object') throw new Error('not an object');
  if (document.schema !== 1) {
    throw new Error(`schema is ${JSON.stringify(document.schema)}, and this server understands 1`);
  }

  const services = document.services;
  if (!services || typeof services !== 'object') throw new Error('services is missing');

  const out = {};
  for (const [service, body] of Object.entries(services)) {
    if (!SERVICE.test(service)) throw new Error(`${service} is not a service prefix`);
    const actions = body?.actions;
    if (!Array.isArray(actions) || actions.length === 0) {
      throw new Error(`${service} has no actions`);
    }

    const seen = new Set();
    const parsed = actions.map((entry) => {
      const action = entry?.action;
      if (typeof action !== 'string' || !ACTION.test(action)) {
        throw new Error(`${service}: ${JSON.stringify(action)} is not an action name`);
      }
      if (!action.startsWith(`${service}:`)) {
        throw new Error(`${action} is listed under ${service}`);
      }
      if (seen.has(action)) throw new Error(`${action} is listed twice`);
      seen.add(action);

      if (!ACCESS_LEVELS.includes(entry.access)) {
        throw new Error(`${action}: access ${JSON.stringify(entry.access)} is not one of `
                        + ACCESS_LEVELS.join(', '));
      }
      // "*" means the action names no resource - sqs:ListQueues is account wide. The screen greys
      // those out for an allow_only restriction, because generator/restriction.py refuses them: a
      // NotResource list can never contain "*", so the statement would deny the action outright
      // rather than narrow it.
      const resource = typeof entry.resource === 'string' && entry.resource ? entry.resource : '*';
      return { action, access: entry.access, resource, account_level: resource === '*' };
    });

    parsed.sort((a, b) => a.action.localeCompare(b.action));
    out[service] = { label: typeof body.label === 'string' ? body.label : service, actions: parsed };
  }

  return out;
}

/** Read the file, or report why not and return an empty catalogue.
 *
 * Never throws. See the top of this file: a convenience file with a typo must not stop the server,
 * because the screen degrades to a text box and the checks that matter are elsewhere.
 */
export function load({ path = CATALOGUE_PATH, log = console } = {}) {
  let services = {};
  let error = null;
  try {
    services = parse(readFileSync(path, 'utf-8'));
    const count = Object.values(services).reduce((n, s) => n + s.actions.length, 0);
    log.info?.('action catalogue loaded services=%s actions=%d path=%s',
               Object.keys(services).join(',') || 'none', count, path);
  } catch (err) {
    error = err.message;
    services = {};
    log.warn?.('action catalogue could not be read (%s) - the restriction screen falls back to a '
               + 'typed action, which is how it worked before this file existed', error);
  }

  return {
    /** Everything, for the page. Frozen: one process-wide copy nothing may edit under a request. */
    all: () => ({ schema: 1, services, error }),
    /** The services covered, so the screen can say which ones still need typing. */
    covered: () => Object.keys(services),
    forService: (name) => services[String(name).toLowerCase()]?.actions ?? [],
    size: () => Object.values(services).reduce((n, s) => n + s.actions.length, 0),
  };
}
