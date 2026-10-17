import { filmLookClass, isFilmPhoto, type Photo } from "@/domain/catalog/photos";
import { WebPhoto } from "@/components/WebPhoto";

type Ratio = "4/3" | "3/2";

/**
 * Tailwind's scanner reads source text, not evaluated strings, so a utility
 * built in a template literal — `aspect-[${ratio}]`, `duration-${duration}` —
 * produces no CSS at all and fails silently: the box loses its aspect ratio and
 * the hover transition loses its length, with no error anywhere. Every class
 * this component can emit is therefore spelled out here, literally, where the
 * scanner will find it. `gallery-tiles.test.mts` compiles the real stylesheet
 * and fails if one of these is ever replaced by interpolation.
 *
 * Narrow literal unions rather than `${number}/${number}` for the same reason:
 * an open type lets a caller pass a ratio this component has no class for,
 * which renders an unconstrained box and still type-checks.
 */
const RATIO_CLASS: Record<Ratio, string> = {
  "4/3": "aspect-[4/3]",
  "3/2": "aspect-[3/2]",
};

const DURATION_CLASS: Record<500 | 700, string> = {
  500: "duration-500",
  700: "duration-700",
};

/**
 * A photo in a fixed-ratio box, cropped to fill, with a letterbox backdrop.
 *
 * Three call sites rendered this by hand — `PhotoCard`, the home page's category
 * tiles and /story's blocks — and they had already drifted, which cost #409: two
 * of the three had a `bg-stone-900 p-1` film frame and one had `bg-stone-200`,
 * so the padding drew a 4px black border on a `border-box` whose image already
 * covers its content box exactly. `gallery-tiles.test.mts` pinned the absence of
 * that padding across the three copies, which stopped the bug returning and
 * stopped nothing else — one file still held three box definitions that could
 * drift. This is the structural half: three copies cannot drift if there is one.
 *
 * **What a caller can no longer get wrong.** The letterbox backdrop is derived
 * from `isFilmPhoto` rather than passed, `filmLookClass` is applied inside, and
 * the `null`-photo case (#245, a category with nothing published yet) is handled
 * once. `PhotoCard` was the odd one out: it hard-coded `bg-stone-200` for every
 * photo, so a film tile there got a light backdrop where the other two got a
 * dark one. With `object-cover` the image fills the box, so this is invisible
 * except when `WebPhoto` falls back to alt text — which is the one case where
 * the backdrop is what you actually see.
 *
 * **What is still the caller's, and why.** The link wraps the tile rather than
 * living in it, because `PhotoCard` and the home page link the caption along
 * with the image and /story links only the block; a tile that owned its own
 * `<Link>` could not serve all three. `sizes` is required rather than defaulted
 * because the two grid tiles and the 60vw block genuinely differ and a wrong
 * value asks the browser for the wrong image silently. `ratio` and `duration`
 * differ too, and are props rather than constants — see the note below.
 *
 * The non-film backdrop is `bg-gallery-200`, not `bg-stone-200` (#424). It is a
 * surface, not ink, and it sits directly on the page background; `gallery-200`
 * and `stone-200` differ by 15/255 on blue, which is why this was a placeholder
 * the eye read as a different material from the page around it. The film
 * backdrop stays `bg-stone-900` — that is ink, the deliberate letterbox that
 * `gallery-tiles.test.mts` pins.
 *
 * The tile's own `group` is what `group-hover:scale-105` matches. The caller's
 * `<Link>` already carries `group` in two of three cases, so this is a superset
 * of what was there: /story, whose link was the box itself and so had no `group`
 * ancestor, is now the only site relying on the tile's.
 */
export function PhotoTile({
  photo,
  sizes,
  ratio = "4/3",
  duration = 700,
}: {
  photo: Photo | undefined;
  /** Required: a 33vw grid tile and a 60vw block ask for different images. */
  sizes: string;
  /** The box's aspect. `4/3` for the grid tiles, `3/2` for /story's blocks. */
  ratio?: Ratio;
  /**
   * The hover transition's length, in ms. A prop because the three sites
   * disagreed (500 in `PhotoCard`, 700 in the other two) and which of those is
   * right is an open question, not something to settle by leaving the longest
   * one as the default.
   */
  duration?: 500 | 700;
}) {
  // #409: no padding utility here, and none in any caller. The image fills the
  // content box exactly, so padding can only ever draw a frame.
  const film = photo !== undefined && isFilmPhoto(photo);

  // `WebPhoto`'s no-image fallback is a `<span>` carrying this same className and
  // the photo's alt text, and it inherits `text-gallery-900` from the body — so
  // the fallback's readability is decided here, by the tile, because the tile is
  // what chose the backdrop it sits on. Near-black on the film backdrop is 1.03:1,
  // which is invisible. A text colour on an `<img>` is inert, so this costs
  // nothing when the image does resolve and is the whole ballgame when it does not.
  const fallbackText = film ? "text-stone-100" : "text-gallery-900";

  return (
    <div
      className={`group ${RATIO_CLASS[ratio]} overflow-hidden rounded-sm ${
        film ? "bg-stone-900" : "bg-gallery-200"
      }`}
    >
      {photo ? (
        <WebPhoto
          photo={photo}
          preferred={1500}
          sizes={sizes}
          className={`w-full h-full object-cover group-hover:scale-105 transition-transform ${DURATION_CLASS[duration]} ${fallbackText} ${filmLookClass(photo.filmLook)}`}
        />
      ) : null}
    </div>
  );
}