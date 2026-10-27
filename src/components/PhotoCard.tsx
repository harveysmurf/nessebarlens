import Link from "next/link";
import { isFilmPhoto, type Photo } from "@/domain/catalog/photos";
import type { Locale } from "@/domain/i18n/locale";
import { localePath } from "@/domain/i18n/locale-path";
import { GALLERY_GRID_SIZES } from "@/components/grid-sizes";
import { PhotoTile } from "@/components/PhotoTile";

export function PhotoCard({
  photo,
  locale,
}: {
  photo: Photo;
  /** The locale of the page the card is on: the print's URL carries it. */
  locale: Locale;
}) {
  return (
    <Link
      href={localePath(locale, `/prints/${photo.slug}`)}
      className="group cursor-pointer space-y-3 block"
    >
      {/* The box itself is `PhotoTile` (#422). Three call sites rendered it by
          hand and two of them had already drifted into the black frame #409
          reported; the fix is one copy of the box, not another test. */}
      <PhotoTile photo={photo} sizes={GALLERY_GRID_SIZES} duration={500} />
      <div className="flex justify-between items-baseline text-xs gap-3">
        <div>
          <h3 className="font-serif text-base font-normal text-gallery-900">{photo.title}</h3>
          <p
            className={`text-[10px] text-stone-500 ${
              // #423: the caption was `text-stone-400` here and `text-stone-500`
              // for film, so the film branch also carried the passing value and
              // the two now agree. The mono face is all that distinguishes them.
              isFilmPhoto(photo) ? "font-mono" : ""
            }`}
          >
            {photo.caption}
          </p>
        </div>
        <span className="text-stone-600 font-medium shrink-0">Print options</span>
      </div>
    </Link>
  );
}
