/**
 * Gasless Jupiter swap (USDC -> SOL), sponsored by the Obliq paymaster.
 *
 * Jupiter's /swap endpoint hard-codes the user as the fee payer. To make Obliq the
 * fee payer we instead ask Jupiter for the raw INSTRUCTIONS (/swap-instructions),
 * then assemble our OWN v0 transaction whose fee payer is the Obliq account:
 *
 *   1. GET  /swap/v1/quote               -> a route + amounts
 *   2. POST /swap/v1/swap-instructions   -> computeBudget/setup/swap/cleanup ixs + ALTs
 *   3. build a v0 tx: payerKey = Obliq, instructions = Jupiter's, resolve the ALTs
 *   4. the USER signs their slot; Obliq co-signs the fee-payer slot and submits
 *
 * Jupiter has liquidity on MAINNET only. `quote` is read-only and safe anywhere;
 * `swap` refuses to run off mainnet unless ALLOW_NON_MAINNET=true.
 *
 * Usage:
 *   npx tsx index.ts register   # tenant + API key
 *   npx tsx index.ts setup      # widen tenant policy for swap programs, fund fee payer
 *   npx tsx index.ts quote      # print a Jupiter quote (no funds moved)
 *   npx tsx index.ts swap       # the gasless swap (mainnet)
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import {
  Connection,
  Keypair,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  AddressLookupTableAccount,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import { getAssociatedTokenAddressSync, getAccount } from "@solana/spl-token";
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
const JUPITER_BASE_URL = process.env.JUPITER_BASE_URL ?? "https://lite-api.jup.ag";
const JUPITER_API_KEY = process.env.JUPITER_API_KEY ?? "";
const INPUT_MINT = process.env.INPUT_MINT ?? "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"; // USDC
const OUTPUT_MINT = process.env.OUTPUT_MINT ?? "So11111111111111111111111111111111111111112"; // wSOL
const AMOUNT_USDC = Number(process.env.AMOUNT_USDC ?? "1.0");
const SLIPPAGE_BPS = Number(process.env.SLIPPAGE_BPS ?? "50");
const USDC_DECIMALS = 6;

// Program ids a Jupiter swap names at the TOP level (the DEXs it routes through
// are reached by CPI, not as top-level instructions, so they need not be listed).
const SWAP_PROGRAMS = {
  system: "11111111111111111111111111111111",
  computeBudget: "ComputeBudget111111111111111111111111111111",
  token: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  token2022: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
  ata: "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
  jupiter: "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
};

const connection = new Connection(SOLANA_RPC_URL, "confirmed");

// --- Obliq + Jupiter clients ------------------------------------------------
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
function jupHeaders(): Record<string, string> {
  return JUPITER_API_KEY ? { "x-api-key": JUPITER_API_KEY } : {};
}
/**
 * The venues a route may use.
 *
 * Jupiter's router reaches venues its own published program-id→label map omits,
 * and that map is what the paymaster's DEX registry syncs. Left unrestricted, a
 * swap can be refused *after* you have signed it — "Program … is not in the
 * allowed list" — which is the worst moment to discover it. Filtering by label
 * alone does not help either: one label can cover several program ids, and at
 * least one venue publishes one id while routing through another.
 *
 * So routing is limited to three major venue families whose program ids are
 * stable and sponsored. Some thin pairs will return no route; that refusal
 * arrives before you sign, which is the point.
 */
const SPONSORED_DEXES = [
  "Raydium",
  "Raydium CLMM",
  "Raydium CP",
  "Whirlpool",
  "Orca V1",
  "Orca V2",
  "Meteora",
  "Meteora DLMM",
  "Meteora DAMM v2",
];

async function jupQuote(amountBaseUnits: bigint): Promise<any> {
  const url = new URL(`${JUPITER_BASE_URL}/swap/v1/quote`);
  url.searchParams.set("inputMint", INPUT_MINT);
  url.searchParams.set("outputMint", OUTPUT_MINT);
  url.searchParams.set("amount", amountBaseUnits.toString());
  url.searchParams.set("slippageBps", String(SLIPPAGE_BPS));
  url.searchParams.set("restrictIntermediateTokens", "true");
  url.searchParams.set("dexes", SPONSORED_DEXES.join(","));
  const res = await fetch(url, { headers: jupHeaders() });
  if (!res.ok) throw new Error(`Jupiter quote ${res.status}: ${await res.text()}`);
  return res.json();
}
async function jupSwapInstructions(quoteResponse: any, userPublicKey: string): Promise<any> {
  const res = await fetch(`${JUPITER_BASE_URL}/swap/v1/swap-instructions`, {
    method: "POST",
    headers: { ...jupHeaders(), "content-type": "application/json" },
    body: JSON.stringify({ quoteResponse, userPublicKey, wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true }),
  });
  if (!res.ok) throw new Error(`Jupiter swap-instructions ${res.status}: ${await res.text()}`);
  return res.json();
}

// --- helpers ----------------------------------------------------------------
function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name}. Run the earlier step or set it in .env.`);
  return v;
}
function isLocalOrDevnet(): boolean {
  return /127\.0\.0\.1|localhost|devnet/.test(SOLANA_RPC_URL);
}
function isMainnet(): boolean {
  return /mainnet/.test(SOLANA_RPC_URL);
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
function loadUser(): Keypair {
  const raw = requireEnv("USER_WALLET_SECRET_KEY").trim();
  return Keypair.fromSecretKey(raw.startsWith("[") ? Uint8Array.from(JSON.parse(raw)) : bs58.decode(raw));
}
// Convert a Jupiter instruction (programId/accounts/data) into a web3.js one.
function toInstruction(ix: any): TransactionInstruction {
  return new TransactionInstruction({
    programId: new PublicKey(ix.programId),
    keys: ix.accounts.map((a: any) => ({ pubkey: new PublicKey(a.pubkey), isSigner: a.isSigner, isWritable: a.isWritable })),
    data: Buffer.from(ix.data, "base64"),
  });
}
// Jupiter's `dynamicComputeUnitLimit` sizes the CU limit to its simulation of
// *its own* transaction, with almost no slack (measured on mainnet USDC->SOL:
// ~29k CU for a single hop, ~137k for two). Ours is not that transaction, and
// two things eat the difference:
//
//   - execution drift — the route can cross an extra tick/bin between the quote
//     and the slot that lands, and
//   - the guard instruction a *wallet* appends at signing. This example signs
//     with a local Keypair so nothing is injected here, but real integrations
//     ported from this file sign with Phantom et al., which append a Lighthouse
//     guard that executes last, on whatever compute the swap leaves behind.
//
// Either way the failure is `Program failed to complete` on the trailing
// instruction, and it looks maddeningly like a minimum-trade-size rule because
// slack varies with trade size. Buy headroom with a flat margin, not a
// multiplier: the SPONSOR pays priority fee on the limit (limit x CU price), so
// an oversized limit bills straight to the fee payer.
const GUARD_CU_HEADROOM = 60_000;
const MAX_CU_LIMIT = 1_400_000;
const SET_CU_LIMIT_DISCRIMINATOR = 0x02;

function encodeCuLimit(units: number): string {
  const data = Buffer.alloc(5);
  data[0] = SET_CU_LIMIT_DISCRIMINATOR;
  data.writeUInt32LE(Math.min(units, MAX_CU_LIMIT), 1);
  return data.toString("base64");
}
function isCuLimitIx(ix: any): boolean {
  const data = Buffer.from(ix.data, "base64");
  return data.length === 5 && data[0] === SET_CU_LIMIT_DISCRIMINATOR;
}
// Re-encode Jupiter's SetComputeUnitLimit with headroom. If Jupiter sent no
// limit we leave the set alone on purpose: the runtime's default budget (200k
// per instruction) already exceeds anything we'd synthesise, so injecting one
// could only shrink it.
function withCuHeadroom(computeBudgetIxs: any[]): any[] {
  const limitIx = computeBudgetIxs.find(isCuLimitIx);
  if (!limitIx) return computeBudgetIxs;
  const units = Buffer.from(limitIx.data, "base64").readUInt32LE(1) + GUARD_CU_HEADROOM;
  return computeBudgetIxs.map((ix) => (ix === limitIx ? { ...ix, data: encodeCuLimit(units) } : ix));
}

async function loadLookupTables(addresses: string[]): Promise<AddressLookupTableAccount[]> {
  const tables = await Promise.all(addresses.map((a) => connection.getAddressLookupTable(new PublicKey(a))));
  return tables.map((t) => t.value).filter((v): v is AddressLookupTableAccount => v !== null);
}

// --- subcommands ------------------------------------------------------------
async function cmdRegister() {
  const res = await fetch(`${OBLIQ_CONTROL_URL}/v1/tenants`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "gasless-jup-swap", fee_payers: 1 }),
  });
  const body = (await res.json()) as any;
  if (!res.ok) throw new Error(`register failed: ${JSON.stringify(body)}`);
  writeEnv("OBLIQ_API_KEY", body.api_key);
  writeEnv("OBLIQ_TENANT_ID", body.tenant_id);
  console.log("✔ Tenant:", body.tenant_id, "\n✔ API key saved to .env\n✔ Fee payer:", body.fee_payers[0]);
  console.log("\nNext: `npm run setup`");
}

async function cmdSetup() {
  const tenantId = requireEnv("OBLIQ_TENANT_ID");
  const { fee_payer } = await obliqRpc<{ fee_payer: string }>("getConfig");
  const balance = await connection.getBalance(new PublicKey(fee_payer));
  console.log("Obliq fee payer:", fee_payer, `(${balance / LAMPORTS_PER_SOL} SOL)`);
  if (isLocalOrDevnet() && balance === 0) {
    const sig = await connection.requestAirdrop(new PublicKey(fee_payer), 2 * LAMPORTS_PER_SOL);
    await connection.confirmTransaction(sig, "confirmed");
  } else if (balance === 0) {
    console.warn("⚠ Fee payer has 0 SOL on a non-airdrop cluster — fund it before swapping.");
  }
  // Allow the programs a Jupiter swap names at top level.
  const overrides = {
    allowed_programs: Object.values(SWAP_PROGRAMS),
    allowed_tokens: [INPUT_MINT, OUTPUT_MINT],
    // Least privilege: the fee payer needs to fund account creation (the
    // temporary wSOL account a swap unwraps through, if you sponsor its rent) —
    // it does NOT need to send lamports to arbitrary destinations, which is what
    // the broader `allow_system_transfer` grants. This example's user funds its
    // own rent, so even this is more than it strictly needs; it is set so the
    // config still works when ported to a browser wallet holding zero SOL.
    allow_fee_payer_account_funding: true,
    allow_spl_transfer: true,
    max_signatures: 12,
  };
  const res = await fetch(`${OBLIQ_CONTROL_URL}/v1/tenants/${tenantId}/config`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${requireEnv("OBLIQ_API_KEY")}` },
    body: JSON.stringify(overrides),
  });
  if (!res.ok) throw new Error(`config update failed: ${JSON.stringify(await res.json())}`);
  console.log("✔ Tenant policy widened for Jupiter + token/compute/ATA programs");
  console.log("\nNext: `npm run quote` (safe) then `npm start` (mainnet swap)");
}

async function cmdQuote() {
  const amount = BigInt(Math.round(AMOUNT_USDC * 10 ** USDC_DECIMALS));
  const q = await jupQuote(amount);
  const outSol = Number(q.outAmount) / LAMPORTS_PER_SOL;
  console.log(`Quote: ${AMOUNT_USDC} USDC -> ~${outSol} SOL`);
  console.log(`  price impact: ${q.priceImpactPct}%   slippage: ${SLIPPAGE_BPS} bps`);
  console.log(`  route: ${q.routePlan?.map((r: any) => r.swapInfo?.label).join(" -> ")}`);
  console.log("  (read-only — no transaction was sent)");
}

async function cmdSwap() {
  if (!isMainnet() && process.env.ALLOW_NON_MAINNET !== "true") {
    throw new Error("Jupiter routes are mainnet-only. Set SOLANA_RPC_URL to mainnet (or ALLOW_NON_MAINNET=true to override).");
  }
  const user = loadUser();
  const { fee_payer } = await obliqRpc<{ fee_payer: string }>("getConfig");
  const feePayer = new PublicKey(fee_payer);
  const amount = BigInt(Math.round(AMOUNT_USDC * 10 ** USDC_DECIMALS));

  const usdcAta = getAssociatedTokenAddressSync(new PublicKey(INPUT_MINT), user.publicKey);
  const usdcBefore = (await getAccount(connection, usdcAta)).amount;
  const solBefore = await connection.getBalance(user.publicKey);
  console.log("User:", user.publicKey.toBase58(), `(${solBefore / LAMPORTS_PER_SOL} SOL, ${Number(usdcBefore) / 10 ** USDC_DECIMALS} USDC)`);

  // 1) quote  2) instructions
  const quote = await jupQuote(amount);
  console.log(`Routing ${AMOUNT_USDC} USDC -> ~${Number(quote.outAmount) / LAMPORTS_PER_SOL} SOL`);
  const ixs = await jupSwapInstructions(quote, user.publicKey.toBase58());

  // 3) assemble OUR tx with Obliq as the fee payer
  const instructions: TransactionInstruction[] = [
    ...withCuHeadroom(ixs.computeBudgetInstructions ?? []).map(toInstruction),
    ...(ixs.setupInstructions ?? []).map(toInstruction),
    toInstruction(ixs.swapInstruction),
    ...(ixs.cleanupInstruction ? [toInstruction(ixs.cleanupInstruction)] : []),
  ];
  const lookupTables = await loadLookupTables(ixs.addressLookupTableAddresses ?? []);
  const { blockhash } = await connection.getLatestBlockhash("confirmed");
  const message = new TransactionMessage({ payerKey: feePayer, recentBlockhash: blockhash, instructions }).compileToV0Message(lookupTables);
  const tx = new VersionedTransaction(message);

  // 4) user authorizes; Obliq co-signs the fee payer + submits
  tx.sign([user]);
  const sent = await obliqRpc<{ signature: string; signer_pubkey: string; fee_lamports: number }>(
    "signAndSendTransaction",
    { transaction: Buffer.from(tx.serialize()).toString("base64") },
  );
  await connection.confirmTransaction(sent.signature, "confirmed");

  const usdcAfter = (await getAccount(connection, usdcAta)).amount;
  const solAfter = await connection.getBalance(user.publicKey);
  console.log("\n✔ Sponsored signature:", sent.signature);
  console.log("✔ Network fee paid by Obliq:", sent.fee_lamports, "lamports (fee payer", sent.signer_pubkey + ")");
  console.log(`✔ User USDC delta: ${(Number(usdcAfter) - Number(usdcBefore)) / 10 ** USDC_DECIMALS}`);
  console.log(`✔ User SOL delta:  ${(solAfter - solBefore) / LAMPORTS_PER_SOL}  (received SOL; paid 0 network fee)`);
  console.log("→ Explorer:", `https://explorer.solana.com/tx/${sent.signature}`);
  console.log("\n✅ Swap settled. The network fee was charged to the Obliq fee payer, not the user.");
}

async function main() {
  const cmd = process.argv[2] ?? "swap";
  if (cmd === "register") return cmdRegister();
  if (cmd === "setup") return cmdSetup();
  if (cmd === "quote") return cmdQuote();
  if (cmd === "swap") return cmdSwap();
  throw new Error(`Unknown command "${cmd}". Use: register | setup | quote | swap`);
}
main().catch((e) => {
  console.error("\n✖", e.message ?? e);
  process.exit(1);
});
