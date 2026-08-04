const kCredentialKeyPattern = /^[A-Z][A-Z0-9_]{1,127}$/;
const kServiceNamePattern =
  /^[a-z0-9](?:[a-z0-9-]{1,62}[a-z0-9])$/;
const kHeaderNamePattern = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const kPlaceholderPattern = /^[A-Za-z0-9_.~-]+$/;
const kSubstitutionSurfaces = new Set([
  "path",
  "query",
  "header",
  "body",
  "websocket",
]);
const kMaxCredentials = 10;
const kMaxSubstitutions = 10;

const normalizeText = (value, maxLength, label, { required = true } = {}) => {
  const normalized = String(value || "").trim();
  if (
    (required && !normalized) ||
    normalized.length > maxLength ||
    normalized.includes("\0")
  ) {
    throw new Error(`${label} is missing or invalid`);
  }
  return normalized;
};

const validateCredentialKey = (value) => {
  const key = String(value || "").trim().toUpperCase();
  if (!kCredentialKeyPattern.test(key)) {
    throw new Error(
      "Credential key must use uppercase letters, numbers, and underscores",
    );
  }
  return key;
};

const getAvailableCredentialKey = (credential) =>
  String(
    credential && typeof credential === "object"
      ? credential.key || credential.name
      : credential,
  )
    .trim()
    .toUpperCase();

const normalizeServiceName = (value) => {
  const name = String(value || "").trim().toLowerCase();
  if (!kServiceNamePattern.test(name) || name.includes("--")) {
    throw new Error(
      "Service name must be a 3-64 character lowercase slug",
    );
  }
  return name;
};

const normalizeServiceHost = (value) => {
  const host = normalizeText(value, 500, "Service host");
  if (
    host !== host.toLowerCase() ||
    host.includes("://") ||
    /[\s\\@?#\0]/.test(host) ||
    host.startsWith(".") ||
    host.endsWith(".") ||
    host.includes("**")
  ) {
    throw new Error("Service host is invalid");
  }
  const slash = host.indexOf("/");
  const authority = slash >= 0 ? host.slice(0, slash) : host;
  const path = slash >= 0 ? host.slice(slash) : "";
  const wildcard = authority.startsWith("*.");
  const authorityWithoutWildcard = wildcard ? authority.slice(2) : authority;
  let hostname = authorityWithoutWildcard;
  const portMatch = authorityWithoutWildcard.match(/:([0-9]+)$/);
  if (portMatch) {
    const port = Number.parseInt(portMatch[1], 10);
    if (port < 1 || port > 65535) {
      throw new Error("Service host port is invalid");
    }
    hostname = authorityWithoutWildcard.slice(0, -portMatch[0].length);
  }
  const labels = hostname.split(".");
  if (
    labels.length < 2 ||
    labels.some(
      (label) =>
        !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label),
    ) ||
    (path &&
      (!path.startsWith("/") ||
        !/^[A-Za-z0-9._~!$&'()+,;=:%@/*/-]+$/.test(path)))
  ) {
    throw new Error("Service host is invalid");
  }
  return host;
};

const defaultPlaceholderForKey = (key) => `__${key.toLowerCase()}__`;

const normalizePlaceholder = (value, key) => {
  const placeholder = String(value || defaultPlaceholderForKey(key)).trim();
  if (
    placeholder.length < 4 ||
    placeholder.length > 200 ||
    !kPlaceholderPattern.test(placeholder) ||
    !/[A-Za-z0-9]/.test(placeholder) ||
    (!placeholder.includes("__") && /^[A-Za-z0-9_]+$/.test(placeholder))
  ) {
    throw new Error(`Substitution placeholder for ${key} is invalid`);
  }
  return placeholder;
};

const normalizeCredential = (credential) => ({
  key: validateCredentialKey(credential?.key),
  description: normalizeText(
    credential?.description,
    500,
    "Credential description",
  ),
  type: "static",
  obtain: normalizeText(credential?.obtain, 500, "Credential obtain URL", {
    required: false,
  }),
  obtainInstructions: normalizeText(
    credential?.obtainInstructions || credential?.obtain_instructions,
    1000,
    "Credential obtain instructions",
    { required: false },
  ),
});

const normalizeCredentials = (credentials) => {
  if (!Array.isArray(credentials) || credentials.length > kMaxCredentials) {
    throw new Error("Credential slots are missing or invalid");
  }
  const normalized = credentials.map(normalizeCredential);
  const keys = new Set();
  for (const credential of normalized) {
    if (keys.has(credential.key)) {
      throw new Error(`Credential slot ${credential.key} is duplicated`);
    }
    keys.add(credential.key);
  }
  return normalized;
};

const normalizeAuth = (auth, referencedKeys) => {
  const type = String(auth?.type || "").trim().toLowerCase();
  if (type === "bearer") {
    const token = validateCredentialKey(auth?.token);
    referencedKeys.add(token);
    return { type, token };
  }
  if (type === "api-key") {
    const key = validateCredentialKey(auth?.key);
    const header = String(auth?.header || "Authorization").trim();
    if (!kHeaderNamePattern.test(header) || header.length > 200) {
      throw new Error("API key header is invalid");
    }
    const prefix = normalizeText(auth?.prefix, 200, "API key prefix", {
      required: false,
    });
    referencedKeys.add(key);
    return { type, key, header, ...(prefix ? { prefix } : {}) };
  }
  if (type === "basic") {
    const username = validateCredentialKey(auth?.username);
    const password = auth?.password
      ? validateCredentialKey(auth.password)
      : "";
    referencedKeys.add(username);
    if (password) referencedKeys.add(password);
    return { type, username, ...(password ? { password } : {}) };
  }
  if (type === "passthrough") return { type };
  throw new Error("Service authentication type is invalid");
};

const normalizeSubstitutions = (substitutions, referencedKeys) => {
  if (substitutions === undefined) return [];
  if (
    !Array.isArray(substitutions) ||
    substitutions.length > kMaxSubstitutions
  ) {
    throw new Error("Service substitutions are invalid");
  }
  return substitutions.map((substitution) => {
    const key = validateCredentialKey(substitution?.key);
    const surfaces = Array.isArray(substitution?.in)
      ? [
          ...new Set(
            substitution.in.map((surface) =>
              String(surface || "").trim().toLowerCase(),
            ),
          ),
        ]
      : [];
    if (
      !surfaces.length ||
      surfaces.some((surface) => !kSubstitutionSurfaces.has(surface))
    ) {
      throw new Error(`Substitution surfaces for ${key} are invalid`);
    }
    referencedKeys.add(key);
    return {
      key,
      placeholder: normalizePlaceholder(substitution?.placeholder, key),
      in: surfaces,
    };
  });
};

const buildRequestInstructions = (
  service,
  requestedInstructions,
) => {
  const instructions = [];
  const requested = normalizeText(
    requestedInstructions,
    2000,
    "Request instructions",
    { required: false },
  );
  if (requested) instructions.push(requested);
  for (const substitution of service.substitutions) {
    instructions.push(
      `Use the exact placeholder ${substitution.placeholder} wherever ${substitution.key} belongs in the ${substitution.in.join(", ")} portion of requests to ${service.host}.`,
    );
  }
  if (!service.substitutions.length) {
    if (service.auth.type === "bearer" || service.auth.type === "basic") {
      instructions.push(
        `Do not supply an Authorization credential when calling ${service.host}; Agent Vault injects it at the proxy.`,
      );
    } else if (service.auth.type === "api-key") {
      instructions.push(
        `Do not supply the ${service.auth.header} credential header when calling ${service.host}; Agent Vault injects it at the proxy.`,
      );
    }
  }
  return [...new Set(instructions)];
};

const normalizeAgentVaultAccessRequest = (input) => {
  const referencedKeys = new Set();
  const service = {
    name: normalizeServiceName(input?.service?.name),
    host: normalizeServiceHost(input?.service?.host),
    auth: normalizeAuth(input?.service?.auth, referencedKeys),
    substitutions: normalizeSubstitutions(
      input?.service?.substitutions,
      referencedKeys,
    ),
  };
  const credentials = normalizeCredentials(input?.credentials);
  const credentialKeys = new Set(credentials.map(({ key }) => key));
  for (const key of credentialKeys) {
    if (!referencedKeys.has(key)) {
      throw new Error(
        `Credential slot ${key} is not referenced by the service`,
      );
    }
  }
  const reason = normalizeText(input?.reason, 2000, "Access reason");
  const userMessage = normalizeText(
    input?.userMessage || input?.user_message || reason,
    5000,
    "User message",
  );
  return {
    service,
    credentials,
    referencedKeys: [...referencedKeys],
    reason,
    userMessage,
    requestInstructions: buildRequestInstructions(
      service,
      input?.requestInstructions || input?.request_instructions,
    ),
  };
};

const serializeCredentialSlot = (credential) => ({
  action: "set",
  key: credential.key,
  type: credential.type,
  description: credential.description,
  ...(credential.obtain ? { obtain: credential.obtain } : {}),
  ...(credential.obtainInstructions
    ? { obtain_instructions: credential.obtainInstructions }
    : {}),
});

const serializeService = (service) => ({
  action: "set",
  name: service.name,
  host: service.host,
  auth: service.auth,
  ...(service.substitutions.length
    ? { substitutions: service.substitutions }
    : {}),
});

const serviceMatchesAccess = (service, expected) => {
  // Agent Vault treats the joined host/path matcher as the service identity and
  // may preserve an existing canonical name when a proposal uses a new name.
  // /discover intentionally exposes no auth/substitution details, so matching
  // by name would create a proposal loop without providing stronger proof.
  return String(service?.host || "").trim().toLowerCase() === expected.host;
};

const planAgentVaultAccess = (access, discovered = {}) => {
  const availableCredentials = new Set(
    Array.isArray(discovered?.available_credentials)
      ? discovered.available_credentials
          .map(getAvailableCredentialKey)
          .filter(Boolean)
      : [],
  );
  const services = Array.isArray(discovered?.services)
    ? discovered.services
    : [];
  const matchedService = services.find((service) =>
    serviceMatchesAccess(service, access.service),
  );
  const credentialByKey = new Map(
    access.credentials.map((credential) => [credential.key, credential]),
  );
  const missingCredentialKeys = access.referencedKeys.filter(
    (key) => !availableCredentials.has(key),
  );
  for (const key of missingCredentialKeys) {
    if (!credentialByKey.has(key)) {
      throw new Error(
        `Credential ${key} is not available and needs a credential slot`,
      );
    }
  }
  const credentials = missingCredentialKeys.map((key) =>
    serializeCredentialSlot(credentialByKey.get(key)),
  );
  const serviceAvailable = Boolean(matchedService);
  return {
    status:
      serviceAvailable && credentials.length === 0
        ? "available"
        : "proposal_required",
    serviceAvailable,
    matchedService: matchedService
      ? {
          name: String(matchedService.name || ""),
          host: String(matchedService.host || ""),
        }
      : null,
    missingCredentialKeys,
    proposal: {
      services: serviceAvailable ? [] : [serializeService(access.service)],
      credentials,
      message: access.reason,
      user_message: access.userMessage,
    },
  };
};

module.exports = {
  defaultPlaceholderForKey,
  getAvailableCredentialKey,
  normalizeAgentVaultAccessRequest,
  planAgentVaultAccess,
  serviceMatchesAccess,
  validateCredentialKey,
};
