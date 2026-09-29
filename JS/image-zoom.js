/* ====================================================================
 *  image-zoom.js   共享图片放大预览 + 滚轮/捏合缩放 + 拖动平移
 *  --------------------------------------------------------------------
 *  用法(任意页面):
 *    1. 引入 css/image-zoom.css
 *    2. 引入本文件 (建议放 body 末尾)
 *    3. 给需要点击放大的元素加 class="zoomable"
 *       (也支持 .case-card / .portfolio-item / [data-zoom] 等常见类名)
 *    4. 如果需要手动打开,调用 window.imageZoom.open('图片路径')
 *  --------------------------------------------------------------------
 *  行为:
 *    - 桌面端:鼠标滚轮缩放,已放大时可拖动,双击切换放大
 *    - 移动端:双指捏合缩放,已放大时可单指拖动,双击切换放大
 *    - 关闭:点击 × / 点击遮罩 / 按 Esc 键
 *  --------------------------------------------------------------------
 *  Bug 修复要点:
 *    - 引入 lastInteractionWasDrag 标记,拖动后短时间内吞掉 click/dblclick,
 *      防止连续拖动被误判为 dblclick 而重置缩放导致"卡住"
 *    - 关闭按钮用 position:fixed 独立于图片容器,放大后不会被图片盖住
 * ==================================================================== */

(function () {
    'use strict';

    // 防止重复加载
    if (window.imageZoom) return;

    // ============== 可被 window.ImageZoomConfig 覆盖的默认配置 ==============
    const DEFAULT_CONFIG = {
        // 自动绑定的"点击放大"触发器选择器(任一匹配即可)
        TRIGGER_SELECTOR: '.zoomable, .case-card, .portfolio-item, [data-zoom], [data-zoom-src]',
        // 模态框相关选择器(新旧类名都支持)
        MODAL_SELECTOR:       '.zoom-modal, .modal',
        MODAL_CONTENT_SELECTOR: '.zoom-modal-content, .modal-content',
        MODAL_IMG_SELECTOR:   '.zoom-modal-img, .modal-img',
        MODAL_CLOSE_SELECTOR: '.zoom-modal-close, .modal-close',
        // 缩放参数
        MIN_SCALE: 1,
        MAX_SCALE: 5,
        WHEEL_STEP: 0.18,          // 滚轮每档 18%
        DBLCLICK_SCALE: 2.5,       // 双击放大的目标倍率
        DRAG_SUPPRESS_MS: 400      // 拖动后这段时间内吞掉 click/dblclick
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

        // 如果页面没写 modal 标记,自动注入一个
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

        // 把 closeBtn 移出 modal-content(关键修复),固定到视口右上角
        // 这样无论图片缩放到多大,关闭按钮都不会被遮住
        if (closeBtn && modalContent && closeBtn.parentElement === modalContent) {
            modal.appendChild(closeBtn);  // 提升到 modal 直接子元素
        }

        // 初始化状态对象
        state = { scale: 1, translateX: 0, translateY: 0 };

        bindTriggers();
        setupEventHandlers();

        // 监听 DOM 变化,自动给后插入的 .zoomable 元素绑定
        const observer = new MutationObserver(bindTriggers);
        observer.observe(document.body, { childList: true, subtree: true });

        // 暴露公共 API
        window.imageZoom = {
            open:  openModal,
            close: closeModal,
            refresh: bindTriggers
        };
    }

    // ============== 触发器绑定 ==============
    function bindTriggers() {
        const triggers = document.querySelectorAll(config.TRIGGER_SELECTOR);
        triggers.forEach(el => {
            if (el.__zoomBound) return;
            el.__zoomBound = true;
            el.addEventListener('click', onTriggerClick);
        });
    }

    function onTriggerClick(e) {
        // 拖动刚结束 -> 吞掉这次 click(避免误触打开)
        if (lastInteractionWasDrag) {
            e.preventDefault();
            e.stopPropagation();
            return;
        }
        e.preventDefault();

        // 优先取 data-zoom-src,否则取元素本身/内部第一张 <img>
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
    }

    function closeModal() {
        if (!modal) return;
        modal.classList.remove('active');
        document.body.style.overflow = '';
        resetTransform();
    }

    // ============== 变换 ==============
    function applyTransform() {
        modalImg.style.transform =
            `translate(${state.translateX}px, ${state.translateY}px) scale(${state.scale})`;
        modalImg.classList.toggle('zoomed', state.scale > 1);
    }

    function resetTransform() {
        state.scale = 1;
        state.translateX = 0;
        state.translateY = 0;
        isDragging = false;
        modalImg.classList.remove('zoomed', 'dragging');
        applyTransform();
    }

    function pinchDistance(t1, t2) {
        return Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);
    }

    /**
     * 围绕视口内某点 (Mx, My) 进行缩放,
     * 保证该点"指着的内容"在缩放后仍位于同一像素位置
     * (数学推导: T' = M*(1-r) + T*r, 其中 r = newScale/oldScale)
     */
    function zoomAround(Mx, My, factor) {
        const newScale = Math.max(config.MIN_SCALE, Math.min(config.MAX_SCALE, state.scale * factor));
        if (newScale === state.scale) return;
        const r = newScale / state.scale;
        state.translateX = Mx * (1 - r) + state.translateX * r;
        state.translateY = My * (1 - r) + state.translateY * r;
        state.scale = newScale;
        applyTransform();
    }

    /**
     * 把"刚发生了一次拖动"的事实记录下来,
     * 持续 DRAG_SUPPRESS_MS 毫秒,期间吞掉 click/dblclick
     */
    function markDragInteraction() {
        lastInteractionWasDrag = true;
        clearTimeout(dragSuppressTimer);
        dragSuppressTimer = setTimeout(() => {
            lastInteractionWasDrag = false;
        }, config.DRAG_SUPPRESS_MS);
    }

    // ============== 事件绑定 ==============
    function setupEventHandlers() {

        // —— 关闭按钮 ——
        if (closeBtn) {
            closeBtn.addEventListener('click', (e) => {
                e.stopPropagation();   // 阻止冒泡到 modal 的"点遮罩关闭"
                closeModal();
            });
        }

        // —— 点 modal 背景关闭(拖动后短时内禁止,避免松手误关) ——
        modal.addEventListener('click', (e) => {
            if (e.target !== modal) return;
            if (lastInteractionWasDrag) return;
            closeModal();
        });

        // —— Esc 关闭 ——
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && modal.classList.contains('active')) closeModal();
        });

        // —— 滚轮缩放(桌面端) ——
        modal.addEventListener('wheel', (e) => {
            if (!modal.classList.contains('active')) return;
            e.preventDefault();
            const factor = e.deltaY < 0 ? (1 + config.WHEEL_STEP) : (1 - config.WHEEL_STEP);
            zoomAround(e.clientX, e.clientY, factor);
        }, { passive: false });

        // —— 双击切换(桌面 + 移动端;拖动后短时内禁用) ——
        modal.addEventListener('dblclick', (e) => {
            if (!modal.classList.contains('active')) return;
            if (lastInteractionWasDrag) return;
            e.preventDefault();
            if (state.scale > 1) {
                resetTransform();
            } else {
                zoomAround(e.clientX, e.clientY, config.DBLCLICK_SCALE);
            }
        });

        // —— 鼠标拖动平移(任何 scale 都允许,方便缩小后重新居中) ——
        //   之前用 state.scale <= 1 早退,导致用户滚轮缩回原图后无法拖动纠正偏移
        modalImg.addEventListener('mousedown', (e) => {
            e.preventDefault();
            isDragging = true;
            dragStartX = e.clientX - state.translateX;
            dragStartY = e.clientY - state.translateY;
            modalImg.classList.add('dragging');
        });

        document.addEventListener('mousemove', (e) => {
            if (!isDragging) return;
            markDragInteraction();
            state.translateX = e.clientX - dragStartX;
            state.translateY = e.clientY - dragStartY;
            applyTransform();
        });

        document.addEventListener('mouseup', () => {
            if (!isDragging) return;
            isDragging = false;
            modalImg.classList.remove('dragging');
            // mouseup 后也要标记一次,防止 click 立即触发"点遮罩关闭"
            markDragInteraction();
        });

        // —— 双指捏合 + 单指拖动(移动端) ——
        // 事件挂 modal 上,即使手指滑出图片也不断
        modal.addEventListener('touchstart', (e) => {
            if (e.touches.length === 2) {
                e.preventDefault();
                lastPinchDist = pinchDistance(e.touches[0], e.touches[1]);
                modalImg.classList.add('dragging');
            } else if (e.touches.length === 1) {
                // 单指:任何 scale 都允许拖动(与桌面端一致)
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
                const dist = pinchDistance(e.touches[0], e.touches[1]);
                if (lastPinchDist === 0) { lastPinchDist = dist; return; }
                const Mx = (e.touches[0].clientX + e.touches[1].clientX) / 2;
                const My = (e.touches[0].clientY + e.touches[1].clientY) / 2;
                zoomAround(Mx, My, dist / lastPinchDist);
                lastPinchDist = dist;
            } else if (e.touches.length === 1 && isDragging) {
                e.preventDefault();
                state.translateX = e.touches[0].clientX - dragStartX;
                state.translateY = e.touches[0].clientY - dragStartY;
                applyTransform();
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