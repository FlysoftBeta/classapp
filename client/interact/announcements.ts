import {
  acknowledgeAnnouncement as acknowledgeRemoteAnnouncement,
  fetchAnnouncement as fetchRemoteAnnouncement,
} from "@/client/api/announcement";
import { client } from "./remote/client";

/** Announcements have no useful offline authority; absence is the local view. */
export async function fetchAnnouncement() {
  if (!client.isConnected()) return null;
  try {
    return await fetchRemoteAnnouncement();
  } catch {
    return null;
  }
}

export async function acknowledgeAnnouncement(revision: number) {
  return acknowledgeRemoteAnnouncement(revision);
}
