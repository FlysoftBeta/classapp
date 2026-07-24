import Box from "@mui/material/Box";
import type { Infini2Id } from "@/lib/infini2";
import { useDebugStore } from "@/client/hooks/useDebugStore";

/** Development-only label for an Infini2 item's stable identity. */
export function InfiniId({ id }: { id: Infini2Id }) {
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
