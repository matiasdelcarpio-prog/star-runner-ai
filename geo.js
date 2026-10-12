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
 * Si se pasa `clip = { center, radiusM }`, los puntos además quedan a menos de radiusM de `center`
 * (sirve para parques enormes: el juego ocurre en una zona acotada).
 * La separación mínima se relaja sola si el área es muy chica o irregular.
 * Siempre termina: si no se encuentra lugar, rellena con el centro.
 */
export function randomStars(polygons, count, rng = Math.random, clip = null) {
    let b = bboxOf(polygons);
    if (clip) {
        const dLat = (clip.radiusM / R) * (180 / Math.PI);
        const dLng = dLat / Math.cos(toRad(clip.center.lat));
        b = {
            minLat: Math.max(b.minLat, clip.center.lat - dLat),
            maxLat: Math.min(b.maxLat, clip.center.lat + dLat),
            minLng: Math.max(b.minLng, clip.center.lng - dLng),
            maxLng: Math.min(b.maxLng, clip.center.lng + dLng),
        };
    }
    const fallback = clip
        ? clip.center
        : { lat: (b.minLat + b.maxLat) / 2, lng: (b.minLng + b.maxLng) / 2 };

    const out = [];
    if (b.minLat <= b.maxLat && b.minLng <= b.maxLng) {
        const diag = haversine({ lat: b.minLat, lng: b.minLng }, { lat: b.maxLat, lng: b.maxLng });
        let minDist = Math.max(6, diag * 0.18);
        const MAX_ATTEMPTS = 20000;
        let attempts = 0;

        while (out.length < count && attempts < MAX_ATTEMPTS) {
            attempts++;
            const p = {
                lat: b.minLat + rng() * (b.maxLat - b.minLat),
                lng: b.minLng + rng() * (b.maxLng - b.minLng),
            };
            if (
                (!clip || haversine(p, clip.center) <= clip.radiusM) &&
                pointInPolygons(p, polygons) &&
                out.every((q) => haversine(p, q) >= minDist)
            ) {
                out.push(p);
            }
            if (attempts % 200 === 0) minDist *= 0.8;
        }
    }

    while (out.length < count) out.push({ lat: fallback.lat, lng: fallback.lng });
    return out;
}

/**
 * Filtro de posición GPS (Kalman simplificado). Cada medición se pesa según su precisión:
 * las buenas mueven mucho la estimación y las malas casi nada, lo que elimina el "temblor".
 * `speed` es cuánto puede moverse la persona por segundo (m/s) entre mediciones.
 * update() devuelve { lat, lng, acc } con la precisión estimada (m).
 */
export function createPositionFilter(speed = 3) {
    let s = null;
    return {
        update(lat, lng, accuracy, timeMs) {
            const acc = Math.max(accuracy, 1);
            if (!s) {
                s = { lat, lng, variance: acc * acc, t: timeMs };
            } else {
                const dt = Math.max(0, (timeMs - s.t) / 1000);
                s.variance += dt * speed * speed;
                const k = s.variance / (s.variance + acc * acc);
                s.lat += k * (lat - s.lat);
                s.lng += k * (lng - s.lng);
                s.variance = (1 - k) * s.variance;
                s.t = timeMs;
            }
            return { lat: s.lat, lng: s.lng, acc: Math.sqrt(s.variance) };
        },
        reset() {
            s = null;
        },
    };
}
