//! Instruction handlers.
//!
//! | data starts with            | instruction  | signed by            |
//! |-----------------------------|--------------|----------------------|
//! | [`EXECUTE`] (8 bytes)       | the hook     | Token-2022 calls it  |
//! | [`INIT`] (8 bytes)          | init         | payer, mint          |
//! | [`tag::SET_RULES`]          | set_rules    | agent                |
//! | [`tag::PAUSE`]              | pause        | guardian             |
//! | [`tag::SET_AGENT`]          | set_agent    | guardian             |
//! | [`tag::SET_COSIGNER`]       | set_cosigner | guardian             |
//! | [`tag::SET_GUARDIAN`]       | set_guardian | guardian, new one    |
//! | [`tag::SET_NAME`]           | set_name     | agent                |
//! | [`tag::SET_KEEPER`]         | set_keeper   | guardian             |
//! | [`tag::CLAIM_FEES`]         | claim_fees   | keeper               |

use {
    crate::state::{
        admits, fact, looks_at, split_adds_up, Change, Facts, Limits, Refusal, Rulebook, MILLIONTHS, NAME_LEN, NO_KEY, RULEBOOK_LEN,
        RULEBOOK_SEED, SYMBOL_LEN, VALIDATION_SEED, VERSION,
    },
    pinocchio::{
        cpi::{invoke_signed, invoke_signed_with_bounds, Seed, Signer},
        error::ProgramError,
        instruction::{InstructionAccount, InstructionView},
        sysvars::{
            clock::Clock,
            instructions::{Instructions, INSTRUCTIONS_ID},
            Sysvar,
        },
        AccountView, Address, ProgramResult,
    },
    pinocchio_system::create_account_with_minimum_balance_signed,
};

/// `sha256("spl-transfer-hook-interface:execute")[..8]`: how Token-2022 calls a hook.
pub const EXECUTE: [u8; 8] = [105, 37, 101, 197, 75, 251, 102, 26];
/// `sha256("spl-transfer-hook-interface:initialize-extra-account-metas")[..8]`.
pub const INIT: [u8; 8] = [43, 34, 13, 49, 167, 88, 235, 235];

pub mod tag {
    pub const SET_RULES: u8 = 1;
    pub const PAUSE: u8 = 2;
    pub const SET_AGENT: u8 = 3;
    pub const SET_COSIGNER: u8 = 4;
    pub const SET_GUARDIAN: u8 = 5;
    pub const SET_NAME: u8 = 6;
    pub const SET_KEEPER: u8 = 7;
    pub const CLAIM_FEES: u8 = 8;
}

pub const TOKEN_2022: Address = Address::from_str_const("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
/// The older token program. Wrapped SOL, which the fees are paid in, is a token of this one.
pub const TOKEN: Address = Address::from_str_const("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
/// `sha256("spl_token_metadata_interface:updating_field")[..8]`: how a token's metadata is edited.
const UPDATE_FIELD: [u8; 8] = [221, 233, 49, 45, 181, 202, 220, 200];
/// The metadata fields a name change touches, by their numbers in that interface.
const FIELD_NAME: u8 = 0;
const FIELD_SYMBOL: u8 = 1;

/// Meteora DBC's pool authority. It owns the token vault of every curve, so tokens leaving an
/// account it owns are a buy and tokens arriving in one are a sell.
pub const POOL_AUTHORITY: Address = Address::from_str_const("FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM");
/// Meteora's bonding curve program, the only one `claim_fees` ever calls.
pub const METEORA_DBC: Address = Address::from_str_const("dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN");
/// `sha256("global:claim_trading_fee2")[..8]`: Meteora's claim for a pool whose token has a hook.
const CLAIM_TRADING_FEE2: [u8; 8] = [84, 191, 71, 50, 9, 162, 55, 193];
/// The accounts Meteora's claim names, in its order: pool authority, config, pool, where the
/// fees in the token go, where the fees in SOL go, the pool's two vaults, the two mints, the
/// fee claimer, the two token programs, Meteora's event authority, Meteora's program.
pub const CLAIM_ACCOUNTS: usize = 14;
/// Where, among those, the two destinations, the token's mint, the fee claimer and Meteora's
/// program sit.
const CLAIM_TOKEN_DESTINATION: usize = 3;
const CLAIM_SOL_DESTINATION: usize = 4;
const CLAIM_MINT: usize = 7;
const CLAIM_FEE_CLAIMER: usize = 9;
const CLAIM_PROGRAM: usize = 13;
/// After them come the accounts the token's hook wants in a transfer. This program's own
/// list has five (the three extra accounts, the program, the validation account).
const MAX_CLAIM_HOOK_ACCOUNTS: usize = 8;
const MAX_CLAIM_ACCOUNTS: usize = CLAIM_ACCOUNTS + MAX_CLAIM_HOOK_ACCOUNTS;
const COMPUTE_BUDGET: Address = Address::from_str_const("ComputeBudget111111111111111111111111111111");
/// The compute-budget instruction that sets a transaction's priority fee.
const SET_COMPUTE_UNIT_PRICE: u8 = 3;

/// The validation account lists three extra accounts: the rulebook, the Instructions sysvar
/// and the curve's SOL vault.
const EXTRA_ACCOUNTS: usize = 3;
/// One entry of that list: a kind byte, 32 bytes of address, a signer flag, a writable flag.
const EXTRA_ACCOUNT_LEN: usize = 35;
pub const VALIDATION_LEN: usize = 16 + EXTRA_ACCOUNTS * EXTRA_ACCOUNT_LEN;

impl From<Refusal> for ProgramError {
    fn from(refusal: Refusal) -> Self {
        ProgramError::Custom(refusal as u32)
    }
}

pub fn process_instruction(program_id: &Address, accounts: &mut [AccountView], data: &[u8]) -> ProgramResult {
    if let Some(data) = data.strip_prefix(&EXECUTE) {
        return execute(program_id, accounts, data);
    }
    if let Some(data) = data.strip_prefix(&INIT) {
        return init(program_id, accounts, data);
    }
    let (kind, data) = data.split_first().ok_or(ProgramError::InvalidInstructionData)?;
    match *kind {
        tag::SET_RULES => set_rules(program_id, accounts, data),
        tag::PAUSE => pause(program_id, accounts, data),
        tag::SET_AGENT => set_key(program_id, accounts, data, |book| &mut book.agent),
        tag::SET_COSIGNER => set_key(program_id, accounts, data, |book| &mut book.cosigner),
        tag::SET_GUARDIAN => set_guardian(program_id, accounts),
        tag::SET_NAME => set_name(program_id, accounts, data),
        tag::SET_KEEPER => set_key(program_id, accounts, data, |book| &mut book.keeper),
        tag::CLAIM_FEES => claim_fees(program_id, accounts, data),
        _ => Err(ProgramError::InvalidInstructionData),
    }
}

fn array<const N: usize>(data: &[u8], at: usize) -> Result<[u8; N], ProgramError> {
    data.get(at..at + N)
        .and_then(|bytes| bytes.try_into().ok())
        .ok_or(ProgramError::InvalidInstructionData)
}

#[cfg(target_os = "solana")]
fn log(message: &str) {
    // SAFETY: the pointer and the length describe a valid string.
    unsafe { pinocchio::syscalls::sol_log_(message.as_ptr(), message.len() as u64) }
}

#[cfg(not(target_os = "solana"))]
fn log(_message: &str) {}

fn u64_in(account: &AccountView, at: usize) -> Result<u64, ProgramError> {
    let data = account.try_borrow()?;
    let bytes = data.get(at..at + 8).and_then(|bytes| bytes.try_into().ok()).ok_or(ProgramError::InvalidAccountData)?;
    Ok(u64::from_le_bytes(bytes))
}

/// Token account layout: mint at 0, owner at 32, amount at 64.
fn token_owner(account: &AccountView) -> Result<[u8; 32], ProgramError> {
    let data = account.try_borrow()?;
    data.get(32..64).and_then(|bytes| bytes.try_into().ok()).ok_or(ProgramError::InvalidAccountData)
}

fn token_amount(account: &AccountView) -> Result<u64, ProgramError> {
    u64_in(account, 64)
}

/// Mint layout: supply at 36.
fn mint_supply(mint: &AccountView) -> Result<u64, ProgramError> {
    u64_in(mint, 36)
}

fn share(amount: u64, supply: u64) -> u64 {
    if supply == 0 {
        return 0;
    }
    (amount as u128 * MILLIONTHS as u128 / supply as u128) as u64
}

/// What the transaction itself says: whether `cosigner` signed it, and the priority fee it
/// set. The app signs a top-level instruction of its own next to the swap (it pays for the
/// buyer's token account), not the swap itself, so every top-level instruction is looked at.
fn read_transaction(ixs: &AccountView, cosigner: &[u8; 32]) -> Result<(bool, u64), ProgramError> {
    let ixs = Instructions::try_from(ixs)?;
    let (mut cosigned, mut priority) = (false, 0);
    for i in 0..ixs.num_instructions() {
        let ix = ixs.load_instruction_at(i)?;
        for j in 0..ix.num_account_metas() {
            let account = ix.get_instruction_account_at(j)?;
            cosigned |= account.is_signer() && account.key.as_array() == cosigner;
        }
        let data = ix.get_instruction_data();
        if ix.get_program_id() == &COMPUTE_BUDGET && data.first() == Some(&SET_COMPUTE_UNIT_PRICE) {
            if let Some(price) = data.get(1..9).and_then(|bytes| bytes.try_into().ok()) {
                priority = u64::from_le_bytes(price);
            }
        }
    }
    Ok((cosigned, priority))
}

/// The hook. Token-2022 has already moved the tokens when it calls this; an error undoes the
/// whole transfer.
///
/// Accounts: source, mint, destination, authority, validation account, rulebook, Instructions
/// sysvar, the curve's SOL vault. It writes nothing, so calling it outside a transfer
/// achieves nothing.
fn execute(program_id: &Address, accounts: &mut [AccountView], data: &[u8]) -> ProgramResult {
    let [source, mint, dest, _authority, _validation, book, ixs, curve_vault, ..] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    let amount = u64::from_le_bytes(array(data, 0)?);

    // Only a buy is ever judged. Selling into the curve and moving tokens between wallets
    // need nobody's permission, and this comes before any rule is even read.
    let receiver = token_owner(dest)?;
    if token_owner(source)? != *POOL_AUTHORITY.as_array() || receiver == *POOL_AUTHORITY.as_array() {
        return Ok(());
    }

    if !book.owned_by(program_id) {
        return Err(ProgramError::InvalidAccountOwner);
    }
    let book_data = book.try_borrow()?;
    let book = Rulebook::cast(&book_data).ok_or(ProgramError::InvalidAccountData)?;
    if book.version != VERSION || book.mint != *mint.address().as_array() {
        return Err(ProgramError::InvalidAccountData);
    }
    if book.paused != 0 || (book.exempt != NO_KEY && receiver == book.exempt) {
        return Ok(());
    }
    let clock = Clock::get()?;
    let now = clock.unix_timestamp;
    if !book.rule_in_force(now) {
        return Ok(());
    }

    let (conditions, count) = book.rule();
    let conditions = &conditions[..count];
    let supply = mint_supply(mint)?;
    let held = token_amount(dest)?;
    let mut facts: Facts = [0; fact::COUNT];
    facts[fact::SIZE as usize] = share(amount, supply);
    facts[fact::HELD_BEFORE as usize] = share(held.saturating_sub(amount), supply);
    facts[fact::HELD_AFTER as usize] = share(held, supply);
    let second_of_day = now.rem_euclid(86_400) as u64;
    facts[fact::MINUTE as usize] = second_of_day % 3_600 / 60;
    facts[fact::HOUR as usize] = second_of_day / 3_600;
    // 1 January 1970 was a Thursday.
    facts[fact::WEEKDAY as usize] = (now.div_euclid(86_400) + 4).rem_euclid(7) as u64;
    facts[fact::ELAPSED as usize] = now.saturating_sub(book.updated_at()).max(0) as u64;
    let account_seed = u64::from_le_bytes(array(dest.address().as_array(), 0)?);
    facts[fact::LUCK as usize] = clock.slot.wrapping_add(account_seed) % 100;
    if looks_at(conditions, fact::VIA_APP) || looks_at(conditions, fact::PRIORITY) {
        let (cosigned, priority) = read_transaction(ixs, &book.cosigner)?;
        facts[fact::VIA_APP as usize] = cosigned as u64;
        facts[fact::PRIORITY as usize] = priority;
    }
    if looks_at(conditions, fact::CURVE_SOL) {
        if *curve_vault.address().as_array() != book.curve_vault {
            return Err(ProgramError::InvalidAccountData);
        }
        // The vault is a wrapped-SOL token account, so its amount is in lamports.
        facts[fact::CURVE_SOL as usize] = token_amount(curve_vault)? / 1_000_000;
    }

    if admits(conditions, &facts) {
        return Ok(());
    }
    log("edict: this buy does not fit the rule in force");
    Err(Refusal::NotAllowed.into())
}

/// Creates the token's rulebook and the validation account Token-2022 reads. The mint signs,
/// so nobody else can write the rulebook of a token before it launches.
///
/// Accounts: payer (signer, writable), mint (signer), validation account (writable), rulebook
/// (writable), system program.
/// Data: guardian, agent, cosigner, exempt, curve vault, keeper (32 bytes each), [`Limits`],
/// the opening fee split: holders, burn, treasury (2 bytes each), then the names the token can
/// go by, 44 bytes each, the one it launches with first. The token opens with no rule.
fn init(program_id: &Address, accounts: &mut [AccountView], data: &[u8]) -> ProgramResult {
    let [payer, mint, validation, book, _system_program, ..] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    if !payer.is_signer() || !mint.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if !validation.is_data_empty() || !book.is_data_empty() {
        return Err(ProgramError::AccountAlreadyInitialized);
    }
    const KEYS: usize = 6 * 32;
    const NAMES: usize = KEYS + Limits::LEN + 6;
    let limits = Limits::decode(&array(data, KEYS)?);
    let split: [u8; 6] = array(data, KEYS + Limits::LEN)?;
    let (holders_bps, burn_bps, treasury_bps) = (u16::from_le_bytes([split[0], split[1]]), u16::from_le_bytes([split[2], split[3]]), u16::from_le_bytes([split[4], split[5]]));
    let names = data.get(NAMES..).ok_or(ProgramError::InvalidInstructionData)?;
    if !limits.sane() {
        return Err(ProgramError::InvalidInstructionData);
    }
    if !split_adds_up(holders_bps, burn_bps, treasury_bps) {
        return Err(Refusal::BadSplit.into());
    }
    if !limits.treasury_fits(treasury_bps) {
        return Err(Refusal::OutsideLimits.into());
    }

    // Both accounts sit at their canonical address, so a token has exactly one rulebook.
    let mint_key = *mint.address().as_array();
    let (validation_key, validation_bump) = Address::find_program_address(&[VALIDATION_SEED, &mint_key], program_id);
    let (book_key, book_bump) = Address::find_program_address(&[RULEBOOK_SEED, &mint_key], program_id);
    if validation.address() != &validation_key || book.address() != &book_key {
        return Err(ProgramError::InvalidSeeds);
    }
    let curve_vault: [u8; 32] = array(data, 128)?;

    let bump = [validation_bump];
    let seeds = [Seed::from(VALIDATION_SEED), Seed::from(&mint_key), Seed::from(&bump)];
    create_account_with_minimum_balance_signed(validation, VALIDATION_LEN, program_id, payer, None, &[Signer::from(&seeds)])?;
    {
        // The list as the transfer-hook interface stores it: the instruction it is for, the
        // byte length of what follows, the number of entries, then the entries. Kind 0 is a
        // plain address. Every entry depends on the mint alone: routers resolve them without
        // knowing the buyer.
        let mut list = validation.try_borrow_mut()?;
        list[0..8].copy_from_slice(&EXECUTE);
        list[8..12].copy_from_slice(&((4 + EXTRA_ACCOUNTS * EXTRA_ACCOUNT_LEN) as u32).to_le_bytes());
        list[12..16].copy_from_slice(&(EXTRA_ACCOUNTS as u32).to_le_bytes());
        for (i, key) in [book_key.as_array(), INSTRUCTIONS_ID.as_array(), &curve_vault].into_iter().enumerate() {
            let at = 16 + i * EXTRA_ACCOUNT_LEN + 1;
            list[at..at + 32].copy_from_slice(key);
        }
    }

    let bump = [book_bump];
    let seeds = [Seed::from(RULEBOOK_SEED), Seed::from(&mint_key), Seed::from(&bump)];
    create_account_with_minimum_balance_signed(book, RULEBOOK_LEN, program_id, payer, None, &[Signer::from(&seeds)])?;
    let mut book_data = book.try_borrow_mut()?;
    let book = Rulebook::cast_mut(&mut book_data).ok_or(ProgramError::InvalidAccountData)?;
    book.version = VERSION;
    book.bump = book_bump;
    book.mint = mint_key;
    book.guardian = array(data, 0)?;
    book.agent = array(data, 32)?;
    book.cosigner = array(data, 64)?;
    book.exempt = array(data, 96)?;
    book.curve_vault = curve_vault;
    book.keeper = array(data, 160)?;
    book.set_limits(&limits);
    book.set_split(holders_bps, burn_bps, treasury_bps);
    if !book.set_names(names) {
        return Err(Refusal::BadName.into());
    }
    // The name it launches with is owed the same stay as any later one.
    book.set_renamed_at(Clock::get()?.unix_timestamp);
    Ok(())
}

/// Runs `change` on the rulebook if `signer` signed and is the key `who` picks out of it.
fn as_keyholder(
    program_id: &Address,
    signer: &AccountView,
    book: &mut AccountView,
    who: impl FnOnce(&Rulebook) -> ([u8; 32], Refusal),
    change: impl FnOnce(&mut Rulebook) -> ProgramResult,
) -> ProgramResult {
    if !signer.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if !book.owned_by(program_id) {
        return Err(ProgramError::InvalidAccountOwner);
    }
    let mut data = book.try_borrow_mut()?;
    let book = Rulebook::cast_mut(&mut data).ok_or(ProgramError::InvalidAccountData)?;
    if book.version != VERSION {
        return Err(ProgramError::InvalidAccountData);
    }
    let (key, refusal) = who(book);
    if key != *signer.address().as_array() {
        return Err(refusal.into());
    }
    change(book)
}

fn as_guardian(
    program_id: &Address,
    guardian: &AccountView,
    book: &mut AccountView,
    change: impl FnOnce(&mut Rulebook) -> ProgramResult,
) -> ProgramResult {
    as_keyholder(program_id, guardian, book, |book| (book.guardian, Refusal::NotGuardian), change)
}

/// The agent rewrites the rules.
///
/// Accounts: agent (signer), rulebook (writable).
/// Data: a [`Change`], then a 32-byte note.
fn set_rules(program_id: &Address, accounts: &mut [AccountView], data: &[u8]) -> ProgramResult {
    let [agent, book, ..] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    let (change, used) = Change::decode(data).ok_or(ProgramError::from(Refusal::BadRule))?;
    if data.len() != used + 32 {
        return Err(ProgramError::InvalidInstructionData);
    }
    let note = array(data, used)?;
    let now = Clock::get()?.unix_timestamp;
    as_keyholder(
        program_id,
        agent,
        book,
        |book| (book.agent, Refusal::NotAgent),
        |book| Ok(book.rewrite(&change, note, now)?),
    )
}

/// The guardian stops or restarts the agent. While paused the hook enforces nothing, so a
/// pause can only ever open the token up.
///
/// Accounts: guardian (signer), rulebook (writable). Data: one byte, non-zero to pause.
fn pause(program_id: &Address, accounts: &mut [AccountView], data: &[u8]) -> ProgramResult {
    let [guardian, book, ..] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    let [paused] = array(data, 0)?;
    as_guardian(program_id, guardian, book, |book| {
        book.paused = (paused != 0) as u8;
        Ok(())
    })
}

/// The guardian replaces the agent, the co-signer or the keeper.
///
/// Accounts: guardian (signer), rulebook (writable). Data: the new key.
fn set_key(
    program_id: &Address,
    accounts: &mut [AccountView],
    data: &[u8],
    field: impl FnOnce(&mut Rulebook) -> &mut [u8; 32],
) -> ProgramResult {
    let [guardian, book, ..] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    let key = array(data, 0)?;
    as_guardian(program_id, guardian, book, |book| {
        *field(book) = key;
        Ok(())
    })
}

/// The guardian hands over to another key, which signs too so the role cannot be sent to a
/// key nobody holds.
///
/// Accounts: guardian (signer), rulebook (writable), new guardian (signer).
fn set_guardian(program_id: &Address, accounts: &mut [AccountView]) -> ProgramResult {
    let [guardian, book, new_guardian, ..] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    if !new_guardian.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }
    let key = *new_guardian.address().as_array();
    as_guardian(program_id, guardian, book, |book| {
        book.guardian = key;
        Ok(())
    })
}

/// The keeper takes the trading fees out of the curve. Meteora hands them only to the address
/// its config names as fee claimer, and for this token that is the rulebook's own, so this
/// asks Meteora for them with the rulebook signing. They can only land in token accounts the
/// keeper owns: a claim is of no use to anybody else, even one the keeper was tricked into
/// signing. And the rulebook signs only for the curve of its own token: the mint the claim
/// names has to be the one the rulebook was written for.
///
/// Accounts: keeper (signer), then every account of Meteora's claim in Meteora's order (see
/// [`CLAIM_ACCOUNTS`]; the fee claimer among them is the rulebook), then the accounts the
/// token's hook wants in a transfer.
/// Data: the most to claim in the token, then the most to claim in SOL (8 bytes each). Both
/// are passed on as they are.
///
/// Only fees in SOL can come out this way, and the curve is set to take no others. Moving
/// fees in the token would have Token-2022 call this program's hook from inside this
/// program's own call, which Solana does not allow.
fn claim_fees(program_id: &Address, accounts: &mut [AccountView], data: &[u8]) -> ProgramResult {
    let [keeper, claim @ ..] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    let count = claim.len();
    if count < CLAIM_ACCOUNTS {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    if count > MAX_CLAIM_ACCOUNTS {
        return Err(ProgramError::InvalidArgument);
    }
    let amounts: &[u8; 16] = data.try_into().map_err(|_| ProgramError::InvalidInstructionData)?;

    if !keeper.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }
    let keeper_key = *keeper.address().as_array();
    let book = &claim[CLAIM_FEE_CLAIMER];
    if !book.owned_by(program_id) {
        return Err(ProgramError::InvalidAccountOwner);
    }
    let (mint_key, bump) = {
        let book_data = book.try_borrow()?;
        let book = Rulebook::cast(&book_data).ok_or(ProgramError::InvalidAccountData)?;
        if book.version != VERSION {
            return Err(ProgramError::InvalidAccountData);
        }
        if book.keeper != keeper_key {
            return Err(Refusal::NotKeeper.into());
        }
        (book.mint, book.bump)
    };
    // The rulebook signs for a claim on its own token's curve and on no other. Anybody can
    // make a curve for a token of theirs whose config names this rulebook as fee claimer, and
    // that token's hook program would then be called with the rulebook signing and accounts
    // of the caller's choosing. Meteora, for its part, refuses a pool that is not this mint's.
    if *claim[CLAIM_MINT].address().as_array() != mint_key {
        return Err(ProgramError::InvalidAccountData);
    }
    // The call below goes to Meteora whatever is passed here: its address is written in this
    // program. A caller who put another program in its place is told so.
    if claim[CLAIM_PROGRAM].address() != &METEORA_DBC {
        return Err(ProgramError::IncorrectProgramId);
    }
    for destination in [&claim[CLAIM_TOKEN_DESTINATION], &claim[CLAIM_SOL_DESTINATION]] {
        let is_token_account = destination.owned_by(&TOKEN_2022) || destination.owned_by(&TOKEN);
        if !is_token_account || token_owner(destination)? != keeper_key {
            return Err(Refusal::NotKeepersAccount.into());
        }
    }

    // Meteora's instruction: its 8 bytes, the two amounts, then which of the accounts after
    // its own are for the token's hook, as a list of (kind, how many). Kind 0 is "for a
    // transfer of the token"; with no such accounts the list is empty.
    let hook_accounts = count - CLAIM_ACCOUNTS;
    let mut call = [0; 8 + 16 + 4 + 2];
    call[..8].copy_from_slice(&CLAIM_TRADING_FEE2);
    call[8..24].copy_from_slice(amounts);
    let len = if hook_accounts == 0 {
        28
    } else {
        call[24] = 1;
        call[29] = hook_accounts as u8;
        30
    };
    // The pool, the two destinations and the two vaults are written to; the fee claimer signs.
    // Past the last account given the array repeats it, and that part is never used.
    let metas: [InstructionAccount; MAX_CLAIM_ACCOUNTS] = core::array::from_fn(|i| {
        InstructionAccount::new(claim[i.min(count - 1)].address(), (2..=6).contains(&i), i == CLAIM_FEE_CLAIMER)
    });
    let instruction = InstructionView { program_id: &METEORA_DBC, accounts: &metas[..count], data: &call[..len] };
    let bump = [bump];
    let seeds = [Seed::from(RULEBOOK_SEED), Seed::from(&mint_key), Seed::from(&bump)];
    invoke_signed_with_bounds::<MAX_CLAIM_ACCOUNTS, _>(&instruction, claim, &[Signer::from(&seeds)])
}

/// The agent switches the token to another of the names written at launch, as part of an
/// edict. The rulebook's own address holds the right to edit the token's metadata, so no
/// key can put any other name on the token.
///
/// Accounts: agent (signer), rulebook (writable), mint (writable), Token-2022.
/// Data: one byte, the number of the name.
fn set_name(program_id: &Address, accounts: &mut [AccountView], data: &[u8]) -> ProgramResult {
    let [agent, book, mint, _token_program, ..] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    let [index] = data else {
        return Err(ProgramError::InvalidInstructionData);
    };
    let now = Clock::get()?.unix_timestamp;
    let mint_key = *mint.address().as_array();
    let (mut name, mut symbol) = ([0; NAME_LEN], [0; SYMBOL_LEN]);
    let (mut name_len, mut symbol_len, mut bump) = (0, 0, 0);
    as_keyholder(
        program_id,
        agent,
        book,
        |book| (book.agent, Refusal::NotAgent),
        |book| {
            if book.mint != mint_key {
                return Err(ProgramError::InvalidAccountData);
            }
            book.rename(*index, now)?;
            let (new_name, new_symbol) = book.name_at(*index).ok_or(ProgramError::from(Refusal::BadName))?;
            name[..new_name.len()].copy_from_slice(new_name);
            symbol[..new_symbol.len()].copy_from_slice(new_symbol);
            (name_len, symbol_len, bump) = (new_name.len(), new_symbol.len(), book.bump);
            Ok(())
        },
    )?;

    // The rulebook is no longer borrowed here: Token-2022 is about to read it as a signer.
    let bump = [bump];
    let seeds = [Seed::from(RULEBOOK_SEED), Seed::from(&mint_key), Seed::from(&bump)];
    update_field(mint, book, FIELD_NAME, &name[..name_len], &seeds)?;
    update_field(mint, book, FIELD_SYMBOL, &symbol[..symbol_len], &seeds)
}

/// Asks Token-2022 to put `value` in one field of the mint's metadata, signed by the rulebook.
/// Token-2022 resizes the mint itself; the lamports for a longer name are put there at launch.
fn update_field(mint: &AccountView, book: &AccountView, field: u8, value: &[u8], seeds: &[Seed; 3]) -> ProgramResult {
    // the instruction's own 8 bytes, the field's number, then the text behind its length
    let mut data = [0; 8 + 1 + 4 + NAME_LEN];
    let len = 13 + value.len();
    data[..8].copy_from_slice(&UPDATE_FIELD);
    data[8] = field;
    data[9..13].copy_from_slice(&(value.len() as u32).to_le_bytes());
    data.get_mut(13..len).ok_or(ProgramError::InvalidInstructionData)?.copy_from_slice(value);
    let accounts = [InstructionAccount::writable(mint.address()), InstructionAccount::readonly_signer(book.address())];
    let instruction = InstructionView { program_id: &TOKEN_2022, accounts: &accounts, data: &data[..len] };
    invoke_signed(&instruction, &[mint, book], &[Signer::from(seeds)])
}
