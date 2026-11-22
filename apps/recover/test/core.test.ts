import {
  buildSignedCancelTransaction,
  encodeOrderRecord,
  instantiateOrder,
  orderLockingBytecode,
  type OrderParams,
} from '@atprice/core';
import { binToHex, decodeTransactionBch, encodeLockingBytecodeP2pkh, hexToBin } from '@bitauth/libauth';
import { describe, expect, it } from 'vitest';
import { checkSignedCancel, CancelCheckError, planCancel, supportsPlaceholderSigning, verifyCancel } from '../src/core/cancel';
import { aboveMinimumText, minimumLine, parameterRows, parametersJson, spokenGroups } from '../src/core/describe';
import { RecoverError } from '../src/core/errors';
import { parseOwnerAddress, parseServerUrl, parseTxid, SERVER_REASON, TXID_REASON } from '../src/core/inputs';
import { findOrderByTxid, findOrdersByAddress, type LoadedOrder } from '../src/core/lookup';
import { recoverNetworkProvider } from '../src/core/provider';
import { scanRecords } from '../src/core/record';
import { FakeChain } from './support/chain';
import { buyParams, fundingTransaction, OWNER, seedUnspentOrder, sellParams, STRANGER } from './support/orders';

const loadOrder = async (chain: FakeChain, params: OrderParams): Promise<LoadedOrder> => {
  const txid = seedUnspentOrder(chain, params);
  const found = await findOrderByTxid(chain, 'chipnet', txid);
  if (found.kind !== 'order') throw new Error(`expected an order, got ${found.kind}`);
  return found.order;
};

describe('inputs', () => {
  it('accepts a txid in either case and rejects anything else with the spec reason', () => {
    expect(parseTxid(` ${'AB'.repeat(32)} `)).toEqual({ ok: true, value: 'ab'.repeat(32) });
    expect(parseTxid('ab'.repeat(31))).toEqual({ ok: false, reason: TXID_REASON });
    expect(parseTxid('zz'.repeat(32))).toEqual({ ok: false, reason: TXID_REASON });
  });

  it('reads an owner address with or without its prefix and in token-aware form', () => {
    const plain = 'bchtest:qq6vqgj8lz07cenug5ex0tsul7q60aemgu72ymzvyz';
    const parsed = parseOwnerAddress(plain, 'chipnet');
    expect(parsed.ok && parsed.value.address).toBe(plain);
    const bare = parseOwnerAddress(plain.slice('bchtest:'.length), 'chipnet');
    expect(bare.ok && bare.value.address).toBe(plain);
    expect(parseOwnerAddress(plain, 'mainnet')).toEqual({ ok: false, reason: 'Enter a mainnet Bitcoin Cash address.' });
    expect(parseOwnerAddress('bchtest:pq0000', 'chipnet').ok).toBe(false);
  });

  it('takes only wss:// servers', () => {
    expect(parseServerUrl('wss://fulcrum.example.org:50004')).toEqual({
      ok: true,
      value: { host: 'fulcrum.example.org', port: 50004, transport: 'wss' },
    });
    expect(parseServerUrl('wss://fulcrum.example.org')).toMatchObject({ ok: true, value: { port: 443 } });
    expect(parseServerUrl('ws://fulcrum.example.org')).toEqual({ ok: false, reason: SERVER_REASON });
    expect(parseServerUrl('https://fulcrum.example.org')).toEqual({ ok: false, reason: SERVER_REASON });
    expect(parseServerUrl('wss://fulcrum.example.org/path')).toEqual({ ok: false, reason: SERVER_REASON });
  });
});

describe('scanRecords', () => {
  const decode = (hex: string) => {
    const decoded = decodeTransactionBch(hexToBin(hex));
    if (typeof decoded === 'string') throw new Error(decoded);
    return decoded;
  };

  it('decodes an ATPR record with packages/core', () => {
    const scan = scanRecords(decode(fundingTransaction(buyParams()).hex));
    expect(scan.kind).toBe('record');
    expect(scan.kind === 'record' && binToHex(scan.record.ownerPkh)).toBe(binToHex(OWNER.pkh));
  });

  it('names a contract version this file does not include', () => {
    const record = encodeOrderRecord(buyParams());
    record[7] = 2;
    const scan = scanRecords(decode(fundingTransaction(buyParams(), { recordBytecode: record }).hex));
    expect(scan).toMatchObject({ kind: 'unknown_version', version: 2 });
  });

  it('reports a malformed ATPR record and ignores other OP_RETURNs', () => {
    const record = encodeOrderRecord(buyParams());
    const truncated = record.slice(0, record.length - 3);
    expect(scanRecords(decode(fundingTransaction(buyParams(), { recordBytecode: truncated }).hex)).kind).toBe('invalid');
    const memo = Uint8Array.from([0x6a, 0x04, 0x6d, 0x65, 0x6d, 0x6f]);
    expect(scanRecords(decode(fundingTransaction(buyParams(), { recordBytecode: memo }).hex))).toEqual({ kind: 'none' });
  });
});

describe('order lookup', () => {
  it('rebuilds an unspent order from its funding transaction alone', async () => {
    const chain = new FakeChain();
    const order = await loadOrder(chain, buyParams());
    expect(order.status.kind).toBe('unspent');
    expect(order.market?.symbol).toBe('PUSDTEST');
    expect(order.funding.vout).toBe(0);
    expect(order.fundingHeight).toBe(342_300);
  });

  it('says so when the record’s contract does not hold the funds', async () => {
    const chain = new FakeChain();
    const params = buyParams();
    const funding = fundingTransaction(params, {
      orderOutput: { lockingBytecode: encodeLockingBytecodeP2pkh(STRANGER.pkh), valueSatoshis: 153_000n },
    });
    chain.addTransaction(funding.txid, funding.hex);
    await expect(findOrderByTxid(chain, 'chipnet', funding.txid)).rejects.toMatchObject({
      code: 'RECOVER_DERIVATION_MISMATCH',
    });
  });

  it('returns no_record for a transaction without one', async () => {
    const chain = new FakeChain();
    const memo = Uint8Array.from([0x6a, 0x04, 0x6d, 0x65, 0x6d, 0x6f]);
    const funding = fundingTransaction(buyParams(), { recordBytecode: memo });
    chain.addTransaction(funding.txid, funding.hex);
    expect(await findOrderByTxid(chain, 'chipnet', funding.txid)).toEqual({ kind: 'no_record' });
  });

  it('classifies a confirmed cancel of the order output with core’s rule R', async () => {
    const chain = new FakeChain();
    const params = buyParams();
    const txid = seedUnspentOrder(chain, params);
    const provider = recoverNetworkProvider(chain, 'chipnet');
    const signed = buildSignedCancelTransaction({
      owner: { utxos: [{ txid: 'cd'.repeat(32), vout: 2, satoshis: 1_000n }] },
      orders: [{ order: instantiateOrder(params, provider), utxo: { txid, vout: 0, satoshis: 153_000n } }],
      ownerSigner: OWNER.signer,
    });
    chain.addTransaction(signed.txid, signed.hex);
    const locking = orderLockingBytecode(params);
    chain.setUtxos(locking, []);
    chain.setHistory(locking, [
      { txid, height: 342_300 },
      { txid: signed.txid, height: 342_301 },
    ]);
    const found = await findOrderByTxid(chain, 'chipnet', txid);
    expect(found.kind === 'order' && found.order.status).toMatchObject({
      kind: 'cancelled',
      txid: signed.txid,
      authorization: 'cancel',
      height: 342_301,
    });
  });

  it('fails visibly when the server lists the output as spent but shows no spender', async () => {
    const chain = new FakeChain();
    const params = buyParams();
    const txid = seedUnspentOrder(chain, params);
    chain.setUtxos(orderLockingBytecode(params), []);
    await expect(findOrderByTxid(chain, 'chipnet', txid)).rejects.toBeInstanceOf(RecoverError);
  });

  it('finds every order of an owner address and reports progress', async () => {
    const chain = new FakeChain();
    const buyTxid = seedUnspentOrder(chain, buyParams());
    const sell = sellParams();
    const sellFunding = fundingTransaction(sell);
    chain.addTransaction(sellFunding.txid, sellFunding.hex);
    chain.setUtxos(orderLockingBytecode(sell), [
      { txid: sellFunding.txid, vout: 0, satoshis: 2_000n, height: 0, token: { category: sell.tokenCategory, amount: 30n } },
    ]);
    chain.setHistory(orderLockingBytecode(sell), [{ txid: sellFunding.txid, height: 0 }]);
    const strangerFunding = fundingTransaction(buyParams({ ownerPkh: STRANGER.pkh }));
    chain.addTransaction(strangerFunding.txid, strangerFunding.hex);
    chain.setHistory(encodeLockingBytecodeP2pkh(OWNER.pkh), [
      { txid: buyTxid, height: 342_300 },
      { txid: strangerFunding.txid, height: 342_301 },
      { txid: sellFunding.txid, height: 0 },
    ]);
    const progress: [number, number][] = [];
    const found = await findOrdersByAddress(chain, 'chipnet', OWNER.pkh, (checked, total) => progress.push([checked, total]));
    expect(found.orders.map((order) => order.funding.txid).sort()).toEqual([buyTxid, sellFunding.txid].sort());
    expect(progress.at(0)).toEqual([0, 3]);
    expect(progress.at(-1)).toEqual([3, 3]);
  });
});

describe('cancel plan', () => {
  it('builds cancel() from a coin at the owner address and passes rule R', async () => {
    const chain = new FakeChain();
    const order = await loadOrder(chain, buyParams());
    const plan = planCancel({
      order,
      ownerUtxos: [{ txid: 'cd'.repeat(32), vout: 2, satoshis: 1_000n, height: 342_300 }],
      path: 'cancel',
      provider: recoverNetworkProvider(chain, 'chipnet'),
    });
    expect(plan.kind).toBe('ready');
    if (plan.kind !== 'ready') return;
    expect(plan.cancel.ownerCoin?.satoshis).toBe(1_000n);
    expect(plan.cancel.refund.satoshis).toBe(153_000n - plan.cancel.fee);
    expect(plan.cancel.draft.request.transaction.broadcast).toBe(false);
    expect(plan.cancel.draft.request.inputPaths).toEqual([[0, 'receive', 0]]);
  });

  it('asks for at least 1,500 sat when the owner address holds no usable coin', async () => {
    const chain = new FakeChain();
    const order = await loadOrder(chain, buyParams());
    const plan = planCancel({
      order,
      ownerUtxos: [{ txid: 'cd'.repeat(32), vout: 1, satoshis: 800n, height: 1, token: { category: 'ef'.repeat(32), amount: 5n } }],
      path: 'cancel',
      provider: recoverNetworkProvider(chain, 'chipnet'),
    });
    expect(plan).toMatchObject({ kind: 'no_owner_utxo', reason: 'owner_address_empty', askSatoshis: 1_500n });
  });

  it('builds cancelWithSig with no owner input and the tokens mirrored for a sell', async () => {
    const chain = new FakeChain();
    const order = await loadOrder(chain, sellParams());
    const plan = planCancel({ order, ownerUtxos: [], path: 'cancelWithSig', provider: recoverNetworkProvider(chain, 'chipnet') });
    expect(plan.kind).toBe('ready');
    if (plan.kind !== 'ready') return;
    expect(plan.cancel.ownerCoin).toBeNull();
    expect(plan.cancel.refund.token?.amount).toBe(30n);
    expect(plan.cancel.draft.request.transaction.sourceOutputs[0]?.contract?.artifact.contractName).toBe('AtPriceSell');
  });

  it('accepts the owner’s signed cancel and refuses an unsigned or altered one', async () => {
    const chain = new FakeChain();
    const params = buyParams();
    const order = await loadOrder(chain, params);
    const ownerUtxo = { txid: 'cd'.repeat(32), vout: 2, satoshis: 1_000n, height: 342_300 };
    const plan = planCancel({ order, ownerUtxos: [ownerUtxo], path: 'cancel', provider: recoverNetworkProvider(chain, 'chipnet') });
    if (plan.kind !== 'ready') throw new Error(plan.kind);
    const signed = buildSignedCancelTransaction({
      owner: { utxos: [ownerUtxo] },
      orders: [{ order: instantiateOrder(params, recoverNetworkProvider(chain, 'chipnet')), utxo: { txid: order.funding.txid, vout: 0, satoshis: 153_000n } }],
      ownerSigner: OWNER.signer,
    });
    expect(checkSignedCancel(plan.cancel, order, signed.hex).txid).toBe(signed.txid);
    expect(() => checkSignedCancel(plan.cancel, order, plan.cancel.draft.unsignedHex)).toThrow(CancelCheckError);

    const tampered = decodeTransactionBch(hexToBin(plan.cancel.draft.unsignedHex));
    if (typeof tampered === 'string') throw new Error(tampered);
    const refund = tampered.outputs[1];
    if (refund === undefined) throw new Error('no refund');
    tampered.outputs[1] = { ...refund, lockingBytecode: STRANGER.lockingBytecode };
    expect(() => verifyCancel(tampered, plan.cancel.draft.sourceOutputs, order, 'cancel', plan.cancel.ownerCoin)).toThrow(
      /refund rule R/,
    );
    const underpaid = decodeTransactionBch(hexToBin(plan.cancel.draft.unsignedHex));
    if (typeof underpaid === 'string') throw new Error(underpaid);
    underpaid.outputs[1] = { ...refund, valueSatoshis: 153_000n - 2_001n };
    expect(() => verifyCancel(underpaid, plan.cancel.draft.sourceOutputs, order, 'cancel', plan.cancel.ownerCoin)).toThrow(
      /refund rule R/,
    );
  });

  it('lists placeholder-signing wallets by the name they send', () => {
    expect(supportsPlaceholderSigning('Paytaca')).toBe(true);
    expect(supportsPlaceholderSigning('Cashonize Wallet')).toBe(true);
    expect(supportsPlaceholderSigning('Electron Cash')).toBe(false);
    expect(supportsPlaceholderSigning(null)).toBe(false);
  });
});

describe('describe', () => {
  it('shows a sell minimum as net proceeds and keeps the raw minOut to the parameter view', async () => {
    const chain = new FakeChain();
    const order = await loadOrder(chain, sellParams());
    const minimum = minimumLine(order);
    expect(minimum).toMatchObject({ kind: 'sell', text: '0.00144934 BCH' });
    expect(minimum.kind === 'sell' && minimum.payoutLine).toContain('0.00146934 BCH');
    const minOutRow = parameterRows(order).find((row) => row.label.startsWith('minOut'));
    expect(minOutRow?.label).toBe('minOut (contract value; for a sell this includes the 2,000 sat reserve)');
    expect(minOutRow?.value).toContain('146,934 sat');
    expect(aboveMinimumText(order, 151_725n)).toBe('+0.00004791 BCH');
    const json = JSON.parse(parametersJson(order)) as { constructorParameters: { minOut: string; minOutNote: string } };
    expect(json.constructorParameters.minOut).toBe('146934');
    expect(json.constructorParameters.minOutNote).toContain('2,000 sat reserve');
  });

  it('states that a sell at or below the reserve has no minimum price', async () => {
    const chain = new FakeChain();
    const order = await loadOrder(chain, sellParams({ minOut: 2_000n }));
    expect(minimumLine(order)).toEqual({
      kind: 'none',
      text: 'No minimum price: the contract value 2,000 sat does not exceed the 2,000 sat reserve.',
    });
  });

  it('shows a buy minimum in token units with the allowlisted decimals', async () => {
    const chain = new FakeChain();
    const order = await loadOrder(chain, buyParams());
    expect(minimumLine(order)).toEqual({ kind: 'buy', text: '58.00 PUSDTEST' });
    expect(aboveMinimumText(order, 5_900n)).toBe('+1.00 PUSDTEST');
  });

  it('groups a key hash by four for screen readers', () => {
    expect(spokenGroups('1a2b3c4d5e')).toBe('1a2b 3c4d 5e');
  });
});
