// Неделя 11: разбираемся с Raydium CLMM на localnet (программа склонирована из devnet).
// Создаём свои тестовые токены, CLMM-пул, добавляем ликвидность в диапазоне и делаем swap.
import * as anchor from "@coral-xyz/anchor";
import { BN } from "@coral-xyz/anchor";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createMint,
  getAccount,
  getAssociatedTokenAddressSync,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { ComputeBudgetProgram, Connection, Keypair, PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY } from "@solana/web3.js";
import { assert } from "chai";
import {
  alignTick,
  clmmProgram,
  CLMM_PROGRAM_ID,
  MEMO_PROGRAM_ID,
  metadataPda,
  METADATA_PROGRAM_ID,
  personalPositionPda,
  poolAddresses,
  PoolAddresses,
  priceToSqrtPriceX64,
  protocolPositionPda,
  Q64,
  sqrtPriceX64ToPrice,
  tickArrayPda,
  tickArrayStartIndex,
  TICK_SPACING,
} from "../client/clmm";

describe("raydium-clmm (неделя 11)", () => {
  const env = anchor.AnchorProvider.env();
  const provider = new anchor.AnchorProvider(
    new Connection(env.connection.rpcEndpoint, "confirmed"),
    env.wallet,
    { commitment: "confirmed", preflightCommitment: "confirmed" }
  );
  anchor.setProvider(provider);
  const connection = provider.connection;
  const wallet = (provider.wallet as anchor.Wallet).payer;
  const clmm = clmmProgram(provider);

  const DECIMALS = 6;
  const ONE = 10 ** DECIMALS;
  let p: PoolAddresses;

  const ata = (mint: PublicKey, owner = wallet.publicKey) => getAssociatedTokenAddressSync(mint, owner, true);
  const balance = async (a: PublicKey) => Number((await getAccount(connection, a)).amount);
  const cu = ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000_000 });

  /** Открывает позицию LP в диапазоне [tickLower, tickUpper] от имени кошелька. */
  const openPosition = async (tickLower: number, tickUpper: number, amount0Max: number, amount1Max: number, baseFlag: boolean) => {
    const nftMint = Keypair.generate();
    const lowerStart = tickArrayStartIndex(tickLower);
    const upperStart = tickArrayStartIndex(tickUpper);
    await clmm.methods
      .openPositionV2(
        tickLower,
        tickUpper,
        lowerStart,
        upperStart,
        new BN(0), // liquidity = 0 -> Raydium посчитает её из base-токена
        new BN(amount0Max),
        new BN(amount1Max),
        false,
        baseFlag
      )
      .accountsPartial({
        payer: wallet.publicKey,
        positionNftOwner: wallet.publicKey,
        positionNftMint: nftMint.publicKey,
        positionNftAccount: ata(nftMint.publicKey),
        metadataAccount: metadataPda(nftMint.publicKey),
        poolState: p.pool,
        protocolPosition: protocolPositionPda(p.pool, tickLower, tickUpper),
        tickArrayLower: tickArrayPda(p.pool, lowerStart),
        tickArrayUpper: tickArrayPda(p.pool, upperStart),
        personalPosition: personalPositionPda(nftMint.publicKey),
        tokenAccount0: ata(p.mint0),
        tokenAccount1: ata(p.mint1),
        tokenVault0: p.vault0,
        tokenVault1: p.vault1,
        rent: SYSVAR_RENT_PUBKEY,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        metadataProgram: METADATA_PROGRAM_ID,
        tokenProgram2022: TOKEN_2022_PROGRAM_ID,
        vault0Mint: p.mint0,
        vault1Mint: p.mint1,
      })
      .preInstructions([cu])
      .signers([nftMint])
      .rpc();
    return nftMint.publicKey;
  };

  before(async () => {
    // Свои тестовые токены
    const mintA = await createMint(connection, wallet, wallet.publicKey, null, DECIMALS);
    const mintB = await createMint(connection, wallet, wallet.publicKey, null, DECIMALS);
    p = poolAddresses(mintA, mintB);
    for (const m of [p.mint0, p.mint1]) {
      const a = await getOrCreateAssociatedTokenAccount(connection, wallet, m, wallet.publicKey);
      await mintTo(connection, wallet, m, a.address, wallet, 1_000_000 * ONE);
    }
  });

  it("create_pool: пул с начальной ценой 1 token1 = 1 token0", async () => {
    const sqrtPrice = priceToSqrtPriceX64(1, DECIMALS, DECIMALS);
    assert.equal(sqrtPrice, Q64, "sqrt(1) * 2^64");

    await clmm.methods
      .createPool(new BN(sqrtPrice.toString()), new BN(0))
      .accountsPartial({
        poolCreator: wallet.publicKey,
        ammConfig: p.ammConfig,
        poolState: p.pool,
        tokenMint0: p.mint0,
        tokenMint1: p.mint1,
        tokenVault0: p.vault0,
        tokenVault1: p.vault1,
        observationState: p.observation,
        tickArrayBitmap: p.bitmapExtension,
        tokenProgram0: TOKEN_PROGRAM_ID,
        tokenProgram1: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .rpc();

    const pool = await clmm.account.poolState.fetch(p.pool);
    assert.ok(pool.tokenMint0.equals(p.mint0));
    assert.ok(pool.tokenMint1.equals(p.mint1));
    assert.ok(pool.ammConfig.equals(p.ammConfig));
    assert.equal(pool.tickSpacing, TICK_SPACING);
    assert.equal(pool.tickCurrent, 0, "цена 1.0 -> тик 0");
    assert.equal(BigInt(pool.sqrtPriceX64.toString()), Q64);
    assert.equal(pool.liquidity.toString(), "0", "ликвидности ещё нет");
  });

  it("open_position_v2: ликвидность в диапазоне ±6% вокруг текущей цены", async () => {
    const tickLower = alignTick(-600); // 1.0001^-600 ≈ 0.942
    const tickUpper = alignTick(600); //  1.0001^600  ≈ 1.062
    const before0 = await balance(ata(p.mint0));
    const before1 = await balance(ata(p.mint1));

    const nft = await openPosition(tickLower, tickUpper, 10_000 * ONE, 11_000 * ONE, true);

    const spent0 = before0 - (await balance(ata(p.mint0)));
    const spent1 = before1 - (await balance(ata(p.mint1)));
    // Цена в середине симметричного диапазона -> оба токена вносятся примерно поровну
    assert.approximately(spent0, 10_000 * ONE, 1);
    assert.approximately(spent1, 10_000 * ONE, 10 * ONE);

    const pos = await clmm.account.personalPositionState.fetch(personalPositionPda(nft));
    assert.equal(pos.tickLowerIndex, tickLower);
    assert.equal(pos.tickUpperIndex, tickUpper);
    assert.isTrue(new BN(pos.liquidity).gtn(0));
    assert.equal(await balance(ata(nft)), 1, "позиция представлена NFT");

    const pool = await clmm.account.poolState.fetch(p.pool);
    assert.equal(pool.liquidity.toString(), pos.liquidity.toString(), "активная ликвидность пула = наша позиция");
  });

  it("open_position_v2: диапазон выше текущей цены принимает только token0", async () => {
    const before1 = await balance(ata(p.mint1));
    await openPosition(alignTick(1200), alignTick(2400), 1_000 * ONE, 0, true);
    assert.equal(before1 - (await balance(ata(p.mint1))), 0, "token1 не нужен: цена ниже диапазона");

    // Вне текущей цены -> не входит в активную ликвидность
    const pool = await clmm.account.poolState.fetch(p.pool);
    const inRange = await clmm.account.personalPositionState.all([
      { memcmp: { offset: 8 + 1 + 32, bytes: p.pool.toBase58() } },
    ]);
    assert.equal(inRange.length, 2);
    assert.equal(
      pool.liquidity.toString(),
      inRange.find((x) => x.account.tickLowerIndex === alignTick(-600))!.account.liquidity.toString()
    );
  });

  it("swap_v2: обмен token0 -> token1 двигает цену вниз", async () => {
    const amountIn = 1_000 * ONE;
    const before1 = await balance(ata(p.mint1));
    const poolBefore = await clmm.account.poolState.fetch(p.pool);

    await clmm.methods
      .swapV2(new BN(amountIn), new BN(990 * ONE), new BN(0), true)
      .accountsPartial({
        payer: wallet.publicKey,
        ammConfig: p.ammConfig,
        poolState: p.pool,
        inputTokenAccount: ata(p.mint0),
        outputTokenAccount: ata(p.mint1),
        inputVault: p.vault0,
        outputVault: p.vault1,
        observationState: p.observation,
        tokenProgram: TOKEN_PROGRAM_ID,
        tokenProgram2022: TOKEN_2022_PROGRAM_ID,
        memoProgram: MEMO_PROGRAM_ID,
        inputVaultMint: p.mint0,
        outputVaultMint: p.mint1,
      })
      .remainingAccounts([
        { pubkey: p.bitmapExtension, isSigner: false, isWritable: false },
        { pubkey: tickArrayPda(p.pool, 0), isSigner: false, isWritable: true },
        { pubkey: tickArrayPda(p.pool, tickArrayStartIndex(-600)), isSigner: false, isWritable: true },
      ])
      .preInstructions([cu])
      .rpc();

    const received = (await balance(ata(p.mint1))) - before1;
    const poolAfter = await clmm.account.poolState.fetch(p.pool);
    const priceAfter = sqrtPriceX64ToPrice(BigInt(poolAfter.sqrtPriceX64.toString()), DECIMALS, DECIMALS);

    // Комиссия 0.25% + сдвиг цены -> получено чуть меньше 1000
    assert.isBelow(received, amountIn);
    assert.isAbove(received, 990 * ONE);
    assert.isBelow(poolAfter.tickCurrent, poolBefore.tickCurrent + 1);
    assert.isBelow(priceAfter, 1);
    assert.isTrue(new BN(poolAfter.feeGrowthGlobal0X64).gt(new BN(poolBefore.feeGrowthGlobal0X64)), "LP заработали комиссию в token0");
  });

  it("swap_v2: ограничение other_amount_threshold (slippage) отклоняет невыгодный обмен", async () => {
    try {
      await clmm.methods
        .swapV2(new BN(100 * ONE), new BN(100 * ONE), new BN(0), true)
        .accountsPartial({
          payer: wallet.publicKey,
          ammConfig: p.ammConfig,
          poolState: p.pool,
          inputTokenAccount: ata(p.mint0),
          outputTokenAccount: ata(p.mint1),
          inputVault: p.vault0,
          outputVault: p.vault1,
          observationState: p.observation,
          tokenProgram: TOKEN_PROGRAM_ID,
          tokenProgram2022: TOKEN_2022_PROGRAM_ID,
          memoProgram: MEMO_PROGRAM_ID,
          inputVaultMint: p.mint0,
          outputVaultMint: p.mint1,
        })
        .remainingAccounts([
          { pubkey: p.bitmapExtension, isSigner: false, isWritable: false },
          { pubkey: tickArrayPda(p.pool, 0), isSigner: false, isWritable: true },
          { pubkey: tickArrayPda(p.pool, tickArrayStartIndex(-600)), isSigner: false, isWritable: true },
        ])
        .preInstructions([cu])
        .rpc();
      assert.fail("должно упасть");
    } catch (e: any) {
      assert.match(String(e?.error?.errorCode?.code ?? e), /TooLittleOutputReceived/);
    }
  });

  it("программа Raydium — та же, что в devnet", async () => {
    const info = await connection.getAccountInfo(CLMM_PROGRAM_ID);
    assert.isTrue(info!.executable);
  });
});
