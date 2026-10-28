import { LOCALES, type Locale } from "@/domain/i18n/locale";
import type { PhotoCategory } from "@/domain/catalog/photo-schema";
import type { ApiErrorCode } from "@/domain/ordering/api-error-codes";
import type {
  ContactErrorCode,
  ContactFieldErrorCode,
} from "@/domain/contact/contact-error-codes";

/**
 * The site's translated strings, and the only place a translation lives.
 *
 * Static imports, on purpose: the lookup reads neither the network, the
 * filesystem, the environment, a cookie nor the browser's language, so the
 * strings a page renders are the strings that were built into it. A dictionary
 * fetched at runtime is a dictionary that can be missing, and a missing
 * dictionary that silently falls back to English is the failure this whole
 * slice exists to prevent.
 *
 * The shape is closed by the compiler: `satisfies Record<Locale, Dictionary>`
 * means a missing locale is a type error and an extra key in a dictionary
 * literal is an excess-property error, so neither can reach a build. The
 * nested key parity is asserted at runtime as well, in
 * `tests/i18n-locale.test.mts`, because the nested maps are keyed by a value
 * the compiler cannot check for equality across two objects.
 *
 * **This module is for the server.** A client component that imported it would
 * ship every locale's copy to every browser that loaded it — a page that
 * renders one page's words would carry the whole site's. So the client
 * components take the slice they need as a prop, and the server reads it here
 * and hands it over. `tests/i18n-locale.test.mts` holds that boundary.
 *
 * The product copy is not here. The configurator's format, frame, mount and
 * paper labels, and the preview's label, caption and note, live in
 * `src/domain/ordering/print-copy.ts`, because the client component that
 * renders them changes its labels as the buyer changes the selection, and a
 * prop cannot carry a function across the server/client boundary.
 */
export type Dictionary = {
  language: {
    /** The switcher's accessible name, in this locale. */
    label: string;
    /** The accessible name of the link to each locale, in this locale. */
    switchTo: Record<Locale, string>;
  };
  notFound: {
    /** The small line above the heading. */
    eyebrow: string;
    /** The heading. */
    title: string;
    /** The sentence under the heading. */
    body: string;
    /** The link back to the site. */
    back: string;
  };
  nav: {
    /** The accessible name of the main navigation landmark. */
    main: string;
    /** The mobile menu toggle's accessible name, open. */
    openMenu: string;
    /** The mobile menu toggle's accessible name, closed. */
    closeMenu: string;
    /** The nav's last entry, which is not a category. */
    contact: string;
    /** The place, before the category list in the header's tagline. */
    tagline: string;
  };
  footer: {
    /** The copyright line. */
    copyright: string;
    /** The fulfilment line. */
    fulfillment: string;
  };
  home: {
    /** The small line above the hero title. */
    heroEyebrow: string;
    /** The sentence under the hero title. */
    heroBody: string;
    /** The line above the link to the story layout. */
    preferStory: string;
    /** The link to the story layout. */
    viewConceptB: string;
    /** The tile's call to action. */
    explore: string;
    /** Each category tile's one-line blurb. */
    tileBlurb: Record<PhotoCategory, string>;
  };
  story: {
    /** The small line above the heading. */
    eyebrow: string;
    /** The heading. */
    title: string;
    /** The sentence under the heading. */
    body: string;
    /** The word before each block's number. */
    categoryLabel: string;
    /** Each block's paragraph. */
    blockBody: Record<PhotoCategory, string>;
    /** Each block's call to action. */
    blockCta: Record<PhotoCategory, string>;
  };
  gallery: {
    /** Each gallery's badge. */
    badge: Record<PhotoCategory, string>;
    /** Each gallery's one-line blurb. */
    blurb: Record<PhotoCategory, string>;
    /** What a gallery with no photographs says. */
    empty: string;
  };
  print: {
    /** The link back to the gallery. */
    backToGallery: string;
    /** The label on a gallery card's price column. */
    printOptions: string;
    /** The line about how the print reaches the buyer. */
    globalDelivery: string;
    /** The preview's accessible name. */
    previewView: string;
    /** The angled view toggle. */
    angled: string;
    /** The straight-on view toggle. */
    front: string;
  };
  configurator: {
    /** The label above the digital price. */
    price: string;
    /** The label above a physical print's price. */
    print: string;
    /** The label above the shipping estimate. */
    shippingEstimate: string;
    /** The format group's heading. */
    supportedOption: string;
    /** The digital copy's field label. */
    resolution: string;
    /** The size field's label. */
    dimensions: string;
    /** The paper field's label. */
    paper: string;
    /** The frame finish field's label. */
    frameFinish: string;
    /** The mount field's label. */
    mount: string;
    /** The destination field's label. */
    shipTo: string;
    /** The checkout button, idle. */
    checkout: string;
    /** The checkout button, busy. */
    openingCheckout: string;
    /** The footnote under the digital checkout button. */
    footnoteDigital: string;
    /** The footnote under a physical checkout button. */
    footnotePhysical: string;
    /** The message when the quote request fails. */
    quoteFailed: string;
    /** The message when the checkout request fails. */
    checkoutFailed: string;
    /** Why a size cannot be printed without a mount: the shape. */
    noMountShape: string;
    /** Why a size cannot be printed without a mount: the resolution. */
    noMountResolution: string;
    /** The mount's help line, for the unmounted product. */
    mountHelpNone: string;
    /** The mount's help line, for the mounted product. */
    mountHelpWhite: string;
    /**
     * The copy for each failure the quote and checkout endpoints report.
     *
     * The endpoints answer with a code; the copy for a code is here, so the
     * sentence a customer reads is in their language. The keys are the site's
     * closed set of codes, so a code without a sentence in this locale is a
     * compile error rather than a missing line at runtime.
     */
    apiErrors: Record<ApiErrorCode, string>;
  };
  contact: {
    /** The small line above the heading. */
    eyebrow: string;
    /** The heading. */
    title: string;
    /** The sentence under the heading. */
    body: string;
    /** The field labels, in the order the form shows them. */
    labels: {
      name: string;
      email: string;
      message: string;
    };
    /** The submit button, idle. */
    send: string;
    /** The submit button, busy. */
    sending: string;
    /** The line that replaces the form once the message is sent. */
    sent: string;
    /** The notice shown when the form cannot be used at all. */
    unavailable: string;
    /** The message for a submission that did not go through. */
    failed: string;
    /** The copy for each field-level rejection, next to the field. */
    fieldErrors: Record<ContactFieldErrorCode, string>;
    /** The copy for each failed attempt, above the form. */
    errors: Record<ContactErrorCode, string>;
  };
};

const en: Dictionary = {
  language: {
    label: "Language",
    switchTo: {
      en: "Switch to English",
      bg: "Switch to Bulgarian",
    },
  },
  notFound: {
    eyebrow: "Page not found",
    title: "This page is not here",
    body: "The address you followed does not match a photograph, a gallery or the contact form. Everything the site has is one click away.",
    back: "Back to the gallery",
  },
  nav: {
    main: "Main",
    openMenu: "Open menu",
    closeMenu: "Close menu",
    contact: "Contact",
    tagline: "Old Town Nessebar",
  },
  footer: {
    copyright: "© NESSEBAR LENS • Old Town Nessebar Fine Art Studio",
    fulfillment: "Global Print Fulfillment via Prodigi Lab",
  },
  home: {
    heroEyebrow: "Featured Fine Art Print",
    heroBody:
      "Documenting three decades of coastal light, everyday street memories, and analog film grain across Old Town Nessebar.",
    preferStory: "Prefer the story layout?",
    viewConceptB: "View Concept B",
    explore: "Explore →",
    tileBlurb: {
      "fine-art": "Best high-end portfolio gallery captures",
      archive: "Everyday street & journalistic moments",
      film: "35mm film photographs shot on my Nikon F3",
    },
  },
  story: {
    eyebrow: "Visual Heritage",
    title: "Stories from the Black Sea Peninsula",
    body: "A clean, unhurried collection of prints captured over decades. High-resolution fine art, historical street photojournalism, and 35mm film photographs shot on a Nikon F3.",
    categoryLabel: "CATEGORY",
    blockBody: {
      "fine-art":
        "My highest-grade artistic works. Carefully composed architecture, dramatic atmospheric coastlines, and pristine color grading tailored for museum Giclée prints.",
      archive:
        "Photojournalistic records of Nessebar's daily soul — fishermen untangling nets at sunrise, autumn cobblers, seasonal storms, and local town life.",
      film: "35mm film photographs shot on my Nikon F3, with the natural grain and character of Kentmere Pan 100.",
    },
    blockCta: {
      "fine-art": "Browse Fine Art Gallery →",
      archive: "Browse Archival Gallery →",
      film: "Browse Film Gallery →",
    },
  },
  gallery: {
    badge: {
      "fine-art": "Curated Portfolio",
      archive: "Photojournalism",
      film: "Analog Negative",
    },
    blurb: {
      "fine-art":
        "My flagship gallery captures • Museum-quality giclée prints via Prodigi • Available on Hahnemühle Photo Rag",
      archive:
        "Street life, candid moments, and historic everyday events in Old Town Nessebar",
      film: "35mm film photographs shot on my Nikon F3 • Kentmere Pan 100",
    },
    empty: "No photographs in this gallery yet.",
  },
  print: {
    backToGallery: "← Back to Gallery",
    printOptions: "Print options",
    globalDelivery: "Global Delivery via Prodigi",
    previewView: "Preview view",
    angled: "Angled",
    front: "Front",
  },
  configurator: {
    price: "Price",
    print: "Print",
    shippingEstimate: "Shipping estimate",
    supportedOption: "Supported Prodigi Option",
    resolution: "Resolution",
    dimensions: "Dimensions",
    paper: "Paper",
    frameFinish: "Frame Finish",
    mount: "Mount",
    shipTo: "Ship to",
    checkout: "Checkout with Stripe",
    openingCheckout: "Opening Checkout…",
    footnoteDigital: "Secure payment · Download link after fulfillment",
    footnotePhysical:
      "Secure payment · Live Prodigi shipping · Prodigi fulfillment",
    quoteFailed: "Quote failed",
    checkoutFailed: "Checkout failed",
    noMountShape: "This photo's shape doesn't fit this frame without a mount.",
    noMountResolution:
      "This photo's resolution is too low for an unmounted print at this size.",
    mountHelpNone: "Your photo fills the frame edge to edge, with no mount.",
    mountHelpWhite: "The photo sits behind a snow-white mount.",
    apiErrors: {
      "invalid-request": "We could not read that request. Please try again.",
      "unknown-photo": "That photograph is not available.",
      "option-unavailable": "This print option is not available for this photo.",
      "pricing-unavailable":
        "Pricing is temporarily unavailable, please try again.",
      "checkout-unavailable":
        "Checkout is temporarily unavailable, please try again.",
      "service-unconfigured":
        "This service is not available at the moment. Please try again later.",
    },
  },
  contact: {
    eyebrow: "Get in touch",
    title: "Contact the Studio",
    body: "Questions about a print, licensing, or an order? Send a message and I'll reply to you directly.",
    labels: {
      name: "Name",
      email: "Email",
      message: "Message",
    },
    send: "Send Message",
    sending: "Sending…",
    sent: "Thank you — your message has been sent. I'll be in touch soon.",
    unavailable:
      "The contact form is temporarily unavailable. Please try again later.",
    failed: "Sorry, your message could not be sent. Please try again.",
    fieldErrors: {
      "name-required": "Please enter your name.",
      "name-too-long": "That name is too long.",
      "email-required": "Please enter your email address.",
      "email-too-long": "That email address is too long.",
      "email-invalid": "Please enter a valid email address.",
      "message-required": "Please enter a message.",
      "message-too-long": "That message is too long.",
      "turnstile-required": "Please complete the anti-spam check.",
    },
    errors: {
      malformed: "That message could not be read. Please try again.",
      unconfigured:
        "The contact form is temporarily unavailable. Please try again later.",
      invalid: "Please check the highlighted fields.",
      "rate-limited":
        "Too many messages from here. Please try again a little later.",
      rejected:
        "We couldn't verify that you're human. Please refresh the page and try again.",
      "delivery-failed":
        "Sorry, your message could not be sent. Please try again.",
    },
  },
};

const bg: Dictionary = {
  language: {
    label: "Език",
    switchTo: {
      en: "Превключи към английски",
      bg: "Превключи към български",
    },
  },
  notFound: {
    eyebrow: "Страницата не е намерена",
    title: "Тази страница я няма",
    body: "Адресът, който последвахте, не съответства на снимка, галерия или формуляр за контакт. Всичко, което има сайтът, е на едно кликване разстояние.",
    back: "Обратно към галерията",
  },
  nav: {
    main: "Основна навигация",
    openMenu: "Отвори менюто",
    closeMenu: "Затвори менюто",
    contact: "Контакти",
    tagline: "Стария Несебър",
  },
  footer: {
    copyright: "© NESSEBAR LENS • Фотоателие за финиарт в Стария Несебър",
    fulfillment:
      "Глобално изпълнение на поръчките за отпечатки чрез лабораторията на Prodigi",
  },
  home: {
    heroEyebrow: "Избран финиарт",
    heroBody:
      "Три десетилетия крайбрежен свет, ежедневни спомени от улиците и зърното на аналоговия филм в Стария Несебър.",
    preferStory: "Предпочитате разказателната версия?",
    viewConceptB: "Вижте концепция Б",
    explore: "Разгледайте →",
    tileBlurb: {
      "fine-art": "Най-силните кадри от портфолиото",
      archive: "Ежедневни улици и журналистични моменти",
      film: "Снимки на 35 мм филм, направени с моя Nikon F3",
    },
  },
  story: {
    eyebrow: "Визуално наследство",
    title: "Разкази от полуострова на Черно море",
    body: "Спокойна колекция от отпечатки, заснети през десетилетия. Висококачествен финиарт, исторически уличен фоторепортаж и снимки на 35 мм филм, направени с Nikon F3.",
    categoryLabel: "КАТЕГОРИЯ",
    blockBody: {
      "fine-art":
        "Най-силните ми художествени работи. Внимателно композирана архитектура, драматични атмосферни крайбрежни линии и прецизна цветова корекция за музейни giclée отпечатки.",
      archive:
        "Фоторепортажни хроники за ежедневия дух на Несебър — рибари, разплитащи мрежи на разсвет, обущари от есента, сезонни бури и градският живот.",
      film: "Снимки на 35 мм филм, направени с моя Nikon F3, с естественото зърно и характер на Kentmere Pan 100.",
    },
    blockCta: {
      "fine-art": "Разгледайте галерията с финиарт →",
      archive: "Разгледайте архивната галерия →",
      film: "Разгледайте филмовата галерия →",
    },
  },
  gallery: {
    badge: {
      "fine-art": "Подбрано портфолио",
      archive: "Фоторепортаж",
      film: "Аналогов негатив",
    },
    blurb: {
      "fine-art":
        "Кадрите от моята знакова галерия • Музейни giclée отпечатки чрез Prodigi • Достъпни на Hahnemühle Photo Rag",
      archive:
        "Уличен живот, непринудени моменти и исторически ежедневни събития в Стария Несебър",
      film: "Снимки на 35 мм филм, направени с моя Nikon F3 • Kentmere Pan 100",
    },
    empty: "В тази галерия още няма снимки.",
  },
  print: {
    backToGallery: "← Обратно към галерията",
    printOptions: "Опции за отпечатък",
    globalDelivery: "Глобална доставка чрез Prodigi",
    previewView: "Изглед на предварителния преглед",
    angled: "Под ъгъл",
    front: "Отпред",
  },
  configurator: {
    price: "Цена",
    print: "Отпечатък",
    shippingEstimate: "Ориентировъчна доставка",
    supportedOption: "Поддържана опция на Prodigi",
    resolution: "Резолюция",
    dimensions: "Размери",
    paper: "Хартия",
    frameFinish: "Рамка",
    mount: "Паспарту",
    shipTo: "Доставка до",
    checkout: "Плащане през Stripe",
    openingCheckout: "Отваряне на плащането…",
    footnoteDigital: "Сигурно плащане · Линк за изтегляне след изпълнение",
    footnotePhysical:
      "Сигурно плащане · Доставка на живо през Prodigi · Изпълнение от Prodigi",
    quoteFailed: "Запитването за цена не е успешно",
    checkoutFailed: "Плащането не е успешно",
    noMountShape:
      "Формата на тази снимка не се побира в тази рамка без паспарту.",
    noMountResolution:
      "Резолюцията на тази снимка е твърде ниска за отпечатък без паспарту в този размер.",
    mountHelpNone: "Снимката запълва рамката от край до край, без паспарту.",
    mountHelpWhite: "Снимката е зад бяла паспарту.",
    apiErrors: {
      "invalid-request":
        "Заявката не можа да бъде прочетена. Моля, опитайте отново.",
      "unknown-photo": "Тази снимка не е налична.",
      "option-unavailable":
        "Тази опция за отпечатък не е налична за тази снимка.",
      "pricing-unavailable":
        "Ценообразуването е временно недостъпно, моля, опитайте отново.",
      "checkout-unavailable":
        "Плащането е временно недостъпно, моля, опитайте отново.",
      "service-unconfigured":
        "Услугата не е налична в момента. Моля, опитайте по-късно.",
    },
  },
  contact: {
    eyebrow: "Свържете се с нас",
    title: "Контакт с ателието",
    body: "Въпроси за отпечатък, лиценз или поръчка? Изпратете съобщение и ще ви отговоря лично.",
    labels: {
      name: "Име",
      email: "Имейл",
      message: "Съобщение",
    },
    send: "Изпрати съобщение",
    sending: "Изпращане…",
    sent: "Благодаря — съобщението ви е изпратено. Ще се свържа с вас скоро.",
    unavailable:
      "Формулярът за контакт е временно недостъпен. Моля, опитайте по-късно.",
    failed:
      "Съжаляваме, съобщението ви не можа да бъде изпратено. Моля, опитайте отново.",
    fieldErrors: {
      "name-required": "Моля, въведете вашето име.",
      "name-too-long": "Това име е твърде дълго.",
      "email-required": "Моля, въведете вашия имейл адрес.",
      "email-too-long": "Този имейл адрес е твърде дълъг.",
      "email-invalid": "Моля, въведете валиден имейл адрес.",
      "message-required": "Моля, въведете съобщение.",
      "message-too-long": "Това съобщение е твърде дълго.",
      "turnstile-required": "Моля, извършете проверката срещу спам.",
    },
    errors: {
      malformed: "Съобщението не можа да бъде прочетено. Моля, опитайте отново.",
      unconfigured:
        "Формулярът за контакт е временно недостъпен. Моля, опитайте по-късно.",
      invalid: "Моля, проверете отбелязаните полета.",
      "rate-limited":
        "Твърде много съобщения от този адрес. Моля, опитайте малко по-късно.",
      rejected:
        "Не можем да потвърдим, че сте човек. Моля, опреснете страницата и опитайте отново.",
      "delivery-failed":
        "Съжаляваме, съобщението ви не можа да бъде изпратено. Моля, опитайте отново.",
    },
  },
};

/** Every locale's dictionary. The `satisfies` is the missing/extra-key guard. */
export const DICTIONARIES = { en, bg } satisfies Record<Locale, Dictionary>;

/**
 * The dictionary for one locale.
 *
 * Throws for a locale the site does not have rather than returning English.
 * The locale comes from the URL, and a URL that names a language the site has
 * no words for is a 404 — not an English page wearing a Bulgarian URL.
 */
export function getDictionary(locale: Locale): Dictionary {
  const dictionary = DICTIONARIES[locale];
  if (!dictionary) {
    throw new Error(
      `No dictionary for ${locale}. Add one for every locale in LOCALES ` +
        `(${LOCALES.join(", ")}) or the page has nothing to say.`,
    );
  }
  return dictionary;
}

/** The copy a client component takes as a prop, narrowed to what it renders. */
export type ConfiguratorCopy = Dictionary["configurator"];
export type ContactCopy = Dictionary["contact"];
export type NavCopy = Dictionary["nav"];
export type PrintCopy = Dictionary["print"];
export type SwitcherCopy = Dictionary["language"];

/**
 * The header's copy: the nav's own words and the switcher's accessible names.
 *
 * The header is a client component, so it takes the two slices it renders
 * rather than the dictionary — the whole dictionary would carry every locale's
 * copy of every page to every browser.
 */
export type HeaderCopy = { nav: NavCopy; language: SwitcherCopy };

/**
 * The print page's copy: the print's own words and the configurator's.
 */
export type PrintPageCopy = { print: PrintCopy; configurator: ConfiguratorCopy };
