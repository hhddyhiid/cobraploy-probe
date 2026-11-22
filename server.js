'use strict';
/*
 * cobraploy-probe — zero-dependency outbound-IP + WebSocket echo probe.
 *
 *   GET /health   -> 200 "ok" (platform healthcheck)
 *   GET /ip       -> egress IPv4/IPv6 from several independent sources
 *   GET /info     -> process / host info (uptime, pid, cpu, mem, env hints)
 *   GET /headers  -> request headers as the container sees them
 *   WS  /ws       -> RFC6455 echo (sends a hello frame with the egress IP)
 *
 * Optional env:
 *   WS_KEEPALIVE_MS  server-side ping interval (default 0 = off)
 *                    set it if the platform's edge kills silent sockets.
 */
const http = require('http');
const crypto = require('crypto');
const os = require('os');

const PORT = parseInt(process.env.PORT || '3000', 10);
const KEEPALIVE_MS = parseInt(process.env.WS_KEEPALIVE_MS || '0', 10);
const STARTED = Date.now();
let lastActivity = Date.now();
const counters = { requests: 0, ws_open: 0, ws_closed: 0, ws_msgs: 0, pings: 0 };

function json(res, code, obj) {
  const body = JSON.stringify(obj, null, 2);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

async function get(url, timeoutMs = 6000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  const t0 = Date.now();
  try {
    const r = await fetch(url, {
      signal: ctl.signal,
      headers: { 'user-agent': 'cobraploy-probe/1.0' },
    });
    let text = (await r.text()).slice(0, 4000).trim();
    if (url.includes('cdn-cgi/trace')) text = text.split('\n').filter((l) => /^(ip|loc|colo|warp)=/.test(l)).join(' ');
    return { url, status: r.status, ms: Date.now() - t0, body: text };
  } catch (e) {
    return { url, error: String((e && e.message) || e).slice(0, 200), ms: Date.now() - t0 };
  } finally {
    clearTimeout(t);
  }
}

let ipCache = { t: 0, data: null };
async function egress(force) {
  if (!force && ipCache.data && Date.now() - ipCache.t < 30000) return ipCache.data;
  const urls = [
    'https://api.ipify.org?format=json',
    'https://api64.ipify.org?format=json',
    'https://ipinfo.io/json',
    'https://ip-api.com/json/?fields=status,country,countryCode,regionName,city,isp,org,as,asname,proxy,hosting,mobile,query',
    'https://1.1.1.1/cdn-cgi/trace',
    'https://ifconfig.me/ip',
  ];
  const probes = {};
  const out = await Promise.all(urls.map((u) => get(u)));
  urls.forEach((u, i) => {
    const key = u.replace(/^https?:\/\//, '').split(/[/?]/)[0].replace(/\./g, '_');
    probes[key] = out[i];
  });
  const data = { checked_at: new Date().toISOString(), probes };
  ipCache = { t: Date.now(), data };
  return data;
}

function info() {
  return {
    service: 'cobraploy-probe',
    version: '1.0',
    pid: process.pid,
    node: process.version,
    port: PORT,
    hostname: os.hostname(),
    platform: os.platform(),
    arch: os.arch(),
    cpus: os.cpus().length,
    cpu_model: (os.cpus()[0] || {}).model || null,
    totalmem_mb: Math.round(os.totalmem() / 1048576),
    freemem_mb: Math.round(os.freemem() / 1048576),
    loadavg: os.loadavg(),
    rss_mb: Math.round((process.memoryUsage().rss / 1048576) * 10) / 10,
    boot_iso: new Date(STARTED).toISOString(),
    now_iso: new Date().toISOString(),
    process_uptime_s: Math.round(process.uptime()),
    idle_s: Math.round((Date.now() - lastActivity) / 1000),
    keepalive_ms: KEEPALIVE_MS,
    counters,
    env_hints: Object.keys(process.env)
      .filter((k) => /^(PORT|NODE|HOST|REGION|RAILWAY|RENDER|FLY|K_|DYNO|APP|KUBER|COBRA|TZ|LANG)/i.test(k))
      .sort()
      .map((k) => k + '=' + String(process.env[k]).slice(0, 80)),
  };
}

const server = http.createServer(async (req, res) => {
  counters.requests += 1;
  lastActivity = Date.now();
  const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  try {
    if (url.pathname === '/health' || url.pathname === '/healthz') {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      return res.end('ok');
    }
    if (url.pathname === '/ip') {
      return json(res, 200, { ...(await egress(url.searchParams.get('fresh') === '1')), info: info() });
    }
    if (url.pathname === '/info') return json(res, 200, info());
    if (url.pathname === '/headers') {
      return json(res, 200, {
        headers: req.headers,
        remote: req.socket.remoteAddress,
        remote_port: req.socket.remotePort,
        http_version: req.httpVersion,
        method: req.method,
        url: req.url,
      });
    }
    if (url.pathname === '/' || url.pathname === '/index.html') {
      const b = `<!doctype html><meta charset="utf-8"><title>cobraploy-probe</title>
<style>body{font:15px/1.7 system-ui;margin:2rem auto;max-width:44rem;padding:0 1rem}code{background:#eef;padding:.1rem .35rem;border-radius:4px}</style>
<h1>cobraploy-probe</h1>
<p>Outbound-IP + WebSocket echo probe running on Cobraploy (beta).</p>
<ul>
<li><a href="/health">/health</a> — 200 ok</li>
<li><a href="/ip">/ip</a> — egress IPv4/IPv6 + geo (multi-source)</li>
<li><a href="/info">/info</a> — process / host info</li>
<li><a href="/headers">/headers</a> — what the container sees</li>
<li><code>/ws</code> — WebSocket echo (<code>wss://&lt;domain&gt;/ws</code>)</li>
</ul>
<p>uptime ${Math.round((Date.now() - STARTED) / 1000)}s · node ${process.version} · pid ${process.pid}</p>`;
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(b);
    }
  } catch (e) {
    return json(res, 500, { error: String((e && e.message) || e) });
  }
  json(res, 404, { error: 'not_found', paths: ['/health', '/ip', '/info', '/headers', '/ws'] });
});

/* ---------- WebSocket (RFC6455) echo ---------- */
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function encode(opcode, payload) {
  const len = payload.length;
  let head;
  if (len < 126) {
    head = Buffer.from([0x80 | opcode, len]);
  } else if (len < 65536) {
    head = Buffer.alloc(4);
    head[0] = 0x80 | opcode;
    head[1] = 126;
    head.writeUInt16BE(len, 2);
  } else {
    head = Buffer.alloc(10);
    head[0] = 0x80 | opcode;
    head[1] = 127;
    head.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([head, payload]);
}

function decode(b) {
  if (b.length < 2) return null;
  const fin = (b[0] & 0x80) !== 0;
  const opcode = b[0] & 0x0f;
  const masked = (b[1] & 0x80) !== 0;
  let len = b[1] & 0x7f;
  let off = 2;
  if (len === 126) {
    if (b.length < 4) return null;
    len = b.readUInt16BE(2);
    off = 4;
  } else if (len === 127) {
    if (b.length < 10) return null;
    len = Number(b.readBigUInt64BE(2));
    off = 10;
  }
  if (len > 8 * 1024 * 1024) return null;
  let mask = null;
  if (masked) {
    if (b.length < off + 4) return null;
    mask = b.slice(off, off + 4);
    off += 4;
  }
  if (b.length < off + len) return null;
  const payload = Buffer.from(b.slice(off, off + len));
  if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
  return { fin, opcode, payload, consumed: off + len };
}

server.on('upgrade', async (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if ((req.url || '').split('?')[0] !== '/ws' || !key) {
    try {
      socket.write('HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
    } catch (_) {}
    return socket.destroy();
  }
  const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      'Sec-WebSocket-Accept: ' + accept + '\r\n' +
      'X-Probe: cobraploy/1.0\r\n\r\n'
  );
  socket.setNoDelay(true);
  counters.ws_open += 1;
  lastActivity = Date.now();

  // hello frame: egress summary so a WS-only client can read it too
  egress(false)
    .then((e) => {
      const ipify = (e.probes['api_ipify_org'] || {}).body || '';
      let ip = null;
      try { ip = JSON.parse(ipify).ip; } catch (_) {}
      const hello = {
        type: 'hello',
        service: 'cobraploy-probe',
        echo_ip: ip,
        pid: process.pid,
        uptime_s: Math.round(process.uptime()),
        now: new Date().toISOString(),
      };
      if (!socket.destroyed) socket.write(encode(0x1, Buffer.from(JSON.stringify(hello))));
    })
    .catch(() => {});

  let buf = Buffer.alloc(0);
  const finalize = () => {
    counters.ws_closed += 1;
    try { socket.destroy(); } catch (_) {}
  };
  socket.on('error', finalize);
  socket.on('close', finalize);

  let ka = null;
  if (KEEPALIVE_MS > 0) {
    ka = setInterval(() => {
      if (!socket.destroyed) {
        try { socket.write(encode(0x9, Buffer.alloc(0))); counters.pings += 1; } catch (_) {}
      }
    }, KEEPALIVE_MS);
    socket.on('close', () => clearInterval(ka));
    socket.on('error', () => clearInterval(ka));
  }

  let closed = false;
  socket.on('data', (chunk) => {
    lastActivity = Date.now();
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      const f = decode(buf);
      if (!f) break;
      buf = buf.slice(f.consumed);
      if (f.opcode === 0x8) {
        closed = true;
        try { socket.write(encode(0x8, Buffer.alloc(0))); } catch (_) {}
        if (ka) clearInterval(ka);
        socket.end();
        return;
      }
      if (f.opcode === 0x9) {
        try { socket.write(encode(0xA, f.payload)); } catch (_) {}
        continue;
      }
      if (f.opcode === 0xA) continue;
      counters.ws_msgs += 1;
      // echo text/binary back with a marker so the client can verify round-trip
      const p = Buffer.from(f.payload);
      const isText = f.opcode === 0x1;
      try {
        socket.write(encode(isText ? 0x1 : 0x2, p));
      } catch (_) {}
    }
  });
  socket.on('close', () => { if (ka) clearInterval(ka); });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('cobraploy-probe listening on 0.0.0.0:' + PORT + ' pid ' + process.pid + ' node ' + process.version);
});
process.on('SIGTERM', () => {
  console.log('SIGTERM received');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000);
});
