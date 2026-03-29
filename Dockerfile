# =========================
#   BUILD NODE MODULES
# =========================
FROM node:20-alpine AS builder

WORKDIR /build
COPY package*.json ./
RUN npm install --omit=dev


# =========================
#   RUNTIME WITH FREECAD
# =========================
FROM alpine:edge

# Add community repository for FreeCAD
RUN echo "https://dl-cdn.alpinelinux.org/alpine/edge/community" >> /etc/apk/repositories

# Install FreeCAD and runtime dependencies
RUN apk update && apk add --no-cache \
    freecad \
    nodejs \
    curl \
    ca-certificates

# FreeCAD environment vars
ENV QT_QPA_PLATFORM=offscreen
ENV FREECAD_USER_HOME=/tmp
ENV XDG_RUNTIME_DIR=/tmp/runtime

WORKDIR /app

# --- Copy node_modules from builder ---
COPY --from=builder /build/node_modules ./node_modules

# --- Copy backend ---
COPY src ./src
COPY package.json .

# --- Copy frontend ---
COPY public ./public
COPY logo.png .
COPY README.md .

# --- Prepare folders ---
RUN mkdir -p uploads converted logs /tmp/runtime \
    && chmod 777 uploads converted logs \
    && chmod 700 /tmp/runtime

EXPOSE 3000 3001

CMD ["node", "src/server.js"]
