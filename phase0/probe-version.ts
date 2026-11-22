import { ElectrumClient } from '@electrum-cash/network';
import { encodeTransactionBCH, binToHex, hexToBin } from '@bitauth/libauth';
const c = new ElectrumClient('atprice-phase0', '1.5.0', process.argv[2] ?? 'chipnet.imaginary.cash');
await c.connect();
for (const version of [1, 2, 3, 4, 10]) {
  const tx = encodeTransactionBCH({
    version,
    locktime: 0,
    inputs: [
      {
        outpointTransactionHash: hexToBin('11'.repeat(32)),
        outpointIndex: 0,
        sequenceNumber: 0xffffffff,
        unlockingBytecode: hexToBin('51'),
      },
    ],
    outputs: [{ lockingBytecode: hexToBin('76a914' + '22'.repeat(20) + '88ac'), valueSatoshis: 10000n }],
  });
  const r = await c.request('blockchain.transaction.broadcast', binToHex(tx));
  console.log('version', version, r instanceof Error ? r.message : r);
}
await c.disconnect();
