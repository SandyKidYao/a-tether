#!/usr/bin/env node
import { claudeCode } from "./backends/claude-code/index.ts";
import { runServer } from "./server/http.ts";

try {
  await runServer(claudeCode);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
