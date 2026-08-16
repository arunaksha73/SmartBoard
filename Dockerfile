# ==============================================================================
# SmartBoard Remote — Production Dockerfile for Render & Containerized Deployments
# ==============================================================================
# Base image: Official Node.js 20 LTS (Debian Bookworm Slim)
FROM node:20-bookworm-slim

# Prevent interactive prompts during apt installation
ENV DEBIAN_FRONTEND=noninteractive \
    NODE_ENV=production \
    PORT=3000

# Install LibreOffice, required rendering fonts, and core dependencies
# - libreoffice / libreoffice-writer / libreoffice-impress: document-to-pdf conversion
# - fonts-liberation / fonts-dejavu-core / fonts-freefont-ttf: clean typography in converted decks
# - ca-certificates: secure HTTPS and certificate handling
RUN apt-get update && apt-get install -y --no-install-recommends \
    libreoffice \
    libreoffice-writer \
    libreoffice-impress \
    fonts-liberation \
    fonts-dejavu-core \
    fonts-freefont-ttf \
    ca-certificates \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/*

# Create and set application directory
WORKDIR /app

# Copy package manifests first for optimal Docker layer caching
COPY package*.json ./

# Install only production dependencies
RUN npm ci --omit=dev --ignore-scripts

# Copy application source code and static assets
COPY . .

# Ensure upload directory and temporary conversion workspace exist
RUN mkdir -p uploads/_convert_tmp public

# Expose default port (Render will automatically override PORT via environment variable)
EXPOSE 3000

# Health check to ensure the service is running and responsive
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "const http = require('http'); const req = http.get('http://127.0.0.1:' + (process.env.PORT || 3000) + '/health', (res) => { process.exit(res.statusCode === 200 ? 0 : 1); }); req.on('error', () => process.exit(1));"

# Launch the SmartBoard server
CMD ["npm", "start"]
