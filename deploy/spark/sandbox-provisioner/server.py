#!/usr/bin/env python3
"""Lightweight sandbox provisioner HTTP service.

Listens on port 8090. When nginx gets a 502 for /openclaw-user/{username},
it redirects here. This service creates the sandbox and redirects back.

Endpoints:
  GET /provision/{username}?redirect={original_url}
    - Creates sandbox if not exists
    - Returns 302 redirect to original URL
  GET /health
    - Returns 200 OK
"""

import http.server
import json
import os
import re
import subprocess
import sys
import urllib.parse

PORT = int(os.environ.get("PROVISIONER_PORT", "8090"))
PROVISION_SCRIPT = "/app/provision.sh"

# Simple lock to prevent concurrent provisioning of the same user
_provisioning = set()


class ProvisionHandler(http.server.BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        sys.stderr.write(f"[provisioner] {fmt % args}\n")

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path.rstrip("/")

        if path == "/health":
            self._respond(200, {"ok": True})
            return

        # /provision/{username}
        match = re.match(r"^/provision/([a-zA-Z0-9_-]+)$", path)
        if not match:
            self._respond(404, {"error": "not found"})
            return

        username = match.group(1)
        params = urllib.parse.parse_qs(parsed.query)
        redirect_url = params.get("redirect", [""])[0]

        # Prevent concurrent provisioning
        if username in _provisioning:
            self.log_message("Already provisioning: %s, waiting...", username)
            # Return a retry-after page
            self._respond_html(
                503,
                f"""<html><head>
                <meta http-equiv="refresh" content="5;url={self.path}">
                </head><body>
                <h2>Creating sandbox for {username}...</h2>
                <p>This may take 15-30 seconds. Page will auto-refresh.</p>
                </body></html>""",
            )
            return

        _provisioning.add(username)
        try:
            self.log_message("Provisioning sandbox: %s", username)
            result = subprocess.run(
                ["bash", PROVISION_SCRIPT, username],
                capture_output=True,
                text=True,
                timeout=120,
            )

            if result.returncode != 0:
                self.log_message("Provision failed: %s", result.stderr)
                self._respond(500, {
                    "error": "provision failed",
                    "stderr": result.stderr[-500:],
                })
                return

            output = result.stdout.strip().split("\n")[-1]
            self.log_message("Provision result: %s", output)

            if redirect_url:
                # Redirect back to original URL
                self.send_response(302)
                self.send_header("Location", redirect_url)
                self.send_header("Cache-Control", "no-cache")
                self.end_headers()
            else:
                self._respond(200, {"ok": True, "result": output})

        except subprocess.TimeoutExpired:
            self._respond(504, {"error": "provision timeout"})
        except Exception as e:
            self._respond(500, {"error": str(e)})
        finally:
            _provisioning.discard(username)

    def _respond(self, code, data):
        body = json.dumps(data).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _respond_html(self, code, html):
        body = html.encode()
        self.send_response(code)
        self.send_header("Content-Type", "text/html")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


if __name__ == "__main__":
    server = http.server.HTTPServer(("0.0.0.0", PORT), ProvisionHandler)
    print(f"[provisioner] Listening on port {PORT}", flush=True)
    server.serve_forever()
