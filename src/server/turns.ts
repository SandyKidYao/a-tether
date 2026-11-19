// A turn is one model reply. It lives on C apart from any connection: its frames are
// numbered and kept in memory, so an A whose connection broke attaches again and
// continues after the last frame it has. A finished turn stays until A releases it,
// and a request for the same context gets it replayed instead of a second generation.
import type { ActiveRequest } from "./monitor.ts";

// What a connection attached to a turn is told.
export type Subscriber = {
  // New frames, or the end of the turn.
  wake(): void;
  // A line outside the numbered frames.
  beat(line: string): void;
  // Another connection took over.
  kick(): void;
};

export class Turn {
  // frames[i] carries n = i + 1.
  readonly frames: string[] = [];
  readonly ids = new Set<string>();
  bytes = 0;
  state: "running" | "done" | "failed" = "running";
  ended?: number;
  // Resolves when generation has stopped and the backend is released.
  settled: Promise<void> = Promise.resolve();
  private subscriber?: Subscriber;

  constructor(readonly entry: ActiveRequest, readonly key: string) { this.ids.add(entry.id); }

  push(frame: object) {
    const line = JSON.stringify({n: this.frames.length + 1, ...frame});
    this.frames.push(line);
    this.bytes += line.length;
    this.subscriber?.wake();
  }
  beat(frame: object) { this.subscriber?.beat(JSON.stringify(frame)); }
  end(state: "done" | "failed", now = Date.now()) {
    this.state = state;
    this.ended = now;
    this.subscriber?.wake();
  }

  // One connection at a time: a new one replaces the old, which is usually dead.
  subscribe(subscriber: Subscriber, now = Date.now()) {
    this.subscriber?.kick();
    this.subscriber = subscriber;
    this.entry.heard = now;
    this.entry.attached = true;
    this.entry.detached = undefined;
    return () => {
      if (this.subscriber !== subscriber) return;
      this.subscriber = undefined;
      this.entry.attached = false;
      this.entry.detached = Date.now();
    };
  }
  kick() { this.subscriber?.kick(); }
}

// How long a turn stays after it ended: a finished one until A fetches it, a failed
// one just long enough for a reconnecting A to read why.
export const retention = {done: 10 * 60_000, failed: 60_000};

export class Turns {
  private byId = new Map<string, Turn>();
  private byKey = new Map<string, Turn>();

  constructor(private maxBytes = 64 * 1024 * 1024) {}

  get(id: string) { return this.byId.get(id); }
  all() { return new Set(this.byId.values()); }
  // A turn for the same context that is running or finished and not yet released.
  reusable(key: string) {
    const turn = this.byKey.get(key);
    return turn && turn.state !== "failed" ? turn : undefined;
  }
  add(turn: Turn) {
    this.byId.set(turn.entry.id, turn);
    this.byKey.set(turn.key, turn);
  }
  // Another request for the same context joins the turn. When nobody reads the turn,
  // the requests that started it have given up, and the new one takes it over: what
  // they say about it later no longer counts.
  alias(id: string, turn: Turn) {
    if (!turn.entry.attached) {
      for (const old of turn.ids) if (this.byId.get(old) === turn) this.byId.delete(old);
      turn.ids.clear();
    }
    turn.ids.add(id);
    this.byId.set(id, turn);
  }
  // One of the turn's IDs no longer wants it. True when that was the last one: several
  // requests for the same context share a turn, and one giving up must not end it for
  // the others.
  unlink(id: string, turn: Turn) {
    turn.ids.delete(id);
    if (this.byId.get(id) === turn) this.byId.delete(id);
    return turn.ids.size === 0;
  }
  drop(turn: Turn) {
    for (const id of turn.ids) if (this.byId.get(id) === turn) this.byId.delete(id);
    if (this.byKey.get(turn.key) === turn) this.byKey.delete(turn.key);
    // A connection still reading the turn finishes by itself: only ended turns are dropped.
  }
  // A failed turn is never replayed: the next request for its context starts afresh.
  forget(turn: Turn) { if (this.byKey.get(turn.key) === turn) this.byKey.delete(turn.key); }

  // Drops ended turns past their retention, then the oldest ended ones while the
  // buffers exceed the limit.
  sweep(now = Date.now()) {
    const ended = [...this.all()].filter(turn => turn.ended !== undefined).sort((a, b) => a.ended! - b.ended!);
    let bytes = [...this.all()].reduce((sum, turn) => sum + turn.bytes, 0);
    for (const turn of ended) {
      const expired = now - turn.ended! > retention[turn.state === "done" ? "done" : "failed"];
      if (!expired && bytes <= this.maxBytes) continue;
      bytes -= turn.bytes;
      this.drop(turn);
    }
  }
}
