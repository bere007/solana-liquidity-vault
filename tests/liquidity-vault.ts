import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import {
  createMint,
  getAccount,
  getAssociatedTokenAddressSync,
  getMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { assert, expect } from "chai";
import { LiquidityVault } from "../target/types/liquidity_vault";

describe("liquidity-vault", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.LiquidityVault as Program<LiquidityVault>;
  const connection = provider.connection;
  const admin = (provider.wallet as anchor.Wallet).payer;

  const alice = Keypair.generate();
  const bob = Keypair.generate();
  const DECIMALS = 6;
  const ONE = 10 ** DECIMALS;

  let underlyingMint: PublicKey;
  let vault: PublicKey;
  let shareMint: PublicKey;
  let vaultTokenAccount: PublicKey;

  const positionPda = (owner: PublicKey) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("position"), vault.toBuffer(), owner.toBuffer()],
      program.programId
    )[0];

  const userAta = (mint: PublicKey, owner: PublicKey) =>
    getAssociatedTokenAddressSync(mint, owner);

  const balance = async (ata: PublicKey) =>
    Number((await getAccount(connection, ata)).amount);

  const deposit = (user: Keypair, amount: number, minShares = 0) =>
    program.methods
      .deposit(new BN(amount), new BN(minShares))
      .accountsPartial({
        owner: user.publicKey,
        vault,
        userPosition: positionPda(user.publicKey),
        underlyingMint,
        shareMint,
        vaultTokenAccount,
        userTokenAccount: userAta(underlyingMint, user.publicKey),
        userShareAccount: userAta(shareMint, user.publicKey),
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([user])
      .rpc();

  const withdraw = (user: Keypair, shares: number, minOut = 0, shareAccountOwner = user.publicKey) =>
    program.methods
      .withdraw(new BN(shares), new BN(minOut))
      .accountsPartial({
        owner: user.publicKey,
        vault,
        userPosition: positionPda(user.publicKey),
        underlyingMint,
        shareMint,
        vaultTokenAccount,
        userTokenAccount: userAta(underlyingMint, user.publicKey),
        userShareAccount: userAta(shareMint, shareAccountOwner),
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([user])
      .rpc();

  const airdrop = async (to: PublicKey) => {
    const sig = await connection.requestAirdrop(to, 2 * LAMPORTS_PER_SOL);
    const bh = await connection.getLatestBlockhash();
    await connection.confirmTransaction({ signature: sig, ...bh }, "confirmed");
  };

  const expectError = async (p: Promise<unknown>, code: string) => {
    try {
      await p;
      assert.fail(`ожидалась ошибка ${code}`);
    } catch (e: any) {
      const actual = e?.error?.errorCode?.code ?? e?.message ?? String(e);
      expect(actual).to.include(code);
    }
  };

  before(async () => {
    await Promise.all([airdrop(alice.publicKey), airdrop(bob.publicKey)]);

    underlyingMint = await createMint(connection, admin, admin.publicKey, null, DECIMALS);
    for (const u of [alice, bob]) {
      const ata = await getOrCreateAssociatedTokenAccount(connection, admin, underlyingMint, u.publicKey);
      await mintTo(connection, admin, underlyingMint, ata.address, admin, 1_000 * ONE);
    }

    [vault] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), underlyingMint.toBuffer()],
      program.programId
    );
    [shareMint] = PublicKey.findProgramAddressSync(
      [Buffer.from("shares"), vault.toBuffer()],
      program.programId
    );
    vaultTokenAccount = getAssociatedTokenAddressSync(underlyingMint, vault, true);
  });

  it("initialize_vault: создаёт конфиг, share-mint и хранилище", async () => {
    await program.methods
      .initializeVault(new BN(10_000 * ONE), 100)
      .accountsPartial({
        authority: admin.publicKey,
        underlyingMint,
        vault,
        shareMint,
        vaultTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    const cfg = await program.account.vaultConfig.fetch(vault);
    assert.ok(cfg.authority.equals(admin.publicKey));
    assert.ok(cfg.underlyingMint.equals(underlyingMint));
    assert.ok(cfg.shareMint.equals(shareMint));
    assert.ok(cfg.vaultTokenAccount.equals(vaultTokenAccount));
    assert.ok(cfg.liquidityPool.equals(PublicKey.default));
    assert.equal(cfg.depositCap.toNumber(), 10_000 * ONE);
    assert.equal(cfg.feeBps, 100);
    assert.isFalse(cfg.paused);

    const mint = await getMint(connection, shareMint);
    assert.equal(mint.decimals, DECIMALS);
    assert.ok(mint.mintAuthority!.equals(vault), "mint authority = PDA vault");
    assert.equal(Number(mint.supply), 0);
  });

  it("initialize_vault: повторная инициализация невозможна", async () => {
    try {
      await program.methods
        .initializeVault(new BN(0), 0)
        .accountsPartial({ authority: admin.publicKey, underlyingMint, vault, shareMint, vaultTokenAccount, tokenProgram: TOKEN_PROGRAM_ID })
        .rpc();
      assert.fail("должно упасть");
    } catch (e: any) {
      expect(String(e)).to.match(/already in use|custom program error: 0x0/);
    }
  });

  it("initialize_vault: слишком большая комиссия отклоняется", async () => {
    const otherMint = await createMint(connection, admin, admin.publicKey, null, DECIMALS);
    const [otherVault] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), otherMint.toBuffer()],
      program.programId
    );
    await expectError(
      program.methods
        .initializeVault(new BN(0), 5_000)
        .accountsPartial({
          authority: admin.publicKey,
          underlyingMint: otherMint,
          vault: otherVault,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc(),
      "FeeTooHigh"
    );
  });

  it("open_position: создаёт PDA пользователя", async () => {
    for (const u of [alice, bob]) {
      await program.methods
        .openPosition()
        .accountsPartial({ owner: u.publicKey, vault, userPosition: positionPda(u.publicKey) })
        .signers([u])
        .rpc();
    }
    const pos = await program.account.userPosition.fetch(positionPda(alice.publicKey));
    assert.ok(pos.owner.equals(alice.publicKey));
    assert.ok(pos.vault.equals(vault));
    assert.equal(pos.totalDeposited.toNumber(), 0);
    assert.equal(pos.totalWithdrawn.toNumber(), 0);
  });

  it("open_position: вторую позицию тому же пользователю открыть нельзя", async () => {
    try {
      await program.methods
        .openPosition()
        .accountsPartial({ owner: alice.publicKey, vault, userPosition: positionPda(alice.publicKey) })
        .signers([alice])
        .rpc();
      assert.fail("должно упасть");
    } catch (e: any) {
      expect(String(e)).to.match(/already in use|custom program error: 0x0/);
    }
  });

  it("deposit: первый депозит даёт доли 1:1 и создаёт share-аккаунт", async () => {
    assert.isNull(await connection.getAccountInfo(userAta(shareMint, alice.publicKey)));

    await deposit(alice, 100 * ONE);

    assert.equal(await balance(userAta(shareMint, alice.publicKey)), 100 * ONE);
    assert.equal(await balance(vaultTokenAccount), 100 * ONE);
    assert.equal(await balance(userAta(underlyingMint, alice.publicKey)), 900 * ONE);
    assert.equal(Number((await getMint(connection, shareMint)).supply), 100 * ONE);

    const pos = await program.account.userPosition.fetch(positionPda(alice.publicKey));
    assert.equal(pos.totalDeposited.toNumber(), 100 * ONE);
  });

  it("deposit: повторный депозит по той же цене доли", async () => {
    await deposit(alice, 50 * ONE);
    assert.equal(await balance(userAta(shareMint, alice.publicKey)), 150 * ONE);

    const pos = await program.account.userPosition.fetch(positionPda(alice.publicKey));
    assert.equal(pos.totalDeposited.toNumber(), 150 * ONE);
  });

  it("deposit: доли пропорциональны после роста активов vault", async () => {
    // Имитируем доход пула: +150 токенов напрямую в хранилище vault.
    await mintTo(connection, admin, underlyingMint, vaultTokenAccount, admin, 150 * ONE);

    // В vault 300 активов на 150 долей -> доля стоит 2, за 100 токенов Bob получает ~50 долей.
    await deposit(bob, 100 * ONE);
    assert.approximately(await balance(userAta(shareMint, bob.publicKey)), 50 * ONE, 1);
  });

  it("deposit: нулевая сумма отклоняется", async () => {
    await expectError(deposit(bob, 0), "ZeroAmount");
  });

  it("deposit: сумма меньше цены одной доли отклоняется", async () => {
    // Доля стоит ~2 минимальные единицы -> 1 единица даёт 0 долей.
    await expectError(deposit(bob, 1), "AmountTooSmall");
  });

  it("deposit: slippage-защита min_shares_out", async () => {
    await expectError(deposit(bob, 10 * ONE, 10 * ONE), "SlippageExceeded");
  });

  it("deposit: нельзя превысить deposit_cap", async () => {
    // В vault 400 из 10_000, депозит 9_700 превышает лимит.
    await expectError(deposit(alice, 9_700 * ONE), "DepositCapExceeded");
  });

  it("deposit: без открытой позиции не работает", async () => {
    const carol = Keypair.generate();
    await airdrop(carol.publicKey);
    const ata = await getOrCreateAssociatedTokenAccount(connection, admin, underlyingMint, carol.publicKey);
    await mintTo(connection, admin, underlyingMint, ata.address, admin, 10 * ONE);
    await expectError(deposit(carol, 10 * ONE), "AccountNotInitialized");
  });

  it("deposit: нельзя внести с чужого токен-аккаунта", async () => {
    await expectError(
      program.methods
        .deposit(new BN(1 * ONE), new BN(0))
        .accountsPartial({
          owner: bob.publicKey,
          vault,
          userPosition: positionPda(bob.publicKey),
          underlyingMint,
          shareMint,
          vaultTokenAccount,
          userTokenAccount: userAta(underlyingMint, alice.publicKey),
          userShareAccount: userAta(shareMint, bob.publicKey),
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([bob])
        .rpc(),
      "ConstraintTokenOwner"
    );
  });

  it("withdraw: сжигает доли и возвращает долю активов", async () => {
    // Сейчас в vault 400 активов на ~200 долей (Alice 150, Bob ~50).
    const tokensBefore = await balance(userAta(underlyingMint, alice.publicKey));
    const supplyBefore = Number((await getMint(connection, shareMint)).supply);

    await withdraw(alice, 50 * ONE);

    const received = (await balance(userAta(underlyingMint, alice.publicKey))) - tokensBefore;
    assert.approximately(received, 100 * ONE, 2, "50 долей по цене ~2 -> ~100 токенов");
    assert.equal(await balance(userAta(shareMint, alice.publicKey)), 100 * ONE);
    assert.equal(Number((await getMint(connection, shareMint)).supply), supplyBefore - 50 * ONE);

    const pos = await program.account.userPosition.fetch(positionPda(alice.publicKey));
    assert.equal(pos.totalWithdrawn.toNumber(), received);
  });

  it("withdraw: нулевое количество долей отклоняется", async () => {
    await expectError(withdraw(alice, 0), "ZeroAmount");
  });

  it("withdraw: slippage-защита min_amount_out", async () => {
    await expectError(withdraw(alice, 10 * ONE, 25 * ONE), "SlippageExceeded");
  });

  it("withdraw: нельзя сжечь больше долей, чем есть", async () => {
    // Token program отклоняет burn: insufficient funds (0x1)
    await expectError(withdraw(alice, 101 * ONE), "0x1");
  });

  it("withdraw: нельзя выводить чужие доли", async () => {
    await expectError(withdraw(bob, 1 * ONE, 0, alice.publicKey), "ConstraintTokenOwner");
  });

  it("withdraw: полный вывод обнуляет доли пользователя", async () => {
    const shares = await balance(userAta(shareMint, bob.publicKey));
    const tokensBefore = await balance(userAta(underlyingMint, bob.publicKey));

    await withdraw(bob, shares);

    assert.equal(await balance(userAta(shareMint, bob.publicKey)), 0);
    // Bob вносил 100 после роста цены доли -> получает обратно ~100
    assert.approximately((await balance(userAta(underlyingMint, bob.publicKey))) - tokensBefore, 100 * ONE, 2);
  });

  it("update_config: чужой authority отклоняется", async () => {
    await expectError(
      program.methods
        .updateConfig({ newAuthority: null, liquidityPool: null, depositCap: null, feeBps: null, paused: true })
        .accountsPartial({ authority: alice.publicKey, vault })
        .signers([alice])
        .rpc(),
      "ConstraintHasOne"
    );
  });

  it("update_config: слишком большая комиссия отклоняется", async () => {
    await expectError(
      program.methods
        .updateConfig({ newAuthority: null, liquidityPool: null, depositCap: null, feeBps: 5_000, paused: null })
        .accountsPartial({ authority: admin.publicKey, vault })
        .rpc(),
      "FeeTooHigh"
    );
  });

  it("update_config: authority меняет настройки", async () => {
    const pool = Keypair.generate().publicKey;
    await program.methods
      .updateConfig({ newAuthority: null, liquidityPool: pool, depositCap: new BN(5_000 * ONE), feeBps: 250, paused: true })
      .accountsPartial({ authority: admin.publicKey, vault })
      .rpc();

    const cfg = await program.account.vaultConfig.fetch(vault);
    assert.isTrue(cfg.paused);
    assert.equal(cfg.feeBps, 250);
    assert.equal(cfg.depositCap.toNumber(), 5_000 * ONE);
    assert.ok(cfg.liquidityPool.equals(pool));
  });

  it("withdraw: на паузе вывод разрешён", async () => {
    const before = await balance(userAta(shareMint, alice.publicKey));
    await withdraw(alice, 10 * ONE);
    assert.equal(await balance(userAta(shareMint, alice.publicKey)), before - 10 * ONE);
  });

  it("deposit: на паузе отклоняется, после снятия паузы снова работает", async () => {
    await expectError(deposit(bob, 1 * ONE), "VaultPaused");

    await program.methods
      .updateConfig({ newAuthority: null, liquidityPool: null, depositCap: null, feeBps: null, paused: false })
      .accountsPartial({ authority: admin.publicKey, vault })
      .rpc();

    const before = await balance(userAta(shareMint, bob.publicKey));
    await deposit(bob, 2 * ONE);
    assert.isAbove(await balance(userAta(shareMint, bob.publicKey)), before);
  });
});
