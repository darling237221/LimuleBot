/**
 * server.js (final - pairing 8 caractères, robustifié)
 *
 * Backend Express + WebSocket minimal pour index.html
 * Stockage en mémoire (OK pour tests). En production => Redis/DB.
 */

const express = require("express");
const path = require("path");
const http = require("http");
const wsLib = require("ws"); // import compatible avec différentes versions
const { WebSocketServer } = wsLib;
const WebSocket = wsLib.WebSocket || wsLib; // fallback safe
const QRCode = require("qrcode");
const { v4: uuidv4 } = require("uuid");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;

// servir fichiers statiques depuis le dossier courant (index.html doit être à la racine)
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
    // defensive: info.createdAt may be undefined in worst case
    if (!info || !info.createdAt) {
      SESSIONS.delete(sid);
      continue;
    }
    if (now - info.createdAt > 1000 * 60 * 60) { // 1h
      SESSIONS.delete(sid);
    }
  }

  for (const [code, p] of PAIRINGS) {
    if (!p || !p.createdAt) {
      PAIRINGS.delete(code);
      continue;
    }
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
      msg = JSON.parse(raw?.toString?.() || raw);
    } catch (e) {
      return safeSend(ws, { type: "error", message: "Invalid JSON" });
    }

    try {
      // --- QR code request ---
      if (msg.type === "request" && msg.content === "qrcode") {
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

      // --- Pairing request ---
      } else if (msg.type === "request" && msg.content === "pairing") {
        const phoneNumber = msg?.data?.phoneNumber ? String(msg.data.phoneNumber) : null;
        const customSession = msg?.data?.customSession ? String(msg.data.customSession) : null;

        const sessionId = customSession || uuidv4();
        // ensure session exists (associate this ws)
        SESSIONS.set(sessionId, { ws, createdAt: Date.now(), connected: false });

        // generate unique 8-character pairing code (retry up to N times)
        let pairingCode = null;
        for (let attempt = 0; attempt < 10; attempt++) {
          const candidate = generatePairingCode(8);
          if (!PAIRINGS.has(candidate)) {
            pairingCode = candidate;
            break;
          }
        }
        if (!pairingCode) {
          return safeSend(ws, { type: "error", message: "Unable to create unique pairing code, try again" });
        }

        PAIRINGS.set(pairingCode, { sessionId, phoneNumber, createdAt: Date.now() });

        safeSend(ws, { type: "pairing", data: pairingCode });
        safeSend(ws, { type: "session", session: sessionId });

        console.log("Issued pairing code", pairingCode, "for session", sessionId, "phone:", phoneNumber);

      // --- Validate session ---
      } else if (msg.type === "validate_session") {
        const sessionId = msg.sessionId ? String(msg.sessionId) : null;
        if (!sessionId) {
          safeSend(ws, { type: "session_validation", session: sessionId, valid: false, reason: "Missing sessionId" });
        } else {
          const exists = SESSIONS.has(sessionId);
          safeSend(ws, { type: "session_validation", session: sessionId, valid: exists });
        }

      // --- Cancel ---
      } else if (msg.type === "cancel") {
        // cancel all sessions owned by this ws
        for (const [sid, info] of SESSIONS) {
          if (info && info.ws === ws) {
            SESSIONS.delete(sid);
            console.log("Cancelled session", sid);
          }
        }
        safeSend(ws, { type: "info", message: "Cancelled" });

      // --- Complete pairing (from mobile/bot) ---
      } else if (msg.type === "complete_pairing") {
        const pairingCode = msg.pairingCode ? String(msg.pairingCode).toUpperCase() : null;
        if (!pairingCode) {
          return safeSend(ws, { type: "error", message: "Missing pairingCode" });
        }
        if (!PAIRINGS.has(pairingCode)) {
          return safeSend(ws, { type: "error", message: "Invalid or expired pairing code" });
        }

        const p = PAIRINGS.get(pairingCode);
        if (!p || !p.sessionId) {
          PAIRINGS.delete(pairingCode);
          return safeSend(ws, { type: "error", message: "Invalid pairing record" });
        }

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
          // session not present (maybe expired) — inform caller
          PAIRINGS.delete(pairingCode);
          safeSend(ws, { type: "error", message: "Session not found for this pairing (maybe expired)" });
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
      if (info && info.ws === ws) {
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