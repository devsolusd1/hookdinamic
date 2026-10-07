//! The compiled hook under the real Token-2022 program, inside LiteSVM: a real mint with the
//! transfer-hook extension, real token accounts, real transfers.
//!
//! Build the program first (`cargo build-sbf` in `../hook`) and point `HOOK_SO` at the `.so`
//! if it isn't in the default target directory.
//!
//! The curve is stood in for by a token account owned by Meteora's pool authority. Nobody
//! holds that key, so the test gives the account a delegate to move tokens out of it.

use {
    agent_hook::{
        processor::{tag, INIT, METEORA_DBC, POOL_AUTHORITY, VALIDATION_LEN},
        state::{
            fact, op, Change, Condition, Limits, Refusal, Rulebook, MAX_CONDITIONS, MAX_NAMES, NAME_ENTRY_LEN, NAME_LEN, RULEBOOK_LEN, RULEBOOK_SEED,
            VALIDATION_SEED,
        },
    },
    litesvm::{types::TransactionResult, LiteSVM},
    solana_account::Account,
    solana_address::Address,
    solana_clock::Clock,
    solana_instruction::{account_meta::AccountMeta, Instruction},
    solana_instruction_error::InstructionError,
    solana_keypair::Keypair,
    solana_message::Message,
    solana_signer::Signer,
    solana_system_interface::instruction::{create_account, transfer},
    solana_transaction::Transaction,
    solana_transaction_error::TransactionError,
};

const SOL: u64 = 1_000_000_000;
/// A Friday, 08:00:00 UTC.
const T0: i64 = 1_800_000_000;
const HOUR: i64 = 3_600;
const DECIMALS: u8 = 6;
const SUPPLY: u64 = 1_000_000_000 * 1_000_000;
/// One percent of the supply, in tokens and in the millionths the rules count in.
const PCT: u64 = SUPPLY / 100;
const PCT_SHARE: u64 = 10_000;
const SPLIT: (u16, u16, u16) = (5_000, 3_000, 2_000);
const SYSTEM_PROGRAM: Address = Address::new_from_array([0; 32]);
const TOKEN_2022: Address = Address::from_str_const("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const TOKEN: Address = Address::from_str_const("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const COMPUTE_BUDGET: Address = Address::from_str_const("ComputeBudget111111111111111111111111111111");
const INSTRUCTIONS_SYSVAR: Address = Address::from_str_const("Sysvar1nstructions1111111111111111111111111");
/// The mint of wrapped SOL, which the trading fees are paid in.
const WRAPPED_SOL: Address = Address::from_str_const("So11111111111111111111111111111111111111112");
const PROGRAM: Address = Address::new_from_array([0x48; 32]);

/// A mint with the transfer-hook extension: 165 bytes of base state, the account type, then
/// the extension header (4) and its two keys (64).
const MINT_LEN: usize = 165 + 1 + 4 + 64;
/// The same mint with a pointer to its own metadata, before the metadata itself is written.
const NAMED_MINT_LEN: usize = MINT_LEN + 4 + 64;
/// The names the test token can go by. The last one is longer than the first two.
const NAMES: [(&str, &str); 3] = [("Edict", "EDICT"), ("Decree", "DECREE"), ("Until Further Notice", "NOTICE")];
/// A token account of such a mint carries a one-byte "transfer in progress" extension.
const TOKEN_ACCOUNT_LEN: usize = 165 + 1 + 4 + 1;

struct Env {
    svm: LiteSVM,
    payer: Keypair,
    mint: Keypair,
    guardian: Keypair,
    agent: Keypair,
    cosigner: Keypair,
    keeper: Keypair,
    /// The delegate that moves tokens out of the curve's vault.
    curve: Keypair,
    vault: Address,
    /// Stands in for the curve's SOL vault: a wrapped-SOL token account.
    sol_vault: Address,
    validation: Address,
    book: Address,
}

fn limits() -> Limits {
    Limits { min_interval_secs: HOUR as u32, max_rule_secs: 6 * HOUR as u32, min_treasury_bps: 1_000, max_treasury_bps: 3_000, min_rename_secs: 24 * HOUR as u32 }
}

fn when(group: u8, fact: u8, op: u8, value: u64) -> Condition {
    Condition { group, fact, op, value }
}

/// A rule in force for an hour, with the opening fee split.
fn rule(conditions: &[Condition]) -> Change {
    Change::new(HOUR as u32, SPLIT, conditions).unwrap()
}

/// An edict with no rule, standing for an hour.
fn open() -> Change {
    rule(&[])
}

/// Names the way `init` takes them: 44 bytes each, the name then the ticker, padded with zeros.
fn names(list: &[(&str, &str)]) -> Vec<u8> {
    let mut out = vec![0; list.len() * NAME_ENTRY_LEN];
    for (entry, (name, symbol)) in out.chunks_mut(NAME_ENTRY_LEN).zip(list) {
        entry[..name.len()].copy_from_slice(name.as_bytes());
        entry[NAME_LEN..NAME_LEN + symbol.len()].copy_from_slice(symbol.as_bytes());
    }
    out
}

/// A text the way Token-2022's metadata instructions take it: its length, then its bytes.
fn text(value: &str) -> Vec<u8> {
    [&(value.len() as u32).to_le_bytes()[..], value.as_bytes()].concat()
}

/// A rule no buy can meet: luck is never below zero.
fn closed() -> Change {
    rule(&[when(0, fact::LUCK, op::LT, 0)])
}

fn custom(result: TransactionResult) -> u32 {
    match result.expect_err("the transaction should have failed").err {
        TransactionError::InstructionError(_, InstructionError::Custom(code)) => code,
        other => panic!("expected a custom program error, got {other:?}"),
    }
}

fn refused(result: TransactionResult, why: Refusal) {
    assert_eq!(custom(result), why as u32, "expected {why:?}");
}

fn failed(result: TransactionResult, why: InstructionError) {
    assert_eq!(result.expect_err("the transaction should have failed").err, TransactionError::InstructionError(0, why));
}

/// Where the compiled program is.
fn hook_so() -> String {
    std::env::var("HOOK_SO").unwrap_or_else(|_| concat!(env!("CARGO_MANIFEST_DIR"), "/../hook/target/deploy/agent_hook.so").into())
}

/// Whether a transaction got as far as calling Meteora's program, read from the line the
/// runtime logs when one program calls another.
fn reached_meteora(result: &TransactionResult) -> bool {
    let logs = match result {
        Ok(meta) => &meta.logs,
        Err(failure) => &failure.meta.logs,
    };
    logs.iter().any(|line| line == "Program dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN invoke [2]")
}

impl Env {
    /// A funded payer and the program, before any token exists.
    fn new() -> Self {
        let so = hook_so();
        let mut svm = LiteSVM::new();
        svm.add_program_from_file(PROGRAM, &so)
            .unwrap_or_else(|e| panic!("build the program first; could not load {so}: {e:?}"));
        let mut clock = svm.get_sysvar::<Clock>();
        clock.unix_timestamp = T0;
        svm.set_sysvar(&clock);

        let payer = Keypair::new();
        svm.airdrop(&payer.pubkey(), 1_000 * SOL).unwrap();
        let mint = Keypair::new();
        let (validation, _) = Address::find_program_address(&[VALIDATION_SEED, mint.pubkey().as_ref()], &PROGRAM);
        let (book, _) = Address::find_program_address(&[RULEBOOK_SEED, mint.pubkey().as_ref()], &PROGRAM);
        let mut env = Env {
            svm,
            payer,
            mint,
            guardian: Keypair::new(),
            agent: Keypair::new(),
            cosigner: Keypair::new(),
            keeper: Keypair::new(),
            curve: Keypair::new(),
            vault: Address::default(),
            sol_vault: Keypair::new().pubkey(),
            validation,
            book,
        };
        env.set_curve_sol(1);
        env
    }

    /// A launched token: the whole supply in the curve's vault, no rule.
    fn launched() -> Self {
        let mut env = Self::new();
        env.create_mint();
        env.init(&limits(), SPLIT, Address::default()).unwrap();
        env.create_vault();
        env
    }

    fn send_all(&mut self, ixs: &[Instruction], signers: &[&Keypair]) -> TransactionResult {
        // Identical transactions would otherwise be rejected as duplicates.
        self.svm.expire_blockhash();
        let mut all = vec![&self.payer];
        all.extend(signers);
        let message = Message::new(ixs, Some(&self.payer.pubkey()));
        self.svm.send_transaction(Transaction::new(&all, message, self.svm.latest_blockhash()))
    }

    fn send(&mut self, ix: Instruction, signers: &[&Keypair]) -> TransactionResult {
        self.send_all(&[ix], signers)
    }

    fn warp(&mut self, seconds: i64) {
        let mut clock = self.svm.get_sysvar::<Clock>();
        clock.unix_timestamp += seconds;
        self.svm.set_sysvar(&clock);
    }

    /// Puts `sol` SOL in the stand-in for the curve's vault. Only the amount, at byte 64 of a
    /// token account, is ever read.
    fn set_curve_sol(&mut self, sol: u64) {
        let mut data = vec![0; 165];
        data[64..72].copy_from_slice(&(sol * SOL).to_le_bytes());
        let account = Account { lamports: SOL, data, owner: TOKEN, executable: false, rent_epoch: 0 };
        self.svm.set_account(self.sol_vault, account).unwrap();
    }

    fn token_ix(&self, data: Vec<u8>, accounts: Vec<AccountMeta>) -> Instruction {
        Instruction { program_id: TOKEN_2022, accounts, data }
    }

    /// A Token-2022 mint whose transfer hook is the program, with the payer as mint authority.
    fn create_mint(&mut self) {
        let mint = self.mint.insecure_clone();
        let rent = self.svm.minimum_balance_for_rent_exemption(MINT_LEN);
        let create = create_account(&self.payer.pubkey(), &mint.pubkey(), rent, MINT_LEN as u64, &TOKEN_2022);
        // TransferHookExtension (36) / Initialize (0): authority, then the hook program
        let mut hook = vec![36, 0];
        hook.extend_from_slice(&[0; 32]);
        hook.extend_from_slice(PROGRAM.as_ref());
        // InitializeMint2 (20): decimals, mint authority, no freeze authority
        let mut init = vec![20, DECIMALS];
        init.extend_from_slice(self.payer.pubkey().as_ref());
        init.push(0);
        let ixs = [
            create,
            self.token_ix(hook, vec![AccountMeta::new(mint.pubkey(), false)]),
            self.token_ix(init, vec![AccountMeta::new(mint.pubkey(), false)]),
        ];
        self.send_all(&ixs, &[&mint]).unwrap();
    }

    /// The same mint with its name on it, the way Meteora makes one: a pointer to the mint's
    /// own metadata, then the metadata, which only the rulebook's address may edit.
    fn create_named_mint(&mut self) {
        let mint = self.mint.insecure_clone();
        // Enough for the metadata as well, and for a name longer than the first.
        let rent = self.svm.minimum_balance_for_rent_exemption(NAMED_MINT_LEN + 400);
        let create = create_account(&self.payer.pubkey(), &mint.pubkey(), rent, NAMED_MINT_LEN as u64, &TOKEN_2022);
        let mut hook = vec![36, 0];
        hook.extend_from_slice(&[0; 32]);
        hook.extend_from_slice(PROGRAM.as_ref());
        // MetadataPointerExtension (39) / Initialize (0): authority, then where the metadata is
        let mut pointer = vec![39, 0];
        pointer.extend_from_slice(&[0; 32]);
        pointer.extend_from_slice(mint.pubkey().as_ref());
        let mut init = vec![20, DECIMALS];
        init.extend_from_slice(self.payer.pubkey().as_ref());
        init.push(0);
        // the metadata interface's "initialize": name, ticker, address of the rest
        let mut metadata = vec![210, 225, 30, 162, 88, 184, 77, 141];
        for value in [NAMES[0].0, NAMES[0].1, "https://example.com/edict.json"] {
            metadata.extend_from_slice(&text(value));
        }
        let metadata_accounts = vec![
            AccountMeta::new(mint.pubkey(), false),
            AccountMeta::new_readonly(self.book, false),
            AccountMeta::new_readonly(mint.pubkey(), false),
            AccountMeta::new_readonly(self.payer.pubkey(), true),
        ];
        let ixs = [
            create,
            self.token_ix(hook, vec![AccountMeta::new(mint.pubkey(), false)]),
            self.token_ix(pointer, vec![AccountMeta::new(mint.pubkey(), false)]),
            self.token_ix(init, vec![AccountMeta::new(mint.pubkey(), false)]),
            self.token_ix(metadata, metadata_accounts),
        ];
        self.send_all(&ixs, &[&mint]).unwrap();
    }

    /// A launched token that carries its name, with the rulebook as the only editor of it.
    fn launched_with_a_name() -> Self {
        let mut env = Self::new();
        env.create_named_mint();
        env.init(&limits(), SPLIT, Address::default()).unwrap();
        env.create_vault();
        env
    }

    /// Who may edit the mint's metadata, the name on it and the ticker, read from the mint.
    fn token_name(&self) -> (Address, String, String) {
        let data = self.svm.get_account(&self.mint.pubkey()).unwrap().data;
        // Extensions follow the account type at byte 165: a type and a length, two bytes each, then the value.
        let mut at = 166;
        while at + 4 <= data.len() {
            let kind = u16::from_le_bytes([data[at], data[at + 1]]);
            let len = u16::from_le_bytes([data[at + 2], data[at + 3]]) as usize;
            let value = &data[at + 4..at + 4 + len];
            // TokenMetadata (19): update authority, mint, then name, ticker and address as texts
            if kind == 19 {
                let read = |from: usize| {
                    let len = u32::from_le_bytes(value[from..from + 4].try_into().unwrap()) as usize;
                    (String::from_utf8(value[from + 4..from + 4 + len].to_vec()).unwrap(), from + 4 + len)
                };
                let (name, next) = read(64);
                let (symbol, _) = read(next);
                return (Address::new_from_array(value[..32].try_into().unwrap()), name, symbol);
            }
            at += 4 + len;
        }
        panic!("the mint carries no metadata");
    }

    fn init_ix(&self, limits: &Limits, split: (u16, u16, u16), exempt: Address) -> Instruction {
        self.init_ix_named(limits, split, exempt, &names(&NAMES))
    }

    fn init_ix_named(&self, limits: &Limits, split: (u16, u16, u16), exempt: Address, names: &[u8]) -> Instruction {
        let mut data = INIT.to_vec();
        for key in [self.guardian.pubkey(), self.agent.pubkey(), self.cosigner.pubkey(), exempt, self.sol_vault, self.keeper.pubkey()] {
            data.extend_from_slice(key.as_ref());
        }
        data.extend_from_slice(&limits.encode());
        for share in [split.0, split.1, split.2] {
            data.extend_from_slice(&share.to_le_bytes());
        }
        data.extend_from_slice(names);
        Instruction {
            program_id: PROGRAM,
            accounts: vec![
                AccountMeta::new(self.payer.pubkey(), true),
                AccountMeta::new_readonly(self.mint.pubkey(), true),
                AccountMeta::new(self.validation, false),
                AccountMeta::new(self.book, false),
                AccountMeta::new_readonly(SYSTEM_PROGRAM, false),
            ],
            data,
        }
    }

    fn init(&mut self, limits: &Limits, split: (u16, u16, u16), exempt: Address) -> TransactionResult {
        let ix = self.init_ix(limits, split, exempt);
        let mint = self.mint.insecure_clone();
        self.send(ix, &[&mint])
    }

    /// A new token account of the mint, owned by `owner`.
    fn token_account(&mut self, owner: &Address) -> Address {
        let account = Keypair::new();
        let rent = self.svm.minimum_balance_for_rent_exemption(TOKEN_ACCOUNT_LEN);
        let create = create_account(&self.payer.pubkey(), &account.pubkey(), rent, TOKEN_ACCOUNT_LEN as u64, &TOKEN_2022);
        // InitializeAccount3 (18): owner
        let mut init = vec![18];
        init.extend_from_slice(owner.as_ref());
        let accounts = vec![AccountMeta::new(account.pubkey(), false), AccountMeta::new_readonly(self.mint.pubkey(), false)];
        let ixs = [create, self.token_ix(init, accounts)];
        self.send_all(&ixs, &[&account]).unwrap();
        account.pubkey()
    }

    /// A wallet and its token account.
    fn holder(&mut self) -> (Keypair, Address) {
        let wallet = Keypair::new();
        let account = self.token_account(&wallet.pubkey());
        (wallet, account)
    }

    /// The curve's vault: owned by Meteora's pool authority, holding the whole supply, with
    /// `curve` as a delegate so the test can move tokens out of it.
    fn create_vault(&mut self) {
        self.vault = self.token_account(&POOL_AUTHORITY);
        // MintTo (7): amount
        let mut mint_to = vec![7];
        mint_to.extend_from_slice(&SUPPLY.to_le_bytes());
        let accounts = vec![
            AccountMeta::new(self.mint.pubkey(), false),
            AccountMeta::new(self.vault, false),
            AccountMeta::new_readonly(self.payer.pubkey(), true),
        ];
        self.send(self.token_ix(mint_to, accounts), &[]).unwrap();

        // token account layout: delegate (an option: 4-byte tag, key) at 72, delegated amount at 121
        let mut account = self.svm.get_account(&self.vault).unwrap();
        account.data[72..76].copy_from_slice(&1u32.to_le_bytes());
        account.data[76..108].copy_from_slice(self.curve.pubkey().as_ref());
        account.data[121..129].copy_from_slice(&u64::MAX.to_le_bytes());
        self.svm.set_account(self.vault, account).unwrap();
    }

    /// TransferChecked (12) with the accounts a hooked transfer needs after the usual four:
    /// the hook's extra accounts, the hook program, the validation account.
    fn transfer_ix(&self, from: Address, to: Address, authority: Address, amount: u64) -> Instruction {
        let mut data = vec![12];
        data.extend_from_slice(&amount.to_le_bytes());
        data.push(DECIMALS);
        let accounts = vec![
            AccountMeta::new(from, false),
            AccountMeta::new_readonly(self.mint.pubkey(), false),
            AccountMeta::new(to, false),
            AccountMeta::new_readonly(authority, true),
            AccountMeta::new_readonly(self.book, false),
            AccountMeta::new_readonly(INSTRUCTIONS_SYSVAR, false),
            AccountMeta::new_readonly(self.sol_vault, false),
            AccountMeta::new_readonly(PROGRAM, false),
            AccountMeta::new_readonly(self.validation, false),
        ];
        self.token_ix(data, accounts)
    }

    /// Tokens leave the curve for `to`.
    fn buy(&mut self, to: Address, amount: u64) -> TransactionResult {
        let curve = self.curve.insecure_clone();
        self.send(self.transfer_ix(self.vault, to, curve.pubkey(), amount), &[&curve])
    }

    /// The same buy the way the app sends it: its own key signs another top-level instruction
    /// of the transaction, not the swap.
    fn buy_through_app(&mut self, signer: &Keypair, to: Address, amount: u64) -> TransactionResult {
        let curve = self.curve.insecure_clone();
        self.svm.airdrop(&signer.pubkey(), SOL).unwrap();
        let ixs = [
            transfer(&signer.pubkey(), &self.payer.pubkey(), 1),
            self.transfer_ix(self.vault, to, curve.pubkey(), amount),
        ];
        self.send_all(&ixs, &[signer, &curve])
    }

    /// A buy in a transaction that sets a priority fee, in micro-lamports per compute unit.
    fn buy_with_priority(&mut self, to: Address, amount: u64, price: u64) -> TransactionResult {
        let curve = self.curve.insecure_clone();
        // ComputeBudget's SetComputeUnitPrice (3): the price
        let mut data = vec![3];
        data.extend_from_slice(&price.to_le_bytes());
        let ixs = [
            Instruction { program_id: COMPUTE_BUDGET, accounts: vec![], data },
            self.transfer_ix(self.vault, to, curve.pubkey(), amount),
        ];
        self.send_all(&ixs, &[&curve])
    }

    /// `owner` sends from its token account: into the vault it is a sell, anywhere else a send.
    fn send_tokens(&mut self, owner: &Keypair, from: Address, to: Address, amount: u64) -> TransactionResult {
        self.send(self.transfer_ix(from, to, owner.pubkey(), amount), &[owner])
    }

    fn set_rules_ix(&self, signer: &Keypair, change: &Change, note: [u8; 32]) -> Instruction {
        let (bytes, len) = change.encode();
        let mut data = vec![tag::SET_RULES];
        data.extend_from_slice(&bytes[..len]);
        data.extend_from_slice(&note);
        let accounts = vec![AccountMeta::new_readonly(signer.pubkey(), true), AccountMeta::new(self.book, false)];
        Instruction { program_id: PROGRAM, accounts, data }
    }

    fn set_rules_as(&mut self, signer: &Keypair, change: &Change, note: [u8; 32]) -> TransactionResult {
        let ix = self.set_rules_ix(signer, change, note);
        self.send(ix, &[signer])
    }

    fn set_name_ix(&self, signer: &Keypair, index: u8) -> Instruction {
        let accounts = vec![
            AccountMeta::new_readonly(signer.pubkey(), true),
            AccountMeta::new(self.book, false),
            AccountMeta::new(self.mint.pubkey(), false),
            AccountMeta::new_readonly(TOKEN_2022, false),
        ];
        Instruction { program_id: PROGRAM, accounts, data: vec![tag::SET_NAME, index] }
    }

    /// The agent issues an edict with no rule and, in the same transaction, takes name `index`.
    fn edict_with_name(&mut self, index: u8) -> TransactionResult {
        let agent = self.agent.insecure_clone();
        let ixs = [self.set_rules_ix(&agent, &open(), [0; 32]), self.set_name_ix(&agent, index)];
        self.send_all(&ixs, &[&agent])
    }

    fn set_rules_raw(&mut self, signer: &Keypair, data: Vec<u8>) -> TransactionResult {
        let accounts = vec![AccountMeta::new_readonly(signer.pubkey(), true), AccountMeta::new(self.book, false)];
        self.send(Instruction { program_id: PROGRAM, accounts, data }, &[signer])
    }

    fn set_rules(&mut self, change: &Change) -> TransactionResult {
        let agent = self.agent.insecure_clone();
        self.set_rules_as(&agent, change, [0; 32])
    }

    fn guardian_ix(&mut self, signer: &Keypair, tag: u8, data: &[u8]) -> TransactionResult {
        let mut all = vec![tag];
        all.extend_from_slice(data);
        let accounts = vec![AccountMeta::new_readonly(signer.pubkey(), true), AccountMeta::new(self.book, false)];
        self.send(Instruction { program_id: PROGRAM, accounts, data: all }, &[signer])
    }

    fn pause(&mut self, paused: bool) -> TransactionResult {
        let guardian = self.guardian.insecure_clone();
        self.guardian_ix(&guardian, tag::PAUSE, &[paused as u8])
    }

    /// A wrapped-SOL token account owned by `owner`, written straight into the ledger. Only
    /// who owns it is ever read here.
    fn sol_account(&mut self, owner: &Address) -> Address {
        let address = Keypair::new().pubkey();
        let mut data = vec![0; 165];
        data[..32].copy_from_slice(WRAPPED_SOL.as_ref());
        data[32..64].copy_from_slice(owner.as_ref());
        // token account layout: state at 108, 1 for an account in use
        data[108] = 1;
        self.svm.set_account(address, Account { lamports: SOL, data, owner: TOKEN, executable: false, rent_epoch: 0 }).unwrap();
        address
    }

    /// Puts a program at Meteora's address, so that a claim that passes every check has
    /// something to call. It is this program's own code: it knows nothing of Meteora's
    /// instruction and answers that the data is not an instruction of its own.
    fn stand_in_for_meteora(&mut self) {
        self.svm.add_program_from_file(METEORA_DBC, hook_so()).unwrap();
    }

    /// A claim of the fees the way a keeper sends it: the keeper, Meteora's fourteen accounts
    /// in Meteora's order, then the five a transfer of the token carries for the hook. The
    /// curve's config, its pool and Meteora's event authority are made-up addresses: this
    /// program passes them on without reading them.
    fn claim_ix(&self, keeper: Address, token_account: Address, sol_account: Address) -> Instruction {
        let made_up = |byte: u8| Address::new_from_array([byte; 32]);
        let mut data = vec![tag::CLAIM_FEES];
        data.extend_from_slice(&0u64.to_le_bytes());
        data.extend_from_slice(&u64::MAX.to_le_bytes());
        let accounts = vec![
            AccountMeta::new_readonly(keeper, true),
            AccountMeta::new_readonly(POOL_AUTHORITY, false),
            AccountMeta::new_readonly(made_up(1), false),
            AccountMeta::new(made_up(2), false),
            AccountMeta::new(token_account, false),
            AccountMeta::new(sol_account, false),
            AccountMeta::new(self.vault, false),
            AccountMeta::new(self.sol_vault, false),
            AccountMeta::new_readonly(self.mint.pubkey(), false),
            AccountMeta::new_readonly(WRAPPED_SOL, false),
            AccountMeta::new_readonly(self.book, false),
            AccountMeta::new_readonly(TOKEN_2022, false),
            AccountMeta::new_readonly(TOKEN, false),
            AccountMeta::new_readonly(made_up(3), false),
            AccountMeta::new_readonly(METEORA_DBC, false),
            AccountMeta::new_readonly(self.book, false),
            AccountMeta::new_readonly(INSTRUCTIONS_SYSVAR, false),
            AccountMeta::new_readonly(self.sol_vault, false),
            AccountMeta::new_readonly(PROGRAM, false),
            AccountMeta::new_readonly(self.validation, false),
        ];
        Instruction { program_id: PROGRAM, accounts, data }
    }

    fn balance(&self, token_account: &Address) -> u64 {
        let data = self.svm.get_account(token_account).unwrap().data;
        u64::from_le_bytes(data[64..72].try_into().unwrap())
    }

    fn book(&self) -> Vec<u8> {
        self.svm.get_account(&self.book).unwrap().data
    }
}

#[test]
fn init_writes_the_rulebook_and_the_list_token_2022_reads() {
    let env = Env::launched();
    let data = env.book();
    assert_eq!(data.len(), RULEBOOK_LEN);
    let book = Rulebook::cast(&data).unwrap();
    assert_eq!(book.mint, env.mint.pubkey().to_bytes());
    assert_eq!(book.guardian, env.guardian.pubkey().to_bytes());
    assert_eq!(book.agent, env.agent.pubkey().to_bytes());
    assert_eq!(book.cosigner, env.cosigner.pubkey().to_bytes());
    assert_eq!(book.curve_vault, env.sol_vault.to_bytes());
    assert_eq!(book.keeper, env.keeper.pubkey().to_bytes());
    assert_eq!(data[864..896], env.keeper.pubkey().to_bytes(), "the keeper, where the site reads it");
    assert_eq!(book.limits(), limits());
    // the treasury's cap and its floor, where the site and the agent read them
    assert_eq!((&data[208..210], &data[214..216]), (&3_000u16.to_le_bytes()[..], &1_000u16.to_le_bytes()[..]));
    assert_eq!((book.split(), book.rule().1, book.rule_until()), (SPLIT, 0, 0));
    assert_eq!((book.epoch(), book.updated_at(), book.paused), (0, 0, 0));
    assert_eq!((book.name, book.name_count as usize, book.renamed_at()), (0, NAMES.len(), T0));
    for (i, (name, symbol)) in NAMES.iter().enumerate() {
        assert_eq!(book.name_at(i as u8), Some((name.as_bytes(), symbol.as_bytes())));
    }

    let list = env.svm.get_account(&env.validation).unwrap();
    assert_eq!((list.owner, list.data.len()), (PROGRAM, VALIDATION_LEN));
    assert_eq!(list.data[12..16], 3u32.to_le_bytes());
    assert_eq!(list.data[17..49], env.book.to_bytes());
    assert_eq!(list.data[52..84], INSTRUCTIONS_SYSVAR.to_bytes());
    assert_eq!(list.data[87..119], env.sol_vault.to_bytes());
}

#[test]
fn init_needs_the_mint_to_sign_and_happens_once() {
    let mut env = Env::new();
    env.create_mint();

    // without the mint's signature anyone could write a token's rulebook before it launches
    let mut ix = env.init_ix(&limits(), SPLIT, Address::default());
    ix.accounts[1] = AccountMeta::new_readonly(env.mint.pubkey(), false);
    assert_eq!(env.send(ix, &[]).unwrap_err().err, TransactionError::InstructionError(0, InstructionError::MissingRequiredSignature));

    // an account that is not the token's own rulebook address
    let mut ix = env.init_ix(&limits(), SPLIT, Address::default());
    ix.accounts[3] = AccountMeta::new(Keypair::new().pubkey(), false);
    let mint = env.mint.insecure_clone();
    assert_eq!(env.send(ix, &[&mint]).unwrap_err().err, TransactionError::InstructionError(0, InstructionError::InvalidSeeds));

    // an opening fee split that is not one, or that gives the treasury more than its cap or
    // less than its floor
    refused(env.init(&limits(), (5_001, 3_000, 2_000), Address::default()), Refusal::BadSplit);
    refused(env.init(&limits(), (3_999, 3_000, 3_001), Address::default()), Refusal::OutsideLimits);
    refused(env.init(&limits(), (6_001, 3_000, 999), Address::default()), Refusal::OutsideLimits);
    // limits that make no sense: a cap above the whole, a floor above the cap
    let senseless = TransactionError::InstructionError(0, InstructionError::InvalidInstructionData);
    assert_eq!(env.init(&Limits { max_treasury_bps: 10_001, ..limits() }, SPLIT, Address::default()).unwrap_err().err, senseless);
    assert_eq!(env.init(&Limits { min_treasury_bps: 3_001, ..limits() }, (4_000, 3_000, 3_000), Address::default()).unwrap_err().err, senseless);

    // names: at least the one it launches with, eight at most, each with a ticker, in readable text
    let mint = env.mint.insecure_clone();
    for bad in [
        vec![],
        names(&[("Edict", "EDICT"); MAX_NAMES + 1]),
        names(&[("Edict", "")]),
        names(&[("", "EDICT")]),
        names(&[("Ed\nict", "EDICT")]),
        names(&NAMES)[..NAME_ENTRY_LEN + 7].to_vec(),
    ] {
        let ix = env.init_ix_named(&limits(), SPLIT, Address::default(), &bad);
        refused(env.send(ix, &[&mint]), Refusal::BadName);
    }

    env.init(&limits(), SPLIT, Address::default()).unwrap();
    assert_eq!(
        env.init(&limits(), SPLIT, Address::default()).unwrap_err().err,
        TransactionError::InstructionError(0, InstructionError::AccountAlreadyInitialized)
    );
}

#[test]
fn with_no_rule_every_transfer_goes_through() {
    let mut env = Env::launched();
    let ((alice, a), (bob, b)) = (env.holder(), env.holder());

    env.buy(a, 30 * PCT).unwrap();
    env.send_tokens(&alice, a, b, 10 * PCT).unwrap();
    env.send_tokens(&bob, b, env.vault, 4 * PCT).unwrap();
    assert_eq!((env.balance(&a), env.balance(&b), env.balance(&env.vault)), (20 * PCT, 6 * PCT, 74 * PCT));
}

#[test]
fn a_transfer_without_the_hook_accounts_does_not_go_through() {
    let mut env = Env::launched();
    let (_, a) = env.holder();
    let curve = env.curve.insecure_clone();
    let mut ix = env.transfer_ix(env.vault, a, curve.pubkey(), PCT);
    ix.accounts.truncate(4);
    assert!(env.send(ix, &[&curve]).is_err(), "Token-2022 itself insists on the hook");
}

#[test]
fn a_rule_can_cap_a_buy_and_a_wallet() {
    let mut env = Env::launched();
    let (_, a) = env.holder();
    // one group, both conditions: no buy above 1%, no account above 2%
    env.set_rules(&rule(&[when(0, fact::SIZE, op::LE, PCT_SHARE), when(0, fact::HELD_AFTER, op::LE, 2 * PCT_SHARE)])).unwrap();

    refused(env.buy(a, PCT + PCT / 100), Refusal::NotAllowed);
    env.buy(a, PCT).unwrap();
    env.buy(a, PCT).unwrap();
    refused(env.buy(a, PCT / 2), Refusal::NotAllowed);
    assert_eq!(env.balance(&a), 2 * PCT);
}

#[test]
fn only_buys_are_judged() {
    let mut env = Env::launched();
    let ((alice, a), (bob, b)) = (env.holder(), env.holder());
    env.buy(a, 10 * PCT).unwrap();

    env.set_rules(&closed()).unwrap();
    refused(env.buy(a, 1), Refusal::NotAllowed);
    refused(env.buy(b, 1), Refusal::NotAllowed);
    // a holder moves tokens and sells them whatever the rule says
    env.send_tokens(&alice, a, b, 4 * PCT).unwrap();
    env.send_tokens(&bob, b, env.vault, 4 * PCT).unwrap();
    env.send_tokens(&alice, a, env.vault, 6 * PCT).unwrap();
    assert_eq!((env.balance(&a), env.balance(&b), env.balance(&env.vault)), (0, 0, SUPPLY));
}

#[test]
fn a_rule_about_the_app_wants_its_signature() {
    let mut env = Env::launched();
    let (_, a) = env.holder();
    env.set_rules(&rule(&[when(0, fact::VIA_APP, op::EQ, 1)])).unwrap();
    let cosigner = env.cosigner.insecure_clone();

    refused(env.buy(a, PCT), Refusal::NotAllowed);
    // somebody else's signature next to the swap is not the app's
    refused(env.buy_through_app(&Keypair::new(), a, PCT), Refusal::NotAllowed);
    env.buy_through_app(&cosigner, a, PCT).unwrap();
    assert_eq!(env.balance(&a), PCT);
}

#[test]
fn groups_are_alternatives() {
    let mut env = Env::launched();
    let (_, a) = env.holder();
    // through the app at any size, or from anywhere up to a tenth of a percent
    env.set_rules(&rule(&[when(0, fact::VIA_APP, op::EQ, 1), when(1, fact::SIZE, op::LE, PCT_SHARE / 10)])).unwrap();
    let cosigner = env.cosigner.insecure_clone();

    env.buy(a, PCT / 10).unwrap();
    refused(env.buy(a, PCT / 5), Refusal::NotAllowed);
    env.buy_through_app(&cosigner, a, 5 * PCT).unwrap();
}

#[test]
fn a_rule_can_keep_out_whoever_already_holds() {
    let mut env = Env::launched();
    let ((_, a), (_, b)) = (env.holder(), env.holder());
    env.set_rules(&rule(&[when(0, fact::HELD_BEFORE, op::EQ, 0)])).unwrap();

    env.buy(a, PCT).unwrap();
    refused(env.buy(a, PCT), Refusal::NotAllowed);
    env.buy(b, 3 * PCT).unwrap();
}

#[test]
fn a_rule_can_read_the_clock() {
    let mut env = Env::launched();
    let (_, a) = env.holder();

    // T0 is 08:00 on a Friday
    env.set_rules(&rule(&[when(0, fact::WEEKDAY, op::EQ, 5), when(0, fact::HOUR, op::EQ, 8), when(0, fact::MINUTE, op::MOD_EQ, 2 << 32)])).unwrap();
    env.buy(a, PCT).unwrap();
    env.warp(60); // 08:01, an odd minute
    refused(env.buy(a, PCT), Refusal::NotAllowed);
    env.warp(60); // 08:02
    env.buy(a, PCT).unwrap();

    // closed for its first ten minutes, then open
    env.warp(HOUR);
    env.set_rules(&rule(&[when(0, fact::ELAPSED, op::GE, 600)])).unwrap();
    refused(env.buy(a, PCT), Refusal::NotAllowed);
    env.warp(599);
    refused(env.buy(a, PCT), Refusal::NotAllowed);
    env.warp(1);
    env.buy(a, PCT).unwrap();
}

#[test]
fn a_rule_can_read_the_priority_fee() {
    let mut env = Env::launched();
    let (_, a) = env.holder();
    env.set_rules(&rule(&[when(0, fact::PRIORITY, op::LE, 1_000)])).unwrap();

    refused(env.buy_with_priority(a, PCT, 1_001), Refusal::NotAllowed);
    env.buy_with_priority(a, PCT, 1_000).unwrap();
    env.buy(a, PCT).unwrap(); // no priority fee set at all
}

#[test]
fn a_rule_can_read_the_sol_in_the_curve() {
    let mut env = Env::launched();
    let (_, a) = env.holder();
    // big buys only once the curve holds 5 SOL; small ones always
    env.set_rules(&rule(&[when(0, fact::CURVE_SOL, op::GE, 5_000), when(1, fact::SIZE, op::LE, PCT_SHARE / 10)])).unwrap();

    refused(env.buy(a, PCT), Refusal::NotAllowed);
    env.buy(a, PCT / 10).unwrap();
    env.set_curve_sol(5);
    env.buy(a, PCT).unwrap();

    // any other account in the vault's place is turned away
    let curve = env.curve.insecure_clone();
    let mut ix = env.transfer_ix(env.vault, a, curve.pubkey(), PCT);
    ix.accounts[6] = AccountMeta::new_readonly(Keypair::new().pubkey(), false);
    assert!(env.send(ix, &[&curve]).is_err());
}

#[test]
fn luck_depends_on_the_slot_and_the_account() {
    let mut env = Env::launched();
    let (_, a) = env.holder();
    env.set_rules(&rule(&[when(0, fact::LUCK, op::LT, 50)])).unwrap();

    let seed = u64::from_le_bytes(a.to_bytes()[..8].try_into().unwrap());
    for _ in 0..2 {
        let slot = env.svm.get_sysvar::<Clock>().slot;
        let lucky = slot.wrapping_add(seed) % 100 < 50;
        let result = env.buy(a, PCT);
        if lucky {
            result.unwrap();
        } else {
            refused(result, Refusal::NotAllowed);
        }
        // fifty slots on, the same account's luck has flipped
        let mut clock = env.svm.get_sysvar::<Clock>();
        clock.slot += 50;
        env.svm.set_sysvar(&clock);
    }
}

#[test]
fn a_rule_lapses_and_buying_reopens_by_itself() {
    let mut env = Env::launched();
    let (_, a) = env.holder();
    env.set_rules(&Change::new(600, SPLIT, closed().conditions()).unwrap()).unwrap();

    refused(env.buy(a, PCT), Refusal::NotAllowed);
    env.warp(599);
    refused(env.buy(a, PCT), Refusal::NotAllowed);
    env.warp(1);
    env.buy(a, PCT).unwrap(); // nobody had to lift it
}

#[test]
fn the_agent_cannot_leave_the_limits() {
    let mut env = Env::launched();
    let cap = [when(0, fact::SIZE, op::LE, PCT_SHARE)];
    // an edict has a term, within the limit, whether it carries a rule or not
    refused(env.set_rules(&Change::new(6 * HOUR as u32 + 1, SPLIT, &cap).unwrap()), Refusal::OutsideLimits);
    refused(env.set_rules(&Change::new(0, SPLIT, &cap).unwrap()), Refusal::OutsideLimits);
    refused(env.set_rules(&Change::new(0, SPLIT, &[]).unwrap()), Refusal::OutsideLimits);
    // rules the hook could not evaluate
    refused(env.set_rules(&rule(&[when(4, fact::SIZE, op::LE, 1)])), Refusal::BadRule);
    refused(env.set_rules(&rule(&[when(0, fact::COUNT as u8, op::LE, 1)])), Refusal::BadRule);
    refused(env.set_rules(&rule(&[when(0, fact::SIZE, 7, 1)])), Refusal::BadRule);
    refused(env.set_rules(&rule(&[when(0, fact::MINUTE, op::MOD_EQ, 1)])), Refusal::BadRule);
    // more conditions than a rule may hold
    let agent = env.agent.insecure_clone();
    let (mut bytes, _) = rule(&[cap[0]; MAX_CONDITIONS]).encode();
    bytes[10] = MAX_CONDITIONS as u8 + 1;
    let mut data = vec![tag::SET_RULES];
    data.extend_from_slice(&bytes);
    data.extend_from_slice(&[0; 12 + 32]);
    refused(env.set_rules_raw(&agent, data), Refusal::BadRule);
    // the fee split: it adds up, and the treasury gets no more than its cap and no less than its floor
    refused(env.set_rules(&Change::new(HOUR as u32, (6_999, 0, 3_001), &[]).unwrap()), Refusal::OutsideLimits);
    refused(env.set_rules(&Change::new(HOUR as u32, (9_001, 0, 999), &[]).unwrap()), Refusal::OutsideLimits);
    refused(env.set_rules(&Change::new(HOUR as u32, (5_000, 5_000, 0), &[]).unwrap()), Refusal::OutsideLimits);
    refused(env.set_rules(&Change::new(HOUR as u32, (5_001, 3_000, 2_000), &[]).unwrap()), Refusal::BadSplit);
    assert_eq!(Rulebook::cast(&env.book()).unwrap().epoch(), 0, "nothing was written");

    let full = [when(3, fact::LUCK, op::LT, 99); MAX_CONDITIONS];
    let change = Change::new(6 * HOUR as u32, (7_000, 0, 3_000), &full).unwrap();
    env.set_rules_as(&agent, &change, [7; 32]).unwrap();
    let data = env.book();
    let book = Rulebook::cast(&data).unwrap();
    assert_eq!((book.rule(), book.rule_until(), book.split()), ((full, MAX_CONDITIONS), T0 + 6 * HOUR, (7_000, 0, 3_000)));
    assert_eq!((book.epoch(), book.updated_at(), book.note), (1, T0, [7; 32]));

    // one change per interval
    env.warp(HOUR - 1);
    refused(env.set_rules(&open()), Refusal::TooSoon);
    env.warp(1);
    env.set_rules(&open()).unwrap();
    let data = env.book();
    let book = Rulebook::cast(&data).unwrap();
    // no rule, and a term of its own: an hour from when it was written
    assert_eq!((book.epoch(), book.rule().1, book.rule_until()), (2, 0, T0 + 2 * HOUR));
}

#[test]
fn the_treasury_is_never_left_under_its_floor() {
    let mut env = Env::launched();
    let split = |env: &Env| {
        let data = env.book();
        let book = Rulebook::cast(&data).unwrap();
        (book.epoch(), book.split())
    };
    // one bps under the floor is refused and nothing is written
    refused(env.set_rules(&Change::new(HOUR as u32, (6_001, 3_000, 999), &[]).unwrap()), Refusal::OutsideLimits);
    assert_eq!(split(&env), (0, SPLIT));
    // at the floor it passes
    env.set_rules(&Change::new(HOUR as u32, (6_000, 3_000, 1_000), &[]).unwrap()).unwrap();
    assert_eq!(split(&env), (1, (6_000, 3_000, 1_000)));
    // and the floor holds for an edict that carries a rule as much as for one that does not
    env.warp(HOUR);
    refused(env.set_rules(&Change::new(HOUR as u32, (10_000, 0, 0), closed().conditions()).unwrap()), Refusal::OutsideLimits);
    assert_eq!(split(&env), (1, (6_000, 3_000, 1_000)));

    // a token whose floor meets its cap: the treasury's share is fixed, the rest is the agent's to move
    let mut env = Env::new();
    env.create_mint();
    let fixed = Limits { min_treasury_bps: 4_000, max_treasury_bps: 4_000, ..limits() };
    refused(env.init(&fixed, (3_000, 3_001, 3_999), Address::default()), Refusal::OutsideLimits);
    refused(env.init(&fixed, (3_000, 2_999, 4_001), Address::default()), Refusal::OutsideLimits);
    env.init(&fixed, (3_000, 3_000, 4_000), Address::default()).unwrap();
    assert_eq!(Rulebook::cast(&env.book()).unwrap().limits(), fixed);
    refused(env.set_rules(&Change::new(HOUR as u32, (3_001, 3_000, 3_999), &[]).unwrap()), Refusal::OutsideLimits);
    refused(env.set_rules(&Change::new(HOUR as u32, (2_999, 3_000, 4_001), &[]).unwrap()), Refusal::OutsideLimits);
    env.set_rules(&Change::new(HOUR as u32, (1_800, 4_200, 4_000), &[]).unwrap()).unwrap();
    assert_eq!(split(&env), (1, (1_800, 4_200, 4_000)));
}

#[test]
fn only_the_agent_writes_rules() {
    let mut env = Env::launched();
    let guardian = env.guardian.insecure_clone();
    refused(env.set_rules_as(&guardian, &open(), [0; 32]), Refusal::NotAgent);
    refused(env.set_rules_as(&Keypair::new(), &open(), [0; 32]), Refusal::NotAgent);

    // the agent's key without its signature
    let (bytes, len) = open().encode();
    let mut data = vec![tag::SET_RULES];
    data.extend_from_slice(&bytes[..len]);
    data.extend_from_slice(&[0; 32]);
    let accounts = vec![AccountMeta::new_readonly(env.agent.pubkey(), false), AccountMeta::new(env.book, false)];
    let result = env.send(Instruction { program_id: PROGRAM, accounts, data }, &[]);
    assert_eq!(result.unwrap_err().err, TransactionError::InstructionError(0, InstructionError::MissingRequiredSignature));
}

#[test]
fn the_guardian_can_pause_and_replace_but_only_that() {
    let mut env = Env::launched();
    let (_, a) = env.holder();
    let (guardian, agent) = (env.guardian.insecure_clone(), env.agent.insecure_clone());
    env.set_rules(&Change::new(6 * HOUR as u32, SPLIT, &[when(0, fact::VIA_APP, op::EQ, 1)]).unwrap()).unwrap();
    refused(env.buy(a, PCT), Refusal::NotAllowed);

    // a pause opens the token up and stops the agent
    refused(env.guardian_ix(&agent, tag::PAUSE, &[1]), Refusal::NotGuardian);
    env.pause(true).unwrap();
    env.buy(a, 5 * PCT).unwrap();
    env.warp(HOUR);
    refused(env.set_rules(&open()), Refusal::Paused);
    env.pause(false).unwrap();
    refused(env.buy(a, PCT), Refusal::NotAllowed);

    // a new app key
    let new_cosigner = Keypair::new();
    let old_cosigner = env.cosigner.insecure_clone();
    refused(env.guardian_ix(&agent, tag::SET_COSIGNER, new_cosigner.pubkey().as_ref()), Refusal::NotGuardian);
    env.guardian_ix(&guardian, tag::SET_COSIGNER, new_cosigner.pubkey().as_ref()).unwrap();
    refused(env.buy_through_app(&old_cosigner, a, PCT), Refusal::NotAllowed);
    env.buy_through_app(&new_cosigner, a, PCT).unwrap();

    // a new agent
    let new_agent = Keypair::new();
    env.guardian_ix(&guardian, tag::SET_AGENT, new_agent.pubkey().as_ref()).unwrap();
    refused(env.set_rules(&open()), Refusal::NotAgent);
    env.set_rules_as(&new_agent, &open(), [0; 32]).unwrap();
    env.buy(a, PCT).unwrap();

    // a new guardian, who has to sign as well
    let new_guardian = Keypair::new();
    let handover = |signed: bool| Instruction {
        program_id: PROGRAM,
        accounts: vec![
            AccountMeta::new_readonly(guardian.pubkey(), true),
            AccountMeta::new(env.book, false),
            AccountMeta::new_readonly(new_guardian.pubkey(), signed),
        ],
        data: vec![tag::SET_GUARDIAN],
    };
    let (unsigned, signed) = (handover(false), handover(true));
    assert!(env.send(unsigned, &[&guardian]).is_err());
    env.send(signed, &[&guardian, &new_guardian]).unwrap();
    refused(env.pause(true), Refusal::NotGuardian);
    env.guardian_ix(&new_guardian, tag::PAUSE, &[1]).unwrap();
}

#[test]
fn only_the_guardian_replaces_the_keeper() {
    let mut env = Env::launched();
    let (guardian, agent, keeper) = (env.guardian.insecure_clone(), env.agent.insecure_clone(), env.keeper.insecure_clone());
    let new_keeper = Keypair::new();
    let keeper_now = |env: &Env| Address::new_from_array(Rulebook::cast(&env.book()).unwrap().keeper);

    // not the agent, not the keeper itself, not the key that wants the job, not a stranger
    for signer in [&agent, &keeper, &new_keeper, &Keypair::new()] {
        refused(env.guardian_ix(signer, tag::SET_KEEPER, new_keeper.pubkey().as_ref()), Refusal::NotGuardian);
    }
    // the guardian's key without its signature
    let mut data = vec![tag::SET_KEEPER];
    data.extend_from_slice(new_keeper.pubkey().as_ref());
    let accounts = vec![AccountMeta::new_readonly(guardian.pubkey(), false), AccountMeta::new(env.book, false)];
    failed(env.send(Instruction { program_id: PROGRAM, accounts, data }, &[]), InstructionError::MissingRequiredSignature);
    // a key cut short
    failed(env.guardian_ix(&guardian, tag::SET_KEEPER, &new_keeper.pubkey().to_bytes()[..31]), InstructionError::InvalidInstructionData);
    assert_eq!(keeper_now(&env), keeper.pubkey(), "nothing was written");

    env.guardian_ix(&guardian, tag::SET_KEEPER, new_keeper.pubkey().as_ref()).unwrap();
    assert_eq!(keeper_now(&env), new_keeper.pubkey());
    // and nothing else moved: the same agent writes the rules, the same guardian pauses
    let data = env.book();
    let book = Rulebook::cast(&data).unwrap();
    assert_eq!((book.agent, book.guardian, book.cosigner), (agent.pubkey().to_bytes(), guardian.pubkey().to_bytes(), env.cosigner.pubkey().to_bytes()));
    env.set_rules(&open()).unwrap();
    // being the keeper gives no say over who the keeper is
    refused(env.guardian_ix(&new_keeper, tag::SET_KEEPER, keeper.pubkey().as_ref()), Refusal::NotGuardian);
}

/// Meteora is not in LiteSVM, so what is tested here is everything before the call to it:
/// who is refused, and that a rightful claim does get as far as calling Meteora's address
/// with the rulebook signing. The claim itself runs on the local validator (scripts/e2e.ts).
#[test]
fn only_the_keeper_claims_and_only_into_its_own_accounts() {
    let mut env = Env::launched();
    env.stand_in_for_meteora();
    let (guardian, agent, keeper) = (env.guardian.insecure_clone(), env.agent.insecure_clone(), env.keeper.insecure_clone());
    let (token_account, sol_account) = (env.token_account(&keeper.pubkey()), env.sol_account(&keeper.pubkey()));
    // What goes wrong first is what is reported, so each refusal below is the only thing wrong with its claim.
    let stopped = |env: &mut Env, ix: Instruction, signer: &Keypair| {
        let result = env.send(ix, &[signer]);
        assert!(!reached_meteora(&result), "a refused claim never gets to Meteora");
        result
    };

    // the keeper's key without its signature
    let mut unsigned = env.claim_ix(keeper.pubkey(), token_account, sol_account);
    unsigned.accounts[0].is_signer = false;
    let result = env.send(unsigned, &[]);
    assert!(!reached_meteora(&result));
    failed(result, InstructionError::MissingRequiredSignature);

    // anybody else, into accounts of their own: a stranger, the agent, the guardian
    let stranger = Keypair::new();
    for other in [&stranger, &agent, &guardian] {
        let (theirs, their_sol) = (env.token_account(&other.pubkey()), env.sol_account(&other.pubkey()));
        let ix = env.claim_ix(other.pubkey(), theirs, their_sol);
        refused(stopped(&mut env, ix, other), Refusal::NotKeeper);
    }
    // or into the keeper's accounts, which does not make the signer the keeper
    let ix = env.claim_ix(stranger.pubkey(), token_account, sol_account);
    refused(stopped(&mut env, ix, &stranger), Refusal::NotKeeper);

    // the keeper, towards an account that is somebody else's: the tokens' side, then the SOL's
    let (theirs, their_sol) = (env.token_account(&stranger.pubkey()), env.sol_account(&stranger.pubkey()));
    let ix = env.claim_ix(keeper.pubkey(), theirs, sol_account);
    refused(stopped(&mut env, ix, &keeper), Refusal::NotKeepersAccount);
    let ix = env.claim_ix(keeper.pubkey(), token_account, their_sol);
    refused(stopped(&mut env, ix, &keeper), Refusal::NotKeepersAccount);
    // towards a plain wallet, the keeper's own included: the fees arrive in token accounts
    env.svm.airdrop(&keeper.pubkey(), SOL).unwrap();
    for wallet in [keeper.pubkey(), stranger.pubkey()] {
        let ix = env.claim_ix(keeper.pubkey(), token_account, wallet);
        refused(stopped(&mut env, ix, &keeper), Refusal::NotKeepersAccount);
    }
    // towards an account of some other program that has the keeper's key written where a
    // token account names its owner
    let lookalike = Keypair::new().pubkey();
    let mut data = vec![0; 165];
    data[32..64].copy_from_slice(keeper.pubkey().as_ref());
    env.svm.set_account(lookalike, Account { lamports: SOL, data, owner: Address::new_from_array([9; 32]), executable: false, rent_epoch: 0 }).unwrap();
    let ix = env.claim_ix(keeper.pubkey(), lookalike, sol_account);
    refused(stopped(&mut env, ix, &keeper), Refusal::NotKeepersAccount);

    // another program where Meteora's goes: this one, the token program
    for other in [PROGRAM, TOKEN_2022] {
        let mut ix = env.claim_ix(keeper.pubkey(), token_account, sol_account);
        ix.accounts[14] = AccountMeta::new_readonly(other, false);
        failed(stopped(&mut env, ix, &keeper), InstructionError::IncorrectProgramId);
    }
    // something that is not a rulebook where the fee claimer goes
    let mut ix = env.claim_ix(keeper.pubkey(), token_account, sol_account);
    ix.accounts[10] = AccountMeta::new_readonly(keeper.pubkey(), false);
    failed(stopped(&mut env, ix, &keeper), InstructionError::InvalidAccountOwner);
    // fewer accounts than Meteora's claim has, more than it could have, amounts cut short
    let mut ix = env.claim_ix(keeper.pubkey(), token_account, sol_account);
    ix.accounts.truncate(14);
    // The runtime still reports too few accounts under this name, which it means to retire.
    #[allow(deprecated)]
    failed(stopped(&mut env, ix, &keeper), InstructionError::NotEnoughAccountKeys);
    let mut ix = env.claim_ix(keeper.pubkey(), token_account, sol_account);
    ix.accounts.extend((0..4).map(|_| AccountMeta::new_readonly(INSTRUCTIONS_SYSVAR, false)));
    failed(stopped(&mut env, ix, &keeper), InstructionError::InvalidArgument);
    let mut ix = env.claim_ix(keeper.pubkey(), token_account, sol_account);
    ix.data.pop();
    failed(stopped(&mut env, ix, &keeper), InstructionError::InvalidInstructionData);

    // The keeper, into its own two accounts: the program calls Meteora's address, and the
    // runtime lets it sign as the rulebook. What answers there is the stand-in, which has no
    // such instruction; the real one is met on the local validator.
    let ix = env.claim_ix(keeper.pubkey(), token_account, sol_account);
    let result = env.send(ix, &[&keeper]);
    assert!(reached_meteora(&result), "a rightful claim is passed on to Meteora");
    failed(result, InstructionError::InvalidInstructionData);
    // the same with none of the hook's accounts behind Meteora's own
    let mut ix = env.claim_ix(keeper.pubkey(), token_account, sol_account);
    ix.accounts.truncate(15);
    assert!(reached_meteora(&env.send(ix, &[&keeper])));

    // the guardian puts another keeper in: the old one is refused, the new one is passed on
    let new_keeper = Keypair::new();
    env.guardian_ix(&guardian, tag::SET_KEEPER, new_keeper.pubkey().as_ref()).unwrap();
    let ix = env.claim_ix(keeper.pubkey(), token_account, sol_account);
    refused(stopped(&mut env, ix, &keeper), Refusal::NotKeeper);
    let (new_token_account, new_sol_account) = (env.token_account(&new_keeper.pubkey()), env.sol_account(&new_keeper.pubkey()));
    // the new keeper cannot send the fees to the old one's accounts either
    let ix = env.claim_ix(new_keeper.pubkey(), token_account, sol_account);
    refused(stopped(&mut env, ix, &new_keeper), Refusal::NotKeepersAccount);
    let ix = env.claim_ix(new_keeper.pubkey(), new_token_account, new_sol_account);
    assert!(reached_meteora(&env.send(ix, &[&new_keeper])));
}

/// Anybody can make a curve on Meteora for a token of their own whose config names this
/// rulebook as its fee claimer. The rulebook must not sign a claim there: the keeper, or
/// whoever has its key, could then have it sign in front of that other token's hook program.
#[test]
fn the_rulebook_signs_only_for_its_own_tokens_curve() {
    let mut env = Env::launched();
    env.stand_in_for_meteora();
    let keeper = env.keeper.insecure_clone();
    let (token_account, sol_account) = (env.token_account(&keeper.pubkey()), env.sol_account(&keeper.pubkey()));
    // Everything about the claim is rightful but the token: another mint stands where the
    // rulebook's own should, first a made-up address and then a real mint of somebody else's.
    let other = Env::launched();
    let other_mint = other.svm.get_account(&other.mint.pubkey()).unwrap();
    env.svm.set_account(other.mint.pubkey(), other_mint).unwrap();
    for mint in [Address::new_from_array([7; 32]), other.mint.pubkey(), WRAPPED_SOL] {
        let mut ix = env.claim_ix(keeper.pubkey(), token_account, sol_account);
        ix.accounts[8] = AccountMeta::new_readonly(mint, false);
        let result = env.send(ix, &[&keeper]);
        assert!(!reached_meteora(&result), "the rulebook signed a claim on a curve that is not its token's");
        failed(result, InstructionError::InvalidAccountData);
    }
    // With its own token's mint there, the same claim is passed on.
    let ix = env.claim_ix(keeper.pubkey(), token_account, sol_account);
    assert!(reached_meteora(&env.send(ix, &[&keeper])));
}

#[test]
fn a_token_with_no_app_key_takes_no_rule_about_the_app() {
    let mut env = Env::new();
    env.create_mint();
    // an all-zero co-signer in the rulebook: the token names no app
    let mut ix = env.init_ix(&limits(), SPLIT, Address::default());
    ix.data[8 + 64..8 + 96].fill(0);
    let mint = env.mint.insecure_clone();
    env.send(ix, &[&mint]).unwrap();
    env.create_vault();

    refused(env.set_rules(&rule(&[when(0, fact::VIA_APP, op::EQ, 1)])), Refusal::BadRule);
    env.set_rules(&rule(&[when(0, fact::SIZE, op::LE, PCT_SHARE)])).unwrap();
}

#[test]
fn the_exempt_owner_skips_the_rules() {
    let mut env = Env::new();
    env.create_mint();
    let buyback = Keypair::new();
    env.init(&limits(), SPLIT, buyback.pubkey()).unwrap();
    env.create_vault();
    let (_, a) = env.holder();
    let b = env.token_account(&buyback.pubkey());
    env.set_rules(&closed()).unwrap();

    refused(env.buy(a, PCT), Refusal::NotAllowed);
    env.buy(b, 5 * PCT).unwrap();
    assert_eq!(env.balance(&b), 5 * PCT);
}

#[test]
fn the_agent_gives_the_token_another_of_its_names() {
    let mut env = Env::launched_with_a_name();
    let (_, a) = env.holder();
    let (agent, guardian) = (env.agent.insecure_clone(), env.guardian.insecure_clone());
    let named = |env: &Env| {
        let (_, name, symbol) = env.token_name();
        (name, symbol)
    };
    let own = |pair: (&str, &str)| (pair.0.to_string(), pair.1.to_string());
    assert_eq!(env.token_name(), (env.book, "Edict".into(), "EDICT".into()));

    // the name it launched with stays as long as any other would
    refused(env.edict_with_name(1), Refusal::TooSoon);
    assert_eq!(Rulebook::cast(&env.book()).unwrap().epoch(), 0, "the edict sent with it was undone too");
    env.warp(24 * HOUR);

    // a name changes only as part of an edict
    let alone = env.set_name_ix(&agent, 1);
    refused(env.send(alone, &[&agent]), Refusal::NoEdict);
    // and only the agent's
    let ixs = [env.set_rules_ix(&agent, &open(), [0; 32]), env.set_name_ix(&guardian, 1)];
    refused(env.send_all(&ixs, &[&agent, &guardian]), Refusal::NotAgent);
    // to a name the token has, other than the one it goes by
    refused(env.edict_with_name(0), Refusal::BadName);
    refused(env.edict_with_name(NAMES.len() as u8), Refusal::BadName);
    assert_eq!(named(&env), own(NAMES[0]));

    env.edict_with_name(1).unwrap();
    assert_eq!(named(&env), own(NAMES[1]));
    let data = env.book();
    let book = Rulebook::cast(&data).unwrap();
    assert_eq!((book.name, book.renamed_at(), book.epoch()), (1, T0 + 24 * HOUR, 1));

    // the new name stays a day as well, and a pause holds it too
    env.warp(23 * HOUR);
    refused(env.edict_with_name(2), Refusal::TooSoon);
    env.warp(HOUR);
    env.pause(true).unwrap();
    assert!(env.edict_with_name(2).is_err());
    env.pause(false).unwrap();
    // a longer name: Token-2022 makes room for it on the mint
    let before = env.svm.get_account(&env.mint.pubkey()).unwrap().data.len();
    env.edict_with_name(2).unwrap();
    assert_eq!(named(&env), own(NAMES[2]));
    assert!(env.svm.get_account(&env.mint.pubkey()).unwrap().data.len() > before);

    // nobody edits the name around the rulebook: not the payer who made the mint, not the agent
    for signer in [env.payer.insecure_clone(), agent.insecure_clone()] {
        let mut data = vec![221, 233, 49, 45, 181, 202, 220, 200, 0];
        data.extend_from_slice(&text("Mine"));
        let accounts = vec![AccountMeta::new(env.mint.pubkey(), false), AccountMeta::new_readonly(signer.pubkey(), true)];
        assert!(env.send(env.token_ix(data, accounts), &[&signer]).is_err());
    }
    // nor does the agent rename some other token through this one's rulebook
    let other = Keypair::new().pubkey();
    env.warp(24 * HOUR);
    let mut stray = env.set_name_ix(&agent, 0);
    stray.accounts[2] = AccountMeta::new(other, false);
    let ixs = [env.set_rules_ix(&agent, &open(), [0; 32]), stray];
    assert!(env.send_all(&ixs, &[&agent]).is_err());
    assert_eq!(named(&env), own(NAMES[2]));

    // the token trades as before under any name
    env.buy(a, PCT).unwrap();
    assert_eq!(env.balance(&a), PCT);
}

#[test]
fn a_token_with_one_name_keeps_it() {
    let mut env = Env::new();
    env.create_named_mint();
    let ix = env.init_ix_named(&limits(), SPLIT, Address::default(), &names(&NAMES[..1]));
    let mint = env.mint.insecure_clone();
    env.send(ix, &[&mint]).unwrap();
    env.warp(24 * HOUR);
    refused(env.edict_with_name(0), Refusal::BadName);
    refused(env.edict_with_name(1), Refusal::BadName);
}
