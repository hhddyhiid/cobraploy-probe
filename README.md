# cobraploy-probe

Zero-dependency Node.js probe used to verify the real outbound IP / ASN and WebSocket
support of a [Cobraploy](https://cobraploy.com) (Brazil, São Paulo) free-beta service.

Endpoints:

| path | what |
|---|---|
| `/health` | `200 ok` (platform healthcheck) |
| `/ip` | egress IPv4/IPv6 from 6 independent sources + ipinfo / ip-api / Cloudflare trace + process info |
| `/info` | pid, node version, uptime, cpu, mem, env hints |
| `/headers` | request headers, remote address, http version as the container sees them |
| `/ws` | RFC6455 WebSocket echo (hello frame carries the egress IP) |

Optional env: `WS_KEEPALIVE_MS` — server-side WS ping interval; leave `0` (off) unless the
platform's edge closes idle sockets.

Listen port: `process.env.PORT`.
