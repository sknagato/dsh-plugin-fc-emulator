/**
 * dsh-plugin-fc-emulator — browser half (client.js)
 *
 * FC（红白机）游戏厅：右下角悬浮球 + 全屏 modal 游戏厅。
 * 模拟核心为自编译的 fceumm libretro 核心（wasm，经 /dsh-plugin-fc/core-fce
 * 懒加载，589 个 mapper 芯片，含 VRC4/CN 等国产芯片），
 * ROM 来自 /dsh-plugin-fc/roms（上传 + 服务器目录双通道），
 * 整局快照（savestates，fceumm serialize 二进制）与电池 SRAM（srm）
 * 持久化到宿主数据目录。
 *
 * 键位（用户定制）：
 *   方向: W/A/S/D（方向键备用）  B: J  A: K  连击: U(Turbo B)/I(Turbo A)
 *   START: 1  SELECT: 5
 */
window.__ModuleLoader__.load({
  id: "dsh-plugin-fc-emulator",
  factory: function (require) {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    var NAME = "dsh-plugin-fc-emulator";
    var PREFIX = "/dsh-plugin-fc";
    // 核心构建戳：核心文件更新时必须同步递增，用于击穿浏览器对
    // fceumm.js / fceumm.wasm 的缓存（wasm 约 800KB，浏览器会强缓存）。
    var CORE_VERSION = "20250929-input1";
    function coreUrl(p) { return p + "?v=" + CORE_VERSION; }
    var SRM_SIZE = 0x2000;
    var FRAME_MS = 1000 / 60;       // NTSC 60fps（自驱动帧循环）
    var TURBO_INTERVAL = 130;       // 连击间隔 ms
    var TURBO_PULSE = 40;           // 连击单次按压时长 ms

    // 逻辑按钮 id（插件内部统一）
    var BTN = {
      A: 0, B: 1, SELECT: 2, START: 3,
      UP: 4, DOWN: 5, LEFT: 6, RIGHT: 7,
      TURBO_A: 8, TURBO_B: 9
    };

    // fceumm 输入映射：逻辑按钮 → RETRO_DEVICE_ID_JOYPAD 索引
    // 注意：本 fceumm 用的 libretro.h 是【非标准】id 定义：
    //   B=0, A=8, SELECT=2, START=3, UP=4, DOWN=5, LEFT=6, RIGHT=7, L3=14
    // （标准 libretro 是 A=1，但这里 A=8，务必按核心实际查询的 id 对齐）
    var JOYPAD_IDX = {
      0: 8,   // A（非标准 libretro：A=8）
      1: 0,   // B
      2: 2,   // SELECT
      3: 3,   // START
      4: 4,   // UP
      5: 5,   // DOWN
      6: 6,   // LEFT
      7: 7    // RIGHT
    };

    // fceumm 像素格式（新版 libretro 枚举，以头文件为准）
    var PXFMT_XRGB8888 = 1, PXFMT_RGB565 = 2, PXFMT_0RGB1555 = 0;

    /**
     * 坏头 ROM 修正表（按文件名匹配，命中则重写 iNES 头）。
     * fceumm 的 iNES 1.0 头解码 = (h7 & 0xF0) | (h6 >> 4)（与 jsnes 同一套约定），
     * 编号为标准 iNES mapper 表（4=MMC3、21=Konami VRC2/VRC4 A、65=IREM-H3001…）。
     * 条目字段：
     *   name    — 文件名包含的关键词
     *   prg/chr — 真实的 PRG(×16K)/CHR(×8K) 银行数
     *   b6/b7   — 重写的 header byte6/byte7（含镜像/标志位）
     *   offset  — 游戏数据在文件内的起始偏移（默认 0）
     * 新增坏头 ROM：加一条即可。
     *
     * 注意：《三目童子》（含子弹增加版）曾有 VRC4 256K/256K 修正条目，经核心实测
     * （wasm 逐帧渲染验证）其原始头 (h6=0x41,h7=0x00) 正确解码为 MMC3(mapper 4,
     * 128K PRG/128K CHR) 并可正常启动，改写后反而灰屏。该条目已删除，勿重新添加。
     * 表中文件若比头声明大（如 768K 的三目童子带 512K 尾部数据），核心只读头声明
     * 的部分、忽略尾部，无需裁剪。
     */
    var ROM_HEADER_FIXES = [
      // 当前为空：所有在库 ROM 的原始头均经核心实测可正常启动。
    ];

    function fixRomHeader(name, rom) {
      for (var i = 0; i < ROM_HEADER_FIXES.length; i++) {
        var r = ROM_HEADER_FIXES[i];
        if (name.indexOf(r.name) === -1) continue;
        var off = r.offset || 0;
        var need = off + 16 + r.prg * 16384 + r.chr * 8192;
        if (rom.length < need) continue;
        // 偏移处必须是合法 iNES 头
        if (rom[off] !== 0x4e || rom[off + 1] !== 0x45 ||
            rom[off + 2] !== 0x53 || rom[off + 3] !== 0x1a) continue;
        var out = new Uint8Array(16 + r.prg * 16384 + r.chr * 8192);
        out.set(rom.subarray(off, need), 0);
        out[4] = r.prg; out[5] = r.chr;
        out[6] = r.b6;  out[7] = r.b7;
        return out;
      }
      return rom;
    }

    // ── 可改键系统 ──
    // 逻辑按钮的展示元信息（顺序即改键面板的行顺序）。
    // id 0~9 为游戏按钮（JOYPAD_IDX 可映射），10~12 为特殊功能键
    // （快速隐藏 / 快速存档 / 快速读档，不进入 JOYPAD_IDX）。
    var BTN_META = [
      { id: 0,  name: "A 键（攻击）" },
      { id: 1,  name: "B 键" },
      { id: 2,  name: "SELECT" },
      { id: 3,  name: "START" },
      { id: 4,  name: "上" },
      { id: 5,  name: "下" },
      { id: 6,  name: "左" },
      { id: 7,  name: "右" },
      { id: 8,  name: "连击 A" },
      { id: 9,  name: "连击 B" },
      { id: 10, name: "快速隐藏（隐藏/恢复）" },
      { id: 11, name: "快速存档" },
      { id: 12, name: "快速读档" }
    ];
    var ID_BOSS = 10, ID_QUICKSAVE = 11, ID_QUICKLOAD = 12;

    // 默认键位：每个按钮最多 2 个键 [主键, 副键]（null = 空）。
    var DEFAULT_KEYMAP = {
      0: ["KeyK", null],
      1: ["KeyJ", null],
      2: ["Digit5", "Numpad5"],
      3: ["Digit1", "Numpad1"],
      4: ["KeyW", "ArrowUp"],
      5: ["KeyS", "ArrowDown"],
      6: ["KeyA", "ArrowLeft"],
      7: ["KeyD", "ArrowRight"],
      8: ["KeyI", null],
      9: ["KeyU", null],
      10: ["Backquote", null],
      11: ["BracketLeft", null],
      12: ["BracketRight", null]
    };
    var KEYMAP_STORAGE = "fc-emulator-keymap-v1";

    function cloneKeymap(km) {
      var out = {};
      for (var b in km) out[b] = km[b].slice();
      return out;
    }

    function loadKeymap() {
      var km = null;
      try { km = JSON.parse(localStorage.getItem(KEYMAP_STORAGE) || "null"); }
      catch (e) { km = null; }
      var out = {};
      for (var i = 0; i < BTN_META.length; i++) {
        var id = BTN_META[i].id;
        if (km && Array.isArray(km[id]) && km[id].length === 2) {
          out[id] = [km[id][0] || null, km[id][1] || null];
        } else {
          out[id] = DEFAULT_KEYMAP[id].slice();
        }
      }
      return out;
    }

    function saveKeymap() {
      try { localStorage.setItem(KEYMAP_STORAGE, JSON.stringify(state.keymap)); }
      catch (e) { /* localStorage 不可用则仅本会话生效 */ }
    }

    // ── 在线游戏库：仓库地址由用户填写（插件本身不指向任何特定 ROM 仓库）──
    var ONLINE_REPO_STORAGE = "fc-emulator-online-repo";
    // 故意为空：插件不预填任何第三方 ROM 仓库；用户自行填写（可在 Issue 里推荐）
    var DEFAULT_ONLINE_REPO = "";

    function loadOnlineRepo() {
      var v = null;
      try { v = localStorage.getItem(ONLINE_REPO_STORAGE); } catch (e) { v = null; }
      return (v && v.trim()) ? v.trim() : DEFAULT_ONLINE_REPO;
    }

    function saveOnlineRepo() {
      try { localStorage.setItem(ONLINE_REPO_STORAGE, state.onlineRepo); }
      catch (e) { /* 仅本会话生效 */ }
    }

    // 解析用户输入的仓库地址 → {owner, repo, branch, prefix}。
    // 支持：
    //   owner/repo
    //   github.com/owner/repo[.git]
    //   https://github.com/owner/repo
    //   https://github.com/owner/repo/tree/<branch>
    //   https://github.com/owner/repo/tree/<branch>/<subdir...>  （如 …/tree/master/roms）
    // 分支缺省 master；prefix 为子目录前缀（无则 ""）。无法解析返回 null。
    function parseGitHubRepo(input) {
      var s = String(input || "").trim();
      if (!s) return null;
      s = s.replace(/^https?:\/\//i, "");
      s = s.replace(/\.git$/i, "");
      s = s.replace(/^(www\.)?github\.com\//i, "");
      var parts = s.split("/").filter(Boolean);
      if (parts.length < 2) return null;
      var owner = parts[0], repo = parts[1];
      if (!owner || !repo) return null;
      var branch = "master";
      var prefix = "";
      for (var i = 2; i < parts.length; i++) {
        if (parts[i] === "tree" && parts[i + 1]) {
          branch = parts[i + 1];
          // /tree/<branch>/<subdir...> → 只扫该子目录
          if (parts.length > i + 2) {
            prefix = parts.slice(i + 2).join("/");
          }
          break;
        }
      }
      return { owner: owner, repo: repo, branch: branch, prefix: prefix };
    }

    // 当前在线仓库配置（未配置/非法 → null）
    function onlineRepoConfig() {
      return parseGitHubRepo(state.onlineRepo);
    }

    // 由 state.keymap（btn→[code,code]）构建反向映射 code→btnId。
    // 同一 code 被多个按钮占用时，按 BTN_META 顺序"先占先得"。
    function rebuildCodeMap() {
      var map = {};
      for (var i = 0; i < BTN_META.length; i++) {
        var id = BTN_META[i].id;
        var codes = state.keymap[id];
        for (var s = 0; s < codes.length; s++) {
          var code = codes[s];
          if (code && map[code] === undefined) map[code] = id;
        }
      }
      state.codeMap = map;
    }

    var CODE_LABELS = {
      ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→",
      Space: "空格", Enter: "回车", Escape: "Esc", Tab: "Tab",
      ShiftLeft: "左Shift", ShiftRight: "右Shift",
      ControlLeft: "左Ctrl", ControlRight: "右Ctrl",
      AltLeft: "左Alt", AltRight: "右Alt",
      Backquote: "`", BracketLeft: "[", BracketRight: "]",
      Semicolon: ";", Quote: "'", Comma: ",", Period: ".", Slash: "/", Backslash: "\\",
      Minus: "-", Equal: "=", Backspace: "退格", Delete: "删除",
      Numpad0: "小键0", Numpad1: "小键1", Numpad2: "小键2", Numpad3: "小键3",
      Numpad4: "小键4", Numpad5: "小键5", Numpad6: "小键6", Numpad7: "小键7",
      Numpad8: "小键8", Numpad9: "小键9"
    };
    function codeLabel(code) {
      if (!code) return "";
      if (CODE_LABELS[code]) return CODE_LABELS[code];
      if (code.indexOf("Key") === 0) return code.slice(3);
      if (code.indexOf("Digit") === 0) return code.slice(5);
      if (code.indexOf("Numpad") === 0) return "小键" + code.slice(6);
      if (code.indexOf("Arrow") === 0) return "方向" + code.slice(5);
      return code;
    }

    var state = {
      root: null,
      ball: null,
      modal: null,
      corePromise: null,
      fce: null,           // emscripten 模块（createFceModule() 的返回）
      game: null,          // 当前游戏会话：{ canvas, ctx, imgData, romPtr, sramPtr, sramSize, fpsFrames, resPos }
      romName: null,
      romLabel: "",
      hasBattery: false,
      sramBytes: null,     // 已加载的 SRAM 字节（用于重置后重新注入）
      sramSize: 0,
      sramTimer: null,     // 周期性 SRAM 落盘定时器
      paused: false,
      muted: false,
      crashed: false,
      libTab: "local",
      localRoms: [],       // 最近一次本地 ROM 列表（供在线页判断是否已下载）
      onlineRoms: null,    // [{name, path, size}] from GitHub tree；path 为仓库内完整路径
      onlineQuery: "",
      onlineRepo: loadOnlineRepo(), // 在线库 GitHub 仓库地址（用户可改）
      fpsTimer: null,
      rafId: null,
      keyDown: null,
      keyUp: null,
      blurHandler: null,
      specialKeyHandler: null,
      resizeObs: null,
      heldButtons: [],
      turbo: { A: { active: false, timer: null }, B: { active: false, timer: null } },
      // 可改键
      keymap: loadKeymap(),       // btnId → [code, code|null]
      codeMap: {},                // e.code → btnId（rebuildCodeMap 重建）
      capturing: null,            // 改键捕获中：{ btnId, slotIdx }
      _captureHandler: null,
      keysViewOpen: false,        // 键位设置面板是否打开
      keysViewReturn: "lib"       // 关闭键位面板后返回哪个视图
    };
    rebuildCodeMap();

    // ─────────────────────────── CSS ───────────────────────────

    var CSS = [
      "#fc-emulator-root *{box-sizing:border-box;margin:0;padding:0;font-family:inherit}",
      "#fc-ball{position:fixed;right:20px;bottom:140px;width:58px;height:58px;border:none;border-radius:14px;cursor:pointer;z-index:999999;",
      "background:linear-gradient(145deg,#3a3f4a,#1c1f26);color:#e8e8e8;display:flex;flex-direction:column;align-items:center;justify-content:center;",
      "box-shadow:0 4px 16px rgba(0,0,0,.45),inset 0 1px 0 rgba(255,255,255,.12);transition:transform .15s ease,box-shadow .15s ease}",
      "#fc-ball:hover{transform:translateY(-3px) scale(1.05);box-shadow:0 8px 22px rgba(0,0,0,.55),inset 0 1px 0 rgba(255,255,255,.15)}",
      "#fc-ball:active{transform:scale(.96)}",
      "#fc-ball .fc-ball-label{font-size:20px;font-weight:800;letter-spacing:1px;color:#ff5a4e;text-shadow:0 1px 2px rgba(0,0,0,.6)}",
      "#fc-ball .fc-ball-sub{font-size:8px;letter-spacing:.5px;opacity:.75;margin-top:1px}",
      "#fc-modal{position:fixed;inset:0;z-index:999999;display:flex;align-items:center;justify-content:center}",
      "#fc-modal .fc-backdrop{position:absolute;inset:0;background:rgba(5,8,12,.72);backdrop-filter:blur(3px)}",
      "#fc-window{position:relative;display:flex;flex-direction:column;width:min(1040px,94vw);height:min(760px,92vh);background:#14161c;border:1px solid rgba(255,255,255,.09);border-radius:14px;overflow:hidden;box-shadow:0 24px 70px rgba(0,0,0,.6);color:#e6e8ee}",
      "#fc-header{display:flex;align-items:center;gap:10px;padding:12px 16px;border-bottom:1px solid rgba(255,255,255,.08);flex:0 0 auto}",
      "#fc-header .fc-title{font-size:15px;font-weight:700}",
      "#fc-header .fc-title b{color:#ff5a4e}",
      "#fc-header .fc-sub{font-size:11px;opacity:.55}",
      "#fc-header .fc-rom-label{font-size:12px;opacity:.85;margin-left:6px;padding:2px 8px;background:rgba(255,255,255,.06);border-radius:6px;max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      "#fc-close{margin-left:auto;width:30px;height:30px;border:none;border-radius:8px;background:transparent;color:#9aa3b2;font-size:18px;cursor:pointer;line-height:1}",
      "#fc-close:hover{background:rgba(255,90,78,.15);color:#ff8a80}",
      "#fc-body{flex:1 1 auto;min-height:0;position:relative}",
      ".fc-view{position:absolute;inset:0;display:flex;flex-direction:column}",
      "[hidden]{display:none !important}",
      /* library */
      "#fc-view-lib{padding:14px 16px;gap:12px;overflow:auto}",
      "#fc-lib-toolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap}",
      ".fc-btn{border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.06);color:#e6e8ee;border-radius:8px;padding:6px 14px;font-size:12.5px;cursor:pointer;transition:background .12s}",
      ".fc-btn:hover{background:rgba(255,255,255,.13)}",
      ".fc-btn.primary{background:#d2443c;border-color:#d2443c;color:#fff;font-weight:600}",
      ".fc-btn.primary:hover{background:#e0554c}",
      ".fc-btn.danger{color:#ff8a80}",
      ".fc-btn:disabled{opacity:.45;cursor:not-allowed}",
      "#fc-lib-toolbar .fc-hint{font-size:11px;opacity:.5;margin-left:auto}",
      "#fc-rom-list{display:flex;flex-direction:column;gap:8px}",
      "#fc-rom-list .fc-empty{opacity:.5;font-size:13px;padding:26px 0;text-align:center}",
      /* tabs */
      "#fc-view-lib{gap:12px}",
      "#fc-panel-local,#fc-panel-online{display:flex;flex-direction:column;gap:12px;flex:1 1 auto;min-height:0}",
      "#fc-online-list{flex:1 1 auto;min-height:0;overflow:auto}",
      "#fc-lib-tabs{display:flex;gap:6px;flex:0 0 auto}",
      ".fc-tab{border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.05);color:#c9ced9;border-radius:9px;padding:7px 18px;font-size:13px;font-weight:600;cursor:pointer;letter-spacing:.3px;transition:background .12s,border-color .12s}",
      ".fc-tab:hover{background:rgba(255,255,255,.11)}",
      ".fc-tab.fc-tab-on{background:#d2443c;border-color:#d2443c;color:#fff}",
      /* online */
      "#fc-online-toolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap}",
      "#fc-online-search{flex:1 1 220px;max-width:340px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.14);border-radius:8px;color:#e6e8ee;padding:7px 12px;font-size:12.5px;outline:none}",
      "#fc-online-search:focus{border-color:rgba(210,68,60,.6)}",
      "#fc-online-repo-row{display:flex;align-items:center;gap:8px;margin-bottom:8px}",
      "#fc-online-repo-row .fc-online-repo-label{font-size:12px;opacity:.7;white-space:nowrap}",
      "#fc-online-repo{flex:1 1 auto;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.14);border-radius:8px;color:#e6e8ee;padding:7px 12px;font-size:12.5px;outline:none;font-family:ui-monospace,Menlo,Consolas,monospace}",
      "#fc-online-repo:focus{border-color:rgba(210,68,60,.6)}",
      "#fc-online-status{font-size:12px;opacity:.75}",
      "#fc-online-list{display:flex;flex-direction:column;gap:6px}",
      "#fc-online-list .fc-empty{opacity:.5;font-size:13px;padding:26px 0;text-align:center}",
      ".fc-online-row .fc-online-name{font-size:13.5px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1 1 auto;min-width:0}",
      ".fc-online-row .fc-online-meta{font-size:11px;opacity:.5;white-space:nowrap}",
      ".fc-online-row .fc-play.local{background:rgba(255,255,255,.14);border-color:rgba(255,255,255,.2)}",
      ".fc-rom-row{display:flex;align-items:center;gap:10px;padding:10px 12px;background:rgba(255,255,255,.045);border:1px solid rgba(255,255,255,.07);border-radius:10px}",
      ".fc-rom-row .fc-rom-name{font-size:13.5px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1 1 auto;min-width:0}",
      ".fc-rom-row .fc-rom-meta{font-size:11px;opacity:.5;flex:0 0 auto}",
      ".fc-rom-row .fc-rom-src{font-size:10px;padding:1px 6px;border-radius:5px;background:rgba(120,170,255,.14);color:#8ab4ff;flex:0 0 auto}",
      ".fc-play{width:34px;height:34px;border-radius:50%;border:none;cursor:pointer;background:linear-gradient(145deg,#ff6a5e,#d2443c);color:#fff;font-size:13px;flex:0 0 auto;box-shadow:0 2px 8px rgba(210,68,60,.4)}",
      ".fc-play:hover{filter:brightness(1.1)}",
      /* game */
      "#fc-view-game{background:#000}",
      "#fc-canvas-host{flex:1 1 auto;min-height:0;background:#000;display:flex;align-items:center;justify-content:center}",
      "#fc-canvas-host canvas{display:block}",
      "#fc-loading{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:13px;opacity:.8;background:#000;z-index:2}",
      "#fc-loading .fc-spin{display:inline-block;width:14px;height:14px;border:2px solid rgba(255,255,255,.25);border-top-color:#ff5a4e;border-radius:50%;margin-right:8px;animation:fcspin .8s linear infinite}",
      "@keyframes fcspin{to{transform:rotate(360deg)}}",
      "#fc-crash{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;background:rgba(0,0,0,.86);z-index:3;font-size:13px;color:#ffb4ad;text-align:center;padding:20px}",
      "#fc-choice{position:absolute;left:50%;bottom:18px;transform:translateX(-50%);display:flex;align-items:center;gap:10px;background:rgba(16,18,24,.92);border:1px solid rgba(255,255,255,.12);border-radius:10px;padding:10px 14px;z-index:3;font-size:12.5px;box-shadow:0 8px 24px rgba(0,0,0,.5)}",
      "#fc-choice .fc-choice-text{opacity:.85}",
      "#fc-game-bar{flex:0 0 auto;display:flex;align-items:center;gap:8px;padding:8px 12px;background:#101216;border-top:1px solid rgba(255,255,255,.07);flex-wrap:wrap}",
      "#fc-game-bar .fc-fps{margin-left:auto;font-size:11.5px;opacity:.6;font-variant-numeric:tabular-nums}",
      /* keymap view */
      "#fc-view-keys{padding:16px 18px;gap:12px;overflow:auto}",
      "#fc-keys-toolbar{display:flex;align-items:center;gap:12px;flex-wrap:wrap}",
      "#fc-keys-toolbar .fc-keys-title{font-size:15px;font-weight:700}",
      "#fc-keys-toolbar .fc-keys-hint{font-size:11px;opacity:.55}",
      "#fc-keys-toolbar .fc-btn{margin-left:auto}",
      "#fc-keys-toolbar .fc-btn.primary{margin-left:8px}",
      "#fc-keys-list{display:flex;flex-direction:column;gap:6px}",
      ".fc-key-row{display:flex;align-items:center;gap:10px;padding:8px 12px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);border-radius:9px}",
      ".fc-key-row .fc-key-name{width:150px;flex:0 0 auto;font-size:12.5px;opacity:.9}",
      ".fc-key-slot{min-width:64px;padding:6px 12px;border:1px solid rgba(255,255,255,.16);background:rgba(255,255,255,.06);color:#e6e8ee;border-radius:7px;font-size:12.5px;cursor:pointer;transition:background .12s,border-color .12s}",
      ".fc-key-slot:hover{background:rgba(255,255,255,.13)}",
      ".fc-key-slot.fc-capturing{background:rgba(255,90,78,.18);border-color:#ff5a4e;color:#ffb4ae;animation:fc-cap-pulse 1s ease-in-out infinite}",
      "@keyframes fc-cap-pulse{0%,100%{box-shadow:0 0 0 0 rgba(255,90,78,.4)}50%{box-shadow:0 0 0 4px rgba(255,90,78,0)}}",
      /* virtual pad */
      "#fc-pad{flex:0 0 auto;display:flex;align-items:center;justify-content:space-between;padding:10px 22px 12px;background:#0c0e12}",
      ".fc-pad-group{display:flex;align-items:center;gap:14px}",
      ".fc-dpad{display:grid;grid-template-columns:repeat(3,44px);grid-template-rows:repeat(3,44px);gap:3px}",
      ".fc-dbtn{border:1px solid rgba(255,255,255,.16);background:linear-gradient(145deg,#262a33,#171a20);color:#cfd5e0;border-radius:9px;font-size:15px;cursor:pointer;user-select:none;touch-action:none;display:flex;align-items:center;justify-content:center}",
      ".fc-dbtn:active,.fc-dbtn.fc-held{background:linear-gradient(145deg,#3a4150,#22262f);color:#fff;border-color:rgba(255,90,78,.5)}",
      ".fc-abad{display:flex;align-items:flex-end;gap:12px}",
      ".fc-rbtn{width:52px;height:52px;border-radius:50%;border:1px solid rgba(255,255,255,.18);cursor:pointer;user-select:none;touch-action:none;font-size:13px;font-weight:700;display:flex;align-items:center;justify-content:center}",
      ".fc-rbtn:active,.fc-rbtn.fc-held{filter:brightness(1.25)}",
      ".fc-rbtn.fc-b{background:linear-gradient(145deg,#4a3a2e,#2c221a);color:#ffc98a}",
      ".fc-rbtn.fc-a{background:linear-gradient(145deg,#5a3028,#331812);color:#ff9a8a;margin-bottom:6px}",
      ".fc-rbtn.fc-sel{width:38px;height:38px;background:linear-gradient(145deg,#2a2f3a,#181c24);color:#aab4c8;font-size:9px;letter-spacing:.5px}",
      ".fc-rbtn.fc-start{width:38px;height:38px;background:linear-gradient(145deg,#2a2f3a,#181c24);color:#aab4c8;font-size:9px;letter-spacing:.5px}",
      "#fc-footer{flex:0 0 auto;padding:6px 16px;border-top:1px solid rgba(255,255,255,.06);font-size:11px;opacity:.55;background:#101216;letter-spacing:.3px}",
      "#fc-toast{position:absolute;top:14px;left:50%;transform:translateX(-50%);background:rgba(20,22,28,.95);border:1px solid rgba(255,255,255,.14);color:#e6e8ee;font-size:12.5px;padding:8px 16px;border-radius:9px;z-index:1000000;opacity:0;transition:opacity .2s;pointer-events:none;box-shadow:0 6px 20px rgba(0,0,0,.5)}",
      "#fc-toast.fc-show{opacity:1}"
    ].join("");

    // ─────────────────────────── DOM helpers ───────────────────────────

    function el(tag, attrs, children) {
      var node = document.createElement(tag);
      if (attrs) {
        Object.keys(attrs).forEach(function (k) {
          if (k === "class") node.className = attrs[k];
          else if (k === "text") node.textContent = attrs[k];
          else if (k === "html") node.innerHTML = attrs[k];
          else if (k === "on") {
            Object.keys(attrs[k]).forEach(function (ev) {
              node.addEventListener(ev, attrs[k][ev]);
            });
          } else if (k === "style") {
            Object.assign(node.style, attrs[k]);
          } else {
            node.setAttribute(k, attrs[k]);
          }
        });
      }
      var kids = children == null ? [] : Array.isArray(children) ? children : [children];
      kids.forEach(function (c) {
        if (c == null) return;
        node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
      });
      return node;
    }

    var toastTimer = null;
    function toast(msg) {
      var t = state.root && state.root.querySelector("#fc-toast");
      if (!t) return;
      t.textContent = msg;
      t.classList.add("fc-show");
      if (toastTimer) clearTimeout(toastTimer);
      toastTimer = setTimeout(function () { t.classList.remove("fc-show"); }, 2200);
    }

    // ─────────────────────────── core loading ───────────────────────────

    /**
     * 加载 fceumm 核心：
     *  1) 预注入钩子（window.createFceModule 已存在 → 直接实例化，测试用）
     *  2) 新路由 /core-fce/fceumm.js（重启后的服务器，正规 content-type）
     *  3) 回退 /roms/fceumm.js（旧服务器无新路由；核心文件放 roms 目录经
     *     现有 ROM 路由分发，wasm 位置用 Module.locateFile 显式指定）
     * 胶水经 Blob URL 执行（兼容 octet-stream 分发），wasm 经 locateFile 拉取。
     */
    function loadCore() {
      if (state.fce) return Promise.resolve(state.fce);
      if (state.corePromise) return state.corePromise;
      state.corePromise = new Promise(function (resolve, reject) {
        function fail(e) {
          state.corePromise = null;
          reject(new Error("fceumm 核心加载失败：" + (e && e.message ? e.message : e)));
        }
        function instantiate(factory, wasmUrl) {
          factory({ locateFile: function (p) { return wasmUrl; } })
            .then(function (m) { state.fce = m; resolve(m); }, fail);
        }
        function runGlue(text, wasmUrl) {
          var blob = new Blob([text], { type: "application/javascript" });
          var url = URL.createObjectURL(blob);
          var s = document.createElement("script");
          s.src = url;
          s.onload = function () {
            URL.revokeObjectURL(url);
            if (typeof window.createFceModule !== "function") {
              fail(new Error("createFceModule 缺失（胶水执行异常）"));
              return;
            }
            instantiate(window.createFceModule, wasmUrl);
          };
          s.onerror = function () {
            URL.revokeObjectURL(url);
            fail(new Error("核心胶水执行失败"));
          };
          document.head.appendChild(s);
        }
        function loadFrom(glueUrl, wasmUrl) {
          return fetch(coreUrl(PREFIX + glueUrl)).then(function (res) {
            if (!res.ok) throw new Error("HTTP " + res.status);
            return res.text();
          }).then(function (text) { runGlue(text, coreUrl(PREFIX + wasmUrl)); });
        }
        // 1) 预注入
        if (typeof window.createFceModule === "function") {
          instantiate(window.createFceModule, coreUrl(PREFIX + "/core-fce/fceumm.wasm"));
          return;
        }
        // 2) 新路由 → 3) 回退
        loadFrom("/core-fce/fceumm.js", "/core-fce/fceumm.wasm")
          .catch(function () {
            return loadFrom("/roms/fceumm.js", "/roms/fceumm.wasm");
          })
          .catch(fail);
      });
      return state.corePromise;
    }

    // ─────────────────────────── API fetch ───────────────────────────

    function api(path, opts) {
      return fetch(PREFIX + path, opts).then(function (res) {
        if (!res.ok) {
          return res.text().then(function (txt) {
            var msg = txt;
            try { msg = JSON.parse(txt).error || txt; } catch (e) { /* keep raw */ }
            throw new Error(msg || ("HTTP " + res.status));
          });
        }
        return res;
      });
    }

    // ─────────────────────────── ROM library ───────────────────────────

    function refreshRoms() {
      var list = state.root.querySelector("#fc-rom-list");
      list.innerHTML = "";
      list.appendChild(el("div", { class: "fc-empty", text: "加载中…" }));
      api("/roms").then(function (res) {
        return res.json();
      }).then(function (doc) {
        list.innerHTML = "";
        var roms = doc.data || [];
        state.localRoms = roms;
        if (roms.length === 0) {
          list.appendChild(el("div", {
            class: "fc-empty",
            text: "还没有游戏。点「上传 ROM」放入自己的 .nes 卡带镜像，或把 ROM 放到服务器插件 roms/ 目录。"
          }));
          return;
        }
        roms.forEach(function (r) {
          var row = el("div", { class: "fc-rom-row" }, [
            el("button", {
              class: "fc-play", title: "开始游戏",
              on: { click: function () { enterGame(r.name, r.name); } }
            }, "▶"),
            el("span", { class: "fc-rom-name", text: r.name }),
            el("span", { class: "fc-rom-src", text: r.source === "uploaded" ? "已上传" : "内置" }),
            el("span", { class: "fc-rom-meta", text: (r.size / 1024).toFixed(0) + " KB" }),
            r.source === "uploaded"
              ? el("button", {
                class: "fc-btn danger", text: "删除",
                on: { click: function () { deleteRom(r.name); } }
              })
              : null
          ]);
          list.appendChild(row);
        });
      }).catch(function (e) {
        list.innerHTML = "";
        list.appendChild(el("div", { class: "fc-empty", text: "加载 ROM 列表失败：" + e.message }));
      });
    }

    function uploadRom(file) {
      var name = file.name || "game.nes";
      var btn = state.root.querySelector("#fc-upload-btn");
      if (btn) btn.disabled = true;
      api("/roms?name=" + encodeURIComponent(name), { method: "POST", body: file })
        .then(function (res) { return res.json(); })
        .then(function (doc) {
          toast("已上传 " + doc.name);
          refreshRoms();
        })
        .catch(function (e) { toast("上传失败：" + e.message); })
        .finally(function () { if (btn) btn.disabled = false; });
    }

    function deleteRom(name) {
      if (!window.confirm("确定删除 ROM：" + name + " ？（存档与 SRAM 会保留）")) return;
      api("/roms/" + encodeURIComponent(name), { method: "DELETE" })
        .then(function (res) { return res.json(); })
        .then(function () { toast("已删除 " + name); refreshRoms(); })
        .catch(function (e) { toast("删除失败：" + e.message); });
    }

    // ─────────────────────────── online ROM library (GitHub) ───────────────────────────

    function setOnlineStatus(text) {
      var s = state.root.querySelector("#fc-online-status");
      if (s) s.textContent = text;
    }

    function loadOnlineRoms(force) {
      if (state.onlineRoms && !force) return Promise.resolve(state.onlineRoms);
      var cfg = onlineRepoConfig();
      if (!cfg) {
        setOnlineStatus("请先填写有效的 GitHub 仓库地址（owner/repo 或 …/tree/分支/子目录）。推荐在 GitHub 搜索：nes游戏合集");
        return Promise.resolve([]);
      }
      var apiTree = "https://api.github.com/repos/" + cfg.owner + "/" + cfg.repo +
        "/git/trees/" + cfg.branch + "?recursive=1";
      setOnlineStatus("正在加载在线游戏清单（github.com/" + cfg.owner + "/" + cfg.repo +
        (cfg.prefix ? "/" + cfg.prefix : "") + "）…");
      return fetch(apiTree)
        .then(function (res) {
          if (!res.ok) {
            var hint = res.status === 403 ? "（GitHub 限流，请稍后再试）" : (res.status === 404 ? "（仓库不存在或无该分支）" : "");
            throw new Error("HTTP " + res.status + hint);
          }
          return res.json();
        })
        .then(function (tree) {
          var roms = [];
          var prefix = cfg.prefix || "";
          var prefixSlash = prefix ? prefix.replace(/\/+$/, "") + "/" : "";
          (tree.tree || []).forEach(function (t) {
            if (t.type !== "blob") return;
            var fullPath = String(t.path || "");
            // 填了 /tree/分支/子目录 时只收该目录下的 .nes；否则整仓递归
            if (prefixSlash && fullPath.indexOf(prefixSlash) !== 0) return;
            var base = fullPath.split("/").pop();
            if (!base || !/\.nes$/i.test(base)) return;
            // name=本地保存/展示用文件名；path=仓库内完整路径（下载必须带上子目录）
            roms.push({ name: base, path: fullPath, size: t.size || 0 });
          });
          roms.sort(function (a, b) { return a.name.localeCompare(b.name, "zh"); });
          state.onlineRoms = roms;
          var srcLabel = "github.com/" + cfg.owner + "/" + cfg.repo +
            (prefix ? "/" + prefix : "");
          setOnlineStatus("共 " + roms.length + " 款游戏（来源：" + srcLabel + "）· 点 ▶ 下载并游玩");
          renderOnlineList();
          return roms;
        })
        .catch(function (e) {
          setOnlineStatus("清单加载失败：" + (e && e.message ? e.message : e) + "（可点「刷新清单」重试）");
        });
    }

    function isLocalRom(name) {
      // 用最近一次本地列表判断（refreshRoms 后有效）
      var names = (state.localRoms || []).map(function (r) { return r.name; });
      return names.indexOf(name) !== -1;
    }

    function renderOnlineList() {
      var list = state.root.querySelector("#fc-online-list");
      if (!list || !state.onlineRoms) return;
      list.innerHTML = "";
      var q = (state.onlineQuery || "").trim().toLowerCase();
      var roms = state.onlineRoms.filter(function (r) {
        if (!q) return true;
        return r.name.toLowerCase().indexOf(q) !== -1 ||
          String(r.path || "").toLowerCase().indexOf(q) !== -1;
      });
      if (roms.length === 0) {
        list.appendChild(el("div", { class: "fc-empty", text: q ? "没有匹配的游戏" : "清单为空" }));
        return;
      }
      roms.forEach(function (r) {
        var local = isLocalRom(r.name);
        var row = el("div", { class: "fc-rom-row fc-online-row" }, [
          el("button", {
            class: "fc-play" + (local ? " local" : ""),
            title: local ? "本地已有，直接开始" : "从 GitHub 下载并保存后开始",
            on: { click: function (ev) { playOnline(r, ev.currentTarget); } }
          }, local ? "▶ 本地" : "▶"),
          el("span", { class: "fc-online-name", text: r.name }),
          el("span", { class: "fc-online-meta", text: humanSize(r.size) })
        ]);
        list.appendChild(row);
      });
    }

    function humanSize(bytes) {
      if (bytes >= 1048576) return (bytes / 1048576).toFixed(1) + " MB";
      return Math.max(1, Math.round(bytes / 1024)) + " KB";
    }

    function playOnline(rom, btn) {
      var name = rom.name;
      if (isLocalRom(name)) {
        enterGame(name);
        return;
      }
      var cfg = onlineRepoConfig();
      if (!cfg) { toast("未配置在线仓库地址"); if (btn) { btn.disabled = false; } return; }
      // 必须用仓库内完整路径（如 roms/游戏/游戏.nes），不能只用 basename
      var relPath = rom.path || name;
      var rawUrl = "https://raw.githubusercontent.com/" + cfg.owner + "/" + cfg.repo + "/" +
        cfg.branch + "/" + relPath.split("/").map(encodeURIComponent).join("/");
      if (btn) { btn.disabled = true; btn.textContent = "下载中…"; }
      fetch(rawUrl)
        .then(function (res) {
          if (!res.ok) throw new Error("GitHub 下载失败（HTTP " + res.status + "）");
          return res.arrayBuffer();
        })
        .then(function (buf) {
          var b = new Uint8Array(buf);
          if (b.length < 4 || b[0] !== 0x4e || b[1] !== 0x45 || b[2] !== 0x53 || b[3] !== 0x1a) {
            throw new Error("文件不是有效的 NES ROM（缺少 NES 头）");
          }
          // 持久化到本地 ROM 库（409 = 已存在，忽略）；本地仍用 basename
          return fetch(PREFIX + "/roms?name=" + encodeURIComponent(name), {
            method: "POST",
            headers: { "Content-Type": "application/octet-stream" },
            body: buf
          }).then(function (res) {
            if (res.status === 409) return;
            if (!res.ok) throw new Error("保存到本地失败（HTTP " + res.status + "）");
          });
        })
        .then(function () {
          return api("/roms").then(function (res) { return res.json(); });
        })
        .then(function (doc) {
          state.localRoms = (doc.data || []).map(function (r) { return r; });
          toast("已下载并保存：" + name);
          enterGame(name);
        })
        .catch(function (e) {
          if (btn) { btn.disabled = false; btn.textContent = "▶"; }
          toast("下载失败：" + (e && e.message ? e.message : e));
        });
    }

    function switchLibTab(which) {
      state.libTab = which;
      var local = state.root.querySelector("#fc-panel-local");
      var online = state.root.querySelector("#fc-panel-online");
      var tb = state.root.querySelector("#fc-tab-local");
      var to = state.root.querySelector("#fc-tab-online");
      local.hidden = which !== "local";
      online.hidden = which !== "online";
      if (tb) tb.classList.toggle("fc-tab-on", which === "local");
      if (to) to.classList.toggle("fc-tab-on", which === "online");
      if (which === "online") loadOnlineRoms(false);
    }

    // ─────────────────────────── SRAM / save states ───────────────────────────

    function sramKey() {
      return state.romName ? encodeURIComponent(state.romName) : "";
    }

    /** 从核心读当前 SRAM 到 JS（返回 Uint8Array 或 null）。 */
    function readSramFromCore() {
      var m = state.fce, g = state.game;
      if (!m || !g || !g.sramPtr || !g.sramSize) return null;
      var sz = m._fce_sram_read(g.sramPtr);
      if (!sz) return null;
      return new Uint8Array(m.HEAP8.buffer, m.HEAP8.byteOffset + g.sramPtr, sz).slice();
    }

    function flushSram() {
      if (!state.hasBattery) return;
      var bytes = readSramFromCore();
      if (!bytes) return;
      api("/srm/" + sramKey(), { method: "PUT", body: bytes })
        .catch(function (e) { console.warn("[fc-emulator] SRAM 落盘失败:", e.message); });
    }

    /** 游戏运行期间每 3s 落盘一次（fceumm 无写回调，按周期轮询）。 */
    function startSramFlush() {
      stopSramFlush();
      if (!state.hasBattery) return;
      state.sramTimer = setInterval(flushSram, 3000);
    }

    function stopSramFlush() {
      if (state.sramTimer) { clearInterval(state.sramTimer); state.sramTimer = null; }
    }

    // 序列化当前整局快照到指定槽位。slotKey 省略 = 主槽（sramKey）。
    function saveSnapshot(slotKey) {
      if (!state.fce || !state.game) return Promise.resolve();
      flushSram();
      var m = state.fce;
      var sz = m._fce_serialize_size();
      if (!sz) return Promise.reject(new Error("核心未提供快照数据（游戏可能未正常加载）"));
      var buf = m._malloc(sz);
      if (!m._fce_serialize(buf, sz)) {
        m._free(buf);
        return Promise.reject(new Error("快照序列化失败"));
      }
      var bytes = new Uint8Array(m.HEAP8.buffer, m.HEAP8.byteOffset + buf, sz);
      m._free(buf);
      var b64 = uint8ToB64(bytes);
      return api("/savestates/" + (slotKey || sramKey()), {
        method: "PUT",
        body: JSON.stringify({ core: "fceumm", data: b64 })
      });
    }

    // 快速存档/读档：独立的 quick 槽位（<ROM名>.quick），不覆盖主档。
    function quickKey() {
      return state.romName ? encodeURIComponent(state.romName + ".quick") : "";
    }

    function quickSave() {
      if (!state.fce || !state.game) return;
      saveSnapshot(quickKey()).then(function () {
        toast("快速存档成功（] 读档）");
      }).catch(function (e) {
        toast("快速存档失败：" + e.message);
      });
    }

    function quickLoad() {
      if (!state.fce || !state.game) return;
      api("/savestates/" + quickKey()).then(function (res) {
        return res.json();
      }).then(function (doc) {
        var env = doc && doc.data;
        if (env && env.core === "fceumm" && typeof env.data === "string") {
          restoreSnapshot(env);
          toast("快速读档成功");
        } else {
          toast("没有快速存档（先按 [ 存一次）");
        }
      }).catch(function (e) {
        toast("快速读档失败：" + e.message);
      });
    }

    function restoreSnapshot(doc) {
      // doc = 存档 envelope：{ core, savedAt, data | state }
      if (!doc) throw new Error("存档数据缺失");
      if (doc.core === "jsnes" || (doc.state && doc.state.cpu)) {
        throw new Error("该存档是旧 jsnes 核心生成的，与 fceumm 不兼容（请重新开局并存档）");
      }
      if (doc.core !== "fceumm" || typeof doc.data !== "string") {
        throw new Error("无法识别的存档格式");
      }
      var bytes = b64ToUint8(doc.data);
      var m = state.fce;
      var buf = m._malloc(bytes.length);
      m.HEAP8.set(bytes, buf);
      var ok = m._fce_unserialize(buf, bytes.length);
      m._free(buf);
      if (!ok) throw new Error("快照恢复失败（存档与当前 ROM 不匹配？）");
    }

    function uint8ToB64(u8) {
      var s = "";
      var CH = 0x8000;
      for (var i = 0; i < u8.length; i += CH) {
        s += String.fromCharCode.apply(null, u8.subarray(i, Math.min(i + CH, u8.length)));
      }
      return btoa(s);
    }

    function b64ToUint8(b64) {
      var s = atob(b64);
      var u8 = new Uint8Array(s.length);
      for (var i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i);
      return u8;
    }

    // ─────────────────────────── game session ───────────────────────────

    function pressBtn(btn) {
      if (state.fce && state.game && JOYPAD_IDX[btn] !== undefined) {
        state.fce._fce_set_input(0, JOYPAD_IDX[btn], 1);
      }
    }

    function releaseBtn(btn) {
      if (state.fce && state.game && JOYPAD_IDX[btn] !== undefined) {
        state.fce._fce_set_input(0, JOYPAD_IDX[btn], 0);
      }
    }

    function releaseAllButtons() {
      if (state.fce) {
        for (var idx = 0; idx < 16; idx++) state.fce._fce_set_input(0, idx, 0);
      }
      state.heldButtons = [];
      stopTurbo("A");
      stopTurbo("B");
    }

    // ── 连击（Turbo）：按住时自动连发 ──
    function startTurbo(which) {
      var t = state.turbo[which];
      if (!t || t.active) return;
      t.active = true;
      var btn = which === "A" ? BTN.A : BTN.B;
      var tap = function () {
        pressBtn(btn);
        setTimeout(function () { releaseBtn(btn); }, TURBO_PULSE);
      };
      tap();
      t.timer = setInterval(tap, TURBO_INTERVAL);
    }

    function stopTurbo(which) {
      var t = state.turbo[which];
      if (!t || !t.active) return;
      t.active = false;
      if (t.timer) { clearInterval(t.timer); t.timer = null; }
      releaseBtn(which === "A" ? BTN.A : BTN.B);
    }

    function bindKeys() {
      unbindKeys();
      state.keyDown = function (e) {
        resumeAudioIfSuspended(); // 自动播放策略下的首次手势恢复
        var btn = state.codeMap[e.code];
        // 实时诊断：显示处理器收到的键 / 映射 / joypad 位
        var kd = state.root ? state.root.querySelector("#fc-keydiag") : null;
        if (kd) kd.textContent = "key:" + e.code + (btn === undefined ? " (未映射)" : " →BTN" + btn + (JOYPAD_IDX[btn] !== undefined ? "/joy" + JOYPAD_IDX[btn] : ""));
        if (btn === undefined) return;
        // 特殊功能键（快速隐藏/快存/快读）由 global specialKeyHandler 处理
        if (btn >= ID_BOSS) return;
        // 改键面板打开时不触发游戏键
        if (state.keysViewOpen) return;
        var t = e.target;
        if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
        e.preventDefault();
        e.stopPropagation(); // 阻止 DSH 主应用截获游戏键
        if (e.repeat) return; // 系统重复键忽略（turbo 自己产生连发）
        if (btn === BTN.TURBO_A) startTurbo("A");
        else if (btn === BTN.TURBO_B) startTurbo("B");
        else pressBtn(btn);
      };
      state.keyUp = function (e) {
        var btn = state.codeMap[e.code];
        if (btn === undefined) return;
        if (btn >= ID_BOSS) return; // 特殊键
        if (state.keysViewOpen) return; // 改键面板打开时不触发
        e.preventDefault();
        e.stopPropagation(); // 阻止 DSH 主应用截获游戏键
        if (btn === BTN.TURBO_A) stopTurbo("A");
        else if (btn === BTN.TURBO_B) stopTurbo("B");
        else releaseBtn(btn);
      };
      state.blurHandler = function () { releaseAllButtons(); };
      // 捕获阶段（第三参 true）：事件到达目标前就处理，确保游戏键优先于
      // DSH 主应用的监听；配合 stopPropagation 彻底挡掉主应用截获。
      document.addEventListener("keydown", state.keyDown, true);
      document.addEventListener("keyup", state.keyUp, true);
      window.addEventListener("blur", state.blurHandler);
    }

    function unbindKeys() {
      if (state.keyDown) document.removeEventListener("keydown", state.keyDown, true);
      if (state.keyUp) document.removeEventListener("keyup", state.keyUp, true);
      if (state.blurHandler) window.removeEventListener("blur", state.blurHandler);
      state.keyDown = state.keyUp = state.blurHandler = null;
    }

    // ── 全局特殊键：快速隐藏（隐藏/恢复）+ 快速存读档 ──
    // 在 buildUi 时绑定、常驻（不随游戏进出解绑），这样"隐藏"状态下
    // 按快速隐藏键也能把游戏唤回。仅在焦点不在输入框时生效，避免打字误触。
    function bindSpecialKeys() {
      if (state.specialKeyHandler) return;
      state.specialKeyHandler = function (e) {
        if (state.capturing) return; // 改键捕获中，交给捕获逻辑
        if (state.keysViewOpen) return; // 键位面板打开时不触发
        var t = e.target;
        if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" ||
            t.tagName === "SELECT" || t.isContentEditable)) return;
        var id = state.codeMap[e.code];
        // 仅在实际执行动作时才拦截，避免无游戏时误吞 DSH 主应用的同名按键
        if (id === ID_BOSS) {
          if (state.game) {
            e.preventDefault();
            e.stopPropagation();
            toggleBoss();
          }
        } else if (id === ID_QUICKSAVE) {
          if (state.game && !state.modal.hidden) {
            e.preventDefault();
            e.stopPropagation();
            quickSave();
          }
        } else if (id === ID_QUICKLOAD) {
          if (state.game && !state.modal.hidden) {
            e.preventDefault();
            e.stopPropagation();
            quickLoad();
          }
        }
      };
      document.addEventListener("keydown", state.specialKeyHandler, true);
    }

    function unbindSpecialKeys() {
      if (state.specialKeyHandler) {
        document.removeEventListener("keydown", state.specialKeyHandler, true);
        state.specialKeyHandler = null;
      }
    }

    // 快速隐藏：收起整个游戏窗口 + 自动暂停；再按一次恢复 + 继续。
    function toggleBoss() {
      if (!state.game) return; // 没有进行中的游戏，忽略
      if (state.modal.hidden) {
        // 唤回
        state.modal.hidden = false;
        if (state.paused) togglePause(); // 继续
        state.ball.blur();
      } else {
        // 隐藏
        state.modal.hidden = true;
        if (!state.paused) togglePause(); // 暂停
        releaseAllButtons();
      }
    }

    function startFpsMeter() {
      stopFpsMeter();
      var fpsEl = state.root.querySelector("#fc-fps");
      state.fpsTimer = setInterval(function () {
        if (!state.game || !fpsEl) return;
        fpsEl.textContent = Math.round(state.game.fpsFrames * 1000 / 500) + " FPS";
        state.game.fpsFrames = 0;
        // 注意：不要在这里做全帧扫描/getImageData 读回——那是每 500ms 的主线程
        // 尖峰（实测 >5ms，浏览器里更高），是"操作卡顿"的主要来源之一。
      }, 500);
    }

    function stopFpsMeter() {
      if (state.fpsTimer) { clearInterval(state.fpsTimer); state.fpsTimer = null; }
    }

    // ── 音频接收器 ──
    // fceumm 核心以 48000Hz 立体声（L/R 同相）输出 int16 采样。
    // 优先创建 48000Hz 的 AudioContext 直接灌入；若浏览器强制设备率
    // （如 44100），在 pumpAudio 里做最近邻重采样。
    // ScriptProcessorNode（不需要 worker 文件，CSP 安全，全浏览器可用）。
    var CORE_RATE = 48000;

    function createAudioSink() {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      var ctx;
      try { ctx = new AC({ sampleRate: CORE_RATE }); }
      catch (e) { ctx = new AC(); } // 不支持指定采样率 → 设备率，pumpAudio 重采样
      var CAP = Math.floor(ctx.sampleRate * 2); // 2 秒环形缓冲
      var ringL = new Float32Array(CAP), ringR = new Float32Array(CAP);
      var w = 0, r = 0, count = 0;
      var proc = ctx.createScriptProcessor(2048, 0, 2);
      proc.onaudioprocess = function (e) {
        var outL = e.outputBuffer.getChannelData(0);
        var outR = e.outputBuffer.getChannelData(1);
        var n = outL.length, i = 0;
        while (i < n && count > 0) {
          outL[i] = ringL[r]; outR[i] = ringR[r];
          r = (r + 1) % CAP; count--; i++;
        }
        for (; i < n; i++) { outL[i] = 0; outR[i] = 0; }
      };
      proc.connect(ctx.destination);
      return {
        ctx: ctx,
        write: function (l, rr) {
          if (count >= CAP) return; // 溢出保护（正常运行不会发生）
          ringL[w] = l; ringR[w] = rr;
          w = (w + 1) % CAP; count++;
        },
        resume: function () {
          if (ctx.state === "suspended") { ctx.resume().catch(function () {}); }
        },
        suspend: function () {
          if (ctx.state === "running") { ctx.suspend().catch(function () {}); }
        },
        destroy: function () {
          try { proc.onaudioprocess = null; proc.disconnect(); } catch (e) { /* ignore */ }
          try { ctx.close(); } catch (e) { /* ignore */ }
        }
      };
    }

    function startAudio() {
      state.audio = createAudioSink();
      if (!state.audio) {
        toast("当前浏览器不支持 Web Audio，游戏将没有声音", 5000);
        return;
      }
      if (state.audio.ctx.state === "suspended") {
        // 浏览器自动播放策略：首次按键/点击时恢复（gesture 处理里已挂）
        toast("声音处于待激活状态：按任意游戏键即可开启声音", 4000);
      }
    }

    /**
     * 把本帧核心产出的 int16 立体声采样灌进音频接收器。
     * 核心 48kHz；若 ctx 不是 48kHz，按 ctx.sampleRate/48000 最近邻重采样。
     */
    function pumpAudio() {
      var m = state.fce, g = state.game;
      if (!m || !g || !state.audio) return;
      var n = m._fce_audio_drain(); // 采样个数（L/R 交错）
      if (!n) return;
      var p16 = m.HEAP16;
      var base = m._fce_audio_ptr() >> 1;
      var write = state.audio.write;
      var frames = n >> 1;
      var rate = state.audio.ctx.sampleRate;
      if (rate === CORE_RATE) {
        for (var i = 0; i < n; i += 2) {
          var l = p16[base + i] / 32768;
          var rr = p16[base + i + 1] / 32768;
          write((l + rr) * 0.5, (l + rr) * 0.5); // L/R 同相 → 下混单声道填充双声道
        }
        return;
      }
      // 最近邻重采样：out 帧 k ← src 帧 floor(k * srcRate/dstRate)
      var outFrames = Math.floor(frames * rate / CORE_RATE);
      var ratio = CORE_RATE / rate;
      for (var k = 0; k < outFrames; k++) {
        var s = Math.min(frames - 1, Math.floor(k * ratio));
        var l2 = p16[base + s * 2] / 32768;
        var r2 = p16[base + s * 2 + 1] / 32768;
        write((l2 + r2) * 0.5, (l2 + r2) * 0.5);
      }
    }

    function resumeAudioIfSuspended() {
      if (state.audio && !state.muted && state.audio.ctx.state === "suspended") {
        state.audio.resume();
      }
    }

    function stopFrameLoop() {
      if (state.rafId) { cancelAnimationFrame(state.rafId); state.rafId = null; }
    }

    function teardownGame() {
      unbindKeys();
      stopFpsMeter();
      stopFrameLoop();
      if (state.audio) {
        try { state.audio.destroy(); } catch (e) { /* ignore */ }
        state.audio = null;
      }
      flushSram();
      stopSramFlush();
      releaseAllButtons();
      if (state.game && state.game.resizeObs) {
        try { state.game.resizeObs.disconnect(); } catch (e) { /* ignore */ }
        state.game.resizeObs = null;
      }
      if (state.fce && state.game) {
        try {
          state.fce._fce_unload();
          if (state.game.romPtr) state.fce._free(state.game.romPtr);
          if (state.game.sramPtr) state.fce._free(state.game.sramPtr);
        } catch (e) { console.warn("[fc-emulator] unload 异常:", e); }
      }
      state.game = null;
      var host = state.root.querySelector("#fc-canvas-host");
      if (host) host.innerHTML = "";
      state.hasBattery = false;
      state.sramBytes = null;
      state.sramSize = 0;
      state.paused = false;
      state.crashed = false;
      state.heldButtons = [];
    }

    function setCrashed(msg) {
      state.crashed = true;
      var c = state.root.querySelector("#fc-crash");
      if (!c) return;
      c.querySelector(".fc-crash-msg").textContent = msg;
      c.hidden = false;
    }

    function clearCrashed() {
      state.crashed = false;
      var c = state.root.querySelector("#fc-crash");
      if (c) c.hidden = true;
    }

    // ── 自驱动帧循环 ──
    // fceumm 每调一次 fce_run 出一帧；用 rAF + 固定步长累加器维持 60fps
    // （掉帧时最多补 2 帧，避免螺旋死亡）。

    // 按容器尺寸把 256×240 画布等比缩放到最大（保 16:15 比例，填满游戏区）
    function fitCanvas() {
      var g = state.game;
      if (!g || !g.canvas) return;
      var host = state.root.querySelector("#fc-canvas-host");
      if (!host) return;
      var hw = host.clientWidth, hh = host.clientHeight;
      if (!hw || !hh) return;
      var scale = Math.min(hw / 256, hh / 240);
      g.canvas.style.width = Math.floor(256 * scale) + "px";
      g.canvas.style.height = Math.floor(240 * scale) + "px";
    }

    function blitFrame() {
      var m = state.fce, g = state.game;
      var w = m._fce_frame_width();
      var h = m._fce_frame_height();
      if (!w || !h) return;
      if (g.canvas.width !== w || g.canvas.height !== h) {
        g.canvas.width = w;
        g.canvas.height = h;
        g.imgData = g.ctx.createImageData(w, h);
      }
      if (!g.imgData) g.imgData = g.ctx.createImageData(w, h);
      var d = g.imgData.data;
      var pitch = m._fce_frame_pitch();
      var fmt = m._fce_pixel_format();
      var fp = m._fce_frame_ptr();
      var i = 0;
      if (fmt === PXFMT_XRGB8888) {
        // 小端 32 位：0x00RRGGBB → 内存 [B, G, R, X]
        // 注意：HEAP8 是有符号的（-128~127），>127 的字节为负值，
        // 直接赋给 Uint8ClampedArray 会被截断成 0 → 必须 & 255 转无符号。
        var H8 = m.HEAP8;
        for (var y = 0; y < h; y++) {
          var o = fp + y * pitch;
          for (var x = 0; x < w; x++, o += 4, i += 4) {
            d[i] = H8[o + 2] & 255;
            d[i + 1] = H8[o + 1] & 255;
            d[i + 2] = H8[o] & 255;
            d[i + 3] = 255;
          }
        }
      } else if (fmt === PXFMT_RGB565) {
        var H16 = m.HEAP16;
        for (var y2 = 0; y2 < h; y2++) {
          var o2 = (fp >> 1) + y2 * (pitch >> 1);
          for (var x2 = 0; x2 < w; x2++, o2++, i += 4) {
            var v = H16[o2] & 0xFFFF;
            d[i] = ((v >> 11) & 0x1F) << 3;
            d[i + 1] = ((v >> 5) & 0x3F) << 2;
            d[i + 2] = (v & 0x1F) << 3;
            d[i + 3] = 255;
          }
        }
      } else if (fmt === PXFMT_0RGB1555) {
        var H16b = m.HEAP16;
        for (var y3 = 0; y3 < h; y3++) {
          var o3 = (fp >> 1) + y3 * (pitch >> 1);
          for (var x3 = 0; x3 < w; x3++, o3++, i += 4) {
            var vb = H16b[o3] & 0xFFFF;
            d[i] = ((vb >> 10) & 0x1F) << 3;
            d[i + 1] = ((vb >> 5) & 0x1F) << 3;
            d[i + 2] = (vb & 0x1F) << 3;
            d[i + 3] = 255;
          }
        }
      } else {
        return; // 未知格式不渲染
      }
      g.ctx.putImageData(g.imgData, 0, 0);
    }

    function startFrameLoop() {
      stopFrameLoop();
      var last = performance.now();
      var acc = 0;
      function tick(now) {
        if (!state.game || state.paused) {
          // 暂停时保持 rAF 存活（恢复时无需重启），但不跑帧
          state.rafId = requestAnimationFrame(tick);
          last = now;
          return;
        }
        state.rafId = requestAnimationFrame(tick);
        var dt = now - last;
        last = now;
        if (dt > 100) dt = 100; // 后台切回等，截断防止爆发补帧
        acc += dt;
        // 固定步长 + 追赶：按累积时间推进，最多一次补 3 帧，保持实时速度。
        // 注意：不要用"每帧最多 1 帧 + acc 截断"的写法——那会丢掉累积的多余
        // 时间，在非 60 整倍数刷新率（如 144Hz）下游戏会变成慢动作（更卡）。
        var ran = 0;
        while (acc >= FRAME_MS && ran < 3) {
          state.fce._fce_run();
          acc -= FRAME_MS;
          ran++;
        }
        if (acc > FRAME_MS * 3) acc = 0; // 长期欠载 → 放弃追赶
        blitFrame();
        pumpAudio();
        state.game.fpsFrames++;
      }
      state.rafId = requestAnimationFrame(tick);
    }

    /**
     * 进入游戏：加载 fceumm 核心 → 取 ROM（含坏头修正）→ fce_load →
     * 建画布 → 恢复 SRAM/快照 → 启动自驱动帧循环。
     * @param {string} name - ROM 文件名。
     */
    function enterGame(name) {
      var gameView = state.root.querySelector("#fc-view-game");
      var libView = state.root.querySelector("#fc-view-lib");
      var host = state.root.querySelector("#fc-canvas-host");
      var loading = state.root.querySelector("#fc-loading");
      var choiceBar = state.root.querySelector("#fc-choice");

      state.romName = name;
      state.root.querySelector("#fc-rom-label").textContent = name;
      libView.hidden = true;
      gameView.hidden = false;
      host.innerHTML = "";
      clearCrashed();
      choiceBar.hidden = true;
      loading.hidden = false;
      state.root.querySelector("#fc-loading-text").textContent = "正在加载游戏…";
      state.root.querySelector("#fc-btn-pause").textContent = "⏸ 暂停";

      var coreCtx = null; // { m, romPtr } — 供 catch 统一释放
      loadCore().then(function (m) {
        return api("/roms/" + encodeURIComponent(name)).then(function (res) {
          return res.arrayBuffer();
        }).then(function (romBuf) {
          var rom = new Uint8Array(romBuf);
          if (rom.length > 16 && rom[0] === 0x4e && rom[1] === 0x45 &&
              rom[2] === 0x53 && rom[3] === 0x1a) {
            rom = fixRomHeader(name, rom);
          }
          if (rom.length < 16) throw new Error("ROM 数据不完整");
          // 拷入 wasm 堆
          var romPtr = m._malloc(rom.length);
          m.HEAP8.set(rom, romPtr);
          coreCtx = { m: m, romPtr: romPtr, romSize: rom.length };
          return coreCtx;
        });
      }).then(function (c) {
        host.innerHTML = "";
        var m = c.m;

        if (!m._fce_bootstrap()) {
          throw new Error("fceumm 核心初始化失败");
        }
        if (!m._fce_load(c.romPtr, c.romSize)) {
          m._free(c.romPtr);
          coreCtx = null; // romPtr 已释放
          throw new Error("ROM 加载失败（芯片不支持或 ROM 头损坏）");
        }

        // 画布（256×240，按容器等比缩放填满，像素化）
        var canvas = document.createElement("canvas");
        canvas.width = 256;
        canvas.height = 240;
        canvas.style.imageRendering = "pixelated";
        canvas.style.display = "block";
        host.appendChild(canvas);
        var ctx = canvas.getContext("2d");
        state.game = {
          canvas: canvas,
          ctx: ctx,
          imgData: null,
          romPtr: c.romPtr,
          romSize: c.romSize,   // resetGame 重新 fce_load 需要 ROM 大小
          sramPtr: m._malloc(SRM_SIZE),
          fpsFrames: 0
        };
        // 画布适配（必须在 state.game 赋值之后）
        fitCanvas(); // 初始适配
        requestAnimationFrame(fitCanvas); // 布局稳定后再适配一次
        // 容器尺寸变化时重算画布（窗口缩放 / 布局变化）
        if (typeof ResizeObserver !== "undefined") {
          state.game.resizeObs = new ResizeObserver(function () { fitCanvas(); });
          state.game.resizeObs.observe(host);
        }
        coreCtx = null; // 指针所有权移交给 state.game（避免 catch 双重释放）
        // SRAM 大小（无电池游戏 = 0）
        state.game.sramSize = m._fce_sram_read(state.game.sramPtr);
        state.hasBattery = state.game.sramSize > 0;
        state.sramSize = state.game.sramSize;

        // 电池 SRAM（游戏内存档）
        if (state.hasBattery) {
          api("/srm/" + encodeURIComponent(name)).then(function (res) {
            return res.arrayBuffer();
          }).then(function (buf) {
            if (!state.game || state.romName !== name) return;
            var sram = new Uint8Array(buf);
            state.sramBytes = sram;
            var sp = m._malloc(sram.length);
            m.HEAP8.set(sram, sp);
            m._fce_sram_write(sp, sram.length);
            m._free(sp);
          }).catch(function () { /* 无存档，全新开始 */ });
        }

        loading.hidden = true;
        startAudio();
        startFrameLoop();
        startFpsMeter();
        startSramFlush();
        bindKeys();
        applyMute();

        // 整局快照 → 继续 / 新开
        api("/savestates/" + encodeURIComponent(name)).then(function (res) {
          return res.json();
        }).then(function (doc) {
          if (!state.game || state.romName !== name) return;
          var env = doc && doc.data;
          if (env && (env.core === "fceumm" || (env.state && env.state.cpu))) {
            choiceBar.querySelector(".fc-choice-text").textContent =
              "发现存档（" + new Date(env.savedAt || Date.now()).toLocaleString("zh-CN") + "）" +
              (env.core === "jsnes" ? " · 旧核心存档不可读" : "");
            choiceBar.hidden = false;
          }
        }).catch(function () { /* 无快照 */ });
      }).catch(function (e) {
        // 加载失败：清理已分配资源（coreCtx = 游戏尚未接管时的指针；
        // state.game = 已接管，由它负责释放）
        try {
          if (state.fce && coreCtx) {
            state.fce._free(coreCtx.romPtr);
          }
          if (state.game) {
            if (state.game.romPtr) state.fce._free(state.game.romPtr);
            if (state.game.sramPtr) state.fce._free(state.game.sramPtr);
          }
        } catch (e2) { /* ignore */ }
        coreCtx = null;
        state.game = null;
        loading.hidden = true;
        setCrashed(e.message || String(e));
      });
    }

    function exitGame() {
      if (!state.game) return;
      // 退出前自动存档（整局快照 + SRAM）
      saveSnapshot().catch(function () { /* ignore */ });
      teardownGame();
      state.romName = null;
      state.root.querySelector("#fc-rom-label").textContent = "";
      state.root.querySelector("#fc-view-game").hidden = true;
      state.root.querySelector("#fc-view-lib").hidden = false;
      refreshRoms();
    }

    function togglePause() {
      if (!state.game) return;
      if (state.paused) {
        state.paused = false;
        state.root.querySelector("#fc-btn-pause").textContent = "⏸ 暂停";
        applyMute();
      } else {
        state.paused = true;
        state.root.querySelector("#fc-btn-pause").textContent = "▶ 继续";
        releaseAllButtons();
        if (state.audio) {
          try { state.audio.suspend(); } catch (e) { /* ignore */ }
        }
      }
    }

    function resetGame() {
      if (!state.game) return;
      try {
        var m = state.fce, g = state.game;
        m._fce_unload();
        if (!m._fce_load(g.romPtr, g.romSize)) {
          throw new Error("ROM 重新加载失败");
        }
        g.sramSize = m._fce_sram_read(g.sramPtr);
        clearCrashed();
        // 重置后重新注入已持久化的 SRAM（电池 RAM 不过电不丢，符合真实硬件）
        if (state.hasBattery && state.sramBytes) {
          var sp = m._malloc(state.sramBytes.length);
          m.HEAP8.set(state.sramBytes, sp);
          m._fce_sram_write(sp, state.sramBytes.length);
          m._free(sp);
        }
        toast("已重置");
      } catch (e) {
        setCrashed("重置失败：" + (e && e.message ? e.message : e));
      }
    }

    function applyMute() {
      if (!state.audio) return;
      try {
        if (state.muted) state.audio.suspend();
        else state.audio.resume();
      } catch (e) { /* ignore */ }
    }

    function toggleMute() {
      state.muted = !state.muted;
      state.root.querySelector("#fc-btn-mute").textContent = state.muted ? "🔇 取消静音" : "🔊 静音";
      applyMute();
    }

    function screenshot() {
      if (!state.game) return;
      try {
        var a = document.createElement("a");
        a.href = state.game.canvas.toDataURL("image/png");
        a.download = (state.romName || "fc") + "-" + Date.now() + ".png";
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        toast("截图已保存");
      } catch (e) {
        toast("截图失败：" + e.message);
      }
    }

    // ─────────────────────────── 改键面板 ───────────────────────────

    function openKeysView() {
      if (!state.root) return;
      endKeyCapture();
      // 记录返回视图
      var libView = state.root.querySelector("#fc-view-lib");
      var gameView = state.root.querySelector("#fc-view-game");
      state.keysViewReturn = (!gameView.hidden && state.game) ? "game" : "lib";
      libView.hidden = true;
      gameView.hidden = true;
      var keysView = state.root.querySelector("#fc-view-keys");
      keysView.hidden = false;
      state.keysViewOpen = true;
      buildKeysView();
    }

    function closeKeysView() {
      if (!state.keysViewOpen) return;
      endKeyCapture();
      state.keysViewOpen = false;
      state.root.querySelector("#fc-view-keys").hidden = true;
      if (state.keysViewReturn === "game" && state.game) {
        state.root.querySelector("#fc-view-game").hidden = false;
      } else {
        state.root.querySelector("#fc-view-lib").hidden = false;
        refreshRoms();
      }
    }

    // 构建/刷新改键面板的行（每次打开、或改键后刷新）
    function buildKeysView() {
      var list = state.root.querySelector("#fc-keys-list");
      if (!list) return;
      list.innerHTML = "";
      for (var i = 0; i < BTN_META.length; i++) {
        var meta = BTN_META[i];
        var codes = state.keymap[meta.id];
        var row = el("div", { class: "fc-key-row" }, [
          el("span", { class: "fc-key-name", text: meta.name }),
          el("button", {
            class: "fc-key-slot",
            "data-btn": String(meta.id), "data-slot": "0",
            title: "点击改键",
            on: { click: function () { startKeyCapture(meta.id, 0); } }
          }, codeLabel(codes[0]) || "—"),
          el("button", {
            class: "fc-key-slot",
            "data-btn": String(meta.id), "data-slot": "1",
            title: "点击改键 / 清空",
            on: { click: function () { startKeyCapture(meta.id, 1); } }
          }, codeLabel(codes[1]) || "＋")
        ]);
        list.appendChild(row);
      }
    }

    function findSlotEl(btnId, slotIdx) {
      return state.root.querySelector(
        '#fc-keys-list .fc-key-slot[data-btn="' + btnId + '"][data-slot="' + slotIdx + '"]');
    }

    function startKeyCapture(btnId, slotIdx) {
      endKeyCapture();
      state.capturing = { btnId: btnId, slotIdx: slotIdx };
      var slot = findSlotEl(btnId, slotIdx);
      if (slot) {
        slot.classList.add("fc-capturing");
        slot.textContent = "按任意键…";
      }
      var handler = function (e) {
        e.preventDefault();
        e.stopPropagation();
        // Esc / 退格 / 删除 = 清空该槽
        if (e.code === "Escape" || e.code === "Backspace" || e.code === "Delete") {
          state.keymap[btnId][slotIdx] = null;
          cleanKeymapSlots();
          saveKeymap();
          rebuildCodeMap();
          buildKeysView();
          endKeyCapture();
          return;
        }
        setSlotKey(btnId, slotIdx, e.code);
        endKeyCapture();
      };
      document.addEventListener("keydown", handler, true);
      state._captureHandler = handler;
    }

    function endKeyCapture() {
      if (state._captureHandler) {
        document.removeEventListener("keydown", state._captureHandler, true);
        state._captureHandler = null;
      }
      var cap = state.capturing;
      if (cap) {
        var slot = findSlotEl(cap.btnId, cap.slotIdx);
        if (slot) slot.classList.remove("fc-capturing");
      }
      state.capturing = null;
    }

    // 把 code 写入 (btnId, slotIdx)；若该 code 已被别的槽占用，先从别处移除。
    function setSlotKey(btnId, slotIdx, code) {
      for (var i = 0; i < BTN_META.length; i++) {
        var id = BTN_META[i].id;
        var codes = state.keymap[id];
        for (var s = 0; s < codes.length; s++) {
          if (codes[s] === code && !(id === btnId && s === slotIdx)) {
            codes[s] = null;
          }
        }
      }
      state.keymap[btnId][slotIdx] = code;
      cleanKeymapSlots();
      saveKeymap();
      rebuildCodeMap();
      buildKeysView();
      toast("已设置：" + BTN_META[btnId].name + " = " + codeLabel(code));
    }

    // 同按钮两个槽不允许重复（重复时保留先出现的）
    function cleanKeymapSlots() {
      for (var i = 0; i < BTN_META.length; i++) {
        var codes = state.keymap[BTN_META[i].id];
        if (codes[0] && codes[1] === codes[0]) codes[1] = null;
      }
    }

    function resetKeymap() {
      state.keymap = cloneKeymap(DEFAULT_KEYMAP);
      saveKeymap();
      rebuildCodeMap();
      buildKeysView();
      toast("键位已恢复默认");
    }

    // ─────────────────────────── virtual pad ───────────────────────────

    function makePadButton(label, cls, btnId, dir) {
      var b = el("button", { class: "fc-dbtn" + (cls ? " " + cls : ""), "data-btn": String(btnId), text: label });
      b.addEventListener("pointerdown", function (e) {
        e.preventDefault();
        resumeAudioIfSuspended(); // 触屏首次手势恢复音频
        if (typeof b.setPointerCapture === "function") {
          try { b.setPointerCapture(e.pointerId); } catch (err) { /* 个别旧浏览器不支持 */ }
        }
        b.classList.add("fc-held");
        pressBtn(btnId);
      });
      var up = function () {
        b.classList.remove("fc-held");
        releaseBtn(btnId);
      };
      b.addEventListener("pointerup", up);
      b.addEventListener("pointercancel", up);
      b.addEventListener("lostpointercapture", up);
      b.addEventListener("contextmenu", function (e) { e.preventDefault(); });
      return b;
    }

    function buildPad(root) {
      var pad = el("div", { id: "fc-pad" });
      var dpad = el("div", { class: "fc-dpad" }, [
        el("span"),
        makePadButton("▲", "", BTN.UP),
        el("span"),
        makePadButton("◀", "", BTN.LEFT),
        el("span", { style: { background: "transparent", border: "none" } }),
        makePadButton("▶", "", BTN.RIGHT),
        el("span"),
        makePadButton("▼", "", BTN.DOWN),
        el("span")
      ]);
      var selBtn = makePadButton("SELECT", "fc-sel", BTN.SELECT);
      selBtn.style.width = "72px";
      selBtn.style.height = "38px";
      selBtn.style.borderRadius = "8px";
      var startBtn = makePadButton("START", "fc-sel", BTN.START);
      startBtn.style.width = "72px";
      startBtn.style.height = "38px";
      startBtn.style.borderRadius = "8px";
      var sysGroup = el("div", { class: "fc-pad-group" }, [selBtn, startBtn]);
      var aBtn = makePadButton("A", "fc-a", BTN.A);
      var bBtn = makePadButton("B", "fc-b", BTN.B);
      var abGroup = el("div", { class: "fc-abad" }, [bBtn, aBtn]);
      pad.appendChild(dpad);
      pad.appendChild(sysGroup);
      pad.appendChild(abGroup);
      root.appendChild(pad);
    }

    // ─────────────────────────── UI construction ───────────────────────────

    function buildUi() {
      // 清理旧实例（HMR 重载安全）
      var old = document.getElementById("fc-emulator-root");
      if (old) old.remove();

      var root = el("div", { id: "fc-emulator-root" });
      state.root = root;

      var style = el("style", { text: CSS });
      root.appendChild(style);
      root.appendChild(el("div", { id: "fc-toast" }));

      // 悬浮球
      var ball = el("button", {
        id: "fc-ball", title: "FC",
        on: { click: function () { openModal(); } }
      }, [
        el("span", { class: "fc-ball-label", text: "FC" })
      ]);
      state.ball = ball;
      root.appendChild(ball);

      // 游戏厅 modal
      var modal = el("div", { id: "fc-modal", hidden: true });
      state.modal = modal;

      var windowEl = el("div", { id: "fc-window" }, [
        el("div", { id: "fc-header" }, [
          el("div", { class: "fc-title", html: "<b>FC</b>" }),
          el("div", { class: "fc-sub", text: "fceumm · 红白机模拟器（589 芯片）" }),
          el("div", { id: "fc-rom-label", class: "fc-rom-label", text: "" }),
          el("button", {
            id: "fc-close", title: "关闭",
            on: { click: function () { closeModal(); } }
          }, "✕")
        ]),

        el("div", { id: "fc-body" }, [
          // 库视图
          el("div", { id: "fc-view-lib", class: "fc-view" }, [
            el("div", { id: "fc-lib-tabs" }, [
              el("button", {
                id: "fc-tab-local", class: "fc-tab fc-tab-on",
                on: { click: function () { switchLibTab("local"); } }
              }, "本地游戏库"),
              el("button", {
                id: "fc-tab-online", class: "fc-tab",
                on: { click: function () { switchLibTab("online"); } }
              }, "在线游戏库")
            ]),
            el("div", { id: "fc-panel-local" }, [
              el("div", { id: "fc-lib-toolbar" }, [
                el("button", {
                  class: "fc-btn", text: "⟳ 刷新",
                  on: { click: refreshRoms }
                }),
                el("button", {
                  class: "fc-btn", text: "⚙ 键位", title: "自定义按键",
                  on: { click: openKeysView }
                }),
                el("label", {
                  id: "fc-upload-btn", class: "fc-btn primary",
                  on: {
                    click: function () {
                      var input = document.getElementById("fc-upload-input");
                      if (input) input.click();
                    }
                  }
                }, "⬆ 上传 ROM"),
                el("input", {
                  id: "fc-upload-input", type: "file", accept: ".nes", hidden: true,
                  on: {
                    change: function (e) {
                      var f = e.target.files && e.target.files[0];
                      if (f) uploadRom(f);
                      e.target.value = "";
                    }
                  }
                }),
                el("span", { class: "fc-hint", text: "仅支持 .nes（iNES）· 请只使用自己拥有版权的卡带镜像" })
              ]),
              el("div", { id: "fc-rom-list" })
            ]),
            el("div", { id: "fc-panel-online", hidden: true }, [
              el("div", { id: "fc-online-repo-row" }, [
                el("span", { class: "fc-online-repo-label", text: "游戏源仓库" }),
                el("input", {
                  id: "fc-online-repo", type: "text",
                  value: state.onlineRepo,
                  placeholder: "owner/repo 或 …/tree/master/roms",
                  title: "支持根仓库（如 owner/repo）或带目录的地址（如 …/tree/master/roms）。改动后回车或点「刷新清单」生效，地址写入 localStorage。可先在 GitHub 搜索：nes游戏合集",
                  on: {
                    change: function (e) {
                      var v = e.target.value.trim();
                      if (v !== state.onlineRepo) {
                        state.onlineRepo = v;
                        saveOnlineRepo();
                        state.onlineRoms = null;
                        loadOnlineRoms(true);
                      }
                    },
                    keydown: function (e) { if (e.key === "Enter") e.target.blur(); }
                  }
                })
              ]),
              el("div", { id: "fc-online-status", text: "尚未加载在线清单" }),
              el("div", { id: "fc-online-toolbar" }, [
                el("input", {
                  id: "fc-online-search", type: "text",
                  placeholder: "搜索游戏名…（如：超级玛丽）",
                  on: {
                    input: function (e) {
                      state.onlineQuery = e.target.value;
                      renderOnlineList();
                    }
                  }
                }),
                el("button", {
                  class: "fc-btn", text: "⟳ 刷新清单",
                  on: { click: function () { loadOnlineRoms(true); } }
                })
              ]),
              el("div", { id: "fc-online-list" })
            ])
          ]),

          // 游戏视图
          el("div", { id: "fc-view-game", class: "fc-view", hidden: true }, [
            el("div", { id: "fc-canvas-host" }),
            el("div", { id: "fc-loading" }, [
              el("span", { class: "fc-spin" }),
              el("span", { id: "fc-loading-text", text: "正在加载游戏…" })
            ]),
            el("div", { id: "fc-crash", hidden: true }, [
              el("div", { class: "fc-crash-msg", text: "" }),
              el("div", { class: "fc-crash-btns", style: { display: "flex", gap: "10px" } }, [
                el("button", {
                  class: "fc-btn primary", text: "重置游戏",
                  on: { click: resetGame }
                }),
                el("button", {
                  class: "fc-btn", text: "← 返回",
                  on: {
                    click: function () {
                      clearCrashed();
                      teardownGame();
                      state.romName = null;
                      state.root.querySelector("#fc-rom-label").textContent = "";
                      state.root.querySelector("#fc-view-game").hidden = true;
                      state.root.querySelector("#fc-view-lib").hidden = false;
                      refreshRoms();
                    }
                  }
                })
              ])
            ]),
            el("div", { id: "fc-choice", hidden: true }, [
              el("span", { class: "fc-choice-text", text: "发现存档" }),
              el("button", {
                class: "fc-btn primary", text: "▶ 继续上次",
                on: { click: function () {
                  var bar = document.getElementById("fc-choice");
                  bar.hidden = true;
                  // 快照恢复（fceumm 二进制；旧 jsnes 存档会提示不兼容）
                  api("/savestates/" + sramKey()).then(function (res) { return res.json(); }).then(function (doc) {
                    if (state.game && doc && doc.data) {
                      restoreSnapshot(doc.data);
                      toast("已读档");
                    }
                  }).catch(function (e) { toast("读档失败：" + e.message); });
                } }
              }),
              el("button", {
                class: "fc-btn", text: "重新开局",
                on: { click: function () { document.getElementById("fc-choice").hidden = true; } }
              })
            ]),
            el("div", { id: "fc-game-bar" }, [
              el("button", {
                id: "fc-btn-pause", class: "fc-btn", text: "⏸ 暂停",
                on: { click: togglePause }
              }),
              el("button", {
                class: "fc-btn", text: "↺ 重置",
                on: { click: resetGame }
              }),
              el("button", {
                class: "fc-btn", text: "💾 保存",
                on: { click: function () {
                  saveSnapshot().then(function () { toast("已保存"); }).catch(function (e) { toast("保存失败：" + e.message); });
                } }
              }),
              el("button", {
                class: "fc-btn", text: "📷 截图",
                on: { click: screenshot }
              }),
              el("button", {
                id: "fc-btn-mute", class: "fc-btn", text: "🔊 静音",
                on: { click: toggleMute }
              }),
              el("button", {
                class: "fc-btn", text: "⚙ 键位", title: "自定义按键（快速隐藏 / 快速存读档也可改）",
                on: { click: openKeysView }
              }),
              el("button", {
                class: "fc-btn danger", text: "✕ 返回",
                on: { click: exitGame }
              }),
              el("span", { id: "fc-fps", class: "fc-fps", text: "" }),
              el("span", { id: "fc-diag", class: "fc-fps", text: "core:…", style: { opacity: ".45", fontSize: "10px" } }),
              el("span", { id: "fc-keydiag", class: "fc-fps", text: "key:—", style: { opacity: ".6", fontSize: "10px", color: "#7fd4ff" } })
            ])
          ]),

          // 改键面板视图
          el("div", { id: "fc-view-keys", class: "fc-view", hidden: true }, [
            el("div", { id: "fc-keys-toolbar" }, [
              el("span", { class: "fc-keys-title", text: "⚙ 键位设置" }),
              el("span", { class: "fc-keys-hint", text: "点击键位格 → 按新键；按 退格/删除 清空该格" }),
              el("button", { class: "fc-btn", text: "恢复默认", on: { click: resetKeymap } }),
              el("button", { class: "fc-btn primary", text: "完成", on: { click: closeKeysView } })
            ]),
            el("div", { id: "fc-keys-list" })
          ])
        ]),

        el("div", {
          id: "fc-footer",
          text: "键位可自定义（游戏控制条「⚙ 键位」）· 默认：WASD/方向键 移动 · J=B · K=A · I/U 连击 · 1=START · 5=SELECT · ` 快速隐藏 · [ 快存 · ] 快读 · ESC 关闭"
        })
      ]);

      modal.appendChild(el("div", { class: "fc-backdrop", on: { click: function () { closeModal(); } } }));
      modal.appendChild(windowEl);
      root.appendChild(modal);

      buildPad(windowEl.querySelector("#fc-view-game"));

      // ESC 关闭（键位面板打开时先返回，不直接退游戏）
      var escHandler = function (e) {
        if (e.code === "Escape" && !state.modal.hidden) {
          e.preventDefault();
          if (state.keysViewOpen) {
            closeKeysView();
          } else if (!state.root.querySelector("#fc-view-game").hidden) {
            exitGame();
          } else {
            closeModal();
          }
        }
      };
      document.addEventListener("keydown", escHandler);
      state._escHandler = escHandler;

      // 快速隐藏 / 快速存读档（常驻，隐藏状态下也能唤回）
      bindSpecialKeys();

      document.body.appendChild(root);
    }

    function openModal() {
      if (state.keysViewOpen) closeKeysView(); // 先收起键位面板
      state.modal.hidden = false;
      if (state.game) {
        // 游戏进行中（可能处于快速隐藏状态）→ 恢复游戏并继续
        state.root.querySelector("#fc-view-game").hidden = false;
        state.root.querySelector("#fc-view-lib").hidden = true;
        if (state.paused) togglePause();
      } else {
        state.root.querySelector("#fc-view-game").hidden = true;
        state.root.querySelector("#fc-view-lib").hidden = false;
        refreshRoms();
      }
      state.ball.blur();
    }

    function closeModal() {
      if (!state.modal.hidden) {
        // 游戏中 → 先保存退出
        if (!state.root.querySelector("#fc-view-game").hidden && state.game) {
          exitGame();
        }
      }
      state.modal.hidden = true;
      if (state.resizeObs) { state.resizeObs.disconnect(); state.resizeObs = null; }
    }

    // ─────────────────────────── plugin entry ───────────────────────────

    var name = NAME;
    var inject = [];

    function init() {
      if (document.getElementById("fc-emulator-root")) return;
      buildUi();
    }

    /**
     * Client plugin entry.
     * @param {object} _ctx - cordis client context（本插件纯 DOM 实现，不使用服务）。
     * @returns {Function} disposer — HMR 重载/卸载时回收全部 DOM 与运行状态。
     */
    function apply(_ctx) {
      if (typeof document === "undefined") return function () {};
      if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init, { once: true });
      } else {
        init();
      }
      return function () {
        if (state.fpsTimer) clearInterval(state.fpsTimer);
        if (state.sramTimer) clearInterval(state.sramTimer);
        stopFrameLoop();
        unbindKeys();
        unbindSpecialKeys();
        endKeyCapture();
        if (state._escHandler) document.removeEventListener("keydown", state._escHandler);
        if (state.game) {
          teardownGame();
        }
        if (state.root) state.root.remove();
        state.root = null;
      };
    }

    exports.name = name;
    exports.inject = inject;
    exports.apply = apply;
    exports.default = { name: name, inject: inject, apply: apply };
    return module.exports;
  }
});
