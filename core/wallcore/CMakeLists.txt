cmake_minimum_required(VERSION 3.20)
project(wallcore LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
add_executable(wallcore WIN32
    src/main.cpp
    src/renderer.cpp
    src/ipc.cpp
)

# libmpv SDK：复用方案2 已验证的本地依赖（MSVC 格式），不读其源码
set(MPV_SDK "F:/AI/AI-Project/C-Wallpaper/WallFlow/third_party")
target_include_directories(wallcore PRIVATE "${MPV_SDK}/include")
target_link_libraries(wallcore PRIVATE "${MPV_SDK}/libmpv.lib")

# Windows 系统库：D3D11/DXGI 渲染 + Winsock(HTTP IPC) +  Shell32/User32(WorkerW)
target_link_libraries(wallcore PRIVATE
    d3d11.lib dxgi.lib d3dcompiler.lib
    ws2_32.lib shell32.lib user32.lib gdi32.lib winmm.lib
)

# UAC 清单：按需（周期任务用不到提权，保持 asInvoker 避免弹窗）
set_target_properties(wallcore PROPERTIES
    OUTPUT_NAME "wallcore"
    RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/bin"
)
