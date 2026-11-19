import type { AssistantMessageEventStream, Model, SimpleStreamOptions, TranscriptContext } from "@earendil-works/pi-ai";
import type { Code } from "../shared/protocol.ts";

// route is a backend-local model identifier. Only the public model crosses the wire.
export type BackendModel = Model<string> & { route: string };

// What C's console shows about model processes. Counts and names only: no
// conversation content and no tool arguments.
export type ProcessInfo = {
  pid?: number;
  state: "generating" | "awaitingTools" | "finishing" | "idle";
  busy: boolean;
  // Kept between requests; a one-shot process ends with its request.
  pooled: boolean;
  model: string;
  effort?: string;
  // Messages of the conversation the process holds.
  history: number;
  // Names of the tool calls whose results the process waits for.
  pending: string[];
  reuses: number;
  started: number;
  lastUsed: number;
  // When an idle process is reclaimed.
  reclaimAt?: number;
};
// How a request got its process: an existing one that continues the history, a new
// one for a new conversation, a new one fed the whole history, or one outside the pool.
export type Lease = {pid?: number; how: "reused" | "started" | "rebuilt" | "oneshot"; history: number;
  added?: {results: number} | {messages: number}};
export type ExitReason = "idle" | "evicted" | "oneshot" | "diverged" | "cancelled" | "lost" | "failed" | "exited" | "killed" | "shutdown";
export type ProcessExit = {pid?: number; model: string; why: ExitReason; history: number};

export interface Backend {
  name: string;
  // detail is a short local diagnostic for the C log; it never crosses the wire.
  status(signal?: AbortSignal): Promise<{ available: boolean; loggedIn: boolean; diagnostic: boolean; detail?: string }>;
  models(signal: AbortSignal): Promise<BackendModel[]>;
  // hooks.lease reports which process serves the request, once it is known.
  stream(model: BackendModel, context: TranscriptContext, options: SimpleStreamOptions,
    hooks?: {lease?(lease: Lease): void}): AssistantMessageEventStream;
  errorCode(detail: string): Code;
  // Process counts reported by /v1/health; they carry no conversation data.
  stats?(): {processes: number; started: number; reused: number};
  // For C's console: running processes, their exits, and ending one by hand.
  processes?(): ProcessInfo[];
  watch?(listener: (exit: ProcessExit) => void): () => void;
  kill?(pid: number): boolean;
  // Releases processes kept between requests; called once when the server stops.
  close?(): Promise<void>;
}
