# Example: Gasless SOL Transfer

Send SOL from an end-user wallet where **the user pays no fee** — the Obliq
paymaster co-signs as the fee payer and pays the lamport fee.

This is the simplest possible gasless transaction and the foundation the USDC and
Jupiter-swap examples build on. Read this one first.

## What it demonstrates

| Step | Code | Obliq method |
|------|------|--------------|
| Find the sponsor | `getConfig` returns the fee-payer pubkey | `getConfig` |
| Build a tx whose **fee payer is Obliq** | `TransactionMessage({ payerKey: feePayer, … })` | — |
| User signs only their slot | `tx.sign([user])` | — |
| Sponsor + submit | base64 tx → Obliq | `signAndSendTransaction` |
| Prove it was gasless | balance deltas | — |

## Prerequisites

1. **Node.js 20+.**
2. **An OBLIQ API key**, with its fee payer funded — see Setup below. You are talking to the
   hosted paymaster; there is nothing to run yourself.
3. **A wallet holding a little SOL to send.** It needs none to *spend on fees* — that is the
   point of the example — but a SOL transfer obviously needs SOL to transfer.

## What this costs you

Runs on **Solana mainnet and moves real funds**: you send `AMOUNT_SOL` (0.001 by default)
and OBLIQ pays the network fee. Sending to an address that does not exist yet needs at
least the rent-exempt minimum — about **0.00081 SOL** — or the network will not create it.

## Setup

You need an OBLIQ API key. There is no self-service signup — tenants are provisioned by a
human, and yours arrives already configured for this example. See
[Request access](https://xyra-labs.mintlify.site/guides/onboarding/request-access); we
reply with a tenant id, an API key and your fee-payer address. Fund that fee payer with a
little SOL (the dashboard's Gas screen) before running anything.

Then fill in two values in `.env`:

| | |
|---|---|
| `OBLIQ_API_KEY` | the key we issued you |
| `USER_WALLET_SECRET_KEY` | **your own** wallet's base58 secret key — a throwaway |

Easy to confuse, and they are opposites: the API key authenticates you to OBLIQ; the
wallet key signs the transfer, never leaves your machine, and we never see it.

```bash
cp .env.example .env
npm install
```

`.env` knobs (all optional on local — sensible defaults apply):

| Variable | Default | Meaning |
|----------|---------|---------|
| `SOLANA_RPC_URL` | `https://api.mainnet-beta.solana.com` | Cluster the tx lands on |
| `OBLIQ_RPC_URL` | `https://solana-paymaster-mainnet.kanalabs.io/rpc` | Paymaster data-plane endpoint |
| `OBLIQ_CONTROL_URL` | `https://solana-paymaster-mainnet.kanalabs.io` | Control plane (registration) |
| `OBLIQ_API_KEY` | _(blank)_ | Issued to you — see above |
| `USER_WALLET_SECRET_KEY` | _(blank)_ | base58 user key; required on mainnet |
| `RECIPIENT` | _(blank)_ | base58 recipient; blank = throwaway |
| `AMOUNT_SOL` | `0.001` | Amount the user sends (must be ≥ rent-exempt min) |

## Run

```bash
npm start          # the gasless transfer — moves real SOL on mainnet
```

### Expected output

```
Obliq fee payer: Fee1xq...9aV (1 SOL)
User wallet:     Usr7bd...k2P (0.011 SOL)

✔ Sponsored signature: 4kT...zQ9
✔ Co-signed by (fee payer): Fee1xq...9aV
✔ User delta:     -0.001 SOL  (expected -0.001, no fee)
✔ Fee payer delta:-0.000005 SOL  (paid the 5000-lamport fee)
→ Explorer: https://explorer.solana.com/tx/4kT...zQ9

✅ GASLESS CONFIRMED: the user paid 0 lamports of fee.
```

The assertion `userDelta === amount` is the proof: the user's balance dropped by
**exactly** the transferred amount, with **no** fee deducted.

## How the gasless mechanism works

A Solana transaction's **first account** is the fee payer and **first required
signer**. We set `payerKey` to the Obliq fee-payer pubkey, so:

- `account_keys[0]` = Obliq fee payer (signs the fee)
- `account_keys[1]` = the user (signs the transfer authority)

The user calls `tx.sign([user])`, which fills **only** their signature slot. The
fee-payer slot is left empty. Obliq receives the partially-signed transaction,
runs its policy and gas checks, fills slot 0 with its own signature, and submits.
Neither key ever sees the other's secret.

## Point it somewhere else

The defaults already target production. To run against a local paymaster instead, change
`OBLIQ_RPC_URL` and `SOLANA_RPC_URL` — the code does not change. Real keys look like
`obliq_prod_<key id>_<secret>`; see [Go live](https://xyra-labs.mintlify.site/guides/operate/go-live).

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `Missing OBLIQ_API_KEY` | Not registered | `npm run register` |
| `Obliq fee payer has 0 SOL` | Sponsor unfunded | `npm run fund` (local/devnet) |
| `[-32014] InsufficientGas` | Fee payer below floor | Fund the fee payer |
| `[-32010] PolicyDenied` | Tenant is allowlist-mode | Use denylist (default) or allowlist the user |
| `[-32020] Kora …` | Validation failed (e.g. blockhash) | See [Errors](https://xyra-labs.mintlify.site/guides/integrate/errors) |

Full matrix: [Errors](https://xyra-labs.mintlify.site/guides/integrate/errors).
