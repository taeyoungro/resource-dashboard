// Candidate attack paths, computed deterministically from the digest.
//
// The model is never asked "find attack paths in this JSON". Code walks the digest first and
// proposes candidates - each one a concrete chain of actions on concrete resources, ending at a
// named outcome - and the model is asked one question per candidate: is this real, could it happen
// by accident, does it create or subvert, what does it need, what does it end in, is the evidence
// enough. That shrinks the model's job from open-ended reasoning over a whole account to a
// judgement with the reasoning already laid out, and it makes every answer checkable: a candidate
// cites actions and ARNs that provably exist in the digest, so an answer that cites anything else
// is a hallucination by construction rather than by suspicion.
//
// Generate generously, prune with the model
// -----------------------------------------
// The temptation is to generate candidates from the rule file, which would be precise and would
// also defeat the purpose: the model could then only confirm or deny what the code already
// suspected, and finding what nobody wrote down is the one thing a model adds over a rule table.
// So generation is at CAPABILITY level and over-produces on purpose - a false candidate costs one
// judgement, and a missing candidate costs the finding.
//
// The graph ends at outcomes, not at actions
// ------------------------------------------
// Two paths to the same place share no action at all:
//
//   replace the instance profile      ec2:AssociateIamInstanceProfile + iam:PassRole
//   rewrite what boots on it          ec2:StopInstances + ModifyInstanceAttribute + StartInstances
//
// Both end holding the role that instance already had, and only the second needs no PassRole. An
// action-keyed graph files them apart; an outcome-keyed one files them together, which is where a
// reader wants them. Outcomes also compose: holding the pipeline's own role is not itself the
// finding - what it reaches next is - so an outcome landing on a control-plane resource is
// promoted rather than reported flat.
//
// Scope discipline is inherited, not re-derived
// ---------------------------------------------
// A chain needing several actions on the SAME resource is only proposed from one unit's action
// set, and a unit the digest marked as a possible union (the producer merges the actions of every
// statement into one group per resource type) yields a candidate marked unverified rather than one
// silently treated as co-located. The model is told the distinction and is not asked to work it
// out - re-deriving it is exactly what the deterministic scopes exist to prevent.

import { CAP, CURATED, capabilitiesOf } from './capabilities.js';

/** Where a path ENDS. The vocabulary an approver actually reasons in. */
export const OUTCOME = {
  CREDENTIALS_OF: 'credentials_of',
  CODE_EXECUTION_AS: 'code_execution_as',
  CONTROL_PLANE_WRITE: 'control_plane_write',
  DATA_EGRESS: 'data_egress',
  NETWORK_EXPOSURE: 'network_exposure',
  AVAILABILITY_DENIAL: 'availability_denial',
  AUDIT_BLIND: 'audit_blind',
  // Rewriting the label a control reads. Its own outcome rather than a kind of modify-config,
  // because what it reaches is not the resource - it is every tag_condition restriction on this
  // permission set, at once. A Deny that selects by tag is only as strong as the tag, and whoever
  // can write the tag chooses which side of the condition a resource falls on: under the closed
  // form they label a resource into the allowed set, under the open form they strip the label off.
  TAG_TAMPER: 'tag_tamper',
};

/**
 * The edges. Each is a capability requirement over ONE unit's action set, and an outcome.
 *
 * `all` means every capability must be present on the same unit - that is the co-location rule,
 * inherited from the unit rather than checked again. `any` means one is enough.
 *
 * `needs` names a capability that may come from anywhere in the same POLICY rather than from the
 * unit, which is the other scope: passing a role and creating the thing to pass it to are two
 * actions on two different resource types, and requiring them on one unit would find nothing.
 */
const EDGES = [
  {
    id: 'takeover-boot',
    all: [CAP.STOP_START, CAP.MODIFY_CODE],
    outcome: OUTCOME.CREDENTIALS_OF,
    why: 'stopping the target, rewriting what runs at boot, and starting it again yields whatever '
      + 'role is already attached - no role-passing permission is involved',
  },
  {
    id: 'takeover-identity',
    any: [CAP.REPLACE_IDENTITY],
    outcome: OUTCOME.CREDENTIALS_OF,
    why: 'the identity a running thing carries can be replaced, so the caller chooses which role '
      + 'the workload runs as',
  },
  {
    id: 'mint',
    any: [CAP.MINT_CREDENTIAL],
    outcome: OUTCOME.CREDENTIALS_OF,
    targetless: true,
    why: 'a credential can be issued directly',
  },
  {
    id: 'pass-and-run',
    any: [CAP.CREATE, CAP.MODIFY_CODE, CAP.INVOKE],
    needs: [CAP.PASS_ROLE],
    outcome: OUTCOME.CODE_EXECUTION_AS,
    targetless: true,
    why: 'a role may be passed to a service, and this policy can also create or rewrite something '
      + 'that runs under it',
  },
  {
    id: 'run-existing',
    all: [CAP.MODIFY_CODE, CAP.INVOKE],
    outcome: OUTCOME.CODE_EXECUTION_AS,
    why: 'the code of something that already holds a role can be replaced and then run',
  },
  {
    id: 'grant-self',
    any: [CAP.ATTACH_POLICY, CAP.WRITE_POLICY],
    outcome: OUTCOME.CREDENTIALS_OF,
    targetless: true,
    why: 'permissions can be written onto a principal directly',
  },
  {
    id: 'data-write',
    any: [CAP.WRITE_DATA],
    outcome: OUTCOME.CONTROL_PLANE_WRITE,
    controlPlaneOnly: true,
    why: 'the contents of this store are what another component acts on, so writing an item makes '
      + 'that component act',
  },
  {
    id: 'exfiltrate',
    any: [CAP.READ_DATA, CAP.READ_SECRET, CAP.SHARE_EXTERNAL, CAP.SNAPSHOT],
    outcome: OUTCOME.DATA_EGRESS,
    targetless: true,
    // Only the half that is real with nothing enumerated, which is why the field exists at all.
    // Reading a table, a secret or a snapshot needs the table, the secret or the volume to be
    // there - proposing those on an empty account is noise an approver has to clear. OPENING
    // something to the outside is a property of the grant: s3:PutBucketPolicy, kms:PutKeyPolicy
    // and lambda:CreateFunctionUrlConfig say "whatever comes to exist can be published", and that
    // is true on day one. It was also the blind spot measured: the whole DATA_EGRESS outcome was
    // unreachable on a new account, so the very action a preventive control is most often asked
    // for produced no finding at all.
    targetlessCaps: [CAP.SHARE_EXTERNAL],
    why: 'contents can be read, copied, or opened to a principal outside this account',
  },
  {
    id: 'open-network',
    any: [CAP.NETWORK_ROUTE, CAP.NETWORK_INGRESS],
    outcome: OUTCOME.NETWORK_EXPOSURE,
    // Whole edge. Every action here BRINGS the path into being - CreateInternetGateway,
    // CreateRoute, AuthorizeSecurityGroupIngress, CreateLoadBalancer - so "this grant can open a
    // way into the network" needs no inventory to be true, and an account with nothing in it yet
    // is exactly where that grant goes unexamined.
    targetless: true,
    why: 'a path into or out of the network can be created',
  },
  {
    id: 'destroy',
    any: [CAP.DELETE],
    outcome: OUTCOME.AVAILABILITY_DENIAL,
    why: 'the resource can be removed or disabled',
  },
  {
    id: 'retag',
    any: [CAP.TAG],
    outcome: OUTCOME.TAG_TAMPER,
    // Targetless, and not because tagging is create-shaped - because what this reaches is not a
    // resource at all. A tag-based Deny selects by label rather than by name, so the resources it
    // covers are whichever ones carry the tag at evaluation time, and the ability to write tags is
    // the ability to move a resource across that line. That is true of resources not yet created,
    // which is exactly the population a tag condition exists to cover.
    targetless: true,
    why: 'the tags a Deny condition selects on can be written, so a resource can be moved to the '
      + 'other side of the condition - relabelled into what a closed form allows, or stripped of '
      + 'the label an open form denies on',
  },
  {
    id: 'blind',
    any: [CAP.TAMPER_AUDIT],
    outcome: OUTCOME.AUDIT_BLIND,
    // Whole edge, and this one was never really a unit finding. What it acts on is account-level
    // audit machinery - the trail, the Config recorder, the GuardDuty detector - which an index of
    // workload resources does not report, so the capability was invisible whether the account was
    // new or full. It is also the outcome an approver most needs to see before granting, because
    // it is the one that makes the others unobservable afterwards.
    targetless: true,
    why: 'the record of what happened can be shortened, stopped or deleted',
  },
];

/**
 * Every edge and what it means, once.
 *
 * A candidate carries the same sentence as every other candidate of its edge, so twenty-six
 * candidates over seven edges sent the same eleven sentences four times each. The frame states them
 * once instead and the candidate carries only its edge id - which it carried already.
 */
export const EDGE_LEGEND = EDGES.map(({ id, why }) => ({ id, why }));

/** Why a candidate cannot be asserted outright. Empty means nothing stands in the way. */
function reservations(grant, unit, digest) {
  const out = [];
  if (unit && unit.colocation === 'union') {
    out.push('the policy named specific ARNs, and the assessment merges the actions of every '
      + 'statement into one list per resource type - so these actions may belong to different '
      + 'resources and this co-location may not exist');
  }
  if (unit && unit.attribution === 'service') {
    out.push('at least one action here was attached to this resource type only because the action '
      + 'table did not know it, so the pairing may be an artefact of over-reporting');
  }
  if (unit && unit.truncated === true) {
    out.push('the resource list is truncated, so the resources named are not all of them');
  }
  if (unit && unit.truncated === null) {
    out.push('whether the resource list is complete was not established');
  }
  if (grant.unreadable) {
    out.push(`the policy body could not be read (${grant.unreadable})`);
  }
  const unreadable = digest.coverage?.policies_unreadable ?? [];
  if (unreadable.length) {
    out.push(`a policy in this permission set could not be read (${unreadable.join(', ')}), so `
      + 'what constrains this grant is unknown');
  }
  if ((digest.coverage?.actions_unbounded ?? []).length) {
    out.push('the permission set carries an unbounded action pattern, so every count here is a '
      + 'floor and nothing enumerated can be treated as the full picture');
  }
  return out;
}

/** The actions of a unit, resolved back to names, with their capabilities. */
function unitActions(grant, unit) {
  const out = [];
  for (const i of unit.acts ?? []) {
    const action = grant.risk_actions[i];
    if (!action) continue;
    const { caps, source } = capabilitiesOf(action);
    out.push({ action, caps, source });
  }
  return out;
}

/**
 * Capabilities the whole POLICY has, wherever they sit. The other scope - passing a role and
 * creating the thing to pass it to are two actions on two resource types.
 */
function grantCapabilities(grant) {
  const out = new Map();
  for (const action of grant.risk_actions) {
    for (const cap of capabilitiesOf(action).caps) {
      if (!out.has(cap)) out.set(cap, []);
      out.get(cap).push(action);
    }
  }
  // Tag writes come from the ACCESS LEVEL, not from the name. The verb fallback reads the first
  // word and a tag write rarely starts with one: ec2:CreateTags is create, s3:PutBucketTagging is
  // modify-config, rds:AddTagsToResource is nothing. So CAP.TAG existed and was never assigned to
  // the actions that matter, and the whole tag-tamper path was unreachable. riskDigest carries the
  // names AWS itself calls Tagging; this adds them to whatever the fallback already guessed rather
  // than replacing it, because ec2:CreateTags really does also create something.
  for (const action of grant.tag_writes ?? []) {
    if (!out.has(CAP.TAG)) out.set(CAP.TAG, []);
    if (!out.get(CAP.TAG).includes(action)) out.get(CAP.TAG).push(action);
  }
  // A service granted whole carries every action of it, INCLUDING the ones the digest folded away
  // by name. Without this the fold would be a hole the graph cannot see through: 'ec2:*' would
  // yield no instance-profile swap, because that action is not written out anywhere. The curated
  // table is where those actions still exist, so the fold is expanded back through it.
  for (const service of grant.complete_services ?? []) {
    for (const [action, caps] of CURATED_BY_SERVICE.get(service) ?? []) {
      for (const cap of caps) {
        if (!out.has(cap)) out.set(cap, []);
        if (!out.get(cap).includes(action)) out.get(cap).push(action);
      }
    }
  }
  return out;
}

// service -> [[action, caps], ...], built once from the curated table so expanding a folded
// service costs a lookup rather than a scan per grant.
const CURATED_BY_SERVICE = (() => {
  const out = new Map();
  for (const [action, caps] of Object.entries(CURATED)) {
    const service = action.slice(0, action.indexOf(':'));
    if (!out.has(service)) out.set(service, []);
    out.get(service).push([action, caps]);
  }
  return out;
})();

/**
 * Every candidate the digest supports.
 *
 * Deterministic and ordered, so the same digest always produces the same candidate ids - which is
 * what lets an answer be cached, compared across runs, and cited in an approval record.
 */
export function candidates(digest) {
  const out = [];
  const push = (candidate) => {
    out.push({ id: `C${out.length + 1}`, ...candidate });
  };

  for (const grant of digest.grants ?? []) {
    if (grant.is_baseline) continue;
    const policyCaps = grantCapabilities(grant);

    for (const unit of grant.units ?? []) {
      const actions = unitActions(grant, unit);
      if (actions.length === 0 && (unit.folded ?? 0) === 0) continue;
      const present = new Map();
      for (const { action, caps } of actions) {
        for (const cap of caps) {
          if (!present.has(cap)) present.set(cap, []);
          present.get(cap).push(action);
        }
      }

      for (const edge of EDGES) {
        if (edge.controlPlaneOnly && (unit.cp ?? []).length === 0) continue;

        let steps = [];
        if (edge.all) {
          if (!edge.all.every((cap) => present.has(cap))) continue;
          steps = edge.all.map((cap) => ({ capability: cap, actions: present.get(cap) }));
        } else {
          const hit = edge.any.filter((cap) => present.has(cap));
          if (hit.length === 0) continue;
          steps = hit.map((cap) => ({ capability: cap, actions: present.get(cap) }));
        }

        // A capability the policy holds elsewhere, when the edge needs one.
        let elsewhere = [];
        if (edge.needs) {
          if (!edge.needs.every((cap) => policyCaps.has(cap))) continue;
          elsewhere = edge.needs.map((cap) => ({ capability: cap, actions: policyCaps.get(cap) }));
        }

        push({
          edge: edge.id,
          outcome: edge.outcome,
          why: edge.why,
          policy: grant.name,
          policy_id: grant.p,
          // Same unit: this is the co-location the outcome depends on.
          //
          // truncated travels with the target so a finding built from this candidate can carry it
          // as a field and not only as a reservation (T-6). Unknown stays null - writing false
          // here would let a finding be shown as complete when nothing established that.
          target: { type: unit.t, count: unit.n, scope: unit.scope, sample: unit.sample,
                    sample_complete: unit.sample_complete,
                    truncated: typeof unit.truncated === 'boolean' ? unit.truncated : null },
          // The pipeline's own resources in the blast radius, by configuration - never by name.
          control_plane: unit.cp ?? [],
          steps,
          also_granted: elsewhere,
          reservations: reservations(grant, unit, digest),
        });
      }
    }

    // Policy-scope candidates: the edges that mean something with NOTHING enumerated.
    //
    // Which edges those are is the distinction worth being careful about. An edge that acts on an
    // existing thing - rewriting code, stopping an instance, reading a table - says nothing when
    // there is no such thing, and proposing it would be noise an approver has to clear. An edge
    // that BRINGS SOMETHING INTO BEING - minting a credential, writing a policy onto a principal,
    // passing a role to a service it then creates, publishing whatever comes to exist, opening a
    // way into the network - is real on an empty account, and it is precisely what a groups-only
    // view cannot see: a create action reaches nothing that exists, so it appears in no unit.
    //
    // The distinction is per CAPABILITY where an edge holds both kinds. `exfiltrate` is the one
    // that does: reading a table needs the table, publishing a bucket policy does not, and marking
    // the whole edge targetless would have proposed every s3:GetObject grant on an empty account.
    // targetlessCaps names the half that survives; without it the edge's whole `any` list does.
    for (const edge of EDGES) {
      if (!edge.targetless) continue;
      if (edge.needs && !edge.needs.every((cap) => policyCaps.has(cap))) continue;
      const hit = (edge.targetlessCaps ?? edge.any ?? []).filter((cap) => policyCaps.has(cap));
      if (hit.length === 0) continue;
      // Only when no unit already carried it, so the same path is not proposed twice.
      const already = out.some((c) => c.edge === edge.id && c.policy_id === grant.p);
      if (already) continue;
      push({
        edge: edge.id,
        outcome: edge.outcome,
        why: `${edge.why} - and no resource of the relevant type exists yet, so this is a capability `
          + 'of the grant rather than a reach over the current inventory',
        policy: grant.name,
        policy_id: grant.p,
        target: null,
        control_plane: [],
        steps: hit.map((cap) => ({ capability: cap, actions: policyCaps.get(cap) })),
        also_granted: (edge.needs ?? []).map(
          (cap) => ({ capability: cap, actions: policyCaps.get(cap) })),
        reservations: reservations(grant, null, digest),
      });
    }
  }

  return out;
}

/** Every action any candidate cites. The set an answer may draw from, and nothing else. */
export function citedActions(list) {
  const out = new Set();
  for (const candidate of list) {
    for (const group of [...candidate.steps, ...candidate.also_granted]) {
      for (const action of group.actions) out.add(action);
    }
  }
  return out;
}
