const { deriveCostBreakdown } = require("./cost-utils");

const kMaxPageSize = 200;
const kDefaultRunsLimit = 20;
const kMaxAnalyticsRuns = 5000;
const kDayMs = 24 * 60 * 60 * 1000;
const kTrendRange24h = "24h";
const kTrendRange7d = "7d";
const kTrendRange30d = "30d";

const toFiniteNumber = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const sanitizeCronJobId = (jobId = "") => {
  const trimmed = String(jobId || "").trim();
  if (!trimmed) throw new Error("Job id is required");
  if (trimmed.includes("/") || trimmed.includes("\\") || trimmed.includes("\0")) {
    throw new Error("Invalid job id");
  }
  return trimmed;
};

const normalizeRunStatus = (value = "all") => {
  const normalized = String(value || "all").trim().toLowerCase();
  return ["ok", "error", "skipped", "all"].includes(normalized)
    ? normalized
    : "all";
};

const normalizeDeliveryStatus = (value = "all") => {
  const normalized = String(value || "all").trim().toLowerCase();
  return ["delivered", "not-delivered", "unknown", "not-requested", "all"].includes(
    normalized,
  )
    ? normalized
    : "all";
};

const normalizeJobs = (value) => {
  const jobs = Array.isArray(value?.jobs) ? value.jobs : [];
  return jobs
    .filter((job) => job && typeof job === "object")
    .map((job) => ({
      ...job,
      id: String(job.id || "").trim(),
      name: String(job.name || "").trim(),
      enabled: job.enabled !== false,
      state: job.state && typeof job.state === "object" ? job.state : {},
      payload: job.payload && typeof job.payload === "object" ? job.payload : {},
      delivery: job.delivery && typeof job.delivery === "object" ? job.delivery : {},
      schedule: job.schedule && typeof job.schedule === "object" ? job.schedule : {},
    }))
    .filter((job) => job.id);
};

const readTokenValue = (source = {}, keys = []) => {
  for (const key of keys) {
    const numericValue = Number(source?.[key]);
    if (Number.isFinite(numericValue) && numericValue >= 0) return numericValue;
  }
  return 0;
};

const enrichRunEntryEstimatedCost = (entry = {}) => {
  const usage = entry?.usage;
  if (!usage || typeof usage !== "object") return entry;
  const existingEstimatedCost = Number(
    usage?.estimatedCost ?? usage?.estimated_cost ?? entry?.estimatedCost ?? entry?.estimated_cost,
  );
  if (Number.isFinite(existingEstimatedCost) && existingEstimatedCost >= 0) {
    return {
      ...entry,
      estimatedCost: existingEstimatedCost,
      usage: { ...usage, estimatedCost: existingEstimatedCost },
    };
  }
  const inputTokens = readTokenValue(usage, ["input_tokens", "inputTokens"]);
  const outputTokens = readTokenValue(usage, ["output_tokens", "outputTokens"]);
  const cacheReadTokens = readTokenValue(usage, ["cache_read_tokens", "cacheReadTokens"]);
  const cacheWriteTokens = readTokenValue(usage, ["cache_write_tokens", "cacheWriteTokens"]);
  if (inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens <= 0) return entry;
  const model = String(entry?.model || usage?.model || "").trim();
  if (!model) return entry;
  const breakdown = deriveCostBreakdown({
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    provider: String(entry?.provider || "").trim(),
    model,
  });
  if (!breakdown.pricingFound) {
    return { ...entry, usage: { ...usage, pricingFound: false } };
  }
  return {
    ...entry,
    estimatedCost: breakdown.totalCost,
    usage: { ...usage, estimatedCost: breakdown.totalCost, pricingFound: true },
  };
};

const startOfLocalDayMs = (valueMs) => {
  const dateValue = new Date(toFiniteNumber(valueMs, 0));
  dateValue.setHours(0, 0, 0, 0);
  return dateValue.getTime();
};

const addLocalDaysMs = (valueMs, dayCount = 0) => {
  const dateValue = new Date(toFiniteNumber(valueMs, 0));
  dateValue.setDate(dateValue.getDate() + Number(dayCount || 0));
  return dateValue.getTime();
};

const readRunEntryTotalTokens = (entry = {}) => {
  const usage = entry?.usage && typeof entry.usage === "object" ? entry.usage : {};
  const componentTotal = [
    usage?.input_tokens,
    usage?.inputTokens,
    usage?.output_tokens,
    usage?.outputTokens,
    usage?.cache_read_tokens,
    usage?.cacheReadTokens,
    usage?.cache_write_tokens,
    usage?.cacheWriteTokens,
  ].reduce((sum, candidate) => {
    const numericValue = Number(candidate);
    return Number.isFinite(numericValue) && numericValue >= 0 ? sum + numericValue : sum;
  }, 0);
  if (componentTotal > 0) return componentTotal;
  for (const candidate of [usage?.total_tokens, usage?.totalTokens, entry?.total_tokens, entry?.totalTokens]) {
    const numericValue = Number(candidate);
    if (Number.isFinite(numericValue) && numericValue >= 0) return numericValue;
  }
  return 0;
};

const readRunEntryEstimatedCost = (entry = {}) => {
  const usage = entry?.usage && typeof entry.usage === "object" ? entry.usage : {};
  for (const candidate of [
    entry?.estimatedCost,
    entry?.estimated_cost,
    usage?.estimatedCost,
    usage?.estimated_cost,
    usage?.totalCost,
    usage?.total_cost,
    usage?.costUsd,
    usage?.cost,
  ]) {
    const numericValue = Number(candidate);
    if (Number.isFinite(numericValue) && numericValue >= 0) return numericValue;
  }
  return null;
};

const buildJobTrends = ({ entries = [], sinceMs = 0, nowMs = Date.now(), range = kTrendRange7d }) => {
  const safeNowMs = toFiniteNumber(nowMs, Date.now());
  const safeSinceMs = toFiniteNumber(sinceMs, 0);
  const normalizedRange = (() => {
    const rawValue = String(range || kTrendRange7d).trim().toLowerCase();
    if (rawValue === kTrendRange24h) return kTrendRange24h;
    if (rawValue === kTrendRange30d) return kTrendRange30d;
    return kTrendRange7d;
  })();
  const rangeConfig = normalizedRange === kTrendRange24h
    ? { bucketCount: 24, bucketMs: 60 * 60 * 1000, alignToLocalDay: false }
    : normalizedRange === kTrendRange30d
      ? { bucketCount: 30, bucketMs: kDayMs, alignToLocalDay: true }
      : { bucketCount: 7, bucketMs: kDayMs, alignToLocalDay: true };
  const windowStartMs = safeSinceMs > 0
    ? (rangeConfig.alignToLocalDay ? startOfLocalDayMs(safeSinceMs) : safeSinceMs)
    : rangeConfig.alignToLocalDay
      ? addLocalDaysMs(startOfLocalDayMs(safeNowMs), -(rangeConfig.bucketCount - 1))
      : safeNowMs - rangeConfig.bucketCount * rangeConfig.bucketMs;
  const pointsByStartMs = new Map();
  for (let index = 0; index < rangeConfig.bucketCount; index += 1) {
    const bucketStartMs = rangeConfig.alignToLocalDay
      ? addLocalDaysMs(windowStartMs, index)
      : windowStartMs + index * rangeConfig.bucketMs;
    const bucketEndMs = index === rangeConfig.bucketCount - 1
      ? safeNowMs
      : rangeConfig.alignToLocalDay
        ? addLocalDaysMs(windowStartMs, index + 1)
        : windowStartMs + (index + 1) * rangeConfig.bucketMs;
    pointsByStartMs.set(bucketStartMs, {
      startMs: bucketStartMs,
      endMs: bucketEndMs,
      ok: 0,
      error: 0,
      skipped: 0,
      totalRuns: 0,
      totalTokens: 0,
      totalCost: 0,
      costSamples: 0,
      totalDurationMs: 0,
      durationSamples: 0,
    });
  }
  for (const rawEntry of entries) {
    const entry = enrichRunEntryEstimatedCost(rawEntry);
    const timestampMs = toFiniteNumber(entry?.ts, 0);
    if (timestampMs <= 0 || timestampMs < windowStartMs || timestampMs > safeNowMs) continue;
    const bucketKey = rangeConfig.alignToLocalDay
      ? startOfLocalDayMs(timestampMs)
      : windowStartMs +
        Math.floor((timestampMs - windowStartMs) / rangeConfig.bucketMs) * rangeConfig.bucketMs;
    const point = pointsByStartMs.get(bucketKey);
    if (!point) continue;
    point.totalRuns += 1;
    const status = String(entry?.status || "").trim().toLowerCase();
    if (["ok", "error", "skipped"].includes(status)) point[status] += 1;
    point.totalTokens += readRunEntryTotalTokens(entry);
    const estimatedCost = readRunEntryEstimatedCost(entry);
    if (estimatedCost != null) {
      point.totalCost += estimatedCost;
      point.costSamples += 1;
    }
    const durationMs = toFiniteNumber(entry?.durationMs, -1);
    if (durationMs >= 0) {
      point.totalDurationMs += durationMs;
      point.durationSamples += 1;
    }
  }
  return {
    sinceMs: windowStartMs,
    nowMs: safeNowMs,
    bucket: rangeConfig.alignToLocalDay ? "day" : "hour",
    range: normalizedRange,
    points: Array.from(pointsByStartMs.values()).map((point) => ({
      ...point,
      avgDurationMs: point.durationSamples > 0
        ? Math.round(point.totalDurationMs / point.durationSamples)
        : 0,
    })),
  };
};

const createCronService = ({ requestGateway, getSessionUsageByKeyPattern }) => {
  if (typeof requestGateway !== "function") {
    throw new Error("createCronService requires requestGateway");
  }

  const requestCron = async (method, params = {}, timeoutMs) => ({
    raw: "",
    parsed: await requestGateway(method, params, timeoutMs),
  });

  const listJobs = async ({ sortBy = "nextRunAtMs", sortDir = "asc" } = {}) => {
    const jobs = [];
    let offset = 0;
    let storePath = "";
    for (;;) {
      const page = await requestGateway("cron.list", {
        includeDisabled: true,
        limit: kMaxPageSize,
        offset,
        sortBy,
        sortDir: String(sortDir || "asc").toLowerCase() === "desc" ? "desc" : "asc",
      });
      storePath ||= String(page?.storePath || "");
      jobs.push(...normalizeJobs(page));
      if (!page?.hasMore || page?.nextOffset == null || page.nextOffset <= offset) break;
      offset = page.nextOffset;
    }
    return {
      storePath,
      jobs,
    };
  };

  const getStatus = async () => requestGateway("cron.status", {});

  const runJobNow = async (jobId) =>
    requestCron("cron.run", { id: sanitizeCronJobId(jobId), mode: "force" }, 600000);

  const setJobEnabled = async ({ jobId, enabled }) =>
    requestCron("cron.update", {
      id: sanitizeCronJobId(jobId),
      patch: { enabled: enabled === true },
    });

  const updateJobPrompt = async ({ jobId, message }) => {
    const safeJobId = sanitizeCronJobId(jobId);
    const normalizedMessage = String(message || "").trim();
    if (!normalizedMessage) throw new Error("Prompt is required");
    const job = await requestGateway("cron.get", { id: safeJobId });
    const payloadKind = String(job?.payload?.kind || "").trim();
    if (payloadKind !== "systemEvent" && payloadKind !== "agentTurn") {
      throw new Error(`unsupported cron payload kind: ${payloadKind || "unknown"}`);
    }
    const payload = payloadKind === "systemEvent"
      ? { kind: "systemEvent", text: normalizedMessage }
      : { kind: "agentTurn", message: normalizedMessage };
    return requestCron("cron.update", { id: safeJobId, patch: { payload } });
  };

  const updateJobRouting = async ({
    jobId,
    sessionTarget,
    wakeMode,
    deliveryMode,
    deliveryChannel,
    deliveryTo,
  }) => {
    const patch = {};
    const normalizedSessionTarget = String(sessionTarget || "").trim();
    if (normalizedSessionTarget) {
      if (
        !["main", "isolated", "current"].includes(normalizedSessionTarget) &&
        !normalizedSessionTarget.startsWith("session:")
      ) {
        throw new Error("sessionTarget must be main, isolated, current, or session:<id>");
      }
      patch.sessionTarget = normalizedSessionTarget;
    }
    const normalizedWakeMode = String(wakeMode || "").trim().toLowerCase();
    if (normalizedWakeMode) {
      if (!["now", "next-heartbeat"].includes(normalizedWakeMode)) {
        throw new Error("wakeMode must be now or next-heartbeat");
      }
      patch.wakeMode = normalizedWakeMode;
    }
    const normalizedDeliveryMode = String(deliveryMode || "").trim().toLowerCase();
    if (normalizedDeliveryMode) {
      if (!["announce", "none", "webhook"].includes(normalizedDeliveryMode)) {
        throw new Error("deliveryMode must be announce, none, or webhook");
      }
      patch.delivery = { mode: normalizedDeliveryMode };
      const channel = String(deliveryChannel || "").trim();
      const to = String(deliveryTo || "").trim();
      if (channel) patch.delivery.channel = channel;
      if (to) patch.delivery.to = to;
    }
    if (Object.keys(patch).length === 0) throw new Error("At least one routing field is required");
    return requestCron("cron.update", { id: sanitizeCronJobId(jobId), patch });
  };

  const getJobRuns = async ({
    jobId,
    limit = kDefaultRunsLimit,
    offset = 0,
    status = "all",
    deliveryStatus = "all",
    sortDir = "desc",
    query = "",
  }) => {
    const safeLimit = Math.max(1, Math.min(kMaxPageSize, Number.parseInt(String(limit), 10) || kDefaultRunsLimit));
    const params = {
      scope: "job",
      id: sanitizeCronJobId(jobId),
      limit: safeLimit,
      offset: Math.max(0, Number.parseInt(String(offset), 10) || 0),
      sortDir: String(sortDir || "desc").toLowerCase() === "asc" ? "asc" : "desc",
    };
    const normalizedStatus = normalizeRunStatus(status);
    const normalizedDeliveryStatus = normalizeDeliveryStatus(deliveryStatus);
    const normalizedQuery = String(query || "").trim();
    if (normalizedStatus !== "all") params.status = normalizedStatus;
    if (normalizedDeliveryStatus !== "all") params.deliveryStatus = normalizedDeliveryStatus;
    if (normalizedQuery) params.query = normalizedQuery;
    const page = await requestGateway("cron.runs", params);
    const entries = Array.isArray(page?.entries) ? page.entries : [];
    return {
      entries: entries.map(enrichRunEntryEstimatedCost),
      total: toFiniteNumber(page?.total, entries.length),
      offset: toFiniteNumber(page?.offset, params.offset),
      limit: toFiniteNumber(page?.limit, safeLimit),
      hasMore: page?.hasMore === true,
      nextOffset:
        page?.nextOffset != null && Number.isFinite(Number(page.nextOffset))
          ? Number(page.nextOffset)
          : null,
    };
  };

  const loadAnalyticsRuns = async ({ jobId, sinceMs = 0 }) => {
    const entries = [];
    let offset = 0;
    while (entries.length < kMaxAnalyticsRuns) {
      const page = await getJobRuns({
        jobId,
        limit: kMaxPageSize,
        offset,
        sortDir: "desc",
      });
      for (const entry of page.entries) {
        if (sinceMs > 0 && toFiniteNumber(entry?.ts, 0) < sinceMs) continue;
        entries.push(entry);
      }
      const oldest = page.entries.at(-1);
      if (
        !page.hasMore ||
        page.nextOffset == null ||
        page.nextOffset <= offset ||
        (sinceMs > 0 && oldest && toFiniteNumber(oldest?.ts, 0) < sinceMs)
      ) break;
      offset = page.nextOffset;
    }
    return entries.slice(0, kMaxAnalyticsRuns);
  };

  const getJobUsage = async ({ jobId, sinceMs = 0 }) => {
    const safeJobId = sanitizeCronJobId(jobId);
    const safeSinceMs = toFiniteNumber(sinceMs, 0);
    const [usage, entries] = await Promise.all([
      Promise.resolve(getSessionUsageByKeyPattern({
        keyPattern: `%:cron:${safeJobId}%`,
        sinceMs: safeSinceMs,
      })),
      loadAnalyticsRuns({ jobId: safeJobId, sinceMs: safeSinceMs }),
    ]);
    const durations = entries
      .map((entry) => toFiniteNumber(entry?.durationMs, -1))
      .filter((durationMs) => durationMs >= 0);
    const totalDurationMs = durations.reduce((sum, value) => sum + value, 0);
    return {
      ...usage,
      totals: {
        ...(usage?.totals || {}),
        totalDurationMs,
        durationSamples: durations.length,
        avgDurationMs: durations.length > 0 ? Math.round(totalDurationMs / durations.length) : 0,
      },
    };
  };

  const getBulkJobUsage = async ({ sinceMs = 0 } = {}) => {
    const { jobs } = await listJobs({ sortBy: "name", sortDir: "asc" });
    const safeSinceMs = toFiniteNumber(sinceMs, 0);
    const rows = await Promise.all(jobs.map(async (job) => {
      const usage = await getJobUsage({ jobId: job.id, sinceMs: safeSinceMs });
      const totals = usage?.totals || {};
      const runCount = toFiniteNumber(totals.runCount, 0);
      const totalTokens = toFiniteNumber(totals.totalTokens, 0);
      return [job.id, {
        totalTokens,
        totalCost: toFiniteNumber(totals.totalCost, 0),
        runCount,
        avgTokensPerRun: runCount > 0 ? Math.round(totalTokens / runCount) : 0,
      }];
    }));
    return { sinceMs: safeSinceMs, byJobId: Object.fromEntries(rows) };
  };

  const getBulkJobRuns = async ({
    sinceMs = 0,
    limitPerJob = kDefaultRunsLimit,
    status = "all",
    deliveryStatus = "all",
    sortDir = "desc",
    query = "",
  } = {}) => {
    const safeSinceMs = toFiniteNumber(sinceMs, 0);
    const safeLimit = Math.max(1, Math.min(kMaxPageSize, Number.parseInt(String(limitPerJob), 10) || kDefaultRunsLimit));
    const byJobId = {};
    let offset = 0;
    let scanned = 0;
    for (;;) {
      const page = await requestGateway("cron.runs", {
        scope: "all",
        limit: kMaxPageSize,
        offset,
        sortDir: String(sortDir || "desc").toLowerCase() === "asc" ? "asc" : "desc",
        ...(normalizeRunStatus(status) !== "all" ? { status: normalizeRunStatus(status) } : {}),
        ...(normalizeDeliveryStatus(deliveryStatus) !== "all"
          ? { deliveryStatus: normalizeDeliveryStatus(deliveryStatus) }
          : {}),
        ...(String(query || "").trim() ? { query: String(query).trim() } : {}),
      });
      const pageEntries = Array.isArray(page?.entries) ? page.entries : [];
      for (const rawEntry of pageEntries) {
        const entry = enrichRunEntryEstimatedCost(rawEntry);
        if (safeSinceMs > 0 && toFiniteNumber(entry?.ts, 0) < safeSinceMs) continue;
        const jobId = String(entry?.jobId || "").trim();
        if (!jobId) continue;
        const bucket = byJobId[jobId] || { entries: [], total: 0 };
        if (bucket.entries.length < safeLimit) bucket.entries.push(entry);
        bucket.total += 1;
        byJobId[jobId] = bucket;
      }
      scanned += pageEntries.length;
      const oldest = pageEntries.at(-1);
      const passedSince =
        String(sortDir || "desc").toLowerCase() !== "asc" &&
        safeSinceMs > 0 &&
        oldest &&
        toFiniteNumber(oldest?.ts, 0) < safeSinceMs;
      if (
        scanned >= kMaxAnalyticsRuns ||
        passedSince ||
        !page?.hasMore ||
        page?.nextOffset == null ||
        page.nextOffset <= offset
      ) break;
      offset = page.nextOffset;
    }
    return { sinceMs: safeSinceMs, byJobId };
  };

  const getJobRunTrends = async ({ jobId, sinceMs = 0, range = kTrendRange7d }) => {
    const entries = await loadAnalyticsRuns({
      jobId: sanitizeCronJobId(jobId),
      sinceMs: toFiniteNumber(sinceMs, 0),
    });
    return buildJobTrends({ entries, sinceMs, range });
  };

  return {
    listJobs,
    getStatus,
    runJobNow,
    setJobEnabled,
    updateJobPrompt,
    updateJobRouting,
    getJobRuns,
    getJobUsage,
    getJobRunTrends,
    getBulkJobUsage,
    getBulkJobRuns,
  };
};

module.exports = { createCronService };
