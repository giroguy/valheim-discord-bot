FROM node:20-slim

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY src ./src

# Runs as root (no USER directive) so it can talk to the mounted Docker
# socket without host GID juggling. This is the same trust trade-off already
# accepted by giving this container docker.sock access in the first place -
# see the comment on that mount in docker-compose.yml.
CMD ["node", "src/index.js"]
