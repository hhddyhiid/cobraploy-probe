#!/usr/bin/env python3
"""Local VLESS-over-WS client test against cobraploy-probe (no xray needed).

Usage: python3 vless_ws_local.py [host] [port] [tls:0|1]
Builds a VLESS request: ver 0 | uuid | optLen 0 | cmd 1 (tcp) | port | atyp 1 | 1.1.1.1
then sends an HTTP GET and prints the server reply header + first bytes of body.
"""
import base64
import hashlib
import os
import socket
import ssl
import struct
import sys
import uuid as uuidlib

host = sys.argv[1] if len(sys.argv) > 1 else "127.0.0.1"
port = int(sys.argv[2]) if len(sys.argv) > 2 else 3000
use_tls = (sys.argv[3] if len(sys.argv) > 3 else "0") == "1"
UID = sys.argv[4] if len(sys.argv) > 4 else "28b45306-3fb5-4fa2-9298-84ae2f532024"
path = sys.argv[5] if len(sys.argv) > 5 else "/ws"

s = socket.create_connection((host, port), timeout=25)
if use_tls:
    ctx = ssl.create_default_context()
    s = ctx.wrap_socket(s, server_hostname=host)
s.settimeout(25)

key = base64.b64encode(os.urandom(16)).decode()
req = ("GET %s HTTP/1.1\r\nHost: %s\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
       "Sec-WebSocket-Key: %s\r\nSec-WebSocket-Version: 13\r\nUser-Agent: vless-local/1.0\r\n\r\n"
       % (path, host, key))
s.sendall(req.encode())

buf = b""
while b"\r\n\r\n" not in buf:
    c = s.recv(4096)
    if not c:
        raise SystemExit("closed during handshake")
    buf += c
head, _, rest = buf.partition(b"\r\n\r\n")
line = head.decode("latin1").splitlines()[0]
print("handshake:", line)
assert " 101 " in line, "not 101"


def send_bin(data):
    mask = os.urandom(4)
    n = len(data)
    out = bytes([0x82])
    if n < 126:
        out += bytes([0x80 | n])
    elif n < 65536:
        out += bytes([0x80 | 126]) + struct.pack("!H", n)
    else:
        out += bytes([0x80 | 127]) + struct.pack("!Q", n)
    out += mask + bytes(b ^ mask[i % 4] for i, b in enumerate(data))
    s.sendall(out)


def recv_frames(seconds=12, stop_after_data=True):
    frames = []
    s.settimeout(seconds)
    pending = b""
    data = b""
    try:
        while True:
            chunk = s.recv(65536)
            if not chunk:
                frames.append(("EOF", 0))
                break
            pending += chunk
            while True:
                if len(pending) < 2:
                    break
                op = pending[0] & 15
                n = pending[1] & 127
                off = 2
                if n == 126:
                    if len(pending) < 4:
                        break
                    n = struct.unpack("!H", pending[2:4])[0]
                    off = 4
                elif n == 127:
                    if len(pending) < 10:
                        break
                    n = struct.unpack("!Q", pending[2:10])[0]
                    off = 10
                if len(pending) < off + n:
                    break
                payload = pending[off:off + n]
                pending = pending[off + n:]
                frames.append((op, len(payload)))
                if op == 2:
                    data += payload
            if stop_after_data and len(data) > 2:
                break
    except socket.timeout:
        frames.append(("TIMEOUT", 0))
    return frames, data


vless_hdr = b"\x00" + uuidlib.UUID(UID).bytes + b"\x00" + b"\x01" + struct.pack("!H", 80) + b"\x01" + bytes([1, 1, 1, 1])
get = b"GET / HTTP/1.1\r\nHost: one.one.one.one\r\nUser-Agent: vless-local/1.0\r\nConnection: close\r\n\r\n"
send_bin(vless_hdr + get)

frames, data = recv_frames()
print("frames:", frames[:8])
if data:
    print("vless response header:", data[:2].hex())
    print("http head:", data[2:120].split(b"\r\n")[0])
    print("bytes:", len(data))
else:
    print("NO DATA")
