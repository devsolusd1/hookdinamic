//! The rulebook account and the decisions taken from it. Nothing here touches the chain, so
//! it is tested as plain Rust.

/// The rulebook of a token sits at `["rules", mint]`.
pub const RULEBOOK_SEED: &[u8] = b"rules";
/// The account Token-2022 reads to learn which extra accounts the hook wants sits at
/// `["extra-account-metas", mint]`. The transfer-hook interface fixes that name.
pub const VALIDATION_SEED: &[u8] = b"extra-account-metas";

pub const VERSION: u8 = 1;
pub const BPS: u16 = 10_000;
pub const RULEBOOK_LEN: usize = 384;
pub const NO_KEY: [u8; 32] = [0; 32];

/// Why a transfer or a change was refused. The number is what wallets and explorers show.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u32)]
pub enum Refusal {
    /// A buy during an app-only window that the app's key did not sign.
    NotCosigned = 1,
    /// One buy above the current cap.
    BuyTooLarge = 2,
    /// The receiving wallet would hold more than the current cap.
    WalletTooLarge = 3,
    /// The signer is not the agent.
    NotAgent = 10,
    /// The signer is not the guardian.
    NotGuardian = 11,
    /// The guardian has paused the agent.
    Paused = 12,
    /// The last change is too recent.
    TooSoon = 13,
    /// A value outside the limits fixed at launch.
    OutsideLimits = 14,
    /// The fee split does not add up to 100%.
    BadSplit = 15,
}

/// How far the agent may go. Written once at launch; nobody can move it afterwards, the
/// guardian included.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Limits {
    /// Shortest time between two rule changes, in seconds.
    pub min_interval_secs: u32,
    /// Longest app-only window a single change may open, in seconds. Zero: never.
    pub max_gate_secs: u32,
    /// The tightest cap on one buy the agent may set, in bps of supply.
    pub min_max_buy_bps: u16,
    /// The tightest cap on one wallet the agent may set, in bps of supply.
    pub min_max_wallet_bps: u16,
    /// The largest share of the fees the agent may send to the treasury, in bps.
    pub max_treasury_bps: u16,
}

/// What the agent asks for in one change.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Change {
    /// Open an app-only window for this many seconds from now. Zero closes it.
    pub gate_secs: u32,
    /// Cap on one buy, in bps of supply. Zero: no cap.
    pub max_buy_bps: u16,
    /// Cap on what one wallet may hold, in bps of supply. Zero: no cap.
    pub max_wallet_bps: u16,
    /// Shares of the trading fees, in bps. They add up to 10,000.
    pub holders_bps: u16,
    pub burn_bps: u16,
    pub treasury_bps: u16,
}

/// The rules in force.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Rules {
    /// Buys need the co-signer until this moment. Zero or a past time: anyone may buy.
    pub gate_until: i64,
    pub max_buy_bps: u16,
    pub max_wallet_bps: u16,
    pub holders_bps: u16,
    pub burn_bps: u16,
    pub treasury_bps: u16,
}

/// What the hook knows about one transfer that is not a sell.
#[derive(Clone, Copy, Debug)]
pub struct Transfer {
    /// The tokens are leaving the curve.
    pub buy: bool,
    pub amount: u64,
    pub supply: u64,
    /// What the receiving account holds once this transfer has landed.
    pub held_after: u64,
}

fn u16_at(bytes: &[u8], at: usize) -> u16 {
    u16::from_le_bytes([bytes[at], bytes[at + 1]])
}

fn u32_at(bytes: &[u8], at: usize) -> u32 {
    u32::from_le_bytes([bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]])
}

impl Limits {
    pub const LEN: usize = 14;

    pub fn decode(bytes: &[u8; Self::LEN]) -> Self {
        Limits {
            min_interval_secs: u32_at(bytes, 0),
            max_gate_secs: u32_at(bytes, 4),
            min_max_buy_bps: u16_at(bytes, 8),
            min_max_wallet_bps: u16_at(bytes, 10),
            max_treasury_bps: u16_at(bytes, 12),
        }
    }

    pub fn encode(&self) -> [u8; Self::LEN] {
        let mut out = [0; Self::LEN];
        out[0..4].copy_from_slice(&self.min_interval_secs.to_le_bytes());
        out[4..8].copy_from_slice(&self.max_gate_secs.to_le_bytes());
        out[8..10].copy_from_slice(&self.min_max_buy_bps.to_le_bytes());
        out[10..12].copy_from_slice(&self.min_max_wallet_bps.to_le_bytes());
        out[12..14].copy_from_slice(&self.max_treasury_bps.to_le_bytes());
        out
    }

    /// Whether these limits make sense at all. Checked once, at launch.
    pub fn sane(&self) -> bool {
        self.min_max_buy_bps <= BPS && self.min_max_wallet_bps <= BPS && self.max_treasury_bps <= BPS
    }

    /// Whether the agent may make this change. `has_cosigner`: the rulebook names an app key,
    /// without which an app-only window would refuse every buy.
    pub fn admit(&self, change: &Change, has_cosigner: bool) -> Result<(), Refusal> {
        if change.gate_secs > self.max_gate_secs || (change.gate_secs > 0 && !has_cosigner) {
            return Err(Refusal::OutsideLimits);
        }
        let cap_ok = |cap: u16, floor: u16| cap == 0 || (cap >= floor && cap <= BPS);
        if !cap_ok(change.max_buy_bps, self.min_max_buy_bps) || !cap_ok(change.max_wallet_bps, self.min_max_wallet_bps) {
            return Err(Refusal::OutsideLimits);
        }
        let split = change.holders_bps as u32 + change.burn_bps as u32 + change.treasury_bps as u32;
        if split != BPS as u32 {
            return Err(Refusal::BadSplit);
        }
        if change.treasury_bps > self.max_treasury_bps {
            return Err(Refusal::OutsideLimits);
        }
        Ok(())
    }
}

impl Change {
    pub const LEN: usize = 14;

    pub fn decode(bytes: &[u8; Self::LEN]) -> Self {
        Change {
            gate_secs: u32_at(bytes, 0),
            max_buy_bps: u16_at(bytes, 4),
            max_wallet_bps: u16_at(bytes, 6),
            holders_bps: u16_at(bytes, 8),
            burn_bps: u16_at(bytes, 10),
            treasury_bps: u16_at(bytes, 12),
        }
    }

    pub fn encode(&self) -> [u8; Self::LEN] {
        let mut out = [0; Self::LEN];
        out[0..4].copy_from_slice(&self.gate_secs.to_le_bytes());
        out[4..6].copy_from_slice(&self.max_buy_bps.to_le_bytes());
        out[6..8].copy_from_slice(&self.max_wallet_bps.to_le_bytes());
        out[8..10].copy_from_slice(&self.holders_bps.to_le_bytes());
        out[10..12].copy_from_slice(&self.burn_bps.to_le_bytes());
        out[12..14].copy_from_slice(&self.treasury_bps.to_le_bytes());
        out
    }

    /// The rules this change puts in force at `now`.
    pub fn rules(&self, now: i64) -> Rules {
        Rules {
            gate_until: if self.gate_secs == 0 { 0 } else { now.saturating_add(self.gate_secs as i64) },
            max_buy_bps: self.max_buy_bps,
            max_wallet_bps: self.max_wallet_bps,
            holders_bps: self.holders_bps,
            burn_bps: self.burn_bps,
            treasury_bps: self.treasury_bps,
        }
    }
}

impl Rules {
    /// Whether buys need the co-signer right now. The window closes by the clock, so an agent
    /// that stops running cannot leave the token app-only.
    pub fn gate_open(&self, now: i64) -> bool {
        now < self.gate_until
    }

    pub fn check_caps(&self, t: &Transfer) -> Result<(), Refusal> {
        let over = |amount: u64, cap_bps: u16| {
            cap_bps > 0 && amount as u128 * BPS as u128 > t.supply as u128 * cap_bps as u128
        };
        if t.buy && over(t.amount, self.max_buy_bps) {
            return Err(Refusal::BuyTooLarge);
        }
        // Wallet-to-wallet sends count too, or one wallet could be filled through another.
        if over(t.held_after, self.max_wallet_bps) {
            return Err(Refusal::WalletTooLarge);
        }
        Ok(())
    }
}

/// The account, byte for byte. Every field is a byte or an array of bytes, so the struct has
/// no padding and can be read straight from account data. Numbers are little-endian.
///
/// | at  | len | field      |
/// |-----|-----|------------|
/// |   0 |   1 | version    |
/// |   1 |   1 | bump       |
/// |   2 |   1 | paused     |
/// |   8 |  32 | mint       |
/// |  40 |  32 | guardian   |
/// |  72 |  32 | agent      |
/// | 104 |  32 | cosigner   |
/// | 136 |  32 | exempt     |
/// | 168 |  14 | limits     |
/// | 184 |   8 | gate_until |
/// | 192 |  10 | caps and fee split: max_buy, max_wallet, holders, burn, treasury |
/// | 208 |   8 | epoch      |
/// | 216 |   8 | updated_at |
/// | 224 |  32 | note       |
#[repr(C)]
pub struct Rulebook {
    pub version: u8,
    pub bump: u8,
    /// Non-zero: the guardian has paused the agent, and the hook enforces nothing.
    pub paused: u8,
    _pad: [u8; 5],
    pub mint: [u8; 32],
    /// Can pause, and replace the agent and the co-signer. Cannot write rules.
    pub guardian: [u8; 32],
    /// The only key that can write rules.
    pub agent: [u8; 32],
    /// The app's signing key: a buy in an app-only window must carry its signature.
    pub cosigner: [u8; 32],
    /// An owner no rule applies to, fixed at launch: the vault that buys back with the fees.
    /// All zeros: nobody.
    pub exempt: [u8; 32],
    limits: [u8; 16],
    gate_until: [u8; 8],
    caps: [u8; 16],
    epoch: [u8; 8],
    updated_at: [u8; 8],
    /// Whatever the agent attaches to a change: the hash of the reasoning it published.
    pub note: [u8; 32],
    _reserved: [u8; 128],
}

const _: () = assert!(core::mem::size_of::<Rulebook>() == RULEBOOK_LEN);
const _: () = assert!(core::mem::align_of::<Rulebook>() == 1);

impl Rulebook {
    pub fn cast(data: &[u8]) -> Option<&Self> {
        if data.len() != RULEBOOK_LEN {
            return None;
        }
        // SAFETY: the length matches, the alignment is 1 and every bit pattern is a valid value.
        Some(unsafe { &*(data.as_ptr() as *const Self) })
    }

    pub fn cast_mut(data: &mut [u8]) -> Option<&mut Self> {
        if data.len() != RULEBOOK_LEN {
            return None;
        }
        // SAFETY: as in `cast`.
        Some(unsafe { &mut *(data.as_mut_ptr() as *mut Self) })
    }

    pub fn limits(&self) -> Limits {
        let mut bytes = [0; Limits::LEN];
        bytes.copy_from_slice(&self.limits[..Limits::LEN]);
        Limits::decode(&bytes)
    }

    pub fn set_limits(&mut self, limits: &Limits) {
        self.limits[..Limits::LEN].copy_from_slice(&limits.encode());
    }

    pub fn rules(&self) -> Rules {
        Rules {
            gate_until: i64::from_le_bytes(self.gate_until),
            max_buy_bps: u16_at(&self.caps, 0),
            max_wallet_bps: u16_at(&self.caps, 2),
            holders_bps: u16_at(&self.caps, 4),
            burn_bps: u16_at(&self.caps, 6),
            treasury_bps: u16_at(&self.caps, 8),
        }
    }

    pub fn set_rules(&mut self, rules: &Rules) {
        self.gate_until = rules.gate_until.to_le_bytes();
        self.caps[0..2].copy_from_slice(&rules.max_buy_bps.to_le_bytes());
        self.caps[2..4].copy_from_slice(&rules.max_wallet_bps.to_le_bytes());
        self.caps[4..6].copy_from_slice(&rules.holders_bps.to_le_bytes());
        self.caps[6..8].copy_from_slice(&rules.burn_bps.to_le_bytes());
        self.caps[8..10].copy_from_slice(&rules.treasury_bps.to_le_bytes());
    }

    /// How many times the rules have been rewritten.
    pub fn epoch(&self) -> u64 {
        u64::from_le_bytes(self.epoch)
    }

    /// When the agent last rewrote the rules. Zero: never.
    pub fn updated_at(&self) -> i64 {
        i64::from_le_bytes(self.updated_at)
    }

    pub fn has_cosigner(&self) -> bool {
        self.cosigner != NO_KEY
    }

    /// The agent rewrites the rules at `now`.
    pub fn rewrite(&mut self, change: &Change, note: [u8; 32], now: i64) -> Result<(), Refusal> {
        if self.paused != 0 {
            return Err(Refusal::Paused);
        }
        let limits = self.limits();
        if self.updated_at() != 0 && now < self.updated_at().saturating_add(limits.min_interval_secs as i64) {
            return Err(Refusal::TooSoon);
        }
        limits.admit(change, self.has_cosigner())?;
        self.set_rules(&change.rules(now));
        self.epoch = self.epoch().saturating_add(1).to_le_bytes();
        self.updated_at = now.to_le_bytes();
        self.note = note;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_800_000_000;
    const SUPPLY: u64 = 1_000_000_000_000_000;

    fn limits() -> Limits {
        Limits { min_interval_secs: 3_600, max_gate_secs: 6 * 3_600, min_max_buy_bps: 25, min_max_wallet_bps: 50, max_treasury_bps: 3_000 }
    }

    fn open() -> Change {
        Change { gate_secs: 0, max_buy_bps: 0, max_wallet_bps: 0, holders_bps: 5_000, burn_bps: 3_000, treasury_bps: 2_000 }
    }

    fn book() -> Rulebook {
        let mut data = [0u8; RULEBOOK_LEN];
        let book = Rulebook::cast_mut(&mut data).unwrap();
        book.version = VERSION;
        book.cosigner = [7; 32];
        book.set_limits(&limits());
        book.set_rules(&open().rules(NOW));
        // SAFETY: `Rulebook` is plain bytes of this exact length.
        unsafe { core::mem::transmute(data) }
    }

    #[test]
    fn the_layout_is_the_documented_one() {
        let mut data = [0u8; RULEBOOK_LEN];
        let book = Rulebook::cast_mut(&mut data).unwrap();
        book.mint = [1; 32];
        book.guardian = [2; 32];
        book.agent = [3; 32];
        book.cosigner = [4; 32];
        book.exempt = [5; 32];
        book.set_limits(&limits());
        book.rewrite(&Change { gate_secs: 600, max_buy_bps: 100, max_wallet_bps: 200, ..open() }, [9; 32], NOW).unwrap();
        for (at, byte) in [(8, 1), (40, 2), (72, 3), (104, 4), (136, 5), (224, 9)] {
            assert_eq!(data[at..at + 32], [byte; 32], "key at {at}");
        }
        assert_eq!(data[168..182], limits().encode());
        assert_eq!(data[184..192], (NOW + 600).to_le_bytes());
        assert_eq!(data[192..202], [100, 0, 200, 0, 0x88, 0x13, 0xb8, 0x0b, 0xd0, 0x07]);
        assert_eq!(data[208..216], 1u64.to_le_bytes());
        assert_eq!(data[216..224], NOW.to_le_bytes());
    }

    #[test]
    fn limits_and_changes_survive_encoding() {
        assert_eq!(Limits::decode(&limits().encode()), limits());
        let change = Change { gate_secs: 900, max_buy_bps: 100, max_wallet_bps: 250, ..open() };
        assert_eq!(Change::decode(&change.encode()), change);
    }

    #[test]
    fn the_agent_stays_inside_the_limits() {
        let l = limits();
        assert_eq!(l.admit(&open(), true), Ok(()));
        assert_eq!(l.admit(&Change { gate_secs: 6 * 3_600, ..open() }, true), Ok(()));
        assert_eq!(l.admit(&Change { gate_secs: 6 * 3_600 + 1, ..open() }, true), Err(Refusal::OutsideLimits));
        // an app-only window with no app key would refuse every buy
        assert_eq!(l.admit(&Change { gate_secs: 60, ..open() }, false), Err(Refusal::OutsideLimits));
        assert_eq!(l.admit(&Change { max_buy_bps: 25, ..open() }, true), Ok(()));
        assert_eq!(l.admit(&Change { max_buy_bps: 24, ..open() }, true), Err(Refusal::OutsideLimits));
        assert_eq!(l.admit(&Change { max_wallet_bps: 49, ..open() }, true), Err(Refusal::OutsideLimits));
        assert_eq!(l.admit(&Change { max_wallet_bps: 10_001, ..open() }, true), Err(Refusal::OutsideLimits));
        assert_eq!(l.admit(&Change { holders_bps: 5_001, ..open() }, true), Err(Refusal::BadSplit));
        assert_eq!(l.admit(&Change { holders_bps: 7_000, burn_bps: 0, treasury_bps: 3_000, ..open() }, true), Ok(()));
        assert_eq!(l.admit(&Change { holders_bps: 6_999, burn_bps: 0, treasury_bps: 3_001, ..open() }, true), Err(Refusal::OutsideLimits));
        // u16 shares that would wrap if added as u16
        assert_eq!(l.admit(&Change { holders_bps: 40_000, burn_bps: 35_536, treasury_bps: 0, ..open() }, true), Err(Refusal::BadSplit));
    }

    #[test]
    fn a_rewrite_waits_its_turn_and_respects_a_pause() {
        let mut b = book();
        let change = Change { max_buy_bps: 100, ..open() };
        assert_eq!(b.rewrite(&change, [1; 32], NOW), Ok(())); // the first one needs no wait
        assert_eq!((b.epoch(), b.updated_at(), b.rules().max_buy_bps), (1, NOW, 100));
        assert_eq!(b.rewrite(&open(), [2; 32], NOW + 3_599), Err(Refusal::TooSoon));
        assert_eq!(b.rules().max_buy_bps, 100, "a refused rewrite changes nothing");
        assert_eq!(b.rewrite(&open(), [2; 32], NOW + 3_600), Ok(()));
        assert_eq!((b.epoch(), b.note), (2, [2; 32]));
        b.paused = 1;
        assert_eq!(b.rewrite(&open(), [3; 32], NOW + 10 * 3_600), Err(Refusal::Paused));
    }

    #[test]
    fn the_gate_closes_by_the_clock() {
        let rules = Change { gate_secs: 600, ..open() }.rules(NOW);
        assert!(rules.gate_open(NOW) && rules.gate_open(NOW + 599));
        assert!(!rules.gate_open(NOW + 600));
        assert!(!open().rules(NOW).gate_open(NOW));
    }

    #[test]
    fn caps_are_shares_of_supply() {
        let rules = Change { max_buy_bps: 100, max_wallet_bps: 200, ..open() }.rules(NOW);
        let one_pct = SUPPLY / 100;
        let t = |buy, amount, held_after| Transfer { buy, amount, supply: SUPPLY, held_after };
        assert_eq!(rules.check_caps(&t(true, one_pct, one_pct)), Ok(()));
        assert_eq!(rules.check_caps(&t(true, one_pct + 1, one_pct + 1)), Err(Refusal::BuyTooLarge));
        assert_eq!(rules.check_caps(&t(true, one_pct, 2 * one_pct)), Ok(()));
        assert_eq!(rules.check_caps(&t(true, one_pct, 2 * one_pct + 1)), Err(Refusal::WalletTooLarge));
        // a wallet-to-wallet send is not a buy, but it still fills a wallet
        assert_eq!(rules.check_caps(&t(false, 2 * one_pct, 2 * one_pct)), Ok(()));
        assert_eq!(rules.check_caps(&t(false, one_pct, 2 * one_pct + 1)), Err(Refusal::WalletTooLarge));
        assert_eq!(open().rules(NOW).check_caps(&t(true, SUPPLY, SUPPLY)), Ok(()));
    }
}
