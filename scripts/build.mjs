// Compiles src once, then assembles the two publishable packages.
import {execFileSync} from "node:child_process";
import {chmodSync, cpSync, mkdirSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const build = join(root, "build");
rmSync(build, {recursive: true, force: true});
execFileSync(process.execPath, [join(root, "node_modules/typescript/bin/tsc"), "-p", join(root, "tsconfig.build.json")], {stdio: "inherit"});

const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const packages = {
  server: {files: ["server.js", "server", "backends", "shared"], extra: [], bins: ["server.js"]},
  pi: {files: ["frontends/pi", "client", "shared"], extra: [], bins: ["frontends/pi/cli.js"]},
};
for (const [name, spec] of Object.entries(packages)) {
  const dir = join(root, "packages", name);
  const dist = join(dir, "dist");
  rmSync(dist, {recursive: true, force: true});
  for (const file of spec.files) cpSync(join(build, file), join(dist, file), {recursive: true});
  for (const [from, to] of spec.extra) { mkdirSync(dirname(join(dist, to)), {recursive: true}); cpSync(join(root, from), join(dist, to)); }
  for (const bin of spec.bins) chmodSync(join(dist, bin), 0o755);
  for (const doc of ["LICENSE"]) try { cpSync(join(root, doc), join(dir, doc)); } catch {}
  const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  manifest.version = version;
  writeFileSync(join(dir, "package.json"), JSON.stringify(manifest, null, 2) + "\n");
}
rmSync(build, {recursive: true, force: true});
console.log("built packages/server (@a-tether/server) and packages/pi (@a-tether/pi) at", version);
