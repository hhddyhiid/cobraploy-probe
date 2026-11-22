'use strict';
/*
 * cobraploy-probe v2 — VLESS over WebSocket (zero dependency) + Komari agent sidecar.
 *
 * Runs on Cobraploy (Brazil, Rio de Janeiro / Nova Net AS61908) free beta.
 * The platform's Traefik ingress + Cloudflare edge terminate TLS and forward
 * plain HTTP/WS to $PORT (3000).
 *
 *   GET  /health        -> 200 "ok"                  (platform health check)
 *   GET  /ip            -> egress IP report (multi-source)
 *   GET  /info          -> process / host info
 *   GET  /status        -> tunnel + komari agent state (diagnostics)
 *   GET  /headers       -> request headers as the container sees them
 *   GET  /limits        -> cgroup v2/v1 CPU & memory caps
 *   WS   /ws            -> 101 + VLESS tunnel        (the proxy)
 *   WS   /echo          -> 101 + text echo           (kept for raw WS diagnosis)
 *   anything else       -> 200 + egress IP text      (keeps the platform healthy)
 *
 * IMPORTANT: the Traefik/CF edge drops a zero-traffic WebSocket at ~59.7 s, so
 * every tunnel gets a server-side WS `ping` frame every 20 s (see KEEPALIVE_MS).
 */
const http = require('http');
const crypto = require('crypto');
const net = require('net');
const dgram = require('dgram');
const os = require('os');
const fs = require('fs');
const cp = require('child_process');

const CR = String.fromCharCode(13);
const LF = String.fromCharCode(10);

const PORT = parseInt(process.env.PORT || '3000', 10);
const WS_PATH = '/ws';
const ECHO_PATH = '/echo';
const UID = '28b45306-3fb5-4fa2-9298-84ae2f532024';
const KEEPALIVE_MS = 20000;          // proven stable: edge kills idle WS at 59.7 s
const KOMARI_DISABLE = process.env.KOMARI_DISABLE === '1';   // local tests only
const BOOT = Date.now();

/* komari monitor (map.amerb.com) — client "🇧🇷 巴西 里約寬頻（Cobraploy）" */
const KOMARI_ENDPOINT = 'https://map.amerb.com';
const KOMARI_TOKEN = 'BI4BRG6lO9l5ZtzVbudc0o';
const KA_BIN = '/tmp/komari-agent';
const KA_VER = '1.6.20';
const KA_URLS = [
  'https://github.com/komari-monitor/komari-agent/releases/download/' + KA_VER + '/komari-agent-linux-amd64',
  'https://ghfast.top/https://github.com/komari-monitor/komari-agent/releases/download/' + KA_VER + '/komari-agent-linux-amd64',
  'https://gh-proxy.com/https://github.com/komari-monitor/komari-agent/releases/download/' + KA_VER + '/komari-agent-linux-amd64',
];

const counters = {
  requests: 0,
  ws_connects: 0,
  ws_pings: 0,
  ws_closes: 0,
  vless_ok: 0,
  vless_bad: 0,
  echo_connects: 0,
};
const recent = [];   // last N tunnel events, for /status

let lastActivity = Date.now();
let egressIp = null;
let ipCache = { t: 0, data: null };

function note(evt) {
  recent.push(new Date().toISOString().slice(11, 19) + ' ' + evt);
  while (recent.length > 30) recent.shift();
  console.log(evt);
}

const UB = (() => {
  const h = UID.replace(/-/g, '');
  const b = Buffer.alloc(16);
  for (let i = 0; i < 16; i++) b[i] = parseInt(h.substr(i * 2, 2), 16);
  return b;
})();

(async () => {
  try {
    const r = await fetch('https://api.ipify.org');
    egressIp = (await r.text()).trim();
    note('EGRESS ' + egressIp);
  } catch (e) {
    note('EGRESS_ERR ' + e.message);
  }
})();

/* ---------------- probe helpers ---------------- */

const SOURCES = [
  ['ipify4', 'https://api.ipify.org?format=json', 'json-ip'],
  ['ipify64', 'https://api64.ipify.org?format=json', 'json-ip'],
  ['ipinfo', 'https://ipinfo.io/json', 'json'],
  ['cloudflare', 'https://www.cloudflare.com/cdn-cgi/trace', 'trace'],
  ['ifconfig.me', 'http://ifconfig.me/ip', 'raw'],
  ['ip-api', 'http://ip-api.com/json/?fields=query,country,regionName,city,isp,org,as,proxy,hosting,mobile', 'json'],
];

async function fetchOne(src) {
  const name = src[0];
  const url = src[1];
  const kind = src[2];
  const t0 = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(function () { ctrl.abort(); }, 8000);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { 'user-agent': 'cobraploy-probe/2.0' } });
    const txt = (await r.text()).slice(0, 6000).trim();
    clearTimeout(timer);
    const out = { source: name, ms: Date.now() - t0 };
    if (kind === 'json-ip') {
      try { out.ip = JSON.parse(txt).ip; } catch (e) { out.raw = txt.slice(0, 200); }
    } else if (kind === 'raw') {
      out.ip = txt.split('\n')[0].slice(0, 80);
    } else if (kind === 'trace') {
      const d = {};
      txt.split('\n').forEach(function (l) {
        const i = l.indexOf('=');
        if (i > 0) d[l.slice(0, i)] = l.slice(i + 1);
      });
      out.ip = d.ip;
      out.colo = d.colo;
      out.loc = d.loc;
      out.warp = d.warp;
    } else {
      try { Object.assign(out, JSON.parse(txt)); } catch (e) { out.raw = txt.slice(0, 200); }
    }
    return out;
  } catch (e) {
    clearTimeout(timer);
    return { source: name, ms: Date.now() - t0, error: String((e && e.message) || e).slice(0, 160) };
  }
}

async function egress(force) {
  if (!force && ipCache.data && Date.now() - ipCache.t < 45000) return ipCache.data;
  const data = await Promise.all(SOURCES.map(fetchOne));
  ipCache = { t: Date.now(), data: data };
  return data;
}

function info() {
  return {
    service: 'cobraploy-probe',
    version: '2.0',
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
    boot_iso: new Date(BOOT).toISOString(),
    now_iso: new Date().toISOString(),
    uptime_s: Math.round((Date.now() - BOOT) / 1000),
    process_uptime_s: Math.round(process.uptime()),
    idle_s: Math.round((Date.now() - lastActivity) / 1000),
    keepalive_ms: KEEPALIVE_MS,
    vless_uuid: UID,
    vless_path: WS_PATH,
    egress_hint: egressIp,
    counters: counters,
  };
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj, null, 2);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

/* ---------------- WebSocket framing (RFC6455, server side) ---------------- */

function frame(payload, op) {
  const n = payload.length;
  const o = op || 2;
  let h;
  if (n < 126) {
    h = Buffer.alloc(2);
    h[0] = 128 | o;
    h[1] = n;
  } else if (n < 65536) {
    h = Buffer.alloc(4);
    h[0] = 128 | o;
    h[1] = 126;
    h.writeUInt16BE(n, 2);
  } else {
    h = Buffer.alloc(10);
    h[0] = 128 | o;
    h[1] = 127;
    h.writeUInt32BE(0, 2);
    h.writeUInt32BE(n, 6);
  }
  return Buffer.concat([h, payload]);
}

/* Read one client (masked) frame out of `b`; returns {opcode,payload,consumed} or null. */
function readFrame(b) {
  if (b.length < 2) return null;
  const opcode = b[0] & 15;
  const masked = (b[1] & 128) !== 0;
  let len = b[1] & 127;
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
  return { opcode: opcode, payload: payload, consumed: off + len };
}

function acceptUpgrade(q, sk) {
  const acc = crypto
    .createHash('sha1')
    .update((q.headers['sec-websocket-key'] || '') + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64');
  sk.write(
    'HTTP/1.1 101 Switching Protocols' + CR + LF +
    'Upgrade: websocket' + CR + LF +
    'Connection: Upgrade' + CR + LF +
    'Sec-WebSocket-Accept: ' + acc + CR + LF + CR + LF
  );
  sk.setNoDelay(true);
  sk.setKeepAlive(true, 30000);
}

/* ---------------- HTTP endpoints ---------------- */

const srv = http.createServer(async function (req, res) {
  counters.requests += 1;
  lastActivity = Date.now();
  const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  const path = url.pathname;

  try {
    if (path === '/health' || path === '/healthz') {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      return res.end('ok');
    }
    if (path === '/version') {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end('cobraploy-probe/2.0');
    }
    if (path === '/info') return sendJson(res, 200, info());
    if (path === '/status') {
      const ka = komari ? komari.state() : { state: 'unavailable' };
      return sendJson(res, 200, { counters: counters, komari: ka, recent: recent });
    }
    if (path === '/ip') {
      const data = await egress(url.searchParams.get('fresh') === '1');
      return sendJson(res, 200, { checked_at: new Date().toISOString(), ip: data, info: info() });
    }
    if (path === '/headers') {
      return sendJson(res, 200, {
        headers: req.headers,
        remote: req.socket.remoteAddress,
        forwarded: req.headers['x-forwarded-for'] || null,
        http_version: req.httpVersion,
        method: req.method,
        url: req.url,
      });
    }
    if (path === '/limits') {
      const read = function (p) {
        try { return fs.readFileSync(p, 'utf8').trim(); } catch (e) { return null; }
      };
      return sendJson(res, 200, {
        cgroup_v2: {
          memory_max: read('/sys/fs/cgroup/memory.max'),
          memory_high: read('/sys/fs/cgroup/memory.high'),
          memory_current: read('/sys/fs/cgroup/memory.current'),
          cpu_max: read('/sys/fs/cgroup/cpu.max'),
          cpu_weight: read('/sys/fs/cgroup/cpu.weight'),
          pids_max: read('/sys/fs/cgroup/pids.max'),
        },
        cgroup_v1: {
          memory_limit: read('/sys/fs/cgroup/memory/memory.limit_in_bytes'),
          cpu_quota: read('/sys/fs/cgroup/cpu/cpu.cfs_quota_us'),
          cpu_period: read('/sys/fs/cgroup/cpu/cpu.cfs_period_us'),
        },
        node_view: { cpus: os.cpus().length, totalmem_mb: Math.round(os.totalmem() / 1048576) },
      });
    }
    if (path === '/' || path === '/index.html') {
      const body = '<!doctype html><meta charset="utf-8"><title>cobraploy-probe</title>\n' +
        '<style>body{font:15px/1.7 system-ui;margin:2rem auto;max-width:44rem;padding:0 1rem}' +
        'code{background:#eef;padding:.1rem .35rem;border-radius:4px}</style>\n' +
        '<h1>cobraploy-probe</h1>\n' +
        '<p>Brazil (Rio de Janeiro) VLESS+WS node + Komari probe on Cobraploy (beta).</p>\n' +
        '<ul>\n' +
        '<li><a href="/health">/health</a> — 200 ok</li>\n' +
        '<li><a href="/ip">/ip</a> — egress IPv4/IPv6 + geo (multi-source)</li>\n' +
        '<li><a href="/info">/info</a> — process / host info</li>\n' +
        '<li><a href="/status">/status</a> — tunnel + agent state</li>\n' +
        '<li><a href="/limits">/limits</a> — cgroup caps</li>\n' +
        '<li><code>/ws</code> — VLESS over WebSocket</li>\n' +
        '</ul>\n' +
        '<p>uptime ' + Math.round((Date.now() - BOOT) / 1000) + 's · node ' + process.version +
        ' · egress ' + (egressIp || '?') + '</p>';
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(body);
    }
  } catch (e) {
    return sendJson(res, 500, { error: String((e && e.message) || e) });
  }
  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
  res.end(egressIp || 'ok');
});

/* ---------------- WebSocket upgrades ---------------- */

srv.on('upgrade', function (q, sk) {
  const path = (q.url || '').split('?')[0];

  /* plain text echo, kept for raw WS / idle-cut diagnosis */
  if (path === ECHO_PATH) {
    acceptUpgrade(q, sk);
    counters.echo_connects += 1;
    const ka = setInterval(function () {
      if (!sk.destroyed) { try { sk.write(frame(Buffer.alloc(0), 9)); counters.ws_pings += 1; } catch (e) {} }
    }, KEEPALIVE_MS);
    let wb = Buffer.alloc(0);
    sk.on('close', function () { clearInterval(ka); });
    sk.on('error', function () { clearInterval(ka); });
    sk.on('data', function (d) {
      wb = Buffer.concat([wb, d]);
      for (;;) {
        const f = readFrame(wb);
        if (!f) return;
        wb = wb.slice(f.consumed);
        if (f.opcode === 8) { try { sk.destroy(); } catch (e) {} return; }
        if (f.opcode === 9) { if (!sk.destroyed) sk.write(frame(f.payload, 10)); continue; }
        if (f.opcode === 10) continue;
        if (!sk.destroyed) {
          const msg = Buffer.from(f.payload);
          sk.write(frame(Buffer.concat([msg, Buffer.from(' @' + (egressIp || '?'))]), f.opcode === 1 ? 1 : 2));
        }
      }
    });
    return;
  }

  if (path !== WS_PATH) {
    try { sk.write('HTTP/1.1 404 Not Found' + CR + LF + 'Content-Length: 0' + CR + LF + 'Connection: close' + CR + LF + CR + LF); } catch (e) {}
    sk.destroy();
    return;
  }

  acceptUpgrade(q, sk);
  counters.ws_connects += 1;
  lastActivity = Date.now();

  let buf = Buffer.alloc(0);    // VLESS payload buffer (pre-handshake / UDP datagrams)
  let wbuf = Buffer.alloc(0);   // raw WS frame buffer
  let tcp = null;
  let udp = null;
  let dst = null;
  let ready = false;
  let closed = false;

  /* the edge kills a silent WS at ~59.7 s -> ping every 20 s */
  const ka = setInterval(function () {
    if (!sk.destroyed) {
      try { sk.write(frame(Buffer.alloc(0), 9)); counters.ws_pings += 1; } catch (e) {}
    }
  }, KEEPALIVE_MS);

  function bye() {
    if (closed) return;
    closed = true;
    clearInterval(ka);
    if (tcp) { try { tcp.destroy(); } catch (e) {} }
    if (udp) { try { udp.close(); } catch (e) {} }
    counters.ws_closes += 1;
  }
  sk.on('close', bye);
  sk.on('error', bye);

  function bad(why) {
    counters.vless_bad += 1;
    note('BADHDR ' + (why || ''));
    bye();
    try { sk.destroy(); } catch (e) {}
  }

  function feed(p) {
    lastActivity = Date.now();
    if (ready) {
      if (tcp) { if (!tcp.destroyed) tcp.write(p); return; }
      buf = Buffer.concat([buf, p]);
      while (buf.length >= 2) {
        const L = buf.readUInt16BE(0);
        if (buf.length < 2 + L) return;
        try { udp.send(buf.slice(2, 2 + L), dst.port, dst.host); } catch (e) {}
        buf = buf.slice(2 + L);
      }
      return;
    }
    buf = Buffer.concat([buf, p]);
    if (buf.length < 18) return;
    if (buf[0] !== 0 || !buf.slice(1, 17).equals(UB)) { bad('uuid'); return; }
    const o0 = 18 + buf[17];                       // version + uuid + optLen + opt
    if (buf.length < o0 + 4) return;
    const cmd = buf[o0];
    const port = buf.readUInt16BE(o0 + 1);
    const at = buf[o0 + 3];                        // address type
    let o1 = o0 + 4;
    let host;
    if (at === 1) {
      if (buf.length < o1 + 4) return;
      host = [buf[o1], buf[o1 + 1], buf[o1 + 2], buf[o1 + 3]].join('.');
      o1 += 4;
    } else if (at === 2) {
      if (buf.length < o1 + 1) return;
      const L = buf[o1];
      if (buf.length < o1 + 1 + L) return;
      host = buf.slice(o1 + 1, o1 + 1 + L).toString();
      o1 += 1 + L;
    } else if (at === 3) {
      if (buf.length < o1 + 16) return;
      const g = [];
      for (let i = 0; i < 8; i++) g.push(buf.readUInt16BE(o1 + i * 2).toString(16));
      host = g.join(':');
      o1 += 16;
    } else { bad('atyp:' + at); return; }

    const rest = buf.slice(o1);
    buf = Buffer.alloc(0);
    ready = true;
    counters.vless_ok += 1;

    if (cmd === 1) {
      note('TCP ' + host + ':' + port);
      tcp = net.connect({ host: host, port: port });
      tcp.on('connect', function () {
        if (!sk.destroyed) sk.write(frame(Buffer.from([0, 0])));
        if (rest.length) tcp.write(rest);
      });
      tcp.on('data', function (d) { if (!sk.destroyed) sk.write(frame(d)); });
      tcp.on('error', function (e) { note('TCPERR ' + host + ' ' + e.message); bye(); try { sk.destroy(); } catch (x) {} });
      tcp.on('close', function () {
        if (!sk.destroyed) {
          try { sk.write(frame(Buffer.alloc(0), 8)); } catch (e) {}
          try { sk.destroy(); } catch (e) {}
        }
        bye();
      });
    } else if (cmd === 2) {
      note('UDP ' + host + ':' + port);
      dst = { host: host, port: port };
      udp = dgram.createSocket(at === 3 ? 'udp6' : 'udp4');
      udp.on('message', function (m) {
        const L = Buffer.alloc(2);
        L.writeUInt16BE(m.length, 0);
        if (!sk.destroyed) sk.write(frame(Buffer.concat([L, m])));
      });
      udp.on('error', function () {});
      if (!sk.destroyed) sk.write(frame(Buffer.from([0, 0])));
      if (rest.length) { buf = rest; feed(Buffer.alloc(0)); }
    } else bad('cmd:' + cmd);
  }

  sk.on('data', function (d) {
    wbuf = Buffer.concat([wbuf, d]);
    for (;;) {
      const f = readFrame(wbuf);
      if (!f) {
        if (wbuf.length > 16 * 1024 * 1024) bad('wsbuf');
        return;
      }
      wbuf = wbuf.slice(f.consumed);
      if (f.opcode === 8) { bye(); try { sk.destroy(); } catch (e) {} return; }
      if (f.opcode === 9) { if (!sk.destroyed) sk.write(frame(f.payload, 10)); continue; }
      if (f.opcode === 10) continue;
      feed(f.payload);
      if (closed) return;
    }
  });
});

/* ---------------- Komari agent (map.amerb.com) ---------------- */

const komari = (function () {
  const st = { state: 'boot', pid: 0, restarts: 0, last: '', log: [] };
  let busy = false;

  function put(s) {
    st.state = s;
    st.last = new Date().toISOString().slice(11, 19) + ' ' + s;
    st.log.push(st.last);
    while (st.log.length > 40) st.log.shift();
    console.log('KA ' + s);
  }

  function run() {
    if (busy) return;
    busy = true;
    let a;
    try {
      a = cp.spawn(KA_BIN, [
        '--endpoint', KOMARI_ENDPOINT,
        '--token', KOMARI_TOKEN,
        '--disable-auto-update',
        '--disable-web-ssh',
        '--prefer-ip-version', '4',
        '-i', '3',
        '--info-report-interval', '5',
      ], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      put('SPAWNERR ' + e.message);
      busy = false;
      return setTimeout(boot, 20000);
    }
    st.pid = a.pid;
    put('SPAWNED pid=' + a.pid);
    a.stdout.on('data', function (d) { put('out ' + String(d).trim().slice(0, 200)); });
    a.stderr.on('data', function (d) { put('err ' + String(d).trim().slice(0, 200)); });
    a.on('error', function (e) {
      put('SPAWNERR ' + e.message);
      try { fs.unlinkSync(KA_BIN); } catch (x) {}
      st.pid = 0;
      busy = false;
      setTimeout(boot, 20000);
    });
    a.on('exit', function (c, s) {
      st.pid = 0;
      st.restarts += 1;
      put('EXIT ' + c + ' ' + s);
      busy = false;
      setTimeout(boot, 15000);
    });
  }

  async function boot() {
    try {
      if (fs.existsSync(KA_BIN) && fs.statSync(KA_BIN).size > 1000000) { run(); return; }
      put('DL start ' + KA_VER);
      let lastErr = '';
      for (const url of KA_URLS) {
        try {
          const r = await fetch(url, { redirect: 'follow', headers: { 'user-agent': 'curl/8.5.0' } });
          if (!r.ok) throw new Error('http ' + r.status);
          const b = Buffer.from(await r.arrayBuffer());
          if (b.length < 1000000) throw new Error('short ' + b.length);
          if (b.slice(0, 4).toString('hex') !== '7f454c46') throw new Error('not ELF');
          fs.writeFileSync(KA_BIN, b);
          fs.chmodSync(KA_BIN, 493);
          put('DL ok ' + b.length + 'B');
          run();
          return;
        } catch (e) {
          lastErr = e.message;
          put('DL fail ' + e.message);
        }
      }
      put('DL all failed: ' + lastErr);
      setTimeout(boot, 60000);
    } catch (e) {
      put('BOOTERR ' + e.message);
      setTimeout(boot, 60000);
    }
  }

  return {
    start: function () { setTimeout(boot, 2000); },
    state: function () {
      return { state: st.state, pid: st.pid, restarts: st.restarts, last: st.last, log: st.log.slice(-12) };
    },
  };
})();

srv.listen(PORT, '0.0.0.0', function () {
  note('LISTEN ' + PORT + ' pid ' + process.pid + ' node ' + process.version + ' vless_uid ' + UID);
  if (KOMARI_DISABLE) note('KOMARI disabled by env');
  else komari.start();
});

process.on('SIGTERM', function () {
  note('SIGTERM');
  srv.close(function () { process.exit(0); });
  setTimeout(function () { process.exit(0); }, 3000);
});
