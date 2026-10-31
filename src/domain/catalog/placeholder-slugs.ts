/**
 * The gallery placeholders added in #484.
 *
 * While `NEXT_PUBLIC_PLACEHOLDER_PHOTOS` is on, the gallery serves a local
 * `/placeholders/{slug}.jpg` for every photo, so these 12 entries exist to keep
 * the shop from being empty before their real masters are shot and promoted.
 * They carry catalog facts so the photo pages render, but they have no objects
 * in `nessebar-lens-masters` and are not production assets.
 *
 * That makes them the one exception to "a published photo's master must exist":
 * `verify-masters` (the release gate) and the bucket audit skip exactly these
 * slugs and still check every real photo. This is the same allow-list #245
 * removed when real photos went live; delete a slug here when its real master is
 * promoted so the gate re-arms for it.
 */
export const PLACEHOLDER_SLUGS: ReadonlySet<string> = new Set([
  "fishing-boats-at-dawn-nessebar",
  "lighthouse-on-the-cliff-nessebar",
  "nessebar-church-ruins-snow",
  "nessebar-film-boat-sunset",
  "nessebar-film-street-scene",
  "nessebar-fishermen-wharf",
  "nessebar-fortress-wall",
  "nessebar-old-house-door",
  "nessebar-old-town-1950s",
  "nessebar-sea-wall-storm",
  "old-windmill-at-sunset-nessebar",
  "stone-wall-and-sea-nessebar",
]);
