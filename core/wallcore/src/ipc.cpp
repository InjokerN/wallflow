// ipc.cpp - minimal localhost HTTP server (single-threaded, one request at a time)
#include "ipc.h"

#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#include <cstdio>
#include <cstring>
#include <string>
#include <thread>
#include <atomic>

namespace ipc {

static std::atomic<bool> g_running{false};
static std::atomic<SOCKET> g_listen{INVALID_SOCKET};
static std::thread g_thread;
static Handler g_handler;

static void logf(const char* fmt, ...) {
    char buf[1024];
    va_list ap; va_start(ap, fmt);
    vsnprintf(buf, sizeof(buf), fmt, ap);
    va_end(ap);
    std::fprintf(stderr, "[ipc] %s\n", buf);
}

// Extract a string field value from JSON body (simple, no escapes for our commands).
static std::string field(const std::string& body, const char* key) {
    std::string k = std::string("\"") + key + "\"";
    size_t p = body.find(k);
    if (p == std::string::npos) return "";
    p = body.find(':', p + k.size());
    if (p == std::string::npos) return "";
    p = body.find('"', p + 1);
    if (p == std::string::npos) return "";
    size_t e = body.find('"', p + 1);
    if (e == std::string::npos) return "";
    return body.substr(p + 1, e - p - 1);
}

static void respond(SOCKET s, int code, const std::string& json) {
    char header[256];
    int n = snprintf(header, sizeof(header),
        "HTTP/1.1 %d %s\r\nContent-Type: application/json; charset=utf-8\r\n"
        "Content-Length: %zu\r\nConnection: close\r\n\r\n",
        code, code == 200 ? "OK" : (code == 400 ? "Bad Request" : (code == 404 ? "Not Found" : "Error")),
        json.size());
    ::send(s, header, n, 0);
    ::send(s, json.c_str(), (int)json.size(), 0);
}

static void serve() {
    while (g_running.load()) {
        SOCKET ls = g_listen.load();
        if (ls == INVALID_SOCKET) break;
        fd_set fds; FD_ZERO(&fds); FD_SET(ls, &fds);
        timeval tv{ 0, 500000 }; // 500ms tick so stop() is responsive
        int r = ::select(0, &fds, nullptr, nullptr, &tv);
        if (r <= 0 || !FD_ISSET(ls, &fds)) continue;

        SOCKET c = ::accept(ls, nullptr, nullptr);
        if (c == INVALID_SOCKET) continue;

        std::string req;
        char buf[4096];
        while (true) {
            int n = ::recv(c, buf, sizeof(buf), 0);
            if (n <= 0) break;
            req.append(buf, n);
            if (req.size() > 64 * 1024) break;
            if (req.find("\r\n\r\n") != std::string::npos) {
                // crude: assume body arrives in same packet for our small commands
                size_t hp = req.find("\r\n\r\n");
                size_t declared = 0;
                size_t cl = req.find("Content-Length:");
                if (cl != std::string::npos) {
                    size_t le = req.find("\r\n", cl);
                    declared = strtoul(req.substr(cl + 15, le - cl - 15).c_str(), nullptr, 10);
                }
                if (req.size() >= hp + 4 + declared) break;
            }
        }

        size_t hp = req.find("\r\n\r\n");
        std::string head = req.substr(0, hp);
        std::string body = hp == std::string::npos ? "" : req.substr(hp + 4);
        std::string firstLine = head.substr(0, head.find("\r\n"));

        if (firstLine.find("GET /api/core/health") != std::string::npos) {
            respond(c, 200, "{\"code\":0,\"message\":\"wallcore ok\",\"data\":{}}");
        } else if (firstLine.find("POST /api/core/command") != std::string::npos) {
            std::string cmd = field(body, "cmd");
            std::string json = g_handler ? g_handler(cmd, body) : "{\"code\":500,\"message\":\"no handler\"}";
            int code = json.find("\"code\":0") != std::string::npos ? 200 : 400;
            respond(c, code, json);
        } else {
            respond(c, 404, "{\"code\":404,\"message\":\"not found\"}");
        }
        ::closesocket(c);
    }
}

bool start(int port, Handler handler, std::string& detail) {
    WSADATA wsa;
    if (::WSAStartup(MAKEWORD(2, 2), &wsa) != 0) {
        detail = "WSAStartup failed"; return false;
    }
    SOCKET ls = ::socket(AF_INET, SOCK_STREAM, 0);
    if (ls == INVALID_SOCKET) { detail = "socket failed"; return false; }
    sockaddr_in addr{};
    addr.sin_family = AF_INET;
    addr.sin_port = htons((u_short)port);
    addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    if (::bind(ls, (sockaddr*)&addr, sizeof(addr)) == SOCKET_ERROR) {
        detail = "bind failed (port in use?)";
        ::closesocket(ls); return false;
    }
    if (::listen(ls, 8) == SOCKET_ERROR) {
        detail = "listen failed"; ::closesocket(ls); return false;
    }
    g_handler = std::move(handler);
    g_listen.store(ls);
    g_running = true;
    g_thread = std::thread(serve);
    logf("listening on 127.0.0.1:%d", port);
    return true;
}

void stop() {
    if (!g_running.exchange(false)) return;
    SOCKET ls = g_listen.exchange(INVALID_SOCKET);
    if (ls != INVALID_SOCKET) ::closesocket(ls);
    if (g_thread.joinable()) g_thread.join();
    ::WSACleanup();
    logf("stopped");
}

} // namespace ipc
