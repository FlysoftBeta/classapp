/** Binary storage unit sizes (bytes). */
const KIB = 1024;
const MIB = KIB * KIB;
const GIB = MIB * KIB;

const UNIT_MULTIPLIERS: Record<StorageUnit, number> = {
  B: 1,
  KB: KIB,
  MB: MIB,
  GB: GIB,
};

export type StorageUnit = "B" | "KB" | "MB" | "GB";

/** String literal for byte constants, e.g. `"200 MB"` or `"1.5 GB"`. */
export type BytesLiteral = `${number} ${StorageUnit}`;

/** Parse a byte constant string literal into bytes. */
export function bytes(literal: BytesLiteral): number {
  const trimmed = literal.trim();
  const space = trimmed.lastIndexOf(" ");
  if (space < 0) throw new Error(`Invalid bytes literal: ${literal}`);
  const amount = Number(trimmed.slice(0, space));
  const unit = trimmed.slice(space + 1).toUpperCase() as StorageUnit;
  const multiplier = UNIT_MULTIPLIERS[unit];
  if (!multiplier || Number.isNaN(amount)) {
    throw new Error(`Invalid bytes literal: ${literal}`);
  }
  return amount * multiplier;
}

/** Format a byte count as human-readable storage size (one decimal for KB and above). */
export function formatBytes(byteCount: number): string {
  if (byteCount < KIB) return `${byteCount} B`;
  if (byteCount < MIB) return `${(byteCount / KIB).toFixed(1)} KB`;
  if (byteCount < GIB) return `${(byteCount / MIB).toFixed(1)} MB`;
  return `${(byteCount / GIB).toFixed(1)} GB`;
}
