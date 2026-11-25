import WebSocket from "ws";
import { createDiagnostics, runtimeOrigin } from "@orvyn/shared/server";

const log = createDiagnostics("web", process.env);

const maxBytes = 4 * 1024 * 1024;
interface Tunnel {
  socket: WebSocket;
  pending: Uint8Array[];
  bytes: number;
  closed: boolean;
}
const tunnels = new WeakMap<object, Tunnel>();
const closeCode = (code?: number) =>
  code &&
  (code === 1000 ||
    (code >= 1001 && code <= 1014 && ![1004, 1005, 1006].includes(code)) ||
    (code >= 3000 && code <= 4999))
    ? code
    : 1011;

export default defineWebSocketHandler({
  upgrade(request) {
    // Keep the browser's origin intact. Never turn an arbitrary inbound origin
    // into the trusted upstream origin or infer trust from forwarded headers.
    if (request.headers.get("origin") !== runtimeOrigin(process.env)) {
      log.warn("websocket.origin_rejected", {
        stage: "websocket",
        status: 403,
      });
      return new Response("Invalid origin", { status: 403 });
    }
    if (!request.headers.get("cookie")?.includes("orvyn_session="))
      return new Response("Sign in required", { status: 401 });
  },
  open(peer) {
    const config = useRuntimeConfig();
    const upstream = new URL(config.collaborationUpstream);
    if (!["ws:", "wss:"].includes(upstream.protocol)) {
      peer.close(1011, "Collaboration unavailable");
      return;
    }
    const socket = new WebSocket(upstream, {
      headers: {
        cookie: peer.request.headers.get("cookie") || "",
        origin: peer.request.headers.get("origin") || "",
      },
      maxPayload: maxBytes,
      handshakeTimeout: 5000,
      perMessageDeflate: false,
    });
    const tunnel: Tunnel = { socket, pending: [], bytes: 0, closed: false };
    tunnels.set(peer, tunnel);
    socket.on("open", () => {
      if (tunnel.closed) return socket.close();
      for (const data of tunnel.pending) socket.send(data);
      tunnel.pending = [];
      tunnel.bytes = 0;
    });
    socket.on("message", (data, binary) => {
      if (tunnel.closed) return;
      if ((peer.websocket.bufferedAmount || 0) > maxBytes) {
        tunnel.closed = true;
        socket.close(1013, "Outbound queue limit");
        peer.close(1013, "Outbound queue limit");
        return;
      }
      peer.send(binary ? data : data.toString());
    });
    socket.on("close", (code, reason) => {
      tunnel.closed = true;
      tunnel.pending = [];
      tunnel.bytes = 0;
      peer.close(closeCode(code), reason.toString());
    });
    socket.on("error", () => {
      log.error("websocket.upstream_failed", { stage: "websocket" });
      tunnel.closed = true;
      tunnel.pending = [];
      tunnel.bytes = 0;
      peer.close(1011, "Collaboration unavailable");
    });
  },
  message(peer, message) {
    const tunnel = tunnels.get(peer);
    if (!tunnel || tunnel.closed) return;
    const data = message.uint8Array();
    if (
      data.byteLength > maxBytes ||
      tunnel.socket.bufferedAmount > maxBytes ||
      (tunnel.socket.readyState === WebSocket.CONNECTING &&
        (tunnel.pending.length >= 32 ||
          tunnel.bytes + data.byteLength > maxBytes))
    ) {
      tunnel.closed = true;
      tunnel.pending = [];
      tunnel.socket.terminate();
      peer.close(1009, "Message or queue too large");
      return;
    }
    if (tunnel.socket.readyState === WebSocket.OPEN) tunnel.socket.send(data);
    else if (tunnel.socket.readyState === WebSocket.CONNECTING) {
      tunnel.pending.push(data);
      tunnel.bytes += data.byteLength;
    }
  },
  close(peer) {
    const tunnel = tunnels.get(peer);
    if (!tunnel) return;
    tunnel.closed = true;
    tunnel.pending = [];
    tunnel.bytes = 0;
    if (tunnel.socket.readyState === WebSocket.CONNECTING)
      tunnel.socket.terminate();
    else tunnel.socket.close();
    tunnels.delete(peer);
  },
});
