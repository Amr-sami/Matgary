// Convert a free-text store name into a URL-safe slug.
// Latin: lowercased, hyphenated. Arabic: transliterated to a short prefix
// then suffixed with random bytes to keep uniqueness without leaking the
// Arabic name.
export function slugify(input: string): string {
  const trimmed = input.trim().toLowerCase();
  const ascii = trimmed
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

  if (ascii.length >= 3) return ascii.slice(0, 40);

  // Fallback for Arabic / non-Latin store names: short random slug.
  const random = Math.random().toString(36).slice(2, 8);
  return `store-${random}`;
}
