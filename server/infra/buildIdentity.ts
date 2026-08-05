import fs from "node:fs";
import path from "node:path";

/** Read the one build identity shared by Shell, client, server and launcher. */
export function readBuildId(appDir: string): string {
  const file = path.join(appDir, "build-id.txt");
  if (!fs.existsSync(file)) return "dev";
  return fs.readFileSync(file, "utf8").trim() || "dev";
}
