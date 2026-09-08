// Shared ownership for commands that can mutate OpenClaw startup state.
const createGatewayLifecycleOwnership = () => {
  let active = null;
  const waiting = [];
  const grant = (kind) => {
    const lease = {
      kind,
      release: () => {
        if (active !== lease) return;
        active = null;
        waiting.shift()?.();
      },
    };
    active = lease;
    return lease;
  };
  return {
    isBusy: () => active !== null,
    isOwner: (lease) => !!lease && active === lease,
    tryAcquire: (kind) => active ? null : grant(kind),
    acquire: (kind) => new Promise((resolve) => {
      const next = () => resolve(grant(kind));
      if (active) waiting.push(next);
      else next();
    }),
  };
};
module.exports = { createGatewayLifecycleOwnership };
