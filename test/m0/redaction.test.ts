import assert from "node:assert/strict";
import test from "node:test";

import { hashDirectory, hashJsonDirectory, redactForReport } from "../../src/m0/redaction.ts";

test("redactForReport replaces user-specific absolute Windows paths", () => {
  const input = "C:\\Users\\aokuni\\Documents\\New project\\src\\file.ts";

  assert.equal(redactForReport(input), "<USER_HOME>\\Documents\\New project\\src\\file.ts");
});

test("redactForReport replaces JSON-escaped Windows home paths", () => {
  const input = String.raw`{"path":"C:\\Users\\aokuni\\.codex\\file.json"}`;

  assert.equal(redactForReport(input), String.raw`{"path":"<USER_HOME_ESCAPED>\\.codex\\file.json"}`);
});

test("redactForReport keeps command names but removes prompt-like text", () => {
  const input = {
    command: "codex app-server --listen stdio://",
    prompt: "private task body",
    result: "ok",
  };

  assert.deepEqual(redactForReport(input), {
    command: "codex app-server --listen stdio://",
    prompt: "<redacted>",
    result: "ok",
  });
});

test("hashDirectory returns the same hash regardless of file enumeration order", async () => {
  const files = new Map([
    ["b.json", '{"b":2}'],
    ["a.json", '{"a":1}'],
  ]);

  const first = await hashDirectory(files);
  const second = await hashDirectory(new Map([...files].reverse()));

  assert.match(first, /^[a-f0-9]{64}$/);
  assert.equal(first, second);
});

test("hashJsonDirectory canonicalizes JSON object key order before hashing", async () => {
  const first = await hashJsonDirectory(new Map([["schema.json", '{"b":2,"a":{"d":4,"c":3}}']]));
  const second = await hashJsonDirectory(new Map([["schema.json", '{"a":{"c":3,"d":4},"b":2}']]));

  assert.equal(first, second);
});
