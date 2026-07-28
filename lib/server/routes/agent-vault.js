const resolveStatus = (error, fallback = 500) => {
  const status = Number(error?.status || error?.statusCode || 0);
  return status >= 400 && status < 600 ? status : fallback;
};

const registerAgentVaultRoutes = ({
  app,
  requireAuth,
  agentVaultService,
  restartRequiredState,
}) => {
  app.get("/api/agent-vault/status", requireAuth, async (_req, res) => {
    try {
      const status = await agentVaultService.getStatus({ attemptClaim: true });
      if (status.restartRequired) {
        restartRequiredState?.markRequired?.("agent_vault_broker_enabled");
      }
      res.json({ ok: true, status });
    } catch (error) {
      res
        .status(resolveStatus(error))
        .json({ ok: false, error: error.message });
    }
  });

  app.post("/api/agent-vault/runtime/claim", requireAuth, async (_req, res) => {
    try {
      const result = await agentVaultService.claimRuntimeToken();
      if (result.restartRequired) {
        restartRequiredState?.markRequired?.("agent_vault_broker_enabled");
      }
      res.json({ ok: true, ...result });
    } catch (error) {
      res
        .status(resolveStatus(error))
        .json({ ok: false, error: error.message });
    }
  });

  app.get("/api/agent-vault/credentials", requireAuth, async (_req, res) => {
    try {
      res.json({ ok: true, ...(await agentVaultService.listCredentials()) });
    } catch (error) {
      res
        .status(resolveStatus(error))
        .json({ ok: false, error: error.message });
    }
  });

  app.post("/api/agent-vault/proposals", requireAuth, async (req, res) => {
    if (Object.prototype.hasOwnProperty.call(req.body || {}, "value")) {
      return res.status(400).json({
        ok: false,
        error: "Credential values must be entered directly in Agent Vault",
      });
    }
    try {
      const result = await agentVaultService.ensureCredential({
        key: req.body?.key,
        description: req.body?.description,
        reason: req.body?.reason,
      });
      res.status(result.status === "proposal_created" ? 201 : 200).json({
        ok: true,
        ...result,
      });
    } catch (error) {
      res
        .status(resolveStatus(error, 400))
        .json({ ok: false, error: error.message });
    }
  });

  app.get("/api/agent-vault/proposals/:id", requireAuth, async (req, res) => {
    try {
      res.json({
        ok: true,
        proposal: await agentVaultService.getProposal(req.params.id),
      });
    } catch (error) {
      res
        .status(resolveStatus(error, 400))
        .json({ ok: false, error: error.message });
    }
  });
};

module.exports = { registerAgentVaultRoutes };
