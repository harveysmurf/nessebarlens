import type { Metadata } from "next";
import { ContactForm } from "@/components/ContactForm";
import { turnstileSiteKey } from "@/infrastructure/config/config";
import { PageShell } from "@/components/PageShell";
import { eyebrowClass } from "@/components/type-styles";
import { pageMetadata } from "@/infrastructure/seo/page-metadata";

// The site key is read from the Worker's runtime environment, so the page must
// render per request: a static build would bake whatever the CI build happened
// to have and then serve it from assets, ignoring a per-environment key.
export const dynamic = "force-dynamic";

// The hand-written title this replaced was 22 characters — visible in full in
// every SERP, and carrying none of the words someone searching for a Nessebar
// print would type. The canonical is new too: /contact had none, so the same page
// was reachable at /contact, /contact/ and /Contact as three separate URLs.
export const metadata: Metadata = pageMetadata("/contact");

export default function ContactPage() {
  return (
    <section className="fade-in">
      <PageShell width="2xl" padding={16} className="space-y-8">
        <div className="text-center space-y-3">
          <span className={eyebrowClass()}>
            Get in touch
          </span>
          <h1 className="font-serif text-4xl sm:text-5xl font-light">
            Contact the Studio
          </h1>
          <p className="text-sm text-stone-500 max-w-md mx-auto">
            Questions about a print, licensing, or an order? Send a message and
            I&apos;ll reply to you directly.
          </p>
        </div>

        <ContactForm siteKey={turnstileSiteKey()} />
      </PageShell>
    </section>
  );
}
