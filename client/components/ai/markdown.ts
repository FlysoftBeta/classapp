import { cjk } from "@streamdown/cjk";
import { createMathPlugin } from "@streamdown/math";
import { mermaid } from "@streamdown/mermaid";

// School answers use `$...$` inline TeX. The plugin default leaves those
// delimiters as prose, so fractions and exponents never reach KaTeX.
// Currency `$` amounts can therefore be parsed as math; that is accepted here.
export const STREAMDOWN_PLUGINS = {
  mermaid,
  math: createMathPlugin({
    singleDollarTextMath: true,
    errorColor: "#cc0000",
  }),
  cjk,
} as const;
