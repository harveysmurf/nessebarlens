import Link from "next/link";
import { BUTTON_LABEL, eyebrowClass } from "@/components/type-styles";

export default async function CheckoutCancelPage({
  searchParams,
}: {
  searchParams: Promise<{ slug?: string }>;
}) {
  const { slug } = await searchParams;
  const backHref = slug ? `/prints/${encodeURIComponent(slug)}` : "/";

  return (
    <section className="fade-in max-w-lg mx-auto px-6 py-20 text-center space-y-6">
      <span className={eyebrowClass()}>
        Checkout cancelled
      </span>
      <h1 className="font-serif text-3xl font-light text-stone-900">
        No charge was made
      </h1>
      <p className="text-xs text-stone-600 leading-relaxed font-light">
        You left Stripe Checkout before paying. Your selection is still on the
        print page if you want to try again.
      </p>
      <Link
        href={backHref}
        className={`${BUTTON_LABEL} inline-block bg-stone-900 hover:bg-stone-800 text-white py-3 px-6 rounded transition-all`}
      >
        {slug ? "Return to print" : "Back to gallery"}
      </Link>
    </section>
  );
}
