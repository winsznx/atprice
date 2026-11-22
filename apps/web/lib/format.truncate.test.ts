import { describe, expect, it } from 'vitest';
import { truncateMiddle } from './format';

describe('truncateMiddle', () => {
  it('drops a cash address prefix but keeps the payload', () => {
    expect(truncateMiddle('bitcoincash:zpdah7k0pxmqu4sj8t0r4mjvxxwv4f0t7vvwchz4zh')).toBe('zpdah7k0…chz4zh');
    expect(truncateMiddle('bchtest:qq6vqgj8lz07cenug5ex0tsul7q60aemgu72ymzvyz')).toBe('qq6vqgj8…ymzvyz');
  });

  it('keeps the txid of an outpoint instead of cutting it at the colon', () => {
    expect(truncateMiddle('9e9da9395ae2533a88c170d9560da630d96959c6d76974c2d21792e04321141a:0')).toBe(
      '9e9da939…141a:0',
    );
  });
});
