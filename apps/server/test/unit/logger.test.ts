import { describe, expect, it } from 'vitest';
import { clientPrefix, ipv6Prefix64, truncateIp } from '../../src/logger.js';

describe('clientPrefix (the per-client intent cap key)', () => {
  it.each([
    ['203.0.113.7', '203.0.113.7'],
    ['::ffff:203.0.113.7', '203.0.113.7'],
    ['2001:db8:85a3:8d3:1319:8a2e:370:7348', '2001:db8:85a3:8d3::/64'],
    ['2001:db8:85a3:8d3:ffff:ffff:ffff:ffff', '2001:db8:85a3:8d3::/64'],
    ['2001:0DB8:0000:0001::1', '2001:db8:0:1::/64'],
    ['2001:db8::1', '2001:db8:0:0::/64'],
    ['2001:db8::', '2001:db8:0:0::/64'],
    ['::1', '0:0:0:0::/64'],
    ['fe80::1%en0', 'fe80:0:0:0::/64'],
  ])('keys %s as %s', (ip, expected) => {
    expect(clientPrefix(ip)).toBe(expected);
  });

  it('puts every address of one IPv6 /64 under one key and neighbouring /64s under different keys', () => {
    expect(clientPrefix('2001:db8:1:2::a')).toBe(clientPrefix('2001:db8:1:2:ffff::b'));
    expect(clientPrefix('2001:db8:1:2::a')).not.toBe(clientPrefix('2001:db8:1:3::a'));
  });
});

describe('truncateIp (what logs and retained intents keep)', () => {
  it.each([
    ['203.0.113.7', '203.0.113.0/24'],
    ['::ffff:198.51.100.200', '198.51.100.0/24'],
    ['2001:db8:85a3:8d3:1319:8a2e:370:7348', '2001:db8:85a3:8d3::/64'],
    ['::1', '0:0:0:0::/64'],
    ['not-an-ip', 'unknown'],
    ['', 'unknown'],
  ])('truncates %s to %s', (ip, expected) => {
    expect(truncateIp(ip)).toBe(expected);
  });

  it('never returns the full IPv4 address', () => {
    expect(truncateIp('192.0.2.44')).not.toContain('.44');
  });
});

describe('ipv6Prefix64', () => {
  it('expands :: in the middle, at the start and at the end', () => {
    expect(ipv6Prefix64('1:2::7:8')).toBe('1:2:0:0');
    expect(ipv6Prefix64('::5:6:7:8')).toBe('0:0:0:0');
    expect(ipv6Prefix64('1:2:3:4::')).toBe('1:2:3:4');
  });
});
