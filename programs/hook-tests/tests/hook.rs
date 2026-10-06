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
        processor::{tag, INIT, POOL_AUTHORITY, VALIDATION_LEN},
        state::{Change, Limits, Refusal, Rulebook, RULEBOOK_LEN, RULEBOOK_SEED, VALIDATION_SEED},
    },
    litesvm::{types::TransactionResult, LiteSVM},
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
const T0: i64 = 1_800_000_000;
const HOUR: i64 = 3_600;
const DECIMALS: u8 = 6;
const SUPPLY: u64 = 1_000_000_000 * 1_000_000;
const PCT: u64 = SUPPLY / 100;
const SYSTEM_PROGRAM: Address = Address::new_from_array([0; 32]);
const TOKEN_2022: Address = Address::from_str_const("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const INSTRUCTIONS_SYSVAR: Address = Address::from_str_const("Sysvar1nstructions1111111111111111111111111");
const PROGRAM: Address = Address::new_from_array([0x48; 32]);

/// A mint with the transfer-hook extension: 165 bytes of base state, the account type, then
/// the extension header (4) and its two keys (64).
const MINT_LEN: usize = 165 + 1 + 4 + 64;
/// A token account of such a mint carries a one-byte "transfer in progress" extension.
const TOKEN_ACCOUNT_LEN: usize = 165 + 1 + 4 + 1;

struct Env {
    svm: LiteSVM,
    payer: Keypair,
    mint: Keypair,
    guardian: Keypair,
    agent: Keypair,
    cosigner: Keypair,
    /// The delegate that moves tokens out of the curve's vault.
    curve: Keypair,
    vault: Address,
    validation: Address,
    book: Address,
}

fn limits() -> Limits {
    Limits { min_interval_secs: HOUR as u32, max_gate_secs: 6 * HOUR as u32, min_max_buy_bps: 25, min_max_wallet_bps: 50, max_treasury_bps: 3_000 }
}

/// No window, no caps, fees half to holders.
fn open() -> Change {
    Change { gate_secs: 0, max_buy_bps: 0, max_wallet_bps: 0, holders_bps: 5_000, burn_bps: 3_000, treasury_bps: 2_000 }
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

impl Env {
    /// A funded payer and the program, before any token exists.
    fn new() -> Self {
        let so = std::env::var("HOOK_SO")
            .unwrap_or_else(|_| concat!(env!("CARGO_MANIFEST_DIR"), "/../hook/target/deploy/agent_hook.so").into());
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
        Env {
            svm,
            payer,
            mint,
            guardian: Keypair::new(),
            agent: Keypair::new(),
            cosigner: Keypair::new(),
            curve: Keypair::new(),
            vault: Address::default(),
            validation,
            book,
        }
    }

    /// A launched token: the whole supply in the curve's vault, open rules.
    fn launched() -> Self {
        let mut env = Self::new();
        env.create_mint();
        env.init(&limits(), &open(), Address::default()).unwrap();
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

    fn init_ix(&self, limits: &Limits, first: &Change, exempt: Address) -> Instruction {
        let mut data = INIT.to_vec();
        for key in [self.guardian.pubkey(), self.agent.pubkey(), self.cosigner.pubkey(), exempt] {
            data.extend_from_slice(key.as_ref());
        }
        data.extend_from_slice(&limits.encode());
        data.extend_from_slice(&first.encode());
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

    fn init(&mut self, limits: &Limits, first: &Change, exempt: Address) -> TransactionResult {
        let ix = self.init_ix(limits, first, exempt);
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

    /// `owner` sends from its token account: into the vault it is a sell, anywhere else a send.
    fn send_tokens(&mut self, owner: &Keypair, from: Address, to: Address, amount: u64) -> TransactionResult {
        self.send(self.transfer_ix(from, to, owner.pubkey(), amount), &[owner])
    }

    fn set_rules_as(&mut self, signer: &Keypair, change: &Change, note: [u8; 32]) -> TransactionResult {
        let mut data = vec![tag::SET_RULES];
        data.extend_from_slice(&change.encode());
        data.extend_from_slice(&note);
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
    assert_eq!(book.limits(), limits());
    assert_eq!(book.rules(), open().rules(0));
    assert_eq!((book.epoch(), book.updated_at(), book.paused), (0, 0, 0));

    let list = env.svm.get_account(&env.validation).unwrap();
    assert_eq!((list.owner, list.data.len()), (PROGRAM, VALIDATION_LEN));
    assert_eq!(list.data[17..49], env.book.to_bytes());
    assert_eq!(list.data[52..84], INSTRUCTIONS_SYSVAR.to_bytes());
}

#[test]
fn init_needs_the_mint_to_sign_and_happens_once() {
    let mut env = Env::new();
    env.create_mint();

    // without the mint's signature anyone could write a token's rulebook before it launches
    let mut ix = env.init_ix(&limits(), &open(), Address::default());
    ix.accounts[1] = AccountMeta::new_readonly(env.mint.pubkey(), false);
    assert_eq!(env.send(ix, &[]).unwrap_err().err, TransactionError::InstructionError(0, InstructionError::MissingRequiredSignature));

    // an account that is not the token's own rulebook address
    let mut ix = env.init_ix(&limits(), &open(), Address::default());
    ix.accounts[3] = AccountMeta::new(Keypair::new().pubkey(), false);
    let mint = env.mint.insecure_clone();
    assert_eq!(env.send(ix, &[&mint]).unwrap_err().err, TransactionError::InstructionError(0, InstructionError::InvalidSeeds));

    // first rules outside the limits, or with a window already open
    refused(env.init(&limits(), &Change { treasury_bps: 3_001, holders_bps: 3_999, ..open() }, Address::default()), Refusal::OutsideLimits);
    assert!(env.init(&limits(), &Change { gate_secs: 60, ..open() }, Address::default()).is_err());
    assert!(env.init(&Limits { max_treasury_bps: 10_001, ..limits() }, &open(), Address::default()).is_err());

    env.init(&limits(), &open(), Address::default()).unwrap();
    assert_eq!(
        env.init(&limits(), &open(), Address::default()).unwrap_err().err,
        TransactionError::InstructionError(0, InstructionError::AccountAlreadyInitialized)
    );
}

#[test]
fn open_rules_let_every_transfer_through() {
    let mut env = Env::launched();
    let (alice, bob) = (Keypair::new(), Keypair::new());
    let (a, b) = (env.token_account(&alice.pubkey()), env.token_account(&bob.pubkey()));

    env.buy(a, 30 * PCT).unwrap();
    env.send_tokens(&alice, a, b, 10 * PCT).unwrap();
    env.send_tokens(&bob, b, env.vault, 4 * PCT).unwrap();
    assert_eq!((env.balance(&a), env.balance(&b), env.balance(&env.vault)), (20 * PCT, 6 * PCT, 74 * PCT));
}

#[test]
fn a_transfer_without_the_hook_accounts_does_not_go_through() {
    let mut env = Env::launched();
    let alice = Keypair::new();
    let a = env.token_account(&alice.pubkey());
    let curve = env.curve.insecure_clone();
    let mut ix = env.transfer_ix(env.vault, a, curve.pubkey(), PCT);
    ix.accounts.truncate(4);
    assert!(env.send(ix, &[&curve]).is_err(), "Token-2022 itself insists on the hook");
}

#[test]
fn max_buy_caps_one_buy() {
    let mut env = Env::launched();
    let alice = Keypair::new();
    let a = env.token_account(&alice.pubkey());
    env.set_rules(&Change { max_buy_bps: 100, ..open() }).unwrap();

    refused(env.buy(a, PCT + 1), Refusal::BuyTooLarge);
    env.buy(a, PCT).unwrap();
    env.buy(a, PCT).unwrap(); // a cap on one buy, not on the wallet
    assert_eq!(env.balance(&a), 2 * PCT);

    // it caps buys only: a holder can send or sell any size
    let bob = Keypair::new();
    let b = env.token_account(&bob.pubkey());
    env.send_tokens(&alice, a, b, 2 * PCT).unwrap();
    env.send_tokens(&bob, b, env.vault, 2 * PCT).unwrap();
}

#[test]
fn max_wallet_caps_a_wallet_by_buy_or_by_send() {
    let mut env = Env::launched();
    let (alice, bob) = (Keypair::new(), Keypair::new());
    let (a, b) = (env.token_account(&alice.pubkey()), env.token_account(&bob.pubkey()));
    env.set_rules(&Change { max_wallet_bps: 200, ..open() }).unwrap();

    env.buy(a, 2 * PCT).unwrap();
    refused(env.buy(a, 1), Refusal::WalletTooLarge);
    env.buy(b, PCT).unwrap();
    refused(env.send_tokens(&alice, a, b, PCT + 1), Refusal::WalletTooLarge);
    env.send_tokens(&alice, a, b, PCT).unwrap();
    assert_eq!((env.balance(&a), env.balance(&b)), (PCT, 2 * PCT));
}

#[test]
fn an_app_only_window_needs_the_cosigner_and_closes_by_the_clock() {
    let mut env = Env::launched();
    let alice = Keypair::new();
    let a = env.token_account(&alice.pubkey());
    env.set_rules(&Change { gate_secs: 2 * HOUR as u32, ..open() }).unwrap();
    let cosigner = env.cosigner.insecure_clone();

    refused(env.buy(a, PCT), Refusal::NotCosigned);
    // somebody else's signature next to the swap is not the app's
    refused(env.buy_through_app(&Keypair::new(), a, PCT), Refusal::NotCosigned);
    env.buy_through_app(&cosigner, a, PCT).unwrap();
    assert_eq!(env.balance(&a), PCT);

    // the window is about buys: sending and selling need nobody's permission
    let bob = Keypair::new();
    let b = env.token_account(&bob.pubkey());
    env.send_tokens(&alice, a, b, PCT / 2).unwrap();
    env.send_tokens(&bob, b, env.vault, PCT / 2).unwrap();

    env.warp(2 * HOUR - 1);
    refused(env.buy(a, PCT), Refusal::NotCosigned);
    env.warp(1);
    env.buy(a, PCT).unwrap(); // nobody had to close it
}

#[test]
fn selling_is_never_refused() {
    let mut env = Env::launched();
    let alice = Keypair::new();
    let a = env.token_account(&alice.pubkey());
    env.buy(a, 10 * PCT).unwrap();

    // the tightest rules the limits allow, all at once
    env.set_rules(&Change { gate_secs: 6 * HOUR as u32, max_buy_bps: 25, max_wallet_bps: 50, ..open() }).unwrap();
    refused(env.buy(a, 1), Refusal::NotCosigned);
    env.send_tokens(&alice, a, env.vault, 7 * PCT).unwrap();
    env.send_tokens(&alice, a, env.vault, 3 * PCT).unwrap();
    assert_eq!((env.balance(&a), env.balance(&env.vault)), (0, SUPPLY));
}

#[test]
fn the_agent_cannot_leave_the_limits() {
    let mut env = Env::launched();
    refused(env.set_rules(&Change { gate_secs: 6 * HOUR as u32 + 1, ..open() }), Refusal::OutsideLimits);
    refused(env.set_rules(&Change { max_buy_bps: 24, ..open() }), Refusal::OutsideLimits);
    refused(env.set_rules(&Change { max_wallet_bps: 49, ..open() }), Refusal::OutsideLimits);
    refused(env.set_rules(&Change { holders_bps: 6_999, burn_bps: 0, treasury_bps: 3_001, ..open() }), Refusal::OutsideLimits);
    refused(env.set_rules(&Change { holders_bps: 5_001, ..open() }), Refusal::BadSplit);
    assert_eq!(Rulebook::cast(&env.book()).unwrap().epoch(), 0, "nothing was written");

    let change = Change { gate_secs: HOUR as u32, max_buy_bps: 100, max_wallet_bps: 300, holders_bps: 7_000, burn_bps: 0, treasury_bps: 3_000 };
    let agent = env.agent.insecure_clone();
    env.set_rules_as(&agent, &change, [7; 32]).unwrap();
    let data = env.book();
    let book = Rulebook::cast(&data).unwrap();
    assert_eq!(book.rules(), change.rules(T0));
    assert_eq!((book.epoch(), book.updated_at(), book.note), (1, T0, [7; 32]));

    // one change per interval
    env.warp(HOUR - 1);
    refused(env.set_rules(&open()), Refusal::TooSoon);
    env.warp(1);
    env.set_rules(&open()).unwrap();
    assert_eq!(Rulebook::cast(&env.book()).unwrap().epoch(), 2);
}

#[test]
fn only_the_agent_writes_rules() {
    let mut env = Env::launched();
    let guardian = env.guardian.insecure_clone();
    refused(env.set_rules_as(&guardian, &open(), [0; 32]), Refusal::NotAgent);
    refused(env.set_rules_as(&Keypair::new(), &open(), [0; 32]), Refusal::NotAgent);

    // the agent's key without its signature
    let mut data = vec![tag::SET_RULES];
    data.extend_from_slice(&open().encode());
    data.extend_from_slice(&[0; 32]);
    let accounts = vec![AccountMeta::new_readonly(env.agent.pubkey(), false), AccountMeta::new(env.book, false)];
    let result = env.send(Instruction { program_id: PROGRAM, accounts, data }, &[]);
    assert_eq!(result.unwrap_err().err, TransactionError::InstructionError(0, InstructionError::MissingRequiredSignature));
}

#[test]
fn the_guardian_can_pause_and_replace_but_only_that() {
    let mut env = Env::launched();
    let alice = Keypair::new();
    let a = env.token_account(&alice.pubkey());
    let (guardian, agent) = (env.guardian.insecure_clone(), env.agent.insecure_clone());
    env.set_rules(&Change { gate_secs: 6 * HOUR as u32, max_buy_bps: 100, ..open() }).unwrap();
    refused(env.buy(a, PCT), Refusal::NotCosigned);

    // a pause opens the token up and stops the agent
    refused(env.guardian_ix(&agent, tag::PAUSE, &[1]), Refusal::NotGuardian);
    env.pause(true).unwrap();
    env.buy(a, 5 * PCT).unwrap();
    env.warp(HOUR);
    refused(env.set_rules(&open()), Refusal::Paused);
    env.pause(false).unwrap();
    refused(env.buy(a, PCT), Refusal::NotCosigned);

    // a new agent
    let new_agent = Keypair::new();
    refused(env.guardian_ix(&agent, tag::SET_AGENT, new_agent.pubkey().as_ref()), Refusal::NotGuardian);
    env.guardian_ix(&guardian, tag::SET_AGENT, new_agent.pubkey().as_ref()).unwrap();
    refused(env.set_rules(&open()), Refusal::NotAgent);
    env.set_rules_as(&new_agent, &Change { gate_secs: HOUR as u32, ..open() }, [0; 32]).unwrap();

    // a new app key
    let new_cosigner = Keypair::new();
    let old_cosigner = env.cosigner.insecure_clone();
    env.guardian_ix(&guardian, tag::SET_COSIGNER, new_cosigner.pubkey().as_ref()).unwrap();
    refused(env.buy_through_app(&old_cosigner, a, PCT), Refusal::NotCosigned);
    env.buy_through_app(&new_cosigner, a, PCT).unwrap();

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
fn the_exempt_owner_skips_the_rules() {
    let mut env = Env::new();
    env.create_mint();
    let buyback = Keypair::new();
    env.init(&limits(), &open(), buyback.pubkey()).unwrap();
    env.create_vault();
    let alice = Keypair::new();
    let a = env.token_account(&alice.pubkey());
    let b = env.token_account(&buyback.pubkey());
    env.set_rules(&Change { gate_secs: HOUR as u32, max_buy_bps: 25, max_wallet_bps: 50, ..open() }).unwrap();

    refused(env.buy(a, PCT), Refusal::NotCosigned);
    env.buy(b, 5 * PCT).unwrap();
    assert_eq!(env.balance(&b), 5 * PCT);
}
