import Link from "next/link";
import type { Photo } from "@/lib/photos";
import { WebPhoto } from "@/components/WebPhoto";

export function PhotoCard({ photo }: { photo: Photo }) {
  const filmClass =
    photo.filmLook === "contrast"
      ? "filter contrast-125"
      : photo.filmLook === "sepia"
        ? "filter sepia"
        : photo.filmLook === "grayscale"
          ? "filter grayscale"
          : "";

  return (
    <Link href={`/prints/${photo.slug}`} className="group cursor-pointer space-y-3 block">
      <div
        className={`aspect-[4/3] overflow-hidden rounded-sm ${
          photo.category === "film" ? "bg-stone-900 p-1" : "bg-stone-200"
        }`}
      >
        <WebPhoto
          slug={photo.slug}
          alt={photo.title}
          preferred={1500}
          sizes="(max-width: 768px) 100vw, 33vw"
          className={`w-full h-full object-cover group-hover:scale-105 transition-transform duration-500 ${filmClass}`}
        />
      </div>
      <div className="flex justify-between items-baseline text-xs gap-3">
        <div>
          <h3 className="font-serif text-base font-normal text-gallery-900">{photo.title}</h3>
          <p
            className={`text-[10px] text-stone-400 ${
              photo.category === "film" ? "font-mono text-stone-500" : ""
            }`}
          >
            {photo.subtitle}
          </p>
        </div>
        <span className="text-stone-600 font-medium shrink-0">Print options</span>
      </div>
    </Link>
  );
}
