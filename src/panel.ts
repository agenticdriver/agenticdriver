import { z } from "zod";
import { AgenticClient, connectionInvitation } from "./client.js";
import {
  ConfigureProviderSchema,
  type ManagementSnapshot,
} from "./management-types.js";
import { DriverError } from "./errors.js";
import {
  ProviderSetupRequestSchema,
  type ProviderSetupSnapshot,
} from "./setup-types.js";
import type { ProviderInfo } from "./types.js";
import type { ProviderPresentation } from "./catalog.js";
export interface PanelConnection {
  id: string;
  label: string;
  url?: string;
}
export interface ProviderPanelState {
  connected: boolean;
  connection?: PanelConnection;
  providers: ProviderInfo[];
  management?: ManagementSnapshot;
  setup?: ProviderSetupSnapshot;
  presentations?: Record<string, ProviderPresentation>;
  canConnect: boolean;
  canDisconnect: boolean;
  canInvite: boolean;
  connectionError?: string;
}
export const PanelRequestSchema = z.discriminatedUnion("action", [
  z
    .object({ action: z.literal("setup"), request: ProviderSetupRequestSchema })
    .strict(),
  z
    .object({ action: z.literal("snapshot"), refresh: z.boolean().optional() })
    .strict(),
  z
    .object({ action: z.literal("configure"), change: ConfigureProviderSchema })
    .strict(),
  z
    .object({
      action: z.literal("connect"),
      invitation: z.string().min(1).max(16_384),
    })
    .strict(),
  z.object({ action: z.literal("disconnect") }).strict(),
  z
    .object({
      action: z.literal("invite"),
      subject: z.string().min(1).max(128),
      providers: z.array(z.string()).max(32),
      manageProviders: z.boolean().default(false),
    })
    .strict(),
  z.object({ action: z.literal("connections") }).strict(),
  z.object({ action: z.literal("revoke"), id: z.uuid() }).strict(),
]);
export type PanelRequest = z.input<typeof PanelRequestSchema>;
export interface ProviderPanelOptions {
  /** Resolve the currently connected backend client for the authorized application user. */
  client(): AgenticClient | undefined | Promise<AgenticClient | undefined>;
  connection?(): PanelConnection | undefined;
  connect?(invitation: string): Promise<void>;
  disconnect?(): Promise<void>;
  /** Reuse reviewed Usagestat metadata/assets through providerPresentation(). */
  presentations?(
    providers: ProviderInfo[],
  ):
    | Record<string, ProviderPresentation>
    | Promise<Record<string, ProviderPresentation>>;
}
/** Mount behind the consuming application's existing settings authorization and CSRF checks. */
export function providerPanel(options: ProviderPanelOptions) {
  async function snapshot(refresh = false): Promise<ProviderPanelState> {
    const client = await options.client();
    const base = {
      canConnect: Boolean(options.connect),
      canDisconnect: Boolean(options.disconnect),
      canInvite: false,
    };
    if (!client)
      return {
        ...base,
        connected: false,
        connection: options.connection?.(),
        providers: [],
      };
    const providers = await client.providers({ refresh });
    let management: ManagementSnapshot | undefined;
    const protocol = await client.protocol();
    if (protocol.features.includes("provider-management"))
      management = await client.management();
    const connection = options.connection?.();
    return {
      ...base,
      connected: true,
      providers,
      connection,
      management,
      ...(management && protocol.features.includes("provider-setup")
        ? { setup: await client.providerSetup({ action: "list" }) }
        : {}),
      canInvite: Boolean(
        management &&
        connection?.url &&
        protocol.features.includes("client-pairing"),
      ),
      ...(options.presentations
        ? { presentations: await options.presentations(providers) }
        : {}),
    };
  }
  return async (input: unknown): Promise<unknown> => {
    const request = PanelRequestSchema.safeParse(input);
    if (!request.success)
      throw new DriverError(
        "INVALID_PANEL_REQUEST",
        "Choose a supported provider panel operation.",
      );
    const action = request.data;
    if (action.action === "snapshot") return snapshot(action.refresh);
    if (action.action === "connect") {
      if (!options.connect)
        throw new DriverError(
          "CONNECTION_UNAVAILABLE",
          "This application has not enabled connection setup.",
        );
      await options.connect(action.invitation);
      return snapshot();
    }
    if (action.action === "disconnect") {
      if (!options.disconnect)
        throw new DriverError(
          "CONNECTION_UNAVAILABLE",
          "This application manages its connection outside this panel.",
        );
      await options.disconnect();
      return snapshot();
    }
    const client = await options.client();
    if (!client)
      throw new DriverError(
        "CONNECTION_REQUIRED",
        "Connect an AgenticDriver host first.",
      );
    if (action.action === "configure") {
      await client.configureProvider(action.change);
      return snapshot();
    }
    if (action.action === "setup") return client.providerSetup(action.request);
    if (action.action === "connections") return client.connections();
    if (action.action === "revoke") return client.revokeConnection(action.id);
    const connection = options.connection?.();
    if (!connection?.url)
      throw new DriverError(
        "CONNECTION_UNAVAILABLE",
        "The host's public connection URL is not configured.",
      );
    const invite = await client.createInvitation({
      grant: {
        subject: action.subject,
        providers: action.providers,
        manageProviders: action.manageProviders,
      },
    });
    return {
      invitation: connectionInvitation(connection.url, invite.code),
      expiresAt: invite.expiresAt,
      grant: invite.grant,
    };
  };
}
