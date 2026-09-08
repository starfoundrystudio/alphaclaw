// Keep first-boot configuration writers ahead of the gateway's migrations.
// The server stays available while enrollment is pending; boot's watchdog and
// greeting start only after this barrier. Later runtime changes still restart.
const createGatewayBootPreparation = ({
  prepare,
  start,
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  logger = console,
}) => {
  let started = false;
  let inFlight = null;
  const run = () => {
    if (!inFlight) {
      inFlight = (async () => {
        while (true) {
          try {
            if ((await prepare()).ready) break;
          } catch {
            // Enrollment owns detailed errors; never include credentials here.
          }
          logger.log(
            "[alphaclaw] Waiting for Agent Vault enrollment before gateway startup",
          );
          await wait(5000);
        }
        // Mark the attempt, not success: once preparation has handed off to
        // startup, later Vault changes must recover a failed launch through
        // restartGateway rather than silently reloading an absent child.
        started = true;
        await start();
      })().finally(() => {
        inFlight = null;
      });
    }
    return inFlight;
  };
  return { start: run, hasStarted: () => started };
};
module.exports = { createGatewayBootPreparation };
