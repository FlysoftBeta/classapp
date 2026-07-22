import type { Database } from "better-sqlite3";
import {
  clampBlobReaderZoom,
  parseBlobReaderGrayscale,
  parseBlobReaderZoom,
  type BlobReaderConfig,
} from "@/shared/userConfig/reader";
import { USER_CONFIG } from "@/shared/userConfig/keys";
import { MalformedRequestError } from "@/shared/protocol/errors";
import { getUserConfig, setUserConfig } from "@/server/services/userConfig";

export class ReaderConfigService {
  constructor(private readonly db: Database) {}

  get(userId: string): BlobReaderConfig {
    return {
      grayscale: parseBlobReaderGrayscale(
        getUserConfig(this.db, userId, USER_CONFIG.BLOB_READER_GRAYSCALE),
      ),
      zoom: parseBlobReaderZoom(
        getUserConfig(this.db, userId, USER_CONFIG.BLOB_READER_ZOOM),
      ),
    };
  }

  patch(userId: string, input: Partial<BlobReaderConfig>): BlobReaderConfig {
    if (input.grayscale === undefined && input.zoom === undefined) {
      throw new MalformedRequestError("缺少配置项");
    }
    if (input.grayscale !== undefined) {
      setUserConfig(
        this.db,
        userId,
        USER_CONFIG.BLOB_READER_GRAYSCALE,
        input.grayscale ? "true" : "false",
      );
    }
    if (input.zoom !== undefined) {
      setUserConfig(
        this.db,
        userId,
        USER_CONFIG.BLOB_READER_ZOOM,
        String(clampBlobReaderZoom(input.zoom)),
      );
    }
    return this.get(userId);
  }
}

export function createReaderConfigService(db: Database): ReaderConfigService {
  return new ReaderConfigService(db);
}
