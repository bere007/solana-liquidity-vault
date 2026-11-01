use anchor_lang::prelude::*;

#[event]
pub struct VaultInitialized {
    pub vault: Pubkey,
    pub authority: Pubkey,
    pub underlying_mint: Pubkey,
    pub share_mint: Pubkey,
}

#[event]
pub struct Deposited {
    pub vault: Pubkey,
    pub user: Pubkey,
    pub amount: u64,
    pub shares: u64,
}

#[event]
pub struct Withdrawn {
    pub vault: Pubkey,
    pub user: Pubkey,
    pub amount: u64,
    pub shares: u64,
}

#[event]
pub struct Swapped {
    pub vault: Pubkey,
    pub pool: Pubkey,
    pub input_mint: Pubkey,
    pub output_mint: Pubkey,
    pub amount_in: u64,
    pub amount_out: u64,
}

#[event]
pub struct ClmmPositionOpened {
    pub vault: Pubkey,
    pub pool: Pubkey,
    pub nft_mint: Pubkey,
    pub tick_lower: i32,
    pub tick_upper: i32,
    pub liquidity: u128,
    pub amount0: u64,
    pub amount1: u64,
}

#[event]
pub struct FeesCollected {
    pub vault: Pubkey,
    pub nft_mint: Pubkey,
    pub amount0: u64,
    pub amount1: u64,
}

#[event]
pub struct ClmmPositionClosed {
    pub vault: Pubkey,
    pub nft_mint: Pubkey,
    pub tick_current: i32,
    pub was_in_range: bool,
    pub amount0: u64,
    pub amount1: u64,
}
