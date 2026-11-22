import type { Network, OrderStatus } from '@atprice/core';
import type { Logger } from 'pino';
import type { Cohort } from './env.js';

/**
 * PRD 20.1 core events that the server can observe (architecture.md, web hardening and privacy):
 * only from API calls and chain observations. `wallet_connected` and `funding_requested` happen in the
 * browser with no server call, so the server never emits them.
 */
export const ANALYTICS_EVENTS = [
  'market_viewed',
  'order_created',
  'funding_broadcast',
  'funding_confirmed',
  'order_opened',
  'execution_eligible',
  'execution_attempted',
  'execution_broadcast',
  'execution_confirmed',
  'cancellation_requested',
  'cancellation_confirmed',
] as const;

export type AnalyticsEvent = (typeof ANALYTICS_EVENTS)[number];

export type AnalyticsFields = Readonly<Record<string, string | number | boolean | null>>;

export interface Analytics {
  emit(event: AnalyticsEvent, fields: AnalyticsFields): void;
}

/** Events are structured log lines with the deployment cohort, so reports can separate test from pilot. */
export const createAnalytics = (logger: Logger, network: Network, cohort: Cohort): Analytics => ({
  emit: (event, fields) => logger.info({ analytics: event, cohort, network, ...fields }, 'analytics event'),
});

/** The events a status edge observed on chain stands for. */
export const transitionEvents = (from: OrderStatus | null, to: OrderStatus): readonly AnalyticsEvent[] => {
  switch (to) {
    case 'FUNDING_PENDING':
      return ['funding_broadcast'];
    case 'OPEN':
      return from === null || from === 'FUNDING_PENDING' ? ['funding_confirmed', 'order_opened'] : [];
    case 'EXECUTION_PENDING':
      return ['execution_broadcast'];
    case 'FILLED':
      return ['execution_confirmed'];
    case 'CANCELLED':
      return ['cancellation_confirmed'];
    case 'CANCELLATION_PENDING':
    case 'RECONCILIATION_REQUIRED':
      return [];
  }
};
