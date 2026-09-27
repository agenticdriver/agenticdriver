import { z } from "zod";
import {
  connectionInvitation,
  connectionTarget,
  DriverError,
} from "@agenticdriver/sdk/client";

export const DestinationSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("current") }).strict(),
  z
    .object({
      mode: z.literal("https"),
      url: z.string().trim().min(1).max(8192),
    })
    .strict(),
  z
    .object({
      mode: z.literal("tunnel"),
      port: z.number().int().min(1024).max(65535),
    })
    .strict(),
]);

/** Reuse the SDK's URL rules with a dummy code. No credential is created or sent. */
const normalized = (url) =>
  connectionTarget(connectionInvitation(url, "0".repeat(43))).url;

export function invitationDestination(selected, destination) {
  if (!selected.url)
    throw new DriverError(
      "HOST_STOPPED",
      "Start the host before creating an invitation.",
    );
  let url = selected.url,
    commands;
  if (destination.mode === "https") {
    url = normalized(destination.url);
    if (!url.startsWith("https:"))
      throw new DriverError(
        "HTTPS_REQUIRED",
        "Use the HTTPS address of the proxy or TLS host that reaches this host.",
      );
  } else if (destination.mode === "tunnel") {
    if (selected.id !== "local")
      throw new DriverError(
        "TUNNEL_HOST_REQUIRED",
        "Create the SSH recipe on the computer running the desktop-owned host.",
      );
    const hostPort = new URL(selected.url).port;
    const binding = `127.0.0.1:${destination.port}:127.0.0.1:${hostPort}`;
    commands = {
      fromApplication: `ssh -N -o ExitOnForwardFailure=yes -L ${binding} USER@DRIVER_HOST`,
      fromHost: `ssh -N -o ExitOnForwardFailure=yes -R ${binding} USER@APP_SERVER`,
    };
    url = `http://127.0.0.1:${destination.port}`;
  }
  url = normalized(url);
  return {
    mode: destination.mode,
    url,
    routeVerified: false,
    ...(commands ? { commands } : {}),
  };
}
