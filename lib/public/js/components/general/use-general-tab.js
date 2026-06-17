import { useEffect, useRef, useState } from "preact/hooks";
import {
  approvePairing,
  fetchPairings,
  rejectPairing,
  triggerWatchdogRepair,
  updateSyncCron,
} from "../../lib/api.js";
import { usePolling } from "../../hooks/usePolling.js";
import { showToast } from "../toast.js";
import { ALL_CHANNELS } from "../channels.js";
import {
  derivePairingsPollingEnabled,
  shouldEnableRecurringPairingsPolling,
  shouldPrimePairingsFetch,
} from "./helpers.js";

const kDefaultSyncCronSchedule = "0 * * * *";

export const useGeneralTab = ({
  statusData = null,
  watchdogData = null,
  doctorStatusData = null,
  onRefreshStatuses = () => {},
  isActive = false,
  restartSignal = 0,
} = {}) => {
  const [repairingWatchdog, setRepairingWatchdog] = useState(false);
  const [syncCronEnabled, setSyncCronEnabled] = useState(true);
  const [syncCronSchedule, setSyncCronSchedule] = useState(kDefaultSyncCronSchedule);
  const [savingSyncCron, setSavingSyncCron] = useState(false);
  const [syncCronChoice, setSyncCronChoice] = useState(kDefaultSyncCronSchedule);
  const [pairingStatusRefreshing, setPairingStatusRefreshing] = useState(false);
  const [pairingsPollingEnabled, setPairingsPollingEnabled] = useState(false);
  const pairingRefreshTimerRef = useRef(null);

  const status = statusData;
  const watchdogStatus = watchdogData;
  const doctorStatus = doctorStatusData;
  const gatewayStatus = status?.gateway ?? null;
  const channels = status?.channels ?? null;
  const repo = status?.repo || null;
  const syncCron = status?.syncCron || null;
  const openclawVersion = status?.openclawVersion || null;

  const hasUnpaired = ALL_CHANNELS.some((channel) => {
    const info = channels?.[channel];
    if (!info) return false;
    const accounts =
      info.accounts && typeof info.accounts === "object" ? info.accounts : {};
    if (Object.keys(accounts).length > 0) {
      return Object.values(accounts).some(
        (acc) => acc && acc.status !== "paired",
      );
    }
    return info.status !== "paired";
  });
  const hasConfiguredPairingChannel = ALL_CHANNELS.some((channel) =>
    Boolean(channels?.[channel]),
  );

  const pairingsPoll = usePolling(
    async () => {
      const data = await fetchPairings();
      const nextPending = data.pending || [];
      setPairingsPollingEnabled(derivePairingsPollingEnabled(nextPending));
      return nextPending;
    },
    3000,
    {
      enabled: shouldEnableRecurringPairingsPolling({
        hasUnpaired,
        gatewayStatus,
        pairingsPollingEnabled,
      }),
      cacheKey: "/api/pairings",
      dedupeInFlight: true,
    },
  );
  const pending = pairingsPoll.data || [];

  useEffect(() => {
    if (hasUnpaired && gatewayStatus === "running") return;
    setPairingsPollingEnabled(false);
  }, [gatewayStatus, hasUnpaired]);

  useEffect(() => {
    if (shouldPrimePairingsFetch({ isActive, hasUnpaired, gatewayStatus })) {
      pairingsPoll.refresh();
    }
  }, [
    gatewayStatus,
    hasUnpaired,
    isActive,
    onRefreshStatuses,
    pairingsPoll.refresh,
  ]);

  useEffect(() => {
    if (!restartSignal || !isActive) return;
    onRefreshStatuses();
    pairingsPoll.refresh({ force: true });
    const t1 = setTimeout(() => {
      onRefreshStatuses();
      pairingsPoll.refresh();
    }, 1200);
    const t2 = setTimeout(() => {
      onRefreshStatuses();
      pairingsPoll.refresh();
    }, 3500);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, [
    isActive,
    onRefreshStatuses,
    pairingsPoll.refresh,
    restartSignal,
  ]);

  useEffect(() => {
    if (!syncCron) return;
    setSyncCronEnabled(syncCron.enabled !== false);
    setSyncCronSchedule(syncCron.schedule || kDefaultSyncCronSchedule);
    setSyncCronChoice(
      syncCron.enabled === false ? "disabled" : syncCron.schedule || kDefaultSyncCronSchedule,
    );
  }, [syncCron?.enabled, syncCron?.schedule]);

  useEffect(
    () => () => {
      if (pairingRefreshTimerRef.current) {
        clearTimeout(pairingRefreshTimerRef.current);
      }
    },
    [],
  );

  const refreshAfterPairingAction = () => {
    setPairingStatusRefreshing(true);
    if (pairingRefreshTimerRef.current) {
      clearTimeout(pairingRefreshTimerRef.current);
    }
    pairingRefreshTimerRef.current = setTimeout(() => {
      setPairingStatusRefreshing(false);
      pairingRefreshTimerRef.current = null;
    }, 2800);
    onRefreshStatuses();
    pairingsPoll.refresh({ force: true });
    setTimeout(() => {
      onRefreshStatuses();
      pairingsPoll.refresh();
    }, 700);
    setTimeout(() => {
      onRefreshStatuses();
      pairingsPoll.refresh();
    }, 1800);
  };

  const saveSyncCronSettings = async ({
    enabled = syncCronEnabled,
    schedule = syncCronSchedule,
  } = {}) => {
    if (savingSyncCron) return;
    setSavingSyncCron(true);
    try {
      const data = await updateSyncCron({ enabled, schedule });
      if (!data.ok) {
        throw new Error(data.error || "Could not save sync settings");
      }
      showToast("Sync schedule updated", "success");
      onRefreshStatuses();
    } catch (err) {
      showToast(err.message || "Could not save sync settings", "error");
    } finally {
      setSavingSyncCron(false);
    }
  };

  const handleSyncCronChoiceChange = async (nextChoice) => {
    setSyncCronChoice(nextChoice);
    const nextEnabled = nextChoice !== "disabled";
    const nextSchedule = nextEnabled ? nextChoice : syncCronSchedule;
    setSyncCronEnabled(nextEnabled);
    setSyncCronSchedule(nextSchedule);
    await saveSyncCronSettings({
      enabled: nextEnabled,
      schedule: nextSchedule,
    });
  };

  const handleApprove = async (id, channel, accountId = "") => {
    try {
      const result = await approvePairing(id, channel, accountId);
      if (!result.ok) throw new Error(result.error || "Could not approve pairing");
      refreshAfterPairingAction();
    } catch (err) {
      showToast(err.message || "Could not approve pairing", "error");
      throw err;
    }
  };

  const handleReject = async (id, channel, accountId = "") => {
    try {
      await rejectPairing(id, channel, accountId);
      refreshAfterPairingAction();
    } catch (err) {
      showToast(err.message || "Could not reject pairing", "error");
      throw err;
    }
  };

  const handleWatchdogRepair = async () => {
    if (repairingWatchdog) return;
    setRepairingWatchdog(true);
    try {
      const data = await triggerWatchdogRepair();
      if (!data.ok) throw new Error(data.error || "Repair failed");
      showToast("Repair triggered", "success");
      setTimeout(() => {
        onRefreshStatuses();
      }, 800);
    } catch (err) {
      showToast(err.message || "Could not run repair", "error");
    } finally {
      setRepairingWatchdog(false);
    }
  };

  return {
    state: {
      channels,
      doctorStatus,
      gatewayStatus,
      hasUnpaired,
      openclawVersion,
      pending,
      pairingsPolling: pairingsPoll.isPolling,
      pairingStatusRefreshing,
      repairingWatchdog,
      repo,
      savingSyncCron,
      syncCron,
      syncCronChoice,
      syncCronEnabled,
      syncCronSchedule,
      syncCronStatusText: syncCronEnabled ? "Enabled" : "Disabled",
      watchdogStatus,
    },
    actions: {
      handleApprove,
      handleReject,
      handleSyncCronChoiceChange,
      handleWatchdogRepair,
    },
  };
};
