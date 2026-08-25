// When a list of actions can be written as one service wildcard, and when it cannot.
//
// The observation this exists for: an administrator who ticked every athena action that reaches a
// data catalog wrote eight names into a statement whose Resource is that one catalog. `athena:*`
// there denies exactly the same thing, because IAM applies a statement only when the Action AND the
// Resource both match - and every athena action the wildcard adds either reaches a different
// resource type, or names no resource at all, and neither of those matches a datacatalog ARN. The
// wildcard is bounded by the ARN rather than by the action list.
//
// That is a size win of a different order from the fold in restriction.py. Measured on the real
// action table: EC2 across every one of its actions is 26,985 bytes as names and 267 as `ec2:*`.
//
// It is NOT a rewrite this module performs. The wildcard becomes the administrator's decision -
// they choose it, it travels as the action, and generator/restriction.py validates it like any
// other, which after B-1 means covers_protected() expands it against the declaration path first.
// A generator that quietly widened `[8 names]` into `athena:*` would be restricting actions this
// approval does not grant, which is the one thing _validate refuses by name.
//
// So what is here is the QUESTION: given these actions and these resources, is the wildcard the
// same statement? Two forms, two different answers, and conflating them is the way to get this
// wrong:
//
//   Resource [ARNs]      bounded by the ARNs. Enough to have every action that REACHES those
//                        resource types - the rest of the service is inert
//   NotResource [kept]   bounded by nothing. `athena:*` denies every athena action everywhere
//                        except on the kept list, including the ones that name no resource. Enough
//                        only to have every action of the service the policy grants
//
// Which actions reach which resources is not derived from ARN text here. An ARN does not always
// carry a type token (an S3 bucket is arn:aws:s3:::name), and where it does, the token is in the
// inventory's vocabulary rather than the reference's - events:rule against
// rule-on-default-event-bus, the gap the impact container bridges at build time. The assessment
// already did that work: ImpactGroup.actions is the actions that reach THAT type, bridged. This
// reads it rather than redoing it.

/** The service prefix of an action, or "" when it has none. */
const serviceOf = (action) => String(action ?? '').split(':', 1)[0];

/**
 * Every action the assessment says reaches at least one of these ARNs.
 *
 * The union over the groups the ARNs fall in. A group whose resources the statement does not name
 * contributes nothing: its actions cannot be denied by a Resource list that does not hold its ARNs.
 */
export function reaching(arns, groups) {
  const wanted = new Set(arns ?? []);
  const out = new Set();
  for (const group of groups ?? []) {
    if (!(group.resources ?? []).some((r) => wanted.has(r.arn))) continue;
    for (const action of group.actions ?? []) out.add(action);
  }
  return out;
}

/**
 * Whether these actions can be written as one `<service>:*`, and what it would change.
 *
 * Returns null when they cannot - a mixed-service list, an empty one, or a set that does not cover
 * what the form requires. Otherwise `{ wildcard, covers, adds }`, where `adds` is the actions the
 * wildcard would additionally deny. `adds` is empty for a sound fold and is returned anyway,
 * because the caller shows it: an administrator agreeing to a wildcard should see what joins.
 *
 * `granted` is what the policy actually grants, expanded. It is the bound for the NotResource form
 * and it is also the honest one for the caller to display - the wildcard reaches beyond it, and
 * generator/restriction.py will refuse the decision unless the policy grants with a wildcard too.
 */
export function serviceFold({ actions, resources, intent, groups, granted }) {
  const chosen = [...new Set(actions ?? [])];
  if (chosen.length === 0) return null;

  const services = new Set(chosen.map(serviceOf));
  // One service, because the statement becomes one wildcard. A list spanning two services has no
  // single wildcard that means it, and `*` across both is the thing that denies the baseline.
  if (services.size !== 1) return null;
  const [service] = [...services];
  if (!service) return null;
  // Already a wildcard - nothing to fold, and folding a fold would hide what it covers.
  if (chosen.some((a) => a.includes('*'))) return null;

  const held = new Set(chosen);
  const inService = (list) => (list ?? []).filter((a) => serviceOf(a) === service);

  let required;
  if (intent === 'allow_only') {
    // NotResource is bounded by nothing, so the wildcard has to be the whole service as this
    // policy grants it. Anything the policy grants and the administrator did not tick would start
    // being denied everywhere outside the kept list.
    required = new Set(inService(granted));
  } else if (intent === 'deny_only') {
    // Resource is bounded by the ARNs. Everything that reaches them has to be in hand; the rest of
    // the service cannot match this statement whatever the wildcard says.
    required = reaching(resources, groups);
    for (const action of [...required]) {
      if (serviceOf(action) !== service) required.delete(action);
    }
  } else if (intent === 'deny_action') {
    // Resource "*", so the wildcard reaches every action of the service - including the ones that
    // name no resource, which is exactly what this intent is for. The bound is therefore the same
    // as allow_only's: the administrator has to hold the whole service as this policy grants it,
    // or ticking eight actions would silently become "deny the service".
    required = new Set(inService(granted));
  } else {
    // The condition intents. tag_condition applies to Resource "*" with a condition on the
    // resource's tag; the wildcard there would reach every action of the service including the
    // ones that carry no resource and therefore no tag, and what those do is not something this
    // can establish. key_condition is judged per covered member against the keys each action
    // declares, which a service wildcard cannot promise for members nobody looked at. Not offered.
    return null;
  }

  if (required.size === 0) return null;
  const missing = [...required].filter((a) => !held.has(a));
  if (missing.length > 0) return null;

  // What joins. For the Resource form this is the rest of the service, all of it inert against
  // these ARNs; for NotResource it is what the policy grants and the administrator did not tick,
  // which is empty by the test above - so anything here is the service beyond the policy's grant.
  const adds = inService(granted).filter((a) => !held.has(a)).sort();
  return { wildcard: `${service}:*`, service, covers: chosen.length, adds };
}
