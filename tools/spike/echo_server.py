#!/usr/bin/env python3
"""本機 echo server，用來驗證 SketchUp 送出的二進位資料有沒有被破壞。

用法（在另一個終端機視窗）：
    python3 tools/spike/echo_server.py

接受 PUT / POST，回傳 JSON：收到幾個 byte、sha256、Content-Type。
只聽 127.0.0.1，不對外開放，資料不會離開這台機器。
"""
import hashlib
import json
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer

PORT = 8787


class EchoHandler(BaseHTTPRequestHandler):
    def _handle_body(self):
        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length) if length else b""
        digest = hashlib.sha256(body).hexdigest()
        info = {
            "method": self.command,
            "content_length_header": length,
            "bytes_received": len(body),
            "sha256": digest,
            "content_type": self.headers.get("Content-Type"),
            "first_8_bytes_hex": body[:8].hex(),
        }
        print(f"  {self.command} {self.path}  {len(body)} bytes  sha256={digest[:16]}…  "
              f"開頭={body[:8].hex()}", flush=True)
        payload = json.dumps(info).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    do_PUT = _handle_body
    do_POST = _handle_body

    def do_GET(self):
        payload = json.dumps({"ok": True, "hint": "用 PUT 或 POST 送資料來驗證"}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, *args):
        pass  # 用我們自己的 print，不要 access log 洗版


if __name__ == "__main__":
    print(f"echo server 聽在 http://127.0.0.1:{PORT}")
    print("PNG 的開頭 8 bytes 應為 89504e470d0a1a0a —— 若不是，代表二進位被破壞了")
    print("Ctrl+C 結束\n", flush=True)
    try:
        HTTPServer(("127.0.0.1", PORT), EchoHandler).serve_forever()
    except KeyboardInterrupt:
        print("\n已停止")
        sys.exit(0)
