import { copyFile } from "node:fs/promises";
import { URL } from "node:url";

await copyFile(
  new URL("./index-wrapper.js", import.meta.url),
  new URL("../dist/index.js", import.meta.url)
);
