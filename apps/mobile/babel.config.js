module.exports = (api) => {
  api.cache(true);
  return {
    presets: ["babel-preset-expo"],
    // Must stay last — the worklets plugin rewrites functions the other
    // transforms have already produced.
    plugins: ["react-native-worklets/plugin"],
  };
};
