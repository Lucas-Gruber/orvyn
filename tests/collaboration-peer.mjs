import assert from "node:assert/strict";
import WS from "ws";
import {
  HocuspocusProvider,
  HocuspocusProviderWebsocket,
} from "@hocuspocus/provider";
import * as Y from "yjs";
export async function waitFor(check, label) {
  const end = Date.now() + 12000;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.fail(label);
}
export function peer(url, pageId, cookie, origin = process.env.TEST_ORIGIN) {
  const doc = new Y.Doc();
  let rejected = false,
    closed = false,
    reason = "";
  class AuthenticatedSocket extends WS {
    constructor(url, protocols) {
      super(url, protocols, {
        headers: { Origin: origin, ...(cookie ? { Cookie: cookie } : {}) },
      });
    }
  }
  const socket = new HocuspocusProviderWebsocket({
    url,
    WebSocketPolyfill: AuthenticatedSocket,
    delay: 50,
    minDelay: 20,
    maxDelay: 200,
  });
  const provider = new HocuspocusProvider({
    websocketProvider: socket,
    name: pageId,
    document: doc,
    token: "cookie",
    onAuthenticationFailed(event) {
      reason = event.reason;
      rejected = true;
    },
    onClose(event) {
      reason = event.event.reason;
      closed = true;
    },
  });
  provider.attach();

  return {
    doc,
    provider,
    socket,
    get reason() {
      return reason;
    },
    get rejected() {
      return rejected;
    },
    get closed() {
      return closed;
    },
    destroy() {
      provider.destroy();
      socket.destroy();
      doc.destroy();
    },
  };
}
