import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import {
  listSlackWorkspaceMembers,
  pollTelegramOwnerCapture,
  startTelegramOwnerCapture,
} from "../../../lib/api.js";

const kOwnerSeedProviders = new Set(["telegram", "discord", "slack"]);
const kSlackMemberResultLimit = 8;

const toDiscordOwner = (person) =>
  person?.id
    ? {
        id: String(person.id),
        name: person.name || person.username || "Discord user",
        detail: person.username ? `@${person.username}` : "",
        avatarUrl: person.avatarUrl || "",
      }
    : null;

const toSlackOwner = (member) =>
  member?.id
    ? {
        id: String(member.id),
        name: member.name || member.realName || member.handle || "Slack user",
        detail:
          member.realName && member.realName !== member.name
            ? member.realName
            : member.handle
              ? `@${member.handle}`
              : "",
        avatarUrl: member.avatarUrl || "",
      }
    : null;

const toTelegramOwner = (person) =>
  person?.id
    ? {
        id: String(person.id),
        name: person.name || "Telegram user",
        detail: person.username ? `@${person.username}` : "",
        avatarUrl: "",
      }
    : null;

export const matchesSlackMemberQuery = (member, query) => {
  const terms = String(query || "")
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  if (terms.length === 0) return true;
  const haystack = [member?.name, member?.realName, member?.handle]
    .map((value) => String(value || "").toLowerCase())
    .join(" ");
  return terms.every((term) => haystack.includes(term));
};

// Owner step of the create-channel modal. `ready` means the bot's tokens
// are verified (or the vault placeholders are active), so the platform can
// be asked who the owner is. Choosing "pairing" keeps today's DM pairing.
export const useChannelOwner = ({
  visible = false,
  provider = "",
  enabled = false,
  ready = false,
  token = "",
  discordBot = null,
}) => {
  const supported = enabled && kOwnerSeedProviders.has(provider);
  const [choice, setChoice] = useState("owner");
  const [owner, setOwner] = useState(null);
  const [slackMembers, setSlackMembers] = useState([]);
  const [slackTruncated, setSlackTruncated] = useState(false);
  const [slackQuery, setSlackQuery] = useState("");
  const [slackLoading, setSlackLoading] = useState(false);
  const [lookupError, setLookupError] = useState("");
  const [telegramLink, setTelegramLink] = useState(null);
  const [telegramWaiting, setTelegramWaiting] = useState(false);
  const [showCandidates, setShowCandidates] = useState(false);
  const pollGeneration = useRef(0);
  const normalizedToken = String(token || "").trim();
  const active = visible && supported && ready && !!normalizedToken;

  useEffect(() => {
    pollGeneration.current += 1;
    setChoice("owner");
    setOwner(null);
    setSlackMembers([]);
    setSlackTruncated(false);
    setSlackQuery("");
    setSlackLoading(false);
    setLookupError("");
    setTelegramLink(null);
    setTelegramWaiting(false);
    setShowCandidates(false);
  }, [visible, provider, normalizedToken, ready]);

  useEffect(() => {
    if (!active || provider !== "discord") return;
    setOwner(toDiscordOwner(discordBot?.owner));
  }, [active, provider, discordBot]);

  const loadSlackMembers = async () => {
    setSlackLoading(true);
    setLookupError("");
    try {
      const result = await listSlackWorkspaceMembers(normalizedToken);
      setSlackMembers(Array.isArray(result?.members) ? result.members : []);
      setSlackTruncated(!!result?.truncated);
    } catch (error) {
      setLookupError(error.message || "Could not load Slack members");
    } finally {
      setSlackLoading(false);
    }
  };

  const loadTelegramLink = async () => {
    setLookupError("");
    try {
      const result = await startTelegramOwnerCapture(normalizedToken);
      setTelegramLink({ url: result.link, nonce: result.nonce });
      return result;
    } catch (error) {
      setLookupError(error.message || "Could not create the Telegram link");
      return null;
    }
  };

  useEffect(() => {
    if (!active) return;
    if (provider === "slack") loadSlackMembers();
    if (provider === "telegram") loadTelegramLink();
  }, [active, provider]);

  useEffect(
    () => () => {
      pollGeneration.current += 1;
    },
    [],
  );

  const waitForTelegramStart = async () => {
    if (!telegramLink?.nonce || telegramWaiting) return;
    const generation = ++pollGeneration.current;
    let nonce = telegramLink.nonce;
    setTelegramWaiting(true);
    setLookupError("");
    try {
      while (generation === pollGeneration.current) {
        try {
          const result = await pollTelegramOwnerCapture({
            token: normalizedToken,
            nonce,
          });
          if (generation !== pollGeneration.current) return;
          if (result?.owner) {
            setOwner(toTelegramOwner(result.owner));
            return;
          }
        } catch (error) {
          if (generation !== pollGeneration.current) return;
          if (String(error.message || "").includes("expired")) {
            // The link outlived its 10 minutes: hand out a fresh one and let
            // the owner tap again.
            const fresh = await loadTelegramLink();
            nonce = fresh?.nonce || "";
            if (!nonce) return;
            setLookupError("That link expired. Open Telegram again to confirm.");
            return;
          }
          setLookupError(error.message || "Could not check Telegram");
          return;
        }
      }
    } finally {
      if (generation === pollGeneration.current) setTelegramWaiting(false);
    }
  };

  const cancelTelegramWait = () => {
    pollGeneration.current += 1;
    setTelegramWaiting(false);
  };

  const filteredSlackMembers = useMemo(
    () =>
      slackMembers
        .filter((member) => matchesSlackMemberQuery(member, slackQuery))
        .slice(0, kSlackMemberResultLimit),
    [slackMembers, slackQuery],
  );

  const discordCandidates = useMemo(
    () =>
      (Array.isArray(discordBot?.ownerCandidates)
        ? discordBot.ownerCandidates
        : []
      )
        .map(toDiscordOwner)
        .filter(Boolean),
    [discordBot],
  );

  const ownerId = active && choice === "owner" && owner?.id ? owner.id : "";

  return {
    supported,
    active,
    choice,
    owner,
    ownerId,
    lookupError,
    useOwner: () => setChoice("owner"),
    usePairing: () => {
      cancelTelegramWait();
      setChoice("pairing");
    },
    clearOwner: () => {
      setOwner(null);
      setShowCandidates(true);
      // A captured link is single-use; confirming someone else needs a new one.
      if (provider === "telegram") loadTelegramLink();
    },
    discord: {
      candidates: discordCandidates,
      showCandidates,
      setShowCandidates,
      selectCandidate: (candidate) => {
        setOwner(candidate);
        setShowCandidates(false);
      },
    },
    slack: {
      loading: slackLoading,
      query: slackQuery,
      setQuery: setSlackQuery,
      members: filteredSlackMembers,
      hasMembers: slackMembers.length > 0,
      truncated: slackTruncated,
      retry: loadSlackMembers,
      selectMember: (member) => setOwner(toSlackOwner(member)),
    },
    telegram: {
      link: telegramLink?.url || "",
      waiting: telegramWaiting,
      waitForStart: waitForTelegramStart,
      cancel: cancelTelegramWait,
      retry: loadTelegramLink,
    },
  };
};
