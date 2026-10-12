// llm-worker.js - Corre el LLM open-source en un Web Worker.
// Así la descarga y la inferencia del modelo NO bloquean la interfaz ni el resto de la página.
//
// Si cambias de modelo (ver MODEL_ID en ai.js), revisa que use el formato de chat ChatML
// (Qwen lo usa). Para otro formato, adapta toChatML().

import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2';

env.allowLocalModels = false; // los modelos se bajan del Hugging Face Hub
env.useBrowserCache = true;   // y se guardan en el navegador: la segunda visita no vuelve a descargar

let generator = null;
let queue = Promise.resolve(); // una sola inferencia a la vez

self.onmessage = (e) => {
    const msg = e.data;
    if (msg.type === 'init') queue = queue.then(() => init(msg.model));
    else if (msg.type === 'generate') queue = queue.then(() => generate(msg));
};

async function init(model) {
    try {
        const files = {};
        let last = -1;
        generator = await pipeline('text-generation', model, {
            progress_callback: (p) => {
                if (p.status !== 'progress' || !p.total) return;
                files[p.file] = { loaded: p.loaded, total: p.total };
                let loaded = 0;
                let total = 0;
                for (const f in files) {
                    loaded += files[f].loaded;
                    total += files[f].total;
                }
                const pct = Math.min(99, Math.round((100 * loaded) / total));
                if (pct !== last) {
                    last = pct;
                    self.postMessage({ type: 'progress', progress: pct });
                }
            },
        });
        self.postMessage({ type: 'ready' });
    } catch (err) {
        self.postMessage({ type: 'error', message: errText(err) });
    }
}

function toChatML(messages) {
    let s = '';
    for (const m of messages) s += `<|im_start|>${m.role}\n${m.content}<|im_end|>\n`;
    return s + '<|im_start|>assistant\n';
}

async function generate({ id, messages, opts = {} }) {
    try {
        if (!generator) throw new Error('El modelo todavía no está cargado');
        const prompt = toChatML(messages);
        const options = { max_new_tokens: opts.max_new_tokens ?? 40 };
        if (opts.do_sample) {
            options.do_sample = true;
            options.temperature = opts.temperature ?? 0.7;
            options.top_k = 40;
        }
        const out = await generator(prompt, options);
        let text = out[0].generated_text;
        if (text.startsWith(prompt)) text = text.slice(prompt.length);
        text = text.split('<|im_end|>')[0].trim();
        self.postMessage({ type: 'result', id, text });
    } catch (err) {
        self.postMessage({ type: 'error', id, message: errText(err) });
    }
}

function errText(err) {
    return String((err && err.message) || err);
}
