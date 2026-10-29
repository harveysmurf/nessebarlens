import { expect, test } from "@playwright/test";

/**
 * The success page's three states (#143), reached through the page's own read
 * path against the seeded ORDERS — see e2e/fixtures/orders-seed.README.md for
 * why seeding and not standing up a webhook receiver.
 *
 * These are the states a customer sees after paying, and the two that matter
 * most are the ones that differ only in KV contents: a physical buyer must not
 * be offered a download, and a paid digital buyer must be. Getting either wrong
 * means charging someone and then telling them the wrong thing about their
 * money, which is why the assertions below are on rendered copy rather than on
 * the absence of a link — the link's absence is easy, its presence is the bug.
 */

const DIGITAL_PAID = "cs_test_e2edigitalpaid00000001";
/** The token seeded for DIGITAL_PAID in e2e/fixtures/orders-seed.json (#111). */
const DIGITAL_PAID_TOKEN = "e2ef17e0000000000000000000000aa0";
const DIGITAL_PENDING = "cs_test_e2edigitalpending000002";
const PHYSICAL = "cs_test_e2ephysicalawaitingprodigi03";

const successUrl = (sessionId: string) =>
  `/checkout/success?session_id=${sessionId}`;

/**
 * The Bulgarian tree is served by the dev server and not by a production build.
 *
 * The served set is the registry's public one — English, until the last slice
 * publishes Bulgarian — and a production build serves exactly that whatever the
 * environment says. The dev server is the one place the override applies
 * (`SERVE_LOCALES=bg` in playwright.config.ts), so these specs run there and
 * skip against a deployed environment, where `/bg` is a 404 by design.
 *
 * The skip carries its reason: a spec that skipped itself silently would look
 * like a pass.
 */
const againstDeployed = Boolean(process.env.E2E_BASE_URL);

/** The reason the skip carries, so a skipped spec does not look like a pass. */
const AGAINST_DEPLOYED_REASON =
  "the Bulgarian tree is not served by a production build yet";

test.describe("success page states", () => {
  test("a paid digital order offers the download and the short reference", async ({
    page,
  }) => {
    await page.goto(successUrl(DIGITAL_PAID));

    await expect(page.getByText(/your download is ready/i)).toBeVisible();

    // The download link is a plain <a download> to /api/download, not a client
    // navigation — see the page's comment on #103. Asserting the href rather
    // than clicking it keeps the spec from streaming a master it has no business
    // downloading, while still proving the credential is carried.
    //
    // The credential is a token, not the session id (#111): the session id alone
    // no longer grants the file, and this href is what replaced it.
    const download = page.getByRole("link", { name: /download your file/i });
    await expect(download).toHaveAttribute(
      "href",
      `/api/download?token=${DIGITAL_PAID_TOKEN}`,
    );
    await expect(download).toHaveAttribute("download", "");

    // The limits the token was issued under are stated, and the page renders no
    // session id anywhere (checkout-success.test.mts pins that).
    await expect(page.getByText(/works 5 times and expires 30 days/i)).toBeVisible();

    // Ready orders carry no poller: there is nothing left to wait for, so a
    // /api/order-status call here would be a reload loop waiting to happen.
    await expect(page.getByText(DIGITAL_PAID.slice(-8).toUpperCase())).toBeVisible();
  });

  test("a digital order mid-fulfilment says preparing and never offers a download", async ({
    page,
  }) => {
    await page.goto(successUrl(DIGITAL_PENDING));

    await expect(page.getByText(/we are preparing your download/i)).toBeVisible();

    // The load-bearing assertion for this state. An order with no masterKey
    // cannot be downloaded — /api/download answers 409 for it — so a link here
    // would be the page promising something the download route refuses.
    await expect(page.getByRole("link", { name: /download your file/i })).toHaveCount(
      0,
    );
  });

  test("a physical order is told it is shipping, with no download", async ({
    page,
  }) => {
    await page.goto(successUrl(PHYSICAL));

    await expect(page.getByText(/being produced and will ship/i)).toBeVisible();

    // /api/download answers 403 not-a-digital-download for a print, and the
    // #103 fix was precisely that this page used to offer that link anyway.
    await expect(page.getByRole("link", { name: /download your file/i })).toHaveCount(
      0,
    );
  });

  test("an unknown session id degrades to preparing rather than an error", async ({
    page,
  }) => {
    // A session id in the Checkout Session grammar that ORDERS has no record
    // for — the ordinary first seconds after payment, before the webhook runs.
    // Not a 500: Stripe already took the money, and a customer told their
    // payment failed is worse than one told to wait.
    const response = await page.goto(
      successUrl("cs_test_e2enothinghere00000000004"),
    );
    expect(response?.status()).toBe(200);
    await expect(page.getByText(/we are preparing your download/i)).toBeVisible();
  });

  test("a reference that is not a Checkout Session is refused, not rendered", async ({
    page,
  }) => {
    // The session id is a KV key. Anything that does not match
    // isCheckoutSessionId's grammar must be refused before the lookup, which
    // is what keeps a customer-supplied string out of the namespace.
    await page.goto("/checkout/success?session_id=not-a-session");

    await expect(page.getByText(/order reference is not valid/i)).toBeVisible();
    await expect(page.getByRole("link", { name: /download your file/i })).toHaveCount(
      0,
    );
  });
});

/**
 * The same states, in the other language.
 *
 * The success page is where a customer finds out what happened to their money,
 * so it has to say it in the language they were buying in. What must NOT change
 * with the language is the credential: the download endpoint is unprefixed and
 * the token is the credential, so a localized href would be a broken one.
 *
 * The page's language is the URL's, not the order's — a customer who switches
 * the page's language to read the page must not change the language their
 * receipt arrives in — so these specs drive the URL, not the record.
 */
test.describe("success page states in Bulgarian", () => {
  test.skip(againstDeployed, AGAINST_DEPLOYED_REASON);

  const bgUrl = (sessionId: string) =>
    `/bg/checkout/success?session_id=${sessionId}`;

  test("a paid digital order is told in Bulgarian and offers the same download", async ({
    page,
  }) => {
    await page.goto(bgUrl(DIGITAL_PAID));

    // The language is in the document, not set by an effect: a crawler reads
    // the HTML, and an effect runs after it.
    await expect(page.locator("html")).toHaveAttribute("lang", "bg");

    await expect(page.getByText(/вашият файл е готов/i)).toBeVisible();

    // The same href as in English: the token endpoint is not localized, and a
    // localized one would be a link to nothing.
    const download = page.getByRole("link", { name: /изтеглете файла/i });
    await expect(download).toHaveAttribute(
      "href",
      `/api/download?token=${DIGITAL_PAID_TOKEN}`,
    );
    await expect(download).toHaveAttribute("download", "");

    // The limits are stated in the reader's language, with the language's own
    // plural words: "5 пъти" and "30 дни", not "5 times" and "30 days".
    await expect(
      page.getByText(/работи 5 пъти и изтича след 30 дни/i),
    ).toBeVisible();
  });

  test("a digital order mid-fulfilment says preparing in Bulgarian", async ({
    page,
  }) => {
    await page.goto(bgUrl(DIGITAL_PENDING));

    await expect(page.getByText(/подготвяме вашия файл/i)).toBeVisible();

    // The load-bearing assertion, in this language too: a link here would be
    // the page promising something /api/download refuses.
    await expect(page.getByRole("link", { name: /изтеглете файла/i })).toHaveCount(
      0,
    );
  });

  test("a physical order is told it is shipping, in Bulgarian", async ({
    page,
  }) => {
    await page.goto(bgUrl(PHYSICAL));

    await expect(page.getByText(/изработва и ще бъде изпратен/i)).toBeVisible();

    await expect(page.getByRole("link", { name: /изтеглете файла/i })).toHaveCount(
      0,
    );
  });

  test("a reference that is not a Checkout Session is refused, in Bulgarian", async ({
    page,
  }) => {
    await page.goto("/bg/checkout/success?session_id=not-a-session");

    await expect(page.getByText(/номер на поръчка не е валиден/i)).toBeVisible();
    await expect(page.getByRole("link", { name: /изтеглете файла/i })).toHaveCount(
      0,
    );
  });
});