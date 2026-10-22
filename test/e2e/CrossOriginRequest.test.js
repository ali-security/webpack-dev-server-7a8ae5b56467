'use strict';

const http = require('http');
const testServer = require('../helpers/test-server');
const config = require('../fixtures/client-config/webpack.config');
const runBrowser = require('../helpers/run-browser');
const [port1, port2] = require('../ports-map').CrossOriginRequest;

describe('cross-origin requests', () => {
  const devServerPort = port1;
  const htmlServerPort = port2;
  const htmlServerHost = '127.0.0.1';

  const cases = [
    {
      title:
        'should return 403 for cross-origin no-cors non-module script tag requests',
      options: {},
      scriptAttributes: '',
      expectedStatus: 403,
    },
    {
      title:
        'should return 200 for cross-origin cors non-module script tag requests',
      options: {
        headers: {
          'Access-Control-Allow-Origin': '*',
        },
      },
      scriptAttributes: ' crossorigin',
      expectedStatus: 200,
    },
    {
      title:
        "should return 200 for cross-origin no-cors non-module script tag requests with the 'disableHostCheck' option",
      options: {
        disableHostCheck: true,
      },
      scriptAttributes: '',
      expectedStatus: 200,
    },
    {
      title:
        "should return 200 for cross-origin no-cors non-module script tag requests with the 'allowedHosts' option and the 'localhost' value",
      options: {
        allowedHosts: ['localhost'],
      },
      scriptAttributes: '',
      expectedStatus: 200,
    },
  ];

  cases.forEach(({ title, options, scriptAttributes, expectedStatus }) => {
    describe(title, () => {
      let htmlServer;

      beforeAll((done) => {
        testServer.startAwaitingCompilation(
          config,
          Object.assign({ port: devServerPort }, options),
          done
        );
      });

      // Start a separate server for serving the HTML file
      beforeAll((done) => {
        htmlServer = http.createServer((req, res) => {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(`
            <html>
              <head>
                <script src="http://localhost:${devServerPort}/main.js"${scriptAttributes}></script>
              </head>
              <body></body>
            </html>
          `);
        });
        htmlServer.listen(htmlServerPort, htmlServerHost, done);
      });

      afterAll((done) => {
        htmlServer.close(() => {
          done();
        });
      });

      afterAll(testServer.close);

      it(title, () =>
        runBrowser().then(({ page, browser }) => {
          const scriptTagRequest = page.waitForResponse(
            `http://localhost:${devServerPort}/main.js`
          );

          return page
            .goto(`http://${htmlServerHost}:${htmlServerPort}`)
            .then(() => scriptTagRequest)
            .then(
              (response) =>
                browser.close().then(() => {
                  expect(response.status()).toBe(expectedStatus);
                }),
              (error) =>
                browser.close().then(() => {
                  throw error;
                })
            );
        }));
    });
  });
});
