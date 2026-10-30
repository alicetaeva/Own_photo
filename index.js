// Own Photo — замена сгенерированной (или ещё не сгенерированной) картинки своим фото.
// Ищет <img data-iig-instruction=... src="[IMG:GEN]"> в сообщениях, добавляет кнопку-камеру,
// загружает выбранный файл на сервер ST (/api/images/upload, в папку персонажа) и
// переписывает src в тексте сообщения — ровно так же, как это делает генерация.

const MODULE = 'own_photo';
const NAME = 'Own Photo';

const DEFAULTS = Object.freeze({
    enabled: true,
    side: 'top-left',  // 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right' — угол кнопки
    maxSide: 2048,     // 0 = не уменьшать
    autoPick: true,    // сразу открывать галерею при нажатии на кнопку
});

// ---------- i18n ----------

const L = {
    ru: {
        btnTitle: 'Заменить своим фото',
        title: 'Своё фото',
        forPrompt: 'Промпт картинки',
        pick: 'Выбрать фото',
        change: 'Выбрать другое',
        dropHint: 'Нажмите, чтобы выбрать из галереи, или перетащите файл сюда',
        name: 'Имя файла',
        willSave: 'Сохранится как',
        overwrite: 'Файл с таким именем в этой папке будет перезаписан.',
        cancel: 'Отмена',
        replace: 'Заменить',
        errType: 'Это не изображение. Выберите файл JPG, PNG, WebP или GIF.',
        errDecode: 'Не удалось открыть изображение. Попробуйте JPG или PNG.',
        errUpload: 'Сервер не принял файл',
        errNoMsg: 'Сообщение не найдено — возможно, его удалили.',
        done: 'Картинка заменена',
        domOnly: 'Фото загружено, но тег в тексте сообщения не найден: замена видна только до обновления страницы.',
        saveFail: 'Картинка заменена, но чат не сохранился',
        errTimeout: 'Сервер слишком долго не отвечает',
        stepPrepare: 'Готовлю фото…',
        stepUpload: 'Загружаю…',
        stepSave: 'Сохраняю…',
        sEnabled: 'Показывать кнопку на картинках',
        sSide: 'Положение кнопки',
        topLeft: 'Сверху слева',
        topRight: 'Сверху справа',
        bottomLeft: 'Снизу слева',
        bottomRight: 'Снизу справа',
        sMax: 'Макс. сторона фото',
        original: 'Оригинал',
        sAuto: 'Сразу открывать галерею',
    },
    en: {
        btnTitle: 'Replace with your photo',
        title: 'Your photo',
        forPrompt: 'Image prompt',
        pick: 'Choose photo',
        change: 'Choose another',
        dropHint: 'Tap to pick from your gallery, or drop a file here',
        name: 'File name',
        willSave: 'Will be saved as',
        overwrite: 'A file with this name in this folder will be overwritten.',
        cancel: 'Cancel',
        replace: 'Replace',
        errType: 'This is not an image. Choose a JPG, PNG, WebP or GIF file.',
        errDecode: 'Could not open the image. Try JPG or PNG.',
        errUpload: 'The server rejected the file',
        errNoMsg: 'Message not found — it may have been deleted.',
        done: 'Image replaced',
        domOnly: 'Photo uploaded, but the tag was not found in the message text: the swap is visible only until reload.',
        saveFail: 'Image replaced, but the chat could not be saved',
        errTimeout: 'The server is taking too long to respond',
        stepPrepare: 'Preparing…',
        stepUpload: 'Uploading…',
        stepSave: 'Saving…',
        sEnabled: 'Show the button on images',
        sSide: 'Button position',
        topLeft: 'Top left',
        topRight: 'Top right',
        bottomLeft: 'Bottom left',
        bottomRight: 'Bottom right',
        sMax: 'Max photo side',
        original: 'Original',
        sAuto: 'Open the gallery immediately',
    },
};

function lang() {
    const raw = (localStorage.getItem('language') || navigator.language || 'en').toLowerCase();
    return /^(ru|uk|be)/.test(raw) ? 'ru' : 'en';
}
const t = (key) => L[lang()][key] ?? L.en[key] ?? key;

// ---------- утилиты ----------

const ctx = () => SillyTavern.getContext();

function settings() {
    const c = ctx();
    c.extensionSettings[MODULE] = Object.assign({}, DEFAULTS, c.extensionSettings[MODULE]);
    return c.extensionSettings[MODULE];
}

function toast(type, msg) {
    try { toastr[type](msg, NAME); } catch { console.log(`[${NAME}]`, msg); }
}

const log = (...a) => console.log(`[${NAME}]`, ...a);

function withTimeout(promise, ms) {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(t('errTimeout'))), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function decodeEntities(s) {
    const ta = document.createElement('textarea');
    ta.innerHTML = s;
    return ta.value;
}

function stamp() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function cleanName(n) {
    const out = String(n || '')
        .trim()
        .replace(/\.(png|jpe?g|webp|gif)$/i, '')
        .replace(/[\\/:*?"<>|#%\u0000-\u001f]/g, '_')
        .replace(/\s+/g, '_')
        .replace(/^\.+/, '')
        .slice(0, 80);
    return out || `photo_${stamp()}`;
}

function extGuess(file) {
    const type = (file?.type || '').toLowerCase();
    if (type === 'image/png') return 'png';
    if (type === 'image/webp') return 'webp';
    if (type === 'image/gif') return 'gif';
    return 'jpg';
}

function el(tag, cls, html) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
}

// ---------- теги <img> в сыром тексте сообщения ----------

// Тег целиком, с учётом кавычек (в JSON инструкции может встретиться «>»).
const TAG_RE = /<img\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi;

function findAttr(tag, name) {
    const re = /\s([\w:-]+)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/g;
    let m;
    while ((m = re.exec(tag))) {
        if (m[1].toLowerCase() !== name) continue;
        const token = m[2];
        const quote = token[0] === '"' || token[0] === "'" ? token[0] : '';
        const value = quote ? token.slice(1, -1) : token;
        const tokenStart = m.index + m[0].length - token.length;
        return { value, quote, tokenStart, tokenEnd: tokenStart + token.length };
    }
    return null;
}

function isCandidateTag(tag) {
    if (findAttr(tag, 'data-iig-instruction')) return true;
    const src = findAttr(tag, 'src');
    return !!src && /\[IMG:GEN\]/i.test(src.value);
}

function rawCandidates(text) {
    const out = [];
    for (const m of String(text).matchAll(TAG_RE)) {
        if (!isCandidateTag(m[0])) continue;
        const instr = findAttr(m[0], 'data-iig-instruction');
        out.push({ tag: m[0], start: m.index, instr: instr ? decodeEntities(instr.value) : '' });
    }
    return out;
}

function withSrc(tag, newSrc) {
    const src = findAttr(tag, 'src');
    if (src) {
        const q = src.quote || '"';
        return tag.slice(0, src.tokenStart) + q + newSrc + q + tag.slice(src.tokenEnd);
    }
    return tag.replace(/\s*(\/?)>$/, (_m, slash) => ` src="${newSrc}"${slash ? ' /' : ''}>`);
}

// ---------- DOM ----------

const CAND_SEL = 'img[data-iig-instruction], img[src*="IMG:GEN"]';

function candidatesIn(mesEl) {
    return [...mesEl.querySelectorAll('.mes_text ' + CAND_SEL)];
}

function describe(img, mesEl) {
    const list = candidatesIn(mesEl);
    const index = list.indexOf(img);
    const instr = img.getAttribute('data-iig-instruction') || '';
    const dupIdx = list.slice(0, index).filter((i) => (i.getAttribute('data-iig-instruction') || '') === instr).length;
    return { mesid: Number(mesEl.getAttribute('mesid')), index, instr, dupIdx, domCount: list.length };
}

// Сообщение могли перерисовать, пока было открыто окно, поэтому живой <img> ищем заново.
function resolveLiveImg(where) {
    const mesEl = document.querySelector(`#chat .mes[mesid="${where.mesid}"]`);
    if (!mesEl) return null;
    const list = candidatesIn(mesEl);
    const same = list.filter((i) => (i.getAttribute('data-iig-instruction') || '') === where.instr);
    return same[where.dupIdx] ?? list[where.index] ?? null;
}

function decorate() {
    if (!document.body) return;
    document.querySelectorAll('#chat .mes_text ' + CAND_SEL).forEach((img) => {
        if (img.closest('.ownphoto-wrap') || !img.parentNode) return;
        const wrap = el('span', 'ownphoto-wrap');
        img.parentNode.insertBefore(wrap, img);
        wrap.appendChild(img);
        const btn = el('button', 'ownphoto-btn', '<i class="fa-solid fa-camera"></i>');
        btn.type = 'button';
        btn.title = t('btnTitle');
        btn.setAttribute('aria-label', t('btnTitle'));
        wrap.appendChild(btn);
    });
}

const SIDES = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];

// Старые значения ('left' / 'right') считаем верхними углами.
function normalizeSide(v) {
    if (v === 'left') return 'top-left';
    if (v === 'right') return 'top-right';
    return SIDES.includes(v) ? v : DEFAULTS.side;
}

function applyBodyClasses() {
    const s = settings();
    s.side = normalizeSide(s.side);
    document.body.classList.toggle('ownphoto-disabled', !s.enabled);
    document.body.dataset.ownphotoPos = s.side;
}

// ---------- обработка файла ----------

function readB64(blob) {
    return new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result).split(',')[1] || '');
        r.onerror = () => reject(new Error(t('errDecode')));
        r.readAsDataURL(blob);
    });
}

function loadImage(file) {
    return new Promise((resolve, reject) => {
        const url = URL.createObjectURL(file);
        const img = new Image();
        img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
        img.onerror = () => { URL.revokeObjectURL(url); reject(new Error(t('errDecode'))); };
        img.src = url;
    });
}

// Фото с телефона весят по 5–10 МБ: уменьшаем до maxSide, остальное отдаём как есть.
async function processFile(file, maxSide) {
    const type = (file.type || '').toLowerCase();
    const known = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' }[type];
    if (type === 'image/gif') return { base64: await readB64(file), ext: 'gif' };

    const img = await loadImage(file);
    const w = img.naturalWidth;
    const h = img.naturalHeight;
    const scale = maxSide > 0 ? Math.min(1, maxSide / Math.max(w, h)) : 1;
    if (scale === 1 && known) return { base64: await readB64(file), ext: known };

    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(w * scale));
    canvas.height = Math.max(1, Math.round(h * scale));
    const g = canvas.getContext('2d');
    const keepAlpha = type === 'image/png' || type === 'image/webp';
    if (!keepAlpha) { g.fillStyle = '#fff'; g.fillRect(0, 0, canvas.width, canvas.height); }
    g.drawImage(img, 0, 0, canvas.width, canvas.height);
    const mime = keepAlpha ? 'image/png' : 'image/jpeg';
    return { base64: canvas.toDataURL(mime, 0.9).split(',')[1], ext: keepAlpha ? 'png' : 'jpg' };
}

async function upload({ base64, ext, folder, filename }) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 90000);
    let res;
    try {
        res = await fetch('/api/images/upload', {
            method: 'POST',
            headers: ctx().getRequestHeaders(),
            body: JSON.stringify({ image: base64, format: ext, ch_name: folder, filename }),
            signal: ctrl.signal,
        });
    } catch (err) {
        throw new Error(err?.name === 'AbortError' ? t('errTimeout') : `${t('errUpload')}: ${err?.message || err}`);
    } finally {
        clearTimeout(timer);
    }
    if (!res.ok) throw new Error(`${t('errUpload')} (${res.status})`);
    const data = await res.json();
    log('upload ответ:', data);
    let p = String(data?.path || '').replace(/\\/g, '/');
    if (!p) throw new Error(t('errUpload'));
    if (/^https?:/i.test(p)) return p;
    if (!p.startsWith('/')) p = '/' + p;
    return p.split('/').map((seg, i) => (i === 0 ? seg : encodeURIComponent(seg))).join('/');
}

// ---------- запись в сообщение ----------

// Возвращает true, если src переписан в тексте сообщения (и в swipes).
function patchMessage(where, newSrc) {
    const message = ctx().chat?.[where.mesid];
    if (!message || typeof message.mes !== 'string') return false;

    const tags = rawCandidates(message.mes);
    let target = null;
    if (where.instr) {
        const same = tags.filter((x) => x.instr === where.instr);
        target = same[where.dupIdx] ?? (same.length === 1 ? same[0] : null);
    }
    if (!target && tags.length === where.domCount) target = tags[where.index];
    if (!target) return false;

    const newTag = withSrc(target.tag, newSrc);
    message.mes = message.mes.slice(0, target.start) + newTag + message.mes.slice(target.start + target.tag.length);
    if (Array.isArray(message.swipes) && Number.isInteger(message.swipe_id) && typeof message.swipes[message.swipe_id] === 'string') {
        message.swipes[message.swipe_id] = message.mes;
    }
    return true;
}

async function commit({ where, folder, file, name, onStep = () => {} }) {
    const message = ctx().chat?.[where.mesid];
    if (!message) throw new Error(t('errNoMsg'));

    onStep(t('stepPrepare'));
    log('commit: файл', file.name, file.type, file.size);
    const { base64, ext } = await processFile(file, settings().maxSide);

    onStep(t('stepUpload'));
    log('commit: загрузка', ext, `${Math.round(base64.length / 1024)} KB base64`);
    const newSrc = await upload({ base64, ext, folder, filename: cleanName(name) });
    log('commit: загружено →', newSrc);

    onStep(t('stepSave'));
    const patched = patchMessage(where, newSrc);
    const live = resolveLiveImg(where);
    log('commit: текст сообщения изменён =', patched, '| живая картинка найдена =', !!live);

    if (live) {
        live.removeAttribute('srcset');
        live.setAttribute('src', newSrc);
        live.src = newSrc;
    }

    if (!patched) {
        toast('warning', t('domOnly'));
        return;
    }

    try {
        await withTimeout(Promise.resolve(ctx().saveChat()), 10000);
    } catch (err) {
        log('saveChat failed', err);
        toast('warning', t('saveFail'));
        return;
    }

    // Другие расширения слушают MESSAGE_UPDATED, но ждать их не нужно: любое зависание
    // чужого обработчика не должно держать наше окно.
    try {
        const { eventSource, eventTypes, event_types } = ctx();
        const ev = (eventTypes || event_types)?.MESSAGE_UPDATED;
        if (ev) Promise.resolve(eventSource.emit(ev, where.mesid)).catch((e) => log('MESSAGE_UPDATED handler failed', e));
    } catch (err) {
        log('emit failed', err);
    }
    toast('success', t('done'));
}

// ---------- окно ----------

function openModal({ folder, prompt, autoPick, submit }) {
    return new Promise((resolve) => {
        let file = null;
        let objUrl = '';
        let busy = false;
        let closed = false;

        const overlay = el('div', 'ownphoto-overlay');
        overlay.setAttribute('role', 'dialog');
        overlay.setAttribute('aria-modal', 'true');
        overlay.innerHTML = `
            <div class="ownphoto-card">
                <div class="ownphoto-head">
                    <h3 class="ownphoto-title"></h3>
                    <button type="button" class="ownphoto-close menu_button" aria-label="Close"><i class="fa-solid fa-xmark"></i></button>
                </div>
                <div class="ownphoto-body">
                    <div class="ownphoto-prompt" hidden>
                        <div class="ownphoto-label"></div>
                        <div class="ownphoto-prompt-text"></div>
                    </div>
                    <button type="button" class="ownphoto-drop">
                        <img class="ownphoto-preview" alt="" hidden>
                        <span class="ownphoto-drop-hint"><i class="fa-solid fa-image"></i><span></span></span>
                    </button>
                    <div class="ownphoto-meta" hidden></div>
                    <label class="ownphoto-field">
                        <span class="ownphoto-label ownphoto-name-label"></span>
                        <input type="text" class="text_pole ownphoto-name" autocomplete="off" autocapitalize="off" spellcheck="false">
                    </label>
                    <div class="ownphoto-path"></div>
                    <div class="ownphoto-note"></div>
                    <div class="ownphoto-error" role="alert" hidden></div>
                    <input type="file" accept="image/*" hidden>
                </div>
                <div class="ownphoto-foot">
                    <button type="button" class="ownphoto-cancel menu_button"></button>
                    <button type="button" class="ownphoto-save menu_button menu_button_icon" disabled><i class="fa-solid fa-check"></i><span></span></button>
                </div>
            </div>`;

        const q = (s) => overlay.querySelector(s);
        const input = q('input[type=file]');
        const nameInput = q('.ownphoto-name');
        const preview = q('.ownphoto-preview');
        const dropHint = q('.ownphoto-drop-hint');
        const meta = q('.ownphoto-meta');
        const errBox = q('.ownphoto-error');
        const saveBtn = q('.ownphoto-save');

        q('.ownphoto-title').textContent = t('title');
        q('.ownphoto-prompt .ownphoto-label').textContent = t('forPrompt');
        dropHint.querySelector('span').textContent = t('dropHint');
        q('.ownphoto-name-label').textContent = t('name');
        q('.ownphoto-note').textContent = t('overwrite');
        q('.ownphoto-cancel').textContent = t('cancel');
        saveBtn.querySelector('span').textContent = t('replace');
        nameInput.value = `photo_${stamp()}`;

        if (prompt) {
            q('.ownphoto-prompt').hidden = false;
            q('.ownphoto-prompt-text').textContent = prompt.length > 240 ? prompt.slice(0, 240) + '…' : prompt;
        }

        const updatePath = () => {
            q('.ownphoto-path').textContent = `${t('willSave')}: /user/images/${folder}/${cleanName(nameInput.value)}.${extGuess(file)}`;
        };
        const showError = (msg) => { errBox.textContent = msg; errBox.hidden = !msg; };

        const close = (result) => {
            if (closed) return;
            closed = true;
            document.removeEventListener('keydown', onKey, true);
            document.removeEventListener('paste', onPaste, true);
            if (objUrl) URL.revokeObjectURL(objUrl);
            overlay.remove();
            resolve(result);
        };

        const setFile = (f) => {
            showError('');
            if (!f) return;
            if (!(f.type || '').startsWith('image/') && !/\.(heic|heif|avif|jpe?g|png|webp|gif|bmp)$/i.test(f.name || '')) {
                showError(t('errType'));
                return;
            }
            file = f;
            if (objUrl) URL.revokeObjectURL(objUrl);
            objUrl = URL.createObjectURL(f);
            preview.onload = () => {
                meta.textContent = `${preview.naturalWidth}×${preview.naturalHeight} · ${(f.size / 1048576).toFixed(1)} MB`;
                meta.hidden = false;
            };
            preview.onerror = () => { meta.hidden = true; };
            preview.src = objUrl;
            preview.hidden = false;
            dropHint.hidden = true;
            saveBtn.disabled = false;
            updatePath();
        };

        const onKey = (e) => {
            if (e.key === 'Escape') { e.stopPropagation(); close(false); }
        };
        const onPaste = (e) => {
            const f = [...(e.clipboardData?.files || [])].find((x) => x.type.startsWith('image/'));
            if (f && !busy) { e.preventDefault(); setFile(f); }
        };

        q('.ownphoto-close').addEventListener('click', () => close(false));
        q('.ownphoto-cancel').addEventListener('click', () => close(false));
        q('.ownphoto-drop').addEventListener('click', () => { if (!busy) input.click(); });
        input.addEventListener('change', () => { setFile(input.files?.[0]); input.value = ''; });
        nameInput.addEventListener('input', updatePath);

        const drop = q('.ownphoto-drop');
        drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('is-over'); });
        drop.addEventListener('dragleave', () => drop.classList.remove('is-over'));
        drop.addEventListener('drop', (e) => {
            e.preventDefault();
            drop.classList.remove('is-over');
            if (!busy) setFile(e.dataTransfer?.files?.[0]);
        });

        saveBtn.addEventListener('click', async () => {
            if (busy || !file) return;
            busy = true;
            saveBtn.disabled = true;
            const icon = saveBtn.querySelector('i');
            const label = saveBtn.querySelector('span');
            const prevIcon = icon.className;
            const prevLabel = label.textContent;
            icon.className = 'fa-solid fa-spinner ownphoto-spin';
            showError('');
            try {
                await submit({ file, name: nameInput.value, onStep: (txt) => { if (!closed) label.textContent = txt; } });
                busy = false;
                close(true);
            } catch (err) {
                log('submit failed', err);
                busy = false;
                if (closed) {
                    toast('error', err?.message || String(err));
                } else {
                    showError(err?.message || String(err));
                    saveBtn.disabled = false;
                    icon.className = prevIcon;
                    label.textContent = prevLabel;
                }
            }
        });

        document.addEventListener('keydown', onKey, true);
        document.addEventListener('paste', onPaste, true);
        document.body.appendChild(overlay);
        updatePath();

        // Вызов внутри того же клика по кнопке — браузеры разрешают открыть выбор файла.
        if (autoPick) {
            try { input.click(); } catch { /* ничего: останется ручной выбор */ }
        } else {
            drop.focus();
        }
    });
}

// ---------- клик по кнопке ----------

let swapInFlight = false;

function readPrompt(instr) {
    if (!instr) return '';
    try {
        const data = JSON.parse(instr);
        return String(data?.prompt ?? '');
    } catch {
        return instr;
    }
}

async function onSwap(btn) {
    // Если флаг завис, а окна уже нет, сбрасываем его, чтобы кнопка не «умирала».
    if (swapInFlight && document.querySelector('.ownphoto-overlay')) return;
    document.querySelectorAll('.ownphoto-overlay').forEach((n) => n.remove());
    swapInFlight = false;
    log('клик по кнопке');
    const img = btn.closest('.ownphoto-wrap')?.querySelector('img');
    const mesEl = img?.closest('.mes');
    if (!img || !mesEl) return;

    const where = describe(img, mesEl);
    const message = ctx().chat?.[where.mesid];
    if (!message) { toast('error', t('errNoMsg')); return; }

    const folder = message.name || ctx().name2 || 'user';
    swapInFlight = true;
    try {
        await openModal({
            folder,
            prompt: readPrompt(where.instr),
            autoPick: settings().autoPick,
            submit: ({ file, name, onStep }) => commit({ where, folder, file, name, onStep }),
        });
    } catch (err) {
        log('onSwap failed', err);
        toast('error', err?.message || String(err));
    } finally {
        swapInFlight = false;
    }
}

// ---------- настройки ----------

function mountSettings() {
    if (document.getElementById('ownphoto_settings')) return true;
    const host = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
    if (!host) return false;

    const s = settings();
    const sel = (v, cur) => (String(v) === String(cur) ? 'selected' : '');
    const wrap = el('div', '', `
        <div class="inline-drawer" id="ownphoto_settings">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>${NAME}</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <label class="checkbox_label"><input type="checkbox" id="ownphoto_enabled" ${s.enabled ? 'checked' : ''}><span>${t('sEnabled')}</span></label>
                <label class="checkbox_label"><input type="checkbox" id="ownphoto_auto" ${s.autoPick ? 'checked' : ''}><span>${t('sAuto')}</span></label>
                <label class="ownphoto-setting"><span>${t('sSide')}</span>
                    <select id="ownphoto_side" class="text_pole">
                        <option value="top-left" ${sel('top-left', s.side)}>${t('topLeft')}</option>
                        <option value="top-right" ${sel('top-right', s.side)}>${t('topRight')}</option>
                        <option value="bottom-left" ${sel('bottom-left', s.side)}>${t('bottomLeft')}</option>
                        <option value="bottom-right" ${sel('bottom-right', s.side)}>${t('bottomRight')}</option>
                    </select>
                </label>
                <label class="ownphoto-setting"><span>${t('sMax')}</span>
                    <select id="ownphoto_max" class="text_pole">
                        <option value="0" ${sel(0, s.maxSide)}>${t('original')}</option>
                        <option value="1024" ${sel(1024, s.maxSide)}>1024 px</option>
                        <option value="1536" ${sel(1536, s.maxSide)}>1536 px</option>
                        <option value="2048" ${sel(2048, s.maxSide)}>2048 px</option>
                        <option value="3072" ${sel(3072, s.maxSide)}>3072 px</option>
                    </select>
                </label>
            </div>
        </div>`);
    host.appendChild(wrap);

    const save = () => ctx().saveSettingsDebounced();
    wrap.querySelector('#ownphoto_enabled').addEventListener('change', (e) => { settings().enabled = e.target.checked; applyBodyClasses(); save(); });
    wrap.querySelector('#ownphoto_auto').addEventListener('change', (e) => { settings().autoPick = e.target.checked; save(); });
    wrap.querySelector('#ownphoto_side').addEventListener('change', (e) => { settings().side = normalizeSide(e.target.value); applyBodyClasses(); save(); });
    wrap.querySelector('#ownphoto_max').addEventListener('change', (e) => { settings().maxSide = Number(e.target.value); save(); });
    return true;
}

// ---------- запуск ----------

jQuery(() => {
    try {
        applyBodyClasses();

        document.addEventListener('click', (e) => {
            const btn = e.target.closest?.('.ownphoto-btn');
            if (!btn) return;
            e.preventDefault();
            e.stopPropagation();
            onSwap(btn);
        }, true);

        let timer = null;
        const schedule = () => {
            clearTimeout(timer);
            timer = setTimeout(decorate, 150);
        };
        const chat = document.getElementById('chat');
        if (chat) new MutationObserver(schedule).observe(chat, { childList: true, subtree: true });
        decorate();

        // Панель настроек: ждём APP_READY, плюс страховка по таймеру.
        const c = ctx();
        const ev = (c.eventTypes || c.event_types)?.APP_READY;
        if (ev) c.eventSource.on(ev, mountSettings);
        let tries = 0;
        const retry = setInterval(() => {
            if (mountSettings() || ++tries > 20) clearInterval(retry);
        }, 1000);

        log('загружен');
    } catch (err) {
        console.error(`[${NAME}] init failed`, err);
    }
});
