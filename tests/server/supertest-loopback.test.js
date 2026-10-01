const express = require("express");
const request = require("supertest");

const createApp = () => {
  const app = express();
  app.get("/whoami", (req, res) => {
    res.json({ localAddress: req.socket.localAddress, query: req.query });
  });
  return app;
};

describe("tests/setup/supertest-loopback", () => {
  it("serves request(app) from a server bound to 127.0.0.1 itself", async () => {
    const res = await request(createApp())
      .get("/whoami")
      .query({ probe: "1" });

    expect(res.status).toBe(200);
    // A dual-stack (::) listener would report ::ffff:127.0.0.1 here.
    expect(res.body).toEqual({
      localAddress: "127.0.0.1",
      query: { probe: "1" },
    });
  });

  it("supports callback-style expect and repeated agent requests", async () => {
    const app = createApp();
    await new Promise((resolve, reject) => {
      request(app)
        .get("/whoami")
        .expect(200, (err) => (err ? reject(err) : resolve()));
    });

    const agent = request.agent(app);
    const first = await agent.get("/whoami");
    const second = await agent.get("/whoami");
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body.localAddress).toBe("127.0.0.1");
  });
});
