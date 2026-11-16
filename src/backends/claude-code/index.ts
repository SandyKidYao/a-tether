import type { Backend } from "../backend.ts";
import type { Code } from "../../shared/protocol.ts";
import { discoverClaudeModels, getClaudeStatus } from "./claude-process.ts";
import { streamClaudeCode } from "./claude-turn.ts";

function backendCode(detail: string): Code {
  if (/quota|rate.limit|billing|credit|status 429|usage limit/i.test(detail)) return "quota";
  if (/not logged in|auth login|unauthorized|status 401/i.test(detail)) return "login";
  if (/not installed|not found on PATH/i.test(detail)) return "unavailable";
  return "backend";
}

export const claudeCode: Backend = {
  name: "Claude Code",
  status: (signal) => getClaudeStatus(process.env, signal),
  models: (signal) => discoverClaudeModels(process.env, signal),
  stream: (model, context, options) => streamClaudeCode(model, context, options, model.route),
  errorCode: backendCode,
};
