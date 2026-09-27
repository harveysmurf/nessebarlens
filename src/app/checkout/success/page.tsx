import Link from "next/link";

export default async function CheckoutSuccessPage({
  searchParams,
}: {
  searchParams: Promise<{ session_id?: string }>;
}) {
  const { session_id: sessionId } = await searchParams;

  return (
    <section className="fade-in max-w-lg mx-auto px-6 py-20 text-center space-y-6">
      <span className="text-[10px] uppercase tracking-[0.3em] text-stone-400 font-medium">
        Payment received
      </span>
      <h1 className="font-serif text-3xl font-light text-stone-900">
        Thank you
      </h1>
      <p className="text-xs text-stone-600 leading-relaxed font-light">
        Your Stripe Checkout completed. Physical prints ship after fulfillment.
        Digital downloads become available once the order is marked paid — this
        page does not deliver the file.
      </p>

      {sessionId ? (
        <div className="bg-white border border-stone-200 rounded-sm p-5 space-y-3 text-left">
          <p className="text-[10px] uppercase tracking-widest text-stone-400">
            Session
          </p>
          <code className="text-[11px] text-stone-700 break-all block">
            {sessionId}
          </code>
          <Link
            href={`/api/download?session_id=${encodeURIComponent(sessionId)}`}
            className="inline-block w-full text-center bg-stone-900 hover:bg-stone-800 text-white font-medium py-3 rounded text-xs uppercase tracking-widest transition-all"
          >
            Go to download
          </Link>
          <p className="text-[10px] text-stone-400 text-center">
            If fulfillment is still processing, the download route will say so.
          </p>
        </div>
      ) : (
        <p className="text-xs text-amber-800 bg-amber-50 border border-amber-100 rounded p-3">
          Missing session_id. Open this page from the Stripe success redirect.
        </p>
      )}

      <Link
        href="/"
        className="inline-block text-xs uppercase tracking-widest border-b border-stone-800 pb-0.5 font-medium hover:text-stone-500"
      >
        Back to gallery
      </Link>
    </section>
  );
}
