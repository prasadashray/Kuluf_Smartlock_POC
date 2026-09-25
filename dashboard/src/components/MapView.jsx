import { useEffect, useRef } from 'react';
import L from 'leaflet';

// Plain Leaflet (no react-leaflet dependency). Circle markers avoid bundling marker image assets.
export default function MapView({ locations }) {
  const el = useRef(null);
  const map = useRef(null);
  const layer = useRef(null);

  useEffect(() => {
    map.current = L.map(el.current, { zoomControl: true }).setView([22.5, 79], 4);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(map.current);
    layer.current = L.layerGroup().addTo(map.current);
    return () => map.current.remove();
  }, []);

  useEffect(() => {
    if (!layer.current) return;
    layer.current.clearLayers();
    const pts = locations.filter((l) => l.positioned && l.latitude != null).map((l) => [Number(l.latitude), Number(l.longitude)]).reverse();
    if (!pts.length) return;
    L.polyline(pts, { color: '#3b6fd8', weight: 3, opacity: 0.7 }).addTo(layer.current);
    const last = pts[pts.length - 1];
    L.circleMarker(last, { radius: 8, color: '#b3261e', fillOpacity: 0.9 }).addTo(layer.current).bindTooltip('latest');
    map.current.setView(last, Math.max(map.current.getZoom(), 15));
  }, [locations]);

  return <div ref={el} className="map" />;
}
