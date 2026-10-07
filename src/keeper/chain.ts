// The chain, as far as the keeper's books and payments need it: a handful of reads and one
// write. `chainOf` is the real one; scripts/keeper-sim.ts stands a made-up one in its place.
import { ACCOUNT_SIZE, AccountType, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { type Connection, PublicKey, SystemProgram, VersionedTransaction } from "@solana/web3.js";

export type TokenAccount = { address: string; owner: string; amount: bigint };

/** What an owner's own account looks like. Null in a list of these: no such account yet. */
export type OwnerAccount = { program: string; hasData: boolean; executable: boolean };

/** What a node says about a signature. Null in a list of these: it has never seen it. */
export type Status = { slot: number; failed: boolean; error?: string; finalized: boolean };

export type Chain = {
  /** Every token account of the mint with its owner and balance, all read at one finalized slot. */
  tokenAccounts(mint: PublicKey, minSlot?: number): Promise<{ slot: number; accounts: TokenAccount[] }>;
  /** The mint's supply, in base units, at a finalized slot. */
  supply(mint: PublicKey, minSlot?: number): Promise<{ slot: number; amount: bigint }>;
  ownerAccounts(owners: string[]): Promise<(OwnerAccount | null)[]>;
  /** The fewest lamports an account with no data may hold. A smaller transfer to an empty address fails. */
  rentExemptMinimum(): Promise<bigint>;
  /** What an address holds, in lamports. With `minSlot`, a node that has not seen that slot yet answers with an error instead of an older figure. */
  balance(address: PublicKey, minSlot?: number): Promise<bigint>;
  /** A recent blockhash, the last block height a transaction signed with it can enter, and the slot the node was at when it gave it. */
  latestBlockhash(): Promise<{ blockhash: string; lastValidBlockHeight: number; slot: number }>;
  send(raw: Uint8Array): Promise<void>;
  /** `slot` is how far the answering node had seen when it answered. */
  statuses(signatures: string[]): Promise<{ slot: number; statuses: (Status | null)[] }>;
  /** The newest finalized block: its slot and its height. */
  finalized(): Promise<{ slot: number; blockHeight: number }>;
  /** The oldest slot whose block the answering node still has. What happened before it, the node cannot say. */
  firstAvailableSlot(): Promise<number>;
  /**
   * The newest transactions that name an address, newest first, as soon as a block has them:
   * a payment by a second keeper with the same key shows here a second after it lands, and
   * not the thirteen it takes to be finalized.
   */
  history(address: PublicKey, limit: number): Promise<{ signature: string; failed: boolean }[]>;
  /** Who paid for a transaction. Null if the node cannot show it, which can be for a moment after it has listed it. */
  feePayer(signature: string): Promise<string | null>;
};

export const SYSTEM = SystemProgram.programId.toBase58();

// Where the fields of a token account sit (spl-token's AccountLayout): the mint at 0, the
// owner at 32, the amount at 64. In a mint, the supply sits at 36.
const OWNER_AT = 32;
const AMOUNT_AT = 64;
const SUPPLY_AT = 36;
/** Token-2022 marks an account longer than the plain 165 bytes with its kind in the next byte. This is "2", a token account, in base58. */
const IS_TOKEN_ACCOUNT = "3";
if (AccountType.Account !== 2) throw new Error("the byte that marks a token account is no longer 2");

export const chunks = <T>(list: T[], size: number): T[][] => Array.from({ length: Math.ceil(list.length / size) }, (_, i) => list.slice(i * size, (i + 1) * size));

export function chainOf(connection: Connection): Chain {
  return {
    async tokenAccounts(mint, minSlot) {
      const { context, value } = await connection.getProgramAccounts(TOKEN_2022_PROGRAM_ID, {
        commitment: "finalized",
        withContext: true,
        minContextSlot: minSlot,
        // Only the owner and the amount come back: 40 bytes an account instead of 171 or more.
        dataSlice: { offset: OWNER_AT, length: AMOUNT_AT + 8 - OWNER_AT },
        // The mint's token accounts carry the hook's extension, so none is 165 bytes long and a
        // filter on that size would find nothing. A node looks the mint up in its index, instead
        // of walking every Token-2022 account, when the second filter is exactly this one.
        filters: [{ memcmp: { offset: 0, bytes: mint.toBase58() } }, { memcmp: { offset: ACCOUNT_SIZE, bytes: IS_TOKEN_ACCOUNT } }],
      });
      return {
        slot: context.slot,
        accounts: value.map(({ pubkey, account }) => ({
          address: pubkey.toBase58(),
          owner: new PublicKey(account.data.subarray(0, 32)).toBase58(),
          amount: account.data.readBigUInt64LE(AMOUNT_AT - OWNER_AT),
        })),
      };
    },
    async supply(mint, minSlot) {
      const { context, value } = await connection.getAccountInfoAndContext(mint, { commitment: "finalized", minContextSlot: minSlot, dataSlice: { offset: SUPPLY_AT, length: 8 } });
      if (!value) throw new Error(`no finalized block has the mint ${mint.toBase58()} yet`);
      if (!value.owner.equals(TOKEN_2022_PROGRAM_ID)) throw new Error(`${mint.toBase58()} is not a Token-2022 mint`);
      return { slot: context.slot, amount: value.data.readBigUInt64LE(0) };
    },
    async ownerAccounts(owners) {
      const found: (OwnerAccount | null)[] = [];
      // A node answers for at most 100 accounts at a time.
      for (const some of chunks(owners, 100)) {
        const accounts = await connection.getMultipleAccountsInfo(some.map((owner) => new PublicKey(owner)), { commitment: "finalized", dataSlice: { offset: 0, length: 1 } });
        for (const account of accounts) found.push(account ? { program: account.owner.toBase58(), hasData: account.data.length > 0, executable: account.executable } : null);
      }
      return found;
    },
    rentExemptMinimum: async () => BigInt(await connection.getMinimumBalanceForRentExemption(0, "finalized")),
    balance: async (address, minSlot) => BigInt(await connection.getBalance(address, { commitment: "confirmed", minContextSlot: minSlot || undefined })),
    async latestBlockhash() {
      const { context, value } = await connection.getLatestBlockhashAndContext("confirmed");
      return { ...value, slot: context.slot };
    },
    async send(raw) {
      // No rehearsal on the node and no retries by it: this code sends again itself, and takes its
      // verdicts from finalized blocks only. A transaction that cannot work lands as a failure, once.
      await connection.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 });
    },
    async statuses(signatures) {
      let slot = Infinity;
      const statuses: (Status | null)[] = [];
      // At most 256 signatures a request. The history is searched too: a restart may come long after the send.
      for (const some of chunks(signatures, 256)) {
        const { context, value } = await connection.getSignatureStatuses(some, { searchTransactionHistory: true });
        slot = Math.min(slot, context.slot);
        for (const status of value) {
          statuses.push(status ? { slot: status.slot, failed: status.err !== null, ...(status.err !== null ? { error: JSON.stringify(status.err) } : {}), finalized: status.confirmationStatus === "finalized" } : null);
        }
      }
      return { slot: signatures.length ? slot : 0, statuses };
    },
    async finalized() {
      const info = await connection.getEpochInfo("finalized");
      if (info.blockHeight === undefined) throw new Error("the node did not say how high the finalized block is");
      return { slot: info.absoluteSlot, blockHeight: info.blockHeight };
    },
    firstAvailableSlot: () => connection.getFirstAvailableBlock(),
    async history(address, limit) {
      const found = await connection.getSignaturesForAddress(address, { limit }, "confirmed");
      return found.map((entry) => ({ signature: entry.signature, failed: entry.err !== null }));
    },
    async feePayer(signature) {
      const found = await connection.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
      return found ? found.transaction.message.staticAccountKeys[0].toBase58() : null;
    },
  };
}

/** What a node makes of a signed transaction without sending it: null if it would go through. */
export type Rehearsal = { error: string | null; logs: string[] };

/** Runs the signed bytes on the node, signatures checked, without sending them. A refusal here costs nothing. */
export async function rehearse(connection: Connection, raw: Uint8Array): Promise<Rehearsal> {
  const { value } = await connection.simulateTransaction(VersionedTransaction.deserialize(raw), { sigVerify: true, commitment: "confirmed" });
  return { error: value.err ? JSON.stringify(value.err) : null, logs: value.logs ?? [] };
}

/** The custom error `program` stopped on, read from its own line in the logs: other programs reuse the same numbers. */
export function stoppedOn(logs: string[], program: PublicKey): number | null {
  const line = logs.map((text) => text.match(new RegExp(`^Program ${program.toBase58()} failed: custom program error: 0x([0-9a-f]+)`))).find(Boolean);
  return line ? parseInt(line[1], 16) : null;
}

/** What a transaction that is in a block moved. */
export type Landed = {
  /** The slot of the block it is in. */
  slot: number;
  /** The change in what a token account holds, in the token's base units. For a wrapped-SOL account that is lamports. */
  tokenChange(account: PublicKey): bigint;
};

/**
 * Reads a transaction back from a block, asking up to `tries` times. Null if the node cannot
 * show it: a node can know a signature a moment before it can show the transaction, and a
 * node that keeps little history may already have dropped the block.
 */
export async function landed(connection: Connection, signature: string, commitment: "confirmed" | "finalized", tries: number): Promise<Landed | null> {
  for (let attempt = 0; attempt < tries; attempt++) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 250));
    const response = await connection.getTransaction(signature, { commitment, maxSupportedTransactionVersion: 0 });
    if (!response?.meta || response.meta.err) continue;
    const { meta } = response;
    const keys = response.transaction.message.staticAccountKeys;
    const amount = (balances: typeof meta.postTokenBalances, at: number) => BigInt(balances?.find((balance) => balance.accountIndex === at)?.uiTokenAmount.amount ?? "0");
    return {
      slot: response.slot,
      tokenChange(account) {
        const at = keys.findIndex((key) => key.equals(account));
        if (at < 0) throw new Error(`transaction ${signature} does not name ${account.toBase58()}`);
        return amount(meta.postTokenBalances, at) - amount(meta.preTokenBalances, at);
      },
    };
  }
  return null;
}
