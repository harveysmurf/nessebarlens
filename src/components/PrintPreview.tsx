"use client";

/**
 * The live product preview (#326): what the buyer receives for the selected
 * format, size and frame, drawn in CSS from the geometry `previewGeometry`
 * computes. There is no per-photo mockup file, no WebGL and no new dependency;
 * the image is the existing web derivative, positioned and cropped.
 *
 * A stretched canvas additionally opens on the angled view (#327): a CSS 3D
 * box whose sides show the real band of the photo Prodigi wraps around the
 * 38 mm bars, from the same cover crop as the front. The view is local state,
 * not part of `PrintSelection`, because it changes nothing about the order; a
 * toggle switches to the flat front view, which is the #326 canvas exactly.
 *
 * The component does no millimetre maths: every rectangle from the domain is
 * turned into a CSS percentage by `percentRect`, so the same geometry drives
 * the unit tests and the pixels.
 */
import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactEventHandler,
  type ReactNode,
  type Ref,
} from "react";
import type { MasterFacts } from "@/domain/catalog/master-facts";
import type { FrameFinish, PrintSize } from "@/domain/pricing/pricing";
import {
  canvasSideFace,
  percentRect,
  type CanvasSide,
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
type ProductGeometry = Extract<PhysicalGeometry, { kind: "paper" | "framed" }>;
type CanvasGeometry = Extract<PhysicalGeometry, { kind: "canvas" }>;
type PreviewView = "angled" | "front";

const FULL: CSSProperties = { left: "0%", top: "0%", width: "100%", height: "100%" };
const SIZES = "(max-width: 1024px) 100vw, 60vw";
/** Turn the product so its right face comes toward the viewer. */
const CANVAS_ANGLE = "scale(0.84) rotateY(-28deg)";

type PrintPreviewProps = {
  geometry: PreviewGeometry;
  image: GalleryImage | null;
  alt: string;
  label: string;
  filmLookClassName: string;
  master: MasterFacts;
  size?: PrintSize;
};

export function PrintPreview(props: PrintPreviewProps) {
  // Keyed on the format kind so entering the canvas remounts the view state at
  // its "angled" default: React resets state on a key change, so the canvas
  // reopens angled after the toggle left it on "front", with no effect.
  return <PreviewBody key={props.geometry.kind} {...props} />;
}

function PreviewBody({
  geometry,
  image,
  alt,
  label,
  filmLookClassName,
  master,
  size,
}: PrintPreviewProps) {
  const [view, setView] = useState<PreviewView>("angled");

  return (
    <div className="space-y-2">
      <div
        role="img"
        aria-label={label}
        data-preview-kind={geometry.kind}
        {...(geometry.kind === "canvas" ? { "data-preview-view": view } : {})}
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
            ) : geometry.kind === "canvas" ? (
              <CanvasScene
                geometry={geometry}
                image={image}
                alt={alt}
                filmLookClassName={filmLookClassName}
                view={view}
              />
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

      {geometry.kind === "canvas" && (
        <div className="flex justify-end">
          <ViewToggle view={view} onChange={setView} />
        </div>
      )}
    </div>
  );
}

/** The angled/front switch: canvas only, a radio group like the format cards. */
function ViewToggle({
  view,
  onChange,
}: {
  view: PreviewView;
  onChange: (view: PreviewView) => void;
}) {
  return (
    <div role="radiogroup" aria-label="Preview view" className="flex items-center gap-1">
      {(["angled", "front"] as const).map((option) => {
        const active = view === option;
        return (
          <label
            key={option}
            className={`text-[10px] uppercase tracking-widest px-2 py-1 rounded cursor-pointer has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-stone-900 ${
              active
                ? "border border-stone-900"
                : "border border-stone-200 text-stone-500"
            }`}
          >
            <input
              type="radio"
              name="preview-view"
              value={option}
              checked={active}
              onChange={() => onChange(option)}
              className="sr-only"
            />
            {option === "angled" ? "Angled" : "Front"}
          </label>
        );
      })}
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

/** The paper sheet or the frame — the product's outer box. */
function outerExtent(geometry: ProductGeometry): Extent {
  return geometry.outer;
}

function ProductBox({
  geometry,
  image,
  alt,
  filmLookClassName,
}: {
  geometry: ProductGeometry;
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

/**
 * The angled canvas (#327): a CSS 3D box whose front is the #326 canvas and
 * whose sides carry the wrapped band of the same photo. The shadow is a
 * sibling of the product, not an ancestor — `filter` on the product would
 * flatten the 3D.
 */
function CanvasScene({
  geometry,
  image,
  alt,
  filmLookClassName,
  view,
}: {
  geometry: CanvasGeometry;
  image: GalleryImage | null;
  alt: string;
  filmLookClassName: string;
  view: PreviewView;
}) {
  const angled = view === "angled";
  const { front } = geometry;
  const [currentSrc, setCurrentSrc] = useState<string | null>(null);
  const frontRef = useRef<HTMLImageElement | null>(null);

  // The side faces paint the exact URL the front actually loaded, so switching
  // to angled costs no new image request. `complete` covers a cached image
  // whose load event fired before this effect attached.
  useEffect(() => {
    const node = frontRef.current;
    if (node?.complete && node.currentSrc) setCurrentSrc(node.currentSrc);
  }, [image]);

  const boxWidth = `min(100cqw, 100cqh * ${front.width / front.height})`;
  const onFrontLoad: ReactEventHandler<HTMLImageElement> = (event) => {
    setCurrentSrc(event.currentTarget.currentSrc);
  };

  return (
    <div
      className="relative w-full h-full"
      style={{ perspective: "250cqw", perspectiveOrigin: "50% 50%" }}
    >
      {angled && (
        <div
          aria-hidden
          className="absolute pointer-events-none"
          style={{
            left: "50%",
            top: "50%",
            width: boxWidth,
            aspectRatio: `${front.width} / ${front.height}`,
            transform: "translate(-50%, -50%) translate(4%, 5%) scale(0.98)",
            background: "rgba(0,0,0,.30)",
            filter: "blur(16px)",
          }}
        />
      )}

      <div
        data-product
        className="absolute motion-safe:transition-transform motion-safe:duration-300"
        style={{
          left: "50%",
          top: "50%",
          width: boxWidth,
          aspectRatio: `${front.width} / ${front.height}`,
          transformStyle: "preserve-3d",
          transform: angled
            ? `translate(-50%, -50%) ${CANVAS_ANGLE}`
            : "translate(-50%, -50%)",
          boxShadow: angled ? undefined : PRODUCT_SHADOW.canvas,
        }}
      >
        <div
          data-face="front"
          className="absolute inset-0 overflow-hidden"
          style={{ backfaceVisibility: "hidden" }}
        >
          <ImageLayer
            containerStyle={FULL}
            boxExtent={front}
            rect={geometry.image}
            image={image}
            alt={alt}
            filmLookClassName={filmLookClassName}
            imgRef={frontRef}
            onLoad={onFrontLoad}
          />
          <div
            className="absolute inset-0 pointer-events-none"
            style={{ boxShadow: CANVAS_EDGE_SHADOW }}
          />
          <div
            className="absolute inset-0 pointer-events-none"
            style={{ backgroundImage: CANVAS_WEAVE, mixBlendMode: "multiply" }}
          />
          <div
            className="absolute inset-0 pointer-events-none"
            style={{ boxShadow: "inset -1px 0 0 rgba(255,255,255,.18)" }}
          />
        </div>

        {currentSrc &&
          (["top", "right", "bottom", "left"] as CanvasSide[]).map((side) => (
            <CanvasSideFace
              key={side}
              geometry={geometry}
              side={side}
              currentSrc={currentSrc}
              filmLookClassName={filmLookClassName}
              angled={angled}
            />
          ))}
      </div>
    </div>
  );
}

/** The transform that stands a face up along its fold, per side. */
const SIDE_TRANSFORM: Record<CanvasSide, CSSProperties> = {
  right: { transform: "rotateY(90deg)", transformOrigin: "left center" },
  left: { transform: "rotateY(-90deg)", transformOrigin: "right center" },
  top: { transform: "rotateX(90deg)", transformOrigin: "center bottom" },
  bottom: { transform: "rotateX(-90deg)", transformOrigin: "center top" },
};

/** Light falling across each wrapped side. */
const SIDE_SHADING: Record<CanvasSide, string> = {
  right: "linear-gradient(to right, rgba(0,0,0,.18), rgba(0,0,0,.32))",
  left: "rgba(0,0,0,.10)",
  top: "rgba(255,255,255,.06)",
  bottom: "rgba(0,0,0,.30)",
};

function CanvasSideFace({
  geometry,
  side,
  currentSrc,
  filmLookClassName,
  angled,
}: {
  geometry: CanvasGeometry;
  side: CanvasSide;
  currentSrc: string;
  filmLookClassName: string;
  angled: boolean;
}) {
  const { front, depthMm } = geometry;
  const { face, image } = canvasSideFace(geometry, side);
  const vertical = side === "left" || side === "right";
  const depthPct = `${pctNumber(depthMm, vertical ? front.width : front.height)}%`;
  const placement: Record<CanvasSide, CSSProperties> = {
    right: { left: "100%", top: 0, width: depthPct, height: "100%" },
    left: { right: "100%", top: 0, width: depthPct, height: "100%" },
    top: { bottom: "100%", left: 0, width: "100%", height: depthPct },
    bottom: { top: "100%", left: 0, width: "100%", height: depthPct },
  };
  return (
    <div
      data-face={side}
      className="absolute overflow-hidden"
      style={{
        ...placement[side],
        ...SIDE_TRANSFORM[side],
        backfaceVisibility: "hidden",
        display: angled ? undefined : "none",
      }}
    >
      {/* The side reuses the exact URL the front already loaded, so it adds no
          request and needs no ladder of its own. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={currentSrc}
        alt=""
        decoding="async"
        className={`absolute max-w-none ${filmLookClassName}`}
        style={percentRect(image, face)}
      />
      <div
        className="absolute inset-0 pointer-events-none"
        style={{ background: SIDE_SHADING[side] }}
      />
    </div>
  );
}

function FramedLayers({
  geometry,
  image,
  alt,
  filmLookClassName,
}: {
  geometry: Extract<ProductGeometry, { kind: "framed" }>;
  image: GalleryImage | null;
  alt: string;
  filmLookClassName: string;
}) {
  const outer = geometry.outer;
  return (
    <>
      {(["top", "right", "bottom", "left"] as CanvasSide[]).map((side) => (
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
  side: CanvasSide;
  outer: Extent;
  m: number;
  finish: FrameFinish;
}) {
  const mx = pctNumber(m, outer.width);
  const my = pctNumber(m, outer.height);
  const box: Record<CanvasSide, CSSProperties> = {
    top: { left: 0, top: 0, width: "100%", height: `${my}%` },
    bottom: { left: 0, bottom: 0, width: "100%", height: `${my}%` },
    left: { left: 0, top: 0, height: "100%", width: `${mx}%` },
    right: { right: 0, top: 0, height: "100%", width: `${mx}%` },
  };
  const clip: Record<CanvasSide, string> = {
    top: `polygon(0 0, 100% 0, calc(100% - ${mx}%) 100%, ${mx}% 100%)`,
    bottom: `polygon(${mx}% 0, calc(100% - ${mx}%) 0, 100% 100%, 0 100%)`,
    left: `polygon(0 0, 100% ${my}%, 100% calc(100% - ${my}%), 0 100%)`,
    right: `polygon(100% 0, 100% 100%, 0 calc(100% - ${my}%), 0 ${my}%)`,
  };
  const insideDirection: Record<CanvasSide, string> = {
    top: "to bottom",
    right: "to left",
    bottom: "to top",
    left: "to right",
  };
  const alongDirection: Record<CanvasSide, string> = {
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
 * produced no image, the alt text is shown in its place. `imgRef`/`onLoad` let
 * the canvas read the URL the browser chose (#327).
 */
function ImageLayer({
  containerStyle,
  boxExtent,
  rect,
  image,
  alt,
  filmLookClassName,
  dataWindow = false,
  imgRef,
  onLoad,
  children,
}: {
  containerStyle: CSSProperties;
  boxExtent: Extent;
  rect: Rect;
  image: GalleryImage | null;
  alt: string;
  filmLookClassName: string;
  dataWindow?: boolean;
  imgRef?: Ref<HTMLImageElement | null>;
  onLoad?: ReactEventHandler<HTMLImageElement>;
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
          imgRef={imgRef}
          onLoad={onLoad}
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
