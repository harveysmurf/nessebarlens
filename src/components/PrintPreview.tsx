"use client";

/**
 * The live product preview (#326): what the buyer receives for the selected
 * format, size and frame, drawn in CSS from the geometry `previewGeometry`
 * computes. There is no per-photo mockup file, no WebGL and no new dependency;
 * the image is the existing web derivative, positioned and cropped.
 *
 * The component does no millimetre maths: every rectangle from the domain is
 * turned into a CSS percentage by `percentRect`, so the same geometry drives
 * the unit tests and the pixels.
 */
import type { CSSProperties, ReactNode } from "react";
import type { MasterFacts } from "@/domain/catalog/master-facts";
import type { FrameFinish, PrintSize } from "@/domain/pricing/pricing";
import {
  percentRect,
  type Extent,
  type PreviewGeometry,
  type Rect,
} from "@/domain/ordering/print-preview";
import type { GalleryImage } from "@/infrastructure/media/gallery-image";
import { PictureImg } from "./PictureImg";
import {
  CANVAS_EDGE_SHADOW,
  CANVAS_WEAVE,
  FRAME_BASE,
  FRAME_GRAIN_STOPS,
  FRAME_LIGHT,
  FRAME_PROFILE,
  MOUNT_BACKGROUND,
  PRODUCT_SHADOW,
  STAGE_BACKGROUND,
} from "./print-preview-style";

type PhysicalGeometry = Exclude<PreviewGeometry, { kind: "digital" }>;
type Side = "top" | "right" | "bottom" | "left";

const FULL: CSSProperties = { left: "0%", top: "0%", width: "100%", height: "100%" };
const SIZES = "(max-width: 1024px) 100vw, 60vw";

export function PrintPreview({
  geometry,
  image,
  alt,
  label,
  filmLookClassName,
  master,
  size,
}: {
  geometry: PreviewGeometry;
  image: GalleryImage | null;
  alt: string;
  label: string;
  filmLookClassName: string;
  master: MasterFacts;
  size?: PrintSize;
}) {
  return (
    <div
      role="img"
      aria-label={label}
      data-preview-kind={geometry.kind}
      {...(geometry.kind === "framed" ? { "data-frame": geometry.frame } : {})}
      {...(size ? { "data-size": size } : {})}
      className="rounded-sm overflow-hidden relative flex items-center justify-center p-6 sm:p-10 border border-stone-300/60"
      style={{
        aspectRatio: `${master.width} / ${master.height}`,
        background: STAGE_BACKGROUND,
      }}
    >
      <div className="relative w-full h-full" style={{ containerType: "size" }}>
        <div className="flex items-center justify-center w-full h-full">
          {geometry.kind === "digital" ? (
            <DigitalImage image={image} alt={alt} filmLookClassName={filmLookClassName} />
          ) : (
            <ProductBox
              geometry={geometry}
              image={image}
              alt={alt}
              filmLookClassName={filmLookClassName}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function DigitalImage({
  image,
  alt,
  filmLookClassName,
}: {
  image: GalleryImage | null;
  alt: string;
  filmLookClassName: string;
}) {
  if (image === null) {
    return <span className="text-xs text-stone-500 text-center">{alt}</span>;
  }
  return (
    <PictureImg
      image={image}
      alt=""
      className={`max-h-full max-w-full object-contain shadow-md ${filmLookClassName}`}
      sizes={SIZES}
      priority
    />
  );
}

/** The paper sheet, the frame, or the canvas front — the product's outer box. */
function outerExtent(geometry: PhysicalGeometry): Extent {
  return geometry.kind === "canvas" ? geometry.front : geometry.outer;
}

function ProductBox({
  geometry,
  image,
  alt,
  filmLookClassName,
}: {
  geometry: PhysicalGeometry;
  image: GalleryImage | null;
  alt: string;
  filmLookClassName: string;
}) {
  const outer = outerExtent(geometry);
  return (
    <div
      className="relative motion-safe:transition-[width,aspect-ratio] duration-200"
      style={{
        aspectRatio: `${outer.width} / ${outer.height}`,
        width: `min(100cqw, 100cqh * ${outer.width} / ${outer.height})`,
        boxShadow: PRODUCT_SHADOW[geometry.kind],
      }}
    >
      {geometry.kind === "paper" && (
        <>
          <ImageLayer
            containerStyle={FULL}
            boxExtent={geometry.outer}
            rect={geometry.image}
            image={image}
            alt={alt}
            filmLookClassName={filmLookClassName}
          />
          <div
            className="absolute inset-0 pointer-events-none"
            style={{ boxShadow: "inset 0 0 0 1px rgba(0,0,0,.06)" }}
          />
        </>
      )}

      {geometry.kind === "canvas" && (
        <>
          <ImageLayer
            containerStyle={FULL}
            boxExtent={geometry.front}
            rect={geometry.image}
            image={image}
            alt={alt}
            filmLookClassName={filmLookClassName}
          />
          <div
            className="absolute inset-0 pointer-events-none"
            style={{ boxShadow: CANVAS_EDGE_SHADOW }}
          />
          <div
            className="absolute inset-0 pointer-events-none"
            style={{ backgroundImage: CANVAS_WEAVE, mixBlendMode: "multiply" }}
          />
        </>
      )}

      {geometry.kind === "framed" && (
        <FramedLayers
          geometry={geometry}
          image={image}
          alt={alt}
          filmLookClassName={filmLookClassName}
        />
      )}
    </div>
  );
}

function FramedLayers({
  geometry,
  image,
  alt,
  filmLookClassName,
}: {
  geometry: Extract<PhysicalGeometry, { kind: "framed" }>;
  image: GalleryImage | null;
  alt: string;
  filmLookClassName: string;
}) {
  const outer = geometry.outer;
  return (
    <>
      {(["top", "right", "bottom", "left"] as Side[]).map((side) => (
        <MouldingPiece
          key={side}
          side={side}
          outer={outer}
          m={geometry.mouldingMm}
          finish={geometry.frame}
        />
      ))}
      <div
        data-mount
        className="absolute"
        style={{
          ...percentRect(geometry.mount, outer),
          background: MOUNT_BACKGROUND,
          boxShadow: "inset 1px 2px 4px rgba(0,0,0,.28)",
        }}
      />
      <ImageLayer
        dataWindow
        containerStyle={{
          ...percentRect(geometry.window, outer),
          boxShadow: "0 0 0 2px #fbfaf6, 0 0 0 3px rgba(0,0,0,.07)",
        }}
        boxExtent={{ width: geometry.window.width, height: geometry.window.height }}
        rect={geometry.image}
        image={image}
        alt={alt}
        filmLookClassName={filmLookClassName}
      >
        <div
          className="absolute inset-0 pointer-events-none"
          style={{ boxShadow: "inset 1px 1px 2px rgba(0,0,0,.18)" }}
        />
      </ImageLayer>
      <div
        className="absolute pointer-events-none"
        style={{
          ...percentRect(geometry.mount, outer),
          background:
            "linear-gradient(120deg, transparent 35%, rgba(255,255,255,.07) 48%, transparent 62%)",
        }}
      />
    </>
  );
}

function MouldingPiece({
  side,
  outer,
  m,
  finish,
}: {
  side: Side;
  outer: Extent;
  m: number;
  finish: FrameFinish;
}) {
  const mx = pctNumber(m, outer.width);
  const my = pctNumber(m, outer.height);
  const box: Record<Side, CSSProperties> = {
    top: { left: 0, top: 0, width: "100%", height: `${my}%` },
    bottom: { left: 0, bottom: 0, width: "100%", height: `${my}%` },
    left: { left: 0, top: 0, height: "100%", width: `${mx}%` },
    right: { right: 0, top: 0, height: "100%", width: `${mx}%` },
  };
  const clip: Record<Side, string> = {
    top: `polygon(0 0, 100% 0, calc(100% - ${mx}%) 100%, ${mx}% 100%)`,
    bottom: `polygon(${mx}% 0, calc(100% - ${mx}%) 0, 100% 100%, 0 100%)`,
    left: `polygon(0 0, 100% ${my}%, 100% calc(100% - ${my}%), 0 100%)`,
    right: `polygon(100% 0, 100% 100%, 0 calc(100% - ${my}%), 0 ${my}%)`,
  };
  const insideDirection: Record<Side, string> = {
    top: "to bottom",
    right: "to left",
    bottom: "to top",
    left: "to right",
  };
  const alongDirection: Record<Side, string> = {
    top: "to right",
    right: "to bottom",
    bottom: "to right",
    left: "to bottom",
  };
  const grain =
    finish === "brown"
      ? `repeating-linear-gradient(${alongDirection[side]}, ${FRAME_GRAIN_STOPS}), `
      : "";
  return (
    <div
      className="absolute pointer-events-none"
      style={{
        ...box[side],
        clipPath: clip[side],
        backgroundColor: FRAME_BASE[finish],
        backgroundImage: `${grain}linear-gradient(${insideDirection[side]}, ${FRAME_PROFILE})`,
      }}
    >
      <div className="absolute inset-0" style={{ backgroundColor: FRAME_LIGHT[side] }} />
    </div>
  );
}

/**
 * A cropped-image box: `containerStyle` places it relative to the product box,
 * `rect` places the image inside it (relative to `boxExtent`). When the ladder
 * produced no image, the alt text is shown in its place.
 */
function ImageLayer({
  containerStyle,
  boxExtent,
  rect,
  image,
  alt,
  filmLookClassName,
  dataWindow = false,
  children,
}: {
  containerStyle: CSSProperties;
  boxExtent: Extent;
  rect: Rect;
  image: GalleryImage | null;
  alt: string;
  filmLookClassName: string;
  dataWindow?: boolean;
  children?: ReactNode;
}) {
  return (
    <div
      {...(dataWindow ? { "data-window": "" } : {})}
      className="absolute overflow-hidden"
      style={containerStyle}
    >
      {image === null ? (
        <span className="absolute inset-0 flex items-center justify-center text-center text-[10px] text-stone-500 p-3">
          {alt}
        </span>
      ) : (
        <PictureImg
          image={image}
          alt=""
          className={`absolute max-w-none ${filmLookClassName}`}
          sizes={SIZES}
          priority
          style={percentRect(rect, boxExtent)}
        />
      )}
      {children}
    </div>
  );
}

function pctNumber(value: number, total: number): number {
  return Number(((value / total) * 100).toFixed(4));
}
