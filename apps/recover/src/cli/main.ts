/**
 * `pnpm recover`: the Recover page's logic in a terminal (architecture.md "Recovery without AtPrice
 * servers"). It talks only to a Bitcoin Cash server the user picks and to the user's wallet over
 * WizardConnect, prints the pairing code as a QR, and never asks for a private key.
 *
 *   pnpm recover --txid <funding txid> [--network mainnet|chipnet] [--server host:port | wss://host:port]
 *   pnpm recover --address <owner address> [--network ...] [--server ...]
 */
import { stdin, stdout } from 'node:process';
import { createInterface, type Interface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { CHAIN_NETWORKS, type ElectrumEndpoint } from '@atprice/chain';
import { createNodeChainClient } from '@atprice/chain/node';
import type { Network } from '@atprice/core';
import { encodeLockingBytecodeP2pkh } from '@bitauth/libauth';
import { walletNetworkLabel } from '../../../web/lib/wallet/keys';
import { isWalletError } from '../../../web/lib/wallet/errors';
import { endpointHost, explorerFor } from '../config';
import { broadcastCancel } from '../core/broadcast';
import {
  cancelBuildInvalidMessage,
  CancelCheckError,
  checkSignedCancel,
  planCancel,
  supportsPlaceholderSigning,
  type CancelPath,
  type CancelPlan,
} from '../core/cancel';
import {
  aboveMinimumText,
  bchText,
  contractAddressOf,
  feeText,
  heldLines,
  minimumLine,
  ownerAddressOf,
  sideLabel,
  STATUS_BADGE,
  tokenLabel,
} from '../core/describe';
import { describeError, errorCode } from '../core/errors';
import { parseOwnerAddress, parseTxid } from '../core/inputs';
import { findOrderByTxid, findOrdersByAddress, readOrderStatus, type LoadedOrder } from '../core/lookup';
import { recoverNetworkProvider } from '../core/provider';
import { connectServer, type RecoverChain } from '../core/server';
import { RecoverWallet, type OwnerKey, type RecoverWalletState } from '../wallet/session';
import { CliExit, parseCliServer } from './args';
import { terminalQr } from './terminal-qr';

const say = (line = ''): void => {
  stdout.write(`${line}\n`);
};

const USAGE =
  'Usage: pnpm recover (--txid <funding txid> | --address <owner address>) [--network mainnet|chipnet] [--server host:port | wss://host:port]';

const ask = async (rl: Interface, question: string): Promise<string> => (await rl.question(question)).trim();

const chooseServer = async (
  rl: Interface | null,
  network: Network,
  flag: string | undefined,
): Promise<ElectrumEndpoint> => {
  if (flag !== undefined) return parseCliServer(flag);
  const servers = CHAIN_NETWORKS[network].nodeElectrum;
  const first = servers[0];
  if (first === undefined) throw new CliExit(`No ${network} servers are bundled; pass --server.`, 2);
  if (rl === null) {
    say(`Server: ${endpointHost(first)} (pass --server to choose another)`);
    return first;
  }
  say(`Bitcoin Cash servers for ${network}:`);
  servers.forEach((server, index) => say(`  ${index + 1}. ${endpointHost(server)}`));
  const answer = await ask(rl, `Pick a server [1-${servers.length}, Enter for 1, or type host:port]: `);
  if (answer === '') return first;
  const index = Number(answer);
  if (Number.isInteger(index) && index >= 1 && index <= servers.length) return servers[index - 1] ?? first;
  return parseCliServer(answer);
};

const printOrder = (order: LoadedOrder, tip: number): void => {
  const minimum = minimumLine(order);
  say();
  say(
    `Order: ${sideLabel(order)} ${tokenLabel(order)}, contract v${order.record.version}, ${STATUS_BADGE[order.status.kind]}`,
  );
  say(`  Locked             ${heldLines(order, order.fundingOutput).join(' + ')}`);
  say(`  Receives at least  ${minimum.text}`);
  if (minimum.kind === 'sell') say(`                     ${minimum.payoutLine}`);
  say(`  Fee cap            ${feeText(order.record.maxNetworkFee)}`);
  say(`  Owner              ${ownerAddressOf(order.record.ownerPkh, order.network)}`);
  say(`  Contract           ${contractAddressOf(order)}`);
  say(
    `  Funding            ${order.funding.txid}:${order.funding.vout}${order.fundingHeight > 0 ? ` (block ${order.fundingHeight})` : ' (not confirmed yet)'}`,
  );
  const status = order.status;
  if (status.kind === 'filled') {
    say(`  Filled in          ${status.txid}`);
    say(`  Above your minimum ${aboveMinimumText(order, status.spend.delivered)}`);
    say(`  Pool owner         ${status.spend.poolOwnerPkh}`);
    say('  Filled by          Not identifiable from the chain');
  } else if (status.kind === 'cancelled') {
    say(`  Cancelled in       ${status.txid}, refunded ${heldLines(order, status.refund).join(' + ')}`);
  } else if (status.kind === 'needs_review') {
    say(
      `  Needs review: the order output was spent by ${status.txid}, which is neither a fill nor a cancel (${status.reason}).`,
    );
  }
  if (tip > 0 && order.status.kind !== 'unspent') say();
};

const findOrder = async (
  rl: Interface | null,
  chain: RecoverChain,
  network: Network,
  values: { txid?: string | undefined; address?: string | undefined },
): Promise<LoadedOrder> => {
  if (values.txid !== undefined) {
    const txid = parseTxid(values.txid);
    if (!txid.ok) throw new CliExit(txid.reason, 2);
    const found = await findOrderByTxid(chain, network, txid.value);
    if (found.kind === 'no_record') {
      throw new CliExit(
        'This transaction has no AtPrice order record. Check you copied the funding transaction, the one that sent funds to the order.',
        1,
      );
    }
    if (found.kind === 'unknown_version') {
      throw new CliExit(
        `This order uses contract version ${found.version}, which this source doesn't include. Use pnpm recover from a newer source.`,
        1,
      );
    }
    return found.order;
  }
  const owner = parseOwnerAddress(values.address ?? '', network);
  if (!owner.ok) throw new CliExit(owner.reason, 2);
  const found = await findOrdersByAddress(chain, network, owner.value.ownerPkh, (checked, total) => {
    if (stdout.isTTY) stdout.write(`\rChecked ${checked} of ${total} transactions`);
    else if (checked === total) say(`Checked ${checked} of ${total} transactions`);
  });
  if (stdout.isTTY) say();
  if (found.unknownVersions.length > 0) {
    say(
      `This address also has records of contract version ${found.unknownVersions.join(', ')}, which this source doesn't include.`,
    );
  }
  if (found.orders.length === 0) {
    throw new CliExit(
      `No AtPrice orders are owned by this address on ${network}. AtPrice orders are owned by the first receive address of the wallet that funded them. If you have the funding transaction id, search by that instead.`,
      1,
    );
  }
  const [only] = found.orders;
  if (found.orders.length === 1 && only !== undefined) return only;
  say('Orders owned by this address:');
  found.orders.forEach((order, index) =>
    say(
      `  ${index + 1}. ${sideLabel(order)} ${tokenLabel(order)}, ${STATUS_BADGE[order.status.kind]}, ${order.funding.txid}:${order.funding.vout}`,
    ),
  );
  if (rl === null)
    throw new CliExit('Several orders found; run again with --txid <funding txid> to pick one.', 2);
  const answer = Number(await ask(rl, `Pick an order [1-${found.orders.length}]: `));
  const picked = found.orders[answer - 1];
  if (picked === undefined) throw new CliExit('No order picked.', 2);
  return picked;
};

/** Waits for the next wallet state that isn't the one given. */
const nextState = (wallet: RecoverWallet, from: RecoverWalletState): Promise<RecoverWalletState> =>
  new Promise((resolve) => {
    const unsubscribe = wallet.subscribe(() => {
      const state = wallet.getState();
      if (state !== from) {
        unsubscribe();
        resolve(state);
      }
    });
  });

const pairOwner = async (
  rl: Interface | null,
  wallet: RecoverWallet,
  order: LoadedOrder,
): Promise<OwnerKey & { walletName: string }> => {
  wallet.start();
  const boot = wallet.getState();
  if (boot.kind === 'unavailable') {
    throw new CliExit(`WIZARDCONNECT_UNAVAILABLE: ${boot.problems.join('; ')}`, 1);
  }
  for (;;) {
    await wallet.connect();
    let state = wallet.getState();
    if (state.kind === 'pairing') {
      say();
      say('Pair the wallet that created this order. Scan this code with a WizardConnect wallet:');
      say(terminalQr(state.qrUri));
      say(`Or open this link on the wallet's device: ${state.uri}`);
      say('Waiting for your wallet. This stops after 5 minutes unless you ask for more time.');
    }
    while (state.kind === 'pairing') {
      const previous = state;
      state = await nextState(wallet, state);
      if (state.kind === 'pairing' && previous.warningSince === null && state.warningSince !== null) {
        if (rl === null) continue;
        say('This stops waiting in 0:30. Press Enter to keep waiting.');
        void rl.question('').then(() => wallet.keepWaiting());
      }
    }
    switch (state.kind) {
      case 'connected': {
        if (state.reconnectingSince !== null) break;
        const owner = state.owner;
        if (Buffer.compare(Buffer.from(owner.ownerPkh), Buffer.from(order.record.ownerPkh)) !== 0) {
          await wallet.disconnect();
          throw new CliExit(
            `This wallet isn't the owner. The order was created by key hash ${Buffer.from(order.record.ownerPkh).toString('hex')}. Connect the wallet that created it.`,
            1,
          );
        }
        say(`Owner wallet connected: ${state.wallet.name}, owner key hash matches.`);
        return { ...owner, walletName: state.wallet.name };
      }
      case 'wrong_network':
        await wallet.disconnect();
        throw new CliExit(
          `Your wallet is on ${walletNetworkLabel(state.walletNetwork)}. This tool is recovering ${order.network} orders. Switch your wallet, then connect again.`,
          1,
        );
      case 'missing_receive':
        await wallet.disconnect();
        throw new CliExit(
          "Your wallet didn't share the receive key path that owns AtPrice orders, so it can't sign this cancel.",
          1,
        );
      case 'pairing_timed_out':
        if (rl === null)
          throw new CliExit('Pairing stopped: no wallet scanned the code within 5 minutes.', 1);
        await ask(
          rl,
          'Pairing stopped. That code no longer works. Press Enter for a new pairing code, or Ctrl+C to quit. ',
        );
        continue;
      case 'disconnected':
        throw new CliExit(`Disconnected from your wallet: ${state.message ?? ''} (${state.reason})`, 1);
      case 'error':
        throw new CliExit(
          state.relayUnreachable
            ? `WIZARDCONNECT_UNAVAILABLE: couldn't reach the wallet connection relay (${state.message}).`
            : `WIZARDCONNECT_ERROR: couldn't connect: ${state.message}`,
          1,
        );
      default:
        throw new CliExit(`Unexpected wallet state ${state.kind}.`, 1);
    }
  }
};

/** Builds the cancel; with no owner coin, waits on the owner address for a top-up (or uses cancelWithSig). */
const buildPlan = async (
  rl: Interface | null,
  chain: RecoverChain,
  order: LoadedOrder,
  walletName: string,
): Promise<Extract<CancelPlan, { kind: 'ready' }>> => {
  const ownerLocking = encodeLockingBytecodeP2pkh(order.record.ownerPkh);
  const provider = recoverNetworkProvider(chain, order.network);
  let path: CancelPath = 'cancel';
  for (;;) {
    const plan = planCancel({
      order,
      ownerUtxos: path === 'cancel' ? await chain.getUtxos(ownerLocking) : [],
      path,
      provider,
    });
    if (plan.kind === 'ready') return plan;
    if (plan.kind === 'invalid') throw new CliExit(cancelBuildInvalidMessage(plan.rule, 'terminal'), 1);
    const ownerAddress = ownerAddressOf(order.record.ownerPkh, order.network);
    say();
    say(`The owner wallet needs a coin at ${ownerAddress} before it can cancel.`);
    say(
      `Send at least ${feeText(plan.askSatoshis)} to it from any wallet. This tool notices the payment and continues.`,
    );
    say(terminalQr(ownerAddress));
    if (rl !== null && supportsPlaceholderSigning(walletName)) {
      const answer = await ask(
        rl,
        `Or sign inside the contract with ${walletName} instead? [y/N, Enter to wait for the payment]: `,
      );
      if (answer.toLowerCase() === 'y') {
        path = 'cancelWithSig';
        continue;
      }
    }
    await new Promise<void>((resolve, reject) => {
      let initial = true;
      chain
        .subscribeAddress(ownerLocking, () => {
          if (initial) {
            initial = false;
            return;
          }
          resolve();
        })
        .catch(reject);
    });
    say('A payment to the owner address arrived. Building the cancel again.');
  }
};

const run = async (): Promise<void> => {
  const { values } = parseArgs({
    options: {
      txid: { type: 'string' },
      address: { type: 'string' },
      network: { type: 'string', default: 'mainnet' },
      server: { type: 'string' },
      help: { type: 'boolean', default: false },
    },
  });
  if (values.help) {
    say(USAGE);
    return;
  }
  if ((values.txid === undefined) === (values.address === undefined)) throw new CliExit(USAGE, 2);
  const network = values.network;
  if (network !== 'mainnet' && network !== 'chipnet')
    throw new CliExit('--network must be mainnet or chipnet.', 2);
  say(
    `AtPrice Recover (terminal), ${network}${network === 'mainnet' ? '. Use --network chipnet for test coins.' : ': test coins.'}`,
  );
  say(
    'This talks only to the Bitcoin Cash server you pick and to your wallet. It never asks for a private key.',
  );

  const rl = stdin.isTTY ? createInterface({ input: stdin, output: stdout }) : null;
  const wallet = new RecoverWallet({ network });
  let chain: RecoverChain | null = null;
  try {
    const endpoint = await chooseServer(rl, network, values.server);
    say(`Connecting to ${endpointHost(endpoint)}`);
    const server = await connectServer({
      network,
      endpoint,
      factory: (net, ep, onEvent) =>
        createNodeChainClient(net, { endpoints: [ep], onEvent, application: 'atprice-recover-cli' }),
      onEvent: () => undefined,
    });
    chain = server.chain;
    say(`Connected to ${server.host}, ${network}, block ${server.tip.height.toLocaleString('en-US')}`);

    const order = await findOrder(rl, chain, network, values);
    printOrder(order, server.tip.height);
    if (order.status.kind !== 'unspent') {
      say('Nothing to cancel.');
      return;
    }
    if (order.fundingHeight <= 0)
      say(
        'The funding is not confirmed yet. Your cancel confirms in the same block as the funding or after it.',
      );

    const owner = await pairOwner(rl, wallet, order);
    const { cancel } = await buildPlan(rl, chain, order, owner.walletName);
    say();
    say(`You get back       ${heldLines(order, cancel.refund).join(' + ')} to ${owner.address}`);
    say(
      `Network fee        ${feeText(cancel.fee)} at ${cancel.feePerByte} sat/byte (the network's minimum relay fee), ${cancel.size} bytes`,
    );
    say(
      `Authorized by      ${cancel.ownerCoin === null ? "the owner wallet's signature inside the contract" : `a coin at the owner address, ${bchText(cancel.ownerCoin.satoshis)}, returned in the same transaction`}`,
    );
    if (rl !== null) {
      const answer = await ask(rl, 'Send this cancel to your wallet for signing? [y/N]: ');
      if (answer.toLowerCase() !== 'y') {
        say('Nothing was sent.');
        return;
      }
    }

    const { status } = await readOrderStatus(
      chain,
      order.record,
      order.lockingBytecode,
      order.funding,
      order.fundingOutput,
    );
    if (status.kind !== 'unspent') {
      printOrder({ ...order, status }, server.tip.height);
      say('The order output was spent while you were deciding. Nothing to cancel.');
      return;
    }
    say('Approve the cancel in your wallet. This waits as long as your wallet takes; press Ctrl+C to stop.');
    const controller = new AbortController();
    const onInterrupt = () => controller.abort();
    process.once('SIGINT', onInterrupt);
    let signedHex: string;
    try {
      signedHex = await wallet.requestSignature(cancel.draft, controller.signal);
    } catch (error) {
      if (isWalletError(error)) throw new CliExit(`${error.code}: ${error.message}`, 1);
      throw error;
    } finally {
      process.off('SIGINT', onInterrupt);
    }
    let signed;
    try {
      signed = checkSignedCancel(cancel, order, signedHex);
    } catch (error) {
      if (error instanceof CancelCheckError)
        throw new CliExit(cancelBuildInvalidMessage(error.rule, 'terminal'), 1);
      throw error;
    }
    say(`Sending to ${server.host}: ${signed.txid}`);
    const outcome = await broadcastCancel(chain, signed);
    if (outcome.kind === 'accepted') {
      say(`Cancel sent. Not confirmed yet. ${explorerFor(network).transaction(outcome.txid)}`);
    } else if (outcome.kind === 'rejected') {
      throw new CliExit(
        `${server.host} rejected the cancel: ${outcome.detail}. Your order is unchanged.${outcome.alreadySpent ? ' The order output was already spent; look the order up again.' : ''}`,
        1,
      );
    } else {
      throw new CliExit(
        `${server.host} didn't confirm the broadcast (${outcome.detail}). Cancel ${outcome.txid} may or may not have reached the network. Run this again or check the txid on another server.`,
        1,
      );
    }
  } finally {
    await wallet.disconnect().catch((error: unknown) => console.error('Wallet disconnect failed:', error));
    await chain?.close();
    rl?.close();
  }
};

run().then(
  () => process.exit(0),
  (error: unknown) => {
    if (error instanceof CliExit) {
      console.error(error.message);
      process.exit(error.exitCode);
    }
    console.error(`${errorCode(error)}: ${describeError(error)}`);
    process.exit(1);
  },
);
