import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { WebSocket } from "ws";
import * as Y from "yjs";
const base = "http://localhost:3101";
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(check: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 100; i++) {
    if (await check()) return;
    await delay(100);
  }
  throw Error("Timed out");
}
async function start() {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "server/index.ts"],
    { env: { ...process.env, PORT: "3101" }, stdio: "pipe" },
  );
  child.stderr.on("data", (d) => process.stderr.write(d));
  await until(async () => {
    try {
      return (await fetch(base + "/api/health")).ok;
    } catch {
      return false;
    }
  });
  return child;
}
async function stop(child: ChildProcess) {
  const exit = once(child, "exit");
  child.kill("SIGTERM");
  await exit;
}
async function connect(id: string, name: string) {
  const doc = new Y.Doc();
  const ws = new WebSocket(`ws://localhost:3101/ws?session=${id}&name=${name}`);
  let ready = false;
  let saved = false;
  let peers = 0;
  ws.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.type === "init" || m.type === "update") {
      Y.applyUpdate(doc, Buffer.from(m.data, "base64"), "remote");
      if (m.type === "init") ready = true;
    }
    if (m.type === "saved") saved = true;
    if (m.type === "presence") peers = m.peers.length;
  });
  doc.on("update", (u: Uint8Array, origin: unknown) => {
    if (origin !== "remote")
      ws.send(
        JSON.stringify({
          type: "update",
          data: Buffer.from(u).toString("base64"),
        }),
      );
  });
  await until(() => ready);
  return { doc, ws, saved: () => saved, peers: () => peers };
}
test(
  "two WebSocket users merge edits, presence updates, and PostgreSQL survives restart",
  { timeout: 30000 },
  async () => {
    let child = await start();
    const sockets: WebSocket[] = [];
    try {
      const r = await fetch(base + "/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Integration workspace" }),
      });
      assert.equal(r.status, 201);
      const { id } = (await r.json()) as { id: string };
      const a = await connect(id, "Alice"),
        b = await connect(id, "Bob");
      sockets.push(a.ws, b.ws);
      await until(() => a.peers() === 2 && b.peers() === 2);
      a.doc.getText("code").insert(0, "// Alice edit\n");
      b.doc.getText("code").insert(0, "// Bob edit\n");
      await until(
        () =>
          a.doc.getText("code").toString() === b.doc.getText("code").toString(),
      );
      const code = a.doc.getText("code").toString();
      assert.match(code, /Alice edit/);
      assert.match(code, /Bob edit/);
      await until(() => a.saved() && b.saved());
      b.ws.close();
      await until(() => a.peers() === 1);
      a.ws.close();
      await stop(child);
      child = await start();
      const c = await connect(id, "Returning user");
      sockets.push(c.ws);
      assert.equal(c.doc.getText("code").toString(), code);
      c.ws.close();
      const invalid = await fetch(base + "/api/sessions/not-an-id");
      assert.equal(invalid.status, 400);
      console.log(
        "Verified: session API, two-client convergence, presence, saved events, restart persistence, invalid IDs.",
      );
    } finally {
      for (const ws of sockets) ws.terminate();
      await stop(child);
    }
  },
);
