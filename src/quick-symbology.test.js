import { mock, test } from "node:test";
import assert from "node:assert/strict";
import {
  circle,
  grid,
  iconGrid,
  marker,
  quickSymbologyResolver,
  registerSymbology,
  renderSymbol,
  stack,
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
      save: (...args) => canvas.calls.push(["save", ...args]),
      restore: (...args) => canvas.calls.push(["restore", ...args]),
      translate: (...args) => canvas.calls.push(["translate", ...args]),
      setTransform: (...args) => canvas.calls.push(["setTransform", ...args]),
      beginPath() {},
      moveTo() {},
      lineTo() {},
      arc: (...args) => canvas.calls.push(["arc", ...args]),
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
  assert.equal(bands.image.width, 2);
  assert.equal(bands.image.height, 10);
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
  const before = canvases.length;
  const result = renderSymbol(tile, { pixelRatio: 2 });
  assert.equal(result.image.width, 32);
  assert.equal(result.image.height, 24);
  assert.equal(canvases.length - before, 1);
  const calls = canvases.at(-1).calls;
  assert.equal(calls.filter(([name]) => name === "drawImage").length, 0);
  assert.equal(calls.filter(([name]) => name === "arc").length, 9);
  assert.ok(
    calls.some(([name, x, y]) => name === "translate" && x === 5 && y === 3),
  );

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

test("stack draws nested icons at their logical dimensions", () => {
  renderSymbol(
    stack({
      items: [
        circle({ radius: 20, color: "green" }),
        marker({ width: 16, height: 24 }),
      ],
    }),
    { pixelRatio: 2 },
  );

  const calls = canvases.at(-1).calls;
  assert.equal(calls.filter(([name]) => name === "drawImage").length, 0);
  assert.deepEqual(
    calls.filter(([name]) => name === "translate"),
    [
      ["translate", 0, 0],
      ["translate", 12, 8],
    ],
  );
});

test("nested stripes fill the parent dimensions and repeat", () => {
  const before = canvases.length;
  const result = renderSymbol(
    stack({
      items: [
        circle({ radius: 5, color: "green" }),
        stripes({
          stripes: [
            { color: "red", width: 3 },
            { color: "blue", width: 2 },
          ],
        }),
      ],
    }),
    { pixelRatio: 2 },
  );
  assert.equal(canvases.length - before, 1);
  assert.equal(result.image.width, 20);
  assert.equal(result.image.height, 20);
  assert.deepEqual(
    canvases.at(-1).calls.filter(([name]) => name === "fillRect"),
    [
      ["fillRect", 0, 0, 10, 3],
      ["fillRect", 0, 3, 10, 2],
      ["fillRect", 0, 5, 10, 3],
      ["fillRect", 0, 8, 10, 2],
    ],
  );
});

test("grid fills both axes with independently sized stripe periods", () => {
  const result = renderSymbol(
    grid({
      lineWidth: 2,
      color: "black",
      spacing: {
        horizontal: 3,
        vertical: 6,
      },
    }),
  );
  assert.equal(result.image.width, 8);
  assert.equal(result.image.height, 5);
  assert.deepEqual(
    canvases.at(-1).calls.filter(([name]) => name === "fillRect"),
    [
      ["fillRect", 0, 0, 8, 2],
      ["fillRect", 0, 2, 8, 3],
      ["fillRect", 0, 0, 2, 5],
      ["fillRect", 2, 0, 6, 5],
    ],
  );
});

test("nested stacks pass dimensions through to their children", () => {
  renderSymbol(
    stack({
      items: [
        circle({ radius: 5, color: "red" }),
        stack({
          items: [
            stripes({
              direction: "vertical",
              stripes: [
                { color: "blue", width: 3 },
                { color: "transparent", width: 2 },
              ],
            }),
          ],
        }),
      ],
    }),
  );
  assert.deepEqual(
    canvases.at(-1).calls.filter(([name]) => name === "fillRect"),
    [
      ["fillRect", 0, 0, 3, 10],
      ["fillRect", 3, 0, 2, 10],
      ["fillRect", 5, 0, 3, 10],
      ["fillRect", 8, 0, 2, 10],
    ],
  );
});

test("child contexts receive parent dimensions in both resolvers", () => {
  const dimensions = [];
  const child = registerSymbology("test-child-dimensions", {
    spec: {},
    size: () => ({ width: 10, height: 10 }),
    render: (_, rc) => {
      dimensions.push([rc.width, rc.height]);
    },
  });

  const expression = stack({
    items: [circle({ radius: 5, color: "red" }), child()],
  });

  renderSymbol(expression);
  const added = [];

  const map = {
    hasImage: () => false,
    addImage: (...args) => added.push(args),
  };
  const before = canvases.length;
  quickSymbologyResolver(map)(expression[1]);
  assert.equal(canvases.length - before, 1);
  assert.equal(added.length, 1);
  assert.deepEqual(dimensions, [
    [10, 10],
    [10, 10],
  ]);
});

test("stack and grid use static image names when their inputs are literal", () => {
  const literalStack = stack({ items: [stripes({}), stripes({})] });
  assert.equal(literalStack[0], "image");
  assert.equal(typeof literalStack[1], "string");

  const dynamicStack = stack({
    items: [stripes({ stripes: [{ width: ["get", "line-width"] }] })],
  });
  assert.equal(dynamicStack[0], "image");
  assert.notEqual(typeof dynamicStack[1], "string");

  const literalGrid = grid({ lineWidth: 2, color: "black", spacing: 16 });
  assert.equal(literalGrid[0], "image");
  assert.equal(typeof literalGrid[1], "string");

  const dynamicGrid = grid({ lineWidth: ["get", "line-width"] });
  assert.equal(dynamicGrid[0], "image");
  assert.notEqual(typeof dynamicGrid[1], "string");
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
  const custom = registerSymbology("test-custom", {
    spec: {
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
    render: (params, context) => {
      received.push(params);
    },
    size: () => ({ width: 1, height: 1 }),
  });
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
  const size = () => ({ width: 1, height: 1 });
  const first = mock.fn();
  const second = mock.fn();

  const firstReg = registerSymbology("test-duplicate", {
    spec,
    render: first,
    size,
  });
  renderSymbol(firstReg());
  assert.equal(first.mock.callCount(), 1, "should call the render function");

  const secondReg = registerSymbology("test-duplicate", {
    spec,
    render: second,
    size,
  });
  renderSymbol(secondReg());
  assert.equal(
    first.mock.callCount(),
    2,
    "should still call the first render function",
  );

  registerSymbology(
    "test-duplicate",
    {
      spec,
      render: second,
      size,
    },
    true,
  );
  renderSymbol(secondReg());
  assert.equal(
    second.mock.callCount(),
    1,
    "should overwrite the existing registration",
  );
});

test("registerSymbology throws for invalid icon type", () => {
  const spec = { size: { type: "number", default: 1 } };
  const render = mock.fn();
  assert.throws(
    () => registerSymbology("invalid=type", { spec, render }),
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
