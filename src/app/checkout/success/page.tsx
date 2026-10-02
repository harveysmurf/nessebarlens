import Link from "next/link";
import OrderStatusPoller from "./OrderStatusPoller";
import {
  resolveCheckoutDownloadLink,
  resolveCheckoutPageState,
} from "./order-state";
import { getConfig } from "@/lib/config";

/**
 * A short reference the customer can quote in support, derived from the session
 * id already in their URL. The full id is printed nowhere: it identified the
 * order and, until #111, doubled as the bearer credential for the download
 * route. It no longer grants a download, but a URL that looks like a secret is
 * one a customer pastes into a public thread.
 */
function orderReference(sessionId: string): string {
  return sessionId.slice(-8).toUpperCase();
}

export default async function CheckoutSuccessPage({
  searchParams,
}: {
  searchParams: Promise<{ session_id?: string }>;
}) {
  const { session_id: sessionId } = await searchParams;
  const state = await resolveCheckoutPageState(sessionId);
  // Only read for the one state that renders a link. A token fetched on every
  // state would be a credential read for pages that cannot use it.
  const downloadHref =
    state === "digital-ready"
      ? await resolveCheckoutDownloadLink(sessionId)
      : null;
  const reference = sessionId ? orderReference(sessionId) : "";
  // Stated from the config the token was actually issued under, so the copy
  // cannot claim 5 downloads on a deployment configured for 3.
  const { maxDownloads, tokenTtlSeconds } = getConfig().download;
  const ttlCopy = ttlCopyOf(tokenTtlSeconds);

  return (
    <section className="fade-in max-w-lg mx-auto px-6 py-20 text-center space-y-6">
      <span className="text-[10px] uppercase tracking-[0.3em] text-stone-400 font-medium">
        Payment received
      </span>
      <h1 className="font-serif text-3xl font-light text-stone-900">
        Thank you
      </h1>

      {state === "missing-session" ? (
        <p className="text-xs text-amber-800 bg-amber-50 border border-amber-100 rounded p-3">
          We could not read your order reference from this link. Open it from the
          Stripe receipt email if you need your download.
        </p>
      ) : state === "invalid-session" ? (
        <p className="text-xs text-amber-800 bg-amber-50 border border-amber-100 rounded p-3">
          That order reference is not valid. Open this page from the Stripe
          receipt email.
        </p>
      ) : state === "physical" ? (
        <OrderCard reference={reference}>
          <p className="text-xs text-stone-600 leading-relaxed font-light">
            Your print is being produced and will ship from our partner studio.
            You do not need to do anything else.
          </p>
        </OrderCard>
      ) : state === "digital-ready" && downloadHref ? (
        <OrderCard reference={reference}>
          <p className="text-xs text-stone-600 leading-relaxed font-light">
            Your download is ready. This link works {maxDownloads} times and
            expires {ttlCopy}.
          </p>
          {/*
            A plain <a>, deliberately not <Link>.

            <Link> to a Route Handler prefetches as soon as it scrolls into view,
            so merely rendering this page issued a GET to /api/download — running
            the KV lookup and starting to stream the full-resolution master before
            any click (#103). <Link> gains nothing here: a file download has no
            client navigation to preserve, and the route's response is not RSC,
            so Next fell back to a hard navigation regardless. `download` tells
            the browser to save rather than navigate, which is what this is.

            Which now also costs a download if it ever were prefetched: the link
            carries a token, and each redemption spends one (#111). A stray
            prefetch would burn the customer's count on a render they never
            asked for, so the plain <a> is load-bearing rather than stylistic.
          */}
          <a
            href={downloadHref}
            download
            className="inline-block w-full text-center bg-stone-900 hover:bg-stone-800 text-white font-medium py-3 rounded text-xs uppercase tracking-widest transition-all"
          >
            Download your file
          </a>
        </OrderCard>
      ) : state === "digital-no-token" ? (
        /*
          Paid, and the order record says the file is ready — but there is no
          download token for it, which is the only thing that now grants the
          file (#111). Reachable for orders stored before tokens existed; the
          token is deliberately not minted here, because this URL carries the
          session id and minting on demand would restore exactly the bearer
          credential tokens replaced. Ask for the link by email instead, which is
          what #117 is for.
        */
        <OrderCard reference={reference}>
          <p className="text-xs text-stone-600 leading-relaxed font-light">
            Your payment went through, but we cannot show a download link here.
            Please contact us and quote the reference below and we will send it.
          </p>
        </OrderCard>
      ) : state === "revoked" ? (
        <OrderCard reference={reference}>
          <p className="text-xs text-stone-600 leading-relaxed font-light">
            This order was refunded or is under dispute, so the download is no
            longer available.
          </p>
        </OrderCard>
      ) : state === "unavailable" ? (
        /*
          A record exists under this session id but cannot be parsed, so
          resolveCheckoutPageState returns "unavailable" and
          /api/order-status answers 500 corrupt-order for it. Distinct from
          "processing" on purpose: that branch's poller would retry the same
          failing endpoint until its deadline, and "we are preparing your
          download" is a claim we cannot make — the order record is already
          there and it is broken. No poller, because nothing can change
          without someone fixing the record.

          Unlike digital-unavailable, this does not promise that the team has
          been notified. lib/order-corrupt.ts does emit order.corrupt for this
          branch (#140), so an operator now sees it — but that log is ours to
          read, not a commitment made to the customer in the moment they are
          told their order is unreadable. The copy asks them to get in touch,
          which is the one thing we can honour without a human having seen the
          alert yet.
        */
        <OrderCard reference={reference}>
          <p className="text-xs text-stone-600 leading-relaxed font-light">
            We could not read this order, so we cannot show you its status here.
            Please contact us and quote the reference below — your payment went
            through and we will get your order to the right place.
          </p>
        </OrderCard>
      ) : state === "digital-unavailable" ? (
        <OrderCard reference={reference}>
          <p className="text-xs text-stone-600 leading-relaxed font-light">
            Your payment went through but we could not prepare the download. Our
            team has been notified — quote the reference below and we will sort it
            out.
          </p>
        </OrderCard>
      ) : (
        // processing, and the degraded cases that cannot assert anything yet.
        <OrderCard reference={reference} sessionId={sessionId}>
          <p className="text-xs text-stone-600 leading-relaxed font-light">
            We are preparing your download. This page updates on its own — no need
            to refresh.
          </p>
        </OrderCard>
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

/** "30 days", "12 hours" — never a raw seconds count at the customer. */
function ttlCopyOf(seconds: number): string {
  if (seconds % 86_400 === 0) {
    const days = seconds / 86_400;
    return days === 1 ? "1 day" : `${days} days`;
  }
  if (seconds % 3_600 === 0) return `${seconds / 3_600} hours`;
  return `${Math.round(seconds / 60)} minutes`;
}

function OrderCard(props: {
  reference: string;
  sessionId?: string | undefined;
  children: React.ReactNode;
}) {
  return (
    <div className="bg-white border border-stone-200 rounded-sm p-5 space-y-3 text-left">
      {props.children}
      {props.reference ? (
        <p className="text-[10px] text-stone-400 text-center">
          Order reference <span className="font-medium">{props.reference}</span>
        </p>
      ) : null}
      {props.sessionId ? <OrderStatusPoller sessionId={props.sessionId} /> : null}
    </div>
  );
}