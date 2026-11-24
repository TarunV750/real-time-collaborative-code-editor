import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { EditorView, keymap } from "@codemirror/view";
import { EditorState, Compartment } from "@codemirror/state";
import { basicSetup } from "codemirror";
import { javascript } from "@codemirror/lang-javascript";
import { python } from "@codemirror/lang-python";
import { oneDark } from "@codemirror/theme-one-dark";
import { yCollab, yUndoManagerKeymap } from "y-codemirror.next";
import * as Y from "yjs";
import {
  Awareness,
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
} from "y-protocols/awareness";
import {
  Code2,
  Plus,
  FileCode2,
  ChevronRight,
  Copy,
  Download,
  Users,
  Settings2,
  PanelLeftClose,
  Check,
  Wifi,
  Terminal,
  X,
  Command,
  CircleHelp,
  Link,
  ArrowUpRight,
} from "lucide-react";
import "./style.css";
const to64 = (data: Uint8Array) => {
  let s = "";
  for (const b of data) s += String.fromCharCode(b);
  return btoa(s);
};
const from64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
type Peer = { id: string; name: string; color: string };
function App() {
  const [session, setSession] = useState(
    new URLSearchParams(location.search).get("session") || "",
  );
  const [title, setTitle] = useState("Untitled workspace");
  const [name, setName] = useState(
    localStorage.getItem("collabcode:name") || "Guest",
  );
  const [peers, setPeers] = useState<Peer[]>([]);
  const [status, setStatus] = useState("offline");
  const [saved, setSaved] = useState("");
  const [error, setError] = useState("");
  const [modal, setModal] = useState<"new" | "join" | "profile" | null>(null);
  const [input, setInput] = useState("");
  const [copied, setCopied] = useState(false);
  const [language, setLanguage] = useState("typescript");
  const [size, setSize] = useState(14);
  const [sidebar, setSidebar] = useState(true);
  const [panel, setPanel] = useState(true);
  const [line, setLine] = useState("Ln 1, Col 1");
  const [chars, setChars] = useState(0);
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const docRef = useRef<Y.Doc | null>(null);
  const langComp = useRef(new Compartment());
  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    let socket: WebSocket;
    let retry: ReturnType<typeof setTimeout>;
    let awareness: Awareness | undefined;
    const doc = new Y.Doc();
    docRef.current = doc;
    const text = doc.getText("code");
    const undo = new Y.UndoManager(text);
    const connect = () => {
      if (cancelled) return;
      setStatus("connecting");
      socket = new WebSocket(
        `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws?session=${encodeURIComponent(session)}&name=${encodeURIComponent(name)}`,
      );
      socket.onmessage = (e) => {
        const m = JSON.parse(e.data);
        if (m.type === "init") {
          Y.applyUpdate(doc, from64(m.data), "remote");
          setStatus("connected");
          if (!awareness) {
            awareness = new Awareness(doc);
            awareness.setLocalStateField("user", {
              name: m.peer.name,
              color: m.peer.color,
              colorLight: m.peer.color + "33",
            });
            awareness.on(
              "update",
              (
                {
                  added,
                  updated,
                  removed,
                }: { added: number[]; updated: number[]; removed: number[] },
                origin: unknown,
              ) => {
                if (origin !== "remote" && socket.readyState === 1)
                  socket.send(
                    JSON.stringify({
                      type: "awareness",
                      data: to64(
                        encodeAwarenessUpdate(awareness!, [
                          ...added,
                          ...updated,
                          ...removed,
                        ]),
                      ),
                    }),
                  );
              },
            );
            view.current = new EditorView({
              parent: host.current!,
              state: EditorState.create({
                doc: text.toString(),
                extensions: [
                  basicSetup,
                  oneDark,
                  langComp.current.of(javascript({ typescript: true })),
                  yCollab(text, awareness, { undoManager: undo }),
                  keymap.of(yUndoManagerKeymap),
                  EditorView.lineWrapping,
                  EditorView.updateListener.of((u) => {
                    if (u.docChanged) setChars(u.state.doc.length);
                    if (u.selectionSet || u.docChanged) {
                      const p = u.state.selection.main.head;
                      const l = u.state.doc.lineAt(p);
                      setLine(`Ln ${l.number}, Col ${p - l.from + 1}`);
                    }
                  }),
                  EditorView.theme({
                    "&": { height: "100%", backgroundColor: "#17191f" },
                    ".cm-scroller": {
                      fontFamily: '"SFMono-Regular", Consolas, monospace',
                      lineHeight: "1.9",
                    },
                    ".cm-gutters": {
                      backgroundColor: "#17191f",
                      border: "none",
                      color: "#626875",
                    },
                    ".cm-activeLineGutter": { backgroundColor: "#20232b" },
                    ".cm-content": { paddingTop: "22px" },
                    ".cm-line": { paddingLeft: "15px" },
                  }),
                ],
              }),
            });
            setChars(text.length);
          }
          socket.send(
            JSON.stringify({
              type: "update",
              data: to64(Y.encodeStateAsUpdate(doc)),
            }),
          );
          socket.send(
            JSON.stringify({
              type: "awareness",
              data: to64(encodeAwarenessUpdate(awareness, [doc.clientID])),
            }),
          );
        } else if (m.type === "update")
          Y.applyUpdate(doc, from64(m.data), "remote");
        else if (m.type === "awareness" && awareness)
          applyAwarenessUpdate(awareness, from64(m.data), "remote");
        else if (m.type === "presence") setPeers(m.peers);
        else if (m.type === "saved")
          setSaved(
            new Date(m.at).toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit",
            }),
          );
        else if (m.type === "error") setError(m.message);
      };
      socket.onclose = (e) => {
        setStatus("offline");
        if (e.code === 1008) {
          setError(
            "This session is unavailable. Create a new session or check your invite link.",
          );
          return;
        }
        if (!cancelled) retry = setTimeout(connect, 1500);
      };
      socket.onerror = () => socket.close();
    };
    doc.on("update", (update: Uint8Array, origin: unknown) => {
      setSaved("");
      if (origin !== "remote" && socket?.readyState === 1)
        socket.send(JSON.stringify({ type: "update", data: to64(update) }));
    });
    fetch(`/api/sessions/${session}`)
      .then(async (r) => {
        if (!r.ok) throw Error("Session not found. Check the invite link.");
        const s = await r.json();
        if (!cancelled) {
          setTitle(s.name);
          connect();
        }
      })
      .catch((e) => setError(e.message));
    return () => {
      cancelled = true;
      clearTimeout(retry);
      awareness?.destroy();
      socket?.close();
      view.current?.destroy();
      view.current = null;
      doc.destroy();
      docRef.current = null;
      setPeers([]);
    };
  }, [session, name]);
  useEffect(() => {
    view.current?.dispatch({
      effects: langComp.current.reconfigure(
        language === "python"
          ? python()
          : javascript({ typescript: language === "typescript" }),
      ),
    });
  }, [language, status]);
  async function create() {
    try {
      setError("");
      const r = await fetch("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: input || "Untitled workspace" }),
      });
      if (!r.ok)
        throw Error(
          "Could not create session. Check that the server is running.",
        );
      const s = await r.json();
      open(s.id);
      setModal(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  function open(id: string) {
    history.pushState({}, "", `?session=${id}`);
    setSession(id);
    setSaved("");
  }
  useEffect(() => {
    const pop = () =>
      setSession(new URLSearchParams(location.search).get("session") || "");
    window.addEventListener("popstate", pop);
    return () => window.removeEventListener("popstate", pop);
  }, []);
  async function copy() {
    try {
      await navigator.clipboard.writeText(location.href);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError("Clipboard unavailable. Copy the URL from your address bar.");
    }
  }
  function download() {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(
      new Blob([docRef.current?.getText("code").toString() || ""], {
        type: "text/plain",
      }),
    );
    a.download = `main.${language === "python" ? "py" : language === "typescript" ? "ts" : "js"}`;
    a.click();
    URL.revokeObjectURL(a.href);
  }
  function submit() {
    if (modal === "new") void create();
    else if (modal === "profile") {
      const n = input.trim().slice(0, 32) || "Guest";
      localStorage.setItem("collabcode:name", n);
      setName(n);
      setModal(null);
    } else {
      const match = input.match(
        /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
      );
      if (match) {
        open(match[0]);
        setModal(null);
      } else setError("Enter a valid session link or ID.");
    }
  }
  return (
    <div className="app">
      <aside className="rail">
        <a className="brand" href="/" aria-label="Collabcode home">
          <Code2 size={25} />
        </a>
        <button
          className="rail-active"
          title="Workspace"
          onClick={() => setSidebar(!sidebar)}
        >
          <FileCode2 />
        </button>
        <button
          title="Collaborators"
          onClick={() => {
            setSidebar(true);
            setPanel(true);
          }}
        >
          <Users />
        </button>
        <div className="rail-bottom">
          <button
            title="Help"
            onClick={() => {
              setPanel(true);
              setError(
                "Share your session link to invite a teammate. Changes sync automatically; use Ctrl/Cmd+Z to undo your edits.",
              );
            }}
          >
            <CircleHelp />
          </button>
          <button
            className="avatar"
            title="Edit your name"
            onClick={() => {
              setInput(name);
              setModal("profile");
            }}
          >
            {name.slice(0, 1).toUpperCase()}
          </button>
        </div>
      </aside>
      <main>
        <header>
          <div className="wordmark">
            collab<span>code</span>
            <span className="badge">WORKSPACE</span>
          </div>
          <div className="header-right">
            <span className="quiet">A shared space to build.</span>
            <button
              className="outline"
              onClick={() => {
                setInput("");
                setModal("new");
              }}
            >
              <Plus size={16} /> New session
            </button>
          </div>
        </header>
        <div className="workspace-top">
          <div>
            <div className="eyebrow">YOUR WORKSPACE</div>
            <h1>{session ? title : "Good code starts together."}</h1>
            <p>
              {session
                ? "Think out loud. Write in sync. Build as a team."
                : "A little less back and forth. A lot more building together."}
            </p>
          </div>
          <button
            className="primary"
            onClick={() => {
              if (session) void copy();
              else {
                setInput("");
                setModal("new");
              }
            }}
          >
            {session ? (
              copied ? (
                <Check size={17} />
              ) : (
                <Link size={17} />
              )
            ) : (
              <Plus size={17} />
            )}{" "}
            {session
              ? copied
                ? "Link copied"
                : "Invite teammate"
              : "Create a session"}
          </button>
        </div>
        <div className="editor-shell">
          <div className="session-bar">
            <div className="session-label">
              <span
                className={`status-dot ${status === "connected" ? "online" : ""}`}
              />
              {session ? "Live session" : "Workspace preview"}
              <span className="session-id">
                {session ? session.slice(0, 8) : "No session yet"}
              </span>
            </div>
            <div className="session-actions">
              <div className="avatar-stack">
                {peers.slice(0, 4).map((p) => (
                  <span
                    key={p.id}
                    title={p.name}
                    style={{ background: p.color, color: "#222" }}
                  >
                    {p.name.slice(0, 1).toUpperCase()}
                  </span>
                ))}
              </div>
              <span className="quiet">{peers.length} online</span>
              <span className="divider" />
              <button
                title="Download code"
                disabled={!session}
                onClick={download}
              >
                <Download size={17} />
              </button>
              <button
                title="Toggle sidebar"
                onClick={() => setSidebar(!sidebar)}
              >
                <PanelLeftClose size={17} />
              </button>
            </div>
          </div>
          <div className="editor-body">
            {sidebar && (
              <aside className="explorer">
                <div className="explorer-heading">
                  EXPLORER{" "}
                  <button
                    title="New session"
                    onClick={() => {
                      setInput("");
                      setModal("new");
                    }}
                  >
                    <Plus size={15} />
                  </button>
                </div>
                <div className="folder">
                  <ChevronRight size={14} className="rotate" />{" "}
                  {session ? "SHARED WORKSPACE" : "GETTING STARTED"}
                </div>
                <div className="file active">
                  <span className="ts-icon">
                    {language === "python"
                      ? "PY"
                      : language === "typescript"
                        ? "TS"
                        : "JS"}
                  </span>
                  main.
                  {language === "python"
                    ? "py"
                    : language === "typescript"
                      ? "ts"
                      : "js"}{" "}
                  <span className="file-dot" />
                </div>
                <div className="explorer-footer">
                  <div className="eyebrow">BETTER, TOGETHER</div>
                  <p>
                    Same file.
                    <br />
                    Same page.
                    <br />
                    <span>Different perspectives.</span>
                  </p>
                  <div className="mini-lines">
                    <i />
                    <i />
                    <i />
                  </div>
                </div>
              </aside>
            )}
            <section className="code-area">
              <div className="tabs">
                <div className="tab">
                  <span className="ts-icon">
                    {language === "python"
                      ? "PY"
                      : language === "typescript"
                        ? "TS"
                        : "JS"}
                  </span>
                  main.
                  {language === "python"
                    ? "py"
                    : language === "typescript"
                      ? "ts"
                      : "js"}
                  <span className="tab-dot" />
                </div>
                <div className="editor-options">
                  <select
                    aria-label="Language"
                    value={language}
                    onChange={(e) => setLanguage(e.target.value)}
                  >
                    <option value="typescript">TypeScript</option>
                    <option value="javascript">JavaScript</option>
                    <option value="python">Python</option>
                  </select>
                  <button
                    title="Change font size"
                    onClick={() => setSize(size === 18 ? 14 : size + 2)}
                  >
                    <Settings2 size={16} />
                  </button>
                </div>
              </div>
              <div
                className="editor-mount"
                ref={host}
                style={{ fontSize: size }}
              />
              {!session && (
                <div className="empty-editor">
                  <div className="empty-icon">
                    <Code2 size={38} />
                  </div>
                  <h2>Your next idea belongs here.</h2>
                  <p>
                    Open a shared workspace and turn
                    <br />
                    “what if” into something real.
                  </p>
                  <button
                    className="primary"
                    onClick={() => {
                      setInput("");
                      setModal("new");
                    }}
                  >
                    <Plus size={17} /> Start building
                  </button>
                  <button
                    className="text-button"
                    onClick={() => {
                      setInput("");
                      setModal("join");
                    }}
                  >
                    Have an invite? Join a session <ArrowUpRight size={14} />
                  </button>
                  <div className="empty-shortcuts">
                    <span>
                      <Users size={15} /> Live collaboration
                    </span>
                    <span>
                      <Check size={15} /> Automatically saved
                    </span>
                  </div>
                </div>
              )}
              {panel && (
                <div className="activity">
                  <div className="activity-heading">
                    <span>
                      <Terminal size={15} /> SESSION ACTIVITY
                    </span>
                    <button
                      title="Close activity"
                      onClick={() => setPanel(false)}
                    >
                      <X size={15} />
                    </button>
                  </div>
                  <p>
                    <span className="activity-time">{saved || "—"}</span>
                    <span className="green">
                      {status === "connected"
                        ? "Connected to workspace"
                        : status === "connecting"
                          ? "Connecting…"
                          : "Ready when you are"}
                    </span>
                  </p>
                  <p>
                    <span className="activity-time">INFO</span>
                    {status === "connected"
                      ? `${peers.length} collaborator${peers.length === 1 ? "" : "s"} in this session. ${saved ? "Changes saved to PostgreSQL." : "Changes sync automatically."}`
                      : "Create a session or join one with an invite link."}
                  </p>
                </div>
              )}
            </section>
          </div>
          <div className="statusbar">
            <div>
              <Wifi size={13} />
              <span>
                {status === "connected"
                  ? "Connected"
                  : status === "connecting"
                    ? "Connecting"
                    : "Offline"}
              </span>
              <span className="status-message">
                {status === "connected"
                  ? saved
                    ? `Saved at ${saved}`
                    : "Syncing changes"
                  : "Your next workspace is one click away"}
              </span>
            </div>
            <div>
              <span>{line}</span>
              <span>{chars} characters</span>
              <span>UTF-8</span>
              <span>
                {language === "typescript"
                  ? "TypeScript"
                  : language === "python"
                    ? "Python"
                    : "JavaScript"}
              </span>
            </div>
          </div>
        </div>
        <footer>
          <span>
            <Command size={14} /> Made for minds that build together.
          </span>
          <button
            className="text-button"
            onClick={() => {
              setInput("");
              setModal("join");
            }}
          >
            Join an existing session <Link size={14} />
          </button>
        </footer>
      </main>
      {error && (
        <div className="toast" role="alert">
          {error}
          <button title="Dismiss" onClick={() => setError("")}>
            <X size={17} />
          </button>
        </div>
      )}
      {modal && (
        <div className="modal-backdrop" onClick={() => setModal(null)}>
          <form
            className="modal"
            onClick={(e) => e.stopPropagation()}
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
          >
            <button
              className="modal-close"
              type="button"
              aria-label="Close"
              onClick={() => setModal(null)}
            >
              <X size={20} />
            </button>
            <div className="empty-icon">
              <Code2 size={28} />
            </div>
            <h2>
              {modal === "new"
                ? "Make room for your next idea."
                : modal === "join"
                  ? "Get on the same page."
                  : "What should we call you?"}
            </h2>
            <p>
              {modal === "new"
                ? "Name your workspace. Share the link. Start building."
                : modal === "join"
                  ? "Paste a session link or ID to collaborate."
                  : "Your teammates will see this name beside your cursor."}
            </p>
            <label>
              {modal === "new"
                ? "Workspace name"
                : modal === "join"
                  ? "Session link or ID"
                  : "Display name"}
              <input
                autoFocus
                maxLength={
                  modal === "join" ? 500 : modal === "profile" ? 32 : 100
                }
                placeholder={
                  modal === "new"
                    ? "e.g. Pair programming / Monday"
                    : modal === "join"
                      ? "Paste invite link…"
                      : "Your name"
                }
                value={input}
                onChange={(e) => setInput(e.target.value)}
              />
            </label>
            <button className="primary" type="submit">
              {modal === "new"
                ? "Create workspace"
                : modal === "join"
                  ? "Join session"
                  : "Save name"}
            </button>
          </form>
        </div>
      )}
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
