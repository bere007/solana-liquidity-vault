// Vault + Raydium CLMM: swap токенов vault через пул (неделя 12).
import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import {
  createMint,
  getAccount,
  getAssociatedTokenAddressSync,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { assert, expect } from "chai";
import { LiquidityVault } from "../target/types/liquidity_vault";
import { alignTick, clmmProgram, CLMM_PROGRAM_ID, MEMO_PROGRAM_ID, poolAddresses, PoolAddresses } from "../client/clmm";
import { computeBudget, createPool, openWalletPosition, swapRemainingAccounts } from "../client/raydium";

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
});
