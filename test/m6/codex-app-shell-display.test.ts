import assert from "node:assert/strict";
import test from "node:test";

import { formatActivityTime, getThreadDisplay, getWorkspaceDisplay } from "../../src/client/display.ts";

test("workspace display emphasizes the project folder like Codex App", () => {
  const workspace = getWorkspaceDisplay("C:\\Users\\aokuni\\Documents\\New project");

  assert.equal(workspace.name, "New project");
  assert.equal(workspace.parent, "C:\\Users\\aokuni\\Documents");
  assert.equal(workspace.fullPath, "C:\\Users\\aokuni\\Documents\\New project");
});

test("thread display keeps titles compact and falls back to the id", () => {
  assert.deepEqual(getThreadDisplay({ id: "thread-123", title: "Fix Codex App-style project sidebar" }), {
    subtitle: "thread-123",
    title: "Fix Codex App-style project sidebar",
  });
  assert.deepEqual(getThreadDisplay({ id: "thread-123" }), {
    subtitle: "Untitled thread",
    title: "thread-123",
  });
});

test("activity time accepts app-server unix seconds and browser milliseconds", () => {
  assert.equal(formatActivityTime(undefined), "No recent activity");
  assert.equal(formatActivityTime(1_775_600_000).includes("1970"), false);
  assert.equal(formatActivityTime(1_775_600_000_000).includes("1970"), false);
});
