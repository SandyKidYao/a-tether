// Tests inject configuration the way users do: a settings.json under a temporary HOME.
import {mkdir, writeFile} from "node:fs/promises";
import {join} from "node:path";
import type {TestContext} from "node:test";

export async function writeSettings(home: string, data: unknown) {
  await mkdir(join(home, ".a-tether"), {recursive: true});
  await writeFile(join(home, ".a-tether", "settings.json"), JSON.stringify(data));
}

// os.homedir() follows HOME, so in-process code reads the temporary settings.
export function useHome(t: TestContext, home: string) {
  const previous = process.env.HOME;
  process.env.HOME = home;
  t.after(() => { if (previous === undefined) delete process.env.HOME; else process.env.HOME = previous; });
}
