import os from "node:os";

const MODE = String(process.env.SCHEDULER_MODE || "auto").trim().toLowerCase();
const NODE_ENV = String(process.env.NODE_ENV || "development").trim().toLowerCase();
const IS_PRODUCTION = NODE_ENV === "production";

const DISPATCH_INTERVAL_SECONDS = Number.parseInt(process.env.DISPATCH_INTERVAL_SECONDS || "45", 10);
const ADMIN_BROADCAST_INTERVAL_SECONDS = Number.parseInt(process.env.ADMIN_BROADCAST_INTERVAL_SECONDS || "45", 10);
const ADMIN_EVENTS_INTERVAL_SECONDS = Number.parseInt(process.env.ADMIN_EVENTS_INTERVAL_SECONDS || "60", 10);
const SHOPEE_INTERVAL_SECONDS = Number.parseInt(process.env.SHOPEE_INTERVAL_SECONDS || "60", 10);
const MELI_AUTOMATION_INTERVAL_SECONDS = Number.parseInt(
  process.env.MELI_AUTOMATION_INTERVAL_SECONDS || String(SHOPEE_INTERVAL_SECONDS),
  10,
);
const AMAZON_AUTOMATION_INTERVAL_SECONDS = Number.parseInt(process.env.AMAZON_AUTOMATION_INTERVAL_SECONDS || String(SHOPEE_INTERVAL_SECONDS), 10);
const CHANNEL_EVENTS_INTERVAL_SECONDS = Number.parseInt(process.env.CHANNEL_EVENTS_INTERVAL_SECONDS || "15", 10);
const MELI_VITRINE_INTERVAL_SECONDS = Number.parseInt(process.env.MELI_VITRINE_INTERVAL_SECONDS || "7200", 10);
const AMAZON_VITRINE_INTERVAL_SECONDS = Number.parseInt(process.env.AMAZON_VITRINE_INTERVAL_SECONDS || "86400", 10);
const DISPATCH_LIMIT = Number.parseInt(process.env.DISPATCH_LIMIT || "100", 10);
const DISPATCH_SOURCE = String(process.env.DISPATCH_SOURCE || "node-scheduler").trim();
const RPC_BASE_URL = String(process.env.SCHEDULER_RPC_BASE_URL || "").trim().replace(/\/$/, "");
const RPC_TOKEN = String(process.env.SCHEDULER_RPC_TOKEN || "").trim();
const REQUEST_TIMEOUT_MS = Number.parseInt(process.env.SCHEDULER_TIMEOUT_MS || "15000", 10);
const PRESSURE_MEM_WARN_PERCENT = Number.parseFloat(process.env.SCHEDULER_MEM_WARN_PERCENT || "80");
const PRESSURE_MEM_CRITICAL_PERCENT = Number.parseFloat(process.env.SCHEDULER_MEM_CRITICAL_PERCENT || "90");
const PRESSURE_LOAD_WARN_PER_CPU = Number.parseFloat(process.env.SCHEDULER_LOAD_WARN_PER_CPU || "1.5");
const PRESSURE_LOAD_CRITICAL_PER_CPU = Number.parseFloat(process.env.SCHEDULER_LOAD_CRITICAL_PER_CPU || "2.0");
const LIMIT_SCALE_WARN = Number.parseFloat(process.env.SCHEDULER_LIMIT_SCALE_WARN || "0.6");
const LIMIT_SCALE_CRITICAL = Number.parseFloat(process.env.SCHEDULER_LIMIT_SCALE_CRITICAL || "0.3");

let runningDispatch = false;
let runningAdminBroadcasts = false;
let runningAdminEvents = false;
let runningShopee = false;
let runningMeliAutomation = false;
let runningAmazonAutomation = false;
let runningChannelEvents = false;
let runningMeliVitrine = false;
let runningAmazonVitrine = false;
let runningPurge = false;

function log(message) {
	console.log(`[scheduler] ${message}`);
}

function getHeaders() {
	const headers = { "content-type": "application/json" };
	if (RPC_TOKEN) {
		headers.Authorization = `Bearer ${RPC_TOKEN}`;
		headers.apikey = RPC_TOKEN;
	}
	return headers;
}

function canRunRemoteMode() {
	return Boolean(RPC_BASE_URL);
}

function hasRemoteToken() {
	return Boolean(RPC_TOKEN);
}

function unwrapRpcData(result) {
  if (result && typeof result === "object" && "data" in result) {
    return result.data || {};
  }
  return result || {};
}

function readPressure() {
	const totalMem = os.totalmem();
	const freeMem = os.freemem();
	const usedMem = Math.max(totalMem - freeMem, 0);
	const usedMemPercent = totalMem > 0 ? (usedMem / totalMem) * 100 : 0;
	const cpuCount = Math.max(os.cpus().length, 1);
	const load1 = os.loadavg()[0] || 0;
	const loadPerCpu = load1 / cpuCount;

	const memoryCritical = usedMemPercent >= PRESSURE_MEM_CRITICAL_PERCENT;
	const memoryWarn = !memoryCritical && usedMemPercent >= PRESSURE_MEM_WARN_PERCENT;
	const loadCritical = loadPerCpu >= PRESSURE_LOAD_CRITICAL_PER_CPU;
	const loadWarn = !loadCritical && loadPerCpu >= PRESSURE_LOAD_WARN_PER_CPU;

	const level = memoryCritical || loadCritical
		? "critical"
		: memoryWarn || loadWarn
			? "warn"
			: "ok";

	return {
		level,
		usedMemPercent: Number(usedMemPercent.toFixed(1)),
		loadPerCpu: Number(loadPerCpu.toFixed(2)),
	};
}

async function invokeFunction(name, body) {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

	try {
		const response = await fetch(`${RPC_BASE_URL}/functions/v1/rpc`, {
			method: "POST",
			headers: getHeaders(),
			body: JSON.stringify({ name, ...(body || {}) }),
			signal: controller.signal,
		});

		const raw = await response.text();
		let parsed = null;

		try {
			parsed = raw ? JSON.parse(raw) : null;
		} catch {
			parsed = { raw };
		}

		if (!response.ok) {
			const message = parsed && typeof parsed === "object" && "error" in parsed
				? String(parsed.error)
				: `HTTP ${response.status}`;
			throw new Error(`${name} failed: ${message}`);
		}

		return parsed;
	} finally {
		clearTimeout(timeout);
	}
}

async function runDispatchCycle() {
	if (runningDispatch) return;
	runningDispatch = true;

	try {
		const pressure = readPressure();
		if (pressure.level === "critical") {
			log(`dispatch skipped due to host pressure critical (mem=${pressure.usedMemPercent}% load/cpu=${pressure.loadPerCpu})`);
			return;
		}

		const limitScale = pressure.level === "warn" ? LIMIT_SCALE_WARN : 1;
		const effectiveLimit = Math.max(Math.floor(DISPATCH_LIMIT * limitScale), 10);

		const result = await invokeFunction("dispatch-messages", {
			source: DISPATCH_SOURCE,
			limit: effectiveLimit,
			silent: true,
		});
		const payload = unwrapRpcData(result);

		const sent = Number(payload?.sent || 0);
		const processed = Number(payload?.processed || 0);
		const failed = Number(payload?.failed || 0);
		if (processed > 0 || sent > 0 || failed > 0) {
			log(`dispatch cycle ok: processed=${processed} sent=${sent} failed=${failed} pressure=${pressure.level} limit=${effectiveLimit}`);
		}
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		log(`dispatch cycle error: ${reason}`);
	} finally {
		runningDispatch = false;
	}
}

async function runAdminBroadcastCycle() {
  if (runningAdminBroadcasts) return;
  runningAdminBroadcasts = true;

  try {
    const pressure = readPressure();
    if (pressure.level === "critical") {
      log(`admin broadcast cycle skipped due to host pressure critical (mem=${pressure.usedMemPercent}% load/cpu=${pressure.loadPerCpu})`);
      return;
    }

    const result = await invokeFunction("admin-wa-broadcast", {
      action: "dispatch_scheduled",
      source: DISPATCH_SOURCE,
      silent: true,
    });
    const payload = unwrapRpcData(result);
    const dispatched = Number(payload?.dispatched || 0);
    const checked = Number(payload?.checked || 0);
    if (checked > 0 || dispatched > 0) {
      log(`admin broadcast cycle ok: checked=${checked} dispatched=${dispatched} pressure=${pressure.level}`);
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    log(`admin broadcast cycle error: ${reason}`);
  } finally {
    runningAdminBroadcasts = false;
  }
}

async function runAdminEventsCycle() {
  if (runningAdminEvents) return;
  runningAdminEvents = true;

  try {
    const pressure = readPressure();
    if (pressure.level === "critical") {
      log(`admin events cycle skipped due to host pressure critical (mem=${pressure.usedMemPercent}% load/cpu=${pressure.loadPerCpu})`);
      return;
    }

    const result = await invokeFunction("admin-message-automations", {
      action: "dispatch_automations",
      source: DISPATCH_SOURCE,
      silent: true,
    });
    const payload = unwrapRpcData(result);
    const dispatched = Number(payload?.dispatched || 0);
    const sent = Number(payload?.sent || 0);
    const failed = Number(payload?.failed || 0);
    const skipped = Number(payload?.skipped || 0);
    if (dispatched > 0 || sent > 0 || failed > 0 || skipped > 0) {
      log(`admin events cycle ok: dispatched=${dispatched} sent=${sent} failed=${failed} skipped=${skipped} pressure=${pressure.level}`);
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    log(`admin events cycle error: ${reason}`);
  } finally {
    runningAdminEvents = false;
  }
}

async function runShopeeCycle() {
	if (runningShopee) return;
	runningShopee = true;

	try {
		const pressure = readPressure();
		if (pressure.level === "critical") {
			log(`shopee cycle skipped due to host pressure critical (mem=${pressure.usedMemPercent}% load/cpu=${pressure.loadPerCpu})`);
			return;
		}

		const result = await invokeFunction("shopee-automation-run", {
			source: DISPATCH_SOURCE,
			pressure: pressure.level,
		});
		const payload = unwrapRpcData(result);

		const active = Number(payload?.active || 0);
		const processed = Number(payload?.processed || 0);
		const sent = Number(payload?.sent || 0);
		const skipped = Number(payload?.skipped || 0);
		const failed = Number(payload?.failed || 0);
		if (active > 0 || processed > 0 || sent > 0 || failed > 0) {
			log(`shopee cycle ok: active=${active} processed=${processed} sent=${sent} skipped=${skipped} failed=${failed} pressure=${pressure.level}`);
		}
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		log(`shopee cycle error: ${reason}`);
  } finally {
    runningShopee = false;
  }
}

async function runChannelEventsCycle() {
  if (runningChannelEvents) return;
  runningChannelEvents = true;

  try {
    const pressure = readPressure();
    if (pressure.level === "critical") {
      log(`channel events cycle skipped due to host pressure critical (mem=${pressure.usedMemPercent}% load/cpu=${pressure.loadPerCpu})`);
      return;
    }

    const result = await invokeFunction("poll-channel-events", {
      source: DISPATCH_SOURCE,
    });
    const payload = unwrapRpcData(result);

    const scope = String(payload?.scope || "unknown");
    const waSessions = Number(payload?.whatsappSessions || 0);
    const waEvents = Number(payload?.whatsappEvents || 0);
    const waFallbackAdded = Number(payload?.whatsappHealthFallbackAdded || 0);
    const tgSessions = Number(payload?.telegramSessions || 0);
    const tgEvents = Number(payload?.telegramEvents || 0);
    const tgFallbackAdded = Number(payload?.telegramHealthFallbackAdded || 0);
    const failed = Number(payload?.failed || 0);
    const orphanCleanup = payload?.orphanCleanup && typeof payload.orphanCleanup === "object"
      ? payload.orphanCleanup
      : null;
    const orphanGroupsDeleted = Number(orphanCleanup?.db?.groupsDeleted || 0);
    const orphanRuntimeRemovedWa = Number(orphanCleanup?.runtime?.removed?.whatsapp || 0);
    const orphanRuntimeRemovedTg = Number(orphanCleanup?.runtime?.removed?.telegram || 0);

    const hasChannelActivity = waEvents > 0 || tgEvents > 0 || failed > 0
      || orphanGroupsDeleted > 0 || orphanRuntimeRemovedWa > 0 || orphanRuntimeRemovedTg > 0;
    if (hasChannelActivity) {
      log(
        `channel events cycle ok: scope=${scope} wa_sessions=${waSessions} wa_events=${waEvents} wa_fallback=${waFallbackAdded} tg_sessions=${tgSessions} tg_events=${tgEvents} tg_fallback=${tgFallbackAdded} failed=${failed} orphan_groups_deleted=${orphanGroupsDeleted} orphan_runtime_removed_wa=${orphanRuntimeRemovedWa} orphan_runtime_removed_tg=${orphanRuntimeRemovedTg} pressure=${pressure.level}`,
      );
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    log(`channel events cycle error: ${reason}`);
  } finally {
    runningChannelEvents = false;
  }
}

async function runAmazonAutomationCycle() {
  if (runningAmazonAutomation) return;
  runningAmazonAutomation = true;

  try {
    const pressure = readPressure();
    if (pressure.level === "critical") {
      log(`amazon automation cycle skipped due to host pressure critical (mem=${pressure.usedMemPercent}% load/cpu=${pressure.loadPerCpu})`);
      return;
    }

    const result = await invokeFunction("amazon-automation-run", {
      source: DISPATCH_SOURCE,
      pressure: pressure.level,
    });
    const payload = unwrapRpcData(result);

    const active = Number(payload?.active || 0);
    const processed = Number(payload?.processed || 0);
    const sent = Number(payload?.sent || 0);
    const skipped = Number(payload?.skipped || 0);
    const failed = Number(payload?.failed || 0);
    if (active > 0 || processed > 0 || sent > 0 || failed > 0) {
      log(`amazon automation cycle ok: active=${active} processed=${processed} sent=${sent} skipped=${skipped} failed=${failed} pressure=${pressure.level}`);
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    log(`amazon automation cycle error: ${reason}`);
  } finally {
    runningAmazonAutomation = false;
  }
}

async function runMeliAutomationCycle() {
  if (runningMeliAutomation) return;
  runningMeliAutomation = true;

  try {
    const pressure = readPressure();
    if (pressure.level === "critical") {
      log(`meli automation cycle skipped due to host pressure critical (mem=${pressure.usedMemPercent}% load/cpu=${pressure.loadPerCpu})`);
      return;
    }

    const result = await invokeFunction("meli-automation-run", {
      source: DISPATCH_SOURCE,
      pressure: pressure.level,
    });
    const payload = unwrapRpcData(result);

    const active = Number(payload?.active || 0);
    const processed = Number(payload?.processed || 0);
    const sent = Number(payload?.sent || 0);
    const skipped = Number(payload?.skipped || 0);
    const failed = Number(payload?.failed || 0);
    if (active > 0 || processed > 0 || sent > 0 || failed > 0) {
      log(`meli automation cycle ok: active=${active} processed=${processed} sent=${sent} skipped=${skipped} failed=${failed} pressure=${pressure.level}`);
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    log(`meli automation cycle error: ${reason}`);
  } finally {
    runningMeliAutomation = false;
  }
}

async function runMeliVitrineCycle() {
  if (runningMeliVitrine) return;
  runningMeliVitrine = true;

  try {
    const pressure = readPressure();
    if (pressure.level === "critical") {
      log(`meli vitrine cycle skipped due to host pressure critical (mem=${pressure.usedMemPercent}% load/cpu=${pressure.loadPerCpu})`);
      return;
    }

    const result = await invokeFunction("meli-vitrine-sync", {
      source: DISPATCH_SOURCE,
      onlyIfStale: true,
    });
    const payload = unwrapRpcData(result);
    const skipped = payload?.skipped === true;
    const added = Number(payload?.addedCount || 0);
    const updated = Number(payload?.updatedCount || 0);
    const removed = Number(payload?.removedCount || 0);
    const fetched = Number(payload?.fetchedCards || 0);

    log(`meli vitrine cycle ok: skipped=${skipped} fetched=${fetched} added=${added} updated=${updated} removed=${removed} pressure=${pressure.level}`);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    log(`meli vitrine cycle error: ${reason}`);
  } finally {
    runningMeliVitrine = false;
  }
}

async function runAmazonVitrineCycle() {
  if (runningAmazonVitrine) return;
  runningAmazonVitrine = true;

  try {
    const pressure = readPressure();
    if (pressure.level === "critical") {
      log(`amazon vitrine cycle skipped due to host pressure critical (mem=${pressure.usedMemPercent}% load/cpu=${pressure.loadPerCpu})`);
      return;
    }

    const result = await invokeFunction("amazon-vitrine-sync", {
      source: DISPATCH_SOURCE,
      onlyIfStale: true,
    });
    const payload = unwrapRpcData(result);
    const skipped = payload?.skipped === true;
    const added = Number(payload?.addedCount || 0);
    const updated = Number(payload?.updatedCount || 0);
    const removed = Number(payload?.removedCount || 0);
    const fetched = Number(payload?.fetchedCards || 0);

    log(`amazon vitrine cycle ok: skipped=${skipped} fetched=${fetched} added=${added} updated=${updated} removed=${removed} pressure=${pressure.level}`);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    log(`amazon vitrine cycle error: ${reason}`);
  } finally {
    runningAmazonVitrine = false;
  }
}

const PURGE_INTERVAL_SECONDS = Number.parseInt(process.env.PURGE_INTERVAL_SECONDS || "86400", 10); // 24h default
const PURGE_HISTORY_DAYS = Number.parseInt(process.env.PURGE_HISTORY_DAYS || "90", 10);

async function runPurgeCycle() {
  if (runningPurge) return;
  runningPurge = true;

  try {
    const result = await invokeFunction("purge-history-entries", {
      source: DISPATCH_SOURCE,
      maxAgeDays: PURGE_HISTORY_DAYS,
      batchSize: 5000,
    });
    const payload = unwrapRpcData(result);
    const deletedTotal = Number(payload?.deletedTotal || 0);
    const batchCount   = Number(payload?.batchCount || 0);
    const durationMs   = Number(payload?.durationMs || 0);
    log(`purge cycle ok: deletedTotal=${deletedTotal} batches=${batchCount} durationMs=${durationMs} maxAgeDays=${PURGE_HISTORY_DAYS}`);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    log(`purge cycle error: ${reason}`);
  } finally {
    runningPurge = false;
  }
}

function scheduleRecurringTask(intervalSeconds, minIntervalSeconds, runner) {
  const safeIntervalMs = Math.max(minIntervalSeconds, intervalSeconds) * 1000;
  return setInterval(() => {
    void runner();
  }, safeIntervalMs);
}

function startRemoteWorker() {
  log(
    `remote mode started (dispatch=${DISPATCH_INTERVAL_SECONDS}s admin_broadcast=${ADMIN_BROADCAST_INTERVAL_SECONDS}s admin_events=${ADMIN_EVENTS_INTERVAL_SECONDS}s shopee=${SHOPEE_INTERVAL_SECONDS}s meli_auto=${MELI_AUTOMATION_INTERVAL_SECONDS}s amazon_auto=${AMAZON_AUTOMATION_INTERVAL_SECONDS}s channels=${CHANNEL_EVENTS_INTERVAL_SECONDS}s meli_vitrine=${MELI_VITRINE_INTERVAL_SECONDS}s amazon_vitrine=${AMAZON_VITRINE_INTERVAL_SECONDS}s purge=${PURGE_INTERVAL_SECONDS}s timeout=${REQUEST_TIMEOUT_MS}ms)`,
  );

  void runDispatchCycle();
  void runAdminBroadcastCycle();
  void runAdminEventsCycle();
  void runShopeeCycle();
  void runMeliAutomationCycle();
  void runAmazonAutomationCycle();
  void runChannelEventsCycle();
  void runMeliVitrineCycle();
  void runAmazonVitrineCycle();

  scheduleRecurringTask(DISPATCH_INTERVAL_SECONDS, 5, runDispatchCycle);
  scheduleRecurringTask(ADMIN_BROADCAST_INTERVAL_SECONDS, 10, runAdminBroadcastCycle);
  scheduleRecurringTask(ADMIN_EVENTS_INTERVAL_SECONDS, 10, runAdminEventsCycle);
  scheduleRecurringTask(SHOPEE_INTERVAL_SECONDS, 5, runShopeeCycle);
  scheduleRecurringTask(MELI_AUTOMATION_INTERVAL_SECONDS, 5, runMeliAutomationCycle);
  scheduleRecurringTask(AMAZON_AUTOMATION_INTERVAL_SECONDS, 5, runAmazonAutomationCycle);
  scheduleRecurringTask(CHANNEL_EVENTS_INTERVAL_SECONDS, 5, runChannelEventsCycle);
  scheduleRecurringTask(MELI_VITRINE_INTERVAL_SECONDS, 60, runMeliVitrineCycle);
  scheduleRecurringTask(AMAZON_VITRINE_INTERVAL_SECONDS, 60, runAmazonVitrineCycle);
  // Purge runs once per day (default); first run is deferred 60s so the API warms up first.
  setTimeout(() => {
    void runPurgeCycle();
    scheduleRecurringTask(PURGE_INTERVAL_SECONDS, 3600, runPurgeCycle);
  }, 60_000);
}

function startLocalFallback() {
	log("local mode detected: scheduler server-side cannot run with browser localStorage backend.");
  log("current behavior: automations and admin event center dispatches run only while app is open and authenticated in browser.");
	log("to run 24/7 without browser, migrate backend to server DB and set SCHEDULER_RPC_BASE_URL.");
}

function failAndExit(message) {
	log(message);
	process.exitCode = 1;
}

const explicitLocal = MODE === "local";
const explicitRemote = MODE === "remote";

if (explicitRemote) {
	if (!canRunRemoteMode()) {
		failAndExit("remote mode requested but SCHEDULER_RPC_BASE_URL is missing.");
	} else if (!hasRemoteToken()) {
		failAndExit("remote mode requested but SCHEDULER_RPC_TOKEN is missing.");
	} else {
		startRemoteWorker();
	}
} else if (explicitLocal) {
	if (IS_PRODUCTION) {
		failAndExit("local mode is not allowed in production. Configure SCHEDULER_MODE=remote.");
	} else {
		startLocalFallback();
	}
} else if (canRunRemoteMode()) {
	if (!hasRemoteToken()) {
		if (IS_PRODUCTION) {
			failAndExit("auto mode in production requires SCHEDULER_RPC_TOKEN when SCHEDULER_RPC_BASE_URL is set.");
		} else {
			log("auto mode: SCHEDULER_RPC_BASE_URL provided but SCHEDULER_RPC_TOKEN is missing; falling back to local mode.");
			startLocalFallback();
		}
	} else {
		startRemoteWorker();
	}
} else {
	if (IS_PRODUCTION) {
		failAndExit("auto mode in production requires SCHEDULER_RPC_BASE_URL. Local fallback is disabled.");
	} else {
		startLocalFallback();
	}
}
