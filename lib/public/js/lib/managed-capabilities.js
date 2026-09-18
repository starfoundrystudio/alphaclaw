import contract from "../../../managed-capability-contract.json";

export const kManagedCapabilityContract = contract;
export const kManagedCapabilityContractRef =
  `${contract.contractId}/v${contract.schemaVersion}@${contract.revision}`;
export const kAdvancedControlUiLabel = contract.surfaces.controlUi.label;
export const kManagedSurfaceId = contract.surfaces.managed.id;
