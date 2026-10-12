// ai.js - Cliente (hilo principal) del LLM que corre en llm-worker.js

// Modelo open-source que se descarga en el navegador. Ocupa varios cientos de MB la primera
// vez (después queda en caché). Para uno más liviano, cámbialo aquí y revisa llm-worker.js.
export const MODEL_ID = 'Xenova/Qwen1.5-0.5B-Chat';

const WORKER_URL = new URL('./llm-worker.js', import.meta.url);

/**
 * state: 'idle' | 'loading' | 'ready' | 'error' | 'off'
 * onChange({ state, progress }) se llama cada vez que cambia el estado o el progreso.
 */
export function createAI(onChange) {
    let worker = null;
    let state = 'idle';
    let progress = 0;
    let nextId = 1;
    const pending = new Map();

    function set(newState, newProgress) {
        state = newState;
        if (newProgress !== undefined) progress = newProgress;
        onChange({ state, progress });
    }

    function fail() {
        for (const { reject, timer } of pending.values()) {
            clearTimeout(timer);
            reject(new Error('ia-error'));
        }
        pending.clear();
        if (worker) worker.terminate();
        worker = null;
        set('error');
    }

    function start() {
        if (worker || (state !== 'idle' && state !== 'off')) return;
        if (typeof Worker === 'undefined') return set('error');
        try {
            worker = new Worker(WORKER_URL, { type: 'module' });
        } catch {
            return set('error');
        }
        set('loading', 0);

        worker.onmessage = (e) => {
            const m = e.data;
            if (m.type === 'progress') set('loading', m.progress);
            else if (m.type === 'ready') set('ready', 100);
            else if (m.type === 'result' || (m.type === 'error' && m.id)) {
                const p = pending.get(m.id);
                if (!p) return;
                pending.delete(m.id);
                clearTimeout(p.timer);
                if (m.type === 'result') p.resolve(m.text);
                else p.reject(new Error(m.message));
            } else if (m.type === 'error') fail();
        };
        worker.onerror = fail;
        worker.postMessage({ type: 'init', model: MODEL_ID });
    }

    /** Devuelve una promesa con el texto generado; rechaza si no está lista o tarda demasiado. */
    function generate(messages, opts = {}, timeoutMs = 8000) {
        if (state !== 'ready' || !worker) return Promise.reject(new Error('ia-no-lista'));
        return new Promise((resolve, reject) => {
            const id = nextId++;
            const timer = setTimeout(() => {
                pending.delete(id);
                reject(new Error('timeout'));
            }, timeoutMs);
            pending.set(id, { resolve, reject, timer });
            worker.postMessage({ type: 'generate', id, messages, opts });
        });
    }

    return {
        start,
        generate,
        markOff: () => set('off'),
        get state() {
            return state;
        },
    };
}
