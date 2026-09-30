/** Display only: omit account identity, paths, credentials and configuration extensions. */
export function providerSetupSummary(providers, management) {
  const configurations = management?.providers;
  const entries = (configurations ?? providers).map((config) => {
    const provider = providers.find((item) => item.id === config.id);
    return {
      id: config.id,
      name: config.name,
      ...(configurations ? { enabled: config.enabled !== false } : {}),
      health: provider?.health?.status ?? "unknown",
      checkedAt: provider?.health?.checkedAt,
      accountStatus: provider?.connection?.account?.status ?? "unknown",
      runtimeVersion: provider?.connection?.runtime?.version,
      // Configured IDs are advisory, not models discovered from an account.
      reportedModels:
        provider?.modelCatalog?.source === "provider"
          ? provider.modelCatalog.models.length
          : undefined,
      catalogComplete:
        provider?.modelCatalog?.source === "provider"
          ? provider.modelCatalog.complete
          : undefined,
    };
  });
  return {
    available: true,
    scope: configurations ? "configured" : "granted",
    count: entries.length,
    enabled: configurations
      ? entries.filter((item) => item.enabled).length
      : undefined,
    signedIn: entries.filter((item) => item.accountStatus === "signed-in")
      .length,
    reportedModels: entries.reduce(
      (sum, item) => sum + (item.reportedModels ?? 0),
      0,
    ),
    entries,
  };
}

export function connectionSetupSummary(list) {
  const observed = list.connections.filter(
    (item) => item.activeRequests !== undefined,
  );
  return {
    available: true,
    count: list.connections.length,
    invitations: list.invitations.length,
    activeRequests: observed.reduce(
      (sum, item) => sum + item.activeRequests,
      0,
    ),
    activityComplete: observed.length === list.connections.length,
  };
}
