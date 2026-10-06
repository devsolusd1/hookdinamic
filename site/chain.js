// Reading the record: the rulebook account from an RPC node, the agent's log from a file.
// The byte layout mirrors programs/hook/src/state.rs.

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const RULEBOOK_LEN = 384;

export const isAddress = (text) => typeof text === "string" && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(text);
export const isSignature = (text) => typeof text === "string" && /^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(text);

export function base58(bytes) {
  const digits = [];
  for (const byte of bytes) {
    let carry = byte;
    for (let i = 0; i < digits.length; i++) {
      carry += digits[i] * 256;
      digits[i] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }
  let text = "";
  for (const byte of bytes) {
    if (byte !== 0) break;
    text += "1";
  }
  for (let i = digits.length - 1; i >= 0; i--) text += ALPHABET[digits[i]];
  return text;
}

const hex = (bytes) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

export function decodeRulebook(bytes) {
  if (bytes.length !== RULEBOOK_LEN) throw new Error(`a rulebook is ${RULEBOOK_LEN} bytes, this account has ${bytes.length}`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const key = (at) => base58(bytes.subarray(at, at + 32));
  const u16 = (at) => view.getUint16(at, true);
  return {
    paused: bytes[2] !== 0,
    mint: key(8),
    guardian: key(40),
    agent: key(72),
    hasApp: bytes.subarray(104, 136).some((byte) => byte !== 0),
    limits: {
      minIntervalSecs: view.getUint32(168, true),
      maxGateSecs: view.getUint32(172, true),
      minMaxBuyBps: u16(176),
      minMaxWalletBps: u16(178),
      maxTreasuryBps: u16(180),
    },
    // Buys need the app's signature until this unix time. 0: anyone may buy.
    gateUntil: Number(view.getBigInt64(184, true)),
    maxBuyBps: u16(192),
    maxWalletBps: u16(194),
    holdersBps: u16(196),
    burnBps: u16(198),
    treasuryBps: u16(200),
    // How many edicts have been issued.
    epoch: Number(view.getBigUint64(208, true)),
    updatedAt: Number(view.getBigInt64(216, true)),
    // The sha256 of the text of the edict in force.
    note: hex(bytes.subarray(224, 256)),
  };
}

export async function readRulebook(rpc, address) {
  const response = await fetch(rpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getAccountInfo", params: [address, { encoding: "base64", commitment: "confirmed" }] }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`the RPC answered ${response.status}`);
  const { result, error } = await response.json();
  if (error) throw new Error(error.message);
  if (!result?.value) throw new Error("there is no account at the rulebook's address");
  return decodeRulebook(Uint8Array.from(atob(result.value.data[0]), (char) => char.charCodeAt(0)));
}

const isEntry = (entry) =>
  typeof entry?.record === "object" &&
  entry.record !== null &&
  Number.isInteger(entry.record.epoch) &&
  typeof entry.record.at === "string" &&
  typeof entry.record.reasoning === "string" &&
  (entry.record.action === "hold" || (entry.record.action === "rewrite" && typeof entry.record.announcement === "string" && typeof entry.record.change === "object"));

/** The agent's log, oldest first. An empty list if nothing is published; null if the file could not be fetched. */
export async function readLog(url) {
  let response;
  try {
    response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(10_000) });
  } catch {
    return null;
  }
  if (response.status === 404) return [];
  if (!response.ok) return null;
  const entries = [];
  for (const line of (await response.text()).split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (isEntry(entry)) entries.push(entry);
    } catch {
      // A line cut short by a write in progress: the next read will have it whole.
    }
  }
  return entries;
}

/** The hash the agent stores on chain with an edict: sha256 of the record exactly as logged. */
export async function hashOf(record) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(record)));
  return hex(new Uint8Array(digest));
}
