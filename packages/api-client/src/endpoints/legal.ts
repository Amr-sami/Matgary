// legal — intentionally no network endpoints.
//
// The privacy policy and the terms of use are content, not data: they live in
// the shared dictionary (`marketing.privacy`, `marketing.terms` in
// @matgary/i18n) and the mobile app typesets them natively from there, so they
// work offline and follow the live locale switch. The canonical web copies are
// https://thestoro.com/<locale>/privacy and /terms.
export const LEGAL_DOCS = ["privacy", "terms"] as const;
export type LegalDoc = (typeof LEGAL_DOCS)[number];
