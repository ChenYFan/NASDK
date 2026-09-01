# NACP 内部记录表

NACP 内部使用七张表记录连接、等待中的回包、订阅和可靠传输状态。

| 表                     | 内容                                          | 写入时机                             | 清理时机                              |
| ---------------------- | --------------------------------------------- | ------------------------------------ | ------------------------------------- |
| `peerAppTable`         | appId 与 peerId 的链路状态，以及 Gateway 槽位 | Register 握手与绑定时                | Unregister / 宽限超时                 |
| `pendingTable`         | 等待 Response 的调用                          | 发出需要 Response 的消息时           | 收到 Response，或超时、遗忘时批量失败 |
| `subscribeTable`       | 为对端在本 App EventBus 上建立的 Listener     | onSubscribe，包含 AutoSubscribe      | onUnsubscribe / 遗忘                  |
| `listenTable`          | 本 App 等待对端 Notify 的 Listener            | subscribe 出站前，包含 AutoSubscribe | unsubscribe / 遗忘                    |
| `backlogTable`         | 尚未出线或等待重发的消息                      | 普通消息进入出站流程时               | 成功出线 / 溢出 / 遗忘                |
| `ackPendingTable`      | 已出站、正在等待 ACK 的消息                   | 可靠消息出站后                       | 收到 ACK / 离线时移回 backlog         |
| `inboundReceivedTable` | 已处理的可靠入站消息 ID                       | 入站处理前                           | 遗忘 / 超容量时逐出最早记录           |

表的生命周期与断线清理见[生命周期](/transport/nacp/lifecycle)，AutoSubscribe 如何同时使用两张订阅表见 [AutoSubscribe](/transport/nacp/auto-subscribe)。
