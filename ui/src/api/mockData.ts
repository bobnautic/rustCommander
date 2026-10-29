// Content for the mock backend's fake file systems.

export const now = Math.floor(Date.now() / 1000);

let seed = 0x2f6e2b1;
/** Deterministic PRNG so the demo looks the same on every load. */
export function rand(): number {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

export const TEXT = {
  bashrc: `# ~/.bashrc: executed by bash(1) for non-login shells.
case $- in
    *i*) ;;
      *) return;;
esac

HISTCONTROL=ignoreboth
HISTSIZE=10000
shopt -s histappend checkwinsize

alias ll='ls -alF'
alias la='ls -A'
alias gs='git status'

export EDITOR=vim
export PATH="$HOME/.cargo/bin:$HOME/.local/bin:$PATH"
PS1='\\[\\e[32m\\]\\u@\\h\\[\\e[0m\\]:\\[\\e[34m\\]\\w\\[\\e[0m\\]\\$ '
`,
  profile: `# ~/.profile
if [ -n "$BASH_VERSION" ] && [ -f "$HOME/.bashrc" ]; then
    . "$HOME/.bashrc"
fi
`,
  sshConfig: `Host web-01
    HostName web-01.example.com
    User deploy
    IdentityFile ~/.ssh/id_ed25519

Host db-01
    HostName db-01.example.com
    User admin
    ProxyJump web-01

Host pi
    HostName pi.local
    User pi

Host build-box
    HostName 10.0.4.17
    Port 2222
    User ci
    ProxyJump web-01

Host router
    HostName router.lan
    User root

Host *.internal
    User admin
`,
  pubKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGq9xI0dT2bQvO2c8mXkq8gJkF1s3hYV7c9Rz1yq3Jd demo@demo-workstation\n',
  privKey: `-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW
QyNTUxOQAAACBqvcSNHU9m0LztnPJl5KvICZBdbN4WFe3PUc9cqtyXSQAAAJiQ0h4MkNIe
(demo key - not a real secret)
-----END OPENSSH PRIVATE KEY-----
`,
  knownHosts: `db-01.example.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIM4nqQ7ds0ZgB5g6YgD2bJ8l4m0x0Kc1d1yVb9Xx3f1e
github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl
`,
  todo: `TODO
- [x] Renew TLS certificate for web-01
- [ ] Migrate backups to the new S3 bucket
- [ ] Update nginx to 1.27
- [ ] Clean up /var/log/old
`,
  notesMd: `# Meeting notes

## 2026-10-27 – Release planning

* Ship **Rust Commander 1.0** after the WebDAV fixes land
* LAN discovery: keep UDP port \`8823\` as default
* Web UI: password protected, TLS by default

| Owner | Task |
|-------|------|
| Anna  | S3 multipart uploads |
| Ben   | Keyboard shortcuts review |
`,
  notesTxt: `Server inventory
================

web-01   192.168.1.20   nginx, php-fpm
db-01    192.168.1.21   postgres 16
pi       192.168.1.50   home automation
nas-01   192.168.1.10   backups (rcmd web UI on :8822)
`,
  indexHtml: (title: string, extra = '') => `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
  <link rel="stylesheet" href="css/style.css">
</head>
<body>
  <header class="site-header">
    <img src="img/logo.svg" alt="Logo" width="48" height="48">
    <nav>
      <a href="index.html">Home</a>
      <a href="about.html">About</a>
      <a href="contact.html">Contact</a>
    </nav>
  </header>
  <main>
    <h1>${title}</h1>
    <p>Welcome! This page is deployed with Rust Commander.</p>${extra}
  </main>
  <script src="js/app.js" defer></script>
</body>
</html>
`,
  css: (accent: string) => `:root {
  --accent: ${accent};
  --text: #1f2933;
  --bg: #ffffff;
}

* { box-sizing: border-box; }

body {
  margin: 0;
  font: 16px/1.5 system-ui, sans-serif;
  color: var(--text);
  background: var(--bg);
}

.site-header {
  display: flex;
  align-items: center;
  gap: 24px;
  padding: 12px 24px;
  border-bottom: 1px solid #e5e7eb;
}

.site-header nav a {
  color: var(--accent);
  text-decoration: none;
  margin-right: 16px;
}

main { max-width: 760px; margin: 40px auto; padding: 0 24px; }
`,
  appJs: `// Small enhancements for the static site
document.addEventListener('DOMContentLoaded', () => {
  const links = document.querySelectorAll('nav a');
  for (const link of links) {
    if (link.getAttribute('href') === location.pathname.split('/').pop()) {
      link.classList.add('active');
    }
  }
  console.log('site ready');
});
`,
  readmeSite: `# Company website

Static site deployed to \`web-01:/var/www/html\`.

## Deploy

\`\`\`sh
./deploy.sh production
\`\`\`
`,
  deploySh: `#!/usr/bin/env bash
set -euo pipefail
TARGET=\${1:-staging}
echo "Deploying to $TARGET"
rsync -av --delete ./ "deploy@web-01:/var/www/html/"
`,
  packageJson: `{
  "name": "company-website",
  "version": "2.4.1",
  "private": true,
  "scripts": {
    "build": "eleventy",
    "serve": "eleventy --serve"
  },
  "devDependencies": {
    "@11ty/eleventy": "^3.0.0"
  }
}
`,
  gitignore: 'node_modules/\n_site/\n.DS_Store\n*.log\n',
  cargoToml: `[package]
name = "rust-commander"
version = "0.9.0"
edition = "2021"

[dependencies]
tokio = { version = "1", features = ["full"] }
serde = { version = "1", features = ["derive"] }
`,
  mainRs: `use std::path::PathBuf;

/// Entry point of the command line tool.
fn main() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let dir = args.get(1).map(PathBuf::from).unwrap_or_else(|| PathBuf::from("."));
    for entry in std::fs::read_dir(&dir)? {
        let entry = entry?;
        println!("{}", entry.file_name().to_string_lossy());
    }
    Ok(())
}
`,
  libRs: `//! Core library.

pub mod vfs;
pub mod transfer;

pub fn version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}
`,
  nginxConf: `user www-data;
worker_processes auto;
pid /run/nginx.pid;

events {
    worker_connections 1024;
}

http {
    sendfile on;
    tcp_nopush on;
    types_hash_max_size 2048;
    include /etc/nginx/mime.types;
    default_type application/octet-stream;

    ssl_protocols TLSv1.2 TLSv1.3;
    access_log /var/log/nginx/access.log;
    error_log /var/log/nginx/error.log;

    gzip on;
    include /etc/nginx/conf.d/*.conf;
    include /etc/nginx/sites-enabled/*;
}
`,
  siteDefault: `server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name example.com www.example.com;
    root /var/www/html;
    index index.html;

    location / {
        try_files $uri $uri/ =404;
    }
}
`,
  hosts: (h: string) => `127.0.0.1\tlocalhost
127.0.1.1\t${h}

# The following lines are desirable for IPv6 capable hosts
::1     ip6-localhost ip6-loopback
`,
  compose: `services:
  app:
    image: ghcr.io/example/app:2.4.1
    restart: unless-stopped
    ports:
      - "8080:8080"
    environment:
      DATABASE_URL: postgres://app@db-01/app
  redis:
    image: redis:7
`,
  robots: 'User-agent: *\nDisallow: /admin/\n',
  deployLog: Array.from({ length: 40 }, (_, i) => `2026-10-${String(1 + (i % 28)).padStart(2, '0')} 0${i % 10}:1${i % 6}:0${i % 9} deploy[${1200 + i}]: release ${i % 3 === 0 ? 'started' : 'finished'} (rev ${(0xa1b2c3 + i * 977).toString(16)})`).join('\n') + '\n',
  accessLog: (() => {
    const paths = ['/', '/index.html', '/about.html', '/css/style.css', '/js/app.js', '/img/logo.svg', '/robots.txt', '/contact.html', '/wp-login.php'];
    const codes = [200, 200, 200, 304, 200, 404, 200, 301];
    const out: string[] = [];
    for (let i = 0; i < 400; i++) {
      const p = paths[i % paths.length];
      const c = p === '/wp-login.php' ? 404 : codes[i % codes.length];
      out.push(`192.168.1.${10 + (i % 90)} - - [28/Oct/2026:${String(8 + (i % 12)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}:${String((i * 7) % 60).padStart(2, '0')} +0000] "GET ${p} HTTP/1.1" ${c} ${200 + ((i * 131) % 9000)} "-" "Mozilla/5.0"`);
    }
    return out.join('\n') + '\n';
  })(),
  errorLog: `2026/10/28 03:12:44 [error] 1234#1234: *88 open() "/var/www/html/wp-login.php" failed (2: No such file or directory)
2026/10/28 09:40:02 [warn] 1234#1234: *140 an upstream response is buffered to a temporary file
`,
  sshdConfig: `# Restricted file - only root can read this
PermitRootLogin no
PasswordAuthentication no
`,
};

export function logoSvg(color: string, label: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256"><rect width="256" height="256" rx="48" fill="${color}"/><circle cx="128" cy="104" r="48" fill="#fff" opacity=".9"/><text x="128" y="206" font-family="system-ui,sans-serif" font-size="34" font-weight="700" fill="#fff" text-anchor="middle">${label}</text></svg>`;
}

export function photoSvg(seedNum: number, label: string): string {
  const hues = [210, 25, 160, 280, 340, 45, 190];
  const h = hues[seedNum % hues.length];
  return `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="640" viewBox="0 0 960 640"><defs><linearGradient id="s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="hsl(${h},70%,62%)"/><stop offset="1" stop-color="hsl(${(h + 40) % 360},80%,85%)"/></linearGradient></defs><rect width="960" height="640" fill="url(#s)"/><circle cx="${700 - (seedNum % 5) * 60}" cy="170" r="70" fill="hsl(45,100%,85%)" opacity=".9"/><path d="M0 470 L200 300 L360 430 L520 250 L760 460 L960 330 L960 640 L0 640 Z" fill="hsl(${(h + 180) % 360},30%,30%)" opacity=".85"/><path d="M0 540 L260 420 L480 520 L700 400 L960 520 L960 640 L0 640 Z" fill="hsl(${(h + 160) % 360},35%,22%)"/><text x="32" y="608" font-family="system-ui,sans-serif" font-size="28" fill="#fff" opacity=".85">${label}</text></svg>`;
}
