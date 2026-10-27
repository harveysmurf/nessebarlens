import type { Metadata } from "next";
import Link from "next/link";
import { buttonClass } from "@/components/Button";
import { PageShell } from "@/components/PageShell";
import { BODY_COPY, eyebrowClass } from "@/components/type-styles";
import { isLocale } from "@/domain/i18n/locale";
import { localePath } from "@/domain/i18n/locale-path";
import { pageMetadata } from "@/infrastructure/seo/page-metadata";
import { requireLocale } from "../../locale-param";

/**
 * `noindex, nofollow`: the URL can carry a `?slug=` back to a print, so this
 * page exists in as many shapes as the catalog has photos, and none of them is
 * worth a search result. `pageMetadata` also keeps it out of the sitemap.
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  if (!isLocale(locale)) return {};
  return pageMetadata("/checkout/cancel", locale);
}

export default async function CheckoutCancelPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ slug?: string }>;
}) {
  const locale = requireLocale((await params).locale);
  const { slug } = await searchParams;
  const backHref = localePath(
    locale,
    slug ? `/prints/${encodeURIComponent(slug)}` : "/",
  );

  return (
    <section className="fade-in">
      <PageShell width="lg" padding={20} className="text-center space-y-6">
        <span className={eyebrowClass()}>
          Checkout cancelled
        </span>
        <h1 className="font-serif text-3xl font-light text-stone-900">
          No charge was made
        </h1>
        <p className={BODY_COPY}>
          You left Stripe Checkout before paying. Your selection is still on the
          print page if you want to try again.
        </p>
        <Link href={backHref} className={buttonClass("inline")}>
          {slug ? "Return to print" : "Back to gallery"}
        </Link>
      </PageShell>
    </section>
  );
}
