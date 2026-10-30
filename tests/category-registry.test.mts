/**
 * The category registry (#421).
 *
 * The three categories used to be enumerated in six places that disagreed:
 * `CATEGORY_LABEL` and `CATEGORY_HREF` in `photos.ts`, `NAV` in `nav.ts`,
 * `META` in `GalleryPage.tsx`, `CATEGORIES` on the home page, `BLOCKS` on
 * /story, and the header tagline's JSX text in `SiteHeader` *and* `MobileNav`.
 * `fine-art` rendered as three different names depending on where you stood.
 * They are one `Record` now.
 *
 * Four things need holding, and each is pinned the way it can actually break:
 *
 * - **exhaustiveness is a compile error, not a convention** — proven by
 *   compiling a probe that widens the category union to four and watching it
 *   fail, not by a regex saying `Record<PhotoCategory`;
 * - **the per-surface escape hatch is still a `Record`, not an array** — proven
 *   from the type the compiler actually inferred, with a negative control that
 *   a hand-typed array of three is rejected, because a file can contain the
 *   token `Record<PhotoCategory,` and still key its tiles positionally;
 * - **no page or component spells a category** — proven by reading literals out
 *   of the AST, both `StringLiteral` and `JsxText`, so a comment quoting "Fine
 *   Art Collection" cannot satisfy the check and satisfy the drift at once. The
 *   honest limit: a literal must *be* a name to be caught. Prose that merely
 *   mentions one ("Browse Fine Art Gallery →") is per-surface copy, which #421
 *   keeps at the call site, so matching substrings would be wrong here;
 * - **the wording is a decision** — the rendered names are asserted against
 *   literals, and which surfaces currently happen to agree is pinned too, so a
 *   copy change says which pair it split rather than silently splitting it.
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";

import { CATEGORY, categoryTagline } from "../src/domain/catalog/categories.ts";
import type { CategoryNames } from "../src/domain/catalog/categories.ts";
import { PHOTOS } from "../src/domain/catalog/photos.ts";
import { PHOTO_CATEGORIES, type PhotoCategory } from "../src/domain/catalog/photo-schema.ts";
import { navFor } from "../src/components/nav.ts";
import { GalleryPage } from "../src/components/GalleryPage.tsx";
import { getDictionary } from "../src/components/i18n/dictionaries.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const TSCONFIG = path.join(ROOT, "tsconfig.json");

/** Every path under `src/`, generated output excluded — that is build output. */
function srcFiles(dir = path.join(ROOT, "src")): string[] {
  const found: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "generated") continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) found.push(...srcFiles(full));
    else if (/\.[cm]?tsx?$/.test(name)) found.push(full);
  }
  return found;
}

/** The project's own compiler options, so a probe resolves `@/` like src/ does. */
function projectOptions(): ts.CompilerOptions {
  const parsed = ts.getParsedCommandLineOfConfigFile(
    TSCONFIG,
    {},
    {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: (d) => {
        throw new Error(ts.flattenDiagnosticMessageText(d.messageText, " "));
      },
    },
  );
  assert.ok(parsed, "tsconfig.json must parse");
  return { ...parsed.options, noEmit: true, incremental: false, plugins: [] };
}

/**
 * A program over `files`, with `virtual` (a `src/` path) optionally backed by
 * `source` instead of the filesystem. The path is inside `src/` so `baseUrl` and
 * the path aliases resolve for it exactly as they do for real code.
 */
function programWith(files: string[], virtual?: [string, string]) {
  const options = projectOptions();
  const host = ts.createCompilerHost(options, true);
  const readFile = host.readFile.bind(host);
  const fileExists = host.fileExists.bind(host);
  const getSourceFile = host.getSourceFile.bind(host);
  if (virtual) {
    const [name, source] = virtual;
    host.fileExists = (candidate) => candidate === name || fileExists(candidate);
    host.readFile = (candidate) => (candidate === name ? source : readFile(candidate));
    host.getSourceFile = (candidate, lang, onError, shouldCreate) =>
      candidate === name
        ? ts.createSourceFile(candidate, source, lang, true)
        : getSourceFile(candidate, lang, onError, shouldCreate);
  }
  return ts.createProgram(files, options, host);
}

/** What the compiler inferred for a module-local `const`, or undefined. */
function inferredTypeOfConst(
  program: ts.Program,
  fileName: string,
  name: string,
): ts.Type | undefined {
  const source = program.getSourceFile(fileName);
  const checker = program.getTypeChecker();
  if (!source) return undefined;
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.name.text === name) {
        return checker.getTypeAtLocation(declaration.name);
      }
    }
  }
  return undefined;
}

test("the registry is a Record over every category, so a fourth is a compile error", () => {
  // A widened union is assigned CATEGORY. With three keys against four members
  // the compiler reports the missing property; with the real union it is clean.
  // A comment or a comment-satisfiable regex could not tell those apart.
  const probe = (members: string) => {
    // Extensionless, matching how the rest of src/ imports it — `bundler`
    // resolution, and no dependency on allowImportingTsExtensions.
    const specifier = JSON.stringify(path.join(ROOT, "src/domain/catalog/categories"));
    return `
import { CATEGORY } from ${specifier};
import type { CategoryFacts } from ${specifier};
type Widened = ${members};
export const widened: Record<Widened, CategoryFacts> = CATEGORY;
`;
  };

  const compile = (source: string) => {
    const virtual = path.join(ROOT, "src", "category-exhaustiveness.probe.ts");
    const program = programWith([virtual], [virtual, source]);
    return ts
      .getPreEmitDiagnostics(program)
      .filter((d) => d.file?.fileName === virtual)
      .map((d) => ts.flattenDiagnosticMessageText(d.messageText, " "));
  };

  assert.deepEqual(
    compile(probe('"fine-art" | "archive" | "film"')),
    [],
    "the real category union must compile against the registry",
  );

  const widened = compile(probe('"fine-art" | "archive" | "film" | "experimental"'));
  assert.ok(
    widened.some((m) => m.includes("experimental")),
    `a fourth category must not typecheck, got: ${JSON.stringify(widened)}`,
  );
});

test("each surface's own copy is keyed by category, as the compiler sees it", () => {
  // The point is what the compiler inferred for the table, not that the token
  // `Record<PhotoCategory` appears somewhere in the file: a positional array of
  // three renders two tiles when a category is added, and no type error. So
  // this reads the inferred type — a `Record` is a non-tuple object with a
  // property per category — rather than grepping the source.
  //
  // The tables live in the dictionary now: the gallery's badge and blurb, the
  // home tile's blurb and the /story block's body and call to action are all
  // copy, and the dictionary is where copy lives.
  const DICTIONARIES = path.join(ROOT, "src/components/i18n/dictionaries.ts");
  const TABLES: [string, string, string][] = [
    ["home", "tileBlurb", "the home tile's blurb"],
    ["gallery", "badge", "the gallery's badge"],
    ["gallery", "blurb", "the gallery's blurb"],
    ["story", "blockBody", "the /story block's body"],
    ["story", "blockCta", "the /story block's call to action"],
  ];

  const program = programWith([DICTIONARIES]);
  const checker = program.getTypeChecker();

  /** The type of `en.<namespace>.<table>`, read from the compiler. */
  const tableType = (namespace: string, table: string): ts.Type | undefined => {
    const dictionary = inferredTypeOfConst(program, DICTIONARIES, "en");
    if (!dictionary) return undefined;
    const space = checker.getPropertyOfType(dictionary, namespace);
    if (!space) return undefined;
    const spaceType = checker.getTypeOfSymbolAtLocation(space, space.valueDeclaration!);
    const property = checker.getPropertyOfType(spaceType, table);
    if (!property) return undefined;
    return checker.getTypeOfSymbolAtLocation(property, property.valueDeclaration!);
  };

  const isCategoryKeyed = (type: ts.Type | undefined) => {
    if (!type || !(type.flags & ts.TypeFlags.Object)) return false;
    if ((type as ts.ObjectType).objectFlags & ts.ObjectFlags.Tuple) return false;
    const keys = type.getProperties().map((p) => p.name);
    return PHOTO_CATEGORIES.every((category) => keys.includes(category));
  };

  for (const [namespace, table, what] of TABLES) {
    assert.ok(
      isCategoryKeyed(tableType(namespace, table)),
      `${namespace}.${table} (${what}) must be keyed by every category, not a tuple`,
    );
  }

  // Negative control. An array of three, with the `Record` token present as a
  // decoy, is exactly what the regex version of this assertion accepted.
  const decoy = path.join(ROOT, "src/per-surface.probe.ts");
  const decoySource = `
import type { PhotoCategory } from "./domain/catalog/photo-schema";
type Unused = Record<PhotoCategory, string>;
export const positional = [
  { title: "Fine Art" },
  { title: "Archive" },
  { title: "Film Photography" },
] as const;
`;
  assert.equal(
    isCategoryKeyed(
      inferredTypeOfConst(
        programWith([decoy], [decoy, decoySource]),
        decoy,
        "positional",
      ),
    ),
    false,
    "a positional array of three must be rejected, decoy token or not",
  );
});

test("neither page hand-numbers itself any more", () => {
  // The "01" came from `PHOTO_CATEGORIES`' position, because typing it meant
  // editing two files in step to keep the homepage and /story in step.
  for (const rel of ["src/app/[locale]/page.tsx", "src/app/[locale]/story/page.tsx"]) {
    const text = readFileSync(path.join(ROOT, rel), "utf8");
    assert.doesNotMatch(text, /n:\s*"0\d"/, `${rel} still types its own "01"`);
  }
});

test("no page or component spells a category, an href, or a name", () => {
  const NAMES = new Set<string>();
  const HREFS = new Set<string>();
  for (const facts of Object.values(CATEGORY)) {
    for (const field of Object.values(facts.names.en)) {
      NAMES.add(field);
    }
    HREFS.add(facts.href);
  }
  const SLUGS = new Set<string>(PHOTO_CATEGORIES);

  // Route pages pass the category to GalleryPage; that is the route, not a table.
  // The pages live under the locale segment, so the route is `/<locale>/<slug>`.
  const ROUTE_PAGES = new Set(
    PHOTO_CATEGORIES.map((c) =>
      path.join(ROOT, "src/app/[locale]", c, "page.tsx"),
    ),
  );

  // An explicit list, not a `src/domain/` prefix. A prefix would wave through a
  // new domain file holding a second name table, which is the exact drift this
  // test exists to catch:
  //   - `categories.ts` declares the facts, so it spells them by definition;
  //   - `photo-schema.ts` owns the slugs, in display order;
  //   - `photos.ts:90` compares a photo's category to `fine-art` to pick a
  //     featured fallback — a preference, not a table of names.
  const DECLARES = new Set(
    ["categories.ts", "photo-schema.ts", "photos.ts"].map((name) =>
      path.join(ROOT, "src/domain/catalog", name),
    ),
  );

  // The legacy redirect table spells the old URLs by definition. It is a frozen
  // record of the paths the site published before the locale segment — a
  // category added tomorrow never had a legacy URL to redirect from — so it
  // names the routes without owning them, and it is named here rather than
  // waved through by a directory prefix.
  const FROZEN_LEGACY_ROUTES = path.join(
    ROOT,
    "src/infrastructure/routing/legacy-redirects.ts",
  );

  // JSX text is not a string literal — it is `JsxText`, and it is how a React
  // component spells visible text, so both are visited. React splits a line
  // into several nodes around `{…}`; whitespace is normalised so a multi-line
  // `<span>` matches the same name as a one-line one.
  const normalize = (text: string) => text.replace(/\s+/g, " ").trim();

  const offenders: string[] = [];
  for (const file of srcFiles()) {
    const text = readFileSync(file, "utf8");
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.ESNext, true);
    const rel = path.relative(ROOT, file);

    const visit = (node: ts.Node) => {
      let value: string | undefined;
      let isKey = false;

      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
        value = node.text;
        // Property *names* are keys, not statements: META["fine-art"].badgeClass
        // is per-surface copy keyed by category, which #421 allows. Only a value
        // spelling is a second table.
        isKey =
          (ts.isPropertyAssignment(node.parent) &&
            node.parent.name === node &&
            !ts.isComputedPropertyName(node.parent.name)) ||
          (ts.isPropertySignature(node.parent) && node.parent.name === node);
      } else if (ts.isJsxText(node)) {
        value = normalize(node.text);
      }

      if (
        value &&
        !isKey &&
        !DECLARES.has(file) &&
        file !== FROZEN_LEGACY_ROUTES &&
        value !== ""
      ) {
        if (NAMES.has(value) || HREFS.has(value)) {
          offenders.push(`${rel}: ${JSON.stringify(value)}`);
        } else if (SLUGS.has(value) && !ROUTE_PAGES.has(file)) {
          offenders.push(`${rel}: ${JSON.stringify(value)}`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }

  assert.deepEqual(offenders, [], "category facts are declared in categories.ts only");
});

test("the nav takes its labels from the registry", () => {
  for (const locale of ["en", "bg"] as const) {
    const nav = navFor(locale, "Contact");
    for (const category of PHOTO_CATEGORIES) {
      const link = nav.find((item) => item.href === CATEGORY[category].href);
      assert.ok(link, `${category} is in the nav`);
      assert.equal(link.label, CATEGORY[category].names[locale].navLabel, category);
    }
    // Contact is not a category; it is still spelled by the caller, because the
    // dictionary is the server's and the nav is the client's.
    assert.equal(nav.at(-1)?.href, "/contact");
  }
});

test("the header tagline lists every category, from the registry", () => {
  // It was JSX text in SiteHeader and again in MobileNav, which is why it is
  // the one thing here that was never a `Record` and never a compile error.
  assert.equal(categoryTagline("en"), "Fine Art, Archive & Film");
  // The Bulgarian list joins with "и", not "&": the joiner is part of the
  // localized names, and a header that says "Художествена фотография, Архив и Аналогова фотография" is a
  // sentence in the wrong language.
  assert.equal(categoryTagline("bg"), "Художествена фотография, Архив и Аналогова фотография");
  for (const category of PHOTO_CATEGORIES) {
    assert.ok(
      categoryTagline("en").includes(CATEGORY[category].names.en.taglineName),
      `${category} appears in the tagline`,
    );
  }
  for (const rel of ["src/components/SiteHeader.tsx", "src/components/MobileNav.tsx"]) {
    const text = readFileSync(path.join(ROOT, rel), "utf8");
    assert.match(text, /categoryTagline/, `${rel} renders the derived tagline`);
    assert.doesNotMatch(
      text,
      /Old Town Nessebar •[^<{]*\b(?:Fine Art|Archive|Film)\b/,
      `${rel} still types its own category list`,
    );
  }
});

/**
 * The English names, written out.
 *
 * Not `photo.categoryLabel === categoryLabel(photo.category)` — photos.ts
 * derives the first from the second, so that holds by construction and would
 * have stayed green while a print page rendered the wrong line. The wording is
 * what needs pinning, so it is written here.
 */
const EXPECTED: Record<PhotoCategory, CategoryNames> = {
  "fine-art": {
    navLabel: "Fine Art",
    galleryTitle: "Fine Art Photography",
    homeTitle: "Fine Art",
    storyTitle: "Fine Art Collection",
    taglineName: "Fine Art",
    printLabel: "Fine Art Collection",
  },
  archive: {
    navLabel: "Archive",
    galleryTitle: "Everyday Archive",
    homeTitle: "Archive",
    storyTitle: "Everyday Archive",
    taglineName: "Archive",
    printLabel: "Everyday Archive • Photojournalism",
  },
  film: {
    navLabel: "Film Photography",
    galleryTitle: "Film Photography",
    homeTitle: "Film Photography",
    storyTitle: "Film Photography",
    taglineName: "Film",
    printLabel: "Film Photography",
  },
};

test("the names the UI renders, written out", () => {
  for (const category of PHOTO_CATEGORIES) {
    assert.deepEqual(
      CATEGORY[category].names.en,
      EXPECTED[category],
      `${category}'s names are a decision; changing one is a copy change`,
    );
    for (const photo of PHOTOS.filter((p) => p.category === category)) {
      assert.equal(photo.categoryLabel, EXPECTED[category].printLabel, photo.slug);
    }
  }
});

test("the Bulgarian names are written out too, and they are Bulgarian", () => {
  // The English names are a copy decision; so are the Bulgarian ones, and a
  // translation that silently drifted would leave the Bulgarian site naming a
  // gallery something the English one does not.
  const EXPECTED_BG: Record<PhotoCategory, CategoryNames> = {
    "fine-art": {
      navLabel: "Художествена фотография",
      galleryTitle: "Художествена фотография",
      homeTitle: "Художествена фотография",
      storyTitle: "Колекция художествени фотографии",
      taglineName: "Художествена фотография",
      printLabel: "Художествена фотография",
    },
    archive: {
      navLabel: "Архив",
      galleryTitle: "Архив на ежедневието",
      homeTitle: "Архив",
      storyTitle: "Архив на ежедневието",
      taglineName: "Архив",
      printLabel: "Архив на ежедневието · Документална фотография",
    },
    film: {
      navLabel: "Аналогова фотография",
      galleryTitle: "Аналогова фотография",
      homeTitle: "Аналогова фотография",
      storyTitle: "Аналогова фотография",
      taglineName: "Аналогова фотография",
      printLabel: "Аналогова фотография",
    },
  };
  for (const category of PHOTO_CATEGORIES) {
    assert.deepEqual(
      CATEGORY[category].names.bg,
      EXPECTED_BG[category],
      `${category}'s Bulgarian names are a decision; changing one is a copy change`,
    );
    // And the Bulgarian name is not the English one: a locale that fell back
    // would be a page in the wrong language wearing a URL that says otherwise.
    for (const [field, value] of Object.entries(EXPECTED_BG[category])) {
      assert.notEqual(
        value,
        EXPECTED[category][field as keyof CategoryNames],
        `${category}.${field} is the same in both languages`,
      );
    }
  }
});

test("the gallery heading is the registry's galleryTitle", () => {
  for (const category of PHOTO_CATEGORIES) {
    const html = renderToStaticMarkup(
      createElement(GalleryPage, {
        category,
        locale: "en",
        copy: getDictionary("en").gallery,
        printOptions: getDictionary("en").print.printOptions,
      }),
    );
    assert.ok(
      html.includes(`>${CATEGORY[category].names.en.galleryTitle}<`),
      `${category} gallery should head with ${CATEGORY[category].names.en.galleryTitle}`,
    );
  }
});

test("which surfaces agree today is a fact, not an accident", () => {
  // #421 declared the differences rather than converging them, which means some
  // pairs still say the same thing. These are the pairs, written out rather
  // than computed, so that editing one field and watching another surface change
  // is a choice somebody made — and so a genuine convergence is a one-line
  // change to this table on purpose.
  const AGREES: Record<PhotoCategory, Record<string, boolean>> = {
    "fine-art": {
      "navLabel=homeTitle": true,
      "navLabel=taglineName": true,
      "galleryTitle=storyTitle": false,
      "storyTitle=printLabel": true,
    },
    archive: {
      "navLabel=homeTitle": true,
      "navLabel=taglineName": true,
      "galleryTitle=storyTitle": true,
      "storyTitle=printLabel": false,
    },
    film: {
      "navLabel=homeTitle": true,
      "navLabel=taglineName": false,
      "galleryTitle=storyTitle": true,
      "storyTitle=printLabel": true,
    },
  };
  const PAIRS: [keyof CategoryNames, keyof CategoryNames][] = [
    ["navLabel", "homeTitle"],
    ["navLabel", "taglineName"],
    ["galleryTitle", "storyTitle"],
    ["storyTitle", "printLabel"],
  ];
  for (const category of PHOTO_CATEGORIES) {
    const facts = CATEGORY[category].names.en;
    for (const [a, b] of PAIRS) {
      assert.equal(
        facts[a] === facts[b],
        AGREES[category][`${a}=${b}`],
        `${category}: do ${a} and ${b} still say the same thing?`,
      );
    }
  }
});

test("every category's facts are non-empty and its href is its route", () => {
  for (const category of PHOTO_CATEGORIES) {
    const facts = CATEGORY[category];
    assert.match(facts.href, /^\/[a-z-]+$/, category);
    for (const locale of ["en", "bg"] as const) {
      for (const [field, value] of Object.entries(facts.names[locale])) {
        assert.equal(typeof value, "string", `${category}.${locale}.${field}`);
        assert.ok(value.trim().length > 0, `${category}.${locale}.${field} is empty`);
      }
    }
    assert.equal(
      facts.href,
      `/${category}`,
      "a category's route is its slug; a different route is a decision, not a default",
    );
  }
});
