import {
  binToHex,
  hexToBin,
  sha256,
  disassembleBytecodeBCH,
  createCompilerBCH,
  importWalletTemplate,
  walletTemplateToCompilerConfiguration,
} from '@bitauth/libauth';
import tpl from '@cashlab/cauldron/cauldron-libauth-template.json' with { type: 'json' };
const t = structuredClone(tpl) as any;
t.scripts.cauldron_poolv0.lockingType = 'standard';
const imported = importWalletTemplate(t);
if (typeof imported === 'string') throw new Error(imported);
const c = createCompilerBCH(walletTemplateToCompilerConfiguration(imported));
const pkh = hexToBin('11'.repeat(20));
const r = c.generateBytecode({
  data: { bytecode: { pool_owner_public_key_hash160: pkh } },
  scriptId: 'cauldron_poolv0',
});
if (!r.success) throw new Error(JSON.stringify(r));
const hex = binToHex(r.bytecode);
console.log(hex.length / 2, hex);
const i = hex.indexOf('11'.repeat(20));
console.log('prefix', hex.slice(0, i), 'suffix', hex.slice(i + 40));
console.log('p2sh32 check', binToHex(sha256.hash(sha256.hash(r.bytecode))));
console.log(disassembleBytecodeBCH(r.bytecode));
