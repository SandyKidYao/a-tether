#!/usr/bin/env node
// The live fixture behind a full C: answers `claude auth status` and model discovery,
// then behaves as tests/fixtures/live-claude.mjs.
import {createInterface} from "node:readline";

if (process.argv.includes("auth")) {
  console.log(JSON.stringify({loggedIn: true}));
  process.exit(0);
}
if (!process.argv.includes("--model")) {
  for await (const line of createInterface({input: process.stdin})) {
    const frame = JSON.parse(line);
    console.log(JSON.stringify({type: "control_response", response: {subtype: "success", request_id: frame.request_id,
      response: {models: [{value: "claude-opus-5-5", displayName: "Opus 5.5", supportsEffort: true}]}}}));
    process.exit(0);
  }
}
await import("./live-claude.mjs");
