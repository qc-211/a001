/* ====================================================================
 *  image-zoom.js   原生图片预览组件:滚轮缩放 / 拖拽平移 / 双击切换
 *  --------------------------------------------------------------------
 *  用法(任意页面):
 *    1. <link rel="stylesheet" href="./css/image-zoom.css">
 *    2. <script src="./JS/image-zoom.js"></script>  (放 </body> 前)
 *    3. 给需要点击放大的元素加 class="zoomable"
 *       (也支持 .case-card / .portfolio-item / [data-zoom] 等常见类名)
 *    4. 手动调用: window.imageZoom.open('图片路径')
 *  --------------------------------------------------------------------
 *  行为:
 *    桌面:鼠标滚轮以光标为中心缩放;按住可拖动;双击切换缩放
 *    移动:双指捏合以两指中点为中心缩放;单指拖动;双击切换
 *    关闭:点 × / 点遮罩 / 按 Esc 键
 *  --------------------------------------------------------------------
 *  核心实现要点(详见各函数注释):
 *    - 缩放数学不依赖 transform-origin,直接基于 getBoundingClientRect
 *      测量图像当前视口位置,反推"使光标处像素保持不动"所需的 translate
 *    - 缩放范围 0.2x ~ 5x,边界限制:放大时贴边、缩小时强制居中
 *    - transform: translate(tx, ty) scale(s) 组合,绝不动 img 的 width/height
 * ==================================================================== */

(function () {
    'use strict';

    // 防止重复加载
    if (window.imageZoom) return;

    // ============== 默认配置(可被 window.ImageZoomConfig 覆盖) ==============
    const DEFAULT_CONFIG = {
        // 自动绑定的"点击放大"触发器选择器
        TRIGGER_SELECTOR: '.zoomable, .case-card, .portfolio-item, [data-zoom], [data-zoom-src]',
        // 模态框相关选择器(新旧类名都兼容)
        MODAL_SELECTOR:          '.zoom-modal, .modal',
        MODAL_CONTENT_SELECTOR: '.zoom-modal-content, .modal-content',
        MODAL_IMG_SELECTOR:      '.zoom-modal-img, .modal-img',
        MODAL_CLOSE_SELECTOR:    '.zoom-modal-close, .modal-close',
        // 缩放参数
        MIN_SCALE:        0.2,   // 用户要求:最小 0.2 倍
        MAX_SCALE:        5,     // 用户要求:最大 5 倍
        WHEEL_STEP:       0.18,  // 滚轮每档 18%
        DBLCLICK_SCALE:   2.5,   // 双击放大的目标倍率
        DRAG_SUPPRESS_MS: 400    // 拖动后这段时间吞掉 click / dblclick
    };
    const config = Object.assign({}, DEFAULT_CONFIG, window.ImageZoomConfig || {});

    // ============== 运行时状态 ==============
    let modal, modalContent, modalImg, closeBtn;
    let state;                     // { scale, translateX, translateY }
    let isDragging = false;
    let dragStartX = 0, dragStartY = 0;
    let lastPinchDist = 0;
    let lastInteractionWasDrag = false;
    let dragSuppressTimer = null;
    let initialized = false;

    // ============== 初始化 ==============
    function init() {
        if (initialized) return;
        initialized = true;

        modal = document.querySelector(config.MODAL_SELECTOR);

        // 页面没写 modal 标记时,自动注入一个
        if (!modal) {
            modal = document.createElement('div');
            modal.className = 'zoom-modal';
            modal.innerHTML =
                '<button class="zoom-modal-close" aria-label="关闭预览">×</button>' +
                '<div class="zoom-modal-content">' +
                    '<img class="zoom-modal-img" alt="预览图片">' +
                '</div>';
            document.body.appendChild(modal);
        }

        modalContent = modal.querySelector(config.MODAL_CONTENT_SELECTOR);
        modalImg     = modal.querySelector(config.MODAL_IMG_SELECTOR);
        closeBtn     = modal.querySelector(config.MODAL_CLOSE_SELECTOR);

        if (!modalImg) {
            console.warn('[image-zoom] 未找到 modal-img,跳过初始化');
            return;
        }

        // 把关闭按钮提升到 modal 直接子元素,固定到视口右上角
        // 这样图片缩放到多大都不会被遮住
        if (closeBtn && modalContent && closeBtn.parentElement === modalContent) {
            modal.appendChild(closeBtn);
        }

        state = { scale: 1, translateX: 0, translateY: 0 };

        bindTriggers();
        setupEventHandlers();

        // 监听 DOM 变化,自动给后插入的 .zoomable 元素绑定
        new MutationObserver(bindTriggers).observe(document.body, { childList: true, subtree: true });

        // 公共 API
        window.imageZoom = { open: openModal, close: closeModal, refresh: bindTriggers };
    }

    // ============== 触发器绑定 ==============
    function bindTriggers() {
        document.querySelectorAll(config.TRIGGER_SELECTOR).forEach(el => {
            if (el.__zoomBound) return;
            el.__zoomBound = true;
            el.addEventListener('click', onTriggerClick);
        });
    }

    function onTriggerClick(e) {
        // 拖动刚结束 → 吞掉 click(避免误触打开)
        if (lastInteractionWasDrag) {
            e.preventDefault();
            e.stopPropagation();
            return;
        }
        e.preventDefault();
        const src = this.dataset.zoomSrc
                  || (this.tagName === 'IMG' ? this.src : (this.querySelector('img') || {}).src);
        if (src) openModal(src);
    }

    // ============== 模态控制 ==============
    function openModal(src) {
        if (!modal || !modalImg) return;
        modalImg.src = src;
        resetTransform();
        modal.classList.add('active');
        document.body.style.overflow = 'hidden';
        // 图片加载完后,做一次"按当前真实尺寸居中"的 clamp
        modalImg.onload = () => { if (state.scale === 1) clampAndApply(); };
    }

    function closeModal() {
        if (!modal) return;
        modal.classList.remove('active');
        document.body.style.overflow = '';
        resetTransform();
    }

    // ============== 变换核心 ==============

    /**
     * 把 state 中的 translate/scale 应用到图像上
     * 不修改 img.width / img.height,只通过 CSS transform 合成
     *   transform: translate(tx, ty) scale(s)
     * transform-origin 保持 center center(由 image-zoom.css 设置)
     */
    function applyTransform() {
        modalImg.style.transform =
            `translate(${state.translateX}px, ${state.translateY}px) scale(${state.scale})`;
        modalImg.classList.toggle('zoomed', state.scale > 1);
    }

    /**
     * clampTranslate + applyTransform 的组合调用
     * 任何会改变 scale / translate 的操作后都要走一遍,
     * 保证图像不会"飘"出可视区域
     */
    function clampAndApply() {
        clampTranslate();
        applyTransform();
    }

    /**
     * 边界限制:把图像位置修正到合法范围
     * 规则(单一公式,所有 scale 通用):
     *   图像的 left ∈ [modal.left,  modal.right  - imgW]
     *   图像的 top  ∈ [modal.top,   modal.bottom - imgH]
     *
     *   - 图像 >= 容器:区间两端颠倒(只能贴一边),图像最多覆盖容器
     *   - 图像 <  容器:区间正向,图像只能在容器内部移动,不会跑出去
     *
     * 关键:这里不主动"居中",只"夹紧"。
     *   旧的 force-center 逻辑会在 scale<1 时写入一个 translate 偏移,
     *   缩回去后这个偏移会带着,造成"乱飘"。新版杜绝这种偏移。
     */
    function clampTranslate() {
        if (!modal || !modalImg) return;
        const imgRect   = modalImg.getBoundingClientRect();   // 当前实际占位
        const modalRect = modal.getBoundingClientRect();      // 可视容器

        // left / top 各自的合法区间(区间端点大小自动处理"图大"和"图小"两种情况)
        const minLeft = Math.min(modalRect.left, modalRect.right  - imgRect.width);
        const maxLeft = Math.max(modalRect.left, modalRect.right  - imgRect.width);
        const minTop  = Math.min(modalRect.top,  modalRect.bottom - imgRect.height);
        const maxTop  = Math.max(modalRect.top,  modalRect.bottom - imgRect.height);

        // 把当前 left/top 夹到合法区间
        const desiredLeft = Math.max(minLeft, Math.min(maxLeft, imgRect.left));
        const desiredTop  = Math.max(minTop,  Math.min(maxTop,  imgRect.top));

        // 累加差量(而不是直接赋值,因为这里用的是"实际位置",不是"translate 值")
        state.translateX += (desiredLeft - imgRect.left);
        state.translateY += (desiredTop  - imgRect.top);
    }

    function resetTransform() {
        state.scale = 1;
        state.translateX = 0;
        state.translateY = 0;
        isDragging = false;
        modalImg.classList.remove('zoomed', 'dragging');
        // 走一次 clamp:图像本身比容器小时,会被夹在视口内(由 flexbox 自然居中)
        applyTransform();
        requestAnimationFrame(clampAndApply);
    }

    // ============== 缩放核心:中心缩放(永不漂移) ==============

    /**
     * 以图像当前的几何中心为锚点缩放。
     *
     * 实现非常简单:
     *   只改 state.scale,完全不动 state.translateX/Y。
     *   因为 CSS 里 transform-origin: center center,
     *   缩放天然以图像局部中心为轴,
     *   viewport 上"图像的几何中心"自动保持不变(等于 translate + 局部中心)。
     *
     * 之后调用 clampAndApply():
     *   - 缩放后图像仍在视口内 → translate 不需要变,中心就是中心
     *   - 缩放后图像超出视口   → clamp 把多出来的边缘拉回到视口边界
     *
     * (Mx, My) 参数保留仅为兼容调用处,内部不使用。
     *   想要"光标点位锁定缩放"的话在滚轮回调里单独写一份即可。
     */
    function zoomAround(Mx, My, factor) {
        void Mx; void My;  // 故意忽略:中心缩放不依赖光标位置
        const oldScale = state.scale;
        const newScale = Math.max(config.MIN_SCALE,
                          Math.min(config.MAX_SCALE, oldScale * factor));
        if (newScale === oldScale) return;
        state.scale = newScale;
        clampAndApply();
    }

    // ============== 拖动 ==============

    /**
     * 把"刚发生了一次拖动"的事实记录下来,
     * 持续 DRAG_SUPPRESS_MS 毫秒,期间吞掉 click / dblclick,
     * 防止拖动释放瞬间被误判为"点背景关闭"或"双击重置"
     */
    function markDragInteraction() {
        lastInteractionWasDrag = true;
        clearTimeout(dragSuppressTimer);
        dragSuppressTimer = setTimeout(() => { lastInteractionWasDrag = false; }, config.DRAG_SUPPRESS_MS);
    }

    // ============== 事件绑定 ==============
    function setupEventHandlers() {

        // —— 关闭按钮 ——
        if (closeBtn) {
            closeBtn.addEventListener('click', (e) => {
                e.stopPropagation();   // 不冒泡到 modal 的"点遮罩关闭"
                closeModal();
            });
        }

        // —— 点 modal 背景关闭(拖动刚结束则忽略) ——
        modal.addEventListener('click', (e) => {
            if (e.target !== modal) return;
            if (lastInteractionWasDrag) return;
            closeModal();
        });

        // —— Esc 关闭 ——
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && modal.classList.contains('active')) closeModal();
        });

        // —— 滚轮缩放(桌面) ——
        modal.addEventListener('wheel', (e) => {
            if (!modal.classList.contains('active')) return;
            e.preventDefault();
            const factor = e.deltaY < 0 ? (1 + config.WHEEL_STEP) : (1 - config.WHEEL_STEP);
            zoomAround(e.clientX, e.clientY, factor);
        }, { passive: false });

        // —— 双击切换(桌面 + 移动;拖动后短时间内忽略) ——
        modal.addEventListener('dblclick', (e) => {
            if (!modal.classList.contains('active')) return;
            if (lastInteractionWasDrag) return;
            e.preventDefault();
            // 已经放大或被拖动过 → 还原;否则放大到 DBLCLICK_SCALE 倍
            const moved = state.translateX !== 0 || state.translateY !== 0;
            if (state.scale > 1 || moved) {
                resetTransform();
            } else {
                zoomAround(e.clientX, e.clientY, config.DBLCLICK_SCALE);
            }
        });

        // —— 鼠标拖动平移 ——
        // 注意:任何 scale 都允许拖动(包括 < 1 时),因为 clamp 会把图像拉回居中
        modalImg.addEventListener('mousedown', (e) => {
            e.preventDefault();
            isDragging = true;
            // 记录"鼠标视口坐标 - 当前 translate"作为后续计算锚点
            dragStartX = e.clientX - state.translateX;
            dragStartY = e.clientY - state.translateY;
            modalImg.classList.add('dragging');
        });

        document.addEventListener('mousemove', (e) => {
            if (!isDragging) return;
            markDragInteraction();
            state.translateX = e.clientX - dragStartX;
            state.translateY = e.clientY - dragStartY;
            // 拖动过程中实时 clamp,防止拖出边界
            clampAndApply();
        });

        document.addEventListener('mouseup', () => {
            if (!isDragging) return;
            isDragging = false;
            modalImg.classList.remove('dragging');
            markDragInteraction();   // 防止 click 立即触发"点遮罩关闭"
        });

        // —— 双指捏合 + 单指拖动(移动端) ——
        const pinchDist = (t1, t2) => Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);

        modal.addEventListener('touchstart', (e) => {
            if (e.touches.length === 2) {
                e.preventDefault();
                lastPinchDist = pinchDist(e.touches[0], e.touches[1]);
                modalImg.classList.add('dragging');
            } else if (e.touches.length === 1) {
                e.preventDefault();
                isDragging = true;
                dragStartX = e.touches[0].clientX - state.translateX;
                dragStartY = e.touches[0].clientY - state.translateY;
                modalImg.classList.add('dragging');
            }
        }, { passive: false });

        modal.addEventListener('touchmove', (e) => {
            if (e.touches.length === 2) {
                e.preventDefault();
                const dist = pinchDist(e.touches[0], e.touches[1]);
                if (lastPinchDist === 0) { lastPinchDist = dist; return; }
                // 双指中点作为缩放中心
                const Mx = (e.touches[0].clientX + e.touches[1].clientX) / 2;
                const My = (e.touches[0].clientY + e.touches[1].clientY) / 2;
                zoomAround(Mx, My, dist / lastPinchDist);
                lastPinchDist = dist;
            } else if (e.touches.length === 1 && isDragging) {
                e.preventDefault();
                state.translateX = e.touches[0].clientX - dragStartX;
                state.translateY = e.touches[0].clientY - dragStartY;
                clampAndApply();
            }
        }, { passive: false });

        const endTouch = (e) => {
            if (e.touches.length < 2) lastPinchDist = 0;
            if (e.touches.length === 0) {
                isDragging = false;
                modalImg.classList.remove('dragging');
            }
        };
        modal.addEventListener('touchend', endTouch);
        modal.addEventListener('touchcancel', endTouch);
    }

    // ============== 启动 ==============
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();