/**
 * The `sizes` each photo grid declares to the browser.
 *
 * `sizes` is what tells the browser how wide the image will be rendered, and
 * the browser picks a candidate from the srcSet on that answer: too small and
 * the tile is soft, too large and every visitor downloads pixels nobody sees.
 * So the value is a fact about the grid the tile sits in — one column below
 * the first breakpoint, two or three above — and not a property of the tile.
 *
 * They were written at each call site instead, which is how the gallery came
 * to be wrong: its grid is `sm:grid-cols-2 lg:grid-cols-3`, so a tile is half
 * the viewport from 640px, while the string it carried described a single
 * column below 768px and a third above. Between 768px and 1024px the browser
 * was told to fetch a third of the viewport for a tile drawn at half of it, so
 * every gallery page served a soft tile at tablet width; between 640px and
 * 768px it fetched a whole viewport width for a half-width tile, which is the
 * same mistake in the other direction.
 *
 * One constant per grid rather than one shared value, because the grids do not
 * break at the same width and the whole point of naming them is that they are
 * read off the grid they describe.
 */

/**
 * The gallery grid: `sm:grid-cols-2 lg:grid-cols-3 gap-8` in `GalleryPage`.
 * One column below Tailwind's `sm` (640px), two until `lg` (1024px), three
 * above it, so a tile is half the viewport across the middle range and a third
 * — less the gap — above it.
 */
export const GALLERY_GRID_SIZES =
  "(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 33vw";

/**
 * The home page's category grid: `md:grid-cols-3 gap-8` in `app/page.tsx`.
 * One column below `md` (768px) and three above it, so a tile is a third of
 * the viewport for every width past that.
 */
export const HOME_CATEGORY_GRID_SIZES = "(max-width: 768px) 100vw, 33vw";

/**
 * The story page's film blocks: `md:col-span-7` of a `md:grid-cols-12` grid in
 * `app/story/page.tsx`, which is seven twelfths of the content column rather
 * than a fraction of the viewport. Spelled 60vw above `md`, which is a little
 * wide for the largest desktop container and errs towards a sharper image
 * rather than a soft one; left as it is, because the correction is a container
 * measurement and this is a declaration of the block's shape.
 */
export const STORY_BLOCK_SIZES = "(max-width: 768px) 100vw, 60vw";
