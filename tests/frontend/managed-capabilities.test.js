describe("frontend/managed-capabilities", () => {
  it("uses the canonical managed capability contract", async () => {
    const capabilities = await import(
      "../../lib/public/js/lib/managed-capabilities.js"
    );

    expect(capabilities.kManagedCapabilityContractRef).toBe(
      "teamyou.managed-capabilities/v1@2026-09-22.1",
    );
    expect(capabilities.kManagedSurfaceId).toBe("clawbridge");
    expect(capabilities.kAdvancedControlUiLabel).toBe(
      "Advanced — unmanaged changes",
    );
    expect(
      capabilities.kManagedCapabilityContract.surfaces.controlUi
        .hostedClawbridgeSections,
    ).toBe(false);
  });
});
