'use strict';

/* eslint-disable
  no-shadow,
  no-undefined,
  func-names
*/
const fs = require('fs');
const path = require('path');
const tls = require('tls');
const url = require('url');
const http = require('http');
const https = require('https');
const ip = require('ip');
const semver = require('semver');
const killable = require('killable');
const chokidar = require('chokidar');
const express = require('express');
const httpProxyMiddleware = require('http-proxy-middleware');
const historyApiFallback = require('connect-history-api-fallback');
const compress = require('compression');
const serveIndex = require('serve-index');
const webpack = require('webpack');
const webpackDevMiddleware = require('webpack-dev-middleware');
const validateOptions = require('schema-utils');
const isAbsoluteUrl = require('is-absolute-url');
const normalizeOptions = require('./utils/normalizeOptions');
const updateCompiler = require('./utils/updateCompiler');
const createLogger = require('./utils/createLogger');
const getCertificate = require('./utils/getCertificate');
const status = require('./utils/status');
const createDomain = require('./utils/createDomain');
const runBonjour = require('./utils/runBonjour');
const routes = require('./utils/routes');
const getSocketServerImplementation = require('./utils/getSocketServerImplementation');
const WebsocketServer = require('./servers/WebsocketServer');
const schema = require('./options.json');

// Workaround for node ^8.6.0, ^9.0.0
// DEFAULT_ECDH_CURVE is default to prime256v1 in these version
// breaking connection when certificate is not signed with prime256v1
// change it to auto allows OpenSSL to select the curve automatically
// See https://github.com/nodejs/node/issues/16196 for more information
if (semver.satisfies(process.version, '8.6.0 - 9')) {
  tls.DEFAULT_ECDH_CURVE = 'auto';
}

if (!process.env.WEBPACK_DEV_SERVER) {
  process.env.WEBPACK_DEV_SERVER = true;
}

class Server {
  constructor(compiler, options = {}, _log) {
    if (options.lazy && !options.filename) {
      throw new Error("'filename' option must be set in lazy mode.");
    }

    validateOptions(schema, options, 'webpack Dev Server');

    this.compiler = compiler;
    this.options = options;

    this.log = _log || createLogger(options);

    if (this.options.transportMode !== undefined) {
      this.log.warn(
        'transportMode is an experimental option, meaning its usage could potentially change without warning'
      );
    }

    normalizeOptions(this.compiler, this.options);

    updateCompiler(this.compiler, this.options);

    this.heartbeatInterval = 30000;
    // this.SocketServerImplementation is a class, so it must be instantiated before use
    this.socketServerImplementation = getSocketServerImplementation(
      this.options
    );

    this.originalStats =
      this.options.stats && Object.keys(this.options.stats).length
        ? this.options.stats
        : {};

    this.sockets = [];
    this.contentBaseWatchers = [];

    // TODO this.<property> is deprecated (remove them in next major release.) in favor this.options.<property>
    this.hot = this.options.hot || this.options.hotOnly;
    this.headers = this.options.headers;
    this.progress = this.options.progress;

    this.serveIndex = this.options.serveIndex;

    this.clientOverlay = this.options.overlay;
    this.clientLogLevel = this.options.clientLogLevel;

    this.publicHost = this.options.public;
    this.allowedHosts = this.options.allowedHosts;
    this.disableHostCheck = !!this.options.disableHostCheck;

    this.watchOptions = options.watchOptions || {};

    // Replace leading and trailing slashes to normalize path
    this.sockPath = `/${
      this.options.sockPath
        ? this.options.sockPath.replace(/^\/|\/$/g, '')
        : 'sockjs-node'
    }`;

    if (this.progress) {
      this.setupProgressPlugin();
    }

    this.setupHooks();
    this.setupApp();
    this.setupCheckHostRoute();
    this.setupCrossOriginHeaderCheck();
    this.setupDevMiddleware();

    // set express routes
    routes(this);

    // Keep track of websocket proxies for external websocket upgrade.
    this.websocketProxies = [];

    this.setupFeatures();
    this.setupHttps();
    this.createServer();

    killable(this.listeningApp);

    // Proxy websockets without the initial http request
    // https://github.com/chimurai/http-proxy-middleware#external-websocket-upgrade
    this.websocketProxies.forEach(function(wsProxy) {
      const proxyUpgrade = wsProxy.upgrade;

      this.listeningApp.on('upgrade', (req, socket, head) => {
        // The upgrade of the dev server's own socket (HMR / live reload) is
        // handled by the socket server and must never reach a user proxy
        if (this.isSocketServerUpgrade(req)) {
          return;
        }

        proxyUpgrade(req, socket, head);
      });
    }, this);
  }

  setupProgressPlugin() {
    // for CLI output
    new webpack.ProgressPlugin({
      profile: !!this.options.profile,
    }).apply(this.compiler);

    // for browser console output
    new webpack.ProgressPlugin((percent, msg, addInfo) => {
      percent = Math.floor(percent * 100);

      if (percent === 100) {
        msg = 'Compilation completed';
      }

      if (addInfo) {
        msg = `${msg} (${addInfo})`;
      }

      this.sockWrite(this.sockets, 'progress-update', { percent, msg });

      if (this.listeningApp) {
        this.listeningApp.emit('progress-update', { percent, msg });
      }
    }).apply(this.compiler);
  }

  setupApp() {
    // Init express server
    // eslint-disable-next-line new-cap
    this.app = new express();
  }

  setupHooks() {
    // Listening for events
    const invalidPlugin = () => {
      this.sockWrite(this.sockets, 'invalid');
    };

    const addHooks = (compiler) => {
      const { compile, invalid, done } = compiler.hooks;

      compile.tap('webpack-dev-server', invalidPlugin);
      invalid.tap('webpack-dev-server', invalidPlugin);
      done.tap('webpack-dev-server', (stats) => {
        this._sendStats(this.sockets, this.getStats(stats));
        this._stats = stats;
      });
    };

    if (this.compiler.compilers) {
      this.compiler.compilers.forEach(addHooks);
    } else {
      addHooks(this.compiler);
    }
  }

  setupCheckHostRoute() {
    this.app.all('*', (req, res, next) => {
      if (this.checkHost(req.headers)) {
        return next();
      }

      res.send('Invalid Host header');
    });
  }

  // Register setup cross origin request check for security
  setupCrossOriginHeaderCheck() {
    this.app.all('*', (req, res, next) => {
      const headers = req.headers;

      if (this.checkHeaders(headers, 'host', true, false)) {
        return next();
      }

      if (
        headers['sec-fetch-mode'] === 'no-cors' &&
        headers['sec-fetch-site'] === 'cross-site'
      ) {
        res.statusCode = 403;
        res.end('Cross-Origin request blocked');
        return;
      }

      // Block cross-origin resource loading when Sec-Fetch-* headers are absent (HTTP origins)
      if (!this.disableHostCheck && !this.isUserCORSWildcardEnabled()) {
        res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
      }

      next();
    });
  }

  setupDevMiddleware() {
    // middleware for serving webpack bundle
    this.middleware = webpackDevMiddleware(
      this.compiler,
      Object.assign({}, this.options, { logLevel: this.log.options.level })
    );
  }

  setupCompressFeature() {
    this.app.use(compress());
  }

  setupProxyFeature() {
    /**
     * Assume a proxy configuration specified as:
     * proxy: {
     *   'context': { options }
     * }
     * OR
     * proxy: {
     *   'context': 'target'
     * }
     */
    if (!Array.isArray(this.options.proxy)) {
      if (Object.prototype.hasOwnProperty.call(this.options.proxy, 'target')) {
        this.options.proxy = [this.options.proxy];
      } else {
        this.options.proxy = Object.keys(this.options.proxy).map((context) => {
          let proxyOptions;
          // For backwards compatibility reasons.
          const correctedContext = context
            .replace(/^\*$/, '**')
            .replace(/\/\*$/, '');

          if (typeof this.options.proxy[context] === 'string') {
            proxyOptions = {
              context: correctedContext,
              target: this.options.proxy[context],
            };
          } else {
            proxyOptions = Object.assign({}, this.options.proxy[context]);
            proxyOptions.context = correctedContext;
          }

          proxyOptions.logLevel = proxyOptions.logLevel || 'warn';

          return proxyOptions;
        });
      }
    }

    const getProxyMiddleware = (proxyConfig) => {
      const context = proxyConfig.context || proxyConfig.path;

      // It is possible to use the `bypass` method without a `target`.
      // However, the proxy middleware has no use in this case, and will fail to instantiate.
      if (proxyConfig.target) {
        // Websocket upgrades are dispatched through `this.websocketProxies`
        // only, which never forwards the dev server's own socket. With
        // `ws: true` the proxy middleware would subscribe itself to the server
        // "upgrade" event on the first request it sees and forward every
        // upgrade, including the dev server's own socket.
        return httpProxyMiddleware(
          context,
          Object.assign({}, proxyConfig, { ws: false })
        );
      }
    };
    /**
     * Assume a proxy configuration specified as:
     * proxy: [
     *   {
     *     context: ...,
     *     ...options...
     *   },
     *   // or:
     *   function() {
     *     return {
     *       context: ...,
     *       ...options...
     *     };
     *   }
     * ]
     */
    this.options.proxy.forEach((proxyConfigOrCallback) => {
      let proxyMiddleware;

      let proxyConfig =
        typeof proxyConfigOrCallback === 'function'
          ? proxyConfigOrCallback()
          : proxyConfigOrCallback;

      proxyMiddleware = getProxyMiddleware(proxyConfig);

      if (proxyConfig.ws) {
        this.websocketProxies.push(proxyMiddleware);
      }

      const handle = (req, res, next) => {
        if (typeof proxyConfigOrCallback === 'function') {
          const newProxyConfig = proxyConfigOrCallback();

          if (newProxyConfig !== proxyConfig) {
            proxyConfig = newProxyConfig;
            proxyMiddleware = getProxyMiddleware(proxyConfig);
          }
        }

        // - Check if we have a bypass function defined
        // - In case the bypass function is defined we'll retrieve the
        // bypassUrl from it otherwise bypassUrl would be null
        const isByPassFuncDefined = typeof proxyConfig.bypass === 'function';
        const bypassUrl = isByPassFuncDefined
          ? proxyConfig.bypass(req, res, proxyConfig)
          : null;

        if (typeof bypassUrl === 'boolean') {
          // skip the proxy
          req.url = null;
          next();
        } else if (typeof bypassUrl === 'string') {
          // byPass to that url
          req.url = bypassUrl;
          next();
        } else if (proxyMiddleware) {
          return proxyMiddleware(req, res, next);
        } else {
          next();
        }
      };

      this.app.use(handle);
      // Also forward error requests to the proxy so it can handle them.
      this.app.use((error, req, res, next) => handle(req, res, next));
    });
  }

  setupHistoryApiFallbackFeature() {
    const fallback =
      typeof this.options.historyApiFallback === 'object'
        ? this.options.historyApiFallback
        : null;

    // Fall back to /index.html if nothing else matches.
    this.app.use(historyApiFallback(fallback));
  }

  setupStaticFeature() {
    const contentBase = this.options.contentBase;
    const contentBasePublicPath = this.options.contentBasePublicPath;

    if (Array.isArray(contentBase)) {
      contentBase.forEach((item, index) => {
        let publicPath = contentBasePublicPath;

        if (
          Array.isArray(contentBasePublicPath) &&
          contentBasePublicPath[index]
        ) {
          publicPath = contentBasePublicPath[index] || contentBasePublicPath[0];
        }

        this.app.use(publicPath, express.static(item));
      });
    } else if (isAbsoluteUrl(String(contentBase))) {
      this.log.warn(
        'Using a URL as contentBase is deprecated and will be removed in the next major version. Please use the proxy option instead.'
      );

      this.log.warn(
        'proxy: {\n\t"*": "<your current contentBase configuration>"\n}'
      );

      // Redirect every request to contentBase
      this.app.get('*', (req, res) => {
        res.writeHead(302, {
          Location: contentBase + req.path + (req._parsedUrl.search || ''),
        });

        res.end();
      });
    } else if (typeof contentBase === 'number') {
      this.log.warn(
        'Using a number as contentBase is deprecated and will be removed in the next major version. Please use the proxy option instead.'
      );

      this.log.warn(
        'proxy: {\n\t"*": "//localhost:<your current contentBase configuration>"\n}'
      );

      // Redirect every request to the port contentBase
      this.app.get('*', (req, res) => {
        res.writeHead(302, {
          Location: `//localhost:${contentBase}${req.path}${req._parsedUrl
            .search || ''}`,
        });

        res.end();
      });
    } else {
      // route content request
      this.app.use(
        contentBasePublicPath,
        express.static(contentBase, this.options.staticOptions)
      );
    }
  }

  setupServeIndexFeature() {
    const contentBase = this.options.contentBase;
    const contentBasePublicPath = this.options.contentBasePublicPath;

    if (Array.isArray(contentBase)) {
      contentBase.forEach((item) => {
        this.app.use(contentBasePublicPath, (req, res, next) => {
          // serve-index doesn't fallthrough non-get/head request to next middleware
          if (req.method !== 'GET' && req.method !== 'HEAD') {
            return next();
          }

          serveIndex(item, { icons: true })(req, res, next);
        });
      });
    } else if (
      typeof contentBase !== 'number' &&
      !isAbsoluteUrl(String(contentBase))
    ) {
      this.app.use(contentBasePublicPath, (req, res, next) => {
        // serve-index doesn't fallthrough non-get/head request to next middleware
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          return next();
        }

        serveIndex(contentBase, { icons: true })(req, res, next);
      });
    }
  }

  setupWatchStaticFeature() {
    const contentBase = this.options.contentBase;

    if (isAbsoluteUrl(String(contentBase)) || typeof contentBase === 'number') {
      throw new Error('Watching remote files is not supported.');
    } else if (Array.isArray(contentBase)) {
      contentBase.forEach((item) => {
        if (isAbsoluteUrl(String(item)) || typeof item === 'number') {
          throw new Error('Watching remote files is not supported.');
        }
        this._watch(item);
      });
    } else {
      this._watch(contentBase);
    }
  }

  setupBeforeFeature() {
    // Todo rename onBeforeSetupMiddleware in next major release
    // Todo pass only `this` argument
    this.options.before(this.app, this, this.compiler);
  }

  setupMiddleware() {
    this.app.use(this.middleware);
  }

  setupAfterFeature() {
    // Todo rename onAfterSetupMiddleware in next major release
    // Todo pass only `this` argument
    this.options.after(this.app, this, this.compiler);
  }

  setupHeadersFeature() {
    this.app.all('*', this.setContentHeaders.bind(this));
  }

  setupMagicHtmlFeature() {
    this.app.get('*', this.serveMagicHtml.bind(this));
  }

  setupSetupFeature() {
    this.log.warn(
      'The `setup` option is deprecated and will be removed in v4. Please update your config to use `before`'
    );

    this.options.setup(this.app, this);
  }

  setupFeatures() {
    const features = {
      compress: () => {
        if (this.options.compress) {
          this.setupCompressFeature();
        }
      },
      proxy: () => {
        if (this.options.proxy) {
          this.setupProxyFeature();
        }
      },
      historyApiFallback: () => {
        if (this.options.historyApiFallback) {
          this.setupHistoryApiFallbackFeature();
        }
      },
      // Todo rename to `static` in future major release
      contentBaseFiles: () => {
        this.setupStaticFeature();
      },
      // Todo rename to `serveIndex` in future major release
      contentBaseIndex: () => {
        this.setupServeIndexFeature();
      },
      // Todo rename to `watchStatic` in future major release
      watchContentBase: () => {
        this.setupWatchStaticFeature();
      },
      before: () => {
        if (typeof this.options.before === 'function') {
          this.setupBeforeFeature();
        }
      },
      middleware: () => {
        // include our middleware to ensure
        // it is able to handle '/index.html' request after redirect
        this.setupMiddleware();
      },
      after: () => {
        if (typeof this.options.after === 'function') {
          this.setupAfterFeature();
        }
      },
      headers: () => {
        this.setupHeadersFeature();
      },
      magicHtml: () => {
        this.setupMagicHtmlFeature();
      },
      setup: () => {
        if (typeof this.options.setup === 'function') {
          this.setupSetupFeature();
        }
      },
    };

    const runnableFeatures = [];

    // compress is placed last and uses unshift so that it will be the first middleware used
    if (this.options.compress) {
      runnableFeatures.push('compress');
    }

    runnableFeatures.push('setup', 'before', 'headers', 'middleware');

    if (this.options.proxy) {
      runnableFeatures.push('proxy', 'middleware');
    }

    if (this.options.contentBase !== false) {
      runnableFeatures.push('contentBaseFiles');
    }

    if (this.options.historyApiFallback) {
      runnableFeatures.push('historyApiFallback', 'middleware');

      if (this.options.contentBase !== false) {
        runnableFeatures.push('contentBaseFiles');
      }
    }

    // checking if it's set to true or not set (Default : undefined => true)
    this.serveIndex = this.serveIndex || this.serveIndex === undefined;

    if (this.options.contentBase && this.serveIndex) {
      runnableFeatures.push('contentBaseIndex');
    }

    if (this.options.watchContentBase) {
      runnableFeatures.push('watchContentBase');
    }

    runnableFeatures.push('magicHtml');

    if (this.options.after) {
      runnableFeatures.push('after');
    }

    (this.options.features || runnableFeatures).forEach((feature) => {
      features[feature]();
    });
  }

  setupHttps() {
    // if the user enables http2, we can safely enable https
    if (this.options.http2 && !this.options.https) {
      this.options.https = true;
    }

    if (this.options.https) {
      // for keep supporting CLI parameters
      if (typeof this.options.https === 'boolean') {
        this.options.https = {
          ca: this.options.ca,
          pfx: this.options.pfx,
          key: this.options.key,
          cert: this.options.cert,
          passphrase: this.options.pfxPassphrase,
          requestCert: this.options.requestCert || false,
        };
      }

      for (const property of ['ca', 'pfx', 'key', 'cert']) {
        const value = this.options.https[property];
        const isBuffer = value instanceof Buffer;

        if (value && !isBuffer) {
          let stats = null;

          try {
            stats = fs.lstatSync(fs.realpathSync(value)).isFile();
          } catch (error) {
            // ignore error
          }

          // It is file
          this.options.https[property] = stats
            ? fs.readFileSync(path.resolve(value))
            : value;
        }
      }

      let fakeCert;

      if (!this.options.https.key || !this.options.https.cert) {
        fakeCert = getCertificate(this.log);
      }

      this.options.https.key = this.options.https.key || fakeCert;
      this.options.https.cert = this.options.https.cert || fakeCert;

      // note that options.spdy never existed. The user was able
      // to set options.https.spdy before, though it was not in the
      // docs. Keep options.https.spdy if the user sets it for
      // backwards compatibility, but log a deprecation warning.
      if (this.options.https.spdy) {
        // for backwards compatibility: if options.https.spdy was passed in before,
        // it was not altered in any way
        this.log.warn(
          'Providing custom spdy server options is deprecated and will be removed in the next major version.'
        );
      } else {
        // if the normal https server gets this option, it will not affect it.
        this.options.https.spdy = {
          protocols: ['h2', 'http/1.1'],
        };
      }
    }
  }

  createServer() {
    if (this.options.https) {
      // Only prevent HTTP/2 if http2 is explicitly set to false
      const isHttp2 = this.options.http2 !== false;

      // `spdy` is effectively unmaintained, and as a consequence of an
      // implementation that extensively relies on Node’s non-public APIs, broken
      // on Node 10 and above. In those cases, only https will be used for now.
      // Once express supports Node's built-in HTTP/2 support, migrating over to
      // that should be the best way to go.
      // The relevant issues are:
      // - https://github.com/nodejs/node/issues/21665
      // - https://github.com/webpack/webpack-dev-server/issues/1449
      // - https://github.com/expressjs/express/issues/3388
      if (semver.gte(process.version, '10.0.0') || !isHttp2) {
        if (this.options.http2) {
          // the user explicitly requested http2 but is not getting it because
          // of the node version.
          this.log.warn(
            'HTTP/2 is currently unsupported for Node 10.0.0 and above, but will be supported once Express supports it'
          );
        }
        this.listeningApp = https.createServer(this.options.https, this.app);
      } else {
        // The relevant issues are:
        // https://github.com/spdy-http2/node-spdy/issues/350
        // https://github.com/webpack/webpack-dev-server/issues/1592
        this.listeningApp = require('spdy').createServer(
          this.options.https,
          this.app
        );
      }
    } else {
      this.listeningApp = http.createServer(this.app);
    }

    this.listeningApp.on('error', (err) => {
      this.log.error(err);
    });
  }

  createSocketServer() {
    const SocketServerImplementation = this.socketServerImplementation;
    this.socketServer = new SocketServerImplementation(this);

    this.socketServer.onConnection((connection, headers) => {
      if (!connection) {
        return;
      }

      if (!headers) {
        this.log.warn(
          'transportMode.server implementation must pass headers to the callback of onConnection(f) ' +
            'via f(connection, headers) in order for clients to pass a headers security check'
        );
      }

      if (!headers || !this.checkHost(headers) || !this.checkOrigin(headers)) {
        this.sockWrite([connection], 'error', 'Invalid Host/Origin header');

        this.socketServer.close(connection);

        return;
      }

      this.sockets.push(connection);

      this.socketServer.onConnectionClose(connection, () => {
        const idx = this.sockets.indexOf(connection);

        if (idx >= 0) {
          this.sockets.splice(idx, 1);
        }
      });

      if (this.clientLogLevel) {
        this.sockWrite([connection], 'log-level', this.clientLogLevel);
      }

      if (this.hot) {
        this.sockWrite([connection], 'hot');
      }

      // TODO: change condition at major version
      if (this.options.liveReload !== false) {
        this.sockWrite([connection], 'liveReload', this.options.liveReload);
      }

      if (this.progress) {
        this.sockWrite([connection], 'progress', this.progress);
      }

      if (this.clientOverlay) {
        this.sockWrite([connection], 'overlay', this.clientOverlay);
      }

      if (!this._stats) {
        return;
      }

      this._sendStats([connection], this.getStats(this._stats), true);
    });
  }

  // Whether an upgrade request targets the dev server's own socket server (HMR /
  // live reload). The request is matched the same way the socket server claims
  // it, so URL variants the socket server refuses are still forwarded to the
  // user websocket proxies.
  isSocketServerUpgrade(req) {
    if (typeof req.url !== 'string') {
      return false;
    }

    // Raw, case-sensitive request target with the query string stripped, no
    // normalization (`//sockjs-node`, `/SOCKJS-NODE`, ... are not the socket)
    const queryIndex = req.url.indexOf('?');
    const pathname = queryIndex !== -1 ? req.url.slice(0, queryIndex) : req.url;

    // `ws` (`WebSocketServer#shouldHandle`) only handles the exact path
    // https://github.com/websockets/ws/blob/6.2.1/lib/websocket-server.js
    if (this.socketServer instanceof WebsocketServer) {
      return pathname === this.sockPath;
    }

    // `sockjs` (`Listener#handler`) handles every request target under its
    // prefix (`^<prefix>([/].+|[/]?)$`), a custom implementation may handle
    // the exact path or the paths under it
    // https://github.com/sockjs/sockjs-node/blob/v0.3.21/lib/sockjs.js
    return (
      pathname === this.sockPath || pathname.startsWith(`${this.sockPath}/`)
    );
  }

  showStatus() {
    const suffix =
      this.options.inline !== false || this.options.lazy === true
        ? '/'
        : '/webpack-dev-server/';
    const uri = `${createDomain(this.options, this.listeningApp)}${suffix}`;

    status(
      uri,
      this.options,
      this.log,
      this.options.stats && this.options.stats.colors
    );
  }

  listen(port, hostname, fn) {
    this.hostname = hostname;

    return this.listeningApp.listen(port, hostname, (err) => {
      this.createSocketServer();

      if (this.options.bonjour) {
        runBonjour(this.options);
      }

      this.showStatus();

      if (fn) {
        fn.call(this.listeningApp, err);
      }

      if (typeof this.options.onListening === 'function') {
        this.options.onListening(this);
      }
    });
  }

  close(cb) {
    this.sockets.forEach((socket) => {
      this.socketServer.close(socket);
    });

    this.sockets = [];

    this.contentBaseWatchers.forEach((watcher) => {
      watcher.close();
    });

    this.contentBaseWatchers = [];

    this.listeningApp.kill(() => {
      this.middleware.close(cb);
    });
  }

  static get DEFAULT_STATS() {
    return {
      all: false,
      hash: true,
      assets: true,
      warnings: true,
      errors: true,
      errorDetails: false,
    };
  }

  getStats(statsObj) {
    const stats = Server.DEFAULT_STATS;

    if (this.originalStats.warningsFilter) {
      stats.warningsFilter = this.originalStats.warningsFilter;
    }

    return statsObj.toJson(stats);
  }

  use() {
    // eslint-disable-next-line
    this.app.use.apply(this.app, arguments);
  }

  setContentHeaders(req, res, next) {
    if (this.headers) {
      // eslint-disable-next-line
      for (const name in this.headers) {
        res.setHeader(name, this.headers[name]);
      }
    }

    next();
  }

  checkHost(headers) {
    return this.checkHeaders(headers, 'host', true);
  }

  checkOrigin(headers) {
    // IP addresses are not automatically trusted for the Origin header,
    // otherwise a page served from an untrusted remote IP host could connect.
    // An IP origin is only allowed when it is the same as the requested host.
    return this.checkHeaders(headers, 'origin', this.isSameOrigin(headers));
  }

  isSameOrigin(headers) {
    // allow user to opt-out this security check, at own risk
    if (this.disableHostCheck) {
      return true;
    }

    const getHostname = (header) => {
      if (!header) {
        return null;
      }

      // a malformed header value (e.g. an invalid IPv6 literal) can make the
      // url-parser throw, treat it as a missing hostname
      try {
        return url.parse(
          // if header doesn't have scheme, add // for parsing.
          /^(.+:)?\/\//.test(header) ? header : `//${header}`,
          false,
          true
        ).hostname;
      } catch (error) {
        return null;
      }
    };

    const origin = getHostname(headers.origin);
    const host = getHostname(headers.host);

    if (!origin || !host) {
      return false;
    }

    return origin === host;
  }

  // Determines whether a request was initiated from the dev server's own
  // origin, to reject cross-site request forgery on state-changing endpoints.
  isSameOriginRequest(req) {
    const headers = req.headers;

    const secFetchSite = headers['sec-fetch-site'];

    // Prefer `Sec-Fetch-Site`: browsers send it even for same-origin GET
    // `fetch`es (which omit `Origin`), and a cross-site page cannot forge it.
    // `none` is a user-initiated navigation.
    if (typeof secFetchSite === 'string') {
      return secFetchSite === 'same-origin' || secFetchSite === 'none';
    }

    // Without `Sec-Fetch-*` metadata (non-browser/legacy clients): a request
    // with no `Origin` header was not initiated by another origin's script;
    // otherwise fall back to the `Origin`/`Host` comparison.
    if (typeof headers.origin !== 'string') {
      return true;
    }

    return this.isSameOrigin(headers);
  }

  // true when the user has configured a wildcard Access-Control-Allow-Origin
  // header (opting into fully open cross-origin access)
  isUserCORSWildcardEnabled() {
    const headers = this.headers;

    if (!headers) {
      return false;
    }

    if (typeof headers === 'function') {
      return false;
    }

    const isWildcard = (value) => {
      if (typeof value === 'string') {
        return value.trim() === '*';
      }

      if (Array.isArray(value)) {
        return value.length === 1 && isWildcard(value[0]);
      }

      return false;
    };

    if (Array.isArray(headers)) {
      return headers.some(
        (header) =>
          Boolean(header) &&
          typeof header.key === 'string' &&
          header.key.toLowerCase() === 'access-control-allow-origin' &&
          isWildcard(header.value)
      );
    }

    return Object.keys(headers).some(
      (key) =>
        key.toLowerCase() === 'access-control-allow-origin' &&
        isWildcard(headers[key])
    );
  }

  checkHeaders(headers, headerToCheck, allowIP, validateHost = true) {
    // allow user to opt-out this security check, at own risk
    if (this.disableHostCheck) {
      return true;
    }

    if (!headerToCheck) {
      headerToCheck = 'host';
    }

    // get the Host header and extract hostname
    // we don't care about port not matching
    const hostHeader = headers[headerToCheck];

    if (!hostHeader) {
      return false;
    }

    // use the node url-parser to retrieve the hostname from the host-header.
    let hostname;

    try {
      hostname = url.parse(
        // if hostHeader doesn't have scheme, add // for parsing.
        /^(.+:)?\/\//.test(hostHeader) ? hostHeader : `//${hostHeader}`,
        false,
        true
      ).hostname;
    } catch (error) {
      return false;
    }

    if (hostname === null) {
      return false;
    }

    // allow requests with explicit IPv4 or IPv6-address if allowIP is true.
    // Note that IP should not be automatically allowed for Origin headers,
    // otherwise an untrusted remote IP host can send requests.
    //
    // A note on IPv6 addresses:
    // hostHeader will always contain the brackets denoting
    // an IPv6-address in URLs,
    // these are removed from the hostname in url.parse(),
    // so we have the pure IPv6-address in hostname.
    // always allow localhost host, for convenience (hostname === 'localhost')
    // allow hostname of listening address  (hostname === this.hostname)
    //
    // when validateHost is false, none of the above hostnames are implicitly
    // trusted; only an explicit opt-in (disableHostCheck, allowedHosts or
    // public) allows the request.
    const isValidHostname = validateHost
      ? (allowIP && (ip.isV4Format(hostname) || ip.isV6Format(hostname))) ||
        hostname === 'localhost' ||
        hostname === this.hostname
      : false;

    if (isValidHostname) {
      return true;
    }
    // always allow localhost host, for convenience
    // allow if hostname is in allowedHosts
    if (this.allowedHosts && this.allowedHosts.length) {
      for (let hostIdx = 0; hostIdx < this.allowedHosts.length; hostIdx++) {
        const allowedHost = this.allowedHosts[hostIdx];

        if (allowedHost === hostname) {
          return true;
        }

        // support "." as a subdomain wildcard
        // e.g. ".example.com" will allow "example.com", "www.example.com", "subdomain.example.com", etc
        if (allowedHost[0] === '.') {
          // "example.com"  (hostname === allowedHost.substring(1))
          // "*.example.com"  (hostname.endsWith(allowedHost))
          if (
            hostname === allowedHost.substring(1) ||
            hostname.endsWith(allowedHost)
          ) {
            return true;
          }
        }
      }
    }

    // also allow public hostname if provided
    if (typeof this.publicHost === 'string') {
      const idxPublic = this.publicHost.indexOf(':');
      const publicHostname =
        idxPublic >= 0 ? this.publicHost.substr(0, idxPublic) : this.publicHost;

      if (hostname === publicHostname) {
        return true;
      }
    }

    // disallow
    return false;
  }

  // eslint-disable-next-line
  sockWrite(sockets, type, data) {
    sockets.forEach((socket) => {
      this.socketServer.send(socket, JSON.stringify({ type, data }));
    });
  }

  serveMagicHtml(req, res, next) {
    const _path = req.path;

    try {
      const isFile = this.middleware.fileSystem
        .statSync(this.middleware.getFilenameFromUrl(`${_path}.js`))
        .isFile();

      if (!isFile) {
        return next();
      }
      // Serve a page that executes the javascript
      const queries = req._parsedUrl.search || '';
      const responsePage = `<!DOCTYPE html><html><head><meta charset="utf-8"/></head><body><script type="text/javascript" charset="utf-8" src="${_path}.js${queries}"></script></body></html>`;
      res.send(responsePage);
    } catch (err) {
      return next();
    }
  }

  // send stats to a socket or multiple sockets
  _sendStats(sockets, stats, force) {
    const shouldEmit =
      !force &&
      stats &&
      (!stats.errors || stats.errors.length === 0) &&
      stats.assets &&
      stats.assets.every((asset) => !asset.emitted);

    if (shouldEmit) {
      return this.sockWrite(sockets, 'still-ok');
    }

    this.sockWrite(sockets, 'hash', stats.hash);

    if (stats.errors.length > 0) {
      this.sockWrite(sockets, 'errors', stats.errors);
    } else if (stats.warnings.length > 0) {
      this.sockWrite(sockets, 'warnings', stats.warnings);
    } else {
      this.sockWrite(sockets, 'ok');
    }
  }

  _watch(watchPath) {
    // duplicate the same massaging of options that watchpack performs
    // https://github.com/webpack/watchpack/blob/master/lib/DirectoryWatcher.js#L49
    // this isn't an elegant solution, but we'll improve it in the future
    const usePolling = this.watchOptions.poll ? true : undefined;
    const interval =
      typeof this.watchOptions.poll === 'number'
        ? this.watchOptions.poll
        : undefined;

    const watchOptions = {
      ignoreInitial: true,
      persistent: true,
      followSymlinks: false,
      atomic: false,
      alwaysStat: true,
      ignorePermissionErrors: true,
      ignored: this.watchOptions.ignored,
      usePolling,
      interval,
    };

    const watcher = chokidar.watch(watchPath, watchOptions);
    // disabling refreshing on changing the content
    if (this.options.liveReload !== false) {
      watcher.on('change', () => {
        this.sockWrite(this.sockets, 'content-changed');
      });
    }
    this.contentBaseWatchers.push(watcher);
  }

  invalidate(callback) {
    if (this.middleware) {
      this.middleware.invalidate(callback);
    }
  }
}

// Export this logic,
// so that other implementations,
// like task-runners can use it
Server.addDevServerEntrypoints = require('./utils/addEntries');

module.exports = Server;
