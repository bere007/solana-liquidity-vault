// Vault + Raydium CLMM: swap токенов vault через пул (неделя 12).
import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import {
  createMint,
  getAccount,
  getAssociatedTokenAddressSync,
  getMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { assert, expect } from "chai";
import { LiquidityVault } from "../target/types/liquidity_vault";
import {
  alignTick,
  clmmProgram,
  CLMM_PROGRAM_ID,
  MEMO_PROGRAM_ID,
  personalPositionPda,
  poolAddresses,
  PoolAddresses,
} from "../client/clmm";
import { computeBudget, createPool, openWalletPosition, swapRemainingAccounts } from "../client/raydium";
import {
  closeVaultPosition,
  collectFees,
  openVaultPosition,
  positionAuthorityPda,
  positionRecordPda,
  rangeAroundPrice,
  rebalanceIfOutOfRange,
  VaultCtx,
  vaultBalances,
} from "../client/vault";

describe("vault + raydium clmm", () => {
  const env = anchor.AnchorProvider.env();
  const provider = new anchor.AnchorProvider(
    new Connection(env.connection.rpcEndpoint, "confirmed"),
    env.wallet,
    { commitment: "confirmed", preflightCommitment: "confirmed" }
  );
  anchor.setProvider(provider);
  const program = anchor.workspace.LiquidityVault as Program<LiquidityVault>;
  const clmm = clmmProgram(provider);
  const connection = provider.connection;
  const admin = (provider.wallet as anchor.Wallet).payer;
  const alice = Keypair.generate();

  const DECIMALS = 6;
  const ONE = 10 ** DECIMALS;

  let underlying: PublicKey; // токен vault
  let pair: PublicKey; // второй токен пула
  let p: PoolAddresses;
  let vault: PublicKey;
  let shareMint: PublicKey;

  const ata = (mint: PublicKey, owner: PublicKey) => getAssociatedTokenAddressSync(mint, owner, true);
  const balance = async (a: PublicKey) => Number((await getAccount(connection, a)).amount);
  const positionPda = (owner: PublicKey) =>
    PublicKey.findProgramAddressSync([Buffer.from("position"), vault.toBuffer(), owner.toBuffer()], program.programId)[0];

  const expectError = async (promise: Promise<unknown>, code: string) => {
    try {
      await promise;
      assert.fail(`ожидалась ошибка ${code}`);
    } catch (e: any) {
      const text = [e?.error?.errorCode?.code, e?.message, ...(e?.logs ?? [])].join("\n");
      expect(text).to.include(code);
    }
  };

  /** swap_via_clmm от имени vault: inputMint -> другой токен пула. */
  const vaultSwap = async (
    inputMint: PublicKey,
    amountIn: number,
    minOut: number,
    opts: { signer?: Keypair; poolState?: PublicKey } = {}
  ) => {
    const outputMint = inputMint.equals(p.mint0) ? p.mint1 : p.mint0;
    const zeroForOne = inputMint.equals(p.mint0);
    const pool = await clmm.account.poolState.fetch(p.pool);
    const signer = opts.signer ?? admin;
    return program.methods
      .swapViaClmm(new BN(amountIn), new BN(minOut), new BN(0))
      .accountsPartial({
        authority: signer.publicKey,
        vault,
        clmmProgram: CLMM_PROGRAM_ID,
        ammConfig: p.ammConfig,
        poolState: opts.poolState ?? p.pool,
        inputTokenAccount: ata(inputMint, vault),
        outputTokenAccount: ata(outputMint, vault),
        inputVault: zeroForOne ? p.vault0 : p.vault1,
        outputVault: zeroForOne ? p.vault1 : p.vault0,
        observationState: p.observation,
        inputVaultMint: inputMint,
        outputVaultMint: outputMint,
        tokenProgram: TOKEN_PROGRAM_ID,
        tokenProgram2022: TOKEN_2022_PROGRAM_ID,
        memoProgram: MEMO_PROGRAM_ID,
      })
      .remainingAccounts(await swapRemainingAccounts(connection, p, pool.tickCurrent, zeroForOne))
      .preInstructions([computeBudget()])
      .signers([signer])
      .rpc();
  };

  before(async () => {
    const sig = await connection.requestAirdrop(alice.publicKey, 2 * LAMPORTS_PER_SOL);
    await connection.confirmTransaction({ signature: sig, ...(await connection.getLatestBlockhash()) }, "confirmed");

    // Токены и пул Raydium с ценой 1:1 и глубокой ликвидностью вокруг цены
    underlying = await createMint(connection, admin, admin.publicKey, null, DECIMALS);
    pair = await createMint(connection, admin, admin.publicKey, null, DECIMALS);
    p = poolAddresses(underlying, pair);
    for (const m of [underlying, pair]) {
      const a = await getOrCreateAssociatedTokenAccount(connection, admin, m, admin.publicKey);
      await mintTo(connection, admin, m, a.address, admin, 10_000_000 * ONE);
    }
    const aliceAta = await getOrCreateAssociatedTokenAccount(connection, admin, underlying, alice.publicKey);
    await mintTo(connection, admin, underlying, aliceAta.address, admin, 10_000 * ONE);

    await createPool(clmm, admin, p, 1, DECIMALS, DECIMALS);
    await openWalletPosition(clmm, admin, p, alignTick(-3000), alignTick(3000), 1_000_000 * ONE, 1_100_000 * ONE);

    // Vault для underlying, привязанный к пулу
    [vault] = PublicKey.findProgramAddressSync([Buffer.from("vault"), underlying.toBuffer()], program.programId);
    [shareMint] = PublicKey.findProgramAddressSync([Buffer.from("shares"), vault.toBuffer()], program.programId);
    await program.methods
      .initializeVault(new BN(0), 100)
      .accountsPartial({ authority: admin.publicKey, underlyingMint: underlying, tokenProgram: TOKEN_PROGRAM_ID })
      .rpc();
    await program.methods
      .updateConfig({ newAuthority: null, liquidityPool: p.pool, depositCap: null, feeBps: null, paused: null })
      .accountsPartial({ authority: admin.publicKey, vault })
      .rpc();

    // Пользователь вносит 1000 underlying
    await program.methods
      .openPosition()
      .accountsPartial({ owner: alice.publicKey, vault, userPosition: positionPda(alice.publicKey) })
      .signers([alice])
      .rpc();
    await program.methods
      .deposit(new BN(1_000 * ONE), new BN(0))
      .accountsPartial({
        owner: alice.publicKey,
        vault,
        userPosition: positionPda(alice.publicKey),
        underlyingMint: underlying,
        shareMint,
        vaultTokenAccount: ata(underlying, vault),
        userTokenAccount: ata(underlying, alice.publicKey),
        userShareAccount: ata(shareMint, alice.publicKey),
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([alice])
      .rpc();
  });

  describe("неделя 12: swap через Raydium", () => {
    it("vault меняет underlying на парный токен с min_amount_out", async () => {
      const before = await balance(ata(underlying, vault));
      const poolBefore = await clmm.account.poolState.fetch(p.pool);

      await vaultSwap(underlying, 300 * ONE, 299 * ONE);

      const received = await balance(ata(pair, vault));
      assert.equal(before - (await balance(ata(underlying, vault))), 300 * ONE, "списано ровно amount_in");
      // Комиссия пула 0.25% -> ~299.25 при глубокой ликвидности
      assert.isAtLeast(received, 299 * ONE);
      assert.isBelow(received, 300 * ONE);

      const poolAfter = await clmm.account.poolState.fetch(p.pool);
      assert.notEqual(poolAfter.sqrtPriceX64.toString(), poolBefore.sqrtPriceX64.toString(), "цена в пуле сдвинулась");
    });

    it("slippage: Raydium отклоняет swap, если на выходе меньше min_amount_out", async () => {
      await expectError(vaultSwap(underlying, 100 * ONE, 100 * ONE), "TooLittleOutputReceived");
    });

    it("min_amount_out = 0 запрещён (swap без защиты от проскальзывания)", async () => {
      await expectError(vaultSwap(underlying, 100 * ONE, 0), "MinAmountOutRequired");
    });

    it("обратный swap: парный токен -> underlying", async () => {
      const pairBalance = await balance(ata(pair, vault));
      const before = await balance(ata(underlying, vault));

      await vaultSwap(pair, pairBalance, Math.floor(pairBalance * 0.99));

      assert.equal(await balance(ata(pair, vault)), 0);
      const back = (await balance(ata(underlying, vault))) - before;
      // Два swap по 0.25% -> вернулось ~99.5% от 300
      assert.approximately(back, 298.5 * ONE, 0.5 * ONE);
    });

    it("swap может делать только authority vault", async () => {
      await expectError(vaultSwap(underlying, 10 * ONE, 9 * ONE, { signer: alice }), "ConstraintHasOne");
    });

    it("swap только через пул из настроек vault", async () => {
      // Любой другой аккаунт Raydium вместо пула отклоняется
      await expectError(vaultSwap(underlying, 10 * ONE, 9 * ONE, { poolState: p.observation }), "WrongPool");
    });
  });

  describe("неделя 13: позиция vault в CLMM-пуле", () => {
    const HALF_WIDTH = 600; // ±~6%
    let c: VaultCtx;
    let firstNft: PublicKey;

    const record = () => program.account.vaultClmmPosition.fetch(positionRecordPda(program.programId, vault));
    const tickCurrent = async () => (await clmm.account.poolState.fetch(p.pool)).tickCurrent;

    /** Торговля «других» участников пула: swap с кошелька admin (двигает цену и платит комиссии LP). */
    const walletSwap = async (zeroForOne: boolean, amount: number) => {
      const state = await clmm.account.poolState.fetch(p.pool);
      await clmm.methods
        .swapV2(new BN(amount), new BN(0), new BN(0), true)
        .accountsPartial({
          payer: admin.publicKey,
          ammConfig: p.ammConfig,
          poolState: p.pool,
          inputTokenAccount: ata(zeroForOne ? p.mint0 : p.mint1, admin.publicKey),
          outputTokenAccount: ata(zeroForOne ? p.mint1 : p.mint0, admin.publicKey),
          inputVault: zeroForOne ? p.vault0 : p.vault1,
          outputVault: zeroForOne ? p.vault1 : p.vault0,
          observationState: p.observation,
          tokenProgram: TOKEN_PROGRAM_ID,
          tokenProgram2022: TOKEN_2022_PROGRAM_ID,
          memoProgram: MEMO_PROGRAM_ID,
          inputVaultMint: zeroForOne ? p.mint0 : p.mint1,
          outputVaultMint: zeroForOne ? p.mint1 : p.mint0,
        })
        .remainingAccounts(await swapRemainingAccounts(connection, p, state.tickCurrent, zeroForOne))
        .preInstructions([computeBudget()])
        .rpc();
    };

    before(async () => {
      c = { program, clmm, connection, authority: admin, vault, pool: p };
      // Для позиции в диапазоне нужны оба токена: меняем часть underlying на парный токен
      await vaultSwap(underlying, 400 * ONE, 398 * ONE);
    });

    it("open_clmm_position: неверный диапазон отклоняется", async () => {
      await expectError(openVaultPosition(c, 600, 0, 1 * ONE, 1 * ONE, true), "InvalidTickRange");
    });

    it("open_clmm_position: только authority vault", async () => {
      const { tickLower, tickUpper } = rangeAroundPrice(await tickCurrent(), HALF_WIDTH);
      // alice сама платит за транзакцию (иначе лишняя подпись не влезает в 1232 байта)
      const asAlice = new Program<LiquidityVault>(
        program.idl,
        new anchor.AnchorProvider(connection, new anchor.Wallet(alice), { commitment: "confirmed" })
      );
      await expectError(
        openVaultPosition({ ...c, program: asAlice, authority: alice }, tickLower, tickUpper, 1 * ONE, 1 * ONE, true),
        "ConstraintHasOne"
      );
    });

    it("open_clmm_position: vault открывает позицию в диапазоне вокруг текущей цены", async () => {
      const tick = await tickCurrent();
      const { tickLower, tickUpper } = rangeAroundPrice(tick, HALF_WIDTH);
      const before = await vaultBalances(c);
      const base = Math.floor(Math.min(before.amount0, before.amount1) * 0.9);

      firstNft = await openVaultPosition(c, tickLower, tickUpper, base, before.amount1, true);

      const r = await record();
      assert.ok(r.vault.equals(vault));
      assert.ok(r.pool.equals(p.pool));
      assert.ok(r.nftMint.equals(firstNft));
      assert.equal(r.tickLower, tickLower);
      assert.equal(r.tickUpper, tickUpper);
      assert.isTrue(tickLower <= tick && tick < tickUpper, "текущая цена внутри диапазона");

      // Ликвидность позиции Raydium = записанной в vault
      const pos = await clmm.account.personalPositionState.fetch(personalPositionPda(firstNft));
      assert.equal(pos.liquidity.toString(), r.liquidity.toString());
      assert.isTrue(new BN(pos.liquidity).gtn(0));

      // NFT позиции у PDA position_authority, неиспользованные токены вернулись на vault
      const pa = positionAuthorityPda(program.programId, vault);
      assert.equal(await balance(ata(firstNft, pa)), 1);
      assert.equal(await balance(ata(p.mint0, pa)), 0);
      assert.equal(await balance(ata(p.mint1, pa)), 0);

      const after = await vaultBalances(c);
      assert.approximately(before.amount0 - after.amount0, base, 1, "base-токен внесён полностью");
      assert.isAbove(before.amount1 - after.amount1, 0, "второй токен внесён по цене");
    });

    it("open_clmm_position: вторую позицию открыть нельзя, пока есть активная", async () => {
      const tick = await tickCurrent();
      const { tickLower, tickUpper } = rangeAroundPrice(tick, HALF_WIDTH);
      await expectError(openVaultPosition(c, tickLower, tickUpper, 1 * ONE, 1 * ONE, true), "already in use");
    });

    it("collect_fees: vault забирает комиссии, заработанные позицией", async () => {
      // Объём торгов в обе стороны внутри диапазона
      await walletSwap(true, 50_000 * ONE);
      await walletSwap(false, 50_000 * ONE);
      const before = await vaultBalances(c);

      await collectFees(c);

      const after = await vaultBalances(c);
      const fee0 = after.amount0 - before.amount0;
      const fee1 = after.amount1 - before.amount1;
      assert.isAbove(fee0, 0, "комиссия в token0");
      assert.isAbove(fee1, 0, "комиссия в token1");

      const r = await record();
      assert.equal(r.feesCollected0.toNumber(), fee0);
      assert.equal(r.feesCollected1.toNumber(), fee1);
      // Ликвидность при сборе комиссий не меняется
      const pos = await clmm.account.personalPositionState.fetch(personalPositionPda(firstNft));
      assert.equal(pos.liquidity.toString(), r.liquidity.toString());
    });

    it("collect_fees: только authority vault", async () => {
      await expectError(collectFees(c, alice), "ConstraintHasOne");
    });

    it("rebalance: пока цена в диапазоне, закрытие в режиме ребаланса отклоняется", async () => {
      await expectError(closeVaultPosition(c, true), "PositionInRange");
      const res = await rebalanceIfOutOfRange(c, HALF_WIDTH);
      assert.isFalse(res.rebalanced);
    });

    it("rebalance: цена вышла из диапазона -> позиция переставлена вокруг новой цены", async () => {
      const old = await record();
      // Крупная продажа token0 двигает цену вниз за нижнюю границу позиции
      await walletSwap(true, 300_000 * ONE);
      const tick = await tickCurrent();
      assert.isBelow(tick, old.tickLower, "цена ниже диапазона");

      const res = await rebalanceIfOutOfRange(c, HALF_WIDTH);
      assert.isTrue(res.rebalanced);

      const r = await record();
      assert.notOk(r.nftMint.equals(old.nftMint), "новая позиция");
      const now = await tickCurrent();
      assert.isTrue(r.tickLower <= now && now < r.tickUpper, "новая цена внутри нового диапазона");
      assert.isTrue(new BN(r.liquidity).gtn(0));

      // Старая позиция Raydium закрыта, NFT сожжён
      assert.isNull(await connection.getAccountInfo(personalPositionPda(old.nftMint)));
      assert.equal(Number((await getMint(connection, old.nftMint)).supply), 0);
    });

    it("close_clmm_position: вся ликвидность возвращается на vault", async () => {
      const r = await record();
      const before = await vaultBalances(c);

      await closeVaultPosition(c, false);

      const after = await vaultBalances(c);
      assert.isAbove(after.amount0 + after.amount1, before.amount0 + before.amount1);
      assert.isNull(await connection.getAccountInfo(positionRecordPda(program.programId, vault)), "запись о позиции закрыта");
      assert.isNull(await connection.getAccountInfo(personalPositionPda(r.nftMint)));

      // После закрытия можно открыть новую позицию
      const { tickLower, tickUpper } = rangeAroundPrice(await tickCurrent(), HALF_WIDTH);
      const bal = await vaultBalances(c);
      await openVaultPosition(c, tickLower, tickUpper, Math.floor(Math.min(bal.amount0, bal.amount1) * 0.5), bal.amount1, true);
      assert.ok((await record()).tickLower === tickLower);
    });
  });
});
