const express = require("express");
const cors = require("cors");
const axios = require("axios");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

const NIM_API_BASE = "https://integrate.api.nvidia.com/v1";
const NIM_API_KEY = process.env.NIM_API_KEY;

// --- CONFIGURATION ---
const SHOW_REASONING = true;       
const ENABLE_THINKING_MODE = true;  

const MODEL_MAPPING = {
  "gpt-4": "meta/llama-3.3-70b-instruct",
  "gpt-4-turbo": "meta/llama-3.3-70b-instruct",
  "gpt-4o": "deepseek-ai/deepseek-v3.2",
  "claude-3.5-sonnet": "deepseek-ai/deepseek-v3.2",
  "gpt-3.5-turbo": "meta/llama-3.3-70b-instruct",
  "claude-3-sonnet": "meta/llama-3.3-70b-instruct",
  "o1-preview": "deepseek-ai/deepseek-r1",
  "o1-mini": "meta/llama-3.3-70b-instruct",
  "gemini-pro": "meta/llama-3.3-70b-instruct",
  "gpt-4o-mini": "meta/llama-3.3-70b-instruct",
};

const FALLBACK_MODELS = {
  large: "deepseek-ai/deepseek-v3.2",
  medium: "meta/llama-3.3-70b-instruct",
  small: "meta/llama-3.1-8b-instruct",
};

// --- LOGGING SYSTEM ---
// NOTE: In Vercel, logs are stored per-function execution (not persistent)
// For persistent logs, you'd need an external DB (Supabase, MongoDB, etc.)
const logs = [];
const MAX_LOGS = 100; // Reduced for serverless
const clients = [];

function addLog(level, category, message, metadata = {}) {
  const logEntry = {
    id: Date.now() + Math.random(),
    timestamp: new Date().toISOString(),
    level,
    category,
    message,
    metadata,
  };
  
  logs.unshift(logEntry);
  if (logs.length > MAX_LOGS) logs.pop();
  
  const emoji = {
    info: "ℹ️",
    success: "✅",
    warning: "⚠️",
    error: "❌",
    debug: "🔍"
  }[level] || "📝";
  
  console.log(`${emoji} [${category.toUpperCase()}] ${message}`, metadata);
  
  // Broadcast to connected clients (limited in serverless)
  clients.forEach(client => {
    try {
      client.write(`data: ${JSON.stringify(logEntry)}\n\n`);
    } catch (e) {
      // Client disconnected
    }
  });
}

// Middleware
app.use(cors({ 
  origin: "*", 
  methods: ["GET", "POST", "OPTIONS"], 
  allowedHeaders: ["Content-Type", "Authorization"] 
}));
app.use(express.json({ limit: "50mb" }));
app.use(express.static(path.join(__dirname, "public")));

// Serve dashboard
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// API: Get logs
app.get("/api/logs", (req, res) => {
  const { level, category, limit = 100 } = req.query;
  let filteredLogs = logs;
  
  if (level) filteredLogs = filteredLogs.filter(log => log.level === level);
  if (category) filteredLogs = filteredLogs.filter(log => log.category === category);
  
  res.json(filteredLogs.slice(0, parseInt(limit)));
});

// API: Real-time log stream (SSE)
// WARNING: SSE has limitations on Vercel (10s timeout for hobby plan)
app.get("/api/logs/stream", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  
  // Send initial heartbeat
  res.write(`: heartbeat\n\n`);
  
  clients.push(res);
  addLog("info", "system", "New client connected to log stream");
  
  // Heartbeat to keep connection alive (within Vercel limits)
  const heartbeat = setInterval(() => {
    try {
      res.write(`: heartbeat\n\n`);
    } catch (e) {
      clearInterval(heartbeat);
    }
  }, 15000);
  
  req.on("close", () => {
    clearInterval(heartbeat);
    const index = clients.indexOf(res);
    if (index !== -1) clients.splice(index, 1);
    addLog("info", "system", "Client disconnected from log stream");
  });
});

// API: Clear logs
app.post("/api/logs/clear", (req, res) => {
  const count = logs.length;
  logs.length = 0;
  addLog("warning", "system", `Cleared ${count} log entries`);
  res.json({ success: true, cleared: count });
});

// API: Get stats
app.get("/api/stats", (req, res) => {
  res.json({
    totalLogs: logs.length,
    errors: logs.filter(l => l.level === 'error').length,
    requests: logs.filter(l => l.category === 'request').length,
    successes: logs.filter(l => l.level === 'success').length,
    config: {
      showReasoning: SHOW_REASONING,
      thinkingMode: ENABLE_THINKING_MODE,
      modelMappings: Object.keys(MODEL_MAPPING).length
    }
  });
});

async function selectModel(requestedModel) {
  const selected = MODEL_MAPPING[requestedModel] || FALLBACK_MODELS.large;
  addLog("info", "model", `Model selection: ${requestedModel} → ${selected}`, {
    requested: requestedModel,
    mapped: selected,
    isFallback: !MODEL_MAPPING[requestedModel]
  });
  return selected;
}

function formatResponseContent(message, showReasoning) {
  let fullContent = message.content || "";
  const reasoning = message.reasoning_content || message.reasoning;
  
  if (showReasoning && reasoning) {
    fullContent = `<think>\n${reasoning}\n</think>\n\n${fullContent}`;
    addLog("debug", "formatting", "Added reasoning tags to response", {
      reasoningLength: reasoning.length,
      contentLength: fullContent.length
    });
  }
  
  return fullContent;
}

app.post("/v1/chat/completions", async (req, res) => {
  const requestStart = Date.now();
  const requestId = `req_${requestStart}_${Math.random().toString(36).substr(2, 9)}`;
  
  try {
    addLog("info", "request", "New chat completion request", {
      requestId,
      model: req.body.model,
      messageCount: req.body.messages?.length,
      stream: req.body.stream,
      temperature: req.body.temperature
    });

    if (!NIM_API_KEY) {
      addLog("error", "config", "NIM_API_KEY is missing");
      return res.status(500).json({ error: "NIM_API_KEY missing" });
    }

    const { model, messages, temperature = 0.6, max_tokens, stream = false } = req.body;
    const nimModel = await selectModel(model);

    const isDeepSeek = nimModel.includes("deepseek");
    const safeMaxTokens = isDeepSeek ? Math.max(max_tokens || 0, 16384) : (max_tokens || 4096);

    addLog("info", "config", "Request configuration", {
      requestId,
      nimModel,
      isDeepSeek,
      thinkingMode: ENABLE_THINKING_MODE && isDeepSeek,
      maxTokens: safeMaxTokens,
      originalMaxTokens: max_tokens
    });

    const nimRequest = {
      model: nimModel,
      messages: messages,
      temperature: temperature,
      max_tokens: safeMaxTokens,
      stream: stream,
    };

    if (ENABLE_THINKING_MODE && isDeepSeek) {
      nimRequest.extra_body = {
        chat_template_kwargs: { thinking: true }
      };
      addLog("info", "feature", "Thinking mode enabled for DeepSeek", { requestId });
    }

    addLog("info", "api", "Sending request to NVIDIA NIM", {
      requestId,
      endpoint: `${NIM_API_BASE}/chat/completions`,
      model: nimModel
    });

    const response = await axios.post(`${NIM_API_BASE}/chat/completions`, nimRequest, {
      headers: { 
        Authorization: `Bearer ${NIM_API_KEY}`, 
        "Content-Type": "application/json" 
      },
      responseType: stream ? "stream" : "json",
      timeout: 300000,
    });

    const responseTime = Date.now() - requestStart;

    if (stream) {
      addLog("info", "response", "Streaming response started", { requestId, responseTime });
      handleStreaming(response, res, model, requestId);
    } else {
      const openaiResponse = {
        id: `chatcmpl-${Date.now()}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: model,
        choices: response.data.choices.map((choice) => ({
          index: choice.index,
          message: {
            role: choice.message.role,
            content: formatResponseContent(choice.message, SHOW_REASONING),
          },
          finish_reason: choice.finish_reason,
        })),
        usage: response.data.usage,
      };
      
      addLog("success", "response", "Non-streaming response completed", {
        requestId,
        responseTime,
        usage: response.data.usage,
        finishReason: response.data.choices[0]?.finish_reason
      });
      
      res.json(openaiResponse);
    }
  } catch (error) {
    const responseTime = Date.now() - requestStart;
    addLog("error", "api", "Request failed", {
      requestId,
      responseTime,
      error: error.message,
      status: error.response?.status,
      details: error.response?.data
    });
    
    console.error("NIM Error Details:", error.response?.data || error.message);
    res.status(500).json({ error: error.message, details: error.response?.data });
  }
});

function handleStreaming(response, res, originalModelName, requestId) {
  res.setHeader("Content-Type", "text/event-stream");
  let reasoningStarted = false;
  let chunkCount = 0;
  let totalBytes = 0;

  response.data.on("data", (chunk) => {
    chunkCount++;
    totalBytes += chunk.length;
    
    const lines = chunk.toString().split("\n");
    lines.forEach((line) => {
      if (!line.startsWith("data: ") || line.includes("[DONE]")) {
        if (line.includes("[DONE]")) {
          addLog("success", "streaming", "Stream completed", {
            requestId,
            chunks: chunkCount,
            totalBytes
          });
          res.write(line + "\n\n");
        }
        return;
      }

      try {
        const data = JSON.parse(line.slice(6));
        const delta = data.choices?.[0]?.delta;
        if (!delta) return;

        let combinedContent = "";
        const reasoning = delta.reasoning_content || delta.reasoning;
        const content = delta.content;

        if (SHOW_REASONING) {
          if (reasoning) {
            if (!reasoningStarted) {
              combinedContent = "<think>\n" + reasoning;
              reasoningStarted = true;
              addLog("debug", "streaming", "Reasoning block started", { requestId });
            } else {
              combinedContent = reasoning;
            }
          } else if (content) {
            if (reasoningStarted) {
              combinedContent = "\n</think>\n\n" + content;
              reasoningStarted = false;
              addLog("debug", "streaming", "Reasoning block ended", { requestId });
            } else {
              combinedContent = content;
            }
          }
        } else {
          combinedContent = content || "";
        }

        if (combinedContent) {
          data.choices[0].delta.content = combinedContent;
          delete data.choices[0].delta.reasoning_content;
          data.model = originalModelName;
          res.write(`data: ${JSON.stringify(data)}\n\n`);
        }
      } catch (e) {
        addLog("warning", "streaming", "Failed to parse stream chunk", {
          requestId,
          error: e.message
        });
      }
    });
  });

  response.data.on("end", () => res.end());
  response.data.on("error", (error) => {
    addLog("error", "streaming", "Stream error", {
      requestId,
      error: error.message
    });
  });
}

// Export for Vercel
module.exports = app;

// For local development
if (require.main === module) {
  addLog("success", "system", `Proxy server starting on port ${PORT}`);
  app.listen(PORT, () => {
    addLog("success", "system", `🚀 Server active on port ${PORT}`);
    addLog("info", "system", `Dashboard available at http://localhost:${PORT}`);
    addLog("info", "config", "Configuration loaded", {
      showReasoning: SHOW_REASONING,
      thinkingMode: ENABLE_THINKING_MODE,
      modelMappings: Object.keys(MODEL_MAPPING).length
    });
  });
}
