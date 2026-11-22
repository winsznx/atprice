import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import * as core from '@wizardconnect/core';
import * as dapp from '@wizardconnect/dapp';
import { describe, expect, it } from 'vitest';
import { networkConfigFor } from '../network';
import { checkWizardConnectCompatibility, EXPECTED_VERSIONS } from './compatibility';

const relays = networkConfigFor('chipnet').wizardConnectRelays;

const installedVersion = (name: string): string => {
  const require = createRequire(import.meta.url);
  let directory = dirname(require.resolve(name));
  while (!directory.endsWith(name.split('/')[1] ?? name)) directory = dirname(directory);
  const parsed: unknown = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
  return typeof parsed === 'object' && parsed !== null && 'version' in parsed
    ? String(parsed.version)
    : 'unknown';
};

describe('WizardConnect boot-time compatibility check', () => {
  it('passes against the pinned packages actually installed', () => {
    expect(installedVersion('@wizardconnect/core')).toBe(EXPECTED_VERSIONS.core);
    expect(installedVersion('@wizardconnect/dapp')).toBe(EXPECTED_VERSIONS.dapp);
    expect(checkWizardConnectCompatibility({ core, dapp }, relays)).toEqual({ ok: true });
  });

  it('lists every problem when the API AtPrice calls has moved', () => {
    const result = checkWizardConnectCompatibility(
      { core: { ...core, initiateDappRelay: undefined, DEFAULT_RELAY_URLS: ['wss://elsewhere'] }, dapp: {} },
      relays,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems).toContain('@wizardconnect/core has no initiateDappRelay()');
    expect(result.problems).toContain('@wizardconnect/dapp has no DappConnectionManager');
    expect(result.problems.some((problem) => problem.includes('default relays changed'))).toBe(true);
  });
});
