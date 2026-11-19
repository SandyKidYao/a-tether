#!/usr/bin/env node
// Offline stand-in for a long-lived `claude -p` with an "sdk" MCP server. It lists the
// tools through the host, then answers each user message: "CALL" makes one tool call
// and waits for the host's result, "SLOW" never finishes, "DRIP n" streams n deltas over
// n/10 seconds, anything else gets a reply.
// Everything it receives is appended to $TEST_LOG.
import {appendFileSync} from "node:fs";
import {createInterface} from "node:readline";

const log = entry => appendFileSync(process.env.TEST_LOG, JSON.stringify({pid: process.pid, ...entry}) + "\n");
const arg = name => process.argv[process.argv.indexOf(name) + 1];
const out = frame => console.log(JSON.stringify(frame));
log({event: "start", model: arg("--model"), mcp: JSON.parse(arg("--mcp-config")), allowed: arg("--allowedTools"),
  effort: process.argv.includes("--effort") ? arg("--effort") : undefined,
  compact: process.env.DISABLE_AUTO_COMPACT});

const lines = createInterface({input: process.stdin})[Symbol.asyncIterator]();
const queue = [];
async function readLine() {
  const next = await lines.next();
  if (next.done) process.exit(0);
  return JSON.parse(next.value);
}
const read = () => queue.length ? queue.shift() : readLine();
let seq = 0;
// Sends an MCP message to the host and waits for its answer, queueing other input.
async function mcp(method, params) {
  const request_id = "cli-" + ++seq;
  out({type: "control_request", request_id, request: {subtype: "mcp_message", server_name: "tether", message: {jsonrpc: "2.0", id: seq, method, params}}});
  for (;;) {
    const frame = await readLine();
    if (frame.type === "control_response" && frame.response.request_id === request_id) return frame.response.response.mcp_response;
    queue.push(frame);
  }
}
let tools = [];
async function listTools() {
  tools = (await mcp("tools/list")).result.tools;
  log({event: "tools", tools: tools.map(t => t.name)});
}
function reply(blocks, stop) {
  const id = `msg_${process.pid}_${++seq}`;
  out({type: "stream_event", event: {type: "message_start", message: {id, usage: {input_tokens: 1}}}});
  blocks.forEach((block, index) => {
    if (block.type === "text") {
      out({type: "stream_event", event: {type: "content_block_start", index, content_block: {type: "text", text: ""}}});
      out({type: "stream_event", event: {type: "content_block_delta", index, delta: {type: "text_delta", text: block.text}}});
    }
    out({type: "assistant", message: {id, content: [block], stop_reason: null}});
    out({type: "stream_event", event: {type: "content_block_stop", index}});
  });
  out({type: "stream_event", event: {type: "message_delta", delta: {stop_reason: stop},
    usage: {input_tokens: 10, cache_read_input_tokens: seq, cache_creation_input_tokens: 3, output_tokens: 5}}});
  out({type: "stream_event", event: {type: "message_stop"}});
}

await listTools();
for (;;) {
  const frame = await read();
  if (frame.type === "control_request") { // a host notification, e.g. tools/list_changed
    log({event: "notification", method: frame.request.message?.method});
    out({type: "control_response", response: {subtype: "success", request_id: frame.request_id}});
    await listTools();
    continue;
  }
  if (frame.type !== "user") continue;
  log({event: "user", content: frame.message.content});
  const text = JSON.stringify(frame.message.content);
  if (text.includes("SLOW")) {
    out({type: "stream_event", event: {type: "message_start", message: {id: "slow"}}});
    continue;
  }
  const drip = /DRIP (\d+)/.exec(text);
  if (drip) {
    // A reply that takes time: one delta every 100 ms, so a test can break the link midway.
    const id = `msg_${process.pid}_${++seq}`;
    let full = "";
    out({type: "stream_event", event: {type: "message_start", message: {id, usage: {input_tokens: 1}}}});
    out({type: "stream_event", event: {type: "content_block_start", index: 0, content_block: {type: "text", text: ""}}});
    for (let i = 0; i < Number(drip[1]); i++) {
      full += `d${i} `;
      out({type: "stream_event", event: {type: "content_block_delta", index: 0, delta: {type: "text_delta", text: `d${i} `}}});
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    out({type: "assistant", message: {id, content: [{type: "text", text: full}], stop_reason: null}});
    out({type: "stream_event", event: {type: "content_block_stop", index: 0}});
    out({type: "stream_event", event: {type: "message_delta", delta: {stop_reason: "end_turn"}, usage: {input_tokens: 10, output_tokens: 5}}});
    out({type: "stream_event", event: {type: "message_stop"}});
  } else if (text.includes("CALL")) {
    const id = `toolu_${process.pid}_${++seq}`;
    reply([{type: "text", text: "calling"}, {type: "tool_use", id, name: "mcp__tether__" + tools[0].name, input: {command: "ls"}}], "tool_use");
    const answer = await mcp("tools/call", {name: tools[0].name, arguments: {command: "ls"}, _meta: {"claudecode/toolUseId": id}});
    log({event: "result", result: answer.result});
    reply([{type: "text", text: "tool said " + answer.result.content[0].text}], "end_turn");
  } else {
    reply([{type: "text", text: "reply " + seq}], "end_turn");
  }
  // The turn total, which the per-call usage above must win over.
  out({type: "result", subtype: "success", is_error: false, stop_reason: "end_turn", usage: {input_tokens: 999}});
}
