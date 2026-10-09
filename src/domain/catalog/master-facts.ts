/**
 * The master's oriented pixel size and its orientation (#295).
 *
 * These are facts about the file, measured once when it is published and never
 * typed by hand. Later work (#299) computes a print's effective PPI from them,
 * so this module stays pure: it knows a width, a height, and the three
 * orientation words, and nothing about sharp, S3 or the catalog.
 *
 * `masterDimensions()` in `scripts/derivative-image.mjs` already applies EXIF
 * orientation 5-8 by swapping the axes, so the numbers this module sees are the
 * pixels as the viewer sees them, and the orientation word is simply the
 * longer edge.
 */

export const ORIENTATIONS = ["landscape", "portrait", "square"] as const;
export type Orientation = (typeof ORIENTATIONS)[number];

export type MasterFacts = {
  width: number;
  height: number;
  orientation: Orientation;
};

/**
 * Why a set of master facts was refused, as a closed set of domain reasons.
 * The caller maps these to its own wording; the parser does not own message
 * prose.
 */
export type MasterFactsReason =
  | "not-positive-integer"
  | "unknown-orientation"
  | "orientation-mismatch";

export type MasterFactsResult =
  | { ok: true; facts: MasterFacts }
  | { ok: false; reason: MasterFactsReason };

/** The raw values as they arrive from an untrusted file, before validation. */
export type MasterFactsInput = {
  width: unknown;
  height: unknown;
  orientation: unknown;
};

/**
 * The largest aspect ratio still called square. A 1% tolerance absorbs the odd
 * pixel a camera or a rounding step can leave on an otherwise square capture,
 * so a 4901×4851 frame is "square" rather than a near-miss portrait.
 */
const SQUARE_TOLERANCE = 1.01;

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isOrientation(value: unknown): value is Orientation {
  return ORIENTATIONS.includes(value as Orientation);
}

/**
 * The orientation implied by a pixel size. Square wins inside the tolerance;
 * otherwise the longer edge decides, so every positive size maps to exactly one
 * word.
 */
export function orientationOf(width: number, height: number): Orientation {
  const long = Math.max(width, height);
  const short = Math.min(width, height);
  if (short > 0 && long / short <= SQUARE_TOLERANCE) return "square";
  return width > height ? "landscape" : "portrait";
}

/**
 * Validate the three raw values together. The order of the checks is the order
 * of least surprise: an absent or nonsensical size is reported before its
 * orientation, and a well-formed orientation that disagrees with the size is
 * `orientation-mismatch` rather than silently corrected. The facts written and
 * the facts checked are therefore the same values.
 */
export function parseMasterFacts(raw: MasterFactsInput): MasterFactsResult {
  const { width, height, orientation } = raw;

  if (!isPositiveInteger(width) || !isPositiveInteger(height)) {
    return { ok: false, reason: "not-positive-integer" };
  }

  if (!isOrientation(orientation)) {
    return { ok: false, reason: "unknown-orientation" };
  }

  if (orientationOf(width, height) !== orientation) {
    return { ok: false, reason: "orientation-mismatch" };
  }

  return { ok: true, facts: { width, height, orientation } };
}
