/**
 * Prodigi sandbox order creation (Phase 2).
 * Asset URLs are public placeholders (or WEB print.jpg later) — never MASTERS.
 */

import { PHOTOS } from "./photos";
import type { FrameFinish, PrintSize } from "./pricing";
import { resolveSku, type PhysicalFormat } from "./sku-map";
import { siteUrl } from "./stripe";

const PRODIGI_ORDERS_URL = "https://api.sandbox.prodigi.com/v4.0/orders";

export type OrderRecipient = {
  name: string;
  line1: string;
  line2: string;
  city: string;
  state: string;
  postcode: string;
  countryCode: string;
  email: string | null;
  phone: string | null;
};

export type ProdigiOrderRequest = {
  merchantReference: string;
  idempotencyKey: string;
  shippingMethod: "Budget";
  recipient: {
    name: string;
    email?: string;
    phoneNumber?: string;
    address: {
      line1: string;
      line2?: string;
      postalOrZipCode: string;
      countryCode: string;
      townOrCity: string;
      stateOrCounty?: string;
    };
  };
  items: Array<{
    sku: string;
    copies: 1;
    sizing: "fillPrintArea";
    attributes: Record<string, string>;
    assets: Array<{ printArea: "default"; url: string }>;
  }>;
};

export type ProdigiOrderSuccess = {
  ok: true;
  orderId: string;
  stage: string | null;
};

export type ProdigiOrderFailure = {
  ok: false;
  kind: "client" | "server";
  message: string;
  status: number | null;
};

export type ProdigiOrderResult = ProdigiOrderSuccess | ProdigiOrderFailure;

export type CreateProdigiOrder = (input: {
  sessionId: string;
  photoSlug: string;
  format: PhysicalFormat;
  size: PrintSize;
  frame: FrameFinish | null;
  recipient: OrderRecipient;
}) => Promise<ProdigiOrderResult>;

/** Public stand-in until WEB `{slug}/print.jpg` is ingested (Phase 3 C). */
export function placeholderAssetUrl(photoSlug: string): string {
  const base = siteUrl().replace(/\/$/, "");
  return `${base}/placeholders/${photoSlug}.jpg`;
}

export function assertNoMasterLeak(value: unknown): void {
  const blob = JSON.stringify(value);
  if (blob.includes("nessebar-lens-masters")) {
    throw new Error("master-leak: masters bucket referenced");
  }
  if (blob.includes("/prints/") || blob.includes('"prints/')) {
    throw new Error("master-leak: prints/ master key path");
  }
  for (const photo of PHOTOS) {
    if (blob.includes(photo.imageKey)) {
      throw new Error(`master-leak: imageKey ${photo.imageKey}`);
    }
  }
}

export function buildProdigiOrderBody(input: {
  sessionId: string;
  photoSlug: string;
  format: PhysicalFormat;
  size: PrintSize;
  frame: FrameFinish | null;
  recipient: OrderRecipient;
  assetUrl?: string;
}): ProdigiOrderRequest {
  const entry = resolveSku(input.format, input.size, input.frame);
  const assetUrl = input.assetUrl ?? placeholderAssetUrl(input.photoSlug);
  if (!/^https:\/\//i.test(assetUrl)) {
    throw new Error("asset url must be https");
  }
  if (/prints\//i.test(assetUrl) || /masters/i.test(assetUrl)) {
    throw new Error("asset url must not point at masters");
  }

  const recipient: ProdigiOrderRequest["recipient"] = {
    name: input.recipient.name,
    address: {
      line1: input.recipient.line1,
      postalOrZipCode: input.recipient.postcode,
      countryCode: input.recipient.countryCode,
      townOrCity: input.recipient.city,
    },
  };
  if (input.recipient.line2) recipient.address.line2 = input.recipient.line2;
  if (input.recipient.state) {
    recipient.address.stateOrCounty = input.recipient.state;
  }
  if (input.recipient.email) recipient.email = input.recipient.email;
  if (input.recipient.phone) recipient.phoneNumber = input.recipient.phone;

  const body: ProdigiOrderRequest = {
    merchantReference: input.sessionId,
    idempotencyKey: input.sessionId,
    shippingMethod: "Budget",
    recipient,
    items: [
      {
        sku: entry.sku,
        copies: 1,
        sizing: "fillPrintArea",
        attributes: entry.attributes,
        assets: [{ printArea: "default", url: assetUrl }],
      },
    ],
  };
  assertNoMasterLeak(body);
  return body;
}

function prodigiApiKey(): string {
  const key =
    process.env.PRODIGI_SANDBOX_API_KEY || process.env.PRODIGI_API_KEY;
  if (!key) {
    throw new Error("Prodigi API key is not set");
  }
  return key;
}

export const createProdigiOrder: CreateProdigiOrder = async (input) => {
  let body: ProdigiOrderRequest;
  try {
    body = buildProdigiOrderBody(input);
  } catch (e) {
    return {
      ok: false,
      kind: "client",
      message: e instanceof Error ? e.message : "invalid-order-body",
      status: null,
    };
  }

  let res: Response;
  try {
    res = await fetch(PRODIGI_ORDERS_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": prodigiApiKey(),
      },
      body: JSON.stringify(body),
    });
  } catch (e) {
    return {
      ok: false,
      kind: "server",
      message: e instanceof Error ? e.message : "network-error",
      status: null,
    };
  }

  let data: {
    outcome?: string;
    order?: { id?: string; status?: { stage?: string } };
  } = {};
  try {
    data = (await res.json()) as typeof data;
  } catch {
    data = {};
  }

  if (!res.ok) {
    return {
      ok: false,
      kind: res.status >= 500 ? "server" : "client",
      message: `Prodigi order HTTP ${res.status}`,
      status: res.status,
    };
  }

  const orderId = data.order?.id;
  if (typeof orderId !== "string" || !orderId) {
    return {
      ok: false,
      kind: "client",
      message: "Prodigi order missing id",
      status: res.status,
    };
  }

  return {
    ok: true,
    orderId,
    stage:
      typeof data.order?.status?.stage === "string"
        ? data.order.status.stage
        : null,
  };
};
