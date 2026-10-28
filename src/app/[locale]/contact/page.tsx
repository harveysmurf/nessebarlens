import type { Metadata } from "next";
import { ContactForm } from "@/components/ContactForm";
import { turnstileSiteKey } from "@/infrastructure/config/config";
import { PageShell } from "@/components/PageShell";
import { eyebrowClass } from "@/components/type-styles";
import { isLocale } from "@/domain/i18n/locale";
import { getDictionary } from "@/components/i18n/dictionaries";
import { pageMetadata } from "@/infrastructure/seo/page-metadata";
import { requireLocale } from "../locale-param";

// The site key is read from the Worker's runtime environment, so the page must
// render per request: a static build would bake whatever the CI build happened
// to have and then serve it from assets, ignoring a per-environment key.
export const dynamic = "force-dynamic";

// The hand-written title this replaced was 22 characters — visible in full in
// every SERP, and carrying none of the words someone searching for a Nessebar
// print would type. The canonical is new too: /contact had none, so the same page
// was reachable at /contact, /contact/ and /Contact as three separate URLs.
//
// A function rather than a constant because the canonical now carries the
// locale segment.
export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  if (!isLocale(locale)) return {};
  return pageMetadata("/contact", locale);
}

/**
 * The contact page, in the page's language.
 *
 * The dictionary is read here, on the server, and the slice the form renders
 * is handed over as a prop: the client component never sees the dictionary, so
 * a browser that opens the contact page carries one locale's copy and not the
 * whole site's.
 */
export default async function ContactPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale: raw } = await params;
  const locale = requireLocale(raw);
  const copy = getDictionary(locale).contact;

  return (
    <section className="fade-in">
      <PageShell width="2xl" padding={16} className="space-y-8">
        <div className="text-center space-y-3">
          <span className={eyebrowClass()}>{copy.eyebrow}</span>
          <h1 className="font-serif text-4xl sm:text-5xl font-light">
            {copy.title}
          </h1>
          <p className="text-sm text-stone-500 max-w-md mx-auto">{copy.body}</p>
        </div>

        <ContactForm siteKey={turnstileSiteKey()} locale={locale} copy={copy} />
      </PageShell>
    </section>
  );
}
