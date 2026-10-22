'use strict';

const http = require('http');
const path = require('path');
const request = require('supertest');
const WebSocket = require('ws');
const testServer = require('../helpers/test-server');
const config = require('../fixtures/proxy-config/webpack.config');
const [devServerPort, backendPort] = require('../ports-map')[
  'proxy-web-socket-origin'
];

const WebSocketServer = WebSocket.Server;
const contentBase = path.resolve(__dirname, '../fixtures/proxy-config');
const devServerUrl = `http://localhost:${devServerPort}`;
const crossOrigin = 'http://evil.example.com';

const delay = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

// @see https://github.com/webpack/webpack-dev-server/security/advisories/GHSA-cfqc-fj3v-j925
describe('proxied websocket upgrade origin validation', () => {
  let backend;
  let backendWss;
  let backendSockets;
  let backendConnections;
  let backendPaths;

  // A stand-in for a service the developer proxies over websocket.
  const startBackend = () =>
    new Promise((resolve) => {
      backendConnections = 0;
      backendSockets = [];
      backendPaths = [];

      backend = http.createServer((req, res) => {
        res.end('backend response');
      });

      backend.on('connection', (socket) => {
        backendSockets.push(socket);
      });

      backendWss = new WebSocketServer({ server: backend });
      backendWss.on('connection', (client, req) => {
        backendConnections += 1;
        backendPaths.push(req.url);
        client.send('INTERNAL-SERVICE-SECRET');
      });

      backend.listen(backendPort, '127.0.0.1', resolve);
    });

  const stopBackend = () =>
    new Promise((resolve) => {
      backendWss.clients.forEach((client) => {
        client.terminate();
      });
      backendWss.close();

      backendSockets.forEach((socket) => {
        socket.destroy();
      });

      backend.close(() => {
        resolve();
      });
    });

  const createProxyConfig = () => {
    return {
      context: ['/api'],
      target: `http://127.0.0.1:${backendPort}`,
      ws: true,
      logLevel: 'warn',
    };
  };

  const startServer = (proxy, options) =>
    new Promise((resolve, reject) => {
      testServer.start(
        config,
        Object.assign(
          {
            contentBase,
            host: 'localhost',
            port: devServerPort,
            proxy: [proxy],
          },
          options
        ),
        (err) => (err ? reject(err) : resolve())
      );
    });

  const stopServer = () =>
    new Promise((resolve) => {
      testServer.close(resolve);
    });

  // Send a raw websocket upgrade request for a proxied path to the dev server
  // and report whether it was switched to the proxy target.
  const upgrade = (origin, headers) =>
    new Promise((resolve) => {
      const requestHeaders = {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
        'Sec-WebSocket-Version': '13',
      };

      if (typeof origin === 'string') {
        requestHeaders.Origin = origin;
      }

      Object.assign(requestHeaders, headers);

      let finished = false;
      let timer = null;

      const finish = (result) => {
        if (finished) {
          return;
        }

        finished = true;
        clearTimeout(timer);
        resolve(result);
      };

      const req = http.request({
        host: 'localhost',
        port: devServerPort,
        path: '/api/socket',
        headers: requestHeaders,
      });

      req.on('upgrade', (res, socket) => {
        socket.destroy();
        finish({ upgraded: true, status: res.statusCode });
      });

      req.on('response', (res) => {
        res.resume();
        finish({ upgraded: false, status: res.statusCode });
      });

      req.on('error', () => {
        finish({ upgraded: false });
      });

      timer = setTimeout(() => {
        req.abort();
        finish({ upgraded: false });
      }, 8000);

      req.end();
    });

  const proxyRequest = () =>
    request(devServerUrl)
      .get('/api/hello')
      .expect(200, 'backend response');

  const expectRejected = (result) => {
    expect(result.upgraded).toBe(false);
    expect(result.status).toBe(403);

    // A separate upgrade listener could still contact the backend after the
    // client receives the rejection, so allow that forwarding to finish.
    return delay(100).then(() => {
      expect(backendConnections).toBe(0);
    });
  };

  const expectForwarded = (result) => {
    expect(result.upgraded).toBe(true);
    expect(result.status).toBe(101);
    expect(backendConnections).toBe(1);
  };

  ['sockjs', 'ws'].forEach((transportMode) => {
    describe(`with transportMode: ${transportMode}`, () => {
      const restartServer = (proxy, options) =>
        stopServer().then(() =>
          startServer(proxy, Object.assign({ transportMode }, options))
        );

      beforeEach(() =>
        startBackend().then(() =>
          startServer(createProxyConfig(), { transportMode })
        )
      );

      afterEach(() => stopServer().then(stopBackend));

      it('should reject a cross-origin proxied websocket upgrade', () =>
        upgrade(crossOrigin).then(expectRejected));

      it('should allow a same-origin proxied websocket upgrade', () =>
        upgrade(devServerUrl).then(expectForwarded));

      it('should reject an upgrade with an invalid Host header', () =>
        upgrade(devServerUrl, { Host: 'evil.example.com' }).then(
          expectRejected
        ));

      it('should reject an upgrade without an Origin header', () =>
        upgrade().then(expectRejected));

      it('should reject an upgrade from an IP origin other than the requested host', () =>
        upgrade(`http://127.0.0.1:${devServerPort}`).then(expectRejected));

      it('should allow a same-origin upgrade addressed by IP', () =>
        upgrade(`http://127.0.0.1:${devServerPort}`, {
          Host: `127.0.0.1:${devServerPort}`,
        }).then(expectForwarded));

      it('should not forward a rejected upgrade after an HTTP proxy request', () =>
        proxyRequest()
          .then(() => upgrade(crossOrigin))
          .then(expectRejected));

      it('should allow a same-origin upgrade after an HTTP proxy request', () =>
        proxyRequest()
          .then(() => upgrade(devServerUrl))
          .then(expectForwarded));

      it('should reject an upgrade from an allowed host that is not the same origin', () =>
        restartServer(createProxyConfig(), { allowedHosts: ['.example.com'] })
          .then(() => upgrade(crossOrigin))
          .then(expectRejected)
          .then(() =>
            upgrade('http://app.example.com', {
              Host: `app.example.com:${devServerPort}`,
            })
          )
          .then(expectForwarded));

      it('should forward a cross-origin upgrade when the host check is disabled', () =>
        restartServer(createProxyConfig(), { disableHostCheck: true })
          .then(() => upgrade(crossOrigin))
          .then(expectForwarded));

      it('should validate upgrades using the current proxy callback configuration', () => {
        let proxyConfig = Object.assign(createProxyConfig(), {
          ws: false,
          pathRewrite: { '^/api': '/initial' },
        });

        return restartServer(() => Object.assign({}, proxyConfig))
          .then(proxyRequest)
          .then(() => {
            proxyConfig = Object.assign({}, proxyConfig, {
              ws: true,
              pathRewrite: { '^/api': '/updated' },
            });

            return proxyRequest();
          })
          .then(() => upgrade(crossOrigin))
          .then(expectRejected)
          .then(() => upgrade(devServerUrl))
          .then((result) => {
            expectForwarded(result);
            expect(backendPaths).toEqual(['/updated/socket']);
          });
      });
    });
  });
});
