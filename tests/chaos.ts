// A TCP proxy between A and C that misbehaves on demand: it can cut every connection,
// refuse new ones, hold bytes back without closing anything (as lost packets do), and
// stall a connection the first time it carries more than a few bytes at once (as a link
// that drops large packets does until the sender falls back to small ones).
import {once} from "node:events";
import {connect, createServer, type Socket} from "node:net";
import type {TestContext} from "node:test";

export async function chaos(t: TestContext, target: number) {
  const pairs = new Set<[Socket, Socket]>();
  const waiting: (() => void)[] = [];
  const state = {refusing: false, paused: false, stall: undefined as {over: number; ms: number} | undefined,
    up: 0, down: 0, connections: 0};
  const server = createServer(a => {
    if (state.refusing) return void a.destroy();
    state.connections++;
    const b = connect(target, "127.0.0.1");
    const pair: [Socket, Socket] = [a, b];
    pairs.add(pair);
    const close = () => { a.destroy(); b.destroy(); pairs.delete(pair); };
    for (const socket of pair) socket.on("error", close);
    const forward = (from: Socket, to: Socket, direction: "up" | "down") => {
      let stalled = false;
      let order: Promise<void> = Promise.resolve();
      const step = (act: () => void, wait = 0) => {
        order = order.then(async () => {
          // Not kept alive by a stall nobody waits for any more.
          if (wait) await new Promise<void>(resolve => setTimeout(resolve, wait).unref());
          while (state.paused) await new Promise<void>(resolve => waiting.push(resolve));
          if (!to.destroyed) act();
        });
      };
      from.on("data", chunk => {
        state[direction] += chunk.length;
        const wait = state.stall && !stalled && chunk.length > state.stall.over ? state.stall.ms : 0;
        if (wait) stalled = true;
        step(() => to.write(chunk), wait);
      });
      from.on("end", () => step(() => to.end()));
      // After what is still on its way: a reply held back must not be lost because its
      // sender has already closed.
      from.on("close", () => step(() => { to.destroy(); pairs.delete(pair); }));
    };
    forward(a, b, "up");
    forward(b, a, "down");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const resume = () => { state.paused = false; for (const go of waiting.splice(0)) go(); };
  const cut = () => { for (const [a, b] of pairs) { a.destroy(); b.destroy(); } };
  t.after(() => { resume(); cut(); server.close(); });
  return {
    port: (server.address() as {port: number}).port, state, cut, resume,
    // Bytes stop moving in both directions; connections stay open.
    pause() { state.paused = true; },
    // The link is gone: open connections die and new ones are turned away.
    down() { state.refusing = true; cut(); },
    up() { state.refusing = false; },
  };
}
