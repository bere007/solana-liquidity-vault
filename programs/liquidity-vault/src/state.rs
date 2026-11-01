use anchor_lang::prelude::*;

/// Аккаунт настроек vault. PDA: ["vault", underlying_mint].
#[account]
#[derive(InitSpace)]
pub struct VaultConfig {
    /// Администратор: меняет настройки, ставит на паузу.
    pub authority: Pubkey,
    /// Токен, который принимает vault.
    pub underlying_mint: Pubkey,
    /// Share-токен vault. PDA: ["shares", vault], mint authority = vault.
    pub share_mint: Pubkey,
    /// ATA vault для underlying-токена — здесь лежат свободные средства.
    pub vault_token_account: Pubkey,
    /// Пул ликвидности, куда будут размещаться средства (задаётся позже).
    pub liquidity_pool: Pubkey,
    /// Лимит на общий объём активов vault (0 — без лимита).
    pub deposit_cap: u64,
    /// Комиссия vault в bps (будет применяться к доходу пула).
    pub fee_bps: u16,
    pub paused: bool,
    pub bump: u8,
    pub share_mint_bump: u8,
}

/// Позиция пользователя. PDA: ["position", vault, owner].
///
/// Баланс долей хранится в share-токенах; здесь — учётная статистика пользователя.
#[account]
#[derive(InitSpace)]
pub struct UserPosition {
    pub owner: Pubkey,
    pub vault: Pubkey,
    /// Сколько underlying пользователь внёс за всё время.
    pub total_deposited: u64,
    /// Сколько underlying пользователь вывел за всё время.
    pub total_withdrawn: u64,
    pub last_action_ts: i64,
    pub bump: u8,
}
