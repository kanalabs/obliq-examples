# Example: Gasless USDC Transfer

Move USDC (an SPL token) between wallets where **the user pays no SOL** — the Obliq
paymaster pays the transaction fee **and** the rent for the recipient's token
account. The user only signs the transfer authority.

Builds on [`../transfer-sol`](../transfer-sol); read that first.

## What's different from the SOL example

| Concern | SOL example | USDC example |
|---------|-------------|--------------|
| Instruction | `SystemProgram.transfer` | `createTransferInstruction` (SPL) |
| Programs touched | System only (allowed by base config) | **Token + Associated-Token** — must be allowed |
| Recipient onboarding | n/a | idempotent **ATA create**, rent paid by Obliq |
| Tenant config | default | widened via `POST /v1/tenants/{id}/config` |

Because the platform `base.kora.toml` only sponsors the **System** program, a USDC
transfer is rejected (`Kora` error) until the tenant's policy is widened to allow
the Token and Associated-Token programs. `npm run setup` does exactly that.

## Prerequisites

Same running Obliq paymaster (`--features production`) as the SOL example, plus
Node 18+.

## What this costs you

Runs on **Solana mainnet and moves real funds**: you send `AMOUNT_USDC` and need **no SOL
at all** — that is the point. If the recipient has never held this token, OBLIQ also pays
the rent to open their account: about **0.0019 SOL**, which it does not get back.

## Setup & run

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

Set `USDC_MINT=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` for mainnet USDC.

```bash
cp .env.example .env
npm install
npm start          # the gasless USDC transfer — moves real funds
```

<details>
<summary>Running against a local paymaster instead</summary>

`npm run register` and `npm run setup` mint and configure a tenant against a **local**
OBLIQ, and mint a test USDC. They call operator-only endpoints, so they cannot work
against production — use the access flow above for that.
</details>

### `.env`

| Variable | Local default | Notes |
|----------|---------------|-------|
| `USDC_MINT` | _(blank → test mint)_ | devnet `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`, mainnet `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` |
| `AMOUNT_USDC` | `1.0` | Human units (6 decimals internally) |
| `USER_WALLET_SECRET_KEY` | _(auto)_ | Persisted across `setup`/`transfer` so they share a wallet |
| `OBLIQ_TENANT_ID` | _(auto)_ | Captured at register; used to push config |

### Expected output

```
Obliq fee payer: Fee1xq...9aV
User: Usr7bd...k2P (1 SOL, 1000 USDC)

✔ Sponsored signature: 5mP...8wK
✔ Co-signed by (fee payer): Fee1xq...9aV
✔ User SOL delta:  0   (expected 0 — gasless)
✔ User USDC delta: -1   (expected -1.0)
→ Explorer: https://explorer.solana.com/tx/5mP...8wK

✅ GASLESS CONFIRMED: USDC moved, the user spent 0 SOL.
```

The proof here is `User SOL delta == 0`: USDC moved and a token account may have
been created, yet the user's SOL balance is unchanged.

## The tenant policy it pushes

`npm run setup` sends this partial config (the real `ConfigOverrides` wire shape —
flat, not nested):

```json
{
  "allowed_programs": [
    "11111111111111111111111111111111",
    "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
    "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
  ],
  "allowed_tokens": ["<your USDC mint>"],
  "allow_fee_payer_account_funding": true,
  "allow_spl_transfer": true
}
```

> **`allow_fee_payer_account_funding`, not `allow_system_transfer`.** Sponsoring a
> recipient ATA's rent is account *creation*; the narrow grant covers exactly that
> and the lamports can land nowhere but the account being created. The broader
> `allow_system_transfer` would additionally let the fee payer send SOL to any
> address — authority this flow never uses.

> **List program ids explicitly.** Setting `allowed_programs` to `["*"]` maps to
> "inherit the platform base" (System only), **not** "allow everything". Always
> enumerate the exact programs you intend to sponsor — it is both correct and
> least-privilege. See [Errors](https://xyra-labs.mintlify.site/guides/integrate/errors).

## Devnet / mainnet

Set `USDC_MINT` to the real mint, give the user real USDC, and (on mainnet) fund
the Obliq fee payer with real SOL. The code is unchanged. See
[Go live](https://xyra-labs.mintlify.site/guides/operate/go-live).
