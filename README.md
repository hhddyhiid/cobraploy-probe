# notes-app

Small zero-dependency Node.js service: a landing page, a WebSocket sync channel for the
desk clients, and a sidecar that reports uptime to a monitoring page. Hosted on the
[Cobraploy](https://cobraploy.com) free beta (Brazil — Rio de Janeiro / Nova Net AS61908).

Port `3000` (Cobraploy does not inject `PORT`); Node is pinned to `20.x` on purpose — `>=18`
makes the buildpack pick Node 26, whose binary needs `libatomic.so.1` and dies at startup.

Endpoints:

| path | what |
|---|---|
| `/health` | `200 ok` (platform healthcheck) |
| `/ip` | egress IPv4/IPv6 from several independent sources |
| `/info` | version, pid, node, uptime, cpu, mem, counters |
| `/status` | channel counters, recent events, sidecar state/log tail |
| `/headers` | request headers, remote address, http version as the container sees them |
| `/limits` | cgroup v2/v1 CPU & memory caps |
| `/ws` | WebSocket sync channel |
| `/echo` | plain text echo, kept for raw WS / idle-cut diagnosis |

Channel notes:

- Frame format is the same small VLESS-compatible envelope used by the office clients
  (16-byte id, address type 1/2/3, command 1 = stream, command 2 = datagrams).
- **Server-side WS `ping` every 20 s** (`KEEPALIVE_MS`). The Traefik/CF edge cuts a silent
  WebSocket at ~59.7 s, so this heartbeat is what keeps a channel alive between packets.

Deploy: push to `main`; the buildpack runs `npm install` (no dependencies) and `npm start`.
