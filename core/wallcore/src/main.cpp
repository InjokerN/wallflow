// wallcore - V2 headless desktop wallpaper render core
// Protocol-compatible with fake-core.mjs (/api/core/health, /api/core/command).
#include <windows.h>
#include <mmsystem.h>
#include <chrono>
#include <condition_variable>
#include <cstdio>
#include <cstdlib>
#include <deque>
#include <memory>
#include <mutex>
#include <string>

#include "renderer.h"
#include "ipc.h"

static int corePort() {
    const char* p = std::getenv("WF_CORE_PORT");
    return p ? std::atoi(p) : 3002;
}

static void coreLog(const char* msg) {
    const char* appdata = std::getenv("APPDATA");
    std::string dir = appdata ? appdata : ".";
    std::string fp = dir + "\\WallFlow\\wallcore.log";
    FILE* f = std::fopen(fp.c_str(), "a");
    if (f) { std::fprintf(f, "[main] %s\n", msg); std::fclose(f); }
}

// Last successfully played path, so the tray "reload wallpaper" can re-apply it.
static std::string g_lastPath;

// ---------------------------------------------------------------------------
// Command queue: EVERY renderer call must happen on the main render thread.
// ipc.cpp dispatches HTTP commands on its own std::thread. Even with a mutex
// around renderer state, calling mpv_command() / mpv_render_context_free()
// from the IPC thread while the main thread sits inside
// mpv_render_context_render() causes an mpv-internal lock-order inversion:
// the HTTP handler blocks >3s, backend times out, video never appears.
// Queue the command, let the render loop execute it, then wake the caller.
// ---------------------------------------------------------------------------
struct QueuedCommand {
    std::string cmd;
    std::string body;
    std::string result;
    bool done = false;
};

static std::mutex g_queueMutex;
static std::condition_variable g_queueCv;
static std::deque<std::shared_ptr<QueuedCommand>> g_queue;
static bool g_shuttingDown = false;

// Executed only from the main render thread (drainCommands).
static std::string executeCommand(const std::string& cmd, const std::string& body) {
    // minimal field extractor (shared shape with ipc.cpp)
    auto field = [&](const char* key) -> std::string {
        std::string k = std::string("\"") + key + "\"";
        size_t p = body.find(k);
        if (p == std::string::npos) return "";
        p = body.find(':', p + k.size());
        if (p == std::string::npos) return "";
        size_t q = body.find('"', p + 1);
        if (q == std::string::npos) return "";
        size_t e = body.find('"', q + 1);
        if (e == std::string::npos) return "";
        return body.substr(q + 1, e - q - 1);
    };

    if (cmd == "play") {
        std::string path = field("path");
        if (path.empty()) return "{\"code\":400,\"message\":\"missing path\"}";
        // JSON may contain escaped backslashes; unescape \\ -> \ and \" -> "
        std::string clean; clean.reserve(path.size());
        for (size_t i = 0; i < path.size(); ++i) {
            if (path[i] == '\\' && i + 1 < path.size()) {
                char c = path[i + 1];
                if (c == '\\' || c == '"' || c == '/') { clean += c; ++i; continue; }
            }
            clean += path[i];
        }
        std::string detail;
        bool ok = renderer::play(clean, detail);
        if (ok) {
            g_lastPath = clean;
            // A played wallpaper must be visible. The window starts hidden
            // (no WS_VISIBLE) and `standby` may have covered it for a web/scene
            // wallpaper - showing here makes `play` self-contained.
            renderer::setVisible(true);
        }
        coreLog(ok ? "play dispatched + shown" : detail.c_str());
        return ok ? "{\"code\":0,\"message\":\"ok\",\"data\":{\"received\":\"play\"}}"
                  : "{\"code\":500,\"message\":\"" + detail + "\"}";
    }
    if (cmd == "hide") {
        // Web / scene wallpapers are rendered by the Electron desktop window
        // (WebWallGL / iframe). Hide our window but KEEP the decoder for a
        // short standby window: destroying/recreating mpv on every switch was
        // both the visible black gap and the source of a render-thread race.
        renderer::standby();
        coreLog("hide dispatched (standby, desktop layer handed over)");
        return "{\"code\":0,\"message\":\"ok\",\"data\":{\"received\":\"hide\"}}";
    }
    if (cmd == "show") {
        renderer::setVisible(true);
        coreLog("show dispatched");
        return "{\"code\":0,\"message\":\"ok\",\"data\":{\"received\":\"show\"}}";
    }
    if (cmd == "reload") {
        if (g_lastPath.empty()) return "{\"code\":400,\"message\":\"no previous wallpaper\"}";
        std::string detail;
        bool ok = renderer::play(g_lastPath, detail);
        if (ok) renderer::setVisible(true);   // same self-contained show as play
        coreLog(ok ? "reload dispatched + shown" : detail.c_str());
        return ok ? "{\"code\":0,\"message\":\"ok\",\"data\":{\"received\":\"reload\"}}"
                  : "{\"code\":500,\"message\":\"" + detail + "\"}";
    }
    if (cmd == "pause") {
        bool paused = body.find("\"paused\":true") != std::string::npos ||
                      body.find("\"paused\": true") != std::string::npos;
        renderer::setPaused(paused);
        return "{\"code\":0,\"message\":\"ok\",\"data\":{\"received\":\"pause\"}}";
    }
    if (cmd == "fps") {
        size_t p = body.find("\"fps\"");
        if (p != std::string::npos) {
            size_t c = body.find(':', p);
            if (c != std::string::npos) renderer::setTargetFps(std::atoi(body.c_str() + c + 1));
        }
        return "{\"code\":0,\"message\":\"ok\",\"data\":{\"received\":\"fps\"}}";
    }
    if (cmd == "status") {
        // Diagnostic: decoder loaded + current render cadence (for verification).
        bool alive = renderer::decoderAlive();
        int fps = renderer::targetFps();
        std::string r = std::string("{\"code\":0,\"message\":\"ok\",\"data\":{\"decoderAlive\":")
            + (alive ? "true" : "false")
            + ",\"targetFps\":" + std::to_string(fps)
            + ",\"presentCount\":" + std::to_string(renderer::presentedFrames())
            + ",\"pollCount\":" + std::to_string(renderer::pollTicks())
            + "}}";
        return r;
    }
    if (cmd == "tier") {
        // V2 placeholder: tier 2 (Stop) -> unload decoder
        size_t p = body.find("\"tier\"");
        if (p != std::string::npos) {
            size_t c = body.find(':', p);
            if (c != std::string::npos) {
                int tier = std::atoi(body.c_str() + c + 1);
                if (tier == 2) renderer::stop();
            }
        }
        return "{\"code\":0,\"message\":\"ok\",\"data\":{\"received\":\"tier\"}}";
    }
    if (cmd == "quit") {
        ::PostQuitMessage(0);
        return "{\"code\":0,\"message\":\"ok\",\"data\":{\"received\":\"quit\"}}";
    }
    return "{\"code\":400,\"message\":\"unknown cmd\"}";
}

// IPC thread entry: enqueue and wait for the render thread to execute it.
static std::string handleCommand(const std::string& cmd, const std::string& body) {
    auto item = std::make_shared<QueuedCommand>();
    item->cmd = cmd;
    item->body = body;
    {
        std::lock_guard<std::mutex> lk(g_queueMutex);
        if (g_shuttingDown) return "{\"code\":503,\"message\":\"shutting down\"}";
        g_queue.push_back(item);
    }
    g_queueCv.notify_all();

    std::unique_lock<std::mutex> lk(g_queueMutex);
    // Backend timeout is 3000ms; answer well before that.
    bool ok = g_queueCv.wait_for(lk, std::chrono::milliseconds(2200),
                                 [&] { return item->done || g_shuttingDown; });
    if (!ok || g_shuttingDown) return "{\"code\":504,\"message\":\"render thread timeout\"}";
    return item->result;
}

// Main render thread: run all pending commands, then render one frame.
static void drainCommands() {
    for (;;) {
        std::shared_ptr<QueuedCommand> item;
        {
            std::lock_guard<std::mutex> lk(g_queueMutex);
            if (g_queue.empty()) return;
            item = g_queue.front();
            g_queue.pop_front();
        }
        item->result = executeCommand(item->cmd, item->body);
        {
            std::lock_guard<std::mutex> lk(g_queueMutex);
            item->done = true;
        }
        g_queueCv.notify_all();
    }
}

int WINAPI wWinMain(HINSTANCE hInst, HINSTANCE, PWSTR, int) {
    coreLog("=== wallcore starting ===");

    // Default Win32 timer granularity is ~15.6ms. With Sleep(16) the render
    // loop only ticked ~33 times/s, so 60/72/144fps all collapsed to ~33.
    // Request 1ms resolution for the lifetime of the wallpaper core.
    timeBeginPeriod(1);

    std::string detail;
    if (!renderer::init(hInst, detail)) {
        coreLog(("renderer init failed: " + detail).c_str());
        timeEndPeriod(1);
        return 1;
    }
    if (!ipc::start(corePort(), handleCommand, detail)) {
        coreLog(("ipc start failed: " + detail).c_str());
        renderer::shutdown();
        timeEndPeriod(1);
        return 1;
    }
    coreLog("wallcore ready");

    // Message loop; poll mpv events so first-frame / errors surface in log.
    MSG msg{};
    while (true) {
        while (::PeekMessageW(&msg, nullptr, 0, 0, PM_REMOVE)) {
            if (msg.message == WM_QUIT) goto done;
            ::TranslateMessage(&msg);
            ::DispatchMessageW(&msg);
        }
        drainCommands();          // all mpv/D3D11 work stays on this thread
        renderer::pollEvents();

        // Sleep only until the next cadence check. Fixed Sleep(16) blocked
        // 60/72/144fps entirely; fixed half-interval still drifted when a
        // Present took longer than expected. The renderer owns the schedule.
        ::Sleep(renderer::pollDelayMs());
    }

done:
    {
        std::lock_guard<std::mutex> lk(g_queueMutex);
        g_shuttingDown = true;
    }
    g_queueCv.notify_all();       // release any IPC handler still waiting
    ipc::stop();
    renderer::shutdown();
    timeEndPeriod(1);
    coreLog("=== wallcore exit ===");
    return 0;
}
