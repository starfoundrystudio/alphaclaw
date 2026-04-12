const childProcess = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  kLatestVersionCacheTtlMs,
  kAlphaclawRegistryUrl,
  kNpmPackageRoot,
  kOpenclawUpdateCopyTimeoutMs,
  kRootDir,
} = require("./constants");
const {
  compareVersionParts,
  normalizeOpenclawVersion,
} = require("./helpers");

const isNewerVersion = (latest, current) => {
  if (!latest || !current) return false;
  const parse = (value) => {
    const normalized = String(value || "").replace(/^v/, "").trim();
    const [core, prerelease = ""] = normalized.split("-", 2);
    const parts = core.split(".").map(Number);
    return {
      major: parts[0] || 0,
      minor: parts[1] || 0,
      patch: parts[2] || 0,
      prerelease,
    };
  };
  const latestParts = parse(latest);
  const currentParts = parse(current);
  if (latestParts.major !== currentParts.major) {
    return latestParts.major > currentParts.major;
  }
  if (latestParts.minor !== currentParts.minor) {
    return latestParts.minor > currentParts.minor;
  }
  if (latestParts.patch !== currentParts.patch) {
    return latestParts.patch > currentParts.patch;
  }
  if (!latestParts.prerelease && currentParts.prerelease) {
    return true;
  }
  return false;
};

const normalizeVersion = (value) => {
  const normalized = String(value || "").trim();
  return normalized || null;
};

const parseJsonResponse = async (response, fallbackMessage) => {
  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(text || fallbackMessage);
  }
  if (!response.ok) {
    throw new Error(
      data?.message ||
        data?.error ||
        text ||
        `${fallbackMessage} (${response.status})`,
    );
  }
  return data;
};

const buildGithubHeaders = ({
  env = process.env,
  accept = "application/json",
  targetUrl = "",
} = {}) => {
  const headers = {
    Accept: accept,
    "User-Agent": "alphaclaw",
  };
  const token = String(env?.GITHUB_TOKEN || env?.GH_TOKEN || "").trim();
  if (token) {
    const normalizedTargetUrl = String(targetUrl || "").trim().toLowerCase();
    const isGithubPackagesRegistryRequest =
      normalizedTargetUrl === kAlphaclawRegistryUrl.toLowerCase() ||
      normalizedTargetUrl.includes("npm.pkg.github.com");

    if (isGithubPackagesRegistryRequest) {
      const username = String(env?.GITHUB_ACTOR || env?.GITHUB_USERNAME || "x-access-token").trim();
      const encodedCredentials = Buffer.from(`${username}:${token}`, "utf8").toString("base64");
      headers.Authorization = `Basic ${encodedCredentials}`;
    } else {
      headers.Authorization = `Bearer ${token}`;
    }
  }
  return headers;
};

const fetchLatestVersionFromRegistry = async ({ fetchImpl, env = process.env }) => {
  if (typeof fetchImpl !== "function") {
    throw new Error("Fetch is not available for AlphaClaw version checks");
  }
  const response = await fetchImpl(kAlphaclawRegistryUrl, {
    headers: buildGithubHeaders({
      env,
      accept: "application/vnd.npm.install-v1+json",
      targetUrl: kAlphaclawRegistryUrl,
    }),
  });
  const data = await parseJsonResponse(
    response,
    "Failed to fetch latest AlphaClaw version",
  );
  const latestVersion = normalizeVersion(data?.["dist-tags"]?.latest);
  const latestOpenclawVersion = latestVersion
    ? normalizeOpenclawVersion(
        data?.versions?.[latestVersion]?.dependencies?.openclaw,
      )
    : null;
  return { latestVersion, latestOpenclawVersion };
};

const createUpdateStrategy = ({
  action,
  provider,
  label,
  description,
  steps = [],
  primaryActionLabel,
  primaryActionUrl = "",
}) => ({
  action,
  provider,
  label,
  templateRepoUrl: "",
  templateBranch: "",
  description: String(description || "").trim(),
  steps: Array.isArray(steps)
    ? steps.map((entry) => String(entry || "").trim()).filter(Boolean)
    : [],
  primaryActionLabel: String(primaryActionLabel || "").trim() || "Update now",
  primaryActionUrl: String(primaryActionUrl || "").trim(),
  managedUpdateUrl: "",
  managedUpdateToken: "",
});

const detectUpdateStrategy = ({
  env = process.env,
  fsImpl = fs,
} = {}) => {
  const deploymentProvider = String(env.ALPHACLAW_DEPLOYMENT_PROVIDER || "")
    .trim()
    .toLowerCase();

  if (deploymentProvider === "clawctl") {
    return createUpdateStrategy({
      action: "instructions",
      provider: "clawctl",
      label: "TeamYou",
      description: "This AlphaClaw instance is managed by TeamYou.",
      steps: ["Contact TeamYou support to request an upgrade."],
      primaryActionLabel: "Done",
    });
  }

  if (fsImpl.existsSync("/.dockerenv")) {
    return createUpdateStrategy({
      action: "instructions",
      provider: "container",
      label: "Container",
      description:
        "This AlphaClaw instance is running in a container. Rebuild or redeploy the container from the latest deployment template or image to apply updates.",
      steps: [
        "Pull the latest deployment template or image for this container",
        "Rebuild or redeploy the container with the updated bundle",
        "Restart the service after the new build is ready",
      ],
      primaryActionLabel: "Done",
    });
  }

  return createUpdateStrategy({
    action: "self-update",
    provider: "self-hosted",
    label: "This install",
    description:
      "This will install the latest @starfoundrystudio/alphaclaw package in place and restart AlphaClaw.",
    steps: [
      "AlphaClaw will install the latest published package in place",
      "The process will restart after the new files are copied into node_modules",
    ],
    primaryActionLabel: "Update now",
  });
};

const createAlphaclawVersionService = ({
  readOpenclawVersion = () => null,
  env = process.env,
  fsImpl = fs,
  fetchImpl = global.fetch,
} = {}) => {
  let kRegistryStatusCache = {
    latestVersion: null,
    latestOpenclawVersion: null,
    fetchedAt: 0,
  };
  let kUpdateInProgress = false;

  const readAlphaclawVersion = () => {
    try {
      const pkg = JSON.parse(
        fsImpl.readFileSync(path.join(kNpmPackageRoot, "package.json"), "utf8"),
      );
      return normalizeVersion(pkg.version);
    } catch {
      return null;
    }
  };

  const readRegistryStatus = async ({ refresh = false } = {}) => {
    const now = Date.now();
    if (
      !refresh &&
      kRegistryStatusCache.fetchedAt &&
      now - kRegistryStatusCache.fetchedAt < kLatestVersionCacheTtlMs
    ) {
      return kRegistryStatusCache;
    }
    const registry = await fetchLatestVersionFromRegistry({ fetchImpl, env });
    kRegistryStatusCache = {
      latestVersion: registry.latestVersion,
      latestOpenclawVersion: registry.latestOpenclawVersion,
      fetchedAt: Date.now(),
    };
    return kRegistryStatusCache;
  };

  const buildVersionStatus = ({
    strategy,
    latestVersion = null,
    latestOpenclawVersion = null,
    ok = true,
    error = "",
  }) => {
    const currentVersion = readAlphaclawVersion();
    const currentOpenclawVersion = normalizeOpenclawVersion(readOpenclawVersion());
    const alphaclawHasUpdate = isNewerVersion(latestVersion, currentVersion);
    const openclawHasUpdate = latestOpenclawVersion
      ? !currentOpenclawVersion ||
        compareVersionParts(latestOpenclawVersion, currentOpenclawVersion) > 0
      : false;
    return {
      ok,
      currentVersion,
      currentOpenclawVersion,
      latestVersion: normalizeVersion(latestVersion),
      latestOpenclawVersion: normalizeOpenclawVersion(latestOpenclawVersion),
      hasUpdate: Boolean(alphaclawHasUpdate || openclawHasUpdate),
      updateStrategy: strategy,
      ...(error ? { error: String(error || "").trim() } : {}),
    };
  };

  const installLatestAlphaclaw = () =>
    new Promise((resolve, reject) => {
      const installDir = findInstallDir(fsImpl);
      const tmpDir = fsImpl.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-update-"));

      const cleanup = () => {
        try {
          fsImpl.rmSync(tmpDir, { recursive: true, force: true });
        } catch {}
      };

      fsImpl.writeFileSync(
        path.join(tmpDir, "package.json"),
        JSON.stringify({
          private: true,
          dependencies: { "@starfoundrystudio/alphaclaw": "latest" },
        }),
      );

      const npmEnv = {
        ...process.env,
        npm_config_update_notifier: "false",
        npm_config_fund: "false",
        npm_config_audit: "false",
      };

      console.log(
        `[alphaclaw] Running: npm install @starfoundrystudio/alphaclaw@latest in temp dir (target: ${installDir})`,
      );
      childProcess.exec(
        "npm install --omit=dev --prefer-online --package-lock=false",
        {
          cwd: tmpDir,
          env: npmEnv,
          timeout: 180000,
        },
        (err, stdout, stderr) => {
          if (err) {
            const message = String(stderr || err.message || "").trim();
            console.log(
              `[alphaclaw] alphaclaw install error: ${message.slice(0, 200)}`,
            );
            cleanup();
            return reject(
              new Error(
                message || "Failed to install @starfoundrystudio/alphaclaw@latest",
              ),
            );
          }
          if (stdout?.trim()) {
            console.log(
              `[alphaclaw] alphaclaw install stdout: ${stdout.trim().slice(0, 300)}`,
            );
          }

          const src = path.join(tmpDir, "node_modules");
          const dest = path.join(installDir, "node_modules");
          childProcess.exec(
            `cp -af "${src}/." "${dest}/"`,
            { timeout: kOpenclawUpdateCopyTimeoutMs },
            (copyErr) => {
              cleanup();
              if (copyErr) {
                console.log(
                  `[alphaclaw] alphaclaw copy error: ${(copyErr.message || "").slice(0, 200)}`,
                );
                return reject(
                  new Error(
                    `Failed to copy updated AlphaClaw files: ${copyErr.message}`,
                  ),
                );
              }
              console.log("[alphaclaw] alphaclaw install completed");
              resolve({ stdout: stdout?.trim(), stderr: stderr?.trim() });
            },
          );
        },
      );
    });

  const restartProcess = () => {
    if (
      env.RAILWAY_ENVIRONMENT ||
      env.RENDER ||
      env.FLY_APP_NAME ||
      fsImpl.existsSync("/.dockerenv")
    ) {
      console.log("[alphaclaw] Restarting via container crash (exit 1)...");
      process.exit(1);
    }
    console.log("[alphaclaw] Spawning new process and exiting...");
    const { spawn } = require("child_process");
    const child = spawn(process.argv[0], process.argv.slice(1), {
      detached: true,
      stdio: "inherit",
    });
    child.unref();
    process.exit(0);
  };

  const getVersionStatus = async (refresh) => {
    const strategy = detectUpdateStrategy({ env, fsImpl });
    if (strategy.action === "instructions") {
      return buildVersionStatus({
        strategy,
        latestVersion: null,
        latestOpenclawVersion: null,
      });
    }
    try {
      const status = await readRegistryStatus({ refresh });
      return buildVersionStatus({
        strategy,
        latestVersion: status.latestVersion,
        latestOpenclawVersion: status.latestOpenclawVersion,
      });
    } catch (err) {
      return buildVersionStatus({
        strategy,
        latestVersion: kRegistryStatusCache.latestVersion,
        latestOpenclawVersion: kRegistryStatusCache.latestOpenclawVersion,
        ok: false,
        error: err.message || "Failed to fetch latest AlphaClaw version",
      });
    }
  };

  const updateAlphaclaw = async () => {
    const strategy = detectUpdateStrategy({ env, fsImpl });
    if (kUpdateInProgress) {
      return {
        status: 409,
        body: { ok: false, error: "AlphaClaw update already in progress" },
      };
    }
    if (strategy.action !== "self-update") {
      return {
        status: 409,
        body: {
          ok: false,
          error:
            strategy.description || "This deployment is updated outside AlphaClaw.",
          updateStrategy: strategy,
        },
      };
    }

    kUpdateInProgress = true;
    const previousVersion = readAlphaclawVersion();
    try {
      await installLatestAlphaclaw();
      const markerPath = path.join(kRootDir, ".alphaclaw-update-pending");
      try {
        fsImpl.writeFileSync(
          markerPath,
          JSON.stringify({ from: previousVersion, ts: Date.now() }),
        );
        console.log(`[alphaclaw] Update marker written to ${markerPath}`);
      } catch (e) {
        console.log(`[alphaclaw] Could not write update marker: ${e.message}`);
      }
      kRegistryStatusCache = {
        latestVersion: null,
        fetchedAt: 0,
      };
      return {
        status: 200,
        body: {
          ok: true,
          previousVersion,
          restarting: true,
        },
      };
    } catch (err) {
      kUpdateInProgress = false;
      return {
        status: 500,
        body: { ok: false, error: err.message || "Failed to update AlphaClaw" },
      };
    }
  };

  return {
    readAlphaclawVersion,
    getVersionStatus,
    updateAlphaclaw,
    restartProcess,
  };
};

const findInstallDir = (fsImpl) => {
  let dir = kNpmPackageRoot;
  while (dir !== path.dirname(dir)) {
    const parent = path.dirname(dir);
    if (
      path.basename(parent) === "node_modules" ||
      parent.includes(`${path.sep}node_modules${path.sep}`)
    ) {
      dir = parent;
      continue;
    }
    const pkgPath = path.join(parent, "package.json");
    if (fsImpl.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fsImpl.readFileSync(pkgPath, "utf8"));
        if (
          pkg.dependencies?.["@starfoundrystudio/alphaclaw"] ||
          pkg.devDependencies?.["@starfoundrystudio/alphaclaw"] ||
          pkg.optionalDependencies?.["@starfoundrystudio/alphaclaw"] ||
          pkg.dependencies?.["@chrysb/alphaclaw"] ||
          pkg.devDependencies?.["@chrysb/alphaclaw"] ||
          pkg.optionalDependencies?.["@chrysb/alphaclaw"]
        ) {
          return parent;
        }
      } catch {}
    }
    dir = parent;
  }
  return kNpmPackageRoot;
};

module.exports = {
  createAlphaclawVersionService,
  detectUpdateStrategy,
};
