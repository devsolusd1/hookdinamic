// Client for the hook program: addresses, instructions and the rulebook decoder.
// The byte layouts mirror programs/hook/src/state.rs and processor.rs.
import { PublicKey, SystemProgram, SYSVAR_INSTRUCTIONS_PUBKEY, TransactionInstruction, type AccountMeta } from "@solana/web3.js";

const EXECUTE = Buffer.from([105, 37, 101, 197, 75, 251, 102, 26]);
const INIT = Buffer.from([43, 34, 13, 49, 167, 88, 235, 235]);
const TAG = { setRules: 1, pause: 2, setAgent: 3, setCosigner: 4, setGuardian: 5 } as const;

export const RULEBOOK_LEN = 384;
export const BPS = 10_000;

/** What a refused transfer or change shows as its custom program error. */
export const REFUSAL: Record<number, string> = {
  1: "app-only window: buys need the app's signature right now",
  2: "max buy: one buy above the current cap",
  3: "max wallet: the receiving wallet would hold more than the current cap",
  10: "the signer is not the agent",
  11: "the signer is not the guardian",
  12: "the guardian has paused the agent",
  13: "the last change is too recent",
  14: "a value outside the limits fixed at launch",
  15: "the fee split does not add up to 100%",
};

/** How far the agent may go. Fixed at launch. */
export type Limits = {
  minIntervalSecs: number;
  maxGateSecs: number;
  minMaxBuyBps: number;
  minMaxWalletBps: number;
  maxTreasuryBps: number;
};

/** One rewrite of the rules. Caps are in bps of supply and 0 means no cap; the shares add up to 10,000. */
export type Change = {
  gateSecs: number;
  maxBuyBps: number;
  maxWalletBps: number;
  holdersBps: number;
  burnBps: number;
  treasuryBps: number;
};

export type Rulebook = {
  version: number;
  paused: boolean;
  mint: PublicKey;
  guardian: PublicKey;
  agent: PublicKey;
  cosigner: PublicKey;
  exempt: PublicKey;
  limits: Limits;
  /** Buys need the co-signer until this unix time. 0: anyone may buy. */
  gateUntil: number;
  maxBuyBps: number;
  maxWalletBps: number;
  holdersBps: number;
  burnBps: number;
  treasuryBps: number;
  /** How many times the rules have been rewritten. */
  epoch: bigint;
  updatedAt: number;
  note: Buffer;
};

export const rulebookAddress = (program: PublicKey, mint: PublicKey) =>
  PublicKey.findProgramAddressSync([Buffer.from("rules"), mint.toBuffer()], program)[0];

export const validationAddress = (program: PublicKey, mint: PublicKey) =>
  PublicKey.findProgramAddressSync([Buffer.from("extra-account-metas"), mint.toBuffer()], program)[0];

const u16 = (n: number) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };

const encodeLimits = (l: Limits) =>
  Buffer.concat([u32(l.minIntervalSecs), u32(l.maxGateSecs), u16(l.minMaxBuyBps), u16(l.minMaxWalletBps), u16(l.maxTreasuryBps)]);

const encodeChange = (c: Change) =>
  Buffer.concat([u32(c.gateSecs), u16(c.maxBuyBps), u16(c.maxWalletBps), u16(c.holdersBps), u16(c.burnBps), u16(c.treasuryBps)]);

/** Writes the token's rulebook. The mint signs, so this goes out before or with the pool creation. */
export function initIx(p: {
  program: PublicKey;
  payer: PublicKey;
  mint: PublicKey;
  guardian: PublicKey;
  agent: PublicKey;
  cosigner: PublicKey;
  /** An owner no rule applies to (the buyback vault). Leave out for nobody. */
  exempt?: PublicKey;
  limits: Limits;
  first: Change;
}): TransactionInstruction {
  if (p.first.gateSecs !== 0) throw new Error("the first rules cannot open a window");
  return new TransactionInstruction({
    programId: p.program,
    keys: [
      { pubkey: p.payer, isSigner: true, isWritable: true },
      { pubkey: p.mint, isSigner: true, isWritable: false },
      { pubkey: validationAddress(p.program, p.mint), isSigner: false, isWritable: true },
      { pubkey: rulebookAddress(p.program, p.mint), isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([
      INIT,
      p.guardian.toBuffer(),
      p.agent.toBuffer(),
      p.cosigner.toBuffer(),
      (p.exempt ?? PublicKey.default).toBuffer(),
      encodeLimits(p.limits),
      encodeChange(p.first),
    ]),
  });
}

/** The agent rewrites the rules. `note` is 32 bytes of its choice: the hash of the reasoning it published. */
export function setRulesIx(p: { program: PublicKey; agent: PublicKey; mint: PublicKey; change: Change; note?: Buffer }): TransactionInstruction {
  const note = p.note ?? Buffer.alloc(32);
  if (note.length !== 32) throw new Error("the note is 32 bytes");
  return new TransactionInstruction({
    programId: p.program,
    keys: [
      { pubkey: p.agent, isSigner: true, isWritable: false },
      { pubkey: rulebookAddress(p.program, p.mint), isSigner: false, isWritable: true },
    ],
    data: Buffer.concat([Buffer.from([TAG.setRules]), encodeChange(p.change), note]),
  });
}

function guardianIx(program: PublicKey, guardian: PublicKey, mint: PublicKey, tag: number, data: Buffer, extra: AccountMeta[] = []) {
  return new TransactionInstruction({
    programId: program,
    keys: [
      { pubkey: guardian, isSigner: true, isWritable: false },
      { pubkey: rulebookAddress(program, mint), isSigner: false, isWritable: true },
      ...extra,
    ],
    data: Buffer.concat([Buffer.from([tag]), data]),
  });
}

/** The guardian stops or restarts the agent. While paused the hook enforces nothing. */
export const pauseIx = (p: { program: PublicKey; guardian: PublicKey; mint: PublicKey; paused: boolean }) =>
  guardianIx(p.program, p.guardian, p.mint, TAG.pause, Buffer.from([p.paused ? 1 : 0]));

export const setAgentIx = (p: { program: PublicKey; guardian: PublicKey; mint: PublicKey; agent: PublicKey }) =>
  guardianIx(p.program, p.guardian, p.mint, TAG.setAgent, p.agent.toBuffer());

export const setCosignerIx = (p: { program: PublicKey; guardian: PublicKey; mint: PublicKey; cosigner: PublicKey }) =>
  guardianIx(p.program, p.guardian, p.mint, TAG.setCosigner, p.cosigner.toBuffer());

/** The new guardian signs too. */
export const setGuardianIx = (p: { program: PublicKey; guardian: PublicKey; mint: PublicKey; newGuardian: PublicKey }) =>
  guardianIx(p.program, p.guardian, p.mint, TAG.setGuardian, Buffer.alloc(0), [{ pubkey: p.newGuardian, isSigner: true, isWritable: false }]);

export function decodeRulebook(data: Buffer): Rulebook {
  if (data.length !== RULEBOOK_LEN) throw new Error(`a rulebook is ${RULEBOOK_LEN} bytes, got ${data.length}`);
  const key = (at: number) => new PublicKey(data.subarray(at, at + 32));
  return {
    version: data[0],
    paused: data[2] !== 0,
    mint: key(8),
    guardian: key(40),
    agent: key(72),
    cosigner: key(104),
    exempt: key(136),
    limits: {
      minIntervalSecs: data.readUInt32LE(168),
      maxGateSecs: data.readUInt32LE(172),
      minMaxBuyBps: data.readUInt16LE(176),
      minMaxWalletBps: data.readUInt16LE(178),
      maxTreasuryBps: data.readUInt16LE(180),
    },
    gateUntil: Number(data.readBigInt64LE(184)),
    maxBuyBps: data.readUInt16LE(192),
    maxWalletBps: data.readUInt16LE(194),
    holdersBps: data.readUInt16LE(196),
    burnBps: data.readUInt16LE(198),
    treasuryBps: data.readUInt16LE(200),
    epoch: data.readBigUInt64LE(208),
    updatedAt: Number(data.readBigInt64LE(216)),
    note: Buffer.from(data.subarray(224, 256)),
  };
}

/**
 * The accounts a hooked transfer of `mint` carries after the usual ones, in Token-2022's order.
 * The SDK resolves them from chain once the mint exists; this is for a buy in the same
 * transaction that creates it.
 */
export function hookTransferAccounts(program: PublicKey, mint: PublicKey): AccountMeta[] {
  return [
    { pubkey: rulebookAddress(program, mint), isSigner: false, isWritable: false },
    { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
    { pubkey: program, isSigner: false, isWritable: false },
    { pubkey: validationAddress(program, mint), isSigner: false, isWritable: false },
  ];
}

export { EXECUTE };
