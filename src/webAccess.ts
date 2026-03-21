import os from 'node:os';

import type { WebConfig } from './config.js';

export interface WebAccessUrl {
  label: '本机' | '局域网';
  host: string;
  origin: string;
  url: string;
}

interface AddressLike {
  address: string;
  port: number;
}

type NetworkInterfaceRecord = Record<string, Array<{
  family?: string | number;
  address: string;
  internal?: boolean;
}> | undefined>;

export function buildWebAccessUrls(
  web: Pick<WebConfig, 'bind' | 'port' | 'authToken'>,
  address: AddressLike | undefined = undefined,
  interfaces: NetworkInterfaceRecord = os.networkInterfaces(),
): WebAccessUrl[] {
  const port = address?.port ?? web.port;
  const listenAddress = normalizeHost(address?.address ?? web.bind);
  const entries: WebAccessUrl[] = [];
  const seenHosts = new Set<string>();

  const push = (label: WebAccessUrl['label'], host: string | undefined): void => {
    if (!host || seenHosts.has(host)) {
      return;
    }

    const origin = `http://${host}:${port}`;
    entries.push({
      label,
      host,
      origin,
      url: appendToken(origin, web.authToken),
    });
    seenHosts.add(host);
  };

  if (isWildcardHost(listenAddress)) {
    push('本机', '127.0.0.1');
    for (const host of listLanIpv4Hosts(interfaces)) {
      push('局域网', host);
    }
    return entries;
  }

  if (isLoopbackHost(listenAddress)) {
    push('本机', '127.0.0.1');
    return entries;
  }

  push('局域网', listenAddress);
  return entries;
}

function appendToken(origin: string, token: string | undefined): string {
  if (!token) {
    return origin;
  }

  return `${origin}/?token=${encodeURIComponent(token)}`;
}

function listLanIpv4Hosts(interfaces: NetworkInterfaceRecord): string[] {
  return Object.values(interfaces)
    .flat()
    .filter((entry): entry is { family?: string | number; address: string; internal?: boolean } => Boolean(entry))
    .filter((entry) => isIpv4Family(entry.family) && !entry.internal && isUsableIpv4(entry.address))
    .map((entry) => entry.address)
    .sort((left, right) => left.localeCompare(right));
}

function normalizeHost(address: string): string {
  if (!address) {
    return '127.0.0.1';
  }

  if (address === '::1' || address === 'localhost') {
    return '127.0.0.1';
  }

  if (address.startsWith('::ffff:')) {
    return address.slice('::ffff:'.length);
  }

  return address;
}

function isIpv4Family(family: string | number | undefined): boolean {
  return family === 'IPv4' || family === 4;
}

function isUsableIpv4(address: string): boolean {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(address) && !isLoopbackHost(address);
}

function isLoopbackHost(address: string): boolean {
  return address === '127.0.0.1';
}

function isWildcardHost(address: string): boolean {
  return address === '0.0.0.0' || address === '::';
}
