// Adapt capability badges at delivery time; retain the original renderer files.
export function adaptRendererCapabilities(filename, data) {
  if (filename.endsWith("/assets/contexts-BNN7VV-R.js")) {
    let source = data.toString("utf8");
    // Local identities have no official subscription edition. Keep that distinction
    // while making the independently hosted appearance settings available.
    for (const [before, after] of [
      ["let n=e?.editionType,r=e?.enterpriseId?.trim()??``;return t?", 'let n=e?.editionType??(e?.isLocal===!0?"free":void 0),r=e?.enterpriseId?.trim()??``;return t?'],
      ["l=t?.editionType,u=t?.expireAt", 'l=t?.editionType??(t?.isLocal===!0?"free":void 0),u=t?.expireAt'],
    ]) {
      if (source.split(before).length !== 2) throw Error("5.8.3 appearance identity binding changed");
      source = source.replace(before, after);
    }
    return Buffer.from(source);
  }
  if (filename.endsWith("/assets/skills-CzOlJP4U.js")) {
    const source = data.toString("utf8");
    const loading = 'installedLoading: installedSkillsHook.installedLoading,\n\t\tinstalledExpanded: installedSkillsHook.installedExpanded,';
    if (source.split(loading).length !== 2) throw Error("Original skill state binding changed");
    return Buffer.from(source.replace(loading, loading + '\n\t\tinstalledLoadError: installedSkillsHook.installedLoadError,'));
  }
  if (filename.endsWith("/assets/expert-picker-uOJU4MNV.js")) {
    let source = data.toString("utf8");
    const result = 'if (mountedRef.current) setLocalExperts(decorateExpertsWithImportSecurityRisk(result.experts));';
    if (source.split(result).length !== 2) throw Error("Original local expert result handling changed");
    source = source.replace(result, 'if (mountedRef.current) { setLocalExperts(decorateExpertsWithImportSecurityRisk(result.experts)); if (Array.isArray(result.errors) && result.errors.length) setError((getLocale().startsWith("zh") ? "部分本地专家包加载失败：" : "Some local expert packages could not be loaded: ") + result.errors.map(item => item.directory + ": " + item.message).join("; ")); }');
    const subscribe = 'const unsubscribeRiskChange = subscribeExpertImportSecurityRiskChange(() => {';
    const cleanup = 'unsubscribeRiskChange();';
    if (source.split(subscribe).length !== 2 || source.split(cleanup).length !== 2)
      throw Error("Original local expert refresh lifecycle changed");
    source = source.replace(subscribe, 'const stopLocalPackages = window.__wbOn?.("expert:packagesChanged", () => loadExperts());\n\t\t' + subscribe);
    source = source.replace(cleanup, cleanup + '\n\t\t\tstopLocalPackages?.();');
    return Buffer.from(source);
  }
  if (filename.endsWith("/assets/use-inspiration-share-code-receiver-DyhZtfQL.js")) {
    let source = data.toString("utf8");
    const before = "const visibleAllExperts = (0, import_react$31.useMemo)(() => filterExpertsByVisibility(allExperts, enterpriseId), [allExperts, enterpriseId]);";
    if (source.split(before).length !== 2) throw Error("Original expert center refresh hook changed");
    source = source.replace(before, '(0, import_react$31.useEffect)(() => window.__wbOn?.("expert:packagesChanged", () => { refresh().catch(() => {}); }), [refresh]);\n\t' + before);
    const selection = "const handleExpertClick = (0, import_react$27.useCallback)((expert) => {\n\t\t\tsetSelectedExpert(expert);\n\t\t}, []);";
    if (source.split(selection).length !== 2) throw Error("Original expert detail selection changed");
    source = source.replace(selection, selection + '\n\t\t(0, import_react$27.useEffect)(() => { setSelectedExpert(current => current?.id?.startsWith("custom-expert:") ? allExperts.find(item => item.id === current.id) ?? null : current); }, [allExperts]);');
    const summon = 'const expert = findExpertByIdentity(expertIdentity);\n\t\t\tconst clickedCategoryId = expert?.categoryId;';
    if (source.split(summon).length !== 2) throw Error("Original expert summon capability check changed");
    source = source.replace(summon, 'const expert = findExpertByIdentity(expertIdentity);\n\t\t\tif (["local-expert-package", "public-expert-catalog"].includes(expert?.source) && expert?.expertType === "team" && expert.runtimeAvailable === false) return performSummon(expertIdentity, cardPosition, promptOverride);\n\t\t\tconst clickedCategoryId = expert?.categoryId;');
    const local = 'const { localExperts, isLoading: localExpertsLoading, refresh: refreshLocalExperts } = useLocalExperts(void 0, { enabled: mainTab === "myExperts" });';
    if (source.split(local).length !== 2) throw Error("Original local expert error binding changed");
    source = source.replace(local, local.replace('refresh: refreshLocalExperts', 'error: localExpertError, refresh: refreshLocalExperts') + '\n\t\t(0, import_react$27.useEffect)(() => { if (mainTab === "myExperts" && localExpertError) toast.error(localExpertError); }, [mainTab, localExpertError]);');
    return Buffer.from(source);
  }
  if (filename.endsWith("/assets/index-BZi9u85P.js")) {
    const source = data.toString("utf8");
    const before = "const eid = account?.enterpriseId;\n\tconst editionType = account?.editionType;\n\tconst expireAt = account?.expireAt;";
    if (source.split(before).length !== 2) throw Error("Original appearance runtime account access changed");
    return Buffer.from(source.replace(before, before.replace("account?.editionType;", "account?.editionType ?? (account?.isLocal ? \"free\" : undefined);")));
  }
  if (filename.endsWith("/assets/components-CFbjBHF1.js")) {
    let source = data.toString("utf8");
    const before = "const sub = skillListRefresh$.subscribe(() => {\n\t\t\tloadSkills(true);\n\t\t});\n\t\treturn () => sub.unsubscribe();";
    if (source.split(before).length !== 2) throw Error("Original skill refresh subscription changed");
    source = source.replace(before, "const sub = skillListRefresh$.subscribe(() => { loadSkills(true); });\n\t\tconst stopLocal = window.__wbOn?.(\"skill:packagesChanged\", () => loadSkills(true));\n\t\treturn () => { sub.unsubscribe(); stopLocal?.(); };");
    const skillErrors = 'if (response.error) console.warn("[useInstalledSkills] response.error:", response.error);';
    if (source.split(skillErrors).length !== 2) throw Error("Original installed skill error handling changed");
    const loading = 'const [installedLoading, setInstalledLoading] = (0, import_react$28.useState)(false);';
    const resultState = 'return {\n\t\thasCacheRef,\n\t\timportFlow,\n\t\tinstalledLoading,';
    const section = 'className: "skills-installed-section",\n\t\t\tchildren: [';
    for (const marker of [loading, resultState, section])
      if (source.split(marker).length !== 2) throw Error("Original installed skill error display changed");
    source = source.replace(loading, loading + '\n\tconst [installedLoadError, setInstalledLoadError] = (0, import_react$28.useState)(null);');
    source = source.replace(resultState, resultState + '\n\t\tinstalledLoadError,');
    source = source.replace(skillErrors, skillErrors + '\n\t\t\tsetInstalledLoadError(Array.isArray(response.errors) && response.errors.length ? (getLocale().startsWith("zh") ? "部分本地技能加载失败：" : "Some local skills could not be loaded: ") + response.errors.map(item => (item.name || item.id) + ": " + item.message).join("; ") : null);');
    source = source.replace(section, section + '\n\t\t\t\tdata.installedLoadError && (0, import_jsx_runtime$1.jsx)("div", { role: "alert", style: { padding: "12px", whiteSpace: "pre-wrap" }, children: data.installedLoadError }),');
    const marketError = 'if (res.code !== 0) {\n\t\t\t\t\tif (!servedFromCache) setBuiltinMarketError(true);';
    if (source.split(marketError).length !== 2) throw Error("Original skill market error handling changed");
    source = source.replace(marketError, 'if (res.code !== 0) {\n\t\t\t\t\tif (!servedFromCache) setBuiltinMarketError(res.data?.source === "local_account_disconnected" ? (getLocale().startsWith("zh") ? "技能推荐市场需要 WorkBuddy 账号认证，当前本地账户尚未连接市场服务。" : "The skills marketplace requires a WorkBuddy account. This local account is not connected to the marketplace.") : true);');
    const marketEmpty = 'children: [/* @__PURE__ */ (0, import_jsx_runtime$12.jsx)("p", { children: t("skills.recommend.empty") }),';
    if (source.split(marketEmpty).length !== 2) throw Error("Original skill market failure panel changed");
    source = source.replace(marketEmpty, 'children: [/* @__PURE__ */ (0, import_jsx_runtime$12.jsx)("p", { children: typeof error === "string" ? error : t("skills.recommend.empty") }),');
    const start = source.indexOf("const runImportFlow = ");
    const end = source.indexOf("const desktopPick = useDesktopSkillPick(runImportFlow);", start);
    if (start < 0 || end < 0) throw Error("Original skill import flow changed");
    const flow = source.slice(start, end);
    const errorHandler = 'toast.error(getLocalizedImportSkillError(error instanceof Error ? error.message : void 0));';
    if (flow.split(errorHandler).length !== 2) throw Error("Original skill import error handler changed");
    const updated = flow.replace(errorHandler, 'if (folderPath && String(error?.message || error).includes("本地版本尚未接入技能安全扫描")) { setUploadScanResult({ verdict: "", failureReason: "local_unavailable", failureDetail: getLocale().startsWith("zh") ? "本地版本尚未接入技能安全扫描；该技能未经安全检测。" : "Security scanning is unavailable in the local edition. This skill has not been scanned.", md5: "", tags: [], fileAnalysis: [], virusName: [] }); setPendingInstallPath(folderPath); } else ' + errorHandler);
    source = source.slice(0,start) + updated + source.slice(end);
    const background = 'message: t("skills.security.async.backgroundRunning"),';
    if (source.split(background).length !== 2) throw Error("Original skipped scan notification changed");
    source = source.replace(background, 'message: uploadScanResult?.failureReason === "local_unavailable" ? t("skills.toast.imported") + (getLocale().startsWith("zh") ? "（安全检测未执行）" : " (security scan not performed)") : t("skills.security.async.backgroundRunning"),');
    const failureDescription = 'children: t(isTimeout ? "skills.security.failed.timeoutContent" : "skills.security.failed.errorContent")';
    if (source.split(failureDescription).length !== 2) throw Error("Original failed scan description changed");
    source = source.replace(failureDescription, 'children: scanResult.failureReason === "local_unavailable" ? scanResult.failureDetail : t(isTimeout ? "skills.security.failed.timeoutContent" : "skills.security.failed.errorContent")');
    return Buffer.from(source);
  }
  if (!filename.endsWith("/assets/hooks-tYu87aVj.js")) return data;
  let source = data.toString("utf8");
  const appearanceConditions = [
    ['facadeAvailable && Boolean(edition) && !account?.enterpriseId?.trim() && !ENTERPRISE_EDITIONS.has(edition)', 'facadeAvailable && (account?.isLocal === true || (Boolean(edition) && !account?.enterpriseId?.trim() && !ENTERPRISE_EDITIONS.has(edition)))'],
    ['const editionType = account?.editionType;\n\tconst expireAt = account?.expireAt;\n\tconst gatingLoading', 'const editionType = account?.editionType ?? (account?.isLocal ? "free" : undefined);\n\tconst expireAt = account?.expireAt;\n\tconst gatingLoading'],
  ];
  for (const [before, after] of appearanceConditions) {
    if (source.split(before).length !== 2) throw Error("Original appearance account access changed");
    source = source.replace(before, after);
  }
  const creditsNumber = "const renderCreditsNumber = () => {\n\t\tswitch (creditsState.kind) {";
  if (source.split(creditsNumber).length !== 2) throw Error("Original account credits renderer changed");
  source = source.replace(creditsNumber, 'const renderCreditsNumber = () => {\n\t\tif (billingAccount?.isLocal === true) return (0, import_jsx_runtime$133.jsx)("span", { className: "account-panel__credits-number", children: getLocale().startsWith("zh") ? "未接入官方积分服务" : "Official credits service unavailable" });\n\t\tswitch (creditsState.kind) {');
  for (const field of ["securityGatewayEnabled", "transmissionEncryptionEnabled"]) {
    const before = `managed && dataSecurity && dataSecurity.${field} === false`;
    if (source.split(before).length !== 2)
      throw new Error(`Original security capability expression changed: ${field}`);
    source = source.replace(before, `dataSecurity && dataSecurity.${field} === false`);
  }
  const modelConditions = [
    ['selectedProvider.authMode === "apiKey" && !apiKey',
      'selectedProvider.authMode === "apiKey" && !apiKey && !editingModel?.apiKeySet'],
    ['selectedProvider.authMode === "apiKey" && !isApiKeyCharacterSetValid(apiKey)',
      'selectedProvider.authMode === "apiKey" && apiKey && !isApiKeyCharacterSetValid(apiKey)'],
  ];
  for (const [before, after] of modelConditions) {
    if (source.split(before).length !== 2)
      throw new Error("Original model credential validation changed");
    source = source.replace(before, after);
  }
  return Buffer.from(source);
}
