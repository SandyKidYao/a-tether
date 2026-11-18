import assert from "node:assert/strict";
import test from "node:test";
import {chmod, mkdtemp, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {findPi, piArgs} from "../src/frontends/pi/cli.ts";
import {useHome} from "./helpers.ts";

test("a-tether-pi adds the extension and default model, but passes subcommands through", () => {
  const [flag, extension, ...rest] = piArgs(["-p", "hi"]);
  assert.equal(flag, "-e");
  assert.match(extension, /extension\.ts$/);
  assert.deepEqual(rest, ["--model", "a-tether/default", "-p", "hi"]);
  assert.deepEqual(piArgs(["--model", "a-tether/claude-opus-5-5"]).slice(2), ["--model", "a-tether/claude-opus-5-5"]);
  assert.deepEqual(piArgs(["--model=x"]).slice(2), ["--model=x"]);
  assert.deepEqual(piArgs(["install", "npm:@a-tether/pi"]), ["install", "npm:@a-tether/pi"]);
});

test("a-tether-pi only uses an existing pi and never installs one", async t => {
  const dir = await mkdtemp(join(tmpdir(), "a-tether-pi-"));
  t.after(() => rm(dir, {recursive: true, force: true}));
  useHome(t, dir);
  assert.equal(findPi({PATH: dir}), undefined);
  const pi = join(dir, "pi");
  await writeFile(pi, "#!/bin/sh\n");
  assert.equal(findPi({PATH: dir}), undefined, "not executable");
  await chmod(pi, 0o755);
  assert.equal(findPi({PATH: dir}), pi);
  assert.equal(findPi({PATH: ""}, pi), pi, "client.pi wins over PATH");
  assert.equal(findPi({PATH: dir}, join(dir, "missing")), undefined);
  assert.equal(findPi({PATH: dir, A_TETHER_PI: join(dir, "missing")}), pi, "the 0.1.0 variable is ignored");
});

test("--version shows the launcher's version and the Pi it would start", async t => {
  const {readFile} = await import("node:fs/promises");
  const {versions} = await import("../src/frontends/pi/cli.ts");
  const expected = JSON.parse(await readFile("package.json", "utf8")).version;
  const dir = await mkdtemp(join(tmpdir(), "a-tether-version-"));
  t.after(() => rm(dir, {recursive: true, force: true}));
  const pi = join(dir, "pi");
  await writeFile(pi, "#!/bin/sh\n[ \"$1\" = --version ] && echo 9.9.9\n", {mode: 0o755});
  assert.deepEqual(versions(pi), ["a-tether-pi " + expected, "pi 9.9.9"]);
  assert.deepEqual(versions(undefined), ["a-tether-pi " + expected, "pi 未找到"]);
});
