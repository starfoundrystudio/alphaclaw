const {
  kAdvancedControlAccessPath,
  kAdvancedControlCookieName,
  normalizeAdvancedControlReturnPath,
} = require("../advanced-control-access");
const {
  kManagedCapabilityContract,
} = require("../managed-capability-contract");

const kAdvancedControlCssPath =
  "/openclaw/_teamyou/advanced-control.css";
const kAdvancedControlScriptPath =
  "/openclaw/_teamyou/advanced-control.js";

// Control UI pages whose settings Clawbridge manages. The read-only config
// guard is gone (beta.5), so these pages get a prominent warning pointing to
// the Clawbridge screen that owns the setting. Paths are relative to the
// /openclaw base and include OpenClaw 2026.9's route aliases.
const kManagedPageWarnings = Object.freeze([
  {
    id: "channels",
    paths: ["/settings/channels", "/channels"],
    title: "Set up channels in Clawbridge",
    body: "Channels added or changed here are not managed. Their tokens stay on this server instead of in Agent Vault, and TeamYou may not support them.",
    href: "/#/general",
    linkLabel: "Open Channels in Clawbridge",
  },
  {
    id: "models",
    paths: [
      "/settings/model-providers",
      "/model-providers",
      "/settings/model-setup",
      "/model-setup",
    ],
    title: "Set up models in Clawbridge",
    body: "Providers and API keys added here are not managed. Keys entered here stay on this server instead of in Agent Vault.",
    href: "/#/models",
    linkLabel: "Open Models in Clawbridge",
  },
  {
    id: "secrets",
    paths: ["/settings/secrets"],
    title: "Keep credentials in Agent Vault",
    body: "Secrets saved here stay on this server. Clawbridge keeps credentials in Agent Vault, off this server.",
    href: "/#/credentials",
    linkLabel: "Open Agent Vault in Clawbridge",
  },
]);

const renderAdvancedControlScript = () => `(() => {
  "use strict";
  const kBase = "/openclaw";
  const kId = "teamyou-managed-page-warning";
  const kWarnings = ${JSON.stringify(kManagedPageWarnings)};
  let dismissedFor = "";
  const currentPath = () => {
    let path = window.location.pathname || "/";
    if (path === kBase || path.startsWith(kBase + "/")) path = path.slice(kBase.length);
    path = path.replace(/\\/+$/, "");
    return path || "/";
  };
  const matchWarning = (path) =>
    kWarnings.find((warning) =>
      warning.paths.some((prefix) => path === prefix || path.startsWith(prefix + "/")),
    ) || null;
  const render = () => {
    if (!document.body) return;
    const path = currentPath();
    const warning = matchWarning(path);
    const existing = document.getElementById(kId);
    if (!warning || dismissedFor === path) {
      if (existing) existing.remove();
      return;
    }
    if (existing && existing.dataset.warning === warning.id) return;
    if (existing) existing.remove();
    const panel = document.createElement("div");
    panel.id = kId;
    panel.dataset.warning = warning.id;
    panel.setAttribute("role", "alert");
    const text = document.createElement("div");
    text.className = "teamyou-managed-page-warning__text";
    const title = document.createElement("strong");
    title.textContent = warning.title;
    const body = document.createElement("span");
    body.textContent = warning.body;
    text.append(title, body);
    const link = document.createElement("a");
    link.className = "teamyou-managed-page-warning__link";
    link.href = warning.href;
    link.textContent = warning.linkLabel;
    const close = document.createElement("button");
    close.type = "button";
    close.className = "teamyou-managed-page-warning__close";
    close.setAttribute("aria-label", "Hide this warning on this page");
    close.textContent = "×";
    close.addEventListener("click", () => {
      dismissedFor = path;
      render();
    });
    panel.append(text, link, close);
    document.body.appendChild(panel);
  };
  const schedule = () => window.setTimeout(render, 0);
  for (const method of ["pushState", "replaceState"]) {
    const original = window.history[method];
    if (typeof original !== "function") continue;
    window.history[method] = function (...args) {
      const result = original.apply(this, args);
      schedule();
      return result;
    };
  }
  window.addEventListener("popstate", schedule);
  window.addEventListener("hashchange", schedule);
  // Some navigations bypass the History API; keep a cheap fallback check.
  window.setInterval(render, 1000);
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", render, { once: true });
  } else {
    render();
  }
})();
`;

const escapeHtml = (value = "") =>
  String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");

const renderAdvancedControlInterstitial = ({ returnTo, service }) => {
  const controlUi = kManagedCapabilityContract.surfaces.controlUi;
  const action = `${kAdvancedControlAccessPath}?returnTo=${encodeURIComponent(returnTo)}`;
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Advanced OpenClaw controls — TeamYou</title>
    <style>
      :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
      * { box-sizing: border-box; }
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px; background: #090d12; color: #f4f7fa; }
      main { width: min(620px, 100%); border: 1px solid #2a3441; border-radius: 18px; padding: 28px; background: #111821; box-shadow: 0 24px 80px rgba(0,0,0,.45); }
      .eyebrow { color: #73d7ee; font-size: 13px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
      h1 { margin: 10px 0 8px; font-size: 26px; line-height: 1.2; }
      p { color: #b5c0cc; line-height: 1.6; }
      .warning { margin: 22px 0; padding: 16px; border: 1px solid #9a6a16; border-radius: 12px; background: #2b210e; }
      .warning strong { display: block; color: #ffd36a; margin-bottom: 7px; }
      label { display: flex; align-items: flex-start; gap: 10px; color: #dce4ec; line-height: 1.45; }
      input { margin-top: 3px; }
      .actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 24px; }
      a, button { border-radius: 9px; padding: 10px 15px; font: inherit; font-weight: 650; text-decoration: none; }
      a { color: #c4ced8; border: 1px solid #3a4654; }
      button { color: #071116; background: #65d2ea; border: 1px solid #65d2ea; cursor: pointer; }
    </style>
  </head>
  <body>
    <main>
      <div class="eyebrow">TeamYou managed OpenClaw</div>
      <h1>Advanced OpenClaw controls</h1>
      <p>Clawbridge is TeamYou's supported managed interface. You do not need this upstream interface for supported managed workflows.</p>
      <div class="warning">
        <strong>${escapeHtml(controlUi.label)}</strong>
        <p>This interface exposes controls outside the managed experience. Set up channels, models, and secrets in Clawbridge: changes made here are not managed and may affect security, performance, reliability, or TeamYou supportability.</p>
      </div>
      <form method="post" action="${escapeHtml(action)}">
        <label>
          <input type="checkbox" name="acknowledged" value="yes" required>
          <span>I understand that I am entering an advanced interface and that workflows or changes available only here may be unsupported by TeamYou.</span>
        </label>
        <div class="actions">
          <a href="/">Return to Clawbridge</a>
          <button type="submit">Acknowledge and continue</button>
        </div>
      </form>
      <p style="font-size: 12px; margin-top: 22px;">Warning ${escapeHtml(service.warningVersion)} · managed configuration ${escapeHtml(service.managedConfigRevision)}</p>
    </main>
  </body>
</html>`;
};

const setAcknowledgementCookie = ({ req, res, service, token }) => {
  res.cookie(
    kAdvancedControlCookieName,
    token,
    service.getCookieOptions(req),
  );
};

const createRequireAdvancedControlAccess = ({ service }) => (req, res, next) => {
  if (service.isAuthorized(req)) return next();
  const method = String(req.method || "GET").toUpperCase();
  const accept = String(req.headers?.accept || "").toLowerCase();
  if ((method === "GET" || method === "HEAD") && accept.includes("text/html")) {
    const returnTo = normalizeAdvancedControlReturnPath(
      req.originalUrl || req.url,
    );
    return res.redirect(
      302,
      `${kAdvancedControlAccessPath}?returnTo=${encodeURIComponent(returnTo)}`,
    );
  }
  if (String(req.originalUrl || "").startsWith("/api/")) {
    return res.status(403).json({
      error: "Advanced OpenClaw access acknowledgement required",
      acknowledgementUrl: kAdvancedControlAccessPath,
    });
  }
  return res
    .status(403)
    .type("text/plain")
    .send("Advanced OpenClaw access acknowledgement required");
};

const registerAdvancedControlRoutes = ({ app, requireAuth, service }) => {
  const requireAdvancedControlAccess = createRequireAdvancedControlAccess({
    service,
  });

  app.get(kAdvancedControlAccessPath, requireAuth, (req, res) => {
    const returnTo = normalizeAdvancedControlReturnPath(req.query?.returnTo);
    if (service.isAuthorized(req)) return res.redirect(302, returnTo);
    res.set("Cache-Control", "no-store");
    res.set(
      "Content-Security-Policy",
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    );
    return res
      .status(200)
      .type("html")
      .send(renderAdvancedControlInterstitial({ returnTo, service }));
  });

  app.post(kAdvancedControlAccessPath, requireAuth, (req, res) => {
    const returnTo = normalizeAdvancedControlReturnPath(req.query?.returnTo);
    try {
      const acknowledgement = service.acknowledge(req);
      setAcknowledgementCookie({
        req,
        res,
        service,
        token: acknowledgement.token,
      });
      return res.redirect(303, returnTo);
    } catch (error) {
      return res
        .status(Number(error?.statusCode || 500))
        .type("text/plain")
        .send(error?.message || "Could not record acknowledgement");
    }
  });

  app.get("/api/advanced-control/status", requireAuth, (req, res) => {
    res.json({ ok: true, ...service.getStatus(req) });
  });

  app.post("/api/advanced-control/acknowledge", requireAuth, (req, res) => {
    try {
      const acknowledgement = service.acknowledge(req);
      setAcknowledgementCookie({
        req,
        res,
        service,
        token: acknowledgement.token,
      });
      return res.json({
        ok: true,
        acknowledged: true,
        acknowledgedAt: acknowledgement.acknowledgedAt,
        auditId: acknowledgement.auditId,
        url: normalizeAdvancedControlReturnPath(req.body?.returnTo),
        warningVersion: service.warningVersion,
        managedConfigRevision: service.managedConfigRevision,
      });
    } catch (error) {
      return res.status(Number(error?.statusCode || 500)).json({
        ok: false,
        error: error?.message || "Could not record acknowledgement",
      });
    }
  });

  app.get("/api/advanced-control/audit", requireAuth, (req, res) => {
    res.json({
      ok: true,
      acknowledgements: service.getAuditEvents({ limit: req.query?.limit }),
    });
  });

  app.get(
    kAdvancedControlCssPath,
    requireAuth,
    requireAdvancedControlAccess,
    (_req, res) => {
      res.set("Cache-Control", "no-store");
      res.type("text/css").send(`
#teamyou-managed-control-warning {
  position: fixed;
  top: 10px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 2147483647;
  max-width: calc(100vw - 24px);
  padding: 7px 12px;
  border: 1px solid #d99a21;
  border-radius: 999px;
  background: #f4b740;
  color: #211604;
  box-shadow: 0 5px 20px rgba(0, 0, 0, .35);
  font: 700 12px/1.25 Inter, ui-sans-serif, system-ui, sans-serif;
  letter-spacing: .01em;
  pointer-events: none;
}
#teamyou-managed-page-warning {
  position: fixed;
  top: 48px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 2147483646;
  box-sizing: border-box;
  width: min(720px, calc(100vw - 24px));
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 14px 16px;
  border: 2px solid #d99a21;
  border-radius: 12px;
  background: #f4b740;
  color: #211604;
  box-shadow: 0 10px 30px rgba(0, 0, 0, .45);
  font: 500 13px/1.4 Inter, ui-sans-serif, system-ui, sans-serif;
}
#teamyou-managed-page-warning .teamyou-managed-page-warning__text {
  display: flex;
  flex-direction: column;
  gap: 3px;
  flex: 1 1 auto;
  min-width: 0;
}
#teamyou-managed-page-warning strong {
  font-size: 15px;
  font-weight: 750;
}
#teamyou-managed-page-warning .teamyou-managed-page-warning__link {
  flex: 0 0 auto;
  padding: 8px 12px;
  border-radius: 8px;
  background: #211604;
  color: #f4b740;
  font-weight: 700;
  text-decoration: none;
  white-space: nowrap;
}
#teamyou-managed-page-warning .teamyou-managed-page-warning__close {
  flex: 0 0 auto;
  border: 0;
  background: transparent;
  color: #211604;
  font: 700 20px/1 Inter, ui-sans-serif, system-ui, sans-serif;
  cursor: pointer;
}
@media (max-width: 640px) {
  #teamyou-managed-page-warning { flex-wrap: wrap; }
}
`);
    },
  );

  app.get(
    kAdvancedControlScriptPath,
    requireAuth,
    requireAdvancedControlAccess,
    (_req, res) => {
      res.set("Cache-Control", "no-store");
      res.type("application/javascript").send(renderAdvancedControlScript());
    },
  );

  return { requireAdvancedControlAccess };
};

module.exports = {
  createRequireAdvancedControlAccess,
  kAdvancedControlCssPath,
  kAdvancedControlScriptPath,
  kManagedPageWarnings,
  registerAdvancedControlRoutes,
  renderAdvancedControlScript,
  renderAdvancedControlInterstitial,
};
