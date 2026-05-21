FROM node:26-alpine

LABEL org.opencontainers.image.title="security-scan" \
      org.opencontainers.image.description="CLI tool for automated vulnerability scanning and safe dependency updates" \
      org.opencontainers.image.source="https://github.com/klock-tecnologia/osv-security-cli"

WORKDIR /app

# Install dependencies first (layer cache optimization)
COPY package*.json ./
RUN npm ci

# Copy source and build
COPY . .
RUN npm run build

ENTRYPOINT ["node", "./dist/security-scan.js"]
