'use strict';

/* eslint-disable
  no-shadow,
  array-bracket-spacing
*/

const url = require('url');
const webpack = require('webpack');
const Server = require('../lib/Server');
const schema = require('../lib/options.json');
const config = require('./fixtures/simple-config/webpack.config');

const messages = schema.errorMessage.properties;

describe('Validation', () => {
  let compiler;
  let server;

  beforeAll(() => {
    compiler = webpack(config);
  });

  describe('validation', () => {
    afterEach((done) => {
      // `server` is undefined if a test is good
      if (server) {
        server.close(() => {
          done();
        });
      } else {
        done();
      }
    });

    const tests = [
      {
        name: 'invalid `hot` configuration',
        config: { hot: 'false' },
        message: `options.hot ${messages.hot}`,
      },
      {
        name: 'invalid `logLevel` configuration',
        config: { logLevel: 1 },
        message: `options.logLevel ${messages.logLevel.split('\n\n')[0]}`,
      },
      {
        name: 'invalid `writeToDisk` configuration',
        config: { writeToDisk: 1 },
        message: `options.writeToDisk ${messages.writeToDisk}`,
      },
      {
        name: 'invalid `overlay` configuration',
        config: { overlay: { errors: 1 } },
        message: `options.overlay ${messages.overlay}`,
      },
      {
        name: 'invalid `contentBase` configuration',
        config: { contentBase: [0] },
        message: `options.contentBase ${messages.contentBase}`,
      },
      {
        name: 'no additional properties',
        config: { additional: true },
        message: 'options should NOT have additional properties',
      },
    ];

    tests.forEach((test) => {
      it(`should fail validation for ${test.name}`, () => {
        try {
          server = new Server(compiler, test.config);
        } catch (err) {
          if (err.name !== 'ValidationError') {
            throw err;
          }

          const [title, message] = err.message.split('\n\n');

          expect(title).toEqual('webpack Dev Server Invalid Options');
          expect(message.trim()).toEqual(test.message);

          return;
        }

        throw new Error("Validation didn't fail");
      });
    });
  });

  describe('filename', () => {
    afterEach((done) => {
      server.close(() => {
        done();
      });
    });

    it('should allow filename to be a function', () => {
      try {
        server = new Server(compiler, { filename: () => {} });
      } catch (err) {
        if (err === 'ValidationError') {
          throw err;
        }

        throw new Error("Validation failed and it shouldn't");
      }
    });
  });

  describe('checkHost', () => {
    afterEach((done) => {
      server.close(() => {
        done();
      });
    });

    it('should always allow any host if options.disableHostCheck is set', () => {
      const options = {
        public: 'test.host:80',
        disableHostCheck: true,
      };

      const headers = {
        host: 'bad.host',
      };

      server = new Server(compiler, options);

      if (!server.checkHost(headers)) {
        throw new Error("Validation didn't fail");
      }
    });

    it('should allow any valid options.public when host is localhost', () => {
      const options = {
        public: 'test.host:80',
      };
      const headers = {
        host: 'localhost',
      };
      server = new Server(compiler, options);
      if (!server.checkHost(headers)) {
        throw new Error("Validation didn't fail");
      }
    });

    it('should allow any valid options.public when host is 127.0.0.1', () => {
      const options = {
        public: 'test.host:80',
      };

      const headers = {
        host: '127.0.0.1',
      };

      server = new Server(compiler, options);

      if (!server.checkHost(headers)) {
        throw new Error("Validation didn't fail");
      }
    });

    it('should allow access for every requests using an IP', () => {
      const options = {};

      const tests = [
        '192.168.1.123',
        '192.168.1.2:8080',
        '[::1]',
        '[::1]:8080',
        '[ad42::1de2:54c2:c2fa:1234]',
        '[ad42::1de2:54c2:c2fa:1234]:8080',
      ];

      server = new Server(compiler, options);

      tests.forEach((test) => {
        const headers = { host: test };

        if (!server.checkHost(headers)) {
          throw new Error("Validation didn't pass");
        }
      });
    });

    it("should not allow hostnames that don't match options.public", () => {
      const options = {
        public: 'test.host:80',
      };

      const headers = {
        host: 'test.hostname:80',
      };

      server = new Server(compiler, options);

      if (server.checkHost(headers)) {
        throw new Error("Validation didn't fail");
      }
    });

    it('should allow urls with scheme for checking origin', () => {
      const options = {
        public: 'test.host:80',
      };
      const headers = {
        origin: 'https://test.host',
      };
      server = new Server(compiler, options);
      if (!server.checkOrigin(headers)) {
        throw new Error("Validation didn't fail");
      }
    });

    describe('allowedHosts', () => {
      it('should allow hosts in allowedHosts', () => {
        const tests = ['test.host', 'test2.host', 'test3.host'];
        const options = { allowedHosts: tests };
        server = new Server(compiler, options);
        tests.forEach((test) => {
          const headers = { host: test };
          if (!server.checkHost(headers)) {
            throw new Error("Validation didn't fail");
          }
        });
      });

      it('should allow hosts that pass a wildcard in allowedHosts', () => {
        const options = { allowedHosts: ['.example.com'] };
        server = new Server(compiler, options);
        const tests = [
          'www.example.com',
          'subdomain.example.com',
          'example.com',
          'subsubcomain.subdomain.example.com',
          'example.com:80',
          'subdomain.example.com:80',
        ];
        tests.forEach((test) => {
          const headers = { host: test };
          if (!server.checkHost(headers)) {
            throw new Error("Validation didn't fail");
          }
        });
      });
    });
  });

  describe('checkOrigin', () => {
    afterEach((done) => {
      server.close(() => {
        done();
      });
    });

    it('should not allow origin headers containing an IP address that does not match the host header', () => {
      const options = {};

      const tests = [
        'http://192.168.1.1',
        'http://192.168.1.1/',
        'http://192.168.1.10:8080',
        'https://192.168.1.10:8443',
        'http://[ad42::1de2:54c2:c2fa:1234]',
        'http://[ad42::1de2:54c2:c2fa:1234]:8080',
      ];

      server = new Server(compiler, options);

      tests.forEach((test) => {
        const headers = { host: 'localhost:8080', origin: test };

        if (server.checkOrigin(headers)) {
          throw new Error(`Validation didn't fail for origin ${test}`);
        }
      });
    });

    it('should not allow origin headers containing an IP address that differs from an IP host header', () => {
      const options = {};

      const headers = {
        host: '127.0.0.1:8080',
        origin: 'http://192.168.1.1',
      };

      server = new Server(compiler, options);

      if (!server.checkHost(headers)) {
        throw new Error("Validation didn't pass");
      }

      if (server.checkOrigin(headers)) {
        throw new Error("Validation didn't fail");
      }
    });

    it('should not allow origin headers containing an IP address without a host header', () => {
      const options = {};

      const headers = {
        origin: 'http://192.168.1.1',
      };

      server = new Server(compiler, options);

      if (server.checkOrigin(headers)) {
        throw new Error("Validation didn't fail");
      }
    });

    it('should allow origin headers containing an IP address that matches the host header', () => {
      const options = {};

      const tests = [
        { host: '127.0.0.1:8080', origin: 'http://127.0.0.1:8080' },
        { host: '192.168.1.10:8080', origin: 'http://192.168.1.10:8080' },
        { host: '192.168.1.10', origin: 'https://192.168.1.10' },
        { host: '[::1]:8080', origin: 'http://[::1]:8080' },
        {
          host: '[ad42::1de2:54c2:c2fa:1234]:8080',
          origin: 'http://[ad42::1de2:54c2:c2fa:1234]:8080',
        },
      ];

      server = new Server(compiler, options);

      tests.forEach((headers) => {
        if (!server.checkHost(headers) || !server.checkOrigin(headers)) {
          throw new Error(`Validation didn't pass for origin ${headers.origin}`);
        }
      });
    });

    it('should allow origin headers containing an IP address listed in allowedHosts', () => {
      const options = { allowedHosts: ['192.168.1.10'] };

      const headers = {
        host: 'localhost:8080',
        origin: 'http://192.168.1.10:8080',
      };

      server = new Server(compiler, options);

      if (!server.checkOrigin(headers)) {
        throw new Error("Validation didn't pass");
      }
    });

    it('should allow origin headers containing an IP address matching options.public', () => {
      const options = { public: '192.168.1.10:8080' };

      const headers = {
        host: 'localhost:8080',
        origin: 'http://192.168.1.10:8080',
      };

      server = new Server(compiler, options);

      if (!server.checkOrigin(headers)) {
        throw new Error("Validation didn't pass");
      }
    });

    it('should allow localhost origin headers', () => {
      const options = {};

      const headers = {
        host: '127.0.0.1:8080',
        origin: 'http://localhost:8080',
      };

      server = new Server(compiler, options);

      if (!server.checkOrigin(headers)) {
        throw new Error("Validation didn't pass");
      }
    });

    it('should always allow any origin if options.disableHostCheck is set', () => {
      const options = {
        disableHostCheck: true,
      };

      const headers = {
        host: 'localhost:8080',
        origin: 'http://192.168.1.1',
      };

      server = new Server(compiler, options);

      if (!server.checkOrigin(headers)) {
        throw new Error("Validation didn't pass");
      }
    });
  });

  describe('checkHeaders without validateHost', () => {
    afterEach((done) => {
      server.close(() => {
        done();
      });
    });

    it('should not implicitly allow localhost, IP addresses or the listening hostname', () => {
      const options = {};

      const tests = [
        'localhost',
        'localhost:8080',
        '127.0.0.1',
        '127.0.0.1:8080',
        '192.168.1.10:8080',
        '[::1]',
        '[::1]:8080',
        'dev.host:8080',
      ];

      server = new Server(compiler, options);
      // hostname of the listening address
      server.hostname = 'dev.host';

      tests.forEach((test) => {
        const headers = { host: test };

        // the implicit host check still allows them
        if (!server.checkHeaders(headers, 'host', true)) {
          throw new Error(`Validation didn't pass for host ${test}`);
        }

        if (server.checkHeaders(headers, 'host', true, false)) {
          throw new Error(`Validation didn't fail for host ${test}`);
        }
      });
    });

    it('should allow hosts listed in allowedHosts', () => {
      const options = { allowedHosts: ['localhost', '.example.com'] };

      server = new Server(compiler, options);

      ['localhost:8080', 'example.com', 'www.example.com:8080'].forEach(
        (test) => {
          const headers = { host: test };

          if (!server.checkHeaders(headers, 'host', true, false)) {
            throw new Error(`Validation didn't pass for host ${test}`);
          }
        }
      );

      const headers = { host: '127.0.0.1:8080' };

      if (server.checkHeaders(headers, 'host', true, false)) {
        throw new Error("Validation didn't fail");
      }
    });

    it('should allow the hostname of options.public', () => {
      const options = { public: 'localhost:8080' };

      const headers = { host: 'localhost:8080' };

      server = new Server(compiler, options);

      if (!server.checkHeaders(headers, 'host', true, false)) {
        throw new Error("Validation didn't pass");
      }
    });

    it('should always allow any host if options.disableHostCheck is set', () => {
      const options = { disableHostCheck: true };

      const headers = { host: 'localhost:8080' };

      server = new Server(compiler, options);

      if (!server.checkHeaders(headers, 'host', true, false)) {
        throw new Error("Validation didn't pass");
      }
    });
  });

  describe('malformed Host/Origin headers', () => {
    afterEach((done) => {
      server.close(() => {
        done();
      });
    });

    // malformed values (invalid IPv6 literals)
    const malformedHosts = ['[::1', '[::1:8080', 'http://[::1/'];
    const malformedOrigins = ['http://[::1/', 'http://[::1', '[::1'];

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

        // a host the url-parser rejects is never trusted, a host it resolves
        // (to a bogus hostname) is checked as before, without throwing
        const expectHostCheck = (check) => {
          if (parser.throwOnMalformed) {
            expect(check()).toBe(false);
          } else {
            expect(check).not.toThrow();
          }
        };

        it('should handle malformed host headers', () => {
          server = new Server(compiler, {});

          malformedHosts.forEach((host) => {
            const headers = { host };

            expectHostCheck(() => server.checkHost(headers));
            expectHostCheck(() =>
              server.checkHeaders(headers, 'host', true, false)
            );
          });
        });

        it('should handle malformed host headers with allowedHosts and public', () => {
          server = new Server(compiler, {
            allowedHosts: ['.example.com', 'localhost'],
            public: 'test.host:80',
          });

          malformedHosts.forEach((host) => {
            const headers = { host };

            expectHostCheck(() => server.checkHost(headers));
            expectHostCheck(() =>
              server.checkHeaders(headers, 'host', true, false)
            );
          });
        });

        it('should not allow malformed origin headers', () => {
          server = new Server(compiler, {});

          malformedOrigins.forEach((origin) => {
            [
              { host: 'localhost:8080', origin },
              { host: '[::1', origin },
            ].forEach((headers) => {
              expect(server.isSameOrigin(headers)).toBe(false);
              expect(server.checkOrigin(headers)).toBe(false);
            });
          });
        });

        it('should not treat requests with a malformed origin header as same-origin requests', () => {
          server = new Server(compiler, {});

          malformedOrigins.forEach((origin) => {
            const req = { headers: { host: 'localhost:8080', origin } };

            expect(server.isSameOriginRequest(req)).toBe(false);
          });
        });

        it('should still allow valid host and origin headers', () => {
          server = new Server(compiler, {});

          [
            { host: 'localhost:8080', origin: 'http://localhost:8080' },
            { host: '[::1]:8080', origin: 'http://[::1]:8080' },
          ].forEach((headers) => {
            expect(server.checkHost(headers)).toBe(true);
            expect(server.checkOrigin(headers)).toBe(true);
            expect(server.isSameOriginRequest({ headers })).toBe(true);
          });
        });
      });
    });

    // a scheme without a host (e.g. `javascript:`) resolves no hostname at all
    it('should not allow host and origin headers without a hostname', () => {
      server = new Server(compiler, {
        allowedHosts: ['.example.com'],
        public: 'test.host:80',
      });

      ['javascript://evil.example.com', 'javascript://localhost'].forEach(
        (value) => {
          expect(server.checkHost({ host: value })).toBe(false);
          expect(
            server.checkHeaders({ host: value }, 'host', true, false)
          ).toBe(false);
          expect(
            server.checkOrigin({ host: 'localhost:8080', origin: value })
          ).toBe(false);
        }
      );
    });
  });
});
