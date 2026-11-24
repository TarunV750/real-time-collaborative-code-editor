# Collabcode

A full-stack collaborative code editor built with **TypeScript, React, Node.js, WebSockets, Redis, PostgreSQL, and Docker**.

## Run the complete project

Install Docker Desktop, start it, then run from this directory:

```sh
docker compose up --build -d
```

Open **http://localhost:3001**. Create a workspace, choose your display name using the bottom-left avatar, and click **Invite teammate**. Open the copied URL in a second browser window or share it with someone who can reach your server. Both users can edit the same document simultaneously.

```sh
docker compose down          # stop; keep saved sessions
docker compose logs -f app  # inspect server logs
```

The `postgres_data` Docker volume preserves sessions across restarts. `docker compose down -v` permanently deletes that volume.

## Local development

Requires Node.js 22+ and Docker Desktop.

```sh
npm ci
docker compose up -d postgres redis
npm run dev
```

Open **http://localhost:5173**. Vite proxies API and WebSocket requests to port 3001. The server defaults to the database and Redis URLs in `.env.example`; export environment variables to override these defaults. The app does not automatically load `.env` files.

```sh
npm run build  # type-check and build the React application
npm test       # CRDT convergence and persistence merge tests
npm start      # serve the built frontend and API on port 3001
```

For the live integration test, keep PostgreSQL and Redis running. The test starts its own server on port 3101:

```sh
npm run test:integration
```

## Features

- Create shared workspaces and join through a unique session link.
- Merge simultaneous edits using Yjs CRDTs rather than overwriting whole documents.
- Live collaborator list, shared cursor/selection awareness, and per-user undo/redo.
- Automatic WebSocket reconnection and synchronization of edits retained in the current tab.
- TypeScript, JavaScript, and Python syntax highlighting, adjustable font size, and code downloads.
- PostgreSQL storage with debounced saves and transactional merges.
- Redis pub/sub for propagating code updates across Node.js processes.
- Responsive dark editor UI with connection and save status.

## Architecture

```text
React + CodeMirror + Yjs
          | HTTP / WebSocket
     Node.js + Express
          |          |
     PostgreSQL    Redis pub/sub
     Yjs state     code updates
```

`POST /api/sessions` creates a document. `GET /api/sessions/:id` returns its metadata. `GET /api/health` checks database and Redis availability. `/ws?session=<uuid>&name=<name>` exchanges Yjs updates and ephemeral presence. On connection the server sends its persisted state, and the client returns its merged state to recover edits after a dropped connection. PostgreSQL transactions merge stored snapshots with incoming snapshots to preserve edits from concurrent saves.

## Scope and deployment

Each workspace contains one shared file. Language selection and font size are local preferences. This editor does not execute user code. It is suitable for local demonstrations and trusted team use: possession of the session URL grants access; authentication, permission management, rate limits, and session deletion are not included. Use HTTPS/WSS and managed secrets before exposing it on the internet; replace the development database password.

Code changes propagate through Redis, while cursors and collaborator lists are scoped to a single server process. Keep one application instance for complete presence behavior. Active room documents stay in server memory until restart. Changes are saved after a short debounce; keep the tab open until the saved indicator appears. Offline changes survive a connection interruption in the current tab, but are not stored offline across a page refresh. PostgreSQL stores the document and workspace name; display names and cursors are ephemeral.
