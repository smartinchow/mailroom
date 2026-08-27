/**
 * SECURITY-CRITICAL (design §9.4): stored bodies contain live magic-link and
 * invite tokens and arbitrary third-party HTML. They may only ever be rendered
 * inside <iframe sandbox=""> (no allow-scripts, no allow-same-origin) via
 * srcdoc, with a CSP that blocks everything by default. Remote images are
 * click-to-load: the default document carries img-src 'none'; the caller
 * re-renders with allowRemoteImages=true after an explicit user action.
 */

export function buildBodySrcdoc(html: string, allowRemoteImages: boolean): string {
  const imgSrc = allowRemoteImages ? "img-src https: data:" : "img-src 'none'";
  // default-src 'none' blocks scripts, frames, fonts, media, fetch, forms.
  // style-src 'unsafe-inline' keeps typical email inline styling legible.
  const csp = `default-src 'none'; style-src 'unsafe-inline'; ${imgSrc}`;
  // Deliberately base-less: no <base>, so relative URLs resolve nowhere useful.
  return (
    "<!doctype html><html><head>" +
    '<meta charset="utf-8">' +
    `<meta http-equiv="Content-Security-Policy" content="${csp}">` +
    "</head><body>" +
    html +
    "</body></html>"
  );
}
