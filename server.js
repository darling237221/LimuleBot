/**
 * server.js
 * Express + WebSocket + Baileys (persistence sessions ./sessions/<sessionId>)
 *
 * Usage:
 *  - npm install @whiskeysockets/baileys ws qrcode express uuid
 *  - node server.js
 *
 * Notes:
 *  - Pour authentifier un compte WhatsApp : scanner le QR envoyé au frontend
 *    (ou affiché dans la console si printQRInTerminal: true).
 *  - Les dossiers de session (./sessions/<uuid>) contiennent les credentials
 *    et sont automatiquement réactivés au démarrage.
 */

const fs = require("fs");
const express = require("express");
const path = require("path");
const http = require("http");
const wsLib = require("ws");
const { WebSocketServer } = wsLib;
const WebSocket = wsLib.WebSocket || wsLib;
const QRCode = require("qrcode");
const { v4: uuidv4 } = require("uuid");
const crypto = require("crypto");

// Baileys
const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
} = require("@whiskeysockets/baileys");

const SESSIONS_DIR = path.join(__dirname, "sessions");

// ensure sessions directory exists
if (!fs.existsSync(SESSIONS_DIR)) {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
}

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname)));
app.get("/_health", (req, res) => res.send("ok"));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// In-memory bookkeeping
// SESSIONS: sessionId -> { wsFrontend (may be null), createdAt, connected (bool), sock (Baileys socket) }
const SESSIONS = new Map();
// PAIRINGS: kept only if you want to use internal pairing codes (not used for Baileys QR)
const PAIRINGS = new Map();

// Cleanup expired items periodically
setInterval(() => {
  const now = Date.now();
  for (const [sid, info] of SESSIONS) {
    if (!info || !info.createdAt || now - info.createdAt > 1000 * 60 * 60) {
      // keep auth files on disk for persistence, but remove in-memory mapping
      console.log("Cleaning up in-memory session:", sid);
      // if sock exists, try to close
      if (info.sock && info.sock.end) {
        try { info.sock.end(); } catch (e) { /* ignore */ }
      }
      SESSIONS.delete(sid);
    }
  }
  for (const [code, p] of PAIRINGS) {
    if (!p || !p.createdAt || now - p.createdAt > 1000 * 60 * 10) {
      PAIRINGS.delete(code);
    }
  }
}, 1000 * 60 * 5);

// Helper: generate an internal pairing code (optional)
function generatePairingCode(length = 8) {
  const CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < length; i++) {
    code += CHARS[crypto.randomInt(0, CHARS.length)];
  }
  return code;
}

// Helper: safe send to frontend WS
function safeSend(socket, payload) {
  try {
    if (!socket) return false;
    if (socket.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify(payload));
    return true;
  } catch (e) {
    console.error("safeSend error:", e);
    return false;
  }
}

/**
 * Start or restore a Baileys socket for a given sessionId.
 * - sessionId: string (folder under ./sessions/<sessionId>)
 * - wsFrontend: WebSocket to notify frontend (may be null)
 * Returns: sock (Baileys socket)
 */
async function startBaileys(sessionId, wsFrontend = null) {
  const sessionFolder = path.join(SESSIONS_DIR, sessionId);
  // ensure folder exists
  if (!fs.existsSync(sessionFolder)) fs.mkdirSync(sessionFolder, { recursive: true });

  let state;
  let saveCreds;
  try {
    const res = await useMultiFileAuthState(sessionFolder);
    state = res.state;
    saveCreds = res.saveCreds;
  } catch (err) {
    console.error("useMultiFileAuthState error:", err);
    throw err;
  }

  // fetch latest baileys version (protocol)
  let version = undefined;
  try {
    const ver = await fetchLatestBaileysVersion();
    version = ver.version;
    console.log("Using Baileys version:", version.join("."));
  } catch (err) {
    console.warn("Could not fetch latest Baileys version, continuing with default:", err?.message || err);
  }

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false, // we will send QR to frontend instead of terminal by default
    browser: ["Ubuntu", "chrome", "20.0.04"],
    // optionally set short-lived key rotation / logger etc.
  });

  // listen for credentials updates and persist them
  sock.ev.on("creds.update", saveCreds);

  // handle connection updates and QR events
  sock.ev.on("connection.update", async (update) => {
    try {
      // update example: { connection: 'open' } or { qr: '...' }
      // console.log("connection.update", update);
      const { qr, connection, lastDisconnect } = update;

      if (qr) {
        // generate data URL and send to frontend if available
        try {
          const dataUrl = await QRCode.toDataURL(qr);
          if (wsFrontend) {
            safeSend(wsFrontend, { type: "qrcode", data: dataUrl });
          }
          // also log to console (base64)
          console.log(`QR for session ${sessionId} (sent to frontend).`);
        } catch (e) {
          console.error("QR generation failed:", e);
        }
      }

      if (connection === "open") {
        console.log("Baileys connection open for session:", sessionId);
        const s = SESSIONS.get(sessionId) || {};
        s.connected = true;
        s.sock = sock;
        s.createdAt = s.createdAt || Date.now();
        SESSIONS.set(sessionId, s);
        // notify frontend
        if (wsFrontend) safeSend(wsFrontend, { type: "connected", session: sessionId });
      } else if (connection === "close") {
        console.warn("Baileys connection closed for session:", sessionId, "lastDisconnect:", lastDisconnect?.error || lastDisconnect);
        const s = SESSIONS.get(sessionId) || {};
        s.connected = false;
        s.sock = sock;
        SESSIONS.set(sessionId, s);
        // optionally notify frontend
        if (wsFrontend) safeSend(wsFrontend, { type: "disconnected", session: sessionId, reason: String(lastDisconnect || "") });
      }
    } catch (err) {
      console.error("Error in connection.update handler:", err);
    }
  });

  // store in memory
  SESSIONS.set(sessionId, { ws: wsFrontend, createdAt: Date.now(), connected: false, sock });

  return sock;
}

// On startup: restore existing sessions found in ./sessions
(async () => {
  try {
    const items = fs.readdirSync(SESSIONS_DIR, { withFileTypes: true });
    for (const it of items) {
      if (it.isDirectory()) {
        const sessionId = it.name;
        try {
          console.log("Restoring session from disk:", sessionId);
          // start Baileys for this session without frontend attached
          await startBaileys(sessionId, null);
        } catch (err) {
          console.error("Failed to restore session", sessionId, err);
        }
      }
    }
  } catch (err) {
    console.error("Error scanning sessions folder:", err);
  }
})();

// WebSocket server: handle frontend clients
wss.on("connection", (ws, req) => {
  console.log("New WS connection from:", req?.socket?.remoteAddress || "unknown");
  safeSend(ws, { type: "info", message: "Server: connected" });

  ws.on("message", async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (err) {
      console.error("Invalid JSON from frontend:", err);
      return safeSend(ws, { type: "error", message: "Invalid JSON" });
    }

    try {
      // request: generate QR (start new session and start baileys)
      if (msg.type === "request" && msg.content === "qrcode") {
        // create a deterministic session id or random
        const sessionId = uuidv4();
        console.log("Frontend requested QR session:", sessionId);
        SESSIONS.set(sessionId, { ws, createdAt: Date.now(), connected: false, sock: null });
        // start baileys which will emit QR to ws when ready
        await startBaileys(sessionId, ws);
        // send session id to frontend
        safeSend(ws, { type: "session", session: sessionId });
      }

      // request: pairing (legacy internal pairing code generation) - optional
      else if (msg.type === "request" && msg.content === "pairing") {
        // create session and generate internal code for display/testing only
        const sessionId = uuidv4();
        const phoneNumber = msg?.data?.phoneNumber ? String(msg.data.phoneNumber) : null;
        SESSIONS.set(sessionId, { ws, createdAt: Date.now(), connected: false, sock: null });

        // create internal pairing code (NOT WhatsApp official code)
        const pairingCode = generatePairingCode(8);
        PAIRINGS.set(pairingCode, { sessionId, phoneNumber, createdAt: Date.now() });

        // start Baileys normally (QR flow). NOTE: the 'pairingCode' here is only for your UI/testing.
        await startBaileys(sessionId, ws);

        // send both: internal pairing code (for display) and session
        safeSend(ws, { type: "pairing", data: pairingCode });
        safeSend(ws, { type: "session", session: sessionId });

        console.log("Issued internal pairing code", pairingCode, "for session", sessionId, "phone:", phoneNumber);
      }

      // validate session (frontend custom session)
      else if (msg.type === "validate_session") {
        const sessionId = msg.sessionId ? String(msg.sessionId) : null;
        if (!sessionId) {
          safeSend(ws, { type: "session_validation", session: sessionId, valid: false, reason: "Missing sessionId" });
        } else {
          const exists = SESSIONS.has(sessionId);
          safeSend(ws, { type: "session_validation", session: sessionId, valid: exists });
        }
      }

      // cancel / reset
      else if (msg.type === "cancel") {
        // remove any in-memory session entries associated with this ws (but keep disk files)
        for (const [sid, info] of SESSIONS) {
          if (info && info.ws === ws) {
            // optionally close Baileys socket
            try { if (info.sock && info.sock.end) info.sock.end(); } catch (e) {}
            info.ws = null;
            SESSIONS.delete(sid);
            console.log("Cancelled in-memory session", sid);
          }
        }
        safeSend(ws, { type: "info", message: "Cancelled" });
      }

      // optionally allow frontend to tell server to complete internal pairing code (NOT WhatsApp): marks session connected locally
      else if (msg.type === "complete_pairing") {
        const rawCode = msg.pairingCode ? String(msg.pairingCode) : null;
        if (!rawCode) return safeSend(ws, { type: "error", message: "Missing pairingCode" });
        const code = String(rawCode).toUpperCase().replace(/[^A-Z0-9]/g, "");
        if (!PAIRINGS.has(code)) return safeSend(ws, { type: "error", message: "Invalid or expired pairing code" });

        const p = PAIRINGS.get(code);
        const s = SESSIONS.get(p.sessionId);
        if (s) {
          s.connected = true;
          SESSIONS.set(p.sessionId, s);
          // notify front (owner)
          if (s.ws) safeSend(s.ws, { type: "connected", session: p.sessionId, note: "completed-via-internal-pairing" });
          PAIRINGS.delete(code);
          return safeSend(ws, { type: "info", message: "Pairing completed (internal)" });
        } else {
          PAIRINGS.delete(code);
          return safeSend(ws, { type: "error", message: "Session not found for pairing (maybe expired)" });
        }
      }

      // unknown
      else {
        safeSend(ws, { type: "error", message: "Unknown request" });
      }
    } catch (err) {
      console.error("Processing error for message:", msg, err);
      safeSend(ws, { type: "error", message: "Server error" });
    }
  });

  ws.on("close", () => {
    // detach ws from any session that referenced it
    for (const [sid, info] of SESSIONS) {
      if (info && info.ws === ws) {
        info.ws = null;
        SESSIONS.set(sid, info);
        console.log("Detached frontend ws from session:", sid);
      }
    }
  });
});

// Optional debug endpoints
app.get("/sessions", (req, res) => {
  const out = {};
  for (const [sid, info] of SESSIONS) {
    out[sid] = { createdAt: info.createdAt, connected: !!info.connected, hasSock: !!info.sock };
  }
  res.json(out);
});

app.get("/pairings", (req, res) => {
  const out = {};
  for (const [code, p] of PAIRINGS) {
    out[code] = { sessionId: p.sessionId, phoneNumber: p.phoneNumber, ageMs: Date.now() - p.createdAt };
  }
  res.json(out);
});

server.listen(PORT, () => {
  console.log(`HTTP + WS server listening on port ${PORT}`);
  console.log(`Sessions folder: ${SESSIONS_DIR}`);
});