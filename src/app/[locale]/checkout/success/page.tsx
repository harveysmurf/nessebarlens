import type { Metadata } from "next";
import Link from "next/link";
import OrderStatusPoller from "./OrderStatusPoller";
import {
  resolveCheckoutDownloadLink,
  resolveCheckoutPageState,
} from "./order-state";
import { getConfig } from "@/infrastructure/config/config";
import { orderReference } from "@/domain/ordering/order-reference";
import {
  ORDER_VIEW_STATES,
  SESSION_ID_PARAM,
} from "@/domain/ordering/order-decision";
import {
  fillDownloadSentence,
  ttlPhrase,
} from "@/domain/ordering/checkout-copy";
import { pluralUnit } from "@/domain/i18n/plurals";
import { buttonClass } from "@/components/Button";
import { PageShell } from "@/components/PageShell";
import { BODY_COPY, eyebrowClass } from "@/components/type-styles";
import { isLocale } from "@/domain/i18n/locale";
import { localePath } from "@/domain/i18n/locale-path";
import {
  getDictionary,
  type CheckoutSuccessCopy,
} from "@/components/i18n/dictionaries";
import { pageMetadata } from "@/infrastructure/seo/page-metadata";
import { requireLocale } from "../../locale-param";

/**
 * `noindex, nofollow`, and deliberately not a canonical to a public page: this
 * URL carries a Stripe session id, so there is nothing here to point a crawler
 * at except itself. Excluded from the sitemap by the same flag.
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  if (!isLocale(locale)) return {};
  return pageMetadata("/checkout/success", locale);
}

/**
 * The success page, in the page's language.
 *
 * Every sentence the customer reads comes from the dictionary, keyed by the
 * state the page is in — so a state the page can reach and the dictionary has
 * no sentence for is a type error rather than an English paragraph on a
 * Bulgarian page.
 *
 * The page's language is the URL's, not the order's. The order carries the
 * language of the *email* it triggers, and those are two different things: a
 * customer who switches the page's language to read the page must not change
 * the language their receipt arrives in.
 */
export default async function CheckoutSuccessPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ session_id?: string }>;
}) {
  const locale = requireLocale((await params).locale);
  const copy = getDictionary(locale).checkout.success;
  const { [SESSION_ID_PARAM]: sessionId } = await searchParams;
  const state = await resolveCheckoutPageState(sessionId);
  // Only read for the one state that renders a link. A token fetched on every
  // state would be a credential read for pages that cannot use it.
  const downloadHref =
    state === ORDER_VIEW_STATES.digitalReady
      ? await resolveCheckoutDownloadLink(sessionId)
      : null;
  const reference = sessionId ? orderReference(sessionId) : "";
  // Stated from the config the token was actually issued under, so the copy
  // cannot claim 5 downloads on a deployment configured for 3.
  const { maxDownloads, tokenTtlSeconds } = getConfig().download;
  const ttlCopy = ttlPhrase(tokenTtlSeconds, copy.units, locale);

  return (
    <section className="fade-in">
      <PageShell width="lg" padding={20} className="text-center space-y-6">
        <span className={eyebrowClass()}>{copy.eyebrow}</span>
        <h1 className="font-serif text-3xl font-light text-stone-900">
          {copy.title}
        </h1>

        {state === "missing-session" ? (
          <p className="text-xs text-amber-800 bg-amber-50 border border-amber-100 rounded p-3">
            {copy.states["missing-session"]}
          </p>
        ) : state === "invalid-session" ? (
          <p className="text-xs text-amber-800 bg-amber-50 border border-amber-100 rounded p-3">
            {copy.states["invalid-session"]}
          </p>
        ) : state === ORDER_VIEW_STATES.physical ? (
          <OrderCard copy={copy} reference={reference}>
            <p className={BODY_COPY}>{copy.states.physical}</p>
          </OrderCard>
        ) : state === ORDER_VIEW_STATES.physicalUnfulfilled ? (
          // Paid, but never sent to production (e.g. an address Prodigi cannot
          // accept). No poller: nothing changes until someone acts, and we must
          // not claim the print is being made.
          <OrderCard copy={copy} reference={reference}>
            <p className={BODY_COPY}>{copy.states[ORDER_VIEW_STATES.physicalUnfulfilled]}</p>
          </OrderCard>
        ) : state === ORDER_VIEW_STATES.digitalReady && downloadHref ? (
          <OrderCard copy={copy} reference={reference}>
            <p className={BODY_COPY}>
              {fillDownloadSentence(copy.states[ORDER_VIEW_STATES.digitalReady], {
                uses: pluralUnit(maxDownloads, copy.units.time, locale),
                ttl: ttlCopy,
              })}
            </p>
            {/*
              A plain <a>, deliberately not <Link>.

              <Link> to a Route Handler prefetches as soon as it scrolls into view,
              so merely rendering this page issued a GET to /api/download — running
              the KV lookup and starting to stream the full-resolution master before
              any click (#103). <Link> gains nothing here: a file download has no
              client navigation to preserve, and the route's response is not RSC,
              so Next fell back to a hard navigation regardless. `download` tells the
              browser to save rather than navigate, which is what this is.

              Which now also costs a download if it ever were prefetched: the link
              carries a token, and each redemption spends one (#111). A stray
              prefetch would burn the customer's count on a render they never
              asked for, so the plain <a> is load-bearing rather than stylistic.
            */}
            <a
              href={downloadHref}
              download
              className={buttonClass("block")}
            >
              {copy.download}
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
          <OrderCard copy={copy} reference={reference}>
            <p className={BODY_COPY}>{copy.states["digital-no-token"]}</p>
          </OrderCard>
        ) : state === ORDER_VIEW_STATES.revoked ? (
          <OrderCard copy={copy} reference={reference}>
            <p className={BODY_COPY}>{copy.states.revoked}</p>
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
          <OrderCard copy={copy} reference={reference}>
            <p className={BODY_COPY}>{copy.states.unavailable}</p>
          </OrderCard>
        ) : state === ORDER_VIEW_STATES.digitalUnavailable ? (
          <OrderCard copy={copy} reference={reference}>
            <p className={BODY_COPY}>{copy.states[ORDER_VIEW_STATES.digitalUnavailable]}</p>
          </OrderCard>
        ) : (
          // processing, and the degraded cases that cannot assert anything yet.
          <OrderCard copy={copy} reference={reference} sessionId={sessionId}>
            <p className={BODY_COPY}>{copy.states.processing}</p>
          </OrderCard>
        )}

      <Link
          href={localePath(locale, "/")}
          className="inline-block text-xs uppercase tracking-widest border-b border-stone-800 pb-0.5 font-medium hover:text-stone-500"
        >
          {copy.backToGallery}
        </Link>
      </PageShell>
    </section>
  );
}

function OrderCard(props: {
  /** The page's own copy, so the card and the poller speak one language. */
  copy: CheckoutSuccessCopy;
  reference: string;
  sessionId?: string | undefined;
  children: React.ReactNode;
}) {
  return (
    <div className="bg-white border border-gallery-200 rounded-sm p-5 space-y-3 text-left">
      {props.children}
      {props.reference ? (
        <p className="text-[10px] text-stone-500 text-center">
          {props.copy.referenceLabel}{" "}
          <span className="font-medium">{props.reference}</span>
        </p>
      ) : null}
      {props.sessionId ? (
        <OrderStatusPoller
          sessionId={props.sessionId}
          timedOut={props.copy.timedOut}
        />
      ) : null}
    </div>
  );
}
