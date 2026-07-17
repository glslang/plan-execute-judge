/**
 * Turns a string into a URL slug: lowercase, whitespace to hyphens, and
 * anything that is not a-z, 0-9, or "-" dropped.
 */
export function slugify(input) {
  return String(input)
    .trim()
    .toLowerCase()
    .replace(/\s/g, "-")
    .replace(/[^a-z0-9-]/g, "");
}
