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
