/*
 * fceumm-bridge.c — 薄桥接层（libretro 1.0 API）
 *
 * 本文件扮演 libretro "前端"，fceumm 核心扮演"核心"：
 *  - 前端注册 environment/video/audio/input 回调
 *  - 每帧调 retro_run()，核心内部回调前端
 *  - 帧/音频数据拷贝进 wasm 堆固定缓冲，JS 侧读取
 *  - SRAM 经 retro_get_memory_data(RETRO_MEMORY_SAVE_RAM)
 *  - 整局快照经 retro_serialize/retro_unserialize
 */
#include <emscripten.h>
#include <stdio.h>
#include <stdarg.h>
#include <stdlib.h>
#include <string.h>
#include <stdbool.h>
#include <stdint.h>

#include <libretro.h>

/* ── 前端状态 ── */
static int16_t g_input[4][16];           /* port × JOYPAD 16 键 */
static enum retro_pixel_format g_pixel_format = RETRO_PIXEL_FORMAT_UNKNOWN;

#define FRAME_MAX (320 * 240)
static uint8_t  g_frame[FRAME_MAX * 4];  /* 最大 320×240 32bpp */
static unsigned g_frame_w = 256, g_frame_h = 240;
static size_t   g_frame_pitch = 256 * 4;

#define AUDIO_CAP (44100 * 2 * 4)        /* 4 秒立体声 16bit */
static int16_t g_audio[AUDIO_CAP];
static size_t  g_audio_count = 0;

static void log_cb(enum retro_log_level level, const char *fmt, ...)
{
   char buf[1024];
   va_list ap;
   va_start(ap, fmt);
   vsnprintf(buf, sizeof(buf), fmt, ap);
   va_end(ap);
   fprintf(stderr, "[fceumm] %s", buf);
}

static bool environment_cb(unsigned cmd, void *data)
{
   switch (cmd) {
   case RETRO_ENVIRONMENT_GET_LOG_INTERFACE: {
      struct retro_log_callback *lc = (struct retro_log_callback *)data;
      lc->log = log_cb;
      return true;
   }
   case RETRO_ENVIRONMENT_SET_PIXEL_FORMAT:
      g_pixel_format = *(enum retro_pixel_format *)data;
      return true;
   case RETRO_ENVIRONMENT_SET_SYSTEM_AV_INFO:
   case RETRO_ENVIRONMENT_SET_GEOMETRY:
   case RETRO_ENVIRONMENT_SET_ROTATION:
   case RETRO_ENVIRONMENT_SET_MESSAGE:
   case RETRO_ENVIRONMENT_SET_CONTROLLER_INFO:
   case RETRO_ENVIRONMENT_SHUTDOWN:
      return true;
   default:
      /* GET_LOG_INTERFACE / GET_CORE_OPTIONS* / GET_SAVE_DIRECTORY /
       * GET_PERF_INTERFACE / VFS 等一律"不支持" → 核心回退默认行为 */
      return false;
   }
}

static void video_cb(const void *data, unsigned width, unsigned height, size_t pitch)
{
   const uint8_t *src = (const uint8_t *)data;
   size_t copy_pitch;

   if (width > 320 || height > 240 || pitch < width)
      return;
   copy_pitch = width * 4;         /* 输出统一 32bpp 行距（RGB565 也 ≤4 字节/像素） */
   if (pitch < copy_pitch)
      copy_pitch = pitch;
   g_frame_w = width;
   g_frame_h = height;
   g_frame_pitch = copy_pitch;
   for (unsigned y = 0; y < height; y++)
      memcpy(g_frame + (size_t)y * copy_pitch, src + (size_t)y * pitch, copy_pitch);
}

static size_t audio_batch_cb(const int16_t *data, size_t frames)
{
   size_t n = frames * 2;          /* 交错 L,R */
   if (g_audio_count + n > AUDIO_CAP)
      n = (g_audio_count < AUDIO_CAP) ? AUDIO_CAP - g_audio_count : 0;
   memcpy(&g_audio[g_audio_count], data, n * sizeof(int16_t));
   g_audio_count += n;
   return n / 2;                   /* 返回已消费的帧数 */
}

static void poll_cb(void) { }

static int16_t input_cb(unsigned port, unsigned device, unsigned index, unsigned id)
{
   if (device != RETRO_DEVICE_JOYPAD || port >= 4)
      return 0;
   /* 本 fceumm 的 libretro.h 是非标准 id：B=0, A=8, SELECT=2, START=3,
      UP/DOWN/LEFT/RIGHT=4..7, L3=14。核心按 id 逐键查询（非位掩码）。
      位掩码模式（id=JOYPAD_MASK=256）也一并支持。 */
   if (id == RETRO_DEVICE_ID_JOYPAD_MASK)
   {
      int16_t mask = 0;
      for (int i = 0; i < 16; i++)
         if (g_input[port][i]) mask |= (int16_t)(1 << i);
      return mask;
   }
   if (id < 16)
      return g_input[port][id];
   return 0;
}

/* ── 导出 API（JS 侧调用）── */

EMSCRIPTEN_KEEPALIVE int fce_bootstrap(void)
{
   retro_set_environment(environment_cb);
   retro_set_video_refresh(video_cb);
   retro_set_audio_sample_batch(audio_batch_cb);
   retro_set_input_poll(poll_cb);
   retro_set_input_state(input_cb);
   retro_init();
   return 1;
}

EMSCRIPTEN_KEEPALIVE int fce_load(const uint8_t *rom, size_t size)
{
   struct retro_game_info gi;
   memset(&gi, 0, sizeof(gi));
   gi.path = "game.nes";
   gi.data = rom;
   gi.size = size;
   return retro_load_game(&gi) ? 1 : 0;
}

EMSCRIPTEN_KEEPALIVE void fce_run(void)   { retro_run(); }
EMSCRIPTEN_KEEPALIVE void fce_reset(void) { retro_reset(); }
EMSCRIPTEN_KEEPALIVE void fce_unload(void) { retro_unload_game(); }

EMSCRIPTEN_KEEPALIVE size_t fce_serialize_size(void) { return retro_serialize_size(); }
EMSCRIPTEN_KEEPALIVE int fce_serialize(uint8_t *out, size_t len) { return retro_serialize(out, len) ? 1 : 0; }
EMSCRIPTEN_KEEPALIVE int fce_unserialize(const uint8_t *in, size_t len) { return retro_unserialize(in, len) ? 1 : 0; }

EMSCRIPTEN_KEEPALIVE size_t fce_sram_read(uint8_t *out)
{
   void *sram = retro_get_memory_data(RETRO_MEMORY_SAVE_RAM);
   size_t sz = retro_get_memory_size(RETRO_MEMORY_SAVE_RAM);
   if (!sram || !sz)
      return 0;
   memcpy(out, sram, sz);
   return sz;
}

EMSCRIPTEN_KEEPALIVE int fce_sram_write(const uint8_t *data, size_t size)
{
   void *sram = retro_get_memory_data(RETRO_MEMORY_SAVE_RAM);
   size_t sz = retro_get_memory_size(RETRO_MEMORY_SAVE_RAM);
   if (!sram || !sz)
      return -1;
   if (size > sz)
      size = sz;
   memcpy(sram, data, size);
   return (int)size;
}

EMSCRIPTEN_KEEPALIVE void fce_set_input(unsigned port, unsigned index, int pressed)
{
   if (port < 4 && index < 16)
      g_input[port][index] = pressed ? 1 : 0;
}

/* 调试：核心解码出的 mapper 号（iNESCart 是 ines.c 全局量） */
#include <fceu.h>
#include <cart.h>
extern CartInfo iNESCart;
EMSCRIPTEN_KEEPALIVE int fce_debug_mapper(void) { return (int)iNESCart.mapper; }
EMSCRIPTEN_KEEPALIVE int fce_debug_mirroring(void) { return (int)iNESCart.mirror; }

/* 帧 / 音频 / 格式查询 */
EMSCRIPTEN_KEEPALIVE uint8_t *fce_frame_ptr(void)    { return g_frame; }
EMSCRIPTEN_KEEPALIVE unsigned fce_frame_width(void)  { return g_frame_w; }
EMSCRIPTEN_KEEPALIVE unsigned fce_frame_height(void) { return g_frame_h; }
EMSCRIPTEN_KEEPALIVE size_t   fce_frame_pitch(void)   { return g_frame_pitch; }
EMSCRIPTEN_KEEPALIVE unsigned fce_pixel_format(void)  { return (unsigned)g_pixel_format; }
EMSCRIPTEN_KEEPALIVE size_t   fce_audio_drain(void)   { size_t c = g_audio_count; g_audio_count = 0; return c; }
EMSCRIPTEN_KEEPALIVE int16_t *fce_audio_ptr(void)     { return g_audio; }
