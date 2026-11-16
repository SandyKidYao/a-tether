import { messages, type Code } from "../shared/protocol.ts";
import { loadSettings } from "../shared/settings.ts";

export function errorMessage(code: unknown) {
  return typeof code === "string" && Object.hasOwn(messages, code) ? messages[code as Code] : messages.backend;
}
// Settings are read on every request, so `login` takes effect without restarting Pi.
export async function request(path: string, init: RequestInit = {}) {
  const {token, client} = loadSettings();
  if (!token) throw new Error(messages.token);
  let res: Response;
  try {
    res = await fetch(client.url + path, {...init, redirect: "error", headers: {authorization: "Bearer " + token, "content-type": "application/json"}});
  } catch { throw new Error(messages.connection); }
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(errorMessage(data?.code));
  }
  return res;
}
