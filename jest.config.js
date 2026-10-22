'use strict';

// On Node < 8 (the Node 6 leg) the historyApiFallback fixtures' file-loader@5
// (Node >= 8.9) never emits index.html, and skipping those specs individually
// leaves a shared-port server open that times out the rest of the file, so the
// file runs on Node >= 8 only.
const isLegacyNode = parseInt(process.versions.node.split('.')[0], 10) < 8;

module.exports = {
  testPathIgnorePatterns: ['/node_modules/'].concat(
    isLegacyNode ? ['<rootDir>/test/server/historyApiFallback-option.test.js'] : []
  ),
  testURL: 'http://localhost/',
  collectCoverage: false,
  coveragePathIgnorePatterns: ['test'],
  moduleFileExtensions: ['js', 'json'],
  testMatch: ['**/test/**/*.test.js'],
  setupFilesAfterEnv: ['<rootDir>/setupTest.js'],
  globalSetup: '<rootDir>/globalSetupTest.js',
  testSequencer: '<rootDir>/test/testSequencer.js',
};
