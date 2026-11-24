import { test } from "node:test";
import assert from "node:assert/strict";
import * as Y from "yjs";
import { mergeState } from "../server/document.ts";
test("simultaneous inserts converge regardless of delivery order", () => {
  const a = new Y.Doc(),
    b = new Y.Doc();
  a.getText("code").insert(0, "hello");
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
  a.getText("code").insert(5, " Alice");
  b.getText("code").insert(5, " Bob");
  const sa = Y.encodeStateAsUpdate(a),
    sb = Y.encodeStateAsUpdate(b);
  Y.applyUpdate(a, sb);
  Y.applyUpdate(b, sa);
  assert.equal(a.getText("code").toString(), b.getText("code").toString());
  assert.match(a.getText("code").toString(), /Alice/);
  assert.match(a.getText("code").toString(), /Bob/);
});
test("persisted state merges stale snapshots without losing edits", () => {
  const a = new Y.Doc(),
    b = new Y.Doc();
  a.getText("code").insert(0, "base");
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
  a.getText("code").insert(4, " one");
  b.getText("code").insert(0, "two ");
  const saved = mergeState(Y.encodeStateAsUpdate(a), Y.encodeStateAsUpdate(b));
  const restored = new Y.Doc();
  Y.applyUpdate(restored, saved);
  assert.equal(restored.getText("code").toString(), "two base one");
  Y.applyUpdate(restored, saved);
  assert.equal(restored.getText("code").toString(), "two base one");
});
