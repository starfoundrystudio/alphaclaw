const fs = require("fs");
const path = require("path");

const {
  kManagedCapabilityContract,
  kManagedCapabilityContractRef,
  renderManagedCapabilityContractTokens,
} = require("../../lib/server/managed-capability-contract");
const {
  ensureManagedOpenclawDefaults,
} = require("../../lib/server/managed-defaults-config");

describe("server/managed-capability-contract", () => {
  it("defines the approved managed and advanced surface boundary", () => {
    expect(kManagedCapabilityContractRef).toBe(
      "teamyou.managed-capabilities/v1@2026-09-18.1",
    );
    const pinnedOpenclawPackage = JSON.parse(
      fs.readFileSync(
        path.resolve("node_modules/openclaw/package.json"),
        "utf8",
      ),
    );
    expect(kManagedCapabilityContract.targetOpenClawVersion).toBe(
      pinnedOpenclawPackage.version,
    );
    expect(kManagedCapabilityContract.surfaces).toMatchObject({
      managed: {
        id: "clawbridge",
        role: "supported-managed-interface",
      },
      controlUi: {
        role: "optional-advanced-access",
        mode: "managed-config-read-only",
        customerRequired: false,
        hostedClawbridgeSections: false,
        label: "Advanced — unmanaged changes",
      },
    });
    expect(kManagedCapabilityContract.agentPolicy).toEqual({
      preferredExecution: "tools-and-cli",
      manualManagedSurface: "clawbridge",
      mayRequireControlUi: false,
      mayRecommendControlUi: false,
      unsupportedWorkflowBehavior: "explain-and-ask",
    });
  });

  it("drives the OpenClaw defaults used by managed provisioning", () => {
    const expected = kManagedCapabilityContract.managedConfig.initialDefaults;
    const { config } = ensureManagedOpenclawDefaults({});

    expect(config.agents.defaults.maxConcurrent).toBe(
      expected.agents.defaults.maxConcurrent,
    );
    expect(config.plugins.entries["memory-core"].config.dreaming.enabled).toBe(
      expected.plugins.entries["memory-core"].config.dreaming.enabled,
    );
    expect(config.skills.workshop.autonomous.mode).toBe(
      expected.skills.workshop.autonomous.mode,
    );
    expect(config.tools).toEqual(expected.tools);
    expect(config.gateway).toEqual(expected.gateway);
    expect(config.telemetry).toEqual(expected.telemetry);
    expect(config.secrets).toEqual(expected.secrets);
  });

  it("renders the contract reference and rejects obsolete product assumptions", () => {
    expect(
      renderManagedCapabilityContractTokens(
        "contract={{MANAGED_CAPABILITY_CONTRACT_REF}} revision={{MANAGED_CAPABILITY_CONTRACT_REVISION}}",
      ),
    ).toBe(
      "contract=teamyou.managed-capabilities/v1@2026-09-18.1 revision=2026-09-18.1",
    );

    const uiFiles = [
      "lib/public/js/components/sidebar-dashboard-action.js",
      "lib/public/js/components/dashboard-launcher-modal.js",
      "lib/public/js/components/general/index.js",
    ];
    const uiSource = uiFiles
      .map((file) => fs.readFileSync(path.resolve(file), "utf8"))
      .join("\n");
    expect(uiSource).not.toContain("Launch OpenClaw");
    expect(uiSource).not.toContain("OpenClaw dashboard access");
    expect(uiSource).not.toContain("primary OpenClaw launcher");
    expect(uiSource).toContain("Advanced OpenClaw controls");
    expect(uiSource).toContain("TeamYou's supported managed interface");
  });
});
