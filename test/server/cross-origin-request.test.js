'use strict';

const http = require('http');
const net = require('net');
const url = require('url');
const request = require('supertest');
const WebSocket = require('ws');
const testServer = require('../helpers/test-server');
const config = require('../fixtures/simple-config/webpack.config');
const port = require('../ports-map')['cross-origin-request'];

// Fetch metadata headers a browser sends when a page from another site loads
// the bundle with a classic `<script src="...">` tag (no `crossorigin` attribute).
const crossSiteNoCorsHeaders = {
  'Sec-Fetch-Mode': 'no-cors',
  'Sec-Fetch-Site': 'cross-site',
  'Sec-Fetch-Dest': 'script',
};

describe('cross-origin requests', () => {
  describe('with default options', () => {
    beforeAll((done) => {
      testServer.start(config, { port }, done);
    });

    afterAll(testServer.close);

    [`http://localhost:${port}`, `http://127.0.0.1:${port}`].forEach(
      (origin) => {
        it(`should return 403 for cross-origin no-cors non-module script tag requests (${origin})`, (done) => {
          request(origin)
            .get('/main.js')
            .set(crossSiteNoCorsHeaders)
            .buffer(true)
            .expect(403)
            .expect((res) => {
              expect(res.text).toEqual('Cross-Origin request blocked');
              expect(res.text).not.toContain('Hey.');
            })
            .end(done);
        });
      }
    );

    it('should return 200 for same-origin no-cors script tag requests', (done) => {
      request(`http://localhost:${port}`)
        .get('/main.js')
        .set({
          'Sec-Fetch-Mode': 'no-cors',
          'Sec-Fetch-Site': 'same-origin',
          'Sec-Fetch-Dest': 'script',
        })
        .buffer(true)
        .expect(200)
        .expect((res) => {
          expect(res.text).toContain('Hey.');
        })
        .end(done);
    });

    it('should return 200 for cross-site navigation requests', (done) => {
      request(`http://localhost:${port}`)
        .get('/main.js')
        .set({
          'Sec-Fetch-Mode': 'navigate',
          'Sec-Fetch-Site': 'cross-site',
          'Sec-Fetch-Dest': 'document',
        })
        .expect(200, done);
    });

    it('should return 200 for requests without fetch metadata headers', (done) => {
      request(`http://localhost:${port}`)
        .get('/main.js')
        .buffer(true)
        .expect(200)
        .expect((res) => {
          expect(res.text).toContain('Hey.');
        })
        .end(done);
    });

    // @see https://github.com/webpack/webpack-dev-server/security/advisories/GHSA-79cf-xcqc-c78w
    // browsers do not send fetch metadata headers to non-HTTPS origins, so the
    // `Cross-Origin-Resource-Policy` header must make the browser block the
    // cross-origin `<script src="...">` load instead
    [`http://localhost:${port}`, `http://127.0.0.1:${port}`].forEach(
      (origin) => {
        it(`should set the 'Cross-Origin-Resource-Policy: same-origin' header for requests without fetch metadata headers (${origin})`, (done) => {
          request(origin)
            .get('/main.js')
            .expect('Cross-Origin-Resource-Policy', 'same-origin')
            .expect(200, done);
        });
      }
    );

    it("should set the 'Cross-Origin-Resource-Policy: same-origin' header for same-origin no-cors script tag requests", (done) => {
      request(`http://localhost:${port}`)
        .get('/main.js')
        .set({
          'Sec-Fetch-Mode': 'no-cors',
          'Sec-Fetch-Site': 'same-origin',
          'Sec-Fetch-Dest': 'script',
        })
        .expect('Cross-Origin-Resource-Policy', 'same-origin')
        .expect(200, done);
    });
  });

  describe("with the 'headers' option allowing any origin", () => {
    beforeAll((done) => {
      testServer.start(
        config,
        {
          port,
          headers: {
            'Access-Control-Allow-Origin': '*',
          },
        },
        done
      );
    });

    afterAll(testServer.close);

    it('should return 200 for cross-origin cors non-module script tag requests', (done) => {
      request(`http://localhost:${port}`)
        .get('/main.js')
        .set({
          Origin: 'http://127.0.0.1:8080',
          'Sec-Fetch-Mode': 'cors',
          'Sec-Fetch-Site': 'cross-site',
          'Sec-Fetch-Dest': 'script',
        })
        .expect('Access-Control-Allow-Origin', '*')
        .expect(200, done);
    });

    it('should still return 403 for cross-origin no-cors non-module script tag requests', (done) => {
      request(`http://localhost:${port}`)
        .get('/main.js')
        .set(crossSiteNoCorsHeaders)
        .expect(403, done);
    });

    it("should not set the 'Cross-Origin-Resource-Policy' header", (done) => {
      request(`http://localhost:${port}`)
        .get('/main.js')
        .expect('Access-Control-Allow-Origin', '*')
        .expect(200)
        .expect((res) => {
          expect(res.headers['cross-origin-resource-policy']).toBeUndefined();
        })
        .end(done);
    });
  });

  describe("with the 'headers' option allowing any origin as an array value", () => {
    beforeAll((done) => {
      testServer.start(
        config,
        {
          port,
          headers: {
            'access-control-allow-origin': ['*'],
          },
        },
        done
      );
    });

    afterAll(testServer.close);

    it("should not set the 'Cross-Origin-Resource-Policy' header", (done) => {
      request(`http://localhost:${port}`)
        .get('/main.js')
        .expect('Access-Control-Allow-Origin', '*')
        .expect(200)
        .expect((res) => {
          expect(res.headers['cross-origin-resource-policy']).toBeUndefined();
        })
        .end(done);
    });
  });

  // no-cors embedding is not governed by CORS, so a specific origin must not
  // disable the `Cross-Origin-Resource-Policy` header
  describe("with the 'headers' option allowing a specific origin", () => {
    beforeAll((done) => {
      testServer.start(
        config,
        {
          port,
          headers: {
            'Access-Control-Allow-Origin': 'http://foo.example.com',
          },
        },
        done
      );
    });

    afterAll(testServer.close);

    it("should set the 'Cross-Origin-Resource-Policy: same-origin' header", (done) => {
      request(`http://localhost:${port}`)
        .get('/main.js')
        .expect('Access-Control-Allow-Origin', 'http://foo.example.com')
        .expect('Cross-Origin-Resource-Policy', 'same-origin')
        .expect(200, done);
    });
  });

  describe("with the 'headers' option allowing a specific origin as an array value", () => {
    beforeAll((done) => {
      testServer.start(
        config,
        {
          port,
          headers: {
            'Access-Control-Allow-Origin': ['http://foo.example.com'],
          },
        },
        done
      );
    });

    afterAll(testServer.close);

    it("should set the 'Cross-Origin-Resource-Policy: same-origin' header", (done) => {
      request(`http://localhost:${port}`)
        .get('/main.js')
        .expect('Access-Control-Allow-Origin', 'http://foo.example.com')
        .expect('Cross-Origin-Resource-Policy', 'same-origin')
        .expect(200, done);
    });
  });

  describe("with the 'disableHostCheck' option", () => {
    beforeAll((done) => {
      testServer.start(
        config,
        {
          port,
          disableHostCheck: true,
        },
        done
      );
    });

    afterAll(testServer.close);

    it('should return 200 for cross-origin no-cors non-module script tag requests', (done) => {
      request(`http://localhost:${port}`)
        .get('/main.js')
        .set(crossSiteNoCorsHeaders)
        .expect(200, done);
    });

    it("should not set the 'Cross-Origin-Resource-Policy' header", (done) => {
      request(`http://localhost:${port}`)
        .get('/main.js')
        .expect(200)
        .expect((res) => {
          expect(res.headers['cross-origin-resource-policy']).toBeUndefined();
        })
        .end(done);
    });
  });

  describe("with the 'allowedHosts' option and the 'localhost' value", () => {
    beforeAll((done) => {
      testServer.start(
        config,
        {
          port,
          allowedHosts: ['localhost'],
        },
        done
      );
    });

    afterAll(testServer.close);

    it('should return 200 for cross-origin no-cors non-module script tag requests', (done) => {
      request(`http://localhost:${port}`)
        .get('/main.js')
        .set(crossSiteNoCorsHeaders)
        .buffer(true)
        .expect(200)
        .expect((res) => {
          expect(res.text).toContain('Hey.');
        })
        .end(done);
    });

    it('should return 403 for cross-origin no-cors non-module script tag requests to a host not listed', (done) => {
      request(`http://127.0.0.1:${port}`)
        .get('/main.js')
        .set(crossSiteNoCorsHeaders)
        .expect(403, done);
    });

    it("should not set the 'Cross-Origin-Resource-Policy' header for a listed host", (done) => {
      request(`http://localhost:${port}`)
        .get('/main.js')
        .expect(200)
        .expect((res) => {
          expect(res.headers['cross-origin-resource-policy']).toBeUndefined();
        })
        .end(done);
    });

    it("should set the 'Cross-Origin-Resource-Policy: same-origin' header for a host not listed", (done) => {
      request(`http://127.0.0.1:${port}`)
        .get('/main.js')
        .expect('Cross-Origin-Resource-Policy', 'same-origin')
        .expect(200, done);
    });
  });

  describe("with the 'public' option", () => {
    beforeAll((done) => {
      testServer.start(
        config,
        {
          port,
          public: `localhost:${port}`,
        },
        done
      );
    });

    afterAll(testServer.close);

    it('should return 200 for cross-origin no-cors non-module script tag requests to the public host', (done) => {
      request(`http://localhost:${port}`)
        .get('/main.js')
        .set(crossSiteNoCorsHeaders)
        .expect(200, done);
    });

    it("should not set the 'Cross-Origin-Resource-Policy' header for the public host", (done) => {
      request(`http://localhost:${port}`)
        .get('/main.js')
        .expect(200)
        .expect((res) => {
          expect(res.headers['cross-origin-resource-policy']).toBeUndefined();
        })
        .end(done);
    });
  });
});

describe('cross-site request forgery on state-changing endpoints', () => {
  const endpoint = '/webpack-dev-server/invalidate';

  let server;
  let invalidateSpy;

  describe('with default options', () => {
    beforeAll((done) => {
      server = testServer.start(config, { port }, done);
    });

    afterAll(testServer.close);

    beforeEach(() => {
      invalidateSpy = jest.spyOn(server, 'invalidate');
    });

    afterEach(() => {
      invalidateSpy.mockRestore();
    });

    it(`should block cross-site requests to ${endpoint}`, (done) => {
      request(`http://localhost:${port}`)
        .get(endpoint)
        .set({
          'Sec-Fetch-Mode': 'cors',
          'Sec-Fetch-Site': 'cross-site',
        })
        .expect(403)
        .expect((res) => {
          expect(res.text).toEqual('Cross-Origin request blocked');
          expect(invalidateSpy).not.toHaveBeenCalled();
        })
        .end(done);
    });

    it(`should block cross-site navigations to ${endpoint}`, (done) => {
      request(`http://localhost:${port}`)
        .get(endpoint)
        .set({
          'Sec-Fetch-Mode': 'navigate',
          'Sec-Fetch-Site': 'cross-site',
          'Sec-Fetch-Dest': 'document',
        })
        .expect(403)
        .expect(() => {
          expect(invalidateSpy).not.toHaveBeenCalled();
        })
        .end(done);
    });

    it(`should block same-site (other port) requests to ${endpoint}`, (done) => {
      request(`http://localhost:${port}`)
        .get(endpoint)
        .set({
          Origin: 'http://localhost:3000',
          'Sec-Fetch-Mode': 'cors',
          'Sec-Fetch-Site': 'same-site',
        })
        .expect(403)
        .expect(() => {
          expect(invalidateSpy).not.toHaveBeenCalled();
        })
        .end(done);
    });

    it(`should allow same-origin requests to ${endpoint}`, (done) => {
      request(`http://localhost:${port}`)
        .get(endpoint)
        .set({
          'Sec-Fetch-Mode': 'cors',
          'Sec-Fetch-Site': 'same-origin',
        })
        .expect(200)
        .expect(() => {
          expect(invalidateSpy).toHaveBeenCalledTimes(1);
        })
        .end(done);
    });

    it(`should allow user-initiated navigations to ${endpoint}`, (done) => {
      request(`http://localhost:${port}`)
        .get(endpoint)
        .set({ 'Sec-Fetch-Site': 'none' })
        .expect(200)
        .expect(() => {
          expect(invalidateSpy).toHaveBeenCalledTimes(1);
        })
        .end(done);
    });

    it('should block requests with a cross-origin Origin and no Sec-Fetch metadata', (done) => {
      request(`http://localhost:${port}`)
        .get(endpoint)
        .set({ Origin: 'http://evil.example' })
        .expect(403)
        .expect((res) => {
          expect(res.text).toEqual('Cross-Origin request blocked');
          expect(invalidateSpy).not.toHaveBeenCalled();
        })
        .end(done);
    });

    it('should allow requests with a same-origin Origin and no Sec-Fetch metadata', (done) => {
      request(`http://localhost:${port}`)
        .get(endpoint)
        .set({ Origin: `http://localhost:${port}` })
        .expect(200)
        .expect(() => {
          expect(invalidateSpy).toHaveBeenCalledTimes(1);
        })
        .end(done);
    });

    it('should allow requests without Sec-Fetch metadata or Origin (e.g. curl)', (done) => {
      request(`http://localhost:${port}`)
        .get(endpoint)
        .expect(200)
        .expect(() => {
          expect(invalidateSpy).toHaveBeenCalledTimes(1);
        })
        .end(done);
    });
  });

  // a listed host is trusted by the `no-cors` script-tag check, so the
  // state-changing endpoint must still reject cross-site requests on its own
  describe("with the 'allowedHosts' option and the 'localhost' value", () => {
    beforeAll((done) => {
      server = testServer.start(
        config,
        {
          port,
          allowedHosts: ['localhost'],
        },
        done
      );
    });

    afterAll(testServer.close);

    beforeEach(() => {
      invalidateSpy = jest.spyOn(server, 'invalidate');
    });

    afterEach(() => {
      invalidateSpy.mockRestore();
    });

    it(`should block cross-site no-cors requests to ${endpoint}`, (done) => {
      request(`http://localhost:${port}`)
        .get(endpoint)
        .set({
          'Sec-Fetch-Mode': 'no-cors',
          'Sec-Fetch-Site': 'cross-site',
          'Sec-Fetch-Dest': 'image',
        })
        .expect(403)
        .expect(() => {
          expect(invalidateSpy).not.toHaveBeenCalled();
        })
        .end(done);
    });

    it(`should allow same-origin requests to ${endpoint}`, (done) => {
      request(`http://localhost:${port}`)
        .get(endpoint)
        .set({
          'Sec-Fetch-Mode': 'cors',
          'Sec-Fetch-Site': 'same-origin',
        })
        .expect(200)
        .expect(() => {
          expect(invalidateSpy).toHaveBeenCalledTimes(1);
        })
        .end(done);
    });
  });
});

describe('malformed Host/Origin headers', () => {
  const invalidHeaderMessage = JSON.stringify({
    type: 'error',
    data: 'Invalid Host/Origin header',
  });

  // invalid IPv6 literals
  const malformedOrigin = 'http://[::1/';
  const malformedHost = '[::1';

  const transportModes = [
    {
      title: 'sockjs',
      transportMode: 'sockjs',
      // raw websocket endpoint of the sockjs server
      socketPath: '/sockjs-node/websocket',
    },
    {
      title: 'ws',
      transportMode: 'ws',
      socketPath: '/sockjs-node',
    },
  ];

  // resolves with the received events once the server closes the WebSocket
  // connection, or after a delay if the connection stays open
  const connectWebSocket = (socketPath, origin) =>
    new Promise((resolve) => {
      const data = [];
      let finished = false;
      const client = new WebSocket(`ws://localhost:${port}${socketPath}`, {
        origin,
      });

      const finish = () => {
        if (finished) {
          return;
        }

        finished = true;
        client.terminate();
        resolve(data);
      };

      client.on('open', () => {
        data.push('open');
      });

      client.on('message', (message) => {
        data.push(message);
      });

      client.on('close', () => {
        data.push('close');
        finish();
      });

      client.on('error', () => {
        data.push('error');
        finish();
      });

      setTimeout(finish, 5000);
    });

  // sent over a raw socket so the malformed `Host` reaches the server as-is,
  // resolves with the raw response
  const sendRawRequest = (host) =>
    new Promise((resolve) => {
      let response = '';
      const socket = net.connect(port, 'localhost', () => {
        socket.write(
          [
            'GET /main.js HTTP/1.1',
            `Host: ${host}`,
            'Connection: close',
            '',
            '',
          ].join('\r\n')
        );
      });

      socket.setEncoding('utf8');
      socket.on('data', (chunk) => {
        response += chunk;
      });
      socket.on('close', () => resolve(response));
      socket.on('error', () => resolve(response));
    });

  // the server must still be alive: a normal request still succeeds
  const getBundleStatus = () =>
    new Promise((resolve, reject) => {
      http
        .get({ host: 'localhost', port, path: '/main.js' }, (res) => {
          res.resume();
          resolve(res.statusCode);
        })
        .on('error', reject);
    });

  [
    {
      title: 'as parsed by url.parse()',
      throwOnMalformed: false,
    },
    {
      // `url.parse()` throws on an invalid IPv6 literal on Node.js >= 18,
      // older versions resolve a bogus hostname instead
      title: 'when url.parse() throws on them (as on Node.js >= 18)',
      throwOnMalformed: true,
    },
  ].forEach((parser) => {
    describe(parser.title, () => {
      let parseSpy;

      beforeEach(() => {
        if (parser.throwOnMalformed) {
          const parse = url.parse;

          parseSpy = jest
            .spyOn(url, 'parse')
            .mockImplementation((input, ...args) => {
              if (typeof input === 'string' && /\[[^\]]*$/.test(input)) {
                const error = new TypeError(`Invalid URL: ${input}`);

                error.code = 'ERR_INVALID_URL';

                throw error;
              }

              return parse.call(url, input, ...args);
            });
        }
      });

      afterEach(() => {
        if (parseSpy) {
          parseSpy.mockRestore();
          parseSpy = null;
        }
      });

      transportModes.forEach((mode) => {
        describe(`with the "${mode.title}" transport mode`, () => {
          beforeEach((done) => {
            testServer.start(
              config,
              { port, transportMode: mode.transportMode },
              done
            );
          });

          afterEach(testServer.close);

          it('should reject a WebSocket connection with a malformed Origin header without crashing', () =>
            connectWebSocket(mode.socketPath, malformedOrigin)
              .then((data) => {
                expect(data).toContain(invalidHeaderMessage);
                expect(data).toContain('close');

                return getBundleStatus();
              })
              .then((status) => {
                expect(status).toBe(200);
              }));
        });
      });

      describe('with default options', () => {
        let server;
        let invalidateSpy;

        beforeEach((done) => {
          server = testServer.start(config, { port }, done);
          invalidateSpy = jest.spyOn(server, 'invalidate');
        });

        afterEach((done) => {
          invalidateSpy.mockRestore();
          testServer.close(done);
        });

        it('should handle a request with a malformed Host header without crashing', () =>
          sendRawRequest(malformedHost)
            .then((response) => {
              // answered, not a server error
              expect(response).toMatch(/^HTTP\/1\.1 200 /);

              // a host the url-parser rejects is never trusted
              if (parser.throwOnMalformed) {
                expect(response).toContain('Invalid Host header');
                expect(response).not.toContain('Hey.');
              }

              return getBundleStatus();
            })
            .then((status) => {
              expect(status).toBe(200);
            }));

        it('should block requests to /webpack-dev-server/invalidate with a malformed Origin header', (done) => {
          request(`http://localhost:${port}`)
            .get('/webpack-dev-server/invalidate')
            .set({ Origin: malformedOrigin })
            .expect(403)
            .expect((res) => {
              expect(res.text).toEqual('Cross-Origin request blocked');
              expect(invalidateSpy).not.toHaveBeenCalled();
            })
            .end(done);
        });
      });
    });
  });

  // a scheme without a host (e.g. `javascript:`) resolves no hostname at all,
  // which must not break the `allowedHosts` subdomain wildcard matching
  describe("with a hostless scheme and the 'allowedHosts' option with a subdomain wildcard", () => {
    const hostlessValue = 'javascript://evil.example.com';

    transportModes.forEach((mode) => {
      describe(`with the "${mode.title}" transport mode`, () => {
        beforeEach((done) => {
          testServer.start(
            config,
            {
              port,
              allowedHosts: ['.example.com'],
              transportMode: mode.transportMode,
            },
            done
          );
        });

        afterEach(testServer.close);

        it('should reject a WebSocket connection with a hostless Origin header without crashing', () =>
          connectWebSocket(mode.socketPath, hostlessValue)
            .then((data) => {
              expect(data).toContain(invalidHeaderMessage);
              expect(data).toContain('close');

              return getBundleStatus();
            })
            .then((status) => {
              expect(status).toBe(200);
            }));
      });
    });

    describe('with a plain request', () => {
      beforeEach((done) => {
        testServer.start(
          config,
          { port, allowedHosts: ['.example.com'] },
          done
        );
      });

      afterEach(testServer.close);

      it('should reject a request with a hostless Host header without crashing', () =>
        sendRawRequest(hostlessValue)
          .then((response) => {
            expect(response).toMatch(/^HTTP\/1\.1 200 /);
            expect(response).toContain('Invalid Host header');
            expect(response).not.toContain('Hey.');

            return getBundleStatus();
          })
          .then((status) => {
            expect(status).toBe(200);
          }));
    });
  });
});
