const kManagedCapabilityContract = require("../managed-capability-contract.json");

const kManagedCapabilityContractRef =
  `${kManagedCapabilityContract.contractId}/v${kManagedCapabilityContract.schemaVersion}` +
  `@${kManagedCapabilityContract.revision}`;

const renderManagedCapabilityContractTokens = (content = "") =>
  String(content)
    .replace(
      /\{\{MANAGED_CAPABILITY_CONTRACT_REF\}\}/g,
      kManagedCapabilityContractRef,
    )
    .replace(
      /\{\{MANAGED_CAPABILITY_CONTRACT_REVISION\}\}/g,
      kManagedCapabilityContract.revision,
    );

module.exports = {
  kManagedCapabilityContract,
  kManagedCapabilityContractRef,
  renderManagedCapabilityContractTokens,
};
