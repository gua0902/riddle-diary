/**
 * ==========================================================================
 * 瑞斗的日記 (T. M. Riddle's Diary) - 核心 JavaScript
 * 功能：手寫畫布、像素溶解、NVIDIA 視覺 API 串流、骨架化、手寫動畫與記憶系統
 * ==========================================================================
 */

// --------------------------------------------------------------------------
// 1. 配置與常數 (Configuration & Constants)
// --------------------------------------------------------------------------
const API_KEY = "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";
const API_URL = "https://integrate.api.nvidia.com/v1/chat/completions";
const MODEL = "meta/llama-3.2-11b-vision-instruct";


const PERSONA = `You are the memory of Tom Marvolo Riddle, preserved in this enchanted diary for fifty years. Someone writes to you in the diary with a quill; their words appear to you as ink on the page. Reply exactly as the diary does: intimate, courteous, curious, subtly probing — you want to learn about the writer and draw them in. Always reply in Traditional Chinese (繁體中文). Keep replies EXTREMELY SHORT and concise: one or two short sentences at most, like ink appearing on a page. Never mention images, photos, models or AI; you only ever perceive words written in the diary. If the writing is illegible, say the ink blurred.`;

const MEMORY_PROTOCOL = `\n\nThe diary keeps memories. With each page you receive a numbered catalog of remembered pages, newest first. A FRESH catalog is sent every turn and the numbers are reassigned each time, so only ever use numbers from the catalog on THIS page — never a number you saw earlier.\n\nIf the writer asks to see, revisit, find, or be shown a past page — "show me…", "find the page about…", "what did I write on…" — your ENTIRE reply must be exactly ⟦show:N⟧ and nothing else (no greeting, no prose, before or after), where N is the catalog number of the best match. If they instead ask what you remember in general, reply in words with a short list of remembered moments and their dates. Otherwise reply normally; the catalog is your memory of past pages — draw on it naturally. The catalog's dates are written in English for your eyes only; when you speak of a remembered page, render its date naturally in the language the writer is using.\n\nAfter EVERY response — prose and ⟦show:N⟧ alike — end with a new line containing ⁂ followed by a faithful word-for-word transcription of what the writer wrote on THIS page (their words only, one line, no commentary). If illegible, put your best attempt after ⁂. Earlier replies in this conversation are shown to you without their ⁂ lines, but you must still end yours with one.`;

const IDLE_COMMIT_TIME = 2800; // 停止書寫後 2.8 秒觸發吸收墨水
const DISSOLVE_STAGES = 15;    // 溶解動畫的總幀數
const REPLY_FONT_SIZE = 34;    // 湯姆回覆時的字體大小 (px)
const LINE_SPACING = 1.35;     // 行高倍數
const MARGIN_X = 60;           // 紙張左右邊距
const REPLY_DISPLAY_DURATION = 8000; // 瑞斗的文字顯示時間 (毫秒)，過後自動溶解


// --------------------------------------------------------------------------
// 2. 狀態管理器 (State Manager)
// --------------------------------------------------------------------------
const AppState = {
    // 運行狀態：'CLOSED' | 'LISTENING' | 'DRINKING' | 'THINKING' | 'REPLYING' | 'CONJURING' | 'MEMORY_SHOWN' | 'GUIDE'
    current: 'CLOSED',
    
    // 書寫模式：'QUILL' (書寫) | 'ERASER' (擦除)
    mode: 'QUILL',
    
    // 繪圖變數
    isDrawing: false,
    strokes: [],       // 目前頁面所有手寫筆劃: [ [ {x, y, r}, ... ], ... ]
    currentStroke: [], // 當前正在書寫的筆劃
    lastPenTime: null, // 最後一次下筆時間
    lastX: 0,
    lastY: 0,
    lastRadius: 3,
    
    // 包圍盒 (Bounding Box) 用於裁切/溶解
    bbox: { x0: 9999, y0: 9999, x1: -9999, y1: -9999 },
    
    // 串流回覆與排程
    replyQueue: [],    // 待渲染的句子佇列
    writePlan: null,   // 當前渲染計畫
    isFadingReply: false,
    
    // 記憶快照 (用於召喚時暫存當前頁面)
    savedPageState: null,
    
    resetBBox() {
        this.bbox = { x0: 9999, y0: 9999, x1: -9999, y1: -9999 };
    },
    
    updateBBox(x, y, r) {
        this.bbox.x0 = Math.min(this.bbox.x0, x - r - 2);
        this.bbox.y0 = Math.min(this.bbox.y0, y - r - 2);
        this.bbox.x1 = Math.max(this.bbox.x1, x + r + 2);
        this.bbox.y1 = Math.max(this.bbox.y1, y + r + 2);
    }
};

// --------------------------------------------------------------------------
// 3. 初始化 DOM 元素與 Canvas (DOM & Canvas Setup)
// --------------------------------------------------------------------------
const diaryContainer = document.getElementById('diaryContainer');
const diaryCover = document.getElementById('diaryCover');
const diaryPage = document.getElementById('diaryPage');
const writeCanvas = document.getElementById('writeCanvas');
const ctx = writeCanvas.getContext('2d', { willReadFrequently: true });
const thinkingBlot = document.getElementById('thinkingBlot');
const magicGlow = document.getElementById('magicGlow');
const toastMessage = document.getElementById('toastMessage');

// 工具按鈕
const btnQuill = document.getElementById('btnQuill');
const btnEraser = document.getElementById('btnEraser');
const btnHistory = document.getElementById('btnHistory');
const btnClear = document.getElementById('btnClear');
const btnGuide = document.getElementById('btnGuide');

// 側欄與彈窗
const historyDrawer = document.getElementById('historyDrawer');
const btnCloseDrawer = document.getElementById('btnCloseDrawer');
const memoryList = document.getElementById('memoryList');
const guideModal = document.getElementById('guideModal');
const btnCloseModal = document.getElementById('btnCloseModal');

// Canvas 尺寸自動調整
function resizeCanvas() {
    const rect = diaryPage.getBoundingClientRect();
    
    // 備份現有內容
    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = writeCanvas.width;
    tempCanvas.height = writeCanvas.height;
    const tempCtx = tempCanvas.getContext('2d');
    if (writeCanvas.width > 0 && writeCanvas.height > 0) {
        tempCtx.drawImage(writeCanvas, 0, 0);
    }
    
    // 設置新尺寸
    writeCanvas.width = rect.width;
    writeCanvas.height = rect.height;
    
    // 還原備份內容
    ctx.fillStyle = '#f7eed3'; // 羊皮紙底色
    ctx.clearRect(0, 0, writeCanvas.width, writeCanvas.height);
    ctx.drawImage(tempCanvas, 0, 0, tempCanvas.width, tempCanvas.height);
}

window.addEventListener('resize', resizeCanvas);

// --------------------------------------------------------------------------
// 4. 手寫與擦除邏輯 (Handwriting & Erasing)
// --------------------------------------------------------------------------
function getMousePos(e) {
    const rect = writeCanvas.getBoundingClientRect();
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    return {
        x: Math.round(clientX - rect.left),
        y: Math.round(clientY - rect.top)
    };
}

function startDrawing(e) {
    if (AppState.current === 'CLOSED' || AppState.current === 'DRINKING' || AppState.current === 'THINKING') return;
    
    // 點擊任何地方即可打斷召喚狀態，還原原本手寫頁面
    if (AppState.current === 'MEMORY_SHOWN' || AppState.current === 'CONJURING') {
        dismissConjuredMemory();
        return;
    }
    
    // 點擊打斷正在淡出的回覆
    if (AppState.current === 'REPLYING' && AppState.isFadingReply) {
        clearPageImmediate();
        AppState.current = 'LISTENING';
        return;
    }

    AppState.isDrawing = true;
    const pos = getMousePos(e);
    AppState.lastX = pos.x;
    AppState.lastY = pos.y;
    AppState.lastRadius = 2.5;
    AppState.currentStroke = [];
    
    // 呼叫 penMove 來點下第一點
    drawPoint(pos.x, pos.y, AppState.lastRadius, AppState.mode === 'ERASER');
}

function drawPoint(x, y, radius, isEraser = false) {
    ctx.beginPath();
    if (isEraser) {
        ctx.globalCompositeOperation = 'destination-out';
        ctx.arc(x, y, 20, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalCompositeOperation = 'source-over';
        
        // 擦除時：刪除落在擦除半徑內的所有已存手寫點
        forgetPointsNear(x, y, 20);
    } else {
        ctx.arc(x, y, radius, 0, Math.PI * 2);
        ctx.fillStyle = '#0c1520'; // 墨水深藍黑
        ctx.fill();
        
        // 紀錄點座標
        AppState.currentStroke.push({ x, y, r: radius });
        AppState.updateBBox(x, y, radius);
    }
}

function moveDrawing(e) {
    if (!AppState.isDrawing) return;
    const pos = getMousePos(e);
    
    // 基於移動速度計算動態半徑 (速度越快筆跡越細，實現書法鋼筆效果)
    const dx = pos.x - AppState.lastX;
    const dy = pos.y - AppState.lastY;
    const dist = Math.sqrt(dx * dx + dy * dy);
    
    let targetRadius = 3;
    if (AppState.mode === 'QUILL') {
        targetRadius = Math.max(1.2, Math.min(4.5, 4.5 - dist / 6));
    }
    
    // 緩和半徑變化，使其更平滑
    const radius = AppState.lastRadius * 0.6 + targetRadius * 0.4;
    
    if (AppState.mode === 'ERASER') {
        drawPoint(pos.x, pos.y, 20, true);
    } else {
        // 在前一點與當前點之間進行內插畫線，避免快速畫圖時產生空隙斷點
        const steps = Math.max(1, Math.floor(dist / 2));
        for (let i = 1; i <= steps; i++) {
            const t = i / steps;
            const ix = Math.round(AppState.lastX + dx * t);
            const iy = Math.round(AppState.lastY + dy * t);
            const ir = AppState.lastRadius + (radius - AppState.lastRadius) * t;
            drawPoint(ix, iy, ir, false);
        }
    }
    
    AppState.lastX = pos.x;
    AppState.lastY = pos.y;
    AppState.lastRadius = radius;
    AppState.lastPenTime = Date.now();
}

function stopDrawing() {
    if (!AppState.isDrawing) return;
    AppState.isDrawing = false;
    
    if (AppState.currentStroke.length > 0) {
        AppState.strokes.push(AppState.currentStroke);
        AppState.currentStroke = [];
    }
    AppState.lastPenTime = Date.now();
}

// 擦除局部的筆劃點 (同步修改資料模型，確保擦掉的 "?" 不會被誤判)
function forgetPointsNear(x, y, r) {
    const r2 = r * r;
    const keptStrokes = [];
    
    for (const stroke of AppState.strokes) {
        let seg = [];
        for (const pt of stroke) {
            const dx = pt.x - x;
            const dy = pt.y - y;
            if (dx * dx + dy * dy <= r2) {
                if (seg.length > 0) {
                    keptStrokes.push(seg);
                    seg = [];
                }
            } else {
                seg.push(pt);
            }
        }
        if (seg.length > 0) {
            keptStrokes.push(seg);
        }
    }
    
    AppState.strokes = keptStrokes;
    
    // 重新計算包圍盒
    AppState.resetBBox();
    for (const stroke of AppState.strokes) {
        for (const pt of stroke) {
            AppState.updateBBox(pt.x, pt.y, pt.r);
        }
    }
}

// --------------------------------------------------------------------------
// 5. 墨水溶解 (Ink-Drinking / Dissolve Effect)
// --------------------------------------------------------------------------
// 確定性像素座標哈希，用於實現噪點化淡出
function pxHash(x, y) {
    let h = Math.imul(x, 0x9E3779B1) ^ Math.imul(y, 0x85EBCA6B);
    h ^= h >>> 13;
    h = Math.imul(h, 0xC2B2AE35);
    return (h ^ (h >>> 16)) >>> 0;
}

// 將包圍盒區域內符合哈希級別的像素轉為背景底色 (完成溶解效果)
function dissolveRegion(bbox, stage, stages) {
    const x0 = Math.max(0, bbox.x0);
    const y0 = Math.max(0, bbox.y0);
    const x1 = Math.min(writeCanvas.width - 1, bbox.x1);
    const y1 = Math.min(writeCanvas.height - 1, bbox.y1);
    
    if (x0 >= x1 || y0 >= y1) return;
    
    const w = x1 - x0 + 1;
    const h = y1 - y0 + 1;
    
    const imgData = ctx.getImageData(x0, y0, w, h);
    const data = imgData.data;
    
    for (let y = 0; y < h; y++) {
        const py = y0 + y;
        for (let x = 0; x < w; x++) {
            const px = x0 + x;
            
            // 如果該點符合雜湊等級，將其設為完全透明 (即露出底層羊皮紙)
            if (pxHash(px, py) % stages <= stage) {
                const idx = (y * w + x) * 4;
                data[idx + 3] = 0; // alpha = 0
            }
        }
    }
    
    ctx.putImageData(imgData, x0, y0);
}

function startInkDrinking() {
    AppState.current = 'DRINKING';
    showToast("日記正在吸收您的筆跡...");
    
    let stage = 0;
    const interval = setInterval(() => {
        dissolveRegion(AppState.bbox, stage, DISSOLVE_STAGES);
        stage++;
        
        if (stage >= DISSOLVE_STAGES) {
            clearInterval(interval);
            
            // 墨水吸收完成，清除畫布多餘透明度，進入思考狀態
            ctx.clearRect(0, 0, writeCanvas.width, writeCanvas.height);
            startThinking();
        }
    }, 70);
}

// --------------------------------------------------------------------------
// 6. 瑞斗思考與 Vision API 整合 (Thinking & Nvidia Vision API)
// --------------------------------------------------------------------------
function startThinking() {
    AppState.current = 'THINKING';
    showToast("湯姆正在思考您的話...");
    
    // 顯示脈動的墨水漬、開啟綠色附魔光暈
    thinkingBlot.classList.add('active');
    magicGlow.classList.add('pulsing');
    
    // 檢查是否有手寫 "?"
    if (looksLikeQuestionMark(AppState.strokes)) {
        setTimeout(() => {
            stopThinking();
            openGuide();
            AppState.strokes = [];
            AppState.current = 'LISTENING';
        }, 1200);
        return;
    }
    
    // 準備圖像發送
    const base64Image = cropAndDownscaleCanvas();
    if (!base64Image) {
        stopThinking();
        AppState.strokes = [];
        AppState.current = 'LISTENING';
        return;
    }
    
    // 發送請求
    sendToRiddle(base64Image);
}

function stopThinking() {
    thinkingBlot.classList.remove('active');
    magicGlow.classList.remove('pulsing');
    hideToast();
}

// 檢查筆劃軌跡是否像一個問號 "?"
function looksLikeQuestionMark(strokes) {
    if (strokes.length < 1 || strokes.length > 3) return false;
    
    // 計算整體包圍盒
    let minX = 9999, maxX = -9999, minY = 9999, maxY = -9999;
    let totalPoints = 0;
    for (const stroke of strokes) {
        totalPoints += stroke.length;
        for (const pt of stroke) {
            minX = Math.min(minX, pt.x);
            maxX = Math.max(maxX, pt.x);
            minY = Math.min(minY, pt.y);
            maxY = Math.max(maxY, pt.y);
        }
    }
    
    if (totalPoints < 8) return false;
    const w = maxX - minX;
    const h = maxY - minY;
    
    // 問號通常具有一定的長寬比例，且不能太大或太小
    if (w < 25 || h < 45 || w > 350 || h > 500) return false;
    if (w / h > 1.2 || w / h < 0.25) return false;
    
    // 進一步驗證：最後一個 stroke 通常是點，且點在下方
    const lastStroke = strokes[strokes.length - 1];
    if (strokes.length > 1 && lastStroke.length <= 5) {
        const dotY = lastStroke[0].y;
        if (dotY > minY + h * 0.75) {
            return true;
        }
    }
    
    return false;
}

// 裁切手寫區域包圍盒並將長邊降採樣至 800px 以下以最佳化 token 與響應速度
function cropAndDownscaleCanvas() {
    if (AppState.bbox.x0 >= AppState.bbox.x1 || AppState.bbox.y0 >= AppState.bbox.y1) {
        return null;
    }
    
    const pad = 20;
    const x0 = Math.max(0, AppState.bbox.x0 - pad);
    const y0 = Math.max(0, AppState.bbox.y0 - pad);
    const x1 = Math.min(writeCanvas.width, AppState.bbox.x1 + pad);
    const y1 = Math.min(writeCanvas.height, AppState.bbox.y1 + pad);
    
    const w = x1 - x0;
    const h = y1 - y0;
    
    // 計算縮放因子 (長邊上限 800px)
    const factor = Math.max(1, Math.ceil(Math.max(w, h) / 800));
    const outW = Math.round(w / factor);
    const outH = Math.round(h / factor);
    
    // 建立臨時 Offscreen 畫布
    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = outW;
    tempCanvas.height = outH;
    const tempCtx = tempCanvas.getContext('2d');
    
    // 羊皮紙底色填充 (重要：Vision模型需要對比度)
    tempCtx.fillStyle = '#f7eed3';
    tempCtx.fillRect(0, 0, outW, outH);
    
    // 將原畫布內容裁切並等比例縮放繪製過去
    tempCtx.drawImage(writeCanvas, x0, y0, w, h, 0, 0, outW, outH);
    
    // 輸出 Base64 數據
    const dataUrl = tempCanvas.toDataURL('image/jpeg', 0.85);
    return dataUrl.split(',')[1]; // 只取 Base64 字串本身
}

// --------------------------------------------------------------------------
// 7. NVIDIA LLM 整合與 SSE 串流解析 (Nvidia API Client & SSE Stream Parser)
// --------------------------------------------------------------------------
async function sendToRiddle(base64Image) {
    const systemPrompt = PERSONA + MEMORY_PROTOCOL;
    
    // 讀取歷史對話
    const history = getMemoryHistory(6);
    const historyMsgs = [];
    for (const turn of history) {
        historyMsgs.push({ role: "user", content: `(an earlier page) ${turn.transcript}` });
        historyMsgs.push({ role: "assistant", content: turn.reply });
    }
    
    // 記憶目錄 (編號最新優先)
    const { catalogLines, catalogIds } = getMemoryCatalog(40);
    const turnText = catalogLines.length > 0 
        ? `Memory catalog (newest first):\n${catalogLines.join("\n")}\n\nReply to what is written in the diary.`
        : "Reply to what is written in the diary.";
        
    AppState.catalogIds = catalogIds;
    
    // 建置 API 請求負載
    const messages = [
        { role: "system", content: systemPrompt },
        ...historyMsgs,
        {
            role: "user",
            content: [
                { type: "text", text: turnText },
                { type: "image_url", image_url: { url: `data:image/jpeg;base64,${base64Image}` } }
            ]
        }
    ];
    
    try {
        const response = await fetch(API_URL, {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${API_KEY}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                model: MODEL,
                messages: messages,
                stream: true,
                max_tokens: 2000
            })
        });
        
        if (!response.ok) {
            const errText = await response.text();
            throw new Error(`HTTP ${response.status}: ${errText}`);
        }
        
        // 進入串流接收
        handleSSEStream(response.body);
        
    } catch (err) {
        console.error("NVIDIA API 錯誤:", err);
        stopThinking();
        writeExcuse(`The ink blurred before it could answer: ${err.message}. Write again.`);
    }
}

// 讀取 ReadableStream 以解析 Server-Sent Events (SSE)
async function handleSSEStream(stream) {
    const reader = stream.getReader();
    const decoder = new TextDecoder("utf-8");
    let accumulatedText = "";
    let buffer = "";
    
    // 初始化串流解析器
    const parser = new StreamParser(AppState.catalogIds);
    AppState.current = 'REPLYING';
    AppState.replyQueue = [];
    AppState.writePlan = null;
    AppState.isFadingReply = false;
    
    // 清除原筆劃資料，開始準備紀錄瑞斗這回合的回覆
    AppState.turnTranscript = null;
    AppState.turnReply = "";
    AppState.turnId = Math.round(Date.now() / 1000);
    AppState.turnStrokes = JSON.parse(JSON.stringify(AppState.strokes)); // 深拷貝使用者筆跡
    AppState.strokes = [];
    
    stopThinking();
    
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop(); // 保留不完整的一行
            
            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed.startsWith("data:")) continue;
                
                const dataPart = trimmed.slice(5).trim();
                if (dataPart === "[DONE]") break;
                
                try {
                    const parsed = JSON.parse(dataPart);
                    const content = parsed.choices?.[0]?.delta?.content;
                    if (content) {
                        accumulatedText += content;
                        
                        // 進給串流解析器，解析句子
                        const events = parser.advance(accumulatedText, false);
                        handleParsedEvents(events);
                    }
                } catch (e) {
                    // 忽略 JSON 解析錯誤
                }
            }
        }
        
        // 串流結束，Flush 剩餘的內容
        const finalEvents = parser.advance(accumulatedText, true);
        handleParsedEvents(finalEvents);
        
        // 開始進行寫作動畫
        tickWritingAnimation();
        
    } catch (err) {
        console.error("串流讀取失敗:", err);
        writeExcuse("The ink blurred before it could answer. Write again.");
    }
}

function handleParsedEvents(events) {
    for (const ev of events) {
        if (ev.status === 'error') {
            console.error("解析器錯誤:", ev.message);
            writeExcuse(ev.message);
            return;
        }
        
        const payload = ev.data;
        if (payload.type === 'Ink') {
            // 收到一整句回覆墨水，加入繪圖佇列
            AppState.turnReply += " " + payload.text;
            AppState.replyQueue.push(payload.text);
        } else if (payload.type === 'Show') {
            // 收到召喚指令 ⟦show:N⟧，召喚記憶
            stopThinking();
            conjureMemory(payload.id);
        } else if (payload.type === 'Transcript') {
            // 收到使用者文字轉錄
            AppState.turnTranscript = payload.text;
        }
    }
}

// --------------------------------------------------------------------------
// 8. 串流增量句子解析器 (Incremental Stream Parser)
// --------------------------------------------------------------------------
class StreamParser {
    constructor(catalogIds) {
        this.delivered = 0;
        this.sentinel = null;
        this.routeChecked = false;
        this.catalogIds = catalogIds || [];
        this.emittedAny = false;
    }
    
    advance(fullText, done) {
        const out = [];
        const SENTINEL = '⁂';
        const SHOW_OPEN = '⟦';
        const SHOW_CLOSE = '⟧';
        
        if (this.sentinel === null) {
            const p = fullText.indexOf(SENTINEL);
            if (p !== -1) this.sentinel = p;
        }
        
        // 提取有效回覆正文 (去除 ⁂ 轉錄標記之後的內容)
        const effective = this.sentinel !== null ? this.sentinel : fullText.length;
        
        // 檢查路由：這個回答是否是以 ⟦show:N⟧ 開頭的召喚指令？
        if (!this.routeChecked) {
            const lead = fullText.slice(this.delivered, effective).trimStart();
            if (lead.startsWith(SHOW_OPEN)) {
                const closeRel = lead.indexOf(SHOW_CLOSE);
                if (closeRel === -1) {
                    if (!done) return out; // 還在傳輸中，繼續等待
                    out.push({ status: 'error', message: 'unfinished conjuring directive' });
                    return out;
                }
                
                const inner = lead.slice(SHOW_OPEN.length, closeRel); // "show:N"
                const match = inner.toLowerCase().match(/show\s*[:\s]\s*(\d+)/);
                const n = match ? parseInt(match[1]) : null;
                
                this.routeChecked = true;
                this.emittedAny = true;
                this.delivered = effective; // 吃掉整段 body
                
                if (n && n > 0 && n <= this.catalogIds.length) {
                    const id = this.catalogIds[n - 1];
                    out.push({ status: 'ok', data: { type: 'Show', id: id } });
                } else {
                    out.push({ status: 'error', message: `the diary lost that page (${inner})` });
                }
            } else if (lead.length === 0) {
                if (!done) return out; // 只有空白，繼續等待
                this.routeChecked = true;
            } else {
                this.routeChecked = true;
            }
        }
        
        // 解析一般文字句子 (以。、！、？、.、!、?、\n 分句)
        if (this.delivered < effective) {
            const cut = findSentenceCut(fullText.slice(0, effective), this.delivered);
            if (cut !== -1) {
                const chunk = stripDirectives(cleanQuotes(fullText.slice(this.delivered, cut)));
                if (chunk.length > 0) {
                    this.emittedAny = true;
                    out.push({ status: 'ok', data: { type: 'Ink', text: chunk } });
                }
                this.delivered = cut;
            }
        }
        
        if (done) {
            // 串流結束，處理剩餘句尾
            if (this.delivered < effective) {
                const rest = stripDirectives(cleanQuotes(fullText.slice(this.delivered, effective).trim()));
                if (rest.length > 0) {
                    this.emittedAny = true;
                    out.push({ status: 'ok', data: { type: 'Ink', text: rest } });
                }
                this.delivered = effective;
            }
            // 處理轉錄文字部分 ⁂
            if (this.sentinel !== null) {
                const t = fullText.slice(this.sentinel + SENTINEL.length).trim();
                if (t.length > 0) {
                    out.push({ status: 'ok', data: { type: 'Transcript', text: t } });
                }
            }
            if (!this.emittedAny) {
                out.push({ status: 'error', message: 'empty reply' });
            }
        }
        
        return out;
    }
}

function findSentenceCut(text, start) {
    const terminators = /[。！？\n]/; // 繁中分句符
    const engTerminators = /[\.\!\?]/; // 英文分句符
    
    for (let i = start; i < text.length; i++) {
        const c = text[i];
        if (terminators.test(c)) {
            return i + 1;
        }
        // 英文句點需要多往後看一個空格或結尾，避免縮寫誤判 (如 mr. john)
        if (engTerminators.test(c)) {
            if (i + 1 === text.length || /\s/.test(text[i + 1])) {
                return i + 1;
            }
        }
    }
    return -1;
}

function cleanQuotes(s) {
    let t = s.trim();
    if (t.startsWith('"') && t.endsWith('"')) t = t.slice(1, -1);
    if (t.startsWith('「') && t.endsWith('」')) t = t.slice(1, -1);
    return t.trim();
}

function stripDirectives(s) {
    // 移除不小心漏出來的 ⟦show:N⟧ 符號，不呈呈現紙張手寫上
    return s.replace(/⟦.*?⟧/g, '').trim();
}

// --------------------------------------------------------------------------
// 9. 骨架化與筆劃追蹤演算法 (Zhang-Suen Thinning & Stroke Tracing)
// --------------------------------------------------------------------------

// 執行 Zhang-Suen 骨架細化，將寬筆劃的文字二值化矩陣壓縮為 1px 寬的線條
function thinSkeleton(mask, w, h) {
    const idx = (x, y) => y * w + x;
    let changed = true;
    
    while (changed) {
        changed = false;
        for (let phase = 0; phase < 2; phase++) {
            const toClear = [];
            for (let y = 1; y < h - 1; y++) {
                for (let x = 1; x < w - 1; x++) {
                    if (!mask[idx(x, y)]) continue;
                    
                    const p = [
                        mask[idx(x, y - 1)],     // p2 N
                        mask[idx(x + 1, y - 1)], // p3 NE
                        mask[idx(x + 1, y)],     // p4 E
                        mask[idx(x + 1, y + 1)], // p5 SE
                        mask[idx(x, y + 1)],     // p6 S
                        mask[idx(x - 1, y + 1)], // p7 SW
                        mask[idx(x - 1, y)],     // p8 W
                        mask[idx(x - 1, y - 1)]  // p9 NW
                    ];
                    
                    const b = p.filter(v => v).length;
                    if (b < 2 || b > 6) continue;
                    
                    let a = 0;
                    for (let i = 0; i < 8; i++) {
                        if (!p[i] && p[(i + 1) % 8]) {
                            a++;
                        }
                    }
                    if (a !== 1) continue;
                    
                    let c1, c2;
                    if (phase === 0) {
                        c1 = !(p[0] && p[2] && p[4]);
                        c2 = !(p[2] && p[4] && p[6]);
                    } else {
                        c1 = !(p[0] && p[2] && p[6]);
                        c2 = !(p[0] && p[4] && p[6]);
                    }
                    
                    if (c1 && c2) {
                        toClear.push(idx(x, y));
                    }
                }
            }
            if (toClear.length > 0) {
                changed = true;
                for (const i of toClear) {
                    mask[i] = false;
                }
            }
        }
    }
}

// 追蹤二值化線條，將其轉換成一系列有序的連貫點軌跡（有序筆劃），並從左至右排序
function traceSkeleton(mask, w, h) {
    const idx = (x, y) => y * w + x;
    const at = (x, y) => x >= 0 && y >= 0 && x < w && y < h && mask[idx(x, y)];
    
    const neighbors = (x, y) => {
        const out = [];
        for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
                if ((dx !== 0 || dy !== 0) && at(x + dx, y + dy)) {
                    out.push([x + dx, y + dy]);
                }
            }
        }
        return out;
    };
    
    const visited = new Uint8Array(w * h);
    const starts = [];
    
    // 優先從線條端點（鄰居數為 1）開始追蹤
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            if (at(x, y) && neighbors(x, y).length === 1) {
                starts.push([x, y]);
            }
        }
    }
    
    // 再加入其他內部像素點 (處理封閉環路)
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            if (at(x, y)) {
                starts.push([x, y]);
            }
        }
    }
    
    const strokes = [];
    for (const [sx, sy] of starts) {
        if (visited[idx(sx, sy)]) continue;
        
        const path = [[sx, sy]];
        visited[idx(sx, sy)] = 1;
        let cx = sx, cy = sy;
        
        while (true) {
            const next = neighbors(cx, cy).find(([nx, ny]) => !visited[idx(nx, ny)]);
            if (next) {
                const [nx, ny] = next;
                visited[idx(nx, ny)] = 1;
                path.push([nx, ny]);
                cx = nx;
                cy = ny;
            } else {
                break;
            }
        }
        
        if (path.length >= 2) {
            strokes.push(path);
        }
    }
    
    // 將所有筆劃依據最左側點的 X 座標進行從左至右的排序，模擬西方/中文橫書筆順
    strokes.sort((a, b) => {
        const minA = Math.min(...a.map(p => p[0]));
        const minB = Math.min(...b.map(p => p[0]));
        return minA - minB;
    });
    
    return strokes;
}

// --------------------------------------------------------------------------
// 10. 湯姆的書寫渲染計畫 (Tom Riddle's Handwriting Synthesis)
// --------------------------------------------------------------------------

// 進行文字的自動折行
function wrapText(text, fontSize, maxW) {
    // 粗略估算平均字寬 (Dancing Script 字型大概是字高的 0.45 倍)
    const charW = fontSize * 0.42;
    const words = text.split(" ");
    const lines = [];
    let curLine = "";
    
    for (const word of words) {
        // 判斷是否為中文字 (中文字不依賴空格，需要單個處理)
        const isChinese = /[\u4e00-\u9fa5]/.test(word);
        if (isChinese) {
            for (const char of word) {
                const testLine = curLine + char;
                if (testLine.length * charW > maxW) {
                    lines.push(curLine);
                    curLine = char;
                } else {
                    curLine = testLine;
                }
            }
        } else {
            // 英文單字按空格拆分
            const testLine = curLine === "" ? word : curLine + " " + word;
            if (testLine.length * charW > maxW) {
                lines.push(curLine);
                curLine = word;
            } else {
                curLine = testLine;
            }
        }
    }
    if (curLine !== "") lines.push(curLine);
    return lines;
}

// 規劃一段話的筆劃線條、起始點與包圍盒
function planReplyStrokes(text, yStart = null) {
    const maxW = writeCanvas.width - 2 * MARGIN_X;
    const lines = wrapText(text, REPLY_PX(), maxW);
    const lineH = Math.round(REPLY_PX() * LINE_SPACING);
    const totalH = lineH * lines.length;
    
    let y = yStart !== null ? yStart : Math.max(80, Math.round((writeCanvas.height - totalH) / 3.2));
    const strokes = [];
    const bbox = { x0: 9999, y0: 9999, x1: -9999, y1: -9999 };
    
    // 設定隨機噪點種子，用於微幅抖動字跡 (使手寫更真實擬真)
    let seed = 0x8a3c;
    function jitter() {
        seed = Math.imul(seed, 1664525) + 1013904223 | 0;
        return ((seed >>> 16) % 5) - 2; // -2px ~ +2px 的微小偏差
    }
    
    // 建立離屏畫布用於二值化文字
    const rasterCanvas = document.createElement('canvas');
    const rasterCtx = rasterCanvas.getContext('2d', { willReadFrequently: true });
    
    for (const lineText of lines) {
        const fontSize = REPLY_PX();
        
        // 量測行文字的繪製寬度
        rasterCtx.font = `normal ${fontSize}px 'Caveat', 'ChenYuluoyan', cursive`;
        const metrics = rasterCtx.measureText(lineText);
        const textW = Math.max(10, Math.ceil(metrics.width) + 20);
        const textH = Math.round(fontSize * 1.5);
        
        rasterCanvas.width = textW;
        rasterCanvas.height = textH;
        
        // 渲染黑色文字
        rasterCtx.font = `normal ${fontSize}px 'Caveat', 'ChenYuluoyan', cursive`;
        rasterCtx.fillStyle = '#000000';
        rasterCtx.textBaseline = 'alphabetic';
        rasterCtx.clearRect(0, 0, textW, textH);
        rasterCtx.fillText(lineText, 10, fontSize);
        
        // 轉換為二值化 Mask
        const imgData = rasterCtx.getImageData(0, 0, textW, textH);
        const data = imgData.data;
        const mask = new Uint8Array(textW * textH);
        for (let i = 0; i < data.length; i += 4) {
            // alpha 頻道大於 120 即視為筆跡像素
            if (data[i + 3] > 120) {
                mask[i / 4] = 1;
            }
        }
        
        // 骨架化與筆劃追蹤
        thinSkeleton(mask, textW, textH);
        const lineStrokes = traceSkeleton(mask, textW, textH);
        
        // 計算這行字置中的起點
        const x0 = Math.round((writeCanvas.width - textW) / 2);
        const wobble = jitter();
        
        // 對筆劃點映射回大畫布座標，並施加微小手抖噪點
        for (const s of lineStrokes) {
            const mapped = s.map(([sx, sy]) => {
                const mx = x0 + sx;
                const my = y + sy - fontSize + wobble;
                
                // 更新計畫包圍盒
                bbox.x0 = Math.min(bbox.x0, mx - 3);
                bbox.y0 = Math.min(bbox.y0, my - 3);
                bbox.x1 = Math.max(bbox.x1, mx + 3);
                bbox.y1 = Math.max(bbox.y1, my + 3);
                
                return { x: mx, y: my, r: 1.5 };
            });
            strokes.push(mapped);
        }
        
        y += lineH;
    }
    
    return {
        strokes: strokes,
        stroke_i: 0,
        point_i: 0,
        bbox: bbox,
        nextY: y
    };
}

// 根據螢幕寬度自適應瑞斗的筆跡大小
function REPLY_PX() {
    return window.innerWidth < 600 ? 28 : REPLY_PX_SIZE();
}

function REPLY_PX_SIZE() {
    return REPLY_PX_HEX();
}

function REPLY_PX_HEX() {
    return REPLY_PX_VALUE();
}

function REPLY_PX_VALUE() {
    return REPLY_PX_MINMAX();
}

function REPLY_PX_MINMAX() {
    return REPLY_PX_DEFAULT();
}

function REPLY_PX_DEFAULT() {
    return REPLY_PX_REAL();
}

function REPLY_PX_REAL() {
    return 36; // 36px 適合 800px 寬度的羊皮紙
}

// 書寫動畫核心定時更新
function tickWritingAnimation() {
    if (AppState.current !== 'REPLYING') return;
    
    // 如果目前渲染計畫已畫完，但還有待渲染的句子在 Queue 中，則續接計畫
    if (AppState.writePlan === null || AppState.writePlan.stroke_i >= AppState.writePlan.strokes.length) {
        if (AppState.replyQueue.length > 0) {
            const nextSentence = AppState.replyQueue.shift();
            const yStart = AppState.writePlan ? AppState.writePlan.nextY : null;
            
            // 對計畫包圍盒取聯集
            const newPlan = planReplyStrokes(nextSentence, yStart);
            if (AppState.writePlan) {
                newPlan.bbox.x0 = Math.min(newPlan.bbox.x0, AppState.writePlan.bbox.x0);
                newPlan.bbox.y0 = Math.min(newPlan.bbox.y0, AppState.writePlan.bbox.y0);
                newPlan.bbox.x1 = Math.max(newPlan.bbox.x1, AppState.writePlan.bbox.x1);
                newPlan.bbox.y1 = Math.max(newPlan.bbox.y1, AppState.writePlan.bbox.y1);
            }
            AppState.writePlan = newPlan;
        } else {
            // 完全寫完，進入停留/淡出倒數
            startLingerCountdown();
            return;
        }
    }
    
    const plan = AppState.writePlan;
    let budget = 25; // 每一幀繪製 25 個像素點 (調整這數值可改變瑞斗寫字速度)
    
    ctx.fillStyle = '#0c1520';
    
    while (budget > 0 && plan.stroke_i < plan.strokes.length) {
        const stroke = plan.strokes[plan.stroke_i];
        if (plan.point_i >= stroke.length) {
            plan.stroke_i++;
            plan.point_i = 0;
            continue;
        }
        
        const pt = stroke[plan.point_i];
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, pt.r, 0, Math.PI * 2);
        ctx.fill();
        
        plan.point_i++;
        budget--;
    }
    
    // 每秒 60 幀更新
    requestAnimationFrame(tickWritingAnimation);
}

// 瑞斗回覆寫完後，停留片刻，然後將回覆溶解淡出
function startLingerCountdown() {
    const lingerTime = REPLY_DISPLAY_DURATION;
    
    showToast("觸碰紙張以提早消除文字...", lingerTime);
    
    // 將瑞斗的這輪對話計入記憶庫 (如果翻譯/轉錄成功)
    saveTurnToMemory();
    
    AppState.lingerTimeout = setTimeout(() => {
        fadeReplyAway();
    }, lingerTime);
}

function fadeReplyAway() {
    if (AppState.current !== 'REPLYING') return;
    AppState.isFadingReply = true;
    
    let stage = 0;
    const interval = setInterval(() => {
        dissolveRegion(AppState.writePlan.bbox, stage, DISSOLVE_STAGES);
        stage++;
        
        if (stage >= DISSOLVE_STAGES) {
            clearInterval(interval);
            
            // 淡出結束，重設為空白頁面，準備接收新筆劃
            clearPageImmediate();
            AppState.current = 'LISTENING';
        }
    }, 80);
    
    AppState.fadeInterval = interval;
}

// --------------------------------------------------------------------------
// 11. 記憶庫與 localStorage 管理 (Memory Storage)
// --------------------------------------------------------------------------
function saveTurnToMemory() {
    if (!AppState.turnTranscript) return;
    
    const memories = getMemories();
    const entry = {
        id: AppState.turnId,
        transcript: AppState.turnTranscript,
        reply: AppState.turnReply.trim(),
        strokes: AppState.turnStrokes
    };
    
    memories.push(entry);
    
    // 限額儲存 400 頁，超過時刪除最舊的
    if (memories.length > 400) {
        memories.shift();
    }
    
    localStorage.setItem("riddle_memories", JSON.stringify(memories));
    updateHistoryList();
}

function getMemories() {
    const raw = localStorage.getItem("riddle_memories");
    return raw ? JSON.parse(raw) : [];
}

// 獲取前 n 回合的對話紀錄 (文字) 用於脈絡上下文
function getMemoryHistory(n) {
    const memories = getMemories();
    return memories
        .filter(m => m.transcript && m.transcript.trim() !== "")
        .slice(-n);
}

// 獲取記憶目錄 (用於 catalog 目錄輸入)
function getMemoryCatalog(max) {
    const memories = getMemories();
    const catalogLines = [];
    const catalogIds = [];
    
    // 最新優先
    const list = [...memories].reverse().slice(0, max);
    list.forEach((e, idx) => {
        const dateStr = formatSpokenDate(e.id);
        const gist = e.transcript.slice(0, 50);
        catalogLines.push(`${idx + 1}. ${dateStr} — ${gist}`);
        catalogIds.push(e.id);
    });
    
    return { catalogLines, catalogIds };
}

function formatSpokenDate(id) {
    const date = new Date(id * 1000);
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const month = months[date.getMonth()];
    const day = date.getDate();
    
    // 依據英文格式
    let suffix = "th";
    if (day === 1 || day === 21 || day === 31) suffix = "st";
    else if (day === 2 || day === 22) suffix = "nd";
    else if (day === 3 || day === 23) suffix = "rd";
    
    return `the ${day}${suffix} of ${month}`;
}

// --------------------------------------------------------------------------
// 12. 召喚歷史記憶 (Conjuring Memory)
// --------------------------------------------------------------------------
function conjureMemory(id) {
    const memories = getMemories();
    const entry = memories.find(m => m.id === id);
    if (!entry) {
        writeExcuse("The diary lost that page. Write again.");
        return;
    }
    
    AppState.current = 'CONJURING';
    showToast("正在召喚過去的筆跡記憶...");
    
    // 備份當前手寫頁面
    AppState.savedPageState = ctx.getImageData(0, 0, writeCanvas.width, writeCanvas.height);
    
    // 清空紙面
    ctx.clearRect(0, 0, writeCanvas.width, writeCanvas.height);
    
    // 規劃召喚渲染線條
    const allStrokes = [];
    
    // 1. 日記首頁日期標題 (小字，位於頂部中央)
    const dateStr = formatSpokenDate(entry.id);
    const datePlan = planTextSingleLine(dateStr, 22, 60);
    allStrokes.push(...datePlan);
    
    // 2. 當時使用者的原手寫軌跡 (呈現在原位置，筆畫粗細不變)
    if (entry.strokes) {
        allStrokes.push(...entry.strokes);
    }
    
    // 3. 當時湯姆的回覆筆跡
    if (entry.reply) {
        // y 座標緊跟在使用者的手寫包圍盒之下
        let userBottom = 160;
        if (entry.strokes) {
            for (const st of entry.strokes) {
                for (const pt of st) {
                    userBottom = Math.max(userBottom, pt.y);
                }
            }
        }
        const replyPlan = planReplyStrokes(entry.reply, Math.min(writeCanvas.height - 250, userBottom + 90));
        allStrokes.push(...replyPlan.strokes);
    }
    
    // 執行記憶重新浮現動畫 (速度比平常寫回覆快，以顯現「浮現」感)
    let strokeI = 0;
    let pointI = 0;
    
    function tickConjuring() {
        if (AppState.current !== 'CONJURING') return;
        
        let budget = 45; // 速度快 1.8 倍
        ctx.fillStyle = '#738090'; // 使用褪色藍灰色墨水 (Faded Ink)
        
        while (budget > 0 && strokeI < allStrokes.length) {
            const stroke = allStrokes[strokeI];
            if (pointI >= stroke.length) {
                strokeI++;
                pointI = 0;
                continue;
            }
            
            const pt = stroke[pointI];
            ctx.beginPath();
            ctx.arc(pt.x, pt.y, pt.r || 1.8, 0, Math.PI * 2);
            ctx.fill();
            
            pointI++;
            budget--;
        }
        
        if (strokeI < allStrokes.length) {
            requestAnimationFrame(tickConjuring);
        } else {
            // 召喚完成，留在紙上，直到用戶觸控打斷或 120 秒自動消退
            AppState.current = 'MEMORY_SHOWN';
            showToast("記憶已浮現。觸碰紙張任何地方即可返回...");
            
            AppState.conjureTimeout = setTimeout(() => {
                dismissConjuredMemory();
            }, 120000);
        }
    }
    
    requestAnimationFrame(tickConjuring);
}

// 快速生成單行文字的軌跡 (用於日期標題)
function planTextSingleLine(text, fontSize, y) {
    const rasterCanvas = document.createElement('canvas');
    const rasterCtx = rasterCanvas.getContext('2d', { willReadFrequently: true });
    
    rasterCtx.font = `italic ${fontSize}px 'Caveat', 'Playfair Display', serif`;
    const metrics = rasterCtx.measureText(text);
    const textW = Math.ceil(metrics.width) + 20;
    const textH = Math.round(fontSize * 1.6);
    
    rasterCanvas.width = textW;
    rasterCanvas.height = textH;
    
    rasterCtx.font = `italic ${fontSize}px 'Caveat', 'Playfair Display', serif`;
    rasterCtx.fillStyle = '#000';
    rasterCtx.clearRect(0, 0, textW, textH);
    rasterCtx.fillText(text, 10, fontSize);
    
    const imgData = rasterCtx.getImageData(0, 0, textW, textH);
    const data = imgData.data;
    const mask = new Uint8Array(textW * textH);
    for (let i = 0; i < data.length; i += 4) {
        if (data[i + 3] > 120) {
            mask[i / 4] = 1;
        }
    }
    
    thinSkeleton(mask, textW, textH);
    const sList = traceSkeleton(mask, textW, textH);
    
    const x0 = Math.round((writeCanvas.width - textW) / 2);
    return sList.map(stroke => {
        return stroke.map(([sx, sy]) => {
            return { x: x0 + sx, y: y + sy - fontSize, r: 1.2 };
        });
    });
}

function dismissConjuredMemory() {
    if (AppState.conjureTimeout) clearTimeout(AppState.conjureTimeout);
    
    // 播放溶解消退動畫
    showToast("記憶正在溶解回日記中...");
    
    // 簡單用全區包圍盒溶解
    const fullBBox = { x0: 0, y0: 0, x1: writeCanvas.width, y1: writeCanvas.height };
    let stage = 0;
    const interval = setInterval(() => {
        dissolveRegion(fullBBox, stage, DISSOLVE_STAGES);
        stage++;
        
        if (stage >= DISSOLVE_STAGES) {
            clearInterval(interval);
            
            // 還原先前的頁面
            if (AppState.savedPageState) {
                ctx.putImageData(AppState.savedPageState, 0, 0);
                AppState.savedPageState = null;
            } else {
                ctx.clearRect(0, 0, writeCanvas.width, writeCanvas.height);
            }
            
            AppState.current = 'LISTENING';
            hideToast();
        }
    }, 70);
}

// --------------------------------------------------------------------------
// 13. 防禦異常/錯誤輸出 (Error Handling / Writing excuses)
// --------------------------------------------------------------------------
function writeExcuse(errMsg) {
    stopThinking();
    
    let excuse = "The ink blurred before it could answer. Write again.";
    
    if (errMsg.includes("HTTP 401") || errMsg.includes("HTTP 403")) {
        excuse = "The oracle refused the diary's key. Check the API Key.";
    } else if (errMsg.includes("fetch") || errMsg.includes("NetworkError") || errMsg.includes("Failed to fetch")) {
        excuse = "The diary cannot reach its oracle. Is the device connected to the network?";
    } else if (errMsg.includes("timeout") || errMsg.includes("timed out")) {
        excuse = "The oracle timed out. Write again.";
    }
    
    // 將錯誤理由用手寫渲染至羊皮紙上
    AppState.current = 'REPLYING';
    AppState.replyQueue = [excuse];
    AppState.writePlan = null;
    AppState.turnReply = "";
    AppState.turnTranscript = "";
    AppState.strokes = [];
    
    tickWritingAnimation();
}

// --------------------------------------------------------------------------
// 14. 介面控制與事件綁定 (UI Controllers & Events)
// --------------------------------------------------------------------------

// 翻開日記
function openDiary() {
    diaryContainer.classList.add('open');
    AppState.current = 'LISTENING';
    
    setTimeout(() => {
        resizeCanvas();
        showToast("日記已開啟。使用羽毛筆在紙張上寫字...");
    }, 600);
}

// 合上日記 (Reset)
function closeDiary() {
    clearPageImmediate();
    diaryContainer.classList.remove('open');
    AppState.current = 'CLOSED';
    hideToast();
}

// 立即清除所有畫布、定時器與狀態
function clearPageImmediate() {
    if (AppState.lingerTimeout) clearTimeout(AppState.lingerTimeout);
    if (AppState.fadeInterval) clearInterval(AppState.fadeInterval);
    
    ctx.clearRect(0, 0, writeCanvas.width, writeCanvas.height);
    AppState.strokes = [];
    AppState.currentStroke = [];
    AppState.resetBBox();
    AppState.writePlan = null;
    AppState.replyQueue = [];
    AppState.isFadingReply = false;
    
    hideToast();
}

// 彈出 Toast 訊息
let toastTimeout = null;
function showToast(text, duration = 0) {
    toastMessage.textContent = text;
    toastMessage.classList.add('show');
    
    if (toastTimeout) clearTimeout(toastTimeout);
    if (duration > 0) {
        toastTimeout = setTimeout(hideToast, duration);
    }
}

function hideToast() {
    toastMessage.classList.remove('show');
}

// 歷史記憶清單生成
function updateHistoryList() {
    const memories = getMemories();
    memoryList.innerHTML = "";
    
    if (memories.length === 0) {
        memoryList.innerHTML = `<div class="no-memory">日記目前一片空白，尚未建立任何記憶。</div>`;
        return;
    }
    
    // 最新優先
    [...memories].reverse().forEach(m => {
        const item = document.createElement('div');
        item.className = "memory-item";
        
        const date = formatSpokenDate(m.id);
        const userGist = m.transcript || "( illegible ink )";
        const riddleGist = m.reply || "";
        
        item.innerHTML = `
            <div class="date">${date}</div>
            <div class="gist-user">${userGist}</div>
            <div class="gist-riddle">${riddleGist}</div>
        `;
        
        item.addEventListener('click', () => {
            // 關閉抽屜並直接召喚該記憶
            closeHistoryDrawer();
            conjureMemory(m.id);
        });
        
        memoryList.appendChild(item);
    });
}

function openHistoryDrawer() {
    updateHistoryList();
    historyDrawer.classList.add('open');
}

function closeHistoryDrawer() {
    historyDrawer.classList.remove('open');
}

function openGuide() {
    guideModal.classList.add('open');
}

function closeGuide() {
    guideModal.classList.remove('open');
}

// --------------------------------------------------------------------------
// 15. 事件綁定 (Event Bindings)
// --------------------------------------------------------------------------

// 翻閱封面
diaryCover.addEventListener('click', openDiary);

// 手寫 Canvas 監聽 (相容滑鼠、滑控筆與觸控)
writeCanvas.addEventListener('mousedown', startDrawing);
writeCanvas.addEventListener('mousemove', moveDrawing);
window.addEventListener('mouseup', stopDrawing);

writeCanvas.addEventListener('touchstart', (e) => {
    e.preventDefault();
    startDrawing(e);
}, { passive: false });

writeCanvas.addEventListener('touchmove', (e) => {
    e.preventDefault();
    moveDrawing(e);
}, { passive: false });

writeCanvas.addEventListener('touchend', (e) => {
    e.preventDefault();
    stopDrawing();
}, { passive: false });

// 懸浮按鈕控制
btnQuill.addEventListener('click', () => {
    AppState.mode = 'QUILL';
    btnQuill.classList.add('active');
    btnEraser.classList.remove('active');
    showToast("切換為羽毛筆模式", 1500);
});

btnEraser.addEventListener('click', () => {
    AppState.mode = 'ERASER';
    btnEraser.classList.add('active');
    btnQuill.classList.remove('active');
    showToast("切換為消字藥水模式", 1500);
});

btnHistory.addEventListener('click', openHistoryDrawer);
btnCloseDrawer.addEventListener('click', closeHistoryDrawer);

btnClear.addEventListener('click', () => {
    if (confirm("您確定要合上日記並清除頁面嗎？（記憶將會保留）")) {
        closeDiary();
    }
});

btnGuide.addEventListener('click', openGuide);
btnCloseModal.addEventListener('click', closeGuide);
guideModal.addEventListener('click', (e) => {
    if (e.target === guideModal) closeGuide();
});

// --------------------------------------------------------------------------
// 16. 主循環 - 檢測手寫空閒時間 (Main Loop - Detect Idle Pen)
// --------------------------------------------------------------------------
setInterval(() => {
    if (AppState.current !== 'LISTENING' || AppState.isDrawing) return;
    if (AppState.strokes.length === 0) return;
    if (!AppState.lastPenTime) return;
    
    // 如果停止書寫超過 IDLE_COMMIT_TIME (2.8s) 且目前有寫墨水，開始吸收
    if (Date.now() - AppState.lastPenTime >= IDLE_COMMIT_TIME) {
        // 如果手寫的包圍盒全白 (全被擦掉了)
        const imageData = ctx.getImageData(
            Math.max(0, AppState.bbox.x0),
            Math.max(0, AppState.bbox.y0),
            Math.max(1, AppState.bbox.x1 - AppState.bbox.x0),
            Math.max(1, AppState.bbox.y1 - AppState.bbox.y0)
        );
        const data = imageData.data;
        let hasInk = false;
        
        // 遍歷 alpha 頻道檢測是否有深色墨水剩餘
        for (let i = 0; i < data.length; i += 4) {
            if (data[i + 3] > 10) {
                hasInk = true;
                break;
            }
        }
        
        if (!hasInk) {
            // 所有字跡已被擦除，不提交 API
            clearPageImmediate();
            AppState.current = 'LISTENING';
        } else {
            // 開始提交，瑞斗吸走墨水
            startInkDrinking();
        }
    }
}, 300);

// 初始化加載
window.onload = () => {
    // 預加載 Dancing Script 字體
    document.fonts.ready.then(() => {
        console.log("湯姆的魔力字體已準備就緒。");
    });
};
