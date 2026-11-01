//! Конвертация underlying <-> shares.
//!
//! Используется «виртуальный» сдвиг на 1 (как в ERC-4626 OpenZeppelin):
//! первый депозит даёт доли 1:1, а атака через инфляцию цены доли
//! (донат в пустой vault) становится невыгодной.

use crate::errors::VaultError;
use anchor_lang::prelude::*;

const VIRTUAL_SHARES: u128 = 1;
const VIRTUAL_ASSETS: u128 = 1;

/// Сколько долей выдать за `amount` underlying (округление вниз — в пользу vault).
pub fn shares_for_deposit(amount: u64, total_assets: u64, total_shares: u64) -> Result<u64> {
    mul_div(
        amount as u128,
        total_shares as u128 + VIRTUAL_SHARES,
        total_assets as u128 + VIRTUAL_ASSETS,
    )
}

/// Сколько underlying вернуть за `shares` долей (округление вниз — в пользу vault).
pub fn assets_for_withdraw(shares: u64, total_assets: u64, total_shares: u64) -> Result<u64> {
    mul_div(
        shares as u128,
        total_assets as u128 + VIRTUAL_ASSETS,
        total_shares as u128 + VIRTUAL_SHARES,
    )
}

fn mul_div(a: u128, b: u128, c: u128) -> Result<u64> {
    let r = a
        .checked_mul(b)
        .ok_or(VaultError::MathOverflow)?
        .checked_div(c)
        .ok_or(VaultError::MathOverflow)?;
    u64::try_from(r).map_err(|_| error!(VaultError::MathOverflow))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_deposit_is_one_to_one() {
        assert_eq!(shares_for_deposit(100, 0, 0).unwrap(), 100);
    }

    #[test]
    fn same_price_gives_same_shares() {
        // 1 доля = 1 токен -> депозит 250 даёт 250 долей
        assert_eq!(shares_for_deposit(250, 1_000, 1_000).unwrap(), 250);
    }

    #[test]
    fn proportional_after_yield() {
        // В vault 200 активов на 100 долей -> доля стоит ~2 токена.
        assert_eq!(shares_for_deposit(100, 200, 100).unwrap(), 50);
    }

    #[test]
    fn rounds_down_in_favor_of_vault() {
        // 1 токен при цене доли 3 -> 0 долей (депозит отклонит AmountTooSmall)
        assert_eq!(shares_for_deposit(1, 300, 100).unwrap(), 0);
    }

    #[test]
    fn inflation_attack_is_unprofitable() {
        // Атакующий внёс 1 токен (1 доля) и задонатил 1_000_000 в хранилище.
        // Жертва вносит 1_000_000 — без сдвига получила бы 0 долей,
        // со сдвигом получает ~половину, атакующий теряет донат.
        let victim = shares_for_deposit(1_000_000, 1_000_001, 1).unwrap();
        assert!(victim > 0);
    }

    #[test]
    fn withdraw_returns_share_of_assets() {
        // 300 активов на 150 долей: 50 долей -> ~100 токенов (вниз)
        assert_eq!(assets_for_withdraw(50, 300, 150).unwrap(), 99);
        // весь supply -> все активы (минус пыль от сдвига)
        assert_eq!(assets_for_withdraw(100, 100, 100).unwrap(), 100);
    }

    #[test]
    fn round_trip_never_profits() {
        for (amount, assets, shares) in [(777, 1_000, 900), (1, 5, 3), (10_000, 123_456, 99_999)] {
            let s = shares_for_deposit(amount, assets, shares).unwrap();
            let back = assets_for_withdraw(s, assets + amount, shares + s).unwrap();
            assert!(back <= amount, "deposit -> withdraw не должен давать прибыль");
        }
    }

    #[test]
    fn huge_values_do_not_overflow() {
        assert_eq!(shares_for_deposit(u64::MAX, 0, 0).unwrap(), u64::MAX);
    }
}
