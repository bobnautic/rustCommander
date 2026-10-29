"""Test WebDAV server (wsgidav + cheroot, basic auth user/pass):
python3 webdav_server.py <root> <port> [certfile keyfile]"""
import sys

from cheroot import wsgi
from wsgidav.wsgidav_app import WsgiDAVApp

root, port = sys.argv[1], int(sys.argv[2])
cert = sys.argv[3] if len(sys.argv) > 3 else None
key = sys.argv[4] if len(sys.argv) > 4 else None

config = {
    "host": "127.0.0.1",
    "port": port,
    "provider_mapping": {"/dav": root},
    "http_authenticator": {"accept_basic": True, "accept_digest": False, "default_to_digest": False},
    "simple_dc": {"user_mapping": {"*": {"user": {"password": "pass"}}}},
    "verbose": 1,
    "logging": {"enable": True},
    "property_manager": True,
    "lock_storage": True,
}
app = WsgiDAVApp(config)
server = wsgi.Server(("127.0.0.1", port), app, numthreads=16)
if cert:
    from cheroot.ssl.builtin import BuiltinSSLAdapter

    server.ssl_adapter = BuiltinSSLAdapter(cert, key)
server.start()
