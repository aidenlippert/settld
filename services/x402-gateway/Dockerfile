FROM node:20-alpine

WORKDIR /app

# The gateway is intentionally dependency-free. It imports small helper logic from src/core/.
COPY src/core ./src/core
COPY services/x402-gateway ./services/x402-gateway

ENV NODE_ENV=production
EXPOSE 8402

CMD ["node", "services/x402-gateway/src/server.js"]

