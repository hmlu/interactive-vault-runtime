import esbuild from "esbuild";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const pluginDir = dirname(fileURLToPath(import.meta.url));
const isProduction = process.argv[2] === "production";
const fflateLicense = await readFile(resolve(pluginDir, "node_modules/fflate/LICENSE"), "utf8");

const context = await esbuild.context({
  entryPoints: [resolve(pluginDir, "src/main.ts")],
  bundle: true,
  external: ["obsidian", "electron", "node:*", "@codemirror/*", "@lezer/*"],
  format: "cjs",
  target: "es2018",
  platform: "browser",
  outfile: resolve(pluginDir, "main.js"),
  banner: {
    js: `/*! fflate\n${fflateLicense.trim()}\n*/`,
  },
  sourcemap: isProduction ? false : "inline",
  minify: isProduction,
  treeShaking: true,
  logLevel: "info",
});

if (isProduction) {
  await context.rebuild();
  await context.dispose();
} else {
  await context.watch();
  console.log("Watching Interactive Vault Runtime sources…");
}
