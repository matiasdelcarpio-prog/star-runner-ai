// app.js - Lógica principal de Star Runner AI
// Flujo (una sola pantalla visible a la vez): elegir plaza -> recoger estrellas -> jugar de nuevo -> elegir plaza ...

import { playClickSound, playStarSound, playWinSound } from './audio.js';
import {
    geojsonToPolygons, circlePolygon, bboxOf, diagonalM, pointInPolygons,
    randomStars, haversine, createPositionFilter,
} from './geo.js';
import { createAI } from './ai.js';

const $ = (id) => document.getElementById(id);

// ---------- Configuración ----------
const STAR_COUNT = 5;
const MAP_RADIUS_M = 500;          // el mapa no se puede alejar ni mover más allá de este radio
const STAR_RADIUS_M = 400;         // las estrellas aparecen a menos de esto del centro (siempre dentro del mapa)
const TAP_RADIUS_PX = 34;          // tolerancia del toque: se recoge la estrella más cercana a menos de esto
const COLLECT_RADIUS_M = 30;       // modo real: distancia a la que se puede recoger una estrella
const GPS_MAX_ACCURACY_M = 50;     // las posiciones con peor precisión (Wi-Fi, antenas, IP) se descartan
const GPS_WARN_AFTER_MS = 20000;   // si tras este tiempo solo hay posiciones imprecisas, se avisa
const FALLBACK_RADIUS_M = 80;      // radio del área de juego cuando el resultado es solo un punto
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
    idle: () => 'IA: preparando…',
    loading: (p) => `IA: descargando ${p}%`,
    ready: () => 'IA lista',
    error: () => 'IA no disponible: se usará la búsqueda básica',
    off: () => 'IA en pausa para ahorrar datos',
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
        return 'error';
    }
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
    const point = { lat: Number(r.lat), lng: Number(r.lon) };
    let polygons = geojsonToPolygons(r.geojson);
    if (!polygons.length) polygons = [[circlePolygon(point, FALLBACK_RADIUS_M)]];

    // Centro del juego: el del rectángulo que envuelve al lugar; si cae fuera (formas en L, etc.), el punto de Nominatim
    const b = bboxOf(polygons);
    let center = { lat: (b.minLat + b.maxLat) / 2, lng: (b.minLng + b.maxLng) / 2 };
    if (!pointInPolygons(center, polygons)) center = point;

    return {
        id: `${r.osm_type}${r.osm_id}`,
        name: r.name || r.display_name.split(',')[0],
        polygons,
        center,
        diag: diagonalM(polygons),
    };
}

async function findPlace(raw) {
    let query = raw;
    if (ai.state === 'ready') {
        setStatus('La IA está interpretando tu texto…');
        query = await interpretQuery(raw);
    } else { return; }
    setStatus('Buscando en el mapa de Córdoba…');
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
    map = L.map('map', {
        maxZoom: 19,
        maxBoundsViscosity: 1, // no se puede arrastrar el mapa fuera del límite
        doubleClickZoom: false, // tocar estrellas rápido no debe hacer zoom
    });
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(map);
    gameLayer = L.layerGroup().addTo(map);
    userLayer = L.layerGroup().addTo(map);
    map.on('click', onMapTap);
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
    real: false,        // modo real: hay que estar cerca de la estrella para recogerla
    watchId: null,
    filter: null,
    pos: null,          // última posición suavizada { lat, lng, acc }
    gpsStart: 0,
    gpsDenied: false,
    coarseAcc: 0,       // precisión de la última posición descartada por imprecisa
    coarseLong: false,  // ¿hace rato que solo llegan posiciones imprecisas?
};

const pad = (n) => String(n).padStart(2, '0');
const fmt = (ms) =>
    `${pad(Math.floor(ms / 60000))}:${pad(Math.floor((ms % 60000) / 1000))}.${pad(Math.floor((ms % 1000) / 10))}`;

// Línea de ayuda: un texto base (según el estado) y mensajes temporales encima
let infoText = '';
let flashTimer = 0;
const renderHint = (t) => { $('hint').textContent = t; };
function setInfo(t) {
    infoText = t;
    if (!flashTimer) renderHint(t);
}
function flashHint(t) {
    renderHint(t);
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => { flashTimer = 0; renderHint(infoText); }, 3500);
}

function refreshInfo() {
    let t = game.real
        ? 'Modo real: acércate a una estrella y tócala.'
        : 'Toca las estrellas del mapa para recogerlas.';
    if (game.gpsDenied) t += ' Ubicación no disponible.';
    else if (game.pos) t += ` GPS ±${Math.round(game.pos.acc)} m`;
    else if (game.coarseLong) t = `Tu ubicación es aproximada (±${Math.round(game.coarseAcc)} m). Activa la ubicación precisa del navegador en los ajustes del teléfono.`;
    else if (game.coarseAcc) t += ` Mejorando la precisión del GPS (±${Math.round(game.coarseAcc)} m)…`;
    else t += ' Buscando GPS…';
    setInfo(t);
}

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
    const n = nearestStar();
    $('distance').textContent = n ? `Más cercana: ${Math.round(n.dist)} m` : ' ';
}

// Mantiene la pantalla encendida mientras se juega (si se apaga, el GPS deja de actualizarse)
let wakeLock = null;
async function keepAwake() {
    try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* no soportado: no pasa nada */ }
}
function releaseAwake() {
    wakeLock?.release().catch(() => {});
    wakeLock = null;
}
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && game.running) keepAwake();
});

function startGame(place) {
    stopGame();
    game.running = true;
    game.token++;
    game.place = place;
    game.left = STAR_COUNT;
    game.stars = randomStars(place.polygons, STAR_COUNT, Math.random, { center: place.center, radiusM: STAR_RADIUS_M })
        .map((p) => ({ lat: p.lat, lng: p.lng, taken: false, marker: null }));

    $('place-name').textContent = place.name;

    renderStars();
    renderDistance();
    clearTimeout(flashTimer);
    flashTimer = 0;

    show('game');
    ensureMap();
    gameLayer.clearLayers();
    userLayer.clearLayers();

    // Límites del mapa: radio máximo de MAP_RADIUS_M alrededor del centro, y zoom mínimo acorde
    map.setMaxBounds(null);
    map.setMinZoom(0);
    map.setView([place.center.lat, place.center.lng], 16, { animate: false });
    map.invalidateSize();
    const limits = L.latLng(place.center.lat, place.center.lng).toBounds(MAP_RADIUS_M * 2);
    map.setMaxBounds(limits);
    const minZoom = map.getBoundsZoom(limits, true); // el zoom más alejado que sigue dentro del límite
    if (Number.isFinite(minZoom)) map.setMinZoom(minZoom);

    // Área de juego (todos los anillos juntos; los huecos se dibujan con relleno par-impar)
    const rings = place.polygons.flat().map((ring) => ring.map(([lng, lat]) => [lat, lng]));
    const area = L.polygon(rings, { color: '#a3e635', weight: 2, fillOpacity: 0.08, interactive: false }).addTo(gameLayer);

    game.stars.forEach((s) => {
        // Los toques se resuelven en onMapTap (más tolerante que el área del ícono)
        s.marker = L.marker([s.lat, s.lng], { icon: starIcon(), interactive: false, keyboard: false }).addTo(gameLayer);
    });

    const fit = place.diag <= MAP_RADIUS_M * 2 ? area.getBounds() : L.latLngBounds(game.stars.map((s) => [s.lat, s.lng]));
    map.fitBounds(fit, { padding: [28, 28], maxZoom: 19, animate: false });

    startGPS();
    setRealMode(game.real);
    requestNarrative(place);
    keepAwake();

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
    releaseAwake();
}

function cleanNarrative(text) {
    const s = String(text).replace(/\s+/g, ' ').trim();
    if (s.length < 10 || s.length > 240) return null;
    if (/[぀-ヿ一-鿿가-힯]/.test(s)) return null; // el modelo a veces se pasa al chino
    return s;
}

// Asegúrate de guardar el texto exacto que le envías al usuario en una variable
function requestNarrative(place) {
    // 1. Definimos un texto por defecto y lo mostramos INMEDIATAMENTE.
    // Así el jugador no se queda viendo "Generando..." y puede empezar a jugar.
    const textoPorDefecto = `¡La misión es en ${place.name}! Recoge las ${STAR_COUNT} estrellas rápido.`;
    $('narrative').textContent = textoPorDefecto;

    const token = game.token;

    // Guardamos el prompt exacto del usuario para poder recortarlo después
    const userPrompt = `La misión es en ${place.name}. Hay ${STAR_COUNT} estrellas espaciales para recoger rápido.`;

    ai.generate(
        [
            {
                role: 'system',
                content: 'Eres el comandante de una misión en un juego de carreras al aire libre. Responde en español, con un máximo de 2 frases cortas y sin emojis.',
            },
            { role: 'user', content: userPrompt },
        ],

        { max_new_tokens: 60, do_sample: true, temperature: 0.8 }
    )
    .then((text) => {
        // Asegurarnos de que tenemos un string con el que trabajar
        let rawText = typeof text === 'string' ? text : text?.text || text?.generated_text || "";

        // 2. RECORTAR EL HISTORIAL: Buscamos dónde termina nuestro prompt
        const promptIndex = rawText.lastIndexOf(userPrompt);
        if (promptIndex !== -1) {
            // Nos quedamos solo con lo que la IA generó a partir de ahí
            rawText = rawText.substring(promptIndex + userPrompt.length);
        }

        // 3. LIMPIAR ETIQUETAS: Borramos marcas internas que usan los modelos locales (ej: <|assistant|>)
        rawText = rawText
            .replace(/<[^>]+>/g, '')                  // Borra etiquetas HTML/XML
            .replace(/(assistant|sistema|user|bot):/gi, '') // Borra prefijos de roles
            .replace(/\[\/?INST\]/gi, '')             // Borra etiquetas de instrucciones
            .trim();

        // 4. Pasamos por tu función de limpieza original
        const s = cleanNarrative(rawText);

        // 5. Si el juego sigue en curso, no se reinició el nivel, y el texto es válido, actualizamos el HTML
        if (game.running && game.token === token && s) {
            $('narrative').textContent = s;
        }
    })
    .catch((error) => {
        // Si hay un error, el jugador ni se entera porque ya tiene el texto por defecto en pantalla
        console.warn("Fallo en la generación de IA de fondo:", error);
    });
}


// ---------- GPS ----------
function startGPS() {
    game.pos = null;
    game.filter = createPositionFilter();
    game.gpsStart = performance.now();
    game.gpsDenied = false;
    game.coarseAcc = 0;
    game.coarseLong = false;

    if (!('geolocation' in navigator)) {
        game.gpsDenied = true;
        return;
    }
    game.watchId = navigator.geolocation.watchPosition(onPosition, onGpsError, {
        enableHighAccuracy: true, // pide GPS real en vez de Wi-Fi/antenas
        maximumAge: 0,            // nunca usar una posición guardada
        timeout: 30000,
    });
}

function onPosition(p) {
    if (!game.running) return;
    const { latitude, longitude, accuracy } = p.coords;

    // Una posición con mala precisión suele venir de Wi-Fi/antenas/IP y puede estar a kilómetros: se descarta
    if (accuracy > GPS_MAX_ACCURACY_M) {
        game.coarseAcc = accuracy;
        game.coarseLong = performance.now() - game.gpsStart > GPS_WARN_AFTER_MS;
        refreshInfo();
        return;
    }

    game.coarseAcc = 0;
    game.coarseLong = false;
    game.pos = game.filter.update(latitude, longitude, accuracy, p.timestamp);
    drawUser();
    renderDistance();
    refreshInfo();
}

function onGpsError(err) {
    if (err.code === 1) {
        game.gpsDenied = true;
        if (game.real) setRealMode(false, 'Para el modo real activa el permiso de ubicación del navegador.');
    }
    refreshInfo();
}

function drawUser() {
    userLayer.clearLayers();
    const { lat, lng, acc } = game.pos;
    L.circle([lat, lng], { radius: acc, color: '#38bdf8', weight: 1, fillOpacity: 0.1, interactive: false }).addTo(userLayer);
    L.circleMarker([lat, lng], { radius: 7, color: '#fff', weight: 2, fillColor: '#38bdf8', fillOpacity: 1, interactive: false }).addTo(userLayer);
}

function setRealMode(on, message) {
    if (on && game.gpsDenied) {
        on = false;
        message = 'Para el modo real activa el permiso de ubicación del navegador.';
    }
    game.real = on;
    const btn = $('real-toggle');
    btn.setAttribute('aria-pressed', String(on));
    btn.textContent = on ? 'Modo real: activado' : 'Modo real: desactivado';
    refreshInfo();
    if (message) flashHint(message);
}

$('real-toggle').addEventListener('click', () => setRealMode(!game.real));

// ---------- Recoger estrellas ----------
/** Toque en el mapa: recoge la estrella más cercana al dedo (a menos de TAP_RADIUS_PX). */
function onMapTap(e) {
    if (!game.running) return;
    let best = null;
    for (const s of game.stars) {
        if (s.taken) continue;
        const d = map.latLngToContainerPoint([s.lat, s.lng]).distanceTo(e.containerPoint);
        if (d <= TAP_RADIUS_PX && (!best || d < best.d)) best = { star: s, d };
    }
    if (best) tryCollect(best.star);
}

function tryCollect(star) {
    if (game.real) {
        if (!game.pos) return flashHint('Esperando una señal GPS precisa…');
        const dist = haversine(game.pos, star);
        if (dist > COLLECT_RADIUS_M + Math.min(game.pos.acc, 20)) {
            return flashHint(`Estás a ${Math.round(dist)} m de esa estrella. ¡Acércate!`);
        }
    }
    collect(star);
}

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

// Sonido de click para todos los botones (las estrellas tienen su propio sonido)
document.addEventListener('click', (e) => {
    if (e.target.closest('button')) playClickSound();
});

let busy = false;
form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (busy) return;

    const raw = input.value.trim();//
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
            setError('No encontré ese lugar en Córdoba capital o la IA todavia no esta lista. Prueba con otro nombre, por ejemplo "Plaza San Martín".');
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
