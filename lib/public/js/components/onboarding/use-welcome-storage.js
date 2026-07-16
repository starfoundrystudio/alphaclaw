import { useEffect, useState } from "preact/hooks";

import { kOnboardingStorageKey } from "../../lib/storage-keys.js";
import {
  kModelAccessModeStorageKey,
  normalizeModelAccessMode,
} from "../../lib/model-config.js";
export { kOnboardingStorageKey };
export const kOnboardingStepKey = "_step";
export const kOnboardingSetupErrorKey = "_lastSetupError";
export const kOnboardingChannelCredentialKeys = new Set([
  "TELEGRAM_BOT_TOKEN",
  "DISCORD_BOT_TOKEN",
  "SLACK_BOT_TOKEN",
  "SLACK_APP_TOKEN",
  "WHATSAPP_OWNER_NUMBER",
]);
const kStaleOpenAiCodexRouteKeys = [
  "_OPENAI_CODEX_ROUTE",
  "_OPENAI_CODEX_ROUTE_TOUCHED",
];
const kTransientSecretKeys = new Set([
  "TAILSCALE_API_TOKEN",
  "_TAILSCALE_API_TOKEN",
  "tailscaleApiToken",
  "_pairingChannel",
  ...kOnboardingChannelCredentialKeys,
]);

export const normalizeWelcomeStorageState = (state = {}) => {
  const normalized = { ...(state || {}) };
  for (const key of kTransientSecretKeys) {
    delete normalized[key];
  }
  for (const key of kStaleOpenAiCodexRouteKeys) {
    delete normalized[key];
  }
  if (
    normalized[kModelAccessModeStorageKey] &&
    !normalizeModelAccessMode(normalized[kModelAccessModeStorageKey])
  ) {
    delete normalized[kModelAccessModeStorageKey];
  }
  return normalized;
};

const loadInitialSetupState = () => {
  try {
    return normalizeWelcomeStorageState(
      JSON.parse(localStorage.getItem(kOnboardingStorageKey) || "{}"),
    );
  } catch {
    return {};
  }
};

export const normalizeWelcomeStep = (storedStep, kSetupStepIndex) => {
  const parsedStep = Number.parseInt(String(storedStep || ""), 10);
  if (!Number.isFinite(parsedStep)) return 0;
  const setupStepIndex = Math.max(0, Number(kSetupStepIndex) || 0);
  if (parsedStep >= setupStepIndex) return Math.max(0, setupStepIndex - 1);
  return Math.max(0, parsedStep);
};

export const useWelcomeStorage = ({ kSetupStepIndex } = {}) => {
  const [initialSetupState] = useState(loadInitialSetupState);
  const [vals, setVals] = useState(() => ({ ...initialSetupState }));
  const [setupError, setSetupError] = useState(null);
  const [step, setStep] = useState(() =>
    normalizeWelcomeStep(
      initialSetupState?.[kOnboardingStepKey],
      kSetupStepIndex,
    ),
  );

  useEffect(() => {
    const persistedVals = normalizeWelcomeStorageState(vals);
    localStorage.setItem(
      kOnboardingStorageKey,
      JSON.stringify({
        ...persistedVals,
        [kOnboardingStepKey]: step,
        ...(setupError ? { [kOnboardingSetupErrorKey]: setupError } : {}),
      }),
    );
  }, [vals, step, setupError]);

  const setValue = (key, value) => setVals((prev) => ({ ...prev, [key]: value }));

  return {
    vals,
    setVals,
    setValue,
    step,
    setStep,
    setupError,
    setSetupError,
  };
};
