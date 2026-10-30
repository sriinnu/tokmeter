/**
 * @sriinnu/tokmeter-core — Public API barrel export.
 *
 * Re-exports everything so consumers can use:
 *   import { TokmeterCore } from "@sriinnu/tokmeter-core";
 */

export { nullMap } from "./aggregates.js";
export {
  aggregateByDate,
  aggregateByModel,
  aggregateByProject,
  aggregateByProvider,
  filterByDate,
  filterByProject,
  filterByProvider,
} from "./aggregator.js";
export type { AliasEntry, AliasMap, AliasSuggestion } from "./alias-service.js";
export {
  aliasFilePath,
  applyTagOp,
  isProjectHidden,
  loadAliases,
  mergeAliases,
  removeAlias,
  resolveProjectName,
  saveAliases,
  setAlias,
  setHidden,
  suggestAliases,
} from "./alias-service.js";
export type {
  AntigravityCreditsUsedToday,
  AntigravityModelQuota,
  AntigravitySnapshot,
} from "./antigravity-live.js";
export {
  computeCreditsUsedToday,
  pollAntigravityLiveStatus,
  pruneSnapshotHistory as pruneAntigravitySnapshotHistory,
  readLatestSnapshot as readLatestAntigravitySnapshot,
  readSnapshotHistory as readAntigravitySnapshotHistory,
} from "./antigravity-live.js";
export {
  ALL_CLEANERS,
  getCleaner,
  getCleaners,
} from "./cleaners/index.js";
export { UnsafeCleanupTargetError } from "./cleanup-guard.js";
export {
  CleanupService,
  cleanupPreviewDigest,
  EMPTY_FILTER_MESSAGE,
  isEmptyCleanupFilter,
} from "./cleanup-service.js";
export type {
  ConfigFieldMeta,
  DefaultRange,
  DefaultSort,
  UserConfig,
} from "./config-service.js";
export {
  CONFIG_FIELDS,
  configFilePath,
  DEFAULT_CONFIG,
  getConfigValue,
  loadConfig,
  mergeConfigs,
  saveConfig,
  setConfigValue,
} from "./config-service.js";
export type { CoverageReport, UnreadFile } from "./coverage-check.js";
export { readCoverageReports, summarizeCoverage } from "./coverage-check.js";
export {
  endOfLocalDay,
  isBeforeToday,
  isSameLocalDay,
  localDateKey,
  startOfLocalDay,
  yesterdayDateKey,
} from "./date-utils.js";
export { sanitizeDataLabel } from "./display-safety.js";
export { invalidateHistorySnapshot } from "./history-snapshot.js";
export type { ModelRateCard, ModelRatesResponse, Rate } from "./model-rates.js";
export { computeModelRates } from "./model-rates.js";
export {
  ALL_PARSERS,
  ALL_PROVIDER_IDS,
  getParser,
  getParsers,
} from "./parsers/index.js";
export {
  clearRecordCache,
  invalidateRecordCache,
  peekCachedRecords,
} from "./parsers/utils.js";
export type { PricingSource, PricingSourceTier } from "./pricing.js";
export {
  getKoshaRegistryMtime,
  maybeBackgroundRefresh,
  PricingService,
  refreshKoshaRegistry,
} from "./pricing.js";
export { ensurePrivateDirectory, writePrivateFile } from "./private-files.js";
export {
  canonicalizeProjectName,
  projectMatchKey,
  projectNameIncludes,
  projectNamesMatch,
} from "./project-name.js";
export type { QuotaAgent, QuotaSample, QuotaVerdict, QuotaWindow } from "./quota.js";
export {
  claudeCodeQuota,
  getQuota,
  quotaWindows,
  readCodexQuota,
  recordQuotaSamples,
  windowLabel,
} from "./quota.js";
export { UnsafeArchiveError } from "./restore-guard.js";
export * from "./session-health.js";
export { computeStatbarSignals } from "./signals.js";
export {
  invalidateSummaryCache,
  loadSummaryCache,
  saveSummaryCache,
} from "./summary-cache.js";
export type { Theme, ThemeColors } from "./themes.js";
export {
  BUILT_IN_THEMES,
  getConfigPath,
  getTheme,
  isNerdFontEnabled,
  listThemeIds,
  listThemes,
  loadUserTheme,
} from "./themes.js";
export {
  computeTimeOfDayProfile,
  TIME_OF_DAY_MIN_DAYS,
  TIME_OF_DAY_WINDOW_DAYS,
} from "./time-of-day.js";
export { TokmeterCore } from "./tokmeter-core.js";
export type {
  BackupInfo,
  CleanupFilter,
  CleanupOptions,
  CleanupPreview,
  CleanupResult,
  CleanupTarget,
  CompactionTelemetry,
  DailyEntry,
  ModelSummary,
  PartialFileWarning,
  ProjectSummary,
  ProviderId,
  ProviderSummary,
  RestoreResult,
  ScanMeta,
  ScanOptions,
  ScanWarning,
  SessionCleaner,
  SessionParser,
  StatbarSignals,
  TimeOfDayBlock,
  TimeOfDayProfile,
  TokenRecord,
  TokmeterConfig,
  TokmeterStats,
  TokmeterSummary,
  UsageMetricProvenance,
  UsageProvenance,
  UsageTelemetrySource,
} from "./types.js";
export type { DerivedUsage, UsageBreakdown } from "./usage.js";
export { deriveUsage, sumUsage } from "./usage.js";
