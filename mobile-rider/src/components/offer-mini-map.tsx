"use client";

/**
 * OfferMiniMap — compact MapLibre + Barikoi map embedded inside a rider
 * offer / active-delivery card. Mirrors `DeliveryMiniMap` from the website
 * (frontend/src/components/rider-profile.tsx) so mobile riders get the
 * same at-a-glance pickup → drop visualisation.
 *
 *  • Pickup pin (P, emerald) and Drop pin (D, rose).
 *  • Rider live location dot (when available).
 *  • Optional polyline (rider → pickup before pickup; pickup → drop after).
 *  • Falls back to plain OSM raster tiles when no Barikoi key is set so
 *    development without the key still shows a usable map.
 */
import { useEffect, useRef, useState } from "react";
import maplibregl, { type StyleSpecification } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { BARIKOI_STYLE_URL, geoApi, polylineToGeoJSON } from "@/lib/geo";

type LngLat = { lat: number; lng: number };

export type OfferMiniMapProps = {
  rider: LngLat | null;
  pickup: LngLat | null;
  drop: LngLat | null;
  /** "offer" → rider→pickup leg, "active" → pickup→drop leg. */
  mode?: "offer" | "active";
  /** Heading text shown above the map (e.g. "Pickup route"). */
  title?: string;
  /** Pixel height of the map canvas. Default 176 (h-44). */
  heightClass?: string;
};

function fallbackStyle(): StyleSpecification {
  return {
    version: 8,
    sources: {
      osm: {
        type: "raster",
        tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
        tileSize: 256,
        attribution: "© OpenStreetMap",
      },
    },
    layers: [{ id: "osm", type: "raster", source: "osm" }],
  };
}

function dot(color: string, size = 14, ring = "white"): HTMLElement {
  const el = document.createElement("div");
  el.style.cssText = `
    width:${size}px;height:${size}px;border-radius:50%;
    background:${color};border:2px solid ${ring};
    box-shadow:0 0 0 4px ${color}33,0 1px 4px rgba(0,0,0,.25);`;
  return el;
}

function pinLabel(letter: "P" | "D", color: string): HTMLElement {
  const el = document.createElement("div");
  el.style.cssText = `
    display:grid;place-items:center;width:22px;height:22px;border-radius:50%;
    background:${color};color:white;font-weight:700;font-size:11px;
    border:2px solid white;box-shadow:0 1px 3px rgba(0,0,0,.3);`;
  el.textContent = letter;
  return el;
}

export function OfferMiniMap({
  rider, pickup, drop, mode = "offer", title = "Pickup route",
  heightClass = "h-44",
}: OfferMiniMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const markersRef = useRef<maplibregl.Marker[]>([]);
  const [route, setRoute] = useState<string | null>(null);

  // Compute the relevant leg.
  useEffect(() => {
    let cancelled = false;
    setRoute(null);
    const from = mode === "offer" ? rider ?? pickup : pickup;
    const to = mode === "offer" ? pickup : drop;
    if (!from || !to) return;
    geoApi.route(from, to)
      .then((r) => { if (!cancelled && r?.geometry) setRoute(r.geometry); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [mode, rider?.lat, rider?.lng, pickup?.lat, pickup?.lng, drop?.lat, drop?.lng]);

  // Init the map once.
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const center = rider ?? pickup ?? drop ?? { lat: 23.7937, lng: 90.4066 };
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: BARIKOI_STYLE_URL ?? fallbackStyle(),
      center: [center.lng, center.lat],
      zoom: 13,
      attributionControl: { compact: true },
      interactive: true,
    });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
    mapRef.current = map;
    return () => { map.remove(); mapRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Place / refresh markers + fit bounds whenever points change.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    markersRef.current.forEach((m) => m.remove());
    markersRef.current = [];

    const pts: Array<[number, number]> = [];
    if (rider) {
      const m = new maplibregl.Marker({ element: dot("#2563eb"), anchor: "center" })
        .setLngLat([rider.lng, rider.lat]).addTo(map);
      markersRef.current.push(m);
      pts.push([rider.lng, rider.lat]);
    }
    if (pickup) {
      const m = new maplibregl.Marker({ element: pinLabel("P", "#10b981"), anchor: "bottom" })
        .setLngLat([pickup.lng, pickup.lat]).addTo(map);
      markersRef.current.push(m);
      pts.push([pickup.lng, pickup.lat]);
    }
    if (drop) {
      const m = new maplibregl.Marker({ element: pinLabel("D", "#f43f5e"), anchor: "bottom" })
        .setLngLat([drop.lng, drop.lat]).addTo(map);
      markersRef.current.push(m);
      pts.push([drop.lng, drop.lat]);
    }
    if (pts.length >= 2) {
      const lngs = pts.map((p) => p[0]);
      const lats = pts.map((p) => p[1]);
      const bounds: [[number, number], [number, number]] = [
        [Math.min(...lngs), Math.min(...lats)],
        [Math.max(...lngs), Math.max(...lats)],
      ];
      map.fitBounds(bounds, { padding: 40, duration: 500, maxZoom: 15 });
    } else if (pts.length === 1) {
      map.easeTo({ center: pts[0] as [number, number], zoom: 14 });
    }
  }, [rider?.lat, rider?.lng, pickup?.lat, pickup?.lng, drop?.lat, drop?.lng]);

  // Draw / update the route polyline.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const SRC = "trip-route";
    const draw = () => {
      if (!route) {
        if (map.getLayer(SRC)) map.removeLayer(SRC);
        if (map.getSource(SRC)) map.removeSource(SRC);
        return;
      }
      const geo = polylineToGeoJSON(route);
      const src = map.getSource(SRC) as maplibregl.GeoJSONSource | undefined;
      if (src) {
        src.setData(geo);
      } else {
        map.addSource(SRC, { type: "geojson", data: geo });
        map.addLayer({
          id: SRC,
          type: "line",
          source: SRC,
          layout: { "line-cap": "round", "line-join": "round" },
          paint: { "line-color": "#ef4444", "line-width": 4, "line-opacity": 0.85 },
        });
      }
    };
    if (map.isStyleLoaded()) draw();
    else map.once("load", draw);
  }, [route]);

  return (
    <div className="mt-3 overflow-hidden rounded-2xl border border-black/5 bg-white/70 dark:border-white/10 dark:bg-white/5">
      <div className="flex items-center justify-between gap-2 px-3 py-1.5 text-[11px]">
        <span className="font-bold text-slate-800 dark:text-slate-100">📍 {title}</span>
        <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 font-semibold text-emerald-700 dark:text-emerald-300">
          {mode === "offer" ? "Offer map" : "Live route"}
        </span>
      </div>
      <div ref={containerRef} className={`${heightClass} w-full`} />
    </div>
  );
}
