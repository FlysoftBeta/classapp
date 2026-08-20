import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";
import { visit } from "unist-util-visit";
import type { Plugin } from "unified";

import { STREAMDOWN_PLUGINS } from "@/client/components/ai/markdown";
import { prepareKatexCss } from "@/scripts/builds/katexCss";

const require = createRequire(import.meta.url);

function katexPackageDir(from = "."): string {
  return path.dirname(require.resolve("katex/package.json", { paths: [from] }));
}

function collectClasses(tree: unknown): string[] {
  const classes = new Set<string>();
  visit(
    tree as never,
    "element",
    (node: { properties?: { className?: unknown } }) => {
      const className = node.properties?.className;
      if (Array.isArray(className)) {
        for (const value of className) {
          if (typeof value === "string" && value) classes.add(value);
        }
      } else if (typeof className === "string") {
        for (const value of className.split(/\s+/)) {
          if (value) classes.add(value);
        }
      }
    },
  );
  return [...classes];
}

function applyConfiguredPlugin(
  processor: { use: (plugin: Plugin, ...parameters: unknown[]) => unknown },
  pluggable:
    | (typeof STREAMDOWN_PLUGINS.math)["remarkPlugin"]
    | (typeof STREAMDOWN_PLUGINS.math)["rehypePlugin"],
): void {
  if (Array.isArray(pluggable)) {
    processor.use(pluggable[0] as Plugin, pluggable[1]);
    return;
  }
  processor.use(pluggable as Plugin);
}

async function renderMathClasses(markdown: string): Promise<string[]> {
  const processor = unified().use(remarkParse);
  applyConfiguredPlugin(processor, STREAMDOWN_PLUGINS.math.remarkPlugin);
  processor.use(remarkRehype).use(rehypeSanitize, {
    ...defaultSchema,
    attributes: {
      ...defaultSchema.attributes,
      code: [...(defaultSchema.attributes?.code ?? []), "metastring"],
    },
  });
  applyConfiguredPlugin(processor, STREAMDOWN_PLUGINS.math.rehypePlugin);
  processor.compiler = (tree) => collectClasses(tree).join("\n");
  const output = String(await processor.process(markdown));
  return output === "" ? [] : output.split("\n");
}

function cssDefinesClass(css: string, className: string): boolean {
  return (
    css.includes(`.${className}{`) ||
    css.includes(`.${className},`) ||
    css.includes(`.${className} `)
  );
}

test("rehype-katex and the injected stylesheet resolve the same KaTeX package", () => {
  const stylesheetDir = katexPackageDir();
  const rendererDir = katexPackageDir(
    path.dirname(require.resolve("rehype-katex")),
  );
  assert.equal(rendererDir, stylesheetDir);
});

test("prepareKatexCss embeds woff2 fonts and drops woff/ttf fallbacks", () => {
  const cssPath = path.join(katexPackageDir(), "dist/katex.min.css");
  const prepared = prepareKatexCss(fs.readFileSync(cssPath, "utf8"), cssPath);
  assert.equal(prepared.includes("url(fonts/"), false);
  assert.equal(prepared.includes(".woff)"), false);
  assert.equal(prepared.includes(".ttf)"), false);
  assert.match(prepared, /url\(data:font\/woff2;base64,[A-Za-z0-9+/]+=*\)/);
  assert.equal((prepared.match(/data:font\/woff2;base64,/g) ?? []).length, 20);
});

test("block, inline, and fenced math emit KaTeX classes the stylesheet defines", async () => {
  const css = fs.readFileSync(
    path.join(katexPackageDir(), "dist/katex.min.css"),
    "utf8",
  );
  const samples = [
    "block $$\\frac{a}{b}$$",
    "inline $x^{2}$",
    "```math\n\\sum_{i=1}^{n} i\n```",
  ];
  for (const markdown of samples) {
    const classes = await renderMathClasses(markdown);
    assert.ok(classes.includes("katex"), markdown);
    const layoutClass = classes.includes("katex-base") ? "katex-base" : "base";
    const strutClass = classes.includes("katex-strut")
      ? "katex-strut"
      : "strut";
    assert.ok(
      classes.includes(layoutClass),
      `${markdown} missing ${layoutClass}`,
    );
    assert.ok(
      classes.includes(strutClass),
      `${markdown} missing ${strutClass}`,
    );
    assert.ok(
      cssDefinesClass(css, layoutClass),
      `.${layoutClass} missing from CSS`,
    );
    assert.ok(
      cssDefinesClass(css, strutClass),
      `.${strutClass} missing from CSS`,
    );
  }
});
