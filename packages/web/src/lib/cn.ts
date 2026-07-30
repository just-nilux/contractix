/**
 * Conditional class names. Deliberately not `clsx` + `tailwind-merge`: nothing
 * here composes classes across component boundaries hard enough to need
 * conflict resolution, and two dependencies to join strings is not a trade this
 * app makes.
 */
export function cn(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}
