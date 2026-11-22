import { ExchangeLab } from '@cashlab/cauldron';
import { binToHex, hexToBin, hash256, disassembleBytecodeBch } from '@bitauth/libauth';
const lab = new ExchangeLab() as unknown as { _compiler: { generateBytecode: (a: unknown) => { success: boolean; bytecode: Uint8Array } } };
const pkh = hexToBin('11'.repeat(20));
const r = lab._compiler.generateBytecode({ data: { bytecode: { pool_owner_public_key_hash160: pkh } }, scriptId: 'cauldron_poolv0', debug: true }) as unknown as { reduce?: { bytecode: Uint8Array }; bytecode: Uint8Array };
console.log(JSON.stringify(Object.keys(r)));
