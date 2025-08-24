# Shika-MD Login (module LimuleBot)

**Shika-MD Login** est un backend WebSocket léger (Express + Node.js) destiné à gérer l'authentification/connexion d'un bot WhatsApp (ex. LimuleBot).  
Il fournit la génération de QR codes, un flux de pairing via un code alphanumérique de 8 caractères, et la gestion de sessions pour l'interface web.

---

## Fonctionnalités principales

- Génération de QR code (data URL PNG) pour login WhatsApp.
- Pairing via un **code alphanumérique de 8 caractères**.
- Gestion de sessions (stockées en mémoire — utile pour les tests).
- Backend WebSocket pour communication avec un frontend (ex. `index.html`).
- Health-check HTTP (`/_health`) pour supervision.
- Conçu pour un déploiement simple sur Render, Docker ou VPS.

---

## Fichiers fournis

- `package.json` — dépendances et scripts (`start`, `start:dev`).
- `server.js` — serveur Express + WebSocket (logique QR / pairing / session).
- `index.html` — frontend (séparé).
- `.gitignore` — fichiers à ignorer.
- `render.yaml` (optionnel) — configuration Render.
- `README.md` — ce document.
- *(optionnel)* `.env.example` — exemple de variables d'environnement.

---

## Installation locale

```bash
git clone <ton-repo>
cd <repo>
npm install
npm start

Puis ouvre : http://localhost:3000

En développement, pour rechargement automatique :

npm run start:dev
# ou si tu veux utiliser nodemon directement
npx nodemon server.js


---

Exemple d’échange WebSocket

Client → Serveur

{ "type": "request", "content": "pairing", "data": { "phoneNumber": "0123456789" } }

Serveur → Client

{ "type": "pairing", "data": "ABCD2345" }        // code pairing (8 caractères)
{ "type": "session", "session": "uuid-v4-string" }

Mobile/Bot → Serveur (pour finaliser le pairing)

{ "type": "complete_pairing", "pairingCode": "ABCD2345" }

Après validation, le serveur notifie le navigateur :

{ "type": "connected", "session": "uuid-v4-string" }


---

Déploiement sur Render

1. Pousse le repo sur GitHub.


2. Crée un service Web sur Render et connecte le repo.


3. Build command : npm install


4. Start command : npm start


5. Render définit automatiquement la variable PORT. Le serveur écoute process.env.PORT.




---

Configuration & bonnes pratiques

Stockage des sessions : le stockage en mémoire est volatile. En production, utiliser Redis ou une base de données (pour persistance et scaling).

.env : il est conseillé d’utiliser un fichier .env pour PORT, REDIS_URL, etc. (ex. via dotenv).

Sécurité : si exposition publique, sécuriser l’accès (HTTPS, reverse-proxy, auth pour endpoints d’administration).

Scaling : pour plusieurs instances, centraliser PAIRINGS/SESSIONS (Redis) pour éviter la désynchronisation.



---

Fichiers / améliorations possibles

Dockerfile — containerisation pour déploiement.

.env.example — variables d’environnement exemplaires.

Endpoint d’admin pour lister sessions / pairings (protégé).

Integration Redis pour sessions/pairings.

Script de simulation simulate_mobile_pairing.js (Node) pour tests locaux.



---

Notes techniques

Pairing : code alphanumérique de 8 caractères (exclut caractères ambigus par défaut).

QR : généré avec la librairie qrcode en data:image/png;base64,....

WebSocket : implémenté avec ws (server) ; le client doit utiliser window.location.host pour inclure le port en dev.

Health-check : GET /_health renvoie ok.



---

Liens utiles

Baileys (WhatsApp)

Render

ws — WebSocket for Node.js



---
