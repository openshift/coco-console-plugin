// Babel config used ONLY by Jest (babel-jest). The webpack build uses swc-loader
// and does not read this file, so transforms here never affect the production
// bundle. Guarded on the "test" env that Jest sets (BABEL_ENV/NODE_ENV=test) so a
// stray Babel invocation in another context stays a no-op.
module.exports = (api) => {
  const isTest = api.env('test');
  api.cache.using(() => process.env.NODE_ENV);
  if (!isTest) return { presets: [] };
  return {
    presets: [
      ['@babel/preset-env', { targets: { node: 'current' } }],
      '@babel/preset-typescript',
      ['@babel/preset-react', { runtime: 'automatic' }],
    ],
  };
};
