// The histories C holds so that A sends only what a turn adds. Memory only: nothing
// here is written to disk, and everything goes when the server stops. Losing an entry
// is harmless: C answers `resync` and A sends the whole context.
import { chainOf, digest, isRef, type WireContext } from "../shared/protocol.ts";

type Snapshot = {messages: unknown[]; sizes: number[]};
export type Resolved = {messages: unknown[]; chain: string};

export class Contexts {
  // By the chain of the history's digests, least recently used first.
  private snapshots = new Map<string, Snapshot>();
  // C's own replies by digest: A names them instead of sending them back.
  private replies = new Map<string, {message: unknown; size: number}>();
  bytes = 0;

  constructor(private maxBytes = 256 * 1024 * 1024, private maxSnapshots = 64, private maxReplies = 256) {}

  // The whole history a request describes, or undefined when C lacks its base or a
  // reply it names.
  resolve(wire: WireContext): Resolved | undefined {
    let messages: unknown[] = [], sizes: number[] = [], chain = "";
    if (wire.base) {
      const base = this.snapshots.get(wire.base.chain);
      if (!base || base.messages.length !== wire.base.count) return undefined;
      // Touch it: the conversation it belongs to is in use.
      this.snapshots.delete(wire.base.chain);
      this.snapshots.set(wire.base.chain, base);
      messages = base.messages.slice();
      sizes = base.sizes.slice();
      chain = wire.base.chain;
    }
    for (const item of wire.add) {
      if (isRef(item)) {
        const reply = this.replies.get(item.$ref);
        if (!reply) return undefined;
        messages.push(reply.message);
        sizes.push(reply.size);
        chain = chainOf(chain, item.$ref);
      } else {
        const json = JSON.stringify(item);
        messages.push(item);
        sizes.push(json.length);
        chain = chainOf(chain, digest(json));
      }
    }
    this.snapshots.delete(chain);
    this.snapshots.set(chain, {messages, sizes});
    this.trim();
    return {messages, chain};
  }

  // Remembers a reply C generated, under the digest A will compute for its copy.
  reply(message: unknown) {
    const json = JSON.stringify(message);
    const key = digest(json);
    this.replies.delete(key);
    this.replies.set(key, {message: JSON.parse(json), size: json.length});
    while (this.replies.size > this.maxReplies) this.replies.delete(this.replies.keys().next().value!);
  }

  get count() { return this.snapshots.size; }

  // Snapshots of one conversation share their messages, so memory is what the distinct
  // messages take. Drops the least recently used snapshots while over a limit.
  private trim() {
    for (;;) {
      const seen = new Set<unknown>();
      let bytes = 0;
      for (const snapshot of this.snapshots.values()) {
        snapshot.messages.forEach((message, i) => {
          if (seen.has(message)) return;
          seen.add(message);
          bytes += snapshot.sizes[i];
        });
      }
      this.bytes = bytes;
      if (this.snapshots.size <= 1 || (this.snapshots.size <= this.maxSnapshots && bytes <= this.maxBytes)) return;
      this.snapshots.delete(this.snapshots.keys().next().value!);
    }
  }
}
