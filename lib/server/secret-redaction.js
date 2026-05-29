const redactSecretText = (value = "") =>
  String(value || "")
    .replace(/tskey-(?:api|auth|client)-[A-Za-z0-9_-]+/g, "***")
    .replace(/ghp_[^\s"']+/g, "***")
    .replace(/github_pat_[^\s"']+/g, "***")
    .replace(/sk-[^\s"']+/g, "***")
    .replace(/vck_[^\s"']+/g, "***")
    .replace(/aigw_[^\s"']+/g, "***")
    .replace(
      /((?:^|\s)(?:"?--[^\s"]*(?:token|key|secret|password)[^\s"]*"?)(?:=|\s+))(?:"[^"]*"|'[^']*'|[^\s]+)/gi,
      '$1"***"',
    )
    .replace(/(?:token|api[_-]?key|secret|password)["'\s:=]+[^\s"']+/gi, (match) =>
      match.replace(/[^\s"':=]+$/g, "***"),
    );

module.exports = { redactSecretText };
