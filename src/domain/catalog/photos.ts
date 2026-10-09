import { PHOTOS as CATALOG } from "../../generated/catalog";
import type { MasterFacts } from "./master-facts";
import type { FilmLook, PhotoCategory, PhotoFile } from "./photo-schema";

export type Photo = {
  slug: string;
  title: string;
  category: PhotoCategory;
  categoryLabel: string;
  caption: string;
  description: string;
  alt: string;
  /** Homepage hero caption. Set on the featured photo only; copy lives here, not in the page. */
  heroCaption?: string;
  /** Private master object key in MASTERS — never used in gallery UI. */
  imageKey: string;
  /** Film gallery uses dark matte + filter. */
  filmLook?: FilmLook;
  /** Set on at most one published photo; drives the homepage hero. */
  featured?: boolean;
  /** Master content hash; when present the web derivative ladder is keyed by it. */
  imageHash?: string;
  /** Oriented pixel size and orientation; drives print eligibility (#295/#297). */
  master: MasterFacts;
};

/**
 * The label shown above a print's title. Derived from the category, so a file
 * cannot carry a second spelling of it — one `Record`, like `CATEGORY_HREF`,
 * so a new category is a compile error here rather than an empty label.
 */
const CATEGORY_LABEL: Record<PhotoCategory, string> = {
  "fine-art": "Fine Art Collection",
  archive: "Everyday Archive • Photojournalism",
  film: "Film Photography",
};

/**
 * The runtime shape of a catalog entry. `categoryLabel` and `imageKey` are
 * derived here rather than stored in YAML, so the file stays about the photo
 * and the code keeps the two rules (a label per category, a master key per
 * slug) in exactly one place.
 */
function toPhoto(file: PhotoFile): Photo {
  return {
    slug: file.slug,
    title: file.title,
    category: file.category,
    categoryLabel: CATEGORY_LABEL[file.category],
    caption: file.caption,
    description: file.description,
    alt: file.alt,
    heroCaption: file.heroCaption,
    imageKey: `prints/${file.slug}.jpg`,
    filmLook: file.filmLook,
    featured: file.featured,
    imageHash: file.imageHash,
    // The generated catalog only contains published photos, which build-catalog
    // validates with requireMasterFacts: true — so master is guaranteed here.
    master: file.master!,
  };
}

/** Compiled from `content/photos/*.yaml` by `npm run build:catalog`. */
export const PHOTOS: Photo[] = CATALOG.map(toPhoto);

export function getPhoto(slug: string): Photo | undefined {
  return PHOTOS.find((p) => p.slug === slug);
}

export function photosByCategory(category: PhotoCategory): Photo[] {
  return PHOTOS.filter((p) => p.category === category);
}

/**
 * The homepage hero: the one photo marked `featured`, or else the first
 * published fine-art photo. PHOTOS is compiled in display order, so the
 * fallback is the lowest `order` among fine-art photos.
 */
export function featuredPhoto(
  photos: readonly Photo[] = PHOTOS,
): Photo | undefined {
  return (
    photos.find((photo) => photo.featured) ??
    photos.find((photo) => photo.category === "fine-art")
  );
}

// A Record rather than a switch: a switch falls off the end when a category
// is added, so a new one would type-check and render href={undefined}.
const CATEGORY_HREF: Record<PhotoCategory, string> = {
  "fine-art": "/fine-art",
  archive: "/archive",
  film: "/film",
};

export function categoryHref(category: PhotoCategory): string {
  return CATEGORY_HREF[category];
}

// The one place a film look is written as a CSS class. This string was
// hand-rolled in every page and component that renders a film photo, and the
// copies only stayed identical by luck — a rename here would have left the
// others rendering an unfiltered image with no test failing.
const FILM_LOOK_CLASS: Record<FilmLook, string> = {
  contrast: "filter contrast-125",
  sepia: "filter sepia",
  grayscale: "filter grayscale",
};

export function filmLookClass(look: Photo["filmLook"]): string {
  return look ? FILM_LOOK_CLASS[look] : "";
}

/**
 * Whether a photo's gallery tile is matted dark.
 *
 * The home and story pages each carried a hand-written `dark` boolean next to
 * per-tile copy, while PhotoCard derived the same thing from
 * `category === "film"`. The two were the drift, not PhotoCard: adding a
 * category, or reordering the tiles, would have left the hand-written flags
 * describing a photo the tile no longer shows.
 *
 * Derived from the category, not from the presence of a filmLook. filmLook
 * drives the CSS filter, the dark matte is a gallery convention, and they
 * happen to agree today — tying the matte to the filter would make a future
 * unfiltered film photo render on a pale tile.
 */
export function isFilmPhoto(photo: Pick<Photo, "category">): boolean {
  return photo.category === "film";
}
