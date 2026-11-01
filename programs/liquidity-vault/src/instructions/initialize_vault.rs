use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token_interface::{Mint, TokenAccount, TokenInterface},
};

use crate::{constants::*, errors::VaultError, events::VaultInitialized, state::VaultConfig};

#[derive(Accounts)]
pub struct InitializeVault<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(mint::token_program = token_program)]
    pub underlying_mint: InterfaceAccount<'info, Mint>,

    #[account(
        init,
        payer = authority,
        space = 8 + VaultConfig::INIT_SPACE,
        seeds = [VAULT_SEED, underlying_mint.key().as_ref()],
        bump,
    )]
    pub vault: Account<'info, VaultConfig>,

    /// Share-токен: те же decimals, что у underlying, выпускать может только vault.
    #[account(
        init,
        payer = authority,
        seeds = [SHARE_MINT_SEED, vault.key().as_ref()],
        bump,
        mint::decimals = underlying_mint.decimals,
        mint::authority = vault,
        mint::token_program = token_program,
    )]
    pub share_mint: InterfaceAccount<'info, Mint>,

    #[account(
        init,
        payer = authority,
        associated_token::mint = underlying_mint,
        associated_token::authority = vault,
        associated_token::token_program = token_program,
    )]
    pub vault_token_account: InterfaceAccount<'info, TokenAccount>,

    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<InitializeVault>, deposit_cap: u64, fee_bps: u16) -> Result<()> {
    require!(fee_bps <= MAX_FEE_BPS, VaultError::FeeTooHigh);

    let vault = &mut ctx.accounts.vault;
    vault.set_inner(VaultConfig {
        authority: ctx.accounts.authority.key(),
        underlying_mint: ctx.accounts.underlying_mint.key(),
        share_mint: ctx.accounts.share_mint.key(),
        vault_token_account: ctx.accounts.vault_token_account.key(),
        liquidity_pool: Pubkey::default(),
        deposit_cap,
        fee_bps,
        paused: false,
        bump: ctx.bumps.vault,
        share_mint_bump: ctx.bumps.share_mint,
    });

    emit!(VaultInitialized {
        vault: vault.key(),
        authority: vault.authority,
        underlying_mint: vault.underlying_mint,
        share_mint: vault.share_mint,
    });
    Ok(())
}
