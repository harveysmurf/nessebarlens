export type PhotoCategory = "fine-art" | "archive" | "film";

export type Photo = {
  slug: string;
  title: string;
  category: PhotoCategory;
  categoryLabel: string;
  subtitle: string;
  description: string;
  /** Private master object key in MASTERS — never used in gallery UI. */
  imageKey: string;
  fromPriceEur: number;
  /** Film gallery uses dark matte + filter. */
  filmLook?: "contrast" | "sepia" | "grayscale";
};

export const PHOTOS: Photo[] = [
  {
    slug: "dawn",
    title: "Dawn Over Ancient Mesembria",
    category: "fine-art",
    categoryLabel: "Fine Art Collection",
    subtitle: "Medium Format Digital",
    description:
      "Flagship gallery capture at first light over the Byzantine basilica ruins in Old Town Nessebar. Printed on Hahnemühle Photo Rag 308gsm.",
    imageKey: "prints/dawn.jpg",
    fromPriceEur: 45,
  },
  {
    slug: "cobblestones",
    title: "Cobblestones in Morning Light",
    category: "fine-art",
    categoryLabel: "Fine Art Collection",
    subtitle: "Fine Art Edition",
    description:
      "High-resolution architectural composition showcasing Nessebar's 19th-century wooden and stone revival homes.",
    imageKey: "prints/cobblestones.jpg",
    fromPriceEur: 40,
  },
  {
    slug: "isthmus",
    title: "Isthmus Causeway at Dusk",
    category: "fine-art",
    categoryLabel: "Fine Art Collection",
    subtitle: "Long Exposure Fine Art",
    description:
      "Long-exposure fine art photograph capturing the sea movement along the narrow road connecting the mainland.",
    imageKey: "prints/isthmus.jpg",
    fromPriceEur: 50,
  },
  {
    slug: "fishermen",
    title: "Fishermen at South Port",
    category: "archive",
    categoryLabel: "Everyday Archive • Photojournalism",
    subtitle: "Documentary Series • 2018",
    description:
      "Documentary street record of traditional Bulgarian fishermen untangling nets in Old Nessebar harbor.",
    imageKey: "prints/fishermen.jpg",
    fromPriceEur: 32,
  },
  {
    slug: "autumn",
    title: "Autumn Harbor Storm",
    category: "archive",
    categoryLabel: "Everyday Archive • Photojournalism",
    subtitle: "Archival Record • 2015",
    description:
      "Journalistic capture of high waves crashing against the wooden pier during an October Black Sea gale.",
    imageKey: "prints/autumn.jpg",
    fromPriceEur: 35,
  },
  {
    slug: "craftsman",
    title: "Street Craftsman in Alley",
    category: "archive",
    categoryLabel: "Everyday Archive • Photojournalism",
    subtitle: "Candid Journalistic • 2021",
    description:
      "Candid archival portrait of an old cobbler working outside his workshop in the heart of Old Town.",
    imageKey: "prints/craftsman.jpg",
    fromPriceEur: 30,
  },
  {
    slug: "windmill",
    title: "The Old Windmill",
    category: "film",
    categoryLabel: "Film Photography • Kodak Tri-X 400",
    subtitle: "Leica M3 • Kodak Tri-X 400",
    description:
      "Captured on 35mm monochrome analog film. Raw grain and authentic silver halide tone curves.",
    imageKey: "prints/windmill.jpg",
    fromPriceEur: 38,
    filmLook: "contrast",
  },
  {
    slug: "fortress",
    title: "Fortress Wall Gate",
    category: "film",
    categoryLabel: "Film Photography • Portra 400",
    subtitle: "Hasselblad 500C • Portra 400",
    description:
      "Medium format 120 film slide capture using Hasselblad 500C. Warm analog tones and organic light bloom.",
    imageKey: "prints/fortress.jpg",
    fromPriceEur: 42,
    filmLook: "sepia",
  },
  {
    slug: "seagulls",
    title: "Seagulls Over North Bay",
    category: "film",
    categoryLabel: "Film Photography • Ilford HP5 400",
    subtitle: "Canon AE-1 • Ilford HP5 400",
    description:
      "Grain-textured 35mm black and white negative capture of seagulls soaring over the northern rocks.",
    imageKey: "prints/seagulls.jpg",
    fromPriceEur: 35,
    filmLook: "grayscale",
  },
];

export function getPhoto(slug: string): Photo | undefined {
  return PHOTOS.find((p) => p.slug === slug);
}

export function photosByCategory(category: PhotoCategory): Photo[] {
  return PHOTOS.filter((p) => p.category === category);
}

export function categoryHref(category: PhotoCategory): string {
  switch (category) {
    case "fine-art":
      return "/fine-art";
    case "archive":
      return "/archive";
    case "film":
      return "/film";
  }
}
