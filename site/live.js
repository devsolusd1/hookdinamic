// Hearing of a change the moment it lands: accounts watched over the RPC node's WebSocket
// (accountSubscribe), kept awake and taken up again when the line drops. It can also listen for
// the transactions that mention one address (logsSubscribe): a buy the hook refuses changes no
// account, so that is the only way to hear of one at once. It only makes the page prompt. What
// it misses while the line is down, the page's own polling still finds.

/** The public devnet node cuts a socket that has been silent for 60 seconds. A browser cannot send a
 *  ping frame, so this asks for a method the node does not have and takes the refusal as the answer. */
const PING_MS = 20_000;
/** What stands for the subscription to transactions, where the others have an account's address. */
const MENTIONS = Symbol("mentions");
/** The waits before trying the line again. The last one repeats. */
const RETRY_MS = [1_000, 2_000, 5_000, 10_000, 30_000];

/** Where an RPC node listens for WebSockets, from the address it answers HTTP on. */
export function socketUrl(rpc) {
  const url = new URL(rpc, globalThis.location?.href);
  if (url.protocol === "ws:" || url.protocol === "wss:") return url.href;
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`not an RPC address: ${rpc}`);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  // A node addressed by its port listens for WebSockets on the next one: 8899 and 8900.
  if (url.port) url.port = String(Number(url.port) + 1);
  return url.href;
}

/**
 * Calls `onChange(address, bytes, slot)` each time one of the accounts changes, and
 * `onState("live" | "partial" | "reconnecting" | "off")` as the line comes and goes: "partial" is
 * a node that took some of the subscriptions and refused others. Returns what stops it.
 * A change made while the line was down is not sent again: read the accounts once on every "live".
 * With `mentions`, an address, `onMention(signature, failed)` is called for every transaction
 * that names it, the failed ones too.
 */
export function watchAccounts(rpc, addresses, onChange, onState, { mentions, onMention } = {}) {
  const wanted = [...new Set(addresses)].filter(Boolean);
  /** The slot of the last change passed on for each account, so that an older one never follows it. */
  const newest = new Map();
  let socket = null;
  let beat = 0;
  let retry = 0;
  let failures = 0;
  let wasLive = false;
  let state = "";
  let stopped = false;

  const tell = (next) => {
    if (next === state) return;
    state = next;
    try {
      onState?.(next);
    } catch {
      // The page's own mistake. It is not a reason to stop listening.
    }
  };

  /** Lets go of a socket: nothing it does after this is heard. */
  const release = (ws) => {
    clearInterval(beat);
    ws.onopen = ws.onmessage = ws.onclose = null;
    try {
      ws.close();
    } catch {
      // It was already gone.
    }
    if (socket === ws) socket = null;
  };

  function connect() {
    let ws;
    try {
      ws = new WebSocket(socketUrl(rpc));
    } catch {
      // No WebSocket here, or an address it will not take. Trying again would not change that.
      return tell("off");
    }
    socket = ws;
    tell("reconnecting");

    const asked = new Map(); // the id of a request to subscribe -> the account
    const subscribed = new Map(); // the id of a subscription -> the account
    let heard = false;

    const send = (id, method, params) => {
      try {
        ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
      } catch {
        // The line is going down. Its closing is what gets acted on.
      }
    };

    const lost = () => {
      release(ws);
      if (stopped) return;
      // A node that has not let this page in once, after all those waits, is not going to. The public
      // mainnet one refuses every handshake that comes from a browser.
      if (!wasLive && failures >= RETRY_MS.length) return tell("off");
      tell("reconnecting");
      const wait = RETRY_MS[Math.min(failures++, RETRY_MS.length - 1)];
      // Not all at once, when a node comes back to every page that was watching it.
      retry = setTimeout(connect, wait * (0.75 + Math.random() / 2));
    };

    ws.onopen = () => {
      wanted.forEach((address, i) => {
        asked.set(i + 1, address);
        send(i + 1, "accountSubscribe", [address, { encoding: "base64", commitment: "confirmed" }]);
      });
      if (mentions) {
        asked.set(wanted.length + 1, MENTIONS);
        send(wanted.length + 1, "logsSubscribe", [{ mentions: [mentions] }, { commitment: "confirmed" }]);
      }
    };

    ws.onmessage = (event) => {
      heard = true;
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (message?.method === "accountNotification") {
        const address = subscribed.get(message.params?.subscription);
        const slot = message.params?.result?.context?.slot;
        const data = message.params?.result?.value?.data?.[0];
        if (!address || typeof data !== "string" || slot < newest.get(address)) return;
        newest.set(address, slot);
        try {
          // An account that has been closed comes as no bytes at all.
          onChange(address, Uint8Array.from(atob(data), (char) => char.charCodeAt(0)), slot);
        } catch {
          // Bytes the page could not read. The next change is still worth hearing.
        }
        return;
      }
      if (message?.method === "logsNotification") {
        const value = message.params?.result?.value;
        if (subscribed.get(message.params?.subscription) !== MENTIONS || typeof value?.signature !== "string") return;
        try {
          onMention?.(value.signature, value.err != null);
        } catch {
          // As above.
        }
        return;
      }
      const address = asked.get(message?.id);
      if (!address) return;
      asked.delete(message.id);
      if (Number.isInteger(message.result)) subscribed.set(message.result, address);
      if (asked.size > 0) return;
      // Every request has its answer. A node that would not take any of them is no use as it is.
      if (subscribed.size === 0) return lost();
      wasLive = true;
      // One that took only some is worth keeping, but the page must go on asking for the rest.
      tell(subscribed.size === wanted.length + (mentions ? 1 : 0) ? "live" : "partial");
    };

    ws.onclose = lost;

    // Starts with the attempt, so a socket that never opens is given up on as well, and so is one
    // that has left a request to subscribe unanswered.
    beat = setInterval(() => {
      if (!heard || asked.size > 0) return lost();
      heard = false;
      // It lasted a heartbeat: the next failure starts the waits over.
      failures = 0;
      send(0, "ping");
    }, PING_MS);
  }

  if (wanted.length > 0) retry = setTimeout(connect, 0);
  else retry = setTimeout(() => tell("off"), 0);

  return () => {
    stopped = true;
    clearTimeout(retry);
    if (socket) release(socket);
    tell("off");
  };
}
