// Phase 0 on-chain proofs on chipnet. Throwaway keys live in ../.local and are never printed.
// Every broadcast is appended to ../.local/phase0-log.jsonl for PHASE0_FINDINGS.md and EVIDENCE.md.
import {
  binToHex,
  decodeTransactionBCH,
  encodeTransactionBCH,
  hash160,
  hexToBin,
  lockingBytecodeToCashAddress,
  secp256k1,
  decodePrivateKeyWif,
} from '@bitauth/libauth';
import { ElectrumNetworkProvider, SignatureTemplate, TransactionBuilder, type Utxo } from 'cashscript';
import {
  buildExecuteTransaction,
  buildFundingTransaction,
  buildSignedCancelTransaction,
  buildSignedCancelWithSigTransaction,
  buyFill,
  decodeOrderRecord,
  finalizeWalletSignedTransaction,
  instantiateOrder,
  ownerLockingBytecode,
  poolLockingBytecode,
  sellFill,
  sellMinOutFromNetProceeds,
  validateOrderParams,
  verifyTransaction,
  DEFAULT_MAX_NETWORK_FEE,
  type CauldronPoolUtxo,
  type FundingDraft,
  type OrderParams,
  type WalletUtxo,
} from '@atprice/core';
import { appendFileSync, readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

const NETWORK = 'chipnet' as const;
const TOKEN = process.env.PHASE0_TOKEN ?? 'dfe50223c8d5cba8dcef8dff6d92b61deb88a8ba44947367f2b746487b56039b';
const INDEXER = 'https://indexer-chipnet.riften.net/cauldron';
const LOG = new URL('../.local/phase0-log.jsonl', import.meta.url);
const provider = new ElectrumNetworkProvider(NETWORK);

interface Key {
  readonly signer: SignatureTemplate;
  readonly pkh: Uint8Array;
  readonly address: string;
  readonly tokenAddress: string;
}

const loadKey = (role: string): Key => {
  const file = JSON.parse(readFileSync(new URL(`../.local/chipnet-${role}.json`, import.meta.url), 'utf8')) as {
    wif: string;
    address: string;
    tokenAddress: string;
  };
  const decoded = decodePrivateKeyWif(file.wif);
  if (typeof decoded === 'string') throw new Error(`wif for ${role}: ${decoded}`);
  const pub = secp256k1.derivePublicKeyCompressed(decoded.privateKey);
  if (typeof pub === 'string') throw new Error(pub);
  return { signer: new SignatureTemplate(file.wif), pkh: hash160(pub), address: file.address, tokenAddress: file.tokenAddress };
};

const record = (event: Record<string, unknown>): void => {
  const line = JSON.stringify({ at: new Date().toISOString(), ...event }, (_k, v: unknown) =>
    typeof v === 'bigint' ? v.toString() : v instanceof Uint8Array ? binToHex(v) : v,
  );
  appendFileSync(LOG, `${line}\n`);
  console.log(line);
};

const walletUtxos = async (key: Key): Promise<WalletUtxo[]> => {
  const utxos = await provider.getUtxos(key.tokenAddress);
  const locking = binToHex(ownerLockingBytecode(key.pkh));
  return utxos.map((u) => ({ ...u, lockingBytecode: locking, pathName: 'receive' as const, addressIndex: 0 }));
};

const broadcast = async (label: string, hex: string, extra: Record<string, unknown> = {}): Promise<string | undefined> => {
  try {
    const txid = await provider.sendRawTransaction(hex);
    record({ label, outcome: 'broadcast_ok', txid, ...extra });
    return txid;
  } catch (error) {
    record({ label, outcome: 'broadcast_rejected', reason: error instanceof Error ? error.message : String(error), ...extra });
    return undefined;
  }
};

// Signs a funding draft the way a wallet would: same inputs, outputs, version and locktime.
const signDraft = (draft: FundingDraft, key: Key, utxos: readonly WalletUtxo[]): string => {
  const tx = decodeTransactionBCH(hexToBin(draft.unsignedHex));
  if (typeof tx === 'string') throw new Error(tx);
  const builder = new TransactionBuilder({ provider });
  for (const input of tx.inputs) {
    const txid = binToHex(input.outpointTransactionHash);
    const utxo = utxos.find((u) => u.txid === txid && u.vout === input.outpointIndex);
    if (!utxo) throw new Error(`funding input ${txid}:${input.outpointIndex} is not a wallet UTXO`);
    builder.addInput(utxo, key.signer.unlockP2PKH(), { sequence: input.sequenceNumber });
  }
  for (const output of tx.outputs) {
    builder.addOutput({
      to: output.lockingBytecode,
      amount: output.valueSatoshis,
      ...(output.token
        ? {
            token: {
              category: binToHex(output.token.category),
              amount: output.token.amount,
              ...(output.token.nft
                ? { nft: { capability: output.token.nft.capability, commitment: binToHex(output.token.nft.commitment) } }
                : {}),
            },
          }
        : {}),
    });
  }
  builder.setLocktime(tx.locktime);
  return finalizeWalletSignedTransaction(draft, builder.build()).hex;
};

interface IndexerPool {
  owner_pkh: string;
  sats: number;
  tokens: number;
  token_id: string;
  tx_pos: number;
  txid: string;
}

// Indexer rows only nominate pools; reserves come from a fresh Electrum read of each pool address.
const livePools = async (): Promise<CauldronPoolUtxo[]> => {
  const response = await fetch(`${INDEXER}/pool/active?token=${TOKEN}`);
  if (!response.ok) throw new Error(`indexer ${response.status}`);
  const rows = ((await response.json()) as { active: IndexerPool[] }).active;
  const pools: CauldronPoolUtxo[] = [];
  for (const row of rows) {
    const pkh = hexToBin(row.owner_pkh);
    const locking = poolLockingBytecode(pkh);
    const encoded = lockingBytecodeToCashAddress({ bytecode: locking, prefix: 'bchtest', tokenSupport: true });
    if (typeof encoded === 'string') throw new Error(`pool address: ${encoded}`);
    const address = encoded.address;
    for (const utxo of await provider.getUtxos(address)) {
      if (utxo.token?.category !== TOKEN || utxo.token.nft || utxo.token.amount <= 0n) continue;
      pools.push({ ...utxo, token: { amount: utxo.token.amount, category: TOKEN }, ownerPkh: pkh, lockingBytecode: binToHex(locking) });
    }
  }
  return pools;
};

const bestPool = (pools: readonly CauldronPoolUtxo[], side: 'buy' | 'sell', amount: bigint): { pool: CauldronPoolUtxo; out: bigint } => {
  let best: { pool: CauldronPoolUtxo; out: bigint } | undefined;
  for (const pool of pools) {
    const reserves = { sats: pool.satoshis, tokens: pool.token.amount };
    try {
      const out = side === 'buy' ? buyFill(reserves, amount).tokensOut : sellFill(reserves, amount).bchOut;
      if (!best || out > best.out) best = { pool, out };
    } catch {
      // A pool too small for this amount is simply not a candidate.
    }
  }
  if (!best) throw new Error('no pool can take this amount');
  return best;
};

const newParams = (side: 'buy' | 'sell', owner: Key, minOut: bigint): OrderParams => {
  const params: OrderParams = {
    side,
    ownerPkh: owner.pkh,
    recipientLockingBytecode: ownerLockingBytecode(owner.pkh),
    tokenCategory: TOKEN,
    minOut,
    maxNetworkFee: DEFAULT_MAX_NETWORK_FEE,
    nonce: new Uint8Array(randomBytes(8)),
  };
  validateOrderParams(params, { supportedTokenCategories: [TOKEN] });
  return params;
};

const fund = async (side: 'buy' | 'sell', amount: bigint, mode: string): Promise<void> => {
  const owner = loadKey('funder');
  const pools = await livePools();
  const quoteAmount = side === 'buy' ? amount : amount;
  const { pool, out } = bestPool(pools, side, quoteAmount);
  // executable: 3% below the current quote, so it fills now. unreachable: twice the quote.
  const target = mode === 'unreachable' ? out * 2n : (out * 97n) / 100n;
  // A sell fill pays its miner fee out of bchOut, so leave room for it below the quote.
  const minOut = side === 'buy' ? target : sellMinOutFromNetProceeds(mode === 'unreachable' ? target : target - 1000n).minOut;
  const params = newParams(side, owner, minOut);
  const utxos = await walletUtxos(owner);
  const draft = buildFundingTransaction({ params, amount, minimumAmount: 1n, walletUtxos: utxos, network: NETWORK, provider });
  const hex = signDraft(draft, owner, utxos);
  await broadcast(`fund-${side}-${mode}`, hex, { quotePool: `${pool.txid}:${pool.vout}`, quotedOut: out, minOut, amount, orderAddress: draft.orderAddress });
};

// Rebuilds the order from the funding transaction alone, as the keeper and the recovery tool do.
const orderFromChain = async (fundingTxid: string) => {
  const raw = await provider.getRawTransaction(fundingTxid);
  const tx = decodeTransactionBCH(hexToBin(raw));
  if (typeof tx === 'string') throw new Error(tx);
  const recordOutput = tx.outputs[1];
  const orderOutput = tx.outputs[0];
  if (!recordOutput || !orderOutput) throw new Error('funding tx shape');
  const params = decodeOrderRecord(recordOutput.lockingBytecode);
  const order = instantiateOrder(params, provider);
  const utxo: Utxo = {
    txid: fundingTxid,
    vout: 0,
    satoshis: orderOutput.valueSatoshis,
    ...(orderOutput.token ? { token: { category: binToHex(orderOutput.token.category), amount: orderOutput.token.amount } } : {}),
  };
  return { params, order, utxo };
};

const execute = async (fundingTxid: string, mutate: boolean): Promise<void> => {
  const { params, order, utxo } = await orderFromChain(fundingTxid);
  const amount = params.side === 'buy' ? utxo.satoshis - 1000n - params.maxNetworkFee : (utxo.token?.amount ?? 0n);
  const { pool } = bestPool(await livePools(), params.side, amount);
  const built = buildExecuteTransaction(order, utxo, pool);
  if (!mutate) {
    await broadcast('execute', built.hex, { fundingTxid, pool: `${pool.txid}:${pool.vout}`, size: built.size, fee: built.fee, execution: built.execution });
    return;
  }
  // Pay the recipient one unit less than the contract allows and leave it in the pool.
  const tx = decodeTransactionBCH(hexToBin(built.hex));
  if (typeof tx === 'string') throw new Error(tx);
  const [poolOut, payout] = tx.outputs;
  if (!poolOut?.token || !payout) throw new Error('execute shape');
  if (params.side === 'buy' && payout.token) {
    payout.token.amount -= 1n;
    poolOut.token.amount += 1n;
  } else {
    payout.valueSatoshis -= 1n;
    poolOut.valueSatoshis += 1n;
  }
  const hex = binToHex(encodeTransactionBCH(tx));
  let localVerdict = 'accepted';
  try {
    verifyTransaction(hex, built.sourceOutputs);
  } catch (error) {
    localVerdict = error instanceof Error ? error.message.slice(0, 200) : String(error);
  }
  await broadcast('execute-underpaying', hex, { fundingTxid, localVerdict });
};

const cancel = async (fundingTxid: string, withSig: boolean): Promise<void> => {
  const owner = loadKey('funder');
  const { order, utxo } = await orderFromChain(fundingTxid);
  if (withSig) {
    const signed = buildSignedCancelWithSigTransaction({ orders: [{ order, utxo }], ownerSigner: owner.signer });
    await broadcast('cancel-with-sig', signed.hex, { fundingTxid });
    return;
  }
  const ownerUtxo = (await provider.getUtxos(owner.tokenAddress)).filter((u) => !u.token).sort((a, b) => (b.satoshis > a.satoshis ? 1 : -1))[0];
  if (!ownerUtxo) throw new Error('owner address holds no token-free UTXO; send at least 1500 sats to it first');
  const signed = buildSignedCancelTransaction({ owner: { utxos: [ownerUtxo] }, orders: [{ order, utxo }], ownerSigner: owner.signer });
  await broadcast('cancel', signed.hex, { fundingTxid });
};

const race = async (fundingTxid: string): Promise<void> => {
  const owner = loadKey('funder');
  const { params, order, utxo } = await orderFromChain(fundingTxid);
  const amount = params.side === 'buy' ? utxo.satoshis - 1000n - params.maxNetworkFee : (utxo.token?.amount ?? 0n);
  const { pool } = bestPool(await livePools(), params.side, amount);
  const exec = buildExecuteTransaction(order, utxo, pool);
  const cancelTx = buildSignedCancelWithSigTransaction({ orders: [{ order, utxo }], ownerSigner: owner.signer });
  await Promise.all([broadcast('race-execute', exec.hex, { fundingTxid }), broadcast('race-cancel', cancelTx.hex, { fundingTxid })]);
};

const status = async (): Promise<void> => {
  for (const role of ['funder', 'owner', 'keeper', 'lp']) {
    const key = loadKey(role);
    const utxos = await provider.getUtxos(key.tokenAddress);
    const sats = utxos.reduce((sum, u) => sum + u.satoshis, 0n);
    const tokens = utxos.reduce((sum, u) => sum + (u.token?.category === TOKEN ? u.token.amount : 0n), 0n);
    console.log(role, key.address, `utxos=${utxos.length} sats=${sats} tokens=${tokens}`);
  }
  const pools = await livePools();
  console.log(`live pools for ${TOKEN.slice(0, 8)}…: ${pools.length}`, pools.slice(0, 3).map((p) => `${p.txid.slice(0, 8)}:${p.vout} ${p.satoshis}/${p.token.amount}`));
};

const [command, arg1, arg2] = process.argv.slice(2);
switch (command) {
  case 'status':
    await status();
    break;
  case 'fund-buy':
    await fund('buy', BigInt(arg1 ?? '0'), arg2 ?? 'executable');
    break;
  case 'fund-sell':
    await fund('sell', BigInt(arg1 ?? '0'), arg2 ?? 'executable');
    break;
  case 'execute':
    await execute(arg1 ?? '', false);
    break;
  case 'bad-execute':
    await execute(arg1 ?? '', true);
    break;
  case 'cancel':
    await cancel(arg1 ?? '', false);
    break;
  case 'cancel-sig':
    await cancel(arg1 ?? '', true);
    break;
  case 'race':
    await race(arg1 ?? '');
    break;
  default:
    console.log('usage: onchain.ts status | fund-buy <sats> [executable|unreachable] | fund-sell <tokens> [..] | execute <txid> | bad-execute <txid> | cancel <txid> | cancel-sig <txid> | race <txid>');
}
process.exit(0);
