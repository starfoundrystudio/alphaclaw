const express = require("express");
const request = require("supertest");
const {
  registerTailscaleRoutes,
} = require("../../lib/server/routes/tailscale");

const createApp = (tailscaleChangeService) => {
  const app = express();
  app.use(express.json());
  registerTailscaleRoutes({ app, tailscaleChangeService });
  return app;
};

describe("server/routes/tailscale", () => {
  it("returns status from the change service", async () => {
    const service = {
      getStatus: vi.fn(async () => ({ ok: true, change: { state: "idle" } })),
    };
    const response = await request(createApp(service)).get(
      "/api/tailscale/status",
    );

    expect(response.status).toBe(200);
    expect(response.body.change.state).toBe("idle");
  });

  it("passes only the token to validation", async () => {
    const service = {
      validateTarget: vi.fn(async () => ({ ok: true })),
    };
    const response = await request(createApp(service))
      .post("/api/tailscale/change/validate")
      .send({
        tailscaleApiToken: "tskey-api-secret",
      });

    expect(response.status).toBe(200);
    expect(service.validateTarget).toHaveBeenCalledWith({
      tailscaleApiToken: "tskey-api-secret",
    });
  });

  it("returns a safe service error", async () => {
    const secret = "tskey-api-secret-value";
    const service = {
      startChange: vi.fn(async () => {
        const error = new Error(`Rejected ${secret}`);
        error.status = 409;
        throw error;
      }),
    };
    const response = await request(createApp(service))
      .post("/api/tailscale/change")
      .send({ tailscaleApiToken: secret });

    expect(response.status).toBe(409);
    expect(JSON.stringify(response.body)).not.toContain(secret);
  });
});
