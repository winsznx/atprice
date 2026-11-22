import { z } from 'zod';
import { appNetwork } from '@/lib/network';

/*
 * The unfunded draft pointer (funding-confirmation.md "Draft") and the signed bytes kept for
 * `Broadcast again`. Both live in this tab's sessionStorage, and every access is wrapped in try/catch:
 * without storage there is simply no pointer back. No keys, no UTXOs, no signed bytes in the draft.
 */

export const DRAFT_KEY = `atprice.draft.${appNetwork.network}`;
const signedKey = (txid: string): string => `atprice.signed.${appNetwork.network}.${txid}`;

const draftSchema = z.object({
  draftId: z.string().regex(/^[0-9a-f]{16}$/),
  slug: z.string().min(1),
  side: z.enum(['buy', 'sell']),
  amount: z.string().regex(/^\d+$/),
  limitText: z.string(),
  limitOrientation: z.enum(['tokens_per_bch', 'bch_per_token']),
  recipient: z.string().nullable(),
  ownerPkh: z.string().regex(/^[0-9a-f]{40}$/),
  contractAddress: z.string().min(1),
});
export type StoredDraft = z.infer<typeof draftSchema>;

type StorageAccess = () => Storage;
const session: StorageAccess = () => window.sessionStorage;

const read = (storage: StorageAccess, key: string): string | null => {
  try {
    return storage().getItem(key);
  } catch (error) {
    console.warn(`Browser storage read failed for ${key}:`, error);
    return null;
  }
};

const write = (storage: StorageAccess, key: string, value: string | null): void => {
  try {
    if (value === null) storage().removeItem(key);
    else storage().setItem(key, value);
  } catch (error) {
    console.warn(`Browser storage write failed for ${key}:`, error);
  }
};

export const newDraftId = (): string =>
  Array.from(crypto.getRandomValues(new Uint8Array(8)), (byte) => byte.toString(16).padStart(2, '0')).join(
    '',
  );

/** One draft per tab; a newer one replaces it. */
export const saveDraft = (draft: StoredDraft, storage: StorageAccess = session): void =>
  write(storage, DRAFT_KEY, JSON.stringify(draft));

export const loadDraft = (storage: StorageAccess = session): StoredDraft | null => {
  const raw = read(storage, DRAFT_KEY);
  if (raw === null) return null;
  try {
    const parsed = draftSchema.safeParse(JSON.parse(raw) as unknown);
    return parsed.success ? parsed.data : null;
  } catch (error) {
    console.warn('The stored draft is not valid JSON:', error);
    return null;
  }
};

let snapshotRaw: string | null | undefined;
let snapshotDraft: StoredDraft | null = null;

/** The stored draft as a stable snapshot for `useSyncExternalStore`: the same object until the raw value changes. */
export const draftSnapshot = (storage: StorageAccess = session): StoredDraft | null => {
  const raw = read(storage, DRAFT_KEY);
  if (raw !== snapshotRaw) {
    snapshotRaw = raw;
    snapshotDraft = loadDraft(storage);
  }
  return snapshotDraft;
};

/** The draft `?draft={id}` asks for, or null when this tab no longer holds it. */
export const draftById = (draftId: string, storage: StorageAccess = session): StoredDraft | null => {
  const draft = loadDraft(storage);
  return draft?.draftId === draftId ? draft : null;
};

/** Deleted once the signed transaction passes its check: from then on the txid is the record. */
export const deleteDraft = (draftId: string, storage: StorageAccess = session): void => {
  if (loadDraft(storage)?.draftId === draftId) write(storage, DRAFT_KEY, null);
};

export const keepSignedHex = (txid: string, hex: string, storage: StorageAccess = session): void =>
  write(storage, signedKey(txid), hex);

export const dropSignedHex = (txid: string, storage: StorageAccess = session): void =>
  write(storage, signedKey(txid), null);

export const signedHex = (txid: string, storage: StorageAccess = session): string | null =>
  read(storage, signedKey(txid));
