FROM node:20-bookworm-slim AS frontend-builder
WORKDIR /work/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

FROM rust:1.93-bookworm AS backend-builder
WORKDIR /work
RUN apt-get update \
    && apt-get install -y --no-install-recommends pkg-config build-essential ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY backend/Cargo.toml backend/Cargo.lock backend/
COPY backend/src backend/src
RUN cargo build --release --locked --manifest-path backend/Cargo.toml

FROM debian:bookworm-slim AS runtime
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates wget \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --create-home --home-dir /app littlegate
WORKDIR /app
COPY --from=backend-builder /work/backend/target/release/backend /app/backend
COPY --from=frontend-builder /work/frontend/dist /app/static
RUN mkdir -p /app/data \
    && chown -R littlegate:littlegate /app
USER littlegate
ENV LISTEN_ADDR=0.0.0.0:8080 \
    STATIC_DIR=/app/static \
    DB_DSN=sqlite:///app/data/little_gate.sqlite \
    RUST_LOG=info
VOLUME ["/app/data"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/healthz >/dev/null || exit 1
CMD ["/app/backend"]
