import { copyFile, mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const vaultArgument = process.argv[2];

if (!vaultArgument) {
  throw new Error("用法：npm run install:vault -- /absolute/path/to/vault");
}

const vaultDir = resolve(vaultArgument);
const manifest = JSON.parse(
  await readFile(resolve(projectDir, "manifest.json"), "utf8"),
);
const destination = resolve(vaultDir, ".obsidian", "plugins", manifest.id);

await mkdir(destination, { recursive: true });
await Promise.all(
  ["main.js", "manifest.json", "styles.css"].map((file) =>
    copyFile(resolve(projectDir, file), resolve(destination, file)),
  ),
);

console.log(`Installed ${manifest.name} to ${destination}`);
