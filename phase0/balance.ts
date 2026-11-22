import { ElectrumClient } from '@electrum-cash/network';
import { cashAddressToLockingBytecode, sha256, binToHex } from '@bitauth/libauth';
import { readFileSync } from 'node:fs';

const roles = process.argv.slice(2);
const client = new ElectrumClient('atprice-phase0', '1.5.0', 'chipnet.imaginary.cash');
await client.connect();
for (const role of roles) {
  const { tokenAddress } = JSON.parse(
    readFileSync(new URL(`../.local/chipnet-${role}.json`, import.meta.url), 'utf8'),
  ) as { tokenAddress: string };
  const lb = cashAddressToLockingBytecode(tokenAddress);
  if (typeof lb === 'string') throw new Error(lb);
  const sh = binToHex(sha256.hash(lb.bytecode).slice().reverse());
  const utxos = (await client.request('blockchain.scripthash.listunspent', sh, 'include_tokens')) as Array<{
    value: number;
    height: number;
    token_data?: unknown;
  }>;
  const total = utxos.reduce((a, u) => a + u.value, 0);
  console.log(
    role,
    tokenAddress,
    'utxos',
    utxos.length,
    'sats',
    total,
    utxos.some((u) => u.token_data) ? 'has tokens' : '',
  );
}
await client.disconnect();
