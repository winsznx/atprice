import { z } from 'zod';

const HEX = (bytes: number) =>
  z.string().regex(new RegExp(`^[0-9a-f]{${bytes * 2}}$`), `${bytes} bytes of lowercase hex`);
const DECIMAL = z.string().regex(/^[1-9]\d{0,19}$/, 'a positive integer as a decimal string');

export const txidSchema = HEX(32);
export const tokenIdSchema = HEX(32);
export const outpointSchema = z.string().regex(/^[0-9a-f]{64}:\d{1,6}$/, 'an outpoint txid:vout');

export const tokenParamsSchema = z.object({ tokenId: tokenIdSchema }).strict();
export const orderIdParamsSchema = z.object({ id: outpointSchema }).strict();
export const executionIdParamsSchema = z.object({ id: z.union([z.uuid(), txidSchema]) }).strict();

export const quoteQuerySchema = z
  .object({
    side: z.enum(['buy', 'sell']),
    amount: DECIMAL,
    maxNetworkFee: DECIMAL.optional(),
  })
  .strict();

export const intentBodySchema = z
  .object({
    side: z.enum(['buy', 'sell']),
    ownerPkh: HEX(20),
    recipientLockingBytecode: z
      .string()
      .regex(/^([0-9a-f]{2}){23,35}$/, 'a P2PKH, P2SH20 or P2SH32 locking bytecode'),
    tokenCategory: tokenIdSchema,
    minOut: DECIMAL,
    maxNetworkFee: DECIMAL,
    nonce: HEX(8),
    amount: DECIMAL,
    /** The address the browser derived itself; a mismatch blocks funding. */
    orderAddress: z.string().min(1).max(120),
  })
  .strict();

export const registerBodySchema = z.object({ txid: txidSchema }).strict();

export const ordersQuerySchema = z
  .object({
    outpoints: z
      .string()
      .max(64 * 71)
      .transform((value) => value.split(',').filter((part) => part.length > 0))
      .pipe(z.array(outpointSchema).min(1).max(50))
      .optional(),
    address: z.string().min(1).max(120).optional(),
  })
  .strict()
  .refine((query) => (query.outpoints === undefined) !== (query.address === undefined), {
    message: 'give exactly one of outpoints or address',
  });

export const cancelPrepareBodySchema = z
  .object({
    /** The wallet's receive index of the owner address (WizardConnect input path); receive/0 by default. */
    addressIndex: z.number().int().min(0).max(1_000_000).optional(),
    userPrompt: z.string().max(200).optional(),
  })
  .strict();

export const evidenceQuerySchema = z
  .object({
    limit: z
      .string()
      .regex(/^\d{1,3}$/)
      .optional(),
    cursor: z
      .string()
      .regex(/^\d{1,10}:[0-9a-f]{64}:\d{1,10}$/)
      .optional(),
  })
  .strict();
