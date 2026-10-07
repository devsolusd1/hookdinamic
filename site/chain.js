// Reading the record: the rulebook account from an RPC node, the agent's log from a file.
// The byte layout mirrors programs/hook/src/state.rs.

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const RULEBOOK_LEN = 896;
const MAX_CONDITIONS = 16;
const MAX_NAMES = 8;
/** A name in the rulebook: 32 bytes of name, 10 of ticker, two spare, each text followed by zeros. */
const NAME_ENTRY_LEN = 44;
const NAME_LEN = 32;
const SYMBOL_LEN = 10;

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
  const text = (at, length) => {
    const field = bytes.subarray(at, at + length);
    const end = field.indexOf(0);
    return new TextDecoder().decode(field.subarray(0, end < 0 ? length : end));
  };
  return {
    paused: bytes[2] !== 0,
    mint: key(8),
    guardian: key(40),
    agent: key(72),
    hasApp: bytes.subarray(104, 136).some((byte) => byte !== 0),
    limits: {
      minIntervalSecs: view.getUint32(200, true),
      maxRuleSecs: view.getUint32(204, true),
      maxTreasuryBps: u16(208),
      minRenameSecs: view.getUint32(210, true),
      minTreasuryBps: u16(214),
    },
    // The unix time the edict's term ends: its rule stops applying and the next edict is due.
    ruleUntil: Number(view.getBigInt64(216, true)),
    holdersBps: u16(224),
    burnBps: u16(226),
    treasuryBps: u16(228),
    // How many edicts have been issued.
    epoch: Number(view.getBigUint64(232, true)),
    updatedAt: Number(view.getBigInt64(240, true)),
    // The sha256 of the text of the edict in force.
    note: hex(bytes.subarray(248, 280)),
    // Twelve bytes a condition: group, fact, comparison, a spare byte, then the number.
    rule: Array.from({ length: Math.min(bytes[280], MAX_CONDITIONS) }, (_, i) => {
      const at = 288 + i * 12;
      return { group: bytes[at], fact: bytes[at + 1], op: bytes[at + 2], value: view.getBigUint64(at + 4, true) };
    }),
    // The names the token can go by, which of them it has now, and since when.
    names: Array.from({ length: Math.min(bytes[481], MAX_NAMES) }, (_, i) => {
      const at = 512 + i * NAME_ENTRY_LEN;
      return { name: text(at, NAME_LEN), symbol: text(at + NAME_LEN, SYMBOL_LEN) };
    }),
    name: bytes[480],
    renamedAt: Number(view.getBigInt64(488, true)),
    // The only key that may take the trading fees out of the curve, and only into accounts of its own.
    keeper: key(864),
  };
}

/** The chain's clock account. Its time, a unix second at byte 32, is the one the hook judges by. */
const CLOCK = "SysvarC1ock11111111111111111111111111111111";

/**
 * Everything the page reads from accounts, in one request: the rulebook decoded, the pool's
 * bytes if a pool is named (pool.js decodes them), the chain's own time and the slot it was
 * all read at.
 */
export async function readChain(rpc, rulebook, pool) {
  const response = await fetch(rpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getMultipleAccounts", params: [[rulebook, CLOCK, ...(pool ? [pool] : [])], { encoding: "base64", commitment: "confirmed" }] }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`the RPC answered ${response.status}`);
  const { result, error } = await response.json();
  if (error) throw new Error(error.message);
  const bytes = (account) => (account ? Uint8Array.from(atob(account.data[0]), (char) => char.charCodeAt(0)) : null);
  const [book, clock, market] = result.value.map(bytes);
  if (!book) throw new Error("there is no account at the rulebook's address");
  return {
    slot: result.context.slot,
    book: decodeRulebook(book),
    now: clock?.length >= 40 ? Number(new DataView(clock.buffer, clock.byteOffset, clock.byteLength).getBigInt64(32, true)) : null,
    pool: market,
  };
}

const isCondition = (c) => Number.isInteger(c?.group) && Number.isInteger(c.fact) && Number.isInteger(c.op) && typeof c.value === "string" && /^\d{1,20}$/.test(c.value);

const isChange = (change) =>
  typeof change === "object" &&
  change !== null &&
  Number.isInteger(change.ruleSecs) &&
  [change.holdersBps, change.burnBps, change.treasuryBps].every(Number.isInteger) &&
  Array.isArray(change.rule) &&
  change.rule.length <= MAX_CONDITIONS &&
  change.rule.every(isCondition);

/** What the agent says it picked from the catalogue. The page only takes the change of name from it. */
const isHooks = (hooks) =>
  typeof hooks === "object" &&
  hooks !== null &&
  typeof hooks.fees === "string" &&
  (hooks.buying === null || (typeof hooks.buying?.hook === "string" && Number.isInteger(hooks.buying.setting))) &&
  (hooks.name === null || (Number.isInteger(hooks.name) && hooks.name >= 0 && hooks.name < MAX_NAMES));

const isEdict = (record) =>
  typeof record.announcement === "string" &&
  isChange(record.change) &&
  isHooks(record.hooks);

const isEntry = (entry) =>
  typeof entry?.record === "object" &&
  entry.record !== null &&
  Number.isInteger(entry.record.epoch) &&
  typeof entry.record.at === "string" &&
  // A date the page could not print would stop the whole journal.
  Number.isFinite(Date.parse(entry.record.at)) &&
  typeof entry.record.reasoning === "string" &&
  (entry.record.action === "hold" || (entry.record.action === "rewrite" && isEdict(entry.record)));

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

/** A logged rule as the chain would hold it: the log keeps 64-bit numbers as text. */
export const loggedRule = (change) => change.rule.map((condition) => ({ ...condition, value: BigInt(condition.value) }));

/** The hash the agent stores on chain with an edict: sha256 of the record exactly as logged. */
export async function hashOf(record) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(record)));
  return hex(new Uint8Array(digest));
}
