/**
 * playwright-core treats chromium-bidi as optional. Rollup hoists that guarded
 * CommonJS require into an ESM import, so this keeps the optional feature from
 * becoming a deployment-time dependency. Chromium launches do not use BiDi.
 */
export default {};
