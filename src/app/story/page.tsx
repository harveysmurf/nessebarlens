import Link from "next/link";
import { WebPhoto } from "@/components/WebPhoto";
import { filmLookClass, getPhoto } from "@/lib/photos";

const BLOCKS = [
  {
    href: "/fine-art",
    slug: "dawn",
    n: "01",
    title: "Fine Art Collection",
    body: "My highest-grade artistic works. Carefully composed architecture, dramatic atmospheric coastlines, and pristine color grading tailored for museum Giclée prints.",
    cta: "Browse Fine Art Gallery →",
    flip: false,
    dark: false,
  },
  {
    href: "/archive",
    slug: "fishermen",
    n: "02",
    title: "Everyday Archive",
    body: "Photojournalistic records of Nessebar's daily soul — fishermen untangling nets at sunrise, autumn cobblers, seasonal storms, and local town life.",
    cta: "Browse Archival Gallery →",
    flip: true,
    dark: false,
  },
  {
    href: "/film",
    slug: "windmill",
    n: "03",
    title: "Film Photography",
    body: "Exclusively analog medium format and 35mm captures. Unfiltered organic grain, authentic light leaks, and Kodak/Ilford film characteristics.",
    cta: "Browse Film Gallery →",
    flip: false,
    dark: true,
    contrast: true,
  },
] as const;

export default function StoryPage() {
  return (
    <section className="fade-in">
      <div className="max-w-5xl mx-auto px-6 py-16 space-y-20">
        <div className="text-center space-y-3 max-w-2xl mx-auto">
          <span className="text-[10px] uppercase tracking-[0.3em] text-stone-400 font-medium">
            Visual Heritage
          </span>
          <h1 className="font-serif text-4xl sm:text-6xl font-light">
            Stories from the Black Sea Peninsula
          </h1>
          <p className="text-stone-600 text-xs font-light leading-relaxed">
            A clean, unhurried collection of prints captured over decades.
            High-resolution medium format, historical street photojournalism, and
            grain-textured analog film negatives.
          </p>
        </div>

        {BLOCKS.map((block, i) => {
          const photo = getPhoto(block.slug)!;
          return (
            <div
              key={block.href}
              className={`grid md:grid-cols-12 gap-8 items-center ${
                i < BLOCKS.length - 1 ? "border-b border-stone-200/80 pb-12" : ""
              }`}
            >
              <div
                className={`md:col-span-7 ${
                  block.flip ? "md:order-2 order-1" : ""
                }`}
              >
                <Link
                  href={block.href}
                  className={`aspect-[3/2] overflow-hidden rounded-sm block ${
                    block.dark ? "bg-stone-900 p-1" : "bg-stone-200"
                  }`}
                >
                  <WebPhoto
                    slug={photo.slug}
                    alt={block.title}
                    preferred={1500}
                    sizes="(max-width: 768px) 100vw, 60vw"
                    className={`w-full h-full object-cover hover:scale-105 transition-transform duration-700 ${
                      "contrast" in block && block.contrast
                        ? filmLookClass("contrast")
                        : ""
                    }`}
                  />
                </Link>
              </div>
              <div
                className={`md:col-span-5 space-y-3 ${
                  block.flip ? "md:order-1 order-2" : ""
                }`}
              >
                <span className="text-[10px] uppercase tracking-widest text-stone-400 font-mono">
                  CATEGORY {block.n}
                </span>
                <h2 className="font-serif text-2xl font-normal">{block.title}</h2>
                <p className="text-xs text-stone-600 leading-relaxed font-light">
                  {block.body}
                </p>
                <Link
                  href={block.href}
                  className="inline-block text-[11px] uppercase tracking-widest text-stone-900 font-medium hover:underline pt-2"
                >
                  {block.cta}
                </Link>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
