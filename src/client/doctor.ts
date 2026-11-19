// /a-tether-status: checks C and measures the link. Besides delay it sends requests of
// different sizes over new connections, because a link that drops large packets looks
// perfect to a small request and fails every real one.
import { randomBytes } from "node:crypto";
import { header, messages } from "../shared/protocol.ts";
import { version } from "../shared/version.ts";
import { request } from "./http.ts";

export type Report = {ok: boolean; lines: string[]};
// Sizes of the probes: one that fits any packet, one that needs several, one to time.
const small = 200, large = 16 * 1024, bulk = 128 * 1024;
// A larger request that takes this much longer than a small one is not just slower.
const stallMs = 2500;

const ms = (value: number) => value < 1000 ? Math.round(value) + " ms" : (value / 1000).toFixed(1) + " 秒";
// The transfer alone: the probe's time less what a small request takes anyway. On a
// fast link that difference is noise, and all there is to say is that it is fast.
function rate(bytes: number, took: number, base: number) {
  const net = took - base;
  if (net < 50) return "很快（传输时间不到 50 ms）";
  const speed = bytes / 1024 / net * 1000;
  return "约 " + (speed >= 1024 ? (speed / 1024).toFixed(1) + " MB/s" : Math.round(speed) + " KB/s");
}

// Round trip of one probe in milliseconds, on a connection of its own.
async function probe(up: number, down: number, signal?: AbortSignal, timeout = 60_000) {
  const began = performance.now();
  const reply = await request("/v1/probe?reply=" + down, {method: "POST", body: randomBytes(up), contentType: "application/octet-stream",
    fresh: true, signal, timeout});
  let received = 0;
  for await (const chunk of reply.body) received += chunk.length;
  if (received !== down) throw new Error(messages.interrupted);
  return performance.now() - began;
}

export async function diagnose(signal?: AbortSignal): Promise<Report> {
  const lines: string[] = [];
  let health;
  let theirs = "";
  try {
    const reply = await request("/v1/health", {signal, timeout: 30_000});
    theirs = String(reply.headers[header.version] ?? "");
    health = await reply.json();
  } catch (error) {
    if (signal?.aborted) throw error;
    return {ok: false, lines: [error instanceof Error ? error.message : messages.connection]};
  }
  const ok = !!health.loggedIn;
  lines.push((ok ? "C 上的 Claude Code 已登录" : health.diagnostic ? messages.backend : health.available ? messages.login : messages.unavailable) +
    ` · A ${version}，C ${theirs || "未知"}`);
  try {
    const trips: number[] = [];
    let failed = 0;
    for (let i = 0; i < 5; i++) {
      const began = performance.now();
      try { (await request("/v1/probe?reply=0", {method: "POST", body: "", signal, timeout: 10_000})).close(); trips.push(performance.now() - began); }
      catch (error) { if (signal?.aborted) throw error; failed++; }
    }
    lines.push(trips.length ? `延迟：平均 ${ms(trips.reduce((a, b) => a + b, 0) / trips.length)}（${ms(Math.min(...trips))}–${ms(Math.max(...trips))}），5 次里 ${failed} 次没回来`
      : "延迟：5 次探测都没回来");
    const base = await probe(small, small, signal);
    const up = await probe(large, small, signal), down = await probe(small, large, signal);
    const upBulk = await probe(bulk, small, signal), downBulk = await probe(small, bulk, signal);
    lines.push(`新连接上的小请求：${ms(base)}`);
    lines.push(`上行（A→C）：16 KB 用时 ${ms(up)}，128 KB ${rate(bulk, upBulk, base)}`);
    lines.push(`下行（C→A）：16 KB 用时 ${ms(down)}，128 KB ${rate(bulk, downBulk, base)}`);
    const stuck = [up - base > stallMs ? "上行" : "", down - base > stallMs ? "下行" : ""].filter(Boolean);
    if (stuck.length) {
      lines.push(`⚠ ${stuck.join("和")}的 16 KB 请求比小请求慢 ${ms(Math.max(up, down) - base)}：链路很可能在丢弃大包（MTU 问题），` +
        "每个新连接都要先卡这么久。处理方法见 README「故障排查」里的「大包被丢弃」。");
    }
  } catch (error) {
    if (signal?.aborted) throw error;
    lines.push("链路测量中断：" + (error instanceof Error ? error.message : messages.connection));
  }
  return {ok, lines};
}
