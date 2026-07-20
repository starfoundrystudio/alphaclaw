const { redactSecretText } = require("../secret-redaction");

const getStatusCode = (error, fallback = 500) => {
  const status = Number(error?.status);
  return status >= 400 && status < 600 ? status : fallback;
};

const getSafeError = (error, fallback) =>
  redactSecretText(String(error?.message || fallback || "Request failed")).slice(
    0,
    500,
  );

const registerTailscaleRoutes = ({ app, tailscaleChangeService }) => {
  app.get("/api/tailscale/status", async (_req, res) => {
    try {
      return res.json(await tailscaleChangeService.getStatus());
    } catch (error) {
      return res.status(getStatusCode(error)).json({
        ok: false,
        error: getSafeError(error, "Could not read Tailscale status"),
      });
    }
  });

  app.post("/api/tailscale/change/validate", async (req, res) => {
    try {
      const result = await tailscaleChangeService.validateTarget({
        tailscaleApiToken: req.body?.tailscaleApiToken,
      });
      return res.json(result);
    } catch (error) {
      return res.status(getStatusCode(error, 502)).json({
        ok: false,
        error: getSafeError(error, "Could not validate the new tailnet"),
      });
    }
  });

  app.post("/api/tailscale/change", async (req, res) => {
    try {
      const result = await tailscaleChangeService.startChange({
        tailscaleApiToken: req.body?.tailscaleApiToken,
        expectedCurrentDns: req.body?.expectedCurrentDns,
      });
      return res.status(202).json(result);
    } catch (error) {
      return res.status(getStatusCode(error, 502)).json({
        ok: false,
        error: getSafeError(error, "Could not start the tailnet change"),
      });
    }
  });
};

module.exports = { registerTailscaleRoutes };
