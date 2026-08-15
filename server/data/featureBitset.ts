import {
  DEFAULT_USER_FEATURES,
  FEATURES,
  type Feature,
  type UserFeatures,
} from "@/shared/features";

export const MAX_FEATURE_BITSET = 2 ** FEATURES.length - 1;
export const DEFAULT_FEATURE_BITSET = encodeFeatureBitset(
  DEFAULT_USER_FEATURES,
);

export function featureBit(feature: Feature): number {
  return 1 << FEATURES.indexOf(feature);
}

export function encodeFeatureBitset(features: UserFeatures): number {
  return FEATURES.reduce(
    (bitset, feature) =>
      features[feature] ? bitset | featureBit(feature) : bitset,
    0,
  );
}

export function decodeFeatureBitset(bitset: number): UserFeatures {
  return Object.fromEntries(
    FEATURES.map((feature) => [feature, (bitset & featureBit(feature)) !== 0]),
  ) as UserFeatures;
}

export function isValidFeatureBitset(bitset: number): boolean {
  return (
    Number.isInteger(bitset) && bitset >= 0 && bitset <= MAX_FEATURE_BITSET
  );
}
