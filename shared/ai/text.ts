export function normalizeAiSearchText(value: string): string {
  return value
    .normalize("NFKC")
    .trim()
    .replace(/\s+/g, " ")
    .toLocaleLowerCase("en-US");
}

export function provisionalAiTitle(value: string): string {
  const compact = value.trim().replace(/\s+/g, " ");
  if (!compact) return "新对话";
  return compact.length <= 32 ? compact : `${compact.slice(0, 32)}…`;
}
