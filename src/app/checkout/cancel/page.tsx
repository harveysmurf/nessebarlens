import Link from "next/link";

export default async function CheckoutCancelPage({
  searchParams,
}: {
  searchParams: Promise<{ slug?: string }>;
}) {
  const { slug } = await searchParams;
  const backHref = slug ? `/prints/${encodeURIComponent(slug)}` : "/";

  return (
    <section className="fade-in max-w-lg mx-auto px-6 py-20 text-center space-y-6">
      <span className="text-[10px] uppercase tracking-[0.3em] text-stone-400 font-medium">
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
        className="inline-block bg-stone-900 hover:bg-stone-800 text-white font-medium py-3 px-6 rounded text-xs uppercase tracking-widest transition-all"
      >
        {slug ? "Return to print" : "Back to gallery"}
      </Link>
    </section>
  );
}
