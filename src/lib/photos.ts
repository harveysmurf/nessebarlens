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
  /** Film gallery uses dark matte + filter. */
  filmLook?: "contrast" | "sepia" | "grayscale";
};

export const PHOTOS: Photo[] = [
  // —— Fine Art (7) ——
  {
    slug: "dawn",
    title: "Dawn Over Ancient Mesembria",
    category: "fine-art",
    categoryLabel: "Fine Art Collection",
    subtitle: "Medium Format Digital",
    description:
      "Flagship gallery capture at first light over the Byzantine basilica ruins in Old Town Nessebar. Printed on Hahnemühle Photo Rag 308gsm.",
    imageKey: "prints/dawn.jpg",
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
  },
  {
    slug: "harbor-mist",
    title: "Harbor Mist Before Sunrise",
    category: "fine-art",
    categoryLabel: "Fine Art Collection",
    subtitle: "Fine Art Edition",
    description:
      "Soft marine fog lifting off the south harbor, with wooden boats as quiet silhouettes against pale stone.",
    imageKey: "prints/harbor-mist.jpg",
  },
  {
    slug: "chapel-light",
    title: "Chapel Light Through Arches",
    category: "fine-art",
    categoryLabel: "Fine Art Collection",
    subtitle: "Architectural Study",
    description:
      "A quiet beam of afternoon light cutting through the arches of a small Old Town chapel.",
    imageKey: "prints/chapel-light.jpg",
  },
  {
    slug: "stone-arch",
    title: "Stone Arch Toward the Sea",
    category: "fine-art",
    categoryLabel: "Fine Art Collection",
    subtitle: "Medium Format Digital",
    description:
      "Framed view through a medieval stone arch opening onto the Black Sea horizon.",
    imageKey: "prints/stone-arch.jpg",
  },
  {
    slug: "evening-wall",
    title: "Evening Wall on the Peninsula",
    category: "fine-art",
    categoryLabel: "Fine Art Collection",
    subtitle: "Golden Hour Edition",
    description:
      "Warm last light on the weathered fortress wall where the peninsula meets open water.",
    imageKey: "prints/evening-wall.jpg",
  },
  // —— Archive (7) ——
  {
    slug: "fishermen",
    title: "Fishermen at South Port",
    category: "archive",
    categoryLabel: "Everyday Archive • Photojournalism",
    subtitle: "Documentary Series • 2018",
    description:
      "Documentary street record of traditional Bulgarian fishermen untangling nets in Old Nessebar harbor.",
    imageKey: "prints/fishermen.jpg",
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
  },
  {
    slug: "market-day",
    title: "Market Day on the Causeway",
    category: "archive",
    categoryLabel: "Everyday Archive • Photojournalism",
    subtitle: "Documentary Series • 2019",
    description:
      "Vendors and locals crossing the isthmus with baskets on a busy Saturday morning.",
    imageKey: "prints/market-day.jpg",
  },
  {
    slug: "net-menders",
    title: "Net Menders at Low Tide",
    category: "archive",
    categoryLabel: "Everyday Archive • Photojournalism",
    subtitle: "Archival Record • 2017",
    description:
      "Two fishermen repairing blue nets on the rocks as the tide pulls back from the south shore.",
    imageKey: "prints/net-menders.jpg",
  },
  {
    slug: "winter-pier",
    title: "Winter Pier Empty",
    category: "archive",
    categoryLabel: "Everyday Archive • Photojournalism",
    subtitle: "Candid Journalistic • 2020",
    description:
      "An emptied wooden pier in January wind — tourist season gone, town kept by those who stay.",
    imageKey: "prints/winter-pier.jpg",
  },
  {
    slug: "alley-cat",
    title: "Alley Cat Near the Fortress",
    category: "archive",
    categoryLabel: "Everyday Archive • Photojournalism",
    subtitle: "Street Record • 2022",
    description:
      "A local cat claiming the warmest patch of stone in a narrow Old Town alley.",
    imageKey: "prints/alley-cat.jpg",
  },
  // —— Film (6) ——
  {
    slug: "windmill",
    title: "The Old Windmill",
    category: "film",
    categoryLabel: "Film Photography • Kodak Tri-X 400",
    subtitle: "Leica M3 • Kodak Tri-X 400",
    description:
      "Captured on 35mm monochrome analog film. Raw grain and authentic silver halide tone curves.",
    imageKey: "prints/windmill.jpg",
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
    filmLook: "grayscale",
  },
  {
    slug: "boat-hull",
    title: "Painted Boat Hull",
    category: "film",
    categoryLabel: "Film Photography • Portra 160",
    subtitle: "Nikon FM2 • Portra 160",
    description:
      "Close study of peeling blue paint on a fishing boat hull — analog color and soft grain.",
    imageKey: "prints/boat-hull.jpg",
    filmLook: "sepia",
  },
  {
    slug: "shadow-street",
    title: "Shadow Street at Noon",
    category: "film",
    categoryLabel: "Film Photography • Kodak Tri-X 400",
    subtitle: "Leica M6 • Kodak Tri-X 400",
    description:
      "Hard noon shadows slicing a quiet residential street in the old quarter.",
    imageKey: "prints/shadow-street.jpg",
    filmLook: "contrast",
  },
  {
    slug: "salt-air",
    title: "Salt Air on the Ramparts",
    category: "film",
    categoryLabel: "Film Photography • Ilford Delta 400",
    subtitle: "Pentax K1000 • Ilford Delta 400",
    description:
      "Wind and spray along the northern ramparts — high-key sky and textured stone.",
    imageKey: "prints/salt-air.jpg",
    filmLook: "grayscale",
  },
];

export function getPhoto(slug: string): Photo | undefined {
  return PHOTOS.find((p) => p.slug === slug);
}

export function photosByCategory(category: PhotoCategory): Photo[] {
  return PHOTOS.filter((p) => p.category === category);
}

// A Record rather than a switch: a switch falls off the end when a category
// is added, so a new one would type-check and render href={undefined}.
const CATEGORY_HREF: Record<PhotoCategory, string> = {
  "fine-art": "/fine-art",
  archive: "/archive",
  film: "/film",
};

export function categoryHref(category: PhotoCategory): string {
  return CATEGORY_HREF[category];
}

// The one place a film look is written as a CSS class. This string was
// hand-rolled in every page and component that renders a film photo, and the
// copies only stayed identical by luck — a rename here would have left the
// others rendering an unfiltered image with no test failing.
const FILM_LOOK_CLASS: Record<NonNullable<Photo["filmLook"]>, string> = {
  contrast: "filter contrast-125",
  sepia: "filter sepia",
  grayscale: "filter grayscale",
};

export function filmLookClass(look: Photo["filmLook"]): string {
  return look ? FILM_LOOK_CLASS[look] : "";
}
