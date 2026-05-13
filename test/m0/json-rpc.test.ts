import assert from "node:assert/strict";
import test from "node:test";

import { JsonRpcLineBuffer, JsonRpcPeer } from "../../src/m0/json-rpc.ts";

test("JsonRpcLineBuffer parses newline-delimited JSON messages and keeps partial lines", () => {
  const buffer = new JsonRpcLineBuffer();

  assert.deepEqual(buffer.push('{"id":1'), []);
  assert.deepEqual(buffer.push(',"result":"ok"}\n{"method":"event"'), [{ id: 1, result: "ok" }]);
  assert.deepEqual(buffer.push(',"params":{"x":1}}\n'), [{ method: "event", params: { x: 1 } }]);
});

test("JsonRpcLineBuffer reports invalid JSON with the original line", () => {
  const buffer = new JsonRpcLineBuffer();

  assert.throws(
    () => buffer.push("{not-json}\n"),
    (error) => error instanceof Error && error.message.includes("{not-json}"),
  );
});

test("JsonRpcPeer allocates monotonically increasing request ids and omits jsonrpc by default", () => {
  const writes: string[] = [];
  const peer = new JsonRpcPeer((line) => writes.push(line));

  const first = peer.request("initialize", { clientInfo: { name: "codex_web_m0" } });
  const second = peer.request("model/list", {});

  assert.equal(first.id, 1);
  assert.equal(second.id, 2);
  assert.deepEqual(JSON.parse(writes[0]!), {
    id: 1,
    method: "initialize",
    params: { clientInfo: { name: "codex_web_m0" } },
  });
  assert.equal(JSON.parse(writes[0]!).jsonrpc, undefined);
});

test("JsonRpcPeer resolves matching responses and emits notifications separately", async () => {
  const writes: string[] = [];
  const notifications: unknown[] = [];
  const peer = new JsonRpcPeer((line) => writes.push(line), {
    onNotification: (message) => notifications.push(message),
  });

  const pending = peer.request("model/list", {});
  peer.receive({ method: "thread/item/updated", params: { itemId: "item_1" } });
  peer.receive({ id: pending.id, result: { models: [] } });

  assert.deepEqual(await pending.response, { models: [] });
  assert.deepEqual(notifications, [{ method: "thread/item/updated", params: { itemId: "item_1" } }]);
});
