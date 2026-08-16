/**
 * One clock for every timestamp the dashboard prints.
 *
 * Viewer-local and 24-hour, formatted by hand rather than by toLocaleString(): the Korean locale
 * default is 12-hour with 오전/오후, and what an approver reads must not depend on which browser
 * locale they happen to carry. The shape is the one the assessment header established and the
 * user pinned - date 2026-08-15, time 17:51:11 - and the viewer's own timezone is used because
 * the person deciding is the reference point, not the container that wrote the document.
 */
const pad = (n: number) => String(n).padStart(2, "0");

export function localDate(at: Date): string {
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

export function localTime(at: Date): string {
  return `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`;
}

/**
 * "2026-08-15 17:51:11", or the input untouched when it does not parse: a wrong-looking
 * timestamp is a prompt to ask, a hidden one is not.
 */
export function clock(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  return `${localDate(at)} ${localTime(at)}`;
}
