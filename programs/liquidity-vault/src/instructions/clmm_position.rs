//! Позиция vault в CLMM-пуле Raydium: открыть в диапазоне, собрать комиссии, закрыть.
//!
//! Raydium в `open_position_v2` использует `payer` и как плательщика ренты (через System
//! program), и как владельца токенов. PDA vault — аккаунт программы с данными и платить
//! через System program не может, поэтому позицией управляет отдельный PDA без данных
//! `["position_authority", vault]`: он владеет NFT позиции и подписывает CPI в Raydium.
//! Токены на время открытия переводятся ему с vault, остаток сразу возвращается.

use anchor_lang::{prelude::*, system_program};
use anchor_spl::{
    associated_token::AssociatedToken,
    token::Token,
    token_2022::Token2022,
    token_interface::{transfer_checked, Mint, TokenAccount, TransferChecked},
};

use crate::{
    constants::*,
    errors::VaultError,
    events::{ClmmPositionClosed, ClmmPositionOpened, FeesCollected},
    raydium_clmm,
    state::{VaultClmmPosition, VaultConfig},
};

// ---------------------------------------------------------------------------
// open_clmm_position
// ---------------------------------------------------------------------------

#[derive(Accounts)]
pub struct OpenClmmPosition<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        has_one = authority,
        seeds = [VAULT_SEED, vault.underlying_mint.as_ref()],
        bump = vault.bump,
    )]
    pub vault: Box<Account<'info, VaultConfig>>,

    /// Одна активная позиция на vault: повторное открытие упадёт на `init`.
    #[account(
        init,
        payer = authority,
        space = 8 + VaultClmmPosition::INIT_SPACE,
        seeds = [CLMM_POSITION_SEED, vault.key().as_ref()],
        bump,
    )]
    pub position_record: Box<Account<'info, VaultClmmPosition>>,

    #[account(mut, seeds = [POSITION_AUTHORITY_SEED, vault.key().as_ref()], bump)]
    pub position_authority: SystemAccount<'info>,

    pub clmm_program: Program<'info, raydium_clmm::program::AmmV3>,

    /// CHECK: только пул из настроек vault; содержимое проверяет Raydium.
    #[account(
        mut,
        owner = raydium_clmm::ID,
        constraint = pool_state.key() == vault.liquidity_pool @ VaultError::WrongPool,
    )]
    pub pool_state: UncheckedAccount<'info>,

    pub token_mint0: Box<InterfaceAccount<'info, Mint>>,
    pub token_mint1: Box<InterfaceAccount<'info, Mint>>,

    #[account(
        init_if_needed,
        payer = authority,
        associated_token::mint = token_mint0,
        associated_token::authority = vault,
        associated_token::token_program = token_program,
    )]
    pub vault_token0: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        init_if_needed,
        payer = authority,
        associated_token::mint = token_mint1,
        associated_token::authority = vault,
        associated_token::token_program = token_program,
    )]
    pub vault_token1: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        init_if_needed,
        payer = authority,
        associated_token::mint = token_mint0,
        associated_token::authority = position_authority,
        associated_token::token_program = token_program,
    )]
    pub authority_token0: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        init_if_needed,
        payer = authority,
        associated_token::mint = token_mint1,
        associated_token::authority = position_authority,
        associated_token::token_program = token_program,
    )]
    pub authority_token1: Box<InterfaceAccount<'info, TokenAccount>>,

    /// Новый mint NFT позиции (keypair с клиента).
    #[account(mut)]
    pub position_nft_mint: Signer<'info>,
    /// CHECK: ATA для NFT, создаёт Raydium.
    #[account(mut)]
    pub position_nft_account: UncheckedAccount<'info>,
    /// CHECK: metadata NFT (не создаётся, with_metadata = false).
    #[account(mut)]
    pub metadata_account: UncheckedAccount<'info>,
    /// CHECK: PDA Raydium, проверяет Raydium.
    #[account(mut)]
    pub protocol_position: UncheckedAccount<'info>,
    /// CHECK: PDA Raydium, проверяет Raydium.
    #[account(mut)]
    pub tick_array_lower: UncheckedAccount<'info>,
    /// CHECK: PDA Raydium, проверяет Raydium.
    #[account(mut)]
    pub tick_array_upper: UncheckedAccount<'info>,
    /// CHECK: PDA Raydium, создаётся Raydium.
    #[account(mut)]
    pub personal_position: UncheckedAccount<'info>,
    /// CHECK: хранилище пула, проверяет Raydium.
    #[account(mut)]
    pub token_vault0: UncheckedAccount<'info>,
    /// CHECK: хранилище пула, проверяет Raydium.
    #[account(mut)]
    pub token_vault1: UncheckedAccount<'info>,

    pub rent: Sysvar<'info, Rent>,
    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    /// CHECK: Metaplex Token Metadata, адрес проверяет Raydium.
    pub metadata_program: UncheckedAccount<'info>,
    pub token_program_2022: Program<'info, Token2022>,
}

#[allow(clippy::too_many_arguments)]
pub fn open_handler(
    ctx: Context<OpenClmmPosition>,
    tick_lower: i32,
    tick_upper: i32,
    tick_array_lower_start: i32,
    tick_array_upper_start: i32,
    amount0_max: u64,
    amount1_max: u64,
    base_flag: bool,
) -> Result<()> {
    require!(tick_lower < tick_upper, VaultError::InvalidTickRange);
    let base_amount = if base_flag { amount0_max } else { amount1_max };
    require!(base_amount > 0, VaultError::ZeroAmount);

    let vault_key = ctx.accounts.vault.key();
    let underlying = ctx.accounts.vault.underlying_mint;
    let vault_seeds: &[&[u8]] = &[VAULT_SEED, underlying.as_ref(), &[ctx.accounts.vault.bump]];
    let pa_bump = ctx.bumps.position_authority;
    let pa_seeds: &[&[u8]] = &[POSITION_AUTHORITY_SEED, vault_key.as_ref(), &[pa_bump]];

    // 1. SOL на ренту аккаунтов Raydium (NFT, позиция, tick arrays) — от authority.
    let lamports = ctx.accounts.position_authority.lamports();
    if lamports < POSITION_AUTHORITY_MIN_LAMPORTS {
        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.authority.to_account_info(),
                    to: ctx.accounts.position_authority.to_account_info(),
                },
            ),
            POSITION_AUTHORITY_MIN_LAMPORTS - lamports,
        )?;
    }

    // 2. Токены vault -> position_authority (подпись PDA vault).
    let a = &ctx.accounts;
    move_tokens(a.token_program.to_account_info(), &a.vault_token0, &a.authority_token0, &a.token_mint0, a.vault.to_account_info(), vault_seeds, amount0_max)?;
    move_tokens(a.token_program.to_account_info(), &a.vault_token1, &a.authority_token1, &a.token_mint1, a.vault.to_account_info(), vault_seeds, amount1_max)?;

    // 3. CPI open_position_v2: liquidity = 0 -> Raydium считает L из base-токена.
    raydium_clmm::cpi::open_position_v2(
        CpiContext::new_with_signer(
            a.clmm_program.to_account_info(),
            raydium_clmm::cpi::accounts::OpenPositionV2 {
                payer: a.position_authority.to_account_info(),
                position_nft_owner: a.position_authority.to_account_info(),
                position_nft_mint: a.position_nft_mint.to_account_info(),
                position_nft_account: a.position_nft_account.to_account_info(),
                metadata_account: a.metadata_account.to_account_info(),
                pool_state: a.pool_state.to_account_info(),
                protocol_position: a.protocol_position.to_account_info(),
                tick_array_lower: a.tick_array_lower.to_account_info(),
                tick_array_upper: a.tick_array_upper.to_account_info(),
                personal_position: a.personal_position.to_account_info(),
                token_account0: a.authority_token0.to_account_info(),
                token_account1: a.authority_token1.to_account_info(),
                token_vault0: a.token_vault0.to_account_info(),
                token_vault1: a.token_vault1.to_account_info(),
                rent: a.rent.to_account_info(),
                system_program: a.system_program.to_account_info(),
                token_program: a.token_program.to_account_info(),
                associated_token_program: a.associated_token_program.to_account_info(),
                metadata_program: a.metadata_program.to_account_info(),
                token_program2022: a.token_program_2022.to_account_info(),
                vault0_mint: a.token_mint0.to_account_info(),
                vault1_mint: a.token_mint1.to_account_info(),
            },
            &[pa_seeds],
        ),
        tick_lower,
        tick_upper,
        tick_array_lower_start,
        tick_array_upper_start,
        0,
        amount0_max,
        amount1_max,
        false,
        Some(base_flag),
    )?;

    // 4. Неиспользованный остаток — обратно на vault.
    ctx.accounts.authority_token0.reload()?;
    ctx.accounts.authority_token1.reload()?;
    let a = &ctx.accounts;
    let left0 = a.authority_token0.amount;
    let left1 = a.authority_token1.amount;
    move_tokens(a.token_program.to_account_info(), &a.authority_token0, &a.vault_token0, &a.token_mint0, a.position_authority.to_account_info(), pa_seeds, left0)?;
    move_tokens(a.token_program.to_account_info(), &a.authority_token1, &a.vault_token1, &a.token_mint1, a.position_authority.to_account_info(), pa_seeds, left1)?;

    // 5. Запоминаем позицию.
    let liquidity = read_position_liquidity(
        &ctx.accounts.personal_position,
        &ctx.accounts.position_nft_mint.key(),
    )?;
    let used0 = amount0_max - left0;
    let used1 = amount1_max - left1;
    ctx.accounts.position_record.set_inner(VaultClmmPosition {
        vault: vault_key,
        pool: ctx.accounts.pool_state.key(),
        nft_mint: ctx.accounts.position_nft_mint.key(),
        tick_lower,
        tick_upper,
        liquidity,
        opened_at: Clock::get()?.unix_timestamp,
        fees_collected0: 0,
        fees_collected1: 0,
        bump: ctx.bumps.position_record,
    });

    emit!(ClmmPositionOpened {
        vault: vault_key,
        pool: ctx.accounts.pool_state.key(),
        nft_mint: ctx.accounts.position_nft_mint.key(),
        tick_lower,
        tick_upper,
        liquidity,
        amount0: used0,
        amount1: used1,
    });
    Ok(())
}

// ---------------------------------------------------------------------------
// collect_fees / close_clmm_position — общий набор аккаунтов
// ---------------------------------------------------------------------------

#[derive(Accounts)]
pub struct ManageClmmPosition<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        has_one = authority,
        seeds = [VAULT_SEED, vault.underlying_mint.as_ref()],
        bump = vault.bump,
    )]
    pub vault: Box<Account<'info, VaultConfig>>,

    #[account(
        mut,
        has_one = vault,
        seeds = [CLMM_POSITION_SEED, vault.key().as_ref()],
        bump = position_record.bump,
    )]
    pub position_record: Box<Account<'info, VaultClmmPosition>>,

    #[account(mut, seeds = [POSITION_AUTHORITY_SEED, vault.key().as_ref()], bump)]
    pub position_authority: SystemAccount<'info>,

    pub clmm_program: Program<'info, raydium_clmm::program::AmmV3>,

    /// CHECK: пул позиции.
    #[account(mut, address = position_record.pool @ VaultError::WrongPool)]
    pub pool_state: UncheckedAccount<'info>,

    #[account(mut, address = position_record.nft_mint)]
    pub position_nft_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(
        mut,
        associated_token::mint = position_nft_mint,
        associated_token::authority = position_authority,
        associated_token::token_program = token_program,
    )]
    pub position_nft_account: Box<InterfaceAccount<'info, TokenAccount>>,

    /// CHECK: PDA Raydium позиции, проверяет Raydium.
    #[account(mut)]
    pub personal_position: UncheckedAccount<'info>,
    /// CHECK: PDA Raydium, проверяет Raydium.
    #[account(mut)]
    pub protocol_position: UncheckedAccount<'info>,
    /// CHECK: хранилище пула, проверяет Raydium.
    #[account(mut)]
    pub token_vault0: UncheckedAccount<'info>,
    /// CHECK: хранилище пула, проверяет Raydium.
    #[account(mut)]
    pub token_vault1: UncheckedAccount<'info>,
    /// CHECK: PDA Raydium, проверяет Raydium.
    #[account(mut)]
    pub tick_array_lower: UncheckedAccount<'info>,
    /// CHECK: PDA Raydium, проверяет Raydium.
    #[account(mut)]
    pub tick_array_upper: UncheckedAccount<'info>,

    pub token_mint0: Box<InterfaceAccount<'info, Mint>>,
    pub token_mint1: Box<InterfaceAccount<'info, Mint>>,

    /// Получатели — токен-аккаунты vault.
    #[account(
        mut,
        associated_token::mint = token_mint0,
        associated_token::authority = vault,
        associated_token::token_program = token_program,
    )]
    pub vault_token0: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        mut,
        associated_token::mint = token_mint1,
        associated_token::authority = vault,
        associated_token::token_program = token_program,
    )]
    pub vault_token1: Box<InterfaceAccount<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
    pub token_program_2022: Program<'info, Token2022>,
    /// CHECK: SPL Memo, адрес проверяет Raydium.
    pub memo_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

impl<'info> ManageClmmPosition<'info> {
    /// CPI decrease_liquidity_v2: забирает `liquidity` и накопленные комиссии на vault.
    fn decrease(&self, pa_seeds: &[&[u8]], liquidity: u128, amount0_min: u64, amount1_min: u64) -> Result<(u64, u64)> {
        let before0 = self.vault_token0.amount;
        let before1 = self.vault_token1.amount;
        raydium_clmm::cpi::decrease_liquidity_v2(
            CpiContext::new_with_signer(
                self.clmm_program.to_account_info(),
                raydium_clmm::cpi::accounts::DecreaseLiquidityV2 {
                    nft_owner: self.position_authority.to_account_info(),
                    nft_account: self.position_nft_account.to_account_info(),
                    personal_position: self.personal_position.to_account_info(),
                    pool_state: self.pool_state.to_account_info(),
                    protocol_position: self.protocol_position.to_account_info(),
                    token_vault0: self.token_vault0.to_account_info(),
                    token_vault1: self.token_vault1.to_account_info(),
                    tick_array_lower: self.tick_array_lower.to_account_info(),
                    tick_array_upper: self.tick_array_upper.to_account_info(),
                    recipient_token_account0: self.vault_token0.to_account_info(),
                    recipient_token_account1: self.vault_token1.to_account_info(),
                    token_program: self.token_program.to_account_info(),
                    token_program2022: self.token_program_2022.to_account_info(),
                    memo_program: self.memo_program.to_account_info(),
                    vault0_mint: self.token_mint0.to_account_info(),
                    vault1_mint: self.token_mint1.to_account_info(),
                },
                &[pa_seeds],
            ),
            liquidity,
            amount0_min,
            amount1_min,
        )?;
        let after0 = token_amount(&self.vault_token0.to_account_info())?;
        let after1 = token_amount(&self.vault_token1.to_account_info())?;
        Ok((after0.saturating_sub(before0), after1.saturating_sub(before1)))
    }
}

/// Собрать накопленные комиссии позиции на vault (decrease_liquidity с liquidity = 0).
pub fn collect_fees_handler(ctx: Context<ManageClmmPosition>) -> Result<()> {
    let vault_key = ctx.accounts.vault.key();
    let pa_seeds: &[&[u8]] = &[POSITION_AUTHORITY_SEED, vault_key.as_ref(), &[ctx.bumps.position_authority]];

    let (fee0, fee1) = ctx.accounts.decrease(pa_seeds, 0, 0, 0)?;

    let record = &mut ctx.accounts.position_record;
    record.fees_collected0 = record.fees_collected0.checked_add(fee0).ok_or(VaultError::MathOverflow)?;
    record.fees_collected1 = record.fees_collected1.checked_add(fee1).ok_or(VaultError::MathOverflow)?;

    emit!(FeesCollected { vault: vault_key, nft_mint: record.nft_mint, amount0: fee0, amount1: fee1 });
    Ok(())
}

/// Закрыть позицию: вся ликвидность и комиссии возвращаются на vault, NFT сжигается.
/// `only_if_out_of_range = true` — режим ребаланса: закрытие разрешено, только если
/// текущая цена пула вышла за диапазон позиции.
pub fn close_handler(
    ctx: Context<ManageClmmPosition>,
    amount0_min: u64,
    amount1_min: u64,
    only_if_out_of_range: bool,
) -> Result<()> {
    let record = &ctx.accounts.position_record;
    let tick_current = read_pool_tick_current(&ctx.accounts.pool_state)?;
    let in_range = tick_current >= record.tick_lower && tick_current < record.tick_upper;
    if only_if_out_of_range {
        require!(!in_range, VaultError::PositionInRange);
    }

    let vault_key = ctx.accounts.vault.key();
    let pa_seeds: &[&[u8]] = &[POSITION_AUTHORITY_SEED, vault_key.as_ref(), &[ctx.bumps.position_authority]];

    // 1. Забрать всю ликвидность (+ комиссии) на vault.
    let liquidity = read_position_liquidity(
        &ctx.accounts.personal_position,
        &ctx.accounts.position_record.nft_mint,
    )?;
    let (amount0, amount1) = ctx.accounts.decrease(pa_seeds, liquidity, amount0_min, amount1_min)?;

    // 2. Сжечь NFT и закрыть personal position (рента -> position_authority).
    let a = &ctx.accounts;
    raydium_clmm::cpi::close_position(CpiContext::new_with_signer(
        a.clmm_program.to_account_info(),
        raydium_clmm::cpi::accounts::ClosePosition {
            nft_owner: a.position_authority.to_account_info(),
            position_nft_mint: a.position_nft_mint.to_account_info(),
            position_nft_account: a.position_nft_account.to_account_info(),
            personal_position: a.personal_position.to_account_info(),
            system_program: a.system_program.to_account_info(),
            token_program: a.token_program.to_account_info(),
        },
        &[pa_seeds],
    ))?;

    emit!(ClmmPositionClosed {
        vault: vault_key,
        nft_mint: a.position_record.nft_mint,
        tick_current,
        was_in_range: in_range,
        amount0,
        amount1,
    });

    // 3. Запись о позиции закрывается, рента -> authority.
    ctx.accounts.position_record.close(ctx.accounts.authority.to_account_info())
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

#[allow(clippy::too_many_arguments)]
fn move_tokens<'info>(
    token_program: AccountInfo<'info>,
    from: &InterfaceAccount<'info, TokenAccount>,
    to: &InterfaceAccount<'info, TokenAccount>,
    mint: &InterfaceAccount<'info, Mint>,
    authority: AccountInfo<'info>,
    seeds: &[&[u8]],
    amount: u64,
) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    transfer_checked(
        CpiContext::new_with_signer(
            token_program,
            TransferChecked {
                from: from.to_account_info(),
                mint: mint.to_account_info(),
                to: to.to_account_info(),
                authority,
            },
            &[seeds],
        ),
        amount,
        mint.decimals,
    )
}

fn token_amount(info: &AccountInfo) -> Result<u64> {
    let data = info.try_borrow_data()?;
    // SPL Token account: mint(32) + owner(32) + amount(8)
    Ok(u64::from_le_bytes(data[64..72].try_into().unwrap()))
}

/// Ликвидность из PersonalPositionState Raydium.
/// Читаем поля по смещению, а не полной десериализацией: сгенерированные десериализаторы
/// больших аккаунтов Raydium не помещаются в стек SBF (4 КБ).
/// Layout: disc 8 + bump 1 + nft_mint 32 + pool_id 32 + tick_lower 4 + tick_upper 4 + liquidity 16.
const POSITION_NFT_MINT_OFFSET: usize = 8 + 1;
const POSITION_LIQUIDITY_OFFSET: usize = 8 + 1 + 32 + 32 + 4 + 4;

fn read_position_liquidity(personal_position: &AccountInfo, nft_mint: &Pubkey) -> Result<u128> {
    require_keys_eq!(*personal_position.owner, raydium_clmm::ID, VaultError::WrongPosition);
    let data = personal_position.try_borrow_data()?;
    require!(
        data.len() >= POSITION_LIQUIDITY_OFFSET + 16
            && data[..8] == raydium_clmm::accounts::PersonalPositionState::DISCRIMINATOR[..]
            && data[POSITION_NFT_MINT_OFFSET..POSITION_NFT_MINT_OFFSET + 32] == nft_mint.to_bytes(),
        VaultError::WrongPosition
    );
    Ok(u128::from_le_bytes(
        data[POSITION_LIQUIDITY_OFFSET..POSITION_LIQUIDITY_OFFSET + 16].try_into().unwrap(),
    ))
}

/// `tick_current` из PoolState Raydium (zero-copy, repr(C, packed)):
/// disc 8 + bump 1 + 7 pubkey 224 + decimals 2 + tick_spacing 2 + liquidity 16 + sqrt_price 16.
const POOL_TICK_CURRENT_OFFSET: usize = 8 + 1 + 32 * 7 + 1 + 1 + 2 + 16 + 16;

fn read_pool_tick_current(pool_state: &AccountInfo) -> Result<i32> {
    require_keys_eq!(*pool_state.owner, raydium_clmm::ID, VaultError::WrongPool);
    let data = pool_state.try_borrow_data()?;
    let bytes = data
        .get(POOL_TICK_CURRENT_OFFSET..POOL_TICK_CURRENT_OFFSET + 4)
        .ok_or(VaultError::WrongPool)?;
    Ok(i32::from_le_bytes(bytes.try_into().unwrap()))
}
