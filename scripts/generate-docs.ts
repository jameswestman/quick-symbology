import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { parse } from "@babel/parser";
import type { Node } from "@babel/types";

type Example = { label: string; expression: string; texture?: boolean };
type ExampleSet = { examples: Example[] };

const examples: Record<string, ExampleSet> = {
  marker: {
    examples: [
      {
        label: "Blue pin",
        expression: 'marker({ color: "#3887be", outlineColor: "white" })',
      },
      {
        label: "Plain coral pin",
        expression:
          'marker({ color: "#df654d", dotColor: "none", width: 32, height: 48 })',
      },
    ],
  },
  circle: {
    examples: [
      {
        label: "Small circle",
        expression: 'circle({ radius: 4, color: "#176b58" })',
      },
      {
        label: "Large circle",
        expression:
          'circle({ radius: 10, color: "#d25440", outlineColor: "#11947c" })',
      },
    ],
  },
  stripes: {
    examples: [
      {
        label: "Horizontal bands",
        expression:
          'stripes({ stripes: [{ color: "#315f8a", width: 4 }, { color: "#f4d57a", width: 4 }] })',
        texture: true,
      },
      {
        label: "Vertical bands",
        expression:
          'stripes({ direction: "vertical", stripes: [{ color: "#d25440", width: 3 }, { color: "transparent", width: 6 }] })',
        texture: true,
      },
    ],
  },
  grid: {
    examples: [
      {
        label: "Basic grid",
        expression: 'grid({ lineWidth: 2, color: "#512eb9", spacing: 9 })',
        texture: true,
      },
      {
        label: "Non-square grid",
        expression:
          'grid({ lineWidth: 2, color: "#948069", spacing: { horizontal: 16, vertical: 32 } })',
        texture: true,
      },
    ],
  },
  iconGrid: {
    examples: [
      {
        label: "Dot grid",
        expression:
          'iconGrid({ horizontalSpacing: 12, verticalSpacing: 12, icon: circle({ radius: 3, color: "#176b58" }) })',
        texture: true,
      },
      {
        label: "Pin grid",
        expression:
          'iconGrid({ horizontalSpacing: 36, verticalSpacing: 42, icon: marker({ color: "#d25440", width: 16, height: 24 }) })',
        texture: true,
      },
    ],
  },
  stack: {
    examples: [
      {
        label: "Stacked icons",
        expression:
          'stack({ items: [circle({ radius: 20, color: "#176b58" }), marker({ color: "#d25440", width: 16, height: 24 })] })',
      },
      {
        label: "Stacked textures",
        expression:
          'stack({ items: [stripes({ stripes: [{ color: "#315f8a", width: 2 }, { color: "transparent", width: 10 }] }), stripes({ stripes: [{ color: "#d25440", width: 2 }, { color: "transparent", width: 10 }], direction: "vertical" })] })',
        texture: true,
      },
    ],
  },
};

const root = resolve(import.meta.dirname, "..");

function getArgument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;

  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`Expected a value after ${name}`);
  }
  return value;
}

const output = resolve(root, getArgument("--output") ?? "docs/docs.html");
const modulePath = relative(
  dirname(output),
  join(root, "dist/quick-symbology.js"),
)
  .split(sep)
  .join("/");
const moduleSpecifier =
  getArgument("--import") ??
  (modulePath.startsWith(".") ? modulePath : `./${modulePath}`);
const sourceText = readFileSync(
  join(root, "src", "quick-symbology.ts"),
  "utf8",
);
const source = parse(sourceText, {
  sourceType: "module",
  plugins: ["typescript"],
});

const functions = new Map(
  source.program.body.flatMap((statement) => {
    const declaration =
      statement.type === "ExportNamedDeclaration"
        ? statement.declaration
        : statement;

    return declaration?.type === "FunctionDeclaration" && declaration.id
      ? [[declaration.id.name, declaration.body] as const]
      : [];
  }),
);

function callsRegister(node: unknown, visited = new Set<string>()): boolean {
  if (!node || typeof node !== "object") return false;
  if (Array.isArray(node))
    return node.some((child) => callsRegister(child, visited));

  const object = node as Record<string, unknown>;
  const callee = object.callee as Record<string, unknown> | undefined;

  if (object.type === "CallExpression" && callee?.type === "Identifier") {
    if (callee.name === "registerSymbology") return true;
    if (typeof callee.name === "string" && !visited.has(callee.name)) {
      visited.add(callee.name);
      if (callsRegister(functions.get(callee.name), visited)) return true;
    }
  }

  return Object.values(object).some((child) => callsRegister(child, visited));
}

const symbologyNames: string[] = [];
const symbologyDescriptions: Record<string, string> = {};

for (const statement of source.program.body) {
  if (statement.type !== "ExportNamedDeclaration" || !statement.declaration)
    continue;

  const declaration = statement.declaration;
  if (
    declaration.type === "FunctionDeclaration" &&
    declaration.id &&
    callsRegister(declaration.body)
  ) {
    symbologyNames.push(declaration.id.name);

    const comment =
      statement.leadingComments
        ?.filter(
          (item) => item.type === "CommentBlock" && item.value.startsWith("*"),
        )
        .at(-1)?.value ?? "";
    const lines = comment
      .replace(/^\*/, "")
      .split("\n")
      .map((line) => line.replace(/^\s*\*\s?/, "").trim());
    const tagIndex = lines.findIndex((line) => line.startsWith("@"));
    symbologyDescriptions[declaration.id.name] = lines
      .slice(0, tagIndex < 0 ? lines.length : tagIndex)
      .join(" ")
      .trim();
  }
}

if (symbologyNames.length === 0) {
  throw new Error("No symbologies found in quick-symbology.ts");
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

type NodeWithRange = Node & { start: number; end: number };

function isNodeWithRange(value: unknown): value is NodeWithRange {
  return (
    !!value &&
    typeof value === "object" &&
    "type" in value &&
    typeof value.type === "string" &&
    "start" in value &&
    typeof value.start === "number" &&
    "end" in value &&
    typeof value.end === "number"
  );
}

function formatType(node: Node): string {
  if (!isNodeWithRange(node)) {
    throw new Error(`Cannot format ${node.type} without source positions`);
  }

  if (
    node.type === "TSTypeReference" &&
    node.typeName.type === "Identifier" &&
    node.typeArguments?.params[0]
  ) {
    const parameter = node.typeArguments.params[0];
    if (node.typeName.name === "Value") return formatType(parameter);
    if (node.typeName.name === "ReadonlyArray") {
      const elementType = formatType(parameter);
      const needsParentheses = [
        "TSUnionType",
        "TSIntersectionType",
        "TSConditionalType",
        "TSFunctionType",
        "TSConstructorType",
        "TSTypeOperator",
      ].includes(parameter.type);
      return `${needsParentheses ? `(${elementType})` : elementType}[]`;
    }
  }

  const start = node.start;
  const end = node.end;
  let text = sourceText.slice(start, end);

  const children = Object.values(node)
    .flatMap((value) => (Array.isArray(value) ? value : [value]))
    .filter(
      (value): value is NodeWithRange =>
        isNodeWithRange(value) && value.start >= start && value.end <= end,
    )
    .sort((left, right) => right.start - left.start);

  for (const child of children) {
    const childStart = child.start;
    const childEnd = child.end;
    text =
      text.slice(0, childStart - start) +
      formatType(child) +
      text.slice(childEnd - start);
  }

  return text;
}

const sections = symbologyNames
  .map((name) => {
    const config = examples[name];
    if (!config || config.examples.length === 0) {
      throw new Error(`Add examples for symbology ${name}`);
    }

    const optionsName = `${name[0].toUpperCase()}${name.slice(1)}Options`;
    const options = source.program.body
      .flatMap((statement) =>
        statement.type === "ExportNamedDeclaration" &&
        statement.declaration?.type === "TSInterfaceDeclaration"
          ? [statement.declaration]
          : [],
      )
      .find((declaration) => declaration.id.name === optionsName);
    if (!options) {
      throw new Error(`Cannot find ${optionsName}`);
    }

    const rows = options.body.body
      .filter((property) => property.type === "TSPropertySignature")
      .map((property) => {
        const comment =
          property.leadingComments
            ?.filter(
              (item) =>
                item.type === "CommentBlock" && item.value.startsWith("*"),
            )
            .at(-1)?.value ?? "";

        const description = comment
          .replace(/^\*/, "")
          .split("\n")
          .map((line) => line.replace(/^\s*\*\s?/, "").trim())
          .join(" ")
          .trim();

        const name = sourceText.slice(property.key.start!, property.key.end!);
        const type = property.typeAnnotation?.typeAnnotation;

        return `
          <tr>
            <th scope="row"><code>${escapeHtml(name)}</code></th>
            <td><code>${escapeHtml(type ? formatType(type) : "unknown")}</code></td>
            <td>${escapeHtml(description)}</td>
          </tr>`;
      })
      .join("\n");

    const previews = config.examples
      .map(
        (example, index) =>
          `
          <figure>
            <div class="preview${example.texture ? " texture" : ""}" id="${name}-${index}"></div>
            <figcaption>${escapeHtml(example.label)}</figcaption>
            <pre><code>${escapeHtml(example.expression)}</code></pre>
          </figure>`,
      )
      .join("\n");

    const textureExamples = config.examples.filter(
      (example) => example.texture,
    ).length;
    const kind =
      textureExamples === 0
        ? "Symbol"
        : textureExamples === config.examples.length
          ? "Texture"
          : "Mixed";

    return `
      <section id="${name}">
        <div class="section-heading">
          <h2>${name}</h2>
          <span>${kind}</span>
        </div>
        <p class="section-description">${escapeHtml(symbologyDescriptions[name] ?? "")}</p>
        <div class="examples">${previews}</div>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Option</th>
                <th>Type</th>
                <th>Description</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </section>`;
  })
  .join("\n");

const renderCalls = symbologyNames
  .flatMap((name) =>
    examples[name].examples.map((example, index) =>
      [
        `show(${JSON.stringify(`${name}-${index}`)}, () => ${example.expression.replaceAll("<", "\\u003c")}, ${!!example.texture});`,
        ...(index === 0
          ? [
              `show(${JSON.stringify(`${name}-nav-icon`)}, () => ${example.expression.replaceAll("<", "\\u003c")}, ${!!example.texture});`,
            ]
          : []),
      ].join("\n"),
    ),
  )
  .join("\n");

const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Quick Symbology Reference</title>
    <style>${readFileSync(join(root, "scripts/docstyle.css"), "utf-8")}</style>
  </head>
  <body>
    <header><h1>Quick Symbology</h1><p>Symbol and texture reference</p></header>

    <main>
      <nav aria-label="Symbologies">${symbologyNames.map((name) => `<a href="#${name}"><span class="nav-icon${examples[name].examples[0].texture ? " texture" : ""}" id="${name}-nav-icon"></span>${name}</a>`).join("")}</nav>${sections}
    </main>

    <script type="module">
      import { ${symbologyNames.join(", ")}, renderSymbol } from ${JSON.stringify(moduleSpecifier)};
      function show(id, createExpression, texture) {
        const preview = document.getElementById(id);
        try {
          const { image, pixelRatio } = renderSymbol(createExpression());
          const canvas = document.createElement("canvas");
          canvas.width = image.width;
          canvas.height = image.height;
          canvas.getContext("2d").putImageData(image, 0, 0);
          const logicalWidth = image.width / pixelRatio;
          const logicalHeight = image.height / pixelRatio;
          const navScale = preview.classList.contains("nav-icon")
            ? Math.min(1, 24 / Math.max(logicalWidth, logicalHeight))
            : 1;
          if (texture) {
            preview.style.backgroundImage = 'url("' + canvas.toDataURL() + '")';
            preview.style.backgroundSize = logicalWidth + 'px ' + logicalHeight + 'px';
          } else {
            canvas.style.width = (logicalWidth * navScale) + 'px';
            canvas.style.height = (logicalHeight * navScale) + 'px';
            preview.append(canvas);
          }
        } catch (error) {
          preview.classList.add("error");
          preview.textContent = 'Unable to render: ' + error.message;
          console.error(error);
        }
      }

      ${renderCalls}
    </script>
  </body>
</html>\n`;

writeFileSync(output, html);
console.log(`Generated ${output} for ${symbologyNames.length} symbologies.`);
