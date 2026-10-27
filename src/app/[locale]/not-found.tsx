import Link from "next/link";
import { buttonClass } from "@/components/Button";
import { PageShell } from "@/components/PageShell";
import { eyebrowClass } from "@/components/type-styles";
import { DEFAULT_LOCALE } from "@/domain/i18n/locale";
import { localePath } from "@/domain/i18n/locale-path";
import { getDictionary } from "@/components/i18n/dictionaries";

/**
 * The page a visitor gets when the address does not match a photograph, a
 * gallery or a form.
 *
 * It lives in the locale segment so it renders inside the site's own layout —
 * the header, the footer, the type — rather than as a bare page with a line
 * of text on it. The copy is the default locale's, because a segment's
 * not-found page is rendered without the segment's parameters: there is no
 * locale to read here, and English is the site.
 */
export default function NotFound() {
  const dictionary = getDictionary(DEFAULT_LOCALE);

  return (
    <section className="fade-in">
      <PageShell width="2xl" padding={16} className="text-center space-y-6">
        <span className={eyebrowClass()}>
          {dictionary.notFound.eyebrow}
        </span>
        <h1 className="font-serif text-4xl sm:text-5xl font-light">
          {dictionary.notFound.title}
        </h1>
        <p className="text-sm text-stone-500 max-w-md mx-auto">
          {dictionary.notFound.body}
        </p>
        <Link href={localePath(DEFAULT_LOCALE, "/")} className={buttonClass("inline")}>
          {dictionary.notFound.back}
        </Link>
      </PageShell>
    </section>
  );
}
