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
 * A renderer for a child image, providing the dimensions and a paint method.
 */
export interface ChildRenderer {
  /**
   * The size of the child image in logical pixels.
   */
  width: number;

  /**
   * The height of the child image in logical pixels.
   */
  height: number;

  /**
   * True if the child image can be rendered at a size other than its requested size.
   */
  resizable: boolean;

  /** Paints the child image onto the given context with the given width and height, which may differ from the natural width and height. */
  paint(g: Ctx2D, width: number, height: number): void;
}

/**
 * The context provided to a custom renderer when determining the size of an icon.
 */
export interface SizeContext {
  /** The map the icon will be used with, or undefined when rendering outside of MapLibre. */
  readonly map: MaplibreMap | undefined;

  /**
   * Device-pixel multiplier the icon is being rendered at.
   *
   * The canvas is already scaled by the pixel ratio, so you usually don't need to
   * worry about this.
   */
  readonly pixelRatio: number;

  /** Gets an image by name for direct painting onto the context's canvas. */
  resolveChild(name: string): ChildRenderer | undefined;
}

/**
 * The context provided to a custom renderer when drawing an icon.
 */
export interface RenderContext extends SizeContext {
  /**
   * The drawing context on which to render the icon.
   */
  readonly g: Ctx2D;

  /**
   * The width of the icon being rendered, in logical pixels.
   *
   * This can differ from the requested width if the symbology is stretchable.
   */
  readonly width: number;

  /**
   * The height of the icon being rendered, in logical pixels.
   *
   * This can differ from the requested height if the symbology is stretchable.
   */
  readonly height: number;
}

/**
 * The interface for a symbology renderer.
 */
export interface Symbology<T extends ParameterSpec> {
  /**
   * The definition the symbology's parameters.
   */
  spec: T;

  /**
   * Returns the size of the icon in logical pixels for the given parameters.
   *
   * If stretchable is true, the icon may be drawn at a different size than requested.
   * This can happen, for example, in a stack, where the icon may be expanded to match
   * the size of other icons in the stack.
   */
  size: (
    params: SymbologyParameters<T>,
    rc: SizeContext,
  ) => { width: number; height: number; resizable?: boolean };

  /** Renders the icon using the provided parameters and context. */
  render: (params: SymbologyParameters<T>, rc: RenderContext) => void;
}

/* Using a symbol key on globalThis ensures that even if a bundler
 * duplicates this module, the registry remains shared across all copies.
 */
const REGISTRY_KEY = Symbol.for("quick-symbology.renderers");

function registry(): Map<string, Symbology<any>> {
  const host = globalThis as unknown as Record<
    symbol,
    Map<string, Symbology<any>> | undefined
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

function decodeParameters<T extends ParameterSpec>(
  spec: T,
  bag: ParamBag,
): SymbologyParameters<T> {
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

  return params as SymbologyParameters<T>;
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
  symbology: Symbology<Spec>,
  overwrite = false,
): (options?: SymbologyOptions<Spec>) => ExpressionSpecification {
  if (/[⟨⟩¦=]/.test(id)) {
    throw new Error(`quick-symbology: invalid icon type "${id}"`);
  }

  const reg = registry();
  if (overwrite || !reg.has(id)) {
    reg.set(id, symbology);
  }

  return (options) =>
    imageExpression(
      id,
      encodeParameters(symbology.spec, options as Record<string, unknown>),
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

function createContext2D(
  width: number,
  height: number,
  pixelRatio: number,
): { g: Ctx2D; pixelRatio: number; pw: number; ph: number } {
  const pw = Math.min(
    MAX_CANVAS_SIZE,
    Math.max(1, Math.round(width * pixelRatio)),
  );
  const ph = Math.min(
    MAX_CANVAS_SIZE,
    Math.max(1, Math.round(height * pixelRatio)),
  );

  let g: Ctx2D | null;

  if (typeof OffscreenCanvas !== "undefined") {
    g = new OffscreenCanvas(pw, ph).getContext("2d", {
      willReadFrequently: true,
    });
  } else {
    const canvas = document.createElement("canvas");
    canvas.width = pw;
    canvas.height = ph;
    g = canvas.getContext("2d", { willReadFrequently: true });
  }
  if (!g) throw new Error("quick-symbology: 2D canvas is not available");

  if (width > 0 && height > 0) {
    g.scale(pw / width, ph / height);
  }

  g.imageSmoothingQuality = "high";

  return { g, pixelRatio: pw / width, pw, ph };
}

const MAX_CANVAS_SIZE = 1024;

function renderImpl<T extends ParameterSpec>(
  map: MaplibreMap | undefined,
  pixelRatio: number,
  resolveExternal: (name: string) => ChildImage | undefined,
  symbology: Symbology<T>,
  params: SymbologyParameters<T>,
): RenderedIcon {
  const ctx: SizeContext = {
    map,
    pixelRatio,

    resolveChild(name) {
      const params = decodeName(name);
      if (!params) {
        /* This isn't a quick-symbology image, so try to resolve it externally. */
        const image = resolveExternal(name);
        if (!image) return undefined;

        return {
          width: image.width,
          height: image.height,
          resizable: false,

          paint(g, width, height) {
            g.drawImage(
              image.source,
              (width - image.width) / 2,
              (height - image.height) / 2,
              image.width,
              image.height,
            );
          },
        };
      }

      const symbology = registry().get(params.type);
      if (!symbology) return undefined;

      const values = decodeParameters(symbology.spec, params);

      const childSize = symbology.size(values, ctx);

      return {
        width: childSize.width,
        height: childSize.height,
        resizable: childSize.resizable ?? false,

        paint(g, width, height) {
          symbology.render(values, { ...ctx, g, width, height });
        },
      };
    },
  };

  const size = symbology.size(params, ctx);

  const {
    g,
    pixelRatio: actualPixelRatio,
    pw,
    ph,
  } = createContext2D(size.width, size.height, pixelRatio);

  symbology.render(params, {
    ...ctx,
    g,
    width: size.width,
    height: size.height,
  });

  const image = g.getImageData(0, 0, pw, ph);
  return { image, pixelRatio: actualPixelRatio, sdf: false };
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

  const params = decodeName(expression[1]);
  const symbology = params && registry().get(params.type);
  if (!params || !symbology) {
    throw new Error(
      `quick-symbology: no renderer for image "${expression[1]}"`,
    );
  }

  const p = decodeParameters(symbology.spec, params);

  return renderImpl(
    undefined,
    pixelRatio,
    options?.resolve ?? (() => undefined),
    symbology,
    p,
  );
}

/**
 * The image resolver function that integrates with a MapLibre map to add symbology images as needed.
 *
 * @param map The MapLibre map to which the images will be added
 * @returns A function that resolves child images for the given MapLibre map
 */
export function quickSymbologyResolver(map: MaplibreMap) {
  let warned = false;

  function loadChild(map: MaplibreMap, name: string): ChildImage | undefined {
    if (!name || !resolve(name)) return undefined;

    const img = map.getImage(name);
    if (!img) return undefined;

    const src = img.data;
    const pixels = new Uint8ClampedArray(src.data.length);
    pixels.set(src.data as ArrayLike<number>);
    const { g } = createContext2D(
      src.width / img.pixelRatio,
      src.height / img.pixelRatio,
      img.pixelRatio,
    );
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
      const p = decodeParameters(registered.spec, params);

      const image = renderImpl(
        map,
        defaultPixelRatio(),
        (name) => loadChild(map, name),
        registered,
        p,
      );

      map.addImage(id, image.image, {
        pixelRatio: image.pixelRatio,
        sdf: image.sdf,
      });
    } catch (err) {
      console.error(`quick-symbology: failed to render "${id}"`, err);
    }
  }

  return resolve;
}

export interface OutlineOptions {
  /** Default 'none'. 'none' disables the outline. */
  outlineColor?: Value<string>;

  /** Default 1. 0 disables the outline. */
  outlineWidth?: Value<number>;
}

const outlineOpts = {
  outlineColor: { type: "string", default: "none" },
  outlineWidth: { type: "number", default: 1, min: 0 },
} as const;

function drawOutline(
  g: Ctx2D,
  { outlineWidth, outlineColor }: SymbologyParameters<typeof outlineOpts>,
) {
  if (
    outlineWidth &&
    outlineWidth > 0 &&
    outlineColor &&
    outlineColor !== "none"
  ) {
    g.lineWidth = outlineWidth;
    g.strokeStyle = outlineColor ?? "#ffffff";
    g.stroke();
  }
}

export interface MarkerOptions extends OutlineOptions {
  /** Fill color of the pin body. */
  color?: Value<string>;

  /** Width of the pin in px. Default 24. Use `icon-anchor: 'bottom'` on the layer. */
  width?: Value<number>;

  /** Height of the pin in px. Default 36. Use `icon-anchor: 'bottom'` on the layer. */
  height?: Value<number>;

  /** Color of the inner dot. Default '#ffffff'; 'none' removes it. */
  dotColor?: Value<string>;

  /** Radius of the inner dot as a fraction of the width. Default 0.42. */
  dotRadius?: Value<number>;
}

const markerOpts = {
  color: { type: "string", default: "#3887be" },
  width: { type: "number", default: 24 },
  height: { type: "number", default: 36 },
  ...outlineOpts,
  dotColor: { type: "string", default: "#ffffff" },
  dotRadius: { type: "number", default: 0.42 },
} as const;

/**
 * A pin marker icon.
 *
 * @param opts Symbology options
 * @returns A MapLibre resolvedImage expression
 */
export function marker(opts?: MarkerOptions) {
  const symbology: Symbology<typeof markerOpts> = {
    spec: markerOpts,

    size: ({ width, height, outlineWidth }, rc) => {
      return { width: width + outlineWidth, height: height + outlineWidth };
    },

    render: (params, rc) => {
      const g = rc.g;

      const {
        width,
        height,
        outlineWidth,
        color,
        outlineColor,
        dotColor,
        dotRadius,
      } = params;

      const pad = outlineWidth / 2 + 0.5;
      const cx = (width + outlineWidth) / 2;
      const r = width / 2;
      const cy = pad + r;
      const tipY = height - pad;
      // Angle at the circle's center between the tip direction and each tangent point.
      const a = Math.acos(r / (tipY - cy));

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
      drawOutline(g, { outlineWidth, outlineColor });
      if (dotColor !== "none" && dotRadius > 0) {
        g.beginPath();
        g.arc(cx, cy, r * dotRadius, 0, Math.PI * 2);
        g.fillStyle = dotColor;
        g.fill();
      }
    },
  };

  return registerSymbology("marker", symbology)(opts);
}

export interface StripesOptions {
  /** Bands in order; the tile repeats after the last one. `width` is in px. */
  stripes?: ReadonlyArray<{ color?: Value<string>; width?: Value<number> }>;

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

/**
 * A horizontal or vertical stripe texture.
 *
 * @param opts Symbology options
 * @returns A MapLibre resolvedImage expression
 */
export function stripes(opts?: StripesOptions) {
  const symbology: Symbology<typeof stripesOpts> = {
    spec: stripesOpts,

    size: ({ stripes, direction }, rc) => {
      const bands = stripes;
      const horizontal = direction === "horizontal";

      const px = bands.map((b) =>
        Math.max(1, Math.round(b.width * rc.pixelRatio)),
      );
      const total = px.reduce((sum, w) => sum + w, 0);
      const size = total / rc.pixelRatio;
      return {
        resizable: true,
        ...(horizontal
          ? { width: 1, height: size }
          : { width: size, height: 1 }),
      };
    },

    render: ({ stripes, direction }, rc) => {
      const g = rc.g;
      const bands = stripes;
      const horizontal = direction === "horizontal";

      // Work in whole device pixels so the tile repeats without seams.
      const px = bands.map((b) =>
        Math.max(1, Math.round(b.width * rc.pixelRatio)),
      );
      const total = px.reduce((sum, w) => sum + w, 0);
      const size = total / rc.pixelRatio;
      const [width, height] = [rc.width, rc.height];

      for (
        let offset = 0;
        offset < (horizontal ? height : width);
        offset += size
      ) {
        let pos = offset;
        bands.forEach((b, i) => {
          if (pos >= (horizontal ? height : width)) {
            return;
          }

          g.fillStyle = b.color;
          const bandWidth = px[i] / rc.pixelRatio;

          if (horizontal) {
            g.fillRect(0, pos, width, Math.min(bandWidth, height - pos));
          } else {
            g.fillRect(pos, 0, Math.min(bandWidth, width - pos), height);
          }

          pos += bandWidth;
        });
      }
    },
  };

  return registerSymbology("stripes", symbology)(opts);
}

export interface StackOptions {
  /** The images to stack */
  items: ReadonlyArray<Value<string>>;
}

const stackOpts = {
  items: {
    type: "array",
    node: "s",
    fields: {
      item: { type: "image", default: "" },
    },
    default: [],
  },
} as const;

export function stack(opts?: StackOptions) {
  const symbology: Symbology<typeof stackOpts> = {
    spec: stackOpts,

    size: ({ items }, rc) => {
      const widths = items.map(
        (item) => rc.resolveChild(item.item)?.width ?? 0,
      );
      const heights = items.map(
        (item) => rc.resolveChild(item.item)?.height ?? 0,
      );

      return {
        width: Math.max(1, ...widths),
        height: Math.max(1, ...heights),
        resizable: true,
      };
    },

    render: ({ items }, rc: RenderContext) => {
      const g = rc.g;
      const children = items
        .map((item) => rc.resolveChild(item.item))
        .filter((x) => !!x);

      children.forEach((child) => {
        if (!child) {
          return;
        }

        g.save();

        if (child.resizable) {
          child.paint(g, rc.width, rc.height);
        } else {
          g.translate(
            (rc.width - child.width) / 2,
            (rc.height - child.height) / 2,
          );
          child.paint(g, child.width, child.height);
        }

        g.restore();
      });
    },
  };

  return registerSymbology(
    "stack",
    symbology,
  )(opts && { items: opts.items.map((item) => ({ item })) });
}

export interface GridOptions {
  /** The width of the grid lines */
  lineWidth?: Value<number>;

  /** The color of the grid lines */
  color?: Value<string>;

  /**
   * The spacing between grid lines, not including the line width.
   *
   * If an object is provided, it should have `horizontal` and `vertical` properties specifying the respective spacings.
   */
  spacing?:
    | Value<number>
    | { horizontal: Value<number>; vertical: Value<number> };
}

/**
 * A grid of horizontal and vertical lines.
 *
 * This is a convenience function; you can achieve the same effect, and more, by stacking multiple `stripe()` textures using `stack()`.
 *
 * @param opts Symbology options
 * @returns A MapLibre resolvedImage expression
 */
export function grid(opts?: GridOptions) {
  const [horizontalSpacing, verticalSpacing] =
    typeof opts?.spacing === "object" &&
    opts?.spacing !== null &&
    !Array.isArray(opts?.spacing)
      ? [opts.spacing.horizontal, opts.spacing.vertical]
      : [opts?.spacing, opts?.spacing];

  return stack({
    items: [
      stripes({
        stripes: [
          { color: opts?.color, width: opts?.lineWidth },
          { color: "transparent", width: horizontalSpacing },
        ],
      }),
      stripes({
        stripes: [
          { color: opts?.color, width: opts?.lineWidth },
          { color: "transparent", width: verticalSpacing },
        ],
        direction: "vertical",
      }),
    ],
  });
}

export interface CircleOptions extends OutlineOptions {
  /** Radius in px */
  radius: Value<number>;

  /** The color of the dot */
  color: Value<string>;
}

const circleOptions = {
  radius: { type: "number", default: 6, min: 0.5, max: 256 },
  color: { type: "string", default: "#000000" },
  ...outlineOpts,
} as const;

/**
 * A filled circle icon.
 *
 * @param opts Symbology options
 * @returns A MapLibre resolvedImage expression
 */
export function circle(opts?: CircleOptions) {
  const symbology: Symbology<typeof circleOptions> = {
    spec: circleOptions,

    size: ({ radius, outlineWidth }) => ({
      width: radius * 2 + outlineWidth,
      height: radius * 2 + outlineWidth,
    }),

    render: ({ radius, color, outlineWidth, outlineColor }, rc) => {
      const size = radius * 2 + outlineWidth;

      const g = rc.g;
      g.beginPath();
      g.arc(size / 2, size / 2, radius, 0, Math.PI * 2);

      g.fillStyle = color;
      g.fill();

      drawOutline(g, { outlineWidth, outlineColor });
    },
  };
  return registerSymbology("circle", symbology)(opts);
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

/**
 * A texture composed of a grid of repeated icons.
 *
 * @param opts Symbology options
 * @returns A MapLibre resolvedImage expression
 */
export function iconGrid(opts: IconGridOptions) {
  const symbology: Symbology<typeof iconGridOptions> = {
    spec: iconGridOptions,

    size: ({ horizontalSpacing, verticalSpacing }) => ({
      width: horizontalSpacing,
      height: verticalSpacing,
    }),

    render: (
      { horizontalSpacing, verticalSpacing, icon },
      rc: RenderContext,
    ) => {
      const g = rc.g;
      const w = horizontalSpacing;
      const h = verticalSpacing;

      const child = rc.resolveChild(icon);
      if (!child) return;

      g.save();
      const cx = (w - child.width) / 2;
      const cy = (h - child.height) / 2;
      g.translate(cx, cy);

      // Draw the neighbors too so icons larger than a cell wrap around the tile edges.
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          g.save();
          g.translate(dx * w, dy * h);
          child.paint(g, child.width, child.height);
          g.restore();
        }
      }
      g.restore();
    },
  };

  return registerSymbology("iconGrid", symbology)(opts);
}

export interface StarOptions extends OutlineOptions {
  /**
   * The number of points on the star.
   */
  points?: Value<number>;

  /**
   * The rotation of the star clockwise in radians. The default is 0, meaning one point of the star points upwards.
   */
  rotation?: Value<number>;

  /**
   * The distance from the center of the star to the inner vertices.
   */
  innerRadius?: Value<number>;

  /**
   * The distance from the center of the star to the outer vertices.
   */
  outerRadius?: Value<number>;

  /**
   * The corner radius to round the inner vertices.
   */
  innerCornerRadius?: Value<number>;

  /**
   * The corner radius to round the outer vertices.
   */
  outerCornerRadius?: Value<number>;

  /**
   * The fill color of the star.
   */
  color?: Value<string>;
}

const starOptions = {
  points: { type: "number", default: 5, min: 3 },
  rotation: { type: "number", default: 0 },
  innerRadius: { type: "number", default: 6 },
  outerRadius: { type: "number", default: 12 },
  innerCornerRadius: { type: "number", default: 0 },
  outerCornerRadius: { type: "number", default: 0 },
  color: { type: "string", default: "#000000" },
  ...outlineOpts,
} as const;

interface RoundedVertex {
  /** Vertex position. The rounded corner passes through this point. */
  x: number;
  y: number;
  /** Unit vector pointing outward from the polygon center at this vertex. */
  ux: number;
  uy: number;
  cornerRadius: number;
  /** True if the vertex points outward (convex), false if concave. */
  convex: boolean;
}

/**
 * Traces a closed path (clockwise on screen) through the vertices, rounding
 * each corner with a circular arc of the given radius whose apex passes
 * through the vertex. Edges are tangent to the arcs.
 */
function roundedPolygonPath(g: Ctx2D, vertices: RoundedVertex[]) {
  const n = vertices.length;
  const circles = vertices.map((v) => {
    const s = v.convex ? 1 : -1;
    return {
      cx: v.x - s * v.ux * v.cornerRadius,
      cy: v.y - s * v.uy * v.cornerRadius,
      r: v.cornerRadius,
      s,
    };
  });

  // Angle offset of the tangent point on circle c as seen from point p.
  const tangent = (c: (typeof circles)[number], px: number, py: number) => {
    const d = Math.hypot(px - c.cx, py - c.cy);
    return {
      angle: Math.atan2(py - c.cy, px - c.cx),
      alpha: Math.acos(Math.min(1, c.r / d)),
    };
  };

  g.beginPath();
  for (let i = 0; i < n; i++) {
    const v = vertices[i];
    const c = circles[i];
    if (c.r <= 0) {
      if (i === 0) g.moveTo(v.x, v.y);
      else g.lineTo(v.x, v.y);
      continue;
    }
    const prev = vertices[(i + n - 1) % n];
    const next = vertices[(i + 1) % n];
    const a = tangent(c, prev.x, prev.y);
    const b = tangent(c, next.x, next.y);
    g.arc(
      c.cx,
      c.cy,
      c.r,
      a.angle + c.s * a.alpha,
      b.angle - c.s * b.alpha,
      c.s < 0,
    );
  }
  g.closePath();
}

export function star(opts?: StarOptions) {
  const symbology: Symbology<typeof starOptions> = {
    spec: starOptions,

    size: ({ outerRadius, outlineWidth }) => ({
      width: outerRadius * 2 + outlineWidth,
      height: outerRadius * 2 + outlineWidth,
    }),

    render: (
      {
        points,
        rotation,
        innerRadius,
        outerRadius,
        innerCornerRadius,
        outerCornerRadius,
        color,
        outlineWidth,
        outlineColor,
      },
      rc,
    ) => {
      const g = rc.g;
      const w = outerRadius * 2 + outlineWidth;
      const h = outerRadius * 2 + outlineWidth;

      g.save();
      g.translate(w / 2, h / 2);

      const vertices: RoundedVertex[] = [];
      for (let i = 0; i < points * 2; i++) {
        const angle = (i * Math.PI) / points - Math.PI / 2 + rotation;
        const outer = i % 2 === 0;
        const radius = outer ? outerRadius : innerRadius;
        vertices.push({
          x: radius * Math.cos(angle),
          y: radius * Math.sin(angle),
          ux: Math.cos(angle),
          uy: Math.sin(angle),
          cornerRadius: outer ? outerCornerRadius : innerCornerRadius,
          convex: outer,
        });
      }
      roundedPolygonPath(g, vertices);

      g.fillStyle = color;
      g.fill();

      drawOutline(g, { outlineWidth, outlineColor });

      g.restore();
    },
  };

  return registerSymbology("star", symbology)(opts);
}
