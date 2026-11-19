import { randomBytes } from "node:crypto";
import { hostname } from "node:os";
import { header, hostLabel, messages, protocol, type Code } from "../shared/protocol.ts";
import { loadSettings } from "../shared/settings.ts";

// One ID per Pi process, kept in memory only: C's console lists each Pi separately.
const client = {[header.client]: randomBytes(6).toString("hex"), [header.host]: hostLabel(hostname())};

export function errorMessage(code: unknown) {
  return typeof code === "string" && Object.hasOwn(messages, code) ? messages[code as Code] : messages.backend;
}
// Settings are read on every request, so `login` takes effect without restarting Pi.
export async function request(path: string, init: RequestInit = {}) {
  const {token, client: settings} = loadSettings();
  if (!token) throw new Error(messages.token);
  let res: Response;
  try {
    res = await fetch(settings.url + path, {...init, redirect: "error",
      headers: {authorization: "Bearer " + token, "content-type": "application/json", [header.protocol]: protocol, ...client}});
  } catch (error) {
    if (init.signal?.aborted) throw error;
    throw new Error(messages.connection);
  }
  // A C from another release either lacks the header or names another version.
  if (res.headers.get(header.protocol) !== protocol) {
    await res.body?.cancel().catch(() => {});
    throw new Error(messages.version);
  }
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(errorMessage(data?.code));
  }
  return res;
}
