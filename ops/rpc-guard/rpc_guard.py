#!/usr/bin/env python3
"""VYD RPC 가드 — 공개 RPC(vyd.mustree.kr)에서 서명·관리 메서드를 막는다.

Geth는 블록 서명(Clique) 때문에 서명자 계정을 --unlock 해 둔다. 이 상태로 RPC를 그대로 공개하면
누구나 eth_sendTransaction 으로 그 계정 명의의 트랜잭션을 보낼 수 있다. 이 가드는 nginx 와 Geth 사이에서
JSON-RPC 요청을 보고 위험한 메서드만 거절하고 나머지는 그대로 전달한다.

  nginx (443) → rpc_guard (127.0.0.1:8747) → geth (127.0.0.1:8745)

표준 라이브러리만 사용 (Python 3.7+). 환경변수:
  UPSTREAM  기본 http://127.0.0.1:8745   (VYD geth HTTP)
  HOST      기본 127.0.0.1
  PORT      기본 8747
"""
import json
import os
import sys
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

UPSTREAM = os.environ.get("UPSTREAM", "http://127.0.0.1:8745")
HOST = os.environ.get("HOST", "127.0.0.1")
PORT = int(os.environ.get("PORT", "8747"))
MAX_BODY = 2 * 1024 * 1024

# 노드에 잠금 해제된 계정으로 서명하게 만드는 메서드와 관리용 네임스페이스
BLOCKED = {
    "eth_sendTransaction", "eth_sign", "eth_signTransaction",
    "eth_signTypedData", "eth_signTypedData_v3", "eth_signTypedData_v4",
}
BLOCKED_PREFIX = ("personal_", "admin_", "debug_", "miner_", "clique_propose", "clique_discard")
# 지갑(MetaMask)은 브라우저에서 직접 서명한 뒤 eth_sendRawTransaction 으로 보내므로 영향 없음


def is_blocked(method):
    return method in BLOCKED or any(method.startswith(p) for p in BLOCKED_PREFIX)


def err(req_id, code, msg):
    return {"jsonrpc": "2.0", "id": req_id, "error": {"code": code, "message": msg}}


def forward(payload):
    data = json.dumps(payload).encode()
    req = urllib.request.Request(UPSTREAM, data=data, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read())


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "vyd-rpc-guard"

    def log_message(self, fmt, *args):  # 거절한 요청만 남긴다 (handle 안에서 직접 출력)
        pass

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", self.headers.get("Origin") or "*")
        self.send_header("Vary", "Origin")
        self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Max-Age", "600")

    def _send(self, status, obj):
        body = json.dumps(obj).encode()
        self.send_response(status)
        self._cors()
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        self._send(200, {"ok": True, "service": "vyd-rpc-guard"})

    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        if n <= 0 or n > MAX_BODY:
            return self._send(413 if n > MAX_BODY else 400, err(None, -32600, "invalid request size"))
        try:
            payload = json.loads(self.rfile.read(n))
        except ValueError:
            return self._send(200, err(None, -32700, "parse error"))

        batch = isinstance(payload, list)
        reqs = payload if batch else [payload]
        out, allowed = {}, []
        for i, r in enumerate(reqs):
            if not isinstance(r, dict) or not isinstance(r.get("method"), str):
                out[i] = err(None, -32600, "invalid request")
                continue
            m = r["method"]
            if is_blocked(m):
                out[i] = err(r.get("id"), -32601, f"method {m} is not allowed on the public RPC")
                print(f"blocked {m} from {self.headers.get('X-Forwarded-For') or self.client_address[0]}", flush=True)
            elif m == "eth_accounts":
                out[i] = {"jsonrpc": "2.0", "id": r.get("id"), "result": []}  # 노드 계정 숨김
            else:
                allowed.append((i, r))

        if allowed:
            try:
                res = forward([r for _, r in allowed])
                if not isinstance(res, list):
                    res = [res]
                by_id = {}
                for x in res:
                    by_id.setdefault(json.dumps(x.get("id")), []).append(x)
                for i, r in allowed:
                    lst = by_id.get(json.dumps(r.get("id")))
                    out[i] = lst.pop(0) if lst else err(r.get("id"), -32603, "no response from node")
            except (urllib.error.URLError, OSError, ValueError) as e:
                for i, r in allowed:
                    out[i] = err(r.get("id"), -32603, f"node unavailable: {e}")
                if not batch:
                    return self._send(502, out[0])

        result = [out[i] for i in range(len(reqs))]
        # 알림(id 없는 요청)은 응답에서 뺀다 (JSON-RPC 2.0)
        result = [x for x, r in zip(result, reqs) if not (isinstance(r, dict) and "id" not in r)]
        if batch:
            return self._send(200, result)
        return self._send(200, result[0] if result else {})


if __name__ == "__main__":
    srv = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"vyd-rpc-guard {HOST}:{PORT} → {UPSTREAM}", flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        sys.exit(0)