import type { Metadata } from "next";
import { ContactForm } from "@/components/ContactForm";
import { turnstileSiteKey } from "@/infrastructure/config/config";

// The site key is read from the Worker's runtime environment, so the page must
// render per request: a static build would bake whatever the CI build happened
// to have and then serve it from assets, ignoring a per-environment key.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Contact — Nessebar Lens",
  description:
    "Get in touch with the Nessebar Lens studio about prints, licensing or an order.",
};

export default function ContactPage() {
  return (
    <section className="fade-in">
      <div className="max-w-2xl mx-auto px-6 py-16 space-y-8">
        <div className="text-center space-y-3">
          <span className="text-[10px] uppercase tracking-[0.3em] text-stone-400 font-medium">
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
      </div>
    </section>
  );
}
