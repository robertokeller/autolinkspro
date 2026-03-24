import process from "node:process";

const apiBaseUrl = process.env.SCHEDULER_RPC_BASE_URL || "http://127.0.0.1:3116";
const schedulerToken = process.env.SCHEDULER_RPC_TOKEN || process.env.SERVICE_TOKEN || "dev-service-token-local-only";

process.env.NODE_ENV = process.env.NODE_ENV || "development";
process.env.SCHEDULER_MODE = "remote";
process.env.SCHEDULER_RPC_BASE_URL = apiBaseUrl;
process.env.SCHEDULER_RPC_TOKEN = schedulerToken;
process.env.SERVICE_TOKEN = process.env.SERVICE_TOKEN || schedulerToken;
process.env.DISPATCH_SOURCE = process.env.DISPATCH_SOURCE || "local-runtime-worker";

await import("./dispatch-scheduler.mjs");
