import { readUserSetting, writeUserSetting } from "./versionedSettings";
import { USER_CONFIG } from "@/shared/userConfig/keys";
import {
  parseBlobReaderGrayscale,
  parseBlobReaderZoom,
} from "@/shared/userConfig/reader";
import { ResultTools } from "@/shared/protocol/result";
import { client } from "@/client/interact/remote/client";

export type ReaderConfig = {
  grayscale: boolean;
  zoom: number;
};

export async function fetchReaderConfig() {
  const [grayscale, zoom] = await Promise.all([
    readUserSetting(USER_CONFIG.BLOB_READER_GRAYSCALE, "false"),
    readUserSetting(USER_CONFIG.BLOB_READER_ZOOM, "1"),
  ]);
  const data = {
    grayscale: parseBlobReaderGrayscale(grayscale),
    zoom: parseBlobReaderZoom(zoom),
  };
  return {
    res: ResultTools.ok(data, { buildId: client.buildId }),
    data,
  };
}

export async function updateReaderConfig(body: Partial<ReaderConfig>) {
  await Promise.all([
    body.grayscale === undefined
      ? undefined
      : writeUserSetting(
          USER_CONFIG.BLOB_READER_GRAYSCALE,
          String(body.grayscale),
        ),
    body.zoom === undefined
      ? undefined
      : writeUserSetting(USER_CONFIG.BLOB_READER_ZOOM, String(body.zoom)),
  ]);
  return {
    res: ResultTools.ok(body, { buildId: client.buildId }),
    data: body,
  };
}
