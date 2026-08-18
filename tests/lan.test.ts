/**
 * DECKSHOT — LAN play.
 *
 * Two halves of one failure. The server already listens on every interface and
 * the client already derives its socket url from `window.location`, so a LAN
 * game needs no configuration — but the host still has to hand the other
 * players a url, and the obvious one is wrong. A host on `http://localhost:8080`
 * who copies `http://localhost:8080/?lobby=K7QX` has copied a link that
 * resolves on every machine on the network and sends each of them to their own
 * laptop. Nothing errors. It just never works.
 *
 * So the server reports its private-range addresses at `/lan`, and the client
 * swaps the hostname in when — and only when — its own page is on loopback.
 */

import { describe, expect, it } from 'vitest';

import { isPrivateIPv4, lanAddresses, lanOrigins, type IfaceMap } from '../server/src/net/lan.js';
import { discoverLanAddress, inviteLink, isLoopbackHost, setLanAddress } from '../client/src/ui/util.js';

// ---------------------------------------------------------------------------
// Server: which addresses count as "the LAN"
// ---------------------------------------------------------------------------

describe('isPrivateIPv4', () => {
  it('accepts the three RFC 1918 ranges', () => {
    expect(isPrivateIPv4('10.0.0.1')).toBe(true);
    expect(isPrivateIPv4('10.255.255.254')).toBe(true);
    expect(isPrivateIPv4('172.16.4.9')).toBe(true);
    expect(isPrivateIPv4('172.31.255.1')).toBe(true);
    expect(isPrivateIPv4('192.168.1.42')).toBe(true);
  });

  it('rejects the 172.x blocks either side of 172.16/12', () => {
    expect(isPrivateIPv4('172.15.0.1')).toBe(false);
    expect(isPrivateIPv4('172.32.0.1')).toBe(false);
  });

  it('rejects loopback, link-local and public addresses', () => {
    // Loopback is the exact thing this module exists to replace.
    expect(isPrivateIPv4('127.0.0.1')).toBe(false);
    // Link-local means DHCP failed. Offering it wastes the host's time.
    expect(isPrivateIPv4('169.254.13.7')).toBe(false);
    expect(isPrivateIPv4('8.8.8.8')).toBe(false);
    expect(isPrivateIPv4('203.0.113.5')).toBe(false);
  });

  it('rejects malformed input rather than coercing it', () => {
    expect(isPrivateIPv4('192.168.1')).toBe(false);
    expect(isPrivateIPv4('192.168.1.256')).toBe(false);
    expect(isPrivateIPv4('192.168.1.1.1')).toBe(false);
    expect(isPrivateIPv4('192.168.01.x')).toBe(false);
    expect(isPrivateIPv4('')).toBe(false);
    // An IPv6 address must not be smuggled through by the octet parser.
    expect(isPrivateIPv4('fe80::1')).toBe(false);
  });
});

describe('lanAddresses', () => {
  const ifaces: IfaceMap = {
    lo0: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
    en0: [
      { address: 'fe80::1', family: 'IPv6', internal: false },
      { address: '192.168.1.42', family: 'IPv4', internal: false },
    ],
    utun3: [{ address: '10.8.0.6', family: 'IPv4', internal: false }],
    docker0: [{ address: '172.17.0.1', family: 'IPv4', internal: false }],
    en1: [{ address: '169.254.9.9', family: 'IPv4', internal: false }],
  };

  it('keeps only external private IPv4 addresses', () => {
    expect(lanAddresses(ifaces)).toEqual(['192.168.1.42', '10.8.0.6', '172.17.0.1']);
  });

  it('ranks the address the other players are actually on first', () => {
    // 192.168/16 is what a consumer router hands out; 172.16/12 here is a
    // Docker bridge, reachable from nothing. Printing that one first would
    // send the host chasing an address that cannot work.
    const [best] = lanAddresses(ifaces);
    expect(best).toBe('192.168.1.42');
  });

  it('tolerates the numeric `family` some Node versions reported', () => {
    const numeric: IfaceMap = { en0: [{ address: '192.168.0.5', family: 4, internal: false }] };
    expect(lanAddresses(numeric)).toEqual(['192.168.0.5']);
  });

  it('deduplicates an address that appears on two interfaces', () => {
    const dup: IfaceMap = {
      en0: [{ address: '192.168.1.42', family: 'IPv4', internal: false }],
      bridge0: [{ address: '192.168.1.42', family: 'IPv4', internal: false }],
    };
    expect(lanAddresses(dup)).toEqual(['192.168.1.42']);
  });

  it('reports nothing off a private network, so a public host leaks nothing', () => {
    const publicOnly: IfaceMap = {
      lo0: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
      eth0: [{ address: '203.0.113.5', family: 'IPv4', internal: false }],
    };
    expect(lanAddresses(publicOnly)).toEqual([]);
    expect(lanOrigins(8080, publicOnly)).toEqual([]);
  });

  it('builds origins on the port the server was told to listen on', () => {
    expect(lanOrigins(8091, ifaces)[0]).toBe('http://192.168.1.42:8091');
  });
});

// ---------------------------------------------------------------------------
// Client: the invite link
// ---------------------------------------------------------------------------

describe('isLoopbackHost', () => {
  it('covers every spelling of "this machine"', () => {
    for (const h of ['localhost', 'LOCALHOST', 'deckshot.localhost', '127.0.0.1', '127.1.2.3', '::1', '[::1]', '0.0.0.0']) {
      expect(isLoopbackHost(h)).toBe(true);
    }
  });

  it('does not claim a real host', () => {
    for (const h of ['192.168.1.42', 'deckshot.fly.dev', '10.0.0.4', 'localhost.evil.com']) {
      expect(isLoopbackHost(h)).toBe(false);
    }
  });
});

describe('inviteLink', () => {
  const loopback = { protocol: 'http:', hostname: 'localhost', port: '8080', pathname: '/' };

  it('swaps a loopback host for the LAN address', () => {
    expect(inviteLink('K7QX', loopback, '192.168.1.42')).toBe('http://192.168.1.42:8080/?lobby=K7QX');
  });

  it('keeps the page port, not the server port', () => {
    // In dev the page is Vite on :5173 while the game server is on :8080.
    // Only the hostname is transferable; taking the server's port here would
    // hand out a url with no client on it.
    const vite = { protocol: 'http:', hostname: 'localhost', port: '5173', pathname: '/' };
    expect(inviteLink('K7QX', vite, '192.168.1.42')).toBe('http://192.168.1.42:5173/?lobby=K7QX');
  });

  it('leaves a real host alone — a public deploy must not advertise a LAN ip', () => {
    const deployed = { protocol: 'https:', hostname: 'deckshot.fly.dev', port: '', pathname: '/' };
    expect(inviteLink('K7QX', deployed, '192.168.1.42')).toBe('https://deckshot.fly.dev/?lobby=K7QX');
  });

  it('falls back to the page url when no LAN address was found', () => {
    expect(inviteLink('K7QX', loopback, null)).toBe('http://localhost:8080/?lobby=K7QX');
  });

  it('preserves a non-root path and omits an empty port', () => {
    const sub = { protocol: 'http:', hostname: 'localhost', port: '', pathname: '/play/' };
    expect(inviteLink('K7QX', sub, '10.0.0.4')).toBe('http://10.0.0.4/play/?lobby=K7QX');
  });
});

describe('discoverLanAddress', () => {
  const ok = (body: unknown): typeof fetch =>
    (async () => ({ ok: true, json: async () => body })) as unknown as typeof fetch;

  it('remembers the first address and uses it for later links', async () => {
    setLanAddress(null);
    await expect(discoverLanAddress(ok({ addresses: ['192.168.1.42', '10.8.0.6'] }))).resolves.toBe('192.168.1.42');
    const loopback = { protocol: 'http:', hostname: 'localhost', port: '8080', pathname: '/' };
    expect(inviteLink('K7QX', loopback)).toBe('http://192.168.1.42:8080/?lobby=K7QX');
    setLanAddress(null);
  });

  it('stays null on an empty list, a bad shape, a non-200 and a thrown fetch', async () => {
    setLanAddress(null);
    await expect(discoverLanAddress(ok({ addresses: [] }))).resolves.toBeNull();
    await expect(discoverLanAddress(ok({ nope: 1 }))).resolves.toBeNull();

    const notFound = (async () => ({ ok: false, json: async () => ({}) })) as unknown as typeof fetch;
    await expect(discoverLanAddress(notFound)).resolves.toBeNull();

    const throws = (async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    await expect(discoverLanAddress(throws)).resolves.toBeNull();

    // The point of every one of those: the link still works locally.
    const loopback = { protocol: 'http:', hostname: 'localhost', port: '8080', pathname: '/' };
    expect(inviteLink('K7QX', loopback)).toBe('http://localhost:8080/?lobby=K7QX');
  });
});
