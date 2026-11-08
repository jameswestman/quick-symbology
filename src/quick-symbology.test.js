import { test } from "node:test";
import assert from "node:assert/strict";
import {
  circle,
  iconGrid,
  marker,
  quickSymbologyResolver,
  registerSymbology,
  renderSymbol,
  stripes,
} from "../dist/quick-symbology.js";

const canvases = [];

globalThis.OffscreenCanvas = class {
  constructor(width, height) {
    this.width = width;
    this.height = height;
    this.calls = [];
    canvases.push(this);
  }

  getContext() {
    const canvas = this;
    return {
      canvas,
      scale: (...args) => canvas.calls.push(["scale", ...args]),
      setTransform: (...args) => canvas.calls.push(["setTransform", ...args]),
      beginPath() {},
      moveTo() {},
      lineTo() {},
      arc() {},
      closePath() {},
      fill() {},
      stroke() {},
      set lineWidth(value) {
        canvas.calls.push(["lineWidth", value]);
      },
      fillRect: (...args) => canvas.calls.push(["fillRect", ...args]),
      drawImage: (...args) => canvas.calls.push(["drawImage", ...args]),
      putImageData: (...args) => canvas.calls.push(["putImageData", ...args]),
      getImageData: () => ({ width: canvas.width, height: canvas.height }),
    };
  }
};

test("renders literal symbols at the requested pixel ratio", () => {
  const icon = renderSymbol(circle({ radius: 3, color: "red" }), {
    pixelRatio: 2,
  });
  assert.equal(icon.image.width, 12);
  assert.equal(icon.image.height, 12);
  assert.equal(icon.pixelRatio, 2);
  assert.deepEqual(canvases.at(-1).calls[0], ["scale", 2, 2]);

  const pin = renderSymbol(marker({ color: "blue", width: 16, height: 25 }), {
    pixelRatio: 1,
  });
  assert.equal(pin.image.width, 16);
  assert.equal(pin.image.height, 25);

  const bands = renderSymbol(
    stripes({
      stripes: [
        { color: "red", width: 2 },
        { color: "blue", width: 3 },
      ],
    }),
    { pixelRatio: 2 },
  );
  assert.equal(bands.image.width, 10);
  assert.equal(
    canvases.at(-1).calls.filter(([name]) => name === "fillRect").length,
    2,
  );
});

test("renders nested generated images and resolves external images", () => {
  const child = circle({ radius: 3, color: "red" });
  const tile = iconGrid({
    horizontalSpacing: 16,
    verticalSpacing: 12,
    icon: child,
  });
  const result = renderSymbol(tile, { pixelRatio: 2 });
  assert.equal(result.image.width, 32);
  assert.equal(result.image.height, 24);
  const calls = canvases.at(-1).calls.filter(([name]) => name === "drawImage");
  assert.equal(calls.length, 9);
  assert.deepEqual(calls[4].slice(2), [5, 3, 6, 6]);

  const source = {};
  const external = iconGrid({
    horizontalSpacing: 16,
    verticalSpacing: 12,
    icon: "custom",
  });
  renderSymbol(external, {
    resolve: (name) =>
      name === "custom" ? { source, width: 4, height: 6 } : undefined,
  });
  assert.equal(
    canvases.at(-1).calls.filter(([name]) => name === "drawImage")[0][1],
    source,
  );
});

test("rejects dynamic expressions and invalid options", () => {
  assert.throws(
    () => renderSymbol(circle({ radius: 3, color: ["get", "color"] })),
    /static image expression/,
  );
  assert.throws(() => renderSymbol(["image", "unknown"]), /no renderer/);
  assert.throws(
    () => renderSymbol(circle({ radius: 3, color: "red" }), { pixelRatio: 0 }),
    /pixelRatio/,
  );
});

test("custom symbology encodes expressions and normalizes parameters for both resolvers", () => {
  const received = [];
  const renderer = (params, context) => {
    received.push(params);
    return context.draw(1, 1, () => {});
  };
  const custom = registerSymbology(
    "test-custom",
    {
      size: { type: "number", default: 5, min: 2, max: 10 },
      color: { type: "string", default: "black", optional: true },
      direction: {
        type: "enum",
        values: ["up", "down"],
        default: "up",
        optional: true,
      },
      items: {
        type: "array",
        node: "item",
        fields: {
          width: { type: "number", default: 3, min: 1, max: 8 },
        },
      },
      icon: { type: "image", default: "" },
    },
    renderer,
  );
  const expression = custom({
    size: 20,
    direction: "invalid",
    items: [{ width: 0 }],
    icon: circle({ radius: 3, color: "red" }),
  });
  renderSymbol(expression);
  assert.deepEqual(received[0], {
    size: 10,
    color: "black",
    direction: "up",
    items: [{ width: 1 }],
    icon: circle({ radius: 3, color: "red" })[1],
  });
  const added = [];
  const map = {
    hasImage: () => false,
    addImage: (...args) => added.push(args),
  };
  quickSymbologyResolver(map)(expression[1]);
  assert.deepEqual(received[1], received[0]);
  assert.equal(added[0][0], expression[1]);
  renderSymbol([
    "image",
    "qs⟨test-custom¦size=bad¦items=⟨item¦width=NaN⟩¦icon=custom⟩",
  ]);
  assert.deepEqual(received[2], {
    size: 5,
    color: "black",
    direction: "up",
    items: [{ width: 3 }],
    icon: "custom",
  });
  const dynamic = custom({ size: ["get", "size"], items: [], icon: "custom" });
  assert.deepEqual(dynamic[1][2], ["to-string", ["get", "size"]]);
});

test("duplicate registration preserves the renderer unless overwrite is requested", () => {
  const spec = { size: { type: "number", default: 1 } };
  const first = () => ({ image: {}, pixelRatio: 1 });
  const second = () => ({ image: {}, pixelRatio: 2 });

  const firstReg = registerSymbology("test-duplicate", spec, first);
  assert.equal(
    renderSymbol(firstReg()).pixelRatio,
    1,
    "should register the symbology",
  );

  const secondReg = registerSymbology("test-duplicate", spec, second);
  assert.equal(
    renderSymbol(secondReg()).pixelRatio,
    1,
    "should not overwrite the existing registration",
  );

  const overwriteReg = registerSymbology("test-duplicate", spec, second, true);
  assert.equal(
    renderSymbol(firstReg()).pixelRatio,
    2,
    "should overwrite the existing registration",
  );

  assert.throws(
    () => registerSymbology("invalid=type", spec, first),
    /invalid icon type/,
    "should throw for invalid character in icon type",
  );
});

test("built-in specs apply dependent limits and empty array defaults", () => {
  const circleIcon = renderSymbol(circle({ color: "red", radius: 1000 }));
  assert.equal(
    circleIcon.image.width,
    512,
    "maximum should be applied to circle radius",
  );

  const stripesIcon = renderSymbol(stripes({ stripes: [] }));
  assert.equal(stripesIcon.image.width, 1);
  assert.equal(
    canvases.at(-1).calls.filter(([name]) => name === "fillRect").length,
    1,
  );
});
