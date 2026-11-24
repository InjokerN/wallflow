# WallFlow

Windows 桌面动态壁纸应用。支持视频、图片、网页（HTML）和 Wallpaper Engine 场景四类壁纸，可把壁纸贴到桌面底层，游戏/全屏时自动暂停。

> 绿色软件：主程序无需安装，解压即用。C++ 内核随包附带，换电脑零安装。

## 快速开始

### 方式一：下载 Release 绿色包（推荐）

到本仓库的 **Releases** 页面下载 `WallFlow-*.zip`，解压后双击 `WallFlow.exe` 即可。无需安装 Node、无需编译。

- 首次启动会自动创建数据目录和空壁纸库。
- 托盘图标可退出、开关壁纸、调整设置。

> **换电脑后壁纸没了？** 这是正常的：你的壁纸素材和壁纸库存在用户数据目录（`%APPDATA%\WallFlow`），不在程序包里，所以解压绿色包后是一个空库。到「本地导入」把原来的壁纸文件/文件夹重新添加一次即可。想连壁纸库一起搬过去，就把旧电脑的 `%APPDATA%\WallFlow` 整个复制到新电脑的同名目录。
>
> 云端壁纸库的账号配置（R2 凭证）同样不随包分发，需要在「设置 → 云端壁纸库」重新填一次。

### 方式二：从源码运行（开发用）

需要 Node.js 22+ 与 npm。

```bash
npm install
npm run app          # 启动应用（源码模式）
```

源码模式下 C++ 内核需要单独编译（见下）；未编译时会回退到内置假内核，视频渲染不可用，网页/场景正常。

## 从源码打包

```bash
npm install
npm run dist         # 产出 release/WallFlow 绿色目录
```

打包脚本会做两件事：剔除开发机上的测试残留与**云凭证**（`server/data/cloud.json` 不随包分发），并清空数据库里的本机路径，保证换机可用。

打包依赖 Windows 上的 MSVC + CMake 来编译 C++ 内核（`core/wallcore/`）。编译前若出现 MSBuild 报 `MSB6001`，先清掉代理变量：

```bash
env -u HTTPS_PROXY -u https_proxy -u HTTP_PROXY -u http_proxy cmake ...
```

## 云端壁纸库（可选）

"发现"页可连接一个 Cloudflare R2 公开桶作为云端壁纸库。配置在应用内的 **设置 → 云端壁纸库** 完成：填 Account ID、桶名、Access Key ID、Secret Key、公开域名，保存即可。

- 凭证保存在本机数据目录的 `cloud.json`，**不随源码或绿色包分发**，换电脑需重新填写。
- 桶需设为公开读，写入走密钥。也可用"本地文件夹"模式在没有账号时跑通整条链路。
- 公开桶里放一份 `index.json` 作为壁纸目录清单，客户端读它列出可下载的壁纸。

## 目录结构

```
shell/       Electron 主进程与预加载脚本（桌面窗口、托盘、应用规则）
web/         前端界面（壁纸库、导入、设置、预览）
server/      Express 后端（壁纸管理、导入导出、云端同步）
core/        C++ 壁纸内核与假内核（视频渲染、WorkerW 贴桌面）
scripts/     打包清理与发布脚本
```

## 壁纸导入

"本地导入"页支持三种方式：

- 选择单文件（图片 / 视频 / HTML）
- 选择 Wallpaper Engine 文件夹或 ZIP 整包（识别 `project.json`）
- 直接把文件夹、ZIP 或散文件拖进导入框

## 许可

私有仓库，仅供作者与受邀协作者使用。
