// ==UserScript==
// @author       Rain
// @name         视频小助手Pro版（液态玻璃版）
// @namespace    video-flow-assistant-pro1
// @version      2.4.3
// @description  A-B循环/音量记忆/全屏控制 + 液态玻璃质感 · 可拖拽悬浮球 + 跟随弹窗 + 离开自动收回 · 倍速/镜像/旋转/画中画 + 智能流畅模式（隐藏弹幕、冻结动画、暂停离屏视频、FPS监控自动降载）。支持抖音、哔哩哔哩等任意视频网站。
// @author       You
// @match        *://*/*
// @exclude      *://localhost*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_xmlhttpRequest
// @grant        GM_openInTab
// @updateURL    https://raw.githubusercontent.com/Raincnm/Video-Assistant-Pro/main/%E8%A7%86%E9%A2%91%E5%B0%8F%E5%8A%A9%E6%89%8B.js
// @downloadURL  https://raw.githubusercontent.com/Raincnm/Video-Assistant-Pro/main/%E8%A7%86%E9%A2%91%E5%B0%8F%E5%8A%A9%E6%89%8B.js
// @connect      raw.githubusercontent.com
// @run-at       document-idle
// @icon         https://img.001315.xyz/file/tg/1789381092104.webp
// ==/UserScript==

(function () {
    'use strict';

    // LIBVIO 等站点的视频常在跨域 iframe 内。顶层负责 UI，iframe 负责真实 video。
    const VFA_IS_TOP = window.top === window.self;
    let vfaRemoteVideoState = null;

    // GitHub 在线更新检测
    const VFA_UPDATE_URL = 'https://raw.githubusercontent.com/Raincnm/Video-Assistant-Pro/main/%E8%A7%86%E9%A2%91%E5%B0%8F%E5%8A%A9%E6%89%8B.js';
    const VFA_CURRENT_VERSION = '2.4.1';
    let vfaUpdateInfo = { available: false, version: '', checking: false };

    function vfaCompareVersions(a, b) {
        const pa = String(a || '').replace(/^v/i, '').split(/[.+_-]/).map(x => /^\d+$/.test(x) ? Number(x) : x);
        const pb = String(b || '').replace(/^v/i, '').split(/[.+_-]/).map(x => /^\d+$/.test(x) ? Number(x) : x);
        const n = Math.max(pa.length, pb.length);
        for (let i = 0; i < n; i++) {
            const x = pa[i] ?? 0, y = pb[i] ?? 0;
            if (typeof x === 'number' && typeof y === 'number') {
                if (x !== y) return x - y;
            } else {
                const c = String(x).localeCompare(String(y), undefined, { numeric: true });
                if (c) return c;
            }
        }
        return 0;
    }

    function vfaSetUpdateBadge(version = '') {
        const badge = document.getElementById('vfa-update-badge');
        if (!badge) return;
        if (version) {
            badge.textContent = `↑ 有新版本 ${version}`;
            badge.title = `GitHub 已发布 ${version}，点击更新`;
            badge.classList.add('show');
        } else {
            badge.classList.remove('show');
        }
    }

    function vfaCheckForUpdate() {
        if (!VFA_IS_TOP || vfaUpdateInfo.checking) return;
        vfaUpdateInfo.checking = true;
        try {
            if (typeof GM_xmlhttpRequest !== 'function') throw new Error('GM_xmlhttpRequest unavailable');
            GM_xmlhttpRequest({
                method: 'GET',
                url: VFA_UPDATE_URL + '?_vfa_update=' + Date.now(),
                nocache: true,
                timeout: 12000,
                onload: response => {
                    vfaUpdateInfo.checking = false;
                    if (response.status < 200 || response.status >= 300) return;
                    const m = String(response.responseText || '').match(/@version\s+([^\s]+)/);
                    const remote = m ? m[1].trim() : '';
                    if (!remote) return;
                    if (vfaCompareVersions(remote, VFA_CURRENT_VERSION) > 0) {
                        vfaUpdateInfo = { available: true, version: remote, checking: false };
                        vfaSetUpdateBadge(remote);
                    } else {
                        vfaUpdateInfo = { available: false, version: remote, checking: false };
                        vfaSetUpdateBadge('');
                    }
                },
                onerror: () => { vfaUpdateInfo.checking = false; },
                ontimeout: () => { vfaUpdateInfo.checking = false; }
            });
        } catch {
            vfaUpdateInfo.checking = false;
        }
    }

    function vfaStartUpdate() {
        if (!vfaUpdateInfo.available) return;
        toast(`正在打开 ${vfaUpdateInfo.version} 更新…`);
        try {
            if (typeof GM_openInTab === 'function') {
                GM_openInTab(VFA_UPDATE_URL, { active: true, insert: true, setParent: true });
            } else {
                window.open(VFA_UPDATE_URL, '_blank');
            }
        } catch {
            window.open(VFA_UPDATE_URL, '_blank');
        }
    }

    function vfaSendToParent(type, data = {}) {
        if (VFA_IS_TOP) return;
        try { window.parent.postMessage({ source: 'vfa-pro', type, ...data }, '*'); } catch { }
    }

    function vfaBroadcastToFrames(type, data = {}) {
        if (!VFA_IS_TOP) return;
        const message = { source: 'vfa-pro', type, ...data };
        document.querySelectorAll('iframe').forEach(frame => {
            try { frame.contentWindow?.postMessage(message, '*'); } catch { }
        });
    }

    // 同源 iframe 可以直接访问 video。跨域 iframe 则依赖 postMessage 桥。
    // 这样即使播放器只是普通同源 iframe，也不需要额外注入脚本。
    function vfaCollectVideosFromRoot(root, vids, seen) {
        if (!root) return;
        try {
            root.querySelectorAll('video').forEach(v => {
                if (!seen.has(v)) { seen.add(v); vids.push(v); }
            });
            root.querySelectorAll('*').forEach(el => {
                if (el.shadowRoot) vfaCollectVideosFromRoot(el.shadowRoot, vids, seen);
            });
        } catch { }
    }

    function vfaCollectSameOriginFrameVideos(root, vids, seen, depth = 0) {
        if (!root || depth > 4) return;
        try {
            root.querySelectorAll('iframe,frame').forEach(frame => {
                try {
                    const doc = frame.contentDocument;
                    if (!doc) return;
                    vfaCollectVideosFromRoot(doc, vids, seen);
                    vfaCollectSameOriginFrameVideos(doc, vids, seen, depth + 1);
                } catch { }
            });
        } catch { }
    }

    if (VFA_IS_TOP) {
        window.addEventListener('message', e => {
            const d = e.data;
            if (!d || d.source !== 'vfa-pro') return;
            if (d.type === 'vfa-ready') {
                if (state) vfaBroadcastToFrames('skip-settings', { skipIntro: state.skipIntro, skipOutro: state.skipOutro, skipIntroSec: state.skipIntroSec, skipOutroSec: state.skipOutroSec });
                return;
            }
            if (d.type === 'video-state') {
                vfaRemoteVideoState = d;
                updateVideoTimeline();
                updatePlayPauseUI();
                if (state) vfaBroadcastToFrames('skip-settings', { skipIntro: state.skipIntro, skipOutro: state.skipOutro, skipIntroSec: state.skipIntroSec, skipOutroSec: state.skipOutroSec });
                if (state && state.open) syncSkipControls(null);
                else updateSkipCurrentMarkers(null);
            } else if (d.type === 'video-cleared') {
                vfaRemoteVideoState = null;
                updateVideoTimeline();
                updatePlayPauseUI();
                if (state && state.open) syncSkipControls(null);
                else updateSkipCurrentMarkers(null);
            }
        });
    } else {
        window.addEventListener('message', e => {
            const d = e.data;
            if (!d || d.source !== 'vfa-pro') return;
            try {
                // 子 iframe 的状态继续向上转发，解决多层 iframe 播放器。
                if (d.type === 'video-state' || d.type === 'video-cleared') {
                    vfaSendToParent(d.type, d);
                    return;
                }
                if (d.type === 'vfa-ready') {
                    vfaSendToParent('vfa-ready');
                    return;
                }
                if (d.type === 'skip-settings') {
                    if (typeof d.skipIntro === 'boolean') state.skipIntro = d.skipIntro;
                    if (typeof d.skipOutro === 'boolean') state.skipOutro = d.skipOutro;
                    if (Number.isFinite(Number(d.skipIntroSec))) state.skipIntroSec = Number(d.skipIntroSec);
                    if (Number.isFinite(Number(d.skipOutroSec))) state.skipOutroSec = Number(d.skipOutroSec);
                    state.skipIntroApplied = false;
                    state.skipOutroTriggered = false;
                    return;
                }
                const v = getVideo();
                if (!v) return;
                if (d.type === 'seek') {
                    const target = Number(d.time);
                    if (Number.isFinite(target)) v.currentTime = Math.max(0, target);
                } else if (d.type === 'play-pause') {
                    v.paused ? v.play().catch(() => {}) : v.pause();
                } else if (d.type === 'set-speed') {
                    const speed = Number(d.speed);
                    if (Number.isFinite(speed)) v.playbackRate = Math.min(16, Math.max(0.25, speed));
                } else if (d.type === 'set-volume') {
                    const volume = Number(d.volume);
                    if (Number.isFinite(volume)) v.volume = Math.min(1, Math.max(0, volume));
                } else if (d.type === 'set-muted') {
                    v.muted = !!d.muted;
                } else if (d.type === 'fullscreen') {
                    if (v.requestFullscreen) v.requestFullscreen().catch(() => {});
                } else if (d.type === 'pip') {
                    if (document.pictureInPictureElement) document.exitPictureInPicture().catch(() => {});
                    else if (v.requestPictureInPicture) v.requestPictureInPicture().catch(() => {});
                } else if (d.type === 'transform') {
                    try {
                        v.style.transformOrigin = 'center center';
                        v.style.transform = `rotate(${Number(d.rotation) || 0}deg) scaleX(${d.mirrored ? -1 : 1})`;
                    } catch { }
                }
            } catch { }
        });
        try { vfaSendToParent('vfa-ready'); } catch { }
    }

    // GM 存储 + localStorage 双保险，确保设置永不丢失
    const store = {
        get: (k, d) => {
            try {
                const v = GM_getValue(k, undefined);
                if (v !== undefined) return v;
            } catch { }
            try { return JSON.parse(localStorage.getItem('vfa_' + k)) ?? d; } catch { return d; }
        },
        set: (k, v) => {
            try { GM_setValue(k, v); } catch { }
            try { localStorage.setItem('vfa_' + k, JSON.stringify(v)); } catch { }
        }
    };

    const state = {
        speed: store.get('speed', 1),
        rememberSpeed: store.get('rememberSpeed', true),
        watermarkOpacity: store.get('watermarkOpacity', 0.05),
        developerUnlocked: false,
        smoothMode: store.get('smoothMode', false),
        freezeDecor: store.get('freezeDecor', false),
        hideDanmaku: store.get('hideDanmaku', false),
        dmKeywords: store.get('dmKeywords', []),
        pauseOffscreen: store.get('pauseOffscreen', true),
        skipIntro: store.get('skipIntro', false),
        skipOutro: store.get('skipOutro', false),
        idlePause: store.get('idlePause', false),
        idleMin: store.get('idleMin', 1),   // 无操作判定时长(分钟,1-30)
        lastActive: Date.now(),
        idleAsked: false,
        skipIntroSec: store.get('skipIntroSec', 10),
        skipOutroSec: store.get('skipOutroSec', 0),
        skipIntroMemory: {},
        skipOutroMemory: {},
        skipMediaKey: '',
        skipIntroApplied: false,
        skipOutroTriggered: false,
        posX: store.get('posX', null),      // 悬浮球位置
        posY: store.get('posY', null),
        rotation: 0,
        mirrored: false,
        fps: 0,
        lowFpsSince: 0,
        autoSmoothed: false,
        wrap: null,
        panel: null,
        open: false,
        closeTimer: null,
        dragging: false,

        // ===== 2.2 新增：安全增量功能 =====
        rememberVolume: store.get('rememberVolume', false),
        volume: store.get('volume', 1),
        muted: store.get('muted', false),
        abA: null,
        abB: null,
        abLoop: false,
        webFullscreen: false,
        webFullscreenVideo: null,
        webFullscreenStyleBackup: null,
        webFullscreenViewportResize: null,
        webFullscreenResizeBound: null

    };

    /* ---------------- 液态玻璃样式 ---------------- */
    const GLASS_CSS = `
#vfa-panel::-webkit-scrollbar { width:0; height:0; display:none; }
#vfa-panel { scrollbar-width:none !important; -ms-overflow-style:none !important; }
#vfa-panel .vfa-skip-input { width:112px !important; min-width:112px !important; text-align:center; letter-spacing:.2px; }
#vfa-panel .vfa-skip-input::placeholder { opacity:.45; }

#vfa-update-badge {
    display:none;
    align-items:center;
    justify-content:center;
    max-width:118px;
    min-height:0;
    padding:6px;
    margin-left:auto;
    border:1px solid rgba(255, 184, 77, .38);
    border-radius:999px;
    background:rgba(255, 184, 77, .12);
    color:#ffd28a;
    font-size:11px;
    font-weight:700;
    line-height:1.2;
    white-space:nowrap;
    cursor:pointer;
    user-select:none;
    transition:all .18s ease;
}
#vfa-update-badge.show { display:inline-flex; }
#vfa-update-badge:hover {
    background:rgba(255, 184, 77, .2);
    border-color:rgba(255, 184, 77, .58);
}

#vfa-panel .vfa-skip-input:focus { user-select:text !important; -webkit-user-select:text !important; cursor:text; }


    /* =========================================================
   Rain · 隐形全屏水印
   ========================================================= */

#vfa-watermark {
    position:fixed;
    inset:0;

    z-index:2147483640;

    pointer-events:none !important;
    user-select:none !important;

    overflow:hidden;

    color:rgba(80,90,105,.9);

    font-family:
        -apple-system,
        BlinkMacSystemFont,
        "SF Pro Display",
        "Segoe UI",
        sans-serif;

    font-size:11px;
    font-weight:600;

    letter-spacing:2.5px;

    /*
     * 不使用 mix-blend-mode。
     *
     * 这样在白色、黑色、视频画面上
     * 都不会突然变得特别明显。
     */
    mix-blend-mode:normal;
}

.vfa-watermark-item {
    position:absolute;
    white-space:nowrap;
    pointer-events:none !important;
    font-size:11px;
    font-weight:600;
    letter-spacing:2px;
}

/* 不让水印影响任何鼠标操作 */
#vfa-watermark,
#vfa-watermark * {
    pointer-events: none !important;
}

    /* =========================================================
   VFA Canvas 视频旋转层
   ========================================================= */

#vfa-video-canvas {
    box-sizing: border-box !important;
    pointer-events: none !important;
    user-select: none !important;
    touch-action: none !important;
}

    /* =========================================
   全局字体 · 柔和浅黑阴影
   ========================================= */

/* 弹窗内所有普通文字 */
#vfa-panel,
#vfa-panel *,
#vfa-toast,
#vfa-idle-box,
#vfa-idle-box * {
    text-shadow:
        0 1px 2px rgba(0, 0, 0, .22),
        0 0 1px rgba(0, 0, 0, .12);
}

/* 标题稍微加强一点，让液态渐变更清晰 */
#vfa-panel .vfa-title {
    text-shadow:none;
    filter:
        drop-shadow(0 1px 2px rgba(0, 0, 0, .20))
        drop-shadow(0 0 4px rgba(0, 0, 0, .10));
}

/* FPS 保持柔和，不要阴影太重 */
#vfa-panel #vfa-fps {
    text-shadow:
        0 1px 2px rgba(0, 0, 0, .20);
}

/* 倍速数字 */
#vfa-panel #vfa-speed {
    text-shadow:
        0 1px 2px rgba(0, 0, 0, .28);
}

/* 按钮文字 */
#vfa-panel button {
    text-shadow:
        0 1px 2px rgba(0, 0, 0, .22);
}

/* 开关文字 */
#vfa-panel .vfa-swrow {
    text-shadow:
        0 1px 2px rgba(0, 0, 0, .22);
}

/* 区块标题 */
#vfa-panel .vfa-label {
    text-shadow:
        0 1px 2px rgba(0, 0, 0, .20);
}

/* 关键词 */
#vfa-panel .vfa-dm-chip {
    text-shadow:
        0 1px 2px rgba(0, 0, 0, .20);
}

/* 输入框文字 */
#vfa-panel #vfa-dm-input {
    text-shadow:
        0 1px 2px rgba(0, 0, 0, .22);
}

/* 输入框 placeholder 稍微弱一点 */
#vfa-panel #vfa-dm-input::placeholder {
    text-shadow:
        0 1px 2px rgba(0, 0, 0, .14);
}

/* 无人观看弹窗 */
#vfa-idle-box .vfa-idle-title {
    text-shadow:
        0 1px 2px rgba(0, 0, 0, .25);
}

#vfa-idle-box .vfa-idle-tip {
    text-shadow:
        0 1px 2px rgba(0, 0, 0, .18);
}

/* 无人观看弹窗按钮 */
#vfa-idle-box .vfa-idle-btn {
    text-shadow:
        0 1px 2px rgba(0, 0, 0, .22);
}

/* Toast 提示 */
#vfa-toast {
    text-shadow:
        0 1px 2px rgba(0, 0, 0, .22);
}

    /* ================================
   弹幕关键词区域
   高度由关键词数量自动决定
   ================================ */

.vfa-dm-section {
    width:100%;
    height:auto;
    min-height:0;
}

/* 关键词容器 */
#vfa-dm-chips {
    display:flex;
    flex-wrap:wrap;
    align-items:flex-start;
    align-content:flex-start;

    width:100%;
    height:auto;
    min-height:0;

    gap:7px;

    overflow:visible;
}
/* 从「暂停离屏视频」开始，额外向下留 5px */
#vfa-panel .vfa-pause-start {
    margin-top:0 !important;
    padding-top:4.5px !important;
}

/* 后面的板块不要固定高度 */
.vfa-lower-section {
    position:relative;

    width:100%;
    height:auto;
    min-height:0;

    transform:none !important;
}

    /* ================================
   VFA 文字对比度优化
   ================================ */

#vfa-panel .vfa-title {
    color:#ffffff;
    font-weight:750;
    text-shadow:
        0 1px 3px rgba(0,0,0,.55),
        0 0 12px rgba(255,255,255,.08);
}

#vfa-panel .vfa-label {
    color:#dbe7ff;
    font-weight:700;
    text-shadow:0 1px 3px rgba(0,0,0,.5);
}

#vfa-panel .vfa-swrow {
    color:#f7f9ff;
    text-shadow:0 1px 2px rgba(0,0,0,.45);
}

#vfa-panel .vfa-speed {
    color:#ffffff;
}

/* FPS */
#vfa-panel .vfa-chip {
    color:#ffffff;
    background:rgba(0,0,0,.25);
    border-color:rgba(255,255,255,.22);
}

/* 普通按钮 */
#vfa-panel .vfa-btn,
#vfa-panel .vfa-ico {
    color:#ffffff;
    background:rgba(255,255,255,.10);
    border-color:rgba(255,255,255,.22);
}

/* 鼠标经过 */
#vfa-panel .vfa-btn:hover,
#vfa-panel .vfa-ico:hover {
    background:rgba(255,255,255,.20);
}

    /* =====================================================
   VFA 液态玻璃初始化修复
   防止刷新后 backdrop-filter 合成层失效
   ===================================================== */

#vfa-fab,
#vfa-panel,
#vfa-toast {
    background:
        linear-gradient(
            135deg,
            rgba(255,255,255,.25),
            rgba(255,255,255,.08)
        );

    backdrop-filter: blur(20px) saturate(160%);
    -webkit-backdrop-filter: blur(20px) saturate(160%);

    isolation: isolate;
}

/* 面板使用更强的玻璃效果 */
#vfa-panel {
    background:
        linear-gradient(
            135deg,
            rgba(30, 42, 68, 0.92),
            rgba(12, 18, 32, 0.88)
        );

    backdrop-filter: blur(18px);
    -webkit-backdrop-filter: blur(18px);

    isolation: isolate;

    transform: translateZ(0);
    will-change: opacity, transform;
}


/* 倍速播放区域和流畅优化区域之间增加呼吸空间 */
.vfa-section-smooth {
    margin-top:25px !important;
}
/* =========================================================
   VFA Pro · 统一 Section 布局
   所有功能区域保持一致的垂直节奏
   ========================================================= */

/* 面板整体 */
#vfa-panel {
    padding:26px 24px;
}

/* =========================================================
   1. 面板顶部
   ========================================================= */

#vfa-panel .vfa-panel-head {
    margin-bottom:22px !important;
}

/* =========================================================
   2. 所有分区标题
   ========================================================= */

#vfa-panel .vfa-label {
    margin-top: 20px !important;
    margin-bottom: 12px !important;
}

/* 第一个分区标题 */
#vfa-panel .vfa-panel-head + .vfa-label {
    margin-top: 0 !important;
}

/* 普通内容行 */
#vfa-panel .vfa-row {
    margin-bottom: 10px;
}

/* 开关之间保持小而一致的距离 */
#vfa-panel .vfa-swrow {
    margin-bottom: 6px;
}

/* 开关列表最后一项 */
#vfa-panel .vfa-swrow:last-of-type {
    margin-bottom:0;
}

/* =========================================================
   5. 倍速快捷按钮
   ========================================================= */

#vfa-panel .vfa-row:has(.vfa-ico) {
    margin-bottom:14px;
}

#vfa-panel .vfa-row:has(.vfa-btn) {
    margin-bottom:0;
}

/* =========================================================
   6. 弹幕关键词
   ========================================================= */

#vfa-panel .vfa-dm-inputrow {
    margin-bottom:8px;
}

#vfa-panel #vfa-dm-chips {
    min-height:20px;
    margin-bottom:0;
}

/* =========================================================
   7. 无操作时间
   ========================================================= */

#vfa-panel .vfa-slider-row {
    margin:6px;
}

/* =========================================================
   8. 最底部操作
   ========================================================= */

/* 底部按钮 */
#vfa-panel .vfa-row:last-child {
    margin-bottom: 0;
}

/* =========================================================
   9. 所有按钮统一高度
   ========================================================= */

#vfa-panel .vfa-btn {
    min-height:38px;
}

#vfa-panel .vfa-ico {
    min-height:38px;
}

/* =========================================================
   10. 小屏幕适配
   ========================================================= */

@media (max-width:520px) {

    #vfa-panel {
        width:calc(100vw - 24px);
        padding:22px 18px;
    }

}



#vfa-root, #vfa-root * {
    margin:0; padding:0; box-sizing:border-box;
    font-family:-apple-system,"SF Pro Display","Segoe UI","Microsoft YaHei",sans-serif;
}
#vfa-wrap {
    position:fixed; z-index:2147483646; top:64px; right:18px;
    width:52px; height:52px; pointer-events:none;
    will-change:transform;
}
#vfa-fab {
    position:absolute; inset:0; pointer-events:auto;
    border-radius:18px; font-size:22px;
    background:linear-gradient(135deg, rgba(255,255,255,.25), rgba(255,255,255,.08));
    backdrop-filter:blur(20px) saturate(160%); -webkit-backdrop-filter:blur(20px) saturate(160%);
    border:1px solid rgba(255,255,255,.4);
    box-shadow:0 8px 32px rgba(31,38,135,.25), inset 0 1px 1px rgba(255,255,255,.5);
    display:flex; align-items:center; justify-content:center;
    cursor:grab; touch-action:none;
    transition:transform .35s cubic-bezier(.2,.9,.3,1.4), box-shadow .3s, border-radius .3s;
}
#vfa-fab:hover { transform:scale(1.08); box-shadow:0 12px 40px rgba(31,38,135,.35), inset 0 1px 1px rgba(255,255,255,.6); }
#vfa-fab:active { cursor:grabbing; transform:scale(.95); }
#vfa-fab.dragging { transition:none !important; transform:scale(1.12); border-radius:26px;
    backdrop-filter:none !important; -webkit-backdrop-filter:none !important;
    box-shadow:0 4px 14px rgba(31,38,135,.3) !important; }
#vfa-panel.dragging { transition:none !important; backdrop-filter:none !important; -webkit-backdrop-filter:none !important; }
#vfa-shield {
    position:fixed; inset:0; z-index:2147483645;
    cursor:grabbing; background:transparent; touch-action:none;
}
/* 流畅模式改用 class 而非全局通配符，避免渲染压力 */
html[vfa-smooth] #vfa-fab, html[vfa-smooth] #vfa-panel { backdrop-filter:none !important; }
#vfa-panel {
    position:absolute;
    pointer-events:auto;
    box-sizing:border-box;
    max-height:calc(100vh - 24px);
    overflow-y:auto !important;
    overflow-x:hidden !important;
    scrollbar-width:none;
    -ms-overflow-style:none;

    width:min(380px, calc(100vw - 40px));
    padding:24px 22px;
    border-radius:30px;

    /* 深色液态玻璃 */
    background:
        linear-gradient(
            135deg,
            rgba(18, 25, 48, .88),
            rgba(25, 34, 65, .82) 45%,
            rgba(35, 45, 88, .78)
        );

    backdrop-filter:blur(28px) saturate(180%);
    -webkit-backdrop-filter:blur(28px) saturate(180%);

    /* 更明显的玻璃边缘 */
    border:1px solid rgba(255,255,255,.24);

    /* 外阴影 + 内高光 */
    box-shadow:
        0 18px 55px rgba(0,0,0,.38),
        0 4px 18px rgba(30,60,140,.18),
        inset 0 1px 0 rgba(255,255,255,.22),
        inset 0 -1px 0 rgba(0,0,0,.15);

    color:#fff;

    display:none;
    user-select:none;
    transform-origin:center;

    isolation:isolate;
}

#vfa-panel.show { display:block; animation:vfa-pop .32s cubic-bezier(.2,.9,.3,1.35); }
#vfa-panel.hide { animation:vfa-out .22s ease forwards; }
@keyframes vfa-pop { from{opacity:0;transform:scale(.85) translateY(6px);} to{opacity:1;transform:none;} }
@keyframes vfa-out { to{opacity:0;transform:scale(.85);} }
#vfa-panel::before {
    content:''; position:absolute; top:-60%; left:-30%;
    width:90%; height:120%; pointer-events:none;
    background:radial-gradient(circle, rgba(255,120,190,.28), transparent 65%);
    filter:blur(30px); animation:vfa-liquid 9s ease-in-out infinite alternate;
}
@keyframes vfa-liquid { from{transform:translate(0,0) scale(1);} to{transform:translate(60px,40px) scale(1.25);} }
.vfa-row { position:relative; display:flex; align-items:center; justify-content:space-between; gap:12px; margin-bottom:18px; }
.vfa-title {
    font-weight: 800;
    font-size: 15px;
    letter-spacing: .5px;

    /* 柔和、明显的液态渐变 */
    background: linear-gradient(
        100deg,
        #b3dcff 0%,
        #79b9ff 22%,
        #aa94ff 48%,
        #d79bea 72%,
        #8fd4ff 100%
    );

    background-size: 220% 100%;

    -webkit-background-clip: text;
    background-clip: text;

    -webkit-text-fill-color: transparent;
    color: transparent;

    animation: vfa-title-flow 7s ease-in-out infinite;

    /* 柔和发光，不刺眼 */
    filter:
        drop-shadow(0 1px 2px rgba(120, 170, 255, .28))
        drop-shadow(0 0 5px rgba(180, 150, 255, .16));
}

@keyframes vfa-title-flow {
    0% {
        background-position: 0% 50%;
    }

    50% {
        background-position: 100% 50%;
    }

    100% {
        background-position: 0% 50%;
    }
}


.vfa-ico {
    width:30px; height:30px; border-radius:10px; border:1px solid rgba(255,255,255,.35);
    background:rgba(255,255,255,.15); cursor:pointer; color:#fff;
    font-size:14px; display:flex; align-items:center; justify-content:center;
    transition:all .25s; backdrop-filter:blur(8px);
}
.vfa-ico:hover { background:rgba(255,255,255,.35); transform:translateY(-1px); }
.vfa-btn {
    flex:1; padding:9px 0; border-radius:14px; cursor:pointer; color:#fff;
    border:1px solid rgba(255,255,255,.3);
    background:rgba(255,255,255,.14); font-size:13px; font-weight:600;
    transition:all .25s; backdrop-filter:blur(8px);
}
.vfa-btn:hover { background:rgba(255,255,255,.32); transform:translateY(-1px); box-shadow:0 4px 14px rgba(0,0,0,.15); }
.vfa-btn:active { transform:scale(.95); }

/* 视频网页全屏：只让“视频播放器容器”接管浏览器视口。
   页面本身不进入全屏，不锁 body/html，不调用 Fullscreen API，
   不移动 <video>，不改变视频源或播放层级。 */
.vfa-web-fullscreen-target {
    position:fixed !important;
    inset:0 !important;
    width:auto !important;
    height:auto !important;
    min-width:0 !important;
    min-height:0 !important;
    max-width:none !important;
    max-height:none !important;
    margin:0 !important;
    padding:0 !important;
    transform:none !important;
    filter:none !important;
    perspective:none !important;
    contain:none !important;
    border-radius:0 !important;
    box-sizing:border-box !important;
    z-index:2147483638 !important;
    background:#000 !important;
    overflow:visible !important;
}
.vfa-web-fullscreen-target video {
    max-width:none !important;
    max-height:none !important;
}

/*.vfa-chip {
    display:inline-flex; align-items:center; gap:3px; font-size:11px;
    padding:3px 10px; border-radius:20px;
    background:rgba(255,255,255,.16); border:1px solid rgba(255,255,255,.3);
}
.vfa-fps { font-variant-numeric:tabular-nums; }*/
/* =========================================
   FPS 显示 · 完整液态玻璃胶囊
   ========================================= */

#vfa-fps {
    /* 根据内容自动调整，但始终完整包住文字 */
    display:inline-flex !important;
    align-items:center;
    justify-content:center;

    width:auto;
    min-width:64px;
    height:28px;

    padding:0 11px !important;

    flex:0 0 auto;

    border-radius:999px !important;

    box-sizing:border-box;

    white-space:nowrap;
    overflow:visible;

    font-size:11px;
    line-height:1;

    font-weight:700;
    font-variant-numeric:tabular-nums;

    color:#7dffb0;

    background:
        linear-gradient(
            135deg,
            rgba(255,255,255,.20),
            rgba(255,255,255,.08)
        ) !important;

    border:1px solid rgba(255,255,255,.35) !important;

    box-shadow:
        inset 0 1px 0 rgba(255,255,255,.30),
        0 3px 12px rgba(0,0,0,.14);

    backdrop-filter:blur(10px);
    -webkit-backdrop-filter:blur(10px);

    text-shadow:
        0 1px 4px rgba(0,0,0,.25);

    transition:
        color .25s ease,
        background .25s ease,
        border-color .25s ease,
        box-shadow .25s ease;
}

/* FPS 数字变化时不会撑破外框 */
#vfa-fps {
    contain:layout paint;
}

/* 标题行本身也要给 FPS 留出空间 */
#vfa-panel .vfa-panel-head {
    display:flex;
    align-items:center;
    justify-content:space-between;

    width:100%;
    min-width:0;

    gap:12px;
}

/* 左边标题允许收缩 */
#vfa-panel .vfa-panel-head .vfa-title {
    min-width:0;
    flex:1 1 auto;

    overflow:hidden;
    text-overflow:ellipsis;
    white-space:nowrap;
}

/* FPS 永远保持完整显示 */
#vfa-panel .vfa-panel-head #vfa-fps {
    flex:0 0 auto;
}

#vfa-speed {
    font-variant-numeric:tabular-nums; font-weight:800; font-size:15px;
    padding:2px 12px; border-radius:12px; min-width:56px; text-align:center;
    background:rgba(0,0,0,.18); border:1px solid rgba(255,255,255,.25);
}
.vfa-glassline { display:none; }
.vfa-label {
    font-size:12px;
    opacity:.9;

    margin:28px 0 16px;

    font-weight:600;
    letter-spacing:1px;
    text-transform:uppercase;
}

.vfa-panel-head { margin-bottom:0; }
.vfa-label:first-of-type { margin-top:26px; }
.vfa-switch { position:relative; width:36px; height:20px; cursor:pointer; flex:none; }
.vfa-switch i {
    position:absolute; inset:0; border-radius:20px; transition:.3s;
    background:rgba(255,255,255,.2); border:1px solid rgba(255,255,255,.35);
}
.vfa-switch i::after {
    content:''; position:absolute; top:2px; left:2px; width:14px; height:14px;
    border-radius:50%; background:#fff; transition:.3s cubic-bezier(.2,.9,.3,1.4);
    box-shadow:0 1px 4px rgba(0,0,0,.3);
}
.vfa-switch.on i { background:linear-gradient(135deg,#4fd482,#3aa0ff); }
.vfa-switch.on i::after { left:18px; }
.vfa-swrow { display:flex; align-items:center; justify-content:space-between; margin-bottom:16px; font-size:13px; cursor:pointer; }
.vfa-slider-row {
    display:none; align-items:center; gap:8px;
    margin:-8px 0 16px; padding:10px 12px; border-radius:14px;
    background:rgba(0,0,0,.16); border:1px solid rgba(255,255,255,.15);
}
#vfa-wm-range {
    flex:1;
    min-width:0;
    -webkit-appearance:none;
    appearance:none;
    height:5px;
    border-radius:5px;
    background:rgba(255,255,255,.25);
    outline:none;
    cursor:pointer;
}

#vfa-wm-range::-webkit-slider-thumb {
    -webkit-appearance:none;
    width:16px;
    height:16px;
    border-radius:50%;
    background:#fff;
    box-shadow:0 0 6px rgba(59,130,246,.9);
    cursor:grab;
    border:2px solid #3b82f6;
}

.vfa-slider-row.show { display:flex; }
.vfa-slider-row span { font-size:12px; opacity:.85; flex:none; white-space:nowrap; }
.vfa-slider-row output {
    flex:none; min-width:52px; text-align:center; font-size:12px; font-weight:700;
    padding:3px 8px; border-radius:10px; white-space:nowrap;
    background:linear-gradient(135deg,#3b82f6,#60a5fa); color:#fff;
}

/* ---------------- 视频时间线 / 集数控制 ---------------- */
.vfa-video-control {
    width:100%;
    margin-top:14px;
    box-sizing:border-box;
    margin-bottom:14px;
    padding:12px 12px 10px;
    border-radius:15px;
    background:rgba(0,0,0,.14);
    border:1px solid rgba(255,255,255,.13);
}
.vfa-time-row {
    display:flex;
    align-items:center;
    gap:10px;
    min-height:32px;
    width:100%;
}
.vfa-time-label {
    flex:0 0 auto;
    min-width:38px;
    font-size:11px;
    line-height:18px;
    font-variant-numeric:tabular-nums;
    opacity:.82;
    text-align:center;
}
#vfa-video-progress {
    flex:1;
    min-width:0;
    width:100%;
    height:7px;
    margin:0;
    padding:0;
    -webkit-appearance:none;
    appearance:none;
    border-radius:8px;
    background:linear-gradient(to right,rgba(96,165,250,.95) 0%,rgba(96,165,250,.95) 0%,rgba(255,255,255,.22) 0%,rgba(255,255,255,.22) 100%);
    outline:none;
    cursor:pointer;
    touch-action:none;
}
#vfa-video-progress::-webkit-slider-runnable-track {
    height:7px;
    border-radius:8px;
    background:transparent;
}
#vfa-video-progress::-webkit-slider-thumb {
    -webkit-appearance:none;
    appearance:none;
    width:16px;
    height:16px;
    margin-top:-4.5px;
    border:2px solid #3b82f6;
    border-radius:50%;
    background:#fff;
    box-shadow:0 0 7px rgba(59,130,246,.95);
    cursor:grab;
}
#vfa-video-progress:active::-webkit-slider-thumb { cursor:grabbing; transform:scale(1.08); }
#vfa-video-progress::-moz-range-track {
    height:7px;
    border-radius:8px;
    background:rgba(255,255,255,.22);
}
#vfa-video-progress::-moz-range-progress {
    height:7px;
    border-radius:8px;
    background:rgba(96,165,250,.95);
}
#vfa-video-progress::-moz-range-thumb {
    width:12px;
    height:12px;
    border:2px solid #3b82f6;
    border-radius:50%;
    background:#fff;
    box-shadow:0 0 7px rgba(59,130,246,.95);
    cursor:grab;
}
.vfa-episode-controls {
    display:flex;
    align-items:center;
    justify-content:center;
    gap:8px;
    margin-top:12px;
    min-height:32px;
}
.vfa-episode-btn {
    flex:1 1 0;
    min-width:0;
    height:32px;
    padding:0 7px;
    border:1px solid rgba(255,255,255,.16);
    border-radius:10px;
    background:rgba(255,255,255,.08);
    color:inherit;
    font-size:11px;
    line-height:30px;
    cursor:pointer;
    transition:transform .15s ease,background .15s ease,border-color .15s ease;
    white-space:nowrap;
    user-select:none;
}
.vfa-episode-btn:hover {
    background:rgba(255,255,255,.15);
    border-color:rgba(255,255,255,.28);
}
.vfa-episode-btn:active { transform:scale(.96); }
.vfa-episode-btn.play {
    flex:0 0 42px;
    padding:0;
    font-size:15px;
    font-weight:700;
}

 .vfa-skip-box {
    display:block !important;
    width:100% !important;
    box-sizing:border-box !important;
    margin:0 0 18px !important;
    padding:20px !important;
    border-radius:18px;
    background:rgba(0,0,0,.14);
    border:1px solid rgba(255,255,255,.13);
}
.vfa-skip-box + .vfa-swrow { margin-top:18px !important; }
.vfa-skip-head {
    display:flex !important;
    align-items:center !important;
    justify-content:space-between !important;
    width:100% !important;
    min-height:24px !important;
    box-sizing:border-box !important;
    gap:14px !important;
    margin:0 0 16px !important;
    padding:0 !important;
    font-size:13px;
    line-height:20px;
    opacity:.92;
}
.vfa-skip-head output {
    flex:0 0 auto !important;
    min-width:48px !important;
    box-sizing:border-box !important;
    text-align:center !important;
    font-size:12px;
    line-height:18px;
    font-weight:700;
    padding:4px 10px !important;
    border-radius:9px;
    background:rgba(59,130,246,.8);
    color:#fff;
}
.vfa-skip-range {
    display:block !important;
    width:100% !important;
    min-width:0 !important;
    height:7px !important;
    box-sizing:border-box !important;
    margin:0 !important;
    padding:0 !important;
    -webkit-appearance:none;
    appearance:none;
    border-radius:7px;
    background:rgba(255,255,255,.25);
    outline:none;
    cursor:pointer;
}
.vfa-skip-range::-webkit-slider-thumb { -webkit-appearance:none; width:16px; height:16px; border-radius:50%; background:#fff; box-shadow:0 0 6px rgba(59,130,246,.9); border:2px solid #3b82f6; cursor:grab; }
.vfa-skip-range::-moz-range-thumb { width:16px; height:16px; border-radius:50%; background:#fff; box-shadow:0 0 6px rgba(59,130,246,.9); border:2px solid #3b82f6; cursor:grab; }
.vfa-skip-track {
    position:relative;
    width:100%;
    height:18px;
    margin:0 !important;
}
.vfa-skip-track .vfa-skip-range {
    position:absolute;
    left:0; top:5px;
    z-index:2;
}
.vfa-skip-current {
    position:absolute;
    left:0; top:6px;
    width:7px; height:7px;
    margin-left:-3.5px;
    border-radius:50%;
    background:#fff;
    box-shadow:0 0 0 2px rgba(59,130,246,.7), 0 0 10px rgba(96,165,250,.9);
    pointer-events:none;
    z-index:4;
    transform:translateX(0);
    transition:left .12s linear;
}
.vfa-skip-current::after {
    content:"";
    position:absolute;
    left:50%; top:8px;
    width:1px; height:14px;
    transform:translateX(-50%);
    background:rgba(255,255,255,.72);
    box-shadow:0 0 8px rgba(96,165,250,.7);
}
.vfa-skip-set-row {
    display:flex;
    align-items:center;
    justify-content:center;
    width:100%;
    box-sizing:border-box;
    margin:12px 0 0 !important;
    padding:0 !important;
    gap:8px;
}

.vfa-skip-set-btn {
    flex:0 0 240px;
    width:240px;
    height:32px;
    padding:0 12px;
    box-sizing:border-box;
    text-align:center;
    border:1px solid rgba(255,255,255,.18);
    border-radius:9px;
    background:rgba(59,130,246,.16);
    color:inherit;
    font-size:11px;
    cursor:pointer;
    white-space:nowrap;
    transition:background .2s ease, transform .15s ease, border-color .2s ease;
}
.vfa-skip-set-btn:hover {
    background:rgba(59,130,246,.30);
    border-color:rgba(96,165,250,.48);
}
.vfa-skip-set-btn:active { transform:scale(.96); }
.vfa-skip-reset-btn {
    flex:0 0 64px;
    width:64px;
    height:32px;
    padding:0 10px;
    box-sizing:border-box;
    text-align:center;
    border:1px solid rgba(255,255,255,.18);
    border-radius:9px;
    background:rgba(255,255,255,.08);
    color:inherit;
    font-size:11px;
    cursor:pointer;
    white-space:nowrap;
    transition:background .2s ease, transform .15s ease, border-color .2s ease;
}
.vfa-skip-reset-btn:hover {
    background:rgba(255,255,255,.16);
    border-color:rgba(255,255,255,.34);
}
.vfa-skip-reset-btn:active { transform:scale(.96); }

.vfa-skip-inputrow {
    display:flex !important;
    align-items:center !important;
    justify-content:center !important;
    width:100% !important;
    min-height:36px !important;
    box-sizing:border-box !important;
    gap:10px !important;
    margin:8px 0 0 !important;
    padding:0 !important;
    font-size:12px;
    line-height:20px;
    opacity:.88;
}
.vfa-skip-input {
    flex:0 0 78px !important;
    width:78px !important;
    height:36px !important;
    box-sizing:border-box !important;
    margin:0 !important;
    padding:6px 9px !important;
    border:1px solid rgba(255,255,255,.22);
    border-radius:9px;
    background:rgba(0,0,0,.22);
    color:inherit;
    outline:none;
    text-align:center;
    font-size:12px;
}
.vfa-skip-input:focus { border-color:rgba(96,165,250,.85); box-shadow:0 0 0 2px rgba(59,130,246,.14); }
.vfa-skip-duration {
    width:100% !important;
    box-sizing:border-box !important;
    margin:12px 0 0 !important;
    padding:0 !important;
    font-size:11px;
    line-height:16px;
    opacity:.55;
    text-align:right;
}

#vfa-idle-range {
    flex:1; min-width:0; -webkit-appearance:none; appearance:none; height:5px; border-radius:5px;
    background:rgba(255,255,255,.25); outline:none; cursor:pointer;
}
#vfa-idle-range::-webkit-slider-thumb {
    -webkit-appearance:none; width:16px; height:16px; border-radius:50%;
    background:#fff; box-shadow:0 0 6px rgba(59,130,246,.9); cursor:grab;
    border:2px solid #3b82f6;
}
#vfa-toast {
    position:fixed; top:22px; left:50%; transform:translateX(-50%) translateY(-8px);
    z-index:2147483647; padding:10px 22px; border-radius:18px;
    background:linear-gradient(135deg, rgba(255,255,255,.25), rgba(255,255,255,.1));
    backdrop-filter:blur(24px) saturate(180%); -webkit-backdrop-filter:blur(24px) saturate(180%);
    border:1px solid rgba(255,255,255,.45);
    box-shadow:0 8px 30px rgba(31,38,135,.3), inset 0 1px 0 rgba(255,255,255,.5);
    color:#fff; font-size:13px; font-weight:600; pointer-events:none;
    opacity:0; transition:all .35s cubic-bezier(.2,.9,.3,1.3);
}
#vfa-toast.show { opacity:1; transform:translateX(-50%) translateY(0); }
/* 无人观看确认弹窗 */
#vfa-idle-mask {
    position:fixed; inset:0; z-index:2147483647;
    background:rgba(5,8,20,.45); display:none;
    align-items:center; justify-content:center;
}
#vfa-idle-mask.show { display:flex; }
#vfa-idle-box {
    width:min(400px, calc(100vw - 48px)); padding:30px 28px; border-radius:26px; text-align:center;
    background:linear-gradient(135deg, rgba(30,38,64,.85), rgba(16,22,40,.9));
    backdrop-filter:blur(28px) saturate(160%); -webkit-backdrop-filter:blur(28px) saturate(160%);
    border:1px solid rgba(255,255,255,.25);
    box-shadow:0 16px 60px rgba(0,0,10,.5), inset 0 1px 0 rgba(255,255,255,.3);
    color:#fff; animation:vfa-pop .32s cubic-bezier(.2,.9,.3,1.35);
}
#vfa-idle-box .vfa-idle-ico { font-size:38px; margin-bottom:12px; }
#vfa-idle-box .vfa-idle-title { font-size:16px; font-weight:700; margin-bottom:8px; }
#vfa-idle-box .vfa-idle-tip { font-size:13px; opacity:.75; margin-bottom:22px; }
#vfa-idle-box .vfa-idle-tip b { color:#7db4ff; font-variant-numeric:tabular-nums; }
.vfa-idle-btns { display:flex; gap:10px; }
.vfa-idle-btn {
    flex:1; padding:11px 0; border-radius:14px; cursor:pointer; font-size:14px; font-weight:600;
    border:1px solid rgba(255,255,255,.3); background:rgba(255,255,255,.12); color:#fff; transition:all .2s;
}
.vfa-idle-btn:hover { background:rgba(255,255,255,.28); transform:translateY(-1px); }
.vfa-idle-btn.primary { background:linear-gradient(135deg,#3b82f6,#60a5fa); border-color:rgba(255,255,255,.4); box-shadow:0 4px 16px rgba(59,130,246,.4); }
.vfa-idle-btn.primary:hover { box-shadow:0 6px 20px rgba(59,130,246,.6); }
.vfa-idle-btn.warn { background:rgba(239,68,68,.25); border-color:rgba(239,68,68,.5); }
.vfa-idle-btn.warn:hover { background:rgba(239,68,68,.45); }
/* html[vfa-smooth] *, html[vfa-smooth] *::before, html[vfa-smooth] *::after {
    backdrop-filter:none !important; -webkit-backdrop-filter:none !important;
}*/
html[vfa-smooth] video { filter:none !important; }
/* 冻结动画(独立开关，默认关)：全局冻结会破坏站点闲置遮罩的生命周期，导致点击/滚轮失效，
   因此仅保留白名单内的滑动/播放器动画 */
html[vfa-freeze] *, html[vfa-freeze] *::before, html[vfa-freeze] *::after {
    animation-duration:.01s !important; animation-iteration-count:1 !important;
    transition-duration:.01s !important;
}
html[vfa-freeze] [class*="swiper"], html[vfa-freeze] [class*="swiper"] *,
html[vfa-freeze] [class*="slide"], html[vfa-freeze] [class*="slide"] *,
html[vfa-freeze] [class*="slider"], html[vfa-freeze] [class*="slider"] *,
html[vfa-freeze] [class*="carousel"], html[vfa-freeze] [class*="carousel"] *,
html[vfa-freeze] [class*="feed"], html[vfa-freeze] [class*="feed"] *,
html[vfa-freeze] [class*="player"], html[vfa-freeze] [class*="player"] *,
html[vfa-freeze] [data-e2e="scroll-list"], html[vfa-freeze] [data-e2e="scroll-list"] * {
    animation-duration:initial !important; animation-iteration-count:initial !important;
    transition-duration:initial !important;
}
html[vfa-danmaku] [class*="danmaku"], html[vfa-danmaku] [class*="dm-wrap"],
html[vfa-danmaku] [class*="bullet-screen"], html[vfa-danmaku] .bpx-player-row-dm-wrap,
html[vfa-danmaku] .bpx-player-dm, html[vfa-danmaku] .xg-danmaku {
    display:none !important; visibility:hidden !important;
}
/* 命中关键词的弹幕 */
.vfa-dm-hide {
    display:none !important;
    visibility:hidden !important;
    opacity:0 !important;
    pointer-events:none !important;
}

/* 弹幕关键词管理 */
.vfa-dm-inputrow { display:flex; gap:6px; margin-bottom:10px; }
/* ================================
   弹幕关键词 · 胶囊圆角输入框
   ================================ */

#vfa-dm-input {
    flex:1;
    min-width:0;

    height:40px;
    padding:0 16px;

    border-radius:999px !important;

    background:rgba(5,10,25,.38) !important;

    border:1px solid rgba(255,255,255,.22) !important;

    color:#fff !important;

    outline:none;

    font-size:12px;

    box-shadow:
        inset 0 1px 2px rgba(0,0,0,.15),
        0 1px 0 rgba(255,255,255,.06);

    transition:
        background .25s ease,
        border-color .25s ease,
        box-shadow .25s ease,
        transform .2s ease;
}

/* 占位文字 */
#vfa-dm-input::placeholder {
    color:rgba(220,230,255,.55) !important;
}

/* 获得焦点 */
#vfa-dm-input:focus {
    background:rgba(5,10,25,.55) !important;

    border-color:rgba(96,165,250,.75) !important;

    box-shadow:
        0 0 0 3px rgba(96,165,250,.12),
        0 0 16px rgba(59,130,246,.18),
        inset 0 1px 2px rgba(0,0,0,.2);

    transform:scale(1.01);
}

/* 鼠标经过 */
#vfa-dm-input:hover {
    background:rgba(5,10,25,.46) !important;
    border-color:rgba(255,255,255,.32) !important;
}


#vfa-dm-add {
    flex:none;

    width:40px;
    height:40px;

    padding:0;

    border-radius:50% !important;

    display:flex;
    align-items:center;
    justify-content:center;

    cursor:pointer;

    font-size:16px;
    font-weight:700;

    border:1px solid rgba(255,255,255,.24);

    background:
        linear-gradient(
            135deg,
            rgba(96,165,250,.32),
            rgba(59,130,246,.18)
        );

    color:#fff;

    box-shadow:
        0 4px 12px rgba(0,0,0,.18),
        inset 0 1px 0 rgba(255,255,255,.18);

    transition:
        transform .2s ease,
        background .2s ease,
        box-shadow .2s ease;
}

#vfa-dm-add:hover {
    background:
        linear-gradient(
            135deg,
            rgba(96,165,250,.55),
            rgba(59,130,246,.35)
        );

    transform:scale(1.08);

    box-shadow:
        0 6px 18px rgba(59,130,246,.28),
        inset 0 1px 0 rgba(255,255,255,.25);
}

#vfa-dm-add:active {
    transform:scale(.92);
}

#vfa-dm-add:hover { background:rgba(255,255,255,.32); }
#vfa-dm-chips:empty::after { content:'暂无关键词，弹幕全部正常显示'; font-size:11px; opacity:.55; }
/* =================================================
   弹幕关键词标签 · 真正自适应版本
   ================================================= */

#vfa-dm-chips {
    display:flex;
    flex-wrap:wrap;
    align-items:flex-start;
    align-content:flex-start;

    width:100%;
    max-width:100%;

    height:auto;
    min-height:0;

    gap:7px;

    overflow:visible;

    padding:2px 0;
}


/* 关键词胶囊 */
#vfa-dm-chips .vfa-dm-chip {
    display:inline-flex;
    align-items:center;

    width:auto;
    max-width:100%;
    min-width:0;

    flex:0 1 auto;

    box-sizing:border-box;

    padding:6px 9px 6px 12px;

    border-radius:999px;

    white-space:normal;
    overflow-wrap:anywhere;
    word-break:break-word;

    line-height:17px;

    background:rgba(96,165,250,.20);
    border:1px solid rgba(96,165,250,.42);

    color:#e8f1ff;
}


/* 删除按钮 */
#vfa-dm-chips .vfa-dm-chip i {
    flex:0 0 16px;

    width:16px;
    height:16px;

    margin-left:6px;

    display:inline-flex;
    align-items:center;
    justify-content:center;

    border-radius:50%;

    font-style:normal;
    font-size:9px;

    color:rgba(255,255,255,.8);

    background:rgba(255,255,255,.10);

    line-height:1;
}

/* hover */
#vfa-dm-chips .vfa-dm-chip:hover {
    background:rgba(239,68,68,.25);
    border-color:rgba(239,68,68,.55);

    transform:translateY(-1px);
}

#vfa-dm-chips .vfa-dm-chip:hover i {
    background:rgba(239,68,68,.45);
    color:#fff;
}

.vfa-lower-section {
    transform:translateY(10px);
}
.vfa-dm-chip:hover { background:rgba(239,68,68,.35); border-color:rgba(239,68,68,.6); }
.vfa-dm-chip i { font-style:normal; opacity:.7; font-size:10px; }
.vfa-title {
    display: flex;
    align-items: center;
    gap: 6px;
    line-height: 1;
}

.vfa-logo {
    width: 20px;
    height: 20px;
    display: block;
    object-fit: contain;
    flex: 0 0 20px;
    border-radius: 5px;
}

.vfa-ab-status { display:flex; align-items:center; justify-content:center; gap:7px; min-width:82px; padding:5px 9px; border-radius:12px; background:rgba(0,0,0,.16); border:1px solid rgba(255,255,255,.16); color:rgba(255,255,255,.78); font-size:11px; font-variant-numeric:tabular-nums; white-space:nowrap; }
.vfa-ab-status.active { color:#fff; border-color:rgba(96,165,250,.55); background:rgba(59,130,246,.20); }
.vfa-ab-btn.active { background:rgba(59,130,246,.38) !important; border-color:rgba(96,165,250,.65) !important; }
.vfa-feature-note { font-size:10px; opacity:.55; margin-top:-5px; line-height:1.4; }
.vfa-volume-row { display:flex; align-items:center; gap:8px; width:100%; margin:2px 0 8px; }
.vfa-volume-icon { width:18px; text-align:center; font-size:13px; opacity:.8; cursor:pointer; user-select:none; transition:transform .15s ease, opacity .2s ease; }
.vfa-volume-icon:hover { opacity:1; transform:scale(1.08); }
.vfa-volume-icon:active { transform:scale(.92); }
.vfa-volume-range { flex:1; min-width:0; height:4px; margin:0; appearance:none; -webkit-appearance:none; border-radius:99px; outline:none; cursor:pointer; background:linear-gradient(to right, rgba(96,165,250,.95) 0%, rgba(96,165,250,.95) var(--vfa-volume,100%), rgba(255,255,255,.18) var(--vfa-volume,100%), rgba(255,255,255,.18) 100%); }
.vfa-volume-range::-webkit-slider-thumb { appearance:none; -webkit-appearance:none; width:13px; height:13px; border-radius:50%; background:#fff; border:1px solid rgba(255,255,255,.65); box-shadow:0 1px 7px rgba(0,0,0,.35); cursor:pointer; }
.vfa-volume-range::-moz-range-thumb { width:13px; height:13px; border-radius:50%; background:#fff; border:1px solid rgba(255,255,255,.65); box-shadow:0 1px 7px rgba(0,0,0,.35); cursor:pointer; }
.vfa-volume-value { width:38px; text-align:right; font-size:11px; font-variant-numeric:tabular-nums; opacity:.82; }


/* =========================================================
   VFA 主弹窗统一间距系统
   所有一级模块使用同一套 12px 垂直节奏
   ========================================================= */
#vfa-panel {
    display:none;
    flex-direction:column !important;
    gap:12px !important;
    box-sizing:border-box !important;
}

#vfa-panel.show { display:flex !important; }

#vfa-panel > .vfa-panel-head,
#vfa-panel > .vfa-label,
#vfa-panel > .vfa-row,
#vfa-panel > .vfa-ab-status,
#vfa-panel > .vfa-video-control,
#vfa-panel > .vfa-volume-row,
#vfa-panel > .vfa-swrow,
#vfa-panel > .vfa-feature-note,
#vfa-panel > .vfa-lower-section {
    margin-top:0 !important;
    margin-bottom:0 !important;
}

#vfa-panel > .vfa-panel-head {
    min-height:32px;
}

#vfa-panel > .vfa-label {
    line-height:20px;
}

#vfa-panel > .vfa-row {
    width:100%;
}

#vfa-panel > .vfa-video-control {
    margin:0 !important;
}

#vfa-panel > .vfa-volume-row {
    min-height:0;
}

#vfa-panel > .vfa-feature-note {
    line-height:16px;
}

/* 弹幕区域内部也采用统一间距 */
#vfa-panel > .vfa-dm-section,
#vfa-panel .vfa-dm-section {
    display:flex;
    flex-direction:column;
    gap:12px;
}

#vfa-panel .vfa-dm-inputrow,
#vfa-panel #vfa-dm-chips {
    margin-top:0 !important;
    margin-bottom:0 !important;
}

/* 下半部分所有功能行统一 12px 间距 */
#vfa-panel .vfa-lower-section {
    display:flex !important;
    flex-direction:column !important;
    gap:12px !important;
    transform:none !important;
    margin:12px 0 0 !important;
    position:relative !important;
    clear:both !important;
}

#vfa-panel .vfa-lower-section > .vfa-swrow,
#vfa-panel .vfa-lower-section > .vfa-skip-box,
#vfa-panel .vfa-lower-section > .vfa-slider-row {
    margin-top:0 !important;
    margin-bottom:0 !important;
}

/* 跳过片头/片尾卡片统一尺寸与内部节奏 */
#vfa-panel .vfa-skip-box {
    box-sizing:border-box !important;
    margin:0 !important;
    padding:16px !important;
}

#vfa-panel .vfa-skip-head {
    margin:0 0 12px !important;
}

#vfa-panel .vfa-skip-inputrow {
    margin:12px 0 0 !important;
}

#vfa-panel .vfa-skip-set-row {
    margin:12px 0 0 !important;
}

/* 时间线内部保持统一节奏 */
#vfa-panel .vfa-video-control {
    padding:12px !important;
}

#vfa-panel .vfa-episode-controls {
    margin-top:12px !important;
}


/* ===== 弹幕关键词与下方功能区最终隔离修正 ===== */
#vfa-panel .vfa-dm-section {
    position:relative !important;
    display:flex !important;
    flex:0 0 auto !important;
    flex-direction:column !important;
    width:100% !important;
    height:auto !important;
    min-height:0 !important;
    margin:0 !important;
    padding:0 !important;
    overflow:visible !important;
    z-index:1 !important;
}

#vfa-panel #vfa-dm-chips {
    position:relative !important;
    display:flex !important;
    flex:0 0 auto !important;
    width:100% !important;
    height:auto !important;
    min-height:20px !important;
    margin:0 !important;
    padding:0 !important;
    overflow:visible !important;
}

#vfa-panel .vfa-lower-section {
    position:relative !important;
    display:flex !important;
    flex:0 0 auto !important;
    flex-direction:column !important;
    width:100% !important;
    height:auto !important;
    min-height:0 !important;
    margin:8px 0 0 !important;
    padding:0 !important;
    transform:none !important;
    clear:both !important;
    z-index:2 !important;
}

#vfa-panel .vfa-lower-section .vfa-pause-start {
    margin:0 !important;
    padding:0 !important;
    transform:none !important;
}

#vfa-panel .vfa-lower-section > .vfa-swrow,
#vfa-panel .vfa-lower-section > .vfa-skip-box,
#vfa-panel .vfa-lower-section > .vfa-slider-row {
    position:relative !important;
    flex:0 0 auto !important;
    margin:0 !important;
    transform:none !important;
}

#vfa-panel .vfa-dm-section + .vfa-lower-section {
    /* 父级 flex gap 为 12px，这里抵消 4px，最终实际间距约为 8px */
    margin-top:-4px !important;
    padding-top:0 !important;
}

/* 画面与窗口模块与上方片头设置的间距收紧到约 8px */
#vfa-panel .vfa-lower-section > .vfa-label {
    margin-top:-4px !important;
    margin-bottom:0 !important;
}



/* ===== 手机端弹窗自适应：按屏幕宽高对整个面板进行视觉缩放 ===== */
@media (max-width:600px) {
    #vfa-panel {
        width:420px !important;
        max-width:420px !important;
        height:auto !important;
        max-height:calc(100vh - 16px) !important;
        overflow-y:auto !important;
        overflow-x:hidden !important;
        -webkit-overflow-scrolling:touch !important;
        touch-action:pan-y !important;
        box-sizing:border-box !important;
        transform-origin:top left !important;
        animation:none !important;
    }

    #vfa-panel .vfa-row,
    #vfa-panel .vfa-btn,
    #vfa-panel .vfa-ico,
    #vfa-panel .vfa-episode-btn {
        min-width:0 !important;
    }
}
`;
    /* =========================================================
     VFA 开发者模式 · 密码系统
     ---------------------------------------------------------
     密码不保存明文。
     使用：
     SHA-256(password + salt)
     + 每个用户独立随机 salt
     ---------------------------------------------------------
     注意：
     纯前端密码只能防止源码直接暴露明文，
     无法防止用户修改 JS 绕过验证。
     ========================================================= */

    const VFA_DEV_STORAGE = {
        hash: 'vfa-dev-password-hash',
        salt: 'vfa-dev-password-salt'
    };


    /* ArrayBuffer → Hex */
    function bufferToHex(buffer) {
        return [...new Uint8Array(buffer)]
            .map(b => b.toString(16).padStart(2, '0'))
            .join('');
    }


    /* 随机 Salt */
    function createDevSalt() {
        const bytes = new Uint8Array(16);
        crypto.getRandomValues(bytes);

        return [...bytes]
            .map(b => b.toString(16).padStart(2, '0'))
            .join('');
    }


    /* SHA-256 */
    async function hashDeveloperPassword(password, salt) {

        const data =
            new TextEncoder().encode(
                salt + ':' + password
            );

        const buffer =
            await crypto.subtle.digest(
                'SHA-256',
                data
            );

        return bufferToHex(buffer);
    }


    /* 判断是否已经设置开发者密码 */
    function hasDeveloperPassword() {
        return !!(
            localStorage.getItem(VFA_DEV_STORAGE.hash) &&
            localStorage.getItem(VFA_DEV_STORAGE.salt)
        );
    }


    /* 设置新密码 */
    async function setDeveloperPassword(password) {

        if (!password || password.length < 6) {
            throw new Error('密码至少需要 6 位');
        }

        const salt = createDevSalt();

        const hash =
            await hashDeveloperPassword(
                password,
                salt
            );

        localStorage.setItem(
            VFA_DEV_STORAGE.salt,
            salt
        );

        localStorage.setItem(
            VFA_DEV_STORAGE.hash,
            hash
        );
    }


    /* 验证密码 */
    async function verifyDeveloperPassword(password) {

        const salt =
            localStorage.getItem(
                VFA_DEV_STORAGE.salt
            );

        const savedHash =
            localStorage.getItem(
                VFA_DEV_STORAGE.hash
            );

        if (!salt || !savedHash) {
            return false;
        }

        const hash =
            await hashDeveloperPassword(
                password,
                salt
            );

        return hash === savedHash;
    }


    /* 删除开发者密码 */
    function clearDeveloperPassword() {

        localStorage.removeItem(
            VFA_DEV_STORAGE.hash
        );

        localStorage.removeItem(
            VFA_DEV_STORAGE.salt
        );
    }

    /* ---------------- Rain 水印 ---------------- */
    function setWatermarkOpacity(value) {
        value = Math.min(1, Math.max(0.01, Number(value) || 0.05));

        state.watermarkOpacity = value;

        document.querySelectorAll('.vfa-watermark-item').forEach(el => {
            el.style.opacity = value;
        });

        store.set('watermarkOpacity', value);
    }




    /* ---------------- 工具 ---------------- */
    function toast(msg) {
        let el = document.getElementById('vfa-toast');
        if (!el) { el = document.createElement('div'); el.id = 'vfa-toast'; document.body.appendChild(el); }
        el.textContent = msg;
        el.classList.add('show');
        clearTimeout(el._t);
        el._t = setTimeout(() => el.classList.remove('show'), 1400);
    }

    function vfaGetPlayerStatus() {
        const local = getVideo();
        if (local) return { kind: 'local', video: local };
        if (VFA_IS_TOP && vfaRemoteVideoState) return { kind: 'iframe', video: null };
        return { kind: 'none', video: null };
    }

    function vfaShowPlayerStatus() {
        if (!VFA_IS_TOP) return;
        const status = vfaGetPlayerStatus();
        const iframes = [...document.querySelectorAll('iframe')].length;
        if (status.kind === 'local') {
            toast(`✓ 已找到视频${iframes ? ` · iframe ${iframes}` : ''}`);
        } else if (status.kind === 'iframe') {
            const d = Number(vfaRemoteVideoState.duration) || 0;
            toast(`✓ 播放器已连接 · ${d > 0 ? formatTime(d) : '等待时长'}`);
        } else {
            toast(`⚠️ 未找到视频 · 页面 iframe ${iframes} 个`);
        }
    }

    function getVideo() {
        const vids = [];
        const seen = new Set();

        const collect = root => {
            if (!root) return;
            try {
                root.querySelectorAll('video').forEach(v => {
                    if (!seen.has(v)) {
                        seen.add(v);
                        vids.push(v);
                    }
                });
                root.querySelectorAll('*').forEach(el => {
                    if (el.shadowRoot) collect(el.shadowRoot);
                });
            } catch { }
        };

        collect(document);
        if (VFA_IS_TOP) vfaCollectSameOriginFrameVideos(document, vids, seen);
        if (!vids.length) return null;

        const vis = v => {
            try {
                const r = v.getBoundingClientRect();
                const w = Math.max(0, Math.min(r.right, innerWidth) - Math.max(r.left, 0));
                const h = Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0));
                return w * h;
            } catch {
                return 0;
            }
        };

        // 1. 优先当前正在播放的视频。
        const playing = vids.find(v => {
            try { return !v.paused && !v.ended; } catch { return false; }
        });
        if (playing) return playing;

        // 2. 优先已经拿到有效 duration 的视频。
        const withDuration = vids
            .filter(v => {
                try {
                    const d = Number(v.duration);
                    return Number.isFinite(d) && d > 0;
                } catch {
                    return false;
                }
            })
            .sort((a, b) => vis(b) - vis(a));
        if (withDuration.length) return withDuration[0];

        // 3. 再找已经加载媒体元数据的视频。
        const ready = vids
            .filter(v => {
                try { return v.readyState >= 1 || v.currentTime > 0; } catch { return false; }
            })
            .sort((a, b) => vis(b) - vis(a));
        if (ready.length) return ready[0];

        // 4. 最后按可见面积选择，兼容手机播放器刚创建但尚未完成 metadata 的阶段。
        return vids.sort((a, b) => vis(b) - vis(a))[0];
    }

    /* =========================================================
       Rain · 隐形全屏水印
       ========================================================= */

    function createWatermark() {
        console.log('[VFA] createWatermark() 开始执行');

        // 如果已经存在，先删除旧水印
        const old = document.getElementById('vfa-watermark');
        if (old) {
            old.remove();
        }

        const wm = document.createElement('div');

        wm.id = 'vfa-watermark';

        Object.assign(wm.style, {
            position: 'fixed',
            left: '0',
            top: '0',
            width: '100vw',
            height: '100vh',

            zIndex: '2147483647',

            pointerEvents: 'none',

            overflow: 'hidden',

            display: 'block',

            visibility: 'visible',

            opacity: '1',

            background: 'transparent',

            transform: 'translateZ(0)',

            isolation: 'isolate'
        });

        const CELL_W = 300;
        const CELL_H = 190;

        const cols =
            Math.ceil(window.innerWidth / CELL_W) + 2;

        const rows =
            Math.ceil(window.innerHeight / CELL_H) + 2;

        const fragment =
            document.createDocumentFragment();

        const pattern = [
            [0, 0, -8],
            [1, 0, 7],
            [2, 0, -5],

            [0, 1, 6],
            [1, 1, -7],
            [2, 1, 9],

            [0, 2, -6],
            [1, 2, 5],
            [2, 2, -9]
        ];

        let count = 0;

        for (let y = 0; y < rows; y++) {

            for (let x = 0; x < cols; x++) {

                if ((x * 7 + y * 11) % 5 !== 0) {
                    continue;
                }

                const p =
                    pattern[
                    (x + y * 3) %
                    pattern.length
                    ];

                const item =
                    document.createElement('span');

                item.className =
                    'vfa-watermark-item';

                item.textContent =
                    typeof VFA_WM_NAME !== 'undefined'
                        ? VFA_WM_NAME
                        : 'RAIN';

                const offsetX =
                    ((x * 37 + y * 17) % 70) - 35;

                const offsetY =
                    ((x * 19 + y * 31) % 45) - 22;

                Object.assign(item.style, {

                    position: 'absolute',

                    left:
                        `${x * CELL_W + offsetX}px`,

                    top:
                        `${y * CELL_H + offsetY}px`,

                    /*
                     * ===== 强制测试样式 =====
                     */

                    color: 'rgba(220,225,235,0.72)',

                    opacity:
                        String(state.watermarkOpacity ?? 0.05),

                    fontSize: '11px',

                    fontWeight: '600',

                    lineHeight: '1',

                    letterSpacing: '2px',

                    whiteSpace: 'nowrap',

                    textShadow:
                        '0 1px 2px rgba(0,0,0,.28), ' +
                        '0 -1px 1px rgba(255,255,255,.08)',

                    transform:
                        `rotate(${p[2]}deg)`,

                    pointerEvents: 'none'
                    ,

                    zIndex:
                        '2147483647'
                });

                fragment.appendChild(item);

                count++;
            }
        }

        wm.appendChild(fragment);

        document.body.appendChild(wm);

        console.log(
            '[VFA] Rain watermark created:',
            count,
            'items'
        );

        /*
         * 强制检查
         */
        const first =
            wm.querySelector('.vfa-watermark-item');

        if (first) {

            console.log(
                '[VFA] 水印文字:',
                first.textContent
            );

            console.log(
                '[VFA] 水印计算样式:',
                getComputedStyle(first).color,
                getComputedStyle(first).opacity,
                getComputedStyle(first).fontSize,
                getComputedStyle(first).visibility
            );

            console.log(
                '[VFA] 水印位置:',
                first.getBoundingClientRect()
            );
        }
    }






    function setSmooth(on) {
        state.smoothMode = !!on;
        store.set('smoothMode', state.smoothMode);

        document.documentElement.toggleAttribute(
            'vfa-smooth',
            state.smoothMode
        );

        // 确保 VFA 自己的玻璃状态立即重新合成
        if (state.wrap) {
            state.wrap.style.transform = 'translateZ(0)';
            requestAnimationFrame(() => {
                state.wrap.style.transform = '';
            });
        }

        if (state.panel) {
            state.panel.style.transform = 'translateZ(0)';
            requestAnimationFrame(() => {
                state.panel.style.transform = '';
            });
        }
    }

    function setFreeze(on) { state.freezeDecor = on; store.set('freezeDecor', on); document.documentElement.toggleAttribute('vfa-freeze', on); }
    function setDanmaku(on) { state.hideDanmaku = on; store.set('hideDanmaku', on); document.documentElement.toggleAttribute('vfa-danmaku', on); }

    /* ---------------- 离屏视频暂停 ---------------- */
    const io = new IntersectionObserver(entries => {
        if (!state.pauseOffscreen) return;
        for (const en of entries) {
            const v = en.target;
            if (en.intersectionRatio < 0.4 && !v.paused) {
                v.pause(); v._vfaPausedByUs = true;
                v._vfaPreload = v.preload; v.preload = 'none';
            } else if (en.intersectionRatio >= 0.4 && v._vfaPausedByUs) {
                v.play().catch(() => { });
                v.preload = v._vfaPreload || 'auto';
                v._vfaPausedByUs = false;
            }
        }
    }, { threshold: [0, 0.4] });

    function watchVideo(v) {
        if (v.dataset.vfa) return;

        v.dataset.vfa = '1';

        io.observe(v);

        applySpeed(v);
        applyRememberedVolume(v);

        /*
         * 如果当前处于旋转/镜像状态，
         * 新视频自动继承。
         */
        if (
            state.rotation !== 0 ||
            state.mirrored
        ) {
            requestAnimationFrame(() => {
                if (getVideo() === v) {
                    applyTf();
                }
            });
        }
    }
    setInterval(() => {
        if (
            !state.rotation &&
            !state.mirrored
        ) {
            return;
        }

        const v = getVideo();

        if (!v) return;

        if (v !== vfaCanvasVideo) {
            startVfaCanvas(v);
        }
    }, 500);


    // 倍速跨视频持续生效：抖音等 SPA 换集时站点会重置 playbackRate，每 500ms 纠偏
    function applySpeed(v) {
        if (state.rememberSpeed && Math.abs(v.playbackRate - state.speed) > 0.01) v.playbackRate = state.speed;
    }
    setInterval(() => {
        if (!state.rememberSpeed) return;
        document.querySelectorAll('video[data-vfa]').forEach(applySpeed);
    }, 500);

    // 2.2：音量记忆默认关闭，开启后才接管音量。
    function applyRememberedVolume(v) {
        if (!state.rememberVolume || !v) return;
        const volume = Math.min(1, Math.max(0, Number(state.volume)));
        try { v.volume = volume; v.muted = !!state.muted; } catch { }
    }
    setInterval(() => {
        if (!state.rememberVolume) return;
        const v = getVideo();
        if (v) applyRememberedVolume(v);
    }, 1000);
    function syncRememberVolumeUI(v) {
        if (!v || v.tagName !== 'VIDEO') return;
        const value = Math.round(Math.min(1, Math.max(0, Number(v.volume))) * 100);
        const range = document.getElementById('vfa-volume-range');
        const out = document.getElementById('vfa-volume-value');
        const icon = document.getElementById('vfa-volume-icon');
        if (range) {
            range.value = value;
            range.style.setProperty('--vfa-volume', value + '%');
        }
        if (out) out.textContent = value + '%';
        if (icon) icon.textContent = (v.muted || value === 0) ? '🔇' : value < 50 ? '🔉' : '🔊';
    }

    document.addEventListener('volumechange', e => {
        const v = e.target;
        if (v?.tagName !== 'VIDEO') return;

        // 无论面板是否打开，都以视频实际的 volume / muted 为准实时同步 UI。
        syncRememberVolumeUI(v);

        if (state.rememberVolume) {
            state.volume = Math.min(1, Math.max(0, Number(v.volume)));
            state.muted = !!v.muted;
            store.set('volume', state.volume);
            store.set('muted', state.muted);
        }
    }, true);

    document.addEventListener('loadeddata', e => {
        if (e.target.tagName === 'VIDEO') {
            applySpeed(e.target);
            applyRememberedVolume(e.target);
            if (state.open) syncVolumeSlider();
        }
    }, true);
    // 抐音弹幕 DOM 每帧变动，必须去抖扫描，否则全页低帧率
    let scanTimer = null;
    const scanVideos = () => {
        if (scanTimer) return;
        scanTimer = setTimeout(() => {
            scanTimer = null;
            document.querySelectorAll('video:not([data-vfa])').forEach(watchVideo);
        }, 500);
    };
    new MutationObserver(scanVideos).observe(document.body || document.documentElement, { childList: true, subtree: true });
    document.querySelectorAll('video').forEach(watchVideo);

    /* ---------------- FPS 监控 ---------------- */
    function startFps() {
        let last = performance.now(), frames = 0;
        setInterval(() => {
            const vid = getVideo();
            if (vid && !vid.paused) {
                if (state.fps < 22 && !state.smoothMode) {
                    if (!state.lowFpsSince) state.lowFpsSince = Date.now();
                    if (Date.now() - state.lowFpsSince > 4000 && !state.autoSmoothed) {
                        setSmooth(true); setDanmaku(true);
                        state.autoSmoothed = true;
                        toast('🚀 检测到卡顿，已自动开启流畅模式');
                    }
                } else state.lowFpsSince = 0;
            }
        }, 1000);
        (function loop(now) {
            frames++;
            if (now - last >= 1000) {
                state.fps = frames; frames = 0; last = now;
                const el = document.getElementById('vfa-fps');
                if (el) {
                    el.textContent = state.fps + ' FPS';
                    el.style.color = state.fps >= 45 ? '#7dffb0' : state.fps >= 25 ? '#ffd97d' : '#ff8d8d';
                }
            }
            requestAnimationFrame(loop);
        })(performance.now());
    }

    /* ---------------- 核心功能 ---------------- */
    function setSpeed(v) {
        v = Math.min(16, Math.max(0.25, Math.round(v * 100) / 100));
        const vid = getVideo();
        if (vid) {
            vid.playbackRate = v;
            if (state.rememberSpeed) { state.speed = v; store.set('speed', v); }
            toast(`⚡ ${v}x 倍速`);
            const el = document.getElementById('vfa-speed');
            if (el) el.textContent = (+v.toFixed(2)) + 'x';
        } else if (VFA_IS_TOP && vfaRemoteVideoState) {
            try { vfaBroadcastToFrames('set-speed', { speed: v }); } catch { }
            if (state.rememberSpeed) { state.speed = v; store.set('speed', v); }
            toast(`⚡ ${v}x 倍速`);
            const el = document.getElementById('vfa-speed');
            if (el) el.textContent = (+v.toFixed(2)) + 'x';
        }
    }
    const nudge = s => {
        const v = getVideo();
        if (v) {
            v.currentTime = Math.min(v.duration || Infinity, Math.max(0, v.currentTime + s));
            toast(s > 0 ? `⏩ +${s}s` : `⏪ ${s}s`);
        } else if (VFA_IS_TOP && vfaRemoteVideoState) {
            const d = Number(vfaRemoteVideoState.duration) || Infinity;
            const t = Number(vfaRemoteVideoState.currentTime) || 0;
            const target = Math.min(d, Math.max(0, t + s));
            vfaBroadcastToFrames('seek', { time: target });
            toast(s > 0 ? `⏩ +${s}s` : `⏪ ${s}s`);
        }
    };
    /* =========================================================
       VFA 2.2 · 增强播放控制
       ========================================================= */
    function formatTime(sec) {
        if (!Number.isFinite(sec) || sec < 0) return '--';
        sec = Math.floor(sec);
        const h = Math.floor(sec / 3600);
        const m = Math.floor((sec % 3600) / 60);
        const ss = sec % 60;
        return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}` : `${m}:${String(ss).padStart(2, '0')}`;
    }
    function updateAbUI() {
        const status = document.getElementById('vfa-ab-status');
        if (!status) return;
        status.textContent = `A ${state.abA == null ? '--' : formatTime(state.abA)} · B ${state.abB == null ? '--' : formatTime(state.abB)}`;
        status.classList.toggle('active', state.abLoop);
        const a = document.querySelector('#vfa-panel [data-a="abA"]');
        const b = document.querySelector('#vfa-panel [data-a="abB"]');
        const l = document.querySelector('#vfa-panel [data-a="abLoop"]');
        a?.classList.toggle('active', state.abA != null);
        b?.classList.toggle('active', state.abB != null);
        l?.classList.toggle('active', state.abLoop);
        if (l) l.textContent = state.abLoop ? '循环中' : '循环';
    }
    function setAbPoint(which) {
        const v = getVideo();
        if (!v || !Number.isFinite(v.currentTime)) { toast('⚠️ 没有可用的视频'); return; }
        if (which === 'A') {
            state.abA = Math.max(0, v.currentTime);
            if (state.abB != null && state.abB <= state.abA) state.abB = null;
            state.abLoop = false;
            updateAbUI();
            toast(`🔁 A 点 ${formatTime(state.abA)}`);
            return;
        }
        if (state.abA == null) { toast('⚠️ 请先设置 A 点'); return; }
        if (v.currentTime <= state.abA + 0.1) { toast('⚠️ B 点必须晚于 A 点'); return; }
        state.abB = v.currentTime;
        state.abLoop = false;
        updateAbUI();
        toast(`🔁 B 点 ${formatTime(state.abB)}`);
    }
    function toggleAbLoop() {
        if (state.abA == null || state.abB == null || state.abB <= state.abA) { toast('⚠️ 请先设置有效的 A、B 点'); return; }
        state.abLoop = !state.abLoop;
        if (state.abLoop) {
            const v = getVideo();
            if (v && (v.currentTime < state.abA || v.currentTime >= state.abB)) v.currentTime = state.abA;
            toast('🔁 A-B 循环已开启');
        } else toast('🔁 A-B 循环已关闭');
        updateAbUI();
    }
    function resetAbLoop() { state.abA = null; state.abB = null; state.abLoop = false; updateAbUI(); toast('🧹 A-B 循环已清除'); }
    document.addEventListener('timeupdate', e => {
        const v = e.target;
        if (v?.tagName !== 'VIDEO' || !state.abLoop) return;
        if (state.abA == null || state.abB == null || state.abB <= state.abA) { state.abLoop = false; updateAbUI(); return; }
        if (v.currentTime >= state.abB - 0.03) { v.currentTime = state.abA; if (v.paused) v.play().catch(() => { }); }
    }, true);
    async function toggleFullscreen() {
        const v = getVideo();
        if (!v) { toast('⚠️ 没有找到可用的视频'); return; }
        try {
            if (document.fullscreenElement) { await document.exitFullscreen(); toast('⛶ 已退出全屏'); return; }
            if (v.requestFullscreen) { await v.requestFullscreen(); toast('⛶ 已进入全屏'); } else toast('⚠️ 当前浏览器不支持全屏');
        } catch (err) { console.warn('[VFA] Fullscreen error:', err); toast('⚠️ 全屏请求被浏览器拒绝'); }
    }
    function getBilibiliWebFullscreenButton() {
        // 优先交给 B 站自己的播放器状态机处理。B站的“网页全屏”
        // 本质是给播放器切换 mode-webfullscreen，而不是调用浏览器 Fullscreen API。
        const selectors = [
            '.bpx-player-ctrl-web-enter:not([style*="display: none"])',
            '.bpx-player-ctrl-web-enter',
            '.squirtle-pagefullscreen-inactive',
            '.bilibili-player-video-web-fullscreen',
            '.bilibili-player-video-btn-fullscreen .bilibili-player-video-web-fullscreen'
        ];
        for (const selector of selectors) {
            const nodes = document.querySelectorAll(selector);
            for (const node of nodes) {
                if (!node || node === state.wrap || state.wrap?.contains(node)) continue;
                const style = getComputedStyle(node);
                const rect = node.getBoundingClientRect();
                if (style.display !== 'none' && style.visibility !== 'hidden' && rect.width >= 1 && rect.height >= 1) {
                    return node;
                }
            }
        }
        return null;
    }

    function getBilibiliWebFullscreenLeaveButton() {
        const selectors = [
            '.bpx-player-ctrl-web-leave',
            '.squirtle-pagefullscreen-active'
        ];
        for (const selector of selectors) {
            const node = document.querySelector(selector);
            if (node && getComputedStyle(node).display !== 'none') return node;
        }
        return null;
    }

    function getVisibleMediaFrame() {
        // 跨域播放器无法从顶层 userscript 进入 iframe 内部，因此把“播放器 iframe”
        // 本身视为完整播放器根节点。这里不再简单选最大的 iframe，避免误选广告/评论框。
        const frames = [...document.querySelectorAll('iframe')];
        const candidates = frames.map(frame => {
            const r = frame.getBoundingClientRect();
            const cs = getComputedStyle(frame);
            if (r.width < 240 || r.height < 140 || r.width * r.height < 30000 ||
                cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return null;

            const meta = `${frame.id || ''} ${frame.className || ''} ${frame.title || ''} ` +
                `${frame.name || ''} ${frame.src || ''}`.toLowerCase();
            let score = 0;
            if (/(player|video|media|play|embed|stream|hls)/i.test(meta)) score += 80;
            if (/(player|video|media|play|embed|stream)/i.test(frame.title || '')) score += 30;
            if (/(ads?|banner|advert|analytics|comment|comments|captcha)/i.test(meta)) score -= 120;
            const ratio = r.width / Math.max(1, r.height);
            if (ratio >= 1.25 && ratio <= 2.2) score += 20;
            score += Math.min(40, (r.width * r.height) / (window.innerWidth * window.innerHeight) * 40);
            return { frame, score, area: r.width * r.height };
        }).filter(Boolean);

        if (!candidates.length) return null;
        candidates.sort((a, b) => (b.score - a.score) || (b.area - a.area));
        return candidates[0].frame;
    }

    function getWebFullscreenTarget(v) {
        if (!v) return getVisibleMediaFrame();

        const vr = v.getBoundingClientRect();
        const videoArea = Math.max(1, vr.width * vr.height);
        let el = v;
        let best = null;
        let bestScore = -Infinity;

        // 目标是“同时包住 video 和播放器控制栏”的最小播放器根节点。
        // 优先寻找带有 player/video/media/control/progress 等特征的祖先，
        // 避免把整个播放页、选集区、简介区一起固定到视口。
        for (let depth = 0; depth < 10 && el && el.parentElement; depth++) {
            const parent = el.parentElement;
            if (parent === document.body || parent === document.documentElement) break;

            const r = parent.getBoundingClientRect();
            const cs = getComputedStyle(parent);
            const area = Math.max(0, r.width) * Math.max(0, r.height);
            if (r.width < vr.width * 0.88 || r.height < vr.height * 0.88 || area < videoArea * 0.88) {
                el = parent;
                continue;
            }

            const meta = `${parent.id || ''} ${parent.className || ''} ${parent.getAttribute('role') || ''}`;
            const descendantMeta = parent.querySelector(
                '[class*="control"],[class*="progress"],[class*="seek"],' +
                '[class*="toolbar"],[class*="controller"],[class*="player"]'
            ) ? 'control' : '';
            const hasPlayerName = /(player|video|media|play-container|play-wrap|video-container|video-wrap)/i.test(meta);
            const hasControl = /(control|progress|seek|toolbar|controller|fullscreen|volume)/i.test(meta) || !!descendantMeta;
            const hasVideo = parent.contains(v);

            let score = 0;
            if (hasPlayerName) score += 100;
            if (hasControl) score += 65;
            if (hasVideo) score += 20;
            if (cs.position === 'fixed' || cs.position === 'absolute' || cs.position === 'relative') score += 5;

            // 越接近 video 越优先，但如果外层明显是播放器根节点，则允许它胜出。
            score -= depth * 7;
            const areaRatio = area / videoArea;
            if (areaRatio <= 1.8) score += 25;
            else if (areaRatio <= 3.0) score += 8;
            else score -= 35;

            // 如果一个祖先已经明显覆盖了页面的大部分内容，则降权。
            const viewportArea = Math.max(1, innerWidth * innerHeight);
            if (area > viewportArea * 1.25) score -= 80;

            if (score > bestScore) {
                bestScore = score;
                best = parent;
            }
            el = parent;
            if (cs.position === 'fixed') break;
        }

        return best || v.parentElement;
    }

    function exitWebFullscreen(showToast = true) {
        // B站网页全屏由它自己的播放器状态机负责退出。
        if (state.webFullscreen === 'bilibili') {
            const leave = getBilibiliWebFullscreenLeaveButton();
            if (leave) {
                leave.click();
                state.webFullscreen = false;
                state.webFullscreenVideo = null;
                if (showToast) toast('🖥️ 已退出网页全屏');
                return;
            }
            state.webFullscreen = false;
            state.webFullscreenVideo = null;
            return;
        }

        const target = state.webFullscreenVideo;
        if (state.webFullscreenViewportResize && window.visualViewport) {
            try { window.visualViewport.removeEventListener('resize', state.webFullscreenViewportResize); } catch {}
        }
        if (state.webFullscreenResizeBound) {
            try { window.removeEventListener('resize', state.webFullscreenResizeBound); } catch {}
        }
        state.webFullscreenViewportResize = null;
        state.webFullscreenResizeBound = null;

        if (target) {
            target.classList.remove('vfa-web-fullscreen-target');
            if (state.webFullscreenStyleBackup !== null) {
                if (state.webFullscreenStyleBackup === '') target.removeAttribute('style');
                else target.setAttribute('style', state.webFullscreenStyleBackup);
            }
        }
        // 页面本身从未进入网页全屏，因此退出时只恢复播放器容器。
        state.webFullscreen = false;
        state.webFullscreenVideo = null;
        state.webFullscreenStyleBackup = null;

        // 连续两帧恢复布局，给站点自己的响应式播放器时间重新计算
        // 视频比例、控制栏和进度条。
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                try {
                    window.dispatchEvent(new Event('resize'));
                    document.querySelectorAll('video').forEach(x => {
                        try { x.dispatchEvent(new Event('resize')); } catch {}
                    });
                } catch {}
            });
        });
        if (showToast) toast('🖥️ 已退出网页全屏');
    }

    function toggleWebFullscreen() {
        if (state.webFullscreen) {
            exitWebFullscreen();
            return;
        }

        // 在 B 站直接调用 B 站原生“网页全屏”按钮。
        // 这样会进入它自己的 mode-webfullscreen，播放器、弹幕、控制栏和视频渲染层
        // 都保持在原来的 DOM 结构中，不会出现把 video 脱离渲染树后黑屏的问题。
        const bilibiliButton = getBilibiliWebFullscreenButton();
        if (bilibiliButton) {
            try {
                bilibiliButton.click();
                state.webFullscreen = 'bilibili';
                toast('🖥️ 已进入网页全屏');
                return;
            } catch (err) {
                console.warn('[VFA] Bilibili web fullscreen error:', err);
            }
        }

        const v = getVideo();
        const mediaFrame = v ? null : getVisibleMediaFrame();
        if (!v && !mediaFrame) {
            toast('⚠️ 没有找到可用的视频播放器');
            return;
        }

        const target = v ? getWebFullscreenTarget(v) : mediaFrame;
        if (!target || target === document.body || target === document.documentElement || target === v) {
            toast('⚠️ 当前页面没有找到稳定的视频播放器容器');
            return;
        }

        // 保存进入网页全屏前的 inline style。
        // 退出时原样恢复，避免播放器被网站的旧固定尺寸卡在顶部。
        state.webFullscreenStyleBackup = target.getAttribute('style');

        // 这里只处理播放器本身。
        // 不给 html/body 加全屏 class，避免把整张网页的滚动和布局一起锁死。
        target.classList.add('vfa-web-fullscreen-target');
        state.webFullscreen = true;
        state.webFullscreenVideo = target;

        const syncWebFullscreenLayout = () => {
            if (!state.webFullscreen) return;
            try {
                window.dispatchEvent(new Event('resize'));
                v?.dispatchEvent(new Event('resize'));
            } catch {}
        };

        // 进入后立即同步一次，随后等下一帧。
        syncWebFullscreenLayout();
        requestAnimationFrame(syncWebFullscreenLayout);

        // 浏览器窗口从小尺寸放大到最大时，重新通知播放器布局。
        if (window.visualViewport) {
            window.visualViewport.addEventListener('resize', syncWebFullscreenLayout, { passive: true });
            state.webFullscreenViewportResize = syncWebFullscreenLayout;
        }
        const onWindowResize = () => syncWebFullscreenLayout();
        window.addEventListener('resize', onWindowResize, { passive: true });
        state.webFullscreenResizeBound = onWindowResize;
        toast('🖥️ 已进入网页全屏');
    }

    document.addEventListener('keydown', e => {
        if (e.key === 'Escape' && state.webFullscreen) {
            e.preventDefault();
            exitWebFullscreen();
        }
    }, true);
    document.addEventListener('fullscreenchange', () => {
        // 原生全屏退出时，不误关闭网页全屏状态。两者互相独立。
    });
    function toggleMute() {
        const v = getVideo();
        if (!v) { toast('⚠️ 没有找到可用的视频'); return; }
        v.muted = !v.muted;
        // 音量记忆开启时，静音状态也立即写入记忆。
        if (state.rememberVolume) {
            state.volume = Math.min(1, Math.max(0, Number(v.volume)));
            state.muted = !!v.muted;
            store.set('volume', state.volume);
            store.set('muted', state.muted);
        }
        syncRememberVolumeUI(v);
        toast(v.muted ? '🔇 静音' : '🔊 有声');
    }

    function togglePlay() {
        const v = getVideo();
        if (v) {
            const willPlay = v.paused;
            willPlay ? v.play() : v.pause();
            toast(willPlay ? '▶ 播放' : '⏸ 暂停');
        } else if (VFA_IS_TOP && vfaRemoteVideoState) {
            try { vfaBroadcastToFrames('play-pause'); } catch { }
            toast(vfaRemoteVideoState.paused ? '▶ 播放' : '⏸ 暂停');
        }
    }
    /* =========================================================
       视频旋转 / 镜像
       Canvas 独立渲染方案
       ========================================================= */

    let vfaCanvas = null;
    let vfaCanvasCtx = null;
    let vfaCanvasVideo = null;
    let vfaCanvasRAF = 0;
    let vfaCanvasRunning = false;


    /* 创建 Canvas */
    function createVfaCanvas() {
        if (vfaCanvas && vfaCanvas.isConnected) {
            return vfaCanvas;
        }

        vfaCanvas = document.createElement('canvas');

        vfaCanvas.id = 'vfa-video-canvas';

        Object.assign(vfaCanvas.style, {
            position: 'fixed',
            zIndex: '2147483640',
            display: 'none',
            pointerEvents: 'none',
            margin: '0',
            padding: '0',
            border: '0',
            background: '#000',
            objectFit: 'contain',
            transformOrigin: 'center center'
        });

        document.body.appendChild(vfaCanvas);

        vfaCanvasCtx = vfaCanvas.getContext('2d', {
            alpha: false,
            desynchronized: true
        });

        return vfaCanvas;
    }


    /* 找当前视频实际显示区域 */
    function getVideoRect(v) {
        const r = v.getBoundingClientRect();

        return {
            left: r.left,
            top: r.top,
            width: r.width,
            height: r.height
        };
    }


    /* Canvas 绘制 */
    function drawVfaCanvas() {
        if (!vfaCanvasRunning) return;

        const v = vfaCanvasVideo;

        if (!v || !v.isConnected) {
            stopVfaCanvas();
            return;
        }

        if (!v.videoWidth || !v.videoHeight) {
            vfaCanvasRAF = requestAnimationFrame(drawVfaCanvas);
            return;
        }

        const rect = getVideoRect(v);

        if (rect.width <= 1 || rect.height <= 1) {
            vfaCanvasRAF = requestAnimationFrame(drawVfaCanvas);
            return;
        }

        const rotation = state.rotation;
        const mirror = state.mirrored;

        /*
         * 旋转适配：Canvas 本身始终锁定在原视频显示区域内。
         * 旧方案在 90° / 270° 时直接交换 Canvas 宽高，
         * 会让 Canvas 的长边跑出播放器区域。
         * 这里改为“固定显示框 + contain”，旋转后的画面始终完整落在原视频区域。
         */
        const rotated =
            rotation === 90 ||
            rotation === 270;

        const cssWidth = rect.width;
        const cssHeight = rect.height;

        const dpr = Math.min(window.devicePixelRatio || 1, 2);

        const pixelWidth = Math.max(1, Math.round(cssWidth * dpr));
        const pixelHeight = Math.max(1, Math.round(cssHeight * dpr));

        if (
            vfaCanvas.width !== pixelWidth ||
            vfaCanvas.height !== pixelHeight
        ) {
            vfaCanvas.width = pixelWidth;
            vfaCanvas.height = pixelHeight;
        }

        /*
         * Canvas 覆盖原视频区域
         */
        vfaCanvas.style.left =
            (rect.left + (rect.width - cssWidth) / 2) + 'px';

        vfaCanvas.style.top =
            (rect.top + (rect.height - cssHeight) / 2) + 'px';

        vfaCanvas.style.width = cssWidth + 'px';
        vfaCanvas.style.height = cssHeight + 'px';

        const ctx = vfaCanvasCtx;

        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(
            0,
            0,
            vfaCanvas.width,
            vfaCanvas.height
        );

        ctx.save();

        /*
         * 使用像素尺寸坐标
         */
        ctx.translate(
            vfaCanvas.width / 2,
            vfaCanvas.height / 2
        );

        /*
         * 旋转
         */
        ctx.rotate(rotation * Math.PI / 180);

        /*
         * 镜像
         */
        if (mirror) {
            ctx.scale(-1, 1);
        }

        /*
         * 计算旋转后的“可视尺寸”。
         * 90° / 270° 后，视频宽高比会反过来。
         * 先在 Canvas 显示框内做 contain，再把这组尺寸反向映射到
         * rotate() 之前的坐标系，这样旋转后仍然不会越界。
         */
        const visualRatio = rotated
            ? (v.videoHeight / v.videoWidth)
            : (v.videoWidth / v.videoHeight);

        const boxRatio =
            vfaCanvas.width / vfaCanvas.height;

        let visualW;
        let visualH;

        if (visualRatio > boxRatio) {
            visualW = vfaCanvas.width;
            visualH = visualW / visualRatio;
        } else {
            visualH = vfaCanvas.height;
            visualW = visualH * visualRatio;
        }

        // 旋转后的视觉宽高 = 旋转前绘制矩形的高宽。
        const dw = rotated ? visualH : visualW;
        const dh = rotated ? visualW : visualH;

        /*
         * 绘制视频
         */
        try {
            ctx.drawImage(
                v,
                -dw / 2,
                -dh / 2,
                dw,
                dh
            );
        } catch (err) {
            console.warn('[VFA] Canvas draw error:', err);
        }

        ctx.restore();

        vfaCanvasRAF = requestAnimationFrame(drawVfaCanvas);
    }


    /* 开启 Canvas 模式 */
    function startVfaCanvas(v) {
        if (!v) return;

        createVfaCanvas();

        vfaCanvasVideo = v;
        vfaCanvasRunning = true;

        /*
         * 原视频继续播放和解码，
         * 但视觉上隐藏。
         *
         * 不使用 display:none，
         * 否则某些浏览器会停止视频渲染。
         */
        v.style.opacity = '0';

        vfaCanvas.style.display = 'block';

        cancelAnimationFrame(vfaCanvasRAF);

        vfaCanvasRAF =
            requestAnimationFrame(drawVfaCanvas);
    }


    /* 关闭 Canvas 模式 */
    function stopVfaCanvas() {
        vfaCanvasRunning = false;

        cancelAnimationFrame(vfaCanvasRAF);

        vfaCanvasRAF = 0;

        if (vfaCanvas) {
            vfaCanvas.style.display = 'none';
        }

        if (vfaCanvasVideo && vfaCanvasVideo.isConnected) {
            vfaCanvasVideo.style.opacity = '';
        }

        vfaCanvasVideo = null;
    }


    /* 应用旋转 */
    function applyTf() {
        const v = getVideo();

        if (!v) return;

        /*
         * 0° + 没镜像：
         * 完全恢复原视频。
         */
        if (
            state.rotation === 0 &&
            !state.mirrored
        ) {
            stopVfaCanvas();
            return;
        }

        /*
         * 只要旋转或镜像开启，
         * 就进入 Canvas 渲染模式。
         */
        startVfaCanvas(v);
    }


    /* 镜像 */
    function toggleMirror() {
        state.mirrored = !state.mirrored;

        applyTf();

        toast(
            state.mirrored
                ? '🪞 已镜像'
                : '🪞 已还原'
        );
    }


    /* 旋转 */
    function rotate() {
        state.rotation =
            (state.rotation + 90) % 360;

        applyTf();

        toast(`🔄 ${state.rotation}°`);
    }

    async function togglePip() {
        const v = getVideo();

        if (!v) {
            toast('⚠️ 没有找到可用的视频');
            return;
        }

        try {
            if (document.pictureInPictureElement) {
                await document.exitPictureInPicture();
                toast('📺 已退出画中画');
                return;
            }

            if (!document.pictureInPictureEnabled) {
                toast('⚠️ 当前浏览器不支持画中画');
                return;
            }

            // 尝试解除网站对 PiP 的限制
            try {
                v.disablePictureInPicture = false;
            } catch { }

            if (!v.videoWidth || !v.videoHeight) {
                toast('⚠️ 视频还没有加载完成');
                return;
            }

            if (v.paused) {
                await v.play().catch(() => { });
            }

            await v.requestPictureInPicture();

            toast('📺 已开启画中画');

        } catch (err) {
            console.warn('[VFA] PiP error:', err);

            if (err?.name === 'NotAllowedError') {
                toast('⚠️ 浏览器拒绝了画中画请求');
            } else if (err?.name === 'InvalidStateError') {
                toast('⚠️ 当前视频暂时无法进入画中画');
            } else {
                toast('⚠️ 画中画开启失败');
            }
        }
    }

    document.addEventListener('enterpictureinpicture', () => {
        const btn = document.querySelector('#vfa-panel [data-a="pip"]');
        if (btn) {
            btn.textContent = '📺 退出画中画';
        }
    });

    document.addEventListener('leavepictureinpicture', () => {
        const btn = document.querySelector('#vfa-panel [data-a="pip"]');
        if (btn) {
            btn.textContent = '📺 画中画';
        }
    });

    /* ---------------- 智能片头 / 片尾 ---------------- */
    // 片头/片尾采用“全站长期定义”记忆。
    // 这里刻意不按 video.src、m3u8、blob、当前集 URL 建立记忆，
    // 因为连续剧自动下一集时这些值都会变化。只要仍在同一个脚本环境中，
    // 之前定义的时间就会继续继承到下一集，并通过 GM/localStorage 长期保存。
    const SKIP_MEMORY_KEY = 'skipTimeDefinition_v3';

    function getSkipGlobalMemory() {
        try {
            const saved = store.get(SKIP_MEMORY_KEY, null);
            if (saved && typeof saved === 'object') {
                return {
                    intro: Number.isFinite(Number(saved.intro)) ? Math.max(0, Number(saved.intro)) : null,
                    outro: Number.isFinite(Number(saved.outro)) ? Math.max(0, Number(saved.outro)) : null
                };
            }
        } catch { }

        // 兼容之前版本已经保存过的时间。
        return {
            intro: Number.isFinite(Number(store.get('skipIntroDefined', null))) ? Math.max(0, Number(store.get('skipIntroDefined', 0))) : null,
            outro: Number.isFinite(Number(store.get('skipOutroDefined', null))) ? Math.max(0, Number(store.get('skipOutroDefined', 0))) : null
        };
    }

    function saveSkipMemory(v, intro, outro) {
        const old = getSkipGlobalMemory();
        const memory = {
            intro: intro != null ? Math.max(0, Number(intro) || 0) : old.intro,
            outro: outro != null ? Math.max(0, Number(outro) || 0) : old.outro,
            updatedAt: Date.now()
        };

        // 一个固定的长期记忆对象，所有集数共享。
        store.set(SKIP_MEMORY_KEY, memory);

        // 同时写旧键，兼容旧版本数据和已有配置。
        if (memory.intro != null) {
            store.set('skipIntroDefined', memory.intro);
            store.set('skipIntroSec', memory.intro);
        }
        if (memory.outro != null) {
            store.set('skipOutroDefined', memory.outro);
            store.set('skipOutroSec', memory.outro);
        }
    }

    function formatTime(sec) {
        sec = Math.max(0, Number(sec) || 0);
        const h = Math.floor(sec / 3600);
        const m = Math.floor((sec % 3600) / 60);
        const s = Math.floor(sec % 60);
        return h > 0
            ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
            : `${m}:${String(s).padStart(2, '0')}`;
    }

    function getSkipMediaState(v = getVideo()) {
        if (v) {
            try {
                const duration = Number(v.duration);
                const currentTime = Number(v.currentTime);
                return {
                    duration: Number.isFinite(duration) && duration > 0 ? duration : 0,
                    currentTime: Number.isFinite(currentTime) && currentTime >= 0 ? currentTime : 0
                };
            } catch { }
        }

        if (VFA_IS_TOP && vfaRemoteVideoState) {
            const duration = Number(vfaRemoteVideoState.duration);
            const currentTime = Number(vfaRemoteVideoState.currentTime);
            return {
                duration: Number.isFinite(duration) && duration > 0 ? duration : 0,
                currentTime: Number.isFinite(currentTime) && currentTime >= 0 ? currentTime : 0
            };
        }

        return { duration: 0, currentTime: 0 };
    }

    function getSkipDuration(v) {
        return getSkipMediaState(v).duration;
    }
    function parseTimeInput(value) {
        const raw = String(value ?? '').trim();
        if (!raw) return null;

        const cn = raw.replace(/\s+/g, '');
        const cnMatch = cn.match(/^(?:(\d+(?:\.\d+)?)小时)?(?:(\d+(?:\.\d+)?)分钟?)?(?:(\d+(?:\.\d+)?)秒)?$/);
        if (cnMatch && /[时分秒]/.test(cn)) {
            const h = Number(cnMatch[1] || 0);
            const m = Number(cnMatch[2] || 0);
            const s = Number(cnMatch[3] || 0);
            return [h, m, s].every(Number.isFinite) ? Math.max(0, h * 3600 + m * 60 + s) : null;
        }

        if (/^\d+(?:\.\d+)?$/.test(raw)) return Math.max(0, Number(raw));

        const parts = raw.split(':').map(x => x.trim());
        if (parts.length === 2 && parts.every(x => /^\d+(?:\.\d+)?$/.test(x))) {
            return Math.max(0, Number(parts[0]) * 60 + Number(parts[1]));
        }
        if (parts.length === 3 && parts.every(x => /^\d+(?:\.\d+)?$/.test(x))) {
            return Math.max(0, Number(parts[0]) * 3600 + Number(parts[1]) * 60 + Number(parts[2]));
        }
        return null;
    }


    function formatSkipTime(sec, duration = 0) {
        if (!Number.isFinite(sec) || sec < 0) return '--';
        sec = Math.floor(sec);
        duration = Number(duration) || 0;
        const useHours = duration >= 3600;
        const h = Math.floor(sec / 3600);
        const m = Math.floor((sec % 3600) / 60);
        const ss = sec % 60;
        if (useHours) return `${h}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
        return `${Math.floor(sec / 60)}:${String(ss).padStart(2, '0')}`;
    }

    function updateSkipTimeFormat(v) {
        const duration = getSkipMediaState(v).duration;
        const label = duration > 3600 ? '（时:分:秒）' : '（分:秒）';
        const introFormat = document.getElementById('vfa-intro-format');
        const outroFormat = document.getElementById('vfa-outro-format');
        if (introFormat) introFormat.textContent = label;
        if (outroFormat) outroFormat.textContent = label + '开始';
    }

    function updateSkipCurrentMarkers(v = getVideo()) {
        const media = getSkipMediaState(v);
        const duration = media.duration;
        const current = media.currentTime;
        const percent = duration > 0 ? Math.min(100, Math.max(0, current / duration * 100)) : 0;
        ['intro', 'outro'].forEach(type => {
            const marker = document.getElementById(`vfa-${type}-current`);
            if (marker) marker.style.left = percent + '%';
        });
    }

    function syncSkipControls(v = getVideo(), forceMemory = false) {
        updateSkipTimeFormat(v);
        const introRange = document.getElementById('vfa-intro-range');
        const introInput = document.getElementById('vfa-intro-input');
        const introOut = document.getElementById('vfa-intro-out');
        const outroRange = document.getElementById('vfa-outro-range');
        const outroInput = document.getElementById('vfa-outro-input');
        const outroOut = document.getElementById('vfa-outro-out');
        if (!introRange || !outroRange) return;

        const media = getSkipMediaState(v);
        const duration = media.duration;
        // 每次检测到新视频/新一集，都从同一个长期定义读取。
        // 不再读取“当前集”专属键，确保自动下一集一定继承上一集设置。
        const mem = getSkipGlobalMemory();
        if (mem.intro != null) state.skipIntroSec = mem.intro;
        if (mem.outro != null) state.skipOutroSec = mem.outro;
        state.skipMediaKey = SKIP_MEMORY_KEY;
        if (forceMemory) {
            state.skipIntroApplied = false;
            state.skipOutroTriggered = false;
        }

        const introMax = Math.max(0, duration || Math.max(60, Number(state.skipIntroSec) || 0));
        const outroMax = Math.max(0, duration || Math.max(60, Number(state.skipOutroSec) || 0));
        state.skipIntroSec = Math.min(Math.max(0, Number(state.skipIntroSec) || 0), introMax);
        state.skipOutroSec = Math.min(Math.max(0, Number(state.skipOutroSec) || 0), outroMax);

        introRange.max = String(introMax);
        outroRange.max = String(outroMax);
        introRange.step = '1';
        outroRange.step = '1';
        introRange.value = String(state.skipIntroSec);
        outroRange.value = String(state.skipOutroSec);
        if (introInput && document.activeElement !== introInput) introInput.value = formatSkipTime(state.skipIntroSec, duration);
        if (outroInput && document.activeElement !== outroInput) outroInput.value = formatSkipTime(state.skipOutroSec, duration);
        if (introOut) introOut.textContent = formatSkipTime(state.skipIntroSec, duration);
        if (outroOut) outroOut.textContent = formatSkipTime(state.skipOutroSec, duration);
        updateSkipCurrentMarkers(v);
        const durEl = document.getElementById('vfa-skip-duration');
        if (durEl) durEl.textContent = duration ? `视频总时长 ${formatSkipTime(duration, duration)}` : '等待视频时长…';
    }

    function setSkipIntroValue(value, save = true) {
        const v = getVideo();
        const duration = getSkipMediaState(v).duration;
        let n = parseTimeInput(value);
        if (n == null) return false;
        n = Math.max(0, n);
        if (duration) n = Math.min(n, duration);
        state.skipIntroSec = Math.round(n);
        if (save) saveSkipMemory(v, state.skipIntroSec, null);
        const r = document.getElementById('vfa-intro-range');
        const i = document.getElementById('vfa-intro-input');
        const o = document.getElementById('vfa-intro-out');
        if (r) r.value = state.skipIntroSec;
        if (i) i.value = formatSkipTime(state.skipIntroSec, duration);
        if (o) o.textContent = formatSkipTime(state.skipIntroSec, duration);
        store.set('skipIntroSec', state.skipIntroSec);
        store.set('skipIntroDefined', state.skipIntroSec);
        state.skipIntroApplied = false;
        if (VFA_IS_TOP) vfaBroadcastToFrames('skip-settings', { skipIntro: state.skipIntro, skipOutro: state.skipOutro, skipIntroSec: state.skipIntroSec, skipOutroSec: state.skipOutroSec });
        return true;
    }

    function setSkipOutroValue(value, save = true) {
        const v = getVideo();
        const duration = getSkipMediaState(v).duration;
        let n = parseTimeInput(value);
        if (n == null) return false;
        n = Math.max(0, n);
        if (duration) n = Math.min(n, duration);
        state.skipOutroSec = Math.round(n);
        if (save) saveSkipMemory(v, null, state.skipOutroSec);
        const r = document.getElementById('vfa-outro-range');
        const i = document.getElementById('vfa-outro-input');
        const o = document.getElementById('vfa-outro-out');
        if (r) r.value = state.skipOutroSec;
        if (i) i.value = formatSkipTime(state.skipOutroSec, duration);
        if (o) o.textContent = formatSkipTime(state.skipOutroSec, duration);
        store.set('skipOutroSec', state.skipOutroSec);
        store.set('skipOutroDefined', state.skipOutroSec);
        state.skipOutroTriggered = false;
        if (VFA_IS_TOP) vfaBroadcastToFrames('skip-settings', { skipIntro: state.skipIntro, skipOutro: state.skipOutro, skipIntroSec: state.skipIntroSec, skipOutroSec: state.skipOutroSec });
        return true;
    }

    function findNextEpisodeControl() {
        const candidates = [...document.querySelectorAll('a,button,[role="button"],[data-action],[class*="next"],[id*="next"]')];
        const words = /(下一集|下一话|下一期|下一篇|next\s*(episode|ep|video|part)?|next)/i;
        const bad = /(上一|prev|previous|评论|评论区|recommend|推荐|advert|广告|download|下载)/i;
        const scored = [];
        for (const el of candidates) {
            if (el.closest('#vfa-root')) continue;
            const text = `${el.innerText || ''} ${el.getAttribute('aria-label') || ''} ${el.getAttribute('title') || ''} ${el.id || ''} ${el.className || ''}`;
            const disabled = el.disabled || el.getAttribute('aria-disabled') === 'true' || el.classList.contains('disabled');
            if (disabled || !words.test(text) || bad.test(text)) continue;
            const r = el.getBoundingClientRect();
            let score = 0;
            if (/(下一集|下一话|下一期)/i.test(text)) score += 100;
            if (/next/i.test(text)) score += 70;
            if (/(episode|ep|video|part)/i.test(text)) score += 25;
            if (r.width > 0 && r.height > 0) score += 20;
            if (el.tagName === 'A' && el.href) score += 10;
            scored.push({ el, score });
        }
        scored.sort((a, b) => b.score - a.score);
        return scored[0]?.el || null;
    }

    function goNextEpisodeOrPause(v) {
        if (!v || state.skipOutroTriggered) return;
        state.skipOutroTriggered = true;
        const next = findNextEpisodeControl();
        if (!next) {
            try { v.pause(); } catch { }
            toast('⏸ 已到片尾，未找到下一集，视频已暂停');
            return;
        }
        toast('⏭ 片尾到达，正在播放下一集');
        try {
            next.click();
        } catch {
            try { v.pause(); } catch { }
        }
    }

    // 当前媒体的识别信息。4KVM 自动下一集有时不会替换 <video> 元素，
    // 而只是给同一个 video 换 src / MediaSource，因此不能只比较 video 对象。
    let lastSkipSignature = '';

    function getSkipSignature(v) {
        if (!v) return '';
        let src = '';
        try { src = String(v.currentSrc || v.src || ''); } catch { }
        const duration = getSkipDuration(v);
        return `${src}|${duration > 0 ? Math.round(duration) : 0}`;
    }

    function reloadSkipDefinition(v, force = false) {
        if (!v) return;
        const sig = getSkipSignature(v);
        if (!force && sig && sig === lastSkipSignature) return;
        if (sig) lastSkipSignature = sig;

        // 每一集都重新读取同一个长期定义。
        const mem = getSkipGlobalMemory();
        if (mem.intro != null) state.skipIntroSec = mem.intro;
        if (mem.outro != null) state.skipOutroSec = mem.outro;
        state.skipIntroApplied = false;
        state.skipOutroTriggered = false;
        syncSkipControls(v, false);
    }

    function handleSkipPlayback(v) {
        if (!v) return;
        reloadSkipDefinition(v);
        const duration = getSkipDuration(v);

        // 不要求 video 已经处于 playing 状态。
        // 自动下一集切换时，loadedmetadata/timeupdate 的先后顺序在不同播放器上可能不同，
        // 只要当前时间仍接近 0，就立即把播放位置送到定义好的片头结束点。
        if (state.skipIntro && !state.skipIntroApplied && v.currentTime < 2.5 && state.skipIntroSec > 0) {
            const target = duration ? Math.min(state.skipIntroSec, Math.max(0, duration - 0.5)) : state.skipIntroSec;
            if (target > 0 && target > v.currentTime + 0.25) {
                try {
                    v.currentTime = target;
                    // 某些 MediaSource 播放器第一次赋值时仍在加载，下一次循环会再次确认。
                    if (Math.abs(v.currentTime - target) < 1.5 || v.readyState >= 1) {
                        state.skipIntroApplied = true;
                    }
                } catch { }
                if (state.skipIntroApplied) toast(`⏭ 跳过片头 ${formatTime(target)}`);
            }
        }

        if (state.skipOutro && state.skipOutroSec > 0 && duration > 0 &&
            v.currentTime >= state.skipOutroSec && v.currentTime < duration + 1) {
            goNextEpisodeOrPause(v);
        }

        // 视频重新从头开始时允许再次执行片头跳过；换集后也会自动重置。
        if (v.currentTime < 0.5) state.skipIntroApplied = false;
    }

    let lastSkipVideo = null;
    setInterval(() => {
        const v = getVideo();
        if (!v) {
            if (VFA_IS_TOP) {
                if (state.open) syncSkipControls(null);
                else updateSkipCurrentMarkers(null);
            }
            return;
        }
        if (v !== lastSkipVideo) {
            lastSkipVideo = v;
            lastSkipSignature = '';
            reloadSkipDefinition(v, true);
        }
        handleSkipPlayback(v);
        if (state.open) syncSkipControls(v);
        else updateSkipCurrentMarkers(v);
    }, 120);

    document.addEventListener('timeupdate', e => {
        if (e.target?.tagName === 'VIDEO') {
            handleSkipPlayback(e.target);
            updateSkipCurrentMarkers(e.target);
        }
    }, true);

    document.addEventListener('loadedmetadata', e => {
        if (e.target?.tagName === 'VIDEO') {
            lastSkipSignature = '';
            reloadSkipDefinition(e.target, true);
            handleSkipPlayback(e.target);
            updateSkipCurrentMarkers(e.target);
        }
    }, true);

    document.addEventListener('durationchange', e => {
        if (e.target?.tagName === 'VIDEO') {
            // duration 变化常常就是新一集开始的信号。
            reloadSkipDefinition(e.target, true);
            handleSkipPlayback(e.target);
        }
    }, true);

    document.addEventListener('ended', e => {
        if (e.target?.tagName === 'VIDEO' && state.skipOutro && !state.skipOutroTriggered) {
            goNextEpisodeOrPause(e.target);
        }
    }, true);


    /* ---------------- 视频时间线 / 上一集 / 播放 / 下一集 ---------------- */
    let vfaTimelineVideo = null;
    let vfaTimelineDragging = false;

    function formatVideoControlTime(sec) {
        sec = Number(sec);
        if (!Number.isFinite(sec) || sec < 0) sec = 0;
        sec = Math.floor(sec);
        const h = Math.floor(sec / 3600);
        const m = Math.floor((sec % 3600) / 60);
        const s = sec % 60;
        if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
        return `${m}:${String(s).padStart(2, '0')}`;
    }

    function getUsableEpisodeElement(el) {
        if (!el || el.closest('#vfa-root')) return false;
        if (el.disabled || el.getAttribute('aria-disabled') === 'true') return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
    }

    function findEpisodeControl(direction) {
        const next = direction > 0;
        const selectors = next
            ? '[data-action*="next" i],[data-testid*="next" i],[aria-label*="下一集" i],[title*="下一集" i],[class*="next" i],[id*="next" i]'
            : '[data-action*="prev" i],[data-action*="previous" i],[data-testid*="prev" i],[data-testid*="previous" i],[aria-label*="上一集" i],[title*="上一集" i],[class*="prev" i],[class*="previous" i],[id*="prev" i],[id*="previous" i]';
        const candidates = [...document.querySelectorAll(`button,a,[role="button"],${selectors}`)];
        const words = next
            ? /(下一集|下一话|下一期|下一篇|next\s*(episode|ep|video|part)?)/i
            : /(上一集|上一话|上一期|上一篇|prev(ious)?\s*(episode|ep|video|part)?)/i;
        const bad = next
            ? /(上一集|上一话|上一期|上一篇|prev(ious)?|评论|recommend|推荐|advert|广告|download|下载)/i
            : /(下一集|下一话|下一期|下一篇|next|评论|recommend|推荐|advert|广告|download|下载)/i;
        const scored = [];

        for (const el of candidates) {
            if (!getUsableEpisodeElement(el)) continue;
            const text = `${el.innerText || ''} ${el.getAttribute('aria-label') || ''} ${el.getAttribute('title') || ''} ${el.id || ''} ${String(el.className || '')}`;
            if (!words.test(text) || bad.test(text)) continue;
            let score = 0;
            if (next && /(下一集|下一话|下一期|下一篇)/i.test(text)) score += 120;
            if (!next && /(上一集|上一话|上一期|上一篇)/i.test(text)) score += 120;
            if (next && /next/i.test(text)) score += 80;
            if (!next && /prev(ious)?/i.test(text)) score += 80;
            if (/(episode|ep|video|part|集|话)/i.test(text)) score += 25;
            if (el.tagName === 'A' && el.href) score += 10;
            scored.push({ el, score });
        }
        scored.sort((a, b) => b.score - a.score);
        return scored[0]?.el || null;
    }

    function navigateEpisode(direction) {
        const control = findEpisodeControl(direction);
        if (!control) {
            toast(direction > 0 ? '⚠️ 未找到下一集按钮' : '⚠️ 未找到上一集按钮');
            return;
        }
        try {
            control.click();
        } catch (err) {
            console.warn('[VFA] episode navigation error:', err);
            toast('⚠️ 集数切换失败');
        }
    }

    function updatePlayPauseUI(v = getVideo()) {
        const btn = document.querySelector('#vfa-panel [data-a="playPause"]');
        if (!btn) return;
        if (!v) {
            btn.textContent = '▶';
            return;
        }
        btn.textContent = v.paused ? '▶' : '⏸';
        btn.title = v.paused ? '播放' : '暂停';
        btn.setAttribute('aria-label', v.paused ? '播放' : '暂停');
    }

    function updateVideoTimeline(v = getVideo()) {
        const range = document.getElementById('vfa-video-progress');
        const current = document.getElementById('vfa-current-time');
        const duration = document.getElementById('vfa-duration');
        if (!range || !current || !duration) return;

        if (!v && VFA_IS_TOP && vfaRemoteVideoState) {
            const d = Number(vfaRemoteVideoState.duration);
            const t = Number(vfaRemoteVideoState.currentTime);
            const validDuration = Number.isFinite(d) && d > 0;
            const safeTime = Number.isFinite(t) && t >= 0 ? t : 0;
            const ratio = validDuration ? Math.min(1, Math.max(0, safeTime / d)) : 0;
            if (!vfaTimelineDragging) range.value = String(ratio * 1000);
            current.textContent = formatVideoControlTime(safeTime);
            duration.textContent = validDuration ? formatVideoControlTime(d) : '0:00';
            const pct = ratio * 100;
            range.style.background = `linear-gradient(to right,rgba(96,165,250,.95) 0%,rgba(96,165,250,.95) ${pct}%,rgba(255,255,255,.22) ${pct}%,rgba(255,255,255,.22) 100%)`;
            return;
        }

        if (!v) {
            range.value = 0;
            current.textContent = '0:00';
            duration.textContent = '0:00';
            range.style.background = 'rgba(255,255,255,.22)';
            return;
        }

        const d = Number(v.duration);
        const t = Number(v.currentTime);
        const validDuration = Number.isFinite(d) && d > 0;
        const safeTime = Number.isFinite(t) && t >= 0 ? t : 0;
        const ratio = validDuration ? Math.min(1, Math.max(0, safeTime / d)) : 0;

        if (!vfaTimelineDragging) range.value = String(ratio * 1000);
        current.textContent = formatVideoControlTime(safeTime);
        duration.textContent = validDuration ? formatVideoControlTime(d) : '0:00';
        const pct = ratio * 100;
        range.style.background = `linear-gradient(to right,rgba(96,165,250,.95) 0%,rgba(96,165,250,.95) ${pct}%,rgba(255,255,255,.22) ${pct}%,rgba(255,255,255,.22) 100%)`;
    }

    function seekFromTimeline() {
        const range = document.getElementById('vfa-video-progress');
        const v = getVideo();
        if (!range) return;
        if (!v && VFA_IS_TOP && vfaRemoteVideoState) {
            const d = Number(vfaRemoteVideoState.duration);
            if (!Number.isFinite(d) || d <= 0) return;
            const ratio = Math.min(1, Math.max(0, Number(range.value) / 1000));
            const target = ratio * d;
            try { vfaBroadcastToFrames('seek', { time: target }); } catch { }
            const current = document.getElementById('vfa-current-time');
            if (current) current.textContent = formatVideoControlTime(target);
            return;
        }
        if (!v) return;
        const d = Number(v.duration);
        if (!Number.isFinite(d) || d <= 0) return;
        const ratio = Math.min(1, Math.max(0, Number(range.value) / 1000));
        const target = ratio * d;
        try {
            v.currentTime = target;
        } catch (err) {
            console.warn('[VFA] timeline seek error:', err);
        }
        const current = document.getElementById('vfa-current-time');
        if (current) current.textContent = formatVideoControlTime(target);
        const pct = ratio * 100;
        range.style.background = `linear-gradient(to right,rgba(96,165,250,.95) 0%,rgba(96,165,250,.95) ${pct}%,rgba(255,255,255,.22) ${pct}%,rgba(255,255,255,.22) 100%)`;
    }

    function initVideoTimeline() {
        const range = document.getElementById('vfa-video-progress');
        if (!range || range.dataset.vfaBound) return;
        range.dataset.vfaBound = '1';

        range.addEventListener('pointerdown', () => {
            vfaTimelineDragging = true;
        });
        range.addEventListener('input', seekFromTimeline);
        range.addEventListener('change', () => {
            seekFromTimeline();
            vfaTimelineDragging = false;
            updateVideoTimeline();
        });
        range.addEventListener('pointerup', () => {
            seekFromTimeline();
            vfaTimelineDragging = false;
            updateVideoTimeline();
        });
        range.addEventListener('pointercancel', () => {
            vfaTimelineDragging = false;
            updateVideoTimeline();
        });
    }

    function bindVideoControlEvents(v) {
        if (!v || v.dataset.vfaControlBound) return;
        v.dataset.vfaControlBound = '1';
        const sync = () => {
            if (getVideo() === v || vfaTimelineVideo === v) updateVideoTimeline(v);
            if (getVideo() === v) updatePlayPauseUI(v);
        };
        ['timeupdate', 'loadedmetadata', 'durationchange', 'progress', 'seeking', 'seeked', 'play', 'pause', 'ended'].forEach(type => {
            v.addEventListener(type, sync, true);
        });
    }

    document.addEventListener('timeupdate', e => {
        if (e.target?.tagName === 'VIDEO') updateVideoTimeline(e.target);
    }, true);
    document.addEventListener('loadedmetadata', e => {
        if (e.target?.tagName === 'VIDEO') {
            bindVideoControlEvents(e.target);
            if (getVideo() === e.target) updateVideoTimeline(e.target);
            if (getVideo() === e.target) updatePlayPauseUI(e.target);
        }
    }, true);
    document.addEventListener('durationchange', e => {
        if (e.target?.tagName === 'VIDEO' && getVideo() === e.target) updateVideoTimeline(e.target);
    }, true);
    document.addEventListener('play', e => {
        if (e.target?.tagName === 'VIDEO' && getVideo() === e.target) updatePlayPauseUI(e.target);
    }, true);
    document.addEventListener('pause', e => {
        if (e.target?.tagName === 'VIDEO' && getVideo() === e.target) updatePlayPauseUI(e.target);
    }, true);

    setInterval(() => {
        const v = getVideo();
        if (!v) {
            vfaTimelineVideo = null;
            updateVideoTimeline(null);
            updatePlayPauseUI(null);
            return;
        }
        if (v !== vfaTimelineVideo) vfaTimelineVideo = v;
        bindVideoControlEvents(v);
        updateVideoTimeline(v);
        updatePlayPauseUI(v);
    }, 200);

    // 跨域 iframe 视频状态桥。LIBVIO 的 /play/ 页面可能把真正 video 放在 iframe 内，
    // 顶层页面无法直接读取跨域 video 的 duration/currentTime，只能通过 postMessage 同步。
    if (!VFA_IS_TOP) {
        let lastFrameSignature = '';
        const reportFrameVideo = () => {
            const v = getVideo();
            if (!v) {
                if (lastFrameSignature) {
                    lastFrameSignature = '';
                    vfaSendToParent('video-cleared');
                }
                return;
            }
            try {
                const d = Number(v.duration);
                const t = Number(v.currentTime);
                const src = v.currentSrc || v.src || '';
                const signature = `${src}|${Number.isFinite(d) ? d : 0}`;
                lastFrameSignature = signature;
                vfaSendToParent('video-state', {
                    currentTime: Number.isFinite(t) ? t : 0,
                    duration: Number.isFinite(d) && d > 0 ? d : 0,
                    paused: !!v.paused,
                    ended: !!v.ended,
                    readyState: Number(v.readyState) || 0,
                    signature
                });
            } catch { }
        };
        reportFrameVideo();
        setInterval(reportFrameVideo, 200);
        try {
            const mo = new MutationObserver(() => reportFrameVideo());
            mo.observe(document.documentElement || document, { childList: true, subtree: true });
        } catch { }
        ['timeupdate', 'loadedmetadata', 'durationchange', 'progress', 'seeking', 'seeked', 'play', 'pause', 'ended'].forEach(type => {
            document.addEventListener(type, e => {
                if (e.target?.tagName === 'VIDEO') reportFrameVideo();
            }, true);
        });
    }

    /* ---------------- 位置 & 弹出方向 ---------------- */
    const GAP = 12;
    function fabSize() { return state.wrap ? state.wrap.offsetWidth : 52; }

    function applyPos() {
        if (!state.wrap) return;
        const w = state.wrap.offsetWidth || 52, h = state.wrap.offsetHeight || 52;
        let x = state.posX == null ? innerWidth - w - 18 : state.posX;
        let y = state.posY == null ? 64 : state.posY;
        x = Math.min(Math.max(0, x), innerWidth - w);
        y = Math.min(Math.max(0, y), innerHeight - h);
        state.wrap.style.left = x + 'px';
        state.wrap.style.top = y + 'px';
        state.wrap.style.right = 'auto';
        state.posX = x; state.posY = y;
    }

    // 面板出现在图标旁（缓存尺寸，不在拖拽帧内做布局读取）
    const dims = { pw: 236, ph: 400 };

    /* 手机端按屏幕实际宽高计算缩放比例，保证整个弹窗一次完整显示。 */
    function fitPanelToViewport() {
        if (!state.panel) return;

        const panel = state.panel;
        if (!window.matchMedia('(max-width:600px)').matches) {
            panel.style.transform = '';
            panel.style.transformOrigin = '';
            panel.style.maxHeight = '';
            panel.style.overflow = '';
            return;
        }

        // 先彻底解除上一次缩放和动画，读取真正的内容尺寸。
        panel.style.animation = 'none';
        panel.style.transform = 'none';
        panel.style.transformOrigin = 'top left';
        panel.style.maxHeight = 'calc(100vh - 16px)';
        panel.style.overflowY = 'auto';
        panel.style.overflowX = 'hidden';
        panel.style.touchAction = 'pan-y';

        const naturalRect = panel.getBoundingClientRect();
        const naturalWidth = Math.max(1, naturalRect.width);
        const naturalHeight = Math.max(1, naturalRect.height);

        const viewport = window.visualViewport;
        const viewportWidth = Math.max(1, viewport ? viewport.width : innerWidth);
        const viewportHeight = Math.max(1, viewport ? viewport.height : innerHeight);
        const availableWidth = Math.max(1, viewportWidth - 16);
        const availableHeight = Math.max(1, viewportHeight - 16);

        // 宽高同时参与计算，取较小值，确保任何一边都不会被裁掉。
        const scale = Math.min(1, availableWidth / naturalWidth, availableHeight / naturalHeight);
        const safeScale = Math.max(0.2, scale);

        panel.style.transform = `scale(${safeScale})`;
        panel.style.transformOrigin = 'top left';
    }

    function placePanel() {
        if (!state.panel || !state.wrap) return;

        const fab = fabSize();

        // 使用视觉尺寸，兼容手机端整体缩放。
        const rect = state.panel.getBoundingClientRect();
        const pw = rect.width || state.panel.offsetWidth || dims.pw;
        const ph = rect.height || state.panel.offsetHeight || dims.ph;

        dims.pw = pw;
        dims.ph = ph;

        /*
         * 优先显示在悬浮球右侧
         * 如果右侧空间不足，则放到左侧
         */
        let left;

        if (state.posX + fab + GAP + pw <= innerWidth - 8) {
            left = fab + GAP;
        } else {
            left = -pw - GAP;
        }

        /*
         * 垂直方向：
         * 尽量和悬浮球顶部对齐；
         * 如果底部超出屏幕，就向上移动；
         * 如果顶部也超出，则贴近顶部。
         */
        let top = 0;

        const absoluteTop = state.posY + top;

        if (absoluteTop + ph > innerHeight - 8) {
            top = innerHeight - 8 - ph - state.posY;
        }

        if (state.posY + top < 8) {
            top = 8 - state.posY;
        }

        state.panel.style.left = `${left}px`;
        state.panel.style.top = `${top}px`;
    }



    /* ---------------- 打开 / 收回 ---------------- */
    function openPanel() {
        if (!state.panel || state.open) return;

        state.open = true;

        const panel = state.panel;

        /*
         * 先准备好面板的最终玻璃状态，
         * 避免 display:none -> block 时出现白色闪帧。
         */
        panel.style.display = 'block';

        /*
         * 强制保持玻璃背景，
         * 防止第一次合成时出现白底。
         */
        panel.style.backgroundColor = 'rgba(18, 24, 38, 0.78)';
        panel.style.backdropFilter = 'blur(18px)';
        panel.style.webkitBackdropFilter = 'blur(18px)';

        /*
         * 先布局，不立即播放动画。
         */
        panel.classList.remove('hide');

        panel.style.visibility = 'hidden';
        panel.style.opacity = '0';

        requestAnimationFrame(() => {

            if (!state.panel || !state.open) return;

            panel.style.height = 'auto';

            fitPanelToViewport();

            const firstRect = panel.getBoundingClientRect();
            dims.pw = firstRect.width || panel.offsetWidth || dims.pw;
            dims.ph = firstRect.height || panel.offsetHeight || dims.ph;

            placePanel();

            /*
             * 再等一帧，让浏览器完成 backdrop-filter
             * 和背景合成。
             */
            requestAnimationFrame(() => {

                if (!state.panel || !state.open) return;

                fitPanelToViewport();

                const secondRect = panel.getBoundingClientRect();
                dims.pw = secondRect.width || panel.offsetWidth || dims.pw;
                dims.ph = secondRect.height || panel.offsetHeight || dims.ph;

                placePanel();

                /*
                 * 最后才显示面板。
                 *
                 * 这样用户不会看到“白色初始化帧”。
                 */
                panel.style.visibility = 'visible';
                panel.style.opacity = '';

                panel.classList.add('show');
            });
        });
    }


    function closePanel() {
        if (!state.panel || !state.open) return;
        state.open = false;
        state.panel.classList.remove('show');
        state.panel.classList.add('hide');
        setTimeout(() => { if (!state.open) state.panel.style.display = ''; }, 220);
    }

    /* ---------------- 拖拽（GPU 渲染） ---------------- */
    function initDrag(fab) {
        let sx, sy, ox, oy, moved, raf = null, cx = 0, cy = 0;
        const flush = () => {
            raf = null;
            state.wrap.style.transform = `translate3d(${cx}px,${cy}px,0)`;
        };
        fab.addEventListener('pointerdown', e => {
            if (e.button !== 0) return;
            fab.setPointerCapture(e.pointerId);
            sx = e.clientX; sy = e.clientY;
            ox = state.posX; oy = state.posY;
            cx = cy = 0; moved = false;
            e.preventDefault();
        });
        fab.addEventListener('pointermove', e => {
            if (sx == null) return;
            const dx = e.clientX - sx, dy = e.clientY - sy;
            if (!moved && Math.hypot(dx, dy) < 6) return;
            if (!moved) {
                moved = true;
                state.dragging = true;
                fab.classList.add('dragging');
                if (state.panel) { state.panel.classList.add('dragging'); state.panel.style.opacity = '.55'; }
            }
            const w = fab.offsetWidth, h = fab.offsetHeight;
            cx = Math.min(Math.max(-ox, dx), innerWidth - w - ox);
            cy = Math.min(Math.max(-oy, dy), innerHeight - h - oy);
            if (!raf) raf = requestAnimationFrame(flush);
        });
        const up = () => {
            if (sx == null) return;
            if (raf) { cancelAnimationFrame(raf); raf = null; }
            sx = sy = null;
            if (moved) {
                state.posX += cx; state.posY += cy;
                state.wrap.style.left = state.posX + 'px';
                state.wrap.style.top = state.posY + 'px';
                store.set('posX', state.posX);
                store.set('posY', state.posY);
                state.dragging = false;
                placePanel();
            }
            state.wrap.style.transform = '';
            fab.classList.remove('dragging');
            if (state.panel) { state.panel.classList.remove('dragging'); state.panel.style.opacity = ''; }
            if (!moved) state.open ? closePanel() : openPanel();
        };
        fab.addEventListener('pointerup', up);
        fab.addEventListener('pointercancel', up);
    }

    /* ---------------- 面板 UI ---------------- */
    function buildUI() {
        if (document.getElementById('vfa-root')) return;
        const root = document.createElement('div');
        root.id = 'vfa-root';
        root.innerHTML = `
<div id="vfa-wrap">
  <div id="vfa-fab">🎬</div>
  <div id="vfa-panel">
    <div class="vfa-row vfa-panel-head">
      <span class="vfa-title">
    <img
        src="https://img.001315.xyz/file/tg/1789381092104.webp"
        class="vfa-logo"
        alt=""
    >
    <span>视频小助手 Pro</span>
</span>

      <span id="vfa-update-badge" role="button" tabindex="0" title="检查更新">↑ 有新版本</span>
      <span class="vfa-chip vfa-fps" id="vfa-fps">-- FPS</span>
    </div>
    <div class="vfa-label">⚡ 倍速播放</div>
    <div class="vfa-row">
      <button class="vfa-ico" data-a="slower">−</button>
      <span id="vfa-speed">1x</span>
      <button class="vfa-ico" data-a="faster">＋</button>
    </div>
    <div class="vfa-row">
      <button class="vfa-btn" data-a="set" data-v="0.5">0.5x</button>
      <button class="vfa-btn" data-a="set" data-v="1">1x</button>
      <button class="vfa-btn" data-a="set" data-v="1.5">1.5x</button>
      <button class="vfa-btn" data-a="set" data-v="2">2x</button>
      <button class="vfa-btn" data-a="set" data-v="3">3x</button>
    </div>

    <div class="vfa-label">🔁 A-B 循环</div>
    <div class="vfa-row" style="margin-bottom:8px">
      <button class="vfa-btn vfa-ab-btn" data-a="abA">设 A</button>
      <button class="vfa-btn vfa-ab-btn" data-a="abB">设 B</button>
      <button class="vfa-btn vfa-ab-btn" data-a="abLoop">循环</button>
      <button class="vfa-btn" data-a="abReset">清除</button>
    </div>
    <div id="vfa-ab-status" class="vfa-ab-status">A -- · B --</div>

    <div class="vfa-label">🔊 播放控制</div>
    <div class="vfa-video-control" id="vfa-video-control">
      <div class="vfa-time-row">
        <span class="vfa-time-label" id="vfa-current-time">0:00</span>
        <input id="vfa-video-progress" type="range" min="0" max="1000" step="0.1" value="0" aria-label="视频进度">
        <span class="vfa-time-label" id="vfa-duration">0:00</span>
      </div>
      <div class="vfa-episode-controls">
        <button class="vfa-episode-btn" data-a="prevEpisode" type="button" title="上一集">⏮ 上一集</button>
        <button class="vfa-episode-btn play" data-a="playPause" type="button" title="播放 / 暂停" aria-label="播放 / 暂停">▶</button>
        <button class="vfa-episode-btn" data-a="nextEpisode" type="button" title="下一集">下一集 ⏭</button>
      </div>
    </div>
    <div class="vfa-volume-row">
      <span class="vfa-volume-icon" id="vfa-volume-icon" role="button" tabindex="0" title="点击静音 / 解除静音" aria-label="静音 / 解除静音">🔊</span>
      <input id="vfa-volume-range" class="vfa-volume-range" type="range" min="0" max="100" step="1" value="100" aria-label="音量">
      <span id="vfa-volume-value" class="vfa-volume-value">100%</span>
    </div>
    <div class="vfa-swrow" data-t="rememberVolume">记忆音量 <span class="vfa-switch" data-t="rememberVolume"><i></i></span></div>
    <div class="vfa-row" style="margin-bottom:8px">
      <button class="vfa-btn" data-a="fullscreen">⛶ 全屏</button>
      <button class="vfa-btn" data-a="webFullscreen">🖥️ 网页全屏</button>
      <button class="vfa-btn" data-a="mute">🔇 静音</button>
    </div>
    <div class="vfa-feature-note">A-B 循环默认关闭，音量记忆默认关闭，不会改变现有播放行为。</div>

    <div class="vfa-label vfa-section-smooth">🚀 流畅优化</div>
    <div class="vfa-swrow" data-t="smooth">一键流畅模式<span class="vfa-switch" data-t="smooth"><i></i></span></div>
    <div class="vfa-swrow" data-t="freezeDecor">冻结装饰动画<span class="vfa-switch" data-t="freezeDecor"><i></i></span></div>
    <div class="vfa-swrow" data-t="danmaku">屏蔽弹幕 <span class="vfa-switch" data-t="danmaku"><i></i></span></div>
<div class="vfa-label">💬 弹幕关键词过滤</div>

<div class="vfa-dm-section">

    <div class="vfa-dm-inputrow">
        <input id="vfa-dm-input" placeholder="输入不想看的弹幕关键词..." maxlength="30">
        <button id="vfa-dm-add">＋</button>
    </div>

    <div id="vfa-dm-chips"></div>

</div>

<div class="vfa-lower-section">

    <div class="vfa-swrow vfa-pause-start" data-t="pauseOffscreen">
        暂停离屏视频
        <span class="vfa-switch" data-t="pauseOffscreen"><i></i></span>
    </div>

    <div class="vfa-swrow" data-t="idlePause">
        无人观看自动暂停
        <span class="vfa-switch" data-t="idlePause"><i></i></span>
    </div>

    <div class="vfa-slider-row" id="vfa-idle-row">
        <span>⏱ 无操作时长</span>
        <input type="range" id="vfa-idle-range" min="1" max="30" step="1">
        <output id="vfa-idle-out">1分钟</output>
    </div>

    <div class="vfa-swrow" data-t="skipIntro" style="margin-bottom:8px">
        跳过片头
        <span class="vfa-switch" data-t="skipIntro"><i></i></span>
    </div>

    <div class="vfa-skip-box">
        <div class="vfa-skip-head">
            <span>片头位置</span><output id="vfa-intro-out">0:00</output>
        </div>
        <div class="vfa-skip-track" data-skip-track="intro">
            <input id="vfa-intro-range" class="vfa-skip-range" type="range" min="0" max="60" step="1" value="10">
            <span id="vfa-intro-current" class="vfa-skip-current" aria-hidden="true"></span>
        </div>
        <div class="vfa-skip-inputrow">
            <span>跳过到</span>
            <input id="vfa-intro-input" class="vfa-skip-input" type="text" inputmode="text" autocomplete="off" spellcheck="false" placeholder="0:00" value="0:10">
            <span id="vfa-intro-format">（分:秒）</span>
        </div>
        <div class="vfa-skip-set-row">
            <button id="vfa-intro-set" class="vfa-skip-set-btn" type="button">一键定位当前时间</button><button id="vfa-intro-reset" class="vfa-skip-reset-btn" type="button">重置</button>
        </div>
    </div>

    <div class="vfa-swrow" data-t="skipOutro" style="margin:10px 0 8px">
        跳过片尾 / 自动下一集
        <span class="vfa-switch" data-t="skipOutro"><i></i></span>
    </div>

    <div class="vfa-skip-box">
        <div class="vfa-skip-head">
            <span>片尾开始位置</span><output id="vfa-outro-out">0:00</output>
        </div>
        <div class="vfa-skip-track" data-skip-track="outro">
            <input id="vfa-outro-range" class="vfa-skip-range" type="range" min="0" max="60" step="1" value="0">
            <span id="vfa-outro-current" class="vfa-skip-current" aria-hidden="true"></span>
        </div>
        <div class="vfa-skip-inputrow">
            <span>从第</span>
            <input id="vfa-outro-input" class="vfa-skip-input" type="text" inputmode="text" autocomplete="off" spellcheck="false" placeholder="0:00" value="0:00">
            <span id="vfa-outro-format">（分:秒）开始</span>
        </div>
        <div class="vfa-skip-set-row">
            <button id="vfa-outro-set" class="vfa-skip-set-btn" type="button">一键定位当前时间</button><button id="vfa-outro-reset" class="vfa-skip-reset-btn" type="button">重置</button>
        </div>
        <div id="vfa-skip-duration" class="vfa-skip-duration">等待视频时长…</div>
    </div>

    <div class="vfa-label">🖼 画面与窗口</div>

    <div class="vfa-row" style="margin-bottom:2px">
        <button class="vfa-btn" data-a="mirror">🪞 镜像</button>
        <button class="vfa-btn" data-a="rotate">🔄 旋转</button>
        <button class="vfa-btn" data-a="pip">📺 画中画</button>
    </div>

</div>


</div>`;
        const style = document.createElement('style');
        style.textContent = GLASS_CSS;
        document.head.appendChild(style);
        document.body.appendChild(root);

        state.wrap = root.querySelector('#vfa-wrap');
        state.panel = root.querySelector('#vfa-panel');
        const updateBadge = root.querySelector('#vfa-update-badge');
        if (updateBadge) {
            updateBadge.addEventListener('click', vfaStartUpdate);
            updateBadge.addEventListener('keydown', e => {
                if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); vfaStartUpdate(); }
            });
        }
        applyPos();
        initDrag(root.querySelector('#vfa-fab'));
        // 打开面板时同步一次开关状态，防止 SPA 页面刷新后面板与实际状态不一致
        const syncOnOpen = () => {
            refreshSwitches();
            state.panel.querySelector('#vfa-speed').textContent = (+state.speed.toFixed(2)) + 'x';
        };
        state.wrap.addEventListener('mouseenter', syncOnOpen);

        // 鼠标离开悬浮球+面板区域 → 延迟收回（输入框聚焦时不收回）
        const hoverZone = () => { clearTimeout(state.closeTimer); };
        state.wrap.addEventListener('mouseenter', hoverZone);
        state.wrap.addEventListener('mouseleave', () => {
            clearTimeout(state.closeTimer);
            state.closeTimer = setTimeout(() => {
                // 正在输入弹幕关键词时不自动收回
                if (document.activeElement === document.getElementById('vfa-dm-input')) return;
                closePanel();
            }, 350);
        });

        // 面板内 pointerdown 冒泡阶段拦截（不在捕获阶段拦，否则自己收不到事件）
        state.panel.addEventListener('pointerdown', e => e.stopPropagation());

        root.addEventListener('click', e => {
            const btn = e.target.closest('.vfa-btn,.vfa-ico,.vfa-episode-btn');
            if (btn) {
                const a = btn.dataset.a;
                if (a === 'faster') setSpeed((getVideo()?.playbackRate || 1) + 0.25);
                else if (a === 'slower') setSpeed((getVideo()?.playbackRate || 1) - 0.25);
                else if (a === 'set') setSpeed(parseFloat(btn.dataset.v));
                else if (a === 'mirror') toggleMirror();
                else if (a === 'rotate') rotate();
                else if (a === 'pip') togglePip();
                else if (a === 'abA') setAbPoint('A');
                else if (a === 'abB') setAbPoint('B');
                else if (a === 'abLoop') toggleAbLoop();
                else if (a === 'abReset') resetAbLoop();
                else if (a === 'fullscreen') toggleFullscreen();
                else if (a === 'webFullscreen') toggleWebFullscreen();
                else if (a === 'mute') toggleMute();
                else if (a === 'playPause') togglePlay();
                else if (a === 'prevEpisode') navigateEpisode(-1);
                else if (a === 'nextEpisode') navigateEpisode(1);
                e.stopPropagation();   // 阻止站点响应
                return;
            }
            const sw = e.target.closest('.vfa-swrow');
            if (sw) {
                const t = sw.dataset.t;
                const on = !state[t];
                state[t] = on;
                store.set(t, on);
                sw.querySelector('.vfa-switch').classList.toggle('on', on);
                if (t === 'smooth') { setSmooth(on); toast(on ? '🚀 流畅模式已开启' : '🚀 流畅模式已关闭'); }
                if (t === 'freezeDecor') { setFreeze(on); toast(on ? '🧊 装饰动画已冻结' : '🧊 装饰动画已恢复'); }
                if (t === 'danmaku') { setDanmaku(on); toast(on ? '🚫 弹幕已屏蔽' : '💬 弹幕已恢复'); }
                if (t === 'skipIntro') { syncSkipControls(getVideo(), true); if (VFA_IS_TOP) vfaBroadcastToFrames('skip-settings', { skipIntro: on, skipOutro: state.skipOutro, skipIntroSec: state.skipIntroSec, skipOutroSec: state.skipOutroSec }); toast(on ? `⏭ 跳过片头 ${formatTime(state.skipIntroSec)}` : '⏭ 跳过片头已关'); }
                if (t === 'skipOutro') { syncSkipControls(getVideo(), true); if (VFA_IS_TOP) vfaBroadcastToFrames('skip-settings', { skipIntro: state.skipIntro, skipOutro: on, skipIntroSec: state.skipIntroSec, skipOutroSec: state.skipOutroSec }); toast(on ? `⏭ 片尾从 ${formatTime(state.skipOutroSec)} 自动下一集` : '⏭ 跳过片尾已关'); }
                if (t === 'idlePause') {
                    toast(on ? '😴 无人观看自动暂停已开启' : '😴 无人观看自动暂停已关闭');
                    document.getElementById('vfa-idle-row')?.classList.toggle('show', on);
                }
                if (t === 'rememberVolume') {
                    if (on) {
                        const v = getVideo();
                        if (v) { state.volume = Math.min(1, Math.max(0, Number(v.volume))); state.muted = !!v.muted; store.set('volume', state.volume); store.set('muted', state.muted); }
                        toast('🔊 音量记忆已开启');
                    } else toast('🔊 音量记忆已关闭');
                }
                e.stopPropagation();   // 处理完毕，阻止站点响应
            }
        });

        refreshSwitches();
        syncIdleSlider();
        initSkipControls();
        syncSkipControls(getVideo(), true);
        initVideoTimeline();
        bindVideoControlEvents(getVideo());
        updateVideoTimeline(getVideo());
        updatePlayPauseUI(getVideo());
        syncVolumeSlider();
        function syncVolumeSlider() {
            const range = document.getElementById('vfa-volume-range');
            const out = document.getElementById('vfa-volume-value');
            const icon = document.getElementById('vfa-volume-icon');
            if (!range || !out) return;

            const v = getVideo();
            const volume = v ? Math.round(Math.min(1, Math.max(0, Number(v.volume))) * 100) : Math.round(Math.min(1, Math.max(0, Number(state.volume))) * 100);
            range.value = volume;

            const render = value => {
                value = Math.min(100, Math.max(0, Number(value) || 0));
                range.value = value;
                range.style.setProperty('--vfa-volume', value + '%');
                out.textContent = value + '%';
                if (icon) icon.textContent = (v?.muted || value === 0) ? '🔇' : value < 50 ? '🔉' : '🔊';
            };

            render(volume);
            if (icon) {
                const toggleIconMute = () => {
                    const video = getVideo();
                    if (!video) { toast('⚠️ 当前没有可用的视频'); return; }
                    video.muted = !video.muted;
                    state.volume = Math.min(1, Math.max(0, Number(video.volume)));
                    state.muted = !!video.muted;
                    if (state.rememberVolume) {
                        store.set('volume', state.volume);
                        store.set('muted', state.muted);
                    }
                    syncRememberVolumeUI(video);
                };
                icon.onclick = e => {
                    e.preventDefault();
                    e.stopPropagation();
                    toggleIconMute();
                };
                icon.onkeydown = e => {
                    if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        e.stopPropagation();
                        toggleIconMute();
                    }
                };
            }

            range.oninput = () => {
                const value = Number(range.value);
                const video = getVideo();
                if (video) {
                    video.volume = value / 100;
                    if (value > 0 && video.muted) video.muted = false;
                    state.muted = !!video.muted;
                } else {
                    state.muted = value === 0;
                }
                state.volume = value / 100;
                if (state.rememberVolume) { store.set('volume', state.volume); store.set('muted', state.muted); }
                render(value);
            };
        }

        function setSkipIntroToCurrentTime() {
            const v = getVideo();
            const media = getSkipMediaState(v);
            if (!v && !(VFA_IS_TOP && vfaRemoteVideoState)) { toast('⚠️ 当前没有可用视频'); return; }
            const t = media.currentTime;
            setSkipIntroValue(t);
            toast(`⏭ 片头已定位到 ${formatSkipTime(t, media.duration)}`);
        }

        function setSkipOutroToCurrentTime() {
            const v = getVideo();
            const media = getSkipMediaState(v);
            if (!v && !(VFA_IS_TOP && vfaRemoteVideoState)) { toast('⚠️ 当前没有可用视频'); return; }
            const t = media.currentTime;
            setSkipOutroValue(t);
            toast(`⏭ 片尾已定位到 ${formatSkipTime(t, media.duration)}`);
        }

        function resetSkipIntroValue() {
            state.skipIntroSec = 0;
            saveSkipMemory(getVideo(), 0, null);
            state.skipIntroApplied = false;
            syncSkipControls(getVideo(), false);
            toast('⏭ 片头时间已重置');
        }

        function resetSkipOutroValue() {
            state.skipOutroSec = 0;
            saveSkipMemory(getVideo(), null, 0);
            state.skipOutroTriggered = false;
            syncSkipControls(getVideo(), false);
            toast('⏭ 片尾时间已重置');
        }

        function initSkipControls() {
        const introRange = document.getElementById('vfa-intro-range');
        const introInput = document.getElementById('vfa-intro-input');
        const outroRange = document.getElementById('vfa-outro-range');
        const outroInput = document.getElementById('vfa-outro-input');
        if (!introRange || !outroRange || introRange.dataset.vfaReady === '1') return;
        introRange.dataset.vfaReady = '1';
        outroRange.dataset.vfaReady = '1';

        introRange.addEventListener('input', e => {
            e.stopPropagation();
            setSkipIntroValue(e.target.value);
        });
        outroRange.addEventListener('input', e => {
            e.stopPropagation();
            setSkipOutroValue(e.target.value);
        });

        document.getElementById('vfa-intro-set')?.addEventListener('click', e => {
            e.preventDefault();
            e.stopPropagation();
            setSkipIntroToCurrentTime();
        });
        document.getElementById('vfa-outro-set')?.addEventListener('click', e => {
            e.preventDefault();
            e.stopPropagation();
            setSkipOutroToCurrentTime();
        });
        document.getElementById('vfa-intro-reset')?.addEventListener('click', e => {
            e.preventDefault();
            e.stopPropagation();
            resetSkipIntroValue();
        });
        document.getElementById('vfa-outro-reset')?.addEventListener('click', e => {
            e.preventDefault();
            e.stopPropagation();
            resetSkipOutroValue();
        });

        const bindTimeInput = (input, setter) => {
            if (!input) return;
            input.addEventListener('input', e => e.stopPropagation());
            input.addEventListener('change', e => {
                e.stopPropagation();
                const raw = e.target.value.trim();
                if (!raw) return;
                if (!setter(raw)) syncSkipControls(getVideo(), false);
            });
            input.addEventListener('blur', e => {
                const raw = e.target.value.trim();
                if (!raw) {
                    syncSkipControls(getVideo(), false);
                    return;
                }
                if (!setter(raw)) syncSkipControls(getVideo(), false);
            });
            input.addEventListener('keydown', e => {
                e.stopPropagation();
                if (e.key === 'Enter') {
                    e.preventDefault();
                    e.target.blur();
                }
            });
        };

        bindTimeInput(introInput, setSkipIntroValue);
        bindTimeInput(outroInput, setSkipOutroValue);
    }

    function syncWatermarkSlider() {
            const range = document.getElementById('vfa-wm-range');
            const out = document.getElementById('vfa-wm-out');

            if (!range || !out) return;

            // 从 state 当前记忆值恢复
            const percent = Math.round(
                (state.watermarkOpacity ?? 0.05) * 100
            );

            range.value = percent;
            out.textContent = percent + '%';

            range.oninput = () => {
                const value = Number(range.value);

                state.watermarkOpacity = value / 100;

                // ★ 立即保存
                store.set(
                    'watermarkOpacity',
                    state.watermarkOpacity
                );

                out.textContent = value + '%';

                // ★ 立即更新已有水印
                updateWatermarkOpacity();
            };
        }

        renderDmChips();
        updateAbUI();
        state.panel.querySelector('#vfa-speed').textContent = (+state.speed.toFixed(2)) + 'x';
        startFps();
        window.addEventListener('resize', () => { applyPos(); if (state.open) { fitPanelToViewport(); placePanel(); } });
    }
    /* =========================================================
       开发者模式
       ---------------------------------------------------------
       默认隐藏
       连续点击标题 7 次 → 密码验证
       第一次使用 → 设置自己的密码
       ========================================================= */

    function initDeveloperMode() {

        const panel =
            document.getElementById('vfa-panel');

        const title =
            panel?.querySelector('.vfa-title');

        if (!panel || !title) {
            console.warn('[VFA] 找不到开发者模式入口');
            return;
        }

        /* 防止重复初始化 */
        if (title.dataset.vfaDevReady === '1') {
            return;
        }

        title.dataset.vfaDevReady = '1';

        let clickCount = 0;
        let clickTimer = null;

        /*
         * 标题连续点击 7 次
         */
        title.addEventListener('click', async e => {

            e.preventDefault();
            e.stopPropagation();

            clickCount++;

            clearTimeout(clickTimer);

            clickTimer = setTimeout(() => {
                clickCount = 0;
            }, 1500);

            /*
             * 第 7 次
             */
            if (clickCount < 7) {
                return;
            }

            clickCount = 0;

            await enterDeveloperMode();
        });


        /*
         * 开发者区域
         *
         * 默认 display:none
         */
        const section =
            document.createElement('div');

        section.id = 'vfa-dev-entry';

        section.style.display = 'none';

        section.innerHTML = `
        <div class="vfa-label">
            🛠 开发者模式
        </div>

        <div class="vfa-swrow">

            <span>
                开发者设置
            </span>

            <button
                id="vfa-dev-lock"
                class="vfa-btn"
                type="button"
                style="
                    flex:none;
                    width:92px;
                    padding:7px 0;
                "
            >
                🔒 锁定
            </button>

        </div>

        <div id="vfa-dev-settings">

            <div class="vfa-slider-row show">

                <span>
                    Rain 透明度
                </span>

                <input
                    id="vfa-wm-range"
                    type="range"
                    min="1"
                    max="20"
                    step="1"
                >

                <output id="vfa-wm-out">
                    1%
                </output>

            </div>

            <div
                class="vfa-swrow"
                style="margin-top:10px;"
            >

                <span>
                    修改开发者密码
                </span>

                <button
                    id="vfa-dev-change"
                    class="vfa-btn"
                    type="button"
                    style="
                        flex:none;
                        width:92px;
                        padding:7px 0;
                    "
                >
                    🔑 修改
                </button>

            </div>

        </div>
    `;

        panel.appendChild(section);


        /*
         * 透明度控件
         */
        const range =
            section.querySelector('#vfa-wm-range');

        const output =
            section.querySelector('#vfa-wm-out');


        range.value =
            Math.round(
                (state.watermarkOpacity || 0.01) * 100
            );

        output.textContent =
            range.value + '%';


        range.addEventListener('input', e => {

            e.stopPropagation();

            if (!state.developerUnlocked) {
                return;
            }

            const percent =
                Number(range.value);

            output.textContent =
                percent + '%';

            setWatermarkOpacity(
                percent / 100
            );
        });


        /*
         * 锁定开发者模式
         */
        section
            .querySelector('#vfa-dev-lock')
            .addEventListener('click', e => {

                e.preventDefault();
                e.stopPropagation();

                lockDeveloperMode();
            });


        /*
         * 修改密码
         */
        section
            .querySelector('#vfa-dev-change')
            .addEventListener('click', async e => {

                e.preventDefault();
                e.stopPropagation();

                await changeDeveloperPassword();
            });


        console.log(
            '[VFA] 开发者模式入口已隐藏'
        );
    }




    function refreshSwitches() {
        state.panel.querySelectorAll('.vfa-swrow').forEach(sw => {
            sw.querySelector('.vfa-switch').classList.toggle('on', !!state[sw.dataset.t]);
        });
    }

    // 无操作时长滑条：跟随开关显示/隐藏，带记忆
    function syncIdleSlider() {
        const row = document.getElementById('vfa-idle-row');
        const range = document.getElementById('vfa-idle-range');
        const out = document.getElementById('vfa-idle-out');
        if (!row || !range) return;
        range.value = state.idleMin;
        out.textContent = state.idleMin + '分钟';
        row.classList.toggle('show', !!state.idlePause);
        range.oninput = () => {
            state.idleMin = +range.value;
            store.set('idleMin', state.idleMin);
            out.textContent = state.idleMin + '分钟';
        };
    }
    function syncWatermarkSlider() {
        const range = document.getElementById('vfa-wm-range');
        const out = document.getElementById('vfa-wm-out');

        if (!range || !out) return;

        const percent = Math.round(state.watermarkOpacity * 100);

        range.value = percent;
        out.textContent = percent + '%';

        range.oninput = () => {
            const value = Number(range.value);

            state.watermarkOpacity = value / 100;

            store.set(
                'watermarkOpacity',
                state.watermarkOpacity
            );

            out.textContent = value + '%';

            updateWatermarkOpacity();
        };
    }

    function updateWatermarkOpacity() {
        document
            .querySelectorAll('.vfa-watermark-item')
            .forEach(item => {
                item.style.opacity =
                    state.watermarkOpacity;
            });
    }


    /* ---------------- 弹幕关键词过滤 ---------------- */
    function renderDmChips() {
        const box = document.getElementById('vfa-dm-chips');
        if (!box) return;

        box.innerHTML = state.dmKeywords.map(k => {
            const safe = k.replace(/[<>&"]/g, '');

            return `
            <span class="vfa-dm-chip">
                <span class="vfa-dm-text">${safe}</span>
                <i>✕</i>
            </span>
        `;
        }).join('');

        box.querySelectorAll('.vfa-dm-chip').forEach(chip => {
            chip.onclick = () => {
                const k = chip.querySelector('.vfa-dm-text')?.textContent.trim() || '';

                state.dmKeywords = state.dmKeywords.filter(x => x !== k);
                store.set('dmKeywords', state.dmKeywords);

                renderDmChips();
                clearDmHides();

                toast('🗑 已删除关键词：' + k);
            };
        });

        // ⭐ 关键：关键词增删后重新计算弹窗布局
        requestAnimationFrame(() => {
            if (state.panel && state.open) {
                state.panel.style.height = 'auto';
                placePanel();
            }
        });
    }


    /* ---------------- 弹幕关键词过滤 Pro ---------------- */

    function hitKeyword(text) {
        const t = String(text || '')
            .trim()
            .toLowerCase();

        if (!t || t.length > 100) return false;

        return state.dmKeywords.some(k => {
            const keyword = String(k || '')
                .trim()
                .toLowerCase();

            return keyword && t.includes(keyword);
        });
    }


    function clearDmHides() {
        document.querySelectorAll('.vfa-dm-hide').forEach(el => {
            el.classList.remove('vfa-dm-hide');
            el.removeAttribute('data-vfa-dm');
        });
    }

    /*
     * 判断一个元素是否像“弹幕条目”
     *
     * 抖音网页版的弹幕 DOM 可能没有固定 class，
     * 所以不能只靠 [class*=danmaku]。
     */
    function isLikelyDanmaku(el) {
        if (!(el instanceof HTMLElement)) return false;

        const r = el.getBoundingClientRect();

        // 不在页面可见区域附近
        if (
            r.width < 10 ||
            r.height < 8 ||
            r.width > innerWidth * 0.95 ||
            r.height > 150
        ) {
            return false;
        }

        // 弹幕通常是横向短条
        if (r.width < r.height * 1.2) return false;

        const style = getComputedStyle(el);

        // 弹幕一般是浮在视频区域上方
        if (style.position !== 'fixed' &&
            style.position !== 'absolute') {
            return false;
        }

        return true;
    }

    /*
     * 从命中的文字节点向上寻找真正应该隐藏的弹幕容器
     */
    function findDmContainer(el) {
        let cur = el;

        for (let i = 0; i < 8 && cur && cur !== document.body; i++) {

            if (!(cur instanceof HTMLElement)) {
                cur = cur.parentElement;
                continue;
            }

            const text = (cur.innerText || cur.textContent || '').trim();

            if (!text || text.length > 120) {
                cur = cur.parentElement;
                continue;
            }

            const r = cur.getBoundingClientRect();

            /*
             * 弹幕条目通常：
             * - 有一定宽度
             * - 高度较小
             * - 位于视频/窗口上方
             */
            if (
                r.width >= 20 &&
                r.height >= 10 &&
                r.height <= 120 &&
                r.width <= innerWidth * 0.95
            ) {
                const cls = String(cur.className || '').toLowerCase();

                // 有明显弹幕特征，直接使用
                if (
                    /danmaku|bullet|barrage|comment|chat|dm-|dm_|弹幕/.test(cls)
                ) {
                    return cur;
                }

                /*
                 * 没有 class 特征时，如果元素是 absolute/fixed，
                 * 并且文字较短，也认为可能是弹幕容器。
                 */
                const pos = getComputedStyle(cur).position;

                if (
                    (pos === 'absolute' || pos === 'fixed') &&
                    text.length <= 80
                ) {
                    return cur;
                }
            }

            cur = cur.parentElement;
        }

        return el instanceof HTMLElement ? el : null;
    }

    /*
     * 获取可能的弹幕文字节点
     *
     * 不再依赖固定 class。
     */
    function getPossibleDmNodes() {

        const result = [];

        /*
         * 先处理传统弹幕 class
         */
        const known = document.querySelectorAll(`
        [class*="danmaku"],
        [class*="Danmaku"],
        [class*="barrage"],
        [class*="Barrage"],
        [class*="bullet-screen"],
        [class*="comment"],
        [class*="Comment"],
        [class*="chat"]
    `);

        known.forEach(el => {
            if (!(el instanceof HTMLElement)) return;

            const text = (el.innerText || el.textContent || '').trim();

            if (
                text &&
                text.length <= 100 &&
                !el.children.length
            ) {
                result.push(el);
            }
        });

        /*
         * 再扫描 fixed / absolute 的短文本节点。
         *
         * 这是针对抖音动态弹幕的关键。
         */
        const all = document.querySelectorAll('body *');

        for (const el of all) {

            if (!(el instanceof HTMLElement)) continue;

            if (el.children.length > 0) continue;

            if (el.dataset.vfaDmChecked === '1') continue;

            const text = (el.textContent || '').trim();

            if (!text || text.length > 80) continue;

            /*
             * 避免扫描大量普通页面文字
             */
            const style = getComputedStyle(el);

            if (
                style.position !== 'fixed' &&
                style.position !== 'absolute'
            ) {
                continue;
            }

            const r = el.getBoundingClientRect();

            if (
                r.width < 10 ||
                r.height < 8 ||
                r.width > innerWidth * 0.95 ||
                r.height > 120
            ) {
                continue;
            }

            result.push(el);
        }

        return result;
    }

    function dmScan() {
        if (!state.dmKeywords.length) {
            clearDmHides();
            return;
        }

        /*
         * 抖音网页版：
         *
         * <div class="SF8xNeY5 danMuText">
         *     <span>弹幕内容</span>
         * </div>
         *
         * 直接锁定 .danMuText，避免扫描整个页面。
         */
        const nodes = document.querySelectorAll(
            '.danMuText, [class*="danMuText"]'
        );

        for (const el of nodes) {
            if (!(el instanceof HTMLElement)) continue;

            const text = (el.textContent || '').trim();

            if (!text) continue;

            if (hitKeyword(text)) {
                el.classList.add('vfa-dm-hide');
            } else {
                el.classList.remove('vfa-dm-hide');
            }
        }

        /*
         * 同时兼容 B站 / 其它播放器的旧规则
         */
        const otherNodes = document.querySelectorAll(
            '[class*="danmaku"] *, ' +
            '[class*="bullet-screen"] *, ' +
            '.xg-danmaku *'
        );

        for (const el of otherNodes) {
            if (!(el instanceof HTMLElement)) continue;
            if (el.children.length) continue;

            const text = (el.textContent || '').trim();

            if (!text) continue;

            if (hitKeyword(text)) {
                let target = el;

                /*
                 * 向上找弹幕条目
                 */
                for (let i = 0; i < 5 && target.parentElement; i++) {
                    const p = target.parentElement;

                    if (
                        p.classList.contains('danmaku') ||
                        p.classList.contains('danMuText') ||
                        /danmaku|bullet-screen|xg-danmaku/i.test(
                            String(p.className || '')
                        )
                    ) {
                        target = p;
                        break;
                    }

                    target = p;
                }

                target.classList.add('vfa-dm-hide');
            }
        }
    }


    /*
     * 抖音弹幕会不断创建新 DOM，
     * MutationObserver 用来快速触发扫描。
     *
     * 注意必须 debounce，否则 MutationObserver 自己会造成卡顿。
     */
    let dmScanTimer = null;

    function scheduleDmScan() {

        if (!state.dmKeywords.length) return;

        if (dmScanTimer) return;

        dmScanTimer = setTimeout(() => {
            dmScanTimer = null;
            dmScan();
        }, 150);
    }

    function initDmFilter() {
        const input = document.getElementById('vfa-dm-input');
        const add = () => {
            const k = input.value.trim();

            if (!k) return;

            if (state.dmKeywords.includes(k)) {
                toast('⚠ 关键词已存在');
                input.value = '';
                return;
            }

            state.dmKeywords.push(k);
            store.set('dmKeywords', state.dmKeywords);

            input.value = '';

            renderDmChips();
            dmScan();

            toast('✅ 已添加过滤：' + k);
        };

        document.getElementById('vfa-dm-add').onclick = add;

        input.addEventListener('keydown', e => {
            if (e.key === 'Enter') {
                e.preventDefault();
                e.stopPropagation();
                add();
            }
        });

        /*
         * 抖音弹幕是不断创建/删除 DOM，
         * 所以监听 danMuText 的变化。
         */
        let scanTimer = null;

        const scheduleScan = () => {
            if (!state.dmKeywords.length) return;
            if (scanTimer) return;

            scanTimer = setTimeout(() => {
                scanTimer = null;
                dmScan();
            }, 80);
        };

        const observer = new MutationObserver(mutations => {
            for (const mutation of mutations) {
                if (
                    mutation.type === 'childList' ||
                    mutation.type === 'characterData'
                ) {
                    scheduleScan();
                    break;
                }
            }
        });

        observer.observe(document.body, {
            childList: true,
            subtree: true,
            characterData: true
        });

        /*
         * 定时兜底。
         */
        setInterval(() => {
            if (state.dmKeywords.length) {
                dmScan();
            }
        }, 500);

        /*
         * 初始化立即扫描一次。
         */
        setTimeout(dmScan, 300);
    }


    /* ---------------- 快捷键 ---------------- */
    document.addEventListener('keydown', e => {
        if (e.target.matches('input,textarea,[contenteditable="true"]')) return;
        if (e.altKey && e.key.toLowerCase() === 'v') { state.open ? closePanel() : openPanel(); return; }
        if (e.key === 'Escape' && state.open) { closePanel(); return; }
        const v = getVideo();
        if (!v) return;
        switch (e.key) {
            case 'z': setSpeed(v.playbackRate - 0.25); break;
            case 'x': setSpeed(1); break;
            case 'c': setSpeed(v.playbackRate + 0.25); break;
            case 'ArrowLeft': nudge(e.shiftKey ? -30 : -5); e.preventDefault(); break;
            case 'ArrowRight': nudge(e.shiftKey ? 30 : 5); e.preventDefault(); break;
            case ' ': togglePlay(); e.preventDefault(); e.stopImmediatePropagation(); break; // 阻止站点双重响应
            case 'm': v.muted = !v.muted; toast(v.muted ? '🔇 静音' : '🔊 有声'); break;
            case 'p': togglePip(); break;
        }
        if (/^[0-9]$/.test(e.key) && v.duration) {
            v.currentTime = v.duration * (+e.key / 10);
            toast(`⏱ ${+e.key * 10}%`);
        }
    }, true);

    /* 防残留保险：万一残留旧遮罩，自动清理 */
    setInterval(() => {
        const old = document.getElementById('vfa-shield');
        if (old && !state.dragging) old.remove();
    }, 2000);
    const init = () => {
        if (!VFA_IS_TOP) return;
        buildUI();

    setTimeout(vfaCheckForUpdate, 1200);
    setInterval(vfaCheckForUpdate, 10 * 60 * 1000);

        setSmooth(state.smoothMode);
        setDanmaku(state.hideDanmaku);

        if (state.freezeDecor) {
            setFreeze(true);
        }

        initDmFilter();
        // ★ 新增：开发者模式
        initDeveloperMode();

        // 创建 Rain 水印
        createWatermark();
    };
    setTimeout(() => {
        createWatermark();
    }, 1000);

    setTimeout(() => {
        createWatermark();
    }, 3000);

    /* =========================================================
       进入开发者模式
       ========================================================= */

    async function enterDeveloperMode() {

        /*
         * 第一次使用
         */
        if (!hasDeveloperPassword()) {

            const password =
                prompt(
                    '🛠 第一次使用开发者模式\n\n' +
                    '请设置你的开发者密码：'
                );

            if (password === null) {
                return;
            }

            if (password.length < 6) {

                toast(
                    '❌ 密码至少需要 6 位'
                );

                return;
            }


            const confirmPassword =
                prompt(
                    '请再次输入开发者密码：'
                );

            if (confirmPassword !== password) {

                toast(
                    '❌ 两次密码输入不一致'
                );

                return;
            }


            try {

                await setDeveloperPassword(
                    password
                );

                toast(
                    '🔐 开发者密码设置成功'
                );

            } catch (err) {

                console.error(
                    '[VFA] 设置开发者密码失败:',
                    err
                );

                toast(
                    '❌ 密码设置失败'
                );

                return;
            }
        }


        /*
         * 已经设置过密码
         */
        const password =
            prompt(
                '🛠 开发者模式\n\n' +
                '请输入开发者密码：'
            );

        if (password === null) {
            return;
        }


        const valid =
            await verifyDeveloperPassword(
                password
            );


        if (!valid) {

            toast(
                '❌ 开发者密码错误'
            );

            return;
        }


        /*
         * 解锁
         */
        state.developerUnlocked = true;

        const section =
            document.getElementById(
                'vfa-dev-entry'
            );

        if (section) {
            section.style.display = 'block';
        }


        toast(
            '🔓 开发者模式已解锁'
        );
    }

    /* =========================================================
       锁定开发者模式
       ========================================================= */

    function lockDeveloperMode() {

        state.developerUnlocked = false;

        const section =
            document.getElementById(
                'vfa-dev-entry'
            );

        if (section) {
            section.style.display = 'none';
        }

        toast(
            '🔒 开发者模式已锁定'
        );
    }


    /* ---------------- 无人观看自动暂停 ---------------- */
    const IDLE_COUNTDOWN = 30;   // 弹窗无响应倒计时(秒)
    ['mousemove', 'pointerdown', 'keydown', 'wheel', 'touchstart'].forEach(ev =>
        document.addEventListener(ev, () => { state.lastActive = Date.now(); }, { passive: true }));

    function showIdleDialog() {
        if (document.getElementById('vfa-idle-mask')) return;
        let left = IDLE_COUNTDOWN;
        const mask = document.createElement('div');
        mask.id = 'vfa-idle-mask';
        mask.innerHTML = `
<div id="vfa-idle-box">
  <div class="vfa-idle-ico">👀</div>
  <div class="vfa-idle-title">还有人正在观看吗？</div>
  <div class="vfa-idle-tip">已连续 <b>${state.idleMin} 分钟</b>无操作，<b><span id="vfa-idle-cd">${left}</span>s</b> 后将自动暂停</div>
  <div class="vfa-idle-btns">
    <button class="vfa-idle-btn warn" id="vfa-idle-no">我离开了</button>
    <button class="vfa-idle-btn primary" id="vfa-idle-yes">正在观看</button>
  </div>
</div>

`;
        document.body.appendChild(mask);
        requestAnimationFrame(() => mask.classList.add('show'));   // 显示弹窗(否则 display:none 隐形)
        const finish = (keep) => {
            clearInterval(timer);
            mask.remove();
            state.idleAsked = false;
            state.lastActive = Date.now();
            const v = getVideo();
            if (!v) return;
            if (keep) { v.play().catch(() => { }); toast('👀 已继续播放'); }
            else if (!v.paused) { v.pause(); toast('😴 已自动暂停'); }
        };
        mask.querySelector('#vfa-idle-yes').onclick = () => finish(true);
        mask.querySelector('#vfa-idle-no').onclick = () => finish(false);
        const timer = setInterval(() => {
            left--;
            const cd = document.getElementById('vfa-idle-cd');
            if (cd) cd.textContent = left;
            if (Date.now() - state.lastActive < 1200) { finish(true); return; }  // 弹窗期间有操作=在看
            if (left <= 0) finish(false);
        }, 1000);
    }

    setInterval(() => {
        if (!state.idlePause || state.idleAsked) return;
        const v = getVideo();
        if (!v || v.paused) return;
        if (Date.now() - state.lastActive >= state.idleMin * 60000) {
            state.idleAsked = true;
            showIdleDialog();
        }
    }, 1000);

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init, {
            once: true
        });
    } else {
        init();
    }

})();
