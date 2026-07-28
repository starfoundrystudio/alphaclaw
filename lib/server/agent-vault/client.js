const kDefaultTimeoutMs = 10000;
const kMaxResponseBytes = 1024 * 1024;

const readLimitedResponse = async (response) => {
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > kMaxResponseBytes) {
    throw new Error("Agent Vault response was too large");
  }
  return text;
};

const createAgentVaultClient = ({
  address,
  token,
  vault = "default",
  fetchImpl = global.fetch,
  timeoutMs = kDefaultTimeoutMs,
}) => {
  const baseUrl = new URL(address);
  if (
    baseUrl.protocol !== "http:" ||
    baseUrl.hostname !== "127.0.0.1" ||
    baseUrl.pathname !== "/" ||
    baseUrl.search ||
    baseUrl.hash
  ) {
    throw new Error("Agent Vault API address must use the loopback tunnel");
  }

  const request = async (pathname, options = {}) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    try {
      const response = await fetchImpl(new URL(pathname, baseUrl), {
        ...options,
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${token}`,
          "X-Vault": vault,
          ...(options.body ? { "Content-Type": "application/json" } : {}),
          ...(options.headers || {}),
        },
        signal: controller.signal,
      });
      const raw = await readLimitedResponse(response);
      let payload = {};
      try {
        payload = raw ? JSON.parse(raw) : {};
      } catch {
        throw new Error("Agent Vault returned invalid JSON");
      }
      if (!response.ok) {
        const error = new Error(
          String(payload?.error || `Agent Vault returned HTTP ${response.status}`),
        );
        error.status = response.status;
        throw error;
      }
      return payload;
    } catch (error) {
      if (error?.name === "AbortError") {
        throw new Error("Agent Vault request timed out");
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    discover: () => request("/discover"),
    createProposal: ({ key, description, reason }) =>
      request("/v1/proposals", {
        method: "POST",
        body: JSON.stringify({
          credentials: [
            {
              action: "set",
              key,
              ...(description ? { description } : {}),
            },
          ],
          message: reason,
          user_message: reason,
        }),
      }),
    getProposal: (id) =>
      request(`/v1/proposals/${encodeURIComponent(String(id))}`),
    listProposals: () => request("/v1/proposals"),
  };
};

const fetchAgentVaultCa = async ({
  address,
  fetchImpl = global.fetch,
  timeoutMs = kDefaultTimeoutMs,
}) => {
  const url = new URL("/v1/mitm/ca.pem", address);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") {
    throw new Error("Agent Vault CA must be fetched through the loopback tunnel");
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    const response = await fetchImpl(url, {
      headers: { Accept: "application/x-pem-file" },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`Agent Vault CA returned HTTP ${response.status}`);
    }
    const pem = await readLimitedResponse(response);
    const advertisedPort = Number.parseInt(
      String(response.headers?.get?.("x-mitm-port") || ""),
      10,
    );
    if (advertisedPort !== 14322) {
      throw new Error("Agent Vault proxy port does not match the tunnel contract");
    }
    return pem;
  } finally {
    clearTimeout(timer);
  }
};

module.exports = {
  createAgentVaultClient,
  fetchAgentVaultCa,
};
