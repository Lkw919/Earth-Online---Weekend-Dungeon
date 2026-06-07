import { useEffect, useRef, useState } from "react";
import AMapLoader from "@amap/amap-jsapi-loader";

type RouteMapProps = {
  origin?: string;
  places: Array<{ name: string; location?: string }>;
  height?: number;
};

const AMAP_KEY = (import.meta.env.VITE_AMAP_JS_KEY as string | undefined)?.trim() || "";

function parseLngLat(loc: string | undefined): [number, number] | null {
  if (!loc || !loc.includes(",")) return null;
  const parts = loc.split(",").map(Number);
  if (parts.length < 2 || !Number.isFinite(parts[0]) || !Number.isFinite(parts[1])) return null;
  return [parts[0], parts[1]];
}

export function RouteMap({ origin, places, height = 220 }: RouteMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<any>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(false);

  const validPlaces = places.filter((p) => parseLngLat(p.location));
  const originCoord = parseLngLat(origin);
  const hasData = validPlaces.length > 0 || originCoord;

  useEffect(() => {
    if (!containerRef.current || !hasData) return;
    if (!AMAP_KEY) {
      setError(true);
      return;
    }

    let destroyed = false;

    AMapLoader.load({
      key: AMAP_KEY,
      version: "2.0",
    })
      .then((AMap: any) => {
        if (destroyed) return;

        const map = new AMap.Map(containerRef.current, {
          viewMode: "2D",
          zoom: 14,
          resizeEnable: true,
        });
        mapRef.current = map;

        const markers: any[] = [];

        if (originCoord) {
          const originMarker = new AMap.Marker({
            position: new AMap.LngLat(originCoord[0], originCoord[1]),
            content: `<div style="position:relative">
              <div style="width:32px;height:32px;border-radius:50%;background:rgba(107,99,246,0.22);
                position:absolute;left:-10px;top:-10px;animation:agentPulse 2s ease-in-out infinite"></div>
              <div style="width:12px;height:12px;border-radius:50%;background:#6B63F6;border:2px solid white;
                box-shadow:0 0 0 2px rgba(107,99,246,0.35)"></div>
              <div style="position:absolute;top:-22px;left:16px;white-space:nowrap;background:white;
                border-radius:8px;padding:2px 8px;font-size:11px;font-weight:700;color:#6B63F6;
                box-shadow:0 2px 6px rgba(123,110,246,0.18)">我的位置</div>
            </div>`,
            offset: new AMap.Pixel(-6, -6),
            anchor: "center",
          });
          markers.push(originMarker);
        }

        const pathPoints: any[] = [];
        validPlaces.forEach((place, idx) => {
          const coord = parseLngLat(place.location)!;
          pathPoints.push(new AMap.LngLat(coord[0], coord[1]));
          const marker = new AMap.Marker({
            position: new AMap.LngLat(coord[0], coord[1]),
            content: `<div style="display:flex;flex-direction:column;align-items:center">
              <div style="width:24px;height:24px;border-radius:50%;background:#7B6EF6;display:flex;
                align-items:center;justify-content:center;border:2px solid white;
                box-shadow:0 4px 10px rgba(123,110,246,0.45)">
                <span style="color:white;font-size:12px;font-weight:700">${idx + 1}</span>
              </div>
              <div style="margin-top:4px;white-space:nowrap;background:white;border-radius:8px;
                padding:2px 8px;font-size:10px;font-weight:600;color:#5E5B8C;
                box-shadow:0 2px 6px rgba(123,110,246,0.18);max-width:100px;overflow:hidden;
                text-overflow:ellipsis">${place.name}</div>
            </div>`,
            offset: new AMap.Pixel(-12, -12),
            anchor: "center",
          });
          markers.push(marker);
        });

        map.add(markers);

        if (pathPoints.length > 1) {
          const polyline = new AMap.Polyline({
            path: pathPoints,
            strokeColor: "#6B63F6",
            strokeWeight: 3,
            strokeStyle: "dashed",
            strokeDasharray: [6, 6],
            lineJoin: "round",
          });
          map.add(polyline);
        } else if (originCoord && pathPoints.length === 1) {
          const lineFromOrigin = new AMap.Polyline({
            path: [new AMap.LngLat(originCoord[0], originCoord[1]), pathPoints[0]],
            strokeColor: "#6B63F6",
            strokeWeight: 3,
            strokeStyle: "dashed",
            strokeDasharray: [6, 6],
          });
          map.add(lineFromOrigin);
        }

        if (markers.length > 0) {
          map.setFitView(markers, false, [40, 40, 40, 40]);
        }

        setLoaded(true);
      })
      .catch((err: any) => {
        console.error("地图加载失败:", err);
        setError(true);
      });

    return () => {
      destroyed = true;
      if (mapRef.current) {
        mapRef.current.destroy();
        mapRef.current = null;
      }
    };
  }, [origin, places, hasData]);

  if (!hasData) {
    return (
      <div
        style={{
          height,
          background: "linear-gradient(135deg, #F3F0FF 0%, #E8E4FF 100%)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          borderRadius: "0 0 16px 16px",
        }}
      >
        <p style={{ fontSize: 13, color: "#8A8FA8" }}>地图数据不可用</p>
      </div>
    );
  }

  if (error) {
    return (
      <div
        style={{
          height,
          background: "linear-gradient(135deg, #F3F0FF 0%, #E8E4FF 100%)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          borderRadius: "0 0 16px 16px",
        }}
      >
        <p style={{ fontSize: 13, color: "#8A8FA8" }}>地图加载失败</p>
      </div>
    );
  }

  return (
    <div style={{ position: "relative", height }}>
      <div ref={containerRef} style={{ width: "100%", height: "100%" }} />
      {!loaded && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            background: "linear-gradient(135deg, #F3F0FF 0%, #E8E4FF 100%)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <p style={{ fontSize: 13, color: "#8A8FA8" }}>地图加载中...</p>
        </div>
      )}
    </div>
  );
}
