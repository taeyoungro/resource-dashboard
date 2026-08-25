import type { Restriction } from "../types";

/**
 * The four sections, in the order they are read - shared by every place a restriction is COMPOSED.
 *
 * Three composers now: the per-policy editor in Impact.tsx, its ActionPicker, and the block-path
 * dialog a risk finding opens. They must agree on what the four intents are called and what each
 * one means, because a restriction written from a finding card lands in the same document the
 * editor's sections compose - one vocabulary, or the same decision reads as two different things
 * depending on which door it came through.
 *
 * They used to be four values of one dropdown, so a policy could carry exactly one of them and
 * choosing a second meant giving up the first. That was never a property of the statements: the
 * permission set holds ONE inline document and each decision composes its own statement into it, so
 * "keep only these buckets, and also deny DeleteBucket outright" is two statements and always was.
 * The dropdown was the only thing making it one choice.
 *
 * 동작 자체 거부 is the section that could not exist under the dropdown at all. Its statement -
 * Deny on Resource "*" - was reachable only as a side effect: an action a list of ARNs cannot scope
 * got one written for it whatever the dropdown said, in a fold at the bottom of the picker with a
 * paragraph explaining that this one is different. It is not a side effect, it is a decision, and
 * lambda:CreateFunction is what an administrator most often wants to make it about.
 *
 * Ordering: the two that narrow, then the one that removes, then the one that follows a tag.
 */
export const SECTIONS: Restriction["intent"][] = [
  "allow_only", "deny_only", "deny_action", "tag_condition", "key_condition",
];

export const INTENT_LABEL: Record<Restriction["intent"], string> = {
  allow_only: "이 자원만 허용",
  deny_only: "이 자원만 거부",
  deny_action: "동작 자체 거부",
  tag_condition: "태그로 거부",
  key_condition: "조건으로 거부",
};

export const INTENT_NOTE: Record<Restriction["intent"], string> = {
  allow_only: "고른 자원만 남기고 나머지를 거부한다. 이후에 생기는 자원도 거부된다.",
  deny_only: "고른 자원만 거부한다. 이후에 생기는 자원은 이 제한에 걸리지 않는다.",
  deny_action: "자원과 무관하게 동작 자체를 거부한다. 자원 목록으로 좁힐 수 없는 동작도 여기서 고른다.",
  tag_condition: "태그가 붙은 자원을 거부한다. 나중에 태그가 붙는 자원까지 덮는다.",
  key_condition:
    "동작이 선언한 요청 조건 키로 거부한다. 기본형은 닫힌 쪽이다 — \"이 값이 아니면 거부\"는 키가 "
    + "없거나 AWS가 값을 새로 추가해도 거부된다.",
};

/** Whether this section's statements carry a resource list. Mirrors ActionPicker.isScoped. */
export const isScoped = (intent: Restriction["intent"]) =>
  intent === "allow_only" || intent === "deny_only";
