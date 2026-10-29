# Headless Rust Commander: web UI + API for the container's (or a mounted) file system.
#   docker build -t rust-commander .
#   docker run -d -p 8822:8822 -p 47800:47800/udp -v /srv:/data \
#     -e RCMD_PASSWORD=change-me --name rcmd rust-commander
# LAN discovery (UDP broadcast) needs --network host to see other instances.

FROM node:22-bookworm AS ui
WORKDIR /src/ui
COPY ui/package.json ui/package-lock.json ./
RUN npm ci
COPY ui/ ./
RUN npm run build

FROM rust:1-bookworm AS build
WORKDIR /src
COPY . .
COPY --from=ui /src/ui/dist ui/dist
RUN cargo build --release -p rc-cli

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates openssh-client \
    && rm -rf /var/lib/apt/lists/* && mkdir -p /data /config
COPY --from=build /src/target/release/rcmd /usr/local/bin/rcmd
ENV RCMD_CONFIG_DIR=/config HOME=/data
VOLUME ["/config", "/data"]
EXPOSE 8822 47800/udp
WORKDIR /data
ENTRYPOINT ["rcmd", "serve"]
CMD ["--port", "8822"]
