function expertPluginNames(expert) {
  return [
    ...new Set(
      [
        expert.id,
        String(expert.id || "").replace(/^custom-expert:/, ""),
        expert.plugin?.name,
        typeof expert.declaredPlugin === "string"
          ? expert.declaredPlugin
          : expert.declaredPlugin?.name,
      ].filter((name) => typeof name === "string" && name),
    ),
  ];
}
function buildExpertRuntimeIdentity(expert) {
  if (!expert?.id) return undefined;
  const field = (value) =>
    typeof value === "string"
      ? value.trim() || undefined
      : typeof value === "number" && Number.isFinite(value)
        ? String(value)
        : undefined;
  const plugin = field(expert.pluginRegisteredName) || field(expert.pluginName),
    agent = field(expert.agentName),
    updatedAt = field(expert.updatedAt);
  const timestamp =
    expert.summonTimestampReliable !== false &&
    typeof expert.summonTimestamp === "number" &&
    Number.isFinite(expert.summonTimestamp)
      ? expert.summonTimestamp
      : undefined;
  return (
    "expert-v2:" +
    JSON.stringify({
      v: 2,
      kind: "expert",
      expertId: expert.id,
      ...(plugin ? { pluginRegisteredName: plugin } : {}),
      ...(agent ? { agentName: agent } : {}),
      ...(updatedAt ? { updatedAt } : {}),
      ...(timestamp !== undefined ? { summonTimestamp: timestamp } : {}),
    })
  );
}
function resolveExpertSwitch(params, session, experts) {
  if (!params || typeof params !== "object" || Array.isArray(params))
    throw Error("Expert switch parameters required");
  for (const field of [
    "sessionId",
    "disablePluginName",
    "enablePluginName",
    "agentName",
    "sourcePluginId",
  ])
    if (params[field] !== undefined && params[field] !== null && typeof params[field] !== "string")
      throw Error(field + " must be a string");
  if (!params.sessionId) return null;
  if (!session || session.id !== params.sessionId) throw Error("Session not found");
  if (params.internalModelRequestHeaders && Object.keys(params.internalModelRequestHeaders).length)
    throw Error("Vendor model request headers require the native plugin runtime");
  const requested =
    params.enablePluginName ||
    (params.sourcePluginId ? params.sourcePluginId.split("@")[0] : undefined);
  let expert;
  if (requested) {
    const matches = experts.filter((item) => expertPluginNames(item).includes(requested));
    if (matches.length !== 1)
      throw Error(matches.length ? "Ambiguous expert plugin" : "Expert plugin not installed");
    expert = matches[0];
    if (
      params.sourcePluginId &&
      !expertPluginNames(expert).includes(params.sourcePluginId.split("@")[0])
    )
      throw Error("Expert source plugin does not match target");
    if (params.agentName && expert.agentName && params.agentName !== expert.agentName)
      throw Error("Requested expert agent is unavailable");
  } else if (params.agentName) {
    expert = experts.find((item) => item.id === session.expertId);
    if (!expert || (expert.agentName && expert.agentName !== params.agentName))
      throw Error("Requested expert agent is unavailable");
  } else if (!params.disablePluginName) return null;
  else {
    const current = experts.find((item) => item.id === session.expertId);
    const activeNames = current
      ? expertPluginNames(current)
      : [session.expertId, session.config?.expertPluginBinding?.pluginName];
    if (!activeNames.includes(params.disablePluginName)) return null;
  }
  return {
    expertId: expert?.id || null,
    runtimeIdentity: expert
      ? buildExpertRuntimeIdentity({
          ...expert,
          pluginRegisteredName: undefined,
          pluginName: undefined,
          agentName: params.agentName || expert.agentName,
          summonTimestamp: Date.now(),
        })
      : null,
    expertMarketplace: expert?.marketplace || null,
    expectedExpertId: session.expertId || null,
    binding: {
      pluginName: params.enablePluginName || null,
      agentName: params.agentName || expert?.agentName || null,
      sourcePluginId: params.sourcePluginId || null,
      nativePluginRuntimeAvailable: false,
    },
  };
}
module.exports = { resolveExpertSwitch, buildExpertRuntimeIdentity };
