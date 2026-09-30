// One SSE route for every background operation (channel account creation,
// setup completion): progress and the final result are replayed from the
// shared operation-events service, so a reconnecting client catches up.
const registerOperationRoutes = ({ app, operationEvents = null }) => {
  app.get("/api/operations/:operationId/events", (req, res) => {
    if (!operationEvents?.subscribe) {
      return res
        .status(503)
        .json({ ok: false, error: "Operation events unavailable" });
    }
    const subscribed = operationEvents.subscribe({
      operationId: req.params.operationId,
      req,
      res,
    });
    if (!subscribed) {
      return res.status(404).json({ ok: false, error: "Operation not found" });
    }
  });
};

module.exports = {
  registerOperationRoutes,
};
