import { ExchangeLab } from '@cashlab/cauldron';
import { binToHex, hexToBin } from '@bitauth/libauth';
const lab = new ExchangeLab();
const pkh = hexToBin('11'.repeat(20));
const lb = lab.generatePoolV0LockingBytecode({ withdraw_pubkey_hash: pkh });
console.log(lb.length, binToHex(lb));
