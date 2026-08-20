import fs from "node:fs";
import path from "node:path";

// KaTeX ships woff2, woff, and ttf for each face. Chrome 70 supports woff2, and
// the production Shell never fetches sibling font files, so the stylesheet that
// lands in app.js must contain only data-URL woff2 sources.

const FALLBACK_SRC =
  /,\s*url\(fonts\/[^)]*\.woff\)\s*format\(["']woff["']\)|,\s*url\(fonts\/[^)]*\.ttf\)\s*format\(["']truetype["']\)/g;
const WOFF2_SRC = /url\((fonts\/[^)]+\.woff2)\)/g;

export function prepareKatexCss(css: string, cssFilePath: string): string {
  const cssDir = path.dirname(cssFilePath);
  const withoutFallbacks = css.replace(FALLBACK_SRC, "");
  const inlined = withoutFallbacks.replace(
    WOFF2_SRC,
    (_match, relPath: string) => {
      const fontPath = path.join(cssDir, relPath);
      const bytes = fs.readFileSync(fontPath);
      return `url(data:font/woff2;base64,${bytes.toString("base64")})`;
    },
  );
  if (inlined.includes("url(fonts/")) {
    throw new Error(
      `KaTeX CSS still has relative font URLs after inlining (${cssFilePath})`,
    );
  }
  return inlined;
}
