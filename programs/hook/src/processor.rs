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

use {
    crate::state::{
        Change, Limits, Refusal, Rulebook, Transfer, NO_KEY, RULEBOOK_LEN, RULEBOOK_SEED, VALIDATION_SEED, VERSION,
    },
    pinocchio::{
        cpi::{Seed, Signer},
        error::ProgramError,
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
}

/// Meteora DBC's pool authority. It owns the token vault of every curve, so tokens leaving an
/// account it owns are a buy and tokens arriving in one are a sell.
pub const POOL_AUTHORITY: Address = Address::from_str_const("FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM");

/// The validation account lists two extra accounts: the rulebook and the Instructions sysvar.
const EXTRA_ACCOUNTS: usize = 2;
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

/// Token account layout: mint at 0, owner at 32, amount at 64.
fn token_owner(account: &AccountView) -> Result<[u8; 32], ProgramError> {
    let data = account.try_borrow()?;
    data.get(32..64).and_then(|bytes| bytes.try_into().ok()).ok_or(ProgramError::InvalidAccountData)
}

fn token_amount(account: &AccountView) -> Result<u64, ProgramError> {
    let data = account.try_borrow()?;
    let bytes = data.get(64..72).and_then(|bytes| bytes.try_into().ok()).ok_or(ProgramError::InvalidAccountData)?;
    Ok(u64::from_le_bytes(bytes))
}

/// Mint layout: supply at 36.
fn mint_supply(mint: &AccountView) -> Result<u64, ProgramError> {
    let data = mint.try_borrow()?;
    let bytes = data.get(36..44).and_then(|bytes| bytes.try_into().ok()).ok_or(ProgramError::InvalidAccountData)?;
    Ok(u64::from_le_bytes(bytes))
}

/// Whether `cosigner` signed this transaction. The app signs a top-level instruction of its
/// own next to the swap (it pays for the buyer's token account), not the swap itself, so every
/// top-level instruction is looked at.
fn cosigned(ixs: &AccountView, cosigner: &[u8; 32]) -> Result<bool, ProgramError> {
    let ixs = Instructions::try_from(ixs)?;
    for i in 0..ixs.num_instructions() {
        let ix = ixs.load_instruction_at(i)?;
        for j in 0..ix.num_account_metas() {
            let account = ix.get_instruction_account_at(j)?;
            if account.is_signer() && account.key.as_array() == cosigner {
                return Ok(true);
            }
        }
    }
    Ok(false)
}

/// The hook. Token-2022 has already moved the tokens when it calls this; an error undoes the
/// whole transfer.
///
/// Accounts: source, mint, destination, authority, validation account, rulebook, Instructions
/// sysvar. It writes nothing, so calling it outside a transfer achieves nothing.
fn execute(program_id: &Address, accounts: &mut [AccountView], data: &[u8]) -> ProgramResult {
    let [source, mint, dest, _authority, _validation, book, ixs, ..] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    let amount = u64::from_le_bytes(array(data, 0)?);

    // A holder can always sell: this comes before any rule is even read.
    let receiver = token_owner(dest)?;
    if receiver == *POOL_AUTHORITY.as_array() {
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

    let rules = book.rules();
    let buy = token_owner(source)? == *POOL_AUTHORITY.as_array();
    if buy && rules.gate_open(Clock::get()?.unix_timestamp) && !cosigned(ixs, &book.cosigner)? {
        log("app-only window: this token can only be bought through the app right now");
        return Err(Refusal::NotCosigned.into());
    }
    let transfer = Transfer { buy, amount, supply: mint_supply(mint)?, held_after: token_amount(dest)? };
    rules.check_caps(&transfer).map_err(|refusal| {
        log(match refusal {
            Refusal::BuyTooLarge => "max buy: this buy is above the current cap",
            _ => "max wallet: the receiving wallet would hold more than the current cap",
        });
        refusal.into()
    })
}

/// Creates the token's rulebook and the validation account Token-2022 reads. The mint signs,
/// so nobody else can write the rulebook of a token before it launches.
///
/// Accounts: payer (signer, writable), mint (signer), validation account (writable), rulebook
/// (writable), system program.
/// Data: guardian, agent, cosigner, exempt (32 bytes each), [`Limits`], then the first rules
/// as a [`Change`] whose window must be zero.
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
    let limits = Limits::decode(&array(data, 128)?);
    let first = Change::decode(&array(data, 128 + Limits::LEN)?);
    if data.len() != 128 + Limits::LEN + Change::LEN || !limits.sane() || first.gate_secs != 0 {
        return Err(ProgramError::InvalidInstructionData);
    }
    limits.admit(&first, false)?;

    // Both accounts sit at their canonical address, so a token has exactly one rulebook.
    let mint_key = *mint.address().as_array();
    let (validation_key, validation_bump) = Address::find_program_address(&[VALIDATION_SEED, &mint_key], program_id);
    let (book_key, book_bump) = Address::find_program_address(&[RULEBOOK_SEED, &mint_key], program_id);
    if validation.address() != &validation_key || book.address() != &book_key {
        return Err(ProgramError::InvalidSeeds);
    }

    let bump = [validation_bump];
    let seeds = [Seed::from(VALIDATION_SEED), Seed::from(&mint_key), Seed::from(&bump)];
    create_account_with_minimum_balance_signed(validation, VALIDATION_LEN, program_id, payer, None, &[Signer::from(&seeds)])?;
    {
        // The list as the transfer-hook interface stores it: the instruction it is for, the
        // byte length of what follows, the number of entries, then the entries. Kind 0 is a
        // plain address. Both entries depend on the mint alone: routers resolve them without
        // knowing the buyer.
        let mut list = validation.try_borrow_mut()?;
        list[0..8].copy_from_slice(&EXECUTE);
        list[8..12].copy_from_slice(&((4 + EXTRA_ACCOUNTS * EXTRA_ACCOUNT_LEN) as u32).to_le_bytes());
        list[12..16].copy_from_slice(&(EXTRA_ACCOUNTS as u32).to_le_bytes());
        list[17..49].copy_from_slice(book_key.as_array());
        list[52..84].copy_from_slice(INSTRUCTIONS_ID.as_array());
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
    book.set_limits(&limits);
    book.set_rules(&first.rules(0));
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
    if data.len() != Change::LEN + 32 {
        return Err(ProgramError::InvalidInstructionData);
    }
    let change = Change::decode(&array(data, 0)?);
    let note = array(data, Change::LEN)?;
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

/// The guardian replaces the agent or the co-signer.
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
