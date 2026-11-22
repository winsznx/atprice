import { describe, expect, it } from 'vitest';
import {
  deleteDraft,
  draftById,
  dropSignedHex,
  keepSignedHex,
  loadDraft,
  saveDraft,
  signedHex,
  type StoredDraft,
} from './draft-store';

const memory = (): (() => Storage) => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  } as Storage;
  return () => storage;
};

const blocked = (): Storage => {
  throw new DOMException('blocked', 'SecurityError');
};

const draft: StoredDraft = {
  draftId: '0123456789abcdef',
  slug: 'bch-pusdtest',
  side: 'buy',
  amount: '50000000',
  limitText: '460.00',
  limitOrientation: 'tokens_per_bch',
  recipient: null,
  ownerPkh: '11'.repeat(20),
  contractAddress: 'bchtest:pexample',
};

describe('draft store', () => {
  it('restores a draft by its id', () => {
    const storage = memory();
    saveDraft(draft, storage);
    expect(draftById('0123456789abcdef', storage)).toEqual(draft);
  });

  it('ignores an unknown id', () => {
    const storage = memory();
    saveDraft(draft, storage);
    expect(draftById('ffffffffffffffff', storage)).toBeNull();
  });

  it('deletes only the draft it names', () => {
    const storage = memory();
    saveDraft(draft, storage);
    deleteDraft('ffffffffffffffff', storage);
    const kept = loadDraft(storage);
    deleteDraft(draft.draftId, storage);
    expect([kept?.draftId, loadDraft(storage)]).toEqual([draft.draftId, null]);
  });

  it('rejects a stored value that is not a draft', () => {
    const storage = memory();
    storage().setItem('atprice.draft.chipnet', '{"draftId":"x"}');
    expect(loadDraft(storage)).toBeNull();
  });

  it('works without storage, with no pointer back', () => {
    saveDraft(draft, blocked);
    expect(loadDraft(blocked)).toBeNull();
  });

  it('keeps signed bytes by txid until dropped', () => {
    const storage = memory();
    keepSignedHex('ab'.repeat(32), '0200', storage);
    const kept = signedHex('ab'.repeat(32), storage);
    dropSignedHex('ab'.repeat(32), storage);
    expect([kept, signedHex('ab'.repeat(32), storage)]).toEqual(['0200', null]);
  });
});
