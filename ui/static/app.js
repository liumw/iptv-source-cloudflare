document.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-copy]");
  if (!button) return;
  const text = button.getAttribute("data-copy");
  if (!text) return;
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
    } else {
      // Clipboard API is unavailable on plain HTTP LAN addresses.
      const field = document.createElement("textarea");
      field.value = text;
      field.style.cssText = "position:fixed;left:-9999px;top:0";
      document.body.append(field);
      field.select();
      const copied = document.execCommand("copy");
      field.remove();
      button.focus();
      if (!copied) throw new Error("clipboard unavailable");
    }
    const old = button.textContent;
    button.textContent = "已复制";
    setTimeout(() => { button.textContent = old; }, 1200);
    showToast("地址已复制");
  } catch (err) {
    showToast("复制失败，请选中地址后手动复制");
  }
});

document.addEventListener("submit", (event) => {
  const form = event.target;
  const confirmText =
    (event.submitter && event.submitter.getAttribute("data-confirm")) ||
    form.getAttribute("data-confirm");
  if (confirmText && !window.confirm(confirmText)) {
    event.preventDefault();
  }
});

document.addEventListener("change", (event) => {
  const select = event.target.closest("[data-autosubmit]");
  if (select) select.form.submit();
  const channelBox = event.target.closest('#channel-list input[name="channel_ids"]');
  if (channelBox) updateChannelCount(channelBox.closest(".modal"));

  const checkAll = event.target.closest("[data-check-all]");
  if (checkAll) {
    document.querySelectorAll('input.channel-select[form="channel-batch-form"]').forEach((box) => {
      box.checked = checkAll.checked;
    });
    updateBulkSelection();
  } else if (event.target.closest(".channel-select")) {
    updateBulkSelection();
  }

  if (event.target.id === "play-stream") {
    const channel = playChannels[currentPlayIndex];
    if (channel) playStream(channel, Number(event.target.value));
  }
});

document.addEventListener("input", (event) => {
  if (event.target.id !== "channel-search") return;
  const modal = event.target.closest(".modal");
  if (!modal) return;
  const query = event.target.value.trim().toLowerCase();
  modal.querySelectorAll(".channel-option").forEach((row) => {
    row.hidden = Boolean(query) && !row.dataset.search.includes(query);
  });
});

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  document.querySelectorAll(".modal:not([hidden])").forEach(closeModal);
});

document.addEventListener("click", async (event) => {
  const opener = event.target.closest("[data-modal-open]");
  if (opener) {
    const modal = document.getElementById(opener.getAttribute("data-modal-open"));
    if (modal) {
      openModal(modal);
      if (modal.id === "channel-modal") await loadChannelOptions(modal);
    }
    return;
  }

  const closer = event.target.closest("[data-modal-close]");
  if (closer) {
    closeModal(closer.closest(".modal"));
    return;
  }

  const channelButton = event.target.closest(".play-channel");
  if (channelButton) {
    openPlayChannel(Number(channelButton.dataset.channelIndex));
  }
});

function openModal(modal) {
  if (!modal) return;
  modal.hidden = false;
  modal._opener = document.activeElement;
  const box = modal.querySelector(".modal-box");
  if (box) {
    box.setAttribute("role", "dialog");
    box.setAttribute("aria-modal", "true");
    const title = box.querySelector("h2, h3");
    if (title) {
      title.id = title.id || `${modal.id}-title`;
      box.setAttribute("aria-labelledby", title.id);
    }
  }
  document.body.classList.add("modal-open");
  const search = modal.querySelector("#channel-search");
  if (search) {
    setTimeout(() => search.focus(), 30);
  }
}

function closeModal(modal) {
  if (!modal) return;
  modal.hidden = true;
  if (modal._opener && modal._opener.isConnected) modal._opener.focus();
  if (!document.querySelector(".modal:not([hidden])")) {
    document.body.classList.remove("modal-open");
  }
}

async function loadChannelOptions(modal) {
  const list = modal.querySelector("#channel-list");
  const count = modal.querySelector("#channel-count");
  if (!list) return;
  list.innerHTML = '<p class="muted small">加载中…</p>';
  if (count) count.textContent = "";
  modal.querySelectorAll(".channel-option").forEach((row) => row.remove());

  let data;
  try {
    const response = await fetch(modal.dataset.optionsUrl, {
      headers: { Accept: "application/json" },
      credentials: "same-origin",
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    data = await response.json();
  } catch (err) {
    list.innerHTML = "";
    const note = document.createElement("p");
    note.className = "muted small";
    note.textContent = "加载频道失败，请刷新页面后重试。";
    list.append(note);
    return;
  }

  if (data.error) {
    list.innerHTML = "";
    const note = document.createElement("p");
    note.className = "muted small";
    note.textContent = data.error;
    list.append(note);
    return;
  }

  const selected = new Set((data.selected || []).map(String));
  list.innerHTML = "";
  if (!data.channels || !data.channels.length) {
    const note = document.createElement("p");
    note.className = "muted small";
    note.textContent = "还没有已确认的频道。请先到「待确认」页确认频道，再回来选择。";
    list.append(note);
    if (count) count.textContent = "已选 0 / 共 0";
    return;
  }

  data.channels.forEach((channel) => {
    const label = document.createElement("label");
    label.className = "channel-option";
    label.dataset.search = `${channel.name} ${channel.key} ${channel.group}`.toLowerCase();

    const box = document.createElement("input");
    box.type = "checkbox";
    box.name = "channel_ids";
    box.value = String(channel.id);
    box.checked = selected.has(String(channel.id));

    const name = document.createElement("span");
    name.className = "channel-name";
    name.textContent = channel.name;

    const meta = document.createElement("span");
    meta.className = "channel-meta";
    meta.textContent = `${channel.group} · ${channel.key}`;

    label.append(box, name);
    if (channel.adult) {
      const badge = document.createElement("span");
      badge.className = "badge bad";
      badge.textContent = "成人";
      label.append(badge);
    }
    label.append(meta);
    list.append(label);
  });

  const search = modal.querySelector("#channel-search");
  if (search) search.value = "";
  updateChannelCount(modal);
}

function updateChannelCount(modal) {
  if (!modal) return;
  const count = modal.querySelector("#channel-count");
  if (!count) return;
  const boxes = modal.querySelectorAll('#channel-list input[name="channel_ids"]');
  const checked = Array.from(boxes).filter((box) => box.checked).length;
  count.textContent = `已选 ${checked} / 共 ${boxes.length}`;
}

function updateBulkSelection() {
  const form = document.getElementById("channel-batch-form");
  if (!form) return;
  const boxes = Array.from(
    document.querySelectorAll('input.channel-select[form="channel-batch-form"]')
  );
  const selected = boxes.filter((box) => box.checked);
  const count = form.querySelector("[data-bulk-count]");
  if (count) count.textContent = String(selected.length);
  boxes.forEach((box) => {
    const row = box.closest("tr");
    if (row) row.classList.toggle("selected", box.checked);
  });
  const checkAll = document.querySelector("[data-check-all]");
  if (checkAll) {
    checkAll.checked = boxes.length > 0 && selected.length === boxes.length;
    checkAll.indeterminate = selected.length > 0 && selected.length < boxes.length;
  }
  form.querySelectorAll("[data-bulk-action]").forEach((button) => {
    button.disabled = selected.length === 0;
  });
}

if (document.getElementById("channel-batch-form")) updateBulkSelection();

let playChannels = [];
let currentPlayIndex = -1;
let hlsPlayer = null;

const playDataElement = document.getElementById("play-data");
if (playDataElement) {
  try {
    playChannels = JSON.parse(playDataElement.textContent || "[]");
  } catch (err) {
    playChannels = [];
  }
}

function openPlayChannel(index) {
  const channel = playChannels[index];
  if (!channel) return;
  currentPlayIndex = index;

  const title = document.getElementById("play-title");
  const subtitle = document.getElementById("play-subtitle");
  const badge = document.getElementById("play-badge");
  const select = document.getElementById("play-stream");
  const idle = document.getElementById("play-idle");
  const copy = document.getElementById("play-copy");
  const external = document.getElementById("play-external");

  if (title) title.textContent = channel.name;
  const logoBox = document.getElementById("play-current-logo");
  const logoImage = document.getElementById("play-current-logo-image");
  if (logoBox && logoImage) {
    logoBox.hidden = false;
    logoBox.classList.remove("logo-ready");
    logoImage.hidden = !channel.logo;
    if (channel.logo) {
      logoImage.src = channel.logo;
      if (logoImage.complete && logoImage.naturalWidth > 0) logoBox.classList.add("logo-ready");
    } else {
      logoImage.removeAttribute("src");
    }
  }
  if (subtitle) {
    subtitle.textContent = `频道分组：${channel.group} · ${channel.streams.length} 条线路`;
  }
  if (badge) {
    badge.querySelector('.channel-number-value').textContent = channel.chno != null ? String(channel.chno) : "—";
    badge.setAttribute("aria-label", channel.chno != null ? `台号 ${channel.chno}` : "未设置台号");
    badge.hidden = false;
  }
  if (idle) idle.hidden = true;
  if (copy) copy.disabled = false;
  if (external) external.hidden = false;

  if (select) {
    select.innerHTML = "";
    select.disabled = false;
    channel.streams.forEach((stream, streamIndex) => {
      const option = document.createElement("option");
      option.value = String(streamIndex);
      const parts = [`线路 ${streamIndex + 1}`];
      if (stream.network) parts.push(stream.network);
      if (stream.carrier) parts.push(stream.carrier);
      if (stream.is_default) parts.push("默认");
      option.textContent = parts.join(" · ");
      select.append(option);
    });
  }

  document.querySelectorAll(".play-channel").forEach((item) => {
    item.classList.toggle("active", Number(item.dataset.channelIndex) === index);
  });
  const active = document.querySelector(`.play-channel[data-channel-index="${index}"]`);
  if (active) active.scrollIntoView({ block: "nearest", behavior: "smooth" });

  playStream(channel, 0);
}

function playStream(channel, streamIndex) {
  const video = document.getElementById("play-video");
  const message = document.getElementById("play-message");
  const copy = document.getElementById("play-copy");
  const external = document.getElementById("play-external");
  const select = document.getElementById("play-stream");
  if (!video) return;

  resetPlayer();
  if (select) select.value = String(streamIndex);
  const stream = channel.streams[streamIndex];
  if (!stream || !stream.url) {
    setPlayerMessage(message, "这个频道没有可用线路。");
    if (copy) copy.disabled = true;
    if (external) {
      external.hidden = true;
      external.removeAttribute("href");
    }
    return;
  }

  if (copy) {
    copy.disabled = false;
    copy.setAttribute("data-copy", stream.url);
  }
  if (external) {
    external.hidden = false;
    external.href = stream.url;
  }

  const url = stream.url;
  const isHttp = /^https?:\/\//i.test(url);
  const isHls = /\.m3u8(?:[?#]|$)/i.test(url) || /[?&](?:type|format)=m3u8/i.test(url);

  if (!isHttp) {
    setPlayerMessage(
      message,
      "该线路不是 HTTP(S) 协议，浏览器无法直接播放。请复制地址，用 VLC / PotPlayer 等外部播放器打开。"
    );
    return;
  }

  if (isHls) {
    const proxyUrl = playDataElement?.dataset.proxyEnabled === "0" ? url : `/_admin/play/proxy?url=${encodeURIComponent(url)}`;
    if (window.Hls && window.Hls.isSupported()) {
      hlsPlayer = new window.Hls({ enableWorker: true, lowLatencyMode: false });
      hlsPlayer.loadSource(proxyUrl);
      hlsPlayer.attachMedia(video);
      hlsPlayer.on(window.Hls.Events.MANIFEST_PARSED, () => {
        video.play().catch(() => {});
      });
      hlsPlayer.on(window.Hls.Events.ERROR, (_event, data) => {
        if (!data || !data.fatal) return;
        setPlayerMessage(
          message,
          "HLS 播放失败，可能是源站限制或线路失效。可以换一条线路，或复制地址用 VLC / PotPlayer 播放。"
        );
      });
      setPlayerMessage(message, playDataElement?.dataset.proxyEnabled === "0" ? "正在直连源站加载 HLS；如被跨域限制，可复制地址到外部播放器。" : "正在通过云端代理加载 HLS 线路…");
      return;
    }
    if (video.canPlayType("application/vnd.apple.mpegurl")) {
      video.src = proxyUrl;
      video.play().catch(() => {});
      setPlayerMessage(message, playDataElement?.dataset.proxyEnabled === "0" ? "使用浏览器原生 HLS 直连播放。" : "使用浏览器原生 HLS + 云端代理播放。");
      return;
    }
    setPlayerMessage(
      message,
      "当前浏览器不支持 HLS。请复制线路地址，用 VLC / PotPlayer 播放。"
    );
    return;
  }

  video.src = url;
  video.play().catch(() => {});
  setPlayerMessage(message, "已载入线路；如果无法播放，请复制地址用外部播放器打开。");
}

function setPlayerMessage(element, text) {
  if (element) element.textContent = text || "";
}

function resetPlayer() {
  if (hlsPlayer) {
    try {
      hlsPlayer.destroy();
    } catch (err) {
      /* ignore */
    }
    hlsPlayer = null;
  }
  const video = document.getElementById("play-video");
  if (video) {
    video.pause();
    video.removeAttribute("src");
    video.load();
  }
}


let toastTimer;
function updateChannelLogo(image) {
  if (!(image instanceof HTMLImageElement) || !image.hasAttribute("data-channel-logo")) return;
  const loaded = image.complete && image.naturalWidth > 0;
  image.closest(".channel-logo")?.classList.toggle("logo-ready", loaded);
  if (image.complete && !loaded) image.hidden = true;
}
document.addEventListener("load", event => updateChannelLogo(event.target), true);
document.addEventListener("error", event => updateChannelLogo(event.target), true);
document.querySelectorAll("img[data-channel-logo]").forEach(updateChannelLogo);

function showToast(message) {
  const toast = document.getElementById("toast");
  if (!toast) return;
  clearTimeout(toastTimer);
  toast.textContent = message;
  toast.hidden = false;
  toastTimer = setTimeout(() => { toast.hidden = true; }, 3000);
}

function setNavigation(open, moveFocus = true) {
  document.body.classList.toggle("nav-open", open);
  const backdrop = document.querySelector("[data-nav-close]");
  const toggle = document.querySelector("[data-nav-toggle]");
  const sidebar = document.querySelector(".sidebar");
  const mobile = window.matchMedia("(max-width: 900px)").matches;
  if (sidebar) sidebar.inert = mobile && !open;
  if (backdrop) backdrop.hidden = !open;
  if (toggle) {
    toggle.setAttribute("aria-expanded", String(open));
    toggle.setAttribute("aria-label", open ? "关闭导航" : "打开导航");
  }
  if (moveFocus && open) document.querySelector('.sidebar a[aria-current="page"]')?.focus();
  else if (moveFocus && toggle && mobile) toggle.focus();
}
document.addEventListener("click", (event) => {
  if (event.target.closest("[data-search-focus]")) document.querySelector('.global-search input')?.focus();
  if (event.target.closest("[data-nav-toggle]")) setNavigation(!document.body.classList.contains("nav-open"));
  if (event.target.closest("[data-nav-close]")) setNavigation(false);
});
window.matchMedia("(max-width: 900px)").addEventListener("change", () => setNavigation(false, false));
setNavigation(false, false);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && document.body.classList.contains("nav-open")) setNavigation(false);
  if (event.key === "/" && !event.ctrlKey && !event.metaKey && !event.altKey && !event.target.closest("input, textarea, select, [contenteditable]")) {
    const search = document.querySelector('.global-search input');
    if (search) { event.preventDefault(); search.focus(); }
  }
  if (event.key !== "Tab") return;
  const scope = document.querySelector('.modal:not([hidden]) .modal-box') ||
    (document.body.classList.contains("nav-open") ? document.querySelector(".sidebar") : null);
  if (!scope) return;
  const items = Array.from(scope.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex="0"]')).filter(el => !el.hidden && el.getClientRects().length);
  if (!items.length) return;
  if (event.shiftKey && document.activeElement === items[0]) { event.preventDefault(); items.at(-1).focus(); }
  else if (!event.shiftKey && document.activeElement === items.at(-1)) { event.preventDefault(); items[0].focus(); }
});

// Keep wide tables scrollable without widening the whole page.
document.querySelectorAll("table").forEach(table => {
  if (table.parentElement.classList.contains("table-scroll")) return;
  const wrapper = document.createElement("div");
  wrapper.className = "table-scroll";
  table.before(wrapper);
  wrapper.append(table);
});

document.getElementById("play-search")?.addEventListener("input", (event) => {
  const query = event.target.value.trim().toLowerCase();
  let visible = 0;
  document.querySelectorAll(".play-channel").forEach(button => {
    button.hidden = !button.dataset.search.toLowerCase().includes(query);
    if (!button.hidden) visible++;
  });
  const empty = document.getElementById("play-search-empty");
  if (empty) empty.hidden = visible > 0;
});

// Show the relevant source input while retaining saved values.
document.querySelectorAll('select[name="origin"]').forEach(select => {
  function update() {
    const fields = { playlist_file: "upload", url: "url", inline_text: "inline" };
    Object.entries(fields).forEach(([name, origin]) => {
      const field = select.form.querySelector(`[name="${name}"]`);
      const label = field?.closest("label");
      if (label) label.hidden = select.value !== origin;
    });
  }
  select.addEventListener("change", update);
  update();
});
