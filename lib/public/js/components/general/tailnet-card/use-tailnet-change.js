import { useState } from "preact/hooks";
import { useCachedFetch } from "../../../hooks/use-cached-fetch.js";
import {
  fetchTailscaleStatus,
  startTailnetChange,
  validateTailnetChange,
} from "../../../lib/api.js";
import { invalidateCache } from "../../../lib/api-cache.js";
import { showToast } from "../../toast.js";

const kStatusCacheKey = "/api/tailscale/status";

export const useTailnetChange = () => {
  const statusQuery = useCachedFetch(kStatusCacheKey, fetchTailscaleStatus, {
    maxAgeMs: 30000,
  });
  const [visible, setVisible] = useState(false);
  const [step, setStep] = useState("token");
  const [token, setToken] = useState("");
  const [validation, setValidation] = useState(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [validating, setValidating] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const reset = () => {
    setStep("token");
    setToken("");
    setValidation(null);
    setAcknowledged(false);
    setError("");
  };

  const open = () => {
    reset();
    setVisible(true);
    statusQuery.refresh({ force: true }).catch(() => {});
  };

  const close = () => {
    if (validating || submitting) return;
    setVisible(false);
    reset();
  };

  const validate = async () => {
    if (!token.trim() || validating) return;
    setValidating(true);
    setError("");
    try {
      const next = await validateTailnetChange(token.trim());
      setValidation(next);
      setStep("review");
    } catch (err) {
      setError(err?.message || "Could not validate the new tailnet");
    } finally {
      setValidating(false);
    }
  };

  const start = async () => {
    if (!validation || !acknowledged || submitting) return;
    setSubmitting(true);
    setError("");
    try {
      await startTailnetChange({
        tailscaleApiToken: token.trim(),
        expectedCurrentDns: validation.currentDns,
      });
      setToken("");
      setStep("reconnect");
      invalidateCache(kStatusCacheKey);
      statusQuery.refresh({ force: true }).catch(() => {});
      showToast("Tailnet change scheduled", "success");
    } catch (err) {
      setError(err?.message || "Could not start the tailnet change");
    } finally {
      setSubmitting(false);
    }
  };

  return {
    statusQuery,
    state: {
      visible,
      step,
      token,
      validation,
      acknowledged,
      validating,
      submitting,
      error,
    },
    actions: {
      open,
      close,
      validate,
      start,
      setToken,
      setAcknowledged,
      back: () => {
        setAcknowledged(false);
        setError("");
        setStep("token");
      },
    },
  };
};
