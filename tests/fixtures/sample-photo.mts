/**
 * A catalog photo the tests can resolve, derived rather than hardcoded.
 *
 * The order, checkout and fulfillment suites need a slug that `getPhoto()`
 * actually returns, because the real code looks the photo up in the compiled
 * catalog. Before #245 they used the placeholder slug `dawn`; that entry is
 * gone, and pinning the owner's real photo slug here would couple the suite to
 * production content. `PHOTOS[0]` keeps the tests green for any non-empty
 * catalog.
 */
import { PHOTOS } from "../../src/lib/photos.ts";

export const SAMPLE_PHOTO = PHOTOS[0];

/** The slug a catalog-resolved order or session should name. */
export const SAMPLE_SLUG = SAMPLE_PHOTO.slug;

/** The production master key for SAMPLE_SLUG: `prints/{slug}.jpg`. */
export const SAMPLE_MASTER_KEY = `prints/${SAMPLE_SLUG}.jpg`;
