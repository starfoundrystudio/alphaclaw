const getGithubBackupConfig = (source = process.env) => {
  const githubToken = String(source?.GITHUB_TOKEN || "").trim();
  const githubRepoInput = String(source?.GITHUB_WORKSPACE_REPO || "").trim();
  const hasGithubToken = !!githubToken;
  const hasGithubRepo = !!githubRepoInput;
  return {
    githubToken,
    githubRepoInput,
    hasGithubToken,
    hasGithubRepo,
    hasGithubBackup: hasGithubToken && hasGithubRepo,
    hasAnyGithubBackupInput: hasGithubToken || hasGithubRepo,
  };
};

const hasGithubBackupConfig = (source = process.env) =>
  getGithubBackupConfig(source).hasGithubBackup;

module.exports = {
  getGithubBackupConfig,
  hasGithubBackupConfig,
};
