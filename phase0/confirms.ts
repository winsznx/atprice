import { ElectrumClient } from '@electrum-cash/network';
import { readFileSync } from 'node:fs';
const lines = readFileSync(new URL('../.local/phase0-log.jsonl', import.meta.url), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { label: string; txid?: string; outcome?: string });
const c = new ElectrumClient('atprice-phase0', '1.5.0', 'chipnet.imaginary.cash');
await c.connect();
for (const l of lines) {
  if (!l.txid) { console.log(`${l.label.padEnd(26)} ${l.outcome} (no txid)`); continue; }
  const v = (await c.request('blockchain.transaction.get', l.txid, true)) as { confirmations?: number; blockhash?: string } | Error;
  console.log(`${l.label.padEnd(26)} ${l.txid} conf=${v instanceof Error ? v.message : (v.confirmations ?? 0)}`);
}
await c.disconnect();
