/**
 * Gasless USDC (SPL token) transfer, sponsored by the Obliq paymaster.
 *
 * Like the SOL example, but the sponsored transaction:
 *   - transfers an SPL token (USDC) between associated token accounts (ATAs), and
 *   - idempotently creates the recipient ATA, with the Obliq fee payer paying the
 *     rent — so the user spends ZERO SOL even when onboarding a new recipient.
 *
 * Because the base Kora config only allows the System program, the tenant must
 * first widen its policy to allow the Token + ATA programs. `npm run setup` does
 * that (POST /v1/tenants/{id}/config) along with local test-token provisioning.
 *
 * Usage:
 *   npx tsx index.ts register   # tenant + API key
 *   npx tsx index.ts setup      # fund fee payer, widen tenant policy, mint test USDC (local)
 *   npx tsx index.ts transfer   # the gasless USDC transfer (default)
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import {
  Connection,
  Keypair,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createMint,
  mintTo,
  getOrCreateAssociatedTokenAccount,
  getAssociatedTokenAddressSync,
  getAccount,
  createTransferInstruction,
  createAssociatedTokenAccountIdempotentInstruction,
} from "@solana/spl-token";
import bs58 from "bs58";
import dotenv from "dotenv";

// Look in this example's own directory first, then one level up. Each example is
// a separate package, so `dotenv` would otherwise only ever see a `.env` sitting
// beside the file you ran — meaning the same key had to be pasted three times to
// try all three. The parent file lets you fill it in once; a local `.env` still
// wins, because the first file to define a key keeps it.
dotenv.config({ path: [".env", "../.env"] });

const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";
const OBLIQ_RPC_URL = process.env.OBLIQ_RPC_URL ?? "https://solana-paymaster-mainnet.kanalabs.io/rpc";
const OBLIQ_CONTROL_URL = process.env.OBLIQ_CONTROL_URL ?? "https://solana-paymaster-mainnet.kanalabs.io";
const AMOUNT_USDC = Number(process.env.AMOUNT_USDC ?? "1.0");
const DECIMALS = 6;
const SYSTEM_PROGRAM = "11111111111111111111111111111111";

const connection = new Connection(SOLANA_RPC_URL, "confirmed");

// --- Obliq JSON-RPC client (identical to the SOL example) -------------------
async function obliqRpc<T = any>(method: string, params: unknown = {}): Promise<T> {
  const res = await fetch(OBLIQ_RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${requireEnv("OBLIQ_API_KEY")}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = (await res.json()) as { result?: T; error?: { code: number; message: string; data?: unknown } };
  if (body.error) throw new Error(`Obliq ${method}: [${body.error.code}] ${body.error.message} ${JSON.stringify(body.error.data ?? {})}`);
  return body.result as T;
}

// --- helpers ----------------------------------------------------------------
function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name}. Run the earlier step first or set it in .env.`);
  return v;
}
function isLocalOrDevnet(): boolean {
  return /127\.0\.0\.1|localhost|devnet/.test(SOLANA_RPC_URL);
}
function explorerTxUrl(sig: string): string {
  if (SOLANA_RPC_URL.includes("devnet")) return `https://explorer.solana.com/tx/${sig}?cluster=devnet`;
  if (isLocalOrDevnet()) return `https://explorer.solana.com/tx/${sig}?cluster=custom&customUrl=${encodeURIComponent(SOLANA_RPC_URL)}`;
  return `https://explorer.solana.com/tx/${sig}`;
}
function writeEnv(key: string, value: string): void {
  const path = ".env";
  let text = existsSync(path) ? readFileSync(path, "utf8") : "";
  const line = `${key}=${value}`;
  text = new RegExp(`^${key}=.*$`, "m").test(text)
    ? text.replace(new RegExp(`^${key}=.*$`, "m"), line)
    : text + (text.endsWith("\n") || text === "" ? "" : "\n") + line + "\n";
  writeFileSync(path, text);
}
// Devnet's faucet is rate-limited and flaky. Make funding idempotent and patient:
// skip if the account already holds enough (so an account pre-funded out of band
// short-circuits), otherwise request an airdrop and retry with backoff. FLOOR
// covers what these examples actually spend (fees + rent are well under 0.05 SOL).
const AIRDROP_FLOOR_LAMPORTS = 0.05 * LAMPORTS_PER_SOL;
async function airdrop(pubkey: PublicKey, sol: number): Promise<void> {
  const need = Math.floor(sol * LAMPORTS_PER_SOL);
  const threshold = Math.min(need, AIRDROP_FLOOR_LAMPORTS);
  if ((await connection.getBalance(pubkey)) >= threshold) return; // already funded
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 8; attempt++) {
    try {
      const sig = await connection.requestAirdrop(pubkey, need);
      const bh = await connection.getLatestBlockhash();
      await connection.confirmTransaction({ signature: sig, ...bh }, "confirmed");
      return;
    } catch (e) {
      lastErr = e;
      if ((await connection.getBalance(pubkey)) >= threshold) return; // funded out of band
      await new Promise((r) => setTimeout(r, 2000 * attempt)); // backoff for the rate limit
    }
  }
  throw new Error(`airdrop to ${pubkey.toBase58()} failed after retries (devnet faucet rate-limited): ${lastErr}. Pre-fund it manually and re-run.`);
}
function loadUser(): Keypair {
  const raw = process.env.USER_WALLET_SECRET_KEY?.trim();
  if (raw) return Keypair.fromSecretKey(raw.startsWith("[") ? Uint8Array.from(JSON.parse(raw)) : bs58.decode(raw));
  if (!isLocalOrDevnet()) throw new Error("USER_WALLET_SECRET_KEY is required on mainnet.");
  // Deterministic-per-run throwaway, persisted to .env so setup + transfer agree.
  const kp = Keypair.generate();
  writeEnv("USER_WALLET_SECRET_KEY", bs58.encode(kp.secretKey));
  return kp;
}

// --- subcommands ------------------------------------------------------------
async function cmdRegister() {
  const res = await fetch(`${OBLIQ_CONTROL_URL}/v1/tenants`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "gasless-transfer-usdc", fee_payers: 1 }),
  });
  const body = (await res.json()) as any;
  if (!res.ok) throw new Error(`register failed: ${JSON.stringify(body)}`);
  writeEnv("OBLIQ_API_KEY", body.api_key);
  writeEnv("OBLIQ_TENANT_ID", body.tenant_id); // setup needs it to POST /v1/tenants/{id}/config
  console.log("✔ Tenant:", body.tenant_id, "\n✔ API key saved to .env\n✔ Fee payer:", body.fee_payers[0]);
  console.log("\nNext: `npm run setup`");
}

// Widen the tenant's Kora policy so the Token + ATA programs are sponsorable,
// then (on local) provision a test mint and mint USDC to the user.
async function cmdSetup() {
  const { fee_payer } = await obliqRpc<{ fee_payer: string }>("getConfig");
  const tenantId = await tenantIdFromKey();

  // 1. fund the fee payer so it can pay fees + ATA rent
  if (isLocalOrDevnet()) await airdrop(new PublicKey(fee_payer), 2);

  // 2. resolve / create the USDC mint
  const user = loadUser();
  if (isLocalOrDevnet()) await airdrop(user.publicKey, 1); // SOL for *setup* only (mint/ATA creation)
  let mint = process.env.USDC_MINT?.trim();
  if (!mint) {
    if (!isLocalOrDevnet()) throw new Error("Set USDC_MINT for devnet/mainnet.");
    const mintPk = await createMint(connection, user, user.publicKey, null, DECIMALS);
    mint = mintPk.toBase58();
    writeEnv("USDC_MINT", mint);
    const userAta = await getOrCreateAssociatedTokenAccount(connection, user, mintPk, user.publicKey);
    await mintTo(connection, user, mintPk, userAta.address, user, 1_000 * 10 ** DECIMALS); // 1000 test USDC
    console.log("✔ Created test USDC mint:", mint, "and minted 1000 to the user");
  }

  // 3. push the tenant config so Kora will sponsor Token + ATA program use
  const overrides = {
    allowed_programs: [SYSTEM_PROGRAM, TOKEN_PROGRAM_ID.toBase58(), ASSOCIATED_TOKEN_PROGRAM_ID.toBase58()],
    allowed_tokens: [mint],
    // Funding the recipient ATA's rent is account *creation*, not a transfer —
    // this is the narrow grant for exactly that, and unlike
    // `allow_system_transfer` it cannot move the fee payer's lamports anywhere
    // but a new account the transaction creates.
    allow_fee_payer_account_funding: true,
    allow_spl_transfer: true,
  };
  const res = await fetch(`${OBLIQ_CONTROL_URL}/v1/tenants/${tenantId}/config`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${requireEnv("OBLIQ_API_KEY")}` },
    body: JSON.stringify(overrides),
  });
  if (!res.ok) throw new Error(`config update failed: ${JSON.stringify(await res.json())}`);
  console.log("✔ Tenant policy widened to allow Token + ATA programs");
  console.log("\nNext: `npm start`");
}

async function cmdTransfer() {
  const mint = new PublicKey(requireEnv("USDC_MINT"));
  const { fee_payer } = await obliqRpc<{ fee_payer: string }>("getConfig");
  const feePayer = new PublicKey(fee_payer);
  const user = loadUser();
  const recipient = process.env.RECIPIENT ? new PublicKey(process.env.RECIPIENT) : Keypair.generate().publicKey;

  const userAta = getAssociatedTokenAddressSync(mint, user.publicKey);
  const recipientAta = getAssociatedTokenAddressSync(mint, recipient);
  const amount = BigInt(Math.round(AMOUNT_USDC * 10 ** DECIMALS));

  const userSolBefore = await connection.getBalance(user.publicKey);
  const userUsdcBefore = (await getAccount(connection, userAta)).amount;
  console.log("Obliq fee payer:", feePayer.toBase58());
  console.log("User:", user.publicKey.toBase58(), `(${userSolBefore / LAMPORTS_PER_SOL} SOL, ${Number(userUsdcBefore) / 10 ** DECIMALS} USDC)`);

  // Build the sponsored tx: fee payer = Obliq. Idempotently create the recipient
  // ATA (rent paid by the fee payer), then transfer. The user only authorizes.
  const { blockhash } = await connection.getLatestBlockhash("confirmed");
  const message = new TransactionMessage({
    payerKey: feePayer,
    recentBlockhash: blockhash,
    instructions: [
      createAssociatedTokenAccountIdempotentInstruction(feePayer, recipientAta, recipient, mint),
      createTransferInstruction(userAta, recipientAta, user.publicKey, amount),
    ],
  }).compileToV0Message();
  const tx = new VersionedTransaction(message);
  tx.sign([user]); // user authorizes the transfer; fee-payer slot left for Obliq

  const sent = await obliqRpc<{ signature: string; signer_pubkey: string; fee_lamports: number }>(
    "signAndSendTransaction",
    { transaction: Buffer.from(tx.serialize()).toString("base64") },
  );
  await connection.confirmTransaction(sent.signature, "confirmed");

  const userSolAfter = await connection.getBalance(user.publicKey);
  const userUsdcAfter = (await getAccount(connection, userAta)).amount;
  console.log("\n✔ Sponsored signature:", sent.signature);
  console.log("✔ Co-signed by (fee payer):", sent.signer_pubkey);
  console.log(`✔ User SOL delta:  ${(userSolAfter - userSolBefore) / LAMPORTS_PER_SOL}  (expected 0 — gasless)`);
  console.log(`✔ User USDC delta: ${(Number(userUsdcAfter) - Number(userUsdcBefore)) / 10 ** DECIMALS}  (expected -${AMOUNT_USDC})`);
  console.log("→ Explorer:", explorerTxUrl(sent.signature));

  if (userSolAfter !== userSolBefore) throw new Error(`User SOL changed by ${userSolAfter - userSolBefore} lamports — expected 0 (gasless).`);
  console.log("\n✅ GASLESS CONFIRMED: USDC moved, the user spent 0 SOL.");
}

async function tenantIdFromKey(): Promise<string> {
  // Captured into .env by `npm run register` (the control plane does not expose a
  // "who am I" lookup, so we persist the id at registration time).
  const id = process.env.OBLIQ_TENANT_ID;
  if (id) return id;
  throw new Error("OBLIQ_TENANT_ID not set. Re-run `npm run register` (it captures the tenant id).");
}

async function main() {
  const cmd = process.argv[2] ?? "transfer";
  if (cmd === "register") return cmdRegister();
  if (cmd === "setup") return cmdSetup();
  if (cmd === "transfer") return cmdTransfer();
  throw new Error(`Unknown command "${cmd}". Use: register | setup | transfer`);
}
main().catch((e) => {
  console.error("\n✖", e.message ?? e);
  process.exit(1);
});
