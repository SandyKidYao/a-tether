import type { Backend } from "../backend.ts";
import type { Code } from "../../shared/protocol.ts";
import { discoverClaudeModels, getClaudeStatus } from "./claude-process.ts";
import { streamClaudeCode } from "./claude-turn.ts";

export function backendCode(detail: string): Code {
  if (/prompt is too long|context.(length|window)|too many tokens|maximum context/i.test(detail)) return "context";
  if (/quota|rate.limit|billing|credit|status 429|usage limit/i.test(detail)) return "quota";
  if (/not logged in|auth login|unauthorized|authentication.(failed|error)|invalid.api.key|oauth token|status 401/i.test(detail)) return "login";
  if (/overloaded|status 5\d\d|\b5(00|02|03|04|29)\b|internal server error|service unavailable|bad gateway|api_error|ECONNRESET|ETIMEDOUT|socket hang up/i.test(detail)) return "overloaded";
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
