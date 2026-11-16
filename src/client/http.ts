import { defaultUrl, messages, type Code } from "../shared/protocol.ts";

function endpoint() {
  const url = new URL(process.env.A_TETHER_URL || defaultUrl);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("A_TETHER_URL 必须指向 SSH 隧道的 http://127.0.0.1:端口");
  }
  return url.origin;
}
export function errorMessage(code: unknown) {
  return typeof code === "string" && Object.hasOwn(messages, code) ? messages[code as Code] : messages.backend;
}
export async function request(path: string, init: RequestInit = {}) {
  const token = process.env.A_TETHER_TOKEN;
  if (!token) throw new Error(messages.unauthorized);
  const url = endpoint() + path;
  let res: Response;
  try {
    res = await fetch(url, {...init, redirect: "error", headers: {authorization: "Bearer " + token, "content-type": "application/json"}});
  } catch { throw new Error(messages.connection); }
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(errorMessage(data?.code));
  }
  return res;
}
