import os from "node:os";

const MODE = String(process.env.SCHEDULER_MODE || "auto").trim().toLowerCase();

const DISPATCH_INTERVAL_SECONDS = Number.parseInt(process.env.DISPATCH_INTERVAL_SECONDS || "45", 10);
const SHOPEE_INTERVAL_SECONDS = Number.parseInt(process.env.SHOPEE_INTERVAL_SECONDS || "60", 10);
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
let runningShopee = false;

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

		const sent = Number(result?.sent || 0);
		const processed = Number(result?.processed || 0);
		const failed = Number(result?.failed || 0);
		log(`dispatch cycle ok: processed=${processed} sent=${sent} failed=${failed} pressure=${pressure.level} limit=${effectiveLimit}`);
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		log(`dispatch cycle error: ${reason}`);
	} finally {
		runningDispatch = false;
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

		const active = Number(result?.active || 0);
		const processed = Number(result?.processed || 0);
		const sent = Number(result?.sent || 0);
		const skipped = Number(result?.skipped || 0);
		const failed = Number(result?.failed || 0);
		log(`shopee cycle ok: active=${active} processed=${processed} sent=${sent} skipped=${skipped} failed=${failed} pressure=${pressure.level}`);
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		log(`shopee cycle error: ${reason}`);
	} finally {
		runningShopee = false;
	}
}

function startRemoteWorker() {
	log(
		`remote mode started (dispatch=${DISPATCH_INTERVAL_SECONDS}s shopee=${SHOPEE_INTERVAL_SECONDS}s timeout=${REQUEST_TIMEOUT_MS}ms)`,
	);

	void runDispatchCycle();
	void runShopeeCycle();

	setInterval(() => {
		void runDispatchCycle();
	}, Math.max(5, DISPATCH_INTERVAL_SECONDS) * 1000);

	setInterval(() => {
		void runShopeeCycle();
	}, Math.max(5, SHOPEE_INTERVAL_SECONDS) * 1000);
}

function startLocalFallback() {
	log("local mode detected: scheduler server-side cannot run with browser localStorage backend.");
	log("current behavior: automations run only while app is open and authenticated in browser.");
	log("to run 24/7 without browser, migrate backend to server DB and set SCHEDULER_RPC_BASE_URL.");
}

const explicitLocal = MODE === "local";
const explicitRemote = MODE === "remote";

if (explicitRemote) {
	if (!canRunRemoteMode()) {
		log("remote mode requested but SCHEDULER_RPC_BASE_URL is missing.");
		process.exitCode = 1;
	} else if (!hasRemoteToken()) {
		log("remote mode requested but SCHEDULER_RPC_TOKEN is missing.");
		process.exitCode = 1;
	} else {
		startRemoteWorker();
	}
} else if (explicitLocal) {
	startLocalFallback();
} else if (canRunRemoteMode()) {
	if (!hasRemoteToken()) {
		log("auto mode: SCHEDULER_RPC_BASE_URL provided but SCHEDULER_RPC_TOKEN is missing; falling back to local mode.");
		startLocalFallback();
	} else {
		startRemoteWorker();
	}
} else {
	startLocalFallback();
}
