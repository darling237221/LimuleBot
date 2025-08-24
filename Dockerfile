# ----------------------------
# Shika-MD Login - Dockerfile
# ----------------------------

# Étape 1 : Utiliser une image Node.js légère
FROM node:18-alpine

# Étape 2 : Définir le répertoire de travail
WORKDIR /app

# Étape 3 : Copier package.json et installer les dépendances
COPY package*.json ./
RUN npm install --only=production

# Étape 4 : Copier le reste du projet
COPY . .

# Étape 5 : Exposer le port (Render utilise la variable PORT)
EXPOSE 3000

# Étape 6 : Démarrer le serveur
CMD ["npm", "start"]