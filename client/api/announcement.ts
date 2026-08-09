import { observeActionResult } from "./runtime";
import { client } from "@/client/interact/remote/client";

const { fetchAnnouncementAction, acknowledgeAnnouncementAction } =
  client.actions;

export async function fetchAnnouncement() {
  const result = await fetchAnnouncementAction();
  observeActionResult(result);
  return result.ok ? result.data : null;
}

export async function acknowledgeAnnouncement(revision: number) {
  return observeActionResult(await acknowledgeAnnouncementAction(revision));
}
