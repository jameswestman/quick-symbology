# Quick Symbology

Easy, data-driven symbology for your MapLibre maps.

[Go to the Gallery page to see some examples!](https://jameswestman.github.io/quick-symbology/)

## What It Does

Quick Symbols generates symbols and patterns on demand using MapLibre's [`MissingStyleImageResolver`](https://maplibre.org/maplibre-gl-js/docs/API/type-aliases/MissingStyleImageResolver/) feature. Symbology can be data-driven without pre-generating every possible symbol image.

## How It Works

The Quick Symbols functions return a MapLibre expression which can be used anywhere MapLibre expects a `resolvedImage`, including [`icon-image`](https://maplibre.org/maplibre-style-spec/layers/#icon-image) and [`fill-pattern`](https://maplibre.org/maplibre-style-spec/layers/#fill-pattern). These expressions encode the symbol parameters as a string, which is parsed by the `MissingStyleImageResolver` and rendered.

To enable tree-shaking, each symbology function registers its render function when it is called. Only the code to render symbols you actually use is included in your application.

## Usage

```typescript
import { quickSymbologyResolver, marker } from "quick-symbology";

const qsResolver = quickSymbologyResolver(map);
map.setMissingStyleImageResolver(qsResolver);

/* If you have other libraries that add resolvers, you can do it like this: */
map.setMissingStyleImageResolver(async (id: string) => {
	await qsResolver(id);
	await /* other resolvers... */;
});

/* In versions of MapLibre prior to 6.0, use the styleimagemissing event instead: */
map.on('styleimagemissing', (event) => {
  qsResolver(event.id);
});


map.addLayer({
	id: 'markers',
	type: 'symbol',
	source: 'my-source',
	layout: {
		'icon-image': marker({
			color: ['get', 'marker-color'],
		})
	}
})
```

## Custom Symbology

Define a custom symbol with `registerSymbology`, providing a unique ID, a parameter specification, and a renderer. The returned function accepts literals or MapLibre expressions and registers the renderer when called.

```typescript
import { registerSymbology } from "quick-symbology";

const customCircle = registerSymbology(
  "custom-circle",
  {
    color: { type: "string", default: "#000000" },
    radius: { type: "number", default: 3, min: 0.5, max: 256 },
  },
  ({ color, radius }, rc) => {
    const size = radius * 2;

    return rc.draw(size, size, function (g) {
      g.beginPath();
      g.arc(size / 2, size / 2, radius, 0, Math.PI * 2);
      g.fillStyle = color;
      g.fill();
    });
  },
);

const expression = customCircle({ color: ["get", "color"], radius: 5 });
```

Renderers receive decoded values, with defaults, numeric bounds, and enum validation already applied. Specs support `string`, `number`, `enum` (`values` and `default`), `image` (an image name or symbology expression), and `array` (`node` and nested `fields`). An array may provide a `default` used when it contains no decoded nodes. Pass `true` as the fourth argument to replace an existing registration when the returned function is called.

## Rendering Without MapLibre

Use `renderSymbol` with a symbology result containing only literal values. It returns an object with `image` (`ImageData`), `pixelRatio`, and an optional `sdf` flag. Rendering requires a browser or another environment providing a 2D canvas.

```ts
import { circle, iconGrid, renderSymbol } from "quick-symbology";

const icon = renderSymbol(
  iconGrid({
    horizontalSpacing: 16,
    verticalSpacing: 16,
    icon: circle({ radius: 3, color: "red" }),
  }),
  { pixelRatio: 2 },
);
const canvas = document.createElement("canvas");
canvas.width = icon.image.width;
canvas.height = icon.image.height;
canvas.getContext("2d")!.putImageData(icon.image, 0, 0);
```

`pixelRatio` defaults to the device pixel ratio rounded up. For a grid using a named external image, provide `resolve(name)` to return a `ChildImage` with a drawable `source` and its logical width and height. Unresolved child images render as empty. Dynamic MapLibre expressions are not supported and cause `renderSymbology` to throw. Custom renderers receive `context.map` as `undefined` when called this way.
