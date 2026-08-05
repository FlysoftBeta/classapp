import Box from "@mui/material/Box";
import type { ItemId } from "@infini-scroll/core";
import { useDebugStore } from "@/client/hooks/useDebugStore";

/** Development-only label for an Infini item's stable identity. */
export function InfiniId({ id }: { id: ItemId }) {
  const showInfiniIds = useDebugStore((state) => state.showInfiniIds);

  if (!showInfiniIds) return null;

  return (
    <Box
      component="span"
      sx={{ color: "text.disabled", fontSize: "0.7rem", mr: 1 }}
    >
      [{id}]
    </Box>
  );
}
