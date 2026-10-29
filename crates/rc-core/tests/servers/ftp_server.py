"""Test FTP server (pyftpdlib, user "user" / password "pass"):
python3 ftp_server.py <root> <plain|explicit|implicit> <port> [certfile|-] [max_cons_per_ip] [idle_timeout]"""
import errno
import os
import sys

from pyftpdlib.authorizers import DummyAuthorizer
from pyftpdlib.filesystems import AbstractedFS
from pyftpdlib.handlers import FTPHandler, TLS_FTPHandler
from pyftpdlib.servers import ThreadedFTPServer

root, mode, port = sys.argv[1], sys.argv[2], int(sys.argv[3])
cert = sys.argv[4] if len(sys.argv) > 4 else None
max_per_ip = int(sys.argv[5]) if len(sys.argv) > 5 else 0
idle_timeout = int(sys.argv[6]) if len(sys.argv) > 6 else 0


class ThreadSafeFS(AbstractedFS):
    """CWD without os.chdir: threaded sessions share the process cwd, and pyftpdlib's
    chdir-based check drops connections when another session deletes that directory."""

    def chdir(self, path):
        if not os.path.isdir(path):
            raise OSError(errno.ENOENT, os.strerror(errno.ENOENT))
        if not os.access(path, os.X_OK):
            raise OSError(errno.EACCES, os.strerror(errno.EACCES))
        self.cwd = self.fs2ftp(path)


auth = DummyAuthorizer()
auth.add_user("user", "pass", root, perm="elradfmwMT")

if mode == "plain":
    class Handler(FTPHandler):
        pass
elif mode == "explicit":
    class Handler(TLS_FTPHandler):
        certfile = cert
        tls_control_required = True
        tls_data_required = True
else:
    class Handler(TLS_FTPHandler):
        certfile = cert

        def handle(self):
            # Implicit FTPS: TLS from the first byte; greet once the handshake is done.
            self.secure_connection(self.ssl_context)

        def handle_ssl_established(self):
            if not getattr(self, "_greeted", False):
                self._greeted = True
                FTPHandler.handle(self)

Handler.authorizer = auth
Handler.abstracted_fs = ThreadSafeFS
Handler.passive_ports = range(30000 + (port % 100) * 50, 30000 + (port % 100) * 50 + 50)
Handler.banner = f"rc test server ({mode})"
if idle_timeout:
    Handler.timeout = idle_timeout

server = ThreadedFTPServer(("127.0.0.1", port), Handler)
if max_per_ip:
    server.max_cons_per_ip = max_per_ip
server.serve_forever()
