use anchor_lang::prelude::*;

use crate::{
    constants::*,
    state::{UserPosition, VaultConfig},
};

#[derive(Accounts)]
pub struct OpenPosition<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        seeds = [VAULT_SEED, vault.underlying_mint.as_ref()],
        bump = vault.bump,
    )]
    pub vault: Account<'info, VaultConfig>,

    #[account(
        init,
        payer = owner,
        space = 8 + UserPosition::INIT_SPACE,
        seeds = [USER_POSITION_SEED, vault.key().as_ref(), owner.key().as_ref()],
        bump,
    )]
    pub user_position: Account<'info, UserPosition>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<OpenPosition>) -> Result<()> {
    ctx.accounts.user_position.set_inner(UserPosition {
        owner: ctx.accounts.owner.key(),
        vault: ctx.accounts.vault.key(),
        total_deposited: 0,
        total_withdrawn: 0,
        last_action_ts: Clock::get()?.unix_timestamp,
        bump: ctx.bumps.user_position,
    });
    Ok(())
}
