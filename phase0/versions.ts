import { ElectrumClient } from '@electrum-cash/network';
import { hexToBin, decodeTransactionBCH } from '@bitauth/libauth';
const c = new ElectrumClient('atprice-phase0', '1.5.0', 'chipnet.imaginary.cash');
await c.connect();
const tip = (await c.request('blockchain.headers.get_tip')) as { height: number };
const counts: Record<string, number> = {};
let samples: string[] = [];
for (let h = tip.height; h > tip.height - 15; h--) {
  for (let pos = 0; pos < 15; pos++) {
    const r = await c.request('blockchain.transaction.id_from_pos', h, pos);
    if (r instanceof Error || typeof r !== 'string') break;
    const raw = (await c.request('blockchain.transaction.get', r)) as string;
    const tx = decodeTransactionBCH(hexToBin(raw));
    if (typeof tx === 'string') continue;
    counts[tx.version] = (counts[tx.version] ?? 0) + 1;
    if (pos > 0 && samples.length < 5) samples.push(`${h}:${pos} v${tx.version} ${r}`);
  }
}
console.log('tip', tip.height, 'versions', counts, samples);
const f = (await c.request('server.features')) as Record<string, unknown>;
console.log('server', c.software, JSON.stringify(f).slice(0, 200));
await c.disconnect();
