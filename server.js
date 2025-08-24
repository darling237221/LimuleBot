/**
 * server.js (corrigé : pairing 8 caractères)
 * Backend Express + WebSocket minimal pour index.html
 *
 * Note : stockage en mémoire (OK pour tests). En production => Redis/DB.
 */

const express = require("express");
const path = require("path");
const http = require("http");
const { WebSocketServer, WebSocket } = require("ws");
const QRCode = require("qrcode");
const { v4: uuidv4 } = require("uuid");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;

// servir fichiers statiques depuis le dossier courant
app.use(express.static(path.join(__dirname)));

// health check
app.get("/_health", (req, res) => res.send("ok"));

// créer le server HTTP
const server = http.createServer(app);

// WebSocket server attaché au serveur HTTP (même host/path)
const wss = new WebSocketServer({ server });

// Stockage en mémoire (sessionId -> { ws, createdAt, connected })
const SESSIONS = new Map();
// pairingCode -> { sessionId, phoneNumber, createdAt }
const PAIRINGS = new Map();

// Nettoyage périodique (sessions > 1h, pairings > 10min)
setInterval(() => {
  const now = Date.now();
  for (const [sid, info] of SESSIONS) {
    if (now - info.createdAt > 1000 * 60 * 60) { // 1h
      SESSIONS.delete(sid);
    }
  }
  for (const [code, p] of PAIRINGS) {
    if (now - p.createdAt > 1000 * 60 * 10) { // 10min
      PAIRINGS.delete(code);
    }
  }
}, 1000 * 60 * 5);

// Helper : génère un code alphanumérique sécurisé de longueur n
function generatePairingCode(length = 8) {
  // alphabet sans caractères ambigus (optionnel)
  const CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // évite 0,O,1,I
  let code = "";
  for (let i = 0; i < length; i++) {
    // crypto.randomInt fournit un entier sûr dans [0, CHARS.length)
    const idx = crypto.randomInt(0, CHARS.length);
    code += CHARS[idx];
  }
  return code;
}

// safe send (vérifie readyState)
function safeSend(socket, payload) {
  try {
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify(payload));
  } catch (e) {
    console.error("safeSend error:", e);
  }
}

wss.on("connection", (ws, req) => {
  console.log("New WS connection from:", req?.socket?.remoteAddress || "unknown");

  // welcome
  safeSend(ws, { type: "info", message: "Server: connected" });

  ws.on("message", async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (e) {
      return safeSend(ws, { type: "error", message: "Invalid JSON" });
    }

    try {
      if (msg.type === "request" && msg.content === "qrcode") {
        // create session, generate QR code with session payload
        const sessionId = uuidv4();
        const payload = `shika-session:${sessionId}`;

        // store session
        SESSIONS.set(sessionId, { ws, createdAt: Date.now(), connected: false });

        // generate QR code data URL (PNG)
        const dataUrl = await QRCode.toDataURL(payload);

        // send QR and session id
        safeSend(ws, { type: "qrcode", data: dataUrl });
        safeSend(ws, { type: "session", session: sessionId });

        console.log("Issued QR + session:", sessionId);

      } else if (msg.type === "request" && msg.content === "pairing") {
        // msg.data may include phoneNumber and customSession
        const phoneNumber = msg.data && msg.data.phoneNumber ? String(msg.data.phoneNumber) : null;
        const customSession = msg.data && msg.data.customSession ? String(msg.data.customSession) : null;

        const sessionId = customSession || uuidv4();
        // ensure session exists
        SESSIONS.set(sessionId, { ws, createdAt: Date.now(), connected: false });

        // generate unique 8-character pairing code (retry up to N times)
        let pairingCode;
        for (let attempt = 0; attempt < 10; attempt++) {
          pairingCode = generatePairingCode(8);
          if (!PAIRINGS.has(pairingCode)) break;
          pairingCode = null;
        }
        if (!pairingCode) {
          return safeSend(ws, { type: "error", message: "Unable to create unique pairing code, try again" });
        }

        PAIRINGS.set(pairingCode, { sessionId, phoneNumber, createdAt: Date.now() });

        safeSend(ws, { type: "pairing", data: pairingCode });
        safeSend(ws, { type: "session", session: sessionId });

        console.log("Issued pairing code", pairingCode, "for session", sessionId, "phone:", phoneNumber);

      } else if (msg.type === "validate_session") {
        const sessionId = msg.sessionId ? String(msg.sessionId) : null;
        if (!sessionId) {
          safeSend(ws, { type: "session_validation", session: sessionId, valid: false, reason: "Missing sessionId" });
        } else {
          const exists = SESSIONS.has(sessionId);
          safeSend(ws, { type: "session_validation", session: sessionId, valid: exists });
        }

      } else if (msg.type === "cancel") {
        // cancel all sessions owned by this ws
        for (const [sid, info] of SESSIONS) {
          if (info.ws === ws) {
            SESSIONS.delete(sid);
            console.log("Cancelled session", sid);
          }
        }
        safeSend(ws, { type: "info", message: "Cancelled" });

      } else if (msg.type === "complete_pairing") {
        const pairingCode = msg.pairingCode ? String(msg.pairingCode).toUpperCase() : null;
        if (pairingCode && PAIRINGS.has(pairingCode)) {
          const p = PAIRINGS.get(pairingCode);
          const s = SESSIONS.get(p.sessionId);
          if (s) {
            s.connected = true;
            if (s.ws && s.ws.readyState === WebSocket.OPEN) {
              safeSend(s.ws, { type: "connected", session: p.sessionId });
            }
            PAIRINGS.delete(pairingCode);
            console.log("Pairing completed for session", p.sessionId);
            safeSend(ws, { type: "info", message: `Pairing completed for session ${p.sessionId}` });
          } else {
            safeSend(ws, { type: "error", message: "Session not found for this pairing" });
          }
        } else {
          safeSend(ws, { type: "error", message: "Invalid or expired pairing code" });
        }

      } else {
        safeSend(ws, { type: "error", message: "Unknown request" });
      }
    } catch (err) {
      console.error("Processing error:", err);
      safeSend(ws, { type: "error", message: "Server error" });
    }
  });

  ws.on("close", () => {
    // cleanup sessions associated with this ws
    for (const [sid, info] of SESSIONS) {
      if (info.ws === ws) {
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