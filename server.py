#!/usr/bin/env python3
"""Local dev server with WCS proxy to bypass CORS."""
import http.server
import urllib.request
import urllib.error
import sys

class Handler(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        if self.path.startswith('/proxy/emodnet-wcs?'):
            self._proxy_wcs()
        else:
            super().do_GET()

    def _proxy_wcs(self):
        query = self.path.split('?', 1)[1]
        url = f'https://ows.emodnet-bathymetry.eu/wcs?{query}'
        try:
            req = urllib.request.Request(url, headers={'User-Agent': 'SeaFloorExplorer/1.0'})
            with urllib.request.urlopen(req, timeout=20) as resp:
                data = resp.read()
                self.send_response(200)
                ct = resp.headers.get('Content-Type', 'application/octet-stream')
                self.send_header('Content-Type', ct)
                self.send_header('Access-Control-Allow-Origin', '*')
                self.send_header('Content-Length', len(data))
                self.end_headers()
                self.wfile.write(data)
        except urllib.error.HTTPError as e:
            self.send_response(e.code)
            self.send_header('Content-Type', 'text/plain')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(f'WCS error: {e.code} {e.reason}'.encode())
        except Exception as e:
            self.send_response(502)
            self.send_header('Content-Type', 'text/plain')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(f'Proxy error: {e}'.encode())

    def log_message(self, format, *args):
        if '/proxy/' in (args[0] if args else ''):
            sys.stderr.write(f'[proxy] {args[0]}\n')
        else:
            super().log_message(format, *args)

if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    server = http.server.HTTPServer(('', port), Handler)
    print(f'Server with WCS proxy on http://localhost:{port}')
    server.serve_forever()
