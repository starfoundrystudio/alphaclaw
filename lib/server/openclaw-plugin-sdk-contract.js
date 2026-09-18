const kRequiredPluginSdkExports = Object.freeze({
  "device-bootstrap": ["approveDevicePairing", "listDevicePairing"],
  "secret-input": ["coerceSecretRef"],
  "secret-ref-runtime": ["resolveSecretRefValues"],
  "cron-store-runtime": ["loadCronStore", "saveCronStore"],
});

let contractPromise = null;

const assertSupportedOpenclawPluginSdk = async ({ importer = (specifier) => import(specifier) } = {}) => {
  contractPromise ||= Promise.all(
    Object.entries(kRequiredPluginSdkExports).map(async ([subpath, requiredExports]) => {
      const specifier = `openclaw/plugin-sdk/${subpath}`;
      const module = await importer(specifier);
      for (const exportName of requiredExports) {
        if (typeof module?.[exportName] !== "function") {
          throw new Error(`${specifier} is missing required export ${exportName}`);
        }
      }
      return specifier;
    }),
  );
  return contractPromise;
};

module.exports = {
  assertSupportedOpenclawPluginSdk,
  kRequiredPluginSdkExports,
};
