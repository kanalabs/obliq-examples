/**
 * Gasless SOL transfer, sponsored by the Obliq paymaster.
 *
 * The end user sends SOL but pays ZERO fee — the Obliq fee payer pays it.
 *
 * Flow:
 *   1. (register)  POST /v1/tenants            -> tenant + API key + fee payer
 *   2. getConfig                               -> the Obliq fee-payer pubkey
 *   3. build a v0 tx whose FEE PAYER is Obliq, transferring from the user
 *   4. the USER signs only their own slot (partial sign)
 *   5. signAndSendTransaction(base64 tx)       -> Obliq co-signs + submits
 *   6. verify balances: user pays the amount, Obliq pays the fee
 *
 * Usage:
 *   npx tsx index.ts register   # mint a tenant + API key (writes OBLIQ_API_KEY to .env)
 *   npx tsx index.ts fund       # airdrop SOL to the Obliq fee payer (local/devnet)
 *   npx tsx index.ts transfer   # the gasless transfer (default)
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import bs58 from "bs58";
import dotenv from "dotenv";

// Look in this example's own directory first, then one level up. Each example is
// a separate package, so `dotenv` would otherwise only ever see a `.env` sitting
// beside the file you ran — meaning the same key had to be pasted three times to
// try all three. The parent file lets you fill it in once; a local `.env` still
// wins, because the first file to define a key keeps it.
dotenv.config({ path: [".env", "../.env"] });

// --------------------------------------------------------------------------
// Config (everything comes from .env — see .env.example)
// --------------------------------------------------------------------------
const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";
const OBLIQ_RPC_URL = process.env.OBLIQ_RPC_URL ?? "https://solana-paymaster-mainnet.kanalabs.io/rpc";
const OBLIQ_CONTROL_URL = process.env.OBLIQ_CONTROL_URL ?? "https://solana-paymaster-mainnet.kanalabs.io";
const AMOUNT_SOL = Number(process.env.AMOUNT_SOL ?? "0.001");

const connection = new Connection(SOLANA_RPC_URL, "confirmed");

// --------------------------------------------------------------------------
// Tiny Obliq JSON-RPC client (this is the ONLY paymaster-specific code)
// --------------------------------------------------------------------------
async function obliqRpc<T = any>(method: string, params: unknown = {}): Promise<T> {
  const apiKey = requireEnv("OBLIQ_API_KEY");
  const res = await fetch(OBLIQ_RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = (await res.json()) as { result?: T; error?: { code: number; message: string; data?: unknown } };
  if (body.error) {
    throw new Error(
      `Obliq ${method} failed: [${body.error.code}] ${body.error.message} ${JSON.stringify(body.error.data ?? {})}`,
    );
  }
  return body.result as T;
}

// Register a tenant (dApp) and return its API key + fee payer. Local control
// plane is open; in production this endpoint is gated by an operator key.
async function registerTenant(name: string) {
  const res = await fetch(`${OBLIQ_CONTROL_URL}/v1/tenants`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, fee_payers: 1 }),
  });
  const body = (await res.json()) as any;
  if (!res.ok) throw new Error(`register failed: ${JSON.stringify(body)}`);
  return body as { tenant_id: string; api_key: string; fee_payers: string[] };
}

// New tenants are fail-closed: `allowed_programs` is empty until a tenant opts
// in (obliq-tenant::to_kora_config / obliq-core TenantConfig::default). Open
// just the System program this example touches.
//
// Note what is deliberately NOT set here: `allow_system_transfer`. That flag
// governs whether the FEE PAYER may be the *sender* of a System transfer —
// i.e. spend its own SOL. This example's transfer sends from the user
// (`fromPubkey: user.publicKey` below), so the fee payer is never the sender
// and the grant would be authority the example never exercises. Sponsoring a
// transfer is not the same as being allowed to make one.
const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";

async function allowSystemProgram(tenantId: string, apiKey: string) {
  const res = await fetch(`${OBLIQ_CONTROL_URL}/v1/tenants/${tenantId}/config`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ allowed_programs: [SYSTEM_PROGRAM_ID] }),
  });
  const body = (await res.json()) as any;
  if (!res.ok) throw new Error(`config update failed: ${JSON.stringify(body)}`);
}

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------
function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name}. Run "npm run register" first, or set it in .env.`);
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

// Load the user keypair from USER_WALLET_SECRET_KEY (base58 or JSON array), or generate
// a throwaway one on local/devnet and airdrop it the transfer amount.
async function loadOrCreateUser(): Promise<Keypair> {
  const raw = process.env.USER_WALLET_SECRET_KEY?.trim();
  if (raw) {
    const bytes = raw.startsWith("[") ? Uint8Array.from(JSON.parse(raw)) : bs58.decode(raw);
    return Keypair.fromSecretKey(bytes);
  }
  if (!isLocalOrDevnet()) throw new Error("USER_WALLET_SECRET_KEY is required on mainnet.");
  const user = Keypair.generate();
  await airdrop(user.publicKey, AMOUNT_SOL + 0.01); // amount + a little headroom
  return user;
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

// Persist OBLIQ_API_KEY back into .env so later commands pick it up.
function writeEnv(key: string, value: string): void {
  const path = ".env";
  const line = `${key}=${value}`;
  let text = existsSync(path) ? readFileSync(path, "utf8") : "";
  text = new RegExp(`^${key}=.*$`, "m").test(text)
    ? text.replace(new RegExp(`^${key}=.*$`, "m"), line)
    : text + (text.endsWith("\n") || text === "" ? "" : "\n") + line + "\n";
  writeFileSync(path, text);
}

// --------------------------------------------------------------------------
// Subcommands
// --------------------------------------------------------------------------
async function cmdRegister() {
  const reg = await registerTenant("gasless-transfer-sol");
  writeEnv("OBLIQ_API_KEY", reg.api_key);
  await allowSystemProgram(reg.tenant_id, reg.api_key);
  console.log("✔ Registered tenant:", reg.tenant_id);
  console.log("✔ API key (saved to .env):", reg.api_key);
  console.log("✔ Obliq fee payer:", reg.fee_payers[0]);
  console.log("✔ Opted in to System program transfers");
  console.log("\nNext: `npm run fund` (local/devnet) then `npm start`.");
}

async function cmdFund() {
  const { fee_payer } = await obliqRpc<{ fee_payer: string }>("getConfig");
  if (!isLocalOrDevnet()) throw new Error("Refusing to airdrop on mainnet — fund the fee payer manually.");
  await airdrop(new PublicKey(fee_payer), 1);
  const bal = await connection.getBalance(new PublicKey(fee_payer));
  console.log(`✔ Funded Obliq fee payer ${fee_payer}: ${bal / LAMPORTS_PER_SOL} SOL`);
}

async function cmdTransfer() {
  // 1. Who is the Obliq fee payer for our tenant?
  const { fee_payer } = await obliqRpc<{ fee_payer: string }>("getConfig");
  const feePayer = new PublicKey(fee_payer);

  // 2. The end user + recipient.
  const user = await loadOrCreateUser();
  const recipient = process.env.RECIPIENT ? new PublicKey(process.env.RECIPIENT) : Keypair.generate().publicKey;
  const lamports = Math.floor(AMOUNT_SOL * LAMPORTS_PER_SOL);

  const userBefore = await connection.getBalance(user.publicKey);
  const feePayerBefore = await connection.getBalance(feePayer);
  console.log("Obliq fee payer:", feePayer.toBase58(), `(${feePayerBefore / LAMPORTS_PER_SOL} SOL)`);
  console.log("User wallet:    ", user.publicKey.toBase58(), `(${userBefore / LAMPORTS_PER_SOL} SOL)`);
  if (feePayerBefore === 0) throw new Error("Obliq fee payer has 0 SOL. Run `npm run fund` (local/devnet) or fund it.");

  // 3. Build a v0 transaction whose FEE PAYER is the Obliq account.
  const { blockhash } = await connection.getLatestBlockhash("confirmed");
  const message = new TransactionMessage({
    payerKey: feePayer, // <-- the paymaster pays the fee, not the user
    recentBlockhash: blockhash,
    instructions: [SystemProgram.transfer({ fromPubkey: user.publicKey, toPubkey: recipient, lamports })],
  }).compileToV0Message();
  const tx = new VersionedTransaction(message);

  // 4. The USER signs only their slot. The fee-payer slot stays empty for Obliq.
  tx.sign([user]);
  const b64 = Buffer.from(tx.serialize()).toString("base64");

  // 5. Obliq runs policy + gas checks, co-signs as fee payer, and submits.
  const sent = await obliqRpc<{ signature: string; signer_pubkey: string; fee_lamports: number }>(
    "signAndSendTransaction",
    { transaction: b64 },
  );
  await connection.confirmTransaction(sent.signature, "confirmed");

  // 6. Verify: the user paid ONLY the transfer amount; Obliq paid the fee.
  const userAfter = await connection.getBalance(user.publicKey);
  const feePayerAfter = await connection.getBalance(feePayer);
  console.log("\n✔ Sponsored signature:", sent.signature);
  console.log("✔ Co-signed by (fee payer):", sent.signer_pubkey);
  console.log(`✔ User delta:     ${(userAfter - userBefore) / LAMPORTS_PER_SOL} SOL  (expected -${AMOUNT_SOL}, no fee)`);
  console.log(`✔ Fee payer delta:${(feePayerAfter - feePayerBefore) / LAMPORTS_PER_SOL} SOL  (paid the ${sent.fee_lamports}-lamport fee)`);
  console.log("→ Explorer:", explorerTxUrl(sent.signature));

  const userDelta = userBefore - userAfter;
  if (userDelta !== lamports) {
    throw new Error(`Expected user to pay exactly ${lamports} lamports (the transfer), but paid ${userDelta}. Was the fee charged to the user?`);
  }
  console.log("\n✅ GASLESS CONFIRMED: the user paid 0 lamports of fee.");
}

// --------------------------------------------------------------------------
async function main() {
  const cmd = process.argv[2] ?? "transfer";
  if (cmd === "register") return cmdRegister();
  if (cmd === "fund") return cmdFund();
  if (cmd === "transfer") return cmdTransfer();
  throw new Error(`Unknown command "${cmd}". Use: register | fund | transfer`);
}

main().catch((e) => {
  console.error("\n✖", e.message ?? e);
  process.exit(1);
});
