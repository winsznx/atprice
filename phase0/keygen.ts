import {
  generatePrivateKey,
  secp256k1,
  hash160,
  encodeCashAddress,
  encodePrivateKeyWif,
  binToHex,
} from '@bitauth/libauth';
import { writeFileSync, existsSync, mkdirSync } from 'node:fs';

const [role, network] = process.argv.slice(2);
if (!role || network !== 'chipnet') throw new Error('usage: keygen <role> chipnet');
const dir = new URL('../.local/', import.meta.url);
mkdirSync(dir, { recursive: true });
const file = new URL(`chipnet-${role}.json`, dir);
if (existsSync(file)) throw new Error(`refusing to overwrite ${file.pathname}`);

const priv = generatePrivateKey();
const pub = secp256k1.derivePublicKeyCompressed(priv);
if (typeof pub === 'string') throw new Error(pub);
const pkh = hash160(pub);
const address = encodeCashAddress({ prefix: 'bchtest', type: 'p2pkh', payload: pkh }).address;
const tokenAddress = encodeCashAddress({ prefix: 'bchtest', type: 'p2pkhWithTokens', payload: pkh }).address;
writeFileSync(
  file,
  JSON.stringify(
    {
      role,
      network,
      wif: encodePrivateKeyWif(priv, 'testnet'),
      pubkey: binToHex(pub),
      address,
      tokenAddress,
    },
    null,
    2,
  ),
  { mode: 0o600 },
);
console.log(JSON.stringify({ role, address, tokenAddress }));
