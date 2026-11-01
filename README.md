# Liquidity Vault

Сквозной проект курса: DeFi-vault на Solana (Anchor), который принимает токены
пользователей и размещает их в пуле ликвидности.

## Прогресс по неделям

| Неделя | Тема | Статус |
|---|---|---|
| 8 | Каркас: аккаунт настроек, PDA пользователя, share-токен | ✅ |
| 9 | Депозит: пользователь вносит токены и получает share-токены | ✅ |
| 10 | CPI и вывод: сжигание долей, возврат токенов с подписью PDA | ✅ |

## Аккаунты

| Компонент | Тип | Seeds |
|---|---|---|
| `VaultConfig` — аккаунт настроек | PDA | `["vault", underlying_mint]` |
| Share-токен vault | Mint-PDA, mint authority = vault | `["shares", vault]` |
| Хранилище underlying | ATA vault | ATA(`underlying_mint`, `vault`) |
| `UserPosition` — PDA пользователя | PDA | `["position", vault, owner]` |

## Инструкции

| Инструкция | Что делает |
|---|---|
| `initialize_vault(deposit_cap, fee_bps)` | Создаёт конфиг, share-mint (decimals = как у underlying) и хранилище |
| `update_config(params)` | Только `authority`: лимит, комиссия (≤ 20%), пауза, адрес пула, смена админа |
| `open_position()` | Создаёт PDA-позицию пользователя |
| `deposit(amount, min_shares_out)` | Переводит underlying в хранилище vault и минтит пользователю share-токены |
| `withdraw(shares, min_amount_out)` | Сжигает share-токены и возвращает пользователю его долю underlying |

Share-mint создаётся как PDA, и его mint authority — тоже PDA vault, поэтому выпускать
доли может только сама программа. Адрес пула ликвидности (`liquidity_pool`) пока пустой —
он задаётся через `update_config`, когда появится интеграция с пулом.

## Депозит

1. Проверки: vault не на паузе, `amount > 0`, после депозита не превышен `deposit_cap`.
2. Считается количество долей (см. формулу ниже); 0 долей → `AmountTooSmall`,
   меньше `min_shares_out` → `SlippageExceeded`.
3. `transfer_checked`: underlying со счёта пользователя в хранилище vault (подписывает пользователь).
4. `mint_to`: share-токены пользователю (подписывает PDA vault через seeds).
   Share-аккаунт пользователя (ATA) создаётся автоматически, если его ещё нет.
5. В `UserPosition` обновляются `total_deposited` и `last_action_ts`, эмитится событие `Deposited`.

### Расчёт долей

```
shares = amount * (total_shares + 1) / (total_assets + 1)
```

- `total_assets` — баланс хранилища vault, `total_shares` — supply share-токена.
- Первый депозит идёт 1:1. Если активы vault выросли (доход пула), доля дорожает
  и за ту же сумму выдаётся меньше долей — так доход достаётся тем, кто был в vault раньше.
- Виртуальный сдвиг `+1` (как в ERC-4626 OpenZeppelin) защищает от атаки инфляцией цены доли:
  донат в пустой vault больше не позволяет «обнулить» депозит следующего пользователя.
- Округление вниз — в пользу vault. Вычисления в `u128`, переполнение → `MathOverflow`.

## Вывод (CPI с подписью PDA)

```
amount = shares * (total_assets + 1) / (total_shares + 1)
```

1. Проверки: `shares > 0`, `amount > 0`, `amount >= min_amount_out` (slippage).
2. **CPI `burn`** в Token program: доли сжигаются со счёта пользователя, подписывает сам пользователь.
3. **CPI `transfer_checked`** в Token program: underlying из хранилища vault пользователю.
   Владелец хранилища — PDA vault, у которого нет приватного ключа, поэтому программа
   подписывает вызов через `CpiContext::new_with_signer` с seeds `["vault", underlying_mint, bump]`.
   Runtime проверяет, что эти seeds с `program_id` дают адрес vault, — так забрать токены
   из хранилища может только наша программа и только по её правилам.
4. В `UserPosition` обновляются `total_withdrawn` и `last_action_ts`, эмитится событие `Withdrawn`.

Сначала сжигаем, потом переводим: если burn не прошёл (долей не хватает), транзакция
откатывается целиком. Пауза вывод **не** блокирует — пользователь всегда может забрать свои средства.
Цикл deposit → withdraw никогда не даёт прибыли из-за округления вниз (проверено unit-тестом).

## Структура

```
programs/liquidity-vault/src/
├── lib.rs              # точки входа
├── state.rs            # VaultConfig, UserPosition
├── math.rs             # конвертация underlying <-> shares (+ unit-тесты)
├── constants.rs, errors.rs, events.rs
└── instructions/       # initialize_vault, update_config, open_position, deposit, withdraw
tests/liquidity-vault.ts  # интеграционные тесты (mocha)
```

## Запуск

Требуется Anchor 0.31.1, Solana CLI 2.1, Node + Yarn. `Cargo.lock` зафиксирован под toolchain Solana 2.1
(в частности `blake3 = 1.5.5`), поэтому собирается без обновления Rust в platform-tools.

```bash
yarn install
anchor keys sync     # подставить ID из локального keypair
anchor test          # сборка + локальный валидатор + тесты
cargo test -p liquidity-vault   # unit-тесты расчёта долей
```

Без локальной установки — через Docker:

```bash
docker run --rm -v "$PWD":/workdir -w /workdir solanafoundation/anchor:v0.31.1 \
  bash -lc "solana-keygen new --no-bip39-passphrase -s -o ~/.config/solana/id.json && yarn install --ignore-engines && anchor keys sync && anchor test"
```
