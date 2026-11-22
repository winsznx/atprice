import { assessFunding, decodeTransactionHex, marketDomain } from '@atprice/core';
import { api } from '@/lib/api/client';
import { isApiError } from '@/lib/api/errors';
import type { Order } from '@/lib/api/schemas';
import { getChain } from '@/lib/chain/client';
import { appNetwork } from '@/lib/network';

/*
 * The public URL names the funding txid (DD 10.5), while architecture.md keys orders by `txid:vout`.
 * The page asks for the txid first; when the server answers that it doesn't know that id, the browser
 * reads the funding transaction from Electrum, finds the one output that pays the re-derived contract
 * (`assessFunding`, the shared validator) and asks again with the exact outpoint. Nothing is guessed.
 */

export const isUnknownOrderError = (error: unknown): boolean =>
  isApiError(error) && error.code === 'API_ERROR' && (error.status === 404 || error.status === 400);

export const resolveOrder = async (txid: string, signal: AbortSignal): Promise<Order> => {
  try {
    return await api.order(txid, { signal });
  } catch (error) {
    if (!isUnknownOrderError(error) || typeof window === 'undefined') throw error;
    let fundingVout: number | undefined;
    try {
      const funding = decodeTransactionHex(await getChain().getRawTransaction(txid));
      fundingVout = assessFunding(funding, marketDomain(appNetwork.network)).fundingVout;
    } catch (chainError) {
      console.warn(`Couldn't resolve the order output of ${txid} from Electrum:`, chainError);
      throw error;
    }
    if (fundingVout === undefined) throw error;
    return api.order(`${txid}:${fundingVout}`, { signal });
  }
};
