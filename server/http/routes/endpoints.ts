import { originsForRequest } from "@/server/infra/endpoints";

/** GET /api/endpoints — API origins for client-side connection spreading. */
export async function GET(req: Request) {
  const origins = originsForRequest(req);
  return Response.json({ origins });
}
