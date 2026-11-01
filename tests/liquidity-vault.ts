import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import {
  createMint,
  getAssociatedTokenAddressSync,
  getMint,
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
});
