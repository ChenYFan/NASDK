# @chenyfan/nact-channel

Shared byte-channel adapters for NASDK providers. The default entry exports the bounded `ByteChannel` and `transportError` helpers. `/socket` adapts Node-compatible TCP/Unix sockets; `/websocket` adapts browser WebSocket and `ws` connections.

The default and WebSocket entries do not import Node networking modules. NACT framing and NACP messages remain in NASDK core; this package handles only bytes, read modes and connection lifecycle.
