/* kakyo-web-ui-components · site.js（展示站专用）
   生成物，请勿手改。源码在 src/，重新生成：node scripts/bundle.mjs */

/* ==========================================================================
   展示站交互：主题切换 / 目录高亮 / 移动端抽屉
   无依赖，约 120 行。组件库本身不依赖这段脚本。
   ========================================================================== */

const root = document.documentElement;

const storage = {
  get(key, fallback) {
    try {
      return localStorage.getItem(key) ?? fallback;
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch {
      /* 隐私模式下忽略 */
    }
  },
};

/* --------------------------------------------------------------------------
   主题
   -------------------------------------------------------------------------- */
const THEMES = {
  claude: { mode: "dark" },
  forest: { mode: "light" },
  violet: { mode: "dark" },
  butterfly: { mode: "light" },
};

function applyTheme(theme, mode) {
  const preset = THEMES[theme] ?? THEMES.claude;
  const nextMode = mode ?? preset.mode;

  root.dataset.theme = theme in THEMES ? theme : "claude";
  root.dataset.mode = nextMode;
  root.style.colorScheme = nextMode;

  document.querySelectorAll("[data-set-theme]").forEach((el) => {
    el.setAttribute("aria-pressed", String(el.dataset.setTheme === root.dataset.theme));
  });

  document.querySelectorAll("[data-set-mode]").forEach((el) => {
    el.setAttribute("aria-pressed", String(el.dataset.setMode === nextMode));
  });

  storage.set("ui-theme", root.dataset.theme);
  storage.set("ui-mode", nextMode);
}

function initTheme() {
  const savedTheme = storage.get("ui-theme", "claude");
  const savedMode = storage.get("ui-mode", null);
  applyTheme(savedTheme, savedMode);

  document.addEventListener("click", (e) => {
    const themeBtn = e.target.closest("[data-set-theme]");
    if (themeBtn) {
      applyTheme(themeBtn.dataset.setTheme, null);
      return;
    }

    const modeBtn = e.target.closest("[data-set-mode]");
    if (modeBtn) {
      applyTheme(root.dataset.theme, modeBtn.dataset.setMode);
    }
  });
}

/* --------------------------------------------------------------------------
   目录高亮
   -------------------------------------------------------------------------- */
function initToc() {
  const links = [...document.querySelectorAll(".toc__link")];
  if (!links.length) return;

  const items = links
    .map((link) => {
      const id = link.getAttribute("href");
      const section = id ? document.querySelector(id) : null;
      return section ? { link, section } : null;
    })
    .filter(Boolean);

  let active = null;
  let lockUntil = 0;

  const setActive = (item) => {
    if (item === active) return;
    active?.link.classList.remove("is-active");
    item?.link.classList.add("is-active");
    active = item;
  };

  // 点目录时立即高亮并短暂锁住滚动计算。
  // 末尾几个区块会同时出现在视口里，只靠滚动位置无法区分用户想看哪个。
  items.forEach((item) => {
    item.link.addEventListener("click", () => {
      setActive(item);
      lockUntil = Date.now() + 700;
    });
  });

  let ticking = false;

  const measure = () => {
    ticking = false;
    if (Date.now() < lockUntil) return;

    const line = 140; // 视口顶部往下 140px 视为"当前"
    let current = items[0];

    for (const item of items) {
      if (item.section.getBoundingClientRect().top <= line) current = item;
    }

    // 页面末尾几个区块滚不到顶部，到底时改用「已进入视口上半部分」的最后一项，
    // 否则会一直卡在倒数第二项上。
    const atBottom = window.innerHeight + window.scrollY >= document.body.scrollHeight - 4;
    if (atBottom) {
      const half = window.innerHeight * 0.55;
      for (const item of items) {
        if (item.section.getBoundingClientRect().top < half) current = item;
      }
    }

    setActive(current);
  };

  const onScroll = () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(measure);
  };

  window.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("resize", onScroll, { passive: true });
  measure();
}

/* --------------------------------------------------------------------------
   移动端抽屉
   -------------------------------------------------------------------------- */
function initNav() {
  const shell = document.querySelector(".site-shell");
  const toggle = document.querySelector(".site-menu-btn");
  const scrim = document.querySelector(".site-scrim");
  if (!shell || !toggle) return;

  const setOpen = (open) => {
    shell.dataset.navOpen = String(open);
    toggle.setAttribute("aria-expanded", String(open));
  };

  toggle.addEventListener("click", () => {
    setOpen(shell.dataset.navOpen !== "true");
  });

  scrim?.addEventListener("click", () => setOpen(false));

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && shell.dataset.navOpen === "true") setOpen(false);
  });

  // 点击导航项后自动收起
  shell.querySelectorAll(".site-nav__item").forEach((item) => {
    item.addEventListener("click", () => setOpen(false));
  });
}

/* --------------------------------------------------------------------------
   图标网格
   -------------------------------------------------------------------------- */
const ICON_NAMES = [
  "sparkles", "wand-sparkles", "image", "images", "palette", "layers", "cpu", "database",
  "terminal", "braces", "git-branch", "rocket", "brain", "flask-conical", "bar-chart-3",
  "trending-up", "wallet", "coins", "key-round", "shield-check", "lock", "user-round",
  "users", "bell", "settings", "search", "calendar-days", "clock", "mail", "message-circle",
  "link", "download", "trash-2", "pencil", "plus", "check", "x", "chevron-right",
  "chevron-down", "loader", "sun", "moon", "menu", "alert-triangle", "info", "copy",
  "volume-2", "play",
];

function renderIcons() {
  const grid = document.getElementById("icon-grid");
  if (!grid) return;

  grid.innerHTML = ICON_NAMES.map(
    (name) => `<div class="icon-cell" title="${name}">
        <svg class="ui-icon ui-icon--20" aria-hidden="true"><use href="#i-${name}"></use></svg>
        <span>${name}</span>
      </div>`,
  ).join("");
}

/* --------------------------------------------------------------------------
   滑块数值回显
   -------------------------------------------------------------------------- */
function initRanges() {
  document.querySelectorAll('input[type="range"][data-output]').forEach((el) => {
    const out = document.getElementById(el.dataset.output);
    if (!out) return;
    const sync = () => {
      out.textContent = el.value;
    };
    el.addEventListener("input", sync);
    sync();
  });
}

/* --------------------------------------------------------------------------
   吐司与横幅演示
   -------------------------------------------------------------------------- */
const TOAST_PRESETS = {
  default: { title: "已复制到剪贴板" },
  success: { title: "保存成功", description: "新的参数已经生效。", variant: "success" },
  info: { title: "后台开始同步", description: "可以继续浏览其他页面。", variant: "info" },
  warning: { title: "额度快用完了", description: "剩余额度只够再生成两张。", variant: "warning" },
  danger: { title: "读取失败", description: "服务暂时没有响应，稍后重试。", variant: "danger", duration: 5000 },
  desc: { title: "已加入队列", description: "前面还有 3 个任务。", variant: "success" },
};

function initFeedback() {
  document.addEventListener("click", (e) => {
    const trigger = e.target.closest("[data-toast]");
    if (trigger && window.UI?.toast) {
      const key = trigger.dataset.toast;
      if (key === "stack") {
        ["success", "info", "warning"].forEach((v, i) => {
          setTimeout(() => window.UI.toast(TOAST_PRESETS[v]), i * 200);
        });
      } else {
        window.UI.toast(TOAST_PRESETS[key] || TOAST_PRESETS.default);
      }
      return;
    }

    const close = e.target.closest(".ui-alert__close");
    if (close) {
      const alert = close.closest(".ui-alert");
      if (alert) {
        alert.style.transition = "opacity .18s ease";
        alert.style.opacity = "0";
        setTimeout(() => alert.remove(), 190);
      }
    }
  });
}

/* --------------------------------------------------------------------------
   浮层演示：命令式对话框 / 菜单选中反馈
   -------------------------------------------------------------------------- */
function initOverlays() {
  document.addEventListener("click", async (e) => {
    const demo = e.target.closest("[data-demo]");
    if (!demo || !window.UI) return;

    if (demo.dataset.demo === "dialog-api") {
      const ok = await window.UI.dialog({
        title: "新建作品",
        description: "先起个名字，之后也能改。",
        body: `<div class="ui-field">
                 <label class="ui-field__label" for="api-name">名称</label>
                 <input class="ui-input" id="api-name" placeholder="未命名作品">
                 <p class="ui-field__hint">留空的话会用时间戳命名。</p>
               </div>`,
        confirmText: "创建",
        cancelText: "取消",
        autofocus: "#api-name",
      });
      if (ok) window.UI.toast({ title: "已创建", variant: "success" });
      return;
    }

    if (demo.dataset.demo === "confirm-api") {
      const ok = await window.UI.confirm({
        title: "清空历史记录？",
        description: "共 128 条，删除后无法恢复。",
        confirmText: "清空",
      });
      if (ok) {
        window.UI.toast({ title: "已清空", description: "128 条记录已删除。", variant: "success" });
      }
    }
  });

  document.addEventListener("menu:select", (e) => {
    const label = e.detail.item.textContent.trim().split("\n")[0];
    window.UI?.toast({ title: `已选择「${label}」` });
  });
}

initTheme();
initToc();
initNav();
renderIcons();
initRanges();
initFeedback();
initOverlays();
