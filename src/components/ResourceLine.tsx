import { useRef } from "react";
import type { ImpactResource } from "../types";
import { parseArn } from "../../server/arn.js";

// One resource, as an approver reads it - and it is now read on two screens.
//
// It lived in Impact.tsx because the impact panel was the only place a resource line appeared. The
// risk cards printed the bare ARN instead, so the same subnet was
// "arn:aws:ec2:us-east-1:644701781058:subnet/subnet-003d4154d197b2496" on one screen and
// "리소스명: subnet-003d4154d197b2496, 계정: 644701781058, 리전: us-east-1" on the other, and an
// approver moving between them had to do the parsing themselves to see they were the same row.
//
// Moved rather than copied. Two renderers of one shape drift, and the thing they would drift on is
// the part that took the most deciding: which slot a KMS alias goes in, that the console link
// belongs on the group heading and not the row, and that tags go behind a button because one
// CloudFormation-managed resource carries two hundred characters of them.

/**
 * The row's tags, behind a button.
 *
 * They were printed inline and a single CloudFormation-managed resource carried two hundred
 * characters of them - a logical id, a stack name, and a stack ARN with a uuid on the end - which
 * pushed 리소스명 off the left of what a reader takes in and made every row look different lengths
 * for reasons that were not about the resource.
 *
 * A native <dialog>, not a hand-built overlay. It comes with Escape, the backdrop, focus trapping
 * and returning focus to the button - four behaviours that get written badly otherwise, and the
 * last of which is the one nobody notices missing until they are using a keyboard.
 *
 * The button says how MANY, so a reader can see there are tags without opening anything, and rows
 * with none show no button rather than an empty one.
 */
export function TagButton({ tags, arn }: { tags: Record<string, string>; arn: string }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const entries = Object.entries(tags ?? {}).sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) return null;
  return (
    <>
      <button
        type="button"
        className="tag-button"
        title="이 자원의 태그를 봅니다"
        onClick={() => dialog.current?.showModal()}
      >
        태그 {entries.length}
      </button>
      <dialog
        ref={dialog}
        className="tag-dialog"
        /* The backdrop IS the dialog element as far as a click is concerned, so a click whose
           target is the dialog itself landed outside the panel below. */
        onClick={(event) => {
          if (event.target === dialog.current) dialog.current?.close();
        }}
      >
        <div className="tag-panel">
          <div className="tag-head">
            <code>{arn}</code>
            <button type="button" onClick={() => dialog.current?.close()}>닫기</button>
          </div>
          <table className="tag-table">
            <tbody>
              {entries.map(([key, value]) => (
                <tr key={key}>
                  <th>{key}</th>
                  <td>{value}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </dialog>
    </>
  );
}

/**
 * One resource as a labelled sentence: 리소스명, 계정, 리전. The console link is NOT here - it
 * lives on the group heading, once per region, because the list page it opens is the same for
 * every row of the group and a repeated link is furniture. The full ARN stays on the hover title;
 * an ARN that does not parse shows whole in the name slot rather than hiding.
 */
export function LabeledResource({ resource, accountId }: {
  resource: ImpactResource;
  /** The governed account, used only when the ARN itself carries none (S3). */
  accountId: string;
}) {
  const parsed = parseArn(resource.arn);
  const account = parsed?.account || accountId;
  const region = resource.region || parsed?.region || "global";
  // A KMS key's own name is a UUID, so a list of them says which service and which region and
  // nothing about which key. Where an alias came back it IS the name, and the id moves to the
  // quiet slot beside it - still on the row, because that is what the console and every policy
  // document call the key, and a page that showed only the alias would leave the reader unable to
  // match a row to a Deny they are about to write.
  const name = resource.alias ?? parsed?.name ?? resource.arn;
  const aside = resource.alias ? (parsed?.name ?? null) : (parsed?.qualifier ?? null);
  return (
    <span className="res labeled" title={resource.arn}>
      <span className="res-label">리소스명: </span>
      <code className="res-name">{name}</code>
      {aside && <span className="res-qualifier">/{aside}</span>}
      <span className="res-label">, 계정: </span>
      <span className="res-value">{account}</span>
      <span className="res-label">, 리전: </span>
      <span className="res-value">{region}</span>
    </span>
  );
}
