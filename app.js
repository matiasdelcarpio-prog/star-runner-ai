// app.js - Lógica principal de Star Runner AI
// Flujo (una sola pantalla visible a la vez): elegir plaza -> recoger estrellas -> jugar de nuevo -> elegir plaza ...

import { playClickSound, playStarSound, playWinSound } from './audio.js';
import { geojsonToPolygons, circlePolygon, diagonalM, randomStars, haversine } from './geo.js';
import { createAI } from './ai.js';

const $ = (id) => document.getElementById(id);

// ---------- Configuración ----------
const STAR_COUNT = 5;
const COLLECT_RADIUS_M = 30;     // distancia (con GPS) a la que se puede recoger una estrella
const MAX_AREA_DIAG_M = 1500;    // si el lugar es más grande que esto, se usa un círculo chico
const FALLBACK_RADIUS_M = 80;    // radio del área de juego cuando el resultado es solo un punto
const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
const CORDOBA_VIEWBOX = '-64.32,-31.30,-64.07,-31.55'; // izquierda,arriba,derecha,abajo (Córdoba capital)

// ---------- Elementos ----------
const screens = { setup: $('screen-setup'), game: $('screen-game'), victory: $('screen-victory') };
const form = $('setup-form');
const input = $('location');
const startBtn = $('start-btn');
const statusEl = $('status');
const errorEl = $('error');

// ---------- Pantallas ----------
function show(name, { focus = true } = {}) {
    for (const [key, el] of Object.entries(screens)) el.hidden = key !== name;
    document.body.dataset.screen = name;
    window.scrollTo(0, 0);
    if (focus) screens[name].querySelector('h1, h2')?.focus({ preventScroll: true });
}

const setStatus = (t) => { statusEl.textContent = t || ''; };
const setError = (t) => { errorEl.textContent = t || ''; };

// ---------- IA (LLM en un Web Worker, carga en segundo plano) ----------
const AI_LABELS = {
    idle: () => '🤖 IA: preparando…',
    loading: (p) => `🤖 IA: descargando ${p}% (puedes jugar mientras tanto)`,
    ready: () => '🤖 IA lista',
    error: () => '🤖 IA no disponible: se usará la búsqueda básica',
    off: () => '🤖 IA en pausa para ahorrar datos',
};

const ai = createAI(({ state, progress }) => {
    $('ai-status').textContent = AI_LABELS[state](progress);
    $('ai-enable').hidden = state !== 'off';
});

$('ai-enable').addEventListener('click', () => ai.start());

(function scheduleAI() {
    const conn = navigator.connection;
    const saveData = conn && (conn.saveData || /^(slow-2g|2g|3g)$/.test(conn.effectiveType || ''));
    if (saveData) return ai.markOff();

    const go = () => {
        const idle = window.requestIdleCallback || ((fn) => setTimeout(fn, 1000));
        idle(() => ai.start(), { timeout: 4000 });
    };
    // Esperamos a que la página termine de cargar para no competir con ella
    if (document.readyState === 'complete') go();
    else window.addEventListener('load', go, { once: true });
})();

const normalize = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** Valida lo que devolvió el LLM: evita alucinaciones exigiendo que se parezca a lo que escribió el usuario. */
function cleanPlaceName(out, raw) {
    const s = String(out)
        .split('\n')[0]
        .replace(/^["'“”«»\s]+|["'“”«».\s]+$/g, '')
        .replace(/^(respuesta|lugar|nombre)\s*:\s*/i, '')
        .trim();
    if (s.length < 3 || s.length > 60) return null;
    const words = (t) => normalize(t).split(/[^a-z0-9]+/).filter((w) => w.length >= 4);
    const rawWords = new Set(words(raw));
    return words(s).some((w) => rawWords.has(w)) ? s : null;
}

/** El LLM extrae el nombre del lugar del texto libre del usuario. Si falla, se usa el texto tal cual. */
async function interpretQuery(raw) {
    if (ai.state !== 'ready') return raw;
    try {
        const out = await ai.generate(
            [
                {
                    role: 'system',
                    content:
                        'Extrae del texto del usuario SOLO el nombre del lugar público (plaza, parque, paseo) de la ciudad de Córdoba, Argentina. ' +
                        'Responde únicamente con el nombre, sin explicaciones.',
                },
                { role: 'user', content: raw },
            ],
            { max_new_tokens: 16 },
            8000
        );
        return cleanPlaceName(out, raw) || raw;
    } catch {
        return raw;
    }
}

function cleanNarrative(text) {
    const s = String(text).replace(/\s+/g, ' ').trim();
    if (s.length < 10 || s.length > 240) return null;
    if (/[぀-ヿ一-鿿가-힯]/.test(s)) return null; // el modelo a veces se pasa al chino
    return s;
}

// ---------- Búsqueda del lugar (Nominatim / OpenStreetMap) ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function nominatim(query) {
    const params = new URLSearchParams({
        q: `${query}, Córdoba, Argentina`,
        format: 'jsonv2',
        limit: '5',
        polygon_geojson: '1',
        polygon_threshold: '0.00005',
        viewbox: CORDOBA_VIEWBOX,
        bounded: '1',
        countrycodes: 'ar',
        'accept-language': 'es',
    });
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10000);
    try {
        const res = await fetch(`${NOMINATIM_URL}?${params}`, { signal: ctrl.signal });
        if (!res.ok) throw new Error(`Nominatim ${res.status}`);
        return await res.json();
    } finally {
        clearTimeout(timer);
    }
}

function scoreResult(r) {
    let s = 0;
    const type = r.type;
    const cat = r.category || r.class;
    if (['park', 'garden', 'square', 'pedestrian', 'playground', 'recreation_ground', 'common'].includes(type)) s += 3;
    if (cat === 'leisure' || (cat === 'place' && type === 'square')) s += 2;
    if (r.geojson && /Polygon/.test(r.geojson.type)) s += 2;
    return s;
}

function toPlace(r) {
    const center = { lat: Number(r.lat), lng: Number(r.lon) };
    let polygons = geojsonToPolygons(r.geojson);
    if (!polygons.length || diagonalM(polygons) > MAX_AREA_DIAG_M) {
        polygons = [[circlePolygon(center, FALLBACK_RADIUS_M)]];
    }
    return {
        id: `${r.osm_type}${r.osm_id}`,
        name: r.name || r.display_name.split(',')[0],
        polygons,
    };
}

async function findPlace(raw) {
    let query = raw;
    if (ai.state === 'ready') {
        setStatus('🤖 La IA está interpretando tu texto…');
        query = await interpretQuery(raw);
    }
    setStatus('🗺️ Buscando en el mapa de Córdoba…');
    let results = await nominatim(query);
    if (!results.length && query !== raw) {
        await sleep(1100); // Nominatim pide máximo 1 pedido por segundo
        results = await nominatim(raw);
    }
    if (!results.length) return null;
    const best = results.reduce((a, b) => (scoreResult(b) > scoreResult(a) ? b : a));
    return toPlace(best);
}

// ---------- Mapa (Leaflet) ----------
let map = null;
let gameLayer = null;
let userLayer = null;

const starIcon = () =>
    L.divIcon({
        className: 'star-div',
        html: '<span class="star-icon">⭐</span>',
        iconSize: [40, 40],
        iconAnchor: [20, 20],
    });

function ensureMap() {
    if (map) return;
    map = L.map('map', { maxZoom: 19 });
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(map);
    gameLayer = L.layerGroup().addTo(map);
    userLayer = L.layerGroup().addTo(map);
}

// ---------- Estado del juego ----------
const game = {
    running: false,
    token: 0,
    place: null,
    stars: [],
    left: 0,
    startTime: 0,
    timerId: 0,
    gps: false,
    watchId: null,
    pos: null,
};

const pad = (n) => String(n).padStart(2, '0');
const fmt = (ms) =>
    `${pad(Math.floor(ms / 60000))}:${pad(Math.floor((ms % 60000) / 1000))}.${pad(Math.floor((ms % 1000) / 10))}`;

const hint = (t) => { $('hint').textContent = t || ''; };

function renderStars() {
    $('stars-count').textContent = '⭐'.repeat(game.left) + '☆'.repeat(STAR_COUNT - game.left);
    $('stars-count').setAttribute('aria-label', `${game.left} estrellas restantes`);
}

function nearestStar() {
    if (!game.pos) return null;
    let best = null;
    for (const s of game.stars) {
        if (s.taken) continue;
        const dist = haversine(game.pos, s);
        if (!best || dist < best.dist) best = { star: s, dist };
    }
    return best;
}

function renderDistance() {
    const el = $('distance');
    if (!game.gps) { el.textContent = 'Toca una estrella del mapa'; return; }
    const n = nearestStar();
    el.textContent = n ? `Más cercana: ${Math.round(n.dist)} m` : 'Buscando GPS…';
}

function startGame(place) {
    stopGame();
    game.running = true;
    game.token++;
    game.place = place;
    game.left = STAR_COUNT;
    game.pos = null;
    game.stars = randomStars(place.polygons, STAR_COUNT).map((p) => ({ lat: p.lat, lng: p.lng, taken: false, marker: null }));

    $('place-name').textContent = place.name;
    $('narrative').textContent = `¡Alerta! ${STAR_COUNT} estrellas de energía acaban de caer en ${place.name}. ¡Ve por ellas!`;
    hint('');
    renderStars();

    show('game');
    ensureMap();
    gameLayer.clearLayers();
    userLayer.clearLayers();

    // Área de juego (todos los anillos juntos; los huecos se dibujan con relleno par-impar)
    const rings = place.polygons.flat().map((ring) => ring.map(([lng, lat]) => [lat, lng]));
    const area = L.polygon(rings, { color: '#a3e635', weight: 2, fillOpacity: 0.08, interactive: false }).addTo(gameLayer);

    game.stars.forEach((s) => {
        s.marker = L.marker([s.lat, s.lng], { icon: starIcon(), keyboard: false }).addTo(gameLayer);
        // Modo práctica (sin GPS): tocar la estrella la recoge
        s.marker.on('click', () => { if (!game.gps) collect(s); });
    });

    map.invalidateSize();
    map.fitBounds(area.getBounds(), { padding: [24, 24], maxZoom: 19 });

    setGpsMode(true);
    requestNarrative(place);

    game.startTime = performance.now();
    game.timerId = setInterval(() => {
        $('timer').textContent = fmt(performance.now() - game.startTime);
    }, 50);
    $('timer').textContent = fmt(0);
}

function stopGame() {
    game.running = false;
    clearInterval(game.timerId);
    if (game.watchId !== null) {
        navigator.geolocation.clearWatch(game.watchId);
        game.watchId = null;
    }
    game.gps = false;
}

function requestNarrative(place) {
    if (ai.state !== 'ready') return;
    const token = game.token;
    ai.generate(
        [
            {
                role: 'system',
                content:
                    'Eres el comandante de una misión en un juego de carreras al aire libre. ' +
                    'Responde en español, con un máximo de 2 frases cortas y sin emojis.',
            },
            { role: 'user', content: `La misión es en ${place.name}. Hay ${STAR_COUNT} estrellas espaciales para recoger rápido.` },
        ],
        { max_new_tokens: 60, do_sample: true, temperature: 0.8 },
        12000
    )
        .then((text) => {
            const s = cleanNarrative(text);
            if (s && game.running && game.token === token) $('narrative').textContent = s;
        })
        .catch(() => {});
}

// ---------- GPS ----------
function setGpsMode(on, message) {
    if (!on && game.watchId !== null) {
        navigator.geolocation.clearWatch(game.watchId);
        game.watchId = null;
    }
    if (on && !('geolocation' in navigator)) {
        on = false;
        message = 'Tu dispositivo no tiene GPS: modo práctica.';
    }
    game.gps = on;
    $('screen-game').dataset.mode = on ? 'gps' : 'practice';
    $('gps-toggle').textContent = on ? '📍 GPS: activado' : '📍 GPS: desactivado (modo práctica)';

    if (on && game.watchId === null) {
        hint('Buscando señal GPS…');
        game.watchId = navigator.geolocation.watchPosition(onPosition, onGpsError, {
            enableHighAccuracy: true,
            maximumAge: 2000,
            timeout: 20000,
        });
    } else if (!on) {
        userLayer?.clearLayers();
        game.pos = null;
        hint(message || 'Modo práctica: toca una estrella en el mapa para recogerla.');
    }
    renderDistance();
}

function onPosition(p) {
    game.pos = { lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy };
    userLayer.clearLayers();
    L.circle([game.pos.lat, game.pos.lng], { radius: game.pos.acc, color: '#38bdf8', weight: 1, fillOpacity: 0.1, interactive: false }).addTo(userLayer);
    L.circleMarker([game.pos.lat, game.pos.lng], { radius: 7, color: '#fff', weight: 2, fillColor: '#38bdf8', fillOpacity: 1, interactive: false }).addTo(userLayer);
    hint('¡Corre en la vida real y presiona al llegar!');
    renderDistance();
}

function onGpsError(err) {
    if (err.code === 1) setGpsMode(false, 'Sin permiso de ubicación: modo práctica. Toca una estrella en el mapa para recogerla.');
    else hint('Buscando señal GPS…');
}

// ---------- Recoger estrellas ----------
function collect(star) {
    if (!game.running || star.taken) return;
    star.taken = true;
    game.left--;
    playStarSound();
    navigator.vibrate?.(40);
    renderStars();
    renderDistance();

    // Efecto de feedback rápido
    document.body.classList.add('flash');
    setTimeout(() => document.body.classList.remove('flash'), 100);

    star.marker.getElement()?.querySelector('.star-icon')?.classList.add('collected');
    setTimeout(() => gameLayer.removeLayer(star.marker), 350);

    if (game.left === 0) finishGame();
}

$('collect-btn').addEventListener('click', () => {
    if (!game.running || !game.gps) return;
    const n = nearestStar();
    if (!n) return hint('Esperando señal GPS…');
    const tolerance = COLLECT_RADIUS_M + Math.min(game.pos.acc || 0, 20);
    if (n.dist <= tolerance) collect(n.star);
    else hint(`Todavía estás a ${Math.round(n.dist)} m de la estrella más cercana. ¡Sigue corriendo!`);
});

$('gps-toggle').addEventListener('click', () => setGpsMode(!game.gps));

// ---------- Fin del juego ----------
const bestKey = (id) => `sr-best:${id}`;
const loadBest = (id) => {
    try { const v = Number(localStorage.getItem(bestKey(id))); return v > 0 ? v : null; } catch { return null; }
};
const saveBest = (id, ms) => {
    try { localStorage.setItem(bestKey(id), String(Math.round(ms))); } catch { /* sin almacenamiento: no pasa nada */ }
};

function finishGame() {
    const elapsed = performance.now() - game.startTime;
    const place = game.place;
    stopGame();

    $('final-time').textContent = fmt(elapsed);
    const prev = loadBest(place.id);
    if (!prev || elapsed < prev) {
        saveBest(place.id, elapsed);
        $('best-time').textContent = prev ? `🏆 ¡Nuevo récord en ${place.name}!` : `Primer tiempo registrado en ${place.name}`;
    } else {
        $('best-time').textContent = `Tu récord en ${place.name}: ${fmt(prev)}`;
    }

    show('victory');
    playWinSound();
}

$('cancel-btn').addEventListener('click', () => {
    stopGame();
    show('setup');
});

$('again-btn').addEventListener('click', () => {
    setStatus('');
    setError('');
    show('setup');
    input.focus();
});

// ---------- Pantalla de configuración ----------
document.querySelectorAll('.chip').forEach((chip) =>
    chip.addEventListener('click', () => {
        input.value = chip.dataset.place;
        input.focus();
    })
);

// Sonido de click para todos los botones (el de recoger suena solo si recoge una estrella)
document.addEventListener('click', (e) => {
    if (e.target.closest('button') && !e.target.closest('[data-silent]')) playClickSound();
});

let busy = false;
form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (busy) return;

    const raw = input.value.trim();
    if (!raw) {
        setError('Escribe el nombre de una plaza o parque de Córdoba.');
        input.focus();
        return;
    }
    if (!window.L) {
        setError('No se pudo cargar el mapa. Revisa tu conexión y recarga la página.');
        return;
    }

    busy = true;
    startBtn.disabled = true;
    setError('');
    try {
        const place = await findPlace(raw);
        if (!place) {
            setError('No encontré ese lugar en Córdoba capital. Prueba con otro nombre, por ejemplo "Plaza San Martín".');
            return;
        }
        startGame(place);
    } catch {
        setError('No pude conectar con el servicio de mapas. Revisa tu conexión e inténtalo de nuevo.');
    } finally {
        busy = false;
        startBtn.disabled = false;
        setStatus('');
    }
});

show('setup', { focus: false });
