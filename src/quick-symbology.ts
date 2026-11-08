/**
 * Copyright (c) 2026 James Westman <james@jwestman.net>
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

import type { ExpressionSpecification, Map as MaplibreMap } from "maplibre-gl";

/** A literal value or a MapLibre expression that evaluates to one. */
export type Value<T> = T | ExpressionSpecification;

type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** The result of rendering an icon. */
export interface RenderedIcon {
  image: ImageData;
  pixelRatio: number;
  sdf?: boolean;
}

/** A previously registered image, loaded as something drawable. Sizes are logical px. */
export interface ChildImage {
  source: CanvasImageSource;
  width: number;
  height: number;
}

/**
 * The context provided to a custom renderer when drawing an icon.
 */
export interface RenderContext {
  /** The map the icon will be used with, or undefined when rendering outside of MapLibre. */
  readonly map: MaplibreMap | undefined;

  /** Device-pixel multiplier the resolver renders at. */
  readonly pixelRatio: number;

  /**
   * Create a canvas covering `width` × `height` logical pixels, call `paint` with a
   * context already scaled to logical units, and read the result back as an icon.
   */
  draw(width: number, height: number, paint: (g: Ctx2D) => void): RenderedIcon;

  /**
   * Get an image by name as a drawable, generating it first if it's one of ours.
   * Returns undefined if the image doesn't exist and can't be generated.
   */
  resolve(name: string): ChildImage | undefined;
}

/**
 * The type of a renderer function for a symbology.
 */
export type Renderer<Params = Record<string, unknown>> = (
  params: Params,
  context: RenderContext,
) => RenderedIcon;

/* Using a symbol key on globalThis ensures that even if a bundler
 * duplicates this module, the registry remains shared across all copies.
 */
const REGISTRY_KEY = Symbol.for("quick-symbology.renderers");

interface RegisteredSymbology {
  spec: ParameterSpec;
  renderer: Renderer;
}

function registry(): Map<string, RegisteredSymbology> {
  const host = globalThis as unknown as Record<
    symbol,
    Map<string, RegisteredSymbology> | undefined
  >;
  let map = host[REGISTRY_KEY];
  if (!map) {
    map = new Map();
    host[REGISTRY_KEY] = map;
  }
  return map;
}

const OPEN = "⟨";
const CLOSE = "⟩";
const SEP = "¦";
const PREFIX = "qs";

/** Decoded parameters of one node, as raw strings with typed accessors. */
class ParamBag {
  constructor(
    readonly type: string,
    private readonly fields: ReadonlyMap<string, string>,
  ) {}

  has(key: string): boolean {
    return this.fields.has(key);
  }

  string(key: string, fallback = ""): string {
    const v = this.fields.get(key);
    return v === undefined || v === "" ? fallback : v;
  }

  /** Parse as a finite number, clamped to [min, max]; the fallback if missing/invalid. */
  number(
    key: string,
    fallback: number,
    min = -Infinity,
    max = Infinity,
  ): number {
    const raw = this.fields.get(key);
    const n = raw === undefined || raw.trim() === "" ? NaN : Number(raw);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
  }

  oneOf<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
    const v = this.fields.get(key);
    return allowed.includes(v as T) ? (v as T) : fallback;
  }

  /** Decode a field made of concatenated nodes (an array) into one bag per node. */
  nodes(key: string): ParamBag[] {
    const raw = this.fields.get(key);
    if (!raw) return [];
    const out: ParamBag[] = [];
    for (const s of scanNodes(raw)) {
      const node = parseNode(s);
      if (node) out.push(node);
    }
    return out;
  }
}

function splitTop(s: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === OPEN) depth++;
    else if (c === CLOSE) depth--;
    else if (c === sep && depth === 0) {
      out.push(s.slice(start, i));
      start = i + 1;
    }
  }
  out.push(s.slice(start));
  return out;
}

function scanNodes(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = -1;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === OPEN) {
      if (depth === 0) start = i;
      depth++;
    } else if (c === CLOSE && depth > 0) {
      depth--;
      if (depth === 0) out.push(s.slice(start, i + 1));
    }
  }
  return out;
}

function parseNode(s: string): ParamBag | undefined {
  if (s[0] !== OPEN || s[s.length - 1] !== CLOSE) return undefined;
  const [type, ...rest] = splitTop(s.slice(1, -1), SEP);
  if (!type) return undefined;
  const fields = new Map<string, string>();
  for (const f of rest) {
    const i = f.indexOf("=");
    if (i > 0) fields.set(f.slice(0, i), f.slice(i + 1));
  }
  return new ParamBag(type, fields);
}

/** Decode an image name produced by one of the symbology functions. */
function decodeName(name: string): ParamBag | undefined {
  return name.startsWith(PREFIX + OPEN)
    ? parseNode(name.slice(PREFIX.length))
    : undefined;
}

type Part = string | ExpressionSpecification;

const asExpr = (e: unknown) => e as ExpressionSpecification;

function part(v: Value<string | number | boolean>): Part {
  return Array.isArray(v) ? asExpr(["to-string", v]) : String(v);
}

function field(
  key: string,
  value: Value<string | number | boolean> | undefined,
): Part[] {
  return value === undefined ? [] : [`${SEP}${key}=`, part(value)];
}

const node = (type: string, fields: Part[]): Part[] => [
  OPEN + type,
  ...fields,
  CLOSE,
];

/** Encodes node parts into a complete `['image', name]` expression */
function imageExpression(
  type: string,
  fields: Part[],
): ExpressionSpecification {
  const merged: Part[] = [];
  for (const p of [PREFIX, ...node(type, fields)]) {
    const last = merged[merged.length - 1];
    if (typeof p === "string" && typeof last === "string")
      merged[merged.length - 1] = last + p;
    else merged.push(p);
  }
  return asExpr([
    "image",
    merged.length === 1 ? merged[0] : ["concat", ...merged],
  ]);
}

/**
 * A specification for the options a symbology takes.
 */
export interface ParameterSpec {
  readonly [key: string]:
    | { type: "string" | "image"; default: string }
    | {
        type: "number";
        default: number;
        min?: number;
        max?: number | ((params: Readonly<Record<string, unknown>>) => number);
      }
    | {
        type: "enum";
        values: readonly string[];
        default: string;
      }
    | {
        type: "array";
        node: string;
        fields: ParameterSpec;
        default?: readonly Record<string, unknown>[];
      };
}

type ParameterValue<Spec> = Spec extends { type: "number" }
  ? number
  : Spec extends { type: "enum"; values: readonly (infer Choice)[] }
    ? Choice
    : Spec extends { type: "array"; fields: infer Fields extends ParameterSpec }
      ? SymbologyParameters<Fields>[]
      : string;

type ParameterInput<Spec> = Spec extends {
  type: "array";
  fields: infer Fields extends ParameterSpec;
}
  ? ReadonlyArray<SymbologyOptions<Fields>>
  : Value<ParameterValue<Spec>>;

/**
 * The options passed to the symbology function.
 */
export type SymbologyOptions<Spec extends ParameterSpec> = {
  [Key in keyof Spec]?: ParameterInput<Spec[Key]>;
};

/**
 * The parameters passed to a render function, with defaults and limits applied.
 */
export type SymbologyParameters<Spec extends ParameterSpec> = {
  [Key in keyof Spec]: ParameterValue<Spec[Key]>;
};

function decodeParameters(
  spec: ParameterSpec,
  bag: ParamBag,
): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  for (const [key, definition] of Object.entries(spec)) {
    if (definition.type === "number") {
      const max =
        typeof definition.max === "function"
          ? definition.max(params)
          : definition.max;

      params[key] = bag.number(key, definition.default, definition.min, max);
    } else if (definition.type === "enum") {
      params[key] = bag.oneOf(key, definition.values, definition.default);
    } else if (definition.type === "array") {
      const values = bag
        .nodes(key)
        .map((child) => decodeParameters(definition.fields, child));

      params[key] = values.length ? values : (definition.default ?? []);
    } else {
      params[key] = bag.string(key, definition.default);
    }
  }
  return params;
}

function encodeParameters(
  spec: ParameterSpec,
  options?: Record<string, unknown>,
): Part[] {
  return Object.entries(spec).flatMap(([key, definition]) => {
    const value = (options ?? {})[key];
    if (value === undefined) return [];
    if (definition.type === "array") {
      return [
        `${SEP}${key}=`,
        ...(value as Record<string, unknown>[]).flatMap((item) =>
          node(definition.node, encodeParameters(definition.fields, item)),
        ),
      ];
    }
    const scalar = value as Value<string | number>;
    return field(
      key,
      definition.type === "image" ? nameOf(scalar as Value<string>) : scalar,
    );
  });
}

/**
 * Registers a custom symbology renderer, returning the symbology function.
 *
 * @param id An ID for the symbology
 * @param spec Specification of the symbology's options
 * @param renderer The function that renders the symbology
 * @param overwrite Whether to overwrite an existing symbology with the same ID
 * @returns The symbology function that can be used to generate a resolvedImage expression
 */
export function registerSymbology<const Spec extends ParameterSpec>(
  id: string,
  spec: Spec,
  renderer: Renderer<SymbologyParameters<Spec>>,
  overwrite = false,
): (options?: SymbologyOptions<Spec>) => ExpressionSpecification {
  if (/[⟨⟩¦=]/.test(id))
    throw new Error(`quick-symbology: invalid icon type "${id}"`);

  const reg = registry();
  if (overwrite || !reg.has(id)) {
    reg.set(id, { spec, renderer: renderer as unknown as Renderer });
  }

  return (options) =>
    imageExpression(
      id,
      encodeParameters(spec, options as Record<string, unknown>),
    );
}

/**
 * Extracts the name from a child icon option, unwrapping `['image', name]` if necessary.
 */
function nameOf(icon: Value<string>): Value<string> {
  return Array.isArray(icon) && icon[0] === "image"
    ? (icon[1] as Value<string>)
    : icon;
}

function defaultPixelRatio(): number {
  const dpr = typeof devicePixelRatio === "number" ? devicePixelRatio : 1;
  return Math.max(1, Math.ceil(dpr));
}

function createContext2D(width: number, height: number): Ctx2D {
  let g: Ctx2D | null;
  if (typeof OffscreenCanvas !== "undefined") {
    g = new OffscreenCanvas(width, height).getContext("2d", {
      willReadFrequently: true,
    });
  } else {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    g = canvas.getContext("2d", { willReadFrequently: true });
  }
  if (!g) throw new Error("quick-symbology: 2D canvas is not available");
  return g;
}

const MAX_CANVAS_SIZE = 1024;

function drawIcon(
  pixelRatio: number,
  width: number,
  height: number,
  paint: (g: Ctx2D) => void,
): RenderedIcon {
  const pw = Math.min(
    MAX_CANVAS_SIZE,
    Math.max(1, Math.round(width * pixelRatio)),
  );
  const ph = Math.min(
    MAX_CANVAS_SIZE,
    Math.max(1, Math.round(height * pixelRatio)),
  );
  const g = createContext2D(pw, ph);
  g.scale(pw / width, ph / height);
  g.imageSmoothingQuality = "high";
  paint(g);
  return { image: g.getImageData(0, 0, pw, ph), pixelRatio: pw / width };
}

/**
 * Options for rendering an icon with `renderSymbol`.
 */
export interface RenderIconOptions {
  /** Resolution multiplier for generated images. Default: ceil(devicePixelRatio). */
  pixelRatio?: number;

  /** Resolve names that do not refer to generated icons. */
  resolve?: (name: string) => ChildImage | undefined;
}

/**
 * Renders a symbology expression without a MapLibre map.
 *
 * If the expression contains data-driven values, this will fail.
 */
export function renderSymbol(
  expression: ExpressionSpecification,
  options: RenderIconOptions = {},
): RenderedIcon {
  if (
    !Array.isArray(expression) ||
    expression.length !== 2 ||
    expression[0] !== "image" ||
    typeof expression[1] !== "string"
  ) {
    throw new Error("quick-symbology: expected a static image expression");
  }

  const pixelRatio = options.pixelRatio ?? defaultPixelRatio();
  if (!Number.isFinite(pixelRatio) || pixelRatio <= 0) {
    throw new Error(
      "quick-symbology: pixelRatio must be a positive finite number",
    );
  }

  const rendering = new Set<string>();
  const render = (name: string): RenderedIcon => {
    const params = decodeName(name);
    const registered = params && registry().get(params.type);
    if (!params || !registered) {
      throw new Error(`quick-symbology: no renderer for image "${name}"`);
    }
    if (rendering.has(name)) {
      throw new Error(`quick-symbology: circular image reference "${name}"`);
    }
    rendering.add(name);

    try {
      return registered.renderer(
        decodeParameters(registered.spec, params),
        context,
      );
    } finally {
      rendering.delete(name);
    }
  };

  const context: RenderContext = {
    map: undefined,
    pixelRatio,
    draw: (width, height, paint) => drawIcon(pixelRatio, width, height, paint),
    resolve(name) {
      if (!decodeName(name)) return options.resolve?.(name);

      const icon = render(name);
      const g = createContext2D(icon.image.width, icon.image.height);
      g.putImageData(icon.image, 0, 0);
      return {
        source: g.canvas,
        width: icon.image.width / icon.pixelRatio,
        height: icon.image.height / icon.pixelRatio,
      };
    },
  };

  return render(expression[1]);
}

/**
 * The image resolver function that integrates with a MapLibre map to add symbology images as needed.
 *
 * @param map The MapLibre map to which the images will be added
 * @returns A function that resolves child images for the given MapLibre map
 */
export function quickSymbologyResolver(map: MaplibreMap) {
  let warned = false;

  function createContext(map: MaplibreMap): RenderContext {
    const pixelRatio = defaultPixelRatio();

    return {
      map,
      pixelRatio,
      draw(width, height, paint) {
        return drawIcon(pixelRatio, width, height, paint);
      },
      resolve: (name) => loadChild(map, name),
    };
  }

  function loadChild(map: MaplibreMap, name: string): ChildImage | undefined {
    if (!name || !resolve(name)) return undefined;
    const img = map.getImage(name);
    if (!img) return undefined;

    const src = img.data as {
      width: number;
      height: number;
      data: ArrayLike<number>;
    };
    const pixels = new Uint8ClampedArray(src.data.length);
    pixels.set(src.data as ArrayLike<number>);
    const g = createContext2D(src.width, src.height);
    g.putImageData(new ImageData(pixels, src.width, src.height), 0, 0);

    const ratio = img.pixelRatio || 1;
    return {
      source: g.canvas,
      width: src.width / ratio,
      height: src.height / ratio,
    };
  }

  function resolve(id: string) {
    if (map.hasImage(id)) return true;

    const params = decodeName(id);
    if (!params) return;

    const registered = registry().get(params.type);
    if (!registered) {
      if (!warned) {
        warned = true;
        console.warn(
          `quick-symbology: no renderer registered for "${params.type}". ` +
            `Call the matching symbology function before the style needs it.`,
        );
      }
      return;
    }

    try {
      const icon = registered.renderer(
        decodeParameters(registered.spec, params),
        createContext(map),
      );

      map.addImage(id, icon.image, {
        pixelRatio: icon.pixelRatio,
        sdf: icon.sdf ?? false,
      });
    } catch (err) {
      console.error(`quick-symbology: failed to render "${id}"`, err);
    }
  }

  return resolve;
}

export interface MarkerOptions {
  /** Fill color of the pin body. */
  color?: Value<string>;

  /** Width of the pin in px. Default 24. Use `icon-anchor: 'bottom'` on the layer. */
  width?: Value<number>;

  /** Height of the pin in px. Default 36. Use `icon-anchor: 'bottom'` on the layer. */
  height?: Value<number>;

  /** Default '#ffffff'. */
  outlineColor?: Value<string>;

  /** Default 1.5. 0 disables the outline. */
  outlineWidth?: Value<number>;

  /** Color of the inner dot. Default '#ffffff'; 'none' removes it. */
  dotColor?: Value<string>;

  /** Radius of the inner dot as a fraction of the width. Default 0.42. */
  dotRadius?: Value<number>;
}

const markerOpts = {
  color: { type: "string", default: "#3887be" },
  width: { type: "number", default: 24 },
  height: { type: "number", default: 36 },
  outlineColor: { type: "string", default: "#ffffff" },
  outlineWidth: { type: "number", default: 1.5, min: 0 },
  dotColor: { type: "string", default: "#ffffff" },
  dotRadius: { type: "number", default: 0.42 },
} as const;

const renderMarker: Renderer<SymbologyParameters<typeof markerOpts>> = (
  params,
  rc,
) => {
  const height = params.height === 0 ? params.width * 1.5 : params.height;

  const {
    width,
    outlineWidth,
    color,
    outlineColor: outline,
    dotColor,
    dotRadius,
  } = params;

  const pad = outlineWidth / 2 + 0.5;
  const cx = width / 2;
  const r = width / 2 - pad;
  const cy = pad + r;
  const tipY = height - pad;
  // Angle at the circle's center between the tip direction and each tangent point.
  const a = Math.acos(r / (tipY - cy));

  return rc.draw(width, height, (g) => {
    g.beginPath();
    g.moveTo(cx, tipY);
    g.lineTo(
      cx + r * Math.cos(Math.PI / 2 - a),
      cy + r * Math.sin(Math.PI / 2 - a),
    );
    g.arc(cx, cy, r, Math.PI / 2 - a, Math.PI / 2 + a, true); // over the top
    g.closePath();
    g.fillStyle = color;
    g.fill();
    if (outlineWidth > 0) {
      g.lineJoin = "round";
      g.lineWidth = outlineWidth;
      g.strokeStyle = outline;
      g.stroke();
    }
    if (dotColor !== "none" && dotRadius > 0) {
      g.beginPath();
      g.arc(cx, cy, r * dotRadius, 0, Math.PI * 2);
      g.fillStyle = dotColor;
      g.fill();
    }
  });
};

/**
 * A pin marker icon.
 *
 * @param opts Symbology options
 * @returns A MapLibre resolvedImage expression
 */
export function marker(opts?: MarkerOptions) {
  return registerSymbology("marker", markerOpts, renderMarker)(opts);
}

export interface StripesOptions {
  /** Bands in order; the tile repeats after the last one. `width` is in px. */
  stripes: ReadonlyArray<{ color: Value<string>; width: Value<number> }>;

  /**
   * 'horizontal' draws bands that run horizontally (stacked top to bottom);
   * 'vertical' draws bands that run vertically (side by side). Default 'horizontal'.
   */
  direction?: Value<"horizontal" | "vertical">;
}

const stripesOpts = {
  direction: {
    type: "enum",
    values: ["horizontal", "vertical"],
    default: "horizontal",
  },
  stripes: {
    type: "array",
    node: "s",
    fields: {
      color: { type: "string", default: "transparent" },
      width: { type: "number", default: 1, min: 0.25, max: 256 },
    },
    default: [{ color: "transparent", width: 1 }],
  },
} as const;

const renderStripes: Renderer<SymbologyParameters<typeof stripesOpts>> = (
  { stripes, direction },
  rc,
) => {
  const bands = stripes;
  const horizontal = direction === "horizontal";

  // Work in whole device pixels so the tile repeats without seams.
  const px = bands.map((b) => Math.max(1, Math.round(b.width * rc.pixelRatio)));
  const total = px.reduce((sum, w) => sum + w, 0);
  const size = total / rc.pixelRatio;

  return rc.draw(size, size, (g) => {
    g.setTransform(1, 0, 0, 1, 0, 0);
    let pos = 0;
    bands.forEach((b, i) => {
      g.fillStyle = b.color;
      if (horizontal) g.fillRect(0, pos, total, px[i]);
      else g.fillRect(pos, 0, px[i], total);
      pos += px[i];
    });
  });
};

/**
 * A horizontal or vertical stripe texture.
 *
 * @param opts Symbology options
 * @returns A MapLibre resolvedImage expression
 */
export function stripes(opts?: StripesOptions) {
  return registerSymbology("stripes", stripesOpts, renderStripes)(opts);
}

export interface CircleOptions {
  /** Radius in px */
  radius: Value<number>;

  /** The color of the dot */
  color: Value<string>;
}

const circleOptions = {
  radius: { type: "number", default: 6, min: 0.5, max: 256 },
  color: { type: "string", default: "#000000" },
} as const;

function renderCircle(
  { radius, color }: SymbologyParameters<typeof circleOptions>,
  rc: RenderContext,
) {
  const size = radius * 2;

  return rc.draw(size, size, (g) => {
    g.beginPath();
    g.arc(size / 2, size / 2, radius, 0, Math.PI * 2);
    g.fillStyle = color;
    g.fill();
  });
}

/**
 * A filled circle icon.
 *
 * @param opts Symbology options
 * @returns A MapLibre resolvedImage expression
 */
export function circle(opts?: CircleOptions) {
  return registerSymbology("circle", circleOptions, renderCircle)(opts);
}

export interface IconGridOptions {
  /** Distance between icon centers along x, in px. */
  horizontalSpacing: Value<number>;

  /** Distance between icon centers along y, in px. */
  verticalSpacing: Value<number>;

  /**
   * The icon to repeat: the result of another symbology function, the name of any
   * image on the map, or an expression that evaluates to an image name.
   */
  icon: Value<string>;
}

const iconGridOptions = {
  horizontalSpacing: { type: "number", default: 16, min: 1, max: 1024 },
  verticalSpacing: { type: "number", default: 16, min: 1, max: 1024 },
  icon: { type: "image", default: "" },
} as const;

function renderIconGrid(
  {
    horizontalSpacing,
    verticalSpacing,
    icon,
  }: SymbologyParameters<typeof iconGridOptions>,
  rc: RenderContext,
) {
  const w = horizontalSpacing;
  const h = verticalSpacing;
  const child = rc.resolve(icon);

  return rc.draw(w, h, (g) => {
    if (!child) return;
    const x = (w - child.width) / 2;
    const y = (h - child.height) / 2;

    // Draw the neighbors too so icons larger than a cell wrap around the tile edges.
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        g.drawImage(
          child.source,
          x + dx * w,
          y + dy * h,
          child.width,
          child.height,
        );
      }
    }
  });
}

/**
 * A texture composed of a grid of repeated icons.
 *
 * @param opts Symbology options
 * @returns A MapLibre resolvedImage expression
 */
export function iconGrid(opts: IconGridOptions) {
  return registerSymbology("iconGrid", iconGridOptions, renderIconGrid)(opts);
}
