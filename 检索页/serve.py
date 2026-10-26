# -*- coding: utf-8 -*-
"""
serve.py — 一个极简本地静态服务

用法：
    python serve.py            # 默认 8765 端口，自动打开浏览器
    python serve.py 8080       # 指定端口

说明：
    本页面用 <script src="data.js"> 读取数据，直接双击 index.html 也能用。
    起本地服务的好处是：路径更规范、以后开启向量检索时能正常加载 models/ 下的模型文件。
"""
import os
import sys
import http.server
import socketserver
import webbrowser
import threading

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
ROOT = os.path.dirname(os.path.abspath(__file__))
os.chdir(ROOT)


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = dict(http.server.SimpleHTTPRequestHandler.extensions_map)
    extensions_map.update({".js": "text/javascript", ".json": "application/json", ".onnx": "application/octet-stream"})

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt, *args):
        pass  # 安静模式


def main():
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer(("127.0.0.1", PORT), Handler) as httpd:
        url = "http://127.0.0.1:%d/index.html" % PORT
        print("检索页已启动： " + url)
        print("按 Ctrl+C 停止")
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\n已停止")


if __name__ == "__main__":
    main()
