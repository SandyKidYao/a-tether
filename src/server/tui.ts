// C's console: a full-screen view of the A ends, Claude processes, requests in flight and
// recent activity, drawn with plain ANSI escapes. `render` is a pure function from a
// snapshot to screen lines; `tuiConsole` owns the terminal. Only metadata reaches the
// screen, and the token only when asked for (t, then r).
import { execFile } from "node:child_process";
import { format } from "node:util";
import type { ProcessInfo } from "../backends/backend.ts";
import { protocol } from "../shared/protocol.ts";
import { isLoopback, loadSettings, loginCommand, type Settings } from "../shared/settings.ts";
import { version } from "../shared/version.ts";
import type { Console } from "./http.ts";
import { short, type ActiveRequest, type Client, type Entry, type Monitor } from "./monitor.ts";
import { fit, safe, slice, truncate, width } from "./text.ts";

// ---------- styles ----------
const style = (code: string) => (text: string | number) => `\x1b[${code}m${text}\x1b[0m`;
const green = style("32"), yellow = style("33"), red = style("31"), blue = style("94"), cyan = style("36"),
  magenta = style("35"), dim = style("2"), bold = style("1"), key = style("7");
const selected = "\x1b[48;5;237m";
const highlight = (line: string) => selected + line.replaceAll("\x1b[0m", "\x1b[0m" + selected) + "\x1b[0m";

const pad2 = (n: number) => String(n).padStart(2, "0");
const clock = (t: number) => { const d = new Date(t); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`; };
export function duration(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return s + "s";
  const m = Math.floor(s / 60);
  if (m < 60) return m + "m" + pad2(s % 60) + "s";
  return Math.floor(m / 60) + "h" + pad2(m % 60) + "m";
}
const minutes = (ms: number) => Math.max(0, Math.ceil(ms / 60_000)) + "m";
const thousands = (n: number) => n >= 1000 ? (n / 1000).toFixed(1) + "k" : String(n);
const modelName = (id: string) => safe(id).replace(/^claude-/, "");

// ---------- snapshot ----------
export type Proc = ProcessInfo & {owner?: string; rss?: number};
export type View = {
  now: number; host: string; port: number; token: string; boot: number;
  health?: Monitor["health"]; catalog?: Monitor["catalog"];
  server: Pick<Settings["server"], "maxSessions" | "heartbeatInterval" | "heartbeatTimeout">;
  clients: Client[]; processes: Proc[]; requests: ActiveRequest[]; entries: Entry[];
  totals: {requests: number; failed: number; started: number; reused: number};
  hostOf(key?: string): string;
};

export function snapshot(monitor: Monitor, options: {host: string; port: number; token: string; server: View["server"];
    rss?: Map<number, number>; now?: number}): View {
  const now = options.now ?? Date.now();
  const stats = monitor.backend.stats?.() ?? {started: 0, reused: 0};
  const order = {generating: 0, finishing: 1, awaitingTools: 2, idle: 3};
  const processes = (monitor.backend.processes?.() ?? []).map(p => ({...p,
    owner: p.pid === undefined ? undefined : monitor.owners.get(p.pid),
    rss: p.pid === undefined ? undefined : options.rss?.get(p.pid)}))
    .sort((a, b) => order[a.state] - order[b.state] || b.lastUsed - a.lastUsed);
  const requests = [...monitor.active.values()].sort((a, b) => a.started - b.started);
  const busy = new Set([...requests.map(r => r.client), ...processes.map(p => p.owner)]);
  const clients = [...monitor.clients.values()].filter(c => now - c.lastSeen < 30 * 60_000 || busy.has(c.key))
    .sort((a, b) => b.lastSeen - a.lastSeen);
  return {now, host: options.host, port: options.port, token: options.token, boot: monitor.boot,
    health: monitor.health, catalog: monitor.catalog, server: options.server, clients, processes, requests,
    entries: monitor.entries, totals: {...monitor.totals, started: stats.started, reused: stats.reused},
    hostOf: key => monitor.hostOf(key)};
}

// ---------- interface state ----------
export const panels = ["clients", "processes", "requests", "log"] as const;
type Panel = typeof panels[number];
export type Modal = {type: "help"} | {type: "token"} | {type: "process"; pid: number} | {type: "request"; id: string} |
  {type: "client"; key: string} | {type: "kill"; pid: number} | {type: "cancel"; id: string} | {type: "quit"} | {type: "stopping"};
export type Ui = {
  focus: number;
  // The selected row of each list, by key, so it stays put while rows reorder.
  sel: Partial<Record<Panel, string>>; index: Record<Panel, number>;
  logOffset: number; filter: number; pausedAt?: number;
  modal?: Modal; reveal: boolean;
};
export const newUi = (modal?: Modal, reveal = false): Ui =>
  ({focus: 1, sel: {}, index: {clients: 0, processes: 0, requests: 0, log: 0}, logOffset: 0, filter: 0, modal, reveal});
const filters: [string, (e: Entry) => boolean][] = [
  ["全部", () => true], ["仅错误", e => e.level === "error" || e.level === "warn"], ["仅进程", e => e.tag === "process"]];

function choose<T>(ui: Ui, panel: Panel, list: T[], id: (item: T) => string) {
  let i = ui.sel[panel] === undefined ? -1 : list.findIndex(item => id(item) === ui.sel[panel]);
  if (i < 0) i = Math.max(0, Math.min(ui.index[panel], list.length - 1));
  ui.index[panel] = i;
  ui.sel[panel] = list[i] === undefined ? undefined : id(list[i]);
  return i;
}
const pidKey = (p: Proc) => String(p.pid);

// ---------- drawing ----------
function box(title: string, right: string, body: string[], w: number, h: number, focus: boolean, sel?: number, footer = "") {
  const line = focus ? blue : dim;
  const inner = w - 2;
  const t = truncate(title, inner - 4);
  let r = right;
  let fill = inner - 3 - width(t) - (r ? width(r) + 3 : 0);
  if (fill < 1 && r) { r = ""; fill = inner - 3 - width(t); }
  const lines = [line("┌─ ") + (focus ? blue(t) : t) + line(" " + "─".repeat(Math.max(0, fill))) + (r ? " " + r + line(" ─") : "") + line("┐")];
  for (let i = 0; i < h - 2; i++) {
    const text = fit(body[i] ?? "", inner - 2);
    lines.push(line("│") + " " + (i === sel && focus ? highlight(text) : text) + " " + line("│"));
  }
  const f = footer ? truncate(footer, inner - 4) : "";
  lines.push(line("└") + (f ? line("─ ") + dim(f) + " " : "") + line("─".repeat(Math.max(0, inner - (f ? width(f) + 3 : 0)))) + line("┘"));
  return lines;
}

type Column = {title: string; cells: string[]; right?: boolean; drop: number; flex?: boolean};
// Lays out columns in `avail` columns: drops the most expendable (highest `drop`) until
// the rest fit, then shrinks a flexible column.
export function table(columns: Column[], avail: number) {
  const natural = (c: Column) => Math.max(width(c.title), ...c.cells.map(width));
  const total = (list: Column[]) => list.reduce((s, c) => s + natural(c), 0) + 2 * (list.length - 1);
  let shown = columns;
  while (shown.length > 1 && total(shown) > avail) {
    const worst = shown.reduce((a, b) => b.drop > a.drop ? b : a);
    shown = shown.filter(c => c !== worst);
  }
  const widths = shown.map(natural);
  let over = total(shown) - avail;
  for (let i = 0; over > 0 && i < shown.length; i++) {
    if (!shown[i].flex) continue;
    const cut = Math.min(over, widths[i] - 4);
    if (cut > 0) { widths[i] -= cut; over -= cut; }
  }
  const row = (cells: string[]) => cells.map((cell, i) => fit(cell, widths[i], shown[i].right ? "right" : "left")).join("  ");
  const rows = columns[0].cells.map((_, r) => row(shown.map(c => c.cells[r])));
  return [row(shown.map(c => dim(c.title))), ...rows];
}

// Keeps the selected row inside a window of `visible` rows.
function windowed(rows: string[], sel: number, visible: number) {
  const start = sel < visible ? 0 : sel - visible + 1;
  const more = rows.length > visible ? `${start + 1}–${Math.min(rows.length, start + visible)} / ${rows.length}` : "";
  return {rows: rows.slice(start, start + visible), sel: sel - start, more};
}

const procState: Record<ProcessInfo["state"], [string, (t: string) => string, string]> = {
  generating: ["生成中", green, "●"], finishing: ["收尾", cyan, "◑"], awaitingTools: ["等工具", yellow, "◐"], idle: ["空闲", dim, "○"],
};
const leaseText = {reused: green("复用"), started: cyan("新进程"), rebuilt: yellow("重建"), oneshot: yellow("一次性")};

function header(v: View, cols: number) {
  const h = v.health;
  const claude = !h ? dim("检查中") : h.loggedIn ? green("● 已登录") : h.available ? red("● 未登录") : red("● 找不到");
  const host = v.host.includes(":") ? `[${v.host}]` : v.host;
  const sep = dim(" │ ");
  const parts = [bold(key(" A-tether 服务端 ")) + " " + version, dim("监听 ") + `${host}:${v.port}`, dim("Claude Code ") + claude,
    dim("协议 ") + protocol, dim("运行 ") + duration(v.now - v.boot)];
  const right = dim(clock(v.now));
  let left = parts.join(sep);
  while (width(left) + width(right) + 1 > cols && parts.length > 2) { parts.splice(parts.length - 2, 1); left = parts.join(sep); }
  const gap = cols - width(left) - width(right);
  return gap > 0 ? left + " ".repeat(gap) + right : fit(left, cols);
}

function banners(v: View, cols: number) {
  const out: string[] = [];
  const h = v.health;
  const bar = (code: string, text: string) => `\x1b[${code}m` + fit(" " + text, cols) + "\x1b[0m";
  if (h && !h.loggedIn) {
    out.push(bar("97;41", h.diagnostic ? "Claude Code 状态检查失败：" + safe(h.detail ?? "原因不明") + "。详情见最近动作。"
      : h.available ? "Claude Code 尚未登录或登录已失效。在这台电脑上运行 claude auth login，A 端的请求会收到 login 错误。"
      : "找不到 Claude Code。检查服务进程的 PATH，或在 settings.json 里把 server.claude 设为绝对路径。"));
  }
  if (!isLoopback(v.host)) out.push(bar("30;43", "服务监听在非本机地址，令牌以明文 HTTP 传输，同一网络中的设备都能连接。只在可信网络里这样用。"));
  return out;
}

function status(v: View, narrow: boolean) {
  const pooled = v.processes.filter(p => p.pooled);
  const busy = pooled.filter(p => p.busy).length;
  const waiting = pooled.filter(p => !p.busy && p.state === "awaitingTools").length;
  const idle = pooled.length - busy - waiting;
  const max = v.server.maxSessions;
  const cells = Math.min(max, narrow ? 12 : 20);
  const scale = (n: number) => max <= cells ? n : Math.round(n * cells / max);
  const marks = [...Array(scale(busy)).fill(green("■")), ...Array(scale(waiting)).fill(yellow("■")), ...Array(scale(idle)).fill(dim("■"))].slice(0, cells);
  const bar = marks.join("") + dim("□".repeat(cells - marks.length));
  const oneshot = v.processes.length - pooled.length;
  const {started, reused} = v.totals;
  const rate = started + reused ? Math.round(reused / (started + reused) * 100) + "%" : dim("—");
  const memory = v.processes.reduce((sum, p) => sum + (p.rss ?? 0), 0);
  const label = (text: string) => fit(dim(text), 9);
  return [
    label("进程池") + (max ? bar + " " : "") + `${pooled.length}/${max}` + (oneshot ? " " + yellow(`+${oneshot} 一次性`) : ""),
    label("") + `${green(busy)} 忙 · ${yellow(waiting)} 等工具 · ${idle} 空闲`,
    label("今天请求") + `${v.totals.requests} · 进行中 ${green(v.requests.length)} · 失败 ${v.totals.failed ? red(v.totals.failed) : dim(0)}`,
    label("进程复用") + `${rate} ${dim(`（启动 ${started} · 复用 ${reused}）`)}`,
    label("模型目录") + (v.catalog ? `${v.catalog.count} 个 ${dim("· " + duration(v.now - v.catalog.at) + " 前刷新")}` : dim("还没有加载")),
    label("心跳") + `每 ${v.server.heartbeatInterval}s ${dim("· 时限 " + v.server.heartbeatTimeout + "s")}`,
    label("内存") + (memory ? `Claude 进程合计 ${Math.round(memory / 1024)} MB` : dim("—")),
  ];
}

function lateHeartbeat(v: View, r: ActiveRequest) { return v.now - r.heard > v.server.heartbeatInterval * 1500; }

function clientsPanel(v: View, ui: Ui, w: number, h: number, focus: boolean) {
  const online = v.clients.filter(c => v.now - c.lastSeen < 5 * 60_000).length;
  const title = `A 端 ${dim("· " + online + " 在线")}`;
  if (!v.clients.length) return box(title, "", [dim("还没有 A 端连接过。按 t 查看 A 端的 login 命令。")], w, h, focus);
  const sel = choose(ui, "clients", v.clients, c => c.key);
  const cells = v.clients.map(c => {
    const active = v.requests.filter(r => r.client === c.key);
    const quiet = v.now - c.lastSeen;
    const late = active.some(r => lateHeartbeat(v, r));
    return {
      name: c.host + (c.id ? dim(" #" + c.id.slice(0, 4)) : ""),
      addr: dim(c.addr),
      state: active.length ? green("● 请求中") : quiet < 5 * 60_000 ? cyan("○ 在线") : dim("· 离开"),
      active: active.length ? String(active.length) : dim("0"),
      procs: String(v.processes.filter(p => p.owner === c.key).length),
      today: String(c.today),
      seen: late ? yellow(duration(quiet) + " 前 · 心跳晚了") : quiet > 5 * 60_000 ? dim(duration(quiet) + " 前") : duration(quiet) + " 前",
    };
  });
  const rows = table([
    {title: "A 端", cells: cells.map(c => c.name), drop: 0, flex: true},
    {title: "来源地址", cells: cells.map(c => c.addr), drop: 6},
    {title: "状态", cells: cells.map(c => c.state), drop: 1},
    {title: "进行中", cells: cells.map(c => c.active), right: true, drop: 2},
    {title: "进程", cells: cells.map(c => c.procs), right: true, drop: 4},
    {title: "今天", cells: cells.map(c => c.today), right: true, drop: 5},
    {title: "最近活动", cells: cells.map(c => c.seen), drop: 3},
  ], w - 4);
  const win = windowed(rows.slice(1), sel, h - 3);
  return box(title, dim("5 分钟内有请求算在线"), [rows[0], ...win.rows], w, h, focus, win.sel + 1, win.more);
}

function processesPanel(v: View, ui: Ui, w: number, h: number, focus: boolean) {
  const pooled = v.processes.filter(p => p.pooled).length;
  const title = `Claude 进程 ${dim(`· ${pooled}/${v.server.maxSessions}`)}`;
  const right = dim("满了回收最久没用的；每个约 50 MB");
  if (!v.processes.length) return box(title, right, [dim("没有 Claude 进程。A 发来第一个请求时启动，每个 Pi 会话一个，空闲 60 分钟后回收。")], w, h, focus);
  const sel = choose(ui, "processes", v.processes, pidKey);
  const cells = v.processes.map(p => {
    const [label, color, dot] = procState[p.state];
    const idle = v.now - p.lastUsed;
    const left = p.reclaimAt === undefined ? 0 : p.reclaimAt - v.now;
    return {
      pid: String(p.pid ?? "?"), state: color(dot + " " + label), owner: p.owner ? v.hostOf(p.owner) : dim("—"),
      model: modelName(p.model), effort: p.effort ?? dim("—"), history: p.history + " 条",
      pending: p.pending.length ? yellow(String(p.pending.length)) + " " + dim(p.pending.map(safe).join(" ")) : dim("—"),
      reuses: String(p.reuses), age: duration(v.now - p.started),
      idle: p.busy ? dim("—") : duration(idle),
      reclaim: p.busy ? dim("—") : !p.pooled ? yellow("用完即结束") : left < 5 * 60_000 ? yellow(minutes(left) + " 后") : dim(minutes(left) + " 后"),
      rss: p.rss === undefined ? dim("—") : Math.round(p.rss / 1024) + " MB",
    };
  });
  const rows = table([
    {title: "PID", cells: cells.map(c => c.pid), drop: 0},
    {title: "状态", cells: cells.map(c => c.state), drop: 0},
    {title: "A 端", cells: cells.map(c => c.owner), drop: 3, flex: true},
    {title: "模型", cells: cells.map(c => c.model), drop: 2, flex: true},
    {title: "推理", cells: cells.map(c => c.effort), drop: 6},
    {title: "历史", cells: cells.map(c => c.history), right: true, drop: 3},
    {title: "待回工具", cells: cells.map(c => c.pending), drop: 4, flex: true},
    {title: "复用", cells: cells.map(c => c.reuses), right: true, drop: 8},
    {title: "已运行", cells: cells.map(c => c.age), right: true, drop: 9},
    {title: "空闲", cells: cells.map(c => c.idle), right: true, drop: 5},
    {title: "回收", cells: cells.map(c => c.reclaim), drop: 5},
    {title: "内存", cells: cells.map(c => c.rss), right: true, drop: 7},
  ], w - 4);
  const win = windowed(rows.slice(1), sel, h - 3);
  return box(title, right, [rows[0], ...win.rows], w, h, focus, win.sel + 1, win.more);
}

function requestsPanel(v: View, ui: Ui, w: number, h: number, focus: boolean) {
  const title = `进行中的请求 ${dim("· " + v.requests.length)}`;
  const right = dim(`模型长时间不输出不算异常，A 的心跳超过 ${v.server.heartbeatTimeout}s 才算失联`);
  if (!v.requests.length) return box(title, right, [dim("没有进行中的请求。")], w, h, focus);
  const sel = choose(ui, "requests", v.requests, r => r.id);
  const timeout = v.server.heartbeatTimeout * 1000;
  const cells = v.requests.map(r => {
    const heard = v.now - r.heard;
    const silent = v.now - r.output;
    const beat = heard > timeout * 0.6 ? red(`${duration(heard)} 前 · ${Math.max(0, Math.ceil((timeout - heard) / 1000))}s 后判定失联`)
      : lateHeartbeat(v, r) ? yellow(duration(heard) + " 前") : duration(heard) + " 前";
    return {
      id: short(r.id), owner: v.hostOf(r.client), model: modelName(r.model) + (r.effort ? " " + dim(r.effort) : ""),
      pid: r.lease?.pid === undefined ? dim("—") : String(r.lease.pid), how: r.lease ? leaseText[r.lease.how] : dim("准备中"),
      age: duration(v.now - r.started), silent: silent > 10_000 ? duration(silent) : dim(duration(silent)), beat,
      chars: thousands(r.chars) + " 字符",
    };
  });
  const rows = table([
    {title: "请求", cells: cells.map(c => c.id), drop: 0},
    {title: "A 端", cells: cells.map(c => c.owner), drop: 2, flex: true},
    {title: "模型", cells: cells.map(c => c.model), drop: 3, flex: true},
    {title: "进程", cells: cells.map(c => c.pid), drop: 4},
    {title: "来源", cells: cells.map(c => c.how), drop: 5},
    {title: "已运行", cells: cells.map(c => c.age), right: true, drop: 0},
    {title: "模型静默", cells: cells.map(c => c.silent), right: true, drop: 6},
    {title: "A 心跳", cells: cells.map(c => c.beat), right: true, drop: 1},
    {title: "输出", cells: cells.map(c => c.chars), right: true, drop: 7},
  ], w - 4);
  const win = windowed(rows.slice(1), sel, h - 3);
  return box(title, right, [rows[0], ...win.rows], w, h, focus, win.sel + 1, win.more);
}

const tagText: Record<Entry["tag"], string> = {request: blue("请求"), process: magenta("进程"), client: cyan("A 端"), system: dim("系统"), error: red("错误")};
function entryLine(e: Entry) {
  const color = e.level === "ok" ? green : e.level === "warn" ? yellow : e.level === "error" ? red : e.tag === "process" ? magenta : (t: string) => t;
  return dim(clock(e.at)) + "  " + fit(tagText[e.tag], 6) + color(safe(e.text));
}

function logPanel(v: View, ui: Ui, w: number, h: number, focus: boolean) {
  const [name, keep] = filters[ui.filter];
  const all = v.entries.filter(keep);
  const shown = ui.pausedAt === undefined ? all : all.filter(e => e.at <= ui.pausedAt!);
  const visible = h - 2;
  ui.logOffset = Math.max(0, Math.min(ui.logOffset, shown.length - visible));
  const end = shown.length - ui.logOffset;
  const lines = shown.slice(Math.max(0, end - visible), end).map(entryLine);
  while (lines.length < visible) lines.unshift("");
  const newer = all.length - shown.length;
  const right = [ui.pausedAt !== undefined ? yellow("⏸ 已暂停" + (newer ? `（${newer} 条新动作）` : "")) : "",
    dim("筛选：") + name].filter(Boolean).join(dim(" · "));
  const footer = end - visible > 0 ? `↑ 还有 ${end - visible} 条更早` : "";
  return box(`最近动作 ${dim("· " + shown.length)}`, right, lines, w, h, focus, undefined, footer);
}

function footer(ui: Ui, cols: number) {
  const panel = panels[ui.focus];
  const own: [string, string][] = panel === "processes" ? [["Enter", "详情"], ["x", "结束进程"]]
    : panel === "requests" ? [["Enter", "详情"], ["c", "取消请求"]]
    : panel === "clients" ? [["Enter", "详情"]]
    : [["↑↓", "翻页"], ["f", "筛选"], ["空格", ui.pausedAt === undefined ? "暂停" : "继续"]];
  const keys: [string, string][] = [["Tab", "切换面板"], ...(panel === "log" ? [] : [["↑↓", "选择"]] as [string, string][]), ...own,
    ["t", "A 端命令"], ["?", "帮助"], ["q", "退出"]];
  return fit(keys.map(([k, text]) => key(` ${k} `) + " " + dim(text)).join("  "), cols);
}

// ---------- dialogs ----------
function wrap(text: string, w: number) {
  const out: string[] = [];
  for (let rest = text; rest; rest = rest.slice(w)) out.push(rest.slice(0, w));
  return out;
}
function dialog(v: View, ui: Ui, modal: Modal, cols: number): {title: string; lines: string[]; danger?: boolean} {
  const hint = (keys: [string, string][]) => keys.map(([k, text]) => key(` ${k} `) + " " + text).join("   ");
  const kv = (label: string, value: string) => fit(dim(label), 12) + value;
  const inner = Math.min(cols - 8, 84);
  switch (modal.type) {
    case "help": return {title: "帮助", lines: [
      kv("Tab / ⇧Tab", "在 A 端、Claude 进程、进行中的请求、最近动作之间切换"),
      kv("1 2 3 4", "直接跳到对应面板"),
      kv("↑ ↓ / j k", "选择行；在最近动作里向前翻"),
      kv("Enter", "查看选中项的详情"),
      kv("x", "结束选中的 Claude 进程（要确认）"),
      kv("c", "取消选中的请求（要确认），A 会收到「请求已取消」"),
      kv("f / 空格", "筛选最近动作 / 暂停滚动"),
      kv("t", "显示 A 端的 login 命令，令牌默认打码"),
      kv("q / Ctrl+C", "停止服务，有请求在进行时先确认；弹窗里 q 只关闭弹窗"),
      kv("停止中 Ctrl+C", "不等清理完，立即退出"),
      "",
      dim("不在终端里运行（nohup、systemd、重定向）时照旧逐行输出；--plain 强制逐行输出。"),
      "", hint([["Esc", "关闭"]])]};
    case "token": {
      const command = ui.reveal ? loginCommand(v.token) : loginCommand("•".repeat(16)) + dim("（已打码）");
      return {title: "A 端配置命令", lines: [
        "在 A 端电脑上运行一次（同一台电脑上使用 Pi 无需运行）：", "",
        ...(ui.reveal ? wrap(command, inner - 2).map(l => "  " + yellow(l)) : ["  " + command]), "",
        dim("令牌保存在 ~/.a-tether/settings.json。录屏或共享屏幕时不要按 r。"),
        "", hint([["r", ui.reveal ? "打码" : "显示令牌"], ["Esc", "关闭"]])]};
    }
    case "process": {
      const p = v.processes.find(p => p.pid === modal.pid);
      if (!p) return {title: "Claude 进程", lines: [dim(`进程 ${modal.pid} 已经结束。`), "", hint([["Esc", "关闭"]])]};
      const [label, color, dot] = procState[p.state];
      const request = v.requests.find(r => r.lease?.pid === p.pid);
      return {title: `Claude 进程 ${p.pid}`, lines: [
        kv("状态", color(dot + " " + label) + (request ? dim(` · 正在处理请求 ${short(request.id)}`) : "")),
        kv("A 端", p.owner ? v.hostOf(p.owner) : "—"),
        kv("模型", modelName(p.model) + (p.effort ? dim(" · 推理 " + p.effort) : "")),
        kv("持有历史", p.history + " 条消息"),
        kv("待回工具", p.pending.length ? p.pending.map(safe).join(", ") : "—"),
        kv("已运行", duration(v.now - p.started) + dim(` · 复用 ${p.reuses} 次`)),
        kv("空闲回收", p.busy ? "处理中，不计时" : !p.pooled ? "一次性进程，请求结束即退出" : minutes((p.reclaimAt ?? v.now) - v.now) + " 后"),
        kv("内存", p.rss === undefined ? "—" : Math.round(p.rss / 1024) + " MB"),
        "", hint([["x", "结束进程"], ["Esc", "关闭"]])]};
    }
    case "request": {
      const r = v.requests.find(r => r.id === modal.id);
      if (!r) return {title: "请求", lines: [dim(`请求 ${short(modal.id)} 已经结束。`), "", hint([["Esc", "关闭"]])]};
      const client = v.clients.find(c => c.key === r.client);
      return {title: `请求 ${short(r.id)}`, lines: [
        kv("请求 ID", r.id),
        kv("A 端", v.hostOf(r.client) + (client ? dim(" · " + client.addr) : "")),
        kv("模型", modelName(r.model) + (r.effort ? dim(" · 推理 " + r.effort) : "")),
        kv("进程", r.lease ? `${r.lease.pid ?? "?"} ${dim("·")} ${leaseText[r.lease.how]}` : dim("准备中")),
        kv("已运行", duration(v.now - r.started)),
        kv("模型静默", duration(v.now - r.output)),
        kv("A 心跳", duration(v.now - r.heard) + " 前" + dim(` · 超过 ${v.server.heartbeatTimeout}s 判定失联`)),
        kv("输出", thousands(r.chars) + " 字符"),
        "", hint([["c", "取消请求"], ["Esc", "关闭"]])]};
    }
    case "client": {
      const c = v.clients.find(c => c.key === modal.key);
      if (!c) return {title: "A 端", lines: [dim("这个 A 端已经不在列表里。"), "", hint([["Esc", "关闭"]])]};
      const procs = v.processes.filter(p => p.owner === c.key);
      return {title: `A 端 ${c.host}`, lines: [
        kv("客户端 ID", c.id ? c.id + dim("（Pi 进程随机生成）") : dim("没有，A 端的 A-tether 较旧或不是 Pi 插件")),
        kv("来源地址", c.addr + (isLoopback(c.addr) ? dim(" · 经端口转发或本机") : "")),
        kv("第一次出现", duration(v.now - c.firstSeen) + " 前"),
        kv("最近活动", duration(v.now - c.lastSeen) + " 前"),
        kv("今天请求", String(c.today)),
        kv("Claude 进程", procs.length ? procs.map(p => p.pid).join(", ") : "—"),
        "", hint([["Esc", "关闭"]])]};
    }
    case "kill": {
      const p = v.processes.find(p => p.pid === modal.pid);
      if (!p) return {title: "结束进程", danger: true, lines: [dim("进程已经结束。"), "", hint([["Esc", "关闭"]])]};
      const request = v.requests.find(r => r.lease?.pid === p.pid);
      return {title: "结束进程", danger: true, lines: [
        `结束 Claude 进程 ${p.pid}？它持有 ${p.history} 条历史。`,
        `${p.owner ? v.hostOf(p.owner) : "A"} 下次请求时会从完整历史重建，那一轮会慢一些。`,
        ...(request ? [yellow(`它正在处理请求 ${short(request.id)}，A 会收到「C 上的 Claude Code 调用失败」。`)] : []),
        "", hint([["y", "结束"], ["Esc", "取消"]])]};
    }
    case "cancel": {
      const r = v.requests.find(r => r.id === modal.id);
      if (!r) return {title: "取消请求", danger: true, lines: [dim("请求已经结束。"), "", hint([["Esc", "关闭"]])]};
      return {title: "取消请求", danger: true, lines: [
        `取消请求 ${short(r.id)}（${v.hostOf(r.client)}，已运行 ${duration(v.now - r.started)}）？`,
        `A 会收到「请求已取消」${r.lease?.pid ? `，进程 ${r.lease.pid} 随之结束` : ""}。`,
        "", hint([["y", "取消请求"], ["Esc", "返回"]])]};
    }
    case "quit": return {title: "停止服务", danger: true, lines: [
      `停止 A-tether 服务？${v.requests.length ? `进行中的 ${v.requests.length} 个请求会被中断，` : ""}${v.processes.length} 个 Claude 进程会被结束。`,
      "", hint([["q", "停止"], ["Esc", "取消"]])]};
    case "stopping": return {title: "停止服务", lines: ["正在停止：结束 Claude 进程，清理临时文件……"]};
  }
}

function overlay(lines: string[], v: View, ui: Ui, cols: number, rows: number) {
  if (!ui.modal) return lines;
  const {title, lines: body, danger} = dialog(v, ui, ui.modal, cols);
  const w = Math.min(cols - 4, Math.max(40, ...body.map(width), width(title) + 6) + 4);
  const h = Math.min(rows - 2, body.length + 2);
  const framed = box(title, "", body, w, h, true).map(l => danger ? l.replaceAll("\x1b[94m", "\x1b[91m") : l);
  const x = Math.floor((cols - w) / 2), y = Math.max(1, Math.floor((rows - h) / 2));
  const out = lines.slice();
  for (let i = 0; i < framed.length; i++) out[y + i] = slice(out[y + i], 0, x) + framed[i] + slice(out[y + i], x + w, cols);
  return out;
}

// The whole screen: exactly `rows` lines, none wider than `cols`.
export function render(v: View, ui: Ui, cols: number, rows: number): string[] {
  if (cols < 80 || rows < 24) {
    const msg = ui.modal?.type === "stopping" ? ["正在停止……", ""]
      : ui.modal?.type === "quit" ? [`有 ${v.requests.length} 个请求在进行，停止会中断它们。`, "再按 q 停止，Esc 取消。"]
      : [`终端窗口太小：至少需要 80×24，现在是 ${cols}×${rows}。`, "放大窗口后自动恢复。按 q 退出。"];
    return Array.from({length: rows}, (_, i) => fit(i === Math.floor(rows / 2) - 1 ? msg[0] : i === Math.floor(rows / 2) ? msg[1] : "", cols));
  }
  const focus = panels[ui.focus];
  const top = [header(v, cols), ...banners(v, cols)];
  const topH = 9;
  const statusW = cols >= 110 ? 48 : 42;
  const left = box("状态", "", status(v, statusW < 48), statusW, topH, false);
  const right = clientsPanel(v, ui, cols - statusW - 1, topH, focus === "clients");
  const rest = rows - top.length - topH - 1;
  let p = Math.min(3 + Math.max(1, v.processes.length), Math.max(4, Math.floor(rest * 0.45)));
  let q = Math.min(3 + Math.max(1, v.requests.length), Math.max(4, Math.floor(rest * 0.3)));
  while (rest - p - q < 4 && p > 4) p--;
  while (rest - p - q < 3 && q > 3) q--;
  const lines = [
    ...top,
    ...left.map((l, i) => l + " " + right[i]),
    ...processesPanel(v, ui, cols, p, focus === "processes"),
    ...requestsPanel(v, ui, cols, q, focus === "requests"),
    ...logPanel(v, ui, cols, rest - p - q, focus === "log"),
    footer(ui, cols),
  ].slice(0, rows).map(l => fit(l, cols));
  while (lines.length < rows) lines.push(" ".repeat(cols));
  return overlay(lines, v, ui, cols, rows);
}

// ---------- keyboard ----------
type Actions = {stop(): void; cancel(id: string): void; kill(pid: number): void; force?(): void};
// Applies one key to the interface state. Returns false for keys it ignores.
export function press(input: string, v: View, ui: Ui, act: Actions): boolean {
  const modal = ui.modal;
  const quit = () => { if (v.requests.length) ui.modal = {type: "quit"}; else { ui.modal = {type: "stopping"}; act.stop(); } };
  if (modal?.type === "stopping") { if (input === "\x03") act.force?.(); return false; }
  if (modal) {
    if (input === "\x1b") { ui.modal = undefined; ui.reveal = false; return true; }
    if (modal.type === "quit" && (input === "q" || input === "y" || input === "\x03")) { ui.modal = {type: "stopping"}; act.stop(); return true; }
    if (input === "\x03") { quit(); return true; }
    if (modal.type === "token" && input === "r") { ui.reveal = !ui.reveal; return true; }
    if (modal.type === "process" && input === "x") { ui.modal = {type: "kill", pid: modal.pid}; return true; }
    if (modal.type === "request" && input === "c") { ui.modal = {type: "cancel", id: modal.id}; return true; }
    if (modal.type === "kill" && input === "y") { act.kill(modal.pid); ui.modal = undefined; return true; }
    if (modal.type === "cancel" && input === "y") { act.cancel(modal.id); ui.modal = undefined; return true; }
    if (input === "q" || input === "?" || input === "\r") { ui.modal = undefined; ui.reveal = false; return true; }
    return false;
  }
  const panel = panels[ui.focus];
  const move = (d: number) => {
    if (panel === "log") ui.logOffset = Math.max(0, ui.logOffset - d);
    else { ui.index[panel] = Math.max(0, ui.index[panel] + d); ui.sel[panel] = undefined; }
  };
  switch (input) {
    case "\t": ui.focus = (ui.focus + 1) % panels.length; return true;
    case "\x1b[Z": ui.focus = (ui.focus + panels.length - 1) % panels.length; return true;
    case "1": case "2": case "3": case "4": ui.focus = Number(input) - 1; return true;
    case "\x1b[B": case "\x1bOB": case "j": move(1); return true;
    case "\x1b[A": case "\x1bOA": case "k": move(-1); return true;
    case "\x1b[6~": move(10); return true;
    case "\x1b[5~": move(-10); return true;
    case "?": ui.modal = {type: "help"}; return true;
    case "t": ui.modal = {type: "token"}; return true;
    case "q": case "\x03": quit(); return true;
    case "f": if (panel !== "log") return false; ui.filter = (ui.filter + 1) % filters.length; ui.logOffset = 0; return true;
    case " ": if (panel !== "log") return false; ui.pausedAt = ui.pausedAt === undefined ? v.now : undefined; ui.logOffset = 0; return true;
  }
  const selectedKey = ui.sel[panel];
  if (input === "\r" && selectedKey !== undefined) {
    if (panel === "processes") ui.modal = {type: "process", pid: Number(selectedKey)};
    else if (panel === "requests") ui.modal = {type: "request", id: selectedKey};
    else if (panel === "clients") ui.modal = {type: "client", key: selectedKey};
    return !!ui.modal;
  }
  if (input === "x" && panel === "processes" && selectedKey !== undefined) { ui.modal = {type: "kill", pid: Number(selectedKey)}; return true; }
  if (input === "c" && panel === "requests" && selectedKey !== undefined) { ui.modal = {type: "cancel", id: selectedKey}; return true; }
  return false;
}
// Splits a chunk of terminal input into keys: escape sequences or single characters.
// Text that arrives in one chunk with more than one character was pasted, not typed:
// it must not run commands, so only a run of escape sequences (held arrow keys) counts.
export function keys(chunk: string) {
  const all = chunk.replace(/\x1b\[200~[\s\S]*?(\x1b\[201~|$)/g, "").match(/\x1b\[[0-9;]*[A-Za-z~]|\x1bO[A-Z]|[\s\S]/gu) ?? [];
  return all.length > 1 && all.some(k => k.length === 1) ? [] : all;
}

// ---------- terminal ----------
// Resident set size per process group, in KB. Claude runs in its own group, so the
// group's total counts the CLI and anything it started.
function sampleMemory(signal: AbortSignal, done: (rss: Map<number, number>) => void) {
  execFile("ps", ["-A", "-o", "pgid=,rss="], {timeout: 3000, signal}, (error, stdout) => {
    if (error) return;
    const rss = new Map<number, number>();
    for (const line of stdout.split("\n")) {
      const [group, kb] = line.trim().split(/\s+/).map(Number);
      if (group > 0 && kb >= 0) rss.set(group, (rss.get(group) ?? 0) + kb);
    }
    done(rss);
  });
}

export function tuiConsole({token, fresh, host, port}: {token: string; fresh: boolean; host: string; port: number}): Console {
  return (monitor, stop) => {
    const out = process.stdout, input = process.stdin;
    // A token generated on this start is shown once, as C printed it before the TUI.
    const ui = newUi(fresh ? {type: "token"} : undefined, fresh);
    const closing = new AbortController();
    let server = loadSettings().server;
    let rss = new Map<number, number>();
    let restored = false, scheduled: NodeJS.Timeout | undefined, checking = false;
    // Requests cut short by stopping fail as "cancelled"; they are no news after exit.
    let stoppedAt = Infinity;
    const mark = () => { stoppedAt = Math.min(stoppedAt, Date.now()); };
    const quit = () => { mark(); stop(); };
    // A stop that hangs (a Claude process that will not let go) can be cut short with a
    // second Ctrl+C or signal, as before the TUI. The terminal is restored first.
    const force = () => {
      restore();
      saved.error("A-tether 没有等清理完成就退出了，可能有 Claude 进程留在后台。");
      process.exit(130);
    };
    const signalled = () => { if (stoppedAt < Infinity) force(); else mark(); };

    const saved = {log: console.log, info: console.info, warn: console.warn, error: console.error};
    console.log = console.info = (...args: unknown[]) => monitor.note("system", "info", format(...args));
    console.warn = console.error = (...args: unknown[]) => monitor.note("system", "warn", format(...args));
    monitor.quiet = true;

    const view = () => snapshot(monitor, {host, port, token, server, rss});
    const draw = () => {
      if (restored) return;
      clearTimeout(scheduled);
      scheduled = undefined;
      const lines = render(view(), ui, out.columns || 80, out.rows || 24);
      // Synchronized output keeps terminals that support it from showing half a frame.
      // Every line is exactly as wide as the terminal, so no erase-in-line: after the last
      // column it would clear that column.
      out.write("\x1b[?2026h\x1b[H" + lines.map(l => l + "\x1b[0m").join("\r\n") + "\x1b[J\x1b[?2026l");
    };
    monitor.onChange = () => { scheduled ??= setTimeout(draw, 100); };
    const restore = () => {
      if (restored) return;
      restored = true;
      try { input.setRawMode(false); } catch {}
      input.pause();
      out.write("\x1b[0m\x1b[?2004l\x1b[?25h\x1b[?1049l");
    };
    const onKey = (chunk: string) => {
      const v = view();
      // Below 80×24 nothing but the size notice shows, so only stopping keys count.
      const small = (out.columns || 80) < 80 || (out.rows || 24) < 24;
      if (small && ui.modal?.type !== "quit" && ui.modal?.type !== "stopping") ui.modal = undefined;
      let changed = false;
      for (const k of keys(chunk)) {
        if (small && !["q", "\x03", "\x1b"].includes(k)) continue;
        changed = press(k, v, ui, {stop: quit, force, cancel: id => monitor.cancel(id), kill: pid => monitor.kill(pid)}) || changed;
      }
      if (changed) draw();
    };
    const slow = () => {
      try { server = loadSettings().server; } catch {} // a broken file is reported on the next request
      sampleMemory(closing.signal, sample => { rss = sample; });
      // While Claude Code is not logged in, check again so the banner goes once it is.
      if (monitor.health && !monitor.health.loggedIn && !checking && Date.now() - monitor.health.at > 30_000) {
        checking = true;
        monitor.backend.status(closing.signal).then(h => { monitor.status(h); }, () => {}).finally(() => { checking = false; });
      }
    };

    out.on("error", () => {});
    out.write("\x1b[?1049h\x1b[?25l\x1b[?2004h\x1b[2J");
    input.setRawMode(true);
    input.setEncoding("utf8");
    input.on("data", onKey);
    input.resume();
    out.on("resize", draw);
    process.on("exit", restore);
    // A closed terminal cannot show the TUI any more: stop as on Ctrl+C.
    process.once("SIGHUP", quit);
    process.on("SIGINT", signalled);
    process.on("SIGTERM", signalled);
    const timers = [setInterval(draw, 1000), setInterval(slow, 5000)];
    slow();
    draw();

    return ({processes}) => {
      for (const timer of timers) clearInterval(timer);
      clearTimeout(scheduled);
      closing.abort();
      monitor.onChange = undefined;
      input.off("data", onKey);
      out.off("resize", draw);
      process.off("exit", restore);
      for (const [signal, listener] of [["SIGHUP", quit], ["SIGINT", signalled], ["SIGTERM", signalled]] as const) process.off(signal, listener);
      restore();
      Object.assign(console, saved);
      monitor.quiet = false;
      // Failures only lived on the TUI screen; leave them in the terminal's scrollback.
      const errors = monitor.entries.filter(e => e.tag === "error" && e.at < stoppedAt);
      console.log(`A-tether 已停止${processes ? `：结束了 ${processes} 个 Claude 进程` : ""}，临时文件已清理。`);
      if (errors.length) {
        console.log(`这次运行中的错误（${errors.length > 20 ? `最近 20 条，共 ${errors.length} 条` : errors.length + " 条"}）：`);
        for (const e of errors.slice(-20)) console.log(`  ${new Date(e.at).toISOString()} ${safe(e.text)}`);
      }
    };
  };
}
