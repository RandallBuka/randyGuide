/** Client-side Google My Maps KML pull + convert (for Sync on GitHub Pages). */
window.RandyGuideKml = (() => {
  const MAP_ID = "1LIB62nT_OvNPpVft2NAqyAluF5I";
  const KML_URL = `https://www.google.com/maps/d/kml?mid=${MAP_ID}&forcekml=1`;

  const STYLE_META = {
    "icon-503-DB4436": {
      key: "red-pin",
      label: "Unexplored spot",
      color: "#DB4436",
      iconUrl: "icons/503-wht-blank_maps.png",
      tint: true,
    },
    "icon-1257": {
      key: "purple-flag",
      label: "Explored spot",
      color: "#9C27B0",
      iconUrl: "icons/1257-poi-government.png",
      tint: false,
    },
    "icon-1057": {
      key: "yellow-eye",
      label: "Partially explored spot",
      color: "#F9A825",
      iconUrl: "icons/1057-biz-optometrist.png",
      tint: false,
    },
    "icon-1085": {
      key: "restaurant",
      label: "Partially explored restaurant",
      color: "#F9A825",
      iconUrl: "icons/1085-biz-restaurant-generic.png",
      tint: false,
    },
    "icon-971": {
      key: "dollar",
      label: "Partially explored mementos",
      color: "#F9A825",
      iconUrl: "icons/971-biz-bank-dollar.png",
      tint: false,
    },
    "icon-979": {
      key: "cocktail",
      label: "Partially explored drinks",
      color: "#F9A825",
      iconUrl: "icons/979-biz-bar.png",
      tint: false,
    },
    "icon-1899-DB4436": {
      key: "route-pin",
      label: "Route pin",
      color: "#DB4436",
      iconUrl: "icons/503-wht-blank_maps.png",
      tint: true,
    },
  };

  const LAYER_ORDER = [
    "Food To Eat",
    "Coffee & Tea",
    "Drinks To Drink",
    "Places To See",
    "Places to Stay",
  ];

  function cleanText(value) {
    if (!value) return "";
    return value
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, "")
      .trim();
  }

  function nameFromBlock(xml) {
    const cdata = xml.match(/<name><!\[CDATA\[([\s\S]*?)\]\]><\/name>/);
    if (cdata) return cleanText(cdata[1]);
    const plain = xml.match(/<name>([^<]*)<\/name>/);
    return cleanText(plain ? plain[1] : "");
  }

  function descFromBlock(xml) {
    const cdata = xml.match(/<description><!\[CDATA\[([\s\S]*?)\]\]><\/description>/);
    if (cdata) return cleanText(cdata[1]);
    const plain = xml.match(/<description>([^<]*)<\/description>/);
    return cleanText(plain ? plain[1] : "");
  }

  function normalizeStyle(styleUrl) {
    let style = styleUrl.replace("-nodesc", "");
    for (const suffix of ["-normal", "-highlight"]) {
      if (style.endsWith(suffix)) style = style.slice(0, -suffix.length);
    }
    return style;
  }

  function parsePlacemarks(layer, body) {
    const places = [];
    const re = /<Placemark>([\s\S]*?)<\/Placemark>/g;
    let match;
    while ((match = re.exec(body))) {
      const pm = match[1];
      const coords = pm.match(
        /<Point>\s*<coordinates>\s*([^<]+?)\s*<\/coordinates>\s*<\/Point>/
      );
      if (!coords) continue;
      const styleM = pm.match(/<styleUrl>#([^<]+)<\/styleUrl>/);
      if (!styleM) continue;
      const style = normalizeStyle(styleM[1]);
      if (style.startsWith("line-")) continue;
      const meta = STYLE_META[style];
      const iconKey = meta ? meta.key : "other";
      const parts = coords[1].split(",").map((p) => p.trim());
      if (parts.length < 2) continue;
      const lon = Number(parts[0]);
      const lat = Number(parts[1]);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      places.push({
        n: nameFromBlock(pm) || "Untitled",
        d: descFromBlock(pm),
        lat: Math.round(lat * 1e6) / 1e6,
        lng: Math.round(lon * 1e6) / 1e6,
        layer,
        icon: iconKey,
      });
    }
    return places;
  }

  function convertKmlText(kml) {
    const folders = kml.split(/<Folder>/).slice(1);
    const places = [];
    const layerCounts = {};

    for (const part of folders) {
      const end = part.indexOf("</Folder>");
      const body = end < 0 ? part : part.slice(0, end);
      const name = nameFromBlock(body);
      if (!name || name.startsWith("Directions from") || name === "Untitled layer") {
        continue;
      }
      const parsed = parsePlacemarks(name, body);
      if (!parsed.length) continue;
      places.push(...parsed);
      layerCounts[name] = parsed.length;
    }

    const layers = LAYER_ORDER.filter((l) => layerCounts[l]).map((l) => ({
      key: l,
      label: l,
      count: layerCounts[l],
    }));
    for (const l of Object.keys(layerCounts)) {
      if (!layers.some((x) => x.key === l)) {
        layers.push({ key: l, label: l, count: layerCounts[l] });
      }
    }

    const iconCounts = {};
    for (const p of places) {
      iconCounts[p.icon] = (iconCounts[p.icon] || 0) + 1;
    }

    const icons = [];
    const seen = new Set();
    for (const meta of Object.values(STYLE_META)) {
      if (seen.has(meta.key) || !iconCounts[meta.key]) continue;
      seen.add(meta.key);
      icons.push({ ...meta, count: iconCounts[meta.key] });
    }
    if (iconCounts.other) {
      icons.push({
        key: "other",
        label: "Other",
        color: "#607D8B",
        iconUrl: "icons/503-wht-blank_maps.png",
        tint: false,
        count: iconCounts.other,
      });
    }

    return {
      title: "Randy's Guide",
      source: "Google My Maps live sync",
      count: places.length,
      layers,
      icons,
      places,
    };
  }

  async function fetchAsArrayBuffer(url) {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error(`KML fetch failed (${res.status})`);
    return res.arrayBuffer();
  }

  async function loadKmlBytes() {
    try {
      return await fetchAsArrayBuffer(KML_URL);
    } catch (directErr) {
      // Browsers often block Google with CORS — try a public CORS relay
      const proxied = `https://api.allorigins.win/raw?url=${encodeURIComponent(KML_URL)}`;
      try {
        return await fetchAsArrayBuffer(proxied);
      } catch {
        throw directErr;
      }
    }
  }

  async function decodeKml(bytes) {
    const head = new Uint8Array(bytes.slice(0, 2));
    const isZip = head[0] === 0x50 && head[1] === 0x4b; // PK
    if (!isZip) {
      return new TextDecoder("utf-8").decode(bytes);
    }
    if (typeof JSZip === "undefined") {
      throw new Error("KMZ received but JSZip is not loaded");
    }
    const zip = await JSZip.loadAsync(bytes);
    const name = Object.keys(zip.files).find((n) => n.toLowerCase().endsWith(".kml"));
    if (!name) throw new Error("KMZ contained no .kml file");
    return zip.files[name].async("string");
  }

  async function pullLiveMap() {
    const bytes = await loadKmlBytes();
    const text = await decodeKml(bytes);
    if (!text.includes("<kml") && !text.includes("<Placemark")) {
      throw new Error("Download did not look like a My Maps KML file");
    }
    return convertKmlText(text);
  }

  return { pullLiveMap, KML_URL, MAP_ID };
})();
