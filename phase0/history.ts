import { ElectrumClient } from '@electrum-cash/network';
import { cashAddressToLockingBytecode, sha256, binToHex } from '@bitauth/libauth';
const addr = process.argv[2]!;
for (const host of ['chipnet.bch.ninja', 'chipnet.imaginary.cash']) {
  const c = new ElectrumClient('atprice-phase0', '1.5.0', host);
  await c.connect();
  const lb = cashAddressToLockingBytecode(addr);
  if (typeof lb === 'string') throw new Error(lb);
  const sh = binToHex(sha256.hash(lb.bytecode).slice().reverse());
  console.log(host, JSON.stringify(await c.request('blockchain.scripthash.get_history', sh)), JSON.stringify(await c.request('blockchain.scripthash.get_balance', sh)));
  await c.disconnect();
}
