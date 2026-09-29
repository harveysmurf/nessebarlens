import Link from "next/link";
import { WebPhoto } from "@/components/WebPhoto";
import { filmLookClass, getPhoto } from "@/lib/photos";

const CATEGORIES = [
  {
    href: "/fine-art",
    slug: "cobblestones",
    n: "01",
    title: "Fine Art",
    blurb: "Best high-end portfolio gallery captures",
    dark: false,
  },
  {
    href: "/archive",
    slug: "fishermen",
    n: "02",
    title: "Archive",
    blurb: "Everyday street & journalistic moments",
    dark: false,
  },
  {
    href: "/film",
    slug: "windmill",
    n: "03",
    title: "Film Photography",
    blurb: "Authentic 35mm & 120 film stock negatives",
    dark: true,
    contrast: true,
  },
] as const;

export default function HomePage() {
  const hero = getPhoto("dawn")!;

  return (
    <section className="fade-in">
      <div className="max-w-7xl mx-auto px-6 pt-10 pb-16 space-y-16">
        <Link
          href={`/prints/${hero.slug}`}
          className="relative aspect-[21/9] rounded-sm overflow-hidden bg-stone-200 group block"
        >
          <WebPhoto
            slug={hero.slug}
            alt={hero.title}
            preferred={2500}
            priority
            sizes="(max-width: 1280px) 100vw, 1280px"
            className="absolute inset-0 w-full h-full object-cover group-hover:scale-105 transition-transform duration-1000"
          />
          <div className="absolute inset-0 bg-gradient-to-t from-gallery-900/80 via-transparent to-transparent flex items-end p-8 sm:p-12">
            <div className="text-white space-y-1">
              <span className="text-[10px] uppercase tracking-[0.3em] text-amber-200 font-medium">
                Featured Fine Art Print
              </span>
              <h1 className="font-serif text-3xl sm:text-5xl font-light">
                {hero.title}
              </h1>
              <p className="text-xs text-stone-300 font-light max-w-md">
                Limited Medium Format Giclée Capture • Fine Art Collection
              </p>
            </div>
          </div>
        </Link>

        <div className="text-center max-w-2xl mx-auto space-y-3 py-4">
          <p className="font-serif text-2xl sm:text-3xl font-light leading-relaxed text-stone-800 italic">
            &ldquo;Documenting three decades of coastal light, everyday street
            memories, and analog film grain across Old Town Nessebar.&rdquo;
          </p>
          <div className="w-12 h-[1px] bg-stone-300 mx-auto" />
          <p className="text-[10px] uppercase tracking-widest text-stone-400 pt-2">
            Prefer the story layout?{" "}
            <Link href="/story" className="underline hover:text-stone-800">
              View Concept B
            </Link>
          </p>
        </div>

        <div className="grid md:grid-cols-3 gap-8">
          {CATEGORIES.map((cat) => {
            const photo = getPhoto(cat.slug)!;
            return (
              <Link key={cat.href} href={cat.href} className="group space-y-3 block">
                <div
                  className={`aspect-[4/3] overflow-hidden rounded-sm ${
                    cat.dark ? "bg-stone-900" : "bg-stone-200"
                  }`}
                >
                  <WebPhoto
                    slug={photo.slug}
                    alt={cat.title}
                    preferred={1500}
                    sizes="(max-width: 768px) 100vw, 33vw"
                    className={`w-full h-full object-cover group-hover:scale-105 transition-transform duration-700 ${
                      "contrast" in cat && cat.contrast
                        ? filmLookClass("contrast")
                        : ""
                    }`}
                  />
                </div>
                <div className="border-b border-stone-200 pb-3 flex justify-between items-baseline gap-3">
                  <div>
                    <h3 className="font-serif text-xl font-normal">
                      {cat.n}. {cat.title}
                    </h3>
                    <p className="text-[11px] text-stone-500">{cat.blurb}</p>
                  </div>
                  <span className="text-[10px] uppercase tracking-widest text-stone-800 font-medium group-hover:underline shrink-0">
                    Explore →
                  </span>
                </div>
              </Link>
            );
          })}
        </div>
      </div>
    </section>
  );
}
