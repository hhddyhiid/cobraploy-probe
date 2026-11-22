# cobraploy-probe

Zero-dependency Node.js **VLESS over WebSocket** node plus a **Komari agent sidecar**, running on
[Cobraploy](https://cobraploy.com) (Brazil — Rio de Janeiro / Nova Net AS61908) free beta.
Port `3000` (Cobraploy does not inject `PORT`); Node pinned to `20.x` on purpose — `>=18`
makes the buildpack pick Node 26, whose binary needs `libatomic.so.1` and dies at startup.

Endpoints:

| path | what |
|---|---|
| `/health` | `200 ok` (platform healthcheck) |
| `/ip` | egress IPv4/IPv6 from 6 independent sources + ipinfo / ip-api / Cloudflare trace |
| `/info` | version, pid, node, uptime, cpu, mem, counters |
| `/status` | tunnel counters, recent tunnel events, Komari agent state/log tail |
| `/headers` | request headers, remote address, http version as the container sees them |
| `/limits` | cgroup v2/v1 CPU & memory caps |
| `/ws` | **VLESS over WebSocket** (UUID + path below) |
| `/echo` | plain text echo, kept for raw WS / idle-cut diagnosis |

Tunnel parameters:

- UUID `28b45306-3fb5-4fa2-9298-84ae2f532024`, WS path `/ws`, TLS terminated by Traefik/Cloudflare.
- **Server-side WS `ping` every 20 s** (`KEEPALIVE_MS`). The Traefik/CF edge cuts a silent
  WebSocket at ~59.7 s, so this heartbeat is what keeps a tunnel alive between packets.

Komari monitor:

- `https://map.amerb.com`, client `🇧🇷 巴西 里約寬頻（Cobraploy）`.
- The agent binary (`1.6.20`, linux/amd64) is fetched on boot from GitHub with
  `ghfast.top` / `gh-proxy.com` fallbacks, cached in `/tmp/komari-agent`, supervised with
  restart on exit.

Env switches: `PORT` (default 3000), `KOMARI_DISABLE=1` (local tests only, no agent).

Local checks (no xray needed):

```bash
PORT=3011 KOMARI_DISABLE=1 node server.js
curl -s localhost:3011/health           # ok
python3 vless_ws_local.py 127.0.0.1 3011 0   # 101 -> VLESS [0,0] -> HTTP head from 1.1.1.1
```
