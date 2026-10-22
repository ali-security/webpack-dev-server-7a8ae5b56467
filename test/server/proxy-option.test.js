'use strict';

const http = require('http');
const path = require('path');
const request = require('supertest');
const express = require('express');
const bodyParser = require('body-parser');
const WebSocket = require('ws');
const testServer = require('../helpers/test-server');
const BaseServer = require('../../lib/servers/BaseServer');
const config = require('../fixtures/proxy-config/webpack.config');
const [port1, port2, port3, port4] = require('../ports-map')['proxy-option'];
const port5 = require('../ports-map')['proxy-option-hmr'];

const WebSocketServer = WebSocket.Server;
const contentBase = path.resolve(__dirname, '../fixtures/proxy-config');

const proxyOptionPathsAsProperties = {
  '/proxy1': {
    target: `http://localhost:${port1}`,
  },
  '/api/proxy2': {
    target: `http://localhost:${port2}`,
    pathRewrite: { '^/api': '' },
  },
  '/foo': {
    bypass(req) {
      if (/\.html$/.test(req.path)) {
        return '/index.html';
      }

      return null;
    },
  },
  '/proxyfalse': {
    bypass(req) {
      if (/\/proxyfalse$/.test(req.path)) {
        return false;
      }
    },
  },
};

const proxyOption = {
  context: () => true,
  target: `http://localhost:${port1}`,
};

const proxyOptionOfArray = [
  { context: '/proxy1', target: proxyOption.target },
  function proxy() {
    return {
      context: '/api/proxy2',
      target: `http://localhost:${port2}`,
      pathRewrite: { '^/api': '' },
    };
  },
];

function startProxyServers() {
  const listeners = [];
  const proxy1 = express();
  const proxy2 = express();

  proxy1.get('/proxy1', (req, res) => {
    res.send('from proxy1');
  });
  proxy1.get('/api', (req, res) => {
    res.send('api response from proxy1');
  });
  proxy2.get('/proxy2', (req, res) => {
    res.send('from proxy2');
  });

  listeners.push(proxy1.listen(port1));
  listeners.push(proxy2.listen(port2));

  // return a function to shutdown proxy servers
  return function proxy() {
    listeners.forEach((listener) => {
      listener.close();
    });
  };
}

describe('proxy option', () => {
  describe('as an object of paths with properties', () => {
    let server;
    let req;
    let closeProxyServers;

    beforeAll((done) => {
      closeProxyServers = startProxyServers();
      server = testServer.start(
        config,
        {
          contentBase,
          proxy: proxyOptionPathsAsProperties,
          port: port3,
        },
        done
      );
      req = request(server.app);
    });

    afterAll((done) => {
      testServer.close(() => {
        closeProxyServers();
        done();
      });
    });

    describe('target', () => {
      it('respects a proxy option when a request path is matched', (done) => {
        req.get('/proxy1').expect(200, 'from proxy1', done);
      });
    });

    describe('pathRewrite', () => {
      it('respects a pathRewrite option', (done) => {
        req.get('/api/proxy2').expect(200, 'from proxy2', done);
      });
    });

    describe('bypass', () => {
      it('can rewrite a request path', (done) => {
        req.get('/foo/bar.html').expect(200, /Hello/, done);
      });

      it('can rewrite a request path regardless of the target defined a bypass option', (done) => {
        req.get('/baz/hoge.html').expect(200, /Hello/, done);
      });

      it('should pass through a proxy when a bypass function returns null', (done) => {
        req.get('/foo.js').expect(200, /Hey/, done);
      });

      it('should not pass through a proxy when a bypass function returns false', (done) => {
        req.get('/proxyfalse').expect(404, done);
      });
    });
  });

  describe('as an option is an object', () => {
    let server;
    let req;
    let closeProxyServers;

    beforeAll((done) => {
      closeProxyServers = startProxyServers();
      server = testServer.start(
        config,
        {
          contentBase,
          proxy: proxyOption,
          port: port3,
        },
        done
      );
      req = request(server.app);
    });

    afterAll((done) => {
      testServer.close(() => {
        closeProxyServers();
        done();
      });
    });

    it('respects a proxy option', (done) => {
      req.get('/proxy1').expect(200, 'from proxy1', done);
    });
  });

  describe('as an array', () => {
    let server;
    let req;
    let closeProxyServers;

    beforeAll((done) => {
      closeProxyServers = startProxyServers();
      server = testServer.start(
        config,
        {
          contentBase,
          proxy: proxyOptionOfArray,
          port: port3,
        },
        done
      );
      req = request(server.app);
    });

    afterAll((done) => {
      testServer.close(() => {
        closeProxyServers();
        done();
      });
    });

    it('respects a proxy option', (done) => {
      req.get('/proxy1').expect(200, 'from proxy1', done);
    });

    it('respects a proxy option of function', (done) => {
      req.get('/api/proxy2').expect(200, 'from proxy2', done);
    });
  });

  describe('should sharing a proxy option', () => {
    let server;
    let req;
    let listener;
    const proxyTarget = {
      target: `http://localhost:${port1}`,
    };

    beforeAll((done) => {
      const proxy = express();

      proxy.get('*', (proxyReq, res) => {
        res.send('from proxy');
      });

      listener = proxy.listen(port1);

      server = testServer.start(
        config,
        {
          contentBase,
          proxy: {
            '/proxy1': proxyTarget,
            '/proxy2': proxyTarget,
          },
          port: port3,
        },
        done
      );
      req = request(server.app);
    });

    afterAll((done) => {
      testServer.close(() => {
        listener.close();
        done();
      });
    });

    it('respects proxy1 option', (done) => {
      req.get('/proxy1').expect(200, 'from proxy', done);
    });

    it('respects proxy2 option', (done) => {
      req.get('/proxy2').expect(200, 'from proxy', done);
    });
  });

  describe('should handles external websocket upgrade', () => {
    let ws;
    let wsServer;
    let responseMessage;

    const transportModes = ['sockjs', 'ws'];
    transportModes.forEach((transportMode) => {
      describe(`with transportMode: ${transportMode}`, () => {
        beforeAll((done) => {
          testServer.start(
            config,
            {
              contentBase,
              transportMode,
              proxy: [
                {
                  context: '/',
                  target: `http://localhost:${port4}`,
                  ws: true,
                },
              ],
              port: port3,
            },
            done
          );

          wsServer = new WebSocketServer({ port: port4 });
          wsServer.on('connection', (server) => {
            server.on('message', (message) => {
              server.send(message);
            });
          });
        });

        beforeEach((done) => {
          ws = new WebSocket(`ws://localhost:${port3}/proxy3/socket`);
          ws.on('message', (message) => {
            responseMessage = message;
            done();
          });
          ws.on('open', () => {
            ws.send('foo');
          });
        });

        it('Should receive response', () => {
          expect(responseMessage).toEqual('foo');
        });

        afterAll((done) => {
          wsServer.close();
          testServer.close(done);
        });
      });
    });
  });

  describe('should supports http methods', () => {
    let server;
    let req;
    let listener;
    const proxyTarget = {
      target: `http://localhost:${port1}`,
    };

    beforeAll((done) => {
      const proxy = express();

      // Parse application/x-www-form-urlencoded
      proxy.use(bodyParser.urlencoded({ extended: false }));

      // Parse application/json
      proxy.use(bodyParser.json());

      // This forces Express to try to decode URLs, which is needed for the test
      // associated with the middleware below.
      proxy.all('*', (_req, res, next) => {
        next();
      });
      // We must define all 4 params in order for this to be detected as an
      // error handling middleware.
      // eslint-disable-next-line no-unused-vars
      proxy.use((error, proxyReq, res, next) => {
        res.status(500);
        res.send('error from proxy');
      });

      proxy.get('/get', (proxyReq, res) => {
        res.send('GET method from proxy');
      });

      proxy.head('/head', (proxyReq, res) => {
        res.send('HEAD method from proxy');
      });

      proxy.post('/post-x-www-form-urlencoded', (proxyReq, res) => {
        const id = proxyReq.body.id;

        res.status(200).send(`POST method from proxy (id: ${id})`);
      });

      proxy.post('/post-application-json', (proxyReq, res) => {
        const id = proxyReq.body.id;

        res.status(200).send({ answer: `POST method from proxy (id: ${id})` });
      });

      proxy.delete('/delete', (proxyReq, res) => {
        res.send('DELETE method from proxy');
      });

      listener = proxy.listen(port1);

      server = testServer.start(
        config,
        {
          contentBase,
          proxy: {
            '**': proxyTarget,
          },
        },
        done
      );
      req = request(server.app);
    });

    afterAll((done) => {
      testServer.close(() => {
        listener.close();
        done();
      });
    });

    it('errors', (done) => {
      req.get('/%').expect(500, 'error from proxy', done);
    });

    it('GET method', (done) => {
      req.get('/get').expect(200, 'GET method from proxy', done);
    });

    it('HEAD method', (done) => {
      req.head('/head').expect(200, done);
    });

    it('POST method (application/x-www-form-urlencoded)', (done) => {
      req
        .post('/post-x-www-form-urlencoded')
        .send('id=1')
        .expect(200, 'POST method from proxy (id: 1)', done);
    });

    it('POST method (application/json)', (done) => {
      req
        .post('/post-application-json')
        .send({ id: '1' })
        .set('Accept', 'application/json')
        .expect('Content-Type', /json/)
        .expect(
          200,
          JSON.stringify({ answer: 'POST method from proxy (id: 1)' }),
          done
        );
    });

    it('DELETE method', (done) => {
      req.delete('/delete').expect(200, 'DELETE method from proxy', done);
    });
  });

  describe('should not forward the dev server socket upgrade to a websocket proxy', () => {
    const devServerUrl = `http://localhost:${port3}`;
    const liveReloadMessage = JSON.stringify({ type: 'liveReload' });

    let backend;
    let backendWss;
    let backendSockets;
    let backendUpgradeCount;
    let proxyErrors;

    // Start a backend (the user proxy target) answering every HTTP request and
    // accepting (or destroying) every websocket upgrade, and a dev server
    // proxying everything to it with `ws: true`.
    const setup = (options, destroyUpgrades) =>
      new Promise((resolve, reject) => {
        backendUpgradeCount = 0;
        backendSockets = [];
        proxyErrors = [];

        backend = http.createServer((req, res) => {
          res.end('from backend');
        });

        backend.on('connection', (socket) => {
          backendSockets.push(socket);
        });

        if (destroyUpgrades) {
          backend.on('upgrade', (req, socket) => {
            backendUpgradeCount += 1;
            socket.destroy();
          });
        } else {
          backendWss = new WebSocketServer({ server: backend });
          backendWss.on('connection', () => {
            backendUpgradeCount += 1;
          });
        }

        backend.listen(port5, () => {
          testServer.start(
            config,
            Object.assign(
              {
                contentBase,
                proxy: [
                  {
                    context: '/',
                    target: `http://localhost:${port5}`,
                    ws: true,
                    logProvider: () => {
                      const noop = () => {};

                      return {
                        log: noop,
                        debug: noop,
                        info: noop,
                        warn: noop,
                        error: (message) => {
                          proxyErrors.push(message);
                        },
                      };
                    },
                  },
                ],
                port: port3,
              },
              options
            ),
            (err) => (err ? reject(err) : resolve())
          );
        });
      });

    const teardown = () =>
      new Promise((resolve) => {
        if (backendWss) {
          backendWss.clients.forEach((client) => {
            client.terminate();
          });
          backendWss.close();
          backendWss = null;
        }

        backendSockets.forEach((socket) => {
          socket.destroy();
        });

        testServer.close(() => {
          backend.close(() => {
            resolve();
          });
        });
      });

    // Open a websocket to `socketPath` on the dev server and report whether the
    // handshake completed, the messages received and whether the upgrade was
    // forwarded to the proxy target.
    const probe = (socketPath) =>
      new Promise((resolve) => {
        const before = backendUpgradeCount;
        const messages = [];
        let opened = false;
        let finished = false;
        let timer = null;

        const client = new WebSocket(`ws://localhost:${port3}${socketPath}`, {
          origin: devServerUrl,
        });

        const finish = () => {
          if (finished) {
            return;
          }

          finished = true;
          clearTimeout(timer);

          // let the proxy forward the upgrade to its target, if it does
          setTimeout(() => {
            client.terminate();

            resolve({
              opened,
              messages,
              forwarded: backendUpgradeCount > before,
            });
          }, 500);
        };

        client.on('open', () => {
          opened = true;
          finish();
        });

        client.on('message', (message) => {
          messages.push(message);
        });

        // the handshake was refused or the socket was broken
        client.on('error', finish);

        timer = setTimeout(finish, 3000);
      });

    // Proxy a plain HTTP request first: with `ws: true` the proxy middleware
    // would subscribe itself to the server "upgrade" event at this point.
    const proxyRequest = () =>
      request(devServerUrl)
        .get('/proxied')
        .expect(200, 'from backend');

    const expectServedLocally = (result) => {
      expect(result.opened).toBe(true);
      expect(result.forwarded).toBe(false);
    };

    [
      {
        transportMode: 'ws',
        // the `ws` server only handles its exact path (query string stripped)
        socketPaths: ['/sockjs-node', '/sockjs-node?token=1'],
        otherPaths: [
          '/not-hmr',
          '//sockjs-node',
          '/sockjs-node/',
          '/SOCKJS-NODE',
          '/sockjs-Node',
          '/%73ockjs-node',
        ],
      },
      {
        transportMode: 'sockjs',
        // the sockjs server handles every path under its prefix
        socketPaths: [
          '/sockjs-node/websocket',
          '/sockjs-node/000/abcd1234/websocket',
        ],
        otherPaths: [
          '/not-hmr',
          '//sockjs-node/websocket',
          '/SOCKJS-NODE/websocket',
          '/sockjs-node-other/websocket',
        ],
      },
    ].forEach((mode) => {
      describe(`with transportMode: ${mode.transportMode}`, () => {
        beforeAll(() => setup({ transportMode: mode.transportMode }));

        afterAll(teardown);

        it('serves the socket upgrade locally and does not forward it to the proxy', () =>
          probe(mode.socketPaths[0]).then((result) => {
            expectServedLocally(result);
            expect(result.messages).toContain(liveReloadMessage);
          }));

        mode.socketPaths.forEach((socketPath) => {
          it(`does not forward the socket upgrade (${socketPath}) to the proxy`, () =>
            probe(socketPath).then(expectServedLocally));
        });

        mode.otherPaths.forEach((otherPath) => {
          it(`forwards a non-socket upgrade (${otherPath}) to the proxy`, () =>
            probe(otherPath).then((result) => {
              expect(result.forwarded).toBe(true);
            }));
        });
      });

      // A page is loaded through the proxy before any websocket is opened, the
      // way a browser does: the proxy middleware must not have subscribed itself
      // to the server "upgrade" event on that first request.
      describe(`with transportMode: ${mode.transportMode} after a proxied request`, () => {
        beforeAll(() => setup({ transportMode: mode.transportMode }));

        afterAll(teardown);

        it('does not forward the socket upgrade to the proxy', () =>
          proxyRequest()
            .then(() => probe(mode.socketPaths[0]))
            .then((result) => {
              expectServedLocally(result);
              expect(result.messages).toContain(liveReloadMessage);
            }));

        it('forwards a non-socket upgrade (/not-hmr) to the proxy', () =>
          probe('/not-hmr').then((result) => {
            expect(result.forwarded).toBe(true);
          }));
      });
    });

    [
      {
        transportMode: 'ws',
        socketPath: '/custom-hmr',
        otherPath: '/sockjs-node',
      },
      {
        transportMode: 'sockjs',
        socketPath: '/custom-hmr/websocket',
        otherPath: '/sockjs-node/websocket',
      },
    ].forEach((mode) => {
      describe(`with transportMode: ${mode.transportMode} and a custom sockPath`, () => {
        beforeAll(() =>
          setup({ transportMode: mode.transportMode, sockPath: '/custom-hmr/' })
        );

        afterAll(teardown);

        it(`does not forward the socket upgrade (${mode.socketPath}) to the proxy`, () =>
          proxyRequest()
            .then(() => probe(mode.socketPath))
            .then((result) => {
              expectServedLocally(result);
              expect(result.messages).toContain(liveReloadMessage);
            }));

        it(`forwards the default socket path (${mode.otherPath}) to the proxy`, () =>
          probe(mode.otherPath).then((result) => {
            expect(result.forwarded).toBe(true);
          }));
      });
    });

    describe('with a custom transportMode.server implementation', () => {
      /* eslint-disable class-methods-use-this */
      class CustomWebsocketServer extends BaseServer {
        constructor(server) {
          super(server);

          this.wsServer = new WebSocketServer({
            noServer: true,
            path: this.server.sockPath,
          });

          this.server.listeningApp.on('upgrade', (req, socket, head) => {
            if (!this.wsServer.shouldHandle(req)) {
              return;
            }

            this.wsServer.handleUpgrade(req, socket, head, (connection) => {
              this.wsServer.emit('connection', connection, req);
            });
          });
        }

        send(connection, message) {
          connection.send(message);
        }

        close(connection) {
          connection.close();
        }

        onConnection(f) {
          this.wsServer.on('connection', (connection, req) => {
            f(connection, req.headers);
          });
        }

        onConnectionClose(connection, f) {
          connection.on('close', f);
        }
      }
      /* eslint-enable class-methods-use-this */

      beforeAll(() =>
        setup({
          transportMode: { server: CustomWebsocketServer, client: 'ws' },
        })
      );

      afterAll(teardown);

      ['/sockjs-node', '/sockjs-node?token=1'].forEach((socketPath) => {
        it(`does not forward the socket upgrade (${socketPath}) to the proxy`, () =>
          probe(socketPath).then(expectServedLocally));
      });

      it('forwards a non-socket upgrade (/not-hmr) to the proxy', () =>
        probe('/not-hmr').then((result) => {
          expect(result.forwarded).toBe(true);
        }));
    });

    // the proxy target refuses the upgrade: forwarding the dev server socket
    // would surface a proxy error and break the socket
    ['ws', 'sockjs'].forEach((transportMode) => {
      describe(`with transportMode: ${transportMode} and a target refusing upgrades`, () => {
        const socketPath =
          transportMode === 'ws' ? '/sockjs-node' : '/sockjs-node/websocket';

        beforeAll(() => setup({ transportMode }, true));

        afterAll(teardown);

        it('does not surface any [HPM] error when the socket client connects', () =>
          proxyRequest()
            .then(() => probe(socketPath))
            .then((result) => {
              expectServedLocally(result);
              expect(result.messages).toContain(liveReloadMessage);
              expect(
                proxyErrors.filter((message) => /\[HPM\]/.test(message))
              ).toEqual([]);
            }));
      });
    });
  });
});
