# AtPrice order covenants (contract v1)

Two CashScript contracts hold orders, one per side:

- [`AtPriceBuy.cash`](../packages/contracts/src/AtPriceBuy.cash): holds BCH, fills into a fungible CashToken.
- [`AtPriceSell.cash`](../packages/contracts/src/AtPriceSell.cash): holds a fungible CashToken, fills into BCH.

They compile with cashc 0.14.0 to the artifacts in [`packages/contracts/artifacts`](../packages/contracts/artifacts). The artifact fingerprints recorded in [`packages/contracts/src/artifacts.ts`](../packages/contracts/src/artifacts.ts) are:

| Contract      | Fingerprint                                                        |
| ------------- | ------------------------------------------------------------------ |
| `AtPriceBuy`  | `f7aabc1473d7a2bdf84e36f28fe54408d56190c73685c2df539a4b0f3cc5bf92` |
| `AtPriceSell` | `10774d1aa273bfa2ed0639e8ac8da2ce86b9c9057129bb4ef792adc6f30f3636` |

Each order is a P2SH32 output locked to one instance of a contract. Each contract has three functions: `execute`, `cancel` and `cancelWithSig`.

## Constructor parameters

Both contracts take the same six parameters, in this order. `packages/core` validates every domain rule before the browser builds a funding transaction.

| Name                       | Type      | Meaning                                                                                                                                                                                             |
| -------------------------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ownerPkh`                 | `bytes20` | hash160 of the owner's compressed public key (the wallet's `receive/0` key). Cancel refunds go to `P2PKH(ownerPkh)`.                                                                                |
| `recipientLockingBytecode` | `bytes`   | Where fills pay. P2PKH, P2SH20 or P2SH32 only. Defaults to `P2PKH(ownerPkh)`.                                                                                                                       |
| `tokenCategory`            | `bytes32` | Token category in introspection byte order, the reverse of the category ID explorers show. Must be on the network's allowlist in [`packages/core/src/markets.ts`](../packages/core/src/markets.ts). |
| `minOut`                   | `int`     | At least 1. Buy: token base units. Sell: gross satoshis paid to the recipient.                                                                                                                      |
| `maxNetworkFee`            | `int`     | Most satoshis of the order that a fill or cancel may spend on miner fee. Floor 1,000, ceiling 5,000, default 2,000 ([`packages/core/src/constants.ts`](../packages/core/src/constants.ts)).         |
| `nonce`                    | `bytes8`  | 8 random bytes from the browser, so two otherwise identical orders get different addresses. `execute` requires it to be non-zero.                                                                   |

Funded amounts:

- Buy: `spend + 1000 + maxNetworkFee` sats, where `spend` is at least the market minimum (50,000 sats on every market) and the 1,000 sats ride along on the payout output.
- Sell: 2,000 sats plus the tokens. The sell `minOut` is the user's minimum net proceeds `P` plus those 2,000 sats. Since the miner fee comes out of the pool's payment plus the 2,000 sats, the user always nets at least `P`. The UI shows `P`, never the raw `minOut`.

## `execute(bytes20 poolPkh)`

Anyone can call it. It needs no signature, which is why the keeper holds no key.

Shape, enforced exactly: inputs `[0] pool, [1] order`, outputs `[0] pool continued, [1] payout`. There is no room for a keeper input, a keeper output or a fee output.

Checks common to both sides:

1. The order is input 1, and the transaction has exactly two inputs and two outputs.
2. Input 0 is a genuine Cauldron V0 pool: its locking bytecode equals `P2SH32(hash256(PREFIX ‖ poolPkh ‖ SUFFIX))`, using the 68-byte pool redeem script from `@cashlab/cauldron` 1.0.3.
3. Input 0's unlocking bytecode is exactly `0x44 ‖ poolScript`. Pushing only the redeem script leaves `OP_DEPTH` at 0, which selects the pool's exchange branch, so the pool's own constant-product rule runs. A pool spent through its owner's withdraw branch is rejected.
4. Output 0 keeps the pool's locking bytecode, and the pool input and output both carry `tokenCategory`.

Let `B0, T0` be the pool input's sats and tokens and `B1, T1` the pool output's.

`AtPriceBuy.execute` also requires:

- The order input holds no tokens.
- `received = T0 - T1` goes entirely to output 1: it pays `recipientLockingBytecode`, carries `tokenCategory`, has token amount exactly `received`, and holds exactly 1,000 sats.
- `received >= minOut`.
- `orderValue - (B1 - B0) - 1000 <= maxNetworkFee`, so the whole order except the fee allowance goes into the pool.
- Best fill: with `poolFee = (B1 - B0) * 3 / 1000`, `(B1 - poolFee) * (T1 - 1) < B0 * T0`. Taking one more token for the same BCH would break the pool's rule, so no token that belongs to the user stays in the pool.

`AtPriceSell.execute` also requires:

- The order input carries `tokenCategory`, and `T1 - T0` equals the order's whole token amount.
- Output 1 pays `recipientLockingBytecode`, carries no token, and holds at least `minOut` sats.
- `(B0 - B1) + orderValue - payout <= maxNetworkFee`.
- Best fill: with `w = (B0 - B1) + 1`, `(B1 - 1 - w * 3 / 1000) * T1 < B0 * T0`. Taking one more satoshi out of the pool would break its rule.

What this does not guarantee: the filler chooses the pool, and the contract only knows `minOut`. Someone can fill through a pool they own priced at exactly the limit, or move a public pool before filling, and keep the difference. The best-fill check only guarantees that the pool actually used keeps nothing it could have released to the user. AtPrice's keeper picks the single public pool with the best output and never fills through a pool it owns. That is keeper policy, not a contract property.

## `cancel()`

Authorized by an ordinary P2PKH input from the owner.

- The order is not input 0.
- Input 0 is locked to `P2PKH(ownerPkh)`. Spending it needs the owner's normal wallet signature, and that `SIGHASH_ALL|UTXOS` signature commits to every output.
- There are no more outputs than inputs.
- Refund rule R, at the order's own index `i`: output `i` pays `P2PKH(ownerPkh)`, mirrors the input's token category, token amount and NFT commitment, and holds at least `inputValue - maxNetworkFee` sats.

Mirroring the input means a UTXO sent to an order address by mistake, with no token or the wrong token, can still be refunded. Because each refund sits at its order's index, one transaction can cancel several orders of the same owner. Output 0 is the owner's change.

## `cancelWithSig(pubkey ownerPk, sig ownerSig)`

For wallets that sign CashScript placeholder inputs, and for the CLI.

- There are at most one more output than inputs.
- `hash160(ownerPk) == ownerPkh` and `checkSig(ownerSig, ownerPk)` passes.
- Refund rule R, as above.

Neither cancel has a time lock. V1 orders are good till cancelled.

## Funding transaction

```
outputs  [0] order: P2SH32(contract), value V, plus tokens for a sell
         [1] OP_RETURN record
         [2] P2PKH(ownerPkh): change, or a 1,000-sat marker if change would be smaller
         [3] optional: P2PKH(ownerPkh) token change, when a sell is funded from a larger token UTXO
```

Output 2 always exists. That means `blockchain.scripthash.get_history` for the owner address on any Electrum server finds every order of that owner, and output 2 is a ready UTXO for the `cancel()` authorization input. The builders in `packages/core` are token-aware: they pay sats only from token-free UTXOs, return token change in its own output, and refuse to sign anything that would burn a token (`TokenBurnRefused`).

### OP_RETURN record

```
OP_RETURN "ATPR"
          <version: 1 byte = 0x01>
          <side: 1 byte, 0x00 buy | 0x01 sell>
          <ownerPkh: 20>
          <tokenCategory: 32, introspection byte order>
          <minOut: 8, little-endian>
          <maxNetworkFee: 8, little-endian>
          <nonce: 8>
          <recipientLockingBytecode: 25 | 23 | 35>
```

The record is 117 bytes with a P2PKH recipient and 127 bytes with a P2SH32 recipient ([`packages/core/src/record.ts`](../packages/core/src/record.ts)), under the 223-byte limit. Parsers accept minimal-push encodings for the one-byte fields, require exact lengths and reject trailing bytes. The record carries no network field: tools read the network from the Electrum server's genesis hash and refuse on a mismatch.

The record holds every constructor parameter, so anyone can rebuild the contract, recompute its address and spend it from on-chain data alone. The first chipnet fill ([`5a405b53…0d99`](https://chipnet.imaginary.cash/tx/5a405b5329d43648bfcbd80e7650b5105726e3109df4b139a95a1bc3541b0d99)) was built by a keeper that rebuilt the order from the OP_RETURN alone.

## Measured sizes and the fee floor

Fill sizes measured from the compiled artifacts in the `BCH_2026_05` VM by [`packages/contracts/test/fee-floor.test.ts`](../packages/contracts/test/fee-floor.test.ts), with worst-case encodings (9-byte token amounts on pool input, pool output and payout, an 8-byte buy `minOut` and a 7-byte sell `minOut`):

| Side | Recipient | Size  |
| ---- | --------- | ----- |
| buy  | P2PKH     | 783 B |
| buy  | P2SH32    | 803 B |
| sell | P2PKH     | 733 B |
| sell | P2SH32    | 753 B |

The fee floor comes from the largest: `ceil(803 B × 1 sat/B × 1.2)` = 964, rounded up to 1,000 sats. Real chipnet fills came in under the bounds: 762 B for a buy and 723 B for a sell.

## Invariants

| Invariant                  | Enforced by                                                                                                                                                                                                                                        |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No unauthorized withdrawal | exact 2-in-2-out fill, pinned payout bytecode, pool forced through its exchange branch; cancel refunds only to `P2PKH(ownerPkh)` with mirrored tokens                                                                                              |
| Minimum price              | `received >= minOut` (buy), payout `>= minOut` (sell)                                                                                                                                                                                              |
| Correct asset              | pool input, pool output and payout categories equal `tokenCategory`; buy input token-free; sell input category checked                                                                                                                             |
| Authorized cancellation    | owner P2PKH input, or hash160 plus `checkSig`                                                                                                                                                                                                      |
| Single consumption         | UTXO model: one spend of the order can confirm. Chipnet race, fill and cancel broadcast together, only the cancel confirmed: [`dda74661…c387`](https://chipnet.imaginary.cash/tx/dda74661833fda15dd8c0b685f5f9d2c1d92edafc570a8641927d24e8192c387) |
| Fee restriction            | `maxNetworkFee` bound on fills, no third output, cancel refund `>= V - maxNetworkFee`                                                                                                                                                              |
| Independent recovery       | cancel needs only the owner wallet and on-chain data; see [recovery.md](recovery.md)                                                                                                                                                               |

## Tests

`packages/contracts` has 15 test files and 420 tests. The adversarial suite in [`packages/contracts/test/adversarial`](../packages/contracts/test/adversarial) rejects, among others: wrong recipient, wrong payout category, payout one below `minOut`, fee one above the cap, best fill violated by one unit, partial BCH into the pool, the pool's withdraw branch, a fake pool, a real pool of another token, a redirected pool output, a third input or output, the order at index 0, a buy input carrying tokens, a cancel with the wrong key or a signature over another transaction, and a cancel that drops tokens or an NFT commitment.
