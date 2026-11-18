import { readFileSync } from "node:fs";

// The repository keeps package.json one level above src/, and each published package
// one level above dist/, so the same relative path works in both.
export const version: string = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version;

export const isVersionFlag = (args: string[]) => args.length === 1 && (args[0] === "--version" || args[0] === "-v");
