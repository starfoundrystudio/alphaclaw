const fs = require("fs");
const os = require("os");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const {
  clearApprovedPairingEntriesCache,
  countApprovedSenders,
  readApprovedPairingEntries,
} = require("../../lib/server/openclaw-pairing-store");
const { listConfiguredChannelAccounts } = require("../../lib/server/agents/shared");

// G3 finding #36: OpenClaw 2026.9.5 keeps pairing approvals in
// state/openclaw.sqlite; only the first owner also lands in the config.
const createStateDatabase = (openclawDir, rows) => {
  fs.mkdirSync(path.join(openclawDir, "state"), { recursive: true });
  const db = new DatabaseSync(path.join(openclawDir, "state", "openclaw.sqlite"));
  db.exec(
    "CREATE TABLE channel_pairing_allow_entries (channel_key TEXT, account_id TEXT, entry TEXT, sort_order INTEGER)",
  );
  const insert = db.prepare(
    "INSERT INTO channel_pairing_allow_entries (channel_key, account_id, entry, sort_order) VALUES (?, ?, ?, ?)",
  );
  rows.forEach(([channel, accountId, entry], index) => insert.run(channel, accountId, entry, index));
  db.close();
};

describe("server/openclaw-pairing-store", () => {
  let openclawDir;
  beforeEach(() => {
    clearApprovedPairingEntriesCache();
    openclawDir = fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-pairing-"));
  });
  afterEach(() => {
    clearApprovedPairingEntriesCache();
    fs.rmSync(openclawDir, { recursive: true, force: true });
  });

  it("reads approved senders per channel account", () => {
    createStateDatabase(openclawDir, [
      ["slack", "default", "U07KBTT468P"],
      ["telegram", "default", "1323238301"],
      ["telegram", "work", "42"],
    ]);
    const approved = readApprovedPairingEntries({ openclawDir });
    expect([...approved.get("telegram").get("default")]).toEqual(["1323238301"]);
    expect([...approved.get("telegram").get("work")]).toEqual(["42"]);
  });

  it("counts config allowFrom and stored approvals once each", () => {
    createStateDatabase(openclawDir, [["slack", "default", "U07KBTT468P"]]);
    const approved = readApprovedPairingEntries({ openclawDir });
    expect(
      countApprovedSenders({
        approved,
        channel: "slack",
        accountId: "default",
        inlineAllowFrom: ["U07KBTT468P"],
      }),
    ).toBe(1);
  });

  it("is empty when OpenClaw has no state database", () => {
    expect(readApprovedPairingEntries({ openclawDir }).size).toBe(0);
  });

  it("shows a channel approved only in the state database as paired", () => {
    createStateDatabase(openclawDir, [["telegram", "default", "1323238301"]]);
    const [telegram] = listConfiguredChannelAccounts({
      OPENCLAW_DIR: openclawDir,
      cfg: {
        channels: {
          telegram: {
            enabled: true,
            accounts: { default: { botToken: "__agent_vault_telegram_bot_token__" } },
          },
        },
      },
    });
    expect(telegram.accounts[0]).toMatchObject({ id: "default", paired: 1, status: "paired" });
  });
});
