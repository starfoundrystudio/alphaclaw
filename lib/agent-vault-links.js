const parseHttpsOrigin = (value, label) => {
  let parsed;
  try {
    parsed = new URL(String(value || "").trim());
  } catch {
    throw new Error(`${label} is invalid`);
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(`${label} is invalid`);
  }
  return parsed;
};

const normalizeTeamYouAgentVaultEntryUrl = (value) => {
  let parsed;
  try {
    parsed = new URL(String(value || "").trim());
  } catch {
    return "";
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.search ||
    parsed.hash ||
    !/^\/openclaw\/agent-vault\/inst_[A-Za-z0-9_-]+\/?$/.test(
      parsed.pathname,
    )
  ) {
    return "";
  }
  return parsed.toString();
};

const buildTeamYouAgentVaultApprovalUrl = ({
  approvalUrl,
  operatorUrl,
  entryUrl,
}) => {
  const normalizedEntryUrl = normalizeTeamYouAgentVaultEntryUrl(entryUrl);
  if (!normalizedEntryUrl) {
    throw new Error("TeamYou Agent Vault entry URL is unavailable");
  }
  const operator = parseHttpsOrigin(operatorUrl, "Agent Vault operator URL");
  if (!operator.hostname.endsWith(".ts.net")) {
    throw new Error("Agent Vault operator URL is invalid");
  }
  let approval;
  try {
    approval = new URL(String(approvalUrl || "").trim());
  } catch {
    throw new Error("Agent Vault approval URL is invalid");
  }
  if (
    approval.origin !== operator.origin ||
    !/^\/approve\/[1-9][0-9]*$/.test(approval.pathname) ||
    approval.hash ||
    Array.from(approval.searchParams.keys()).some((key) => key !== "token") ||
    approval.searchParams.getAll("token").length !== 1 ||
    !approval.searchParams.get("token")
  ) {
    throw new Error("Agent Vault approval URL is invalid");
  }
  const entry = new URL(normalizedEntryUrl);
  entry.searchParams.set("return_to", `${approval.pathname}${approval.search}`);
  return entry.toString();
};

module.exports = {
  buildTeamYouAgentVaultApprovalUrl,
  normalizeTeamYouAgentVaultEntryUrl,
};
