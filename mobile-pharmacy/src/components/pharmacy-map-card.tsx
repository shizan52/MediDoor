"use client";

/**
 * Lightweight maplibre map card for the pharmacy mobile app.
 *
 * Shows the pharmacy's location as a brand-coloured pin and an approximate
 * delivery radius circle (3km default — matches the storefront's
 * `/api/storefront/nearby?radius_km=5` discovery radius).
 *
 * Intentionally simpler than the website's <MediMap>:
 *   - no Barikoi POI sprite (we use OSM raster tiles to avoid the
 *     "office_11" missing-layer console errors and to keep the bundle small)
 *   - no rider tracking, no location picker, no search bar
 *   - read-only — tap "Edit on profile" to update lat/lng
 *
 * If lat/lng are not set, we render a placeholder card prompting the user
 * to use the "Locate me" button on the edit screen.
 */
import { useEffect, useRef } from "react";
import Link from "next/link";
import { MapPin, Navigation } from "lucide-react";
import maplibregl, { type Map as MlMap } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";

const OSM_RASTER_STYLE: maplibregl.StyleSpecification = {
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
};

export function PharmacyMapCard({
  lat,
  lng,
  pharmacyName,
  radiusKm = 3,
  height = 220,
}: {
  lat: number | null | undefined;
  lng: number | null | undefined;
  pharmacyName: string;
  radiusKm?: number;
  height?: number;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MlMap | null>(null);

  useEffect(() => {
    if (!containerRef.current || lat == null || lng == null) return;
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: OSM_RASTER_STYLE,
      center: [lng, lat],
      zoom: 13,
      attributionControl: { compact: true },
      interactive: true,
    });
    mapRef.current = map;

    map.on("load", () => {
      // Delivery radius circle (approx — uses a GeoJSON polygon
      // generated client-side; good enough for a small preview).
      const circle = circlePolygon([lng, lat], radiusKm);
      map.addSource("radius", { type: "geojson", data: circle });
      map.addLayer({
        id: "radius-fill",
        type: "fill",
        source: "radius",
        paint: { "fill-color": "#06ad65", "fill-opacity": 0.12 },
      });
      map.addLayer({
        id: "radius-line",
        type: "line",
        source: "radius",
        paint: { "line-color": "#06ad65", "line-width": 1.5, "line-dasharray": [3, 2] },
      });
    });

    // Pharmacy pin
    const el = document.createElement("div");
    el.className = "pharmacy-pin";
    el.setAttribute(
      "style",
      [
        "width:30px",
        "height:30px",
        "background:#06ad65",
        "border:3px solid #fff",
        "border-radius:50% 50% 50% 0",
        "transform:rotate(-45deg)",
        "box-shadow:0 4px 10px rgba(0,0,0,.3)",
      ].join(";"),
    );
    new maplibregl.Marker({ element: el, anchor: "bottom" })
      .setLngLat([lng, lat])
      .setPopup(new maplibregl.Popup({ offset: 18 }).setText(pharmacyName))
      .addTo(map);

    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, [lat, lng, radiusKm, pharmacyName]);

  if (lat == null || lng == null) {
    return (
      <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 p-4 text-center dark:border-white/15 dark:bg-white/[0.03]">
        <MapPin className="mx-auto text-slate-400" size={22} />
        <p className="mt-2 text-sm font-semibold">Shop location set করা নেই</p>
        <p className="mt-1 text-[11px] opacity-60">
          Profile → Edit → Use current location দিয়ে সঠিক position সেট করুন।
        </p>
        <Link
          href="/profile/edit"
          className="tap mt-3 inline-flex items-center gap-1.5 rounded-full bg-brand-500 px-3 py-1.5 text-[12px] font-semibold text-white"
        >
          <Navigation size={12} /> Set location
        </Link>
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-2xl border border-slate-200 dark:border-white/10">
      <div ref={containerRef} style={{ height }} className="w-full" />
      <div className="flex items-center justify-between gap-2 border-t border-slate-100 bg-white px-3 py-2 text-[11px] dark:border-white/5 dark:bg-white/[0.04]">
        <span className="flex items-center gap-1 opacity-70">
          <span className="inline-block h-2 w-2 rounded-full bg-brand-500" />
          Delivery radius: ~{radiusKm} km
        </span>
        <Link href="/profile/edit" className="tap font-semibold text-brand-600 dark:text-brand-300">
          Edit →
        </Link>
      </div>
    </div>
  );
}

/**
 * Build an approximate circle polygon (64-segment) around a centre.
 * Latitude is converted using the standard 1° ≈ 111.32 km, longitude
 * is corrected for the cosine of the latitude. Good enough for a
 * 1-10 km preview circle.
 */
function circlePolygon(
  center: [number, number],
  radiusKm: number,
  steps = 64,
): GeoJSON.Feature<GeoJSON.Polygon> {
  const [cx, cy] = center;
  const coords: [number, number][] = [];
  const earthKmPerDeg = 111.32;
  const dLat = radiusKm / earthKmPerDeg;
  const dLng = radiusKm / (earthKmPerDeg * Math.cos((cy * Math.PI) / 180));
  for (let i = 0; i < steps; i++) {
    const angle = (i * 2 * Math.PI) / steps;
    coords.push([cx + dLng * Math.cos(angle), cy + dLat * Math.sin(angle)]);
  }
  coords.push(coords[0]);
  return {
    type: "Feature",
    properties: {},
    geometry: { type: "Polygon", coordinates: [coords] },
  };
}
