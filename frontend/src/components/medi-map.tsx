"use client";

/**
 * MediMap — reusable MapLibre + Barikoi map.
 *
 * Features:
 *  - Barikoi vector tiles (osm-liberty style) when NEXT_PUBLIC_BARIKOI_KEY
 *    is set; falls back to plain raster OSM tiles otherwise.
 *  - User marker (blue dot) + optional accuracy ring.
 *  - Pharmacy markers (green pill with rating) — popup shows name+rating+CTA.
 *  - Optional rider marker (orange bike) for live tracking.
 *  - Optional route polyline (red) drawn from a Barikoi polyline string.
 *  - Built-in autocomplete search box (top-left).
 *  - Locate-me button (top-right) → geolocation + reverse-geocode.
 *  - Search / locate can emit onPick({lat,lng,address}) when supplied.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import maplibregl, {
  type Map as MlMap,
  type Marker as MlMarker,
  type StyleSpecification,
} from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { Loader2, MapPin, Navigation, Search, X } from "lucide-react";
import {
  BARIKOI_STYLE_URL,
  DEFAULT_CENTER,
  friendlyLocationLabel,
  geoApi,
  getPreciseLocation,
  locationErrorMessage,
  polylineToGeoJSON,
  type AutocompletePlace,
  type PharmacyMarker as PharmMarker,
  type ReverseAddress,
} from "@/lib/geo";

export type LatLng = { lat: number; lng: number };

export type MapPickResult = {
  lat: number;
  lng: number;
  address: string;
  raw: ReverseAddress;
};

export type MediMapProps = {
  center?: LatLng | null;
  zoom?: number;
  height?: number | string;
  className?: string;

  /** Blue dot for the user / shop / rider self. */
  userLocation?: LatLng | null;
  userLabel?: string;

  /** Pharmacy pins. */
  pharmacies?: PharmMarker[];
  /** Open the storefront when a pharmacy popup CTA is clicked. */
  onPharmacyClick?: (p: PharmMarker) => void;

  /** Live rider marker (orange). */
  riderLocation?: LatLng | null;
  riderLabel?: string;

  /** Customer/drop marker with profile image fallback. */
  customerLocation?: LatLng | null;
  customerLabel?: string;
  customerAvatarUrl?: string | null;
  customerFallbackImageUrl?: string | null;

  /** Optional Barikoi-encoded polyline for the trip. */
  routePolyline?: string | null;

  /** Click → reverse-geocode → emit. Defaults to disabled. */
  onPick?: (result: MapPickResult) => void;
  pickEnabled?: boolean;

  /** Hide the search box. */
  showSearch?: boolean;
  /** Hide the locate-me FAB. */
  showLocateButton?: boolean;
  /** Custom city restriction for autocomplete. */
  searchCity?: string;

  /**
   * Allow the user to drag the user/pick marker to fine-tune the position.
  * Defaults to false. Enable only for explicit address-picker surfaces.
   */
  draggablePin?: boolean;
};

/* ------------------------------------------------------------------ */
/* Style                                                              */
/* ------------------------------------------------------------------ */
function fallbackStyle(): StyleSpecification {
  // Plain OSM raster — no key needed. Used when Barikoi key missing.
  return {
    version: 8,
    sources: {
      osm: {
        type: "raster",
        tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
        tileSize: 256,
        attribution: "© OpenStreetMap contributors",
      },
    },
    layers: [{ id: "osm", type: "raster", source: "osm" }],
  } satisfies StyleSpecification;
}

/* ------------------------------------------------------------------ */
/* Marker DOM helpers                                                 */
/* ------------------------------------------------------------------ */
function makeUserDot(label?: string): HTMLDivElement {
  const wrap = document.createElement("div");
  wrap.className = "medi-marker medi-marker-user";
  wrap.innerHTML = `
    <div class="medi-marker-pulse"></div>
    <div class="medi-marker-dot"></div>
  `;
  if (label) wrap.title = label;
  return wrap;
}

function makePharmDot(p: PharmMarker): HTMLDivElement {
  const wrap = document.createElement("div");
  wrap.className = "medi-marker medi-marker-pharm";
  const tone = p.is_open ? "open" : "closed";
  const img = escapeHtml(p.banner_photo_url || "/brand/logo-inside.png");
  const initial = escapeHtml((p.name || "P").slice(0, 1).toUpperCase());
  wrap.innerHTML = `
    <div class="medi-pharm-pin ${tone}">
      <img src="${img}" alt="" loading="lazy" />
      <span>${initial}</span>
    </div>
  `;
  wrap.title = `${p.name}${p.is_open ? "" : " (closed)"}`;
  return wrap;
}

function makeRiderDot(label?: string): HTMLDivElement {
  const wrap = document.createElement("div");
  wrap.className = "medi-marker medi-marker-rider";
  wrap.innerHTML = `
    <div class="medi-rider-pin">
      <img src="/brand/rider-logo.png" alt="" loading="lazy" />
    </div>
  `;
  if (label) wrap.title = label;
  return wrap;
}

function makeCustomerDot(
  label?: string,
  avatarUrl?: string | null,
  fallbackUrl: string = "/brand/logo-outside-bg.png",
): HTMLDivElement {
  const wrap = document.createElement("div");
  wrap.className = "medi-marker medi-marker-customer";
  const img = escapeHtml(avatarUrl || fallbackUrl);
  const text = escapeHtml(label || "Customer");
  wrap.innerHTML = `
    <div class="medi-customer-pin">
      <img src="${img}" alt="" loading="lazy" />
    </div>
    <div class="medi-marker-label customer">${text}</div>
  `;
  wrap.title = text;
  return wrap;
}

/* ------------------------------------------------------------------ */
/* Component                                                          */
/* ------------------------------------------------------------------ */
export function MediMap({
  center,
  zoom = 13,
  height = 380,
  className,
  userLocation,
  userLabel,
  pharmacies = [],
  onPharmacyClick,
  riderLocation,
  riderLabel,
  customerLocation,
  customerLabel,
  customerAvatarUrl,
  customerFallbackImageUrl,
  routePolyline,
  onPick,
  pickEnabled = false,
  showSearch = true,
  showLocateButton = true,
  searchCity = "dhaka",
  draggablePin,
}: MediMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MlMap | null>(null);
  const userMarkerRef = useRef<MlMarker | null>(null);
  const riderMarkerRef = useRef<MlMarker | null>(null);
  const customerMarkerRef = useRef<MlMarker | null>(null);
  const pharmMarkersRef = useRef<MlMarker[]>([]);
  const pickMarkerRef = useRef<MlMarker | null>(null);

  const [busy, setBusy] = useState<"locate" | "pick" | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQ, setSearchQ] = useState("");
  const [searchResults, setSearchResults] = useState<AutocompletePlace[]>([]);
  const [searching, setSearching] = useState(false);
  const [locateMsg, setLocateMsg] = useState<string | null>(null);
  const [accuracyM, setAccuracyM] = useState<number | null>(null);

  const initialCenter = useMemo(() => center ?? userLocation ?? DEFAULT_CENTER, [center, userLocation]);

  /* ----- init map ----- */
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const style: string | StyleSpecification = BARIKOI_STYLE_URL ?? fallbackStyle();
    const map = new maplibregl.Map({
      container: containerRef.current,
      style,
      center: [initialCenter.lng, initialCenter.lat],
      zoom,
      attributionControl: { compact: true },
    });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "bottom-right");
    map.addControl(new maplibregl.ScaleControl({ unit: "metric" }), "bottom-left");
    mapRef.current = map;

    return () => {
      map.remove();
      mapRef.current = null;
      userMarkerRef.current = null;
      riderMarkerRef.current = null;
      customerMarkerRef.current = null;
      pharmMarkersRef.current = [];
      pickMarkerRef.current = null;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ----- center prop changes ----- */
  useEffect(() => {
    if (!mapRef.current || !center) return;
    mapRef.current.flyTo({ center: [center.lng, center.lat], zoom: Math.max(mapRef.current.getZoom(), 13) });
  }, [center?.lat, center?.lng]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ----- user marker ----- */
  /* ----- user marker ----- */
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (!userLocation) {
      userMarkerRef.current?.remove();
      userMarkerRef.current = null;
      return;
    }
    const allowDrag = (draggablePin ?? !!onPick) && pickEnabled;
    if (!userMarkerRef.current) {
      const marker = new maplibregl.Marker({
        element: makeUserDot(userLabel),
        draggable: allowDrag,
      })
        .setLngLat([userLocation.lng, userLocation.lat])
        .addTo(map);

      if (allowDrag && onPick) {
        // Visual feedback while dragging
        marker.on("drag", () => {
          marker.getElement().classList.add("medi-marker-dragging");
        });
        marker.on("dragend", async () => {
          marker.getElement().classList.remove("medi-marker-dragging");
          const { lng, lat } = marker.getLngLat();
          // User has explicitly placed the pin — drop the accuracy circle
          // and the locate toast since the GPS estimate is now overridden.
          setAccuracyM(null);
          setLocateMsg(null);
          try {
            setBusy("pick");
            const raw = await geoApi.reverse(lat, lng);
            const address = friendlyLocationLabel(raw, "নির্বাচিত অবস্থান");
            onPick({ lat, lng, address, raw });
          } catch {
            onPick({
              lat,
              lng,
              address: "নির্বাচিত অবস্থান",
              raw: { address: null, country: "Bangladesh", lat, lng, source: "fallback" },
            });
          } finally {
            setBusy(null);
          }
        });
      }
      userMarkerRef.current = marker;
    } else {
      userMarkerRef.current.setLngLat([userLocation.lng, userLocation.lat]);
      userMarkerRef.current.setDraggable(allowDrag);
    }
  }, [userLocation?.lat, userLocation?.lng, userLabel, draggablePin, pickEnabled, onPick]); // eslint-disable-line

  /* ----- accuracy circle (around user marker) ----- */
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const SRC = "medi-accuracy";
    const LYR_FILL = "medi-accuracy-fill";
    const LYR_LINE = "medi-accuracy-line";

    const apply = () => {
      const haveData = !!(userLocation && accuracyM != null && accuracyM > 0);
      if (!haveData) {
        if (map.getLayer(LYR_LINE)) map.removeLayer(LYR_LINE);
        if (map.getLayer(LYR_FILL)) map.removeLayer(LYR_FILL);
        if (map.getSource(SRC)) map.removeSource(SRC);
        return;
      }
      // Build a 64-point polygon in metres around (lat,lng).
      const lat = userLocation!.lat;
      const lng = userLocation!.lng;
      const r = accuracyM!;
      const earth = 6378137;
      const dLat = (r / earth) * (180 / Math.PI);
      const dLng = (r / (earth * Math.cos((lat * Math.PI) / 180))) * (180 / Math.PI);
      const ring: [number, number][] = [];
      const steps = 64;
      for (let i = 0; i <= steps; i++) {
        const t = (i / steps) * Math.PI * 2;
        ring.push([lng + dLng * Math.cos(t), lat + dLat * Math.sin(t)]);
      }
      const data = {
        type: "Feature" as const,
        geometry: { type: "Polygon" as const, coordinates: [ring] },
        properties: {},
      };
      const src = map.getSource(SRC) as maplibregl.GeoJSONSource | undefined;
      if (src) {
        src.setData(data as GeoJSON.Feature);
      } else {
        map.addSource(SRC, { type: "geojson", data: data as GeoJSON.Feature });
        map.addLayer({
          id: LYR_FILL,
          type: "fill",
          source: SRC,
          paint: { "fill-color": "#3b82f6", "fill-opacity": 0.15 },
        });
        map.addLayer({
          id: LYR_LINE,
          type: "line",
          source: SRC,
          paint: { "line-color": "#3b82f6", "line-width": 1.2, "line-opacity": 0.6 },
        });
      }
    };

    if (map.isStyleLoaded()) apply();
    else map.once("load", apply);
  }, [userLocation?.lat, userLocation?.lng, accuracyM]); // eslint-disable-line

  /* ----- rider marker ----- */
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (!riderLocation) {
      riderMarkerRef.current?.remove();
      riderMarkerRef.current = null;
      return;
    }
    if (!riderMarkerRef.current) {
      riderMarkerRef.current = new maplibregl.Marker({ element: makeRiderDot(riderLabel) })
        .setLngLat([riderLocation.lng, riderLocation.lat])
        .addTo(map);
    } else {
      riderMarkerRef.current.setLngLat([riderLocation.lng, riderLocation.lat]);
    }
  }, [riderLocation?.lat, riderLocation?.lng, riderLabel]); // eslint-disable-line

  /* ----- customer/drop marker ----- */
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (!customerLocation) {
      customerMarkerRef.current?.remove();
      customerMarkerRef.current = null;
      return;
    }
    const element = makeCustomerDot(customerLabel, customerAvatarUrl, customerFallbackImageUrl || undefined);
    if (!customerMarkerRef.current) {
      customerMarkerRef.current = new maplibregl.Marker({ element })
        .setLngLat([customerLocation.lng, customerLocation.lat])
        .addTo(map);
    } else {
      const old = customerMarkerRef.current;
      old.remove();
      customerMarkerRef.current = new maplibregl.Marker({ element })
        .setLngLat([customerLocation.lng, customerLocation.lat])
        .addTo(map);
    }
  }, [customerLocation?.lat, customerLocation?.lng, customerLabel, customerAvatarUrl, customerFallbackImageUrl]); // eslint-disable-line

  /* ----- pharmacy markers ----- */
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    pharmMarkersRef.current.forEach((m) => m.remove());
    pharmMarkersRef.current = [];
    for (const p of pharmacies) {
      if (p.lat == null || p.lng == null) continue;
      const popup = new maplibregl.Popup({ offset: 22, closeButton: false }).setHTML(`
        <div class="medi-popup">
          <div class="medi-popup-title">${escapeHtml(p.name)}</div>
          ${p.business_name ? `<div class="medi-popup-sub">${escapeHtml(p.business_name)}</div>` : ""}
          <div class="medi-popup-row">
            <span>★ ${p.rating.toFixed(1)} (${p.rating_count})</span>
            <span class="medi-popup-status ${p.is_open ? "open" : "closed"}">
              ${p.is_open ? "Open now" : "Closed"}
            </span>
          </div>
          ${p.address ? `<div class="medi-popup-addr">${escapeHtml(p.address)}</div>` : ""}
          <button class="medi-popup-cta" data-pid="${p.id}">Visit shop →</button>
        </div>
      `);
      popup.on("open", () => {
        const el = popup.getElement().querySelector<HTMLButtonElement>(".medi-popup-cta");
        if (!el) return;
        el.onclick = (e) => {
          e.preventDefault();
          if (onPharmacyClick) onPharmacyClick(p);
          else window.location.href = `/store/${p.id}`;
        };
      });
      const marker = new maplibregl.Marker({ element: makePharmDot(p) })
        .setLngLat([p.lng, p.lat])
        .setPopup(popup)
        .addTo(map);
      pharmMarkersRef.current.push(marker);
    }
  }, [pharmacies, onPharmacyClick]);

  /* ----- route polyline ----- */
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const apply = () => {
      const sourceId = "medi-route";
      const layerId = "medi-route-line";
      if (map.getLayer(layerId)) map.removeLayer(layerId);
      if (map.getSource(sourceId)) map.removeSource(sourceId);
      if (!routePolyline) return;
      const geo = polylineToGeoJSON(routePolyline);
      map.addSource(sourceId, { type: "geojson", data: geo });
      map.addLayer({
        id: layerId,
        type: "line",
        source: sourceId,
        layout: { "line-join": "round", "line-cap": "round" },
        paint: { "line-color": "#06ad65", "line-width": 5, "line-opacity": 0.85 },
      });
      // Fit bounds
      const coords = (geo.geometry.coordinates as Array<[number, number]>);
      if (coords.length >= 2) {
        const bounds = coords.reduce(
          (b, c) => b.extend(c as [number, number]),
          new maplibregl.LngLatBounds(coords[0], coords[0]),
        );
        map.fitBounds(bounds, { padding: 60, maxZoom: 15, duration: 700 });
      }
    };
    if (map.isStyleLoaded()) apply();
    else map.once("load", apply);
  }, [routePolyline]);

  /* ----- click pick ----- */
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !pickEnabled || !onPick) return;
    const handler = async (e: maplibregl.MapMouseEvent) => {
      const { lat, lng } = e.lngLat;
      try {
        setBusy("pick");
        const raw = await geoApi.reverse(lat, lng);
        const address = friendlyLocationLabel(raw, "নির্বাচিত অবস্থান");
        // Drop a transient marker
        if (pickMarkerRef.current) pickMarkerRef.current.remove();
        pickMarkerRef.current = new maplibregl.Marker({ color: "#06ad65" })
          .setLngLat([lng, lat])
          .addTo(map);
        onPick({ lat, lng, address, raw });
      } catch {
        /* swallow — UI already shows old data */
      } finally {
        setBusy(null);
      }
    };
    map.on("click", handler);
    return () => {
      map.off("click", handler);
    };
  }, [pickEnabled, onPick]);

  /* ----- locate me ----- */
  const handleLocate = useCallback(async () => {
    if (!mapRef.current) return;
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      setLocateMsg(locationErrorMessage());
      return;
    }
    setBusy("locate");
    setLocateMsg("📡 GPS signal নিচ্ছি…");
    try {
      const fix = await getPreciseLocation({
        desiredAccuracyM: 25,
        bestEffortAfterMs: 12_000,
        timeoutMs: 22_000,
        onProgress: (p) => {
          setAccuracyM(p.accuracy);
          setLocateMsg(
            p.accuracy <= 25
              ? `🎯 Pin-point ±${Math.round(p.accuracy)} m`
              : `📡 Refining… ±${Math.round(p.accuracy)} m`,
          );
        },
      });
      setAccuracyM(fix.accuracy);
      mapRef.current.flyTo({
        center: [fix.lng, fix.lat],
        // tighter zoom when GPS is accurate, looser when only network fix is available.
        zoom: fix.accuracy <= 25 ? 17 : fix.accuracy <= 100 ? 16 : 14,
        speed: 1.4,
      });
      if (onPick) {
        try {
          const raw = await geoApi.reverse(fix.lat, fix.lng);
          const address = friendlyLocationLabel(raw, "নির্বাচিত অবস্থান");
          onPick({ lat: fix.lat, lng: fix.lng, address, raw });
        } catch {
          /* reverse-geocode optional */
        }
      }
      setLocateMsg(`🎯 ±${Math.round(fix.accuracy)} m${fix.source === "gps" ? " (GPS)" : " (Wi-Fi)"}`);
      // Hide the toast after a few seconds.
      window.setTimeout(() => setLocateMsg(null), 4000);
    } catch (err) {
      setLocateMsg(locationErrorMessage(err));
      window.setTimeout(() => setLocateMsg(null), 7000);
    } finally {
      setBusy(null);
    }
  }, [onPick]);

  /* ----- search ----- */
  useEffect(() => {
    if (!searchQ || searchQ.trim().length < 2) {
      setSearchResults([]);
      return;
    }
    const id = setTimeout(async () => {
      try {
        setSearching(true);
        const res = await geoApi.autocomplete(searchQ, { city: searchCity, limit: 8 });
        setSearchResults(res);
      } catch {
        setSearchResults([]);
      } finally {
        setSearching(false);
      }
    }, 250);
    return () => clearTimeout(id);
  }, [searchQ, searchCity]);

  const pickResult = useCallback(
    async (p: AutocompletePlace) => {
      if (!mapRef.current || p.lat == null || p.lng == null) return;
      mapRef.current.flyTo({ center: [p.lng, p.lat], zoom: 16 });
      if (onPick) {
        const raw: ReverseAddress = {
          address: p.address,
          area: p.area ?? null,
          city: p.city ?? null,
          country: "Bangladesh",
          lat: p.lat,
          lng: p.lng,
          source: "barikoi",
        };
        if (pickMarkerRef.current) pickMarkerRef.current.remove();
        pickMarkerRef.current = new maplibregl.Marker({ color: "#06ad65" })
          .setLngLat([p.lng, p.lat])
          .addTo(mapRef.current);
        onPick({ lat: p.lat, lng: p.lng, address: p.address, raw });
      }
      setSearchOpen(false);
      setSearchQ("");
      setSearchResults([]);
    },
    [onPick],
  );

  return (
    <div className={`medi-map-wrap ${className ?? ""}`} style={{ height }}>
      <div ref={containerRef} className="medi-map-canvas" />

      {/* Search ---------------------------------------------------- */}
      {showSearch && (
        <div className={`medi-map-search ${searchOpen ? "open" : ""}`}>
          {!searchOpen ? (
            <button
              type="button"
              className="medi-map-fab"
              onClick={() => setSearchOpen(true)}
              aria-label="লোকেশন search"
              title="লোকেশন search"
            >
              <Search size={16} />
            </button>
          ) : (
            <div className="medi-search-box">
              <Search size={14} />
              <input
                autoFocus
                value={searchQ}
                onChange={(e) => setSearchQ(e.target.value)}
                placeholder="ঠিকানা খুঁজুন (e.g. Banani, Mirpur)…"
              />
              <button
                type="button"
                onClick={() => {
                  setSearchOpen(false);
                  setSearchQ("");
                }}
                aria-label="Close search"
              >
                <X size={14} />
              </button>
            </div>
          )}

          {searchOpen && (searching || searchResults.length > 0) && (
            <ul className="medi-search-results">
              {searching && (
                <li className="loading">
                  <Loader2 size={12} className="animate-spin" /> Searching…
                </li>
              )}
              {!searching &&
                searchResults.map((r, i) => (
                  <li key={`${r.id ?? i}`} onClick={() => pickResult(r)}>
                    <MapPin size={12} />
                    <div>
                      <div className="ttl">{r.address}</div>
                      <div className="sub">
                        {[r.sub_area, r.area, r.city].filter(Boolean).join(" · ")}
                      </div>
                    </div>
                  </li>
                ))}
            </ul>
          )}
        </div>
      )}

      {/* Locate-me FAB --------------------------------------------- */}
      {showLocateButton && (
        <button
          type="button"
          onClick={handleLocate}
          className="medi-map-fab medi-locate-fab"
          aria-label="আমার লোকেশন"
          title="আমার লোকেশন"
          disabled={busy === "locate"}
        >
          {busy === "locate" ? <Loader2 size={16} className="animate-spin" /> : <Navigation size={16} />}
        </button>
      )}

      {busy === "pick" && (
        <div className="medi-map-toast">
          <Loader2 size={12} className="animate-spin" /> ঠিকানা বের করা হচ্ছে…
        </div>
      )}

      {locateMsg && (
        <div className="medi-map-toast medi-locate-toast">
          {busy === "locate" && <Loader2 size={12} className="animate-spin" />}
          <span>{locateMsg}</span>
        </div>
      )}

      <style jsx global>{`
        .medi-map-wrap {
          position: relative;
          width: 100%;
          border-radius: 1.5rem;
          overflow: hidden;
          isolation: isolate;
        }
        .medi-map-canvas {
          position: absolute;
          inset: 0;
        }
        .maplibregl-popup-content {
          padding: 12px 14px;
          border-radius: 14px;
          font-family: inherit;
          background: rgba(255, 255, 255, 0.97);
          color: #0f172a;
          box-shadow: 0 18px 38px -12px rgba(15, 23, 42, 0.28);
        }
        :is(.dark) .maplibregl-popup-content {
          background: rgba(15, 23, 42, 0.95);
          color: #e2e8f0;
        }
        .medi-popup-title { font-weight: 600; font-size: 14px; }
        .medi-popup-sub { font-size: 11px; opacity: 0.75; margin-top: 1px; }
        .medi-popup-row {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 10px;
          margin-top: 6px;
          font-size: 11px;
        }
        .medi-popup-status.open { color: #059669; font-weight: 600; }
        .medi-popup-status.closed { color: #f43f5e; font-weight: 600; }
        .medi-popup-addr {
          font-size: 11px;
          opacity: 0.8;
          margin-top: 4px;
          line-height: 1.35;
        }
        .medi-popup-cta {
          margin-top: 8px;
          width: 100%;
          padding: 6px 10px;
          background: #06ad65;
          color: white;
          border: 0;
          border-radius: 999px;
          font-size: 12px;
          font-weight: 600;
          cursor: pointer;
        }
        .medi-popup-cta:hover { background: #058a51; }

        .medi-marker { cursor: pointer; }
        .medi-marker-user {
          position: relative;
          width: 18px;
          height: 18px;
        }
        .maplibregl-marker.maplibregl-marker-draggable .medi-marker-user {
          cursor: grab;
        }
        .medi-marker-user.medi-marker-dragging .medi-marker-pulse { animation: none; }
        .medi-marker-user.medi-marker-dragging .medi-marker-dot {
          transform: scale(1.4);
          box-shadow: 0 0 0 2px rgba(37, 99, 235, 0.6), 0 6px 18px -4px rgba(37, 99, 235, 0.5);
          transition: transform 0.12s ease;
        }
        .medi-marker-dot {
          position: absolute;
          inset: 3px;
          border-radius: 999px;
          background: #2563eb;
          border: 2px solid white;
          box-shadow: 0 0 0 1px rgba(37, 99, 235, 0.4);
        }
        .medi-marker-pulse {
          position: absolute;
          inset: -6px;
          border-radius: 999px;
          background: rgba(37, 99, 235, 0.25);
          animation: mediPulse 2s ease-out infinite;
        }
        @keyframes mediPulse {
          0% { transform: scale(0.6); opacity: 0.7; }
          100% { transform: scale(1.6); opacity: 0; }
        }

        .medi-pharm-pin {
          position: relative;
          width: 42px;
          height: 42px;
          border-radius: 999px;
          display: grid;
          place-items: center;
          overflow: hidden;
          color: white;
          background: #ecfdf5;
          border: 3px solid white;
          box-shadow: 0 10px 22px -8px rgba(6, 173, 101, 0.65), 0 0 0 3px rgba(6, 173, 101, 0.2);
        }
        .medi-pharm-pin::after {
          content: "";
          position: absolute;
          left: 50%;
          bottom: -7px;
          width: 13px;
          height: 13px;
          transform: translateX(-50%) rotate(45deg);
          background: inherit;
          border-right: 3px solid white;
          border-bottom: 3px solid white;
          box-shadow: 4px 4px 10px -8px rgba(15, 23, 42, 0.8);
          z-index: -1;
        }
        .medi-pharm-pin img {
          width: 100%;
          height: 100%;
          object-fit: contain;
          background: white;
        }
        .medi-pharm-pin span {
          position: absolute;
          display: none;
          font-size: 13px;
          font-weight: 900;
          color: #047857;
        }
        .medi-pharm-pin img[src=""] + span { display: block; }
        .medi-pharm-pin.closed { box-shadow: 0 10px 22px -8px rgba(100, 116, 139, 0.55), 0 0 0 3px rgba(100, 116, 139, 0.22); filter: grayscale(0.25); }

        .medi-marker-customer {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 4px;
        }
        .medi-customer-pin {
          width: 42px;
          height: 42px;
          border-radius: 999px;
          display: grid;
          place-items: center;
          overflow: hidden;
          background: white;
          border: 3px solid white;
          box-shadow: 0 10px 22px -8px rgba(37, 99, 235, 0.7), 0 0 0 3px rgba(37, 99, 235, 0.22);
        }
        .medi-customer-pin img {
          width: 100%;
          height: 100%;
          object-fit: cover;
          background: white;
        }
        .medi-marker-label {
          max-width: 92px;
          border-radius: 999px;
          padding: 3px 8px;
          background: rgba(15, 23, 42, 0.88);
          color: white;
          font-size: 10px;
          font-weight: 800;
          line-height: 1.1;
          text-align: center;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          box-shadow: 0 8px 18px -10px rgba(15, 23, 42, 0.6);
        }
        .medi-marker-label.customer { background: rgba(37, 99, 235, 0.92); }

        .medi-rider-pin {
          width: 38px;
          height: 38px;
          border-radius: 999px;
          background: white;
          border: 2px solid white;
          color: #f97316;
          display: grid;
          place-items: center;
          box-shadow: 0 10px 22px -8px rgba(249, 115, 22, 0.75), 0 0 0 4px rgba(249, 115, 22, 0.18);
          animation: mediBob 1.6s ease-in-out infinite;
        }
        .medi-rider-pin img {
          width: 30px;
          height: 30px;
          object-fit: contain;
        }
        @keyframes mediBob {
          0%, 100% { transform: translateY(0); }
          50% { transform: translateY(-3px); }
        }

        .medi-map-fab {
          width: 38px;
          height: 38px;
          border-radius: 999px;
          background: white;
          color: #0f172a;
          border: 1px solid rgba(15, 23, 42, 0.08);
          box-shadow: 0 8px 20px -8px rgba(15, 23, 42, 0.25);
          display: grid;
          place-items: center;
          cursor: pointer;
          transition: transform 120ms;
        }
        .medi-map-fab:hover { transform: translateY(-1px); }
        :is(.dark) .medi-map-fab {
          background: rgba(15, 23, 42, 0.92);
          color: #e2e8f0;
          border-color: rgba(255, 255, 255, 0.1);
        }
        .medi-locate-fab {
          position: absolute;
          top: 12px;
          right: 12px;
          z-index: 5;
        }
        .medi-map-search {
          position: absolute;
          top: 12px;
          left: 12px;
          z-index: 5;
          width: min(320px, calc(100% - 64px));
        }
        .medi-search-box {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 8px 12px;
          background: white;
          border-radius: 999px;
          box-shadow: 0 8px 20px -8px rgba(15, 23, 42, 0.25);
          border: 1px solid rgba(15, 23, 42, 0.08);
        }
        :is(.dark) .medi-search-box {
          background: rgba(15, 23, 42, 0.92);
          border-color: rgba(255, 255, 255, 0.1);
          color: #e2e8f0;
        }
        .medi-search-box input {
          flex: 1;
          border: 0;
          background: transparent;
          outline: none;
          font-size: 13px;
          color: inherit;
        }
        .medi-search-box button {
          background: transparent;
          border: 0;
          color: inherit;
          opacity: 0.6;
          cursor: pointer;
        }
        .medi-search-results {
          margin: 6px 0 0;
          padding: 6px;
          background: white;
          border-radius: 14px;
          box-shadow: 0 14px 30px -10px rgba(15, 23, 42, 0.25);
          list-style: none;
          max-height: 280px;
          overflow-y: auto;
          border: 1px solid rgba(15, 23, 42, 0.08);
        }
        :is(.dark) .medi-search-results {
          background: rgba(15, 23, 42, 0.95);
          color: #e2e8f0;
          border-color: rgba(255, 255, 255, 0.1);
        }
        .medi-search-results li {
          display: flex;
          align-items: flex-start;
          gap: 8px;
          padding: 8px 10px;
          border-radius: 10px;
          cursor: pointer;
          font-size: 12px;
        }
        .medi-search-results li:hover { background: rgba(6, 173, 101, 0.08); }
        .medi-search-results li.loading {
          color: rgba(15, 23, 42, 0.5);
          cursor: default;
        }
        :is(.dark) .medi-search-results li.loading { color: rgba(226, 232, 240, 0.5); }
        .medi-search-results .ttl { font-weight: 600; line-height: 1.3; }
        .medi-search-results .sub { opacity: 0.7; font-size: 11px; margin-top: 2px; }
        .medi-search-results svg { margin-top: 3px; flex-shrink: 0; color: #06ad65; }

        .medi-map-toast {
          position: absolute;
          bottom: 12px;
          left: 50%;
          transform: translateX(-50%);
          background: rgba(15, 23, 42, 0.85);
          color: white;
          padding: 6px 14px;
          font-size: 11px;
          line-height: 1.35;
          border-radius: 18px;
          display: flex;
          align-items: flex-start;
          gap: 6px;
          z-index: 5;
          white-space: normal;
          text-align: left;
          max-width: min(420px, calc(100% - 24px));
        }
        .medi-map-toast span { min-width: 0; }
        .medi-locate-toast {
          bottom: 48px;
          background: rgba(6, 173, 101, 0.95);
          font-weight: 600;
          box-shadow: 0 8px 18px -8px rgba(6, 173, 101, 0.6);
        }
      `}</style>
    </div>
  );
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string),
  );
}

export default MediMap;
