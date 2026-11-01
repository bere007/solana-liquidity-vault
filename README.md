# Liquidity Vault

Сквозной проект курса: DeFi-vault на Solana (Anchor), который принимает токены
пользователей и размещает их в пуле ликвидности.

## Прогресс по неделям

| Неделя | Тема | Статус |
|---|---|---|
| 8 | Каркас: аккаунт настроек, PDA пользователя, share-токен | ✅ |
| 9 | Депозит: пользователь вносит токены и получает share-токены | ✅ |
| 10 | CPI и вывод: сжигание долей, возврат токенов с подписью PDA | ✅ |
| 11 | AMM и концентрированная ликвидность: свои токены и CLMM-пул Raydium | ✅ |
| 12 | Swap токенов vault через CLMM-пул Raydium с min_amount_out | ✅ |
| 13 | Позиция vault в CLMM: открыть в диапазоне, собрать комиссии, закрыть, переставить | ✅ |

## Аккаунты

| Компонент | Тип | Seeds |
|---|---|---|
| `VaultConfig` — аккаунт настроек | PDA | `["vault", underlying_mint]` |
| Share-токен vault | Mint-PDA, mint authority = vault | `["shares", vault]` |
| Хранилище underlying | ATA vault | ATA(`underlying_mint`, `vault`) |
| `UserPosition` — PDA пользователя | PDA | `["position", vault, owner]` |
| `VaultClmmPosition` — активная позиция vault в пуле Raydium | PDA | `["clmm_position", vault]` |
| Position authority — владелец NFT позиции (без данных) | PDA | `["position_authority", vault]` |

## Инструкции

| Инструкция | Что делает |
|---|---|
| `initialize_vault(deposit_cap, fee_bps)` | Создаёт конфиг, share-mint (decimals = как у underlying) и хранилище |
| `update_config(params)` | Только `authority`: лимит, комиссия (≤ 20%), пауза, адрес пула, смена админа |
| `open_position()` | Создаёт PDA-позицию пользователя |
| `deposit(amount, min_shares_out)` | Переводит underlying в хранилище vault и минтит пользователю share-токены |
| `withdraw(shares, min_amount_out)` | Сжигает share-токены и возвращает пользователю его долю underlying |
| `swap_via_clmm(amount_in, min_amount_out, sqrt_price_limit_x64)` | Только `authority`: обмен токенов vault через CLMM-пул Raydium |
| `open_clmm_position(tick_lower, tick_upper, ..., amount0_max, amount1_max, base_flag)` | Только `authority`: позиция vault в CLMM-пуле в заданном диапазоне |
| `collect_fees()` | Только `authority`: забрать накопленные комиссии позиции на vault |
| `close_clmm_position(amount0_min, amount1_min, only_if_out_of_range)` | Только `authority`: закрыть позицию, вернуть ликвидность на vault |

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
└── instructions/       # initialize_vault, update_config, open_position, deposit, withdraw, swap, clmm_position
client/clmm.ts            # хелперы Raydium CLMM: PDA, цена <-> sqrtPriceX64 <-> тик
client/raydium.ts         # действия с пулом: create_pool, позиция LP, remaining accounts для swap
client/vault.ts           # позиция vault: open / collect / close / rebalance
client/idl/raydium_clmm.json  # полный IDL Raydium CLMM для TS-клиента
idls/raydium_clmm.json    # IDL Raydium для declare_program! (только нужные аккаунты)
scripts/                  # скрипты для devnet
docs/amm-clmm.md          # конспект: AMM, концентрированная ликвидность, устройство Raydium CLMM
tests/
├── liquidity-vault.ts    # тесты vault
├── raydium-clmm.ts       # тесты пула Raydium CLMM на localnet
├── vault-clmm.ts         # vault + Raydium: swap и позиции
└── fixtures/             # программа Raydium CLMM, Metaplex и AmmConfig, выгруженные из devnet
```

## Raydium CLMM

Разбор AMM и концентрированной ликвидности — в [docs/amm-clmm.md](docs/amm-clmm.md).

**Localnet.** Программа Raydium CLMM (`devi51mZmdwUJGU9hjN27vEz64Gps7uUefqxg27EAtH`),
программа Metaplex Token Metadata и `AmmConfig` (index 1: комиссия 0.25%, tick spacing 60)
выгружены из devnet в `tests/fixtures/` и подключены в `Anchor.toml`, поэтому `anchor test`
работает с настоящим кодом Raydium без выхода в сеть:

```bash
solana program dump -u devnet devi51mZmdwUJGU9hjN27vEz64Gps7uUefqxg27EAtH tests/fixtures/raydium_clmm.so
solana program dump -u devnet metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s tests/fixtures/mpl_token_metadata.so
solana account -u devnet B9H7TR8PSjJT7nuW2tuPkFC63z7drtMZ4LoCtD7PrCN1 --output json -o tests/fixtures/amm_config.json
anchor idl fetch devi51mZmdwUJGU9hjN27vEz64Gps7uUefqxg27EAtH --provider.cluster devnet > raw.json
anchor idl convert raw.json --program-id devi51mZmdwUJGU9hjN27vEz64Gps7uUefqxg27EAtH -o client/idl/raydium_clmm.json
```

**Devnet.** Скрипт создаёт два тестовых токена, CLMM-пул с ценой 1:1 и стартовую позицию
LP в диапазоне ±6%; адреса сохраняются в `deployments/devnet.json`:

```bash
ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
ANCHOR_WALLET=~/.config/solana/devnet.json \
yarn ts-node scripts/devnet-create-pool.ts
```

Кошелёк devnet хранится только локально и в репозиторий не попадает.

## Swap через Raydium

`swap_via_clmm` меняет токены, лежащие на vault, через CLMM-пул Raydium (CPI в `swap_v2`):

- CPI-клиент Raydium генерируется макросом `declare_program!(raydium_clmm)` из
  `idls/raydium_clmm.json` — без зависимости от крейта Raydium и конфликтов версий.
- Направление задаётся парой `input_*` / `output_*`: underlying → парный токен и обратно.
  Оба токен-аккаунта принадлежат PDA vault (выходной ATA создаётся при первом swap),
  поэтому `payer` в CPI — сам vault, подпись через seeds `["vault", underlying_mint, bump]`.
- **Slippage.** `min_amount_out` передаётся в Raydium как `other_amount_threshold`
  (при `is_base_input = true` это минимум на выходе — иначе `TooLittleOutputReceived`).
  После CPI vault перечитывает свои балансы и ещё раз проверяет, что получено
  не меньше `min_amount_out`. `min_amount_out = 0` запрещён. Дополнительно можно
  ограничить цену через `sqrt_price_limit_x64` (0 — без ограничения).
- Вызывать может только `authority`, и только через пул, заданный в `VaultConfig::liquidity_pool`
  (`update_config`); пул также проверяется на владельца — программу Raydium.
- В `remaining_accounts` передаются bitmap extension пула и tick arrays по направлению
  движения цены — хелпер `swapRemainingAccounts` в [`client/raydium.ts`](client/raydium.ts).
- Событие `Swapped` фиксирует фактически списанную и полученную сумму.

> Пока стоимость vault (`total_assets`) считается только по underlying на балансе vault:
> учёт парного токена и позиций в пуле добавится вместе с размещением ликвидности.

## Позиция vault в CLMM-пуле

Vault размещает свои токены в CLMM-пуле Raydium в выбранном ценовом диапазоне
(одна активная позиция на vault, запись `VaultClmmPosition`).

**Кто владеет позицией.** Позиция Raydium — это NFT. В `open_position_v2` Raydium использует
`payer` и для оплаты ренты новых аккаунтов (через System program), и как владельца
вносимых токенов. PDA vault — аккаунт программы с данными, System program не может списывать
с него SOL. Поэтому позицией управляет отдельный PDA без данных
`["position_authority", vault]`: он владеет NFT и подписывает все CPI в Raydium.

**open_clmm_position**
1. `position_authority` пополняется SOL от authority (до 0.2 SOL) на ренту NFT, позиции и tick arrays.
2. Vault переводит `amount0_max` / `amount1_max` на токен-аккаунты `position_authority`.
3. CPI `open_position_v2` с `liquidity = 0` и `base_flag`: Raydium сам считает ликвидность `L`
   из base-токена и берёт второй токен по текущей цене (не больше `amount*_max`).
4. Неиспользованный остаток сразу возвращается на vault; `L` записывается в `VaultClmmPosition`.

**collect_fees** — CPI `decrease_liquidity_v2` с `liquidity = 0`: ликвидность не меняется,
накопленные комиссии в обоих токенах приходят на токен-аккаунты vault.
Суммы копятся в `fees_collected0/1`.

**close_clmm_position(amount0_min, amount1_min, only_if_out_of_range)**
1. CPI `decrease_liquidity_v2` на всю ликвидность (минимумы — защита от проскальзывания),
   токены и комиссии приходят на vault.
2. CPI `close_position`: NFT сжигается, аккаунт позиции Raydium закрывается.
3. Запись `VaultClmmPosition` закрывается — можно открыть новую позицию.

С `only_if_out_of_range = true` программа сама читает `tick_current` пула и разрешает
закрытие, только если цена вышла из диапазона `[tick_lower, tick_upper)` (иначе `PositionInRange`).

**Ребаланс** (`rebalanceIfOutOfRange` в [`client/vault.ts`](client/vault.ts)):
цена вышла из диапазона → позиция целиком в одном токене и не зарабатывает комиссии, поэтому
1. `close_clmm_position(only_if_out_of_range = true)`;
2. `swap_via_clmm` выравнивает стоимость токенов примерно 50/50 по текущей цене;
3. `open_clmm_position` в новом диапазоне ±`halfWidth` тиков вокруг текущей цены.

Ребаланс — это несколько транзакций: открытие и закрытие позиции вместе не помещаются
в одну транзакцию (лимит 1232 байта). Открытие позиции и так занимает почти весь лимит,
поэтому authority должен сам платить комиссию транзакции (без отдельного fee payer);
для продакшена стоит использовать Address Lookup Tables.

Для `declare_program!` используется урезанный IDL (`idls/raydium_clmm.json`, из аккаунтов только
`PersonalPositionState`): сгенерированные десериализаторы больших аккаунтов Raydium
(`TickArrayState`, `ObservationState`) не помещаются в стек SBF. Поля `PoolState` и
`PersonalPositionState` программа читает по смещениям с проверкой владельца, дискриминатора и NFT.

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
