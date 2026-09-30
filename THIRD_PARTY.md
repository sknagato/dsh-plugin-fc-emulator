# 第三方组件

## fceumm（libretro 核心，当前运行核心）

- 来源：https://github.com/libretro/libretro-fceumm
- 许可：**GPL-2.0**（copyleft）
- 集成文件：`core-fce/fceumm.js`（UMD 胶水，`createFceModule`，约 63KB）+ `core-fce/fceumm.wasm`（约 795KB）
- 构建：emsdk 6.0.10 `-sMODULARIZE=1 -sEXPORT_NAME=createFceModule`（UMD，浏览器挂 `window.createFceModule`），
  附 `core-fce/fceumm-bridge.c`（EMSCRIPTEN_KEEPALIVE 封装：视频/音频环形缓冲、输入、序列化、SRAM 读写）
  与 `core-fce/fceumm-core.patch`（修复上游 `retro_load_game` 经典路径未取 `info->data/size` 的缺陷）
- 用途：NES/红白机模拟核心（CPU 6502、PPU、2A03/2C02 音频、**589 种 mapper**，含 CN/VRC 等国产芯片）
- 说明：GPL-2.0 为 copyleft，内部自部署、不分发时不触发开源义务；若未来对外分发本插件，
  需按 GPL-2.0 提供完整对应源码（见 README「许可与合规」）。


