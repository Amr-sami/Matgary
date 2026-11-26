// Digital collections — InstaPay Payment Address (IPA) links and handles
// (spec 06 §4.6, 03 §B.2.1).
//
// Since InstaPay app v1.11.0 (23 Dec 2025) an IPA can be paid only by QR,
// link or favourite (03 §0.6), so a receiving account stores its `ipa_link`
// and the POS draws its QR (qr.ts).
//
// The link shape `https://ipn.eg/S/<handle>/instapay/<id>` comes from an
// UNOFFICIAL community SDK (https://github.com/MohamedMostafa259/instapay-eg,
// [IPEG]); UNVERIFIED (I3, G-M1). How to verify: share a real link from the
// InstaPay app and scan the app's own QR with a generic scanner (15's Q9
// protocol). The strict pattern lives here only — there is no DB CHECK — so a
// changed shape is a code change, not a migration.
//
// Look-alike links are the phishing risk IF7: another host
// (`ipn.eg.evil.com`), plain http, a query, a fragment, a trailing slash or an
// upper-case host are all rejected.
//
// Hermes-safe.

/** §B.2.1 `ipa_link`; group 1 = the handle segment, group 2 = the link id. */
export const IPA_LINK_RE = /^https:\/\/ipn\.eg\/S\/([^/?#\s]+)\/instapay\/([A-Za-z0-9]+)$/;

/** §B.2.1 `ipa_handle`, stored lower-case. */
export const IPA_HANDLE_RE = /^[a-z0-9._-]{3,60}@instapay$/;

const LINK_PREFIX = "https://ipn.eg/S/";

/**
 * True only for `https://ipn.eg/S/<handle>/instapay/<id>` (after trimming):
 * exact host `ipn.eg`, https only, no query, fragment or trailing slash.
 */
export function isValidIpaLink(link: string): boolean {
  if (typeof link !== "string") return false;
  return IPA_LINK_RE.test(link.trim());
}

/**
 * The handle a valid link points at: "<decoded segment, lower-cased>@instapay",
 * or null when the link is invalid or the segment is not a valid handle.
 */
export function ipaHandleFromLink(link: string): string | null {
  if (typeof link !== "string") return null;
  const m = IPA_LINK_RE.exec(link.trim());
  if (!m) return null;
  let segment: string;
  try {
    segment = decodeURIComponent(m[1]);
  } catch {
    return null;
  }
  const handle = `${segment.toLowerCase()}@instapay`;
  return IPA_HANDLE_RE.test(handle) ? handle : null;
}

/** Checks the lower-cased, trimmed value against IPA_HANDLE_RE. */
export function isValidIpaHandle(handle: string): boolean {
  if (typeof handle !== "string") return false;
  return IPA_HANDLE_RE.test(handle.trim().toLowerCase());
}

// Characters that may precede a link in pasted text (start of a token).
const TOKEN_OPENERS = " \t\n\r\f\v(\"'<[{:،؛ ";
// Punctuation that may trail a link in pasted text.
const TRAILING_PUNCT_RE = /[.,;:!?)\]}>"'،؛۔]+$/;

/**
 * The first valid `https://ipn.eg/S/…` link in a pasted share text, e.g. the
 * app's "Click the link to send money to <handle>@instapay … Powered by
 * InstaPay" [APPSTORE], so the account form (spec 09) accepts a paste of the
 * whole text. The link must start a token; trailing punctuation is dropped.
 * Returns null when no valid link is found.
 */
export function ipaLinkFromShareText(text: string): string | null {
  if (typeof text !== "string") return null;
  let from = 0;
  for (;;) {
    const at = text.indexOf(LINK_PREFIX, from);
    if (at === -1) return null;
    from = at + LINK_PREFIX.length;
    if (at > 0 && TOKEN_OPENERS.indexOf(text[at - 1]) === -1) continue;
    let end = at;
    while (end < text.length && !/\s/.test(text[end])) end++;
    const candidate = text.slice(at, end).replace(TRAILING_PUNCT_RE, "");
    if (isValidIpaLink(candidate)) return candidate;
  }
}
