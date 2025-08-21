/**
 * server.js
 * Backend minimal pour gérer les messages WebSocket utilisés par index.html
 *
 * - Sert les fichiers statiques (ton index.html)
 * - Gère WebSocket (qrcode, pairing, validate_session, cancel, etc)
 *
 * NOTE: Ce serveur est volontairement simple (stockage en mémoire).
 * Pour production, stocke sessions/pairings en base (redis, pg, mongo...).
 */

const express = require("express");
const path = require("path");
const http = require("http");
const { WebSocketServer } = require("ws");
const QRCode = require("qrcode");
const { v4: uuidv4 } = require("uuid");

const app = express();
const PORT = process.env.PORT || 3000;

// -- servir fichiers statiques depuis le dossier courant
app.use(express.static(path.join(__dirname)));

// petit endpoint health
app.get("/_health", (req, res) => res.send("ok"));

// créer le server HTTP
const server = http.createServer(app);

// WebSocket server attaché au serveur HTTP (même host/path)
const wss = new WebSocketServer({ server });

// Stockage en mémoire (sessionId -> { ws, createdAt, connected })
const SESSIONS = new Map();
// pairingCode -> { sessionId, phoneNumber, createdAt }
const PAIRINGS = new Map();

// Nettoyage périodique (sessions/pairings > 10 min)
setInterval(() => {
  const now = Date.now();
  for (const [sid, info] of SESSIONS) {
    if (now - info.createdAt > 1000 * 60 * 60) { // 1h
      SESSIONS.delete(sid);
    }
  }
  for (const [code, p] of PAIRINGS) {
    if (now - p.createdAt > 1000 * 60 * 10) {
      PAIRINGS.delete(code);
    }
  }
}, 1000 * 60 * 5);

wss.on("connection", (ws, req) => {
  console.log("New WS connection:", req.socket.remoteAddress);

  // Optionally send a welcome message
  ws.send(JSON.stringify({ type: "info", message: "Server: connected" }));

  ws.on("message", async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (e) {
      ws.send(JSON.stringify({ type: "error", message: "Invalid JSON" }));
      return;
    }

    try {
      // handle types based on your client expectations
      if (msg.type === "request" && msg.content === "qrcode") {
        // create session, generate QR code with session payload
        const sessionId = uuidv4();
        const payload = `shika-session:${sessionId}`;

        // store session
        SESSIONS.set(sessionId, { ws, createdAt: Date.now(), connected: false });

        // generate QR code data URL (PNG)
        const dataUrl = await QRCode.toDataURL(payload);

        // send QR and session id
        ws.send(JSON.stringify({ type: "qrcode", data: dataUrl }));
        ws.send(JSON.stringify({ type: "session", session: sessionId }));

        console.log("Issued QR + session:", sessionId);

      } else if (msg.type === "request" && msg.content === "pairing") {
        // two flows:
        // 1) If this is the pairing flow started from the UI (user clicks Pairing Code button),
        //    we will return a pairing code to display.
        // msg.data may include phoneNumber and customSession
        const phoneNumber = msg.data && msg.data.phoneNumber ? String(msg.data.phoneNumber) : null;
        const customSession = msg.data && msg.data.customSession ? String(msg.data.customSession) : null;

        const sessionId = customSession || uuidv4();
        // ensure session exists
        SESSIONS.set(sessionId, { ws, createdAt: Date.now(), connected: false });

        // generate 6-digit pairing code (human-friendly)
        const pairingCode = Math.floor(100000 + Math.random() * 900000).toString();

        PAIRINGS.set(pairingCode, { sessionId, phoneNumber, createdAt: Date.now() });

        // send pairing code back to client
        ws.send(JSON.stringify({ type: "pairing", data: pairingCode }));
        ws.send(JSON.stringify({ type: "session", session: sessionId }));

        console.log("Issued pairing code", pairingCode, "for session", sessionId, "phone:", phoneNumber);

      } else if (msg.type === "validate_session") {
        // client wants to validate a custom session id
        const sessionId = msg.sessionId ? String(msg.sessionId) : null;
        if (!sessionId) {
          ws.send(JSON.stringify({ type: "session_validation", session: sessionId, valid: false, reason: "Missing sessionId" }));
        } else {
          const exists = SESSIONS.has(sessionId);
          ws.send(JSON.stringify({ type: "session_validation", session: sessionId, valid: exists }));
        }

      } else if (msg.type === "cancel") {
        // cancel current operation for that ws: find any sessions assoc with this ws and remove
        for (const [sid, info] of SESSIONS) {
          if (info.ws === ws) {
            SESSIONS.delete(sid);
            console.log("Cancelled session", sid);
          }
        }
        ws.send(JSON.stringify({ type: "info", message: "Cancelled" }));

      } else if (msg.type === "complete_pairing") {
        // Optional: client can tell server that pairing completed (ex: mobile done)
        // payload: { pairingCode }
        const pairingCode = msg.pairingCode ? String(msg.pairingCode) : null;
        if (pairingCode && PAIRINGS.has(pairingCode)) {
          const p = PAIRINGS.get(pairingCode);
          // mark session connected
          const s = SESSIONS.get(p.sessionId);
          if (s) {
            s.connected = true;
            // notify the ws (owner of session)
            s.ws.send(JSON.stringify({ type: "connected", session: p.sessionId }));
            // optionally remove pairing
            PAIRINGS.delete(pairingCode);
            console.log("Pairing completed for session", p.sessionId);
          }
        } else {
          ws.send(JSON.stringify({ type: "error", message: "Invalid or expired pairing code" }));
        }

      } else {
        // unknown message type
        ws.send(JSON.stringify({ type: "error", message: "Unknown request" }));
      }
    } catch (err) {
      console.error("Processing error:", err);
      ws.send(JSON.stringify({ type: "error", message: "Server error" }));
    }
  });

  ws.on("close", () => {
    // cleanup sessions associated with this ws if any (optional)
    for (const [sid, info] of SESSIONS) {
      if (info.ws === ws) {
        // keep sessions for a grace period, but for simplicity remove
        SESSIONS.delete(sid);
        console.log("Removed session on close:", sid);
      }
    }
  });

  ws.on("error", (err) => {
    console.error("WS error:", err);
  });
});

server.listen(PORT, () => {
  console.log(`HTTP + WS server listening on port ${PORT}`);
});




 