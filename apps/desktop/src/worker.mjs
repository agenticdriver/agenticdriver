import { desktopController, publicError } from "./controller.mjs";
let controller;
const send = (message) => {
  if (process.connected) process.send(message);
};
try {
  controller = await desktopController(process.argv[2]);
  send({ event: "ready" });
} catch (error) {
  send({ event: "failed", error: publicError(error) });
  process.exitCode = 1;
  process.disconnect?.();
}
let pending = 0;
process.on("message", async (message) => {
  if (!controller || !message || typeof message.id !== "string") return;
  if (pending >= 32) {
    send({
      id: message.id,
      error: {
        code: "DESKTOP_BUSY",
        message: "Wait for the current operation to finish.",
      },
    });
    return;
  }
  pending++;
  try {
    if (message.close) {
      await controller.close({ interrupt: message.interrupt === true });
      send({ id: message.id, value: { closed: true } });
      process.disconnect();
    } else
      send({ id: message.id, value: await controller.request(message.input) });
  } catch (error) {
    send({ id: message.id, error: publicError(error) });
  } finally {
    pending--;
  }
});
// Losing the owning desktop closes only this child's host, including after a main-process crash.
process.on("disconnect", () => {
  void controller?.close({ interrupt: true }).finally(() => process.exit());
});
