'use strict';

const request = require('supertest');
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
