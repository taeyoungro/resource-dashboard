import { resourceIconPath } from "../../server/serviceIcons.js";

/**
 * The AWS service icon beside a service's name - the official one, extracted from the
 * Architecture Icons deck (tools/extract-aws-icons.mjs), loaded per icon from the static
 * directory so a page only fetches the handful its assessment actually shows.
 *
 * Decoration, and declared as such: the service NAME next to it is the information, so the image
 * carries an empty alt and failure renders nothing - an unmapped prefix returns no element at all,
 * and a file that fails to load hides itself rather than leaving a broken-image glyph beside
 * every row of a policy.
 */
export function ServiceIcon({ service, resourceType }: {
  service: string;
  /** When given, the type's own PRODUCT wins over the prefix: IAM files VPC under ec2, and an
   *  approver reading ec2:vpc under an EC2 icon is being told the wrong product. */
  resourceType?: string;
}) {
  const src = resourceIconPath(service, resourceType);
  if (!src) return null;
  return (
    <img
      className="service-icon"
      src={src}
      alt=""
      aria-hidden="true"
      loading="lazy"
      onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
    />
  );
}
