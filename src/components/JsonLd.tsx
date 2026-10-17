import { serializeJsonLd } from "@/infrastructure/seo/json-ld";

/**
 * The tag. Everything interesting is in `infrastructure/seo/json-ld.ts` — this
 * exists so a page writes `<JsonLd data={sitewideJsonLd()} />` and does not
 * repeat the escaping at four call sites.
 *
 * `next/script` would be the wrong element: it is for loading and executing
 * JavaScript, and JSON-LD is data a crawler reads. The Next guide is explicit
 * that a plain `<script type="application/ld+json">` is correct here.
 */
export function JsonLd({
  data,
}: {
  data: Parameters<typeof serializeJsonLd>[0];
}) {
  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: serializeJsonLd(data) }}
    />
  );
}