/*
 * Preload hook for Codex Discord Bridge on networks where Discord's
 * websocket endpoint must go through a local HTTP CONNECT proxy.
 *
 * discord.js uses the `ws` package for gateway websockets, and `ws` does not
 * automatically honor HTTP_PROXY/HTTPS_PROXY. This hook patches the named
 * `WebSocket` export before discord.js loads it and injects a lightweight
 * CONNECT agent only for Discord gateway websocket URLs.
 */
'use strict';

const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const tls = require('node:tls');

try {
  const { ProxyAgent, setGlobalDispatcher } = require('undici');
  const proxyForFetch = getProxyUrl();
  if (proxyForFetch) {
    setGlobalDispatcher(new ProxyAgent(proxyForFetch));
  }
} catch (error) {
}

const wsModule = require('ws');
const OriginalWebSocket = wsModule.WebSocket || wsModule;

function getProxyUrl() {
  return (
    process.env.CODEX_DISCORD_BRIDGE_PROXY ||
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy ||
    ''
  ).trim();
}

function isDiscordGatewayUrl(address) {
  try {
    const url = new URL(typeof address === 'string' ? address : String(address));
    const hostname = url.hostname.toLowerCase();
    return (url.protocol === 'wss:' || url.protocol === 'ws:') && (
      hostname === 'gateway.discord.gg' ||
      hostname.endsWith('.discord.gg')
    );
  } catch {
    return false;
  }
}

function parseProxy(proxyValue) {
  if (!proxyValue) {
    return undefined;
  }

  const proxy = new URL(proxyValue);
  if (proxy.protocol !== 'http:') {
    throw new Error(`[ws-proxy-preload] Unsupported proxy protocol: ${proxy.protocol}. Only http:// CONNECT proxies are supported.`);
  }

  return {
    host: proxy.hostname,
    port: Number(proxy.port || 80),
    auth: proxy.username ? `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}` : '',
  };
}

class HttpConnectAgent extends http.Agent {
  constructor(proxy) {
    super({ keepAlive: true });
    this.proxy = proxy;
  }

  createConnection(options, callback) {
    createConnectTunnel(this.proxy, options, false, callback);
  }
}

class HttpsConnectAgent extends https.Agent {
  constructor(proxy) {
    super({ keepAlive: true });
    this.proxy = proxy;
  }

  createConnection(options, callback) {
    createConnectTunnel(this.proxy, options, true, callback);
  }
}

const agentCache = new Map();

function getAgent(targetProtocol, proxyValue) {
  const cacheKey = `${targetProtocol}|${proxyValue}`;
  const cached = agentCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const proxy = parseProxy(proxyValue);
  if (!proxy) {
    return undefined;
  }

  const agent = targetProtocol === 'wss:' ? new HttpsConnectAgent(proxy) : new HttpConnectAgent(proxy);
  agentCache.set(cacheKey, agent);
  return agent;
}

function createConnectTunnel(proxy, options, secureEndpoint, callback) {
  const endpointHost = options.servername || options.host || options.hostname;
  const endpointPort = Number(options.port || (secureEndpoint ? 443 : 80));
  let settled = false;
  let buffered = Buffer.alloc(0);

  function done(error, socket) {
    if (settled) {
      if (socket) socket.destroy();
      return;
    }
    settled = true;
    callback(error, socket);
  }

  const socket = net.connect(proxy.port, proxy.host);

  socket.once('error', (error) => done(error));
  socket.once('connect', () => {
    const headers = [
      `CONNECT ${endpointHost}:${endpointPort} HTTP/1.1`,
      `Host: ${endpointHost}:${endpointPort}`,
      'Proxy-Connection: Keep-Alive',
      'Connection: Keep-Alive',
    ];

    if (proxy.auth) {
      headers.push(`Proxy-Authorization: Basic ${Buffer.from(proxy.auth).toString('base64')}`);
    }

    socket.write(`${headers.join('\r\n')}\r\n\r\n`);
  });

  socket.on('data', function onData(chunk) {
    buffered = Buffer.concat([buffered, chunk]);
    const headerEnd = buffered.indexOf('\r\n\r\n');
    if (headerEnd === -1) {
      return;
    }

    socket.off('data', onData);
    const header = buffered.subarray(0, headerEnd).toString('latin1');
    const extra = buffered.subarray(headerEnd + 4);
    const statusLine = header.split('\r\n')[0] || '';
    const statusCode = Number(statusLine.split(/\s+/)[1]);

    if (statusCode < 200 || statusCode >= 300) {
      socket.destroy();
      done(new Error(`[ws-proxy-preload] Proxy CONNECT failed: ${statusLine}`));
      return;
    }

    if (extra.length > 0) {
      socket.unshift(extra);
    }

    if (!secureEndpoint) {
      done(null, socket);
      return;
    }

    const tlsSocket = tls.connect({
      ...options,
      socket,
      servername: endpointHost,
    });

    tlsSocket.once('secureConnect', () => done(null, tlsSocket));
    tlsSocket.once('error', (error) => done(error, tlsSocket));
  });
}

class ProxyAwareWebSocket extends OriginalWebSocket {
  constructor(address, protocols, options) {
    let finalProtocols = protocols;
    let finalOptions = options;

    if (
      finalOptions === undefined &&
      finalProtocols &&
      typeof finalProtocols === 'object' &&
      !Array.isArray(finalProtocols) &&
      !(finalProtocols instanceof String)
    ) {
      finalOptions = finalProtocols;
      finalProtocols = undefined;
    }

    const proxyValue = getProxyUrl();
    if (proxyValue && isDiscordGatewayUrl(address)) {
      const targetUrl = new URL(typeof address === 'string' ? address : String(address));
      finalOptions = {
        ...(finalOptions || {}),
        agent: finalOptions?.agent || getAgent(targetUrl.protocol, proxyValue),
      };
      if (!process.env.CODEX_DISCORD_BRIDGE_WS_PROXY_PATCH_LOGGED) {
        process.env.CODEX_DISCORD_BRIDGE_WS_PROXY_PATCH_LOGGED = '1';
      }
    }

    if (finalProtocols === undefined) {
      super(address, finalOptions);
    } else {
      super(address, finalProtocols, finalOptions);
    }
  }
}

try {
  wsModule.WebSocket = ProxyAwareWebSocket;
  wsModule.default = ProxyAwareWebSocket;
} catch (error) {
}
