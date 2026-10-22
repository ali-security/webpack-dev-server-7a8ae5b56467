'use strict';

/* eslint-disable
  no-shadow,
  array-bracket-spacing
*/

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
});
