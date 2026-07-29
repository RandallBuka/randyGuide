(() => {
  const BASE = (() => {
    const scripts = document.getElementsByTagName("script");
    for (let i = scripts.length - 1; i >= 0; i -= 1) {
      const src = scripts[i].src || "";
      if (src.includes("app.js")) {
        return new URL(".", src).pathname;
      }
    }
    const path = location.pathname;
    if (path.endsWith("/")) return path;
    return path.replace(/\/[^/]*$/, "/");
  })();

  function url(path) {
    return `${BASE}${String(path).replace(/^\//, "")}`;
  }

  const state = {
    data: null,
    places: [],
    activeIcons: new Set(),
    activeLayers: new Set(),
    query: "",
    map: null,
    layer: null,
    markersByKey: new Map(),
    contentHash: null,
    pollTimer: null,
    renderTimer: null,
    loading: false,
    hasSyncApi: null,
  };

  const ICON_COLORS = {
    "red-pin": "#DB4436",
    "purple-flag": "#8E24AA",
    "yellow-eye": "#F9A825",
    restaurant: "#F9A825",
    dollar: "#F9A825",
    cocktail: "#F9A825",
    other: "#607D8B",
    "route-pin": "#DB4436",
  };

  const preparedIconUrls = new Map();
  const leafletIconCache = new Map();
  let didFitInitialView = false;
  let renderSeq = 0;

  const els = {
    iconFilters: document.getElementById("icon-filters"),
    layerFilters: document.getElementById("layer-filters"),
    search: document.getElementById("search"),
    status: document.getElementById("status"),
    syncStatus: document.getElementById("sync-status"),
    syncNow: document.getElementById("sync-now"),
    syncHint: document.getElementById("sync-hint"),
    loading: document.getElementById("loading"),
    sidebar: document.getElementById("sidebar"),
    sidebarToggle: document.getElementById("sidebar-toggle"),
  };

  function setLoading(on, label = "Loading places…") {
    state.loading = on;
    els.loading.hidden = !on;
    const span = els.loading.querySelector("span");
    if (span) span.textContent = label;
  }

  function escapeHtml(str) {
    return String(str)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  }

  function iconMeta(key) {
    return state.data?.icons.find((i) => i.key === key);
  }

  function layerMeta(key) {
    return state.data?.layers.find((l) => l.key === key);
  }

  function formatWhen(iso) {
    if (!iso) return null;
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return null;
    return d.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  }

  function updateSyncStatus(meta) {
    if (!meta) {
      els.syncStatus.textContent =
        "Sync status unavailable (is server.py running?)";
      return;
    }
    if (meta.syncing) {
      els.syncStatus.textContent = "Syncing from Google My Maps…";
      return;
    }
    if (meta.ok === false) {
      els.syncStatus.textContent = `Sync error: ${meta.lastError || "unknown"}`;
      return;
    }
    const when = formatWhen(meta.lastSyncedAt || meta.lastCheckedAt);
    if (meta.lastSyncedAt) {
      els.syncStatus.textContent = when
        ? `Last synced ${when}`
        : "Synced with Google My Maps";
    } else if (when) {
      els.syncStatus.textContent = `Last checked ${when}`;
    } else {
      els.syncStatus.textContent = "Waiting for first sync…";
    }
  }

  function markerStyle(iconKey) {
    const color = ICON_COLORS[iconKey] || ICON_COLORS.other;
    return {
      radius: 8,
      color: "#ffffff",
      weight: 2,
      fillColor: color,
      fillOpacity: 0.95,
    };
  }

  function knockoutBlack(iconUrl) {
    const resolved = url(iconUrl);
    if (preparedIconUrls.has(resolved)) return preparedIconUrls.get(resolved);

    const promise = new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        try {
          const canvas = document.createElement("canvas");
          canvas.width = img.naturalWidth || 32;
          canvas.height = img.naturalHeight || 32;
          const ctx = canvas.getContext("2d");
          ctx.drawImage(img, 0, 0);
          const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
          const data = imageData.data;
          for (let i = 0; i < data.length; i += 4) {
            if (data[i] < 28 && data[i + 1] < 28 && data[i + 2] < 28) {
              data[i + 3] = 0;
            }
          }
          ctx.putImageData(imageData, 0, 0);
          resolve(canvas.toDataURL("image/png"));
        } catch {
          resolve(resolved);
        }
      };
      img.onerror = () => resolve(resolved);
      img.src = resolved;
    });

    preparedIconUrls.set(resolved, promise);
    return promise;
  }

  async function getLeafletIcon(iconKey) {
    if (leafletIconCache.has(iconKey)) return leafletIconCache.get(iconKey);

    const meta = iconMeta(iconKey) || {
      iconUrl: "icons/503-wht-blank_maps.png",
      tint: false,
    };
    const src = await knockoutBlack(meta.iconUrl);
    const tintClass = meta.tint ? " tint" : "";
    const icon = L.divIcon({
      className: "rg-marker",
      html: `<img class="rg-pin${tintClass}" src="${src}" alt="" width="28" height="28" />`,
      iconSize: [28, 36],
      iconAnchor: [14, 34],
      popupAnchor: [0, -28],
    });
    leafletIconCache.set(iconKey, icon);
    return icon;
  }

  async function ensureIconsReady() {
    if (!state.data?.icons?.length) return;
    await Promise.all(state.data.icons.map((i) => getLeafletIcon(i.key)));
  }

  function venueSubtitle(place) {
    const desc = (place.d || "").trim();
    const name = (place.n || "").trim();

    // Descriptions often look like: "-Queen City Exchange [notes]"
    const bullet = desc.match(/^[+\-–—•]\s*([^\n\r]+)/);
    if (bullet) {
      let title = bullet[1].replace(/\s*\[.*?\]\s*/g, " ").trim();
      title = title.replace(/\s{2,}/g, " ").trim();
      if (title.length > 2 && title.toLowerCase() !== name.toLowerCase()) {
        return title;
      }
    }

    if (desc) {
      const first = desc
        .split(/\n/)[0]
        .replace(/^[+\-–—•]\s*/, "")
        .replace(/\s*\[.*?\]\s*/g, " ")
        .trim();
      if (first.length > 2 && first.toLowerCase() !== name.toLowerCase()) {
        return first;
      }
    }

    return "";
  }

  function notesText(place) {
    const desc = (place.d || "").trim();
    if (!desc) return "";
    const venue = venueSubtitle(place);

    // Keep bracket callouts from the first line even if we promote the venue name
    const brackets = [...desc.matchAll(/\[(.*?)\]/g)]
      .map((m) => m[1].trim())
      .filter(Boolean);

    let body = desc;
    if (venue) {
      // Strip the leading venue bullet line so Notes don't repeat the subtitle
      body = body.replace(/^[+\-–—•]\s*[^\n\r]+/, "").trim();
      // Also strip a plain first-line duplicate of the venue
      const lines = body.split(/\n/);
      if (
        lines[0] &&
        lines[0].replace(/\[.*?\]/g, "").trim().toLowerCase() ===
          venue.toLowerCase()
      ) {
        body = lines.slice(1).join("\n").trim();
      }
    }

    const extras = brackets.filter(
      (b) => !venue || !venue.toLowerCase().includes(b.toLowerCase())
    );
    if (!body && extras.length) return extras.map((b) => `[${b}]`).join("\n");
    if (body && extras.length) {
      // Avoid duplicating brackets already present in body
      const missing = extras.filter((b) => !body.includes(b));
      return missing.length ? `${body}\n${missing.map((b) => `[${b}]`).join("\n")}` : body;
    }
    return body;
  }

  function mapsCoordUrl(place) {
    return `https://www.google.com/maps?q=${place.lat},${place.lng}`;
  }

  function popupHtml(place) {
    const layer = layerMeta(place.layer)?.label || place.layer;
    const icon = iconMeta(place.icon)?.label || place.icon;
    const heading = (place.n || "").trim() || "Untitled";
    const subtitle = venueSubtitle(place);
    const notes = notesText(place);

    const subtitleBlock = subtitle
      ? `<p class="subtitle">${escapeHtml(subtitle)}</p>`
      : "";
    const notesBlock = notes
      ? `<section class="rg-block notes">
           <h4 class="block-label">Notes</h4>
           <p class="desc">${escapeHtml(notes)}</p>
         </section>`
      : "";

    return `
      <div class="rg-popup" data-lat="${place.lat}" data-lng="${place.lng}" data-heading="${escapeHtml(heading)}" data-venue="${escapeHtml(subtitle)}">
        <p class="meta">${escapeHtml(layer)} · ${escapeHtml(icon)}</p>
        <h3 class="title">${escapeHtml(heading)}</h3>
        ${subtitleBlock}

        ${notesBlock}

        <section class="rg-block details">
          <h4 class="block-label">Details</h4>
          <p class="address js-address">Looking up address…</p>
          <div class="details-facts js-facts" hidden></div>
          <p class="details-hint">Phone, website, hours, and reviews open in Google Maps.</p>
          <p class="maps-link">
            <a class="js-maps-link" href="${mapsCoordUrl(place)}" target="_blank" rel="noopener noreferrer">Open in Google Maps</a>
          </p>
        </section>
      </div>
    `;
  }

  const addressCache = new Map();

  function formatNominatimAddress(data) {
    if (!data) return "";
    const a = data.address || {};
    const street = [a.house_number, a.road || a.pedestrian || a.footway || a.path]
      .filter(Boolean)
      .join(" ");
    const parts = [
      street,
      a.neighbourhood || a.suburb || a.quarter,
      a.city || a.town || a.village || a.municipality || a.county,
      a.state || a.region || a.province,
      a.postcode,
      a.country,
    ].filter(Boolean);

    const uniq = [];
    for (const part of parts) {
      if (!uniq.length || uniq[uniq.length - 1].toLowerCase() !== part.toLowerCase()) {
        uniq.push(part);
      }
    }
    if (uniq.length) return uniq.join(", ");
    return data.display_name || "";
  }

  function formatBigDataAddress(data) {
    if (!data) return "";
    const admin = (data.localityInfo?.administrative || [])
      .slice()
      .sort((a, b) => (b.adminLevel || 0) - (a.adminLevel || 0))
      .map((x) => x.name)
      .filter(Boolean);

    const parts = [
      admin[0],
      data.locality,
      data.city,
      data.principalSubdivision,
      data.postcode,
      data.countryName,
    ].filter(Boolean);

    const uniq = [];
    for (const part of parts) {
      if (!uniq.length || uniq[uniq.length - 1].toLowerCase() !== part.toLowerCase()) {
        uniq.push(part);
      }
    }
    return uniq.join(", ");
  }

  function renderFact(label, value, href) {
    if (!value) return "";
    const content = href
      ? `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(value)}</a>`
      : escapeHtml(value);
    return `<div class="fact"><span class="fact-label">${escapeHtml(label)}</span><span class="fact-value">${content}</span></div>`;
  }

  async function lookupPlaceDetails(lat, lng) {
    const key = `${lat.toFixed(5)},${lng.toFixed(5)}`;
    if (addressCache.has(key)) return addressCache.get(key);

    let result = { address: "", phone: "", website: "", osmName: "" };

    try {
      const nomUrl =
        `https://nominatim.openstreetmap.org/reverse` +
        `?format=jsonv2&lat=${lat}&lon=${lng}&addressdetails=1&extratags=1&namedetails=1&zoom=18`;
      const res = await fetch(nomUrl, { headers: { Accept: "application/json" } });
      if (res.ok) {
        const data = await res.json();
        result.address = formatNominatimAddress(data);
        result.osmName = data.name || data.namedetails?.name || "";
        const tags = data.extratags || {};
        result.phone = tags.phone || tags["contact:phone"] || "";
        result.website = tags.website || tags["contact:website"] || tags.url || "";
      }
    } catch {
      // fall through
    }

    if (!result.address) {
      try {
        const bdcUrl =
          `https://api.bigdatacloud.net/data/reverse-geocode-client` +
          `?latitude=${lat}&longitude=${lng}&localityLanguage=en`;
        const res = await fetch(bdcUrl);
        if (res.ok) {
          const data = await res.json();
          result.address = formatBigDataAddress(data);
        }
      } catch {
        // fall through
      }
    }

    if (!result.address) {
      result.address = `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
    }

    addressCache.set(key, result);
    return result;
  }

  async function fillAddress(popupRoot) {
    const wrap = popupRoot?.closest?.(".rg-popup") || popupRoot;
    if (!wrap) return;
    const addressEl = wrap.querySelector(".js-address");
    const factsEl = wrap.querySelector(".js-facts");
    const mapsLink = wrap.querySelector(".js-maps-link");
    const lat = Number(wrap.getAttribute("data-lat"));
    const lng = Number(wrap.getAttribute("data-lng"));
    const venue = wrap.getAttribute("data-venue") || "";
    const heading = wrap.getAttribute("data-heading") || "";

    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      if (addressEl) addressEl.hidden = true;
      return;
    }

    if (addressEl) {
      addressEl.hidden = false;
      addressEl.textContent = "Looking up address…";
    }

    const details = await lookupPlaceDetails(lat, lng);
    if (!wrap.isConnected) return;

    if (addressEl) addressEl.textContent = details.address;

    if (factsEl) {
      const html = [
        renderFact("Phone", details.phone, details.phone ? `tel:${details.phone}` : ""),
        renderFact("Website", details.website ? details.website.replace(/^https?:\/\//, "") : "", details.website),
      ]
        .filter(Boolean)
        .join("");
      factsEl.innerHTML = html;
      factsEl.hidden = !html;
    }

    if (mapsLink) {
      const q = encodeURIComponent(
        [venue, heading, details.address].filter(Boolean).join(" ")
      );
      mapsLink.href = `https://www.google.com/maps/search/?api=1&query=${q}`;
    }
  }

  function bindPlacePopup(marker, place) {
    marker.bindPopup(() => popupHtml(place), {
      maxWidth: 300,
      autoPan: true,
      autoPanPadding: [40, 40],
      // Keep popup alive if map nudges while opening
      closeOnClick: true,
    });
    marker.on("popupopen", (e) => {
      const node = e.popup.getElement();
      const root = node?.querySelector(".rg-popup");
      if (root) fillAddress(root);
    });
  }

  function placeKey(place) {
    return `${place.icon}|${place.layer}|${place.lat}|${place.lng}|${place.n}|${place.d || ""}`;
  }

  function matchesFilters(place, q) {
    if (!state.activeIcons.has(place.icon)) return false;
    if (!state.activeLayers.has(place.layer)) return false;
    if (!q) return true;
    return `${place.n}\n${place.d}`.toLowerCase().includes(q);
  }

  function filteredPlaces() {
    const q = state.query.trim().toLowerCase();
    const out = [];
    for (const place of state.places) {
      if (matchesFilters(place, q)) out.push(place);
    }
    return out;
  }

  function clearAllMarkers() {
    if (state.layer) state.layer.clearLayers();
    state.markersByKey.clear();
  }

  function scheduleRender({ immediate = false } = {}) {
    clearTimeout(state.renderTimer);
    const run = () => {
      renderVisibleMarkers().catch((err) => console.error(err));
    };
    if (immediate) {
      run();
      return;
    }
    // Short debounce keeps pans smooth without waiting long after release
    state.renderTimer = setTimeout(run, 16);
  }

  function fitToDataIfNeeded() {
    if (didFitInitialView || !state.map || !state.places.length) return;
    const matched = filteredPlaces();
    if (!matched.length) return;
    const latLngs = matched.map((p) => [p.lat, p.lng]);
    const bounds = L.latLngBounds(latLngs);
    if (!bounds.isValid()) return;
    state.map.fitBounds(bounds.pad(0.08), { maxZoom: 5, animate: false });
    didFitInitialView = true;
  }

  async function applyPlacesData(data) {
    preserveFiltersAgainst(data);
    state.data = data;
    state.places = data.places;
    leafletIconCache.clear();
    preparedIconUrls.clear();
    clearAllMarkers();
    renderFilterList(els.iconFilters, data.icons, "icon");
    renderFilterList(els.layerFilters, data.layers, "layer");
    await ensureIconsReady();
    fitToDataIfNeeded();
    await renderVisibleMarkers();
  }

  async function renderVisibleMarkers() {
    if (!state.map || !state.layer || !state.data) return;

    const seq = ++renderSeq;
    const matched = filteredPlaces();
    // Generous pad so edge pins don't drop during small pans / popup auto-pan
    const bounds = state.map.getBounds().pad(0.35);

    const shouldShow = new Map();
    for (const place of matched) {
      if (bounds.contains([place.lat, place.lng])) {
        shouldShow.set(placeKey(place), place);
      }
    }

    // Drop markers that left the view / no longer match filters.
    // Never remove a marker with an open popup (auto-pan would otherwise close it).
    for (const [key, marker] of [...state.markersByKey.entries()]) {
      if (shouldShow.has(key)) continue;
      if (marker.isPopupOpen()) continue;
      state.layer.removeLayer(marker);
      state.markersByKey.delete(key);
    }

    if (seq !== renderSeq) return;

    // Add only markers that are missing (keeps open popups intact)
    const toAdd = [];
    for (const [key, place] of shouldShow) {
      if (!state.markersByKey.has(key)) toAdd.push([key, place]);
    }

    const iconKeys = [...new Set(toAdd.map(([, p]) => p.icon))];
    await Promise.all(iconKeys.map((k) => getLeafletIcon(k)));
    if (seq !== renderSeq) return;

    // Sync adds after icons are ready — no per-marker await (faster, no mid-add gaps)
    const CHUNK = 120;
    for (let i = 0; i < toAdd.length; i += CHUNK) {
      if (seq !== renderSeq) return;
      const chunk = toAdd.slice(i, i + CHUNK);
      for (const [key, place] of chunk) {
        if (state.markersByKey.has(key)) continue;
        const icon = leafletIconCache.get(place.icon);
        if (!icon) continue;
        const marker = L.marker([place.lat, place.lng], {
          icon,
          keyboard: false,
          riseOnHover: true,
        });
        bindPlacePopup(marker, place);
        state.layer.addLayer(marker);
        state.markersByKey.set(key, marker);
      }
      if (i + CHUNK < toAdd.length) {
        await new Promise((r) => requestAnimationFrame(r));
      }
    }

    if (seq !== renderSeq) return;

    els.status.textContent = `${matched.length.toLocaleString()} of ${state.data.count.toLocaleString()} match filters · ${shouldShow.size.toLocaleString()} in view`;
  }

  function renderFilterList(container, items, kind) {
    container.innerHTML = "";
    for (const item of items) {
      const id = `${kind}-${item.key}`;
      const label = document.createElement("label");
      label.className = "filter-item";
      label.htmlFor = id;

      const input = document.createElement("input");
      input.type = "checkbox";
      input.id = id;
      input.checked =
        kind === "icon"
          ? state.activeIcons.has(item.key)
          : state.activeLayers.has(item.key);
      input.addEventListener("change", () => {
        const set = kind === "icon" ? state.activeIcons : state.activeLayers;
        if (input.checked) set.add(item.key);
        else set.delete(item.key);
        scheduleRender({ immediate: true });
      });

      const text = document.createElement("span");
      text.className = "label";

      if (kind === "icon") {
        const swatch = document.createElement("span");
        swatch.className = `swatch${item.tint ? " tint" : ""}`;
        swatch.style.background = ICON_COLORS[item.key] || "#1c1915";
        if (item.iconUrl) {
          const img = document.createElement("img");
          img.src = item.iconUrl;
          img.alt = "";
          swatch.appendChild(img);
        }
        text.appendChild(swatch);
      }

      const name = document.createElement("span");
      name.textContent = item.label;
      text.appendChild(name);

      const count = document.createElement("span");
      count.className = "count";
      count.textContent = item.count.toLocaleString();

      label.append(input, text, count);
      container.appendChild(label);
    }
  }

  function setAll(kind, on) {
    if (kind === "icons") {
      state.activeIcons = new Set(
        on ? state.data.icons.map((i) => i.key) : []
      );
      renderFilterList(els.iconFilters, state.data.icons, "icon");
    } else {
      state.activeLayers = new Set(
        on ? state.data.layers.map((l) => l.key) : []
      );
      renderFilterList(els.layerFilters, state.data.layers, "layer");
    }
    scheduleRender({ immediate: true });
  }

  function preserveFiltersAgainst(nextData) {
    const iconKeys = new Set(nextData.icons.map((i) => i.key));
    const layerKeys = new Set(nextData.layers.map((l) => l.key));

    if (!state.data) {
      state.activeIcons = new Set(iconKeys);
      state.activeLayers = new Set(layerKeys);
      return;
    }

    const prevIconKeys = new Set(state.data.icons.map((i) => i.key));
    const prevLayerKeys = new Set(state.data.layers.map((l) => l.key));

    const nextIcons = new Set(
      [...state.activeIcons].filter((k) => iconKeys.has(k))
    );
    for (const key of iconKeys) {
      if (!prevIconKeys.has(key)) nextIcons.add(key);
    }
    if (nextIcons.size === 0) {
      for (const key of iconKeys) nextIcons.add(key);
    }

    const nextLayers = new Set(
      [...state.activeLayers].filter((k) => layerKeys.has(k))
    );
    for (const key of layerKeys) {
      if (!prevLayerKeys.has(key)) nextLayers.add(key);
    }
    if (nextLayers.size === 0) {
      for (const key of layerKeys) nextLayers.add(key);
    }

    state.activeIcons = nextIcons;
    state.activeLayers = nextLayers;
  }

  async function loadPlaces() {
    if (state.loading) return;
    setLoading(true, "Loading places…");
    els.status.textContent = "Downloading place data…";

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 60_000);
      let res;
      try {
        res = await fetch(url(`data/places.json?t=${Date.now()}`), {
          cache: "no-store",
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeout);
      }
      if (!res.ok) {
        throw new Error(`Failed to load places.json (${res.status})`);
      }

      setLoading(true, "Parsing places…");
      els.status.textContent = "Parsing place data…";
      const text = await res.text();
      // Yield so the overlay can paint before the JSON parse blocks the main thread
      await new Promise((r) => setTimeout(r, 20));
      const data = JSON.parse(text);
      await applyPlacesData(data);
    } finally {
      setLoading(false);
    }
  }

  async function fetchMeta() {
    const res = await fetch(url(`api/sync-meta?t=${Date.now()}`), {
      cache: "no-store",
    });
    if (!res.ok) throw new Error("meta unavailable");
    return res.json();
  }

  function enableStaticHostingMode() {
    state.hasSyncApi = false;
    if (els.syncNow) els.syncNow.hidden = false;
    if (els.syncHint) {
      els.syncHint.textContent =
        "Sync now re-pulls the live Google My Map in this browser. GitHub also refreshes about every 6 hours.";
    }
    els.syncStatus.textContent = "Online edition — tap Sync now to refresh";
  }

  async function detectSyncApi() {
    try {
      const res = await fetch(url(`api/sync-meta?t=${Date.now()}`), {
        cache: "no-store",
      });
      if (!res.ok) {
        enableStaticHostingMode();
        return false;
      }
      state.hasSyncApi = true;
      if (els.syncNow) els.syncNow.hidden = false;
      if (els.syncHint) {
        els.syncHint.textContent =
          "Sync now re-pulls from Google My Maps. Auto-checks continue while this server is running.";
      }
      return true;
    } catch {
      enableStaticHostingMode();
      return false;
    }
  }

  async function syncFromGoogleInBrowser() {
    if (!window.RandyGuideKml?.pullLiveMap) {
      throw new Error("Live sync script failed to load");
    }
    els.syncStatus.textContent = "Downloading Google My Map…";
    const data = await window.RandyGuideKml.pullLiveMap();
    if (!data?.places?.length) {
      throw new Error("My Map download contained no places");
    }
    await applyPlacesData(data);
    els.syncStatus.textContent = `Synced just now · ${data.count.toLocaleString()} places`;
  }

  async function checkForUpdates() {
    if (!state.hasSyncApi) return;
    try {
      const meta = await fetchMeta();
      updateSyncStatus(meta);

      if (
        meta.contentHash &&
        state.contentHash &&
        meta.contentHash !== state.contentHash &&
        !state.loading
      ) {
        els.syncStatus.textContent = "Update found — refreshing map…";
        await loadPlaces();
        state.contentHash = meta.contentHash;
        updateSyncStatus(await fetchMeta().catch(() => meta));
      } else if (meta.contentHash && !state.contentHash) {
        state.contentHash = meta.contentHash;
      }
    } catch {
      enableStaticHostingMode();
    }
  }

  async function syncNow() {
    if (state.loading) return;
    els.syncNow.disabled = true;
    els.syncStatus.textContent = "Syncing from Google My Maps…";
    setLoading(true, "Syncing from My Maps…");
    try {
      if (state.hasSyncApi) {
        const res = await fetch(url("api/sync"), { method: "POST" });
        const meta = await res.json();
        if (!res.ok || meta.ok === false) {
          throw new Error(meta.lastError || "Sync failed");
        }
        setLoading(false);
        if (meta.changed || meta.contentHash !== state.contentHash) {
          await loadPlaces();
        }
        state.contentHash = meta.contentHash || state.contentHash;
        updateSyncStatus(meta);
      } else {
        await syncFromGoogleInBrowser();
        setLoading(false);
      }
    } catch (err) {
      console.error(err);
      els.syncStatus.textContent = `Sync failed: ${err.message || err}`;
      setLoading(false);
    } finally {
      els.syncNow.disabled = false;
    }
  }

  function startPolling() {
    const tick = async () => {
      await checkForUpdates();
      state.pollTimer = setTimeout(tick, 30_000);
    };
    // Delay first poll so it doesn't race the initial load
    state.pollTimer = setTimeout(tick, 15_000);
  }

  function wireActions() {
    document.querySelectorAll("[data-action]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const action = btn.getAttribute("data-action");
        if (action === "icons-all") setAll("icons", true);
        if (action === "icons-none") setAll("icons", false);
        if (action === "layers-all") setAll("layers", true);
        if (action === "layers-none") setAll("layers", false);
      });
    });

    let searchTimer = null;
    els.search.addEventListener("input", () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        state.query = els.search.value;
        scheduleRender({ immediate: true });
      }, 120);
    });

    els.sidebarToggle.addEventListener("click", () => {
      const open = !els.sidebar.classList.contains("open");
      els.sidebar.classList.toggle("open", open);
      els.sidebarToggle.setAttribute("aria-expanded", String(open));
    });

    els.syncNow.addEventListener("click", () => {
      syncNow();
    });
  }

  function initMap() {
    state.map = L.map("map", {
      zoomControl: false,
      worldCopyJump: true,
    }).setView([20, 0], 2);

    L.control.zoom({ position: "bottomright" }).addTo(state.map);

    const roadLayer = L.tileLayer(
      "https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png",
      {
        attribution:
          '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/">CARTO</a>',
        subdomains: "abcd",
        maxZoom: 20,
      }
    );

    // Hybrid satellite: imagery + roads/borders/city labels (closer to Google Satellite)
    const satelliteImagery = L.tileLayer(
      "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
      {
        attribution:
          "Tiles &copy; Esri &mdash; Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community",
        maxZoom: 19,
      }
    );
    const satelliteRoads = L.tileLayer(
      "https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}",
      {
        opacity: 0.9,
        maxZoom: 19,
        pane: "overlayPane",
      }
    );
    const satelliteLabels = L.tileLayer(
      "https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}",
      {
        opacity: 0.95,
        maxZoom: 19,
        pane: "overlayPane",
      }
    );
    const satelliteLayer = L.layerGroup([
      satelliteImagery,
      satelliteRoads,
      satelliteLabels,
    ]);

    roadLayer.addTo(state.map);
    state.baseLayers = { road: roadLayer, satellite: satelliteLayer };
    state.activeBase = "road";

    L.control
      .layers(
        {
          Map: roadLayer,
          Satellite: satelliteLayer,
        },
        null,
        { position: "topright", collapsed: false }
      )
      .addTo(state.map);

    state.layer = L.layerGroup().addTo(state.map);

    // Update while dragging so pins appear without waiting for release
    let moveRaf = 0;
    state.map.on("move", () => {
      if (moveRaf) return;
      moveRaf = requestAnimationFrame(() => {
        moveRaf = 0;
        scheduleRender({ immediate: true });
      });
    });
    state.map.on("moveend", () => scheduleRender({ immediate: true }));
    state.map.on("zoomend", () => scheduleRender({ immediate: true }));
  }

  async function boot() {
    initMap();
    wireActions();
    setupPwa();

    try {
      await loadPlaces();
      const hasApi = await detectSyncApi();
      if (hasApi) {
        try {
          const meta = await fetchMeta();
          state.contentHash = meta.contentHash || null;
          updateSyncStatus(meta);
        } catch {
          updateSyncStatus(null);
        }
        startPolling();
      }
    } catch (err) {
      console.error(err);
      els.status.textContent =
        "Could not load map data. If you're online, try refreshing.";
      els.syncStatus.textContent = "Data not reachable";
      setLoading(false);
    }
  }

  function isStandalone() {
    return (
      window.matchMedia("(display-mode: standalone)").matches ||
      window.navigator.standalone === true
    );
  }

  function isIos() {
    return /iphone|ipad|ipod/i.test(window.navigator.userAgent);
  }

  function setupPwa() {
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register(url("sw.js"), { scope: BASE }).catch((err) => {
        console.warn("Service worker registration failed", err);
      });
    }

    const banner = document.getElementById("install-banner");
    const installBtn = document.getElementById("install-btn");
    const dismissBtn = document.getElementById("install-dismiss");
    const instructions = document.getElementById("install-instructions");
    if (!banner || !installBtn || !dismissBtn || !instructions) return;

    if (isStandalone() || localStorage.getItem("rg-install-dismissed") === "1") {
      return;
    }

    let deferredPrompt = null;

    const showBanner = () => {
      banner.hidden = false;
    };

    dismissBtn.addEventListener("click", () => {
      localStorage.setItem("rg-install-dismissed", "1");
      banner.hidden = true;
    });

    window.addEventListener("beforeinstallprompt", (event) => {
      event.preventDefault();
      deferredPrompt = event;
      instructions.textContent =
        "Install for a full-screen app icon on your home screen.";
      installBtn.hidden = false;
      showBanner();
    });

    installBtn.addEventListener("click", async () => {
      if (!deferredPrompt) return;
      deferredPrompt.prompt();
      await deferredPrompt.userChoice;
      deferredPrompt = null;
      banner.hidden = true;
    });

    // iOS has no beforeinstallprompt — show Share instructions instead
    if (isIos()) {
      instructions.textContent =
        "In Safari: tap Share, then “Add to Home Screen”.";
      installBtn.hidden = true;
      showBanner();
    }
  }

  boot();
})();
