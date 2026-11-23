#pragma once
#include <string>
#include <functional>

// ipc.h - minimal localhost HTTP IPC, protocol-compatible with fake-core.mjs
namespace ipc {

// Callback: receives (cmd, raw json body). Returns a JSON string to respond with.
using Handler = std::function<std::string(const std::string& cmd, const std::string& body)>;

// Start listening on 127.0.0.1:port in a background thread. Non-blocking.
bool start(int port, Handler handler, std::string& detail);

void stop();

} // namespace ipc
