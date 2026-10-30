import { expect, test } from "@playwright/test";
import { PHOTOS, photoForLocale } from "@/domain/catalog/photos";

/**
 * The storefront in both languages.
 *
 * The site serves English only until the contact and checkout slices land —
 * that is the integration guard, and a Bulgarian URL serving English copy would
 * be worse than no Bulgarian URL at all. So the Bulgarian tree is reachable
 * only where the guard is lifted, which is the dev server the e2e runs
 * against: `SERVE_LOCALES=bg` in playwright.config.ts, and a production build
 * ignores it whatever the environment says.
 *
 * That is why this spec can exist before Bulgarian is published, and why it
 * matters: the copy, the prices and the country names are all in Bulgarian
 * *now*, while the copy is still unreviewed, rather than being translated
 * against a page that has already changed underneath it.
 *
 * The flow is home → gallery → print → configuration, in Bulgarian, and then
 * the switch back to English — the same journey a Bulgarian visitor would
 * take, and the one that would break if a page fell back to the source's
 * words.
 */

const SAMPLE = PHOTOS[0]!;
const BULGARIAN = photoForLocale(SAMPLE, "bg");

/**
 * The Bulgarian tree is not served by a production build.
 *
 * The served set is the registry's public one — English, until the contact and
 * checkout slices land — and a production build serves exactly that whatever
 * the environment says. The dev server is the one place the guard is lifted
 * (`SERVE_LOCALES=bg` in playwright.config.ts), so this spec runs there and
 * skips against a deployed environment, where `/bg` is a 404 by design.
 *
 * The skip carries its reason: a spec that skips itself silently would look
 * like a pass.
 */
const againstDeployed = Boolean(process.env.E2E_BASE_URL);

/** The reason the skip carries, so a skipped spec does not look like a pass. */
const AGAINST_DEPLOYED_REASON =
  "the Bulgarian tree is not served by a production build yet";

// One skip for the file, not one per test: the whole spec is about the
// Bulgarian tree, and it is either served or it is not.
test.skip(againstDeployed, AGAINST_DEPLOYED_REASON);

/** The price in Bulgarian conventions: the symbol after the amount. */
const BULGARIAN_DIGITAL_PRICE = "30,00 €";

test("the Bulgarian home page is Bulgarian, and says so in the document", async ({
  page,
}) => {
  await page.goto("/bg");

  // The language is in the document, not set by an effect: a crawler reads the
  // HTML, and an effect runs after it.
  await expect(page.locator("html")).toHaveAttribute("lang", "bg");

  // The nav is the registry's names in this language, not the English ones.
  // Scoped to the nav: the tile and the hero carry the same words, and a
  // locator that matches three things asserts nothing.
  const nav = page.getByRole("navigation", { name: "Основна навигация" });
  await expect(
    nav.getByRole("link", { name: "Художествена фотография", exact: true }),
  ).toBeVisible();
  await expect(nav.getByRole("link", { name: "Архив", exact: true })).toBeVisible();
  await expect(
    nav.getByRole("link", { name: "Аналогова фотография", exact: true }),
  ).toBeVisible();

  // The header's tagline joins the categories the Bulgarian way.
  await expect(
    page.getByText(
      "Старият Несебър • Художествена фотография, Архив и Аналогова фотография",
    ),
  ).toBeVisible();

  // And the page's own words are Bulgarian: the hero's eyebrow, the line under
  // it and the tile blurbs.
  await expect(page.getByText("Избрана художествена фотография")).toBeVisible();
  await expect(
    page.getByText("Научете повече за историите зад снимките:"),
  ).toBeVisible();
  await expect(
    page.getByText("Най-добрите ми художествени фотографии"),
  ).toBeVisible();
});

test("the Bulgarian gallery and print page are Bulgarian", async ({ page }) => {
  await page.goto("/bg/fine-art");

  // The gallery's heading is the registry's Bulgarian name, and the badge and
  // blurb are the dictionary's.
  await expect(
    page.getByRole("heading", { name: "Художествена фотография" }),
  ).toBeVisible();
  await expect(page.getByText("Подбрано портфолио")).toBeVisible();

  // A card carries the photo's Bulgarian title and caption, not the source's.
  const card = page.locator(`a[href="/bg/prints/${SAMPLE.slug}"]`).first();
  await expect(card).toBeVisible();
  await expect(card.getByText(BULGARIAN.title)).toBeVisible();
  await expect(card.getByText("Изберете вариант за печат")).toBeVisible();

  // And the image's alt text is the Bulgarian one: the card's own picture
  // carries it, and the source's words are nowhere on the page.
  await expect(
    page.locator(`img[alt="${BULGARIAN.alt}"]`).first(),
  ).toBeVisible();
  await expect(page.locator(`img[alt="${SAMPLE.alt}"]`)).toHaveCount(0);

  await page.goto(`/bg/prints/${SAMPLE.slug}`);

  // The print page: the photo's own words, its category line and the way back.
  await expect(page.getByRole("heading", { name: BULGARIAN.title })).toBeVisible();
  await expect(page.getByText(BULGARIAN.description)).toBeVisible();
  await expect(page.getByText("← Назад към галерията")).toBeVisible();

});

test("the Bulgarian configurator is Bulgarian, and prices in Bulgarian", async ({
  page,
}) => {
  await page.goto(`/bg/prints/${SAMPLE.slug}`);

  // The format names, the field labels and the button. The format card's
  // title is also in the screen-reader line under the button, so the
  // assertion is on the first of them.
  await expect(
    page.getByText("Художествен отпечатък (giclée)").first(),
  ).toBeVisible();
  await expect(page.getByText("Дигитален файл").first()).toBeVisible();
  await expect(
    page.getByText("Изберете вариант за печат").first(),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Плащане през Stripe" })).toBeVisible();

  // The price is in the locale's conventions: the symbol after the amount and
  // a decimal comma. The amount is the same number.
  await expect(page.getByText(BULGARIAN_DIGITAL_PRICE).first()).toBeVisible();

  // The destination list is in the reader's language, and the submitted value
  // is still the ISO code.
  await expect(page.locator("#shipping-country")).toHaveValue("BG");
  const bulgaria = page.locator("#shipping-country option", { hasText: "България" });
  await expect(bulgaria).toHaveCount(1);
  await expect(bulgaria).toHaveAttribute("value", "BG");
});

test("the Bulgarian contact page is Bulgarian, and so are its field errors", async ({
  page,
}) => {
  await page.goto("/bg/contact");

  await expect(page.locator("html")).toHaveAttribute("lang", "bg");

  // The page's own words.
  await expect(
    page.getByRole("heading", { name: "Контакт с ателието" }),
  ).toBeVisible();
  await expect(page.getByText("Свържете се с нас")).toBeVisible();
  await expect(page.getByText("Въпроси за отпечатък")).toBeVisible();

  // The form's labels, and the button.
  await expect(page.getByLabel("Име", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Имейл", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Съобщение", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Изпрати съобщение" }),
  ).toBeVisible();

  // And the rejections: the form renders the dictionary's Bulgarian sentence
  // for each code, so an empty submission reads in Bulgarian too.
  await page.getByRole("button", { name: "Изпрати съобщение" }).click();
  await expect(page.getByText("Моля, въведете вашето име.")).toBeVisible();
  await expect(page.getByText("Моля, въведете вашия имейл адрес.")).toBeVisible();
  await expect(page.getByText("Моля, въведете съобщение.")).toBeVisible();
  // The English sentences are nowhere on the page.
  await expect(page.getByText("Please enter your name.")).toHaveCount(0);
  await expect(page.getByText("Send Message")).toHaveCount(0);
});

test("the switcher carries the reader from Bulgarian to English and back", async ({
  page,
}) => {
  await page.goto(`/bg/prints/${SAMPLE.slug}`);

  // The switcher is a real link, so the browser can follow it.
  const toEnglish = page.getByRole("link", { name: "English", exact: true });
  await expect(toEnglish).toHaveAttribute(
    "href",
    `/en/prints/${SAMPLE.slug}`,
  );
  await toEnglish.click();

  await expect(page).toHaveURL(new RegExp(`/en/prints/${SAMPLE.slug}$`));
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.getByRole("heading", { name: SAMPLE.title })).toBeVisible();

  // And back: the other language, on the same page.
  await page.getByRole("link", { name: "Български", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/bg/prints/${SAMPLE.slug}$`));
  await expect(page.locator("html")).toHaveAttribute("lang", "bg");
  await expect(page.getByRole("heading", { name: BULGARIAN.title })).toBeVisible();
});

test("the Bulgarian mobile menu is Bulgarian at 320px", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto("/bg");

  // The toggle's accessible name is the page's language, and the panel's nav
  // carries the Bulgarian names. The hit target is not shrunk to make the
  // longer words fit: the panel scrolls, the button does not move.
  const toggle = page.getByRole("button", { name: "Отвори менюто" });
  await expect(toggle).toBeVisible();
  await toggle.click();

  const panel = page.getByRole("navigation", { name: "Основна навигация" });
  await expect(panel).toBeVisible();
  await expect(
    panel.getByRole("link", {
      name: "Художествена фотография",
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Затвори менюто" })).toBeVisible();
});
