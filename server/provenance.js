// How a resource got there: a stack, a stack set, or somebody's hands.
//
// CloudFormation writes three tags onto everything it creates, and the assessment already carries
// them because the inventory carries every tag. They were being printed raw, so a row read
//
//   리소스명: /opt/solution/opt-inspector, 계정: …, 리전: us-east-1aws:cloudformation:logical-id=…
//   aws:cloudformation:stack-id=arn:aws:cloudformation:us-east-1:…:stack/opt-stack-ecs-runtime/
//   eb4deb10-9623-11f1-b69a-0affc8320de1 aws:cloudformation:stack-name=opt-stack-ecs-runtime
//
// - two hundred characters of which the useful part is "opt-stack-ecs-runtime", said twice. This
// turns the three tags into the one fact they carry between them.
//
// Why the fact is worth keeping at all: it separates what an operator can undo from what they
// cannot. Deleting a stack-managed resource by hand leaves the stack in drift and the next update
// puts it back or fails; a stack-set-managed one is governed from another account entirely. An
// approver looking at a restriction over these resources should be able to see which of them their
// own console can actually change.
//
// Display only. A resource name, a tag key and a tag value may not reach a grade or a narrative
// (IMPLEMENTATION.md T-4), and nothing here is read by findings.js, candidatePaths.js or the
// analysis prompt - the digest carries no tags at all.

/** The three tags CloudFormation writes. Only two of them say anything a reader needs. */
const STACK_NAME = 'aws:cloudformation:stack-name';
const STACK_ID = 'aws:cloudformation:stack-id';

/**
 * A stack created BY a stack set is named StackSet-<the stack set's name>-<uuid>.
 *
 * That is CloudFormation's own convention for the member stack, and it is the only place the stack
 * set's name appears on the resource - the tags name the member stack, not the set. The trailing
 * group is a v4 uuid, so it is matched as one rather than by "everything after the last hyphen":
 * a stack set called event-ingestion and one called event produce member stacks whose names differ
 * only in a hyphen, and cutting at the last one would name the wrong set for both.
 */
const MEMBER_STACK = /^StackSet-(.+)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Where a resource came from, from its tags alone.
 *
 * Returns { kind: 'stack' | 'stackset' | 'manual', name: string | null }.
 *
 * 'manual' is what absence means and it is deliberately not called 'unknown'. Every resource
 * CloudFormation creates carries these tags, so a resource without them was not created by
 * CloudFormation - by terraform, by a console, by an SDK call. That is a fact about the resource
 * rather than a gap in the evidence, and the three the pipeline itself governs are in that group:
 * this solution's own mirror roles are terraform's, not CloudFormation's.
 */
export function provenance(tags) {
  const bag = tags && typeof tags === 'object' ? tags : {};
  const stack = typeof bag[STACK_NAME] === 'string' ? bag[STACK_NAME].trim() : '';
  if (!stack) {
    // stack-id without stack-name would be odd, but the id carries the name too and reading it is
    // cheaper than reporting a resource as hand-made because one tag went missing.
    const id = typeof bag[STACK_ID] === 'string' ? bag[STACK_ID] : '';
    const fromId = id.includes(':stack/') ? id.split(':stack/')[1].split('/')[0] : '';
    if (!fromId) return { kind: 'manual', name: null };
    return named(fromId);
  }
  return named(stack);
}

function named(stack) {
  const member = MEMBER_STACK.exec(stack);
  if (member) return { kind: 'stackset', name: member[1] };
  return { kind: 'stack', name: stack };
}

/** The tag keys provenance() consumes, so a renderer can show what is left without repeating them. */
export const PROVENANCE_TAGS = [STACK_NAME, STACK_ID, 'aws:cloudformation:logical-id'];

/** Tags worth showing beside a resource: everything the provenance summary did not already say. */
export function remainingTags(tags) {
  const bag = tags && typeof tags === 'object' ? tags : {};
  return Object.fromEntries(
    Object.entries(bag).filter(([key]) => !PROVENANCE_TAGS.includes(key)),
  );
}
