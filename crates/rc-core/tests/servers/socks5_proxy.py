"""Minimal SOCKS5 proxy (no auth, CONNECT only) for tests: python3 socks5_proxy.py <port>
Logs every CONNECT so tests can be checked for traffic going through the proxy."""
import asyncio
import socket
import struct
import sys


async def pipe(reader, writer):
    try:
        while data := await reader.read(65536):
            writer.write(data)
            await writer.drain()
    except Exception:
        pass
    finally:
        writer.close()


async def handle(reader, writer):
    try:
        _ver, n = await reader.readexactly(2)
        await reader.readexactly(n)
        writer.write(b"\x05\x00")
        await writer.drain()
        _ver, _cmd, _rsv, atyp = await reader.readexactly(4)
        if atyp == 1:
            host = socket.inet_ntoa(await reader.readexactly(4))
        elif atyp == 3:
            host = (await reader.readexactly((await reader.readexactly(1))[0])).decode()
        else:
            host = socket.inet_ntop(socket.AF_INET6, await reader.readexactly(16))
        port = struct.unpack("!H", await reader.readexactly(2))[0]
        remote_reader, remote_writer = await asyncio.open_connection(host, port)
        writer.write(b"\x05\x00\x00\x01" + socket.inet_aton("0.0.0.0") + struct.pack("!H", 0))
        await writer.drain()
        print(f"CONNECT {host}:{port}", flush=True)
        await asyncio.gather(pipe(reader, remote_writer), pipe(remote_reader, writer))
    except Exception as e:
        print(f"error: {e}", flush=True)
        writer.close()


async def main():
    server = await asyncio.start_server(handle, "127.0.0.1", int(sys.argv[1]))
    async with server:
        await server.serve_forever()


asyncio.run(main())
