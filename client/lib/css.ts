export function vh(x: number) {
  return `calc(var(--vh, 1vh) * ${x});`;
}

export function inset(x: number) {
  return { top: x, bottom: x, left: x, right: x } as const;
}

/** CSS min()/max() fallback for Chrome 70, usable directly in MUI sx. */
export function cssMin(
  property: "maxHeight" | "paddingTop" | "paddingBottom",
  fallback: string,
  expression: string,
) {
  const cssProperty = property.replace(
    /[A-Z]/g,
    (letter) => `-${letter.toLowerCase()}`,
  );
  return {
    [property]: fallback,
    [`@supports (${cssProperty}: ${expression})`]: { [property]: expression },
  } as const;
}

/** Flexbox gap fallback; Chrome 70 supports grid gap but not flex gap. */
export function flexGap(
  gap: number | string,
  direction: "row" | "column" = "row",
) {
  const margin = direction === "row" ? "marginLeft" : "marginTop";
  return {
    gap,
    "@supports not (gap: 1px)": {
      "& > :not(style) ~ :not(style)": { [margin]: gap },
    },
  } as const;
}
