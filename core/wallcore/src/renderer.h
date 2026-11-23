#pragma once
#include <windows.h>
#include <string>

// renderer.h - desktop window + WorkerW attach + libmpv D3D11 rendering.
// Follows plan doc section 2.1 discipline (NOREDIRECTIONBITMAP / flip / d3d11va / attach WorkerW).

namespace renderer {

// Create hidden layered desktop window, attach to WorkerW, init libmpv with D3D11 hwdec.
// Returns true on success. detail receives human-readable status.
bool init(HINSTANCE hInst, std::string& detail);

// Load a media file (video/image) into mpv playback (replace current).
bool play(const std::string& utf8Path, std::string& detail);

// Pause / resume playback.
void setPaused(bool paused);

// Stop playback and unload decoder immediately (free memory) - tier2 / shutdown.
void stop();

// Step aside for a web/scene wallpaper without destroying the decoder, so a
// quick switch back to video is instant. Decoder is auto-released after 15s.
void standby();

// Show / hide the desktop window. Used when a web/scene wallpaper needs the
// Electron desktop layer to take over: the core window must step aside instead
// of covering the browser-rendered wallpaper. Hiding also starts standby.
void setVisible(bool visible);

// Flush pending mpv events. Call from the UI/message thread periodically.
void pollEvents();

// Shutdown mpv and destroy window.
void shutdown();

// Expose the desktop HWND (for diagnostics).
HWND desktopWindow();

// Is mpv currently initialized (core fully started).
bool ready();

// Is the mpv decoder currently loaded? False after stop()/standby timeout.
// Used by the status command to verify Stop really freed RAM/VRAM.
bool decoderAlive();

// Global render cadence (WE-style FPS limit). Decoding keeps running; only
// render+Present is throttled to this many frames per second. 1..240.
void setTargetFps(int fps);
int targetFps();

// Diagnostics: actual Present / poll counts since start. Used to verify the
// cadence gate is really executing, not just storing a target number.
unsigned long long presentedFrames();
unsigned long long pollTicks();

// Milliseconds the main loop should sleep before the next cadence check.
// Accounts for time already spent inside Present, so 30fps stays 30fps even
// when one composite takes ~16ms on a slow GPU.
DWORD pollDelayMs();

} // namespace renderer
