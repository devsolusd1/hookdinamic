//! The rulebook account and the decisions taken from it. Nothing here touches the chain, so
//! it is tested as plain Rust.
//!
//! A rule is a short list of conditions about one buy. The conditions are sorted into groups:
//! a buy goes through if, in at least one group, every condition holds. A rule with no
//! conditions lets every buy through. That is the whole language: it cannot loop, it cannot
//! write anything, and all it can ever do is refuse a buy.

/// The rulebook of a token sits at `["rules", mint]`.
pub const RULEBOOK_SEED: &[u8] = b"rules";
/// The account Token-2022 reads to learn which extra accounts the hook wants sits at
/// `["extra-account-metas", mint]`. The transfer-hook interface fixes that name.
pub const VALIDATION_SEED: &[u8] = b"extra-account-metas";

pub const VERSION: u8 = 4;
pub const BPS: u16 = 10_000;
pub const RULEBOOK_LEN: usize = 896;
pub const NO_KEY: [u8; 32] = [0; 32];

/// The most names a token can go by. They are written at launch and never added to.
pub const MAX_NAMES: usize = 8;
/// How long a name and a ticker may be, in bytes of text.
pub const NAME_LEN: usize = 32;
pub const SYMBOL_LEN: usize = 10;
/// One name as the rulebook stores it: the name, the ticker, two spare bytes. Text shorter
/// than its field is followed by zeros.
pub const NAME_ENTRY_LEN: usize = 44;

/// The most conditions one rule may hold, and the most groups they may form.
pub const MAX_CONDITIONS: usize = 16;
pub const MAX_GROUPS: u8 = 4;
/// Shares of the supply are counted in millionths, so a rule can speak of a thousandth of a percent.
pub const MILLIONTHS: u64 = 1_000_000;

/// Why a transfer or a change was refused. The number is what wallets and explorers show.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u32)]
pub enum Refusal {
    /// A buy that fits none of the groups of the rule in force.
    NotAllowed = 1,
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
    /// A rule the hook could not evaluate.
    BadRule = 16,
    /// A name the token does not have, or the one it already goes by.
    BadName = 17,
    /// A name changes only together with an edict, and none was written just now.
    NoEdict = 18,
    /// The signer is not the keeper.
    NotKeeper = 19,
    /// Fees were asked to be sent to an account that is not a token account of the keeper.
    NotKeepersAccount = 20,
}

/// The text in a field padded with zeros: not empty, readable, with no control characters.
pub fn text(field: &[u8]) -> Option<&[u8]> {
    let len = field.iter().position(|&byte| byte == 0).unwrap_or(field.len());
    let (text, padding) = field.split_at(len);
    let fine = len > 0
        && padding.iter().all(|&byte| byte == 0)
        && text.iter().all(|&byte| byte >= 0x20 && byte != 0x7f)
        && core::str::from_utf8(text).is_ok();
    fine.then_some(text)
}

/// The name and the ticker in one stored entry, if both are fit to put on a token.
pub fn name_entry(entry: &[u8]) -> Option<(&[u8], &[u8])> {
    Some((text(entry.get(..NAME_LEN)?)?, text(entry.get(NAME_LEN..NAME_LEN + SYMBOL_LEN)?)?))
}

/// What a rule can look at in one buy. Every fact is a whole number.
pub mod fact {
    /// The size of this buy, in millionths of the supply.
    pub const SIZE: u8 = 0;
    /// What the buying account held before this buy, in millionths of the supply.
    pub const HELD_BEFORE: u8 = 1;
    /// What it holds once the buy has landed, in millionths of the supply.
    pub const HELD_AFTER: u8 = 2;
    /// Minute of the hour, 0 to 59, UTC.
    pub const MINUTE: u8 = 3;
    /// Hour of the day, 0 to 23, UTC.
    pub const HOUR: u8 = 4;
    /// Day of the week, 0 for Sunday to 6 for Saturday, UTC.
    pub const WEEKDAY: u8 = 5;
    /// Seconds since the rule was written.
    pub const ELAPSED: u8 = 6;
    /// 1 if the app's key signed the transaction, 0 if not.
    pub const VIA_APP: u8 = 7;
    /// The priority fee the transaction set, in micro-lamports per compute unit.
    pub const PRIORITY: u8 = 8;
    /// SOL sitting in the curve, in thousandths of a SOL.
    pub const CURVE_SOL: u8 = 9;
    /// A number from 0 to 99 that depends on the slot and on the buying account.
    pub const LUCK: u8 = 10;
    pub const COUNT: usize = 11;
}

pub type Facts = [u64; fact::COUNT];

/// How a fact is compared with the condition's value.
pub mod op {
    pub const LT: u8 = 0;
    pub const LE: u8 = 1;
    pub const GT: u8 = 2;
    pub const GE: u8 = 3;
    pub const EQ: u8 = 4;
    pub const NE: u8 = 5;
    /// The fact, divided by a modulus, leaves a given remainder. The value holds the modulus
    /// in its upper 32 bits and the remainder in its lower 32.
    pub const MOD_EQ: u8 = 6;
}

/// One comparison: a fact, an operator and a number. Twelve bytes on chain.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Condition {
    pub group: u8,
    pub fact: u8,
    pub op: u8,
    pub value: u64,
}

impl Condition {
    pub const LEN: usize = 12;
    pub const NONE: Condition = Condition { group: 0, fact: 0, op: 0, value: 0 };

    pub fn decode(bytes: &[u8]) -> Self {
        let mut value = [0; 8];
        value.copy_from_slice(&bytes[4..12]);
        Condition { group: bytes[0], fact: bytes[1], op: bytes[2], value: u64::from_le_bytes(value) }
    }

    pub fn encode(&self) -> [u8; Self::LEN] {
        let mut out = [0; Self::LEN];
        out[0] = self.group;
        out[1] = self.fact;
        out[2] = self.op;
        out[4..12].copy_from_slice(&self.value.to_le_bytes());
        out
    }

    /// Whether the hook can evaluate this condition at all.
    pub fn well_formed(&self) -> bool {
        self.group < MAX_GROUPS
            && (self.fact as usize) < fact::COUNT
            && self.op <= op::MOD_EQ
            && (self.op != op::MOD_EQ || self.value >> 32 != 0)
    }

    pub fn holds(&self, facts: &Facts) -> bool {
        let Some(&seen) = facts.get(self.fact as usize) else {
            return false;
        };
        match self.op {
            op::LT => seen < self.value,
            op::LE => seen <= self.value,
            op::GT => seen > self.value,
            op::GE => seen >= self.value,
            op::EQ => seen == self.value,
            op::NE => seen != self.value,
            op::MOD_EQ => match self.value >> 32 {
                0 => false,
                modulus => seen % modulus == self.value & 0xffff_ffff,
            },
            _ => false,
        }
    }
}

/// Whether a buy with these facts goes through: with no conditions, always; otherwise when
/// one group has all of its conditions hold.
pub fn admits(conditions: &[Condition], facts: &Facts) -> bool {
    if conditions.is_empty() {
        return true;
    }
    (0..MAX_GROUPS).any(|group| {
        let mut members = conditions.iter().filter(|c| c.group == group).peekable();
        members.peek().is_some() && members.all(|c| c.holds(facts))
    })
}

/// Whether any condition looks at `fact`. Some facts cost a read to work out.
pub fn looks_at(conditions: &[Condition], fact: u8) -> bool {
    conditions.iter().any(|c| c.fact == fact)
}

fn u16_at(bytes: &[u8], at: usize) -> u16 {
    u16::from_le_bytes([bytes[at], bytes[at + 1]])
}

fn u32_at(bytes: &[u8], at: usize) -> u32 {
    u32::from_le_bytes([bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]])
}

/// How far the agent may go. Written once at launch; nobody can move it afterwards, the
/// guardian included.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Limits {
    /// Shortest time between two edicts, in seconds.
    pub min_interval_secs: u32,
    /// Longest an edict may stand, in seconds. After that every buy goes through until the
    /// agent writes again, so a rule nobody can satisfy cannot outlive this.
    pub max_rule_secs: u32,
    /// The smallest share of the fees the agent may leave the treasury, in bps.
    pub min_treasury_bps: u16,
    /// The largest share of the fees the agent may send to the treasury, in bps.
    pub max_treasury_bps: u16,
    /// Shortest time between two changes of the token's name, in seconds.
    pub min_rename_secs: u32,
}

impl Limits {
    pub const LEN: usize = 16;

    /// The floor for the treasury comes last: it was added after the other four, in bytes
    /// that had been spare, so nothing before it moved.
    pub fn decode(bytes: &[u8; Self::LEN]) -> Self {
        Limits {
            min_interval_secs: u32_at(bytes, 0),
            max_rule_secs: u32_at(bytes, 4),
            max_treasury_bps: u16_at(bytes, 8),
            min_rename_secs: u32_at(bytes, 10),
            min_treasury_bps: u16_at(bytes, 14),
        }
    }

    pub fn encode(&self) -> [u8; Self::LEN] {
        let mut out = [0; Self::LEN];
        out[0..4].copy_from_slice(&self.min_interval_secs.to_le_bytes());
        out[4..8].copy_from_slice(&self.max_rule_secs.to_le_bytes());
        out[8..10].copy_from_slice(&self.max_treasury_bps.to_le_bytes());
        out[10..14].copy_from_slice(&self.min_rename_secs.to_le_bytes());
        out[14..16].copy_from_slice(&self.min_treasury_bps.to_le_bytes());
        out
    }

    /// Whether these limits make sense at all. Checked once, at launch.
    pub fn sane(&self) -> bool {
        self.min_treasury_bps <= self.max_treasury_bps && self.max_treasury_bps <= BPS
    }

    /// Whether the treasury may be given this share of the fees: no less than its floor, no
    /// more than its cap. Asked of the opening split and of every edict's.
    pub fn treasury_fits(&self, treasury_bps: u16) -> bool {
        (self.min_treasury_bps..=self.max_treasury_bps).contains(&treasury_bps)
    }

    /// Whether the agent may make this change. `has_cosigner`: the rulebook names an app key,
    /// without which a rule about the app could never be met.
    pub fn admit(&self, change: &Change, has_cosigner: bool) -> Result<(), Refusal> {
        let conditions = change.conditions();
        if !conditions.iter().all(Condition::well_formed) || (!has_cosigner && looks_at(conditions, fact::VIA_APP)) {
            return Err(Refusal::BadRule);
        }
        // Every edict has a term, a rule or none: it says when the next one is due.
        if change.rule_secs == 0 || change.rule_secs > self.max_rule_secs {
            return Err(Refusal::OutsideLimits);
        }
        if !split_adds_up(change.holders_bps, change.burn_bps, change.treasury_bps) {
            return Err(Refusal::BadSplit);
        }
        if !self.treasury_fits(change.treasury_bps) {
            return Err(Refusal::OutsideLimits);
        }
        Ok(())
    }
}

pub fn split_adds_up(holders_bps: u16, burn_bps: u16, treasury_bps: u16) -> bool {
    holders_bps as u32 + burn_bps as u32 + treasury_bps as u32 == BPS as u32
}

/// What the agent asks for in one edict: a rule, how long it stands, and where the fees go
/// from now on.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Change {
    /// How long the edict stands, in seconds. With no conditions it restricts nothing, and
    /// the term only says when the next edict is due.
    pub rule_secs: u32,
    /// Shares of the trading fees, in bps. They add up to 10,000.
    pub holders_bps: u16,
    pub burn_bps: u16,
    pub treasury_bps: u16,
    count: u8,
    conditions: [Condition; MAX_CONDITIONS],
}

impl Change {
    /// The fixed part: duration, the three shares, the number of conditions.
    pub const HEAD_LEN: usize = 11;
    pub const MAX_LEN: usize = Self::HEAD_LEN + MAX_CONDITIONS * Condition::LEN;

    /// `None` if there are more conditions than a rule may hold.
    pub fn new(rule_secs: u32, split: (u16, u16, u16), rule: &[Condition]) -> Option<Self> {
        if rule.len() > MAX_CONDITIONS {
            return None;
        }
        let mut conditions = [Condition::NONE; MAX_CONDITIONS];
        conditions[..rule.len()].copy_from_slice(rule);
        Some(Change { rule_secs, holders_bps: split.0, burn_bps: split.1, treasury_bps: split.2, count: rule.len() as u8, conditions })
    }

    pub fn conditions(&self) -> &[Condition] {
        &self.conditions[..self.count as usize]
    }

    /// Reads a change from the front of `data` and says how many bytes it took.
    pub fn decode(data: &[u8]) -> Option<(Self, usize)> {
        let head = data.get(..Self::HEAD_LEN)?;
        let count = head[10] as usize;
        let len = Self::HEAD_LEN + count * Condition::LEN;
        if count > MAX_CONDITIONS || data.len() < len {
            return None;
        }
        let mut conditions = [Condition::NONE; MAX_CONDITIONS];
        for (i, slot) in conditions.iter_mut().take(count).enumerate() {
            let at = Self::HEAD_LEN + i * Condition::LEN;
            *slot = Condition::decode(&data[at..at + Condition::LEN]);
        }
        let change = Change {
            rule_secs: u32_at(head, 0),
            holders_bps: u16_at(head, 4),
            burn_bps: u16_at(head, 6),
            treasury_bps: u16_at(head, 8),
            count: count as u8,
            conditions,
        };
        Some((change, len))
    }

    /// The bytes of this change and how many of them are used.
    pub fn encode(&self) -> ([u8; Self::MAX_LEN], usize) {
        let mut out = [0; Self::MAX_LEN];
        out[0..4].copy_from_slice(&self.rule_secs.to_le_bytes());
        out[4..6].copy_from_slice(&self.holders_bps.to_le_bytes());
        out[6..8].copy_from_slice(&self.burn_bps.to_le_bytes());
        out[8..10].copy_from_slice(&self.treasury_bps.to_le_bytes());
        out[10] = self.count;
        for (i, condition) in self.conditions().iter().enumerate() {
            let at = Self::HEAD_LEN + i * Condition::LEN;
            out[at..at + Condition::LEN].copy_from_slice(&condition.encode());
        }
        (out, Self::HEAD_LEN + self.count as usize * Condition::LEN)
    }
}

/// The account, byte for byte. Every field is a byte or an array of bytes, so the struct has
/// no padding and can be read straight from account data. Numbers are little-endian.
///
/// | at  | len | field        |
/// |-----|-----|--------------|
/// |   0 |   1 | version      |
/// |   1 |   1 | bump         |
/// |   2 |   1 | paused       |
/// |   8 |  32 | mint         |
/// |  40 |  32 | guardian     |
/// |  72 |  32 | agent        |
/// | 104 |  32 | cosigner     |
/// | 136 |  32 | exempt       |
/// | 168 |  32 | curve_vault  |
/// | 200 |  16 | limits: shortest interval (4), longest term (4), treasury cap (2), shortest stay of a name (4), treasury floor (2) |
/// | 216 |   8 | rule_until   |
/// | 224 |   6 | fee split: holders, burn, treasury |
/// | 232 |   8 | epoch        |
/// | 240 |   8 | updated_at   |
/// | 248 |  32 | note         |
/// | 280 |   1 | rule_count   |
/// | 288 | 192 | conditions, 12 bytes each: group, fact, op, a spare byte, value |
/// | 480 |   1 | name: which of the names below the token goes by |
/// | 481 |   1 | name_count   |
/// | 488 |   8 | renamed_at   |
/// | 512 | 352 | names, 44 bytes each: name (32), ticker (10), two spare bytes |
/// | 864 |  32 | keeper       |
#[repr(C)]
pub struct Rulebook {
    pub version: u8,
    pub bump: u8,
    /// Non-zero: the guardian has paused the agent, and the hook enforces nothing.
    pub paused: u8,
    _pad: [u8; 5],
    pub mint: [u8; 32],
    /// Can pause, and replace the agent, the co-signer and the keeper. Cannot write rules.
    pub guardian: [u8; 32],
    /// The only key that can write rules.
    pub agent: [u8; 32],
    /// The app's signing key: what the "via app" fact looks for among a transaction's signers.
    pub cosigner: [u8; 32],
    /// An owner no rule applies to, fixed at launch: the vault that buys back with the fees.
    /// All zeros: nobody.
    pub exempt: [u8; 32],
    /// The token account holding the curve's SOL, read for the "SOL in the curve" fact.
    pub curve_vault: [u8; 32],
    limits: [u8; Limits::LEN],
    rule_until: [u8; 8],
    split: [u8; 8],
    epoch: [u8; 8],
    updated_at: [u8; 8],
    /// Whatever the agent attaches to a change: the hash of the text it published.
    pub note: [u8; 32],
    rule_count: u8,
    _pad2: [u8; 7],
    conditions: [u8; MAX_CONDITIONS * Condition::LEN],
    /// Which of its names the token goes by now. The rulebook holds the right to edit the
    /// token's metadata, so this is the only place a name can be changed from.
    pub name: u8,
    pub name_count: u8,
    _pad3: [u8; 6],
    renamed_at: [u8; 8],
    _reserved: [u8; 16],
    names: [u8; MAX_NAMES * NAME_ENTRY_LEN],
    /// The only key that may ask for the trading fees. The curve names this rulebook's own
    /// address as the one that claims them, so no key holds that right for good: the keeper
    /// asks through the program, and the guardian can replace it. It sits in what were the
    /// last 32 spare bytes, so nothing before it moved.
    pub keeper: [u8; 32],
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
        Limits::decode(&self.limits)
    }

    pub fn set_limits(&mut self, limits: &Limits) {
        self.limits = limits.encode();
    }

    /// Holders, burn, treasury, in bps.
    pub fn split(&self) -> (u16, u16, u16) {
        (u16_at(&self.split, 0), u16_at(&self.split, 2), u16_at(&self.split, 4))
    }

    pub fn set_split(&mut self, holders_bps: u16, burn_bps: u16, treasury_bps: u16) {
        self.split[0..2].copy_from_slice(&holders_bps.to_le_bytes());
        self.split[2..4].copy_from_slice(&burn_bps.to_le_bytes());
        self.split[4..6].copy_from_slice(&treasury_bps.to_le_bytes());
    }

    /// The conditions of the rule as last written, and how many of them there are.
    pub fn rule(&self) -> ([Condition; MAX_CONDITIONS], usize) {
        let count = (self.rule_count as usize).min(MAX_CONDITIONS);
        let mut conditions = [Condition::NONE; MAX_CONDITIONS];
        for (i, slot) in conditions.iter_mut().take(count).enumerate() {
            *slot = Condition::decode(&self.conditions[i * Condition::LEN..(i + 1) * Condition::LEN]);
        }
        (conditions, count)
    }

    /// The moment the edict's term ends: its rule stops applying and the next edict is due.
    /// Zero before the first edict.
    pub fn rule_until(&self) -> i64 {
        i64::from_le_bytes(self.rule_until)
    }

    /// Whether a rule stands between a buyer and the curve right now. It lapses by the clock,
    /// so an agent that stops running cannot leave buying closed.
    pub fn rule_in_force(&self, now: i64) -> bool {
        self.rule_count > 0 && now < self.rule_until()
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

        let conditions = change.conditions();
        self.rule_count = conditions.len() as u8;
        self.conditions = [0; MAX_CONDITIONS * Condition::LEN];
        for (i, condition) in conditions.iter().enumerate() {
            self.conditions[i * Condition::LEN..(i + 1) * Condition::LEN].copy_from_slice(&condition.encode());
        }
        self.rule_until = now.saturating_add(change.rule_secs as i64).to_le_bytes();
        self.set_split(change.holders_bps, change.burn_bps, change.treasury_bps);
        self.epoch = self.epoch().saturating_add(1).to_le_bytes();
        self.updated_at = now.to_le_bytes();
        self.note = note;
        Ok(())
    }

    /// Writes the names a token can go by, at launch. It starts under the first. `false` if
    /// there are none, too many, or one that is not fit to put on a token.
    pub fn set_names(&mut self, entries: &[u8]) -> bool {
        let count = entries.len() / NAME_ENTRY_LEN;
        let fine = entries.len() % NAME_ENTRY_LEN == 0 && (1..=MAX_NAMES).contains(&count) && entries.chunks(NAME_ENTRY_LEN).all(|entry| name_entry(entry).is_some());
        if fine {
            self.names[..entries.len()].copy_from_slice(entries);
            self.name_count = count as u8;
            self.name = 0;
        }
        fine
    }

    /// Name number `index` and its ticker.
    pub fn name_at(&self, index: u8) -> Option<(&[u8], &[u8])> {
        if index >= self.name_count {
            return None;
        }
        let at = index as usize * NAME_ENTRY_LEN;
        name_entry(self.names.get(at..at + NAME_ENTRY_LEN)?)
    }

    /// Since when the token has gone by its current name: its launch, or the last change.
    pub fn renamed_at(&self) -> i64 {
        i64::from_le_bytes(self.renamed_at)
    }

    pub fn set_renamed_at(&mut self, now: i64) {
        self.renamed_at = now.to_le_bytes();
    }

    /// The agent switches the token to another of its names at `now`. A name changes only as
    /// part of an edict, so one has to have been written at this same moment.
    pub fn rename(&mut self, index: u8, now: i64) -> Result<(), Refusal> {
        if self.paused != 0 {
            return Err(Refusal::Paused);
        }
        if index >= self.name_count || index == self.name {
            return Err(Refusal::BadName);
        }
        if self.updated_at() != now {
            return Err(Refusal::NoEdict);
        }
        if now < self.renamed_at().saturating_add(self.limits().min_rename_secs as i64) {
            return Err(Refusal::TooSoon);
        }
        self.name = index;
        self.set_renamed_at(now);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_800_000_000;
    const SPLIT: (u16, u16, u16) = (5_000, 3_000, 2_000);

    fn limits() -> Limits {
        Limits { min_interval_secs: 900, max_rule_secs: 2 * 3_600, min_treasury_bps: 1_000, max_treasury_bps: 3_000, min_rename_secs: 86_400 }
    }

    fn when(group: u8, fact: u8, op: u8, value: u64) -> Condition {
        Condition { group, fact, op, value }
    }

    fn entry(name: &[u8], symbol: &[u8]) -> [u8; NAME_ENTRY_LEN] {
        let mut out = [0; NAME_ENTRY_LEN];
        out[..name.len()].copy_from_slice(name);
        out[NAME_LEN..NAME_LEN + symbol.len()].copy_from_slice(symbol);
        out
    }

    /// Three names: Edict, Decree and Same Coin.
    fn names() -> [u8; 3 * NAME_ENTRY_LEN] {
        let mut out = [0; 3 * NAME_ENTRY_LEN];
        for (i, (name, symbol)) in [(&b"Edict"[..], &b"EDICT"[..]), (b"Decree", b"DECREE"), (b"Same Coin", b"SAME")].into_iter().enumerate() {
            out[i * NAME_ENTRY_LEN..(i + 1) * NAME_ENTRY_LEN].copy_from_slice(&entry(name, symbol));
        }
        out
    }

    fn facts(pairs: &[(u8, u64)]) -> Facts {
        let mut facts = [0; fact::COUNT];
        for &(fact, value) in pairs {
            facts[fact as usize] = value;
        }
        facts
    }

    fn book() -> Rulebook {
        let mut data = [0u8; RULEBOOK_LEN];
        let book = Rulebook::cast_mut(&mut data).unwrap();
        book.version = VERSION;
        book.cosigner = [7; 32];
        book.set_limits(&limits());
        book.set_split(SPLIT.0, SPLIT.1, SPLIT.2);
        assert!(book.set_names(&names()));
        book.set_renamed_at(NOW);
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
        book.curve_vault = [6; 32];
        book.keeper = [8; 32];
        book.set_limits(&limits());
        assert!(book.set_names(&names()));
        book.set_renamed_at(NOW - 86_400);
        let rule = [when(0, fact::SIZE, op::LE, 10_000), when(1, fact::MINUTE, op::MOD_EQ, 2 << 32)];
        book.rewrite(&Change::new(600, (4_000, 5_000, 1_000), &rule).unwrap(), [9; 32], NOW).unwrap();
        book.rename(2, NOW).unwrap();
        for (at, byte) in [(8, 1), (40, 2), (72, 3), (104, 4), (136, 5), (168, 6), (248, 9), (864, 8)] {
            assert_eq!(data[at..at + 32], [byte; 32], "key at {at}");
        }
        assert_eq!(data[200..216], limits().encode());
        assert_eq!(data[208..210], 3_000u16.to_le_bytes(), "the treasury's cap");
        assert_eq!(data[210..214], 86_400u32.to_le_bytes());
        assert_eq!(data[214..216], 1_000u16.to_le_bytes(), "the treasury's floor, in what were two spare bytes");
        assert_eq!((data[480], data[481]), (2, 3), "the name in use, and how many there are");
        assert_eq!(data[488..496], NOW.to_le_bytes());
        assert_eq!(data[512..512 + 3 * NAME_ENTRY_LEN], names());
        assert_eq!((&data[512..517], &data[544..549], &data[556..562]), (&b"Edict"[..], &b"EDICT"[..], &b"Decree"[..]));
        assert_eq!(data[216..224], (NOW + 600).to_le_bytes());
        assert_eq!(data[224..230], [0xa0, 0x0f, 0x88, 0x13, 0xe8, 0x03]);
        assert_eq!(data[232..240], 1u64.to_le_bytes());
        assert_eq!(data[240..248], NOW.to_le_bytes());
        assert_eq!(data[280], 2);
        assert_eq!(data[288..300], rule[0].encode());
        assert_eq!(data[300..312], rule[1].encode());
        assert_eq!(data[300..304], [1, fact::MINUTE, op::MOD_EQ, 0]);
    }

    #[test]
    fn changes_survive_encoding() {
        assert_eq!(Limits::decode(&limits().encode()), limits());
        let rule = [when(0, fact::VIA_APP, op::EQ, 1), when(3, fact::HELD_BEFORE, op::EQ, 0), when(3, fact::LUCK, op::LT, 30)];
        let change = Change::new(1_800, SPLIT, &rule).unwrap();
        let (bytes, len) = change.encode();
        assert_eq!(len, Change::HEAD_LEN + 3 * Condition::LEN);
        assert_eq!(Change::decode(&bytes[..len]), Some((change, len)));
        // a note or anything else may follow a change
        assert_eq!(Change::decode(&bytes).map(|(_, used)| used), Some(len));
        assert_eq!(Change::decode(&bytes[..len - 1]), None, "cut short");
        assert!(Change::new(0, SPLIT, &[Condition::NONE; MAX_CONDITIONS + 1]).is_none());
        let mut too_many = bytes;
        too_many[10] = MAX_CONDITIONS as u8 + 1;
        assert_eq!(Change::decode(&too_many), None);
    }

    #[test]
    fn a_condition_compares_one_fact() {
        let seen = facts(&[(fact::SIZE, 10_000), (fact::MINUTE, 7)]);
        for (op, value, holds) in [
            (op::LT, 10_001, true), (op::LT, 10_000, false),
            (op::LE, 10_000, true), (op::LE, 9_999, false),
            (op::GT, 9_999, true), (op::GT, 10_000, false),
            (op::GE, 10_000, true), (op::GE, 10_001, false),
            (op::EQ, 10_000, true), (op::EQ, 1, false),
            (op::NE, 1, true), (op::NE, 10_000, false),
        ] {
            assert_eq!(when(0, fact::SIZE, op, value).holds(&seen), holds, "op {op} against {value}");
        }
        // minute 7: odd, and 7 = 2 * 3 + 1
        assert!(when(0, fact::MINUTE, op::MOD_EQ, 2 << 32 | 1).holds(&seen));
        assert!(!when(0, fact::MINUTE, op::MOD_EQ, 2 << 32).holds(&seen));
        assert!(when(0, fact::MINUTE, op::MOD_EQ, 3 << 32 | 1).holds(&seen));
        // things the hook cannot evaluate never hold
        assert!(!when(0, fact::MINUTE, op::MOD_EQ, 1).holds(&seen), "a modulus of zero");
        assert!(!when(0, fact::COUNT as u8, op::EQ, 0).holds(&seen), "a fact that does not exist");
        assert!(!when(0, fact::SIZE, 7, 0).holds(&seen), "an operator that does not exist");
    }

    #[test]
    fn a_buy_needs_one_whole_group() {
        // either through the app, or a small first buy
        let rule = [when(0, fact::VIA_APP, op::EQ, 1), when(2, fact::HELD_BEFORE, op::EQ, 0), when(2, fact::SIZE, op::LE, 5_000)];
        assert!(admits(&rule, &facts(&[(fact::VIA_APP, 1), (fact::SIZE, 900_000)])));
        assert!(admits(&rule, &facts(&[(fact::SIZE, 5_000)])));
        assert!(!admits(&rule, &facts(&[(fact::SIZE, 5_001)])), "second group half met");
        assert!(!admits(&rule, &facts(&[(fact::HELD_BEFORE, 1), (fact::SIZE, 1)])));
        // no conditions, no rule
        assert!(admits(&[], &facts(&[(fact::SIZE, 1_000_000)])));
        assert!(looks_at(&rule, fact::VIA_APP) && !looks_at(&rule, fact::LUCK));
    }

    #[test]
    fn the_agent_stays_inside_the_limits() {
        let l = limits();
        let rule = [when(0, fact::SIZE, op::LE, 10_000)];
        let change = |secs, split, rule: &[Condition]| Change::new(secs, split, rule).unwrap();
        assert_eq!(l.admit(&change(600, SPLIT, &[]), true), Ok(()));
        assert_eq!(l.admit(&change(7_200, SPLIT, &rule), true), Ok(()));
        // an edict has a term, and not a longer one than the limit says
        assert_eq!(l.admit(&change(7_201, SPLIT, &rule), true), Err(Refusal::OutsideLimits));
        assert_eq!(l.admit(&change(0, SPLIT, &rule), true), Err(Refusal::OutsideLimits));
        assert_eq!(l.admit(&change(0, SPLIT, &[]), true), Err(Refusal::OutsideLimits), "with or without a rule");
        assert_eq!(l.admit(&change(7_201, SPLIT, &[]), true), Err(Refusal::OutsideLimits));
        // rules the hook could not evaluate
        assert_eq!(l.admit(&change(60, SPLIT, &[when(4, fact::SIZE, op::LE, 1)]), true), Err(Refusal::BadRule));
        assert_eq!(l.admit(&change(60, SPLIT, &[when(0, fact::COUNT as u8, op::LE, 1)]), true), Err(Refusal::BadRule));
        assert_eq!(l.admit(&change(60, SPLIT, &[when(0, fact::SIZE, 7, 1)]), true), Err(Refusal::BadRule));
        assert_eq!(l.admit(&change(60, SPLIT, &[when(0, fact::MINUTE, op::MOD_EQ, 1)]), true), Err(Refusal::BadRule));
        // a rule about the app when the token names no app key could never be met
        assert_eq!(l.admit(&change(60, SPLIT, &[when(0, fact::VIA_APP, op::EQ, 1)]), false), Err(Refusal::BadRule));
        assert_eq!(l.admit(&change(60, SPLIT, &[when(0, fact::VIA_APP, op::EQ, 1)]), true), Ok(()));
        // the fee split
        assert_eq!(l.admit(&change(60, (5_001, 3_000, 2_000), &[]), true), Err(Refusal::BadSplit));
        assert_eq!(l.admit(&change(60, (7_000, 0, 3_000), &[]), true), Ok(()));
        assert_eq!(l.admit(&change(60, (6_999, 0, 3_001), &[]), true), Err(Refusal::OutsideLimits));
        // the treasury is owed its floor as surely as it is held to its cap
        assert_eq!(l.admit(&change(60, (9_000, 0, 1_000), &[]), true), Ok(()));
        assert_eq!(l.admit(&change(60, (9_001, 0, 999), &[]), true), Err(Refusal::OutsideLimits));
        assert_eq!(l.admit(&change(60, (5_000, 5_000, 0), &[]), true), Err(Refusal::OutsideLimits));
        // u16 shares that would wrap if added as u16
        assert_eq!(l.admit(&change(60, (40_000, 35_536, 0), &[]), true), Err(Refusal::BadSplit));
    }

    #[test]
    fn the_treasury_has_a_floor_under_its_cap() {
        let with = |min_treasury_bps, max_treasury_bps| Limits { min_treasury_bps, max_treasury_bps, ..limits() };
        assert!(with(1_000, 3_000).sane());
        assert!(with(0, 0).sane() && with(0, BPS).sane() && with(BPS, BPS).sane());
        assert!(with(4_000, 4_000).sane(), "a floor that meets the cap fixes the share");
        assert!(!with(3_001, 3_000).sane(), "a floor above the cap leaves no share the treasury could take");
        assert!(!with(0, BPS + 1).sane() && !with(BPS + 1, BPS + 1).sane());

        let l = with(4_000, 5_000);
        assert_eq!([3_999, 4_000, 4_500, 5_000, 5_001].map(|bps| l.treasury_fits(bps)), [false, true, true, true, false]);
        assert_eq!([3_999, 4_000, 4_001].map(|bps| with(4_000, 4_000).treasury_fits(bps)), [false, true, false]);
        // limits written before there was a floor read as a floor of zero
        let mut old = limits().encode();
        old[14..16].fill(0);
        assert_eq!(Limits::decode(&old), with(0, 3_000));
    }

    #[test]
    fn a_rewrite_waits_its_turn_and_respects_a_pause() {
        let mut b = book();
        let rule = [when(0, fact::SIZE, op::LE, 10_000)];
        assert_eq!(b.rewrite(&Change::new(600, SPLIT, &rule).unwrap(), [1; 32], NOW), Ok(())); // the first one needs no wait
        assert_eq!((b.epoch(), b.updated_at(), b.rule().1, b.rule_until()), (1, NOW, 1, NOW + 600));
        let open = Change::new(300, (6_000, 3_000, 1_000), &[]).unwrap();
        assert_eq!(b.rewrite(&open, [2; 32], NOW + 899), Err(Refusal::TooSoon));
        assert_eq!(b.rule().1, 1, "a refused rewrite changes nothing");
        assert_eq!(b.rewrite(&open, [2; 32], NOW + 900), Ok(()));
        assert_eq!((b.epoch(), b.note, b.rule().1, b.rule_until(), b.split()), (2, [2; 32], 0, NOW + 1_200, (6_000, 3_000, 1_000)));
        // a split outside the limits is refused whole as well
        assert_eq!(b.rewrite(&Change::new(300, (7_000, 3_000, 0), &[]).unwrap(), [3; 32], NOW + 1_800), Err(Refusal::OutsideLimits));
        assert_eq!((b.epoch(), b.split()), (2, (6_000, 3_000, 1_000)));
        assert!(!b.rule_in_force(NOW + 900), "an edict with no conditions has a term but restricts nothing");
        b.paused = 1;
        assert_eq!(b.rewrite(&open, [3; 32], NOW + 10_000), Err(Refusal::Paused));
    }

    #[test]
    fn a_name_changes_with_an_edict_and_not_too_often() {
        let mut b = book();
        let day = limits().min_rename_secs as i64;
        let edict = Change::new(600, SPLIT, &[]).unwrap();
        assert_eq!((b.name, b.name_count, b.renamed_at()), (0, 3, NOW));
        assert_eq!(b.name_at(1), Some((&b"Decree"[..], &b"DECREE"[..])));
        assert_eq!(b.name_at(3), None);

        // the name it launched with stays for a day
        b.rewrite(&edict, [0; 32], NOW + day - 1_000).unwrap();
        assert_eq!(b.rename(1, NOW + day - 1_000), Err(Refusal::TooSoon));
        // a day on, but with no edict written at that moment
        assert_eq!(b.rename(1, NOW + day), Err(Refusal::NoEdict));
        b.rewrite(&edict, [0; 32], NOW + day).unwrap();
        assert_eq!(b.rename(3, NOW + day), Err(Refusal::BadName), "a name it does not have");
        assert_eq!(b.rename(0, NOW + day), Err(Refusal::BadName), "the name it already goes by");
        assert_eq!(b.rename(1, NOW + day), Ok(()));
        assert_eq!((b.name, b.renamed_at()), (1, NOW + day));

        // and then that one stays for a day too
        b.rewrite(&edict, [0; 32], NOW + 2 * day - 1_000).unwrap();
        assert_eq!(b.rename(0, NOW + 2 * day - 1_000), Err(Refusal::TooSoon));
        b.rewrite(&edict, [0; 32], NOW + 2 * day).unwrap();
        b.paused = 1;
        assert_eq!(b.rename(0, NOW + 2 * day), Err(Refusal::Paused));
        b.paused = 0;
        assert_eq!(b.rename(0, NOW + 2 * day), Ok(()));
    }

    #[test]
    fn names_have_to_be_fit_for_a_token() {
        assert_eq!(text(b"Edict\0\0\0"), Some(&b"Edict"[..]));
        assert_eq!(text(b"Edict"), Some(&b"Edict"[..]), "a field filled to the end");
        assert_eq!(text("Édito\0".as_bytes()), Some("Édito".as_bytes()));
        assert_eq!(text(b"\0\0\0"), None, "empty");
        assert_eq!(text(b"Ed\0ct"), None, "text after the padding starts");
        assert_eq!(text(b"Ed\nct\0"), None, "a control character");
        assert_eq!(text(&[b'E', 0xff, 0]), None, "not UTF-8");

        let mut b = book();
        let three = names();
        assert!(!b.set_names(&[]), "a token has at least the name it launches with");
        assert!(!b.set_names(&three[..NAME_ENTRY_LEN + 1]), "a list cut in the middle of a name");
        let mut nine = [0; 9 * NAME_ENTRY_LEN];
        nine.chunks_mut(NAME_ENTRY_LEN).for_each(|chunk| chunk.copy_from_slice(&entry(b"Edict", b"EDICT")));
        assert!(!b.set_names(&nine), "nine names");
        assert!(!b.set_names(&entry(b"Edict", b"")), "a name with no ticker");
        assert_eq!(b.name_count, 3, "a refused list changes nothing");
        assert!(b.set_names(&entry(b"Only", b"ONLY")));
        assert_eq!((b.name_count, b.name_at(0)), (1, Some((&b"Only"[..], &b"ONLY"[..]))));
    }

    #[test]
    fn a_rule_lapses_by_the_clock() {
        let mut b = book();
        assert!(!b.rule_in_force(NOW), "no conditions, nothing in force");
        b.rewrite(&Change::new(600, SPLIT, &[when(0, fact::LUCK, op::LT, 0)]).unwrap(), [0; 32], NOW).unwrap();
        assert!(b.rule_in_force(NOW) && b.rule_in_force(NOW + 599));
        assert!(!b.rule_in_force(NOW + 600));
        // a rule written over it replaces it whole
        b.rewrite(&Change::new(60, SPLIT, &[when(1, fact::HOUR, op::GE, 12)]).unwrap(), [0; 32], NOW + 900).unwrap();
        let (conditions, count) = b.rule();
        assert_eq!((count, conditions[0]), (1, when(1, fact::HOUR, op::GE, 12)));
    }
}
