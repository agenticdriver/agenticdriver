"""Runnable single-user loopback settings example. Credentials live only in backend memory.
Use the application's existing authorization/secret store when embedding in a real app.
"""
import json
import os
import secrets
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlsplit
from agenticdriver import AgenticClient, DriverError, ProviderPanel, provider_panel_html, provider_panel_script
from agenticdriver.connections import connection_target

client = None
connection = None

def connect(invitation):
    global client, connection
    if client is not None:
        raise DriverError('CONNECTION_EXISTS', 'Disconnect the current host first.')
    url, code = connection_target(invitation)
    with AgenticClient(url, code, ca_file=os.environ.get("AGENTICDRIVER_CA_FILE")) as pairing:
        grant = pairing.exchange_connection()
    client = AgenticClient(url, grant['token'], ca_file=os.environ.get('AGENTICDRIVER_CA_FILE'))
    connection = {'id': grant['id'], 'label': urlsplit(url).netloc, 'url': url}

def disconnect():
    global client, connection
    if client: client.close()
    client = connection = None

panel = ProviderPanel(lambda: client, connection=lambda: connection, connect=connect, disconnect=disconnect)
prefix = '/' + secrets.token_urlsafe(32)
markup = ('<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>AgenticDriver · Python</title>'
          '<style>body{margin:20px;background:#171c2b}</style>' + provider_panel_html(prefix + '/api', prefix + '/panel.js')).encode()

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_args): pass  # Never log private paths, invitations or API keys.
    def respond(self, status, value, content_type='application/json'):
        self.send_response(status)
        for key, val in {'Content-Type': content_type, 'Content-Length': str(len(value)), 'Cache-Control': 'no-store',
                         'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff',
                         'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'"}.items():
            self.send_header(key, val)
        self.end_headers()
        self.wfile.write(value)
    def allowed(self):
        authority = f'127.0.0.1:{self.server.server_port}'
        return self.headers.get('Host') == authority and self.headers.get('Origin', 'http://' + authority) == 'http://' + authority
    def do_GET(self):
        if not self.allowed(): self.respond(403, b'{}')
        elif self.path == prefix + '/': self.respond(200, markup, 'text/html; charset=utf-8')
        elif self.path == prefix + '/panel.js': self.respond(200, provider_panel_script(), 'text/javascript; charset=utf-8')
        else: self.respond(404, b'{}')
    def do_POST(self):
        if not self.allowed() or self.path != prefix + '/api':
            self.respond(403, b'{}'); return
        try:
            if self.headers.get('Content-Type', '').split(';')[0] != 'application/json' or self.headers.get('Transfer-Encoding'): raise ValueError()
            size = int(self.headers.get('Content-Length', '0'))
            if not 0 < size <= 1_000_000: raise ValueError()
            request = json.loads(self.rfile.read(size))
            if not isinstance(request, dict): raise ValueError()
            self.respond(200, json.dumps(panel.handle(request)).encode())
        except DriverError as error:
            self.respond(400, json.dumps({'error': {'code': error.code, 'message': str(error)}}).encode())
        except Exception:
            self.respond(400, b'{"error":{"message":"The panel request could not be completed."}}')
    def setup(self):
        super().setup()
        self.connection.settimeout(30)

if __name__ == '__main__':
    with HTTPServer(('127.0.0.1', 0), Handler) as server:
        print(json.dumps({'url': f'http://127.0.0.1:{server.server_port}{prefix}/'}), flush=True)
        try: server.serve_forever()
        except KeyboardInterrupt: pass
        finally: disconnect()
