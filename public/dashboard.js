let logs = [];
let autoScroll = true;
const logContainer = document.getElementById("logContainer");

// Connect to SSE stream for real-time logs
const eventSource = new EventSource("/api/logs/stream");

eventSource.onmessage = (event) => {
  const log = JSON.parse(event.data);
  logs.unshift(log);
  updateStats();

  if (shouldDisplayLog(log)) {
    renderLog(log, true);
    removePlaceholder();
  }
};

eventSource.onerror = (error) => {
  console.error("SSE connection error:", error);
  setTimeout(() => {
    console.log("Attempting to reconnect...");
    location.reload();
  }, 5000);
};

// Load initial logs
fetch("/api/logs?limit=50")
  .then((r) => r.json())
  .then((data) => {
    logs = data;
    updateStats();
    if (logs.length > 0) {
      removePlaceholder();
      renderLogs();
    }
  })
  .catch((err) => console.error("Failed to load initial logs:", err));

function shouldDisplayLog(log) {
  const levelFilter = document.getElementById("levelFilter").value;
  const categoryFilter = document.getElementById("categoryFilter").value;

  if (levelFilter && log.level !== levelFilter) return false;
  if (categoryFilter && log.category !== categoryFilter) return false;
  return true;
}

function renderLogs() {
  const placeholder = logContainer.querySelector(".log-placeholder");
  if (placeholder) {
    logContainer.innerHTML = "";
  }

  logs.filter(shouldDisplayLog).forEach((log) => renderLog(log, false));
}

function renderLog(log, prepend) {
  const entry = document.createElement("div");
  entry.className = `log-entry ${log.level}`;

  const hasMetadata = Object.keys(log.metadata).length > 0;
  const metadataId = `meta-${log.id}`;

  entry.innerHTML = `
    <div class="log-header">
      <div class="log-badges">
        <span class="log-badge ${log.level}">${log.level}</span>
        <span class="log-category">${log.category}</span>
      </div>
      <span class="log-time">${formatTime(log.timestamp)}</span>
    </div>
    <div class="log-message">${escapeHtml(log.message)}</div>
    ${
      hasMetadata
        ? `
      <span class="toggle-metadata" onclick="toggleMetadata('${metadataId}')">
        Show metadata ▼
      </span>
      <div class="log-metadata" id="${metadataId}" style="display: none;">
${JSON.stringify(log.metadata, null, 2)}
      </div>
    `
        : ""
    }
  `;

  if (prepend) {
    const placeholder = logContainer.querySelector(".log-placeholder");
    if (placeholder) {
      logContainer.removeChild(placeholder);
    }
    logContainer.insertBefore(entry, logContainer.firstChild);
  } else {
    logContainer.appendChild(entry);
  }

  if (autoScroll && prepend) {
    logContainer.scrollTop = 0;
  }
}

function removePlaceholder() {
  const placeholder = logContainer.querySelector(".log-placeholder");
  if (placeholder) {
    placeholder.remove();
  }
}

function toggleMetadata(id) {
  const element = document.getElementById(id);
  const toggle = element.previousElementSibling;

  if (element.style.display === "none") {
    element.style.display = "block";
    toggle.textContent = "Hide metadata ▲";
  } else {
    element.style.display = "none";
    toggle.textContent = "Show metadata ▼";
  }
}

function updateStats() {
  document.getElementById("totalLogs").textContent = logs.length;
  document.getElementById("errorCount").textContent = logs.filter(
    (l) => l.level === "error"
  ).length;
  document.getElementById("requestCount").textContent = logs.filter(
    (l) => l.category === "request"
  ).length;
  document.getElementById("successCount").textContent = logs.filter(
    (l) => l.level === "success"
  ).length;
}

function clearLogs() {
  if (
    confirm("Clear all logs? This will remove all log entries from the server.")
  ) {
    fetch("/api/logs/clear", { method: "POST" })
      .then(() => {
        logs = [];
        logContainer.innerHTML = `
          <div class="log-placeholder">
            <div class="placeholder-icon">📊</div>
            <p>Logs cleared</p>
            <p class="placeholder-hint">New logs will appear here as requests are processed</p>
          </div>
        `;
        updateStats();
      })
      .catch((err) => {
        console.error("Failed to clear logs:", err);
        alert("Failed to clear logs. Check console for details.");
      });
  }
}

function toggleAutoScroll() {
  autoScroll = !autoScroll;
  document.getElementById("autoScrollStatus").textContent = autoScroll
    ? "ON"
    : "OFF";
}

function exportLogs() {
  const dataStr = JSON.stringify(logs, null, 2);
  const dataBlob = new Blob([dataStr], { type: "application/json" });
  const url = URL.createObjectURL(dataBlob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `proxy-logs-${new Date().toISOString()}.json`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

function formatTime(timestamp) {
  const date = new Date(timestamp);
  return date.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });
}

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

// Event listeners for filters
document.getElementById("levelFilter").addEventListener("change", () => {
  renderLogs();
});

document.getElementById("categoryFilter").addEventListener("change", () => {
  renderLogs();
});

// Log connection status
console.log("🚀 Dashboard initialized. Connecting to log stream...");
