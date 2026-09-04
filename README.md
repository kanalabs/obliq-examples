# OBLIQ examples

Runnable examples of **gasless transactions on Solana**: a user with **no SOL at all** swaps
or transfers tokens, and [OBLIQ](https://xyra-labs.mintlify.site) pays the network fee.

Each directory is a self-contained program. Clone it, fill in two environment variables, and
run it against mainnet.

| Example | What it proves |
| --- | --- |
| [`swap/`](./swap) | A wallet holding only USDC swaps through Jupiter. OBLIQ pays the fee, and the rent for the output token account if the wallet has never held it. |
| [`transfer-sol/`](./transfer-sol) | A native SOL transfer where the sender pays no fee. |
| [`transfer-usdc/`](./transfer-usdc) | An SPL token transfer to someone who has never held the token — OBLIQ opens their account and pays the rent. |

## How it works

The user's wallet is **not** the fee payer. The transaction is built with OBLIQ's account in
the fee-payer slot, the user signs only their own authority, and OBLIQ co-signs and submits:

```
  build v0 tx, payerKey = OBLIQ's fee payer
        │
  user signs their slot          ← their key never leaves their machine
        │
  signAndSendTransaction(base64) ← OBLIQ co-signs the fee payer and submits
        │
  signature
```

That is the whole idea. Two JSON-RPC calls — `getConfig` to learn the fee payer, and
`signAndSendTransaction` to submit. No SDK required; these examples call the RPC directly, the
same way the [live demo](https://demo-obliq.vercel.app) does.

## Before you run anything

> [!WARNING]
> **These run on Solana mainnet and move real funds.** Amounts are small by default — around
> $0.10 — but they are real. Use a throwaway wallet.

You need an **OBLIQ API key**. There is no self-service signup: tenants are provisioned by a
human so that each one gets a real, funded fee payer and a policy sized to what it sponsors.

1. [Request access](https://xyra-labs.mintlify.site/guides/onboarding/request-access). We reply
   with a **tenant id**, an **API key**, and your **fee-payer address**.
2. Send a little SOL to that fee-payer address — it is what pays your users' fees. The
   [dashboard](https://solana-paymaster.vercel.app) has a Gas screen for this.
3. `cp .env.example .env` in whichever example you want, and fill in two values.

### The two values, and why people mix them up

| | |
| --- | --- |
| `OBLIQ_API_KEY` | Authenticates **you** to OBLIQ. Looks like `obliq_prod_<key id>_<secret>`. Issued by us. |
| `USER_WALLET_SECRET_KEY` | Signs the transaction. **Your own** wallet's base58 secret key. We never see it, and it never leaves your machine. |

They are opposites: one is a credential we gave you, the other is a key we must never have.
Neither belongs in a browser bundle or a git commit — see
[Integration architecture](https://xyra-labs.mintlify.site/guides/integrate/architecture).

There are also two separate pots of money, which is the other common confusion:

- **Your wallet** holds the token being spent — USDC for the swap, SOL for the SOL transfer.
- **Your tenant's fee payer** holds the SOL that pays gas. Only this one is topped up via the
  dashboard.

## Run one

```bash
cd swap
cp .env.example .env    # then fill in the two values above
npm install
npm run quote           # read-only: prints a live quote, sends nothing
npm start               # the real thing
```

> `.env.example` lives inside each example directory, not at the repository root.
> It starts with a dot, so most editors hide it by default — if you cannot see it in
> the file tree, `ls -a` will show it, or enable hidden files.

Then open the printed signature in an explorer and check your wallet's SOL balance. It will
not have moved.

## What OBLIQ actually pays

Measured on mainnet, read back from confirmed transactions:

| | |
| --- | --- |
| Simple transfer | ~85,000 lamports |
| Swap | ~200,000–750,000 lamports, depending on route length |
| Opening an SPL token account | ~1,855,569 lamports of rent, unrecoverable |
| Opening a Token-2022 account | ~1,994,895 lamports — larger, because extensions make the account bigger |

Rent parameters change; read them from the chain with `getMinimumBalanceForRentExemption`
rather than hardcoding a constant.

## Documentation

- [Quickstart](https://xyra-labs.mintlify.site/guides/quickstart)
- [Sponsor a token transfer](https://xyra-labs.mintlify.site/guides/integrate/sponsor-a-transfer)
- [Sponsor a swap](https://xyra-labs.mintlify.site/guides/integrate/sponsor-a-swap)
- [JSON-RPC reference](https://xyra-labs.mintlify.site/api-reference/json-rpc/overview)
- [Errors](https://xyra-labs.mintlify.site/guides/integrate/errors)
