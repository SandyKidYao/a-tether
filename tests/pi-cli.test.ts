import assert from "node:assert/strict";
import test from "node:test";
import {chmod, mkdtemp, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {findPi, piArgs} from "../src/frontends/pi/cli.ts";

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
  assert.equal(findPi({PATH: dir}), undefined);
  const pi = join(dir, "pi");
  await writeFile(pi, "#!/bin/sh\n");
  assert.equal(findPi({PATH: dir}), undefined, "not executable");
  await chmod(pi, 0o755);
  assert.equal(findPi({PATH: dir}), pi);
  assert.equal(findPi({PATH: "", A_TETHER_PI: pi}), pi);
  assert.equal(findPi({PATH: dir, A_TETHER_PI: join(dir, "missing")}), undefined);
});
