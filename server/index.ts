import express from "express";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import { Pool } from "pg";
import { createClient } from "redis";
import * as Y from "yjs";
import { STARTER, mergeState } from "./document.ts";

const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ??
    "postgres://collabcode:collabcode@localhost:5432/collabcode",
});
const redis = createClient({
  url: process.env.REDIS_URL ?? "redis://localhost:6379",
});
redis.on("error", (e) => console.error("Redis:", e.message));
await redis.connect();
const subscriber = redis.duplicate();
await subscriber.connect();
await pool.query(
  `CREATE TABLE IF NOT EXISTS sessions (id UUID PRIMARY KEY, name VARCHAR(100) NOT NULL, state BYTEA NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
);
const app = express();
app.use(express.json({ limit: "16kb" }));
const server = createServer(app);
const wss = new WebSocketServer({
  server,
  path: "/ws",
  maxPayload: 1024 * 1024,
});
const instance = randomUUID();
type Peer = { id: string; name: string; color: string };
type Room = {
  doc: Y.Doc;
  peers: Map<WebSocket, Peer>;
  timer?: ReturnType<typeof setTimeout>;
  saving: Promise<void>;
};
const rooms = new Map<string, Promise<Room>>();
const send = (ws: WebSocket, value: unknown) => {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(value));
};
async function persist(id: string, room: Room) {
  const snapshot = Buffer.from(Y.encodeStateAsUpdate(room.doc));
  room.saving = room.saving
    .catch(() => {})
    .then(async () => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const r = await client.query(
          "SELECT state FROM sessions WHERE id=$1 FOR UPDATE",
          [id],
        );
        const merged = mergeState(r.rows[0].state, snapshot);
        await client.query(
          "UPDATE sessions SET state=$2,updated_at=now() WHERE id=$1",
          [id, Buffer.from(merged)],
        );
        await client.query("COMMIT");
        for (const ws of room.peers.keys())
          send(ws, { type: "saved", at: Date.now() });
      } catch (e) {
        await client.query("ROLLBACK");
        console.error("Save failed", e);
        for (const ws of room.peers.keys())
          send(ws, {
            type: "error",
            message: "Storage unavailable. Your edits remain in this browser.",
          });
      } finally {
        client.release();
      }
    });
  return room.saving;
}
async function getRoom(id: string) {
  if (!rooms.has(id)) {
    const pending = (async () => {
      const result = await pool.query(
        "SELECT state FROM sessions WHERE id=$1",
        [id],
      );
      if (!result.rows.length) throw Error("Session not found");
      const room: Room = {
        doc: new Y.Doc(),
        peers: new Map(),
        saving: Promise.resolve(),
      };
      Y.applyUpdate(room.doc, result.rows[0].state);
      room.doc.on("update", (update: Uint8Array, origin: unknown) => {
        for (const ws of room.peers.keys())
          if (ws !== origin)
            send(ws, {
              type: "update",
              data: Buffer.from(update).toString("base64"),
            });
        if (origin !== "redis")
          void redis
            .publish(
              "collabcode:updates",
              JSON.stringify({
                instance,
                id,
                data: Buffer.from(update).toString("base64"),
              }),
            )
            .catch(console.error);
        clearTimeout(room.timer);
        room.timer = setTimeout(() => void persist(id, room), 600);
      });
      return room;
    })();
    rooms.set(id, pending);
    pending.catch(() => rooms.delete(id));
  }
  return rooms.get(id)!;
}
await subscriber.subscribe("collabcode:updates", async (raw) => {
  try {
    const message = JSON.parse(raw);
    if (message.instance === instance || !rooms.has(message.id)) return;
    const room = await rooms.get(message.id)!;
    Y.applyUpdate(room.doc, Buffer.from(message.data, "base64"), "redis");
  } catch (e) {
    console.error(e);
  }
});
app.get("/api/health", async (_req, res) => {
  try {
    await pool.query("SELECT 1");
    await redis.ping();
    res.json({ ok: true });
  } catch {
    res.status(503).json({ ok: false });
  }
});
app.post("/api/sessions", async (req, res, next) => {
  try {
    const name =
      typeof req.body.name === "string"
        ? req.body.name.trim().slice(0, 100)
        : "Untitled session";
    const id = randomUUID();
    const doc = new Y.Doc();
    doc.getText("code").insert(0, STARTER);
    await pool.query("INSERT INTO sessions (id,name,state) VALUES ($1,$2,$3)", [
      id,
      name || "Untitled session",
      Buffer.from(Y.encodeStateAsUpdate(doc)),
    ]);
    doc.destroy();
    res.status(201).json({ id, name: name || "Untitled session" });
  } catch (e) {
    next(e);
  }
});
const validId = (id: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
app.get("/api/sessions/:id", async (req, res, next) => {
  try {
    if (!validId(req.params.id)) {
      res.status(400).json({ error: "Invalid session ID" });
      return;
    }
    const r = await pool.query(
      "SELECT id,name,updated_at FROM sessions WHERE id=$1",
      [req.params.id],
    );
    if (!r.rows.length) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    res.json(r.rows[0]);
  } catch (e) {
    next(e);
  }
});
wss.on("connection", async (ws, req) => {
  const url = new URL(req.url!, "http://localhost");
  const id = url.searchParams.get("session") || "";
  if (!validId(id)) {
    ws.close(1008, "Invalid session");
    return;
  }
  try {
    const room = await getRoom(id);
    if (ws.readyState !== WebSocket.OPEN) return;
    const peer: Peer = {
      id: randomUUID(),
      name: (url.searchParams.get("name") || "Guest").slice(0, 32),
      color: ["#b7f271", "#9b9fff", "#ffbd75", "#75d9d0"][room.peers.size % 4],
    };
    room.peers.set(ws, peer);
    const presence = () => {
      for (const socket of room.peers.keys())
        send(socket, { type: "presence", peers: [...room.peers.values()] });
    };
    send(ws, {
      type: "init",
      data: Buffer.from(Y.encodeStateAsUpdate(room.doc)).toString("base64"),
      peer,
    });
    presence();
    let alive = true;
    ws.on("pong", () => {
      alive = true;
    });
    const heartbeat = setInterval(() => {
      if (!alive) {
        ws.terminate();
        return;
      }
      alive = false;
      ws.ping();
    }, 30000);
    ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === "update" && typeof msg.data === "string")
          Y.applyUpdate(room.doc, Buffer.from(msg.data, "base64"), ws);
        else if (msg.type === "awareness" && typeof msg.data === "string")
          for (const socket of room.peers.keys())
            if (socket !== ws)
              send(socket, { type: "awareness", data: msg.data });
      } catch {
        send(ws, { type: "error", message: "Invalid synchronization message" });
      }
    });
    ws.on("close", () => {
      clearInterval(heartbeat);
      room.peers.delete(ws);
      presence();
      for (const socket of room.peers.keys())
        send(socket, { type: "left", clientId: peer.id });
      void persist(id, room);
    });
  } catch {
    ws.close(1008, "Session unavailable");
  }
});
app.use(express.static(path.resolve("dist")));
app.get("/{*path}", (_req, res) =>
  res.sendFile(path.resolve("dist/index.html")),
);
app.use(
  (
    error: Error,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) => {
    console.error(error);
    res.status(500).json({ error: "Unable to complete request" });
  },
);
server.listen(Number(process.env.PORT || 3001), "0.0.0.0", () =>
  console.log("Collabcode listening on http://localhost:3001"),
);
async function shutdown() {
  for (const pending of rooms.values()) {
    const room = await pending;
    clearTimeout(room.timer);
  }
  for (const [id, pending] of rooms) await persist(id, await pending);
  wss.clients.forEach((ws) => ws.close(1001, "Restarting"));
  server.close();
  await subscriber.quit();
  await redis.quit();
  await pool.end();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
