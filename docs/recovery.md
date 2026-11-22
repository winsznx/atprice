# Recovering an order without AtPrice

Every AtPrice order can be cancelled by its owner with nothing but the owner's wallet and public Bitcoin Cash data. You don't need the AtPrice website, API or keeper. This page covers three ways to do it, from easiest to most manual.

What you need in every case:

- The wallet that created the order. The owner key is the wallet's `receive/0` key.
- Either the funding transaction id or the owner address. If you have neither, the owner address is the wallet's first receiving address, and every order of that owner shows up in its history because each funding transaction pays a change or marker output back to it.

What you never need: a private key typed into any tool. Signing always happens in your wallet.

## 1. The recover file

`apps/recover` builds one self-contained HTML file per network: `atprice-recover-mainnet-<version>.html` and `atprice-recover-chipnet-<version>.html`. The file carries its own fonts, styles and script, works when opened from disk (`file://`), and makes no request to any AtPrice host. It talks only to the Electrum server you choose and to your wallet over WizardConnect's public relays.

Get the file:

- Build it yourself: `pnpm install --frozen-lockfile && pnpm build`, or just `pnpm --filter @atprice/recover build` after the workspace packages are built. The files land in `apps/recover/dist/`, and the build prints each file's SHA-256 and writes it to `apps/recover/dist/manifest.json`.
- Or save https://atprice.cash/recover. The website serves the same bytes from the same manifest, so you can compare its SHA-256 with your own build.

Use it:

1. Open the file in a browser.
2. Step 1, server: pick one of the bundled public Electrum servers or enter your own. The tool checks the server's genesis hash against the file's network and refuses on a mismatch.
3. Step 2, find: enter a funding txid or the owner address. The tool reads the transactions, finds `ATPR` OP_RETURN records, rebuilds each contract from the record and recomputes its address.
4. Step 3, order: check the order. It shows what is locked, the minimum you would receive, the fee cap, the owner and contract addresses, and whether the order is open, filled or cancelled. Filled orders show the fill txid, the pool owner and how much you got above your minimum.
5. Step 4, cancel: connect the owner wallet over WizardConnect by scanning the QR code or opening the link on the wallet's device. The tool checks that the wallet's owner key hash matches the order. It shows what you get back and the network fee, then sends the unsigned cancel to the wallet. After you approve, it checks the signed transaction and broadcasts it to your server.

If the owner address holds no token-free coin (the funding change was spent since), `cancel()` has no input 0 to use. The tool says so, shows the owner address with a copy button and a QR code, and asks you to send at least 1,500 sats to it from any wallet. It waits for that payment in the mempool and then builds the cancel. If your wallet is one known to sign CashScript placeholder inputs, the tool also offers `cancelWithSig()`, which needs no extra coin.

## 2. `pnpm recover` in a terminal

The same logic runs in Node:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm recover --txid <funding txid> [--network mainnet|chipnet] [--server host:port | wss://host:port]
pnpm recover --address <owner address> [--network mainnet|chipnet] [--server host:port | wss://host:port]
```

`host:port` is a TLS Electrum socket and `wss://host[:port]` a secure WebSocket. Without `--server`, the CLI lists the bundled servers for the network and lets you pick one or type your own. It prints the order, a WizardConnect pairing QR code in the terminal (and the pairing link), asks for confirmation before sending the cancel to your wallet, then broadcasts and prints the explorer link.

## 3. Building the cancel by hand

Everything needed is on chain. These are the steps the tools follow.

### Read the record

Find the funding transaction and its `OP_RETURN` output (output 1). Decode it per [contract.md](contract.md#op_return-record):

```
"ATPR" | version 0x01 | side (0x00 buy, 0x01 sell) | ownerPkh (20) | tokenCategory (32)
       | minOut (8 LE) | maxNetworkFee (8 LE) | nonce (8) | recipientLockingBytecode (25 | 23 | 35)
```

`decodeOrderRecord` in [`packages/core/src/record.ts`](../packages/core/src/record.ts) does this with exact-length checks.

### Rebuild the contract

Instantiate the artifact for the side (`AtPriceBuy.json` or `AtPriceSell.json` from [`packages/contracts/artifacts`](../packages/contracts/artifacts)) with cashscript 0.14.0, passing the constructor arguments in this order: `ownerPkh`, `recipientLockingBytecode`, `tokenCategory`, `minOut`, `maxNetworkFee`, `nonce`. The resulting P2SH32 address must equal the address paid by funding output 0. If it doesn't, you have the wrong artifact or a wrong argument; stop.

Check that the order outpoint (`<funding txid>:0`) is still unspent. If it has been spent, the order was already filled or cancelled.

### Option A: `cancel()`

```
inputs   [0] any token-free UTXO at P2PKH(ownerPkh), signed normally by the owner wallet
         [1] the order UTXO, unlocked with: OP_1 <redeem script>
outputs  [0] owner change, P2PKH(ownerPkh)
         [1] refund to P2PKH(ownerPkh): same token category, token amount and NFT commitment as the
             order UTXO, and value >= order value - maxNetworkFee
```

`OP_1` selects `cancel`, the contract's second function (`execute` is 0, `cancelWithSig` is 2). The redeem script is the contract bytecode with the constructor arguments, which cashscript produces. The transaction may have no more outputs than inputs. The owner's signature on input 0 commits to all outputs, which is what authorizes the refund. To cancel several orders of the same owner at once, add each order as a further input and put its refund at the same index.

### Option B: `cancelWithSig()`

```
inputs   [0] the order UTXO, unlocked with: <ownerSig> <ownerPk> OP_2 <redeem script>
outputs  [0] refund to P2PKH(ownerPkh), same tokens and NFT commitment, value >= order value - maxNetworkFee
```

`ownerPk` is the compressed public key whose hash160 is `ownerPkh`, and `ownerSig` is its signature over this transaction. The refund sits at the order's own input index, and the transaction may have at most one more output than inputs. This path needs no extra coin, so use it when the owner address is empty and your signing tool can sign a contract input.

### Fee and broadcast

AtPrice builds at the minimum relay fee of 1 sat per byte. The contract only requires the refund to be at least the order value minus `maxNetworkFee` (1,000 to 5,000 sats). Before broadcasting, check that token inputs equal token outputs for every category, so nothing is burned. Then broadcast to any Electrum server with `blockchain.transaction.broadcast`.

[`buildCancelTransaction`](../packages/core/src/tx/cancel.ts) and [`buildCancelWithSigTransaction`](../packages/core/src/tx/cancel.ts) in `packages/core` implement both options, including the token-burn check.

## Chipnet examples

- `cancel()` with an owner P2PKH input: [`1373677e…964b`](https://chipnet.imaginary.cash/tx/1373677ecc5b9f0cd4767ebfaca5fe2cf6ce1d9170681c41beac4df06f66964b)
- `cancelWithSig()` of a sell order, tokens refunded: [`8bee5c8c…06c5`](https://chipnet.imaginary.cash/tx/8bee5c8c49f19d15be31719a61436a37045332727cf3455a35c41db837da06c5)
- Cancel sent before the funding confirmed: [`b31b5260…27d6`](https://chipnet.imaginary.cash/tx/b31b5260d5d6374036209088d53e094d1ca6e291ddf3f3e2a9db4c4ca09527d6)
