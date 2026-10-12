// geo.js - Funciones geográficas puras (sin DOM, fáciles de probar)
// Convención: los puntos son {lat, lng}; los anillos de polígono son [[lng, lat], ...] (GeoJSON).

const R = 6371008.8; // radio medio de la Tierra en metros
const toRad = (d) => (d * Math.PI) / 180;

/** Distancia en metros entre dos puntos {lat, lng}. */
export function haversine(a, b) {
    const dLat = toRad(b.lat - a.lat);
    const dLng = toRad(b.lng - a.lng);
    const h =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** ¿El punto está dentro del anillo? (ray casting) */
export function pointInRing(pt, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i];
        const [xj, yj] = ring[j];
        const crosses =
            yi > pt.lat !== yj > pt.lat &&
            pt.lng < ((xj - xi) * (pt.lat - yi)) / (yj - yi) + xi;
        if (crosses) inside = !inside;
    }
    return inside;
}

/** Polígono = [anilloExterior, ...huecos]. */
export function pointInPolygon(pt, rings) {
    if (!rings.length || !pointInRing(pt, rings[0])) return false;
    for (let i = 1; i < rings.length; i++) {
        if (pointInRing(pt, rings[i])) return false;
    }
    return true;
}

export function pointInPolygons(pt, polygons) {
    return polygons.some((poly) => pointInPolygon(pt, poly));
}

/** GeoJSON Polygon / MultiPolygon -> array de polígonos (cada uno es un array de anillos). */
export function geojsonToPolygons(geom) {
    if (!geom || !geom.coordinates) return [];
    if (geom.type === 'Polygon') return [geom.coordinates];
    if (geom.type === 'MultiPolygon') return geom.coordinates;
    return [];
}

/** Aproxima un círculo con un polígono de n lados. Devuelve un anillo [[lng, lat], ...]. */
export function circlePolygon(center, radiusM, n = 32) {
    const ring = [];
    const dLat = (radiusM / R) * (180 / Math.PI);
    const dLng = dLat / Math.cos(toRad(center.lat));
    for (let i = 0; i < n; i++) {
        const t = (2 * Math.PI * i) / n;
        ring.push([center.lng + dLng * Math.cos(t), center.lat + dLat * Math.sin(t)]);
    }
    ring.push(ring[0]);
    return ring;
}

export function bboxOf(polygons) {
    let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
    for (const poly of polygons) {
        for (const ring of poly) {
            for (const [lng, lat] of ring) {
                if (lat < minLat) minLat = lat;
                if (lat > maxLat) maxLat = lat;
                if (lng < minLng) minLng = lng;
                if (lng > maxLng) maxLng = lng;
            }
        }
    }
    return { minLat, maxLat, minLng, maxLng };
}

/** Diagonal del bounding box en metros. */
export function diagonalM(polygons) {
    const b = bboxOf(polygons);
    return haversine({ lat: b.minLat, lng: b.minLng }, { lat: b.maxLat, lng: b.maxLng });
}

/**
 * Elige `count` puntos al azar dentro de los polígonos, separados entre sí.
 * La separación mínima se relaja sola si el área es muy chica o irregular.
 * Siempre termina (si el polígono es degenerado, rellena con el centro del bbox).
 */
export function randomStars(polygons, count, rng = Math.random) {
    const b = bboxOf(polygons);
    const diag = diagonalM(polygons);
    let minDist = Math.max(6, diag * 0.18);
    const out = [];
    let attempts = 0;
    const MAX_ATTEMPTS = 20000;

    while (out.length < count && attempts < MAX_ATTEMPTS) {
        attempts++;
        const p = {
            lat: b.minLat + rng() * (b.maxLat - b.minLat),
            lng: b.minLng + rng() * (b.maxLng - b.minLng),
        };
        if (pointInPolygons(p, polygons) && out.every((q) => haversine(p, q) >= minDist)) {
            out.push(p);
        }
        if (attempts % 200 === 0) minDist *= 0.8;
    }

    while (out.length < count) {
        out.push({ lat: (b.minLat + b.maxLat) / 2, lng: (b.minLng + b.maxLng) / 2 });
    }
    return out;
}
