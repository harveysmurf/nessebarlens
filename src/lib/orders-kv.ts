/**
 * The one spelling of "the ORDERS KV binding is not usable".
 *
 * Three sites answered 503 "orders-kv-unavailable" — twice in the download
 * route (binding missing, and get() threw) and once in the stripe webhook
 * (binding missing). Same deploy-time fact, same status, same body, three
 * literals, and the string is what an operator greps for when a paid download
 * 503s. A reworded literal landing in one site would make the three
 * indistinguishable in the logs. The string is narrow on purpose: only a
 * missing binding may produce it. The webhook's bare catch answering with this
 * string for any throw is exactly the misdiagnosis to avoid — a real bug in
 * fulfillment logged as a missing binding points at the wrong subsystem.
 *
 * The two routes answer with different headers and that asymmetry is
 * deliberate, not an oversight: download is a private asset route and wraps
 * the body in NO_STORE_HEADERS, while the webhook returns no headers. So these
 * are two plain constants rather than a shared response builder — the string
 * and the status are the shared facts, the headers stay the caller's choice.
 *
 * Stays free of `next/server`, like json-body.ts and prodigi-config.ts.
 */
export const ORDERS_KV_UNAVAILABLE_ERROR = "orders-kv-unavailable";

export const ORDERS_KV_UNAVAILABLE_STATUS = 503;
