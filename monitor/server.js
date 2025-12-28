const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const url = require("url");
const { spawn, spawnSync } = require("child_process");

function readLink(baseDir, filename) {
  const p = path.join(baseDir, filename);
  if (!fs.existsSync(p)) return "";
  const raw = fs.readFileSync(p, "utf-8").trim();
  if (!raw) return "";
  return path.isAbsolute(raw) ? raw : path.resolve(baseDir, raw);
}

function resolveMementoRoot(baseDir) {
  if (fs.existsSync(path.join(baseDir, ".memento"))) {
    return path.join(baseDir, ".memento");
  }
  const direct = readLink(baseDir, ".memento-root");
  if (direct) return direct;
  const parent = path.dirname(baseDir);
  const sibling = path.join(parent, `${path.basename(baseDir)}-memento`, ".memento");
  if (fs.existsSync(sibling)) return sibling;
  return path.join(baseDir, ".memento");
}
const repoRoot = path.resolve(__dirname, "..");
const mementoRoot = process.env.MEMENTO_ROOT || resolveMementoRoot(repoRoot);
const activityDir = path.join(mementoRoot, "state", "activity");
const chatDir = path.join(mementoRoot, "state", "chat");
const configPath = path.join(mementoRoot, "config.json");
const boardPath = path.join(mementoRoot, "state", "board.json");
const kickScript =
  process.env.MEMENTO_KICK_SCRIPT ||
  path.join(
    process.env.HOME || "",
    "Documents",
    "HomeDev",
    "memento",
    "scripts",
    "baton_kick.sh"
  );
const agentdSocket = process.env.MEMENTO_AGENTD_SOCKET || "/tmp/memento-agentd.sock";
const agentdScript =
  process.env.MEMENTO_AGENTD_SCRIPT ||
  (fs.existsSync(path.resolve(repoRoot, "..", "memento", "scripts", "agentd.py"))
    ? path.resolve(repoRoot, "..", "memento", "scripts", "agentd.py")
    : path.join(process.env.HOME || "", "Documents", "HomeDev", "memento", "scripts", "agentd.py"));
const chatSessionState = new Map();
const chatLastMessage = new Map();
const chatLastResponse = new Map();
const chatTimeoutMs = 5 * 60 * 1000;
const chatSlaMs = 2 * 60 * 1000;
const endPhrases = [
  "bye",
  "see ya",
  "see you",
  "see you later",
  "seeya",
  "over and out",
  "goodbye",
  "later",
  "gtg",
  "gotta go",
  "talk later",
  "thanks, bye",
  "thanks bye"
];

function listAgents() {
  if (!fs.existsSync(configPath)) return [];
  try {
    const cfg = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    return Object.entries(cfg.agents || {}).map(([key, meta]) => ({
      id: key,
      personDisplayName: meta.personDisplayName || "",
      roleDisplayName: meta.roleDisplayName || ""
    }));
  } catch {
    return [];
  }
}

function readActivityForDate(dateStr) {
  const p = path.join(activityDir, `${dateStr}.jsonl`);
  if (!fs.existsSync(p)) return [];
  const raw = fs.readFileSync(p, "utf-8").trim();
  if (!raw) return [];
  return raw
    .split("\n")
    .map(line => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function readActivityForDates(dateStrs) {
  const all = [];
  dateStrs.forEach(dateStr => {
    readActivityForDate(dateStr).forEach(entry => all.push(entry));
  });
  return all;
}

function readActivityTail(limit) {
  const dates = [todayUtc(), yesterdayUtc()];
  const entries = readActivityForDates(dates);
  entries.sort((a, b) => {
    const aTs = Date.parse(a.ts || "") || 0;
    const bTs = Date.parse(b.ts || "") || 0;
    return bTs - aTs;
  });
  return entries.slice(0, limit);
}

function listChatChannels() {
  if (!fs.existsSync(chatDir)) return [];
  return fs
    .readdirSync(chatDir)
    .filter(name => name.endsWith(".log"))
    .map(name => name.replace(/\.log$/, ""));
}

function readChatChannel(channel) {
  const p = path.join(chatDir, `${channel}.log`);
  if (!fs.existsSync(p)) return [];
  const raw = fs.readFileSync(p, "utf-8").trim();
  if (!raw) return [];
  return raw
    .split("\n")
    .map(line => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function appendChatMessage(channel, agent, message) {
  if (!fs.existsSync(chatDir)) {
    fs.mkdirSync(chatDir, { recursive: true });
  }
  const entry = {
    ts: new Date().toISOString(),
    channel,
    agent,
    message: String(message)
  };
  fs.appendFileSync(path.join(chatDir, `${channel}.log`), `${JSON.stringify(entry)}\n`);
  return entry;
}


function buildChatSummary(agents) {
  const agentMap = {};
  agents.forEach(agent => {
    agentMap[agent.id] = agent;
  });
  const selfAgent = "product-owner";
  const channels = listChatChannels();
  const summaries = new Map();
  channels.forEach(channel => {
    const participants = parseParticipants(channel);
    if (!participants.includes(selfAgent)) return;
    const normalized = [...participants].sort().join("__");
    const messages = readChatChannel(channel);
    const last = messages[messages.length - 1] || null;
    const otherAgent = participants.find(p => p !== selfAgent) || selfAgent;
    const entry = {
      channel,
      lastMessage: last ? last.message : "",
      lastTs: last ? last.ts : "",
      agent: agentMap[otherAgent] || null,
      otherAgentId: otherAgent
    };
    const existing = summaries.get(normalized);
    if (!existing) {
      summaries.set(normalized, entry);
      return;
    }
    const prefersCurrent = channel.startsWith(`${selfAgent}__`);
    const prefersExisting = existing.channel.startsWith(`${selfAgent}__`);
    if (prefersCurrent && !prefersExisting) {
      summaries.set(normalized, entry);
      return;
    }
    if (!prefersCurrent && prefersExisting) {
      return;
    }
    const existingTs = existing.lastTs ? Date.parse(existing.lastTs) : 0;
    const currentTs = entry.lastTs ? Date.parse(entry.lastTs) : 0;
    if (currentTs >= existingTs) {
      summaries.set(normalized, entry);
    }
  });

  return Array.from(summaries.values()).sort((a, b) => {
    const aTs = a.lastTs ? Date.parse(a.lastTs) : 0;
    const bTs = b.lastTs ? Date.parse(b.lastTs) : 0;
    return bTs - aTs;
  });
}

function summarizeActivityByAgent(dateStrs) {
  const entries = readActivityForDates(dateStrs);
  const summary = {};
  for (const entry of entries) {
    const agent = entry.agent || "system";
    if (!summary[agent]) {
      summary[agent] = { latest: null, lastCompleted: null };
    }
    if (!summary[agent].latest) {
      summary[agent].latest = entry;
    } else {
      const prevTs = Date.parse(summary[agent].latest.ts || "") || 0;
      const nextTs = Date.parse(entry.ts || "") || 0;
      if (nextTs >= prevTs) summary[agent].latest = entry;
    }
    const msg = String(entry.message || "").toLowerCase();
    if (msg.includes("complete")) {
      summary[agent].lastCompleted = entry;
    }
  }
  return summary;
}

function fallbackFromLog(agentName, summary) {
  return summary[agentName]?.lastCompleted || null;
}

function computeActivityViews(entry, lastCompleted) {
  const rawMsg = entry?.message || "";
  const lower = String(rawMsg).toLowerCase();
  const isComplete = lower.includes("complete");
  let currentActivity = rawMsg || "No recent activity";
  if (lower.includes("procedure e")) {
    currentActivity = "Cleanup pass in progress";
  }
  if (isComplete) {
    currentActivity = "Idle";
  }
  const lastCompletedActivity = lastCompleted?.message || (isComplete ? rawMsg : "");
  return { currentActivity, lastCompletedActivity, isComplete };
}

function readBoard() {
  if (!fs.existsSync(boardPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(boardPath, "utf-8"));
  } catch {
    return null;
  }
}

function fallbackFromBoard(agentName, board) {
  if (!board || !board.tasks) return null;
  const tasks = Object.values(board.tasks)
    .filter(t => t.owner === agentName && ["assigned", "in_progress", "blocked", "needs_review"].includes(t.status))
    .sort((a, b) => {
      const ap = a.priority || 0;
      const bp = b.priority || 0;
      return bp - ap;
    });
  if (!tasks.length) return null;
  const top = tasks[0];
  return {
    ts: board.lastUpdatedAt || "",
    agent: agentName,
    story: "",
    tasks: [top.id],
    tags: ["board"],
    message: `Board status: ${top.status}`
  };
}

function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}

function yesterdayUtc() {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

function serveJson(res, data) {
  const body = JSON.stringify(data, null, 2);
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(body);
}

function callAgentd(payload) {
  if (!fs.existsSync(agentdScript)) return false;
  const result = spawnSync("python3", [agentdScript, "once", JSON.stringify(payload)], {
    env: { ...process.env, MEMENTO_ROOT: mementoRoot },
    stdio: "ignore",
    timeout: 5000
  });
  return result.status === 0;
}

function parseParticipants(channel) {
  if (!channel.includes("__")) return [channel];
  return channel.split("__").map(part => part.trim()).filter(Boolean);
}

function isEndPhrase(message) {
  const lower = String(message || "").toLowerCase();
  return endPhrases.some(phrase => lower.includes(phrase));
}

function startChatSession(agentId, channel, sender, message) {
  if (!agentId || agentId === sender) return;
  if (!fs.existsSync(agentdScript)) return;
  if (callAgentd({ cmd: "chat_start", agent: agentId, channel, sender, message })) return;
}

function stopChatSession(agentId, channel) {
  if (!agentId) return;
  callAgentd({ cmd: "chat_stop", agent: agentId, channel });
}

function hasActiveChat(agentId) {
  for (const key of chatSessionState.keys()) {
    if (key.startsWith(`${agentId}::`)) return true;
  }
  return false;
}


function activeChatSince(agentId) {
  let latest = 0;
  for (const [key, lastTs] of chatSessionState.entries()) {
    if (!key.startsWith(`${agentId}::`)) continue;
    if (lastTs > latest) latest = lastTs;
  }
  return latest || 0;
}

function wakeAgent(agentId, sender, message) {
  if (!agentId || agentId === sender) return;
  if (!fs.existsSync(kickScript)) return;
  const prompt = [
    "# MEMENTO PROMPT",
    "",
    `Target agent: **${agentId}**`,
    "",
    `You have a new chat message from ${sender || "a teammate"}:`,
    message ? `"${String(message).slice(0, 200)}"` : "",
    "",
    "Please check the monitor chat and respond if needed."
  ]
    .filter(Boolean)
    .join("\n");
  const tempName = `monitor_wake_${agentId}_${Date.now()}.md`;
  const tempPath = path.join(os.tmpdir(), tempName);
  fs.writeFileSync(tempPath, prompt, "utf-8");
  spawn(kickScript, [agentId, tempPath], { stdio: "ignore", detached: true }).unref();
}

function readRequestBody(req, cb) {
  let body = "";
  req.on("data", chunk => {
    body += chunk;
  });
  req.on("end", () => {
    cb(body);
  });
}

function serveIndex(res) {
  const html = fs.readFileSync(path.join(__dirname, "ui", "index.html"), "utf-8");
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
}

function serveAsset(res, relPath) {
  const base = path.join(__dirname, "ui");
  const p = path.normalize(path.join(base, relPath));
  if (!p.startsWith(base)) return false;
  if (!fs.existsSync(p)) return false;
  const ext = path.extname(p).toLowerCase();
  const type = ext === ".png" ? "image/png" : "application/octet-stream";
  res.writeHead(200, { "Content-Type": type });
  fs.createReadStream(p).pipe(res);
  return true;
}

function handler(req, res) {
  const parsed = url.parse(req.url || "", true);
  if (parsed.pathname === "/api/status") {
    const date = String(parsed.query.date || todayUtc());
    const dates = parsed.query.date ? [date] : [todayUtc(), yesterdayUtc()];
    const agents = listAgents();
    const summary = summarizeActivityByAgent(dates);
    const board = readBoard();
    const payload = agents.map(agent => {
      const entry = summary[agent.id]?.latest || fallbackFromBoard(agent.id, board);
      const lastCompleted = summary[agent.id]?.lastCompleted || fallbackFromLog(agent.id, summary);
      const view = computeActivityViews(entry, lastCompleted);
      const agentLastMessage = chatLastMessage.get(agent.id) || null;
      const agentLastResponse = chatLastResponse.get(agent.id) || null;
      return {
        agent: agent.id,
        personDisplayName: agent.personDisplayName,
        roleDisplayName: agent.roleDisplayName,
        activity: entry,
        lastCompleted,
        currentActivity: view.currentActivity,
        lastCompletedActivity: view.lastCompletedActivity,
        chatActive: hasActiveChat(agent.id),
        forceOnline: agent.id === "product-owner",
        lastSeen: entry?.ts || "",
        lastMessageAt: agentLastMessage?.ts || "",
        lastMessageFrom: agentLastMessage?.from || "",
        lastResponseAt: agentLastResponse?.ts || "",
        chatStartedAt: activeChatSince(agent.id) ? new Date(activeChatSince(agent.id)).toISOString() : ""
      };
    });
    return serveJson(res, { date, agents: payload });
  }

  if (parsed.pathname === "/api/chat/summary") {
    const agents = listAgents();
    return serveJson(res, { channels: buildChatSummary(agents) });
  }

  if (parsed.pathname === "/api/activity") {
    const limit = Math.max(1, Math.min(200, Number(parsed.query.limit) || 50));
    const entries = readActivityTail(limit);
    return serveJson(res, { entries });
  }

  if (parsed.pathname === "/api/chat/prewarm" && req.method === "POST") {
    return readRequestBody(req, raw => {
      let payload = null;
      try {
        payload = JSON.parse(raw || "{}");
      } catch {
        payload = null;
      }
      if (!payload) {
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end("Invalid payload");
        return;
      }
      const agents = Array.isArray(payload?.agents) ? payload.agents : [];
      const ok = callAgentd({ cmd: "chat_prewarm", agents });
      return serveJson(res, { ok });
    });
  }

  if (parsed.pathname && parsed.pathname.startsWith("/api/chat/")) {
    const channel = decodeURIComponent(parsed.pathname.replace("/api/chat/", ""));
    if (!channel) {
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end("Missing channel");
      return;
    }
    if (req.method === "GET") {
      const messages = readChatChannel(channel);
      const limit = Math.max(1, Math.min(100, Number(parsed.query.limit) || 25));
      const before = Math.max(0, Number(parsed.query.before) || 0);
      const total = messages.length;
      const end = Math.max(0, total - before);
      const start = Math.max(0, end - limit);
      const slice = messages.slice(start, end);
      const nextBefore = total - start;
      return serveJson(res, { channel, messages: slice, total, nextBefore });
    }
    if (req.method === "DELETE") {
      const p = path.join(chatDir, `${channel}.log`);
      if (!fs.existsSync(p)) {
        return serveJson(res, { ok: true, deleted: 0 });
      }
      const raw = fs.readFileSync(p, "utf-8").trim();
      if (!raw) {
        return serveJson(res, { ok: true, deleted: 0 });
      }
      const lines = raw.split("\n");
      let count = 0;
      for (const line of lines) {
        if (line.trim()) count += 1;
      }
      fs.writeFileSync(p, "", "utf-8");
      return serveJson(res, { ok: true, deleted: count });
    }
    if (req.method === "POST") {
      return readRequestBody(req, raw => {
        let payload = null;
        try {
          payload = JSON.parse(raw || "{}");
        } catch {
          payload = null;
        }
        if (!payload || !payload.agent || !payload.message) {
          res.writeHead(400, { "Content-Type": "text/plain" });
          res.end("Invalid payload");
          return;
        }
        const entry = appendChatMessage(channel, payload.agent, payload.message);
        const participants = parseParticipants(channel);
        const sender = payload.agent;
        const recipients = participants.filter(p => p && p !== sender);
        if (sender !== "product-owner") {
          chatLastResponse.set(sender, { ts: entry.ts });
        }
        if (sender === "product-owner") {
          recipients.forEach(agentId => {
            chatLastMessage.set(agentId, { ts: entry.ts, from: sender });
          });
        }
        recipients.forEach(agentId => {
          const key = `${agentId}::${channel}`;
          chatSessionState.set(key, Date.now());
          startChatSession(agentId, channel, sender, payload.message);
        });
        if (sender === "product-owner" && isEndPhrase(payload.message)) {
          recipients.forEach(agentId => {
            const key = `${agentId}::${channel}`;
            chatSessionState.delete(key);
            stopChatSession(agentId, channel);
          });
        }
        return serveJson(res, { ok: true });
      });
    }
    res.writeHead(405, { "Content-Type": "text/plain" });
    res.end("Method not allowed");
    return;
  }

  if (parsed.pathname === "/api/agents/nudge" && req.method === "POST") {
    return readRequestBody(req, raw => {
      let payload = null;
      try {
        payload = JSON.parse(raw || "{}");
      } catch {
        payload = null;
      }
      if (!payload || !payload.agent) {
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end("Invalid payload");
        return;
      }
      const agentId = String(payload.agent);
      const msg = String(payload.message || "Quick check-in: please respond when you can.");
      startChatSession(agentId, `product-owner__${agentId}`, "product-owner", msg);
      return serveJson(res, { ok: true });
    });
  }

  if (parsed.pathname && parsed.pathname.startsWith("/assets/")) {
    const rel = decodeURIComponent(parsed.pathname.replace(/^\/+/, ""));
    if (serveAsset(res, rel)) return;
    console.log(`[monitor] asset not found: ${rel}`);
  }

  if (parsed.pathname === "/" || parsed.pathname === "/index.html") {
    return serveIndex(res);
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not found");
}

const server = http.createServer(handler);
const port = process.env.PORT ? Number(process.env.PORT) : 4317;
server.listen(port, () => {
  console.log(`[monitor] listening on http://localhost:${port}`);
});

setInterval(() => {
  const now = Date.now();
  for (const [key, lastTs] of chatSessionState.entries()) {
    if (now - lastTs < chatTimeoutMs) continue;
    const [agentId, channel] = key.split("::");
    stopChatSession(agentId, channel);
    chatSessionState.delete(key);
  }
}, 60 * 1000);

setInterval(() => {
  const now = Date.now();
  for (const [agentId, lastMsg] of chatLastMessage.entries()) {
    if (!lastMsg?.ts) continue;
    const lastResponse = chatLastResponse.get(agentId)?.ts || "";
    const msgTs = Date.parse(lastMsg.ts) || 0;
    const respTs = Date.parse(lastResponse) || 0;
    if (msgTs <= respTs) continue;
    if (now - msgTs < chatSlaMs) continue;
    startChatSession(agentId, `product-owner__${agentId}`, "product-owner", "Quick check-in: please respond when you can.");
    chatLastMessage.set(agentId, { ts: new Date().toISOString(), from: "product-owner" });
  }
}, 30 * 1000);
