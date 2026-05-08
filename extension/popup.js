function sendMessage(payload) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(payload, (response) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }
      resolve(response || { ok: false, error: "No response." });
    });
  });
}

document.addEventListener("DOMContentLoaded", async () => {
  const statusEl = document.getElementById("status");
  const status = await sendMessage({ type: "CB_GET_STATUS" });
  if (status.ok && status.connected) {
    statusEl.textContent = `Connected${status.email ? " as " + status.email : ""}. Saves go to ${status.target}.`;
    statusEl.dataset.tone = "success";
  } else {
    statusEl.textContent = "Not connected. Open options and sign in with your CareerBoost account.";
    statusEl.dataset.tone = "";
  }
  document.getElementById("options").addEventListener("click", () => {
    chrome.runtime.openOptionsPage();
  });
});
