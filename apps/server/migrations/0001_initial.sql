-- AtPrice schema, architecture.md r5 (persistence, keeper, health). Amounts are numeric(78,0) and travel
-- as decimal strings in JSON.

CREATE TYPE order_status AS ENUM (
  'FUNDING_PENDING',
  'OPEN',
  'EXECUTION_PENDING',
  'CANCELLATION_PENDING',
  'FILLED',
  'CANCELLED',
  'RECONCILIATION_REQUIRED'
);

CREATE TYPE order_side AS ENUM ('buy', 'sell');

-- The legal status edges. Kept identical to ORDER_STATUS_PAIRS in packages/core/src/order-state.ts by
-- test/integration/migrations-trigger.test.ts. A NULL from_status is order creation; 'DELETED' is the removal of a
-- FUNDING_PENDING order whose funding vanished (its events are kept).
CREATE TABLE order_status_edges (
  from_status order_status,
  to_status text NOT NULL,
  CONSTRAINT order_status_edges_pair UNIQUE NULLS NOT DISTINCT (from_status, to_status),
  CONSTRAINT order_status_edges_target CHECK (
    to_status IN ('FUNDING_PENDING', 'OPEN', 'EXECUTION_PENDING', 'CANCELLATION_PENDING', 'FILLED', 'CANCELLED',
                  'RECONCILIATION_REQUIRED', 'DELETED')
  )
);

INSERT INTO order_status_edges (from_status, to_status) VALUES
  (NULL, 'FUNDING_PENDING'),
  (NULL, 'OPEN'),
  (NULL, 'FILLED'),
  (NULL, 'CANCELLED'),
  (NULL, 'EXECUTION_PENDING'),
  (NULL, 'CANCELLATION_PENDING'),
  (NULL, 'RECONCILIATION_REQUIRED'),
  ('FUNDING_PENDING', 'OPEN'),
  ('FUNDING_PENDING', 'DELETED'),
  ('OPEN', 'EXECUTION_PENDING'),
  ('OPEN', 'CANCELLATION_PENDING'),
  ('FUNDING_PENDING', 'CANCELLATION_PENDING'),
  ('FUNDING_PENDING', 'EXECUTION_PENDING'),
  ('OPEN', 'FILLED'),
  ('OPEN', 'CANCELLED'),
  ('FUNDING_PENDING', 'FILLED'),
  ('FUNDING_PENDING', 'CANCELLED'),
  ('EXECUTION_PENDING', 'FILLED'),
  ('CANCELLATION_PENDING', 'CANCELLED'),
  ('EXECUTION_PENDING', 'CANCELLATION_PENDING'),
  ('CANCELLATION_PENDING', 'EXECUTION_PENDING'),
  ('EXECUTION_PENDING', 'OPEN'),
  ('CANCELLATION_PENDING', 'OPEN'),
  ('FUNDING_PENDING', 'RECONCILIATION_REQUIRED'),
  ('OPEN', 'RECONCILIATION_REQUIRED'),
  ('EXECUTION_PENDING', 'RECONCILIATION_REQUIRED'),
  ('CANCELLATION_PENDING', 'RECONCILIATION_REQUIRED'),
  ('FILLED', 'RECONCILIATION_REQUIRED'),
  ('CANCELLED', 'RECONCILIATION_REQUIRED'),
  ('RECONCILIATION_REQUIRED', 'OPEN'),
  ('RECONCILIATION_REQUIRED', 'EXECUTION_PENDING'),
  ('RECONCILIATION_REQUIRED', 'CANCELLATION_PENDING'),
  ('RECONCILIATION_REQUIRED', 'FILLED'),
  ('RECONCILIATION_REQUIRED', 'CANCELLED');

CREATE TABLE markets (
  network text NOT NULL,
  token_id text NOT NULL CHECK (token_id ~ '^[0-9a-f]{64}$'),
  symbol text NOT NULL,
  name text NOT NULL,
  decimals integer NOT NULL CHECK (decimals BETWEEN 0 AND 18),
  metadata_sources jsonb NOT NULL,
  minimum_buy_sats numeric(78, 0) NOT NULL,
  minimum_sell_tokens numeric(78, 0) NOT NULL,
  supported boolean NOT NULL,
  pool_count integer,
  liquidity_sats numeric(78, 0),
  liquidity_tokens numeric(78, 0),
  last_quote jsonb,
  last_pool_update_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (network, token_id)
);

-- One row per order instance, keyed by its outpoint (`txid:vout`). The funding instance is the order the
-- user created; any other UTXO that lands on a known order address is its own `stray` instance with the
-- parent's parameters, always cancellable and supported only if it passes the same per-side checks.
CREATE TABLE orders (
  id text PRIMARY KEY CHECK (id ~ '^[0-9a-f]{64}:[0-9]+$'),
  network text NOT NULL,
  instance_kind text NOT NULL CHECK (instance_kind IN ('funding', 'stray')),
  parent_order_id text,
  funding_txid text NOT NULL CHECK (funding_txid ~ '^[0-9a-f]{64}$'),
  funding_vout integer NOT NULL CHECK (funding_vout >= 0),
  side order_side NOT NULL,
  owner_pkh text NOT NULL CHECK (owner_pkh ~ '^[0-9a-f]{40}$'),
  owner_address text NOT NULL,
  recipient_locking_bytecode text NOT NULL,
  token_id text NOT NULL,
  min_out numeric(78, 0) NOT NULL,
  max_network_fee numeric(78, 0) NOT NULL,
  nonce text NOT NULL,
  contract_version text NOT NULL,
  order_address text NOT NULL,
  order_locking_bytecode text NOT NULL,
  satoshis numeric(78, 0) NOT NULL,
  token_amount numeric(78, 0) NOT NULL DEFAULT 0,
  token_nft jsonb,
  input_amount numeric(78, 0),
  supported boolean NOT NULL,
  unsupported_reason text,
  unsupported_detail text,
  status order_status NOT NULL,
  funding_height integer,
  funding_block_hash text,
  spend_txid text,
  spend_kind text CHECK (spend_kind IN ('execute', 'cancel', 'unknown')),
  spend_height integer,
  spend_block_hash text,
  vanish_sweeps integer NOT NULL DEFAULT 0,
  claimed_by text,
  claimed_until timestamptz,
  keeper_executable_since timestamptz,
  last_evaluated_at timestamptz,
  last_evaluation jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT orders_outpoint UNIQUE (funding_txid, funding_vout),
  CONSTRAINT orders_id_is_outpoint CHECK (id = funding_txid || ':' || funding_vout),
  CONSTRAINT orders_unsupported_reason CHECK (supported OR unsupported_reason IS NOT NULL),
  CONSTRAINT orders_stray_parent CHECK ((instance_kind = 'stray') = (parent_order_id IS NOT NULL))
);
CREATE INDEX orders_status ON orders (network, status);
CREATE INDEX orders_owner ON orders (network, owner_address);
CREATE INDEX orders_address ON orders (network, order_address);
CREATE INDEX orders_token_open ON orders (network, token_id) WHERE status = 'OPEN' AND supported;

-- Every observation, including no-ops. No foreign key: a vanished FUNDING_PENDING order is deleted while
-- its events stay.
CREATE TABLE transaction_events (
  id bigserial PRIMARY KEY,
  order_id text NOT NULL,
  network text NOT NULL,
  txid text,
  cause text NOT NULL,
  decision text NOT NULL CHECK (decision IN ('noop', 'transition', 'delete', 'reconcile')),
  from_status order_status,
  to_status text,
  network_state text NOT NULL CHECK (network_state IN ('mempool', 'confirmed', 'missing', 'reorged', 'conflict')),
  block_height integer,
  block_hash text,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  observed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX transaction_events_order ON transaction_events (order_id, id);
CREATE INDEX transaction_events_confirmed ON transaction_events (network, block_height) WHERE block_height IS NOT NULL;

CREATE TABLE order_intents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  network text NOT NULL,
  order_address text NOT NULL,
  order_locking_bytecode text NOT NULL,
  side order_side NOT NULL,
  token_id text NOT NULL,
  amount numeric(78, 0) NOT NULL,
  params jsonb NOT NULL,
  client_prefix text NOT NULL,
  status text NOT NULL DEFAULT 'live' CHECK (status IN ('live', 'funded', 'expired')),
  funded_order_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  CONSTRAINT order_intents_address UNIQUE (network, order_locking_bytecode)
);
CREATE INDEX order_intents_live ON order_intents (network, status, expires_at);
CREATE INDEX order_intents_prefix ON order_intents (client_prefix, created_at);

CREATE TABLE executions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id text NOT NULL REFERENCES orders (id),
  network text NOT NULL,
  txid text NOT NULL CHECK (txid ~ '^[0-9a-f]{64}$'),
  side order_side NOT NULL,
  input_amount numeric(78, 0) NOT NULL,
  output_amount numeric(78, 0) NOT NULL,
  surplus numeric(78, 0) NOT NULL,
  execution_fee numeric(78, 0) NOT NULL DEFAULT 0,
  network_fee numeric(78, 0) NOT NULL,
  payout_satoshis numeric(78, 0) NOT NULL,
  route_metadata jsonb NOT NULL,
  by_atprice_keeper boolean NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'confirmed', 'reorged', 'dropped')),
  block_height integer,
  block_hash text,
  created_at timestamptz NOT NULL DEFAULT now(),
  confirmed_at timestamptz,
  CONSTRAINT executions_txid UNIQUE (txid)
);
CREATE INDEX executions_order ON executions (order_id);
CREATE INDEX executions_confirmed ON executions (network, confirmed_at DESC) WHERE status = 'confirmed';

CREATE TABLE keeper_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id text NOT NULL REFERENCES orders (id),
  network text NOT NULL,
  pool_outpoint text,
  pool_owner_pkh text,
  chained_from uuid REFERENCES keeper_attempts (id),
  candidate jsonb NOT NULL,
  quote_age_ms integer NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('built', 'pool_changed', 'vm_rejected', 'broadcast_rejected', 'order_spent',
                                           'pool_spent', 'broadcast_ok', 'dropped')),
  failure_reason text,
  txid text,
  tx_hex text,
  broadcast_results jsonb,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  duration_ms integer,
  retry_after timestamptz,
  missing_sweeps integer NOT NULL DEFAULT 0
);
CREATE INDEX keeper_attempts_order ON keeper_attempts (order_id, started_at DESC);
CREATE INDEX keeper_attempts_in_flight ON keeper_attempts (network, outcome) WHERE outcome IN ('built', 'broadcast_ok');
CREATE INDEX keeper_attempts_recent ON keeper_attempts (network, started_at DESC);

CREATE TABLE keeper_facts (
  network text NOT NULL,
  name text NOT NULL,
  value jsonb NOT NULL,
  observed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (network, name)
);

-- Owned by the API's independent evaluator; the keeper never writes here (health, executable_unfilled).
CREATE TABLE evaluator_orders (
  network text NOT NULL,
  order_id text NOT NULL,
  executable_since timestamptz,
  last_checked_at timestamptz NOT NULL,
  last_result jsonb NOT NULL,
  quote_disagreement jsonb,
  PRIMARY KEY (network, order_id)
);

CREATE TABLE evaluator_state (
  network text NOT NULL,
  name text NOT NULL,
  value jsonb NOT NULL,
  observed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (network, name)
);

-- The trigger that enforces the transition table on every write.
CREATE FUNCTION enforce_order_status_edge() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (SELECT 1 FROM order_status_edges WHERE from_status IS NULL AND to_status = NEW.status::text) THEN
      RAISE EXCEPTION 'illegal order status edge (none) -> %', NEW.status USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  ELSIF TG_OP = 'UPDATE' THEN
    NEW.updated_at := now();
    IF NEW.status IS DISTINCT FROM OLD.status
       AND NOT EXISTS (SELECT 1 FROM order_status_edges WHERE from_status = OLD.status AND to_status = NEW.status::text) THEN
      RAISE EXCEPTION 'illegal order status edge % -> %', OLD.status, NEW.status USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  ELSE
    IF NOT EXISTS (SELECT 1 FROM order_status_edges WHERE from_status = OLD.status AND to_status = 'DELETED') THEN
      RAISE EXCEPTION 'illegal order status edge % -> DELETED', OLD.status USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;
END;
$$;

CREATE TRIGGER orders_status_edge
BEFORE INSERT OR UPDATE OR DELETE ON orders
FOR EACH ROW EXECUTE FUNCTION enforce_order_status_edge();

-- The API hands a new intent to the keeper on channel `order_intent`; the keeper's sweep also loads any
-- live intent it has not subscribed, so a missed NOTIFY loses nothing.
CREATE FUNCTION notify_order_intent() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('order_intent', NEW.id::text);
  RETURN NEW;
END;
$$;

CREATE TRIGGER order_intents_notify
AFTER INSERT ON order_intents
FOR EACH ROW EXECUTE FUNCTION notify_order_intent();
