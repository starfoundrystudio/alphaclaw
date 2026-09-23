"use strict";

// Approved channel senders. OpenClaw 2026.9 stores pairing approvals in its
// state database (`channel_pairing_allow_entries`); only the first owner is
// also bootstrapped into openclaw.json (`commands.ownerAllowFrom` and that
// channel's `allowFrom`). Reading only the config showed every later channel
// as "Awaiting pairing" after approval (G3 finding #36). Neither
// `openclaw pairing list` nor `channels.pairing.list` returns approved
// senders, so read the table directly, read-only.

const fs = require("fs");
const path = require("path");

const kCacheTtlMs = 3000;
let cache = { key: "", at: 0, value: null };

const resolveStateDatabasePath = (openclawDir) =>
  path.join(String(openclawDir || ""), "state", "openclaw.sqlite");

const normalizeAccountId = (value) =>
  String(value || "").trim().toLowerCase() || "default";

// Returns Map<channel, Map<accountId, Set<entry>>>. Empty when the database,
// the table, or node:sqlite is unavailable (older OpenClaw lines).
const readApprovedPairingEntries = ({
  openclawDir,
  fsModule = fs,
  loadSqlite = () => require("node:sqlite"),
  now = Date.now,
} = {}) => {
  const databasePath = resolveStateDatabasePath(openclawDir);
  if (cache.value && cache.key === databasePath && now() - cache.at < kCacheTtlMs) {
    return cache.value;
  }
  const result = new Map();
  let db = null;
  try {
    if (!fsModule.existsSync(databasePath)) return result;
    const sqlite = loadSqlite();
    db = new sqlite.DatabaseSync(databasePath, { readOnly: true });
    db.exec("PRAGMA busy_timeout = 2000;");
    const hasTable = db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'channel_pairing_allow_entries' LIMIT 1",
      )
      .get();
    if (!hasTable) return result;
    const rows = db
      .prepare(
        "SELECT channel_key, account_id, entry FROM channel_pairing_allow_entries",
      )
      .all();
    for (const row of rows) {
      const channel = String(row?.channel_key || "").trim();
      const entry = String(row?.entry || "").trim();
      if (!channel || !entry) continue;
      const accounts = result.get(channel) || new Map();
      const accountId = normalizeAccountId(row?.account_id);
      const entries = accounts.get(accountId) || new Set();
      entries.add(entry);
      accounts.set(accountId, entries);
      result.set(channel, accounts);
    }
  } catch {
    return result;
  } finally {
    try {
      db?.close();
    } catch {}
  }
  cache = { key: databasePath, at: now(), value: result };
  return result;
};

// Distinct approved senders for one channel account: the config's inline
// allowFrom plus the state database's approvals.
const countApprovedSenders = ({ approved, channel, accountId, inlineAllowFrom }) => {
  const entries = new Set(
    (Array.isArray(inlineAllowFrom) ? inlineAllowFrom : [])
      .map((entry) => String(entry || "").trim())
      .filter(Boolean),
  );
  const stored = approved?.get(String(channel || "").trim())?.get(normalizeAccountId(accountId));
  for (const entry of stored || []) entries.add(entry);
  return entries.size;
};

const clearApprovedPairingEntriesCache = () => {
  cache = { key: "", at: 0, value: null };
};

module.exports = {
  clearApprovedPairingEntriesCache,
  countApprovedSenders,
  readApprovedPairingEntries,
};
