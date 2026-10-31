import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { JsonLd } from "@/components/JsonLd";
import { PrintDetail } from "@/components/PrintDetail";
import { PageShell } from "@/components/PageShell";
import { categoryHref } from "@/domain/catalog/categories";
import { shipToCountriesFor } from "@/domain/pricing/ship-to-countries";
import { filmLookClass, getPhoto, PHOTOS, photoForLocale } from "@/domain/catalog/photos";
import { isLocale } from "@/domain/i18n/locale";
import { localePath } from "@/domain/i18n/locale-path";
import { galleryImage } from "@/infrastructure/media/gallery-image";
import { printJsonLd } from "@/infrastructure/seo/json-ld";
import { printMetadata } from "@/infrastructure/seo/page-metadata";
import { getDictionary } from "@/components/i18n/dictionaries";
import { requireLocale } from "../../locale-param";

export function generateStaticParams() {
  return PHOTOS.map((p) => ({ slug: p.slug }));
}

/**
 * The photograph's own title and canonical.
 *
 * `params` is a Promise in Next 16 and must be awaited, exactly as the page
 * below awaits it — `generateMetadata` is not exempt, and passing the
 * unresolved promise to `getPhoto()` finds nothing and renders a canonical of
 * `/prints/[object Promise]`.
 *
 * An unknown slug returns an empty object rather than a guess, and the page's
 * own `notFound()` answers with a 404: a title invented for a slug that does not
 * exist would be the one thing here that gets indexed.
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string; slug: string }>;
}): Promise<Metadata> {
  const { locale, slug } = await params;
  const photo = getPhoto(slug);
  if (!photo || !isLocale(locale)) return {};
  return printMetadata(photo, locale);
}

export default async function PrintDetailPage({
  params,
}: {
  params: Promise<{ locale: string; slug: string }>;
}) {
  const { locale: raw, slug } = await params;
  const locale = requireLocale(raw);
  const photo = getPhoto(slug);
  if (!photo) notFound();
  // The photo as it reads in this page's language: the shared catalog holds the
  // source's words, and the print page shows the reader's.
  const localized = photoForLocale(photo, locale);
  const copy = getDictionary(locale);
  // The destination list, named here on the server: the names come from ICU,
  // and the server's ICU and the browser's are not the same version, so a name
  // the client re-derived could differ from this one and React would call it a
  // hydration mismatch.
  const countries = shipToCountriesFor(locale);

  // Resolved on the server: `galleryImage()` reads `process.env`, which a
  // client component does not see, so the ladder URL must be computed here and
  // passed down as a plain value (#326).
  const image = galleryImage(photo, 2000);
  const filmLookClassName = filmLookClass(photo.filmLook);

  return (
    <section className="fade-in">
      <PageShell width="7xl" padding={10}>
        {/* Product + BreadcrumbList, describing the print this page sells. The
            image is the 2000px rung the page already requests, so the markup
            names a file that exists rather than a second, larger one. */}
        <JsonLd data={printJsonLd(photo, image, locale)} />
        <Link
          href={localePath(locale, categoryHref(photo.category))}
          className="text-xs uppercase tracking-widest text-stone-500 hover:text-stone-900 mb-8 inline-flex items-center gap-2 font-medium"
        >
          {copy.print.backToGallery}
        </Link>

        <PrintDetail
          photoSlug={localized.slug}
          title={localized.title}
          offer={localized.printOffer}
          master={localized.master}
          image={image}
          alt={localized.alt}
          filmLookClassName={filmLookClassName}
          locale={locale}
          copy={{ print: copy.print, configurator: copy.configurator }}
          countries={countries}
        >
          <div>
            <span className="text-[10px] uppercase tracking-[0.2em] font-mono font-medium text-amber-800">
              {localized.categoryLabel}
            </span>
            <h1 className="font-serif text-3xl font-normal text-stone-900 mt-1">
              {localized.title}
            </h1>
            <p className="text-xs text-stone-500 mt-2 leading-relaxed">
              {localized.description}
            </p>
          </div>
        </PrintDetail>
      </PageShell>
    </section>
  );
}
