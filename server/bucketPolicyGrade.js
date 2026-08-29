// From a bucket policy reading to the card that shows it - the part that is data, not screen.
//
// The resource policy panel prints its readings as risk cards, which means every reading needs a
// grade, a status and a place in the order. That mapping is a judgement about what a policy means,
// not a styling choice, so it lives here where a test can hold it still.
//
// Plain JS with a .d.ts beside it, same arrangement as blockPath.js and for the same reason: node
// --test is the one test runner here and it cannot load TypeScript.
//
// The grade is not the risk grade
// -------------------------------
// A risk card's grade answers "what can this permission do". A reading's grade answers "what does
// this bucket policy say about this principal". The same words are used so an approver reads one
// colour scheme rather than two, and the two numbers are never added.
//
// An Allow is not access. Across accounts both halves are required - this policy AND the principal's
// own identity policy - so an Allow here is a precondition. It is still graded higher than the
// same-account case, because it is the half an approver can act on: the bucket has already opened,
// and deciding to widen an identity policy without knowing that is the mistake this panel exists to
// prevent. In the same account the identity policy alone would have carried it, so what this policy
// adds is that much less.
//
// Silence is the other half of the same thought, and only one of its three cases is an answer.

export const GRADE = { CRITICAL: 'CRITICAL', HIGH: 'HIGH', MEDIUM: 'MEDIUM', LOW: 'LOW', NONE: 'NONE' };
export const STATUS = { CONFIRMED: 'CONFIRMED', UNVERIFIED: 'UNVERIFIED', NOT_ASSESSABLE: 'NOT_ASSESSABLE' };

const RANK = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3, NONE: 4 };

/**
 * The grade, status, order and title for one reading.
 *
 * `weight` orders within a grade, and the rule it encodes is that what is UNSETTLED comes before
 * what is settled. Inside grade NONE that puts "a statement this does not interpret" and "silence
 * that means nothing" above "does not reach" and "explicitly denied" - the two answers an approver
 * can stop reading at.
 */
export function shapeOf(reading) {
  const same = reading?.sameAccount ?? null;
  switch (reading?.outcome) {
    case 'ALLOWED':
      return same === true
        ? { grade: GRADE.MEDIUM, weight: 0, status: STATUS.CONFIRMED,
            title: '이 버킷이 같은 계정의 우리 주체를 허용함' }
        : { grade: GRADE.HIGH, weight: 0, status: STATUS.CONFIRMED,
            title: same === false
              ? '다른 계정의 우리 주체를 이 버킷이 허용함'
              : '이 버킷이 우리 주체를 허용함' };
    case 'CONDITIONAL':
      return { grade: GRADE.MEDIUM, weight: 1, status: STATUS.UNVERIFIED,
               title: '허용이 걸려 있으나 조건을 판정하지 못함' };
    case 'DELEGATED':
      // The delegation itself is certain; who reaches through it is the other account's identity
      // policies to decide and this never reads them. No status badge rather than a confident one.
      return { grade: GRADE.MEDIUM, weight: 2, status: null,
               title: '버킷이 이 주체의 계정에 위임함' };
    case 'UNREADABLE':
      return { grade: GRADE.NONE, weight: 0, status: STATUS.NOT_ASSESSABLE,
               title: '해석하지 않는 문장이 있어 판정하지 않음' };
    case 'SILENT':
      // Only the cross-account silence is an answer: both halves are required and this half is
      // absent, so the policy does not carry it. The other two are the absence of an answer, and a
      // card that graded all three the same way would present "we cannot say" as "there is nothing
      // here" - which is the mistake this whole panel is written against.
      return same === false
        ? { grade: GRADE.NONE, weight: 2, status: STATUS.CONFIRMED, title: '이 정책으로는 닿지 않음' }
        : { grade: GRADE.NONE, weight: 1, status: STATUS.NOT_ASSESSABLE,
            title: same === true
              ? '이 정책은 말하지 않으며, 같은 계정이라 그것은 답이 아님'
              : '계정을 몰라 언급 없음의 뜻을 판정하지 않음' };
    case 'DENIED':
      return { grade: GRADE.NONE, weight: 3, status: STATUS.CONFIRMED,
               title: '이 버킷이 이 주체를 명시적으로 거부함' };
    default:
      // An outcome this does not know is not graded as nothing. It is the same class of fact as an
      // unreadable statement - something is there and this cannot say what.
      return { grade: GRADE.NONE, weight: 0, status: STATUS.NOT_ASSESSABLE,
               title: '판정을 읽지 못함' };
  }
}

/**
 * Display order: grade, then unsettled before settled, then the name.
 *
 * The server sends readings in EVALUATION precedence - a Deny beats every Allow, so DENIED arrives
 * first. That is the order in which outcomes win, not the order in which they should be read, and
 * the heading over this list says "worst first". Sorting here is what makes the heading true.
 */
export function byWeight(a, b) {
  const [x, y] = [shapeOf(a), shapeOf(b)];
  return RANK[x.grade] - RANK[y.grade]
    || x.weight - y.weight
    || String(a?.principal?.label ?? '').localeCompare(String(b?.principal?.label ?? ''));
}

/**
 * The grade for an Allow that reaches beyond this deployment's own principals.
 *
 * Any principal with no condition at all is the one thing this panel should say loudest - with
 * public access block off, that is a bucket open to the internet. Any principal WITH a condition is
 * not the same fact and must not share the badge: counting an org-scoped "*" as public teaches an
 * approver to ignore the colour. What this does not do is judge whether the condition is narrow
 * enough - it counts key names, so "conditions present" means "look at them", not "fenced".
 */
export function openGrade(statement) {
  if (statement?.anyPrincipal && (statement.conditionKeys ?? []).length === 0) {
    return {
      grade: GRADE.CRITICAL,
      label: '모든 주체 · 조건 없음',
      why: '주체를 가리지 않고 허용하며 조건이 하나도 없습니다. 퍼블릭 액세스 차단이 켜져 있지 '
        + '않으면 이것은 인터넷에 열린 허용입니다. 이 화면은 차단 설정을 읽지 않습니다.',
    };
  }
  if (statement?.anyPrincipal) {
    return {
      grade: GRADE.HIGH,
      label: '모든 주체 · 조건 있음',
      why: '주체를 가리지 않고 허용하되 조건이 붙어 있습니다. 이 화면은 조건 키의 이름만 세고 그 '
        + '값이 충분히 좁은지는 판정하지 않으므로, 아래 키를 직접 읽어야 합니다.',
    };
  }
  return {
    grade: GRADE.MEDIUM,
    label: '외부 지목',
    why: '우리가 발급하지 않은 주체를 이름으로 지목해 허용합니다. 계정을 넘는 허용이면 그쪽 계정의 '
      + '자기 정책이 실제로 누가 닿는지를 정합니다.',
  };
}

/** Open statements worst first, by the same rule. */
export function byOpenGrade(a, b) {
  return RANK[openGrade(a).grade] - RANK[openGrade(b).grade];
}
