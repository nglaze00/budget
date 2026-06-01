const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);

// Allow importing .sql drizzle migration files as assets if we add them later.
config.resolver.sourceExts.push("sql");

module.exports = config;
