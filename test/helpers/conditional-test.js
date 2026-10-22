'use strict';

const isWindows = process.platform === 'win32';

function skipTestOnWindows(reason) {
  if (isWindows) {
    test.skip(reason, () => {});
  }
  return isWindows;
}

module.exports.skipTestOnWindows = skipTestOnWindows;

// The test fixtures' loaders (file-loader@5, style-loader@1) need Node >= 8.9,
// so on legacy Node (the Node 6 leg) the fixture assets are never emitted.
const isLegacyNode = parseInt(process.versions.node.split('.')[0], 10) < 8;

function itSkipOnLegacyNode(...args) {
  return (isLegacyNode ? it.skip : it)(...args);
}

module.exports.itSkipOnLegacyNode = itSkipOnLegacyNode;
