import process from "node:process";

const API_URL = process.env.MONITOR_API_URL || "http://127.0.0.1:3116";
const MONITOR_EMAIL = process.env.MONITOR_EMAIL || "aliancaslovely@gmail.com";
const MONITOR_PASSWORD = process.env.MONITOR_PASSWORD || "abacate1";

function readArg(name, fallback = "") {
  const index = process.argv.findIndex((arg) => arg === `--${name}`);
  if (index >= 0 && process.argv[index + 1]) return String(process.argv[index + 1]);
  return fallback;
}

function readBoolArg(name, fallback = false) {
  const index = process.argv.findIndex((arg) => arg === `--${name}`);
  if (index < 0) return fallback;
  const next = process.argv[index + 1];
  if (!next || String(next).startsWith("--")) return true;
  const normalized = String(next).trim().toLowerCase();
  if (["1", "true", "yes", "on", "y", "sim"].includes(normalized)) return true;
  if (["0", "false", "no", "off", "n", "nao"].includes(normalized)) return false;
  return fallback;
}

const REASON_HINTS = {
  missing_image_required: "A rota exige imagem, mas ela nao estava disponivel para envio.",
  image_ingestion_failed: "A imagem foi detectada, mas falhou na captura/download.",
  unsupported_media_type: "Tipo de midia nao suportado pela rota.",
  destination_send_failed: "Falha no envio para o destino (verificar sessao/conector).",
  destination_session_offline: "Sessao de destino offline ou sem identificador.",
  destination_not_found: "Grupo de destino nao encontrado.",
  no_active_routes: "Nao havia rota ativa para a origem da mensagem.",
  no_destination_groups: "Rota sem grupos de destino configurados.",
  no_destination_groups_for_session: "Rota sem destino para a sessao filtrada.",
  route_processing_error: "Erro interno no processamento da rota.",
  partner_link_required: "A rota exige link parceiro e a mensagem nao tinha um valido.",
  marketplace_not_enabled: "Marketplace do link nao esta habilitado na rota.",
  missing_text_required: "A mensagem ficou sem texto valido apos processamento.",
  negative_keyword: "Mensagem bloqueada por palavra-chave negativa.",
  positive_keyword_missing: "Mensagem nao contem palavra-chave positiva exigida.",
};

function nowIso() {
  return new Date().toISOString();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeProcessingStatus(row) {
  const processing = String(row?.processing_status || "").trim().toLowerCase();
  if (processing === "sent" || processing === "failed" || processing === "blocked" || processing === "processed") {
    return processing;
  }

  const status = String(row?.status || "").trim().toLowerCase();
  if (status === "success") return "sent";
  if (status === "error") return "failed";
  if (status === "warning") return "blocked";
  return "processed";
}

function parseDetails(raw) {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw;
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch {
      return null;
    }
  }
  return null;
}

function firstText(...values) {
  for (const value of values) {
    if (value === null || value === undefined) continue;
    const normalized = String(value).trim();
    if (normalized) return normalized;
  }
  return "";
}

function shorten(value, max = 140) {
  const text = String(value || "").trim().replace(/\s+/g, " ");
  if (!text) return "";
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(max - 3, 0))}...`;
}

function summarizeRouteIssues(rows, maxSamples = 3) {
  const all = Array.isArray(rows) ? rows : [];
  const issues = [];
  const buckets = new Map();
  let failed = 0;
  let blocked = 0;
  let imageIssues = 0;

  for (const row of all) {
    const processing = normalizeProcessingStatus(row);
    const hasIssue = processing === "failed" || processing === "blocked";
    if (!hasIssue) continue;

    const details = parseDetails(row?.details);
    const reason = String(firstText(
      row?.block_reason,
      details?.reason,
      processing === "failed" ? "failed_without_reason" : "blocked_without_reason",
    )).toLowerCase();
    const step = String(firstText(row?.error_step, details?.errorStep, "-")).toLowerCase();
    const key = `${reason}|${step}`;
    buckets.set(key, {
      reason,
      step,
      count: Number((buckets.get(key)?.count || 0)) + 1,
    });

    if (processing === "failed") failed += 1;
    if (processing === "blocked") blocked += 1;
    if (reason.includes("image") || step.includes("media")) imageIssues += 1;

    const detailMessage = firstText(
      details?.error,
      details?.message,
      details?.reason,
      row?.block_reason,
    );

    issues.push({
      createdAt: row?.created_at || null,
      type: firstText(row?.type, "-"),
      direction: firstText(row?.direction, "-"),
      processing,
      reason,
      step,
      destination: firstText(row?.destination, "-"),
      source: firstText(row?.source, "-"),
      messageType: firstText(row?.message_type, "-"),
      detailMessage: shorten(detailMessage, 180),
    });
  }

  const sortedBuckets = [...buckets.values()]
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason))
    .slice(0, 6);
  const sampleSize = Math.max(0, Number(maxSamples || 0));
  const samples = sampleSize > 0 ? issues.slice(0, sampleSize) : [];

  return {
    total: issues.length,
    failed,
    blocked,
    imageIssues,
    topReasons: sortedBuckets,
    samples,
  };
}

function reasonHint(reason) {
  return REASON_HINTS[String(reason || "").trim().toLowerCase()] || "";
}

async function jsonRequest(path, options = {}) {
  let response;
  try {
    response = await fetch(`${API_URL}${path}`, options);
  } catch (error) {
    const cause = error && typeof error === "object" && "cause" in error
      ? error.cause
      : null;
    const causeCode = cause && typeof cause === "object" && "code" in cause
      ? String(cause.code || "")
      : "";
    const causeDetail = causeCode ? ` (${causeCode})` : "";
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Falha ao conectar na API ${API_URL}${path}: ${message}${causeDetail}`);
  }
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  return { response, json };
}

async function signIn() {
  const { response, json } = await jsonRequest("/auth/signin", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: MONITOR_EMAIL,
      password: MONITOR_PASSWORD,
    }),
  });

  const cookie = response.headers.get("set-cookie") || "";
  const userId = json?.data?.user?.id || "";

  if (!response.ok || !cookie || !userId) {
    const message = json?.error?.message || "Falha no login para monitoramento";
    throw new Error(`${message} (status=${response.status})`);
  }

  return { cookie, userId };
}

async function rpc(cookie, name, body = {}) {
  const { response, json } = await jsonRequest("/functions/v1/rpc", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie,
    },
    body: JSON.stringify({ name, ...body }),
  });

  return {
    status: response.status,
    data: json?.data ?? null,
    error: json?.error?.message || null,
  };
}

async function rest(cookie, table, body) {
  const { response, json } = await jsonRequest(`/api/rest/${table}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie,
    },
    body: JSON.stringify(body),
  });

  return {
    status: response.status,
    data: json?.data ?? null,
    count: typeof json?.count === "number" ? json.count : null,
    error: json?.error?.message || null,
  };
}

function summarizeHistoryRows(rows) {
  const all = Array.isArray(rows) ? rows : [];
  const sent = all.filter((row) => normalizeProcessingStatus(row) === "sent").length;
  const failed = all.filter((row) => normalizeProcessingStatus(row) === "failed").length;
  const blocked = all.filter((row) => normalizeProcessingStatus(row) === "blocked").length;
  const processed = all.filter((row) => normalizeProcessingStatus(row) === "processed").length;
  const inbound = all.filter((row) => String(row?.direction || "") === "inbound").length;
  const outbound = all.filter((row) => String(row?.direction || "") === "outbound").length;

  return {
    total: all.length,
    sent,
    failed,
    blocked,
    processed,
    inbound,
    outbound,
  };
}

function extractPlatform(details) {
  if (details && typeof details === "object" && !Array.isArray(details)) {
    const value = String(details.platform || "").trim().toLowerCase();
    if (value === "whatsapp" || value === "telegram") return value;
    return "";
  }
  if (typeof details === "string") {
    try {
      const parsed = JSON.parse(details);
      if (parsed && typeof parsed === "object") {
        const value = String(parsed.platform || "").trim().toLowerCase();
        if (value === "whatsapp" || value === "telegram") return value;
      }
    } catch {
      return "";
    }
  }
  return "";
}

function summarizeCaptureRows(rows) {
  const all = Array.isArray(rows) ? rows : [];
  let whatsapp = 0;
  let telegram = 0;

  for (const row of all) {
    const platform = extractPlatform(row?.details);
    if (platform === "whatsapp") whatsapp += 1;
    if (platform === "telegram") telegram += 1;
  }

  return {
    total: all.length,
    whatsapp,
    telegram,
  };
}

function shortTs(value) {
  if (!value) return "-";
  const text = String(value);
  return text.replace("T", " ").replace(".000Z", "Z");
}

function aggregateConnectorIngestion(rawSessions) {
  const sessions = Array.isArray(rawSessions) ? rawSessions : [];
  let messagesSeen = 0;
  let accepted = 0;
  let duplicates = 0;
  let dropped = 0;
  let lastAcceptedAt = null;
  let lastDroppedAt = null;

  for (const session of sessions) {
    const ingestion = session && typeof session === "object" && session.ingestion && typeof session.ingestion === "object"
      ? session.ingestion
      : null;
    if (!ingestion) continue;

    messagesSeen += Number(ingestion.messagesSeen || 0);
    accepted += Number(ingestion.accepted || 0);
    duplicates += Number(ingestion.duplicates || 0);

    const droppedMap = ingestion.dropped && typeof ingestion.dropped === "object"
      ? ingestion.dropped
      : {};
    for (const value of Object.values(droppedMap)) {
      dropped += Number(value || 0);
    }

    const acceptedAt = typeof ingestion.lastAcceptedAt === "string" ? ingestion.lastAcceptedAt : null;
    const droppedAt = typeof ingestion.lastDroppedAt === "string" ? ingestion.lastDroppedAt : null;
    if (acceptedAt && (!lastAcceptedAt || acceptedAt > lastAcceptedAt)) lastAcceptedAt = acceptedAt;
    if (droppedAt && (!lastDroppedAt || droppedAt > lastDroppedAt)) lastDroppedAt = droppedAt;
  }

  return {
    sessions: sessions.length,
    messagesSeen,
    accepted,
    duplicates,
    dropped,
    lastAcceptedAt,
    lastDroppedAt,
  };
}

function summarizeTelegramHandlerState(rawSessions) {
  const sessions = Array.isArray(rawSessions) ? rawSessions : [];
  let total = 0;
  let bound = 0;
  let withClient = 0;

  for (const session of sessions) {
    if (!session || typeof session !== "object") continue;
    total += 1;
    if (session.messageHandlerBound === true) bound += 1;
    if (session.hasClient === true) withClient += 1;
  }

  return { total, bound, withClient };
}

async function collectSnapshot(cookie, userId, windowMinutes, sourceTag, issueSamplesLimit) {
  const wa = await rpc(cookie, "whatsapp-connect", { action: "health" });
  const tg = await rpc(cookie, "telegram-connect", { action: "health" });
  const poll = await rpc(cookie, "poll-channel-events", { source: sourceTag });

  const fromIso = new Date(Date.now() - windowMinutes * 60_000).toISOString();
  const routeHistory = await rest(cookie, "history_entries", {
    op: "select",
    columns: "id,type,status,source,destination,direction,message_type,processing_status,block_reason,error_step,details,created_at",
    filters: [
      { type: "gte", col: "created_at", val: fromIso },
      { type: "in", col: "type", val: ["route_forward", "schedule_sent"] },
    ],
    options: {
      order: [{ col: "created_at", ascending: false }],
      limit: 400,
    },
  });
  const captureHistory = await rest(cookie, "history_entries", {
    op: "select",
    columns: "id,type,status,direction,processing_status,details,created_at",
    filters: [
      { type: "gte", col: "created_at", val: fromIso },
      { type: "eq", col: "type", val: "session_event" },
      { type: "eq", col: "direction", val: "inbound" },
    ],
    options: {
      order: [{ col: "created_at", ascending: false }],
      limit: 800,
    },
  });

  const waSessions = await rest(cookie, "whatsapp_sessions", {
    op: "select",
    columns: "id,status,connected_at,error_message,updated_at",
    options: { order: [{ col: "updated_at", ascending: false }], limit: 10 },
  });

  const tgSessions = await rest(cookie, "telegram_sessions", {
    op: "select",
    columns: "id,status,connected_at,error_message,updated_at",
    options: { order: [{ col: "updated_at", ascending: false }], limit: 10 },
  });

  const groupsCount = await rest(cookie, "groups", {
    op: "select",
    columns: "id",
    filters: [{ type: "is", col: "deleted_at", val: null }],
    options: { count: "exact", head: true },
  });

  const historySummary = summarizeHistoryRows(routeHistory.data);
  const captureSummary = summarizeCaptureRows(captureHistory.data);
  const waSessionRows = Array.isArray(waSessions.data) ? waSessions.data : [];
  const tgSessionRows = Array.isArray(tgSessions.data) ? tgSessions.data : [];
  const waIngestion = aggregateConnectorIngestion(wa.data?.sessions);
  const tgIngestion = aggregateConnectorIngestion(tg.data?.sessions);
  const tgHandler = summarizeTelegramHandlerState(tg.data?.sessions);
  const routeIssues = summarizeRouteIssues(routeHistory.data, issueSamplesLimit);

  return {
    checkedAt: nowIso(),
    userId,
    health: {
      waOnline: wa.data?.online === true,
      waError: wa.data?.error || wa.error,
      tgOnline: tg.data?.online === true,
      tgError: tg.data?.error || tg.error,
      waUptimeSec: typeof wa.data?.uptimeSec === "number" ? wa.data.uptimeSec : null,
      tgUptimeSec: typeof tg.data?.uptimeSec === "number" ? tg.data.uptimeSec : null,
    },
    poll: {
      source: poll.data?.source || sourceTag,
      scope: poll.data?.scope || null,
      failed: poll.data?.failed ?? null,
      whatsappSessions: poll.data?.whatsappSessions ?? null,
      whatsappEvents: poll.data?.whatsappEvents ?? null,
      telegramSessions: poll.data?.telegramSessions ?? null,
      telegramEvents: poll.data?.telegramEvents ?? null,
    },
    sessions: {
      waTotal: waSessionRows.length,
      waOnline: waSessionRows.filter((row) => row.status === "online").length,
      tgTotal: tgSessionRows.length,
      tgOnline: tgSessionRows.filter((row) => row.status === "online").length,
    },
    ingestion: {
      wa: waIngestion,
      tg: tgIngestion,
    },
    telegramRuntime: tgHandler,
    groups: {
      total: groupsCount.count,
    },
    historyWindow: {
      minutes: windowMinutes,
      from: fromIso,
      ...historySummary,
    },
    routeIssues,
    captureWindow: {
      minutes: windowMinutes,
      from: fromIso,
      ...captureSummary,
    },
  };
}

function printSnapshot(snapshot, options = {}) {
  const onlyIssues = options.onlyIssues === true;
  const {
    checkedAt,
    health,
    poll,
    sessions,
    ingestion,
    telegramRuntime,
    groups,
    historyWindow,
    routeIssues,
    captureWindow,
  } = snapshot;

  const waState = health.waOnline ? "ONLINE" : "OFFLINE";
  const tgState = health.tgOnline ? "ONLINE" : "OFFLINE";
  const waErr = health.waError ? ` err=${health.waError}` : "";
  const tgErr = health.tgError ? ` err=${health.tgError}` : "";

  if (onlyIssues && routeIssues.total === 0) {
    return;
  }

  console.log(`[monitor] ${checkedAt}`);
  console.log(`[monitor] WA=${waState}${waErr} | TG=${tgState}${tgErr}`);
  console.log(
    `[monitor] poll scope=${poll.scope || "-"} failed=${poll.failed ?? "-"} ` +
    `waSessions=${poll.whatsappSessions ?? "-"} waEvents=${poll.whatsappEvents ?? "-"} ` +
    `tgSessions=${poll.telegramSessions ?? "-"} tgEvents=${poll.telegramEvents ?? "-"}`,
  );
  console.log(
    `[monitor] sessions wa=${sessions.waOnline}/${sessions.waTotal} tg=${sessions.tgOnline}/${sessions.tgTotal} ` +
    `| groups=${groups.total ?? "-"}`,
  );
  if (telegramRuntime.total > 0) {
    console.log(
      `[monitor] tg runtime handlers=${telegramRuntime.bound}/${telegramRuntime.total} client=${telegramRuntime.withClient}/${telegramRuntime.total}`,
    );
  }
  console.log(
    `[monitor] ingest wa seen=${ingestion.wa.messagesSeen} accepted=${ingestion.wa.accepted} ` +
    `dup=${ingestion.wa.duplicates} drop=${ingestion.wa.dropped} | ` +
    `tg seen=${ingestion.tg.messagesSeen} accepted=${ingestion.tg.accepted} ` +
    `dup=${ingestion.tg.duplicates} drop=${ingestion.tg.dropped}`,
  );
  console.log(
    `[monitor] ingest last waAccepted=${shortTs(ingestion.wa.lastAcceptedAt)} waDropped=${shortTs(ingestion.wa.lastDroppedAt)} | ` +
    `tgAccepted=${shortTs(ingestion.tg.lastAcceptedAt)} tgDropped=${shortTs(ingestion.tg.lastDroppedAt)}`,
  );
  console.log(
    `[monitor] history ${historyWindow.minutes}m total=${historyWindow.total} sent=${historyWindow.sent} ` +
    `failed=${historyWindow.failed} blocked=${historyWindow.blocked} processed=${historyWindow.processed}`,
  );
  if (routeIssues.total > 0) {
    console.log(
      `[monitor] issues ${historyWindow.minutes}m total=${routeIssues.total} failed=${routeIssues.failed} ` +
      `blocked=${routeIssues.blocked} imageRelated=${routeIssues.imageIssues}`,
    );
    if (routeIssues.topReasons.length > 0) {
      const topText = routeIssues.topReasons
        .map((bucket) => `${bucket.reason}@${bucket.step}=${bucket.count}`)
        .join(" | ");
      console.log(`[monitor] issues top ${topText}`);
    }
    for (const issue of routeIssues.samples) {
      const hint = reasonHint(issue.reason);
      const hintText = hint ? ` hint=${hint}` : "";
      console.log(
        `[monitor] issue at=${shortTs(issue.createdAt)} type=${issue.type} dir=${issue.direction} ` +
        `proc=${issue.processing} reason=${issue.reason} step=${issue.step} ` +
        `dest=${issue.destination} src=${issue.source} msgType=${issue.messageType}${hintText}`,
      );
      if (issue.detailMessage) {
        console.log(`[monitor] issue detail ${issue.detailMessage}`);
      }
    }
  } else {
    console.log(`[monitor] issues ${historyWindow.minutes}m none`);
  }
  console.log(
    `[monitor] history dir inbound=${historyWindow.inbound} outbound=${historyWindow.outbound}`,
  );
  console.log(
    `[monitor] capture ${captureWindow.minutes}m total=${captureWindow.total} wa=${captureWindow.whatsapp} tg=${captureWindow.telegram}`,
  );
  console.log("");
}

async function main() {
  const intervalMs = Math.max(2_000, Number(readArg("interval-ms", "8000")) || 8000);
  const windowMinutes = Math.max(1, Number(readArg("window-min", "20")) || 20);
  const maxTicks = Math.max(0, Number(readArg("ticks", "0")) || 0);
  const issuesLimit = Math.max(0, Number(readArg("issues-limit", "3")) || 3);
  const onlyIssues = readBoolArg("only-issues", false);
  const exitOnIssue = readBoolArg("exit-on-issue", false);

  const { cookie, userId } = await signIn();
  console.log(`[monitor] authenticated user=${userId} api=${API_URL}`);
  console.log(
    `[monitor] interval=${intervalMs}ms window=${windowMinutes}m ticks=${maxTicks === 0 ? "infinite" : maxTicks} ` +
    `issuesLimit=${issuesLimit} onlyIssues=${onlyIssues ? "on" : "off"} exitOnIssue=${exitOnIssue ? "on" : "off"}`,
  );
  console.log("");

  let tick = 0;
  while (true) {
    tick += 1;
    const sourceTag = `monitor-channel-flow-${tick}`;
    try {
      const snapshot = await collectSnapshot(cookie, userId, windowMinutes, sourceTag, issuesLimit);
      printSnapshot(snapshot, { onlyIssues });
      if (exitOnIssue && snapshot.routeIssues.total > 0) {
        console.error(`[monitor] aborting after detecting route issues.`);
        process.exit(2);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[monitor] snapshot failed: ${message}`);
    }

    if (maxTicks > 0 && tick >= maxTicks) break;
    await sleep(intervalMs);
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  if (String(message).includes("Falha ao conectar na API")) {
    console.error(
      `[monitor] dica: inicie a API local antes de monitorar (ex.: "npm run dev" ou "npm run svc:api:dev").`,
    );
  }
  process.exit(1);
});
