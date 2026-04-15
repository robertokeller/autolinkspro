// services/whatsapp-baileys/src/analytics/index.ts

// Types
export * from "./types.js";

// DDD/State mapping
export * from "./ddd-to-state.js";

// Storage
export * from "./store.js";

// Collector
export {
  setupAnalyticsCollector,
  captureSnapshotForGroup,
  captureAllGroupSnaphots,
  scheduleDailySnapshots,
} from "./collector.js";

// Recapture dispatcher
export { scheduleRecaptureDispatcher } from "./recapture-dispatcher.js";

// Metrics
export { calculateComposition } from "./metrics/composition.js";
export { calculateGeography } from "./metrics/geography.js";
export { calculateDailyChurn } from "./metrics/churn-daily.js";
export { calculateChurnTrends } from "./metrics/churn-trends.js";
export { calculateRetention } from "./metrics/churn-retention.js";
export { calculateCrossGroup } from "./metrics/cross-group.js";
export { calculateHealthScore } from "./metrics/health-score.js";
