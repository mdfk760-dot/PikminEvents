const API_URL = "https://script.google.com/macros/s/AKfycby6rxbH_2xObY8yeCMD3bzspAqwMEIrHhWRfA5OrGHdLx55DPeUKTENqd7DkoAEjn7p/exec";

    const EVENT_INTERVAL_LABELS = {
      "1day": "每1天一次",
      "7days": "每7天一次",
      "30days": "每30天一次",
      "monthly1st": "每月1號刷新",
      "1month": "每月1號刷新",
      "once": "活動期間限一次"
    };

    const PUBLIC_CACHE_KEY = "pikminActivityPublicCacheV1";
    const CACHE_MAX_AGE = 7 * 24 * 60 * 60 * 1000;
    const DATA_VERSION_CHECK_INTERVAL = 30 * 1000;
    const FETCH_TIMEOUT = 15000;

    let events = [];
    let currentDataVersion = null;
    const ENDED_EVENTS_INITIAL_LIMIT = 10;
    let showAllEndedEvents = false;
    let toastTimer = null;
    let isLoading = false;
    let dataVersionTimer = null;
    let adminPassword = sessionStorage.getItem("pikminActivityAdminPassword") || "";
    let isAdmin = false;
    let editingEventId = null;

    const $ = id => document.getElementById(id);


    // 網站發布新版時，提醒仍開著舊頁面的使用者重新整理。
    const SITE_VERSION_CHECK_INTERVAL = 60 * 1000;
    const SITE_VERSION_URL = "./version.txt";
    
    let publishedSiteVersion = null;
    let siteVersionTimer = null;
    let siteVersionUpdateDetected = false;
    
    async function getPublishedSiteVersion() {
      const url = new URL(SITE_VERSION_URL, window.location.href);
      url.searchParams.set("_updateCheck", Date.now());
    
      const response = await fetch(url.toString(), {
        method: "GET",
        cache: "no-store"
      });
    
      if (!response.ok) throw new Error(`版本檢查 HTTP ${response.status}`);
    
      return (await response.text()).trim();
    }
    
    function showSiteUpdateBanner() {
      if (siteVersionUpdateDetected) return;
      siteVersionUpdateDetected = true;
      const banner = $("siteUpdateBanner");
      if (banner) banner.classList.add("active");
    }

    async function checkSiteVersion({ initialize = false } = {}) {
      if (siteVersionUpdateDetected) return;
      if (!initialize && document.visibilityState !== "visible") return;
    
      try {
        const siteVersion = await getPublishedSiteVersion();
    
        if (!siteVersion) return;
    
        if (!publishedSiteVersion || initialize) {
          publishedSiteVersion = siteVersion;
          return;
        }
    
        if (siteVersion === publishedSiteVersion) return;
    
        // 再確認一次，避免 GitHub Pages/CDN 更新中的短暫狀態誤報。
        await new Promise(resolve => setTimeout(resolve, 3000));
    
        if (document.visibilityState !== "visible" || siteVersionUpdateDetected) return;
    
        const confirmVersion = await getPublishedSiteVersion();
    
        if (
          confirmVersion === siteVersion &&
          confirmVersion !== publishedSiteVersion
        ) {
          showSiteUpdateBanner();
        }
      } catch (error) {
        console.debug("網站版本檢查失敗", error);
      }
    }

    function stopSiteVersionTimer() {
      if (siteVersionTimer !== null) {
        clearInterval(siteVersionTimer);
        siteVersionTimer = null;
      }
    }

    function startSiteVersionTimer() {
      stopSiteVersionTimer();
      if (document.visibilityState !== "visible" || siteVersionUpdateDetected) return;
      siteVersionTimer = setInterval(() => checkSiteVersion(), SITE_VERSION_CHECK_INTERVAL);
    }

    function showToast(message) {
      const toast = $("toast");
      toast.textContent = message;
      toast.classList.add("active");
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => toast.classList.remove("active"), 1600);
    }

    function escapeHtml(value) {
      return String(value || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
    }

    function escapeXml(value) {
      return String(value || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&apos;");
    }

    function sanitizeFileName(value) {
      return String(value || "活動座標")
        .replace(/[\\/:*?"<>|]/g, "_")
        .replace(/\s+/g, " ")
        .trim() || "活動座標";
    }

    function fetchWithTimeout(url, options = {}, timeoutMs = FETCH_TIMEOUT) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      return fetch(url, {
        ...options,
        cache: "no-store",
        signal: controller.signal
      }).finally(() => clearTimeout(timer));
    }

    function saveCache() {
      try {
        localStorage.setItem(PUBLIC_CACHE_KEY, JSON.stringify({
          savedAt: Date.now(),
          dataVersion: currentDataVersion,
          events
        }));
      } catch (error) {
        console.debug("保存活動快取失敗", error);
      }
    }

    function restoreCache() {
      try {
        const raw = localStorage.getItem(PUBLIC_CACHE_KEY);
        if (!raw) return false;
        const data = JSON.parse(raw);
        if (!data || !Array.isArray(data.events) || !Number.isFinite(Number(data.savedAt))) return false;
        if (Date.now() - Number(data.savedAt) > CACHE_MAX_AGE) return false;
        events = data.events;
        currentDataVersion = data.dataVersion != null ? String(data.dataVersion) : null;
        renderEvents();
        return true;
      } catch (error) {
        console.debug("讀取活動快取失敗", error);
        return false;
      }
    }

    async function loadEvents({ showLoading = false } = {}) {
      if (isLoading) return false;
      isLoading = true;
      if (showLoading) $("loadingMessage").style.display = "block";

      let loadedEvents = null;
      let loadedDataVersion = null;
      let lastError = null;

      try {
        // 主要來源：與開花公告共用的公開資料 API。
        try {
          const res = await fetchWithTimeout(`${API_URL}?action=list&ts=${Date.now()}`);
          if (!res.ok) throw new Error(`action=list HTTP ${res.status}`);

          const data = await res.json();
          if (!data.success) throw new Error(data.message || "action=list 讀取失敗");
          if (!Array.isArray(data.events)) throw new Error("action=list 未回傳 events");

          loadedEvents = data.events;
          loadedDataVersion = data.dataVersion != null ? String(data.dataVersion) : null;
        } catch (error) {
          lastError = error;
          console.warn("共用公開資料讀取失敗，改用 listEvents 備援", error);
        }

        // 備援來源：只讀活動資料。
        if (!Array.isArray(loadedEvents)) {
          const fallbackRes = await fetchWithTimeout(`${API_URL}?action=listEvents&ts=${Date.now()}`);
          if (!fallbackRes.ok) throw new Error(`action=listEvents HTTP ${fallbackRes.status}`);

          const fallbackData = await fallbackRes.json();
          if (!fallbackData.success || !Array.isArray(fallbackData.events)) {
            throw new Error(fallbackData.message || "action=listEvents 讀取失敗");
          }

          loadedEvents = fallbackData.events;
        }

        events = loadedEvents;

        // 若備援 API 沒有 dataVersion，就保留既有版本值；
        // 下一次 version check 仍可正常偵測資料更新。
        if (loadedDataVersion !== null) currentDataVersion = loadedDataVersion;

        saveCache();

        // 資料已成功取得後，再單獨處理畫面渲染。
        try {
          renderEvents();
        } catch (renderError) {
          console.error("活動資料渲染失敗", renderError);
          $("eventsEmpty").textContent = "活動資料已讀取，但畫面顯示發生錯誤。";
          $("eventsEmpty").style.display = "block";
          return false;
        }

        return true;
      } catch (error) {
        lastError = error || lastError;
        console.error("活動資料讀取失敗", lastError);

        if (!events.length && !restoreCache()) {
          $("eventsEmpty").textContent = lastError && lastError.name === "AbortError"
            ? "活動資料載入逾時，請稍後重新整理。"
            : "暫時無法讀取活動資料。";
          $("eventsEmpty").style.display = "block";
        } else {
          showToast("暫時無法更新，目前顯示上次成功資料");
        }
        return false;
      } finally {
        isLoading = false;
        $("loadingMessage").style.display = "none";
      }
    }

    async function checkDataVersion() {
      if (document.visibilityState !== "visible" || isLoading) return;
      try {
        const res = await fetchWithTimeout(`${API_URL}?action=version&ts=${Date.now()}`, {}, 8000);
        if (!res.ok) return;
        const data = await res.json();
        if (!data.success || data.dataVersion == null) return;
        const serverDataVersion = String(data.dataVersion);
        if (currentDataVersion === null) {
          currentDataVersion = serverDataVersion;
          return;
        }
        if (serverDataVersion !== currentDataVersion) await loadEvents();
      } catch (error) {
        console.debug("活動資料版本檢查失敗", error);
      }
    }

    function startDataVersionTimer() {
      if (dataVersionTimer) clearInterval(dataVersionTimer);
      if (document.visibilityState !== "visible") return;
      dataVersionTimer = setInterval(checkDataVersion, DATA_VERSION_CHECK_INTERVAL);
    }

    const EVENT_TZ_OFFSET_MS = 8 * 60 * 60 * 1000;

    function getTaipeiParts(date) {
      if (!(date instanceof Date) || Number.isNaN(date.getTime())) return null;

      // 活動資料固定依台灣時間 UTC+8 顯示。
      // 先把 UTC 時間平移 +8 小時，再使用 UTC 欄位讀值，
      // 可完全避免瀏覽器所在地時區造成 8/31 顯示成 8/30。
      const shifted = new Date(date.getTime() + EVENT_TZ_OFFSET_MS);
      return {
        year: shifted.getUTCFullYear(),
        month: shifted.getUTCMonth() + 1,
        day: shifted.getUTCDate(),
        hour: shifted.getUTCHours(),
        minute: shifted.getUTCMinutes()
      };
    }

    function taipeiWallTimeToDate(year, month, day, hour = 0, minute = 0, second = 0) {
      // 把「台灣牆上時間」轉成真正 UTC Date。
      return new Date(Date.UTC(year, month - 1, day, hour - 8, minute, second, 0));
    }

    function parseEventDateValue(value, { endOfDayWhenDateOnly = false } = {}) {
      if (!value) return null;

      if (Object.prototype.toString.call(value) === "[object Date]") {
        const date = new Date(value.getTime());
        const parts = getTaipeiParts(date);
        if (!parts) return null;
        const hasTime = parts.hour !== 0 || parts.minute !== 0;
        if (endOfDayWhenDateOnly && !hasTime) {
          return {
            date: taipeiWallTimeToDate(parts.year, parts.month, parts.day, 23, 59, 59),
            hasTime: false
          };
        }
        return { date, hasTime };
      }

      const text = String(value).trim();
      if (!text) return null;

      // Google Sheet / Apps Script 常回傳 ISO UTC，例如：
      // 2026-08-30T16:00:00.000Z = 台灣 2026/08/31 00:00。
      if (/^\d{4}-\d{2}-\d{2}T/.test(text)) {
        const date = new Date(text);
        if (Number.isNaN(date.getTime())) return null;
        const parts = getTaipeiParts(date);
        if (!parts) return null;
        const hasTime = parts.hour !== 0 || parts.minute !== 0;
        if (endOfDayWhenDateOnly && !hasTime) {
          return {
            date: taipeiWallTimeToDate(parts.year, parts.month, parts.day, 23, 59, 59),
            hasTime: false
          };
        }
        return { date, hasTime };
      }

      // 也支援後端若直接回傳文字：
      // 2026/08/31
      // 2026/09/30 18:00
      const localMatch = text.match(/^(\d{4})[\/-](\d{1,2})[\/-](\d{1,2})(?:[ T](\d{1,2}):(\d{2}))?$/);
      if (localMatch) {
        const year = Number(localMatch[1]);
        const month = Number(localMatch[2]);
        const day = Number(localMatch[3]);
        const hasTime = localMatch[4] != null;
        const hour = hasTime ? Number(localMatch[4]) : (endOfDayWhenDateOnly ? 23 : 0);
        const minute = hasTime ? Number(localMatch[5]) : (endOfDayWhenDateOnly ? 59 : 0);
        const second = !hasTime && endOfDayWhenDateOnly ? 59 : 0;
        return {
          date: taipeiWallTimeToDate(year, month, day, hour, minute, second),
          hasTime
        };
      }

      const date = new Date(text);
      if (Number.isNaN(date.getTime())) return null;
      const parts = getTaipeiParts(date);
      if (!parts) return null;
      const hasTime = parts.hour !== 0 || parts.minute !== 0;
      if (endOfDayWhenDateOnly && !hasTime) {
        return {
          date: taipeiWallTimeToDate(parts.year, parts.month, parts.day, 23, 59, 59),
          hasTime: false
        };
      }
      return { date, hasTime };
    }

    function formatEventDate(value) {
      const parsed = parseEventDateValue(value);
      if (!parsed) return "";
      const parts = getTaipeiParts(parsed.date);
      if (!parts) return "";
      const y = String(parts.year).padStart(4, "0");
      const m = String(parts.month).padStart(2, "0");
      const d = String(parts.day).padStart(2, "0");
      const hh = String(parts.hour).padStart(2, "0");
      const mm = String(parts.minute).padStart(2, "0");
      return parsed.hasTime ? `${y}/${m}/${d} ${hh}:${mm}` : `${y}/${m}/${d}`;
    }

    function formatEventPeriodPart(parsed, includeYear) {
      if (!parsed) return "";
      const parts = getTaipeiParts(parsed.date);
      if (!parts) return "";

      const y = String(parts.year).padStart(4, "0");
      const m = String(parts.month).padStart(2, "0");
      const d = String(parts.day).padStart(2, "0");
      const hh = String(parts.hour).padStart(2, "0");
      const mm = String(parts.minute).padStart(2, "0");
      const dateText = includeYear ? `${y}/${m}/${d}` : `${m}/${d}`;
      return parsed.hasTime ? `${dateText} ${hh}:${mm}` : dateText;
    }

    function buildEventPeriodHtml(eventData) {
      const start = parseEventDateValue(eventData.startDate, { endOfDayWhenDateOnly: false });
      const end = parseEventDateValue(eventData.endDate, { endOfDayWhenDateOnly: true });

      if (!start && !end) {
        return '<div class="event-period-lines"><div>未設定</div></div>';
      }

      const startParts = start ? getTaipeiParts(start.date) : null;
      const endParts = end ? getTaipeiParts(end.date) : null;
      const nowParts = getTaipeiParts(new Date());
      const currentYear = nowParts ? nowParts.year : new Date().getFullYear();

      // 只有「開始、結束都在今年」時才省略年份。
      // 跨年度活動兩邊都顯示年份；常駐活動若從過去年份開始，也保留開始年份。
      const bothWithinCurrentYear = !!(
        startParts &&
        endParts &&
        startParts.year === currentYear &&
        endParts.year === currentYear
      );
      const startIncludeYear = startParts
        ? (!end ? startParts.year !== currentYear : !bothWithinCurrentYear)
        : false;
      const endIncludeYear = endParts
        ? (!start ? endParts.year !== currentYear : !bothWithinCurrentYear)
        : false;

      const startText = start
        ? formatEventPeriodPart(start, startIncludeYear)
        : "未設定";
      const endText = end
        ? formatEventPeriodPart(end, endIncludeYear)
        : "常駐";

      return `
        <div class="event-period-lines">
          <div>${escapeHtml(startText)}</div>
          <div class="event-period-end">~ ${escapeHtml(endText)}</div>
        </div>
      `;
    }

    function getEventStatus(eventData) {
      const now = new Date();
      const start = parseEventDateValue(eventData.startDate, { endOfDayWhenDateOnly: false });
      const end = parseEventDateValue(eventData.endDate, { endOfDayWhenDateOnly: true });

      if (start && now.getTime() < start.date.getTime()) {
        return { key: "upcoming", label: "尚未開始" };
      }
      if (end && now.getTime() > end.date.getTime()) {
        return { key: "ended", label: "已結束" };
      }
      if (!end) return { key: "permanent", label: "常駐" };
      return { key: "active", label: "進行中" };
    }

    function parseEventCoordinateLines(coordsText) {
      return String(coordsText || "")
        .replace(/\r\n/g, "\n")
        .split("\n")
        .map(line => line.trim())
        .filter(Boolean)
        .map((line, index) => {
          const semicolon = line.indexOf(";");
          const name = semicolon >= 0 ? line.slice(0, semicolon).trim() : `座標 ${index + 1}`;
          const coordText = semicolon >= 0 ? line.slice(semicolon + 1).trim() : line;
          const match = coordText.match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/);
          if (!match) return null;
          const lat = Number(match[1]);
          const lon = Number(match[2]);
          if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
          return { name: name || `座標 ${index + 1}`, lat, lon };
        })
        .filter(Boolean);
    }

    function buildEventGpx(eventData) {
      const points = parseEventCoordinateLines(eventData.coords);
      const trackName = eventData.name || "活動座標";
      const wpts = points.map(point =>
        `  <wpt lat="${escapeXml(point.lat.toFixed(6))}" lon="${escapeXml(point.lon.toFixed(6))}"><name>${escapeXml(point.name)}</name></wpt>`
      ).join("\n");
      const trkpts = points.map(point =>
        `      <trkpt lat="${escapeXml(point.lat.toFixed(6))}" lon="${escapeXml(point.lon.toFixed(6))}"><name>${escapeXml(point.name)}</name></trkpt>`
      ).join("\n");
      return `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="XiaoXiao">\n${wpts}\n  <trk>\n    <name>${escapeXml(trackName)}</name>\n    <trkseg>\n${trkpts}\n    </trkseg>\n  </trk>\n</gpx>`;
    }

    function downloadTextFile(text, fileName) {
      const blob = new Blob([text], { type: "application/gpx+xml;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = fileName;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    async function copyEventCoords(id) {
      const eventData = events.find(item => String(item.id) === String(id));
      if (!eventData) return;
      const points = parseEventCoordinateLines(eventData.coords);
      if (!points.length) return showToast("這個活動沒有有效座標");
      const text = points.map(point => `${point.lat.toFixed(6)},${point.lon.toFixed(6)}`).join("\n");
      try {
        await navigator.clipboard.writeText(text);
      } catch (error) {
        const temp = document.createElement("textarea");
        temp.value = text;
        document.body.appendChild(temp);
        temp.select();
        document.execCommand("copy");
        temp.remove();
      }
      showToast(`已複製 ${points.length} 個活動座標`);
    }

    async function copyEventGpx(id) {
      const eventData = events.find(item => String(item.id) === String(id));
      if (!eventData) return;
      const points = parseEventCoordinateLines(eventData.coords);
      if (!points.length) return showToast("這個活動沒有有效座標");

      const wpts = points.map(point =>
        `  <wpt lat="${escapeXml(point.lat.toFixed(6))}" lon="${escapeXml(point.lon.toFixed(6))}"><name>${escapeXml(point.name)}</name></wpt>`
      ).join("\n");
      const wptGpx = `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="XiaoXiao">\n${wpts}\n</gpx>`;

      try {
        await navigator.clipboard.writeText(wptGpx);
      } catch (error) {
        const temp = document.createElement("textarea");
        temp.value = wptGpx;
        temp.style.position = "fixed";
        temp.style.opacity = "0";
        document.body.appendChild(temp);
        temp.select();
        document.execCommand("copy");
        temp.remove();
      }
      showToast(`已複製 AR WPT（${points.length} 個座標）`);
    }

    function downloadEventGpx(id) {
      const eventData = events.find(item => String(item.id) === String(id));
      if (!eventData) return;
      const points = parseEventCoordinateLines(eventData.coords);
      if (!points.length) return showToast("這個活動沒有有效座標");
      const fileName = `${sanitizeFileName(`活動_${eventData.name || "活動座標"}`)}.gpx`;
      downloadTextFile(buildEventGpx(eventData), fileName);
      showToast(`已下載 GPX：${fileName}`);
    }


    async function verifyAdminPassword(password) {
      const res = await fetchWithTimeout(API_URL, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify({ action: "verify", accessPassword: password })
      });
      const data = await res.json();
      return { success: !!data.success && data.role === "admin", data };
    }

    function setAdminMode(enabled) {
      isAdmin = !!enabled;
      document.body.classList.toggle("admin-on", isAdmin);
      $("adminPanel").classList.toggle("active", isAdmin);
      $("adminLoginBtn").style.display = isAdmin ? "none" : "inline-block";
      $("logoutBtn").style.display = isAdmin ? "inline-block" : "none";
      renderEvents();
    }

    function clearEventForm() {
      editingEventId = null;
      $("eventNameInput").value = "";
      $("eventIntervalInput").value = "1day";
      $("eventStartDateInput").value = "";
      $("eventStartTimeInput").value = "";
      $("eventEndDateInput").value = "";
      $("eventEndTimeInput").value = "";
      $("eventCoordsInput").value = "";
      $("eventNoteInput").value = "";
      $("saveEventBtn").textContent = "新增活動";
    }

    function splitEventDateTimeValue(value) {
      if (!value) return { date: "", time: "" };

      const parsed = parseEventDateValue(value, { endOfDayWhenDateOnly: false });
      if (!parsed || !parsed.date) return { date: "", time: "" };

      const parts = getTaipeiParts(parsed.date);
      if (!parts) return { date: "", time: "" };

      const y = String(parts.year).padStart(4, "0");
      const m = String(parts.month).padStart(2, "0");
      const d = String(parts.day).padStart(2, "0");
      const hh = String(parts.hour).padStart(2, "0");
      const mm = String(parts.minute).padStart(2, "0");

      return {
        date: `${y}-${m}-${d}`,
        time: parsed.hasTime ? `${hh}:${mm}` : ""
      };
    }

    function normalize24HourTime(value) {
      const raw = String(value || "").trim();
      if (!raw) return "";

      const compact = raw.replace(/[^0-9]/g, "");
      let hour = "";
      let minute = "";

      if (/^\d{3}$/.test(compact)) {
        hour = compact.slice(0, 1);
        minute = compact.slice(1);
      } else if (/^\d{4}$/.test(compact)) {
        hour = compact.slice(0, 2);
        minute = compact.slice(2);
      } else {
        const match = raw.match(/^(\d{1,2}):(\d{2})$/);
        if (!match) return null;
        hour = match[1];
        minute = match[2];
      }

      const h = Number(hour);
      const m = Number(minute);
      if (!Number.isInteger(h) || !Number.isInteger(m) || h < 0 || h > 23 || m < 0 || m > 59) return null;
      return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
    }

    function buildStoredEventDate(dateValue, timeValue) {
      const date = String(dateValue || "").trim();
      const normalizedTime = normalize24HourTime(timeValue);
      if (!date) return "";
      if (normalizedTime === null) return null;

      const normalizedDate = date.replace(/-/g, "/");
      return normalizedTime ? `${normalizedDate} ${normalizedTime}` : normalizedDate;
    }

    function editEventItem(id) {
      const eventData = events.find(item => String(item.id) === String(id));
      if (!eventData || !isAdmin) return;
      editingEventId = eventData.id;
      $("eventNameInput").value = eventData.name || "";
      $("eventIntervalInput").value = eventData.interval === "1month" ? "monthly1st" : (eventData.interval || "1day");
      const startParts = splitEventDateTimeValue(eventData.startDate);
      const endParts = splitEventDateTimeValue(eventData.endDate);
      $("eventStartDateInput").value = startParts.date;
      $("eventStartTimeInput").value = startParts.time;
      $("eventEndDateInput").value = endParts.date;
      $("eventEndTimeInput").value = endParts.time;
      $("eventCoordsInput").value = String(eventData.coords || "").replace(/\r\n/g, "\n");
      $("eventNoteInput").value = eventData.note || "";
      $("saveEventBtn").textContent = "更新活動";
      $("adminPanel").classList.remove("collapsed");
      $("adminCollapseBtn").textContent = "▲";
      $("adminPanel").scrollIntoView({ behavior:"smooth", block:"start" });
    }

    async function saveEventToSheet(eventData) {
      const res = await fetchWithTimeout(API_URL, {
        method:"POST",
        headers:{ "Content-Type":"text/plain;charset=utf-8" },
        body:JSON.stringify({ action:"saveEvent", adminPassword, event:eventData })
      });
      return await res.json();
    }

    async function deleteEventItem(id) {
      if (!isAdmin) return;
      const eventData = events.find(item => String(item.id) === String(id));
      if (!eventData) return;
      if (!confirm(`確定要刪除「${eventData.name || "此活動"}」嗎？`)) return;
      const res = await fetchWithTimeout(API_URL, {
        method:"POST",
        headers:{ "Content-Type":"text/plain;charset=utf-8" },
        body:JSON.stringify({ action:"deleteEvent", adminPassword, id })
      });
      const data = await res.json();
      if (!data.success) { alert(data.message || "刪除失敗"); return; }
      clearEventForm();
      await loadEvents({ showLoading:false });
      showToast("已刪除活動");
    }

    function renderEventTable(list) {
      if (!list.length) return "";
      return `
        <div class="event-table-header">
          <div class="event-cell">活動名稱</div>
          <div class="event-cell">活動間隔</div>
          <div class="event-cell">活動期間</div>
          <div class="event-cell">座標數量</div>
          <div class="event-cell">備註</div>
          <div class="event-cell">狀態 / 操作</div>
        </div>
        ${list.map(renderEventCard).join("")}
      `;
    }

    function renderEventCard(eventData) {
      const status = getEventStatus(eventData);
      const points = parseEventCoordinateLines(eventData.coords);
      const periodHtml = buildEventPeriodHtml(eventData);
      const interval = EVENT_INTERVAL_LABELS[eventData.interval] || eventData.interval || "未設定";
      const safeId = String(eventData.id || "").replace(/'/g, "\\'");

      return `
        <article class="event-card ${status.key === "ended" ? "ended" : ""}">
          <div class="event-cell event-name-cell"><h3 class="event-card-title">${escapeHtml(eventData.name || "未命名活動")}</h3></div>
          <div class="event-cell event-interval-cell"><span class="event-mobile-label">活動間隔</span>${escapeHtml(interval)}</div>
          <div class="event-cell event-period-cell"><span class="event-mobile-label">活動期間</span>${periodHtml}</div>
          <div class="event-cell event-count-cell"><span class="event-mobile-label">座標數量</span>${points.length} 個</div>
          <div class="event-cell event-note-cell"><span class="event-mobile-label">備註</span>${escapeHtml(eventData.note || "—")}</div>
          <div class="event-cell event-operation-cell">
            <span class="event-mobile-label event-operation-label">狀態 / 操作</span>
            <span class="event-status ${status.key}">${escapeHtml(status.label)}</span>
            ${status.key === "ended" ? "" : `
            <div class="event-actions">
              <button onclick="copyEventCoords('${safeId}')">複製座標</button>
              <button class="secondary" onclick="copyEventGpx('${safeId}')">AR複製</button>
              <button class="download" onclick="downloadEventGpx('${safeId}')">下載 GPX</button>
            </div>`}
            ${isAdmin ? `
            <div class="event-actions">
              <button class="green" onclick="editEventItem('${safeId}')">編輯</button>
              <button class="danger" onclick="deleteEventItem('${safeId}')">刪除</button>
            </div>` : ""}
          </div>
        </article>
      `;
    }

    function renderEvents() {
      $("loadingMessage").style.display = "none";

      const current = [];
      const permanent = [];
      const ended = [];

      events.forEach(eventData => {
        const statusKey = getEventStatus(eventData).key;
        if (statusKey === "ended") {
          ended.push(eventData);
        } else if (statusKey === "permanent") {
          permanent.push(eventData);
        } else {
          // 進行中與尚未開始都留在主要「活動座標」區塊。
          current.push(eventData);
        }
      });

      // 排序規則：
      // 1. 活動座標：結束日期由近到遠；相同時開始日期由舊到新。
      // 2. 常駐活動：開始日期由舊到新。
      // 3. 已結束活動：結束日期由新到舊。
      const getStartTime = eventData => {
        const parsed = parseEventDateValue(eventData.startDate, { endOfDayWhenDateOnly: false });
        return parsed ? parsed.date.getTime() : Number.POSITIVE_INFINITY;
      };

      const getEndTime = eventData => {
        const parsed = parseEventDateValue(eventData.endDate, { endOfDayWhenDateOnly: true });
        return parsed ? parsed.date.getTime() : Number.POSITIVE_INFINITY;
      };

      current.sort((a, b) => {
        const statusA = getEventStatus(a).key;
        const statusB = getEventStatus(b).key;

        // 進行中優先，尚未開始排後面。
        const priority = { active: 0, upcoming: 1 };
        const priorityDiff = (priority[statusA] ?? 9) - (priority[statusB] ?? 9);
        if (priorityDiff !== 0) return priorityDiff;

        // 同一狀態內：結束日期由近到遠；相同時開始日期由舊到新。
        const endDiff = getEndTime(a) - getEndTime(b);
        if (endDiff !== 0) return endDiff;
        return getStartTime(a) - getStartTime(b);
      });

      permanent.sort((a, b) => getStartTime(a) - getStartTime(b));

      ended.sort((a, b) => {
        // 第一順位：結束日期，新 → 舊
        const endDiff = getEndTime(b) - getEndTime(a);
        if (endDiff !== 0) return endDiff;

        // 第二順位：開始日期，新 → 舊
        const startDiff = getStartTime(b) - getStartTime(a);
        if (startDiff !== 0) return startDiff;

        // 第三順位：活動名稱 A → Z
        return String(a.name || "").localeCompare(
          String(b.name || ""),
          "zh-Hant",
          { numeric: true, sensitivity: "base" }
        );
      });

      $("eventsGrid").innerHTML = renderEventTable(current);
      $("eventsGrid").style.display = current.length ? "block" : "none";

      $("permanentEventsGrid").innerHTML = renderEventTable(permanent);
      $("permanentEventsGrid").style.display = permanent.length ? "block" : "none";
      $("permanentEventsTitle").style.display = permanent.length ? "flex" : "none";
      $("permanentEventsCount").textContent = permanent.length ? `共 ${permanent.length} 個活動` : "";

      const visibleEndedEvents = showAllEndedEvents
        ? ended
        : ended.slice(0, ENDED_EVENTS_INITIAL_LIMIT);

      $("endedEventsGrid").innerHTML = renderEventTable(visibleEndedEvents);
      $("endedEventsGrid").style.display = ended.length ? "block" : "none";
      $("endedEventsTitle").style.display = ended.length ? "block" : "none";

      const endedMoreWrap = $("endedEventsMoreWrap");
      const endedMoreBtn = $("endedEventsMoreBtn");

      if (ended.length > ENDED_EVENTS_INITIAL_LIMIT) {
        endedMoreWrap.style.display = "block";

        if (showAllEndedEvents) {
          endedMoreBtn.textContent = "收合";
        } else {
          const remainingCount = ended.length - ENDED_EVENTS_INITIAL_LIMIT;
          endedMoreBtn.textContent = `顯示更多（剩餘 ${remainingCount} 筆）`;
        }
      } else {
        endedMoreWrap.style.display = "none";
      }
      $("eventsCount").textContent = current.length ? `共 ${current.length} 個活動` : "";

      const counts = events.reduce((result, eventData) => {
        const key = getEventStatus(eventData).key;
        result[key] = (result[key] || 0) + 1;
        return result;
      }, {});

      const summaryParts = [
        `進行中 ${counts.active || 0} 個`,
        `常駐 ${counts.permanent || 0} 個`
      ];
      if (counts.upcoming) summaryParts.push(`尚未開始 ${counts.upcoming} 個`);
      $("eventSummaryText").textContent = summaryParts.join(" ｜ ");

      $("eventsSection").style.display = events.length ? "block" : "none";
      $("eventsEmpty").style.display = events.length ? "none" : "block";
    }

    window.copyEventCoords = copyEventCoords;
    window.copyEventGpx = copyEventGpx;
    window.downloadEventGpx = downloadEventGpx;
    window.editEventItem = editEventItem;
    window.deleteEventItem = deleteEventItem;

    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") {
        checkDataVersion();
        startDataVersionTimer();
      } else if (dataVersionTimer) {
        clearInterval(dataVersionTimer);
        dataVersionTimer = null;
      }
    });



    $("endedEventsMoreBtn").addEventListener("click", () => {
      showAllEndedEvents = !showAllEndedEvents;
      renderEvents();

      if (!showAllEndedEvents) {
        $("endedEventsTitle").scrollIntoView({
          behavior: "smooth",
          block: "start"
        });
      }
    });

    $("adminLoginBtn").addEventListener("click", () => $("loginDialog").showModal());
    $("closeLoginBtn").addEventListener("click", () => $("loginDialog").close());
    $("passwordInput").addEventListener("keydown", e => { if (e.key === "Enter") $("confirmLoginBtn").click(); });
    $("confirmLoginBtn").addEventListener("click", async () => {
      const password = $("passwordInput").value;
      if (!password) { alert("請輸入密碼。"); return; }
      const btn = $("confirmLoginBtn");
      btn.disabled = true; btn.textContent = "驗證中…";
      try {
        const result = await verifyAdminPassword(password);
        if (!result.success) { alert(result.data?.message || "管理員密碼錯誤。"); return; }
        adminPassword = password;
        sessionStorage.setItem("pikminActivityAdminPassword", password);
        $("passwordInput").value = "";
        $("loginDialog").close();
        setAdminMode(true);
        showToast("已進入活動管理模式");
      } catch (e) {
        alert("暫時無法驗證管理員權限，請稍後再試。");
      } finally {
        btn.disabled = false; btn.textContent = "登入";
      }
    });
    $("logoutBtn").addEventListener("click", () => {
      adminPassword = "";
      sessionStorage.removeItem("pikminActivityAdminPassword");
      clearEventForm();
      setAdminMode(false);
      showToast("已登出管理員");
    });
    $("adminPanelHeader").addEventListener("click", () => {
      const panel = $("adminPanel");
      const collapsed = !panel.classList.contains("collapsed");
      panel.classList.toggle("collapsed", collapsed);
      $("adminCollapseBtn").textContent = collapsed ? "▼" : "▲";
    });
    $("clearEventFormBtn").addEventListener("click", clearEventForm);
    ["eventStartTimeInput", "eventEndTimeInput"].forEach(id => {
      $(id).addEventListener("blur", () => {
        const normalized = normalize24HourTime($(id).value);
        if (normalized !== null) $(id).value = normalized;
      });
    });

    $("saveEventBtn").addEventListener("click", async () => {
      if (!isAdmin) return;
      const name = $("eventNameInput").value.trim();
      const coords = String($("eventCoordsInput").value || "").replace(/\r\n/g,"\n").trim();

      const startDateOnly = $("eventStartDateInput").value;
      const startTimeOnly = $("eventStartTimeInput").value;
      const endDateOnly = $("eventEndDateInput").value;
      const endTimeOnly = $("eventEndTimeInput").value;

      if (!name) { alert("請填寫活動名稱。"); $("eventNameInput").focus(); return; }
      if (!startDateOnly) { alert("請填寫活動開始日期。"); $("eventStartDateInput").focus(); return; }
      if (startTimeOnly && !startDateOnly) { alert("請先填寫活動開始日期。"); $("eventStartDateInput").focus(); return; }
      if (endTimeOnly && !endDateOnly) { alert("請先填寫活動結束日期，或清除結束時間。"); $("eventEndDateInput").focus(); return; }
      if (!coords) { alert("請填寫活動座標。"); $("eventCoordsInput").focus(); return; }

      const startDate = buildStoredEventDate(startDateOnly, startTimeOnly);
      const endDate = buildStoredEventDate(endDateOnly, endTimeOnly);

      if (startDate === null) {
        alert("活動開始時間請使用 24 小時制 HH:mm，例如 09:30 或 18:00。");
        $("eventStartTimeInput").focus();
        return;
      }
      if (endDate === null) {
        alert("活動結束時間請使用 24 小時制 HH:mm，例如 09:30 或 18:00。");
        $("eventEndTimeInput").focus();
        return;
      }

      const eventData = {
        id: editingEventId || crypto.randomUUID(),
        name,
        interval: $("eventIntervalInput").value,
        startDate,
        endDate,
        coords,
        note: $("eventNoteInput").value.trim()
      };
      const btn = $("saveEventBtn");
      btn.disabled = true;
      try {
        const data = await saveEventToSheet(eventData);
        if (!data.success) { alert(data.message || "儲存失敗"); return; }
        const wasEditing = !!editingEventId;
        clearEventForm();
        await loadEvents({ showLoading:false });
        showToast(wasEditing ? "已更新活動" : "已新增活動");
      } catch (e) {
        alert("儲存失敗，請稍後再試。");
      } finally { btn.disabled = false; }
    });

    // 若本分頁已有管理員登入狀態，自動重新驗證。
    if (adminPassword) {
      verifyAdminPassword(adminPassword).then(result => {
        if (result.success) setAdminMode(true);
        else { adminPassword = ""; sessionStorage.removeItem("pikminActivityAdminPassword"); }
      }).catch(() => {});
    }

    $("reloadLatestBtn").addEventListener("click", () => {
      const url = new URL(window.location.href);
      url.searchParams.set("_latest", Date.now());
      window.location.replace(url.toString());
    });

    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") {
        checkSiteVersion();
        startSiteVersionTimer();
      } else {
        stopSiteVersionTimer();
      }
    });

    checkSiteVersion({ initialize: true }).finally(startSiteVersionTimer);

    const restored = restoreCache();
    
    if (!restored) {
      loadEvents({ showLoading: true });
    } else {
      checkDataVersion();
    }
    
    startDataVersionTimer();
