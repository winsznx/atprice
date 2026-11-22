import { pino, type Logger } from 'pino';

/**
 * Logs never carry request bodies, xpubs or full client IPs (architecture.md, API). The redact list is a
 * second line of defence for fields that should never be logged in the first place.
 */
export const createLogger = (process: 'api' | 'keeper' | 'migrate', level: string): Logger =>
  pino({
    level,
    base: { process },
    redact: {
      paths: [
        'body',
        'req.body',
        'request.body',
        '*.xpub',
        'xpub',
        'req.headers.authorization',
        'req.headers.cookie',
      ],
      censor: '[redacted]',
    },
    timestamp: pino.stdTimeFunctions.isoTime,
  });

/** Truncates an IP to its network part: /24 for IPv4, /64 for IPv6. */
export const truncateIp = (ip: string): string => {
  const v4 = ip.replace(/^::ffff:/, '');
  if (/^\d+\.\d+\.\d+\.\d+$/.test(v4)) return `${v4.split('.').slice(0, 3).join('.')}.0/24`;
  if (ip.includes(':')) return `${ipv6Prefix64(ip)}::/64`;
  return 'unknown';
};

/** The first four hextets of an IPv6 address, expanding `::`, which is how intents are capped per client. */
export const ipv6Prefix64 = (ip: string): string => {
  const [head = '', tail = ''] = ip.split('::');
  const headParts = head === '' ? [] : head.split(':');
  const tailParts = ip.includes('::') ? (tail === '' ? [] : tail.split(':')) : [];
  const missing = 8 - headParts.length - tailParts.length;
  const full = [...headParts, ...Array.from({ length: Math.max(missing, 0) }, () => '0'), ...tailParts];
  return full
    .slice(0, 4)
    .map((part) => part.toLowerCase().replace(/^0+(?=.)/, ''))
    .join(':');
};

/** The key intents are rate-limited by: the IPv4 address, or the IPv6 /64. */
export const clientPrefix = (ip: string): string => {
  const v4 = ip.replace(/^::ffff:/, '');
  if (/^\d+\.\d+\.\d+\.\d+$/.test(v4)) return v4;
  if (ip.includes(':')) return `${ipv6Prefix64(ip)}::/64`;
  return ip;
};
