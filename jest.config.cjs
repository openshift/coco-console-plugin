// Jest runs the pure-logic unit tests under src/utils (CDH-path validator,
// KBS-URL classifier, etc.). Component rendering is covered by the console e2e
// harness, not Jest, so this config deliberately only picks up *.spec.ts files
// and transforms TypeScript with babel-jest (see babel.config.cjs).
/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/*.spec.ts', '**/*.spec.tsx'],
  transform: {
    '^.+\\.[jt]sx?$': 'babel-jest',
  },
  moduleNameMapper: {
    '\\.(css|scss)$': '<rootDir>/src/test/styleMock.js',
  },
  clearMocks: true,
};
