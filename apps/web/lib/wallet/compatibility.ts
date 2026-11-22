/**
 * Boot-time check that the WizardConnect build in this bundle is the one AtPrice was written against.
 * WizardConnect is pre-1.0 and changes often (BUILD_PROMPT 4.3); the versions are pinned exactly in
 * package.json, and this check catches a bundle where the API AtPrice calls has moved anyway. A failure
 * is the named state WIZARDCONNECT_UNAVAILABLE with every problem listed, never a silent fallback.
 */

export const EXPECTED_VERSIONS = { core: '0.2.11', dapp: '0.2.8' } as const;

const MANAGER_METHODS = [
  'attachRelay',
  'updateConnection',
  'loadStoredSession',
  'clearStoredSession',
  'signTransaction',
  'sendDisconnect',
  'destroy',
  'getPubkey',
  'hasPath',
  'getSessionPaths',
  'on',
  'off',
] as const;

export interface WizardConnectModules {
  readonly core: Readonly<Record<string, unknown>>;
  readonly dapp: Readonly<Record<string, unknown>>;
}

export type CompatibilityResult =
  { readonly ok: true } | { readonly ok: false; readonly problems: readonly string[] };

const isFunction = (value: unknown): value is (...args: never[]) => unknown => typeof value === 'function';

export const checkWizardConnectCompatibility = (
  modules: WizardConnectModules,
  expectedRelays: readonly string[],
): CompatibilityResult => {
  const problems: string[] = [];
  const { core, dapp } = modules;

  if (!isFunction(core.initiateDappRelay)) problems.push('@wizardconnect/core has no initiateDappRelay()');
  if (!isFunction(core.childIndexOfPathName)) {
    problems.push('@wizardconnect/core has no childIndexOfPathName()');
  } else {
    const childIndex = core.childIndexOfPathName as (name: string) => number | undefined;
    if (childIndex('receive') !== 0 || childIndex('change') !== 1) {
      problems.push('@wizardconnect/core maps receive/change to unexpected child indexes');
    }
  }
  const relays = core.DEFAULT_RELAY_URLS;
  if (!Array.isArray(relays) || relays.join(',') !== expectedRelays.join(',')) {
    problems.push(
      `@wizardconnect/core default relays changed (got ${Array.isArray(relays) ? relays.join(', ') : 'none'})`,
    );
  }

  const Manager = dapp.DappConnectionManager;
  if (!isFunction(Manager)) {
    problems.push('@wizardconnect/dapp has no DappConnectionManager');
  } else {
    const prototype: unknown = Manager.prototype;
    for (const method of MANAGER_METHODS) {
      const member =
        typeof prototype === 'object' && prototype !== null ? Reflect.get(prototype, method) : undefined;
      if (!isFunction(member)) problems.push(`DappConnectionManager.${method}() is missing`);
    }
  }
  if (dapp.DEFAULT_SESSION_KEY !== 'wizardconnect-session') {
    problems.push('@wizardconnect/dapp session key changed');
  }

  if (typeof WebSocket === 'undefined') problems.push('this browser has no WebSocket');
  if (typeof crypto === 'undefined' || !isFunction(crypto.getRandomValues)) {
    problems.push('this browser has no crypto.getRandomValues');
  }

  return problems.length === 0 ? { ok: true } : { ok: false, problems };
};
