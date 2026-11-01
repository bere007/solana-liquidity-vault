use anchor_lang::prelude::*;

use crate::{constants::*, errors::VaultError, state::VaultConfig};

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Default)]
pub struct UpdateConfigParams {
    pub new_authority: Option<Pubkey>,
    pub liquidity_pool: Option<Pubkey>,
    pub deposit_cap: Option<u64>,
    pub fee_bps: Option<u16>,
    pub paused: Option<bool>,
}

#[derive(Accounts)]
pub struct UpdateConfig<'info> {
    pub authority: Signer<'info>,

    #[account(
        mut,
        has_one = authority,
        seeds = [VAULT_SEED, vault.underlying_mint.as_ref()],
        bump = vault.bump,
    )]
    pub vault: Account<'info, VaultConfig>,
}

pub fn handler(ctx: Context<UpdateConfig>, params: UpdateConfigParams) -> Result<()> {
    let vault = &mut ctx.accounts.vault;

    if let Some(fee_bps) = params.fee_bps {
        require!(fee_bps <= MAX_FEE_BPS, VaultError::FeeTooHigh);
        vault.fee_bps = fee_bps;
    }
    if let Some(cap) = params.deposit_cap {
        vault.deposit_cap = cap;
    }
    if let Some(paused) = params.paused {
        vault.paused = paused;
    }
    if let Some(pool) = params.liquidity_pool {
        vault.liquidity_pool = pool;
    }
    if let Some(new_authority) = params.new_authority {
        vault.authority = new_authority;
    }
    Ok(())
}
