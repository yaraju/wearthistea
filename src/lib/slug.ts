/** Lowercase, non-alphanumeric-to-dash, trimmed, capped at 50 chars. */
export function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "")
      .slice(0, 50) || "wearthistea-design"
  );
}

/**
 * A Design's shareable slug: slugify(title) + "-" + id. The id suffix
 * guarantees global uniqueness by construction (ids are already unique) —
 * no collision retry loop needed, unlike a bare slugify(title).
 */
export function designSlug(title: string, id: string): string {
  return `${slugify(title)}-${id}`;
}
