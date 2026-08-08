# 局域网联机架构

## 产品模型

联机连接属于跨游戏持续存在的“联机小队”，不属于某一局游戏。用户只在游戏首页创建小队或扫码加入；进入支持联机的游戏后，可以向在线成员发出对局邀请。对方接受后双方进入同一游戏，对局结束仍保留小队连接。

首版支持桌面端创建小队，桌面端和移动端均可加入。移动端房主需要外部轻量信令或原生端口监听能力，当前协议保留扩展空间，但本实现不假装提供标准 Obsidian 移动插件无法稳定完成的监听能力。

## 生命周期

```text
Plugin onload
  -> MultiplayerService
      -> disconnected
      -> hosting / joining
      -> connected party
          -> pending challenge
          -> active match
          -> connected party
Plugin onunload / leaveParty
  -> close DataChannels and signaling endpoint
```

`MultiplayerService` 是插件级单例。每个应用挂载得到按 manifest ID 隔离的 `ProjectMultiplayer` 门面。应用 cleanup 只移除本实例的状态和消息订阅；连接不跟随 `mount()` 生命周期关闭。

## 传输

1. 桌面房主动态加载 Node.js `http` 和 `os` 模块，在随机端口监听临时信令接口。
2. 首页把私有 IPv4 地址、端口、小队 ID 和高熵邀请令牌编码进二维码。
3. 加入设备提交名称和令牌，房主在本机明确允许或拒绝。
4. 房主创建 WebRTC Offer，加入者生成 Answer；双方等待 ICE gathering 完成后通过 HTTP 交换完整 SDP。
5. DataChannel 打开后停止轮询。成员状态、挑战和游戏数据均通过可靠有序 DataChannel 传输。

信令端点不解释游戏数据、不保存账号和战绩，也不转发正式游戏流量。邀请端点只接受带随机令牌的加入请求，并为每个申请签发独立会话密钥。

## 职责边界

Runtime 负责：

- 平台能力判断、桌面临时端点和 WebRTC 生命周期；
- 联机小队成员、加入审批和断线状态；
- 按项目隔离的挑战、接受/拒绝与对局通道；
- 远端项目路径的本地加载校验；
- 消息体积限制、基础结构校验和未挂载项目的短队列。

应用负责：

- 哪些游戏支持联机及面向用户的入口；
- 每款游戏的协议版本、规则设置、玩家角色和权威模型；
- 对远端 payload 的完整业务校验；
- 状态快照、输入频率、预测/插值与胜负；
- 对局结束时调用 `endMatch()`。

## 当前限制

- 房主必须保持 Obsidian 和插件运行；房主退出会断开小队。
- 访客 Wi-Fi、AP 客户端隔离、系统防火墙或 VPN 可能阻止局域网访问。
- 当前只选取优先级最高的私有 IPv4 地址；复杂多网卡环境可能需要后续增加地址选择。
- WebRTC 使用局域网 host candidates，不配置公网 STUN/TURN；它不是互联网联机方案。
- 移动系统切后台可能暂停 JavaScript 和网络，对局界面应保持前台。
