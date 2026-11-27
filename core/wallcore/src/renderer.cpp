// renderer.cpp - desktop wallpaper renderer.
//
// Architecture (rewritten 2026-11-22): we own the D3D11 device + FLIP_DISCARD
// swap chain; libmpv is demoted to a pure DECODER via the render API (vo=libmpv).
// Each frame: mpv renders into our intermediate texture -> one fullscreen quad
// composites it to the swap-chain back buffer -> Present. This is the same
// pipeline Wallpaper Engine / Lively use, and avoids the huge GPU overhead of
// the old `vo=gpu + wid` approach where a full media player owned its own
// swap chain and window composition on top of the desktop.
//
// Kept from the old renderer: WorkerW attach, plain child window + click-through,
// hide/show (desktop-layer handover), 2s anti-WE Z-order watchdog, stop/reload.

#ifndef NOMINMAX
#define NOMINMAX
#endif
#include "renderer.h"

#include <windows.h>
#include <d3d11.h>
#include <dxgi1_2.h>
#include <d3dcompiler.h>
#include <mpv/client.h>
#include <mpv/render.h>
#include <mpv/render_d3d11.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cstdarg>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <mutex>
#include <string>

// ---------- logging ----------
static void logf(const char* fmt, ...) {
    char buf[1024];
    va_list ap;
    va_start(ap, fmt);
    _vsnprintf_s(buf, sizeof(buf), _TRUNCATE, fmt, ap);
    va_end(ap);
    std::fputs("[wallcore] ", stderr);
    std::fputs(buf, stderr);
    std::fputc('\n', stderr);
    std::fflush(stderr);
}

// ---------- state ----------
namespace {

template <class T>
void release(T*& ptr) {
    if (ptr != nullptr) { ptr->Release(); ptr = nullptr; }
}

HWND g_hwnd = nullptr;
HWND g_parent = nullptr;
bool g_noAttach = false;
std::atomic<bool> g_ready{false};

// IPC commands arrive on their own thread (ipc.cpp), while the Win32 message
// loop renders every 16ms. mpv's render context and the D3D11 device must not
// be touched concurrently: hide/play used to free one while the other thread
// was inside mpv_render_context_render(), producing 0xC0000005 after a few
// wallpaper switches. Every public entry point serializes on this mutex.
static std::mutex g_apiMutex;

// A short switch (video -> web/scene -> video) should not destroy the decoder.
// Hidden frames are still rendered into the texture but not Presented; if no
// play arrives within this window, the decoder is released to free VRAM.
const DWORD kStandbyMs = 15000;
DWORD g_hideAt = 0;   // 0 = visible / standby cancelled

// D3D11 presenter state
ID3D11Device* g_device = nullptr;
ID3D11DeviceContext* g_ctx = nullptr;
IDXGISwapChain1* g_swap = nullptr;
ID3D11Texture2D* g_frameTex = nullptr;   // mpv renders here (RTV+SRV)
ID3D11ShaderResourceView* g_frameSRV = nullptr;
ID3D11VertexShader* g_vs = nullptr;
ID3D11PixelShader* g_ps = nullptr;
ID3D11SamplerState* g_sampler = nullptr;
ID3D11Buffer* g_cb = nullptr;
ID3D11RasterizerState* g_raster = nullptr;
int g_w = 0, g_h = 0;

// mpv decoder state
mpv_handle* g_mpv = nullptr;
mpv_render_context* g_render = nullptr;
std::string g_lastPath;
bool g_paused = false;
bool g_muted = true;   // 桌面视频默认静音（跟"应用即静音"老行为一致）；由 /sound 开关改写并跨 mpv 重建保持
float g_coverScale = 1.0f;
bool g_coverApplied = false;
bool g_firstFrame = false;

// Global render cadence (WE-style FPS limit): throttle how often we Present a
// frame to the desktop. Decoding and mpv events keep running every tick; only
// the final composite-to-desktop is rate limited. Never touches window state.
int g_targetFps = 30;                 // default 30 (WE recommendation)
double g_lastPresentAt = 0;
unsigned long long g_presentCount = 0; // diagnostics: successful desktop Presents
unsigned long long g_pollCount = 0;    // diagnostics: render-loop ticks
double presentIntervalMs() { return 1000.0 / g_targetFps; }

// GetTickCount64 still quantizes to the legacy ~15.6ms tick on some systems
// even after timeBeginPeriod(1). Use steady_clock for sub-tick cadence math.
double highResNowMs() {
    return std::chrono::duration<double, std::milli>(
        std::chrono::steady_clock::now().time_since_epoch()).count();
}

// Fullscreen-triangle composite shader. mpv renders a centred "contain" frame
// into g_frameTex; scaling sample UVs about centre by contain/cover yields cover.
const char kShader[] = R"(
cbuffer CoverCB : register(b0) { float2 uvScale; float2 padding; };
struct VSOut { float4 pos : SV_POSITION; float2 uv : TEXCOORD0; };
VSOut VSMain(uint id : SV_VertexID) {
  VSOut o;
  float2 p = float2((id == 1) ? 3.0 : -1.0, (id == 2) ? 3.0 : -1.0);
  o.pos = float4(p, 0.0, 1.0);
  o.uv = float2(p.x * 0.5 + 0.5, 0.5 - p.y * 0.5);
  return o;
}
Texture2D frameTex : register(t0);
SamplerState linearClamp : register(s0);
float4 PSMain(VSOut i) : SV_TARGET {
  float2 uv = 0.5 + (i.uv - 0.5) * uvScale;
  return frameTex.Sample(linearClamp, uv);
}
)";

struct CoverConstants { float uvScale[2]; float padding[2]; };

bool compileShader(const char* src, size_t len, const char* entry,
                   const char* target, ID3DBlob** out) {
    ID3DBlob* err = nullptr;
    HRESULT hr = D3DCompile(src, len, nullptr, nullptr, nullptr, entry, target,
                            0, 0, out, &err);
    if (FAILED(hr)) {
        logf("shader compile %s/%s failed 0x%08X %s", entry, target,
             (unsigned)hr, err ? (const char*)err->GetBufferPointer() : "?");
        if (err) err->Release();
        return false;
    }
    if (err) err->Release();
    return true;
}

// ---------- WorkerW discovery ----------
HWND findWorkerW() {
    HWND progman = ::FindWindowW(L"Progman", nullptr);
    if (!progman) return nullptr;

    HWND found = nullptr;
    EnumWindows([](HWND hwnd, LPARAM lparam) -> BOOL {
        HWND defView = ::FindWindowExW(hwnd, nullptr, L"SHELLDLL_DefView", nullptr);
        if (defView) {
            HWND worker = ::FindWindowExW(nullptr, hwnd, L"WorkerW", nullptr);
            if (worker) { *reinterpret_cast<HWND*>(lparam) = worker; return FALSE; }
        }
        return TRUE;
    }, reinterpret_cast<LPARAM>(&found));
    if (found) return found;

    found = ::FindWindowExW(progman, nullptr, L"WorkerW", nullptr);
    if (found) return found;

    ::SendMessageTimeoutW(progman, 0x052C, 0, 0, SMTO_NORMAL, 1000, nullptr);
    EnumWindows([](HWND hwnd, LPARAM lparam) -> BOOL {
        HWND defView = ::FindWindowExW(hwnd, nullptr, L"SHELLDLL_DefView", nullptr);
        if (defView) {
            HWND worker = ::FindWindowExW(nullptr, hwnd, L"WorkerW", nullptr);
            if (worker) { *reinterpret_cast<HWND*>(lparam) = worker; return FALSE; }
        }
        return TRUE;
    }, reinterpret_cast<LPARAM>(&found));
    if (found) return found;
    return progman;  // last resort
}

// ---------- D3D11 presenter ----------
bool createD3D(int w, int h, std::string& detail) {
    D3D_FEATURE_LEVEL fl = D3D_FEATURE_LEVEL_11_0;
    HRESULT hr = D3D11CreateDevice(nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr, 0,
                                   nullptr, 0, D3D11_SDK_VERSION, &g_device,
                                   &fl, &g_ctx);
    if (FAILED(hr)) {
        detail = "D3D11CreateDevice failed";
        logf("%s 0x%08X", detail.c_str(), (unsigned)hr);
        return false;
    }

    IDXGIDevice* dxgiDev = nullptr;
    hr = g_device->QueryInterface(__uuidof(IDXGIDevice), (void**)&dxgiDev);
    if (FAILED(hr)) { detail = "QueryInterface(IDXGIDevice) failed"; return false; }
    IDXGIAdapter* adapter = nullptr;
    dxgiDev->GetAdapter(&adapter);
    IDXGIFactory2* factory = nullptr;
    hr = adapter->GetParent(__uuidof(IDXGIFactory2), (void**)&factory);
    adapter->Release();
    dxgiDev->Release();
    if (FAILED(hr)) { detail = "GetParent(IDXGIFactory2) failed"; return false; }

    DXGI_SWAP_CHAIN_DESC1 desc{};
    desc.Width = (UINT)w;
    desc.Height = (UINT)h;
    desc.Format = DXGI_FORMAT_R8G8B8A8_UNORM;
    desc.SampleDesc.Count = 1;
    desc.BufferUsage = DXGI_USAGE_RENDER_TARGET_OUTPUT;
    desc.BufferCount = 2;
    desc.Scaling = DXGI_SCALING_STRETCH;
    desc.SwapEffect = DXGI_SWAP_EFFECT_FLIP_DISCARD;
    desc.AlphaMode = DXGI_ALPHA_MODE_UNSPECIFIED;
    hr = factory->CreateSwapChainForHwnd(g_device, g_hwnd, &desc, nullptr, nullptr, &g_swap);
    factory->Release();
    if (FAILED(hr)) {
        detail = "CreateSwapChainForHwnd failed";
        logf("%s 0x%08X", detail.c_str(), (unsigned)hr);
        return false;
    }
    g_w = w; g_h = h;

    // intermediate texture: mpv renders into it (needs RTV + DEFAULT + no MSAA)
    D3D11_TEXTURE2D_DESC td{};
    td.Width = (UINT)w; td.Height = (UINT)h; td.MipLevels = 1; td.ArraySize = 1;
    td.Format = DXGI_FORMAT_R8G8B8A8_UNORM;
    td.SampleDesc.Count = 1;
    td.Usage = D3D11_USAGE_DEFAULT;
    td.BindFlags = D3D11_BIND_RENDER_TARGET | D3D11_BIND_SHADER_RESOURCE;
    hr = g_device->CreateTexture2D(&td, nullptr, &g_frameTex);
    if (FAILED(hr)) { detail = "frame texture create failed"; return false; }
    hr = g_device->CreateShaderResourceView(g_frameTex, nullptr, &g_frameSRV);
    if (FAILED(hr)) { detail = "frame SRV create failed"; return false; }

    ID3DBlob* vsb = nullptr; ID3DBlob* psb = nullptr;
    bool ok = compileShader(kShader, sizeof(kShader) - 1, "VSMain", "vs_4_0", &vsb)
           && compileShader(kShader, sizeof(kShader) - 1, "PSMain", "ps_4_0", &psb);
    if (!ok) { release(vsb); release(psb); detail = "shader compile failed"; return false; }
    hr = g_device->CreateVertexShader(vsb->GetBufferPointer(), vsb->GetBufferSize(), nullptr, &g_vs);
    if (SUCCEEDED(hr))
        hr = g_device->CreatePixelShader(psb->GetBufferPointer(), psb->GetBufferSize(), nullptr, &g_ps);
    release(vsb); release(psb);
    if (FAILED(hr)) { detail = "shader create failed"; return false; }

    D3D11_SAMPLER_DESC sd{};
    sd.Filter = D3D11_FILTER_MIN_MAG_MIP_LINEAR;
    sd.AddressU = sd.AddressV = sd.AddressW = D3D11_TEXTURE_ADDRESS_CLAMP;
    sd.ComparisonFunc = D3D11_COMPARISON_NEVER;
    sd.MinLOD = 0.0f; sd.MaxLOD = D3D11_FLOAT32_MAX;
    hr = g_device->CreateSamplerState(&sd, &g_sampler);
    if (FAILED(hr)) { detail = "sampler create failed"; return false; }

    D3D11_RASTERIZER_DESC rd{};
    rd.FillMode = D3D11_FILL_SOLID; rd.CullMode = D3D11_CULL_NONE; rd.DepthClipEnable = TRUE;
    hr = g_device->CreateRasterizerState(&rd, &g_raster);
    if (FAILED(hr)) { detail = "rasterizer create failed"; return false; }

    D3D11_BUFFER_DESC cb{};
    cb.ByteWidth = sizeof(CoverConstants);
    cb.Usage = D3D11_USAGE_DYNAMIC;
    cb.BindFlags = D3D11_BIND_CONSTANT_BUFFER;
    cb.CPUAccessFlags = D3D11_CPU_ACCESS_WRITE;
    hr = g_device->CreateBuffer(&cb, nullptr, &g_cb);
    if (FAILED(hr)) { detail = "constant buffer create failed"; return false; }

    logf("D3D11 ready: %dx%d FLIP_DISCARD swapchain + composite shader", w, h);
    return true;
}

bool presentFrame(bool toScreen) {
    if (!g_ctx || !g_swap || !g_frameTex || !g_render) return false;

    // mpv leaves arbitrary pipeline state behind; clear before and after.
    g_ctx->ClearState();
    mpv_d3d11_fbo fbo{};
    fbo.tex = g_frameTex;
    mpv_render_param params[] = {
        { MPV_RENDER_PARAM_D3D11_FBO, &fbo },
        { MPV_RENDER_PARAM_INVALID, nullptr },
    };
    if (mpv_render_context_render(g_render, params) < 0) return false;

    // Standby: keep draining mpv's frame queue (otherwise its decoder stalls),
    // but skip desktop composition/Present while the window is hidden.
    if (!toScreen) return true;

    // composite g_frameTex -> swapchain back buffer with cover crop
    ID3D11Texture2D* back = nullptr;
    HRESULT hr = g_swap->GetBuffer(0, __uuidof(ID3D11Texture2D), (void**)&back);
    if (FAILED(hr)) return false;
    ID3D11RenderTargetView* rtv = nullptr;
    hr = g_device->CreateRenderTargetView(back, nullptr, &rtv);
    back->Release();
    if (FAILED(hr)) return false;

    g_ctx->ClearState();
    D3D11_MAPPED_SUBRESOURCE mapped{};
    if (SUCCEEDED(g_ctx->Map(g_cb, 0, D3D11_MAP_WRITE_DISCARD, 0, &mapped))) {
        auto* c = (CoverConstants*)mapped.pData;
        c->uvScale[0] = c->uvScale[1] = g_coverScale;
        c->padding[0] = c->padding[1] = 0.0f;
        g_ctx->Unmap(g_cb, 0);
    }
    D3D11_VIEWPORT vp{};
    vp.Width = (float)g_w; vp.Height = (float)g_h; vp.MaxDepth = 1.0f;
    g_ctx->RSSetViewports(1, &vp);
    g_ctx->RSSetState(g_raster);
    g_ctx->IASetInputLayout(nullptr);
    g_ctx->IASetPrimitiveTopology(D3D11_PRIMITIVE_TOPOLOGY_TRIANGLELIST);
    g_ctx->VSSetShader(g_vs, nullptr, 0);
    g_ctx->PSSetShader(g_ps, nullptr, 0);
    g_ctx->PSSetConstantBuffers(0, 1, &g_cb);
    g_ctx->PSSetShaderResources(0, 1, &g_frameSRV);
    g_ctx->PSSetSamplers(0, 1, &g_sampler);
    g_ctx->OMSetRenderTargets(1, &rtv, nullptr);
    g_ctx->OMSetBlendState(nullptr, nullptr, 0xFFFFFFFF);
    g_ctx->OMSetDepthStencilState(nullptr, 0);
    g_ctx->Draw(3, 0);
    release(rtv);
    g_ctx->OMSetRenderTargets(0, nullptr, nullptr);
    hr = g_swap->Present(1, 0);
    if (FAILED(hr)) { logf("Present failed 0x%08X", (unsigned)hr); return false; }
    ++g_presentCount;
    if (!g_firstFrame) { logf("first frame presented"); g_firstFrame = true; }
    return true;
}

// ---------- mpv decoder ----------
bool createMpv(std::string& detail) {
    if (g_mpv) return true;
    g_mpv = mpv_create();
    if (!g_mpv) { detail = "mpv_create failed"; return false; }

    // vo=libmpv IS the render API output. Without it mpv opens its own window.
    mpv_set_option_string(g_mpv, "vo", "libmpv");
    mpv_set_option_string(g_mpv, "hwdec", "d3d11va");
    mpv_set_option_string(g_mpv, "hwdec-codecs", "h264,hevc,vp9,av1");
    mpv_set_option_string(g_mpv, "loop-file", "inf");
    mpv_set_option_string(g_mpv, "keep-open", "yes");
    // Mute follows the user's /sound setting (default muted). Keeping the audio
    // clock alive avoids timing drift even while muted.
    mpv_set_option_string(g_mpv, "mute", g_muted ? "yes" : "no");
    mpv_set_option_string(g_mpv, "keepaspect", "yes");
    mpv_set_option_string(g_mpv, "terminal", "no");
    mpv_set_option_string(g_mpv, "msg-level", "all=warn");
    if (mpv_initialize(g_mpv) < 0) {
        detail = "mpv_initialize failed";
        mpv_terminate_destroy(g_mpv); g_mpv = nullptr;
        return false;
    }

    // CRITICAL: render context must exist BEFORE first loadfile, otherwise mpv
    // reverts to its own window and frames never reach our texture.
    mpv_d3d11_init_params init{};
    init.device = g_device;
    mpv_render_param params[] = {
        { MPV_RENDER_PARAM_API_TYPE, const_cast<char*>(MPV_RENDER_API_TYPE_D3D11) },
        { MPV_RENDER_PARAM_D3D11_INIT_PARAMS, &init },
        { MPV_RENDER_PARAM_INVALID, nullptr },
    };
    if (mpv_render_context_create(&g_render, g_mpv, params) < 0) {
        detail = "mpv_render_context_create failed";
        logf("%s", detail.c_str());
        mpv_terminate_destroy(g_mpv); g_mpv = nullptr;
        return false;
    }
    logf("mpv decoder ready (vo=libmpv, hwdec=d3d11va, render context before loadfile)");
    return true;
}

void computeCover() {
    if (g_coverApplied || !g_mpv) return;
    int64_t vw = 0, vh = 0;
    if (mpv_get_property(g_mpv, "dwidth", MPV_FORMAT_INT64, &vw) < 0 ||
        mpv_get_property(g_mpv, "dheight", MPV_FORMAT_INT64, &vh) < 0 || vw <= 0 || vh <= 0)
        return;
    double contain = std::min((double)g_w / vw, (double)g_h / vh);
    double cover = std::max((double)g_w / vw, (double)g_h / vh);
    if (contain > 0 && cover > 0) g_coverScale = (float)(contain / cover);
    g_coverApplied = true;

    const char* hw = mpv_get_property_string(g_mpv, "hwdec-current");
    logf("decode: hwdec-current=%s %lldx%lld cover=%.3f",
         hw ? hw : "?", (long long)vw, (long long)vh, g_coverScale);
    if (hw) mpv_free((void*)hw);
}

void unloadMpv() {
    if (g_render) { mpv_render_context_free(g_render); g_render = nullptr; }
    if (g_mpv) { mpv_terminate_destroy(g_mpv); g_mpv = nullptr; }
    logf("decoder unloaded (RAM/VRAM freed)");
}

} // namespace

// ---------- public API (unchanged signatures; main.cpp untouched) ----------
namespace renderer {

bool init(HINSTANCE hInst, std::string& detail) {
    std::lock_guard<std::mutex> lock(g_apiMutex);
    WNDCLASSEXW wc{};
    wc.cbSize = sizeof(wc);
    wc.lpfnWndProc = ::DefWindowProcW;
    wc.hInstance = hInst;
    wc.lpszClassName = L"WallFlowCoreDesktop";
    if (!::RegisterClassExW(&wc) && ::GetLastError() != ERROR_CLASS_ALREADY_EXISTS) {
        detail = "RegisterClassExW failed";
        return false;
    }

    int w = ::GetSystemMetrics(SM_CXVIRTUALSCREEN);
    int h = ::GetSystemMetrics(SM_CYVIRTUALSCREEN);
    int vx = ::GetSystemMetrics(SM_XVIRTUALSCREEN);
    int vy = ::GetSystemMetrics(SM_YVIRTUALSCREEN);
    if (w <= 0 || h <= 0) { w = ::GetSystemMetrics(SM_CXSCREEN); h = ::GetSystemMetrics(SM_CYSCREEN); vx = vy = 0; }

    // plain child + click-through; no layered alpha (that forced DWM full-screen blend)
    g_hwnd = ::CreateWindowExW(
        WS_EX_NOACTIVATE | WS_EX_TRANSPARENT | WS_EX_NOPARENTNOTIFY,
        wc.lpszClassName, L"WallFlowCoreDesktop", WS_POPUP,
        vx, vy, w, h, nullptr, nullptr, hInst, nullptr);
    if (!g_hwnd) { detail = "CreateWindowExW failed"; return false; }

    const char* noAttachEnv = std::getenv("WF_CORE_NO_ATTACH");
    g_noAttach = noAttachEnv && std::strcmp(noAttachEnv, "1") == 0;
    if (g_noAttach) {
        logf("no-attach mode: render window stays hidden, desktop untouched");
    } else {
        g_parent = findWorkerW();
        if (!g_parent) { detail = "WorkerW not found"; return false; }
        ::SetParent(g_hwnd, g_parent);
        LONG style = ::GetWindowLongW(g_hwnd, GWL_STYLE);
        ::SetWindowLongW(g_hwnd, GWL_STYLE, (style | WS_CHILD) & ~WS_POPUP);
        RECT rc{};
        if (::GetClientRect(g_parent, &rc) && rc.right > rc.left && rc.bottom > rc.top) {
            w = rc.right - rc.left; h = rc.bottom - rc.top;
        }
        ::SetWindowPos(g_hwnd, HWND_TOP, 0, 0, w, h, SWP_NOACTIVATE | SWP_FRAMECHANGED);
        logf("attached to WorkerW %p as child, size %dx%d", (void*)g_parent, w, h);
    }

    if (!createD3D(w, h, detail)) return false;
    if (!createMpv(detail)) return false;
    g_ready = true;
    return true;
}

bool play(const std::string& utf8Path, std::string& detail) {
    std::lock_guard<std::mutex> lock(g_apiMutex);
    // A play command cancels any pending standby release. If the decoder was
    // already released (long pause / tier2), rebuild it here so play is
    // self-contained and never fails with "decoder not initialized".
    g_hideAt = 0;
    if (!g_mpv || !g_render) {
        if (!createMpv(detail)) return false;
    }
    g_lastPath = utf8Path;
    g_coverApplied = false;
    g_coverScale = 1.0f;
    g_firstFrame = false;
    const char* cmd[] = { "loadfile", utf8Path.c_str(), "replace", nullptr };
    if (mpv_command(g_mpv, cmd) < 0) {
        detail = "loadfile failed";
        logf("%s path=%s", detail.c_str(), utf8Path.c_str());
        return false;
    }
    logf("play ok path=%s", utf8Path.c_str());
    return true;
}

void setPaused(bool paused) {
    std::lock_guard<std::mutex> lock(g_apiMutex);
    g_paused = paused;
    if (!g_mpv) return;
    int flag = paused ? 1 : 0;
    mpv_set_property(g_mpv, "pause", MPV_FORMAT_FLAG, &flag);
    logf("setPaused %d", flag);
}

void setMuted(bool muted) {
    std::lock_guard<std::mutex> lock(g_apiMutex);
    g_muted = muted;   // remember across mpv recreate (wallpaper switches)
    if (!g_mpv) return;
    int flag = muted ? 1 : 0;
    mpv_set_property(g_mpv, "mute", MPV_FORMAT_FLAG, &flag);
    logf("setMuted %d", flag);
}

bool isMuted() {
    std::lock_guard<std::mutex> lock(g_apiMutex);
    return g_muted;
}

void setTargetFps(int fps) {
    std::lock_guard<std::mutex> lock(g_apiMutex);
    if (fps < 1 || fps > 240) return;
    if (g_targetFps == fps) return;
    g_targetFps = fps;
    g_lastPresentAt = 0;   // apply new cadence immediately
    logf("render cadence -> %d fps", fps);
}

void stop() {
    std::lock_guard<std::mutex> lock(g_apiMutex);
    g_hideAt = 0;
    computeCover();
    unloadMpv();
}

// Web/scene wallpapers need the desktop layer. Step aside without destroying
// the decoder, so switching back to the same video is nearly instant.
void standby() {
    std::lock_guard<std::mutex> lock(g_apiMutex);
    if (!g_hwnd) return;
    if (!g_hideAt) g_hideAt = ::GetTickCount();
    if (!g_noAttach) ::ShowWindow(g_hwnd, SW_HIDE);
    logf("standby: decoder kept %u ms for fast switch", (unsigned)kStandbyMs);
}

void setVisible(bool visible) {
    std::lock_guard<std::mutex> lock(g_apiMutex);
    if (!g_hwnd) return;
    g_hideAt = visible ? 0 : ::GetTickCount();
    if (g_noAttach) { logf("setVisible %d (no-attach: skipped)", visible ? 1 : 0); return; }
    ::ShowWindow(g_hwnd, visible ? SW_SHOWNOACTIVATE : SW_HIDE);
    logf("setVisible %d", visible ? 1 : 0);
}

static DWORD g_lastAssert = 0;
static DWORD g_lastAssertLog = 0;
static void reassertDesktopLayer() {
    if (g_noAttach || !g_hwnd || !g_parent) return;
    DWORD now = ::GetTickCount();
    if (now - g_lastAssert < 2000) return;
    g_lastAssert = now;

    bool reparent = ::GetAncestor(g_hwnd, GA_PARENT) != g_parent;
    bool onTop = ::GetWindow(g_parent, GW_CHILD) == g_hwnd;
    int w = 0, h = 0;
    bool resized = false;
    RECT rc{};
    if (::GetClientRect(g_parent, &rc)) {
        w = rc.right - rc.left; h = rc.bottom - rc.top;
        RECT ours{};
        if (::GetWindowRect(g_hwnd, &ours))
            resized = (ours.right - ours.left != w) || (ours.bottom - ours.top != h);
    }
    if (!reparent && onTop && !resized) return;

    if (reparent) {
        ::SetParent(g_hwnd, g_parent);
        LONG style = ::GetWindowLongW(g_hwnd, GWL_STYLE);
        ::SetWindowLongW(g_hwnd, GWL_STYLE, (style | WS_CHILD) & ~WS_POPUP);
    }
    if (w > 0 && h > 0)
        ::SetWindowPos(g_hwnd, HWND_TOP, 0, 0, w, h, SWP_NOACTIVATE | SWP_FRAMECHANGED);
    if (now - g_lastAssertLog > 10000) {
        g_lastAssertLog = now;
        logf("reassert desktop layer (reparent=%d top=%d resize=%d)",
             reparent ? 1 : 0, onTop ? 1 : 0, resized ? 1 : 0);
    }
}

void pollEvents() {
    std::lock_guard<std::mutex> lock(g_apiMutex);
    ++g_pollCount;
    reassertDesktopLayer();

    // Standby timeout: release decoder/VRAM only if no play arrived in time.
    DWORD now = ::GetTickCount();
    if (g_hideAt && now - g_hideAt >= kStandbyMs) {
        g_hideAt = 0;
        computeCover();
        unloadMpv();
    }
    if (!g_mpv) return;

    // Drain mpv events (errors / file state surface in log).
    while (mpv_event* ev = mpv_wait_event(g_mpv, 0)) {
        if (ev->event_id == MPV_EVENT_NONE) break;
        if (ev->event_id == MPV_EVENT_FILE_LOADED) logf("mpv file-loaded");
        else if (ev->event_id == MPV_EVENT_END_FILE) {
            auto* e = (mpv_event_end_file*)ev->data;
            logf("mpv end-file reason=%d", (int)e->reason);
        }
    }
    computeCover();

    // Global render cadence (WE-style): render+Present only when the target
    // interval elapsed. Skipping presentFrame also skips mpv_render_context_render
    // and the D3D composite, so GPU work actually drops; decoding keeps running
    // on mpv's own thread and events are still drained above. The swap chain
    // keeps showing the last frame between ticks. Never touches window state.
    if (g_render && !g_paused) {
        // Use a high-resolution ms clock (GetTickCount64) and a fractional
        // interval. Integer 1000/144 == 6 would otherwise let the 16ms Win32
        // timer overshoot the target and present far more often than requested.
        const double nowMs = highResNowMs();
        const double interval = presentIntervalMs();
        if (g_lastPresentAt == 0 || nowMs - g_lastPresentAt + 0.5 >= interval) {
            g_lastPresentAt = nowMs;
            presentFrame(g_hideAt == 0);
        }
    }
}

void shutdown() {
    std::lock_guard<std::mutex> lock(g_apiMutex);
    g_ready = false;
    g_hideAt = 0;
    unloadMpv();
    release(g_frameSRV); release(g_frameTex);
    release(g_vs); release(g_ps); release(g_sampler);
    release(g_cb); release(g_raster);
    release(g_swap); release(g_ctx); release(g_device);
    if (g_hwnd) { ::DestroyWindow(g_hwnd); g_hwnd = nullptr; }
    logf("shutdown done");
}

HWND desktopWindow() { return g_hwnd; }
bool ready() { return g_ready.load(); }

bool decoderAlive() { std::lock_guard<std::mutex> lock(g_apiMutex); return g_mpv != nullptr; }

int targetFps() { std::lock_guard<std::mutex> lock(g_apiMutex); return g_targetFps; }

unsigned long long presentedFrames() { std::lock_guard<std::mutex> lock(g_apiMutex); return g_presentCount; }
unsigned long long pollTicks() { std::lock_guard<std::mutex> lock(g_apiMutex); return g_pollCount; }

DWORD pollDelayMs() {
    std::lock_guard<std::mutex> lock(g_apiMutex);
    const double interval = presentIntervalMs();
    const double now = highResNowMs();
    const double elapsed = (g_lastPresentAt == 0) ? interval : (now - g_lastPresentAt);
    double left = interval - elapsed;
    if (left < 1.0) left = 1.0;
    if (left > 16.0) left = 16.0;
    return (DWORD)left;
}

} // namespace renderer
